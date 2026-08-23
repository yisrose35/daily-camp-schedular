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
// If the camp identified by campId has connected its own Stripe account
// (camps.stripe_account_id, see stripe-connect-onboard-camp),
// payment_intent_data[transfer_data][destination] is added so the resulting
// charge routes to the camp's own bank account instead of the platform's —
// a destination charge, no Stripe-Account header, no change to how the
// Checkout Session itself is created. No platform fee (camp keeps 100%). A
// camp that hasn't connected is unaffected — same behavior as before.
//
// KNOWN RESIDUAL RISK, not fully closed by campOwnsFamily() below: this
// endpoint is called from campistry_link_parent.html's _lkCheckout() using
// only the shared anon key, with no per-user session token — so there is no
// real identity check on the caller at all (same pre-existing gap flagged
// in BILLING_PAYMENTS_SETUP.md — "route stripe-checkout behind an
// authenticated RPC"). campOwnsFamily() blocks the simple case (a stale/
// wrong campId sent alongside a REAL family's key from a genuine caller),
// but it can't stop someone who has gone through real Stripe Connect
// onboarding for their OWN camp from planting a matching familyKey in their
// OWN camp_state_kv (which their owner/admin RLS already lets them write)
// and then phishing a victim into paying a crafted link — the destination
// account would be real and KYC-verified, but not the victim's actual camp.
// Closing this fully needs stripe-checkout to require the CALLER's real
// session (parent or staff) and derive campId/familyKey from it server-side
// — the same pattern stripe-charge now uses — rather than trusting any
// client-supplied value. Deferred here because campistry_link_parent.html's
// _lkCheckout() would need to switch from the anon key to forwarding the
// signed-in parent's own access token first, which is untestable without a
// live Supabase/Stripe account in this environment and risks breaking the
// live parent payment flow if rushed. Flagged, not silently left unfixed.
//
// Request:  { campId, familyKey, familyName, email?, amount, description?,
//             enrollmentId?, successUrl?, cancelUrl? }
// Response: { url, sessionId }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// campId is client-supplied and this endpoint has no session auth at all
// (it's the public Pay Link flow) — never trust it alone to pick a money
// destination. Only apply a destination when campId's own camp_state_kv
// actually contains this exact familyKey — otherwise fall through with no
// destination (same safe behavior as an unconnected camp), never reject
// the checkout itself.
async function campOwnsFamily(campId: string | undefined, familyKey: string | undefined): Promise<boolean> {
  if (!campId || !familyKey || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await supabase
    .from("camp_state_kv")
    .select("value")
    .eq("camp_id", campId)
    .eq("key", "campistryMe")
    .maybeSingle();
  const families = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).families : null;
  return !!(families && typeof families === "object" && Object.prototype.hasOwnProperty.call(families, familyKey));
}

async function lookupCampDestination(campId: string | undefined, familyKey: string | undefined): Promise<string | null> {
  if (!campId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!(await campOwnsFamily(campId, familyKey))) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: camp } = await supabase
    .from("camps")
    .select("stripe_account_id, stripe_charges_enabled")
    .eq("id", campId)
    .maybeSingle();
  return (camp?.stripe_account_id && camp.stripe_charges_enabled) ? camp.stripe_account_id : null;
}

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

    const destinationAccountId = await lookupCampDestination(campId, familyKey);
    if (destinationAccountId) {
      params["payment_intent_data[transfer_data][destination]"] = destinationAccountId;
    }

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
