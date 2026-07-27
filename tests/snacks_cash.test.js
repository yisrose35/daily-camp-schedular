// node --test tests/snacks_cash.test.js
// Validates the canteen cash-out rules:
//   • available cash comes from balance − balanceFloor, NOT from credit limit
//   • the per-camper daily cash cap is enforced on top of the balance check
//   • validate() rejects the same cases the UI disables the button for
//   • the ledger row is a debit tagged cash_out, so balance reconciliation and
//     revenue reporting both do the right thing with it
const test = require('node:test');
const assert = require('node:assert');
const SC = require('../campistry_snacks_cash.js');

const D = '2026-07-15';
const loose = { cashDailyMax: 0, cashReasonRequired: false, cashAllowNegative: false };

test('available cash is balance minus the reserve floor', () => {
    const lim = SC.limit({ account: { balance: 40, balanceFloor: 10 }, camper: 'Eli', date: D, settings: loose });
    assert.strictEqual(lim.balance, 40);
    assert.strictEqual(lim.max, 30);
    assert.strictEqual(lim.reason, '');
});

test('a credit limit does NOT extend cash out', () => {
    // creditLimit lets a camper finish a purchase; handing out cash against it
    // would be lending money, so it must be ignored here.
    const lim = SC.limit({ account: { balance: 5, creditLimit: 100 }, camper: 'Eli', date: D, settings: loose });
    assert.strictEqual(lim.max, 5);
});

test('zero balance reports a reason rather than a silent zero', () => {
    const lim = SC.limit({ account: { balance: 0 }, camper: 'Eli', date: D, settings: loose });
    assert.strictEqual(lim.max, 0);
    assert.strictEqual(lim.reason, 'No available balance');
});

test('a negative balance never yields negative headroom', () => {
    const lim = SC.limit({ account: { balance: -12 }, camper: 'Eli', date: D, settings: loose });
    assert.strictEqual(lim.max, 0);
});

test('cashAllowNegative lifts the balance check entirely', () => {
    const lim = SC.limit({ account: { balance: 0 }, camper: 'Eli', date: D,
                           settings: { ...loose, cashAllowNegative: true } });
    assert.strictEqual(lim.max, Infinity);
    assert.strictEqual(lim.reason, '');
});

test('the daily cash cap applies on top of the balance', () => {
    const txs = [{ kind: 'cash_out', camper: 'Eli', amount: 15, date: D }];
    const lim = SC.limit({ account: { balance: 200 }, transactions: txs, camper: 'Eli', date: D,
                           settings: { ...loose, cashDailyMax: 20 } });
    assert.strictEqual(lim.takenToday, 15);
    assert.strictEqual(lim.max, 5);
});

test('once the daily cap is spent the reason says so', () => {
    const txs = [{ kind: 'cash_out', camper: 'Eli', amount: 20, date: D }];
    const lim = SC.limit({ account: { balance: 200 }, transactions: txs, camper: 'Eli', date: D,
                           settings: { ...loose, cashDailyMax: 20 } });
    assert.strictEqual(lim.max, 0);
    assert.match(lim.reason, /Daily cash-out limit of \$20\.00/);
});

test('the daily cap applies even when cashAllowNegative is on', () => {
    const txs = [{ kind: 'cash_out', camper: 'Eli', amount: 8, date: D }];
    const lim = SC.limit({ account: { balance: -50 }, transactions: txs, camper: 'Eli', date: D,
                           settings: { cashDailyMax: 20, cashAllowNegative: true, cashReasonRequired: false } });
    assert.strictEqual(lim.max, 12);
});

test('takenOn only counts cash_out rows, for that camper, on that date', () => {
    const txs = [
        { kind: 'cash_out', camper: 'Eli', amount: 10, date: D },
        { kind: 'cash_out', camper: 'Eli', amount: 5, date: '2026-07-14' }, // other day
        { kind: 'cash_out', camper: 'Moshe', amount: 7, date: D },          // other camper
        { kind: 'deposit', type: 'credit', camper: 'Eli', amount: 50, date: D },
        { camper: 'Eli', amount: 3, date: D, type: 'debit' }                // a purchase
    ];
    assert.strictEqual(SC.takenOn(txs, 'Eli', D), 10);
    assert.strictEqual(SC.paidOutOn(txs, D), 17);   // Eli 10 + Moshe 7
});

test('paidOutOn tolerates negative-signed amounts', () => {
    const txs = [{ kind: 'cash_out', camper: 'Eli', amount: -10, date: D }];
    assert.strictEqual(SC.paidOutOn(txs, D), 10);
});

test('validate: rejects no camper, no amount, and a missing required reason', () => {
    const base = { account: { balance: 100 }, date: D, settings: loose };
    assert.strictEqual(SC.validate({ ...base, amount: 10 }).error, 'Pick a camper');
    assert.strictEqual(SC.validate({ ...base, camper: 'Eli', amount: 0 }).error, 'Enter an amount');
    assert.strictEqual(SC.validate({ ...base, camper: 'Eli', amount: -5 }).error, 'Enter an amount');

    const strict = { ...base, camper: 'Eli', amount: 10, settings: { ...loose, cashReasonRequired: true } };
    assert.match(SC.validate(strict).error, /reason is required/);
    assert.strictEqual(SC.validate({ ...strict, note: '   ' }).ok, false);  // whitespace isn't a reason
    assert.strictEqual(SC.validate({ ...strict, note: 'Trip money' }).ok, true);
});

test('validate: rejects an over-balance withdrawal, allows exactly the balance', () => {
    const base = { account: { balance: 25 }, camper: 'Eli', date: D, settings: loose };
    assert.match(SC.validate({ ...base, amount: 25.01 }).error, /Only \$25\.00 available/);
    assert.strictEqual(SC.validate({ ...base, amount: 25 }).ok, true);
});

test('validate: cents that round to the cap are accepted, not blocked by float noise', () => {
    const base = { account: { balance: 0.3 }, camper: 'Eli', date: D, settings: loose };
    assert.strictEqual(SC.validate({ ...base, amount: 0.1 + 0.2 }).ok, true);
});

test('buildTransaction: a debit tagged cash_out, with the note folded into the label', () => {
    const t = SC.buildTransaction({ camper: 'Eli', amount: 20, note: ' Trip money ', by: 'Rivky', date: D, time: '2:15 PM' });
    assert.strictEqual(t.type, 'debit');          // so balance reconciliation subtracts it
    assert.strictEqual(t.kind, 'cash_out');       // so revenue reporting excludes it
    assert.strictEqual(t.amount, 20);
    assert.strictEqual(t.note, 'Trip money');     // trimmed
    assert.strictEqual(t.by, 'Rivky');
    assert.strictEqual(t.items, 'Cash out — Trip money');
    assert.strictEqual(t.date, D);
});

test('buildTransaction: no note leaves a bare label', () => {
    assert.strictEqual(SC.buildTransaction({ camper: 'Eli', amount: 5 }).items, 'Cash out');
});

test('buildTransaction rounds to cents', () => {
    assert.strictEqual(SC.buildTransaction({ camper: 'Eli', amount: 10.005 }).amount, 10.01);
    assert.strictEqual(SC.buildTransaction({ camper: 'Eli', amount: 0.1 + 0.2 }).amount, 0.3);
});

test('a withdrawal recorded via buildTransaction closes the headroom it used', () => {
    // End-to-end on the pure layer: take out 12 of a 20 cap, and only 8 is left.
    const settings = { ...loose, cashDailyMax: 20 };
    const txs = [];
    const first = SC.validate({ account: { balance: 100 }, transactions: txs, camper: 'Eli', date: D, settings, amount: 12 });
    assert.strictEqual(first.ok, true);
    txs.push(SC.buildTransaction({ camper: 'Eli', amount: first.amount, date: D }));

    const second = SC.validate({ account: { balance: 88 }, transactions: txs, camper: 'Eli', date: D, settings, amount: 12 });
    assert.strictEqual(second.ok, false);
    assert.match(second.error, /Only \$8\.00 available/);
});
