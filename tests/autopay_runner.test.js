// =============================================================================
// autopay_runner.test.js — the REAL nightly autopay program
// (charge-due-installments), run against a pretend Stripe and database
// (edge_harness.js). The database answers are the ones its own functions give.
//
//   TED-051  a plan a PARENT built (dueDates, no installments[]) with autopay on
//            is charged on its due date. It used to be skipped before its plans
//            were ever looked at.
//   TED-055  a declined instalment on an office-built (installments[]) plan is
//            NOT dropped: it stays pending with the reason, the plan is flagged
//            (so the office is told), and it is charged again on the retry.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

const TODAY = new Date().toISOString().split('T')[0];

const BASE = `
const TODAY = '${TODAY}';
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_autopay_charge = () => ({ success: true, balance: 500 });
T.rpc.record_autopay_installment = () => ({ success: true, patched: true });
T.rpc.flag_plan_collection = () => ({ success: true });
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };
`;

const charges = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'))
    .map(f => { const p = new URLSearchParams(f.body); return p.get('customer') + ' $' + Number(p.get('amount')) / 100; });

test('TED-051: a parent-built plan with autopay on is charged on its due date', () => {
    const r = runEdge('charge-due-installments', BASE + `
      T.rpc.camp_families_object = () => ({
        famP: { name: 'Parent plan', camperIds: ['A'], cardOnFile: true, stripeCustomerId: 'cus_P',
                plans: [{ id: 'plan_p', dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false, total: 1000, source: 'parent' }] },
      });
      T.rpc.plan_due_for = (a: any) => a.p_family_key === 'famP' ? { index: 0, dueDate: TODAY, amount: 500 } : null;
      T.fetch = (url: string) => url.endsWith('/payment_intents') ? { id: 'pi_P1', status: 'succeeded' } : {};
    `);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(charges(r), ['cus_P $500'], 'the parent-built plan was not charged');
    const rec = r.rpcs.filter(x => x.name === 'record_autopay_charge');
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].args.p_amount, 500);
    assert.strictEqual(rec[0].args.p_plan_id, 'plan_p');
});

test('TED-055: a declined office-plan instalment is kept pending, flagged, and retried — never dropped', () => {
    const scenario = (night) => BASE + `
      const inst1: any = { n: 1, amount: 500, dueDate: TODAY, status: 'pending' };
      const plan: any = { id: 'plan_o', installments: [inst1, { n: 2, amount: 500, dueDate: '2099-01-01', status: 'pending' }], autopay: true, total: 1000, source: 'office' };
      ${night === 2 ? `Object.assign(inst1, { failReason: 'card_declined', attempts: 1 }); plan.collectionBlocked = { reason: 'declined', attempts: 1, nextRetryAt: TODAY };` : ''}
      T.rpc.camp_families_object = () => ({
        famO: { name: 'Office plan', camperIds: ['B'], cardOnFile: true, stripeCustomerId: 'cus_O', charges: [{ amount: 1000 }], plans: [plan] },
      });
      T.fetch = (url: string) => url.endsWith('/payment_intents')
        ? (${night === 1} ? { error: { message: 'Your card was declined.', code: 'card_declined' } } : { id: 'pi_O2', status: 'succeeded' })
        : {};
    `;
    // Night 1: declined.
    const n1 = runEdge('charge-due-installments', scenario(1));
    assert.strictEqual(n1.status, 200, JSON.stringify(n1.body));
    const writes = n1.rpcs.filter(x => x.name === 'record_autopay_installment');
    assert.strictEqual(writes.length, 1);
    assert.notStrictEqual(writes[0].args.p_patch.status, 'failed', 'the declined instalment was dropped as failed');
    assert.strictEqual(writes[0].args.p_patch.status, undefined, 'the instalment must stay pending');
    assert.match(String(writes[0].args.p_patch.failReason), /declined/i);
    const flags = n1.rpcs.filter(x => x.name === 'flag_plan_collection');
    assert.strictEqual(flags.length, 1, 'the office was not told');
    assert.strictEqual(flags[0].args.p_reason, 'declined');
    assert.strictEqual(flags[0].args.p_plan_id, 'plan_o');
    // Night 2 (the retry date): charged again, and the flag cleared.
    const n2 = runEdge('charge-due-installments', scenario(2));
    assert.deepStrictEqual(charges(n2), ['cus_O $500'], 'the declined instalment was not retried');
    const paid = n2.rpcs.filter(x => x.name === 'record_autopay_installment')[0];
    assert.strictEqual(paid.args.p_patch.status, 'paid');
    assert.ok(n2.rpcs.some(x => x.name === 'flag_plan_collection' && x.args.p_reason == null), 'the flag was not cleared after collecting');
});

test('TED-055: before the retry date, a flagged office plan is left alone (no charge every night)', () => {
    const r = runEdge('charge-due-installments', BASE + `
      T.rpc.camp_families_object = () => ({
        famO: { name: 'Office plan', camperIds: ['B'], cardOnFile: true, stripeCustomerId: 'cus_O', charges: [{ amount: 1000 }],
                plans: [{ id: 'plan_o', installments: [{ n: 1, amount: 500, dueDate: TODAY, status: 'pending', failReason: 'declined', attempts: 1 }],
                          autopay: true, collectionBlocked: { reason: 'declined', attempts: 1, nextRetryAt: '2099-01-01' } }] },
      });
      T.fetch = () => ({ id: 'pi_x', status: 'succeeded' });
    `);
    assert.deepStrictEqual(charges(r), [], 'a flagged plan was charged before its retry date');
});
