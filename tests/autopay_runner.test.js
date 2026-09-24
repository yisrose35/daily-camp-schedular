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

// ── TED-064: a bank debit that is still clearing ─────────────────────────────
function achNight(plan, piAnswer, heldStatus) {
    return BASE + `
      const plan: any = ${JSON.stringify(plan)};
      T.rpc.camp_families_object = () => ({
        famA: { name: 'Bank family', camperIds: ['C'], cardOnFile: true, stripeCustomerId: 'cus_A', charges: [{ amount: 1000 }], plans: [plan] },
      });
      T.rpc.plan_due_for = () => ({ index: 0, dueDate: TODAY, amount: 500 });
      T.rpc.hold_autopay_charge = () => ({ success: true });
      T.fetch = (url: string, init: any) => {
        if (init.method === 'POST' && url.endsWith('/payment_intents')) return ${JSON.stringify(piAnswer)};
        if (url.includes('/payment_intents/pi_ach')) return { id: 'pi_ach', status: '${heldStatus || 'processing'}', last_payment_error: { message: 'Insufficient funds' } };
        return {};
      };`;
}
const newCharges = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));
const LEDGER_PLAN = { id: 'plan_a', dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false };

test('TED-064: night 1 — a debit that comes back "processing" is held on the plan, not recorded as paid', () => {
    const r = runEdge('charge-due-installments', achNight(LEDGER_PLAN, { id: 'pi_ach', status: 'processing' }));
    assert.strictEqual(newCharges(r).length, 1);
    assert.ok(newCharges(r)[0].headers['Idempotency-Key'], 'no Idempotency-Key on the autopay charge');
    const hold = r.rpcs.find(x => x.name === 'hold_autopay_charge');
    assert.ok(hold, 'the debit in flight was not held');
    assert.strictEqual(hold.args.p_hold.paymentIntentId, 'pi_ach');
    assert.strictEqual(hold.args.p_hold.index, 0);
    assert.ok(!r.rpcs.some(x => x.name === 'record_autopay_charge'), 'a debit that has not landed was recorded');
});

test('TED-064: night 2 — while the debit is still clearing, nothing new is charged', () => {
    const held = Object.assign({}, LEDGER_PLAN, { pendingCharge: { paymentIntentId: 'pi_ach', index: 0, dueDate: TODAY, amount: 500, since: TODAY } });
    const r = runEdge('charge-due-installments', achNight(held, { id: 'pi_NEW', status: 'processing' }, 'processing'));
    assert.strictEqual(newCharges(r).length, 0, 'the family was debited again while the first debit was clearing');
    assert.ok(r.rpcs.every(x => x.name !== 'record_autopay_charge'));
});

test('TED-064: night 3 — the debit cleared: it is recorded as that instalment, the hold released, nothing new charged', () => {
    const held = Object.assign({}, LEDGER_PLAN, { pendingCharge: { paymentIntentId: 'pi_ach', index: 0, dueDate: TODAY, amount: 500, since: TODAY } });
    const r = runEdge('charge-due-installments', achNight(held, { id: 'pi_NEW', status: 'succeeded' }, 'succeeded'));
    assert.strictEqual(newCharges(r).length, 0);
    const rec = r.rpcs.find(x => x.name === 'record_autopay_charge');
    assert.ok(rec, 'the cleared debit was not recorded');
    assert.strictEqual(rec.args.p_amount, 500);
    assert.strictEqual(rec.args.p_index, 0);
    assert.strictEqual(rec.args.p_dedupe_key, 'pi_ach');
    assert.ok(r.rpcs.some(x => x.name === 'hold_autopay_charge' && x.args.p_hold == null), 'the hold was not released');
});

test('TED-064: a debit that failed while clearing goes down the decline path (office told), hold released', () => {
    const held = Object.assign({}, LEDGER_PLAN, { pendingCharge: { paymentIntentId: 'pi_ach', index: 0, dueDate: TODAY, amount: 500, since: TODAY } });
    const r = runEdge('charge-due-installments', achNight(held, { id: 'pi_NEW', status: 'succeeded' }, 'requires_payment_method'));
    assert.strictEqual(newCharges(r).length, 0);
    const rec = r.rpcs.find(x => x.name === 'record_autopay_charge');
    assert.strictEqual(rec.args.p_amount, 0);
    assert.match(rec.args.p_reason, /declined/);
    assert.ok(r.rpcs.some(x => x.name === 'flag_plan_collection' && x.args.p_reason === 'declined'));
    assert.ok(r.rpcs.some(x => x.name === 'hold_autopay_charge' && x.args.p_hold == null));
});

test('TED-064: an office-built installments[] plan holds a clearing debit too', () => {
    const plan = { id: 'plan_o2', autopay: true, installments: [{ n: 1, amount: 500, dueDate: TODAY, status: 'pending' }] };
    const n1 = runEdge('charge-due-installments', achNight(plan, { id: 'pi_ach', status: 'processing' }));
    assert.strictEqual(newCharges(n1).length, 1);
    assert.ok(n1.rpcs.some(x => x.name === 'hold_autopay_charge' && x.args.p_hold && x.args.p_hold.paymentIntentId === 'pi_ach'));
    const held = Object.assign({}, plan, { pendingCharge: { paymentIntentId: 'pi_ach', dueDate: TODAY, amount: 500, since: TODAY } });
    const n2 = runEdge('charge-due-installments', achNight(held, { id: 'pi_NEW', status: 'processing' }, 'processing'));
    assert.strictEqual(newCharges(n2).length, 0, 'debited again');
    const n3 = runEdge('charge-due-installments', achNight(held, { id: 'pi_NEW', status: 'processing' }, 'succeeded'));
    assert.strictEqual(newCharges(n3).length, 0);
    const paid = n3.rpcs.find(x => x.name === 'record_autopay_installment');
    assert.strictEqual(paid.args.p_patch.status, 'paid');
    assert.strictEqual(paid.args.p_dedupe_key, 'pi_ach');
});

// ── TED-073: the nightly retry for a counselor's tip that failed ─────────────
function tipNight(existingTransfer) {
    return BASE + `
      T.rpc.camp_families_object = () => ({});
      T.rpc.retry_failed_tip_transfers = () => [{ id: 'item1', cartId: 'cart1', staffName: 'Counselor Dina', staffAccountId: 'lsa-internal-uuid', tipCents: 2000, feeCents: 40 }];
      T.tables.link_tip_cart_items = [{ id: 'item1', cart_id: 'cart1', camp_id: 'camp1', staff_account_id: 'lsa-internal-uuid', staff_name: 'Counselor Dina',
          staff_role: 'counselor', stripe_account_id: 'acct_DINA', tip_cents: 2000, fee_cents: 40, processed_at: null, transfer_error: 'boom',
          parent_user_id: 'u-p', camper_name: 'Avi', person_id: 4 }];
      T.tables.link_tips = [];
      T.fetch = (url: string, init: any) => {
        if (init.method === 'GET' && url.includes('/transfers?')) return { data: ${existingTransfer ? `[{ id: 'tr_first', metadata: { cartItemId: 'item1' } }]` : '[]'} };
        if (init.method === 'POST' && url.endsWith('/transfers')) return { id: 'tr_retry' };
        return {};
      };`;
}
const transfersMade = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/transfers'));

test('TED-073: the tip retry pays the whole tip to the counselor\'s Stripe account, and records it', () => {
    const r = runEdge('charge-due-installments', tipNight(false));
    const t = transfersMade(r);
    assert.strictEqual(t.length, 1);
    const p = new URLSearchParams(t[0].body);
    assert.strictEqual(p.get('destination'), 'acct_DINA', 'sent to the internal record id, not the counselor\'s Stripe account');
    assert.strictEqual(p.get('amount'), '2000', 'the tip was cut by the fee a second time');
    assert.ok(t[0].headers['Idempotency-Key']);
    assert.ok(r.writes.some(w => w.table === 'link_tips' && w.op === 'insert'), 'the tip was not recorded for the counselor');
    assert.ok(r.rpcs.some(x => x.name === 'increment_staff_total_earned'));
    assert.ok(r.writes.some(w => w.table === 'link_tip_cart_items' && w.op === 'update' && w.payload.stripe_transfer_id === 'tr_retry'));
});

test('TED-073: if the first transfer actually went through, the retry pays nothing and only catches up', () => {
    const r = runEdge('charge-due-installments', tipNight(true));
    assert.strictEqual(transfersMade(r).length, 0, 'the counselor was paid twice');
    assert.ok(r.writes.some(w => w.table === 'link_tip_cart_items' && w.op === 'update' && w.payload.stripe_transfer_id === 'tr_first'));
});

// ── TED-079: a declined instalment on a plan with the office's own amounts ───
test('TED-079: a declined fixed-amount instalment is not skipped — the counter stays, the office is told', () => {
    const r = runEdge('charge-due-installments', BASE + `
      T.rpc.camp_families_object = () => ({
        famF: { name: 'Fixed plan', camperIds: ['D'], cardOnFile: true, stripeCustomerId: 'cus_F',
                plans: [{ id: 'plan_f', dueDates: [TODAY, '2099-07-01', '2099-08-01'], amounts: [1000, 200, 200], count: 3, nextIndex: 0, history: [], autopay: true }] },
      });
      T.rpc.plan_due_for = () => ({ index: 0, dueDate: TODAY, amount: 1000 });
      T.fetch = (url: string) => url.endsWith('/payment_intents') ? { error: { message: 'Your card was declined.' } } : {};
    `);
    assert.ok(!r.rpcs.some(x => x.name === 'record_autopay_charge'), 'the declined $1,000 instalment was recorded and skipped');
    const flag = r.rpcs.find(x => x.name === 'flag_plan_collection');
    assert.strictEqual(flag.args.p_reason, 'declined');
});

test('an even-split plan still records the decline and moves on (later payments absorb it)', () => {
    const r = runEdge('charge-due-installments', BASE + `
      T.rpc.camp_families_object = () => ({
        famE: { name: 'Even plan', camperIds: ['E'], cardOnFile: true, stripeCustomerId: 'cus_E',
                plans: [{ id: 'plan_e', dueDates: [TODAY, '2099-07-01'], count: 2, nextIndex: 0, history: [], autopay: true }] },
      });
      T.rpc.plan_due_for = () => ({ index: 0, dueDate: TODAY, amount: 500 });
      T.fetch = (url: string) => url.endsWith('/payment_intents') ? { error: { message: 'Your card was declined.' } } : {};
    `);
    const rec = r.rpcs.find(x => x.name === 'record_autopay_charge');
    assert.ok(rec);
    assert.strictEqual(rec.args.p_amount, 0);
});

// TED-084: the hold works for every shape of plan, and is never claimed when
// it did not save.
function shapeNight(famPlans, piAnswer, opts = {}) {
    return BASE + `
      T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: ${opts.processor ? `'${opts.processor}'` : 'null'} }];
      T.rpc.camp_families_object = () => ({
        famA: Object.assign({ name: 'Bank family', camperIds: ['C'], cardOnFile: true, stripeCustomerId: 'cus_A',
                              byopCustomerRef: 'tok_A', charges: [{ amount: 1000 }] }, ${JSON.stringify(famPlans)}),
      });
      T.rpc.plan_due_for = () => ({ index: 0, dueDate: TODAY, amount: 500 });
      T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
      T.rpc.hold_autopay_charge = () => (${JSON.stringify(opts.holdAnswer || { success: true })});
      T.fetch = (url: string, init: any) => {
        if (init.method === 'POST' && url.endsWith('/payment_intents')) return ${JSON.stringify(piAnswer)};
        if (url.includes('/payment_intents/pi_ach')) return { id: 'pi_ach', status: '${opts.heldStatus || 'processing'}' };
        return {};
      };`;
}
const LEGACY = { autopay: true, total: 1000, installments: [{ n: 1, amount: 500, dueDate: TODAY, status: 'pending' }, { n: 2, amount: 500, dueDate: '2099-01-01', status: 'pending' }] };
const results = r => (r.body.details || []).map(d => d.result);

test('TED-084: the old single plan (no id) holds its bank debit — by position #0', () => {
    const r = runEdge('charge-due-installments', shapeNight({ plan: LEGACY }, { id: 'pi_ach', status: 'processing' }));
    const hold = r.rpcs.find(x => x.name === 'hold_autopay_charge');
    assert.ok(hold, 'no hold was even asked for');
    assert.strictEqual(hold.args.p_plan_id, '#0');
    assert.deepStrictEqual(results(r), ['processing_held']);
});

test('TED-084: a plan in the list without an id holds by its position', () => {
    const r = runEdge('charge-due-installments', shapeNight({ plans: [{ id: 'p0', autopay: false, installments: [] }, LEGACY] }, { id: 'pi_ach', status: 'processing' }));
    assert.strictEqual(r.rpcs.find(x => x.name === 'hold_autopay_charge').args.p_plan_id, '#1');
});

test('TED-084: a hold that did not save is never reported as held — the office is told', () => {
    const r = runEdge('charge-due-installments', shapeNight({ plan: LEGACY }, { id: 'pi_ach', status: 'processing' },
        { holdAnswer: { success: false, error: 'plan_not_found' } }));
    assert.ok(!results(r).includes('processing_held'), 'reported processing_held: ' + JSON.stringify(results(r)));
    assert.ok(results(r).includes('processing_hold_failed'));
    const flag = r.rpcs.find(x => x.name === 'flag_plan_collection' && x.args.p_reason === 'bank_debit_unheld');
    assert.ok(flag, 'the office was not told');
    assert.strictEqual(flag.args.p_plan_id, '#0');
});

test('TED-084: night 2 — the old single plan\'s held debit is asked about, not debited again', () => {
    const held = Object.assign({}, LEGACY, { pendingCharge: { paymentIntentId: 'pi_ach', dueDate: TODAY, amount: 500, since: TODAY } });
    const r = runEdge('charge-due-installments', shapeNight({ plan: held }, { id: 'pi_NEW', status: 'processing' }));
    assert.strictEqual(newCharges(r).length, 0, 'debited again');
    assert.deepStrictEqual(results(r), ['waiting_for_bank_debit']);
});

test('TED-084: a camp that moved off Stripe still clears the Stripe debit it left in flight', () => {
    const held = Object.assign({}, LEDGER_PLAN, { pendingCharge: { paymentIntentId: 'pi_ach', index: 0, dueDate: TODAY, amount: 500, since: TODAY } });
    const r = runEdge('charge-due-installments', shapeNight({ plans: [held] }, { id: 'pi_NEW', status: 'succeeded' },
        { processor: 'cardknox', heldStatus: 'succeeded' }));
    assert.ok(r.rpcs.some(x => x.name === 'record_autopay_charge' && x.args.p_dedupe_key === 'pi_ach'), 'the cleared debit was never recorded: ' + JSON.stringify(results(r)));
    assert.strictEqual(r.fetches.filter(f => f.method === 'POST').length, 0, 'charged again');
});

test('TED-084: a debit still clearing after ten days is put in front of the office', () => {
    const since = new Date(Date.now() - 20 * 86400000).toISOString().split('T')[0];
    const held = Object.assign({}, LEDGER_PLAN, { pendingCharge: { paymentIntentId: 'pi_ach', index: 0, dueDate: since, amount: 500, since } });
    const r = runEdge('charge-due-installments', shapeNight({ plans: [held] }, { id: 'pi_NEW', status: 'processing' }));
    assert.strictEqual(newCharges(r).length, 0);
    assert.ok(r.rpcs.some(x => x.name === 'flag_plan_collection' && x.args.p_reason === 'bank_debit_stuck'));
});
