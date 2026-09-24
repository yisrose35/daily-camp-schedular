// Probe (20th pass): the real nightly runner, legacy installments[] plans.
// Teal (paused for a dispute) and Olive (control) are identical otherwise.
// Is Teal held and Olive charged? Run with an arg path to use another runner copy.
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdge } = require(R + '/tests/edge_harness.js');
const fam = (name, extra) => Object.assign({ name, cardOnFile: true, stripeCustomerId: 'cus_' + name, stripePaymentMethodId: 'pm_' + name,
  charges: [{ id: 'ch_' + name, amount: 1000, description: 'Tuition' }],
  plans: [{ id: 'p_' + name, autopay: true, installments: [{ dueDate: '2020-01-01', amount: 500, status: 'pending' }, { dueDate: '2099-01-01', amount: 500, status: 'pending' }] }] }, extra || {});
const fams = { teal: fam('Teal'), olive: fam('Olive') };
fams.teal.plans[0].collectionBlocked = { reason: 'chargeback', disputeId: 'dp_1' };
const r = runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.camp_families_object = () => (${JSON.stringify(fams)});
T.fetch = (url: string, init: any) => (init && init.method === 'POST' && /payment_intents$/.test(url)) ? { id: 'pi_' + new URLSearchParams(String(init.body)).get('customer'), status: 'succeeded', amount: 50000 } : {};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`);
const charges = r.fetches.filter(f => f.method === 'POST' && /\/payment_intents$/.test(f.url)).map(f => new URLSearchParams(String(f.body)).get('customer'));
console.log('results:', JSON.stringify((r.body.details || []).map(d => d.family + ':' + d.result)));
console.log('charges:', JSON.stringify(charges));
const ok = charges.includes('cus_Olive') && !charges.includes('cus_Teal');
console.log(ok ? 'ok   Teal held, Olive (control) charged' : 'BAD  Teal charged or control not charged');
process.exitCode = ok ? 0 : 1;
