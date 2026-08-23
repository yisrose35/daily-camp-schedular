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
//                                 onto link_staff_accounts OR camps (durable
//                                 source of truth; stripe-connect-status/
//                                 stripe-connect-status-camp are just the
//                                 synchronous "check now" right after redirect).
//                                 The SAME "Connected accounts" endpoint fires
//                                 this for every connected account under the
//                                 platform — staff Express accounts AND camp
//                                 Express accounts alike — so no separate
//                                 registration is needed for camps; only the
//                                 handler below needed to learn to also look
//                                 there. Dispatched by metadata.staffAccountId
//                                 when present (staff, existing behavior), else
//                                 by a direct camps.stripe_account_id lookup
//                                 (camps deliberately don't set that metadata
//                                 key — see stripe-connect-onboard-camp).
//   - payment_intent.succeeded → the money-lands moment for a tip charge.
//                                 Two shapes, both gated on metadata.source
//                                 so neither can ever collide with the
//                                 billing webhook's own succeeded handling:
//                                 - "campistry-link-tip" (stripe-connect-tip,
//                                   single recipient, a destination charge —
//                                   money already routed to the connected
//                                   account as part of the charge itself).
//                                 - "campistry-link-tip-cart"
//                                   (stripe-connect-tip-cart, N recipients,
//                                   NO destination on the charge — the full
//                                   amount landed in the PLATFORM's own
//                                   balance, so this handler creates one
//                                   Stripe Transfer per recipient from
//                                   link_tip_cart_items, migration 059).
//                                 Either way, each recipient gets exactly
//                                 one link_tips row + a credit to
//                                 link_staff_accounts.total_earned, written
//                                 directly with the service-role client —
//                                 NOT via submit_link_tip(), which requires
//                                 auth.uid() and can't be called from a
//                                 webhook. balance/total_paid_out are
//                                 deliberately left untouched: for a
//                                 Stripe-paid tip the money already reached
//                                 the staff member's own bank (via the
//                                 destination charge, or via the Transfer
//                                 this handler creates), so crediting
//                                 balance here (like submit_link_tip's
//                                 ledger-only upsert does) would let an
//                                 admin later double-pay them via
//                                 record_staff_payout().
//   - payment_intent.payment_failed → logged only; nothing was written on
//                                 success, so there's nothing to roll back.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_CONNECT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET");
const STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Only used by the cart fan-out (handleTipCartSucceeded) — the
// single-recipient flow never calls the Stripe API from this function at
// all, since a destination charge already moves the money by itself.
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
  // Both staff and camp connected accounts only ever request the
  // `transfers` capability (never card_payments), so Stripe's charges_enabled
  // flag — which tracks whether the account can create its OWN charges — may
  // never turn true even once onboarding is fully complete. payouts_enabled
  // is what actually indicates the account has satisfied its requirements
  // and is ready to receive money; check either.
  const chargesEnabled = !!(account.charges_enabled || account.payouts_enabled);
  const onboardingStatus = chargesEnabled ? "complete" : "pending";

  const staffAccountId = account.metadata?.staffAccountId;
  if (staffAccountId) {
    const { data: existing } = await supabase
      .from("link_staff_accounts")
      .select("stripe_connected_at")
      .eq("id", staffAccountId)
      .maybeSingle();

    const update: Record<string, unknown> = {
      stripe_charges_enabled: chargesEnabled,
      stripe_onboarding_status: onboardingStatus,
      updated_at: new Date().toISOString(),
    };
    if (chargesEnabled && !existing?.stripe_connected_at) {
      update.stripe_connected_at = new Date().toISOString();
    }
    const { error } = await supabase.from("link_staff_accounts").update(update).eq("id", staffAccountId);
    console.log(`[stripe-connect-webhook] account.updated ${account.id} (staff) charges_enabled=${chargesEnabled}: ${error ? "FAILED " + error.message : "ok"}`);
    return;
  }

  // Not a staff account (no staffAccountId metadata) — try camps, matched
  // by the unique idx_camps_stripe_account index instead of metadata, since
  // stripe-connect-onboard-camp deliberately doesn't set a metadata key that
  // would need to be kept in sync with this handler forever.
  const { data: camp } = await supabase
    .from("camps")
    .select("id, stripe_connected_at")
    .eq("stripe_account_id", account.id)
    .maybeSingle();
  if (camp) {
    const update: Record<string, unknown> = {
      stripe_charges_enabled: chargesEnabled,
      stripe_onboarding_status: onboardingStatus,
    };
    if (chargesEnabled && !camp.stripe_connected_at) {
      update.stripe_connected_at = new Date().toISOString();
    }
    const { error } = await supabase.from("camps").update(update).eq("id", camp.id);
    console.log(`[stripe-connect-webhook] account.updated ${account.id} (camp) charges_enabled=${chargesEnabled}: ${error ? "FAILED " + error.message : "ok"}`);
    return;
  }

  console.log(`[stripe-connect-webhook] account.updated ${account.id} — no matching staff or camp row`);
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
    staff_account_id: meta.staffAccountId || null,
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

// Cart flow (stripe-connect-tip-cart, migration 059): this PaymentIntent has
// NO transfer_data.destination — the full charge landed in the platform's
// own Stripe balance, so getting money to each recipient is this function's
// job, not Stripe's. Fans out into one Transfer + one link_tips row per
// still-unprocessed line in link_tip_cart_items.
async function handleTipCartSucceeded(supabase: ReturnType<typeof createClient>, pi: Record<string, any>) {
  const meta = pi.metadata || {};
  const cartId = meta.cartId;
  if (!cartId) {
    console.error(`[stripe-connect-webhook] cart tip ${pi.id} has no cartId in metadata — skipping`);
    return;
  }

  // Only rows this cart hasn't finished paying out yet — see the
  // migration's comment on why processed_at (not an event-level flag) is
  // what makes a retried delivery safe: a partial failure part-way through
  // a cart just picks up where it left off, it can't double-pay anyone
  // already marked processed.
  const { data: items, error: selErr } = await supabase
    .from("link_tip_cart_items")
    .select("*")
    .eq("cart_id", cartId)
    .is("processed_at", null);
  if (selErr) {
    console.error(`[stripe-connect-webhook] cart ${cartId} lookup failed:`, selErr.message);
    return;
  }
  if (!items || !items.length) {
    console.log(`[stripe-connect-webhook] cart ${cartId}: nothing left to process`);
    return;
  }

  const chargeId = pi.latest_charge || null;

  for (const item of items) {
    try {
      // The REAL idempotency check — link_tips' (stripe_payment_intent_id,
      // staff_account_id) unique index is the source of truth, not
      // processed_at. If a prior run already created the Transfer and
      // inserted this row but was killed before it could mark processed_at,
      // a retry must catch up the bookkeeping WITHOUT creating a second
      // Transfer (which would double-pay this recipient).
      const { data: already } = await supabase
        .from("link_tips")
        .select("id, stripe_transfer_id")
        .eq("stripe_payment_intent_id", pi.id)
        .eq("staff_account_id", item.staff_account_id)
        .maybeSingle();
      if (already) {
        await supabase.from("link_tip_cart_items")
          .update({ processed_at: new Date().toISOString(), stripe_transfer_id: already.stripe_transfer_id, transfer_error: null })
          .eq("id", item.id);
        console.log(`[stripe-connect-webhook] cart ${cartId} item ${item.id}: already recorded, caught up bookkeeping only`);
        continue;
      }

      const transfer = await stripePost("/transfers", {
        amount: String(item.tip_cents),
        currency: "usd",
        destination: item.stripe_account_id,
        ...(chargeId ? { source_transaction: String(chargeId) } : {}),
        "transfer_group": `cart_${cartId}`,
        "metadata[cartId]": cartId,
        "metadata[cartItemId]": item.id,
      });
      if (transfer.error) throw new Error(transfer.error.message);

      const tipAmount = item.tip_cents / 100;
      const { error: insErr } = await supabase.from("link_tips").insert({
        camp_id: item.camp_id,
        user_id: item.parent_user_id,
        camper_name: item.camper_name,
        parent_name: item.parent_name,
        parent_email: item.parent_email,
        recipient_name: item.staff_name,
        recipient_role: item.staff_role,
        staff_account_id: item.staff_account_id,
        amount: tipAmount,
        payment_method: "stripe_connect",
        stripe_payment_intent_id: pi.id,
        stripe_transfer_id: transfer.id,
        fee_amount: item.fee_cents / 100,
      });
      if (insErr) throw new Error(`link_tips insert: ${insErr.message}`);

      const { data: acct } = await supabase
        .from("link_staff_accounts")
        .select("total_earned")
        .eq("id", item.staff_account_id)
        .maybeSingle();
      await supabase
        .from("link_staff_accounts")
        .update({ total_earned: (Number(acct?.total_earned) || 0) + tipAmount, updated_at: new Date().toISOString() })
        .eq("id", item.staff_account_id);

      await supabase
        .from("link_tip_cart_items")
        .update({ processed_at: new Date().toISOString(), stripe_transfer_id: transfer.id, transfer_error: null })
        .eq("id", item.id);

      console.log(`[stripe-connect-webhook] cart ${cartId} item ${item.id}: $${tipAmount} transferred to ${item.staff_name} (${transfer.id})`);
    } catch (err) {
      console.error(`[stripe-connect-webhook] cart ${cartId} item ${item.id} FAILED:`, err.message);
      // Deliberately continue to the next recipient — one failed transfer
      // (a since-disconnected account, a Stripe hiccup) must never block
      // the rest of the cart from paying out. transfer_error is left for
      // manual follow-up; processed_at stays null so a future retry
      // (Stripe's own delivery retries, or a manual resend) picks it up.
      await supabase.from("link_tip_cart_items")
        .update({ transfer_error: err.message })
        .eq("id", item.id);
    }
  }
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
      const meta = event.data.object.metadata || {};
      if (meta.source === "campistry-link-tip-cart") {
        await handleTipCartSucceeded(supabase, event.data.object);
      } else {
        await handleTipSucceeded(supabase, event.data.object); // no-ops itself if source isn't "campistry-link-tip"
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const meta = event.data.object.metadata || {};
      if (meta.source === "campistry-link-tip") {
        console.log(`[stripe-connect-webhook] tip payment failed for ${meta.staffName}: ${event.data.object.last_payment_error?.message || "unknown"}`);
      } else if (meta.source === "campistry-link-tip-cart") {
        console.log(`[stripe-connect-webhook] cart tip payment failed for cart ${meta.cartId}: ${event.data.object.last_payment_error?.message || "unknown"}`);
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
