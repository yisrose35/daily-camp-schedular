// =================================================================
// ScarceActivityAllocator.js  (v1.0)
// =================================================================
// Runs at the start of each daily generation, BEFORE BunkTimelineSolver.
// Identifies scarce special activities available today, scores all
// eligible bunks by rotation need, fills ALL capacity slots, and
// creates wave schedules when bunks must rotate through the activity.
//
// Output: scarceBlocksMap — per-bunk list of pre-committed time blocks
// that BunkTimelineSolver treats as HARD anchors (priority 150).
//
// SCARCE DETECTION (all three conditions must hold):
//   1. availableDays is set (specific days only)
//   2. mustScheduleWhenAvailable === true
//   3. capacity > 0
//
// CRITICAL RULE: If capacity is N, ALL N simultaneous slots must be
// used. Only exception: fewer eligible bunks than capacity.
//
// WAVE SCHEDULING:
//   If totalBunksToServe > capacity, bunks rotate through the
//   activity's time window in sequential waves. Each wave occupies
//   one [duration]-length slot starting at waveStart. Waves are
//   packed as tightly as the time window allows.
//
// ARCHITECTURE CONTRACT:
//   - Reads from window.AutoBuildEngine for detection helpers
//   - Reads RotationEngine for bunk scoring
//   - Reads isSpecialAvailableForDivision for division filtering
//   - Output consumed by BunkTimelineSolver.buildForBunk()
//   - Does NOT modify total_solver_engine.js or rotation_engine.js
//   - Does NOT touch perBunkSlots (BunkTimelineSolver owns that)
//   - Non-allocated bunks recorded in deferredBunks for next run
//
// OUTPUT FORMAT (scarceBlocksMap):
//   { bunkName: [{ activityName, type, startMin, endMin,
//                  isScarce, capacity, wave, _suggestedActivity }] }
// =================================================================

(function () {
    'use strict';

    var VERSION = '1.0';

    // =================================================================
    // LOGGING
    // =================================================================
    var _logs = [];
    function log(msg)  { _logs.push(msg);       console.log('[ScarceAlloc] ' + msg); }
    function warn(msg) { _logs.push('⚠ ' + msg); console.warn('[ScarceAlloc] ' + msg); }
    function clearLogs() { _logs = []; }
    function getLogs()   { return _logs.slice(); }

    // =================================================================
    // TIME UTILITIES
    // =================================================================

    function parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (!str || typeof str !== 'string') return null;
        var s = str.trim().toLowerCase();
        var mer = null;
        if (s.endsWith('am') || s.endsWith('pm')) {
            mer = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
        if (isNaN(hh) || isNaN(mm) || mm < 0 || mm > 59) return null;
        if (mer) {
            if (hh === 12) hh = mer === 'am' ? 0 : 12;
            else if (mer === 'pm') hh += 12;
        }
        return hh * 60 + mm;
    }

    function minutesToLabel(min) {
        var h = Math.floor(min / 60), m = min % 60;
        var ap = h >= 12 ? 'PM' : 'AM';
        return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
    }

    function dayNameFromDateStr(dateStr) {
        var parts = dateStr.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2]);
        return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
    }

    // =================================================================
    // DELEGATE TO AutoBuildEngine (detection helpers)
    // =================================================================

    function getABE() {
        return window.AutoBuildEngine || null;
    }

    function getAllSpecials() {
        var abe = getABE();
        if (abe && abe.getSpecialActivities) return abe.getSpecialActivities();
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        return (g.app1 || {}).specialActivities || [];
    }

    function getSpecialCfg(name) {
        var abe = getABE();
        if (abe && abe.getSpecialConfig) return abe.getSpecialConfig(name);
        return getAllSpecials().find(function (s) {
            return s.name && s.name.toLowerCase() === (name || '').toLowerCase();
        }) || null;
    }

    function isAvailableOnDay(cfg, dayName) {
        var abe = getABE();
        if (abe && abe.isSpecialAvailableOnDay) return abe.isSpecialAvailableOnDay(cfg, dayName);
        if (!cfg) return true;
        if (Array.isArray(cfg.availableDays) && cfg.availableDays.length > 0) {
            return cfg.availableDays.map(function (d) { return d.toLowerCase(); })
                       .indexOf(dayName.toLowerCase()) >= 0;
        }
        return true;
    }

    function isScarce(cfg, dayName) {
        var abe = getABE();
        if (abe && abe.isScarceSpecial) return abe.isScarceSpecial(cfg, dayName);
        if (!cfg) return false;
        if (!isAvailableOnDay(cfg, dayName)) return false;
        if (Array.isArray(cfg.availableDays) && cfg.availableDays.length > 0) return true;
        if (cfg.mustScheduleWhenAvailable) return true;
        return false;
    }

    // =================================================================
    // CAPACITY RESOLUTION
    // =================================================================

    /**
     * Number of bunks that can simultaneously occupy this activity.
     * Reads sharableWith.capacity first, then fallback fields.
     */
    function getCapacity(cfg) {
        if (!cfg) return 1;
        if (cfg.sharableWith) {
            var cap = parseInt(cfg.sharableWith.capacity, 10);
            if (!isNaN(cap) && cap > 0) return cap;
            if (cfg.sharableWith.type === 'not_sharable') return 1;
        }
        var c = parseInt(cfg.capacity, 10) || parseInt(cfg.maxBunks, 10);
        return (!isNaN(c) && c > 0) ? c : 1;
    }

    // =================================================================
    // TIME WINDOW RESOLUTION
    // =================================================================

    /**
     * Get the time window for a scarce activity.
     * Priority: availableFrom/To → windowStart/End → timeRules[Available] → null
     */
    function getTimeWindow(cfg) {
        if (!cfg) return null;

        // Explicit window fields
        var start = cfg.availableFrom || cfg.windowStart || cfg.startTime;
        var end   = cfg.availableTo   || cfg.windowEnd   || cfg.endTime;
        if (start && end) {
            var s = parseTimeToMinutes(start);
            var e = parseTimeToMinutes(end);
            if (s !== null && e !== null && e > s) return { startMin: s, endMin: e };
        }

        // timeRules
        if (Array.isArray(cfg.timeRules) && cfg.timeRules.length > 0) {
            var available = cfg.timeRules.filter(function (r) {
                return !r.type || r.type === 'Available';
            });
            if (available.length > 0) {
                var earliest = Infinity, latest = -Infinity;
                available.forEach(function (r) {
                    var rs = r.startMin != null ? r.startMin : parseTimeToMinutes(r.start);
                    var re = r.endMin   != null ? r.endMin   : parseTimeToMinutes(r.end);
                    if (rs != null && rs < earliest) earliest = rs;
                    if (re != null && re > latest)   latest   = re;
                });
                if (earliest < Infinity && latest > -Infinity) {
                    return { startMin: earliest, endMin: latest };
                }
            }
        }

        return null;
    }

    // =================================================================
    // DIVISION AVAILABILITY CHECK
    // =================================================================

    /**
     * Returns true if the scarce activity is available to the given
     * division (respects limitUsage config from special_activities.js).
     */
    function isAvailableForDivision(specialName, divName) {
        var cfg = getSpecialCfg(specialName);
        if (!cfg) return true;
        var rules = cfg.limitUsage;
        if (!rules || !rules.enabled) return true;
        var allowed = rules.divisions;
        if (!allowed || typeof allowed !== 'object') return true;
        if (Array.isArray(allowed)) return allowed.indexOf(divName) >= 0;
        return divName in allowed;
    }

    // =================================================================
    // ROTATION SCORING
    // =================================================================

    /**
     * Lower score = did this more recently = lower allocation priority.
     * Higher score = longest gap / never done = allocate first.
     */
    function rotationScore(bunkName, activityName) {
        // Prefer full rotation score if available
        if (window.RotationEngine) {
            var re = window.RotationEngine;
            if (re.calculateFullRotationScore) {
                return re.calculateFullRotationScore(bunkName, activityName, 0, {});
            }
            if (re.calculateRecencyScore) {
                return re.calculateRecencyScore(bunkName, activityName, 0);
            }
            if (re.getDaysSinceActivity) {
                var days = re.getDaysSinceActivity(bunkName, activityName, 0);
                if (days === null || days === undefined) return 9999;
                return days;
            }
        }
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDaysSinceActivity) {
            var days2 = window.SchedulerCoreUtils.getDaysSinceActivity(bunkName, activityName, 0);
            if (days2 === null || days2 === undefined) return 9999;
            return days2;
        }
        return 1; // No history — treat all equal
    }

    // =================================================================
    // CAMP STRUCTURE HELPERS
    // =================================================================

    function getCampStructure() {
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        return g.campStructure || {};
    }

    function getDivisionForBunk(bunkName) {
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionForBunk) {
            return window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
        }
        var structure = getCampStructure();
        for (var divName in structure) {
            var grades = structure[divName].grades || {};
            for (var grade in grades) {
                if ((grades[grade].bunks || []).indexOf(bunkName) !== -1) return divName;
            }
        }
        return null;
    }

    // =================================================================
    // WAVE BUILDER
    // =================================================================

    /**
     * Given an ordered list of bunks to serve and a capacity (N bunks
     * simultaneously), produce wave assignments within the time window.
     *
     * Waves pack sequentially: wave 0 at windowStart, wave 1 at
     * windowStart + duration, etc. Returns null if there is not enough
     * room in the window for all waves.
     *
     * @param {string[]} rankedBunks   Bunks ordered by rotation score (desc)
     * @param {number}   capacity      Simultaneous slots
     * @param {number}   duration      Activity duration in minutes
     * @param {number}   windowStart
     * @param {number}   windowEnd
     *
     * @returns {Array<{ bunk, startMin, endMin, wave }>} or null if infeasible
     */
    function buildWaves(rankedBunks, capacity, duration, windowStart, windowEnd) {
        var totalBunks  = rankedBunks.length;
        var wavesNeeded = Math.ceil(totalBunks / capacity);
        var windowSize  = windowEnd - windowStart;
        var roomForWaves = Math.floor(windowSize / duration);

        if (roomForWaves < wavesNeeded) {
            // Not enough room — use all available wave slots, warn about rest
            wavesNeeded = roomForWaves;
        }

        var assignments = [];
        var bunkIdx = 0;

        for (var w = 0; w < wavesNeeded; w++) {
            var wStart = windowStart + w * duration;
            var wEnd   = wStart + duration;
            if (wEnd > windowEnd) break;

            for (var slot = 0; slot < capacity && bunkIdx < totalBunks; slot++) {
                assignments.push({
                    bunk:     rankedBunks[bunkIdx],
                    startMin: wStart,
                    endMin:   wEnd,
                    wave:     w
                });
                bunkIdx++;
            }
        }

        return { assignments: assignments, served: bunkIdx, total: totalBunks };
    }

    // =================================================================
    // DEFERRED BUNK TRACKING
    // =================================================================
    // Non-allocated bunks are stored in globalSettings so the next
    // available day's allocator can prioritise them.

    var DEFERRED_KEY = 'scarceDeferredBunks';

    function getDeferredBunks() {
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        return (g.app1 || {})[DEFERRED_KEY] || {};
    }

    function saveDeferredBunks(deferred) {
        try {
            var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            if (!g.app1) g.app1 = {};
            g.app1[DEFERRED_KEY] = deferred;
            if (window.saveGlobalSettings) window.saveGlobalSettings('app1', g.app1);
        } catch (e) {
            console.error('[ScarceAlloc] Failed to save deferred bunks:', e);
        }
    }

    function markBunksDeferred(activityName, bunkNames, dateStr) {
        if (!bunkNames || bunkNames.length === 0) return;
        var deferred = getDeferredBunks();
        if (!deferred[activityName]) deferred[activityName] = {};
        bunkNames.forEach(function (b) {
            deferred[activityName][b] = { since: dateStr, reason: 'capacity_exhausted' };
        });
        saveDeferredBunks(deferred);
    }

    function clearDeferredBunks(activityName, bunkNames) {
        var deferred = getDeferredBunks();
        if (!deferred[activityName]) return;
        bunkNames.forEach(function (b) { delete deferred[activityName][b]; });
        saveDeferredBunks(deferred);
    }

    /**
     * Boost rotation score for bunks that were deferred from a prior day.
     */
    function applyDeferredBoost(bunkName, activityName, baseScore) {
        var deferred = getDeferredBunks();
        if (deferred[activityName] && deferred[activityName][bunkName]) {
            return baseScore + 5000; // Large boost — deferred bunks go first
        }
        return baseScore;
    }

    // =================================================================
    // CORE ALLOCATOR
    // =================================================================

    /**
     * Allocate scarce activities for a given date across all bunks.
     *
     * @param {object} params
     *   params.dateStr    {string}   'YYYY-MM-DD'
     *   params.allBunks   {string[]} All bunks to consider
     *   params.warnings   {string[]} Shared warnings array (mutated)
     *
     * @returns {object} result
     *   result.scarceBlocksMap  { bunkName: [block, ...] }
     *   result.deferredBunks    { activityName: [bunkName, ...] }
     *   result.warnings         {string[]}
     *   result.allocations      summary array (for UI / logging)
     */
    function allocate(params) {
        clearLogs();

        var dateStr  = params.dateStr;
        var allBunks = params.allBunks || [];
        var warnings = params.warnings || [];

        var dayName  = dayNameFromDateStr(dateStr);
        var isRainy  = window.isRainyDayModeActive ? window.isRainyDayModeActive() : false;

        log('==================================================');
        log('ScarceActivityAllocator v' + VERSION);
        log('Date: ' + dateStr + ' (' + dayName + ')' + (isRainy ? ' ☔ RAINY' : ''));
        log('Bunks: ' + allBunks.length);
        log('==================================================');

        var scarceBlocksMap = {};    // { bunk: [block] }
        var deferredBunks   = {};    // { activityName: [bunk] }
        var allocations     = [];    // summary for logging/UI

        // Initialise output map
        allBunks.forEach(function (b) { scarceBlocksMap[b] = []; });

        // ── Step 1: Identify scarce specials available today ────────────
        var allSpecials = getAllSpecials();

        // Filter: rainy day exclusivity
        if (!isRainy) {
            allSpecials = allSpecials.filter(function (s) {
                return s.rainyDayOnly !== true && s.rainyDayExclusive !== true;
            });
        } else {
            allSpecials = allSpecials.filter(function (s) {
                return s.rainyDayAvailable !== false && s.availableOnRainyDay !== false;
            });
        }

        var todaysScarce = allSpecials.filter(function (s) {
            return isScarce(s, dayName);
        });

        log('Scarce specials today: ' + todaysScarce.length +
            ' (' + todaysScarce.map(function (s) { return s.name; }).join(', ') + ')');

        if (todaysScarce.length === 0) {
            log('No scarce specials today — allocator done');
            return { scarceBlocksMap: scarceBlocksMap, deferredBunks: deferredBunks,
                     warnings: warnings, allocations: allocations };
        }

        // ── Step 2–6: Per scarce activity ──────────────────────────────
        todaysScarce.forEach(function (cfg) {
            var name     = cfg.name;
            var duration = parseInt(cfg.duration || cfg.defaultDuration, 10) || 30;
            var capacity = getCapacity(cfg);
            var tw       = getTimeWindow(cfg);

            log('\n[' + name + '] duration=' + duration + 'min, capacity=' + capacity);

            if (!tw) {
                var msg = name + ': No time window configured — cannot allocate (add timeRules or availableFrom/To)';
                warn(msg);
                warnings.push(msg);
                return;
            }

            log('  Window: ' + minutesToLabel(tw.startMin) + '–' + minutesToLabel(tw.endMin));

            // ── Step 2: Score all eligible bunks ────────────────────────
            var eligibleBunks = allBunks.filter(function (b) {
                var div = getDivisionForBunk(b);
                return div ? isAvailableForDivision(name, div) : true;
            });

            if (eligibleBunks.length === 0) {
                var msg2 = name + ': No eligible bunks (all excluded by division restrictions)';
                warn(msg2);
                warnings.push(msg2);
                return;
            }

            // Score and sort: highest score → allocated first
            var scored = eligibleBunks.map(function (b) {
                var base = rotationScore(b, name);
                var boosted = applyDeferredBoost(b, name, base);
                return { bunk: b, score: boosted, base: base };
            });
            scored.sort(function (a, b) { return b.score - a.score; });

            log('  Eligible: ' + eligibleBunks.length +
                ' | Top 3: ' + scored.slice(0, 3).map(function (s) {
                    return s.bunk + '(' + s.score + ')';
                }).join(', '));

            // ── Step 3: Determine how many slots the window holds ───────
            var slotsInWindow = Math.floor((tw.endMin - tw.startMin) / duration);
            var totalCapacity = slotsInWindow * capacity; // max bunks the window can serve

            if (totalCapacity <= 0) {
                var msg3 = name + ': Time window (' + (tw.endMin - tw.startMin) +
                    ' min) too small for duration (' + duration + ' min)';
                warn(msg3);
                warnings.push(msg3);
                return;
            }

            // ── Step 4: Fill ALL capacity slots ─────────────────────────
            var toServe = Math.min(scored.length, totalCapacity);

            if (toServe < capacity && toServe < scored.length) {
                // Warn but continue — this shouldn't happen in practice
                warn(name + ': Only ' + toServe + ' bunks will be served (capacity=' + capacity + ')');
            }

            if (toServe === 0) {
                warn(name + ': No bunks to serve');
                return;
            }

            var rankedBunks = scored.slice(0, toServe).map(function (s) { return s.bunk; });

            // ── Step 5: Build wave schedule ──────────────────────────────
            var waveResult = buildWaves(rankedBunks, capacity, duration, tw.startMin, tw.endMin);

            log('  Serving ' + waveResult.served + '/' + waveResult.total +
                ' bunks in ' + Math.ceil(waveResult.served / capacity) + ' wave(s)');

            if (waveResult.served < waveResult.total) {
                var unserved = rankedBunks.slice(waveResult.served);
                var msg4 = name + ': Window too small — ' + unserved.length +
                    ' bunk(s) deferred to next available day: [' + unserved.join(', ') + ']';
                warn(msg4);
                warnings.push(msg4);
                markBunksDeferred(name, unserved, dateStr);
                deferredBunks[name] = unserved;
            }

            // ── Step 6: Write committed blocks ──────────────────────────
            waveResult.assignments.forEach(function (a) {
                if (!scarceBlocksMap[a.bunk]) scarceBlocksMap[a.bunk] = [];
                scarceBlocksMap[a.bunk].push({
                    activityName:       name,
                    type:               'scarce_special',
                    startMin:           a.startMin,
                    endMin:             a.endMin,
                    duration:           a.endMin - a.startMin,
                    isScarce:           true,
                    capacity:           capacity,
                    wave:               a.wave,
                    _suggestedActivity: name,
                    _autoGenerated:     true,
                    _durationStrict:    true   // solver cannot resize this block
                });
            });

            // Clear any deferred flags for bunks that got served today
            var servedBunks = waveResult.assignments.map(function (a) { return a.bunk; });
            clearDeferredBunks(name, servedBunks);

            // Non-allocated bunks (were eligible but capacity ran out today entirely)
            var notAllocated = eligibleBunks.filter(function (b) {
                return rankedBunks.indexOf(b) === -1;
            });
            if (notAllocated.length > 0) {
                markBunksDeferred(name, notAllocated, dateStr);
                if (!deferredBunks[name]) deferredBunks[name] = [];
                deferredBunks[name] = deferredBunks[name].concat(notAllocated);
                log('  Deferred (not in top capacity): [' + notAllocated.join(', ') + ']');
            }

            // ── Summary entry ────────────────────────────────────────────
            allocations.push({
                activityName: name,
                capacity:     capacity,
                duration:     duration,
                window:       tw,
                served:       waveResult.served,
                total:        scored.length,
                deferred:     (deferredBunks[name] || []).length,
                waves:        Math.ceil(waveResult.served / capacity),
                assignments:  waveResult.assignments
            });

            log('  ✓ ' + name + ': ' + waveResult.served + ' bunks committed across ' +
                Math.ceil(waveResult.served / capacity) + ' wave(s)');
        });

        // ── Summary ───────────────────────────────────────────────────
        var totalCommitted = 0;
        allBunks.forEach(function (b) {
            totalCommitted += (scarceBlocksMap[b] || []).length;
        });

        log('\n==================================================');
        log('ALLOCATOR COMPLETE: ' + allocations.length + ' scarce activities processed');
        log('Total committed blocks: ' + totalCommitted);
        if (warnings.length > 0) log(warnings.length + ' warning(s)');
        log('==================================================');

        return {
            scarceBlocksMap: scarceBlocksMap,
            deferredBunks:   deferredBunks,
            warnings:        warnings,
            allocations:     allocations
        };
    }

    // =================================================================
    // CONVENIENCE: get all bunks across all grades
    // =================================================================

    function getAllBunksFromStructure() {
        var structure = getCampStructure();
        var bunks = [];
        Object.values(structure).forEach(function (divData) {
            Object.values(divData.grades || {}).forEach(function (gradeData) {
                (gradeData.bunks || []).forEach(function (b) {
                    if (bunks.indexOf(b) === -1) bunks.push(b);
                });
            });
        });
        return bunks;
    }

    // =================================================================
    // PUBLIC API
    // =================================================================

    window.ScarceActivityAllocator = {
        VERSION: VERSION,

        // Core
        allocate: allocate,

        // Helpers (exposed for DayPlanEngine and testing)
        isScarce:              isScarce,
        getCapacity:           getCapacity,
        getTimeWindow:         getTimeWindow,
        isAvailableOnDay:      isAvailableOnDay,
        isAvailableForDivision: isAvailableForDivision,
        rotationScore:         rotationScore,
        buildWaves:            buildWaves,
        getAllBunksFromStructure: getAllBunksFromStructure,

        // Deferred bunk management
        getDeferredBunks:  getDeferredBunks,
        markBunksDeferred: markBunksDeferred,
        clearDeferredBunks: clearDeferredBunks,

        // Debug
        getLogs:    getLogs,
        clearLogs:  clearLogs
    };

    log('ScarceActivityAllocator v' + VERSION + ' loaded');

})();
