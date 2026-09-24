// =============================================================================
// payments-canteen-refund-all — Refund EVERY camper's leftover canteen balance
// on a BYOP processor (Cardknox/Sola, Banquest).
//
// WHY THIS EXISTS. The Snacks page's season-end "Refund All" button called
// stripe-canteen-refund-all unconditionally, with no processor check. On a camp
// using Cardknox or Banquest that function looks for Stripe charges the camp
// never had, finds nothing refundable, and reports success — having returned
// nothing. Every family's leftover canteen money stayed with the camp and the
// screen said the refund had run.
//
// That was an oversight rather than a decision: the PER-CAMPER refund was
// carefully made processor-aware (payments-canteen-refund, and the client's own
// _onlineRefundCapacity branches on stripePaymentIntentId vs byopTransactionId).
// Only the bulk path was left on the Stripe rail.
//
// This is stripe-canteen-refund-all's structure with payments-canteen-refund's
// gateway calls. Both are inlined rather than imported: this repo deploys edge
// functions by pasting ONE file into the Supabase Dashboard, so a relative
// ../_shared import cannot bundle. Keep the two refund bodies in sync with
// payments-canteen-refund, which is the canonical per-camper version.
//
// SAFETY, same as the Stripe version:
//   * a camper is only ever refunded up to BOTH their spendable wallet balance
//     AND what their own deposits on the CURRENT processor can still give back,
//     so cash/manual deposits are never refunded to a card;
//   * chunks are drawn oldest deposit first, and a chunk that fails leaves
//     everything before it standing — real money already moved for those;
//   * a camper only counts as FAILED if a gateway call for them actually
//     errored. "Nothing refundable" is a skip, not a failure.
//
// Auth: the caller's real Supabase session JWT, owner/admin only.
// Request:  POST {}   header: Authorization: Bearer <caller's access token>
// Response: { totalRefunded, refundedCount, skippedCount, failedCount, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

// How many campers to refund in parallel. Each camper may involve several
// sequential gateway calls of its own (one refund per deposit drawn from), so
// this caps total concurrent requests at a reasonable level rather than firing
// the whole roster at a camp's processor at once.
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

// ── gateway calls, inlined from payments-canteen-refund ─────────────────────
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxRefund(
  credentials: Record<string, string>,
  externalTransactionId: string,
  amountCents: number,
): Promise<{ success: boolean; uncertain?: boolean; externalTransactionId?: string; status?: string; error?: string; raw?: unknown }> {
  const apiKey = credentials.apiKey;
  if (!apiKey) return { success: false, error: "Missing apiKey" };
  try {
    const resp = await fetch(CARDKNOX_GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        xKey: apiKey, xVersion: "4.5.9", xSoftwareName: "Campistry", xSoftwareVersion: "1.0",
        xCommand: "cc:refund", xRefNum: externalTransactionId, xAmount: (amountCents / 100).toFixed(2),
      }).toString(),
    });
    const text = await resp.text();
    const r: Record<string, string> = {};
    new URLSearchParams(text).forEach((v, k) => { r[k] = v; });
    // No result at all is not a "no" (TED-093): the gateway may have refunded.
    if (!r.xResult) return { success: false, uncertain: true, error: "No answer from the card company (HTTP " + resp.status + ")", raw: r };
    if (r.xResult !== "A") return { success: false, status: r.xStatus, error: r.xError || "Refund failed", raw: r };
    return { success: true, externalTransactionId: r.xRefNum, status: r.xStatus, raw: r };
  } catch (err) {
    return { success: false, uncertain: true, error: (err as Error).message };   // cut off: may have moved money (TED-093)
  }
}

const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(credentials: Record<string, string>): string {
  let b = (credentials.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
async function banquestRefund(
  credentials: Record<string, string>,
  externalTransactionId: string,
  amountCents: number,
): Promise<{ success: boolean; uncertain?: boolean; externalTransactionId?: string; status?: string; error?: string; raw?: unknown }> {
  if (!credentials.sourceKey || !credentials.pin) return { success: false, error: "Missing sourceKey/pin" };
  const refNum = Number(externalTransactionId);
  if (!Number.isFinite(refNum)) return { success: false, error: "Original transaction reference is not a valid Banquest reference_number." };
  try {
    const resp = await fetch(`${bqBase(credentials)}/transactions/reversal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${credentials.sourceKey}:${credentials.pin}`) },
      body: JSON.stringify({ reference_number: refNum, amount: Number((amountCents / 100).toFixed(2)) }),
    });
    let data: Record<string, any> = {};
    try { data = await resp.json(); } catch { /* non-JSON error body */ }
    const code = String(data?.status_code || "").toUpperCase();
    const st = String(data?.status || "").toLowerCase();
    const ok = code === "A" || /approv|void|refund/.test(st);
    const newRef = data?.reference_number != null ? String(data.reference_number) : (data?.transaction?.id ? String(data.transaction.id) : "");
    if (resp.status >= 500 && !newRef) {
      return { success: false, uncertain: true, error: `No answer from the card company (HTTP ${resp.status})`, raw: data };
    }
    if (resp.status < 200 || resp.status >= 300 || !ok || !newRef) {
      const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Refund failed (HTTP ${resp.status})`;
      return { success: false, status: data?.status, error: errMsg, raw: data };
    }
    return { success: true, externalTransactionId: newRef, status: data?.status, raw: data };
  } catch (err) {
    return { success: false, uncertain: true, error: (err as Error).message };   // cut off: may have moved money (TED-093)
  }
}

// Copied verbatim from stripe-canteen-refund-all — resolves the camp the
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

  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0])
    : null;
  if (owned?.id) return owned.id;

  const { data: memberships } = await asUser
    .from("camp_users")
    .select("camp_id, role")
    .eq("user_id", uid)
    .not("accepted_at", "is", null)
    .order("accepted_at", { ascending: false })
    .limit(1);
  const membership = Array.isArray(memberships) && memberships.length ? memberships[0] : null;
  if (membership?.camp_id && SENDER_ROLES.includes(membership.role)) return membership.camp_id;
  return null;
}

type DepositRemainder = { externalTransactionId: string; remaining: number; timestamp: number };

// Everything this camper's deposits ON THE CAMP'S CURRENT PROCESSOR can still
// be refunded from, oldest first — same math as payments-canteen-refund's
// per-request version. Deposits taken on a DIFFERENT processor (before the camp
// switched) are deliberately excluded: that transaction id means nothing to the
// gateway we would be calling.
function depositsFor(
  who: { camperId: number | null; camperName: string },
  transactions: Record<string, any>[],
  processorKey: string,
  holds: Record<string, any>[] = [],
): DepositRemainder[] {
  // By camper ID when the account has one (250): the account's key is the
  // spelling at the time, and a renamed or same-named child shares spellings.
  // The name is compared only when the account or the ledger row has no number.
  const mine = (t: Record<string, any>) => (who.camperId != null && t.camperId != null) ? String(t.camperId) === String(who.camperId) : t.camper === who.camperName;
  return transactions
    .filter((t) => t && mine(t) && t.kind === "deposit" && t.method === processorKey && t.byopTransactionId)
    .map((dep) => {
      // what is already refunded from it, and what another refund has on its way from it (275)
      const refundedSoFar = transactions
        .filter((t) => t && t.kind === "refund" && t.byopTransactionId === dep.byopTransactionId)
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
        + holds.filter((h) => h.method === processorKey && h.paymentRef === dep.byopTransactionId)
            .reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
      return {
        externalTransactionId: dep.byopTransactionId as string,
        remaining: round2((Number(dep.amount) || 0) - refundedSoFar),
        timestamp: Number(dep.timestamp) || 0,
      };
    })
    .filter((d) => d.remaining > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function refundOneCamper(
  service: ReturnType<typeof createClient>,
  campId: string,
  processorKey: string,
  credentials: Record<string, string>,
  who: { camperId: number | null; camperName: string },
  walletAvailable: number,
  transactions: Record<string, any>[],
  batchKey: string | null,
  holds: Record<string, any>[] = [],
): Promise<{ camperId: number | null; camperName: string; refunded: number; skipped?: string; error?: string }> {
  const { camperId, camperName } = who;
  const deposits = depositsFor(who, transactions, processorKey, holds);
  const processorCapacity = round2(deposits.reduce((sum, d) => sum + d.remaining, 0));
  const targetAmount = round2(Math.min(walletAvailable, processorCapacity));

  // An earlier refund of this child's money that the card company never
  // confirmed (275): its money stays off the wallet — it may be with the
  // parent — and the office is told, every run, until someone has looked.
  const mineHold = (h: Record<string, any>) => (camperId != null && h.camperId != null) ? String(h.camperId) === String(camperId) : h.accountKey === camperName;
  const stale = holds.filter((h) => mineHold(h) && Number(h.ageSeconds) >= 180);
  const staleAmt = round2(stale.reduce((t, h) => t + (Number(h.amount) || 0), 0));
  const staleNote = stale.length
    ? `An earlier refund of $${staleAmt.toFixed(2)} for this child was never confirmed by the card company — check the processor's dashboard, then settle it under "waiting for an answer" (in Refund All or this child's Refund).`
    : null;

  if (targetAmount <= 0) {
    if (staleNote) return { camperId, camperName, refunded: 0, error: staleNote };
    return {
      camperId, camperName,
      refunded: 0,
      skipped: processorCapacity <= 0
        ? "no online deposits on this processor (cash/manual, or a processor the camp has since left)"
        : "nothing available",
    };
  }

  let remainingToRefund = targetAmount;
  let refunded = 0;
  for (const dep of deposits) {
    if (remainingToRefund <= 0) break;
    let chunk = round2(Math.min(dep.remaining, remainingToRefund));
    if (chunk <= 0) continue;

    try {
      const keyFor = (amt: number) => `canteen:${dep.externalTransactionId}:${Math.round(dep.remaining * 100)}:${Math.round(amt * 100)}`;
      // TAKE THE MONEY OFF THE WALLET FIRST (275, TED-110), at this child's
      // turn and in one locked step — not from the balances read when the run
      // started. A refund of this child from another computer, or a sale, since
      // then is seen here; whichever reserves first has the money.
      const reserve = (amt: number) => service.rpc("reserve_canteen_refund", {
        p_camp_id: campId, p_camper_id: camperId, p_camper_name: camperName,
        p_hold_key: keyFor(amt), p_amount: amt, p_method: processorKey, p_payment_ref: String(dep.externalTransactionId) });
      let { data: held, error: holdErr } = await reserve(chunk);
      if (!holdErr && held && held.success === false && held.error === "insufficient") {
        const avail = round2(Number(held.available) || 0);
        if (avail <= 0) {
          if (refunded > 0 || staleNote) break;
          return { camperId, camperName, refunded, skipped: "the balance changed during the run (another refund or a sale took it)" };
        }
        chunk = round2(Math.min(chunk, avail));
        ({ data: held, error: holdErr } = await reserve(chunk));
      }
      if (holdErr || !held || held.success !== true) {
        throw new Error("Could not set this child's refund money aside, so nothing was sent: " + (holdErr?.message || held?.error || "no answer"));
      }
      if (held.existing && held.state === "posted") {
        console.log(`[canteen-refund-all] already refunded, skipping: ${keyFor(chunk)}`);
        continue;
      }
      if (held.existing) chunk = round2(Number(held.amount) || chunk);   // its reservation decides the amount
      const holdKey = keyFor(chunk);
      const chunkCents = Math.round(chunk * 100);
      // CLAIM BEFORE THE PROCESSOR. This function refunds a whole camp's wallets
      // in one invocation, so a timeout partway through is the likeliest way it
      // gets run twice — and without a claim the campers it already reached would
      // be refunded again. Keyed per camper AND per deposit chunk so a resumed run
      // skips exactly what it finished.
      // Keyed on the deposit and what is left on it, never on a request key:
      // Snacks sends none, so nothing was ever claimed and a re-run after a
      // lost answer refunded the child again (TED-093). A single refund of the
      // same child uses its own page key; what keeps the two from both
      // spending the same money is the wallet reservation above (275, TED-110),
      // not a shared key.
      void batchKey;
      const chunkKey = holdKey;
      if (chunkKey) {
        const { data: claim } = await service.rpc("claim_refund_intent", {
          p_camp_id: campId, p_key: chunkKey, p_amount: chunk,
          p_payment_ref: String(dep.externalTransactionId),
        });
        if (claim && claim.claimed === false) {
          if (!(claim.previous && claim.previous.externalTransactionId)) {
            // Asked on an earlier run and never confirmed (TED-093): leave this
            // camper for the office to check, never refund them twice.
            return { camperId, camperName, refunded, error: "An earlier refund for this camper was never confirmed by the card company — check the processor's dashboard." };
          }
          console.log(`[canteen-refund-all] already settled, skipping: ${chunkKey}`);
          await service.rpc("settle_canteen_refund_hold", { p_camp_id: campId, p_hold_key: holdKey,
            p_refund_id: String(claim.previous.externalTransactionId) });
          continue;
        }
      }
      const refundResult = processorKey === "cardknox"
        ? await cardknoxRefund(credentials, dep.externalTransactionId, chunkCents)
        : await banquestRefund(credentials, dep.externalTransactionId, chunkCents);
      if (!refundResult.success && refundResult.uncertain) {
        // Maybe it moved money: keep the claim, so a re-run leaves this camper
        // for the office to check instead of refunding them again (TED-093).
        throw new Error("The card company did not answer, so this camper's refund may or may not have gone through — check the processor's dashboard.");
      }
      if (!refundResult.success) {
        // A definite "no": nothing moved. The claim and the money go back.
        if (chunkKey) {
          await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: chunkKey });
        }
        await service.rpc("release_canteen_refund_hold", { p_camp_id: campId, p_hold_key: holdKey });
        throw new Error(refundResult.error || "Refund failed");
      }
      if (chunkKey) {
        await service.rpc("settle_refund_intent", {
          p_camp_id: campId, p_key: chunkKey,
          p_result: { success: true, externalTransactionId: refundResult.externalTransactionId,
                      amount: chunk },
        });
      }

      await service.rpc("record_processor_transaction", {
        p_camp_id: campId,
        p_processor_key: processorKey,
        p_external_transaction_id: refundResult.externalTransactionId,
        p_kind: "refund",
        p_amount_cents: chunkCents,
        p_status: refundResult.status || "unknown",
        p_raw_response: refundResult.raw ? JSON.parse(JSON.stringify(refundResult.raw)) : null,
      });

      // The refund line goes on the wallet's ledger; the money came off when
      // it was reserved, so the balance does not move again (275).
      const { data: posted, error: postErr } = await service.rpc("settle_canteen_refund_hold", {
        p_camp_id: campId, p_hold_key: holdKey, p_refund_id: String(refundResult.externalTransactionId) });
      const creditErr = postErr || (posted && posted.success === true ? null : { message: String(posted?.error || "no answer") });
      if (creditErr) {
        console.error(`[payments-canteen-refund-all] refund ${refundResult.externalTransactionId} succeeded ` +
          `but the canteen ledger was not updated for camper ${camperId ?? "(no number)"} ${camperName}: ${creditErr.message}`);
      }

      refunded = round2(refunded + chunk);
      remainingToRefund = round2(remainingToRefund - chunk);
    } catch (chunkErr) {
      // Keep whatever succeeded for this camper before the error — real money
      // already moved for those chunks — and report the rest as a partial
      // failure rather than losing track of it.
      return { camperId, camperName, refunded, error: (chunkErr as Error).message };
    }
  }

  return staleNote ? { camperId, camperName, refunded, error: staleNote } : { camperId, camperName, refunded };
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

  // This function has always been callable with no body at all, so a missing or
  // unparsable one is not an error — it just means no idempotency key, and the run
  // proceeds unguarded exactly as it did before.
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  try {
    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund canteen balances." }, 403);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", authedCampId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-canteen-refund-all instead." }, 400);
    }
    if (processorKey !== "cardknox" && processorKey !== "banquest") {
      return json({ error: `Refunds aren't supported yet for processor '${processorKey}'.` }, 400);
    }

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: authedCampId });
    if (!credResult?.success) {
      return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }

    // canteen_refund_view (migration 250), not get_canteen_accounts: that one
    // decides what to show from the signed-in caller, which the service role is
    // not — it answered not_authorized, so every refund stopped here — and its
    // ledger is a 7-day window. This has every deposit, and each account's id.
    const { data: accountsData, error: acctErr } = await service.rpc("canteen_refund_view", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balances." }, 500);

    const accounts: Record<string, any> = accountsData.accounts || {};
    const transactions: Record<string, any>[] = accountsData.transactions || [];
    const holds: Record<string, any>[] = Array.isArray(accountsData.holds) ? accountsData.holds : [];

    // Each account with its camper number (250); the account key rides along
    // as the name, for the fallback of an account with no number. A child
    // whose earlier refund was never confirmed is listed too, so the office
    // hears about it (275).
    const candidates = Object.entries(accounts)
      .map(([accountKey, acct]) => {
        const a = acct || {};
        const walletAvailable = Math.max(0, round2((Number(a.balance) || 0) - (Number(a.balanceFloor) || 0)));
        const who = { camperId: a.camperId != null ? Number(a.camperId) : null, camperName: accountKey };
        const staleHold = holds.some((h) => Number(h.ageSeconds) >= 180 &&
          ((who.camperId != null && h.camperId != null) ? String(h.camperId) === String(who.camperId) : h.accountKey === accountKey));
        return { who, walletAvailable, staleHold };
      })
      .filter((c) => c.walletAvailable > 0 || c.staleHold);

    if (!candidates.length) {
      return json({ totalRefunded: 0, refundedCount: 0, skippedCount: 0, failedCount: 0, details: [] });
    }

    // One key for the whole run. Supplied by the caller so a deliberate second
    // clear-out gets its own key and is allowed, while a retry of the same one
    // resumes instead of re-refunding what it already finished.
    const batchKey = (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim())
      ? (body.idempotencyKey as string).trim() : null;

    const results = await mapWithConcurrency(candidates, CONCURRENCY, (c) =>
      refundOneCamper(service, authedCampId, processorKey, credResult.credentials,
                      c.who, c.walletAvailable, transactions, batchKey, holds)
    );

    let totalRefunded = 0, refundedCount = 0, skippedCount = 0, failedCount = 0;
    for (const r of results) {
      if (r.refunded > 0) { totalRefunded = round2(totalRefunded + r.refunded); refundedCount++; }
      if (r.error) failedCount++;
      else if (r.skipped) skippedCount++;
    }

    console.log(`[payments-canteen-refund-all] camp ${authedCampId} (${processorKey}): refunded $${totalRefunded} ` +
      `across ${refundedCount} camper(s), ${skippedCount} skipped, ${failedCount} failed`);

    return json({ totalRefunded, refundedCount, skippedCount, failedCount, details: results });
  } catch (err) {
    console.error("[payments-canteen-refund-all] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
