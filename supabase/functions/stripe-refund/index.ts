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
// WHO MAY REFUND (TED-052). This function used to check nobody: anyone holding a
// payment's reference (printed on every autopay receipt) could refund it. Now,
// like payments-refund:
//   - the caller must be signed in as an owner/admin of a camp, derived from
//     their own session, never from the request;
//   - the payment must belong to THAT camp: its Stripe customer is one of the
//     camp's families, or (a payment with no customer) Stripe's own record of it
//     names the camp;
//   - the refund is claimed before Stripe is called (migration 198), so a retry
//     of the same click replays the first answer instead of refunding twice.
//
// Request:  { paymentIntentId, amount?, reason?, metadata?, idempotencyKey? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { refundId, status, amount }
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
  if (out && typeof out === "object" && !out.error) {
    // Stripe marks an answer repeated from its memory of the key (TED-126).
    try { out.__replayed = resp.headers?.get?.("Idempotent-Replayed") === "true"; } catch (_) { /* no headers */ }
  }
  return out;
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
  });
  return resp.json();
}

// Stripe keeps each Idempotency-Key's first answer for 24 hours and answers a
// repeat from that memory. A refund it made under the key and has since FAILED
// comes back as it was then — "succeeded" — with nothing sent (TED-126). So a
// repeated answer is checked against the refund as it is now, and a failed one
// moves the key on, to one made from the failed refund's own id.
async function sendRefund(params: Record<string, string>, key: string | undefined): Promise<any> {
  if (!key) return stripePost("/refunds", params);
  let k = key;
  for (let i = 0; i < 5; i++) {
    const out = await stripePost("/refunds", params, k);
    if (!out || out.error || !out.id) return out;
    const replayed = out.__replayed === true
      || (Number(out.created) > 0 && Date.now() - Number(out.created) * 1000 > 120000);
    if (!replayed) return out;
    let now: any = null;
    try { now = await stripeGet(`/refunds/${encodeURIComponent(String(out.id))}`); } catch (_) { now = null; }
    if (!now || now.error || !now.id) return { error: { type: "api_error", message: "Stripe did not say what became of this refund." } };
    if (now.status !== "failed" && now.status !== "canceled") return now;
    k = `${key}_after_${now.id}`;
  }
  return { error: { type: "invalid_request_error", message: "This refund has failed at Stripe five times — refund it by hand." } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// The camp the AUTHENTICATED caller is owner/admin of — same rule as
// stripe-charge and payments-refund.
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
  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0])
    : null;
  if (owned?.id) return owned.id;
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

// Does this payment belong to this camp? Its customer must be one of the camp's
// families; a payment with no customer must carry the camp in Stripe's own
// metadata (set by our checkout functions, never by the refund request).
async function campOwnsPayment(campId: string, pi: any): Promise<boolean> {
  // Our own functions stamp the camp on every payment they create (metadata is
  // set with the platform's secret key, never by a browser). That decides it
  // first: a registration deposit is made on the FORM's customer, which is
  // often not the family's card on file (a returning family, a sibling, a
  // hosted checkout's fresh customer) — and it is still this camp's (TED-096).
  //
  // But only for a family's money (TED-100): Campistry's own charges TO the camp
  // — the SMS number and monthly SMS fees — carry the same camp stamp, and a
  // camp must never be able to refund those to itself.
  const meta = pi?.metadata || {};
  if (/telnyx/i.test(String(meta.purpose || "")) || /telnyx/i.test(String(meta.source || ""))) return false;
  if (meta.campId && String(meta.campId) !== campId) return false;   // another camp's, by its own stamp
  if (String(meta.campId || "") === campId && String(meta.source || "") === "registration_deposit") return true;
  const customer = typeof pi?.customer === "string" ? pi.customer : pi?.customer?.id;
  if (customer) {
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: families, error } = await service.rpc("camp_families_object", { p_camp_id: campId });
    if (error || !families || typeof families !== "object") return false;
    return Object.values(families as Record<string, any>).some((f: any) => f && f.stripeCustomerId === customer);
  }
  return String(pi?.metadata?.campId || "") === campId;
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

    const campId = await callerCampId(req);
    if (!campId) return json({ error: "Only camp owners/admins can issue a refund." }, 403);

    const { paymentIntentId, amount, reason, metadata, idempotencyKey } = await req.json();

    if (!paymentIntentId || !/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntentId))) {
      return json({ error: "paymentIntentId required" }, 400);
    }

    const pi = await stripeGet(`/payment_intents/${paymentIntentId}`);
    if (!pi || pi.error || !(await campOwnsPayment(campId, pi))) {
      return json({ error: "That payment does not belong to your camp." }, 403);
    }

    // Always an explicit, positive amount (TED-076). "No amount" means a FULL
    // refund to Stripe, so a 0, a negative or a missing amount used to refund
    // the whole payment. Billing always sends the amount it means.
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return json({ error: "A refund needs an amount greater than zero." }, 400);
    }
    const params: Record<string, string> = {
      payment_intent: String(paymentIntentId),
      amount: String(amountCents),
    };
    // Stripe only accepts: duplicate | fraudulent | requested_by_customer
    if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") {
      params.reason = reason;
    }
    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        params[`metadata[${k}]`] = String(v);
      });
    }

    params["metadata[campId]"] = campId;

    // Was the original charge a destination charge to a camp's own
    // connected account? If so, reverse the transfer along with the refund
    // so the camp's account (not the platform's) is debited.
    if (pi?.transfer_data?.destination) {
      params.reverse_transfer = "true";
    }

    // CLAIM BEFORE STRIPE (migration 198), exactly as payments-refund does: a
    // retry of the same click replays the first answer instead of refunding
    // again. The same key also goes to Stripe as its Idempotency-Key.
    const pageKey = typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : null;
    let claimKey = pageKey;
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // A refund made under this key and settled may since have FAILED at Stripe
    // and been put back on the family's account (278). The office is then told
    // to refund it again, and Billing sends the same key (the same payment,
    // amount and what is left of it) — which replayed the old, failed refund:
    // "Refunded $500" with nothing sent, a new refund line per press (TED-136).
    // So a replay is checked against the refund as it is NOW; a failed or
    // canceled one moves the key on, to one made from its id — the same new
    // key again if this refund is itself cut off and retried.
    let hop = 0;
    for (; claimKey && hop < 5; hop++) {
      const { data: claim } = await service.rpc("claim_refund_intent", {
        p_camp_id: campId, p_key: claimKey,
        p_amount: params.amount ? Number(params.amount) / 100 : null,
        p_payment_ref: String(paymentIntentId),
      });
      if (!(claim && claim.claimed === false && claim.previous && claim.previous.refundId)) break;
      // Held but never confirmed falls through too: an earlier try was cut off
      // after Stripe was asked (TED-093), and asking again with the SAME Stripe
      // key is safe — Stripe answers with the refund it made, or makes it now.
      const prevId = String(claim.previous.refundId);
      let now: any = null;
      try { now = await stripeGet(`/refunds/${encodeURIComponent(prevId)}`); } catch (_) { now = null; }
      if (!now || now.error || !now.id) {
        return json({ uncertain: true, error: "Stripe could not be asked what became of the earlier refund with these details — try again in a minute." }, 200);
      }
      if (now.status !== "failed" && now.status !== "canceled") {
        console.log(`[stripe-refund] replaying settled refund for key ${claimKey}`);
        return json(Object.assign({ replayed: true }, claim.previous, { status: now.status }), 200);
      }
      console.log(`[stripe-refund] the refund under key ${claimKey} (${prevId}) ${now.status} — sending a new one`);
      claimKey = `${pageKey}:after:${prevId}`;
    }
    if (hop >= 5) {
      return json({ error: "This refund has failed at Stripe five times — refund it by hand (Offline Refund)." }, 409);
    }

    const refund = await sendRefund(params, claimKey ? `refund:${campId}:${claimKey}` : undefined);

    if (refund.error) {
      // Still running at Stripe (a concurrent try with this key): not a "no".
      if (refund.error.type === "idempotency_error" || refund.error.type === "api_error") {
        return json({ uncertain: true, error: "Stripe is still working on this refund — wait a minute and check before trying again." }, 200);
      }
      if (claimKey) await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: claimKey });
      throw new Error(refund.error.message);
    }

    if (claimKey) {
      await service.rpc("settle_refund_intent", {
        p_camp_id: campId, p_key: claimKey,
        p_result: { refundId: refund.id, status: refund.status, amount: (refund.amount || 0) / 100 },
      });
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
