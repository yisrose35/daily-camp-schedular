// Probe (9th pass, new hunt). A parent disputes a $500 tuition charge. Stripe
// sends charge.dispute.created to the REAL stripe-webhook (signed correctly).
// stripe-webhook looks for the camp in the DISPUTE's own `metadata`
// (index.ts:754). Our functions stamp campId on the PaymentIntent (and Stripe
// copies that to the Charge), but a Dispute is its own object with its own
// metadata, which is empty unless someone sets it.
//   A. dispute.metadata = {}            (what I expect Stripe to send — unconfirmed)
//   B. dispute.metadata = {campId: …}   (what the code assumes)
// Does the chargeback reach the family's ledger (record_chargeback)?
// Run: node --test ted/probes/2026-09-24-billing-9/dispute_campid.test.js
'use strict';
const test = require('node:test');
const crypto = require('node:crypto');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

function run(label, metadata) {
  const event = { id: 'evt_1', type: 'charge.dispute.created', data: { object: {
    id: 'dp_1', object: 'dispute', amount: 50000, currency: 'usd', charge: 'ch_1', payment_intent: 'pi_1',
    reason: 'fraudulent', status: 'needs_response', metadata, evidence_details: { due_by: 1790000000 } } } };
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
  const r = runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.rpc.record_chargeback = (a: any) => ({ success: true, entryId: 'le_cb_' + a.p_dispute_id });
T.fetch = () => ({});
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
  const posted = r.rpcs.filter(c => c.name === 'record_chargeback');
  const log = (r.logs || []).find(l => /dispute dp_1/.test(l)) || '';
  console.log(`# ${label}: HTTP ${r.status} | record_chargeback calls: ${posted.length} | log: ${log.slice(0, 150)}`);
}

test('dispute campId', () => {
  run('A. dispute metadata empty ', {});
  run('B. dispute metadata campId', { campId: 'camp1' });
});
