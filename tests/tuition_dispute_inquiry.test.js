// =============================================================================
// tuition_dispute_inquiry.test.js — TED-186, TED-187, TED-188: the real
// stripe-webhook and charge-due-installments.
//
// A bank's INQUIRY (a question; no money moved) was posted as a chargeback:
// the payment went back on the family's bill, the camp was told the bank
// "pulled it back", and that night's autopay charged the family again. Now an
// inquiry posts nothing; a dispute that takes money (created, or an inquiry
// escalating: updated / funds_withdrawn) posts once and pauses autopay for the
// family (migration 288, pgtest 288); a win puts both back. A database error
// on a refund, a chargeback or a close is answered 500 so Stripe sends it again.
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
  if (url.includes('/payment_intents/pi_teal')) return { id: 'pi_teal', metadata: { campId: 'camp1', familyKey: 'teal' } };
  if (url.includes('/charges/ch_teal')) return { id: 'ch_teal', payment_intent: 'pi_teal', metadata: {} };
  if (url.includes('/refunds/')) return { status: 'succeeded' };
  return {};
};
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'teal' });
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'teal', outcome: a.p_won ? 'won' : 'lost' });
${extra || ''}
Object.defineProperty(T, 'requests', { get: () => ${JSON.stringify(reqs)} });`);
}
const dispute = (type, status, id) => ({ id: 'evt_' + type + status, type, data: { object: {
    id: id || 'dp_1', charge: 'ch_teal', payment_intent: 'pi_teal', amount: 100000, status, reason: 'fraudulent' } } });
const calls = (r, name) => r.rpcs.filter(c => c.name === name).map(c => c.args);

test('TED-186: a bank inquiry on a tuition payment posts nothing, and its close undoes nothing because nothing was done', () => {
    const r = deliver([dispute('charge.dispute.created', 'warning_needs_response'), dispute('charge.dispute.closed', 'warning_closed')]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200]);
    assert.strictEqual(calls(r, 'record_chargeback').length, 0, 'an inquiry was booked as a chargeback');
    assert.strictEqual(calls(r, 'hold_autopay_for_dispute').length, 0, 'autopay was paused for a question');
    assert.strictEqual(calls(r, 'resolve_chargeback').length, 0);
});

test('TED-186/188: the inquiry escalates — the money comes back on the bill once, and autopay pauses', () => {
    const r = deliver([
        dispute('charge.dispute.created', 'warning_needs_response'),
        dispute('charge.dispute.updated', 'needs_response'),
        dispute('charge.dispute.funds_withdrawn', 'needs_response'),
    ]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200]);
    assert.strictEqual(calls(r, 'record_chargeback').length, 2, 'both money-moving messages go to the (dispute-keyed) writer');
    assert.strictEqual(calls(r, 'record_chargeback')[0].p_amount, 1000);
    const holds = calls(r, 'hold_autopay_for_dispute');
    assert.ok(holds.length >= 1 && holds.every(h => h.p_hold === true && h.p_family_key === 'teal' && h.p_dispute_id === 'dp_1'), JSON.stringify(holds));
    // updated / funds_withdrawn send no second platform email
    assert.strictEqual(r.emails.length, 1, 'emails: ' + r.emails.length);
});

test('TED-186: the camp wins — the payment goes back and autopay starts again; lost — autopay stays paused', () => {
    const won = deliver([dispute('charge.dispute.created', 'needs_response'), dispute('charge.dispute.closed', 'won')]);
    assert.deepStrictEqual(calls(won, 'hold_autopay_for_dispute').map(h => h.p_hold), [true, false]);
    assert.deepStrictEqual(calls(won, 'resolve_chargeback').map(a => a.p_won), [true]);
    const lost = deliver([dispute('charge.dispute.created', 'needs_response'), dispute('charge.dispute.closed', 'lost')]);
    assert.deepStrictEqual(calls(lost, 'hold_autopay_for_dispute').map(h => h.p_hold), [true]);
});

test('TED-187: a database error on a chargeback, a close or a dashboard refund is answered 500 (Stripe sends it again)', () => {
    const cb = deliver([dispute('charge.dispute.created', 'needs_response')], `T.rpc.record_chargeback = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(cb.status, 500);
    const cl = deliver([dispute('charge.dispute.closed', 'won')], `T.rpc.resolve_chargeback = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(cl.status, 500);
    const rf = deliver([{ id: 'evt_r', type: 'charge.refunded', data: { object: { id: 'ch_teal', payment_intent: 'pi_teal', metadata: { campId: 'camp1' },
        refunds: { data: [{ id: 're_1', amount: 50000, status: 'succeeded' }] } } } }],
        `T.rpc.record_external_refund = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(rf.status, 500);
    // an ANSWER (no such payment) is not retried
    const ans = deliver([dispute('charge.dispute.created', 'needs_response')], `T.rpc.record_chargeback = () => ({ success: false, error: 'payment_not_found' });`);
    assert.strictEqual(ans.status, 200);
});

test('TED-186: autopay skips a plan paused for a dispute — nothing is charged', () => {
    const r = runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.camp_families_object = () => ({ teal: { name: 'Teal', cardOnFile: true, stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1',
    entries: [{ id: 'le_c', kind: 'charge', amount: 1000, reason: 'tuition' }],
    plans: [{ id: 'p1', autopay: true, dueDates: ['2020-01-01'], collectionBlocked: { reason: 'chargeback', disputeId: 'dp_1' } },
            { id: 'p2', autopay: true, installments: [{ dueDate: '2020-01-01', amount: 500, status: 'pending' }], collectionBlocked: { reason: 'chargeback', disputeId: 'dp_1' } }] } });
T.fetch = () => ({ id: 'pi_new', status: 'succeeded' });
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`);
    const charges = r.fetches.filter(f => f.method === 'POST' && /\/payment_intents$/.test(f.url));
    assert.strictEqual(charges.length, 0, 'autopay charged a family whose payment is disputed');
    assert.ok(/held_for_dispute/.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 400));
});

test('TED-199 (M8): the autopay pause fails to save — 500, so Stripe sends the chargeback again', () => {
    const r = deliver([dispute('charge.dispute.created', 'needs_response')], `T.rpc.hold_autopay_for_dispute = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(r.status, 500);
});

test('TED-199 (M9/M10): in the same night a family NOT in dispute is charged — the held family is held by its pause, not by chance', () => {
    const plansFor = (blocked) => [{ id: 'p1', autopay: true, dueDates: ['2020-01-01'], count: 1, nextIndex: 0, history: [], ...(blocked ? { collectionBlocked: { reason: 'chargeback', disputeIds: ['dp_1'] } } : {}) }];
    const r = runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_autopay_charge = () => ({ success: true, balance: 0 });
T.rpc.hold_autopay_charge = () => ({ success: true });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '2020-01-01', amount: 250 });
T.rpc.camp_families_object = () => ({
  teal: { name: 'Teal', cardOnFile: true, stripeCustomerId: 'cus_teal', stripePaymentMethodId: 'pm_1', entries: [{ id: 'e', kind: 'charge', amount: 250 }], plans: ${JSON.stringify(plansFor(true))} },
  olive: { name: 'Olive', cardOnFile: true, stripeCustomerId: 'cus_olive', stripePaymentMethodId: 'pm_2', entries: [{ id: 'e', kind: 'charge', amount: 250 }], plans: ${JSON.stringify(plansFor(false))} } });
T.tables.__charged = [];
T.fetch = (url: string, init: any) => { if (init.method === 'POST' && url.endsWith('/payment_intents')) { T.tables.__charged.push(new URLSearchParams(init.body).get('customer')); return { id: 'pi_n', status: 'succeeded', amount: 25000 }; } return {}; };
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`);
    assert.deepStrictEqual(r.tables.__charged, ['cus_olive'], 'charged: ' + JSON.stringify(r.tables.__charged) + ' ' + JSON.stringify(r.body).slice(0, 300));
});
