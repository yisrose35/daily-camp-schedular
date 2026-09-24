// =============================================================================
// canteen_refund_scale.test.js — TED-139, the real functions at a large camp.
//
// Snacks asks the refund function what every child can get back to a card
// (TED-130), and Refund All works out every child's top-ups. Both used to
// re-scan the whole ledger for each top-up: at 1,000 children × 15 top-ups
// that was ~3 s of CPU — over Supabase's limit for a function — and the Snacks
// page then fell back to its week-only figure. The ledger is now indexed once.
//
// Timed as the real function runs (tests/edge_harness.js): the same request on
// a tiny camp and on a 1,000 × 15 camp; the difference is the work.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

function camp(children, each, method, idField) {
    const accounts = {}, transactions = [];
    for (let a = 1; a <= children; a++) {
        const key = 'Camper ' + a;
        accounts[key] = { balance: 50, balanceFloor: 0, camperId: a };
        for (let t = 1; t <= each; t++) {
            const ref = `${idField === 'stripePaymentIntentId' ? 'pi' : 'x'}_${a}_${t}`;
            transactions.push({ kind: 'deposit', method, [idField]: ref, amount: 25, camper: key, camperId: a, timestamp: t });
            if (t <= 3) transactions.push({ kind: 'refund', method, [idField]: ref, amount: 5, camper: key, camperId: a });
        }
    }
    return { success: true, accounts, transactions, holds: [{ key: 'h', accountKey: 'Camper 1', camperId: 1, amount: 10, method, paymentRef: `${idField === 'stripePaymentIntentId' ? 'pi' : 'x'}_1_1`, ageSeconds: 5 }] };
}

function timedHolds(fn, view, proc) {
    const scenario = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: '${proc}' }];
const VIEW = ${JSON.stringify(view)};
let __t0 = 0;
T.rpc.canteen_refund_view = () => { __t0 = performance.now(); return VIEW; };
const __json = JSON.stringify;
// the moment the function starts writing its answer: the work is done
JSON.stringify = function (v: any, ...rest: any[]) { if (v && v.refundable && __t0) { T.tables.__ms = performance.now() - __t0; __t0 = 0; } return (__json as any).call(JSON, v, ...rest); } as any;
T.request = { headers: { Authorization: 'Bearer owner' }, body: { action: 'holds' } };`;
    const r = runEdge(fn, scenario);
    return { ms: r.tables.__ms, body: r.body };
}

for (const [fn, method, idField, proc] of [
    ['stripe-canteen-refund', 'stripe', 'stripePaymentIntentId', 'stripe'],
    ['payments-canteen-refund', 'cardknox', 'byopTransactionId', 'cardknox'],
]) {
    test(`TED-139: ${fn} works out 1,000 children × 15 top-ups well inside Supabase's 2 s`, () => {
        const big = timedHolds(fn, camp(1000, 15, method, idField), proc);
        // each child: 15 × $25 − 3 × $5 = $360 (child 1: less $10 on its way)
        assert.deepStrictEqual(big.body.refundable['Camper 2'], { camperId: 2, wallet: 50, card: 360, now: 50 });
        assert.deepStrictEqual(big.body.refundable['Camper 1'], { camperId: 1, wallet: 50, card: 350, now: 50 });
        assert.strictEqual(Object.keys(big.body.refundable).length, 1000);
        assert.ok(typeof big.ms === 'number', 'not timed');
        assert.ok(big.ms < 500, `${big.ms.toFixed(0)} ms for 1,000 × 15 (it was ~3,000 ms)`);
        if (process.env.SHOW_MS) console.log('TIMING', fn, big.ms.toFixed(0));
    });
}

test('TED-139: Refund All works out 1,000 children × 15 top-ups well inside Supabase\'s 2 s', () => {
    // every child has money, and this pretend Stripe refuses each payment at
    // once — so what is timed is Refund All's own per-child work (finding each
    // child's top-ups and what is left on them), for all 1,000 children
    const view = camp(1000, 15, 'stripe', 'stripePaymentIntentId');
    const r = runEdge('stripe-canteen-refund-all', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
const VIEW = ${JSON.stringify(view)};
let __t0 = 0;
T.rpc.canteen_refund_view = () => { if (!__t0) __t0 = performance.now(); return VIEW; };
T.fetch = (url: string) => url.includes('/payment_intents/') ? { __status: 400, error: { type: 'invalid_request_error', message: 'test: refused' } } : { data: [], has_more: false };
const __json = JSON.stringify;
JSON.stringify = function (v: any, ...rest: any[]) { if (v && v.lookedUp && __t0) { T.tables.__ms = performance.now() - __t0; __t0 = 0; } return (__json as any).call(JSON, v, ...rest); } as any;
T.request = { headers: { Authorization: 'Bearer owner' }, body: {} };`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.strictEqual(r.body.failedCount, 1000, 'every child was worked out: ' + JSON.stringify(r.body).slice(0, 200));
    assert.ok(typeof r.tables.__ms === 'number', 'not timed');
    if (process.env.SHOW_MS) console.log('TIMING refund-all', r.tables.__ms.toFixed(0));
    assert.ok(r.tables.__ms < 1000, `${r.tables.__ms.toFixed(0)} ms`);
});
