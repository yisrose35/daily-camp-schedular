// =============================================================================
// stripe-setup — Create Stripe Customer + SetupIntent
//
// Called when camp wants to save a family's payment method.
// Creates a Stripe Customer (or reuses existing), then creates a
// SetupIntent so the parent can enter their card details.
//
// Request:  { familyName, email, campId }
// Response: { clientSecret, customerId, setupIntentId }
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

    const { familyName, email, campId, existingCustomerId } = await req.json();

    // 1. Create or retrieve Stripe Customer
    let customerId = existingCustomerId;
    if (!customerId) {
      // Search for existing customer by email
      const search = await stripeGet(
        `/customers?email=${encodeURIComponent(email)}&limit=1`
      );
      if (search.data?.length > 0) {
        customerId = search.data[0].id;
        console.log(`[stripe-setup] Found existing customer: ${customerId}`);
      } else {
        // Create new customer
        const customer = await stripePost("/customers", {
          name: familyName,
          email: email,
          "metadata[campId]": campId || "",
          "metadata[source]": "campistry",
        });
        if (customer.error) {
          throw new Error(customer.error.message);
        }
        customerId = customer.id;
        console.log(`[stripe-setup] Created customer: ${customerId}`);
      }
    }

    // 2. Create SetupIntent for saving card
    const setupIntent = await stripePost("/setup_intents", {
      customer: customerId,
      "payment_method_types[]": "card",
      "metadata[campId]": campId || "",
      "metadata[familyName]": familyName,
      usage: "off_session", // allow charging when customer is not present
    });

    if (setupIntent.error) {
      throw new Error(setupIntent.error.message);
    }

    console.log(`[stripe-setup] SetupIntent created: ${setupIntent.id}`);

    return new Response(
      JSON.stringify({
        clientSecret: setupIntent.client_secret,
        customerId: customerId,
        setupIntentId: setupIntent.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[stripe-setup] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
