// =============================================================================
// office_plan_is_ledger_plan.test.js — TED-056. The office's Set Up / Edit
// Payment Plan writes the SAME plan a parent builds (dueDates, the amount
// worked out at charge time), never an installments[] plan; and reopening a
// plan keeps what it already collected.
//
// The real _mpBuildLedgerPlan and _planSchedule are cut from campistry_me.js.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cut(name) {
    const at = SRC.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = SRC.indexOf('{', at), d = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
    return SRC.slice(at, i + 1);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(cut('_mpBuildLedgerPlan') + '\n' + cut('_planSchedule') + '\nthis.build=_mpBuildLedgerPlan;this.sched=_planSchedule;', ctx);

const rows = (dates) => dates.map((d, i) => ({ n: i + 1, amount: 100, dueDate: d, status: 'pending' }));

test('a new office plan is a ledger plan: dates, no installments[]', () => {
    const p = ctx.build(null, rows(['2026-07-01', '2026-06-01', '2026-08-01']), true, 300);
    assert.ok(!('installments' in p), 'the office wrote an installments[] plan');
    assert.deepStrictEqual(Array.from(p.dueDates), ['2026-06-01', '2026-07-01', '2026-08-01']);
    assert.strictEqual(p.nextIndex, 0);
    assert.strictEqual(p.count, 3);
    assert.strictEqual(p.autopay, true);
    assert.strictEqual(p.source, 'office');
    assert.ok(p.id);
});

test('editing a parent-built plan keeps its id, collected payments and history', () => {
    const parent = { id: 'plan_p', dueDates: ['2026-06-01', '2026-07-01', '2026-08-01'], count: 3, nextIndex: 1,
                     history: [{ index: 0, dueDate: '2026-06-01', charged: 400 }], autopay: true, source: 'parent', createdAt: 'X' };
    const p = ctx.build(parent, rows(['2026-07-15', '2026-09-01']), true, 800);
    assert.strictEqual(p.id, 'plan_p');
    assert.strictEqual(p.source, 'parent');
    assert.strictEqual(p.createdAt, 'X');
    assert.strictEqual(p.nextIndex, 1, 'the payment already collected was forgotten');
    assert.deepStrictEqual(Array.from(p.dueDates), ['2026-06-01', '2026-07-15', '2026-09-01']);
    assert.strictEqual(p.history.length, 1);
    assert.ok(!('installments' in p));
});

test('editing an old installments[] plan turns it into a ledger plan, paid ones kept as history', () => {
    const old = { id: 'plan_o', installments: [
        { n: 1, amount: 500, dueDate: '2026-06-01', status: 'paid', paymentId: 'pay_1', paidDate: '2026-06-01' },
        { n: 2, amount: 500, dueDate: '2026-07-01', status: 'pending' }], autopay: true, total: 1000 };
    const p = ctx.build(old, rows(['2026-07-01']), true, 500);
    assert.ok(!('installments' in p));
    assert.deepStrictEqual(Array.from(p.dueDates), ['2026-06-01', '2026-07-01']);
    assert.strictEqual(p.nextIndex, 1);
    assert.strictEqual(p.history[0].charged, 500);
    assert.strictEqual(p.history[0].paymentId, 'pay_1');
});

test('TED-068: the office\'s typed amounts are what the schedule shows and autopay charges', () => {
    const plan = ctx.build(null, [
        { n: 1, amount: 1000, dueDate: '2026-06-01' }, { n: 2, amount: 200, dueDate: '2026-07-01' },
        { n: 3, amount: 200, dueDate: '2026-08-01' }], true, 1400);
    assert.deepStrictEqual(Array.from(plan.amounts), [1000, 200, 200]);
    const s = ctx.sched(plan, 1400);
    assert.deepStrictEqual(Array.from(s, x => x.amount), [1000, 200, 200], 'the typed amounts were not kept');
});

test('TED-068: a plan for $600 of a $1,400 balance charges $300 + $300, not $700 + $700', () => {
    const plan = ctx.build(null, [{ n: 1, amount: 300, dueDate: '2026-06-01' }, { n: 2, amount: 300, dueDate: '2026-07-01' }], true, 600);
    const s = ctx.sched(plan, 1400);
    assert.deepStrictEqual(Array.from(s, x => x.amount), [300, 300]);
});

test('TED-068: never more than is owed, and a plan without amounts still splits evenly', () => {
    const plan = ctx.build(null, [{ n: 1, amount: 500, dueDate: '2026-06-01' }], true, 500);
    assert.strictEqual(ctx.sched(plan, 120)[0].amount, 120);
    const even = { id: 'p', dueDates: ['2026-06-01', '2026-07-01', '2026-08-01'], nextIndex: 1, history: [] };
    assert.deepStrictEqual(Array.from(ctx.sched(even, 600), x => x.amount), [null, 300, 300]);
});

test('editing keeps the amounts already charged for past dates', () => {
    const p = ctx.build({ id: 'x', dueDates: ['2026-06-01', '2026-07-01'], amounts: [700, 700], nextIndex: 1, history: [] },
                       [{ n: 1, amount: 350, dueDate: '2026-08-01' }, { n: 2, amount: 350, dueDate: '2026-09-01' }], true, 700);
    assert.deepStrictEqual(Array.from(p.amounts), [700, 350, 350]);
    assert.deepStrictEqual(Array.from(p.dueDates), ['2026-06-01', '2026-08-01', '2026-09-01']);
});

test('the editor reopens a plan from its schedule, not from installments[] (a parent-built plan used to crash it)', () => {
    assert.doesNotMatch(SRC, /var startRows=existingPlan\?existingPlan\.installments\.map/);
    assert.match(SRC, /var newPlan=_mpBuildLedgerPlan\(existingPlan,insts,!!auto,total\);/);
});

test('TED-076: editing a plan keeps it paused, keeps its collection block and a debit in flight', () => {
    const blocked = { reason: 'declined', attempts: 2, nextRetryAt: '2026-07-10' };
    const held = { paymentIntentId: 'pi_ach', index: 0, dueDate: '2026-06-01', amount: 300 };
    const p = ctx.build({ id: 'x', dueDates: ['2026-06-01'], nextIndex: 0, history: [], paused: true, collectionBlocked: blocked, pendingCharge: held },
                       rows(['2026-06-01', '2026-07-01']), true, 600);
    assert.strictEqual(p.paused, true, 'editing un-paused the plan');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.collectionBlocked)), blocked);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.pendingCharge)), held);
    assert.strictEqual(ctx.build(null, rows(['2026-06-01']), true, 100).paused, false);
});

test('TED-074: an application asking for a payment plan always gives the office the Set Up button', () => {
    const at = SRC.indexOf("if(e.paymentMethod==='payment_plan'){");
    assert.ok(at > 0);
    const branch = SRC.slice(at, SRC.indexOf("}else if(e.paymentMethod==='credit_card'", at));
    assert.doesNotMatch(branch, /allowParentPaymentPlans/, 'the setting still hides the office\'s button');
    assert.match(branch, /CampistryMe\.monthlyPlan\(/);
    assert.doesNotMatch(SRC, /build their own plan from their Link portal/, 'the office is still told a builder exists that does not');
    // the switch says what it really does: offers the choice on the registration form
    assert.match(SRC, /Let parents ask for a payment plan on the registration form/);
});

test('TED-080: the parent portal shows the amounts autopay will charge', () => {
    const LINK = fs.readFileSync(path.join(__dirname, '..', 'campistry_link_parent.html'), 'utf8');
    const at = LINK.indexOf('function _lkPlanSchedule(');
    let i = LINK.indexOf('{', at), d = 0;
    for (; i < LINK.length; i++) { if (LINK[i] === '{') d++; else if (LINK[i] === '}' && --d === 0) break; }
    const lctx = {}; vm.createContext(lctx);
    vm.runInContext(LINK.slice(at, i + 1) + '\nthis.s=_lkPlanSchedule;', lctx);
    const plan = { dueDates: ['2026-06-01', '2026-07-01', '2026-08-01'], amounts: [1000, 200, 200], nextIndex: 0 };
    assert.deepStrictEqual(Array.from(lctx.s(plan, 1400), x => x.amount), [1000, 200, 200]);
    // and exactly what the office sees
    assert.deepStrictEqual(Array.from(lctx.s(plan, 1400), x => x.amount), Array.from(ctx.sched(plan, 1400), x => x.amount));
    assert.deepStrictEqual(Array.from(lctx.s({ dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 }, 600), x => x.amount), [300, 300]);
});
