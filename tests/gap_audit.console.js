// gap_audit.console.js
// =====================================================================
// HONEST gap audit for a generated schedule.
// Paste into the browser console (Vercel preview / localhost) AFTER a
// schedule has been generated. Reports real fill rate including null
// buckets and wall-clock gaps that the per-bucket counter ignores.
//
// Background: the older `fillRate = filled/totalSlots` metric defined
// `totalSlots` as non-null buckets only, so null buckets disappeared
// from the denominator and "100% fill" silently passed schedules with
// visible holes. This harness counts them honestly and also surfaces
// wall-clock gaps between consecutive activities (≥5 min by default).
// =====================================================================
(function () {
  const sched = window.scheduleAssignments || {};
  const divisions = window.divisions || {};
  const MIN_WALL_GAP = 5; // minutes — anything shorter is a normal buffer

  let totalBuckets = 0, nullBuckets = 0, filledBuckets = 0;
  const nullGaps = [];
  const wallGaps = [];

  for (const [bunk, slots] of Object.entries(sched)) {
    if (!Array.isArray(slots)) continue;
    let grade = null;
    for (const [d, info] of Object.entries(divisions)) {
      if ((info.bunks || []).includes(bunk)) { grade = d; break; }
    }
    const pbs = window._perBunkSlots?.[grade]?.[bunk] || [];

    // Null bucket detection
    slots.forEach((s, i) => {
      totalBuckets++;
      if (!s) {
        nullBuckets++;
        const b = pbs[i];
        if (b) nullGaps.push({ bunk, grade, idx: i, start: b.startMin, end: b.endMin, dur: b.endMin - b.startMin });
      } else if (s._activity && s.field !== 'Free') {
        filledBuckets++;
      }
    });

    // Wall-clock gap detection (between adjacent placed slots)
    const real = slots
      .filter(s => s && !s.continuation && s._startMin != null && s._endMin != null)
      .sort((a, b) => a._startMin - b._startMin);
    for (let i = 1; i < real.length; i++) {
      const prev = real[i-1], cur = real[i];
      if (cur._startMin > prev._endMin) {
        const dur = cur._startMin - prev._endMin;
        if (dur >= MIN_WALL_GAP) {
          wallGaps.push({
            bunk, grade, dur,
            after: prev._activity, before: cur._activity,
            from: prev._endMin, to: cur._startMin
          });
        }
      }
    }
  }

  // Cluster null gaps by (grade, time window) — same gap on many bunks = pattern
  const cluster = {};
  nullGaps.forEach(g => {
    const k = `${g.grade}|${g.start}-${g.end}`;
    (cluster[k] = cluster[k] || []).push(g.bunk);
  });
  const clusters = Object.entries(cluster).map(([k, bunks]) => ({ key: k, count: bunks.length, bunks }));

  // Wall-clock gaps over 15min are usually real holes vs buffer
  const wallGaps_significant = wallGaps.filter(g => g.dur >= 15);

  const report = {
    HONEST_fillRate_pct: Math.round(filledBuckets / totalBuckets * 100),
    totalBuckets, filledBuckets, nullBuckets,
    nullGapClusters: clusters,
    wallGaps_5to14min: wallGaps.filter(g => g.dur < 15).length,
    wallGaps_15plus_min: wallGaps_significant.length,
    wallGaps_15plus_samples: wallGaps_significant.slice(0, 10),
    PASS: nullBuckets === 0 && wallGaps_significant.length === 0 ? '✅' : '❌'
  };

  console.log('=== HONEST GAP AUDIT ===');
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
