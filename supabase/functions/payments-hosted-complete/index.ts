// =============================================================================
// payments-hosted-complete — the return leg of the Banquest redirect flow.
//
// After the parent pays / saves a card on Banquest's hosted Payment Page, they
// come back to Campistry with ?key=<key> in the URL. The browser calls this
// with that key; we look it up in banquest_pending_links (written by
// payments-hosted-link) to know WHAT the parent was doing — trusting only the
// opaque key, never anything else the browser sends — then confirm and record
// it against Banquest's own records:
//
//   GET /transactions?key=<key>   → the transaction (status_details.status,
//        transaction_details.reference_number, amount_details.amount,
//        customer.customer_id, card_details.last4/card_type).
//
// By purpose:
//   pay_now  → append the payment to the family ledger (me.finance.payments).
//   canteen  → credit_canteen_balance_from_processor (idempotent on the txn id).
//   save_card→ the hosted page saves the card to a Banquest Customer; we read
//        that customer's newest card payment-method
//        (GET /customers/{id}/payment-methods) and store it as source
//        "pm-<id>" — the durable token autopay/auto-reload charge later.
//
// Idempotent: a completed pending row short-circuits to its recorded result, so
// a double return / refresh never double-records.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/api\/v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}

// A transaction's status lives in status_details.status; these mean "the money
// moved / card is good", everything else (declined/error/voided/cancelled/
// returned/expired/blocked) is a failure.
const SUCCESS_STATUSES = new Set(["captured", "settled", "approved"]);
function txStatus(t: Record<string, any>): string {
  return String(t?.status_details?.status || t?.status || "").toLowerCase();
}
function txRef(t: Record<string, any>): string {
  const r = t?.transaction_details?.reference_number ?? t?.reference_number ?? t?.id;
  return r != null ? String(r) : "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId: bodyCampId, key } = await req.json();
    if (!key) return json({ success: false, error: "key is required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // The Banquest return URL only carries the opaque one-time `key`; the
    // pending row (its primary key) is the source of truth for which camp /
    // family / camper / purpose it belongs to. campId, if the caller passes it,
    // is only cross-checked.
    const { data: pending } = await service.from("banquest_pending_links")
      .select("*").eq("key", String(key)).maybeSingle();
    if (!pending) return json({ success: false, error: "This payment link is unknown or has expired." }, 404);
    if (bodyCampId && String(bodyCampId) !== String(pending.camp_id)) {
      return json({ success: false, error: "This payment link does not belong to that camp." }, 400);
    }
    const campId = pending.camp_id;

    // Already recorded — replay the stored outcome (refresh / double return).
    if (pending.status === "completed") {
      return json({ success: true, purpose: pending.purpose, alreadyRecorded: true, last4: pending.last4 });
    }

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) return json({ success: false, error: credResult?.error || "This camp's processor isn't connected." }, 400);
    const creds = credResult.credentials as Record<string, string>;
    if (!creds?.sourceKey || !creds?.pin) return json({ success: false, error: "This camp's Banquest credential is incomplete." }, 400);

    // Find the transaction the hosted page produced for this key.
    const listResp = await fetch(`${bqBase(creds)}/transactions?order=desc&limit=10&key=${encodeURIComponent(String(key))}`, {
      headers: { "Authorization": bqAuth(creds) },
    });
    let list: any = [];
    try { list = await listResp.json(); } catch { /* non-JSON */ }
    if (listResp.status < 200 || listResp.status >= 300) {
      return json({ success: false, error: `Could not verify the payment (HTTP ${listResp.status}).` }, 200);
    }
    const txns: Record<string, any>[] = Array.isArray(list) ? list : (Array.isArray(list?.transactions) ? list.transactions : []);
    // Prefer a transaction whose recorded key matches; fall back to the newest.
    const tx = txns.find((t) => String(t?.transaction_details?.key || "") === String(key)) || txns[0];

    if (!tx) {
      // No transaction yet — the parent may have abandoned the page, or Banquest
      // hasn't recorded it. Leave the pending row alone so a later retry works.
      return json({ success: false, error: "No completed payment found yet for this link.", pending: true }, 200);
    }
    if (!SUCCESS_STATUSES.has(txStatus(tx))) {
      await service.from("banquest_pending_links").update({ status: "failed", completed_at: new Date().toISOString() }).eq("key", String(key));
      return json({ success: false, error: `The payment did not go through (status: ${txStatus(tx) || "unknown"}).` }, 200);
    }

    const referenceNumber = txRef(tx);
    const last4 = tx?.card_details?.last4 || tx?.card_details?.last_4 || null;
    const cardType = tx?.card_details?.card_type || null;
    const amount = Number(tx?.amount_details?.amount ?? pending.amount ?? 0);

    // ── save_card: pull the durable token off the Customer the page created ──
    if (pending.purpose === "save_card") {
      const customerId = tx?.customer?.customer_id;
      if (!customerId) {
        return json({ success: false, error: "The card was entered but Banquest didn't attach it to a customer — the hosted page needs 'save card' enabled." }, 200);
      }
      const pmResp = await fetch(`${bqBase(creds)}/customers/${encodeURIComponent(String(customerId))}/payment-methods?type=card`, {
        headers: { "Authorization": bqAuth(creds) },
      });
      let pms: any = [];
      try { pms = await pmResp.json(); } catch { /* non-JSON */ }
      const methods: Record<string, any>[] = Array.isArray(pms) ? pms : [];
      // Newest by created_at, else the default, else the first.
      methods.sort((a, b) => String(b?.created_at || "").localeCompare(String(a?.created_at || "")));
      const pm = methods.find((m) => m?.is_default) || methods[0];
      if (!pm?.id) {
        return json({ success: false, error: "The card was saved but no reusable token came back from Banquest." }, 200);
      }
      const token = "pm-" + pm.id;
      const pmLast4 = pm?.last4 || last4;
      const pmType = pm?.card_type || cardType || "card";

      let saved = false;
      if (pending.camper_name) {
        // Canteen auto-reload card-save: token lives on the camper's autoReload
        // block (campistrySnacks.accounts[camper].autoReload), mirroring the
        // Cardknox canteen_autoreload_setup path.
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          const cur = await service.from("camp_state_kv").select("value")
            .eq("camp_id", campId).eq("key", "campistrySnacks").maybeSingle();
          const snacks: Record<string, any> = (cur.data?.value && typeof cur.data.value === "object") ? cur.data.value : {};
          if (!snacks.accounts || typeof snacks.accounts !== "object") snacks.accounts = {};
          const acct = snacks.accounts[pending.camper_name];
          if (!acct) return json({ success: false, error: "Camper no longer exists" }, 400);
          const ar = (acct.autoReload && typeof acct.autoReload === "object") ? acct.autoReload : {};
          ar.byopProcessor = "banquest";
          ar.byopCustomerRef = token;
          ar.cardOnFile = true;
          // Re-enable and reset the failure counter, same as a fresh card save.
          ar.consecutiveFailures = 0;
          if (pmLast4) { ar.paymentMethodLabel = "•••• " + pmLast4; ar.paymentMethodType = pmType; }
          acct.autoReload = ar;
          snacks.accounts[pending.camper_name] = acct;
          const up = await service.from("camp_state_kv").upsert(
            { camp_id: campId, key: "campistrySnacks", value: snacks, updated_at: new Date().toISOString() },
            { onConflict: "camp_id,key" });
          if (!up.error) saved = true;
        }
      } else {
        // Tuition card-save: token lives on the family record.
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          const cur = await service.from("camp_state_kv").select("value")
            .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
          const me: Record<string, any> = (cur.data?.value && typeof cur.data.value === "object") ? cur.data.value : {};
          if (!me.families || typeof me.families !== "object") me.families = {};
          const f = me.families[pending.family_key];
          if (!f) return json({ success: false, error: "Family no longer exists" }, 400);
          f.byopProcessor = "banquest";
          f.byopCustomerRef = token;
          f.cardOnFile = true;
          f.cardSavedDate = new Date().toISOString();
          if (pmLast4) { f.paymentMethodLabel = "•••• " + pmLast4; f.paymentMethodType = pmType; }
          const up = await service.from("camp_state_kv").upsert(
            { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
            { onConflict: "camp_id,key" });
          if (!up.error) saved = true;
        }
      }
      if (!saved) return json({ success: false, error: "Card saved with Banquest but could not be recorded — contact support." }, 500);

      await service.from("banquest_pending_links").update({
        status: "completed", completed_at: new Date().toISOString(),
        reference_number: referenceNumber ? Number(referenceNumber) : null, card_ref: token, last4: pmLast4,
      }).eq("key", String(key));
      return json({ success: true, purpose: "save_card", last4: pmLast4 });
    }

    // ── canteen: credit the camper's balance (idempotent on the txn id) ──────
    if (pending.purpose === "canteen") {
      const creditRes = await service.rpc("credit_canteen_balance_from_processor", {
        p_camp_id: campId,
        p_camper_name: pending.camper_name,
        p_amount: amount,
        p_processor_key: "banquest",
        p_external_transaction_id: referenceNumber,
        p_source: "parent",
      });
      if (creditRes.error || !creditRes.data?.success) {
        console.error(`[payments-hosted-complete] canteen credit failed camp ${campId}/${pending.camper_name}: ${creditRes.error?.message || creditRes.data?.error}`);
        return json({ success: false, error: "Payment went through but crediting the balance failed — contact support." }, 200);
      }
      await service.from("banquest_pending_links").update({
        status: "completed", completed_at: new Date().toISOString(),
        reference_number: referenceNumber ? Number(referenceNumber) : null, last4,
      }).eq("key", String(key));
      return json({ success: true, purpose: "canteen", amount, last4 });
    }

    // ── pay_now: append the tuition payment to the family ledger ─────────────
    let recorded = false;
    for (let attempt = 0; attempt < 4 && !recorded; attempt++) {
      const cur = await service.from("camp_state_kv").select("value")
        .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
      const me: Record<string, any> = (cur.data?.value && typeof cur.data.value === "object") ? cur.data.value : {};
      if (!me.finance) me.finance = {};
      if (!Array.isArray(me.finance.payments)) me.finance.payments = [];
      const pays: Record<string, any>[] = me.finance.payments;
      if (pays.find((p) => p.byopTransactionId === referenceNumber)) { recorded = true; break; }
      const f = (me.families && me.families[pending.family_key]) || null;
      pays.push({
        id: "byop_" + referenceNumber,
        family: (f && f.name) || pending.family_key, familyKey: pending.family_key,
        amount, date: new Date().toISOString().split("T")[0],
        method: "Card (Banquest, hosted page)",
        reference: referenceNumber, notes: "Paid on Banquest hosted page",
        byopTransactionId: referenceNumber, byopProcessor: "banquest",
        status: "succeeded", timestamp: Date.now(),
      });
      const up = await service.from("camp_state_kv").upsert(
        { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
        { onConflict: "camp_id,key" });
      if (!up.error) recorded = true;
    }
    if (!recorded) return json({ success: false, error: "Payment went through but recording it failed — contact support." }, 500);

    await service.from("banquest_pending_links").update({
      status: "completed", completed_at: new Date().toISOString(),
      reference_number: referenceNumber ? Number(referenceNumber) : null, last4,
    }).eq("key", String(key));
    return json({ success: true, purpose: "pay_now", amount, last4 });
  } catch (err) {
    console.error("[payments-hosted-complete] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
