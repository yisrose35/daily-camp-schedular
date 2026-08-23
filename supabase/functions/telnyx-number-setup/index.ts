// =============================================================================
// telnyx-number-setup — Step 1 of camp self-serve SMS number provisioning.
//
// Mirrors stripe-setup/index.ts exactly (Customer-then-SetupIntent), just
// for a camp instead of a family. Creates/reuses a Stripe Customer for the
// camp, creates a SetupIntent so the Dashboard can collect a card via
// Stripe Elements, and upserts camp_telnyx_provisioning with the submitted
// business info at status='pending_payment'.
//
// Auth: JWT-verified (Supabase default) + re-checks caller is owner/admin
// of the camp via get_user_role(), same pattern as send-sms/send-broadcast.
//
// Request:  { campId, businessName, businessEmail, businessPhone,
//             businessAddress, ein?, isNonprofit? }
// Response: { clientSecret, customerId }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SENDER_ROLES = ["owner", "admin"];

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

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } });
  return resp.json();
}

async function callerRole(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_role`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: authHeader, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return null;
  const role = await res.json();
  return typeof role === "string" ? role : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const role = await callerRole(req);
    if (!role || !SENDER_ROLES.includes(role)) {
      return json({ error: "Only camp owners/admins can set up a texting number." }, 403);
    }

    const { campId, businessName, businessEmail, businessPhone, businessAddress, ein, isNonprofit } = await req.json();
    if (!campId || !businessName || !businessEmail || !businessPhone || !businessAddress || !ein) {
      return json({ error: "campId, businessName, businessEmail, businessPhone, businessAddress, and ein are all required — Telnyx's Standard 10DLC brand registration needs every one of them. (Sole Proprietor registration without an EIN isn't supported by this flow yet.)" }, 400);
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Reuse an existing Stripe customer for this camp's provisioning row if
    // one's already there (e.g. a retry after a failed attempt).
    const { data: existing } = await supabase
      .from("camp_telnyx_provisioning")
      .select("stripe_customer_id")
      .eq("camp_id", campId)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id;
    if (!customerId) {
      const search = await stripeGet(`/customers?email=${encodeURIComponent(businessEmail)}&limit=1`);
      if (search.data?.length > 0) {
        customerId = search.data[0].id;
      } else {
        const customer = await stripePost("/customers", {
          name: businessName,
          email: businessEmail,
          "metadata[campId]": campId,
          "metadata[source]": "campistry_telnyx_provisioning",
        });
        if (customer.error) throw new Error(customer.error.message);
        customerId = customer.id;
      }
    }

    const setupIntent = await stripePost("/setup_intents", {
      customer: customerId,
      "payment_method_types[]": "card",
      "metadata[campId]": campId,
      "metadata[purpose]": "telnyx_number_provisioning",
      usage: "off_session",
    });
    if (setupIntent.error) throw new Error(setupIntent.error.message);

    const { error: upsertErr } = await supabase.from("camp_telnyx_provisioning").upsert({
      camp_id: campId,
      status: "pending_payment",
      business_legal_name: businessName,
      ein: ein || null,
      business_address: businessAddress,
      business_email: businessEmail,
      business_phone: businessPhone,
      is_nonprofit: !!isNonprofit,
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "camp_id" });
    if (upsertErr) throw new Error(upsertErr.message);

    return json({ clientSecret: setupIntent.client_secret, customerId });
  } catch (err) {
    console.error("[telnyx-number-setup] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
