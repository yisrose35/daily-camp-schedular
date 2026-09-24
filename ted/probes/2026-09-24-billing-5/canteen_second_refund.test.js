// Probe (5th pass): stripe-canteen-refund keys each Stripe refund on
// payment intent + amount only. A camper's $50 Stripe top-up; the office refunds
// $20, then (same day) another $20. Stripe keeps idempotency keys for 24 h and
// answers a repeated key with the FIRST refund. What does the office see, and
// how much money actually went back?
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

test('probe', () => {
    const r = runEdge('stripe-canteen-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 50;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
// Stripe with its idempotency: the same key within 24 h returns the first result.
const seen: Record<string, any> = {}; let n = 0; (globalThis as any).__moved = 0;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];
    if (!seen[k]) { n++; const amt = Number(new URLSearchParams(init.body).get('amount')); (globalThis as any).__moved += amt; seen[k] = { id: 're_' + n, status: 'succeeded', amount: amt }; }
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20 } };
T.requests = [req, req];`);
    r.responses.forEach((x, i) => console.log(`# office refund ${i + 1} ($20): HTTP ${x.status} ${JSON.stringify(x.body)}`));
    const refunds = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds'));
    console.log('# Idempotency-Keys sent:', refunds.map(f => f.headers['Idempotency-Key']).join(' , '));
});
