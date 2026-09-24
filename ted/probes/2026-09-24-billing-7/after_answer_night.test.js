// Probe (7th pass, TED-103 re-check): the REAL charge-due-installments on the
// night after the office answered the card-deposit question. The family no
// longer has a question; its plan still carries the 'deposit_review' flag the
// database wrote on the nights before (shape copied from deposit_review_flag.js
// output: attempts 1 → nextRetryAt today+3). Is the instalment due today charged?
// Run: node --test ted/probes/2026-09-24-billing-7/after_answer_night.test.js
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');
const TODAY = new Date().toISOString().split('T')[0];
const IN3 = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
function night(blocked) {
  const plan = { id: 'plan_a', dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false };
  if (blocked) plan.collectionBlocked = blocked;
  return `
const TODAY = '${TODAY}';
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_autopay_charge = () => ({ success: true, balance: 500 });
T.rpc.flag_plan_collection = () => ({ success: true });
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', camperIds: ['Avi'], cardOnFile: true, stripeCustomerId: 'cus_G',
    charges: [{ amount: 1000 }], depositReview: [], depositReviewed: { pi_dep: 'separate' }, plans: [${JSON.stringify(plan)}] } });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: TODAY, amount: 500 });
T.fetch = (url: string, init: any) => (init.method === 'POST' && url.endsWith('/payment_intents')) ? { id: 'pi_new', status: 'succeeded' } : {};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
}
const charges = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents')).length;
test('probe', () => {
  const clean = runEdge('charge-due-installments', night(null));
  console.log(`# control, no flag on the plan: charges sent ${charges(clean)} | results ${JSON.stringify((clean.body.details || []).map(d => d.result))}`);
  const r = runEdge('charge-due-installments', night({ reason: 'deposit_review', attempts: 1, nextRetryAt: IN3, escalated: false }));
  console.log(`# question answered, deposit_review flag left from last night (retry ${IN3}): charges sent ${charges(r)} | results ${JSON.stringify((r.body.details || []).map(d => ({ result: d.result, reason: d.reason, next: d.nextRetryAt })))}`);
});
