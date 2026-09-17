// =============================================================================
// card-capture-start — get a card accepted by the processor BEFORE the form is
// submitted.
//
// The old order was backwards: submit, then meet the processor, then find out
// the card was declined with the application already gone. Now the form asks
// here first, the parent deals with the processor, and the form shows a tick
// or a cross next to the payment method. Submit waits for the tick.
//
// NOTHING HERE CHARGES ANYTHING. Every path is a zero-amount "is this card
// good" check. The deposit is taken afterwards, by
// registration-deposit-checkout, against the card captured here and for the
// amount the camp stamped on the saved application -- never an amount a
// browser sent.
//
// Two actions, one function (one Dashboard deploy, no CLI -- see CLAUDE.md):
//
//   action 'start'  { campId, returnUrl }
//     -> { success, mode: 'inline' | 'popup', reference, processor, url? }
//        'inline' means the card is collected on our own framed card page and
//        finished with the 'finish' action below (Banquest). 'popup' means the
//        processor has its own page and answers later by webhook; the form
//        polls get_card_capture_status until it flips.
//
//   action 'finish' { campId, reference, cardToken, card?, billing? }
//     -> { success, accepted, last4?, brand?, error? }
//        Banquest only: a $0 verify with save_card:true. This is the moment
//        the gateway says yes or no, so it is the moment the tick appears.
//
// Anon by design -- a parent filling in a public form has no session. It is
// safe because nothing here moves money and nothing it returns can: the
// response carries a status, a brand and four digits. The vault references
// stay server-side, readable only through _claim_card_capture.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ── Banquest, inlined (a Dashboard deploy bundles ONE file) ─────────────────
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  let b = (c.gatewayUrl || c.apiHost || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}
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
  put("street", b.street); put("street2", b.street2); put("city", b.city);
  put("state", b.state); put("zip", b.zip); put("country", b.country); put("phone", b.phone);
  if (Object.keys(addr).length) out.billing_info = addr;
  const email = String(b.email ?? "").trim();
  if (email) out.customer = { email };
  return out;
}
function bqCardParts(card: Record<string, any> | null | undefined): Record<string, unknown> {
  const c = (card && typeof card === "object") ? card : {};
  const out: Record<string, unknown> = {};
  if (Number(c.expiryMonth) > 0) out.expiry_month = Number(c.expiryMonth);
  if (Number(c.expiryYear) > 0) out.expiry_year = Number(c.expiryYear);
  const zip = String(c.avsZip ?? "").trim();
  if (zip) out.avs_zip = zip;
  return out;
}
// Banquest answers a malformed body with a bare "Validation error" and puts
// the offending field in error_details, which is an object, not a string.
function bqErrDetail(d: unknown): string {
  if (d === null || d === undefined) return "";
  if (typeof d === "string") return d.trim();
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (Array.isArray(d)) return d.map(bqErrDetail).filter(Boolean).join("; ");
  if (typeof d === "object") {
    return Object.entries(d as Record<string, unknown>)
      .map(([k, v]) => { const s = bqErrDetail(v); return s ? `${k}: ${s}` : k; })
      .filter(Boolean).join("; ");
  }
  return String(d);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const action = String(body.action || "start");
    const campId = body.campId;
    if (!campId) return json({ success: false, error: "campId is required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service
      .from("camps")
      .select("payment_processor_key, stripe_account_id, stripe_charges_enabled")
      .eq("id", campId)
      .maybeSingle();
    const processorKey: string = camp?.payment_processor_key
      || (camp?.stripe_charges_enabled && camp?.stripe_account_id ? "stripe" : "");

    // ── finish (Banquest): the gateway says yes or no, right now ────────────
    if (action === "finish") {
      const { reference, cardToken, card, billing } = body;
      if (!reference || !cardToken) {
        return json({ success: false, error: "reference and cardToken are required" }, 400);
      }
      if (processorKey !== "banquest") {
        return json({ success: false, error: "This camp does not collect cards this way." }, 400);
      }

      const { data: credRes } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const creds = (credRes?.credentials || credRes?.credential || credRes) as Record<string, string> | null;
      if (!creds?.sourceKey || !creds?.pin) {
        return json({ success: false, error: "This camp has not finished setting up online payments." }, 200);
      }

      const cardParts = bqCardParts(card);
      if (cardParts.expiry_month === undefined || cardParts.expiry_year === undefined) {
        return json({ success: false, error: "The card's expiry didn't come through — please re-enter the card." }, 200);
      }

      // A $0 verify with save_card is Banquest's "is this card good, and give
      // me something I can charge later" -- the same call payments-save-method
      // already uses. No money moves.
      const resp = await fetch(`${bqBase(creds)}/transactions/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
        body: JSON.stringify({
          source: "nonce-" + String(cardToken),
          save_card: true,
          ...cardParts,
          ...bqBillingParts(billing),
        }),
      });
      let d: Record<string, any> = {};
      try { d = await resp.json(); } catch { /* non-JSON error body */ }

      const cardRef = d?.card_ref;
      const approved = String(d?.status_code || "").toUpperCase() === "A"
                    || String(d?.status || "").toLowerCase() === "approved"
                    || !!cardRef;  // some verify responses omit status but return card_ref
      if (resp.status < 200 || resp.status >= 300 || !cardRef || !approved) {
        console.error("[card-capture] banquest verify failed:", resp.status, JSON.stringify(d));
        const detail = bqErrDetail(d?.error_details) || bqErrDetail(d?.error_messages);
        const base = d?.error_message || d?.error || d?.message || `Card not accepted (HTTP ${resp.status})`;
        const msg = String(detail ? `${base}: ${detail}` : base);
        await service.rpc("complete_card_capture", {
          p_reference: String(reference), p_status: "failed",
          p_customer_ref: null, p_method_ref: null, p_last4: null, p_brand: null, p_error: msg,
        });
        return json({ success: true, accepted: false, error: msg });
      }

      const last4 = d?.last_4 || d?.transaction?.last_4 || d?.card?.last_4 || card?.last4 || null;
      const brand = d?.card_type || d?.transaction?.card_type || d?.card?.card_type || card?.cardType || null;
      const { data: doneRes, error: doneErr } = await service.rpc("complete_card_capture", {
        p_reference: String(reference), p_status: "completed",
        p_customer_ref: String(cardRef), p_method_ref: String(cardRef),
        p_last4: last4 ? String(last4) : null, p_brand: brand ? String(brand) : null, p_error: null,
      });
      if (doneErr || !doneRes?.success) {
        // The card is fine but we cannot prove it later, so do not show a tick
        // we would not be able to honour at submit.
        const why = doneErr?.message || doneRes?.error || "unknown";
        console.error(`[card-capture] banquest accepted ${reference} but could not record it: ${why}`);
        // "Try again" is the wrong advice for the most likely cause by far --
        // migration 189 not applied yet, so complete_card_capture does not
        // exist. Retrying then fails identically, forever, and the parent has
        // no way to know. Say which failure it is.
        // Two different database-side problems produce this, and both are
        // permanent until someone applies a migration -- so neither is worth
        // telling a parent to retry:
        //   * the function is missing entirely (189 not applied)
        //   * there are TWO of it and Postgres will not choose (192 added a
        //     defaulted 8-arg overload beside 189's 7-arg one; PostgREST
        //     resolves by NAME, so both matched -- fixed by 194)
        const missing = /could not find the function|schema cache|does not exist|42883|PGRST202/i.test(why);
        const ambiguous = /could not choose the best candidate|PGRST203|is not unique|42725/i.test(why);
        return json({
          success: false,
          reason: (missing || ambiguous) ? "capture_not_installed" : "capture_not_recorded",
          error: (missing || ambiguous)
            ? "Online card entry isn't finished setting up for this camp — please contact the office."
            : "Your card was accepted but we could not save it — please try again.",
          // The gateway's own words, for whoever is testing the form. It is a
          // Postgres error string, never card data -- and without it, working
          // out WHICH of these it was costs a round trip of guessing.
          debug: why,
        }, 200);
      }

      console.log(`[card-capture] banquest accepted ${reference} for camp ${campId}`);
      return json({ success: true, accepted: true, last4, brand });
    }

    // ── start ───────────────────────────────────────────────────────────────
    const returnUrl = String(body.returnUrl || "");
    const reference = "cap_" + crypto.randomUUID().replace(/-/g, "");

    if (!processorKey) {
      return json({
        success: false,
        error: "This camp takes payment another way — they will be in touch.",
        reason: "no_processor",
      }, 200);
    }

    const { data: made, error: madeErr } = await service.rpc("create_card_capture", {
      p_camp_id: campId, p_reference: reference, p_processor: processorKey,
    });
    if (madeErr || !made?.success) {
      console.error(`[card-capture] could not open a capture for camp ${campId}:`, madeErr?.message || made?.error);
      return json({ success: false, error: "Could not start card entry — please try again." }, 500);
    }

    // Banquest is collected on our own framed card page; there is no third
    // party to visit, so the form goes straight to the fields and comes back
    // through 'finish'.
    if (processorKey === "banquest") {
      return json({ success: true, mode: "inline", reference, processor: "banquest" });
    }

    if (processorKey === "cardknox") {
      const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const checkoutSlug = credResult?.credentials?.checkoutSlug;
      if (!credResult?.success || !checkoutSlug) {
        return json({ success: false, error: "This camp has not finished setting up online payments.", reason: "cardknox_not_configured" }, 200);
      }
      // The SAME reference goes onto a cardknox_checkout_intents row, because
      // that is the table cardknox-webhook resolves against (including its
      // amount-zero fallback for cc:save, which Sola needs -- it never echoes
      // xInvoice back). The webhook then writes the result through to the
      // capture row this function created.
      const { data: intentRes, error: intentErr } = await service.rpc("create_cardknox_checkout_intent", {
        p_camp_id: campId,
        p_reference: reference,
        p_kind: "registration_card_capture",
        p_family_key: null,
        p_family_name: null,
        p_camper_name: null,
        p_amount_cents: 0,
        p_description: "Card check — registration",
      });
      if (intentErr || !intentRes?.success) {
        console.error(`[card-capture] cardknox intent failed: ${intentErr?.message || intentRes?.error}`);
        return json({ success: false, error: "Could not start card entry — please try again." }, 500);
      }
      // cc:save and xAmount are mutually exclusive: cc:save is what turns
      // Sola's hosted page into a tokenize-only form with no amount.
      const url = "https://secure.cardknox.com/" + encodeURIComponent(checkoutSlug) +
        "?xCommand=" + encodeURIComponent("cc:save") +
        "&xInvoice=" + encodeURIComponent(reference);
      return json({ success: true, mode: "popup", url, reference, processor: "cardknox" });
    }

    // Stripe: a Checkout Session in setup mode. It collects and verifies the
    // card without charging it, and works for bank accounts too -- Stripe's
    // own page handles the verification dance, which is far more than card
    // collection alone.
    if (processorKey === "stripe") {
      if (!STRIPE_SECRET_KEY) {
        return json({ success: false, error: "Online payment is not configured.", reason: "no_stripe_key" }, 200);
      }
      const back = /^https:\/\//.test(returnUrl) ? returnUrl : "";
      if (!back) return json({ success: false, error: "returnUrl must be an https URL" }, 400);

      const params: Record<string, string> = {
        "mode": "setup",
        "payment_method_types[0]": "card",
        "success_url": `${back}${back.includes("?") ? "&" : "?"}type=card&status=ok&ref=${encodeURIComponent(reference)}`,
        "cancel_url": `${back}${back.includes("?") ? "&" : "?"}type=card&status=cancelled&ref=${encodeURIComponent(reference)}`,
        "metadata[source]": "registration_card_capture",
        "metadata[reference]": reference,
        "metadata[campId]": String(campId),
        "setup_intent_data[metadata][source]": "registration_card_capture",
        "setup_intent_data[metadata][reference]": reference,
        "setup_intent_data[metadata][campId]": String(campId),
      };
      if (body.email) params["customer_email"] = String(body.email);

      const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      const session = await resp.json();
      if (!resp.ok || !session?.url) {
        console.error(`[card-capture] stripe setup session failed: ${session?.error?.message || resp.status}`);
        return json({ success: false, error: "Could not start card entry — please try again." }, 200);
      }
      return json({ success: true, mode: "popup", url: session.url, reference, processor: "stripe" });
    }

    console.log(`[card-capture] camp ${campId} is on '${processorKey}', which has no card entry here yet`);
    return json({
      success: false,
      error: "This camp takes payment another way — they will be in touch.",
      reason: "processor_unsupported",
    }, 200);
  } catch (err) {
    console.error("[card-capture] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
