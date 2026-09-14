// =============================================================================
// payments-save-method — BYOP: turn a client-side tokenization result
// (Banquest Hosted Tokenization / Cardknox iFields — see campistry_card_setup.html) into
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
// Cardknox/Sola cc:save, inlined rather than imported from
// _shared/adapters/cardknox_adapter.ts on purpose: this project deploys edge
// functions by pasting ONE file into the Supabase Dashboard (no CLI — see
// CLAUDE.md), and only that file is deployed, so ANY relative import fails to
// bundle. Same reasoning cardknox-webhook and charge-due-installments already
// follow for their own gateway calls.
//
// Keep in sync with cardknox_adapter.saveMethod(). An iFields-issued token is
// often already reusable per Cardknox's own model, but cc:save explicitly
// converts it into a long-lived vault token — the safer, explicit choice, so
// nothing here depends on a temporary token outliving its expiry between
// "save" and some later charge.
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxSaveMethod(apiKey: string, token: string) {
  const resp = await fetch(CARDKNOX_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      xKey: apiKey,
      xVersion: "4.5.9",
      xSoftwareName: "Campistry",
      xSoftwareVersion: "1.0",
      xCommand: "cc:save",
      xToken: token,
    }).toString(),
  });
  const parsed: Record<string, string> = {};
  new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
  if (parsed.xResult !== "A" || !parsed.xToken) {
    return { success: false, error: parsed.xError || "Could not save payment method", raw: parsed };
  }
  return { success: true, customerRef: parsed.xToken, raw: parsed };
}

// Banquest (AffiniPay/8am): exchange the Hosted-Tokenization nonce for a
// durable saved card — a $0 verify with save_card:true returns a card_ref that
// later charges reference as source "tkn-<card_ref>". Same
// inline-for-Dashboard-deploy reason; auth is HTTP Basic base64(sourceKey:pin),
// API base is per-camp and lives under /api/v2. The client's getNonceToken()
// returns the bare nonce; the "nonce-" source prefix is added here. The verify
// response also carries last_4 / card_type — captured so Link and Me can show
// the actual card (•••• 4242) instead of a bare "card on file".
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  // Tolerate a stored gatewayUrl that omits the API path (a bare host like
  // "https://api.sandbox.banquestgateway.com"): the v2 API always lives under
  // /api/v2, so append it when it isn't already there.
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/api\/v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
// Maps the card page's collected fields (campistryMe.cardFormFields, migration
// 150) onto Banquest's own shapes. billing_info is an Address; the cardholder
// name arrives as one string and Banquest wants it split. Only non-empty values
// are included — a blank AVS field is treated worse by the gateway than an
// absent one. Returns the pieces to merge into a transaction body.
function bqBillingParts(billing: Record<string, string> | null | undefined): Record<string, unknown> {
  const b = (billing && typeof billing === "object") ? billing : {};
  const out: Record<string, unknown> = {};
  const addr: Record<string, string> = {};
  const put = (k: string, v: unknown) => { const s = String(v ?? "").trim(); if (s) addr[k] = s; };

  if (b.name) {
    const parts = String(b.name).trim().split(/\s+/);
    put("first_name", parts.shift());
    put("last_name", parts.join(" "));
  }
  put("street", b.street);
  put("street2", b.street2);
  put("city", b.city);
  put("state", b.state);
  put("zip", b.zip);
  put("country", b.country);
  put("phone", b.phone);
  if (Object.keys(addr).length) out.billing_info = addr;

  const email = String(b.email ?? "").trim();
  if (email) out.customer = { email };
  return out;
}

async function banquestSaveMethod(creds: Record<string, string>, nonce: string, billing?: Record<string, string> | null): Promise<{ success: boolean; customerRef?: string; last4?: string; brand?: string; error?: string }> {
  const resp = await fetch(`${bqBase(creds)}/transactions/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${creds.sourceKey}:${creds.pin}`) },
    body: JSON.stringify({ source: "nonce-" + nonce, save_card: true, ...bqBillingParts(billing) }),
  });
  let data: Record<string, any> = {};
  try { data = await resp.json(); } catch { /* non-JSON error body */ }
  const cardRef = data?.card_ref;
  const approved = String(data?.status_code || "").toUpperCase() === "A"
                || String(data?.status || "").toLowerCase() === "approved"
                || !!cardRef; // some verify responses omit status but return card_ref
  if (resp.status < 200 || resp.status >= 300 || !cardRef || !approved) {
    const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Could not save payment method (HTTP ${resp.status})`;
    return { success: false, error: errMsg };
  }
  const last4 = data?.last_4 || data?.transaction?.last_4 || data?.card?.last_4;
  const brand = data?.card_type || data?.transaction?.card_type || data?.card?.card_type;
  return { success: true, customerRef: cardRef, last4: last4 ? String(last4) : undefined, brand: brand ? String(brand) : undefined };
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

// Same shape as stripe-checkout's own campOwnsFamily — campId is
// client-supplied and this endpoint has no session auth, so a destructive
// or money-moving action never proceeds off campId alone; this only
// confirms the family actually exists under that camp before writing
// anything onto its record.
async function campHasCamper(service: ReturnType<typeof createClient>, campId: string, camperName: string): Promise<boolean> {
  const { data } = await service.from("camp_state_kv").select("value")
    .eq("camp_id", campId).eq("key", "campistrySnacks").maybeSingle();
  const accts = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).accounts : null;
  return !!(accts && typeof accts === "object" && Object.prototype.hasOwnProperty.call(accts, camperName));
}

async function campOwnsFamily(service: ReturnType<typeof createClient>, campId: string, familyKey: string): Promise<boolean> {
  const { data } = await service.from("camp_state_kv").select("value")
    .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
  const families = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).families : null;
  return !!(families && typeof families === "object" && Object.prototype.hasOwnProperty.call(families, familyKey));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, familyKey, camperName, token, billing } = await req.json();
    if (!campId || !token || !(familyKey || camperName)) {
      return json({ success: false, error: "campId, token, and one of familyKey / camperName are required" }, 400);
    }
    // camperName (without familyKey) is the canteen AUTO-RELOAD card save: the
    // token belongs to that camper's autoReload block, not to a family record.
    const isCamperScoped = !familyKey && !!camperName;

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (isCamperScoped) {
      if (!(await campHasCamper(service, campId, String(camperName)))) {
        return json({ success: false, error: "Camper not found for this camp" }, 400);
      }
    } else if (!(await campOwnsFamily(service, campId, familyKey))) {
      return json({ success: false, error: "Family not found for this camp" }, 400);
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ success: false, error: "This camp is on Stripe — use the Stripe card-setup flow instead." }, 400);
    }

    // Cardknox/Sola and Banquest are both inlined here. Any other
    // processor gets a clear error rather than a silent no-op.
    if (processorKey !== "cardknox" && processorKey !== "banquest") {
      return json({ success: false, error: `Saving a card isn't wired for processor '${processorKey}' yet.` }, 400);
    }

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }

    let saveResult: { success: boolean; customerRef?: string; last4?: string; brand?: string; error?: string };
    if (processorKey === "cardknox") {
      const apiKey = credResult.credentials?.apiKey;
      if (!apiKey) {
        return json({ success: false, error: "This camp's processor credential is missing its API key." }, 400);
      }
      saveResult = await cardknoxSaveMethod(String(apiKey), String(token));
    } else {
      const creds = credResult.credentials;
      if (!creds?.sourceKey || !creds?.pin) {
        return json({ success: false, error: "This camp's processor credential is missing its source key or PIN." }, 400);
      }
      saveResult = await banquestSaveMethod(creds, String(token), billing);
    }
    if (!saveResult.success || !saveResult.customerRef) {
      return json({ success: false, error: saveResult.error || "Could not save payment method" }, 200);
    }

    // Same retry-loop read-modify-write convention already used by
    // stripe-webhook's handleAutopaySetup for this exact JSON blob.
    let saved = false;
    if (isCamperScoped) {
      // Canteen auto-reload: the token belongs on this camper's autoReload
      // block (campistrySnacks), which is what canteen-auto-reload charges.
      for (let attempt = 0; attempt < 4 && !saved; attempt++) {
        const cur = await service.from("camp_state_kv").select("value")
          .eq("camp_id", campId).eq("key", "campistrySnacks").maybeSingle();
        const snacks: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object") ? cur.data.value : {};
        if (!snacks.accounts || typeof snacks.accounts !== "object") snacks.accounts = {};
        const acct = snacks.accounts[String(camperName)];
        if (!acct) return json({ success: false, error: "Camper no longer exists" }, 400);
        const ar = (acct.autoReload && typeof acct.autoReload === "object") ? acct.autoReload : {};
        ar.byopProcessor = processorKey;
        ar.byopCustomerRef = saveResult.customerRef;
        ar.cardOnFile = true;
        // A fresh card clears the decline streak that may have paused
        // auto-reload (3 consecutive failures disables it).
        ar.consecutiveFailures = 0;
        if (saveResult.last4) {
          ar.paymentMethodLabel = "•••• " + saveResult.last4;
          ar.paymentMethodType = saveResult.brand || "card";
        }
        acct.autoReload = ar;
        snacks.accounts[String(camperName)] = acct;
        const up = await service.from("camp_state_kv").upsert(
          { camp_id: campId, key: "campistrySnacks", value: snacks, updated_at: new Date().toISOString() },
          { onConflict: "camp_id,key" },
        );
        if (!up.error) saved = true;
      }
    } else {
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
        // Show the real card (•••• 4242) rather than a bare "card on file" when
        // the processor handed back the last 4 / brand on the save.
        if (saveResult.last4) {
          f.paymentMethodLabel = "•••• " + saveResult.last4;
          f.paymentMethodType = saveResult.brand || "card";
        }

        const up = await service.from("camp_state_kv").upsert(
          { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
          { onConflict: "camp_id,key" },
        );
        if (!up.error) saved = true;
      }
    }
    if (!saved) return json({ success: false, error: "Payment method saved with the processor but could not be recorded — contact support." }, 500);

    console.log(`[payments-save-method] Saved ${processorKey} method for ${isCamperScoped ? `camper ${camperName}` : `family ${familyKey}`}, camp ${campId}`);
    return json({ success: true });
  } catch (err) {
    console.error("[payments-save-method] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
