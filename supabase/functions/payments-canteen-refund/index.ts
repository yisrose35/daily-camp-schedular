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
// Cardknox/Sola refund, inlined so this function is self-contained and
// Dashboard-deployable (no CLI / ../_shared bundling). Mirrors
// _shared/adapters/cardknox_adapter.ts's refund().
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxRefund(
  credentials: Record<string, string>,
  externalTransactionId: string,
  amountCents: number,
): Promise<{ success: boolean; externalTransactionId?: string; status?: string; error?: string; raw?: unknown }> {
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
    if (r.xResult !== "A") return { success: false, status: r.xStatus, error: r.xError || "Refund failed", raw: r };
    return { success: true, externalTransactionId: r.xRefNum, status: r.xStatus, raw: r };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// Banquest (AffiniPay/8am) reversal of a prior transaction — the convenience
// endpoint that auto-picks refund (settled) vs void (unsettled). Inlined for
// the same Dashboard-deploy reason; keep in sync with
// _shared/adapters/banquest_adapter.ts. Auth is HTTP Basic base64(sourceKey:
// pin); API base is per-camp and lives under /api/v2; amounts are DOLLARS;
// the prior transaction is referenced by its integer `reference_number`
// (NOT a "ref-" source string — that prefix is only for charging a stored
// transaction's card again, not for reversing it).
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(credentials: Record<string, string>): string {
  // A stored gatewayUrl that already ends in /v2 or /api/v2 is used verbatim;
  // a bare host gets /api/v2 appended. Both spellings are honoured on purpose:
  // the API reference documents the base as /api/v2, while the Hosted
  // Tokenization guide's own backend example posts to /v2 — so whichever path
  // the camp actually stores is the one we call.
  let b = (credentials.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
async function banquestRefund(
  credentials: Record<string, string>,
  externalTransactionId: string,
  amountCents: number,
): Promise<{ success: boolean; externalTransactionId?: string; status?: string; error?: string; raw?: unknown }> {
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
    // Success = an "A" status_code (or "Approved"/"Voided" status word); the
    // new reversal transaction's own reference_number is what we record.
    const code = String(data?.status_code || "").toUpperCase();
    const st = String(data?.status || "").toLowerCase();
    const ok = code === "A" || /approv|void|refund/.test(st);
    const newRef = data?.reference_number != null ? String(data.reference_number) : (data?.transaction?.id ? String(data.transaction.id) : "");
    if (resp.status < 200 || resp.status >= 300 || !ok || !newRef) {
      const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Refund failed (HTTP ${resp.status})`;
      return { success: false, status: data?.status, error: errMsg, raw: data };
    }
    return { success: true, externalTransactionId: newRef, status: data?.status, raw: data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

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

    const { camperName, camperId: body_camperId, amount, reason, idempotencyKey } = await req.json();
    // The camper by ID when the page sent one: the account's key is a spelling.
    const camperIdSent = (body_camperId != null && /^\d+$/.test(String(body_camperId)) && Number(body_camperId) > 0) ? Number(body_camperId) : null;
    if (camperIdSent == null && !camperName) return json({ error: "camperId (or camperName) is required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", authedCampId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-canteen-refund instead." }, 400);
    }

    if (processorKey !== "cardknox" && processorKey !== "banquest") return json({ error: `Refunds aren't supported yet for processor '${processorKey}'.` }, 400);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: authedCampId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    // canteen_refund_view (migration 250), not get_canteen_accounts: that one
    // decides what to show from the signed-in caller, which the service role is
    // not — it answered not_authorized, so every refund stopped here — and its
    // ledger is a 7-day window. This has every deposit, and each account's id.
    const { data: accountsData, error: acctErr } = await service.rpc("canteen_refund_view", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balance." }, 500);

    // The number decides: given one, only the account carrying it; the name
    // (the account key) is the fallback only for a caller that sent no number.
    const accountsAll: Record<string, any> = accountsData.accounts || {};
    const byNumber = (id: number) => Object.values(accountsAll).find((a: any) => a && String(a.camperId) === String(id));
    const account = (camperIdSent != null ? byNumber(camperIdSent) : accountsAll[String(camperName)]) || {};   // name only when no camperId was sent
    const camperId: number | null = camperIdSent != null ? camperIdSent
        : (account.camperId != null ? Number(account.camperId) : null);
    // A ledger row with a number matches by its number; by name only when either side has none.
    const mine = (t: Record<string, any>) => (camperId != null && t.camperId != null) ? String(t.camperId) === String(camperId) : t.camper === camperName;
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
      .filter((t) => t && mine(t) && t.kind === "deposit" && t.method === processorKey && t.byopTransactionId)
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
        // CLAIM BEFORE THE PROCESSOR. Same reasoning as payments-refund: the
        // ledger's idempotency keys on the processor's refund id, which does not
        // exist until money has already moved. Per CHUNK, because each chunk is a
        // separate processor call and a retry may resume partway through.
        const chunkKey = (typeof idempotencyKey === "string" && idempotencyKey.trim())
          ? `${idempotencyKey.trim()}:${dep.externalTransactionId}:${chunkCents}` : null;
        if (chunkKey) {
          const { data: claim } = await service.rpc("claim_refund_intent", {
            p_camp_id: authedCampId, p_key: chunkKey, p_amount: chunk,
            p_payment_ref: String(dep.externalTransactionId),
          });
          // Already done. Skip the processor and move to the next deposit rather
          // than refunding this one twice.
          if (claim && claim.claimed === false) {
            console.log(`[canteen-refund] chunk already settled, skipping: ${chunkKey}`);
            continue;
          }
        }
        const refundResult = processorKey === "cardknox"
          ? await cardknoxRefund(credResult.credentials, dep.externalTransactionId, chunkCents)
          : await banquestRefund(credResult.credentials, dep.externalTransactionId, chunkCents);
        if (!refundResult.success) {
          // No money moved, so give the claim back or this chunk is locked out.
          if (chunkKey) {
            await service.rpc("release_refund_intent", { p_camp_id: authedCampId, p_key: chunkKey });
          }
          throw new Error(refundResult.error || "Refund failed");
        }
        if (chunkKey) {
          await service.rpc("settle_refund_intent", {
            p_camp_id: authedCampId, p_key: chunkKey,
            p_result: { success: true, externalTransactionId: refundResult.externalTransactionId,
                        amount: chunk },
          });
        }

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
          p_camper_id: camperId, p_camper_name: String(camperName ?? ""),
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
