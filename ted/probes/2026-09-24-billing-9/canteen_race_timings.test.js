// Probe (9th pass, TED-109 re-check). The REAL stripe-canteen-refund and
// payments-canteen-refund. The office means ONE $20 refund; a second request
// with the SAME key (the page's key: e.g. the browser gave up waiting, the
// office pressed again while the server was still working) arrives at five
// different moments of the first request:
//
//   prior    between the first's "earlier claims" read and its first claim  (8th-pass timing)
//   claim1   right after the first took its first claim
//   postIn   while the first's first refund call is on its way (not yet made)
//   postMade after the card company made the first refund, before its answer is back
//   settle1  after the first's first part is settled and recorded
//
// Stripe is modelled as it behaves: a repeated Idempotency-Key replays the
// refund it made; a request with a key whose first request is still in
// progress gets 409 idempotency_error and moves no money. Cardknox has no key.
// The ledger functions are idempotent by refund id (migration 229).
// Run: node --test ted/probes/2026-09-24-billing-9/canteen_race_timings.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

const CASES = { one: [50], two: [50, 50], small: [10, 50] };
const TIMINGS = ['prior', 'claim1', 'postIn', 'postMade', 'settle1'];

const COMMON = (mode) => `
const MODE = ${JSON.stringify(mode)};
T.inB = false; T.aClaims = 0; T.aSettles = 0; T.aPosts = 0; T.tables.__race = [];
const reqBody = { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' };
T.runB = async () => {
  T.inB = true;
  const r = await T.handler(new Request('http://edge.test/fn', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify(reqBody) }));
  T.tables.__race.push(await r.json());
  T.inB = false;
};
T.tables.refund_intents = [];
const RI = () => T.tables.refund_intents;
const find = (k: string) => RI().find((r: any) => r.key === k);
T.rpc.claim_refund_intent = async (a: any) => {
  const isA = !T.inB;
  if (isA) { T.aClaims++; if (MODE === 'prior' && T.aClaims === 1) await T.runB(); }
  const c = find(a.p_key);
  let out: any;
  if (c) out = { claimed: false, unguarded: false, previous: c.result || {} };
  else { RI().push({ camp_id: a.p_camp_id, key: a.p_key, amount: a.p_amount, payment_ref: a.p_payment_ref, result: null, settled_at: null, created_at: Date.now() }); out = { claimed: true, unguarded: false }; }
  if (isA && MODE === 'claim1' && T.aClaims === 1) await T.runB();
  return out;
};
T.rpc.settle_refund_intent = async (a: any) => {
  const c = find(a.p_key); if (!c) return false; c.result = a.p_result; c.settled_at = 'now';
  return true;
};
T.rpc.release_refund_intent = (a: any) => { const c = find(a.p_key); if (!c || c.settled_at) return false; T.tables.refund_intents = RI().filter((r: any) => r !== c); return true; };
T.rpc.release_stale_refund_intent = () => false;   // every claim here is seconds old
T.users = { owner: 'u-owner' };
const req = { headers: { Authorization: 'Bearer owner' }, body: reqBody };
T.requests = [req];
`;

function stripeScenario(deps, mode) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
${COMMON(mode)}
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_stripe = async (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount;
  if (!T.inB) { T.aSettles++; if (MODE === 'settle1' && T.aSettles === 1) await T.runB(); }
  return { success: true, balance: bal };
};
const seen: Record<string, any> = {}; const inflight = new Set<string>(); let n = 0;
T.tables.__money = [];
const make = (k: string, p: URLSearchParams) => { if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(p.get('amount')) }; T.tables.__money.push(p.get('payment_intent') + ' $' + Number(p.get('amount')) / 100); } return seen[k]; };
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];
    const p = new URLSearchParams(init.body);
    if (inflight.has(k)) return { __status: 409, error: { type: 'idempotency_error', message: 'There is currently another in-progress request using this Stripe API Idempotency Key' } };
    if (!T.inB) {
      T.aPosts++;
      if (T.aPosts === 1 && MODE === 'postIn') { inflight.add(k); await T.runB(); inflight.delete(k); return make(k, p); }
      if (T.aPosts === 1 && MODE === 'postMade') { make(k, p); inflight.add(k); await T.runB(); inflight.delete(k); return seen[k]; }
    }
    return make(k, p);
  }
  if (url.includes('/payment_intents/')) return { id: 'pi', transfer_data: null };
  return {};
};`;
}

function byopScenario(deps, mode) {
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${COMMON(mode)}
T.rpc.record_processor_transaction = () => ({ success: true });
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'cardknox', byopTransactionId: 'X' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_processor = async (a: any) => {
  if (tx.some(t => t.byopRefundId === a.p_refund_external_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', byopTransactionId: a.p_external_transaction_id, amount: a.p_amount, byopRefundId: a.p_refund_external_id, camperId: 7 });
  bal -= a.p_amount;
  if (!T.inB) { T.aSettles++; if (MODE === 'settle1' && T.aSettles === 1) await T.runB(); }
  return { success: true, balance: bal };
};
let n = 0; T.tables.__money = [];
T.fetch = async (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    const p = new URLSearchParams(init.body);
    const isA = !T.inB;
    if (isA) T.aPosts++;
    if (isA && T.aPosts === 1 && MODE === 'postIn') await T.runB();
    n++; const my = n;
    T.tables.__money.push(p.get('xRefNum') + ' $' + p.get('xAmount'));
    if (isA && T.aPosts === 1 && MODE === 'postMade') await T.runB();
    return 'xResult=A&xRefNum=R' + my + '&xStatus=Approved';
  }
  return {};
};`;
}

const moved = (r) => (r.tables.__money || []).reduce((t, x) => t + Number(String(x).split('$')[1] || 0), 0);
const say = (x) => x.error ? (x.uncertain ? 'UNCERTAIN: ' : 'ERROR: ') + x.error.slice(0, 60) : (x.uncertain ? 'uncertain ' : '') + '$' + x.totalRefunded;

const rows = [];
for (const timing of TIMINGS) {
  for (const [name, deps] of Object.entries(CASES)) {
    for (const [fn, scen, label] of [['stripe-canteen-refund', stripeScenario, 'Stripe  '], ['payments-canteen-refund', byopScenario, 'Cardknox']]) {
      test(`${label} ${timing} ${JSON.stringify(deps)}`, () => {
        const r = runEdge(fn, scen(deps, timing));
        const m = moved(r);
        const first = r.responses[0].body, second = (r.tables.__race || [])[0] || {};
        const ledger = (r.tables.refund_intents || []).map(c => c.key.replace('cref_1:', '') + (c.settled_at ? ' settled ' + c.result.amount : ' OPEN'));
        const line = `${label} ${timing.padEnd(8)} ${JSON.stringify(deps).padEnd(7)} | money moved $${m} ${JSON.stringify(r.tables.__money)} | 1st: ${say(first)} | 2nd: ${say(second)} | claims ${JSON.stringify(ledger)}`;
        rows.push(line);
        console.log('# ' + line);
        assert.ok(m <= 20.0001, 'more than $20 went back: ' + line);
        // a plain (not "uncertain") error on a request whose money went is a wrong answer
        for (const a of [first, second]) {
          if (a.error && !a.uncertain && m > 0) assert.fail('plain error though money moved: ' + line);
        }
      });
    }
  }
}
