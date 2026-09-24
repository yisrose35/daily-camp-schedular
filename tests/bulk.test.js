// node --test tests/bulk.test.js
//
// campistry_bulk.js is the half that was missing. campistry_installments.js made
// INVOICING the event that advances a family's plan, and nothing in the app ever
// invoiced anybody — so every schedule sat `pending` forever and the aging report
// had nothing to age. Same shape for late fees: campistry_ar.js proposes them and
// stamps each proposal with a dedupe key nobody checked.
//
// A bulk action is the one place "it mostly worked" is unacceptable, because nobody
// re-reads 120 rows to find the four that did not. So the tests care as much about
// what gets SKIPPED, and why, as about what gets done.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const B = require(path.join(__dirname, '..', 'campistry_bulk.js'));
const I = require(path.join(__dirname, '..', 'campistry_installments.js'));
const A = require(path.join(__dirname, '..', 'campistry_ar.js'));

B.useInstallments(I);

/** A two-payment schedule, all pending. */
function sched(amounts) {
    return (amounts || [500, 500]).map((a, i) => ({
        n: i + 1, of: (amounts || [500, 500]).length,
        label: 'Payment ' + (i + 1) + ' of ' + (amounts || [500, 500]).length,
        amount: a, dueDate: '2026-06-0' + (i + 1), status: 'pending'
    }));
}

// ── 1. an installment run ─────────────────────────────────────────────────

test('a run invoices every family’s NEXT installment, not all of them', () => {
    const p = B.planInvoiceRun({
        families: [{ key: 'f1', name: 'Klein', schedule: sched([300, 700]) }],
        on: '2026-06-01'
    });
    assert.strictEqual(p.count, 1);
    assert.strictEqual(p.total, 300, 'the first installment, not the whole plan');
    assert.strictEqual(p.run[0].index, 0);
    assert.strictEqual(p.run[0].schedule[0].status, 'invoiced');
    assert.strictEqual(p.run[0].schedule[1].status, 'pending',
        'a run must advance a family by ONE installment');
});

test('the new schedule comes back with the run, so nothing has to be re-derived', () => {
    const before = sched([300, 700]);
    const p = B.planInvoiceRun({ families: [{ key: 'f1', schedule: before }], on: '2026-06-01' });
    assert.strictEqual(p.run[0].schedule[0].invoicedAt, '2026-06-01');
    assert.strictEqual(before[0].status, 'pending',
        'the caller’s own array must not be mutated before they agree to the run');
});

test('what the office asks for is recorded BESIDE the schedule’s date, not over it', () => {
    // Overwriting dueDate would erase the fact that the camp billed late, which is
    // the one thing aging needs to be honest about.
    const p = B.planInvoiceRun({
        families: [{ key: 'f1', schedule: sched() }],
        on: '2026-08-01', dueDate: '2026-08-31'
    });
    assert.strictEqual(p.run[0].installment.dueDate, '2026-06-01', 'the intent survives');
    assert.strictEqual(p.run[0].installment.invoiceDueDate, '2026-08-31');
    assert.strictEqual(p.run[0].installment.invoicedAt, '2026-08-01');
});

test('a family with nothing left to invoice is SKIPPED and named', () => {
    // Not given an extra installment. A plan that grows by being run again is a plan
    // that bills a family forever.
    const done = sched().map(s => Object.assign({}, s, { status: 'invoiced' }));
    const p = B.planInvoiceRun({ families: [{ key: 'f1', name: 'Klein', schedule: done }] });
    assert.strictEqual(p.count, 0);
    assert.strictEqual(p.skipped.length, 1);
    assert.strictEqual(p.skipped[0].reason, 'all_invoiced');
    assert.strictEqual(p.skipped[0].name, 'Klein');
    assert.match(p.skipped[0].message, /already invoiced/);
});

test('a family not on a plan is skipped with a different reason', () => {
    const p = B.planInvoiceRun({ families: [{ key: 'f1', name: 'Klein', schedule: [] }] });
    assert.strictEqual(p.skipped[0].reason, 'no_schedule');
    assert.match(p.skipped[0].message, /Not on a payment plan/);
});

test('a zero installment is skipped rather than invoiced for nothing', () => {
    // An invoice asking for 0.00 is worse than no invoice: the family has to work
    // out whether it was a mistake.
    const p = B.planInvoiceRun({ families: [{ key: 'f1', schedule: sched([0, 500]) }] });
    assert.strictEqual(p.count, 0);
    assert.strictEqual(p.skipped[0].reason, 'nothing_owed');
});

test('the runnable and the skipped are both reported from one mixed run', () => {
    const p = B.planInvoiceRun({ families: [
        { key: 'a', name: 'A', schedule: sched([100, 100]) },
        { key: 'b', name: 'B', schedule: sched().map(s => Object.assign({}, s, { status: 'paid' })) },
        { key: 'c', name: 'C', schedule: sched([250, 250]) },
        { key: 'd', name: 'D', schedule: null }
    ] });
    assert.strictEqual(p.count, 2);
    assert.strictEqual(p.total, 350);
    assert.strictEqual(p.skipped.length, 2);
    assert.strictEqual(p.run.map(r => r.key).join(','), 'a,c');
    assert.strictEqual(p.skipped.map(s => s.key).join(','), 'b,d');
});

test('a paid installment does not block the next one', () => {
    const s = sched([100, 200]);
    s[0].status = 'paid';
    const p = B.planInvoiceRun({ families: [{ key: 'f1', schedule: s }] });
    assert.strictEqual(p.run[0].index, 1);
    assert.strictEqual(p.total, 200);
});

test('something that is not the rule is not mistaken for it', () => {
    // The duck-type is invoiceNext, not truthiness. An object that fails it must fall
    // through to the real rule rather than being called and throwing mid-run — a
    // half-invoiced run is the one outcome there is no clean recovery from.
    const p = B.planInvoiceRun({
        families: [{ key: 'f1', name: 'Klein', schedule: sched([300, 700]) }],
        installments: { nope: true }
    });
    assert.strictEqual(p.count, 1, 'it must fall back to the real rule');
    assert.strictEqual(p.total, 300);
});

test('an explicit rule is preferred over the injected one', () => {
    const p = B.planInvoiceRun({
        families: [{ key: 'f1', schedule: sched() }],
        installments: {
            invoiceNext: () => ({ ok: true, reason: 'ok', index: 7,
                                  installment: { amount: 42, label: 'Stub' }, schedule: [] })
        }
    });
    assert.strictEqual(p.total, 42);
    assert.strictEqual(p.run[0].label, 'Stub');
});

test('with no rule at all every family is skipped as no_rule and the plan is not ok', () => {
    // require() would hand back the cached module, which this file has already
    // injected the rule into — so it has to be loaded FRESH, in a context with no
    // window to find a global on either.
    const vm = require('node:vm');
    const fs = require('node:fs');
    const box = { module: { exports: {} }, console };
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'campistry_bulk.js'), 'utf8'),
        vm.createContext(box));
    const fresh = box.module.exports;
    const p = fresh.planInvoiceRun({ families: [{ key: 'f1', name: 'Klein', schedule: sched() }] });
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.count, 0);
    assert.strictEqual(p.skipped[0].reason, 'no_rule');
});

test('describeRun says nothing when there is nothing to run', () => {
    assert.strictEqual(B.describeRun(B.planInvoiceRun({ families: [] })), '');
    const p = B.planInvoiceRun({ families: [
        { key: 'a', schedule: sched([100, 100]) },
        { key: 'b', schedule: [] }
    ] });
    assert.strictEqual(B.describeRun(p), '1 family · 100.00 · 1 skipped');
});

// ── 2. a bulk credit or charge ────────────────────────────────────────────

const T3 = [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }, { key: 'c', name: 'C' }];

test('"each" gives every account the same amount', () => {
    const p = B.planBulkEntry({ targets: T3, kind: 'credit', mode: 'each',
                                amount: 50, reason: 'Sibling discount' });
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.count, 3);
    assert.strictEqual(p.total, 150);
    p.entries.forEach(e => assert.strictEqual(e.amount, 50));
});

test('"split" sums to EXACTLY the amount asked for', () => {
    // 1000 / 3 is the case that goes wrong in dollars. A pot that grants 999.99 of
    // 1000.00 has a cent nobody can account for and no longer reconciles.
    const p = B.planBulkEntry({ targets: T3, kind: 'credit', mode: 'split',
                                amount: 1000, reason: 'Scholarship pot' });
    assert.strictEqual(p.total, 1000);
    const summed = p.entries.reduce((n, e) => n + e.amount, 0);
    assert.strictEqual(Math.round(summed * 100) / 100, 1000);
    assert.strictEqual(p.entries.map(e => e.amount).join(','), '333.34,333.33,333.33',
        'the odd pennies ride on the FIRST account, as an installment split does');
});

test('a split always sums to exactly what was asked for', () => {
    // This stands in for the post-hoc "did that add up?" check the module
    // deliberately does not carry: working in integer cents makes the sum exact by
    // construction, so a guard could never fire, and the property is worth more
    // proved over a range than asserted in a branch nothing reaches. Every ratio
    // here is one that goes wrong if the arithmetic moves to dollars, or if the
    // remainder is dropped or handed to the wrong account.
    const cases = [[100, 3], [0.03, 3], [1, 7], [9999.99, 13], [7, 6], [0.05, 5],
                   [1000, 3], [12345.67, 97], [2, 3], [0.1, 3], [50, 49]];
    for (let n = 2; n <= 60; n++) cases.push([n * 3.33 + 0.01, n]);
    for (const [total, n] of cases) {
        const targets = Array.from({ length: n }, (_, i) => ({ key: 'k' + i, name: 'N' + i }));
        const p = B.planBulkEntry({ targets, kind: 'charge', mode: 'split',
                                    amount: total, reason: 'r' });
        assert.strictEqual(p.ok, true, total + '/' + n + ' should be splittable');
        assert.strictEqual(p.entries.length, n, 'every account gets an entry');
        const summedC = p.entries.reduce((s, e) => s + Math.round(e.amount * 100), 0);
        assert.strictEqual(summedC, Math.round(total * 100),
            total + ' split ' + n + ' ways came to ' + (summedC / 100));
        // And nobody gets nothing, which is the other way a split goes wrong.
        p.entries.forEach(e => assert.ok(e.amount > 0,
            'a zero share in a ' + total + '/' + n + ' split'));
    }
});

test('a split too thin to give anybody anything is refused, not posted as zeroes', () => {
    const targets = Array.from({ length: 400 }, (_, i) => ({ key: 'k' + i }));
    const p = B.planBulkEntry({ targets, kind: 'credit', mode: 'split',
                                amount: 3, reason: 'r' });
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.reason, 'too_thin');
    assert.strictEqual(p.entries.length, 0);
    assert.match(p.message, /Raise the amount or select fewer/);
});

test('a reason is required, for a credit and for a charge alike', () => {
    ['credit', 'charge'].forEach(kind => {
        const p = B.planBulkEntry({ targets: T3, kind, mode: 'each', amount: 10, reason: '  ' });
        assert.strictEqual(p.ok, false);
        assert.strictEqual(p.reason, 'no_reason');
        assert.match(p.message, /indistinguishable from a mistake/);
    });
});

test('nobody selected, or no amount, is refused before anything is computed', () => {
    let p = B.planBulkEntry({ targets: [], kind: 'credit', mode: 'each', amount: 10, reason: 'r' });
    assert.strictEqual(p.reason, 'no_targets');
    p = B.planBulkEntry({ targets: T3, kind: 'credit', mode: 'each', amount: 0, reason: 'r' });
    assert.strictEqual(p.reason, 'no_amount');
    p = B.planBulkEntry({ targets: T3, kind: 'credit', mode: 'each', amount: -5, reason: 'r' });
    assert.strictEqual(p.reason, 'no_amount', 'a negative bulk credit is a charge in disguise');
});

test('a target with no key is dropped rather than posted to nowhere', () => {
    const p = B.planBulkEntry({ targets: [{ key: 'a' }, { name: 'no key' }, null],
                                kind: 'credit', mode: 'each', amount: 10, reason: 'r' });
    assert.strictEqual(p.count, 1);
    assert.strictEqual(p.total, 10, 'the total must follow the accounts that survived');
});

test('an unknown kind or mode falls back to the safe one', () => {
    const p = B.planBulkEntry({ targets: T3, kind: 'nonsense', mode: 'nonsense',
                                amount: 10, reason: 'r' });
    assert.strictEqual(p.kind, 'credit', 'a credit costs a family nothing; a charge does not');
    assert.strictEqual(p.mode, 'each');
});

test('describeBulk names the direction, because the two are opposites', () => {
    const c = B.planBulkEntry({ targets: T3, kind: 'credit', mode: 'each', amount: 10, reason: 'r' });
    const d = B.planBulkEntry({ targets: T3, kind: 'charge', mode: 'each', amount: 10, reason: 'r' });
    assert.match(B.describeBulk(c), /^Credit 30\.00 across 3 accounts$/);
    assert.match(B.describeBulk(d), /^Charge 30\.00/);
    assert.strictEqual(B.describeBulk({ ok: false }), '');
});

// ── 3. credits covering what is owed ──────────────────────────────────────

const OBS = [
    { id: 'i1', label: 'Installment 1', kind: 'installment', amount: 500, paid: 0, dueDate: '2026-06-01' },
    { id: 'dep', label: 'Deposit', kind: 'deposit', amount: 200, paid: 0, dueDate: '2026-07-01' },
    { id: 'reg', label: 'Registration fee', kind: 'registration', amount: 75, paid: 0, dueDate: '2026-07-15' }
];

test('a deposit is covered before an older installment', () => {
    // The deposit is the one that BLOCKS something. A family with money on account
    // being asked for a deposit is the app failing at arithmetic in public.
    const p = B.planCoverage({ credit: 200, obligations: OBS });
    assert.strictEqual(p.applications[0].id, 'dep');
    assert.strictEqual(p.applications[0].amount, 200);
    assert.strictEqual(p.applied, 200);
    assert.strictEqual(p.leftover, 0);
});

test('deposit, then registration, then everything else', () => {
    const p = B.planCoverage({ credit: 1000, obligations: OBS });
    assert.strictEqual(p.applications.map(a => a.id).join(','), 'dep,reg,i1');
    assert.strictEqual(p.applied, 775);
    assert.strictEqual(p.leftover, 225);
    assert.match(p.warnings.join(' '), /225\.00 of the credit is left over/);
});

test('a partial cover is named as partial and never overshoots', () => {
    const p = B.planCoverage({ credit: 120, obligations: OBS });
    assert.strictEqual(p.applications.length, 1);
    assert.strictEqual(p.applications[0].amount, 120);
    assert.strictEqual(p.applications[0].full, false);
    assert.strictEqual(p.partial, 'dep');
    assert.strictEqual(p.covered.length, 0);
    assert.strictEqual(p.leftover, 0);
});

test('an already-part-paid obligation only draws what is still owed', () => {
    const p = B.planCoverage({ credit: 1000, obligations: [
        { id: 'dep', kind: 'deposit', amount: 200, paid: 150 }
    ] });
    assert.strictEqual(p.applications[0].amount, 50);
    assert.strictEqual(p.applied, 50);
});

test('a settled obligation is not in the plan at all', () => {
    const p = B.planCoverage({ credit: 100, obligations: [
        { id: 'a', kind: 'deposit', amount: 200, paid: 200 },
        { id: 'b', kind: 'fee', amount: 50, paid: 0 }
    ] });
    assert.strictEqual(p.applications.map(a => a.id).join(','), 'b');
});

test('among equal kinds, the oldest due date goes first', () => {
    const p = B.planCoverage({ credit: 10, obligations: [
        { id: 'late', kind: 'fee', amount: 5, dueDate: '2026-05-01' },
        { id: 'later', kind: 'fee', amount: 5, dueDate: '2026-09-01' }
    ] });
    assert.strictEqual(p.applications.map(a => a.id).join(','), 'late,later');
});

test('an obligation with NO due date sorts last, not first', () => {
    // A blank date is not evidence of being the oldest, and treating it as such
    // would jump it ahead of a deposit that really is overdue.
    const p = B.planCoverage({ credit: 5, obligations: [
        { id: 'undated', kind: 'fee', amount: 5, dueDate: '' },
        { id: 'dated', kind: 'fee', amount: 5, dueDate: '2026-09-01' }
    ] });
    assert.strictEqual(p.applications.map(a => a.id).join(','), 'dated');
});

test('no credit, or nothing owed, is refused with the right explanation', () => {
    let p = B.planCoverage({ credit: 0, obligations: OBS });
    assert.strictEqual(p.ok, false);
    assert.match(p.warnings[0], /no credit on this account/);
    p = B.planCoverage({ credit: 500, obligations: [] });
    assert.strictEqual(p.ok, false);
    assert.match(p.warnings[0], /Nothing is outstanding/);
});

test('coverage never applies more than the credit, whatever is owed', () => {
    const many = Array.from({ length: 20 },
        (_, i) => ({ id: 'o' + i, kind: 'fee', amount: 100, dueDate: '2026-06-01' }));
    const p = B.planCoverage({ credit: 250, obligations: many });
    const summed = Math.round(p.applications.reduce((n, a) => n + a.amount, 0) * 100) / 100;
    assert.strictEqual(summed, 250);
    assert.strictEqual(p.applied, 250);
    assert.strictEqual(p.leftover, 0);
});

test('describeCoverage is empty when nothing would be applied', () => {
    assert.strictEqual(B.describeCoverage(B.planCoverage({ credit: 0, obligations: OBS })), '');
    const p = B.planCoverage({ credit: 1000, obligations: OBS });
    assert.strictEqual(B.describeCoverage(p), '775.00 against 3 items · 225.00 left on account');
});

// ── 4. late fees, actually applied ────────────────────────────────────────

/** A real proposal, from the real rule, so the key is the real key. */
function proposals(asOf) {
    return A.assessLateFees({
        docs: [{ id: 'inv1', kind: 'invoice', status: 'open', amount: 500, paid: 0,
                 dueDate: '2026-06-01' }],
        policy: { mode: 'flat', flat: 25, frequency: 'monthly' },
        asOf: asOf
    });
}

test('running the month twice charges the fee ONCE', () => {
    // Being charged twice because an office clicked a button twice is not a rounding
    // error, and "we'll notice" is not a control.
    const first = B.planLateFees({ proposals: proposals('2026-07-05'), applied: {} });
    assert.strictEqual(first.count, 1);
    const applied = B.recordLateFees({}, first, '2026-07-05');
    const second = B.planLateFees({ proposals: proposals('2026-07-05'), applied: applied });
    assert.strictEqual(second.count, 0);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.alreadyApplied.length, 1);
});

test('the NEXT month is a new fee, because the period is in the key', () => {
    const july = proposals('2026-07-05');
    const applied = B.recordLateFees({}, B.planLateFees({ proposals: july, applied: {} }),
        '2026-07-05');
    const august = B.planLateFees({ proposals: proposals('2026-08-05'), applied: applied });
    assert.strictEqual(august.count, 1, 'a month later is a different fee');
    assert.notStrictEqual(august.toApply[0].key, july[0].key);
});

test('the same key proposed twice in ONE run is applied once', () => {
    // A duplicate inside a single run double-charges exactly as effectively as a
    // duplicate across two runs.
    const p = proposals('2026-07-05');
    const doubled = B.planLateFees({ proposals: [p[0], Object.assign({}, p[0])], applied: {} });
    assert.strictEqual(doubled.count, 1);
    assert.strictEqual(doubled.alreadyApplied.length, 1);
    // 1 Jun due, 5 Jul as-of is 34 days late; monthly is one period per completed
    // 30 days past grace, so ceil(34/30) = 2 and a flat 25 comes to 50.
    assert.strictEqual(doubled.total, 50);
});

test('a keyless or zero proposal is ignored entirely', () => {
    // Ignored, not applied: a fee with no key can never be deduped, so applying it
    // would guarantee a double-charge on the next run.
    const p = B.planLateFees({ proposals: [
        { key: '', amount: 25 }, { key: 'k1', amount: 0 }, { key: 'k2', amount: -5 }, null
    ], applied: {} });
    assert.strictEqual(p.count, 0);
    assert.strictEqual(p.alreadyApplied.length, 0, 'these were never candidates');
});

test('recordLateFees does not mutate the record it is given', () => {
    const before = { old: '2026-06-01' };
    const p = B.planLateFees({ proposals: proposals('2026-07-05'), applied: {} });
    const after = B.recordLateFees(before, p, '2026-07-05');
    assert.deepStrictEqual(Object.keys(before), ['old'], 'the stored record must be replaced, not edited');
    assert.strictEqual(Object.keys(after).length, 2);
    assert.strictEqual(after.old, '2026-06-01', 'the history survives');
});

test('recordLateFees stamps the date it was applied, not just a flag', () => {
    const p = B.planLateFees({ proposals: proposals('2026-07-05'), applied: {} });
    const rec = B.recordLateFees({}, p, '2026-07-05');
    assert.strictEqual(rec[p.toApply[0].key], '2026-07-05');
});

test('a policy that is off proposes nothing, so there is nothing to dedupe', () => {
    const none = A.assessLateFees({
        docs: [{ id: 'inv1', kind: 'invoice', status: 'open', amount: 500, paid: 0,
                 dueDate: '2026-01-01' }],
        policy: {}, asOf: '2026-09-01'
    });
    const p = B.planLateFees({ proposals: none, applied: {} });
    assert.strictEqual(p.count, 0);
    assert.match(B.describeLateFees(p), /Nothing is late enough/);
});

test('describeLateFees distinguishes "nothing late" from "already done"', () => {
    const first = B.planLateFees({ proposals: proposals('2026-07-05'), applied: {} });
    assert.match(B.describeLateFees(first), /^1 fee · 50\.00$/);   // 2 periods × 25
    const applied = B.recordLateFees({}, first, '2026-07-05');
    const again = B.planLateFees({ proposals: proposals('2026-07-05'), applied: applied });
    assert.match(B.describeLateFees(again), /Already applied/);
});

test('the total only counts what will actually be charged', () => {
    const p = proposals('2026-07-05');
    const applied = B.recordLateFees({}, B.planLateFees({ proposals: p, applied: {} }),
        '2026-07-05');
    const mixed = B.planLateFees({
        proposals: p.concat([{ key: 'lf_inv2_p1', docId: 'inv2', amount: 40, periods: 1 }]),
        applied: applied
    });
    assert.strictEqual(mixed.total, 40, 'the already-applied fee must not be in the total');
    assert.strictEqual(mixed.count, 1);
    assert.strictEqual(mixed.alreadyApplied.length, 1);
});

// ── 5. telling the family ─────────────────────────────────────────────────

test('two parents sharing an inbox get ONE copy', () => {
    const p = B.planSend({ kind: 'invoice', recipients: [
        { key: 'f1', name: 'Klein', emails: ['a@x.com', 'A@X.com', 'b@x.com'] }
    ] });
    assert.strictEqual(p.count, 1);
    assert.strictEqual(p.send[0].to.join(','), 'a@x.com,b@x.com');
    assert.strictEqual(p.addresses, 2);
});

test('two families sharing an address each get their own document', () => {
    // A grandparent paying for two households is owed two invoices, not one.
    // Deduping across families would quietly drop the second family's bill.
    const p = B.planSend({ recipients: [
        { key: 'f1', name: 'Klein', emails: ['gran@x.com'] },
        { key: 'f2', name: 'Stein', emails: ['gran@x.com'] }
    ] });
    assert.strictEqual(p.count, 2);
    assert.strictEqual(p.send.map(s => s.key).join(','), 'f1,f2');
});

test('a family with no usable address is named, not silently dropped', () => {
    // A run that marks installments invoiced and reaches nobody is worse than one
    // that refuses: the office believes it has asked and the family has not been.
    const p = B.planSend({ recipients: [
        { key: 'f1', name: 'Klein', emails: [] },
        { key: 'f2', name: 'Stein', emails: ['  '] },
        { key: 'f3', name: 'Gross', emails: ['not-an-address'] },
        { key: 'f4', name: 'Weiss', emails: ['ok@x.com'] }
    ] });
    assert.strictEqual(p.count, 1);
    assert.strictEqual(p.noEmail.map(x => x.name).join(','), 'Klein,Stein,Gross');
});

test('an ordinary address is not rejected by an over-strict pattern', () => {
    // A dropped invoice looks exactly like a family who ignored one, so the bar is
    // one @ with something either side rather than a guess at the RFC.
    ['a+tag@x.co.uk', "o'brien@x.com", 'a.b-c_d@sub.domain.museum', 'ünïcode@x.com']
        .forEach(e => {
            const p = B.planSend({ recipients: [{ key: 'f', name: 'N', emails: [e] }] });
            assert.strictEqual(p.count, 1, e + ' should be deliverable');
        });
});

test('an address with a space, or two @, is refused', () => {
    ['a b@x.com', 'a@b@x.com', '@x.com', 'a@'].forEach(e => {
        const p = B.planSend({ recipients: [{ key: 'f', name: 'N', emails: [e] }] });
        assert.strictEqual(p.count, 0, e + ' should not be deliverable');
    });
});

test('the kind rides along, and an unknown kind is an invoice', () => {
    assert.strictEqual(B.planSend({ kind: 'statement',
        recipients: [{ key: 'f', emails: ['a@x.com'] }] }).send[0].kind, 'statement');
    assert.strictEqual(B.planSend({ kind: 'nonsense',
        recipients: [{ key: 'f', emails: ['a@x.com'] }] }).kind, 'invoice');
});

test('describeSend distinguishes "nobody has an email" from "nobody selected"', () => {
    assert.match(B.describeSend(B.planSend({ recipients: [] })), /Nobody to send to/);
    assert.match(B.describeSend(B.planSend({ recipients: [{ key: 'f', emails: [] }] })),
        /Nobody on this list has an email/);
    const p = B.planSend({ recipients: [
        { key: 'f1', name: 'A', emails: ['a@x.com', 'b@x.com'] },
        { key: 'f2', name: 'B', emails: [] }
    ] });
    assert.strictEqual(B.describeSend(p), '1 family · 2 addresses · 1 with no email');
});
