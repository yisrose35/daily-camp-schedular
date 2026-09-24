// Probe (7th pass, TED-105 re-check): Snacks now sends one key per refund and
// resends it when the office presses Refund again after a lost answer. The
// builder's test covers ONE top-up on Stripe. Most campers top up more than
// once. The office refunds $20; the first request fully succeeds and is
// recorded, but the page never hears back; the office presses Refund again
// (same key, as campistry_snacks.js:1946-1950 does). How many refunds reach
// the card company, for the real stripe-canteen-refund and payments-canteen-refund?
//   one:     one top-up of $50
//   two:     two top-ups, $50 then $50
//   small:   two top-ups, $10 then $50 (the $20 spans both)
// Run: node --test ted/probes/2026-09-24-billing-7/canteen_retry_two_topups.test.js
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

const CASES = { one: [50], two: [50, 50], small: [10, 50] };

function stripeScenario(deps) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
const seen: Record<string, any> = {}; let n = 0;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];          // Stripe replays a repeated key
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(new URLSearchParams(init.body).get('amount')) }; }
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req];`;
}

function byopScenario(deps) {
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { if (claims[a.p_key] && !claims[a.p_key].result) delete claims[a.p_key]; return true; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = { result: a.p_result }; return true; };
T.rpc.release_stale_refund_intent = () => false;
T.rpc.record_processor_transaction = () => ({ success: true });
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'cardknox', byopTransactionId: 'X' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_processor = (a: any) => {
  tx.push({ kind: 'refund', byopTransactionId: a.p_external_transaction_id, amount: a.p_amount, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
let n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) { n++; return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved'; }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req];`;
}

const gatewayRefunds = (r) => r.fetches.filter(f => (f.method === 'POST' && f.url.endsWith('/refunds')) || String(f.body || '').includes('cc%3Arefund'));
const describe = (r) => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).map(f => f.headers['Idempotency-Key'] + ' $' + Number(new URLSearchParams(f.body).get('amount')) / 100)
  .concat(r.fetches.filter(f => String(f.body || '').includes('cc%3Arefund')).map(f => { const p = new URLSearchParams(f.body); return p.get('xRefNum') + ' $' + p.get('xAmount'); }));

test('probe', () => {
  for (const [name, deps] of Object.entries(CASES)) {
    const s = runEdge('stripe-canteen-refund', stripeScenario(deps));
    const distinct = new Set(s.responses.flatMap(x => (x.body.refunds || []).map(y => y.refundId)));
    console.log(`# Stripe  ${name.padEnd(5)} top-ups ${JSON.stringify(deps)}: answers ${JSON.stringify(s.responses.map(x => x.status + ' ' + (x.body.error || '$' + x.body.totalRefunded)))} | distinct Stripe refunds made: ${distinct.size} ${JSON.stringify([...distinct])} | refund calls ${JSON.stringify(describe(s))}`);
    const b = runEdge('payments-canteen-refund', byopScenario(deps));
    console.log(`# Cardknox ${name.padEnd(5)} top-ups ${JSON.stringify(deps)}: answers ${JSON.stringify(b.responses.map(x => x.status + ' ' + (x.body.error || '$' + x.body.totalRefunded)))} | refunds sent to Cardknox: ${gatewayRefunds(b).length} ${JSON.stringify(describe(b))}`);
  }
  console.log('# the office meant ONE $20 refund in every case');
});
