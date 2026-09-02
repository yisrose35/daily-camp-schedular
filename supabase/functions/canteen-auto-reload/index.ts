// =============================================================================
// canteen-auto-reload — the canteen auto-reload runner (threshold + scheduled)
//
// Meant to be called on a recurring schedule by pg_cron (see
// CANTEEN_AUTORELOAD_SETUP.md) — every 30 minutes during camp hours is the
// suggested cadence, since a low canteen balance should resolve same-day, not
// wait for a once-a-day job. For every camp it scans
// campistrySnacks.accounts for camper accounts that have:
//   - autoReload.enabled === true
//   - autoReload.cardOnFile + autoReload.stripeCustomerId (saved via
//     stripe-canteen-autoreload-setup + stripe-webhook's
//     handleCanteenAutoReloadSetup)
// and, per account, charges AT MOST ONE reload per run, based on whichever
// trigger is due:
//   - THRESHOLD: thresholdEnabled && balance < thresholdAmount
//   - SCHEDULE:  scheduleEnabled && today matches scheduleFrequency/scheduleDay
// both gated by `lastChargedDate !== today` so a camper is never charged
// more than once per calendar day even if the cron fires every 30 minutes or
// both triggers are due the same day.
//
// IMPORTANT: this function only CREATES the Stripe charge — it does NOT
// credit the canteen balance itself. Each charge is tagged
// metadata.source='campistry-canteen-deposit' (the same value a manual "Add
// Funds" deposit uses), so the EXISTING stripe-webhook handleCanteenDeposit
// handler credits the balance via credit_canteen_balance_from_stripe once
// Stripe confirms payment_intent.succeeded — no new crediting RPC needed,
// and no risk of this function and the webhook double-crediting the same
// charge (this function only ever writes lastChargedDate/lastFailureDate/
// consecutiveFailures, never `balance`).
//
// A card that fails 3 times in a row (config.autoReload.consecutiveFailures
// hits 3) has auto-reload auto-disabled (enabled:false) to avoid repeated
// decline fees / spamming Stripe — the parent portal surfaces this as
// "Auto-reload paused" and offers to update the card, which also resets the
// failure count (migrations/109_canteen_auto_reload.sql, re-enable branch).
//
// Auth: requires header  x-cron-secret: <CANTEEN_AUTORELOAD_CRON_SECRET>  —
// a separate secret from charge-due-installments' INSTALLMENT_CRON_SECRET so
// the two recurring jobs can be rotated/disabled independently.
//
// Response: { ok, charged, failed, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("CANTEEN_AUTORELOAD_CRON_SECRET") || "";

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
  // connected Stripe account, same as every other canteen/tuition charge.
  if (destinationAccountId) params["transfer_data[destination]"] = destinationAccountId;
  const resp = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return resp.json();
}

function todayISO() { return new Date().toISOString().split("T")[0]; }

// Whichever trigger is due, using UTC day-of-week/day-of-month — matches
// submit_canteen_purchase's own `(now() AT TIME ZONE 'utc')::date` day
// boundary, so "today" means the same thing everywhere in the canteen system.
function dueAmount(ar: Record<string, any>, balance: number, today: string): { amount: number; kind: string } | null {
  if (ar.lastChargedDate === today) return null; // already reloaded today
  if (ar.thresholdEnabled && typeof ar.thresholdAmount === "number" && balance < ar.thresholdAmount) {
    return { amount: Number(ar.thresholdReloadAmount) || 0, kind: "threshold" };
  }
  if (ar.scheduleEnabled) {
    const now = new Date();
    const dow = now.getUTCDay();       // 0-6, Sunday=0
    const dom = now.getUTCDate();      // 1-31
    const matches = ar.scheduleFrequency === "weekly"
      ? Number(ar.scheduleDay) === dow
      : ar.scheduleFrequency === "monthly"
        ? Number(ar.scheduleDay) === dom
        : false;
    if (matches) return { amount: Number(ar.scheduleReloadAmount) || 0, kind: "schedule" };
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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
    .select("camp_id, value").eq("key", "campistrySnacks");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

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
    const snacks = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    if (!snacks || !snacks.accounts) continue;
    let dirty = false;

    for (const [camperName, acctRaw] of Object.entries(snacks.accounts)) {
      const acct = acctRaw as Record<string, any>;
      const ar = acct.autoReload;
      if (!ar || !ar.enabled || !ar.cardOnFile || !ar.stripeCustomerId) continue;

      const due = dueAmount(ar, Number(acct.balance) || 0, today);
      if (!due || due.amount <= 0) continue;

      const pi = await stripeCharge(
        ar.stripeCustomerId, ar.stripePaymentMethodId || null, due.amount,
        `Canteen auto-reload (${due.kind}) — ${camperName}`,
        { campId: String(row.camp_id), camperName, source: "campistry-canteen-deposit", auto: "true" },
        campDestinations.get(String(row.camp_id)) || null,
      );

      if (pi.error || pi.status === "requires_action") {
        const reason = pi.error?.message || "requires_authentication";
        ar.lastFailureDate = today;
        ar.lastFailureReason = reason;
        ar.consecutiveFailures = (Number(ar.consecutiveFailures) || 0) + 1;
        if (ar.consecutiveFailures >= 3) ar.enabled = false; // stop retrying a dead/declining card
        failed++;
        details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "failed", reason });
      } else if (pi.status === "succeeded" || pi.status === "processing") {
        // Balance crediting happens asynchronously via stripe-webhook's
        // handleCanteenDeposit once Stripe confirms payment_intent.succeeded
        // — this function never touches `balance` itself.
        ar.lastChargedDate = today;
        ar.lastChargeAmount = due.amount;
        ar.consecutiveFailures = 0;
        delete ar.lastFailureDate;
        delete ar.lastFailureReason;
        charged++;
        details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "charged", stripeStatus: pi.status });
      } else {
        details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: pi.status });
      }
      dirty = true;
    }

    if (dirty) {
      const up = await supabase.from("camp_state_kv").upsert(
        { camp_id: row.camp_id, key: "campistrySnacks", value: snacks, updated_at: new Date().toISOString() },
        { onConflict: "camp_id,key" },
      );
      if (up.error) console.warn(`[canteen-auto-reload] write failed for camp ${row.camp_id}: ${up.error.message}`);
    }
  }

  console.log(`[canteen-auto-reload] done — charged ${charged}, failed ${failed}`);
  return new Response(
    JSON.stringify({ ok: true, charged, failed, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
