// =============================================================================
// bunk_schedule_engine.js — Campistry Bunk Schedule Engine v1.1.0
// =============================================================================
// Responsible for: WHEN and WHAT TYPE each bunk gets, per-bunk.
// NOT responsible for: which specific activity or field (that's total_solver_engine).
//
// v1.1.0 Changes:
//   ★ Swim stagger: each bunk gets its own sequential swim slot (no more
//     all-bunks-at-the-same-time issue).
//   ★ Phases 5-7 REMOVED: conflict resolution, gap fill, and activity
//     assignment are now handled by total_solver_engine via the bridge
//     in bunk_engine_integration.js.
//   ★ build() output is now typed placeholder slots only — solver fills them.
//
// Pipeline position:
//   Layers → BunkScheduleEngine.build() [Phases 0-4]
//          → bunk_engine_integration.js bridge
//          → total_solver_engine.Solver.solveSchedule()
// =============================================================================

(function () {
    'use strict';

    var VERSION = '1.1.0';

    function log(msg) {
        console.log('[BunkScheduleEngine v' + VERSION + '] ' + msg);
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function fmtTime(min) {
        if (min == null) return '?';
        var h = Math.floor(min / 60), m = min % 60;
        var ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + (m < 10 ? '0' : '') + m + ap;
    }

    function parseTime(str) {
        if (!str) return null;
        if (typeof str === 'number') return str;
        var s = str.trim().toLowerCase();
        var ap = s.includes('pm') ? 'pm' : s.includes('am') ? 'am' : null;
        s = s.replace(/[apm]/g, '').trim();
        var parts = s.split(':');
        var h = parseInt(parts[0]), m = parseInt(parts[1] || '0');
        if (isNaN(h)) return null;
        if (ap === 'pm' && h !== 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return h * 60 + m;
    }

    function uid() {
        return 'bse_' + Math.random().toString(36).slice(2, 9);
    }

    function overlaps(s1, e1, s2, e2) {
        return s1 < e2 && e1 > s2;
    }

    function getGlobalSettings() {
        return window.loadGlobalSettings ? window.loadGlobalSettings() : (window.globalSettings || {});
    }

    function getDayName(dateStr) {
        if (!dateStr) return '';
        var parts = dateStr.split('-').map(Number);
        var dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
        return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
    }

    // =========================================================================
    // LAYER HELPERS
    // =========================================================================

    // Types that always get a locked "change" buffer around them (swim only)
    var CHANGE_BUFFER_TYPES = ['swim'];
    // Types that are always treated as hard anchors regardless of ratio
    var HARD_ANCHOR_TYPES = ['swim', 'lunch', 'snack', 'snacks', 'dismissal'];

    function needsChangeBuffer(layerType) {
        return CHANGE_BUFFER_TYPES.indexOf((layerType || '').toLowerCase()) >= 0;
    }

    function isHardAnchor(layerType) {
        return HARD_ANCHOR_TYPES.indexOf((layerType || '').toLowerCase()) >= 0;
    }

    // Duration of the activity slot itself (not the window).
    // Prefer periodMin — the DAW sets this to the activity run-time.
    // durationMin on anchor layers often equals the full window width,
    // which would cause a 10-min snack to be classified as pinned.
    function getLayerDuration(layer) {
        return layer.periodMin || layer.durationMin || layer.duration || 30;
    }

    // Max duration — same priority: periodMin before durationMin.
    function getLayerDurationMax(layer) {
        return layer.durationMax || layer.periodMin || layer.durationMin || layer.duration || getLayerDuration(layer);
    }

    // Window size = endMin - startMin
    function getWindowSize(layer) {
        var s = layer.startMin != null ? layer.startMin : parseTime(layer.startTime);
        var e = layer.endMin != null ? layer.endMin : parseTime(layer.endTime);
        if (s == null || e == null) return 0;
        return Math.max(0, e - s);
    }

    // ── Placement classification ─────────────────────────────────────────
    // PINNED:      duration >= window  (or hard anchor type)
    //              → locked slot at startMin, fills window exactly
    // SOFT-PINNED: duration / window >= 0.6  (slot is close to window size)
    //              → locked slot placed at earliest free spot in window
    // FILLER:      duration / window < 0.6
    //              → unlocked slot, solver can place within window
    var SOFT_PIN_RATIO = 0.6; // if duration >= 60% of window → soft-pinned

    function classifyLayer(layer) {
        var layerType = (layer.type || layer.event || 'activity').toLowerCase();

        // Hard anchor types are always PINNED regardless of ratio
        if (isHardAnchor(layerType)) return 'pinned';

        var windowSize = getWindowSize(layer);
        if (windowSize <= 0) return 'filler'; // no window → treat as filler

        var maxDur = getLayerDurationMax(layer);

        // pinExact flag overrides ratio
        if (layer.pinExact || layer.pinned) return 'pinned';
        // op='=' with duration >= window → pinned
        var op = layer.op || layer.operator || '>=';
        if ((op === '=' || op === '==') && maxDur >= windowSize) return 'pinned';

        var ratio = maxDur / windowSize;
        if (ratio >= 1.0) return 'pinned';
        if (ratio >= SOFT_PIN_RATIO) return 'soft-pinned';
        return 'filler';
    }

    function getChangeBufferDuration() {
        var gs = getGlobalSettings();
        return parseInt(gs.app1?.changeBufferDuration) ||
               parseInt(gs.changeBufferDuration) || 10;
    }

    // =========================================================================
    // DIVISION / BUNK RESOLUTION
    // =========================================================================

    function getDivisions() {
        var gs = getGlobalSettings();
        return gs.app1?.divisions || gs.divisions || window.divisions || {};
    }

    function getBunksForDivision(divName) {
        var divs = getDivisions();
        return (divs[divName]?.bunks || []).map(String);
    }

    function getDivisionForGrade(grade) {
        var divs = getDivisions();
        // Try direct match first
        if (divs[grade]) return grade;
        // Try alias/grade field
        for (var d in divs) {
            if (divs[d].grade === grade || divs[d].name === grade) return d;
        }
        return grade; // fallback — assume grade IS the division name
    }

    function getDivisionTimes(divName) {
        var divs = getDivisions();
        var div = divs[divName] || {};
        var start = parseTime(div.startTime || div.start) || 540;
        var end = parseTime(div.endTime || div.end || div.dismissalTime) || 900;
        return { start: start, end: end };
    }

    // =========================================================================
    // PHASE 0: COMPILE RULES FROM LAYERS
    // =========================================================================
    // Classifies each layer by its duration-to-window ratio:
    //
    //   PINNED:      duration >= window  OR hard anchor type (swim/lunch/snacks/dismissal)
    //                → locked slot stamped at startMin, full window width
    //   SOFT-PINNED: duration / window >= 0.6
    //                → locked slot, placed at earliest free spot within window
    //   FILLER:      duration / window < 0.6
    //                → unlocked slot within window, solver picks activity
    //
    // All three produce anchorRules (locked) or windowedRules (solver-fillable).

    function compileRules(layers, divName, dayName) {
        var anchorRules = [];      // locked slots (pinned + soft-pinned)
        var windowedRules = [];    // solver-fillable slots within a time window
        var frequencyRules = [];   // "N of type T per day" rules (no time window)

        layers.forEach(function (layer) {
            var grade = layer.grade || layer.division || '_all';
            var layerDiv = getDivisionForGrade(grade);
            if (layerDiv !== divName && grade !== '_all') return;

            // Day-of-week filter
            if (layer.days && layer.days.length > 0) {
                if (layer.days.indexOf(dayName) < 0 &&
                    layer.days.indexOf(dayName.toLowerCase()) < 0) return;
            }

            var layerType = (layer.type || layer.event || 'activity').toLowerCase();
            var startMin = layer.startMin != null ? layer.startMin : parseTime(layer.startTime);
            var endMin   = layer.endMin   != null ? layer.endMin   : parseTime(layer.endTime);
            var duration = getLayerDuration(layer);
            var windowSize = (startMin != null && endMin != null) ? Math.max(0, endMin - startMin) : 0;

            var classification = classifyLayer(layer);

            if (classification === 'pinned') {
                // Locked slot spanning the full window (duration == windowSize)
                var pinnedDur = windowSize > 0 ? windowSize : duration;
                anchorRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || layerType,
                    startMin: startMin,
                    endMin: endMin,
                    duration: pinnedDur,
                    windowMin: startMin,
                    windowMax: endMin,
                    placement: 'pinned',    // at startMin, full width
                    _layer: layer
                });

            } else if (classification === 'soft-pinned') {
                // Locked slot of own duration, placed at earliest free spot in window
                anchorRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || layerType,
                    startMin: startMin,
                    endMin: endMin,
                    duration: duration,
                    windowMin: startMin,
                    windowMax: endMin,
                    placement: 'soft-pinned',  // floating within window, locked
                    _layer: layer
                });

            } else if (startMin != null && endMin != null) {
                // Filler: solver-fillable slot within window
                var qty = layer.qty || layer.quantity || 1;
                var op  = layer.op  || layer.operator  || '>=';
                windowedRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || null,
                    startMin: startMin,
                    endMin: endMin,
                    duration: duration,
                    quantity: qty,
                    operator: op,
                    _scarce: layer.scarce || layer._scarce || false,
                    _layer: layer
                });

            } else if (layer.qty || layer.quantity) {
                // Quantity-only rule (no time window)
                frequencyRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || null,
                    duration: duration,
                    quantity: layer.qty || layer.quantity,
                    operator: layer.op || layer.operator || '>=',
                    _layer: layer
                });
            }
        });

        return { anchorRules: anchorRules, windowedRules: windowedRules, frequencyRules: frequencyRules };
    }

    // =========================================================================
    // PHASE 1: PLACE ANCHORS
    // =========================================================================
    // Places all anchor rules (pinned + soft-pinned) as locked slots.
    //
    //   SWIM:        staggered per-bunk with pre/post change buffers
    //   PINNED:      simultaneous, at startMin, full window width
    //   SOFT-PINNED: simultaneous, own duration, at earliest free spot in window

    function placeAnchors(timelines, anchorRules, divName, dayName) {
        var changeBuf = getChangeBufferDuration();

        // Sort by startMin so anchors are placed in chronological order
        // regardless of the order layers were defined by the user.
        var sorted = anchorRules.slice().sort(function (a, b) {
            return (a.startMin || 0) - (b.startMin || 0);
        });

        sorted.forEach(function (rule) {
            var isSwim = rule.layerType === 'swim';

            if (isSwim) {
                // ── STAGGERED SWIM ──────────────────────────────────────────
                var sortedTimelines = timelines.slice().sort(function (a, b) {
                    var na = parseInt(a.bunkName.replace(/\D/g, '')) || 0;
                    var nb = parseInt(b.bunkName.replace(/\D/g, '')) || 0;
                    return na - nb;
                });

                var cursor   = rule.startMin;
                var swimWindow = rule.endMin;
                var swimDur  = rule.duration;

                sortedTimelines.forEach(function (tl) {
                    // Pre-change
                    if (changeBuf > 0 && cursor - changeBuf >= tl.dayStart &&
                        !hasConflict(tl.slots, cursor - changeBuf, cursor)) {
                        tl.slots.push({
                            startMin: cursor - changeBuf,
                            endMin:   cursor,
                            activity: 'Change', activityType: 'change',
                            locked: true, source: 'swim-pre-change', _ruleId: rule.id
                        });
                    }

                    // Swim — compress if overflows window
                    var swimStart = cursor;
                    var swimEnd   = swimStart + swimDur;
                    if (swimEnd > swimWindow) { swimStart = swimWindow - swimDur; swimEnd = swimWindow; }

                    tl.slots.push({
                        startMin: swimStart, endMin: swimEnd,
                        activity: rule.event || 'Swim', activityType: 'swim',
                        locked: true, source: 'anchor-swim', _ruleId: rule.id
                    });

                    // Post-change
                    if (changeBuf > 0) {
                        tl.slots.push({
                            startMin: swimEnd, endMin: swimEnd + changeBuf,
                            activity: 'Change', activityType: 'change',
                            locked: true, source: 'swim-post-change', _ruleId: rule.id
                        });
                    }

                    cursor = swimEnd + changeBuf;
                });

                log('Swim staggered across ' + sortedTimelines.length + ' bunks. ' +
                    'Window: ' + fmtTime(rule.startMin) + '-' + fmtTime(rule.endMin));

            } else if (rule.placement === 'pinned') {
                // ── SIMULTANEOUS PINNED (full window width) ─────────────────
                timelines.forEach(function (tl) {
                    tl.slots.push({
                        startMin: rule.startMin,
                        endMin:   rule.startMin + rule.duration,
                        activity: rule.event || rule.layerType,
                        activityType: rule.layerType,
                        locked: true, source: 'anchor-pinned', _ruleId: rule.id
                    });
                });
                log('Anchor "' + rule.layerType + '" placed simultaneously for all bunks at ' +
                    fmtTime(rule.startMin) + ' (' + rule.duration + 'min)');

            } else {
                // ── SIMULTANEOUS SOFT-PINNED (own duration, earliest free spot) ─
                timelines.forEach(function (tl) {
                    var dur    = rule.duration;
                    var wStart = rule.windowMin;
                    var wEnd   = rule.windowMax;
                    var cursor = wStart;
                    var placed = false;

                    while (cursor + dur <= wEnd) {
                        if (!hasConflict(tl.slots, cursor, cursor + dur)) {
                            tl.slots.push({
                                startMin: cursor, endMin: cursor + dur,
                                activity: rule.event || rule.layerType,
                                activityType: rule.layerType,
                                locked: true, source: 'anchor-soft-pinned', _ruleId: rule.id
                            });
                            placed = true;
                            break;
                        }
                        cursor += 5;
                    }

                    if (!placed) {
                        // Fallback: stamp at window start
                        tl.slots.push({
                            startMin: wStart, endMin: wStart + dur,
                            activity: rule.event || rule.layerType,
                            activityType: rule.layerType,
                            locked: true, source: 'anchor-soft-pinned-fallback', _ruleId: rule.id
                        });
                    }
                });
                log('Anchor "' + rule.layerType + '" (soft-pinned ' + rule.duration + 'min) placed within ' +
                    fmtTime(rule.windowMin) + '-' + fmtTime(rule.windowMax));
            }
        });
    }
    function hasConflict(slots, startMin, endMin) {
        return slots.some(function (s) {
            return overlaps(s.startMin, s.endMin, startMin, endMin);
        });
    }

    // =========================================================================
    // PHASE 2: SCARCE PRE-ALLOCATION
    // =========================================================================
    // Scarce activities (e.g., Bubble Lady — only 1 bunk at a time, limited
    // capacity) get their windows reserved before regular windowed placement.
    // Fairness-ranked: bunks that had the activity least recently go first.

    function placeScarce(timelines, windowedRules, divName, dayName) {
        var scarceRules = windowedRules.filter(function (r) { return r._scarce; });
        if (scarceRules.length === 0) return;

        var rotationHistory = window.loadRotationHistory ? window.loadRotationHistory() : {};

        scarceRules.forEach(function (rule) {
            // Rank bunks by fairness (least recent first)
            var ranked = timelines.slice().sort(function (a, b) {
                var aLast = getLastOccurrence(rotationHistory, a.bunkName, rule.event || rule.layerType);
                var bLast = getLastOccurrence(rotationHistory, b.bunkName, rule.event || rule.layerType);
                return aLast - bLast; // oldest first
            });

            var capacity = rule._layer?.capacity || 1; // bunks served simultaneously
            var qty = rule.quantity || 1;
            var dur = rule.duration;
            var cursor = rule.startMin;

            // Place in batches of <capacity>
            for (var i = 0; i < ranked.length && qty > 0; i += capacity) {
                var batch = ranked.slice(i, i + capacity);
                var slotStart = cursor;
                var slotEnd = slotStart + dur;

                if (slotEnd > rule.endMin) break;

                // Check all bunks in batch have no conflict
                var ok = batch.every(function (tl) {
                    return !hasConflict(tl.slots, slotStart, slotEnd);
                });

                if (ok) {
                    batch.forEach(function (tl) {
                        tl.slots.push({
                            startMin: slotStart,
                            endMin: slotEnd,
                            activity: rule.event || null,
                            activityType: rule.layerType,
                            locked: false,
                            source: 'scarce',
                            _ruleId: rule.id
                        });
                    });
                    cursor = slotEnd;
                    qty--;
                }
            }
        });
    }

    function getLastOccurrence(history, bunkName, activityName) {
        if (!history || !activityName) return 0;
        var bunkHistory = history[bunkName] || history[String(bunkName)] || {};
        var dates = bunkHistory[activityName] || bunkHistory[(activityName || '').toLowerCase()] || [];
        if (!dates.length) return 0;
        var sorted = dates.slice().sort();
        return new Date(sorted[sorted.length - 1]).getTime() || 0;
    }

    // =========================================================================
    // PHASE 3: PER-BUNK REQUIREMENT SCORING
    // =========================================================================
    // Evaluates what each bunk still needs after anchors and scarce placement.
    // Returns a requirements object keyed by bunk name.

    function scoreRequirements(timelines, rules) {
        var reqs = {};

        timelines.forEach(function (tl) {
            var placed = {
                sport: 0, sports: 0,
                special: 0, specials: 0,
                activity: 0
            };
            tl.slots.forEach(function (s) {
                var t = (s.activityType || '').toLowerCase();
                if (placed[t] != null) placed[t]++;
            });

            var needs = {};
            rules.windowedRules.concat(rules.frequencyRules).forEach(function (rule) {
                var t = rule.layerType;
                var current = placed[t] || 0;
                var qty = rule.quantity || 1;
                var op = rule.operator || '>=';
                var deficit = 0;
                if (op === '>=' || op === '=') deficit = Math.max(0, qty - current);
                if (op === '<=') deficit = 0; // upper bound — no minimum need
                if (deficit > 0) {
                    needs[rule.id] = { rule: rule, deficit: deficit };
                }
            });

            reqs[tl.bunkName] = needs;
        });

        return reqs;
    }

    // =========================================================================
    // PHASE 4: TIMELINE CONSTRUCTION (typed placeholder slots)
    // =========================================================================
    // Fills free time in each bunk's timeline with typed placeholder slots.
    // The solver will later assign specific activities + fields to each.

    function buildTimelines(timelines, rules, divTimes) {
        var minSlotDur = 20; // don't create placeholder slots shorter than this

        timelines.forEach(function (tl) {
            // Sort existing slots chronologically
            tl.slots.sort(function (a, b) { return a.startMin - b.startMin; });

            // Find free gaps
            var gaps = findGaps(tl.slots, divTimes.start, divTimes.end);

            gaps.forEach(function (gap) {
                var gapDur = gap.end - gap.start;
                if (gapDur < minSlotDur) return;

                // Determine best type for this gap from windowed rules
                var type = pickTypeForGap(tl, gap, rules);

                // Fill the entire gap as one slot
                // The solver will handle internal subdivision if needed
                tl.slots.push({
                    startMin: gap.start,
                    endMin: gap.end,
                    activity: null,         // solver picks specific activity
                    activityType: type,     // 'sports', 'special', 'activity'
                    locked: false,          // solver can assign
                    source: 'phase4-gap',
                    _ruleId: null
                });
            });

            // Final sort
            tl.slots.sort(function (a, b) { return a.startMin - b.startMin; });
        });
    }

    function findGaps(slots, dayStart, dayEnd) {
        var sorted = slots.slice().sort(function (a, b) { return a.startMin - b.startMin; });
        var gaps = [];
        var cursor = dayStart;

        sorted.forEach(function (s) {
            if (s.startMin > cursor) {
                gaps.push({ start: cursor, end: s.startMin });
            }
            cursor = Math.max(cursor, s.endMin);
        });

        if (cursor < dayEnd) {
            gaps.push({ start: cursor, end: dayEnd });
        }

        return gaps;
    }

    function pickTypeForGap(tl, gap, rules) {
        // Find windowed rules whose window overlaps this gap
        // A rule's window overlaps if gap falls inside or partially inside it
        var midpoint = (gap.start + gap.end) / 2;
        var covering = rules.windowedRules.filter(function (r) {
            if (r._scarce) return false; // already handled in Phase 2
            // Skip snacks/lunch/dismissal windowed rules — those become locked slots
            var lt = (r.layerType || '').toLowerCase();
            if (lt === 'snack' || lt === 'snacks' || lt === 'lunch' || lt === 'dismissal') return false;
            // Gap midpoint falls within window
            return r.startMin <= midpoint && r.endMin >= midpoint;
        });

        if (covering.length === 0) return 'activity';

        // Prefer most specific type
        var types = covering.map(function (r) { return r.layerType; });
        if (types.indexOf('sports') >= 0 || types.indexOf('sport') >= 0) return 'sports';
        if (types.indexOf('special') >= 0 || types.indexOf('specials') >= 0) return 'special';
        return types[0] || 'activity';
    }

    // =========================================================================
    // MAIN BUILD FUNCTION
    // =========================================================================

    function build(params) {
        var layers = params.layers || [];
        var dateStr = params.dateStr;
        var t0 = performance.now();

        log('=======================================================');
        log('BUILD v' + VERSION + ' | Date: ' + dateStr);
        log('Layers: ' + (Array.isArray(layers) ?
            Object.values(layers).flat().length :
            Object.values(layers).reduce(function(s, a) { return s + a.length; }, 0)));
        log('=======================================================');

        var warnings = [];
        var dayName = getDayName(dateStr);
        log('Day: ' + dayName);

        // Flatten layers (may be keyed by grade or a flat array)
        var allLayers = [];
        if (Array.isArray(layers)) {
            allLayers = layers;
        } else {
            Object.keys(layers).forEach(function (grade) {
                (layers[grade] || []).forEach(function (l) {
                    allLayers.push(Object.assign({}, l, { grade: l.grade || grade }));
                });
            });
        }

        if (allLayers.length === 0) {
            warnings.push('No layers defined');
            return { bunkTimelines: {}, warnings: warnings, _buildVersion: VERSION };
        }

        // Group layers by division.
        // Deduplicate by layer id within each division — the DAW editor stores
        // one copy of each layer per bunk key, so without dedup a dismissal
        // layer with qty=1 would produce N anchor rules (one per bunk).
        var layersByDiv = {};
        var seenByDiv = {};  // divName → fingerprint → true
        allLayers.forEach(function (layer) {
            var grade = layer.grade || layer.division || '_all';
            var divName = getDivisionForGrade(grade);
            if (!layersByDiv[divName]) { layersByDiv[divName] = []; seenByDiv[divName] = {}; }
            // Dedup key: id if present, otherwise type+startMin+endMin+periodMin fingerprint.
            // The DAW stores one copy of each layer per bunk key, so without dedup an 8-bunk
            // division would produce 8 anchor rules for a single dismissal layer.
            var layerType = (layer.type || layer.event || '').toLowerCase();
            var fp = layer.id ||
                (layerType + '|' + (layer.startMin || '') + '|' + (layer.endMin || '') +
                 '|' + (layer.periodMin || layer.durationMin || ''));
            if (seenByDiv[divName][fp]) return;
            seenByDiv[divName][fp] = true;
            layersByDiv[divName].push(layer);
        });

        var bunkTimelines = {};

        Object.keys(layersByDiv).forEach(function (divName) {
            var divLayers = layersByDiv[divName];
            var divTimes = getDivisionTimes(divName);
            var bunks = getBunksForDivision(divName);

            if (bunks.length === 0) {
                warnings.push('Division "' + divName + '" has no bunks — skipping');
                return;
            }

            log('\nDivision: ' + divName + ' | Bunks: ' + bunks.join(', ') +
                ' | ' + fmtTime(divTimes.start) + '-' + fmtTime(divTimes.end));

            // ── Phase 0: Compile rules ────────────────────────────────────
            var rules = compileRules(divLayers, divName, dayName);
            log('[Phase 0] ' + rules.anchorRules.length + ' anchors, ' +
                rules.windowedRules.length + ' windowed, ' +
                rules.frequencyRules.length + ' frequency rules');

            // ── Initialize per-bunk timeline objects ──────────────────────
            var timelines = bunks.map(function (bunk) {
                return {
                    bunkName: bunk,
                    divisionName: divName,
                    dayStart: divTimes.start,
                    dayEnd: divTimes.end,
                    slots: []
                };
            });

            // ── Phase 1: Place anchors ────────────────────────────────────
            placeAnchors(timelines, rules.anchorRules, divName, dayName);
            // Sort slots chronologically after placement so later phases
            // and the output reflect time order, not layer definition order.
            timelines.forEach(function (tl) {
                tl.slots.sort(function (a, b) { return a.startMin - b.startMin; });
            });
            log('[Phase 1] Anchors placed');

            // ── Phase 2: Scarce pre-allocation ───────────────────────────
            placeScarce(timelines, rules.windowedRules, divName, dayName);
            log('[Phase 2] Scarce pre-allocation done');

            // ── Phase 3: Requirement scoring ─────────────────────────────
            var reqs = scoreRequirements(timelines, rules);
            var needCount = Object.values(reqs).reduce(function (s, r) {
                return s + Object.keys(r).length;
            }, 0);
            log('[Phase 3] ' + needCount + ' bunk-level requirements identified');

            // ── Phase 4: Timeline construction ───────────────────────────
            buildTimelines(timelines, rules, divTimes);

            var totalSlots = timelines.reduce(function (s, tl) {
                return s + tl.slots.length;
            }, 0);
            log('[Phase 4] Timeline built: ' + totalSlots + ' total slots across ' +
                bunks.length + ' bunks');

            // ── Collect into output bunkTimelines ────────────────────────
            timelines.forEach(function (tl) {
                bunkTimelines[tl.bunkName] = {
                    bunkName: tl.bunkName,
                    divisionName: tl.divisionName,
                    dayStart: tl.dayStart,
                    dayEnd: tl.dayEnd,
                    slots: tl.slots.map(function (s) {
                        return {
                            startMin: s.startMin,
                            endMin: s.endMin,
                            activity: s.activity || null,
                            activityType: s.activityType,
                            field: s.field || null,
                            locked: s.locked || false,
                            source: s.source,
                            _ruleId: s._ruleId || null
                        };
                    })
                };
            });
        });

        // ── Phases 5-7 REMOVED ───────────────────────────────────────────
        // Conflict resolution, gap fill, and specific activity assignment
        // are handled by total_solver_engine via bunk_engine_integration.js.

        var elapsed = Math.round(performance.now() - t0);
        var bunkCount = Object.keys(bunkTimelines).length;

        log('\nBuild complete in ' + elapsed + 'ms. ' +
            bunkCount + ' bunks. → handing off to solver.');

        if (warnings.length > 0) {
            log('Warnings:');
            warnings.forEach(function (w) { log('  ⚠ ' + w); });
        }

        return {
            bunkTimelines: bunkTimelines,
            warnings: warnings,
            _buildDate: dateStr,
            _buildVersion: VERSION,
            _elapsedMs: elapsed,
            _autoGenerated: true
        };
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.BunkScheduleEngine = {
        build: function (config) {
            var result = build(config);
            window._lastBunkTimelines = result.bunkTimelines; // for diagnostics
            return result;
        },
        VERSION: VERSION,
        // Exposed utilities (used by integration layer)
        fmtTime: fmtTime,
        parseTime: parseTime
    };

    log('Loaded v' + VERSION);

})();
