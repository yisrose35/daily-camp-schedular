// node --test tests/family_merge.test.js
// Validates merging two duplicate family records:
//   • custom field values survive in BOTH directions — the headline bug
//   • money adds up rather than one record's totals winning
//   • campers under both families are reported as duplicates, not silently lost
//   • plans and saved cards, which can't be summed, resolve to the kept family
const test = require('node:test');
const assert = require('node:assert');
const M = require('../campistry_family_merge.js');

const hh = (name, email, address) => ({
    label: 'Primary', address: address || '', billingContact: true,
    parents: [{ name: name, email: email || '', phone: '', relation: 'Parent' }],
});

test('a blank on the target never overwrites a real value on the source', () => {
    // The headline bug: the kept record had no custom field values, so merging
    // wiped the ones the absorbed record was carrying.
    const target = { cf_shirt: '', cf_bus: 'Route 4', notes: '' };
    const source = { cf_shirt: 'Adult M', cf_bus: '', notes: 'Allergic to bees' };

    const r = M.reconcileFields(target, source);
    assert.strictEqual(r.merged.cf_shirt, 'Adult M', 'source value must fill the target blank');
    assert.strictEqual(r.merged.cf_bus, 'Route 4', 'target value must survive a source blank');
    assert.strictEqual(r.merged.notes, 'Allergic to bees');
    assert.deepStrictEqual(r.conflicts, []);
    assert.ok(r.recovered.includes('cf_shirt'));
});

test('a real conflict keeps the target and reports what it discarded', () => {
    const r = M.reconcileFields({ cf_shirt: 'Youth L' }, { cf_shirt: 'Adult M' });
    assert.strictEqual(r.merged.cf_shirt, 'Youth L');
    assert.deepStrictEqual(r.conflicts, [{ key: 'cf_shirt', kept: 'Youth L', discarded: 'Adult M' }]);
});

test('values that only differ by case or padding are not a conflict', () => {
    const r = M.reconcileFields({ cf_shirt: 'Adult M' }, { cf_shirt: '  adult m ' });
    assert.deepStrictEqual(r.conflicts, []);
    assert.strictEqual(r.merged.cf_shirt, 'Adult M');
});

test('array fields concatenate instead of one list beating the other', () => {
    const r = M.reconcileFields({ documents: ['a.pdf'] }, { documents: ['b.pdf'] });
    assert.deepStrictEqual(r.merged.documents, ['a.pdf', 'b.pdf']);
    assert.deepStrictEqual(r.conflicts, []);
});

test('merging a family adds the money rather than picking a side', () => {
    const target = { name: 'Weiss Family', balance: 1200, totalPaid: 800, camperIds: ['Ari Weiss'] };
    const source = { name: 'Weiss Family', balance: 600, totalPaid: 300, camperIds: ['Bina Weiss'] };

    const r = M.planMerge(target, source);
    assert.strictEqual(r.family.balance, 1800);
    assert.strictEqual(r.family.totalPaid, 1100);
    assert.deepStrictEqual(r.family.camperIds, ['Ari Weiss', 'Bina Weiss']);
    assert.deepStrictEqual(r.movedCampers, ['Bina Weiss']);
    assert.deepStrictEqual(r.duplicateCampers, []);
});

test('charges and fee history concatenate, with history left in time order', () => {
    const r = M.planMerge(
        { charges: [{ id: 'a', amount: 50 }], feeHistory: [{ at: '2026-03-01', action: 'added' }] },
        { charges: [{ id: 'b', amount: 25 }], feeHistory: [{ at: '2026-01-15', action: 'added' }] },
    );
    assert.strictEqual(r.family.charges.length, 2);
    assert.deepStrictEqual(r.family.feeHistory.map(x => x.at), ['2026-01-15', '2026-03-01']);
});

test('a camper under both families is flagged, not duplicated in the roster list', () => {
    const r = M.planMerge(
        { camperIds: ['Ari Weiss', 'Bina Weiss'] },
        { camperIds: ['ari weiss', 'Caleb Weiss'] },
    );
    assert.deepStrictEqual(r.duplicateCampers, ['ari weiss']);
    assert.deepStrictEqual(r.family.camperIds, ['Ari Weiss', 'Bina Weiss', 'Caleb Weiss']);
    assert.ok(r.warnings.some(w => /appears under both/.test(w)));
});

test('duplicate camper records combine field-by-field, keeping custom fields', () => {
    const r = M.mergeCamperRecords(
        { school: 'PS 11', cf_shirt: '', history: [{ ts: '2026-02-01', type: 'edit' }] },
        { school: '', cf_shirt: 'Adult M', teacher: 'Mrs Rho', history: [{ ts: '2026-01-01', type: 'created' }] },
    );
    assert.strictEqual(r.merged.school, 'PS 11');
    assert.strictEqual(r.merged.cf_shirt, 'Adult M');
    assert.strictEqual(r.merged.teacher, 'Mrs Rho');
    assert.deepStrictEqual(r.merged.history.map(h => h.ts), ['2026-01-01', '2026-02-01']);
});

test('two monthly plans cannot be summed — the kept family keeps its schedule', () => {
    const tPlan = { installments: [{ n: 1, amount: 400 }], autopay: true };
    const sPlan = { installments: [{ n: 1, amount: 250 }], autopay: false };

    const r = M.planMerge({ plan: tPlan }, { plan: sPlan });
    assert.strictEqual(r.family.plan, tPlan);
    assert.strictEqual(r.planConflict, true);
    assert.ok(r.warnings.some(w => /monthly plan/i.test(w)));

    // Only one side has a plan → it is adopted, with no warning to raise.
    const only = M.planMerge({}, { plan: sPlan });
    assert.strictEqual(only.family.plan, sPlan);
    assert.strictEqual(only.planConflict, false);
});

test('a saved card is adopted when the kept family has none, and flagged when both do', () => {
    const adopted = M.planMerge({}, { cardOnFile: true, stripeCustomerId: 'cus_B' });
    assert.strictEqual(adopted.family.cardOnFile, true);
    assert.strictEqual(adopted.family.stripeCustomerId, 'cus_B');
    assert.strictEqual(adopted.cardConflict, false);

    const both = M.planMerge(
        { cardOnFile: true, stripeCustomerId: 'cus_A' },
        { cardOnFile: true, stripeCustomerId: 'cus_B' },
    );
    assert.strictEqual(both.family.stripeCustomerId, 'cus_A');
    assert.strictEqual(both.cardConflict, true);

    // The same Stripe customer on both records is not a conflict.
    const same = M.planMerge(
        { cardOnFile: true, stripeCustomerId: 'cus_A' },
        { cardOnFile: true, stripeCustomerId: 'cus_A' },
    );
    assert.strictEqual(same.cardConflict, false);
});

test('households dedupe on parent email and absorb a parent listed on only one side', () => {
    const target = { households: [hh('Dov Weiss', 'dov@example.com', '4 Elm St')] };
    const source = {
        households: [
            Object.assign(hh('Dov Weiss', 'DOV@example.com', '4 Elm St'),
                { parents: [{ name: 'Dov Weiss', email: 'dov@example.com' }, { name: 'Rivka Weiss', email: 'rivka@example.com' }] }),
            hh('Someone Else', 'other@example.com', '9 Oak Ave'),
        ],
    };
    const r = M.planMerge(target, source);
    assert.strictEqual(r.family.households.length, 2, 'the matching household must not be duplicated');
    const names = r.family.households[0].parents.map(p => p.name);
    assert.deepStrictEqual(names, ['Dov Weiss', 'Rivka Weiss']);
});

test('reserved keys are computed, never copied field-by-field', () => {
    // Copying balance through reconcileFields would take one side's number
    // instead of the sum.
    const r = M.planMerge({ balance: 100, camperIds: ['A'] }, { balance: 50, camperIds: ['B'] });
    assert.strictEqual(r.family.balance, 150);
    assert.deepStrictEqual(r.family.camperIds, ['A', 'B']);
});

test('duplicate detection scores families on shared identity signals', () => {
    const families = {
        f1: { name: 'Weiss Family', households: [hh('Dov Weiss', 'dov@example.com', '4 Elm St')] },
        f2: { name: 'Weiss Family', households: [hh('Dov Weiss', 'dov@example.com', '4 Elm Street')] },
        f3: { name: 'Cohen Family', households: [hh('Sara Cohen', 'sara@example.com', '9 Oak Ave')] },
    };
    const dupes = M.findDuplicates(families);
    assert.strictEqual(dupes.length, 1);
    assert.deepStrictEqual(dupes[0].keys.sort(), ['f1', 'f2']);
    assert.strictEqual(dupes[0].confidence, 'high');   // name + email + parent
    // An unrelated family is never paired.
    assert.ok(!dupes.some(d => d.keys.includes('f3')));
    // A single family, or none, produces no pairs.
    assert.deepStrictEqual(M.findDuplicates({ f1: families.f1 }), []);
    assert.deepStrictEqual(M.findDuplicates({}), []);
});

test('merging tolerates empty and missing records without throwing', () => {
    const r = M.planMerge({}, {});
    assert.deepStrictEqual(r.family.camperIds, []);
    assert.strictEqual(r.family.balance, 0);
    assert.deepStrictEqual(r.warnings, []);
    assert.doesNotThrow(() => M.planMerge(null, null));
    assert.doesNotThrow(() => M.mergeCamperRecords(null, null));
});
