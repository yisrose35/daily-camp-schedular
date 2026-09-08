// =============================================================================
// admin-connect-processor — the human-assisted BYOP onboarding tool.
//
// Deliberately NOT camp-facing. Per the explicit decision behind this
// feature: a camp's processor API key/secret is live and can move real
// money out of their own account if mishandled, so credential handoff goes
// through a Campistry staffer verifying the camp (by call/support channel),
// not a self-serve Dashboard form. This function is that staffer's tool —
// see BYOP_SETUP.md for the actual step-by-step runbook, including the exact
// request to send.
//
// Auth: gated on the raw Supabase SERVICE ROLE key as the bearer token —
// the same key already sitting in Supabase Dashboard → Settings → API,
// which only the Campistry operator has (same key cron jobs already use
// internally, just now also accepted directly as a caller credential for
// this one function). No new secret to create or distribute, no new
// internal-staff-auth system to build — reuses infrastructure that already
// exists specifically for "only the platform operator can do this."
//
// Flow: test the credential for real against the processor's own API
// BEFORE ever persisting it (never store an unverified key), then persist
// via the service-role-only RPCs added in migration 126.
//
// Request:  { campId, processorKey, credentials, notes? }
//           header: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
// Response: { success: true } or { success: false, error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAdapter } from "../_shared/processor_adapter.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!SUPABASE_SERVICE_KEY || bearer !== SUPABASE_SERVICE_KEY) {
      // Deliberately generic — never hint at why to an unauthenticated caller.
      return json({ success: false, error: "unauthorized" }, 401);
    }

    const { campId, processorKey, credentials, notes } = await req.json();
    if (!campId || !processorKey || !credentials || typeof credentials !== "object") {
      return json({ success: false, error: "campId, processorKey, and credentials (object) are required" }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ success: false, error: `No adapter implemented for processor '${processorKey}' yet.` }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service.from("camps").select("id, name").eq("id", campId).maybeSingle();
    if (!camp) return json({ success: false, error: "No camp with that id." }, 404);

    // Test BEFORE storing — an unverified credential is never persisted.
    const test = await adapter.testConnection(credentials);
    if (!test.success) {
      return json({ success: false, error: `Credential test failed: ${test.error || "unknown error"}` }, 400);
    }

    const { data: storeResult, error: storeErr } = await service.rpc("_admin_store_camp_processor_credentials", {
      p_camp_id: campId,
      p_processor_key: processorKey,
      p_vault_secret: JSON.stringify(credentials),
      p_connected_by: null, // no staff auth.uid() to attribute this to in a service-role-only call — notes is the audit trail instead
      p_notes: notes || null,
    });
    if (storeErr || !storeResult?.success) {
      return json({ success: false, error: storeResult?.error || storeErr?.message || "Failed to store credentials." }, 500);
    }

    await service.rpc("_admin_mark_processor_verified", { p_camp_id: campId, p_ok: true });

    console.log(`[admin-connect-processor] Connected ${processorKey} for camp "${camp.name}" (${campId})`);

    return json({ success: true, campName: camp.name, processorKey });
  } catch (err) {
    console.error("[admin-connect-processor] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
