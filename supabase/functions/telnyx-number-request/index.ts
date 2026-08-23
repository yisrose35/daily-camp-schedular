// =============================================================================
// telnyx-number-request — Step 2: charge the camp, then provision via Telnyx.
//
// Called once the Dashboard has confirmed the SetupIntent from
// telnyx-number-setup client-side (card is saved). This is the "go" button:
//   1. Re-fetch the provisioning row, require a saved payment method.
//   2. Charge the one-time registration fee (off-session PaymentIntent, same
//      shape as charge-due-installments/index.ts's stripeCharge()).
//   3. On charge success, call Telnyx: search+order a number near the camp's
//      business address, register a 10DLC Brand, register a Campaign, link
//      the number to the campaign.
//   4. If ANY Telnyx step fails after the charge succeeded, refund it and
//      mark the row 'failed' — never leave a camp having paid for nothing.
//
// IMPORTANT: the exact Telnyx 10DLC endpoint/field names below are written
// from Telnyx's documented API shape but have NOT been exercised against a
// live Telnyx account from this environment (no Telnyx credentials here).
// Verify against https://developers.telnyx.com/api/messaging/10dlc before
// processing a real charge in production — see SMS_EMAIL_BROADCAST_SETUP.md.
// If a field/endpoint name is wrong, the Telnyx call fails, which triggers
// the refund path below — the safe failure mode, not a silent bad charge.
//
// Request:  { campId }
// Response: { ok, status, phoneNumber? } | { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
const TELNYX_API = "https://api.telnyx.com/v2";
const SENDER_ROLES = ["owner", "admin"];

// Pricing researched against Telnyx's own published fee schedule (see
// TELNYX_NUMBER_PROVISIONING_SETUP.md for the full breakdown and sources).
// Telnyx hard costs: number $1.00 one-time + $1.00/mo rental + $0.10/mo
// SMS/MMS add-on, 10DLC brand $4.50 one-time, 10DLC campaign carrier-review
// $15.00 one-time (can recur on resubmission), 10DLC campaign monthly fee
// $10/mo for the "MIXED" use case this code registers (10dlc/campaign call
// below uses usecase: "MIXED" — Standard tier, not the cheaper $1.50/mo Low
// Volume Mixed tier). Total hard cost: ~$20.50 one-time, ~$11.10/mo
// recurring. These constants add a small buffer on top since actual
// per-message carrier costs (~$0.004-0.008/message) are NOT separately
// metered or passed through anywhere in this flow — see the setup doc's
// "usage costs are not metered" note before enabling this for real camps.
const REGISTRATION_FEE_CENTS = 2500; // $25 one-time
const MONTHLY_FEE_CENTS = 1500;      // $15/month

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

async function telnyxRequest(method: string, endpoint: string, body?: Record<string, unknown>) {
  const resp = await fetch(`${TELNYX_API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.errors?.[0]?.detail || `Telnyx ${method} ${endpoint} failed (${resp.status})`);
  return data;
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

function zipToAreaCodeHint(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/\b(\d{5})(-\d{4})?\b/);
  return m ? m[1] : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);
    if (!TELNYX_API_KEY) return json({ error: "Telnyx not configured" }, 500);

    const role = await callerRole(req);
    if (!role || !SENDER_ROLES.includes(role)) {
      return json({ error: "Only camp owners/admins can request a texting number." }, 403);
    }

    const { campId } = await req.json();
    if (!campId) return json({ error: "campId required" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: row, error: rowErr } = await supabase
      .from("camp_telnyx_provisioning")
      .select("*")
      .eq("camp_id", campId)
      .maybeSingle();
    if (rowErr || !row) return json({ error: "Run telnyx-number-setup first." }, 400);
    if (!row.stripe_customer_id) return json({ error: "No saved payment method for this camp yet." }, 400);
    if (row.status === "active") return json({ error: "This camp already has an active number." }, 400);
    if (row.status === "pending_carrier_review" || row.status === "provisioning") {
      return json({ error: "A request is already in progress for this camp." }, 400);
    }

    // Need a confirmed payment method on the customer (the client confirmed
    // the SetupIntent already — pull whichever card is now attached).
    const pmList = await fetch(`${STRIPE_API}/payment_methods?customer=${row.stripe_customer_id}&type=card`, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
    }).then((r) => r.json());
    const paymentMethodId = pmList?.data?.[0]?.id;
    if (!paymentMethodId) return json({ error: "No card on file yet — complete the card step first." }, 400);

    // 1. Charge the one-time registration fee, off-session.
    const chargeParams: Record<string, string> = {
      amount: String(REGISTRATION_FEE_CENTS),
      currency: "usd",
      customer: row.stripe_customer_id,
      payment_method: paymentMethodId,
      off_session: "true",
      confirm: "true",
      description: `Campistry SMS number setup — ${row.business_legal_name || campId}`,
      "metadata[campId]": campId,
      "metadata[purpose]": "telnyx_number_registration",
    };
    const pi = await fetch(`${STRIPE_API}/payment_intents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(chargeParams).toString(),
    }).then((r) => r.json());

    if (pi.error || pi.status !== "succeeded") {
      const msg = pi.error?.message || `Payment ${pi.status || "failed"} — try a different card.`;
      await supabase.from("camp_telnyx_provisioning").update({
        status: "failed", error_message: msg, updated_at: new Date().toISOString(),
      }).eq("camp_id", campId);
      return json({ error: msg }, 402);
    }

    await supabase.from("camp_telnyx_provisioning").update({
      status: "provisioning",
      stripe_payment_method_id: paymentMethodId,
      registration_fee_cents: REGISTRATION_FEE_CENTS,
      monthly_fee_cents: MONTHLY_FEE_CENTS,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("camp_id", campId);

    // 2. Provision via Telnyx. Any failure here refunds the charge above.
    try {
      const areaCodeHint = zipToAreaCodeHint(row.business_address);
      const searchQs = areaCodeHint
        ? `filter[national_destination_code]=${areaCodeHint.slice(0, 3)}&filter[limit]=1`
        : `filter[limit]=1`;
      const available = await telnyxRequest("GET", `/available_phone_numbers?${searchQs}`);
      const candidate = available?.data?.[0]?.phone_number;
      if (!candidate) throw new Error("No available phone numbers found near this camp's address.");

      const order = await telnyxRequest("POST", "/number_orders", {
        phone_numbers: [{ phone_number: candidate }],
      });
      const orderedNumber = order?.data?.phone_numbers?.[0]?.phone_number || candidate;
      const numberId = order?.data?.phone_numbers?.[0]?.id;

      const brand = await telnyxRequest("POST", "/10dlc/brand", {
        entityType: row.is_nonprofit ? "NONPROFIT" : "PRIVATE_PROFIT",
        displayName: row.business_legal_name,
        companyName: row.business_legal_name,
        ein: row.ein,
        phone: row.business_phone,
        street: row.business_address,
        country: "US",
        email: row.business_email,
        vertical: row.is_nonprofit ? "NPO" : "HOSPITALITY",
      });
      const brandId = brand?.data?.brandId || brand?.brandId;
      if (!brandId) throw new Error("Telnyx did not return a brand ID.");

      const campaign = await telnyxRequest("POST", "/10dlc/campaign", {
        brandId,
        usecase: "MIXED",
        description: `${row.business_legal_name} — camp-to-parent communication (schedules, alerts, messages, payment reminders).`,
        sample1: "Hi! This is a message from your camp about today's schedule. Reply STOP to opt out.",
        messageFlow: "Parents opt in by checking a consent box on the camp's registration/staff-apply form before any message is sent.",
        helpMessage: "Reply HELP for help, STOP to opt out.",
        optinKeywords: "START",
        optoutKeywords: "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT",
      });
      const campaignId = campaign?.data?.campaignId || campaign?.campaignId;
      if (!campaignId) throw new Error("Telnyx did not return a campaign ID.");

      // Link the ordered number to the campaign so it's cleared to send.
      if (numberId) {
        await telnyxRequest("POST", `/10dlc/phoneNumberCampaign`, { phoneNumber: orderedNumber, campaignId });
      }

      await supabase.from("camp_telnyx_provisioning").update({
        status: "pending_carrier_review",
        telnyx_phone_number: orderedNumber,
        telnyx_number_id: numberId || null,
        telnyx_brand_id: brandId,
        telnyx_campaign_id: campaignId,
        next_charge_at: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
        updated_at: new Date().toISOString(),
      }).eq("camp_id", campId);

      return json({ ok: true, status: "pending_carrier_review", phoneNumber: orderedNumber });
    } catch (telnyxErr) {
      // Never leave a camp having paid for a number that didn't provision.
      await stripePost("/refunds", { payment_intent: pi.id, "metadata[reason]": "telnyx_provisioning_failed" }).catch(() => {});
      await supabase.from("camp_telnyx_provisioning").update({
        status: "failed",
        error_message: (telnyxErr as Error).message,
        updated_at: new Date().toISOString(),
      }).eq("camp_id", campId);
      return json({ error: `Provisioning failed, refunded: ${(telnyxErr as Error).message}` }, 502);
    }
  } catch (err) {
    console.error("[telnyx-number-request] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
