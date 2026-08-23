// =============================================================================
// stripe-connect-status — On-demand sync check of a staff member's Connect
// onboarding state, right after they're redirected back from Stripe.
//
// The account.updated webhook (see stripe-connect-webhook) is the durable
// source of truth for stripe_charges_enabled, but webhooks are async — this
// function lets campistry_link_admin.html get an immediate answer the moment
// the admin lands back on ?stripeReturn=1, instead of waiting on the webhook.
//
// Request:  { accountId }  (link_staff_accounts.id)
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { charges_enabled, onboarding_status }
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

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
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

    const { accountId } = await req.json();
    if (!accountId) {
      return new Response(JSON.stringify({ error: "accountId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: acct, error: selErr } = await asUser
      .from("link_staff_accounts")
      .select("id, stripe_account_id, stripe_connected_at")
      .eq("id", accountId)
      .maybeSingle();
    if (selErr || !acct) {
      return new Response(JSON.stringify({ error: "not_authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!acct.stripe_account_id) {
      return new Response(JSON.stringify({ error: "not_connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const account = await stripeGet(`/accounts/${acct.stripe_account_id}`);
    if (account.error) throw new Error(account.error.message);

    // This account only ever requests the `transfers` capability (never
    // card_payments), so charges_enabled may never turn true even once
    // onboarding is fully complete — payouts_enabled is the field that
    // actually reflects readiness to receive money. Check either (matches
    // the same fix in stripe-connect-webhook's handleAccountUpdated and
    // stripe-connect-status-camp).
    const chargesEnabled = !!(account.charges_enabled || account.payouts_enabled);
    const onboardingStatus = chargesEnabled ? "complete" : "pending";
    const update: Record<string, unknown> = {
      stripe_charges_enabled: chargesEnabled,
      stripe_onboarding_status: onboardingStatus,
    };
    if (chargesEnabled && !acct.stripe_connected_at) {
      update.stripe_connected_at = new Date().toISOString();
    }
    const { error: updErr } = await asUser
      .from("link_staff_accounts")
      .update(update)
      .eq("id", accountId);
    if (updErr) throw new Error(updErr.message);

    return new Response(
      JSON.stringify({ charges_enabled: chargesEnabled, onboarding_status: onboardingStatus }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[stripe-connect-status] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
