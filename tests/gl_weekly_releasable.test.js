// node --test tests/gl_weekly_releasable.test.js
// Guards the SAFETY CRUX of the [GENERIC-RELEASE-WEEKLY] pass: a weekly-must
// reservation may only be released (filled with something else / converted to
// Sport) when it is NOT now-or-never, i.e. the weekly min can still be met on a
// later camp-day. Releasing on a deadline day would drop the weekly guarantee.
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const GLStagger = require('../gl_stagger.js');

const rel = (minFreq, weekToDate, daysInPeriod, dayOfPeriod) =>
    GLStagger.weeklyReleasable({ minFreq, weekToDate, daysInPeriod, dayOfPeriod });

test('day 1 of 6, owes 1 → releasable (5 later days to place it)', () => {
    assert.strictEqual(rel(1, 0, 6, 1), true);
});

test('LAST day of the period, still owes 1 → NOT releasable (now-or-never)', () => {
    assert.strictEqual(rel(1, 0, 6, 6), false);   // need 1 >= remaining 1
});

test('second-to-last day, owes 1 → releasable (one more day remains)', () => {
    assert.strictEqual(rel(1, 0, 6, 5), true);    // need 1 < remaining 2
});

test('weekly min already met (need <= 0) → releasable regardless of day', () => {
    assert.strictEqual(rel(1, 1, 6, 6), true);    // wtd 1 >= M 1 → met
    assert.strictEqual(rel(3, 3, 5, 5), true);
    assert.strictEqual(rel(3, 5, 5, 5), true);    // over-met
});

test('owes more than days remaining → NOT releasable (must place every remaining day)', () => {
    assert.strictEqual(rel(3, 0, 6, 5), false);   // need 3 >= remaining 2
    assert.strictEqual(rel(2, 0, 6, 5), false);   // need 2 >= remaining 2
});

test('owes fewer than days remaining → releasable', () => {
    assert.strictEqual(rel(2, 0, 6, 4), true);    // need 2 < remaining 3
    assert.strictEqual(rel(3, 1, 6, 3), true);    // need 2 < remaining 4
});

test('no weekly min (minFreq 0 / missing) → releasable (nothing to protect)', () => {
    assert.strictEqual(rel(0, 0, 6, 6), true);
    assert.strictEqual(GLStagger.weeklyReleasable({}), true);
    assert.strictEqual(GLStagger.weeklyReleasable(null), true);
});

test('exact boundary need === remaining is the deadline (NOT releasable)', () => {
    assert.strictEqual(rel(1, 0, 3, 3), false);   // need 1 === remaining 1
    assert.strictEqual(rel(2, 0, 4, 3), false);   // need 2 === remaining 2
    assert.strictEqual(rel(2, 0, 4, 2), true);    // need 2 < remaining 3
});

test('degenerate inputs are clamped, never throw', () => {
    assert.strictEqual(rel(1, 0, 0, 0), false);   // D,e clamp to 1 → remaining 1, need 1 → deadline
    assert.strictEqual(typeof rel(1, 0, -3, -3), 'boolean');
});
