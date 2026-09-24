// Probe (13th pass, TED-130 side effect). Since TED-130 the Snacks Refund
// window asks stripe-canteen-refund / payments-canteen-refund for the whole
// camp's `refundable` answer every time a child is picked, and Refund All
// once per opening. How long does the REAL function take to work it out for a
// large camp over a full summer? (The database read itself is not timed here:
// canteen_refund_view is answered with a synthetic view of the same shape.)
// Run: node ted/probes/2026-09-24-billing-13/refundable_scale.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');

function view(accounts, topUpsEach, refundsEach, method) {
  const idField = method === 'stripe' ? 'stripePaymentIntentId' : 'byopTransactionId';
  const acc = {}, txs = [], holds = [];
  for (let a = 1; a <= accounts; a++) {
    const key = 'Camper ' + a;
    acc[key] = { balance: 50, balanceFloor: 0, camperId: a };
    for (let t = 1; t <= topUpsEach; t++) {
      const ref = `${method === 'stripe' ? 'pi' : 'X'}_${a}_${t}`;
      txs.push({ kind: 'deposit', type: 'credit', method, [idField]: ref, amount: 25, camper: key, camperId: a, date: '2026-07-01', timestamp: t });
      if (t <= refundsEach) txs.push({ kind: 'refund', type: 'debit', method, [idField]: ref, amount: 5, camper: key, camperId: a });
    }
    if (a % 50 === 0) holds.push({ key: 'h' + a, accountKey: key, camperId: a, amount: 5, method, paymentRef: `${method === 'stripe' ? 'pi' : 'X'}_${a}_1`, ageSeconds: 10 });
  }
  return { success: true, accounts: acc, transactions: txs, holds };
}

for (const [accounts, each, refunds] of [[100, 8, 2], [300, 8, 2], [600, 8, 2], [600, 15, 3], [1000, 10, 2]]) {
  for (const fn of ['stripe-canteen-refund', 'payments-canteen-refund']) {
    const method = fn.startsWith('stripe') ? 'stripe' : 'cardknox';
    const v = view(accounts, each, refunds, method);
    const scen = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'c1', owner: 'u-owner', payment_processor_key: '${method}' }];
const __V = ${JSON.stringify(v)};
T.rpc.canteen_refund_view = () => __V;
T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: { action: 'holds' } }, { headers: { Authorization: 'Bearer owner' }, body: { action: 'holds' } }];
const __h = T.handlers; T.__t = [];
const __orig = T.fetch;`;
    const t0 = Date.now();
    const r = runEdges([fn], scen);
    const ms = Date.now() - t0;
    const b = r.responses[0].body || {};
    const n = Object.keys(b.refundable || {}).length;
    console.log(`${fn.padEnd(24)} ${String(accounts).padStart(5)} children × ${String(each).padStart(2)} top-ups (${v.transactions.length} ledger rows): 2 answers in ${ms} ms (incl. harness start-up); refundable for ${n} children; child 1 → ${JSON.stringify((b.refundable || {})['Camper 1'])}`);
  }
}
