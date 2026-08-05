// node --test tests/payments_deposit.test.js
// Validates the per-camper deposit math:
//   • a deposit multiplies by camper count, not by family
//   • each camper is capped at what they actually owe
//   • family-level payments are allocated across campers before the cap applies
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_payments.js');

const owed = (...pairs) => pairs.map(([name, amount]) => ({ name, owed: amount }));

test('a per-camper deposit scales with the number of campers', () => {
    const r = P.perCamperDeposit(owed(['Ari', 3000], ['Bina', 3000], ['Caleb', 3000]), 500);
    assert.strictEqual(r.total, 1500);
    assert.deepStrictEqual(r.lines.map(l => l.deposit), [500, 500, 500]);
    assert.strictEqual(r.cappedCount, 0);

    // One camper is still one deposit — the family-level case falls out of the
    // same rule rather than needing a branch.
    assert.strictEqual(P.perCamperDeposit(owed(['Ari', 3000]), 500).total, 500);
});

test('no camper is charged more than they owe', () => {
    // Bina has a scholarship and owes less than the deposit; Caleb owes nothing.
    const r = P.perCamperDeposit(owed(['Ari', 3000], ['Bina', 180], ['Caleb', 0]), 500);
    assert.deepStrictEqual(r.lines.map(l => l.deposit), [500, 180, 0]);
    assert.strictEqual(r.total, 680);
    assert.strictEqual(r.cappedCount, 2);
    assert.deepStrictEqual(r.lines.map(l => l.capped), [false, true, true]);
});

test('a credit balance owes nothing rather than reducing the family total', () => {
    // A negative balance must floor at zero — subtracting it would quietly
    // discount the other campers' deposits.
    const r = P.perCamperDeposit(owed(['Ari', 3000], ['Bina', -250]), 500);
    assert.strictEqual(r.total, 500);
    assert.strictEqual(r.lines[1].deposit, 0);
    assert.strictEqual(r.lines[1].owed, 0);
});

test('a zero or missing deposit produces no charge at all', () => {
    for (const each of [0, -100, null, undefined, '']) {
        const r = P.perCamperDeposit(owed(['Ari', 3000]), each);
        assert.strictEqual(r.total, 0, `deposit of ${each} must charge nothing`);
        assert.deepStrictEqual(r.lines, []);
    }
    // No campers is a zero total, not a crash.
    assert.strictEqual(P.perCamperDeposit([], 500).total, 0);
    assert.strictEqual(P.perCamperDeposit(null, 500).total, 0);
});

test('the total is money-rounded, not left with float drift', () => {
    const r = P.perCamperDeposit(owed(['Ari', 33.33], ['Bina', 33.33], ['Caleb', 33.34]), 100);
    assert.strictEqual(r.total, 100);
    assert.ok(Number.isInteger(Math.round(r.total * 100)));
});

test('family payments are allocated across campers before the deposit is capped', () => {
    // The family paid $3,200 against three $3,000 tuitions: the first camper is
    // settled, the second is partly paid, the third untouched.
    const alloc = P.allocateFamilyPayments(
        [{ name: 'Ari', amount: 3000 }, { name: 'Bina', amount: 3000 }, { name: 'Caleb', amount: 3000 }],
        3200,
    );
    assert.deepStrictEqual(alloc, [
        { name: 'Ari', owed: 0 },
        { name: 'Bina', owed: 2800 },
        { name: 'Caleb', owed: 3000 },
    ]);

    // Ari is fully paid, so no deposit is taken for them.
    const r = P.perCamperDeposit(alloc, 500);
    assert.deepStrictEqual(r.lines.map(l => l.deposit), [0, 500, 500]);
    assert.strictEqual(r.total, 1000);
});

test('allocation sums repeated charges for the same camper and never goes negative', () => {
    // A camper with two sessions is one camper owing the sum of both.
    const alloc = P.allocateFamilyPayments(
        [{ name: 'Ari', amount: 1000 }, { name: 'Bina', amount: 1000 }, { name: 'Ari', amount: 500 }],
        0,
    );
    assert.deepStrictEqual(alloc, [{ name: 'Ari', owed: 1500 }, { name: 'Bina', owed: 1000 }]);

    // Overpayment settles everyone and stops at zero.
    const paid = P.allocateFamilyPayments([{ name: 'Ari', amount: 1000 }], 9999);
    assert.deepStrictEqual(paid, [{ name: 'Ari', owed: 0 }]);
    // A negative payment total is treated as nothing collected.
    assert.deepStrictEqual(P.allocateFamilyPayments([{ name: 'Ari', amount: 1000 }], -50),
        [{ name: 'Ari', owed: 1000 }]);
});
