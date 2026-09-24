// =============================================================================
// tip_refund_dispute.test.js — TED-176, the real stripe-connect-webhook.
//
// A tip is charged on Campistry's Stripe account and the tip part goes on to
// the staff member's Stripe account. A refund or a chargeback is paid from
// Campistry's balance — and nothing noticed: the staff member kept the tip,
// and it stayed on their record. Now the webhook takes the tip's share back
// from the staff member's account (a transfer reversal, once), marks the tip
// (migration 285; its SQL is pgtest 285), and emails the platform once with
// what is left to do by hand.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

function deliver(events, opts) {
    opts = opts || {};
    const t = Math.floor(Date.now() / 1000);
    const reqs = events.map(ev => {
        const body = JSON.stringify(ev);
        const sig = crypto.createHmac('sha256', 'whsec_c').update(`${t}.${body}`).digest('hex');
        return { headers: { 'stripe-signature': `t=${t},v1=${sig}` }, rawBody: body };
    });
    return runEdge('stripe-connect-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_c', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: ${opts.noEmailKey ? 'undefined' : "'re_x'"} };
T.tables.link_tips = ${JSON.stringify(opts.tips || [{ id: 'tip1', amount: 20, staff_account_id: 'lsa1', stripe_transfer_id: null,
        recipient_name: 'Moshe', camp_id: 'camp1', stripe_payment_intent_id: 'pi_tip', dispute_status: null }])};
const charges: any = ${JSON.stringify(opts.charges || { ch_1: { id: 'ch_1', amount: 2100, amount_refunded: 2100, transfer: 'tr_1', payment_intent: 'pi_tip' } })};
const transfers: any = ${JSON.stringify(opts.transfers || { tr_1: { id: 'tr_1', amount: 2000, amount_reversed: 0 } })};
const keys: any = {};
let emailsTried = 0;
T.tables.__emails = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('api.resend.com')) {
    emailsTried++;
    ${opts.emailFailsOnce ? "if (emailsTried === 1) return { __status: 500, message: 'rate limited' };" : ''}
    T.tables.__emails.push(JSON.parse(init.body)); return { id: 'em' };
  }
  let m = url.match(/\\/charges\\/([^/?]+)$/); if (m) return charges[m[1]] || { error: { message: 'No such charge' } };
  m = url.match(/\\/transfers\\/([^/?]+)\\/reversals$/);
  ${opts.reversalFails ? "if (m) return { error: { message: 'Insufficient funds in the connected account' } };" : ''}
  if (m) { const k = init.headers['Idempotency-Key']; if (!keys[k]) { keys[k] = 1; transfers[m[1]].amount_reversed += Number(new URLSearchParams(init.body).get('amount')); } return { id: 'trr_' + k }; }
  m = url.match(/\\/transfers\\/([^/?]+)$/); if (m) return transfers[m[1]] || { error: { message: 'No such transfer' } };
  return {};
};
T.tables.__transfers = transfers;
const st: any = {};
T.rpc.record_tip_reversal = (a: any) => {
  const tip = T.tables.link_tips.find((x: any) => x.id === a.p_tip_id);
  const s = st[a.p_tip_id] = st[a.p_tip_id] || { refunded: 0, dispute: tip.dispute_status, claw: 0, alerted: null };
  s.refunded = Math.max(s.refunded, a.p_refunded); if (a.p_dispute_status) s.dispute = a.p_dispute_status;
  if (a.p_clawed_back != null) s.claw = Math.max(s.claw, a.p_clawed_back);
  tip.dispute_status = s.dispute;
  const state = 'r=' + s.refunded + ';d=' + s.dispute + ';c=' + s.claw;
  return { success: true, amount: tip.amount, refunded: s.refunded, disputeStatus: s.dispute || null, clawedBack: s.claw,
           lost: Math.max(s.refunded, s.dispute === 'open' || s.dispute === 'lost' ? tip.amount : 0), note: a.p_note, state, alerted: s.alerted === state };
};
T.rpc.mark_tip_reversal_alerted = (a: any) => { st[a.p_tip_id].alerted = a.p_state; return true; };
Object.defineProperty(T, 'requests', { get: () => ${JSON.stringify(reqs)} });`);
}
const refunded = (obj) => ({ id: 'evt_r', type: 'charge.refunded', data: { object: obj } });
const reversals = (r) => r.fetches.filter(f => /\/reversals$/.test(f.url) && f.method === 'POST');

test('TED-176: a tip refunded in full — taken back from the staff member once, marked, one email; the repeat does nothing', () => {
    const ev = refunded({ id: 'ch_1', amount: 2100, amount_refunded: 2100, transfer: 'tr_1', payment_intent: 'pi_tip' });
    const r = deliver([ev, ev]);
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200]);
    assert.strictEqual(reversals(r).length, 1, 'the tip was taken back twice (or never)');
    assert.strictEqual(new URLSearchParams(reversals(r)[0].body).get('amount'), '2000');
    assert.strictEqual(reversals(r)[0].headers['Idempotency-Key'], 'tiprev_tr_1_2000');
    assert.strictEqual(r.tables.__transfers.tr_1.amount_reversed, 2000);
    const rec = r.rpcs.filter(c => c.name === 'record_tip_reversal');
    assert.strictEqual(rec.length, 2);
    assert.strictEqual(rec[0].args.p_refunded, 20);
    assert.strictEqual(rec[0].args.p_clawed_back, 20);
    assert.strictEqual(r.tables.__emails.length, 1, 'emails: ' + r.tables.__emails.length);
    assert.match(r.tables.__emails[0].subject, /tip was refunded — Moshe/);
    assert.match(r.tables.__emails[0].html, /taken back from Moshe's Stripe account automatically/);
});

test('TED-176: a disputed tip — the whole tip is taken back while the bank decides; won — the platform is told to send it back', () => {
    const r = deliver([
        { id: 'evt_d1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1', amount: 2100, status: 'needs_response' } } },
        { id: 'evt_d2', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', charge: 'ch_1', amount: 2100, status: 'won' } } },
    ], { charges: { ch_1: { id: 'ch_1', amount: 2100, amount_refunded: 0, transfer: 'tr_1', payment_intent: 'pi_tip' } } });
    assert.deepStrictEqual(r.responses.map(x => x.status), [200, 200]);
    assert.strictEqual(reversals(r).length, 1);
    assert.strictEqual(new URLSearchParams(reversals(r)[0].body).get('amount'), '2000');
    const rec = r.rpcs.filter(c => c.name === 'record_tip_reversal').map(c => c.args.p_dispute_status);
    assert.deepStrictEqual(rec, ['open', 'won']);
    assert.strictEqual(r.tables.__emails.length, 2);
    assert.match(r.tables.__emails[0].subject, /disputed/);
    assert.match(r.tables.__emails[1].html, /The dispute was won.*send it to them again/s);
});

test('TED-176: a cart of tips, half refunded — each staff member gives back their own share', () => {
    const tips = [
        { id: 'tA', amount: 10, staff_account_id: 'a', stripe_transfer_id: 'tr_A', recipient_name: 'Avi', camp_id: 'camp1', stripe_payment_intent_id: 'pi_cart' },
        { id: 'tB', amount: 10, staff_account_id: 'b', stripe_transfer_id: 'tr_B', recipient_name: 'Bina', camp_id: 'camp1', stripe_payment_intent_id: 'pi_cart' },
    ];
    const r = deliver([refunded({ id: 'ch_c', amount: 2100, amount_refunded: 1050, payment_intent: 'pi_cart' })], {
        tips, transfers: { tr_A: { id: 'tr_A', amount: 1000, amount_reversed: 0 }, tr_B: { id: 'tr_B', amount: 1000, amount_reversed: 0 } } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(reversals(r).map(f => [f.url.match(/tr_[AB]/)[0], new URLSearchParams(f.body).get('amount')]),
        [['tr_A', '500'], ['tr_B', '500']]);
    assert.strictEqual(r.tables.__emails.length, 2);
});

test('TED-176: not a tip — left to stripe-webhook: nothing taken back, nothing recorded', () => {
    const r = deliver([refunded({ id: 'ch_9', amount: 50000, amount_refunded: 50000, payment_intent: 'pi_tuition' })]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(reversals(r).length, 0);
    assert.strictEqual(r.rpcs.filter(c => c.name === 'record_tip_reversal').length, 0);
    assert.strictEqual(r.tables.__emails.length, 0);
});

test('TED-176: the email does not go — 500, Stripe sends it again, and only the email is tried again', () => {
    const ev = refunded({ id: 'ch_1', amount: 2100, amount_refunded: 2100, transfer: 'tr_1', payment_intent: 'pi_tip' });
    const r = deliver([ev, ev], { emailFailsOnce: true });
    assert.deepStrictEqual(r.responses.map(x => x.status), [500, 200]);
    assert.strictEqual(reversals(r).length, 1, 'the retry took the tip back again');
    assert.strictEqual(r.tables.__emails.length, 1);
});

test('TED-176: the reversal is refused (the staff account has no balance) — the email says what to do by hand', () => {
    const r = deliver([refunded({ id: 'ch_1', amount: 2100, amount_refunded: 2100, transfer: 'tr_1', payment_intent: 'pi_tip' })],
        { reversalFails: true });
    assert.strictEqual(r.status, 200);
    const rec = r.rpcs.find(c => c.name === 'record_tip_reversal').args;
    assert.strictEqual(rec.p_clawed_back, null);
    assert.match(rec.p_note, /Could not take \$20\.00 back from Moshe's Stripe account: Insufficient funds/);
    assert.strictEqual(r.tables.__emails.length, 1);
    assert.match(r.tables.__emails[0].html, /To do:.*\$20\.00 of this tip is still in Moshe's Stripe account.*Reverse transfer/s);
});

test('TED-176: Link admin counts a refunded or disputed tip at what the staff member kept', () => {
    const vm = require('node:vm');
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'campistry_link_admin.html'), 'utf8');
    const at = src.indexOf('function _mergedTipLog(');
    let i = src.indexOf('{', at), d = 0;
    for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
    const ctx = { _loadTipsLog: () => [], _cloudTipRows: [
        { id: 'a', recipient_name: 'Moshe', amount: '20', refunded_amount: '20', created_at: '2026-08-01' },
        { id: 'b', recipient_name: 'Moshe', amount: '10', dispute_status: 'open', created_at: '2026-08-02' },
        { id: 'c', recipient_name: 'Moshe', amount: '10', dispute_status: 'won', created_at: '2026-08-03' },
        { id: 'd', recipient_name: 'Moshe', amount: '10', refunded_amount: '4', created_at: '2026-08-04' },
        { id: 'e', recipient_name: 'Moshe', amount: '5', created_at: '2026-08-05' } ] };
    vm.createContext(ctx);
    vm.runInContext(src.slice(at, i + 1) + '\nthis.log = _mergedTipLog();', ctx);
    const by = Object.fromEntries(ctx.log.map(t => [t.id, [t.amount, t.reversal]]));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(by)), { a: [0, 'Refunded'], b: [0, 'Disputed'], c: [10, ''], d: [6, 'Part refunded'], e: [5, ''] });
    assert.match(src, /\.from\('link_tips'\)\s*\n\s*\/\/[^\n]*\n\s*\.select\('\*'\)/);
});

test('TED-182: a bank inquiry (no money moved) takes nothing from the staff member and records nothing', () => {
    const r = deliver([{ id: 'evt_i', type: 'charge.dispute.created', data: { object: { id: 'dp_i', charge: 'ch_1', amount: 2100, status: 'warning_needs_response' } } }],
        { charges: { ch_1: { id: 'ch_1', amount: 2100, amount_refunded: 0, transfer: 'tr_1', payment_intent: 'pi_tip' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(reversals(r).length, 0, 'the tip was taken back for a question');
    assert.strictEqual(r.rpcs.filter(c => c.name === 'record_tip_reversal').length, 0);
    assert.strictEqual(r.tables.__emails.length, 0);
});

test('TED-182: an "opened" message arriving after the dispute was won takes nothing', () => {
    const tip = { id: 'tip1', amount: 20, staff_account_id: 'lsa1', stripe_transfer_id: null, recipient_name: 'Moshe', camp_id: 'camp1',
                  stripe_payment_intent_id: 'pi_tip', dispute_status: 'won' };
    const r = deliver([{ id: 'evt_late', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1', amount: 2100, status: 'needs_response' } } }],
        { tips: [tip], charges: { ch_1: { id: 'ch_1', amount: 2100, amount_refunded: 0, transfer: 'tr_1', payment_intent: 'pi_tip' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(reversals(r).length, 0, 'a late "opened" took the tip after the dispute was won');
});

test('TED-199 (M15): a tip dispute seen first as funds_withdrawn takes the tip back too', () => {
    const r = deliver([{ id: 'evt_fw', type: 'charge.dispute.funds_withdrawn', data: { object: { id: 'dp_fw', charge: 'ch_1', amount: 2100, status: 'needs_response' } } }],
        { charges: { ch_1: { id: 'ch_1', amount: 2100, amount_refunded: 0, transfer: 'tr_1', payment_intent: 'pi_tip' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(reversals(r).length, 1, 'funds_withdrawn was not handled for tips');
});
