const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
test('tip retry', () => {
  const r = runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [];
T.rpc.retry_failed_tip_transfers = () => [{ id: 'item1', staffName: 'Coach Dan', staffAccountId: '5f0c2a8e-0000-4000-8000-000000000001', tipCents: 2000, feeCents: 40 }];
T.fetch = (url: string, init: any) => url.endsWith('/transfers') ? (new URLSearchParams(init.body).get('destination')!.startsWith('acct_') ? { id: 'tr_1' } : { error: { message: 'No such destination: ' + new URLSearchParams(init.body).get('destination') } }) : {};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };
`);
  const tr = r.fetches.filter(f => f.url.endsWith('/transfers'));
  tr.forEach(t => console.log('transfer sent:', t.body));
  console.log(r.logs.filter(l => /tip/.test(l)).join('\n'));
});
