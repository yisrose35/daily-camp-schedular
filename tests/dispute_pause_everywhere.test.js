// =============================================================================
// dispute_pause_everywhere.test.js — TED-200/201/202/204: a family whose
// payment is disputed with their bank is not charged again — by autopay or
// from the office, whether or not they are on autopay, whichever processor.
// The real stripe-webhook, byop-dispute-webhook, charge-due-installments,
// stripe-charge and payments-charge, in the edge harness; the database side
// (the family's disputeHold, lost disputes, Resume) is pgtest 288.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

const calls = (r, name) => r.rpcs.filter(c => c.name === name).map(c => c.args);

// ── stripe-webhook ──────────────────────────────────────────────────────────
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
  if (url.includes('/payment_intents/pi_hazel')) return { id: 'pi_hazel', metadata: { campId: 'camp1', familyKey: 'hazel' } };
  if (url.includes('/charges/ch_hazel')) return { id: 'ch_hazel', payment_intent: 'pi_hazel', metadata: {} };
  return {};
};
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'hazel' });
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'hazel', outcome: a.p_won ? 'won' : 'lost' });
${extra || ''}
Object.defineProperty(T, 'requests', { get: () => ${JSON.stringify(reqs)} });`);
}
const dispute = (type, status, id) => ({ id: 'evt_' + type + status + (id || ''), type, data: { object: {
    id: id || 'dp_1', charge: 'ch_hazel', payment_intent: 'pi_hazel', amount: 100000, status, reason: 'fraudulent' } } });

test('TED-202: a lost dispute is marked lost (Resume may then lift it); a won one is not', () => {
    const lost = deliver([dispute('charge.dispute.created', 'needs_response'), dispute('charge.dispute.closed', 'lost')]);
    assert.deepStrictEqual(lost.responses.map(x => x.status), [200, 200]);
    assert.deepStrictEqual(calls(lost, 'note_dispute_lost'), [{ p_camp_id: 'camp1', p_family_key: 'hazel', p_dispute_id: 'dp_1' }]);
    const won = deliver([dispute('charge.dispute.created', 'needs_response'), dispute('charge.dispute.closed', 'won')]);
    assert.strictEqual(calls(won, 'note_dispute_lost').length, 0);
    // marking it lost fails: 500, so Stripe sends it again
    const err = deliver([dispute('charge.dispute.closed', 'lost')], `T.rpc.note_dispute_lost = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(err.status, 500);
});

test('TED-204 (N7): a late "updated" or "funds_withdrawn" carrying won or lost takes nothing and pauses nothing', () => {
    const r = deliver([
        dispute('charge.dispute.updated', 'won'),
        dispute('charge.dispute.funds_withdrawn', 'won'),
        dispute('charge.dispute.updated', 'lost'),
    ]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200]);
    assert.strictEqual(calls(r, 'record_chargeback').length, 0, 'a decided dispute was posted as money taken');
    assert.strictEqual(calls(r, 'hold_autopay_for_dispute').length, 0, 'a decided dispute paused the family');
    // an open status on the same messages still does
    const open = deliver([dispute('charge.dispute.updated', 'under_review')]);
    assert.strictEqual(calls(open, 'hold_autopay_for_dispute').length, 1);
});

// ── byop-dispute-webhook (Cardknox / Banquest) ──────────────────────────────
function byop(body, extra) {
    return runEdge('byop-dispute-webhook', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek' };
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'hazel' });
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'hazel', outcome: a.p_won ? 'won' : 'lost' });
${extra || ''}
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=banquest&camp=camp1', headers: { 'x-webhook-secret': 'sek', 'content-type': 'application/json' }, rawBody: ${JSON.stringify(JSON.stringify(body))} };`);
}

test('TED-200: a Banquest/Cardknox dispute pauses the family\'s card too; won lifts it; lost marks it lost', () => {
    const opened = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'open', amount: 500, reason: 'fraud' });
    assert.strictEqual(opened.status, 200, JSON.stringify(opened.body));
    assert.deepStrictEqual(calls(opened, 'hold_autopay_for_dispute').map(h => [h.p_family_key, h.p_dispute_id, h.p_hold]), [['hazel', 'cb_9', true]]);
    const won = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'won' });
    assert.deepStrictEqual(calls(won, 'hold_autopay_for_dispute').map(h => h.p_hold), [false]);
    const lost = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'lost' });
    assert.deepStrictEqual(calls(lost, 'note_dispute_lost').map(h => h.p_dispute_id), ['cb_9']);
    assert.strictEqual(calls(lost, 'hold_autopay_for_dispute').length, 0);
    // the pause cannot be saved: 500, so the processor sends it again
    const err = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'open' },
        `T.rpc.hold_autopay_for_dispute = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(err.status, 500);
});

// ── the nightly runner ──────────────────────────────────────────────────────
test('TED-200/201: autopay does not charge a family paused on the FAMILY — a plan added or switched on mid-dispute — while a control family is charged', () => {
    const plan = (extra) => [{ id: 'p1', autopay: true, dueDates: ['2020-01-01'], count: 1, nextIndex: 0, history: [], ...extra }];
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
  hazel: { name: 'Hazel', cardOnFile: true, stripeCustomerId: 'cus_hazel', stripePaymentMethodId: 'pm_1', entries: [{ id: 'e', kind: 'charge', amount: 250 }],
           disputeHold: { disputeIds: ['dp_h'], lostIds: [] }, plans: ${JSON.stringify(plan({}))} },
  ash: { name: 'Ash', cardOnFile: true, stripeCustomerId: 'cus_ash', stripePaymentMethodId: 'pm_3', entries: [{ id: 'e', kind: 'charge', amount: 500 }],
         disputeHold: { disputeIds: ['dp_a'] }, plan: { autopay: true, installments: [{ dueDate: '2020-01-01', amount: 500, status: 'pending' }] } },
  olive: { name: 'Olive', cardOnFile: true, stripeCustomerId: 'cus_olive', stripePaymentMethodId: 'pm_2', entries: [{ id: 'e', kind: 'charge', amount: 250 }], plans: ${JSON.stringify(plan({}))} } });
T.tables.__charged = [];
T.fetch = (url: string, init: any) => { if (init.method === 'POST' && url.endsWith('/payment_intents')) { T.tables.__charged.push(new URLSearchParams(init.body).get('customer')); return { id: 'pi_n', status: 'succeeded', amount: 25000 }; } return {}; };
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`);
    assert.deepStrictEqual(r.tables.__charged, ['cus_olive'], 'charged: ' + JSON.stringify(r.tables.__charged) + ' ' + JSON.stringify(r.body).slice(0, 300));
    const held = JSON.stringify(r.body).match(/held_for_dispute/g) || [];
    assert.strictEqual(held.length, 2, JSON.stringify(r.body).slice(0, 400));
});

// ── the office's Charge Card on the server ──────────────────────────────────
const FAMS = `({ hazel: { name: 'Hazel', stripeCustomerId: 'cus_H', byopCustomerRef: 'tok_h', disputeHold: { disputeIds: ['dp_h'], lostIds: [] },
                 plans: [{ id: 'p1', autopay: false, dueDates: ['2026-07-01'] }] },
                fern: { name: 'Fern', stripeCustomerId: 'cus_F', byopCustomerRef: 'tok_f' } })`;

function stripeCharge(customerId, extra) {
    return runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }];
T.rpc.camp_families_object = () => ${FAMS};
${extra || ''}
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_1', customer: '${customerId}' };
  if (url.includes('/payment_intents?customer=')) return { object: 'list', data: [], has_more: false };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) return { id: 'pi_new', status: 'succeeded', amount: 100000 };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: '${customerId}', paymentMethodId: 'pm_1', amount: 1000, idempotencyKey: 'k_${customerId}' } };`);
}
const piPosts = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));

test('TED-200: stripe-charge refuses the card of a family in dispute — hand-paying, on the server, before Stripe is asked', () => {
    const r = stripeCharge('cus_H');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.disputed, true);
    assert.match(r.body.error, /Hazel disputed a payment with their bank/);
    assert.strictEqual(piPosts(r).length, 0, 'Stripe was asked to charge a disputed card');
    // the control: a family not in dispute is charged
    const ok = stripeCharge('cus_F');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(piPosts(ok).length, 1);
});

test('TED-200: a paused plan (an older pause, on the plan only) is refused too; a family read error charges nothing', () => {
    const r = stripeCharge('cus_F', `T.rpc.camp_families_object = () => ({ fern: { name: 'Fern', stripeCustomerId: 'cus_F',
        plans: [{ id: 'p', collectionBlocked: { reason: 'chargeback', disputeIds: ['dp'] } }] } });`);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(piPosts(r).length, 0);
});

function byopCharge(ref) {
    return runEdge('payments-charge', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc.camp_families_object = () => ${FAMS};
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck_key' } });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.fetch = (url: string) => (url.includes('cardknox') ? 'xResult=A&xRefNum=9001&xStatus=Approved' : {});
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: '${ref}', amount: 40, idempotencyKey: 'k_${ref}' } };`);
}

test('TED-200: payments-charge (Cardknox/Banquest) refuses a family in dispute; the control is charged', () => {
    const r = byopCharge('tok_h');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.fetches.filter(f => /cardknox/.test(f.url)).length, 0, 'the gateway was asked to charge a disputed card');
    const ok = byopCharge('tok_f');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.fetches.filter(f => /cardknox/.test(f.url)).length, 1);
});
