// =============================================================================
// deposits_reach_the_family.test.js — TED-089/090, the real code.
//
//   * A deposit a parent paid by card when applying becomes ONE refundable
//     payment on the family and lowers the balance — once, however often
//     Billing loads. The office's "Mark deposit received" (no card reference)
//     is left alone.
//   * A tab that loaded an application before the parent paid does not save
//     it back unpaid (campistry_finance_merge.js).
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ME = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
const B = require(path.join(ROOT, 'campistry_billing_core.js'));
const M = require(path.join(ROOT, 'campistry_finance_merge.js'));

function cut(name) {
    const at = ME.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
function load() {
    const ctx = { _billingCore: () => B, finPayments: [], roster: {}, today: () => '2026-07-01' };
    vm.createContext(ctx);
    vm.runInContext(['_camperIdOf', '_paymentRefOf', '_paymentRefsOf', '_postPaymentEntry', '_postCardDepositsFor'].map(cut).join('\n')
        + '\nthis.post=_postCardDepositsFor;', ctx);
    return ctx;
}
const family = () => {
    const f = { name: 'Gold', entries: [] };
    B.post(f, { id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', note: 'Tuition' });
    return f;
};

test('TED-090: a card-paid deposit lowers the family\'s balance, once', () => {
    const ctx = load(), f = family();
    const e = { camperName: 'Avi', depositPaid: 250, depositReference: 'pi_dep', depositProcessor: 'stripe',
                depositCharges: [{ ref: 'pi_dep', amount: 250, date: '2026-05-01', processor: 'stripe' }] };
    assert.ok(ctx.post(f, 'gold', e, 'e1') > 0);
    ctx.post(f, 'gold', e, 'e1'); ctx.post(f, 'gold', e, 'e1');
    assert.strictEqual(B.balance(f), 750);
    assert.strictEqual(ctx.finPayments.length, 1, 'the deposit became more than one payment');
    const p = ctx.finPayments[0];
    assert.strictEqual(p.stripePaymentIntentId, 'pi_dep', 'not refundable: no Stripe payment on the row');
    assert.strictEqual(p.familyKey, 'gold');
});

test('TED-090: a Cardknox deposit is refundable through the camp\'s processor', () => {
    const ctx = load(), f = family();
    ctx.post(f, 'gold', { depositCharges: [{ ref: '9001', amount: 250, processor: 'cardknox' }] }, 'e1');
    assert.strictEqual(ctx.finPayments[0].byopTransactionId, '9001');
    assert.strictEqual(ctx.finPayments[0].byopProcessor, 'cardknox');
    assert.strictEqual(B.balance(f), 750);
});

test('an application from before 271 (one reference, no list) still counts', () => {
    const ctx = load(), f = family();
    ctx.post(f, 'gold', { depositPaid: 250, depositReference: 'pi_old' }, 'e1');
    assert.strictEqual(B.balance(f), 750);
});

test('the office\'s "Mark deposit received" is not turned into money', () => {
    const ctx = load(), f = family();
    assert.strictEqual(ctx.post(f, 'gold', { depositPaid: 250, depositStatus: 'paid' }, 'e1'), 0);
    assert.strictEqual(B.balance(f), 1000);
    assert.strictEqual(ctx.finPayments.length, 0);
});

test('Billing\'s load runs it for every enrolled camper\'s family', () => {
    assert.match(ME, /_posted\+=_postCardDepositsFor\(families\[fk\],fk,e,eid\)/);
});

test('TED-089: a tab that loaded the application before the parent paid does not save it back unpaid', () => {
    const local = { enrollments: { e1: { camperName: 'Avi', status: 'accepted', depositRequired: 250, notes: 'office note' } } };
    const cloud = { enrollments: { e1: { camperName: 'Avi', status: 'applied', depositRequired: 250, depositPaid: 250,
        depositReference: 'pi_dep', depositStatus: 'paid', depositCharges: [{ ref: 'pi_dep', amount: 250 }] } } };
    M.mergePublicSubmissions(local, cloud);
    const e = local.enrollments.e1;
    assert.strictEqual(e.depositPaid, 250);
    assert.strictEqual(e.depositReference, 'pi_dep');
    assert.strictEqual(e.status, 'accepted', 'the office\'s own edit was lost');
    assert.strictEqual(e.notes, 'office note');
});

test('the office\'s own deposit edit stands when the server has nothing newer', () => {
    const local = { enrollments: { e1: { depositPaid: 0, depositReference: 'pi_dep', depositStatus: 'awaiting' } } };
    const cloud = { enrollments: { e1: { depositPaid: 250, depositReference: 'pi_dep', depositStatus: 'paid' } } };
    M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(local.enrollments.e1.depositPaid, 0);
});
