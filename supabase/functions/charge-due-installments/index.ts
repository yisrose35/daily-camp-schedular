// =============================================================================
// charge-due-installments — the monthly-billing (autopay) runner
//
// Meant to be called once a day by pg_cron (see BILLING_PAYMENTS_SETUP.md). For
// every camp it scans campistryMe.families for families that have:
//   - one or more payment plans with autopay on (f.plans[].autopay === true —
//     a family can have MULTIPLE plans, e.g. one per enrolled camper; see
//     migrations/116_multi_payment_plans.sql. A pre-116 family with only the
//     legacy singular f.plan is read the same way, one-plan-in-a-list.)
//   - a saved card                              (f.cardOnFile + f.stripeCustomerId)
//   - at least one installment due today/overdue (status 'pending', dueDate<=today)
// and charges each due installment off-session via Stripe, marks it paid, and
// appends a payment to finance.payments so it shows up in Billing. A failed
// charge marks that installment 'failed' and moves on (office can retry).
//
// Auth: requires header  x-cron-secret: <INSTALLMENT_CRON_SECRET>  so only the
// scheduler can trigger it.
//
// If a camp has connected its own Stripe account (camps.stripe_account_id,
// see stripe-connect-onboard-camp / migrations/077_camp_stripe_connect.sql),
// each installment charge for that camp becomes a destination charge routing
// the money to the camp's own bank account instead of the platform's. No
// change to the Customer/PaymentMethod used to charge — only where the
// money settles. A camp that hasn't connected charges exactly as before.
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

async function stripeCharge(customerId: string, pmId: string | null, amount: number, description: string, metadata: Record<string, string>, destinationAccountId?: string | null) {
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
  // Destination charge — routes the resulting money to the camp's own
  // connected Stripe account (see migrations/077_camp_stripe_connect.sql).
  // No Stripe-Account header, no change to the Customer/PaymentMethod used
  // above — only where the money settles. No platform fee.
  if (destinationAccountId) params["transfer_data[destination]"] = destinationAccountId;
  const resp = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return resp.json();
}

function todayISO() { return new Date().toISOString().split("T")[0]; }

// A family's REAL outstanding balance right now — billed minus paid minus
// credits, the same math get_my_balance/set_my_payment_plan use server-side
// (migrations 116/117). Computed fresh per family on every run so autopay
// never charges more than what's actually still owed:
//   - a parent who pays the full balance early (via the "pay in full" button,
//     which just posts a normal one-off payment with no idea a plan exists)
//     brings this to $0, so every remaining pending installment gets marked
//     covered instead of charged.
//   - a parent who pays some EXTRA amount ahead of schedule (payNow already
//     lets them type any amount, not just the exact next installment) brings
//     this below the sum of what's left, so a later installment gets capped
//     at whatever's actually still owed instead of blindly charging its
//     original scheduled amount and overcollecting.
function computeFamilyBalance(me: Record<string, any>, f: Record<string, any>, famKey: string): number {
  const camperIds: string[] = Array.isArray(f.camperIds) ? f.camperIds : [];
  const enr = (me.enrollments && typeof me.enrollments === "object") ? me.enrollments as Record<string, any> : {};
  const sessions: any[] = Array.isArray(me.sessions) ? me.sessions : [];

  let billed = 0;
  const myEnrIds = new Set<string>();
  for (const [enrId, eRaw] of Object.entries(enr)) {
    const e = eRaw as Record<string, any>;
    if (!e || !camperIds.includes(e.camperName)) continue;
    if (!["enrolled", "accepted"].includes(e.status)) continue;
    myEnrIds.add(enrId);
    const liveSession = sessions.find((s) => s && s.name === e.session);
    const liveT = liveSession ? Number(liveSession.tuition) : NaN;
    const tuition = (!Number.isNaN(liveT) && liveT > 0) ? liveT : (Number(e.sessionTuition) || 0);
    let disc = 0;
    if (e.discount && e.discount !== null) {
      disc = (Number(e.discount.amt) || 0) + Math.round(tuition * (Number(e.discount.pct) || 0) / 100);
    }
    billed += tuition - disc;
  }
  for (const ch of (Array.isArray(f.charges) ? f.charges : [])) {
    billed += Number((ch as Record<string, any>).amount) || 0;
  }

  let credits = 0;
  for (const cr of (Array.isArray(f.credits) ? f.credits : [])) {
    credits += Number((cr as Record<string, any>).amount) || 0;
  }

  let paid = 0;
  for (const pRaw of (Array.isArray(me.finance?.payments) ? me.finance.payments : [])) {
    const p = pRaw as Record<string, any>;
    if (!p) continue;
    const matches = p.familyKey === famKey || camperIds.includes(p.family) || myEnrIds.has(p.enrollmentId);
    if (!matches) continue;
    const amt = Number(p.amount) || 0;
    if (p.status === "pending" || p.status === "failed") continue;
    paid += amt;
  }

  return billed - paid - credits;
}

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

  // Batch-fetch every connected camp once, up front, instead of a per-family
  // lookup — this loop can iterate thousands of installments in one run.
  const { data: connectedCamps } = await supabase
    .from("camps")
    .select("id, stripe_account_id, stripe_charges_enabled")
    .not("stripe_account_id", "is", null)
    .eq("stripe_charges_enabled", true);
  const campDestinations = new Map<string, string>();
  for (const c of (connectedCamps || [])) {
    if (c.stripe_account_id) campDestinations.set(c.id, c.stripe_account_id);
  }

  for (const row of (rows || [])) {
    const me = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    if (!me || !me.families) continue;
    if (!me.finance) me.finance = {};
    if (!Array.isArray(me.finance.payments)) me.finance.payments = [];
    let dirty = false;

    for (const [famKey, fRaw] of Object.entries(me.families)) {
      const f = fRaw as Record<string, any>;
      if (!f.cardOnFile || !f.stripeCustomerId) continue;
      // A family can have MULTIPLE plans (migration 116) — normalize the
      // legacy singular f.plan into a one-item list so a pre-116 family
      // charges exactly as it always did.
      const plans: Record<string, any>[] = Array.isArray(f.plans)
        ? f.plans
        : (f.plan && Array.isArray(f.plan.installments) ? [f.plan] : []);
      if (!plans.some((p) => p && p.autopay && Array.isArray(p.installments))) continue;

      // One balance check per family per run, decremented as installments
      // get charged in this same run (several can be due the same day across
      // multiple plans) — see computeFamilyBalance's header comment.
      let remainingBalance = computeFamilyBalance(me, f, famKey);

      for (const plan of plans) {
        if (!plan || !plan.autopay || !Array.isArray(plan.installments)) continue;

        for (const inst of plan.installments) {
          if (inst.status !== "pending") continue;
          if (!inst.dueDate || inst.dueDate > today) continue; // not due yet
          const scheduledAmount = Number(inst.amount) || 0;
          if (scheduledAmount <= 0) { inst.status = "paid"; dirty = true; continue; }

          // Already paid off (in full, or by enough ahead-of-schedule
          // payments to cover what's left) — never charge, just mark covered.
          if (remainingBalance <= 0.005) {
            inst.status = "paid";
            inst.paidDate = today;
            inst.note = "Covered by an earlier payment — not charged";
            dirty = true;
            details.push({ camp: row.camp_id, family: f.name, amount: scheduledAmount, result: "waived_paid_ahead" });
            continue;
          }

          // Cap the charge at what's actually still owed — a parent who paid
          // some extra ahead of schedule shouldn't be re-charged the full
          // original installment amount once the real balance is lower.
          const amount = Math.min(scheduledAmount, remainingBalance);
          const camperName = (Array.isArray(f.camperIds) && f.camperIds[0]) ? f.camperIds[0] : (f.name || "");
          const pi = await stripeCharge(
            f.stripeCustomerId, f.stripePaymentMethodId || null, amount,
            `Autopay installment — ${f.name || famKey}`,
            { campId: String(row.camp_id), familyKey: famKey, familyName: camperName, planId: plan.id || "", source: "autopay" },
            campDestinations.get(String(row.camp_id)) || null,
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
            if (amount < scheduledAmount) inst.amount = amount; // reflect what was actually charged
            me.finance.payments.push({
              id: "auto_" + pi.id, family: camperName, familyKey: famKey,
              amount: amount, date: today, method: "Autopay (card)",
              reference: pi.id, notes: "Monthly autopay installment",
              stripePaymentIntentId: pi.id, status: "succeeded", timestamp: Date.now(),
            });
            charged++;
            remainingBalance -= amount;
            details.push({ camp: row.camp_id, family: f.name, amount, result: "charged" });
          } else {
            // processing (e.g. slower method) — leave pending-ish but note it
            details.push({ camp: row.camp_id, family: f.name, amount, result: pi.status });
          }
          dirty = true;
        }
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
