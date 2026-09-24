const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const TODAY = new Date().toISOString().split('T')[0];
test('ACH autopay: processing on night 1, what happens on night 2', () => {
  const night = () => runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: {} }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.camp_families_object = () => ({ famB: { name: 'Bank family', camperIds: ['A'], cardOnFile: true, stripeCustomerId: 'cus_B', stripePaymentMethodId: 'pm_bank',
   plans: [{ id: 'plan_b', dueDates: ['${TODAY}', '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false }] } });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '${TODAY}', amount: 500 });   // nothing recorded, balance unchanged
T.fetch = (url: string) => url.endsWith('/payment_intents') ? { id: 'pi_' + Math.random().toString(36).slice(2, 6), status: 'processing' } : {};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };
`);
  let total = 0;
  for (const n of [1, 2, 3]) {
    const r = night();
    const pis = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));
    const rec = r.rpcs.filter(x => x.name === 'record_autopay_charge').length;
    total += pis.length;
    console.log('night', n, ': debits started', pis.length, '| recorded', rec, '| idempotency key sent:', !!(pis[0] && pis[0].headers['Idempotency-Key']));
  }
  console.log('bank debits started over 3 nights for one $500 instalment:', total);
});
