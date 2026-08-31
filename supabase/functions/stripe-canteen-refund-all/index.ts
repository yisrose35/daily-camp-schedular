// =============================================================================
// stripe-canteen-refund-all — Refund EVERY camper's leftover canteen balance
// in one action, instead of the office going camper-by-camper.
//
// Same underlying per-camper apportionment logic as stripe-canteen-refund
// (draw from that camper's Stripe deposits oldest-first, cap at the lower of
// wallet balance and Stripe-refundable capacity) — just run once per camper
// who actually has money left, with modest concurrency so a camp with a
// large roster doesn't take forever. Deliberately NOT shared code with
// stripe-canteen-refund (this repo doesn't use a _shared/ import convention
// for edge functions — every function here is self-contained by design, see
// stripe-canteen-refund's own header comment on why duplication was chosen
// over chaining an HTTP call).
//
// Auth: requires the caller's real Supabase session JWT, owner/admin only —
// same as every other money-moving action in this app. The acting camp is
// derived EXCLUSIVELY from that session's own owner/admin membership, never
// from a client-supplied campId.
//
// A camper is SKIPPED (not an error) when they have nothing refundable —
// either a zero/spent balance, or a balance that came entirely from a
// cash/manual deposit (no PaymentIntent behind it, nothing for Stripe to
// refund). A camper only counts as FAILED if a Stripe call for them actually
// errored — one camper failing does not stop the rest from processing.
//
// Request:  {}  (no body needed — acts on every camper in this camp)
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { totalRefunded, refundedCount, skippedCount, failedCount, details: [...] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

// How many campers to refund in parallel. Each camper may involve several
// sequential Stripe calls of its own (one PI fetch + one refund per deposit
// drawn from), so this caps total concurrent Stripe requests at a
// reasonable level rather than firing the whole roster at once.
const CONCURRENCY = 4;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function stripePost(endpoint: string, body: Record<string, string>, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { method: "POST", headers, body: new URLSearchParams(body).toString() });
  return resp.json();
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } });
  return resp.json();
}

// Copied verbatim from stripe-charge/index.ts (and stripe-canteen-refund) —
// resolves the camp the AUTHENTICATED caller actually belongs to as
// owner/admin. This, not any client-supplied value, is the only campId
// ever trusted for this action.
async function callerCampId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;

  const { data: owned } = await asUser.from("camps").select("id").eq("owner", uid).maybeSingle();
  if (owned?.id) return owned.id;

  const { data: membership } = await asUser
    .from("camp_users")
    .select("camp_id, role")
    .eq("user_id", uid)
    .maybeSingle();
  if (membership?.camp_id && SENDER_ROLES.includes(membership.role)) return membership.camp_id;
  return null;
}

type DepositRemainder = { paymentIntentId: string; remaining: number; timestamp: number };

// Everything this camper's Stripe deposits can still be refunded from,
// oldest first — same math as stripe-canteen-refund's per-request version.
function depositsFor(camperName: string, transactions: Record<string, any>[]): DepositRemainder[] {
  return transactions
    .filter((t) => t && t.camper === camperName && t.kind === "deposit" && t.method === "stripe" && t.stripePaymentIntentId)
    .map((dep) => {
      const refundedSoFar = transactions
        .filter((t) => t && t.kind === "refund" && t.stripePaymentIntentId === dep.stripePaymentIntentId)
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      return { paymentIntentId: dep.stripePaymentIntentId as string, remaining: round2((Number(dep.amount) || 0) - refundedSoFar), timestamp: Number(dep.timestamp) || 0 };
    })
    .filter((d) => d.remaining > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function refundOneCamper(
  supabase: ReturnType<typeof createClient>,
  campId: string,
  camperName: string,
  walletAvailable: number,
  transactions: Record<string, any>[],
): Promise<{ camperName: string; refunded: number; skipped?: string; error?: string }> {
  const deposits = depositsFor(camperName, transactions);
  const stripeCapacity = round2(deposits.reduce((sum, d) => sum + d.remaining, 0));
  const targetAmount = round2(Math.min(walletAvailable, stripeCapacity));

  if (targetAmount <= 0) {
    return {
      camperName,
      refunded: 0,
      skipped: stripeCapacity <= 0 ? "no Stripe-paid deposits (cash/manual only)" : "nothing available",
    };
  }

  let remainingToRefund = targetAmount;
  let refunded = 0;
  for (const dep of deposits) {
    if (remainingToRefund <= 0) break;
    const chunk = round2(Math.min(dep.remaining, remainingToRefund));
    if (chunk <= 0) continue;

    try {
      const pi = await stripeGet(`/payment_intents/${dep.paymentIntentId}`);
      if (pi.error) throw new Error(pi.error.message);

      const params: Record<string, string> = {
        payment_intent: dep.paymentIntentId,
        amount: String(Math.round(chunk * 100)),
      };
      if (pi.transfer_data?.destination) params.reverse_transfer = "true";

      const refund = await stripePost("/refunds", params, `canteen_refund_${dep.paymentIntentId}_${Math.round(chunk * 100)}`);
      if (refund.error) throw new Error(refund.error.message);

      const { error: creditErr } = await supabase.rpc("refund_canteen_deposit_from_stripe", {
        p_camp_id: campId,
        p_camper_name: camperName,
        p_amount: chunk,
        p_payment_intent_id: dep.paymentIntentId,
        p_refund_id: refund.id,
      });
      if (creditErr) console.error(`[stripe-canteen-refund-all] Stripe refund ${refund.id} succeeded but ledger update failed for ${camperName}: ${creditErr.message}`);

      refunded = round2(refunded + chunk);
      remainingToRefund = round2(remainingToRefund - chunk);
    } catch (chunkErr) {
      // Keep whatever succeeded for this camper before the error — real
      // money already moved for those chunks — and report the rest as a
      // partial failure rather than losing track of it.
      return { camperName, refunded, error: (chunkErr as Error).message };
    }
  }

  return { camperName, refunded };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund canteen balances." }, 403);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: accountsData, error: acctErr } = await supabase.rpc("get_canteen_accounts", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balances." }, 500);

    const accounts: Record<string, any> = accountsData.accounts || {};
    const transactions: Record<string, any>[] = accountsData.transactions || [];

    const candidates = Object.keys(accounts)
      .map((camperName) => {
        const a = accounts[camperName] || {};
        const walletAvailable = Math.max(0, round2((Number(a.balance) || 0) - (Number(a.balanceFloor) || 0)));
        return { camperName, walletAvailable };
      })
      .filter((c) => c.walletAvailable > 0);

    if (!candidates.length) {
      return json({ totalRefunded: 0, refundedCount: 0, skippedCount: 0, failedCount: 0, details: [] });
    }

    const results = await mapWithConcurrency(candidates, CONCURRENCY, (c) =>
      refundOneCamper(supabase, authedCampId, c.camperName, c.walletAvailable, transactions)
    );

    let totalRefunded = 0, refundedCount = 0, skippedCount = 0, failedCount = 0;
    for (const r of results) {
      if (r.refunded > 0) { totalRefunded = round2(totalRefunded + r.refunded); refundedCount++; }
      if (r.error) failedCount++;
      else if (r.skipped) skippedCount++;
    }

    console.log(`[stripe-canteen-refund-all] camp ${authedCampId}: refunded $${totalRefunded} across ${refundedCount} camper(s), ${skippedCount} skipped, ${failedCount} failed`);

    return json({ totalRefunded, refundedCount, skippedCount, failedCount, details: results });
  } catch (err) {
    console.error("[stripe-canteen-refund-all] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
