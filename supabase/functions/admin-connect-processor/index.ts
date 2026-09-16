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

    // ── The steps this call CANNOT do for you ───────────────────────────────
    //
    // Connecting a camp has always had manual steps left over — they live in
    // the camp's OWN processor dashboard, which we have no access to. Those
    // steps were written down in BYOP_SETUP.md and nowhere else, and the
    // dispute webhook is the proof that is not good enough: a camp onboarded
    // without it takes payments perfectly well and only reveals the gap months
    // later, when a parent charges back and the money leaves the camp's bank
    // account with nothing in Campistry to show for it.
    //
    // So the checklist is returned HERE, at the moment someone is onboarding a
    // camp, with the real URLs already filled in. Nothing to look up and
    // nothing to remember.
    const steps: Array<{ do: string; why: string }> = [];

    // Does this camp's webhook URL need &camp=? Counted, not remembered. With
    // one camp on a processor the webhook resolves the camp itself; with
    // several it refuses to guess, because posting a chargeback against the
    // wrong camp's books is worse than not recording it.
    let campsOnProcessor = 1;
    let otherCampIds: string[] = [];
    try {
      const { data: onProc } = await service
        .from("camp_processor_credentials")
        .select("camp_id")
        .eq("processor_key", processorKey);
      if (onProc && onProc.length > 0) {
        campsOnProcessor = onProc.length;
        otherCampIds = onProc.map((r: { camp_id: string }) => String(r.camp_id))
                             .filter((id: string) => id !== String(campId));
      }
    } catch {
      // Can't count: assume the ambiguous case. An unnecessary &camp= is
      // harmless; a missing one silently drops every dispute for this camp.
      campsOnProcessor = 2;
    }

    const disputeUrl = `${SUPABASE_URL}/functions/v1/byop-dispute-webhook` +
      `?processor=${processorKey}` +
      (campsOnProcessor > 1 ? `&camp=${campId}` : "");

    steps.push({
      do: `In the camp's ${processorKey} dashboard, point the chargeback / dispute ` +
          `notification at: ${disputeUrl}`,
      why: campsOnProcessor > 1
        ? `REQUIRED. Without it a chargeback pulls money out of the camp's bank account ` +
          `while Campistry still shows the payment as collected. ${campsOnProcessor} camps ` +
          `now use ${processorKey}, so the &camp= is required too — with more than one ` +
          `camp the webhook refuses to guess which camp a dispute belongs to.`
        : `REQUIRED. Without it a chargeback pulls money out of the camp's bank account ` +
          `while Campistry still shows the payment as collected. No &camp= needed yet — ` +
          `this is the only camp on ${processorKey}, so the webhook resolves it. If a ` +
          `second camp connects ${processorKey}, THIS camp's URL must have &camp=${campId} ` +
          `added to it as well.`,
    });

    // Connecting THIS camp can break a camp that was already set up. Once a
    // second camp shares a processor the webhook stops resolving the camp on
    // its own, so every URL without &camp= goes from working to silently
    // dropping disputes. The operator is standing right here — tell them now.
    if (otherCampIds.length > 0) {
      steps.push({
        do: `Go back and add &camp=<that camp's id> to the dispute webhook URL of the ` +
            `${otherCampIds.length} camp(s) already on ${processorKey}: ${otherCampIds.join(", ")}`,
        why: `THIS CONNECT JUST BROKE THEM. While one camp used ${processorKey} the webhook ` +
             `could resolve the camp by itself, so their URLs have no &camp=. Now that ` +
             `${campsOnProcessor} camps share it, the webhook refuses to guess — it will not ` +
             `post a chargeback against a camp it is not sure about — so their disputes are ` +
             `dropped until their URLs are updated. Nothing will error; it just stops working.`,
      });
    }

    steps.push({
      do: `Send one test dispute from the ${processorKey} dashboard and check the ` +
          `byop-dispute-webhook logs.`,
      why: `The field names are taken from the adapter so the payment reference is right, ` +
           `but neither processor's dispute envelope could be verified against their docs. ` +
           `The function logs the whole body when it can't find a reference. Until you've ` +
           `done this once for ${processorKey}, treat its chargeback handling as plumbed ` +
           `but unproven.`,
    });

    if (processorKey === "cardknox") {
      steps.push({
        do: `Portal Settings -> Gateway Settings -> Webhook Settings: set the Postback URL to ` +
            `${SUPABASE_URL}/functions/v1/cardknox-webhook?campId=${campId} and the PIN to the ` +
            `exact webhookPin you just stored.`,
        why: `Required for hosted checkout — this is how a parent's payment gets credited. ` +
             `A mismatched PIN means payments complete on Sola and never reach Campistry.`,
      });
      steps.push({
        do: `Same screen: set Redirect on success AND Redirect on error to ` +
            `https://link.campistry.org/campistry_link_parent.html`,
        why: `Brings the parent back into the app. Crediting happens via the postback above ` +
             `regardless of what this redirect does.`,
      });
    }

    return json({
      success: true,
      campName: camp.name,
      processorKey,
      campsOnProcessor,
      // Named "remainingSetup" and not "notes" on purpose: this is not
      // information, it is work that is still outstanding.
      remainingSetup: steps,
    });
  } catch (err) {
    console.error("[admin-connect-processor] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
