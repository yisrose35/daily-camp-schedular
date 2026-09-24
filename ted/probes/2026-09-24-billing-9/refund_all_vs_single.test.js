// Probe (9th pass, new hunt). Two DIFFERENT refund actions for the same child at
// the same moment — the REAL functions, loaded into one process
// (two_fn_harness.js, a copy of tests/edge_harness.js that can load several):
//
//   Office B: Snacks → Refund, $20 for Avi (the page's own key)
//             → stripe-canteen-refund / payments-canteen-refund
//   Office A: Snacks → Refund All (end of summer)
//             → stripe-canteen-refund-all / payments-canteen-refund-all
//
// Avi topped up $50 once and spent $30 at the canteen: $20 is left. Whatever
// the two offices do, at most $20 can rightly go back to the parent.
//
// The card company is modelled as it behaves: it refuses a refund larger than
// what is still unrefunded on that one original charge, and nothing else. The
// ledger functions are idempotent by refund id and do not stop at zero (229).
// One shared refund_intents table behind claim/settle/release (198/273).
//
// Timings: "single-first" — Refund All runs in full while the single refund
// holds its claim; "all-first" — the single refund runs in full while Refund
// All is waiting for the card company.
// Run: node --test ted/probes/2026-09-24-billing-9/refund_all_vs_single.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdges } = require('./two_fn_harness');

const COMMON = (timing) => `
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
  if (!T.nested && TIMING === 'single-first' && T.phase === 'single' && !T.fired) { T.fired = true; await T.runOther(1, {}); }
  return out;
};
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (!c) return false; c.result = a.p_result; c.settled_at = 'now'; return true; };
T.rpc.release_refund_intent = (a: any) => { const c = find(a.p_key); if (!c || c.settled_at) return false; T.tables.refund_intents = RI().filter((r: any) => r !== c); return true; };
T.rpc.release_stale_refund_intent = () => false;
T.rpc.record_processor_transaction = () => ({ success: true });
const singleBody = { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_b' };
if (TIMING === 'single-first') { T.phase = 'single'; T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: singleBody, url: 'http://edge.test/single' }]; }
else { T.phase = 'all'; }
`;

function stripe(timing) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
${COMMON(timing)}
const tx: any[] = [
  { kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 },
  { kind: 'purchase', amount: 30, camper: 'Avi', camperId: 7, timestamp: 2 },
];
let bal = 20;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal = Math.round((bal - a.p_amount) * 100) / 100; return { success: true, balance: bal };
};
const seen: Record<string, any> = {}; let n = 0; let refundedOnPi = 0; T.tables.__money = [];
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key']; const p = new URLSearchParams(init.body);
    if (!T.nested && TIMING === 'all-first' && !T.fired) { T.fired = true; await T.runOther(0, singleBody); }
    if (seen[k]) return seen[k];
    const cents = Number(p.get('amount'));
    if (refundedOnPi + cents > 5000) return { __status: 400, error: { type: 'invalid_request_error', message: 'Refund amount ($' + (cents / 100).toFixed(2) + ') is greater than unrefunded amount on charge ($' + ((5000 - refundedOnPi) / 100).toFixed(2) + ')' } };
    refundedOnPi += cents; n++;
    seen[k] = { id: 're_' + n, status: 'succeeded', amount: cents };
    T.tables.__money.push(p.get('payment_intent') + ' $' + cents / 100 + ' (key ' + k + ')');
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top1', transfer_data: null };
  return {};
};
T.tables.__bal = () => bal;
T.__final = () => bal;
${timing === 'all-first' ? "T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: {}, url: 'http://edge.test/all' }];" : ''}
globalThis.__BAL = () => bal;`;
}

function cardknox(timing) {
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${COMMON(timing)}
const tx: any[] = [
  { kind: 'deposit', method: 'cardknox', byopTransactionId: 'X1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 },
  { kind: 'purchase', amount: 30, camper: 'Avi', camperId: 7, timestamp: 2 },
];
let bal = 20;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_processor = (a: any) => {
  if (tx.some(t => t.byopRefundId === a.p_refund_external_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', byopTransactionId: a.p_external_transaction_id, amount: a.p_amount, byopRefundId: a.p_refund_external_id, camperId: 7 });
  bal = Math.round((bal - a.p_amount) * 100) / 100; return { success: true, balance: bal };
};
let n = 0, refundedOnX1 = 0; T.tables.__money = [];
T.fetch = async (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    const p = new URLSearchParams(init.body);
    if (!T.nested && TIMING === 'all-first' && !T.fired) { T.fired = true; await T.runOther(0, singleBody); }
    const cents = Math.round(Number(p.get('xAmount')) * 100);
    if (refundedOnX1 + cents > 5000) return 'xResult=E&xStatus=Error&xError=Amount exceeds original transaction';
    refundedOnX1 += cents; n++;
    T.tables.__money.push(p.get('xRefNum') + ' $' + p.get('xAmount'));
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
${timing === 'all-first' ? "T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: {}, url: 'http://edge.test/all' }];" : ''}`;
}

// T.requests always runs the LAST loaded handler (T.handler), so the function
// the outer request needs is loaded last; the other is handler 0 or 1 by the
// order below.
const say = (b) => b.error ? 'ERROR ' + String(b.error).slice(0, 70) : ('totalRefunded' in b && 'refundedCount' in b ? 'refund-all $' + b.totalRefunded : '$' + b.totalRefunded);
for (const [proc, scen, single, all] of [['Stripe', stripe, 'stripe-canteen-refund', 'stripe-canteen-refund-all'], ['Cardknox', cardknox, 'payments-canteen-refund', 'payments-canteen-refund-all']]) {
  for (const timing of ['single-first', 'all-first']) {
    test(`${proc} ${timing}`, () => {
      // handler 0 = single, handler 1 = all; the outer request uses the last one loaded
      const names = timing === 'single-first' ? [all, single] : [single, all];
      // re-map runOther indexes: in single-first the nested call is Refund All (loaded first = index 0)
      const fix = (s) => timing === 'single-first' ? s.replace('await T.runOther(1, {})', 'await T.runOther(0, {})') : s;
      const r = runEdges(names, fix(scen(timing)));
      const moved = (r.tables.__money || []).reduce((t, x) => t + Number(String(x).split('$')[1].split(' ')[0]), 0);
      // the wallet ledger books each refund id once (229 is idempotent by refund id)
      const ids = {}; r.rpcs.filter(c => /^refund_canteen_deposit_from_/.test(c.name)).forEach(c => { ids[c.args.p_refund_id || c.args.p_refund_external_id] = Number(c.args.p_amount || 0); });
      const booked = Object.values(ids).reduce((t, a) => t + a, 0);
      const outer = r.responses[0].body, inner = (r.tables.__answers || [])[0] || {};
      const line = `${proc.padEnd(8)} ${timing.padEnd(12)} | money back to the parent: $${moved} ${JSON.stringify(r.tables.__money)} | canteen wallet after: ${(20 - booked).toFixed(2)} | outer: ${say(outer)} | inner: ${say(inner.body || {})}`;
      console.log('# ' + line);
      assert.ok(moved <= 20.0001, 'more than the $20 left in the wallet went back: ' + line);
    });
  }
}
