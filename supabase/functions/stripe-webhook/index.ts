// =============================================================================
// stripe-webhook — Record online payments into the billing ledger
//
// Stripe calls this when a payment changes state. We write the payment straight
// into the camp's billing ledger — camp_state_kv → campistryMe.finance.payments
// — which is the SAME list the office Billing/Analytics screens read. So a
// payment a parent makes online (card, ACH bank debit, Cash App, PayPal, …)
// shows up in billing automatically, no manual entry.
//
// Lifecycle handled (important for ACH, which settles in days, not seconds):
//   - payment_intent.processing      → record as status 'pending' (visible, but
//                                       NOT counted as collected yet)
//   - payment_intent.succeeded       → mark 'succeeded' (now counts)
//   - payment_intent.payment_failed  → mark 'failed' (never counts)
//
// Idempotent by stripePaymentIntentId: webhook retries — and payments the office
// already recorded client-side via stripe-charge — are updated in place, never
// duplicated.
//
// CANTEEN DEPOSITS are a separate, either/or path: a PaymentIntent with
// metadata.source === 'campistry-canteen-deposit' (created by stripe-checkout
// for the Link "Add Funds" flow) is credited to campistrySnacks instead — see
// handleCanteenDeposit() and migrations/079_canteen_stripe_deposits.sql. It
// must NEVER also land in campistryMe.finance.payments, or Billing/Analytics
// would misreport a canteen top-up as tuition revenue.
//
// LINK PHOTO PURCHASES are a third either/or path: metadata.source ===
// 'campistry-link-photo-purchase' (created by link-photo-checkout, a
// SEPARATE function from stripe-checkout) records a facial-recognition or
// HD-photo unlock into link_photo_purchases instead — see
// handleLinkPhotoPurchase() and migrations/081_link_photo_purchases.sql.
//
// AUTOPAY SETUP is a fourth, unrelated path — it isn't a payment at all.
// stripe-setup-checkout creates a Checkout Session in `mode: 'setup'`
// (parent or office saving a card/bank account for future autopay, never
// typed into Campistry's own site). That produces a `setup_intent.succeeded`
// event, not a payment_intent one — handled separately below by
// handleAutopaySetup(), which writes the resulting Customer + PaymentMethod
// straight onto the family record (f.stripeCustomerId/stripePaymentMethodId/
// cardOnFile) that charge-due-installments already reads for autopay.
//
// PLATFORM RISK EVENTS are a fifth, unrelated path — not billing at all.
// Every camp's charge is ultimately a destination charge on CAMPISTRY'S OWN
// platform Stripe account (camps only ever RECEIVE a transfer — see
// stripe-connect-onboard-camp's header comment), so a sudden volume spike
// across all camps combined can trip Stripe's automated risk systems on
// the platform account itself: early fraud warnings, manual reviews,
// disputes, or a failed payout. None of that is visible to any individual
// camp's office — it has to be watched at the platform level. handleRiskEvent()
// below emails the platform operator immediately when one of these fires,
// so it can be addressed (per Stripe's own guidance) before it escalates
// into a rolling reserve that would delay real payouts to camps.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

// ── receipts ────────────────────────────────────────────────────────────────
// Emailing the parent a receipt is the last step of taking money, not an extra.
// It is dispatched, never awaited for correctness: the money is already taken,
// so a receipt that fails must never fail — or retry — the charge. send-payment-
// receipt is idempotent on the payment reference, so several callers racing for
// the same payment produce exactly one email.

/** A camper id carried in Stripe metadata (always a string there), or null. */
function camperIdIn(v: unknown): number | null {
  return v != null && /^\d+$/.test(String(v)) ? Number(v) : null;
}

async function sendReceipt(o: Record<string, unknown>) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-payment-receipt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(o),
    });
    if (!r.ok) console.warn(`[receipt] dispatch returned ${r.status} for ref ${String(o.ref || "")}`);
  } catch (e) {
    console.warn("[receipt] dispatch failed:", (e as Error)?.message);
  }
}


const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Where platform-risk alerts go — not a camp's inbox, Campistry's own.
const RISK_ALERT_EMAIL = "campistryoffice@gmail.com";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const resend = new Resend(RESEND_API_KEY);

// Mirrors link-photo-checkout's own constant — that function is the only
// place the price is actually charged, this one only needs it to split a
// multi-camper PaymentIntent's total back into a per-camper ledger amount
// (pi.amount is the batch total, not any single camper's share). Keep the
// two in sync if the price ever changes.
const FACIAL_RECOGNITION_FEE_CENTS = 895;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

// Friendly method label from Stripe's payment_method type.
function methodLabel(type: string): string {
  switch (type) {
    case "card": return "Credit Card (online)";
    case "us_bank_account": return "ACH / Bank (online)";
    case "cashapp": return "Cash App";
    case "link": return "Link";
    case "paypal": return "PayPal";
    case "klarna": return "Klarna";
    case "afterpay_clearpay": return "Afterpay";
    default: return type ? type.replace(/_/g, " ") : "Online payment";
  }
}

// A signature older than this is refused, so a captured message cannot be
// replayed later (TED-057). Stripe's own libraries use the same 5 minutes.
const WEBHOOK_TOLERANCE_SECONDS = 300;

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
    const tsSeconds = Number(timestamp);
    if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
      return false;
    }
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return expected === sig;
  } catch {
    return false;
  }
}

// Read-modify-write the campistryMe blob, upserting one payment. Retries a few
// times to shrink the (small) race window between two concurrent webhooks.
// ── A payment Campistry can never record (TED-183) ─────────────────────────
// Most refusals pass (a busy database): the delivery is answered 500 and
// Stripe sends it again. Some never will — the child's number is no longer
// anyone, the application was deleted, the camp is gone. Retrying those for
// Stripe's three days ends in silence: the parent paid and nobody knows. So a
// refusal of that kind is told to the platform once (with what to do) and the
// delivery answered 200.
const NEVER_RECORDED = new Set([
  "unknown_camper", "missing_camper", "no_canteen_account", "camp_not_found", "family_not_found",
  "application_not_found", "enrollment_not_found", "not_found", "invalid_amount", "missing_argument",
]);
class NeverRecorded extends Error { code: string; constructor(m: string, c: string) { super(m); this.code = c; } }
function notRecorded(message: string, code: unknown): Error {
  const c = String(code || "");
  return NEVER_RECORDED.has(c) ? new NeverRecorded(message, c) : new Error(message);
}

async function upsertPayment(
  supabase: ReturnType<typeof createClient>,
  campId: string,
  pi: Record<string, any>,
  status: "pending" | "succeeded" | "failed",
) {
  const meta = pi.metadata || {};
  const amount = (pi.amount || 0) / 100;
  const type = (pi.payment_method_types && pi.payment_method_types[0]) || "card";
  const errorMsg = pi.last_payment_error?.message || "";

  // ── one atomic call, not a blind read-modify-write ──────────────────────
  // This used to read campistryMe, mutate finance.payments and upsert the whole
  // blob, with no lock and no version check. Two overlapping writers — a second
  // webhook, the nightly autopay run, an office save — both read the same blob
  // and the later write silently discarded the earlier append. The card was
  // charged and Campistry had no record of it.
  //
  // The retry loop that was here did not help: it retried on a WRITE ERROR, and
  // a lost update is not an error. Both writes succeed.
  //
  // Stripe sends several events for ONE intent (pending, then succeeded or
  // failed), so this is an upsert rather than an append: p_update_on_match
  // patches the row already recorded for that intent instead of adding a second
  // payment for the same charge. Both the match and the write happen under one
  // row lock, which also makes Stripe's routine webhook retries safe — the
  // duplicate delivery sees the first one's row. See migration 168.
  // Stripe does not promise the order of its events. A "processing" event that
  // lands AFTER "succeeded" (a retried delivery, a slow queue) used to patch
  // the paid row back to pending — the family owed the money again, and
  // Charge Card offered to debit them a second time (TED-144); one landing
  // after "payment_failed" turned a returned debit back into "on its way" for
  // two weeks, blocking Charge Card and autopay (TED-154). So a processing
  // event is checked against the payment as it stands NOW, and recorded only
  // while Stripe still says processing. If Stripe cannot be asked, the
  // delivery is answered 500 and Stripe sends it again.
  if (status === "pending" && STRIPE_SECRET && pi.id) {
    let now: any = null;
    try {
      const resp = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(String(pi.id))}`, {
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
      });
      now = resp.ok ? await resp.json() : null;
    } catch (_) { now = null; }
    if (!now || typeof now.status !== "string") {
      throw new Error(`${pi.id}: Stripe could not be asked how the payment stands — the 'processing' event will come again`);
    }
    if (now.status !== "processing") {
      console.log(`[stripe-webhook] ${pi.id} is ${now.status} now — the late 'processing' event changes nothing`);
      return true;
    }
  }
  const patch: Record<string, any> = {
    status: status,
    amount: amount,
    method: methodLabel(type),
  };
  if (errorMsg) patch.notes = "Online payment failed — " + errorMsg;

  const res = await supabase.rpc("append_camp_payment", {
    p_camp_id: campId,
    p_payment: {
      id: "pi_" + pi.id,
      family: meta.familyName || "",
      familyKey: meta.familyKey || null,
      enrollmentId: meta.enrollmentId || null,
      amount: amount,
      date: new Date().toISOString().split("T")[0],
      method: methodLabel(type),
      reference: pi.id,
      notes: status === "failed"
        ? "Online payment failed — " + errorMsg
        : status === "pending"
          ? "Online payment (" + methodLabel(type) + ") — awaiting settlement"
          : "Online payment (" + methodLabel(type) + ")",
      stripePaymentIntentId: pi.id,
      status: status,
      timestamp: Date.now(),
    },
    p_dedupe_key: pi.id,
    p_update_on_match: patch,
  });
  if (res.error || res.data?.success !== true) {
    // Not recorded (TED-164): the delivery is answered 500 so Stripe sends it
    // again (the write is keyed on the payment, so a retry cannot book it
    // twice) — and no receipt goes out for a payment Campistry has no record of.
    throw notRecorded(`could not record ${pi.id}: ${res.error?.message || res.data?.error || "unknown"}`, !res.error && res.data?.error);
  }
  return true;
}

// Only acts on a final 'succeeded' status — canteen has no "pending balance"
// concept in the UI (unlike tuition's visible-but-uncounted pending row), so
// crediting only once Stripe confirms the charge is final is the safe call:
// a kid tapping the POS terminal needs the balance to already be real money.
async function handleCanteenDeposit(
  supabase: ReturnType<typeof createClient>,
  campId: string,
  pi: Record<string, any>,
  status: "pending" | "succeeded" | "failed",
) {
  if (status !== "succeeded") {
    console.log(`[stripe-webhook] canteen deposit ${pi.id} status=${status} — no ledger write (only 'succeeded' credits)`);
    return;
  }
  const meta = pi.metadata || {};
  // The camper's ID, when the page that started the checkout sent one (it is
  // stamped into the metadata beside the name) — it decides who is credited.
  // The name is the fallback for a checkout started before numbers.
  const camperId = camperIdIn(meta.camperId), camperName = String(meta.camperName || "");
  if (camperId == null && !camperName) {
    console.error(`[stripe-webhook] canteen deposit ${pi.id} has no camperId/camperName in metadata — skipping`);
    return;
  }
  const { data, error } = await supabase.rpc("credit_canteen_balance_from_stripe", {
    p_camp_id: campId,
    p_camper_id: camperId, p_camper_name: camperName,
    p_amount: (pi.amount || 0) / 100,
    p_payment_intent_id: pi.id,
  });
  console.log(`[stripe-webhook] canteen deposit $${(pi.amount || 0) / 100} for ${camperName} (camp ${campId}): ${error ? "FAILED " + error.message : JSON.stringify(data)}`);
  // Not credited (TED-164): 500, so Stripe sends it again (keyed on the payment).
  if (error || !(data as any)?.success) {
    throw notRecorded(`canteen deposit ${pi.id} not credited: ${error?.message || (data as any)?.error || "unknown"}`, !error && (data as any)?.error);
  }
}

// Same "only 'succeeded' counts" rule as canteen deposits above — a parent
// shouldn't see their photo matching/download unlock before Stripe confirms
// the charge is final. record_link_photo_purchase (migration 081, widened
// in 082) is idempotent per (payment_intent, kind, camper/photo), so a
// webhook retry — or this loop re-running mid-way through a batch — is safe.
/**
 * A registration deposit, paid from the public form.
 *
 * Marks the application, not the ledger: there is no family to credit until
 * the office accepts. _record_registration_deposit is idempotent on the
 * payment intent id, so Stripe retrying this event -- which it does -- cannot
 * credit the same deposit twice.
 */
async function handleRegistrationDeposit(
  supabase: ReturnType<typeof createClient>,
  campId: string,
  pi: Record<string, any>,
  status: "pending" | "succeeded" | "failed",
) {
  const enrollmentId = String(pi.metadata?.enrollmentId || "");
  if (!enrollmentId) {
    console.error("[stripe-webhook] registration deposit with no enrollmentId — cannot mark it");
    return;
  }
  // Only settled money counts. A processing ACH or a failed card must not mark
  // a place as held.
  if (status !== "succeeded") {
    console.log(`[stripe-webhook] registration deposit ${status} for ${enrollmentId} — not marking`);
    return;
  }
  const { data, error } = await supabase.rpc("_record_registration_deposit", {
    p_camp_id: campId,
    p_enroll_id: enrollmentId,
    p_amount: (pi.amount || 0) / 100,
    p_reference: String(pi.id || ""),
  });
  if (error || !(data as any)?.success) {
    // The money moved. Anything other than a loud log here loses a paid
    // family into a list of unpaid ones.
    console.error(`[stripe-webhook] could not mark registration deposit for camp ${campId} enrollment ${enrollmentId}: ${error?.message || (data as any)?.error}`);
    // TED-164: 500, so Stripe sends it again.
    throw notRecorded(`registration deposit ${pi.id} not recorded: ${error?.message || (data as any)?.error || "unknown"}`, !error && (data as any)?.error);
  }
  console.log(`[stripe-webhook] registration deposit $${(pi.amount || 0) / 100} marked on ${enrollmentId}${(data as any)?.duplicate ? " (already recorded)" : ""}`);

  // The card, if the parent asked us to keep it. setup_future_usage put the
  // method on a customer; recording the pair here lets enrollCamper carry it
  // onto the family the moment the family first exists.
  const customer = String(pi.customer || "");
  const method = String(pi.payment_method || "");
  if (!customer || !method) return;
  const last4 = String(pi.charges?.data?.[0]?.payment_method_details?.card?.last4 || "");
  const { error: cardErr } = await supabase.rpc("_record_registration_card", {
    p_camp_id: campId,
    p_enroll_id: enrollmentId,
    p_processor: "stripe",
    p_customer: customer,
    p_method: method,
    p_last4: last4,
  });
  // Not fatal: the deposit is already marked and the money is in. A card that
  // did not stick means the family types it once more later, which is a
  // nuisance rather than a loss.
  if (cardErr) console.warn(`[stripe-webhook] card not saved for ${enrollmentId}: ${cardErr.message}`);
  else console.log(`[stripe-webhook] card saved for ${enrollmentId} (••••${last4})`);
}

async function handleLinkPhotoPurchase(
  supabase: ReturnType<typeof createClient>,
  campId: string,
  pi: Record<string, any>,
  status: "pending" | "succeeded" | "failed",
) {
  if (status !== "succeeded") {
    console.log(`[stripe-webhook] link photo purchase ${pi.id} status=${status} — no record written (only 'succeeded' unlocks)`);
    return;
  }
  const meta = pi.metadata || {};
  if (!meta.kind || !meta.parentUserId) {
    console.error(`[stripe-webhook] link photo purchase ${pi.id} missing kind/parentUserId in metadata — skipping`);
    return;
  }

  if (meta.kind === "facial_recognition") {
    const parseList = (s: unknown): unknown[] => {
      try { const v = JSON.parse(String(s || "[]")); return Array.isArray(v) ? v : []; } catch { return []; }
    };
    // Position for position: each camper's number (which decides who the
    // purchase is for) and their name (the fallback for a slot with no number).
    const ids = parseList(meta.camperIds), names = parseList(meta.camperNames).map((n) => String(n ?? ""));
    if (!names.length) {
      console.error(`[stripe-webhook] link photo purchase ${pi.id} missing camperNames in metadata — skipping`);
      return;
    }
    for (let ni = 0; ni < names.length; ni++) {
      const name = names[ni];
      const { data, error } = await supabase.rpc("record_link_photo_purchase", {
        p_camp_id: campId,
        p_parent_user_id: meta.parentUserId,
        p_kind: "facial_recognition",
        p_camper_id: camperIdIn(ids[ni]), p_camper_name: name,
        p_photo_id: null,
        p_amount_cents: FACIAL_RECOGNITION_FEE_CENTS, // per-camper share, NOT pi.amount (that's the whole batch)
        p_payment_intent_id: pi.id,
      });
      console.log(`[stripe-webhook] link photo purchase (facial_recognition) for ${name}, camp ${campId}: ${error ? "FAILED " + error.message : JSON.stringify(data)}`);
      if (error || !(data as any)?.success) {
        throw notRecorded(`photo purchase ${pi.id} for ${name} not recorded: ${error?.message || (data as any)?.error || "unknown"}`, !error && (data as any)?.error);
      }
    }
    return;
  }

  const { data, error } = await supabase.rpc("record_link_photo_purchase", {
    p_camp_id: campId,
    p_parent_user_id: meta.parentUserId,
    p_kind: meta.kind,
    p_camper_id: null, p_camper_name: null,   // an HD photo is bought for a photo, not a camper
    p_photo_id: meta.photoId || null,
    p_amount_cents: pi.amount || 0,
    p_payment_intent_id: pi.id,
  });
  console.log(`[stripe-webhook] link photo purchase (${meta.kind}) $${(pi.amount || 0) / 100} camp ${campId}: ${error ? "FAILED " + error.message : JSON.stringify(data)}`);
  // Not recorded (TED-164): 500, so Stripe sends it again (once per payment).
  if (error || !(data as any)?.success) {
    throw notRecorded(`photo purchase ${pi.id} not recorded: ${error?.message || (data as any)?.error || "unknown"}`, !error && (data as any)?.error);
  }
}

// A card checked on a public registration form (migration 189). The parent is
// still filling the form in, so there is no family and no application to hang
// this on -- it lands on the capture row keyed by the reference we minted, the
// form's poll flips to a tick, and the deposit is charged against it once the
// application is saved.
//
// setup_intent.succeeded is the moment Stripe says the card is usable, which
// is exactly what the tick is claiming.
async function handleRegistrationCardCapture(
  supabase: ReturnType<typeof createClient>,
  si: Record<string, any>,
) {
  const reference = si.metadata?.reference;
  if (!reference) {
    console.error(`[stripe-webhook] card capture ${si.id} has no reference in metadata — nothing to flip`);
    return;
  }
  const customerId = si.customer;
  const paymentMethodId = si.payment_method;
  if (!customerId || !paymentMethodId) {
    // Tell the form, rather than leaving it spinning on a capture that will
    // never arrive.
    await supabase.rpc("complete_card_capture", {
      p_reference: String(reference), p_status: "failed",
      p_customer_ref: null, p_method_ref: null, p_last4: null, p_brand: null,
      p_error: "The card could not be saved.",
    });
    console.error(`[stripe-webhook] card capture ${si.id} missing customer/payment_method`);
    return;
  }

  // Brand and last four, purely so the form can print "Visa ending 4242".
  // Cosmetic: a failure here must not cost the parent an accepted card.
  let last4: string | null = null, brand: string | null = null;
  // FUNDING — 'credit' | 'debit' | 'prepaid' | 'unknown'. Captured because a
  // credit-card surcharge may NEVER be applied to a debit, prepaid, FSA, HSA or
  // Medicare Flex card, and until now every card-saving path here recorded the
  // brand and the last four digits and threw this away. Without it
  // campistry_card_fees.js refuses to surcharge at all, which is the right
  // answer but collects nothing.
  let funding: string | null = null;
  if (STRIPE_SECRET) {
    try {
      const resp = await fetch(`${STRIPE_API}/payment_methods/${paymentMethodId}`, {
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
      });
      const pm = await resp.json();
      if (pm?.card) {
        last4 = pm.card.last4 || null; brand = pm.card.brand || null;
        funding = pm.card.funding || null;
      }
      else if (pm?.us_bank_account) { last4 = pm.us_bank_account.last4 || null; brand = pm.us_bank_account.bank_name || "Bank"; }
    } catch (e) {
      console.warn(`[stripe-webhook] could not label card capture ${reference}: ${(e as Error).message}`);
    }
  }

  const { data, error } = await supabase.rpc("complete_card_capture", {
    p_reference: String(reference), p_status: "completed",
    p_customer_ref: String(customerId), p_method_ref: String(paymentMethodId),
    p_last4: last4, p_brand: brand, p_funding: funding, p_error: null,
  });
  if (error || !data?.success) {
    console.error(`[stripe-webhook] card capture ${reference} accepted but not recorded:`, error?.message || data?.error);
    return;
  }
  console.log(`[stripe-webhook] card capture ${reference} accepted (${brand || "card"} ${last4 || ""})`);
}

// A saved payment method carries no ledger amount, so this doesn't gate on
// status the way the payment/deposit handlers above do — setup_intent.succeeded
// only fires once Stripe actually confirms the method is usable.
async function handleAutopaySetup(
  supabase: ReturnType<typeof createClient>,
  si: Record<string, any>,
) {
  const meta = si.metadata || {};
  const campId = meta.campId;
  const familyKey = meta.familyKey;
  if (!campId || !familyKey) {
    console.error(`[stripe-webhook] autopay setup ${si.id} missing campId/familyKey in metadata — skipping`);
    return;
  }
  const customerId = si.customer;
  const paymentMethodId = si.payment_method;
  if (!customerId || !paymentMethodId) {
    console.error(`[stripe-webhook] autopay setup ${si.id} missing customer/payment_method — skipping`);
    return;
  }

  // Look up the method's type (card vs us_bank_account) for a friendly
  // label in the office/parent UI — informational only, charge-due-installments
  // doesn't care which type it is, off-session PaymentIntents work the same
  // way for both once a PaymentMethod is attached to a Customer.
  let pmType = "card";
  let pmLabel = "";
  // The expiry date, which we were fetching and throwing away. A card expires on
  // a date known the day it is saved, so storing these two numbers is what lets
  // the camp be warned BEFORE autopay starts declining (migration 179) instead
  // of finding out through a decline mid-summer.
  let pmExpMonth: number | null = null;
  let pmExpYear: number | null = null;
  // See the card-capture handler above: a surcharge is credit-only, so the
  // funding type has to be on file or no saved-card charge can ever carry one.
  let pmFunding: string | null = null;
  if (STRIPE_SECRET) {
    try {
      const resp = await fetch(`${STRIPE_API}/payment_methods/${paymentMethodId}`, {
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
      });
      const pm = await resp.json();
      if (pm.type) pmType = pm.type;
      if (pmType === "card" && pm.card) {
        pmLabel = `${pm.card.brand || "Card"} ···· ${pm.card.last4 || ""}`.trim();
        pmExpMonth = Number(pm.card.exp_month) || null;
        pmExpYear = Number(pm.card.exp_year) || null;
        pmFunding = pm.card.funding || null;
      }
      else if (pmType === "us_bank_account" && pm.us_bank_account) pmLabel = `${pm.us_bank_account.bank_name || "Bank"} ···· ${pm.us_bank_account.last4 || ""}`.trim();
    } catch (e) {
      console.warn(`[stripe-webhook] could not fetch payment_method ${paymentMethodId} for label: ${(e as Error).message}`);
    }
  }

  // Migration 139: savedPaymentMethods is a real LIST, not a single slot — same
  // reasoning as cardknox-webhook's mirrored change. The FIRST card ever for a
  // family becomes the default and syncs the legacy single-slot fields (which
  // every existing charge path still reads directly); an ADDITIONAL card just
  // appends as non-default and must not touch them.
  //
  // Which of those it is depends on whether the list is empty, so it is decided
  // under the row lock inside migration 170's append_family_payment_method, not
  // here. This used to be a read, a push and a whole-blob upsert: two cards
  // saved at once lost one, and a redelivered setup_intent.succeeded (Stripe
  // retries freely) appended the SAME card twice. The RPC dedupes on the
  // processor token, under the lock.
  const { data: saved, error: saveErr } = await supabase.rpc("append_family_payment_method", {
    p_camp_id: campId,
    p_family_key: familyKey,
    p_method: {
      id: "pm_" + crypto.randomUUID().replace(/-/g, ""),
      type: pmType,
      processor: "stripe",
      token: paymentMethodId,
      stripeCustomerId: customerId,
      last4: (pmLabel.match(/(\d{4})\s*$/) || [])[1] || "",
      label: pmLabel || (pmType === "us_bank_account" ? "Bank account" : "Card on file"),
      addedDate: new Date().toISOString(),
      // Stored so the camp can be warned before this card starts declining.
      // Absent for a bank account, which does not expire — card_expiry_status
      // reads that as 'unknown' and says nothing, which is correct.
      ...(pmExpMonth && pmExpYear ? { expMonth: pmExpMonth, expYear: pmExpYear } : {}),
      // Absent for a bank account and for a card Stripe could not classify.
      // Absent means "do not surcharge", never "assume credit".
      ...(pmFunding ? { funding: pmFunding } : {}),
    },
    p_default_fields: {
      stripeCustomerId: customerId,
      stripePaymentMethodId: paymentMethodId,
      cardOnFile: true,
      paymentMethodType: pmType,
      ...(pmLabel ? { paymentMethodLabel: pmLabel } : {}),
      cardSavedDate: new Date().toISOString(),
    },
  });

  if (saveErr || !saved?.success) {
    const why = saveErr?.message || saved?.error || "unknown";
    // family_not_found is the one case that is not a transient failure: the
    // family was deleted between the parent starting the card save and Stripe
    // confirming it. Nothing to retry against.
    console.error(`[stripe-webhook] autopay setup ${si.id}: could not save the card for family ${familyKey} in camp ${campId} (${why})`);
    return;
  }
  console.log(`[stripe-webhook] autopay setup complete for family ${familyKey}, camp ${campId} (${pmType})`
    + (saved.alreadySaved ? " — already on file, redelivery ignored" : ""));

  // Owner-facing feed notification — mirrors check-notes-reminders' insert
  // shape (migration 056). This is the only signal an owner previously had that
  // a parent finished setting up a payment plan on their end; idempotent on
  // (camp_id, source, source_id=si.id) so a webhook retry never double-notifies.
  const { error: notifErr } = await supabase.from("notifications").upsert({
    camp_id: campId,
    source: "autopay_setup",
    source_id: si.id,
    title: "Payment plan set up",
    body: `${saved.familyName || familyKey} saved a ${pmType === "us_bank_account" ? "bank account" : "card"} for autopay${pmLabel ? " (" + pmLabel + ")" : ""}.`,
    link_target: "campistry_me.html",
  }, { onConflict: "camp_id,source,source_id", ignoreDuplicates: true });
  if (notifErr) console.warn(`[stripe-webhook] autopay setup notification insert failed: ${notifErr.message}`);
}

// Canteen auto-reload's card-save handler — the canteen analog of
// handleAutopaySetup above. Same "just a saved payment method, no ledger
// amount" shape, but writes onto campistrySnacks.accounts[camperName]
// .autoReload instead of a campistryMe family record (canteen is per-camper,
// not per-family). Only the card/attempt bookkeeping fields are touched here
// — the parent's trigger config (enabled/threshold*/schedule*), set via
// set_canteen_auto_reload (migration 109), is left untouched by merging
// rather than overwriting the autoReload object.
async function handleCanteenAutoReloadSetup(
  supabase: ReturnType<typeof createClient>,
  si: Record<string, any>,
) {
  const meta = si.metadata || {};
  const campId = meta.campId;
  // The number decides whose account the card is saved on; the name is the
  // fallback for a setup started before numbers.
  const camperId = camperIdIn(meta.camperId), camperName = String(meta.camperName || "");
  if (!campId || (camperId == null && !camperName)) {
    console.error(`[stripe-webhook] canteen auto-reload setup ${si.id} missing campId/camperId in metadata — skipping`);
    return;
  }
  const customerId = si.customer;
  const paymentMethodId = si.payment_method;
  if (!customerId || !paymentMethodId) {
    console.error(`[stripe-webhook] canteen auto-reload setup ${si.id} missing customer/payment_method — skipping`);
    return;
  }

  let pmType = "card";
  let pmLabel = "";
  if (STRIPE_SECRET) {
    try {
      const resp = await fetch(`${STRIPE_API}/payment_methods/${paymentMethodId}`, {
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
      });
      const pm = await resp.json();
      if (pm.type) pmType = pm.type;
      if (pmType === "card" && pm.card) pmLabel = `${pm.card.brand || "Card"} ···· ${pm.card.last4 || ""}`.trim();
      else if (pmType === "us_bank_account" && pm.us_bank_account) pmLabel = `${pm.us_bank_account.bank_name || "Bank"} ···· ${pm.us_bank_account.last4 || ""}`.trim();
    } catch (e) {
      console.warn(`[stripe-webhook] could not fetch payment_method ${paymentMethodId} for label: ${(e as Error).message}`);
    }
  }

  // Migration 170's merge_canteen_autoreload_card: a shallow merge of the card
  // fields onto accounts[camper].autoReload, under a row lock.
  //
  // This one mattered more than it looks. The old path upserted the WHOLE
  // campistrySnacks blob — and that blob holds the canteen transaction ledger,
  // from which the canteen balance is recomputed. A card save racing a POS sale
  // did not just lose a card field, it erased a sale and the money with it.
  const { data: merged, error: mergeErr } = await supabase.rpc("merge_canteen_autoreload_card", {
    p_camp_id: campId,
    p_camper_id: camperId, p_camper: camperName,
    // Only the card/attempt bookkeeping fields. The parent's trigger config
    // (enabled, threshold*, schedule*), set via set_canteen_auto_reload
    // (migration 109), is left untouched by merging rather than overwriting.
    p_fields: {
      stripeCustomerId: customerId,
      stripePaymentMethodId: paymentMethodId,
      cardOnFile: true,
      paymentMethodType: pmType,
      ...(pmLabel ? { paymentMethodLabel: pmLabel } : {}),
      cardSavedDate: new Date().toISOString(),
    },
  });

  if (mergeErr || !merged?.success) {
    const why = mergeErr?.message || merged?.error || "unknown";
    console.error(`[stripe-webhook] canteen auto-reload setup ${si.id}: could not save the card for ${camperName} in camp ${campId} (${why})`);
    return;
  }
  console.log(`[stripe-webhook] canteen auto-reload setup complete for ${camperName}, camp ${campId} (${pmType})`);
}

// Best-effort — a failed alert email must never fail the webhook response
// (Stripe retries on non-2xx, and we don't want risk-event handling to
// become a source of duplicate/stuck webhook deliveries).
// Says whether it went (TED-150): "sent", "failed" (the email service did not
// take it — worth trying again), or "not_configured" (no key: trying again
// cannot help, and the camp's own Billing notice still stands).
async function sendRiskAlertEmail(subject: string, html: string): Promise<"sent" | "failed" | "not_configured"> {
  if (!RESEND_API_KEY) {
    console.error(`[stripe-webhook] RESEND_API_KEY not configured — cannot send risk alert: ${subject}`);
    return "not_configured";
  }
  try {
    const { error } = await resend.emails.send({
      from: "Campistry Platform Alerts <onboarding@resend.dev>",
      to: [RISK_ALERT_EMAIL],
      subject,
      html,
    });
    if (error) { console.error(`[stripe-webhook] risk alert email failed: ${JSON.stringify(error)}`); return "failed"; }
    console.log(`[stripe-webhook] risk alert email sent: ${subject}`);
    return "sent";
  } catch (e) {
    console.error(`[stripe-webhook] risk alert email threw: ${(e as Error).message}`);
    return "failed";
  }
}

// The four platform-account signals Stripe's own guidance points to as
// early warnings before a rolling reserve gets imposed — see the header
// comment. Everything else keeps falling through to the generic
// "Unhandled event" log line at the bottom of the handler, unchanged.
const RISK_EVENT_TYPES = new Set([
  "radar.early_fraud_warning.created",
  "review.opened",
  "charge.dispute.created",
  // Added with migration 175: a dispute the camp WINS has to put the money back
  // on the family's ledger, so the close event matters as much as the open one.
  "charge.dispute.closed",
  "payout.failed",
]);

// ── The CAMP's side of a dispute (migration 175) ───────────────────────────
// handleRiskEvent below emails RISK_ALERT_EMAIL, which is the PLATFORM's
// address. That is the right audience for a fraud signal and the wrong one for a
// chargeback: the money has left the CAMP's account, so the camp's books are now
// wrong until something moves it back.
//
// A chargeback is a reversal of cash received, so it posts a refund entry to the
// family's ledger — the balance goes back up because the ledger got longer, and
// the original payment stays on the record. Winning the dispute posts the
// payment back. Neither edits anything.
//
// Best-effort and never throws: a failure here must not make the webhook return
// non-2xx, because Stripe would retry the whole event and the platform email
// would go out again.
// A GET against the platform's Stripe account. Stripe not answering (cut off,
// its own 5xx, a rate limit) THROWS (TED-121): the event is then answered 500,
// so Stripe sends it again — answering "OK" would lose the chargeback or the
// refund for good. A plain "no such object" is an answer: null.
async function stripeGetJson(path: string): Promise<Record<string, any> | null> {
  if (!STRIPE_SECRET) return null;
  let resp: Response, out: any;
  try {
    resp = await fetch(`${STRIPE_API}${path}`, { headers: { "Authorization": `Bearer ${STRIPE_SECRET}` } });
    out = await resp.json();
  } catch (e) {
    throw new Error(`Stripe did not answer ${path} (${(e as Error).message}) — asking Stripe to send this event again`);
  }
  if (resp.status >= 500 || resp.status === 429) {
    throw new Error(`Stripe answered ${resp.status} for ${path} — asking Stripe to send this event again`);
  }
  return out && !out.error ? out : null;
}

// Which camp a charge, refund or dispute belongs to. Campistry stamps campId on
// the PaymentIntent (and so the charge made from it). A DISPUTE is its own
// object and Stripe does not copy that metadata onto it (TED-114): read it
// from the payment the dispute is about.
// The family a payment was for, from its metadata (TED-207).
async function familyKeyFor(obj: Record<string, any>): Promise<string | null> {
  if (obj?.metadata?.familyKey) return String(obj.metadata.familyKey);
  const piId = typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
  if (piId) {
    const pi = await stripeGetJson(`/payment_intents/${encodeURIComponent(piId)}`);
    if (pi?.metadata?.familyKey) return String(pi.metadata.familyKey);
  }
  return null;
}

async function campIdFor(obj: Record<string, any>): Promise<string | null> {
  if (obj?.metadata?.campId) return String(obj.metadata.campId);
  const piId = typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
  if (piId) {
    const pi = await stripeGetJson(`/payment_intents/${encodeURIComponent(piId)}`);
    if (pi?.metadata?.campId) return String(pi.metadata.campId);
  }
  const chId = typeof obj?.charge === "string" ? obj.charge : obj?.charge?.id;
  if (chId) {
    const ch = await stripeGetJson(`/charges/${encodeURIComponent(chId)}`);
    if (ch?.metadata?.campId) return String(ch.metadata.campId);
  }
  return null;
}

// ── A canteen top-up refunded or disputed outside Campistry (TED-181) ──────
// The payment's metadata says it was a canteen top-up; then the money comes
// off that child's wallet (migration 287), once, and the camp is told. The
// payment is asked of Stripe when the event itself does not carry it.
async function canteenPaymentOf(obj: Record<string, any>): Promise<{ campId: string; pi: string } | null> {
  let meta = obj?.metadata || {};
  let piId = typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
  if (!piId) {
    const chId = typeof obj?.charge === "string" ? obj.charge : obj?.charge?.id;
    if (chId) { const ch = await stripeGetJson(`/charges/${encodeURIComponent(chId)}`); piId = ch?.payment_intent || null; }
  }
  if (!piId) return null;
  if (meta.source !== "campistry-canteen-deposit") {
    const pi = await stripeGetJson(`/payment_intents/${encodeURIComponent(String(piId))}`);
    meta = pi?.metadata || {};
  }
  if (meta.source !== "campistry-canteen-deposit" || !meta.campId) return null;
  return { campId: String(meta.campId), pi: String(piId) };
}
async function canteenReversal(supabase: ReturnType<typeof createClient>, campId: string, pi: string,
                               ref: string, amount: number, kind: "refund" | "dispute" | "dispute_won", note: string | null) {
  const { data, error } = await supabase.rpc("record_canteen_stripe_reversal", {
    p_camp_id: campId, p_payment_intent_id: pi, p_ref_id: ref, p_amount: amount, p_kind: kind, p_note: note });
  // Not recorded: 500, so Stripe sends it again (the write is keyed on the
  // refund or dispute id). A top-up Campistry never credited has nothing to
  // take back — said, not retried.
  if (error || (!data?.success && data?.error !== "deposit_not_found")) {
    throw new Error(`canteen ${kind} ${ref} on ${pi} not recorded: ${error?.message || data?.error || "unknown"} — is migration 287 applied?`);
  }
  console.log(`[stripe-webhook] canteen ${kind} ${ref} on ${pi}: ${JSON.stringify(data)}`);
}

// A disputed canteen top-up (TED-181/205/210): off the child's wallet while the
// bank decides, that child's auto-reload off (290) — and the child's FAMILY
// paused as for a tuition dispute (288), so a brother's or sister's
// auto-reload, tuition autopay and Charge Card on that card wait too. Won: the
// money back and the family's pause lifted; lost: marked lost, for the office.
async function canteenDispute(supabase: ReturnType<typeof createClient>, campId: string, pi: string, disputeId: string,
                              amount: number, outcome: "taking" | "won" | "lost", reason: string | null) {
  let familyKey: string | null = null;
  if (outcome === "taking") {
    await canteenReversal(supabase, campId, pi, disputeId, amount, "dispute", reason ? `Disputed — ${reason}` : null);
    const pause = await supabase.rpc("pause_canteen_autoreload_for_dispute", {
      p_camp_id: campId, p_payment_intent_id: pi, p_dispute_id: disputeId });
    if (pause.error) throw new Error(`canteen dispute ${disputeId}: auto-reload not paused yet: ${pause.error.message} — is migration 290 applied?`);
    if (pause.data?.alreadyWon) return;
    familyKey = pause.data?.familyKey || null;
  } else {
    if (outcome === "won") await canteenReversal(supabase, campId, pi, disputeId, amount, "dispute_won", null);
    const fam = await supabase.rpc("canteen_dispute_family", { p_camp_id: campId, p_ref: pi });
    if (fam.error) throw new Error(`canteen dispute ${disputeId} closed: family not found yet: ${fam.error.message} — is migration 290 applied?`);
    familyKey = fam.data?.familyKey || null;
  }
  if (!familyKey) return;
  const r = outcome === "lost"
    ? await supabase.rpc("note_dispute_lost", { p_camp_id: campId, p_family_key: familyKey, p_dispute_id: disputeId })
    : await supabase.rpc("hold_autopay_for_dispute", { p_camp_id: campId, p_family_key: familyKey, p_dispute_id: disputeId,
        p_hold: outcome === "taking", p_detail: reason ? `canteen top-up: ${reason}` : "canteen top-up" });
  if (r.error) throw new Error(`canteen dispute ${disputeId}: the family's card pause not updated yet: ${r.error.message} — is migration 288 applied?`);
}

async function handleChargeRefunded(
  supabase: ReturnType<typeof createClient>,
  event: Record<string, any>,
) {
  const charge = event.data.object || {};
  const campId = await campIdFor({ metadata: charge.metadata, payment_intent: charge.payment_intent });

  // Stripe sends the whole charge with its refunds list, and re-sends it on
  // every subsequent partial refund. So post each refund individually, keyed on
  // its own id — otherwise a second partial refund would either be missed or
  // would re-post the first. Newer API versions leave the list off the charge,
  // so it is then asked for.
  let refunds: Record<string, any>[] = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
  if (!refunds.length && charge.id) {
    const list = await stripeGetJson(`/refunds?charge=${encodeURIComponent(String(charge.id))}&limit=100`);
    refunds = Array.isArray(list?.data) ? list.data : [];
  }
  if (!refunds.length) return;

  // A canteen top-up (TED-181): off the child's wallet, not the family's bill.
  const canteen = await canteenPaymentOf({ metadata: charge.metadata, payment_intent: charge.payment_intent, charge: charge.id });
  if (canteen) {
    for (const r of refunds) {
      const refundId = String(r.id || "");
      const amount = Number((((r.amount || 0) / 100)).toFixed(2));
      if (!refundId || !(amount > 0)) continue;
      // Campistry's own canteen refund (Snacks) is already on the wallet.
      if (r.metadata && r.metadata.campistryHold) continue;
      const now = await stripeGetJson(`/refunds/${encodeURIComponent(refundId)}`);
      const status = String((now && now.status) || r.status || "");
      if (status === "failed" || status === "canceled") continue;
      await canteenReversal(supabase, canteen.campId, canteen.pi, refundId, amount, "refund", r.reason ? `Refunded in Stripe — ${r.reason}` : null);
    }
    return;
  }

  if (!campId) {
    console.error(`[stripe-webhook] charge.refunded ${charge.id} has no campId in metadata — ` +
      `the refund is NOT on the camp's books; the family still shows a credit they no ` +
      `longer have. Reconcile by hand.`);
    return;
  }

  // Which payment? A row carries the intent id or the charge id depending on
  // which path recorded it, so offer both rather than picking one.
  const refs = [charge.payment_intent, charge.id].filter(Boolean).map(String);

  for (const r of refunds) {
    const refundId = String(r.id || "");
    const amount = Number((((r.amount || 0) / 100)).toFixed(2));
    if (!refundId || !(amount > 0)) continue;
    // A refund that failed (or was canceled) sent nothing back (TED-126): it is
    // not booked here, and one booked before it failed is put back by
    // handleRefundFailed. The list in the event is how the refund stood when
    // the event was MADE — on an older API version this event can arrive after
    // the refund failed and still say "succeeded" (TED-133) — so its status is
    // asked of Stripe now. Stripe not answering throws: the event is sent again.
    const now = await stripeGetJson(`/refunds/${encodeURIComponent(refundId)}`);
    const status = String((now && now.status) || r.status || "");
    if (status === "failed" || status === "canceled") continue;
    {
      const { data, error } = await supabase.rpc("record_external_refund", {
        p_camp_id: campId, p_refund_id: refundId, p_refs: refs,
        p_amount: amount,
        p_note: r.reason ? `Refund — ${r.reason}` : "Refund issued at the processor",
      });
      // A database error: 500, so Stripe sends the refund again (TED-187; the
      // entry is keyed on the refund id). An answer is only logged.
      if (error) throw new Error(`refund ${refundId} not booked yet: ${error.message}`);
      if (!data?.success) {
        console.error(`[stripe-webhook] refund ${refundId} NOT posted ` +
          `(${error?.message || data?.error || "unknown"}) — the family still shows a ` +
          `credit they no longer have. refs=${refs.join(",")}`);
      }
    }
  }
}

// ── A refund Stripe accepted and then FAILED (TED-126) ─────────────────────
// Stripe can fail a refund days after accepting it (the card account was
// closed, say). The money comes back to the PLATFORM's balance — a canteen
// top-up and a camp payment are destination charges, and the transfer reversal
// is not undone — and the family's bill or the child's wallet still said
// "refunded" with the parent paid nothing. Stripe says so with refund.failed
// (and, on older API versions or some payment methods, a refund.updated or
// charge.refund.updated whose status is failed); each is handled once:
// reverse_failed_stripe_refund (278) puts the money back where it was booked
// and raises a Billing notice, and the platform is emailed to pass the money
// back to the camp's own account.
const REFUND_FAILED_TYPES = new Set(["refund.failed", "refund.updated", "charge.refund.updated"]);

async function handleRefundFailed(
  supabase: ReturnType<typeof createClient>,
  event: Record<string, any>,
) {
  const r = event.data.object || {};
  const status = String(r.status || "");
  if (status !== "failed" && status !== "canceled") return;     // an update that is not a failure
  const refundId = String(r.id || "");
  if (!refundId) return;
  const campId = await campIdFor({ metadata: r.metadata, payment_intent: r.payment_intent, charge: r.charge });
  const amount = Number(((Number(r.amount) || 0) / 100).toFixed(2));
  const why = r.failure_reason ? String(r.failure_reason).replace(/_/g, " ") : (status === "canceled" ? "canceled" : null);
  const payment = typeof r.payment_intent === "string" ? r.payment_intent : (r.payment_intent?.id || (typeof r.charge === "string" ? r.charge : r.charge?.id) || "");
  // The platform is alerted for EVERY failed refund (TED-131) — the money is
  // back in the platform's balance whether or not Campistry had booked the
  // refund — once per refund where the camp is known (the database's notice
  // is the once-only claim).
  const alert = (what: string) => sendRiskAlertEmail(`Stripe alert: a $${amount.toFixed(2)} refund failed — pass it back to the camp`, `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#B91C1C;">A refund failed after Stripe accepted it</h2>
      <p><strong>Refund:</strong> ${refundId} (${status}${why ? ", " + why : ""})</p>
      <p><strong>Amount:</strong> $${amount.toFixed(2)}</p>
      <p><strong>Payment:</strong> ${payment || "—"}</p>
      <p><strong>Camp:</strong> ${campId || "not found — look the payment up in Stripe"}</p>
      <p>The money is back in the PLATFORM's Stripe balance; the camp's own account was debited when
      the refund was made. ${what} Transfer $${amount.toFixed(2)} back to the camp's connected account.</p>
      <p style="margin-top:20px;color:#64748B;font-size:13px;">Event: ${event.type} (${event.id})</p>
    </div>`);
  // Once per refund (TED-137): Stripe sends the same failure several times.
  // The claim is given back when the email did not go (TED-150), and the
  // delivery answered 500, so Stripe's next delivery sends it.
  const alertOnce = async (what: string) => {
    const { data: first, error: claimErr } = await supabase.rpc("claim_refund_failure_alert", { p_refund_id: refundId });
    if (claimErr) throw new Error(`refund ${refundId} failed and the platform alert could not be claimed: ${claimErr.message}`);
    if (first === false) return;
    if ((await alert(what)) === "failed") {
      await supabase.rpc("release_refund_failure_alert", { p_refund_id: refundId });
      throw new Error(`refund ${refundId} failed and the platform alert email did not send — Stripe will send the failure again`);
    }
  };
  if (!campId) {
    console.error(`[stripe-webhook] refund ${refundId} ${status} but has no camp — nothing put back; reconcile by hand`);
    await alertOnce("No camp could be found for it, so nothing was changed in Campistry.");
    return;
  }
  const { data, error } = await supabase.rpc("reverse_failed_stripe_refund", {
    p_camp_id: campId, p_refund_id: refundId, p_reason: why, p_amount: amount || null, p_payment_ref: payment || null,
    // Campistry's own canteen refund carries its reservation's key (TED-138)
    p_hold_key: (r.metadata && r.metadata.campistryHold) ? String(r.metadata.campistryHold) : null });
  // The database not answering is not an answer: 500, so Stripe sends it again.
  if (error) throw new Error(`refund ${refundId} failed at Stripe and could not be put back yet: ${error.message}`);
  if (!data?.success) {
    console.error(`[stripe-webhook] refund ${refundId} ${status} (camp ${campId}) — not on Campistry's books ` +
      `(${data?.error || "unknown"}); nothing put back`);
    await alertOnce("It was not on Campistry's books (made in the Stripe dashboard, or its answer was lost), so nothing was changed there; the camp has been told.");
    return;
  }
  // The card surcharge's share Billing took off the bill with this refund
  // goes back on it (281, TED-148): the family kept the payment. Once per
  // refund, so a repeated delivery (or one after a crash here) changes nothing.
  if (data.familyKey) {
    const undo = await supabase.rpc("undo_card_fee_return", {
      p_camp_id: campId, p_family_key: String(data.familyKey), p_refund_id: refundId });
    if (undo.error) throw new Error(`refund ${refundId}: its card-surcharge credit could not be taken back yet: ${undo.error.message}`);
    if (undo.data?.undone) console.warn(`[stripe-webhook] refund ${refundId}: $${undo.data.amount} of card surcharge back on ${data.familyKey}'s bill`);
  }
  if (!data.alreadyRecorded) console.warn(`[stripe-webhook] refund ${refundId} ${status}: $${amount} put back for camp ${campId}`);
  await alertOnce("Campistry has put it back on the family's account (or the child's canteen wallet) and told the camp.");
}

async function handleDisputeLedger(
  supabase: ReturnType<typeof createClient>,
  event: Record<string, any>,
) {
  const obj = event.data.object || {};
  const disputeId = String(obj.id || "");
  if (!disputeId) return;

  // Stripe gives the charge id and (on current API versions) the payment_intent.
  // A payment row may carry either depending on which path recorded it, so pass
  // both and let the RPC match on the set — that is what stops a dispute failing
  // to find its own payment.
  const refs = [obj.payment_intent, obj.charge, obj.id]
    .filter(Boolean).map(String);

  // An INQUIRY (warning_needs_response, warning_under_review, warning_closed)
  // is the bank asking a question: no money has moved, so nothing is posted —
  // not on a family's bill (TED-186), not on a child's wallet (TED-181). If it
  // escalates, Stripe says so with the same dispute in a money-moving status
  // (charge.dispute.updated / charge.dispute.funds_withdrawn), handled below.
  const status = String(obj.status || "");
  if (status.startsWith("warning_")) {
    console.log(`[stripe-webhook] ${event.type} ${disputeId}: an inquiry (${status}) — nothing posted`);
    return;
  }
  // Money taken: the first of created / updated / funds_withdrawn in a real
  // dispute status posts it (each writer is keyed on the dispute, so the
  // others change nothing). Closed: won puts it back; lost leaves it.
  // A decided dispute (won / lost) takes nothing more (TED-196): a late
  // "updated" carrying the outcome must not pause autopay again.
  const taking = (event.type === "charge.dispute.created" || event.type === "charge.dispute.updated"
              || event.type === "charge.dispute.funds_withdrawn") && status !== "won" && status !== "lost";
  const closed = event.type === "charge.dispute.closed";
  if (!taking && !closed) return;

  // A canteen top-up (TED-181, TED-188): off the child's wallet while the
  // bank decides; back on if the camp wins.
  const canteen = await canteenPaymentOf(obj);
  if (canteen) {
    const amount = Number(((obj.amount || 0) / 100).toFixed(2));
    await canteenDispute(supabase, canteen.campId, canteen.pi, disputeId, amount, taking ? "taking" : status === "won" ? "won" : "lost",
                         obj.reason ? String(obj.reason).replace(/_/g, " ") : null);
    return;
  }

  // Which camp? The PAYMENT's metadata carries campId on every path that takes
  // money; the dispute's own metadata is empty (TED-114), so the payment is
  // asked. Without it there is nothing to post against and guessing would put a
  // chargeback on the wrong camp's books.
  const campId = await campIdFor(obj);
  if (!campId) {
    console.error(`[stripe-webhook] dispute ${disputeId} has no campId in metadata — ` +
      `cannot post it to a ledger; reconcile by hand (refs: ${refs.join(", ")})`);
    return;
  }

  // A database error is thrown (TED-187): 500, so Stripe sends the event again
  // (every writer here is keyed on the dispute). An ANSWER — no such payment —
  // is logged: sending it again would not change it.
  if (taking) {
    const { data, error } = await supabase.rpc("record_chargeback", {
      p_camp_id: campId, p_dispute_id: disputeId, p_refs: refs,
      p_amount: Number(((obj.amount || 0) / 100).toFixed(2)),
      p_reason: obj.reason || null, p_status: obj.status || null,
    });
    if (error) throw new Error(`chargeback ${disputeId} not posted yet: ${error.message}`);
    if (!data?.success) {
      console.error(`[stripe-webhook] chargeback ${disputeId} NOT posted to the ledger ` +
        `(${data?.error || "unknown"}) — the camp's books now ` +
        `overstate collected cash until this is reconciled by hand`);
      return;
    }
    // Autopay does not charge the family again while their bank is deciding
    // (288). Won: it starts again; lost: the office decides, in Billing.
    if (data.familyKey) {
      const hold = await supabase.rpc("hold_autopay_for_dispute", {
        p_camp_id: campId, p_family_key: String(data.familyKey), p_dispute_id: disputeId, p_hold: true,
        p_detail: obj.reason ? String(obj.reason).replace(/_/g, " ") : null });
      if (hold.error) throw new Error(`chargeback ${disputeId}: autopay could not be paused yet: ${hold.error.message} — is migration 288 applied?`);
    }
  } else {
    // `won` means the camp kept the money. Anything else leaves the refund
    // standing, which is already correct.
    const won = status === "won";
    const { data, error } = await supabase.rpc("resolve_chargeback", {
      p_camp_id: campId, p_dispute_id: disputeId, p_won: won,
      p_status: obj.status || null,
    });
    if (error) throw new Error(`dispute ${disputeId} close not recorded yet: ${error.message}`);
    if (won && data?.familyKey) {
      const rel = await supabase.rpc("hold_autopay_for_dispute", {
        p_camp_id: campId, p_family_key: String(data.familyKey), p_dispute_id: disputeId, p_hold: false });
      if (rel.error) throw new Error(`dispute ${disputeId} won: autopay could not be resumed yet: ${rel.error.message}`);
    } else if (!won) {
      // Lost (TED-202): the pause stays, marked lost — the office may resume
      // once no other dispute of the family's is still open. A loss that
      // arrives before the dispute itself (TED-207) has no chargeback to find
      // yet: the family comes from the payment, and the loss is remembered.
      const famKey = data?.familyKey ? String(data.familyKey) : await familyKeyFor(obj);
      if (famKey) {
        const lost = await supabase.rpc("note_dispute_lost", {
          p_camp_id: campId, p_family_key: famKey, p_dispute_id: disputeId });
        if (lost.error) throw new Error(`dispute ${disputeId} lost: not marked yet: ${lost.error.message} — is migration 288 applied?`);
      }
    }
  }
}

async function handleRiskEvent(event: Record<string, any>) {
  const obj = event.data.object || {};
  let heading = "";
  let detailsHtml = "";

  switch (event.type) {
    case "radar.early_fraud_warning.created":
      heading = "Stripe Radar flagged a charge as likely fraud";
      detailsHtml = `
        <p><strong>Charge:</strong> ${obj.charge || "—"}</p>
        <p><strong>Fraud type:</strong> ${obj.fraud_type || "—"}</p>
        <p><strong>Actionable:</strong> ${obj.actionable ? "Yes — you can still act on this" : "No"}</p>`;
      break;
    case "review.opened":
      heading = "Stripe opened a manual review on a payment";
      detailsHtml = `
        <p><strong>Reason:</strong> ${obj.reason || "—"}</p>
        <p><strong>Payment Intent:</strong> ${obj.payment_intent || "—"}</p>
        <p><strong>Charge:</strong> ${obj.charge || "—"}</p>`;
      break;
    case "charge.dispute.created":
      heading = "A parent disputed a charge (chargeback filed)";
      detailsHtml = `
        <p><strong>Amount:</strong> $${((obj.amount || 0) / 100).toFixed(2)} ${(obj.currency || "usd").toUpperCase()}</p>
        <p><strong>Reason:</strong> ${obj.reason || "—"}</p>
        <p><strong>Charge:</strong> ${obj.charge || "—"}</p>
        <p><strong>Respond by:</strong> ${obj.evidence_details?.due_by ? new Date(obj.evidence_details.due_by * 1000).toLocaleString() : "—"}</p>`;
      break;
    case "charge.dispute.closed":
      heading = "A disputed charge was closed — " + (obj.status || "unknown outcome");
      detailsHtml = `
        <p><strong>Outcome:</strong> ${obj.status || "—"}</p>
        <p><strong>Amount:</strong> $${((obj.amount || 0) / 100).toFixed(2)} ${(obj.currency || "usd").toUpperCase()}</p>
        <p><strong>Charge:</strong> ${obj.charge || "—"}</p>
        <p>${obj.status === "won" ? "The money has been returned to the camp and posted back to the family's ledger." : "The refund posted when the dispute opened stands."}</p>`;
      break;
    case "payout.failed":
      heading = "A Stripe payout failed";
      detailsHtml = `
        <p><strong>Amount:</strong> $${((obj.amount || 0) / 100).toFixed(2)} ${(obj.currency || "usd").toUpperCase()}</p>
        <p><strong>Failure reason:</strong> ${obj.failure_message || obj.failure_code || "—"}</p>
        <p><strong>Arrival date:</strong> ${obj.arrival_date ? new Date(obj.arrival_date * 1000).toLocaleDateString() : "—"}</p>`;
      break;
    default:
      heading = `Stripe platform risk event: ${event.type}`;
      detailsHtml = `<p>See the Stripe Dashboard for details.</p>`;
  }

  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#B91C1C;">${heading}</h2>
      ${detailsHtml}
      <p style="margin-top:20px;color:#64748B;font-size:13px;">
        Event: ${event.type} (${event.id})<br/>
        This fired on Campistry's platform Stripe account — every camp's
        payments flow through it before being transferred to that camp's
        own connected account. Look this event up in the Stripe Dashboard
        (Developers &rarr; Events, search "${event.id}") for full details
        and to respond if action is needed.
      </p>
    </div>`;

  console.warn(`[stripe-webhook] RISK EVENT: ${event.type} (${event.id})`);
  await sendRiskAlertEmail(`Stripe alert: ${heading}`, html);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature") || "";
    // FAIL CLOSED (TED-057). With no secret this used to skip the check, so
    // anyone could post a fake "payment succeeded" and mark a family paid.
    // Refusing with a 500 makes Stripe retry (for up to three days), so no real
    // event is lost while the secret is being set.
    if (!STRIPE_WEBHOOK_SECRET) {
      console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing every event until it is");
      return new Response(JSON.stringify({ error: "Webhook not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const valid = await verifySignature(body, signature, STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      console.error("[stripe-webhook] Invalid or expired signature");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const event = JSON.parse(body);
    console.log(`[stripe-webhook] Event: ${event.type} (${event.id})`);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const statusFor: Record<string, "pending" | "succeeded" | "failed"> = {
      "payment_intent.processing": "pending",
      "payment_intent.succeeded": "succeeded",
      "payment_intent.payment_failed": "failed",
    };

    if (statusFor[event.type]) {
      const pi = event.data.object;
      const campId = pi.metadata?.campId;
      let neverRecorded: NeverRecorded | null = null;
      try {
      if (!campId) {
        console.log("[stripe-webhook] No campId in metadata — skipping ledger write");
      } else if (pi.metadata?.source === "campistry-canteen-deposit") {
        // Either/or with the tuition path below — never both.
        await handleCanteenDeposit(supabase, campId, pi, statusFor[event.type]);
      } else if (pi.metadata?.source === "campistry-link-photo-purchase") {
        // Either/or — never lands in campistryMe.finance.payments either.
        await handleLinkPhotoPurchase(supabase, campId, pi, statusFor[event.type]);
      } else if (pi.metadata?.source === "registration_deposit") {
        // A deposit paid from the registration form. There is no family record
        // yet — the office has not accepted anybody — so this marks the
        // APPLICATION rather than writing a ledger payment. It becomes an
        // ordinary payment when the office accepts and enrolls.
        await handleRegistrationDeposit(supabase, campId, pi, statusFor[event.type]);
      } else {
        await upsertPayment(supabase, campId, pi, statusFor[event.type]);   // throws when not recorded
        console.log(`[stripe-webhook] ledger ${statusFor[event.type]} $${(pi.amount || 0) / 100} camp ${campId}: ok`);
      }
      } catch (e) {
        if (!(e instanceof NeverRecorded)) throw e;
        neverRecorded = e;
      }
      if (neverRecorded) {
        // Told once (the claim is keyed on the payment, and given back when the
        // email did not go, so Stripe's next delivery sends it), then 200.
        const key = `unrecorded:${pi.id}:${statusFor[event.type]}`;
        const { data: first, error: claimErr } = await supabase.rpc("claim_refund_failure_alert", { p_refund_id: key });
        if (claimErr) throw new Error(`${neverRecorded.message} — and the platform could not be told (${claimErr.message})`);
        if (first !== false) {
          const amt = ((Number(pi.amount_received ?? pi.amount) || 0) / 100).toFixed(2);
          const sent = await sendRiskAlertEmail(`Stripe: a $${amt} payment could not be recorded in Campistry`, `
            <div style="font-family:sans-serif;max-width:600px;">
              <h2 style="color:#B91C1C;">A payment Campistry cannot record</h2>
              <p><strong>Payment:</strong> ${pi.id} (${statusFor[event.type]}) · <strong>Amount:</strong> $${amt}</p>
              <p><strong>Camp:</strong> ${campId || "—"} · <strong>What it was for:</strong> ${pi.metadata?.source || "a family payment"}
                 ${pi.metadata?.camperName ? " · child " + pi.metadata.camperName : ""}${pi.metadata?.camperId ? " (#" + pi.metadata.camperId + ")" : ""}
                 ${pi.metadata?.enrollmentId ? " · application " + pi.metadata.enrollmentId : ""}</p>
              <p><strong>Why:</strong> ${neverRecorded.code.replace(/_/g, " ")} — this will not change by trying again.</p>
              <p>The money was taken. Tell the camp: they record it by hand (the child's new number, or the family it belongs to),
                 or refund it in Stripe.</p>
              <p style="margin-top:20px;color:#64748B;font-size:13px;">Event: ${event.type} (${event.id})</p>
            </div>`);
          if (sent === "failed") {
            await supabase.rpc("release_refund_failure_alert", { p_refund_id: key });
            throw new Error(`${neverRecorded.message} — and the platform alert did not send; Stripe will send it again`);
          }
        }
        console.error(`[stripe-webhook] ${neverRecorded.message} — it never will be; the platform has been told`);
        return new Response(JSON.stringify({ received: true, recorded: false, reason: neverRecorded.code }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Only reached once the payment is recorded (every writer above throws
      // when it is not, TED-164), so a receipt never describes a payment
      // Campistry has no record of.
      // The receipt goes out from HERE for every Stripe charge in the product —
      // a pay link, a registration deposit, a canteen top-up, an autopay
      // instalment, a card the office charged. All of them end up as a
      // succeeded PaymentIntent with this metadata, so one call beats five, and
      // the ones that also dispatch their own (the BYOP sweeps) lose the claim
      // rather than sending a second email.
      if (campId && statusFor[event.type] === "succeeded") {
        const src = String(pi.metadata?.source || "");
        const what =
          src === "campistry-canteen-deposit" ? "Canteen funds"
          : src === "campistry-link-photo-purchase" ? "Photos"
          : src === "registration_deposit" ? "Registration deposit"
          : src === "autopay" ? "Payment plan instalment"
          : "Camp payment";
        await sendReceipt({
          campId,
          ref: String(pi.id || ""),
          amount: (Number(pi.amount_received ?? pi.amount) || 0) / 100,
          what,
          method: "Card",
          familyKey: pi.metadata?.familyKey || null,
          camperId: camperIdIn(pi.metadata?.camperId), camperName: pi.metadata?.camperName || null,
          enrollmentId: pi.metadata?.enrollmentId || null,
        });
      }
    } else if (event.type === "charge.refunded") {
      // A refund issued from the STRIPE DASHBOARD rather than from Billing —
      // which people do constantly. This event was simply not handled, so that
      // refund produced nothing here at all: no ledger entry, no payment row.
      // The family kept a credit they no longer had and the camp's payment list
      // disagreed with its own Stripe account.
      //
      // A refund made IN Campistry also lands here, echoed back by Stripe. That
      // is fine: the RPC keys the entry on the refund id, which is the same key
      // Billing's refund action writes, so whichever arrives second does
      // nothing rather than crediting the refund twice.
      await handleChargeRefunded(supabase, event);
    } else if (REFUND_FAILED_TYPES.has(event.type)) {
      await handleRefundFailed(supabase, event);
    } else if (event.type === "setup_intent.succeeded") {
      // Not a payment at all — a saved card/bank account for future autopay
      // (tuition) or auto-reload (canteen). Either/or, routed by source.
      const si = event.data.object;
      if (si.metadata?.source === "campistry-canteen-autoreload-setup") {
        await handleCanteenAutoReloadSetup(supabase, si);
      } else if (si.metadata?.source === "registration_card_capture") {
        // A card checked on a registration form, before the application
        // exists. There is no family to attach it to yet -- it goes on the
        // capture row the form is watching (migration 189).
        await handleRegistrationCardCapture(supabase, si);
      } else {
        await handleAutopaySetup(supabase, si);
      }
    } else if (event.type === "charge.dispute.updated" || event.type === "charge.dispute.funds_withdrawn") {
      // An inquiry that escalated, or the money actually leaving (TED-186/188):
      // posted once, keyed on the dispute; no second platform email.
      await handleDisputeLedger(supabase, event);
    } else if (RISK_EVENT_TYPES.has(event.type)) {
      // A dispute also moves real money out of the CAMP's account, so it needs a
      // ledger entry as well as the platform alert. Ledger first: if the email
      // provider is down, the money must still be right.
      if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
        await handleDisputeLedger(supabase, event);
      }
      // Platform-account risk signal — alerts the operator, not any camp.
      await handleRiskEvent(event);
    } else {
      console.log(`[stripe-webhook] Unhandled event: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-webhook] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
