// =============================================================================
// league_away_offcampus_reserve_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the CONFIRMED live bug: a league tile set to "Away" → zone
// "TABC" was generated onto REGULAR ON-CAMPUS fields instead of the TABC zone.
//
// Root cause (confirmed from the user's generation log): the off-campus zone's
// fields sat in the SHARED league field pool with no reservation, so the three
// on-campus (non-away) leagues — processed FIRST in seniority order — consumed
// and locked every TABC court. When the away league (junior-most division) ran
// LAST, all TABC fields were locked, the zone∩pool intersection was empty, and
// the engine silently fell back to the full on-campus pool
// ("...zone has no available fields; keeping full pool").
//
// Fix (mirrored here): buildAvailableFieldSportPool now RESERVES off-campus
// fields — a field in an off-campus zone is admitted ONLY when the caller is a
// game going Away to THAT zone (awayZoneName). Non-away leagues never see it, so
// they can't poach it, and the away league's zone stays free for it.
//
// This drives the SAME getZoneForField / getFieldsInZone scan zones.js uses and
// the exact pool predicate + exclusive/mixed handling added to the league engine.
// =============================================================================

'use strict';
const assert = require('assert');

// --- config: on-campus fields + an OFF-CAMPUS "TABC" zone (mirrors the camp) ---
const SPORTS = ['Basketball', 'Football', 'Hockey'];
const FIELDS = [
  { name: 'New Gym bball(1)',      activities: ['Basketball'] },
  { name: 'Old Gym Hockey',        activities: ['Hockey'] },
  { name: 'Football (field 1)',    activities: ['Football'] },
  { name: 'TABC Bball (NG1)',      activities: ['Basketball'] },
  { name: 'TABC bball (ng2)',      activities: ['Basketball'] },
  { name: 'TABC Hockey (old gym)', activities: ['Hockey'] },
];
const LOCATION_ZONES = {
  // ★ The reported camp's "TABC" zone is ON-campus (isOffCampus falsy) — it's used
  //   purely as an Away destination. Reservation must NOT depend on isOffCampus.
  TABC: { name: 'TABC', isOffCampus: false,
          fields: ['TABC Bball (NG1)', 'TABC bball (ng2)', 'TABC Hockey (old gym)'] },
  // an on-campus zone that is NOT an away target must NOT reserve its fields
  'Main Campus': { name: 'Main Campus', isOffCampus: false, fields: ['New Gym bball(1)'] },
};

// --- exact scan zones.js uses (getZoneForField / getFieldsInZone) ---
function getZoneForField(fieldName) {
  for (const zone of Object.values(LOCATION_ZONES)) {
    if (zone && Array.isArray(zone.fields) && zone.fields.includes(fieldName)) return zone;
  }
  return null;
}
function getFieldsInZone(zoneName) {
  const z = LOCATION_ZONES[zoneName];
  return (z && Array.isArray(z.fields)) ? [...z.fields] : [];
}

// every period here has Week 1 Leagues going Away to TABC, so TABC is reserved:
const RESERVED_AWAY_ZONES = new Set(['TABC']);

// --- mirror of buildAvailableFieldSportPool's field admission + the away block ---
function buildPool(sports, awayZoneName, reservedAwayZones) {
  const pool = [];
  for (const field of FIELDS) {
    // the exact reservation predicate added to the pool builder:
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
// away resolution, mirroring the engine: build with the zone admitted, then for
// EXCLUSIVE mode intersect down to the zone's fields; MIXED leaves the pool.
function leagueAwayPool(sports, awayZone, awayMode) {
  let pool = buildPool(sports, awayZone || null, RESERVED_AWAY_ZONES);
  if (awayZone && awayMode === 'exclusive') {
    const zset = new Set(getFieldsInZone(awayZone));
    const filtered = pool.filter(p => zset.has(p.field));
    if (filtered.length > 0) pool = filtered; // else fallback (genuine misconfig)
  }
  return pool;
}
const isTABC = f => f.startsWith('TABC');

// =============================================================================
// TEST 1 — the bug: a NON-away league must NOT be offered any TABC (off-campus)
//          field. Previously they were, so the seniors drained the zone.
// =============================================================================
{
  const pool = buildPool(SPORTS, null, RESERVED_AWAY_ZONES);
  assert.ok(pool.length > 0, 'non-away league still has on-campus fields');
  assert.ok(!pool.some(p => isTABC(p.field)), 'FIX: non-away league sees ZERO TABC (away-target) fields');
  assert.ok(pool.some(p => p.field === 'New Gym bball(1)'), 'on-campus fields unaffected');
}
console.log('TEST 1 PASS — non-away leagues cannot poach an away-target zone even when it is on-campus (the confirmed bug)');

// =============================================================================
// TEST 2 — the away league (exclusive "all away") gets ONLY the TABC zone fields
// =============================================================================
{
  const pool = leagueAwayPool(SPORTS, 'TABC', 'exclusive');
  assert.ok(pool.length > 0, 'away league has a non-empty zone pool');
  assert.ok(pool.every(p => isTABC(p.field)), 'exclusive away → only TABC fields');
  assert.ok(pool.some(p => p.field === 'TABC Bball (NG1)'), 'TABC basketball available');
  assert.ok(pool.some(p => p.field === 'TABC Hockey (old gym)'), 'TABC hockey available');
}
console.log('TEST 2 PASS — exclusive away league restricted to its own zone');

// =============================================================================
// TEST 3 — mixed ("either/or") away league sees BOTH zone + on-campus fields
// =============================================================================
{
  const pool = leagueAwayPool(SPORTS, 'TABC', 'mixed');
  assert.ok(pool.some(p => isTABC(p.field)), 'mixed away → TABC fields admitted');
  assert.ok(pool.some(p => !isTABC(p.field)), 'mixed away → on-campus fields also allowed');
}
console.log('TEST 3 PASS — mixed away league can play either off-campus or home');

// =============================================================================
// TEST 4 — no over-block: an ON-CAMPUS zone (isOffCampus:false) never reserves,
//          and camps with no off-campus zone are entirely unaffected.
// =============================================================================
{
  const pool = buildPool(SPORTS, null, RESERVED_AWAY_ZONES);
  // New Gym bball(1) is in an on-campus, non-away-target zone → freely available.
  assert.ok(pool.some(p => p.field === 'New Gym bball(1)'),
    'on-campus, non-away-target zone field is NOT reserved from normal leagues');
  // and a camp with NO away games (empty reserved set, no off-campus) reserves nothing:
  const noAway = buildPool(SPORTS, null, new Set());
  assert.ok(noAway.some(p => isTABC(p.field)),
    'no away games → TABC (on-campus) fields stay in the normal pool (zero behavior change)');
}
console.log('TEST 4 PASS — only away-target/off-campus zones reserve; camps without away games unchanged');

console.log('\nALL 4 LEAGUE-AWAY-OFFCAMPUS-RESERVE TESTS PASS');
