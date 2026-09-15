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
    .select("id, stripe_account_id, stripe_charges_enabled")
    .not("stripe_account_id", "is", null)
    .eq("stripe_charges_enabled", true);
  const campDestinations = new Map<string, string>();
  for (const c of (connectedCamps || [])) {
    if (c.stripe_account_id) campDestinations.set(c.id, c.stripe_account_id);
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

  for (const row of (rows || [])) {
    const me = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    if (!me || !me.families) continue;
    if (!me.finance) me.finance = {};
    if (!Array.isArray(me.finance.payments)) me.finance.payments = [];
    let dirty = false;

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
        details.push({ camp: row.camp_id, family: f.name, result: "skipped_no_chargeable_card", reason: why, processor: processorKey || "stripe" });
        continue;
      }

      // One balance check per family per run, decremented as installments
      // get charged in this same run (several can be due the same day across
      // multiple plans) — see computeFamilyBalance's header comment.
      let remainingBalance = computeFamilyBalance(
        me, f, famKey, depositsByFamily.get(String(row.camp_id)));

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
              inst.status = "failed";
              inst.failReason = res.error || "Declined";
              failed++;
              details.push({ camp: row.camp_id, family: f.name, amount, result: "failed", reason: inst.failReason });
            } else {
              inst.status = "paid";
              inst.paidDate = today;
              inst.byopTransactionId = res.externalTransactionId;
              if (capped) {
                inst.scheduledAmount = scheduledAmount;  // what the plan asked for
                inst.amount = amount;                    // what actually left the card
                inst.note = cappedNote;
              }
              // Same payment shape payments-charge/cardknox-webhook already
              // write, incl. byopTransactionId — that's what makes Billing's
              // existing "Direct Refund" action work on an autopay charge too.
              me.finance.payments.push({
                id: "auto_byop_" + res.externalTransactionId, family: camperName, familyKey: famKey,
                amount: amount, date: today, method: "Autopay (card)",
                reference: res.externalTransactionId,
                notes: capped ? "Autopay installment — " + cappedNote : "Autopay installment",
                byopTransactionId: res.externalTransactionId, byopProcessor: processorKey,
                status: "succeeded", timestamp: Date.now(),
              });
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
              details.push({ camp: row.camp_id, family: f.name, amount, result: "charged" });
            }
            dirty = true;
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
            inst.status = "failed";
            inst.failReason = pi.error?.message || "requires_authentication";
            failed++;
            details.push({ camp: row.camp_id, family: f.name, amount, result: "failed", reason: inst.failReason });
          } else if (pi.status === "succeeded") {
            inst.status = "paid";
            inst.paidDate = today;
            inst.stripePaymentIntentId = pi.id;
            if (capped) {
              inst.scheduledAmount = scheduledAmount;  // what the plan asked for
              inst.amount = amount;                    // what actually left the card
              inst.note = cappedNote;
            }
            me.finance.payments.push({
              id: "auto_" + pi.id, family: camperName, familyKey: famKey,
              amount: amount, date: today, method: "Autopay (card)",
              reference: pi.id,
              notes: capped ? "Monthly autopay installment — " + cappedNote : "Monthly autopay installment",
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

  console.log(`[autopay] done — charged ${charged}, failed ${failed}` + (details.length ? `; details=${JSON.stringify(details)}` : "; nothing due"));
  return new Response(
    JSON.stringify({ ok: true, charged, failed, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
