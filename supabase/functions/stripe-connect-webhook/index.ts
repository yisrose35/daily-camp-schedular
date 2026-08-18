// =============================================================================
// stripe-connect-webhook — Lands Connect-tip money in Campistry Link's ledger
//
// Kept as its OWN function with its OWN webhook secret(s), separate from
// stripe-webhook (which is scoped to the billing ledger only, per its own
// header comment) — so this feature's event handling can evolve without
// touching that function's signature-verification/idempotency logic.
//
// Must be registered TWICE in the Stripe Dashboard, as two separate
// endpoints pointing at this same URL, because the two event types this
// function cares about live on two different accounts:
//   - account.updated fires on the CONNECTED account (the staff member's
//     Express account) → register with "Listen to events on: Connected
//     accounts".
//   - payment_intent.succeeded / payment_intent.payment_failed fire on the
//     PLATFORM account, because stripe-connect-tip creates the Checkout
//     Session (and therefore the PaymentIntent) on the platform account and
//     merely routes the money via transfer_data.destination (a destination
//     charge) — the PI itself never becomes an object on the connected
//     account. → register with "Listen to events on: Your account" (the
//     default). A single "Connected accounts" endpoint will silently never
//     receive payment_intent.succeeded — that was a real bug here: money
//     charged, nothing recorded, because only the Connected-accounts
//     endpoint was ever registered.
// Each endpoint gets its OWN signing secret from Stripe — set both:
//   STRIPE_CONNECT_WEBHOOK_SECRET           (the "Your account" endpoint)
//   STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET   (the "Connected accounts" endpoint)
// verifySignature is tried against both; either match is accepted.
//
// Events handled:
//   - account.updated          → sync stripe_charges_enabled/onboarding_status
//                                 onto link_staff_accounts (durable source of
//                                 truth; stripe-connect-status is just the
//                                 synchronous "check now" right after redirect)
//   - payment_intent.succeeded → the money-lands moment for a tip charge
//                                 (filtered to metadata.source ===
//                                 "campistry-link-tip" so it can never
//                                 collide with the billing webhook's own
//                                 succeeded handling). Writes link_tips +
//                                 credits link_staff_accounts.total_earned
//                                 directly with the service-role client —
//                                 NOT via submit_link_tip(), which requires
//                                 auth.uid() and can't be called from a
//                                 webhook. balance/total_paid_out are
//                                 deliberately left untouched: for a
//                                 Stripe-paid tip the money already reached
//                                 the staff member's own bank via the
//                                 destination charge, so crediting balance
//                                 here (like submit_link_tip's ledger-only
//                                 upsert does) would let an admin later
//                                 double-pay them via record_staff_payout().
//   - payment_intent.payment_failed → logged only; nothing was written on
//                                 success, so there's nothing to roll back.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_CONNECT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET");
const STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

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

async function handleAccountUpdated(supabase: ReturnType<typeof createClient>, account: Record<string, any>) {
  const staffAccountId = account.metadata?.staffAccountId;
  if (!staffAccountId) {
    console.log("[stripe-connect-webhook] account.updated with no staffAccountId metadata — skipping");
    return;
  }
  const chargesEnabled = !!account.charges_enabled;
  const { data: existing } = await supabase
    .from("link_staff_accounts")
    .select("stripe_connected_at")
    .eq("id", staffAccountId)
    .maybeSingle();

  const update: Record<string, unknown> = {
    stripe_charges_enabled: chargesEnabled,
    stripe_onboarding_status: chargesEnabled ? "complete" : "pending",
    updated_at: new Date().toISOString(),
  };
  if (chargesEnabled && !existing?.stripe_connected_at) {
    update.stripe_connected_at = new Date().toISOString();
  }
  const { error } = await supabase.from("link_staff_accounts").update(update).eq("id", staffAccountId);
  console.log(`[stripe-connect-webhook] account.updated ${account.id} charges_enabled=${chargesEnabled}: ${error ? "FAILED " + error.message : "ok"}`);
}

async function handleTipSucceeded(supabase: ReturnType<typeof createClient>, pi: Record<string, any>) {
  const meta = pi.metadata || {};
  if (meta.source !== "campistry-link-tip") return; // not ours — leave it to stripe-webhook

  // Idempotency: a retried/duplicate delivery of the same event must never
  // double-credit a staff member.
  const { data: existing } = await supabase
    .from("link_tips")
    .select("id")
    .eq("stripe_payment_intent_id", pi.id)
    .maybeSingle();
  if (existing) {
    console.log(`[stripe-connect-webhook] payment_intent ${pi.id} already recorded — skipping`);
    return;
  }

  const tipAmount = Number(meta.tipCents || 0) / 100;
  const feeAmount = Number(meta.feeCents || 0) / 100;

  const { error: insErr } = await supabase.from("link_tips").insert({
    camp_id: meta.campId,
    user_id: meta.parentUserId || null,
    camper_name: meta.camperName || null,
    parent_name: meta.parentName || null,
    parent_email: meta.parentEmail || null,
    recipient_name: meta.staffName || "",
    recipient_role: meta.staffRole || "",
    amount: tipAmount,
    payment_method: "stripe_connect",
    stripe_payment_intent_id: pi.id,
    fee_amount: feeAmount,
  });
  if (insErr) {
    console.error(`[stripe-connect-webhook] link_tips insert failed for ${pi.id}:`, insErr.message);
    return;
  }

  // total_earned only — see header note on why balance/total_paid_out stay untouched.
  const { data: acct } = await supabase
    .from("link_staff_accounts")
    .select("total_earned")
    .eq("id", meta.staffAccountId)
    .maybeSingle();
  const { error: updErr } = await supabase
    .from("link_staff_accounts")
    .update({ total_earned: (Number(acct?.total_earned) || 0) + tipAmount, updated_at: new Date().toISOString() })
    .eq("id", meta.staffAccountId);

  console.log(`[stripe-connect-webhook] tip recorded: $${tipAmount} for ${meta.staffName} (camp ${meta.campId}): ${updErr ? "FAILED " + updErr.message : "ok"}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature") || "";
    // Two endpoints (see header note) can deliver here, each signed with its
    // own secret — accept either. If neither secret is configured at all,
    // skip verification (matches this function's original permissive
    // behavior rather than hard-failing on an incomplete deploy).
    const secrets = [STRIPE_CONNECT_WEBHOOK_SECRET, STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET].filter(Boolean) as string[];
    if (secrets.length > 0) {
      let valid = false;
      for (const secret of secrets) {
        if (await verifySignature(body, signature, secret)) { valid = true; break; }
      }
      if (!valid) {
        console.error("[stripe-connect-webhook] Invalid signature");
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const event = JSON.parse(body);
    console.log(`[stripe-connect-webhook] Event: ${event.type} (${event.id})`);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (event.type === "account.updated") {
      await handleAccountUpdated(supabase, event.data.object);
    } else if (event.type === "payment_intent.succeeded") {
      await handleTipSucceeded(supabase, event.data.object);
    } else if (event.type === "payment_intent.payment_failed") {
      const meta = event.data.object.metadata || {};
      if (meta.source === "campistry-link-tip") {
        console.log(`[stripe-connect-webhook] tip payment failed for ${meta.staffName}: ${event.data.object.last_payment_error?.message || "unknown"}`);
      }
    } else {
      console.log(`[stripe-connect-webhook] Unhandled event: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-connect-webhook] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
