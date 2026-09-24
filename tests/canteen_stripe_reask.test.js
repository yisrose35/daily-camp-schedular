// =============================================================================
// canteen_stripe_reask.test.js — TED-117, the real Stripe canteen refunds.
//
// A canteen refund was sent to Stripe and its answer never came back; its
// money is held off the wallet (275). What happens when it is picked up again?
//
// Before, it was sent AGAIN with its old Idempotency-Key. Stripe forgets a key
// after 24 hours, so a day later that was a second refund ($100 back on a $50
// wallet); and a top-up already fully refunded answered "already refunded",
// which was read as "no" and put the $20 back on the wallet. Now Stripe's own
// list of the payment's refunds is asked: made — booked; never made — the
// money goes back; Stripe cannot say — it stays held.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

// Stripe as it behaves a day later: every POST is a NEW refund (the old key is
// forgotten), refused only when it would exceed what is left on the payment.
function scenario({ deposit, bal, hold, stripeRefunds, listFails, extra }) {
    return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.tables.refund_intents = [];
const RI = () => T.tables.refund_intents;
const find = (k: string) => RI().find((r: any) => r.key === k);
T.rpc.claim_refund_intent = (a: any) => { const c = find(a.p_key); if (c) return { claimed: false, previous: c.result || {} };
  RI().push({ key: a.p_key, amount: a.p_amount, result: null, settled_at: null, created_at: new Date().toISOString() }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (c) { c.result = a.p_result; c.settled_at = 'now'; } return true; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = RI().filter((r: any) => !(r.key === a.p_key && !r.settled_at)); return true; };
T.rpc.release_stale_refund_intent = () => false;
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: ${deposit}, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = ${bal};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
${hold ? `T.tables.canteen_refund_holds.push(${JSON.stringify(hold)}); T.holdAge = 90000;` : ''}
const refunds: any[] = ${JSON.stringify(stripeRefunds || [])};
let n = 0; T.tables.__posted = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('/refunds?payment_intent=')) {
    if (${JSON.stringify(!!listFails)}) return { __status: 500, error: { type: 'api_error', message: 'Stripe had a hiccup' } };
    return { data: refunds.slice(), has_more: false };
  }
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const p = new URLSearchParams(init.body); const cents = Number(p.get('amount'));
    const left = ${deposit * 100} - refunds.reduce((t: number, r: any) => t + r.amount, 0);
    if (cents > left) return { __status: 400, error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge has already been refunded.' } };
    const r = { id: 're_new' + (++n), status: 'succeeded', amount: cents, payment_intent: 'pi_top1', metadata: { campistryHold: p.get('metadata[campistryHold]') }, created: Math.floor(Date.now() / 1000) };
    refunds.push(r); T.tables.__posted.push(cents / 100);
    return r;
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top1', transfer_data: null };
  return {};
};
${extra || ''}
T.request = { headers: { Authorization: 'Bearer owner' }, body: {} };`;
}
const heldRow = (amount, key) => ({ key: key || `scanteen:pi_top1:5000:${amount * 100}`, amount, method: 'stripe', paymentRef: 'pi_top1',
    stripeKey: `canteen_refund_pi_top1_5000_${amount * 100}`, state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' });
const holdState = (r) => (r.tables.canteen_refund_holds || []).map(h => h.state);
const ledgerRefunds = (r) => r.rpcs.filter(c => c.name === 'settle_canteen_refund_hold').map(c => c.args.p_refund_id);

test('TED-117: a held $20 that Stripe DID make, picked up a day later — booked, never sent again', () => {
    const r = runEdge('stripe-canteen-refund-all', scenario({ deposit: 50, bal: 30, hold: heldRow(20),
        stripeRefunds: [{ id: 're_old', status: 'succeeded', amount: 2000, payment_intent: 'pi_top1', metadata: { campistryHold: 'scanteen:pi_top1:5000:2000' }, created: 1 }] }));
    assert.ok(ledgerRefunds(r).includes('re_old'), 'the refund Stripe made was not booked');
    assert.deepStrictEqual(r.tables.__posted, [30], 'money sent to the parent this run: ' + JSON.stringify(r.tables.__posted));
    assert.strictEqual(r.tables.__bal, 0);
});

test('TED-117: a held $20 on a top-up Stripe already refunded in full — booked, not put back on the wallet', () => {
    const r = runEdge('stripe-canteen-refund-all', scenario({ deposit: 20, bal: 0, hold: heldRow(20, 'scanteen:pi_top1:2000:2000'),
        stripeRefunds: [{ id: 're_old', status: 'succeeded', amount: 2000, payment_intent: 'pi_top1', metadata: { campistryHold: 'scanteen:pi_top1:2000:2000' }, created: 1 }] }));
    assert.deepStrictEqual(holdState(r), ['posted']);
    assert.strictEqual(r.tables.__bal, 0, 'money the parent already got back was put on the wallet');
    assert.deepStrictEqual(r.tables.__posted, []);
});

test('TED-117: a held $20 Stripe never made — the money goes back and is refunded once', () => {
    const r = runEdge('stripe-canteen-refund-all', scenario({ deposit: 50, bal: 30, hold: heldRow(20), stripeRefunds: [] }));
    assert.deepStrictEqual(holdState(r)[0], 'released');
    assert.deepStrictEqual(r.tables.__posted, [50]);
    assert.strictEqual(r.tables.__bal, 0);
});

test('TED-117: Stripe cannot be asked — the $20 stays held, nothing is put back', () => {
    const r = runEdge('stripe-canteen-refund-all', scenario({ deposit: 50, bal: 30, hold: heldRow(20), stripeRefunds: [], listFails: true }));
    assert.strictEqual(holdState(r)[0], 'open');
    assert.ok(!r.rpcs.some(c => c.name === 'release_canteen_refund_hold' && c.args.p_hold_key === 'scanteen:pi_top1:5000:2000'));
    assert.deepStrictEqual(r.tables.__posted, [30], 'only what was not held went back');
});

test('TED-117: the single refund looks a day-old held refund up too — no second refund', () => {
    const src = scenario({ deposit: 50, bal: 30, hold: heldRow(20),
        stripeRefunds: [{ id: 're_old', status: 'succeeded', amount: 2000, payment_intent: 'pi_top1', metadata: { campistryHold: 'scanteen:pi_top1:5000:2000' }, created: 1 }],
        extra: `T.request = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 30, idempotencyKey: 'cref_9' } };` });
    const r = runEdge('stripe-canteen-refund', src.replace(/T\.request = \{ headers: \{ Authorization: 'Bearer owner' \}, body: \{\} \};$/, ''));
    assert.ok(ledgerRefunds(r).includes('re_old'));
    assert.deepStrictEqual(r.tables.__posted, [30]);
    assert.strictEqual(r.tables.__bal, 0);
    assert.strictEqual(r.body.totalRefunded, 30, JSON.stringify(r.body));
});

test('TED-117: Stripe\'s "that key was used with other details" is never read as "no refund"', () => {
    // this refund's own part, moments old, not in Stripe's list yet: asked again
    // with the same key, and Stripe refuses the key — that decides nothing
    const r = runEdge('stripe-canteen-refund', scenario({ deposit: 50, bal: 30, hold: heldRow(20, 'scanteen:cref_1:pi_top1'), stripeRefunds: [],
        extra: `T.holdAge = 0;
T.tables.refund_intents.push({ key: 'scanteen:cref_1:pi_top1', amount: 20, result: null, settled_at: null, created_at: new Date().toISOString() });
const f0 = T.fetch; T.fetch = (url: string, init: any) => (init.method === 'POST' && url.endsWith('/refunds'))
  ? { __status: 400, error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } }
  : f0(url, init);
T.request = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };` })
        .replace(/T\.request = \{ headers: \{ Authorization: 'Bearer owner' \}, body: \{\} \};$/, ''));
    assert.strictEqual(r.body.uncertain, true, JSON.stringify(r.body));
    assert.strictEqual(holdState(r)[0], 'open', 'the $20 was put back on the wallet');
    assert.strictEqual(r.tables.__bal, 30);
});
