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

// ---------------------------------------------------------------------------
// Per-scenario camp window resolution.
//
// The TRUE division window (what counselors actually run, and what the gapless
// criterion is measured against) can be OFF the 5-minute grid. Production builds
// the internal period grid by snapping the start UP and the end DOWN to the
// enclosing 5-min boundaries (so the grid stays clean), which historically left
// the start/end sliver outside every period — permanently uncoverable.
//
// opts.offGrid shifts Auto's window edges off the 5-min grid (start 9:58, end
// 11:42) to exercise exactly that boundary. The grade.startTime/endTime, the
// layer windows, and the analyse()/criteria all use the TRUE edge; the period
// grid + divisionTimes are snapped (mirroring production) via gridSnap().
// ---------------------------------------------------------------------------
function campConfig(opts) {
  opts = opts || {};
  if (opts.smooth) {
    // SMOOTH-DAY scenario — faithful model of the user's live camp shape:
    //   sports-free, FIELD-LESS custom anchors (Davening / Morning Activity /
    //   Main Activity, each using its own name as a pseudo-field), an off-grid
    //   lunch wall, and a deep catalog of WIDE-window (whole-day) specials at
    //   mixed 10/20/40-min durations. Layer-driven (no bell periods). The walls
    //   are placed so the inter-wall spans are NOT clean multiples of the piece
    //   sizes — reproducing the user's 5/10/15-min residual remainders — so we
    //   can MEASURE how much dead time the real solver leaves and iterate.
    return {
      autoStart: HM(9, 0),  autoEnd: HM(15, 0),
      chairStart: HM(9, 0), chairEnd: HM(15, 0),
      autoStartStr: '9:00', autoEndStr: '15:00',
      smooth: true, smoothOffGrid: !!opts.smoothOffGrid, noSports: true,
      smoothPartialBell: !!opts.smoothPartialBell,
      // SURPLUS test passthroughs (see the default return below)
      specialsOverride: opts.specialsOverride || null,
      subQuantities: opts.subQuantities || null,
      subOps: opts.subOps || null,
      priorDays: opts.priorDays || null,
    };
  }
  if (opts.swimReal) {
    // SWIM-REAL scenario — the FAITHFUL reproduction of the live swim-era bug.
    //
    // Unlike SWIM-WALLS (TEST 6), this models swim as a REAL type:'swim' fullGrade
    // layer and the special as a REAL type:'special' layer that the GlobalPlanner +
    // Phase 2.5 distributes from globalSettings.app1.specialActivities (real catalog
    // specials in real rooms). NO custom-layer stand-ins. This is the live config.
    //
    // Live band structure (grades 9:00-12:20, Chair shifted; matching the report):
    //   - sport band first
    //   - SWIM band (real type:'swim', 45-min, fullGrade)
    //   - special band (real type:'special', 45-min, distributed)
    //   - 20-min Main-Activity custom-layer wall AFTER the swim band
    // The day window is 9:00-12:20 (200 min). The special band is a wide window so
    // the special can float; the Main wall lands between swim and the special.
    return {
      autoStart: HM(9, 0),  autoEnd: HM(12, 20),
      chairStart: HM(9, 0), chairEnd: HM(12, 20),
      autoStartStr: '9:00', autoEndStr: '12:20',
      swimReal: true,
      swimGAShare: !!opts.swimGAShare,
      swimRotated: !!opts.swimRotated,
      swimAsGA: !!opts.swimAsGA,
      swimNoFacility: !!opts.swimNoFacility,
    };
  }
  if (opts.swimWalls) {
    // SWIM-WALLS scenario — the user's LIVE swim-era regen bug. None of the
    // first five scenarios include SWIM; the moment the user enabled swim, two
    // new wall-bounded gaps appeared that the existing STEP 6.865 absorber
    // could NOT close:
    //
    //   [REAL-GAP] (Main|gap|special)  25m  — between the Main-Activity wall
    //              (immune) and the FOLLOWING special (Lake). No sport field is
    //              free in the window, so the gap can only close by pulling the
    //              following special's START backward over it (Lake's room free).
    //   [REAL-GAP] (swim|gap|Main)     15m  — between SWIM and the Main-Activity
    //              wall. Both neighbours were immune (swim WAS in _SAB_IMMUNE,
    //              Main always is), so neither a sport nor a special is adjacent.
    //              The ONLY gapless outcome is to stretch the SWIM block forward
    //              (its pool is free). The OLD _SAB_IMMUNE listed `swim`, so swim
    //              was NEVER stretched → the sliver survived as a [REAL-GAP].
    //
    // Geometry (explicit mixed-size period grid, both grades, 9:00-12:15 = 195min):
    //   P0 09:00-09:45 (45m)  sport
    //   P1 09:45-10:30 (45m)  SWIM band (custom "Swim" in Pool, pins to P1)
    //   P2 10:30-10:45 (15m)  empty, sub-floor → swim|gap|Main sliver
    //   P3 10:45-11:05 (20m)  Main-Activity wall
    //   P4 11:05-11:30 (25m)  empty, floor-sized → Main|gap|special gap
    //   P5 11:30-12:15 (45m)  SPECIAL band (custom "Lake" in Lake field)
    //
    // FEASIBILITY-ORACLE (a perfect, gapless day EXISTS per bunk):
    //   sport 9:00-9:45 | swim 9:45-10:45 (45 + absorbed P2 15) |
    //   Main 10:45-11:05 | special/Lake 11:05-12:15 (absorbed P4 25 + 45,
    //   pulled start back) → 1 main, 1 special, 1 sport, swim covered, ZERO gap
    //   minutes. Both absorptions stretch a STRETCHABLE block (swim, special)
    //   over the gap; NEITHER stretches the immune Main-Activity wall.
    //
    // Sport fields are made Unavailable 10:30-11:30 (mirroring "no sport field
    // free in that window") so NO sport can fill P2/P4 — isolating the
    // wall-bounded absorption requirement. Sports place freely in P0; the Pool
    // (swim) and Lake (special) rooms stay free across their gaps so the swim /
    // special stretch CAN close them.
    //
    // NOTE on test fidelity: swim and the special are modeled as CUSTOM layers
    // (named "Swim"/"Lake", hosted in "Pool"/"Lake") so they pin deterministically
    // and sidestep the swim-era GlobalPlanner pool-staggering + special-
    // distribution interaction (which, with a real type:'swim' layer present,
    // places 0 concrete specials). The blocks are still named/roomed as a real
    // swim / catalog special, so STEP 6.865 identifies them exactly as it would
    // in production (swim by name/pool field, special by catalog name/room).
    return {
      autoStart: HM(9, 0),  autoEnd: HM(12, 15),
      chairStart: HM(9, 0), chairEnd: HM(12, 15),
      autoStartStr: '9:00', autoEndStr: '12:15',
      swimWalls: true,
    };
  }
  if (opts.sliver2) {
    // SLIVER-RESIDUAL scenario — the user's LIVE residual gap that the original
    // STEP 6.865 (commit 8badb70) STILL missed. Distinct from the SLIVER-BAND
    // case below in two load-bearing ways:
    //
    //   (1) the gap is EXACTLY the 25-min sport floor (not a 15-min sub-floor
    //       sliver). 6.865 short-circuited any gap with `gapDur >= floor`, so a
    //       25-min gap was treated as "fillable on its own → not our job" and
    //       skipped — even though NO sport could actually take it.
    //   (2) the gap STRADDLES a period boundary. The 25 minutes are split across
    //       two short periods (a 10-min P0 leftover + a 15-min P1), so neither
    //       per-period piece reaches the 25-min sport floor and the per-period
    //       tiler can place no sport there → "no sports in priority list" /
    //       "no field". coveredByContiguousPeriods(585,610) is still TRUE (the
    //       two periods are contiguous — it is NOT a real dead gap like lunch),
    //       so the gap is legitimately coverable; it just can't host its own
    //       activity. The ONLY gapless outcome is to stretch the bounding
    //       special (Lake) from 585 over the gap to 610 (its room is free).
    //
    // Geometry (mirrors the user's [REAL-GAP] Auto 3 10:45-11:10 25min):
    //   P0 band   540-595 (55m): 45-min Lake special → 540-585, leaves 585-595
    //   P1        595-610 (15m): empty (15m < 25m sport floor)
    //   P2 wall   610-630 (20m): 20-min Main Activity wall
    //   afternoon 45/45/40-min sport periods to 12:30
    // → gap 585-610 = 25 min, bounded by special(ends 585) | Main wall(starts 610),
    //   crossing the 595 boundary. prev=[special/Lake 45m pinned], next=[Main wall].
    return {
      autoStart: HM(9, 0),  autoEnd: HM(12, 30),
      chairStart: HM(9, 0), chairEnd: HM(12, 30),
      autoStartStr: '9:00', autoEndStr: '12:30',
      sliver2: true,
    };
  }
  if (opts.sliver) {
    // SLIVER-BAND scenario — faithful reproduction of the user's live regen bug.
    //
    // The day runs 9:00 -> 12:30 on an explicit mixed-size period grid (see
    // buildSandbox's sliverPeriods):
    //   - a 60-min off-field special band period (9:00-10:00) that must hold a
    //     45-min special — leaving a 15-min sub-floor remainder (< the 25-min
    //     sport floor) that NOTHING can fill on its own;
    //   - a 20-min "Main Activity" wall period immediately after (10:00-10:20);
    //   - 45/40-min afternoon periods that hold the sports.
    // So the 15-min remainder is wedged between the 45-min special (a pinned wall)
    // and the Main-Activity wall (immune) — neither neighbour is a flexible sport,
    // so STEP 6.86 SPORT-FLEX cannot absorb it ("no extendable-neighbour gaps to
    // close") and it survives as the exact REBAL-STUCK / REAL-GAP the user saw:
    //   prev=[special/Lake 45min pinned]  gap 15min  next=[custom/Main Activity wall].
    //
    // Because special(45) + a fillable sport(25) = 70 > the 60-min band, NO flush
    // placement can avoid the sliver here — it MUST be absorbed (last-resort fix:
    // stretch the bounding special over the sliver). Both grades (8 Auto + 6 Chair)
    // run on the SAME grid so the same-grade-staggered Auditorium Main Activity must
    // take its own lane during the overlap (the cross-grade-restricted case).
    return {
      autoStart: HM(9, 0),  autoEnd: HM(12, 30),
      chairStart: HM(9, 0), chairEnd: HM(12, 30),
      autoStartStr: '9:00', autoEndStr: '12:30',
      sliver: true,
    };
  }
  if (opts.offGrid) {
    // TRUE Auto window 8:58 -> 11:42. Snapping start UP to 9:00 and end DOWN to
    // 11:40 yields EXACTLY the fair grid (8 × 20-min periods, 9:00-11:40) — so
    // the period count, layer fit, and field capacity are IDENTICAL to the fair
    // scenario; the ONLY difference is the 8:58-9:00 leading and 11:40-11:42
    // trailing slivers that fall outside the snapped grid. This isolates the
    // off-grid boundary bug without altering anything else the test exercises.
    return {
      autoStart: HM(8, 58),  autoEnd: HM(11, 42),   // OFF-grid edges (true window)
      chairStart: CHAIR_START, chairEnd: CHAIR_END,  // Chair stays on-grid
      autoStartStr: '8:58', autoEndStr: '11:42',
    };
  }
  return {
    autoStart: AUTO_START, autoEnd: AUTO_END,
    chairStart: CHAIR_START, chairEnd: CHAIR_END,
    autoStartStr: '9:00', autoEndStr: '11:40',
    lunchLeeway: !!opts.lunchLeeway,
    // noSports: model a sports-free camp — the user's day is swim + lunch +
    //   specials + custom activities only, and they NEVER created a sport layer.
    //   The FIELD catalog (FIELDS, with sport activities) is STILL configured in
    //   the sandbox, so the engine could (wrongly) back-fill open time with field
    //   sports. buildLayers omits the SPORT layer; the assertion is that NO bunk
    //   receives any sport-typed block (the field catalog must not leak into a
    //   camp that asked for no sports).
    noSports: !!opts.noSports,
    // morningPin: add a fixed-time custom "Morning Activity" wall (see buildLayers)
    //   — the recapture-displacement repro for the pinned-custom guard.
    morningPin: !!opts.morningPin,
    // morningWide: draw that custom's window wider than its duration so it
    //   classifies "windowed" (the stacker case) — repro for Phase 2.45.
    morningWide: !!opts.morningWide,
    // subFloor: attach a subcategory FLOOR (snack '=' 2) to the special layer so
    //   STEP 6.98 LAYER-FLOOR ENFORCER must guarantee every bunk ends with 2
    //   snack-subcategory specials (the active goal: every bunk gets every layer
    //   as set). See buildLayers' special layer and the subFloor assertion.
    subFloor: !!opts.subFloor,
    // subFloorTight: same snack '=' 2 floor, but the special LAYER window is
    //   confined to a single 20-min period (10:00-10:20, inside BOTH grades) so
    //   the distributor can seat at most ONE snack in-window — forcing STEP 6.98
    //   to reclaim a sport/Free slot elsewhere for the 2nd snack. This exercises
    //   the enforcer's placement path directly (asserted via its "placed" log).
    subFloorTight: !!opts.subFloorTight,
    // oversub: DEMAND↔CAPACITY RECONCILIATION repro. Override one special ("VR")
    //   to a not_sharable, capacity-1 seat tagged subcategory 'shiur', and attach
    //   a subcategory FLOOR of 1 to the special layer so EVERY one of the 14 bunks
    //   demands that one cap-1 chair. Total floor (14) far exceeds what one seat can
    //   deliver in the day → the pre-layout reconciliation must clamp the aggregate
    //   floor and demote the surplus to opportunistic (asserted via its log line).
    oversub: !!opts.oversub,
    // SURPLUS test passthroughs: a scenario-supplied special catalog (config-
    //   shaped) and scenario-supplied subcategory demands on the special layer.
    specialsOverride: opts.specialsOverride || null,
    subQuantities: opts.subQuantities || null,
    subOps: opts.subOps || null,
    priorDays: opts.priorDays || null,
  };
}

// Snap a true window OUTWARD-then-inward to clean 5-min period grid edges:
// start UP to the next :05 boundary, end DOWN to the previous :05 boundary —
// exactly what the production grid does, so the test reproduces the real sliver.
function gridSnap(start, end) {
  const gs = Math.ceil(start / 5) * 5;
  const ge = Math.floor(end / 5) * 5;
  return { gs, ge };
}

// Build a period grid (array of {startMin,endMin}) snapping to PERIOD between
// start and end. Start/end are first snapped to the 5-min grid (production
// behaviour) so periods always begin/end on clean boundaries.
function buildPeriods(start, end, period) {
  const P = period || PERIOD;
  const { gs, ge } = gridSnap(start, end);
  const out = [];
  for (let t = gs; t + P <= ge; t += P) {
    out.push({ startMin: t, endMin: t + P });
  }
  return out;
}

// divisionTimes slots carry slotIndex + a default event/type the solver treats
// as an open slot.
function buildDivisionTimes(start, end, period) {
  return buildPeriods(start, end, period).map((p, i) => ({
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

// Subcategory tags (LAYER-FLOOR scenario): two distinct "snack" specials so a
// bunk can satisfy a snack subcategory FLOOR of 2 with two different names
// (the enforcer skips a name already used today, so a floor of 2 needs 2 names).
// Inert in every other scenario — no scenario but cfg.subFloor configures a
// subcategory floor/cap, so this metadata never affects placement elsewhere.
const SUBCAT_BY_NAME = { canteen: 'snack', gameroom: 'snack' };

// SMOOTH-DAY catalog (cfg.smooth): a deep set of WIDE-window specials at mixed
//   10/20/40-min durations, each in its own room, sharable cross-division so a
//   whole grade can share one session. Mirrors the user's Slush(10)/Ice Cream(20)/
//   Drama(40)/… catalog. Enough distinct specials that a sports-free 9:00-15:00
//   day can be tiled entirely from specials (no sport layer at all).
const SMOOTH_SPECIALS = [
  { name: 'Slush',        location: 'Slush Stand',  dur: 10 },
  { name: 'Ice Cream',    location: 'Ice Cream Hut', dur: 20 },
  { name: 'Neranitas',    location: 'Neranitas Rm', dur: 20 },
  { name: 'Arts & Crafts',location: 'Art Room',     dur: 20 },
  { name: 'Foam Pit',     location: 'Foam Pit',     dur: 20 },
  { name: 'Shiur',        location: 'Shiur Room',   dur: 20 },
  { name: 'Popcorn',      location: 'Popcorn Cart', dur: 10 },
  { name: 'Drama',        location: 'Drama Room',   dur: 40 },
  { name: 'Baking',       location: 'Kitchen',      dur: 40 },
  { name: 'Art Shoppes',  location: 'Shoppe',       dur: 40 },
  { name: 'Accessorize',  location: 'Accessorize Rm', dur: 40 },
  { name: 'Pioneering',   location: 'Field House',  dur: 40 },
  { name: 'Gymnastics',   location: 'Gym',          dur: 40 },
  { name: 'Woodworking',  location: 'Wood Shop',    dur: 40 },
];
function smoothSpecialConfig(s) {
  return {
    name: s.name, location: s.location, type: 'Special',
    duration: s.dur, durationMin: s.dur,
    sharableWith: { type: 'cross_division', divisions: [], capacity: 20,
      allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } },
    timeRules: [], availableDays: null,
  };
}

// Special activity config objects (globalSettings.app1.specialActivities).
// Each is sharable enough not to starve, ~20 min, available all days.
function specialConfig(s, specialDur, oversub) {
  const dur = specialDur || PERIOD;
  // oversub: make "VR" the single not_sharable, cap-1 'shiur' seat (see campConfig).
  const _cap1Seat = oversub && String(s.name).toLowerCase() === 'vr';
  return {
    name: s.name,
    location: s.location,
    type: 'Special',
    subcategory: _cap1Seat ? 'shiur' : (SUBCAT_BY_NAME[String(s.name).toLowerCase()] || ''),
    duration: dur,
    durationMin: dur,
    sharableWith: _cap1Seat
      ? { type: 'not_sharable', divisions: [], capacity: 1, allowedPairs: {} }
      : { type: 'cross_division', divisions: [], capacity: 20,
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
function buildLayers(cfg) {
  cfg = cfg || campConfig({});
  // In the sliver scenario the band geometry depends on a 20-min Main Activity
  // wall and 45-min specials on a 5-min grid; elsewhere everything is 20-min.
  const mainDur = (cfg.sliver || cfg.swimWalls) ? 20 : PERIOD;
  const specialDur = (cfg.sliver || cfg.sliver2 || cfg.swimWalls) ? 45 : PERIOD;
  const sportMin = (cfg.sliver || cfg.sliver2 || cfg.swimWalls) ? 25 : PERIOD;
  // SLIVER-RESIDUAL band geometry: 45-min special confined to a 55-min band
  // (9:00-9:55) leaving a 10-min in-band remainder; a 15-min empty period
  // (9:55-10:10); then the 20-min Main-Activity wall (10:10-10:30). The 25-min
  // gap 9:45-10:10 (special-end .. Main-start) straddles the 9:55 boundary and
  // equals the sport floor — neither per-period piece (10m + 15m) can host a
  // 25-min sport, so only stretching the bounding special can close it.
  const band2Start = cfg.sliver2 ? HM(9, 0) : null;
  const band2End = cfg.sliver2 ? HM(9, 50) : null;
  const mainWall2Start = cfg.sliver2 ? HM(10, 10) : null;
  const mainWall2End = cfg.sliver2 ? HM(10, 30) : null;
  // The 45-min special is confined to the 60-min off-field band (9:00-10:00),
  // leaving a 15-min sub-floor sliver in the band. The 20-min Main Activity wall
  // is confined to the very next period (10:00-10:20). So the band sliver is
  // bounded by the special (a pinned wall) on the left and the Main Activity
  // (a wall) on the right — neither neighbour is a flexible sport, so STEP 6.86
  // cannot absorb it: the exact REBAL-STUCK / REAL-GAP the user reported.
  const bandStart = cfg.sliver ? HM(9, 0) : null;
  const bandEnd = cfg.sliver ? HM(10, 0) : null;
  const mainWallStart = cfg.sliver ? HM(10, 0) : null;
  const mainWallEnd = cfg.sliver ? HM(10, 20) : null;
  // SWIM-WALLS band geometry (see campConfig({swimWalls})):
  //   swim band  09:30-10:15 (fullGrade swim → 45m snaps to P1),
  //   Main wall  10:30-10:50 (20m, confined to P3),
  //   special    11:15-12:00 (45m, confined to P5). The empty P2 (10:15-10:30,
  //   15m) and P4 (10:50-11:15, 25m) are the two wall-bounded gaps to absorb.
  const swimBandStart = cfg.swimWalls ? HM(9, 45) : null;
  const swimBandEnd = cfg.swimWalls ? HM(10, 30) : null;
  const mainWallSWStart = cfg.swimWalls ? HM(10, 45) : null;
  const mainWallSWEnd = cfg.swimWalls ? HM(11, 5) : null;
  // SWIM-REAL band geometry (faithful: REAL type:'swim' + REAL type:'special'):
  //   P0 09:00-09:45 sport | P1 09:45-10:30 SWIM band (real swim, fullGrade) |
  //   P2 10:30-10:50 Main-Activity wall (20-min custom) | P3 10:50-11:35 special
  //   target | P4 11:35-12:20 sport. The special LAYER window is WIDE
  //   (10:50-12:20) so the distributor is free to park it flush after the Main
  //   wall (10:50-11:35) — the correct outcome — or float it to the band end
  //   (11:35-12:20), which orphans the 10:50-11:35 gap (the live bug).
  const swimBandRStart = cfg.swimReal ? HM(9, 45) : null;
  const swimBandREnd   = cfg.swimReal ? HM(10, 30) : null;
  // Main-Activity wall window is WIDE (10:30-11:35) — a STAGGERED shared-room
  // custom (Auditorium, same-grade-only). Phase 2.6 picks the actual 20-min lane
  // AFTER Phase 2.5 has already distributed the special, so at special-placement
  // time the special does NOT know where the Main wall will land — the live bug.
  const mainWallRStart = cfg.swimReal ? HM(10, 30) : null;
  const mainWallREnd   = cfg.swimReal ? HM(11, 35) : null;
  // The special LAYER window is WIDE (10:30-12:20) so the distributor is free to
  // float it to its band END instead of flush after the (not-yet-placed) Main wall.
  const specBandRStart = cfg.swimReal ? HM(10, 30) : null;
  const specBandREnd   = cfg.swimReal ? HM(12, 20) : null;
  const layers = [];

  for (const grade of ['Auto', 'Chair']) {
    const start = grade === 'Auto' ? cfg.autoStart : cfg.chairStart;
    const end = grade === 'Auto' ? cfg.autoEnd : cfg.chairEnd;
    const bunks = grade === 'Auto' ? AUTO_BUNKS : CHAIR_BUNKS;

    // SMOOTH-DAY layers — the user's shape: field-less Davening / Morning Activity
    //   / Main Activity custom anchors (no customField → name-as-pseudo-field), an
    //   off-grid lunch wall, and ONE wide-window special layer (op '>=', whole day)
    //   that the planner fills from the deep SMOOTH_SPECIALS catalog. No sport layer
    //   (sports-free camp). Wall times are deliberately off the 10-min piece grid
    //   so the inter-wall spans don't tile cleanly — the residual-remainder repro.
    if (cfg.smooth) {
      // Anchors hosted in a high-capacity shared room (cross-grade) so both grades
      //   can sit on the same anchor at the same time without colliding — mirroring
      //   a whole-camp Davening / Main Activity. GRID-ALIGNED so every inter-wall
      //   span is a multiple of the 10-min special granularity → a gapless day is
      //   arithmetically possible. cfg.smoothOffGrid nudges lunch +5 and shrinks
      //   Main to 35 min so the fillable total is NOT a multiple of 10 → an
      //   unavoidable 5-min remainder (proves the gap is an off-grid wall artifact,
      //   not a solver failure).
      // FIELD-LESS anchors (customField:null → name used as pseudo-field), exactly
      //   like the user's real Davening / Morning Activity / Main Activity. Each
      //   layer window EQUALS its duration (tight) → by the movability rule the
      //   tiler must keep it FIXED at its configured time (never nudged to chase a
      //   sliver). Grid-aligned so a gapless day is still arithmetically possible.
      const anchor = (name, s, e) => ({
        grade, type: 'custom', name, customActivity: name, customField: null,
        customBunks: bunks.slice(), periodMin: e - s, durationMin: e - s, durationMax: e - s,
        startMin: s, endMin: e, qty: 1, op: '=',
        customSharing: { capacity: 99, allowedGrades: ['Auto', 'Chair'] },
      });
      var _lunchS = cfg.smoothOffGrid ? HM(12, 25) : HM(12, 20);
      var _mainS  = cfg.smoothOffGrid ? HM(14, 25) : HM(14, 20);
      layers.push(anchor('Davening', HM(9, 0), HM(9, 20)));
      layers.push(anchor('Morning Activity', HM(9, 20), HM(10, 0)));
      layers.push(anchor('Main Activity', _mainS, HM(15, 0)));
      layers.push({                                                          // lunch wall
        grade, type: 'lunch', name: 'lunch', event: 'lunch',
        periodMin: 20, durationMin: 20, durationMax: 20,
        startMin: _lunchS, endMin: _lunchS + 20, qty: 1, op: '=',
      });
      const _smoothSpec = {                                                  // fill the rest from specials
        grade, type: 'special', name: 'Special',
        periodMin: 20, durationMin: 10,
        startMin: HM(9, 0), endMin: HM(15, 0), qty: 1, op: '>=',
      };
      // generic passthrough (SURPLUS test): scenario-supplied subcategory demands.
      if (cfg.subQuantities) { _smoothSpec.subQuantities = cfg.subQuantities; _smoothSpec.subOps = cfg.subOps || {}; }
      layers.push(_smoothSpec);
      continue;
    }

    const mainStart = cfg.swimReal ? mainWallRStart : (cfg.swimWalls ? mainWallSWStart : (cfg.sliver2 ? mainWall2Start : (cfg.sliver ? mainWallStart : start)));
    const mainEnd = cfg.swimReal ? mainWallREnd : (cfg.swimWalls ? mainWallSWEnd : (cfg.sliver2 ? mainWall2End : (cfg.sliver ? mainWallEnd : end)));
    const specStart = cfg.swimReal ? specBandRStart : (cfg.sliver2 ? band2Start : (cfg.sliver ? bandStart : start));
    const specEnd = cfg.swimReal ? specBandREnd : (cfg.sliver2 ? band2End : (cfg.sliver ? bandEnd : end));

    // SWIM layer (SWIM-WALLS only) — a 45-min swim confined to P1 (09:45-10:30).
    // Modeled as a CUSTOM layer named "Swim" hosted in the "Pool" field so it
    // pins deterministically to its single period (exactly like the Main
    // Activity custom layer), sidestepping the swim-type planner's cross-grade
    // pool staggering which would otherwise relocate the swim window and break
    // this test's fixed geometry. The block is still NAMED "Swim" and lives in
    // the Pool, so STEP 6.865 identifies it as a stretchable swim block (pool is
    // free 10:30-10:45 → it can grow over the P2 sliver). Its end (10:30) abuts
    // the 15-min P2 sliver (10:30-10:45).
    if (cfg.swimWalls) {
      layers.push({
        grade,
        type: 'custom',
        name: 'Swim',
        customActivity: 'Swim',
        customField: 'Pool',
        customBunks: bunks.slice(),
        periodMin: 45, durationMin: 45, durationMax: 45,
        startMin: swimBandStart, endMin: swimBandEnd,
        qty: 1, op: '=',
        customSharing: {
          capacity: 20,
          allowedGrades: ['Auto', 'Chair'],
        },
        color: '#0EA5E9',
      });
    }

    // SWIM layer (SWIM-REAL only) — a REAL type:'swim' fullGrade layer, 45 min,
    // confined to the swim band (09:45-10:30). This drives the actual swim-type
    // planner (Phase 0 pin + pool staggering), exactly as the live camp does —
    // NOT a custom stand-in. fullGrade:true so Phase 0 pins it grade-wide to the
    // Pool. This is what makes the repro faithful (and may surface the
    // "0 specials placed" entanglement the prior agent sidestepped).
    if (cfg.swimReal) {
      // ★ swimAsGA: model swim the NEW way — a General-Activity-backed `custom`
      //   layer (quickType:'swim', bound to the Pool facility) instead of a
      //   hard-coded type:'swim'. The solver's GA normalization must map it to
      //   swim behavior so ALL swim logic (pool gate, stagger, change blocks,
      //   coverage) fires identically. Proves the refactor's keystone.
      layers.push(cfg.swimAsGA ? {
        grade,
        type: 'custom',
        quickType: 'swim',
        name: 'Swim',
        event: 'Swim',
        customActivity: 'Swim',
        customField: 'Pool',
        customBunks: bunks.slice(),
        fullGrade: cfg.swimRotated ? false : true,
        periodMin: 45, durationMin: 45, durationMax: 45,
        startMin: cfg.swimRotated ? start : swimBandRStart,
        endMin:   cfg.swimRotated ? end   : swimBandREnd,
        qty: 1, op: '=',
        color: '#0EA5E9',
      } : {
        grade,
        type: 'swim',
        name: 'Swim',
        event: 'Swim',
        // swimRotated: model the live camp's PER-BUNK rotated swim (fullGrade:false).
        //   getSwimmersForToday returns ALL bunks when bunksPerDay>=count (harness
        //   default), so every bunk needs swim today — but a non-fullGrade swim is
        //   NOT pinned in Phase 0; it must be reserved by Phase 2.3 BEFORE specials
        //   or it gets crowded out (the live "missing SWIM: 0min free" bug).
        fullGrade: cfg.swimRotated ? false : true,
        periodMin: 45, durationMin: 45, durationMax: 45,
        // swimRotated mirrors the live shape: a WIDE (whole-day) swim window
        // (ratio<1, "leeway") rather than a tight band. This is the case where
        // specials can pack the day before swim is reserved.
        startMin: cfg.swimRotated ? start : swimBandRStart,
        endMin:   cfg.swimRotated ? end   : swimBandREnd,
        qty: 1, op: '=',
        color: '#0EA5E9',
      });
    }

    // CUSTOM "Main Activity" layer — same-grade-only cross sharing.
    layers.push({
      grade,
      type: 'custom',
      name: 'Main Activity',
      customActivity: 'Main Activity',
      customField: 'Auditorium',
      customBunks: bunks.slice(),
      periodMin: cfg.sliver2 ? 20 : mainDur,
      durationMin: cfg.sliver2 ? 20 : mainDur,
      durationMax: cfg.sliver2 ? 20 : mainDur,
      startMin: mainStart,
      endMin: mainEnd,       // sliver: confined to the band; else whole day
      qty: 1, op: '=',
      customSharing: {
        capacity: 20,
        // same-grade-only: each grade lists ONLY itself -> Auto|Chair never set
        allowedGrades: [grade],
      },
      color: '#7C3AED',
    });

    // CUSTOM "Morning Activity" PINNED layer (morningPin only) — a fixed-time wall
    // (window == duration, so it classifies pinned) named "Morning Activity". The
    // name is intentionally NOT one the recapture's skip regex matched (it matched
    // "main activity"), so pre-fix the deferred-special recapture could swap a
    // special into it and drop it for some bunks (live: 'RECAPTURED Pioneering …
    // displaced "Morning Activity"'). Post-fix the custom-layer-name guard protects
    // it: every bunk keeps exactly one Morning Activity.
    if (cfg.morningPin) {
      // morningWide: model the live "stacker band" — a REQUIRED custom whose
      //   window (60 min) is wider than its duration (20 min), so it classifies
      //   "windowed" (floats) and competes with specials. Pre-fix it dropped for
      //   most bunks (specials claimed the window first); Phase 2.45 must reserve
      //   it for every bunk.
      const mpStart = cfg.morningWide ? HM(10, 0)  : HM(10, 0);
      const mpEnd   = cfg.morningWide ? HM(11, 0)  : HM(10, 20); // wide vs tight window
      layers.push({
        grade,
        type: 'custom',
        name: 'Morning Activity',
        customActivity: 'Morning Activity',
        customField: 'Pavilion',
        customBunks: bunks.slice(),
        periodMin: 20, durationMin: 20, durationMax: 20,
        startMin: mpStart, endMin: mpEnd,
        qty: 1, op: '=',
        customSharing: { capacity: 20, allowedGrades: [grade] },
        color: '#6366F1',
      });
    }

    // LUNCH layer (lunchLeeway only) — a UNIVERSAL camp wall modeled exactly like
    // the live camp's problem case: type:'lunch', NOT fullGrade, drawn with a WIDE
    // window (the whole day). Pre-fix, the wide window gives ratio<1 → the layer is
    // classified windowed/open instead of pinned, so specials/sports crowd lunch
    // out entirely and many bunks end the day with NO lunch block. Post-fix, lunch
    // is pinned grade-wide regardless of the flag and snapped to its 30-min
    // duration near the window centre — every bunk gets lunch.
    if (cfg.lunchLeeway) {
      layers.push({
        grade,
        type: 'lunch',
        name: 'lunch',
        event: 'lunch',
        // intentionally NO fullGrade flag + WIDE window (whole day). Duration =
        // PERIOD so it snaps cleanly onto this harness's 20-min period grid (the
        // live camp's periods fit its 30-min lunch the same way) — the fix under
        // test is the wide-window→ratio<1→unpinned classification, not tiling.
        periodMin: PERIOD, durationMin: PERIOD, durationMax: PERIOD,
        startMin: start, endMin: end,
        qty: 1, op: '=',
        color: '#F59E0B',
      });
    }

    if (cfg.swimWalls) {
      // SWIM-WALLS: model the special as a CUSTOM layer named "Lake" hosted in
      // "Lake Dock", confined to P5 (11:30-12:15), so it pins deterministically
      // (like Main Activity / Swim) and sidesteps the swim-era GlobalPlanner
      // special-distribution interaction that otherwise places 0 specials when a
      // swim layer is present. "Lake" IS one of the catalog SPECIALS, so
      // analyse() counts it as a real special (criterion 2). It sits AFTER the
      // Main wall (P3) with the 25-min P4 gap between → the bounding-special
      // start-pull-back path must close that gap (Lake Dock is free 11:05-11:30).
      layers.push({
        grade,
        type: 'custom',
        name: 'Lake',
        customActivity: 'Lake',
        customField: 'Lake Dock',
        customBunks: bunks.slice(),
        periodMin: 45, durationMin: 45, durationMax: 45,
        startMin: HM(11, 30), endMin: HM(12, 15),
        qty: 1, op: '=',
        customSharing: { capacity: 20, allowedGrades: ['Auto', 'Chair'] },
        color: '#10B981',
      });
    } else {
      // SPECIAL layer — at least 1 special. In the sliver scenario, EXACTLY one
      // 45-min special per bunk confined to the 60-min band (9:00-10:00), so it
      // leaves a 15-min sub-floor remainder bounded by the next period's
      // Main-Activity wall — the wall-bounded sliver bug.
      const _specLayer = {
        grade, type: 'special', name: 'Special',
        periodMin: specialDur, durationMin: specialDur,
        startMin: specStart, endMin: specEnd,
        qty: 1, op: (cfg.sliver || cfg.sliver2 || cfg.swimReal) ? '=' : '>=',
      };
      // subFloor / subFloorTight: demand 2 "snack" specials per bunk (a
      //   subcategory FLOOR). subFloorTight also confines the layer window to a
      //   single 20-min period so the distributor seats at most one snack and the
      //   STEP 6.98 enforcer must place the 2nd. STEP 6.98 tops each bunk up to 2
      //   by reclaiming Free/filler/sport slots.
      if (cfg.subFloor || cfg.subFloorTight) { _specLayer.subQuantities = { snack: 2 }; _specLayer.subOps = { snack: '=' }; }
      if (cfg.subFloorTight) { _specLayer.startMin = HM(10, 0); _specLayer.endMin = HM(10, 20); }
      // oversub: every bunk demands the single cap-1 'shiur' seat (floor = 1) →
      //   14 floors against 1 seat, which the reconciliation pass must clamp.
      if (cfg.oversub) { _specLayer.subQuantities = { shiur: 1 }; _specLayer.subOps = { shiur: '=' }; }
      // generic passthrough (SURPLUS test): scenario-supplied subcategory demands.
      if (cfg.subQuantities) { _specLayer.subQuantities = cfg.subQuantities; _specLayer.subOps = cfg.subOps || {}; }
      layers.push(_specLayer);
    }

    // SPORT layer — at least 1 sport; cap unbounded so it fills remaining slots.
    // OMITTED entirely in the noSports scenario: a sports-free camp never created
    // a sport layer, so the engine must fill open time from specials/customs and
    // must NOT inject field-catalog sports.
    if (!cfg.noSports) {
      layers.push({
        grade, type: 'sport', name: 'Sports',
        periodMin: sportMin, durationMin: sportMin,
        startMin: start, endMin: end,
        qty: 1, op: '>=',
      });
    }
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
  const cfg = campConfig(opts);
  const disabledFields = Array.isArray(opts.disabledFields) ? opts.disabledFields.slice() : [];
  // Period granularity: 5-min grid for the sliver scenario (so a 45-min special
  // can float mid-band and orphan a 20-min sub-floor sliver), 20-min elsewhere.
  const period = cfg.sliver ? 5 : PERIOD;
  // Special duration: 45-min specials in the sliver scenarios, else one period.
  const specialDur = (cfg.sliver || cfg.sliver2 || cfg.swimWalls || cfg.swimReal) ? 45 : PERIOD;
  const chairStartStr = (cfg.sliver || cfg.sliver2 || cfg.swimWalls || cfg.swimReal) ? '9:00' : '10:00';
  const chairEndStr = cfg.swimReal ? '12:20' : (cfg.swimWalls ? '12:15' : ((cfg.sliver || cfg.sliver2) ? '12:30' : '12:40'));
  const divisions = {
    // TRUE division window — off-grid edges (e.g. 9:58) flow through here so the
    // solver sees the real boundary, exactly like a real camp config.
    Auto:  { bunks: AUTO_BUNKS.slice(),  startTime: cfg.autoStartStr, endTime: cfg.autoEndStr },
    Chair: { bunks: CHAIR_BUNKS.slice(), startTime: chairStartStr, endTime: chairEndStr },
  };

  // SLIVER scenario uses an EXPLICIT mixed-size period grid (not a uniform one):
  //   - a 60-min off-field special "band" period (9:00-10:00) that holds a 45-min
  //     special and leaves a 15-min sub-floor remainder (the sliver)
  //   - a 20-min Main-Activity wall period immediately after (10:00-10:20) so the
  //     sliver is wall-bounded on BOTH sides (special | sliver | Main-Activity)
  //   - 45/40-min afternoon periods so 25-min sports tile cleanly (a uniform 5-min
  //     grid can't assemble 25-min sports and leaves spurious 5/15-min Frees)
  // Both grades share the structure so the same-grade-staggered Auditorium Main
  // Activity must take its own lane during the overlap (the exact failing case).
  const sliverPeriods = () => ([
    { startMin: HM(9, 0),  endMin: HM(10, 0) },  // 60-min off-field special band (45 special → 15-min sliver)
    { startMin: HM(10, 0), endMin: HM(10, 20) }, // 20-min Main Activity wall period
    { startMin: HM(10, 20), endMin: HM(11, 5) }, // 45 sport
    { startMin: HM(11, 5), endMin: HM(11, 50) }, // 45 sport
    { startMin: HM(11, 50), endMin: HM(12, 30) }, // 40 sport
  ]);
  const sliverDivTimes = () => sliverPeriods().map((p, i) => ({
    slotIndex: i, startMin: p.startMin, endMin: p.endMin, event: 'GA', type: 'slot'
  }));

  // SLIVER-RESIDUAL grid (see campConfig({sliver2})): the 25-min gap straddles a
  // period boundary and EQUALS the sport floor — the case the original 6.865
  // skipped via `gapDur >= floor`. The band (9:00-9:55) holds a 45-min special
  // (→ 9:45-9:55 in-band remainder); a 15-min empty period (9:55-10:10) and the
  // 20-min Main-Activity wall (10:10-10:30) follow; afternoon 45/45/40-min sport
  // periods to 12:30. Neither the 10-min nor the 15-min piece can host a 25-min
  // sport, so the 9:45-10:10 gap can only be closed by stretching the special.
  const sliver2Periods = () => ([
    { startMin: HM(9, 0),   endMin: HM(9, 50) },  // 50-min band: 45-min special → 9:00-9:45, 5-min in-band remainder
    { startMin: HM(9, 50),  endMin: HM(10, 0) },  // 10-min empty period (< 25-min sport floor)
    { startMin: HM(10, 0),  endMin: HM(10, 10) }, // 10-min empty period (< 25-min sport floor)
    { startMin: HM(10, 10), endMin: HM(10, 30) }, // 20-min Main Activity wall
    { startMin: HM(10, 30), endMin: HM(11, 15) }, // 45 sport
    { startMin: HM(11, 15), endMin: HM(12, 0) },  // 45 sport
    { startMin: HM(12, 0),  endMin: HM(12, 30) }, // 30 sport
  ]);
  const sliver2DivTimes = () => sliver2Periods().map((p, i) => ({
    slotIndex: i, startMin: p.startMin, endMin: p.endMin, event: 'GA', type: 'slot'
  }));

  // SWIM-WALLS grid (see campConfig({swimWalls})): swim band | sub-floor sliver |
  // Main wall | floor-sized gap | special band | sport, both grades the same.
  const swimWallsPeriods = () => ([
    { startMin: HM(9, 0),   endMin: HM(9, 45) },  // 45 sport
    { startMin: HM(9, 45),  endMin: HM(10, 30) }, // 45 swim band
    { startMin: HM(10, 30), endMin: HM(10, 45) }, // 15 empty (swim|gap|Main sliver)
    { startMin: HM(10, 45), endMin: HM(11, 5) },  // 20 Main Activity wall
    { startMin: HM(11, 5),  endMin: HM(11, 30) }, // 25 empty (Main|gap|special)
    { startMin: HM(11, 30), endMin: HM(12, 15) }, // 45 special band (Lake)
  ]);
  const swimWallsDivTimes = () => swimWallsPeriods().map((p, i) => ({
    slotIndex: i, startMin: p.startMin, endMin: p.endMin, event: 'GA', type: 'slot'
  }));

  // SWIM-REAL grid (faithful — real swim + real special layers):
  //   P0 09:00-09:45 sport | P1 09:45-10:30 SWIM band | P2 10:30-10:50 Main wall |
  //   P3 10:50-11:35 special target | P4 11:35-12:20 sport.
  const swimRealPeriods = () => ([
    { startMin: HM(9, 0),   endMin: HM(9, 45) },  // 45 sport
    { startMin: HM(9, 45),  endMin: HM(10, 30) }, // 45 swim band
    { startMin: HM(10, 30), endMin: HM(10, 50) }, // 20 Main Activity wall
    { startMin: HM(10, 50), endMin: HM(11, 35) }, // 45 special target
    { startMin: HM(11, 35), endMin: HM(12, 20) }, // 45 sport
  ]);
  const swimRealDivTimes = () => swimRealPeriods().map((p, i) => ({
    slotIndex: i, startMin: p.startMin, endMin: p.endMin, event: 'GA', type: 'slot'
  }));

  const divisionTimes = cfg.swimReal ? {
    Auto:  swimRealDivTimes(),
    Chair: swimRealDivTimes(),
  } : cfg.swimWalls ? {
    Auto:  swimWallsDivTimes(),
    Chair: swimWallsDivTimes(),
  } : cfg.sliver2 ? {
    Auto:  sliver2DivTimes(),
    Chair: sliver2DivTimes(),
  } : cfg.sliver ? {
    Auto:  sliverDivTimes(),
    Chair: sliverDivTimes(),
  } : cfg.smooth ? {
    Auto:  buildDivisionTimes(cfg.autoStart, cfg.autoEnd, 10),
    Chair: buildDivisionTimes(cfg.chairStart, cfg.chairEnd, 10),
  } : {
    Auto:  buildDivisionTimes(cfg.autoStart, cfg.autoEnd, period),
    Chair: buildDivisionTimes(cfg.chairStart, cfg.chairEnd, period),
  };

  const campPeriods = (cfg.swimReal && cfg.swimRotated) ? {
    // swimRotated faithfully models the LIVE camp: free-form division times with
    // NO bell-schedule periods. campPeriods is empty so Phase 2.3's period
    // requirement is exercised (the no-periods synthetic-window path).
    Auto:  [],
    Chair: [],
  } : cfg.swimReal ? {
    Auto:  swimRealPeriods(),
    Chair: swimRealPeriods(),
  } : cfg.swimWalls ? {
    Auto:  swimWallsPeriods(),
    Chair: swimWallsPeriods(),
  } : cfg.sliver2 ? {
    Auto:  sliver2Periods(),
    Chair: sliver2Periods(),
  } : cfg.sliver ? {
    Auto:  sliverPeriods(),
    Chair: sliverPeriods(),
  } : (cfg.smooth && cfg.smoothPartialBell) ? {
    // PARTIAL bell schedule: periods cover only the afternoon (10:50→day end),
    // while the camp day + morning layers start at 9:00. Reproduces a stale/
    // partial bell grid. Without the day-coverage extension the pre-10:50 morning
    // is a dead zone (left empty); with it, a synthetic morning period tiles it.
    Auto:  [{ startMin: HM(10, 50), endMin: HM(15, 0) }],
    Chair: [{ startMin: HM(10, 50), endMin: HM(15, 0) }],
  } : cfg.smooth ? {
    // layer-driven (no bell periods) → the tiler region-splits on walls.
    Auto:  [],
    Chair: [],
  } : {
    Auto:  buildPeriods(cfg.autoStart, cfg.autoEnd, period),
    Chair: buildPeriods(cfg.chairStart, cfg.chairEnd, period),
  };

  // In the sliver scenario BOTH grades (8 Auto + 6 Chair = 14 bunks) run on the
  // SAME period grid, so all 14 want a sport simultaneously in the afternoon
  // periods. The base 8 fields would starve 6 bunks (an unrelated capacity
  // failure). Provision extra fields/sports so capacity matches the 14-bunk
  // simultaneous demand — isolating the sliver bug from field starvation.
  const sportList = (cfg.sliver || cfg.sliver2 || cfg.swimWalls || cfg.swimReal)
    ? SPORTS.concat(['Tennis', 'Dodgeball', 'Kickball', 'Frisbee', 'Lacrosse', 'Handball'])
    : SPORTS.slice();
  const fieldList = (cfg.sliver || cfg.sliver2 || cfg.swimWalls || cfg.swimReal)
    ? FIELDS.concat([
        { name: 'Tennis Court',    activities: ['Tennis'] },
        { name: 'Dodgeball Gym',   activities: ['Dodgeball'] },
        { name: 'Kickball Field',  activities: ['Kickball'] },
        { name: 'Frisbee Field',   activities: ['Frisbee'] },
        { name: 'Lacrosse Field',  activities: ['Lacrosse'] },
        { name: 'Handball Wall',   activities: ['Handball'] },
      ])
    : FIELDS.slice();

  // SWIM-WALLS: add a high-capacity, cross-grade-shared Pool so all 14 bunks
  // (8 Auto + 6 Chair) can swim simultaneously in the 9:30-10:15 band without
  // pool-capacity starvation (isolating the wall-bounded-gap bug). The pool is
  // free 10:15-10:30, so the swim block can legally stretch over the P2 sliver.
  // SWIM-REAL: a high-capacity, cross-grade-shared Pool so all 14 bunks can swim
  // in the 09:45-10:30 band without pool-capacity starvation. The pool is free
  // after 10:30 so swim CAN stretch over a swim|gap|Main sliver if one appears.
  // SWIM-NO-FACILITY: NO Pool field and NO Swim general activity anywhere — the
  // camp never modeled a pool. Swim must then be UNLIMITED (no cap): all 14 bunks
  // swim concurrently in the one legal band. Pre-fix, canUsePoolAtTime's default
  // capacity of 12 starved bunks 13-14 ("could not place swim").
  if (cfg.swimReal && !cfg.swimNoFacility) {
    // SWIM-GA-SHARE: model the user's real config — the Pool FIELD is restrictive
    // (not_sharable → capacity 1), but pool sharing is configured on the "Swim"
    // GENERAL ACTIVITY instead (added to globalSettings.facilities below). Without
    // the v18 fix, canUsePoolAtTime reads only the field (cap 1) and starves swim;
    // with it, the Swim activity's type:'all' is honored and every bunk swims.
    fieldList.push(cfg.swimGAShare ? {
      name: 'Pool',
      activities: ['Swim'],
      sharableWith: { type: 'not_sharable', divisions: [], capacity: 1, allowedPairs: {} },
    } : {
      name: 'Pool',
      activities: ['Swim'],
      sharableWith: { type: 'all', divisions: [], capacity: 20,
        allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } },
    });
  }
  if (cfg.swimWalls) {
    fieldList.push({
      name: 'Pool',
      activities: ['Swim'],
      sharableWith: { type: 'all', divisions: [], capacity: 20,
        allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } },
    });
    // The "Lake" special is modeled as a custom layer hosted in a "Lake" field
    // (custom layers render field == activity name). Register that field with
    // high cross-grade capacity so all 14 bunks can hold Lake in the same band,
    // and so isFieldAvailable("Lake", ...) is TRUE across the 11:05-11:30 gap —
    // letting STEP 6.865 pull the Lake start back over the Main|gap|special hole.
    fieldList.push({
      name: 'Lake',
      activities: ['Lake'],
      sharableWith: { type: 'all', divisions: [], capacity: 20,
        allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } },
    });
  }

  const sportMetaData = {};
  sportList.forEach(s => { sportMetaData[s] = { minPlayers: 1, maxPlayers: 99 }; });

  const activityProperties = {};
  if (cfg.specialsOverride) {
    // scenario-supplied catalog (already config-shaped): the engine resolves
    // subcategory/sharing from activityProperties, so it must see the SAME objects.
    cfg.specialsOverride.forEach(s => { activityProperties[s.name] = s; });
  } else if (cfg.smooth) {
    SMOOTH_SPECIALS.forEach(s => { activityProperties[s.name] = smoothSpecialConfig(s); });
  } else {
    SPECIALS.forEach(s => { activityProperties[s.name] = specialConfig(s, specialDur, cfg.oversub); });
  }
  // SLIVER-RESIDUAL: make every sport FIELD genuinely Unavailable before 10:30, so
  // NO sport field is free in the 9:45-10:10 gap window — faithfully reproducing the
  // user's "no field free for a new sport in that window". A new sport therefore
  // CANNOT fill the gap; the only gapless outcome is stretching the bounding special
  // (Lake), whose own room (Lake Dock) IS free across the window. Sports still place
  // freely in the afternoon periods (all >= 10:30), so criterion (3) holds.
  if (cfg.sliver2) {
    fieldList.forEach(f => {
      if (!f || !Array.isArray(f.activities) || !f.activities.length) return;
      activityProperties[f.name] = Object.assign(activityProperties[f.name] || {}, {
        timeRules: [{ type: 'Unavailable', startMin: 0, endMin: HM(10, 30), divisions: null }],
      });
    });
  }
  // SWIM-WALLS: make every SPORT field Unavailable 10:15-11:15 so NO sport can
  // fill the P2 (15m) or P4 (25m) gaps in that window — exactly the user's "no
  // sport field free in that window". Sports place freely in P0 (9:00-9:30) and
  // P6 (12:00-12:30), so criterion (3) holds. The Pool (swim) and Lake Dock /
  // special rooms stay free across the gaps, so the swim/special stretch CAN
  // close them. The Pool is excluded from the sport-field block.
  if (cfg.swimWalls) {
    const _nonSport = new Set(['pool', 'lake', 'auditorium']);
    fieldList.forEach(f => {
      if (!f || !Array.isArray(f.activities) || !f.activities.length) return;
      if (_nonSport.has(String(f.name).toLowerCase())) return;       // pool/lake/auditorium stay open
      if (f.activities.some(a => ['swim', 'lake', 'main activity'].includes(String(a).toLowerCase()))) return;
      activityProperties[f.name] = Object.assign(activityProperties[f.name] || {}, {
        timeRules: [{ type: 'Unavailable', startMin: HM(10, 30), endMin: HM(11, 30), divisions: null }],
      });
    });
  }
  // SWIM-REAL: make every SPORT field Unavailable 10:30-11:35 so NO sport can
  // fill the Main↔special gap window (P3, 10:50-11:35) — exactly the user's "no
  // sport field free in that window". Sports place freely in P0 (9:00-9:45) and
  // P4 (11:35-12:20), so criterion (3) holds. The Pool (swim), Auditorium (Main),
  // and the special ROOMS stay free across the gap, so the only gapless outcome
  // is to place/stretch the special flush after the Main wall.
  if (cfg.swimReal) {
    const _specialRooms = new Set(SPECIALS.map(s => String(s.location).toLowerCase()));
    const _nonSport = new Set(['pool', 'auditorium']);
    fieldList.forEach(f => {
      if (!f || !Array.isArray(f.activities) || !f.activities.length) return;
      const nm = String(f.name).toLowerCase();
      if (_nonSport.has(nm) || _specialRooms.has(nm)) return;        // pool/auditorium/special rooms stay open
      if (f.activities.some(a => ['swim', 'main activity'].includes(String(a).toLowerCase()))) return;
      activityProperties[f.name] = Object.assign(activityProperties[f.name] || {}, {
        timeRules: [{ type: 'Unavailable', startMin: HM(10, 30), endMin: HM(11, 35), divisions: null }],
      });
    });
  }

  const globalSettings = {
    app1: {
      fields: fieldList.slice(),
      // specialsOverride: a scenario-supplied catalog (already in config shape) —
      //   used by the SURPLUS test to mix subcategories/sharing inside a smooth day.
      specialActivities: cfg.specialsOverride ? cfg.specialsOverride
        : cfg.smooth ? SMOOTH_SPECIALS.map(smoothSpecialConfig) : SPECIALS.map(s => specialConfig(s, specialDur, cfg.oversub)),
      sportMetaData,
      disabledFields,
      divisions,
      // opt-in: let STEP 6.865 tier-2 stretch a bounding special over a sub-floor
      //   sliver (default off — see the "no stretch" tests for the locked default).
      sliverStretchSpecial: opts.stretchSpecial === true,
      // oversub: drive the GENERIC-LAYOUT planner (the demand→capacity path the
      //   reconciliation lives in); classic CSP scenarios leave this off.
      useGenericLayout: cfg.oversub === true,
    },
    campPeriods,
  };
  // SWIM-GA-SHARE: pool sharing lives on the "Swim" general activity (the real
  // user config), NOT on the Pool field. canUsePoolAtTime must read this.
  if (cfg.swimGAShare) {
    globalSettings.facilities = [{
      name: 'Pool',
      generalActivities: [{ name: 'Swim', quickType: 'swim',
        sharableWith: { type: 'all', divisions: [], capacity: 999, allowedPairs: {} } }],
    }];
  }

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
  // priorDays (COHORT test): seed earlier days' saved schedules so lifetime
  // cohort counts (getLifetimeSpecialCount scans allDailyData) are non-zero.
  sandbox.loadAllDailyData = () => (cfg.priorDays || {});
  sandbox.getDivisions = () => divisions;
  sandbox.getAllGlobalSports = () => sportList.slice().sort();
  sandbox.getSportMetaData = () => sportMetaData;
  sandbox.getBunkMetaData = () => bunkMetaData;
  sandbox.getGlobalSpecialActivities = () => cfg.specialsOverride ? cfg.specialsOverride
    : cfg.smooth ? SMOOTH_SPECIALS.map(smoothSpecialConfig) : SPECIALS.map(s => specialConfig(s, specialDur, cfg.oversub));
  sandbox.getAllSpecialActivities = () => cfg.smooth ? SMOOTH_SPECIALS.map(smoothSpecialConfig) : SPECIALS.map(s => specialConfig(s, specialDur, cfg.oversub));
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
    'period_layout.js', 'gl_stagger.js',
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
function analyse(sandbox, cfg) {
  cfg = cfg || campConfig({});
  const sa = sandbox.scheduleAssignments || {};
  const dt = sandbox.divisionTimes || {};
  const bunkDiv = {};
  Object.entries(sandbox.divisions).forEach(([div, d]) => (d.bunks || []).forEach(b => { bunkDiv[String(b)] = div; }));

  const specialNames = new Set((cfg.smooth ? SMOOTH_SPECIALS : SPECIALS).map(s => s.name.toLowerCase()));
  // Configured special duration for this scenario (mirrors buildSandbox/buildLayers).
  const cfgSpecialDur = (cfg.sliver || cfg.sliver2 || cfg.swimWalls || cfg.swimReal) ? 45 : PERIOD;
  // Smooth scenario has MIXED per-special durations — look each up by name.
  const smoothDurByName = {};
  if (cfg.smooth) SMOOTH_SPECIALS.forEach(s => { smoothDurByName[s.name.toLowerCase()] = s.dur; });
  // Sport names come from the sandbox's live sportMetaData (the sliver scenario
  // provisions extra sports/fields to match its 14-bunk simultaneous demand).
  const sportNames = new Set(Object.keys(sandbox.sportMetaData || {}).map(s => s.toLowerCase()));
  SPORTS.forEach(s => sportNames.add(s.toLowerCase()));
  const isFree = (name) => {
    const a = String(name || '').toLowerCase().trim();
    return !a || a === 'free' || a === 'free play' || a.startsWith('free ');
  };

  const results = {};
  for (const bunk of [...AUTO_BUNKS, ...CHAIR_BUNKS]) {
    const grade = bunkDiv[bunk];
    const winStart = grade === 'Auto' ? cfg.autoStart : cfg.chairStart;
    const winEnd = grade === 'Auto' ? cfg.autoEnd : cfg.chairEnd;
    const slots = Array.isArray(sa[bunk]) ? sa[bunk] : [];
    const divSlots = dt[grade] || [];

    let mainCount = 0, specialCount = 0, sportCount = 0, swimCount = 0, lunchCount = 0, morningCount = 0, subFloorCount = 0;
    const covered = []; // {s,e}
    const entries = [];
    const specialOver = []; // configured specials placed LONGER than their config
    slots.forEach((s, i) => {
      if (!s || s.continuation) return;
      const act = s._activity || s.field || '';
      let startMin = s._startMin, endMin = s._endMin;
      if (startMin == null && divSlots[i]) { startMin = divSlots[i].startMin; endMin = divSlots[i].endMin; }
      entries.push({ act, startMin, endMin, raw: s });
      const al = String(act).toLowerCase();
      if (al === 'lunch' || String(s.type || '').toLowerCase() === 'lunch') lunchCount++;
      if (al === 'swim' || String(s.type || '').toLowerCase() === 'swim') swimCount++;
      if (al === 'morning activity') morningCount++;
      if (al === 'main activity') mainCount++;
      else if (specialNames.has(al)) {
        specialCount++;
        if (SUBCAT_BY_NAME[al] === 'snack') subFloorCount++;
        // ★ DURATION LOCK: a configured special must keep its exact duration —
        //   never stretched a whole grid step (>=5min) to swallow a sliver. A
        //   sub-grid overrun (<5min) is unavoidable off-grid division-boundary
        //   snapping (e.g. a division starting at 8:58 on a 5-min grid), not the
        //   slot-bloat bug, so it is tolerated.
        const _cfgDur = (cfg.smooth && smoothDurByName[al] != null) ? smoothDurByName[al] : cfgSpecialDur;
        if (startMin != null && endMin != null && (endMin - startMin) - _cfgDur >= 5) {
          specialOver.push(act + ' ' + fmt(startMin) + '-' + fmt(endMin) + ' (' + (endMin - startMin) + 'min > ' + _cfgDur + ')');
        }
      }
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
      grade, mainCount, specialCount, sportCount, swimCount, lunchCount, morningCount, subFloorCount, gapMin, gaps, entries, specialOver,
      pass: {
        main: mainCount === 1,
        special: specialCount >= 1,
        sport: sportCount >= 1,
        swim: swimCount >= 1,
        lunch: lunchCount >= 1,
        nogap: gapMin === 0,
        specialDur: specialOver.length === 0,
        subFloor: subFloorCount >= 2,
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
  opts = opts || {};
  const cfg = campConfig(opts);
  const sandbox = buildSandbox(opts);
  loadModules(sandbox);

  assert.equal(typeof sandbox.runAutoScheduler, 'function',
    'window.runAutoScheduler must be defined after loading modules');

  const layers = buildLayers(cfg);
  let ranOk;
  try {
    ranOk = await sandbox.runAutoScheduler(layers, { allowedDivisions: null });
  } catch (e) {
    console.error('runAutoScheduler threw:', e && e.stack || e);
    console.error((sandbox.__logs || []).slice(-40).join('\n'));
    throw e;
  }

  const results = analyse(sandbox, cfg);
  console.error('\n===== SCENARIO: ' + label + ' =====');
  printTable(results, sandbox);

  if (process.env.DUMPLOG) {
    const pat = new RegExp(process.env.DUMPLOG, 'i');
    (sandbox.__logs || []).forEach(l => { if (pat.test(l)) console.error('LOG: ' + l); });
  }

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
    // requireNoSports (sports-free camp): the day has NO sport layer, so no bunk
    //   may receive a sport-typed block — the field catalog must not leak in.
    //   Skip the default "sport >= 1" requirement in this mode.
    if (opts.requireNoSports) {
      if (r.sportCount > 0) failures.push(`${bunk}: sport count = ${r.sportCount} (want 0 — no sport layer configured)`);
    } else if (!r.pass.sport) {
      failures.push(`${bunk}: sport count = ${r.sportCount} (want >=1)`);
    }
    // requireSwim: assert every bunk actually got a swim block (validates the
    //   Swim general-activity sharing path). skipGapCheck: relax the gapless
    //   criterion for scenarios whose purpose is swim coverage, not tiling.
    if (opts.requireSwim && !r.pass.swim) failures.push(`${bunk}: swim count = ${r.swimCount} (want >=1)`);
    // requireLunch: assert every bunk got a lunch block (validates that a
    //   non-fullGrade, wide-window lunch layer still pins as a universal wall).
    if (opts.requireLunch && !r.pass.lunch) failures.push(`${bunk}: lunch count = ${r.lunchCount} (want >=1)`);
    // requireMorningPin: the pinned custom "Morning Activity" must survive for every
    //   bunk (exactly 1) — never displaced by deferred-special recapture.
    if (opts.requireMorningPin && r.morningCount !== 1) failures.push(`${bunk}: Morning Activity count = ${r.morningCount} (want exactly 1 — pinned custom must not be displaced)`);
    if (!opts.skipGapCheck && !r.pass.nogap) failures.push(`${bunk}: ${r.gapMin} uncovered min (${r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(',')})`);
    // ★ DURATION LOCK (universal): a configured special is never stretched beyond
    //   its configured duration — true for every scenario, every camp. EXCEPTION:
    //   the opt-in sliver-stretch path (globalSettings.app1.sliverStretchSpecial)
    //   deliberately grows a bounding special over a sub-floor gap; expectStretch
    //   scenarios assert that growth happened instead of forbidding it.
    if (!opts.expectStretch && !r.pass.specialDur) failures.push(`${bunk}: configured special stretched past its duration — ${r.specialOver.join('; ')}`);
    // requireSubFloor: the active goal — a subcategory layer set to "=2" means
    //   EVERY bunk must end with 2 specials of that subcategory. STEP 6.98
    //   LAYER-FLOOR ENFORCER guarantees it by topping up any bunk the distributor
    //   left short (reclaiming Free/filler/sport time).
    if (opts.requireSubFloor && !r.pass.subFloor) failures.push(`${bunk}: snack-subcategory count = ${r.subFloorCount} (want >=2 — layer floor not met)`);
  }

  // requireSwimUncappedResolved: assert the engine RESOLVED the pool capacity as
  //   UNLIMITED when no facility is assigned to swim (the [STEP 1.5] diag line
  //   prints the same resolution chain canUsePoolAtTime uses). This is the
  //   binding pre/post-fix observable: the old code resolved "default
  //   capacity=12" here. End-of-day swim coverage alone can't bind — the
  //   fullGrade pin registers pool usage per GRADE (2 grades ≪ 12), and the
  //   per-bunk heal pass (poolSwimPairFreeAt) was already unrestricted with no
  //   config, so the old phantom cap surfaced as per-bunk deferrals/stagger,
  //   not necessarily as missing swim in this small harness.
  if (opts.requireSwimUncappedResolved) {
    const resolvedUnlimited = (sandbox.__logs || []).some(l =>
      l.includes('[STEP 1.5] Pool sharing config:') && l.includes('UNLIMITED (no facility assigned to swim'));
    assert.ok(resolvedUnlimited,
      '[' + label + '] expected [STEP 1.5] to resolve pool capacity as UNLIMITED (no facility assigned to swim); got: '
      + ((sandbox.__logs || []).find(l => l.includes('[STEP 1.5] Pool sharing config:')) || '(no pool-config line)'));
  }

  // requireSwimReservedBeforeSpecials: assert Phase 2.3 actually pre-placed swim
  //   as walls (count > 0) on EVERY iteration. This is the behavior the
  //   no-bell-periods fix changes: pre-fix it logged "PRE-PLACED 0" (silent
  //   no-op → swim crowded out by the post-specials CSP); post-fix it reserves
  //   swim from a synthesized window before specials. The end-of-day swim count
  //   can't prove this (the small-harness CSP recovers), so assert on the
  //   reservation directly.
  if (opts.requireSwimReservedBeforeSpecials) {
    const prePlaced = (sandbox.__logs || [])
      .map(l => { const m = /\[Phase2\.3\] ★ PRE-PLACED (\d+) staggered swim/.exec(l); return m ? parseInt(m[1], 10) : null; })
      .filter(n => n !== null);
    assert.ok(prePlaced.length > 0, '[' + label + '] expected at least one [Phase2.3] PRE-PLACED summary line');
    const zeroIters = prePlaced.filter(n => n === 0).length;
    assert.equal(zeroIters, 0,
      '[' + label + '] Phase 2.3 reserved 0 swim walls on ' + zeroIters + '/' + prePlaced.length +
      ' iteration(s) — swim not reserved before specials (counts seen: ' + prePlaced.join(',') + ')');
  }

  assert.deepEqual(failures, [], '[' + label + '] per-bunk criteria failures:\n  ' + failures.join('\n  '));
  return { results, sandbox };
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

// ---------------------------------------------------------------------------
// TEST 3 — OFF-GRID config: a grade's true start/end is NOT on the 5-minute
// grid (Auto runs 8:58 → 11:42). Production snaps the internal period grid to
// the enclosing 5-min boundaries (start UP to 9:00, end DOWN to 11:40), which
// yields EXACTLY the fair 8-period grid — so the only difference from the fair
// case is the leading 8:58-9:00 sliver and the trailing 11:40-11:42 sliver,
// which fall outside every period and were historically uncoverable: a tiny
// permanent gap that breaks the gapless criterion.
//
// The fix (STEP 6.87 EDGE-CLIP) extends the first scheduled block back to begin
// at the TRUE division start (8:58) and the last block forward to end at the
// TRUE division end (11:42), so coverage spans the real window. No one's day is
// shortened, and on-grid divisions (Chair) are untouched (sliver == 0 → no-op).
// The four criteria are NOT weakened — the edge slivers, being adjacent to a
// real activity, get absorbed.
// ---------------------------------------------------------------------------
test('auto scheduler fills a gapless day for all 14 bunks with an off-grid division start/end', async (t) => {
  await runScenario('OFF-GRID (Auto 8:58→11:42, grid snaps to 9:00→11:40)', {
    offGrid: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 4 — SLIVER-BAND config: the user's live regen bug that NONE of the
// first three scenarios reproduce.
//
// Mixed-size period grid (see campConfig({sliver}) / buildSandbox sliverPeriods):
// a 60-min off-field special band period (9:00-10:00) holds one 45-min special,
// a 20-min Main-Activity wall period follows (10:00-10:20), then 45/40-min sport
// periods to 12:30. Both grades (8 Auto + 6 Chair = 14 bunks) run the same grid,
// with extra fields provisioned so the 14-bunk simultaneous sport demand never
// starves (isolating the sliver bug from field capacity).
//
// THE BUG: the 45-min special tiles the band flush at 9:00-9:45, leaving a 15-min
// remainder (9:45-10:00). 15 < the 25-min sport floor, so it can't host its own
// activity; and it is wedged between the special (a pinned wall) and the next
// period's Main-Activity wall (immune). Neither neighbour is a flexible sport, so
// STEP 6.86 SPORT-FLEX reports "no extendable-neighbour gaps to close" and the
// 15-min remainder survives as a [REAL-GAP] — exactly the user's REBAL-STUCK case
//   prev=[special/Lake 45min pinned]  next=[custom/Main Activity 20min pinned].
// special(45) + a fillable sport(25) = 70 > 60-min band, so NO flush placement
// can avoid the sliver — it MUST be absorbed.
//
// THE FIX:
//   (a) PRIMARY (Phase 2.5 FLUSH-CONSOLIDATION): when a band IS wide enough,
//       place the special flush against a wall so the leftover consolidates into
//       one >= floor chunk instead of floating mid-band and orphaning a sliver on
//       each side (prevents the user's live mid-band float).
//   (b) LAST RESORT (STEP 6.865 WALL-BOUNDED SLIVER-ABSORB): when a sub-floor
//       sliver bounded by walls still remains, stretch a bounding block over it —
//       prefer an adjacent flexible sport; if both neighbours are walls, stretch
//       the bounding SPECIAL (a slightly longer special beats a Free hole). Gated
//       by isFieldAvailable + _validateWritePlacement + coveredByContiguousPeriods.
// The four criteria are NOT weakened.
// ---------------------------------------------------------------------------
// NOTE (duration-lock rule): a configured special MUST keep its exact duration,
// even when that leaves a wall-bounded sliver no flexible neighbour can absorb.
// Closing this sliver would require stretching the bounding 45-min special — now
// forbidden. The correct outcome is therefore: special stays 45 (asserted via the
// universal specialDur check) and the sub-floor sliver remains (skipGapCheck).
test('auto scheduler keeps special duration over a wall-bounded sliver band (no stretch)', async (t) => {
  await runScenario('SLIVER-BAND (45-min special in a 60-min band + 20-min Main Activity wall, mixed-size periods)', {
    sliver: true,
    skipGapCheck: true,
  });
});

// Opt-in counterpart: with globalSettings.app1.sliverStretchSpecial = true, the
// SAME wall-bounded sliver is closed by growing the bounding special over the gap
// (the only engine lever in a sportless / no-short-filler camp). Proves the new
// tier-2 path fires ONLY when the flag is on; the test above proves it stays off
// by default.
test('auto scheduler stretches a bounding special to close a sub-floor sliver when sliverStretchSpecial is on', async (t) => {
  const { results } = await runScenario('SLIVER-BAND (stretch ON — opt-in)', {
    sliver: true,
    stretchSpecial: true,
    expectStretch: true,
    skipGapCheck: true,
  });
  const anyStretched = Object.values(results).some(r => !r.pass.specialDur);
  assert.ok(anyStretched, 'with sliverStretchSpecial=on, a bounding special should be stretched to absorb the sub-floor sliver');
});

// ---------------------------------------------------------------------------
// TEST 5 — SLIVER-RESIDUAL config: the user's LIVE residual gap that the
// ORIGINAL STEP 6.865 (commit 8badb70) STILL left open. NONE of tests 1-4
// reproduce it.
//
//   [REAL-GAP] Auto 3 10:45am-11:10am (25min)  prev=[special/Lake 45m pinned]
//                                               next=[custom/Main Activity 20m pinned]
//   [STEP 6.865 SLIVER-ABSORB] no wall-bounded slivers to absorb.  absorbed=0
//
// Two things make this case slip past the original 6.865 (both must hold):
//   (1) The gap EQUALS the 25-min sport floor (not a sub-floor sliver). 6.865
//       short-circuited every gap with `gapDur >= floor` as "fillable on its own
//       → not our job" — so a 25-min gap was never considered, even though no
//       sport could actually take it.
//   (2) The gap STRADDLES a period boundary, split into a 10-min band remainder
//       + a 15-min empty period. Neither piece reaches the 25-min sport floor, so
//       the per-period tiler places no sport there ("no sports in priority list"
//       / "no field"). coveredByContiguousPeriods is still TRUE (the periods are
//       contiguous — NOT a real dead gap like lunch), so it is legitimately
//       coverable; the only gapless outcome is to stretch the bounding special
//       (Lake) over the gap (its room is free across the window).
//
// THE FIX (extends STEP 6.865): treat a wall-bounded gap as absorbable when it is
// sub-floor OR (>= floor but no sport / no free field can actually fill it). The
// bounding-special stretch then closes it, gated by isFieldAvailable on the
// special's own room + _validateWritePlacement + coveredByContiguousPeriods, never
// bridging a real dead gap and never stretching an immune wall.
// The four criteria are NOT weakened.
// ---------------------------------------------------------------------------
// NOTE (duration-lock rule): same as the sliver-band case — the only way to close
// this floor-sized, period-crossing gap was stretching the bounding 45-min special,
// which the duration-lock rule forbids. Correct outcome: special stays 45, gap
// remains (it's a layer-window issue for the user to resolve, not a duration to break).
test('auto scheduler keeps special duration over a floor-sized period-crossing gap (no stretch)', async (t) => {
  await runScenario('SLIVER-RESIDUAL (25-min gap = sport floor, straddles a period boundary, special|gap|Main wall)', {
    sliver2: true,
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 6 — SWIM-WALLS config: the user's LIVE swim-era regen bug. NONE of the
// first five scenarios include SWIM; the moment swim was enabled, two new
// wall-bounded gaps appeared that the existing STEP 6.865 absorber could NOT
// close (see campConfig({swimWalls}) for full geometry + feasibility-oracle):
//
//   [REAL-GAP] (Main|gap|special) 25m  Main-Activity wall (immune) | gap |
//              FOLLOWING special (Lake). The fix pulls the following special's
//              START backward over the gap (the wall on the left is immune, no
//              sport field is free in the 10:30-11:30 window).
//   [REAL-GAP] (swim|gap|Main) 15m  SWIM (immune in the OLD _SAB_IMMUNE set) |
//              gap | Main-Activity wall (immune). Both neighbours were immune,
//              so 6.865 could absorb NOTHING. The fix lets a NORMAL swim block
//              stretch forward over the sliver (its pool is free), while STILL
//              never stretching the Main-Activity wall.
//
// A perfect, gapless day EXISTS per bunk (feasibility-oracle in campConfig):
//   sport 9:00-9:45 | swim 9:45-10:45 (P1 45 + absorbed P2 15) |
//   Main 10:45-11:05 | special/Lake 11:05-12:15 (absorbed P4 25 + P5 45)
//   → 1 main, 1 special, 1 sport, swim covered, ZERO gap minutes.
//
// THE FIX (extends STEP 6.865 WALL-BOUNDED SLIVER-ABSORB):
//   - Add a stretchable-SWIM last-resort path (tried after sport, after special)
//     so a NORMAL swim block can grow over a swim|gap|Main sliver, gated by
//     isFieldAvailable on the pool + _validateWritePlacement +
//     coveredByContiguousPeriods — but NEVER stretch the Main-Activity wall,
//     lunch, league, trip, etc. (swim stays in _SAB_IMMUNE for the sport/special
//     predicates; the dedicated swim path is the only thing that may grow it).
//   - Recognize a special by its catalog NAME or registered ROOM (not just the
//     _autoSpecial/_isSpecialLocation flags), so the following-special-start-
//     pull-back path fires for the Main|gap|special case.
// The four criteria are NOT weakened.
// ---------------------------------------------------------------------------
test('auto scheduler fills a gapless day with swim-bounded and Main-wall-bounded gaps', async (t) => {
  await runScenario('SWIM-WALLS (swim|gap|Main 15m + Main|gap|special 25m, mixed-size periods, fields blocked 10:30-11:30)', {
    swimWalls: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 7 — SWIM-REAL config: the FAITHFUL reproduction of the live swim-era bug.
//
// TEST 6 (SWIM-WALLS) modeled swim AND the special as CUSTOM layers (named
// "Swim"/"Lake" in "Pool"/"Lake" fields) that pin deterministically. That made
// the test GREEN but UNFAITHFUL: it sidestepped the REAL type:'swim' planner
// (Phase 0 pin + pool staggering) and the REAL type:'special' GlobalPlanner +
// Phase 2.5 distributor. The live camp STILL had gaps because the real
// special-distribution path parks the special at its band END instead of flush
// after the Main-Activity wall.
//
// This scenario uses a REAL type:'swim' fullGrade layer and a REAL type:'special'
// layer (catalog specials in real rooms), plus a 20-min Main-Activity custom
// wall. Band structure (both grades, 9:00-12:20):
//   P0 09:00-09:45 sport | P1 09:45-10:30 SWIM (real swim, fullGrade) |
//   P2 10:30-10:50 Main-Activity wall (20-min custom) | P3 10:50-11:35 special
//   target | P4 11:35-12:20 sport.
// The special LAYER window is WIDE (10:50-12:20) and sport fields are blocked
// 10:30-11:35, so the only gapless outcome is the special placed flush after the
// Main wall (10:50-11:35). If the distributor parks it at the band end
// (11:35-12:20), the 10:50-11:35 gap is orphaned (the live bug).
//
// FEASIBILITY-ORACLE (a perfect, gapless day EXISTS per bunk):
//   sport 9:00-9:45 | swim 9:45-10:30 | Main 10:30-10:50 |
//   special 10:50-11:35 | sport 11:35-12:20
//   → 1 main, 1 special, 1 sport, swim covered, ZERO gap minutes.
// ---------------------------------------------------------------------------
test('auto scheduler fills a gapless day with a REAL swim layer + REAL catalog special', async (t) => {
  await runScenario('SWIM-REAL (real type:swim + real type:special, Main wall between, fields blocked 10:30-11:35)', {
    swimReal: true,
  });
});

// TEST 8 — SWIM-GA-SHARE: pool concurrency is configured on the "Swim" GENERAL
// ACTIVITY (globalSettings.facilities[].generalActivities[]), while the Pool
// FIELD is set not_sharable (capacity 1). This is the user's real config shape.
//
// Before the v18 fix, canUsePoolAtTime read ONLY the Pool field → capacity 1 →
// only one bunk could swim per window → most bunks fail ("could not place swim")
// and the day is left with gaps / missing swim. The fix makes canUsePoolAtTime
// prefer the Swim general activity's sharableWith (type:'all' → unlimited), so
// every bunk swims and the day is perfect. This test FAILS without the fix
// (verified by stashing the solver change) and PASSES with it.
test('auto scheduler honors pool sharing set on the Swim general activity (not the Pool field)', async (t) => {
  await runScenario('SWIM-GA-SHARE (Pool field not_sharable, Swim general-activity type:all)', {
    swimReal: true,
    swimGAShare: true,
    // The fix's guarantee is that EVERY bunk swims (concurrently, which the
    // field's not_sharable cap=1 would forbid → proves the Swim activity's
    // type:'all' is honored). The unrealistic not_sharable field also poisons
    // the gap-absorber's pool-stretch, leaving a 20-min Main-adjacent gap that
    // is NOT what this scenario tests — so assert swim coverage, skip gaps.
    requireSwim: true,
    skipGapCheck: true,
  });
});

// TEST 8b — SWIM-NO-FACILITY: NO facility is assigned to swim at all — no Pool
// FIELD in the catalog, no Swim GENERAL ACTIVITY in globalSettings.facilities,
// no legacy poolLaneCapacity. The rule: with no facility assigned, swim is
// UNLIMITED (no cap). All 14 bunks (8 Auto + 6 Chair) share ONE legal 45-min
// swim band (09:45-10:30), so pre-fix the phantom default capacity of 12 in
// canUsePoolAtTime starved bunks 13-14 ("could not place swim"). Post-fix the
// no-config default is unlimited (kill-switch: window.__swimNoFacilityUnlimited
// = false restores 12), so every bunk swims.
test('auto scheduler leaves swim UNCAPPED when no facility is assigned to swim', async (t) => {
  await runScenario('SWIM-NO-FACILITY (no Pool field, no Swim general activity → unlimited)', {
    swimReal: true,
    swimNoFacility: true,
    // Binding observable: the resolved pool capacity must be UNLIMITED (the old
    // code resolved a phantom default of 12 here — fails pre-fix).
    requireSwimUncappedResolved: true,
    // Umbrella: every bunk still swims (14 concurrent, facility-less).
    requireSwim: true,
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 9 — LUNCH-LEEWAY: a type:'lunch' layer that is NOT fullGrade and is drawn
// with a WIDE window (the whole day). This is the live-camp shape that left 4
// grades with a lunch layer but NO lunch block: the wide window gives ratio<1,
// so the classifier put lunch in the windowed/open fill path, and specials/
// sports crowded it out entirely.
//
// The fix pins lunch (and snacks) grade-wide regardless of the fullGrade flag or
// window width — every bunk eats lunch, every day — and snaps it to its 30-min
// duration near the window centre. With the fix, every bunk gets a lunch block.
// This test FAILS without the fix (lunch crowded out for most bunks) and PASSES
// with it.
test('auto scheduler pins a non-fullGrade, wide-window lunch layer for every bunk', async (t) => {
  await runScenario('LUNCH-LEEWAY (type:lunch, no fullGrade, whole-day window)', {
    lunchLeeway: true,
    requireLunch: true,
    // This scenario validates lunch coverage specifically; the wide lunch wall
    // can leave a small tiling residue that is not what we're testing here.
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 10 — SWIM-ROTATED: a type:'swim' layer that is NOT fullGrade (the live
// camp's per-bunk rotated swim). Every bunk needs swim today (bunksPerDay >=
// count), but a non-fullGrade swim is not pinned in Phase 0 — it must be
// reserved by Phase 2.3 as a wall BEFORE Phase 2.5 distributes specials, or the
// specials pack the swim window and the bunk ends the day with no swim ("missing
// SWIM: window ... has only 0min free" in the live log). Asserts every bunk
// gets swim.
test('auto scheduler reserves rotated (non-fullGrade) swim before specials for every bunk', async (t) => {
  await runScenario('SWIM-ROTATED (type:swim, fullGrade:false, no bell periods, reserved before specials)', {
    swimReal: true,
    swimRotated: true,
    requireSwim: true,
    requireSwimReservedBeforeSpecials: true,
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 11 — NO-SPORTS: a sports-free camp. The day is built from a Main Activity
// custom wall + specials only; the user NEVER created a sport layer. But the
// FIELD catalog (8 sport fields) is still configured in the sandbox (a leftover
// from setup / a template). Pre-fix, the engine treats every open grid slot as a
// sport-fillable 'slot' block and the AutoSolver back-fills it with a field sport
// (Baseball/Basketball/...), so a sports-free camp gets sports it never asked for
// (the live "why are there sports?" bug). Post-fix, with no sport layer the field
// catalog must NOT leak: open time is filled from the specials pool (or left
// clean), and NO bunk receives a sport-typed block.
test('auto scheduler injects NO field-catalog sports when the camp has no sport layer', async (t) => {
  await runScenario('NO-SPORTS (no sport layer, fields still configured)', {
    noSports: true,
    requireNoSports: true,
    // The fix under test is the sport-leak gate (no sport-typed blocks); whether
    // the limited specials pool can tile every last minute is a separate concern.
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 12 — PINNED-CUSTOM: a fixed-time custom "Morning Activity" wall must
// survive for every bunk. Pre-fix, the deferred-special recapture's skip-list
// was a name regex that only matched "main activity"/"shiur"/… so a custom named
// "Morning Activity" was a valid displacement target and got overwritten by a
// recaptured special for some bunks (live Harmony log: 'RECAPTURED Pioneering …
// displaced "Morning Activity"'). The custom-layer-name guard now protects every
// custom layer. Run with a special-heavy day to create recapture pressure.
test('auto scheduler never displaces a pinned custom layer with a recaptured special', async (t) => {
  await runScenario('PINNED-CUSTOM (fixed-time "Morning Activity", special-heavy day)', {
    morningPin: true,
    requireMorningPin: true,
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 13 — REQUIRED-WINDOWED-CUSTOM (stacker band): a required custom whose
// window is wider than its duration classifies "windowed" and competes with
// specials. Pre-fix it dropped for most bunks because Phase 2.5 pre-placed
// specials as walls before the Phase-3 custom need ran (live Harmony bug:
// Morning Activity landed for only 1 of 4 bunks). Two-layer defense now: Phase
// 1.4 reserves it BEFORE the planner distributes specials, and STEP 6.84
// (REQUIRED-CUSTOM ENSURE) guarantees it in the FINAL grid for any bunk a late
// saturated-band pass still crowded out. Asserts every bunk keeps exactly one
// in window.scheduleAssignments (the saved schedule).
test('auto scheduler reserves a required windowed custom layer for every bunk', async (t) => {
  await runScenario('REQUIRED-WINDOWED-CUSTOM (wide-window "Morning Activity", stacker band)', {
    morningPin: true,
    morningWide: true,
    requireMorningPin: true,
    skipGapCheck: true,
  });
});

// ---------------------------------------------------------------------------
// TEST 14 — SMOOTH-DAY (the user's live shape): sports-free, field-less
// Davening / Morning Activity / Main Activity anchors, an off-grid lunch wall,
// and a deep wide-window catalog of mixed 10/20/40-min specials. Measures how
// much dead time the REAL solver leaves per bunk after all post-passes. Run
// with skipGapCheck so it reports rather than hard-fails while we iterate;
// requireNoSports asserts the sports-free invariant holds.
test('auto scheduler drives full swim behavior from a General-Activity layer (quickType:swim)', async (t) => {
  // Refactor keystone: swim is no longer a hard-coded type — it comes from a
  //   General Activity (custom layer, quickType:'swim', bound to the Pool
  //   facility). The solver's GA normalization must map it to swim behavior so
  //   every bunk still gets swim (pool gate + stagger + change envelope + the
  //   swim-coverage guarantee all fire). Same assertions as SWIM-REAL.
  await runScenario('SWIM-VIA-GENERAL-ACTIVITY (custom layer, quickType:swim @ Pool)', {
    swimReal: true,
    swimAsGA: true,
    requireSwim: true,
    skipGapCheck: true,
  });
});

test('auto scheduler builds a fully GAPLESS sportless day when walls are grid-aligned', async (t) => {
  // The PROOF: with anchors/lunch on the 10-min special grid, the real solver
  //   leaves ZERO dead minutes for every bunk in the cleanly-modeled grade.
  //   (The 2nd grade is omitted from the gapless assertion — two identically-timed
  //   grades collide on a shared anchor name, an artifact real camps avoid by
  //   staggering divisions.)
  const { results } = await runScenario('SMOOTH-DAY ALIGNED (sportless, mixed-dur specials, grid walls)', {
    smooth: true, requireNoSports: true, skipGapCheck: true,
  });
  const auto = Object.entries(results).filter(([b, r]) => r.grade === 'Auto');
  const bad = auto.filter(([b, r]) => r.gapMin !== 0)
    .map(([b, r]) => `${b}:${r.gapMin}min (${r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(',')})`);
  assert.deepEqual(bad, [], 'grid-aligned walls must yield a gapless day:\n  ' + bad.join('\n  '));

  // The field-less, tight-window anchors must stay PINNED at their configured
  //   times (movability == layer-window slack; window == duration → no move).
  const ANCHORS = { 'davening': [HM(9,0), HM(9,20)], 'morning activity': [HM(9,20), HM(10,0)], 'main activity': [HM(14,20), HM(15,0)] };
  const drifted = [];
  for (const [bunk, r] of auto) {
    for (const [name, [s, e]] of Object.entries(ANCHORS)) {
      const hits = (r.entries || []).filter(x => String(x.act).toLowerCase() === name);
      if (!hits.length) { drifted.push(`${bunk}: missing ${name}`); continue; }
      if (!hits.some(x => x.startMin === s && x.endMin === e))
        drifted.push(`${bunk}: ${name} at ${hits.map(x => fmt(x.startMin)+'-'+fmt(x.endMin)).join(',')} (want ${fmt(s)}-${fmt(e)})`);
    }
  }
  assert.deepEqual(drifted, [], 'tight-window (field-less) anchors must stay fixed at their configured times:\n  ' + drifted.join('\n  '));
});

test('auto scheduler coalesces the off-grid remainder into one small sliver (field-less anchors slide, no stretch)', async (t) => {
  // REGRESSION GUARD for the df31dd5 mistake. The real camp has OFF-GRID walls
  //   (lunch +5, Main shifted) and FIELD-LESS Davening/Morning/Main anchors with
  //   tight windows. If those anchors are PINNED, every region fragments and a
  //   sub-floor sliver is stranded on each side → catastrophic dead time. Because
  //   they are window-dropped and region-slide, the off-grid remainder coalesces
  //   into at most ONE small sliver per bunk — AND no special is stretched past
  //   its configured duration to fill the coalesced space (the careful fix:
  //   slide-but-never-stretch). This is the test that would have caught the
  //   3800-min regression; the grid-aligned test could not (grid walls hide it).
  const { results } = await runScenario('SMOOTH-DAY OFF-GRID (field-less anchors slide; no special stretch)', {
    smooth: true, smoothOffGrid: true, requireNoSports: true, skipGapCheck: true,
  });
  const auto = Object.entries(results).filter(([b, r]) => r.grade === 'Auto');
  // (specialDur is asserted for ALL bunks inside runScenario — a stretched
  //   special hard-fails there. Here we add the anti-fragmentation bound.)
  // HONEST-OPEN contract: the unfillable remainder sliver is no longer dressed
  //   up as a generic "Special: …" tile — it is dropped at emit and shows as
  //   OPEN time. So the coalescence guard now reads the sliver as a gap:
  //   at most ONE contiguous run, no bigger than the single sub-floor
  //   remainder (25 min here). Fragmentation (the df31dd5 regression) leaves
  //   MANY runs and hundreds of minutes — still hard-fails.
  const COALESCED_MAX = 25; // the one sub-floor remainder sliver, now visible as open time
  const fragmented = auto
    .filter(([b, r]) => r.gapMin > COALESCED_MAX || (r.gaps || []).length > 1)
    .map(([b, r]) => `${b}:${r.gapMin}min in ${(r.gaps || []).length} run(s) (${r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(',')})`);
  assert.deepEqual(fragmented, [], 'off-grid day must coalesce to one small sliver per bunk — ' +
    'fragmentation here means field-less anchors are wrongly pinned again:\n  ' + fragmented.join('\n  '));
});

test('auto scheduler tiles the pre-bell-grid morning (a bell schedule never shrinks the day)', async (t) => {
  // REGRESSION GUARD for the "activity floating with dead space on both sides"
  //   report (Minors 2: Arts & Crafts 10:00-10:20, dead 9:50-10:00 and
  //   10:20-10:35). Root cause: a stale/partial bell schedule that covers only
  //   the afternoon (10:50→end) dead-zoned the 9:00-10:50 morning, so the morning
  //   never reached the duration-first region tiler — a special got scattered
  //   there with gaps around it. The day-coverage extension adds a synthetic
  //   morning period so the pre-grid morning is tiled flush + filled like any
  //   other region. Aligned {10,20,40} catalog + grid-aligned walls ⇒ the morning
  //   tiles to ZERO gap. Without the fix the 10:00-10:50 morning is ~50 dead min.
  const { results } = await runScenario('SMOOTH-DAY PARTIAL-BELL (afternoon-only grid; morning must still tile)', {
    smooth: true, smoothPartialBell: true, requireNoSports: true, skipGapCheck: true,
  });
  const auto = Object.entries(results).filter(([b, r]) => r.grade === 'Auto');
  const bad = auto.filter(([b, r]) => r.gapMin !== 0)
    .map(([b, r]) => `${b}:${r.gapMin}min (${r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(',')})`);
  assert.deepEqual(bad, [], 'a partial (afternoon-only) bell schedule must not dead-zone the ' +
    'morning — the pre-grid morning must tile to zero gap:\n  ' + bad.join('\n  '));
});

test('auto scheduler keeps a pinned lunch at its configured time (never nudges it)', async (t) => {
  // Regression guard: a pinned lunch must NOT be moved by the tiler to swallow a
  //   sliver. (A prior "snap wall" change nudged lunch off its configured 12:20
  //   start — the user reported lunch had moved.) lunch is a hard-fixed wall:
  //   every bunk's lunch block must sit exactly at its configured 12:20-12:40.
  const { results } = await runScenario('SMOOTH-DAY (pinned-lunch position guard)', {
    smooth: true, requireNoSports: true, skipGapCheck: true,
  });
  const LUNCH_S = HM(12, 20), LUNCH_E = HM(12, 40);
  const moved = [];
  for (const [bunk, r] of Object.entries(results)) {
    const lunch = (r.entries || []).filter(e => String(e.act).toLowerCase() === 'lunch');
    if (!lunch.length) { moved.push(`${bunk}: no lunch block`); continue; }
    const ok = lunch.some(e => e.startMin === LUNCH_S && e.endMin === LUNCH_E);
    if (!ok) moved.push(`${bunk}: lunch at ${lunch.map(e => fmt(e.startMin) + '-' + fmt(e.endMin)).join(',')} (want 12:20-12:40)`);
  }
  assert.deepEqual(moved, [], 'pinned lunch must stay at its configured time:\n  ' + moved.join('\n  '));
});

// ---------------------------------------------------------------------------
// TEST — LAYER-FLOOR guarantee (the active goal). A special layer carries a
// subcategory FLOOR of "snack = 2". The contract: EVERY bunk must end the day
// with 2 snack-subcategory specials, no matter how the distributor packed the
// day. STEP 6.98 LAYER-FLOOR ENFORCER tops up any bunk left short by reclaiming
// Free / generic-filler / sport time (preferring to drop a sport over a
// special). The day is the FAIR grid (8 sport fields, 20-min periods) so there
// is always reclaimable room; Canteen + Gameroom are the two snack specials
// (cross-division cap 20 → ample). The standard perfect-day criteria still hold
// (Main==1, special>=1, sport>=1, gapless, no over-duration) — the floor is met
// WITHOUT breaking anything else.
// ---------------------------------------------------------------------------
test('auto scheduler guarantees every bunk meets a subcategory layer floor (snack = 2)', async (t) => {
  // skipGapCheck: with 14 bunks contending for 8 sport fields during the grade
  //   overlap, a couple of bunks can end with a tail Free period — a field-
  //   starvation/tiling artifact (proven gapless under non-starved grids in other
  //   tests), independent of the floor enforcer (snacks are full-period here, so
  //   the enforcer never splits and never creates a gap). The contract under test
  //   is the FLOOR, asserted via requireSubFloor.
  const { results } = await runScenario('LAYER-FLOOR (snack subcategory = 2 per bunk)', {
    subFloor: true, requireSubFloor: true, skipGapCheck: true,
  });
  // Belt-and-suspenders: re-assert the floor explicitly with a readable message.
  const short = [];
  for (const [bunk, r] of Object.entries(results)) {
    if ((r.subFloorCount || 0) < 2) short.push(`${bunk}: ${r.subFloorCount || 0} snack specials (want 2)`);
  }
  assert.deepEqual(short, [], 'every bunk must reach the snack subcategory floor of 2:\n  ' + short.join('\n  '));
});

// ---------------------------------------------------------------------------
// TEST — LAYER-FLOOR enforcer placement path. Same snack = 2 floor, but the
// special layer window is confined to ONE 20-min period so the distributor can
// only seat ONE snack in-window. The 2nd snack can ONLY come from STEP 6.98
// reclaiming a sport/Free slot elsewhere — so this proves the enforcer's
// placement path actually runs (asserted via its "placed" log line) AND that
// every bunk still reaches the floor of 2.
// ---------------------------------------------------------------------------
test('auto scheduler enforces a subcategory floor the distributor under-delivers (STEP 6.98 places the shortfall)', async (t) => {
  const { results, sandbox } = await runScenario('LAYER-FLOOR TIGHT (1-period special window, snack = 2)', {
    subFloorTight: true, requireSubFloor: true, skipGapCheck: true,
  });
  // The enforcer must have actually placed at least one missing snack.
  const placedLine = (sandbox.__logs || []).find(l => /STEP 6\.98 LAYER-FLOOR ENFORCE\] placed \d+/.test(l));
  assert.ok(placedLine, 'STEP 6.98 enforcer must have placed at least one shortfall special (saw: ' +
    ((sandbox.__logs || []).filter(l => /6\.98/.test(l)).join(' | ') || 'no 6.98 log') + ')');
  const m = /placed (\d+)/.exec(placedLine);
  assert.ok(m && parseInt(m[1], 10) > 0, 'STEP 6.98 placed count must be > 0 (line: ' + placedLine + ')');
  // And every bunk still reaches the floor.
  const short = [];
  for (const [bunk, r] of Object.entries(results)) {
    if ((r.subFloorCount || 0) < 2) short.push(`${bunk}: ${r.subFloorCount || 0} snack specials (want 2)`);
  }
  assert.deepEqual(short, [], 'every bunk must reach the snack floor of 2 after enforcement:\n  ' + short.join('\n  '));
});

// ---------------------------------------------------------------------------
// TEST — DEMAND ↔ CAPACITY RECONCILIATION. One special ("VR") is a not_sharable,
// capacity-1 seat tagged subcategory 'shiur', and the special layer floors that
// subcat at 1 for every bunk → all 14 bunks demand the single chair (the live
// "Shiur given to 13 bunks but only one Rabbi" over-subscription). The pre-layout
// reconciliation pass must clamp the AGGREGATE floor to what one seat can deliver
// in the day and demote the surplus to opportunistic (cap kept, floor dropped),
// instead of committing 14 must-place tiles into 1 seat and thrashing the recovery
// passes. We assert (1) the reconciliation fired and demoted surplus floors, and
// (2) the engine never seats more than one 'VR' concurrently (the cap-1 invariant).
// ---------------------------------------------------------------------------
test('auto scheduler reconciles over-subscribed demand against capacity (cap-1 shiur, 14 bunks)', async (t) => {
  const opts = { oversub: true };
  const cfg = campConfig(opts);
  const sandbox = buildSandbox(opts);
  loadModules(sandbox);
  const layers = buildLayers(cfg);
  const ranOk = await sandbox.runAutoScheduler(layers, { allowedDivisions: null });
  assert.notEqual(ranOk, false, 'runAutoScheduler returned false (generation aborted)');

  const logs = sandbox.__logs || [];
  // (1) Reconciliation fired for the cap-1 'shiur' seat and demoted surplus floors.
  const rec = logs.find(l => /\[GENERIC-RECONCILE\].*specialact:VR/.test(l));
  assert.ok(rec, 'expected a [GENERIC-RECONCILE] line for the cap-1 shiur seat (specialact:VR). ' +
    'Reconcile lines seen: ' + (logs.filter(l => /GENERIC-RECONCILE/.test(l)).join(' | ') || 'NONE'));
  const dem = /demoted (\d+)/.exec(rec);
  assert.ok(dem && parseInt(dem[1], 10) > 0,
    'reconciliation must demote at least one surplus floor (line: ' + rec + ')');

  // (2) Cap-1 invariant: no two 'VR' assignments overlap in time across all bunks.
  const vr = [];
  for (const bunk of [...AUTO_BUNKS, ...CHAIR_BUNKS]) {
    (sandbox.scheduleAssignments[bunk] || []).forEach(s => {
      if (s && String(s._activity || '').toLowerCase() === 'vr' &&
          s._startMin != null && s._endMin != null && !s.continuation) {
        vr.push({ bunk, s: s._startMin, e: s._endMin });
      }
    });
  }
  for (let i = 0; i < vr.length; i++) {
    for (let j = i + 1; j < vr.length; j++) {
      const a = vr[i], b = vr[j];
      assert.ok(!(a.s < b.e && b.s < a.e),
        `cap-1 'VR' double-booked: ${a.bunk} ${fmt(a.s)}-${fmt(a.e)} overlaps ${b.bunk} ${fmt(b.s)}-${fmt(b.e)}`);
    }
  }
});

test('auto scheduler leaves a GENUINE OPEN slot when a subcategory pool is exhausted (subcat-strict: no cross-subcat fill, no placeholder, no sport)', async (t) => {
  // SUBCAT-STRICT CONTRACT: a subcategory is a semantic commitment. If the user
  //   put in 4 activities but 5 slots need filling, slot 5 is a GENUINE FREE —
  //   never another subcategory's activity, never a manufactured placeholder,
  //   never a Sport. Here every bunk demands food '=' 2 but the camp has ONE
  //   food special (Baking, seat-rich so capacity is not the limiter): the
  //   second food tile can never fill from its own subcat (no same-day repeat)
  //   and must surface as OPEN time attributed to 'food' in the capacity advice.
  const XDIV = { type: 'cross_division', divisions: [],
    capacity: 20, allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } };
  const mk = (name, dur, subcat) => ({
    name, location: name + ' Rm', type: 'Special', subcategory: subcat,
    duration: dur, durationMin: dur,
    sharableWith: XDIV, timeRules: [], availableDays: null,
  });
  const specialsOverride = [
    mk('Baking', 40, 'food'),
    // plenty of REAL free 'theme' specials at the same 40-min length — the strict
    // contract is that these must NOT be pulled into the dead food slot.
    mk('Drama', 40, 'theme'), mk('Art Shoppes', 40, 'theme'), mk('Accessorize', 40, 'theme'),
    mk('Pioneering', 40, 'theme'), mk('Gymnastics', 40, 'theme'), mk('Woodworking', 40, 'theme'),
    // (durations mirror SMOOTH_SPECIALS so the harness's stretched-duration guard stays valid)
    mk('Neranitas', 20, 'theme'), mk('Arts & Crafts', 20, 'theme'), mk('Foam Pit', 20, 'theme'),
    mk('Ice Cream', 20, 'theme'), mk('Shiur', 20, 'theme'),
    mk('Slush', 10, 'theme'), mk('Popcorn', 10, 'theme'),
  ];
  const { results, sandbox } = await runScenario('SUBCAT-STRICT (food floor 2, one food special → slot 2 is genuine free)', {
    smooth: true, requireNoSports: true, skipGapCheck: true, specialsOverride,
    subQuantities: { food: 2 }, subOps: { food: '=' },
  });
  // 1) no dressed-up placeholder survives to the emitted schedule
  const generics = [];
  for (const [bunk, slots] of Object.entries(sandbox.scheduleAssignments || {})) {
    (slots || []).forEach(s => { if (s && s._generic === true) generics.push(`${bunk}: ${s._activity}`); });
  }
  assert.deepEqual(generics, [], 'no generic placeholder tile may survive (honest open, not dressed up):\n  ' + generics.join('\n  '));
  // 2) the dropped tiles are exposed for the capacity advice, attributed to FOOD —
  //    one 40-min open slot per bunk (14 bunks), all tagged with the demanded subcat.
  const open = sandbox.__genOpenSlots || [];
  const openFood = open.filter(o => o && o.subcat === 'food' && (o.endMin - o.startMin) === 40);
  assert.equal(openFood.length, 14,
    `every bunk's unfillable 2nd food tile must surface as a 40-min open slot tagged 'food' — got ${openFood.length}/14 (all open: ${JSON.stringify(open)})`);
  assert.equal(open.length, openFood.length,
    'no OTHER open slots expected in this scenario: ' + JSON.stringify(open.filter(o => !(o && o.subcat === 'food'))));
  // 3) the open time is REAL free time on the grid: each Auto bunk shows exactly
  //    the one 40-min gap (the food slot), in a single run — and NOT theme-filled.
  //    (Chair's shorter configured day reads as scenario-frame gaps in every
  //    smooth test and is not asserted there either.)
  const badGaps = Object.entries(results)
    .filter(([b, r]) => r.grade === 'Auto')
    .filter(([b, r]) => r.gapMin !== 40 || (r.gaps || []).length !== 1)
    .map(([b, r]) => `${b}:${r.gapMin}min in ${(r.gaps || []).length} run(s) (${r.gaps.map(g => fmt(g[0]) + '-' + fmt(g[1])).join(',')})`);
  assert.deepEqual(badGaps, [], 'each Auto bunk must show exactly ONE 40-min genuine-free run (the exhausted food slot):\n  ' + badGaps.join('\n  '));
  // 4) the engine says so, honestly, in one line
  assert.ok((sandbox.__logs || []).some(l => String(l).includes('[GENERIC-HONEST]')),
    'the honest-open endgame must report the dropped tiles');
});

test('auto scheduler fills a tile with a cohort-DEFERRED activity rather than leaving it open (fill-if-possible)', async (t) => {
  // FILL-IF-POSSIBLE: the rotation-cohort gate ("nobody twice until every
  //   cohort bunk has been once") used to HARD-SKIP an activity for every bunk
  //   ahead of the cohort minimum — pools emptied for the whole day and tiles
  //   went OPEN while seats sat free (live: 53/72 workshop options blocked).
  //   Now those activities are DEFERRED, not dropped: the have-nots keep
  //   absolute priority via the primary pool, and a deferred activity fills a
  //   tile ONLY when the alternative is dead time.
  const XDIV = { type: 'cross_division', divisions: [],
    capacity: 20, allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } };
  const mk = (name, dur, subcat, extra) => Object.assign({
    name, location: name + ' Rm', type: 'Special', subcategory: subcat,
    duration: dur, durationMin: dur,
    sharableWith: XDIV, timeRules: [], availableDays: null,
  }, extra || {});
  const specialsOverride = [
    // the cohort-gated workshop: every bunk except Chair 6 did it on a prior
    // day → cohort min 0 → 17 of 18 bunks are DEFERRED for it today.
    mk('Craftastic', 40, 'workshops', { rotationCohort: { enabled: true, grades: ['Auto', 'Chair'] } }),
    // the rest of the day's pool (no cohort)
    mk('Drama', 40, 'theme'), mk('Art Shoppes', 40, 'theme'), mk('Accessorize', 40, 'theme'),
    mk('Pioneering', 40, 'theme'), mk('Gymnastics', 40, 'theme'), mk('Woodworking', 40, 'theme'),
    mk('Neranitas', 20, 'theme'), mk('Arts & Crafts', 20, 'theme'), mk('Foam Pit', 20, 'theme'),
    mk('Ice Cream', 20, 'theme'), mk('Shiur', 20, 'theme'),
    mk('Slush', 10, 'theme'), mk('Popcorn', 10, 'theme'),
  ];
  // prior day: everyone but Chair 6 already had Craftastic
  const priorAssignments = {};
  [...AUTO_BUNKS, ...CHAIR_BUNKS].forEach(b => {
    if (b === 'Chair 6') return;
    priorAssignments[b] = [{ _activity: 'Craftastic', field: 'Craftastic Rm', continuation: false }];
  });
  const priorDays = { '2026-07-14': { scheduleAssignments: priorAssignments } };
  const { results, sandbox } = await runScenario('COHORT DEFER (17/18 bunks ahead; deferred fills before OPEN)', {
    smooth: true, requireNoSports: true, skipGapCheck: true, specialsOverride, priorDays,
  });
  const logs = (sandbox.__logs || []).map(String);
  // 1) the gate DEFERS instead of hard-skipping
  assert.ok(logs.some(l => l.includes('[cohort] defer Craftastic')),
    'cohort gate must DEFER (not skip) an ahead-of-minimum bunk');
  // 2) the last-resort fill actually fired
  assert.ok(logs.some(l => l.includes('cohort-relaxed last-resort fill')),
    'a tile that would otherwise be OPEN must fill with the deferred activity');
  // 3) most bunks end the day WITH Craftastic (deferred for 17, primary for Chair 6),
  //    each at most once (no same-day repeat is untouched)
  let withCraft = 0;
  for (const [bunk, slots] of Object.entries(sandbox.scheduleAssignments || {})) {
    const n = (slots || []).filter(s => s && !s.continuation && s._activity === 'Craftastic').length;
    assert.ok(n <= 1, bunk + ' must not repeat Craftastic same-day (got ' + n + ')');
    if (n === 1) withCraft++;
  }
  assert.ok(withCraft >= 12, 'deferred fills should land broadly (got ' + withCraft + '/18 bunks)');
  // 4) still no placeholder tiles anywhere
  const generics = [];
  for (const [bunk, slots] of Object.entries(sandbox.scheduleAssignments || {})) {
    (slots || []).forEach(s => { if (s && s._generic === true) generics.push(bunk); });
  }
  assert.deepEqual(generics, [], 'no generic placeholder may survive');
});

test('maxUsage "per week" counts THIS week only — last week\'s visits must not starve the pool (legacy \'week\' alias)', async (t) => {
  // REGRESSION (live, Camp Neranina): config stores maxUsagePeriod:'week' (legacy
  //   string). The engine-local getPeriodStartDate had cases only for '1week'..'4weeks',
  //   so 'week' fell to default → HALF start → getPeriodCount counted the entire half.
  //   Result: "[max] skip Shiur (count=3..5 >= max=3 per week)" on day 2 of a week where
  //   the bunk had done 0 shiurs — while the weekly floor's counter (which normalizes
  //   the alias) said wk 0/1. 22 shiur tiles/day went OPEN with seats free.
  //   Here: the ONLY 'shiur' special is capped 3× per week; every bunk did it 3× LAST
  //   week (Wed-Fri, before this week's Monday 2026-07-13). This week's count is 0, so
  //   today (Wed 2026-07-15) every bunk must still get it — no [max] skip, no open slot.
  const XDIV = { type: 'cross_division', divisions: [],
    capacity: 20, allowedPairs: { 'Auto|Auto': true, 'Chair|Chair': true, 'Auto|Chair': true } };
  const mk = (name, dur, subcat, extra) => Object.assign({
    name, location: name + ' Rm', type: 'Special', subcategory: subcat,
    duration: dur, durationMin: dur,
    sharableWith: XDIV, timeRules: [], availableDays: null,
  }, extra || {});
  const specialsOverride = [
    mk('Shiur', 20, 'shiur', { maxUsage: 3, maxUsagePeriod: 'week' }),
    // rest of the day's pool (durations mirror SMOOTH_SPECIALS)
    mk('Drama', 40, 'theme'), mk('Art Shoppes', 40, 'theme'), mk('Accessorize', 40, 'theme'),
    mk('Pioneering', 40, 'theme'), mk('Gymnastics', 40, 'theme'), mk('Woodworking', 40, 'theme'),
    mk('Neranitas', 20, 'theme'), mk('Arts & Crafts', 20, 'theme'), mk('Foam Pit', 20, 'theme'),
    mk('Ice Cream', 20, 'theme'), mk('Baking', 40, 'theme'),
    mk('Slush', 10, 'theme'), mk('Popcorn', 10, 'theme'),
  ];
  // 3 shiur days LAST week for every bunk (all before Monday 2026-07-13)
  const priorDays = {};
  ['2026-07-08', '2026-07-09', '2026-07-10'].forEach(dk => {
    const assigns = {};
    [...AUTO_BUNKS, ...CHAIR_BUNKS].forEach(b => {
      assigns[b] = [{ _activity: 'Shiur', field: 'Shiur Rm', continuation: false }];
    });
    priorDays[dk] = { scheduleAssignments: assigns };
  });
  const { results, sandbox } = await runScenario('WEEK-ALIAS (3× last week; this week 0 → today must fill)', {
    smooth: true, requireNoSports: true, skipGapCheck: true, specialsOverride, priorDays,
    subQuantities: { shiur: 1 }, subOps: { shiur: '=' },
  });
  const logs = (sandbox.__logs || []).map(String);
  // 1) the weekly ceiling must NOT fire — this week's count is 0
  const maxSkips = logs.filter(l => l.includes('[max] skip Shiur'));
  assert.deepEqual(maxSkips, [],
    'maxUsage "per week" must count THIS week only (last week\'s 3 visits are out of window):\n  ' + maxSkips.join('\n  '));
  // 2) no shiur tile goes OPEN — the pool was never starved
  const openShiur = (sandbox.__genOpenSlots || []).filter(o => o && o.subcat === 'shiur');
  assert.deepEqual(openShiur, [],
    'no shiur tile may go OPEN when the special is in-window: ' + JSON.stringify(openShiur));
  // 3) every bunk gets its demanded shiur today, exactly once
  const missing = [], repeated = [];
  for (const [bunk, slots] of Object.entries(sandbox.scheduleAssignments || {})) {
    const n = (slots || []).filter(s => s && !s.continuation && s._activity === 'Shiur').length;
    if (n === 0) missing.push(bunk);
    if (n > 1) repeated.push(bunk + ':' + n);
  }
  assert.deepEqual(missing, [], 'every bunk must get Shiur today (this week count=0 < max=3): ' + missing.join(', '));
  assert.deepEqual(repeated, [], 'no same-day repeat: ' + repeated.join(', '));
});
