// Probe (6th pass): TED-096's fix lets stripe-refund accept any PaymentIntent
// whose metadata.campId is the caller's camp. Campistry's OWN charges to the
// camp (SMS number $25 setup fee: telnyx-number-request; monthly SMS fee:
// telnyx-charge-monthly-fees) carry metadata.campId too, sit on the platform
// account with no transfer, and are charged to the camp's own platform
// customer. Can the camp's office refund Campistry's fee to itself?
// Run once at HEAD and once (by FN_DIR) at the pre-fix code.
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

const scenario = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: 'acct_1' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_family' } });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.rpc.release_refund_intent = () => true;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) return { id: 're_fee', status: 'succeeded', amount: 2500 };
  // exactly as telnyx-charge-monthly-fees / telnyx-number-request create it
  if (url.includes('/payment_intents/')) return { id: 'pi_fee', amount: 2500, customer: 'cus_camp_itself',
      metadata: { campId: 'camp1', purpose: 'telnyx_monthly_fee' } };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_fee', amount: 25, idempotencyKey: 'k1' } };`;

test('probe', () => {
    const r = runEdge('stripe-refund', scenario);
    const sent = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds'));
    console.log(`# camp office refunds Campistry's own SMS fee: HTTP ${r.status} ${JSON.stringify(r.body)} | refunds sent to Stripe: ${sent.length}` +
        (sent[0] ? ` | reverse_transfer: ${/reverse_transfer/.test(sent[0].body || '')}` : ''));
});
