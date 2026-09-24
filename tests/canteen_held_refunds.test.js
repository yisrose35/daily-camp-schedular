// =============================================================================
// canteen_held_refunds.test.js — TED-116. A Sola/Banquest canteen refund whose
// answer never came back holds its money off the wallet (275). Before, nothing
// could settle it: if it went through it never reached the child's history; if
// it did not, the parent's money stayed locked. Now the office answers it from
// Snacks (Refund, or Refund All): "it went through" with the processor's
// reference, or "nothing went through" — and a new refund for that child waits
// until the earlier one is answered.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runEdge } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

// Avi: $50 topped up, a $20 refund sent and never answered (held; wallet 30).
function byop(requests, { age = 400, extra = '' } = {}) {
    return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
T.tables.refund_intents = [{ key: 'canteen:cref_old:X1', amount: 20, result: null, settled_at: null }];
const RI = () => T.tables.refund_intents;
const find = (k: string) => RI().find((r: any) => r.key === k);
T.rpc.claim_refund_intent = (a: any) => { const c = find(a.p_key); if (c) return { claimed: false, previous: c.result || {} };
  RI().push({ key: a.p_key, amount: a.p_amount, result: null, settled_at: null }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = find(a.p_key); if (c) { c.result = a.p_result; c.settled_at = 'now'; } return true; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = RI().filter((r: any) => !(r.key === a.p_key && !r.settled_at)); return true; };
T.rpc.release_stale_refund_intent = (a: any) => { const c = find(a.p_key); if (c && !c.settled_at && (T.holdAge || 0) >= 180) { T.tables.refund_intents = RI().filter((r: any) => r !== c); return true; } return false; };
T.rpc.record_processor_transaction = () => ({ success: true });
const tx: any[] = [{ kind: 'deposit', method: 'cardknox', byopTransactionId: 'X1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 },
                   { kind: 'refund', method: 'cardknox', byopTransactionId: 'X9', amount: 5, byopRefundId: 'R_USED', camperId: 8 }];
let bal = 30;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
T.tables.canteen_refund_holds.push({ key: 'canteen:cref_old:X1', amount: 20, method: 'cardknox', paymentRef: 'X1', stripeKey: null, state: 'open', refundId: null, camperId: 7, accountKey: 'Avi' });
T.holdAge = ${age};
let n = 0; T.tables.__sent = [];
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) { n++; T.tables.__sent.push(Number(new URLSearchParams(init.body).get('xAmount'))); return 'xResult=A&xRefNum=RN' + n + '&xStatus=Approved'; }
  return {};
};
${extra}
const owner = { Authorization: 'Bearer owner' };
T.requests = ${JSON.stringify(requests)}.map((b: any) => ({ headers: owner, body: b }));`;
}
const hold = (r) => (r.tables.canteen_refund_holds || [])[0];

test('TED-116: the office lists the held refunds', () => {
    const r = runEdge('payments-canteen-refund', byop([{ action: 'holds' }]));
    assert.deepStrictEqual(r.body.holds.map(h => [h.key, h.amount, h.camperId]), [['canteen:cref_old:X1', 20, 7]]);
});

test('TED-116: "it went through" puts it on the child\'s history, and the wallet stays where it is', () => {
    const r = runEdge('payments-canteen-refund', byop([{ action: 'resolveHold', holdKey: 'canteen:cref_old:X1', wentThrough: true, reference: 'RX_77' }]));
    assert.strictEqual(r.body.settled, true, JSON.stringify(r.body));
    assert.strictEqual(hold(r).state, 'posted');
    assert.strictEqual(r.tables.__bal, 30);
    assert.ok(r.rpcs.some(c => c.name === 'settle_refund_intent' && c.args.p_key === 'canteen:cref_old:X1'));
});

test('TED-116: a reference already used for another refund is refused, not taken', () => {
    const r = runEdge('payments-canteen-refund', byop([{ action: 'resolveHold', holdKey: 'canteen:cref_old:X1', wentThrough: true, reference: 'R_USED' }]));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(hold(r).state, 'open');
});

test('TED-116: "nothing went through" puts the $20 back — but never for a refund still on its way', () => {
    const young = runEdge('payments-canteen-refund', byop([{ action: 'resolveHold', holdKey: 'canteen:cref_old:X1', wentThrough: false }], { age: 30 }));
    assert.strictEqual(young.status, 409);
    assert.match(young.body.error, /moment ago/);
    const r = runEdge('payments-canteen-refund', byop([{ action: 'resolveHold', holdKey: 'canteen:cref_old:X1', wentThrough: false }]));
    assert.strictEqual(r.body.released, true, JSON.stringify(r.body));
    assert.strictEqual(r.tables.__bal, 50);
    assert.strictEqual(hold(r).state, 'released');
});

test('TED-116: a new refund for that child waits for the earlier one; "not there" gives it back and sends the new one once', () => {
    // Ted's case D: the first refund did NOT go through, the office reloads
    // Snacks (a new key) and refunds $20 again.
    const ask = { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_new' };
    const r = runEdge('payments-canteen-refund', byop([ask, Object.assign({}, ask, { confirmNotRefunded: true, confirmHolds: ['canteen:cref_old:X1'] })]));
    const [a, b] = r.responses.map(x => x.body);
    assert.strictEqual(a.uncertain, true, 'a second refund went round the unanswered one: ' + JSON.stringify(a));
    assert.deepStrictEqual(a.confirmHolds, ['canteen:cref_old:X1']);
    assert.strictEqual(b.totalRefunded, 20, JSON.stringify(b));
    assert.deepStrictEqual(r.tables.__sent, [20], 'money sent to the parent');
    assert.strictEqual(r.tables.__bal, 30, 'the wallet should show 50 - the one $20 that went back');
});

test('TED-116: a Stripe refund is not settled by hand', () => {
    const r = runEdge('payments-canteen-refund', byop([{ action: 'resolveHold', holdKey: 'canteen:cref_old:X1', wentThrough: true, reference: 'x' }],
        { extra: "T.tables.canteen_refund_holds[0].method = 'stripe';" }));
    assert.strictEqual(r.status, 409);
});

test('TED-116: Refund All names the child whose earlier refund is unanswered', () => {
    const r = runEdge('payments-canteen-refund-all', byop([{}]));
    const d = (r.body.details || []).find(x => x.camperId === 7);
    assert.ok(d && /never confirmed/.test(d.error), JSON.stringify(r.body));
});

// ── the Snacks side ────────────────────────────────────────────────────────
const SN = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
function cut(name) {
    const at = SN.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = SN.indexOf('{', at), d = 0;
    for (; i < SN.length; i++) { if (SN[i] === '{') d++; else if (SN[i] === '}' && --d === 0) break; }
    return SN.slice(at, i + 1);
}

// This file pulls single functions out of the page, so it cannot see whether
// the page itself can reach them — the test below passed while the real page
// crashed on _lbl, declared inside getCamperList (TED-116). The real proof is
// tests/snacks_refund_windows.e2e.js (npm run test:smoke), which clicks the
// windows in a browser; this only keeps the two known traps shut.
test('TED-116/124: the helpers the refund windows call are reachable from the page', () => {
    const lbl = SN.indexOf('function _lbl(');
    const gcl = SN.indexOf('function getCamperList(');
    assert.ok(lbl >= 0 && gcl >= 0 && lbl < gcl, '_lbl must be declared at the top level, not inside getCamperList');
    assert.doesNotMatch(SN, /_stripeRefundCapacity\s*\(/, 'Refund All must not call a helper that does not exist');
    assert.match(cut('_refundAllPreview'), /_onlineRefundCapacity\(c\.name, processorKey\)/);
});

test('TED-116: Snacks shows the held refund with both answers, and sends the office\'s answer', async () => {
    const el = { style: {}, innerHTML: '' };
    const sent = [];
    const ctx = {
        window: {}, esc: (s) => String(s), toast() {}, _secEdit: () => true, _refreshSnacksFromCloud() {}, refundPickCamper() {},
        _edgeFnErrorMessage: async () => null,
        getRoster: () => ({ 'Avi Katz #7': { camperId: 7 } }),
        _getSnacksProcessorKey: async () => 'cardknox',
        document: { getElementById: () => null },
    };
    ctx.window.CampistryDB = { client: { functions: { invoke: async (fn, o) => { sent.push([fn, o.body]);
        return { data: o.body.action === 'holds' ? { holds: [{ key: 'canteen:cref_old:X1', camperId: 7, account: 'Avi Katz #7', amount: 20, method: 'cardknox', ageSeconds: 600 }] } : { settled: true } }; } } } };
    ctx.window.prompt = () => 'RX_77';
    ctx.window.confirm = () => true;
    vm.createContext(ctx);
    vm.runInContext(['_lbl', '_loadCanteenHolds', '_holdCamperKey', '_holdAge', '_showCanteenHolds'].map(cut).join('\n')
        + '\n' + SN.match(/window\.resolveCanteenRefundHold = async function[\s\S]*?\n\};\n/)[0]
        + '\nthis._showCanteenHolds=_showCanteenHolds;', ctx);
    await ctx._showCanteenHolds(el, 'Avi Katz #7');
    assert.match(el.innerHTML, /Avi Katz<\/strong>: \$20\.00, sent 10 min ago/);
    assert.match(el.innerHTML, /It went through/);
    assert.match(el.innerHTML, /Nothing went through/);
    await ctx.window.resolveCanteenRefundHold('canteen:cref_old:X1', true);
    // (compared as JSON: the page's objects come from another realm)
    assert.strictEqual(JSON.stringify(sent.find(s => s[1].action === 'resolveHold')),
        JSON.stringify(['payments-canteen-refund', { action: 'resolveHold', holdKey: 'canteen:cref_old:X1', wentThrough: true, reference: 'RX_77' }]));
});
