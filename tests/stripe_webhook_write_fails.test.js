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
        `T.rpc.append_camp_payment = () => { if (++n === 1) return { success: false, error: 'lock_not_available' }; return { success: true }; };`);
    assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200]);
    assert.strictEqual(r.tables.__receipts.length, 1);
});

// ── TED-183: a refusal that will never pass ─────────────────────────────────
function never(meta, rpcName, code, extra) {
    const event = { id: 'evt_p', type: 'payment_intent.succeeded', data: { object: {
        id: 'pi_p1', amount: 2000, amount_received: 2000, payment_method_types: ['card'], metadata: Object.assign({ campId: 'camp1' }, meta) } } };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_x' };
T.tables.__receipts = [];
T.fetch = (url: string) => { if (url.includes('/functions/v1/send-payment-receipt')) T.tables.__receipts.push(url); return {}; };
T.rpc.${rpcName} = () => ({ success: false, error: '${code}' });
const claimed: any = {};
T.rpc.claim_refund_failure_alert = (a: any) => { if (claimed[a.p_refund_id]) return false; claimed[a.p_refund_id] = 1; return true; };
T.rpc.release_refund_failure_alert = (a: any) => { delete claimed[a.p_refund_id]; return true; };
${extra || ''}
Object.defineProperty(T, 'requests', { get: () => [T.request, T.request] });
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
}

test('TED-183: a top-up for a child number that is no longer anyone — the platform is told once, Stripe gets 200, no receipt', () => {
    const r = never({ source: 'campistry-canteen-deposit', camperName: 'Avi', camperId: '7' }, 'credit_canteen_balance_from_stripe', 'unknown_camper');
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200], 'Stripe would retry for three days and then give up in silence');
    assert.strictEqual(r.emails.length, 1, 'the platform was not told (or told twice)');
    assert.match(r.emails[0].subject, /\$20\.00 payment could not be recorded/);
    assert.match(r.emails[0].html, /unknown camper — this will not change/);
    assert.strictEqual(r.tables.__receipts.length, 0, 'a receipt for a payment Campistry has no record of');
});

test('TED-183: a deposit for a deleted application — the same', () => {
    const r = never({ source: 'registration_deposit', enrollmentId: 'app9' }, '_record_registration_deposit', 'application_not_found');
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200]);
    assert.strictEqual(r.emails.length, 1);
    assert.match(r.emails[0].html, /application app9/);
});

test('TED-183: the email does not go — 500 and the claim given back, so the next delivery tells the platform', () => {
    const r = never({ source: 'campistry-canteen-deposit', camperName: 'Avi', camperId: '7' }, 'credit_canteen_balance_from_stripe', 'unknown_camper',
        `let tries = 0; T.emailFails = () => ++tries === 1;`);
    assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200]);
    assert.strictEqual(r.emails.length, 1);
});
