// =============================================================================
// batch_charge_counts_failures.test.js — TED-059. "Batch charge" said
// "12 charged, 0 failed" whatever happened: chargeStoredCard swallowed every
// error, so the batch counted each family as a success. The real
// chargeStoredCard and batchCharge run here with the processor answering.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}

function world(answers) {
    const toasts = [], calls = [];
    const ctx = {
        toasts, calls, console: { log() {}, error() {}, warn() {} }, Promise, setTimeout: (f) => f(), Date, Math, Object, JSON, String, Number,
        families: {
            famA: { name: 'Adler', stripeCustomerId: 'cus_A', cardOnFile: true },
            famB: { name: 'Baum', stripeCustomerId: 'cus_B', cardOnFile: true },
            famC: { name: 'Cohen', stripeCustomerId: 'cus_C', cardOnFile: true },
        },
        finPayments: [], curPage: 'billing',
        buildFamilyLedgers() { const o = {}; Object.keys(ctx.families).forEach(k => { o[k] = { balance: 100, family: ctx.families[k] }; }); return o; },
        _famChargeable: (f) => !!(f && f.stripeCustomerId),
        esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2),
        toast: (m, k) => toasts.push({ m, k }),
        showModal: (_t, _h, cb) => { ctx._modalDone = cb(); },
        closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {}, save() {}, _postPaymentEntry() { return true; },
        getCampId: () => 'camp1',
        // the charge being made, kept in this browser until it settles (TED-111)
        localStorage: (() => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })(),
        callEdgeFunctionAuthed: async (fn, body) => {
            calls.push({ fn, body });
            const a = answers[body.customerId];
            if (a instanceof Error) throw a;
            return a;
        },
    };
    vm.createContext(ctx);
    const pending = ['_pendingChargeStoreKey', '_pendingChargeAll', '_pendingChargeGet', '_pendingChargeSet', '_pendingChargeClear'].map(cut).join('\n');
    const onWay = ['_familyOnItsWay', '_familyDisputed', '_famDisputeHeld', '_onItsWayWords', '_recordOnItsWay', '_methodTypeCharged'].map(cut).join('\n');
    vm.runInContext(cut('chargeStoredCard') + '\n' + cut('batchCharge') + '\n' + pending + '\n' + onWay + '\nthis.chargeStoredCard=chargeStoredCard;this.batchCharge=batchCharge;', ctx);
    return ctx;
}

test('TED-059: a declined card is counted as failed and named', async () => {
    const ctx = world({
        cus_A: { status: 'succeeded', paymentIntentId: 'pi_A' },
        // a decline as stripe-charge answers it (TED-111): a definite "no"
        cus_B: Object.assign(new Error('Your card was declined.'), { data: { declined: true, error: 'Your card was declined.' } }),
        cus_C: { status: 'requires_action' },
    });
    await ctx.batchCharge();
    await ctx._modalDone;
    const last = ctx.toasts[ctx.toasts.length - 1].m;
    assert.match(last, /1 charged, 2 failed/, last);
    assert.match(last, /Baum \(Your card was declined\.\)/);
    assert.match(last, /Cohen/);
    assert.strictEqual(ctx.finPayments.length, 1, 'only the successful charge is recorded');
});

test('each charge carries its own idempotency key', async () => {
    const ctx = world({ cus_A: { status: 'succeeded', paymentIntentId: 'pi_A' }, cus_B: { status: 'succeeded', paymentIntentId: 'pi_B' }, cus_C: { status: 'succeeded', paymentIntentId: 'pi_C' } });
    await ctx.batchCharge();
    await ctx._modalDone;
    const keys = ctx.calls.map(c => c.body.idempotencyKey);
    assert.strictEqual(new Set(keys).size, 3);
    assert.ok(keys.every(Boolean));
    assert.match(ctx.toasts[ctx.toasts.length - 1].m, /3 charged, 0 failed/);
});

test('chargeStoredCard answers ok:true only when the money moved', async () => {
    const ctx = world({ cus_A: { status: 'succeeded', paymentIntentId: 'pi_A' }, cus_B: new Error('nope'), cus_C: { status: 'processing' } });
    assert.strictEqual((await ctx.chargeStoredCard('famA', 50, 'x', true)).ok, true);
    assert.strictEqual((await ctx.chargeStoredCard('famB', 50, 'x', true)).ok, false);
    // a bank debit that has started is not paid yet, and not failed (TED-144)
    const c = await ctx.chargeStoredCard('famC', 50, 'x', true);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.pending, true);
});
