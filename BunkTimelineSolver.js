// =================================================================
// BunkTimelineSolver.js  (v1.1)
// =================================================================
// The core bunk-level timeline engine. For each bunk, reads:
//   • Weekly matrix row (activity types for this bunk/day)
//   • Scarce allocator pre-committed blocks
//   • Grade layer rules (windows, durations, timesPerDay)
//   • activityProperties (transition times, durations)
//
// Builds a complete, independent daily timeline using the
// Posts-and-Gaps model, then writes output into the perBunkSlots
// format that division_times_system.js already reads natively.
//
// ARCHITECTURE CONTRACT:
//   - Reads WeeklyAllocationSolver.getBunkDayRow(bunk, dateStr)
//   - Reads window.activityProperties for transition times
//   - Reads RotationEngine for activity identity scoring
//   - NEVER modifies total_solver_engine.js or rotation_engine.js
//   - NEVER modifies division_times_system.js
//   - Output blocks carry _suggestedActivity hints for the solver
//   - Output is written to window.divisionTimes via DayPlanEngine
//
// POSTS-AND-GAPS MODEL:
//   Step 1 — Feasibility: sum durations + transitions vs day length
//   Step 2 — Composite priority score → placement order
//   Step 3 — HARD posts placed first; divide day into segments
//   Step 4 — SOFT posts find best position by tightness
//   Step 5 — FILLER activities flow into remaining gaps
//   Step 6 — Transition times respected during gap fitting
//   Step 7 — Sequence → real start/end timestamps → perBunkSlots
//
// COMPOSITE PRIORITY SCORE:
//   timeScore     = HARD:100 | SOFT:50 | FILLER:10
//   identityScore = known identity:+50 | unknown:0
//   scarceBonus   = mustFillCapacity:+40 | normal:0
//   priority      = timeScore + identityScore + scarceBonus (desc)
//
// v1.1 CHANGES:
//   - pickBestIdentity() accepts blockedActivities Set param
//   - buildForBunk() accepts blockedActivities, passes to pickBestIdentity
//   - layerQtyMap built from layerRules for operator/qty enforcement
//   - Operator cap (= and <=) applied when building typeCounters posts
// =================================================================

(function () {
    'use strict';

    var VERSION = '1.1';

    // =================================================================
    // LOGGING
    // =================================================================
    var _logs = [];
    function log(msg) { _logs.push(msg); console.log('[BunkTimeline] ' + msg); }
    function warn(msg) { _logs.push('⚠ ' + msg); console.warn('[BunkTimeline] ' + msg); }
    function clearLogs() { _logs = []; }
    function getLogs() { return _logs.slice(); }

    // =================================================================
    // TIME UTILITIES
    // =================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        var s = str.trim().toLowerCase();
        var mer = null;
        if (s.endsWith('am') || s.endsWith('pm')) {
            mer = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        var hh = parseInt(m[1], 10);
        var mm = parseInt(m[2], 10);
        if (isNaN(hh) || isNaN(mm) || mm < 0 || mm > 59) return null;
        if (mer) {
            if (hh === 12) hh = mer === 'am' ? 0 : 12;
            else if (mer === 'pm') hh += 12;
        } else {
            if (hh < 0 || hh > 23) return null;
        }
        return hh * 60 + mm;
    }

    function minutesToTimeLabel(min) {
        var h = Math.floor(min / 60);
        var m = min % 60;
        var ap = h >= 12 ? 'PM' : 'AM';
        var h12 = h % 12 || 12;
        return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
    }

    function minutesToDate(min) {
        var now = new Date();
        now.setHours(Math.floor(min / 60), min % 60, 0, 0);
        return now;
    }

    function overlaps(aStart, aEnd, bStart, bEnd) {
        return aStart < bEnd && aEnd > bStart;
    }

    function uid() {
        return 'bts_' + Math.random().toString(36).slice(2, 9);
    }

    // =================================================================
    // ANCHOR CLASSIFICATION  (mirrors WeeklyAllocationSolver)
    // =================================================================

    /**
     * ratio = duration / (windowEnd - windowStart)
     * >= 0.85 → HARD | 0.40–0.84 → SOFT | < 0.40 → FILLER | > 1.0 → INVALID
     */
    function classifyAnchor(duration, windowStart, windowEnd) {
        var windowMin = (windowEnd || 0) - (windowStart || 0);
        if (windowMin <= 0) return 'HARD';
        var ratio = duration / windowMin;
        if (ratio > 1.0) return 'INVALID';
        if (ratio >= 0.85) return 'HARD';
        if (ratio >= 0.40) return 'SOFT';
        return 'FILLER';
    }

    // =================================================================
    // ACTIVITY PROPERTIES ACCESSORS
    // =================================================================

    function getActivityProperties() {
        return window.activityProperties || {};
    }

    /**
     * Get transition (pre + post buffer) for an activity in minutes.
     * Falls back to 0 if not configured.
     */
    function getTransitionMinutes(activityName) {
        if (!activityName) return 0;
        var props = getActivityProperties();
        var p = props[activityName];
        if (!p) return 0;
        var t = p.transition || {};
        return (parseInt(t.preMin, 10) || 0) + (parseInt(t.postMin, 10) || 0);
    }

    /**
     * Get the configured duration for a known activity (special).
     * Returns null if not found.
     */
    function getKnownDuration(activityName) {
        if (!activityName) return null;
        var props = getActivityProperties();
        var p = props[activityName];
        if (p && p.duration && parseInt(p.duration, 10) > 0) return parseInt(p.duration, 10);
        return null;
    }

    // =================================================================
    // DIVISION / GRADE LOOKUPS
    // =================================================================

    function getCampStructure() {
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        return g.campStructure || {};
    }

    function getGradeForBunk(bunkName) {
        var structure = getCampStructure();
        for (var divName in structure) {
            var grades = structure[divName].grades || {};
            for (var gradeName in grades) {
                var bunks = grades[gradeName].bunks || [];
                if (bunks.indexOf(bunkName) !== -1) return gradeName;
            }
        }
        return null;
    }

    function getDivisionForBunk(bunkName) {
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionForBunk) {
            return window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
        }
        var structure = getCampStructure();
        for (var divName in structure) {
            var grades = structure[divName].grades || {};
            for (var gradeName in grades) {
                var bunks = grades[gradeName].bunks || [];
                if (bunks.indexOf(bunkName) !== -1) return divName;
            }
        }
        return null;
    }

    /**
     * Get division start/end in minutes for a bunk.
     * Reads from app1.divisions (where Flow stores startTime/endTime).
     */
    function getDivisionTimeRange(bunkName) {
        var divName = getDivisionForBunk(bunkName);
        if (!divName) return null;

        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var divisions = (g.app1 || {}).divisions || {};
        var div = divisions[divName] || {};

        var startMin = parseTimeToMinutes(div.startTime);
        var endMin = parseTimeToMinutes(div.endTime);
        if (startMin === null || endMin === null) return null;

        return { startMin: startMin, endMin: endMin, divName: divName };
    }

    /**
     * Get grade layer rules for this bunk.
     */
    function getLayerRulesForBunk(bunkName) {
        var grade = getGradeForBunk(bunkName);
        if (!grade) return [];
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var rules = ((g.app1 || {}).gradeLayerRules || {})[grade] || [];
        return rules;
    }

    /**
     * Build a quick operator+qty lookup from layer rules.
     * Used to cap how many posts of each type are created.
     * { actType: { op: '>=', qty: 2 } }
     */
    function buildLayerQtyMap(layerRules) {
        var map = {};
        layerRules.forEach(function (rule) {
            if (!rule.type) return;
            var op = (rule.operator || rule.weeklyOp || '>=')
                .replace('\u2265', '>=')
                .replace('\u2264', '<=');
            map[rule.type] = {
                op:  op,
                qty: rule.timesPerDay || rule.quantity || 1
            };
        });
        return map;
    }

    // =================================================================
    // ROTATION IDENTITY SCORING
    // =================================================================

    /**
     * Given an activity type (e.g. 'special', 'sport', 'swim'),
     * pick the best concrete activity identity for this bunk via rotation.
     *
     * @param {string}  bunkName
     * @param {string}  activityType
     * @param {Set}     blockedActivities  — activity names to exclude (capacity-full on prior solve)
     * @returns {{ name, score } | null}
     */
    function pickBestIdentity(bunkName, activityType, blockedActivities) {
        blockedActivities = blockedActivities || new Set();
        var props = getActivityProperties();
        var candidates = [];

        Object.keys(props).forEach(function (name) {
            var p = props[name];
            // Match type: 'special' prop type must match requested type
            var pType = (p.type || '').toLowerCase();
            var aType = (activityType || '').toLowerCase();
            if (pType !== aType && pType !== 'activity') return;
            if (p.available === false) return;

            // ★ Skip activities blocked due to capacity exhaustion on a prior solve pass
            if (blockedActivities.has(name)) return;

            var score = 0;
            if (window.RotationEngine && window.RotationEngine.getDaysSinceActivity) {
                var days = window.RotationEngine.getDaysSinceActivity(bunkName, name, 0);
                score = (days === null || days === undefined) ? 999 : days;
            } else {
                score = 1;
            }
            candidates.push({ name: name, score: score });
        });

        if (candidates.length === 0) return null;
        candidates.sort(function (a, b) { return b.score - a.score; });
        return candidates[0];
    }

    // =================================================================
    // COMPOSITE PRIORITY SCORE
    // =================================================================

    /**
     * Compute placement priority for a post.
     * post: { anchor, hasKnownIdentity, isScarce }
     */
    function computePriority(post) {
        var timeScore = post.anchor === 'HARD' ? 100 : post.anchor === 'SOFT' ? 50 : 10;
        var identityScore = post.hasKnownIdentity ? 50 : 0;
        var scarceBonus = post.isScarce ? 40 : 0;
        return timeScore + identityScore + scarceBonus;
    }

    // =================================================================
    // FEASIBILITY CHECK
    // =================================================================

    /**
     * Before placing anything, verify total committed time fits the day.
     * Returns { feasible, totalRequired, totalAvailable, deficit }
     */
    function checkFeasibility(posts, dayStart, dayEnd) {
        var totalAvailable = dayEnd - dayStart;
        var totalRequired = 0;

        posts.forEach(function (post) {
            totalRequired += post.duration;
            totalRequired += getTransitionMinutes(post.knownIdentity);
        });

        var deficit = totalRequired - totalAvailable;
        return {
            feasible: deficit <= 0,
            totalRequired: totalRequired,
            totalAvailable: totalAvailable,
            deficit: Math.max(0, deficit)
        };
    }

    // =================================================================
    // GAP FINDER
    // =================================================================

    /**
     * Given a sorted list of committed time ranges, return the free gaps
     * within [dayStart, dayEnd].
     * ranges: [{ startMin, endMin }, ...]
     */
    function findGaps(ranges, dayStart, dayEnd) {
        var sorted = ranges.slice().sort(function (a, b) { return a.startMin - b.startMin; });
        var gaps = [];
        var cursor = dayStart;

        sorted.forEach(function (r) {
            if (r.startMin > cursor) {
                gaps.push({ startMin: cursor, endMin: r.startMin });
            }
            cursor = Math.max(cursor, r.endMin);
        });

        if (cursor < dayEnd) {
            gaps.push({ startMin: cursor, endMin: dayEnd });
        }

        return gaps;
    }

    /**
     * Find the best gap to place a block of `duration` minutes.
     * Respects windowStart/windowEnd if provided.
     * Returns { startMin, endMin } or null.
     */
    function findBestGap(gaps, duration, windowStart, windowEnd) {
        var best = null;
        var bestSlack = Infinity;

        gaps.forEach(function (gap) {
            // Intersect gap with the activity's time window
            var rangeStart = Math.max(gap.startMin, windowStart !== undefined ? windowStart : gap.startMin);
            var rangeEnd = Math.min(gap.endMin, windowEnd !== undefined ? windowEnd : gap.endMin);

            if (rangeEnd - rangeStart < duration) return; // Doesn't fit

            var slack = (rangeEnd - rangeStart) - duration;

            // Prefer the gap with least slack (tightest fit → most constrained first)
            if (slack < bestSlack) {
                bestSlack = slack;
                best = { startMin: rangeStart, endMin: rangeStart + duration };
            }
        });

        return best;
    }

    // =================================================================
    // CORE SOLVER: buildForBunk
    // =================================================================

    /**
     * Build the complete daily timeline for a single bunk.
     *
     * @param {object} params
     *   params.bunkName          {string}
     *   params.dateStr           {string}  'YYYY-MM-DD'
     *   params.matrixRow         {string[]} activity types for today from WeeklyAllocationSolver
     *   params.scarceBlocks      {object[]} pre-committed blocks from ScarceActivityAllocator
     *                            Each: { activityName, type, startMin, endMin, _suggestedActivity }
     *   params.warnings          {string[]} shared warnings array (mutated)
     *   params.blockedActivities {Set}      activity names that failed capacity on a prior solve
     *                                       — excluded from pickBestIdentity
     *
     * @returns {object[]} perBunkSlots array (matches division_times_system.js format)
     */
    function buildForBunk(params) {
        var bunkName         = params.bunkName;
        var dateStr          = params.dateStr;
        var matrixRow        = params.matrixRow        || [];
        var scarceBlocks     = params.scarceBlocks     || [];
        var warnings         = params.warnings         || [];
        // ★ v1.1: activities blocked due to capacity exhaustion on a prior solve
        var blockedActivities = params.blockedActivities instanceof Set
            ? params.blockedActivities
            : new Set(params.blockedActivities || []);

        log('\n--- Bunk: ' + bunkName + ' / ' + dateStr + ' ---');
        if (blockedActivities.size > 0) {
            log('  Blocked activities: [' + Array.from(blockedActivities).join(', ') + ']');
        }

        // ── Division time range ────────────────────────────────────────
        var timeRange = getDivisionTimeRange(bunkName);
        if (!timeRange) {
            var msg = bunkName + ': No division time range found — skipping';
            warn(msg);
            warnings.push(msg);
            return [];
        }
        var dayStart = timeRange.startMin;
        var dayEnd   = timeRange.endMin;
        var divName  = timeRange.divName;

        log('  Day: ' + minutesToTimeLabel(dayStart) + ' → ' + minutesToTimeLabel(dayEnd) +
            ' (' + (dayEnd - dayStart) + ' min) [' + divName + ']');

        // ── Layer rules for this bunk's grade ──────────────────────────
        var layerRules = getLayerRulesForBunk(bunkName);
        log('  Layer rules: ' + layerRules.length);

        // ★ v1.1: Build operator+qty map from layer rules
        // Used to cap post count (= and <= operators mean never exceed qty).
        var layerQtyMap = buildLayerQtyMap(layerRules);

        // ── Build the post list ─────────────────────────────────────────
        // Posts = all activities that need to be placed today.
        // Sources: matrixRow types + scarce pre-committed blocks.

        var posts = [];

        // 1. Scarce blocks (already have exact times → treat as HARD with known identity)
        scarceBlocks.forEach(function (sb) {
            posts.push({
                id:               uid(),
                type:             sb.type || 'special',
                anchor:           'HARD',
                duration:         sb.endMin - sb.startMin,
                windowStart:      sb.startMin,
                windowEnd:        sb.endMin,
                knownIdentity:    sb.activityName || sb._suggestedActivity || null,
                hasKnownIdentity: !!(sb.activityName || sb._suggestedActivity),
                isScarce:         true,
                committed:        true,
                startMin:         sb.startMin,
                endMin:           sb.endMin,
                _suggestedActivity: sb.activityName || sb._suggestedActivity || null,
                _fromScarce:      true
            });
            log('  + Scarce post: ' + (sb.activityName || '?') +
                ' ' + minutesToTimeLabel(sb.startMin) + '–' + minutesToTimeLabel(sb.endMin));
        });

        // 2. Matrix-row types → find matching layer rule → create post
        //    Multiple occurrences of the same type → one post per occurrence.
        //    ★ v1.1: Operator cap: '=' and '<=' prevent placing more than qty.
        var typeCounters = {};
        matrixRow.forEach(function (actType) {
            typeCounters[actType] = (typeCounters[actType] || 0) + 1;
        });

        Object.keys(typeCounters).forEach(function (actType) {
            var count = typeCounters[actType];

            // ★ v1.1: Enforce operator ceiling before building posts
            var opRule = layerQtyMap[actType];
            if (opRule && (opRule.op === '=' || opRule.op === '<=')) {
                count = Math.min(count, opRule.qty);
            }

            // Find layer rule(s) matching this type
            var matchingRules = layerRules.filter(function (r) {
                return (r.type || '').toLowerCase() === actType.toLowerCase();
            });

            for (var i = 0; i < count; i++) {
                var rule        = matchingRules[i] || matchingRules[0] || null;
                var duration    = (rule && rule.duration) ? rule.duration : 30;
                var windowStart = (rule && rule.windowStart !== undefined) ? rule.windowStart : dayStart;
                var windowEnd   = (rule && rule.windowEnd   !== undefined) ? rule.windowEnd   : dayEnd;

                // Clamp window to day bounds
                windowStart = Math.max(dayStart, windowStart);
                windowEnd   = Math.min(dayEnd,   windowEnd);

                var anchor = classifyAnchor(duration, windowStart, windowEnd);

                if (anchor === 'INVALID') {
                    var msg = bunkName + ' / ' + actType + ' [rule ' + i + ']: duration exceeds window — INVALID, skipped';
                    warn(msg);
                    warnings.push(msg);
                    continue;
                }

                // Phase A pre-resolution: tentatively pick identity via rotation
                // ★ v1.1: Pass blockedActivities so exhausted activities are skipped
                var identity = pickBestIdentity(bunkName, actType, blockedActivities);
                var knownDur = identity ? getKnownDuration(identity.name) : null;
                // If the identity has a specific duration, use it (Phase A → Phase B)
                if (knownDur) duration = knownDur;

                posts.push({
                    id:               uid(),
                    type:             actType,
                    anchor:           anchor,
                    duration:         duration,
                    windowStart:      windowStart,
                    windowEnd:        windowEnd,
                    knownIdentity:    identity ? identity.name : null,
                    hasKnownIdentity: !!identity,
                    isScarce:         false,
                    committed:        false,
                    _suggestedActivity: identity ? identity.name : null,
                    _rule:            rule
                });

                log('  + Matrix post: ' + actType + ' (' + anchor + ', ' + duration + 'min)' +
                    (identity ? ' → suggest: ' + identity.name : ' → no identity (all blocked?)'));
            }
        });

        if (posts.length === 0) {
            warn(bunkName + ': No posts to place — empty day');
            return [];
        }

        // ── Step 1: Feasibility check ───────────────────────────────────
        var feasibility = checkFeasibility(posts, dayStart, dayEnd);
        if (!feasibility.feasible) {
            var fMsg = bunkName + ': Day infeasible — need ' + feasibility.totalRequired +
                ' min but only ' + feasibility.totalAvailable + ' min available' +
                ' (deficit: ' + feasibility.deficit + ' min)';
            warn(fMsg);
            warnings.push(fMsg);
            // Continue anyway — place what we can, surface warning
        }

        // ── Step 2: Sort by composite priority (desc) ───────────────────
        posts.forEach(function (p) { p._priority = computePriority(p); });
        posts.sort(function (a, b) { return b._priority - a._priority; });

        log('  Priority order: ' + posts.map(function (p) {
            return p.type + '(' + p._priority + ')';
        }).join(', '));

        // ── Step 3 & 4: Place posts ─────────────────────────────────────
        var placedBlocks = []; // { startMin, endMin, post }

        posts.forEach(function (post) {
            if (post.committed) {
                // Scarce blocks are pre-committed — just record placement
                placedBlocks.push({ startMin: post.startMin, endMin: post.endMin, post: post });
                return;
            }

            var transition  = getTransitionMinutes(post.knownIdentity);
            var effectiveDur = post.duration + transition;

            // Build current occupied ranges
            var occupied = placedBlocks.map(function (b) {
                return { startMin: b.startMin, endMin: b.endMin };
            });

            var gaps = findGaps(occupied, dayStart, dayEnd);

            if (post.anchor === 'HARD') {
                // HARD: must go exactly in its window
                var placed = findBestGap(gaps, effectiveDur, post.windowStart, post.windowEnd - post.duration);
                if (!placed) {
                    var hMsg = bunkName + ': Could not place HARD "' + post.type + '" (' + post.duration + ' min) in window ' +
                        minutesToTimeLabel(post.windowStart) + '–' + minutesToTimeLabel(post.windowEnd);
                    warn(hMsg);
                    warnings.push(hMsg);
                    return;
                }
                post.startMin = placed.startMin;
                post.endMin   = placed.startMin + post.duration;
                placedBlocks.push({ startMin: post.startMin, endMin: post.endMin, post: post });
                log('  ✓ HARD placed: ' + post.type + ' ' +
                    minutesToTimeLabel(post.startMin) + '–' + minutesToTimeLabel(post.endMin));

            } else if (post.anchor === 'SOFT') {
                // SOFT: flexible within window
                var softGaps = gaps.filter(function (g) {
                    return g.endMin > post.windowStart && g.startMin < post.windowEnd;
                });
                softGaps.sort(function (a, b) {
                    return (a.endMin - a.startMin) - (b.endMin - b.startMin);
                });

                var softPlaced = null;
                for (var gi = 0; gi < softGaps.length; gi++) {
                    var sg = softGaps[gi];
                    var rangeStart = Math.max(sg.startMin, post.windowStart);
                    var rangeEnd   = Math.min(sg.endMin,   post.windowEnd);
                    if (rangeEnd - rangeStart >= effectiveDur) {
                        softPlaced = { startMin: rangeStart, endMin: rangeStart + post.duration };
                        break;
                    }
                }

                if (!softPlaced) {
                    // Fallback: try anywhere in the day
                    softPlaced = findBestGap(gaps, effectiveDur, dayStart, dayEnd);
                }

                if (!softPlaced) {
                    var sMsg = bunkName + ': Could not place SOFT "' + post.type + '" (' + post.duration + ' min)';
                    warn(sMsg);
                    warnings.push(sMsg);
                    return;
                }
                post.startMin = softPlaced.startMin;
                post.endMin   = softPlaced.startMin + post.duration;
                placedBlocks.push({ startMin: post.startMin, endMin: post.endMin, post: post });
                log('  ✓ SOFT placed: ' + post.type + ' ' +
                    minutesToTimeLabel(post.startMin) + '–' + minutesToTimeLabel(post.endMin));

            } else {
                // FILLER: rotation drives placement — find any gap it fits
                var fillerPlaced = findBestGap(gaps, effectiveDur, post.windowStart, post.windowEnd);
                if (!fillerPlaced) {
                    fillerPlaced = findBestGap(gaps, effectiveDur, dayStart, dayEnd);
                }
                if (!fillerPlaced) {
                    var fMsg2 = bunkName + ': Could not place FILLER "' + post.type + '" (' + post.duration + ' min)';
                    warn(fMsg2);
                    warnings.push(fMsg2);
                    return;
                }
                post.startMin = fillerPlaced.startMin;
                post.endMin   = fillerPlaced.startMin + post.duration;
                placedBlocks.push({ startMin: post.startMin, endMin: post.endMin, post: post });
                log('  ✓ FILLER placed: ' + post.type + ' ' +
                    minutesToTimeLabel(post.startMin) + '–' + minutesToTimeLabel(post.endMin));
            }
        });

        // ── Step 6 & 7: Sort by time, convert to perBunkSlots ──────────
        placedBlocks.sort(function (a, b) { return a.startMin - b.startMin; });

        var slots = placedBlocks.map(function (b, idx) {
            var post     = b.post;
            var slotType = post._fromScarce ? 'scarce' : (post.anchor === 'HARD' ? 'pinned' : 'slot');

            return {
                slotIndex:          idx,
                startMin:           b.startMin,
                endMin:             b.endMin,
                duration:           b.endMin - b.startMin,
                event:              post.type,       // activity type label; solver fills real name
                type:               slotType,
                division:           divName,
                label:              minutesToTimeLabel(b.startMin) + ' - ' + minutesToTimeLabel(b.endMin),
                _bunk:              bunkName,
                _suggestedActivity: post._suggestedActivity || null,
                _autoGenerated:     true,
                _durationStrict:    post._fromScarce || post.anchor === 'HARD',
                _anchorClass:       post.anchor,
                _activityType:      post.type,       // ★ the logical type (special/sport/etc)
                start:              minutesToDate(b.startMin),
                end:                minutesToDate(b.endMin)
            };
        });

        log('  → ' + slots.length + ' slots placed for ' + bunkName);
        return slots;
    }

    // =================================================================
    // DIVISION-LEVEL ASSEMBLER
    // =================================================================

    /**
     * Build perBunkSlots for all bunks in a division and attach to
     * window.divisionTimes in the format DivisionTimesSystem expects.
     *
     * @param {object} params
     *   params.divName         {string}
     *   params.bunks           {string[]}
     *   params.dateStr         {string}
     *   params.scarceBlocksMap { bunkName: [block, ...] }
     *   params.warnings        {string[]}
     *
     * @returns { perBunkSlots: { bunkName: slot[] }, warnings: string[] }
     */
    function buildForDivision(params) {
        var divName         = params.divName;
        var bunks           = params.bunks           || [];
        var dateStr         = params.dateStr;
        var scarceBlocksMap = params.scarceBlocksMap || {};
        var warnings        = params.warnings        || [];

        log('\n==============================');
        log('Division: ' + divName + ' / ' + dateStr);
        log('Bunks: ' + bunks.join(', '));
        log('==============================');

        var perBunkSlots = {};

        bunks.forEach(function (bunk) {
            var matrixRow = [];
            if (window.WeeklyAllocationSolver) {
                matrixRow = window.WeeklyAllocationSolver.getBunkDayRow(bunk, dateStr) || [];
            }
            log('  ' + bunk + ' matrix row: [' + matrixRow.join(', ') + ']');

            var slots = buildForBunk({
                bunkName:     bunk,
                dateStr:      dateStr,
                matrixRow:    matrixRow,
                scarceBlocks: scarceBlocksMap[bunk] || [],
                warnings:     warnings
                // blockedActivities not passed here — only passed during refinement rebuilds
            });

            perBunkSlots[bunk] = slots;
        });

        return { perBunkSlots: perBunkSlots, warnings: warnings };
    }

    /**
     * Write the perBunkSlots output into window.divisionTimes using the
     * exact structure division_times_system.js expects for per-bunk mode.
     *
     * divisionTimes[divName]._isPerBunk = true
     * divisionTimes[divName]._perBunkSlots = { bunk: slot[] }
     * divisionTimes[divName] = firstBunkSlots (array with metadata attached)
     */
    function applyToDivisionTimes(divName, perBunkSlots) {
        if (!window.divisionTimes) window.divisionTimes = {};

        var firstBunkSlots = null;
        Object.keys(perBunkSlots).forEach(function (bunk) {
            if (!firstBunkSlots) firstBunkSlots = perBunkSlots[bunk];
        });

        var divSlots = firstBunkSlots || [];
        divSlots._perBunkSlots = perBunkSlots;
        divSlots._isPerBunk    = true;

        window.divisionTimes[divName] = divSlots;

        log('Applied ' + Object.keys(perBunkSlots).length +
            ' bunk slot arrays to divisionTimes["' + divName + '"]');
    }

    // =================================================================
    // PUBLIC API
    // =================================================================

    window.BunkTimelineSolver = {
        VERSION: VERSION,

        // Core
        buildForBunk:         buildForBunk,
        buildForDivision:     buildForDivision,
        applyToDivisionTimes: applyToDivisionTimes,
        buildLayerQtyMap:     buildLayerQtyMap,

        // Utilities (shared with DayPlanEngine)
        classifyAnchor:     classifyAnchor,
        computePriority:    computePriority,
        checkFeasibility:   checkFeasibility,
        parseTimeToMinutes: parseTimeToMinutes,
        minutesToTimeLabel: minutesToTimeLabel,
        findGaps:           findGaps,

        // Debug
        getLogs:   getLogs,
        clearLogs: clearLogs
    };

    log('BunkTimelineSolver v' + VERSION + ' loaded');

})();
