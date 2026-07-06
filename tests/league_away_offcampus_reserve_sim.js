// =============================================================================
// league_away_offcampus_reserve_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the CONFIRMED live bug: a league tile set to "Away" → zone
// "TABC" was generated onto regular on-campus fields instead of the TABC zone.
//
// Root cause (confirmed from the camp's live config dump): the TABC courts were
// recorded in the zone's `locations` map, NOT its `fields` array. But
// getZoneForField() / getFieldsInZone() only scanned `zone.fields`, so:
//   • getFieldsInZone('TABC') → []  → the away step had nothing to restrict to
//     → "no available fields; keeping full pool" → games fell back on-campus.
//   • getZoneForField(court)  → null → the reservation couldn't recognise the
//     court as belonging to an (off-campus / away) zone → non-away leagues, run
//     first in seniority order, poached the courts before the away league ran.
//
// Fix (mirrored here): both helpers now UNION `zone.fields` with the keys of
// `zone.locations` — a facility in either bucket physically lives in the zone.
// Then the pool builder reserves a zone's fields for Away games to that zone
// (off-campus zones always; on-campus zones in periods they're an away target).
//
// This mirrors the union scan added to zones.js and the league pool predicate.
// =============================================================================

'use strict';
const assert = require('assert');

const SPORTS = ['Basketball', 'Football', 'Hockey'];
const FIELDS = [
  { name: 'New Gym bball(1)',      activities: ['Basketball'] },
  { name: 'Old Gym Hockey',        activities: ['Hockey'] },
  { name: 'Football (field 1)',    activities: ['Football'] },
  { name: 'TABC Bball (NG1)',      activities: ['Basketball'] },
  { name: 'TABC bball (ng2)',      activities: ['Basketball'] },
  { name: 'TABC Hockey (old gym)', activities: ['Hockey'] },
];
// ★ Mirrors the live dump: TABC is off-campus and its courts are stored under
//   `locations` (NOT `fields`). Main Campus keeps its courts under `fields`.
const LOCATION_ZONES = {
  TABC: { name: 'TABC', isOffCampus: true, fields: [],
          locations: { 'TABC Bball (NG1)': {}, 'TABC bball (ng2)': {}, 'TABC Hockey (old gym)': {} } },
  'Main Campus': { name: 'Main Campus', isOffCampus: false, fields: ['New Gym bball(1)'],
                   locations: { 'Old Gym Hockey': {}, 'Football (field 1)': {} } },
};

// --- exact UNION scan the fixed zones.js uses (fields ∪ Object.keys(locations)) ---
function getZoneForField(fieldName) {
  for (const zone of Object.values(LOCATION_ZONES)) {
    if (Array.isArray(zone.fields) && zone.fields.includes(fieldName)) return zone;
    if (zone.locations && Object.prototype.hasOwnProperty.call(zone.locations, fieldName)) return zone;
  }
  return null;
}
function getFieldsInZone(zoneName) {
  const z = LOCATION_ZONES[zoneName];
  if (!z) return [];
  const names = new Set(Array.isArray(z.fields) ? z.fields : []);
  if (z.locations) Object.keys(z.locations).forEach(n => names.add(n));
  return [...names];
}

// every period here has Week 1 Leagues going Away to TABC → TABC reserved:
const RESERVED_AWAY_ZONES = new Set(['TABC']);

// --- mirror of buildAvailableFieldSportPool's field admission + the away block ---
function buildPool(sports, awayZoneName, reservedAwayZones) {
  const pool = [];
  for (const field of FIELDS) {
    const fz = getZoneForField(field.name);
    if (fz && fz.name !== awayZoneName &&
        (fz.isOffCampus === true ||
         (reservedAwayZones && reservedAwayZones.has(fz.name)))) continue;
    for (const sport of sports) {
      if (field.activities.includes(sport)) pool.push({ field: field.name, sport });
    }
  }
  return pool;
}
function leagueAwayPool(sports, awayZone, awayMode) {
  let pool = buildPool(sports, awayZone || null, RESERVED_AWAY_ZONES);
  if (awayZone && awayMode === 'exclusive') {
    const zset = new Set(getFieldsInZone(awayZone));
    const filtered = pool.filter(p => zset.has(p.field));
    if (filtered.length > 0) pool = filtered;
  }
  return pool;
}
const isTABC = f => f.startsWith('TABC');

// =============================================================================
// TEST 0 — the root fix: helpers resolve a court stored under `locations`.
// =============================================================================
{
  assert.strictEqual((getZoneForField('TABC Bball (NG1)') || {}).name, 'TABC',
    'FIX: getZoneForField resolves a locations-stored court to its zone (was null)');
  const zf = getFieldsInZone('TABC');
  assert.deepStrictEqual(zf.sort(), ['TABC Bball (NG1)', 'TABC Hockey (old gym)', 'TABC bball (ng2)'].sort(),
    'FIX: getFieldsInZone returns the locations-stored courts (was [])');
}
console.log('TEST 0 PASS — zone helpers now see courts stored under `locations` (the root fix)');

// =============================================================================
// TEST 1 — a NON-away league must not be offered any TABC field (the bug).
// =============================================================================
{
  const pool = buildPool(SPORTS, null, RESERVED_AWAY_ZONES);
  assert.ok(pool.length > 0, 'non-away league still has on-campus fields');
  assert.ok(!pool.some(p => isTABC(p.field)), 'FIX: non-away league sees ZERO TABC fields');
  assert.ok(pool.some(p => p.field === 'New Gym bball(1)'), 'on-campus fields unaffected');
}
console.log('TEST 1 PASS — non-away leagues cannot poach the away zone (the confirmed bug)');

// =============================================================================
// TEST 2 — exclusive "all away" league gets ONLY the TABC zone fields.
// =============================================================================
{
  const pool = leagueAwayPool(SPORTS, 'TABC', 'exclusive');
  assert.ok(pool.length > 0, 'away league has a non-empty zone pool (no more empty-zone fallback)');
  assert.ok(pool.every(p => isTABC(p.field)), 'exclusive away → only TABC fields');
  assert.ok(pool.some(p => p.field === 'TABC Hockey (old gym)'), 'TABC hockey available');
}
console.log('TEST 2 PASS — exclusive away league restricted to its own zone');

// =============================================================================
// TEST 3 — mixed ("either/or") away league sees BOTH zone + on-campus fields.
// =============================================================================
{
  const pool = leagueAwayPool(SPORTS, 'TABC', 'mixed');
  assert.ok(pool.some(p => isTABC(p.field)), 'mixed away → TABC fields admitted');
  assert.ok(pool.some(p => !isTABC(p.field)), 'mixed away → on-campus fields also allowed');
}
console.log('TEST 3 PASS — mixed away league can play either off-campus or home');

// =============================================================================
// TEST 4 — no over-block: on-campus, non-away-target zone fields stay available.
// =============================================================================
{
  const pool = buildPool(SPORTS, null, RESERVED_AWAY_ZONES);
  assert.ok(pool.some(p => p.field === 'New Gym bball(1)'),
    'on-campus (Main Campus) field is NOT reserved from a normal league');
  assert.ok(pool.some(p => p.field === 'Old Gym Hockey'),
    'a Main-Campus court stored under `locations` is still freely available (on-campus)');
}
console.log('TEST 4 PASS — on-campus zone fields (incl. locations-stored) never reserve');

console.log('\nALL 5 LEAGUE-AWAY-OFFCAMPUS-RESERVE TESTS PASS');
