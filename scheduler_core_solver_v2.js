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
                    start: s._startMin, end: s._endMin });
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
    flat.forEach(c => {
      const cfg = fieldByName[c.field];
      if (!cfg?.timeRules || cfg.timeRules.length === 0) return;
      const avail = cfg.timeRules.filter(r => r.type === 'Available' || !r.type || r.available === true);
      const unavail = cfg.timeRules.filter(r => r.type === 'Unavailable' || r.available === false);
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

    return out;
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
      const next = _cloneSchedule(schedule);
      const bucket = ctx.perBunkSlots[grade]?.[bunk]?.[idx];
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
  //     close a wall-clock gap. This DOES NOT modify the bucket grid in
  //     ctx.perBunkSlots — only the slot's own time range, which is what
  //     the wall-clock-gap cost function actually reads.
  function moveBucketExtend(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const slots = schedule[bunk];
      if (!Array.isArray(slots) || slots.length < 2) continue;
      // Pick an adjacent (real, real) pair with a gap
      const real = [];
      slots.forEach((s, i) => { if (s && !s.continuation && s._startMin != null) real.push({ s, i }); });
      real.sort((a, b) => a.s._startMin - b.s._startMin);
      const candidates = [];
      for (let k = 0; k < real.length - 1; k++) {
        const gap = real[k + 1].s._startMin - real[k].s._endMin;
        if (gap >= 10 && _isMovable(real[k].s)) {
          candidates.push({ idx: real[k].i, newEnd: real[k + 1].s._startMin, kind: 'fwd' });
        }
        if (gap >= 10 && _isMovable(real[k + 1].s)) {
          candidates.push({ idx: real[k + 1].i, newStart: real[k].s._endMin, kind: 'back' });
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

    if (strat === 'extend-prev' && _isMovable(worstGap.prevSlot)) {
      // Stretch the previous activity's _endMin to fill the gap
      next[worstGap.bunk][worstGap.prevIdx] = Object.assign({}, worstGap.prevSlot, {
        _endMin: worstGap.gapEnd, _source: 'v2-gapTargeted-extPrev'
      });
      return next;
    }
    if (strat === 'extend-next-back' && _isMovable(worstGap.nextSlot)) {
      // Stretch the next activity's _startMin earlier to fill the gap
      next[worstGap.bunk][worstGap.nextIdx] = Object.assign({}, worstGap.nextSlot, {
        _startMin: worstGap.gapStart, _source: 'v2-gapTargeted-extNext'
      });
      return next;
    }
    if (strat === 'replace-prev-with-longer' && _isMovable(worstGap.prevSlot)) {
      // Replace the previous activity with a different one whose natural
      // duration is closer to (prev.start → gap.end). For now, just pick
      // a random alternative — the cost evaluator filters bad picks.
      const grade = _bunkGrade(worstGap.bunk, ctx.divisions);
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

  // --- bucketInsert (atomic): splice a NEW bucket into a wall-clock gap in
  //     the bucket grid. Returns a wrapped candidate { schedule, bucketPatch }
  //     so the SA loop only commits the grid mutation on accept.
  function moveBucketInsert(schedule, ctx, rng) {
    const bunks = Object.keys(schedule);
    for (let attempt = 0; attempt < 20; attempt++) {
      const bunk = bunks[Math.floor(rng() * bunks.length)];
      const grade = _bunkGrade(bunk, ctx.divisions);
      if (!grade) continue;
      const pbs = ctx.perBunkSlots[grade]?.[bunk];
      if (!Array.isArray(pbs) || pbs.length < 2) continue;
      // Find gap ≥ 15 min (large enough to merit a real activity)
      const gaps = [];
      for (let i = 0; i < pbs.length - 1; i++) {
        const gap = pbs[i + 1].startMin - pbs[i].endMin;
        if (gap >= 15) gaps.push({ afterIdx: i, start: pbs[i].endMin, end: pbs[i + 1].startMin });
      }
      if (gaps.length === 0) continue;
      const g = gaps[Math.floor(rng() * gaps.length)];
      const pool = _candidateActivities(grade, ctx);
      if (pool.length === 0) continue;
      const newAct = pool[Math.floor(rng() * pool.length)];
      const newField = _findFieldForActivity(newAct, ctx);
      if (!newField) continue;
      // Build the candidate schedule with new slot inserted at afterIdx+1
      const next = _cloneSchedule(schedule);
      next[bunk] = next[bunk].slice();
      next[bunk].splice(g.afterIdx + 1, 0, {
        field: newField.name, sport: newAct, _activity: newAct,
        _autoMode: true, _autoSolved: true,
        _startMin: g.start, _endMin: g.end,
        _source: 'v2-bucketInsert', continuation: false
      });
      // Return wrapped candidate with the grid patch — SA applies it on accept
      return {
        schedule: next,
        bucketPatch: {
          kind: 'insert', grade, bunk,
          idx: g.afterIdx + 1,
          newBucket: { startMin: g.start, endMin: g.end }
        }
      };
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

  const MOVES = {
    replace:      moveReplace,
    swap:         moveSwap,
    inject:       moveInject,
    relocate:     moveRelocate,
    crossSwap:    moveCrossSwap,
    bucketExtend: moveBucketExtend,
    gapTargeted:  moveGapTargeted,
    bucketInsert: moveBucketInsert,
    bucketDelete: moveBucketDelete
  };

  // Weight `gapTargeted` 3x in selection — it's the highest-leverage move
  // when gaps dominate the cost. Other moves still get sampled for diversity.
  const MOVE_WEIGHTS = {
    replace:      1,
    swap:         1,
    inject:       2,    // holes are expensive
    relocate:    0.5,   // small effect
    crossSwap:    1,
    bucketExtend: 2,
    gapTargeted:  3,
    bucketInsert: 2,    // grid mutation, expensive but high-leverage
    bucketDelete: 1.5   // removes phantom holes
  };

  function pickMove(stats, rng) {
    const names = Object.keys(MOVES);
    const totalProposes = names.reduce((s, m) => s + (stats.moves[m]?.propose || 0), 0);
    // Phase 1 (warmup): sample by static MOVE_WEIGHTS so moves we believe in
    // a-priori (gapTargeted, inject) get more attempts during early SA.
    // Phase 2 (after each move tried ≥20 times): blend MOVE_WEIGHTS with
    // observed acceptance rate, plus 15% epsilon-greedy exploration.
    if (totalProposes < names.length * 20 || rng() < 0.15) {
      // Static weighted pick
      const weights = names.map(m => MOVE_WEIGHTS[m] ?? 1);
      const sum = weights.reduce((a, b) => a + b, 0);
      let r = rng() * sum;
      for (let i = 0; i < names.length; i++) {
        r -= weights[i];
        if (r <= 0) return names[i];
      }
      return names[names.length - 1];
    }
    // Adaptive: rate = (accept + 1) / (propose + 1) * static_weight
    const rates = names.map(m => {
      const ms = stats.moves[m] || { propose: 0, accept: 0 };
      return ((ms.accept + 1) / (ms.propose + 1)) * (MOVE_WEIGHTS[m] ?? 1);
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
    const { best, bestEval, stats, bestPbsSnapshot } = runSA(seed, ctx);

    // Commit the best schedule back to window.scheduleAssignments,
    // AND restore the bucket grid to its state at the moment `best` was
    // captured. This prevents phantom nulls caused by post-best inserts.
    window.scheduleAssignments = best;
    if (bestPbsSnapshot) {
      for (const [grade, byBunk] of Object.entries(bestPbsSnapshot)) {
        if (!window.divisionTimes?.[grade]) continue;
        window.divisionTimes[grade]._perBunkSlots = byBunk;
      }
    }

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

    return {
      config,
      divisions,
      perBunkSlots,
      fields,
      specials,
      _fieldByName,
      _specialByName,
      allowedDivisions: options?.allowedDivisions || null,
      repetitionIgnoreSet: ignore
    };
  }

  log('scheduler_core_solver_v2.js loaded — skeleton ready (Phase X1)');
})();
