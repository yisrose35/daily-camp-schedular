// =============================================================================
// stripe-canteen-refund — Refund a Stripe-backed canteen deposit.
//
// Auth: requires the caller's real Supabase session JWT, owner/admin only
// (same tightest-default precedent as other money-moving actions in this
// app). The acting camp is derived EXCLUSIVELY from that session's own
// owner/admin membership (callerCampId, copied verbatim from
// stripe-charge/index.ts) — never from a client-supplied campId.
//
// A refund is capped at whatever's still unspent in the camper's canteen
// wallet (balance - balanceFloor, the same ceiling cash-out already uses
// for "take real value back out of the wallet" — creditLimit is a
// forward-looking spending allowance, not a withdrawal ceiling, so it's
// deliberately NOT used here). If nothing is left to refund, this returns
// 409 rather than silently no-op-ing. A capped refund just processes the
// capped amount and reports it — no confirm-before-submit step.
//
// Request:  { paymentIntentId, camperName, amount?, reason? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { refundId, status, amount, capped }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

// Copied verbatim from stripe-charge/index.ts — resolves the camp the
// AUTHENTICATED caller actually belongs to as owner/admin. This, not any
// client-supplied value, is the only campId ever trusted for this action.
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund a canteen deposit." }, 403);

    const { paymentIntentId, camperName, amount, reason } = await req.json();
    if (!paymentIntentId || !camperName) {
      return json({ error: "paymentIntentId and camperName are required" }, 400);
    }

    // Verify this PI is genuinely a canteen deposit belonging to this camp
    // and camper — guards a staff member pasting the wrong PaymentIntent id.
    const pi = await stripeGet(`/payment_intents/${paymentIntentId}`);
    if (pi.error) throw new Error(pi.error.message);
    const meta = pi.metadata || {};
    if (meta.source !== "campistry-canteen-deposit" || meta.campId !== authedCampId || meta.camperName !== camperName) {
      return json({ error: "This payment doesn't match a canteen deposit for this camp/camper." }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: accountsData, error: acctErr } = await supabase.rpc("get_canteen_accounts", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balance." }, 500);
    const account = (accountsData.accounts || {})[camperName] || {};
    const balance = Number(account.balance) || 0;
    const balanceFloor = Number(account.balanceFloor) || 0;
    const available = Math.max(0, round2(balance - balanceFloor));

    if (available <= 0) {
      return json({ error: "Nothing available to refund — this deposit has already been spent." }, 409);
    }

    const requested = amount != null && Number(amount) > 0 ? Number(amount) : (pi.amount || 0) / 100;
    const refundAmount = round2(Math.min(requested, available));
    const capped = refundAmount < round2(requested);

    const params: Record<string, string> = {
      payment_intent: String(paymentIntentId),
      amount: String(Math.round(refundAmount * 100)),
    };
    if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") {
      params.reason = reason;
    }
    // Same auto-detection already used in stripe-refund/index.ts — reverses
    // the transfer so the CAMP's connected account is debited, not the
    // platform's. Duplicated here (not chained via HTTP) to keep this one
    // reviewable request/response cycle self-contained.
    if (pi.transfer_data?.destination) params.reverse_transfer = "true";

    const refund = await stripePost("/refunds", params, `canteen_refund_${paymentIntentId}_${Math.round(refundAmount * 100)}`);
    if (refund.error) throw new Error(refund.error.message);

    const { error: creditErr } = await supabase.rpc("refund_canteen_deposit_from_stripe", {
      p_camp_id: authedCampId,
      p_camper_name: camperName,
      p_amount: refundAmount,
      p_payment_intent_id: paymentIntentId,
      p_refund_id: refund.id,
    });
    if (creditErr) console.error(`[stripe-canteen-refund] Stripe refund ${refund.id} succeeded but ledger update failed: ${creditErr.message}`);

    console.log(`[stripe-canteen-refund] Refund ${refund.id}: $${refundAmount} for ${camperName} (camp ${authedCampId})${capped ? " (capped)" : ""}`);

    return json({ refundId: refund.id, status: refund.status, amount: refundAmount, capped });
  } catch (err) {
    console.error("[stripe-canteen-refund] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
