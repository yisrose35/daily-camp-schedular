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

test('the office sees the edited plan with the amounts still owed, split evenly', () => {
    const p = ctx.build({ id: 'x', dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 1, history: [] }, rows(['2026-08-01', '2026-09-01']), false, 0);
    const s = ctx.sched(p, 600);
    assert.strictEqual(s.length, 3);
    assert.strictEqual(s[0].status, 'paid');
    assert.strictEqual(s[1].amount, 300);
    assert.strictEqual(s[2].amount, 300);
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
