const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
test('hosted-complete: key not matched -> newest transaction used', () => {
  const r = runEdge('payments-hosted-complete', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.banquest_pending_links = [{ key: 'KEY_A', camp_id: 'camp1', purpose: 'pay_now', family_key: 'famA', amount: 100, status: 'pending' }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { families: { famA: { name: 'Family A' } } } }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { sourceKey: 's', pin: 'p' } });
T.rpc.append_camp_payment = (a: any) => { (T as any).paid = a.p_payment; return { success: true }; };
// Banquest answers with the newest transactions on the account; none carries KEY_A
T.fetch = (url: string) => url.includes('/transactions?') ? [{ transaction_details: { reference_number: 777, key: 'KEY_OTHER_FAMILY' }, status_details: { status: 'captured' }, amount_details: { amount: 350 } }] : {};
T.request = { body: { key: 'KEY_A' } };
`);
  const pay = r.rpcs.find(x => x.name === 'append_camp_payment');
  console.log('response', JSON.stringify(r.body), '| recorded for', pay && pay.args.p_payment.familyKey, '$' + (pay && pay.args.p_payment.amount), 'ref', pay && pay.args.p_payment.reference);
});
