// =============================================================================
// charge-due-installments — the monthly-billing (autopay) runner
//
// Meant to be called once a day by pg_cron (see BILLING_PAYMENTS_SETUP.md). For
// every camp it scans campistryMe.families for families that have:
//   - one or more payment plans with autopay on (f.plans[].autopay === true —
//     a family can have MULTIPLE plans, e.g. one per enrolled camper; see
//     migrations/116_multi_payment_plans.sql. A pre-116 family with only the
//     legacy singular f.plan is read the same way, one-plan-in-a-list.)
//   - a saved card — either Stripe (f.cardOnFile + f.stripeCustomerId) or a
//     BYOP processor's vaulted token (f.cardOnFile + f.byopCustomerRef; see
//     BYOP_SETUP.md and _shared/adapters/*)
//   - at least one installment due today/overdue (status 'pending', dueDate<=today)
// and charges each due installment off-session — via Stripe for a Stripe camp,
// or via that camp's own processor adapter for a BYOP camp (Cardknox/Sola,
// Banquest) — marks it paid, and appends a payment to finance.payments so it
// shows up in Billing. A failed charge marks that installment 'failed' and
// moves on (office can retry).
//
// Which path a camp takes is decided ONLY by camps.payment_processor_key: a
// camp on 'stripe' (the default, every existing camp) behaves exactly as it
// always has. This is what closes the gap BYOP_SETUP.md flagged — "a BYOP
// family's autopay schedule still has nowhere to charge" — so a payment plan
// built by a parent or the office now actually charges on a Cardknox camp too.
//
// Auth: requires header  x-cron-secret: <INSTALLMENT_CRON_SECRET>  so only the
// scheduler can trigger it.
//
// TWO PLAN MODELS LIVE HERE, and which one a family uses is decided by the
// shape of its plan:
//
//   POSTED LEDGER (migrations 171/172) — plan.dueDates + nextIndex, no
//     installments[]. The amount is DERIVED at charge time as
//     outstanding / instalments remaining, read fresh from the database
//     immediately before the card is charged. There is no per-instalment
//     `status` field, so nothing can be marked 'paid' on an instalment nobody
//     charged — which is what used to leave a parked camper's plan reading
//     settled while $1,500 went uncollected (TEST_FINDINGS.md D1). Outcomes go
//     into an append-only history that records charged:0 WITH ITS REASON.
//
//   LEGACY FROZEN INSTALMENTS — installments[] each with a mutable status. Kept
//     working unchanged for families not yet converted by
//     convert_family_ledgers; conversion is how a camp leaves D1 behind.
//
// WRITES GO THROUGH an RPC either way — 172's record_autopay_charge for the
// ledger path, 169's record_autopay_installment for the legacy one — one call
// per instalment, NOT a whole-blob upsert at the end of the run. This used to
// read every camp's campistryMe up front and write it back after the last card
// was charged, so the blob was stale for the length of the run: anything the
// office or a webhook saved in between was discarded, and the run's own charges
// were lost if anyone else saved first. See those migrations' headers.
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
  const resp = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return resp.json();
}

// Cardknox/Sola charge against a vaulted card token, inlined rather than
// imported from _shared/adapters/cardknox_adapter.ts on purpose: this project
// deploys edge functions by pasting ONE file into the Supabase Dashboard (no
// CLI — see CLAUDE.md), so a `../_shared/` relative import fails to bundle at
// deploy time. Same reasoning, and the same small-duplication-over-import
// convention, cardknox-webhook already follows for its own gateway call.
//
// Keep in sync with cardknox_adapter.charge() — including the unique
// per-charge xInvoice, which is load-bearing: Sola blocks a transaction whose
// Key+Card+Amount+Invoice match another within 10 minutes, which is exactly
// what two same-amount installments charged back to back would look like.
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
      xInvoice: "CI-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    }).toString(),
  });
  const parsed: Record<string, string> = {};
  new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
  if (parsed.xResult !== "A") {
    return { success: false, error: parsed.xError || "Declined", status: parsed.xStatus, raw: parsed };
  }
  return { success: true, externalTransactionId: parsed.xRefNum, status: parsed.xStatus, raw: parsed };
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
    return { success: false, error: errMsg, status: data?.status, raw: data };
  }
  return { success: true, externalTransactionId: ref, status: data?.status, raw: data };
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
function computeFamilyBalance(
  me: Record<string, any>,
  f: Record<string, any>,
  famKey: string,
  depositsByFamily?: Map<string, number>,
): number {
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

  // Zelle and ACH deposits captured from the bank's alerts are REAL payments
  // that deliberately live in the bank_deposits table rather than in this
  // blob (migration 145: the blob has one writer, so a webhook appending to it
  // gets overwritten). The browser's ledger unions them in at read time. This
  // did not, so a family who paid by Zelle still looked like they owed the lot
  // and autopay charged their card for money they had already sent -- the
  // exact opposite of what deposit capture is for.
  const fromBank = depositsByFamily ? (depositsByFamily.get(famKey) || 0) : 0;

  return billed - paid - credits - fromBank;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Gate: only the scheduler (holding the secret) may run this.
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    console.warn("[autopay] unauthorized — x-cron-secret header missing or does not match INSTALLMENT_CRON_SECRET");
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // No hard requirement on STRIPE_SECRET: a BYOP-only deployment (Cardknox/
  // Sola) charges through its own processor and may legitimately have no
  // Stripe key. The Stripe charge branch below guards on STRIPE_SECRET itself,
  // so a missing key skips (and logs) only the Stripe families instead of
  // silently returning 500 and blocking EVERY camp's autopay — including BYOP —
  // with no log line, which is exactly what made "my autopay never ran"
  // impossible to see in the logs.
  if (!STRIPE_SECRET) console.warn("[autopay] STRIPE_SECRET not set — Stripe-camp autopay will be skipped; BYOP camps still run");

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

  // Posted bank deposits, per family, for every camp in one read — same
  // reasoning as the batch below: this loop can touch thousands of families.
  // A return/NSF is stored positive with is_reversal set, so the sign is
  // applied here; without that a bounced ACH would REDUCE what autopay thinks
  // is owed, on the strength of a payment that just failed.
  const depositsByFamily = new Map<string, Map<string, number>>();
  {
    const { data: depRows, error: depErr } = await supabase
      .from("bank_deposits")
      .select("camp_id, family_key, amount_cents, is_reversal")
      .eq("status", "posted")
      .not("family_key", "is", null);
    if (depErr) {
      // Charging on a balance that ignores deposits over-charges a family who
      // has already paid. Better to skip this run and retry than to take money
      // twice, so this is fatal rather than a warning.
      console.error(`[autopay] could not read bank deposits: ${depErr.message} — aborting rather than over-charging`);
      return new Response(JSON.stringify({ error: "deposit_read_failed", detail: depErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    for (const d of (depRows || [])) {
      const campKey = String(d.camp_id);
      if (!depositsByFamily.has(campKey)) depositsByFamily.set(campKey, new Map());
      const byFam = depositsByFamily.get(campKey)!;
      const amt = (d.is_reversal ? -1 : 1) * (Number(d.amount_cents) || 0) / 100;
      byFam.set(String(d.family_key), (byFam.get(String(d.family_key)) || 0) + amt);
    }
  }

  // Batch-fetch every connected camp once, up front, instead of a per-family
  // lookup — this loop can iterate thousands of installments in one run.
  const { data: connectedCamps } = await supabase
    .from("camps")
    .select("id, stripe_account_id, stripe_charges_enabled, name")
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

  // Which camps are on a non-Stripe processor. Fetched once up front (same
  // reasoning as campDestinations above — this loop can iterate thousands of
  // installments), but the CREDENTIALS themselves are pulled lazily below,
  // only for a camp that actually has something due: they're Vault-backed
  // secrets, so there's no reason to decrypt every BYOP camp's key on a run
  // where most camps have nothing to charge.
  const { data: byopCamps } = await supabase
    .from("camps")
    .select("id, payment_processor_key")
    .not("payment_processor_key", "is", null)
    .neq("payment_processor_key", "stripe");
  const campProcessors = new Map<string, string>();
  for (const c of (byopCamps || [])) {
    if (c.payment_processor_key) campProcessors.set(c.id, c.payment_processor_key);
  }
  const credCache = new Map<string, Record<string, string> | null>();
  async function byopCredentials(campId: string): Promise<Record<string, string> | null> {
    if (credCache.has(campId)) return credCache.get(campId) || null;
    const { data: credResult } = await supabase.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    const creds = credResult?.success ? (credResult.credentials as Record<string, string>) : null;
    if (!creds) console.warn(`[autopay] camp ${campId} is on a BYOP processor but has no verified credential — skipping its autopay`);
    credCache.set(campId, creds);
    return creds;
  }

  // Mark a plan as unable to collect, or clear it (migration 175).
  //
  // Two ways autopay silently stops and nobody is told: a parent removes their
  // last card (the plan still reads active, and the runner skips the family
  // BEFORE the plan loop, so the counter never advances — the plan does not even
  // run out, it stalls on the same instalment forever), or a card declines. This
  // writes the reason onto the plan, which both the office's Billing page and
  // the parent's portal already receive, and raises ONE notification per plan per
  // reason rather than one a night.
  //
  // Best-effort: a failure here must never stop the run charging other families.
  async function flagPlan(campId: string, famKey: string, planId: string,
                          reason: string | null, detail?: string) {
    if (!planId) return;
    try {
      await supabase.rpc("flag_plan_collection", {
        p_camp_id: campId, p_family_key: famKey, p_plan_id: planId,
        p_reason: reason, p_detail: detail || null,
      });
    } catch (e) {
      console.warn(`[autopay] could not flag plan ${planId}: ${(e as Error).message}`);
    }
  }

  // Persist ONE installment outcome — the patch, and when a card was actually
  // charged the payment alongside it — through migration 169's locking RPC.
  //
  // The two have to move together. A payment recorded without its installment
  // marked paid gets charged again tomorrow; an installment marked paid without
  // its payment is money the office can never see. One call, one row lock, both
  // writes, and the RPC only ever patches an installment that is still
  // 'pending', so a re-run of a failed run charges nobody twice.
  async function recordInstallment(
    campId: string,
    famKey: string,
    plan: Record<string, any>,
    planIndex: number,
    inst: Record<string, any>,
    patch: Record<string, unknown>,
    payment?: Record<string, unknown> | null,
    dedupeKey?: string | null,
  ): Promise<boolean> {
    // Keep the in-memory copy in step so the rest of THIS run (the details[]
    // lines below, the next installment on the same plan) reads what was saved.
    Object.assign(inst, patch);
    const { data, error } = await supabase.rpc("record_autopay_installment", {
      p_camp_id: campId,
      p_family_key: famKey,
      p_plan_id: plan && plan.id ? String(plan.id) : null,
      p_plan_index: planIndex,
      p_due_date: inst.dueDate ? String(inst.dueDate) : null,
      p_patch: patch,
      p_payment: payment || null,
      p_dedupe_key: dedupeKey || null,
    });
    if (error || !data?.success) {
      // Loud on purpose. If a card was charged and this write failed, the money
      // left the parent's account and Campistry has no record of it — the one
      // failure in this function a human has to see the same day.
      const why = error?.message || data?.error || "unknown";
      console.error(
        `[autopay] camp ${campId} family ${famKey}: could not record installment (${why})`
        + (payment ? " — A CARD WAS CHARGED AND IS NOT RECORDED" : ""),
      );
      return false;
    }
    return true;
  }

  for (const row of (rows || [])) {
    const me = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    if (!me) continue;

    // Families and payments come from their ROWS, never the document.
    //
    // Since 212/214 every server-side writer — record_autopay_installment below,
    // a parent saving a card or choosing a plan, a webhook recording a payment —
    // writes camp_families / camp_payments. The document's copies catch up only
    // when somebody saves the Me page. Reading them here meant an installment this
    // run marked PAID was still PENDING in the document tomorrow, so its card was
    // charged again every night (and the write refused, so the second charge was
    // not recorded either). And the payments were read from me.finance.payments,
    // a branch that has not existed since migration 158 — so what a family had
    // paid counted as nothing, and a family who paid in full early was charged
    // their remaining installments anyway.
    //
    // A camp whose rows cannot be read is SKIPPED, never charged from the stale copy.
    {
      const famRes = await supabase.rpc("camp_families_object", { p_camp_id: row.camp_id });
      const payRes = await supabase.rpc("camp_payments_array", { p_camp_id: row.camp_id });
      if (famRes.error || payRes.error || !famRes.data || typeof famRes.data !== "object") {
        console.error(`[autopay] camp ${row.camp_id}: could not read family/payment rows `
          + `(${famRes.error?.message || payRes.error?.message || "no data"}) — skipping this camp tonight`);
        details.push({ camp: row.camp_id, result: "skipped_rows_unreadable" });
        continue;
      }
      me.families = famRes.data as Record<string, any>;
      me.finance = { ...(me.finance && typeof me.finance === "object" ? me.finance : {}),
                     payments: Array.isArray(payRes.data) ? payRes.data : [] };
    }
    if (!me.families || !Object.keys(me.families).length) continue;

    // Look AHEAD at the cards, before charging anything with them. A card
    // expires on a date known the day it was saved, so autopay starting to
    // decline mid-summer is a failure nobody had to have. This runs here rather
    // than in its own scheduled function because this one already runs nightly
    // and already holds every camp's families — a second cron is a second thing
    // to deploy and a second thing to notice has stopped.
    //
    // It reports only what was captured. Stripe gives exp_month/exp_year and
    // stripe-webhook stores them; the BYOP adapters return a brand and last four
    // and no expiry, so those cards come back 'unknown' and are deliberately not
    // warned about. Best-effort: never fail a run over it.
    try {
      const { data: exp, error: expErr } = await supabase.rpc("flag_expiring_cards", {
        p_camp_id: row.camp_id, p_as_of: today, p_days: 30,
      });
      if (expErr) {
        console.warn(`[autopay] camp ${row.camp_id}: card expiry check failed (${expErr.message})`);
      } else if (exp?.expired || exp?.expiringSoon) {
        console.log(`[autopay] camp ${row.camp_id}: ${exp.expired} expired card(s), ` +
          `${exp.expiringSoon} expiring within 30 days`);
      }
    } catch (e) {
      console.warn(`[autopay] camp ${row.camp_id}: card expiry check threw (${(e as Error).message})`);
    }
    // `me` is read-only from here on: it is the snapshot the due/owed decisions
    // are made from, never what gets written back. Every write goes through
    // recordInstallment, which re-reads the blob under its own lock.

    // A BYOP camp charges its families' vaulted processor tokens instead of
    // Stripe customers — same plan/installment data, different rail.
    const processorKey = campProcessors.get(String(row.camp_id)) || null;

    for (const [famKey, fRaw] of Object.entries(me.families)) {
      const f = fRaw as Record<string, any>;
      // A family can have MULTIPLE plans (migration 116) — normalize the
      // legacy singular f.plan into a one-item list so a pre-116 family
      // charges exactly as it always did.
      const plans: Record<string, any>[] = Array.isArray(f.plans)
        ? f.plans
        : (f.plan && Array.isArray(f.plan.installments) ? [f.plan] : []);
      if (!plans.some((p) => p && p.autopay && Array.isArray(p.installments))) continue;
      // This family WANTS autopay — so if it has nothing chargeable behind it,
      // that's a real misconfiguration (a plan was set up but the card/token
      // never got saved), worth a log line instead of the two silent `continue`s
      // that used to sit above the plan check and made "my autopay didn't run"
      // impossible to diagnose from the logs.
      if (!f.cardOnFile || (processorKey ? !f.byopCustomerRef : !f.stripeCustomerId)) {
        const why = !f.cardOnFile ? "no card on file"
          : (processorKey ? "no vaulted card token (byopCustomerRef) — the card was never saved to the processor" : "no Stripe customer");
        console.warn(`[autopay] camp ${row.camp_id} family "${f.name}": autopay is on but ${why} — cannot charge`);
        // Say so ON THE PLAN. Skipping here happens before the plan loop, so
        // nothing else in this run will ever mention this family again — which is
        // exactly how a removed card silently stopped collection.
        for (const p of (Array.isArray(f.plans) ? f.plans : [])) {
          if (p && Array.isArray(p.dueDates) && p.autopay && !p.paused) {
            await flagPlan(String(row.camp_id), famKey, String(p.id || ""), "no_card", why);
          }
        }
        details.push({ camp: row.camp_id, family: f.name, result: "skipped_no_chargeable_card", reason: why, processor: processorKey || "stripe" });
        continue;
      }

      // ── POSTED-LEDGER PLANS (migrations 171/172) ─────────────────────────
      // A converted plan stores WHEN, never HOW MUCH: dueDates + nextIndex, no
      // installments[]. The amount is DERIVED at charge time from what is
      // actually still owed, so there is no frozen number to disagree with
      // reality and — the whole point — no per-instalment `status` to be marked
      // 'paid' on an instalment nobody charged. That write is what made a parked
      // camper's plan read settled while $1,500 went uncollected (D1).
      //
      // plan_due_for reads the CURRENT blob rather than the snapshot this run
      // took at the start, because by the time we reach a given family the
      // snapshot is minutes old and a parent may have paid in the meantime.
      const ledgerPlans = (Array.isArray(f.plans) ? f.plans : [])
        .filter((p: Record<string, any>) => p && Array.isArray(p.dueDates));
      for (const plan of ledgerPlans) {
        if (!plan.autopay || plan.paused) continue;

        // A plan already known to be failing gets chased on a schedule rather
        // than on every due date (migration 179). Two reasons this check sits
        // BEFORE the gateway call and not after: most processors bill the camp
        // for an authorisation whether it approves or declines, so retrying a
        // closed account daily is a charge for nothing; and a decline still
        // advances the instalment counter, so an unthrottled dead card burns
        // through the whole plan in a week of due dates and leaves it reading
        // finished with the balance untouched.
        const blocked = plan.collectionBlocked;
        if (blocked && blocked.nextRetryAt && String(blocked.nextRetryAt) > today) {
          details.push({ camp: row.camp_id, family: f.name, result: "waiting_to_retry",
                         reason: blocked.reason, attempts: blocked.attempts,
                         nextRetryAt: blocked.nextRetryAt });
          continue;
        }

        const { data: due, error: dueErr } = await supabase.rpc("plan_due_for", {
          p_camp_id: row.camp_id, p_family_key: famKey,
          p_plan_id: String(plan.id || ""), p_as_of: today,
        });
        if (dueErr) {
          console.error(`[autopay] camp ${row.camp_id} family "${f.name}": could not read what is due (${dueErr.message})`);
          details.push({ camp: row.camp_id, family: f.name, result: "error_reading_due" });
          continue;
        }
        if (!due) continue;                                  // nothing due yet

        // Nothing owed. Record the outcome WITH ITS REASON and move on —
        // recording is not the same as settling, and this is the line that used
        // to destroy an instalment.
        if (!(Number(due.amount) > 0)) {
          await supabase.rpc("record_autopay_charge", {
            p_camp_id: row.camp_id, p_family_key: famKey,
            p_plan_id: String(plan.id || ""), p_index: due.index,
            p_due_date: due.dueDate, p_amount: 0,
            p_reason: due.reason || "nothing_owed",
          });
          details.push({ camp: row.camp_id, family: f.name, amount: 0,
                         result: "nothing_owed" });
          continue;
        }

        const amount = Number(due.amount);
        const camperName2 = (Array.isArray(f.camperIds) && f.camperIds[0]) ? f.camperIds[0] : (f.name || "");
        let txnId = "", ok = false, failWhy = "";

        if (processorKey) {
          const creds = (processorKey === "cardknox" || processorKey === "banquest")
            ? await byopCredentials(String(row.camp_id)) : null;
          const hasCred = processorKey === "cardknox" ? !!creds?.apiKey
            : processorKey === "banquest" ? (!!creds?.sourceKey && !!creds?.pin) : false;
          if (!creds || !hasCred) {
            // Not a decline and not the family's fault. Record NOTHING so the
            // counter does not advance — the instalment retries next run once
            // the camp's processor is connected.
            await flagPlan(String(row.camp_id), famKey, String(plan.id || ""),
                           "no_processor", `processor ${processorKey} is not connected`);
            details.push({ camp: row.camp_id, family: f.name, amount, result: "skipped_no_processor", processor: processorKey });
            continue;
          }
          const res = processorKey === "cardknox"
            ? await cardknoxCharge(String(creds.apiKey), Math.round(amount * 100), String(f.byopCustomerRef))
            : await banquestCharge(creds, Math.round(amount * 100), String(f.byopCustomerRef));
          ok = !!(res.success && res.externalTransactionId);
          txnId = String(res.externalTransactionId || "");
          failWhy = res.error || "Declined";
          if (ok) {
            await supabase.rpc("record_processor_transaction", {
              p_camp_id: row.camp_id, p_processor_key: processorKey,
              p_external_transaction_id: txnId, p_kind: "charge",
              p_amount_cents: Math.round(amount * 100),
              p_status: res.status || "unknown",
              p_raw_response: res.raw ? JSON.parse(JSON.stringify(res.raw)) : null,
            });
          }
        } else {
          if (!STRIPE_SECRET) {
            console.warn(`[autopay] camp ${row.camp_id} family "${f.name}": Stripe camp but STRIPE_SECRET not set — skipping`);
            details.push({ camp: row.camp_id, family: f.name, amount, result: "skipped_no_stripe_key" });
            continue;
          }
          const pi = await stripeCharge(
            f.stripeCustomerId, f.stripePaymentMethodId || null, amount,
            `${campNames.get(String(row.camp_id)) || "Camp"} — instalment (${f.name || famKey})`,
            { campId: String(row.camp_id), familyKey: famKey, familyName: camperName2,
              planId: String(plan.id || ""), source: "autopay" },
            campDestinations.get(String(row.camp_id)) || null,
          );
          if (pi.error || pi.status === "requires_action") {
            failWhy = pi.error?.message || "requires_authentication";
          } else if (pi.status === "succeeded") {
            ok = true; txnId = String(pi.id);
          } else {
            // Still processing. Record nothing: the counter must not advance on
            // a charge that has not landed.
            details.push({ camp: row.camp_id, family: f.name, amount, result: pi.status });
            continue;
          }
        }

        if (!ok) {
          // A decline advances the counter with charged:0 and the reason, so the
          // office can see it happened and the plan does not stall for ever on
          // one bad card. Nothing is recorded as paid.
          await supabase.rpc("record_autopay_charge", {
            p_camp_id: row.camp_id, p_family_key: famKey,
            p_plan_id: String(plan.id || ""), p_index: due.index,
            p_due_date: due.dueDate, p_amount: 0, p_reason: "declined: " + failWhy,
          });
          await flagPlan(String(row.camp_id), famKey, String(plan.id || ""), "declined", failWhy);
          failed++;
          details.push({ camp: row.camp_id, family: f.name, amount, result: "failed", reason: failWhy });
          continue;
        }

        // The card was charged. The ledger entry, the plan history row and the
        // Billing receipt land in ONE locked write — split them and a crash
        // between leaves either money with no record or a skipped instalment.
        const rec = await supabase.rpc("record_autopay_charge", {
          p_camp_id: row.camp_id, p_family_key: famKey,
          p_plan_id: String(plan.id || ""), p_index: due.index,
          p_due_date: due.dueDate, p_amount: amount,
          p_payment: {
            id: (processorKey ? "auto_byop_" : "auto_") + txnId,
            family: camperName2, familyKey: famKey,
            amount: amount, date: today, method: "Autopay (card)",
            reference: txnId,
            notes: "Autopay instalment " + (due.index + 1) + " of " + plan.dueDates.length,
            ...(processorKey
                ? { byopTransactionId: txnId, byopProcessor: processorKey }
                : { stripePaymentIntentId: txnId }),
            status: "succeeded", timestamp: Date.now(),
          },
          p_dedupe_key: txnId,
          p_entry_note: "Autopay instalment " + (due.index + 1) + " of " + plan.dueDates.length,
        });
        if (rec.error || !rec.data?.success) {
          console.error(`[autopay] camp ${row.camp_id} family ${famKey}: A CARD WAS CHARGED AND IS NOT RECORDED (${rec.error?.message || rec.data?.error || "unknown"})`);
        }
        // Collected: whatever was blocking is over. Clearing uses the same call,
        // so a newly saved card or a card that now works closes the flag without
        // anyone having to dismiss anything.
        await flagPlan(String(row.camp_id), famKey, String(plan.id || ""), null);
        // An instalment is the charge a parent is LEAST expecting: nobody was
        // present, it happened overnight, and until now the first they knew of
        // it was the line on their statement. On the Stripe path the webhook
        // also dispatches one for this same PaymentIntent and whichever arrives
        // second sends nothing.
        await sendReceipt({
          campId: String(row.camp_id), familyKey: famKey, ref: txnId, amount,
          what: "Payment plan instalment " + (due.index + 1) + " of " + plan.dueDates.length,
          method: "Card on file", when: today, balanceAfter: rec.data?.balance,
        });
        charged++;
        details.push({ camp: row.camp_id, family: f.name, amount,
                       result: (rec.error || !rec.data?.success) ? "charged_not_recorded" : "charged",
                       balanceAfter: rec.data?.balance });
      }

      // ── LEGACY FROZEN-INSTALMENT PLANS ───────────────────────────────────
      // Everything below runs only for plans not yet converted by migration
      // 171's convert_family_ledgers. It keeps the old behaviour, D1 included,
      // because changing it would be a second behaviour for the same data —
      // conversion is how a camp leaves it behind.

      // One balance check per family per run, decremented as installments
      // get charged in this same run (several can be due the same day across
      // multiple plans) — see computeFamilyBalance's header comment.
      let remainingBalance = computeFamilyBalance(
        me, f, famKey, depositsByFamily.get(String(row.camp_id)));

      // Indexed, because the RPC identifies the plan by id when it has one and
      // by POSITION when it does not — so the position has to be the one in
      // this same normalized list.
      for (let planIndex = 0; planIndex < plans.length; planIndex++) {
        const plan = plans[planIndex];
        if (!plan || !plan.autopay || !Array.isArray(plan.installments)) continue;
        // A converted plan was already handled above by the derived path; it has
        // dueDates and no installments, but guard anyway so a half-converted
        // plan can never be charged twice in one night.
        if (Array.isArray(plan.dueDates)) continue;

        for (const inst of plan.installments) {
          if (inst.status !== "pending") continue;
          if (!inst.dueDate || inst.dueDate > today) continue; // not due yet
          const scheduledAmount = Number(inst.amount) || 0;
          if (scheduledAmount <= 0) {
            await recordInstallment(String(row.camp_id), famKey, plan, planIndex, inst, { status: "paid" });
            continue;
          }

          // Already paid off (in full, or by enough ahead-of-schedule
          // payments to cover what's left) — never charge, just mark covered.
          if (remainingBalance <= 0.005) {
            await recordInstallment(String(row.camp_id), famKey, plan, planIndex, inst, {
              status: "paid",
              paidDate: today,
              note: "Covered by an earlier payment — not charged",
            });
            details.push({ camp: row.camp_id, family: f.name, amount: scheduledAmount, result: "waived_paid_ahead" });
            continue;
          }

          // Cap the charge at what's actually still owed — a parent who paid
          // some extra ahead of schedule shouldn't be re-charged the full
          // original installment amount once the real balance is lower.
          const amount = Math.min(scheduledAmount, remainingBalance);
          // When the two differ, the plan is about to show a number nobody
          // scheduled. Overwriting inst.amount with no record of why is what
          // makes an office look at a $5 line on a $500 instalment and
          // reasonably conclude the data is corrupt -- so keep what was
          // scheduled and say what happened.
          const capped = amount < scheduledAmount - 0.005;
          const cappedNote = capped
            ? `Charged ${amount.toFixed(2)} of ${scheduledAmount.toFixed(2)} — the rest of this instalment was already covered`
            : "";
          const camperName = (Array.isArray(f.camperIds) && f.camperIds[0]) ? f.camperIds[0] : (f.name || "");

          // ── BYOP camp: charge the family's vaulted processor token ──────
          // Everything above this point (which installments are due, the
          // paid-ahead waiver, the balance cap) is processor-agnostic and
          // already ran — only the actual charge call and how the result is
          // recorded differ. Kept as its own branch that returns early so
          // the Stripe path below stays byte-for-byte what it always was.
          if (processorKey) {
            // Cardknox/Sola and Banquest are both wired for autopay. Any
            // other BYOP processor falls through to the "leave it pending"
            // path rather than being charged wrong or silently skipped —
            // flagged in BYOP_SETUP.md, not quietly dropped.
            const creds = (processorKey === "cardknox" || processorKey === "banquest")
              ? await byopCredentials(String(row.camp_id)) : null;
            const hasCred = processorKey === "cardknox" ? !!creds?.apiKey
              : processorKey === "banquest" ? (!!creds?.sourceKey && !!creds?.pin) : false;
            if (!creds || !hasCred) {
              // Not a decline and not the family's fault — leave the
              // installment 'pending' so it retries on the next run once the
              // camp's processor is connected properly (or a branch for it is
              // wired), rather than burning it as 'failed' and making the
              // office re-create it by hand.
              details.push({ camp: row.camp_id, family: f.name, amount, result: "skipped_no_processor", processor: processorKey });
              continue;
            }
            const res = processorKey === "cardknox"
              ? await cardknoxCharge(String(creds.apiKey), Math.round(amount * 100), String(f.byopCustomerRef))
              : await banquestCharge(creds, Math.round(amount * 100), String(f.byopCustomerRef));
            if (!res.success || !res.externalTransactionId) {
              await recordInstallment(String(row.camp_id), famKey, plan, planIndex, inst, {
                status: "failed", failReason: res.error || "Declined",
              });
              failed++;
              details.push({ camp: row.camp_id, family: f.name, amount, result: "failed", reason: inst.failReason });
            } else {
              const patch: Record<string, unknown> = {
                status: "paid", paidDate: today, byopTransactionId: res.externalTransactionId,
              };
              if (capped) {
                patch.scheduledAmount = scheduledAmount;  // what the plan asked for
                patch.amount = amount;                    // what actually left the card
                patch.note = cappedNote;
              }
              // Same payment shape payments-charge/cardknox-webhook already
              // write, incl. byopTransactionId — that's what makes Billing's
              // existing "Direct Refund" action work on an autopay charge too.
              // It goes in with the patch, in one transaction: see
              // recordInstallment's header for why they cannot be two writes.
              const recorded = await recordInstallment(String(row.camp_id), famKey, plan, planIndex, inst, patch, {
                id: "auto_byop_" + res.externalTransactionId, family: camperName, familyKey: famKey,
                amount: amount, date: today, method: "Autopay (card)",
                reference: res.externalTransactionId,
                notes: capped ? "Autopay installment — " + cappedNote : "Autopay installment",
                byopTransactionId: res.externalTransactionId, byopProcessor: processorKey,
                status: "succeeded", timestamp: Date.now(),
              }, String(res.externalTransactionId));
              await supabase.rpc("record_processor_transaction", {
                p_camp_id: row.camp_id,
                p_processor_key: processorKey,
                p_external_transaction_id: res.externalTransactionId,
                p_kind: "charge",
                p_amount_cents: Math.round(amount * 100),
                p_status: res.status || "unknown",
                p_raw_response: res.raw ? JSON.parse(JSON.stringify(res.raw)) : null,
              });
              charged++;
              remainingBalance -= amount;
              details.push({ camp: row.camp_id, family: f.name, amount,
                result: recorded ? "charged" : "charged_not_recorded" });
            }
            continue;
          }

          // Stripe path needs the platform Stripe key. A BYOP-only deployment
          // may not have one — skip (and log) just this family instead of the
          // old top-of-run 500 that blocked everyone.
          if (!STRIPE_SECRET) {
            console.warn(`[autopay] camp ${row.camp_id} family "${f.name}": Stripe camp but STRIPE_SECRET not set — skipping`);
            details.push({ camp: row.camp_id, family: f.name, amount, result: "skipped_no_stripe_key" });
            continue;
          }
          const pi = await stripeCharge(
            f.stripeCustomerId, f.stripePaymentMethodId || null, amount,
            `Autopay installment — ${f.name || famKey}`,
            { campId: String(row.camp_id), familyKey: famKey, familyName: camperName, planId: plan.id || "", source: "autopay" },
            campDestinations.get(String(row.camp_id)) || null,
          );

          if (pi.error || pi.status === "requires_action") {
            await recordInstallment(String(row.camp_id), famKey, plan, planIndex, inst, {
              status: "failed", failReason: pi.error?.message || "requires_authentication",
            });
            failed++;
            details.push({ camp: row.camp_id, family: f.name, amount, result: "failed", reason: inst.failReason });
          } else if (pi.status === "succeeded") {
            const patch: Record<string, unknown> = {
              status: "paid", paidDate: today, stripePaymentIntentId: pi.id,
            };
            if (capped) {
              patch.scheduledAmount = scheduledAmount;  // what the plan asked for
              patch.amount = amount;                    // what actually left the card
              patch.note = cappedNote;
            }
            const recorded = await recordInstallment(String(row.camp_id), famKey, plan, planIndex, inst, patch, {
              id: "auto_" + pi.id, family: camperName, familyKey: famKey,
              amount: amount, date: today, method: "Autopay (card)",
              reference: pi.id,
              notes: capped ? "Monthly autopay installment — " + cappedNote : "Monthly autopay installment",
              stripePaymentIntentId: pi.id, status: "succeeded", timestamp: Date.now(),
            }, String(pi.id));
            charged++;
            remainingBalance -= amount;
            details.push({ camp: row.camp_id, family: f.name, amount,
              result: recorded ? "charged" : "charged_not_recorded" });
          } else {
            // Processing (e.g. a slower method). Nothing to persist: the
            // installment stays 'pending' on purpose, so the next run picks it
            // up if the intent never lands.
            details.push({ camp: row.camp_id, family: f.name, amount, result: pi.status });
          }
        }
      }
    }
  }

  // ── tips that never reached the staff member (migration 182) ────────────
  // A cart tip whose transfer failed left transfer_error set and processed_at
  // null, and the code that wrote it said a retry would pick it up — "Stripe's
  // own delivery retries, or a manual resend". Neither existed: that webhook
  // returns 200 so Stripe never redelivers, and there is no resend in the app.
  // The money stayed with the platform and the counselor stayed unpaid.
  //
  // This is that retry. It runs here for the same reason the card-expiry check
  // does: this function is already nightly and already has the Stripe key, and
  // a second cron is a second thing to deploy and a second thing to notice has
  // stopped. Best-effort — a tip retry must never fail a tuition run.
  let tipsRetried = 0, tipsStillFailing = 0;
  try {
    const { data: pending } = await supabase.rpc("retry_failed_tip_transfers", { p_limit: 50 });
    for (const t of (pending || [])) {
      if (!STRIPE_SECRET) break;
      try {
        const amountCents = Math.max(0, Number(t.tipCents) - Number(t.feeCents || 0));
        if (!(amountCents > 0)) continue;
        const resp = await fetch(`${STRIPE_API}/transfers`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${STRIPE_SECRET}`,
            "Content-Type": "application/x-www-form-urlencoded",
            // Same key every night for the same item, so a retry that actually
            // went through on a previous run cannot pay the tip twice.
            "Idempotency-Key": `tip_retry_${t.id}`,
          },
          body: new URLSearchParams({
            amount: String(amountCents),
            currency: "usd",
            destination: String(t.staffAccountId),
            description: `Campistry tip — ${t.staffName || ""} (retry)`,
          }).toString(),
        });
        const tr = await resp.json();
        if (tr.error) throw new Error(tr.error.message);
        await supabase.from("link_tip_cart_items")
          .update({ processed_at: new Date().toISOString(), stripe_transfer_id: tr.id, transfer_error: null })
          .eq("id", t.id);
        tipsRetried++;
        console.log(`[autopay] retried tip ${t.id} -> ${t.staffName}: $${amountCents / 100} (${tr.id})`);
      } catch (e) {
        tipsStillFailing++;
        console.warn(`[autopay] tip ${t.id} for ${t.staffName} still failing: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.warn(`[autopay] tip retry sweep failed: ${(e as Error).message}`);
  }
  if (tipsRetried || tipsStillFailing) {
    console.log(`[autopay] tips — ${tipsRetried} paid on retry, ${tipsStillFailing} still failing`);
  }

  console.log(`[autopay] done — charged ${charged}, failed ${failed}` + (details.length ? `; details=${JSON.stringify(details)}` : "; nothing due"));
  return new Response(
    JSON.stringify({ ok: true, charged, failed, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
