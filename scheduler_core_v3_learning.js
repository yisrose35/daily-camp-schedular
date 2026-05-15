// =============================================================================
// scheduler_core_v3_learning.js — Solver v3 Phase F: Self-learning
// =============================================================================
// After each v3 gen, record success metrics + per-move acceptance rates so the
// solver can adapt move-selection weights to what works for THIS specific camp
// config. Persisted to globalSettings.solverV3LearningData.
//
// Schema:
//   {
//     campId,
//     runs: number,                       // total v3 runs recorded
//     metrics: {                          // rolling averages
//       holes, gapMin, sigGaps, periodViol, swimNoChange, cost
//     },
//     moveSuccess: {                      // per-move proposed vs accepted
//       [moveName]: { proposed, accepted }
//     },
//     weightAdjustments: {                // multiplier applied to default weight
//       [moveName]: number
//     },
//     lastRunAt: timestamp
//   }
//
// Adaptation rule:
//   acceptanceRate = accepted / proposed
//   baseline      = global mean acceptanceRate across all moves
//   if rate > baseline * 1.5  -> bump weight ×1.2 (max ×3)
//   if rate < baseline * 0.5  -> dampen weight ×0.8 (min ×0.3)
//
// runAutoSchedulerV2 reads `ctx.config.moveWeights` if present, so v3 just
// injects the adjustments before calling SolverV2.runSA.
// =============================================================================
(function () {
  'use strict';

  const TAG = '[SolverV3:Learning]';
  const log = (msg, ...a) => console.log(TAG + ' ' + msg, ...a);

  // Maximum and minimum bounds for weight multipliers (prevents runaway).
  const WEIGHT_MAX = 3.0;
  const WEIGHT_MIN = 0.3;
  const BUMP   = 1.2;
  const DAMPEN = 0.8;

  /** Resolve a stable camp-id from globalSettings so learning is per-camp. */
  function _campId() {
    const g = window.loadGlobalSettings?.() || {};
    return g.app1?.campId || g.campId || g.campName || 'default';
  }

  /** Pull (or initialize) the learning blob for the active camp. */
  function loadData() {
    const g = window.loadGlobalSettings?.() || {};
    const all = g.solverV3LearningData || {};
    const id = _campId();
    if (!all[id]) {
      all[id] = {
        campId: id,
        runs: 0,
        metrics: { holes: 0, gapMin: 0, sigGaps: 0, periodViol: 0, swimNoChange: 0, cost: 0 },
        moveSuccess: {},
        weightAdjustments: {},
        lastRunAt: null
      };
    }
    return { all, data: all[id] };
  }

  function saveData(all) {
    const g = window.loadGlobalSettings?.() || {};
    g.solverV3LearningData = all;
    // Persist via app1 channel (existing save plumbing)
    if (typeof window.saveGlobalSettings === 'function') {
      window.saveGlobalSettings('solverV3LearningData', all);
    }
  }

  /**
   * Compute current weight multipliers for v3's SA call.
   * Returns an object { [moveName]: multiplier } for SolverV2.runSA to honor.
   * Move names match the keys in v2's pickMove stats (replace, swap, inject, ...).
   */
  function getWeightAdjustments() {
    const { data } = loadData();
    return Object.assign({}, data.weightAdjustments);
  }

  /**
   * Record a completed v3 run.
   * @param {Object} runResult — { cost, costBreakdown, saStats, elapsed }
   *   saStats expected shape: { byMove: { [name]: { proposed, accepted } }, ... }
   */
  function recordRun(runResult) {
    if (!runResult) return;
    const { all, data } = loadData();

    // 1. Rolling-average metrics (Welford-style: M_n = M_{n-1} + (x - M_{n-1})/n).
    const n = data.runs + 1;
    const bd = runResult.costBreakdown || {};
    const update = (key, val) => {
      const v = Number(val) || 0;
      data.metrics[key] = data.metrics[key] + (v - data.metrics[key]) / n;
    };
    update('holes',         bd.holes);
    update('gapMin',        bd.wallClockGap);
    update('sigGaps',       bd.sigGaps);
    update('periodViol',    bd.periodViolation);
    update('swimNoChange',  bd.swimNoChange);
    update('cost',          runResult.cost);

    // 2. Accumulate move-success counters.
    const byMove = runResult.saStats?.byMove || {};
    for (const [name, c] of Object.entries(byMove)) {
      if (!data.moveSuccess[name]) data.moveSuccess[name] = { proposed: 0, accepted: 0 };
      data.moveSuccess[name].proposed += (c.proposed || 0);
      data.moveSuccess[name].accepted += (c.accepted || 0);
    }

    // 3. Recompute weight adjustments based on cumulative acceptance rates.
    //    A move that gets accepted often is "working" for this camp.
    const rates = {};
    let rateSum = 0, rateCount = 0;
    for (const [name, c] of Object.entries(data.moveSuccess)) {
      if (c.proposed < 50) continue;   // ignore noise — need a sample
      const r = c.accepted / c.proposed;
      rates[name] = r;
      rateSum += r; rateCount++;
    }
    const baseline = rateCount > 0 ? rateSum / rateCount : 0;

    for (const [name, r] of Object.entries(rates)) {
      const current = data.weightAdjustments[name] || 1.0;
      let next = current;
      if (baseline > 0 && r > baseline * 1.5) next = Math.min(WEIGHT_MAX, current * BUMP);
      else if (baseline > 0 && r < baseline * 0.5) next = Math.max(WEIGHT_MIN, current * DAMPEN);
      data.weightAdjustments[name] = +next.toFixed(3);
    }

    data.runs = n;
    data.lastRunAt = Date.now();
    all[data.campId] = data;
    saveData(all);

    log('Recorded run ' + n + ' for camp "' + data.campId + '". ' +
        'cost=' + (runResult.cost ?? '?') +
        ', baseline rate=' + baseline.toFixed(3) +
        ', adjusted moves=' + Object.keys(data.weightAdjustments).length);
  }

  /** Wipe learning data for current camp (debug / re-baseline tool). */
  function reset() {
    const { all, data } = loadData();
    delete all[data.campId];
    saveData(all);
    log('Learning data reset for camp "' + data.campId + '"');
  }

  /** Diagnostic: dump current learning state to console. */
  function inspect() {
    const { data } = loadData();
    console.table(data.metrics);
    console.table(data.moveSuccess);
    console.table(data.weightAdjustments);
    return data;
  }

  window.SolverV3Learning = {
    recordRun,
    getWeightAdjustments,
    loadData: () => loadData().data,
    reset,
    inspect
  };
  log('Phase F loaded.');
})();
