// =============================================================================
// scheduler_core_auto.js — CAMPISTRY AUTO SCHEDULER CORE v1.0
// =============================================================================
// Replaces scheduler_core_main.js entirely when builderMode === 'auto'.
// Takes raw user-defined layers from auto_schedule_planner.js and produces
// a complete, validated, per-bunk schedule for the entire camp.
//
// PIPELINE:
//   Step 0    — Wipe clean
//   Step 1    — Load layers and supporting data
//   Step 1.5  — Classify layers (Pinned / Windowed / Open)
//   Step 2    — Live iterative solver (build the day per bunk across camp)
//     2.1     — Place Pinned layers (anchors)
//     2.2a    — Query RotationEngine for ranked specials per bunk
//     2.2b    — Mini Special Solver (draft order, scarce-first, live capacity)
//     2.3     — Live placement engine (Windowed + Open, camp-wide simultaneous)
//     2.4     — Backtrack and retry
//     2.5     — Gap fill (General Activity for uncovered time)
//     2.6     — Validate (no gaps, no overlaps, all quantities satisfied)
//     2.7     — Formalize (buildFromSkeleton, _perBunkSlots, scheduleAssignments)
//   Step 3    — League engines (time blocks from Step 2 → matchup logic)
//   Step 4    — Total Solver (field + sport/general activity assignment only)
//   Step 5    — Save and fire campistry-generation-complete
//
// KEY CONTRACTS:
//   - Special activity blocks are FULLY resolved here (activity + field + lock).
//     The Total Solver receives them as already-filled slots and skips them.
//   - field usage is registered in fieldUsageBySlot immediately when a special
//     block is committed, so the Total Solver sees real occupancy.
//   - _divisionTimesLocked = true is set in Step 2.7 — nothing may overwrite
//     divisionTimes after that point.
//   - division_times_integration.js must have an early return for auto mode
//     before this file runs. That file's patches are NOT active in auto mode.
// =============================================================================

(function () {
    'use strict';

    const VERSION = '1.1.0'; // self-contained — no window.AutoBuildEngine dependency
    const TAG = '[AutoCore]';

    function log(msg, ...args) { console.log(TAG + ' ' + msg, ...args); }
    function warn(msg, ...args) { console.warn(TAG + ' ⚠️ ' + msg, ...args); }
    function err(msg, ...args) { console.error(TAG + ' ❌ ' + msg, ...args); }

    // =========================================================================
    // UTILITIES — all self-contained, no window.AutoBuildEngine dependency
    // =========================================================================

    // Unique ID generator
    function uid() { return 'ac_' + Math.random().toString(36).slice(2, 9); }

    // Parse a time string or number to minutes-since-midnight
    function parseTimeToMinutes(str) {
        if (str == null) return null;
        if (typeof str === 'number') return str;
        let s = String(str).toLowerCase().trim();
        const isPM = s.includes('pm'), isAM = s.includes('am');
        s = s.replace(/am|pm/g, '').trim();
        const parts = s.split(':');
        let h = parseInt(parts[0], 10);
        if (isNaN(h)) return null;
        const m = parseInt(parts[1], 10) || 0;
        if (isPM && h !== 12) h += 12;
        if (isAM && h === 12) h = 0;
        return h * 60 + m;
    }

    // Format minutes to "9:00am" style label
    function minutesToTimeLabel(min) {
        if (min == null) return '';
        let h = Math.floor(min / 60), m = min % 60;
        const ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + String(m).padStart(2, '0') + ap;
    }

    function minutesToDate(min) {
        const d = new Date();
        d.setHours(Math.floor(min / 60), min % 60, 0, 0);
        return d;
    }

    // Compute layer ratio = periodMin / (endMin - startMin)
   function computeRatio(layer) {
        const win = (layer.endMin || 0) - (layer.startMin || 0);
        if (win <= 0) return 1;
        const dur = layer.periodMin || layer.duration || layer.durationMin || 0;
        // No duration + tight window (≤ 30 min) = treat as pinned anchor (lunch, dismissal, etc.)
        if (dur === 0 && win <= 30) return 1;
        return dur / win;
    }

    // Deep clone a plain object
    function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

    // Check if two time ranges overlap
    function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }

    // Snap to nearest 5 minutes
    function snapTo5(val) { return Math.round(val / 5) * 5; }

    // ── Data access ──────────────────────────────────────────────────────────

    function getGlobalSettings() { return window.loadGlobalSettings ? window.loadGlobalSettings() : {}; }

    function getSpecialActivitiesList(globalSettings) {
        return (globalSettings.app1 && globalSettings.app1.specialActivities) || [];
    }

    // Look up a special activity config by name (case-insensitive)
    function getSpecialConfig(specialName, globalSettings) {
        const specials = getSpecialActivitiesList(globalSettings);
        return specials.find(s => s.name && s.name.toLowerCase().trim() === specialName.toLowerCase().trim()) || null;
    }

    // Get all fields from globalSettings
    function getFields(globalSettings) {
        return (globalSettings.app1 && globalSettings.app1.fields) || globalSettings.fields || [];
    }

    // Get bunks for a grade/division
    function getBunksForGrade(grade, divisions) {
        return (divisions[grade] && divisions[grade].bunks) ? [...divisions[grade].bunks] : [];
    }

    // Get division start/end times in minutes
    function getDivisionTimes(grade, divisions) {
        const div = divisions[grade];
        if (!div) return { start: 540, end: 960 };
        return {
            start: (div.startTime ? parseTimeToMinutes(div.startTime) : 540) || 540,
            end:   (div.endTime   ? parseTimeToMinutes(div.endTime)   : 960) || 960
        };
    }

    // ── Special activity helpers ─────────────────────────────────────────────

    // Get the available time window for a special from its timeRules config
    function getSpecialTimeWindow(cfg) {
        if (!cfg) return null;
        const start = cfg.availableFrom || cfg.windowStart || cfg.startTime;
        const end   = cfg.availableTo   || cfg.windowEnd   || cfg.endTime;
        if (start && end) {
            return {
                startMin: typeof start === 'number' ? start : parseTimeToMinutes(start),
                endMin:   typeof end   === 'number' ? end   : parseTimeToMinutes(end)
            };
        }
        if (Array.isArray(cfg.timeRules) && cfg.timeRules.length > 0) {
            const available = cfg.timeRules.filter(r => r.type === 'Available' || !r.type);
            if (available.length > 0) {
                let earliest = Infinity, latest = -Infinity;
                available.forEach(r => {
                    const rs = r.startMin != null ? r.startMin : parseTimeToMinutes(r.start);
                    const re = r.endMin   != null ? r.endMin   : parseTimeToMinutes(r.end);
                    if (rs != null && rs < earliest) earliest = rs;
                    if (re != null && re > latest)   latest   = re;
                });
                if (earliest < Infinity && latest > -Infinity) return { startMin: earliest, endMin: latest };
            }
        }
        return null;
    }

    // Duration of a special — checks all known property names + live registry fallback
   function getSpecialDuration(specialName, activityProperties, globalSettings, layer) {
        // 1. activityProperties (runtime-enriched map)
        const props = activityProperties && activityProperties[specialName];
        if (props) {
            const d = props.defaultDuration || props.duration || props.durationMin || props.periodMin;
            if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
        }

        // 2. Special activity config from globalSettings
        const cfg = getSpecialConfig(specialName, globalSettings);
        if (cfg) {
            const d = cfg.defaultDuration || cfg.duration || cfg.durationMin || cfg.periodMin;
            if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
        }

        // 3. Live window registry (special_activities.js may expose this)
        if (window.getSpecialActivityByName) {
            const live = window.getSpecialActivityByName(specialName);
            if (live) {
                const d = live.defaultDuration || live.duration || live.durationMin;
                if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
            }
        }
// Fall back to layer's own duration constraints
        if (layer) {
            const d = layer.periodMin || layer.durationMin || layer.duration;
            if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
            // If layer only has a window, use half of it capped at 60
            if (layer.startMin != null && layer.endMin != null) {
                const half = Math.round((layer.endMin - layer.startMin) / 2);
                return Math.min(60, Math.max(20, snapTo5(half)));
            }
        }

        return null;
    }

    // Capacity of a special (how many bunks can do it simultaneously)
    function getSpecialCapacity(specialName, activityProperties, globalSettings) {
        const cfg = getSpecialConfig(specialName, globalSettings);
        if (cfg) {
            if (cfg.sharableWith) {
                if (cfg.sharableWith.type === 'not_sharable') return 1;
                const c = parseInt(cfg.sharableWith.capacity);
                if (!isNaN(c) && c > 0) return c;
            }
            const c = parseInt(cfg.capacity) || parseInt(cfg.maxBunks);
            if (!isNaN(c) && c > 0) return c;
        }
        // Fall back to activityProperties
        const props = activityProperties && activityProperties[specialName];
        if (props) {
            if (props.sharableWith) {
                if (props.sharableWith.type === 'not_sharable') return 1;
                if (props.sharableWith.capacity) return parseInt(props.sharableWith.capacity) || 1;
            }
            if (props.capacity) return parseInt(props.capacity);
            if (props.maxBunks) return parseInt(props.maxBunks);
        }
        return 2; // default
    }

    // True if this special only runs on specific days (must be prioritised today)
    function isScarce(specialName, dayName, globalSettings) {
        const cfg = getSpecialConfig(specialName, globalSettings);
        if (!cfg) return false;
        if (!isSpecialAvailableOnDay(specialName, dayName, false, globalSettings)) return false;
        return !!(
            (cfg.availableDays && cfg.availableDays.length > 0) ||
            cfg.dayAvailability ||
            cfg.mustScheduleWhenAvailable
        );
    }

    // True if this special should run on the given day (respects rainy day rules)
    function isSpecialAvailableOnDay(specialName, dayName, isRainy, globalSettings) {
        const cfg = getSpecialConfig(specialName, globalSettings);
        if (!cfg) return true;
        if (!isRainy && cfg.rainyDayOnly) return false;
        if (isRainy && cfg.availableOnRainyDay === false) return false;
        // availableDays array
        if (Array.isArray(cfg.availableDays) && cfg.availableDays.length > 0) {
            return cfg.availableDays.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
        }
        // dayAvailability object or array
        if (cfg.dayAvailability) {
            const da = cfg.dayAvailability;
            if (typeof da === 'object' && !Array.isArray(da)) return da[dayName] !== false;
            if (Array.isArray(da)) return da.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
        }
        return true;
    }

    // True if this special is accessible by a specific division (respects limitUsage)
    function isSpecialAvailableForDivision(specialName, divName, globalSettings) {
        const cfg = getSpecialConfig(specialName, globalSettings);
        if (!cfg) return true;
        const rules = cfg.limitUsage;
        if (!rules || !rules.enabled) return true;
        const allowed = rules.divisions;
        if (!allowed || typeof allowed !== 'object') return true;
        if (Array.isArray(allowed)) return allowed.includes(divName);
        return divName in allowed;
    }

    // Get the location/field for a special activity
    function getLocationForSpecial(specialName, activityProperties, globalSettings) {
        const props = activityProperties && activityProperties[specialName];
        if (props && props.location) return props.location;
        const cfg = getSpecialConfig(specialName, globalSettings);
        return (cfg && cfg.location) ? cfg.location : null;
    }

    // Register field usage when a special block is committed
    function registerSpecialFieldUsage(slotIndices, fieldName, bunkName, activityName, divName, fieldUsageBySlot) {
        for (const slotIdx of slotIndices) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fieldName]) {
                fieldUsageBySlot[slotIdx][fieldName] = { count: 0, divisions: [], bunks: {}, _locked: false };
            }
            fieldUsageBySlot[slotIdx][fieldName].count++;
            fieldUsageBySlot[slotIdx][fieldName].bunks[bunkName] = activityName;
            if (divName && !fieldUsageBySlot[slotIdx][fieldName].divisions.includes(divName)) {
                fieldUsageBySlot[slotIdx][fieldName].divisions.push(divName);
            }
        }
    }

    // Sort grades by constraint tightness (most special layers, fewest fallbacks = most constrained)
    function sortGradesByConstraint(grades, layersByGrade, specialRanking) {
        return [...grades].sort((a, b) => {
            const aSpecial = (layersByGrade[a] || []).filter(l => l.type === 'special').length;
            const bSpecial = (layersByGrade[b] || []).filter(l => l.type === 'special').length;
            const aOptions = (specialRanking[a] || []).length;
            const bOptions = (specialRanking[b] || []).length;
            // More special layers + fewer fallback options = more constrained
            return (bSpecial - aSpecial) || (aOptions - bOptions);
        });
    }

    // Sort bunks by constraint (fewest ranked specials = most constrained)
    function sortBunksByConstraint(bunks, bunkSpecialRanking) {
        return [...bunks].sort((a, b) => {
            const aRank = (bunkSpecialRanking[a] || []).length;
            const bRank = (bunkSpecialRanking[b] || []).length;
            return aRank - bRank;
        });
    }

    // =========================================================================
    // MAIN ENTRY POINT
    // =========================================================================

    window.runAutoScheduler = async function (layers, options) {
        options = options || {};

        log('═══════════════════════════════════════════════════════════');
        log('AUTO SCHEDULER CORE v' + VERSION);
        log('═══════════════════════════════════════════════════════════');

        const startTime = Date.now();
        const warnings = [];

        // =====================================================================
        // STEP 0 — WIPE CLEAN
        // =====================================================================
        log('\n[STEP 0] Wiping clean...');

        // Block stale cloud rehydration during generation
        window._preGenClearActive = true;
        window._divisionTimesLocked = false;

        // Reset scheduleAssignments and related
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window.fieldUsageBySlot = {};
        window.locationUsageBySlot = {};

        // Reset GlobalFieldLocks
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.reset();
        } else {
            warn('[STEP 0] GlobalFieldLocks not loaded — field locking will not work');
        }

        // Reset RotationEngine caches
        if (window.RotationEngine && window.RotationEngine.rebuildAllHistory) {
            window.RotationEngine.rebuildAllHistory();
        }

        log('[STEP 0] ✅ Wiped clean');

        // =====================================================================
        // STEP 1 — LOAD LAYERS AND SUPPORTING DATA
        // =====================================================================
        log('\n[STEP 1] Loading layers and supporting data...');

        if (!layers || layers.length === 0) {
            err('[STEP 1] No layers provided — cannot generate');
            window._preGenClearActive = false;
            return false;
        }

        const globalSettings = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        const divisions = window.divisions || (globalSettings.app1 && globalSettings.app1.divisions) || {};
        const activityProperties = window.activityProperties || {};

        // Rainy day detection
        const dailyData = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
        if (window.isRainyDay === undefined) {
            window.isRainyDay = dailyData.rainyDayMode === true || dailyData.isRainyDay === true;
        }
        const isRainy = !!window.isRainyDay;
        log('[STEP 1] Rainy Day Mode: ' + (isRainy ? '🌧️ YES' : '☀️ NO'));

        // Day of week
        const currentDate = window.currentScheduleDate || window.currentDate || '';
        let dayName = 'Monday';
        if (currentDate) {
            const parts = currentDate.split('-').map(Number);
            const dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
            dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
        }
        log('[STEP 1] Day: ' + dayName);

        // All past daily data — keyed by date string 'YYYY-MM-DD'
        const allDailyData = window.loadAllDailyData ? window.loadAllDailyData() : {};

        // ── Period boundary helpers ────────────────────────────────────────────
        // Returns the ISO date string (YYYY-MM-DD) for the Monday of the week
        // that contains the given date string, offset by -weeksBack full weeks.
        function getMondayOfWeek(dateStr, weeksBack) {
            if (!dateStr) return null;
            const parts = dateStr.split('-').map(Number);
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            // Walk back to Monday of current week
            const dow = d.getDay(); // 0=Sun
            const daysToMon = dow === 0 ? 6 : dow - 1;
            d.setDate(d.getDate() - daysToMon - (weeksBack * 7));
            return d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
        }

        // Returns the start date for the current camp half from globalSettings,
        // falling back to the earliest date in allDailyData if not configured.
        function getHalfStartDate() {
            const s = globalSettings.app1 || globalSettings;
            if (s.halfStartDate) return s.halfStartDate;
            if (s.currentHalfStart) return s.currentHalfStart;
            if (s.sessionHalfStart) return s.sessionHalfStart;
            // Fallback: earliest date in history
            const dates = Object.keys(allDailyData).sort();
            return dates.length > 0 ? dates[0] : null;
        }

        // Returns the window start date for a given maxUsagePeriod.
        // Dates strictly before this cutoff are NOT counted.
        function getPeriodStartDate(period) {
            switch (period) {
                case '1week':  return getMondayOfWeek(currentDate, 0);
                case '2weeks': return getMondayOfWeek(currentDate, 1);
                case '3weeks': return getMondayOfWeek(currentDate, 2);
                case '4weeks': return getMondayOfWeek(currentDate, 3);
                case 'half':
                default:       return getHalfStartDate();
            }
        }

        // ── Core period count function ─────────────────────────────────────────
        // Returns how many times bunk received specialName within the period
        // defined by maxUsagePeriod, looking only at dates before today.
        function getPeriodCount(bunk, specialName, maxUsagePeriod) {
            const periodStart = getPeriodStartDate(maxUsagePeriod || 'half');

            let count = 0;
            Object.entries(allDailyData).forEach(([dateKey, dayData]) => {
                // Only count past days, within the period window
                if (dateKey >= currentDate) return;
                if (periodStart && dateKey < periodStart) return;

                const slots = dayData?.scheduleAssignments?.[bunk];
                if (!Array.isArray(slots)) return;

                // Count at most once per day (a bunk doesn't do the same special twice in a day)
                const found = slots.some(entry =>
                    entry &&
                    !entry.continuation &&
                    (entry._activity === specialName || entry.field === specialName)
                );
                if (found) count++;
            });
            return count;
        }

        log('[STEP 1] Period-aware usage tracking ready (' +
            Object.keys(allDailyData).length + ' days of history)');

        // RBAC — which divisions this user can generate
        const allowedDivisions = options.allowedDivisions || null; // null = all
        const allowedSet = allowedDivisions ? new Set(allowedDivisions.map(String)) : null;

        // All specials available today
        const allSpecials = (globalSettings.app1 && globalSettings.app1.specialActivities) || [];
        const todaysSpecials = allSpecials.filter(s =>
            isSpecialAvailableOnDay(s.name, dayName, isRainy, globalSettings)
        );
        const scarceSpecials = todaysSpecials.filter(s => isScarce(s.name, dayName, globalSettings));
        const regularSpecials = todaysSpecials.filter(s => !isScarce(s.name, dayName, globalSettings));

        log('[STEP 1] Specials today: ' + todaysSpecials.length +
            ' (' + scarceSpecials.length + ' scarce, ' + regularSpecials.length + ' regular)');
        log('[STEP 1] Grades in config: ' + Object.keys(divisions).join(', '));
        log('[STEP 1] ✅ Data loaded');

        // fieldUsageBySlot local reference
        const fieldUsageBySlot = window.fieldUsageBySlot;

        // =====================================================================
        // STEP 1.5 — CLASSIFY LAYERS
        // =====================================================================
        log('\n[STEP 1.5] Classifying layers...');

        // Group layers by grade
        const layersByGrade = {};
        layers.forEach(layer => {
            const grade = layer.grade || layer.division || '_all';
            if (!layersByGrade[grade]) layersByGrade[grade] = [];
            layersByGrade[grade].push(layer);
        });

        // Classify each layer
        // ratio = periodMin / (endMin - startMin)
        // Pinned:   ratio === 1  (fills exactly)
        // Windowed: ratio >= 0.25 and < 1
        // Open:     ratio < 0.25
      const classified = layers.map(layer => {
            const ratio = computeRatio(layer);
            let classification;
            if (ratio >= 1) {
                classification = 'pinned';
            } else if (ratio >= 0.25) {
                classification = 'windowed';
            } else {
                classification = 'open';
            }
            return Object.assign({}, layer, { _classification: classification, _ratio: ratio });
        });

        // Sort most constrained first: pinned → windowed → open
        // Within same class, higher ratio = more constrained
        const classOrder = { pinned: 0, windowed: 1, open: 2 };
        classified.sort((a, b) => {
            const classDiff = classOrder[a._classification] - classOrder[b._classification];
            if (classDiff !== 0) return classDiff;
            return b._ratio - a._ratio; // higher ratio = more constrained within class
        });

        const pinnedLayers   = classified.filter(l => l._classification === 'pinned');
        const windowedLayers = classified.filter(l => l._classification === 'windowed');
        const openLayers     = classified.filter(l => l._classification === 'open');

        log('[STEP 1.5] Classified: ' + pinnedLayers.length + ' pinned, ' +
            windowedLayers.length + ' windowed, ' + openLayers.length + ' open');
        log('[STEP 1.5] ✅ Classification complete');
        // Declare allGrades and all mutable Step-2 state early
        // so the iterative wrapper's resetIterState() can reference them
        const allGrades = Object.keys(divisions).filter(g =>
            !allowedSet || allowedSet.has(String(g))
        );

        const bunkTimelines = {};
        const bunkSpecialQueues = {};
        const bunkSpecialAssigned = {};
        const specialCapacityTracker = {};
        const activityCapacityTracker = {};
        const sharedLeagueTime = {};
        const bunkNeeds = {};

        // =====================================================================
        // ITERATIVE BEST-PICK WRAPPER
        // Runs Steps 2.1–2.5b up to MAX_ITERATIONS times with varying seeds.
        // Each iteration is a full independent build — all mutable state is
        // reset between runs. Steps 3–5 run once on the best result.
        // =====================================================================

        const MAX_ITERATIONS  = 60;
        const PERFECT_SCORE   = 0;
        const STALE_STOP      = 12; // stop if no improvement for this many consecutive iterations

        let _iterSeed    = 0; // read by stagger offset in Step 2.3
        let bestScore    = Infinity;
        let bestTimelines = null;
        let bestWarnings  = [];
        let staleCount   = 0;
       let totalIters   = 0;

        log('\n══════════════════════════════════════════════════════════');
        // Lower = better. 0 = perfect.
       function scoreTimelines(timelines, iterWarnings) {
            let score = 0;

            Object.entries(timelines).forEach(([bunk, timeline]) => {
                // ── Duration violations ──────────────────────────────────────
                timeline.forEach(block => {
                    if (!block.layer) return;
                    const dur    = block.endMin - block.startMin;
                    const minDur = block.layer.durationMin || block.layer.periodMin || block.layer.duration || 0;
                    const maxDur = block.layer.durationMax || block.layer.periodMin || block.layer.duration || Infinity;
                    if (minDur && dur < minDur) score += (minDur - dur) * 20;  // heavy — duration too short
                    if (maxDur < Infinity && dur > maxDur) score += (dur - maxDur) * 10; // over max
                });
// ── Out-of-bounds penalty ────────────────────────────────────
                const gradeKey = Object.entries(divisions).find(([g, d]) =>
                    (d.bunks || []).map(String).includes(String(bunk))
                )?.[0];
                if (gradeKey) {
                    const dStart = parseTimeToMinutes(divisions[gradeKey]?.startTime) || 540;
                    const dEnd   = parseTimeToMinutes(divisions[gradeKey]?.endTime)   || 960;
                    timeline.forEach(block => {
                        if (block.endMin <= dStart || block.startMin >= dEnd) {
                            score += 10000; // massive penalty — this iteration is garbage
                        }
                    });
                }
                // ── Gaps between blocks ──────────────────────────────────────
                const sorted = [...timeline].sort((a, b) => a.startMin - b.startMin);
                for (let i = 0; i < sorted.length - 1; i++) {
                    const gap = sorted[i + 1].startMin - sorted[i].endMin;
                    if (gap > 0) score += gap * 5; // any gap is bad
                }

                // ── Undersized gap-fill slots ────────────────────────────────
                // A slot smaller than GAP_MIN_DUR means the placer created an
                // unfillable hole — heavily penalise so this iteration loses
                timeline.forEach(block => {
                    if (block._fromGapDetection) {
                        const dur = block.endMin - block.startMin;
                        if (dur < GAP_MIN_DUR) score += (GAP_MIN_DUR - dur) * 50;
                    }
                });

                // ── Unmet needs penalty ──────────────────────────────────────
                // If bunkNeeds has unplaced required layers, score heavily
                const needs = bunkNeeds[bunk] || [];
                needs.forEach(n => {
                    if (n.op !== '<=' && n.op !== '≤') {
                        const deficit = Math.max(0, n.required - n.placed);
                        if (deficit > 0) score += deficit * 300;
                    }
                });
            });

            // ── Warning penalties ────────────────────────────────────────────
             iterWarnings.forEach(w => {
                if (w.type === 'placement_failure') score += 500;
                if (w.type === 'overlap')           score += 1000;
                if (w.type === 'remaining_gap')     score += 50;
            });
 
            // ── Field contention penalty ─────────────────────────────────
            // Penalise iterations where sport/field demand exceeds capacity.
            // Uses getFieldImpact per block so specials-on-fields count as
            // consumers while off-field specials do not.
            const campStart = Math.min(...Object.values(divisions).map(d =>
                parseTimeToMinutes(d.startTime) || 660
            ));
            const campEnd = Math.max(...Object.values(divisions).map(d =>
                parseTimeToMinutes(d.endTime) || 990
            ));
 
            for (let t = campStart; t < campEnd; t += CONTENTION_SLICE) {
                const sliceEnd = Math.min(t + CONTENTION_SLICE, campEnd);
                let sportCount = 0;
 
                Object.entries(timelines).forEach(([bunk, timeline]) => {
                    for (const block of timeline) {
                        if (getFieldImpact(block) !== 'consumer') continue;
                        if (block.startMin < sliceEnd && block.endMin > t) {
                            sportCount++;
                            break;
                        }
                    }
                });
 
                if (sportCount > FIELD_CAPACITY) {
                    score += (sportCount - FIELD_CAPACITY) * 200;
                }
            }
 
            return score;
        }

        // ── Reset all mutable Step-2 state between iterations ────────────────
        function resetIterState() {
            // Clear bunk timelines
            allGrades.forEach(grade => {
                getBunksForGrade(grade, divisions).forEach(bunk => {
                    bunkTimelines[bunk] = [];
                    bunkSpecialAssigned[bunk] = {};
                });
            });

            // Reset special capacity tracker assignments (keep totals)
            todaysSpecials.forEach(s => {
                if (specialCapacityTracker[s.name]) {
                    specialCapacityTracker[s.name].assignments = [];
                }
            });

            // Reset activity capacity tracker entirely
            Object.keys(activityCapacityTracker).forEach(k => {
                delete activityCapacityTracker[k];
            });

            // Reset bunkNeeds placed counters
            Object.values(bunkNeeds).forEach(needs => {
                needs.forEach(n => { n.placed = 0; });
            });

            // Reset league shared time map
            Object.keys(sharedLeagueTime).forEach(k => {
                delete sharedLeagueTime[k];
            });
        }

       
        log('\n══════════════════════════════════════════════════════════');
        log('ITERATIVE BEST-PICK — cap: ' + MAX_ITERATIONS +
            ' | stale stop: ' + STALE_STOP + ' iterations');
        log('══════════════════════════════════════════════════════════');

        // =====================================================================
        // STEP 2 — LIVE ITERATIVE SOLVER
        // =====================================================================
        log('\n[STEP 2] Live iterative solver — building day for entire camp...');
// ── Helper functions — defined outside loop ──────────────────────────

        function getFreeGaps(bunk, windowStart, windowEnd) {
            const timeline = bunkTimelines[bunk] || [];
            const occupied = timeline
                .filter(b => overlaps(b.startMin, b.endMin, windowStart, windowEnd))
                .map(b => ({ start: Math.max(b.startMin, windowStart), end: Math.min(b.endMin, windowEnd) }))
                .sort((a, b) => a.start - b.start);
            const gaps = [];
            let cursor = windowStart;
            for (const occ of occupied) {
                if (occ.start > cursor) gaps.push({ start: cursor, end: occ.start });
                cursor = Math.max(cursor, occ.end);
            }
            if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
            return gaps.filter(g => g.end - g.start >= 5);
        }

       function findBestGapPosition(bunk, windowStart, windowEnd, duration, blockType, specialName) {
            const gaps = getFreeGaps(bunk, windowStart, windowEnd);
            let bestPos = null;
            let bestScore = Infinity;
 
            for (const gap of gaps) {
                if (gap.end - gap.start < duration) continue;
 
                const latestStart = gap.end - duration;
                for (let cs = gap.start; cs <= latestStart; cs += 5) {
                    const ce = cs + duration;
                    const score = scorePositionByContention(cs, ce, blockType, bunk, specialName);
 
                    if (score < bestScore) {
                        bestScore = score;
                        bestPos = { start: cs, end: ce };
                    }
                }
            }
 
            // ★ FIX: sanity check — never return a position outside the requested window
            if (bestPos && (bestPos.start < windowStart || bestPos.end > windowEnd)) {
                warn('[findBestGapPosition] CORRECTING out-of-window result: ' +
                    bestPos.start + '-' + bestPos.end + ' (window=' + windowStart + '-' + windowEnd + ')');
                bestPos = null;
            }
            return bestPos;
        }

        function findFlexGapPosition(bunk, windowStart, windowEnd, minDuration) {
            const floor = minDuration || 5;
            const gaps = getFreeGaps(bunk, windowStart, windowEnd);
            let best = null;
            for (const gap of gaps) {
                const snappedStart = Math.ceil(gap.start / 5) * 5;
                const snappedEnd   = Math.floor(gap.end   / 5) * 5;
                if (snappedEnd - snappedStart < floor) continue;
                if (!best || (snappedEnd - snappedStart) > (best.end - best.start)) {
                    best = { start: snappedStart, end: snappedEnd };
                }
            }
            return best;
        }

      function placeTentativeBlock(bunk, block) {
            // ★ FIX: clamp blocks to grade day boundaries
            const grade = block.layer?.grade || block.layer?.division;
            if (grade && divisions[grade]) {
                const dStart = parseTimeToMinutes(divisions[grade].startTime) || 540;
                const dEnd   = parseTimeToMinutes(divisions[grade].endTime)   || 960;
                // Completely outside — reject
                if (block.endMin <= dStart || block.startMin >= dEnd) {
                    warn('[placeTentativeBlock] REJECTED ' + block.event + ' ' +
                        block.startMin + '-' + block.endMin + ' for ' + bunk +
                        ' (day=' + dStart + '-' + dEnd + ')');
                    return;
                }
                // Partially outside — clamp
                if (block.startMin < dStart) {
                    warn('[placeTentativeBlock] CLAMPED start ' + block.startMin + '→' + dStart + ' for ' + block.event + ' on ' + bunk);
                    block.startMin = dStart;
                }
                if (block.endMin > dEnd) {
                    warn('[placeTentativeBlock] CLAMPED end ' + block.endMin + '→' + dEnd + ' for ' + block.event + ' on ' + bunk);
                    block.endMin = dEnd;
                }
            }
            bunkTimelines[bunk].push(block);
            bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
        }

        function removeTentativeBlock(bunk, block) {
            const idx = bunkTimelines[bunk].indexOf(block);
            if (idx !== -1) bunkTimelines[bunk].splice(idx, 1);
        }

        function getNextSpecial(bunk, excludeNames, winStart, winEnd) {
            const queue = bunkSpecialQueues[bunk] || [];
            for (const candidate of queue) {
                if (excludeNames && excludeNames.has(candidate.name)) continue;
                const tracker = specialCapacityTracker[candidate.name];
                if (!tracker) continue;
                const alreadyAssigned = (bunkSpecialAssigned[bunk] && bunkSpecialAssigned[bunk][candidate.name]) || 0;
                if (alreadyAssigned > 0) continue;
                if (candidate.maxUsage && candidate.maxUsage > 0) {
                    const periodCount = getPeriodCount(bunk, candidate.name, candidate.maxUsagePeriod || 'half');
                    if (periodCount >= candidate.maxUsage) continue;
                }
                return candidate;
            }
            return null;
        }

        function claimSpecial(bunk, specialEntry, startMin, endMin) {
            const tracker = specialCapacityTracker[specialEntry.name];
            if (tracker) tracker.assignments.push({ bunk, startMin, endMin });
            if (!bunkSpecialAssigned[bunk]) bunkSpecialAssigned[bunk] = {};
            bunkSpecialAssigned[bunk][specialEntry.name] = (bunkSpecialAssigned[bunk][specialEntry.name] || 0) + 1;
        }

        function unclaimSpecial(bunk, specialName) {
            const tracker = specialCapacityTracker[specialName];
            if (tracker) {
                const idx = tracker.assignments.findIndex(a => a.bunk === bunk);
                if (idx !== -1) tracker.assignments.splice(idx, 1);
            }
            if (bunkSpecialAssigned[bunk] && bunkSpecialAssigned[bunk][specialName]) {
                bunkSpecialAssigned[bunk][specialName]--;
                if (bunkSpecialAssigned[bunk][specialName] <= 0) {
                    delete bunkSpecialAssigned[bunk][specialName];
                }
            }
        }

        function getTypeCapacity(type) {
            const cfg = (globalSettings.app1?.activityCapacity || {})[type];
            return cfg || 9999;
        }

        function claimActivitySlot(type, bunk, startMin, endMin) {
            if (!activityCapacityTracker[type]) {
                activityCapacityTracker[type] = { total: getTypeCapacity(type), assignments: [] };
            }
            activityCapacityTracker[type].assignments.push({ bunk, startMin, endMin });
        }

        function hasActivityCapacity(type, startMin, endMin) {
            const tracker = activityCapacityTracker[type];
            if (!tracker) return true;
            const overlapping = tracker.assignments.filter(a =>
                a.startMin < endMin && a.endMin > startMin
            ).length;
            return overlapping < tracker.total;
        }

        function willHaveCapacityLater(type, afterMin, windowEnd, duration) {
            const tracker = activityCapacityTracker[type];
            if (!tracker) return true;
            for (let t = afterMin; t + duration <= windowEnd; t += 5) {
                const overlapping = tracker.assignments.filter(a =>
                    a.startMin < t + duration && a.endMin > t
                ).length;
                if (overlapping < tracker.total) return true;
            }
            return false;
        }

       const GAP_MIN_DUR     = 20;
        const GAP_MAX_DUR     = 60;
        const GAP_ABSORB_TAIL = 15;

        function getGapCapForGrade(grade, gapStart, gapEnd) {
            const gradeLayers = layersByGrade[grade] || [];
            const mid = (gapStart + gapEnd) / 2;
            let cap = GAP_MAX_DUR;
            gradeLayers.forEach(layer => {
                const s = layer.startMin ?? 0;
                const e = layer.endMin   ?? 9999;
                if (s <= mid && e >= mid) {
                    const lCap = layer.durationMax || layer.periodMin || layer.duration || GAP_MAX_DUR;
                    cap = Math.min(cap, lCap);
                }
            });
            return Math.max(cap, GAP_MIN_DUR);
        }

       // ── Field contention helpers ────────────────────────────────────
        const FIELD_CAPACITY = 26;   // approx concurrent sport-field slots
        const CONTENTION_SLICE = 10; // minutes per evaluation slice
 
        // Check if a special activity lives on a physical field.
        // If its location matches a known field in activityProperties,
        // it consumes a field even though it's typed as 'special'.
        function isSpecialOnField(blockOrName) {
            // Accept either a timeline block object or a special name string
            const loc = typeof blockOrName === 'string'
                ? getLocationForSpecial(blockOrName, activityProperties, globalSettings)
                : (blockOrName._specialLocation || null);
 
            if (!loc) return false;
 
            // Check if this location is a known field
            const props = activityProperties[loc];
            if (props && props.type === 'field') return true;
 
            // Also check if it appears in the fields list directly
            const fields = globalSettings?.app1?.fields || [];
            return fields.some(f => f.name === loc);
        }
 
        // Classify a timeline block as field-consumer or field-reliever.
        // Returns 'consumer', 'reliever', or 'neutral'.
        function getFieldImpact(block) {
            const t = (block.type || '').toLowerCase();
 
            // Explicit field consumers
            if (t === 'sport' || t === 'sports' || t === 'slot' ||
                t === 'league' || t === 'specialty_league') {
                return 'consumer';
            }
 
            // Swim always relieves fields
            if (t === 'swim') return 'reliever';
 
            // Specials: depends on whether they occupy a physical field
            if (t === 'special') {
                return isSpecialOnField(block) ? 'consumer' : 'reliever';
            }
 
            // Everything else (lunch, snacks, dismissal, change, pinned)
            // is neutral — bunk isn't using a field but isn't "relieving" either
            return 'neutral';
        }
 
        // Classify a block TYPE + optional special name for scoring during
        // placement (before the block exists in the timeline).
        // Used by scorePositionByContention.
        function getPlacementImpact(blockType, specialName) {
            const t = (blockType || '').toLowerCase();
 
            if (t === 'sport' || t === 'sports' || t === 'slot' ||
                t === 'league' || t === 'specialty_league') {
                return 'consumer';
            }
 
            if (t === 'swim') return 'reliever';
 
            if (t === 'special') {
                if (specialName && isSpecialOnField(specialName)) return 'consumer';
                return 'reliever';
            }
 
            return 'neutral';
        }
 
        // Count bunks with field-consuming blocks in a time window.
        // Higher number = more field pressure.
        function getFieldDemand(startMin, endMin, excludeBunk) {
            let peakDemand = 0;
 
            for (let t = startMin; t < endMin; t += CONTENTION_SLICE) {
                const sliceEnd = Math.min(t + CONTENTION_SLICE, endMin);
                let demandThisSlice = 0;
 
                for (const grade of allGrades) {
                    const bunks = getBunksForGrade(grade, divisions);
                    for (const bk of bunks) {
                        if (bk === excludeBunk) continue;
                        const timeline = bunkTimelines[bk] || [];
                        for (const block of timeline) {
                            if (getFieldImpact(block) !== 'consumer') continue;
                            if (block.startMin < sliceEnd && block.endMin > t) {
                                demandThisSlice++;
                                break; // one block per bunk per slice
                            }
                        }
                    }
                }
 
                if (demandThisSlice > peakDemand) peakDemand = demandThisSlice;
            }
 
            return peakDemand;
        }
 
        // Score a candidate position for placement.
        // For CONSUMERS: lower demand = better = lower score.
        // For RELIEVERS: higher demand = better = lower score (inverted).
        // For NEUTRAL: return 0 (no preference).
        // Returns a number where LOWER = better placement.
        function scorePositionByContention(startMin, endMin, blockType, excludeBunk, specialName) {
            const impact = getPlacementImpact(blockType, specialName);
            if (impact === 'neutral') return 0;
 
            const demand = getFieldDemand(startMin, endMin, excludeBunk);
 
            if (impact === 'reliever') {
                // Relievers WANT high demand — invert so high demand = low score
                return -demand;
            } else {
                // Consumers WANT low demand — direct mapping
                return demand;
            }
        }
        do { // ← ITERATION LOOP START — wraps Steps 2.1 through 2.5b

        // Shared live capacity tracker (global across camp)
        // Structure: { specialName: { remaining: N, assignedTo: { bunkName: count } } }
       
        todaysSpecials.forEach(s => {
            specialCapacityTracker[s.name] = {
                total: getSpecialCapacity(s.name, activityProperties, globalSettings),
                // assignments: array of {bunk, startMin, endMin} for overlap checking
                assignments: []
            };
        });

        

       

        // Initialize bunk timelines and assigned trackers
        allGrades.forEach(grade => {
            const bunks = getBunksForGrade(grade, divisions);
            bunks.forEach(bunk => {
                bunkTimelines[bunk] = [];
                bunkSpecialAssigned[bunk] = {};
            });
        });

        // -----------------------------------------------------------------
        // STEP 2.1 — PLACE PINNED LAYERS
        // -----------------------------------------------------------------
        log('\n[STEP 2.1] Placing pinned layers...');
        let pinnedCount = 0;

      pinnedLayers.forEach(layer => {
            const grade = layer.grade || layer.division;
            const bunks = getBunksForGrade(grade, divisions);
            if (!bunks.length) return;
            if (allowedSet && !allowedSet.has(String(grade))) return;

            bunks.forEach(bunk => {
                bunkTimelines[bunk].push({
                    startMin: layer.startMin,
                    endMin: layer.endMin,
                    type: layer.type || 'pinned',
                    event: layer.event || layer.name || layer.type || 'Pinned',
                    layer,
                    _classification: 'pinned',
                    _committed: true,
                    _bunkOverride: true,
                    _fixed: true
                });
                pinnedCount++;
            });
        });

        // Sort each bunk's timeline by startMin after placing pinned
        allGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
            });
        });

        log('[STEP 2.1] ✅ Placed ' + pinnedCount + ' pinned blocks across camp');
// -----------------------------------------------------------------
        
        // -----------------------------------------------------------------
        // STEP 2.2a — QUERY ROTATION ENGINE FOR RANKED SPECIALS PER BUNK
        // -----------------------------------------------------------------
        log('\n[STEP 2.2a] Querying RotationEngine for special rankings...');

        // Find which grades have at least one special layer
        const gradesWithSpecials = new Set(
            [...windowedLayers, ...openLayers]
                .filter(l => l.type === 'special')
                .map(l => l.grade || l.division)
        );

        allGrades.forEach(grade => {
            if (!gradesWithSpecials.has(grade)) return;
            const bunks = getBunksForGrade(grade, divisions);

            bunks.forEach(bunk => {
                // Get rotation scores for all today's specials from RotationEngine
                const ranked = [];

                todaysSpecials.forEach(s => {
                    let score = 0;
                    const scarce = isScarce(s.name, dayName, globalSettings);
                   const specialLayer = [...windowedLayers, ...openLayers].find(l => l.type === 'special' && (l.grade || l.division) === grade);
const duration = getSpecialDuration(s.name, activityProperties, globalSettings, specialLayer);

                    if (!duration || duration <= 0) {
                        warn('[STEP 2.2a] ' + s.name + ' has no resolvable duration — skipping');
                        return;
                    }

                    if (window.RotationEngine && window.RotationEngine.calculateRotationScore) {
                        score = window.RotationEngine.calculateRotationScore({
                            bunkName: bunk,
                            activityName: s.name,
                            divisionName: grade,
                            beforeSlotIndex: 0,
                            allActivities: null,
                            activityProperties
                        });
                    }

                    // RotationEngine Infinity means "all-time limit hit" per the engine's own records.
                    // We do NOT use this as a hard exclusion — the engine doesn't know about
                    // maxUsagePeriod (resets). Our period-aware check below is the real gate.
                    // Clamp to a high-but-finite score so it sorts to the bottom of the queue
                    // but stays available if the period has reset.
                    if (score === Infinity) score = 99999;

                    // ★ maxUsage check — period-aware
                    // Uses maxUsagePeriod from the special's config to determine
                    // the relevant window: 'half' | '1week' | '2weeks' | '3weeks' | '4weeks'
                    const props = activityProperties[s.name] || s || {};
                    const maxUsage = parseInt(props.maxUsage) || 0;
                    const maxUsagePeriod = props.maxUsagePeriod || 'half';

                    if (maxUsage > 0) {
                        const periodCount = getPeriodCount(bunk, s.name, maxUsagePeriod);
                        if (periodCount >= maxUsage) {
                            log('[STEP 2.2a] ' + bunk + ' at limit (' + periodCount + '/' + maxUsage +
                                ' ' + maxUsagePeriod + ') for "' + s.name + '" — excluded from queue');
                            return;
                        }
                    }

                    ranked.push({
                        name: s.name,
                        score,
                        duration,
                        isScarce: scarce,
                        capacity: getSpecialCapacity(s.name, activityProperties, globalSettings),
                        location: getLocationForSpecial(s.name, activityProperties, globalSettings),
                        maxUsage,
                        maxUsagePeriod
                    });
                });

                // Sort: scarce first (they must be scheduled today), then by score (lower = better)
                ranked.sort((a, b) => {
                    if (a.isScarce !== b.isScarce) return a.isScarce ? -1 : 1;
                    return a.score - b.score;
                });

                bunkSpecialQueues[bunk] = ranked;
            });
        });

        log('[STEP 2.2a] ✅ Special rankings built for ' +
            Object.keys(bunkSpecialQueues).length + ' bunks');

        // -----------------------------------------------------------------
        // STEP 2.2b — MINI SPECIAL SOLVER (draft order, scarce-first)
        // -----------------------------------------------------------------
        log('\n[STEP 2.2b] Mini special solver — building draft order...');

        // The mini solver does NOT finalize how many specials each bunk gets
        // (that depends on how the day fills). It ensures:
        //   1. Scarce specials are assigned before regular ones
        //   2. Each bunk has a ranked queue with confirmed picks at top and fallbacks below
        //   3. A shared live capacity tracker is ready for Step 2.3

        // Process scarce specials first — most constrained
        // Find all bunks that need specials, sorted most constrained first (fewest options)
        const bunksNeedingSpecials = allGrades.flatMap(grade => getBunksForGrade(grade, divisions))
            .filter(bunk => bunkSpecialQueues[bunk] && bunkSpecialQueues[bunk].length > 0);

        const bunksSortedByConstraint = [...bunksNeedingSpecials].sort((a, b) => {
            const aQueue = bunkSpecialQueues[a] || [];
            const bQueue = bunkSpecialQueues[b] || [];
            // Fewer options = more constrained = goes first
            return aQueue.length - bQueue.length;
        });

        // Validate scarce specials are reachable — warn if capacity < bunks wanting it
        scarceSpecials.forEach(s => {
            const tracker = specialCapacityTracker[s.name];
            if (!tracker) return;
            const wantingCount = bunksNeedingSpecials.filter(bunk =>
                (bunkSpecialQueues[bunk] || []).some(r => r.name === s.name)
            ).length;
            if (wantingCount > tracker.total) {
                warn('[STEP 2.2b] Scarce special "' + s.name + '" wanted by ' +
                    wantingCount + ' bunks but capacity is ' + tracker.total);
            }
        });

        log('[STEP 2.2b] ✅ Draft order ready — ' + bunksSortedByConstraint.length +
            ' bunks in queue, ' + scarceSpecials.length + ' scarce specials protected');

        // -----------------------------------------------------------------
        // STEP 2.3 — UNIFIED SKELETON PLACEMENT ENGINE
        // -----------------------------------------------------------------
        log('\n[STEP 2.3] Unified skeleton placement engine...');
 
        // ── Build flexible type layers per grade ─────────────────────────
        // Collect what each grade needs (excluding pinned)
        const nonPinnedLayers = [...windowedLayers, ...openLayers];
 
        const gradeFlexTypes = {}; // grade → array of distinct type strings
        allGrades.forEach(grade => {
            const types = new Set();
            nonPinnedLayers.forEach(l => {
                if ((l.grade || l.division) !== grade) return;
                types.add((l.type || '').toLowerCase());
            });
            gradeFlexTypes[grade] = [...types];
        });
 
        // ── Generate skeleton per grade (shuffled by _iterSeed) ──────────
        // The skeleton is a TYPE SEQUENCE that defines preferred placement
        // order. Different iterations try different orderings.
        function generateSkeleton(grade, seed) {
            const types = [...(gradeFlexTypes[grade] || [])];
            if (types.length === 0) return [];
 
            // Fisher-Yates shuffle seeded by grade index + iteration seed
            const gradeIdx = allGrades.indexOf(grade);
            let s = ((seed + 1) * (gradeIdx + 1) * 2654435761) >>> 0; // hash
            function rand() {
                s ^= s << 13; s ^= s >> 17; s ^= s << 5;
                return (s >>> 0) / 4294967296;
            }
 
            for (let i = types.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                [types[i], types[j]] = [types[j], types[i]];
            }
 
            return types;
        }
 
        const gradeSortedForPlacement = sortGradesByConstraint(
            allGrades, layersByGrade, bunkSpecialQueues
        );
 
        // ── Build needs list per bunk ────────────────────────────────────
        gradeSortedForPlacement.forEach(grade => {
            const bunks = getBunksForGrade(grade, divisions);
            const gradeLayers = nonPinnedLayers.filter(l =>
                (l.grade || l.division) === grade
            );
            gradeLayers.sort((a, b) => b._ratio - a._ratio);
            bunks.forEach(bunk => {
                bunkNeeds[bunk] = gradeLayers.map(layer => ({
                    layer,
                    placed: 0,
                    required: layer.qty != null ? layer.qty : (layer.quantity != null ? layer.quantity : 1),
                    op: layer.op || layer.operator || '='
                }));
            });
        });
 
        // ── Skeleton generation ──────────────────────────────────────────
        const gradeSkeletons = {};
        gradeSortedForPlacement.forEach(grade => {
            gradeSkeletons[grade] = generateSkeleton(grade, _iterSeed);
        });
 
        log('[STEP 2.3] Skeletons: ' + gradeSortedForPlacement.map(g =>
            g + '→[' + gradeSkeletons[g].join(',') + ']').join(' | '));
 
        // ── Shuffle grade processing order by seed ───────────────────────
        const gradeOrder = [...gradeSortedForPlacement];
        {
            let s = ((_iterSeed + 7) * 2246822519) >>> 0;
            function rand2() {
                s ^= s << 13; s ^= s >> 17; s ^= s << 5;
                return (s >>> 0) / 4294967296;
            }
            for (let i = gradeOrder.length - 1; i > 0; i--) {
                const j = Math.floor(rand2() * (i + 1));
                [gradeOrder[i], gradeOrder[j]] = [gradeOrder[j], gradeOrder[i]];
            }
        }
 
        // ── League pre-processing ────────────────────────────────────────
        // Build league → grades map so shared leagues get the same time
        const gradeToLeagueName = {};
        const leagueLayersMap = {}; // grade → league layer
        nonPinnedLayers.forEach(layer => {
            const t = (layer.type || '').toLowerCase();
            if (t !== 'league' && t !== 'specialty_league') return;
            const grade = layer.grade || layer.division;
            leagueLayersMap[grade] = layer;
            const league = (Array.isArray(window.masterLeagues)
                ? window.masterLeagues
                : Object.values(window.masterLeagues || {})).find(l =>
                (l.divisions || []).includes(grade)
            );
            if (league) gradeToLeagueName[grade] = league.name;
        });
 
        // ── Helper: find best time for league (all bunks free, scored) ───
        function placeLeagueForGrade(grade, layer) {
            const bunks = getBunksForGrade(grade, divisions);
            const dur = layer.periodMin || layer.durationMin || layer.duration || 30;
            const windowStart = layer.startMin;
            const windowEnd = layer.endMin;
            const lType = (layer.type || '').toLowerCase();
            const leagueName = gradeToLeagueName[grade];
 
            // If shared league already placed by another grade, use that time
            if (leagueName && sharedLeagueTime[leagueName] != null) {
                const sharedStart = sharedLeagueTime[leagueName];
                const sharedEnd = sharedStart + dur;
                bunks.forEach(bunk => {
                    bunkTimelines[bunk].push({
                        startMin: sharedStart, endMin: sharedEnd,
                        type: lType, event: layer.event || 'League Game',
                        layer, _classification: 'windowed', _committed: true
                    });
                    bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
                });
                return sharedStart;
            }
 
            // Find all valid positions, score by contention
            let bestStart = null;
            let bestScore = Infinity;
 
            for (let ts = windowStart; ts + dur <= windowEnd; ts += 5) {
                const te = ts + dur;
                const allFree = bunks.every(bunk =>
                    !(bunkTimelines[bunk] || []).some(b => b.startMin < te && b.endMin > ts)
                );
                if (!allFree) continue;
 
                // Score: league is a field consumer
                const score = scorePositionByContention(ts, te, 'league', null, null);
                if (score < bestScore) {
                    bestScore = score;
                    bestStart = ts;
                }
            }
 
            if (bestStart === null) {
                warn('[STEP 2.3] No shared free gap for league in ' + grade);
                return null;
            }
 
            const placedEnd = bestStart + dur;
            bunks.forEach(bunk => {
                bunkTimelines[bunk].push({
                    startMin: bestStart, endMin: placedEnd,
                    type: lType, event: layer.event || 'League Game',
                    layer, _classification: 'windowed', _committed: true
                });
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
            });
 
            if (leagueName) sharedLeagueTime[leagueName] = bestStart;
            log('[STEP 2.3] ' + grade + ': league at ' +
                Math.floor(bestStart / 60) + ':' + String(bestStart % 60).padStart(2, '0') +
                ' (' + dur + 'min) — contention score ' + bestScore);
            return bestStart;
        }
 
        // ── Helper: find best swim position for a single bunk ────────────
      function placeSwimForBunk(bunk, layer) {
            const dur = layer.periodMin || layer.durationMin || layer.duration || 45;
            // ★ FIX: clamp to grade day boundaries (mirrors Step 2.3 swim logic)
            const grade = layer.grade || layer.division;
            const dStart = parseTimeToMinutes(divisions[grade]?.startTime) || 660;
            const dEnd   = parseTimeToMinutes(divisions[grade]?.endTime)   || 990;
            const windowStart = Math.max(layer.startMin || 0, dStart);
            const windowEnd   = Math.min(layer.endMin || 990, dEnd);
 
            return findBestGapPosition(bunk, windowStart, windowEnd, dur, 'swim', null);
        }
 
        // ── Helper: place a special for a bunk ───────────────────────────
        function placeSpecialForBunk(bunk, grade, layer, windowStart, windowEnd) {
            const usedExclusions = new Set(Object.keys(bunkSpecialAssigned[bunk] || {}));
            const gradeBunks = getBunksForGrade(grade, divisions).map(String);
 
            const candidate = getNextSpecial(bunk, usedExclusions, windowStart, windowEnd);
            if (!candidate) return null;
 
            const cfg = getSpecialConfig(candidate.name, globalSettings);
            const sharableType = cfg?.sharableWith?.type || 'not_sharable';
            const tracker2 = specialCapacityTracker[candidate.name];
 
            let position = null;
 
            // Try joining existing session
            if (sharableType === 'same_division' || sharableType === 'all' ||
                (sharableType === 'custom' && cfg?.sharableWith?.divisions?.length > 0)) {
                const existingSession = (tracker2?.assignments || []).find(a => {
                    if (sharableType === 'same_division') {
                        if (!gradeBunks.includes(String(a.bunk))) return false;
                    }
                    const gaps = getFreeGaps(bunk, a.startMin, a.endMin);
                    return gaps.some(g => g.start <= a.startMin && g.end >= a.endMin);
                });
                if (existingSession) {
                    position = { start: existingSession.startMin, end: existingSession.endMin };
                }
            }
 
            // Find fresh gap with contention scoring
            if (!position) {
                position = candidate.duration
                    ? (findBestGapPosition(bunk, windowStart, windowEnd, candidate.duration, 'special', candidate.name) ||
                       findBestGapPosition(bunk, layer.startMin, layer.endMin, candidate.duration, 'special', candidate.name))
                    : findFlexGapPosition(bunk, windowStart, windowEnd);
 
                if (position) {
                    const snapped = snapTo5(position.start);
                    const dur = position.end - position.start;
                    position = { start: snapped, end: snapped + dur };
                }
 
                // Cross-grade conflict check
                if (position && sharableType !== 'all') {
                    const crossGradeConflict = (tracker2?.assignments || []).some(a => {
                        if (gradeBunks.includes(String(a.bunk))) return false;
                        return a.startMin < position.end && a.endMin > position.start;
                    });
                    if (crossGradeConflict) position = null;
                }
            }
 
            if (!position) return null;
 
            // Capacity check
            const tracker = specialCapacityTracker[candidate.name];
            const overlappingNow = tracker ? tracker.assignments.filter(a =>
                a.startMin < position.end && a.endMin > position.start
            ).length : 0;
 
            if (tracker && overlappingNow >= tracker.total) return null;
 
            // Commit
            claimSpecial(bunk, candidate, position.start, position.end);
            return {
                startMin: position.start,
                endMin: position.end,
                type: 'special',
                event: candidate.name,
                layer,
                _classification: layer._classification,
                _assignedSpecial: candidate.name,
                _specialDuration: candidate.duration,
                _specialLocation: candidate.location,
                _activityLocked: true,
                _bunkOverride: true
            };
        }
 
        // ── Helper: place a sport/slot block for a bunk ──────────────────
        function placeSportForBunk(bunk, layer, windowStart, windowEnd) {
            const type = layer.type;
            const event = layer.event || layer.name || layer.type || 'Activity';
            const dMin = layer.durationMin || layer.periodMin || layer.duration || GAP_MIN_DUR;
            const dMax = layer.durationMax || layer.periodMin || layer.duration || GAP_MAX_DUR;

            // ★ FIX: Intersect free window with layer's own time window
            // Without this, open/windowed layers get placed in any free gap
            // regardless of where the user defined them (e.g. snacks at 2-3pm
            // placed at 11:45am because there's a gap after swim).
            const layerWinStart = layer.startMin;
            const layerWinEnd   = layer.endMin;
            if (layerWinStart != null && layerWinEnd != null) {
                windowStart = Math.max(windowStart, layerWinStart);
                windowEnd   = Math.min(windowEnd, layerWinEnd);
                if (windowStart >= windowEnd) return null; // no overlap
            }

            // Find best gap with contention scoring
            const position = findBestGapPosition(bunk, windowStart, windowEnd, dMin, type, null);

            if (!position) return null;
 
            // Size the block: take up to dMax or available space
            const gapEnd = (() => {
                const gaps = getFreeGaps(bunk, position.start, windowEnd);
                const gap = gaps.find(g => g.start <= position.start && g.end > position.start);
                return gap ? gap.end : position.end;
            })();
 
            const availableSpace = gapEnd - position.start;
            const targetDur = snapTo5(Math.max(dMin, Math.min(dMax, availableSpace)));
 
            if (!hasActivityCapacity(type, position.start, position.start + targetDur)) {
                return null;
            }
 
            claimActivitySlot(type, bunk, position.start, position.start + targetDur);
 
            const _isTimeLocked = ['swim', 'snacks', 'lunch', 'dismissal'].includes(type);
            return {
                startMin: position.start,
                endMin: position.start + targetDur,
                type, event, layer,
                _classification: layer._classification,
                _activityLocked: _isTimeLocked
            };
        }
 
        // ═════════════════════════════════════════════════════════════════
        // MAIN PLACEMENT LOOP — Cross-grade interleaved by type
        // ★ Process type-by-type across all grades so the contention scorer
        //   sees each grade's relievers (swim) before the next grade places
        //   theirs. This naturally staggers swim/specials across the day.
        // ═════════════════════════════════════════════════════════════════

        // Collect all unique skeleton types across all grades
        const _allTypes = new Set();
        for (const _g of gradeOrder) { (gradeSkeletons[_g] || []).forEach(t => _allTypes.add(t)); }

        // Order: relievers first (swim), then leagues, then specials, then consumers (sport)
        const _typeOrder = ['swim', 'league', 'specialty_league', 'special', 'sport', 'sports', 'slot'];
        const _sortedTypes = [..._allTypes].sort((a, b) => {
            const ai = _typeOrder.indexOf(a.toLowerCase());
            const bi = _typeOrder.indexOf(b.toLowerCase());
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

        log('[STEP 2.3] Interleaved type order: [' + _sortedTypes.join(', ') + ']');

        // ── Phase 1: Place each type across all grades ───────────────────
        for (const skeletonType of _sortedTypes) {
            const typeLC = skeletonType.toLowerCase();

            for (const grade of gradeOrder) {
                // Skip if this grade doesn't have this type in its skeleton
                if (!(gradeSkeletons[grade] || []).includes(skeletonType)) continue;

                const bunks = getBunksForGrade(grade, divisions);
                const divStart = parseTimeToMinutes(divisions[grade]?.startTime) || 660;
                const rawDivEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 990;
                const lastPinned = (bunkTimelines[bunks[0]] || [])
                    .filter(b => b._classification === 'pinned')
                    .sort((a, b) => b.startMin - a.startMin)[0];
                const divEnd = (lastPinned && lastPinned.startMin < rawDivEnd) ? lastPinned.startMin : rawDivEnd;

                // ── LEAGUE: grade-wide simultaneous ──────────────────────
                if (typeLC === 'league' || typeLC === 'specialty_league') {
                    const leagueLayer = leagueLayersMap[grade];
                    if (leagueLayer) {
                        const leagueStart = placeLeagueForGrade(grade, leagueLayer);
                        if (leagueStart != null) {
                            for (const bk of bunks) {
                                const ln = (bunkNeeds[bk] || []).find(n =>
                                    (n.layer.type || '').toLowerCase() === typeLC
                                );
                                if (ln) ln.placed = ln.required;
                            }
                        }
                    }
                    continue;
                }

                // ── SWIM: per-bunk staggered, contention-scored ──────────
                if (typeLC === 'swim') {
                    const swimLayer = nonPinnedLayers.find(l =>
                        (l.grade || l.division) === grade &&
                        (l.type || '').toLowerCase() === 'swim'
                    );
                    if (!swimLayer) continue;

                    // ★ Clamp swim window to grade day boundaries
                    const swimWindowStart = Math.max(swimLayer.startMin || 0, divStart);
                    const swimWindowEnd = Math.min(swimLayer.endMin || 990, divEnd);

                    const sortedBunks = [...bunks].sort((a, b) =>
                        (parseInt(String(a).replace(/\D/g, '')) || 0) -
                        (parseInt(String(b).replace(/\D/g, '')) || 0)
                    );

                    // ★ Clamp swim window to grade day boundaries
                    const swimDur = swimLayer.periodMin || swimLayer.durationMin || swimLayer.duration || 45;
                    const swimWinStart = Math.max(swimLayer.startMin || 0, divStart);
                    const swimWinEnd = Math.min(swimLayer.endMin || 990, divEnd);

                   
                       for (const bunk of sortedBunks) {
                        const position = findBestGapPosition(bunk, swimWinStart, swimWinEnd, swimDur, 'swim', null);
                        if (totalIters < 2) log('[SWIM-DBG] bunk=' + bunk + ' window=' + swimWinStart + '-' + swimWinEnd + ' dur=' + swimDur + ' → position=' + (position ? position.start + '-' + position.end : 'null'));
                        if (position) {
                            var _preCount = bunkTimelines[bunk].length;
                           var _swimBlock = {
                                startMin: position.start,
                                endMin: position.end,
                                type: 'swim',
                                event: swimLayer.event || 'Swim',
                                layer: swimLayer,
                                _classification: 'pinned',
                                _activityLocked: true,
                                _fixed: true,
                                _committed: true
                            };
                            var _swimAdded = placeTentativeBlock(bunk, _swimBlock);
                            if (totalIters < 2) log('[SWIM-DBG] bunk=' + bunk + ' added=' + _swimAdded + ' timeline=' + _preCount + '→' + bunkTimelines[bunk].length + ' inArray=' + bunkTimelines[bunk].includes(_swimBlock));

                            if (_swimAdded !== false) {
                                const swimNeed = (bunkNeeds[bunk] || []).find(n =>
                                    (n.layer.type || '').toLowerCase() === 'swim'
                                );
                                if (swimNeed) swimNeed.placed++;
                            }
                        }
                    }
                    continue;
                }

                // ── SPECIAL: per-bunk, capacity-aware, rotation-scored ───
                if (typeLC === 'special') {
                    const specialLayer = nonPinnedLayers.find(l =>
                        (l.grade || l.division) === grade && l.type === 'special'
                    );
                    if (!specialLayer) continue;

                    for (const bunk of bunks) {
                        const specialNeed = (bunkNeeds[bunk] || []).find(n =>
                            n.layer.type === 'special' && n.placed < n.required
                        );
                        if (!specialNeed) continue;

                        const committed = (bunkTimelines[bunk] || [])
                            .filter(b => b._committed || b._fixed)
                            .sort((a, b) => a.startMin - b.startMin);

                        let placed = false;
                        const freeWindows = [];
                        let cursor = divStart;
                        committed.forEach(b => {
                            if (b.startMin > cursor) freeWindows.push({ start: cursor, end: b.startMin });
                            cursor = Math.max(cursor, b.endMin);
                        });
                        if (cursor < divEnd) freeWindows.push({ start: cursor, end: divEnd });

                        for (const win of freeWindows) {
                            if (placed) break;
                            const block = placeSpecialForBunk(bunk, grade, specialLayer, win.start, win.end);
                            if (block) {
                                placeTentativeBlock(bunk, block);
                                specialNeed.placed++;
                                placed = true;
                            }
                        }
                    }
                    continue;
                }

                // ── SPORT / SLOT / OTHER: per-bunk, contention-scored ────
                {
                    const typeLayer = nonPinnedLayers.find(l =>
                        (l.grade || l.division) === grade &&
                        (l.type || '').toLowerCase() === typeLC
                    );
                    if (!typeLayer) continue;

                    for (const bunk of bunks) {
                        const need = (bunkNeeds[bunk] || []).find(n =>
                            (n.layer.type || '').toLowerCase() === typeLC && n.placed < n.required
                        );
                        if (!need) continue;

                        const committed = (bunkTimelines[bunk] || [])
                            .filter(b => b._committed || b._fixed || b._classification === 'pinned')
                            .sort((a, b) => a.startMin - b.startMin);

                        const tentative = (bunkTimelines[bunk] || [])
                            .filter(b => !b._committed && !b._fixed)
                            .sort((a, b) => a.startMin - b.startMin);

                        const allPlaced = [...committed, ...tentative].sort((a, b) => a.startMin - b.startMin);

                        const freeWindows = [];
                        let cursor = divStart;
                        allPlaced.forEach(b => {
                            if (b.startMin > cursor) freeWindows.push({ start: cursor, end: b.startMin });
                            cursor = Math.max(cursor, b.endMin);
                        });
                        if (cursor < divEnd) freeWindows.push({ start: cursor, end: divEnd });

                        for (const win of freeWindows) {
                            if (need.placed >= need.required) break;

                            const block = placeSportForBunk(bunk, need.layer, win.start, win.end);
                            if (block) {
                                placeTentativeBlock(bunk, block);
                                need.placed++;
                            }
                        }
                    }
                }
            }
        }

        // ── Phase 2: Fill remaining gaps per grade ───────────────────────
        // After all types are placed across all grades, backfill any bunk
        // with unmet needs in remaining free windows.
        for (const grade of gradeOrder) {
            const bunks = getBunksForGrade(grade, divisions);
            const divStart = parseTimeToMinutes(divisions[grade]?.startTime) || 660;
            const rawDivEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 990;
            const lastPinned = (bunkTimelines[bunks[0]] || [])
                .filter(b => b._classification === 'pinned')
                .sort((a, b) => b.startMin - a.startMin)[0];
            const divEnd = (lastPinned && lastPinned.startMin < rawDivEnd) ? lastPinned.startMin : rawDivEnd;

            for (const bunk of bunks) {
                const unmetNeeds = (bunkNeeds[bunk] || []).filter(n => {
                    if (n.op === '<=' || n.op === '≤') return false;
                    const t = (n.layer.type || '').toLowerCase();
                    if (t === 'league' || t === 'specialty_league') return false;
                    return n.placed < n.required;
                });

                for (const need of unmetNeeds) {
                    const typeLC = (need.layer.type || '').toLowerCase();

                    const allPlaced = (bunkTimelines[bunk] || []).sort((a, b) => a.startMin - b.startMin);
                    const freeWindows = [];
                    let cursor = divStart;
                    allPlaced.forEach(b => {
                        if (b.startMin > cursor) freeWindows.push({ start: cursor, end: b.startMin });
                        cursor = Math.max(cursor, b.endMin);
                    });
                    if (cursor < divEnd) freeWindows.push({ start: cursor, end: divEnd });

                    for (const win of freeWindows) {
                        if (need.placed >= need.required) break;

                        if (typeLC === 'special') {
                            const block = placeSpecialForBunk(bunk, grade, need.layer, win.start, win.end);
                            if (block) {
                                placeTentativeBlock(bunk, block);
                                need.placed++;
                            }
                        } else if (typeLC === 'swim') {
                            const position = placeSwimForBunk(bunk, need.layer);
                            if (position) {
                                placeTentativeBlock(bunk, {
                                    startMin: position.start, endMin: position.end,
                                    type: 'swim', event: need.layer.event || 'Swim',
                                    layer: need.layer, _classification: need.layer._classification,
                                    _activityLocked: true
                                });
                                need.placed++;
                            }
                        } else {
                            const block = placeSportForBunk(bunk, need.layer, win.start, win.end);
                            if (block) {
                                placeTentativeBlock(bunk, block);
                                need.placed++;
                            }
                        }
                    }
                }
            }
        }

        log('[STEP 2.3] ✅ Skeleton placement complete');
        // -----------------------------------------------------------------
        // STEP 2.4 — BACKTRACK AND RETRY
        // -----------------------------------------------------------------
        log('\n[STEP 2.4] Checking for placement failures and backtracking...');

        // Check each bunk for failed minimum quantity requirements
        let backtrackNeeded = false;
        const failedBunks = [];

        allGrades.forEach(grade => {
            const bunks = getBunksForGrade(grade, divisions);
            const gradeLayers = nonPinnedLayers.filter(l => {
    if ((l.grade || l.division) !== grade) return false;
    const t = (l.type || '').toLowerCase();
    return t !== 'league' && t !== 'specialty_league';
})

            bunks.forEach(bunk => {
                gradeLayers.forEach(layer => {
                    const required = layer.quantity || 1;
                    const op = layer.operator || '=';

                    // Count how many of this layer's type were placed for this bunk
                    const placed = bunkTimelines[bunk].filter(b =>
                        b.layer === layer && !b._committed
                    ).length;

                    const minRequired = (op === '<=' || op === '≤') ? 0 : required;

                    if (placed < minRequired) {
                        backtrackNeeded = true;
                        failedBunks.push({ bunk, grade, layer, placed, required: minRequired });
                    }
                });
            });
        });

        if (backtrackNeeded) {
            warn('[STEP 2.4] Backtrack needed for ' + failedBunks.length + ' failures');

            // Attempt resolution for each failed bunk
            failedBunks.forEach(({ bunk, grade, layer, placed, required }) => {
                warn('[STEP 2.4] Failed: ' + bunk + ' needs ' + required +
                    ' of "' + layer.event + '", got ' + placed);

                if (layer.type === 'special') {
                    // Try swapping special assignments with another bunk in the grade
                    const gradeBunks = getBunksForGrade(grade, divisions);
                    let resolved = false;

                    for (const otherBunk of gradeBunks) {
                        if (otherBunk === bunk) continue;

                        // Find a special assigned to otherBunk that bunk hasn't had
                        const otherSpecials = bunkTimelines[otherBunk].filter(
                            b => b.type === 'special' && !b._committed && !b._isScarce
                        );

                        for (const otherBlock of otherSpecials) {
                            const specialName = otherBlock._assignedSpecial;
                            if (bunkSpecialAssigned[bunk] && bunkSpecialAssigned[bunk][specialName]) continue;

                            // Try giving this special to bunk
                            const candidate = (bunkSpecialQueues[bunk] || []).find(r => r.name === specialName);
                            if (!candidate) continue;

                            const tracker = specialCapacityTracker[specialName];
                            if (!tracker || tracker.remaining <= 0) continue;

                            // Find a position in bunk's window
                            const position = findBestGapPosition(
        bunk, layer.startMin, layer.endMin, candidate.duration, 'special', candidate.name
     );
                            if (!position) continue;

                            // Swap — claim for bunk
                            claimSpecial(bunk, candidate);
                            placeTentativeBlock(bunk, {
                                startMin: position.start,
                                endMin: position.end,
                                type: 'special',
                                event: candidate.name,
                                layer,
                                _classification: layer._classification,
                                _assignedSpecial: candidate.name,
                                _specialDuration: candidate.duration,
                                _specialLocation: candidate.location,
                                _activityLocked: true,
                                _bunkOverride: true,
                                _isScarce: candidate.isScarce,
                                _committed: false
                            });

                            resolved = true;
                            log('[STEP 2.4] Resolved ' + bunk + ' via swap with ' + otherBunk +
                                ' for ' + specialName);
                            break;
                        }
                        if (resolved) break;
                    }

                    if (!resolved) {
                        warn('[STEP 2.4] Could not resolve ' + bunk + ' for "' +
                            layer.event + '" — flagging with warning');
                        warnings.push({
                            type: 'placement_failure',
                            bunk,
                            grade,
                            layer: layer.event,
                            message: 'Could not satisfy minimum quantity ' + required
                        });
                    }

                } else {
                    // Non-special: just flag it
                    warnings.push({
                        type: 'placement_failure',
                        bunk,
                        grade,
                        layer: layer.event,
                        message: 'Could not satisfy minimum quantity ' + required
                    });
                }
            });
        } else {
            log('[STEP 2.4] ✅ No backtracking needed');
        }

        // Commit all tentative blocks that passed
        allGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                bunkTimelines[bunk].forEach(b => { b._committed = true; });
            });
        });

       // -----------------------------------------------------------------
        // STEP 2.5 — GAP FILL
        // ★ FIX: subdivide large gaps + absorb micro-gaps instead of
        //   creating oversized or undersized slots
        // -----------------------------------------------------------------
        log('\n[STEP 2.5] Gap filling...');

        

       

        let gapsFilled = 0;

        allGrades.forEach(grade => {
            const gradeStart = parseTimeToMinutes(divisions[grade] && divisions[grade].startTime) || 540;
            const gradeEnd = parseTimeToMinutes(divisions[grade] && divisions[grade].endTime) || 960;
            const bunks = getBunksForGrade(grade, divisions);

            bunks.forEach(bunk => {
                const gaps = getFreeGaps(bunk, gradeStart, gradeEnd);
                gaps.forEach(gap => {
                    const gapDur = gap.end - gap.start;

                    // ★ Drop micro-gaps — too small to be a real activity
                    if (gapDur < GAP_MIN_DUR) {
                        log(`[STEP 2.5] Micro-gap dropped (${gapDur}min @ ${gap.start}) for ${bunk}`);
                        return;
                    }

                   const maxDur = getGapCapForGrade(grade, gap.start, gap.end);
                    // ★ Use sport layer durationMin as floor for gap chunks (not GAP_MIN_DUR)
                    const _gapGradeLayers = (layersByGrade[grade] || []);
                    const _gapSportLayer = _gapGradeLayers.find(l => l.type === 'sport');
                    const _gapFloor = _gapSportLayer ? (_gapSportLayer.durationMin || _gapSportLayer.periodMin || GAP_MIN_DUR) : GAP_MIN_DUR;
                    let cursor = gap.start;
                    const created = [];

                    // ★ Subdivide large gaps into capped chunks (smart packing)
                   while (cursor < gap.end) {
                        const remaining = gap.end - cursor;

                        // If remaining is below sport minimum, absorb into previous chunk
                        if (remaining < _gapFloor) {
                            if (created.length > 0) {
                                created[created.length - 1].endMin = gap.end;
                            }
                            break;
                        }

                        // ★ Smart packing: calculate ideal number of blocks
                        // so all blocks are between _gapFloor and maxDur
                        const minBlocks = Math.ceil(remaining / maxDur);
                        const maxBlocks = Math.floor(remaining / _gapFloor);
                        let slotDur;
                       if (maxBlocks >= minBlocks && minBlocks > 0) {
                            const useBlocks = minBlocks;
                            slotDur = Math.round(remaining / useBlocks);
                            slotDur = Math.max(_gapFloor, Math.min(maxDur, slotDur));
                            // ★ Snap to 5-minute increments (round down to avoid exceeding maxDur)
                            slotDur = Math.floor(slotDur / 5) * 5;
                            if (slotDur < _gapFloor) slotDur = _gapFloor;
                        } else {
                            slotDur = Math.min(maxDur, remaining);
                            slotDur = Math.floor(slotDur / 5) * 5;
                            if (slotDur < _gapFloor) slotDur = _gapFloor;
                        }

                        if (slotDur < _gapFloor) {
                            if (created.length > 0) {
                                created[created.length - 1].endMin = gap.end;
                            }
                            break;
                        }

                        created.push({                            startMin: cursor,
                            endMin:   cursor + slotDur,
                            type: 'slot',
                            event: 'General Activity Slot',
                            layer: null,
                            _classification: 'gap',
                            _fromGapDetection: true,
                            _committed: true
                        });
                        cursor += slotDur;
                    }

                    created.forEach(block => {
                        placeTentativeBlock(bunk, block);
                        gapsFilled++;
                    });

                    if (created.length > 1) {
                        log(`[STEP 2.5] Gap ${gap.start}-${gap.end} (${gapDur}min) → ${created.length} slots of ≤${maxDur}min for ${bunk}`);
                    }
                });
            });
        });

        log('[STEP 2.5] ✅ Filled ' + gapsFilled + ' gap slots across camp');
        log('[STEP 2.5] ✅ Filled ' + gapsFilled + ' gaps with General Activity Slot');

       // -----------------------------------------------------------------
        // STEP 2.5b — SEAM CLOSING
        // Walks every bunk's timeline and closes micro-gaps between adjacent
        // blocks. Priority order:
        //   1. Extend earlier block forward (if durationMax allows)
        //   2. Extend later block backward (if durationMax allows)
        //   3. Shift later block's startMin earlier (slides whole block, no duration change)
        //   4. If later block is fixed — replan all non-fixed blocks in the
        //      window between the last fixed block and this one, then re-run seam check
        // Repeats passes until no seams remain or MAX_PASSES hit.
        // -----------------------------------------------------------------
        log('\n[STEP 2.5b] Seam closing...');

       const SEAM_CLOSE_THRESHOLD = 30;
        let seamsClosed = 0;

        allGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const timeline = bunkTimelines[bunk];
                if (!timeline || timeline.length < 2) return;

                let passChanged = true;
                let passCount = 0;
                const MAX_PASSES = 20;

                while (passChanged && passCount < MAX_PASSES) {
                    passChanged = false;
                    passCount++;
                    timeline.sort((a, b) => a.startMin - b.startMin);

                    for (let i = 0; i < timeline.length - 1; i++) {
                        const curr = timeline[i];
                        const next = timeline[i + 1];
                        const gap = next.startMin - curr.endMin;

                       if (gap <= 0 || gap > SEAM_CLOSE_THRESHOLD) continue;

                        const currDur    = curr.endMin - curr.startMin;
                        const currMaxDur = curr.layer
                            ? (curr.layer.durationMax || curr.layer.periodMin || curr.layer.duration || Infinity)
                            : Infinity;

                        const nextDur    = next.endMin - next.startMin;
                        const nextMaxDur = next.layer
                            ? (next.layer.durationMax || next.layer.periodMin || next.layer.duration || Infinity)
                            : Infinity;

                        const nextIsFixed = next._fixed || next._classification === 'pinned';
                        const currIsFixed = curr._fixed || curr._classification === 'pinned';

                        // ★ Option 0: Both blocks are fixed/pinned — compact by sliding later block back
                        // Skip grade-wide simultaneous blocks (league, swim) — their times are shared across bunks
                        const _noSlideTypes = ['league', 'specialty_league', 'swim'];
                        const _nextTypeLC = (next.type || '').toLowerCase();
                        const _currTypeLC = (curr.type || '').toLowerCase();

                        if (currIsFixed && nextIsFixed &&
                            !_noSlideTypes.includes(_nextTypeLC) &&
                            !_noSlideTypes.includes(_currTypeLC)) {
                            log(`[STEP 2.5b] Pass ${passCount} — compact fixed: "${next.event}" ${next.startMin}→${curr.endMin} on ${bunk} (closing ${gap}min gap after "${curr.event}")`);
                            next.startMin = curr.endMin;
                            next.endMin   = curr.endMin + nextDur;
                            seamsClosed++;
                            passChanged = true;
                            continue;
                        }

                        // ★ Option 1: extend earlier block forward
                        if (currDur + gap <= currMaxDur) {                            const nextWindowMin = next.layer?.startMin ?? next.layer?.windowMin ?? next.startMin;
                            const shiftTarget = curr.endMin;

                            if (shiftTarget >= nextWindowMin) {
                                log(`[STEP 2.5b] Pass ${passCount} — FIXED↔FIXED shift: "${next.event}" ${next.startMin}→${shiftTarget} on ${bunk}`);
                                next.endMin   = shiftTarget + nextDur;
                                next.startMin = shiftTarget;
                                seamsClosed++;
                                passChanged = true;
                            } else {
                                // Can't shift next back — try extending curr forward within its window
                                const currWindowMax = curr.layer?.endMin ?? curr.layer?.windowMax ?? curr.endMin;
                                if (curr.endMin + gap <= currWindowMax) {
                                    log(`[STEP 2.5b] Pass ${passCount} — FIXED↔FIXED extend: "${curr.event}" endMin ${curr.endMin}→${next.startMin} on ${bunk}`);
                                    curr.endMin = next.startMin;
                                    seamsClosed++;
                                    passChanged = true;
                                }
                                // else: neither can move — gap remains
                            }
                            continue; // skip Options 1-4 entirely for FIXED↔FIXED pairs
                        }

                        // ★ Option 1: extend earlier block forward
                        if (currDur + gap <= currMaxDur) {                            log(`[STEP 2.5b] Pass ${passCount} — extend earlier: "${curr.event}" ${curr.endMin}→${next.startMin} on ${bunk}`);
                            curr.endMin = next.startMin;
                            seamsClosed++;
                            passChanged = true;

                        // ★ Option 2: extend later block backward (starts earlier, runs longer)
                        } else if (!nextIsFixed && nextDur + gap <= nextMaxDur) {
                            log(`[STEP 2.5b] Pass ${passCount} — extend later back: "${next.event}" ${next.startMin}→${curr.endMin} on ${bunk}`);
                            next.startMin = curr.endMin;
                            seamsClosed++;
                            passChanged = true;

                        // ★ Option 3: shift later block earlier (no duration change, may cascade)
                        } else if (!nextIsFixed) {
                            const nextMinDur = next.layer
                                ? (next.layer.durationMin || next.layer.periodMin || next.layer.duration || 0)
                                : 0;
                            const shiftedDur = nextDur - gap;
                            if (nextMinDur > 0 && shiftedDur < nextMinDur) {
                                // Shifting would violate durationMin — skip, leave gap
                                continue;
                            }
                            log(`[STEP 2.5b] Pass ${passCount} — shift earlier: "${next.event}" ${next.startMin}→${curr.endMin} on ${bunk}`);
                            next.startMin = curr.endMin;
                            next.endMin   = next.endMin - gap;
                            seamsClosed++;
                            passChanged = true;

                        // ★ Option 4: later block is fixed and immovable — replan the window
                        } else {
                            warn(`[STEP 2.5b] Pass ${passCount} — fixed block "${next.event}" at ${next.startMin} ` +
                                `on ${bunk} has ${gap}min unsealed gap before it — replanning window`);

                            // Find the window to replan: from the end of the last fixed block
                            // before curr, up to next.startMin
                            let windowStart = 0;
                            for (let j = i - 1; j >= 0; j--) {
                                if (timeline[j]._fixed || timeline[j]._classification === 'pinned') {
                                    windowStart = timeline[j].endMin;
                                    break;
                                }
                            }
                            const windowEnd = next.startMin;

                            // Pull out all non-fixed blocks in this window
                            const blocksToReplan = timeline.filter(b =>
                                b !== next &&
                                !b._fixed &&
                                b._classification !== 'pinned' &&
                                b.startMin >= windowStart &&
                                b.endMin <= windowEnd
                            );

                            if (blocksToReplan.length === 0) {
                                warn(`[STEP 2.5b] No replannable blocks in window ${windowStart}-${windowEnd} on ${bunk} — leaving gap`);
                                continue;
                            }

                            // Remove them all from the timeline
                            blocksToReplan.forEach(b => removeTentativeBlock(bunk, b));

                            // Re-pack them sequentially from windowStart, 
                            // respecting each block's duration exactly
                            let cursor = windowStart;
                            blocksToReplan.forEach(b => {
                                const dur = b.endMin - b.startMin;
                                b.startMin = cursor;
                                b.endMin   = cursor + dur;
                                placeTentativeBlock(bunk, b);
                                cursor = b.endMin;
                            });

                            log(`[STEP 2.5b] Replanned ${blocksToReplan.length} blocks in window ` +
                                `${windowStart}-${windowEnd} on ${bunk}, cursor now at ${cursor}`);

                            seamsClosed++;
                            passChanged = true;
                            break; // restart pass — timeline has changed significantly
                        }
                    }
                }

                if (passCount >= MAX_PASSES) {
                    warn(`[STEP 2.5b] ${bunk} hit MAX_PASSES (${MAX_PASSES}) — some seams may remain`);
                }
            });
        });

        log('[STEP 2.5b] ✅ Closed ' + seamsClosed + ' seams across camp');

        // ── Score this iteration and track best ──────────────────────────────
        const iterWarnings = [];
        const iterScore = scoreTimelines(bunkTimelines, iterWarnings);
        totalIters++;

        const improved = iterScore < bestScore;
        if (improved) {
            bestScore    = iterScore;
            bestTimelines = {};
            allGrades.forEach(grade => {
                getBunksForGrade(grade, divisions).forEach(bunk => {
                    bestTimelines[bunk] = bunkTimelines[bunk].map(b => ({ ...b }));
                });
            });
            bestWarnings = [...warnings]; // capture warnings from this iteration
            staleCount = 0;
        } else {
            staleCount++;
        }

        if (improved || totalIters <= 3 || totalIters % 10 === 0) {
            log('[ITER ' + totalIters + '] score=' + iterScore +
                (improved ? ' ★ NEW BEST' : '') +
                ' | best=' + bestScore + ' | stale=' + staleCount);
        }

       

    // Debug exports — only on final iteration (perf: skip deep clone in hot loop)

        if (bestScore > PERFECT_SCORE && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS) {
            _iterSeed++;
            warnings.length = 0; // clear for next iteration
            resetIterState();
        }
        } while (bestScore > PERFECT_SCORE && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS);
        // ────────────────────────────────────────────────────────────────────

        log('══════════════════════════════════════════════════════════');
        log('BEST SCORE: ' + bestScore + ' after ' + totalIters + ' iteration(s)');
        log('══════════════════════════════════════════════════════════');

        // Debug exports — once after loop (moved from hot loop for perf)
        window._bunkNeeds     = JSON.parse(JSON.stringify(bunkNeeds));
        window._bunkTimelines = JSON.parse(JSON.stringify(bunkTimelines));
        window._autoBuildTimelines = JSON.parse(JSON.stringify(bunkTimelines));

        // Restore the best iteration's timelines into live state for Steps 3–5
        allGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                bunkTimelines[bunk] = bestTimelines[bunk] || [];
            });
        });
        warnings.length = 0;
        bestWarnings.forEach(w => warnings.push(w));
        
        // -----------------------------------------------------------------
        // STEP 2.6 — VALIDATE
        // -----------------------------------------------------------------
        log('\n[STEP 2.6] Validating...');

        let validationPassed = true;

        allGrades.forEach(grade => {
            const gradeStart = parseTimeToMinutes(divisions[grade] && divisions[grade].startTime) || 540;
            const gradeEnd = parseTimeToMinutes(divisions[grade] && divisions[grade].endTime) || 960;
            const bunks = getBunksForGrade(grade, divisions);

            bunks.forEach(bunk => {
                const timeline = bunkTimelines[bunk] || [];

                // Check for overlaps
                for (let i = 0; i < timeline.length - 1; i++) {
                    if (timeline[i].endMin > timeline[i + 1].startMin) {
                        err('[STEP 2.6] OVERLAP in ' + bunk + ': ' +
                            timeline[i].event + ' (' + timeline[i].startMin + '-' + timeline[i].endMin + ') overlaps ' +
                            timeline[i + 1].event + ' (' + timeline[i + 1].startMin + '-' + timeline[i + 1].endMin + ')');
                        validationPassed = false;
                        warnings.push({ type: 'overlap', bunk, grade });
                    }
                }

                // Check that every block has valid start, end, event
                timeline.forEach(b => {
                    if (b.startMin == null || b.endMin == null || b.endMin <= b.startMin) {
                        err('[STEP 2.6] Invalid block in ' + bunk + ': ' + JSON.stringify(b));
                        validationPassed = false;
                        warnings.push({ type: 'invalid_block', bunk, grade });
                    }
                    if (!b.event) {
                        warn('[STEP 2.6] Missing event label in ' + bunk + ' at ' + b.startMin);
                    }
                });

                // Check for gaps (should be none after 2.5)
                const remainingGaps = getFreeGaps(bunk, gradeStart, gradeEnd);
                if (remainingGaps.length > 0) {
                    warn('[STEP 2.6] Unexpected remaining gaps in ' + bunk + ':',
                        remainingGaps.map(g => g.start + '-' + g.end).join(', '));
                    warnings.push({ type: 'remaining_gap', bunk, grade });
                }
            });
        });

        if (validationPassed) {
            log('[STEP 2.6] ✅ Validation passed');
        } else {
            warn('[STEP 2.6] Validation completed with errors — proceeding with best available');
        }

        // -----------------------------------------------------------------
        // STEP 2.7 — FORMALIZE (buildFromSkeleton → _perBunkSlots → scheduleAssignments)
        // -----------------------------------------------------------------
        log('\n[STEP 2.7] Formalizing — building per-bunk skeleton and divisionTimes...');

        // Convert bunk timelines into skeleton blocks for DivisionTimesSystem
        const autoSkeleton = [];

        allGrades.forEach(grade => {
            const bunks = getBunksForGrade(grade, divisions);
            bunks.forEach(bunk => {
                (bunkTimelines[bunk] || []).forEach(block => {
                    autoSkeleton.push({
                        division: grade,
                        _bunk: bunk,
                        startTime: minutesToTimeLabel(block.startMin),
                        endTime: minutesToTimeLabel(block.endMin),
                        startMin: block.startMin,
                        endMin: block.endMin,
                        event: block.event || 'General Activity Slot',
                        type: block.type || 'slot',
                        _autoGenerated: true,
                        _classification: block._classification,
                        _suggestedActivity: block._assignedSpecial || null,
                        _activityLocked: (block._activityLocked && (block._assignedSpecial || block._fixed || block._classification === 'pinned')) || false,
_durationStrict: (block._activityLocked && (block._assignedSpecial || block._fixed || block._classification === 'pinned')) || false,
                        _fixed: block._fixed || false,
                        _pinned: block._classification === 'pinned',
                        _durationStrict: block._activityLocked || false,
                        _isScarce: block._isScarce || false,
                        _specialLocation: block._specialLocation || null
                    });
                });
            });
        });

        // Store autoSkeleton so DivisionTimesSystem can build from it
        window.manualSkeleton = autoSkeleton;
        window._autoSkeleton = autoSkeleton;

        // Build divisionTimes via DivisionTimesSystem
       if (window.DivisionTimesSystem) {
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(autoSkeleton, divisions);
            log('[STEP 2.7] Built divisionTimes for ' + Object.keys(window.divisionTimes).length + ' grades');

            // Build _perBunkSlots manually — DivisionTimesSystem only builds division-level slots.
            // We need per-bunk slot arrays so Step 3 and the solver can match blocks by bunk.
            allGrades.forEach(grade => {
                const divSlots = window.divisionTimes[grade];
                if (!divSlots) return;

                const perBunkSlots = {};
                const bunks = getBunksForGrade(grade, divisions);

                bunks.forEach(bunk => {
                    // Get all skeleton blocks for this bunk, sorted by startMin
                    const bunkBlocks = autoSkeleton
                        .filter(b => b.division === grade && String(b._bunk) === String(bunk))
                        .sort((a, b) => a.startMin - b.startMin);

                    perBunkSlots[String(bunk)] = bunkBlocks.map((b, i) => ({
                        startMin: b.startMin,
                        endMin: b.endMin,
                        startTime: b.startTime,
                        endTime: b.endTime,
                        type: b.type,
                        event: b.event,
                        slotIndex: i,
                        _bunk: bunk,
                        _autoGenerated: true
                    }));
                });

                window.divisionTimes[grade]._perBunkSlots = perBunkSlots;
            });

            log('[STEP 2.7] Built _perBunkSlots for all grades');
        } else {            err('[STEP 2.7] DivisionTimesSystem not available — cannot build _perBunkSlots');
            warnings.push({ type: 'critical', message: 'DivisionTimesSystem not loaded' });
        }

        // Initialize scheduleAssignments per bunk from _perBunkSlots
        allGrades.forEach(grade => {
            const divSlots = window.divisionTimes && window.divisionTimes[grade];
            const perBunkSlots = divSlots && divSlots._perBunkSlots;
            const bunks = getBunksForGrade(grade, divisions);

           bunks.forEach(bunk => {
    const bunkSlots = perBunkSlots && perBunkSlots[String(bunk)];
    const slotCount = bunkSlots ? bunkSlots.length : (divSlots ? divSlots.length : 0);
    window.scheduleAssignments[String(bunk)] = new Array(slotCount).fill(null);

   
});
        });

        // NOW write special blocks directly to scheduleAssignments — fully locked
        // The Total Solver will see these as already filled and skip them,
        // but the field they use IS registered in fieldUsageBySlot so the solver
        // won't double-book the location.
        let specialWriteCount = 0;

        allGrades.forEach(grade => {
            const divSlots = window.divisionTimes && window.divisionTimes[grade];
            const perBunkSlots = divSlots && divSlots._perBunkSlots;
            if (!perBunkSlots) return;

            const bunks = getBunksForGrade(grade, divisions);
            bunks.forEach(bunk => {
                const bunkSlotArr = perBunkSlots[String(bunk)] || [];
                const timeline = bunkTimelines[bunk] || [];

                timeline
                    .filter(b => b.type === 'special' && b._assignedSpecial)
                    .forEach(block => {
                        // Find matching slot index
                        const slotIdx = bunkSlotArr.findIndex(s =>
                            s.startMin === block.startMin && s.endMin === block.endMin
                        );
                        if (slotIdx === -1) {
                            warn('[STEP 2.7] Could not find slot index for special "' +
                                block._assignedSpecial + '" in ' + bunk);
                            return;
                        }

                        const fieldName = block._specialLocation || block._assignedSpecial;

                        // Write fully locked to scheduleAssignments
                        window.scheduleAssignments[String(bunk)][slotIdx] = {
                            field: fieldName,
                            sport: null,
                            _activity: block._assignedSpecial,
                            _fixed: true,
                            _bunkOverride: true,
                            _activityLocked: true,
                            _isScarce: block._isScarce || false,
                            _autoSpecial: true,
                            continuation: false
                        };

                        // Register field usage so Total Solver avoids this location
                        registerSpecialFieldUsage(
                            [slotIdx], fieldName, String(bunk),
                            block._assignedSpecial, grade, fieldUsageBySlot
                        );

                        // Lock the location in GlobalFieldLocks
                        if (fieldName && window.GlobalFieldLocks) {
                            window.GlobalFieldLocks.lockField(fieldName, [slotIdx], {
                                lockedBy: 'auto_special',
                                division: grade,
                                activity: block._assignedSpecial + ' (auto special)'
                            });
                        }

                        specialWriteCount++;
                    });
            });
        });

        // Also write pinned blocks directly to scheduleAssignments
        let pinnedWriteCount = 0;

        allGrades.forEach(grade => {
            const divSlots = window.divisionTimes && window.divisionTimes[grade];
            const perBunkSlots = divSlots && divSlots._perBunkSlots;
            if (!perBunkSlots) return;

            const bunks = getBunksForGrade(grade, divisions);
            bunks.forEach(bunk => {
                const bunkSlotArr = perBunkSlots[String(bunk)] || [];
                const timeline = bunkTimelines[bunk] || [];

                timeline
                    .filter(b => b._classification === 'pinned' && b._committed)
                    .forEach(block => {
                        const slotIdx = bunkSlotArr.findIndex(s =>
                            s.startMin === block.startMin && s.endMin === block.endMin
                        );
                        if (slotIdx === -1) return;

                        // Don't overwrite if already written (special might overlap)
                        if (window.scheduleAssignments[String(bunk)][slotIdx]) return;

                        window.scheduleAssignments[String(bunk)][slotIdx] = {
                            field: block.event,
                            sport: null,
                            _activity: block.event,
                            _fixed: true,
                            _pinned: true,
                            _bunkOverride: true,
                            continuation: false
                        };
                        pinnedWriteCount++;
                    });
            });
        });
// Write swim/snacks/dismissal-type blocks that are windowed (not pinned) but still fixed
        const fixedTypes = ['swim', 'snacks', 'lunch', 'dismissal'];
        allGrades.forEach(grade => {
            const divSlots = window.divisionTimes && window.divisionTimes[grade];
            const perBunkSlots = divSlots && divSlots._perBunkSlots;
            if (!perBunkSlots) return;
            const bunks = getBunksForGrade(grade, divisions);
            bunks.forEach(bunk => {
                const bunkSlotArr = perBunkSlots[String(bunk)] || [];
                const timeline = bunkTimelines[bunk] || [];
                timeline
                    .filter(b => fixedTypes.includes((b.type || '').toLowerCase()) && b._committed)
                    .forEach(block => {
                        const slotIdx = bunkSlotArr.findIndex(s =>
                            s.startMin === block.startMin && s.endMin === block.endMin
                        );
                        if (slotIdx === -1) return;
                        if (window.scheduleAssignments[String(bunk)][slotIdx]) return;
                        window.scheduleAssignments[String(bunk)][slotIdx] = {
                            field: block.event,
                            sport: null,
                            _activity: block.event,
                            _fixed: true,
                            _pinned: true,
                            _bunkOverride: true,
                            continuation: false
                        };
                    });
            });
        });
        // LOCK divisionTimes — nothing may overwrite from this point
        window._divisionTimesLocked = true;
        window._autoDivisionTimesBuilt = true;
        window._preGenClearActive = false;

        log('[STEP 2.7] ✅ Formalized: ' + specialWriteCount + ' special blocks locked, ' +
            pinnedWriteCount + ' pinned blocks written');
        log('[STEP 2.7] 🔒 _divisionTimesLocked = true');

        // Build schedulableSlotBlocks for the Total Solver
        // These are ONLY the non-special, non-pinned blocks — sports, general activity, leagues
        const schedulableSlotBlocks = [];

        allGrades.forEach(grade => {
            const divSlots = window.divisionTimes && window.divisionTimes[grade];
            const perBunkSlots = divSlots && divSlots._perBunkSlots;
            if (!perBunkSlots) return;

            const bunks = getBunksForGrade(grade, divisions);
            bunks.forEach(bunk => {
                const bunkSlotArr = perBunkSlots[String(bunk)] || [];
                const timeline = bunkTimelines[bunk] || [];

               timeline
                    .filter(b =>
                        b._classification !== 'pinned' &&
                        b.type !== 'special' &&
                        !b._activityLocked
                    )
                    .forEach(block => {
                        const slotIdx = bunkSlotArr.findIndex(s =>
                            s.startMin === block.startMin && s.endMin === block.endMin
                        );
                        if (slotIdx === -1) return;

                        // Skip if already filled (pinned or special wrote here)
                        if (window.scheduleAssignments[String(bunk)][slotIdx]) return;

                        const skipTypes = ['swim', 'snacks', 'lunch', 'dismissal', 'pinned', 'league', 'specialty_league'];
                        if (skipTypes.includes((block.type || '').toLowerCase())) return;

                        schedulableSlotBlocks.push({
                            divName: grade,
                            bunk: String(bunk),
                           event: (() => {
                const t = (block.type || '').toLowerCase();
                const e = (block.event || '').toLowerCase();
                if (t === 'sport' || t === 'sports' || e === 'sport' || e === 'sports') return 'Sports Slot';
                if (t === 'special' || t === 'specials') return 'Special Activity';
               const _dal = window.loadGlobalSettings?.()?.app1?.dailyAutoLayers || {};
const gradeLayers = (_dal[currentDate] || {})[grade] || [];
                const isSportLayer = gradeLayers.some(l =>
                    l.type === 'sport' &&
                    block.startMin >= l.startMin &&
                    block.endMin <= l.endMin
                );
                if (isSportLayer) return 'Sports Slot';
                return 'General Activity Slot';
            })(),
                            type: 'slot',
                            startTime: minutesToTimeLabel(block.startMin),
                            endTime: minutesToTimeLabel(block.endMin),
                            slots: [slotIdx],
                            _durationStrict: false,
                            _autoGenerated: true,
                            _suggestedActivity: null,
                            _fromGapDetection: block._fromGapDetection || false,
                            _perBunkSlot: true,
                            _originalType: block.type
                        });
                    });          // closes .forEach(block =>
            });                  // closes bunks.forEach(bunk =>
        });                      // closes allGrades.forEach(grade =>

        log('[STEP 2.7] Built ' + schedulableSlotBlocks.length + ' schedulable blocks for solver');
        log('[STEP 2] ✅ Live iterative solver complete');
        // =====================================================================
        // STEP 3 — LEAGUE ENGINES
        // =====================================================================

        const yesterdayHistory = (() => {
            const parts = (currentDate || '').split('-').map(Number);
            if (!parts[0]) return {};
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            d.setDate(d.getDate() - 1);
            const yKey = d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
            return allDailyData[yKey]?.scheduleAssignments || {};
        })();

        log('\n[STEP 3] Running league engines...');

        const leagueBlocks = (() => {
            const seen = new Set();
            return autoSkeleton.filter(b => {
                if (b.type !== 'league' && b.type !== 'specialty_league') return false;
                const key = b.division + '_' + b.startMin;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).map(b => ({
                divName: b.division,
                bunk: String(b._bunk || ''),
                event: b.type === 'league' ? 'League Game' : 'Specialty League',
                type: b.type,
                startTime: b.startTime || minutesToTimeLabel(b.startMin),
                endTime: b.endTime || minutesToTimeLabel(b.endMin),
                startMin: b.startMin,
                endMin: b.endMin,
               slots: (() => {
    const divSlots = window.divisionTimes?.[b.division];
    if (!Array.isArray(divSlots)) return [];
    const idx = divSlots.findIndex(s => s.startMin === b.startMin);
    return idx >= 0 ? [idx] : [];
})(),
                _autoGenerated: true
            }));
        })();

        if (leagueBlocks.length > 0) {            const masterLeaguesArr = Array.isArray(window.masterLeagues)
                ? window.masterLeagues
                : Object.values(window.masterLeagues || {});

            const leagueContext = {
                schedulableSlotBlocks: leagueBlocks,
                fieldUsageBySlot,
                activityProperties,
                masterLeagues: masterLeaguesArr,
                disabledLeagues: window.disabledLeagues || [],
                masterSpecialtyLeagues: window.masterSpecialtyLeagues || [],
                disabledSpecialtyLeagues: window.disabledSpecialtyLeagues || [],
                rotationHistory: window.rotationHistory || {},
                yesterdayHistory,
                divisions,
                fieldsBySport: window.fieldsBySport || {},
                dailyLeagueSportsUsage: {},
                fillBlock: window.fillBlock || function() {},
                fields: getFields(globalSettings),
                disabledFields: (globalSettings.app1?.disabledFields || globalSettings.disabledFields || []),
                leagueAssignments: window.leagueAssignments,
                storeLeagueMatchups: function(divName, slots, matchups, gameLabel, sport, leagueName) {
                    const league = masterLeaguesArr.find(l => l.name === leagueName);
                    const coveredDivisions = (league?.divisions || [leagueName]).filter(d =>
                        autoSkeleton.some(b => b.division === d && b.type === 'league')
                    );
                    const targetDivisions = coveredDivisions.length > 0 ? coveredDivisions : [divName];
                    targetDivisions.forEach(function(div) {
                        const leagueBlock = autoSkeleton.find(b => b.division === div && b.type === 'league');
                        if (!leagueBlock) return;
                        if (!window.leagueAssignments[div]) window.leagueAssignments[div] = {};
                        window.leagueAssignments[div][leagueBlock.startMin] = {
                            matchups: matchups || [],
                            gameLabel: gameLabel || '',
                            sport: sport || '',
                            leagueName: leagueName || ''
                        };
                    });
                }
            };

            if (window.SchedulerCoreSpecialtyLeagues && window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues) {
                try {
                    leagueContext.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'specialty_league');
                    window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(leagueContext);
                    log('[STEP 3] Specialty leagues complete');
                } catch (e) {
                    warn('[STEP 3] Specialty league error: ' + e.message);
                }
            }

            if (window.SchedulerCoreLeagues && window.SchedulerCoreLeagues.processRegularLeagues) {
                try {
                    leagueContext.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'league');
                    window.SchedulerCoreLeagues.processRegularLeagues(leagueContext);
                    log('[STEP 3] Regular leagues complete');
                } catch (e) {
                    warn('[STEP 3] Regular league error: ' + e.message);
                }
            }

           // Bridge leagueAssignments[gradeName] → scheduleAssignments[bunk]
            // Uses skeleton startMin directly — no slot index resolution needed
            let leagueWriteCount = 0;
            Object.entries(window.leagueAssignments || {}).forEach(function(gradeEntry) {
                const gradeName = gradeEntry[0];
                const gradeSlots = gradeEntry[1];

                // Get the real league time from the skeleton — single source of truth
                const leagueSkelBlock = autoSkeleton.find(function(b) {
                    return b.division === gradeName && b.type === 'league';
                });
                if (!leagueSkelBlock) return;
                const leagueStartMin = leagueSkelBlock.startMin;

                // Get the assignment — take the first value, all keys are the same game
                const assignment = Object.values(gradeSlots)[0];
                if (!assignment) return;

                // Write to every bunk in this grade by matching startMin directly
                const perBunkSlots = window.divisionTimes?.[gradeName]?._perBunkSlots;
                if (!perBunkSlots) return;

                Object.entries(perBunkSlots).forEach(function(bunkEntry) {
                    const bunkId = bunkEntry[0];
                    const bunkSlots = bunkEntry[1];
                    const finalIdx = bunkSlots.findIndex(function(s) {
                        return s.startMin === leagueStartMin;
                    });
                    if (finalIdx === -1) return;
                    if (!window.scheduleAssignments[bunkId]) return;
                    window.scheduleAssignments[bunkId][finalIdx] = {
                        field: assignment.sport || 'League Game',
                        sport: assignment.sport || null,
                        _activity: 'League Game',
                        _league: true,
                        _leagueName: assignment.leagueName || '',
                        _gameLabel: assignment.gameLabel || '',
                        matchups: assignment.matchups || [],
                        _fixed: true,
                        continuation: false
                    };
                    leagueWriteCount++;
                });
            });
            log('[STEP 3] Wrote ' + leagueWriteCount + ' league slots to scheduleAssignments');

        } else {
            log('[STEP 3] No league blocks — skipping');
        }

        const solverBlocks = schedulableSlotBlocks.filter(b =>
            b.type !== 'league' && b.type !== 'specialty_league'
        );
        log('[STEP 3] ✅ Leagues complete. ' + solverBlocks.length + ' blocks remain for solver');
        // =====================================================================
        // STEP 4 — TOTAL SOLVER
        // =====================================================================
        log('\n[STEP 4] Running Total Solver...');
        log('[STEP 4] Solver receives ' + solverBlocks.length + ' blocks');

        const Solver = window.TotalSolverEngine || window.TotalSolver || window.totalSolverEngine;

       if (Solver && typeof Solver.solveSchedule === 'function') {
            try {
                console.log('🔴 STEP 4 try block entered');
                const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};                const masterFields   = gs.app1?.fields            || gs.fields            || window.fields            || [];
                const masterSpecials = gs.app1?.specialActivities || gs.specialActivities || window.specialActivities || [];

               // Build activityProperties from fields + specials
const builtActivityProperties = window.buildActivityProperties
    ? window.buildActivityProperties(masterSpecials, masterFields)
    : {};
// Inject field activities so solver can find sport/activity candidates
masterFields.forEach(function(field) {
    (field.activities || []).forEach(function(actName) {
        if (!builtActivityProperties[actName]) {
            builtActivityProperties[actName] = {
                available: true,
                sharable: false,
                sharableWith: { type: 'not_sharable' },
                preferredDivisions: [],
                allowedDivisions: [],
                _fromField: true
            };
        }
        if (!builtActivityProperties[actName]._fields) {
            builtActivityProperties[actName]._fields = [];
        }
        builtActivityProperties[actName]._fields.push(field.name);
    });
});
window.activityProperties = builtActivityProperties;

// Build fieldsBySport from field.activities (solver expects this structure)
const fieldsBySport = {};
masterFields.forEach(function(field) {
    (field.activities || []).forEach(function(actName) {
        if (!fieldsBySport[actName]) fieldsBySport[actName] = [];
        fieldsBySport[actName].push(field.name);
    });
});
window.fieldsBySport = fieldsBySport;

                // rotationHistory is structured as { bunks: {}, leagues: {} } — solver wants the bunks map
                const rhRaw = window.loadRotationHistory?.() || {};
                const rotationHistory = rhRaw.bunks || rhRaw;

                // Convert solverBlocks → activityBlocks
                // solverBlocks have startTime/endTime already in minutes from Step 2.7
               const activityBlocks = solverBlocks.map(function(b) {
    return {
        bunk:        b.bunk,
        divName:     b.divName,
        slots:       b.slots,
        startTime:   b.startTime,
        endTime:     b.endTime,
        type:        b.type  || 'slot',
        event:       b.event || 'General Activity Slot',
        _autoGenerated: true,
        _startMin:   (window.divisionTimes?.[b.divName]?._perBunkSlots?.[b.bunk] || [])[b.slots?.[0]]?.startMin,
        _autoMode:   true
    };
});

                log('[STEP 4] activityProperties keys: ' + Object.keys(builtActivityProperties).length);
                log('[STEP 4] rotationHistory bunks: ' + Object.keys(rotationHistory).length);
                log('[STEP 4] activityBlocks: ' + activityBlocks.length);

              const solverConfig = {
    activityProperties: builtActivityProperties,
    rotationHistory,
    divisions,
    masterFields,
    masterSpecials: [], // ★ auto mode: specials fully resolved in Step 2.7 — exclude from planner
    fieldsBySport,
    dateStr:        currentDate || window.currentScheduleDate || '',
    disabledFields: gs.app1?.disabledFields || gs.disabledFields || [],
    yesterdayHistory,
    isRainy,
    _autoMode: true
};

               


const _origLoadAndFilter = window.SchedulerCoreUtils.loadAndFilterData;
window.SchedulerCoreUtils.loadAndFilterData = function() {
    const result = _origLoadAndFilter.apply(this, arguments);
    result.fieldsBySport = fieldsBySport;
    // ★ auto mode: specials fully resolved in Step 2.7 — exclude from planner
    result.masterSpecials = [];
    result.specialActivityNames = [];
    result.activities = (result.activities || []).filter(function(a) {
        return (a.type || '').toLowerCase() !== 'special';
    });
    result.allActivities = (result.allActivities || []).filter(function(a) {
        return (a.type || '').toLowerCase() !== 'special';
    });
    return result;
};
// Hook precomputeResourceMaps to strip specials from allCandidateOptions after it's built
const _origPrecompute = window._SolverInternals.precomputeResourceMaps;
window._SolverInternals.precomputeResourceMaps = function() {
    _origPrecompute.apply(this, arguments);
    if (window._SolverInternals.allCandidateOptions) {
    const arr = window._SolverInternals.allCandidateOptions;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].type === 'special') arr.splice(i, 1);
    }
}
};
// Strip stale non-fixed entries so solver doesn't skip them
Object.keys(window.scheduleAssignments).forEach(function(bunk) {
    (window.scheduleAssignments[bunk] || []).forEach(function(s, i) {
        if (s && !s._fixed && !s._league && !s._autoSpecial) {
            window.scheduleAssignments[bunk][i] = null;
        }
    });
});
                // ★ AUTO MODE: build fieldUsageBySlot from current state so canBlockFit sees existing usage
window.fieldUsageBySlot = window.buildFieldUsageBySlot ? window.buildFieldUsageBySlot() : {};

console.log('🔴🔴🔴 POST-STRIP slot 3:', window.scheduleAssignments?.['1']?.[3]);
console.log('🔴🔴🔴 POST-STRIP slot 8:', window.scheduleAssignments?.['1']?.[8]);

// ★ Strip specials from window.activityProperties so solver doesn't use them
const _origWindowAP = window.activityProperties;
const strippedAP = {};
Object.entries(window.activityProperties || {}).forEach(function([k, v]) {
    const isSpecial = masterSpecials.some(function(s) { return s.name === k; });
    if (!isSpecial) strippedAP[k] = v;
});
window.activityProperties = strippedAP;

Solver.solveSchedule(activityBlocks, solverConfig);

window.activityProperties = _origWindowAP;
// Restore original after solver runs
window.SchedulerCoreUtils.loadAndFilterData = _origLoadAndFilter;
                window._SolverInternals.precomputeResourceMaps = _origPrecompute;

                // Count what was filled
                let solverFilled = 0;
                activityBlocks.forEach(function(b) {
                    const slot = (window.scheduleAssignments?.[b.bunk] || [])[b.slots?.[0]];
                    if (slot && !slot._league && !slot._fixed) solverFilled++;
                });
                log('[STEP 4] ✅ Total Solver complete — filled ~' + solverFilled + ' slots');

            } catch (e) {
                err('[STEP 4] Total Solver error: ' + e.message);
                console.error(e);
                warnings.push({ type: 'solver_error', message: e.message });
            }
        } else {
            warn('[STEP 4] TotalSolverEngine not loaded — skipping field assignment');
            warnings.push({ type: 'critical', message: 'TotalSolverEngine not loaded' });
        }

        // =====================================================================
        // STEP 5 — SAVE AND DONE
        // =====================================================================
        log('\n[STEP 5] Saving...');

        // Save to localStorage
        if (window.saveCurrentDailyData) {
            try {
                // Strip 'Free' entries before saving — solver fallback, not real assignments
const cleanAssignments = {};
Object.entries(window.scheduleAssignments || {}).forEach(function([bunk, slots]) {
    cleanAssignments[bunk] = (slots || []).map(s =>
        (s && s.field === 'Free' && !s._fixed) ? null : s
    );
});

window.saveCurrentDailyData({
    scheduleAssignments: cleanAssignments,
                    leagueAssignments: window.leagueAssignments,
                    manualSkeleton: autoSkeleton,
                    _autoGenerated: true,
                    _autoVersion: VERSION,
                    _generatedAt: new Date().toISOString(),
                    _warnings: warnings
                });
                log('[STEP 5] Saved to localStorage');
            } catch (e) {
                warn('[STEP 5] localStorage save error: ' + e.message);
            }
        }

        // Sync to Supabase cloud
        if (window.SupabaseSyncEngine && window.SupabaseSyncEngine.pushSchedule) {
            try {
                await window.SupabaseSyncEngine.pushSchedule(
                    window.scheduleAssignments,
                    window.currentScheduleDate || window.currentDate
                );
                log('[STEP 5] Synced to cloud');
            } catch (e) {
                warn('[STEP 5] Cloud sync error: ' + e.message);
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

        log('\n═══════════════════════════════════════════════════════════');
        log('AUTO SCHEDULER COMPLETE in ' + elapsed + 's');
        log('Warnings: ' + warnings.length);
        if (warnings.length > 0) {
            warnings.forEach((w, i) => log('  ' + (i + 1) + '. [' + w.type + '] ' + (w.message || JSON.stringify(w))));
        }
        log('═══════════════════════════════════════════════════════════');

        // Fire completion event — all downstream listeners (rendering, post-edit, etc.) react to this
        window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
            detail: {
                mode: 'auto',
                version: VERSION,
                elapsed,
                warnings
            }
        }));

        return {
            success: true,
            warnings,
            elapsed,
            blocksScheduled: solverBlocks.length,
            specialBlocksLocked: specialWriteCount
        };
    };

    log('scheduler_core_auto.js v' + VERSION + ' loaded');

})();
