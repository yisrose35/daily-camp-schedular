'use strict';
// Simulation test for the MID-DAY RAIN SPLIT (Manual builder, daily_adjustments.js).
//
// Models the v3 mid-day rain flow: the day is CUT at the rain-start minute —
// everything before it stays (pinned, keeps rotation credit), everything after
// is erased (schedule + rotation credit), and a block in progress at the cut
// follows the 75% rule: ≥75% done → kept + counted; less → erased + not counted.
//
// Invariants proven:
//   1. Block ends ≤ T   → kept, stamped _pinned/_fixed/_midDayPreserved.
//   2. Block starts ≥ T → erased (slot → null).
//   3. Straddling block: done-fraction ≥ 0.75 keeps it, < 0.75 erases it;
//      exactly 75% keeps (>= rule).
//   4. Multi-slot blocks (spanned specials) are decided as ONE unit over the
//      full span, continuation slots follow the head, stats count blocks once.
//   5. Rotation counting (which skips null/continuation entries) loses credit
//      for erased blocks and keeps it for kept ones — no marker needed.
//   6. Blocks with no resolvable time are left untouched.
//   7. Bunks outside the passed divisions are never scanned or returned.
//   8. The input assignments object is not mutated (pure function).

const test = require('node:test');
const assert = require('node:assert');

// ── Pure re-implementation of the production logic under test ──────────────
// (mirrors daily_adjustments.js _rainySplitScheduleAt — keep in sync)

const RAIN_KEEP_FRACTION = 0.75;

function rainySplitScheduleAt(assignments, divisionTimes, divisions, tMin, keepFraction) {
  const kf = (typeof keepFraction === 'number') ? keepFraction : RAIN_KEEP_FRACTION;
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
  const out = {};
  const stats = { keptDone: 0, keptInProgress: 0, erasedInProgress: 0, erasedFuture: 0, unknown: 0 };
  Object.entries(divisions || {}).forEach(([divName, divData]) => {
    const slots = (divisionTimes || {})[divName] || [];
    (((divData || {}).bunks) || []).forEach(b => {
      const bunk = String(b);
      const arr = (assignments || {})[bunk];
      if (!Array.isArray(arr)) return;

      const groups = new Map();
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!e) continue;
        const bs = (e._blockStart != null) ? e._blockStart
                 : (e._startMin != null) ? e._startMin : null;
        const key = (bs != null) ? ('b:' + bs) : ('i:' + i);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
      }

      const res = arr.map(e => e ? JSON.parse(JSON.stringify(e)) : null);
      groups.forEach(indices => {
        let start = null, end = null;
        indices.forEach(i => {
          const s = slots[i] || {};
          const e = arr[i] || {};
          const ss = toMin((s.startMin != null) ? s.startMin : ((s.start != null) ? s.start : e._startMin));
          const se = toMin((s.endMin != null) ? s.endMin : ((s.end != null) ? s.end : e._endMin));
          if (ss != null && (start == null || ss < start)) start = ss;
          if (se != null && (end == null || se > end)) end = se;
        });
        if (start == null || end == null || end <= start) {
          stats.unknown += indices.length;
          return;
        }
        let keep, inProgress = false;
        if (end <= tMin) keep = true;
        else if (start >= tMin) keep = false;
        else { inProgress = true; keep = ((tMin - start) / (end - start)) >= kf; }
        indices.forEach(i => {
          const isHead = res[i] && !res[i].continuation;
          if (keep) {
            res[i] = Object.assign({}, res[i], { _pinned: true, _fixed: true, _midDayPreserved: true });
            if (isHead) stats[inProgress ? 'keptInProgress' : 'keptDone']++;
          } else {
            if (isHead) stats[inProgress ? 'erasedInProgress' : 'erasedFuture']++;
            res[i] = null;
          }
        });
      });
      out[bunk] = res;
    });
  });
  return { assignments: out, stats };
}

// ── Pure re-implementation of the mid-day CUT-SCOPED GENERATE logic ─────────
// (mirrors daily_adjustments.js _rainyBuildMidDayRegenScope — keep in sync)

function rainyBuildMidDayRegenScope(assignments, divisionTimes, divisions, tMin) {
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
  const scope = {};
  let regenTotal = 0;
  Object.entries(divisions || {}).forEach(([divName, divData]) => {
    const slots = (divisionTimes || {})[divName] || [];
    (((divData || {}).bunks) || []).forEach(b => {
      const bunk = String(b);
      const arr = (assignments || {})[bunk] || [];
      const n = Math.max(arr.length, slots.length);
      const regen = new Set();
      const keep = {};
      const orig = {};
      for (let i = 0; i < n; i++) {
        const e = arr[i];
        const s = slots[i] || {};
        const se = toMin((s.endMin != null) ? s.endMin : ((s.end != null) ? s.end : (e ? e._endMin : null)));
        const postCut = (se != null) && (se > tMin);
        const pinnedByUser = !!(e && (e._pinned || e._fixed));
        if (postCut && !pinnedByUser) {
          regen.add(i);
          if (e) orig[i] = JSON.parse(JSON.stringify(e));
        } else if (e) {
          keep[i] = JSON.parse(JSON.stringify(e));
        }
      }
      scope[bunk] = { regen, keep, orig };
      regenTotal += regen.size;
    });
  });
  return { scope, regenTotal };
}

// scheduler_core_main.js STEP 6.5 slot-scope gate + occupied filter (simplified):
// with an active per-slot scope, the solver may fill ONLY the scoped regen slots.
function filterBlocksWithScope(blocks, scheduleAssignments, regenSlotScope) {
  return blocks.filter(b => {
    const rs = regenSlotScope && regenSlotScope[b.bunk];
    if (rs && rs.regen && typeof rs.regen.has === 'function' && !rs.regen.has(b.slots[0])) return false;
    const ex = scheduleAssignments[b.bunk] && scheduleAssignments[b.bunk][b.slots[0]];
    if (ex && !ex.continuation && !ex._isTransition) {
      const act = (ex._activity || ex.field || '').toLowerCase().trim();
      if (act && act !== 'free' && act !== 'free play') return false;
    }
    return true;
  });
}

// rotation_cloud.js saveRotationCounts / scheduler_core_utils rebuildHistoricalCounts
// counting rule (simplified): skip null / continuation / transition / Free.
function countRotation(assignments) {
  const counts = {};
  Object.keys(assignments).forEach(bunk => {
    (assignments[bunk] || []).forEach(e => {
      if (!e || e.continuation || e._isTransition) return;
      const act = e._activity || '';
      if (!act || act.toLowerCase() === 'free') return;
      counts[bunk] = counts[bunk] || {};
      counts[bunk][act] = (counts[bunk][act] || 0) + 1;
    });
  });
  return counts;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// Day: 4 one-hour slots 10:00 (600), 11:00 (660), 14:00 (840... simplified:
// keep sequential hours 600/660/720/780 for clarity.

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
      { _activity: 'Soccer', field: 'Field 1' },     // 600-660
      { _activity: 'Swim', field: 'Pool' },          // 660-720 (straddle candidate)
      { _activity: 'Art', field: 'Art Room' },       // 720-780
      { _activity: 'Hockey', field: 'Rink' },        // 780-840
    ],
    B: [
      { _activity: 'Basketball', field: 'Court 1' },
      null,
      { _activity: 'Tennis', field: 'Court 2' },
      { _activity: 'Chess', field: 'Club' },
    ],
    C: [
      { _activity: 'Dance', field: 'Studio' },
      { _activity: 'Music', field: 'Hall' },
    ],
    Ghost: [ { _activity: 'Nothing', field: 'Nowhere' } ], // not in any division
  };
  return { divisions, divisionTimes, scheduleAssignments };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('past blocks kept + pinned; future blocks erased (T on a slot boundary)', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const { assignments, stats } = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 720);

  // A: slots 0-1 end ≤ 720 → kept+pinned; slots 2-3 start ≥ 720 → erased.
  [0, 1].forEach(i => {
    assert.ok(assignments.A[i] && assignments.A[i]._pinned && assignments.A[i]._fixed && assignments.A[i]._midDayPreserved,
      'A slot ' + i + ' kept + pinned');
    assert.strictEqual(assignments.A[i]._activity, scheduleAssignments.A[i]._activity);
  });
  [2, 3].forEach(i => assert.strictEqual(assignments.A[i], null, 'A slot ' + i + ' erased'));

  // B: null slot stays null; erased Tennis/Chess; kept Basketball.
  assert.ok(assignments.B[0]._pinned);
  assert.strictEqual(assignments.B[1], null);
  assert.strictEqual(assignments.B[2], null);
  assert.strictEqual(assignments.B[3], null);

  // C (Div2): both blocks end ≤ 720 → kept.
  assert.ok(assignments.C[0]._pinned && assignments.C[1]._pinned);

  assert.strictEqual(stats.keptDone, 2 + 1 + 2, 'kept blocks counted (A:2, B:1, C:2)');
  assert.strictEqual(stats.erasedFuture, 2 + 2, 'future blocks counted');
  assert.strictEqual(stats.keptInProgress + stats.erasedInProgress, 0, 'no straddle at a boundary');
});

test('straddling block: ≥75% done kept + counted, <75% erased; exactly 75% keeps', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();

  // T=665: slot 660-720 is 5/60 = 8% done → erased.
  let r = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 665);
  assert.strictEqual(r.assignments.A[1], null, '8%-done Swim erased');
  assert.strictEqual(r.stats.erasedInProgress, 2, 'A Swim + C Music both 8% → erased'); // B slot 1 is null

  // T=710: slot 660-720 is 50/60 = 83% done → kept.
  r = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 710);
  assert.ok(r.assignments.A[1] && r.assignments.A[1]._pinned, '83%-done Swim kept');
  assert.strictEqual(r.stats.keptInProgress, 2, 'A Swim + C Music kept');

  // T=705: exactly 45/60 = 75% → the >= rule keeps it.
  r = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 705);
  assert.ok(r.assignments.A[1] && r.assignments.A[1]._pinned, 'exactly-75% block kept');
});

test('multi-slot block decided as ONE unit over the full span; stats count it once', () => {
  const divisions = { Div1: { bunks: ['A'] } };
  const divisionTimes = { Div1: [
    { startMin: 600, endMin: 660 },
    { startMin: 660, endMin: 720 },
    { startMin: 720, endMin: 780 },
  ] };
  // 2-slot special spanning 600-720 (head + continuation share _blockStart).
  const assignments = { A: [
    { _activity: 'Mega Swim', field: 'Pool', _blockStart: 600 },
    { _activity: 'Mega Swim', field: 'Pool', _blockStart: 600, continuation: true },
    { _activity: 'Art', field: 'Art Room' },
  ] };

  // T=690: block is 90/120 = 75% done → whole block kept (both slots).
  let r = rainySplitScheduleAt(assignments, divisionTimes, divisions, 690);
  assert.ok(r.assignments.A[0]._pinned && r.assignments.A[1]._pinned, 'whole spanned block kept');
  assert.strictEqual(r.stats.keptInProgress, 1, 'block counted once (continuation skipped)');
  assert.strictEqual(r.assignments.A[2], null, 'future Art erased');

  // T=660: block is 60/120 = 50% done → whole block erased, incl. the
  // continuation slot even though the head slot already fully elapsed.
  r = rainySplitScheduleAt(assignments, divisionTimes, divisions, 660);
  assert.strictEqual(r.assignments.A[0], null, 'spanned head erased with its block');
  assert.strictEqual(r.assignments.A[1], null, 'continuation erased with its block');
  assert.strictEqual(r.stats.erasedInProgress, 1, 'block counted once');
});

test('rotation credit follows the split with no special-case marker', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();

  // T=710 (Swim 83% → kept): counts keep Swim, lose the future blocks.
  const r = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 710);
  const counts = countRotation(r.assignments);
  assert.deepStrictEqual(counts.A, { Soccer: 1, Swim: 1 }, 'kept blocks still count');
  assert.deepStrictEqual(counts.B, { Basketball: 1 }, 'erased future blocks uncounted');

  // T=665 (Swim 8% → erased): Swim loses its credit too.
  const r2 = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 665);
  const counts2 = countRotation(r2.assignments);
  assert.deepStrictEqual(counts2.A, { Soccer: 1 }, 'under-75% in-progress block uncounted');
});

test('blocks with no resolvable time are left untouched', () => {
  const divisions = { Div1: { bunks: ['A'] } };
  const divisionTimes = { Div1: [] }; // no slot times at all
  const assignments = { A: [ { _activity: 'Mystery', field: 'Somewhere' } ] };
  const r = rainySplitScheduleAt(assignments, divisionTimes, divisions, 700);
  assert.ok(r.assignments.A[0] && !r.assignments.A[0]._pinned, 'entry untouched, not pinned');
  assert.strictEqual(r.stats.unknown, 1);
});

test('entry-level _startMin/_endMin used when division slot times are missing', () => {
  const divisions = { Div1: { bunks: ['A'] } };
  const divisionTimes = { Div1: [{}, {}] }; // slots exist but carry no times
  const assignments = { A: [
    { _activity: 'Morning Thing', field: 'X', _startMin: 600, _endMin: 660 },
    { _activity: 'Afternoon Thing', field: 'Y', _startMin: 800, _endMin: 860 },
  ] };
  const r = rainySplitScheduleAt(assignments, divisionTimes, divisions, 700);
  assert.ok(r.assignments.A[0]._pinned, 'past block (entry times) kept');
  assert.strictEqual(r.assignments.A[1], null, 'future block (entry times) erased');
});

test('cut-scoped generate: only post-cut unpinned slots are regen; pre-cut + pinned kept', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  // Simulate the state AFTER a split at 720 followed by the user pinning a
  // manual tile into a post-cut slot.
  const split = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 720);
  const sa = split.assignments;
  sa.A[2] = { _activity: 'Board Games', field: 'Rec Room', _pinned: true }; // user-pinned post-cut
  const { scope, regenTotal } = rainyBuildMidDayRegenScope(sa, divisionTimes, divisions, 720);

  // A: slots 0-1 pre-cut kept entries → keep; slot 2 pinned → keep; slot 3 → regen.
  assert.deepStrictEqual([...scope.A.regen].sort(), [3], 'only the unpinned post-cut slot regens');
  assert.deepStrictEqual(Object.keys(scope.A.keep).map(Number).sort(), [0, 1, 2], 'pre-cut + pinned post-cut kept');
  // B: slots 2,3 post-cut empty → regen; slot 1 pre-cut EMPTY → neither set.
  assert.deepStrictEqual([...scope.B.regen].sort(), [2, 3]);
  assert.ok(!(1 in scope.B.keep) && !scope.B.regen.has(1), 'empty pre-cut slot in neither set');
  // C (ends at 720): nothing post-cut.
  assert.strictEqual(scope.C.regen.size, 0);
  assert.strictEqual(regenTotal, 1 + 2, 'A:1 + B:2');
});

test('cut-scoped generate: solver blocks outside the regen set are dropped — empty pre-cut slots stay empty', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const split = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 720);
  const { scope } = rainyBuildMidDayRegenScope(split.assignments, divisionTimes, divisions, 720);

  // Model STEP 1: keeps re-inserted pinned, everything else null.
  const rebuilt = {};
  Object.keys(scope).forEach(bunk => {
    const n = (split.assignments[bunk] || []).length;
    const arr = new Array(n).fill(null);
    Object.keys(scope[bunk].keep).forEach(k => {
      arr[+k] = Object.assign({}, scope[bunk].keep[k], { _fixed: true, _pinned: true });
    });
    rebuilt[bunk] = arr;
  });

  // The skeleton emits a block for EVERY (bunk, slot) — incl. B's empty pre-cut slot 1.
  const blocks = [];
  ['A', 'B'].forEach(bunk => { for (let s = 0; s < 4; s++) blocks.push({ bunk, slots: [s] }); });
  const surviving = filterBlocksWithScope(blocks, rebuilt, scope);
  const keys = surviving.map(b => b.bunk + ':' + b.slots[0]).sort();

  // Without the slot-scope gate, B:1 (empty pre-cut) would survive and get
  // backfilled — rewriting history. With it, only post-cut slots fill.
  assert.deepStrictEqual(keys, ['A:2', 'A:3', 'B:2', 'B:3'], 'only post-cut slots are fillable');
});

test('cut-scoped generate: unpinned post-cut entries land in orig (no-blank fallback) and regen', () => {
  const divisions = { Div1: { bunks: ['A'] } };
  const divisionTimes = { Div1: [ { startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 } ] };
  // User hand-placed an UNPINNED tile after the cut — a Generate re-rolls it,
  // but its content is snapshotted for the no-blank fallback.
  const sa = { A: [
    { _activity: 'Soccer', field: 'Field 1', _pinned: true, _midDayPreserved: true },
    { _activity: 'Ping Pong', field: 'Rec Room' },
  ] };
  const { scope } = rainyBuildMidDayRegenScope(sa, divisionTimes, divisions, 630);
  assert.ok(scope.A.regen.has(1), 'unpinned post-cut entry is re-rolled');
  assert.strictEqual(scope.A.orig[1]._activity, 'Ping Pong', 'content snapshotted into orig');
  assert.ok(scope.A.keep[0]._midDayPreserved, 'kept straddle-pinned morning entry stays');
});

test('bunks outside the passed divisions are never scanned or returned; input not mutated', () => {
  const { divisions, divisionTimes, scheduleAssignments } = fixture();
  const before = JSON.parse(JSON.stringify(scheduleAssignments));
  const r = rainySplitScheduleAt(scheduleAssignments, divisionTimes, divisions, 665);

  assert.ok(!('Ghost' in r.assignments), 'unknown bunk not in result');
  assert.deepStrictEqual(scheduleAssignments, before, 'input assignments untouched (pure)');

  // Role-clamped divisions (scheduler for Div1 only): Div2 bunks untouched.
  const clamped = rainySplitScheduleAt(scheduleAssignments, divisionTimes, { Div1: divisions.Div1 }, 665);
  assert.ok(!('C' in clamped.assignments), 'clamped-out division bunk not returned');
});
