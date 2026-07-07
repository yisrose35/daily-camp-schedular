// =============================================================================
// elective_special_reservation_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the CONFIRMED live leak: an elective reserved "Pizza Making"
// for division מתמדים @ 5:10–6:00pm, but a SPECIAL of the same name was still
// handed to a bunk in division "Camp Agudah > 6" at the same time.
//
// Root cause: the SmartTile special pool (smart_logic_adapter.getAvailableSpecials-
// ForTimeBlock) gated specials only through GlobalFieldLocks (a per-division
// SLOT-INDEX check). Slot N is a different wall-clock time in each grade's grid, so
// a foreign division querying its own indices MISSES the elective's lock. Sports were
// safe because canBlockFit also consults window.fieldReservations (robust wall-clock),
// but the special pool never did.
//
// Fix: getAvailableSpecialsForTimeBlock now excludes any special reserved by
// window.fieldReservations for an overlapping window, using the REAL block times it
// already receives (startMin/endMin) — NOT slot indices — and DIVISION-AWARE: an
// elective reservation exempts its OWN grade; a pin blocks everyone.
//
// (A) SOURCE GUARD — the pool builder must consult window.fieldReservations.
// (B) BEHAVIORAL — mirror the wall-clock gate: foreign blocked, own exempt, pin
//     blocks own, disjoint/unreserved free.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- (A) SOURCE GUARD --------------------------------------------------------
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'smart_logic_adapter.js'), 'utf8');
    const start = src.indexOf('function getAvailableSpecialsForTimeBlock');
    assert.ok(start !== -1, 'located getAvailableSpecialsForTimeBlock');
    const next = src.indexOf('\n    function ', start + 1);
    const body = src.slice(start, next === -1 ? start + 20000 : next);
    assert.ok(/window\.fieldReservations/.test(body),
        'getAvailableSpecialsForTimeBlock must consult window.fieldReservations (robust wall-clock elective/pin block)');
    console.log('SOURCE GUARD PASS — SmartTile special pool consults window.fieldReservations');
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

// Faithful mirror of the new gate in getAvailableSpecialsForTimeBlock — uses the
// REAL block times (startMin/endMin), no slot reconstruction.
function specialAllowed(divisionName, specialName, startMin, endMin) {
    if (!(global.window.fieldReservations && startMin != null && endMin != null)) return true;
    const isElectiveOwn = r => (r.type==='elective'||r.type==='swim_elective') && r.division && String(r.division)===String(divisionName);
    const hit = nm => { const list = nm && global.window.fieldReservations[nm]; if (!Array.isArray(list)) return null;
        return list.find(r => r && r.startMin < endMin && r.endMin > startMin && !isElectiveOwn(r)) || null; };
    return !hit(specialName); // allowed iff no blocking reservation
}

// TEST 1 — foreign division (Camp Agudah > 6) BLOCKED from Pizza Making @ the window.
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Pizza Making', 1030, 1110), false,
    'foreign division blocked from the elective-reserved special (was the leak)');
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Gaming Center', 1030, 1080), false,
    'second reserved special also blocked for the foreign division');
console.log('TEST 1 PASS — foreign division blocked from elective-reserved specials (wall-clock)');

// TEST 2 — the elective's OWN grade (מתמדים) is EXEMPT.
assert.strictEqual(specialAllowed('מתמדים', 'Pizza Making', 1030, 1080), true,
    "elective's own grade may use its own reserved special");
console.log('TEST 2 PASS — own grade exempt');

// TEST 3 — disjoint time & unrelated special stay free (no over-block).
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Face Painting', 1030, 1080), true,
    'unreserved special stays allowed');
assert.strictEqual(specialAllowed('Camp Agudah > 6', 'Pizza Making', 1080, 1140), true,
    'disjoint time (after the elective window) stays free');
console.log('TEST 3 PASS — no over-block on disjoint times / unreserved specials');

// TEST 4 — a PINNED reservation blocks EVERY division incl. its own (pin invariant).
global.window.fieldReservations = Utils.getFieldReservationsFromSkeleton([
    { type: 'pinned', division: 'מתמדים', event: 'Assembly', startTime: '5:10 PM', endTime: '6:00 PM', reservedFields: ['Auditorium'] }
]);
assert.strictEqual(specialAllowed('מתמדים', 'Auditorium', 1030, 1080), false,
    'a PIN blocks even its own division (pin invariant, unlike an elective)');
console.log('TEST 4 PASS — pinned reservation blocks own division too (invariant preserved)');

console.log('\n✅ ALL elective_special_reservation_sim TESTS PASSED');
