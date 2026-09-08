// =============================================================================
// payments-save-method — BYOP: turn a client-side tokenization result
// (NMI Collect.js / Cardknox iFields — see campistry_card_setup.html) into
// a durable saved payment method on a family's record, the missing piece
// that makes payments-charge/payments-refund actually usable for a BYOP
// camp.
//
// No session auth, by design — mirrors stripe-checkout's own reasoning
// exactly (this is opened either by office staff on a family's behalf, or
// potentially directly by a family with no Link account yet, same as the
// existing "office-side fallback" Stripe flow in campistry_me.js's
// requestCardSetup()). campOwnsFamily() is the same safety net
// stripe-checkout already uses for the same reason — it blocks a stale/
// wrong campId sent alongside a real family's key, though (documented
// there, same residual gap here) it can't fully stop a targeted phishing
// attempt from someone who has gone through real onboarding for their OWN
// camp. Closing that fully needs real session auth end-to-end, same
// deferred item already flagged on stripe-checkout — not solved here
// either, for the same reasons (no live account to test a session-based
// rework against yet).
//
// Request:  { campId, familyKey, token }
// Response: { success: true } or { success: false, error }
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

// Same shape as stripe-checkout's own campOwnsFamily — campId is
// client-supplied and this endpoint has no session auth, so a destructive
// or money-moving action never proceeds off campId alone; this only
// confirms the family actually exists under that camp before writing
// anything onto its record.
async function campOwnsFamily(service: ReturnType<typeof createClient>, campId: string, familyKey: string): Promise<boolean> {
  const { data } = await service.from("camp_state_kv").select("value")
    .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
  const families = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).families : null;
  return !!(families && typeof families === "object" && Object.prototype.hasOwnProperty.call(families, familyKey));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, familyKey, token } = await req.json();
    if (!campId || !familyKey || !token) {
      return json({ success: false, error: "campId, familyKey, and token are required" }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (!(await campOwnsFamily(service, campId, familyKey))) {
      return json({ success: false, error: "Family not found for this camp" }, 400);
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ success: false, error: "This camp is on Stripe — use the Stripe card-setup flow instead." }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ success: false, error: `No adapter implemented for processor '${processorKey}'` }, 500);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }

    const saveResult = await adapter.saveMethod(credResult.credentials, String(token));
    if (!saveResult.success || !saveResult.customerRef) {
      return json({ success: false, error: saveResult.error || "Could not save payment method" }, 200);
    }

    // Same retry-loop read-modify-write convention already used by
    // stripe-webhook's handleAutopaySetup for this exact JSON blob.
    let saved = false;
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      const cur = await service.from("camp_state_kv").select("value")
        .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
      const me: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object") ? cur.data.value : {};
      if (!me.families || typeof me.families !== "object") me.families = {};
      const f = me.families[familyKey];
      if (!f) return json({ success: false, error: "Family no longer exists" }, 400);

      f.byopProcessor = processorKey;
      f.byopCustomerRef = saveResult.customerRef;
      f.cardOnFile = true;
      f.cardSavedDate = new Date().toISOString();

      const up = await service.from("camp_state_kv").upsert(
        { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
        { onConflict: "camp_id,key" },
      );
      if (!up.error) saved = true;
    }
    if (!saved) return json({ success: false, error: "Payment method saved with the processor but could not be recorded — contact support." }, 500);

    console.log(`[payments-save-method] Saved ${processorKey} method for family ${familyKey}, camp ${campId}`);
    return json({ success: true });
  } catch (err) {
    console.error("[payments-save-method] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
