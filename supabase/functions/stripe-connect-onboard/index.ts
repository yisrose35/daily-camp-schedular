// =============================================================================
// stripe-connect-onboard — Create/resume a Stripe Connect Express account for
// one Campistry Link staff tip account, and return a hosted onboarding URL.
//
// Called from either campistry_me.js's Tip Payments tab (Payroll — an admin
// acting on a staff member's row; Staff Payments management lives in
// Campistry Me now, not Link Admin) or campistry_lite.js's Tips tab (the
// staff member acting on their OWN row after claim_staff_tip_account() links
// it to their login — the primary flow, since a real bank account should be
// connected by the actual person, not set up on their behalf). Either way
// the caller's own Supabase session JWT is used to read/write the row
// through Supabase's normal RLS — migration 017 covers the admin path,
// migration 058's self-service policies cover the staff path. This is a
// deliberate departure from the rest of the Stripe functions in this repo,
// which trust an unauthenticated campId from the request body. Minting a
// Connect account tied to a real bank account is higher-stakes than the
// existing billing flow, so we lean on real auth here instead.
//
// capabilities[transfers][requested]=true only — NOT card_payments. Campistry
// (the platform) takes the actual charge via a destination charge; the
// connected account only ever needs to RECEIVE a transfer. Requesting
// card_payments here is the most common Connect Express mistake and pulls in
// extra Stripe underwriting requirements this feature doesn't need.
//
// Request:  { accountId, returnTo? }  (link_staff_accounts.id;
//           returnTo: 'lite' | 'me', default 'me')
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { url }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

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

    const { accountId, returnTo } = await req.json();
    if (!accountId) {
      return new Response(JSON.stringify({ error: "accountId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RLS-scoped as the caller — only resolves if they're owner/admin of the
    // camp this row belongs to. No custom role-check code needed.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: acct, error: selErr } = await asUser
      .from("link_staff_accounts")
      .select("id, camp_id, staff_name, stripe_account_id")
      .eq("id", accountId)
      .maybeSingle();
    if (selErr || !acct) {
      return new Response(JSON.stringify({ error: "not_authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let stripeAccountId = acct.stripe_account_id as string | null;
    if (!stripeAccountId) {
      const account = await stripePost("/accounts", {
        type: "express",
        country: "US",
        business_type: "individual",
        "capabilities[transfers][requested]": "true",
        "metadata[campId]": String(acct.camp_id || ""),
        "metadata[staffAccountId]": String(acct.id),
        "metadata[staffName]": String(acct.staff_name || ""),
      });
      if (account.error) throw new Error(account.error.message);
      stripeAccountId = account.id;

      const { error: updErr } = await asUser
        .from("link_staff_accounts")
        .update({ stripe_account_id: stripeAccountId, stripe_onboarding_status: "pending" })
        .eq("id", accountId);
      if (updErr) throw new Error(updErr.message);

      console.log(`[stripe-connect-onboard] Created Connect account ${stripeAccountId} for ${acct.staff_name}`);
    }

    // Express onboarding links expire after ~5 minutes — always mint a fresh
    // one. This also doubles as "resume onboarding" for a staff member who
    // dropped off partway through.
    const origin = req.headers.get("origin") || "";
    const returnPage = returnTo === "lite" ? "campistry_lite.html" : "campistry_me.html";
    const returnUrl = `${origin}/${returnPage}?stripeReturn=1&accountId=${encodeURIComponent(accountId)}`;
    const link = await stripePost("/account_links", {
      account: stripeAccountId,
      type: "account_onboarding",
      refresh_url: returnUrl,
      return_url: returnUrl,
    });
    if (link.error) throw new Error(link.error.message);

    return new Response(JSON.stringify({ url: link.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-connect-onboard] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
