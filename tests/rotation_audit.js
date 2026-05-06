(function() {
  'use strict';

  const SKIP = new Set([
    'free', 'free play', 'free (timeout)', 'lunch', 'snacks', 'regroup',
    'dismissal', 'change', 'swim', 'transition', 'arrival'
  ]);

  function norm(s) { return (s || '').toLowerCase().trim(); }

  function getBunkDivision(bunk) {
    if (window.getBunkDivision) return window.getBunkDivision(bunk);
    const gs = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
    const divs = gs.app1?.divisions || {};
    for (const [name, div] of Object.entries(divs)) {
      if ((div.bunks || []).includes(bunk) || (div.bunks || []).map(Number).includes(Number(bunk))) return name;
    }
    return '?';
  }

  function run() {
    const allDaily = window.loadAllDailyData?.() || {};
    const dates = Object.keys(allDaily).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

    if (dates.length === 0) {
      console.error('[RotationAudit] No schedule data found.');
      return;
    }

    console.log('%c╔══════════════════════════════════════════════════════════╗', 'color:#6366f1;font-weight:bold');
    console.log('%c║         ROTATION AUDIT — Activity Distribution          ║', 'color:#6366f1;font-weight:bold');
    console.log('%c╚══════════════════════════════════════════════════════════╝', 'color:#6366f1;font-weight:bold');
    console.log(`Dates with data: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);

    // ── Collect per-bunk activity history across all dates ──
    const bunkHistory = {};   // bunk → { actName → [dateKey, ...] }
    const bunkDayActs = {};   // bunk → dateKey → [actName, ...]
    const allBunks = new Set();
    const allActivities = new Set();

    for (const dateKey of dates) {
      const sched = allDaily[dateKey]?.scheduleAssignments || {};
      for (const [bunk, slots] of Object.entries(sched)) {
        allBunks.add(bunk);
        if (!bunkHistory[bunk]) bunkHistory[bunk] = {};
        if (!bunkDayActs[bunk]) bunkDayActs[bunk] = {};
        if (!bunkDayActs[bunk][dateKey]) bunkDayActs[bunk][dateKey] = [];

        const arr = Array.isArray(slots) ? slots : Object.values(slots);
        for (const entry of arr) {
          if (!entry || !entry._activity) continue;
          if (entry.continuation || entry._isTransition) continue;
          const act = entry._activity;
          const n = norm(act);
          if (SKIP.has(n)) continue;

          allActivities.add(act);
          if (!bunkHistory[bunk][act]) bunkHistory[bunk][act] = [];
          bunkHistory[bunk][act].push(dateKey);
          bunkDayActs[bunk][dateKey].push(act);
        }
      }
    }

    const sortedBunks = [...allBunks].sort((a, b) => Number(a) - Number(b));
    const sortedActs = [...allActivities].sort();

    // ══════════════════════════════════════════════════════════
    // TEST 1: Same-day repeats (should be zero)
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 1: Same-Day Repeats ──', 'color:#ef4444;font-weight:bold');
    let sameDayViolations = 0;
    for (const bunk of sortedBunks) {
      for (const [dateKey, acts] of Object.entries(bunkDayActs[bunk] || {})) {
        const seen = {};
        for (const act of acts) {
          seen[act] = (seen[act] || 0) + 1;
          if (seen[act] > 1) {
            console.warn(`  ⚠️ Bunk ${bunk} on ${dateKey}: "${act}" assigned ${seen[act]}x`);
            sameDayViolations++;
          }
        }
      }
    }
    if (sameDayViolations === 0) {
      console.log('  %c✅ PASS — No same-day repeats found', 'color:#22c55e');
    } else {
      console.log(`  %c❌ FAIL — ${sameDayViolations} same-day repeat(s)`, 'color:#ef4444');
    }

    // ══════════════════════════════════════════════════════════
    // TEST 2: Back-to-back repeats (same activity consecutive days)
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 2: Back-to-Back Repeats (consecutive days) ──', 'color:#f59e0b;font-weight:bold');
    let b2bCount = 0;
    const b2bDetails = [];
    for (const bunk of sortedBunks) {
      for (const [act, actDates] of Object.entries(bunkHistory[bunk] || {})) {
        const sorted = [...new Set(actDates)].sort();
        for (let i = 1; i < sorted.length; i++) {
          const prev = new Date(sorted[i - 1] + 'T12:00:00');
          const curr = new Date(sorted[i] + 'T12:00:00');
          const diffDays = Math.round((curr - prev) / 86400000);
          if (diffDays === 1) {
            b2bCount++;
            b2bDetails.push({ bunk, act, dates: `${sorted[i - 1]} → ${sorted[i]}` });
          }
        }
      }
    }
    if (b2bCount === 0) {
      console.log('  %c✅ PASS — No back-to-back repeats', 'color:#22c55e');
    } else {
      console.log(`  %c⚠️ ${b2bCount} back-to-back repeat(s)`, 'color:#f59e0b');
      const sample = b2bDetails.slice(0, 15);
      sample.forEach(d => console.log(`     Bunk ${d.bunk}: "${d.act}" on ${d.dates}`));
      if (b2bDetails.length > 15) console.log(`     ... and ${b2bDetails.length - 15} more`);
    }

    // ══════════════════════════════════════════════════════════
    // TEST 3: Activity frequency balance per bunk
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 3: Activity Frequency Balance ──', 'color:#3b82f6;font-weight:bold');
    let imbalanceCount = 0;
    const imbalanceDetails = [];
    for (const bunk of sortedBunks) {
      const hist = bunkHistory[bunk] || {};
      const counts = Object.values(hist).map(d => d.length);
      if (counts.length < 2) continue;
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      const spread = max - min;
      if (spread > 3) {
        imbalanceCount++;
        const mostDone = Object.entries(hist).sort((a, b) => b[1].length - a[1].length)[0];
        const leastDone = Object.entries(hist).sort((a, b) => a[1].length - b[1].length)[0];
        imbalanceDetails.push({
          bunk,
          spread,
          most: `${mostDone[0]} (${mostDone[1].length}x)`,
          least: `${leastDone[0]} (${leastDone[1].length}x)`,
          uniqueCount: Object.keys(hist).length
        });
      }
    }
    if (imbalanceCount === 0) {
      console.log('  %c✅ PASS — All bunks within 3-count spread', 'color:#22c55e');
    } else {
      console.log(`  %c⚠️ ${imbalanceCount} bunk(s) with spread > 3`, 'color:#f59e0b');
      imbalanceDetails.slice(0, 10).forEach(d =>
        console.log(`     Bunk ${d.bunk}: spread=${d.spread}, most="${d.most}", least="${d.least}" (${d.uniqueCount} unique activities)`)
      );
    }

    // ══════════════════════════════════════════════════════════
    // TEST 4: Coverage — are bunks trying all available activities?
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 4: Activity Coverage ──', 'color:#8b5cf6;font-weight:bold');
    const divBunks = {};
    for (const bunk of sortedBunks) {
      const div = getBunkDivision(bunk);
      if (!divBunks[div]) divBunks[div] = [];
      divBunks[div].push(bunk);
    }

    for (const [div, bunks] of Object.entries(divBunks).sort((a, b) => a[0].localeCompare(b[0]))) {
      const divActivities = new Set();
      for (const bunk of bunks) {
        for (const act of Object.keys(bunkHistory[bunk] || {})) divActivities.add(act);
      }
      const total = divActivities.size;
      if (total === 0) continue;

      console.log(`  Division ${div} (${total} activities available):`);
      for (const bunk of bunks) {
        const tried = new Set(Object.keys(bunkHistory[bunk] || {}));
        const coverage = total > 0 ? ((tried.size / total) * 100).toFixed(0) : 0;
        const missing = [...divActivities].filter(a => !tried.has(a));
        const status = missing.length === 0 ? '✅' : missing.length <= 3 ? '⚠️' : '❌';
        console.log(`     ${status} Bunk ${bunk}: ${tried.size}/${total} (${coverage}%)${missing.length > 0 && missing.length <= 5 ? ' — missing: ' + missing.join(', ') : missing.length > 5 ? ` — missing ${missing.length} activities` : ''}`);
      }
    }

    // ══════════════════════════════════════════════════════════
    // TEST 5: Cross-bunk fairness within divisions
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 5: Cross-Bunk Fairness (within divisions) ──', 'color:#06b6d4;font-weight:bold');
    let fairnessIssues = 0;
    for (const [div, bunks] of Object.entries(divBunks).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (bunks.length < 2) continue;
      const divActivities = new Set();
      for (const bunk of bunks) {
        for (const act of Object.keys(bunkHistory[bunk] || {})) divActivities.add(act);
      }

      const unfair = [];
      for (const act of divActivities) {
        const counts = bunks.map(b => (bunkHistory[b]?.[act] || []).length);
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        if (max - min > 2) {
          unfair.push({ act, max, min, spread: max - min });
        }
      }

      if (unfair.length === 0) {
        console.log(`  %c✅ Division ${div}: Fair distribution (all within 2-count spread)`, 'color:#22c55e');
      } else {
        fairnessIssues += unfair.length;
        console.log(`  ⚠️ Division ${div}: ${unfair.length} activity(ies) with >2 spread`);
        unfair.sort((a, b) => b.spread - a.spread).slice(0, 5).forEach(u =>
          console.log(`     "${u.act}": min=${u.min}, max=${u.max} (spread ${u.spread})`)
        );
      }
    }

    // ══════════════════════════════════════════════════════════
    // TEST 6: Streak detection (3+ consecutive days same activity)
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 6: Long Streaks (3+ days same activity) ──', 'color:#ec4899;font-weight:bold');
    let longStreaks = 0;
    for (const bunk of sortedBunks) {
      for (const [act, actDates] of Object.entries(bunkHistory[bunk] || {})) {
        const sorted = [...new Set(actDates)].sort();
        let streak = 1, streakStart = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          const prev = new Date(sorted[i - 1] + 'T12:00:00');
          const curr = new Date(sorted[i] + 'T12:00:00');
          if (Math.round((curr - prev) / 86400000) === 1) {
            streak++;
          } else {
            if (streak >= 3) {
              console.warn(`  ❌ Bunk ${bunk}: "${act}" for ${streak} consecutive days starting ${streakStart}`);
              longStreaks++;
            }
            streak = 1;
            streakStart = sorted[i];
          }
        }
        if (streak >= 3) {
          console.warn(`  ❌ Bunk ${bunk}: "${act}" for ${streak} consecutive days starting ${streakStart}`);
          longStreaks++;
        }
      }
    }
    if (longStreaks === 0) {
      console.log('  %c✅ PASS — No 3+ day streaks found', 'color:#22c55e');
    } else {
      console.log(`  %c❌ FAIL — ${longStreaks} long streak(s)`, 'color:#ef4444');
    }

    // ══════════════════════════════════════════════════════════
    // TEST 7: Free block analysis
    // ══════════════════════════════════════════════════════════
    console.log('\n%c── TEST 7: Free Block Analysis ──', 'color:#78716c;font-weight:bold');
    let totalFree = 0, totalSlots = 0;
    const freeByBunk = {};
    for (const dateKey of dates) {
      const sched = allDaily[dateKey]?.scheduleAssignments || {};
      for (const [bunk, slots] of Object.entries(sched)) {
        const arr = Array.isArray(slots) ? slots : Object.values(slots);
        for (const entry of arr) {
          if (!entry || entry.continuation || entry._isTransition) continue;
          const n = norm(entry._activity || '');
          if (n === 'free' || n === 'free (timeout)') {
            totalFree++;
            freeByBunk[bunk] = (freeByBunk[bunk] || 0) + 1;
          }
          totalSlots++;
        }
      }
    }
    const freePct = totalSlots > 0 ? ((totalFree / totalSlots) * 100).toFixed(1) : 0;
    console.log(`  Total: ${totalFree} Free blocks out of ${totalSlots} activity slots (${freePct}%)`);
    if (totalFree > 0) {
      const sorted = Object.entries(freeByBunk).sort((a, b) => b[1] - a[1]);
      console.log('  Worst offenders:');
      sorted.slice(0, 8).forEach(([b, c]) => console.log(`     Bunk ${b}: ${c} Free blocks`));
    }
    if (parseFloat(freePct) <= 5) {
      console.log(`  %c✅ PASS — Free rate ${freePct}% is acceptable`, 'color:#22c55e');
    } else {
      console.log(`  %c⚠️ Free rate ${freePct}% is high — solver may lack candidate options`, 'color:#f59e0b');
    }

    // ══════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════
    console.log('\n%c═══════════════ SUMMARY ═══════════════', 'color:#6366f1;font-weight:bold');
    console.log(`  Days analyzed:        ${dates.length}`);
    console.log(`  Bunks:                ${sortedBunks.length}`);
    console.log(`  Unique activities:    ${sortedActs.length}`);
    console.log(`  Same-day repeats:     ${sameDayViolations === 0 ? '✅ 0' : '❌ ' + sameDayViolations}`);
    console.log(`  Back-to-back:         ${b2bCount === 0 ? '✅ 0' : '⚠️ ' + b2bCount}`);
    console.log(`  Imbalanced bunks:     ${imbalanceCount === 0 ? '✅ 0' : '⚠️ ' + imbalanceCount}`);
    console.log(`  Long streaks (3+):    ${longStreaks === 0 ? '✅ 0' : '❌ ' + longStreaks}`);
    console.log(`  Fairness issues:      ${fairnessIssues === 0 ? '✅ 0' : '⚠️ ' + fairnessIssues}`);
    console.log(`  Free block rate:      ${freePct}%`);
    console.log('%c═══════════════════════════════════════', 'color:#6366f1;font-weight:bold');

    return {
      dates: dates.length,
      bunks: sortedBunks.length,
      activities: sortedActs.length,
      sameDayViolations,
      b2bCount,
      imbalanceCount,
      longStreaks,
      fairnessIssues,
      freePct: parseFloat(freePct)
    };
  }

  window.runRotationAudit = run;
  console.log('[RotationAudit] Loaded. Run: window.runRotationAudit()');
})();
