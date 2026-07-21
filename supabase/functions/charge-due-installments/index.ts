// =============================================================================
// charge-due-installments — the monthly-billing (autopay) runner
//
// Meant to be called once a day by pg_cron (see BILLING_PAYMENTS_SETUP.md). For
// every camp it scans campistryMe.families for families that have:
//   - a monthly plan with autopay on           (f.plan.autopay === true)
//   - a saved card                              (f.cardOnFile + f.stripeCustomerId)
//   - at least one installment due today/overdue (status 'pending', dueDate<=today)
// and charges each due installment off-session via Stripe, marks it paid, and
// appends a payment to finance.payments so it shows up in Billing. A failed
// charge marks that installment 'failed' and moves on (office can retry).
//
// Auth: requires header  x-cron-secret: <INSTALLMENT_CRON_SECRET>  so only the
// scheduler can trigger it.
//
// Response: { ok, charged, failed, skippedCamps, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("INSTALLMENT_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

async function stripeCharge(customerId: string, pmId: string | null, amount: number, description: string, metadata: Record<string, string>) {
  const params: Record<string, string> = {
    amount: String(Math.round(amount * 100)),
    currency: "usd",
    customer: customerId,
    off_session: "true",
    confirm: "true",
    description: description,
  };
  if (pmId) params["payment_method"] = pmId;
  Object.entries(metadata).forEach(([k, v]) => { params[`metadata[${k}]`] = String(v); });
  const resp = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return resp.json();
}

function todayISO() { return new Date().toISOString().split("T")[0]; }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Gate: only the scheduler (holding the secret) may run this.
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!STRIPE_SECRET) {
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const today = todayISO();
  let charged = 0, failed = 0;
  const details: Record<string, unknown>[] = [];

  const { data: rows, error } = await supabase.from("camp_state_kv")
    .select("camp_id, value").eq("key", "campistryMe");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  for (const row of (rows || [])) {
    const me = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    if (!me || !me.families) continue;
    if (!me.finance) me.finance = {};
    if (!Array.isArray(me.finance.payments)) me.finance.payments = [];
    let dirty = false;

    for (const [famKey, fRaw] of Object.entries(me.families)) {
      const f = fRaw as Record<string, any>;
      const plan = f.plan;
      if (!plan || !plan.autopay || !Array.isArray(plan.installments)) continue;
      if (!f.cardOnFile || !f.stripeCustomerId) continue;

      for (const inst of plan.installments) {
        if (inst.status !== "pending") continue;
        if (!inst.dueDate || inst.dueDate > today) continue; // not due yet
        const amount = Number(inst.amount) || 0;
        if (amount <= 0) { inst.status = "paid"; dirty = true; continue; }

        const camperName = (Array.isArray(f.camperIds) && f.camperIds[0]) ? f.camperIds[0] : (f.name || "");
        const pi = await stripeCharge(
          f.stripeCustomerId, f.stripePaymentMethodId || null, amount,
          `Autopay installment — ${f.name || famKey}`,
          { campId: String(row.camp_id), familyKey: famKey, familyName: camperName, source: "autopay" },
        );

        if (pi.error || pi.status === "requires_action") {
          inst.status = "failed";
          inst.failReason = pi.error?.message || "requires_authentication";
          failed++;
          details.push({ camp: row.camp_id, family: f.name, amount, result: "failed", reason: inst.failReason });
        } else if (pi.status === "succeeded") {
          inst.status = "paid";
          inst.paidDate = today;
          inst.stripePaymentIntentId = pi.id;
          me.finance.payments.push({
            id: "auto_" + pi.id, family: camperName, familyKey: famKey,
            amount: amount, date: today, method: "Autopay (card)",
            reference: pi.id, notes: "Monthly autopay installment",
            stripePaymentIntentId: pi.id, status: "succeeded", timestamp: Date.now(),
          });
          charged++;
          details.push({ camp: row.camp_id, family: f.name, amount, result: "charged" });
        } else {
          // processing (e.g. slower method) — leave pending-ish but note it
          details.push({ camp: row.camp_id, family: f.name, amount, result: pi.status });
        }
        dirty = true;
      }
    }

    if (dirty) {
      const up = await supabase.from("camp_state_kv").upsert(
        { camp_id: row.camp_id, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
        { onConflict: "camp_id,key" },
      );
      if (up.error) console.warn(`[autopay] write failed for camp ${row.camp_id}: ${up.error.message}`);
    }
  }

  console.log(`[autopay] done — charged ${charged}, failed ${failed}`);
  return new Response(
    JSON.stringify({ ok: true, charged, failed, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
