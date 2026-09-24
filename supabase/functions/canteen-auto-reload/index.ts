// =============================================================================
// canteen-auto-reload — the canteen auto-reload runner (threshold + scheduled)
//
// Meant to be called on a recurring schedule by pg_cron (see
// CANTEEN_AUTORELOAD_SETUP.md) — every 30 minutes during camp hours is the
// suggested cadence, since a low canteen balance should resolve same-day, not
// wait for a once-a-day job. For every camp it reads the canteen account ROWS
// (canteen_autoreload_accounts, migration 243 — never the campistrySnacks
// document, whose accounts are stripped since 219) for camper accounts that
// have autoReload.enabled === true and a saved card, then charges AT MOST ONE
// reload per run, based
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

// ── receipts ────────────────────────────────────────────────────────────────
// Emailing the parent a receipt is the last step of taking money, not an extra.
// It is dispatched, never awaited for correctness: the money is already taken,
// so a receipt that fails must never fail — or retry — the charge. send-payment-
// receipt is idempotent on the payment reference, so several callers racing for
// the same payment produce exactly one email.
async function sendReceipt(o: Record<string, unknown>) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-payment-receipt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(o),
    });
    if (!r.ok) console.warn(`[receipt] dispatch returned ${r.status} for ref ${String(o.ref || "")}`);
  } catch (e) {
    console.warn("[receipt] dispatch failed:", (e as Error)?.message);
  }
}


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

async function stripeCharge(customerId: string, pmId: string | null, amount: number, description: string, metadata: Record<string, string>, destinationAccountId?: string | null, idempotencyKey?: string) {
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
  // on_behalf_of makes the CAMP the settlement merchant, which is the whole
  // point: a destination charge without it settles on the platform, so the
  // cardholder's statement carries the PLATFORM's descriptor. A parent who
  // pays their camp and finds a charge from a company they have never heard
  // of disputes it — and a dispute over an unrecognised descriptor is the
  // single most documented avoidable chargeback there is. With on_behalf_of
  // the statement uses the connected account's descriptor, i.e. the camp's.
  // Stripe requires it to EQUAL transfer_data[destination] for card
  // payments, so the two are always set together, from the same value.
  if (destinationAccountId) {
    params["transfer_data[destination]"] = destinationAccountId;
    params["on_behalf_of"] = destinationAccountId;
  }
  const headers: Record<string, string> = { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let resp: Response;
  try {
    resp = await fetch(`${STRIPE_API}/payment_intents`, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    // Cut off: whether Stripe charged is unknown — NOT a decline (TED-094).
    return { error: { message: (e as Error).message }, unknownOutcome: true };
  }
  let body: any = {};
  try { body = await resp.json(); } catch { /* not JSON */ }
  // A Stripe server error (or a concurrent try with the same key) is not a
  // decline either: the retry must repeat THIS key so Stripe answers with what
  // it did, instead of starting a second charge under a new one.
  if (resp.status >= 500 || resp.status === 409 || body?.error?.type === "api_error"
      || body?.error?.type === "idempotency_error") {
    return Object.assign({ error: { message: `Stripe ${resp.status}` } }, body, { unknownOutcome: true });
  }
  return body;
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

// Banquest (AffiniPay/8am) sale against a saved card_ref — inlined for the same
// Dashboard-deploy reason as the Cardknox call above; keep in sync with
// _shared/adapters/banquest_adapter.ts. Auth is HTTP Basic base64(sourceKey:
// pin); API base is per-camp and lives under /api/v2; amounts are DOLLARS; a
// saved card is charged as source "tkn-<card_ref>". Approval is reported by
// status_code "A" (status "Approved"); the transaction's integer
// `reference_number` is what we store to later refund/reverse it.
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  // A stored gatewayUrl that already ends in /v2 or /api/v2 is used verbatim;
  // a bare host gets /api/v2 appended. Both spellings are honoured on purpose:
  // the API reference documents the base as /api/v2, while the Hosted
  // Tokenization guide's own backend example posts to /v2 — so whichever path
  // the camp actually stores is the one we call.
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
async function banquestCharge(creds: Record<string, string>, amountCents: number, cardRef: string) {
  const resp = await fetch(`${bqBase(creds)}/transactions/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${creds.sourceKey}:${creds.pin}`) },
    // A saved card is either a verify card_ref (charged "tkn-<ref>") or a
    // Customer payment-method saved on the hosted page (already stored WITH its
    // "pm-<id>" prefix). Pass an already-prefixed ref through untouched.
    body: JSON.stringify({ amount: Number((amountCents / 100).toFixed(2)), source: /^(tkn-|pm-|ref-|nonce-)/.test(cardRef) ? cardRef : "tkn-" + cardRef }),
  });
  let data: Record<string, any> = {};
  try { data = await resp.json(); } catch { /* non-JSON error body */ }
  const approved = String(data?.status_code || "").toUpperCase() === "A"
                || String(data?.status || "").toLowerCase() === "approved";
  const ref = data?.reference_number != null ? String(data.reference_number) : "";
  if (resp.status < 200 || resp.status >= 300 || !approved || !ref) {
    const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Declined (HTTP ${resp.status})`;
    return { success: false, error: errMsg, raw: data };
  }
  return { success: true, externalTransactionId: ref, raw: data };
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

// N-days-ago cutoff (UTC, YYYY-MM-DD), inclusive of `today` — a 1-day
// window means "just today", a 14-day window means today plus the
// preceding 13 days.
function daysAgoISO(days: number, today: string): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().split("T")[0];
}

// Configurable "at most N reloads within a rolling M-day window" cap
// (migration 143) — replaces the old hardcoded "once per calendar day".
// maxReloadsPerPeriod=1/reloadPeriodDays=1 (the default when unset)
// reproduces that exact prior behavior. reloadHistory is a plain array of
// ISO dates, one appended per successful charge by markSuccess; an account
// saved before this migration has no reloadHistory yet, so fall back to
// treating lastChargedDate as a single-entry history.
function reloadsWithinCap(ar: Record<string, any>, today: string): boolean {
  const max = Number(ar.maxReloadsPerPeriod) || 1;
  const periodDays = Number(ar.reloadPeriodDays) || 1;
  const cutoff = daysAgoISO(periodDays, today);
  const history: string[] = Array.isArray(ar.reloadHistory) ? ar.reloadHistory
    : (ar.lastChargedDate ? [ar.lastChargedDate] : []);
  const countInWindow = history.filter((d) => typeof d === "string" && d >= cutoff && d <= today).length;
  return countInWindow < max;
}

// Whichever trigger is due, using UTC day-of-week/day-of-month — matches
// submit_canteen_purchase's own `(now() AT TIME ZONE 'utc')::date` day
// boundary, so "today" means the same thing everywhere in the canteen system.
function dueAmount(ar: Record<string, any>, balance: number, today: string): { amount: number; kind: string } | null {
  if (!reloadsWithinCap(ar, today)) return null; // frequency cap already hit for this window
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
  if (!Array.isArray(ar.reloadHistory)) ar.reloadHistory = [];
  ar.reloadHistory.push(today);
  // Bound growth — far more than any realistic reloadPeriodDays (max 90) x
  // maxReloadsPerPeriod (max 20) combination would ever need to look back
  // through, so trimming here never affects reloadsWithinCap's count.
  if (ar.reloadHistory.length > 200) ar.reloadHistory = ar.reloadHistory.slice(-200);
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


/** A camper's name as a person reads it: without the roster's internal
 *  " #<number>" that tells two campers with one name apart. For what a parent
 *  sees; never for identifying the camper. */
function displayName(s: unknown): string {
  return String(s ?? "").replace(/\s#\d+(?:-\d+)?$/, "");
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
  // The camper's number, when the page sends it, decides which account this
  // is; the name is only the fallback for a caller that has no number.
  let camperIdScope: number | null = null;
  if (!isCron) {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no/invalid body */ }
    scopeCampId = typeof body.campId === "string" ? body.campId : null;
    camperIdScope = /^\d+$/.test(String(body.camperId ?? "")) && Number(body.camperId) > 0 ? Number(body.camperId) : null;
    scopeCamperName = camperIdScope == null && typeof body.camperName === "string" ? body.camperName : null;
    if (!scopeCampId || (camperIdScope == null && !scopeCamperName) || !(await callerIsStaffOfCamp(req, scopeCampId))) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const today = todayISO();
  let charged = 0, failed = 0;
  const details: Record<string, unknown>[] = [];

  // The accounts come from camp_canteen_accounts, through
  // canteen_autoreload_accounts (migration 243) — NOT from
  // campistrySnacks.accounts. 219 made the rows the truth and the page strips
  // `accounts` out of every document save, so reading the document found
  // nobody after a camp's first save and this job charged no one, every night.
  //
  // Each account is keyed here by the camper's CURRENT name, which every
  // canteen writer resolves to that person's account. The account key is not
  // used: after a rename it is the old spelling, and if another child now
  // carries it the writers would resolve it to them.
  const { data: acctRows, error } = await supabase.rpc("canteen_autoreload_accounts",
    scopeCampId ? { p_camp_id: scopeCampId } : {});
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const unresolvable: Record<string, unknown>[] = [];
  const byCamp = new Map<string, Array<{ camperName: string; camperId: number | null; acct: Record<string, any> }>>();
  for (const a of (acctRows || []) as Record<string, any>[]) {
    if (!a.resolvable) {
      // An unattributed account whose key is now somebody else's name. Charging
      // its card would credit the wrong child — skipped, and reported.
      unresolvable.push({ camp: a.camp_id, camper: a.account_key, result: "skipped_unresolvable_account" });
      continue;
    }
    const campKey = String(a.camp_id);
    if (!byCamp.has(campKey)) byCamp.set(campKey, []);
    // The camper's ID rides with the account, and every write below sends it.
    // The name beside it is the camper's current name: for display, and the
    // fallback for an account that has no number yet.
    const camperId = a.person_id != null && /^\d+$/.test(String(a.person_id)) ? Number(a.person_id) : null;
    byCamp.get(campKey)!.push({ camperId, camperName: String(a.camper_name), acct: Object.assign({}, a.account || {}, { camperId }) });
  }
  // One entry per camp with its list of accounts.
  const rows = [...byCamp.entries()].map(([camp_id, accounts]) => ({ camp_id, accounts }));

  const { data: connectedCamps } = await supabase
    .from("camps")
    .select("id, stripe_account_id, stripe_charges_enabled, payment_processor_key, name")
    .not("stripe_account_id", "is", null)
    .eq("stripe_charges_enabled", true);
  const campDestinations = new Map<string, string>();
  for (const c of (connectedCamps || [])) {
    if (c.stripe_account_id) campDestinations.set(c.id, c.stripe_account_id);
  }
  // The camp's NAME, from the same round trip. It is what the parent reads on
  // their statement and receipt; a charge called "Camp payment" tells them
  // nothing about which camp, and an unrecognised charge is a chargeback.
  const campNames = new Map<string, string>();
  for (const c of (connectedCamps || [])) {
    if (c.name) campNames.set(c.id, String(c.name).trim());
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

  // Persist ONE camper's autoReload bookkeeping (lastChargedDate/reloadHistory/
  // consecutiveFailures/enabled) atomically, without touching balance or
  // transactions. Must be used instead of re-upserting the whole campistrySnacks
  // blob: on the Cardknox path credit_canteen_balance_from_processor has
  // already committed the balance+deposit to this row, and a full-blob upsert
  // of the pre-credit in-memory snapshot would erase it (confirmed live).
  async function persistAr(campId: string, camperName: string, ar: Record<string, any>, camperId: number | null = null) {
    const res = await supabase.rpc("update_canteen_autoreload_state", {
      p_camp_id: campId, p_camper_name: camperName, p_camper_id: camperId, p_autoreload: ar,
    });
    if (res.error || !res.data?.success) {
      console.warn(`[canteen-auto-reload] autoReload-state write failed for ${campId}/${camperName}: ${res.error?.message || res.data?.error}`);
    }
  }

  details.push(...unresolvable);

  for (const row of (rows || [])) {
    for (const { camperName, camperId, acct } of row.accounts) {
      // The number decides; a name-only caller (no number sent) matches by name.
      if (camperIdScope != null ? camperId !== camperIdScope : (scopeCamperName && camperName !== scopeCamperName)) continue;
      const ar = acct.autoReload;
      if (!ar || !ar.enabled || !ar.cardOnFile) continue;
      if (!ar.stripeCustomerId && !ar.byopCustomerRef) continue; // enabled but no card saved through either flow yet

      const due = dueAmount(ar, Number(acct.balance) || 0, today);
      if (!due || due.amount <= 0) continue;

      // ONE reload per camper per slot (TED-075). Two runs at once — the
      // 30-minute cron and a parent's purchase triggering it, say — both read
      // the same balance and both charged. The claim is taken before the card
      // is charged: the loser skips; a decline gives it back.
      const reloadsToday = (Array.isArray(ar.reloadHistory) ? ar.reloadHistory : []).filter((d: string) => d === today).length;
      const reloadKey = `reload:${camperId != null ? camperId : camperName}:${today}:${reloadsToday}`;
      const { data: rclaim } = await supabase.rpc("claim_refund_intent", {
        p_camp_id: row.camp_id, p_key: reloadKey, p_amount: due.amount, p_payment_ref: String(camperId ?? camperName),
      });
      if (rclaim && rclaim.claimed === false) {
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "already_reloaded" });
        continue;
      }
      const releaseReload = () => supabase.rpc("release_refund_intent", { p_camp_id: row.camp_id, p_key: reloadKey });

      if (ar.byopCustomerRef) {
        // Cardknox/Sola path — a direct gateway charge, synchronous, so
        // this function credits the balance itself instead of waiting on a
        // webhook (there isn't one for cc:sale calls made directly like this).
        const processorKey = campProcessors.get(String(row.camp_id));
        if (processorKey !== "cardknox" && processorKey !== "banquest") {
          // Card was saved on a processor auto-reload doesn't know how to
          // charge yet (or the camp switched processors since saving it) —
          // leave enabled, don't burn a failure on the family for something
          // that isn't their fault. Flagged, not silently dropped.
          details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "skipped_no_processor", processor: processorKey || "unknown" });
          await releaseReload();
          continue;
        }
        const creds = await byopCredentials(String(row.camp_id));
        const hasCred = processorKey === "cardknox" ? !!creds?.apiKey : (!!creds?.sourceKey && !!creds?.pin);
        if (!creds || !hasCred) {
          details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "skipped_no_processor", processor: processorKey });
          await releaseReload();
          continue;
        }
        const res = processorKey === "cardknox"
          ? await cardknoxCharge(String(creds.apiKey), Math.round(due.amount * 100), String(ar.byopCustomerRef))
          : await banquestCharge(creds, Math.round(due.amount * 100), String(ar.byopCustomerRef));
        if (!res.success || !res.externalTransactionId) {
          await releaseReload();
          markFailure(ar, today, res.error || "Declined");
          failed++;
          details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "failed", reason: res.error || "Declined" });
          await persistAr(String(row.camp_id), camperName, ar, camperId);
          continue;
        }
        const creditRes = await supabase.rpc("credit_canteen_balance_from_processor", {
          p_camp_id: row.camp_id,
          p_camper_id: camperId, p_camper_name: camperName,
          p_amount: due.amount,
          p_processor_key: processorKey,
          p_external_transaction_id: res.externalTransactionId,
          // Marks the ledger row kind:'autoreload' so the parent portal shows
          // an "Auto-Pay" tag on it (migration 145). Harmless before 145 is
          // applied — the old 5-arg function ignores the extra key.
          p_source: "autoreload",
        });
        if (creditRes.error || !creditRes.data?.success) {
          // Money was captured but the credit write failed — worth loud
          // logging for office follow-up rather than silently losing the
          // deposit; still record the charge as successful (it was) so
          // lastChargedDate/consecutiveFailures reflect reality and the
          // cron doesn't try to charge the card again today.
          console.error(`[canteen-auto-reload] ${processorKey} charge ${res.externalTransactionId} succeeded but credit failed for camp ${row.camp_id}/${camperName}:`, creditRes.error?.message || creditRes.data?.error);
        }
        markSuccess(ar, today, due.amount);
        charged++;
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "charged", processor: processorKey });
        // persist autoReload bookkeeping ONLY — the balance/deposit was
        // already committed by credit_canteen_balance_from_processor above.
        await persistAr(String(row.camp_id), camperName, ar, camperId);
        continue;
      }

      // Stripe path (unchanged from before BYOP support was added).
      if (!STRIPE_SECRET) {
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "skipped_no_processor", processor: "stripe" });
        await releaseReload();
        continue;
      }
      const pi = await stripeCharge(
        ar.stripeCustomerId, ar.stripePaymentMethodId || null, due.amount,
        `${campNames.get(String(row.camp_id)) || "Camp"} — canteen auto-reload (${due.kind}), ${displayName(camperName)}`,
        { campId: String(row.camp_id), camperName, camperId: camperId != null ? String(camperId) : "", source: "campistry-canteen-deposit", auto: "true" },
        campDestinations.get(String(row.camp_id)) || null,
        // The failure count makes a retry after a decline a NEW request
        // (TED-085): Stripe replays a key's first answer — the decline — for
        // 24 hours, and three replays would switch auto-reload off for a
        // parent who had already fixed their card.
        `${row.camp_id}:${reloadKey}:f${Number(ar.consecutiveFailures) || 0}`,
      );

      if (pi.unknownOutcome) {
        // Neither a charge nor a decline: give the slot back WITHOUT counting a
        // failure, so the next check repeats this same Stripe key (TED-094).
        await releaseReload();
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "retry_same_key", reason: pi.error?.message });
        continue;
      }
      if (pi.error || pi.status === "requires_action") {
        await releaseReload();
        const reason = pi.error?.message || "requires_authentication";
        markFailure(ar, today, reason);
        failed++;
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "failed", reason });
        await persistAr(String(row.camp_id), camperName, ar, camperId);
      } else if (pi.status === "succeeded" || pi.status === "processing") {
        // Balance crediting happens asynchronously via stripe-webhook's
        // handleCanteenDeposit once Stripe confirms payment_intent.succeeded
        // — this function never touches `balance` on the Stripe path.
        markSuccess(ar, today, due.amount);
        // An automatic top-up is money moved with nobody watching, so it gets a
        // receipt for the same reason an instalment does. Keyed on the
        // PaymentIntent, so the webhook's copy and this one are one email.
        await sendReceipt({
          campId: String(row.camp_id), camperName, camperId: camperId, ref: String(pi.id || ""),
          amount: due.amount, when: today, method: "Card on file",
          what: "Canteen auto-reload (" + due.kind + ")",
        });
        charged++;
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "charged", stripeStatus: pi.status });
        await persistAr(String(row.camp_id), camperName, ar, camperId);
      } else {
        // requires_payment_method, canceled, …: no money moved. Give the slot
        // back rather than holding it until tomorrow, and count it as the
        // failure it is.
        await releaseReload();
        markFailure(ar, today, String(pi.status || "not_charged"));
        failed++;
        details.push({ camp: row.camp_id, camper: camperName, camperId, amount: due.amount, kind: due.kind, result: "failed", reason: pi.status });
        await persistAr(String(row.camp_id), camperName, ar, camperId);
      }
    }
  }

  console.log(`[canteen-auto-reload] done — charged ${charged}, failed ${failed}`);
  return new Response(
    JSON.stringify({ ok: true, charged, failed, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
