// Probe (8th pass, TED-105 re-check). The real stripe-canteen-refund and
// payments-canteen-refund, with ONE refund_intents table shared by the claim
// RPCs (claim/settle/release, same rules as migrations 198/273) and by the new
// "what did this key already do" table read. Stripe replays a repeated
// Idempotency-Key (as it does). The office means ONE $20 refund each time.
//
//  lost:      first request succeeds and is recorded, answer lost; office presses again (same key)
//  netlost:   the refund call reaches the card company, but the answer never comes back
//             (Stripe: fetch throws after Stripe made it; Cardknox: no answer) -> press again
//  partfail:  $10+$50: first top-up refunded, second DECLINED (no money moved) -> press again
//  race:      second click's request runs in full between the first request's
//             "earlier claims" read and its first claim (same key)
// Run: node --test ted/probes/2026-09-24-billing-8/canteen_retry_realistic.test.js
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

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
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(p.get('amount')) }; T.tables.__money.push(p.get('payment_intent') + ' $' + Number(p.get('amount')) / 100); }
    if (${JSON.stringify(mode)} === 'netlost' && posts === 1) throw new Error('connection reset');   // made, answer lost
    return seen[k];
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

// money that actually moved = refunds the (modelled) card company made
const moneyOf = (r) => {
  // T.money is not returned; rebuild from fetches + scenario rules is fiddly, so read logs of Stripe keys instead
  return r;
};

function summarize(label, r, processor) {
  let made;
  if (processor === 'stripe') {
    const keys = new Set(r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).map(f => f.headers['Idempotency-Key'] + '|' + new URLSearchParams(f.body).get('amount')));
    made = [...keys];
  } else {
    made = r.fetches.filter(f => String(f.body || '').includes('cc%3Arefund')).map(f => { const p = new URLSearchParams(f.body); return p.get('xRefNum') + ' $' + p.get('xAmount'); });
  }
  const answers = r.responses.map(x => x.status + ' ' + (x.body.error ? 'ERR ' + x.body.error.slice(0, 70) : (x.body.uncertain ? 'uncertain ' : '') + '$' + x.body.totalRefunded));
  const moved = r.tables.__money || [];
  const race = (r.tables.__race || []).map(x => x.error ? 'ERR ' + x.error.slice(0, 60) : (x.uncertain ? 'uncertain ' : '') + '$' + x.totalRefunded);
  if (race.length) answers.unshift('2nd click: ' + race[0]);
  const ledger = (r.tables.refund_intents || []).map(c => c.key.replace('cref_1:', '') + (c.settled_at ? ' settled ' + (c.result && c.result.amount) : ' OPEN'));
  console.log(`# ${label}: answers ${JSON.stringify(answers)} | MONEY MOVED ${moved.length}: ${JSON.stringify(moved)} | calls ${made.length} | claims ${JSON.stringify(ledger)}`);
}

test('probe', () => {
  for (const mode of ['lost', 'netlost', 'partfail', 'race']) {
    for (const [name, deps] of Object.entries(CASES)) {
      if (mode === 'partfail' && name !== 'small') continue;
      const s = runEdge('stripe-canteen-refund', stripeScenario(deps, mode) + `\nT.__done = true;`);
      summarize(`Stripe   ${mode.padEnd(8)} ${name.padEnd(5)} ${JSON.stringify(deps)}`, s, 'stripe');
      const b = runEdge('payments-canteen-refund', byopScenario(deps, mode));
      summarize(`Cardknox ${mode.padEnd(8)} ${name.padEnd(5)} ${JSON.stringify(deps)}`, b, 'byop');
    }
  }
  console.log('# the office meant ONE $20 refund in every case');
});
