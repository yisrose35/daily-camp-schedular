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
//   - account.updated and payout.failed fire on the CONNECTED account (a staff
//     member's Express account, or a CAMP's own Connect account) → register
//     with "Listen to events on: Connected accounts". payout.failed must be
//     ticked on that endpoint or a camp whose bank details are wrong gets no
//     warning here at all — see the payout.failed branch below.
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
//   - charge.refunded / charge.dispute.created / charge.dispute.updated /
//     charge.dispute.closed (the "Your account" endpoint — tick them there)
//                               → a tip the parent got back (TED-176). The
//                                 refund or chargeback is paid from the
//                                 PLATFORM's balance, while the tip itself sits
//                                 in the staff member's Stripe account. So:
//                                 the tip's share is taken back from that
//                                 account (a transfer reversal), the tip is
//                                 marked and comes off the staff member's
//                                 total (migration 285), and the platform is
//                                 emailed once per new state with what is left
//                                 to do by hand (TIPPING_SETUP.md). A payment
//                                 that is not a tip is left to stripe-webhook.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_CONNECT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET");
const STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// The platform's own address — the same one stripe-webhook's risk alerts go to.
const PLATFORM_ALERT_EMAIL = "campistryoffice@gmail.com";

// Only used by the cart fan-out (handleTipCartSucceeded) — the
// single-recipient flow never calls the Stripe API from this function at
// all, since a destination charge already moves the money by itself.
// idempotencyKey matters a lot here: without it, a Stripe webhook retry (or
// two overlapping invocations of the same event) racing past the DB-level
// "already recorded?" check below — both reading "not yet" before either
// has written its link_tips row — would each independently POST /transfers
// and Stripe would execute BOTH as real, separate payouts. With a stable
// key, Stripe recognizes the retry and returns the original Transfer
// instead of creating a second one.
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
  return resp.json();
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { headers: { "Authorization": `Bearer ${STRIPE_SECRET}` } });
  return resp.json();
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

// Stripe's own recommended tolerance for webhook signature freshness — a
// signature is cryptographically valid forever once computed, so without
// this, a captured/leaked past payload+signature (a log, a misconfigured
// proxy, a webhook-testing tool run against production) stays replayable
// indefinitely. DB-level idempotency (link_tips' unique index) still stops
// a replay from re-crediting money, but this is a cheap first line of
// defense that matches Stripe's documented verification guidance.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

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
    // The id the checkout carried decides who the tip is from; without one the
    // table's own trigger stamps it from the name (223).
    person_id: camperIdIn(meta.camperId), camper_name: meta.camperName || null,
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

  // total_earned only — see header note on why balance/total_paid_out stay
  // untouched. Atomic single-statement increment (migration 078) — a plain
  // SELECT-then-UPDATE here could lose an increment if two tips land on the
  // same staff member close together.
  const { error: updErr } = await supabase.rpc("increment_staff_total_earned", {
    p_account_id: meta.staffAccountId,
    p_amount: tipAmount,
  });

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

  // The parent's payment on every line of the cart (migration 270), so a
  // nightly retry of a failed transfer records its tip against the same
  // payment — and a redelivery of this event then sees it (TED-087).
  // Best-effort: before 270 the column is not there, and nothing else changes.
  {
    const { error: piErr } = await supabase.from("link_tip_cart_items")
      .update({ stripe_payment_intent_id: pi.id })
      .eq("cart_id", cartId).is("stripe_payment_intent_id", null);
    if (piErr) console.warn(`[stripe-connect-webhook] cart ${cartId}: could not note the payment on its lines (${piErr.message}) — is migration 270 applied?`);
  }

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

      // Same dimension as the DB-level idempotency check just above
      // (stripe_payment_intent_id, staff_account_id) — a retried delivery
      // of this exact event for this exact recipient reuses this same key,
      // so Stripe itself refuses to create a second Transfer even if two
      // invocations both raced past the "already recorded?" check.
      const transfer = await stripePost("/transfers", {
        amount: String(item.tip_cents),
        currency: "usd",
        destination: item.stripe_account_id,
        ...(chargeId ? { source_transaction: String(chargeId) } : {}),
        "transfer_group": `cart_${cartId}`,
        "metadata[cartId]": cartId,
        "metadata[cartItemId]": item.id,
      }, `tipcart_${pi.id}_${item.staff_account_id}`);
      if (transfer.error) throw new Error(transfer.error.message);

      const tipAmount = item.tip_cents / 100;
      const { error: insErr } = await supabase.from("link_tips").insert({
        camp_id: item.camp_id,
        user_id: item.parent_user_id,
        person_id: item.person_id ?? null, camper_name: item.camper_name,
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

      // Atomic increment (migration 078) — same lost-update risk as the
      // single-recipient path, across every item in this cart's loop.
      await supabase.rpc("increment_staff_total_earned", {
        p_account_id: item.staff_account_id,
        p_amount: tipAmount,
      });

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
      // Recording the reason was never the problem — nothing READ it. The
      // comment above says a retry picks it up "Stripe's own delivery retries,
      // or a manual resend", and neither existed: this handler returns 200, so
      // Stripe considers the event delivered and never retries, and there was
      // no resend anywhere in the app. So: raise it with the camp, whose staff
      // member is the one unpaid, and leave it in the queue that
      // charge-due-installments now drains nightly (migration 182).
      const { error: recErr } = await supabase.rpc("record_tip_transfer_failure", {
        p_item_id: item.id, p_error: err.message,
      });
      if (recErr) {
        // Fall back to the bare write so the reason is at least stored.
        console.error(`[stripe-connect-webhook] could not raise the failed tip for item ` +
          `${item.id}: ${recErr.message}`);
        await supabase.from("link_tip_cart_items")
          .update({ transfer_error: err.message })
          .eq("id", item.id);
      }
    }
  }
}


// ── A tip the parent got back: refunded, or disputed (TED-176) ─────────────
async function sendPlatformAlert(subject: string, html: string): Promise<"sent" | "failed" | "not_configured"> {
  if (!RESEND_API_KEY) {
    console.error(`[stripe-connect-webhook] RESEND_API_KEY not configured — cannot send: ${subject}`);
    return "not_configured";
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Campistry Platform Alerts <onboarding@resend.dev>", to: [PLATFORM_ALERT_EMAIL], subject, html }),
    });
    if (!resp.ok) { console.error(`[stripe-connect-webhook] alert email failed: ${resp.status}`); return "failed"; }
    return "sent";
  } catch (e) {
    console.error(`[stripe-connect-webhook] alert email threw: ${(e as Error).message}`);
    return "failed";
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function handleTipReversal(supabase: ReturnType<typeof createClient>, event: Record<string, any>) {
  const obj = event.data.object || {};
  const isDispute = String(event.type).startsWith("charge.dispute.");
  const chargeId = String((isDispute ? obj.charge : obj.id) || "");
  let piId = String(obj.payment_intent || "");
  // The charge: its amount, what was refunded, and (for a single tip) the
  // transfer that sent the tip on. A dispute carries only the charge's id.
  let charge: Record<string, any> | null = isDispute ? null : obj;
  if (!charge || charge.amount == null || !piId) {
    if (!chargeId) return;
    charge = await stripeGet(`/charges/${encodeURIComponent(chargeId)}`);
    if (!charge || charge.error) throw new Error(`could not read charge ${chargeId} from Stripe`);  // retried
    piId = piId || String(charge.payment_intent || "");
  }
  if (!piId) return;

  // Our tips on this payment. None: not a tip — stripe-webhook handles it.
  const { data: tips, error: tipErr } = await supabase.from("link_tips")
    .select("id, amount, staff_account_id, stripe_transfer_id, recipient_name, camp_id")
    .eq("stripe_payment_intent_id", piId);
  if (tipErr) throw new Error(`link_tips lookup failed: ${tipErr.message}`);   // retried
  if (!tips || !tips.length) return;

  const chargeCents = Number(charge.amount) || 0;
  const refundedCents = Number(charge.amount_refunded) || 0;
  // open while the bank decides; won/lost once it has (a closed inquiry cost
  // nothing, like a win)
  const disputeStatus = !isDispute ? null
    : event.type === "charge.dispute.closed" ? (String(obj.status) === "lost" ? "lost" : "won")
    : "open";

  for (const tip of tips) {
    const tipCents = Math.round(Number(tip.amount) * 100);
    // this tip's share of what the parent got back
    const refundCents = chargeCents > 0 ? Math.min(tipCents, Math.round(refundedCents * tipCents / chargeCents)) : 0;
    // the tip's own transfer (a cart), else the charge's (a destination charge)
    const transferId = tip.stripe_transfer_id || (tips.length === 1 ? (charge.transfer || null) : null);
    let clawedCents: number | null = null;
    let note = "";
    if (transferId) {
      const tr = await stripeGet(`/transfers/${encodeURIComponent(String(transferId))}`);
      if (!tr || tr.error) {
        note = `Could not read transfer ${transferId} from Stripe — take the tip back by hand.`;
      } else {
        const reversed = Number(tr.amount_reversed) || 0;
        // What to take back now: the refunded share, or the whole tip while
        // the parent's bank has the money (a dispute is paid from the
        // platform's balance at once). A won dispute takes nothing more.
        const { data: prev } = await supabase.from("link_tips").select("dispute_status").eq("id", tip.id).maybeSingle();
        const dispNow = disputeStatus || prev?.dispute_status || null;
        const want = Math.min(Number(tr.amount) || tipCents,
          Math.max(refundCents, dispNow === "open" || dispNow === "lost" ? tipCents : 0));
        if (want > reversed) {
          // The same key for the same target: a repeated delivery, or two at
          // once, reverse once.
          const rev = await stripePost(`/transfers/${encodeURIComponent(String(transferId))}/reversals`, {
            amount: String(want - reversed),
            "metadata[reason]": isDispute ? "tip_disputed" : "tip_refunded",
            "metadata[tipId]": String(tip.id),
          }, `tiprev_${transferId}_${want}`);
          if (rev.error) note = `Could not take ${money(want - reversed)} back from ${tip.recipient_name}'s Stripe account: ${rev.error.message}`;
          else clawedCents = want;
        } else {
          clawedCents = reversed;
        }
      }
    } else {
      note = "No transfer to this staff member was found on this payment — take the tip back by hand.";
    }

    const { data: rec, error: recErr } = await supabase.rpc("record_tip_reversal", {
      p_tip_id: tip.id, p_refunded: refundCents / 100, p_dispute_status: disputeStatus,
      p_clawed_back: clawedCents == null ? null : clawedCents / 100, p_note: note || null,
    });
    if (recErr || !rec?.success) throw new Error(`tip ${tip.id}: not recorded (${recErr?.message || rec?.error || "unknown"}) — is migration 285 applied?`);
    console.log(`[stripe-connect-webhook] tip ${tip.id} (${tip.recipient_name}): refunded $${rec.refunded}, dispute ${rec.disputeStatus || "none"}, taken back $${rec.clawedBack}`);

    if (rec.alerted) continue;
    const lostCents = Math.round(Number(rec.lost) * 100);
    const clawCents = Math.round(Number(rec.clawedBack) * 100);
    const todo = rec.disputeStatus === "won" && clawCents > 0
      ? `<p><strong>The dispute was won.</strong> ${money(clawCents)} was taken back from ${tip.recipient_name}'s Stripe account while it was open — send it to them again: Stripe Dashboard → Connect → their account → Send funds (a transfer of ${money(clawCents)}).</p>`
      : clawCents < lostCents
        ? `<p><strong>To do:</strong> ${money(lostCents - clawCents)} of this tip is still in ${tip.recipient_name}'s Stripe account. ${rec.note || note || ""} In the Stripe Dashboard: Payments → this payment → the transfer → Reverse transfer.</p>`
        : `<p>The tip's share (${money(clawCents)}) was taken back from ${tip.recipient_name}'s Stripe account automatically — nothing to do but ${isDispute ? "answer the dispute in Stripe" : "note it"}.</p>`;
    const sent = await sendPlatformAlert(
      `Stripe: a staff tip was ${isDispute ? "disputed" : "refunded"} — ${tip.recipient_name}`,
      `<h2>A tip to ${tip.recipient_name} was ${isDispute ? `disputed (${rec.disputeStatus})` : "refunded"}</h2>
       <p><strong>Tip:</strong> $${Number(rec.amount).toFixed(2)} · <strong>refunded:</strong> $${Number(rec.refunded).toFixed(2)} · <strong>dispute:</strong> ${rec.disputeStatus || "none"}</p>
       <p><strong>Camp:</strong> ${tip.camp_id} · <strong>Payment:</strong> ${piId} · <strong>Charge:</strong> ${chargeId || charge.id}</p>
       ${todo}`);
    // Not sent: 500, so Stripe sends the event again — the tip is already
    // recorded, and only the email is tried again.
    if (sent === "failed") throw new Error(`tip ${tip.id}: the platform alert did not send`);
    await supabase.rpc("mark_tip_reversal_alerted", { p_tip_id: tip.id, p_state: rec.state });
  }
}

/** A camper id (from the page, or from metadata), or null. */
function camperIdIn(v: unknown): number | null {
  return v != null && /^\d+$/.test(String(v)) ? Number(v) : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature") || "";
    // Two endpoints (see header note) can deliver here, each signed with its
    // own secret — accept either. With NEITHER set this used to skip the check
    // and accept anything; it now refuses (TED-057's twin). A 500 makes Stripe
    // retry, so nothing is lost while the secret is being set.
    const secrets = [STRIPE_CONNECT_WEBHOOK_SECRET, STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET].filter(Boolean) as string[];
    if (!secrets.length) {
      console.error("[stripe-connect-webhook] no webhook secret is set — refusing every event until one is");
      return new Response(JSON.stringify({ error: "Webhook not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
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
    } else if (event.type === "charge.refunded" || event.type === "charge.dispute.created"
               || event.type === "charge.dispute.updated" || event.type === "charge.dispute.closed") {
      // A tip the parent got back (TED-176); anything else is stripe-webhook's.
      await handleTipReversal(supabase, event);
    } else if (event.type === "payout.failed") {
      // The camp's OWN payout, not the platform's. stripe-webhook already
      // handles payout.failed, but that is Campistry's payout and its alert goes
      // to Campistry's address — a camp with a closed bank account or a mistyped
      // routing number saw money collected, saw none arrive, and found nothing
      // here that explained the gap.
      //
      // A connected-account event carries the account id and nothing else about
      // whose it is, so the RPC resolves the camp from camps.stripe_account_id
      // and refuses rather than guessing: a payout alert on the wrong camp's
      // dashboard sends the wrong office to their bank.
      const po = event.data.object || {};
      const acct = String(event.account || "");
      const { data, error } = await supabase.rpc("record_payout_failure", {
        p_stripe_account_id: acct,
        p_payout_id: String(po.id || ""),
        p_amount: po.amount != null ? Number((po.amount / 100).toFixed(2)) : null,
        p_currency: po.currency || null,
        p_failure_message: po.failure_message || po.failure_code || null,
        p_arrival_date: po.arrival_date
          ? new Date(po.arrival_date * 1000).toISOString().split("T")[0] : null,
      });
      if (error || !data?.success) {
        console.error(`[stripe-connect-webhook] payout ${po.id} for account ${acct} failed and ` +
          `was NOT recorded (${error?.message || data?.error || "unknown"}) — that camp has ` +
          `money sitting at Stripe with nothing here to say so.`);
      } else {
        console.log(`[stripe-connect-webhook] payout ${po.id} failed for camp ${data.campName} ` +
          `(${data.campId}) — the camp has been notified`);
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
