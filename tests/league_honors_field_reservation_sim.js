// =============================================================================
// league_honors_field_reservation_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the CONFIRMED live double-book: a Daily-Adjustments field
// reservation ("Home Run Stadium" reserved for division מתמדים via a pinned
// "Masmidim" tile, 3:30–4:30pm) was ALSO handed to the 6th-Grade Fruit League
// (division "Camp Agudah > 6", game 3:30–4:50pm) during generation.
//
// Root cause: the reservation is extracted into window.fieldReservations
// (Utils.getFieldReservationsFromSkeleton) and already blocks SPORT placement via
// canBlockFit — but the league field pools only consulted GlobalFieldLocks, never
// window.fieldReservations, so the reserved field looked free to the league.
//
// Fix: the league pools now also consult window.fieldReservations, DIVISION-AWARE:
// a field is blocked only when reserved by a DIFFERENT division than the league
// serves. A division reserves its OWN signup-league field pool (e.g. div 8/9
// "Signup leagues"), and that division's own league MUST still be able to use it.
//
// Drives the REAL scheduler_core_utils.js (getFieldReservationsFromSkeleton) and
// mirrors the division-aware filter added to both league engines.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = { addEventListener: () => {}, divisionTimes: {} };
global.document = { readyState: 'complete', addEventListener: () => {} };
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'));
const Utils = global.window.SchedulerCoreUtils;
assert.ok(Utils && Utils.getFieldReservationsFromSkeleton, 'utils loaded');

// Skeleton: מתמדים's pinned "Masmidim" tile reserves Home Run Stadium 3:30–4:30pm,
// and a senior division "8" reserves its "Signup leagues" pool (incl. Dunk Courts).
const SKELETON = [
  { id: 'm1', type: 'pinned', event: 'Masmidim', division: 'מתמדים',
    startTime: '3:30 PM', endTime: '4:30 PM', reservedFields: ['Home Run Stadium', 'Swish City', 'Touchdown Park'] },
  { id: 's8', type: 'pinned', event: 'Signup leagues', division: '8',
    startTime: '12:20 PM', endTime: '1:40 PM', reservedFields: ['Dunk Courts', 'AFFL Stadium 1'] },
];
global.window.fieldReservations = Utils.getFieldReservationsFromSkeleton(SKELETON);
assert.ok(global.window.fieldReservations['Home Run Stadium'], 'masmidim reservation extracted');
assert.ok(global.window.fieldReservations['Dunk Courts'], 'div-8 pool reservation extracted');

// --- mirror of the division-aware filter added to the league pools ---
// returns the kept (available) field names for a league serving `divisionNames`
// over [poolStart, poolEnd).
function leaguePool(allFields, divisionNames, poolStart, poolEnd) {
  const cur = (divisionNames || []).map(d => String(d).toLowerCase().trim());
  return allFields.filter(f => {
    const rl = global.window.fieldReservations[f] || [];
    const foreign = rl.find(r => r && r.startMin < poolEnd && r.endMin > poolStart &&
      r.division && !cur.includes(String(r.division).toLowerCase().trim()));
    return !foreign;
  });
}

const POOL = ['Home Run Stadium', 'Swish City', 'Dunk Courts', 'AFFL Stadium 1', 'New Gym 1'];
const m = (h, mn) => h * 60 + mn;

// =============================================================================
// TEST 1 — the bug: 6th-Grade Fruit League (div "Camp Agudah > 6") @3:30–4:50
//          must NOT be offered Home Run Stadium (reserved by מתמדים @3:30–4:30)
// =============================================================================
{
  const pool = leaguePool(POOL, ['Camp Agudah > 6'], m(15, 30), m(16, 50));
  assert.ok(!pool.includes('Home Run Stadium'), 'FIX: 6th league kept OFF מתמדים-reserved Home Run Stadium');
  assert.ok(!pool.includes('Swish City'), 'FIX: also off Swish City (same reservation)');
  assert.ok(pool.includes('New Gym 1'), 'unreserved field still available');
}
console.log('TEST 1 PASS — foreign-division reservation blocks the 6th-grade league (the confirmed bug)');

// =============================================================================
// TEST 2 — no over-block: division "8"'s OWN signup league may use its OWN pool
// =============================================================================
{
  const pool = leaguePool(POOL, ['8'], m(12, 20), m(13, 40));
  assert.ok(pool.includes('Dunk Courts'), 'div-8 league CAN use its own reserved pool field');
  assert.ok(pool.includes('AFFL Stadium 1'), 'div-8 league CAN use its own reserved pool field 2');
}
console.log('TEST 2 PASS — a division\'s own reservation never locks its own league out (no over-block)');

// =============================================================================
// TEST 3 — a DIFFERENT division IS blocked from div-8's pool (cross-div protected)
// =============================================================================
{
  const pool = leaguePool(POOL, ['Camp Agudah > 6'], m(12, 20), m(13, 40));
  assert.ok(!pool.includes('Dunk Courts'), 'a different division is blocked from div-8\'s reserved pool');
}
console.log('TEST 3 PASS — div-8 pool is protected from other divisions\' leagues');

// =============================================================================
// TEST 4 — disjoint time is NOT blocked
// =============================================================================
{
  const pool = leaguePool(POOL, ['Camp Agudah > 6'], m(17, 10), m(18, 30)); // after 4:30
  assert.ok(pool.includes('Home Run Stadium'), 'non-overlapping league window may use the field');
}
console.log('TEST 4 PASS — disjoint-time league window is unaffected');

console.log('\nALL 4 LEAGUE-HONORS-FIELD-RESERVATION (division-aware) TESTS PASS');
