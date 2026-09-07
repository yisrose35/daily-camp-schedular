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

  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await supabase.from("camp_state_kv").select("value")
      .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
    const me: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object")
      ? cur.data.value : {};
    if (!me.finance) me.finance = {};
    if (!Array.isArray(me.finance.payments)) me.finance.payments = [];
    const pays: Record<string, any>[] = me.finance.payments;

    const existing = pays.find((p) => p.stripePaymentIntentId === pi.id);
    if (existing) {
      existing.status = status;
      existing.amount = amount;
      existing.method = methodLabel(type);
      if (errorMsg) existing.notes = "Online payment failed — " + errorMsg;
    } else {
      pays.push({
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
      });
    }

    const up = await supabase.from("camp_state_kv").upsert(
      { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
      { onConflict: "camp_id,key" },
    );
    if (!up.error) return true;
    console.warn(`[stripe-webhook] upsert attempt ${attempt} failed: ${up.error.message}`);
  }
  return false;
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
  const camperName = meta.camperName;
  if (!camperName) {
    console.error(`[stripe-webhook] canteen deposit ${pi.id} has no camperName in metadata — skipping`);
    return;
  }
  const { data, error } = await supabase.rpc("credit_canteen_balance_from_stripe", {
    p_camp_id: campId,
    p_camper_name: camperName,
    p_amount: (pi.amount || 0) / 100,
    p_payment_intent_id: pi.id,
  });
  console.log(`[stripe-webhook] canteen deposit $${(pi.amount || 0) / 100} for ${camperName} (camp ${campId}): ${error ? "FAILED " + error.message : JSON.stringify(data)}`);
}

// Same "only 'succeeded' counts" rule as canteen deposits above — a parent
// shouldn't see their photo matching/download unlock before Stripe confirms
// the charge is final. record_link_photo_purchase (migration 081, widened
// in 082) is idempotent per (payment_intent, kind, camper/photo), so a
// webhook retry — or this loop re-running mid-way through a batch — is safe.
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
    let names: string[] = [];
    try { names = JSON.parse(meta.camperNames || "[]"); } catch { names = []; }
    if (!Array.isArray(names) || !names.length) {
      console.error(`[stripe-webhook] link photo purchase ${pi.id} missing camperNames in metadata — skipping`);
      return;
    }
    for (const name of names) {
      const { data, error } = await supabase.rpc("record_link_photo_purchase", {
        p_camp_id: campId,
        p_parent_user_id: meta.parentUserId,
        p_kind: "facial_recognition",
        p_camper_name: name,
        p_photo_id: null,
        p_amount_cents: FACIAL_RECOGNITION_FEE_CENTS, // per-camper share, NOT pi.amount (that's the whole batch)
        p_payment_intent_id: pi.id,
      });
      console.log(`[stripe-webhook] link photo purchase (facial_recognition) for ${name}, camp ${campId}: ${error ? "FAILED " + error.message : JSON.stringify(data)}`);
    }
    return;
  }

  const { data, error } = await supabase.rpc("record_link_photo_purchase", {
    p_camp_id: campId,
    p_parent_user_id: meta.parentUserId,
    p_kind: meta.kind,
    p_camper_name: null,
    p_photo_id: meta.photoId || null,
    p_amount_cents: pi.amount || 0,
    p_payment_intent_id: pi.id,
  });
  console.log(`[stripe-webhook] link photo purchase (${meta.kind}) $${(pi.amount || 0) / 100} camp ${campId}: ${error ? "FAILED " + error.message : JSON.stringify(data)}`);
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

  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await supabase.from("camp_state_kv").select("value")
      .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
    const me: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object")
      ? cur.data.value : {};
    if (!me.families || typeof me.families !== "object") me.families = {};
    const f = me.families[familyKey];
    if (!f) {
      console.error(`[stripe-webhook] autopay setup ${si.id}: family ${familyKey} no longer exists in camp ${campId} — skipping`);
      return;
    }

    f.stripeCustomerId = customerId;
    f.stripePaymentMethodId = paymentMethodId;
    f.cardOnFile = true;
    f.paymentMethodType = pmType;
    if (pmLabel) f.paymentMethodLabel = pmLabel;
    f.cardSavedDate = new Date().toISOString();

    const up = await supabase.from("camp_state_kv").upsert(
      { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
      { onConflict: "camp_id,key" },
    );
    if (!up.error) {
      console.log(`[stripe-webhook] autopay setup complete for family ${familyKey}, camp ${campId} (${pmType})`);
      // Owner-facing feed notification — mirrors check-notes-reminders' insert
      // shape (migration 056). This is the only signal an owner previously
      // had that a parent finished setting up a payment plan on their end;
      // idempotent on (camp_id, source, source_id=si.id) so a webhook retry
      // never double-notifies.
      const { error: notifErr } = await supabase.from("notifications").upsert({
        camp_id: campId,
        source: "autopay_setup",
        source_id: si.id,
        title: "Payment plan set up",
        body: `${f.name || familyKey} saved a ${pmType === "us_bank_account" ? "bank account" : "card"} for autopay${pmLabel ? " (" + pmLabel + ")" : ""}.`,
        link_target: "campistry_me.html",
      }, { onConflict: "camp_id,source,source_id", ignoreDuplicates: true });
      if (notifErr) console.warn(`[stripe-webhook] autopay setup notification insert failed: ${notifErr.message}`);
      return;
    }
    console.warn(`[stripe-webhook] autopay setup upsert attempt ${attempt} failed: ${up.error.message}`);
  }
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
  const camperName = meta.camperName;
  if (!campId || !camperName) {
    console.error(`[stripe-webhook] canteen auto-reload setup ${si.id} missing campId/camperName in metadata — skipping`);
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

  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await supabase.from("camp_state_kv").select("value")
      .eq("camp_id", campId).eq("key", "campistrySnacks").maybeSingle();
    const snacks: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object")
      ? cur.data.value : { accounts: {}, transactions: [] };
    if (!snacks.accounts || typeof snacks.accounts !== "object") snacks.accounts = {};
    const acct = snacks.accounts[camperName] || (snacks.accounts[camperName] = { balance: 0, dailyLimit: 10, spentToday: 0 });
    const ar = acct.autoReload || (acct.autoReload = {});

    ar.stripeCustomerId = customerId;
    ar.stripePaymentMethodId = paymentMethodId;
    ar.cardOnFile = true;
    ar.paymentMethodType = pmType;
    if (pmLabel) ar.paymentMethodLabel = pmLabel;
    ar.cardSavedDate = new Date().toISOString();

    const up = await supabase.from("camp_state_kv").upsert(
      { camp_id: campId, key: "campistrySnacks", value: snacks, updated_at: new Date().toISOString() },
      { onConflict: "camp_id,key" },
    );
    if (!up.error) {
      console.log(`[stripe-webhook] canteen auto-reload setup complete for ${camperName}, camp ${campId} (${pmType})`);
      return;
    }
    console.warn(`[stripe-webhook] canteen auto-reload setup upsert attempt ${attempt} failed: ${up.error.message}`);
  }
}

// Best-effort — a failed alert email must never fail the webhook response
// (Stripe retries on non-2xx, and we don't want risk-event handling to
// become a source of duplicate/stuck webhook deliveries).
async function sendRiskAlertEmail(subject: string, html: string) {
  if (!RESEND_API_KEY) {
    console.error(`[stripe-webhook] RESEND_API_KEY not configured — cannot send risk alert: ${subject}`);
    return;
  }
  try {
    const { error } = await resend.emails.send({
      from: "Campistry Platform Alerts <onboarding@resend.dev>",
      to: [RISK_ALERT_EMAIL],
      subject,
      html,
    });
    if (error) console.error(`[stripe-webhook] risk alert email failed: ${JSON.stringify(error)}`);
    else console.log(`[stripe-webhook] risk alert email sent: ${subject}`);
  } catch (e) {
    console.error(`[stripe-webhook] risk alert email threw: ${(e as Error).message}`);
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
  "payout.failed",
]);

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
    if (STRIPE_WEBHOOK_SECRET) {
      const valid = await verifySignature(body, signature, STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        console.error("[stripe-webhook] Invalid signature");
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
      if (!campId) {
        console.log("[stripe-webhook] No campId in metadata — skipping ledger write");
      } else if (pi.metadata?.source === "campistry-canteen-deposit") {
        // Either/or with the tuition path below — never both.
        await handleCanteenDeposit(supabase, campId, pi, statusFor[event.type]);
      } else if (pi.metadata?.source === "campistry-link-photo-purchase") {
        // Either/or — never lands in campistryMe.finance.payments either.
        await handleLinkPhotoPurchase(supabase, campId, pi, statusFor[event.type]);
      } else {
        const ok = await upsertPayment(supabase, campId, pi, statusFor[event.type]);
        console.log(`[stripe-webhook] ledger ${statusFor[event.type]} $${(pi.amount || 0) / 100} camp ${campId}: ${ok ? "ok" : "FAILED"}`);
      }
    } else if (event.type === "setup_intent.succeeded") {
      // Not a payment at all — a saved card/bank account for future autopay
      // (tuition) or auto-reload (canteen). Either/or, routed by source.
      const si = event.data.object;
      if (si.metadata?.source === "campistry-canteen-autoreload-setup") {
        await handleCanteenAutoReloadSetup(supabase, si);
      } else {
        await handleAutopaySetup(supabase, si);
      }
    } else if (RISK_EVENT_TYPES.has(event.type)) {
      // Platform-account risk signal — alert the operator, not any camp.
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
