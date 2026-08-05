// node --test tests/setup_checklist.test.js
// Validates the new-camp setup checklist:
//   • steps are derived from the camp's real data, never a separate record
//   • optional steps never hold the checklist open
//   • an established camp is never shown it
const test = require('node:test');
const assert = require('node:assert');
const S = require('../campistry_setup_checklist.js');

const fullySetUp = {
    campName: 'Sunny Acres', campStart: '2026-06-28', campEnd: '2026-08-20',
    divisionCount: 3, bunkCount: 12, sessionCount: 2,
    camperCount: 140, enrollmentCount: 140, campersInBunks: 138,
    staffCount: 20, stripeKey: 'pk_live_x',
};
const brandNew = {
    campName: '', campStart: '', campEnd: '',
    divisionCount: 0, bunkCount: 0, sessionCount: 0,
    camperCount: 0, enrollmentCount: 0, campersInBunks: 0,
    staffCount: 0, stripeKey: '',
};
const byKey = (r, k) => r.steps.find(s => s.key === k);

test('a brand-new camp has everything to do and 0%', () => {
    const r = S.evaluate(brandNew);
    assert.strictEqual(r.completed, 0);
    assert.strictEqual(r.percent, 0);
    assert.strictEqual(r.allRequiredDone, false);
    assert.strictEqual(r.nextStep.key, 'name', 'naming the camp comes first');
});

test('a fully set-up camp is complete and the checklist hides itself', () => {
    const r = S.evaluate(fullySetUp);
    assert.strictEqual(r.completed, r.total);
    assert.strictEqual(r.allRequiredDone, true);
    assert.strictEqual(r.percent, 100);
    assert.strictEqual(r.nextStep, null);
    assert.strictEqual(S.shouldShow(fullySetUp, {}), false);
});

test('optional steps never hold the checklist open', () => {
    // Stripe and staff are real setup, but a camp taking cash and cheques is
    // legitimately finished without them.
    const noStripe = { ...fullySetUp, stripeKey: '', staffCount: 0 };
    const r = S.evaluate(noStripe);
    assert.strictEqual(r.allRequiredDone, true, 'required work is done');
    assert.ok(r.completed < r.total, 'but not every step is ticked');
    assert.strictEqual(r.percent, 100);
    assert.strictEqual(S.shouldShow(noStripe, {}), false, 'must not nag forever');
    assert.strictEqual(byKey(r, 'payments').required, false);
    assert.strictEqual(byKey(r, 'staff').required, false);
});

test('a missing required step keeps the checklist open', () => {
    const noBunks = { ...fullySetUp, campersInBunks: 0 };
    const r = S.evaluate(noBunks);
    assert.strictEqual(r.allRequiredDone, false);
    assert.strictEqual(r.nextStep.key, 'bunks');
    assert.strictEqual(r.nextStep.page, 'bunkbuilder', 'the step has to say where to go');
    assert.ok(S.shouldShow(noBunks, {}));
});

test('steps read live data, so deleting everything unticks them', () => {
    // There is no separate progress record to drift out of step with reality.
    assert.strictEqual(byKey(S.evaluate(fullySetUp), 'structure').done, true);
    const wiped = { ...fullySetUp, divisionCount: 0, bunkCount: 0 };
    assert.strictEqual(byKey(S.evaluate(wiped), 'structure').done, false);
});

test('structure needs both divisions and bunks', () => {
    // Divisions with no bunks underneath is a half-built structure; the next
    // step (placing campers) cannot be done from it.
    const divsOnly = { ...brandNew, divisionCount: 2, bunkCount: 0 };
    assert.strictEqual(byKey(S.evaluate(divsOnly), 'structure').done, false);
    const both = { ...brandNew, divisionCount: 2, bunkCount: 6 };
    assert.strictEqual(byKey(S.evaluate(both), 'structure').done, true);
});

test('campers count whether typed in or arrived by registration', () => {
    const imported = { ...brandNew, camperCount: 40 };
    const registered = { ...brandNew, enrollmentCount: 40 };
    assert.strictEqual(byKey(S.evaluate(imported), 'campers').done, true);
    assert.strictEqual(byKey(S.evaluate(registered), 'campers').done, true);
});

test('camp dates need both ends, not just a start', () => {
    const startOnly = { ...brandNew, campStart: '2026-06-28' };
    assert.strictEqual(byKey(S.evaluate(startOnly), 'dates').done, false);
    const both = { ...startOnly, campEnd: '2026-08-20' };
    assert.strictEqual(byKey(S.evaluate(both), 'dates').done, true);
});

test('whitespace is not a completed step', () => {
    const blank = { ...brandNew, campName: '   ' };
    assert.strictEqual(byKey(S.evaluate(blank), 'name').done, false);
});

test('a dismissed or established camp is never shown the checklist', () => {
    assert.strictEqual(S.shouldShow(brandNew, { dismissed: true }), false);
    // Showing a half-ticked checklist to a camp mid-season reads as
    // "you did this wrong", not as help.
    assert.strictEqual(S.shouldShow(brandNew, { establishedCamp: true }), false);
    assert.strictEqual(S.shouldShow(brandNew, {}), true);
});

test('evaluate survives a missing or malformed state instead of throwing', () => {
    for (const bad of [undefined, null, {}, { divisionCount: 'lots' }]) {
        const r = S.evaluate(bad);
        assert.strictEqual(r.allRequiredDone, false);
        assert.strictEqual(r.total, S.STEPS.length);
    }
});

test('trial days left rounds up and floors at zero', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    assert.strictEqual(S.trialDaysLeft(now + 3 * 86400000, now), 3);
    // Part of a day still counts as a day — telling someone "0 days left"
    // while they still have six hours would be wrong.
    assert.strictEqual(S.trialDaysLeft(now + 6 * 3600000, now), 1);
    assert.strictEqual(S.trialDaysLeft(now - 86400000, now), 0);
    assert.strictEqual(S.trialDaysLeft(null, now), null, 'no trial means no countdown');
});

test('every step names a real page to send the camp to', () => {
    const pages = ['campers', 'structure', 'bunkbuilder', 'enrollment', 'staffing', 'settings'];
    for (const step of S.STEPS) {
        assert.ok(pages.includes(step.page), `${step.key} points at unknown page "${step.page}"`);
        assert.ok(step.label && step.detail, `${step.key} needs a label and detail`);
    }
    const keys = S.STEPS.map(s => s.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'step keys must be unique');
});
