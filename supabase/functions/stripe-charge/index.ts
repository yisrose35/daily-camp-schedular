// =============================================================================
// stripe-charge — Charge a stored payment method
//
// Called when camp wants to charge a family's saved card.
// Uses the stored Stripe Customer + PaymentMethod to create
// an off-session PaymentIntent (auto-debit).
//
// Auth: requires the caller's real Supabase session JWT (this function is
// only ever called from campistry_me.js's staff Billing page — confirmed,
// no other caller in the codebase — so requiring a real session breaks
// nothing legitimate). The camp that receives a destination transfer is
// derived EXCLUSIVELY from that authenticated caller's own owner/admin
// membership — never from a client-supplied campId. Earlier drafts of this
// function trusted an unauthenticated request-body campId to pick the
// Stripe Connect destination; a caller could send a real family's
// customerId/paymentMethodId alongside an arbitrary OTHER (attacker-owned,
// Connect-enabled) camp's campId and misroute that family's money. Deriving
// the destination camp from the session instead of the request body closes
// that off entirely — there is no campId value a client can send that
// changes where the money goes.
//
// If the caller's own camp has connected its own Stripe account
// (camps.stripe_account_id, see stripe-connect-onboard-camp), the resulting
// PaymentIntent gets transfer_data[destination] added so the money lands in
// the camp's own bank account instead of the platform's. This is a
// destination charge — the Customer/PaymentMethod/Charge object all stay on
// the PLATFORM account (never a Stripe-Account header), so nothing about
// how the card was saved needs to change. No platform fee is applied (the
// camp keeps 100% of the charge) — see migrations/077_camp_stripe_connect.sql.
// A camp that hasn't connected (stripe_account_id IS NULL) is unaffected —
// this stays the exact same platform-account charge as before.
//
// WHOSE CARD (TED-058). The customer must be one of the caller's own camp's
// families, and a given payment method must be that customer's; otherwise the
// charge is REFUSED. (It used to go ahead with no destination, charging a
// stranger's card into the platform's account.) An idempotencyKey from the
// click is sent to Stripe as its Idempotency-Key, so a retry cannot charge
// twice.
//
// Request:  { customerId, paymentMethodId, amount, currency, description, metadata, idempotencyKey?, campId? }
//           header: Authorization: Bearer <caller's Supabase access token>
//           (campId in the body is kept for metadata/logging only — it is
//           NEVER used to pick a Stripe Connect destination)
// Response: { paymentIntentId, status, amount }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Resolves the camp the AUTHENTICATED caller actually belongs to as
// owner/admin — this, not any client-supplied value, is the only campId
// ever used to pick a Stripe Connect destination.
async function callerCampId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;

  // .maybeSingle() throws/returns null on >1 rows — an account can
  // legitimately own more than one camp (debug copies, multiple real
  // camps), and that silently broke this whole check for any such
  // account: a genuine owner fell through to the camp_users check below
  // and, finding nothing there either, got rejected as "not owner/admin"
  // on their own camp. Mirrors detectCampAndRole()'s own tie-break in
  // supabase_client.js: prefer the camp whose id equals the owner's own
  // uid (the original signup convention), else just the first one.
  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0])
    : null;
  if (owned?.id) return owned.id;

  // Same fix here — .maybeSingle() also broke for anyone belonging to more
  // than one camp_users row. Most-recently-accepted wins, matching
  // detectCampAndRole()'s STEP 1 rule (and only an ACCEPTED invite counts,
  // same as that rule — a still-pending one shouldn't grant refund
  // authority).
  const { data: memberships } = await asUser
    .from("camp_users")
    .select("camp_id, role")
    .eq("user_id", uid)
    .not("accepted_at", "is", null)
    .order("accepted_at", { ascending: false })
    .limit(1);
  const membership = Array.isArray(memberships) && memberships.length ? memberships[0] : null;
  if (membership?.camp_id && SENDER_ROLES.includes(membership.role)) return membership.camp_id;
  return null;
}

// Defense in depth on top of callerCampId already being server-derived:
// only apply a destination when the resolved camp's own camp_state_kv
// actually contains a family with this exact stripeCustomerId — otherwise
// fall through with no destination (the same safe behavior as an
// unconnected camp), never reject the charge itself.
async function campOwnsCustomer(campId: string | undefined, customerId: string | undefined): Promise<boolean> {
  if (!campId || !customerId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  // The family ROWS (camp_families_object): a Stripe customer saved by
  // stripe-webhook is written to the row, and the campistryMe document's copy
  // only catches up when somebody saves the Me page — so this refused to charge
  // a card the camp had just saved.
  const { data: families, error } = await supabase.rpc("camp_families_object", { p_camp_id: campId });
  if (error || !families || typeof families !== "object") return false;
  return Object.values(families as Record<string, any>).some((f: any) => f && f.stripeCustomerId === customerId);
}

// Returns the camp's connected account AND its name. The name is not a nicety:
// it is what a parent reads on their statement and in their receipt, and a
// charge described as "Campistry payment" is a charge from a company the parent
// has never heard of, for money they gave their camp.
async function lookupCamp(campId: string | undefined, customerId: string | undefined):
    Promise<{ destination: string | null; name: string }> {
  const none = { destination: null, name: "" };
  if (!campId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return none;
  if (!(await campOwnsCustomer(campId, customerId))) return none;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: camp } = await supabase
    .from("camps")
    .select("stripe_account_id, stripe_charges_enabled, name")
    .eq("id", campId)
    .maybeSingle();
  return {
    destination: (camp?.stripe_account_id && camp.stripe_charges_enabled) ? camp.stripe_account_id : null,
    name: String(camp?.name || "").trim(),
  };
}

async function stripePost(endpoint: string, body: Record<string, string>, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${STRIPE_SECRET}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
  const out = await resp.json();
  // A "no" Stripe stands by (a 4xx it keeps for the key: a decline, a bad
  // request) is definite. A 5xx, a 409 (the same key still running) or a 429
  // decides nothing — the charge may yet be made.
  if (out && typeof out === "object" && out.error) out.__definite = resp.status >= 400 && resp.status < 500 && resp.status !== 409 && resp.status !== 429;
  return out;
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
  });
  return resp.json();
}

// ── An autopay charge the card company never answered (276), answered "it
// went through" by the office (TED-120) ────────────────────────────────────
// On an autopay night many families pay the same amount, so a payment id
// pasted from the Stripe dashboard can easily be another family's — or a typo.
// Recorded as it stood, that credited this family twice (or for money never
// collected). So Stripe is asked about the payment, and it is recorded only
// when it is: succeeded; this family's Stripe customer; for this instalment's
// amount; made on or after the day autopay tried (a day's slack for time
// zones); and, when it carries Campistry's stamp, this camp's and this
// family's. The database then refuses it again if it is booked for anyone else.
async function confirmAutopay(campId: string, body: Record<string, any>): Promise<Record<string, unknown>> {
  const familyKey = String(body.familyKey || "");
  const planRef = String(body.planRef || "");
  const piId = String(body.paymentIntentId || "").trim();
  if (!familyKey || !planRef) return { success: false, error: "Which family and plan?" };
  if (!/^pi_[A-Za-z0-9]+$/.test(piId)) return { success: false, error: "On Stripe, use the payment's id — it starts with pi_." };
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: families, error: famErr } = await service.rpc("camp_families_object", { p_camp_id: campId });
  if (famErr || !families || typeof families !== "object") return { success: false, error: "Could not read this camp's families — try again." };
  const fam = (families as Record<string, any>)[familyKey];
  if (!fam) return { success: false, error: "That family is not at your camp." };
  const plans: any[] = Array.isArray(fam.plans) ? fam.plans : [];
  const plan = plans.find((p: any, i: number) => p && ((p.id && String(p.id) === planRef) || (!p.id && `#${i}` === planRef)));
  const hold = plan && plan.pendingCharge;
  if (!hold || !hold.unconfirmed) return { success: false, error: "That charge was already answered." };
  if (String(hold.processor || "") !== "stripe") return { success: false, error: "That charge did not go through Stripe." };
  if (!fam.stripeCustomerId) return { success: false, error: "This family has no Stripe customer on file, so the payment cannot be checked." };

  let pi: any;
  try {
    const resp = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(piId)}`, {
      headers: { "Authorization": `Bearer ${STRIPE_SECRET}` } });
    if (resp.status >= 500 || resp.status === 429) return { success: false, error: "Stripe did not answer — try again in a minute." };
    pi = await resp.json();
  } catch (_) {
    return { success: false, error: "Stripe did not answer — try again in a minute." };
  }
  if (!pi || pi.error || !pi.id) return { success: false, error: `Stripe has no payment ${piId} — check the id (it is on the payment's page in the Stripe dashboard).` };
  const customer = typeof pi.customer === "string" ? pi.customer : pi.customer?.id;
  const cents = Math.round(Number(hold.amount) * 100);
  const got = Number(pi.amount_received ?? pi.amount) || 0;
  const meta = pi.metadata || {};
  if (pi.status !== "succeeded") return { success: false, error: `That payment has not gone through (Stripe says "${pi.status}").` };
  if (customer !== fam.stripeCustomerId) return { success: false, error: `That payment is not ${fam.name || "this family"}'s — it was made on another customer's card.` };
  if (got !== cents) return { success: false, error: `That payment is for $${(got / 100).toFixed(2)}, not this instalment's $${(cents / 100).toFixed(2)}.` };
  if ((meta.campId && String(meta.campId) !== campId) || (meta.familyKey && String(meta.familyKey) !== familyKey)) {
    return { success: false, error: "That payment was made for another family." };
  }
  if (meta.planId && hold.planId && String(meta.planId) !== String(hold.planId)) {
    return { success: false, error: "That payment was made for another payment plan." };
  }
  const since = Date.parse(String(hold.since || "") + "T00:00:00Z");
  if (Number.isFinite(since) && Number(pi.created) * 1000 < since - 86400000) {
    return { success: false, error: `That payment was made before autopay tried this instalment (${hold.since}) — it is an earlier payment.` };
  }

  const { data: rec, error: recErr } = await service.rpc("resolve_unconfirmed_autopay_checked", {
    p_camp_id: campId, p_family_key: familyKey, p_plan_ref: planRef, p_reference: piId });
  if (recErr) return { success: false, error: "Could not record it — try again. (" + recErr.message + ")" };
  if (!rec || rec.success !== true) {
    const why = rec?.error === "reference_is_another_payment" ? "that payment is already booked for another family or amount"
      : rec?.error === "nothing_to_answer" ? "that charge was already answered" : (rec?.error || "not recorded");
    return { success: false, error: "Not recorded: " + why + "." };
  }
  return { success: true, recorded: true };
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

    let reqBody: Record<string, any> = {};
    try { reqBody = await req.json(); } catch (_) { reqBody = {}; }
    const authedCampId = await callerCampId(req);
    if (!authedCampId) {
      // Said for what was asked (TED-134): confirming an autopay payment charges nothing.
      const why = reqBody && reqBody.action === "confirmAutopay"
        ? "Only the camp owner or an admin can confirm a Stripe autopay payment."
        : "Only the camp owner or an admin can charge a stored card.";
      return new Response(JSON.stringify({ error: why }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // "The autopay charge went through" on Stripe (279, TED-120): checked with
    // Stripe here, never taken from the browser.
    if (reqBody && reqBody.action === "confirmAutopay") {
      const out = await confirmAutopay(authedCampId, reqBody);
      return new Response(JSON.stringify(out), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { customerId, paymentMethodId, amount, currency, description, metadata, idempotencyKey } = reqBody;

    if (!customerId || !amount || !(Number(amount) > 0)) {
      return new Response(JSON.stringify({ error: "customerId and a positive amount required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only a family of the caller's own camp.
    if (!(await campOwnsCustomer(authedCampId, customerId))) {
      return new Response(JSON.stringify({ error: "That card is not on file for a family at your camp." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // ...and a given payment method must be that family's own.
    if (paymentMethodId) {
      const pm = await stripeGet(`/payment_methods/${encodeURIComponent(String(paymentMethodId))}`);
      const pmCustomer = typeof pm?.customer === "string" ? pm.customer : pm?.customer?.id;
      if (!pm || pm.error || pmCustomer !== customerId) {
        return new Response(JSON.stringify({ error: "That payment method does not belong to this family." }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
      description: description || "Camp payment",
    };

    // Add metadata
    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        params[`metadata[${k}]`] = String(v);
      });
    }
    // The camp is the server's, never the request's.
    params["metadata[campId]"] = authedCampId;

    const camp = await lookupCamp(authedCampId, customerId);
    const destinationAccountId = camp.destination;
    // Name the camp on the charge, so the parent reading a statement or a
    // receipt recognises it. Set after the lookup, which is why the params
    // object above no longer tries to guess a description of its own.
    if (camp.name) params["description"] = description || (camp.name + " — payment");
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
      params["transfer_data[destination]"] = destinationAccountId;
      params["on_behalf_of"] = destinationAccountId;
    }

    const claimKey = typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : "";
    const unsure = (why: string) => new Response(JSON.stringify({ uncertain: true,
      error: `Stripe did not give a final answer (${why}), so this charge may have gone through. Check the family's payments or the Stripe dashboard before charging again — pressing Charge Card again for the same amount is safe: Stripe answers with the first charge instead of making a second.` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    let paymentIntent: any;
    try {
      paymentIntent = await stripePost("/payment_intents", params,
        claimKey ? `charge:${authedCampId}:${claimKey}` : undefined);
    } catch (e) {
      // Cut off after Stripe may have charged (TED-111): never "failed".
      return unsure((e as Error).message || "no answer");
    }

    if (paymentIntent.error && !paymentIntent.__definite) return unsure(paymentIntent.error.message || "no answer");
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
      // A definite decline: nothing was charged. Said as such (TED-111), so
      // the page starts a fresh charge next time instead of replaying this one.
      return new Response(JSON.stringify({ declined: true, error: paymentIntent.error.message || "Declined" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
