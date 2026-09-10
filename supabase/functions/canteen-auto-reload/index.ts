// =============================================================================
// canteen-auto-reload — the canteen auto-reload runner (threshold + scheduled)
//
// Meant to be called on a recurring schedule by pg_cron (see
// CANTEEN_AUTORELOAD_SETUP.md) — every 30 minutes during camp hours is the
// suggested cadence, since a low canteen balance should resolve same-day, not
// wait for a once-a-day job. For every camp it scans
// campistrySnacks.accounts for camper accounts that have autoReload.enabled
// === true and a saved card, then charges AT MOST ONE reload per run, based
// on whichever trigger is due:
//   - THRESHOLD: thresholdEnabled && balance < thresholdAmount
//   - SCHEDULE:  scheduleEnabled && today matches scheduleFrequency/scheduleDay
// both gated by `lastChargedDate !== today` so a camper is never charged
// more than once per calendar day even if the cron fires every 30 minutes or
// both triggers are due the same day.
//
// TWO PROCESSOR PATHS, because the saved card can be either kind (migration
// 136 added Cardknox/Sola card-save for auto-reload alongside the original
// Stripe-only setup-mode Checkout):
//   - Stripe (autoReload.stripeCustomerId, saved via
//     stripe-canteen-autoreload-setup + stripe-webhook's
//     handleCanteenAutoReloadSetup): this function only CREATES the
//     PaymentIntent — it does NOT credit the balance itself. Each charge is
//     tagged metadata.source='campistry-canteen-deposit' (the same value a
//     manual "Add Funds" deposit uses), so the EXISTING stripe-webhook
//     handleCanteenDeposit handler credits the balance via
//     credit_canteen_balance_from_stripe once Stripe confirms
//     payment_intent.succeeded.
//   - Cardknox/Sola (autoReload.byopCustomerRef, saved via
//     cardknox-checkout-start's canteen_autoreload_setup kind +
//     cardknox-webhook): a direct gateway charge (cc:sale) is synchronous —
//     its response IS the confirmation, there's no webhook round trip — so
//     THIS function credits the balance itself, immediately, via
//     credit_canteen_balance_from_processor (idempotent on the gateway's own
//     xRefNum, same as every other Cardknox crediting path in this codebase).
// Either way this function only ever writes lastChargedDate/lastFailureDate/
// consecutiveFailures on the autoReload block itself — never double-credits,
// and never touches the other processor's fields.
//
// A card that fails 3 times in a row (autoReload.consecutiveFailures hits 3)
// has auto-reload auto-disabled (enabled:false) to avoid repeated decline
// fees / spamming the gateway — the parent portal surfaces this as
// "Auto-reload paused" and offers to update the card, which also resets the
// failure count (migrations/109_canteen_auto_reload.sql, re-enable branch).
//
// Auth: requires header  x-cron-secret: <CANTEEN_AUTORELOAD_CRON_SECRET>  —
// a separate secret from charge-due-installments' INSTALLMENT_CRON_SECRET so
// the two recurring jobs can be rotated/disabled independently.
//
// INSTANT TRIGGER (no cron secret): a POS sale that pushes a camper under
// their threshold shouldn't have to wait for the next 30-min cron tick.
// campistry_snacks_pos.js fires a scoped, session-authenticated call right
// after such a sale — POST { campId, camperName } with the POS's own Bearer
// JWT (no x-cron-secret). That path is authorized separately (the caller
// must be real staff — owner or any camp_users row — of exactly that camp,
// same bar submit_canteen_purchase itself already requires) and is HARD
// restricted to that one camp_id/camperName — it can never trigger the
// unscoped, every-camp scan the cron secret gates. Whether anything is
// actually due is still decided the same way either path: dueAmount() below
// is the sole authority, so a spurious instant call (e.g. the client's own
// cheap pre-check in migration 140 was a false positive) just no-ops.
//
// Response: { ok, charged, failed, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
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

// Inlined rather than imported — same "no shared module between Edge
// Functions" convention charge-due-installments' own copy of this helper
// documents; keep the two in sync by hand if the gateway call ever changes.
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxCharge(apiKey: string, amountCents: number, cardToken: string) {
  const resp = await fetch(CARDKNOX_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      xKey: apiKey,
      xVersion: "4.5.9",
      xSoftwareName: "Campistry",
      xSoftwareVersion: "1.0",
      xCommand: "cc:sale",
      xAmount: (amountCents / 100).toFixed(2),
      xToken: cardToken,
      xInvoice: "AR-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    }).toString(),
  });
  const parsed: Record<string, string> = {};
  new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
  if (parsed.xResult !== "A") {
    return { success: false, error: parsed.xError || "Declined", raw: parsed };
  }
  return { success: true, externalTransactionId: parsed.xRefNum, raw: parsed };
}

function todayISO() { return new Date().toISOString().split("T")[0]; }

// Optional parent-set [startDate,stopDate] window (migration 135) — either
// end may be null. Plain string comparison is safe since both `today` and
// the stored bounds are always 'YYYY-MM-DD'. This is the ONLY place the
// window is enforced — the RPC that saves it (set_canteen_auto_reload) just
// validates and stores, it never blocks a charge itself.
function inActiveWindow(ar: Record<string, any>, today: string): boolean {
  if (ar.startDate && today < ar.startDate) return false;
  if (ar.stopDate && today > ar.stopDate) return false;
  return true;
}

// Whichever trigger is due, using UTC day-of-week/day-of-month — matches
// submit_canteen_purchase's own `(now() AT TIME ZONE 'utc')::date` day
// boundary, so "today" means the same thing everywhere in the canteen system.
function dueAmount(ar: Record<string, any>, balance: number, today: string): { amount: number; kind: string } | null {
  if (ar.lastChargedDate === today) return null; // already reloaded today
  if (!inActiveWindow(ar, today)) return null; // outside the parent's chosen date range
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

function markFailure(ar: Record<string, any>, today: string, reason: string) {
  ar.lastFailureDate = today;
  ar.lastFailureReason = reason;
  ar.consecutiveFailures = (Number(ar.consecutiveFailures) || 0) + 1;
  if (ar.consecutiveFailures >= 3) ar.enabled = false; // stop retrying a dead/declining card
}

function markSuccess(ar: Record<string, any>, today: string, amount: number) {
  ar.lastChargedDate = today;
  ar.lastChargeAmount = amount;
  ar.consecutiveFailures = 0;
  delete ar.lastFailureDate;
  delete ar.lastFailureReason;
}

// Same authorization bar submit_canteen_purchase (migration 026) itself
// requires: the caller must be the camp's owner or any camp_users row for
// this exact camp — counselors running the POS included. Resolved from the
// caller's own JWT via the anon-key client, never trusted from the request
// body.
async function callerIsStaffOfCamp(req: Request, campId: string): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY || !campId) return false;
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return false;
  const { data: owned } = await asUser.from("camps").select("id").eq("id", campId).eq("owner", uid).maybeSingle();
  if (owned?.id) return true;
  const { data: membership } = await asUser.from("camp_users").select("camp_id").eq("camp_id", campId).eq("user_id", uid).maybeSingle();
  return !!membership;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const isCron = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;

  // Not the cron → this must be an instant, single-camper check triggered
  // right after a POS sale. Require an explicit camp+camper AND a real
  // staff session for exactly that camp — never allow an unscoped scan
  // without the cron secret.
  let scopeCampId: string | null = null;
  let scopeCamperName: string | null = null;
  if (!isCron) {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no/invalid body */ }
    scopeCampId = typeof body.campId === "string" ? body.campId : null;
    scopeCamperName = typeof body.camperName === "string" ? body.camperName : null;
    if (!scopeCampId || !scopeCamperName || !(await callerIsStaffOfCamp(req, scopeCampId))) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const today = todayISO();
  let charged = 0, failed = 0;
  const details: Record<string, unknown>[] = [];

  let kvQuery = supabase.from("camp_state_kv").select("camp_id, value").eq("key", "campistrySnacks");
  if (scopeCampId) kvQuery = kvQuery.eq("camp_id", scopeCampId);
  const { data: rows, error } = await kvQuery;
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: connectedCamps } = await supabase
    .from("camps")
    .select("id, stripe_account_id, stripe_charges_enabled, payment_processor_key")
    .not("stripe_account_id", "is", null)
    .eq("stripe_charges_enabled", true);
  const campDestinations = new Map<string, string>();
  for (const c of (connectedCamps || [])) {
    if (c.stripe_account_id) campDestinations.set(c.id, c.stripe_account_id);
  }

  // BYOP processor key per camp (only Cardknox/Sola is wired for auto-reload
  // so far — same scoping decision charge-due-installments already made for
  // autopay). Credentials fetched lazily and cached, one RPC call per camp
  // regardless of how many campers on it have auto-reload enabled.
  const { data: allCamps } = await supabase.from("camps").select("id, payment_processor_key");
  const campProcessors = new Map<string, string>();
  for (const c of (allCamps || [])) {
    if (c.payment_processor_key && c.payment_processor_key !== "stripe") campProcessors.set(c.id, c.payment_processor_key);
  }
  const credCache = new Map<string, Record<string, string> | null>();
  async function byopCredentials(campId: string): Promise<Record<string, string> | null> {
    if (credCache.has(campId)) return credCache.get(campId) || null;
    const { data: credResult } = await supabase.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    const creds = credResult?.success ? (credResult.credentials as Record<string, string>) : null;
    if (!creds) console.warn(`[canteen-auto-reload] camp ${campId} is on a BYOP processor but has no verified credential — skipping its auto-reload`);
    credCache.set(campId, creds);
    return creds;
  }

  for (const row of (rows || [])) {
    const snacks = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    if (!snacks || !snacks.accounts) continue;
    let dirty = false;

    for (const [camperName, acctRaw] of Object.entries(snacks.accounts)) {
      if (scopeCamperName && camperName !== scopeCamperName) continue;
      const acct = acctRaw as Record<string, any>;
      const ar = acct.autoReload;
      if (!ar || !ar.enabled || !ar.cardOnFile) continue;
      if (!ar.stripeCustomerId && !ar.byopCustomerRef) continue; // enabled but no card saved through either flow yet

      const due = dueAmount(ar, Number(acct.balance) || 0, today);
      if (!due || due.amount <= 0) continue;

      if (ar.byopCustomerRef) {
        // Cardknox/Sola path — a direct gateway charge, synchronous, so
        // this function credits the balance itself instead of waiting on a
        // webhook (there isn't one for cc:sale calls made directly like this).
        const processorKey = campProcessors.get(String(row.camp_id));
        if (processorKey !== "cardknox") {
          // Card was saved on a processor auto-reload doesn't know how to
          // charge yet (or the camp switched processors since saving it) —
          // leave enabled, don't burn a failure on the family for something
          // that isn't their fault. Flagged, not silently dropped.
          details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "skipped_no_processor", processor: processorKey || "unknown" });
          continue;
        }
        const creds = await byopCredentials(String(row.camp_id));
        const apiKey = creds?.apiKey || null;
        if (!apiKey) {
          details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "skipped_no_processor", processor: "cardknox" });
          continue;
        }
        const res = await cardknoxCharge(apiKey, Math.round(due.amount * 100), String(ar.byopCustomerRef));
        if (!res.success || !res.externalTransactionId) {
          markFailure(ar, today, res.error || "Declined");
          failed++;
          details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "failed", reason: res.error || "Declined" });
          dirty = true;
          continue;
        }
        const creditRes = await supabase.rpc("credit_canteen_balance_from_processor", {
          p_camp_id: row.camp_id,
          p_camper_name: camperName,
          p_amount: due.amount,
          p_processor_key: "cardknox",
          p_external_transaction_id: res.externalTransactionId,
        });
        if (creditRes.error || !creditRes.data?.success) {
          // Money was captured but the credit write failed — worth loud
          // logging for office follow-up rather than silently losing the
          // deposit; still record the charge as successful (it was) so
          // lastChargedDate/consecutiveFailures reflect reality and the
          // cron doesn't try to charge the card again today.
          console.error(`[canteen-auto-reload] cardknox charge ${res.externalTransactionId} succeeded but credit failed for camp ${row.camp_id}/${camperName}:`, creditRes.error?.message || creditRes.data?.error);
        }
        markSuccess(ar, today, due.amount);
        charged++;
        details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "charged", processor: "cardknox" });
        dirty = true;
        continue;
      }

      // Stripe path (unchanged from before BYOP support was added).
      if (!STRIPE_SECRET) {
        details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "skipped_no_processor", processor: "stripe" });
        continue;
      }
      const pi = await stripeCharge(
        ar.stripeCustomerId, ar.stripePaymentMethodId || null, due.amount,
        `Canteen auto-reload (${due.kind}) — ${camperName}`,
        { campId: String(row.camp_id), camperName, source: "campistry-canteen-deposit", auto: "true" },
        campDestinations.get(String(row.camp_id)) || null,
      );

      if (pi.error || pi.status === "requires_action") {
        const reason = pi.error?.message || "requires_authentication";
        markFailure(ar, today, reason);
        failed++;
        details.push({ camp: row.camp_id, camper: camperName, amount: due.amount, kind: due.kind, result: "failed", reason });
      } else if (pi.status === "succeeded" || pi.status === "processing") {
        // Balance crediting happens asynchronously via stripe-webhook's
        // handleCanteenDeposit once Stripe confirms payment_intent.succeeded
        // — this function never touches `balance` on the Stripe path.
        markSuccess(ar, today, due.amount);
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
