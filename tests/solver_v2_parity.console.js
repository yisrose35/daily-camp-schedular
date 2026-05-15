// solver_v2_parity.console.js
// =====================================================================
// Phase X3 parity harness. Paste in the Vercel preview console after
// the page has loaded and a camp config is hydrated.
//
// What it does:
//   1. Saves the current solverVersion setting so it can be restored.
//   2. Runs v1, captures (fillRate, holes, hard violations, cost).
//   3. Runs v2 (same config, same date), captures the same.
//   4. Prints a side-by-side diff.
//   5. Restores the original solverVersion.
//
// Run 5+ times to handle solver non-determinism — both v1 and v2 are
// random-seeded, so single-shot comparisons can mislead.
// =====================================================================
(async function () {
  if (typeof window.runAutoScheduler !== 'function' ||
      typeof window._runAutoSchedulerV1 !== 'function' ||
      typeof window.runAutoSchedulerV2 !== 'function') {
    console.error('[parity] missing one of: runAutoScheduler / _runAutoSchedulerV1 / runAutoSchedulerV2');
    return;
  }

  function audit() {
    const sa = window.scheduleAssignments || {};
    const divisions = window.divisions || {};
    let total = 0, nulls = 0, free = 0, gapMin = 0;
    const significantGaps = [];
    for (const [bunk, slots] of Object.entries(sa)) {
      if (!Array.isArray(slots)) continue;
      let grade = null;
      for (const [d, info] of Object.entries(divisions)) {
        if ((info.bunks || []).includes(bunk)) { grade = d; break; }
      }
      const pbs = window.divisionTimes?.[grade]?._perBunkSlots?.[bunk] || [];
      for (let i = 0; i < pbs.length; i++) {
        total++;
        const s = slots[i];
        if (!s) nulls++;
        else if (s.field === 'Free' || s._activity === 'Free') free++;
      }
      const real = slots.filter(s => s && !s.continuation && s._startMin != null)
                        .sort((a, b) => a._startMin - b._startMin);
      for (let i = 1; i < real.length; i++) {
        const g = real[i]._startMin - real[i-1]._endMin;
        if (g > 5) gapMin += (g - 5);
        if (g >= 15) significantGaps.push({ bunk, dur: g });
      }
    }
    return { total, holes: nulls + free, nulls, free, gapMin, sigGaps: significantGaps.length };
  }

  function getLayers() {
    // The generate button delegates through daily_adjustments.js — replicate
    // the layer-flattening it does so we can drive runAutoScheduler directly.
    const g = window.loadGlobalSettings?.() || {};
    const daAutoLayers = g.app1?.daAutoLayers ||
                         g.app1?.dailyAutoLayers?.[window.currentScheduleDate] ||
                         {};
    const allLayers = [];
    Object.keys(daAutoLayers).forEach(grade => {
      (daAutoLayers[grade] || []).forEach(l => allLayers.push(Object.assign({}, l, { grade })));
    });
    return allLayers;
  }

  async function runOnce(label, runFn) {
    const t0 = performance.now();
    let result;
    try {
      result = await runFn();
    } catch (e) {
      console.error('[parity] ' + label + ' threw:', e);
      return null;
    }
    const t1 = performance.now();
    const a = audit();
    a.elapsedMs = Math.round(t1 - t0);
    a.cost = result?.cost ?? null;
    a.label = label;
    return a;
  }

  const layers = getLayers();
  if (layers.length === 0) {
    console.warn('[parity] no layers found for current date — generate normally first to seed daAutoLayers');
    return;
  }

  const g = window.loadGlobalSettings();
  const originalVersion = g.app1?.solverVersion || 'v1';
  const N_RUNS = 3;
  const rows = [];

  for (let i = 0; i < N_RUNS; i++) {
    console.log('[parity] run ' + (i + 1) + '/' + N_RUNS + ' — v1');
    const v1 = await runOnce('v1#' + (i+1), () => window._runAutoSchedulerV1(layers, {}));
    console.log('[parity] run ' + (i + 1) + '/' + N_RUNS + ' — v2');
    const v2 = await runOnce('v2#' + (i+1), () => window.runAutoSchedulerV2(layers, {}));
    rows.push({ run: i + 1, v1, v2 });
  }

  // restore version
  g.app1.solverVersion = originalVersion;
  window.saveGlobalSettings?.('app1', g.app1);

  console.log('[parity] === SUMMARY ===');
  rows.forEach(({ run, v1, v2 }) => {
    if (!v1 || !v2) { console.log('run ' + run + ': missing data'); return; }
    console.log(
      'run ' + run +
      ': v1 holes=' + v1.holes + ' gapMin=' + v1.gapMin + ' sigGaps=' + v1.sigGaps + ' ms=' + v1.elapsedMs +
      '  |  v2 holes=' + v2.holes + ' gapMin=' + v2.gapMin + ' sigGaps=' + v2.sigGaps + ' ms=' + v2.elapsedMs
    );
  });
  console.table(rows.map(r => ({
    run: r.run,
    v1_holes: r.v1?.holes, v2_holes: r.v2?.holes, holes_delta: (r.v2?.holes ?? 0) - (r.v1?.holes ?? 0),
    v1_gapMin: r.v1?.gapMin, v2_gapMin: r.v2?.gapMin, gapMin_delta: (r.v2?.gapMin ?? 0) - (r.v1?.gapMin ?? 0),
    v1_ms: r.v1?.elapsedMs, v2_ms: r.v2?.elapsedMs
  })));
  return rows;
})();
