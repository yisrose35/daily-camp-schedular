// node --test tests/finance_merge.test.js
//
// The scenario these exist for, start to finish:
//
//   21:00  the office leaves Me open
//   02:00  charge-due-installments charges a card, appends the payment to
//          finance.payments and marks the installment paid — server-side
//   09:00  somebody in that same tab renames a bunk; save() writes the whole
//          campistryMe blob from memory that predates the charge
//
// Before this merge: the payment vanished (the family owes it again) and the
// installment went back to 'pending', so the cron charged the same card the
// following night. The balance not going down and the double charge are the
// same bug.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../campistry_finance_merge.js');

const ROOT = path.join(__dirname, '..');

function stale() {
    return {
        families: {
            fam_k: {
                name: 'Klein Family',
                cardOnFile: true,
                stripeCustomerId: 'cus_1',
                plans: [{ id: 'plan1', autopay: true, installments: [
                    { id: 'i1', label: 'Deposit', dueDate: '2026-06-01', amount: 500, status: 'paid' },
                    { id: 'i2', label: 'July',    dueDate: '2026-07-01', amount: 500, status: 'pending' },
                    { id: 'i3', label: 'August',  dueDate: '2026-08-01', amount: 500, status: 'pending' }
                ] }]
            }
        },
        finance: { payments: [{ id: 'pay_deposit', familyKey: 'fam_k', amount: 500, date: '2026-06-01', method: 'Card' }] }
    };
}

function cloudAfterAutopay() {
    const c = stale();
    c.families.fam_k.plans[0].installments[1] = {
        id: 'i2', label: 'July', dueDate: '2026-07-01', amount: 500, status: 'paid',
        paidDate: '2026-07-01', stripePaymentIntentId: 'pi_july'
    };
    c.finance.payments.push({
        id: 'auto_pi_july', familyKey: 'fam_k', family: 'Leah Klein', amount: 500,
        date: '2026-07-01', method: 'Autopay (card)', reference: 'pi_july',
        stripePaymentIntentId: 'pi_july', status: 'succeeded'
    });
    return c;
}

test('an autopay charge survives a save from a tab that predates it', () => {
    const local = stale();
    M.mergeCampistryMe(local, cloudAfterAutopay());

    const paid = local.finance.payments.filter((p) => p.id === 'auto_pi_july');
    assert.strictEqual(paid.length, 1, 'the autopay payment must come back');
    assert.strictEqual(paid[0].amount, 500);

    // And it is counted the way the ledger counts money: total collected goes up.
    const collected = local.finance.payments.reduce((n, p) => n + p.amount, 0);
    assert.strictEqual(collected, 1000, 'owed must fall by the amount charged');
});

test('the installment stays paid, so the card is not charged twice', () => {
    const local = stale();
    M.mergeCampistryMe(local, cloudAfterAutopay());
    const insts = local.families.fam_k.plans[0].installments;
    assert.strictEqual(insts[1].status, 'paid', 'a reset to pending is a second charge tomorrow');
    assert.strictEqual(insts[1].paidDate, '2026-07-01');
    assert.strictEqual(insts[1].stripePaymentIntentId, 'pi_july');
    assert.strictEqual(insts[2].status, 'pending', 'August is genuinely still due');
});

test('a partial charge carries the amount actually taken', () => {
    // The cron rewrites amount when the balance was smaller than the
    // instalment. Keeping the schedule's number would overstate what is owed.
    const local = stale();
    const cloud = cloudAfterAutopay();
    cloud.families.fam_k.plans[0].installments[1].amount = 120;
    M.mergeCampistryMe(local, cloud);
    assert.strictEqual(local.families.fam_k.plans[0].installments[1].amount, 120);
});

test('nothing is duplicated when the tab is already up to date', () => {
    const local = cloudAfterAutopay();
    const before = local.finance.payments.length;
    M.mergeCampistryMe(local, cloudAfterAutopay());
    assert.strictEqual(local.finance.payments.length, before, 'a payment counted twice halves the balance');
});

test('local edits win over the cloud copy of the same payment', () => {
    // The office corrects a payment it can see. The merge puts back what is
    // missing; it does not overrule what is there.
    const local = stale();
    local.finance.payments[0].amount = 450;
    local.finance.payments[0].notes = 'corrected';
    M.mergeCampistryMe(local, cloudAfterAutopay());
    const dep = local.finance.payments.find((p) => p.id === 'pay_deposit');
    assert.strictEqual(dep.amount, 450);
    assert.strictEqual(dep.notes, 'corrected');
});

test('an installment marked paid locally is never un-paid', () => {
    // Un-paying is exactly what makes the cron charge again, so the merge only
    // ever moves pending -> paid.
    const local = stale();
    local.families.fam_k.plans[0].installments[2].status = 'paid';
    local.families.fam_k.plans[0].installments[2].paidDate = '2026-07-15';
    M.mergeCampistryMe(local, cloudAfterAutopay());
    assert.strictEqual(local.families.fam_k.plans[0].installments[2].status, 'paid');
    assert.strictEqual(local.families.fam_k.plans[0].installments[2].paidDate, '2026-07-15');
});

test('a deleted family is not resurrected', () => {
    // Deleting a household is a real local action. A merge that undid it would
    // make the roster impossible to clean up.
    const local = stale();
    delete local.families.fam_k;
    M.mergeCampistryMe(local, cloudAfterAutopay());
    assert.ok(!local.families.fam_k, 'the merge must not put a deleted family back');
});

test('the card autopay runs on is not blanked by a stale tab', () => {
    // Written only by the processor webhooks — a browser never sets them, so a
    // local blank is staleness, and a blank one is why autopay logs "autopay is
    // on but no card on file" and quietly stops charging.
    const local = stale();
    local.families.fam_k.cardOnFile = false;
    local.families.fam_k.stripeCustomerId = '';
    const cloud = cloudAfterAutopay();
    cloud.families.fam_k.byopCustomerRef = 'cust_abc';
    M.mergeCampistryMe(local, cloud);
    assert.strictEqual(local.families.fam_k.cardOnFile, true);
    assert.strictEqual(local.families.fam_k.stripeCustomerId, 'cus_1');
    assert.strictEqual(local.families.fam_k.byopCustomerRef, 'cust_abc');
});

test('saved cards are unioned, not replaced', () => {
    const local = stale();
    local.families.fam_k.savedPaymentMethods = [{ id: 'pm_1', last4: '4242' }];
    const cloud = cloudAfterAutopay();
    cloud.families.fam_k.savedPaymentMethods = [{ id: 'pm_1', last4: '4242' }, { id: 'pm_2', last4: '1881' }];
    M.mergeCampistryMe(local, cloud);
    const ids = local.families.fam_k.savedPaymentMethods.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, ['pm_1', 'pm_2']);
});

test('a scrubbed finance branch does not overwrite the real one', () => {
    // Section access strips finance for a user without Billing. They must not
    // write the scrub back as truth.
    const local = stale();
    delete local.finance;
    M.mergeCampistryMe(local, cloudAfterAutopay());
    assert.strictEqual(local.finance.payments.length, 2);
});

test('legacy payments with no id are matched on what they are', () => {
    // Hand-recorded and imported rows predate ids. Without a fallback identity
    // every save would append another copy of each one.
    const a = { familyKey: 'fam_k', amount: 200, date: '2026-05-01', method: 'Check' };
    const merged = M.mergePayments([a], [{ ...a }]);
    assert.strictEqual(merged.length, 1, 'the same legacy payment must not double');
});

test('the merge is actually wired into the only cloud writer', () => {
    // The module can be correct and never run. It has to be loaded by the
    // pages and called by the upsert path that rewrites campistryMe.
    const hooks = fs.readFileSync(path.join(ROOT, 'integration_hooks.js'), 'utf8');
    assert.match(hooks, /CampistryFinanceMerge\.mergeCampistryMe/,
        'integration_hooks must merge before it upserts campistryMe');

    ['campistry_me.html', 'dashboard.html', 'flow.html'].forEach((page) => {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        assert.match(html, /<script src="campistry_finance_merge\.js\?v=/, page + ' does not load the merge');
        assert.ok(html.indexOf('campistry_finance_merge.js') < html.indexOf('integration_hooks.js'),
            page + ' loads the merge after the thing that uses it');
    });
});

// ── finding what was lost before the merge existed ──────────────────────────
//
// The merge closes the window; it cannot undo what already went through it.
// Migration 162 reports processor charges with nothing pointing at them, and
// Finance surfaces it. Both halves are easy to half-ship, so pin them.
test('the reconciliation migration exists and stays read-only', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/162_reconcile_processor_charges.sql'), 'utf8');

    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reconcile_processor_charges/);
    assert.match(sql, /_deposit_can_admin/, 'must be admin-gated');
    assert.match(sql, /SET search_path = public, pg_catalog/, 'SECURITY DEFINER needs a pinned search_path');
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reconcile_processor_charges/);
    assert.match(sql, /NOTIFY pgrst/, 'PostgREST will not see it without a schema reload');

    // Read-only is the whole design: it cannot say WHOSE a gap is, so it must
    // never write one to a guess.
    assert.ok(!/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?(camp_state_kv|processor_transactions|bank_deposits)\b/i.test(sql),
        'the reconciliation must not write to any ledger table');

    // A clean result must never read as a clean ledger — Stripe autopay never
    // recorded into this table at all.
    assert.match(sql, /'covers'/, 'the result must state what it does not cover');
    assert.match(sql, /Stripe/, 'the caveat has to name the rail it cannot see');
});

test('Finance can actually run the reconciliation', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /function finReconcileCharges/, 'the action is missing');
    assert.match(me, /rpc\('reconcile_processor_charges'/, 'it never calls the function');
    assert.match(me, /finReconcileCharges:finReconcileCharges/, 'not exposed, so the button cannot reach it');
    assert.match(me, /CampistryMe\.finReconcileCharges\(\)/, 'no button calls it');
    // The one failure a camp will actually hit is the migration not being
    // applied, and "schema cache" means nothing to them.
    assert.match(me, /Migration 162 has not been applied/, 'must explain an unapplied migration in words');
});

// ── what autopay charges against ────────────────────────────────────────────
//
// The cron computes a family's balance from the campistryMe blob alone. Zelle
// and ACH deposits deliberately live in bank_deposits (migration 145) and are
// unioned into the ledger at READ time by the browser — so the cron could not
// see them, and a family who had already paid by Zelle was charged their card
// for the same money. That is the exact opposite of what deposit capture is
// for, and it over-charges rather than under-charges, so it cannot be left to
// a follow-up.
test('autopay counts bank deposits when working out what is still owed', () => {
    const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/charge-due-installments/index.ts'), 'utf8');

    assert.match(src, /from\("bank_deposits"\)/, 'the cron never reads posted deposits');
    assert.match(src, /\.eq\("status",\s*"posted"\)/, 'only posted deposits are real money');
    assert.match(src, /depositsByFamily/, 'deposits are read but never reach the balance');
    assert.match(src, /billed - paid - credits - fromBank/, 'the balance must subtract them');

    // A bounced ACH is stored positive with is_reversal — counting it as a
    // credit would reduce what autopay charges on the strength of a payment
    // that just failed.
    assert.match(src, /is_reversal \? -1 : 1/, 'a reversal must subtract, not add');

    // Reading them is not optional: charging on a balance that ignores
    // deposits takes money twice, so a failed read must stop the run.
    assert.match(src, /deposit_read_failed/, 'a failed deposit read must abort the run, not warn');
});

test('a charge capped at the remaining balance explains itself', () => {
    // amount = min(scheduled, remaining). When they differ the plan would show
    // a number nobody scheduled — a $5 line on a $500 instalment — with no
    // record of why, which is exactly how a real autopay run comes to look
    // like corrupt data.
    const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/charge-due-installments/index.ts'), 'utf8');
    assert.match(src, /const capped = amount < scheduledAmount - 0\.005/);
    // Written into the patch that migration 169's RPC persists, not onto the
    // in-memory instalment — the whole-blob write this function used to do at
    // the end of the run is gone. recordInstallment applies the patch to `inst`
    // as well, so the rest of the run still reads it.
    assert.match(src, /patch\.scheduledAmount = scheduledAmount/, 'what the plan asked for must survive');
    assert.match(src, /cappedNote/, 'the instalment must carry the reason');
    assert.match(src, /capped \? "Autopay installment/, 'the ledger line must say it too');

    // Both rails, or the BYOP camps keep the confusing behaviour.
    const hits = src.match(/patch\.scheduledAmount = scheduledAmount/g) || [];
    assert.strictEqual(hits.length, 2, 'the Stripe and BYOP branches must both record it');

    // And the browser has to show it, or none of the above is visible.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /scheduled<br>the rest was already covered/, 'the plan table must explain the gap');
    assert.match(me, /scheduledAmount:i\.scheduledAmount/, 'the field is dropped before it reaches the table');
});
