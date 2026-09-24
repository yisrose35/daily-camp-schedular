// 7th pass copy: loader also cuts _markCardPayment (new in 66a65df).
// Probe (6th pass): TED-095's "same money?" review with two siblings.
// Two children in one family each paid a $250 deposit by card (pi_A, pi_B).
// Case 1: the office had typed in ONE $250 by hand (no reference).
// Case 2: the office had typed in BOTH (two $250 payments, no reference).
// The office answers the Billing questions with the real resolveDepositReview.
// Real code from campistry_me.js, same loader as tests/deposits_reach_the_family.test.js.
'use strict';
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const ROOT = '/home/user/daily-camp-schedular';
const ME = fs.readFileSync(ROOT + '/campistry_me.js', 'utf8');
const B = require(ROOT + '/campistry_billing_core.js');
function cut(name) {
    const at = ME.indexOf((name === 'resolveDepositReview' ? 'async ' : '') + 'function ' + name + '(');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
async function run(label, hand, answers) {
    const asked = [];
    const ctx = { _billingCore: () => B, finPayments: hand.map(h => Object.assign({}, h)), roster: {}, today: () => '2026-07-01',
        families: {}, esc: s => String(s), fm: n => '$' + n, save() {}, renderBilling() {}, curPage: 'billing',
        confirmDialog: async (o) => { asked.push(o.message.replace(/<br>/g, ' ')); return answers.shift(); } };
    vm.createContext(ctx);
    vm.runInContext(['_camperIdOf', '_markCardPayment', '_paymentRefOf', '_paymentRefsOf', '_postPaymentEntry', '_postCardDepositsFor', 'resolveDepositReview'].map(cut).join('\n')
        + '\nthis.post=_postCardDepositsFor;this.postPay=_postPaymentEntry;this.resolve=resolveDepositReview;', ctx);
    const f = { name: 'Gold', entries: [] };
    ctx.families.gold = f;
    B.post(f, { id: 'le_t1', kind: 'charge', amount: 1000, reason: 'tuition', note: 'Tuition A' });
    B.post(f, { id: 'le_t2', kind: 'charge', amount: 1000, reason: 'tuition', note: 'Tuition B' });
    ctx.finPayments.forEach(p => ctx.postPay(f, p));
    const eA = { camperName: 'Avi', depositCharges: [{ ref: 'pi_A', amount: 250, date: '2026-05-01', processor: 'stripe' }] };
    const eB = { camperName: 'Dina', depositCharges: [{ ref: 'pi_B', amount: 250, date: '2026-05-01', processor: 'stripe' }] };
    const load = () => { ctx.post(f, 'gold', eA, 'eA'); ctx.post(f, 'gold', eB, 'eB'); };
    load();
    console.log(`# ${label}`);
    console.log(`#   questions after Billing load: ${JSON.stringify((f.depositReview || []).map(r => r.ref + '->' + r.paymentId))}`);
    await ctx.resolve('gold', 'pi_A');
    load();
    await ctx.resolve('gold', 'pi_B');
    load(); load();
    console.log(`#   dialogs shown: ${asked.length}; last: ${asked[asked.length - 1]}`);
    console.log(`#   payment rows: ${JSON.stringify(ctx.finPayments.map(p => ({ id: p.id, amt: p.amount, depRef: p.depositReference, pi: p.stripePaymentIntentId })))}`);
    console.log(`#   family balance: ${B.balance(f)}  (2000 tuition - 500 actually paid by card = 1500)`);
    console.log(`#   open questions left: ${JSON.stringify(f.depositReview)}`);
}
test('probe', async () => {
    // Office typed ONE $250; it is A's. Office answers "same" for A, then is shown the SAME hand payment for B.
    await run('case 1: one hand-typed $250; office says same for A, same for B (dialog shows the hand payment)', [
        { id: 'pay_h1', familyKey: 'gold', amount: 250, method: 'Card', date: '2026-05-02', status: 'succeeded' }], [true, true]);
    await run('case 1b: one hand-typed $250; office says same for A, different for B', [
        { id: 'pay_h1', familyKey: 'gold', amount: 250, method: 'Card', date: '2026-05-02', status: 'succeeded' }], [true, false, true]);
    await run('case 2: both typed by hand; office says same for both', [
        { id: 'pay_h1', familyKey: 'gold', amount: 250, method: 'Card', date: '2026-05-02', status: 'succeeded' },
        { id: 'pay_h2', familyKey: 'gold', amount: 250, method: 'Card', date: '2026-05-02', status: 'succeeded' }], [true, true]);
});
