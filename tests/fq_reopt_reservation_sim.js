// =============================================================================
// fq_reopt_reservation_sim.js
// -----------------------------------------------------------------------------
// Locks down the UPSTREAM fix for "why are we getting Frees": the STEP 7.8
// Field-Quality re-optimizer (field_quality_reopt.js) must NOT pull a placement
// onto a facility reserved by a pinned event/league (window.fieldReservations).
//
// Real-world chain (from a live flow.html gen log): a clean full gen placed
// volleyball, then FQ-reopt "upgraded" two bunks onto Slam Plex 1 & 2 — courts
// reserved 740-810 by the pinned "Max Leagues" event (overlapping the 805-870
// window by 5 min). FQ-reopt consulted GlobalFieldLocks + timeRules but NOT
// window.fieldReservations, so it saw the courts as free. STEP 7.9 (which DOES
// read fieldReservations) then evicted both → Free.
//
// This drives the REAL FieldQualityReopt.run() (loaded with a window stub) and
// the REAL Utils.isFieldReserved, so it proves the fix end-to-end — not a mirror.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- Real Utils.isFieldReserved (extracted, same method as the evict-sweep sim)
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
const m = utilsSrc.match(/Utils\.isFieldReserved\s*=\s*function[\s\S]*?\n    \};/);
assert.ok(m, 'located Utils.isFieldReserved in source');
const isFieldReserved = (0, eval)('(' + m[0].replace(/^\s*Utils\.isFieldReserved\s*=\s*/, '').replace(/;\s*$/, '') + ')');

// ---- Build a window stub and load the REAL FieldQualityReopt module ----------
// Two volleyball courts in one quality group: "Good Court" (rank 1, better) and
// "OK Court" (rank 2). A bunk sits on OK Court; Phase A wants to pull it to the
// better-ranked Good Court when that court is free.
function makeSA() {
    return { 'כ': [{ field: 'OK Court', _activity: 'Volleyball', _startMin: 805, _endMin: 870 }] };
}
const FIELDS = [
    { name: 'Good Court', fieldGroup: 'VB', qualityRank: 1, activities: ['Volleyball'], sharableWith: { type: 'same_division', capacity: 2 } },
    { name: 'OK Court',   fieldGroup: 'VB', qualityRank: 2, activities: ['Volleyball'], sharableWith: { type: 'same_division', capacity: 2 } }
];
// Max Leagues reserves Good Court 740-810 — overlaps the 805-870 placement by 5 min.
const RESERVED = { 'Good Court': [{ startMin: 740, endMin: 810, division: '8', event: 'Max Leagues' }] };

global.window = {
    loadGlobalSettings: () => ({ app1: { fields: FIELDS } }),
    divisions: { '7': { bunks: ['כ'] } },
    scheduleAssignments: makeSA(),
    getDivisionAgeOrder: (ks) => ks,          // single grade — order irrelevant
    SchedulerCoreUtils: { isFieldReserved },
    GlobalFieldLocks: undefined,               // no global lock in play
    fieldReservations: {},                     // set per-test below
    loadCurrentDailyData: () => ({}),
    currentDisabledFields: [],
    activityProperties: {}
};

require(path.join('..', 'field_quality_reopt.js'));
assert.ok(window.FieldQualityReopt && typeof window.FieldQualityReopt.run === 'function', 'FieldQualityReopt.run loaded');

// =============================================================================
// TEST 1 (control — non-vacuous) — no reservation: FQ-reopt DOES pull to the
//   better-ranked court. Proves the upgrade path is live in this scenario.
// =============================================================================
{
    window.scheduleAssignments = makeSA();
    window.fieldReservations = {};
    const r = window.FieldQualityReopt.run({ log: function () {} });
    assert.strictEqual(r.moved, 1, 'control: exactly one quality upgrade');
    assert.strictEqual(window.scheduleAssignments['כ'][0].field, 'Good Court', 'control: pulled to the better-ranked court');
    console.log('TEST 1 PASS — with no reservation, FQ-reopt upgrades OK Court → Good Court (pull is live)');
}

// =============================================================================
// TEST 2 (the fix) — Good Court reserved by the pin: FQ-reopt must NOT move
//   onto it. The placement stays on OK Court, so STEP 7.9 has nothing to evict.
// =============================================================================
{
    window.scheduleAssignments = makeSA();
    window.fieldReservations = RESERVED;
    const r = window.FieldQualityReopt.run({ log: function () {} });
    assert.strictEqual(r.moved, 0, 'fix: no move onto the reserved court');
    assert.strictEqual(window.scheduleAssignments['כ'][0].field, 'OK Court', 'fix: placement stays on the unreserved court');
    console.log('TEST 2 PASS — with Good Court reserved, FQ-reopt leaves the placement put (no eviction → no Free)');
}

// =============================================================================
// TEST 3 (no false block) — a DISJOINT reservation (Good Court reserved 700-805,
//   ending exactly at the placement start) must not block the upgrade.
// =============================================================================
{
    window.scheduleAssignments = makeSA();
    window.fieldReservations = { 'Good Court': [{ startMin: 700, endMin: 805, division: '8', event: 'Max Leagues' }] };
    const r = window.FieldQualityReopt.run({ log: function () {} });
    assert.strictEqual(r.moved, 1, 'disjoint reservation (ends at 805, placement starts 805) does not block');
    assert.strictEqual(window.scheduleAssignments['כ'][0].field, 'Good Court', 'disjoint: upgrade still happens');
    console.log('TEST 3 PASS — a reservation that only touches the boundary (700-805 vs 805-870) does not false-block');
}

// =============================================================================
// TEST 4 — the fill-path / re-heal gate predicate (isFieldPinReserved mirror).
//   auto_fill_slot.js calls window.SchedulerCoreUtils.isFieldReserved the same
//   way; assert overlap vs boundary vs missing-field behaviour it relies on.
// =============================================================================
{
    const resv = RESERVED;
    assert.ok(isFieldReserved('Good Court', 805, 870, resv), 'overlap (805-810) → reserved');
    assert.ok(!isFieldReserved('Good Court', 810, 870, resv), 'starts at reservation end → free');
    assert.ok(!isFieldReserved('OK Court', 805, 870, resv), 'unlisted field → free');
    console.log('TEST 4 PASS — isFieldReserved overlap/boundary/missing behaviour the fill gate depends on');
}

console.log('\n✅ ALL fq_reopt_reservation_sim TESTS PASSED');
