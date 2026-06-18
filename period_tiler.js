
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
    var bestRank = null;

    // Rank a candidate layout. Lower is better, compared field-by-field:
    //   bucket: 0 = perfect tile (no leftover), 1 = sport-fillable leftover
    //           (>= minSportDMin), 2 = leaves an unfillable sliver.
    //   For an unsolvable bucket (2) we then minimize the wasted sliver.
    //   Finally, among otherwise-equal layouts, minimize how far pieces were
    //   shifted from their configured starts (least disruption wins). This
    //   replaces the old logic, which accepted the LAST ok permutation seen and
    //   so could pick a heavily-shifted layout over an equivalent zero-shift one.
    function _rankOf(ok, leftover, shiftDist) {
      var bucket = ok ? (leftover === 0 ? 0 : 1) : 2;
      return { bucket: bucket, leftover: leftover, shiftDist: shiftDist };
    }
    function _isBetter(a, b) {
      if (!b) return true;
      if (a.bucket !== b.bucket) return a.bucket < b.bucket;
      if (a.bucket === 2 && a.leftover !== b.leftover) return a.leftover < b.leftover;
      return a.shiftDist < b.shiftDist;
    }

    function tryPermutation(perm) {
      // All items in display order = fixed (in their configured order) merged with perm.
      // For simplicity, we place fixed items at their configured starts and slot movable
      // items into the remaining gaps. Then we expand durations within [dMin..dMax] to
      // close leftover.

      // 1. Build a timeline of fixed items (sorted by start). Reject if any fixed item
      //    overlaps the period boundary or another fixed item.
      //    ★ A fixed item's footprint is its REAL duration (configuredDur), not dMin.
      //    Using dMin here let a block longer than its dMin overflow the period
      //    boundary or overlap its neighbour while the gap math (which uses
      //    configuredDur) silently disagreed — producing layouts that ran past
      //    the period end. Measure both checks by the same footprint as the gaps.
      var fixedSorted = _sortBy(fixed, 'configuredStart');
      var _foot = function (x) { return (x.configuredDur != null ? x.configuredDur : x.dMin); };
      for (var i = 0; i < fixedSorted.length; i++) {
        var f = fixedSorted[i];
        if (f.configuredStart < period.startMin || f.configuredStart + _foot(f) > period.endMin) return;
        if (i > 0 && fixedSorted[i].configuredStart < fixedSorted[i - 1].configuredStart + _foot(fixedSorted[i - 1])) return;
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

      var rank = _rankOf(ok, leftover, shiftDist);
      if (_isBetter(rank, bestRank)) {
        bestLayout = placements;
        bestLeftover = leftover;
        bestShiftDist = shiftDist;
        bestRank = rank;
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
              periodStart: period.startMin,
              periodEnd: period.endMin,
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
    if (typeof console !== 'undefined' && console.log) {
      console.log('[PeriodTiler P1] Smoke tests:', allPass ? 'PASS' : 'FAIL');
      results.forEach(function (r) {
        console.log('  - ' + r.name + ': ' + (r.pass ? 'OK' : 'FAIL'),
          'shifts=', r.shifts, 'unsolvable=', r.unsolvable);
      });
    }
    return { allPass: allPass, results: results };
  }

  // ─────────────────────────────────────────────────────────────
  // fitBunkRegion — per-bunk "fit math" + region packing.
  //
  // The human scheduler's loop for the davening→wall gap (e.g. 11:50→2:20):
  //   region = wall_start - davening_end                       (150 min)
  //   budget = region - sum(windowed fixed walls: Morning 40, Lunch 20)  (90)
  //   pick the specials this bunk is DUE for, at their CONFIGURED durations,
  //   so they sum to the budget; place everything so it abuts (zero slivers),
  //   honouring each wall's window and NEVER resizing a configured duration.
  //
  // Verdict (the "math that makes sure it fits"):
  //   'fit'   sum(due) == budget   → place all, no slack
  //   'slack' sum(due) <  budget   → place all; leftover is a sport (>= floor,
  //                                  if allowed) / an extra due pick / honest gap
  //   'over'  sum(due) >  budget   → can't fit all at their real durations; keep
  //                                  highest-priority until budget, DEFER the rest
  //                                  and report them — never shrink a special
  //
  // Non-greedy: it keeps the slack as ONE consolidated block rather than
  // scattering pieces, so shared fields/time stay open for the other bunks to
  // tile their own regions (the cross-bunk layer aligns those shared blocks).
  //
  // INPUT:
  //   { regionStart, regionEnd,
  //     walls: [{ name, dur, earliestStart, latestStart }],   // windowed fixed walls
  //     due:   [{ name, dur, priority }],                     // higher priority kept first
  //     minSportDMin = 25, sportsAllowed = false, gridStep = 5 }
  //
  // OUTPUT:
  //   { verdict, region, budget, dueTotal, slackMin,
  //     layout: [{ name, kind, start, end, dur }],            // contiguous, sorted
  //     placed: [name...], unplaced: [name...], debug }
  // ─────────────────────────────────────────────────────────────
  function fitBunkRegion(input) {
    var S = input.regionStart, E = input.regionEnd;
    var region = Math.max(0, E - S);
    var minSport = input.minSportDMin != null ? input.minSportDMin : 25;
    var sportsAllowed = !!input.sportsAllowed;

    var walls = (input.walls || []).map(function (w) {
      return {
        name: w.name, dur: w.dur, kind: 'wall',
        es: (w.earliestStart != null ? w.earliestStart : S),
        ls: (w.latestStart != null ? w.latestStart : (E - w.dur))
      };
    });
    var wallTotal = walls.reduce(function (s, w) { return s + w.dur; }, 0);
    var budget = region - wallTotal;

    var due = (input.due || []).map(function (d) {
      return { name: d.name, dur: d.dur, priority: (d.priority != null ? d.priority : 0) };
    });
    var dueTotal = due.reduce(function (s, d) { return s + d.dur; }, 0);

    // ── Verdict + selection ──
    var verdict, selected = [], unplaced = [];
    if (budget < 0) {
      verdict = 'over';                 // walls alone overflow — structurally infeasible
      due.forEach(function (d) { unplaced.push(d.name); });
    } else if (dueTotal === budget) {
      verdict = 'fit'; selected = due.slice();
    } else if (dueTotal < budget) {
      verdict = 'slack'; selected = due.slice();
    } else {
      verdict = 'over';                 // keep highest-priority until budget; defer the rest
      var byPri = due.slice().sort(function (a, b) { return b.priority - a.priority; });
      var running = 0;
      byPri.forEach(function (d) {
        if (running + d.dur <= budget) { selected.push(d); running += d.dur; }
        else unplaced.push(d.name);
      });
    }

    var selTotal = selected.reduce(function (s, d) { return s + d.dur; }, 0);
    var slackMin = Math.max(0, budget - selTotal);

    // ── Build the piece set to pack (sums to the region exactly when budget>=0) ──
    var pieces = [];
    walls.forEach(function (w) { pieces.push({ name: w.name, dur: w.dur, kind: 'wall', es: w.es, ls: w.ls }); });
    selected.forEach(function (d) { pieces.push({ name: d.name, dur: d.dur, kind: 'special', es: S, ls: E - d.dur }); });
    if (slackMin > 0) {
      var slackKind = (sportsAllowed && slackMin >= minSport) ? 'sport' : 'gap';
      pieces.push({ name: slackKind === 'sport' ? 'Sport' : 'Free', dur: slackMin, kind: slackKind, es: S, ls: E - slackMin, _slack: true });
    }

    // ── Pack: place an ordering left-to-right from S; a wall clamps to its
    //    window. Score by (least gap+overflow), then least wall shift. Try all
    //    orderings (<=7 pieces) else a single greedy walls-by-deadline order. ──
    var best = null;
    function tryOrder(order) {
      var cursor = S, lay = [], internalGap = 0, shift = 0, okOrder = true;
      for (var i = 0; i < order.length; i++) {
        var p = order[i], start = cursor;
        if (p.kind === 'wall') {
          if (cursor < p.es) { internalGap += (p.es - cursor); start = p.es; }
          if (start > p.ls) { okOrder = false; break; }
          shift += Math.abs(start - p.es);
        }
        var end = start + p.dur;
        if (end > E) { okOrder = false; break; }
        lay.push({ name: p.name, kind: p.kind, start: start, end: end, dur: p.dur, _slack: !!p._slack });
        cursor = end;
      }
      if (!okOrder) return;
      var totalGap = internalGap + (E - cursor);
      if (!best || totalGap < best.totalGap || (totalGap === best.totalGap && shift < best.shift)) {
        best = { layout: lay, totalGap: totalGap, shift: shift };
      }
    }
    if (pieces.length <= 7) {
      _permute(pieces, [], tryOrder);
    } else {
      tryOrder(pieces.slice().sort(function (a, b) {
        return (a.kind === 'wall' ? a.ls : Infinity) - (b.kind === 'wall' ? b.ls : Infinity);
      }));
    }

    var layout = best ? best.layout.slice().sort(function (a, b) { return a.start - b.start; }) : [];
    return {
      verdict: verdict, region: region, budget: budget, dueTotal: dueTotal, slackMin: slackMin,
      layout: layout,
      placed: selected.map(function (d) { return d.name; }),
      unplaced: unplaced,
      debug: { wallTotal: wallTotal, selTotal: selTotal, gap: best ? best.totalGap : null, pieceCount: pieces.length }
    };
  }

  // ─────────────────────────────────────────────────────────────
  // packBunkDay — whole-day duration-first packer (the user's "math" model)
  //
  // Movability is DERIVED, never hardcoded: each anchor carries its configured
  // window [winStart,winEnd]; slack = winEnd - winStart - dur. slack<=0 ⇒ PINNED
  // (a fixed checkpoint: swim/Main Activity in a tight-window camp); slack>0 ⇒
  // it slides to abut its neighbour (lunch/Davening/Morning Activity). The same
  // rule fits ANY camp — widen a layer's window and that piece becomes slidable.
  //
  // The packer sweeps left from dayStart: it abuts pieces with no gaps, slides
  // each anchor as early as its window allows, and FILLS the run before each
  // anchor (and the tail) from a candidate pool of specials chosen by best-fit
  // (exact-to-target first, then largest, then most-rotation-due). Existing
  // specials are preferred (already rotation-validated); a wasteful small filler
  // that isn't needed for an exact landing is simply not chosen → dropped. The
  // only leftover is the sub-smallest-activity remainder, which lands against
  // the next PINNED checkpoint (e.g. the 5 min before a pinned Main Activity).
  //
  // INPUT:
  //   { dayStart, dayEnd, minFill = 10,
  //     anchors:          [{ id, name, dur, winStart, winEnd, pinned, kind }],
  //     existingSpecials: [{ id, name, dur, score }],   // currently placed; kept-preferred
  //     pool:             [{ name, dur, score }] }       // eligible specials to ADD
  // OUTPUT:
  //   { placements: [{ name, start, end, dur, kind, anchor?, pinned?, fromPool?, id? }],
  //     dropped: [name...], added: [name...], residualMin }
  // ─────────────────────────────────────────────────────────────
  function packBunkDay(input) {
    var dayStart = input.dayStart, dayEnd = input.dayEnd;
    var minFill = (input.minFill != null) ? input.minFill : 10;
    var anchors = (input.anchors || []).slice().sort(function (a, b) {
      var as = (a.winStart != null ? a.winStart : dayStart), bs = (b.winStart != null ? b.winStart : dayStart);
      return (as - bs) || (a.dur - b.dur);
    });
    var _k = function (s) { return String(s == null ? '' : s).toLowerCase().trim(); };

    // Candidate specials: existing first (preferred), then pool; dedup by name.
    var cand = [], seen = {};
    (input.existingSpecials || []).forEach(function (s) { var k = _k(s.name); if (!seen[k] && s.dur > 0) { seen[k] = 1; cand.push({ name: s.name, dur: s.dur, score: s.score || 0, existing: true, id: s.id }); } });
    (input.pool || []).forEach(function (s) { var k = _k(s.name); if (!seen[k] && s.dur > 0) { seen[k] = 1; cand.push({ name: s.name, dur: s.dur, score: s.score || 0, existing: false }); } });

    var used = {};
    // Fill specials forward from `cursor` toward `targetEnd` (don't overshoot it
    // by choice), never letting a piece run past `hardEnd`. Best-fit per step.
    function takeFill(targetEnd, hardEnd, cursor) {
      var out = [], guard = 0;
      while (guard++ < 80) {
        if (cursor >= targetEnd) break;
        var spaceHard = hardEnd - cursor;
        if (spaceHard < minFill) break;
        var need = targetEnd - cursor;
        var avail = cand.filter(function (c) { return !used[_k(c.name)] && c.dur <= spaceHard; });
        if (!avail.length) break;
        avail.sort(function (a, b) {
          var ae = (a.dur === need) ? 1 : 0, be = (b.dur === need) ? 1 : 0;   // exact landing first
          if (ae !== be) return be - ae;
          if (a.dur !== b.dur) return b.dur - a.dur;                          // then largest
          return (a.score || 0) - (b.score || 0);                            // then most-due
        });
        var pick = avail[0];
        used[_k(pick.name)] = 1; out.push(pick); cursor += pick.dur;
      }
      return { fills: out, cursor: cursor };
    }

    var placements = [], cursor = dayStart, residual = 0;
    function emitFills(fills) {
      fills.forEach(function (f) {
        placements.push({ name: f.name, start: cursor, end: cursor + f.dur, dur: f.dur, kind: 'special', fromPool: !f.existing, id: f.id });
        cursor += f.dur;
      });
    }

    for (var i = 0; i < anchors.length; i++) {
      var A = anchors[i];
      var ws = (A.winStart != null) ? A.winStart : dayStart;
      var we = (A.winEnd != null) ? A.winEnd : dayEnd;
      var latest = Math.max(ws, we - A.dur);
      if (cursor < ws) { var r = takeFill(ws, latest, cursor); emitFills(r.fills); }
      if (cursor < ws) { residual += (ws - cursor); cursor = ws; }   // unfillable gap before the anchor
      if (cursor > latest) cursor = latest;
      placements.push({ name: A.name, start: cursor, end: cursor + A.dur, dur: A.dur, kind: A.kind || 'anchor', anchor: true, pinned: !!A.pinned, id: A.id });
      cursor = cursor + A.dur;
    }
    var t = takeFill(dayEnd, dayEnd, cursor); emitFills(t.fills);
    if (cursor < dayEnd) residual += (dayEnd - cursor);

    var dropped = (input.existingSpecials || []).filter(function (s) { return !used[_k(s.name)]; }).map(function (s) { return s.name; });
    var added = placements.filter(function (p) { return p.fromPool; }).map(function (p) { return p.name; });
    placements.sort(function (a, b) { return a.start - b.start; });
    return { placements: placements, dropped: dropped, added: added, residualMin: residual };
  }

  // Expose API
  var api = {
    tileBunkDay: tileBunkDay,
    tilePeriod: tilePeriod,
    fitBunkRegion: fitBunkRegion,
    packBunkDay: packBunkDay,
    _smokeTest: _smokeTest
  };
  if (typeof window !== 'undefined') {
    window.PeriodTiler = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  // Auto-run smoke test on load (only logs; no side effects)
  try {
    if (typeof window !== 'undefined' && window.location && /[?&]tilerSmoke=1/.test(window.location.search)) {
      _smokeTest();
    }
  } catch (e) {}
})();
