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
        assert.deepStrictEqual(calls[0].args, { p_camp_id: 'camp1', p_refund_id: 're_16', p_reason: 'expired or canceled card',
            p_amount: 20, p_payment_ref: 'pi_1', p_hold_key: 'scanteen:pi_1:2000:2000' });
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

// ── TED-131: the platform hears about EVERY failed refund, once ─────────────

const alerted = (r) => r.logs.filter(l => /cannot send risk alert: Stripe alert: a \$20\.00 refund failed/.test(l)).length;

test('TED-131: a failed refund not on Campistry\'s books still alerts the platform (and the office is told)', () => {
    const r = hook(refundEvent('refund.failed', 'failed'),
        `T.rpc.reverse_failed_stripe_refund = () => ({ success: false, error: 'refund_not_found', firstNotice: true });`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(alerted(r), 1, JSON.stringify(r.logs));
});

test('TED-131: the same unbooked failure again (refund.updated after refund.failed) does not alert twice', () => {
    const r = hook(refundEvent('refund.updated', 'failed'),
        // the first delivery claimed the alert (claim_refund_failure_alert)
        `T.rpc.reverse_failed_stripe_refund = () => ({ success: false, error: 'refund_not_found', firstNotice: false });
T.rpc.claim_refund_failure_alert = () => false;`);
    assert.strictEqual(alerted(r), 0, JSON.stringify(r.logs));
});

test('TED-131: a booked failure alerts once; a repeat does not', () => {
    const first = hook(refundEvent('refund.failed', 'failed'),
        `T.rpc.reverse_failed_stripe_refund = () => ({ success: true, canteen: true, amount: 20, firstNotice: true });`);
    assert.strictEqual(alerted(first), 1);
    const again = hook(refundEvent('charge.refund.updated', 'failed'),
        `T.rpc.reverse_failed_stripe_refund = () => ({ success: true, alreadyRecorded: true, canteen: true });
T.rpc.claim_refund_failure_alert = () => false;`);
    assert.strictEqual(alerted(again), 0);
});

// ── TED-150: an alert email that did not send is sent on the next delivery ──

function deliveries(n, extra) {
    return hook(refundEvent('refund.failed', 'failed'), `T.env.RESEND_API_KEY = 're_test';
const alertsClaimed = new Set<string>();
T.rpc.claim_refund_failure_alert = (a: any) => { const first = !alertsClaimed.has(a.p_refund_id); alertsClaimed.add(a.p_refund_id); return first; };
T.rpc.release_refund_failure_alert = (a: any) => alertsClaimed.delete(a.p_refund_id);
T.rpc.reverse_failed_stripe_refund = () => ({ success: true, canteen: true, amount: 20, firstNotice: true });
${extra}
Object.defineProperty(T, 'requests', { get: () => Array(${n}).fill(T.request) });`);
}

test('TED-150: the email service fails on the first delivery — 500, and the next delivery sends the alert', () => {
    const r = deliveries(3, `let tries = 0; T.emailFails = () => ++tries === 1;`);
    assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200, 200], JSON.stringify(r.responses.map(x => x.body)));
    assert.strictEqual(r.emails.length, 1, 'alerts sent: ' + r.emails.length);
    assert.match(r.emails[0].subject, /a \$20\.00 refund failed/);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'release_refund_failure_alert').length, 1);
});

test('TED-150: a sent alert is still sent once, however often Stripe repeats the failure', () => {
    const r = deliveries(4, '');
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200, 200]);
    assert.strictEqual(r.emails.length, 1);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'release_refund_failure_alert').length, 0);
});

test('TED-150: with no email key there is nothing to retry — the delivery is answered, the camp\'s notice stands', () => {
    const r = hook(refundEvent('refund.failed', 'failed'),
        `T.rpc.reverse_failed_stripe_refund = () => ({ success: true, canteen: true, amount: 20, firstNotice: true });`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(alerted(r), 1);
});

test('TED-150: with no camp either, a failed email is tried again on the next delivery', () => {
    const r = deliveries(2, `T.fetch = () => ({ id: 'x', metadata: {} }); let tries = 0; T.emailFails = () => ++tries === 1;`);
    assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200]);
    assert.strictEqual(r.emails.length, 1);
});

// ── TED-148: the surcharge's share goes back on the bill with the put-back ──

test('TED-148: a family refund put back — its card-surcharge credit is taken back (the database keeps it to once)', () => {
    const r = deliveries(2, `T.rpc.reverse_failed_stripe_refund = () => ({ success: true, family: true, familyKey: 'slate', amount: 1000, firstNotice: true });
T.rpc.undo_card_fee_return = (a: any) => ({ success: true, undone: 1, amount: 29.13 });`);
    const u = r.rpcs.filter(c => c.name === 'undo_card_fee_return');
    assert.ok(u.length >= 1, 'the surcharge credit was left on the bill');
    assert.deepStrictEqual(u[0].args, { p_camp_id: 'camp1', p_family_key: 'slate', p_refund_id: 're_16' });
});

test('TED-148: the database cannot take the credit back yet — 500, so Stripe sends it again', () => {
    const r = hook(refundEvent('refund.failed', 'failed'),
        `T.rpc.reverse_failed_stripe_refund = () => ({ success: true, family: true, familyKey: 'slate', amount: 1000, firstNotice: true });
T.rpc.undo_card_fee_return = () => { throw new Error('connection refused'); };`);
    assert.strictEqual(r.status, 500);
});

test('TED-131/137: a failed refund with no camp anywhere alerts the platform — once, however often Stripe sends it', () => {
    const r = hook(refundEvent('refund.failed', 'failed'), `T.fetch = () => ({ id: 'x', metadata: {} });
const alertsClaimed = new Set<string>();
T.rpc.claim_refund_failure_alert = (a: any) => { const first = !alertsClaimed.has(a.p_refund_id); alertsClaimed.add(a.p_refund_id); return first; };
// the same failure delivered four times (read once T.request is set)
Object.defineProperty(T, 'requests', { get: () => [T.request, T.request, T.request, T.request] });`);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'reverse_failed_stripe_refund').length, 0);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200, 200]);
    assert.strictEqual(alerted(r), 1, 'alerts for one failure: ' + alerted(r));
});

// ── TED-133: charge.refunded asks Stripe how each refund stands NOW ────────

test('TED-133: a refund the event still calls succeeded, but Stripe now says failed, is not booked', () => {
    const event = { id: 'evt_4', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1',
        metadata: { campId: 'camp1' }, refunds: { data: [
            { id: 're_ok', amount: 1000, status: 'succeeded' },
            { id: 're_late', amount: 20000, status: 'succeeded' }] } } } };
    const r = hook(event, `T.fetch = (url: string) => url.endsWith('/refunds/re_late') ? { id: 're_late', status: 'failed' }
      : url.endsWith('/refunds/re_ok') ? { id: 're_ok', status: 'succeeded' } : {};`);
    assert.deepStrictEqual(r.rpcs.filter(c => c.name === 'record_external_refund').map(c => c.args.p_refund_id), ['re_ok']);
});

test('TED-133: Stripe not answering about a refund — 500, so the event comes again', () => {
    const event = { id: 'evt_5', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1',
        metadata: { campId: 'camp1' }, refunds: { data: [{ id: 're_ok', amount: 1000, status: 'succeeded' }] } } } };
    const r = hook(event, `T.fetch = (url: string) => url.includes('/refunds/') ? { __status: 503, error: { type: 'api_error' } } : {};`);
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'record_external_refund').length, 0);
});

// ── TED-130/135: the page is told what can go back to a card, from the FULL ledger

const monthAgo = 1;   // a timestamp far in the past: the functions must not care how old a top-up is
function holdsView(method, idField) {
    const dep = (ref, amount, ts) => ({ kind: 'deposit', method, [idField]: ref, amount, camper: 'Avi', camperId: 7, timestamp: ts });
    return {
        success: true,
        accounts: { Avi: { camperId: 7, balance: 70, balanceFloor: 0 }, Bea: { camperId: 8, balance: 12, balanceFloor: 2 } },
        transactions: [
            dep('OLD', 30, monthAgo), dep('NEW', 25, 2),
            { kind: 'deposit', method: 'cash', amount: 40, camper: 'Avi', camperId: 7 },
            { kind: 'refund', method, [idField]: 'OLD', amount: 10, camperId: 7 },
            { kind: 'refund_failed', type: 'credit', method, stripePaymentIntentId: 'OLD', amount: 10, camperId: 7 },
            { kind: 'deposit', method, [idField]: 'B1', amount: 50, camper: 'Bea', camperId: 8, timestamp: 3 },
        ],
        holds: [{ key: 'h1', accountKey: 'Avi', camperId: 7, amount: 20, method, paymentRef: 'NEW', ageSeconds: 30 }],
    };
}

test('TED-130: stripe-canteen-refund tells the page what each child can get back to the card, from the full ledger', () => {
    const r = runEdge('stripe-canteen-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.rpc.canteen_refund_view = () => (${JSON.stringify(holdsView('stripe', 'stripePaymentIntentId'))});
T.request = { headers: { Authorization: 'Bearer owner' }, body: { action: 'holds' } };`);
    // Avi: OLD 30 − 10 refunded + 10 failed back = 30; NEW 25 − 20 on its way = 5 → 35; wallet 70 → 35 now
    assert.deepStrictEqual(r.body.refundable.Avi, { camperId: 7, wallet: 70, card: 35, now: 35 });
    // Bea: $50 top-up, wallet $12 — her $2 floor limits spending, not a refund (TED-142)
    assert.deepStrictEqual(r.body.refundable.Bea, { camperId: 8, wallet: 12, card: 50, now: 12 });
    assert.strictEqual(r.body.holds.length, 1);
});

test('TED-130: payments-canteen-refund does the same on a Sola camp', () => {
    const r = runEdge('payments-canteen-refund', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc.canteen_refund_view = () => (${JSON.stringify(holdsView('cardknox', 'byopTransactionId'))});
T.request = { headers: { Authorization: 'Bearer owner' }, body: { action: 'holds' } };`);
    // on Sola a refund_failed line (Stripe-only) does not apply: OLD 30 − 10 = 20; NEW 5 → 25
    assert.deepStrictEqual(r.body.refundable.Avi, { camperId: 7, wallet: 70, card: 25, now: 25 });
    assert.strictEqual(r.body.processor, 'cardknox');
});

test('TED-135: Refund All says what the look-up of waiting refunds found', () => {
    const H = 'scanteen:pi_top1:2000:2000';
    const r = runEdge('stripe-canteen-refund-all', canteen({
        deposits: [{ pi: 'pi_top1', amount: 20, ts: 1 }], bal: 0, holdAge: 900,
        holds: [{ key: H, amount: 20, method: 'stripe', paymentRef: 'pi_top1', stripeKey: 'k', state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' }],
        refunds: [snapshot('re_9', 2000, 'pi_top1', H)] }));
    assert.deepStrictEqual(r.body.lookedUp, { made: 1, madeAmount: 20, notMade: 0, notMadeAmount: 0 });
    assert.strictEqual(r.body.refundedCount, 0);
    const n = runEdge('stripe-canteen-refund-all', canteen({
        deposits: [{ pi: 'pi_top1', amount: 20, ts: 1 }], bal: 0, holdAge: 900,
        holds: [{ key: H, amount: 20, method: 'stripe', paymentRef: 'pi_top1', stripeKey: 'k', state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' }],
        refunds: [] }));
    assert.deepStrictEqual(n.body.lookedUp, { made: 0, madeAmount: 0, notMade: 1, notMadeAmount: 20 });
    assert.strictEqual(n.body.totalRefunded, 20, 'the put-back money was refunded again in the same run');
});

// ── TED-132: Billing can refund a put-back refund to the card again ────────

test('TED-132: a tuition refund that failed and was put back can be refunded to the card again', () => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
    const cut = (name) => { const at = ME.indexOf('function ' + name + '('); let i = ME.indexOf('{', at), d = 0;
        for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; } return ME.slice(at, i + 1); };
    const pay = { id: 'pay_1', family: 'Gold', amount: 500, stripePaymentIntentId: 'pi_g', timestamp: Date.now() };
    const refund = { id: 'ref_1', family: 'Gold', amount: -500, refundOf: 'pay_1', stripeRefundId: 're_f1' };
    const putBack = { id: 'refail_re_f1', family: 'Gold', familyKey: 'gold', amount: 500, method: 'Refund failed', failedRefundId: 're_f1' };
    const run = (rows) => {
        const ctx = { finPayments: rows, families: {}, normalizePersonId: () => null, camperNameById: () => null };
        vm.createContext(ctx);
        vm.runInContext(['_famRefundablePayments', '_famPaymentsIn', '_refundedFrom', '_famRefundableOnlineAll'].map(cut).join('\n')
            + '\nthis.f = _famRefundableOnlineAll;', ctx);
        return JSON.parse(JSON.stringify(ctx.f({ name: 'Gold', camperIds: [] }).map(d => [d.p.id, d.remaining])));
    };
    assert.deepStrictEqual(run([pay, refund]), [], 'a refunded payment still offered');
    assert.deepStrictEqual(run([pay, refund, putBack]), [['pay_1', 500]]);
});

// ── TED-136: "refund it again from Billing" after a refund failed ──────────
// Billing sends the SAME key for the same payment, amount and remainder. The
// claim table kept the first, failed refund's answer under it forever, so the
// second press replayed it: "Refunded $500", nothing sent.

test('TED-136: pressing Refund again after the first refund failed makes a real second refund — once', () => {
    const r = runEdge('stripe-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.rpc.camp_families_object = () => ({ gold: { stripeCustomerId: 'cus_gold' } });
// refund_intents, as migration 198 keeps them: a settled claim answers with its result forever
const claims: any = {};
T.rpc.claim_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} };
  claims[a.p_key] = { result: null }; return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key].result = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
// Stripe: each key's first answer kept. re_1 is made by the first press and has
// FAILED by the time anyone asks about it again (the card account was closed).
const refunds: any = {}; const memory: any = {}; let n = 0; T.tables.__sent = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_intents/pi_g')) return { id: 'pi_g', customer: 'cus_gold', amount: 50000 };
  if (url.includes('/refunds/re_')) {
    const id = url.split('/refunds/')[1]; const r = refunds[id];
    if (!r) return { __status: 404, error: { type: 'invalid_request_error' } };
    return Object.assign({}, r, id === 're_1' ? { status: 'failed', failure_reason: 'expired_or_canceled_card' } : {});
  }
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const key = init.headers['Idempotency-Key'];
    if (memory[key]) return Object.assign({}, memory[key], { __headers: { 'Idempotent-Replayed': 'true' } });
    const r = { id: 're_' + (++n), status: 'succeeded', amount: 50000, created: Math.floor(Date.now() / 1000) };
    refunds[r.id] = r; memory[key] = Object.assign({}, r); T.tables.__sent.push({ id: r.id, key });
    return r;
  }
  return {};
};
const press = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_g', amount: 500, idempotencyKey: 'rfnd_gold:pay_1:500:500' } };
T.requests = [press, press, press];`);
    const [first, again, third] = r.responses.map(x => x.body);
    assert.strictEqual(first.refundId, 're_1');
    // the office presses Refund again (Billing sends the same key): a NEW refund
    assert.strictEqual(again.refundId, 're_2', 'the failed refund was replayed as if it had gone through: ' + JSON.stringify(again));
    assert.ok(!again.replayed);
    assert.deepStrictEqual(r.tables.__sent.map(x => x.key),
        ['refund:camp1:rfnd_gold:pay_1:500:500', 'refund:camp1:rfnd_gold:pay_1:500:500:after:re_1']);
    // pressed a third time (say its answer was lost): the second refund, replayed — nothing new sent
    assert.strictEqual(third.refundId, 're_2');
    assert.strictEqual(third.replayed, true);
    assert.strictEqual(r.tables.__sent.length, 2, 'a third refund was sent');
});

test('TED-136: Stripe cannot be asked about the earlier refund — nothing is sent, and it is not booked', () => {
    const r = runEdge('stripe-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.rpc.camp_families_object = () => ({ gold: { stripeCustomerId: 'cus_gold' } });
T.rpc.claim_refund_intent = () => ({ claimed: false, previous: { refundId: 're_1', amount: 500 } });
T.fetch = (url: string, init: any) => url.includes('/payment_intents/pi_g') ? { id: 'pi_g', customer: 'cus_gold', amount: 50000 }
  : url.includes('/refunds/re_1') ? { __status: 503, error: { type: 'api_error' } } : {};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_g', amount: 500, idempotencyKey: 'k1' } };`);
    assert.strictEqual(r.body.uncertain, true, JSON.stringify(r.body));
    assert.ok(!r.body.refundId, 'an answer the page would book as a refund');
    assert.strictEqual(r.fetches.filter(f => f.method === 'POST').length, 0);
});

// ── TED-142: a balance floor is not held back from a refund ────────────────

test('TED-142: Refund All returns the whole balance, floor and all', () => {
    const src = canteen({ deposits: [{ pi: 'pi_top1', amount: 50, ts: 1 }], bal: 50, refunds: [] })
      .replace("T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }",
               "T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 10 } }");
    assert.ok(/balanceFloor: 10/.test(src));
    const r = runEdge('stripe-canteen-refund-all', src);
    assert.strictEqual(r.body.totalRefunded, 50, JSON.stringify(r.body));
    assert.strictEqual(r.tables.__bal, 0);
    const one = runEdge('stripe-canteen-refund', src.replace(/T\.request = [^\n]*$/,
        `T.request = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', idempotencyKey: 'cref_f' } };`));
    assert.strictEqual(one.body.totalRefunded, 50, JSON.stringify(one.body));
});

test('TED-142: Take Out Cash still keeps the floor, and says so — and where the rest can go', () => {
    const C = require('../campistry_snacks_cash.js');
    const S = { cashDailyMax: 0, cashReasonRequired: false };
    const v = C.validate({ account: { balance: 50, balanceFloor: 10 }, transactions: [], camper: 'Avi', date: '2026-08-20', settings: S, amount: 50 });
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /Only \$40\.00 available to take out — the other \$10\.00 is under the balance floor; refund it to the card \(Refund\), or, if it was paid in cash, at the end of the season use Me → Billing → the family → Close out…, which takes the whole balance/);
    const w = C.validate({ account: { balance: 10, balanceFloor: 10 }, transactions: [], camper: 'Avi', date: '2026-08-20', settings: S, amount: 5 });
    assert.match(w.error, /under the balance floor — it cannot be taken out as cash here; refund it to the card \(Refund\), or, if it was paid in cash, .*Close out…, which takes the whole balance/);
    // when the DAILY limit is what stops it, the floor is not blamed
    const d = C.validate({ account: { balance: 50, balanceFloor: 10 }, transactions: [], camper: 'Avi', date: '2026-08-20',
        settings: { cashDailyMax: 20, cashReasonRequired: false }, amount: 30 });
    assert.strictEqual(d.error, 'Only $20.00 available to take out');
});
