// Proof: a family whose plan is still the oldest shape (the single `plan`, no id,
// from before migration 116) paying by bank account. Does the TED-064 hold apply?
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');
const TODAY = new Date().toISOString().split('T')[0];
const night = (famPlan) => `
const TODAY = '${TODAY}';
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_autopay_installment = () => ({ success: true, patched: true });
T.rpc.flag_plan_collection = () => ({ success: true });
const held: any[] = [];
T.rpc.hold_autopay_charge = (a: any) => { held.push(a); return { success: true }; };
T.rpc.camp_families_object = () => ({ famA: { name: 'Bank family', camperIds: ['C'], cardOnFile: true, stripeCustomerId: 'cus_A', charges: [{ amount: 1000 }], ${famPlan} } });
T.fetch = (url: string, init: any) => (init.method === 'POST' && url.endsWith('/payment_intents')) ? { id: 'pi_ach_' + T.fetches.length, status: 'processing' } : {};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
test('probe', () => {
  const plan = `plan: { installments: [{ n: 1, amount: 500, dueDate: TODAY, status: 'pending' }, { n: 2, amount: 500, dueDate: '2099-01-01', status: 'pending' }], autopay: true, total: 1000 }`;
  for (let n = 1; n <= 3; n++) {
    const r = runEdge('charge-due-installments', night(plan));
    const debits = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents')).length;
    const holds = r.rpcs.filter(x => x.name === 'hold_autopay_charge').length;
    console.log(`night ${n}: bank debits started ${debits} | hold calls ${holds} | results ${JSON.stringify((r.body.details || []).map(d => d.result))}`);
  }
});
