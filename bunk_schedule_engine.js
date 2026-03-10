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

    var ALWAYS_ANCHOR_TYPES = ['swim', 'lunch', 'snack', 'snacks', 'dismissal'];
    var CHANGE_BUFFER_TYPES = ['swim'];

    function isAnchorType(layerType) {
        return ALWAYS_ANCHOR_TYPES.indexOf((layerType || '').toLowerCase()) >= 0;
    }

    function needsChangeBuffer(layerType) {
        return CHANGE_BUFFER_TYPES.indexOf((layerType || '').toLowerCase()) >= 0;
    }

    function getLayerDuration(layer) {
        return layer.periodMin || layer.durationMin || layer.duration ||
            ((layer.endMin || 0) - (layer.startMin || 0)) || 30;
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
    // Converts raw layer objects into typed rule objects that the placement
    // phases can work with.

    function compileRules(layers, divName, dayName) {
        var anchorRules = [];      // fixed-time: swim, lunch, snack, dismissal
        var windowedRules = [];    // time-windowed type blocks
        var frequencyRules = [];   // "X of type Y per day" rules

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
            var endMin = layer.endMin != null ? layer.endMin : parseTime(layer.endTime);
            var duration = getLayerDuration(layer);

            if (isAnchorType(layerType)) {
                anchorRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || layerType,
                    startMin: startMin,
                    endMin: endMin,
                    duration: duration,
                    pinExact: layer.pinExact || true,
                    _layer: layer
                });
            } else if (startMin != null && endMin != null && layer.pinExact) {
                // Pinned non-anchor (exact time window)
                windowedRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || layerType,
                    startMin: startMin,
                    endMin: endMin,
                    duration: duration,
                    pinExact: true,
                    _scarce: layer.scarce || layer._scarce || false,
                    _layer: layer
                });
            } else if (startMin != null && endMin != null) {
                // Time window (flexible placement within window)
                var qty = layer.quantity || 1;
                var op = layer.operator || '>=';
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
            } else if (layer.quantity) {
                // Quantity-only rule (no time window)
                frequencyRules.push({
                    id: layer.id || uid(),
                    layerType: layerType,
                    event: layer.event || null,
                    duration: duration,
                    quantity: layer.quantity,
                    operator: layer.operator || '>=',
                    _layer: layer
                });
            }
        });

        return { anchorRules: anchorRules, windowedRules: windowedRules, frequencyRules: frequencyRules };
    }

    // =========================================================================
    // PHASE 1: PLACE ANCHORS (swim staggered, others simultaneous)
    // =========================================================================
    // Anchors (swim, lunch, snack, dismissal) are placed first as locked slots.
    //
    // Swim is special: staggered across bunks with change buffers.
    // All other anchors are simultaneous across all bunks.

    function placeAnchors(timelines, anchorRules, divName, dayName) {
        var changeBuf = getChangeBufferDuration();
        var bunks = timelines.map(function (tl) { return tl.bunkName; });

        anchorRules.forEach(function (rule) {
            var isSwim = rule.layerType === 'swim';

            if (isSwim) {
                // ── STAGGERED SWIM ──────────────────────────────────────────
                // Sort bunks by number (Bunk 1, Bunk 2, ...) for deterministic order.
                var sortedTimelines = timelines.slice().sort(function (a, b) {
                    var na = parseInt(a.bunkName.replace(/\D/g, '')) || 0;
                    var nb = parseInt(b.bunkName.replace(/\D/g, '')) || 0;
                    return na - nb;
                });

                // cursor = earliest we can place the next bunk's swim
                var cursor = rule.startMin;
                var swimWindow = rule.endMin;
                var swimDur = rule.duration;

                sortedTimelines.forEach(function (tl) {
                    // Pre-change: if there's a change buffer before swim
                    var preStart = cursor - changeBuf;
                    var preEnd = cursor;

                    // Check if pre-change fits (don't go before day start)
                    var dayStart = tl.dayStart;
                    if (changeBuf > 0 && preStart >= dayStart && !hasConflict(tl.slots, preStart, preEnd)) {
                        tl.slots.push({
                            startMin: preStart,
                            endMin: preEnd,
                            activity: 'Change',
                            activityType: 'change',
                            locked: true,
                            source: 'swim-pre-change',
                            _ruleId: rule.id
                        });
                    }

                    // Swim slot
                    var swimStart = cursor;
                    var swimEnd = swimStart + swimDur;

                    // If swim overflows window, try to compress
                    if (swimEnd > swimWindow) {
                        swimStart = swimWindow - swimDur;
                        swimEnd = swimWindow;
                    }

                    tl.slots.push({
                        startMin: swimStart,
                        endMin: swimEnd,
                        activity: rule.event || 'Swim',
                        activityType: 'swim',
                        locked: true,
                        source: 'anchor-swim',
                        _ruleId: rule.id
                    });

                    // Post-change
                    if (changeBuf > 0) {
                        tl.slots.push({
                            startMin: swimEnd,
                            endMin: swimEnd + changeBuf,
                            activity: 'Change',
                            activityType: 'change',
                            locked: true,
                            source: 'swim-post-change',
                            _ruleId: rule.id
                        });
                    }

                    // Advance cursor: next bunk starts after this bunk's post-change
                    cursor = swimEnd + changeBuf;
                });

                log('Swim staggered across ' + sortedTimelines.length + ' bunks. ' +
                    'Window: ' + fmtTime(rule.startMin) + '-' + fmtTime(rule.endMin));

            } else {
                // ── SIMULTANEOUS ANCHOR (lunch, snack, dismissal) ──────────
                timelines.forEach(function (tl) {
                    tl.slots.push({
                        startMin: rule.startMin,
                        endMin: rule.endMin != null ? rule.endMin : rule.startMin + rule.duration,
                        activity: rule.event || rule.layerType,
                        activityType: rule.layerType,
                        locked: true,
                        source: 'anchor-' + rule.layerType,
                        _ruleId: rule.id
                    });
                });

                log('Anchor "' + rule.layerType + '" placed simultaneously for all bunks at ' +
                    fmtTime(rule.startMin));
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
        // Check if any windowed rule covers this gap
        var covering = rules.windowedRules.filter(function (r) {
            if (r._scarce) return false; // already handled in Phase 2
            return r.startMin <= gap.start && r.endMin >= gap.end;
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

        // Group layers by division
        var layersByDiv = {};
        allLayers.forEach(function (layer) {
            var grade = layer.grade || layer.division || '_all';
            var divName = getDivisionForGrade(grade);
            if (!layersByDiv[divName]) layersByDiv[divName] = [];
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
