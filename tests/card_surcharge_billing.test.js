// =============================================================================
// card_surcharge_billing.test.js — TED-140 and TED-141, Billing's own code.
//
// TED-140. "Add card surcharge…" quoted every family as if its card were a
// credit card, so a family whose only saved card is DEBIT got a 3% fee — which
// the card brands forbid, and which the project's own card-fee rules refuse
// when asked about the real card. It now asks about the family's card.
//
// TED-141. A surcharge goes back in proportion to what is refunded (a
// card-brand rule). The rule existed (campistry_card_fees.refundShare) and no
// screen used it: a $1,000 refund of a $1,030 payment ($30 of it the fee) kept
// all $30 on the bill. Billing's card refund now takes the fee's share off.
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
const LIVE = { mode: 'surcharge', surchargePct: 3, state: 'NY', processorNotifiedOn: '2026-01-01' };

function billing(family, policy) {
    const toasts = [], saved = [];
    let onOk = null;
    const ctx = {
        families: { gold: family }, enrollSettings: { cardFeePolicy: policy || LIVE }, _giveCashDiscount: () => 'discount-tool',
        _cfAPI: () => F, _secEdit: () => true, esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2),
        today: () => '2026-08-01', save: () => saved.push(1), closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {},
        curPage: 'billing', _postLedgerCharge: () => true, toast: (t, k) => toasts.push([t, k]),
        showModal: (title, html, ok) => { onOk = ok; }, _surchargePreview() {},
        document: { getElementById: (id) => id === 'csBase' ? { value: '1000' } : null },
    };
    const names = ['addCardSurcharge', '_familyCardOnFile', '_familyCardFunding', '_familyCardLabel', '_familyDefaultIsBank'];
    const fn = new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { addCardSurcharge, _familyCardFunding };')(...Object.values(ctx));
    return { fn, toasts, press: () => onOk && onOk(), family };
}

test('TED-140: a family whose card on file is DEBIT is not surcharged', () => {
    const b = billing({ name: 'Gold', balance: 1000, charges: [], stripePaymentMethodId: 'pm_d',
        savedPaymentMethods: [{ token: 'pm_d', type: 'card', label: 'Visa •4242', funding: 'debit' }] });
    assert.strictEqual(b.fn._familyCardFunding(b.family), 'debit');
    b.fn.addCardSurcharge('gold');
    b.press();
    assert.strictEqual(b.family.charges.length, 0, 'a surcharge was added to a debit card');
    assert.ok(b.toasts.some(([t, k]) => k === 'error'), JSON.stringify(b.toasts));
});

test('TED-140: a card whose type is not on file is not surcharged either (never assumed credit)', () => {
    const b = billing({ name: 'Gold', balance: 1000, charges: [], stripePaymentMethodId: 'pm_x',
        savedPaymentMethods: [{ token: 'pm_x', type: 'card', label: 'Card on file' }] });
    assert.strictEqual(b.fn._familyCardFunding(b.family), 'unknown');
    b.fn.addCardSurcharge('gold');
    b.press();
    assert.strictEqual(b.family.charges.length, 0);
});

test('TED-140: a CREDIT card on file is surcharged — 3% of $1,000, and the card type is recorded', () => {
    const b = billing({ name: 'Gold', balance: 1000, charges: [], stripePaymentMethodId: 'pm_c',
        savedPaymentMethods: [{ token: 'pm_d', type: 'card', funding: 'debit' }, { token: 'pm_c', type: 'card', label: 'Visa •1111', funding: 'credit' }] });
    b.fn.addCardSurcharge('gold');
    b.press();
    assert.strictEqual(b.family.charges.length, 1, JSON.stringify(b.toasts));
    assert.strictEqual(b.family.charges[0].amount, 30);
    assert.strictEqual(b.family.charges[0].cardFee.funding, 'credit');
});

// ── the surcharge belongs to the card payment that paid it (TED-146) ────────
const T0 = Date.parse('2026-08-01T12:00:00Z');
function feeWorld(fam, payments) {
    const ctx = { _cfAPI: () => F, families: { fam }, finPayments: payments,
        normalizePersonId: () => null, camperNameById: () => null, REFUND_WINDOW_DAYS: 120, _paymentAgeDays: () => 1 };
    const names = ['_famPaymentsIn', '_refundedFrom', '_paidByCard', '_surchargeCarried', '_feeShareOfRefund', '_surchargeShare',
        '_surchargeKept', '_refundFeeShare', '_famRefundableOnline', '_famRefundableOnlineAll', '_famRefundablePayments'];
    return new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
}
const sur = (fee, base, at) => ({ id: 'sur_' + at, amount: fee, date: '2026-08-01', timestamp: at, cardFee: { mode: 'surcharge', base } });
const pay = (id, amount, at, extra) => Object.assign({ id, family: 'X', familyKey: 'fam', amount, date: '2026-08-01', timestamp: at,
    stripePaymentIntentId: 'pi_' + id, method: 'Credit Card (online)' }, extra || {});

test('TED-141: Silver — a $1,000 refund of a $1,030 card payment returns $29.13 of the $30; the rest returns $0.87', () => {
    const silver = { name: 'X', charges: [sur(30, 1000, T0)], credits: [] };
    const pays = [pay('p1', 1030, T0 + 60000)];
    const w = feeWorld(silver, pays);
    assert.deepStrictEqual(w._surchargeCarried(silver), { p1: 30 });
    assert.strictEqual(w._refundFeeShare(silver, 1000), 29.13);
    assert.strictEqual(w._refundFeeShare(silver, 1030), 30, 'a whole refund returns the whole fee');
    pays.push({ id: 'r1', amount: -1000, refundOf: 'p1', familyKey: 'fam' });
    assert.strictEqual(w._surchargeKept(silver), 0.87);
    assert.strictEqual(w._refundFeeShare(silver, 30), 0.87, 'two refunds add up to more than the fee');
});

test('TED-146: Bronze — the deposit paid before the fee carries none of it; refunding the $3,090 returns all $90', () => {
    const bronze = { name: 'X', charges: [sur(90, 3000, T0)], credits: [] };
    const pays = [pay('dep', 500, T0 - 30 * 86400000, { date: '2026-07-01' }), pay('bal', 3090, T0 + 60000)];
    const w = feeWorld(bronze, pays);
    assert.deepStrictEqual(w._surchargeCarried(bronze), { bal: 90 });
    assert.strictEqual(w._refundFeeShare(bronze, 3090), 90, 'part of the surcharge stayed on the bill of a fully refunded payment');
});

test('TED-146: Copper — a refund drawn from the BANK payment returns none of the card surcharge', () => {
    const copper = { name: 'X', charges: [sur(30, 1000, T0)], credits: [] };
    const pays = [pay('card', 1030, T0 + 60000), pay('bank', 2000, T0 + 86400000, { method: 'ACH / Bank (online)' })];
    const w = feeWorld(copper, pays);
    assert.deepStrictEqual(w._surchargeCarried(copper), { card: 30 });
    assert.strictEqual(w._refundFeeShare(copper, 500), 0, 'a bank refund returned card surcharge');
    // the office's own charge row says card or bank
    const pays2 = [pay('card', 1030, T0 + 60000, { method: 'Stripe (auto)', paidWith: 'card' }),
                   pay('bank', 2000, T0 + 86400000, { method: 'Stripe (auto)', paidWith: 'us_bank_account' })];
    assert.strictEqual(feeWorld(copper, pays2)._refundFeeShare(copper, 500), 0);
});

test('TED-146/148: a refund that failed and was put back does not count — the full share is returned again, once', () => {
    const slate = { name: 'X', charges: [sur(30, 1000, T0)], credits: [] };
    const pays = [pay('p1', 1030, T0 + 60000), { id: 'r1', amount: -1000, refundOf: 'p1', stripeRefundId: 're_1', familyKey: 'fam' },
                  { id: 'refail_re_1', amount: 1000, failedRefundId: 're_1', familyKey: 'fam', status: 'succeeded', method: 'Refund failed' }];
    const w = feeWorld(slate, pays);
    assert.strictEqual(w._surchargeKept(slate), 30);
    assert.strictEqual(w._refundFeeShare(slate, 1000), 29.13, 'after the put-back, a second refund of $1,000 is not $0.84');
});

test('TED-144: a payment still on its way or one that failed is not refundable (and carries no surcharge)', () => {
    const fam = { name: 'X', charges: [], credits: [] };
    const w = feeWorld(fam, [pay('a', 500, T0, { status: 'pending' }), pay('b', 500, T0, { status: 'failed' }), pay('c', 200, T0)]);
    assert.deepStrictEqual(w._famRefundableOnline(fam).map(d => d.p.id), ['c']);
});

test('TED-141/146: Billing\'s card refund posts one surcharge credit per refund, carrying the refund\'s id', () => {
    assert.match(ME, /var _carried=_surchargeCarried\(f\), _feeBack=0, _feeCredits=\[\];/);
    assert.match(ME, /var _share=_feeShareOfRefund\(_carried\[String\(p\.id\)\]\|\|0,p,_before,chunk\);/);
    assert.match(ME, /refundId:refId\|\|null,refundOf:p\.id,/);
    assert.match(ME, /cardFeeReturn:true/);
    assert.match(ME, /_postLedgerCredit\(f,_fc\);/);
});

test('TED-146: the window\'s "Balance owed after this refund" includes the surcharge\'s share', () => {
    const silver = { name: 'X', balance: 0, charges: [sur(30, 1000, T0)], credits: [] };
    const els = { crFamKey: { value: 'fam' }, crRefundAmount: { value: '1000' }, crType: { value: 'refund_gateway' }, crBalancePreview: { innerHTML: '', textContent: '' } };
    const ctx = { _cfAPI: () => F, families: { fam: silver }, finPayments: [pay('p1', 1030, T0 + 60000)],
        normalizePersonId: () => null, camperNameById: () => null, REFUND_WINDOW_DAYS: 120, _paymentAgeDays: () => 1,
        fm: (n) => '$' + Number(n).toFixed(2), document: { getElementById: (id) => els[id] || null } };
    const names = ['_famPaymentsIn', '_refundedFrom', '_paidByCard', '_surchargeCarried', '_feeShareOfRefund', '_surchargeShare',
        '_refundFeeShare', '_famRefundableOnline', '_famRefundableOnlineAll', '_famRefundablePayments', '_crUpdateBalancePreview'];
    new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\n_crUpdateBalancePreview();')(...Object.values(ctx));
    assert.match(els.crBalancePreview.innerHTML, /Balance owed after this refund: <strong>\$970\.87<\/strong>/, els.crBalancePreview.innerHTML);
    assert.match(els.crBalancePreview.innerHTML, /\$29\.13 of the refund is card surcharge/);
});

// ── TED-147: never a card fee the bank account will pay ─────────────────────

test('TED-147: Iron\'s DEFAULT method is a bank account — no surcharge, even with a credit card saved', () => {
    const b = billing({ name: 'Iron', balance: 1000, charges: [], stripePaymentMethodId: 'pm_bank',
        savedPaymentMethods: [{ token: 'pm_bank', type: 'us_bank_account', label: 'Bank ••6789' },
                              { token: 'pm_c', type: 'card', label: 'Visa ••1111', funding: 'credit' }] });
    assert.strictEqual(b.fn._familyCardFunding(b.family), 'unknown');
    b.fn.addCardSurcharge('gold');
    b.press();
    assert.strictEqual(b.family.charges.length, 0, 'a card fee was added that Charge Card would take by bank debit');
    assert.ok(b.toasts.some(([t, k]) => k === 'error' && /default payment method is a bank account/.test(t)), JSON.stringify(b.toasts));
});

test('TED-147: with the credit card as the default, the fee is added and names that card', () => {
    const b = billing({ name: 'Iron', balance: 1000, charges: [], stripePaymentMethodId: 'pm_c',
        savedPaymentMethods: [{ token: 'pm_bank', type: 'us_bank_account' }, { token: 'pm_c', type: 'card', funding: 'credit' }] });
    b.fn.addCardSurcharge('gold');
    b.press();
    assert.strictEqual(b.family.charges.length, 1);
    assert.strictEqual(b.family.charges[0].cardFee.token, 'pm_c');
});

test('TED-146: the office\'s charge row records whether a card or a bank account paid it', () => {
    assert.match(ME, /paidWith:isBYOP\?'card':_methodTypeCharged\(f\),/);
    const fn = new Function(cut('_methodTypeCharged') + '\nreturn _methodTypeCharged;')();
    assert.strictEqual(fn({ stripePaymentMethodId: 'pm_bank', savedPaymentMethods: [{ token: 'pm_bank', type: 'us_bank_account' }] }), 'us_bank_account');
    assert.strictEqual(fn({ stripePaymentMethodId: 'pm_c', savedPaymentMethods: [{ token: 'pm_c', type: 'card' }] }), 'card');
    assert.strictEqual(fn({}), 'card', 'no default: stripe-charge picks a card');
});

test('TED-155: a flat online payment fee is allowed for a family paying by bank (it is not a card rule)', () => {
    const b = billing({ name: 'Iron', balance: 1000, charges: [], stripePaymentMethodId: 'pm_bank',
        savedPaymentMethods: [{ token: 'pm_bank', type: 'us_bank_account' }] }, { mode: 'convenience', convenienceFlat: 5 });
    b.fn.addCardSurcharge('gold');
    b.press();
    assert.strictEqual(b.family.charges.length, 1, 'the $5 online payment fee was refused: ' + JSON.stringify(b.toasts));
    assert.strictEqual(b.family.charges[0].amount, 5);
    assert.ok(!b.toasts.some(([t]) => /card brands forbid/.test(t)));
});

test('TED-153: in cash-discount mode the family tool gives the discount instead of "no fee"', () => {
    const b = billing({ name: 'Iron', balance: 1000, charges: [] }, { mode: 'cash_discount', cashDiscountPct: 3 });
    assert.strictEqual(b.fn.addCardSurcharge('gold'), 'discount-tool');
});
