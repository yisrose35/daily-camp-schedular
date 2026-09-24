// =============================================================================
// canteen_refund_retry.test.js — TED-105 / TED-109, the real canteen refunds.
//
// The office means ONE $20 refund. Whatever happens — the answer is lost, the
// connection drops, half of it is declined, or a second press arrives while
// the first is running — no more than $20 may go back to the card, and where
// the outcome is known it is exactly $20. Scenarios from Ted's 8th-pass probe:
// one shared refund_intents table behind the claim RPCs and the "what did this
// key already do" read, and a Stripe that replays a repeated Idempotency-Key.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

const CASES = { one: [50], two: [50, 50], small: [10, 50] };

const CLAIMS = `
T.tables.refund_intents = [];
const RI = () => T.tables.refund_intents;
const find = (k: string) => RI().find((r: any) => r.key === k);
T.rpc.claim_refund_intent = async (a: any) => {
  if (T.beforeFirstClaim) { const f = T.beforeFirstClaim; T.beforeFirstClaim = null; await f(); }
  const c = find(a.p_key);
  if (c) return { claimed: false, unguarded: false, previous: c.result || {} };
  RI().push({ camp_id: a.p_camp_id, key: a.p_key, amount: a.p_amount, payment_ref: a.p_payment_ref, result: null, settled_at: null, created_at: Date.now() });
  return { claimed: true, unguarded: false };
};
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (!c) return false; c.result = a.p_result; c.settled_at = 'now'; return true; };
T.rpc.release_refund_intent = (a: any) => { const c = find(a.p_key); if (!c || c.settled_at) return false; T.tables.refund_intents = RI().filter((r: any) => r !== c); return true; };
T.rpc.release_stale_refund_intent = () => false;   // every claim here is seconds old
`;

function stripeScenario(deps, mode) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
${CLAIMS}
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
${HOLDS}
const seen: Record<string, any> = {}; let n = 0; let posts = 0;
T.tables.__money = [];
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    posts++;
    const k = init.headers['Idempotency-Key'];
    const p = new URLSearchParams(init.body);
    if (${JSON.stringify(mode)} === 'partfail' && p.get('payment_intent') === 'pi_top2' && posts === 2) {
      return { __status: 402, error: { message: 'Your card was declined (refund)' } };   // no money moved, no key stored
    }
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(p.get('amount')), payment_intent: p.get('payment_intent'),
                                      metadata: { campistryHold: p.get('metadata[campistryHold]') }, created: Math.floor(Date.now() / 1000) };
                    T.tables.__money.push(p.get('payment_intent') + ' $' + Number(p.get('amount')) / 100); }
    if (${JSON.stringify(mode)} === 'netlost' && posts === 1) throw new Error('connection reset');   // made, answer lost
    return seen[k];
  }
  // Stripe's list of a payment's refunds (TED-117: how a lost answer is looked up)
  if (url.includes('/refunds?payment_intent=')) {
    const pi = new URL(url).searchParams.get('payment_intent');
    return { data: Object.values(seen).filter((r: any) => r.payment_intent === pi), has_more: false };
  }
  if (url.includes('/payment_intents/')) return { id: 'pi', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
if (${JSON.stringify(mode)} === 'race') {
  T.beforeFirstClaim = async () => { const r = await T.handler(new Request('http://edge.test/fn', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify(req.body) })); T.tables.__race = [await r.json()]; };
  T.requests = [req];
} else T.requests = [req, req];`;
}

function byopScenario(deps, mode) {
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${CLAIMS}
T.rpc.record_processor_transaction = () => ({ success: true });
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'cardknox', byopTransactionId: 'X' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_processor = (a: any) => {
  tx.push({ kind: 'refund', byopTransactionId: a.p_external_transaction_id, amount: a.p_amount, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
${HOLDS}
let n = 0; T.tables.__money = [];
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    n++; const p = new URLSearchParams(init.body);
    if (${JSON.stringify(mode)} === 'partfail' && p.get('xRefNum') === 'X2' && n === 2) return 'xResult=D&xStatus=Declined&xError=Declined';
    T.tables.__money.push(p.get('xRefNum') + ' $' + p.get('xAmount'));
    if (${JSON.stringify(mode)} === 'netlost' && n === 1) throw new Error('connection reset');
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
if (${JSON.stringify(mode)} === 'race') {
  T.beforeFirstClaim = async () => { const r = await T.handler(new Request('http://edge.test/fn', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify(req.body) })); T.tables.__race = [await r.json()]; };
  T.requests = [req];
} else T.requests = [req, req];`;
}


const moved = (r) => (r.tables.__money || []).reduce((t, x) => t + Number(String(x).split('$')[1] || 0), 0);
const answers = (r) => (r.tables.__race || []).concat(r.responses.map(x => x.body));

for (const mode of ['lost', 'netlost', 'partfail', 'race']) {
    for (const [name, deps] of Object.entries(CASES)) {
        if (mode === 'partfail' && name !== 'small') continue;
        for (const [fn, scen] of [['stripe-canteen-refund', stripeScenario], ['payments-canteen-refund', byopScenario]]) {
            test(`${fn} · ${mode} · top-ups ${JSON.stringify(deps)}: never more than the $20 asked for`, () => {
                const r = runEdge(fn, scen(deps, mode));
                const m = moved(r);
                assert.ok(m <= 20.0001, `$${m} went back to the card: ${JSON.stringify(r.tables.__money)} — answers ${JSON.stringify(answers(r))}`);
                const known = mode !== 'netlost' || fn === 'stripe-canteen-refund';   // Stripe answers a re-ask; Cardknox leaves it to the office
                if (known) assert.strictEqual(m, 20, `$${m} refunded, not 20: ${JSON.stringify(answers(r))}`);
                // the wallet (275): down by exactly what went back to the card —
                // including a refund made whose answer never came back, which
                // stays off the wallet until the office has checked
                const start = deps.reduce((t, a) => t + a, 0);
                const want = Math.round((start - m) * 100) / 100;
                assert.strictEqual(r.tables.__bal, want, `the wallet ended at $${r.tables.__bal}, not $${want}: ${JSON.stringify(answers(r))}`);
                for (const a of answers(r)) {
                    assert.ok(!(a.error && !a.uncertain && m >= 20), 'told "' + a.error + '" though the refund went through');
                }
            });
        }
    }
}

// ── TED-115: Stripe cut off again while re-asking an unconfirmed part ──────
test('TED-115: a second lost Stripe answer on the re-ask says "may have gone through", and $20 moves once', () => {
    const r = runEdge('stripe-canteen-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
${CLAIMS}
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 50;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
const seen: Record<string, any> = {}; let posts = 0, n = 0, lists = 0; T.tables.__money = [];
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    posts++; const k = init.headers['Idempotency-Key']; const p = new URLSearchParams(init.body);
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(p.get('amount')), payment_intent: p.get('payment_intent'),
                                     metadata: { campistryHold: p.get('metadata[campistryHold]') }, created: Math.floor(Date.now() / 1000) };
                    T.tables.__money.push('pi_top1 $' + Number(p.get('amount')) / 100); }
    if (posts === 1) throw new Error('connection reset');   // press 1: made, answer lost
    return seen[k];
  }
  // press 2 asks Stripe what happened, and that call is cut off too; press 3's gets through
  if (url.includes('/refunds?payment_intent=')) {
    if (++lists === 1) throw new Error('connection reset');
    return { data: Object.values(seen), has_more: false };
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top1', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req, req];`);
    const [a, b, c] = r.responses.map(x => x.body);
    assert.strictEqual(a.uncertain, true, 'press 1: ' + JSON.stringify(a));
    assert.strictEqual(b.uncertain, true, 'press 2 showed a raw error: ' + JSON.stringify(b));
    assert.ok(!/connection reset/.test(String(b.error)), 'press 2: ' + b.error);
    assert.strictEqual(c.totalRefunded, 20, 'press 3: ' + JSON.stringify(c));
    assert.deepStrictEqual(r.tables.__money, ['pi_top1 $20']);
    assert.strictEqual(r.tables.__bal, 30);
});
