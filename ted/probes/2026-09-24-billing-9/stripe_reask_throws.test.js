// Probe (9th pass, TED-109 claim check): "a Stripe network error is reported as
// uncertain, not as Refund failed". The REAL stripe-canteen-refund. Press 1:
// Stripe makes the refund, the answer is lost. Press 2 (same key) re-asks Stripe
// for the held part — and that call is cut off too. Press 3: Stripe answers.
// What does the office see on press 2, and how much money moves in total?
// Run: node --test ted/probes/2026-09-24-billing-9/stripe_reask_throws.test.js
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');
test('probe', () => {
  const r = runEdge('stripe-canteen-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.tables.refund_intents = [];
const find = (k: string) => T.tables.refund_intents.find((r: any) => r.key === k);
T.rpc.claim_refund_intent = (a: any) => { const c = find(a.p_key); if (c) return { claimed: false, previous: c.result || {} }; T.tables.refund_intents.push({ camp_id: a.p_camp_id, key: a.p_key, amount: a.p_amount, result: null, settled_at: null }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (c) { c.result = a.p_result; c.settled_at = 'now'; } return true; };
T.rpc.release_refund_intent = () => true;
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 50;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => { if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true }; tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 }); bal -= a.p_amount; return { success: true }; };
const seen: Record<string, any> = {}; let posts = 0, n = 0; T.tables.__money = [];
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    posts++; const k = init.headers['Idempotency-Key'];
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded' }; T.tables.__money.push('pi_top1 $' + Number(new URLSearchParams(init.body).get('amount')) / 100); }
    if (posts <= 2) throw new Error('connection reset');
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top1', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req, req];`);
  r.responses.forEach((x, i) => console.log(`# press ${i + 1}: HTTP ${x.status} ${JSON.stringify(x.body).slice(0, 170)}`));
  console.log(`# money moved: ${JSON.stringify(r.tables.__money)}`);
});
