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

// Credential test-connection, inlined per processor rather than imported from
// _shared/adapters/*.ts: this project deploys edge functions by pasting ONE
// file into the Supabase Dashboard (no CLI — see CLAUDE.md), so ANY relative
// import fails to bundle (that broken "./_shared" import is exactly why this
// function could never boot before). Keep in sync with each adapter's
// testConnection().

// Cardknox/Sola: cc:sale with Sola's published always-decline sandbox card +
// trigger amount ($9.91) — a clean decline still proves the key authenticates;
// only xResult 'E' is a real failure. No real card, no money moved.
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxTestConnection(creds: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  const apiKey = creds.apiKey;
  if (!apiKey) return { success: false, error: "Missing apiKey" };
  try {
    const resp = await fetch(CARDKNOX_GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        xKey: apiKey, xVersion: "4.5.9", xSoftwareName: "Campistry", xSoftwareVersion: "1.0",
        xCommand: "cc:sale", xCardNum: "4444333322221111", xExp: "1230", xAmount: "9.91",
        xInvoice: "TEST-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      }).toString(),
    });
    const r: Record<string, string> = {};
    new URLSearchParams(await resp.text()).forEach((v, k) => { r[k] = v; });
    if (r.xResult === "E") return { success: false, error: r.xError || "Gateway returned an error" };
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// Banquest (AffiniPay/8am) JSON API. Auth is HTTP Basic base64(sourceKey:pin);
// the API base is per-camp (sandbox vs prod). testConnection POSTs an empty
// body to /transactions/verify — a valid key returns a validation error
// (auth OK, nothing charged), a bad key returns 401/403.
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com";
function bqBase(c: Record<string, string>): string {
  return (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}
async function banquestTestConnection(creds: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  if (!creds.sourceKey || !creds.pin) return { success: false, error: "Missing sourceKey/pin" };
  try {
    const resp = await fetch(`${bqBase(creds)}/transactions/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
      body: JSON.stringify({}),
    });
    if (resp.status === 401 || resp.status === 403) {
      let msg = "Authentication failed";
      try { const d = await resp.json(); msg = d?.error || d?.message || msg; } catch { /* ignore */ }
      return { success: false, error: msg };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

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

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service.from("camps").select("id, name").eq("id", campId).maybeSingle();
    if (!camp) return json({ success: false, error: "No camp with that id." }, 404);

    // Test BEFORE storing — an unverified credential is never persisted.
    // Inlined per processor (see the header block re: Dashboard deploy).
    let test: { success: boolean; error?: string };
    if (processorKey === "cardknox") {
      test = await cardknoxTestConnection(credentials);
    } else if (processorKey === "banquest") {
      test = await banquestTestConnection(credentials);
    } else {
      return json({ success: false, error: `No adapter implemented for processor '${processorKey}' yet.` }, 400);
    }
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

    // A camp switching processors leaves every family's/camper's old saved
    // card dead — a token tokenized on one gateway can't be charged on
    // another. Scrub anything that doesn't match the processor just connected,
    // so Link and Me only ever show a card that actually works. Best-effort:
    // never fail the connect over cleanup (migration 147).
    try {
      const { data: cleared } = await service.rpc("_admin_clear_stale_byop_cards", { p_camp_id: campId, p_processor_key: processorKey });
      if (cleared?.cleared) console.log(`[admin-connect-processor] cleared ${cleared.cleared} stale saved card(s) not matching ${processorKey}`);
    } catch (e) {
      console.error("[admin-connect-processor] stale-card cleanup failed (non-fatal):", (e as Error).message);
    }

    console.log(`[admin-connect-processor] Connected ${processorKey} for camp "${camp.name}" (${campId})`);

    return json({ success: true, campName: camp.name, processorKey });
  } catch (err) {
    console.error("[admin-connect-processor] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
