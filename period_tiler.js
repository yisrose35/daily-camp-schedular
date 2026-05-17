/**
 * period_tiler.js — Phase −0.5 PeriodTiler (P1: pure function only)
 * =================================================================
 *
 * The human scheduler doesn't place activities one at a time and accept the
 * leftover gap. They look at the whole period as a packing puzzle:
 *
 *   "I've got 14:45–15:35 (50 min). Inhabitants: Shiur (20–30 min flex),
 *    Popcorn (10 min fixed), one sport (≥25 min). Solution:
 *    Shiur=20 + Sport=20... no, sport dMin is 25. So Shiur=20 + Popcorn=10 +
 *    Sport=20 doesn't fit. Try Popcorn at the wall: 14:45–14:55 Popcorn,
 *    14:55–15:25 Shiur (30 min), 15:25–15:35... 10 min hole. Try again:
 *    14:45–15:15 Shiur (30), 15:15–15:25 Popcorn, 15:25–15:35... no good.
 *    OK: 14:45–15:10 Sport (25), 15:10–15:30 Shiur (20), 15:30–15:35 Popcorn?
 *    Popcorn is 10 min not 5. Shift Popcorn earliest start to abut Shiur."
 *
 * The solver today treats configured start times as pins. The tiler treats
 * them as DEFAULTS with a flex window, and runs a real packing solver.
 *
 * STATUS: P1 — pure function + smoke test. Not wired into pipeline yet.
 *   - tileBunkDay(input) → { shifts, unsolvableSlivers, debug }
 *   - No mutation of window state.
 *   - Used by Phase −0.5 in P2 (next step).
 *
 * INPUT SHAPE (everything the tiler needs, nothing more):
 *
 *   {
 *     bunk: 'Duetos 1',
 *     grade: 'Duetos',
 *     periods: [{ startMin, endMin, name }, ...],     // bell schedule for this grade
 *     inhabitants: [                                  // activities planned in this day
 *       { name, configuredStart, configuredEnd,
 *         dMin, dMax,                                  // duration flex
 *         earliestStart, latestStart,                  // start-time flex window
 *         kind: 'anchor'|'sport'|'special'|'swim'|'change'|'lunch',
 *         isMovable: true|false,                       // can we shift its start?
 *         isResizable: true|false }                    // can we change its dur?
 *     ],
 *     minSportDMin: 25                                 // any leftover < this is a SLIVER
 *   }
 *
 * OUTPUT SHAPE:
 *
 *   {
 *     shifts: [                                       // changes to apply at Phase 0
 *       { name, oldStart, newStart, oldDur, newDur, reason }
 *     ],
 *     unsolvableSlivers: [                            // periods that still have slivers
 *       { period, sliverStart, sliverDur, why }
 *     ],
 *     debug: { perPeriod: [...] }
 *   }
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  function _clone(o) { return JSON.parse(JSON.stringify(o)); }

  function _inPeriod(item, period) {
    // An item belongs to a period if its configured start is inside it.
    return item.configuredStart >= period.startMin &&
           item.configuredStart <  period.endMin;
  }

  function _sortBy(arr, key) {
    return arr.slice().sort(function (a, b) { return a[key] - b[key]; });
  }

  /**
   * Try to tile a single period. Returns either:
   *   { ok: true, layout: [{name, start, end, dur}], leftover: number }
   * or
   *   { ok: false, why: '...', leftover: number, layout: best-effort }
   *
   * Algorithm:
   *   1. Sort inhabitants by isMovable=false first (fixed walls), then by earliestStart.
   *   2. Try EACH permutation of movable inhabitants (capped at 8! = 40320; we
   *      bail to a heuristic if more than 6 movable items).
   *   3. For each permutation, try DURATION assignments greedily (dMin first,
   *      then expand toward dMax to absorb leftover).
   *   4. A layout is VALID if it tiles the period with leftover==0, OR
   *      leftover >= minSportDMin (a sport can fill it later).
   *   5. Best layout = one with leftover==0; tie-break by minimal total shift
   *      distance from configured starts.
   */
  function tilePeriod(period, inhabitants, minSportDMin) {
    var periodDur = period.endMin - period.startMin;
    var debug = { period: period.name, periodDur: periodDur, inhabCount: inhabitants.length };

    if (inhabitants.length === 0) {
      return { ok: true, layout: [], leftover: periodDur, debug: debug };
    }

    // Split immovable from movable.
    var fixed = inhabitants.filter(function (x) { return !x.isMovable; });
    var movable = inhabitants.filter(function (x) { return x.isMovable; });

    // Too many movable items? Fall back to greedy. (Real schedules rarely have > 5.)
    if (movable.length > 6) {
      return _greedyTile(period, inhabitants, minSportDMin, debug);
    }

    var bestLayout = null;
    var bestLeftover = -1;
    var bestShiftDist = Infinity;

    function tryPermutation(perm) {
      // All items in display order = fixed (in their configured order) merged with perm.
      // For simplicity, we place fixed items at their configured starts and slot movable
      // items into the remaining gaps. Then we expand durations within [dMin..dMax] to
      // close leftover.

      // 1. Build a timeline of fixed items (sorted by start). Reject if any fixed item
      //    overlaps the period boundary or another fixed item.
      var fixedSorted = _sortBy(fixed, 'configuredStart');
      for (var i = 0; i < fixedSorted.length; i++) {
        var f = fixedSorted[i];
        if (f.configuredStart < period.startMin || f.configuredStart + f.dMin > period.endMin) return;
        if (i > 0 && fixedSorted[i].configuredStart < fixedSorted[i - 1].configuredStart + fixedSorted[i - 1].dMin) return;
      }

      // 2. Compute the gaps between fixed items (within the period).
      var gaps = [];
      var cursor = period.startMin;
      for (var i = 0; i < fixedSorted.length; i++) {
        var f = fixedSorted[i];
        if (f.configuredStart > cursor) gaps.push({ start: cursor, end: f.configuredStart });
        cursor = f.configuredStart + (f.configuredDur || f.dMin);
      }
      if (cursor < period.endMin) gaps.push({ start: cursor, end: period.endMin });

      // 3. Walk perm in order, placing each movable item into the next gap that fits.
      var placements = fixedSorted.map(function (f) {
        return { name: f.name, start: f.configuredStart, end: f.configuredStart + (f.configuredDur || f.dMin), dur: (f.configuredDur || f.dMin), ref: f };
      });
      var gIdx = 0;
      var gCursor = gaps.length ? gaps[0].start : null;

      for (var j = 0; j < perm.length; j++) {
        var m = perm[j];
        // Find the next gap that can hold m.dMin
        while (gIdx < gaps.length) {
          var g = gaps[gIdx];
          var avail = g.end - gCursor;
          if (avail >= m.dMin) break;
          // skip this gap (leftover < dMin → sliver candidate)
          gIdx++;
          if (gIdx < gaps.length) gCursor = gaps[gIdx].start;
        }
        if (gIdx >= gaps.length) return; // can't place

        // Place at gCursor with dMin; we'll expand later.
        var place = { name: m.name, start: gCursor, end: gCursor + m.dMin, dur: m.dMin, ref: m };

        // Honor earliestStart/latestStart if defined
        if (m.earliestStart != null && place.start < m.earliestStart) {
          place.start = m.earliestStart;
          place.end = place.start + m.dMin;
        }
        if (m.latestStart != null && place.start > m.latestStart) return;
        if (place.end > gaps[gIdx].end) return;

        placements.push(place);
        gCursor = place.end;
      }

      // 4. Sort placements by start, compute total leftover.
      placements.sort(function (a, b) { return a.start - b.start; });
      var totalDur = placements.reduce(function (s, p) { return s + p.dur; }, 0);
      var leftover = periodDur - totalDur;

      // 5. Try to grow movable durations to close leftover, respecting dMax.
      if (leftover > 0) {
        for (var k = 0; k < placements.length && leftover > 0; k++) {
          var p = placements[k];
          if (!p.ref.isResizable) continue;
          var room = (p.ref.dMax || p.dur) - p.dur;
          if (room <= 0) continue;
          // Also limited by gap to next placement
          var nextStart = (k + 1 < placements.length) ? placements[k + 1].start : period.endMin;
          var roomNext = nextStart - p.end;
          var grow = Math.min(room, roomNext, leftover);
          if (grow > 0) {
            p.dur += grow;
            p.end += grow;
            leftover -= grow;
            // Shift everything after by 0 (we grew into existing space; the
            // sliver was between p.end and nextStart already).
          }
        }
      }

      // 6. Final leftover: if 0 OR >= minSportDMin → ok.
      var ok = (leftover === 0) || (leftover >= minSportDMin);

      // 7. Compute shift distance for tie-breaking.
      var shiftDist = 0;
      placements.forEach(function (p) {
        if (p.ref && p.ref.configuredStart != null) {
          shiftDist += Math.abs(p.start - p.ref.configuredStart);
        }
      });

      var betterLeftover = false;
      if (ok && bestLeftover !== 0) betterLeftover = true;       // prefer ok solutions
      else if (ok && leftover === 0 && bestLeftover !== 0) betterLeftover = true;
      else if (ok && leftover === bestLeftover && shiftDist < bestShiftDist) betterLeftover = true;
      else if (!bestLayout) betterLeftover = true;

      if (betterLeftover) {
        bestLayout = placements;
        bestLeftover = leftover;
        bestShiftDist = shiftDist;
      }
    }

    // Generate permutations of movable
    _permute(movable, [], tryPermutation);

    if (!bestLayout) {
      return { ok: false, why: 'no valid permutation', leftover: periodDur, layout: [], debug: debug };
    }
    debug.bestLeftover = bestLeftover;
    debug.bestShiftDist = bestShiftDist;
    return { ok: (bestLeftover === 0 || bestLeftover >= minSportDMin), layout: bestLayout, leftover: bestLeftover, debug: debug };
  }

  function _permute(arr, prefix, cb) {
    if (arr.length === 0) { cb(prefix); return; }
    for (var i = 0; i < arr.length; i++) {
      var rest = arr.slice(0, i).concat(arr.slice(i + 1));
      _permute(rest, prefix.concat([arr[i]]), cb);
    }
  }

  function _greedyTile(period, inhabitants, minSportDMin, debug) {
    // Fallback: place everything at configured starts, no shifts. Just report leftover.
    var sorted = _sortBy(inhabitants, 'configuredStart');
    var placements = sorted.map(function (x) {
      return { name: x.name, start: x.configuredStart, end: x.configuredStart + (x.configuredDur || x.dMin), dur: (x.configuredDur || x.dMin), ref: x };
    });
    var totalDur = placements.reduce(function (s, p) { return s + p.dur; }, 0);
    var leftover = (period.endMin - period.startMin) - totalDur;
    debug.greedy = true;
    return { ok: (leftover === 0 || leftover >= minSportDMin), layout: placements, leftover: leftover, debug: debug };
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  function tileBunkDay(input) {
    var periods = input.periods || [];
    var inhabitants = input.inhabitants || [];
    var minSportDMin = input.minSportDMin || 25;

    var shifts = [];
    var unsolvableSlivers = [];
    var perPeriodDebug = [];

    for (var pi = 0; pi < periods.length; pi++) {
      var period = periods[pi];
      var inPeriod = inhabitants.filter(function (x) { return _inPeriod(x, period); });
      var result = tilePeriod(period, inPeriod, minSportDMin);
      perPeriodDebug.push({ period: period.name, result: result });

      // Emit shifts: any layout placement whose start/dur differs from configured.
      if (result.layout) {
        result.layout.forEach(function (p) {
          var ref = p.ref;
          if (!ref) return;
          var oldStart = ref.configuredStart;
          var oldDur = ref.configuredDur || ref.dMin;
          if (p.start !== oldStart || p.dur !== oldDur) {
            shifts.push({
              name: ref.name,
              bunk: input.bunk,
              period: period.name,
              oldStart: oldStart,
              newStart: p.start,
              oldDur: oldDur,
              newDur: p.dur,
              reason: 'period-tile'
            });
          }
        });
      }

      if (!result.ok) {
        unsolvableSlivers.push({
          period: period.name,
          sliverStart: period.startMin,
          sliverDur: result.leftover,
          why: result.why || ('leftover=' + result.leftover + ' < minSportDMin=' + minSportDMin)
        });
      }
    }

    return {
      shifts: shifts,
      unsolvableSlivers: unsolvableSlivers,
      debug: { perPeriod: perPeriodDebug, bunk: input.bunk }
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Smoke tests — run on load, log results. P1 verification.
  // ─────────────────────────────────────────────────────────────

  function _smokeTest() {
    var results = [];

    // Fixture 1: SOLVABLE — period has room for shift to eliminate sliver.
    // 60-min period, Shiur(20-30 flex) configured 885-905, Popcorn(10 fixed)
    // configured 935-945. Configured leaves 905-935 = 30-min gap (sport-fillable)
    // and 945-945 = 0. After grow Shiur to 30: Shiur 885-915, Popcorn 935-945,
    // leftover = 915-935 = 20-min sliver! Tiler should INSTEAD keep Shiur at 20,
    // shift Popcorn to 935 (already there), leaving 905-935 = 30 (>=25 ✓).
    var f1 = {
      bunk: 'TestDuetos1',
      grade: 'Duetos',
      periods: [{ startMin: 885, endMin: 945, name: 'P7' }],
      inhabitants: [
        { name: 'Shiur1', kind: 'special', configuredStart: 885, configuredDur: 20,
          dMin: 20, dMax: 30, earliestStart: 885, latestStart: 885,
          isMovable: false, isResizable: true },
        { name: 'Popcorn', kind: 'anchor', configuredStart: 935, configuredDur: 10,
          dMin: 10, dMax: 10, earliestStart: 895, latestStart: 935,
          isMovable: true, isResizable: false }
      ],
      minSportDMin: 25
    };
    var r1 = tileBunkDay(f1);
    results.push({
      name: 'Duetos 15:25 sliver',
      shifts: r1.shifts,
      unsolvable: r1.unsolvableSlivers,
      pass: r1.unsolvableSlivers.length === 0
    });

    // Fixture 2: SOLVABLE — 50-min period containing Slush(10-20 flex) only.
    // Configured 760-770 leaves 750-760 (10 sliver) + 770-800 (30 sport-ok).
    // Tiler should shift Slush to 750 grown to 20 → ends 770 → leftover 770-800
    // = 30 ≥ 25 ✓.
    var f2 = {
      bunk: 'TestSoloists1',
      grade: 'Soloists',
      periods: [{ startMin: 750, endMin: 800, name: 'P-pre-lunch' }],
      inhabitants: [
        { name: 'Slush', kind: 'anchor', configuredStart: 760, configuredDur: 10,
          dMin: 10, dMax: 20, earliestStart: 750, latestStart: 770,
          isMovable: true, isResizable: true }
      ],
      minSportDMin: 25
    };
    var r2 = tileBunkDay(f2);
    results.push({
      name: 'Soloists 12:50 sliver',
      shifts: r2.shifts,
      unsolvable: r2.unsolvableSlivers,
      pass: r2.unsolvableSlivers.length === 0
    });

    // Fixture 3: Trios 15:25 (same shape as Duetos)
    var f3 = _clone(f1);
    f3.bunk = 'TestTrios4';
    f3.grade = 'Trios';
    f3.inhabitants[0].name = 'Shiur2';
    f3.inhabitants[1].name = 'Slush';
    var r3 = tileBunkDay(f3);
    results.push({
      name: 'Trios 15:25 sliver',
      shifts: r3.shifts,
      unsolvable: r3.unsolvableSlivers,
      pass: r3.unsolvableSlivers.length === 0
    });

    var allPass = results.every(function (r) { return r.pass; });
    if (window.console && console.log) {
      console.log('[PeriodTiler P1] Smoke tests:', allPass ? 'PASS' : 'FAIL');
      results.forEach(function (r) {
        console.log('  - ' + r.name + ': ' + (r.pass ? 'OK' : 'FAIL'),
          'shifts=', r.shifts, 'unsolvable=', r.unsolvable);
      });
    }
    return { allPass: allPass, results: results };
  }

  // Expose API
  window.PeriodTiler = {
    tileBunkDay: tileBunkDay,
    tilePeriod: tilePeriod,
    _smokeTest: _smokeTest
  };

  // Auto-run smoke test on load (only logs; no side effects)
  try {
    if (window.location && /[?&]tilerSmoke=1/.test(window.location.search)) {
      _smokeTest();
    }
  } catch (e) {}
})();
