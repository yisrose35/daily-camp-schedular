'use strict';
// Simulation test for RAINY DAY per-tile regeneration (Manual builder).
//
// Models the data-flow the real feature wires together:
//   daily_adjustments.js  _rainyBuildInvalidSets()   → invalid field/special name sets
//   daily_adjustments.js  _rainyScanInvalidTiles()   → [{bunk,startMin,endMin}] selections
//   daily_adjustments.js  _daPartialRegenerate()     → maps selections back to slot
//     indices (±2 min) and builds window.__regenSlotScope for scheduler_core_main.
//
// Invariants proven:
//   1. RAIN: exactly the tiles on outdoor fields (rainyDayAvailable !== true) and
//      the specials the solver drops in rain (rainyDayAvailable === false ||
//      availableOnRainyDay === false) are selected; indoor tiles are not.
//   2. SUN: exactly the tiles holding rainy-only specials (rainyDayOnly /
//      rainyDayExclusive) are selected.
//   3. Continuation, transition, Free, and empty slots are never selected.
//   4. Selections carry the slot's own start/end minutes, so the regen core's
//      ±2-minute time mapping resolves every selection back to its slot index.
//   5. Fed through the regen-scope build, ONLY the weather-invalid tiles are
//      re-rolled; every valid tile (including sibling bunks') is preserved.
//   6. Division scoping: bunks outside the passed divisions are never scanned.

const test = require('node:test');
const assert = require('node:assert');

// ── Pure re-implementations of the production logic under test ──────────────
// (mirrors daily_adjustments.js — keep in sync)

function rainyBuildInvalidSets(mode, fields, specials) {
  const norm = n => String(n || '').toLowerCase().trim();
  const fieldSet = new Set();
  const specialSet = new Set();
  if (mode === 'rain') {
    fields.forEach(f => { if (f && f.name && f.rainyDayAvailable !== true) fieldSet.add(norm(f.name)); });
    specials.forEach(s => {
      if (s && s.name && (s.rainyDayAvailable === false || s.availableOnRainyDay === false)) specialSet.add(norm(s.name));
    });
  } else {
    specials.forEach(s => {
      if (s && s.name && (s.rainyDayOnly === true || s.rainyDayExclusive === true)) specialSet.add(norm(s.name));
    });
  }
  return { fields: fieldSet, specials: specialSet };
}

function rainyScanInvalidTiles(assignments, divisionTimes, divisions, invalid) {
  const norm = n => String(n || '').toLowerCase().trim();
  const toMin = v => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const m = v.match(/^(\d{1,2}):(\d{2})$/);
      if (m) return (+m[1]) * 60 + (+m[2]);
      const d = new Date(v);
      if (!isNaN(d)) return d.getHours() * 60 + d.getMinutes();
    }
    return null;
  };
  const selections = [];
  Object.entries(divisions || {}).forEach(([divName, divData]) => {
    const slots = (divisionTimes || {})[divName] || [];
    (((divData || {}).bunks) || []).forEach(b => {
      const bunk = String(b);
      const arr = (assignments || {})[bunk] || [];
      for (let i = 0; i < arr.length && i < slots.length; i++) {
        const e = arr[i];
        if (!e || e.continuation || e._isTransition) continue;
        const act = norm(e._activity || e.activityName || e.sport);
        const fld = norm(e.field);
        if (!act && !fld) continue;
        if (act === 'free' || act === 'free play') continue;
        if (!((fld && invalid.fields.has(fld)) || (act && invalid.specials.has(act)))) continue;
        const s = slots[i] || {};
        const startMin = toMin((s.startMin != null) ? s.startMin : s.start);
        const endMin = toMin((s.endMin != null) ? s.endMin : s.end);
        if (startMin == null) continue;
        selections.push({ bunk, startMin, endMin });
      }
    });
  });
  return selections;
}

// daily_adjustments.js _daPartialRegenerate: time-window → slot index (±2 min).
function mapTileToSlot(divisionTimes, divName, startMin, endMin) {
  const slots = divisionTimes[divName] || [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] || {};
    const ss = (s.startMin != null) ? s.startMin : s.start;
    const se = (s.endMin != null) ? s.endMin : s.end;
    if (ss != null && Math.abs(ss - startMin) <= 2 &&
        (se == null || endMin == null || Math.abs(se - endMin) <= 2)) return i;
  }
  return -1;
}

// daily_adjustments.js _daPartialRegenerate steps 1–2 + scheduler_core_main STEP 1.
function regenerateSelections(divisions, divisionTimes, scheduleAssignments, selections) {
  const bunkToDiv = {};
  Object.entries(divisions).forEach(([dn, di]) =>
    (di.bunks || []).forEach(b => { bunkToDiv[String(b)] = dn; }));

  const regenByBunk = {};
  const affectedDivs = new Set();
  selections.forEach(sel => {
    const bunk = String(sel.bunk);
    const dn = bunkToDiv[bunk];
    if (!dn) return;
    const idx = mapTileToSlot(divisionTimes, dn, sel.startMin, sel.endMin);
    if (idx < 0) return;
    if (!regenByBunk[bunk]) regenByBunk[bunk] = new Set();
    regenByBunk[bunk].add(idx);
    affectedDivs.add(dn);
  });

  const rebuilt = {};
  affectedDivs.forEach(dn => {
    (divisions[dn].bunks || []).forEach(b => {
      const bunk = String(b);
      const regen = regenByBunk[bunk] || new Set();
      const arr = scheduleAssignments[bunk] || [];
      rebuilt[bunk] = arr.map((e, i) => {
        if (regen.has(i)) return null; // re-roll
        if (!e) return null;
        return Object.assign({}, e, { _fixed: true, _pinned: true, _regenPreserved: true });
      });
    });
  });
  return rebuilt;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const FIELDS = [
  { name: 'Field 1' },                                  // outdoor (no flag)
  { name: 'Court 1', rainyDayAvailable: false },        // outdoor (explicit)
  { name: 'Gym', rainyDayAvailable: true },             // indoor
  { name: 'Pool', rainyDayAvailable: true },            // indoor
];

const SPECIALS = [
  { name: 'Nature Hike', availableOnRainyDay: false },  // dropped in rain
  { name: 'Kayaking', rainyDayAvailable: false },       // dropped in rain
  { name: 'Movie Marathon', rainyDayOnly: true },       // rainy-only
  { name: 'Game Show', rainyDayExclusive: true },       // rainy-only
  { name: 'Arts & Crafts' },                            // always fine
];

function fixture() {
  const divisions = { Div1: { bunks: ['A', 'B'] }, Div2: { bunks: ['C'] } };
  const divisionTimes = {
    Div1: [
      { startMin: 600, endMin: 660 },
      { startMin: 660, endMin: 720 },
      { startMin: 720, endMin: 780 },
      { startMin: 780, endMin: 840 },
    ],
    Div2: [
      { startMin: 600, endMin: 660 },
      { startMin: 660, endMin: 720 },
    ],
  };
  const scheduleAssignments = {
    A: [
      { _activity: 'Soccer', field: 'Field 1' },            // outdoor → re-roll in rain
      { _activity: 'Swim', field: 'Pool' },                 // indoor → keep
      { _activity: 'Nature Hike', field: 'Gym' },           // special dropped in rain → re-roll
      { _activity: 'Arts & Crafts', field: 'Gym' },         // fine either way
    ],
    B: [
      { _activity: 'Basketball', field: 'Court 1' },        // outdoor (explicit false) → re-roll
      null,                                                 // empty → never selected
      { _activity: 'Free' },                                // Free → never selected
      { _activity: 'Movie Marathon', field: 'Gym' },        // rainy-only → re-roll on SUN
    ],
    C: [
      { _activity: 'Tennis', field: 'Field 1' },            // outdoor, other division
      { _activity: 'Game Show', field: 'Gym' },             // rainy-only, other division
    ],
  };
  return { divisions, divisionTimes, scheduleAssignments };
}

const key = s => s.bunk + '@' + s.startMin;

// ── Tests ────────────────────────────────────────────────────────────────

test('RAIN: outdoor-field tiles and rain-dropped specials selected; indoor tiles not', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const invalid = rainyBuildInvalidSets('rain', FIELDS, SPECIALS);

  assert.ok(invalid.fields.has('field 1') && invalid.fields.has('court 1'), 'outdoor fields flagged');
  assert.ok(!invalid.fields.has('gym') && !invalid.fields.has('pool'), 'indoor fields not flagged');
  assert.ok(invalid.specials.has('nature hike') && invalid.specials.has('kayaking'), 'rain-dropped specials flagged');
  assert.ok(!invalid.specials.has('movie marathon'), 'rainy-only specials are VALID in rain');

  const sel = rainyScanInvalidTiles(scheduleAssignments, divisionTimes, divisions, invalid);
  assert.deepStrictEqual(sel.map(key).sort(),
    ['A@600', 'A@720', 'B@600', 'C@600'],
    'exactly the outdoor + rain-dropped tiles across all divisions');
});

test('SUN: only rainy-only special tiles selected', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const invalid = rainyBuildInvalidSets('sun', FIELDS, SPECIALS);

  assert.strictEqual(invalid.fields.size, 0, 'no field is invalid on a regular day');
  assert.ok(invalid.specials.has('movie marathon') && invalid.specials.has('game show'));

  const sel = rainyScanInvalidTiles(scheduleAssignments, divisionTimes, divisions, invalid);
  assert.deepStrictEqual(sel.map(key).sort(), ['B@780', 'C@660'],
    'exactly the rainy-only tiles');
});

test('continuation, transition, Free, and empty slots are never selected', () => {
  const { divisions, divisionTimes } = fixture();
  const invalid = rainyBuildInvalidSets('rain', FIELDS, SPECIALS);
  const assignments = {
    A: [
      { _activity: 'Soccer', field: 'Field 1' },                        // head → selected
      { _activity: 'Soccer', field: 'Field 1', continuation: true },    // continuation → skipped
      { _activity: 'Transition', field: 'Field 1', _isTransition: true }, // transition → skipped
      null,                                                              // empty → skipped
    ],
    B: [
      { _activity: 'Free' },                                             // Free → skipped
      { _activity: 'free play', field: 'Field 1' },                      // Free Play → skipped
      null, null,
    ],
  };
  const sel = rainyScanInvalidTiles(assignments, divisionTimes, divisions, invalid);
  assert.deepStrictEqual(sel.map(key), ['A@600'],
    'only the block head is selected — the regen core expands the span');
});

test('league entries follow their field: outdoor league re-rolled, indoor league kept', () => {
  const { divisions, divisionTimes } = fixture();
  const invalid = rainyBuildInvalidSets('rain', FIELDS, SPECIALS);
  const assignments = {
    A: [
      { field: 'Field 1', _isLeague: true, matchups: 'B1 vs B2' },  // outdoor league → re-roll
      { field: 'Gym', _isLeague: true, matchups: 'B3 vs B4' },      // indoor league → keep
      null, null,
    ],
  };
  const sel = rainyScanInvalidTiles(assignments, divisionTimes, divisions, invalid);
  assert.deepStrictEqual(sel.map(key), ['A@600']);
});

test('selections round-trip through the ±2-min slot mapping and regen-scope build', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const invalid = rainyBuildInvalidSets('rain', FIELDS, SPECIALS);
  const sel = rainyScanInvalidTiles(scheduleAssignments, divisionTimes, divisions, invalid);

  // Every selection maps back to a slot index (invariant 4).
  sel.forEach(s => {
    const dn = divisions.Div1.bunks.includes(s.bunk) ? 'Div1' : 'Div2';
    assert.notStrictEqual(mapTileToSlot(divisionTimes, dn, s.startMin, s.endMin), -1,
      'selection must be mappable: ' + key(s));
  });

  const rebuilt = regenerateSelections(divisions, divisionTimes, scheduleAssignments, sel);

  // Weather-invalid tiles emptied for re-roll.
  assert.strictEqual(rebuilt.A[0], null, 'outdoor Soccer re-rolled');
  assert.strictEqual(rebuilt.A[2], null, 'rain-dropped Nature Hike re-rolled');
  assert.strictEqual(rebuilt.B[0], null, 'outdoor Basketball re-rolled');
  assert.strictEqual(rebuilt.C[0], null, 'outdoor Tennis re-rolled (own division scope)');

  // Every valid tile preserved byte-for-byte and pinned.
  assert.ok(rebuilt.A[1]._pinned && rebuilt.A[1]._activity === 'Swim', 'indoor Swim kept');
  assert.ok(rebuilt.A[3]._pinned && rebuilt.A[3]._activity === 'Arts & Crafts', 'neutral special kept');
  assert.ok(rebuilt.B[3]._pinned && rebuilt.B[3]._activity === 'Movie Marathon',
    'rainy-only special kept during RAIN');
  assert.ok(rebuilt.C[1]._pinned && rebuilt.C[1]._activity === 'Game Show', 'sibling-division valid tile kept');
});

test('division scoping: bunks outside the passed divisions are never scanned', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const invalid = rainyBuildInvalidSets('rain', FIELDS, SPECIALS);
  // Scheduler role clamped to Div1 only (mirrors _rainyScopedDivisions).
  const scoped = { Div1: divisions.Div1 };
  const sel = rainyScanInvalidTiles(scheduleAssignments, divisionTimes, scoped, invalid);
  assert.ok(sel.every(s => s.bunk !== 'C'), 'clamped-out division untouched');
  assert.deepStrictEqual(sel.map(key).sort(), ['A@600', 'A@720', 'B@600']);
});

test('string slot times (HH:MM / date strings) are normalized to minutes', () => {
  const invalid = rainyBuildInvalidSets('rain', FIELDS, SPECIALS);
  const divisions = { Div1: { bunks: ['A'] } };
  const divisionTimes = {
    Div1: [
      { start: '10:00', end: '11:00' },                       // HH:MM strings
      { start: '2026-07-05T11:00:00', end: '2026-07-05T12:00:00' }, // date strings
    ],
  };
  const assignments = {
    A: [
      { _activity: 'Soccer', field: 'Field 1' },
      { _activity: 'Basketball', field: 'Court 1' },
    ],
  };
  const sel = rainyScanInvalidTiles(assignments, divisionTimes, divisions, invalid);
  assert.deepStrictEqual(sel.map(s => s.startMin), [600, 660], 'both string shapes parsed');
});
