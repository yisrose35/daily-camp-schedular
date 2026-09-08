// =============================================================================
// payments-canteen-refund — BYOP equivalent of stripe-canteen-refund: refund
// a camper's canteen balance back to the parent, in ONE requested dollar
// amount, apportioned across as many of the camper's BYOP-backed deposits as
// needed (oldest first) — same reasoning as stripe-canteen-refund's own
// header comment (a wallet is fungible; the office shouldn't have to pick
// one deposit and repeat the action until a target total is reached).
//
// Auth: requires the caller's real Supabase session JWT, owner/admin only —
// callerCampId copied verbatim from payments-refund/stripe-canteen-refund.
// The acting camp is derived EXCLUSIVELY from that session, never a
// client-supplied campId.
//
// A refund is capped at THE LOWEST of three ceilings, same as
// stripe-canteen-refund:
//   1. whatever's still unspent in the camper's canteen wallet
//      (balance - balanceFloor)
//   2. the total still refundable across the camper's BYOP deposits FOR
//      THE CAMP'S CURRENT PROCESSOR (each deposit's original amount minus
//      whatever's already been refunded from it)
//   3. the amount actually requested (or, if omitted, ceiling 1)
// Ceiling 2 can be below ceiling 1 when some of the balance came from a
// manual/cash deposit, a Stripe deposit from before a processor switch, or
// a deposit on a DIFFERENT BYOP processor than the camp is on now — none of
// those have anything here to refund them from; the response says so.
//
// Request:  { camperName, amount?, reason? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { totalRefunded, requested, capped, cappedReason?, refunds: [...] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAdapter } from "./_shared/processor_adapter.ts";

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Copied verbatim from payments-refund/index.ts.
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund a canteen deposit." }, 403);

    const { camperName, amount, reason } = await req.json();
    if (!camperName) return json({ error: "camperName is required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", authedCampId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-canteen-refund instead." }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ error: `No adapter implemented for processor '${processorKey}'` }, 500);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: authedCampId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    const { data: accountsData, error: acctErr } = await service.rpc("get_canteen_accounts", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balance." }, 500);

    const account = (accountsData.accounts || {})[camperName] || {};
    const balance = Number(account.balance) || 0;
    const balanceFloor = Number(account.balanceFloor) || 0;
    const walletAvailable = Math.max(0, round2(balance - balanceFloor));

    if (walletAvailable <= 0) {
      return json({ error: "Nothing available to refund — this balance has already been spent." }, 409);
    }

    // Every deposit for this camper on the camp's CURRENT processor, minus
    // whatever's already been refunded from each one.
    const transactions: Record<string, any>[] = accountsData.transactions || [];
    const deposits = transactions
      .filter((t) => t && t.camper === camperName && t.kind === "deposit" && t.method === processorKey && t.byopTransactionId)
      .map((dep) => {
        const refundedSoFar = transactions
          .filter((t) => t && t.kind === "refund" && t.byopTransactionId === dep.byopTransactionId)
          .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
        return { externalTransactionId: dep.byopTransactionId as string, remaining: round2((Number(dep.amount) || 0) - refundedSoFar), timestamp: Number(dep.timestamp) || 0 };
      })
      .filter((d) => d.remaining > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    const processorCapacity = round2(deposits.reduce((sum, d) => sum + d.remaining, 0));

    const requested = amount != null && Number(amount) > 0 ? round2(Number(amount)) : walletAvailable;
    const targetAmount = round2(Math.min(requested, walletAvailable, processorCapacity));

    if (targetAmount <= 0) {
      if (processorCapacity <= 0) {
        return json({ error: "This balance has no online deposits on this processor left to refund — it came from cash/manual deposits (or a different processor) and must be refunded that way instead." }, 409);
      }
      return json({ error: "Nothing available to refund." }, 409);
    }

    // Draw from deposits oldest-first until the target amount is covered.
    // Each chunk is its own refund call and its own ledger entry — if one
    // chunk fails partway through, everything before it has already
    // succeeded for real money, so those are kept and reported rather than
    // rolled back or hidden.
    let remainingToRefund = targetAmount;
    let totalRefunded = 0;
    const refunds: Record<string, unknown>[] = [];
    let chunkError: string | null = null;

    for (const dep of deposits) {
      if (remainingToRefund <= 0) break;
      const chunk = round2(Math.min(dep.remaining, remainingToRefund));
      if (chunk <= 0) continue;

      try {
        const chunkCents = Math.round(chunk * 100);
        const refundResult = await adapter.refund(credResult.credentials, dep.externalTransactionId, chunkCents);
        if (!refundResult.success) throw new Error(refundResult.error || "Refund failed");

        await service.rpc("record_processor_transaction", {
          p_camp_id: authedCampId,
          p_processor_key: processorKey,
          p_external_transaction_id: refundResult.externalTransactionId,
          p_kind: "refund",
          p_amount_cents: chunkCents,
          p_status: refundResult.status || "unknown",
          p_raw_response: refundResult.raw ? JSON.parse(JSON.stringify(refundResult.raw)) : null,
        });

        const { error: creditErr } = await service.rpc("refund_canteen_deposit_from_processor", {
          p_camp_id: authedCampId,
          p_camper_name: camperName,
          p_amount: chunk,
          p_processor_key: processorKey,
          p_external_transaction_id: dep.externalTransactionId,
          p_refund_external_id: refundResult.externalTransactionId,
        });
        if (creditErr) console.error(`[payments-canteen-refund] refund ${refundResult.externalTransactionId} succeeded but ledger update failed: ${creditErr.message}`);

        refunds.push({ refundId: refundResult.externalTransactionId, externalTransactionId: dep.externalTransactionId, amount: chunk });
        totalRefunded = round2(totalRefunded + chunk);
        remainingToRefund = round2(remainingToRefund - chunk);
      } catch (chunkErr) {
        chunkError = (chunkErr as Error).message;
        break;
      }
    }

    if (totalRefunded <= 0) {
      throw new Error(chunkError || "Refund failed.");
    }

    const capped = totalRefunded < round2(requested);
    let cappedReason: string | null = null;
    if (chunkError) {
      cappedReason = `Refunded $${totalRefunded.toFixed(2)} before hitting an error on the rest: ${chunkError}`;
    } else if (capped) {
      cappedReason = processorCapacity < Math.min(requested, walletAvailable)
        ? "Capped — the rest of this balance came from cash/manual deposits (or a different processor) and must be refunded that way."
        : "Capped to what was left available.";
    }

    console.log(`[payments-canteen-refund] Refunded $${totalRefunded} for ${camperName} (camp ${authedCampId}) across ${refunds.length} deposit(s)${capped ? " (capped)" : ""}`);

    return json({ totalRefunded, requested: round2(requested), capped, cappedReason, refunds });
  } catch (err) {
    console.error("[payments-canteen-refund] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
