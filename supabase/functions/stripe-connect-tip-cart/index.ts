// =============================================================================
// stripe-connect-tip-cart — Create ONE hosted Checkout Session that tips
// MULTIPLE staff members at once, possibly across MULTIPLE camps, in a
// single charge to the parent's card.
//
// stripe-connect-tip (destination charge, one recipient) is unchanged and
// still exists for that flow. Stripe has no way to split a single
// PaymentIntent's transfer_data across more than one connected account, so
// a multi-recipient cart uses a different pattern: this charge has NO
// destination at all — the full amount lands in the PLATFORM's own Stripe
// balance — and stripe-connect-webhook fans it out into one Transfer per
// recipient the moment payment_intent.succeeded fires (Stripe's own
// documented pattern for "one payment, many payouts": see
// https://docs.stripe.com/connect/separate-charges-and-transfers).
//
// The cart itself (who gets what) is persisted in link_tip_cart_items
// BEFORE the Checkout Session is created, keyed by a cart_id put in the
// session/PaymentIntent metadata — Stripe metadata can't hold an arbitrary
// N-item array reliably (500-char values, ~50 keys), so the metadata only
// ever carries the id, and the webhook looks the real cart up in Postgres.
//
// Fee math: Campistry's 2% is computed PER RECIPIENT (so each person's
// link_tips.fee_amount reflects their own share) and shown as their own
// tip line item's context, but Stripe's real processing fee (2.9%+30c) is
// computed ONCE on the whole cart's total — it's a single charge, so Stripe
// only charges ONE fixed 30c and one 2.9%, not one per recipient — and
// added as its own combined "Card & platform fees" line item rather than
// being split (arbitrarily) across recipients.
//
// Request:  { items: [{ campId, accountId, tipAmount, camperName? }, ...],
//             parentName?, parentEmail? }
//           (accountId = link_staff_accounts.id, from get_link_tip_targets;
//           campId is per-item because a parent's cart can span camps)
//           header: Authorization: Bearer <parent's Supabase access token>
// Response: { url, sessionId, cartId }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const PLATFORM_FEE_RATE = 0.02;
const STRIPE_PCT = 0.029;
const STRIPE_FIXED_CENTS = 30;
const MIN_TIP = 1;
const MAX_TIP = 500;      // per recipient — mirrors stripe-connect-tip
const MAX_ITEMS = 20;     // sane cap on one cart; Stripe Checkout allows up to 100 line items

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { items, parentName, parentEmail } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "items is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (items.length > MAX_ITEMS) {
      return new Response(JSON.stringify({ error: "too_many_items" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    for (const it of items) {
      const amt = Number(it?.tipAmount);
      if (!it?.campId || !it?.accountId || !amt || amt < MIN_TIP || amt > MAX_TIP) {
        return new Response(JSON.stringify({ error: "invalid_item" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authUser } = await asUser.auth.getUser();
    if (!authUser?.user?.id) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify an active invite for EVERY camp referenced in the cart —
    // fail the whole request if any one camp doesn't check out, rather
    // than silently dropping items (a parent should never end up paying
    // less than the total they reviewed on the cart screen).
    const campIds = [...new Set(items.map((it: Record<string, unknown>) => String(it.campId)))];
    for (const campId of campIds) {
      const { data: invite } = await asUser
        .from("link_parent_invites")
        .select("id")
        .eq("camp_id", campId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!invite) {
        return new Response(JSON.stringify({ error: "no_active_invite", campId }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Parents have no SELECT policy on link_staff_accounts — service role,
    // scoped per item to its own claimed camp+id (same pattern as
    // stripe-connect-tip).
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const cartId = crypto.randomUUID();
    const lineItems: Record<string, string> = {};
    const cartRows: Record<string, unknown>[] = [];
    let tipCentsTotal = 0;
    let campistryFeeCentsTotal = 0;
    let idx = 0;

    for (const it of items) {
      const { data: acct, error: acctErr } = await service
        .from("link_staff_accounts")
        .select("id, camp_id, staff_name, role, stripe_account_id, stripe_charges_enabled")
        .eq("id", String(it.accountId))
        .eq("camp_id", String(it.campId))
        .maybeSingle();
      if (acctErr || !acct) {
        return new Response(JSON.stringify({ error: "staff_not_found", accountId: it.accountId }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!acct.stripe_charges_enabled || !acct.stripe_account_id) {
        return new Response(JSON.stringify({ error: "staff_not_connected", accountId: it.accountId, staffName: acct.staff_name }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tipCents = Math.round(Number(it.tipAmount) * 100);
      const feeCents = Math.round(tipCents * PLATFORM_FEE_RATE);
      tipCentsTotal += tipCents;
      campistryFeeCentsTotal += feeCents;

      lineItems[`line_items[${idx}][quantity]`] = "1";
      lineItems[`line_items[${idx}][price_data][currency]`] = "usd";
      lineItems[`line_items[${idx}][price_data][unit_amount]`] = String(tipCents);
      lineItems[`line_items[${idx}][price_data][product_data][name]`] = `Tip for ${acct.staff_name || "camp staff"}`;
      idx++;

      cartRows.push({
        cart_id: cartId,
        camp_id: it.campId,
        staff_account_id: acct.id,
        staff_name: acct.staff_name || "",
        staff_role: acct.role || "",
        stripe_account_id: acct.stripe_account_id,
        camper_name: it.camperName || null,
        parent_user_id: authUser.user.id,
        parent_name: parentName || null,
        parent_email: parentEmail || null,
        tip_cents: tipCents,
        fee_cents: feeCents,
      });
    }

    // Stripe's own cut, computed ONCE on the whole cart (see header note) —
    // grossed up so it, plus Campistry's summed 2%, plus every tip, equals
    // the total actually charged, and no recipient's payout is touched by it.
    const preStripeCents = tipCentsTotal + campistryFeeCentsTotal + STRIPE_FIXED_CENTS;
    const totalCents = Math.ceil(preStripeCents / (1 - STRIPE_PCT));
    const feesCents = totalCents - tipCentsTotal; // combined Stripe + Campistry, one line item

    lineItems[`line_items[${idx}][quantity]`] = "1";
    lineItems[`line_items[${idx}][price_data][currency]`] = "usd";
    lineItems[`line_items[${idx}][price_data][unit_amount]`] = String(feesCents);
    lineItems[`line_items[${idx}][price_data][product_data][name]`] = "Card & platform fees";

    const { error: insErr } = await service.from("link_tip_cart_items").insert(cartRows);
    if (insErr) throw new Error(insErr.message);

    const origin = req.headers.get("origin") || "";
    const success = `${origin}/campistry_pay_thanks.html?status=success&context=tip`;
    const cancel = `${origin}/campistry_pay_thanks.html?status=cancelled&context=tip`;

    const meta: Record<string, string> = {
      cartId,
      parentUserId: authUser.user.id,
      parentName: String(parentName || ""),
      parentEmail: String(parentEmail || ""),
      source: "campistry-link-tip-cart",
    };

    const params: Record<string, string> = {
      "mode": "payment",
      "success_url": success,
      "cancel_url": cancel,
      ...lineItems,
      // Deliberately NO payment_intent_data[transfer_data]/[application_fee_amount]
      // here — this charge stays entirely on the platform balance; the
      // webhook moves each recipient's share out via a separate Transfer.
      "payment_intent_data[description]": `Camp tips (${items.length} ${items.length === 1 ? "recipient" : "recipients"})`,
    };
    if (parentEmail) params["customer_email"] = String(parentEmail);
    Object.entries(meta).forEach(([k, v]) => {
      params[`metadata[${k}]`] = v;
      params[`payment_intent_data[metadata][${k}]`] = v;
    });

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    console.log(`[stripe-connect-tip-cart] Session ${session.id} — cart ${cartId}, ${items.length} recipients, $${totalCents / 100} total`);

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id, cartId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[stripe-connect-tip-cart] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
