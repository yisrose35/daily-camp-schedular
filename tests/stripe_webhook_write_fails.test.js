// =============================================================================
// stripe_webhook_write_fails.test.js — TED-164, the real stripe-webhook.
//
// A parent pays (Link Pay Now, a canteen top-up, photos, a registration
// deposit). Stripe takes the money and tells Campistry. If the database
// refused the write at that moment, the webhook still answered "received" and
// emailed the receipt — and Stripe never sends a "received" event again, so the
// payment was never recorded. Now a write that fails answers 500 (Stripe sends
// it again; every write is keyed on the payment) and no receipt goes out until
// the payment is recorded — as the Sola webhook already does.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

function deliver(meta, rpcName, extra) {
    const event = { id: 'evt_pay', type: 'payment_intent.succeeded', data: { object: {
        id: 'pi_1', amount: 50000, amount_received: 50000, payment_method_types: ['card'], metadata: Object.assign({ campId: 'camp1' }, meta) } } };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.__receipts = [];
T.fetch = (url: string) => { if (url.includes('/functions/v1/send-payment-receipt')) T.tables.__receipts.push(url); return {}; };
let n = 0;
// the database times out on the first delivery, and answers on the second
T.rpc.${rpcName} = () => { if (++n === 1) throw new Error('canceling statement due to statement timeout'); return { success: true }; };
${extra || ''}
Object.defineProperty(T, 'requests', { get: () => [T.request, T.request] });
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
}
const writes = (r, name) => r.rpcs.filter(c => c.name === name).length;

for (const [what, meta, rpc] of [
    ['Link Pay Now (tuition)', { familyKey: 'gold', familyName: 'Gold' }, 'append_camp_payment'],
    ['a canteen top-up', { source: 'campistry-canteen-deposit', camperName: 'Avi', camperId: '7' }, 'credit_canteen_balance_from_stripe'],
    ['a photo purchase', { source: 'campistry-link-photo-purchase', kind: 'gallery', parentUserId: 'u1', camperNames: '["Avi"]' }, 'record_link_photo_purchase'],
    ['a registration deposit', { source: 'registration_deposit', enrollmentId: 'app1' }, '_record_registration_deposit'],
]) {
    test(`TED-164: ${what} — the database fails: 500 and no receipt; Stripe's next delivery records it and sends one`, () => {
        const r = deliver(meta, rpc);
        assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200], JSON.stringify(r.responses.map(x => x.body)));
        assert.strictEqual(writes(r, rpc), 2, 'the second delivery did not write');
        assert.strictEqual(r.tables.__receipts.length, 1, 'receipts: ' + r.tables.__receipts.length + ' (one only after it was recorded)');
    });
}

test('TED-164: the database ANSWERS "not recorded" — also 500, as the Sola webhook does', () => {
    const r = deliver({ familyKey: 'gold' }, 'append_camp_payment',
        `T.rpc.append_camp_payment = () => { if (++n === 1) return { success: false, error: 'camp_not_found' }; return { success: true }; };`);
    assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200]);
    assert.strictEqual(r.tables.__receipts.length, 1);
});
