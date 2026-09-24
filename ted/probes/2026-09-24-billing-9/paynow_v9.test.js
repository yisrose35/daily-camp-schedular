// 9th pass copy of probes/2026-09-24-billing/paynow.test.js: prints the answer
// when no Stripe session was made (the original crashed reading it). The first
// case is a parent with NO login naming a family: TED-063 says it must be refused.
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const W = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', stripe_account_id: 'acct_CAMP', stripe_charges_enabled: true }];
T.rpc.camp_family = (a: any) => a.p_family_key === 'gold' ? { name: 'Gold' } : null;
T.fetch = (url: string) => url.endsWith('/checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/x' } : {};
`;
for (const [who, body] of [
  ['parent portal Pay Now, no login, family by name', `{campId:'camp1',familyName:'Gold',email:'p@x',amount:500,description:'Camp payment — Gold',successUrl:'https://l/s',cancelUrl:'https://l/c'}`],
  ['office pay link body, no login', `{campId:'camp1',familyKey:'gold',familyName:'Gold',email:'p@x',amount:500,description:'x'}`]]) {
  test(who, () => {
    const r = runEdge('stripe-checkout', W + `T.request = { body: ${body} };`);
    const s = r.fetches.find(f => f.url.endsWith('/checkout/sessions'));
    if (!s) { console.log(who, '=> no Stripe session made; answer', r.status, JSON.stringify(r.body).slice(0, 140)); return; }
    const p = new URLSearchParams(s.body);
    console.log(who, '=> destination:', p.get('payment_intent_data[transfer_data][destination]'), '| metadata familyKey:', JSON.stringify(p.get('payment_intent_data[metadata][familyKey]')));
  });
}
