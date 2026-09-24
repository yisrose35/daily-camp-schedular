// =============================================================================
// ach_on_its_way.test.js — TED-144. A family paying by bank.
//
// Iron's default method is a bank account. The office presses Charge Card for
// the $1,000 owed; the bank debit starts and is "processing" for a few
// business days. Before: Billing said "✕ Payment status: processing" (it looked
// like a failure), the balance still read $1,000, and pressing Charge Card
// again — on another computer, or the next day — started a SECOND $1,000
// debit. The only guard was a note in the first computer's own browser.
//
// Now a debit on its way is shown as on its way, taken off what is offered,
// and no second charge starts while it is there: Billing refuses, stripe-charge
// asks Stripe and refuses (so another computer cannot), the nightly autopay
// waits, and a late "processing" event never turns a paid row back to pending.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runEdge } = require('./edge_harness');

// ── stripe-charge: Stripe is asked ──────────────────────────────────────────
function office(list, extra) {
    return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }];
T.rpc.camp_families_object = () => ({ iron: { name: 'Iron', stripeCustomerId: 'cus_I' } });
T.tables.__debits = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_bank', customer: 'cus_I' };
  if (url.includes('/payment_intents?customer=')) {
    ${list === 'down' ? "return { __status: 503, error: { message: 'Stripe is unavailable' } };" : ''}
    const all = ${JSON.stringify(list === 'down' ? [] : list)};
    // Stripe filters by customer itself
    const cus = new URL(url).searchParams.get('customer');
    return { object: 'list', data: all.filter((p: any) => p.customer === cus), has_more: false };
  }
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    T.tables.__debits.push(Number(new URLSearchParams(init.body).get('amount')));
    return { id: 'pi_' + (T.tables.__debits.length + 1), status: 'processing', payment_method_types: ['us_bank_account'] };
  }
  return {};
};
${extra || ''}`;
}
const press = (key) => `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_I', paymentMethodId: 'pm_bank', amount: 1000, metadata: { familyKey: 'iron' }, idempotencyKey: '${key}' } };`;
const DEBIT1 = { id: 'pi_1', customer: 'cus_I', status: 'processing', amount: 100000, created: Math.floor(Date.parse('2026-09-24T14:00:00Z') / 1000),
    payment_method_types: ['us_bank_account'], metadata: { campId: 'camp1', familyKey: 'iron' } };

test('TED-144: a second Charge Card from ANOTHER computer while the first debit is processing starts nothing', () => {
    const r = runEdge('stripe-charge', office([DEBIT1]) + press('chg_iron_computerB'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.onItsWay, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.paymentIntentId, 'pi_1');
    assert.match(r.body.error, /A \$1000\.00 bank debit for this family, started 2026-09-24, is still on its way — bank debits take a few business days\. Nothing more was charged/);
    assert.deepStrictEqual(r.tables.__debits, [], 'a second debit was started');
});

test('TED-144: with nothing on its way the charge goes ahead as before (and comes back "processing")', () => {
    const r = runEdge('stripe-charge', office([]) + press('chg_iron_1'));
    assert.deepStrictEqual(r.tables.__debits, [100000]);
    assert.strictEqual(r.body.status, 'processing');
});

test('TED-144: a canteen top-up, a photo purchase or another camp\'s payment still processing does not block the bill', () => {
    const other = [
        { ...DEBIT1, id: 'pi_c', metadata: { campId: 'camp1', source: 'campistry-canteen-deposit' } },
        { ...DEBIT1, id: 'pi_p', metadata: { campId: 'camp1', source: 'campistry-link-photo-purchase' } },
        { ...DEBIT1, id: 'pi_x', metadata: { campId: 'camp2' } },
        { ...DEBIT1, id: 'pi_s', status: 'succeeded' },
    ];
    const r = runEdge('stripe-charge', office(other) + press('chg_iron_2'));
    assert.deepStrictEqual(r.tables.__debits, [100000], JSON.stringify(r.body));
});

test('TED-144: an autopay instalment still processing blocks an office charge too', () => {
    const r = runEdge('stripe-charge', office([{ ...DEBIT1, metadata: { campId: 'camp1', source: 'autopay', familyKey: 'iron' } }]) + press('chg_iron_3'));
    assert.strictEqual(r.body.onItsWay, true);
    assert.deepStrictEqual(r.tables.__debits, []);
});

test('TED-144: when Stripe cannot be asked, nothing is charged — and it says so', () => {
    const r = runEdge('stripe-charge', office('down') + press('chg_iron_4'));
    assert.strictEqual(r.body.notCharged, true, JSON.stringify(r.body));
    assert.match(r.body.error, /nothing was charged/);
    assert.deepStrictEqual(r.tables.__debits, []);
});

// ── Billing: the office's page ──────────────────────────────────────────────
const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
function billing(finPayments, answers, withGold) {
    const store = {}, sent = [], toasts = [], modals = [];
    const ctx = {
        families: Object.assign({ iron: { name: 'Iron', stripeCustomerId: 'cus_I', stripePaymentMethodId: 'pm_bank', cardOnFile: true } },
            withGold ? { gold: { name: 'Gold', stripeCustomerId: 'cus_G', cardOnFile: true } } : {}),
        finPayments, curPage: 'billing', setTimeout: (f) => f(),
        buildFamilyLedgers: () => { const o = {}; Object.keys(ctx.families).forEach(k => { o[k] = { balance: 1000, family: ctx.families[k] }; }); return o; },
        _famChargeable: () => true, _payFamilyByName: () => null,
        toast: (t, k) => toasts.push([t, k]), save: () => {}, renderBilling: () => {}, renderFamilyDetailPage: () => {},
        showModal: (title, html, ok) => modals.push({ title, html, ok }), closeModal: () => {},
        _postPaymentEntry: () => true, fm: (n) => '$' + Number(n).toFixed(2), esc: (s) => String(s),
        getCampId: () => 'camp1', confirmDialog: async () => true,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        window: { confirm: () => false },
        callEdgeFunctionAuthed: async (fn, body) => {
            sent.push(body);
            const a = answers.shift();
            if (a && a.error) { const e = new Error(a.error); e.data = a; throw e; }
            return a;
        },
    };
    const names = ['chargeStoredCard', 'batchCharge', '_familyOnItsWay', '_familyDisputed', '_famDisputeHeld', '_onItsWayWords', '_recordOnItsWay', '_methodTypeCharged',
        '_pendingChargeStoreKey', '_pendingChargeAll', '_pendingChargeGet', '_pendingChargeSet', '_pendingChargeClear'];
    const fns = new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { chargeStoredCard, batchCharge };')(...Object.values(ctx));
    return { ...fns, sent, toasts, modals, finPayments,
        setDispute: (fk) => { ctx.families[fk].plans = [{ id: 'p1', autopay: true, collectionBlocked: { reason: 'chargeback', disputeIds: ['dp_1'] } }]; },
        // TED-200: the family's own pause — no plan, or a plan not on autopay
        setFamilyDispute: (fk, plans) => { ctx.families[fk].disputeHold = { disputeIds: ['dp_h'], lostIds: [] }; if (plans) ctx.families[fk].plans = plans; } };
}
const pendingRow = () => ({ id: 'pi_pi_1', family: 'Iron', familyKey: 'iron', amount: 1000, date: '2026-09-24',
    stripePaymentIntentId: 'pi_1', status: 'pending', timestamp: Date.now() - 3600000 });

test('TED-144: computer A — the debit starts: "on its way", not a red failure; a second press charges nothing', async () => {
    const b = billing([], [{ paymentIntentId: 'pi_1', status: 'processing', amount: 1000 }]);
    const r1 = await b.chargeStoredCard('iron', 1000, 'Camp payment');
    assert.strictEqual(r1.pending, true);
    assert.ok(!b.toasts.some(([t, k]) => k === 'error'), 'shown as a failure: ' + JSON.stringify(b.toasts));
    assert.match(b.toasts[b.toasts.length - 1][0], /bank debit has started for Iron — it is on its way\. Bank debits take a few business days/);
    assert.strictEqual(b.finPayments.length, 1);
    assert.strictEqual(b.finPayments[0].id, 'pi_pi_1', 'not under the id the webhook uses — two rows');
    assert.strictEqual(b.finPayments[0].status, 'pending');
    // pressed again: refused here, nothing sent
    const r2 = await b.chargeStoredCard('iron', 1000, 'Camp payment');
    assert.strictEqual(r2.onItsWay, true);
    assert.strictEqual(b.sent.length, 1, 'a second charge was sent');
    // Charge Card itself: the window says so and offers no amount
    b.chargeStoredCard('iron');
    const m = b.modals[b.modals.length - 1];
    assert.match(m.html, /A \$1000\.00 bank debit started 2026-09-24 is still on its way — bank debits take a few business days/);
    assert.ok(!/chargeAmt/.test(m.html), 'the window still offers a charge');
});

test('TED-144: computer B, the next day, with the webhook\'s pending row — refused before anything is sent', async () => {
    const b = billing([pendingRow()], []);
    const r = await b.chargeStoredCard('iron', 1000, 'Camp payment');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.onItsWay, true);
    assert.strictEqual(b.sent.length, 0);
});

test('TED-144: computer B before the webhook arrived — Stripe says so; shown as on its way, not "Charge failed"', async () => {
    const b = billing([], [{ onItsWay: true, paymentIntentId: 'pi_1', amount: 1000,
        error: 'A $1000.00 bank debit for this family, started 2026-09-24, is still on its way — bank debits take a few business days. Nothing more was charged; charge again only if that one fails.' }]);
    const r = await b.chargeStoredCard('iron', 1000, 'Camp payment');
    assert.strictEqual(r.onItsWay, true);
    assert.ok(!b.toasts.some(([t]) => /^Charge failed/.test(t)), JSON.stringify(b.toasts));
    assert.strictEqual(b.finPayments[0].stripePaymentIntentId, 'pi_1');
    assert.strictEqual(b.finPayments[0].status, 'pending');
});

test('TED-144: an old pending row (over a fortnight) or a failed one does not block', async () => {
    const old = { ...pendingRow(), timestamp: Date.now() - 20 * 86400000, date: '2026-08-01' };
    const failed = { ...pendingRow(), id: 'pi_pi_0', stripePaymentIntentId: 'pi_0', status: 'failed' };
    const b = billing([old, failed], [{ paymentIntentId: 'pi_2', status: 'succeeded', amount: 1000 }]);
    const r = await b.chargeStoredCard('iron', 1000, 'Camp payment');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(b.sent.length, 1);
});

test('TED-144: Batch charge leaves out a family with a debit on its way, and names it', async () => {
    const b = billing([pendingRow()], [{ paymentIntentId: 'pi_g', status: 'succeeded', amount: 1000 }], true);
    b.batchCharge();
    const m = b.modals[b.modals.length - 1];
    assert.ok(m, 'no batch window');
    assert.match(m.title, /1 Families/);
    assert.match(m.html, /Not charged: Iron — a bank debit is still on its way/);
    await m.ok();
    assert.deepStrictEqual(b.sent.map(x => x.customerId), ['cus_G'], 'Iron was charged again in the batch');
    // with only Iron owing, nothing is charged and it says why
    const solo = billing([pendingRow()], []);
    solo.batchCharge();
    assert.strictEqual(solo.modals.length, 0);
    assert.match(solo.toasts[0][0], /1 family has a bank debit still on its way/);
});

test('TED-195: Batch Charge and Charge Card leave out a family whose payment is disputed, and say so', async () => {
    const b = billing([], [{ paymentIntentId: 'pi_g', status: 'succeeded', amount: 1000 }], true);
    // Gold's payment is charged back: its plan carries the dispute pause (288)
    const fam = b.families || null;
    b.setDispute('gold');
    b.batchCharge();
    const m = b.modals[b.modals.length - 1];
    assert.match(m.title, /1 Families/);
    assert.match(m.html, /Not charged — a payment is disputed: Gold/);
    await m.ok();
    assert.deepStrictEqual(b.sent.map(x => x.customerId), ['cus_I'], 'the disputed family was charged in the batch');
    const r = await b.chargeStoredCard('gold', 1000, 'Camp payment');
    assert.strictEqual(r.disputed, true);
    assert.strictEqual(b.sent.length, 1, 'Charge Card charged a disputed family');
});

test('TED-200: a family paying by hand, or with no plan, whose payment is disputed is not charged by Batch Charge or Charge Card', async () => {
    for (const plans of [null, [{ id: 'p1', autopay: false, dueDates: ['2026-07-01'] }]]) {
        const b = billing([], [{ paymentIntentId: 'pi_i', status: 'succeeded', amount: 1000 }], true);
        b.setFamilyDispute('gold', plans);
        b.batchCharge();
        const m = b.modals[b.modals.length - 1];
        assert.match(m.html, /Not charged — a payment is disputed: Gold/);
        await m.ok();
        assert.deepStrictEqual(b.sent.map(x => x.customerId), ['cus_I'], 'the disputed family was charged in the batch');
        const r = await b.chargeStoredCard('gold', 1000, 'Camp payment');
        assert.strictEqual(r.disputed, true);
        assert.strictEqual(b.sent.length, 1, 'Charge Card charged a disputed family');
    }
});

// ── the nightly autopay waits ───────────────────────────────────────────────
const TODAY = new Date().toISOString().split('T')[0];
function night(payments, planHold) {
    const plan = { id: 'plan_i', dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false,
        ...(planHold ? { pendingCharge: planHold } : {}) };
    return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron', STRIPE_SECRET_KEY: 'sk_test' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => ${JSON.stringify(payments)};
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_autopay_charge = () => ({ success: true, balance: 500 });
T.rpc.flag_plan_collection = () => ({ success: true });
T.rpc.hold_autopay_charge = () => ({ success: true });
T.rpc.camp_families_object = () => ({ iron: { name: 'Iron', camperIds: ['Avi'], cardOnFile: true, stripeCustomerId: 'cus_I', charges: [{ amount: 1000 }], plans: [${JSON.stringify(plan)}] } });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '${TODAY}', amount: 500 });
T.tables.__debits = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_intents/pi_auto')) return { id: 'pi_auto', status: 'processing' };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) { T.tables.__debits.push(url); return { id: 'pi_new', status: 'succeeded' }; }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
}

test('TED-144: autopay does not charge a family whose office bank debit is still on its way', () => {
    const r = runEdge('charge-due-installments', night([pendingRow()]));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.tables.__debits, [], 'autopay debited the same bill again');
    assert.ok(r.body.details.some(d => d.result === 'waiting_for_office_bank_debit' && d.paymentIntentId === 'pi_1'), JSON.stringify(r.body.details));
    // and nothing was marked "covered" by money that has not arrived
    assert.ok(!r.rpcs.some(c => c.name === 'record_autopay_charge'), 'an instalment was marked paid');
});

test('TED-144: once it settles (or with none on its way) autopay charges as before', () => {
    const r = runEdge('charge-due-installments', night([{ ...pendingRow(), status: 'failed' }]));
    assert.strictEqual(r.tables.__debits.length, 1, JSON.stringify(r.body.details));
});

test('TED-144: autopay\'s OWN debit on its way is still handled by its own hold, not this rule', () => {
    const own = { ...pendingRow(), id: 'pi_pi_auto', stripePaymentIntentId: 'pi_auto', amount: 500 };
    const r = runEdge('charge-due-installments', night([own], { paymentIntentId: 'pi_auto', index: 0, dueDate: TODAY, amount: 500, since: TODAY, processor: 'stripe' }));
    assert.ok(!r.body.details.some(d => d.result === 'waiting_for_office_bank_debit'), JSON.stringify(r.body.details));
    assert.ok(r.body.details.some(d => d.result === 'waiting_for_bank_debit'), 'its own hold (TED-064) did not answer: ' + JSON.stringify(r.body.details));
    assert.deepStrictEqual(r.tables.__debits, []);
});

// ── the webhook: a late "processing" never un-pays a payment ────────────────
const crypto = require('node:crypto');
function hook(nowStatus) {
    const event = { id: 'evt_late', type: 'payment_intent.processing', data: { object: { id: 'pi_1', amount: 100000,
        payment_method_types: ['us_bank_account'], metadata: { campId: 'camp1', familyKey: 'iron', familyName: 'Iron' } } } };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.fetch = (url: string) => url.includes('/payment_intents/pi_1') ? ${nowStatus ? `{ id: 'pi_1', status: '${nowStatus}' }` : `{ __status: 503, error: { message: 'unavailable' } }`} : {};
T.rpc.append_camp_payment = () => ({ success: true });
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
}
const appended = (r) => r.rpcs.filter(c => c.name === 'append_camp_payment');

test('TED-144: a "processing" event arriving AFTER "succeeded" leaves the payment paid', () => {
    const r = hook('succeeded');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(appended(r).length, 0, 'the paid row was patched back to pending');
});

test('TED-144: a "processing" event in its place is recorded as on its way, as before', () => {
    const r = hook('processing');
    const a = appended(r);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].args.p_payment.status, 'pending');
    assert.strictEqual(a[0].args.p_update_on_match.status, 'pending');
});

test('TED-154: a "processing" event arriving after the bank RETURNED the debit does not make it "on its way" again', () => {
    for (const now of ['requires_payment_method', 'canceled', 'succeeded']) {
        const r = hook(now);
        assert.strictEqual(r.status, 200, now);
        assert.strictEqual(appended(r).length, 0, 'a ' + now + ' debit was turned back into "on its way"');
    }
});

test('TED-154: Stripe cannot be asked — 500, so the event comes again (never recorded on a guess)', () => {
    const r = hook(null);
    assert.strictEqual(r.status, 500);
    assert.strictEqual(appended(r).length, 0);
});
