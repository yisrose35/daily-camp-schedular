/**
 * day_packer.js — Phase −1 Day Packer (Commit 1: input collection only)
 * ======================================================================
 *
 * The human scheduler doesn't sequentially pin activities. They look at one
 * bunk's whole day — all the pieces it needs (specials, swim, sports, fillers,
 * anchors) — and lay them out as a coherent tiled whole. No gaps, every piece
 * in a legal slot, configured preferences honored when possible but shifted
 * when needed to make the tile work.
 *
 * Today's pipeline (Phase 0 → 2.3 → 2.5 → 3) pins decisions sequentially. Each
 * phase locks choices that the next phase has to work around. The 4 remaining
 * 10-min slivers in our best schedule are direct consequence: Phase 0/2.5
 * pinned specials at configured times, leaving holes Phase 3 can't fill
 * because no filler exists at the needed duration.
 *
 * DAY PACKER GOAL (full vision, not commit 1): for each bunk, treat the day as
 * a constraint-satisfaction problem. Try arrangements. Backtrack on slivers.
 * Score by gap-closure + field availability + rotation fairness + closeness
 * to configured preferences. Output a fully tiled day before any phase pins
 * a single decision.
 *
 * COMMIT 1 (this file): input collection only. For each bunk, gather what the
 * packer WILL need to plan its day:
 *   - Periods (bell schedule for the grade)
 *   - Walls (fixed anchors: lunch, cleanup, MAIN ACTIVITY, multi-period specials)
 *   - Anchor specials (configured-time specials with isAnchor=true)
 *   - Filler specials (Slush/Popcorn/Nit Check/Snack/Ice Cream patterns)
 *   - Swim requirement (if this bunk swims today)
 *   - Sport quota (how many sport slots needed)
 *   - Available fields (per-bunk access)
 *
 * Logs a structured summary. No mutation. This surfaces what data each
 * existing phase implicitly knows but never documents explicitly. Future
 * commits use this picture to make placement decisions.
 *
 * USAGE:
 *   window.DayPacker.collectBunkPlanInput(bunk, grade, opts) → { ... }
 *   window.DayPacker.runShadowCollection(opts) → logs per-bunk summary
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  function _periodForTime(periods, mins) {
    for (var i = 0; i < periods.length; i++) {
      if (mins >= periods[i].startMin && mins < periods[i].endMin) return periods[i];
    }
    return null;
  }

  // Filler patterns — names that historically appear as 10-min glue blocks
  // across many positions in the same day. Used only for categorization in
  // commit 1; future commits will read placementMode from special config.
  var _FILLER_RE = /^(slush|popcorn|snack|nit\s*check|ice\s*cream|nosh|treat|powerade)/i;
  var _MAIN_RE   = /^(main\s*activity|majors\s*breakout|drama)/i;
  var _SWIM_RE   = /^swim$/i;
  var _CHANGE_RE = /^(pre[-\s]?change|post[-\s]?change|change)/i;
  var _LUNCH_RE  = /^lunch$/i;
  var _CLEANUP_RE= /^cleanup$/i;
  var _SHIUR_RE  = /^shiur/i;

  function _categorize(name) {
    var s = String(name || '');
    if (_SWIM_RE.test(s))    return 'swim';
    if (_CHANGE_RE.test(s))  return 'change';
    if (_LUNCH_RE.test(s))   return 'lunch';
    if (_CLEANUP_RE.test(s)) return 'cleanup';
    if (_MAIN_RE.test(s))    return 'main-anchor';
    if (_SHIUR_RE.test(s))   return 'shiur';
    if (_FILLER_RE.test(s))  return 'filler';
    return 'other';
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /**
   * Collect the full input picture for one bunk's day plan.
   * Pure read — no mutation.
   *
   * @param {string} bunk
   * @param {string} grade
   * @param {object} opts {
   *   periods:        array of {startMin, endMin, name}
   *   bunkTimeline:   current bunkTimelines[bunk] (may be empty if pre-Phase-0)
   *   sportsNeeded:   integer
   *   swimToday:      boolean
   *   fieldAccess:    Set<string> of accessible field names (optional)
   * }
   * @returns {{
   *   bunk, grade,
   *   periods: array,
   *   walls: array,         // fixed anchors that can't move
   *   anchorSpecials: array,
   *   fillerSpecials: array,
   *   swimNeeded: boolean,
   *   sportQuota: integer,
   *   totalScheduledMin: number,
   *   periodCapacity: number,
   *   slack: number          // periodCapacity - totalScheduledMin
   * }}
   */
  function collectBunkPlanInput(bunk, grade, opts) {
    opts = opts || {};
    var periods = (opts.periods || []).slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var tl = opts.bunkTimeline || [];

    var walls = [];
    var anchorSpecials = [];
    var fillerSpecials = [];
    var hasSwim = false;
    var totalScheduledMin = 0;

    for (var i = 0; i < tl.length; i++) {
      var b = tl[i];
      if (!b || b.startMin == null || b.endMin == null) continue;
      var dur = b.endMin - b.startMin;
      if (dur <= 0) continue;
      totalScheduledMin += dur;
      var name = b.event || (b.layer && b.layer.name) || b.type || 'unknown';
      var kind = _categorize(name);
      var fixed = !!(b._fixed || b._classification === 'pinned' || b._source === 'phase0');
      var entry = {
        name: name, startMin: b.startMin, endMin: b.endMin, dur: dur,
        kind: kind, fixed: fixed, source: b._source || null,
        period: (_periodForTime(periods, b.startMin) || {}).name || null
      };

      if (kind === 'swim') hasSwim = true;
      if (kind === 'lunch' || kind === 'cleanup' || kind === 'main-anchor' || kind === 'change' || kind === 'swim') {
        walls.push(entry);
      } else if (kind === 'filler') {
        fillerSpecials.push(entry);
      } else if (kind === 'shiur' || kind === 'other') {
        // Specials that aren't obvious fillers — treat as anchors for now.
        // Future commits will read placementMode from config to distinguish.
        anchorSpecials.push(entry);
      }
    }

    var periodCapacity = periods.reduce(function (s, p) { return s + (p.endMin - p.startMin); }, 0);

    return {
      bunk: bunk, grade: grade,
      periods: periods,
      walls: walls,
      anchorSpecials: anchorSpecials,
      fillerSpecials: fillerSpecials,
      swimNeeded: hasSwim || !!opts.swimToday,
      sportQuota: opts.sportsNeeded || 0,
      totalScheduledMin: totalScheduledMin,
      periodCapacity: periodCapacity,
      slack: periodCapacity - totalScheduledMin
    };
  }

  /**
   * Iterate all bunks, collect plan input, log a structured summary.
   * Used in shadow mode — no decisions are committed.
   *
   * @param {object} opts {
   *   bunkTimelines:  object<bunk, array>
   *   allGrades:      array<string>
   *   getBunksForGrade: fn(grade) → array<bunk>
   *   campPeriods:    object<grade, array<period>>
   *   log:            fn(string)
   * }
   */
  function runShadowCollection(opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var bunkTimelines = opts.bunkTimelines || {};
    var allGrades = opts.allGrades || [];
    var getBunksForGrade = opts.getBunksForGrade || function () { return []; };
    var campPeriods = opts.campPeriods || {};

    var summary = {
      bunksAnalyzed: 0,
      bunksWithSwim: 0,
      bunksWithSlack: 0,
      totalAnchorSpecials: 0,
      totalFillerSpecials: 0,
      totalWalls: 0,
      sampleBunks: []
    };

    allGrades.forEach(function (grade) {
      var periods = campPeriods[grade] || [];
      getBunksForGrade(grade).forEach(function (bunk) {
        var input = collectBunkPlanInput(bunk, grade, {
          periods: periods,
          bunkTimeline: bunkTimelines[bunk] || []
        });
        summary.bunksAnalyzed++;
        if (input.swimNeeded) summary.bunksWithSwim++;
        if (input.slack > 0) summary.bunksWithSlack++;
        summary.totalAnchorSpecials += input.anchorSpecials.length;
        summary.totalFillerSpecials += input.fillerSpecials.length;
        summary.totalWalls          += input.walls.length;
        if (summary.sampleBunks.length < 3) {
          summary.sampleBunks.push({
            bunk: bunk, grade: grade,
            walls: input.walls.length,
            anchors: input.anchorSpecials.length,
            fillers: input.fillerSpecials.length,
            swim: input.swimNeeded,
            slack: input.slack
          });
        }
      });
    });

    log('[DayPacker Commit 1] Input collection: ' + summary.bunksAnalyzed + ' bunks');
    log('  - bunks needing swim: ' + summary.bunksWithSwim);
    log('  - bunks with leftover slack: ' + summary.bunksWithSlack);
    log('  - total walls (anchors+swim+lunch+change): ' + summary.totalWalls);
    log('  - total anchor specials (Shiur/Drama/other): ' + summary.totalAnchorSpecials);
    log('  - total filler specials (Slush/Popcorn/etc): ' + summary.totalFillerSpecials);
    if (summary.sampleBunks.length > 0) {
      log('  - sample bunk picture:');
      summary.sampleBunks.forEach(function (s) {
        log('      ' + s.bunk + ' (' + s.grade + '): walls=' + s.walls +
            ' anchors=' + s.anchors + ' fillers=' + s.fillers +
            ' swim=' + s.swim + ' slack=' + s.slack + 'min');
      });
    }
    return summary;
  }

  // Expose
  window.DayPacker = {
    collectBunkPlanInput: collectBunkPlanInput,
    runShadowCollection: runShadowCollection,
    _categorize: _categorize  // exported for tests
  };
})();
