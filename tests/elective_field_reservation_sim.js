// =============================================================================
// elective_field_reservation_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the CONFIRMED double-book: an elective handed out to one
// division ("Rock Climbing" reserved for division A, 2:00–2:45pm) was ALSO given
// to a bunk in a DIFFERENT division B doing regular rotation at the same time.
//
// Root cause: an elective is a fancy custom-pinned tile — its facilities must be
// held against everything else exactly like a pin. But an elective created from
// Daily Adjustments carries only `electiveActivities` (NO `reservedFields`), so
// Utils.getFieldReservationsFromSkeleton never extracted it into
// window.fieldReservations. The sports solver (canBlockFit) gates SPORT placement
// on window.fieldReservations, so a DA-created elective's facility looked FREE to
// another division's sport — the leak. (Master-builder electives set reservedFields
// and were already covered; the two paths were enforced inconsistently.)
//
// Fix: getFieldReservationsFromSkeleton now also treats an elective/swim_elective
// tile's electiveActivities (and swim location) as reserved facilities — a robust
// wall-clock reservation, identical to a pin, for BOTH creation paths.
//
// Drives the REAL scheduler_core_utils.js (getFieldReservationsFromSkeleton +
// isFieldReserved — the exact pair canBlockFit uses to reject a sport at line ~814).
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = { addEventListener: () => {}, divisionTimes: {} };
global.document = { readyState: 'complete', addEventListener: () => {} };
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'));
const Utils = global.window.SchedulerCoreUtils;
assert.ok(Utils && Utils.getFieldReservationsFromSkeleton && Utils.isFieldReserved, 'utils loaded');

const m = (h, mn) => h * 60 + mn; // clock helper
// canBlockFit rejects a field when isFieldReserved(...) is truthy for the block's
// wall-clock window. Mirror that exact call so the test speaks the solver's language.
const sportBlocked = (field, s, e, reservations) =>
    !!Utils.isFieldReserved(field, s, e, reservations);

// =============================================================================
// TEST 1 — DA-created elective (electiveActivities ONLY, no reservedFields) is now
//          extracted into fieldReservations and blocks a FOREIGN division's sport.
// =============================================================================
{
    const SKELETON = [
        // Daily-Adjustments elective for division A, 2:00–2:45pm. NOTE: no reservedFields.
        { id: 'e1', type: 'elective', event: 'Elective', division: 'A',
          startTime: '2:00 PM', endTime: '2:45 PM',
          electiveActivities: ['Rock Climbing', 'Archery'] },
    ];
    const res = Utils.getFieldReservationsFromSkeleton(SKELETON);

    assert.ok(res['Rock Climbing'], 'elective activity Rock Climbing extracted into fieldReservations (was the bug)');
    assert.ok(res['Archery'], 'every elective activity is reserved');

    // Division B's sport wants Rock Climbing at an overlapping time → BLOCKED.
    assert.ok(sportBlocked('Rock Climbing', m(14, 0), m(14, 45), res), 'foreign division sport blocked at the elective window');
    // Partial overlaps at both edges → blocked.
    assert.ok(sportBlocked('Rock Climbing', m(13, 50), m(14, 10), res), 'leading-edge overlap blocked');
    assert.ok(sportBlocked('Archery', m(14, 30), m(15, 0), res), 'trailing-edge overlap blocked');
    // Disjoint time on the same facility → free (no over-block).
    assert.ok(!sportBlocked('Rock Climbing', m(14, 45), m(15, 30), res), 'disjoint time after the window stays free');
    assert.ok(!sportBlocked('Rock Climbing', m(13, 0), m(14, 0), res), 'disjoint time before the window stays free');
    // An unrelated facility → free.
    assert.ok(!sportBlocked('Soccer Field', m(14, 0), m(14, 45), res), 'unrelated facility stays free');

    console.log('TEST 1 PASS — DA elective (electiveActivities only) now reserves its facilities exactly like a pin');
}

// =============================================================================
// TEST 2 — swim+elective hybrid: the pool (swimLocation) AND every elective
//          activity are all held.
// =============================================================================
{
    const SKELETON = [
        { id: 'se1', type: 'swim_elective', event: 'Swim + Elective', division: 'A',
          startTime: '10:00 AM', endTime: '11:00 AM',
          swimLocation: 'Main Pool',
          electiveActivities: ['Main Pool', 'Ropes Course'] },
    ];
    const res = Utils.getFieldReservationsFromSkeleton(SKELETON);
    assert.ok(res['Main Pool'], 'swim location reserved');
    assert.ok(res['Ropes Course'], 'hybrid elective activity reserved');
    assert.ok(sportBlocked('Ropes Course', m(10, 30), m(10, 45), res), 'foreign sport blocked from hybrid facility');
    console.log('TEST 2 PASS — swim+elective hybrid holds pool + every activity');
}

// =============================================================================
// TEST 3 — master-builder elective (reservedFields + electiveActivities both set)
//          still works; no crash, no dependence on one field over the other.
// =============================================================================
{
    const SKELETON = [
        { id: 'e2', type: 'elective', event: 'Elective', division: 'A',
          startTime: '3:00 PM', endTime: '3:45 PM',
          reservedFields: ['Woodshop', 'Pottery'],
          electiveActivities: ['Woodshop', 'Pottery'] },
    ];
    const res = Utils.getFieldReservationsFromSkeleton(SKELETON);
    assert.ok(res['Woodshop'] && res['Pottery'], 'both facilities reserved');
    // Reserved once (dedup via the per-block Set) — a single overlapping entry.
    assert.strictEqual(res['Woodshop'].length, 1, 'facility reserved once, not double-counted');
    assert.ok(sportBlocked('Woodshop', m(15, 10), m(15, 20), res), 'foreign sport blocked');
    console.log('TEST 3 PASS — master-builder elective (both fields set) reserved cleanly, no double-count');
}

// =============================================================================
// TEST 4 — NON-elective tiles are unchanged: a plain sports/activity tile with
//          neither reservedFields nor electiveActivities reserves NOTHING (no
//          new over-block regression); a pinned tile still reserves via
//          reservedFields exactly as before.
// =============================================================================
{
    const SKELETON = [
        { id: 's1', type: 'sports', event: 'Sports', division: 'A',
          startTime: '1:00 PM', endTime: '1:45 PM' },
        { id: 'p1', type: 'pinned', event: 'Assembly', division: 'A',
          startTime: '1:00 PM', endTime: '1:30 PM', reservedFields: ['Gym'] },
    ];
    const res = Utils.getFieldReservationsFromSkeleton(SKELETON);
    assert.strictEqual(Object.keys(res).length, 1, 'only the pinned tile reserves a field');
    assert.ok(res['Gym'], 'pinned reservedFields still extracted (unchanged)');
    assert.ok(sportBlocked('Gym', m(13, 10), m(13, 20), res), 'pinned facility still blocks (no regression)');
    console.log('TEST 4 PASS — plain tiles reserve nothing; pinned reservedFields unchanged');
}

console.log('\n✅ ALL TESTS PASS — electives are reserved across the system exactly like custom pinned tiles');
