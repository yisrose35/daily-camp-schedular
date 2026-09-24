// Probe (5th pass): TED-090 says a card-paid registration deposit becomes a
// REFUNDABLE payment (stripePaymentIntentId on the row). Can the office actually
// refund it through Billing (stripe-refund), when the family's card on file is
// not the card the parent used on the form? (Returning family, sibling, or a
// hosted Checkout deposit, which makes its own customer.)
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

const scenario = (familyCustomer) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: 'acct_1' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: ${JSON.stringify(familyCustomer)} } });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.rpc.release_refund_intent = () => true;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) return { id: 're_1', status: 'succeeded', amount: 25000 };
  // the deposit PaymentIntent exactly as registration-deposit-checkout makes it
  if (url.includes('/payment_intents/')) return { id: 'pi_dep', amount: 25000, customer: 'cus_form',
      transfer_data: { destination: 'acct_1' },
      metadata: { source: 'registration_deposit', enrollmentId: 'e1', campId: 'camp1' } };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_dep', amount: 250, idempotencyKey: 'k1' } };`;

test('probe', () => {
    for (const [label, cus] of [['family card on file = the form card', 'cus_form'],
                                ['family card on file = a different card (returning family)', 'cus_office'],
                                ['family has no Stripe customer on file', null]]) {
        const r = runEdge('stripe-refund', scenario(cus));
        const sent = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).length;
        console.log(`# ${label}: HTTP ${r.status} ${JSON.stringify(r.body)} | refunds sent to Stripe: ${sent}`);
    }
});
