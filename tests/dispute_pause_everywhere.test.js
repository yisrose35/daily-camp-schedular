// =============================================================================
// dispute_pause_everywhere.test.js — TED-200/201/202/204: a family whose
// payment is disputed with their bank is not charged again — by autopay or
// from the office, whether or not they are on autopay, whichever processor.
// The real stripe-webhook, byop-dispute-webhook, charge-due-installments,
// stripe-charge and payments-charge, in the edge harness; the database side
// (the family's disputeHold, lost disputes, Resume) is pgtest 288.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

const calls = (r, name) => r.rpcs.filter(c => c.name === name).map(c => c.args);

// ── stripe-webhook ──────────────────────────────────────────────────────────
function deliver(events, extra) {
    const t = Math.floor(Date.now() / 1000);
    const reqs = events.map(ev => {
        const body = JSON.stringify(ev);
        const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
        return { headers: { 'stripe-signature': `t=${t},v1=${sig}` }, rawBody: body };
    });
    return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_x' };
T.fetch = (url: string) => {
  if (url.includes('/payment_intents/pi_hazel')) return { id: 'pi_hazel', metadata: { campId: 'camp1', familyKey: 'hazel' } };
  if (url.includes('/charges/ch_hazel')) return { id: 'ch_hazel', payment_intent: 'pi_hazel', metadata: {} };
  return {};
};
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'hazel' });
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'hazel', outcome: a.p_won ? 'won' : 'lost' });
${extra || ''}
Object.defineProperty(T, 'requests', { get: () => ${JSON.stringify(reqs)} });`);
}
const dispute = (type, status, id) => ({ id: 'evt_' + type + status + (id || ''), type, data: { object: {
    id: id || 'dp_1', charge: 'ch_hazel', payment_intent: 'pi_hazel', amount: 100000, status, reason: 'fraudulent' } } });

test('TED-202: a lost dispute is marked lost (Resume may then lift it); a won one is not', () => {
    const lost = deliver([dispute('charge.dispute.created', 'needs_response'), dispute('charge.dispute.closed', 'lost')]);
    assert.deepStrictEqual(lost.responses.map(x => x.status), [200, 200]);
    assert.deepStrictEqual(calls(lost, 'note_dispute_lost'), [{ p_camp_id: 'camp1', p_family_key: 'hazel', p_dispute_id: 'dp_1' }]);
    const won = deliver([dispute('charge.dispute.created', 'needs_response'), dispute('charge.dispute.closed', 'won')]);
    assert.strictEqual(calls(won, 'note_dispute_lost').length, 0);
    // marking it lost fails: 500, so Stripe sends it again
    const err = deliver([dispute('charge.dispute.closed', 'lost')], `T.rpc.note_dispute_lost = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(err.status, 500);
});

test('TED-204 (N7): a late "updated" or "funds_withdrawn" carrying won or lost takes nothing and pauses nothing', () => {
    const r = deliver([
        dispute('charge.dispute.updated', 'won'),
        dispute('charge.dispute.funds_withdrawn', 'won'),
        dispute('charge.dispute.updated', 'lost'),
    ]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200, 200]);
    assert.strictEqual(calls(r, 'record_chargeback').length, 0, 'a decided dispute was posted as money taken');
    assert.strictEqual(calls(r, 'hold_autopay_for_dispute').length, 0, 'a decided dispute paused the family');
    // an open status on the same messages still does
    const open = deliver([dispute('charge.dispute.updated', 'under_review')]);
    assert.strictEqual(calls(open, 'hold_autopay_for_dispute').length, 1);
});

// ── byop-dispute-webhook (Cardknox / Banquest) ──────────────────────────────
function byop(body, extra) {
    return runEdge('byop-dispute-webhook', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek' };
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'hazel' });
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'hazel', outcome: a.p_won ? 'won' : 'lost' });
${extra || ''}
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=banquest&camp=camp1', headers: { 'x-webhook-secret': 'sek', 'content-type': 'application/json' }, rawBody: ${JSON.stringify(JSON.stringify(body))} };`);
}

test('TED-200: a Banquest/Cardknox dispute pauses the family\'s card too; won lifts it; lost marks it lost', () => {
    const opened = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'open', amount: 500, reason: 'fraud' });
    assert.strictEqual(opened.status, 200, JSON.stringify(opened.body));
    assert.deepStrictEqual(calls(opened, 'hold_autopay_for_dispute').map(h => [h.p_family_key, h.p_dispute_id, h.p_hold]), [['hazel', 'cb_9', true]]);
    const won = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'won' });
    assert.deepStrictEqual(calls(won, 'hold_autopay_for_dispute').map(h => h.p_hold), [false]);
    const lost = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'lost' });
    assert.deepStrictEqual(calls(lost, 'note_dispute_lost').map(h => h.p_dispute_id), ['cb_9']);
    assert.strictEqual(calls(lost, 'hold_autopay_for_dispute').length, 0);
    // the pause cannot be saved: 500, so the processor sends it again
    const err = byop({ chargeback_id: 'cb_9', reference_number: 'ref_1', status: 'open' },
        `T.rpc.hold_autopay_for_dispute = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(err.status, 500);
});

// ── the nightly runner ──────────────────────────────────────────────────────
test('TED-200/201: autopay does not charge a family paused on the FAMILY — a plan added or switched on mid-dispute — while a control family is charged', () => {
    const plan = (extra) => [{ id: 'p1', autopay: true, dueDates: ['2020-01-01'], count: 1, nextIndex: 0, history: [], ...extra }];
    const r = runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_autopay_charge = () => ({ success: true, balance: 0 });
T.rpc.hold_autopay_charge = () => ({ success: true });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '2020-01-01', amount: 250 });
T.rpc.camp_families_object = () => ({
  hazel: { name: 'Hazel', cardOnFile: true, stripeCustomerId: 'cus_hazel', stripePaymentMethodId: 'pm_1', entries: [{ id: 'e', kind: 'charge', amount: 250 }],
           disputeHold: { disputeIds: ['dp_h'], lostIds: [] }, plans: ${JSON.stringify(plan({}))} },
  ash: { name: 'Ash', cardOnFile: true, stripeCustomerId: 'cus_ash', stripePaymentMethodId: 'pm_3', entries: [{ id: 'e', kind: 'charge', amount: 500 }],
         disputeHold: { disputeIds: ['dp_a'] }, plan: { autopay: true, installments: [{ dueDate: '2020-01-01', amount: 500, status: 'pending' }] } },
  olive: { name: 'Olive', cardOnFile: true, stripeCustomerId: 'cus_olive', stripePaymentMethodId: 'pm_2', entries: [{ id: 'e', kind: 'charge', amount: 250 }], plans: ${JSON.stringify(plan({}))} } });
T.tables.__charged = [];
T.fetch = (url: string, init: any) => { if (init.method === 'POST' && url.endsWith('/payment_intents')) { T.tables.__charged.push(new URLSearchParams(init.body).get('customer')); return { id: 'pi_n', status: 'succeeded', amount: 25000 }; } return {}; };
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`);
    assert.deepStrictEqual(r.tables.__charged, ['cus_olive'], 'charged: ' + JSON.stringify(r.tables.__charged) + ' ' + JSON.stringify(r.body).slice(0, 300));
    const held = JSON.stringify(r.body).match(/held_for_dispute/g) || [];
    assert.strictEqual(held.length, 2, JSON.stringify(r.body).slice(0, 400));
});

// ── the office's Charge Card on the server ──────────────────────────────────
const FAMS = `({ hazel: { name: 'Hazel', stripeCustomerId: 'cus_H', byopCustomerRef: 'tok_h', disputeHold: { disputeIds: ['dp_h'], lostIds: [] },
                 plans: [{ id: 'p1', autopay: false, dueDates: ['2026-07-01'] }] },
                fern: { name: 'Fern', stripeCustomerId: 'cus_F', byopCustomerRef: 'tok_f' } })`;

function stripeCharge(customerId, extra) {
    return runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }];
T.rpc.camp_families_object = () => ${FAMS};
${extra || ''}
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_1', customer: '${customerId}' };
  if (url.includes('/payment_intents?customer=')) return { object: 'list', data: [], has_more: false };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) return { id: 'pi_new', status: 'succeeded', amount: 100000 };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: '${customerId}', paymentMethodId: 'pm_1', amount: 1000, idempotencyKey: 'k_${customerId}' } };`);
}
const piPosts = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));

test('TED-200: stripe-charge refuses the card of a family in dispute — hand-paying, on the server, before Stripe is asked', () => {
    const r = stripeCharge('cus_H');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.disputed, true);
    assert.match(r.body.error, /Hazel disputed a payment with their bank/);
    assert.strictEqual(piPosts(r).length, 0, 'Stripe was asked to charge a disputed card');
    // the control: a family not in dispute is charged
    const ok = stripeCharge('cus_F');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(piPosts(ok).length, 1);
});

test('TED-200: a paused plan (an older pause, on the plan only) is refused too; a family read error charges nothing', () => {
    const r = stripeCharge('cus_F', `T.rpc.camp_families_object = () => ({ fern: { name: 'Fern', stripeCustomerId: 'cus_F',
        plans: [{ id: 'p', collectionBlocked: { reason: 'chargeback', disputeIds: ['dp'] } }] } });`);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(piPosts(r).length, 0);
});

function byopCharge(ref) {
    return runEdge('payments-charge', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc.camp_families_object = () => ${FAMS};
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck_key' } });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.fetch = (url: string) => (url.includes('cardknox') ? 'xResult=A&xRefNum=9001&xStatus=Approved' : {});
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: '${ref}', amount: 40, idempotencyKey: 'k_${ref}' } };`);
}

test('TED-200: payments-charge (Cardknox/Banquest) refuses a family in dispute; the control is charged', () => {
    const r = byopCharge('tok_h');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.fetches.filter(f => /cardknox/.test(f.url)).length, 0, 'the gateway was asked to charge a disputed card');
    const ok = byopCharge('tok_f');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.fetches.filter(f => /cardknox/.test(f.url)).length, 1);
});

// ── canteen auto-reload (TED-205) ───────────────────────────────────────────
function reloadNight(families) {
    return runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { sessions: [{ name: 'Summer', startDate: '2000-01-01', endDate: '2999-12-31' }] } }];
const ar = (cus: string) => ({ enabled: true, cardOnFile: true, stripeCustomerId: cus, thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 25 });
T.rpc.canteen_autoreload_accounts = () => [
  { camp_id: 'camp1', resolvable: true, person_id: 1, camper_name: 'Bea Gold', account: { balance: 0, autoReload: ar('cus_gold') } },
  { camp_id: 'camp1', resolvable: true, person_id: 2, camper_name: 'Dan Gold #2', account: { balance: 0, autoReload: ar('cus_grandma') } },
  { camp_id: 'camp1', resolvable: true, person_id: 3, camper_name: 'Cy', account: { balance: 0, autoReload: ar('cus_cy') } },
  { camp_id: 'camp1', resolvable: true, person_id: 4, camper_name: 'Eli Cousin', account: { balance: 0, autoReload: ar('cus_gold') } }];
T.rpc.camp_families_object = ${families};
// the family of each child, by camper number
T.rpc.camp_family_key_for_person = (a: any) => (({ 1: 'gold', 2: 'gold', 3: 'cy' } as any)[a.p_person_id] ?? null);
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.tables.__charged = [];
T.fetch = (url: string, init: any) => { if (init.method === 'POST' && url.endsWith('/payment_intents')) { T.tables.__charged.push(new URLSearchParams(init.body).get('customer')); return { id: 'pi_r', status: 'succeeded' }; } return {}; };
T.request = { headers: { 'x-cron-secret': 'c' }, body: {} };`);
}

test('TED-205: auto-reload does not charge the card of a family whose payment is disputed, nor its children\'s other cards; a control child is charged', () => {
    const r = reloadNight(`() => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_gold', camperIds: ['Bea Gold', 'Dan Gold #2'],
        disputeHold: { disputeIds: ['dp_gold'], lostIds: [] } }, cy: { name: 'Cy', stripeCustomerId: 'cus_cy', camperIds: ['Cy'] } })`);
    assert.deepStrictEqual(r.tables.__charged, ['cus_cy'], 'charged: ' + JSON.stringify(r.tables.__charged));
    // Bea and Dan (the family's children, whichever card) and Eli (another family, the disputed card)
    assert.strictEqual((JSON.stringify(r.body).match(/held_for_dispute/g) || []).length, 3, JSON.stringify(r.body).slice(0, 500));
    // with no dispute, all three are charged
    const none = reloadNight(`() => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_gold', camperIds: ['Bea Gold', 'Dan Gold #2'] } })`);
    assert.deepStrictEqual(none.tables.__charged.sort(), ['cus_cy', 'cus_gold', 'cus_gold', 'cus_grandma']);
});

test('TED-205: when the families cannot be read, nothing is reloaded this run', () => {
    const r = reloadNight(`() => { throw new Error('statement timeout'); }`);
    assert.deepStrictEqual(r.tables.__charged, []);
    assert.match(JSON.stringify(r.body), /skipped_family_read_failed/);
});

test('TED-205: a disputed canteen top-up switches that child\'s auto-reload off (500 if it cannot, so Stripe sends it again)', () => {
    const ev = { id: 'evt_cd', type: 'charge.dispute.created', data: { object: { id: 'dp_avi', charge: 'ch_avi', payment_intent: 'pi_avi', amount: 2000, status: 'needs_response', reason: 'fraudulent' } } };
    const canteen = `
T.fetch = (url: string) => {
  if (url.includes('/payment_intents/pi_avi')) return { id: 'pi_avi', metadata: { campId: 'camp1', camperName: 'Avi', source: 'campistry-canteen-deposit' } };
  if (url.includes('/charges/ch_avi')) return { id: 'ch_avi', payment_intent: 'pi_avi', metadata: {} };
  return {};
};
T.rpc.record_canteen_stripe_reversal = () => ({ success: true, amount: 20 });`;
    const ok = deliver([ev], canteen);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(calls(ok, 'pause_canteen_autoreload_for_dispute'), [{ p_camp_id: 'camp1', p_payment_intent_id: 'pi_avi', p_dispute_id: 'dp_avi' }]);
    const bad = deliver([ev], canteen + `\nT.rpc.pause_canteen_autoreload_for_dispute = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(bad.status, 500);
});

test('TED-206: a database error while posting a Cardknox/Banquest chargeback (or its close) answers 500, so it is sent again; an answer does not', () => {
    const post = byop({ chargeback_id: 'cb_1', reference_number: 'ref_1', status: 'open' }, `T.rpc.record_chargeback = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(post.status, 500);
    assert.strictEqual(calls(post, 'hold_autopay_for_dispute').length, 0);
    const close = byop({ chargeback_id: 'cb_1', reference_number: 'ref_1', status: 'won' }, `T.rpc.resolve_chargeback = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(close.status, 500);
    const answer = byop({ chargeback_id: 'cb_1', reference_number: 'ref_1', status: 'open' }, `T.rpc.record_chargeback = () => ({ success: false, error: 'payment_not_found' });`);
    assert.strictEqual(answer.status, 200);
    // no secret configured: refused, and says what to set
    const unset = runEdge('byop-dispute-webhook', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=banquest', headers: { 'content-type': 'application/json' }, rawBody: '{}' };`);
    assert.strictEqual(unset.status, 503);
});

test('TED-206: a processor that cannot send a header passes the secret as &key= on the URL; a wrong key is refused', () => {
    const run = (q, hdr) => runEdge('byop-dispute-webhook', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek' };
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'hazel' });
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=banquest&camp=camp1${q}', headers: ${JSON.stringify(Object.assign({ 'content-type': 'application/json' }, hdr || {}))},
  rawBody: ${JSON.stringify(JSON.stringify({ chargeback_id: 'cb_k', reference_number: 'ref_1', status: 'open' }))} };`);
    const ok = run('&key=sek');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(calls(ok, 'record_chargeback').length, 1);
    for (const bad of [run('&key=nope'), run(''), run('&key=sek', { 'x-webhook-secret': 'wrong' })]) {
        assert.strictEqual(bad.status, 401);
        assert.strictEqual(calls(bad, 'record_chargeback').length, 0);
    }
});

test('TED-208 (P10): stripe-charge charges nothing when it cannot read the families the second time', () => {
    const r = stripeCharge('cus_F', `let n = 0; T.rpc.camp_families_object = () => { n++; if (n > 1) throw new Error('statement timeout'); return ${FAMS}; };`);
    assert.strictEqual(r.status, 503, JSON.stringify(r.body));
    assert.strictEqual(piPosts(r).length, 0);
});

// ── the Me page's Resume window (TED-202/208) ───────────────────────────────
const fsx = require('node:fs');
const ME = fsx.readFileSync(require('node:path').join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cutFn(name) {
    const m = ME.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));
    if (!m) throw new Error('not found: ' + name);
    return m[0];
}
function resumePage(fam, answers, yes) {
    const sent = [], dialogs = [], toasts = [];
    const client = { rpc: async (name, args) => { sent.push(args); return { data: answers.shift(), error: null }; } };
    const ctx = {
        families: { wren: fam }, _secEdit: () => true, toast: (t) => toasts.push(t),
        confirmDialog: async (o) => { dialogs.push(o); return yes.shift(); },
        window: { CampistryDB: { getClient: () => client, getCampId: () => 'camp1' } },
        _loadFamiliesFromRows: async () => {}, curPage: 'billing', renderBilling() {}, renderFamilyDetailPage() {},
    };
    const fn = new Function(...Object.keys(ctx), cutFn('_disputeCounts') + cutFn('resumeAutopayAfterDispute') + 'return resumeAutopayAfterDispute;')(...Object.values(ctx));
    return { fn, sent, dialogs, toasts };
}

test('TED-208 (P17): Resume sends "resume anyway" only when a dispute is open and the office chose it', async () => {
    const lostOnly = resumePage({ name: 'Wren', disputeHold: { disputeIds: ['dp_w'], lostIds: ['dp_w'] } }, [{ success: true, changed: true }], [true]);
    await lostOnly.fn('wren');
    assert.deepStrictEqual(lostOnly.sent.map(a => a.p_even_open), [false]);
    assert.match(lostOnly.dialogs[0].message, /the camp lost it/);
    const open = resumePage({ name: 'Wren', disputeHold: { disputeIds: ['dp_a', 'dp_b'], lostIds: ['dp_a'] } }, [{ success: true, changed: true }], [true]);
    await open.fn('wren');
    assert.match(open.dialogs[0].message, /1 dispute is still open with the bank \(the camp lost 1\)/);
    assert.strictEqual(open.dialogs[0].confirmLabel, 'Resume anyway');
    assert.deepStrictEqual(open.sent.map(a => a.p_even_open), [true]);
    const no = resumePage({ name: 'Wren', disputeHold: { disputeIds: ['dp_a'], lostIds: [] } }, [], [false]);
    await no.fn('wren');
    assert.strictEqual(no.sent.length, 0, 'cancelled, but the page asked the server anyway');
});

test('TED-208 (P18): a page that loaded before the dispute is asked again with the server\'s count, and Cancel changes nothing', async () => {
    const stale = () => resumePage({ name: 'Wren', disputeHold: { disputeIds: ['dp_a'], lostIds: ['dp_a'] } },
        [{ success: false, error: 'dispute_open', open: 1, message: 'A dispute is still open with the bank.' }, { success: true, changed: true }], [true, true]);
    const yes = stale();
    await yes.fn('wren');
    assert.deepStrictEqual(yes.sent.map(a => a.p_even_open), [false, true]);
    assert.match(yes.dialogs[1].message, /A dispute is still open with the bank\. Resume charging Wren.s card anyway\?/);
    assert.match(yes.toasts[0], /resumed for Wren/);
    const cancel = resumePage({ name: 'Wren', disputeHold: { disputeIds: ['dp_a'], lostIds: ['dp_a'] } },
        [{ success: false, error: 'dispute_open', open: 1, message: 'A dispute is still open with the bank.' }], [true, false]);
    await cancel.fn('wren');
    assert.strictEqual(cancel.sent.length, 1);
    assert.strictEqual(cancel.toasts.length, 0);
});

test('TED-213: a child who only shares a NAME with a paused family\'s child is still reloaded', () => {
    // the paused Roe family's child is "Dan Gold" (no number); ours is "Dan Gold #2", on grandma's card
    const r = reloadNight(`() => ({ roe: { name: 'Roe', stripeCustomerId: 'cus_roe', camperIds: ['Dan Gold'], disputeHold: { disputeIds: ['dp_roe'] } } })`);
    assert.ok(r.tables.__charged.includes('cus_grandma'), 'charged: ' + JSON.stringify(r.tables.__charged));
});

test('TED-214 (Q4): a pause written only on a plan (the older form) holds the family\'s children too', () => {
    const r = reloadNight(`() => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_gold', camperIds: ['Bea Gold', 'Dan Gold #2'],
        plans: [{ id: 'p1', collectionBlocked: { reason: 'chargeback', disputeIds: ['dp_old'] } }] } })`);
    assert.deepStrictEqual(r.tables.__charged, ['cus_cy']);
});

test('TED-210: a card with one child\'s top-up disputed is not charged for a brother or sister', () => {
    const r = runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { sessions: [{ name: 'Summer', startDate: '2000-01-01', endDate: '2999-12-31' }] } }];
const ar = (cus: string, extra: any) => Object.assign({ enabled: true, cardOnFile: true, stripeCustomerId: cus, thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 25 }, extra || {});
T.rpc.canteen_autoreload_accounts = () => [
  { camp_id: 'camp1', resolvable: true, person_id: 1, camper_name: 'Dov Katz', account: { balance: 0, autoReload: ar('cus_katz', { enabled: false, disputePausedAt: '2026-09-24T10:00:00Z', disputeId: 'dp_dov' }) } },
  { camp_id: 'camp1', resolvable: true, person_id: 2, camper_name: 'Eve Katz', account: { balance: 0, autoReload: ar('cus_katz') } },
  { camp_id: 'camp1', resolvable: true, person_id: 3, camper_name: 'Cy', account: { balance: 0, autoReload: ar('cus_cy') } }];
T.rpc.camp_families_object = () => ({});
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.tables.__charged = [];
T.fetch = (url: string, init: any) => { if (init.method === 'POST' && url.endsWith('/payment_intents')) { T.tables.__charged.push(new URLSearchParams(init.body).get('customer')); return { id: 'pi_r', status: 'succeeded' }; } return {}; };
T.request = { headers: { 'x-cron-secret': 'c' }, body: {} };`);
    assert.deepStrictEqual(r.tables.__charged, ['cus_cy'], 'charged: ' + JSON.stringify(r.tables.__charged));
    assert.match(JSON.stringify(r.body), /Eve Katz[^}]*held_for_dispute/);
});

// ── canteen disputes pause the FAMILY (TED-210), lost-first (TED-207) ────────
const CANTEEN_WORLD = `
T.fetch = (url: string) => {
  if (url.includes('/payment_intents/pi_dov')) return { id: 'pi_dov', metadata: { campId: 'camp1', camperName: 'Dov Katz', source: 'campistry-canteen-deposit' } };
  if (url.includes('/charges/ch_dov')) return { id: 'ch_dov', payment_intent: 'pi_dov', metadata: {} };
  if (url.includes('/payment_intents/pi_hazel')) return { id: 'pi_hazel', metadata: { campId: 'camp1', familyKey: 'hazel' } };
  if (url.includes('/charges/ch_hazel')) return { id: 'ch_hazel', payment_intent: 'pi_hazel', metadata: {} };
  return {};
};
T.rpc.record_canteen_stripe_reversal = () => ({ success: true, amount: 20 });
T.rpc.pause_canteen_autoreload_for_dispute = () => ({ success: true, changed: true, familyKey: 'katz' });
T.rpc.canteen_dispute_family = () => ({ success: true, familyKey: 'katz' });`;
const dovDispute = (type, status) => ({ id: 'evt_dov' + type + status, type, data: { object: { id: 'dp_dov', charge: 'ch_dov', payment_intent: 'pi_dov', amount: 2000, status, reason: 'fraudulent' } } });

test('TED-210: a disputed canteen top-up pauses the child\'s FAMILY; won lifts it; lost marks it lost', () => {
    const taking = deliver([dovDispute('charge.dispute.created', 'needs_response')], CANTEEN_WORLD);
    assert.strictEqual(taking.status, 200, JSON.stringify(taking.body));
    assert.deepStrictEqual(calls(taking, 'hold_autopay_for_dispute').map(h => [h.p_family_key, h.p_dispute_id, h.p_hold]), [['katz', 'dp_dov', true]]);
    const won = deliver([dovDispute('charge.dispute.closed', 'won')], CANTEEN_WORLD);
    assert.deepStrictEqual(calls(won, 'record_canteen_stripe_reversal').map(a => a.p_kind), ['dispute_won']);
    assert.deepStrictEqual(calls(won, 'hold_autopay_for_dispute').map(h => h.p_hold), [false]);
    const lost = deliver([dovDispute('charge.dispute.closed', 'lost')], CANTEEN_WORLD);
    assert.deepStrictEqual(calls(lost, 'note_dispute_lost').map(a => a.p_family_key), ['katz']);
    // a late message after a win pauses nothing
    const late = deliver([dovDispute('charge.dispute.updated', 'under_review')], CANTEEN_WORLD +
        `\nT.rpc.pause_canteen_autoreload_for_dispute = () => ({ success: true, changed: false, alreadyWon: true, familyKey: 'katz' });`);
    assert.strictEqual(calls(late, 'hold_autopay_for_dispute').length, 0);
    // the family pause fails: 500, so Stripe sends it again
    const bad = deliver([dovDispute('charge.dispute.created', 'needs_response')], CANTEEN_WORLD +
        `\nT.rpc.hold_autopay_for_dispute = () => { throw new Error('statement timeout'); };`);
    assert.strictEqual(bad.status, 500);
});

test('TED-207 (D7): "closed: lost" before "created" — the family comes from the payment and the loss is remembered', () => {
    const r = deliver([{ id: 'evt_l', type: 'charge.dispute.closed', data: { object: { id: 'dp_l', charge: 'ch_hazel', payment_intent: 'pi_hazel', amount: 100000, status: 'lost' } } }],
        CANTEEN_WORLD + `\nT.rpc.resolve_chargeback = () => ({ success: false, error: 'chargeback_not_found' });`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls(r, 'note_dispute_lost'), [{ p_camp_id: 'camp1', p_family_key: 'hazel', p_dispute_id: 'dp_l' }]);
});

// ── Cardknox/Banquest: only chargebacks are booked (TED-212); canteen (TED-211) ──
function ck(body, extra) {
    return runEdge('byop-dispute-webhook', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek' };
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'birch' });
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'birch', outcome: a.p_won ? 'won' : 'lost' });
${extra || ''}
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=cardknox&camp=camp1&key=sek', headers: { 'content-type': 'application/json' }, rawBody: ${JSON.stringify(JSON.stringify(body))} };`);
}

test('TED-212: an ordinary "Approved" sale, a refund or a void sent to the dispute address books nothing', () => {
    for (const body of [
        { xResponseRefnum: '9001', xStatus: 'Approved', xCommand: 'cc:sale' },
        { xResponseRefnum: '9002', xStatus: 'Approved', xCommand: 'cc:refund' },
        { xResponseRefnum: '9003', xStatus: 'Reversed', xCommand: 'cc:void' },
    ]) {
        const r = ck(body);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ignored, 'not_a_chargeback', JSON.stringify(r.body));
        assert.strictEqual(r.rpcs.length, 0, 'wrote: ' + r.rpcs.map(x => x.name).join(','));
    }
    // a real chargeback still posts and pauses
    const cb = ck({ xResponseRefnum: '9001', xStatus: 'Chargeback', xStatusReason: 'Fraud' });
    assert.strictEqual(calls(cb, 'record_chargeback').length, 1);
    assert.deepStrictEqual(calls(cb, 'hold_autopay_for_dispute').map(h => h.p_hold), [true]);
});

test('TED-212: "Chargeback Reversal" is a win — the payment goes back and the pause lifts', () => {
    const r = ck({ xResponseRefnum: '9001', xStatus: 'Chargeback Reversal' });
    assert.deepStrictEqual(calls(r, 'resolve_chargeback').map(a => a.p_won), [true]);
    assert.deepStrictEqual(calls(r, 'hold_autopay_for_dispute').map(h => h.p_hold), [false]);
    const bq = runEdge('byop-dispute-webhook', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek' };
T.rpc.resolve_chargeback = (a: any) => ({ success: true, familyKey: 'birch' });
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=banquest&camp=camp1&key=sek', headers: { 'content-type': 'application/json' },
  rawBody: ${JSON.stringify(JSON.stringify({ chargeback_id: 'cb_7', reference_number: 'r1', event_type: 'chargeback.reversed' }))} };`);
    assert.deepStrictEqual(calls(bq, 'resolve_chargeback').map(a => a.p_won), [true]);
});

test('TED-211: a Cardknox/Banquest dispute of a canteen top-up comes off the wallet, stops auto-reload and pauses the family; won puts it back', () => {
    const world = `T.rpc.record_chargeback = () => ({ success: false, error: 'payment_not_found' });
T.rpc.canteen_dispute_family = (a: any) => (a.p_ref === '7001' ? { success: true, familyKey: 'eli_fam' } : { success: false, error: 'deposit_not_found' });
T.rpc.record_canteen_stripe_reversal = () => ({ success: true, amount: 20 });
T.rpc.pause_canteen_autoreload_for_dispute = () => ({ success: true, changed: true, familyKey: 'eli_fam' });`;
    const r = ck({ xResponseRefnum: '7001', xStatus: 'Chargeback' }, world);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(calls(r, 'record_canteen_stripe_reversal').map(a => [a.p_payment_intent_id, a.p_kind]), [['7001', 'dispute']]);
    assert.deepStrictEqual(calls(r, 'pause_canteen_autoreload_for_dispute').map(a => a.p_payment_intent_id), ['7001']);
    assert.deepStrictEqual(calls(r, 'hold_autopay_for_dispute').map(h => [h.p_family_key, h.p_hold]), [['eli_fam', true]]);
    const won = ck({ xResponseRefnum: '7001', xStatus: 'Chargeback Reversal' }, world +
        `\nT.rpc.resolve_chargeback = () => ({ success: false, error: 'chargeback_not_found' });`);
    assert.deepStrictEqual(calls(won, 'record_canteen_stripe_reversal').map(a => a.p_kind), ['dispute_won']);
    assert.deepStrictEqual(calls(won, 'hold_autopay_for_dispute').map(h => h.p_hold), [false]);
});

test('TED-214 (Q14): a Cardknox/Banquest call that throws answers 500, so the processor sends it again', () => {
    const r = ck({ xResponseRefnum: '9001', xStatus: 'Chargeback' }, `T.rpc.record_chargeback = () => { throw new Error('boom'); };`);
    assert.strictEqual(r.status, 500);
    const r2 = ck({ xResponseRefnum: '7001', xStatus: 'Chargeback' },
        `T.rpc.record_chargeback = () => ({ success: false, error: 'payment_not_found' });\nT.rpc.canteen_dispute_family = () => { throw new Error('boom'); };`);
    assert.strictEqual(r2.status, 500);
});
