// Proof: a card-on-file deposit whose processor call fails with a network error
// (fetch throws / non-JSON answer) leaves its claim in place; every later try is
// answered "already paid" although nothing was charged.
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');
test('probe', () => {
  const r = runEdge('registration-deposit-checkout', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null, stripe_account_id: 'acct_1', stripe_charges_enabled: true }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: { enr_1: { camperName: 'Avi',
   savedCardCustomer: 'cus_parent', savedCardMethod: 'pm_parent', savedCardProcessor: 'stripe', savedCardLast4: '4242' } } } }];
T.rpc._registration_deposit_owed = () => ({ success: true, owed: 250, label: 'Deposit', camperName: 'Avi' });
T.rpc._record_registration_deposit = () => ({ success: true });
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { if (claims[a.p_key]) return { claimed: false, previous: claims[a.p_key] }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
let n = 0;
T.fetch = (url: string) => { if (url.endsWith('/payment_intents')) { if (n++ === 0) throw new Error('connection reset'); return { id: 'pi_ok', status: 'succeeded', amount_received: 25000 }; } return {}; };
const req = { headers: { Authorization: 'Bearer owner' }, body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://camp.test/', officeCharge: true } };
T.requests = [req, req, req];`);
  r.responses.forEach((x, i) => console.log('try ' + (i + 1) + ':', x.status, JSON.stringify(x.body)));
  console.log('card charges that went through:', r.fetches.filter(f => f.url.endsWith('/payment_intents')).length - 1);
});
