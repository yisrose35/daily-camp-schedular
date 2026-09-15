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
