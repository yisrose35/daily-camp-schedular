// node --test tests/installments.test.js
//
// The old model stamped a calendar at enrolment: today, +30, +60. Two ordinary
// things break it. A family joining in May gets May/June/July while a February
// family gets February/March/April — same plan, no month on which the office can
// "run installment 2", because there are as many as there are application dates.
// And a camp that bills late has a schedule claiming money was due on a date
// nothing happened on.
//
// CampMinder's model, and now ours: the counter belongs to the FAMILY and moves
// when they are INVOICED. Nobody advances because a date passed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const I = require(path.join(__dirname, '..', 'campistry_installments.js'));
// The catalogue is a global in a browser and a require() here. Injected, so that
// "a camp turned plans off" is testable at all rather than silently defaulting on.
const PAY = require(path.join(__dirname, '..', 'campistry_payments.js'));
I.useCatalogue(PAY);

const SES3 = { paymentPlan: '3', startDate: '2026-06-28' };
const SESDEP = { paymentPlan: 'deposit', depositAmount: 500, startDate: '2026-06-28' };

// ── building a schedule ────────────────────────────────────────────────────

test('a schedule always totals the tuition it was built from', () => {
    [[1000, '2'], [1000, '3'], [999.99, '3'], [1000, '7'], [0.03, '3'], [1234.56, '4']]
        .forEach(([tuition, plan]) => {
            const sch = I.build({ session: { paymentPlan: plan }, tuition, today: '2026-03-01' });
            assert.strictEqual(I.total(sch), Math.round(tuition * 100) / 100,
                tuition + ' over ' + plan);
        });
});

test('the odd pennies ride on the FIRST payment, not the last', () => {
    // The other way round leaves a penny outstanding at the end of the summer, and
    // somebody has to chase it.
    const sch = I.build({ session: { paymentPlan: '3' }, tuition: 1000, today: '2026-03-01' });
    assert.strictEqual(sch[0].amount, 333.34);
    assert.strictEqual(sch[1].amount, 333.33);
    assert.strictEqual(sch[2].amount, 333.33);
});

test('a deposit plan is the deposit and the rest', () => {
    const sch = I.build({ session: SESDEP, tuition: 2000, today: '2026-03-01' });
    assert.strictEqual(sch.length, 2);
    assert.strictEqual(sch[0].amount, 500);
    assert.strictEqual(sch[1].amount, 1500);
    assert.strictEqual(sch[1].dueDate, '2026-06-28', 'the balance is due when camp starts');
    assert.strictEqual(I.total(sch), 2000);
});

test('a deposit larger than the tuition does not create a negative balance', () => {
    const sch = I.build({ session: { paymentPlan: 'deposit', depositAmount: 9999 },
                          tuition: 2000, today: '2026-03-01' });
    assert.strictEqual(I.total(sch), 2000);
    assert.ok(sch.every(s => s.amount >= 0));
    assert.strictEqual(sch.length, 1, 'and no empty second installment');
});

test('no plan means no schedule', () => {
    [{ paymentPlan: 'full' }, { paymentPlan: '' }, {}].forEach(ses =>
        assert.strictEqual(I.build({ session: ses, tuition: 1000 }), null));
    assert.strictEqual(I.build({ session: SES3, tuition: 0 }), null, 'nor does nothing owed');
});

// ── a camp can switch plans off ────────────────────────────────────────────

test('unticking Payment plan means no plans at all', () => {
    // Not a plan that is offered and then refused — none built in the first place.
    assert.strictEqual(I.plansAllowed({ enabled: ['credit', 'cash'] }), false);
    assert.strictEqual(I.build({ session: SES3, tuition: 1000,
                                 policy: { enabled: ['credit', 'cash'] } }), null);
});

test('a camp that allows plans still gets them', () => {
    assert.strictEqual(I.plansAllowed({ enabled: ['credit', 'plan'] }), true);
    assert.ok(I.build({ session: SES3, tuition: 900,
                        policy: { enabled: ['credit', 'plan'] } }));
});

test('no stored policy means plans are allowed, as before the catalogue existed', () => {
    assert.strictEqual(I.plansAllowed({}), true);
    assert.strictEqual(I.plansAllowed(), true);
});

test('NO CATALOGUE AT ALL still allows plans', () => {
    // A camp must not lose payment plans because a script tag is missing. This path
    // is otherwise never reached, since the suite injects a catalogue at the top —
    // which is exactly how a mutation making a missing catalogue mean "plans off"
    // stayed green.
    I.useCatalogue(null);
    try {
        assert.strictEqual(I.plansAllowed({ enabled: ['credit'] }), true,
            'without a catalogue there is nothing to consult, so do not withhold');
        assert.ok(I.build({ session: SES3, tuition: 900, today: '2026-03-01' }),
            'and a schedule still gets built');
    } finally {
        I.useCatalogue(PAY);
    }
});

test('an explicitly passed catalogue wins over the injected one', () => {
    // So a caller holding its own policy does not depend on module-level state.
    const noPlans = { forContext: () => [{ id: 'credit', label: 'Credit card' }] };
    assert.strictEqual(I.plansAllowed({}, noPlans), false);
    assert.strictEqual(I.build({ session: SES3, tuition: 900, payments: noPlans }), null);
});

// ── the progression: invoicing advances, dates do not ──────────────────────

test('a new schedule sits on its first installment', () => {
    const sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    const cur = I.current(sch);
    assert.strictEqual(cur.index, 0);
    assert.strictEqual(cur.done, false);
    assert.strictEqual(cur.installment.label, 'Payment 1 of 3');
});

test('INVOICING is what advances a family, not a date passing', () => {
    let sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });

    // Years later. Every dueDate is long gone and the family has still not moved,
    // because nobody has billed them.
    assert.strictEqual(I.current(sch).index, 0, 'a passed date must not advance anyone');

    sch = I.invoiceNext(sch, { on: '2026-05-10' }).schedule;
    assert.strictEqual(I.current(sch).index, 1, 'invoicing moved them');
    assert.strictEqual(sch[0].status, 'invoiced');
    assert.strictEqual(sch[0].invoicedAt, '2026-05-10');
});

test('two families on the same plan can sit on different installments', () => {
    // The thing a calendar model cannot represent at all.
    const a = I.invoiceNext(I.build({ session: SES3, tuition: 900, today: '2026-03-01' })).schedule;
    let b = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    b = I.invoiceNext(b).schedule;
    b = I.invoiceNext(b).schedule;
    assert.strictEqual(I.current(a).index, 1);
    assert.strictEqual(I.current(b).index, 2);
});

test('a plan cannot grow by being run again', () => {
    // A plan that gains an installment every time somebody runs it bills forever.
    let sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    for (let i = 0; i < 3; i++) sch = I.invoiceNext(sch).schedule;
    assert.strictEqual(sch.length, 3);
    const again = I.invoiceNext(sch);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, 'all_invoiced');
    assert.strictEqual(again.schedule.length, 3);
    assert.strictEqual(I.current(sch).done, true);
});

test('invoicing records what happened WITHOUT erasing what was intended', () => {
    // Overwriting dueDate would hide that the camp billed two months late.
    let sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    const intended = sch[0].dueDate;
    sch = I.invoiceNext(sch, { on: '2026-05-10', dueDate: '2026-05-25' }).schedule;
    assert.strictEqual(sch[0].dueDate, intended, 'the intention survives');
    assert.strictEqual(sch[0].invoicedAt, '2026-05-10');
    assert.strictEqual(sch[0].invoiceDueDate, '2026-05-25');
});

test('invoiceNext does not mutate the schedule it was given', () => {
    // A caller storing the returned array must not already have had its own changed.
    const sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    I.invoiceNext(sch);
    assert.strictEqual(sch[0].status, 'pending');
});

test('a family not on a plan is refused rather than invoiced', () => {
    const r = I.invoiceNext(null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_schedule');
    assert.match(r.message, /not on a payment plan/);
});

// ── what is actually owed ──────────────────────────────────────────────────

test('owed means INVOICED and unpaid, never merely overdue by date', () => {
    // This is what makes aging honest: a family is late because they were billed and
    // did not pay, not because a date slipped by while the office was busy.
    let sch = I.build({ session: SES3, tuition: 900, today: '2020-01-01' });
    assert.strictEqual(I.owedNow(sch).total, 0,
        'three long-passed dueDates, nothing invoiced, nothing owed');

    sch = I.invoiceNext(sch).schedule;
    assert.strictEqual(I.owedNow(sch).total, 300);

    sch = I.markPaid(sch, 0).schedule;
    assert.strictEqual(I.owedNow(sch).total, 0, 'paid is not owed');
    assert.strictEqual(sch[0].status, 'paid');
    assert.ok(sch[0].paidAt);
});

test('owed adds up across several invoiced installments', () => {
    let sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    sch = I.invoiceNext(sch).schedule;
    sch = I.invoiceNext(sch).schedule;
    const owed = I.owedNow(sch);
    assert.strictEqual(owed.total, 600);
    assert.strictEqual(owed.items.length, 2);
});

test('markPaid refuses an installment that is not there', () => {
    const sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    assert.strictEqual(I.markPaid(sch, 99).ok, false);
    assert.strictEqual(I.markPaid(sch, -1).ok, false);
});

// ── the line an office reads ────────────────────────────────────────────────

test('describe says where they are and what is outstanding', () => {
    let sch = I.build({ session: SES3, tuition: 900, today: '2026-03-01' });
    assert.match(I.describe(sch), /Next: Payment 1 of 3/);
    sch = I.invoiceNext(sch).schedule;
    assert.match(I.describe(sch), /Next: Payment 2 of 3/);
    assert.match(I.describe(sch), /1 awaiting payment/);
    sch = I.markPaid(sch, 0).schedule;
    assert.match(I.describe(sch), /1 paid/);
    sch = I.invoiceNext(sch).schedule;
    sch = I.invoiceNext(sch).schedule;
    assert.match(I.describe(sch), /All 3 invoiced/);
    assert.strictEqual(I.describe(null), '');
});

test('nothing here throws on rubbish', () => {
    [undefined, null, {}, 'x', 42, [null, 'x']].forEach(arg => {
        assert.doesNotThrow(() => I.current(arg));
        assert.doesNotThrow(() => I.owedNow(arg));
        assert.doesNotThrow(() => I.describe(arg));
        assert.doesNotThrow(() => I.total(arg));
        assert.doesNotThrow(() => I.invoiceNext(arg));
        assert.doesNotThrow(() => I.build(arg));
    });
});

test('the page delegates to this rule instead of keeping its own maths', () => {
    // campistry_me.js had its own body doing the split in DOLLARS with Math.floor,
    // and not asking whether the camp allows plans at all. It must call the rule —
    // an assertion that the rule merely exists says nothing about who uses it.
    const ME = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
    const fn = ME.slice(ME.indexOf('function _buildInstallmentSchedule(sesObj,tuition)'));
    const body = fn.slice(0, 900);
    assert.match(body, /window\.CampistryInstallments/);
    assert.match(body, /if\(R\)return R\.build\(\{session:sesObj,tuition:tuition\}\);/,
        'the rule must be asked FIRST, before the fallback runs');
    // The old body survives only as a fallback, after the delegation.
    assert.ok(body.indexOf('R.build(') < body.indexOf('Math.floor'),
        'the fallback must come after the delegation, not instead of it');
});
