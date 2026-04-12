// =============================================================================
// stripe-webhook — Handle Stripe payment confirmations
//
// Receives webhook events from Stripe when payments succeed/fail.
// Updates the camp's payment records in Supabase.
//
// Events handled:
//   - payment_intent.succeeded → record payment
//   - payment_intent.payment_failed → flag failure
//   - setup_intent.succeeded → card saved confirmation
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

// Simple webhook signature verification
async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  if (!secret || !signature) return false;
  try {
    const parts = signature.split(",").reduce((acc: Record<string, string>, part: string) => {
      const [key, val] = part.split("=");
      acc[key] = val;
      return acc;
    }, {});
    const timestamp = parts["t"];
    const sig = parts["v1"];
    if (!timestamp || !sig) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return expected === sig;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature") || "";

    // Verify webhook signature if secret is configured
    if (STRIPE_WEBHOOK_SECRET) {
      const valid = await verifySignature(body, signature, STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        console.error("[stripe-webhook] Invalid signature");
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const event = JSON.parse(body);
    console.log(`[stripe-webhook] Event: ${event.type} (${event.id})`);

    // Initialize Supabase client with service role for DB writes
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const campId = pi.metadata?.campId;
        const familyName = pi.metadata?.familyName;
        const amount = pi.amount / 100; // cents to dollars

        console.log(`[stripe-webhook] Payment succeeded: $${amount} from ${familyName} (camp: ${campId})`);

        // Store payment record in Supabase
        if (campId) {
          await supabase.from("stripe_payments").insert({
            camp_id: campId,
            stripe_payment_intent_id: pi.id,
            stripe_customer_id: pi.customer,
            family_name: familyName || "",
            amount: amount,
            currency: pi.currency,
            status: "succeeded",
            payment_method_type: pi.payment_method_types?.[0] || "card",
            metadata: pi.metadata,
            created_at: new Date().toISOString(),
          });
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const campId = pi.metadata?.campId;
        const familyName = pi.metadata?.familyName;
        const errorMsg = pi.last_payment_error?.message || "Payment failed";

        console.error(`[stripe-webhook] Payment FAILED: ${familyName} — ${errorMsg}`);

        if (campId) {
          await supabase.from("stripe_payments").insert({
            camp_id: campId,
            stripe_payment_intent_id: pi.id,
            stripe_customer_id: pi.customer,
            family_name: familyName || "",
            amount: pi.amount / 100,
            currency: pi.currency,
            status: "failed",
            error_message: errorMsg,
            metadata: pi.metadata,
            created_at: new Date().toISOString(),
          });
        }
        break;
      }

      case "setup_intent.succeeded": {
        const si = event.data.object;
        const campId = si.metadata?.campId;
        const familyName = si.metadata?.familyName;

        console.log(`[stripe-webhook] Card saved for ${familyName} (customer: ${si.customer})`);

        // Store the payment method reference
        if (campId) {
          await supabase.from("stripe_customers").upsert({
            camp_id: campId,
            stripe_customer_id: si.customer,
            family_name: familyName || "",
            payment_method_id: si.payment_method,
            card_saved: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: "camp_id,stripe_customer_id" });
        }
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-webhook] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
