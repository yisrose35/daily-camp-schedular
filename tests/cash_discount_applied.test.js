// =============================================================================
// cash_discount_applied.test.js — TED-153, Billing's own code.
//
// Card Fees' "discount for not paying by card" is promised on the registration
// form ("Paying by cheque or bank transfer takes 3% off") and was never given:
// a family paying $970 by cheque against $1,000 still owed $30, and the
// office's only card-fee tool said "That works out to no fee". Now Record
// Payment gives it for a cheque, cash or bank payment, as its own credit line,
// and the family menu's tool gives it for a bank payment made online.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const F = require('../campistry_card_fees.js');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
const VARS = ME.match(/var _CASH_DISCOUNT_METHODS=\{[^}]*\};/)[0];

function office(policy, owed) {
    const fam = { name: 'Gold', balance: owed, charges: [], credits: [] };
    const toasts = [], posted = [], els = {};
    let onOk = null;
    const input = (id, value) => (els[id] = { value, addEventListener() {} });
    const ctx = {
        families: { gold: fam }, enrollSettings: { cardFeePolicy: policy }, finPayments: [],
        _cfAPI: () => F, _secEdit: () => true, esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2),
        today: () => '2026-08-20', save() {}, closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {}, curPage: 'billing',
        toast: (t) => toasts.push(t), showModal: (t, h, ok) => { onOk = ok; },
        buildFamilyLedgers: () => ({ gold: { balance: fam.balance } }),
        _payOptions: () => '', _payBlockedNote: () => '', _payAllowed: () => true,
        _postPaymentEntry: () => true,   // the real one posts to the ledger; the handler moves f.balance
        _postLedgerCredit: (f, c) => { posted.push(c); return true; },
        document: { getElementById: (id) => els[id] || null },
    };
    const names = ['_cashDiscountFor', '_postCashDiscount', '_payDiscountPreview', 'openPaymentForFamily'];
    const fns = new Function(...Object.keys(ctx), VARS + '\n' + names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
    const pay = (amount, method) => {
        els.payDiscount = { innerHTML: '' };
        fns.openPaymentForFamily('gold');
        input('payFamKey', 'gold'); input('payAmount', String(amount)); input('payDate', '2026-08-20');
        input('payMethod', method); input('payRef', ''); input('payNotes', '');
        onOk();
    };
    return { fam, fns, pay, posted, toasts, ctx, els, press: () => onOk && onOk(), input };
}
const THREE = { mode: 'cash_discount', cashDiscountPct: 3 };

test('TED-153: $970 by cheque against $1,000 settles it — the $30 discount is its own line', () => {
    const o = office(THREE, 1000);
    o.pay(970, 'check');
    assert.strictEqual(o.fam.balance, 0, 'the family still owes the discount');
    assert.strictEqual(o.fam.credits.length, 1);
    const c = o.fam.credits[0];
    assert.strictEqual(c.amount, 30);
    assert.strictEqual(c.reason, 'discount');
    assert.strictEqual(c.cashDiscount, true);
    assert.match(c.note, /Discount for not paying by card \(3% on \$1000\.00\)/);
    assert.deepStrictEqual(o.posted.map(p => p.id), [c.id], 'not on the ledger');
    assert.match(o.toasts[0], /with \$30\.00 off for not paying by card/);
});

test('TED-153: the full posted price by cheque earns the same $30 back as credit', () => {
    const o = office(THREE, 1000);
    o.pay(1000, 'check');
    assert.strictEqual(o.fam.balance, -30);
});

test('TED-153: two part payments add up to exactly the discount on the bill', () => {
    const o = office(THREE, 1000);
    o.pay(500, 'ach');
    o.pay(470, 'zelle');
    const total = o.fam.credits.reduce((t, c) => t + c.amount, 0);
    assert.strictEqual(Math.round(total * 100) / 100, 30);
    assert.strictEqual(o.fam.balance, 0);
});

test('TED-153: a card, PayPal or "other" payment pays the posted price; other card-fee modes give nothing', () => {
    for (const m of ['credit', 'debit', 'paypal', 'other']) {
        const o = office(THREE, 1000);
        o.pay(970, m);
        assert.strictEqual(o.fam.credits.length, 0, m);
    }
    const s = office({ mode: 'surcharge', surchargePct: 3 }, 1000);
    s.pay(970, 'check');
    assert.strictEqual(s.fam.credits.length, 0);
});

test('TED-153: a flat discount comes off per payment', () => {
    const o = office({ mode: 'cash_discount', cashDiscountFlat: 10 }, 1000);
    o.pay(990, 'cash');
    assert.strictEqual(o.fam.credits[0].amount, 10);
    assert.strictEqual(o.fam.balance, 0);
});

test('TED-153: Record Payment shows the discount before it is saved', () => {
    const o = office(THREE, 1000);
    o.els.payDiscount = { innerHTML: '' };
    o.fns.openPaymentForFamily('gold');
    o.input('payFamKey', 'gold'); o.input('payAmount', '970'); o.input('payMethod', 'check');
    o.fns._payDiscountPreview();
    assert.match(o.els.payDiscount.innerHTML, /Discount for not paying by card: <strong>\$30\.00<\/strong>/);
});

test('TED-153: the family tool is for bank payments made online (which payment: tests/finance_payments_reach_the_bill.test.js)', () => {
    assert.match(cut('_giveCashDiscount'), /_onlineBankPaymentsWithoutDiscount\(famKey\)/);
});

test('TED-153: the Card Fees setting says where the discount is given', () => {
    assert.match(ME, /Taken off automatically when you record a cheque, cash or bank-transfer payment in Billing/);
});
