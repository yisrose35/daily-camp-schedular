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
