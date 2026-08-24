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
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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
