// =============================================================================
// payments-charge — BYOP dispatcher: charge a family's saved payment method
// through whichever processor the caller's camp has connected.
//
// Mirrors stripe-charge's auth model exactly (same reasoning, same
// callerCampId derivation — never trust a client-supplied campId to decide
// where the charge runs or which credentials get used). The one thing this
// function does NOT do is decide "should this camp even be calling me" —
// that's the client's job (campistry_me.js checks the camp's
// payment_processor_key and only calls this function for a non-Stripe camp;
// Stripe camps keep calling stripe-charge directly, completely unchanged).
// If a Stripe camp ends up here anyway, this function safely no-ops with a
// clear error rather than trying to do anything Stripe-specific — 'stripe'
// is deliberately not one of the adapters this function knows how to load.
//
// SELF-CONTAINED (TED-054). This used to import a shared adapter file that
// does not exist next to it, so it could never start and the office's "Charge
// card" failed on every Banquest/Cardknox camp. The two gateway calls are
// inlined, copied from charge-due-installments (keep them in sync), because
// this project deploys a function by pasting one file into the Dashboard.
//
// WHOSE CARD. The saved card must belong to one of the caller's own camp's
// families (the same rule stripe-charge follows), and a charge sent with an
// idempotencyKey is claimed before the gateway is called, so a retried click
// replays the first answer instead of charging twice.
//
// Request:  { customerRef, amount, description?, familyKey?, idempotencyKey? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { externalTransactionId, status, amount } or { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxCharge(apiKey: string, amountCents: number, cardToken: string) {
  const resp = await fetch(CARDKNOX_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      xKey: apiKey,
      xVersion: "4.5.9",
      xSoftwareName: "Campistry",
      xSoftwareVersion: "1.0",
      xCommand: "cc:sale",
      xAmount: (amountCents / 100).toFixed(2),
      xToken: cardToken,
      xInvoice: "CI-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    }).toString(),
  });
  const parsed: Record<string, string> = {};
  new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
  if (parsed.xResult !== "A") {
    return { success: false, error: parsed.xError || "Declined", status: parsed.xStatus, raw: parsed };
  }
  return { success: true, externalTransactionId: parsed.xRefNum, status: parsed.xStatus, raw: parsed };
}

// Banquest (AffiniPay/8am) sale against a saved card_ref — inlined for the same
// Dashboard-deploy reason as the Cardknox call above; keep in sync with
// _shared/adapters/banquest_adapter.ts. Auth is HTTP Basic base64(sourceKey:
// pin); API base is per-camp and lives under /api/v2; amounts are DOLLARS; a
// saved card is charged as source "tkn-<card_ref>". Approval is reported by
// status_code "A" (status "Approved"); the transaction's integer
// `reference_number` is what we store to later refund/reverse it.
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  // A stored gatewayUrl that already ends in /v2 or /api/v2 is used verbatim;
  // a bare host gets /api/v2 appended. Both spellings are honoured on purpose:
  // the API reference documents the base as /api/v2, while the Hosted
  // Tokenization guide's own backend example posts to /v2 — so whichever path
  // the camp actually stores is the one we call.
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
async function banquestCharge(creds: Record<string, string>, amountCents: number, cardRef: string) {
  const resp = await fetch(`${bqBase(creds)}/transactions/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${creds.sourceKey}:${creds.pin}`) },
    // A saved card is either a verify card_ref (charged "tkn-<ref>") or a
    // Customer payment-method saved on the hosted page (already stored WITH its
    // "pm-<id>" prefix). Pass an already-prefixed ref through untouched.
    body: JSON.stringify({ amount: Number((amountCents / 100).toFixed(2)), source: /^(tkn-|pm-|ref-|nonce-)/.test(cardRef) ? cardRef : "tkn-" + cardRef }),
  });
  let data: Record<string, any> = {};
  try { data = await resp.json(); } catch { /* non-JSON error body */ }
  const approved = String(data?.status_code || "").toUpperCase() === "A"
                || String(data?.status || "").toLowerCase() === "approved";
  const ref = data?.reference_number != null ? String(data.reference_number) : "";
  if (resp.status < 200 || resp.status >= 300 || !approved || !ref) {
    const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Declined (HTTP ${resp.status})`;
    return { success: false, error: errMsg, status: data?.status, raw: data };
  }
  return { success: true, externalTransactionId: ref, status: data?.status, raw: data };
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

// Identical shape to stripe-charge's own callerCampId — kept as its own copy
// rather than imported, because each function is deployed as one pasted file.
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
    if (!campId) return json({ error: "Only camp owners/admins can charge a stored payment method." }, 403);

    const { customerRef, amount, idempotencyKey } = await req.json();
    if (!customerRef || !(Number(amount) > 0)) return json({ error: "customerRef and a positive amount required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-charge instead." }, 400);
    }

    if (processorKey !== "cardknox" && processorKey !== "banquest") {
      return json({ error: `Charging a saved card isn't supported yet for processor '${processorKey}'.` }, 400);
    }

    // Only a card saved for one of THIS camp's families.
    const { data: families } = await service.rpc("camp_families_object", { p_camp_id: campId });
    const owns = !!families && typeof families === "object" &&
      Object.values(families as Record<string, any>).some((f: any) => f && String(f.byopCustomerRef || "") === String(customerRef));
    if (!owns) return json({ error: "That card is not on file for a family at your camp." }, 403);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    const creds = credResult.credentials || {};
    const amountCents = Math.round(Number(amount) * 100);

    // Claim before the gateway (the same claim table refunds use, migration 198).
    const claimKey = typeof idempotencyKey === "string" && idempotencyKey.trim() ? "charge:" + idempotencyKey.trim() : null;
    if (claimKey) {
      const { data: claim } = await service.rpc("claim_refund_intent", {
        p_camp_id: campId, p_key: claimKey, p_amount: amountCents / 100, p_payment_ref: String(customerRef),
      });
      if (claim && claim.claimed === false) {
        return json(Object.assign({ replayed: true }, claim.previous || {}), 200);
      }
    }

    const result = processorKey === "cardknox"
      ? await cardknoxCharge(String(creds.apiKey || ""), amountCents, String(customerRef))
      : await banquestCharge(creds, amountCents, String(customerRef));

    if (!result.success) {
      if (claimKey) await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: claimKey });
      return json({ error: result.error || "Charge declined", status: result.status }, 200);
    }
    if (claimKey) {
      await service.rpc("settle_refund_intent", {
        p_camp_id: campId, p_key: claimKey,
        p_result: { externalTransactionId: result.externalTransactionId, status: result.status, amount: amountCents / 100 },
      });
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: processorKey,
      p_external_transaction_id: result.externalTransactionId,
      p_kind: "charge",
      p_amount_cents: amountCents,
      p_status: result.status || "unknown",
      p_raw_response: result.raw ? JSON.parse(JSON.stringify(result.raw)) : null,
    });

    console.log(`[payments-charge] ${processorKey} charge ${result.externalTransactionId}: ${result.status} — $${amount} (camp ${campId})`);

    return json({ externalTransactionId: result.externalTransactionId, status: result.status, amount });
  } catch (err) {
    console.error("[payments-charge] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
