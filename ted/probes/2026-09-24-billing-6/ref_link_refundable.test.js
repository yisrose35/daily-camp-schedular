// 6th pass copy: also prints the linked row (is it refundable to the card? needs stripePaymentIntentId/byopTransactionId)
// Probe (5th pass): my 4th-pass report (and the old "Mark deposit received"
// wording) told the office to record a card deposit in Billing BY HAND. What
// happens to a family where they did, once the TED-090 code runs? The real
// _postCardDepositsFor / _postPaymentEntry from campistry_me.js, same loader as
// tests/deposits_reach_the_family.test.js.
'use strict';
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const ROOT = '/home/user/daily-camp-schedular';
const ME = fs.readFileSync(ROOT + '/campistry_me.js', 'utf8');
const B = require(ROOT + '/campistry_billing_core.js');
function cut(name) {
    const at = ME.indexOf('function ' + name + '(');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
test('probe', () => {
    for (const [label, manual] of [
        ['office typed it as a Card payment, reference = the pi', { id: 'pay_1727', familyKey: 'gold', amount: 250, method: 'Card', reference: 'pi_dep', date: '2026-05-02', status: 'succeeded' }],
        ['office typed it as a Card payment, no reference', { id: 'pay_1728', familyKey: 'gold', amount: 250, method: 'Card', date: '2026-05-02', status: 'succeeded' }],
    ]) {
        const ctx = { _billingCore: () => B, finPayments: [manual], roster: {}, today: () => '2026-07-01' };
        vm.createContext(ctx);
        vm.runInContext(['_camperIdOf', '_paymentRefOf', '_paymentRefsOf', '_postPaymentEntry', '_postCardDepositsFor'].map(cut).join('\n')
            + '\nthis.post=_postCardDepositsFor;this.postPay=_postPaymentEntry;', ctx);
        const f = { name: 'Gold', entries: [] };
        B.post(f, { id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', note: 'Tuition' });
        ctx.postPay(f, manual);                             // what Record Payment did back then
        const before = B.balance(f);
        ctx.post(f, 'gold', { camperName: 'Avi', depositPaid: 250, depositReference: 'pi_dep', depositProcessor: 'stripe',
            depositCharges: [{ ref: 'pi_dep', amount: 250, date: '2026-05-01', processor: 'stripe' }] }, 'e1');
        console.log('# row after load: '+JSON.stringify(ctx.finPayments[0]));console.log(`# ${label}: balance before ${before} -> after Billing load ${B.balance(f)} (should stay 750); payment rows ${ctx.finPayments.length}`);
    }
});
