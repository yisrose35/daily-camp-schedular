// =============================================================================
// finance_payments_reach_the_bill.test.js — TED-157, TED-158, TED-160.
//
// TED-157. Finance → Revenue → "+ Record Payment" saved a row with a typed
// family name and nothing on the family's bill: Billing, the parent's Link
// balance and autopay never saw it, and the nightly run charged a $1,000
// cheque's family $1,000 again. It is now Billing's Record Payment.
//
// TED-158. Finance's ✕ removed only the list row: the payment (and its cheque
// discount) stayed on the ledger, so the family owed nothing for money the camp
// never kept. Removing a recorded payment now reverses it on the ledger.
//
// TED-160. The discount for a bank payment made online can be given once per
// payment, for a payment the office picks; a card refund of that payment takes
// its share of the discount back.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const B = require('../campistry_billing_core.js');
const F = require('../campistry_card_fees.js');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
const VARS = ME.match(/var _CASH_DISCOUNT_METHODS=\{[^}]*\};/)[0];

function office(policy) {
    // Moss owes $1,000 of tuition, on a real ledger
    const fam = { name: 'Moss', balance: 1000, charges: [], credits: [], entries: [] };
    B.post(fam, { id: 'le_chg_t', kind: 'charge', amount: 1000, reason: 'tuition' });
    const els = {}, toasts = [], dialogs = [];
    let onOk = null;
    const input = (id, value) => (els[id] = { value, addEventListener() {} });
    const ctx = {
        families: { moss: fam }, enrollSettings: { cardFeePolicy: policy || { mode: 'off' } }, finPayments: [],
        _cfAPI: () => F, _billingCore: () => B, _secEdit: () => true, esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2),
        today: () => '2026-08-20', save() {}, closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {}, renderFinance() {}, curPage: 'finance',
        toast: (t, k) => toasts.push([t, k]), showModal: (t, h, ok) => { onOk = ok; ctx.lastModal = h; },
        confirmDialog: async (o) => { dialogs.push(o); return true; },
        buildFamilyLedgers: () => ({ moss: { balance: B.balance(fam) } }),
        _payOptions: () => '', _payBlockedNote: () => '', _payAllowed: () => true, _payLabel: (m) => m, _payFamilyByName: () => null,
        document: { getElementById: (id) => els[id] || null },
    };
    const names = ['_cashDiscountFor', '_postCashDiscount', '_payDiscountPreview', 'openPaymentForFamily', 'finAddPayment',
        'finRemovePayment', '_removeRecordedPayment', '_postPaymentEntry', '_paymentRefOf', '_paymentRefsOf', '_postLedgerCredit',
        '_camperIdOf', '_giveCashDiscount', '_onlineBankPaymentsWithoutDiscount', '_famPaymentsIn', '_paidByCard',
        '_cashDiscountOf', '_cashDiscountBackOf', '_throughProcessor'];
    const extra = { normalizePersonId: () => null, camperNameById: () => null, _camperLabel: (x) => x, roster: {} };
    Object.assign(ctx, extra);
    const fns = new Function(...Object.keys(ctx), VARS + '\n' + names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
    return { fam, fns, ctx, els, toasts, dialogs, input, press: () => onOk && onOk() };
}

test('TED-157: Finance\'s "+ Record Payment" puts the cheque on the family\'s bill', () => {
    const o = office();
    o.fns.finAddPayment();                                    // Finance → Revenue → + Record Payment
    o.input('payFamKey', 'moss'); o.input('payAmount', '1000'); o.input('payDate', '2026-08-20');
    o.input('payMethod', 'check'); o.input('payRef', '#1042'); o.input('payNotes', '');
    o.press();
    assert.strictEqual(B.balance(o.fam), 0, 'the cheque never reached the bill — autopay would charge again');
    assert.strictEqual(o.ctx.finPayments.length, 1);
    assert.strictEqual(o.ctx.finPayments[0].familyKey, 'moss', 'the payment names its family by key, not typed name');
    assert.match(ME, /function finAddPayment\(\)\{\s*if\(!_secEdit\('billing','Recording a payment'\)\)return;\s*openPaymentForFamily\(null\);\s*\}/);
});

test('TED-158: Finance\'s ✕ takes the payment — and its cheque discount — off the bill', async () => {
    const o = office({ mode: 'cash_discount', cashDiscountPct: 3 });
    o.fns.openPaymentForFamily('moss');
    o.input('payFamKey', 'moss'); o.input('payAmount', '970'); o.input('payDate', '2026-08-20');
    o.input('payMethod', 'check'); o.input('payRef', ''); o.input('payNotes', '');
    o.press();
    assert.strictEqual(B.balance(o.fam), 0, 'setup: $970 by cheque settles $1,000');
    const id = o.ctx.finPayments[0].id;
    await o.fns.finRemovePayment(id);
    assert.strictEqual(B.balance(o.fam), 1000, 'the family still owes nothing for a cheque that was removed');
    assert.strictEqual(o.ctx.finPayments.length, 0);
    assert.strictEqual(o.fam.credits.length, 0, 'the discount stayed');
    assert.match(o.dialogs[0].message, /comes off Moss’s account — they will owe it again, and the \$30\.00 discount that came with it goes too/);
    // the history keeps both: the entries are reversed, not deleted
    assert.ok(o.fam.entries.some(e => e.reverses && e.kind === 'refund'), 'no reversal of the payment on the ledger');
    assert.ok(o.fam.entries.some(e => e.reverses && e.kind === 'charge'), 'no reversal of the discount on the ledger');
});

test('TED-158: money that went through the card processor is not "removed" — that is a refund', async () => {
    const o = office();
    o.ctx.finPayments.push({ id: 'pi_pi_1', familyKey: 'moss', amount: 500, stripePaymentIntentId: 'pi_1', date: '2026-08-01' });
    await o.fns.finRemovePayment('pi_pi_1');
    assert.strictEqual(o.ctx.finPayments.length, 1);
    assert.match(o.toasts[0][0], /use Issue Credit\/Refund/);
});

test('TED-160: the online-bank discount is for a payment the office picks, once', () => {
    const o = office({ mode: 'cash_discount', cashDiscountPct: 3 });
    // Moss paid $970 online by bank (the webhook's row, and its ledger entry)
    const bank = { id: 'pi_pi_b', familyKey: 'moss', amount: 970, stripePaymentIntentId: 'pi_b', method: 'ACH / Bank (online)', status: 'succeeded', date: '2026-08-10' };
    o.ctx.finPayments.push(bank);
    o.fns._postPaymentEntry(o.fam, bank);
    assert.strictEqual(B.balance(o.fam), 30);
    o.fns._giveCashDiscount('moss');
    assert.match(o.ctx.lastModal, /2026-08-10 — \$970\.00/);
    o.input('cdPay', 'pi_pi_b');
    o.press();
    assert.strictEqual(B.balance(o.fam), 0);
    assert.strictEqual(o.fam.credits[0].id, 'cdisc_pi_pi_b');
    // again: that payment is no longer offered, and nothing more is given
    o.fns._giveCashDiscount('moss');
    assert.match(o.ctx.lastModal, /already has its discount/);
    assert.strictEqual(o.fam.credits.length, 1);
    // a card payment is never offered
    o.ctx.finPayments.push({ id: 'pi_pi_c', familyKey: 'moss', amount: 100, stripePaymentIntentId: 'pi_c', method: 'Credit Card (online)', status: 'succeeded' });
    assert.deepStrictEqual(o.fns._onlineBankPaymentsWithoutDiscount('moss').map(p => p.id), []);
});

test('TED-160: refunding a discounted payment takes its share of the discount back — exactly, over partial refunds', () => {
    const o = office();
    const p = { id: 'pi_pi_b', amount: 970 };
    o.fam.credits.push({ id: 'cdisc_pi_pi_b', amount: 30, cashDiscount: true, paymentId: 'pi_pi_b' });
    const a = o.fns._cashDiscountBackOf(o.fam, p, 0, 500);
    const b = o.fns._cashDiscountBackOf(o.fam, p, 500, 470);
    assert.strictEqual(a, 15.46);
    assert.strictEqual(Math.round((a + b) * 100) / 100, 30, 'partial refunds did not add up to the discount');
    assert.strictEqual(o.fns._cashDiscountBackOf(o.fam, { id: 'other', amount: 100 }, 0, 100), 0);
    // the card refund posts it, carrying the refund's id (for 281 if the refund fails)
    assert.match(ME, /var _db=_cashDiscountBackOf\(f,p,_before,chunk\);/);
    assert.match(ME, /cashDiscountBack:true,paymentId:p\.id,refundId:refId\|\|null/);
});

test('TED-163: a refund that went through Stripe or Sola, or a failed refund\'s put-back, cannot be "removed"', async () => {
    for (const row of [
        { id: 'ref_1', familyKey: 'moss', amount: -970, method: 'Refund', stripeRefundId: 're_1', refundOf: 'pi_pi_b' },
        { id: 'ref_2', familyKey: 'moss', amount: -500, method: 'Refund', byopRefundId: 'R9', byopProcessor: 'cardknox' },
        { id: 'refail_re_3', familyKey: 'moss', amount: 970, method: 'Refund failed', failedRefundId: 're_3', status: 'succeeded' },
        { id: 'ext_re_4', familyKey: 'moss', amount: -100, method: 'Refund', stripeRefundId: 're_4' },   // made in the Stripe dashboard
    ]) {
        const o = office();
        o.ctx.finPayments.push(row);
        const before = B.balance(o.fam);
        await o.fns.finRemovePayment(row.id);
        assert.strictEqual(o.ctx.finPayments.length, 1, row.id + ' was removed');
        assert.strictEqual(B.balance(o.fam), before, row.id + ' moved the balance');
        assert.strictEqual(o.dialogs.length, 0, 'it even asked to remove ' + row.id);
        assert.match(o.toasts[0][0], /processor/);
    }
    // an offline refund the office typed in can still be taken back
    assert.strictEqual(o_fns_throughProcessor({ id: 'ref_5', amount: -50, method: 'Refund', offline: true }), false);
    // and the Payment Log shows no ✕ on processor rows
    assert.match(ME, /var _acts=_throughProcessor\(p\)\?'':'<button/);
});
function o_fns_throughProcessor(p) { return office().fns._throughProcessor(p); }

test('Ted\'s wording note: a row that never reached the bill is removed without claiming a balance change', async () => {
    const o = office();
    o.ctx.finPayments.push({ id: 1700000000000, family: 'Moss', familyKey: 'moss', amount: 970, method: 'check', date: '2026-08-01', status: 'paid' });
    await o.fns.finRemovePayment('1700000000000');
    assert.match(o.dialogs[0].message, /It was never on Moss’s bill, so no balance changes\./);
    assert.strictEqual(B.balance(o.fam), 1000);
    assert.strictEqual(o.toasts[o.toasts.length - 1][0], 'Payment removed');
});
