// node --test tests/payments_refund.test.js
// Validates the outbound (refund) half of the payment-method catalogue:
//   • refunds are their own list, not a reuse of the inbound methods
//   • the Stripe option only exists when there is a card charge to return to
//   • the Stripe flag is what the caller keys the "capped at the original"
//     rule off, so it has to be right for every id
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_payments.js');

test('the Stripe return is offered only when a card charge backs the payment', () => {
    const withCard = P.refundMethods({ canStripe: true }).map(m => m.id);
    const manual = P.refundMethods({ canStripe: false }).map(m => m.id);

    assert.ok(withCard.includes('card'));
    assert.ok(!manual.includes('card'),
        'a Zelle payment has no PaymentIntent — offering "back to the card" would fail at Stripe');

    // Every manual method survives both cases; only the card entry is gated.
    assert.deepStrictEqual(withCard.filter(id => id !== 'card'), manual);
    // Omitting opts entirely is the safe default, not a crash.
    assert.deepStrictEqual(P.refundMethods().map(m => m.id), manual);
});

test('refundIsStripe is true for the card return and false for every manual method', () => {
    assert.strictEqual(P.refundIsStripe('card'), true);
    for (const m of P.REFUND_METHODS) {
        if (m.id === 'card') continue;
        assert.strictEqual(P.refundIsStripe(m.id), false, `${m.id} must not route through Stripe`);
    }
    // An unknown or absent id must not be mistaken for a Stripe refund, or the
    // over-refund cap would be applied to a manual one.
    assert.strictEqual(P.refundIsStripe('nonsense'), false);
    assert.strictEqual(P.refundIsStripe(''), false);
});

test('the outbound list drops inbound-only methods and adds account credit', () => {
    const refundIds = P.REFUND_METHODS.map(m => m.id);
    // "Payment plan" and the charge-to-account methods describe how money comes
    // IN; they have no meaning for money going back out.
    for (const id of ['plan', 'canteen', 'bill']) {
        assert.ok(!refundIds.includes(id), `${id} is inbound-only`);
    }
    // Leaving the money on the family's account is a refund outcome only.
    assert.ok(refundIds.includes('account_credit'));
    assert.ok(!P.METHODS.map(m => m.id).includes('account_credit'));
});

test('every refund method carries a label, and unknown ids fall back safely', () => {
    for (const m of P.REFUND_METHODS) {
        assert.strictEqual(P.refundLabel(m.id), m.label);
        assert.ok(m.label && m.label.trim().length, `${m.id} needs a human label`);
    }
    assert.strictEqual(P.refundLabel('nonsense'), 'nonsense');
    assert.strictEqual(P.refundLabel(''), '—');
});

test('refundOptionsHtml marks the selected method and honours the Stripe gate', () => {
    const html = P.refundOptionsHtml('zelle', { canStripe: true });
    assert.ok(html.includes('<option value="zelle" selected>Zelle</option>'));
    assert.ok(html.includes('value="card"'));
    assert.strictEqual((html.match(/ selected>/g) || []).length, 1);

    assert.ok(!P.refundOptionsHtml('check', { canStripe: false }).includes('value="card"'));
});

test('refund ids are unique, so a stored value resolves to one method', () => {
    const ids = P.REFUND_METHODS.map(m => m.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});
