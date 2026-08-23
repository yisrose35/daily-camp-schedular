// =============================================================================
// stripe-connect-status-camp — On-demand sync check of a CAMP's Connect
// onboarding state, right after the owner is redirected back from Stripe.
//
// Mirrors stripe-connect-status exactly, retargeted at camps. The
// account.updated webhook (see stripe-connect-webhook) is the durable
// source of truth for stripe_charges_enabled, but webhooks are async — this
// function lets dashboard.js get an immediate answer the moment the owner
// lands back on ?stripeReturn=1, instead of waiting on the webhook.
//
// Request:  { campId }
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } });
  return resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const { campId } = await req.json();
    if (!campId) return json({ error: "campId is required" }, 400);

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: camp, error: selErr } = await asUser
      .from("camps")
      .select("id, owner, stripe_account_id, stripe_connected_at")
      .eq("id", campId)
      .eq("owner", (await asUser.auth.getUser()).data.user?.id || "")
      .maybeSingle();
    if (selErr || !camp) return json({ error: "not_authorized" }, 403);
    if (!camp.stripe_account_id) return json({ error: "not_connected" }, 400);

    const account = await stripeGet(`/accounts/${camp.stripe_account_id}`);
    if (account.error) throw new Error(account.error.message);

    const chargesEnabled = !!account.charges_enabled;
    const onboardingStatus = chargesEnabled ? "complete" : "pending";
    const update: Record<string, unknown> = {
      stripe_charges_enabled: chargesEnabled,
      stripe_onboarding_status: onboardingStatus,
    };
    if (chargesEnabled && !camp.stripe_connected_at) {
      update.stripe_connected_at = new Date().toISOString();
    }
    const { error: updErr } = await asUser.from("camps").update(update).eq("id", campId);
    if (updErr) throw new Error(updErr.message);

    return json({ charges_enabled: chargesEnabled, onboarding_status: onboardingStatus });
  } catch (err) {
    console.error("[stripe-connect-status-camp] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
