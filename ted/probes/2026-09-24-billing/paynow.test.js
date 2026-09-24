const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const W = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', stripe_account_id: 'acct_CAMP', stripe_charges_enabled: true }];
T.rpc.camp_family = (a: any) => a.p_family_key === 'gold' ? { name: 'Gold' } : null;
T.fetch = (url: string) => url.endsWith('/checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/x' } : {};
`;
for (const [who, body] of [
  ['parent portal Pay Now (campistry_link_parent.html:1723 body)', `{campId:'camp1',familyName:'Gold',email:'p@x',amount:500,description:'Camp payment — Gold',successUrl:'https://l/s',cancelUrl:'https://l/c'}`],
  ['office pay link (campistry_me.js:19019 body)', `{campId:'camp1',familyKey:'gold',familyName:'Gold',email:'p@x',amount:500,description:'x'}`]]) {
  test(who, () => {
    const r = runEdge('stripe-checkout', W + `T.request = { body: ${body} };`);
    const s = r.fetches.find(f => f.url.endsWith('/checkout/sessions'));
    const p = new URLSearchParams(s.body);
    console.log(who, '=> destination:', p.get('payment_intent_data[transfer_data][destination]'), '| metadata familyKey:', JSON.stringify(p.get('payment_intent_data[metadata][familyKey]')));
  });
}
