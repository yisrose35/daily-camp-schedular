// =============================================================================
// field_lock_time_collision_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the "New Gym 1" double-book: a LEAGUE game and a regular
// BUNK activity landed on the same court at the same time.
//
// Root cause: GlobalFieldLocks._locks is keyed by per-division SLOT INDEX. The
// same index is a different clock time in each division's grid. A pinned event
// (ABBL @ 2:50pm, div A, index 1) and a league game (4th/5th @ 1:25pm, div B,
// index 1) collide on the same (index, field) key. The old lockField refused
// the second lock outright, so the league's court lock was silently DROPPED —
// the court looked free at 1:25pm and the solver placed a bunk there.
//
// Fix: lockField is now TIME-AWARE — it only refuses a colliding lock when the
// two windows actually OVERLAP; for disjoint times sharing an index it keeps
// BOTH (stored under a time-qualified key). isFieldLockedByTime scans every key
// so the solver's time-based check then sees the league's lock and skips it.
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

const FIELD = 'New Gym 1';

// =============================================================================
// TEST 1 — disjoint-time locks sharing an index are BOTH preserved
// =============================================================================
GFL.reset();
{
    // ABBL pinned event: div A, slot index 1 = 2:50pm-4:10pm (890-970)
    const okA = GFL.lockField(FIELD, [1], {
        lockedBy: 'pinned_event_location', division: 'A',
        activity: 'ABBL (pinned @ New Gym 1)', startMin: 890, endMin: 970,
    });
    assert.strictEqual(okA, true, 'ABBL lock registers');

    // 4th/5th league: div B, slot index 1 = 1:25pm-2:30pm (805-870) — SAME index
    const okB = GFL.lockField(FIELD, [1], {
        lockedBy: 'regular_league', division: 'B',
        leagueName: '4th and 5th Grade League', startMin: 805, endMin: 870,
    });
    assert.strictEqual(okB, true, 'league lock at the same index but disjoint time is PRESERVED (was dropped)');

    // The solver placing a bunk at 1:25pm (its own grid) must now SEE the league lock.
    const hitLeague = GFL.isFieldLockedByTime(FIELD, 805, 870, '7');
    assert.ok(hitLeague && hitLeague.leagueName === '4th and 5th Grade League',
        'solver-style time check finds the league lock @1:25pm → bunk is kept off New Gym 1');

    // ABBL's own lock is still intact at its real time.
    const hitAbbl = GFL.isFieldLockedByTime(FIELD, 890, 970, '8');
    assert.ok(hitAbbl && hitAbbl.lockedBy === 'pinned_event_location',
        'ABBL lock still found at 2:50pm');
}
console.log('TEST 1 PASS — pinned + league at the same index, disjoint times → both locks preserved');

// =============================================================================
// TEST 2 — a genuine SAME-TIME conflict is still refused (no over-permissive)
// =============================================================================
GFL.reset();
{
    GFL.lockField(FIELD, [1], { lockedBy: 'regular_league', division: 'B',
        leagueName: 'League X', startMin: 805, endMin: 870 });
    // Another use that genuinely OVERLAPS 1:25-2:30 must be refused.
    const okOverlap = GFL.lockField(FIELD, [1], { lockedBy: 'regular_league', division: 'C',
        leagueName: 'League Y', startMin: 810, endMin: 860 });
    assert.strictEqual(okOverlap, false, 'an actually-overlapping lock is still refused');
    // And the original still wins.
    const hit = GFL.isFieldLockedByTime(FIELD, 820, 850, '7');
    assert.ok(hit && hit.leagueName === 'League X', 'original same-time lock preserved');
}
console.log('TEST 2 PASS — genuinely overlapping locks are still refused (no double-booking allowed)');

// =============================================================================
// TEST 3 — a free field stays free; unknown-time locks keep old strict behavior
// =============================================================================
GFL.reset();
{
    assert.strictEqual(GFL.isFieldLockedByTime('Three Point Court', 805, 870, '7'), null,
        'an untouched field stays available');
    // Two locks with UNKNOWN times at the same index → old strict refuse (safe).
    GFL.lockField('Court Z', [2], { lockedBy: 'x', division: 'A' });
    const ok2 = GFL.lockField('Court Z', [2], { lockedBy: 'y', division: 'B' });
    assert.strictEqual(ok2, false, 'no-time locks keep the old strict refuse (no regression)');
}
console.log('TEST 3 PASS — free fields stay free; timeless locks keep strict behavior');

console.log('\nALL 3 FIELD-LOCK TIME-COLLISION TESTS PASS');
