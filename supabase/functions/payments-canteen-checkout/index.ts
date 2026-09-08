// =============================================================================
// payments-canteen-checkout — BYOP: a parent's canteen "Add Funds" tap for a
// camp on a connected non-Stripe processor. No session (mirrors
// payments-save-method/payments-checkout's reasoning — the parent has none),
// opened via campistry_card_setup.html's canteen mode instead of a Stripe
// Checkout session (stripe-checkout's canteen branch).
//
// Tokenizes+saves+charges in one call (same shape as payments-checkout, the
// tuition pay-link equivalent), then credits the same JSON-blob canteen
// wallet (camp_state_kv.campistrySnacks) migration 079's Stripe path
// already writes to — get_canteen_accounts, the POS terminal, and every
// other canteen reader stay completely processor-agnostic; only the
// transaction's `method`/`byopTransactionId` fields differ from a Stripe
// deposit's `method:'stripe'`/`stripePaymentIntentId`.
//
// Request:  { campId, camperName, token, amount, description? }
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

// Canteen's own ownership check, keyed on camper name (app1.camperRoster),
// not familyKey — copied verbatim from stripe-checkout's campOwnsCamper.
// A failure here hard-rejects rather than falling through: crediting a real
// JSON balance to a possibly-fabricated camper name is a ledger-integrity
// problem, not just a routing one.
async function campOwnsCamper(service: ReturnType<typeof createClient>, campId: string, camperName: string): Promise<boolean> {
  const { data } = await service.from("camp_state_kv").select("value")
    .eq("camp_id", campId).eq("key", "app1").maybeSingle();
  const roster = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).camperRoster : null;
  return !!(roster && typeof roster === "object" && Object.prototype.hasOwnProperty.call(roster, camperName));
}

// Camp-wide "does this camp even run a canteen" gate (migration 106) —
// copied verbatim from stripe-checkout. No row for the camp means the
// program defaults on, same as everywhere else this settings table is read.
async function canteenProgramEnabled(service: ReturnType<typeof createClient>, campId: string): Promise<boolean> {
  const { data } = await service.from("camp_link_program_settings").select("canteen_enabled").eq("camp_id", campId).maybeSingle();
  return !data || data.canteen_enabled !== false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, camperName, token, amount, description } = await req.json();
    if (!campId || !camperName || !token || !amount) {
      return json({ success: false, error: "campId, camperName, token, and amount are required" }, 400);
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 50) {
      return json({ success: false, error: "Enter an amount of at least $0.50" }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (!(await canteenProgramEnabled(service, campId))) {
      return json({ success: false, error: "Canteen isn't available for this camp." }, 400);
    }
    if (!(await campOwnsCamper(service, campId, camperName))) {
      return json({ success: false, error: "Camper not found for this camp" }, 400);
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ success: false, error: "This camp is on Stripe — use the Stripe canteen checkout instead." }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ success: false, error: `No adapter implemented for processor '${processorKey}'` }, 500);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }

    // No saved-card concept for canteen (each deposit tokenizes fresh) —
    // saveMethod is still the only way this adapter shape hands back a
    // chargeable customerRef, so it's called transiently and the resulting
    // vault token is discarded once the charge below completes.
    const saveResult = await adapter.saveMethod(credResult.credentials, String(token));
    if (!saveResult.success || !saveResult.customerRef) {
      return json({ success: false, error: saveResult.error || "Could not process the card — check the details and try again." }, 200);
    }

    const chargeResult = await adapter.charge(credResult.credentials, amountCents, saveResult.customerRef, description || ("Canteen funds — " + camperName));
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

    const { data: creditResult, error: creditErr } = await service.rpc("credit_canteen_balance_from_processor", {
      p_camp_id: campId,
      p_camper_name: camperName,
      p_amount: Number(amount),
      p_processor_key: processorKey,
      p_external_transaction_id: chargeResult.externalTransactionId,
    });
    if (creditErr || !creditResult?.success) {
      return json({ success: false, error: "Payment succeeded (ref " + chargeResult.externalTransactionId + ") but could not be credited — contact support." }, 500);
    }

    console.log(`[payments-canteen-checkout] ${processorKey} charge ${chargeResult.externalTransactionId}: $${amount} for ${camperName}, camp ${campId}`);
    return json({ success: true, amount, externalTransactionId: chargeResult.externalTransactionId });
  } catch (err) {
    console.error("[payments-canteen-checkout] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
