// =============================================================================
// post_edit_pinned_field_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the post-edit field-picker bug:
//   "I did a post-edit, picked a sport, and the system said Gym 1 was available
//    — but Gym 1 was already reserved via a custom pinned tile for another grade."
//
// THE BUG: findFieldsForActivity (unified_schedule_system.js, the post-edit
// modal's "available fields" search) decides a facility is free using only
// NAME-based gates (checkLocationConflict / checkFieldAvailableByTime), which
// match an occupied facility by entry.field / _location / _activity.
//
// A custom pinned tile, however, stores the EVENT NAME in entry.field/_activity
// and the REAL facility in entry._reservedFields[] (e.g. field:"ABBL",
// _reservedFields:["Gym 1"]). So the name-based gates never see "Gym 1" → the
// picker reports the reserved facility as OPEN → the user can double-book it.
//
// THE FIX: scan _reservedFields[] (the pin's real facilities) for time-overlap
// and mark those facilities busy ("reserved") — mirroring the GlobalFieldLocks
// pinned lock + the manual free-fill _fieldPinLocked76 guard.
//
// This sim reproduces BOTH the buggy name-only gate (old=miss) and the new
// _reservedFields scan (new=block) against the same realistic schedule.
// =============================================================================

'use strict';
const assert = require('assert');

function fieldLabel(f) { return typeof f === 'string' ? f : (f && f.name) || ''; }

// ---- world: 10:00–10:45 slot, two divisions sharing a campus ---------------
const divisionTimes = {
    '5th Grade': [{ startMin: 600, endMin: 645 }],
    '6th Grade': [{ startMin: 600, endMin: 645 }],
};
const divisions = {
    '5th Grade': { bunks: ['5A'] },
    '6th Grade': { bunks: ['6A'] },
};

// 6A holds a CUSTOM PINNED tile reserving "Gym 1" for the 10:00–10:45 window.
// Note the shape: field is the EVENT NAME, the facility lives in _reservedFields.
const scheduleAssignments = {
    '6A': [{
        field: 'Basketball League',
        _activity: 'Basketball League',
        _pinned: true,
        _fixed: true,
        _reservedFields: ['Gym 1'],
        _startMin: 600, _endMin: 645,
    }],
    '5A': [{ field: 'Free', _activity: 'Free', _startMin: 600, _endMin: 645 }],
};

const world = { divisionTimes, divisions, scheduleAssignments };

// ---- OLD: the name-only gate (what shipped before the fix) ------------------
// Returns true if the facility looks "in use" by NAME at [startMin,endMin].
function nameOnlyOccupied(world, fieldName, startMin, endMin, excludeBunk) {
    for (const [divName, divData] of Object.entries(world.divisions)) {
        const divSlots = world.divisionTimes[divName] || [];
        for (const b of divData.bunks) {
            if (String(b) === String(excludeBunk)) continue;
            const asg = world.scheduleAssignments[b] || [];
            for (let i = 0; i < Math.max(divSlots.length, asg.length); i++) {
                const e = asg[i];
                if (!e || e.continuation) continue;
                const si = divSlots[i];
                const oS = typeof e._startMin === 'number' ? e._startMin : si && si.startMin;
                const oE = typeof e._endMin === 'number' ? e._endMin : si && si.endMin;
                if (oS == null || oE == null) continue;
                if (oE <= startMin || oS >= endMin) continue;
                const entryField = fieldLabel(e.field);
                const entryLoc = e._location || entryField;
                const entryAct = e._activity || entryField;
                const f = fieldName.toLowerCase();
                if (entryField.toLowerCase() === f || entryLoc.toLowerCase() === f || entryAct.toLowerCase() === f) {
                    return true;
                }
            }
        }
    }
    return false;
}

// ---- NEW: the _reservedFields scan added by the fix ------------------------
function getPinnedReservedFieldsInTimeRange(world, startMin, endMin, excludeBunk) {
    const result = new Set();
    if (startMin == null || endMin == null) return result;
    for (const [divName, divData] of Object.entries(world.divisions)) {
        const divSlots = world.divisionTimes[divName] || [];
        for (const b of divData.bunks) {
            if (String(b) === String(excludeBunk)) continue;
            const asg = world.scheduleAssignments[b] || [];
            for (let i = 0; i < Math.max(divSlots.length, asg.length); i++) {
                const e = asg[i];
                if (!e || e.continuation) continue;
                const rf = Array.isArray(e._reservedFields) ? e._reservedFields.filter(Boolean) : [];
                if (!rf.length) continue;
                const si = divSlots[i];
                const oS = typeof e._startMin === 'number' ? e._startMin : si && si.startMin;
                const oE = typeof e._endMin === 'number' ? e._endMin : si && si.endMin;
                if (oS == null || oE == null) continue;
                if (oE <= startMin || oS >= endMin) continue;
                rf.forEach(x => result.add(String(x).toLowerCase()));
                const loc = typeof e._location === 'string' && e._location.trim() ? e._location.trim().toLowerCase() : null;
                if (loc) result.add(loc);
            }
        }
    }
    return result;
}

let pass = 0;
function test(name, fn) { fn(); console.log('  ✓ ' + name); pass++; }

console.log('post_edit_pinned_field_sim');

// 1. BUG REPRO: the old name-only gate misses the pin → Gym 1 looks FREE.
test('OLD name-only gate misses the pin (bug repro): Gym 1 reported free', () => {
    const occupied = nameOnlyOccupied(world, 'Gym 1', 600, 645, '5A');
    assert.equal(occupied, false, 'name-only gate should (wrongly) see Gym 1 as free');
});

// 2. FIX: the _reservedFields scan catches the pin → Gym 1 is reserved.
test('NEW reserved-fields scan blocks Gym 1 for the editing bunk', () => {
    const pinned = getPinnedReservedFieldsInTimeRange(world, 600, 645, '5A');
    assert.ok(pinned.has('gym 1'), 'Gym 1 must be reported as pinned-reserved');
});

// 3. A non-reserved court is still free (no over-blocking).
test('an unrelated court (Gym 2) stays free', () => {
    const pinned = getPinnedReservedFieldsInTimeRange(world, 600, 645, '5A');
    assert.ok(!pinned.has('gym 2'), 'Gym 2 was never reserved — must stay open');
});

// 4. Disjoint time window: a pin at a different time does not block.
test('pin outside the edited window does not block', () => {
    const pinned = getPinnedReservedFieldsInTimeRange(world, 700, 745, '5A');
    assert.ok(!pinned.has('gym 1'), 'no time overlap → no reservation');
});

// 5. The pin owner editing its OWN slot is excluded (can re-edit its own tile).
test("the pin's own bunk is excluded from its reservation", () => {
    const pinned = getPinnedReservedFieldsInTimeRange(world, 600, 645, '6A');
    assert.ok(!pinned.has('gym 1'), "excludeBunk=6A → 6A's own pin is not self-blocking");
});

// 6. Normal sport entries (real field in entry.field, no _reservedFields) are
//    NOT swept into the reserved set — capacity gates handle those.
test('normal entries without _reservedFields are not over-blocked', () => {
    const w2 = {
        divisionTimes,
        divisions: { '6th Grade': { bunks: ['6A'] } },
        scheduleAssignments: { '6A': [{ field: 'Gym 1', _activity: 'Basketball', _startMin: 600, _endMin: 645 }] },
    };
    const pinned = getPinnedReservedFieldsInTimeRange(w2, 600, 645, '5A');
    assert.ok(!pinned.has('gym 1'), 'a normal sport on Gym 1 is handled by capacity gates, not the pin scan');
});

console.log('\n' + pass + '/6 passed');
if (pass !== 6) process.exit(1);
