// =============================================================================
// closeout_canteen_and_rollforward.test.js — TED-067. The real _applyCloseout
// with the real campistry_closeout.js and BillingCore.
//
//   - a child's canteen money comes off the CANTEEN account (canteen_office_
//     cash_out), never charged to the family's tuition account;
//   - "Roll into next season" leaves the money where it is — it used to post a
//     charge that consumed it;
//   - the family's own credit, donated or paid out, is still a charge against
//     the account (the credit is used up).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..');
const ME = fs.readFileSync(path.join(R, 'campistry_me.js'), 'utf8');
function cut(name) {
    const at = ME.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}

function world(balanceEntries) {
    const calls = [], toasts = [];
    const ctx = { window: {}, console: { log() {}, warn() {}, error() {} }, Promise, calls, toasts };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(R, 'campistry_billing_core.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(R, 'campistry_closeout.js'), 'utf8'), ctx);
    ctx.window.CampistryDB = { getClient: () => ({ rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: { success: true } }); } }), getCampId: () => 'camp1' };
    ctx.__entries = balanceEntries;
    vm.runInContext(`
      var families={gold:{name:'Gold',camperIds:['Avi Gold'],balance:0,entries:__entries}};
      var roster={'Avi Gold':{camperId:4}};
      var curPage='billing';
      function save(){} function closeModal(){} function renderBilling(){} function renderFamilyDetailPage(){}
      function toast(m,k){toasts.push(m)} function today(){return '2026-08-20'} function fm(n){return '$'+n}
      function _billingCore(){return window.BillingCore}
      function _closeoutAPI(){return window.CampistryCloseout}
    ` + cut('_camperLabel') + '\n' + cut('_camperIdOf') + '\n' + cut('_postLedgerCharge') + '\n' + cut('_applyCloseout'), ctx);
    return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 20));
const bal = ctx => vm.runInContext('window.BillingCore.balance(families.gold)', ctx);
const PAID_IN_FULL = [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition' }, { id: 'le_p', kind: 'payment', amount: 1000, reason: 'card' }];

test('TED-067: rolling a child\'s canteen money forward leaves both the canteen and the tuition balance alone', async () => {
    const ctx = world(PAID_IN_FULL);
    vm.runInContext(`_applyCloseout('gold',{steps:[{kind:'canteen',camper:'Avi Gold',do:'roll_forward',amount:6}]})`, ctx);
    await settle();
    assert.strictEqual(bal(ctx), 0, 'a paid-in-full family now owes their child\'s snack money');
    assert.strictEqual(ctx.calls.length, 0, 'the canteen account was touched');
});

test('TED-067: cashing out a child\'s canteen money takes it off the CANTEEN account, not the family\'s', async () => {
    const ctx = world(PAID_IN_FULL);
    vm.runInContext(`_applyCloseout('gold',{steps:[{kind:'canteen',camper:'Avi Gold',do:'cash',amount:6}]})`, ctx);
    await settle();
    assert.strictEqual(bal(ctx), 0);
    // 280 (TED-142/145): the season's own close-out, not the till's cash-out
    // (whose $20-a-day cash limit and the parent's floor kept money back)
    assert.ok(!ctx.calls.some(x => x.fn === 'canteen_office_cash_out'), 'the close-out went through the till\'s limits');
    const c = ctx.calls.find(x => x.fn === 'canteen_season_closeout');
    assert.ok(c, 'the canteen account was not debited');
    assert.strictEqual(c.args.p_amount, 6);
    assert.strictEqual(c.args.p_camper_id, 4, 'the child is named by number');
    assert.match(c.args.p_note, /close-out/i);
});

test('TED-067: rolling the family\'s own credit forward keeps the credit', async () => {
    const ctx = world([{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition' }, { id: 'le_p', kind: 'payment', amount: 1100, reason: 'card' }]);
    vm.runInContext(`_applyCloseout('gold',{steps:[{kind:'family',do:'roll_forward',amount:100}]})`, ctx);
    await settle();
    assert.strictEqual(bal(ctx), -100, 'the rolled-forward credit disappeared');
});

test('the family\'s credit donated or paid out is used up (a charge against the account)', async () => {
    const ctx = world([{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition' }, { id: 'le_p', kind: 'payment', amount: 1100, reason: 'card' }]);
    vm.runInContext(`_applyCloseout('gold',{steps:[{kind:'family',do:'donate',amount:100}]})`, ctx);
    await settle();
    assert.strictEqual(bal(ctx), 0);
    assert.strictEqual(ctx.calls.length, 0);
});
