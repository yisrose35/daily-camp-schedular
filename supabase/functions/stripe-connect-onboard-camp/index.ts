// =============================================================================
// stripe-connect-onboard-camp — Create/resume a Stripe Connect Express
// account for a CAMP (not a staff member — see stripe-connect-onboard for
// that), so tuition/store payments can route directly into that camp's own
// bank account instead of pooling into the shared platform Stripe account.
//
// Mirrors stripe-connect-onboard exactly, retargeted at camps. Same
// deliberate departure from the rest of the Stripe functions in this repo
// (which trust an unauthenticated campId from the request body): this one
// requires the caller's own Supabase session JWT, and only the camp OWNER
// (not admin, not scheduler) may connect — a bank account is the single
// most sensitive thing a camp can set up, higher-stakes than ordinary
// billing actions, so it gets the tightest auth in the app.
//
// capabilities[transfers][requested]=true only — NOT card_payments. The
// platform takes the actual charge via a destination charge (see
// stripe-charge/stripe-checkout/charge-due-installments); the connected
// account only ever needs to RECEIVE a transfer. This is the same pattern
// already proven for staff Connect accounts.
//
// Request:  { campId, returnTo? }
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function stripePost(endpoint: string, body: Record<string, string>) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const { campId, returnTo } = await req.json();
    if (!campId) return json({ error: "campId is required" }, 400);

    // RLS-scoped as the caller — only resolves if they're the camp's owner.
    // camps' existing UPDATE policy (already used by dashboard.js's
    // saveProfile() for name/address/contact_email) is owner-only, so no
    // new policy is needed here; a non-owner's select/update below just
    // returns no row.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: camp, error: selErr } = await asUser
      .from("camps")
      .select("id, owner, name, stripe_account_id")
      .eq("id", campId)
      .eq("owner", (await asUser.auth.getUser()).data.user?.id || "")
      .maybeSingle();
    if (selErr || !camp) {
      return json({ error: "Only the camp owner can connect a Stripe account." }, 403);
    }

    let stripeAccountId = camp.stripe_account_id as string | null;
    if (!stripeAccountId) {
      const account = await stripePost("/accounts", {
        type: "express",
        country: "US",
        business_type: "company",
        "capabilities[transfers][requested]": "true",
        "metadata[campId]": String(camp.id),
        "metadata[campName]": String(camp.name || ""),
      });
      if (account.error) throw new Error(account.error.message);
      stripeAccountId = account.id;

      const { error: updErr } = await asUser
        .from("camps")
        .update({ stripe_account_id: stripeAccountId, stripe_onboarding_status: "pending" })
        .eq("id", campId);
      if (updErr) throw new Error(updErr.message);

      console.log(`[stripe-connect-onboard-camp] Created Connect account ${stripeAccountId} for camp ${camp.name}`);
    }

    // Express onboarding links expire after ~5 minutes — always mint a
    // fresh one. This also doubles as "resume onboarding" for an owner who
    // dropped off partway through.
    const origin = req.headers.get("origin") || "";
    const returnUrl = `${origin}/dashboard.html?stripeReturn=1&campId=${encodeURIComponent(campId)}`;
    const link = await stripePost("/account_links", {
      account: stripeAccountId,
      type: "account_onboarding",
      refresh_url: returnUrl,
      return_url: returnUrl,
    });
    if (link.error) throw new Error(link.error.message);

    return json({ url: link.url });
  } catch (err) {
    console.error("[stripe-connect-onboard-camp] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
