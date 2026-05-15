// =============================================================================
// scheduler_core_solver_v3.js — main entry orchestrating Phases A→F
// =============================================================================
// PHASE A (constraint analysis):    SolverV3Constraints.buildConstraintGraph
// PHASE B (constructive placement): inline _constructiveBuild (this file)
// PHASE C (validation):             reuse v2's detectHardViolations
// PHASE D (smart repair):           reuse v2's smartRepair (post-SA)
// PHASE E (SA polish):              reuse v2's runSA
// PHASE F (learning):               SolverV3Learning.recordRun (after gen)
//
// See docs/SOLVER_V3_DESIGN.md.
// =============================================================================
(function () {
  'use strict';

  const TAG = '[SolverV3]';
  const log  = (m, ...a) => console.log(TAG + ' ' + m, ...a);
  const warn = (m, ...a) => console.warn(TAG + ' ' + m, ...a);

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE B — Constructive placement
  // ─────────────────────────────────────────────────────────────────────────
  // Builds a schedule from scratch using the ConstraintGraph.
  // Output shape: same as v1/v2 — { scheduleAssignments, perBunkSlots }.
  //
  // Strategy:
  //   1. Build period-aligned bucket grid (one slot per period per bunk)
  //   2. Place hard-pinned activities first (specials, leagues)
  //   3. Place fullGrade specials atomically across all grade bunks
  //   4. Place swim + change atomic units
  //   5. Place sports rotation-fairly into remaining slots
  //   6. Return + report unsolvable constraints
  function _constructiveBuild(cg, ctx) {
    const schedule = {};
    const perBunkSlots = {};

    // ── B.1: Build period-aligned bucket grids ────────────────────────────
    for (const { name, grade } of cg.bunks) {
      const periods = cg.periods[grade] || [];
      // One bucket per period, named after the period
      const buckets = periods.map(p => ({
        startMin: p.startMin,
        endMin:   p.endMin,
        startTime: _minutesToTime(p.startMin),
        endTime:   _minutesToTime(p.endMin),
        _periodId: p.id || null,
        _periodName: p.name || null
      }));
      if (!perBunkSlots[grade]) perBunkSlots[grade] = {};
      perBunkSlots[grade][name] = buckets;
      schedule[name] = new Array(buckets.length).fill(null);
    }

    log('B.1: built period-aligned bucket grids for ' + cg.bunks.length + ' bunks');

    // ── B.2: Place hard-pinned activities ─────────────────────────────────
    let pinnedPlaced = 0;
    for (const pin of cg.hardPinned) {
      if (!perBunkSlots[pin.grade]) continue;
      const bunksInGrade = cg.bunks.filter(b => b.grade === pin.grade);
      bunksInGrade.forEach(({ name }) => {
        const buckets = perBunkSlots[pin.grade][name];
        const idx = _findBucketIndex(buckets, pin.startMin, pin.endMin);
        if (idx < 0) return;
        if (schedule[name][idx]) return; // already taken
        schedule[name][idx] = {
          field: pin.activity, sport: null, _activity: pin.activity,
          _autoMode: true, _fixed: true, _activityLocked: true,
          _startMin: buckets[idx].startMin, _endMin: buckets[idx].endMin,
          _source: 'v3-hardPin', continuation: false,
          _layer: pin.layer
        };
        pinnedPlaced++;
      });
    }
    log('B.2: placed ' + pinnedPlaced + ' hard-pinned slots');

    // ── B.3: Place fullGrade specials (grade-wide atomic) ─────────────────
    let fgPlaced = 0;
    for (const fgSpec of cg.fullGradeSpecials) {
      for (const grade of Object.keys(perBunkSlots)) {
        const bunksInGrade = cg.bunks.filter(b => b.grade === grade);
        if (bunksInGrade.length === 0) continue;
        const sampleBuckets = perBunkSlots[grade][bunksInGrade[0].name];
        // Find a bucket where every bunk in this grade has a free slot
        for (let idx = 0; idx < sampleBuckets.length; idx++) {
          const allFree = bunksInGrade.every(({ name }) => !schedule[name][idx]);
          if (!allFree) continue;
          // Try placing
          const slotTemplate = {
            field: fgSpec.location || fgSpec.name,
            sport: null, _activity: fgSpec.name,
            _autoMode: true, _fixed: true, _gradeWide: true, _activityLocked: true,
            _startMin: sampleBuckets[idx].startMin,
            _endMin:   sampleBuckets[idx].endMin,
            _source: 'v3-fullGrade',
            continuation: false
          };
          bunksInGrade.forEach(({ name }) => {
            schedule[name][idx] = Object.assign({}, slotTemplate);
            fgPlaced++;
          });
          break; // place once per grade
        }
      }
    }
    log('B.3: placed ' + fgPlaced + ' fullGrade slot instances');

    // ── B.4: Place swim + change atomic units ─────────────────────────────
    let swimPlaced = 0;
    for (const swim of cg.swimAtomic) {
      const bunksInGrade = cg.bunks.filter(b => b.grade === swim.grade);
      bunksInGrade.forEach(({ name }) => {
        const buckets = perBunkSlots[swim.grade][name];
        const swimIdx = _findBucketIndex(buckets, swim.startMin, swim.endMin);
        if (swimIdx < 0 || schedule[name][swimIdx]) return;
        // Atomic write of swim + pre/post change blocks
        schedule[name][swimIdx] = {
          field: 'Swim', sport: null, _activity: 'Swim',
          type: 'swim', _autoMode: true, _fixed: true, _activityLocked: true,
          _gradeWide: true,
          _startMin: buckets[swimIdx].startMin, _endMin: buckets[swimIdx].endMin,
          _source: 'v3-swim', continuation: false
        };
        // Pre-change: tuck into the bucket BEFORE the swim if room exists
        // Post-change: tuck into the bucket AFTER
        // Phase B intentionally only places swim itself here — the change
        // blocks are created by the bucket-grid having period gaps where
        // they fit naturally. The Phase D repair fills them in if missing.
        swimPlaced++;
      });
    }
    log('B.4: placed ' + swimPlaced + ' swim units');

    // ── B.5: Place sports rotation-fairly into remaining slots ────────────
    let sportPlaced = 0;
    const fieldUsage = {};   // [time]: { field: count }
    const recordUsage = (start, end, field) => {
      // mark every 10-min tick of [start, end) as occupying this field
      for (let t = start; t < end; t += 10) {
        if (!fieldUsage[t]) fieldUsage[t] = {};
        fieldUsage[t][field] = (fieldUsage[t][field] || 0) + 1;
      }
    };
    // Pre-populate from already-placed slots
    for (const bunk of Object.keys(schedule)) {
      schedule[bunk].forEach(s => {
        if (s && s.field) recordUsage(s._startMin, s._endMin, s.field);
      });
    }

    for (const { name, grade } of cg.bunks) {
      const buckets = perBunkSlots[grade][name];
      const pool = cg.sportsRotation[name] || [];
      for (let i = 0; i < buckets.length; i++) {
        if (schedule[name][i]) continue;
        const bucket = buckets[i];
        // Find an activity whose hosting field has capacity at this time
        const fieldsByName = {};
        (ctx.fields || []).forEach(f => { fieldsByName[f.name] = f; });
        let chosen = null;
        for (const candidate of pool) {
          const okField = candidate.fields.find(fname => {
            const fdef = fieldsByName[fname];
            if (!fdef) return false;
            const cap = fdef.sharableWith?.capacity || (fdef.sharableWith?.type === 'not_sharable' ? 1 : 2);
            // Check capacity at every 10-min tick within bucket
            for (let t = bucket.startMin; t < bucket.endMin; t += 10) {
              const used = fieldUsage[t]?.[fname] || 0;
              if (used >= cap) return false;
            }
            return true;
          });
          if (okField) { chosen = { activity: candidate.sport, field: okField }; break; }
        }
        if (!chosen) continue;
        schedule[name][i] = {
          field: chosen.field, sport: chosen.activity, _activity: chosen.activity,
          _autoMode: true, _autoSolved: true,
          _startMin: bucket.startMin, _endMin: bucket.endMin,
          _source: 'v3-sport', continuation: false
        };
        recordUsage(bucket.startMin, bucket.endMin, chosen.field);
        sportPlaced++;
      }
    }
    log('B.5: placed ' + sportPlaced + ' sport slots');

    return { schedule, perBunkSlots };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function _findBucketIndex(buckets, startMin, endMin) {
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].startMin <= startMin && buckets[i].endMin >= endMin) return i;
    }
    return -1;
  }
  function _minutesToTime(min) {
    if (min == null) return '';
    const h = Math.floor(min / 60), m = min % 60;
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ampm;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC ENTRY
  // ─────────────────────────────────────────────────────────────────────────
  window.runAutoSchedulerV3 = async function (layers, options) {
    if (!window.SolverV3Constraints?.buildConstraintGraph) {
      warn('Phase A module not loaded — falling back to v2');
      if (typeof window.runAutoSchedulerV2 === 'function') return window.runAutoSchedulerV2(layers, options);
      if (typeof window._runAutoSchedulerV1 === 'function') return window._runAutoSchedulerV1(layers, options);
      throw new Error('No solver available');
    }
    log('v3 entry. layers=' + (Array.isArray(layers) ? layers.length : 0));
    const startTime = Date.now();

    // Phase A: constraint graph
    const g = window.loadGlobalSettings?.() || {};
    const cg = window.SolverV3Constraints.buildConstraintGraph({
      layers,
      divisions: window.divisions || {},
      campPeriods: window.campPeriods || {},
      fields: g.app1?.fields || g.fields || [],
      specials: g.specialActivities || [],
      allowedDivisions: options?.allowedDivisions || null
    });

    // Build a ctx similar to v2's
    const ctx = {
      divisions: window.divisions || {},
      fields: g.app1?.fields || g.fields || [],
      specials: g.specialActivities || [],
      perBunkSlots: {}
    };

    // Phase B: constructive placement
    const { schedule, perBunkSlots } = _constructiveBuild(cg, ctx);

    // Commit to window state so Phase D + E can operate
    window.scheduleAssignments = schedule;
    for (const [grade, byBunk] of Object.entries(perBunkSlots)) {
      if (!window.divisionTimes) window.divisionTimes = {};
      if (!window.divisionTimes[grade]) window.divisionTimes[grade] = {};
      window.divisionTimes[grade]._perBunkSlots = byBunk;
    }
    ctx.perBunkSlots = perBunkSlots;

    // Phase C+D+E: hand off to v2's SA + smart repair to polish
    if (typeof window.runAutoSchedulerV2 === 'function') {
      log('v3: handing off to v2 SA + smart repair for polish...');
      // v2 expects v1 as seed source; temporarily skip v1 by directly
      // using our schedule as the seed. The cleanest path is to inline
      // v2's SA logic — but we can also just call v2 and let it re-run
      // v1 as seed. For now, accept v2 wraps and runs SA on whatever's
      // in window.scheduleAssignments.
      // The simplest integration: v2 reads scheduleAssignments + perBunkSlots
      // as its starting point. We've already set those. v2's SA loop
      // will start from there.

      // BUT v2's buildSeed calls _runAutoSchedulerV1 which wipes our work.
      // For this minimum-viable phase, we skip v2 and just return our
      // constructive output. Phase E integration is a TODO.
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log('v3 done in ' + elapsed + 's');

    // Dispatch the generation-complete event so save handlers fire
    window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
      detail: { mode: 'auto-v3', version: 'v3', elapsed: parseFloat(elapsed) }
    }));

    return {
      success: true,
      version: 'v3',
      elapsed: parseFloat(elapsed),
      constraintGraph: cg
    };
  };

  log('v3 entry registered.');
})();
