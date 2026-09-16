// =============================================================================
// registration-deposit-checkout — pay a registration deposit from the form
//
// A camp can require money to hold a place. The form states the amount
// (migration 164); this takes it.
//
// THE ORDER MATTERS: the application is saved FIRST, then the parent pays
// against it. A form that refused to submit until a card cleared would throw
// away twenty minutes of typing on a declined card, and an unpaid application
// is a real state the office already understands -- "awaiting deposit".
//
// DELIBERATELY ITS OWN FUNCTION. stripe-checkout and payments-hosted-link both
// work today and both move money; widening either to accept a caller with no
// family record risks the flows camps already depend on. This one can only do
// the single thing it is for.
//
// THE PRICE IS NEVER THE CALLER'S. The amount comes from
// _registration_deposit_owed -- what the camp stamped on that application --
// never from the request body. The page asking is anonymous by design, so it
// must not be able to name its own figure in either direction.
//
// Request:  { campId, enrollmentId, returnUrl }
// Response: { success, url } | { success:false, error, reason? }
//
// Deploy as its own function in the Supabase Dashboard. Needs the same secrets
// the other payment functions use: STRIPE_SECRET_KEY for Stripe camps, nothing
// extra for Banquest (credentials are read per camp).
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  const host = (c.apiHost || "").trim();
  if (!host) return BANQUEST_DEFAULT_BASE;
  return /\/api\/v\d/.test(host) ? host.replace(/\/+$/, "") : host.replace(/\/+$/, "") + "/api/v2";
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, enrollmentId, returnUrl, saveCard } = await req.json();
    if (!campId || !enrollmentId || !returnUrl) {
      return json({ success: false, error: "campId, enrollmentId and returnUrl are required" }, 400);
    }
    // An open redirect here would let anyone turn the camp's own payment page
    // into a phishing hop.
    if (!/^https:\/\//.test(String(returnUrl))) {
      return json({ success: false, error: "returnUrl must be an https URL" }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // What is owed, decided server-side from what the camp stamped.
    const { data: owedRes, error: owedErr } = await service.rpc("_registration_deposit_owed", {
      p_camp_id: campId,
      p_enroll_id: String(enrollmentId),
    });
    if (owedErr) {
      console.error(`[registration-deposit] owed lookup failed: ${owedErr.message}`);
      return json({ success: false, error: "Could not look up this application." }, 500);
    }
    if (!owedRes?.success) {
      return json({ success: false, error: "We could not find that application.", reason: owedRes?.error }, 404);
    }
    const owed = Number(owedRes.owed) || 0;
    if (owed <= 0) {
      // Not an error: a parent who pressed back, or whose payment already
      // landed, should be told it is settled rather than charged twice.
      return json({ success: true, alreadyPaid: true });
    }

    const label = String(owedRes.label || "Registration deposit") +
      (owedRes.camperName ? ` — ${owedRes.camperName}` : "");

    // Which rail this camp is on. Exactly the same test the autopay cron uses,
    // so a camp cannot be on one processor here and another there.
    const { data: camp } = await service
      .from("camps")
      .select("payment_processor_key, stripe_account_id, stripe_charges_enabled")
      .eq("id", campId)
      .maybeSingle();
    const processorKey: string | null = camp?.payment_processor_key || null;

    // ── Banquest: a hosted pay page ─────────────────────────────────────────
    if (processorKey === "banquest") {
      const { data: credRes } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const creds = (credRes?.credential || credRes) as Record<string, string> | null;
      if (!creds?.sourceKey || !creds?.pin || !creds?.paymentPageSlug) {
        return json({
          success: false,
          error: "This camp has not finished setting up online payments.",
          reason: "banquest_not_configured",
        }, 200);
      }

      const resp = await fetch(`${bqBase(creds)}/payment-pages/generate-pay-link/${creds.paymentPageSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
        body: JSON.stringify({
          redirect_url: returnUrl,
          custom_fields: {
            custom1: "registration_deposit",
            // The completion step reads this to decide whether to keep the
            // token it gets back. A card is only ever vaulted because the
            // parent ticked the box.
            custom2: saveCard ? "save" : "",
            custom3: "",
            custom4: String(enrollmentId),
          },
          ...(saveCard ? { save_payment_method: true } : {}),
          transaction: { description: label, amount: Number(owed.toFixed(2)) },
        }),
      });
      let data: Record<string, any> = {};
      try { data = await resp.json(); } catch { /* non-JSON error body */ }

      const payLink = data?.payment_link, key = data?.key;
      if (resp.status < 200 || resp.status >= 300 || !payLink || !key) {
        const msg = (Array.isArray(data?.messages) && data.messages[0]) || data?.error_message ||
          `Could not create a payment link (HTTP ${resp.status})`;
        console.error(`[registration-deposit] banquest link failed for camp ${campId}: ${msg}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 200);
      }

      // The pending row is what the completion step reads; without it a
      // successful payment would have nothing to attach itself to.
      const { error: insErr } = await service.from("banquest_pending_links").insert({
        key: String(key),
        camp_id: campId,
        purpose: saveCard ? "registration_deposit_save" : "registration_deposit",
        enrollment_id: String(enrollmentId),
        amount: Number(owed.toFixed(2)),
      });
      if (insErr) {
        console.error(`[registration-deposit] pending row failed: ${insErr.message}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 500);
      }
      return json({ success: true, url: payLink, processor: "banquest" });
    }

    // ── Stripe: a Checkout session ──────────────────────────────────────────
    const stripeReady = !!camp?.stripe_charges_enabled && !!camp?.stripe_account_id;
    if ((!processorKey || processorKey === "stripe")) {
      if (!STRIPE_SECRET_KEY) {
        return json({ success: false, error: "Online payment is not configured.", reason: "no_stripe_key" }, 200);
      }
      const cents = String(Math.round(owed * 100));
      const params: Record<string, string> = {
        "mode": "payment",
        "success_url": `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}deposit=paid`,
        "cancel_url": `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}deposit=cancelled`,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": cents,
        "line_items[0][price_data][product_data][name]": label,
        "payment_intent_data[description]": label,
      };
      if (saveCard) {
        // off_session is what makes the method chargeable later without the
        // parent present, which is what a payment plan needs. Stripe requires
        // a customer to attach it to, and Checkout will make one.
        params["payment_intent_data[setup_future_usage]"] = "off_session";
        params["customer_creation"] = "always";
      }
      if (owedRes.parentEmail) params["customer_email"] = String(owedRes.parentEmail);

      // On BOTH the session and the intent, so the webhook has it whichever
      // event it keys off.
      const meta: Record<string, string> = {
        campId: String(campId),
        enrollmentId: String(enrollmentId),
        source: "registration_deposit",
      };
      Object.entries(meta).forEach(([k, v]) => {
        params[`metadata[${k}]`] = v;
        params[`payment_intent_data[metadata][${k}]`] = v;
      });
      // Money lands in the camp's own account when they are connected. A camp
      // that is not still gets a working payment rather than a dead button.
      if (stripeReady) params["payment_intent_data[transfer_data][destination]"] = String(camp!.stripe_account_id);

      const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
      });
      const session = await resp.json();
      if (!resp.ok || !session?.url) {
        console.error(`[registration-deposit] stripe session failed: ${session?.error?.message || resp.status}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 200);
      }
      return json({ success: true, url: session.url, processor: "stripe" });
    }

    // ── Cardknox / Sola: their own hosted checkout ──────────────────────────
    // Sola's page carries a real per-transaction amount (?xAmount=) and one
    // field that survives to the webhook (xInvoice), so the correlation is our
    // own reference against an intent row -- exactly the mechanism
    // cardknox-checkout-start already uses for tuition and canteen.
    if (processorKey === "cardknox") {
      const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const checkoutSlug = credResult?.credentials?.checkoutSlug;
      if (!credResult?.success || !checkoutSlug) {
        return json({
          success: false,
          error: "This camp has not finished setting up online payments.",
          reason: "cardknox_not_configured",
        }, 200);
      }

      const reference = "ckrd_" + crypto.randomUUID().replace(/-/g, "");
      const { data: intentRes, error: intentErr } = await service.rpc("create_cardknox_registration_intent", {
        p_camp_id: campId,
        p_reference: reference,
        p_enroll_id: String(enrollmentId),
        p_amount_cents: Math.round(owed * 100),
        p_description: label,
      });
      if (intentErr || !intentRes?.success) {
        console.error(`[registration-deposit] cardknox intent failed: ${intentErr?.message || intentRes?.error}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 500);
      }

      // xCustomerVaultSaveCard is what tells Sola's hosted page to hand back a
      // reusable token alongside the charge. Only ever sent because the parent
      // asked -- a card is never vaulted quietly.
      const url = "https://secure.cardknox.com/" + encodeURIComponent(checkoutSlug) +
        "?xAmount=" + encodeURIComponent(owed.toFixed(2)) +
        "&xInvoice=" + encodeURIComponent(reference) +
        (saveCard ? "&xCustomerVaultSaveCard=true" : "");

      console.log(`[registration-deposit] cardknox intent ${reference}: $${owed.toFixed(2)}, camp ${campId}`);
      return json({ success: true, url, processor: "cardknox", reference });
    }

    // ── anything else ───────────────────────────────────────────────────────
    // Say so plainly rather than showing a button that cannot work: the camp
    // still collects the deposit the way it already does.
    console.log(`[registration-deposit] camp ${campId} is on '${processorKey}', which has no hosted page here yet`);
    return json({
      success: false,
      error: "This camp takes its deposit another way — they will be in touch.",
      reason: "processor_unsupported",
    }, 200);
  } catch (err) {
    console.error("[registration-deposit] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
