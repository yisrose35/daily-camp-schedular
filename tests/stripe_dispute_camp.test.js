// =============================================================================
// stripe_dispute_camp.test.js — TED-114, the real stripe-webhook.
//
// A parent disputes a $500 charge. Stripe sends charge.dispute.created with the
// DISPUTE object, whose own metadata is empty: Campistry stamps campId on the
// PaymentIntent, and Stripe does not copy it onto a dispute. The webhook has to
// ask Stripe for the payment the dispute is about, or the chargeback never
// reaches the family's ledger.
//
// Also: a Stripe account on a newer API version sends charge.refunded without
// the refunds list; the webhook asks for it instead of posting nothing.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

function signed(event, extra) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.rpc.record_chargeback = (a: any) => ({ success: true, entryId: 'le_cb_' + a.p_dispute_id });
T.rpc.resolve_chargeback = () => ({ success: true });
T.rpc.record_external_refund = () => ({ success: true });
${extra}
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
}

const dispute = (type, metadata, status) => ({ id: 'evt_1', type, data: { object: {
    id: 'dp_1', object: 'dispute', amount: 50000, currency: 'usd', charge: 'ch_1', payment_intent: 'pi_1',
    reason: 'fraudulent', status: status || 'needs_response', metadata, evidence_details: { due_by: 1790000000 } } } });

test('TED-114: a dispute with empty metadata reaches the family ledger through its payment', () => {
    const r = signed(dispute('charge.dispute.created', {}), `
T.fetch = (url: string) => url.includes('/payment_intents/pi_1') ? { id: 'pi_1', metadata: { campId: 'camp1' } } : {};`);
    const posted = r.rpcs.filter(c => c.name === 'record_chargeback');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(posted.length, 1, 'the chargeback was not posted: ' + JSON.stringify(r.logs));
    assert.strictEqual(posted[0].args.p_camp_id, 'camp1');
    assert.strictEqual(posted[0].args.p_amount, 500);
    assert.deepStrictEqual(posted[0].args.p_refs, ['pi_1', 'ch_1', 'dp_1']);
});

test('TED-114: when the payment is not found, the charge is asked', () => {
    const r = signed(dispute('charge.dispute.created', {}), `
T.fetch = (url: string) => url.includes('/payment_intents/') ? { error: { message: 'No such payment_intent' }, __status: 404 }
  : url.includes('/charges/ch_1') ? { id: 'ch_1', metadata: { campId: 'camp1' } } : {};`);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'record_chargeback' && c.args.p_camp_id === 'camp1').length, 1);
});

test('TED-114: a won dispute closes on the right camp too', () => {
    const r = signed(dispute('charge.dispute.closed', {}, 'won'), `
T.fetch = (url: string) => url.includes('/payment_intents/pi_1') ? { id: 'pi_1', metadata: { campId: 'camp1' } } : {};`);
    const closed = r.rpcs.filter(c => c.name === 'resolve_chargeback');
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].args.p_camp_id, 'camp1');
    assert.strictEqual(closed[0].args.p_won, true);
});

test('TED-114: no camp anywhere — nothing is guessed, and it is logged for the office', () => {
    const r = signed(dispute('charge.dispute.created', {}), `T.fetch = () => ({ id: 'x', metadata: {} });`);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'record_chargeback').length, 0);
    assert.ok(r.logs.some(l => /dp_1 has no campId/.test(l)), JSON.stringify(r.logs));
});

test('a charge.refunded without its refunds list asks Stripe for them', () => {
    const event = { id: 'evt_2', type: 'charge.refunded', data: { object: {
        id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount_refunded: 5000, metadata: { campId: 'camp1' } } } };
    const r = signed(event, `
T.fetch = (url: string) => url.includes('/refunds?charge=ch_1') ? { data: [{ id: 're_1', amount: 5000, reason: 'requested_by_customer' }] } : {};`);
    const posted = r.rpcs.filter(c => c.name === 'record_external_refund');
    assert.strictEqual(posted.length, 1, JSON.stringify(r.logs));
    assert.strictEqual(posted[0].args.p_refund_id, 're_1');
    assert.strictEqual(posted[0].args.p_amount, 50);
});

// ── TED-121: Stripe cannot be asked — the event is sent again, never lost ────
for (const [label, model] of [['a 500', `{ __status: 500, error: { message: 'api_error' } }`],
                              ['a rate limit', `{ __status: 429, error: { message: 'rate_limit' } }`],
                              ['a dropped connection', `(() => { throw new Error('connection reset'); })()`]]) {
    test(`TED-121: Stripe answers the dispute lookup with ${label} — 500, so Stripe sends the event again`, () => {
        const r = signed(dispute('charge.dispute.created', {}), `T.fetch = (url: string) => url.includes('/payment_intents/') ? ${model} : {};`);
        assert.strictEqual(r.status, 500, 'answered ' + r.status + ' — Stripe would never send it again');
        assert.strictEqual(r.rpcs.filter(c => c.name === 'record_chargeback').length, 0);
    });
}

test('TED-121: a refund whose list cannot be fetched is sent again too', () => {
    const event = { id: 'evt_3', type: 'charge.refunded', data: { object: {
        id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount_refunded: 5000, metadata: { campId: 'camp1' } } } };
    const r = signed(event, `T.fetch = (url: string) => url.includes('/refunds?charge=') ? { __status: 503, error: { message: 'unavailable' } } : {};`);
    assert.strictEqual(r.status, 500);
});

test('TED-121: "no such payment" is an answer, not a hiccup — the charge is asked instead', () => {
    const r = signed(dispute('charge.dispute.created', {}), `
T.fetch = (url: string) => url.includes('/payment_intents/') ? { __status: 404, error: { message: 'No such payment_intent' } }
  : url.includes('/charges/ch_1') ? { id: 'ch_1', metadata: { campId: 'camp1' } } : {};`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'record_chargeback').length, 1);
});
