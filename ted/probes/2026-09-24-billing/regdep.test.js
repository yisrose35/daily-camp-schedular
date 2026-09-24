const test = require('node:test'); const assert = require('node:assert');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const W = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.camps = [{ id: 'camp1', payment_processor_key: null, stripe_account_id: 'acct_1', stripe_charges_enabled: true }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: { enr_1: { camperName: 'Avi', savedCardCustomer: 'cus_parent', savedCardMethod: 'pm_parent', savedCardProcessor: 'stripe', savedCardLast4: '4242' } } } }];
let paid = 0;
T.rpc._registration_deposit_owed = () => ({ success: true, owed: paid ? 0 : 250, label: 'Deposit', camperName: 'Avi' });
T.rpc._record_registration_deposit = () => { paid = 1; return { success: true }; };
T.fetch = (url) => url.endsWith('/payment_intents') ? { id: 'pi_' + T.fetches.length, status: 'succeeded', amount_received: 25000 } : {};
`;
test('anonymous caller, officeCharge:true', () => {
  const r = runEdge('registration-deposit-checkout', W + `T.request = { body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://evil.example/', officeCharge: true } };`);
  const pis = r.fetches.filter(f => f.url.endsWith('/payment_intents'));
  console.log('status', r.status, JSON.stringify(r.body), 'stripe charges:', pis.length, pis.map(p => new URLSearchParams(p.body).get('customer') + ' ' + new URLSearchParams(p.body).get('amount')));
});
