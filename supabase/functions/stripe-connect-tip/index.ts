// =============================================================================
// stripe-connect-tip — Create a hosted Checkout Session that charges a parent
// for a tip and routes it straight to a staff member's connected Stripe
// account via a destination charge, minus a 2% platform fee (kept by
// Campistry, the connected account still receives the FULL tip amount).
//
// Unlike stripe-checkout/stripe-setup/stripe-charge, this function does NOT
// trust an unauthenticated campId from the request body — a real charge tied
// to a specific person's bank account is higher-stakes than the existing
// billing flow. The caller must be the authenticated parent themselves;
// their invite is resolved the same way submit_link_tip() resolves it in
// SQL (link_parent_invites WHERE user_id = auth.uid()), just redone here in
// Deno since Checkout Sessions can't be created inside a plpgsql RPC.
//
// The 2% platform fee is hardcoded for this first concept — not yet a
// camp-configurable setting (see TIPPING_SETUP.md).
//
// Stripe's own processing fee (2.9% + 30c, the standard US card rate) is
// ALSO passed to the parent on top of that 2%, not absorbed by Campistry.
// Without this, Campistry actually loses money on every tip: Stripe deducts
// its real cut from the platform's application_fee_amount regardless of
// what that's set to, and 2% of a typical tip doesn't cover 2.9%+30c of the
// total charge. See computeFees() below for the exact (grossed-up) math —
// grossing up matters because Stripe's percentage is charged on the TOTAL
// charge, which itself includes the fee being solved for.
//
// Request:  { campId, accountId, camperName?, parentName?, parentEmail?, tipAmount }
//           (accountId = link_staff_accounts.id; only ids returned by the
//           get_link_tip_targets RPC are ever passed in from the client, so
//           a mistyped/parent-supplied name can never itself route a charge)
//           header: Authorization: Bearer <parent's Supabase access token>
// Response: { url, sessionId }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const PLATFORM_FEE_RATE = 0.02;  // Campistry's cut, 2% of the tip — see header note.
const STRIPE_PCT = 0.029;        // Stripe's standard US card rate — 2.9% + 30c.
const STRIPE_FIXED_CENTS = 30;
const MIN_TIP = 1;
const MAX_TIP = 500; // mirrors submit_link_tip()'s existing bounds

// Solves for the total charge such that, after Stripe takes its real cut
// (STRIPE_PCT of the FULL charge + a fixed 30c) out of the platform's
// application_fee_amount, the staff member still gets the exact tip amount
// (transfer_data.destination = total - applicationFee = tip, always) AND
// Campistry's 2% survives as real margin instead of covering Stripe's cost.
// total = tip + campistryFee + (total * STRIPE_PCT + STRIPE_FIXED_CENTS)
// => total = (tip + campistryFee + STRIPE_FIXED_CENTS) / (1 - STRIPE_PCT)
function computeFees(tipCents: number) {
  const campistryFeeCents = Math.round(tipCents * PLATFORM_FEE_RATE);
  const preStripeCents = tipCents + campistryFeeCents + STRIPE_FIXED_CENTS;
  const totalCents = Math.ceil(preStripeCents / (1 - STRIPE_PCT));
  const feeCents = totalCents - tipCents; // combined Stripe + Campistry fee, shown to the parent as one number
  const stripeFeeCents = feeCents - campistryFeeCents;
  return { totalCents, feeCents, campistryFeeCents, stripeFeeCents };
}

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

    const { campId, accountId, camperName, parentName, parentEmail, tipAmount } = await req.json();
    if (!campId || !accountId) {
      return new Response(JSON.stringify({ error: "campId and accountId are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const tip = Number(tipAmount);
    if (!tip || tip < MIN_TIP || tip > MAX_TIP) {
      return new Response(JSON.stringify({ error: "invalid_amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve the caller's own active invite for this camp — same check
    // submit_link_tip() does in SQL. RLS (link_parent_invites_parent_select)
    // already scopes this to user_id = auth.uid(); we just also filter camp_id.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: invite, error: inviteErr } = await asUser
      .from("link_parent_invites")
      .select("id, camp_id, parent_name, parent_email")
      .eq("camp_id", campId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inviteErr || !invite) {
      return new Response(JSON.stringify({ error: "no_active_invite" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parents have no SELECT policy on link_staff_accounts at all — service
    // role is required here, scoped manually to the requested camp+id.
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: acct, error: acctErr } = await service
      .from("link_staff_accounts")
      .select("id, camp_id, staff_name, role, stripe_account_id, stripe_charges_enabled")
      .eq("id", accountId)
      .eq("camp_id", campId)
      .maybeSingle();
    if (acctErr || !acct) {
      return new Response(JSON.stringify({ error: "staff_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!acct.stripe_charges_enabled || !acct.stripe_account_id) {
      return new Response(JSON.stringify({ error: "staff_not_connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tipCents = Math.round(tip * 100);
    const { totalCents, feeCents, campistryFeeCents, stripeFeeCents } = computeFees(tipCents);

    const origin = req.headers.get("origin") || "";
    const success = `${origin}/campistry_pay_thanks.html?status=success&context=tip`;
    const cancel = `${origin}/campistry_pay_thanks.html?status=cancelled&context=tip`;

    // One combined line item — the tip sheet in campistry_link_parent.html
    // already shows the parent "$X tip + $Y fee = $Z total" (Stripe's cut +
    // Campistry's cut summed into one number, per the owner's chosen
    // display) before they get here, so Checkout itself doesn't need to
    // itemize it again.
    // auth.uid() isn't directly on the invite row we selected — fetch it via
    // the same RLS-scoped client (cheap; JWT is already decoded locally by
    // getUser() with no extra round trip needed beyond token introspection).
    const { data: authUser } = await asUser.auth.getUser();

    const meta: Record<string, string> = {
      campId: String(campId),
      staffAccountId: String(acct.id),
      staffName: String(acct.staff_name || ""),
      staffRole: String(acct.role || ""),
      camperName: String(camperName || ""),
      parentUserId: String(authUser?.user?.id || ""),
      parentName: String(parentName || invite.parent_name || ""),
      parentEmail: String(parentEmail || invite.parent_email || ""),
      tipCents: String(tipCents),
      feeCents: String(feeCents),
      campistryFeeCents: String(campistryFeeCents),
      stripeFeeCents: String(stripeFeeCents),
      source: "campistry-link-tip",
    };

    const params: Record<string, string> = {
      "mode": "payment",
      "success_url": success,
      "cancel_url": cancel,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(totalCents),
      "line_items[0][price_data][product_data][name]": `Tip for ${acct.staff_name || "camp staff"}`,
      "payment_intent_data[application_fee_amount]": String(feeCents),
      "payment_intent_data[transfer_data][destination]": acct.stripe_account_id,
      "payment_intent_data[description]": `Tip for ${acct.staff_name || "camp staff"}`,
    };
    if (meta.parentEmail) params["customer_email"] = meta.parentEmail;
    Object.entries(meta).forEach(([k, v]) => {
      params[`metadata[${k}]`] = v;
      params[`payment_intent_data[metadata][${k}]`] = v;
    });

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    console.log(`[stripe-connect-tip] Session ${session.id} — $${tip} tip for ${acct.staff_name} (+$${feeCents / 100} fee)`);

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[stripe-connect-tip] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
