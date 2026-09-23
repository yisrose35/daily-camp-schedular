// =============================================================================
// stripe_refund_and_charge.test.js — the real stripe-refund and stripe-charge
// edge functions, run against a pretend Stripe and database (edge_harness.js).
//
//   TED-052  stripe-refund: no login → refused, nothing sent to Stripe; a staff
//            member who is not owner/admin → refused; another camp's payment →
//            refused; the owner's own payment → refunded, once, even when the
//            same click is sent twice.
//   TED-058  stripe-charge: another camp's family's card → refused, nothing
//            sent to Stripe; a card that is not that family's → refused; the
//            camp's own family → charged, with an Idempotency-Key.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

// Two camps. camp1's owner is u-owner; u-counselor is camp1 staff; camp2 has
// its own family with its own Stripe customer.
const WORLD = `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', counselor: 'u-counselor', other: 'u-other-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }, { id: 'camp2', owner: 'u-other-owner', name: 'Camp Two' }];
T.tables.camp_users = [{ user_id: 'u-counselor', camp_id: 'camp1', role: 'counselor', accepted_at: '2026-01-01' }];
T.rpc.camp_families_object = (a: any) => a.p_camp_id === 'camp1'
  ? { fam1: { name: 'Gold', stripeCustomerId: 'cus_camp1' } }
  : { famX: { name: 'Stone', stripeCustomerId: 'cus_camp2' } };
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => {
  const k = a.p_camp_id + '|' + a.p_key;
  if (claims[k]) return { claimed: false, previous: claims[k].result || {} };
  claims[k] = { result: null }; return { claimed: true };
};
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_camp_id + '|' + a.p_key].result = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_camp_id + '|' + a.p_key]; return true; };
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_intents/pi_camp1')) return { id: 'pi_camp1', customer: 'cus_camp1', amount: 50000 };
  if (url.includes('/payment_intents/pi_camp2')) return { id: 'pi_camp2', customer: 'cus_camp2', amount: 50000 };
  if (url.includes('/payment_intents/pi_guest')) return { id: 'pi_guest', customer: null, metadata: { campId: 'camp2' } };
  if (url.includes('/payment_methods/pm_camp1')) return { id: 'pm_camp1', customer: 'cus_camp1' };
  if (url.includes('/payment_methods/pm_camp2')) return { id: 'pm_camp2', customer: 'cus_camp2' };
  if (url.endsWith('/refunds')) return { id: 're_' + T.fetches.length, status: 'succeeded', amount: 10000 };
  if (url.endsWith('/payment_intents')) return { id: 'pi_new', status: 'succeeded' };
  return {};
};
`;

const moneyCalls = (r, what) => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith(what));

test('TED-052: a refund with no login is refused and nothing reaches Stripe', () => {
    const r = runEdge('stripe-refund', WORLD + `T.request = { body: { paymentIntentId: 'pi_camp1', amount: 100 } };`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.fetches.length, 0, 'Stripe was called for a caller with no login');
});

test('TED-052: a staff member who is not owner/admin cannot refund', () => {
    const r = runEdge('stripe-refund', WORLD + `T.request = { headers: { Authorization: 'Bearer counselor' }, body: { paymentIntentId: 'pi_camp1', amount: 100 } };`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(moneyCalls(r, '/refunds').length, 0);
});

test('TED-052: an owner cannot refund another camp\'s payment', () => {
    for (const pi of ['pi_camp2', 'pi_guest']) {
        const r = runEdge('stripe-refund', WORLD + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: '${pi}', amount: 100 } };`);
        assert.strictEqual(r.status, 403, pi + ' was not refused');
        assert.strictEqual(moneyCalls(r, '/refunds').length, 0, pi + ': a refund reached Stripe');
    }
});

test('TED-052: the owner refunds their own camp\'s payment once, even when the click is sent twice', () => {
    const r = runEdge('stripe-refund', WORLD + `
      const req = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_camp1', amount: 100, idempotencyKey: 'rfnd_1:0', metadata: { campId: 'camp2' } } };
      T.requests = [req, req];`);
    assert.strictEqual(r.responses[0].status, 200, JSON.stringify(r.responses[0].body));
    assert.ok(r.responses[0].body.refundId, 'no refund id');
    assert.strictEqual(r.responses[1].status, 200);
    assert.strictEqual(r.responses[1].body.replayed, true, 'the second send was not a replay');
    const refunds = moneyCalls(r, '/refunds');
    assert.strictEqual(refunds.length, 1, 'the same click refunded twice');
    const p = new URLSearchParams(refunds[0].body);
    assert.strictEqual(p.get('amount'), '10000');
    assert.strictEqual(p.get('metadata[campId]'), 'camp1', 'a campId from the request reached Stripe');
    assert.ok(refunds[0].headers['Idempotency-Key'], 'no Idempotency-Key sent to Stripe');
});

test('TED-058: an owner cannot charge another camp\'s family\'s card', () => {
    const r = runEdge('stripe-charge', WORLD + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_camp2', amount: 50 } };`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(moneyCalls(r, '/payment_intents').length, 0, 'a stranger\'s card was charged');
});

test('TED-058: a payment method that is not that family\'s is refused', () => {
    const r = runEdge('stripe-charge', WORLD + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_camp1', paymentMethodId: 'pm_camp2', amount: 50 } };`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(moneyCalls(r, '/payment_intents').length, 0);
});

test('TED-058: the camp\'s own family is charged, with an Idempotency-Key and the camp from the server', () => {
    const r = runEdge('stripe-charge', WORLD + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_camp1', paymentMethodId: 'pm_camp1', amount: 50, idempotencyKey: 'chg_1', metadata: { campId: 'camp2' } } };`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const pis = moneyCalls(r, '/payment_intents');
    assert.strictEqual(pis.length, 1);
    const p = new URLSearchParams(pis[0].body);
    assert.strictEqual(p.get('amount'), '5000');
    assert.strictEqual(p.get('customer'), 'cus_camp1');
    assert.strictEqual(p.get('metadata[campId]'), 'camp1');
    assert.ok(pis[0].headers['Idempotency-Key'], 'no Idempotency-Key sent to Stripe');
});

test('TED-058: no login, or a counselor, cannot charge', () => {
    for (const h of ['', 'counselor']) {
        const r = runEdge('stripe-charge', WORLD + `T.request = { headers: ${h ? `{ Authorization: 'Bearer ${h}' }` : '{}'}, body: { customerId: 'cus_camp1', amount: 50 } };`);
        assert.strictEqual(r.status, 403);
        assert.strictEqual(moneyCalls(r, '/payment_intents').length, 0);
    }
});

test('TED-061: the retired stripe-setup refuses everything', () => {
    const r = runEdge('stripe-setup', WORLD + `T.request = { body: { email: 'a@b.c' } };`);
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.fetches.length, 0);
});
