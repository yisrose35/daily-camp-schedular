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
// CANTEEN DEPOSITS (added alongside tuition Pay Links): pass
// source:'campistry-canteen-deposit' and camperName instead of familyKey.
// Unlike the tuition case, an ownership failure here is a HARD REJECT (400),
// not a silent no-destination fallback — see campOwnsCamper()'s comment for
// why. See migrations/079_canteen_stripe_deposits.sql for the full flow
// (webhook crediting, refunds).
//
// Request:  { campId, familyKey, familyName, email?, amount, description?,
//             enrollmentId?, successUrl?, cancelUrl?, source?, camperName? }
// Response: { url, sessionId }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const VALID_SOURCES = new Set(["campistry-checkout", "campistry-canteen-deposit"]);

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
  // The family ROW (camp_family), not the campistryMe document's copy of it.
  const { data, error } = await supabase.rpc("camp_family", { p_camp_id: campId, p_family_key: familyKey });
  return !error && !!data && typeof data === "object";
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

// Canteen's own ownership check, keyed on camper name (app1.camperRoster),
// not familyKey (campistryMe.families) — canteen is per-camper, not
// per-family. UNLIKE campOwnsFamily, a failure here must HARD-REJECT the
// checkout session rather than fall through with no destination: falling
// through would still create a session that, on success, credits a real
// JSON balance to a possibly-fabricated camper name — a ledger-integrity
// problem, not just a routing one (tuition's fallback only risks a wrong
// *destination*, money still lands somewhere real either way).
async function campOwnsCamper(campId: string | undefined, camperName: string | undefined): Promise<boolean> {
  if (!campId || !camperName || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await supabase
    .from("camp_state_kv")
    .select("value")
    .eq("camp_id", campId)
    .eq("key", "app1")
    .maybeSingle();
  const roster = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).camperRoster : null;
  return !!(roster && typeof roster === "object" && Object.prototype.hasOwnProperty.call(roster, camperName));
}

// Camp-wide "does this camp even run a canteen" gate (migration 106) — no
// row for the camp means every program defaults on, same as everywhere
// else this settings table is read.
async function canteenProgramEnabled(campId: string | undefined): Promise<boolean> {
  if (!campId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return true;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await supabase
    .from("camp_link_program_settings")
    .select("canteen_enabled")
    .eq("camp_id", campId)
    .maybeSingle();
  return !data || data.canteen_enabled !== false;
}

async function lookupCampDestinationForCamper(campId: string | undefined, camperName: string | undefined): Promise<string | null> {
  if (!campId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
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
      enrollmentId, successUrl, cancelUrl, source, camperName,
    } = await req.json();

    if (!amount || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "A positive amount is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const checkoutSource = source ? String(source) : "campistry-checkout";
    if (!VALID_SOURCES.has(checkoutSource)) {
      return new Response(JSON.stringify({ error: "Invalid source" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const isCanteenDeposit = checkoutSource === "campistry-canteen-deposit";

    if (isCanteenDeposit) {
      if (!(await canteenProgramEnabled(campId))) {
        return new Response(JSON.stringify({ error: "This camp isn't offering online canteen funding." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!camperName || !(await campOwnsCamper(campId, camperName))) {
        return new Response(JSON.stringify({ error: "Camper not found for this camp" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const cents = String(Math.round(Number(amount) * 100));
    // The camp's own name leads the label, because this string is what the
    // parent sees on the Checkout page, in Stripe's receipt and on their card
    // statement. "Camp payment" names no camp, and a parent who cannot place a
    // charge disputes it.
    let campLabel = "";
    try {
      if (campId && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { data: c } = await svc.from("camps").select("name").eq("id", campId).maybeSingle();
        campLabel = String(c?.name || "").trim();
      }
    } catch (_) { /* a missing name must never stop a payment */ }
    const who = campLabel || "Camp";
    const label = description || (isCanteenDeposit
      ? `${who} — canteen funds for ${camperName}`
      : `${who} — payment${familyName ? " (" + familyName + ")" : ""}`);
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
      source: checkoutSource,
    };
    if (isCanteenDeposit) meta.camperName = String(camperName);

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

    const destinationAccountId = isCanteenDeposit
      ? await lookupCampDestinationForCamper(campId, camperName)
      : await lookupCampDestination(campId, familyKey);

    // Tuition's Pay Link works fine with no destination (money still lands
    // somewhere real — the platform account). Canteen is different: the
    // entire point of this flow is "money must land in the camp's own
    // account," so a canteen deposit with nowhere real to route to would be
    // a silent policy violation, not just degraded UX. Reject outright
    // rather than quietly falling back to the platform account — the
    // client is also expected to hide "Add Funds" for an unconnected camp
    // (get_camp_canteen_stripe_status), this is the server-side backstop.
    if (isCanteenDeposit && !destinationAccountId) {
      return new Response(JSON.stringify({ error: "This camp hasn't set up online canteen funding yet." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (destinationAccountId) {
      // on_behalf_of makes the CAMP the settlement merchant, which is the whole
      // point: a destination charge without it settles on the platform, so the
      // cardholder's statement carries the PLATFORM's descriptor. A parent who
      // pays their camp and finds a charge from a company they have never heard
      // of disputes it — and a dispute over an unrecognised descriptor is the
      // single most documented avoidable chargeback there is. With on_behalf_of
      // the statement uses the connected account's descriptor, i.e. the camp's.
      // Stripe requires it to EQUAL transfer_data[destination] for card
      // payments, so the two are always set together, from the same value.
      params["payment_intent_data[transfer_data][destination]"] = destinationAccountId;
      params["payment_intent_data[on_behalf_of]"] = destinationAccountId;
    }

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    console.log(`[stripe-checkout] Session ${session.id} for ${isCanteenDeposit ? camperName : (familyName || familyKey)} — $${amount}`);

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
