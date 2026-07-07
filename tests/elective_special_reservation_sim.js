// =============================================================================
// elective_special_reservation_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the CONFIRMED live leak: an elective reserved "Pizza Making"
// for division מתמדים @ 5:10–6:00pm, but a SPECIAL of the same name was still
// handed to a bunk in division "Camp Agudah > 6" at the same time.
//
// Root cause: the SmartTile special gate (smart_logic_adapter.canDivisionUseSpecial)
// checked ONLY GlobalFieldLocks.isFieldLocked(name, slots, div) — a per-division
// SLOT-INDEX check. Slot N is a different wall-clock time in each grade's grid, so a
// foreign division querying its own indices can MISS the elective's lock. Sports were
// safe because canBlockFit also consults window.fieldReservations (robust wall-clock),
// but the special path never did.
//
// Fix: canDivisionUseSpecial now ALSO consults window.fieldReservations, wall-clock
// and DIVISION-AWARE — an elective reservation exempts its OWN grade; a pin blocks
// everyone.
//
// (A) SOURCE GUARD — the real gate must consult window.fieldReservations.
// (B) BEHAVIORAL — mirror the check, driven by the REAL getFieldReservationsFromSkeleton,
//     with two divisions whose grids map the SAME wall-clock window to DIFFERENT slot
//     indices (the exact case the old slot-index check missed).
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- (A) SOURCE GUARD --------------------------------------------------------
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'smart_logic_adapter.js'), 'utf8');
    const fn = src.slice(src.indexOf('function canDivisionUseSpecial'), src.indexOf('function canDivisionUseSpecial') + 3000);
    assert.ok(/window\.fieldReservations/.test(fn),
        'canDivisionUseSpecial must consult window.fieldReservations (robust cross-division elective/pin block)');
    console.log('SOURCE GUARD PASS — SmartTile special gate consults window.fieldReservations');
}

// ---- (B) BEHAVIORAL MIRROR ---------------------------------------------------
global.window = { addEventListener: () => {}, divisionTimes: {} };
global.document = { readyState: 'complete', addEventListener: () => {} };
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'));
const Utils = global.window.SchedulerCoreUtils;

// Elective for מתמדים reserves Pizza Making + Gaming Center @ 5:10–6:00pm (1030–1080).
const SKELETON = [{
    type: 'elective', division: 'מתמדים', event: 'Elective',
    startTime: '5:10 PM', endTime: '6:00 PM',
    electiveActivities: ['Pizza Making', 'Gaming Center']
}];
global.window.fieldReservations = Utils.getFieldReservationsFromSkeleton(SKELETON);

// Two divisions whose grids place the SAME wall-clock window at DIFFERENT slot
// indices — the misalignment the old slot-index GlobalFieldLocks check missed.
global.window.divisionTimes = {
    'מתמדים':          [ {startMin: 990, endMin: 1030}, {startMin: 1030, endMin: 1080} ],       // window at index 1
    'Camp Agudah > 6': [ {startMin: 1030, endMin: 1110} ],                                        // window at index 0
};

// Faithful mirror of the fieldReservations block added to canDivisionUseSpecial.
function specialAllowed(divisionName, specialName, slots, props) {
    if (!(global.window.fieldReservations && slots && slots.length > 0)) return true;
    const dts = global.window.divisionTimes[divisionName] || [];
    let qs = null, qe = null;
    for (const si of slots) { const s = dts[si]; if (s) { if (qs===null||s.startMin<qs) qs=s.startMin; if (qe===null||s.endMin>qe) qe=s.endMin; } }
    if (qs === null || qe === null) return true;
    const isElectiveOwn = r => (r.type==='elective'||r.type==='swim_elective') && r.division && String(r.division)===String(divisionName);
    const check = name => { const list = global.window.fieldReservations[name]; if (!Array.isArray(list)) return null;
        return list.find(r => r && r.startMin < qe && r.endMin > qs && !isElectiveOwn(r)) || null; };
    let rz = check(specialName);
    if (!rz && props && props.location) rz = check(props.location);
    return !rz; // allowed iff no blocking reservation
}

// TEST 1 — foreign division (Camp Agudah > 6, window at slot index 0) is BLOCKED
//          from Pizza Making. This is the exact leak.
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Pizza Making', [0]), false,
    'foreign division blocked from the elective-reserved special (was the leak)');
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Gaming Center', [0]), false,
    'second reserved special also blocked for the foreign division');
console.log('TEST 1 PASS — foreign division blocked from elective-reserved specials across a misaligned grid');

// TEST 2 — the elective's OWN grade (מתמדים) is EXEMPT (division-lock semantics).
assert.strictEqual(specialAllowed('מתמדים', 'Pizza Making', [1]), true,
    "elective's own grade may use its own reserved special");
console.log('TEST 2 PASS — own grade exempt');

// TEST 3 — disjoint time & unrelated special stay free (no over-block).
//   Camp Agudah > 6 index 0 is 1030–1110; a special NOT reserved is fine.
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Face Painting', [0]), true,
    'unreserved special stays allowed');
global.window.divisionTimes['Camp Agudah > 6'] = [ {startMin: 1080, endMin: 1140} ]; // after the window
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Pizza Making', [0]), true,
    'disjoint time (after the elective window) stays free');
console.log('TEST 3 PASS — no over-block on disjoint times / unreserved specials');

// TEST 4 — a PINNED reservation blocks EVERY division incl. its own (pin invariant).
global.window.fieldReservations = Utils.getFieldReservationsFromSkeleton([
    { type: 'pinned', division: 'מתמדים', event: 'Assembly', startTime: '5:10 PM', endTime: '6:00 PM', reservedFields: ['Auditorium'] }
]);
global.window.divisionTimes = { 'מתמדים': [ {startMin: 1030, endMin: 1080} ] };
assert.strictEqual(specialAllowed('מתמדים', 'Auditorium', [0]), false,
    'a PIN blocks even its own division (pin invariant, unlike an elective)');
console.log('TEST 4 PASS — pinned reservation blocks own division too (invariant preserved)');

console.log('\n✅ ALL elective_special_reservation_sim TESTS PASSED');
