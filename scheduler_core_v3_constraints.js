// =============================================================================
// scheduler_core_v3_constraints.js — Solver v3 Phase A: Constraint analysis
// =============================================================================
// Builds a ConstraintGraph from the camp config that the constructive builder
// (Phase B) uses to make smart placement decisions.
//
// See docs/SOLVER_V3_DESIGN.md for the full architecture.
// =============================================================================

(function () {
  'use strict';

  const TAG = '[SolverV3:Constraints]';
  const log = (msg, ...a) => console.log(TAG + ' ' + msg, ...a);

  /**
   * Build the ConstraintGraph for the given camp config.
   * Pure: no DOM access, no side effects.
   *
   * @param {Object} input
   *   - layers:   flattened layer list from runOptimizer
   *   - divisions: window.divisions
   *   - campPeriods: per-grade bell schedule
   *   - fields:   g.app1.fields
   *   - specials: g.specialActivities
   *   - allowedDivisions: optional partial-gen scope
   * @returns {ConstraintGraph}
   */
  function buildConstraintGraph(input) {
    const {
      layers = [],
      divisions = {},
      campPeriods = {},
      fields = [],
      specials = [],
      allowedDivisions = null
    } = input;

    const allowedSet = allowedDivisions
      ? new Set(allowedDivisions.map(String))
      : null;

    // ─── 1. Bunk inventory + ordering ──────────────────────────────────────
    const bunks = [];
    for (const [grade, info] of Object.entries(divisions)) {
      if (allowedSet && !allowedSet.has(String(grade))) continue;
      (info.bunks || []).forEach(b => bunks.push({ name: String(b), grade }));
    }

    // ─── 2. Period maps ────────────────────────────────────────────────────
    const periods = {};
    for (const [grade, info] of Object.entries(divisions)) {
      if (allowedSet && !allowedSet.has(String(grade))) continue;
      const list = (campPeriods[grade] || []).slice()
        .sort((a, b) => a.startMin - b.startMin);
      periods[grade] = list;
    }

    // ─── 3. Hard-pinned activities (specials with fixed time, league fixtures) ─
    // Layers with `pinned` flag, league/specialty_league types, or rotation_events
    // become hard pins. They MUST be placed at their exact configured time.
    const hardPinned = [];
    layers.forEach(layer => {
      const t = String(layer.type || '').toLowerCase();
      const isPinned =
        layer.pinned === true ||
        t === 'league' ||
        t === 'specialty_league' ||
        layer.fullGrade === true ||
        layer._fixed === true;
      if (!isPinned) return;
      if (layer.startMin == null || layer.endMin == null) return;
      const grade = layer.grade || layer.division;
      if (!grade) return;
      if (allowedSet && !allowedSet.has(String(grade))) return;
      hardPinned.push({
        type: t,
        grade,
        activity: layer.event || layer.name || layer.activity || t,
        startMin: layer.startMin,
        endMin: layer.endMin,
        layer,
        target: 'all-grade-bunks'   // resolved later
      });
    });

    // ─── 4. fullGrade specials — must hit entire grade simultaneously ──────
    const fullGradeSpecials = specials
      .filter(s => s && s.fullGrade === true)
      .map(s => ({
        name: s.name,
        config: s,
        location: s.location || null,
        durations: Array.isArray(s.durations) && s.durations.length ? s.durations : [s.duration || 30]
      }));

    // ─── 5. Swim+Change atomic units ──────────────────────────────────────
    // For each grade with swim layers, identify the swim slot AND the
    // pre/post-change duration the camp config specifies.
    const swimAtomic = [];
    layers.forEach(layer => {
      if (String(layer.type || '').toLowerCase() !== 'swim') return;
      const grade = layer.grade || layer.division;
      if (!grade) return;
      if (allowedSet && !allowedSet.has(String(grade))) return;
      swimAtomic.push({
        grade,
        startMin: layer.startMin,
        endMin: layer.endMin,
        preChangeMin: parseInt(layer.preChangeMin) || 5,
        postChangeMin: parseInt(layer.postChangeMin) || 5,
        layer
      });
    });

    // ─── 6. Sports rotation pool per bunk ──────────────────────────────────
    // For now: every accessible sport. Phase B will sort by rotation score.
    const sportsRotation = {};
    bunks.forEach(({ name, grade }) => {
      const accessibleFields = fields.filter(f => {
        const ar = f && f.accessRestrictions;
        if (!ar?.enabled) return true;
        const divs = ar.divisions || {};
        if (!(grade in divs) && !(String(grade) in divs)) return false;
        const allow = divs[grade] || divs[String(grade)];
        if (Array.isArray(allow) && allow.length > 0
            && !allow.map(String).includes(String(name))) return false;
        return true;
      });
      const sports = new Set();
      accessibleFields.forEach(f => {
        (f.activities || []).forEach(act => sports.add(act));
      });
      sportsRotation[name] = [...sports].map(act => {
        // Score: 0 = neutral; lower is better (more attractive for rotation)
        // Phase B will plug in real rotation scoring.
        return { sport: act, score: 0, fields: accessibleFields.filter(f => (f.activities||[]).includes(act)).map(f => f.name) };
      });
    });

    // ─── 7. Field demand / scarcity ────────────────────────────────────────
    const fieldDemand = {};
    fields.forEach(f => {
      if (!f || !f.name) return;
      const cap = f.sharableWith?.capacity || (f.sharableWith?.type === 'not_sharable' ? 1 : 2);
      fieldDemand[f.name] = {
        capacity: cap,
        shareType: f.sharableWith?.type || 'not_sharable',
        activities: f.activities || [],
        accessibleBunks: 0   // populated below
      };
    });
    bunks.forEach(({ name, grade }) => {
      Object.entries(fieldDemand).forEach(([fname, fd]) => {
        const fieldObj = fields.find(f => f.name === fname);
        const ar = fieldObj?.accessRestrictions;
        if (ar?.enabled) {
          const divs = ar.divisions || {};
          if (!(grade in divs) && !(String(grade) in divs)) return;
          const allow = divs[grade] || divs[String(grade)];
          if (Array.isArray(allow) && allow.length > 0
              && !allow.map(String).includes(String(name))) return;
        }
        fd.accessibleBunks++;
      });
    });

    // Scarcity: capacity vs accessible-bunk-count
    const scarcity = { fields: {}, activities: {} };
    Object.entries(fieldDemand).forEach(([fname, fd]) => {
      const ratio = fd.capacity > 0 ? fd.accessibleBunks / fd.capacity : 0;
      scarcity.fields[fname] = ratio;   // higher = scarcer
    });

    // ─── 8. Bunk ordering — most-constrained-first ────────────────────────
    // For Phase B's placement loop. Bunks with rarer accessible sports
    // and more hard pins get processed first.
    bunks.sort((a, b) => {
      const aOpts = (sportsRotation[a.name] || []).length;
      const bOpts = (sportsRotation[b.name] || []).length;
      return aOpts - bOpts;   // fewer options = higher priority
    });

    log('Constraint graph built: ' +
        bunks.length + ' bunks, ' +
        hardPinned.length + ' hard pins, ' +
        fullGradeSpecials.length + ' fullGrade specials, ' +
        swimAtomic.length + ' swim atomic units');

    return {
      bunks,
      periods,
      hardPinned,
      fullGradeSpecials,
      swimAtomic,
      sportsRotation,
      fieldDemand,
      scarcity,
      meta: {
        builtAt: Date.now(),
        allowedDivisions: allowedDivisions || null,
        version: 'v3-phaseA-1.0'
      }
    };
  }

  // Expose
  window.SolverV3Constraints = { buildConstraintGraph };
  log('Phase A loaded.');
})();
