// =============================================================================
// stripe-canteen-autoreload-setup — Hosted Stripe page to save a payment
// method for CANTEEN auto-reload (threshold/scheduled top-ups), the canteen
// analog of stripe-setup-checkout (which does the same thing for tuition
// autopay, keyed to a family). Duplicated rather than shared — this codebase
// has no shared module between Edge Functions (see stripe-setup-checkout's
// own header comment, and how stripe-canteen-refund duplicated stripe-refund
// instead of chaining an HTTP call) — with the ownership check swapped for
// campOwnsCamper (canteen is per-camper, not per-family) and metadata that
// routes the resulting webhook event to the canteen account instead of a
// family record.
//
// On completion, stripe-webhook's setup_intent.succeeded handler
// (handleCanteenAutoReloadSetup) writes the resulting Stripe Customer +
// PaymentMethod ID onto camp_state_kv.campistrySnacks.accounts[camperName]
// .autoReload (stripeCustomerId / stripePaymentMethodId / cardOnFile) — read
// by the canteen-auto-reload cron function to actually charge later. See
// migrations/109_canteen_auto_reload.sql + CANTEEN_AUTORELOAD_SETUP.md.
//
// Request:  { campId, camperName, email?, existingCustomerId?, successUrl?, cancelUrl? }
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

// Canteen is per-camper (app1.camperRoster), not per-family — same check
// stripe-checkout uses for canteen deposits. campId is client-supplied with
// no session auth here (same residual gap documented on stripe-setup-checkout
// and stripe-checkout) — this endpoint doesn't move any money itself, it only
// lets someone start a Checkout session that (once completed) attaches a
// payment method to a real camper's own auto-reload config in THEIR OWN
// camp's data; resolveCamper blocks the simple stale/wrong-campId case.
//
// Returns the camper's roster key, or null when they are not on this camp's
// roster. The camper NUMBER decides when the page sends one (resolved to that
// person's current roster key by camp_person_label); the name is only the
// fallback for a caller that sends no number.
async function resolveCamper(campId: string | undefined, camperName: unknown, camperId: number | null): Promise<string | null> {
  if (!campId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  let key: string | null = camperId == null && typeof camperName === "string" && camperName ? camperName : null;
  if (camperId != null) {
    const { data: label, error } = await supabase.rpc("camp_person_label", { p_camp_id: campId, p_person_id: camperId });
    key = !error && typeof label === "string" && label ? label : null;
  }
  if (!key) return null;
  const { data } = await supabase
    .from("camp_state_kv")
    .select("value")
    .eq("camp_id", campId)
    .eq("key", "app1")
    .maybeSingle();
  const roster = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).camperRoster : null;
  return roster && typeof roster === "object" && Object.prototype.hasOwnProperty.call(roster, key) ? key : null;
}

// Camp-wide "does this camp even run a canteen" gate (migration 106) — same
// check stripe-checkout applies before a canteen deposit; auto-reload is
// just another way to fund canteen, so it needs the same gate.
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


/** A camper id sent by the page (campistry_camper_id_rpc.js adds it), or null. */
function camperIdIn(v: unknown): number | null {
  return v != null && /^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null;
}

/** A camper's name as a person reads it: without the roster's internal
 *  " #<number>" that tells two campers with one name apart. For what a parent
 *  sees; never for identifying the camper. */
function displayName(s: unknown): string {
  return String(s ?? "").replace(/\s#\d+(?:-\d+)?$/, "");
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
      campId, camperName, camperId: bodyCamperId, email, existingCustomerId, successUrl, cancelUrl,
    } = await req.json();
    const camperId = camperIdIn(bodyCamperId);

    if (!campId || (camperId == null && !camperName)) {
      return new Response(JSON.stringify({ error: "campId and camperId (or camperName) are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!(await canteenProgramEnabled(campId))) {
      return new Response(JSON.stringify({ error: "Canteen isn't enabled for this camp" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const camperKey = await resolveCamper(campId, camperName, camperId);
    if (!camperKey) {
      return new Response(JSON.stringify({ error: "Camper not found for this camp" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reuse an existing Stripe Customer if one was already created for this
    // email (e.g. from tuition autopay setup) rather than creating a
    // duplicate — same pattern stripe-setup-checkout uses.
    let customerId = existingCustomerId || null;
    if (!customerId && email) {
      const search = await stripeGet(`/customers?email=${encodeURIComponent(email)}&limit=1`);
      if (search.data?.length > 0) customerId = search.data[0].id;
    }
    if (!customerId) {
      const customer = await stripePost("/customers", {
        name: displayName(camperKey),
        ...(email ? { email: String(email) } : {}),
        "metadata[campId]": String(campId),
        "metadata[source]": "campistry",
      });
      if (customer.error) throw new Error(customer.error.message);
      customerId = customer.id;
    }

    const origin = req.headers.get("origin") || "";
    const success = successUrl || `${origin}/campistry_pay_thanks.html?status=success&kind=canteen-autoreload`;
    const cancel = cancelUrl || `${origin}/campistry_pay_thanks.html?status=cancelled&kind=canteen-autoreload`;

    const meta: Record<string, string> = {
      campId: String(campId),
      // To stripe-webhook, which saves the card on this camper's account by
      // ID; the roster key beside it is only the fallback for no number.
      camperId: camperId != null ? String(camperId) : "", camperName: String(camperKey),
      source: "campistry-canteen-autoreload-setup",
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
    console.error("[stripe-canteen-autoreload-setup] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
