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
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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
