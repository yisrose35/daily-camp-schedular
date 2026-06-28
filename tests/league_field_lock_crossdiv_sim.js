// =============================================================================
// league_field_lock_crossdiv_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the cross-league field DOUBLE-BOOK bug:
//   "the program for leagues gave out Swish City twice"
//
// Two different leagues run at the SAME wall-clock time in DIFFERENT divisions.
// League A assigns + globally locks a field (Swish City). League B then builds
// its field pool and is supposed to see that lock and skip the field.
//
// THE BUG: the league code derived each period's lock/query time window by
// indexing a SHARED `slots` array (taken from one division's block) into EACH
// league's OWN divisionTimes grid. In manual mode divisions have different
// skeletons, so the same slot INDEX is a different clock time per division.
// League B's query window then didn't overlap League A's lock window → the lock
// was missed → the field was handed out twice.
//
// THE FIX: anchor the window on the authoritative wall-clock `timeKey` (the
// shared period start for every division). Any two same-start windows overlap,
// so League B reliably sees League A's lock.
//
// This sim drives the REAL global_field_locks.js to prove old=miss, new=block.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// --- Minimal browser shims so global_field_locks.js (an IIFE) can load --------
let _now = 1;
global.window = {
    divisionTimes: {},
    addEventListener: () => {},
    DEBUG_GLOBAL_LOCKS: false,
};
global.document = { readyState: 'complete', addEventListener: () => {} };
global.Date = class extends Date { static now() { return _now++; } };

// Load the real lock module (attaches window.GlobalFieldLocks)
const src = fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(src);
const GFL = global.window.GlobalFieldLocks;
assert.ok(GFL, 'GlobalFieldLocks loaded');

// --- Scenario: two divisions, MISALIGNED slot grids, same period start --------
// Both leagues' period starts at 780 (1:00pm). Note the league block sits at a
// DIFFERENT slot index in each division because their skeletons differ.
const TIME_KEY = 780;               // shared wall-clock start for the period
global.window.divisionTimes = {
    // Soloists: league block is slot index 3
    Soloists: [
        { startMin: 650, endMin: 700 },
        { startMin: 700, endMin: 740 },
        { startMin: 740, endMin: 780 },
        { startMin: 780, endMin: 825 },   // <- the league period (slot 3)
    ],
    // Majors: league block is slot index 1; slot 3 is a TOTALLY different time
    Majors: [
        { startMin: 650, endMin: 780 },
        { startMin: 780, endMin: 825 },   // <- the league period (slot 1)
        { startMin: 825, endMin: 900 },
        { startMin: 900, endMin: 945 },   // <- slot 3 here is 3:00pm, not 1:00pm
    ],
};

// `slots` is taken from allBlocks[0] — say the Soloists block — so slots = [3].
const SHARED_SLOTS = [3];
const FIELD = 'Swish City';

// Helpers mirroring the two derivation strategies ------------------------------
function oldLockWindow(leagueDiv) {
    const g = global.window.divisionTimes[leagueDiv] || [];
    const s = g[SHARED_SLOTS[0]] ? g[SHARED_SLOTS[0]].startMin : null;
    const e = g[SHARED_SLOTS[SHARED_SLOTS.length - 1]]
        ? g[SHARED_SLOTS[SHARED_SLOTS.length - 1]].endMin : (s != null ? s + 40 : null);
    return { startMin: s, endMin: e };
}
function newWindow(leagueDiv) {
    // Anchor on timeKey; end best-effort from this division's grid, guarded.
    const g = global.window.divisionTimes[leagueDiv] || [];
    let s = TIME_KEY;
    let e = g[SHARED_SLOTS[SHARED_SLOTS.length - 1]] ? g[SHARED_SLOTS[SHARED_SLOTS.length - 1]].endMin : null;
    if (e == null || e <= s) e = s + 40;
    return { startMin: s, endMin: e };
}

// =============================================================================
// TEST 1 — OLD derivation reproduces the double-book (lock MISSED)
// =============================================================================
GFL.reset();
{
    const aWin = oldLockWindow('Soloists');   // League A locks Swish City
    GFL.lockField(FIELD, SHARED_SLOTS, {
        lockedBy: 'regular_league', leagueName: 'A', division: 'Soloists',
        startMin: aWin.startMin, endMin: aWin.endMin,
    });
    const bWin = oldLockWindow('Majors');     // League B queries its (mis-derived) window
    const hit = GFL.isFieldLockedByTime(FIELD, bWin.startMin, bWin.endMin, 'Majors');
    assert.strictEqual(hit, null,
        'OLD derivation should MISS the lock (this is the bug being fixed)');
}
console.log('TEST 1 PASS — old slot-index derivation misses the lock → field double-booked (bug reproduced)');

// =============================================================================
// TEST 2 — NEW derivation blocks the double-book (lock SEEN)
// =============================================================================
GFL.reset();
{
    const aWin = newWindow('Soloists');       // League A locks with timeKey-anchored window
    GFL.lockField(FIELD, SHARED_SLOTS, {
        lockedBy: 'regular_league', leagueName: 'A', division: 'Soloists',
        startMin: aWin.startMin, endMin: aWin.endMin,
    });
    const bWin = newWindow('Majors');         // League B queries timeKey-anchored window
    const hit = GFL.isFieldLockedByTime(FIELD, bWin.startMin, bWin.endMin, 'Majors');
    assert.ok(hit && hit.leagueName === 'A',
        'NEW derivation must SEE League A\'s lock so League B skips the field');
}
console.log('TEST 2 PASS — timeKey-anchored window sees the lock → second league skips the field (fixed)');

// =============================================================================
// TEST 3 — NEW derivation still leaves a genuinely-free field available
// =============================================================================
GFL.reset();
{
    const aWin = newWindow('Soloists');
    GFL.lockField('Swish City', SHARED_SLOTS, {
        lockedBy: 'regular_league', leagueName: 'A', division: 'Soloists',
        startMin: aWin.startMin, endMin: aWin.endMin,
    });
    const bWin = newWindow('Majors');
    // A DIFFERENT, unlocked field must remain free for League B.
    const free = GFL.isFieldLockedByTime('Baseball Field 2', bWin.startMin, bWin.endMin, 'Majors');
    assert.strictEqual(free, null, 'an unlocked field stays available — no over-blocking');
}
console.log('TEST 3 PASS — unlocked fields stay available (no over-blocking)');

console.log('\nALL 3 CROSS-DIVISION FIELD-LOCK TESTS PASS');
