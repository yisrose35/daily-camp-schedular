// =============================================================================
// payments-refund — BYOP dispatcher: refund a previous charge through
// whichever processor the caller's camp has connected.
//
// Same auth model as payments-charge (see that file's header) — the acting
// camp is always derived from the caller's own authenticated session, never
// from a client-supplied campId, so there is no way to refund against a
// different camp's processor connection than the one the caller actually
// belongs to.
//
// Request:  { externalTransactionId, amount? }
//           header: Authorization: Bearer <caller's Supabase access token>
//           (amount omitted = full refund of whatever was charged; the
//           adapter interface always takes an explicit amountCents, so a
//           full refund here means the CALLER must pass the original
//           charge amount — unlike Stripe's refund endpoint, this dispatcher
//           has no way to look up "the original amount" itself without a
//           processor-specific query call, which not every adapter may
//           support. Flagged in BYOP_SETUP.md as a known rough edge to
//           smooth out once a second adapter exists to compare against.)
// Response: { externalTransactionId, status, amount } or { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Cardknox/Sola refund, inlined so this function is fully self-contained and
// deployable via the Supabase Dashboard (no CLI, no ../_shared bundling — the
// old shared-adapter import path was broken and could never boot). Mirrors
// _shared/adapters/cardknox_adapter.ts's refund().
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
    // Success = an "A" status_code (or "Approved"/"Voided" status word); the
    // new reversal transaction's own reference_number is what we record.
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
    const campId = await callerCampId(req);
    if (!campId) return json({ error: "Only camp owners/admins can issue a refund." }, 403);

    const { externalTransactionId, amount, idempotencyKey, confirmNotRefunded } = await req.json();
    if (!externalTransactionId || !amount || !(Number(amount) > 0)) {
      return json({ error: "externalTransactionId and amount are required (see this file's header re: full refunds)." }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-refund instead." }, 400);
    }

    if (processorKey !== "cardknox" && processorKey !== "banquest") return json({ error: `Refunds aren't supported yet for processor '${processorKey}'.` }, 400);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    const amountCents = Math.round(Number(amount) * 100);

    // CLAIM BEFORE THE PROCESSOR, NOT AFTER.
    //
    // record_external_refund is idempotent on the processor's refund id — which
    // does not exist until the call below has already moved money. So a repeat of
    // this request creates a SECOND refund and books both correctly: the ledger
    // stays right and the family is paid twice. The claim is the only thing that
    // can prevent it, and it has to be taken first.
    //
    // A request with no key proceeds unguarded, exactly as it did before this
    // existed. A missing header must not stop an office issuing money.
    const claimKey = typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? idempotencyKey.trim() : null;
    if (claimKey) {
      const { data: claim } = await service.rpc("claim_refund_intent", {
        p_camp_id: campId, p_key: claimKey,
        p_amount: Number((amountCents / 100).toFixed(2)),
        p_payment_ref: String(externalTransactionId),
      });
      if (claim && claim.claimed === false) {
        if (claim.previous && claim.previous.externalTransactionId) {
          // Somebody already did this. Replay their answer rather than refunding
          // again — a retry should look like the success it is repeating.
          console.log(`[payments-refund] replaying settled refund for key ${claimKey}`);
          return json(Object.assign({ replayed: true }, claim.previous), 200);
        }
        // Held, never confirmed: an earlier try was cut off after the card
        // company was asked, or is still running (TED-093). Not a success to
        // replay and not a reason to refund again — unless the office has looked
        // at the processor and says nothing went through.
        if (confirmNotRefunded !== true) {
          return json({ uncertain: true, error: "An earlier try at this refund was never confirmed by the card company. Check the processor's dashboard: if it is not there, confirm and it will be sent." }, 200);
        }
        await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: claimKey });
        const { data: again } = await service.rpc("claim_refund_intent", {
          p_camp_id: campId, p_key: claimKey,
          p_amount: Number((amountCents / 100).toFixed(2)),
          p_payment_ref: String(externalTransactionId),
        });
        if (again && again.claimed === false) {
          return json({ uncertain: true, error: "This refund is being sent right now by someone else." }, 200);
        }
      }
    }

    const result = processorKey === "cardknox"
      ? await cardknoxRefund(credResult.credentials, String(externalTransactionId), amountCents)
      : await banquestRefund(credResult.credentials, String(externalTransactionId), amountCents);

    if (!result.success && result.uncertain) {
      // Maybe it moved money (TED-093). Keep the claim: a retry is told to check
      // the processor instead of sending a second refund.
      console.error(`[payments-refund] ${processorKey} refund of ${externalTransactionId} unconfirmed: ${result.error}`);
      return json({ uncertain: true, error: "The card company did not answer, so this refund may or may not have gone through. Check the processor's dashboard before trying again." }, 200);
    }
    if (!result.success) {
      // The processor did NOT move money, so hand the claim back — otherwise a
      // dropped connection locks this refund out for good: the office retries, is
      // told it already happened, and the family never sees the money.
      if (claimKey) {
        await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: claimKey });
      }
      return json({ error: result.error || "Refund failed", status: result.status }, 200);
    }

    // Record what the processor said, so a later retry of the same key replays
    // this answer instead of looking like a fresh failure.
    if (claimKey) {
      await service.rpc("settle_refund_intent", {
        p_camp_id: campId, p_key: claimKey,
        p_result: { success: true, externalTransactionId: result.externalTransactionId,
                    status: result.status || "unknown", amount: amountCents / 100 },
      });
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: processorKey,
      p_external_transaction_id: result.externalTransactionId,
      p_kind: "refund",
      p_amount_cents: amountCents,
      p_status: result.status || "unknown",
      p_raw_response: result.raw ? JSON.parse(JSON.stringify(result.raw)) : null,
    });

    // ...and the family's BALANCE, not just the processor's transaction log.
    // This used to end here, so a refund on a BYOP camp left the family showing
    // a credit they no longer had. Billing's own screen looked right because it
    // reads finance.payments, which the browser writes after this returns — but
    // the parent portal answers from the posted ledger, and nothing put it
    // there. Posting server-side also means the refund survives the browser
    // being closed between the gateway call and the save.
    //
    // Keyed on the refund's own transaction id, which is the same key the
    // browser's row carries, so the two cannot post it twice.
    try {
      const { data: refData, error: refErr } = await service.rpc("record_external_refund", {
        p_camp_id: campId,
        p_refund_id: String(result.externalTransactionId),
        p_refs: [String(externalTransactionId)],
        p_amount: Number((amountCents / 100).toFixed(2)),
        p_note: `Refund — ${processorKey}`,
      });
      if (refErr || !refData?.success) {
        console.error(`[payments-refund] refund ${result.externalTransactionId} succeeded at ` +
          `${processorKey} but was NOT posted to the family ledger ` +
          `(${refErr?.message || refData?.error || "unknown"}) — the family still shows a ` +
          `credit they no longer have. Original transaction: ${externalTransactionId}`);
      }
    } catch (e) {
      console.error(`[payments-refund] ledger post threw: ${(e as Error).message}`);
    }

    console.log(`[payments-refund] ${processorKey} refund ${result.externalTransactionId}: ${result.status} — $${amount} (camp ${campId})`);

    return json({ externalTransactionId: result.externalTransactionId, status: result.status, amount });
  } catch (err) {
    console.error("[payments-refund] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
