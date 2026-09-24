// =============================================================================
// autopay_lost_answer.test.js — TED-113, the real nightly autopay runner
// (charge-due-installments).
//
// Two families, Gold then Silver, each with a $500 instalment due tonight.
// When the card company takes Gold's $500 and the answer never comes back:
//   before — the whole run stopped (HTTP 500): Silver, and every camp after,
//            waited a night; Gold's charge was never recorded, so the next
//            night charged Gold again; a Banquest timeout was booked "declined".
//   now    — Gold's charge is held on the plan for the office, with a Billing
//            notice, never booked as declined and never charged again by
//            itself; Silver is charged the same night.
// From Ted's 9th-pass probe (ted/probes/2026-09-24-billing-9/).
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');
const TODAY = new Date().toISOString().split('T')[0];

function night(proc, mode, extra) {
    const plan = (id) => ({ id, dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false });
    return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron', STRIPE_SECRET_KEY: 'sk_test' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: ${proc === 'stripe' ? 'null' : `'${proc}'`} }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 's', pin: 'p' } });
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.record_autopay_charge = () => ({ success: true, balance: 500 });
T.rpc.flag_plan_collection = () => ({ success: true });
T.rpc.hold_autopay_charge = () => ({ success: true });
const fams: Record<string, any> = {
  gold:   { name: 'Gold',   camperIds: ['Avi'],  cardOnFile: true, byopCustomerRef: '111', stripeCustomerId: 'cus_111', byopProcessor: '${proc}', charges: [{ amount: 1000 }], plans: [${JSON.stringify(plan('plan_g'))}] },
  silver: { name: 'Silver', camperIds: ['Dina'], cardOnFile: true, byopCustomerRef: '222', stripeCustomerId: 'cus_222', byopProcessor: '${proc}', charges: [{ amount: 1000 }], plans: [${JSON.stringify(plan('plan_s'))}] } };
T.rpc.camp_families_object = () => fams;
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '${TODAY}', amount: 500 });
T.tables.__sales = [];
let stripePosts = 0;
T.fetch = (url: string, init: any) => {
  const body = String(init.body || '');
  if (body.includes('cc%3Asale')) {
    const tok = new URLSearchParams(body).get('xToken');
    T.tables.__sales.push(tok === '111' ? 'Gold' : 'Silver');
    if (${JSON.stringify(mode)} === 'drop' && tok === '111') throw new Error('connection reset by peer');
    return 'xResult=A&xRefNum=' + (tok === '111' ? '9001' : '9002') + '&xStatus=Approved';
  }
  if (url.endsWith('/transactions/charge')) {
    const src = JSON.parse(body).source;
    T.tables.__sales.push(src === 'tkn-111' ? 'Gold' : 'Silver');
    if (${JSON.stringify(mode)} === '504' && src === 'tkn-111') return { __status: 504 };
    return { status_code: 'A', status: 'Approved', reference_number: src === 'tkn-111' ? 7001 : 7002 };
  }
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const cus = new URLSearchParams(body).get('customer');
    if (cus === 'cus_111') {
      stripePosts++;
      if (stripePosts === 1) T.tables.__sales.push('Gold');     // Stripe made it on the first ask...
      if (${JSON.stringify(mode)} === 'drop' && stripePosts === 1) throw new Error('connection reset');   // ...and the answer was lost
      if (${JSON.stringify(mode)} === 'stripe-down') return { __status: 503, error: { message: 'Stripe is unavailable' } };
      return { id: 'pi_gold', status: 'succeeded' };            // the same key again: Stripe's first answer
    }
    T.tables.__sales.push('Silver');
    return { id: 'pi_silver', status: 'succeeded' };
  }
  return {};
};
${extra || ''}
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
}
// Deno's serve answers 500 when the handler throws; the harness has no such
// wrapper, so the same one is added after the function loads.
const DENO = { transform: (fn) => fn + "\n{ const T = (globalThis as any).__T; const h = T.handler; T.handler = async (r: any) => { try { return await h(r); } catch (e) { T.tables.__thrown = [String((e as Error).message)]; return new Response('Internal Server Error', { status: 500 }); } }; }\n" };
const booked = (r, fam) => r.rpcs.filter(c => c.name === 'record_autopay_charge' && c.args.p_family_key === fam);
const holds = (r, fam) => r.rpcs.filter(c => c.name === 'hold_autopay_charge' && c.args.p_family_key === fam && c.args.p_hold);
const declined = (r, fam) => r.rpcs.filter(c => c.name === 'flag_plan_collection' && c.args.p_family_key === fam && c.args.p_reason === 'declined');
const notices = (r) => r.writes.filter(w => w.table === 'notifications' && w.op === 'insert').map(w => w.payload);

for (const proc of ['cardknox', 'banquest']) {
    test(`TED-113: ${proc} — Gold's answer is lost: held for the office, never declined; Silver is still charged tonight`, () => {
        const r = runEdge('charge-due-installments', night(proc, proc === 'cardknox' ? 'drop' : '504'), DENO);
        assert.strictEqual(r.status, 200, 'the run stopped: ' + JSON.stringify(r.tables.__thrown || r.body));
        assert.deepStrictEqual(r.tables.__sales, ['Gold', 'Silver']);
        assert.strictEqual(booked(r, 'gold').length, 0, 'an unanswered charge was booked');
        assert.strictEqual(declined(r, 'gold').length, 0, 'an unanswered charge was booked as a decline');
        const h = holds(r, 'gold');
        assert.strictEqual(h.length, 1, 'Gold\'s charge was not held');
        assert.strictEqual(h[0].args.p_hold.unconfirmed, true);
        assert.strictEqual(h[0].args.p_hold.amount, 500);
        assert.strictEqual(h[0].args.p_plan_id, 'plan_g');
        const n = notices(r).filter(x => x.source === 'charge_unconfirmed');
        assert.strictEqual(n.length, 1, 'the office was not told');
        assert.match(n[0].body, /Gold.*\$500\.00.*may have gone through/);
        assert.strictEqual(booked(r, 'silver').length, 1, 'Silver was not charged tonight');
        const d = r.body.details || [];
        assert.ok(d.some(x => x.family === 'Gold' && x.result === 'unconfirmed_held'), JSON.stringify(d));
    });
}

test('TED-113: the next night, a held charge is not charged again', () => {
    const r = runEdge('charge-due-installments', night('cardknox', 'ok', `
fams.gold.plans[0].pendingCharge = { unconfirmed: true, processor: 'cardknox', amount: 500, index: 0, planId: 'plan_g', dueDate: '${TODAY}', since: '${TODAY}' };`));
    assert.deepStrictEqual(r.tables.__sales, ['Silver'], 'Gold was charged again while the office had not answered');
    assert.ok((r.body.details || []).some(x => x.family === 'Gold' && x.result === 'waiting_for_office'));
});

test('TED-113: Stripe — the answer is lost, the runner asks again with the same key: charged once, recorded', () => {
    const r = runEdge('charge-due-installments', night('stripe', 'drop'));
    const posts = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents') && /cus_111/.test(f.body));
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key'], 'asked again with a new key');
    assert.deepStrictEqual(r.tables.__sales, ['Gold', 'Silver']);
    assert.strictEqual(booked(r, 'gold').length, 1);
    assert.strictEqual(booked(r, 'gold')[0].args.p_dedupe_key, 'pi_gold');
});

test('TED-113: Stripe never gives a final answer: held for the office, not declined', () => {
    const r = runEdge('charge-due-installments', night('stripe', 'stripe-down'));
    assert.strictEqual(booked(r, 'gold').length, 0);
    assert.strictEqual(declined(r, 'gold').length, 0);
    assert.strictEqual(holds(r, 'gold').length, 1);
    assert.strictEqual(booked(r, 'silver').length, 1);
});

test('TED-113: an error nobody foresaw in one family stops only that family', () => {
    const r = runEdge('charge-due-installments', night('cardknox', 'ok', `
// (throws once: the harness itself reads the rows again when it reports)
let boomed = false;
Object.defineProperty(fams.gold, 'plans', { get() { if (!boomed) { boomed = true; throw new Error('boom'); } return []; } });`), DENO);
    assert.strictEqual(r.status, 200, 'the run stopped: ' + JSON.stringify(r.tables.__thrown || r.body));
    assert.deepStrictEqual(r.tables.__sales, ['Silver']);
    assert.ok((r.body.details || []).some(x => x.result === 'error' && /boom/.test(x.reason)), JSON.stringify(r.body.details));
});

// ── the office answers it in Billing ───────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const RESOLVE = ME.match(/async function resolveUnconfirmedAutopay\(fk,planRef\)\{[\s\S]*?\n\}\n/)[0];
const WARN = ME.match(/function _collectionWarning\(l\)\{[\s\S]*?\n\}\n/)[0];

function billing(answers, prompt) {
    const calls = [], toasts = [];
    const ctx = {
        families: { gold: { name: 'Gold', plans: [{ id: 'plan_g', pendingCharge: { unconfirmed: true, processor: 'cardknox', amount: 500, since: '2026-06-01', why: 'connection reset' } }] } },
        confirmDialog: async () => answers.shift(),
        toast: (t) => toasts.push(t), fm: (n) => '$' + n, esc: (s) => String(s), getCampId: () => 'camp1', curPage: 'billing',
        renderBilling: () => {}, renderFamilyDetailPage: () => {}, _loadFamiliesFromRows: async () => {}, _loadPaymentsFromRows: async () => {},
        window: { prompt: () => prompt, CampistryDB: { getClient: () => ({ rpc: async (n, a) => { calls.push([n, a]); return { data: { success: true } }; } }) } },
    };
    const fn = new Function(...Object.keys(ctx), RESOLVE + '; return resolveUnconfirmedAutopay;')(...Object.values(ctx));
    return { fn, calls, toasts, ctx };
}

test('TED-113: Billing shows a held autopay charge, and the office records it with its reference', async () => {
    const w = new Function('je', 'esc', 'fm', '_flatStatus', WARN + '; return _collectionWarning;')(
        (s) => s, (s) => String(s), (n) => '$' + n, (l) => l);
    const html = w({ famKey: 'gold', family: { plans: [{ id: 'plan_g', pendingCharge: { unconfirmed: true, amount: 500, since: '2026-06-01' } }] } });
    assert.match(html, /resolveUnconfirmedAutopay\('gold','plan_g'\)/);
    assert.match(html, /Autopay \$500 \(2026-06-01\) never confirmed/);

    const b = billing([true], '9001');
    await b.fn('gold', 'plan_g');
    assert.deepStrictEqual(b.calls, [['resolve_unconfirmed_autopay',
        { p_camp_id: 'camp1', p_family_key: 'gold', p_plan_ref: 'plan_g', p_went_through: true, p_reference: '9001' }]]);
    assert.ok(!b.ctx.families.gold.plans[0].pendingCharge);
});

test('TED-113: "nothing went through" needs a second, deliberate yes; cancelling changes nothing', async () => {
    const b = billing([false, true]);
    await b.fn('gold', 'plan_g');
    assert.strictEqual(b.calls[0][1].p_went_through, false);
    const c = billing([false, false]);
    await c.fn('gold', 'plan_g');
    assert.strictEqual(c.calls.length, 0, 'a cancelled answer released the hold');
    const d = billing([true], '');
    await d.fn('gold', 'plan_g');
    assert.strictEqual(d.calls.length, 0, '"went through" was saved with no reference');
});
