// =============================================================================
// stripe-checkout — Create a hosted Checkout Session so a family can pay online
//
// The office (or, later, the parent portal) calls this to get a Stripe-hosted
// payment page URL for a family's balance. We intentionally DO NOT pin
// payment_method_types — Stripe then offers every method the camp has enabled
// in its Stripe Dashboard (card, ACH bank debit, Cash App Pay, Link, PayPal,
// Klarna, Afterpay, …). So "which methods are offered" is a Dashboard toggle,
// no code change. Whatever the family picks is recorded by stripe-webhook.
//
// Note: Venmo and Zelle are NOT Stripe methods — Venmo is PayPal-only, Zelle has
// no merchant API. Those stay manual-entry methods (recorded by office staff).
//
// Request:  { campId, familyKey, familyName, email?, amount, description?,
//             enrollmentId?, successUrl?, cancelUrl? }
// Response: { url, sessionId }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function stripePost(endpoint: string, body: Record<string, string>) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  return resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!STRIPE_SECRET) {
      return new Response(JSON.stringify({ error: "Stripe not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      campId, familyKey, familyName, email, amount, description,
      enrollmentId, successUrl, cancelUrl,
    } = await req.json();

    if (!amount || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "A positive amount is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cents = String(Math.round(Number(amount) * 100));
    const label = description || `Camp payment${familyName ? " — " + familyName : ""}`;
    const origin = req.headers.get("origin") || "";
    const success = successUrl || `${origin}/campistry_pay_thanks.html?status=success`;
    const cancel = cancelUrl || `${origin}/campistry_pay_thanks.html?status=cancelled`;

    // Metadata rides on BOTH the session and the resulting PaymentIntent, so the
    // webhook has it regardless of which event we key off.
    const meta: Record<string, string> = {
      campId: String(campId || ""),
      familyKey: String(familyKey || ""),
      familyName: String(familyName || ""),
      enrollmentId: String(enrollmentId || ""),
      source: "campistry-checkout",
    };

    const params: Record<string, string> = {
      "mode": "payment",
      "success_url": success,
      "cancel_url": cancel,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": cents,
      "line_items[0][price_data][product_data][name]": label,
      // us_bank_account (ACH) needs a statement descriptor & mandate; Checkout
      // handles the mandate UI automatically when the method is enabled.
      "payment_intent_data[description]": label,
    };
    if (email) params["customer_email"] = String(email);
    Object.entries(meta).forEach(([k, v]) => {
      params[`metadata[${k}]`] = v;
      params[`payment_intent_data[metadata][${k}]`] = v;
    });

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    console.log(`[stripe-checkout] Session ${session.id} for ${familyName || familyKey} — $${amount}`);

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[stripe-checkout] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
