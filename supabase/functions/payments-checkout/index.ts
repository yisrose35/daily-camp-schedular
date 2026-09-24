// =============================================================================
// payments-checkout — BYOP: the "Online Payment Link" a family opens directly,
// with no Campistry session (mirrors payments-save-method's reasoning
// exactly — this is opened by whoever the office sends the link to, same
// campOwnsFamily safety net). Tokenizes+saves the card via that camp's
// connected processor adapter, then immediately charges it for the requested
// amount, then records the result into the SAME campistryMe.finance.payments
// array stripe-webhook's upsertPayment already writes Stripe online payments
// into — so Billing computes every family's balance the same way
// (buildFamilyLedgers only ever reads finance.payments, never a
// processor-specific column) regardless of which processor produced the
// money.
//
// This is the BYOP equivalent of a Stripe Checkout Session created by
// stripe-checkout: sendPayLink() in campistry_me.js sends the parent to
// campistry_card_setup.html (in its amount+description "Pay Now" mode)
// instead of a Stripe-hosted URL when the camp has a connected, verified
// non-Stripe processor — that page calls this function on tokenize success.
//
// Request:  { campId, familyKey, familyName, token, amount, description? }
// Response: { success: true, amount, externalTransactionId } or
//           { success: false, error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAdapter } from "./_shared/processor_adapter.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Same shape as payments-save-method's own campOwnsFamily — campId is
// client-supplied and this endpoint has no session auth, so a money-moving
// action never proceeds off campId alone; this only confirms the family
// actually exists under that camp before charging or writing anything.
async function campOwnsFamily(service: ReturnType<typeof createClient>, campId: string, familyKey: string): Promise<boolean> {
  // The family ROW (camp_family), not the campistryMe document's copy of it.
  const { data, error } = await service.rpc("camp_family", { p_camp_id: campId, p_family_key: familyKey });
  return !error && !!data && typeof data === "object";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, familyKey, familyName, token, amount, description } = await req.json();
    if (!campId || !familyKey || !token || !amount) {
      return json({ success: false, error: "campId, familyKey, token, and amount are required" }, 400);
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 50) {
      return json({ success: false, error: "Enter an amount of at least $0.50" }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (!(await campOwnsFamily(service, campId, familyKey))) {
      return json({ success: false, error: "Family not found for this camp" }, 400);
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ success: false, error: "This camp is on Stripe — use the Stripe payment link instead." }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ success: false, error: `No adapter implemented for processor '${processorKey}'` }, 500);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }

    const saveResult = await adapter.saveMethod(credResult.credentials, String(token));
    if (!saveResult.success || !saveResult.customerRef) {
      return json({ success: false, error: saveResult.error || "Could not process the card — check the details and try again." }, 200);
    }

    const chargeResult = await adapter.charge(credResult.credentials, amountCents, saveResult.customerRef, description || "Camp payment");
    if (!chargeResult.success) {
      return json({ success: false, error: chargeResult.error || "Payment declined", status: chargeResult.status }, 200);
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: processorKey,
      p_external_transaction_id: chargeResult.externalTransactionId,
      p_kind: "charge",
      p_amount_cents: amountCents,
      p_status: chargeResult.status || "unknown",
      p_raw_response: chargeResult.raw ? JSON.parse(JSON.stringify(chargeResult.raw)) : null,
    });

    // Save the card on file and record the payment.
    //
    // Both used to happen in ONE blind read-modify-write of the whole
    // campistryMe blob: read, mutate families[...] and finance.payments, upsert
    // it all back. With no lock and no version check, any overlapping writer —
    // another webhook, the nightly autopay run, an office save — silently
    // discarded whichever change landed first. Losing the payment means the
    // card was charged with no record; losing the card-on-file fields means
    // autopay quietly stops working for that family.
    //
    // Two atomic calls now (migration 168), each taking a row lock across its
    // own read and write. They are separate transactions, but each is
    // independently safe and idempotent, which is strictly better than one
    // write that can lose either.
    const famRes = await service.rpc("merge_camp_family_fields", {
      p_camp_id: campId,
      p_family_key: familyKey,
      p_fields: {
        byopProcessor: processorKey,
        byopCustomerRef: saveResult.customerRef,
        cardOnFile: true,
        cardSavedDate: new Date().toISOString(),
      },
    });
    if (famRes.error || famRes.data?.success !== true) {
      const why = famRes.error?.message || famRes.data?.error || "unknown";
      if (why === "family_not_found") {
        return json({ success: false, error: "Payment succeeded (ref " + chargeResult.externalTransactionId + ") but the family record is gone — contact support." }, 500);
      }
      console.error(`[payments-checkout] could not save card on file for ${familyKey}: ${why}`);
    }

    let famName = familyName || "";
    try {
      const cur = await service.from("camp_state_kv").select("value")
        .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
      const meNow: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object") ? cur.data.value : {};
      const fNow = (meNow.families && meNow.families[familyKey]) || null;
      if (!famName && fNow && fNow.name) famName = fNow.name;
    } catch (_) { /* cosmetic only */ }

    const payRes = await service.rpc("append_camp_payment", {
      p_camp_id: campId,
      p_payment: {
        id: "byop_" + chargeResult.externalTransactionId,
        family: famName,
        familyKey: familyKey,
        amount: Number(amount),
        date: new Date().toISOString().split("T")[0],
        method: (processorKey === "cardknox" ? "Sola" : processorKey) + " (online)",
        reference: chargeResult.externalTransactionId,
        notes: "Online payment link (" + processorKey + ")",
        byopTransactionId: chargeResult.externalTransactionId,
        byopProcessor: processorKey,
        status: "succeeded",
        timestamp: Date.now(),
      },
      p_dedupe_key: chargeResult.externalTransactionId,
    });
    const saved = !payRes.error && payRes.data?.success === true;
    if (!saved) {
      return json({ success: false, error: "Payment succeeded (ref " + chargeResult.externalTransactionId + ") but could not be recorded — contact support." }, 500);
    }

    console.log(`[payments-checkout] ${processorKey} charge ${chargeResult.externalTransactionId}: $${amount} for family ${familyKey}, camp ${campId}`);
    return json({ success: true, amount, externalTransactionId: chargeResult.externalTransactionId });
  } catch (err) {
    console.error("[payments-checkout] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
