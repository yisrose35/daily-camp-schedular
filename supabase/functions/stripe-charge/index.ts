// =============================================================================
// stripe-charge — Charge a stored payment method
//
// Called when camp wants to charge a family's saved card.
// Uses the stored Stripe Customer + PaymentMethod to create
// an off-session PaymentIntent (auto-debit).
//
// Request:  { customerId, paymentMethodId, amount, currency, description, metadata }
// Response: { paymentIntentId, status, amount }
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

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
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

    const { customerId, paymentMethodId, amount, currency, description, metadata } = await req.json();

    if (!customerId || !amount) {
      return new Response(JSON.stringify({ error: "customerId and amount required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If no paymentMethodId provided, get the customer's default payment method
    let pmId = paymentMethodId;
    if (!pmId) {
      const methods = await stripeGet(
        `/payment_methods?customer=${customerId}&type=card&limit=1`
      );
      if (methods.data?.length > 0) {
        pmId = methods.data[0].id;
      } else {
        return new Response(
          JSON.stringify({ error: "No payment method on file for this customer" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Create PaymentIntent — off_session means customer not present
    const params: Record<string, string> = {
      amount: String(Math.round(amount * 100)), // Stripe uses cents
      currency: currency || "usd",
      customer: customerId,
      payment_method: pmId,
      off_session: "true",
      confirm: "true", // charge immediately
      description: description || "Campistry payment",
    };

    // Add metadata
    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        params[`metadata[${k}]`] = String(v);
      });
    }

    const paymentIntent = await stripePost("/payment_intents", params);

    if (paymentIntent.error) {
      // If card requires authentication, return the client secret
      // so frontend can handle 3D Secure
      if (paymentIntent.error.code === "authentication_required") {
        return new Response(
          JSON.stringify({
            status: "requires_action",
            clientSecret: paymentIntent.error.payment_intent?.client_secret,
            paymentIntentId: paymentIntent.error.payment_intent?.id,
            error: "Card requires authentication — parent must approve",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error(paymentIntent.error.message);
    }

    console.log(`[stripe-charge] PaymentIntent ${paymentIntent.id}: ${paymentIntent.status} — $${amount}`);

    return new Response(
      JSON.stringify({
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
        amount: amount,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[stripe-charge] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
