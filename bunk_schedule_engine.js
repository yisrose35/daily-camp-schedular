// =============================================================================
// bunk_schedule_engine.js — Campistry Bunk Schedule Engine v1.0.0
// =============================================================================
//
// The new AUTO generation pipeline. Replaces the grade-based AutoBuildEngine
// when a camp is running in AUTO mode.
//
// Core principle: every bunk owns its own independent timeline measured
// in real minutes. Time is never shared across a division.
//
// PIPELINE:
//   Phase 0 — Rule Compilation       (layers → typed rule objects)
//   Phase 1 — Hard Anchor Placement  (pinExact layers → locked slots)
//   Phase 2 — Scarce Pre-Allocation  (day-restricted specials → fairness-ranked)
//   Phase 3 — Requirement Scoring    (per-bunk to-do list for today)
//   Phase 4 — Timeline Construction  (build each bunk's complete day)
//   Phase 5 — Conflict Resolution    (fix shared-resource collisions)
//   Phase 6 — Gap Fill               (rotation-fair activity assignment)
//   Phase 7 — Validation + Output    (verify rules → emit bunkTimelines)
//
// OUTPUT:
//   { bunkTimelines, warnings, diagnostics }
//   bunkTimelines is keyed by bunkName. Each timeline has real-minute slots.
//   The renderer and save layer read bunkTimelines — NOT scheduleAssignments.
//
// READS FROM (existing systems, unchanged):
//   window.loadGlobalSettings()       — layers, special activities, fields, divisions
//   RotationEngine.getBunkHistory()   — per-bunk activity history
//   RotationEngine.calculateRotationScore() — fairness scoring for gap fill
//   SchedulerCoreUtils.getActivityCount()   — historical usage counts
//   window.loadAllDailyData()         — weekly history for timesPerWeek checks
//   window.activityProperties         — activity durations + capacity
//
// =============================================================================

(function () {
    'use strict';

    var VERSION = '1.0.0';
    var DEBUG = true;

    function log() {
        if (DEBUG) console.log.apply(console, ['[BunkEngine]'].concat(Array.prototype.slice.call(arguments)));
    }
    function warn() {
        console.warn.apply(console, ['[BunkEngine]'].concat(Array.prototype.slice.call(arguments)));
    }

    // =========================================================================
    // TIME UTILITIES
    // =========================================================================

    function parseTime(str) {
        if (typeof str === 'number') return str;
        if (!str || typeof str !== 'string') return null;
        var s = str.trim().toLowerCase();
        var mer = null;
        if (s.slice(-2) === 'am' || s.slice(-2) === 'pm') {
            mer = s.slice(-2);
            s = s.slice(0, -2).trim();
        }
        var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
        if (isNaN(hh) || isNaN(mm)) return null;
        if (mer === 'am' && hh === 12) hh = 0;
        else if (mer === 'pm' && hh !== 12) hh += 12;
        return hh * 60 + mm;
    }

    function fmtTime(min) {
        if (min == null) return '?';
        var h = Math.floor(min / 60), m = min % 60;
        var ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + (m < 10 ? '0' : '') + m + ap;
    }

    function overlaps(s1, e1, s2, e2) {
        return s1 < e2 && e1 > s2;
    }

    function getDayName(dateStr) {
        if (!dateStr) return '';
        var parts = dateStr.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2]);
        return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
    }

    // Returns remaining scheduled days this week INCLUDING today
    function getRemainingWeekdays(dateStr) {
        if (!dateStr) return 1;
        var parts = dateStr.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2]);
        var dow = d.getDay(); // 0=Sun
        // Camp typically runs Sun-Fri or Mon-Sat. Count days to end of week (Fri)
        // Simple: remaining = Math.max(1, 6 - dow) for Mon-Sat week
        var remaining = 6 - dow; // days until Saturday
        return Math.max(1, remaining);
    }

    function getMondayOfWeek(dateStr) {
        var parts = dateStr.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2]);
        var dow = d.getDay();
        var diff = dow === 0 ? -6 : 1 - dow;
        d.setDate(d.getDate() + diff);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    // =========================================================================
    // DATA ACCESS HELPERS
    // =========================================================================

    function getGlobalSettings() {
        return window.loadGlobalSettings?.() || {};
    }

    function getSpecialActivities() {
        var g = getGlobalSettings();
        return g.app1?.specialActivities || g.specialActivities || [];
    }

    function getFields() {
        var g = getGlobalSettings();
        return g.app1?.fields || g.fields || [];
    }

    function getDivisions() {
        return window.divisions || getGlobalSettings().app1?.divisions || {};
    }

    function getBunksForDivision(divName) {
        return getDivisions()[divName]?.bunks || [];
    }

    function getDivisionForBunk(bunkName) {
        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            return window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
        }
        var divs = getDivisions();
        for (var dn in divs) {
            if ((divs[dn].bunks || []).includes(bunkName)) return dn;
        }
        return null;
    }

    function getDivisionTimeRange(divName) {
        var div = getDivisions()[divName];
        if (!div) return { start: 540, end: 900 };
        return {
            start: parseTime(div.startTime) || 540,
            end: parseTime(div.endTime) || 900
        };
    }

    function getSpecialConfig(name) {
        return getSpecialActivities().find(function (s) {
            return s.name?.toLowerCase().trim() === name?.toLowerCase().trim();
        }) || null;
    }

    function getActivityDuration(activityName) {
        // Source 1: activityProperties (most reliable, built by scheduler_core_loader)
        var props = window.activityProperties?.[activityName];
        if (props) {
            var dur = props.defaultDuration || props.duration || props.durationMin || props.periodMin;
            if (dur && dur > 0) return dur;
        }
        // Source 2: special activities config
        var special = getSpecialConfig(activityName);
        if (special) {
            var sdur = special.duration || special.defaultDuration || special.durationMin;
            if (sdur && sdur > 0) return sdur;
        }
        // Source 3: fields config
        var fields = getFields();
        for (var i = 0; i < fields.length; i++) {
            if ((fields[i].activities || []).includes(activityName)) {
                var fdur = fields[i].duration || fields[i].defaultDuration;
                if (fdur && fdur > 0) return fdur;
            }
        }
        return null; // unknown — never use a fallback silently
    }

    function getActivityCapacity(activityName) {
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(activityName, window.activityProperties) || 1;
        }
        var props = window.activityProperties?.[activityName];
        if (props?.sharableWith?.capacity) return parseInt(props.sharableWith.capacity) || 1;
        if (props?.sharableWith?.type === 'all') return 999;
        return 1;
    }

    // Get all valid activity names for a given type ('sports', 'special', 'activity')
    function getActivitiesForType(type, divName) {
        var results = [];
        if (type === 'sports' || type === 'activity') {
            var fields = getFields();
            fields.forEach(function (f) {
                if (f.available !== false && !f.disabled) {
                    (f.activities || []).forEach(function (act) {
                        if (!results.includes(act)) results.push(act);
                    });
                }
            });
        }
        if (type === 'special' || type === 'activity') {
            getSpecialActivities().forEach(function (s) {
                if (s.available !== false && !results.includes(s.name)) {
                    results.push(s.name);
                }
            });
        }
        return results;
    }

    function getLayerDuration(layer) { return layer.durationMin || layer.duration || layer.periodMin || 30; }
    function getLayerDurationMax(layer) { return layer.durationMax || layer.duration || layer.durationMin || layer.periodMin || getLayerDuration(layer); }
    function isLayerPinned(layer) {
        var windowSize = (layer.endMin || 0) - (layer.startMin || 0);
        var maxDur = getLayerDurationMax(layer);
        if (windowSize > 0 && maxDur > 0 && windowSize <= maxDur) return true;
        if (layer.pinned || layer.pinExact) return true;
        return false;
    }

    // =========================================================================
    // PHASE 0 — RULE COMPILATION
    // =========================================================================
    //
    // Reads daAutoLayers (keyed by grade/division) and normalises each layer
    // into one of three typed rule objects:
    //
    //   AnchorRule     — pinExact=true  → locked slot at exact time
    //   WindowedRule   — pinExact=false → must happen within window
    //   FrequencyRule  — timesPerWeek   → quota checked against history
    //
    // All durations are validated here. Layers with unknown durations are
    // flagged and skipped — they never silently size a block at a wrong value.
    // =========================================================================

    function compileRules(layers, dateStr, warnings) {
        var anchors = [];
        var windowed = [];
        var frequency = [];
        var dayName = getDayName(dateStr);

        // Layer type → rule category
        // Anchors: pinExact=true, or type is dismissal (always fixed)
        // Windowed: pinExact=false + has a time window
        // Frequency: contributes a frequency rule based on timesPerWeek

        layers.forEach(function (layer) {
            if (!layer || !layer.type) return;

            var windowSize = (layer.endMin != null && layer.startMin != null) ? layer.endMin - layer.startMin : 0;
            var isAnchor = isLayerPinned(layer);
            var duration = layer.periodMin || layer.durationMin || (windowSize > 0 ? windowSize : null) || getLayerDurationMax(layer);

            if (!duration || duration <= 0) {
                warn('Layer "' + (layer.event || layer.type) + '" has no duration — skipped');
                warnings.push('Layer "' + (layer.event || layer.type) + '" skipped: no duration set');
                return;
            }

            var base = {
                id: layer.id || ('rule_' + Math.random().toString(36).slice(2, 7)),
                layerType: layer.type,
                event: layer.event || layer.type,
                duration: duration,
                grade: layer.grade || null,
                originalLayer: layer
            };

            if (isAnchor) {
                // Hard anchor — must appear at exactly this time
                if (layer.startMin == null) {
                    warn('Anchor "' + base.event + '" has no startMin — skipped');
                    warnings.push('Anchor "' + base.event + '" skipped: no start time');
                    return;
                }
                anchors.push(Object.assign({}, base, {
                    ruleType: 'anchor',
                    startMin: layer.startMin,
                    endMin: layer.startMin + duration,
                    priority: 0  // highest — placed first, never moved
                }));

            } else {
                // Windowed — must happen somewhere in the window
                if (layer.startMin == null || layer.endMin == null) {
                    warn('Windowed layer "' + base.event + '" has no time window — treated as free-float');
                    // Free-float: can go anywhere in the day, treated as frequency
                } else if (layer.endMin - layer.startMin < duration) {
                    warn('Window for "' + base.event + '" (' + (layer.endMin - layer.startMin) + 'min) is smaller than duration (' + duration + 'min)');
                    warnings.push('"' + base.event + '": window smaller than duration — will try to fit');
                }

                var quantity = parseInt(layer.quantity) || 1;
                var operator = layer.operator || '≥';

                windowed.push(Object.assign({}, base, {
                    ruleType: 'windowed',
                    windowStart: layer.startMin,
                    windowEnd: layer.endMin,
                    quantity: quantity,
                    operator: operator,
                    priority: 1
                }));

                // Also register a frequency rule if timesPerWeek is set
                if (layer.timesPerWeek != null && layer.timesPerWeek > 0) {
                    frequency.push(Object.assign({}, base, {
                        ruleType: 'frequency',
                        timesPerWeek: layer.timesPerWeek,
                        weeklyOp: layer.weeklyOp || '≥',
                        windowStart: layer.startMin,
                        windowEnd: layer.endMin,
                        quantity: quantity,
                        operator: operator,
                        priority: 2
                    }));
                }
            }
        });

        log('Compiled rules: ' + anchors.length + ' anchors, ' + windowed.length + ' windowed, ' + frequency.length + ' frequency');
        return { anchors: anchors, windowed: windowed, frequency: frequency };
    }

    // =========================================================================
    // RESOURCE TRACKER
    // =========================================================================
    // Time-range based. No slot indices. Checks real overlaps.

    function createResourceTracker() {
        // _usage: { resourceName: [ { startMin, endMin, bunkName, divName, activity } ] }
        var _usage = {};

        return {
            // Register a bunk's use of a resource for a time window
            register: function (resourceName, startMin, endMin, bunkName, divName, activity) {
                if (!resourceName || startMin == null || endMin == null) return;
                var key = resourceName.toLowerCase().trim();
                if (!_usage[key]) _usage[key] = [];
                _usage[key].push({
                    startMin: startMin,
                    endMin: endMin,
                    bunkName: bunkName,
                    divName: divName,
                    activity: activity || resourceName
                });
            },

            // Check if a resource is available for a time window for a given bunk
            isAvailable: function (resourceName, startMin, endMin, capacity, excludeBunk) {
                var key = resourceName.toLowerCase().trim();
                var usages = _usage[key] || [];
                var concurrent = usages.filter(function (u) {
                    if (excludeBunk && u.bunkName === excludeBunk) return false;
                    return overlaps(u.startMin, u.endMin, startMin, endMin);
                });
                return concurrent.length < (capacity || 1);
            },

            // Count how many bunks are using a resource during a window
            countUsage: function (resourceName, startMin, endMin, excludeBunk) {
                var key = resourceName.toLowerCase().trim();
                var usages = _usage[key] || [];
                return usages.filter(function (u) {
                    if (excludeBunk && u.bunkName === excludeBunk) return false;
                    return overlaps(u.startMin, u.endMin, startMin, endMin);
                }).length;
            },

            // Get all bunks using a resource in a window
            getUsers: function (resourceName, startMin, endMin) {
                var key = resourceName.toLowerCase().trim();
                return (_usage[key] || []).filter(function (u) {
                    return overlaps(u.startMin, u.endMin, startMin, endMin);
                });
            },

            // Remove a bunk's registration (used during conflict resolution)
            unregister: function (resourceName, bunkName, startMin, endMin) {
                var key = resourceName.toLowerCase().trim();
                if (!_usage[key]) return;
                _usage[key] = _usage[key].filter(function (u) {
                    if (u.bunkName !== bunkName) return true;
                    return !overlaps(u.startMin, u.endMin, startMin, endMin);
                });
            },

            // Dump for diagnostics
            dump: function () { return JSON.parse(JSON.stringify(_usage)); }
        };
    }

    // =========================================================================
    // BUNK TIMELINE
    // =========================================================================
    // The central data structure. Each bunk gets one of these.

    function createBunkTimeline(bunkName, divName, dayStart, dayEnd) {
        return {
            bunkName: bunkName,
            divisionName: divName,
            dayStart: dayStart,
            dayEnd: dayEnd,
            slots: [],     // placed activities, sorted by startMin
            _gaps: null    // cached, invalidated on every slot change
        };
    }

    // Add a slot to a timeline. Keeps slots sorted by startMin.
    function addSlot(timeline, slot) {
        timeline.slots.push(slot);
        timeline.slots.sort(function (a, b) { return a.startMin - b.startMin; });
        timeline._gaps = null; // invalidate gap cache
    }

    // Get free gaps in a timeline — windows with no slot placed yet
    function getGaps(timeline) {
        if (timeline._gaps) return timeline._gaps;

        var gaps = [];
        var cursor = timeline.dayStart;
        var slots = timeline.slots.filter(function (s) { return !s._placeholder; });

        slots.forEach(function (slot) {
            if (slot.startMin > cursor + 1) {
                gaps.push({ startMin: cursor, endMin: slot.startMin, durationMin: slot.startMin - cursor });
            }
            cursor = Math.max(cursor, slot.endMin);
        });

        if (cursor < timeline.dayEnd) {
            gaps.push({ startMin: cursor, endMin: timeline.dayEnd, durationMin: timeline.dayEnd - cursor });
        }

        timeline._gaps = gaps;
        return gaps;
    }

    // Find gaps that can fit a given duration, optionally within a time window
    function findFittingGaps(timeline, durationMin, windowStart, windowEnd) {
        return getGaps(timeline).filter(function (gap) {
            var effectiveStart = windowStart != null ? Math.max(gap.startMin, windowStart) : gap.startMin;
            var effectiveEnd = windowEnd != null ? Math.min(gap.endMin, windowEnd) : gap.endMin;
            return (effectiveEnd - effectiveStart) >= durationMin;
        }).map(function (gap) {
            return {
                startMin: windowStart != null ? Math.max(gap.startMin, windowStart) : gap.startMin,
                endMin: windowEnd != null ? Math.min(gap.endMin, windowEnd) : gap.endMin,
                gapStartMin: gap.startMin,
                gapEndMin: gap.endMin
            };
        });
    }

    // =========================================================================
    // PHASE 1 — HARD ANCHOR PLACEMENT
    // =========================================================================

    function placeAnchors(timelines, anchorRules, resourceTracker) {
        log('Phase 1: placing ' + anchorRules.length + ' anchors across ' + timelines.length + ' bunks');

        anchorRules.forEach(function (rule) {
            timelines.forEach(function (timeline) {
                // Only apply if grade matches (or rule has no grade restriction)
                if (rule.grade && rule.grade !== timeline.divisionName) return;

                addSlot(timeline, {
                    startMin: rule.startMin,
                    endMin: rule.endMin,
                    activity: rule.event,
                    activityType: rule.layerType,
                    field: null,
                    locked: true,
                    source: 'anchor',
                    _ruleId: rule.id
                });

                // Register resource use if the anchor has a known resource
                if (rule.field) {
                    resourceTracker.register(rule.field, rule.startMin, rule.endMin,
                        timeline.bunkName, timeline.divisionName, rule.event);
                }
            });
        });
    }

    // =========================================================================
    // PHASE 2 — SCARCE RESOURCE PRE-ALLOCATION
    // =========================================================================
    //
    // Scarce = day-restricted specials (availableDays set) or mustScheduleWhenAvailable.
    // These are allocated BEFORE anything else so their limited slots aren't wasted.
    // Fairness: bunks that haven't done this activity in the longest time go first.

    function allocateScarceResources(timelines, dateStr, dayName, resourceTracker, warnings) {
        log('Phase 2: scarce resource allocation for ' + dayName);

        var specials = getSpecialActivities();

        // Find scarce activities available today
        var scarceToday = specials.filter(function (s) {
            if (!s.available) return false;
            // Day-restricted
            if (Array.isArray(s.availableDays) && s.availableDays.length > 0) {
                var available = s.availableDays.some(function (d) {
                    return d.toLowerCase() === dayName.toLowerCase();
                });
                if (!available) return false;
                return true; // available today AND day-restricted = scarce
            }
            // mustScheduleWhenAvailable flag
            if (s.mustScheduleWhenAvailable === true) return true;
            return false;
        });

        if (scarceToday.length === 0) {
            log('Phase 2: no scarce activities today');
            return;
        }

        log('Phase 2: ' + scarceToday.length + ' scarce activities: ' + scarceToday.map(function (s) { return s.name; }).join(', '));

        scarceToday.forEach(function (special) {
            var duration = getActivityDuration(special.name);
            if (!duration) {
                warn('Scarce activity "' + special.name + '" has unknown duration — skipped');
                warnings.push('"' + special.name + '" skipped in Phase 2: no duration');
                return;
            }

            var capacity = getActivityCapacity(special.name);

            // Time window for this special
            var windowStart = null, windowEnd = null;
            if (Array.isArray(special.timeRules) && special.timeRules.length > 0) {
                var available = special.timeRules.find(function (r) { return r.type === 'Available'; });
                if (available) {
                    windowStart = available.startMin || parseTime(available.start);
                    windowEnd = available.endMin || parseTime(available.end);
                }
            }

            // Filter timelines to those in divisions this special is available for
            var eligibleTimelines = timelines.filter(function (tl) {
                // Check division access
                if (Array.isArray(special.divisions) && special.divisions.length > 0) {
                    return special.divisions.includes(tl.divisionName);
                }
                return true;
            });

            if (eligibleTimelines.length === 0) return;

            // Rank by fairness: longest time since last did this activity = highest priority
            var ranked = eligibleTimelines.map(function (tl) {
                var history = window.RotationEngine?.getBunkHistory?.(tl.bunkName) || {};
                var daysSince = window.RotationEngine?.getDaysSinceActivity?.(tl.bunkName, special.name) || null;
                var count = window.SchedulerCoreUtils?.getActivityCount?.(tl.bunkName, special.name) || 0;
                return {
                    timeline: tl,
                    daysSince: daysSince === null ? 9999 : daysSince,
                    count: count
                };
            }).sort(function (a, b) {
                // Longer since = higher priority (b - a would invert)
                if (b.daysSince !== a.daysSince) return b.daysSince - a.daysSince;
                return a.count - b.count; // fewer times total = higher priority
            });

            // Determine max slots available today
            // capacity = max concurrent bunks; we find how many non-overlapping windows fit
            var slotsAllocated = 0;
            var dayStart = 540, dayEnd = 900; // defaults if we can't find division times

            ranked.forEach(function (item) {
                // Check if this special already has enough capacity used
                var fittingGaps = findFittingGaps(item.timeline, duration, windowStart, windowEnd);
                if (fittingGaps.length === 0) return;

                var gap = chooseBestGap(fittingGaps, duration, item.timeline, special.name);
                if (!gap) return;

                var slotStart = gap.startMin;
                var slotEnd = slotStart + duration;

                // Check resource availability at this time
                if (!resourceTracker.isAvailable(special.name, slotStart, slotEnd, capacity, item.timeline.bunkName)) {
                    // Try next gap
                    for (var gi = 0; gi < fittingGaps.length; gi++) {
                        var altStart = fittingGaps[gi].startMin;
                        var altEnd = altStart + duration;
                        if (resourceTracker.isAvailable(special.name, altStart, altEnd, capacity, item.timeline.bunkName)) {
                            slotStart = altStart;
                            slotEnd = altEnd;
                            break;
                        }
                    }
                    if (!resourceTracker.isAvailable(special.name, slotStart, slotEnd, capacity, item.timeline.bunkName)) {
                        return; // no available window
                    }
                }

                // Place the slot
                addSlot(item.timeline, {
                    startMin: slotStart,
                    endMin: slotEnd,
                    activity: special.name,
                    activityType: 'special',
                    field: special.location || null,
                    locked: true,  // scarce allocations are locked
                    source: 'scarce',
                    _ruleId: 'scarce_' + special.name
                });

                resourceTracker.register(special.name, slotStart, slotEnd,
                    item.timeline.bunkName, item.timeline.divisionName, special.name);

                slotsAllocated++;
                log('  Phase 2: allocated "' + special.name + '" to ' + item.timeline.bunkName +
                    ' at ' + fmtTime(slotStart) + '–' + fmtTime(slotEnd));
            });

            log('Phase 2: "' + special.name + '" → ' + slotsAllocated + ' bunks allocated');
        });
    }

    // =========================================================================
    // PHASE 3 — PER-BUNK REQUIREMENT SCORING
    // =========================================================================
    //
    // For each bunk, determine what it still needs to do today, in priority order.
    // Returns an array of requirement objects sorted by urgency.

    function computeBunkRequirements(timeline, rules, dateStr) {
        var requirements = [];
        var bunkName = timeline.bunkName;
        var today = dateStr;
        var daysLeftInWeek = getRemainingWeekdays(today);

        // What has this bunk already been allocated today (from anchors + scarce)
        var alreadyToday = new Set();
        timeline.slots.forEach(function (s) {
            if (s.activity) alreadyToday.add(s.activity.toLowerCase());
            if (s.activityType) alreadyToday.add(s.activityType.toLowerCase());
        });

        // Count how many of each layer type have been placed today
        var typeCountToday = {};
        timeline.slots.forEach(function (s) {
            var t = s.activityType || 'unknown';
            typeCountToday[t] = (typeCountToday[t] || 0) + 1;
        });

        // Process windowed rules — these represent daily requirements
        rules.windowed.forEach(function (rule) {
            if (rule.grade && rule.grade !== timeline.divisionName) return;

            var alreadyPlaced = typeCountToday[rule.layerType] || 0;
            var needed = 0;

            if (rule.operator === '≥' || rule.operator === '>=') {
                needed = Math.max(0, rule.quantity - alreadyPlaced);
            } else if (rule.operator === '=' || rule.operator === '==') {
                needed = Math.max(0, rule.quantity - alreadyPlaced);
            } else if (rule.operator === '≤' || rule.operator === '<=') {
                // Upper bound — still need at least 1 if none placed
                needed = alreadyPlaced === 0 ? 1 : 0;
            }

            if (needed <= 0) return;

            requirements.push({
                rule: rule,
                urgency: 'daily',
                remaining: needed,
                priority: 10
            });
        });

        // Process frequency rules — weekly quotas
        rules.frequency.forEach(function (rule) {
            if (rule.grade && rule.grade !== timeline.divisionName) return;

            var doneThisWeek = countWeeklyOccurrences(bunkName, rule.layerType, today);
            var needed = 0;

            if (rule.weeklyOp === '≥' || rule.weeklyOp === '>=') {
                needed = Math.max(0, rule.timesPerWeek - doneThisWeek);
            } else if (rule.weeklyOp === '=' || rule.weeklyOp === '==') {
                needed = Math.max(0, rule.timesPerWeek - doneThisWeek);
            }

            if (needed <= 0) return;

            // How urgent is this?
            var urgency, priority;
            if (needed >= daysLeftInWeek) {
                urgency = 'weekly_critical';  // must do today or quota won't be met
                priority = 20;
            } else {
                urgency = 'weekly_preferred'; // should do today, but not critical
                priority = 30;
            }

            requirements.push({
                rule: rule,
                urgency: urgency,
                remaining: Math.min(needed, daysLeftInWeek),
                priority: priority
            });
        });

        // Sort: daily > weekly_critical > weekly_preferred, then by rule priority
        requirements.sort(function (a, b) {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return (a.rule.priority || 99) - (b.rule.priority || 99);
        });

        return requirements;
    }

    // Count how many times a bunk has done activities of a given type this week
    function countWeeklyOccurrences(bunkName, layerType, dateStr) {
        var weekStart = getMondayOfWeek(dateStr);
        var allDaily = window.loadAllDailyData?.() || {};
        var count = 0;

        Object.keys(allDaily).forEach(function (dk) {
            if (dk < weekStart || dk >= dateStr) return; // only past days this week
            var sched = allDaily[dk]?.scheduleAssignments?.[bunkName];
            if (!Array.isArray(sched)) return;

            sched.forEach(function (entry) {
                if (!entry || entry.continuation || entry._isTransition) return;
                var act = entry._activity || '';
                if (!act) return;

                // Match by layer type
                var actLower = act.toLowerCase();
                var matchesType = false;
                if (layerType === 'sports' || layerType === 'sport') {
                    var fields = getFields();
                    matchesType = fields.some(function (f) {
                        return (f.activities || []).some(function (a) {
                            return a.toLowerCase() === actLower;
                        });
                    });
                } else if (layerType === 'special') {
                    matchesType = getSpecialActivities().some(function (s) {
                        return s.name.toLowerCase() === actLower;
                    });
                } else if (layerType === 'swim') {
                    matchesType = actLower === 'swim' || actLower.includes('swim');
                } else if (layerType === 'lunch') {
                    matchesType = actLower === 'lunch';
                }

                if (matchesType) count++;
            });
        });

        return count;
    }

    // =========================================================================
    // PHASE 4 — BUNK TIMELINE CONSTRUCTION
    // =========================================================================
    //
    // For each bunk, work through its requirement list and place activities
    // into the best available gaps. This builds each bunk's complete day.

    function constructBunkTimeline(timeline, requirements, rules, resourceTracker, warnings) {
        var bunkName = timeline.bunkName;

        requirements.forEach(function (req) {
            var rule = req.rule;
            var remaining = req.remaining;

            for (var i = 0; i < remaining; i++) {
                var placed = placeRuleInTimeline(timeline, rule, resourceTracker, warnings);
                if (!placed) {
                    if (req.urgency === 'daily') {
                        warnings.push(bunkName + ': could not satisfy daily requirement "' + rule.event + '"');
                    }
                    break;
                }
            }
        });
    }

    function placeRuleInTimeline(timeline, rule, resourceTracker, warnings) {
        var duration = rule.duration;
        var fittingGaps = findFittingGaps(timeline, duration, rule.windowStart, rule.windowEnd);

        if (fittingGaps.length === 0) {
            // Try without window constraint as fallback
            fittingGaps = findFittingGaps(timeline, duration, null, null);
            if (fittingGaps.length === 0) {
                warn('No gap for rule "' + rule.event + '" in ' + timeline.bunkName);
                return false;
            }
        }

        // Score each gap and pick the best one
        var gap = chooseBestGap(fittingGaps, duration, timeline, rule.event);
        if (!gap) return false;

        var slotStart = gap.startMin;
        var slotEnd = slotStart + duration;

        // Place a type-placeholder — the specific activity gets assigned in Phase 6
        addSlot(timeline, {
            startMin: slotStart,
            endMin: slotEnd,
            activity: null,           // filled in Phase 6
            activityType: rule.layerType,
            field: null,              // filled in Phase 6
            locked: false,
            source: 'required',
            _ruleId: rule.id,
            _windowStart: rule.windowStart,
            _windowEnd: rule.windowEnd
        });

        return true;
    }

    // Score a gap for placing an activity — prefers natural day flow
    function chooseBestGap(fittingGaps, duration, timeline, activityHint) {
        if (fittingGaps.length === 0) return null;
        if (fittingGaps.length === 1) return fittingGaps[0];

        var dayMid = (timeline.dayStart + timeline.dayEnd) / 2;
        var isLunch = activityHint && activityHint.toLowerCase().includes('lunch');
        var isPhysical = activityHint && (
            activityHint.toLowerCase().includes('swim') ||
            activityHint.toLowerCase().includes('sport') ||
            activityHint.toLowerCase() === 'sports'
        );

        var scored = fittingGaps.map(function (gap) {
            var score = 0;

            // Penalize tiny leftover fragments after placement
            var remainder = (gap.endMin - gap.startMin) - duration;
            if (remainder > 0 && remainder < 10) score -= 50;

            // Lunch should land near the middle of the day
            if (isLunch) {
                score -= Math.abs(gap.startMin - dayMid) * 0.3;
            }

            // Physical activities preferred in the morning
            if (isPhysical && gap.startMin < dayMid) score += 15;

            // Prefer not splitting large gaps unnecessarily
            var gapSize = gap.endMin - gap.startMin;
            if (gapSize > duration * 2) score += 5;

            return { gap: gap, score: score };
        });

        scored.sort(function (a, b) { return b.score - a.score; });
        return scored[0].gap;
    }

    // =========================================================================
    // PHASE 5 — CROSS-BUNK RESOURCE CONFLICT RESOLUTION
    // =========================================================================
    //
    // After Phase 4, every bunk has a full timeline of typed placeholders.
    // Phase 6 assigns specific activities + fields. Before that, we need to
    // ensure no two bunks have claimed the same limited resource simultaneously.
    //
    // For typed placeholders (sports, special), conflicts are resolved during
    // Phase 6 by the resource tracker. This phase focuses on slots that already
    // have a specific resource assigned (from Phase 1/2).

    function resolveResourceConflicts(timelines, resourceTracker, warnings) {
        log('Phase 5: checking resource conflicts');
        var conflictsFound = 0;

        timelines.forEach(function (timeline) {
            timeline.slots.forEach(function (slot) {
                if (!slot.field || !slot.locked) return; // only locked slots with resources

                var capacity = getActivityCapacity(slot.field);
                var users = resourceTracker.getUsers(slot.field, slot.startMin, slot.endMin);
                var otherUsers = users.filter(function (u) { return u.bunkName !== timeline.bunkName; });

                if (otherUsers.length >= capacity) {
                    // This slot is over capacity. If it's a scarce allocation (locked),
                    // we can't move it — log a warning
                    if (slot.locked) {
                        warnings.push(timeline.bunkName + ': ' + slot.field + ' at ' +
                            fmtTime(slot.startMin) + ' is over capacity (' +
                            (otherUsers.length + 1) + '/' + capacity + ')');
                        conflictsFound++;
                    }
                }
            });
        });

        if (conflictsFound > 0) {
            warn('Phase 5: ' + conflictsFound + ' capacity conflicts found');
        } else {
            log('Phase 5: no conflicts');
        }
    }

    // =========================================================================
    // PHASE 6 — GAP FILL + SPECIFIC ACTIVITY ASSIGNMENT
    // =========================================================================
    //
    // Two jobs:
    //   A. Assign specific activities to placeholder slots (from Phase 4)
    //   B. Fill remaining gaps with rotation-fair activities
    //
    // Uses RotationEngine.calculateRotationScore for fairness.

    function fillGapsAndAssignActivities(timeline, resourceTracker, warnings) {
        var bunkName = timeline.bunkName;
        var divName = timeline.divisionName;

        // Job A: assign specific activities to type-placeholders
        timeline.slots.forEach(function (slot) {
            if (slot.activity) return; // already assigned (anchors, scarce)

            var candidate = pickActivityForSlot(slot, timeline, resourceTracker);
            if (candidate) {
                slot.activity = candidate.activity;
                slot.field = candidate.field;
                if (candidate.field) {
                    resourceTracker.register(candidate.field, slot.startMin, slot.endMin,
                        bunkName, divName, candidate.activity);
                }
            } else {
                slot.activity = slot.activityType || 'Free';
                warn('No candidate found for ' + bunkName + ' ' + slot.activityType +
                    ' at ' + fmtTime(slot.startMin));
            }
        });

        // Job B: fill remaining gaps
        var gaps = getGaps(timeline);
        gaps.forEach(function (gap) {
            if (gap.durationMin < 10) return; // too small to fill

            var candidate = pickActivityForGap(gap, timeline, resourceTracker);
            if (candidate) {
                addSlot(timeline, {
                    startMin: gap.startMin,
                    endMin: gap.startMin + candidate.duration,
                    activity: candidate.activity,
                    activityType: candidate.type,
                    field: candidate.field,
                    locked: false,
                    source: 'fill'
                });

                if (candidate.field) {
                    resourceTracker.register(candidate.field, gap.startMin, gap.startMin + candidate.duration,
                        bunkName, divName, candidate.activity);
                }
            }
        });
    }

    function pickActivityForSlot(slot, timeline, resourceTracker) {
        var type = slot.activityType;
        var duration = slot.endMin - slot.startMin;
        var bunkName = timeline.bunkName;
        var divName = timeline.divisionName;

        var candidates = buildCandidatesForType(type, duration, slot.startMin, slot.endMin,
            bunkName, divName, resourceTracker);

        if (candidates.length === 0) return null;

        // Sort by rotation score (lower = more deserved)
        candidates.sort(function (a, b) { return a.rotationScore - b.rotationScore; });
        return candidates[0];
    }

    function pickActivityForGap(gap, timeline, resourceTracker) {
        var bunkName = timeline.bunkName;
        var divName = timeline.divisionName;
        var duration = gap.durationMin;

        // Try sports first, then specials
        var types = ['sports', 'special'];
        for (var ti = 0; ti < types.length; ti++) {
            var candidates = buildCandidatesForType(types[ti], duration, gap.startMin, gap.endMin,
                bunkName, divName, resourceTracker);
            if (candidates.length > 0) {
                candidates.sort(function (a, b) { return a.rotationScore - b.rotationScore; });
                var best = candidates[0];
                return { activity: best.activity, field: best.field, type: types[ti], duration: duration };
            }
        }
        return null;
    }

    function buildCandidatesForType(type, duration, startMin, endMin, bunkName, divName, resourceTracker) {
        var candidates = [];
        var fields = getFields();
        var actProps = window.activityProperties || {};

        if (type === 'sports' || type === 'sport') {
            fields.forEach(function (field) {
                if (field.available === false || field.disabled) return;

                var capacity = getActivityCapacity(field.name);
                if (!resourceTracker.isAvailable(field.name, startMin, endMin, capacity, bunkName)) return;

                // Check time rules for the field
                if (!isTimeAvailableForActivity(field.name, startMin, endMin)) return;

                (field.activities || []).forEach(function (act) {
                    var actDur = getActivityDuration(act);
                    if (actDur && Math.abs(actDur - duration) > 15) return; // duration mismatch

                    var score = calcRotationScore(bunkName, act);
                    if (score === Infinity) return; // blocked

                    candidates.push({
                        activity: act,
                        field: field.name,
                        rotationScore: score,
                        duration: duration
                    });
                });
            });

        } else if (type === 'special') {
            getSpecialActivities().forEach(function (special) {
                if (special.available === false) return;

                // Check day restrictions
                if (Array.isArray(special.availableDays) && special.availableDays.length > 0) {
                    // Scarce — should have been handled in Phase 2
                    return;
                }

                // Check duration
                var sdur = getActivityDuration(special.name);
                if (!sdur) return;
                if (Math.abs(sdur - duration) > 15) return;

                // Check capacity
                var capacity = getActivityCapacity(special.name);
                if (!resourceTracker.isAvailable(special.name, startMin, endMin, capacity, bunkName)) return;

                // Check division access
                if (Array.isArray(special.divisions) && special.divisions.length > 0) {
                    if (!special.divisions.includes(divName)) return;
                }

                if (!isTimeAvailableForActivity(special.name, startMin, endMin)) return;

                var score = calcRotationScore(bunkName, special.name);
                if (score === Infinity) return;

                candidates.push({
                    activity: special.name,
                    field: special.location || special.name,
                    rotationScore: score,
                    duration: sdur
                });
            });
        }

        return candidates;
    }

    function calcRotationScore(bunkName, activityName) {
        if (window.RotationEngine?.calculateRotationScore) {
            return window.RotationEngine.calculateRotationScore({
                bunkName: bunkName,
                activityName: activityName,
                divisionName: getDivisionForBunk(bunkName),
                beforeSlotIndex: 0,
                allActivities: null,
                activityProperties: window.activityProperties || {}
            });
        }
        // Fallback: days since last
        var daysSince = window.RotationEngine?.getDaysSinceActivity?.(bunkName, activityName);
        return daysSince === null ? 0 : -daysSince; // more days since = lower score = higher priority
    }

    function isTimeAvailableForActivity(activityName, startMin, endMin) {
        var special = getSpecialConfig(activityName);
        if (!special || !Array.isArray(special.timeRules) || special.timeRules.length === 0) return true;

        var hasAvailableRule = false;
        var blocked = false;

        special.timeRules.forEach(function (rule) {
            var rs = rule.startMin || parseTime(rule.start);
            var re = rule.endMin || parseTime(rule.end);
            if (rs == null || re == null) return;

            if (rule.type === 'Available') {
                if (startMin >= rs && endMin <= re) hasAvailableRule = true;
            } else if (rule.type === 'Unavailable') {
                if (overlaps(startMin, endMin, rs, re)) blocked = true;
            }
        });

        if (blocked) return false;
        if (hasAvailableRule) return true;
        return true; // no available rule = available everywhere
    }

    // =========================================================================
    // PHASE 7 — VALIDATION + OUTPUT
    // =========================================================================

    function validateAndBuildOutput(timelines, rules, warnings) {
        log('Phase 7: validation and output');
        var diagnostics = { violations: [], stats: {} };

        timelines.forEach(function (timeline) {
            var bunkName = timeline.bunkName;

            // Check for overlapping slots
            for (var i = 0; i < timeline.slots.length - 1; i++) {
                var a = timeline.slots[i], b = timeline.slots[i + 1];
                if (a.endMin > b.startMin) {
                    diagnostics.violations.push(bunkName + ': overlap between "' +
                        (a.activity || a.activityType) + '" and "' + (b.activity || b.activityType) +
                        '" at ' + fmtTime(a.startMin));
                }
            }

            // Stats
            diagnostics.stats[bunkName] = {
                totalSlots: timeline.slots.length,
                coveredMinutes: timeline.slots.reduce(function (acc, s) {
                    return acc + (s.endMin - s.startMin);
                }, 0),
                freeMinutes: getGaps(timeline).reduce(function (acc, g) {
                    return acc + g.durationMin;
                }, 0),
                sources: timeline.slots.reduce(function (acc, s) {
                    acc[s.source] = (acc[s.source] || 0) + 1;
                    return acc;
                }, {})
            };
        });

        // Build output bunkTimelines object — the canonical new format
        var bunkTimelines = {};
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
                        activity: s.activity || s.activityType || 'Free',
                        activityType: s.activityType,
                        field: s.field,
                        locked: s.locked || false,
                        source: s.source
                    };
                })
            };
        });

        return { bunkTimelines: bunkTimelines, diagnostics: diagnostics };
    }

    // =========================================================================
    // HISTORY UPDATE
    // =========================================================================
    // Called after generation. Updates rotation history from bunkTimelines
    // directly — not from slot arrays.

    function updateHistoryFromTimelines(bunkTimelines, dateStr) {
        log('Updating rotation history from bunkTimelines');

        try {
            var newHistory = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
            newHistory.bunks = newHistory.bunks || {};
            var timestamp = Date.now();

            Object.values(bunkTimelines).forEach(function (tl) {
                var bunkName = tl.bunkName;
                newHistory.bunks[bunkName] = newHistory.bunks[bunkName] || {};

                tl.slots.forEach(function (slot) {
                    var act = slot.activity;
                    if (!act) return;
                    var actLower = act.toLowerCase();
                    if (actLower === 'free' || actLower.includes('transition')) return;
                    newHistory.bunks[bunkName][act] = timestamp;
                });
            });

            window.saveRotationHistory?.(newHistory);

            // Rebuild historical counts — schedule this async to not block UI
            setTimeout(function () {
                if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                    window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
                }
            }, 300);

            log('History update complete');
        } catch (e) {
            console.error('[BunkEngine] History update failed:', e);
        }
    }

    // =========================================================================
    // MAIN BUILD FUNCTION
    // =========================================================================

    function build(config) {
        // config: { dateStr, layers (daAutoLayers format), divisions? }
        var t0 = performance.now();
        var dateStr = config.dateStr || new Date().toISOString().split('T')[0];
        var dayName = getDayName(dateStr);
        var warnings = [];

        log('═══ BUNK SCHEDULE ENGINE v' + VERSION + ' ═══');
        log('Date: ' + dateStr + ' (' + dayName + ')');

        // ── Load layers ──────────────────────────────────────────────────────
        // daAutoLayers is keyed by grade/division name
        var layerSource = config.layers || window.daAutoLayers || {};
        if (typeof layerSource !== 'object' || Object.keys(layerSource).length === 0) {
            warn('No layers provided — aborting');
            return { bunkTimelines: {}, warnings: ['No layers defined'], diagnostics: {} };
        }

        // ── Get divisions and bunks ──────────────────────────────────────────
        var divisions = config.divisions || getDivisions();
        var allBunks = [];
        Object.keys(divisions).forEach(function (divName) {
            var bunks = divisions[divName]?.bunks || [];
            bunks.forEach(function (b) {
                allBunks.push({ bunkName: b, divisionName: divName });
            });
        });

        if (allBunks.length === 0) {
            warn('No bunks found — aborting');
            return { bunkTimelines: {}, warnings: ['No bunks configured'], diagnostics: {} };
        }

        log(allBunks.length + ' bunks across ' + Object.keys(divisions).length + ' divisions');

        // ── Flatten layers: grade-keyed → flat array per bunk's division ────
        // Each bunk uses the layers for its own division/grade
        var layersByDiv = {};
        Object.keys(layerSource).forEach(function (grade) {
            var layers = layerSource[grade] || [];
            if (layers.length === 0) return;
            layersByDiv[grade] = layers;
        });

        // ── Phase 0: Compile rules per division ──────────────────────────────
        var rulesByDiv = {};
        Object.keys(layersByDiv).forEach(function (grade) {
            var gradedLayers = layersByDiv[grade].map(function(l) { return Object.assign({}, l, { grade: grade }); });
            rulesByDiv[grade] = compileRules(gradedLayers, dateStr, warnings);
        });

        // ── Create resource tracker (shared across all bunks) ─────────────
        var resourceTracker = createResourceTracker();

        // ── Create all bunk timelines ─────────────────────────────────────
        var timelines = allBunks.map(function (b) {
            var times = getDivisionTimeRange(b.divisionName);
            return createBunkTimeline(b.bunkName, b.divisionName, times.start, times.end);
        });

        // ── Phase 1: Hard anchor placement (applies to all bunks in div) ────
        var allAnchors = [];
        Object.keys(rulesByDiv).forEach(function (grade) {
            rulesByDiv[grade].anchors.forEach(function (a) {
                allAnchors.push(Object.assign({}, a, { grade: grade }));
            });
        });
        placeAnchors(timelines, allAnchors, resourceTracker);

        // ── Phase 2: Scarce resource pre-allocation ───────────────────────
        allocateScarceResources(timelines, dateStr, dayName, resourceTracker, warnings);

        // ── Phases 3 + 4: Per-bunk requirements + timeline construction ────
        timelines.forEach(function (timeline) {
            var divName = timeline.divisionName;
            // Find the rules for this bunk's division
            var rules = rulesByDiv[divName] || { anchors: [], windowed: [], frequency: [] };

            // Phase 3
            var requirements = computeBunkRequirements(timeline, rules, dateStr);

            // Phase 4
            constructBunkTimeline(timeline, requirements, rules, resourceTracker, warnings);
        });

        // ── Phase 5: Conflict resolution ──────────────────────────────────
        resolveResourceConflicts(timelines, resourceTracker, warnings);

        // ── Phase 6: Gap fill + specific activity assignment ──────────────
        timelines.forEach(function (timeline) {
            fillGapsAndAssignActivities(timeline, resourceTracker, warnings);
        });

        // ── Phase 7: Validate + build output ──────────────────────────────
        var output = validateAndBuildOutput(timelines, rulesByDiv, warnings);

        // ── Update rotation history ────────────────────────────────────────
        updateHistoryFromTimelines(output.bunkTimelines, dateStr);

        var elapsed = Math.round(performance.now() - t0);
        log('Build complete in ' + elapsed + 'ms. ' +
            Object.keys(output.bunkTimelines).length + ' bunks scheduled. ' +
            warnings.length + ' warnings.');

        if (warnings.length > 0) {
            log('Warnings:');
            warnings.forEach(function (w) { log('  ⚠ ' + w); });
        }

        return {
            bunkTimelines: output.bunkTimelines,
            warnings: warnings,
            diagnostics: output.diagnostics,
            _buildDate: dateStr,
            _buildVersion: VERSION,
            _elapsedMs: elapsed,
            _autoGenerated: true
        };
    }

    // =========================================================================
    // DIAGNOSTIC HELPERS
    // =========================================================================

    function explainBunkSchedule(bunkName) {
        // Quick diagnostic dump for a bunk's timeline
        var tl = window._lastBunkTimelines?.[bunkName];
        if (!tl) {
            console.log('[BunkEngine] No timeline found for ' + bunkName + '. Run build() first.');
            return;
        }
        console.log('\n═══ Schedule for ' + bunkName + ' (' + tl.divisionName + ') ═══');
        tl.slots.forEach(function (s) {
            var flag = s.locked ? '🔒' : s.source === 'scarce' ? '⭐' : s.source === 'required' ? '📋' : '○';
            console.log(flag + ' ' + fmtTime(s.startMin) + '–' + fmtTime(s.endMin) +
                ' | ' + (s.activity || '?') +
                (s.field ? ' @ ' + s.field : '') +
                ' [' + s.source + ']');
        });
        var gaps = getGaps(tl);
        if (gaps.length > 0) {
            console.log('Free gaps:');
            gaps.forEach(function (g) {
                console.log('  ' + fmtTime(g.startMin) + '–' + fmtTime(g.endMin) + ' (' + g.durationMin + 'min)');
            });
        }
        console.log('═══\n');
    }

    function previewScarceAllocation(dateStr) {
        var dayName = getDayName(dateStr || new Date().toISOString().split('T')[0]);
        var specials = getSpecialActivities().filter(function (s) {
            if (!s.available) return false;
            if (Array.isArray(s.availableDays) && s.availableDays.length > 0) {
                return s.availableDays.some(function (d) {
                    return d.toLowerCase() === dayName.toLowerCase();
                });
            }
            return s.mustScheduleWhenAvailable === true;
        });

        console.log('\n═══ Scarce Allocation Preview for ' + dayName + ' ═══');
        if (specials.length === 0) {
            console.log('No scarce activities today.');
            return;
        }
        specials.forEach(function (s) {
            var capacity = getActivityCapacity(s.name);
            var duration = getActivityDuration(s.name);
            console.log('\n' + s.name + ' (cap=' + capacity + ', dur=' + (duration || '?') + 'min)');
            console.log('Fairness ranking:');
            var allBunks = [];
            Object.values(getDivisions()).forEach(function (d) {
                (d.bunks || []).forEach(function (b) { allBunks.push(b); });
            });
            allBunks.map(function (b) {
                return {
                    bunk: b,
                    daysSince: window.RotationEngine?.getDaysSinceActivity?.(b, s.name) || null,
                    count: window.SchedulerCoreUtils?.getActivityCount?.(b, s.name) || 0
                };
            }).sort(function (a, b) {
                if (b.daysSince !== a.daysSince) return (b.daysSince || 9999) - (a.daysSince || 9999);
                return a.count - b.count;
            }).slice(0, 10).forEach(function (item, idx) {
                var marker = idx < capacity ? '✅' : '  ';
                console.log(marker + ' ' + (idx + 1) + '. ' + item.bunk +
                    ' (days since: ' + (item.daysSince || 'never') + ', count: ' + item.count + ')');
            });
        });
        console.log('═══\n');
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.BunkScheduleEngine = {
        build: function (config) {
            var result = build(config);
            // Cache timelines for diagnostics
            window._lastBunkTimelines = result.bunkTimelines;
            return result;
        },
        explainBunkSchedule: explainBunkSchedule,
        previewScarceAllocation: previewScarceAllocation,
        VERSION: VERSION
    };

    log('Bunk Schedule Engine v' + VERSION + ' loaded');

})();
