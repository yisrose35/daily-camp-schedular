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

  // ─────────────────────────────────────────────────────────────
  // COMMIT 2 — PLAN BUILDER
  // ─────────────────────────────────────────────────────────────
  // The "human's mental list" before they sit down to schedule:
  //   PINNED items (walls + user pins) define the immovable structure.
  //   FREE-GAME items have a duration and a TIME WINDOW (allowed range,
  //     NOT a preferred time). The bin-packer is free to land them
  //     anywhere inside their window.
  //
  // This function gathers the plan. It does NOT pack. Session B will.
  // Session A's job: prove we can describe the plan correctly.
  // ─────────────────────────────────────────────────────────────

  function _periodCapacity(periods) {
    return periods.reduce(function (s, p) { return s + (p.endMin - p.startMin); }, 0);
  }

  // PINNED detector — anything in bunkTimelines that cannot move.
  // Walls (swim/lunch/change/cleanup/main/shiur/snack/dismissal) +
  // explicit user pins (_pinned:true or _source in {phase0,manual,user}).
  function _isPinnedEntry(b) {
    if (!b) return false;
    if (b._pinned === true) return true;
    var src = String(b._source || '').toLowerCase();
    if (src === 'phase0' || src === 'manual' || src === 'user') return true;
    var name = String(b.event || (b.layer && b.layer.name) || b.type || '').toLowerCase();
    if (/^(swim|lunch|cleanup|change|pre[-\s]?change|post[-\s]?change|main\s*activity|shiur|dismissal|snack)/i.test(name)) return true;
    return false;
  }

  // Collect every configured special the camp knows about.
  function _allConfiguredSpecials(opts) {
    if (opts.specials && Array.isArray(opts.specials)) return opts.specials;
    var out = [];
    try {
      if (typeof window.getAllSpecialActivities === 'function') out = window.getAllSpecialActivities() || [];
      else if (typeof window.getGlobalSpecialActivities === 'function') out = window.getGlobalSpecialActivities() || [];
    } catch (e) {}
    return out;
  }

  // Effective time window for a special on a specific bunk's grade.
  // Window = intersection of (special.windowStart/End if set) AND (grade's
  // schedulable day from periods[0].startMin to periods[last].endMin).
  function _specialWindow(spec, periods) {
    var dayStart = periods.length ? periods[0].startMin : 0;
    var dayEnd   = periods.length ? periods[periods.length - 1].endMin : 1440;
    var ws = (typeof spec.windowStart === 'number') ? spec.windowStart : dayStart;
    var we = (typeof spec.windowEnd   === 'number') ? spec.windowEnd   : dayEnd;
    return { start: Math.max(ws, dayStart), end: Math.min(we, dayEnd) };
  }

  // Does this special pass access restrictions for this grade/bunk?
  function _specialAccessibleByBunk(spec, grade, bunk) {
    var ar = spec && spec.accessRestrictions;
    if (!ar || ar.enabled !== true) return true;
    var divs = ar.divisions || {};
    var gKey = String(grade);
    if (!(gKey in divs) && !(grade in divs)) return false;
    var allow = divs[gKey] || divs[grade];
    if (Array.isArray(allow) && allow.length > 0) {
      return allow.map(String).includes(String(bunk));
    }
    return true;
  }

  // Duration vector — a special may have dMin/dMax OR a durations:[...] array.
  // Returns { min, max, options: [...] }.
  function _specialDurations(spec) {
    var opts = [];
    if (Array.isArray(spec.durations) && spec.durations.length) {
      opts = spec.durations.slice().sort(function (a, b) { return a - b; });
    } else {
      var dMin = parseInt(spec.dMin || spec.duration || spec.preferredDuration) || 0;
      var dMax = parseInt(spec.dMax || spec.duration || spec.preferredDuration) || dMin;
      if (dMin > 0) opts.push(dMin);
      if (dMax > 0 && dMax !== dMin) opts.push(dMax);
    }
    return {
      min: opts.length ? opts[0] : 0,
      max: opts.length ? opts[opts.length - 1] : 0,
      options: opts
    };
  }

  // Compute the gap segments inside the period grid that are NOT occupied
  // by pinned items. These are what the bin-packer needs to fill.
  function _computeGapSegments(periods, pinned) {
    var gaps = [];
    var pSorted = pinned.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    periods.forEach(function (p) {
      var cursor = p.startMin;
      pSorted.forEach(function (pin) {
        // Only pins overlapping THIS period
        if (pin.endMin <= p.startMin || pin.startMin >= p.endMin) return;
        var overlapS = Math.max(pin.startMin, p.startMin);
        var overlapE = Math.min(pin.endMin, p.endMin);
        if (overlapS > cursor) gaps.push({ start: cursor, end: overlapS, period: p.name });
        cursor = Math.max(cursor, overlapE);
      });
      if (cursor < p.endMin) gaps.push({ start: cursor, end: p.endMin, period: p.name });
    });
    return gaps;
  }

  /**
   * Build the full per-bunk plan.
   * PINNED comes from bunkTimelines (walls already placed by Phase 2.3/2.4
   * before this is called).
   * FREE-GAME enumerates every configured special the bunk is allowed to
   * receive, with its duration options and time window.
   * GAPS lists the segments inside the period grid that need filling.
   *
   * @returns { pinned: [...], freeGame: [...], periods: [...], gaps: [...],
   *           totalPinnedMin, totalGapMin, freeGameSpecialsCount }
   */
  function buildBunkPlan(bunk, grade, opts) {
    opts = opts || {};
    var periods = (opts.periods || []).slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var tl = opts.bunkTimeline || [];

    // PINNED — filter bunkTimeline to immovables only
    var pinned = [];
    tl.forEach(function (b) {
      if (!b || b.startMin == null || b.endMin == null) return;
      if (b.endMin - b.startMin <= 0) return;
      if (!_isPinnedEntry(b)) return;
      var name = b.event || (b.layer && b.layer.name) || b.type || 'unknown';
      pinned.push({
        name: name,
        startMin: b.startMin, endMin: b.endMin, dur: b.endMin - b.startMin,
        kind: _categorize(name),
        source: b._source || null
      });
    });

    // GAPS — segments of period grid not covered by pinned
    var gaps = _computeGapSegments(periods, pinned);

    // FREE-GAME — every configured special this bunk is allowed to receive
    var allSpecials = _allConfiguredSpecials(opts);
    var freeGame = [];
    allSpecials.forEach(function (sp) {
      if (!sp || !sp.name) return;
      if (!_specialAccessibleByBunk(sp, grade, bunk)) return;
      var durs = _specialDurations(sp);
      if (durs.min <= 0) return;
      var win = _specialWindow(sp, periods);
      if (win.end - win.start < durs.min) return; // window too small for any duration
      var _subRaw = (typeof sp.subcategory === 'string') ? sp.subcategory.trim() : '';
      var _subKey = _subRaw ? _subRaw.toLowerCase() : 'regular';
      freeGame.push({
        name: sp.name,
        durations: durs.options,
        dMin: durs.min,
        dMax: durs.max,
        window: { start: win.start, end: win.end },
        location: sp.location || (sp.accessRestrictions && sp.accessRestrictions.location) || null,
        scarce: !!sp.scarcity || !!sp.isScarce,
        maxUsage: parseInt(sp.maxUsage) || 0,
        sharable: !!(sp.sharableWith && sp.sharableWith.type && sp.sharableWith.type !== 'not_sharable'),
        subcategory: _subRaw || 'Regular',
        subcategoryKey: _subKey
      });
    });

    // Subcategory breakdown — how many free-game items in each subcategory
    var subcategoryCounts = {};
    freeGame.forEach(function (f) {
      subcategoryCounts[f.subcategory] = (subcategoryCounts[f.subcategory] || 0) + 1;
    });

    return {
      bunk: bunk, grade: grade,
      periods: periods,
      pinned: pinned,
      gaps: gaps,
      freeGame: freeGame,
      subcategoryCounts: subcategoryCounts,
      subcategoryCaps: (opts.subcategoryCaps && opts.subcategoryCaps[bunk]) || null,
      totalPinnedMin: pinned.reduce(function (s, p) { return s + p.dur; }, 0),
      totalGapMin: gaps.reduce(function (s, g) { return s + (g.end - g.start); }, 0),
      freeGameSpecialsCount: freeGame.length,
      periodCapacity: _periodCapacity(periods)
    };
  }

  /**
   * Shadow-mode driver. Iterates every bunk, builds a plan, logs it.
   * Read-only — does NOT mutate anything. Hook this BEFORE Phase 2.5 to
   * see what the bin-packer would receive as input.
   */
  function runShadowPlan(opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var bunkTimelines = opts.bunkTimelines || {};
    var allGrades = opts.allGrades || [];
    var getBunksForGrade = opts.getBunksForGrade || function () { return []; };
    var campPeriods = opts.campPeriods || {};

    log('═══════════════════════════════════════════════════════════');
    log('[DayPacker Commit 2] PLAN SHADOW — pre-Phase-2.5 snapshot');
    log('═══════════════════════════════════════════════════════════');

    var totals = {
      bunks: 0, totalPinnedMin: 0, totalGapMin: 0, totalFreeGame: 0
    };
    var sampleEmitted = 0;

    allGrades.forEach(function (grade) {
      var periods = campPeriods[grade] || [];
      var bunks = getBunksForGrade(grade) || [];
      bunks.forEach(function (bunk) {
        var plan = buildBunkPlan(bunk, grade, {
          periods: periods,
          bunkTimeline: bunkTimelines[bunk] || [],
          specials: opts.specials,  // allow caller to pass pre-loaded list
          subcategoryCaps: opts.subcategoryCaps  // per-bunk caps from shopping list
        });
        totals.bunks++;
        totals.totalPinnedMin += plan.totalPinnedMin;
        totals.totalGapMin    += plan.totalGapMin;
        totals.totalFreeGame  += plan.freeGameSpecialsCount;

        // Sample emit: first bunk of each grade
        if (sampleEmitted < 7 && bunks[0] === bunk) {
          sampleEmitted++;
          log('--- PLAN ' + bunk + ' (' + grade + ') ---');
          log('  pinned (' + plan.pinned.length + ', ' + plan.totalPinnedMin + 'min):');
          plan.pinned.forEach(function (p) {
            log('    ' + p.startMin + '-' + p.endMin + ' ' + p.name + ' [' + p.kind + ']');
          });
          log('  gaps to fill (' + plan.gaps.length + ', ' + plan.totalGapMin + 'min):');
          plan.gaps.forEach(function (g) {
            log('    ' + g.start + '-' + g.end + ' (' + (g.end - g.start) + 'min) in ' + g.period);
          });
          log('  free-game candidates (' + plan.freeGame.length + '):');
          plan.freeGame.forEach(function (f) {
            var durStr = f.durations.length > 1
              ? '[' + f.durations.join(',') + ']'
              : String(f.durations[0] || f.dMin);
            log('    [' + f.subcategory + '] ' + f.name + ' dur=' + durStr + 'min window=' + f.window.start + '-' + f.window.end +
                (f.scarce ? ' SCARCE' : '') +
                (f.maxUsage ? ' max=' + f.maxUsage : '') +
                (f.sharable ? ' (sharable)' : ''));
          });
          // Subcategory breakdown + required caps
          var subKeys = Object.keys(plan.subcategoryCounts).sort();
          if (subKeys.length > 0) {
            var subStr = subKeys.map(function (k) {
              var avail = plan.subcategoryCounts[k];
              var cap = plan.subcategoryCaps && plan.subcategoryCaps[k.toLowerCase()];
              return k + ': ' + avail + ' available' + (cap != null ? ' / NEED ' + cap : '');
            }).join(', ');
            log('  subcategory mix: ' + subStr);
          }
        }
      });
    });

    log('───────────────────────────────────────────────────────────');
    log('[DayPacker Commit 2] Totals: ' + totals.bunks + ' bunks, ' +
        totals.totalPinnedMin + 'min pinned, ' +
        totals.totalGapMin + 'min gap to fill, ' +
        Math.round(totals.totalFreeGame / Math.max(totals.bunks, 1)) + ' free-game specials/bunk avg');
    log('═══════════════════════════════════════════════════════════');
    return totals;
  }

  // Expose
  window.DayPacker = {
    collectBunkPlanInput: collectBunkPlanInput,
    runShadowCollection: runShadowCollection,
    // Commit 2:
    buildBunkPlan: buildBunkPlan,
    runShadowPlan: runShadowPlan,
    _categorize: _categorize  // exported for tests
  };
})();
