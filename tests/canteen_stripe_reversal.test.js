// =============================================================================
// canteen_stripe_reversal.test.js — TED-181, the real stripe-webhook.
//
// A canteen top-up refunded from the Stripe dashboard, or disputed with the
// bank, stayed on the child's wallet: the webhook looked for a family payment,
// found none, and logged it. Now it goes to the wallet (migration 287; its SQL
// is pgtest 287): once, keyed on the refund or dispute, never for Campistry's
// own refunds, and a failed write is retried.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

function deliver(events, extra) {
    const t = Math.floor(Date.now() / 1000);
    const reqs = events.map(ev => {
        const body = JSON.stringify(ev);
        const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
        return { headers: { 'stripe-signature': `t=${t},v1=${sig}` }, rawBody: body };
    });
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_x' };
T.fetch = (url: string) => {
  if (url.includes('/payment_intents/pi_top')) return { id: 'pi_top', metadata: { source: 'campistry-canteen-deposit', campId: 'camp1', camperName: 'Avi' } };
  if (url.includes('/payment_intents/pi_tuition')) return { id: 'pi_tuition', metadata: { campId: 'camp1', familyKey: 'gold' } };
  if (url.includes('/charges/ch_top')) return { id: 'ch_top', payment_intent: 'pi_top' };
  if (url.includes('/refunds/')) return { status: 'succeeded' };
  return {};
};
T.rpc.record_external_refund = () => ({ success: false, error: 'payment_not_found' });
T.rpc.record_chargeback = () => ({ success: false, error: 'payment_not_found' });
${extra || ''}
Object.defineProperty(T, 'requests', { get: () => ${JSON.stringify(reqs)} });`);
}
const rev = (r) => r.rpcs.filter(c => c.name === 'record_canteen_stripe_reversal').map(c => [c.args.p_payment_intent_id, c.args.p_ref_id, c.args.p_amount, c.args.p_kind]);

test('TED-181: a top-up refunded in the Stripe dashboard comes off the child\'s wallet — not the family\'s bill', () => {
    const r = deliver([{ id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_top', payment_intent: 'pi_top', metadata: {},
        refunds: { data: [{ id: 're_dash', amount: 2000, status: 'succeeded' }] } } } }]);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(rev(r), [['pi_top', 're_dash', 20, 'refund']]);
    assert.ok(!r.rpcs.some(c => c.name === 'record_external_refund'), 'a canteen refund went to the family\'s bill');
});

test('TED-181: Campistry\'s own canteen refund (it carries its hold) is not taken a second time', () => {
    const r = deliver([{ id: 'evt_2', type: 'charge.refunded', data: { object: { id: 'ch_top', payment_intent: 'pi_top', metadata: {},
        refunds: { data: [{ id: 're_own', amount: 1000, status: 'succeeded', metadata: { campistryHold: 'scanteen:pi_top:1000:2000' } }] } } } }]);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(rev(r), []);
});

test('TED-181: a disputed top-up comes off while the bank decides, and goes back on when the camp wins; an inquiry moves nothing', () => {
    const r = deliver([
        { id: 'evt_q', type: 'charge.dispute.created', data: { object: { id: 'dp_q', charge: 'ch_top', amount: 2000, status: 'warning_needs_response' } } },
        { id: 'evt_d', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_top', amount: 2000, status: 'needs_response', reason: 'fraudulent' } } },
        { id: 'evt_w', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', charge: 'ch_top', amount: 2000, status: 'won' } } },
    ]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200]);
    assert.deepStrictEqual(rev(r), [['pi_top', 'dp_1', 20, 'dispute'], ['pi_top', 'dp_1', 20, 'dispute_won']]);
});

test('TED-181: the wallet write fails — 500, so Stripe sends the refund again', () => {
    const r = deliver([{ id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_top', payment_intent: 'pi_top', metadata: {},
        refunds: { data: [{ id: 're_dash', amount: 2000, status: 'succeeded' }] } } } }],
        `T.rpc.record_canteen_stripe_reversal = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(r.status, 500);
});

test('TED-181: a tuition payment refunded in the dashboard still goes to the family\'s bill, as before', () => {
    const r = deliver([{ id: 'evt_3', type: 'charge.refunded', data: { object: { id: 'ch_t', payment_intent: 'pi_tuition', metadata: { campId: 'camp1' },
        refunds: { data: [{ id: 're_t', amount: 50000, status: 'succeeded' }] } } } }]);
    assert.deepStrictEqual(rev(r), []);
    assert.ok(r.rpcs.some(c => c.name === 'record_external_refund'));
});

test('TED-188: a canteen inquiry that escalates comes off the wallet — once, on the dispute', () => {
    const r = deliver([
        { id: 'evt_q', type: 'charge.dispute.created', data: { object: { id: 'dp_e', charge: 'ch_top', amount: 2000, status: 'warning_needs_response' } } },
        { id: 'evt_u', type: 'charge.dispute.updated', data: { object: { id: 'dp_e', charge: 'ch_top', amount: 2000, status: 'needs_response' } } },
        { id: 'evt_f', type: 'charge.dispute.funds_withdrawn', data: { object: { id: 'dp_e', charge: 'ch_top', amount: 2000, status: 'needs_response' } } },
    ]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200]);
    // both money-moving messages reach the dispute-keyed writer (pgtest 287: the second changes nothing)
    assert.deepStrictEqual(rev(r), [['pi_top', 'dp_e', 20, 'dispute'], ['pi_top', 'dp_e', 20, 'dispute']]);
});
