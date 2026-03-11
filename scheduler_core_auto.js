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
    function getSpecialDuration(specialName, activityProperties, globalSettings) {
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

        // =====================================================================
        // STEP 2 — LIVE ITERATIVE SOLVER
        // =====================================================================
        log('\n[STEP 2] Live iterative solver — building day for entire camp...');

        // Shared live capacity tracker (global across camp)
        // Structure: { specialName: { remaining: N, assignedTo: { bunkName: count } } }
        const specialCapacityTracker = {};
        todaysSpecials.forEach(s => {
            specialCapacityTracker[s.name] = {
                total: getSpecialCapacity(s.name, activityProperties, globalSettings),
                // assignments: array of {bunk, startMin, endMin} for overlap checking
                assignments: []
            };
        });

        // Per-bunk day timelines (tentative)
        // Structure: { bunkName: [ { startMin, endMin, type, event, layer, _classification, _assignedSpecial, _committed } ] }
        const bunkTimelines = {};

        // Per-bunk ranked special queues
        // Structure: { bunkName: [ { name, score, duration, isScarce, remainingCapacity } ] }
        const bunkSpecialQueues = {};

        // Track how many times each special has been assigned to each bunk today
        // Structure: { bunkName: { specialName: count } }
        const bunkSpecialAssigned = {};

        // All grades
        const allGrades = Object.keys(divisions).filter(g =>
            !allowedSet || allowedSet.has(String(g))
        );

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
                    event: layer.event || 'Pinned',
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
        // STEP 2.1b — PLACE LEAGUE LAYERS (grade-wide simultaneous)
        // Must run after pinned anchors (lunch/swim/dismissal already placed)
        // but before per-bunk windowed placement so leagues get first pick
        // of remaining free time.
        // -----------------------------------------------------------------
        log('\n[STEP 2.1b] Placing league layers (grade-wide simultaneous)...');
        let leagueCount = 0;

       const leagueLayersToPlace = [...windowedLayers, ...openLayers].filter(l => {
            const t = (l.type || '').toLowerCase();
            return t === 'league' || t === 'specialty_league';
        });

        // Build grade rotation order — same grades/types as Step 2.3 soft rotation
        const leagueRotationTypes = ['league', 'sport', 'swim', 'special', 'slot', 'snacks'];
        const leagueGradeList = allGrades.filter(g => !allowedSet || allowedSet.has(String(g)));

       // Pre-build a map of which grades share the same league
        // so they get placed at the same time
        const sharedLeagueTime = {}; // gradeName → placedStartMin (set when first grade in league is placed)
        const gradeToLeagueName = {}; // gradeName → leagueName
        leagueLayersToPlace.forEach(layer => {
            const grade = layer.grade || layer.division;
            const league = (Array.isArray(window.masterLeagues) ? window.masterLeagues : Object.values(window.masterLeagues || {})).find(l =>
                (l.divisions || []).includes(grade)
            );
            if (league) gradeToLeagueName[grade] = league.name;
        });

        leagueLayersToPlace.forEach(layer => {
            const grade = layer.grade || layer.division;
            const bunks = getBunksForGrade(grade, divisions);
            if (!bunks.length) return;
            if (allowedSet && !allowedSet.has(String(grade))) return;

            const windowStart = layer.startMin;
            const windowEnd = layer.endMin;
            const dur = layer.periodMin || 30;
            const lType = (layer.type || '').toLowerCase();

            // If another grade in the same league already placed, use their time
            const leagueName = gradeToLeagueName[grade];
            if (leagueName && sharedLeagueTime[leagueName] != null) {
                const sharedStart = sharedLeagueTime[leagueName];
                const sharedEnd = sharedStart + dur;
                bunks.forEach(bunk => {
                    bunkTimelines[bunk].push({
                        startMin: sharedStart,
                        endMin: sharedEnd,
                        type: lType,
                        event: layer.event || 'League Game',
                        layer,
                        _classification: 'windowed',
                        _committed: true
                    });
                    bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
                    leagueCount++;
                });
                log('[STEP 2.1b] ' + grade + ': joined shared league time at ' +
                    Math.floor(sharedStart/60) + ':' + String(sharedStart%60).padStart(2,'0') +
                    ' (same as ' + leagueName + ')');
                return;
            }
           // Stagger league time by grade index, but treat shared-league grades
            // as the same unit so they get the same offset
            // Build a deduplicated list where shared-league grades count as one slot
            const leagueUnits = []; // each entry is the "primary" grade for a league unit
            leagueGradeList.forEach(g => {
                const ln = gradeToLeagueName[g];
                if (ln) {
                    // Only add if no grade from this league is already in leagueUnits
                    const alreadyAdded = leagueUnits.some(u => gradeToLeagueName[u] === ln);
                    if (!alreadyAdded) leagueUnits.push(g);
                } else {
                    leagueUnits.push(g);
                }
            });
            const primaryGrade = leagueName
                ? leagueUnits.find(u => gradeToLeagueName[u] === leagueName) || grade
                : grade;
            const gradeIdx = leagueUnits.indexOf(primaryGrade);
            const totalGrades = leagueUnits.length || 1;
            const usableWindow = windowEnd - windowStart - dur;
            const targetOffset = snapTo5(Math.round((gradeIdx / totalGrades) * usableWindow));
            const searchStart = windowStart + targetOffset;

            // Find first slot where ALL bunks in grade are simultaneously free,
            // starting from the grade's target offset position
            let placedStart = null;
            for (let ts = searchStart; ts + dur <= windowEnd; ts += 5) {
                const te = ts + dur;
                const allFree = bunks.every(bunk =>
                    !(bunkTimelines[bunk] || []).some(b => b.startMin < te && b.endMin > ts)
                );
                if (allFree) { placedStart = ts; break; }
            }
            // Fallback: search from window start if target offset had no free gap
            if (placedStart === null) {
                for (let ts = windowStart; ts < searchStart; ts += 5) {
                    const te = ts + dur;
                    const allFree = bunks.every(bunk =>
                        !(bunkTimelines[bunk] || []).some(b => b.startMin < te && b.endMin > ts)
                    );
                    if (allFree) { placedStart = ts; break; }
                }
            }
            if (placedStart === null) {
                warn('[STEP 2.1b] No shared free gap for league in ' + grade);
                return;
            }

            const placedEnd = placedStart + dur;
            bunks.forEach(bunk => {
                bunkTimelines[bunk].push({
                    startMin: placedStart,
                    endMin: placedEnd,
                    type: lType,
                    event: layer.event || 'League Game',
                    layer,
                    _classification: 'windowed',
                    _committed: true
                });
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
                leagueCount++;
            });

            log('[STEP 2.1b] ' + grade + ': league placed at ' +
                Math.floor(placedStart/60) + ':' + String(placedStart%60).padStart(2,'0') +
                ' (' + dur + 'min) across ' + bunks.length + ' bunks');

            // Record this time for other grades in the same league
            if (leagueName && placedStart !== null) {
                sharedLeagueTime[leagueName] = placedStart;
            }
        });

        log('[STEP 2.1b] ✅ ' + leagueCount + ' league blocks placed');
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
                    const duration = getSpecialDuration(s.name, activityProperties, globalSettings);

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
        // STEP 2.3 — LIVE PLACEMENT ENGINE
        // -----------------------------------------------------------------
        log('\n[STEP 2.3] Live placement engine — camp-wide simultaneous placement...');

        // All placements here are TENTATIVE until Step 2.6 validates the entire camp.
        // Committed pinned blocks from Step 2.1 are the only hard anchors.

        // Helper: get free gaps in a bunk's timeline within a window
        function getFreeGaps(bunk, windowStart, windowEnd) {
            const timeline = bunkTimelines[bunk] || [];
            // Collect occupied ranges within the window
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
            return gaps.filter(g => g.end - g.start >= 5); // min 5 min gap
        }

        // Helper: find the best gap position for a block of a given duration within a window
        function findBestGapPosition(bunk, windowStart, windowEnd, duration) {
            const gaps = getFreeGaps(bunk, windowStart, windowEnd);
            for (const gap of gaps) {
                if (gap.end - gap.start >= duration) {
                    return { start: gap.start, end: gap.start + duration };
                }
            }
            return null;
        }

        // Helper: find the largest available gap within the window (no fixed duration)
        // Returns the gap snapped to 5-min boundaries — used for sport/activity layers
        // that have no explicit periodMin.
        function findFlexGapPosition(bunk, windowStart, windowEnd) {
            const gaps = getFreeGaps(bunk, windowStart, windowEnd);
            let best = null;
            for (const gap of gaps) {
                const snappedStart = Math.ceil(gap.start / 5) * 5;
                const snappedEnd   = Math.floor(gap.end   / 5) * 5;
                if (snappedEnd - snappedStart < 5) continue;
                if (!best || (snappedEnd - snappedStart) > (best.end - best.start)) {
                    best = { start: snappedStart, end: snappedEnd };
                }
            }
            return best;
        }

        // Helper: place a block tentatively into a bunk's timeline
        function placeTentativeBlock(bunk, block) {
            bunkTimelines[bunk].push(block);
            bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
        }

        // Helper: remove a tentative block from a bunk's timeline
        function removeTentativeBlock(bunk, block) {
            const idx = bunkTimelines[bunk].indexOf(block);
            if (idx !== -1) bunkTimelines[bunk].splice(idx, 1);
        }

        // Helper: get next available special from a bunk's ranked queue
        // that still has capacity, hasn't been assigned to this bunk today,
        // and hasn't exceeded the bunk's lifetime maxUsage for this special
        function getNextSpecial(bunk, excludeNames, winStart, winEnd) {
            const queue = bunkSpecialQueues[bunk] || [];
            for (const candidate of queue) {
                if (excludeNames && excludeNames.has(candidate.name)) continue;

                const tracker = specialCapacityTracker[candidate.name];
                if (!tracker) continue;
                // Capacity checked post-position in placement loop — not here
                // Already assigned to this bunk today
                const alreadyAssigned = (bunkSpecialAssigned[bunk] && bunkSpecialAssigned[bunk][candidate.name]) || 0;
                if (alreadyAssigned > 0) continue;

                // ★ Tertiary maxUsage guard at placement time — period-aware
                // Catches any edge case where the queue wasn't filtered in 2.2a
                if (candidate.maxUsage && candidate.maxUsage > 0) {
                    const periodCount = getPeriodCount(bunk, candidate.name, candidate.maxUsagePeriod || 'half');
                    if (periodCount >= candidate.maxUsage) continue;
                }

                return candidate;
            }
            return null;
        }

        // Helper: claim a special for a bunk (reduces capacity)
        function claimSpecial(bunk, specialEntry, startMin, endMin) {
            const tracker = specialCapacityTracker[specialEntry.name];
            if (tracker) tracker.assignments.push({ bunk, startMin, endMin });
            if (!bunkSpecialAssigned[bunk]) bunkSpecialAssigned[bunk] = {};
            bunkSpecialAssigned[bunk][specialEntry.name] = (bunkSpecialAssigned[bunk][specialEntry.name] || 0) + 1;
        }

        // Helper: unclaim a special (for backtracking)
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

       // ── STEP 2.3 ROUND-ROBIN PLACEMENT ENGINE ──
        // Each round: visit every bunk once, place ONE activity per need.
        // This staggers timelines naturally so specials/activities land at
        // different times for different bunks — enabling time-sliced capacity reuse.

        // Capacity tracker for non-special activity types
        // Pulled from layer config if present, otherwise unlimited
        const activityCapacityTracker = {};
        function getTypeCapacity(type) {
            // Check global settings for capacity config
            const cfg = (globalSettings.app1?.activityCapacity || {})[type];
            return cfg || 9999; // default unlimited
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
            // Scan forward in 5-min steps to see if a slot opens up
            for (let t = afterMin; t + duration <= windowEnd; t += 5) {
                const overlapping = tracker.assignments.filter(a =>
                    a.startMin < t + duration && a.endMin > t
                ).length;
                if (overlapping < tracker.total) return true;
            }
            return false;
        }

        // Build needs list per bunk
        const nonPinnedLayers = [...windowedLayers, ...openLayers];
        const gradeSortedForPlacement = sortGradesByConstraint(
            allGrades, layersByGrade, bunkSpecialQueues
        );

        // bunkNeeds[bunk] = array of { layer, placed, required, op }
        const bunkNeeds = {};
        gradeSortedForPlacement.forEach(grade => {
            const bunks = getBunksForGrade(grade, divisions);
            const gradeLayers = nonPinnedLayers.filter(l => {
    if ((l.grade || l.division) !== grade) return false;
    const t = (l.type || '').toLowerCase();
    return t !== 'league' && t !== 'specialty_league';
})
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

       // ── SOFT ROTATION PRE-PASS ──
        // Assign each grade a different "first priority" activity type.
        // This nudges grades to attempt different activities in the first round,
        // naturally staggering timelines across the morning.
        // It's purely a reordering of bunkNeeds — not a hard constraint.
        const activityTypes = [...new Set(nonPinnedLayers.map(l => l.type))];
        gradeSortedForPlacement.forEach((grade, gradeIdx) => {
            const bunks = getBunksForGrade(grade, divisions);
            // Rotate activity type priority by grade index
            const priorityType = activityTypes[gradeIdx % activityTypes.length];
            bunks.forEach(bunk => {
                const needs = bunkNeeds[bunk] || [];
                // Move priority type to front, keep everything else in original order
                bunkNeeds[bunk] = [
                    ...needs.filter(n => n.layer.type === priorityType),
                    ...needs.filter(n => n.layer.type !== priorityType)
                ];
            });
        });
        log('[STEP 2.3] Soft rotation pre-pass: ' + gradeSortedForPlacement.map((g, i) =>
            g + '→' + activityTypes[i % activityTypes.length]).join(', '));

        // Round-robin loop — keep going until no progress made
        let madeProgress = true;
        let roundCount = 0;
        const MAX_ROUNDS = 30;

        while (madeProgress && roundCount < MAX_ROUNDS) {
            madeProgress = false;
            roundCount++;
            log('[STEP 2.3] Round ' + roundCount);

            for (const grade of gradeSortedForPlacement) {
                const bunks = sortBunksByConstraint(
                    getBunksForGrade(grade, divisions), bunkSpecialQueues
                );

                for (const bunk of bunks) {
                    const needs = bunkNeeds[bunk] || [];

                    for (const need of needs) {
                        const { layer, op, required } = need;
                        // Skip if fully satisfied
                        if (op === '=' && need.placed >= required) continue;
                        if (op === '>=' && need.placed >= required && roundCount > 1) continue;

                        const windowStart = layer.startMin;
                        const windowEnd   = layer.endMin;
                        const type        = layer.type;
                        const duration    = layer.periodMin || layer.durationMin || layer.duration || null;
                        const _classification = layer._classification;
                        const event       = layer.event || layer.name || layer.type || 'Activity';

                       if (type === 'special') {
                            // ── SPECIAL ──
                            // Try each candidate in ranked order until one fits position + capacity
                            const usedExclusions = new Set(Object.keys(bunkSpecialAssigned[bunk] || {}));
                            let placed = false;

                            // Stagger special search start by bunk index
                            const allBunksList2 = gradeSortedForPlacement.flatMap(g => getBunksForGrade(g, divisions));
                            const bunkIdx2 = allBunksList2.indexOf(bunk);
                            const specialWindowSize = windowEnd - windowStart;
                           const specialStaggerOffset = specialWindowSize > 0
                                ? snapTo5(Math.round((bunkIdx2 / allBunksList2.length) * specialWindowSize))
                                : 0;
                            const specialStaggeredStart = windowStart + specialStaggerOffset;

                            while (!placed) {
                                const candidate = getNextSpecial(bunk, usedExclusions, windowStart, windowEnd);
                                if (!candidate) break;

                                // Check if a same-grade bunk is already running this special
                                // If so, join their session (same start time) instead of starting a new one
                                const cfg = getSpecialConfig(candidate.name, globalSettings);
                                const sharableType = cfg?.sharableWith?.type || 'not_sharable';
                                const gradeBunks = getBunksForGrade(grade, divisions).map(String);
                                const tracker2 = specialCapacityTracker[candidate.name];

                                let position = null;

                                // Try to join an existing session first
                                if (sharableType === 'same_division' || sharableType === 'all' ||
                                    (sharableType === 'custom' && cfg?.sharableWith?.divisions?.length > 0)) {
                                    const existingSession = (tracker2?.assignments || []).find(a => {
                                        // Enforce same_division — only join if same grade
                                        if (sharableType === 'same_division') {
                                            if (!gradeBunks.includes(String(a.bunk))) return false;
                                        }
                                        // Enforce custom with specific divisions
                                        if (sharableType === 'custom' && cfg?.sharableWith?.divisions?.length > 0) {
                                            const allowedDivs = cfg.sharableWith.divisions;
                                            if (!allowedDivs.includes(grade)) return false;
                                        }
                                        // Check this bunk has a free gap at that exact time
                                        const gaps = getFreeGaps(bunk, a.startMin, a.endMin);
                                        return gaps.some(g => g.start <= a.startMin && g.end >= a.endMin);
                                    });
                                    if (existingSession) {
                                        position = { start: existingSession.startMin, end: existingSession.endMin };
                                    }
                                }

                                // No existing session to join — find a fresh gap
                                if (!position) {
                                    position = candidate.duration
                                        ? (findBestGapPosition(bunk, specialStaggeredStart, windowEnd, candidate.duration) ||
                                           findBestGapPosition(bunk, windowStart, specialStaggeredStart, candidate.duration))
                                        : (findFlexGapPosition(bunk, specialStaggeredStart, windowEnd) ||
                                           findFlexGapPosition(bunk, windowStart, windowEnd));
                                    // Snap to 5-min boundary
                                    if (position) {
                                        const snapped = snapTo5(position.start);
                                        const dur = position.end - position.start;
                                        position = { start: snapped, end: snapped + dur };
                                    }

                                    // ★ Cross-grade conflict check
                                    // If this position overlaps with a different grade doing the same special,
                                    // and sharing rules don't allow it — reject and try next candidate
                                    if (position && sharableType !== 'all') {
                                        const crossGradeConflict = (tracker2?.assignments || []).some(a => {
                                            if (gradeBunks.includes(String(a.bunk))) return false; // same grade — ok
                                            return a.startMin < position.end && a.endMin > position.start;
                                        });
                                        if (crossGradeConflict) {
                                            usedExclusions.add(candidate.name);
                                            position = null;
                                        }
                                    }
                                }
                                if (!position) {
                                    // No gap fits this candidate — try next
                                    usedExclusions.add(candidate.name);
                                    continue;
                                }

                                // Post-position capacity check
                                const tracker = specialCapacityTracker[candidate.name];
                                const overlappingNow = tracker ? tracker.assignments.filter(a =>
                                    a.startMin < position.end && a.endMin > position.start
                                ).length : 0;

                               
                            if (tracker && overlappingNow >= tracker.total) {
                                    // At capacity at this time — try next special
                                    usedExclusions.add(candidate.name);
                                    continue;
                                }

                                // ✅ Found a candidate that fits — claim and place
                                claimSpecial(bunk, candidate, position.start, position.end);
                                placed = true;
                            placeTentativeBlock(bunk, {
                                startMin: position.start,
                                endMin:   position.end,
                                type:     'special',
                                event:    candidate.name,
                                layer,
                                _classification,
                                _assignedSpecial: candidate.name,
                                _specialDuration: candidate.duration,
                                _specialLocation: candidate.location,
                                _activityLocked:  true,
                                _bunkOverride:    true
                            });
                            need.placed++;
                            madeProgress = true;
                            } // end while (!placed)

                        } else {
                            // ── NON-SPECIAL (swim, sport, league, etc.) ──
                            // Stagger start position by bunk index to spread activities across the day
                            const allBunksList = gradeSortedForPlacement.flatMap(g => getBunksForGrade(g, divisions));
                            const bunkIdx = allBunksList.indexOf(bunk);
                            const windowSize = windowEnd - windowStart;
                            const staggerOffset = windowSize > 0
                                ? Math.floor((bunkIdx / allBunksList.length) * windowSize)
                                : 0;
                            const staggeredStart = windowStart + snapTo5(staggerOffset);

                            // Try staggered start first, fall back to first available gap
                            const position = duration
                                ? (findBestGapPosition(bunk, staggeredStart, windowEnd, duration) ||
                                   findBestGapPosition(bunk, windowStart, staggeredStart, duration) ||
                                   findBestGapPosition(bunk, windowStart, windowEnd, duration))
                                : (findFlexGapPosition(bunk, staggeredStart, windowEnd) ||
                                   findFlexGapPosition(bunk, windowStart, windowEnd));
                            if (!position) continue;

                            if (!hasActivityCapacity(type, position.start, position.end)) {
                                // Check if capacity opens up later in this bunk's window
                                const dur = duration || (position.end - position.start);
                                if (willHaveCapacityLater(type, position.end, windowEnd, dur)) {
                                    continue; // wait for next round
                                }
                                // No future capacity — place anyway (unlimited effective cap)
                            }

                            claimActivitySlot(type, bunk, position.start, position.end);
                            placeTentativeBlock(bunk, {
                                startMin: position.start,
                                endMin:   position.end,
                                type,
                                event,
                                layer,
                                _classification,
                                _activityLocked: true
                            });
                            need.placed++;
                            madeProgress = true;
                        }
                    }
                }
            }
        }

        log('[STEP 2.3] ✅ Round-robin complete after ' + roundCount + ' rounds');

       log('[STEP 2.3] ✅ Tentative placement complete');
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
                                bunk, layer.startMin, layer.endMin, candidate.duration
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
                    placeTentativeBlock(bunk, {
                        startMin: gap.start,
                        endMin: gap.end,
                        type: 'slot',
                        event: 'General Activity Slot',
                        layer: null,
                        _classification: 'gap',
                        _fromGapDetection: true,
                        _committed: true
                    });
                    gapsFilled++;
                });
            });
        });

        log('[STEP 2.5] ✅ Filled ' + gapsFilled + ' gaps with General Activity Slot');

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
                        _activityLocked: block._activityLocked || false,
                        _bunkOverride: block._bunkOverride || false,
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

                       schedulableSlotBlocks.push({
                            divName: grade,
                            bunk: String(bunk),
                            event: block.event || 'General Activity Slot',
                            type: block.type || 'slot',
                            startTime: minutesToTimeLabel(block.startMin),
                            endTime: minutesToTimeLabel(block.endMin),
                            slots: [slotIdx],
                            _durationStrict: false,
                            _autoGenerated: true,
                            _suggestedActivity: null,
                            _fromGapDetection: block._fromGapDetection || false,
                            _perBunkSlot: true
                        });
                    });
            });
        });

        log('[STEP 2.7] Built ' + schedulableSlotBlocks.length + ' schedulable blocks for solver');
        log('[STEP 2] ✅ Live iterative solver complete');

        // =====================================================================
// STEP 3 — LEAGUE ENGINES
// =====================================================================
// Build yesterdayHistory for league engine context
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

const leagueBlocks = schedulableSlotBlocks.filter(b =>
    b.type === 'league' || b.type === 'specialty_league'
);

if (leagueBlocks.length > 0) {

    const leagueContext = {
        schedulableSlotBlocks: leagueBlocks,
        fieldUsageBySlot,
        activityProperties,
        masterLeagues: window.masterLeagues || [],
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
            // Find the actual league divisions this league covers
            // (Senior Leagues covers both 5th and 6th Grade)
            const league = (Array.isArray(window.masterLeagues) ? window.masterLeagues : Object.values(window.masterLeagues || {})).find(l => l.name === leagueName);
            const coveredDivisions = (league?.divisions || [leagueName]).filter(d =>
                autoSkeleton.some(b => b.division === d && b.type === 'league')
            );
            const targetDivisions = coveredDivisions.length > 0 ? coveredDivisions : [divName];

            targetDivisions.forEach(div => {
                // Find the league block startMin for this division from skeleton
                const leagueBlock = autoSkeleton.find(b =>
                    b.division === div && b.type === 'league'
                );
                if (!leagueBlock) return;

                if (!window.leagueAssignments[div]) window.leagueAssignments[div] = {};
                // Key by startMin instead of slot index — bridge resolves by time
                window.leagueAssignments[div][leagueBlock.startMin] = {
                    matchups: matchups || [],
                    gameLabel: gameLabel || '',
                    sport: sport || '',
                    leagueName: leagueName || ''
                };
            });
        }
        }
    };

    // Specialty leagues first
    if (window.SchedulerCoreSpecialtyLeagues?.processSpecialtyLeagues) {
        try {
            leagueContext.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'specialty_league');
            window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(leagueContext);
            log('[STEP 3] Specialty leagues complete');
        } catch (e) {
            warn('[STEP 3] Specialty league error: ' + e.message);
        }
    }

    // Regular leagues
    if (window.SchedulerCoreLeagues?.processRegularLeagues) {
        try {
            leagueContext.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'league');
            window.SchedulerCoreLeagues.processRegularLeagues(leagueContext);
            log('[STEP 3] Regular leagues complete');
        } catch (e) {
            warn('[STEP 3] Regular league error: ' + e.message);
        }
    }

    // ★★★ FIX: Bridge leagueAssignments[gradeName] → scheduleAssignments[bunk]
    // leagueAssignments is keyed by grade name from storeLeagueMatchups,
    // but scheduleAssignments is keyed by bunk number. Bridge via _perBunkSlots.
    if (window.leagueAssignments) {
        let leagueWriteCount = 0;
        Object.entries(window.leagueAssignments).forEach(([gradeName, gradeSlots]) => {
            const perBunkSlots = window.divisionTimes?.[gradeName]?._perBunkSlots;
            if (!perBunkSlots) return;
            Object.entries(gradeSlots).forEach(([startMinKey, assignment]) => {
                const targetStartMin = parseInt(startMinKey);
                Object.entries(perBunkSlots).forEach(([bunkId, bunkSlots]) => {
                    const finalIdx = bunkSlots.findIndex(s => s.startMin === targetStartMin);
                    if (finalIdx === -1 || !window.scheduleAssignments[bunkId]) return;
                    window.scheduleAssignments[bunkId][finalIdx] = {
                        field: assignment.sport || 'League Game',
                        sport: assignment.sport || null,
                        _activity: 'League Game',
                        _league: true,
                        _leagueName: assignment.leagueName || '',
                        _gameLabel: assignment.gameLabel || '',
                        matchups: assignment.matchups || [],
                        _fixed: false,
                        continuation: false
                    };
                    leagueWriteCount++;
                });
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
        log('[STEP 4] Special blocks are already locked — solver will skip filled slots');

        if (window.TotalSolverEngine && window.TotalSolverEngine.run) {
            try {
                await window.TotalSolverEngine.run({
                    schedulableSlotBlocks: solverBlocks,
                    divisions,
                    activityProperties,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    isRainy,
                    allowedDivisions: allowedSet ? [...allowedSet] : null
                });
                log('[STEP 4] ✅ Total Solver complete');
            } catch (e) {
                err('[STEP 4] Total Solver error: ' + e.message);
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
                window.saveCurrentDailyData({
                    scheduleAssignments: window.scheduleAssignments,
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
