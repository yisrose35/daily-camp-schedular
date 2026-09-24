// =============================================================================
// canteen_refund_race.test.js — TED-110, the real canteen refund functions.
//
// Avi topped up $50 once and spent $30: $20 is left. Two offices at once:
//
//   Office A: Snacks → Refund All (end of summer)
//   Office B: Snacks → Refund, for Avi ($20, or $10)
//
// Whatever order they land in, at most $20 may go back to the parent and the
// wallet must never go below zero. Both functions are loaded into one process
// (tests/edge_harness.js runEdges) and the second office's request is run from
// inside the first one's claim or card-company call — the moment it would
// really land. The wallet is migration 275's reservation, as a model
// (tests/canteen_wallet_model.js); the SQL, with a real two-connection race,
// is in scripts/pgtests/275_a_canteen_refund_takes_its_money_first.sql.
//
// Scenarios from Ted's 9th-pass probe (ted/probes/2026-09-24-billing-9/).
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdges } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

const COMMON = (timing, single) => `
const TIMING = ${JSON.stringify(timing)};
T.users = { owner: 'u-owner' };
T.tables.refund_intents = [];
const RI = () => T.tables.refund_intents;
const find = (k: string) => RI().find((r: any) => r.key === k);
T.nested = false; T.tables.__answers = [];
T.runOther = async (idx: number, body: any) => {
  T.nested = true;
  const r = await T.handlers[idx](new Request('http://edge.test/fn', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify(body) }));
  T.tables.__answers.push({ fn: idx, body: await r.json() });
  T.nested = false;
};
T.rpc.claim_refund_intent = async (a: any) => {
  const c = find(a.p_key);
  let out: any;
  if (c) out = { claimed: false, unguarded: false, previous: c.result || {} };
  else { RI().push({ key: a.p_key, amount: a.p_amount, result: null, settled_at: null }); out = { claimed: true, unguarded: false }; }
  // single-first: Refund All runs in full while the single refund holds its claim
  if (!T.nested && TIMING === 'single-first' && !T.fired) { T.fired = true; await T.runOther(0, {}); }
  return out;
};
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (!c) return false; c.result = a.p_result; c.settled_at = 'now'; return true; };
T.rpc.release_refund_intent = (a: any) => { const c = find(a.p_key); if (!c || c.settled_at) return false; T.tables.refund_intents = RI().filter((r: any) => r !== c); return true; };
T.rpc.release_stale_refund_intent = () => false;
T.rpc.record_processor_transaction = () => ({ success: true });
const singleBody = { camperId: 7, camperName: 'Avi', amount: ${single}, idempotencyKey: 'cref_b' };
T.requests = TIMING === 'single-first'
  ? [{ headers: { Authorization: 'Bearer owner' }, body: singleBody }]
  : [{ headers: { Authorization: 'Bearer owner' }, body: {} }];
`;

// Stripe as it behaves: a repeated key answers with the first result; a refund
// larger than what is left unrefunded on the charge is refused.
function stripe(timing, single) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
${COMMON(timing, single)}
const tx: any[] = [
  { kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 },
  { kind: 'purchase', amount: 30, camper: 'Avi', camperId: 7, timestamp: 2 },
];
let bal = 20;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
const seen: Record<string, any> = {}; let n = 0; let refundedOnPi = 0; T.tables.__money = [];
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key']; const p = new URLSearchParams(init.body);
    // all-first: the single refund runs in full while Refund All waits for Stripe
    if (!T.nested && TIMING === 'all-first' && !T.fired) { T.fired = true; await T.runOther(1, singleBody); }
    if (seen[k]) return seen[k];
    const cents = Number(p.get('amount'));
    if (refundedOnPi + cents > 5000) return { __status: 400, error: { type: 'invalid_request_error', message: 'Refund amount is greater than unrefunded amount on charge' } };
    refundedOnPi += cents; n++;
    seen[k] = { id: 're_' + n, status: 'succeeded', amount: cents };
    T.tables.__money.push(cents / 100);
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top1', transfer_data: null };
  return {};
};`;
}

function cardknox(timing, single) {
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${COMMON(timing, single)}
const tx: any[] = [
  { kind: 'deposit', method: 'cardknox', byopTransactionId: 'X1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 },
  { kind: 'purchase', amount: 30, camper: 'Avi', camperId: 7, timestamp: 2 },
];
let bal = 20;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
let n = 0, refundedOnX1 = 0; T.tables.__money = [];
T.fetch = async (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    const p = new URLSearchParams(init.body);
    if (!T.nested && TIMING === 'all-first' && !T.fired) { T.fired = true; await T.runOther(1, singleBody); }
    const cents = Math.round(Number(p.get('xAmount')) * 100);
    if (refundedOnX1 + cents > 5000) return 'xResult=E&xStatus=Error&xError=Amount exceeds original transaction';
    refundedOnX1 += cents; n++;
    T.tables.__money.push(cents / 100);
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};`;
}

const say = (b) => b.error ? 'ERROR ' + String(b.error).slice(0, 80) : ('refundedCount' in b ? 'refund-all $' + b.totalRefunded : '$' + b.totalRefunded);

for (const [proc, scen, single, all] of [['Stripe', stripe, 'stripe-canteen-refund', 'stripe-canteen-refund-all'],
                                         ['Cardknox', cardknox, 'payments-canteen-refund', 'payments-canteen-refund-all']]) {
    for (const amount of [20, 10]) {
        for (const timing of ['single-first', 'all-first']) {
            test(`TED-110: ${proc} — Refund All and a $${amount} refund of the same child at once (${timing}): never more than the $20 left`, () => {
                // handler 0 = Refund All, handler 1 = the single refund; the outer
                // request goes to the last one loaded.
                const names = timing === 'single-first' ? [all, single] : [single, all];
                const src = scen(timing, amount).replace(/T\.runOther\(1, singleBody\)/, timing === 'all-first' ? 'T.runOther(0, singleBody)' : 'T.runOther(1, singleBody)');
                const r = runEdges(names, timing === 'single-first' ? src : src.replace('await T.runOther(0, {})', 'await T.runOther(1, {})'));
                const moved = (r.tables.__money || []).reduce((t, x) => t + x, 0);
                const answers = [r.responses[0].body].concat((r.tables.__answers || []).map(a => a.body));
                const line = `money back $${moved}, wallet after $${r.tables.__bal} — ${answers.map(say).join(' | ')}`;
                assert.strictEqual((r.tables.__answers || []).length, 1, 'the second office\'s request never ran: ' + line);
                assert.ok(moved <= 20.0001, 'more than the $20 in the wallet went back: ' + line);
                assert.ok(r.tables.__bal >= 0, 'the wallet went below zero: ' + line);
                assert.strictEqual(r.tables.__bal, Math.round((20 - moved) * 100) / 100, 'the wallet does not match what went back: ' + line);
                assert.strictEqual(moved, 20, 'the rest of the $20 was not refunded: ' + line);
                // neither office is told "done" for money the other one sent,
                // and no answer claims more than went back
                const claimed = answers.reduce((t, b) => t + (Number(b.totalRefunded) || 0), 0);
                assert.ok(claimed <= 20.0001, 'the two answers say more went back than did: ' + line);
            });
        }
    }
}

// A sale lands while Refund All is running: Refund All read $20 at the start,
// the till takes $15 of it before Avi's turn comes. Only $5 may go back.
for (const [proc, scen, all] of [['Stripe', stripe, 'stripe-canteen-refund-all'], ['Cardknox', cardknox, 'payments-canteen-refund-all']]) {
    test(`TED-110: ${proc} — a canteen sale during Refund All is not refunded as well`, () => {
        const src = scen('sale', 20).replace(`T.rpc.canteen_refund_view = () =>`, `
let viewed = 0;
T.rpc.canteen_refund_view = () => { const v = __v0(); if (++viewed === 1) { bal = Math.round((bal - 15) * 100) / 100; } return v; };
const __v0 = () =>`);
        const r = runEdges([all], src);
        const moved = (r.tables.__money || []).reduce((t, x) => t + x, 0);
        assert.strictEqual(moved, 5, `$${moved} went back after a $15 sale left $5: ${JSON.stringify(r.responses[0].body)}`);
        assert.strictEqual(r.tables.__bal, 0, 'wallet after: ' + r.tables.__bal);
    });
}
