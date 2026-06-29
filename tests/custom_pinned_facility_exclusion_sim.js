// =============================================================================
// custom_pinned_facility_exclusion_sim.js
// -----------------------------------------------------------------------------
// Locks down the invariant: once a CUSTOM PINNED tile reserves a facility,
// NOTHING else may be on that facility anywhere within the tile's wall-clock
// [startMin, endMin] window — leagues, specialty leagues, sports, specials,
// smart/split tiles, electives, free-fill, auto — EXCEPT another custom pinned
// tile (a deliberate user override).
//
// These tests validate the lock-mechanism PROPERTIES the manual-generator fixes
// depend on:
//   • scheduler_core_main STEP 2.45 pre-locks every custom-pinned facility
//     (GLOBAL lock, explicit times) BEFORE electives/leagues/solver run.
//   • The free-fill passes (STEP 7.6 / 7.62 / 7.65) reject any field for which
//     GlobalFieldLocks.isFieldLockedByTime(field, s, e, grade) is truthy.
//
// Property 1: a `pinned_event_location` GLOBAL lock blocks EVERY division
//             (including its own grade) for ANY overlapping time in the window,
//             and leaves disjoint times free. This is what the free-fill guard
//             and the league/solver time checks rely on.
// Property 2: ordering matters — if an elective division-lock is registered
//             FIRST and the pinned lock SECOND (the old STEP-3 order), the pinned
//             GLOBAL lock silently fails and the elective's own grade can reuse
//             the facility (the bug). Registering pinned FIRST (STEP 2.45) makes
//             the elective yield and pinned win.
// Property 3: pinned-vs-pinned coexists — a second pinned tile is never blocked
//             from the facility (placement is unconditional); the lock stays in
//             place so non-pinned consumers remain excluded.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let _now = 1;
global.window = { divisionTimes: {}, addEventListener: () => {}, DEBUG_GLOBAL_LOCKS: false };
global.document = { readyState: 'complete', addEventListener: () => {} };
global.Date = class extends Date { static now() { return _now++; } };

const src = fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8');
(0, eval)(src);
const GFL = global.window.GlobalFieldLocks;
assert.ok(GFL, 'GlobalFieldLocks loaded');

const FIELD = 'Basketball – Court 1';
// Custom pinned "Assembly" reserving Court 1 for division A, 11:00am-11:30am.
const PIN = { lockedBy: 'pinned_event_location', division: 'A', startMin: 660, endMin: 690,
              activity: 'Assembly (pinned @ Basketball – Court 1)' };

// The exact guard the free-fill passes use (mirror of _fieldPinLocked76).
const freeFillGuard = (field, s, e, grade) =>
    !!(GFL.isFieldLockedByTime && GFL.isFieldLockedByTime(field, s, e, grade));

// =============================================================================
// TEST 1 — pinned facility is excluded for EVERY division, full overlap window
// =============================================================================
GFL.reset();
{
    assert.strictEqual(GFL.lockField(FIELD, [1], PIN), true, 'pinned facility lock registers');

    // Free-fill / solver in the PINNED tile's OWN grade A → blocked.
    assert.ok(freeFillGuard(FIELD, 660, 690, 'A'), "own grade A blocked for the full window");
    // A FOREIGN division B (different slot grid) → blocked by wall-clock time.
    assert.ok(freeFillGuard(FIELD, 660, 690, 'B'), 'foreign grade B blocked');
    // Partial overlaps at both edges → blocked.
    assert.ok(freeFillGuard(FIELD, 640, 665, 'B'), 'overlap at the leading edge blocked');
    assert.ok(freeFillGuard(FIELD, 685, 720, 'C'), 'overlap at the trailing edge blocked');
    // A DISJOINT time on the same facility → free (no over-block).
    assert.ok(!freeFillGuard(FIELD, 690, 720, 'A'), 'disjoint time after the window stays free');
    assert.ok(!freeFillGuard(FIELD, 600, 660, 'A'), 'disjoint time before the window stays free');
    // A DIFFERENT facility → free.
    assert.ok(!freeFillGuard('Soccer Field', 660, 690, 'B'), 'an unrelated facility stays free');

    console.log('TEST 1 PASS — pinned facility blocked for every grade across its whole window; disjoint times & other fields stay free');
}

// =============================================================================
// TEST 2a — BUG REPRO: elective-first ordering lets the pinned tile lose
// =============================================================================
GFL.reset();
{
    // OLD order: elective (STEP 2.5) reserves Court 1 for grade A FIRST...
    assert.strictEqual(
        GFL.lockFieldForDivision(FIELD, [1], 'A', 'Elective (A)', { startMin: 660, endMin: 690 }),
        true, 'elective division-lock registers first');
    // ...then the pinned tile (old STEP-3 order) tries to GLOBAL-lock the same slot.
    const pinnedOk = GFL.lockField(FIELD, [1], PIN);
    assert.strictEqual(pinnedOk, false, 'pinned GLOBAL lock SILENTLY FAILS on the shared slot (the bug)');
    // Result: the elective division-lock exempts grade A → A can reuse the facility.
    assert.ok(!freeFillGuard(FIELD, 660, 690, 'A'),
        "BUG: pinned tile's own-region check leaves grade A free to reuse the facility");

    console.log('TEST 2a PASS — bug reproduced: elective-first order lets the elective grade reuse a pinned facility');
}

// =============================================================================
// TEST 2b — FIX: pinned pre-lock (STEP 2.45) before electives → pinned wins
// =============================================================================
GFL.reset();
{
    // NEW order: STEP 2.45 pre-locks the pinned facility GLOBALLY FIRST...
    assert.strictEqual(GFL.lockField(FIELD, [1], PIN), true, 'pinned GLOBAL pre-lock registers first');
    // ...then the elective (STEP 2.5) tries to reserve the same slot → must yield.
    const electiveOk = GFL.lockFieldForDivision(FIELD, [1], 'A', 'Elective (A)', { startMin: 660, endMin: 690 });
    assert.strictEqual(electiveOk, false, 'elective yields to the existing pinned GLOBAL lock');
    // Now even the pinned tile's OWN grade A is blocked → pinned wins over the elective.
    assert.ok(freeFillGuard(FIELD, 660, 690, 'A'), 'grade A blocked — pinned wins over its own elective');
    assert.ok(freeFillGuard(FIELD, 660, 690, 'Z'), 'every other grade blocked too');

    console.log('TEST 2b PASS — fixed order: pinned pre-lock wins; elective yields; no grade can reuse the facility');
}

// =============================================================================
// TEST 3 — pinned-vs-pinned coexists (the allowed user override)
// =============================================================================
GFL.reset();
{
    assert.strictEqual(GFL.lockField(FIELD, [1], PIN), true, 'first custom pinned locks the facility');

    // A SECOND custom pinned tile on the same facility/time. Its lockField may
    // return false (genuine overlap), but tile PLACEMENT in STEP 3 fills
    // unconditionally — so the second pinned tile still occupies the facility.
    // What matters here: the facility remains locked, so NON-pinned consumers
    // stay excluded. (The second tile's coexistence is a placement concern, not a
    // lock concern; the lock must simply remain.)
    const secondPinnedLock = GFL.lockField(FIELD, [1], {
        lockedBy: 'pinned_event_location', division: 'B', startMin: 660, endMin: 690,
        activity: 'Color War (pinned @ Basketball – Court 1)'
    });
    assert.strictEqual(secondPinnedLock, false, 'second overlapping pinned lock is a no-op (facility already locked)');
    assert.ok(freeFillGuard(FIELD, 660, 690, 'C'), 'facility remains excluded for non-pinned consumers');

    // Two pinned tiles at DISJOINT times on the same facility → both locks kept.
    const laterPin = GFL.lockField(FIELD, [1], {
        lockedBy: 'pinned_event_location', division: 'B', startMin: 700, endMin: 730,
        activity: 'Assembly 2 (pinned @ Basketball – Court 1)'
    });
    assert.strictEqual(laterPin, true, 'a disjoint-time second pinned tile keeps its own lock');
    assert.ok(freeFillGuard(FIELD, 700, 730, 'C'), 'the later pinned window is also excluded');

    console.log('TEST 3 PASS — pinned-vs-pinned: facility stays excluded from non-pinned consumers; disjoint pins both lock');
}

console.log('\nALL CUSTOM-PINNED FACILITY-EXCLUSION TESTS PASS');
