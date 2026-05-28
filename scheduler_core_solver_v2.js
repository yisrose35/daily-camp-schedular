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
      timeBudgetMs: parseInt(a1.solverV2TimeBudgetMs) || 3000,   // ★ v2.2: lowered from 10000 — SA stops improving after ~1-2s on real data (improvements=0 for last 90% of budget)
      multiStart:   (a1.solverV2MultiStart === undefined) ? false : !!a1.solverV2MultiStart,  // ★ v2.1: disabled by default — pass2 has never beaten pass1 on real data
      tempStart:    parseFloat(a1.solverV2TempStart)   || 100,
      tempEnd:      parseFloat(a1.solverV2TempEnd)     || 0.1,
      kickAfter:    parseInt(a1.solverV2KickAfter)     || 500,    // stall threshold for re-randomize
      kickSize:     parseInt(a1.solverV2KickSize)      || 5,      // # slots to randomize per kick
      seed:         parseInt(a1.solverV2Seed)          || Date.now(),
      cost: {
        hardViolation:    parseFloat(a1.solverV2CostHardViolation)    || 1e9,
        hole:             parseFloat(a1.solverV2CostHole)             || 100,
        sameDayRepeat:    parseFloat(a1.solverV2CostSameDayRepeat)    || 30,
        rotationUnfair:   parseFloat(a1.solverV2CostRotationUnfair)   || 20,
        wallClockGapMin:  parseFloat(a1.solverV2CostWallClockGapMin)  || 1,
        sigGapBonus:      parseFloat(a1.solverV2CostSigGapBonus)      || 25,  // per gap ≥15min
        // swim-no-change: cost 100/each. v2 now HAS moveAddChange to fix
        //   these, so the cost steers SA toward synthesizing Change blocks.
        // period-viol: cost 0. Still v2-uncatchable for seed-state — kept
        //   in breakdown for diagnostics only.
        swimNoChange:     parseFloat(a1.solverV2CostSwimNoChange)     || 100,
        periodViolation:  parseFloat(a1.solverV2CostPeriodViolation)  || 0,
        // unfillableSliver: stiff per-occurrence penalty for any wall-clock
        //   gap whose duration is in (5, minFillerDur) — i.e. too big to be
        //   a period transition (≤5min) but too small for any filler
        //   activity to occupy (Slush/Popcorn = 10min). These are the gaps
        //   v1 most often creates by stuffing a 20-min activity into a
        //   30-min slot. SA needs strong signal to AVOID these placements
        //   and to UNDO them via moveFitDuration when found.
        unfillableSliver: parseFloat(a1.solverV2CostUnfillableSliver) || 500
      }
    };
  }

  // Smallest-filler-duration cutoff used by the unfillableSliver detector.
  // Any gap strictly less than this can't be closed by ANY filler activity,
  // so SA should treat it as an outright bad placement to avoid creating.
  // Hard-coded for now (matches Slush/Popcorn 10-min standard); future:
  // derive from min(ctx.specials.duration) for activities marked as fillers.
  const MIN_FILLER_DUR = 10;

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

    // Term 5: Wall-clock gaps over 5 min (period transitions = free).
    //         Also adds a flat per-significant-gap bonus so SA optimizes for
    //         eliminating gaps entirely (vs. just shaving them).
    const gapInfo = countWallClockGapMinutes(schedule, ctx);
    cost += gapInfo.gapMin * cfg.cost.wallClockGapMin;
    cost += gapInfo.sigGaps * cfg.cost.sigGapBonus;

    // Terms 6+7: Swim-no-Change and period violations — both are usually
    // v1-seed-induced. Skip the expensive scans entirely when their weight
    // is 0 (default). This restores SA iteration count to pre-X2f-9 levels
    // (~86k iters/pass on this camp config).
    let swimNoChange = 0, periodViol = 0;
    if (cfg.cost.swimNoChange > 0) {
      swimNoChange = countSwimWithoutChange(schedule);
      cost += swimNoChange * cfg.cost.swimNoChange;
    }
    if (cfg.cost.periodViolation > 0) {
      periodViol = countPeriodViolations(schedule, ctx);
      cost += periodViol * cfg.cost.periodViolation;
    }

    // Term 8: unfillable slivers — wall-clock gaps in (5, MIN_FILLER_DUR).
    //   These are too big to be transition zones (≤5min) and too small for
    //   any filler activity (Slush/Popcorn = 10min). They're "dead" minutes
    //   that NO move can close — the only fix is to avoid creating them.
    //   This term gives SA strong signal to swap out 20-in-30 placements.
    let unfillable = 0;
    if (cfg.cost.unfillableSliver > 0) {
      unfillable = countUnfillableSlivers(schedule, ctx);
      cost += unfillable * cfg.cost.unfillableSliver;
    }

    return { cost, hardViolations, breakdown: { holes, repeats, rotUnfair, gapMin: gapInfo.gapMin, sigGaps: gapInfo.sigGaps, swimNoChange, periodViol, unfillable } };
  }

  // Walk each bunk's real (non-continuation) slots in time order; count gaps
  // that no available activity can fill.
  //
  // X2f-18c: ELIGIBILITY-BASED instead of size-based. The old check only
  // caught gaps in (5, MIN_FILLER_DUR) — but a 10-min gap on a bunk that's
  // already used Slush/Popcorn/Ice Cream to maxUsage is just as dead. We
  // now ask the real question: is there ANY specials-pool activity with
  //   dMin ≤ gap, accessible to the bunk's grade, under maxUsage,
  // available right now? If no → this gap is unfillable, cost it.
  //
  // Gaps ≤ 5 min are still considered legal inter-period buffers and
  // never costed (matches the bell-schedule transition convention).
  function countUnfillableSlivers(schedule, ctx) {
    let n = 0;
    const specials = (ctx && ctx.specials) || [];
    const divisions = (ctx && ctx.divisions) || {};

    for (const [bunk, slots] of Object.entries(schedule)) {
      if (!Array.isArray(slots)) continue;
      const grade = _bunkGrade(bunk, divisions);
      if (!grade) continue;

      // Per-bunk usage count for maxUsage filter.
      const usage = {};
      for (const s of slots) {
        if (!s || s.continuation || !s._activity) continue;
        const a = String(s._activity);
        usage[a] = (usage[a] || 0) + 1;
      }

      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null && s._endMin != null)
        .sort((a, b) => a._startMin - b._startMin);

      for (let i = 1; i < real.length; i++) {
        const gap = real[i]._startMin - real[i - 1]._endMin;
        if (gap <= 5) continue;     // legal transition buffer
        if (gap > 45) continue;     // huge gap — different problem class
        // Does ANY eligible filler fit this gap?
        let fillable = false;
        for (const sp of specials) {
          if (!sp || !sp.name) continue;
          if (sp.fullGrade === true) continue;
          const ar = sp.accessRestrictions;
          if (ar && ar.enabled) {
            const divs = ar.divisions || {};
            if (!(grade in divs) && !(String(grade) in divs)) continue;
          }
          const maxUse = parseInt(sp.maxUsage) || 0;
          if (maxUse > 0 && (usage[sp.name] || 0) >= maxUse) continue;
          const dMin = parseInt(sp.dMin || sp.duration || sp.preferredDuration) || 0;
          if (dMin > 0 && dMin > gap) continue;
          fillable = true;
          break;
        }
        if (!fillable) n++;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // VALIDATORS (stubs — to be filled in Phase X2b)
  // -------------------------------------------------------------------------
  // Detect hard rule violations. Self-contained so the SA loop doesn't depend
  // on v1's closure. Mirrors the logic in v1's commitWriteIfLegal + safety net.
  function detectHardViolations(schedule, ctx) {
    const out = [];
    const fieldByName = ctx._fieldByName;
    const specialByName = ctx._specialByName;

    // Build flat (bunk, grade, field, sport, activity, start, end) list once.
    const flat = [];
    for (const [bunk, slots] of Object.entries(schedule)) {
      if (!Array.isArray(slots)) continue;
      let grade = null;
      for (const [d, info] of Object.entries(ctx.divisions)) {
        if ((info.bunks || []).includes(bunk)) { grade = d; break; }
      }
      slots.forEach((s, idx) => {
        if (!s || s.continuation) return;
        if (s.field === 'Free' || !s._activity) return;
        if (s._activity === 'Change' || s.type === 'pre-change' || s.type === 'post-change') return;
        flat.push({ bunk, grade, idx, field: s.field, activity: s._activity,
                    start: s._startMin, end: s._endMin,
                    type: s.type, special: s._assignedSpecial, loc: (s.location || s._specialLocation) });
      });
    }

    // === 1. Field access restrictions (per-division + per-bunk allow lists) ===
    flat.forEach(c => {
      const cfg = fieldByName[c.field];
      if (!cfg?.accessRestrictions?.enabled) return;
      const divs = cfg.accessRestrictions.divisions || {};
      const gradeKey = String(c.grade);
      if (!(gradeKey in divs) && !(c.grade in divs)) {
        out.push({ bunk: c.bunk, idx: c.idx, reason: 'field-access:grade ' + c.grade + ' not allowed on ' + c.field });
        return;
      }
      const allow = divs[gradeKey] || divs[c.grade];
      if (Array.isArray(allow) && allow.length > 0 && !allow.map(String).includes(String(c.bunk))) {
        out.push({ bunk: c.bunk, idx: c.idx, reason: 'field-access:bunk ' + c.bunk + ' not in allow-list for ' + c.field });
      }
    });

    // === 2. Field time rules (Available/Unavailable, per-division) ===
    // ★ Day 22.5 fix: DA Resources daily rules live in:
    //   - window.activityProperties[name].timeRules (gen-entry merge)
    //   - dailyData.dailyFieldAvailability[name]
    //   - localStorage 'campResourceOverrides_<date>'
    // V2 previously read ONLY cfg.timeRules (setup-level), so daily-only
    // Unavailable rules were invisible — the SA optimizer could happily
    // make replace/swap moves into a daily-unavailable window.
    function _getDailyRulesForField(fieldName) {
      try {
        const ap = (typeof window !== 'undefined') ? window.activityProperties?.[fieldName]?.timeRules : null;
        if (Array.isArray(ap) && ap.length > 0) return ap;
        const dd = (typeof window !== 'undefined') ? (window.loadCurrentDailyData?.()?.dailyFieldAvailability || {})[fieldName] : null;
        if (Array.isArray(dd) && dd.length > 0) return dd;
        const dk = (typeof window !== 'undefined') ? (window.currentScheduleDate || '') : '';
        if (dk) {
          const _stored = localStorage.getItem('campResourceOverrides_' + dk);
          if (_stored) {
            const _parsed = JSON.parse(_stored);
            const ls = _parsed?.dailyFieldAvailability?.[fieldName];
            if (Array.isArray(ls) && ls.length > 0) return ls;
          }
        }
      } catch (_e) {}
      return null;
    }
    flat.forEach(c => {
      const cfg = fieldByName[c.field];
      // Effective rules: daily rules REPLACE setup-level rules (matches the
      // gen-entry merge semantics for activityProperties[name].timeRules).
      const _dailyRules = _getDailyRulesForField(c.field);
      const effRules = _dailyRules || cfg?.timeRules || [];
      if (effRules.length === 0) return;
      const avail = effRules.filter(r => r.type === 'Available' || !r.type || r.available === true);
      const unavail = effRules.filter(r => r.type === 'Unavailable' || r.available === false);
      // Available: must lie within at least one applicable rule
      if (avail.length > 0) {
        const ok = avail.some(r => {
          if (r.divisions && r.divisions.length > 0 && !r.divisions.includes(c.grade)) return false;
          const rs = r.startMin ?? null, re = r.endMin ?? null;
          if (rs == null || re == null) return true;
          return c.start >= rs && c.end <= re;
        });
        if (!ok) out.push({ bunk: c.bunk, idx: c.idx, reason: 'time-rule:outside-available on ' + c.field });
      }
      // Unavailable: no applicable rule may overlap
      unavail.forEach(r => {
        if (r.divisions && r.divisions.length > 0 && !r.divisions.includes(c.grade)) return;
        const rs = r.startMin ?? null, re = r.endMin ?? null;
        if (rs == null || re == null) return;
        if (c.start < re && c.end > rs) {
          out.push({ bunk: c.bunk, idx: c.idx, reason: 'time-rule:in-unavailable ' + rs + '-' + re + ' on ' + c.field });
        }
      });
    });

    // === 3. Field capacity + sharing (cap exceeded, cross-grade on same_division, etc.) ===
    const byField = {};
    flat.forEach(c => { if (c.field) (byField[c.field] = byField[c.field] || []).push(c); });
    for (const [fieldName, claims] of Object.entries(byField)) {
      const cfg = fieldByName[fieldName];
      if (!cfg) continue;
      const globalCap = cfg.sharableWith?.capacity || (cfg.sharableWith?.type === 'not_sharable' ? 1 : 2);
      const globalShare = cfg.sharableWith?.type || 'not_sharable';
      const gsr = cfg.gradeShareRules || {};

      // Peak concurrent + cross-grade overlap check
      for (let i = 0; i < claims.length; i++) {
        for (let j = i + 1; j < claims.length; j++) {
          const a = claims[i], b = claims[j];
          if (a.start >= b.end || a.end <= b.start) continue; // no overlap
          // not_sharable globally and no per-grade override → conflict
          const aRule = gsr[a.grade], bRule = gsr[b.grade];
          const effShareA = aRule?.type || globalShare;
          const effShareB = bRule?.type || globalShare;
          if (effShareA === 'not_sharable' || effShareB === 'not_sharable') {
            out.push({ bunk: a.bunk, idx: a.idx, reason: 'field-share:not_sharable overlap with ' + b.bunk + ' on ' + fieldName });
            break;
          }
          // same_division: cross-grade overlap is illegal
          if ((effShareA === 'same_division' || effShareB === 'same_division') && a.grade !== b.grade) {
            out.push({ bunk: a.bunk, idx: a.idx, reason: 'field-share:same_division cross-grade with ' + b.bunk + '/' + b.grade + ' on ' + fieldName });
          }
          // cross_division with allowedPairs
          if (effShareA === 'cross_division') {
            const pairs = cfg.sharableWith?.allowedPairs || {};
            const key = [a.grade, b.grade].sort().join('|');
            if (!pairs[key]) {
              out.push({ bunk: a.bunk, idx: a.idx, reason: 'field-share:cross_division pair ' + key + ' not allowed on ' + fieldName });
            }
          }
        }
      }
      // Peak count vs cap (per grade override aware)
      const events = [];
      claims.forEach(c => { events.push({ t: c.start, e: 1, c }); events.push({ t: c.end, e: -1, c }); });
      events.sort((a, b) => a.t - b.t || a.e - b.e);
      let cur = 0, peak = 0, peakAt = 0, peakOverlaps = [];
      events.forEach(ev => {
        if (ev.e === 1) cur++; else cur--;
        if (cur > peak) {
          peak = cur; peakAt = ev.t;
          peakOverlaps = claims.filter(c => c.start <= ev.t && c.end > ev.t);
        }
      });
      if (peak > globalCap) {
        out.push({ bunk: peakOverlaps[0]?.bunk, idx: peakOverlaps[0]?.idx, reason: 'field-cap:' + fieldName + ' peak=' + peak + ' cap=' + globalCap });
      }
      // Per-grade cap (if any grade has its own override that's tighter than peak for that grade)
      Object.keys(gsr).forEach(g => {
        const ruleCap = parseInt(gsr[g]?.capacity) || (gsr[g]?.type === 'not_sharable' ? 1 : 2);
        const gClaims = claims.filter(c => c.grade === g);
        const gEv = []; gClaims.forEach(c => { gEv.push({ t: c.start, e: 1 }); gEv.push({ t: c.end, e: -1 }); });
        gEv.sort((a, b) => a.t - b.t || a.e - b.e);
        let gc = 0, gp = 0; gEv.forEach(x => { gc += x.e; if (gc > gp) gp = gc; });
        if (gp > ruleCap) {
          out.push({ bunk: gClaims[0]?.bunk, idx: gClaims[0]?.idx, reason: 'field-cap-per-grade:' + g + ' on ' + fieldName + ' peak=' + gp + ' cap=' + ruleCap });
        }
      });
    }

    // === 4. Special access restrictions (per-bunk allow lists on specials) ===
    flat.forEach(c => {
      const spec = specialByName[c.activity];
      if (!spec?.accessRestrictions?.enabled) return;
      const divs = spec.accessRestrictions.divisions || {};
      const gradeKey = String(c.grade);
      if (!(gradeKey in divs) && !(c.grade in divs)) {
        out.push({ bunk: c.bunk, idx: c.idx, reason: 'special-access:grade ' + c.grade + ' not allowed for ' + c.activity });
        return;
      }
      const allow = divs[gradeKey] || divs[c.grade];
      if (Array.isArray(allow) && allow.length > 0 && !allow.map(String).includes(String(c.bunk))) {
        out.push({ bunk: c.bunk, idx: c.idx, reason: 'special-access:bunk not in allow-list for ' + c.activity });
      }
    });

    // === 5. FullGrade enforcement (special marked fullGrade must hit ALL grade bunks) ===
    const fullGradeSpecials = (ctx.specials || []).filter(s => s.fullGrade === true);
    fullGradeSpecials.forEach(spec => {
      for (const [grade, info] of Object.entries(ctx.divisions)) {
        const bunks = info.bunks || [];
        const got = bunks.filter(b => (schedule[b] || []).some(s => s?._activity === spec.name));
        if (got.length > 0 && got.length < bunks.length) {
          got.forEach(b => out.push({ bunk: b, idx: -1, reason: 'fullGrade:partial ' + got.length + '/' + bunks.length + ' bunks of ' + grade + ' got ' + spec.name }));
        }
      }
    });

    // === 6. Special maxUsage per bunk per day ===
    (ctx.specials || []).forEach(spec => {
      const maxUse = parseInt(spec.maxUsage) || 0;
      if (maxUse <= 0) return;
      const byBunk = {};
      flat.filter(c => c.activity === spec.name).forEach(c => { byBunk[c.bunk] = (byBunk[c.bunk] || 0) + 1; });
      Object.entries(byBunk).forEach(([b, n]) => {
        if (n > maxUse) out.push({ bunk: b, idx: -1, reason: 'special-maxUsage:' + spec.name + ' bunk=' + n + ' max=' + maxUse });
      });
    });

    // === 7. Cooldown / spacing rules (rules.js → window.SchedulingRules) ===
    // The v1 seed already respects these (it calls rulesAllow at placement
    // time), but v2's SA moves can shuffle a block into a forbidden range with
    // no check. Treat a spacing violation as a HARD violation so the cost
    // function (1e9 each) rejects any move that introduces one — and since the
    // seed starts clean, SA just maintains 0. Fully guarded: a complete no-op
    // when the user has no auto-mode spacing rules (zero overhead in the common
    // case). The O(n^2)-per-bunk cost applies only when spacing rules exist,
    // where correctness outweighs the extra SA time.
    try {
      const SR = (typeof window !== 'undefined') ? window.SchedulingRules : null;
      const cdRules = (SR && typeof SR.getCooldownRules === 'function') ? (SR.getCooldownRules() || []) : [];
      const hasAutoCd = SR && typeof SR.isCandidateAllowed === 'function' && cdRules.some(r => {
        const m = (r && r.mode) || 'both';
        return (m === 'both' || m === 'auto') && r.target && r.reference && (parseInt(r.minutes) || 0) > 0;
      });
      if (hasAutoCd) {
        const _mkBlk = (c) => {
          // Build a rules-engine descriptor. Prefer name-inferred type
          // (reliably yields sport/special/swim/lunch/snack/dismissal from the
          // activity name); fall back to the slot's explicit type (e.g. custom).
          const infer = (typeof SR.inferTypeFromActivity === 'function') ? SR.inferTypeFromActivity(c.activity) : 'activity';
          const type = (infer && infer !== 'activity') ? infer : (String(c.type || '').toLowerCase() || infer);
          return { startMin: c.start, endMin: c.end, type, event: c.activity,
                   field: c.field, _assignedSpecial: c.special || null, _specialLocation: c.loc || null };
        };
        const byBunkCd = {};
        flat.forEach(c => { (byBunkCd[c.bunk] = byBunkCd[c.bunk] || []).push(c); });
        Object.keys(byBunkCd).forEach(bk => {
          const arr = byBunkCd[bk];
          const blks = arr.map(_mkBlk);
          for (let i = 0; i < blks.length; i++) {
            const cand = blks[i];
            const tmpl = blks.slice(0, i).concat(blks.slice(i + 1));
            if (!SR.isCandidateAllowed(cand, tmpl, { mode: 'auto' })) {
              out.push({ bunk: bk, idx: arr[i].idx,
                         reason: 'cooldown:"' + (cand.event || '?') + '" violates a spacing rule' });
            }
          }
        });
      }
    } catch (_eCd) { /* never let rule-checking break the solver */ }

    // === 8. Sport player cap (rules.js → sportMetaData.maxPlayers) ===
    // When bunks SHARE a field for a sport, their summed roster (bunk sizes)
    // must not exceed that sport's maxPlayers — mirrors the v1 solver check
    // (auto_solver_engine.js L358-373). v1 enforces only maxPlayers (minPlayers
    // is a soft size-matching hint, not a hard floor), so v2 matches. No-op when
    // no sport has a maxPlayers configured, or bunk sizes are unset (sizes → 0).
    try {
      const _spMeta = ctx.sportMetaData || {};
      const _bs = ctx._bunkSize || {};
      const _anyMax = Object.keys(_spMeta).some(k => (parseInt(_spMeta[k] && _spMeta[k].maxPlayers) || 0) > 0);
      if (_anyMax) {
        for (const fieldName in byField) {
          const claims = byField[fieldName];
          for (let i = 0; i < claims.length; i++) {
            const c = claims[i];
            const cap = parseInt(_spMeta[c.activity] && _spMeta[c.activity].maxPlayers) || 0;
            if (cap <= 0) continue;
            let total = parseInt(_bs[String(c.bunk)]) || 0;
            for (let j = 0; j < claims.length; j++) {
              if (j === i) continue;
              const o = claims[j];
              if (o.start >= c.end || o.end <= c.start) continue; // no time overlap
              total += parseInt(_bs[String(o.bunk)]) || 0;
            }
            if (total > cap) {
              out.push({ bunk: c.bunk, idx: c.idx,
                         reason: 'sport-maxPlayers:' + c.activity + ' roster=' + total + ' max=' + cap + ' on ' + fieldName });
            }
          }
        }
      }
    } catch (_eSp) { /* never let rule-checking break the solver */ }

    return out;
  }

  // Period violations: non-anchor activities crossing period boundaries.
  // KEPT AS SOFT COST — v1 seed often has these (Lineup, etc.), and treating
  // them as hard violations paralyzes SA. v2 moves already respect periods
  // via _staysInPeriod so SA won't CREATE new ones. Seed-state violations
  // get a high but finite cost so SA prefers schedules without them.
  function countPeriodViolations(schedule, ctx) {
    let n = 0;
    for (const [bunk, slots] of Object.entries(schedule)) {
      if (!Array.isArray(slots)) continue;
      let grade = null;
      for (const [d, info] of Object.entries(ctx.divisions)) if ((info.bunks||[]).includes(bunk)) { grade = d; break; }
      const periods = window.campPeriods?.[grade];
      if (!Array.isArray(periods) || periods.length === 0) continue;
      slots.forEach(s => {
        if (!s || s.continuation || !s._activity) return;
        const lc = String(s._activity).toLowerCase();
        if (['lunch','swim','change','snack','snacks','dismissal','lineup','dismissal'].includes(lc)) return;
        if (s._startMin == null || s._endMin == null) return;
        const inside = periods.some(p => s._startMin >= p.startMin && s._endMin <= p.endMin);
        if (!inside) n++;
      });
    }
    return n;
  }

  // Soft-violations: things that aren't show-stoppers but should be penalized.
  // Returns a count, used as a separate cost-function term so SA tries to
  // minimize without being paralyzed by un-fixable seed-state issues.
  function countSwimWithoutChange(schedule) {
    let n = 0;
    for (const [bunk, slots] of Object.entries(schedule)) {
      if (!Array.isArray(slots)) continue;
      const real = slots
        .filter(s => s && !s.continuation && s._activity)
        .sort((a, b) => (a._startMin ?? 0) - (b._startMin ?? 0));
      for (let i = 0; i < real.length; i++) {
        const s = real[i];
        if ((s._activity || '').toLowerCase() !== 'swim') continue;
        const before = real[i - 1];
        const after = real[i + 1];
        const bIsChange = before && /change/i.test(before._activity || '') && before._endMin === s._startMin;
        const aIsChange = after && /change/i.test(after._activity || '') && after._startMin === s._endMin;
        if (!bIsChange && !aIsChange) n++;
      }
    }
    return n;
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

  // Returns { gapMin, sigGaps } so the cost can apply both a per-minute
  // and a per-significant-gap penalty. The per-gap bonus pushes SA to
  // CLOSE gaps entirely rather than just shrink them slightly.
  function countWallClockGapMinutes(schedule, ctx) {
    let minutes = 0, sigGaps = 0;
    for (const slots of Object.values(schedule)) {
      if (!Array.isArray(slots)) continue;
      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null && s._endMin != null)
        .sort((a, b) => a._startMin - b._startMin);
      for (let i = 1; i < real.length; i++) {
        const gap = real[i]._startMin - real[i-1]._endMin;
        if (gap > 5) minutes += (gap - 5);
        if (gap >= 15) sigGaps++;
      }
    }
    return { gapMin: minutes, sigGaps };
  }

  // -------------------------------------------------------------------------
  // MOVE OPERATORS
  // -------------------------------------------------------------------------
  // Each operator: takes current schedule + ctx, returns a NEW schedule with
  // one local change, or null if no valid move could be found this call.
  //
  // Movability rules:
  //   - Anchor blocks (Swim/Lunch/Change/Snacks/Dismissal) are immovable.
  //   - _fixed / _pinned / _league / _autoSpecial slots are immovable.
  //   - Continuation slots are immovable (head bucket is the placeable one).
  //   - "Free" or null slots are candidates for inject/replace.

  function _isMovable(slot) {
    if (!slot) return true; // null is movable (inject candidate)
    if (slot.continuation) return false;
    if (slot._fixed || slot._pinned || slot._league || slot._autoSpecial) return false;
    const act = String(slot._activity || '').toLowerCase();
    if (['lunch', 'swim', 'change', 'snacks', 'snack', 'dismissal'].includes(act)) return false;
    return true;
  }

  function _bunkGrade(bunk, divisions) {
    for (const [d, info] of Object.entries(divisions)) {
      if ((info.bunks || []).includes(bunk)) return d;
    }
    return null;
  }

  // Does [startMin, endMin] fit ENTIRELY within at least one period of `grade`?
  // Used to reject extend/cross-swap moves that would cross period boundaries.
  function _staysInPeriod(grade, startMin, endMin) {
    const periods = window.campPeriods?.[grade];
    if (!Array.isArray(periods) || periods.length === 0) return true;
    return periods.some(p => p.startMin <= startMin && p.endMin >= endMin);
  }

  function _candidateActivities(grade, ctx) {
    // Pool of activities that could plausibly fill a slot for this grade:
    //   - All fields' `activities` arrays (sports list)
    //   - All non-fullGrade specials accessible to this grade
    const acts = new Set();
    (ctx.fields || []).forEach(f => {
      const ar = f.accessRestrictions;
      if (ar?.enabled) {
        const divs = ar.divisions || {};
        if (!(grade in divs) && !(String(grade) in divs)) return;
      }
      (f.activities || []).forEach(a => acts.add(a));
    });
    (ctx.specials || []).forEach(s => {
      if (s.fullGrade === true) return;
      const ar = s.accessRestrictions;
      if (ar?.enabled) {
        const divs = ar.divisions || {};
        if (!(grade in divs) && !(String(grade) in divs)) return;
      }
      acts.add(s.name);
    });
    return [...acts];
  }

  function _findFieldForActivity(activity, ctx) {
    return (ctx.fields || []).find(f => Array.isArray(f.activities) && f.activities.includes(activity)) || null;
  }

  // Shallow-clone schedule so we can mutate one bunk's array without touching
  // the others. Slot objects are shared by reference — we only replace slots
  // we change, never mutate them in place.
  function _cloneSchedule(schedule) {
    const out = {};
    for (const [bunk, slots] of Object.entries(schedule)) {
      out[bunk] = Array.isArray(slots) ? slots.slice() : slots;
    }
    return out;
  }

  // --- Bucket-grid patching --------------------------------------------------
  // Moves that change the BUCKET GRID (insert/delete/extend a bucket in
  // _perBunkSlots) must NOT mutate ctx.perBunkSlots directly — if SA rejects
  // the candidate schedule the grid would still have the unwanted change.
  //
  // Pattern: move returns either:
  //    A plain schedule object (no grid change), OR
  //    { schedule, bucketPatch: { grade, bunk, kind: 'insert'|'extend'|'delete',
  //                                idx, newBucket?, newBounds? } }
  //
  // SA loop:
  //    - if candidate has bucketPatch AND we accept → applyBucketPatch(ctx, patch)
  //    - if reject → do nothing (no mutation happened)
  function applyBucketPatch(ctx, patch) {
    if (!patch) return;
    const arr = ctx.perBunkSlots?.[patch.grade]?.[patch.bunk];
    if (!Array.isArray(arr)) return;
    if (patch.kind === 'insert') {
      arr.splice(patch.idx, 0, patch.newBucket);
    } else if (patch.kind === 'delete') {
      arr.splice(patch.idx, 1);
    } else if (patch.kind === 'extend') {
      arr[patch.idx] = Object.assign({}, arr[patch.idx], patch.newBounds);
    }
  }
  function unwrapCandidate(maybe) {
    // Normalize: return { schedule, bucketPatch }
    if (!maybe) return null;
    if (Array.isArray(maybe) || typeof maybe !== 'object') return null;
    if (maybe.schedule) return maybe; // already wrapped
    return { schedule: maybe, bucketPatch: null };
  }

  // --- replace: pick a movable slot, swap its activity for a different one ---
  function moveReplace(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    if (bunks.length === 0) return null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const slots = schedule[bunk];
      if (!Array.isArray(slots) || slots.length === 0) continue;
      const idx = Math.floor(rng() * slots.length);
      if (!_isMovable(slots[idx])) continue;
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const pool = _candidateActivities(grade, ctx);
      if (pool.length < 2) continue;
      const newAct = pool[Math.floor(rng() * pool.length)];
      const oldAct = slots[idx]?._activity;
      if (newAct === oldAct) continue;
      const newField = _findFieldForActivity(newAct, ctx);
      if (!newField) continue;
      const bucket = ctx.perBunkSlots[grade]?.[bunk]?.[idx];
      // ★ Day 22.5 fix: block moves that would land in a daily-Unavailable window.
      //   detectHardViolations now flags these in the cost function, but the SA
      //   loop sometimes can't escape them once the seed sits at a violation.
      //   Reject candidate fields outright at move-construction time.
      try {
        const _sM = bucket?.startMin ?? slots[idx]?._startMin;
        const _eM = bucket?.endMin ?? slots[idx]?._endMin;
        if (_sM != null && _eM != null) {
          let _da = null;
          const _ap = (typeof window !== 'undefined') ? window.activityProperties?.[newField.name]?.timeRules : null;
          if (Array.isArray(_ap) && _ap.length > 0) _da = _ap;
          if (!_da) {
            const _dd = (typeof window !== 'undefined') ? (window.loadCurrentDailyData?.()?.dailyFieldAvailability || {})[newField.name] : null;
            if (Array.isArray(_dd) && _dd.length > 0) _da = _dd;
          }
          if (!_da) {
            const _dk = (typeof window !== 'undefined') ? (window.currentScheduleDate || '') : '';
            if (_dk) {
              const _stored = localStorage.getItem('campResourceOverrides_' + _dk);
              if (_stored) {
                const _parsed = JSON.parse(_stored);
                const _ls = _parsed?.dailyFieldAvailability?.[newField.name];
                if (Array.isArray(_ls) && _ls.length > 0) _da = _ls;
              }
            }
          }
          if (_da) {
            let _bad = false;
            for (const r of _da) {
              const _t = String(r.type || '').toLowerCase();
              if (!(_t === 'unavailable' || r.available === false)) continue;
              const _rs = r.startMin ?? null;
              const _re = r.endMin ?? null;
              if (_rs == null || _re == null) continue;
              if (_rs < _eM && _re > _sM) { _bad = true; break; }
            }
            if (_bad) continue; // pick a different field/activity
          }
        }
      } catch (_e) {}
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk][idx] = {
        field: newField.name, sport: newAct, _activity: newAct,
        _autoMode: true, _autoSolved: true,
        _startMin: bucket?.startMin ?? slots[idx]?._startMin,
        _endMin: bucket?.endMin ?? slots[idx]?._endMin,
        _source: 'v2-replace', continuation: false
      };
      return next;
    }
    return null;
  }

  // --- swap: swap two movable slots within the same bunk ---
  function moveSwap(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 10; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const slots = schedule[bunk];
      if (!Array.isArray(slots) || slots.length < 2) continue;
      const movable = [];
      slots.forEach((s, i) => { if (_isMovable(s) && s) movable.push(i); });
      if (movable.length < 2) continue;
      const a = movable[Math.floor(rng() * movable.length)];
      let b = movable[Math.floor(rng() * movable.length)];
      while (b === a) b = movable[Math.floor(rng() * movable.length)];
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      // Swap activities only — keep bucket times in place
      const sa = next[bunk][a], sb = next[bunk][b];
      const bucketA = ctx.perBunkSlots[_bunkGrade(bunk, ctx.divisions)]?.[bunk]?.[a];
      const bucketB = ctx.perBunkSlots[_bunkGrade(bunk, ctx.divisions)]?.[bunk]?.[b];
      next[bunk][a] = Object.assign({}, sb, {
        _startMin: bucketA?.startMin ?? sa?._startMin,
        _endMin: bucketA?.endMin ?? sa?._endMin,
        _source: 'v2-swap', continuation: false
      });
      next[bunk][b] = Object.assign({}, sa, {
        _startMin: bucketB?.startMin ?? sb?._startMin,
        _endMin: bucketB?.endMin ?? sb?._endMin,
        _source: 'v2-swap', continuation: false
      });
      return next;
    }
    return null;
  }

  // --- inject: find a null/Free slot, fill it with a valid activity ---
  function moveInject(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const slots = schedule[bunk];
      if (!Array.isArray(slots)) continue;
      const holes = [];
      slots.forEach((s, i) => {
        if (!s || s.field === 'Free' || s._activity === 'Free') holes.push(i);
      });
      if (holes.length === 0) continue;
      const idx = holes[Math.floor(rng() * holes.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const bucket = ctx.perBunkSlots[grade]?.[bunk]?.[idx];
      if (!bucket) continue;
      const pool = _candidateActivities(grade, ctx);
      if (pool.length === 0) continue;
      const newAct = pool[Math.floor(rng() * pool.length)];
      const newField = _findFieldForActivity(newAct, ctx);
      if (!newField) continue;
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk][idx] = {
        field: newField.name, sport: newAct, _activity: newAct,
        _autoMode: true, _autoSolved: true,
        _startMin: bucket.startMin, _endMin: bucket.endMin,
        _source: 'v2-inject', continuation: false
      };
      return next;
    }
    return null;
  }

  // --- relocate: keep the activity, try a different field that hosts it ---
  function moveRelocate(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 10; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const slots = schedule[bunk];
      if (!Array.isArray(slots)) continue;
      const idx = Math.floor(rng() * slots.length);
      const s = slots[idx];
      if (!_isMovable(s) || !s?._activity) continue;
      const candidates = (ctx.fields || []).filter(f =>
        Array.isArray(f.activities) && f.activities.includes(s._activity) && f.name !== s.field
      );
      if (candidates.length === 0) continue;
      const newField = candidates[Math.floor(rng() * candidates.length)];
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk][idx] = Object.assign({}, s, { field: newField.name, _source: 'v2-relocate' });
      return next;
    }
    return null;
  }

  // --- crossSwap: swap a slot between two bunks of the same grade ---
  function moveCrossSwap(schedule, ctx, rng) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const grades = Object.keys(ctx.divisions);
      const grade = grades[Math.floor(rng() * grades.length)];
      const bunks = ctx.divisions[grade]?.bunks || [];
      if (bunks.length < 2) continue;
      const ba = bunks[Math.floor(rng() * bunks.length)];
      let bb = bunks[Math.floor(rng() * bunks.length)];
      while (bb === ba) bb = bunks[Math.floor(rng() * bunks.length)];
      const slotsA = schedule[ba], slotsB = schedule[bb];
      if (!Array.isArray(slotsA) || !Array.isArray(slotsB)) continue;
      const len = Math.min(slotsA.length, slotsB.length);
      const idx = Math.floor(rng() * len);
      if (!_isMovable(slotsA[idx]) || !_isMovable(slotsB[idx])) continue;
      const bucketA = ctx.perBunkSlots[grade]?.[ba]?.[idx];
      const bucketB = ctx.perBunkSlots[grade]?.[bb]?.[idx];
      if (!bucketA || !bucketB) continue;
      // Period-boundary check: both buckets must lie within a single period
      if (!_staysInPeriod(grade, bucketA.startMin, bucketA.endMin)) continue;
      if (!_staysInPeriod(grade, bucketB.startMin, bucketB.endMin)) continue;
      const next = _cloneSchedule(schedule);
      next[ba] = next[ba].slice(); next[bb] = next[bb].slice();
      const sA = next[ba][idx], sB = next[bb][idx];
      next[ba][idx] = sB ? Object.assign({}, sB, { _startMin: bucketA.startMin, _endMin: bucketA.endMin, _source: 'v2-crossSwap' }) : null;
      next[bb][idx] = sA ? Object.assign({}, sA, { _startMin: bucketB.startMin, _endMin: bucketB.endMin, _source: 'v2-crossSwap' }) : null;
      return next;
    }
    return null;
  }

  // --- bucketExtend: stretch an adjacent activity's _startMin/_endMin to
  //     close a wall-clock gap. Critically, EITHER side can be _fixed
  //     (anchor, special, league) — we only need ONE side to be movable.
  //     E.g. "Neranitas(_fixed) → 25min gap → Chalk Coloring" closes by
  //     extending Chalk Coloring backward, even though Neranitas itself
  //     is fixed.
  function moveBucketExtend(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const slots = schedule[bunk];
      if (!Array.isArray(slots) || slots.length < 2) continue;
      const real = [];
      slots.forEach((s, i) => { if (s && !s.continuation && s._startMin != null) real.push({ s, i }); });
      real.sort((a, b) => a.s._startMin - b.s._startMin);
      const grade = _bunkGrade(bunk, ctx.divisions);
      const candidates = [];
      for (let k = 0; k < real.length - 1; k++) {
        const gap = real[k + 1].s._startMin - real[k].s._endMin;
        if (gap < 10) continue;
        const prev = real[k].s, nxt = real[k + 1].s;
        // Re-introduced X2f-15: period-boundary check on extends. Without
        // this, v2 routinely crosses period boundaries to close gaps
        // (18 violations/gen vs v1 seed's 3). Cost-function approach was
        // too expensive (slowed SA from 86k→44k iters/pass). Move-time
        // check is cheap and only rejects moves that WOULD create new
        // violations beyond what v1 seed already had.
        if (_isMovable(prev) && _staysInPeriod(grade, prev._startMin, nxt._startMin)) {
          candidates.push({ idx: real[k].i, newEnd: nxt._startMin, kind: 'fwd' });
        }
        if (_isMovable(nxt) && _staysInPeriod(grade, prev._endMin, nxt._endMin)) {
          candidates.push({ idx: real[k + 1].i, newStart: prev._endMin, kind: 'back' });
        }
      }
      if (candidates.length === 0) continue;
      const c = candidates[Math.floor(rng() * candidates.length)];
      const slot = slots[c.idx];
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      if (c.kind === 'fwd') {
        next[bunk][c.idx] = Object.assign({}, slot, { _endMin: c.newEnd, _source: 'v2-bucketExtend-fwd' });
      } else {
        next[bunk][c.idx] = Object.assign({}, slot, { _startMin: c.newStart, _source: 'v2-bucketExtend-back' });
      }
      return next;
    }
    return null;
  }

  // --- gapTargeted: scan EVERY bunk for the largest current wall-clock gap,
  //     then specifically attack it with the most promising strategy. This
  //     is the workhorse move when gaps are the dominant cost — it doesn't
  //     waste budget on random changes elsewhere.
  function moveGapTargeted(schedule, ctx, rng) {
    let worstGap = null;
    for (const [bunk, slots] of Object.entries(schedule)) {
      if (!Array.isArray(slots)) continue;
      const real = [];
      slots.forEach((s, i) => { if (s && !s.continuation && s._startMin != null) real.push({ s, i }); });
      real.sort((a, b) => a.s._startMin - b.s._startMin);
      for (let k = 0; k < real.length - 1; k++) {
        const gap = real[k + 1].s._startMin - real[k].s._endMin;
        if (gap > 5 && (!worstGap || gap > worstGap.gap)) {
          worstGap = {
            bunk, gap,
            prevIdx: real[k].i, prevSlot: real[k].s,
            nextIdx: real[k + 1].i, nextSlot: real[k + 1].s,
            gapStart: real[k].s._endMin, gapEnd: real[k + 1].s._startMin
          };
        }
      }
    }
    if (!worstGap) return null;
    // Pick a strategy at random (or in order — random gives diversity)
    const strategies = ['extend-prev', 'extend-next-back', 'replace-prev-with-longer'];
    const strat = strategies[Math.floor(rng() * strategies.length)];
    const next = _cloneSchedule(schedule);
    next[worstGap.bunk] = next[worstGap.bunk].slice();

    const grade = _bunkGrade(worstGap.bunk, ctx.divisions);

    if (strat === 'extend-prev' && _isMovable(worstGap.prevSlot)
        && _staysInPeriod(grade, worstGap.prevSlot._startMin, worstGap.gapEnd)) {
      next[worstGap.bunk][worstGap.prevIdx] = Object.assign({}, worstGap.prevSlot, {
        _endMin: worstGap.gapEnd, _source: 'v2-gapTargeted-extPrev'
      });
      return next;
    }
    if (strat === 'extend-next-back' && _isMovable(worstGap.nextSlot)
        && _staysInPeriod(grade, worstGap.gapStart, worstGap.nextSlot._endMin)) {
      next[worstGap.bunk][worstGap.nextIdx] = Object.assign({}, worstGap.nextSlot, {
        _startMin: worstGap.gapStart, _source: 'v2-gapTargeted-extNext'
      });
      return next;
    }
    if (strat === 'replace-prev-with-longer' && _isMovable(worstGap.prevSlot)
        && _staysInPeriod(grade, worstGap.prevSlot._startMin, worstGap.gapEnd)) {
      const pool = _candidateActivities(grade, ctx);
      const newAct = pool[Math.floor(rng() * pool.length)];
      const newField = _findFieldForActivity(newAct, ctx);
      if (!newField) return null;
      next[worstGap.bunk][worstGap.prevIdx] = {
        field: newField.name, sport: newAct, _activity: newAct,
        _autoMode: true, _autoSolved: true,
        _startMin: worstGap.prevSlot._startMin, _endMin: worstGap.gapEnd,
        _source: 'v2-gapTargeted-replace', continuation: false
      };
      return next;
    }
    return null;
  }

  // --- bucketInsert (atomic with bounded backtracking): splice a NEW bucket
  //     into a wall-clock gap. Tries MULTIPLE candidate activities per call
  //     until one passes a quick local validation (field exists, has the
  //     activity in its hosted list, no obvious field-capacity blowout).
  //     The SA cost function still does the final rule check, but this
  //     pre-filter raises the rate of useful inserts vs random misses.
  function moveBucketInsert(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (!Array.isArray(pbs) || pbs.length < 2) continue;
      // Find gap ≥ 15 min that ALSO lies within a single period (don't
      // insert across period boundaries — that's a known camp rule).
      const gaps = [];
      for (let i = 0; i < pbs.length - 1; i++) {
        const gap = pbs[i + 1].startMin - pbs[i].endMin;
        if (gap < 15) continue;
        const gStart = pbs[i].endMin, gEnd = pbs[i + 1].startMin;
        if (!_staysInPeriod(grade, gStart, gEnd)) continue;
        gaps.push({ afterIdx: i, start: gStart, end: gEnd });
      }
      if (gaps.length === 0) continue;
      const g = gaps[Math.floor(rng() * gaps.length)];
      // Try up to 3 candidate activities for this gap. Limit kept low so
      // each move attempt stays fast — SA iteration count matters more
      // than per-attempt quality once the SA loop is running.
      const pool = _candidateActivities(grade, ctx);
      if (pool.length === 0) continue;
      const shuffled = pool.slice().sort(() => rng() - 0.5).slice(0, 3);
      for (const newAct of shuffled) {
        const newField = _findFieldForActivity(newAct, ctx);
        if (!newField) continue;
        // Quick local validation: is the field accessible to this grade?
        const ar = newField.accessRestrictions;
        if (ar?.enabled) {
          const divs = ar.divisions || {};
          if (!(grade in divs) && !(String(grade) in divs)) continue;
          const allow = divs[grade] || divs[String(grade)];
          if (Array.isArray(allow) && allow.length > 0 && !allow.map(String).includes(String(bunk))) continue;
        }
        // Build the candidate
        const next = _cloneSchedule(schedule);
        next[bunk] = next[bunk].slice();
        next[bunk].splice(g.afterIdx + 1, 0, {
          field: newField.name, sport: newAct, _activity: newAct,
          _autoMode: true, _autoSolved: true,
          _startMin: g.start, _endMin: g.end,
          _source: 'v2-bucketInsert', continuation: false
        });
        return {
          schedule: next,
          bucketPatch: {
            kind: 'insert', grade, bunk,
            idx: g.afterIdx + 1,
            newBucket: { startMin: g.start, endMin: g.end }
          }
        };
      }
    }
    return null;
  }

  // --- bucketDelete (atomic): remove a null/Free bucket entirely so the
  //     bunk's day no longer has a "+Add" slot — useful when the grid was
  //     bloated with buckets the seed couldn't fill.
  function moveBucketDelete(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 10; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      const slots = schedule[bunk];
      if (!Array.isArray(pbs) || !Array.isArray(slots) || pbs.length < 2) continue;
      // Find a null or Free slot whose bucket can be safely removed
      const candidates = [];
      slots.forEach((s, i) => {
        if (!s || s.field === 'Free' || s._activity === 'Free') candidates.push(i);
      });
      if (candidates.length === 0) continue;
      const idx = candidates[Math.floor(rng() * candidates.length)];
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk].splice(idx, 1);
      return {
        schedule: next,
        bucketPatch: { kind: 'delete', grade, bunk, idx }
      };
    }
    return null;
  }

  // --- addChange (atomic): find a Swim block without an adjacent Change,
  //     synthesize a 10-min Change block right before or after it. Closes
  //     the user's reported "swim without change" issue, which is otherwise
  //     un-fixable by v2 because all other moves treat Change/Swim as
  //     immovable.
  //
  //     Insertion requires:
  //       - The 10-min window before/after the Swim is currently empty
  //         (no other activity occupies it)
  //       - The window stays within the bunk's day
  //
  //     The new Change slot is marked _fixed:true (anchor semantics) so
  //     subsequent SA iterations don't try to delete/move it.
  function moveAddChange(schedule, ctx, rng) {
    const CHANGE_DUR = 10; // standard Change block duration
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const slots = schedule[bunk];
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (!Array.isArray(slots) || !Array.isArray(pbs)) continue;
      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null)
        .sort((a, b) => a._startMin - b._startMin);
      // Find a Swim missing adjacent Change
      const swimIdxs = [];
      for (let i = 0; i < real.length; i++) {
        const s = real[i];
        if ((s._activity || '').toLowerCase() !== 'swim') continue;
        const before = real[i - 1];
        const after = real[i + 1];
        const bIsCh = before && /change/i.test(before._activity || '') && before._endMin === s._startMin;
        const aIsCh = after && /change/i.test(after._activity || '') && after._startMin === s._endMin;
        if (!bIsCh && !aIsCh) swimIdxs.push({ swim: s, before, after });
      }
      if (swimIdxs.length === 0) continue;
      const target = swimIdxs[Math.floor(rng() * swimIdxs.length)];
      const swim = target.swim;

      // Try inserting BEFORE the swim (preferred — pre-change is more common)
      let insertStart = swim._startMin - CHANGE_DUR;
      let insertEnd = swim._startMin;
      let insertSide = 'before';
      const conflictBefore = target.before && target.before._endMin > insertStart;
      if (conflictBefore) {
        // Try inserting AFTER the swim instead
        insertStart = swim._endMin;
        insertEnd = swim._endMin + CHANGE_DUR;
        insertSide = 'after';
        const conflictAfter = target.after && target.after._startMin < insertEnd;
        if (conflictAfter) continue; // no room either side
      }
      // Find swim's index in the bunk's slots array (not the sorted real list)
      const swimSlotIdx = slots.findIndex(s => s === swim);
      if (swimSlotIdx < 0) continue;
      const newSlot = {
        field: 'Change', sport: null, _activity: 'Change',
        type: insertSide === 'before' ? 'pre-change' : 'post-change',
        _autoMode: true, _fixed: true, _activityLocked: true,
        _startMin: insertStart, _endMin: insertEnd,
        _source: 'v2-addChange', continuation: false
      };
      // Insertion index in the bunk's slots: before swim → swimSlotIdx,
      // after swim → swimSlotIdx + 1
      const insertIdx = (insertSide === 'before') ? swimSlotIdx : swimSlotIdx + 1;
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk].splice(insertIdx, 0, newSlot);
      // Mirror bucket grid insertion atomically via bucketPatch
      return {
        schedule: next,
        bucketPatch: {
          kind: 'insert', grade, bunk,
          idx: insertIdx,
          newBucket: { startMin: insertStart, endMin: insertEnd }
        }
      };
    }
    return null;
  }

  // --- shiftBlocker: addChange can fail when a non-anchor activity is
  //     occupying the 10-min adjacent window. This move tries to RELOCATE
  //     that blocker to a different time slot so Change can be added.
  //     Operates only on movable activities; gives up if blocker is also
  //     anchor/fixed.
  function moveShiftBlocker(schedule, ctx, rng) {
    const CHANGE_DUR = 10;
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const slots = schedule[bunk];
      if (!Array.isArray(slots)) continue;
      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null)
        .sort((a, b) => a._startMin - b._startMin);
      // Find Swim missing Change AND a movable blocker on at least one side
      const targets = [];
      for (let i = 0; i < real.length; i++) {
        const s = real[i];
        if ((s._activity || '').toLowerCase() !== 'swim') continue;
        const before = real[i - 1];
        const after = real[i + 1];
        const bIsCh = before && /change/i.test(before._activity || '') && before._endMin === s._startMin;
        const aIsCh = after && /change/i.test(after._activity || '') && after._startMin === s._endMin;
        if (bIsCh || aIsCh) continue; // already has Change
        // Identify movable blockers
        if (before && _isMovable(before) && before._endMin > s._startMin - CHANGE_DUR) {
          targets.push({ blockerIdx: slots.findIndex(x => x === before), side: 'before', swim: s });
        }
        if (after && _isMovable(after) && after._startMin < s._endMin + CHANGE_DUR) {
          targets.push({ blockerIdx: slots.findIndex(x => x === after), side: 'after', swim: s });
        }
      }
      if (targets.length === 0) continue;
      const t = targets[Math.floor(rng() * targets.length)];
      if (t.blockerIdx < 0) continue;
      const blocker = slots[t.blockerIdx];
      // Try to find an empty time window in this bunk's day where the blocker fits
      const blockerDur = blocker._endMin - blocker._startMin;
      const dayStart = Math.min(...real.map(r => r._startMin));
      const dayEnd = Math.max(...real.map(r => r._endMin));
      // Build occupied intervals (excluding the blocker we're trying to move)
      const occupied = real
        .filter(r => r !== blocker)
        .map(r => ({ start: r._startMin, end: r._endMin }));
      // Find a free interval of at least blockerDur within day bounds
      const free = [];
      let cursor = dayStart;
      occupied.sort((a, b) => a.start - b.start);
      for (const o of occupied) {
        if (o.start > cursor && o.start - cursor >= blockerDur) {
          free.push({ start: cursor, end: o.start });
        }
        cursor = Math.max(cursor, o.end);
      }
      if (cursor < dayEnd && dayEnd - cursor >= blockerDur) {
        free.push({ start: cursor, end: dayEnd });
      }
      if (free.length === 0) continue;
      const target = free[Math.floor(rng() * free.length)];
      const newStart = target.start;
      const newEnd = newStart + blockerDur;
      // Build candidate: move blocker to new time
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk][t.blockerIdx] = Object.assign({}, blocker, {
        _startMin: newStart, _endMin: newEnd,
        _source: 'v2-shiftBlocker'
      });
      // NOTE: this doesn't insert the Change block itself — addChange will
      // get another shot on a later iteration and find space now. So this
      // move alone won't reduce swimNoChange by 1, but it UNBLOCKS the path
      // for addChange.
      return next;
    }
    return null;
  }

  // --- addBucket (atomic): close per-bunk-slot gaps by SYNTHESIZING a new
  //     bucket of the gap's exact dimensions and assigning a filler-eligible
  //     activity to it. Mirrors moveAddChange's two-step atomic splice
  //     (schedule + bucketPatch).
  //
  //     Why this exists: v1's per-bunk-slot pruning drops sub-dMin slivers
  //     (e.g. 720-730 in Duetos), leaving holes that no other v2 move can
  //     touch because they all operate on EXISTING buckets. Without
  //     addBucket, addressing those holes requires moving the boundaries
  //     of neighboring buckets — which trips period-violation rules.
  //
  //     Detection: scan _perBunkSlots[grade][bunk] for consecutive pairs
  //     where pbs[i+1].startMin > pbs[i].endMin (a per-bunk gap).
  //
  //     Activity selection:
  //       - Use _candidateActivities (same pool as inject/replace)
  //       - Filter by per-bunk-per-day maxUsage check so we don't pick
  //         specials that are already at their cap (rejected by the hard
  //         validator anyway, but this saves SA budget)
  //       - Need a field that lists the activity AND no field-conflict at
  //         the new time (validator catches this — we don't pre-check)
  //
  //     The new bucket is marked _fixed:true so subsequent SA moves don't
  //     try to mutate or delete it (same as addChange's Change blocks).
  function moveAddBucket(schedule, ctx, rng) {
    const MIN_GAP = 5;        // ignore < 5 min — usually period transitions
    const MAX_GAP = 30;       // > 30 min is bucketInsert/extend territory
    const bunks = Object.keys(schedule);

    // Pre-build a specials-by-name lookup once per call so the maxUsage
    // filter is O(1). Specials list is small (< 100 typically), so the
    // micro-optimisation isn't critical, but it keeps the hot path clean.
    const specByName = {};
    (ctx.specials || []).forEach(s => { if (s && s.name) specByName[s.name] = s; });

    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const slots = schedule[bunk];
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (!Array.isArray(slots) || !Array.isArray(pbs) || pbs.length < 2) continue;

      // Find per-bunk-slot gaps. Walk pbs in time order (already sorted by
      // construction) and record any (i, i+1) where there's daylight between
      // the two buckets' boundaries.
      const gaps = [];
      for (let i = 0; i < pbs.length - 1; i++) {
        const cur = pbs[i], nxt = pbs[i + 1];
        if (!cur || !nxt || cur.endMin == null || nxt.startMin == null) continue;
        const span = nxt.startMin - cur.endMin;
        if (span >= MIN_GAP && span <= MAX_GAP) {
          gaps.push({ afterIdx: i, startMin: cur.endMin, endMin: nxt.startMin, dur: span });
        }
      }
      if (gaps.length === 0) continue;

      const gap = gaps[Math.floor(rng() * gaps.length)];

      // Build per-bunk usage map so we can filter out specials already at cap.
      const usage = {};
      for (const s of slots) {
        if (!s || s.continuation || !s._activity) continue;
        const a = String(s._activity);
        usage[a] = (usage[a] || 0) + 1;
      }

      // Build candidate activity list (X2f-18b): SPECIALS ONLY.
      // Sports were rendering purple + below-dMin when inserted here because
      // (a) we tag the new slot _fixed:true (the renderer styles _fixed slots
      // as pinned/special purple) and (b) sports usually have dMin ≥ 25 min
      // while our gap window is 5–30. Restricting the pool to specials means
      // only filler-style activities (Slush/Popcorn/Snack/etc.) can land
      // here. Also enforce that the special's minimum duration fits the gap.
      const pool = _candidateActivities(grade, ctx).filter(act => {
        const spec = specByName[act];
        if (!spec) return false; // skip pure sports — wrong rendering + dMin
        const maxUse = parseInt(spec.maxUsage) || 0;
        if (maxUse > 0 && (usage[act] || 0) >= maxUse) return false;
        const dMin = parseInt(spec.dMin || spec.duration || spec.preferredDuration) || 0;
        if (dMin > 0 && dMin > gap.dur) return false;
        return true;
      });
      if (pool.length === 0) continue;

      // Try up to a few activities; first one with an accessible field wins.
      // Don't iterate the entire pool — keeps the move cheap and SA picks
      // diversity over time.
      const tryActs = pool.slice().sort(() => rng() - 0.5).slice(0, 8);
      let picked = null;
      for (const act of tryActs) {
        const field = _findFieldForActivity(act, ctx);
        if (!field) continue;
        picked = { act, field };
        break;
      }
      if (!picked) continue;

      const newSlot = {
        field: picked.field.name,
        sport: picked.act,
        _activity: picked.act,
        _autoMode: true,
        _autoSolved: true,
        _fixed: true,
        _startMin: gap.startMin,
        _endMin: gap.endMin,
        _source: 'v2-addBucket',
        continuation: false
      };

      // Insert at array-index (gap.afterIdx + 1) so schedule + pbs stay in
      // lockstep. Both arrays grow by 1; all subsequent indices shift up.
      const insertIdx = gap.afterIdx + 1;
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk].splice(insertIdx, 0, newSlot);

      return {
        schedule: next,
        bucketPatch: {
          kind: 'insert', grade, bunk,
          idx: insertIdx,
          newBucket: { startMin: gap.startMin, endMin: gap.endMin }
        }
      };
    }
    return null;
  }

  // --- absorbDeadGap (atomic): close per-bunk gaps that NO filler can occupy
  //     by SWAPPING a neighbor's activity for one whose configured duration
  //     covers the (neighbor-bucket + gap), then EXTENDING the neighbor's
  //     bucket to span both. This honors the user's principle: "20-min
  //     activity in a 30-min slot leaves a 10-min unfillable hole; pick a
  //     different activity (a 30-min one) instead." We do NOT extend any
  //     activity beyond its configured duration — we replace it.
  //
  //     Detection: scan _perBunkSlots[grade][bunk] for consecutive pairs with
  //     a gap, then ask countUnfillableSlivers' eligibility logic whether
  //     ANY filler exists for the gap. If no filler exists → "dead" gap.
  //
  //     Repair candidate: try the slot BEFORE the gap (and then the slot
  //     AFTER) for activities whose configured duration ≥ neighbor.dur + gap.
  //     Cap at neighbor.dur + gap so we don't overshoot the next neighbor.
  //
  //     Atomic via bucketPatch:'extend' so ctx.perBunkSlots stays in lockstep.
  function moveAbsorbDeadGap(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    const specByName = ctx._specialByName || {};
    const fieldByActivity = {};
    (ctx.fields || []).forEach(f => {
      (f.activities || []).forEach(a => {
        if (!fieldByActivity[a]) fieldByActivity[a] = [];
        fieldByActivity[a].push(f);
      });
    });

    function actDuration(actName) {
      const sp = specByName[actName];
      if (sp) {
        const d = parseInt(sp.duration || sp.preferredDuration || sp.dMin) || 0;
        return d;
      }
      // sport: read from layer config if available, else 0 (skip)
      const layers = ctx.layers || [];
      for (const L of layers) {
        if (L && L.activities && L.activities[actName]) {
          const d = parseInt(L.activities[actName].duration || L.activities[actName].dMin) || 0;
          if (d > 0) return d;
        }
      }
      return 0;
    }

    // X2f-18d: return {dMin,dMax} for an activity so we can accept any duration
    // within the activity's legal range, not just its preferred duration.
    // This is NOT "extending beyond duration" — dMax IS the activity's max
    // configured duration; running it at dMax is by-the-book legal.
    function actBounds(actName) {
      const sp = specByName[actName];
      if (sp) {
        const dPref = parseInt(sp.duration || sp.preferredDuration) || 0;
        const dMin = parseInt(sp.dMin) || dPref || 0;
        const dMax = parseInt(sp.dMax) || dPref || dMin;
        return { dMin, dMax, dPref };
      }
      const layers = ctx.layers || [];
      for (const L of layers) {
        if (L && L.activities && L.activities[actName]) {
          const a = L.activities[actName];
          const dPref = parseInt(a.duration) || 0;
          const dMin = parseInt(a.dMin) || dPref || 0;
          const dMax = parseInt(a.dMax) || dPref || dMin;
          return { dMin, dMax, dPref };
        }
      }
      return { dMin: 0, dMax: 0, dPref: 0 };
    }

    // X2f-18d: walls (Lunch/Swim/Change/Cleanup/Main/Shiur) are sacred and
    // never moved. But the Phase 2.5 _autoSpecial fillers (Neranitas/Drama/
    // Ice Cream/etc.) that pinned themselves into dead-gap-creating positions
    // are eligible for swap — otherwise the gaps they created can never close.
    function _isWall(slot) {
      if (!slot) return false;
      const a = String(slot._activity || slot.event || '').toLowerCase();
      return /^(swim|lunch|cleanup|change|pre[-\s]?change|post[-\s]?change|main\s*activity|shiur|dismissal|snack)/i.test(a);
    }
    function _isSwappableForGap(slot) {
      if (!slot) return false;
      if (_isWall(slot)) return false;
      // Skip continuations of multi-slot activities (multi-period specials).
      if (slot.continuation) return false;
      // X2f-18e: NEVER touch user-pinned specials. User-pinned slots have
      // _pinned:true OR _source:'phase0' (configured-time specials with
      // isAnchor) OR _source:'manual'. Only auto-placed Phase 2.5/3 fillers
      // (_autoSpecial / _source:'phase2.5' / 'phase3') are eligible — those
      // are the ones the solver chose freely and that may have created the
      // dead gap by their placement.
      if (slot._pinned === true) return false;
      const src = String(slot._source || '');
      if (src === 'phase0' || src === 'manual' || src === 'user') return false;
      // Movable-by-SA or auto-pinned fillers are fair game.
      return true;
    }

    function gapHasFiller(grade, gap, usage) {
      for (const sp of (ctx.specials || [])) {
        if (!sp || !sp.name) continue;
        if (sp.fullGrade === true) continue;
        const ar = sp.accessRestrictions;
        if (ar && ar.enabled) {
          const divs = ar.divisions || {};
          if (!(grade in divs) && !(String(grade) in divs)) continue;
        }
        const maxUse = parseInt(sp.maxUsage) || 0;
        if (maxUse > 0 && (usage[sp.name] || 0) >= maxUse) continue;
        const dMin = parseInt(sp.dMin || sp.duration || sp.preferredDuration) || 0;
        if (dMin > 0 && dMin > gap) continue;
        return true;
      }
      return false;
    }

    for (let attempt = 0; attempt < 25; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const slots = schedule[bunk];
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (!Array.isArray(slots) || !Array.isArray(pbs) || pbs.length < 2) continue;

      // Per-bunk usage for the filler-availability check.
      const usage = {};
      for (const s of slots) {
        if (!s || s.continuation || !s._activity) continue;
        usage[s._activity] = (usage[s._activity] || 0) + 1;
      }

      // Find dead gaps.
      const deadGaps = [];
      for (let i = 0; i < pbs.length - 1; i++) {
        const cur = pbs[i], nxt = pbs[i + 1];
        if (!cur || !nxt) continue;
        const gap = nxt.startMin - cur.endMin;
        if (gap <= 5 || gap > 45) continue;
        if (gapHasFiller(grade, gap, usage)) continue;
        deadGaps.push({ leftIdx: i, rightIdx: i + 1, startMin: cur.endMin, endMin: nxt.startMin, dur: gap });
      }
      if (deadGaps.length === 0) continue;

      const dg = deadGaps[Math.floor(rng() * deadGaps.length)];

      // Try absorbing into the LEFT neighbor first, then RIGHT.
      for (const side of ['left', 'right']) {
        const nIdx = side === 'left' ? dg.leftIdx : dg.rightIdx;
        const nSlot = slots[nIdx];
        const nBucket = pbs[nIdx];
        if (!nSlot || !nBucket) continue;
        // X2f-18d: walls untouchable, but pinned _autoSpecial that caused
        // the dead gap IS eligible to swap.
        if (!_isSwappableForGap(nSlot)) continue;
        const curDur = nBucket.endMin - nBucket.startMin;
        const targetDur = curDur + dg.dur;
        const newStart = side === 'left' ? nBucket.startMin : dg.startMin;
        const newEnd   = side === 'left' ? dg.endMin       : nBucket.endMin;

        // Must stay within one period of the grade.
        if (!_staysInPeriod(grade, newStart, newEnd)) continue;

        // X2f-18d: accept any activity whose CONFIGURED dMin/dMax range
        // includes targetDur. This is the activity's own legal duration
        // range — running an activity at its dMax is by definition allowed,
        // not "extending beyond duration." If the activity has no flex
        // (dMin==dMax==pref), it only matches exactly, same as before.
        const pool = _candidateActivities(grade, ctx).filter(act => {
          const b = actBounds(act);
          const dPref = b.dPref || b.dMin;
          if (!dPref) return false;
          // targetDur must be within [dMin, dMax]
          if (targetDur < b.dMin || targetDur > b.dMax) return false;
          // accessible field?
          const fs = fieldByActivity[act] || [];
          if (fs.length === 0) return false;
          // maxUsage gate
          const sp = specByName[act];
          if (sp) {
            const maxUse = parseInt(sp.maxUsage) || 0;
            if (maxUse > 0 && (usage[act] || 0) >= maxUse) return false;
          }
          return true;
        });
        if (pool.length === 0) continue;

        const pickAct = pool[Math.floor(rng() * pool.length)];
        const pickField = (fieldByActivity[pickAct] || [])[0];
        if (!pickField) continue;

        const next = _cloneSchedule(schedule);
        next[bunk] = next[bunk].slice();
        next[bunk][nIdx] = {
          field: pickField.name, sport: pickAct, _activity: pickAct,
          _autoMode: true, _autoSolved: true,
          _startMin: newStart, _endMin: newEnd,
          _source: 'v2-absorbDeadGap', continuation: false
        };

        return {
          schedule: next,
          bucketPatch: {
            kind: 'extend', grade, bunk, idx: nIdx,
            newBounds: { startMin: newStart, endMin: newEnd }
          }
        };
      }
    }
    return null;
  }

  // --- (REMOVED X2f-18c) fitDuration: when a movable slot has a non-empty trailing
  //     gap of [10, 45] min, try EXTENDING its _endMin to swallow some of
  //     that gap — provided either:
  //       (a) the extension stays within the slot's period (safe), OR
  //       (b) the extension crosses ONLY a 5-min transition zone (allowed
  //           per X2f-17 trade-off decision), AND
  //       (c) the new bigger duration doesn't leave a NEW unfillable sliver
  //           between the extended slot and its next neighbor.
  //
  //     This is the move that closes "20-min activity stuffed in 30-min
  //     slot" placements — it grows the activity to fit, instead of leaving
  //     the sliver.
  //
  //     Pairs with the unfillableSliver cost term: cost gives signal, this
  //     move provides the corrective action.
  //
  //     Atomic via bucketPatch:'extend' so ctx.perBunkSlots[i].endMin stays
  //     in lockstep with schedule[bunk][i]._endMin.
  function moveFitDuration(schedule, ctx, rng) {
    const MIN_GAP = MIN_FILLER_DUR;  // only bother with gaps ≥ smallest filler
    const MAX_GAP = 45;              // beyond this is addBucket/Insert territory
    const bunks = Object.keys(schedule);

    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const slots = schedule[bunk];
      if (!Array.isArray(slots)) continue;

      // Collect (slot, trailingGap, nextSlot) triples for movable slots.
      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null && s._endMin != null)
        .sort((a, b) => a._startMin - b._startMin);
      const candidates = [];
      for (let i = 0; i < real.length - 1; i++) {
        const cur = real[i], nxt = real[i + 1];
        if (!_isMovable(cur)) continue;
        const gap = nxt._startMin - cur._endMin;
        if (gap < MIN_GAP || gap > MAX_GAP) continue;
        candidates.push({ slot: cur, next: nxt, gap });
      }
      if (candidates.length === 0) continue;

      const pick = candidates[Math.floor(rng() * candidates.length)];

      // How far can we extend? Prefer "absorb the whole gap" but fall back
      // to "absorb everything but a transition-sized tail" if the whole
      // absorption would land us inside the next slot.
      const newEnd = pick.next._startMin;
      const newDur = newEnd - pick.slot._startMin;

      // Period guard (X2f-18b): STRICT — never cross a period boundary.
      // The inter-period transition zones (typically 5 min) are deliberate
      // buffers in the bell schedule, NOT gaps to be absorbed. Earlier
      // experiment with allowing TRANSITION_MAX-sized crossings produced
      // visible transition-zone violations in the rendered grid.
      if (!_staysInPeriod(grade, pick.slot._startMin, newEnd)) continue;

      // Find this slot's actual index in the bunk's slots array
      const slotIdx = slots.findIndex(s => s === pick.slot);
      if (slotIdx < 0) continue;

      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk][slotIdx] = Object.assign({}, pick.slot, {
        _endMin: newEnd,
        _source: 'v2-fitDuration'
      });

      // Atomic bucket-grid patch so ctx.perBunkSlots stays aligned.
      // Find the matching pbs index (by startMin, since slot order matches).
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      let pbsIdx = -1;
      if (Array.isArray(pbs)) {
        pbsIdx = pbs.findIndex(b => b && b.startMin === pick.slot._startMin && b.endMin === pick.slot._endMin);
      }

      return {
        schedule: next,
        bucketPatch: (pbsIdx >= 0) ? {
          kind: 'extend', grade, bunk,
          idx: pbsIdx,
          newBounds: { startMin: pick.slot._startMin, endMin: newEnd }
        } : null
      };
    }
    return null;
  }

  const MOVES = {
    replace:      moveReplace,
    swap:         moveSwap,
    inject:       moveInject,
    relocate:     moveRelocate,
    crossSwap:    moveCrossSwap,
    bucketExtend: moveBucketExtend,
    gapTargeted:  moveGapTargeted,
    bucketInsert: moveBucketInsert,
    bucketDelete: moveBucketDelete,
    addChange:    moveAddChange,
    shiftBlocker: moveShiftBlocker,
    addBucket:    moveAddBucket,
    absorbDeadGap: moveAbsorbDeadGap
  };

  // Weight `gapTargeted` 3x in selection — it's the highest-leverage move
  // when gaps dominate the cost. Other moves still get sampled for diversity.
  // Tuned weights after state-sync fix:
  //   - State-sync bug fixed → bucketInsert no longer risks holes, bump 2 → 4
  //   - bucketExtend works reliably → bump 2 → 3
  //   - gapTargeted is the highest-leverage move → 3 → 4
  //   - moves that don't close gaps (replace/swap/relocate) stay low so SA
  //     doesn't waste budget on equivalent shuffles when gaps remain
  const MOVE_WEIGHTS = {
    replace:      1,
    swap:         0.5,
    inject:       2,
    relocate:    0.5,
    crossSwap:    0.5,
    bucketExtend: 3,
    gapTargeted:  4,
    bucketInsert: 4,
    bucketDelete: 1,
    addChange:    3,    // fixes user-reported swim-without-Change issue
    shiftBlocker: 2,    // unblocks addChange when adjacent space is occupied
    addBucket:    3,    // closes per-bunk-slot gaps that pruning left behind
    absorbDeadGap: 5    // X2f-18c: swaps activity to legitimately fill bucket+gap
  };

  function pickMove(stats, rng, weightMul) {
    const names = Object.keys(MOVES);
    const w = (m) => (MOVE_WEIGHTS[m] ?? 1) * (weightMul?.[m] ?? 1);
    const totalProposes = names.reduce((s, m) => s + (stats.moves[m]?.propose || 0), 0);
    // Phase 1 (warmup): sample by static MOVE_WEIGHTS so moves we believe in
    // a-priori (gapTargeted, inject) get more attempts during early SA.
    // Phase 2 (after each move tried ≥20 times): blend MOVE_WEIGHTS with
    // observed acceptance rate, plus 15% epsilon-greedy exploration.
    if (totalProposes < names.length * 20 || rng() < 0.15) {
      // Static weighted pick (× learned multiplier from Phase F if present)
      const weights = names.map(m => w(m));
      const sum = weights.reduce((a, b) => a + b, 0);
      let r = rng() * sum;
      for (let i = 0; i < names.length; i++) {
        r -= weights[i];
        if (r <= 0) return names[i];
      }
      return names[names.length - 1];
    }
    // Adaptive: rate = (accept + 1) / (propose + 1) * static_weight * learned_mul
    const rates = names.map(m => {
      const ms = stats.moves[m] || { propose: 0, accept: 0 };
      return ((ms.accept + 1) / (ms.propose + 1)) * w(m);
    });
    const sum = rates.reduce((a, b) => a + b, 0);
    let r = rng() * sum;
    for (let i = 0; i < names.length; i++) {
      r -= rates[i];
      if (r <= 0) return names[i];
    }
    return names[names.length - 1];
  }

  // Kick: re-randomize `kickSize` movable slots in random bunks to escape
  // a local minimum. Each kicked slot gets a random valid activity.
  function applyKick(schedule, ctx, rng, kickSize) {
    let kicked = 0;
    let attempts = 0;
    const newSchedule = _cloneSchedule(schedule);
    while (kicked < kickSize && attempts < kickSize * 10) {
      attempts++;
      const result = moveReplace(newSchedule, ctx, rng);
      if (result) {
        // commit into newSchedule by copying back
        for (const k of Object.keys(result)) newSchedule[k] = result[k];
        kicked++;
      }
    }
    return newSchedule;
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
  // Deep-clone perBunkSlots so we can snapshot it alongside `best.schedule`.
  // Each grade has a bunk-keyed map, each bunk maps to an array of bucket
  // objects. We slice the array (shallow) but the bucket objects are
  // primitives-only so reference-sharing is safe.
  function _clonePerBunkSlots(pbs) {
    const out = {};
    for (const [grade, byBunk] of Object.entries(pbs)) {
      out[grade] = {};
      for (const [bunk, arr] of Object.entries(byBunk)) {
        out[grade][bunk] = Array.isArray(arr) ? arr.slice() : arr;
      }
    }
    return out;
  }

  function runSA(seed, ctx) {
    const cfg = ctx.config;
    const rng = mulberry32(cfg.seed);
    const deadline = Date.now() + cfg.timeBudgetMs;

    let current = seed;
    let currentEval = evaluate(current, ctx);
    let best = current;
    let bestEval = currentEval;
    // ★ Snapshot the bucket grid alongside the best schedule. SA mutates
    //   ctx.perBunkSlots cumulatively via accepted patches, so the bucket
    //   grid at gen-end can have MORE buckets than `best.schedule` has
    //   slots — leading to phantom nulls in the audit. Restoring the grid
    //   from this snapshot at SA end fixes the sync.
    let bestPbsSnapshot = _clonePerBunkSlots(ctx.perBunkSlots);

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
        ', sigGaps=' + currentEval.breakdown.sigGaps +
        ', gapMin=' + currentEval.breakdown.gapMin +
        ', repeats=' + currentEval.breakdown.repeats +
        ', swimNoChange=' + currentEval.breakdown.swimNoChange +
        ', periodViol=' + currentEval.breakdown.periodViol +
        ', unfillable=' + (currentEval.breakdown.unfillable ?? 0) +
        ', hardViol=' + currentEval.hardViolations.length + ')');

    while (Date.now() < deadline) {
      stats.iterations++;
      // Linear cooling schedule
      const progress = stats.iterations / 50000; // assumed iters cap
      const T = Math.max(cfg.tempEnd, cfg.tempStart * (1 - progress));

      const moveName = pickMove(stats, rng, cfg.moveWeightMultipliers);
      stats.moves[moveName].propose++;
      const raw = MOVES[moveName](current, ctx, rng);
      const candidate = unwrapCandidate(raw);
      if (!candidate || !candidate.schedule) continue; // move couldn't find a valid local change

      const candidateEval = evaluate(candidate.schedule, ctx);
      const dC = candidateEval.cost - currentEval.cost;

      let accept = false;
      if (dC < 0) accept = true;
      else if (Math.exp(-dC / T) > rng()) accept = true;

      if (accept) {
        // Apply the bucket-grid patch (if any) atomically with the schedule swap
        if (candidate.bucketPatch) {
          applyBucketPatch(ctx, candidate.bucketPatch);
        }
        current = candidate.schedule;
        currentEval = candidateEval;
        stats.accepts++;
        stats.moves[moveName].accept++;
        if (candidateEval.cost < bestEval.cost) {
          best = candidate.schedule;
          bestEval = candidateEval;
          // Snapshot the bucket grid AT THIS MOMENT — must include any
          // patch we just applied.
          bestPbsSnapshot = _clonePerBunkSlots(ctx.perBunkSlots);
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
        // Kick: re-randomize a slice of the schedule and re-evaluate. If the
        // kicked state has lower cost than current, keep it; otherwise accept
        // it anyway to escape (this is the whole point of a kick).
        const kicked = applyKick(current, ctx, rng, cfg.kickSize);
        const kickedEval = evaluate(kicked, ctx);
        current = kicked;
        currentEval = kickedEval;
        if (kickedEval.cost < bestEval.cost) {
          best = kicked; bestEval = kickedEval;
          stats.improvements++;
        }
        stats.stallCount = 0;
        stats.kicks = (stats.kicks || 0) + 1;
      }
    }

    log('SA done. iters=' + stats.iterations +
        ' accepts=' + stats.accepts +
        ' improvements=' + stats.improvements +
        ' final_best_cost=' + bestEval.cost);

    return { best, bestEval, stats, bestPbsSnapshot };
  }

  // -------------------------------------------------------------------------
  // SMART REPAIR — top-level so v3 can call it via SolverV2 API
  // -------------------------------------------------------------------------
  function smartRepairTop(scheduleRef, ctxRef) {
    let totalFixes = 0;
    const MAX_ITERATIONS = 50;
    const passLog = { swimNoChange: 0, gaps: 0, holes: 0 };

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let madeChange = false;

      // Pass 1: swim-no-change
      for (const bunk of Object.keys(scheduleRef)) {
        const slots = scheduleRef[bunk];
        if (!Array.isArray(slots)) continue;
        const grade = _bunkGrade(bunk, ctxRef.divisions);
        if (!grade) continue;
        const real = slots
          .filter(s => s && !s.continuation && s._startMin != null)
          .sort((a, b) => a._startMin - b._startMin);
        for (let i = 0; i < real.length; i++) {
          const s = real[i];
          if ((s._activity || '').toLowerCase() !== 'swim') continue;
          const before = real[i - 1];
          const after = real[i + 1];
          const bIsCh = before && /change/i.test(before._activity || '') && before._endMin === s._startMin;
          const aIsCh = after && /change/i.test(after._activity || '') && after._startMin === s._endMin;
          if (bIsCh || aIsCh) continue;
          const fix = _attemptAddChangeAtTop(scheduleRef, ctxRef, bunk, s);
          if (fix) { madeChange = true; totalFixes++; passLog.swimNoChange++; break; }
        }
        if (madeChange) break;
      }
      if (madeChange) continue;

      // Pass 2: close gaps
      let gapClosed = false;
      for (const bunk of Object.keys(scheduleRef)) {
        if (gapClosed) break;
        const slots = scheduleRef[bunk];
        if (!Array.isArray(slots)) continue;
        const grade = _bunkGrade(bunk, ctxRef.divisions);
        const real = slots
          .filter(s => s && !s.continuation && s._startMin != null)
          .sort((a, b) => a._startMin - b._startMin);
        for (let k = 0; k < real.length - 1; k++) {
          const prev = real[k], nxt = real[k + 1];
          const gap = nxt._startMin - prev._endMin;
          if (gap < 15) continue;
          if (_isMovable(prev) && _staysInPeriod(grade, prev._startMin, nxt._startMin)) {
            const idx = slots.indexOf(prev);
            slots[idx] = Object.assign({}, prev, { _endMin: nxt._startMin, _source: 'v2-repair-extPrev' });
            madeChange = true; gapClosed = true; totalFixes++; passLog.gaps++; break;
          }
          if (_isMovable(nxt) && _staysInPeriod(grade, prev._endMin, nxt._endMin)) {
            const idx = slots.indexOf(nxt);
            slots[idx] = Object.assign({}, nxt, { _startMin: prev._endMin, _source: 'v2-repair-extNext' });
            madeChange = true; gapClosed = true; totalFixes++; passLog.gaps++; break;
          }
        }
      }
      if (madeChange) continue;

      // Pass 3: fill holes
      let holeFilled = false;
      for (const bunk of Object.keys(scheduleRef)) {
        if (holeFilled) break;
        const slots = scheduleRef[bunk];
        if (!Array.isArray(slots)) continue;
        const grade = _bunkGrade(bunk, ctxRef.divisions);
        const pbs = ctxRef.perBunkSlots[grade]?.[bunk];
        if (!Array.isArray(pbs)) continue;
        for (let i = 0; i < pbs.length; i++) {
          const s = slots[i];
          if (s && s.field !== 'Free' && s._activity !== 'Free') continue;
          const bucket = pbs[i];
          if (!bucket) continue;
          const pool = _candidateActivities(grade, ctxRef);
          for (const act of pool.slice(0, 5)) {
            const field = _findFieldForActivity(act, ctxRef);
            if (!field) continue;
            slots[i] = {
              field: field.name, sport: act, _activity: act,
              _autoMode: true, _autoSolved: true, _fixed: true,
              _startMin: bucket.startMin, _endMin: bucket.endMin,
              _source: 'v2-repair-fillHole', continuation: false
            };
            madeChange = true; holeFilled = true; totalFixes++; passLog.holes++; break;
          }
          if (holeFilled) break;
        }
      }
      if (madeChange) continue;
      break;
    }
    log('Smart repair: ' + totalFixes + ' total fixes ' +
        '(swim-no-change=' + passLog.swimNoChange +
        ', gaps=' + passLog.gaps +
        ', holes=' + passLog.holes + ')');
    return totalFixes;
  }

  function _attemptAddChangeAtTop(schedule, ctx, bunk, swim) {
    const CHANGE_DUR = 10;
    const slots = schedule[bunk];
    const grade = _bunkGrade(bunk, ctx.divisions);
    if (!grade || !Array.isArray(slots)) return false;
    const real = slots
      .filter(s => s && !s.continuation && s._startMin != null)
      .sort((a, b) => a._startMin - b._startMin);
    const swimIdx = real.findIndex(r => r === swim);
    const before = real[swimIdx - 1];
    const after = real[swimIdx + 1];
    const beforeStart = swim._startMin - CHANGE_DUR;
    const beforeEnd = swim._startMin;
    if (!before || before._endMin <= beforeStart) {
      const swimSlotIdx = slots.findIndex(s => s === swim);
      if (swimSlotIdx < 0) return false;
      slots.splice(swimSlotIdx, 0, {
        field: 'Change', sport: null, _activity: 'Change',
        type: 'pre-change', _autoMode: true, _fixed: true, _activityLocked: true,
        _startMin: beforeStart, _endMin: beforeEnd,
        _source: 'v2-repair-addChange-pre', continuation: false
      });
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (Array.isArray(pbs)) pbs.splice(swimSlotIdx, 0, { startMin: beforeStart, endMin: beforeEnd });
      return true;
    }
    const afterStart = swim._endMin;
    const afterEnd = swim._endMin + CHANGE_DUR;
    if (!after || after._startMin >= afterEnd) {
      const swimSlotIdx = slots.findIndex(s => s === swim);
      if (swimSlotIdx < 0) return false;
      slots.splice(swimSlotIdx + 1, 0, {
        field: 'Change', sport: null, _activity: 'Change',
        type: 'post-change', _autoMode: true, _fixed: true, _activityLocked: true,
        _startMin: afterStart, _endMin: afterEnd,
        _source: 'v2-repair-addChange-post', continuation: false
      });
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (Array.isArray(pbs)) pbs.splice(swimSlotIdx + 1, 0, { startMin: afterStart, endMin: afterEnd });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // PUBLIC ENTRY
  // -------------------------------------------------------------------------
  window.runAutoSchedulerV2 = async function (layers, options) {
    try { window.__v2FlowDiag = { v2Entered: Date.now() }; } catch (_eEntry) {}
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

    // -------------------------------------------------------------------
    // SMART REPAIR ENGINE — runs AFTER SA finds a good neighborhood
    // -------------------------------------------------------------------
    // SA is "dumb" optimization: random move, accept if better. It finds
    // good schedules but leaves residual issues (swim-no-change, gaps,
    // period violations) that are hard to fix randomly.
    //
    // This repair engine is targeted and deterministic:
    //   - Scans the schedule for KNOWN issue types
    //   - Applies the RIGHT fix for each (not random)
    //   - Iterates until stable (no more fixes available)
    //
    // Each repair pass returns true if it changed something. The loop
    // continues until a full pass produces zero changes.
    function smartRepair(scheduleRef, ctxRef) {
      let totalFixes = 0;
      const MAX_ITERATIONS = 50;
      const passLog = { swimNoChange: 0, gaps: 0, holes: 0 };

      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        let madeChange = false;

        // ─── Pass 1: Fix swim-no-change ──────────────────────────────────
        // For each Swim missing a Change block, try addChange. If that fails
        // due to blocker, try shiftBlocker followed by addChange.
        for (const bunk of Object.keys(scheduleRef)) {
          const slots = scheduleRef[bunk];
          if (!Array.isArray(slots)) continue;
          const grade = _bunkGrade(bunk, ctxRef.divisions);
          if (!grade) continue;
          const real = slots
            .filter(s => s && !s.continuation && s._startMin != null)
            .sort((a, b) => a._startMin - b._startMin);
          for (let i = 0; i < real.length; i++) {
            const s = real[i];
            if ((s._activity || '').toLowerCase() !== 'swim') continue;
            const before = real[i - 1];
            const after = real[i + 1];
            const bIsCh = before && /change/i.test(before._activity || '') && before._endMin === s._startMin;
            const aIsCh = after && /change/i.test(after._activity || '') && after._startMin === s._endMin;
            if (bIsCh || aIsCh) continue;
            // Try addChange before this swim
            const fix = _attemptAddChangeAt(scheduleRef, ctxRef, bunk, s);
            if (fix) {
              madeChange = true;
              totalFixes++;
              passLog.swimNoChange++;
              break; // restart bunk to recompute `real`
            }
          }
          if (madeChange) break;
        }
        if (madeChange) continue; // restart outer loop

        // ─── Pass 2 (DISABLED X2f-18c): was "extend prev/next to close gap"
        // but this stretched activities beyond their configured duration AND
        // mutated schedule._endMin without updating ctx.perBunkSlots, causing
        // schedule↔bucket desync that mis-rendered rows. The legitimate
        // gap-closer is moveAbsorbDeadGap (SA-driven) which both swaps the
        // activity AND patches the bucket atomically.
        //

        // ─── Pass 3: Fill any remaining null/Free slots with best activity ─
        let holeFilled = false;
        for (const bunk of Object.keys(scheduleRef)) {
          if (holeFilled) break;
          const slots = scheduleRef[bunk];
          if (!Array.isArray(slots)) continue;
          const grade = _bunkGrade(bunk, ctxRef.divisions);
          const pbs = ctxRef.perBunkSlots[grade]?.[bunk];
          if (!Array.isArray(pbs)) continue;
          for (let i = 0; i < pbs.length; i++) {
            const s = slots[i];
            if (s && s.field !== 'Free' && s._activity !== 'Free') continue;
            const bucket = pbs[i];
            if (!bucket) continue;
            const pool = _candidateActivities(grade, ctxRef);
            for (const act of pool.slice(0, 5)) {
              const field = _findFieldForActivity(act, ctxRef);
              if (!field) continue;
              slots[i] = {
                field: field.name, sport: act, _activity: act,
                _autoMode: true, _autoSolved: true, _fixed: true,
                _startMin: bucket.startMin, _endMin: bucket.endMin,
                _source: 'v2-repair-fillHole', continuation: false
              };
              madeChange = true;
              holeFilled = true;
              totalFixes++;
              passLog.holes++;
              break;
            }
            if (holeFilled) break;
          }
        }
        if (madeChange) continue;

        // No changes this iteration — converged
        break;
      }

      log('Smart repair: ' + totalFixes + ' total fixes ' +
          '(swim-no-change=' + passLog.swimNoChange +
          ', gaps=' + passLog.gaps +
          ', holes=' + passLog.holes + ')');
      return totalFixes;
    }

    // Helper for repair: try to add a Change block before or after a Swim.
    // Returns true if successful, false if blocked.
    function _attemptAddChangeAt(schedule, ctx, bunk, swim) {
      const CHANGE_DUR = 10;
      const slots = schedule[bunk];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade || !Array.isArray(slots)) return false;
      const real = slots
        .filter(s => s && !s.continuation && s._startMin != null)
        .sort((a, b) => a._startMin - b._startMin);
      const swimIdx = real.findIndex(r => r === swim);
      const before = real[swimIdx - 1];
      const after = real[swimIdx + 1];
      // Try BEFORE: from swim.startMin - 10 to swim.startMin
      const beforeStart = swim._startMin - CHANGE_DUR;
      const beforeEnd = swim._startMin;
      if (!before || before._endMin <= beforeStart) {
        // Space is free. Insert.
        const swimSlotIdx = slots.findIndex(s => s === swim);
        if (swimSlotIdx < 0) return false;
        slots.splice(swimSlotIdx, 0, {
          field: 'Change', sport: null, _activity: 'Change',
          type: 'pre-change', _autoMode: true, _fixed: true, _activityLocked: true,
          _startMin: beforeStart, _endMin: beforeEnd,
          _source: 'v2-repair-addChange-pre', continuation: false
        });
        const pbs = ctx.perBunkSlots[grade]?.[bunk];
        if (Array.isArray(pbs)) pbs.splice(swimSlotIdx, 0, { startMin: beforeStart, endMin: beforeEnd });
        return true;
      }
      // Try AFTER
      const afterStart = swim._endMin;
      const afterEnd = swim._endMin + CHANGE_DUR;
      if (!after || after._startMin >= afterEnd) {
        const swimSlotIdx = slots.findIndex(s => s === swim);
        if (swimSlotIdx < 0) return false;
        slots.splice(swimSlotIdx + 1, 0, {
          field: 'Change', sport: null, _activity: 'Change',
          type: 'post-change', _autoMode: true, _fixed: true, _activityLocked: true,
          _startMin: afterStart, _endMin: afterEnd,
          _source: 'v2-repair-addChange-post', continuation: false
        });
        const pbs = ctx.perBunkSlots[grade]?.[bunk];
        if (Array.isArray(pbs)) pbs.splice(swimSlotIdx + 1, 0, { startMin: afterStart, endMin: afterEnd });
        return true;
      }
      return false;
    }

    // ★ v2.1: Multi-start is OFF by default (cfg.multiStart).
    // Pass2 never beat pass1 on real data — both converge to the same local
    // minimum because the seed dominates. Skipping pass2 cuts SA time in
    // half. Re-enable via globalSettings.app1.solverV2MultiStart = true if
    // a use case ever benefits from it.
    let best, bestEval, stats, bestPbsSnapshot;
    if (cfg.multiStart) {
      // CRITICAL: snapshot ctx.perBunkSlots BEFORE pass1 so we can restore it
      // for pass2's start state. Without this, bucketInsert mutations from
      // pass1 carry into pass2's seed → phantom holes.
      const halfBudget = Math.floor(cfg.timeBudgetMs / 2);
      const preMultiStartPbs = _clonePerBunkSlots(ctx.perBunkSlots);
      cfg.timeBudgetMs = halfBudget;
      const pass1 = runSA(seed, ctx);
      for (const [grade, byBunk] of Object.entries(preMultiStartPbs)) {
        ctx.perBunkSlots[grade] = byBunk;
      }
      cfg.seed = (cfg.seed + 0x9E3779B9) | 0;
      const pass2 = runSA(seed, ctx);
      cfg.timeBudgetMs = halfBudget * 2;

      if (pass1.bestEval.cost <= pass2.bestEval.cost) {
        ({ best, bestEval, stats, bestPbsSnapshot } = pass1);
        log('Multi-start: pass1 won (' + pass1.bestEval.cost + ' < ' + pass2.bestEval.cost + ')');
      } else {
        ({ best, bestEval, stats, bestPbsSnapshot } = pass2);
        log('Multi-start: pass2 won (' + pass2.bestEval.cost + ' < ' + pass1.bestEval.cost + ')');
      }
    } else {
      // Single SA pass — uses the full time budget.
      const single = runSA(seed, ctx);
      ({ best, bestEval, stats, bestPbsSnapshot } = single);
    }

    // Commit the best schedule back to window.scheduleAssignments,
    // AND restore the bucket grid to its state at the moment `best` was
    // captured. This prevents phantom nulls caused by post-best inserts.
    window.scheduleAssignments = best;
    if (bestPbsSnapshot) {
      for (const [grade, byBunk] of Object.entries(bestPbsSnapshot)) {
        if (!window.divisionTimes?.[grade]) continue;
        window.divisionTimes[grade]._perBunkSlots = byBunk;
      }
      // Mirror to ctx so repair pass sees the same state
      ctx.perBunkSlots = bestPbsSnapshot;
    }

    try { window.__v2FlowDiag = (window.__v2FlowDiag || {}); window.__v2FlowDiag.beforeSmartRepair = Date.now(); } catch (_e1) {}
    // ★ SMART REPAIR — directed, deterministic fixes for residual issues.
    //   SA finds a good neighborhood; repair polishes specific violations.
    try { smartRepair(window.scheduleAssignments, ctx); } catch (_eSR) { try { window.__v2FlowDiag.smartRepairError = String(_eSR && _eSR.message); window.__v2FlowDiag.smartRepairStack = String(_eSR && _eSR.stack); } catch (_e2) {} }
    try { window.__v2FlowDiag.afterSmartRepair = Date.now(); } catch (_e3) {}

    // ★ FIELD QUALITY GROUPS re-optimization (rules.js) — runs AFTER SA + repair,
    //   because v2 rebuilds the schedule and would otherwise discard the v1 seed's
    //   field-quality moves. Pull each grouped-field sport block to a strictly
    //   better-ranked field in its group when that field hosts the sport, can be
    //   shared (same activity + same grade, within capacity), and the move adds NO
    //   hard violation (validated via detectHardViolations → access/time/capacity/
    //   sharing/cooldown/sport-cap). No-op when no field groups are configured.
    try {
      (function _fqReoptV2() {
        const flds = ctx.fields || [];
        const fgMap = {}, fgGroups = {}, hostsBySport = {}, capMap = {};
        flds.forEach(function (f) {
          if (!f || !f.name) return;
          (f.activities || []).forEach(function (sp) { (hostsBySport[sp] = hostsBySport[sp] || []).push(f.name); });
          capMap[f.name] = parseInt(f.sharableWith && f.sharableWith.capacity) || parseInt(f.capacity)
            || ((f.sharableWith && f.sharableWith.type === 'not_sharable') ? 1 : 2);
          if (f.fieldGroup && f.qualityRank) {
            fgMap[f.name] = { group: f.fieldGroup, rank: parseInt(f.qualityRank) || 999 };
            (fgGroups[f.fieldGroup] = fgGroups[f.fieldGroup] || []).push({ name: f.name, rank: parseInt(f.qualityRank) || 999 });
          }
        });
        if (Object.keys(fgGroups).length === 0) return;
        Object.keys(fgGroups).forEach(function (gn) { fgGroups[gn].sort(function (a, b) { return a.rank - b.rank; }); });

        const sched = window.scheduleAssignments || {};
        const bunkGrade = {};
        for (const [g, info] of Object.entries(ctx.divisions || {})) { (info.bunks || []).forEach(function (b) { bunkGrade[String(b)] = g; }); }
        const occ = {};
        Object.keys(sched).forEach(function (b) {
          (sched[b] || []).forEach(function (s) {
            if (!s || s.continuation || !s.field || s.field === 'Free') return;
            const st = s._startMin, en = s._endMin; if (st == null || en == null) return;
            (occ[s.field] = occ[s.field] || []).push({ s: st, e: en, bunk: String(b), act: s._activity });
          });
        });
        function canUse(field, s, e, exclBunk, myGrade, myAct) {
          const list = occ[field] || []; let n = 0, ok = true;
          for (let i = 0; i < list.length; i++) {
            const iv = list[i];
            if (iv.bunk === exclBunk) continue;
            if (iv.s >= e || iv.e <= s) continue;
            n++; if (bunkGrade[iv.bunk] !== myGrade || iv.act !== myAct) ok = false;
          }
          if (n === 0) return true;
          return ok && n < (capMap[field] || 2);
        }

        // Seniority (camp-structure age order) — process senior grades first so
        // they claim better-ranked fields before juniors.
        const _senMap = {};
        try {
          const _a1 = (window.loadGlobalSettings ? (window.loadGlobalSettings().app1 || {}) : {});
          const _ord = (Array.isArray(_a1.manualColumnOrder) && _a1.manualColumnOrder.length) ? _a1.manualColumnOrder.slice() : Object.keys(ctx.divisions || {});
          const _dir = _a1.divisionAgeDirection || 'youngToOld';
          const _N = _ord.length;
          _ord.forEach(function (nm, i) { _senMap[nm] = (_dir === 'oldToYoung') ? (_N - 1 - i) : i; });
        } catch (_eS) {}
        const _sen = function (gr) { const v = _senMap[gr]; return (v == null) ? -1 : v; };
        let baseline = detectHardViolations(sched, ctx).length;
        let moved = 0;
        const _bunkOrder = Object.keys(sched).sort(function (a, b) { return _sen(bunkGrade[String(b)]) - _sen(bunkGrade[String(a)]); });
        for (const bunk of _bunkOrder) {
          const slots = sched[bunk]; if (!Array.isArray(slots)) continue;
          const bs = String(bunk), grade = bunkGrade[bs];
          for (const s of slots) {
            if (!s || s.continuation || !s.field || s.field === 'Free') continue;
            const cur = fgMap[s.field]; if (!cur) continue;
            const sport = s._activity; if (!sport) continue;
            const st = s._startMin, en = s._endMin; if (st == null || en == null) continue;
            const members = fgGroups[cur.group];
            for (let i = 0; i < members.length; i++) {
              const m = members[i];
              if (m.rank >= cur.rank) break;
              if (m.name === s.field) continue;
              if ((hostsBySport[sport] || []).indexOf(m.name) < 0) continue;
              if (!canUse(m.name, st, en, bs, grade, sport)) continue;
              const from = s.field;
              s.field = m.name;
              const v = detectHardViolations(sched, ctx).length;
              if (v <= baseline) {
                baseline = v; s._fqMoved = true;
                const fl = occ[from]; if (fl) { for (let k = 0; k < fl.length; k++) { if (fl[k].bunk === bs && fl[k].s === st && fl[k].e === en) { fl.splice(k, 1); break; } } }
                (occ[m.name] = occ[m.name] || []).push({ s: st, e: en, bunk: bs, act: sport });
                moved++; break;
              }
              s.field = from; // would add a hard violation → revert
            }
          }
        }
        // PHASE B — seniority re-pair: within each (group, exact time window), give
        // the most senior grade the best-ranked field. Reassign fields among the
        // co-located group placements (each hosts the activity), then validate via
        // detectHardViolations and revert if it adds any hard violation.
        const _slotMap = {};
        for (const _bk of Object.keys(sched)) {
          const _sl = sched[_bk]; if (!Array.isArray(_sl)) continue;
          for (const _s of _sl) {
            if (!_s || _s.continuation || !_s.field || _s.field === 'Free') continue;
            const _fg = fgMap[_s.field]; if (!_fg) continue;
            const _st = _s._startMin, _en = _s._endMin; if (_st == null || _en == null) continue;
            (_slotMap[_fg.group + '|' + _st + '|' + _en] = _slotMap[_fg.group + '|' + _st + '|' + _en] || []).push({ s: _s, field: _s.field, grade: bunkGrade[String(_bk)] });
          }
        }
        Object.keys(_slotMap).forEach(function (key) {
          const list = _slotMap[key];
          if (list.length < 2) return;
          const bySen = list.slice().sort(function (a, b) { return _sen(b.grade) - _sen(a.grade); }); // most senior first
          const fieldsByRank = list.map(function (p) { return p.field; }).sort(function (a, b) { return fgMap[a].rank - fgMap[b].rank; }); // best rank first
          let anyChange = false, hostOk = true;
          for (let i = 0; i < bySen.length; i++) {
            if ((hostsBySport[bySen[i].s._activity] || []).indexOf(fieldsByRank[i]) < 0) hostOk = false;
            if (bySen[i].s.field !== fieldsByRank[i]) anyChange = true;
          }
          if (!anyChange || !hostOk) return;
          const orig = bySen.map(function (p) { return p.s.field; });
          for (let i = 0; i < bySen.length; i++) bySen[i].s.field = fieldsByRank[i];
          const v = detectHardViolations(sched, ctx).length;
          if (v <= baseline) { baseline = v; for (let i = 0; i < bySen.length; i++) bySen[i].s._fqMoved = true; moved++; }
          else { for (let i = 0; i < bySen.length; i++) bySen[i].s.field = orig[i]; }
        });
        try { console.log('[FQ-REOPT-v2] groups=' + Object.keys(fgGroups).length + ', moved=' + moved); } catch (_e) {}
        try { window.__v2FlowDiag.fqReoptCompleted = Date.now(); window.__v2FlowDiag.fqGroupsCount = Object.keys(fgGroups).length; window.__v2FlowDiag.fqMoved = moved; } catch (_eD) {}
      })();
    } catch (_eFQ2) { try { window.__v2FlowDiag.fqReoptError = String(_eFQ2 && _eFQ2.message); window.__v2FlowDiag.fqReoptStack = String(_eFQ2 && _eFQ2.stack); } catch (_eD2) {} }
    try { window.__v2FlowDiag.beforePairingReopt = Date.now(); } catch (_e4) {}

    // ★ FORCED BUNK-PAIRING tag pass — re-validates and re-tags pairs after SA.
    //   v1's `_pairingReopt` already tags pairs as `_pinned` before v2 reads the
    //   seed, and `_isMovable` honors `_pinned` so SA does not break pairs. This
    //   pass re-verifies on the final v2 state: scans for same-grade/same-sport/
    //   same-time/same-field block clusters where any member is under the sport's
    //   minPlayers and the combined size meets it; tags each member `_pinned`+
    //   `_pairLock`. Self-healing if some new co-location formed during SA.
    try {
      (function _pairingReoptV2() {
        try { window.__pairingV2Diag = { started: true, ts: Date.now(), ctxKeys: ctx ? Object.keys(ctx) : null }; } catch (_eD) {}
        const sched = window.scheduleAssignments || {};
        const bunkGradeP = {};
        for (const [g, info] of Object.entries(ctx.divisions || {})) { (info.bunks || []).forEach(function (b) { bunkGradeP[String(b)] = g; }); }
        try { window.__pairingV2Diag.bunkGradeCount = Object.keys(bunkGradeP).length; window.__pairingV2Diag.divisionsKeys = Object.keys(ctx.divisions || {}); } catch (_eD2) {}
        const _sizeMap = (ctx._bunkSize || {});
        function _szOfV2(b) {
          if (typeof _sizeMap[b] === 'number') return _sizeMap[b];
          try {
            const bmd = window.getBunkMetaData && window.getBunkMetaData();
            if (bmd && bmd[b] && typeof bmd[b].size === 'number') return bmd[b].size;
          } catch (_e) {}
          return 0;
        }
        const sm = ctx.sportMetaData || (typeof window.getSportMetaData === 'function' ? window.getSportMetaData() : (window.sportMetaData || {}));
        function _reqsOf(sport) {
          const m = sm && sm[sport];
          if (!m) return null;
          return { minPlayers: m.minPlayers || null, maxPlayers: m.maxPlayers || null };
        }
        const slotIdxV2 = {};
        Object.keys(sched).forEach(function (b) {
          (sched[b] || []).forEach(function (s, i) {
            if (!s || s.continuation || !s.field || s.field === 'Free') return;
            const sport = s._activity || s.sport;
            if (!sport) return;
            const st = s._startMin, en = s._endMin;
            if (st == null || en == null) return;
            const g = bunkGradeP[String(b)];
            if (!g) return;
            const key = g + '|' + sport + '|' + st + '|' + en + '|' + s.field;
            (slotIdxV2[key] = slotIdxV2[key] || []).push({ bunk: String(b), idx: i, slot: s });
          });
        });
        let pairedTaggedV2 = 0, underMinSoloV2 = 0;
        Object.keys(slotIdxV2).forEach(function (key) {
          const entries = slotIdxV2[key];
          if (entries.length < 2) return;
          const sportName = key.split('|')[1];
          const reqs = _reqsOf(sportName);
          if (!reqs || !reqs.minPlayers) return;
          let combined = 0, anyUnder = false;
          for (let i = 0; i < entries.length; i++) {
            const sz = _szOfV2(entries[i].bunk);
            combined += sz;
            if (sz < reqs.minPlayers) anyUnder = true;
          }
          if (!anyUnder) return;
          if (combined < reqs.minPlayers) return;
          if (reqs.maxPlayers && combined > reqs.maxPlayers) return;
          for (let j = 0; j < entries.length; j++) {
            entries[j].slot._pinned = true;
            entries[j].slot._pairLock = true;
            entries[j].slot._pairCombinedSize = combined;
            pairedTaggedV2++;
          }
        });
        Object.keys(sched).forEach(function (b) {
          (sched[b] || []).forEach(function (s) {
            if (!s || s.continuation || !s.field || s.field === 'Free') return;
            if (s._pairLock) return;
            const sport = s._activity || s.sport;
            if (!sport) return;
            const reqs = _reqsOf(sport);
            if (!reqs || !reqs.minPlayers) return;
            if (_szOfV2(String(b)) >= reqs.minPlayers) return;
            underMinSoloV2++;
          });
        });
        try { console.log('[PAIRING-REOPT-v2] pairedHalvesTagged=' + pairedTaggedV2 + ', underMinSolo=' + underMinSoloV2); } catch (_eL) {}
        try { window.__pairingV2Diag.completed = true; window.__pairingV2Diag.pairedTagged = pairedTaggedV2; window.__pairingV2Diag.underMinSolo = underMinSoloV2; window.__pairingV2Diag.slotIdxKeyCount = Object.keys(slotIdxV2).length; } catch (_eD3) {}
      })();
    } catch (_ePR2) { try { window.__pairingV2Diag = window.__pairingV2Diag || {}; window.__pairingV2Diag.error = String(_ePR2 && _ePR2.message || _ePR2); window.__pairingV2Diag.errorStack = String(_ePR2 && _ePR2.stack || ''); } catch (_eD4) {} }

    // ★ Day 22.5+ FINAL NULL BACKFILL — guarantee 100% fill rate.
    //   smartRepair's Pass 3 tries to fill nulls with real activities, but
    //   gives up if no top-5 activity has a valid field for the slot. That
    //   leaves trailing nulls at end-of-day for some bunks, which the
    //   renderer paints as "+ Add" cells. This pass walks every bunk's slot
    //   grid and forces any remaining nulls to a Free placeholder so the
    //   grid is 100% filled and the user never sees "+ Add" gaps.
    (function _finalNullBackfill() {
      try {
        const sa = window.scheduleAssignments || {};
        let filledFree = 0, filledReal = 0, scanned = 0;
        for (const [grade, gradePbs] of Object.entries(ctx.perBunkSlots || {})) {
          for (const [bunk, pbsArr] of Object.entries(gradePbs || {})) {
            if (!Array.isArray(pbsArr)) continue;
            let slots = sa[bunk];
            if (!Array.isArray(slots)) {
              slots = new Array(pbsArr.length).fill(null);
              sa[bunk] = slots;
            }
            // Extend slots to pbs length if short, truncate if longer than pbs
            while (slots.length < pbsArr.length) slots.push(null);
            if (slots.length > pbsArr.length) slots.length = pbsArr.length;
            for (let i = 0; i < pbsArr.length; i++) {
              scanned++;
              if (slots[i]) continue;
              const b = pbsArr[i];
              if (!b || b.startMin == null || b.endMin == null) continue;
              // Try a real activity first via smartRepair candidate helper
              let placed = null;
              try {
                const pool = (typeof _candidateActivities === 'function')
                  ? _candidateActivities(grade, ctx) : [];
                for (const act of pool.slice(0, 8)) {
                  const field = (typeof _findFieldForActivity === 'function')
                    ? _findFieldForActivity(act, ctx) : null;
                  if (!field) continue;
                  placed = {
                    field: field.name || field, sport: act, _activity: act,
                    _autoMode: true, _autoSolved: true, _fixed: true,
                    _startMin: b.startMin, _endMin: b.endMin,
                    _source: 'v2-final-backfill', continuation: false
                  };
                  break;
                }
              } catch (_e1) { /* fall through to Free */ }
              if (placed) { slots[i] = placed; filledReal++; }
              else {
                slots[i] = {
                  field: 'Free', sport: null, _activity: 'Free',
                  _autoMode: true, _fixed: true,
                  _startMin: b.startMin, _endMin: b.endMin,
                  _source: 'v2-final-backfill-free', continuation: false
                };
                filledFree++;
              }
            }
          }
        }
        log('Final null backfill: scanned=' + scanned + ' filledReal=' + filledReal + ' filledFree=' + filledFree);
      } catch (eB) {
        warn('Final null backfill error: ' + (eB && eB.message));
      }
    })();

    // ★ Day 22.5 IRON GATE: final scrub for DA Resources daily time rules.
    //   No matter which path (V1, safety net, V2 SA moves, smartRepair, null
    //   bucket finalizer) placed something, this final pass clears any slot
    //   that overlaps an Unavailable window or falls outside an Available
    //   window for its grade. Guarantees 100% time-rule accuracy.
    (function _ironGateTimeRules() {
      try {
        function _getDaily(fieldName) {
          try {
            // ★ Day 22.5: PRIMARY source — dedicated iron-gate key (no solver path touches it).
            const dk = window.currentScheduleDate || '';
            if (dk) {
              const enf = localStorage.getItem('campTimeRulesEnforce_' + dk);
              if (enf) {
                const parsed = JSON.parse(enf);
                const r = parsed?.[fieldName];
                if (Array.isArray(r) && r.length > 0) return r;
              }
            }
            // Secondary sources (may be wiped by solver paths)
            const ap = window.activityProperties?.[fieldName]?.timeRules;
            if (Array.isArray(ap) && ap.length > 0) return ap;
            const dd = (window.loadCurrentDailyData?.()?.dailyFieldAvailability || {})[fieldName];
            if (Array.isArray(dd) && dd.length > 0) return dd;
            if (dk) {
              const stored = localStorage.getItem('campResourceOverrides_' + dk);
              if (stored) {
                const parsed = JSON.parse(stored);
                const ls = parsed?.dailyFieldAvailability?.[fieldName];
                if (Array.isArray(ls) && ls.length > 0) return ls;
              }
            }
          } catch (_e) {}
          return null;
        }
        const sa = window.scheduleAssignments || {};
        const divs = window.divisions || {};
        let cleared = 0;
        for (const [bunk, slots] of Object.entries(sa)) {
          if (!Array.isArray(slots)) continue;
          let grade = null;
          for (const [d, info] of Object.entries(divs)) {
            if ((info.bunks || []).includes(bunk)) { grade = d; break; }
          }
          for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (!s || s.continuation) continue;
            const field = (typeof s.field === 'object') ? s.field?.name : s.field;
            if (!field || field === 'Free') continue;
            const sMin = s._startMin, eMin = s._endMin;
            if (sMin == null || eMin == null) continue;
            const rules = _getDaily(field);
            if (!Array.isArray(rules) || rules.length === 0) continue;
            let bad = false;
            let hasAvail = false, inside = false;
            for (const r of rules) {
              const t = String(r.type || '').toLowerCase();
              const isUnavail = t === 'unavailable' || r.available === false;
              const isAvail = t === 'available' || r.available === true;
              const rs = r.startMin ?? null, re = r.endMin ?? null;
              if (rs == null || re == null) continue;
              if (Array.isArray(r.divisions) && r.divisions.length > 0
                  && grade != null && !r.divisions.map(String).includes(String(grade))) continue;
              if (isUnavail && rs < eMin && re > sMin) { bad = true; break; }
              if (isAvail) { hasAvail = true; if (sMin >= rs && eMin <= re) inside = true; }
            }
            if (!bad && hasAvail && !inside) bad = true;
            if (bad) {
              slots[i] = {
                field: 'Free', sport: null, _activity: 'Free',
                _autoMode: true, _fixed: true,
                _startMin: sMin, _endMin: eMin,
                _source: 'iron-gate-time-rule',
                _violationReason: 'DA time rule on ' + field,
                continuation: false
              };
              cleared++;
            }
          }
        }
        if (cleared > 0) console.warn('[V2 IRON GATE] cleared ' + cleared + ' time-rule violation(s)');
      } catch (e) { console.warn('[V2 IRON GATE] error: ' + e.message); }
    })();

    // ★ INVARIANT CHECK (X2f-18c): schedule[bunk][i] and perBunkSlots[grade][bunk][i]
    //   MUST be index-aligned at the same start/end. The renderer reads
    //   bucket bounds for column positions and slot._activity for labels —
    //   any drift between them mis-renders rows (e.g. lunch appearing in the
    //   wrong column on Trios 2). Logs the first mismatch per bunk so we can
    //   trace which move desynced.
    (function _checkAlignment() {
      const divs = window.divisions || {};
      let bunkCount = 0, mismatchCount = 0;
      const firstFew = [];
      for (const [bunk, slots] of Object.entries(window.scheduleAssignments || {})) {
        if (!Array.isArray(slots)) continue;
        bunkCount++;
        const grade = _bunkGrade(bunk, divs);
        if (!grade) continue;
        const pbs = window.divisionTimes?.[grade]?._perBunkSlots?.[bunk];
        if (!Array.isArray(pbs)) continue;
        if (pbs.length !== slots.length) {
          mismatchCount++;
          if (firstFew.length < 5) firstFew.push(bunk + ': lengths ' + slots.length + ' vs ' + pbs.length);
          continue;
        }
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i], b = pbs[i];
          if (!s || !b) continue;
          if (s._startMin !== b.startMin || s._endMin !== b.endMin) {
            mismatchCount++;
            if (firstFew.length < 5) {
              firstFew.push(bunk + '[' + i + '] ' + (s._activity || '?') +
                ' schedule=' + s._startMin + '-' + s._endMin +
                ' bucket=' + b.startMin + '-' + b.endMin +
                ' src=' + (s._source || '?'));
            }
            break; // one per bunk is enough for diagnostics
          }
        }
      }
      if (mismatchCount > 0) {
        warn('[v2 ALIGNMENT] ' + mismatchCount + '/' + bunkCount + ' bunks desync. First:');
        firstFew.forEach(m => warn('  ' + m));
      } else {
        log('[v2 ALIGNMENT] OK — all ' + bunkCount + ' bunks index-aligned');
      }
    })();

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

    const fields   = g.app1?.fields || g.fields || [];
    const specials = g.specialActivities || [];

    // Pre-build lookup maps so the validator's hot loop is O(1) per slot.
    const _fieldByName = {};
    fields.forEach(f => { if (f && f.name) _fieldByName[f.name] = f; });
    const _specialByName = {};
    specials.forEach(s => { if (s && s.name) _specialByName[s.name] = s; });

    // Sport player caps (rules.js → app1.sportMetaData) + a precomputed bunk-size
    // map, so detectHardViolations can enforce maxPlayers without re-reading
    // globals on every SA evaluation.
    const sportMetaData = g.app1?.sportMetaData || window.sportMetaData || {};
    const _bunkSize = {};
    const _bmd = (typeof window !== 'undefined' && (window.getBunkMetaData?.() || window.bunkMetaData)) || {};
    Object.keys(divisions).forEach(grade => {
      const dd = divisions[grade] || {};
      const sizes = dd.bunkSizes || {};
      const dflt = parseInt(dd.defaultBunkSize) || parseInt(dd.bunkSize) || 0;
      // Canonical bunk size = camper count in bunkMetaData; fall back to divisions.bunkSizes.
      (dd.bunks || []).forEach(b => { _bunkSize[String(b)] = parseInt(_bmd[b] && _bmd[b].size) || parseInt(sizes[b]) || dflt || 0; });
    });

    return {
      config,
      divisions,
      perBunkSlots,
      fields,
      specials,
      _fieldByName,
      _specialByName,
      sportMetaData,
      _bunkSize,
      allowedDivisions: options?.allowedDivisions || null,
      repetitionIgnoreSet: ignore
    };
  }

  // -------------------------------------------------------------------------
  // PUBLIC API — for v3 (and future external callers) to invoke SA + repair
  // on a pre-built schedule WITHOUT going through v1 seeding.
  // -------------------------------------------------------------------------
  window.SolverV2 = {
    getConfig,
    buildContext,
    evaluate,
    detectHardViolations,
    runSA,
    smartRepair: smartRepairTop
  };

  log('scheduler_core_solver_v2.js loaded — skeleton ready (Phase X1)');
})();
