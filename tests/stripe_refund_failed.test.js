// =============================================================================
// stripe_refund_failed.test.js — TED-126 and TED-127, the real functions.
//
// TED-126. Stripe can accept a refund and fail it days later (the parent's card
// account closed). Two things went wrong:
//   1. A canteen refund whose answer was lost, and which Stripe later failed,
//      was put back on the wallet — and then sent AGAIN with its old
//      Idempotency-Key. Stripe answers a repeated key from its memory, as the
//      refund was then: "succeeded". It was booked; the wallet went to $0 and
//      the parent got $0.
//   2. Nothing listened for the failure: the family's bill or the child's
//      wallet kept saying "refunded".
// TED-127. After the look-up settled a stuck Refund All refund, a refund of a
// later top-up drew on the old, already-refunded top-up first and Stripe said
// "already refunded" — nothing was refunded on the first press.
//
// The Stripe here keeps each key's first answer and replays it marked
// Idempotent-Replayed, refuses a refund past what is left on a payment, and
// lets a refund's status change after the fact — the documented behaviour.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

// deposits: [{ pi, amount, ts }]; refunds: Stripe's refunds as they are NOW;
// memory: key → Stripe's saved first answer.
function canteen({ deposits, bal, holds, refunds, memory, holdAge, intents, request, unlisted }) {
    return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.tables.refund_intents = ${JSON.stringify(intents || [])};
const RI = () => T.tables.refund_intents;
const find = (k: string) => RI().find((r: any) => r.key === k);
T.rpc.claim_refund_intent = (a: any) => { const c = find(a.p_key); if (c) return { claimed: false, previous: c.result || {} };
  RI().push({ key: a.p_key, amount: a.p_amount, result: null, settled_at: null, created_at: new Date().toISOString() }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (c) { c.result = a.p_result; c.settled_at = 'now'; } return true; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = RI().filter((r: any) => !(r.key === a.p_key && !r.settled_at)); return true; };
T.rpc.release_stale_refund_intent = () => false;
const tx: any[] = ${JSON.stringify((deposits || []).map(d => ({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: d.pi, amount: d.amount, camper: 'Avi', camperId: 7, timestamp: d.ts })))};
let bal = ${bal};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
T.tables.canteen_refund_holds.push(...${JSON.stringify(holds || [])});
T.holdAge = ${holdAge || 0};
const PIS: any = ${JSON.stringify(Object.fromEntries((deposits || []).map(d => [d.pi, Math.round(d.amount * 100)])))};
const refunds: any[] = ${JSON.stringify(refunds || [])};
const memory: any = ${JSON.stringify(memory || {})};
let n = 0; T.tables.__sent = [];
const standing = (pi: string) => refunds.filter((r: any) => r.payment_intent === pi && r.status !== 'failed' && r.status !== 'canceled')
  .reduce((t: number, r: any) => t + r.amount, 0);
T.fetch = (url: string, init: any) => {
  const one = url.match(/\\/refunds\\/(re_[A-Za-z0-9_]+)$/);
  if (one && init.method !== 'POST') {
    const r = refunds.find((x: any) => x.id === one[1]);
    return r ? JSON.parse(JSON.stringify(r)) : { __status: 404, error: { type: 'invalid_request_error', message: 'No such refund' } };
  }
  if (url.includes('/refunds?payment_intent=')) {
    const pi = decodeURIComponent(url.split('payment_intent=')[1].split('&')[0]);
    // (a refund moments old may not be in the list yet: 'unlisted')
    const hidden: string[] = ${JSON.stringify(unlisted || [])};
    return { data: refunds.filter((r: any) => r.payment_intent === pi && !hidden.includes(r.id)).slice().reverse(), has_more: false };
  }
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const key = init.headers['Idempotency-Key'];
    if (key && memory[key]) return Object.assign(JSON.parse(JSON.stringify(memory[key])), { __headers: { 'Idempotent-Replayed': 'true' } });
    const p = new URLSearchParams(init.body); const pi = String(p.get('payment_intent')); const cents = Number(p.get('amount'));
    if (cents > PIS[pi] - standing(pi)) {
      const e = { __status: 400, error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge for ' + pi + ' has already been refunded.' } };
      if (key) memory[key] = e; return e;
    }
    const r = { id: 're_new' + (++n), object: 'refund', status: 'succeeded', amount: cents, payment_intent: pi,
                metadata: { campistryHold: p.get('metadata[campistryHold]') }, created: Math.floor(Date.now() / 1000) };
    refunds.push(r); if (key) memory[key] = JSON.parse(JSON.stringify(r));
    T.tables.__sent.push({ pi, amount: cents / 100, key });
    return r;
  }
  if (url.includes('/payment_intents/')) return { id: url.split('/payment_intents/')[1], transfer_data: null };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(request || {})} };`;
}
const booked = (r) => r.rpcs.filter(c => c.name === 'settle_canteen_refund_hold').map(c => c.args.p_refund_id);
const snapshot = (id, amount, pi, key) => ({ id, object: 'refund', status: 'succeeded', amount, payment_intent: pi, metadata: { campistryHold: key }, created: Math.floor(Date.now() / 1000) - 3600 });
const failed = (id, amount, pi, key) => Object.assign(snapshot(id, amount, pi, key), { status: 'failed', failure_reason: 'expired_or_canceled_card' });

// ── TED-126 (1): a failed refund is never re-sent under its old key ─────────

test('TED-126: Refund All — a stuck $20 that Stripe later FAILED goes back, and is refunded again for real', () => {
    const K = 'canteen_refund_pi_top1_2000_2000', H = 'scanteen:pi_top1:2000:2000';
    const r = runEdge('stripe-canteen-refund-all', canteen({
        deposits: [{ pi: 'pi_top1', amount: 20, ts: 1 }], bal: 0, holdAge: 900,
        holds: [{ key: H, amount: 20, method: 'stripe', paymentRef: 'pi_top1', stripeKey: K, state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' }],
        refunds: [failed('re_16', 2000, 'pi_top1', H)],
        memory: { [K]: snapshot('re_16', 2000, 'pi_top1', H) } }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__sent.map(s => s.amount), [20], 'the parent was not sent the $20: ' + JSON.stringify(r.body));
    assert.notStrictEqual(r.tables.__sent[0].key, K, 'sent again under the failed refund\'s key');
    assert.ok(!booked(r).includes('re_16'), 'the failed refund was booked as the refund');
    assert.deepStrictEqual(booked(r), ['re_new1']);
    assert.strictEqual(r.tables.__bal, 0);
    assert.strictEqual(r.body.totalRefunded, 20);
});

test('TED-126: the single refund — pressed again after its refund failed, it refunds for real', () => {
    const K = 'canteen_refund_cref_1_pi_top1', H = 'scanteen:cref_1:pi_top1';
    const r = runEdge('stripe-canteen-refund', canteen({
        deposits: [{ pi: 'pi_top1', amount: 20, ts: 1 }], bal: 0, holdAge: 900,
        holds: [{ key: H, amount: 20, method: 'stripe', paymentRef: 'pi_top1', stripeKey: K, state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' }],
        intents: [{ camp_id: 'camp1', key: H, amount: 20, result: null, settled_at: null, created_at: new Date(Date.now() - 900000).toISOString() }],
        refunds: [failed('re_16', 2000, 'pi_top1', H)],
        memory: { [K]: snapshot('re_16', 2000, 'pi_top1', H) },
        request: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } }));
    assert.strictEqual(r.body.totalRefunded, 20, JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__sent.map(s => s.amount), [20], 'nothing was sent to the parent');
    assert.strictEqual(r.tables.__sent[0].key, K + '_after_re_16');
    assert.deepStrictEqual(booked(r), ['re_new1']);
    assert.strictEqual(r.tables.__bal, 0);
});

test('TED-126: a lost answer repeated from Stripe\'s memory that DID go through is still booked once', () => {
    const K = 'canteen_refund_cref_2_pi_top1', H = 'scanteen:cref_2:pi_top1';
    const made = Object.assign(snapshot('re_20', 2000, 'pi_top1', H), { created: Math.floor(Date.now() / 1000) - 30 });
    const r = runEdge('stripe-canteen-refund', canteen({
        deposits: [{ pi: 'pi_top1', amount: 20, ts: 1 }], bal: 0, holdAge: 30,
        holds: [{ key: H, amount: 20, method: 'stripe', paymentRef: 'pi_top1', stripeKey: K, state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' }],
        intents: [{ camp_id: 'camp1', key: H, amount: 20, result: null, settled_at: null, created_at: new Date().toISOString() }],
        refunds: [made], unlisted: ['re_20'], memory: { [K]: made },    // made moments ago, not in the list yet
        request: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_2' } }));
    assert.strictEqual(r.body.totalRefunded, 20, JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__sent, [], 'a second refund was made');
    assert.deepStrictEqual(booked(r), ['re_20']);
});

test('TED-126: the tuition refund — a repeated key whose refund failed moves on to a new one', () => {
    const r = runEdge('stripe-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.rpc.camp_families_object = () => ({ gold: { stripeCustomerId: 'cus_1' } });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.rpc.release_refund_intent = () => true;
const sent: any[] = []; T.tables.__sent = sent;
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_intents/pi_1')) return { id: 'pi_1', customer: 'cus_1', metadata: {} };
  if (url.endsWith('/refunds/re_5')) return { id: 're_5', status: 'failed', amount: 50000 };
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const key = init.headers['Idempotency-Key'];
    if (key === 'refund:camp1:rk_1') return { id: 're_5', status: 'succeeded', amount: 50000, created: 1, __headers: { 'Idempotent-Replayed': 'true' } };
    sent.push(key); return { id: 're_6', status: 'succeeded', amount: 50000, created: Math.floor(Date.now() / 1000) };
  }
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_1', amount: 500, idempotencyKey: 'rk_1' } };`);
    assert.strictEqual(r.body.refundId, 're_6', JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__sent, ['refund:camp1:rk_1_after_re_5']);
});

// ── TED-127: a refund the look-up settles counts against its top-up ────────

test('TED-127: after a stuck Refund All refund is found, a new top-up is refunded on the FIRST press', () => {
    const H = 'scanteen:pi_A:2000:2000';
    const r = runEdge('stripe-canteen-refund', canteen({
        deposits: [{ pi: 'pi_A', amount: 20, ts: 1 }, { pi: 'pi_B', amount: 30, ts: 2 }], bal: 30, holdAge: 900,
        holds: [{ key: H, amount: 20, method: 'stripe', paymentRef: 'pi_A', stripeKey: 'canteen_refund_pi_A_2000_2000', state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' }],
        refunds: [snapshot('re_old', 2000, 'pi_A', H)],
        request: { camperId: 7, camperName: 'Avi', amount: 30, idempotencyKey: 'cref_new' } }));
    assert.strictEqual(r.body.totalRefunded, 30, JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__sent.map(s => [s.pi, s.amount]), [['pi_B', 30]]);
    assert.ok(booked(r).includes('re_old'));
    assert.strictEqual(r.tables.__bal, 0);
});

test('TED-126: a refund that failed and was put back can be refunded from its top-up again', () => {
    // the ledger: $20 top-up, a $20 refund that later failed, and the line
    // that put it back — the top-up is refundable again
    const src = canteen({ deposits: [{ pi: 'pi_top1', amount: 20, ts: 1 }], bal: 20,
        refunds: [failed('re_16', 2000, 'pi_top1', 'scanteen:x')],
        request: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_3' } })
      .replace('let bal = 20;', `let bal = 20;
tx.push({ kind: 'refund', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 20, stripeRefundId: 're_16', camperId: 7 });
tx.push({ kind: 'refund_failed', type: 'credit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 20, failedRefundId: 're_16', camperId: 7 });`);
    const r = runEdge('stripe-canteen-refund', src);
    assert.strictEqual(r.body.totalRefunded, 20, JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__sent.map(s => s.amount), [20]);
    const all = runEdge('stripe-canteen-refund-all', src.replace(/T\.request = [^\n]*$/, `T.request = { headers: { Authorization: 'Bearer owner' }, body: {} };`));
    assert.strictEqual(all.body.totalRefunded, 20, JSON.stringify(all.body));
});

// ── TED-126 (2): the webhook hears the failure ─────────────────────────────

function hook(event, extra) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.rpc.record_external_refund = () => ({ success: true });
T.rpc.reverse_failed_stripe_refund = (a: any) => ({ success: true, canteen: true, amount: 20 });
T.fetch = (url: string) => url.includes('/payment_intents/pi_1') ? { id: 'pi_1', metadata: { campId: 'camp1' } } : {};
${extra || ''}
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
}
const refundEvent = (type, status) => ({ id: 'evt_9', type, data: { object: {
    id: 're_16', object: 'refund', amount: 2000, status, payment_intent: 'pi_1', failure_reason: 'expired_or_canceled_card',
    metadata: { campistryHold: 'scanteen:pi_1:2000:2000' } } } });

for (const type of ['refund.failed', 'refund.updated', 'charge.refund.updated']) {
    test(`TED-126: ${type} (failed) puts the money back on the right camp, once per event`, () => {
        const r = hook(refundEvent(type, 'failed'));
        const calls = r.rpcs.filter(c => c.name === 'reverse_failed_stripe_refund');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(calls.length, 1, JSON.stringify(r.logs));
        assert.deepStrictEqual(calls[0].args, { p_camp_id: 'camp1', p_refund_id: 're_16', p_reason: 'expired or canceled card' });
    });
}

test('TED-126: a refund update that is not a failure changes nothing', () => {
    const r = hook(refundEvent('refund.updated', 'succeeded'));
    assert.strictEqual(r.rpcs.filter(c => c.name === 'reverse_failed_stripe_refund').length, 0);
});

test('TED-126: the database cannot be reached — 500, so Stripe sends the failure again', () => {
    const r = hook(refundEvent('refund.failed', 'failed'), `T.rpc.reverse_failed_stripe_refund = () => { throw new Error('connection refused'); };`);
    assert.strictEqual(r.status, 500, JSON.stringify(r.body));
});

test('TED-126: a failed refund in a charge.refunded list is not booked as a refund', () => {
    const event = { id: 'evt_3', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1',
        metadata: { campId: 'camp1' }, refunds: { data: [
            { id: 're_ok', amount: 1000, status: 'succeeded' },
            { id: 're_bad', amount: 2000, status: 'failed' }] } } } };
    const r = hook(event);
    assert.deepStrictEqual(r.rpcs.filter(c => c.name === 'record_external_refund').map(c => c.args.p_refund_id), ['re_ok']);
});

// ── the Snacks screen counts the put-back money as refundable again ────────

test('TED-126: Snacks counts a failed-and-put-back refund as refundable again', () => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const SN = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
    const cut = (name) => { const at = SN.indexOf('function ' + name + '('); let i = SN.indexOf('{', at), d = 0;
        for (; i < SN.length; i++) { if (SN[i] === '{') d++; else if (SN[i] === '}' && --d === 0) break; } return SN.slice(at, i + 1); };
    const ctx = { snacks: { transactions: [
        { kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_1', amount: 20, camper: 'Avi', camperId: 7 },
        { kind: 'refund', method: 'stripe', stripePaymentIntentId: 'pi_1', amount: 20, camper: 'Avi', camperId: 7 },
        { kind: 'refund_failed', type: 'credit', method: 'stripe', stripePaymentIntentId: 'pi_1', amount: 20, camper: 'Avi', camperId: 7 }] },
        _deskCamperId: () => 7 };
    vm.createContext(ctx);
    vm.runInContext(cut('_onlineDeposits') + '\n' + cut('_onlineRefundCapacity') + '\nthis.cap = _onlineRefundCapacity;', ctx);
    assert.strictEqual(ctx.cap('Avi', 'stripe'), 20);
});
