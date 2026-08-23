// =============================================================================
// stripe-refund — Refund a payment (full or partial)
//
// Called when camp wants to refund a charge made through Campistry. Refunds the
// PaymentIntent created by stripe-charge (or any PaymentIntent id on the payment
// record). Amount is optional — omit for a full refund.
//
// If the original charge was a destination charge (routed to a camp's own
// connected Stripe account, see migrations/077_camp_stripe_connect.sql), the
// refund needs reverse_transfer:true so the money is clawed back from the
// CAMP's account, not the platform's own (now-smaller) balance. Rather than
// trust a client-supplied campId/flag, this is looked up directly from
// Stripe itself — authoritative, and a camp that was never connected (or
// wasn't connected yet when the original charge happened) simply has no
// transfer_data on its PI, so this is a no-op for every pre-Connect payment
// on file.
//
// Request:  { paymentIntentId, amount?, reason?, metadata? }
// Response: { refundId, status, amount }
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

    const { paymentIntentId, amount, reason, metadata } = await req.json();

    if (!paymentIntentId) {
      return new Response(JSON.stringify({ error: "paymentIntentId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const params: Record<string, string> = {
      payment_intent: String(paymentIntentId),
    };
    // Omit amount for a full refund; otherwise partial (cents).
    if (amount != null && Number(amount) > 0) {
      params.amount = String(Math.round(Number(amount) * 100));
    }
    // Stripe only accepts: duplicate | fraudulent | requested_by_customer
    if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") {
      params.reason = reason;
    }
    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        params[`metadata[${k}]`] = String(v);
      });
    }

    // Was the original charge a destination charge to a camp's own
    // connected account? If so, reverse the transfer along with the refund
    // so the camp's account (not the platform's) is debited.
    const pi = await stripeGet(`/payment_intents/${paymentIntentId}`);
    if (pi?.transfer_data?.destination) {
      params.reverse_transfer = "true";
    }

    const refund = await stripePost("/refunds", params);

    if (refund.error) {
      throw new Error(refund.error.message);
    }

    console.log(`[stripe-refund] Refund ${refund.id}: ${refund.status} — $${(refund.amount || 0) / 100}`);

    return new Response(
      JSON.stringify({
        refundId: refund.id,
        status: refund.status,
        amount: (refund.amount || 0) / 100,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[stripe-refund] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
