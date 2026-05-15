// =============================================================================
// scheduler_core_solver_v2.js — Solver v2 (greedy seed + simulated annealing)
// =============================================================================
// Skeleton for the Option-B re-architecture. See docs/SOLVER_V2_DESIGN.md for
// the full design.
//
// Lifecycle:
//   1. Entry: window.runAutoSchedulerV2(layers, options) — same signature as v1
//   2. Seed: delegate to v1 to produce an initial schedule (warm start)
//   3. Validate: compute cost = hard_violations*1e9 + holes*100 + repetition*30 + ...
//   4. SA loop until time budget (default 10s):
//        - Propose a random move (swap/replace/relocate/cross-swap/slide/inject)
//        - Evaluate ΔC = cost(new) - cost(current)
//        - Accept if ΔC < 0, else accept with prob exp(-ΔC/T)
//        - Cool T toward 0
//        - Track best-seen
//   5. Return best-seen + infeasibility report
//
// This file is intentionally a single self-contained skeleton — splitting into
// _seed/_cost/_moves/_history modules will happen after the SA loop is working
// end-to-end and we have a parity baseline against v1.
// =============================================================================

(function () {
  'use strict';

  const TAG = '[SolverV2]';
  const log  = (msg, ...args) => console.log(TAG + ' ' + msg, ...args);
  const warn = (msg, ...args) => console.warn(TAG + ' ' + msg, ...args);

  // -------------------------------------------------------------------------
  // CONFIG (overridable via globalSettings.app1.solverV2*)
  // -------------------------------------------------------------------------
  function getConfig() {
    const g = window.loadGlobalSettings?.() || {};
    const a1 = g.app1 || {};
    return {
      timeBudgetMs: parseInt(a1.solverV2TimeBudgetMs) || 10000,
      tempStart:    parseFloat(a1.solverV2TempStart)   || 100,
      tempEnd:      parseFloat(a1.solverV2TempEnd)     || 0.1,
      kickAfter:    parseInt(a1.solverV2KickAfter)     || 500,    // stall threshold for re-randomize
      kickSize:     parseInt(a1.solverV2KickSize)      || 5,      // # slots to randomize per kick
      seed:         parseInt(a1.solverV2Seed)          || Date.now(),
      cost: {
        hardViolation:   parseFloat(a1.solverV2CostHardViolation)   || 1e9,
        hole:            parseFloat(a1.solverV2CostHole)            || 100,
        sameDayRepeat:   parseFloat(a1.solverV2CostSameDayRepeat)   || 30,
        rotationUnfair:  parseFloat(a1.solverV2CostRotationUnfair)  || 20,
        wallClockGapMin: parseFloat(a1.solverV2CostWallClockGapMin) || 1
      }
    };
  }

  // -------------------------------------------------------------------------
  // SEED — warm-start from v1's existing pipeline
  // -------------------------------------------------------------------------
  // Reuses v1 so we get all the camp setup, layer parsing, pinned blocks,
  // rotation history, league fixtures, etc. without re-implementing them.
  // The v1 result is the *starting point* for SA, not the final answer.
  async function buildSeed(layers, options) {
    if (typeof window._runAutoSchedulerV1 !== 'function') {
      throw new Error('SolverV2: v1 not available as seed source');
    }
    log('Building seed via v1 pipeline...');
    const seedResult = await window._runAutoSchedulerV1(layers, options);
    // The seed is now in window.scheduleAssignments. Deep-clone it so SA can
    // mutate without trashing the canonical state until we commit.
    const seed = structuredClone(window.scheduleAssignments || {});
    return { seed, seedResult };
  }

  // -------------------------------------------------------------------------
  // COST FUNCTION — the heart of the algorithm
  // -------------------------------------------------------------------------
  // Pure: same input always yields same cost. Validator collects hard
  // violations as a separate array so the caller can decide whether to
  // surface them as an infeasibility report.
  function evaluate(schedule, ctx) {
    const cfg = ctx.config;
    const hardViolations = [];
    let cost = 0;

    // Term 1: Hard violations (field caps, access, time rules, fullGrade, etc.)
    //         Delegate to v1's existing validators, which we know are correct.
    hardViolations.push(...detectHardViolations(schedule, ctx));
    cost += hardViolations.length * cfg.cost.hardViolation;

    // Term 2: Null buckets and Free slots — both are "no activity here."
    const holes = countHoles(schedule, ctx);
    cost += holes * cfg.cost.hole;

    // Term 3: Same-day repetition (excludes activities explicitly allowed to repeat)
    const repeats = countSameDayRepeats(schedule, ctx);
    cost += repeats * cfg.cost.sameDayRepeat;

    // Term 4: Rotation unfairness — deviation from ideal counts per (bunk, activity)
    const rotUnfair = computeRotationUnfairness(schedule, ctx);
    cost += rotUnfair * cfg.cost.rotationUnfair;

    // Term 5: Wall-clock gaps over 5 min (period transitions = free)
    const gapMin = countWallClockGapMinutes(schedule, ctx);
    cost += gapMin * cfg.cost.wallClockGapMin;

    return { cost, hardViolations, breakdown: { holes, repeats, rotUnfair, gapMin } };
  }

  // -------------------------------------------------------------------------
  // VALIDATORS (stubs — to be filled in Phase X2b)
  // -------------------------------------------------------------------------
  function detectHardViolations(schedule, ctx) {
    // TODO X2b: iterate all assignments and call v1's _validateWritePlacement
    // + rule check helpers. Returns an array of { bunk, idx, reason } objects.
    return [];
  }

  function countHoles(schedule, ctx) {
    let n = 0;
    const divisions = ctx.divisions;
    for (const [bunk, slots] of Object.entries(schedule)) {
      if (!Array.isArray(slots)) continue;
      let grade = null;
      for (const [d, info] of Object.entries(divisions)) {
        if ((info.bunks || []).includes(bunk)) { grade = d; break; }
      }
      const pbs = ctx.perBunkSlots?.[grade]?.[bunk] || [];
      for (let i = 0; i < pbs.length; i++) {
        const s = slots[i];
        if (!s) n++;
        else if (s.field === 'Free' || s._activity === 'Free') n++;
      }
    }
    return n;
  }

  function countSameDayRepeats(schedule, ctx) {
    let n = 0;
    const ignore = ctx.repetitionIgnoreSet;
    for (const slots of Object.values(schedule)) {
      if (!Array.isArray(slots)) continue;
      const seen = new Set();
      for (const s of slots) {
        if (!s || s.continuation || s.field === 'Free' || !s._activity) continue;
        if (s._pinned || s._league || s._autoSpecial || s._fixed) continue;
        const act = String(s._activity).toLowerCase().trim();
        if (!act || ignore.has(act)) continue;
        if (seen.has(act)) n++;
        else seen.add(act);
      }
    }
    return n;
  }

  function computeRotationUnfairness(schedule, ctx) {
    // TODO X2b: integrate with window.RotationEngine for per-bunk fairness scoring.
    // For now, return 0 — SA still optimizes the other terms while we develop this.
    return 0;
  }

  function countWallClockGapMinutes(schedule, ctx) {
    let minutes = 0;
    for (const slots of Object.values(schedule)) {
      if (!Array.isArray(slots)) continue;
      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null && s._endMin != null)
        .sort((a, b) => a._startMin - b._startMin);
      for (let i = 1; i < real.length; i++) {
        const gap = real[i]._startMin - real[i-1]._endMin;
        if (gap > 5) minutes += (gap - 5);
      }
    }
    return minutes;
  }

  // -------------------------------------------------------------------------
  // MOVE OPERATORS (stubs — to be filled in Phase X2d)
  // -------------------------------------------------------------------------
  // Each operator: takes current schedule + ctx, returns a NEW schedule with
  // one local change, or null if no valid move could be found this call.
  const MOVES = {
    swap:        function (schedule, ctx, rng) { return null; },
    replace:     function (schedule, ctx, rng) { return null; },
    relocate:    function (schedule, ctx, rng) { return null; },
    crossSwap:   function (schedule, ctx, rng) { return null; },
    slide:       function (schedule, ctx, rng) { return null; },
    inject:      function (schedule, ctx, rng) { return null; }
  };

  function pickMove(stats, rng) {
    // Weighted by recent acceptance rate; defaults to uniform until enough samples.
    const names = Object.keys(MOVES);
    // TODO X2d: use stats.acceptCount / stats.proposeCount per move type
    return names[Math.floor(rng() * names.length)];
  }

  // -------------------------------------------------------------------------
  // RNG — seeded so runs are reproducible
  // -------------------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -------------------------------------------------------------------------
  // SIMULATED ANNEALING LOOP
  // -------------------------------------------------------------------------
  function runSA(seed, ctx) {
    const cfg = ctx.config;
    const rng = mulberry32(cfg.seed);
    const deadline = Date.now() + cfg.timeBudgetMs;

    let current = seed;
    let currentEval = evaluate(current, ctx);
    let best = current;
    let bestEval = currentEval;

    const stats = {
      iterations: 0,
      moves: {},
      accepts: 0, rejects: 0,
      stallCount: 0,
      improvements: 0
    };
    Object.keys(MOVES).forEach(m => { stats.moves[m] = { propose: 0, accept: 0 }; });

    log('SA starting. Initial cost=' + currentEval.cost +
        ' (holes=' + currentEval.breakdown.holes +
        ', repeats=' + currentEval.breakdown.repeats +
        ', gapMin=' + currentEval.breakdown.gapMin +
        ', hardViol=' + currentEval.hardViolations.length + ')');

    while (Date.now() < deadline) {
      stats.iterations++;
      // Linear cooling schedule
      const progress = stats.iterations / 50000; // assumed iters cap
      const T = Math.max(cfg.tempEnd, cfg.tempStart * (1 - progress));

      const moveName = pickMove(stats, rng);
      stats.moves[moveName].propose++;
      const candidate = MOVES[moveName](current, ctx, rng);
      if (!candidate) continue; // move couldn't find a valid local change

      const candidateEval = evaluate(candidate, ctx);
      const dC = candidateEval.cost - currentEval.cost;

      let accept = false;
      if (dC < 0) accept = true;
      else if (Math.exp(-dC / T) > rng()) accept = true;

      if (accept) {
        current = candidate;
        currentEval = candidateEval;
        stats.accepts++;
        stats.moves[moveName].accept++;
        if (candidateEval.cost < bestEval.cost) {
          best = candidate;
          bestEval = candidateEval;
          stats.improvements++;
          stats.stallCount = 0;
        } else {
          stats.stallCount++;
        }
      } else {
        stats.rejects++;
        stats.stallCount++;
      }

      if (stats.stallCount >= cfg.kickAfter) {
        // Kick: small re-randomization to escape local minimum
        // TODO X2d: pick `kickSize` random slots and replace them
        stats.stallCount = 0;
      }
    }

    log('SA done. iters=' + stats.iterations +
        ' accepts=' + stats.accepts +
        ' improvements=' + stats.improvements +
        ' final_best_cost=' + bestEval.cost);

    return { best, bestEval, stats };
  }

  // -------------------------------------------------------------------------
  // PUBLIC ENTRY
  // -------------------------------------------------------------------------
  window.runAutoSchedulerV2 = async function (layers, options) {
    const cfg = getConfig();
    log('v2 entry. timeBudget=' + cfg.timeBudgetMs + 'ms');

    // Build the seed via v1
    const { seed, seedResult } = await buildSeed(layers, options);
    if (!seedResult?.success) {
      warn('v1 seed failed — returning v1 result as-is');
      return seedResult;
    }

    // Build the SA context (everything the validator + moves need to read,
    // but pre-computed once to avoid repeated work inside the hot loop).
    const ctx = buildContext(cfg, options);

    // Run SA
    const { best, bestEval, stats } = runSA(seed, ctx);

    // Commit the best schedule back to window.scheduleAssignments
    window.scheduleAssignments = best;

    // Save (delegate to v1's save path — TODO X2: extract this so v2 doesn't
    // depend on v1's whole gen lifecycle; for now we just trigger the same
    // save-on-generation-complete listeners by dispatching the event).
    window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
      detail: { mode: 'auto-v2', version: 'v2', elapsed: cfg.timeBudgetMs / 1000 }
    }));

    return {
      success: bestEval.hardViolations.length === 0,
      warnings: bestEval.hardViolations,
      cost: bestEval.cost,
      costBreakdown: bestEval.breakdown,
      saStats: stats,
      elapsed: cfg.timeBudgetMs / 1000
    };
  };

  function buildContext(config, options) {
    const g = window.loadGlobalSettings?.() || {};
    const divisions = window.divisions || {};
    const perBunkSlots = {};
    Object.keys(divisions).forEach(grade => {
      perBunkSlots[grade] = window.divisionTimes?.[grade]?._perBunkSlots || {};
    });

    // Activities that are exempt from same-day-repeat (configurable via global settings;
    // mirrors v1's CSWEEP_IGNORE_ACTS set).
    const ignore = new Set([
      'lunch', 'snack', 'snacks', 'swim', 'change', 'dismissal',
      'general activity slot', 'free'
    ]);

    return {
      config,
      divisions,
      perBunkSlots,
      fields: g.app1?.fields || g.fields || [],
      specials: g.specialActivities || [],
      allowedDivisions: options?.allowedDivisions || null,
      repetitionIgnoreSet: ignore
    };
  }

  log('scheduler_core_solver_v2.js loaded — skeleton ready (Phase X1)');
})();
