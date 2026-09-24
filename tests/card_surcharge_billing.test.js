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

function billing(family) {
    const toasts = [], saved = [];
    let onOk = null;
    const ctx = {
        families: { gold: family }, enrollSettings: { cardFeePolicy: LIVE },
        _cfAPI: () => F, _secEdit: () => true, esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2),
        today: () => '2026-08-01', save: () => saved.push(1), closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {},
        curPage: 'billing', _postLedgerCharge: () => true, toast: (t, k) => toasts.push([t, k]),
        showModal: (title, html, ok) => { onOk = ok; }, _surchargePreview() {},
        document: { getElementById: (id) => id === 'csBase' ? { value: '1000' } : null },
    };
    const names = ['addCardSurcharge', '_familyCardOnFile', '_familyCardFunding', '_familyCardLabel'];
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

test('TED-141: a $1,000 refund of a $1,030 card payment returns $29.13 of the $30 surcharge', () => {
    const ctx = { _cfAPI: () => F, families: {} };
    const fns = new Function(...Object.keys(ctx), cut('_surchargeKept') + cut('_surchargeShare') + '\nreturn { _surchargeKept, _surchargeShare };')(...Object.values(ctx));
    const silver = { charges: [{ id: 'sur_1', amount: 30, cardFee: { mode: 'surcharge', base: 1000 } }], credits: [] };
    assert.strictEqual(fns._surchargeKept(silver), 30);
    assert.strictEqual(fns._surchargeShare(30, 1030, 1000), 29.13);
    assert.strictEqual(fns._surchargeShare(30, 1030, 1030), 30, 'a whole refund returns the whole fee');
    // after it goes back, only what is left is kept — a second refund returns the rest in proportion
    silver.credits.push({ id: 'cfr_1', amount: 29.13, cardFeeReturn: true });
    assert.strictEqual(fns._surchargeKept(silver), 0.87);
    assert.strictEqual(fns._surchargeShare(0.87, 30, 30), 0.87);
    // no surcharge, nothing to return
    assert.strictEqual(fns._surchargeShare(0, 1000, 500), 0);
});

test('TED-141: Billing\'s card refund posts the surcharge\'s share as a credit, once per refund', () => {
    // the refund handler computes the share from what was kept and paid BEFORE the refund
    assert.match(ME, /var _feeBefore=_surchargeKept\(f\), _paidBefore=onlineTotal;/);
    assert.match(ME, /var _feeBack=_surchargeShare\(_feeBefore,_paidBefore,done\);/);
    assert.match(ME, /cardFeeReturn:true/);
    assert.match(ME, /_postLedgerCredit\(f,_fc\);/);
});
