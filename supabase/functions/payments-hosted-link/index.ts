// =============================================================================
// payments-hosted-link — Banquest redirect-to-hosted-page: mint a one-time
// Payment Page link the parent is sent to.
//
// The redirect model the user asked for: the parent never types a card on a
// Campistry page. This function calls Banquest's
//   POST /payment-pages/generate-pay-link/{slug}
// with one_time_use:true, which returns { payment_link, key }. The browser is
// then sent to payment_link; on success Banquest sends the parent back to
// returnUrl with ?key=<key> appended, and payments-hosted-complete uses that
// key to look the transaction up (GET /transactions?key=) and record it.
//
// We stash the pay-link `key` → {camp, family/camper, purpose, amount} in
// banquest_pending_links (migration 149) so the completion step trusts only the
// opaque key, not anything else the browser hands back. custom1..4 carry the
// same metadata onto the Banquest transaction as a backup / for the webhook.
//
// Request:  { campId, purpose: 'save_card'|'pay_now'|'canteen',
//             familyKey?, camperName?, amount?, returnUrl, description? }
// Response: { success, payment_link, key } | { success:false, error }
//
// Self-session-auth convention matches payments-save-method: campId is
// client-supplied, so we only confirm the family/camper exists under that camp
// before minting a link — no money moves here (the parent still has to enter a
// card on Banquest's page), and the completion step re-derives everything from
// the server-side pending row.
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

// Banquest API base — see the inlined callers in the charge/refund functions.
// The v2 API always lives under /api/v2; append it when a bare host is stored.
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}

async function campOwnsFamily(service: ReturnType<typeof createClient>, campId: string, familyKey: string): Promise<boolean> {
  // The family ROW (camp_family), not the campistryMe document's copy of it.
  const { data, error } = await service.rpc("camp_family", { p_camp_id: campId, p_family_key: familyKey });
  return !error && !!data && typeof data === "object";
}

async function campHasCamper(service: ReturnType<typeof createClient>, campId: string, camperName: string): Promise<boolean> {
  // The canteen accounts are ROWS since 219, and the page strips `accounts`
  // out of every campistrySnacks document save — so reading the document said
  // "no such camper" for everyone, and every canteen card deposit was refused.
  // canteen_camper_known (migration 243) asks the roster and the account rows.
  const { data, error } = await service.rpc("canteen_camper_known", {
    p_camp_id: campId, p_camper_name: camperName,
  });
  if (error) {
    console.error("[campHasCamper] canteen_camper_known failed:", error.message);
    return false;   // fail closed: money is never taken for a camper we cannot confirm
  }
  return data === true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, purpose, familyKey, camperName, amount, returnUrl, description } = await req.json();
    if (!campId || !purpose || !returnUrl) {
      return json({ success: false, error: "campId, purpose, and returnUrl are required" }, 400);
    }
    if (purpose !== "save_card" && purpose !== "pay_now" && purpose !== "canteen") {
      return json({ success: false, error: "purpose must be save_card, pay_now, or canteen" }, 400);
    }
    if (!/^https:\/\//.test(String(returnUrl))) {
      return json({ success: false, error: "returnUrl must be an https URL" }, 400);
    }
    if ((purpose === "pay_now" || purpose === "canteen") && !(Number(amount) > 0)) {
      return json({ success: false, error: "A positive amount is required for a payment." }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Confirm the subject exists under this camp before minting a link. A
    // canteen deposit and a canteen auto-reload card-save are camper-scoped
    // (camperName); a tuition payment and a family card-save are family-scoped
    // (familyKey). save_card can be either — canteen auto-reload passes a
    // camperName, tuition autopay passes a familyKey.
    const isCamperScoped = purpose === "canteen" || (purpose === "save_card" && !!camperName);
    if (isCamperScoped) {
      if (!camperName || !(await campHasCamper(service, campId, String(camperName)))) {
        return json({ success: false, error: "Camper not found for this camp" }, 400);
      }
    } else {
      if (!familyKey || !(await campOwnsFamily(service, campId, String(familyKey)))) {
        return json({ success: false, error: "Family not found for this camp" }, 400);
      }
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (processorKey !== "banquest") {
      return json({ success: false, error: "The hosted payment page is only available for Banquest." }, 400);
    }

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }
    const creds = credResult.credentials as Record<string, string>;
    if (!creds?.sourceKey || !creds?.pin) {
      return json({ success: false, error: "This camp's Banquest credential is missing its source key or PIN." }, 400);
    }
    if (!creds?.paymentPageSlug) {
      return json({ success: false, error: "No hosted Payment Page slug is configured for this camp yet." }, 400);
    }

    // custom1..4 ride along on the Banquest transaction so the metadata is
    // available in GET /transactions and the webhook, not just our pending row.
    const body: Record<string, any> = {
      one_time_use: true,
      redirect_url: returnUrl,
      custom_fields: {
        custom1: purpose,
        custom2: familyKey ? String(familyKey) : "",
        custom3: camperName ? String(camperName) : "",
        custom4: String(campId),
      },
      general_fields: {
        description: description ? String(description) : (purpose === "save_card" ? "Save card on file" : "Payment"),
        ...(purpose !== "save_card" ? { amount: Number(Number(amount).toFixed(2)) } : {}),
      },
    };

    const slug = encodeURIComponent(String(creds.paymentPageSlug));
    const resp = await fetch(`${bqBase(creds)}/payment-pages/generate-pay-link/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
      body: JSON.stringify(body),
    });
    let data: Record<string, any> = {};
    try { data = await resp.json(); } catch { /* non-JSON error body */ }

    const payLink = data?.payment_link;
    const key = data?.key;
    if (resp.status < 200 || resp.status >= 300 || !payLink || !key) {
      const msg = (Array.isArray(data?.messages) && data.messages[0]) || data?.error_message || data?.error || `Could not create a payment link (HTTP ${resp.status})`;
      console.error(`[payments-hosted-link] generate-pay-link failed for camp ${campId}: ${msg}`);
      return json({ success: false, error: msg }, 200);
    }

    const { error: insErr } = await service.from("banquest_pending_links").insert({
      key: String(key),
      camp_id: campId,
      purpose,
      family_key: familyKey ? String(familyKey) : null,
      camper_name: camperName ? String(camperName) : null,
      amount: purpose === "save_card" ? null : Number(Number(amount).toFixed(2)),
    });
    if (insErr) {
      console.error(`[payments-hosted-link] could not record pending link: ${insErr.message}`);
      return json({ success: false, error: "Could not start the payment — please try again." }, 500);
    }

    return json({ success: true, payment_link: payLink, key: String(key) });
  } catch (err) {
    console.error("[payments-hosted-link] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
