// =============================================================================
// stripe-setup-checkout — Hosted Stripe page to save a payment method, no
// card/bank details ever touching Campistry's own site.
//
// Replaces the old embedded-Stripe-Elements "Save Card" box (Stripe.js
// mounted directly inside campistry_me.html) with a redirect to a real
// Checkout Session in `mode: 'setup'` — same trust model as the existing
// tuition Pay Link (stripe-checkout), just saving a payment method instead
// of charging one. Offers BOTH card and ACH bank transfer; Stripe's hosted
// page handles bank-account verification itself (micro-deposits / Financial
// Connections instant verify) — building that by hand would be a lot more
// work than card collection alone.
//
// Callable from either side:
//   - The PARENT, from their own Campistry Link portal (the normal path —
//     they pick card or bank themselves, nothing routes through the office).
//   - The OFFICE, from Me → Billing, as a fallback for a family with no
//     portal access (opens in a new tab; the office never types the card,
//     they just hand the family the page or, on a phone call, read it back
//     to them to enter live on Stripe's own page).
//
// On completion, stripe-webhook's setup_intent.succeeded handler writes the
// resulting Stripe Customer + PaymentMethod ID back onto the family record
// (f.stripeCustomerId / f.stripePaymentMethodId / f.cardOnFile), which is
// exactly what charge-due-installments already reads to run autopay — no
// change needed there.
//
// Request:  { campId, familyKey, familyName, email?, existingCustomerId?,
//             successUrl?, cancelUrl? }
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

// Same ownership check as stripe-checkout's campOwnsFamily — duplicated
// rather than imported (no shared module between edge functions in this
// codebase, matches how stripe-canteen-refund duplicated stripe-refund's
// block instead of chaining an HTTP call). campId is client-supplied with
// no session auth here (same residual gap already documented on
// stripe-checkout) — this only blocks the simple case (stale/wrong campId
// alongside a real family's key), which is fine: this endpoint doesn't
// move any money, it only lets someone start a Stripe Checkout session
// that (once completed) attaches a payment method to a family's own
// record in THEIR OWN camp's data.
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) {
      return new Response(JSON.stringify({ error: "Stripe not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      campId, familyKey, familyName, email, existingCustomerId, successUrl, cancelUrl,
    } = await req.json();

    if (!campId || !familyKey) {
      return new Response(JSON.stringify({ error: "campId and familyKey are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!(await campOwnsFamily(campId, familyKey))) {
      return new Response(JSON.stringify({ error: "Family not found for this camp" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reuse the family's existing Stripe Customer if it already has one
    // (from a prior save, or the retired embedded flow), same as
    // stripe-setup did — avoids creating duplicate Customers on retry.
    let customerId = existingCustomerId || null;
    if (!customerId && email) {
      const search = await stripeGet(`/customers?email=${encodeURIComponent(email)}&limit=1`);
      if (search.data?.length > 0) customerId = search.data[0].id;
    }
    if (!customerId) {
      const customer = await stripePost("/customers", {
        name: familyName || "",
        ...(email ? { email: String(email) } : {}),
        "metadata[campId]": String(campId),
        "metadata[source]": "campistry",
      });
      if (customer.error) throw new Error(customer.error.message);
      customerId = customer.id;
    }

    const origin = req.headers.get("origin") || "";
    const success = successUrl || `${origin}/campistry_pay_thanks.html?status=success&kind=autopay`;
    const cancel = cancelUrl || `${origin}/campistry_pay_thanks.html?status=cancelled&kind=autopay`;

    const meta: Record<string, string> = {
      campId: String(campId),
      familyKey: String(familyKey),
      familyName: String(familyName || ""),
      source: "campistry-autopay-setup",
    };

    const params: Record<string, string> = {
      "mode": "setup",
      "customer": customerId,
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "us_bank_account",
      "success_url": success,
      "cancel_url": cancel,
    };
    Object.entries(meta).forEach(([k, v]) => {
      params[`metadata[${k}]`] = v;
      params[`setup_intent_data[metadata][${k}]`] = v;
    });

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id, customerId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[stripe-setup-checkout] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
