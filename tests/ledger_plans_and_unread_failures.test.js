// node --test tests/ledger_plans_and_unread_failures.test.js
//
// THE BIG ONE. 172 replaced frozen instalment amounts with a derived model, and
// 179 added dunning on top. Both live on the same branch of the autopay runner:
//
//     const ledgerPlans = (...).filter((p) => p && Array.isArray(p.dueDates));
//
// And nothing created a plan with dueDates. set_my_payment_plan — the only
// thing in the app that makes a plan — wrote `installments`, the legacy shape.
// So every plan went down the legacy branch, where the amount stays frozen and
// a declined instalment is written status:'failed' and never looked at again:
// `if (inst.status !== "pending") continue`. One decline and it was gone.
//
// Two smaller ones with the same shape — a failure recorded and read by nobody:
//
//   A TIP THAT NEVER ARRIVED. transfer_error was written and nothing read it.
//     The code said a retry would pick it up, "Stripe's own delivery retries,
//     or a manual resend" — but the handler returns 200 so Stripe never
//     redelivers, and there was no resend anywhere. Parent charged, counselor
//     unpaid, money on the platform, nothing on any screen.
//
//   THE SMS FEE. error_message written, status left 'active', and the dashboard
//     only shows error_message when status is 'rejected' or 'failed'. And
//     next_charge_at was not advanced, so the same dead card was charged every
//     run for ever.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const M181 = read('migrations/181_new_plans_are_ledger_plans.sql');
const M182 = read('migrations/182_tip_and_platform_fee_failures.sql');
const RUNNER = read('supabase/functions/charge-due-installments/index.ts');
const ME = read('campistry_me.js');
const PARENT = read('campistry_link_parent.html');

// ── 1. a new plan is a ledger plan ──────────────────────────────────────────

test('set_my_payment_plan writes dueDates, not installments', () => {
    const fn = M181.slice(M181.indexOf('FUNCTION public.set_my_payment_plan'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /'dueDates', v_dates/,
        'a new plan still has no dueDates, so nothing built for ledger plans runs');
    assert.ok(!/'installments', v_insts/.test(body),
        'the plan still stores frozen per-instalment amounts');
    // The counter and history the derived model needs.
    for (const k of ["'count', v_n", "'nextIndex', 0", "'history', '[]'::jsonb"]) {
        assert.ok(body.includes(k), `the ledger plan is missing ${k}`);
    }
});

test('the amount is still VALIDATED, just not stored', () => {
    // Dropping the check would let a parent build a plan that quietly collects
    // less than they owe. It is the storing that is the defect, not the asking.
    const fn = M181.slice(M181.indexOf('FUNCTION public.set_my_payment_plan'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /'error', 'total_mismatch'/,
        'a plan that does not add up to the balance is now accepted');
    assert.match(body, /v_sum := v_sum \+ v_amt;/);
    assert.match(body, /abs\(v_sum - v_target\) > 0\.05/);
});

test('every guard 117 had is still there', () => {
    // This migration replaces a working function. The one thing it is allowed
    // to change is the shape written at the end.
    const fn = M181.slice(M181.indexOf('FUNCTION public.set_my_payment_plan'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    for (const guard of [
        "'not_authenticated'", "'invalid_payload'", "'no_active_invite'",
        "'camp_not_found'", "'self_serve_not_enabled'", "'no_family_on_file'",
        "'nothing_owed'", "'plan_already_exists'", "'invalid_installment_count'",
    ]) {
        assert.ok(body.includes(guard), `guard ${guard} was lost in the rewrite`);
    }
    assert.match(body, /FOR UPDATE/, 'the row lock was lost');
    // And the target is still the real balance, not a tuition sum.
    assert.match(body, /v_target := v_billed - v_paid - v_credits;/);
});

test('the runner will now see these plans as ledger plans', () => {
    // The whole point: this is the filter that decides which branch a plan
    // takes, and therefore whether it gets derived amounts and dunning.
    assert.match(RUNNER, /filter\(\(p: Record<string, any>\) => p && Array\.isArray\(p\.dueDates\)\)/);
    const fn = M181.slice(M181.indexOf('FUNCTION public.set_my_payment_plan'));
    assert.match(fn, /'dueDates', v_dates/);
});

test('existing legacy plans are left alone', () => {
    // Rewriting a live plan underneath a family mid-season is a bigger risk
    // than the bug. The legacy branch has to keep working.
    assert.match(RUNNER, /if \(Array\.isArray\(plan\.dueDates\)\) continue;/,
        'the legacy loop no longer skips converted plans, so a plan could charge twice');
    assert.match(RUNNER, /Array\.isArray\(plan\.installments\)/,
        'the legacy branch is gone, stranding every plan that already exists');
});

// ── 2. both views derive the same number autopay will charge ────────────────

test('the office and the parent derive a ledger plan the same way', () => {
    // Two copies of this math is already one too many; three (with plan_due)
    // is only tolerable if they agree. The rule: outstanding / remaining, last
    // one sweeps the rest.
    for (const [name, src] of [['campistry_me.js', ME], ['campistry_link_parent.html', PARENT]]) {
        const fnName = name.endsWith('.js') ? '_planSchedule' : '_lkPlanSchedule';
        const at = src.indexOf('function ' + fnName + '(');
        assert.ok(at > 0, `${name} has no ${fnName}`);
        const body = src.slice(at, at + 1200);
        assert.match(body, /left<=1\?owed:Math\.round\(\(owed\/left\)\*100\)\/100/,
            `${name} does not derive the instalment the way plan_due does`);
        assert.match(body, /Array\.isArray\(plan\.installments\)&&plan\.installments\.length\)return plan\.installments/,
            `${name} no longer renders a legacy plan as stored`);
    }
});

test('a ledger plan is visible to the office at all', () => {
    // It used to filter on p.installments.length, so a parent-built plan simply
    // did not appear on the camp's screen.
    assert.match(ME, /_famPlans\(f\)\.filter\(function\(p\)\{return _planSchedule\(p,l\.balance\)\.length\}\)/,
        'the office plan card still filters on installments, hiding ledger plans');
    assert.ok(!/_famPlans\(f\)\.filter\(function\(p\)\{return p\.installments&&p\.installments\.length\}\)/.test(ME));
});

test('a ledger plan is visible to the parent at all', () => {
    assert.match(PARENT, /Array\.isArray\(d\.plan\.dueDates\)&&d\.plan\.dueDates\.length/,
        '_lkFamPlans still only recognises legacy plans');
    assert.match(PARENT, /var insts=_lkPlanSchedule\(plan,d&&d\.balance\);/,
        'the plan card still reads plan.installments directly');
});

test('a family with only a ledger plan still counts as having money', () => {
    // _familyHasMoney gates whether a family record can be deleted. Missing the
    // new shape means deleting a family that owes on a plan.
    assert.match(ME, /if\(f\.plan&&\(f\.plan\.installments\|\|f\.plan\.dueDates\)\)return true;/);
});

// ── 3. the tip nobody was told about ────────────────────────────────────────

test('a failed tip transfer is raised with the camp', () => {
    assert.match(M182, /FUNCTION public\.record_tip_transfer_failure/);
    const hook = read('supabase/functions/stripe-connect-webhook/index.ts');
    assert.match(hook, /record_tip_transfer_failure/,
        'a failed transfer is still only written to a column nothing reads');
    // One per ITEM: a retry failing again is the same unpaid tip.
    assert.match(M182, /'tip_transfer_failed', p_item_id::text/);
    // And the message has to say the parent WAS charged, or the office will
    // assume the tip never happened.
    assert.match(M182, /parent was charged/);
});

test('the retry the old comment promised now actually exists', () => {
    assert.match(M182, /FUNCTION public\.retry_failed_tip_transfers/);
    assert.match(RUNNER, /retry_failed_tip_transfers/,
        'nothing ever drains the queue of unpaid tips');
    // Paying a tip twice is worse than paying it late.
    assert.match(RUNNER, /"Idempotency-Key": `tip_retry_\$\{t\.id\}`/,
        'a retry has no idempotency key, so a transfer that actually succeeded ' +
        'on an earlier run could pay the staff member twice');
    // Only ever items whose money was taken and not handed on.
    const fn = M182.slice(M182.indexOf('FUNCTION public.retry_failed_tip_transfers'));
    assert.match(fn, /processed_at IS NULL/);
    assert.match(fn, /COALESCE\(i\.transfer_error, ''\) <> ''/);
    assert.match(fn, /interval '90 days'/,
        'a permanently broken account is retried nightly for ever');
});

test('a tip retry cannot fail the tuition run', () => {
    const at = RUNNER.indexOf('retry_failed_tip_transfers');
    const block = RUNNER.slice(at - 900, at + 2200);
    assert.match(block, /try \{/);
    assert.match(block, /tip retry sweep failed/,
        'an error in the tip sweep is not contained');
});

// ── 4. Campistry's own fee ──────────────────────────────────────────────────

test('a declined SMS fee backs off instead of retrying every run', () => {
    assert.match(M182, /FUNCTION public\.record_telnyx_charge_failure/);
    const fn = M182.slice(M182.indexOf('FUNCTION public.record_telnyx_charge_failure'));
    // Statements only: commenting the line out is exactly how this regresses,
    // and a raw-text match would happily find it in the comment.
    const body = fn.slice(0, fn.indexOf('\n$$;'))
        .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    assert.match(body, /next_charge_at\s*=\s*now\(\) \+/,
        'next_charge_at is still left alone, so the dead card is charged every run');
    // The same schedule as plan dunning, deliberately.
    for (const d of ['3', '5', '7', '14']) {
        assert.ok(body.includes(`THEN ${d}`) || body.includes(`ELSE ${d} END`),
            `the backoff is missing its ${d}-day step`);
    }
    assert.match(body, /charge_failures = COALESCE\(charge_failures, 0\) \+ 1/);
});

test('the camp is told, and told louder the third time', () => {
    const fn = M182.slice(M182.indexOf('FUNCTION public.record_telnyx_charge_failure'));
    assert.match(fn, /INSERT INTO notifications/,
        'the camp still sees nothing but "active since <date>"');
    assert.match(fn, /'telnyx_fee_failed', v_fails::text/,
        'the notification is keyed per camp, so only the first failure is ever seen');
    assert.match(fn, /v_fails >= 3[\s\S]{0,120}at risk/);
    // Nothing has actually been cut off — saying otherwise is a lie that gets
    // support calls.
    assert.match(fn, /still active and nothing has been cut off/);
});

test('paying stops the chasing', () => {
    assert.match(M182, /FUNCTION public\.clear_telnyx_charge_failures/);
    const fees = read('supabase/functions/telnyx-charge-monthly-fees/index.ts');
    assert.match(fees, /record_telnyx_charge_failure/);
    assert.match(fees, /charge_failures: 0/,
        'a camp that fixes its card keeps its failure count for ever');
});

test('the column the backoff counts on is created', () => {
    assert.match(M182, /ALTER TABLE camp_telnyx_provisioning\s*\n\s*ADD COLUMN IF NOT EXISTS charge_failures integer NOT NULL DEFAULT 0;/);
});
