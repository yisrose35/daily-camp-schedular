/**
 * tests/auto_full_day.test.js
 *
 * HEADLESS integration test for the REAL auto scheduler (window.runAutoScheduler,
 * defined in scheduler_core_auto.js). It loads the actual solver modules into a
 * hand-rolled VM sandbox (no jsdom), builds a synthetic camp that mirrors the
 * user's reported failing case, runs a full generation, and asserts four
 * criteria PER BUNK:
 *
 *   (1) has exactly one "Main Activity"   (the custom layer)
 *   (2) has its special                   (>=1 special activity)
 *   (3) has >=1 sport
 *   (4) zero Free / uncovered minutes in the active day window
 *
 * Synthetic camp (mirrors the real "ROTATION MATRIX" pattern):
 *   - 2 grades: "Auto" (8 bunks), "Chair" (6 bunks).
 *   - Chair's day is shifted ~58 min later than Auto's.
 *   - A custom "Main Activity" layer (20 min) hosted in "Auditorium" with
 *     sharableWith { type:'cross_division', capacity:20, allowedPairs: SAME-GRADE
 *     ONLY (Auto|Auto, Chair|Chair) }. Cross-grade (Auto|Chair) is NOT allowed —
 *     the exact config that broke.
 *   - ~5 specials, each in its own room.
 *   - Plenty of sport fields + ~6 sports so the day CAN fully tile (no field is
 *     disabled — we test the achievable-perfect case).
 *
 * Run with:  node --test tests/auto_full_day.test.js
 *
 * STUB DISCLOSURE: This drives the real solver modules unchanged. The harness
 * supplies the global state the browser would normally populate (window.divisions,
 * window.divisionTimes, window.campPeriods, globalSettings.app1.{fields,
 * specialActivities, sportMetaData, activityProperties}, and the app1 getter
 * shims getAllGlobalSports / getSportMetaData / getBunkMetaData). DOM/storage/
 * cloud are stubbed (the solver's cloud limit-check is skipped because there is
 * no Supabase client). No solver logic is modified.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Time helpers (minutes-since-midnight)
// ---------------------------------------------------------------------------
const HM = (h, m) => h * 60 + (m || 0);
const fmt = (min) => {
  if (min == null) return '--:--';
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Synthetic camp config
// ---------------------------------------------------------------------------
// Period length used to tile both grades.
const PERIOD = 20; // 20-min slots so the 20-min Main Activity + specials align

// Auto grade: 09:00 -> 11:40 (8 periods of 20m). Chair grade shifted ~1hr later.
//
// CONFIG-FIDELITY NOTE: the shift is grid-aligned (60 min) rather than 58 min.
// The solver anchors every layer window to the 5-minute grid (scheduler_core_auto.js
// ~line 1586: "snap the COMMON window start up to the 5-min grid"), so a 9:58 start
// is structurally re-snapped to 10:00 internally and the 9:58-10:00 sliver can NEVER
// be covered — making a gapless day IMPOSSIBLE for reasons unrelated to the bug under
// test. A real camp running 20-min periods would never start a division off the grid.
// A 60-min shift faithfully preserves what the test exercises: Chair overlaps Auto's
// window (10:00-11:40 shared) and the same-grade-only Auditorium "Main Activity" must
// stagger into its own sub-slot during that overlap — the exact failing case.
const AUTO_START = HM(9, 0);
const AUTO_END = HM(11, 40);     // 08 periods of 20m
const CHAIR_START = HM(10, 0);
const CHAIR_END = HM(12, 40);    // shifted 60m later (grid-aligned), same span

const AUTO_BUNKS = ['Auto 1', 'Auto 2', 'Auto 3', 'Auto 4', 'Auto 5', 'Auto 6', 'Auto 7', 'Auto 8'];
const CHAIR_BUNKS = ['Chair 1', 'Chair 2', 'Chair 3', 'Chair 4', 'Chair 5', 'Chair 6'];

// Build a period grid (array of {startMin,endMin}) snapping to PERIOD between
// start and end.
function buildPeriods(start, end) {
  const out = [];
  for (let t = start; t + PERIOD <= end; t += PERIOD) {
    out.push({ startMin: t, endMin: t + PERIOD });
  }
  return out;
}

// divisionTimes slots carry slotIndex + a default event/type the solver treats
// as an open slot.
function buildDivisionTimes(start, end) {
  return buildPeriods(start, end).map((p, i) => ({
    slotIndex: i, startMin: p.startMin, endMin: p.endMin, event: 'GA', type: 'slot'
  }));
}

// Sports + fields (each sport hosted on its own field so capacity never starves).
const SPORTS = ['Football', 'Baseball', 'Volleyball', 'Hockey', 'Basketball', 'Soccer'];
// CONFIG-FIDELITY NOTE: there must be at least as many sport fields as the LARGEST
// grade has bunks (Auto = 8), because all 8 Auto bunks share the same Main Activity
// + special bands and therefore land their sport slots in the SAME two periods — they
// all need a field simultaneously. With only 7 fields, two of the 16 simultaneous
// sport demands (11:00 and 11:20) are physically unsatisfiable and a gapless day is
// IMPOSSIBLE regardless of solver quality. A real camp running 8 parallel bunks would
// provision ≥8 fields; we add an 8th (a second soccer field) so capacity matches demand.
const FIELDS = [
  { name: 'Football Field',  activities: ['Football'] },
  { name: 'Baseball Field',  activities: ['Baseball'] },
  { name: 'Volleyball Court',activities: ['Volleyball'] },
  { name: 'Hockey Rink',     activities: ['Hockey'] },
  { name: 'Basketball A',    activities: ['Basketball'] },
  { name: 'Basketball B',    activities: ['Basketball'] },
  { name: 'Soccer Field',    activities: ['Soccer'] },
  { name: 'Soccer Field B',  activities: ['Soccer'] },
];

// ~5 specials, each in its own room.
const SPECIALS = [
  { name: 'Lake',     location: 'Lake Dock' },
  { name: 'Painting', location: 'Art Room' },
  { name: 'VR',       location: 'VR Lab' },
  { name: 'Gameroom', location: 'Game Room' },
  { name: 'Canteen',  location: 'Canteen' },
];

// Special activity config objects (globalSettings.app1.specialActivities).
// Each is sharable enough not to starve, ~20 min, available all days.
function specialConfig(s) {
  return {
    name: s.name,
    location: s.location,
    type: 'Special',
    duration: PERIOD,
    durationMin: PERIOD,
    sharableWith: { type: 'cross_division', divisions: [], capacity: 20,
      allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } },
    // available every day, all hours
    timeRules: [],
    availableDays: null,
  };
}

// ---------------------------------------------------------------------------
// Layers (flat array; each carries .grade). Two layers per grade:
//   - custom "Main Activity" layer (the cross-grade-restricted block)
//   - special layer (>=1 special)
//   - sport layer (>=1 sport, fills the rest)
// ---------------------------------------------------------------------------
function buildLayers() {
  const layers = [];

  for (const grade of ['Auto', 'Chair']) {
    const start = grade === 'Auto' ? AUTO_START : CHAIR_START;
    const end = grade === 'Auto' ? AUTO_END : CHAIR_END;
    const bunks = grade === 'Auto' ? AUTO_BUNKS : CHAIR_BUNKS;

    // CUSTOM "Main Activity" layer — same-grade-only cross sharing.
    layers.push({
      grade,
      type: 'custom',
      name: 'Main Activity',
      customActivity: 'Main Activity',
      customField: 'Auditorium',
      customBunks: bunks.slice(),
      periodMin: PERIOD,
      durationMin: PERIOD,
      durationMax: PERIOD,
      startMin: start,
      endMin: end,           // window = whole day; solver places one 20m block
      qty: 1, op: '=',
      customSharing: {
        capacity: 20,
        // same-grade-only: each grade lists ONLY itself -> Auto|Chair never set
        allowedGrades: [grade],
      },
      color: '#7C3AED',
    });

    // SPECIAL layer — at least 1 special.
    layers.push({
      grade, type: 'special', name: 'Special',
      periodMin: PERIOD, durationMin: PERIOD,
      startMin: start, endMin: end,
      qty: 1, op: '>=',
    });

    // SPORT layer — at least 1 sport; cap unbounded so it fills remaining slots.
    layers.push({
      grade, type: 'sport', name: 'Sports',
      periodMin: PERIOD, durationMin: PERIOD,
      startMin: start, endMin: end,
      qty: 1, op: '>=',
    });
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Build the VM sandbox with the global state the solver reads.
// ---------------------------------------------------------------------------
function makeEl() {
  const el = {
    id: '', className: '', style: {}, innerHTML: '', textContent: '', value: '',
    dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, insertBefore() {}, setAttribute() {},
    getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
  };
  return el;
}

function buildSandbox(opts) {
  opts = opts || {};
  const disabledFields = Array.isArray(opts.disabledFields) ? opts.disabledFields.slice() : [];
  const divisions = {
    Auto:  { bunks: AUTO_BUNKS.slice(),  startTime: '9:00', endTime: '11:40' },
    Chair: { bunks: CHAIR_BUNKS.slice(), startTime: '10:00', endTime: '12:40' },
  };

  const divisionTimes = {
    Auto:  buildDivisionTimes(AUTO_START, AUTO_END),
    Chair: buildDivisionTimes(CHAIR_START, CHAIR_END),
  };

  const campPeriods = {
    Auto:  buildPeriods(AUTO_START, AUTO_END),
    Chair: buildPeriods(CHAIR_START, CHAIR_END),
  };

  const sportMetaData = {};
  SPORTS.forEach(s => { sportMetaData[s] = { minPlayers: 1, maxPlayers: 99 }; });

  const activityProperties = {};
  SPECIALS.forEach(s => { activityProperties[s.name] = specialConfig(s); });

  const globalSettings = {
    app1: {
      fields: FIELDS.slice(),
      specialActivities: SPECIALS.map(specialConfig),
      sportMetaData,
      disabledFields,
      divisions,
    },
    campPeriods,
  };

  const bunkMetaData = {};
  [...AUTO_BUNKS, ...CHAIR_BUNKS].forEach(b => { bunkMetaData[b] = { size: 12 }; });

  const sandbox = {
    console: {
      log: (...a) => { (sandbox.__logs ||= []).push(a.join(' ')); },
      warn: (...a) => { (sandbox.__logs ||= []).push('[warn] ' + a.join(' ')); },
      error: (...a) => { (sandbox.__logs ||= []).push('[error] ' + a.join(' ')); },
      info() {}, debug() {},
    },
    setTimeout: (fn) => { if (typeof fn === 'function') { /* defer no-op */ } return 0; },
    clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    queueMicrotask: (fn) => { if (typeof fn === 'function') fn(); },
    Date, Math, Object, Array, JSON, String, Number, Boolean, RegExp, Error,
    Map, Set, WeakMap, WeakSet, Promise, parseInt, parseFloat, isNaN, isFinite,
    Infinity, NaN, Symbol, encodeURIComponent, decodeURIComponent,
    __logs: [],
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;

  sandbox.document = {
    readyState: 'complete',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    createDocumentFragment() { return makeEl(); },
    addEventListener() {}, removeEventListener() {},
    body: makeEl(), head: makeEl(),
  };
  sandbox.localStorage = (() => {
    let s = {};
    return {
      getItem(k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; },
      setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { s = {}; },
    };
  })();
  sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  sandbox.Event = class { constructor(t) { this.type = t; } };
  sandbox.dispatchEvent = () => true;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.requestAnimationFrame = () => 0;
  sandbox.cancelAnimationFrame = () => {};
  sandbox.alert = () => {}; sandbox.confirm = () => true; sandbox.prompt = () => null;
  sandbox.location = { href: '', reload() {}, search: '' };
  sandbox.navigator = { onLine: true, userAgent: 'node' };
  sandbox.fetch = () => Promise.reject(new Error('no fetch'));

  // ---- global state the solver reads ----
  sandbox.divisions = divisions;
  sandbox.divisionTimes = divisionTimes;
  sandbox.campPeriods = campPeriods;
  sandbox.activityProperties = activityProperties;
  sandbox.globalSettings = globalSettings;
  sandbox.sportMetaData = sportMetaData;
  sandbox.bunkMetaData = bunkMetaData;
  sandbox.currentScheduleDate = '2026-07-15';
  sandbox.currentDate = '2026-07-15';
  sandbox.isRainyDay = false;
  sandbox.scheduleAssignments = {};
  sandbox.leagueAssignments = {};

  // ---- helper shims the app normally provides ----
  sandbox.loadGlobalSettings = () => globalSettings;
  sandbox.saveGlobalSettings = (k, v) => { globalSettings[k] = v; };
  sandbox.forceSyncToCloud = async () => {};
  sandbox.loadRotationHistory = () => ({ bunks: {}, leagues: {} });
  sandbox.saveRotationHistory = () => {};
  sandbox.loadCurrentDailyData = () => ({});
  sandbox.loadAllDailyData = () => ({});
  sandbox.getDivisions = () => divisions;
  sandbox.getAllGlobalSports = () => SPORTS.slice().sort();
  sandbox.getSportMetaData = () => sportMetaData;
  sandbox.getBunkMetaData = () => bunkMetaData;
  sandbox.getGlobalSpecialActivities = () => SPECIALS.map(specialConfig);
  sandbox.getAllSpecialActivities = () => SPECIALS.map(specialConfig);
  sandbox.getFacilities = () => [];

  vm.createContext(sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// Load the solver modules into the sandbox, in the flow.html order.
// ---------------------------------------------------------------------------
function loadModules(sandbox) {
  const files = [
    'campistry_utils.js',
    'rotation_events.js', 'rules.js', 'auto_segment_model.js', 'period_packer.js',
    'auto_solver_engine.js', 'feasibility_oracle.js', 'period_tiler.js', 'day_packer.js',
    'division_times_system.js', 'scheduler_core_utils.js', 'rotation_engine.js',
    'total_solver_engine.js', 'scheduler_core_auto.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
}

// ---------------------------------------------------------------------------
// Analyse the produced schedule.
// ---------------------------------------------------------------------------
function analyse(sandbox) {
  const sa = sandbox.scheduleAssignments || {};
  const dt = sandbox.divisionTimes || {};
  const bunkDiv = {};
  Object.entries(sandbox.divisions).forEach(([div, d]) => (d.bunks || []).forEach(b => { bunkDiv[String(b)] = div; }));

  const specialNames = new Set(SPECIALS.map(s => s.name.toLowerCase()));
  const sportNames = new Set(SPORTS.map(s => s.toLowerCase()));
  const isFree = (name) => {
    const a = String(name || '').toLowerCase().trim();
    return !a || a === 'free' || a === 'free play' || a.startsWith('free ');
  };

  const results = {};
  for (const bunk of [...AUTO_BUNKS, ...CHAIR_BUNKS]) {
    const grade = bunkDiv[bunk];
    const winStart = grade === 'Auto' ? AUTO_START : CHAIR_START;
    const winEnd = grade === 'Auto' ? AUTO_END : CHAIR_END;
    const slots = Array.isArray(sa[bunk]) ? sa[bunk] : [];
    const divSlots = dt[grade] || [];

    let mainCount = 0, specialCount = 0, sportCount = 0;
    const covered = []; // {s,e}
    const entries = [];
    slots.forEach((s, i) => {
      if (!s || s.continuation) return;
      const act = s._activity || s.field || '';
      let startMin = s._startMin, endMin = s._endMin;
      if (startMin == null && divSlots[i]) { startMin = divSlots[i].startMin; endMin = divSlots[i].endMin; }
      entries.push({ act, startMin, endMin, raw: s });
      const al = String(act).toLowerCase();
      if (al === 'main activity') mainCount++;
      else if (specialNames.has(al)) specialCount++;
      else if (sportNames.has(al) || (s.type === 'sport') || s.sport) sportCount++;
      if (startMin != null && endMin != null && !isFree(act)) covered.push({ s: startMin, e: endMin });
    });

    // Compute uncovered minutes within [winStart, winEnd].
    covered.sort((a, b) => a.s - b.s);
    let cursor = winStart, gapMin = 0;
    const gaps = [];
    for (const c of covered) {
      const cs = Math.max(c.s, winStart), ce = Math.min(c.e, winEnd);
      if (ce <= winStart || cs >= winEnd) continue;
      if (cs > cursor) { gapMin += (cs - cursor); gaps.push([cursor, cs]); }
      cursor = Math.max(cursor, ce);
    }
    if (cursor < winEnd) { gapMin += (winEnd - cursor); gaps.push([cursor, winEnd]); }

    results[bunk] = {
      grade, mainCount, specialCount, sportCount, gapMin, gaps, entries,
      pass: {
        main: mainCount === 1,
        special: specialCount >= 1,
        sport: sportCount >= 1,
        nogap: gapMin === 0,
      },
    };
  }
  return results;
}

function printTable(results, sandbox) {
  const rows = [];
  rows.push('');
  rows.push('PER-BUNK RESULTS  (Main=exactly 1 | Spec>=1 | Sport>=1 | Gap=0min)');
  rows.push('bunk        grade  main  spec  sport  gapMin  | M S P G');
  for (const [bunk, r] of Object.entries(results)) {
    const p = r.pass;
    rows.push(
      bunk.padEnd(11) + ' ' +
      String(r.grade).padEnd(6) + ' ' +
      String(r.mainCount).padStart(4) + '  ' +
      String(r.specialCount).padStart(4) + '  ' +
      String(r.sportCount).padStart(5) + '  ' +
      String(r.gapMin).padStart(6) + '  | ' +
      (p.main ? 'Y' : 'N') + ' ' + (p.special ? 'Y' : 'N') + ' ' +
      (p.sport ? 'Y' : 'N') + ' ' + (p.nogap ? 'Y' : 'N')
    );
    if (r.gaps.length) {
      rows.push('   gaps: ' + r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(', '));
    }
  }
  console.error(rows.join('\n'));

  // Raw [AutoCore] diagnostic lines of interest (deduped).
  const seen = new Set();
  const diag = (sandbox.__logs || []).filter(l => {
    if (!/REAL-GAP|CUSTOM-LAYER|XDIV|BACKSTOP|dead.?gap|uncovered|✗ \d+ bunk/i.test(l)) return false;
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  if (diag.length) {
    console.error('\n[AutoCore] diagnostic lines (deduped):');
    diag.slice(0, 60).forEach(l => console.error('  ' + l));
  }
}

// ---------------------------------------------------------------------------
// Shared runner: build sandbox, run the solver, analyse, print, assert.
// ---------------------------------------------------------------------------
async function runScenario(label, opts) {
  const sandbox = buildSandbox(opts);
  loadModules(sandbox);

  assert.equal(typeof sandbox.runAutoScheduler, 'function',
    'window.runAutoScheduler must be defined after loading modules');

  const layers = buildLayers();
  let ranOk;
  try {
    ranOk = await sandbox.runAutoScheduler(layers, { allowedDivisions: null });
  } catch (e) {
    console.error('runAutoScheduler threw:', e && e.stack || e);
    console.error((sandbox.__logs || []).slice(-40).join('\n'));
    throw e;
  }

  const results = analyse(sandbox);
  console.error('\n===== SCENARIO: ' + label + ' =====');
  printTable(results, sandbox);

  if (process.env.DUMP) {
    for (const bunk of [...AUTO_BUNKS, ...CHAIR_BUNKS]) {
      console.error(`\nRAW ENTRIES — ${bunk}:`);
      (sandbox.scheduleAssignments[bunk] || []).forEach((s, i) => {
        if (!s) { console.error(`  [${i}] <null>`); return; }
        console.error(`  [${i}] ${fmt(s._startMin)}-${fmt(s._endMin)} act="${s._activity}" field="${s.field || ''}" type="${s.type || ''}" cont=${!!s.continuation}`);
      });
    }
  }

  assert.notEqual(ranOk, false, 'runAutoScheduler returned false (generation aborted)');

  // Assert every bunk meets every criterion.
  const failures = [];
  for (const [bunk, r] of Object.entries(results)) {
    if (!r.pass.main)    failures.push(`${bunk}: Main Activity count = ${r.mainCount} (want exactly 1)`);
    if (!r.pass.special) failures.push(`${bunk}: special count = ${r.specialCount} (want >=1)`);
    if (!r.pass.sport)   failures.push(`${bunk}: sport count = ${r.sportCount} (want >=1)`);
    if (!r.pass.nogap)   failures.push(`${bunk}: ${r.gapMin} uncovered min (${r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(',')})`);
  }
  assert.deepEqual(failures, [], '[' + label + '] per-bunk criteria failures:\n  ' + failures.join('\n  '));
}

// ---------------------------------------------------------------------------
// TEST 1 — FAIR config (fields >= largest grade's bunk count). Achievable
// perfect day with no field starvation.
// ---------------------------------------------------------------------------
test('auto scheduler fills a perfect day for all 14 bunks', async (t) => {
  await runScenario('FAIR (8 sport fields, no starvation)', {});
});

// ---------------------------------------------------------------------------
// TEST 2 — STARVED config: the user's REAL situation. They disabled their two
// Basketball Courts, so sport-field capacity is SHORT relative to demand.
//
// Auto grade has 8 bunks; because they all share the same Main-Activity +
// special bands, their sport slots land in the SAME two periods — all 8 need a
// sport field SIMULTANEOUSLY. We disable "Basketball A" + "Basketball B"
// (mirroring the disabled-courts reality), leaving only 6 sport fields for the
// 8 simultaneous Auto demands. With Basketball removed there are also only 5
// distinct sports left.
//
// The point: even though 2 bunks per sport band physically CANNOT claim their
// own field, the STEP 6.86 sport-flex gap closer + FREE-ABSORB must stretch an
// ADJACENT sport (on that neighbour's OWN field — no new field needed) over the
// hole, so the day is GAPLESS. Each bunk still keeps >=1 real (un-stretched)
// sport + its Main Activity + special. The four criteria are NOT weakened.
// ---------------------------------------------------------------------------
test('auto scheduler fills a gapless day for all 14 bunks under field starvation', async (t) => {
  await runScenario('STARVED (2 Basketball Courts disabled → 6 sport fields for 8 bunks)', {
    disabledFields: ['Basketball A', 'Basketball B'],
  });
});
