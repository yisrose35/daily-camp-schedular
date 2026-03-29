// =============================================================================
// scheduler_core_auto.js — CAMPISTRY AUTO SCHEDULER CORE v3.0
// =============================================================================
// WHAT → WHEN → WHERE Architecture
//
// Phase 0: Place all PINNED layers (whatever the user pinned — any type)
// Phase 1: Build exhaustive ranked activity lists per bunk (the WHAT)
// Phase 2: Draft-style assignment with live field ledger (the WHERE)
// Phase 3: DAP per-bunk day partition with zero dead space (the WHEN)
// Phase 4: Execute templates into bunkTimelines
//
// INTELLIGENCE SYSTEMS:
//   CEL  — Constraint Enforcement Layer (duration validation)
//   MRC  — Multi-Bunk Resource Coordination (shared resource staggering)
//   CIL  — Cross-Iteration Learning (remembers what worked)
//
// KEY PRINCIPLES:
//   - NOTHING is hardcoded by type. Layer CLASSIFICATION (pinned/windowed/open)
//     drives behavior. Lunch can be windowed. Sport can be pinned. 
//   - Specials with configured durations override layer dMin/dMax.
//     Specials WITHOUT configured durations use layer dMin/dMax as a range.
//   - Every sport/special priority list is EXHAUSTIVE — never runs dry.
//   - Leagues + full-grade activities are always grade-wide (inherent to type).
//   - Field capacity is resolved BEFORE time placement, not after.
//
// PIPELINE (external interface unchanged):
//   Step 0    — Wipe clean
//   Step 1    — Load data + classify layers
//   Step 2    — Phase 0→1→2→3→4 + safety nets + validate + formalize
//   Step 3    — League engines
//   Step 4    — Total Solver (mostly rubber-stamping draft results)
//   Step 5    — Save + fire campistry-generation-complete
// =============================================================================

(function () {
    'use strict';

    const VERSION = '3.0.0';
    const TAG = '[AutoCore]';

    function log(msg, ...args) { console.log(TAG + ' ' + msg, ...args); }
    function warn(msg, ...args) { console.warn(TAG + ' ⚠️ ' + msg, ...args); }
    function err(msg, ...args) { console.error(TAG + ' ❌ ' + msg, ...args); }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function uid() { return 'ac_' + Math.random().toString(36).slice(2, 9); }

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

    function computeRatio(layer) {
        const win = (layer.endMin || 0) - (layer.startMin || 0);
        if (win <= 0) return 1;
        const dur = layer.periodMin || layer.duration || layer.durationMin || 0;
        if (dur === 0 && win <= 30) return 1;
        return dur / win;
    }

    function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
    function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }
    function snapTo5(val) { return Math.round(val / 5) * 5; }
    // Grace: fixed-duration blocks (dMin===dMax) get 0 grace. Flex blocks get +5.
    function dMaxWithGrace(constraints) { return constraints.dMax + (constraints.dMin === constraints.dMax ? 0 : 5); }

    // =========================================================================
    // DATA ACCESS HELPERS
    // =========================================================================

    function getGlobalSettings() { return window.loadGlobalSettings ? window.loadGlobalSettings() : {}; }
    function getSpecialActivitiesList(gs) { return (gs.app1 && gs.app1.specialActivities) || []; }

    function getSpecialConfig(specialName, gs) {
        const specials = getSpecialActivitiesList(gs);
        return specials.find(s => s.name && s.name.toLowerCase().trim() === specialName.toLowerCase().trim()) || null;
    }

    function getFields(gs) { return (gs.app1 && gs.app1.fields) || gs.fields || []; }
    function getBunksForGrade(grade, divisions) { return (divisions[grade] && divisions[grade].bunks) ? [...divisions[grade].bunks] : []; }

    function getDivisionTimes(grade, divisions) {
        const div = divisions[grade];
        if (!div) return { start: 540, end: 960 };
        return {
            start: (div.startTime ? parseTimeToMinutes(div.startTime) : 540) || 540,
            end: (div.endTime ? parseTimeToMinutes(div.endTime) : 960) || 960
        };
    }

    // =========================================================================
    // SPECIAL ACTIVITY HELPERS
    // =========================================================================

    function getSpecialTimeWindow(cfg) {
        if (!cfg) return null;
        const start = cfg.availableFrom || cfg.windowStart || cfg.startTime;
        const end = cfg.availableTo || cfg.windowEnd || cfg.endTime;
        if (start && end) {
            return { startMin: typeof start === 'number' ? start : parseTimeToMinutes(start), endMin: typeof end === 'number' ? end : parseTimeToMinutes(end) };
        }
        if (Array.isArray(cfg.timeRules) && cfg.timeRules.length > 0) {
            const available = cfg.timeRules.filter(r => r.type === 'Available' || !r.type);
            if (available.length > 0) {
                let earliest = Infinity, latest = -Infinity;
                available.forEach(r => {
                    const rs = r.startMin != null ? r.startMin : parseTimeToMinutes(r.start);
                    const re = r.endMin != null ? r.endMin : parseTimeToMinutes(r.end);
                    if (rs != null && rs < earliest) earliest = rs;
                    if (re != null && re > latest) latest = re;
                });
                if (earliest < Infinity && latest > -Infinity) return { startMin: earliest, endMin: latest };
            }
        }
        return null;
    }

    function getSpecialDuration(specialName, activityProperties, gs, layer) {
        const props = activityProperties && activityProperties[specialName];
        if (props) { const d = props.defaultDuration || props.duration || props.durationMin || props.periodMin; if (d && parseInt(d, 10) > 0) return parseInt(d, 10); }
        const cfg = getSpecialConfig(specialName, gs);
        if (cfg) { const d = cfg.defaultDuration || cfg.duration || cfg.durationMin || cfg.periodMin; if (d && parseInt(d, 10) > 0) return parseInt(d, 10); }
        if (window.getSpecialActivityByName) { const live = window.getSpecialActivityByName(specialName); if (live) { const d = live.defaultDuration || live.duration || live.durationMin; if (d && parseInt(d, 10) > 0) return parseInt(d, 10); } }
        // ★ Return null if no specific duration — caller uses layer dMin/dMax
        return null;
    }

    function getSpecialCapacity(specialName, activityProperties, gs) {
        const cfg = getSpecialConfig(specialName, gs);
        if (cfg) {
            if (cfg.sharableWith) { if (cfg.sharableWith.type === 'not_sharable') return 1; const c = parseInt(cfg.sharableWith.capacity); if (!isNaN(c) && c > 0) return c; }
            const c = parseInt(cfg.capacity) || parseInt(cfg.maxBunks); if (!isNaN(c) && c > 0) return c;
        }
        const props = activityProperties && activityProperties[specialName];
        if (props) {
            if (props.sharableWith) { if (props.sharableWith.type === 'not_sharable') return 1; if (props.sharableWith.capacity) return parseInt(props.sharableWith.capacity) || 1; }
            if (props.capacity) return parseInt(props.capacity); if (props.maxBunks) return parseInt(props.maxBunks);
        }
        return 2;
    }

    function isScarce(specialName, dayName, gs) {
        const cfg = getSpecialConfig(specialName, gs);
        if (!cfg) return false;
        if (!isSpecialAvailableOnDay(specialName, dayName, false, gs)) return false;
        return !!((cfg.availableDays && cfg.availableDays.length > 0) || cfg.dayAvailability || cfg.mustScheduleWhenAvailable);
    }

    function isSpecialAvailableOnDay(specialName, dayName, isRainy, gs) {
        const cfg = getSpecialConfig(specialName, gs);
        if (!cfg) return true;
        if (!isRainy && cfg.rainyDayOnly) return false;
        if (isRainy && cfg.availableOnRainyDay === false) return false;
        if (Array.isArray(cfg.availableDays) && cfg.availableDays.length > 0) return cfg.availableDays.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
        if (cfg.dayAvailability) {
            const da = cfg.dayAvailability;
            if (typeof da === 'object' && !Array.isArray(da)) return da[dayName] !== false;
            if (Array.isArray(da)) return da.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
        }
        return true;
    }

    function isSpecialAvailableForDivision(specialName, divName, gs) {
        const cfg = getSpecialConfig(specialName, gs);
        if (!cfg) return true;
        const rules = cfg.limitUsage;
        if (!rules || !rules.enabled) return true;
        const allowed = rules.divisions;
        if (!allowed || typeof allowed !== 'object') return true;
        if (Array.isArray(allowed)) return allowed.includes(divName);
        return divName in allowed;
    }

    function getLocationForSpecial(specialName, activityProperties, gs) {
        const props = activityProperties && activityProperties[specialName];
        if (props && props.location) return props.location;
        const cfg = getSpecialConfig(specialName, gs);
        return (cfg && cfg.location) ? cfg.location : null;
    }

    function registerSpecialFieldUsage(slotIndices, fieldName, bunkName, activityName, divName, fieldUsageBySlot) {
        for (const slotIdx of slotIndices) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fieldName]) fieldUsageBySlot[slotIdx][fieldName] = { count: 0, divisions: [], bunks: {}, _locked: false };
            fieldUsageBySlot[slotIdx][fieldName].count++;
            fieldUsageBySlot[slotIdx][fieldName].bunks[bunkName] = activityName;
            if (divName && !fieldUsageBySlot[slotIdx][fieldName].divisions.includes(divName)) fieldUsageBySlot[slotIdx][fieldName].divisions.push(divName);
        }
    }

    function sortGradesByConstraint(grades, layersByGrade, specialRanking) {
        return [...grades].sort((a, b) => {
            const aSpecial = (layersByGrade[a] || []).filter(l => l.type === 'special').length;
            const bSpecial = (layersByGrade[b] || []).filter(l => l.type === 'special').length;
            const aOptions = (specialRanking[a] || []).length;
            const bOptions = (specialRanking[b] || []).length;
            return (bSpecial - aSpecial) || (aOptions - bOptions);
        });
    }


    // =========================================================================
    // MAIN ENTRY POINT
    // =========================================================================

    window.runAutoScheduler = async function (layers, options) {
        options = options || {};
        log('═══════════════════════════════════════════════════════════');
        log('AUTO SCHEDULER v' + VERSION + ' — WHAT→WHEN→WHERE Engine');
        log('═══════════════════════════════════════════════════════════');
        const startTime = Date.now();
        const warnings = [];

        // =====================================================================
        // STEP 0 — WIPE CLEAN
        // =====================================================================
        log('\n[STEP 0] Wiping clean...');
        window._preGenClearActive = true;
        window._divisionTimesLocked = false;
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window.fieldUsageBySlot = {};
        window.locationUsageBySlot = {};
        if (window.GlobalFieldLocks) window.GlobalFieldLocks.reset();
        if (window.RotationEngine && window.RotationEngine.rebuildAllHistory) window.RotationEngine.rebuildAllHistory();
        log('[STEP 0] ✅ Wiped');

        // =====================================================================
        // STEP 1 — LOAD DATA
        // =====================================================================
        log('\n[STEP 1] Loading...');
        if (!layers || layers.length === 0) { err('No layers'); window._preGenClearActive = false; return false; }

        const globalSettings = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        const divisions = window.divisions || (globalSettings.app1 && globalSettings.app1.divisions) || {};
        const activityProperties = window.activityProperties || {};
        const dailyData = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
        if (window.isRainyDay === undefined) window.isRainyDay = dailyData.rainyDayMode === true || dailyData.isRainyDay === true;
        const isRainy = !!window.isRainyDay;

        const currentDate = window.currentScheduleDate || window.currentDate || '';
        let dayName = 'Monday';
        if (currentDate) { const parts = currentDate.split('-').map(Number); const dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay(); dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow]; }

        const allDailyData = window.loadAllDailyData ? window.loadAllDailyData() : {};

        // Period helpers (unchanged from v2)
        function getMondayOfWeek(dateStr, weeksBack) {
            if (!dateStr) return null;
            const parts = dateStr.split('-').map(Number);
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            const dow = d.getDay(); const daysToMon = dow === 0 ? 6 : dow - 1;
            d.setDate(d.getDate() - daysToMon - (weeksBack * 7));
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        function getHalfStartDate() {
            const s = globalSettings.app1 || globalSettings;
            return s.halfStartDate || s.currentHalfStart || s.sessionHalfStart || (Object.keys(allDailyData).sort()[0] || null);
        }
        function getPeriodStartDate(period) {
            switch (period) { case '1week': return getMondayOfWeek(currentDate, 0); case '2weeks': return getMondayOfWeek(currentDate, 1); case '3weeks': return getMondayOfWeek(currentDate, 2); case '4weeks': return getMondayOfWeek(currentDate, 3); default: return getHalfStartDate(); }
        }
        function getPeriodCount(bunk, specialName, maxUsagePeriod) {
            const periodStart = getPeriodStartDate(maxUsagePeriod || 'half');
            let count = 0;
            Object.entries(allDailyData).forEach(([dateKey, dayData]) => {
                if (dateKey >= currentDate) return; if (periodStart && dateKey < periodStart) return;
                const slots = dayData?.scheduleAssignments?.[bunk]; if (!Array.isArray(slots)) return;
                if (slots.some(e => e && !e.continuation && (e._activity === specialName || e.field === specialName))) count++;
            });
            return count;
        }

        log('[STEP 1] Day: ' + dayName + ' | Rainy: ' + (isRainy ? 'YES' : 'NO'));
        const allowedDivisions = options.allowedDivisions || null;
        const allowedSet = allowedDivisions ? new Set(allowedDivisions.map(String)) : null;

        const allSpecials = getSpecialActivitiesList(globalSettings);
        const todaysSpecials = allSpecials.filter(s => isSpecialAvailableOnDay(s.name, dayName, isRainy, globalSettings));
        const scarceSpecials = todaysSpecials.filter(s => isScarce(s.name, dayName, globalSettings));
        log('[STEP 1] Specials: ' + todaysSpecials.length + ' (' + scarceSpecials.length + ' scarce)');

        const fieldUsageBySlot = window.fieldUsageBySlot;

        // =====================================================================
        // STEP 1.5 — CLASSIFY LAYERS
        // =====================================================================
        // ★ Classification drives ALL behavior. Type does NOT determine
        //   whether something is pinned/windowed/open. The user's layer
        //   definition determines that via the ratio.
        // =====================================================================
        log('\n[STEP 1.5] Classifying layers...');

        const layersByGrade = {};
        layers.forEach(layer => {
            const grade = layer.grade || layer.division || '_all';
            if (!layersByGrade[grade]) layersByGrade[grade] = [];
            layersByGrade[grade].push(layer);
        });

        const classified = layers.map(layer => {
            const ratio = computeRatio(layer);
            let classification;
            if (ratio >= 1) classification = 'pinned';
            else if (ratio >= 0.10) classification = 'windowed';
            else classification = 'open';
            return Object.assign({}, layer, { _classification: classification, _ratio: ratio });
        });

        const classOrder = { pinned: 0, windowed: 1, open: 2 };
        classified.sort((a, b) => {
            const cd = classOrder[a._classification] - classOrder[b._classification];
            return cd !== 0 ? cd : b._ratio - a._ratio;
        });

        const pinnedLayers = classified.filter(l => l._classification === 'pinned');
        const windowedLayers = classified.filter(l => l._classification === 'windowed');
        const openLayers = classified.filter(l => l._classification === 'open');
        const nonPinnedLayers = [...windowedLayers, ...openLayers];

        log('[STEP 1.5] ' + pinnedLayers.length + ' pinned, ' + windowedLayers.length + ' windowed, ' + openLayers.length + ' open');

        const allGrades = Object.keys(divisions).filter(g => !allowedSet || allowedSet.has(String(g)));

        // =====================================================================
        // MUTABLE STATE
        // =====================================================================
        const bunkTimelines = {};
        const bunkSpecialQueues = {};
        const bunkSpecialAssigned = {};
        const specialCapacityTracker = {};
        const sharedLeagueTime = {};
        let staggerPlan = {};

        // ── Cross-grade activity tracker ─────────────────────────────
        // Tracks what each grade is doing at each time to prevent contention.
        // Key: time bucket (5-min rounded). Value: { league: [grades], swim: [grades], special: [grades], snack: [grades], 'special:Name': [grades] }
        const crossGradeTracker = {};
        function registerCrossGrade(grade, type, startMin, endMin, eventName) {
            const t = (type || '').toLowerCase();
            const trackTypes = ['league', 'swim', 'special', 'snacks', 'snack'];
            if (!trackTypes.includes(t)) return;
            const key = t === 'snack' ? 'snacks' : t;
            for (let m = startMin; m < endMin; m += 5) {
                if (!crossGradeTracker[m]) crossGradeTracker[m] = {};
                if (!crossGradeTracker[m][key]) crossGradeTracker[m][key] = [];
                if (!crossGradeTracker[m][key].includes(grade)) crossGradeTracker[m][key].push(grade);
                // Also track by specific event name for specials
                if (t === 'special' && eventName) {
                    const nameKey = 'special:' + eventName.toLowerCase();
                    if (!crossGradeTracker[m][nameKey]) crossGradeTracker[m][nameKey] = [];
                    if (!crossGradeTracker[m][nameKey].includes(grade)) crossGradeTracker[m][nameKey].push(grade);
                }
            }
        }
        function getCrossGradeConflicts(type, startMin, endMin, excludeGrade, eventName) {
            const t = (type || '').toLowerCase();
            // For specials: check the specific name if provided
            const key = (t === 'special' && eventName) ? 'special:' + eventName.toLowerCase() : (t === 'snack' ? 'snacks' : t);
            let conflicts = 0;
            for (let m = startMin; m < endMin; m += 5) {
                const bucket = crossGradeTracker[m];
                if (!bucket || !bucket[key]) continue;
                conflicts += bucket[key].filter(g => g !== excludeGrade).length;
            }
            return conflicts;
        }
        function resetCrossGradeTracker() {
            Object.keys(crossGradeTracker).forEach(k => delete crossGradeTracker[k]);
            Object.keys(specialUsageTracker).forEach(k => delete specialUsageTracker[k]);
        }

        // ── Special capacity tracker ─────────────────────────────────
        // Tracks per-special, per-5min-bucket: { count, grades: Set }
        // Used by greedyPackBunk to enforce capacity + cross-division rules.
        const specialUsageTracker = {};
        function registerSpecialUsage(specialName, grade, startMin, endMin) {
            const key = (specialName || '').toLowerCase();
            if (!key) return;
            for (let m = startMin; m < endMin; m += 5) {
                if (!specialUsageTracker[m]) specialUsageTracker[m] = {};
                if (!specialUsageTracker[m][key]) specialUsageTracker[m][key] = { count: 0, grades: new Set() };
                specialUsageTracker[m][key].count++;
                specialUsageTracker[m][key].grades.add(grade);
            }
        }
       function canUseSpecialAtTime(specialName, grade, startMin, endMin) {
            const key = (specialName || '').toLowerCase();
            if (!key) return true;

            // ★★★ FIX v3.2: Robust config lookup + enforce ALL sharing types ★★★
            let sProps = activityProperties[specialName] || {};
            let shareType = sProps.sharableWith?.type;
            let cap = sProps.sharableWith?.capacity;

            // Fallback: if activityProperties has empty/missing sharableWith, try globalSettings
            if (!shareType) {
                const cfg = getSpecialConfig(specialName, globalSettings);
                if (cfg?.sharableWith?.type) {
                    shareType = cfg.sharableWith.type;
                    cap = parseInt(cfg.sharableWith.capacity) || (shareType === 'not_sharable' ? 1 : 2);
                }
            }
            shareType = shareType || 'not_sharable';
            cap = parseInt(cap) || 1;

            // ★ TEMP DEBUG: Log cross-div checks for specials
            if (key === 'painting' || key === 'bubble lady') {
                let hasOtherGrade = false;
                for (let dm = startMin; dm < endMin; dm += 5) {
                    const db = specialUsageTracker[dm]?.[key];
                    if (db && db.grades.size > 0 && !db.grades.has(grade)) { hasOtherGrade = true; break; }
                }
                console.log(`[P0-XDIV] canUseSpecialAtTime("${specialName}", "${grade}", ${startMin}-${endMin}) shareType=${shareType} cap=${cap} otherGradeBlocking=${hasOtherGrade} trackerBuckets=${Object.keys(specialUsageTracker).length}`);
            }

            for (let m = startMin; m < endMin; m += 5) {                const bucket = specialUsageTracker[m]?.[key];
                if (!bucket) continue;

                // Capacity check (all sharing types)
                if (bucket.count >= cap) return false;

                // Cross-division enforcement for not_sharable
                if (shareType === 'not_sharable' && bucket.grades.size > 0) {
                    if (!bucket.grades.has(grade)) return false;
                }

                // Cross-division enforcement for same_division
                if (shareType === 'same_division' && bucket.grades.size > 0) {
                    if (!bucket.grades.has(grade)) return false;
                }

                // Cross-division enforcement for custom
                if (shareType === 'custom' && bucket.grades.size > 0) {
                    if (!bucket.grades.has(grade)) {
                        const allowedDivs = sProps.sharableWith?.divisions || [];
                        const existingGrades = [...bucket.grades];
                        const allAllowed = existingGrades.every(g => allowedDivs.includes(g)) && allowedDivs.includes(grade);
                        if (!allAllowed) return false;
                    }
                }
            }
            return true;
        }

        // =====================================================================
        // CEL — CONSTRAINT ENFORCEMENT LAYER
        // Single source of truth for dMin/dMax/dIdeal.
        // =====================================================================
        const GAP_MIN_DUR = 20;
        const GAP_MAX_DUR = 60;
        const FIELD_CAPACITY = 26;
        const CONTENTION_SLICE = 10;

        const TYPE_FLOORS = { swim: 30, league: 30, specialty_league: 30, special: 20, sport: 25, sports: 25, lunch: 20, snack: 15, snacks: 15, dismissal: 10, slot: GAP_MIN_DUR, activity: GAP_MIN_DUR, elective: 20 };
        const TYPE_CEILINGS = { swim: 60, league: 60, specialty_league: 60, special: 60, sport: GAP_MAX_DUR, sports: GAP_MAX_DUR, lunch: 45, snack: 30, snacks: 30, dismissal: 30, slot: GAP_MAX_DUR, activity: GAP_MAX_DUR, elective: 60 };

        function resolveConstraints(layer, type, block) {
            const t = (type || layer?.type || 'slot').toLowerCase();
            const typeFloor = TYPE_FLOORS[t] || GAP_MIN_DUR;
            const typeCeiling = TYPE_CEILINGS[t] || GAP_MAX_DUR;
            if (!layer) return { dMin: typeFloor, dMax: typeCeiling, dIdeal: snapTo5(Math.round((typeFloor + typeCeiling) / 2)) };

            const rawMin = layer.durationMin || layer.periodMin || layer.duration || 0;
            const rawMax = layer.durationMax || layer.periodMin || layer.duration || 0;
            // ★ User's explicit layer value WINS over type floor.
            // Type floor is only a fallback when the user didn't set anything.
            // Absolute floor of 5min prevents truly insane values.
            const ABSOLUTE_FLOOR = 5;
            let dMin = rawMin > 0 ? Math.max(ABSOLUTE_FLOOR, rawMin) : typeFloor;
            let dMax = Math.max(dMin, rawMax > 0 ? Math.max(ABSOLUTE_FLOOR, rawMax) : typeCeiling);

           // ★ Special override: if a SPECIFIC special has its own duration, use that
            // If not, the layer dMin/dMax range applies (flexible special)
            if (t === 'special') {
                let specDur = null;
                if (layer) {
                    const specName = layer._assignedSpecial || layer._resolvedSpecial || layer.event || layer.name;
                    if (specName) specDur = getSpecialDuration(specName, activityProperties, globalSettings, null);
                }
               // Fallback: block-level _specialDuration (covers layer-null blocks from draft/fallback)
                if (!specDur && block && block._specialDuration) specDur = block._specialDuration;
                // Final fallback: look up by event name directly (covers needs/draft objects)
                if (!specDur && block) {
                    const eName = block.event || block._assignedSpecial || block._draftActivity || block.name;
                    if (eName) specDur = getSpecialDuration(eName, activityProperties, globalSettings, null);
                }
                if (specDur && specDur > 0) {
                    dMin = specDur;
                    dMax = specDur;
                }
            }

            return { dMin, dMax, dIdeal: snapTo5(Math.round((dMin + dMax) / 2)) };
        }

        function validateTimelineIntegrity(bunk) {
            const timeline = bunkTimelines[bunk] || [];
            const violations = [];
            timeline.forEach((block, i) => {
                if (block._fromGapDetection && !block.layer) return;
                if (block._microGap) return;
                const { dMin } = resolveConstraints(block.layer, (block.type || 'slot').toLowerCase(), block);
                const dur = block.endMin - block.startMin;
                if (dur < dMin) violations.push({ block, bunk, type: 'undersized', actual: dur, required: dMin, msg: (block.event || block.type) + ' at ' + block.startMin + ': ' + dur + 'min < min=' + dMin });
                if (i < timeline.length - 1 && block.endMin > timeline[i + 1].startMin) violations.push({ block, bunk, type: 'overlap', msg: block.event + ' overlaps ' + timeline[i + 1].event });
            });
            return violations;
        }

        log('[CEL] Initialized');

        // =====================================================================
        // MRC — MULTI-BUNK RESOURCE COORDINATION
        // Staggers shared resources (swim pool) across grades.
        // Only applies to layers classified as requiring shared resources.
        // =====================================================================
        const resourceCalendar = { swim: {} };

        function buildResourceCalendar(seed) {
            resourceCalendar.swim = {};
            // Find all grades that have a swim-type layer (regardless of classification)
            const swimGrades = [];
            allGrades.forEach(grade => {
                const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
                if (!swimLayer) return;
                // Only stagger non-pinned swim. Pinned swim is placed at exact time.
                if (computeRatio(swimLayer) >= 1) return;
                const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                const c = resolveConstraints(swimLayer, 'swim');
                swimGrades.push({
                    grade, swimLayer, dMin: c.dMin, dMax: c.dMax,
                    winStart: Math.max(swimLayer.startMin || 0, gs),
                    winEnd: Math.min(swimLayer.endMin || 1440, ge),
                    windowSize: Math.min(swimLayer.endMin || 1440, ge) - Math.max(swimLayer.startMin || 0, gs)
                });
            });

            if (swimGrades.length > 1) {
                swimGrades.sort((a, b) => a.windowSize - b.windowSize);
                const rot = seed % swimGrades.length;
                for (let r = 0; r < rot; r++) swimGrades.push(swimGrades.shift());

                const poolStart = Math.min(...swimGrades.map(g => g.winStart));
                const poolEnd = Math.max(...swimGrades.map(g => g.winEnd));
                const bandDur = Math.max(Math.min(...swimGrades.map(g => g.dMax)), snapTo5(Math.floor((poolEnd - poolStart) / swimGrades.length)));

                let cursor = poolStart;
                swimGrades.forEach(g => {
                    const bStart = Math.max(g.winStart, cursor);
                    const bEnd = Math.min(g.winEnd, bStart + bandDur);
                    resourceCalendar.swim[g.grade] = { start: bStart, end: bEnd, dMin: g.dMin, dMax: g.dMax };
                    cursor = bEnd;
                });
            }
        }

        function getSwimWindow(grade) { return resourceCalendar.swim[grade] || null; }
        log('[MRC] Initialized');

        // =====================================================================
        // CIL — CROSS-ITERATION LEARNING
        // =====================================================================
        const iterationMemory = { bestPerGrade: {} };

        function extractFragments(timelines, iterScore) {
            allGrades.forEach(grade => {
                const bunks = getBunksForGrade(grade, divisions);
                let gradeScore = 0;
                const typeTimings = {};
                bunks.forEach(bunk => {
                    const tl = timelines[bunk] || [];
                    const sorted = [...tl].sort((a, b) => a.startMin - b.startMin);
                    const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    if (sorted.length > 0 && sorted[0].startMin > gs) gradeScore += (sorted[0].startMin - gs) * 15;
                    for (let i = 0; i < sorted.length - 1; i++) { const gap = sorted[i + 1].startMin - sorted[i].endMin; if (gap > 0) gradeScore += gap * 15; }
                    tl.forEach(block => {
                        if (!block.layer) return;
                        const { dMin } = resolveConstraints(block.layer, block.type, block);
                        if (block.endMin - block.startMin < dMin) gradeScore += (dMin - (block.endMin - block.startMin)) * 200;
                        const t = (block.type || 'slot').toLowerCase();
                        if (!typeTimings[t]) typeTimings[t] = [];
                        typeTimings[t].push({ start: block.startMin, end: block.endMin });
                    });
                });
                const prev = iterationMemory.bestPerGrade[grade];
                if (!prev || gradeScore < prev.score) iterationMemory.bestPerGrade[grade] = { score: gradeScore, types: typeTimings, iteration: totalIters };
            });
        }

        function getLearnedPreference(grade, type, startMin, endMin) {
            const best = iterationMemory.bestPerGrade[grade];
            if (!best || !best.types[type]) return 0;
            let bestOverlap = 0;
            for (const frag of best.types[type]) {
                const overlap = Math.max(0, Math.min(frag.end, endMin) - Math.max(frag.start, startMin));
                const dur = endMin - startMin;
                bestOverlap = Math.max(bestOverlap, dur > 0 ? overlap / dur : 0);
            }
            return -Math.round(bestOverlap * 50);
        }

        log('[CIL] Initialized');


        // =====================================================================
        // FIELD LEDGER — Tracks every resource's real-time availability
        // Used by the Draft (Phase 2) to prevent field conflicts.
        // =====================================================================

        const fieldLedger = {};

        function initFieldLedger() {
            // Clear previous
            Object.keys(fieldLedger).forEach(k => delete fieldLedger[k]);

            const fields = getFields(globalSettings);
            const disabled = globalSettings.app1?.disabledFields || globalSettings.disabledFields || [];

            fields.forEach(field => {
                if (disabled.includes(field.name)) return;
                const props = activityProperties[field.name] || {};
                const timeRules = [];

                if (props.timeRules && Array.isArray(props.timeRules)) {
                    props.timeRules.forEach(rule => {
                        if (rule.type === 'Available' || !rule.type) {
                            timeRules.push({
                                startMin: rule.startMin ?? parseTimeToMinutes(rule.start),
                                endMin: rule.endMin ?? parseTimeToMinutes(rule.end),
                                divisions: rule.divisions || null
                            });
                        }
                    });
                }

                // Default: available all day
                if (timeRules.length === 0) {
                    const campStart = Math.min(...Object.values(divisions).map(d => parseTimeToMinutes(d.startTime) || 540));
                    const campEnd = Math.max(...Object.values(divisions).map(d => parseTimeToMinutes(d.endTime) || 990));
                    timeRules.push({ startMin: campStart, endMin: campEnd, divisions: null });
                }

                const capacity = props.capacity || props.sharableWith?.capacity || 2;
                const shareType = props.sharableWith?.type || 'same_division';

                fieldLedger[field.name] = {
                    name: field.name, capacity, shareType,
                    isIndoor: field.isIndoor || false,
                    timeRules, activities: field.activities || [],
                    claims: []
                };
            });

            // Add special activity locations that aren't already fields
            todaysSpecials.forEach(special => {
                const location = getLocationForSpecial(special.name, activityProperties, globalSettings);
                if (location && !fieldLedger[location]) {
                    const cap = getSpecialCapacity(special.name, activityProperties, globalSettings);
                    const cfg = getSpecialConfig(special.name, globalSettings);
                    fieldLedger[location] = {
                        name: location, capacity: cap,
                        shareType: cfg?.sharableWith?.type || 'not_sharable',
                        isIndoor: true, // assume indoor for special locations
                        timeRules: [{ startMin: 540, endMin: 990, divisions: null }],
                        activities: [special.name], claims: [],
                        _isSpecialLocation: true
                    };
                }
            });
        }

        function isFieldAvailable(fieldName, startMin, endMin, bunk, grade) {
            const ledger = fieldLedger[fieldName];
            if (!ledger) return false;

            // Rainy: no outdoor fields
            if (isRainy && !ledger.isIndoor) return false;

            // Time rules
            const timeOk = ledger.timeRules.some(rule => {
                if (rule.startMin > startMin || rule.endMin < endMin) return false;
                if (rule.divisions && !rule.divisions.includes(grade)) return false;
                return true;
            });
            if (!timeOk) return false;

            // Capacity
            const overlapping = ledger.claims.filter(c => c.startMin < endMin && c.endMin > startMin);
            if (overlapping.length >= ledger.capacity) return false;

            // Sharing rules
            if (ledger.shareType === 'not_sharable' && overlapping.length > 0) return false;
            if (ledger.shareType === 'same_division') {
                if (overlapping.some(c => c.grade !== grade)) return false;
            }

            return true;
        }

        function claimField(fieldName, startMin, endMin, bunk, grade, activity) {
            if (!isFieldAvailable(fieldName, startMin, endMin, bunk, grade)) return false;
            fieldLedger[fieldName].claims.push({ bunk, grade, activity, startMin, endMin });
            return true;
        }

        function unclaimField(fieldName, bunk, startMin) {
            const ledger = fieldLedger[fieldName];
            if (!ledger) return;
            const idx = ledger.claims.findIndex(c => c.bunk === bunk && c.startMin === startMin);
            if (idx !== -1) ledger.claims.splice(idx, 1);
        }

        // =====================================================================
        // HELPER: CONTENTION SCORING (for Phase 0 league/swim placement)
        // =====================================================================

        function isSpecialOnField(blockOrName) {
            const loc = typeof blockOrName === 'string'
                ? getLocationForSpecial(blockOrName, activityProperties, globalSettings)
                : (blockOrName._specialLocation || null);
            if (!loc) return false;
            const props = activityProperties[loc];
            if (props && props.type === 'field') return true;
            return (globalSettings?.app1?.fields || []).some(f => f.name === loc);
        }

        function getFieldImpact(block) {
            const t = (block.type || '').toLowerCase();
            if (['sport', 'sports', 'slot', 'league', 'specialty_league'].includes(t)) return 'consumer';
            if (t === 'swim') return 'reliever';
            if (t === 'special') return isSpecialOnField(block) ? 'consumer' : 'reliever';
            return 'neutral';
        }

        function getFieldDemand(startMin, endMin, excludeBunk) {
            let peakDemand = 0;
            for (let t = startMin; t < endMin; t += CONTENTION_SLICE) {
                const sliceEnd = Math.min(t + CONTENTION_SLICE, endMin);
                let demand = 0;
                for (const grade of allGrades) {
                    const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 660;
                    const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 990;
                    if (t >= ge || sliceEnd <= gs) continue;
                    for (const bk of getBunksForGrade(grade, divisions)) {
                        if (bk === excludeBunk) continue;
                        const tl = bunkTimelines[bk] || [];
                        let hasBlock = false, isCons = false;
                        for (const block of tl) {
                            if (block.startMin < sliceEnd && block.endMin > t) { hasBlock = true; if (getFieldImpact(block) === 'consumer') isCons = true; break; }
                        }
                        if (isCons) demand++;
                        else if (!hasBlock) demand++;
                    }
                }
                if (demand > peakDemand) peakDemand = demand;
            }
            return peakDemand;
        }

        function scorePositionByContention(startMin, endMin, blockType, excludeBunk, specialName) {
            const t = (blockType || '').toLowerCase();
            let impact = 'neutral';
            if (['sport', 'sports', 'slot', 'league', 'specialty_league'].includes(t)) impact = 'consumer';
            else if (t === 'swim') impact = 'reliever';
            else if (t === 'special') impact = (specialName && isSpecialOnField(specialName)) ? 'consumer' : 'reliever';

            if (impact === 'neutral') return 0;
            const demand = getFieldDemand(startMin, endMin, excludeBunk);
            let score = impact === 'reliever' ? -demand : demand;

            // CIL: learned preference
            if (totalIters >= 2 && excludeBunk) {
                const bunkGrade = Object.entries(divisions).find(([g, d]) => (d.bunks || []).map(String).includes(String(excludeBunk)))?.[0];
                if (bunkGrade) score += getLearnedPreference(bunkGrade, blockType, startMin, endMin);
            }
            return score;
        }

        // =====================================================================
        // HELPER: FREE GAP / PLACEMENT FUNCTIONS (used by Phase 0 + DAP)
        // =====================================================================

        function getFreeGaps(bunk, windowStart, windowEnd) {
            const timeline = bunkTimelines[bunk] || [];
            const occupied = timeline.filter(b => overlaps(b.startMin, b.endMin, windowStart, windowEnd))
                .map(b => ({ start: Math.max(b.startMin, windowStart), end: Math.min(b.endMin, windowEnd) }))
                .sort((a, b) => a.start - b.start);
            const gaps = [];
            let cursor = windowStart;
            for (const occ of occupied) { if (occ.start > cursor) gaps.push({ start: cursor, end: occ.start }); cursor = Math.max(cursor, occ.end); }
            if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
            return gaps.filter(g => g.end - g.start >= 5);
        }

        // ── Can a residual gap be filled by any block? ─────────────────
        // A residual (leftover space after placing a block) is viable ONLY if:
        //   - It's zero (no gap), OR
        //   - It's large enough for at least one type of block to fit
        // This is the fundamental rule that prevents unfillable gaps.
        const _minFillableByGrade = {};
        function getMinFillable(grade) {
            if (_minFillableByGrade[grade]) return _minFillableByGrade[grade];
            const gradeLayers = layersByGrade[grade] || [];
            let minD = Infinity;
            // Only consider types that actually fill open regions in DAP.
            // Swim, snacks, lunch, dismissal, league are anchors — they don't fill gaps.
            const fillerTypes = ['sport', 'sports', 'special', 'elective', 'activity', 'slot'];
            gradeLayers.forEach(l => {
                const t = (l.type || '').toLowerCase();
                if (!fillerTypes.includes(t)) return;
                const c = resolveConstraints(l, t);
                if (c.dMin < minD) minD = c.dMin;
            });
            if (minD === Infinity) minD = GAP_MIN_DUR;
            _minFillableByGrade[grade] = minD;
            return minD;
        }

        function isResidualViable(gapStart, gapEnd, blockStart, blockEnd, grade) {
            const before = blockStart - gapStart;
            const after = gapEnd - blockEnd;
            const minFill = grade ? getMinFillable(grade) : GAP_MIN_DUR;
            // Three zones for each residual:
            //   0          → perfect, no gap
            //   1 to 10    → absorbable (neighbors can stretch by this much)
            //   11 to minFill-1 → DEAD ZONE (too big to absorb, too small to fill)
            //   >= minFill  → fillable (a real block fits)
            const ABSORB_MAX = 10; // max minutes a neighbor can absorb
            if (before > ABSORB_MAX && before < minFill) return false;
            if (after > ABSORB_MAX && after < minFill) return false;
            return true;
        }

        function findBestGapPosition(bunk, windowStart, windowEnd, duration, blockType, specialName, grade) {
            const gaps = getFreeGaps(bunk, windowStart, windowEnd);
            const minFill = grade ? getMinFillable(grade) : GAP_MIN_DUR;
            let bestPos = null, bestScore = Infinity;
            for (const gap of gaps) {
                if (gap.end - gap.start < duration) continue;
                for (let cs = gap.start; cs <= gap.end - duration; cs += 5) {
                    if (!isResidualViable(gap.start, gap.end, cs, cs + duration, grade)) continue;
                    const score = scorePositionByContention(cs, cs + duration, blockType, bunk, specialName);
                    if (score < bestScore) { bestScore = score; bestPos = { start: cs, end: cs + duration }; }
                }
            }
            // Snap to gap edges only if residual would be unfillable
            if (bestPos) {
                const bestGap = gaps.find(g => g.start <= bestPos.start && g.end >= bestPos.end);
                if (bestGap) {
                    const beforeRes = bestPos.start - bestGap.start;
                    const afterRes = bestGap.end - bestPos.end;
                    if (beforeRes > 0 && beforeRes < minFill) bestPos.start = bestGap.start;
                    if (afterRes > 0 && afterRes < minFill) bestPos.end = bestGap.end;
                }
            }
            if (bestPos && (bestPos.start < windowStart || bestPos.end > windowEnd)) bestPos = null;
            return bestPos;
        }

        function placeTentativeBlock(bunk, block) {
            const grade = block.layer?.grade || block.layer?.division;
            if (grade && divisions[grade]) {
                const ds = parseTimeToMinutes(divisions[grade].startTime) || 540;
                const de = parseTimeToMinutes(divisions[grade].endTime) || 960;
                if (block.endMin <= ds || block.startMin >= de) return;
                if (block.startMin < ds) block.startMin = ds;
                if (block.endMin > de) block.endMin = de;
            }
            bunkTimelines[bunk].push(block);
            bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
        }

        function removeTentativeBlock(bunk, block) {
            const idx = (bunkTimelines[bunk] || []).indexOf(block);
            if (idx !== -1) bunkTimelines[bunk].splice(idx, 1);
        }

        // =====================================================================
        // TRANSITION TIME
        // =====================================================================

        function getTransitionTime(fromEvent, toEvent) {
            if (!window.getZoneForField) return 0;
            const fromZone = window.getZoneForField(fromEvent);
            const toZone = window.getZoneForField(toEvent);
            if (!fromZone || !toZone || fromZone.name === toZone.name) return 0;
            return (fromZone.transition?.postMin || 0) + (toZone.transition?.preMin || 0);
        }


        // =====================================================================
        // PHASE 0: PLACE ALL PINNED LAYERS
        // ★ "Pinned" means classification=pinned (ratio≥1), NOT a specific type.
        //   Any type can be pinned if the user defined it that way.
        // =====================================================================

        function executePinnedLayers() {
            let count = 0;
            pinnedLayers.forEach(layer => {
                const grade = layer.grade || layer.division;
                if (!grade || (allowedSet && !allowedSet.has(String(grade)))) return;
                const allBunks = getBunksForGrade(grade, divisions);
                if (!allBunks.length) return;

                const t = (layer.type || '').toLowerCase();
                const isGradeWide = t === 'league' || t === 'specialty_league' ||
                    (activityProperties[layer.event]?.fullGrade) || (activityProperties[layer.name]?.fullGrade);

                // ★ Custom layers: only place for selected bunks
                const isCustom = t === 'custom';
                const targetBunks = (isCustom && layer.customBunks && layer.customBunks.length > 0)
                    ? allBunks.filter(b => layer.customBunks.includes(String(b)))
                    : allBunks;

                const eventName = (isCustom && layer.customActivity) ? layer.customActivity : (layer.event || layer.name || layer.type || 'Pinned');

                // ★★★ FIX v3.3: Cross-division check for pinned specials ★★★
                const isSpecialType = t === 'special';
                if (isSpecialType && !canUseSpecialAtTime(eventName, grade, layer.startMin, layer.endMin)) {
                    return; // Skip — another grade already has this special at overlapping time
                }

                targetBunks.forEach(bunk => {
                    bunkTimelines[bunk].push({
                        startMin: layer.startMin, endMin: layer.endMin,
                        type: isCustom ? 'custom' : (layer.type || 'pinned'),
                        event: eventName,
                        layer, _classification: 'pinned', _committed: true, _fixed: true,
                        _gradeWide: isGradeWide && !isCustom,
                        _activityLocked: true, _noBacktrack: isGradeWide,
                        _customActivity: isCustom ? layer.customActivity : null,
                        _customField: isCustom ? layer.customField : null,
                        _customBunks: isCustom ? layer.customBunks : null
                    });
                    count++;
                });

                // ★★★ FIX v3.3: Register special usage for cross-grade tracking ★★★
                if (isSpecialType) {
                    registerSpecialUsage(eventName, grade, layer.startMin, layer.endMin);
                }

                // ★ Register custom field as occupied so solver/fallback doesn't use it
                if (isCustom && layer.customField) {
                    registerCrossGrade(grade, 'custom', layer.startMin, layer.endMin, layer.customActivity);
                }
            });
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin)));
            return count;
        }

        // ── League placement (for non-pinned leagues — they're always grade-wide) ──
        function placeLeagueForGrade(grade, layer) {
            const bunks = getBunksForGrade(grade, divisions);
            const { dMin, dMax } = resolveConstraints(layer, 'league');
            let dur = dMin; // start at minimum, expanded below if gap allows
            const leagueName = (() => {
                const league = (Array.isArray(window.masterLeagues) ? window.masterLeagues : Object.values(window.masterLeagues || {}))
                    .find(l => (l.divisions || []).includes(grade));
                return league ? league.name : null;
            })();

           // ★ Helper: expand league duration to fill gap up to dMax
            function expandLeagueDur(start, bunkList) {
                let nextWall = start + dMax;
                bunkList.forEach(bk => {
                    (bunkTimelines[bk] || []).forEach(b => {
                        if (b.startMin > start && b.startMin < nextWall) nextWall = b.startMin;
                    });
                });
                const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                if (ge < nextWall) nextWall = ge;
                let d = Math.max(dMin, Math.min(dMax, nextWall - start));
                d = snapTo5(d);
                return d < dMin ? dMin : d;
            }

            if (leagueName && sharedLeagueTime[leagueName] != null) {
                const ss = sharedLeagueTime[leagueName];
                const expandedDur = expandLeagueDur(ss, bunks);
                bunks.forEach(bunk => {
                    bunkTimelines[bunk].push({
                        startMin: ss, endMin: ss + expandedDur,
                        type: layer.type || 'league', event: layer.event || 'League Game',
                        layer, _classification: 'windowed', _committed: true,
                        _gradeWide: true, _activityLocked: true, _noBacktrack: true
                    });
                    bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
                });
                return ss;
            }

            let bestStart = null, bestScore = Infinity;
            const gradeStagger = staggerPlan[grade] || { offset: 0, searchDirection: 'early' };
            const searchReverse = gradeStagger.searchDirection === 'late';
            const times = [];
            for (let ts = layer.startMin; ts + dur <= layer.endMin; ts += 5) times.push(ts);
            if (searchReverse) times.reverse();

            for (const ts of times) {
                const te = ts + dur;
                if (!bunks.every(bk => !(bunkTimelines[bk] || []).some(b => b.startMin < te && b.endMin > ts))) continue;
                let score = scorePositionByContention(ts, te, 'league', null, null);
                const crossConflicts = getCrossGradeConflicts('league', ts, te, grade);
                score += crossConflicts * 10000;
                if (score < bestScore) { bestScore = score; bestStart = ts; }
            }
            if (bestStart === null) { warn('[P0] No free league gap for ' + grade); return null; }

            const expandedDur = expandLeagueDur(bestStart, bunks);
            bunks.forEach(bunk => {
                bunkTimelines[bunk].push({
                    startMin: bestStart, endMin: bestStart + expandedDur,
                    type: layer.type || 'league', event: layer.event || 'League Game',
                    layer, _classification: 'windowed', _committed: true,
                    _gradeWide: true, _activityLocked: true, _noBacktrack: true
                });
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
            });
            if (leagueName) sharedLeagueTime[leagueName] = bestStart;
            registerCrossGrade(grade, 'league', bestStart, bestStart + expandedDur);
            log('[P0] ' + grade + ' league at ' + minutesToTimeLabel(bestStart) + ' (' + expandedDur + 'min)');
            return bestStart;
        }

        // ── Swim placement (MRC-staggered, per-bunk within grade) ──
        function placeSwimForGrade(grade, layer) {
            const bunks = getBunksForGrade(grade, divisions);
            const { dMin, dMax } = resolveConstraints(layer, 'swim');
            const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
            const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
            const mrc = getSwimWindow(grade);
            const winStart = mrc ? Math.max(mrc.start, gs) : Math.max(layer.startMin || 0, gs);
            const winEnd = mrc ? Math.min(mrc.end, ge) : Math.min(layer.endMin || 1440, ge);

            const sortedBunks = [...bunks].sort((a, b) =>
                (parseInt(String(a).replace(/\D/g, '')) || 0) - (parseInt(String(b).replace(/\D/g, '')) || 0));

            let placedCount = 0;
            for (const bunk of sortedBunks) {
                // ★ findBestGapPosition + isResidualViable will automatically reject
                // any gap where placing swim would leave an unfillable residual.
                // No need to hardcode "prefer post-lunch" — the math handles it.
                const pos = findBestGapPosition(bunk, winStart, winEnd, dMin, 'swim', null, grade);
                if (!pos) continue;
                const bunkIdx = sortedBunks.indexOf(bunk);
                let start = pos.start + bunkIdx * 5;
                if (start + dMin > pos.end) start = pos.start;
                const dur = Math.max(dMin, Math.min(dMax, pos.end - start));

                placeTentativeBlock(bunk, {
                    startMin: start, endMin: start + dur,
                    type: 'swim', event: layer.event || 'Swim',
                    layer, _classification: 'windowed',
                    _activityLocked: true, _fixed: false, _committed: true,
                    _softAnchor: true,
                    _softWindow: { start: winStart, end: winEnd },
                    _softDuration: dur
                });
                placedCount++;
            }
            return placedCount;
        }

        // =====================================================================
        // PHASE 1: BUILD SHOPPING LISTS (the WHAT)
        // For each bunk, compile everything it needs with full priority lists.
        // =====================================================================

        function buildBunkShoppingList(bunk, grade) {
            const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
            const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
            const bunkSize = (window.getBunkMetaData?.() || window.bunkMetaData || {})[bunk]?.size || 20;

            // ── Determine what's already placed (Phase 0) ────────────────
            const timeline = (bunkTimelines[bunk] || []).sort((a, b) => a.startMin - b.startMin);
            const freeWindows = [];
            let cursor = gradeStart;
            timeline.forEach(b => { if (b.startMin > cursor) freeWindows.push({ start: cursor, end: b.startMin, duration: b.startMin - cursor }); cursor = Math.max(cursor, b.endMin); });
            if (cursor < gradeEnd) freeWindows.push({ start: cursor, end: gradeEnd, duration: gradeEnd - cursor });

            const totalFree = freeWindows.reduce((s, w) => s + w.duration, 0);

            // ── Determine which layers still need placement ──────────────
            // Layers whose type was already fully placed in Phase 0 are excluded.
            const placedTypes = {};
            timeline.forEach(b => {
                const t = (b.type || '').toLowerCase();
                placedTypes[t] = (placedTypes[t] || 0) + 1;
            });

            const remainingNeeds = [];
            nonPinnedLayers.forEach(layer => {
                if ((layer.grade || layer.division) !== grade) return;
                const t = (layer.type || '').toLowerCase();
                const required = layer.qty || layer.quantity || 1;
                const op = layer.op || layer.operator || '>=';
                const alreadyPlaced = placedTypes[t] || 0;

                // For grade-wide types that were placed in Phase 0, count once (not per-bunk)
                // Leagues: check if this grade has a league in the timeline
                if (t === 'league' || t === 'specialty_league') {
                    const hasLeague = timeline.some(b => (b.type || '').toLowerCase() === t);
                    if (hasLeague) return; // already placed
                }

                const stillNeeded = Math.max(0, required - alreadyPlaced);
                if (stillNeeded <= 0 && op !== '<=' && op !== '≤') return;
                if (op === '<=' || op === '≤') return; // max-only layers, skip

                remainingNeeds.push({ layer, type: t, count: stillNeeded, op });
            });

            // ── Build SPORT priority list ─────────────────────────────────
            const sportNeeds = remainingNeeds.filter(n => n.type === 'sport' || n.type === 'sports');
            const sportCount = sportNeeds.reduce((s, n) => s + n.count, 0);
            const sportLayer = sportNeeds[0]?.layer || null;
            const sportConstraints = sportLayer ? resolveConstraints(sportLayer, 'sport') : { dMin: 25, dMax: 60, dIdeal: 40 };

            const sportPriorityList = [];
            const allFieldsArr = getFields(globalSettings);
            const disabledFields = globalSettings.app1?.disabledFields || [];
            const sportMap = new Map();

            allFieldsArr.forEach(field => {
                if (disabledFields.includes(field.name)) return;
                (field.activities || []).forEach(actName => {
                    if (!sportMap.has(actName)) sportMap.set(actName, { name: actName, fields: [], isIndoor: false });
                    sportMap.get(actName).fields.push(field.name);
                    if (field.isIndoor) sportMap.get(actName).isIndoor = true;
                });
            });

            sportMap.forEach((sport, name) => {
                let score = 0;
                if (window.RotationEngine?.calculateRotationScore) {
                    score = window.RotationEngine.calculateRotationScore({ bunkName: bunk, activityName: name, divisionName: grade, beforeSlotIndex: 0, allActivities: null, activityProperties });
                }
                if (score === Infinity) score = 99999;
                const playerReqs = window.SchedulerCoreUtils?.getSportPlayerRequirements?.(name);
                const needsPairing = playerReqs?.minPlayers && bunkSize < playerReqs.minPlayers;

                sportPriorityList.push({
                    name, type: 'sport', rotationScore: score,
                    dMin: sportConstraints.dMin, dMax: sportConstraints.dMax, dIdeal: sportConstraints.dIdeal,
                    fields: sport.fields, needsPairing, playerReqs, bunkSize,
                    isIndoor: sport.isIndoor, _layer: sportLayer
                });
            });
            sportPriorityList.sort((a, b) => a.rotationScore - b.rotationScore);

            // ── Build SPECIAL priority list ───────────────────────────────
            const specialNeeds = remainingNeeds.filter(n => n.type === 'special');
            const specialCount = specialNeeds.reduce((s, n) => s + n.count, 0);
            const specialLayer = specialNeeds[0]?.layer || null;
            const specialConstraints = specialLayer ? resolveConstraints(specialLayer, 'special') : { dMin: 20, dMax: 60, dIdeal: 35 };

            const specialPriorityList = [];
            todaysSpecials.forEach(s => {
                if (!isSpecialAvailableForDivision(s.name, grade, globalSettings)) return;

                let score = 0;
                if (window.RotationEngine?.calculateRotationScore) {
                    score = window.RotationEngine.calculateRotationScore({ bunkName: bunk, activityName: s.name, divisionName: grade, beforeSlotIndex: 0, allActivities: null, activityProperties });
                }
                if (score === Infinity) score = 99999;

                const props = activityProperties[s.name] || s;
                const maxUsage = parseInt(props.maxUsage) || 0;
                const maxUsagePeriod = props.maxUsagePeriod || 'half';
                if (maxUsage > 0 && getPeriodCount(bunk, s.name, maxUsagePeriod) >= maxUsage) return;

                // ★ KEY: Get the special's own duration. NULL means "use layer range"
                const specificDuration = getSpecialDuration(s.name, activityProperties, globalSettings, null);
                const cfg = getSpecialConfig(s.name, globalSettings);
                const prepDuration = cfg?.prepDuration || 0;
                const prepLocation = cfg?.prepLocation || null;
                const location = getLocationForSpecial(s.name, activityProperties, globalSettings);
                const scarce = isScarce(s.name, dayName, globalSettings);
                const timeWindow = getSpecialTimeWindow(cfg);

                specialPriorityList.push({
                    name: s.name, type: 'special', rotationScore: score,
                    // ★ duration = null means "flexible, use layer range"
                    duration: specificDuration,
                    // If no specific duration, use layer constraints
                    dMin: specificDuration || specialConstraints.dMin,
                    dMax: specificDuration || specialConstraints.dMax,
                    dIdeal: specificDuration || specialConstraints.dIdeal,
                    isFlexDuration: !specificDuration, // true = uses layer range
                    capacity: getSpecialCapacity(s.name, activityProperties, globalSettings),
                    location, isScarce: scarce,
                    isIndoor: !isSpecialOnField(s.name),
                    prepDuration, prepLocation,
                    totalDuration: (specificDuration || specialConstraints.dIdeal) + prepDuration,
                    timeWindow, _linkedPair: prepDuration > 0,
                    _layer: specialLayer
                });
            });
            specialPriorityList.sort((a, b) => { if (a.isScarce !== b.isScarce) return a.isScarce ? -1 : 1; return a.rotationScore - b.rotationScore; });

            // ── Build OTHER needs (snack, elective, etc.) ────────────────
            const otherNeeds = remainingNeeds.filter(n => n.type !== 'sport' && n.type !== 'sports' && n.type !== 'special' && n.type !== 'league' && n.type !== 'specialty_league');

            // Snack candidates (floating anchor positions)
            const snackNeed = otherNeeds.find(n => n.type === 'snack' || n.type === 'snacks');
            let snackOptions = null;
            if (snackNeed) {
                const sc = resolveConstraints(snackNeed.layer, snackNeed.type);
                snackOptions = [];
                for (let t = snackNeed.layer.startMin; t + sc.dMin <= snackNeed.layer.endMin; t += 10) {
                    snackOptions.push({ startMin: t, endMin: t + sc.dMin, duration: sc.dMin, type: snackNeed.type, event: snackNeed.layer.event || 'Snacks', layer: snackNeed.layer });
                }
            }

            // Elective info
            const electiveNeed = otherNeeds.find(n => n.type === 'elective');
            let electiveInfo = null;
            if (electiveNeed) {
                const ec = resolveConstraints(electiveNeed.layer, 'elective');
                electiveInfo = { type: 'elective', dMin: ec.dMin, dMax: ec.dMax, dIdeal: ec.dIdeal, count: electiveNeed.count, window: { start: electiveNeed.layer.startMin, end: electiveNeed.layer.endMin }, layer: electiveNeed.layer };
            }

            // Other block types (anything the user defined that isn't sport/special/snack/elective/league)
            const genericNeeds = otherNeeds.filter(n => n.type !== 'snack' && n.type !== 'snacks' && n.type !== 'elective');

            // ── Find adjacent bunk for pairing ───────────────────────────
            const allBunks = getBunksForGrade(grade, divisions);
            const myNum = parseInt(String(bunk).replace(/\D/g, '')) || 0;
            let adjacentBunk = null, closestDist = Infinity;
            allBunks.forEach(other => {
                if (other === bunk) return;
                const d = Math.abs((parseInt(String(other).replace(/\D/g, '')) || 0) - myNum);
                if (d < closestDist) { closestDist = d; adjacentBunk = other; }
            });

            return {
                bunk, grade, bunkSize,
                freeWindows, totalFree,
                sports: { required: sportCount, priorityList: sportPriorityList, layer: sportLayer, constraints: sportConstraints },
                specials: { required: specialCount, priorityList: specialPriorityList, layer: specialLayer, constraints: specialConstraints },
                snack: snackOptions,
                elective: electiveInfo,
                genericNeeds,
                adjacentBunk
            };
        }


        // =====================================================================
        // PHASE 2: DRAFT-STYLE ASSIGNMENT (the WHERE)
        // Bunks take turns claiming activities from priority lists.
        // Live field ledger prevents conflicts.
        // =====================================================================

        function runDraft(shoppingLists) {
            initFieldLedger();

            const draftResults = {};
            const allBunkList = Object.values(shoppingLists);

            // Sort: most constrained first
            allBunkList.sort((a, b) => {
                const ac = a.sports.required + a.specials.required * 2 + (a.bunkSize < 12 ? 3 : 0) - a.sports.priorityList.length * 0.1;
                const bc = b.sports.required + b.specials.required * 2 + (b.bunkSize < 12 ? 3 : 0) - b.sports.priorityList.length * 0.1;
                return bc - ac;
            });

            // Initialize results
            allBunkList.forEach(list => {
                draftResults[list.bunk] = { sports: [], specials: [], elective: [], generic: [], usedActivities: new Set(), grade: list.grade };
            });

            // Helper: find time for a field within free windows
            function findTimeForField(fieldName, bunk, grade, duration, freeWindows) {
                for (const win of freeWindows) {
                    if (win.duration < duration) continue;
                    for (let t = win.start; t + duration <= win.end; t += 5) {
                        if (isFieldAvailable(fieldName, t, t + duration, bunk, grade)) return { startMin: t, endMin: t + duration };
                    }
                }
                return null;
            }

            // Helper: find any free window
            function findAnyWindow(freeWindows, duration) {
                for (const win of freeWindows) { if (win.duration >= duration) return { startMin: win.start, endMin: win.start + duration }; }
                return null;
            }

            // Helper: recompute free windows after claims
            function getUpdatedFreeWindows(bunk, grade) {
                const result = draftResults[bunk];
                const claimed = [...result.sports, ...result.specials, ...result.elective, ...result.generic]
                    .map(c => c.claimedTime).filter(Boolean).sort((a, b) => a.startMin - b.startMin);

                const original = shoppingLists[bunk]?.freeWindows || [];
                const updated = [];
                for (const win of original) {
                    let cursor = win.start;
                    const overlapping = claimed.filter(c => c.startMin < win.end && c.endMin > win.start).sort((a, b) => a.startMin - b.startMin);
                    for (const cl of overlapping) {
                        if (cl.startMin > cursor) updated.push({ start: cursor, end: cl.startMin, duration: cl.startMin - cursor });
                        cursor = Math.max(cursor, cl.endMin);
                    }
                    if (cursor < win.end) updated.push({ start: cursor, end: win.end, duration: win.end - cursor });
                }
                return updated.filter(w => w.duration > 0);
            }

            // Helper: find paired time for two bunks
            function findPairedTime(fieldName, bunk1, bunk2, grade, duration, fw1, fw2) {
                for (const w1 of fw1) {
                    for (const w2 of fw2) {
                        const os = Math.max(w1.start, w2.start), oe = Math.min(w1.end, w2.end);
                        if (oe - os < duration) continue;
                        for (let t = os; t + duration <= oe; t += 5) {
                            if (isFieldAvailable(fieldName, t, t + duration, bunk1, grade)) return { startMin: t, endMin: t + duration };
                        }
                    }
                }
                return null;
            }

            // ── ROUND 1: Scarce specials ─────────────────────────────────
            for (const list of allBunkList) {
                const bunk = list.bunk, grade = list.grade, result = draftResults[bunk];
                if (list.specials.required <= 0) continue;

                for (const special of list.specials.priorityList) {
                    if (result.specials.length >= list.specials.required) break;
                    if (!special.isScarce) continue;
                    if (result.usedActivities.has(special.name)) continue;

                    const fw = getUpdatedFreeWindows(bunk, grade);
                    const dur = special.totalDuration;
                    const time = special.location ? findTimeForField(special.location, bunk, grade, dur, fw) : findAnyWindow(fw, dur);
                    if (!time) continue;

                    if (special.location) claimField(special.location, time.startMin, time.endMin, bunk, grade, special.name);
                    if (special._linkedPair && special.prepLocation) {
                        claimField(special.prepLocation, time.startMin, time.startMin + special.prepDuration, bunk, grade, special.name + ' (Prep)');
                    }

                    result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                    result.usedActivities.add(special.name);
                }
            }

            // ── ROUND 2: Regular specials ────────────────────────────────
            for (const list of allBunkList) {
                const bunk = list.bunk, grade = list.grade, result = draftResults[bunk];
                if (result.specials.length >= list.specials.required) continue;

                for (const special of list.specials.priorityList) {
                    if (result.specials.length >= list.specials.required) break;
                    if (result.usedActivities.has(special.name)) continue;
                    if (special.isScarce) continue;

                    const fw = getUpdatedFreeWindows(bunk, grade);
                    const dur = special.totalDuration;
                    const time = special.location ? findTimeForField(special.location, bunk, grade, dur, fw) : findAnyWindow(fw, dur);
                    if (!time) continue;

                    if (special.location) claimField(special.location, time.startMin, time.endMin, bunk, grade, special.name);
                    if (special._linkedPair && special.prepLocation) {
                        claimField(special.prepLocation, time.startMin, time.startMin + special.prepDuration, bunk, grade, special.name + ' (Prep)');
                    }

                    result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                    result.usedActivities.add(special.name);
                }

                if (result.specials.length < list.specials.required) {
                    warn('[DRAFT] ' + bunk + ': only ' + result.specials.length + '/' + list.specials.required + ' specials');
                }
            }

            // ── ROUND 3: Sports (with pairing awareness) ─────────────────
            for (const list of allBunkList) {
                const bunk = list.bunk, grade = list.grade, result = draftResults[bunk];
                const sportsNeeded = list.sports.required;
                if (sportsNeeded <= 0) continue;

                for (const sport of list.sports.priorityList) {
                    if (result.sports.length >= sportsNeeded) break;
                    if (result.usedActivities.has(sport.name)) continue; // no repeat

                    const fw = getUpdatedFreeWindows(bunk, grade);

                    // Pairing check
                    if (sport.needsPairing && list.adjacentBunk) {
                        const partner = list.adjacentBunk;
                        const partnerList = shoppingLists[partner];
                        if (partnerList?.sports.priorityList.some(s => s.name === sport.name)) {
                            const pfw = getUpdatedFreeWindows(partner, partnerList.grade);
                            let paired = false;
                            for (const field of sport.fields) {
                                const time = findPairedTime(field, bunk, partner, grade, sport.dIdeal, fw, pfw);
                                if (time) {
                                    claimField(field, time.startMin, time.endMin, bunk, grade, sport.name);
                                    claimField(field, time.startMin, time.endMin, partner, grade, sport.name);
                                    result.sports.push({ ...sport, claimedTime: time, claimedField: field, pairedWith: partner });
                                    result.usedActivities.add(sport.name);
                                    // Record for partner too
                                    if (!draftResults[partner]) draftResults[partner] = { sports: [], specials: [], elective: [], generic: [], usedActivities: new Set(), grade };
                                    draftResults[partner].sports.push({ ...sport, claimedTime: time, claimedField: field, pairedWith: bunk });
                                    draftResults[partner].usedActivities.add(sport.name);
                                    paired = true; break;
                                }
                            }
                            if (paired) continue;
                        }
                        continue; // skip to next sport if pairing failed
                    }

                    // Normal assignment
                    let claimed = false;
                    for (const field of sport.fields) {
                        const time = findTimeForField(field, bunk, grade, sport.dIdeal, fw);
                        if (time) {
                            claimField(field, time.startMin, time.endMin, bunk, grade, sport.name);
                            result.sports.push({ ...sport, claimedTime: time, claimedField: field });
                            result.usedActivities.add(sport.name);
                            claimed = true; break;
                        }
                    }
                }

                if (result.sports.length < sportsNeeded) {
                    warn('[DRAFT] ' + bunk + ': only ' + result.sports.length + '/' + sportsNeeded + ' sports');
                }
            }

            // ── ROUND 4: Electives ───────────────────────────────────────
            for (const list of allBunkList) {
                if (!list.elective) continue;
                const bunk = list.bunk, result = draftResults[bunk];
                const fw = getUpdatedFreeWindows(bunk, list.grade);
                for (let i = 0; i < list.elective.count; i++) {
                    const time = findAnyWindow(fw, list.elective.dIdeal);
                    if (time) result.elective.push({ type: 'elective', duration: list.elective.dIdeal, claimedTime: time, layer: list.elective.layer });
                }
            }

            // ── ROUND 5: Generic needs (user-defined types) ──────────────
            for (const list of allBunkList) {
                if (!list.genericNeeds || list.genericNeeds.length === 0) continue;
                const bunk = list.bunk, result = draftResults[bunk];
                list.genericNeeds.forEach(need => {
                    const fw = getUpdatedFreeWindows(bunk, list.grade);
                    const c = resolveConstraints(need.layer, need.type);
                    for (let i = 0; i < need.count; i++) {
                        const time = findAnyWindow(fw, c.dIdeal);
                        if (time) result.generic.push({ type: need.type, event: need.layer.event || need.type, duration: c.dIdeal, claimedTime: time, layer: need.layer, dMin: c.dMin, dMax: c.dMax });
                    }
                });
            }

            return draftResults;
        }


        // =====================================================================
        // PHASE 3: DAP — PER-BUNK DAY PARTITION (the WHEN, precise)
        // Takes draft results + shopping list and designs minute-by-minute
        // layout with zero dead space.
        // =====================================================================

        // ── Perfect-fit distribution: size N blocks to sum exactly to target ──
        // Each block has [dMin, dMax]. Returns array of durations.
        // Algorithm: start all at dMin, distribute excess proportionally to headroom.
        function perfectFitDistribute(blockDescs, target) {
            const n = blockDescs.length;
            if (n === 0) return [];
            if (n === 1) return [Math.max(blockDescs[0].dMin, Math.min(blockDescs[0].dMax, target))];

            // Start all at dMin
            const durations = blockDescs.map(b => b.dMin);
            let excess = target - durations.reduce((s, d) => s + d, 0);

            if (excess <= 0) return durations; // already at or over target

            // ★ MAXIMIZE: fill each block to dMax before moving to the next.
            // Produces fewer, longer activities instead of many short ones.
            for (let i = 0; i < n && excess > 0; i++) {
                const maxGrow = blockDescs[i].dMax - durations[i];
                if (maxGrow <= 0) continue;
                const give = Math.min(maxGrow, excess);
                durations[i] += give;
                excess -= give;
            }

            // If still excess after all blocks maxed, spread remainder
            if (excess > 0) {
                for (let i = 0; i < n && excess > 0; i++) {
                    durations[i]++;
                    excess--;
                }
            }
            // Snap to 5 while preserving total
            let total = 0;
            for (let i = 0; i < n - 1; i++) {
                durations[i] = snapTo5(durations[i]);
                durations[i] = Math.max(blockDescs[i].dMin, Math.min(blockDescs[i].dMax, durations[i]));
                total += durations[i];
            }
            // Last block gets whatever's left
            durations[n - 1] = target - total;
            durations[n - 1] = Math.max(blockDescs[n - 1].dMin, durations[n - 1]);

            return durations;
        }

        // =====================================================================
        // PHASE 3: GREEDY CONSTRAINT PACKER
        // For each bunk: list what needs placing, get the gaps between walls,
        // pack blocks into gaps one at a time — most constrained first.
        // Every placement checks: "can the remaining blocks still fit?"
        // After packing, expand all flex blocks to fill regions exactly.
        // =====================================================================

        function greedyPackBunk(bunk, grade, draftResult, shoppingList, staggerOffset, swimsToday) {
            const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
            const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
            const sportC = shoppingList.sports?.constraints || resolveConstraints(null, 'sport');
            const minFill = getMinFillable(grade);
            const ABSORB_MAX = 10;

            // ── Step 1: Walls — blocks already placed by Phase 0 ──────────
            // These are lunch, dismissal, league — they CANNOT move.
            const walls = (bunkTimelines[bunk] || []).map(b => {
                const t = (b.type || '').toLowerCase();
                const isLeague = t === 'league' || t === 'specialty_league';
                const c = (isLeague && b.layer) ? resolveConstraints(b.layer, t) : null;
                return {
                    startMin: b.startMin, endMin: b.endMin, type: b.type, event: b.event,
                    layer: b.layer, _fixed: true, _source: 'phase0',
                    // Leagues can flex — carry their real constraints
                    dMin: c ? c.dMin : (b.endMin - b.startMin),
                    dMax: c ? c.dMax : (b.endMin - b.startMin),
                    _gradeWide: b._gradeWide || false, _activityLocked: true,
                    _classification: b._classification || 'pinned',
                    _noBacktrack: b._noBacktrack || false
                };
            });

            // ── Step 2: Build needs list — everything else ────────────────
            // Sorted most-constrained first: fixed-dur → tight-window → flex
            const needs = [];

            // Swim (fixed duration, wide window) — only if this bunk swims today
            const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
            if (swimLayer && swimsToday !== false && !walls.some(w => (w.type || '').toLowerCase() === 'swim')) {
                const c = resolveConstraints(swimLayer, 'swim');
                needs.push({
                    type: 'swim', event: swimLayer.event || 'Swim', layer: swimLayer,
                    dMin: c.dMin, dMax: c.dMax,
                    windowStart: Math.max(swimLayer.startMin || 0, gradeStart),
                    windowEnd: Math.min(swimLayer.endMin || 1440, gradeEnd),
                    _activityLocked: true, _source: 'layer'
                });
            }

            // Snack (fixed duration, tight window)
            const snackLayer = (layersByGrade[grade] || []).find(l =>
                ['snacks', 'snack'].includes((l.type || '').toLowerCase())
            );
            if (snackLayer && !walls.some(w => ['snacks', 'snack'].includes((w.type || '').toLowerCase()))) {
                const c = resolveConstraints(snackLayer, 'snacks');
                needs.push({
                    type: 'snacks', event: snackLayer.event || 'snacks', layer: snackLayer,
                    dMin: c.dMin, dMax: c.dMax,
                    windowStart: Math.max(snackLayer.startMin || 0, gradeStart),
                    windowEnd: Math.min(snackLayer.endMin || 1440, gradeEnd),
                    _activityLocked: true, _source: 'layer'
                });
            }

            // Draft specials (flex duration, full window, assigned activity)
            (draftResult.specials || []).forEach(special => {
                const c = resolveConstraints(special.layer, 'special', special);
                // If the special has a configured duration, it's FIXED — no flex.
                // If no duration, use layer dMin/dMax range (flexible).
                const hasFixedDur = special.duration && special.duration > 0;
                const sDMin = hasFixedDur ? special.duration : c.dMin;
                const sDMax = hasFixedDur ? special.duration : c.dMax;
                needs.push({
                    type: 'special', event: special.name, layer: special.layer,
                    dMin: sDMin, dMax: sDMax,                    windowStart: gradeStart, windowEnd: gradeEnd,
                    _activityLocked: true, _assignedSpecial: special.name,
                    _specialLocation: special.location, _specialDuration: special.duration,
                    _source: 'draft'
                });
            });

            // ★ Custom layers (windowed, not pinned) — pre-assigned activity + field
            (layersByGrade[grade] || []).filter(l =>
                (l.type || '').toLowerCase() === 'custom' && l._classification !== 'pinned'
            ).forEach(customLayer => {
                // Only add for this bunk if it's in the selected bunks list
                if (customLayer.customBunks && customLayer.customBunks.length > 0) {
                    if (!customLayer.customBunks.includes(String(bunk))) return;
                }
                const dur = customLayer.durationMin || customLayer.periodMin || 30;
                const durMax = customLayer.durationMax || dur;
                needs.push({
                    type: 'custom',
                    event: customLayer.customActivity || customLayer.event || 'Custom',
                    layer: customLayer,
                    dMin: dur, dMax: durMax,
                    windowStart: Math.max(customLayer.startMin || 0, gradeStart),
                    windowEnd: Math.min(customLayer.endMin || 1440, gradeEnd),
                    _activityLocked: true,
                    _customActivity: customLayer.customActivity || null,
                    _customField: customLayer.customField || null,
                    _customBunks: customLayer.customBunks || null,
                    _source: 'custom-layer'
                });
            });

            // Sort: fixed-duration first, then tighter flexibility ratio
            needs.sort((a, b) => {
                const aFixed = a.dMin === a.dMax ? 0 : 1;
                const bFixed = b.dMin === b.dMax ? 0 : 1;
                if (aFixed !== bFixed) return aFixed - bFixed;
                // Among same fixedness: tighter (less flexibility) first
                const aFlex = (a.windowEnd - a.windowStart) / Math.max(1, a.dMin);
                const bFlex = (b.windowEnd - b.windowStart) / Math.max(1, b.dMin);
                return aFlex - bFlex;
            });

            // ★ STAGGER: Rotate flex needs by grade offset so different grades
            // place swim/special/snack at different positions in the day.
            // Fixed-duration blocks stay first (they're most constrained).
            if (staggerOffset > 0 && needs.length > 1) {
                const fixedPart = needs.filter(n => n.dMin === n.dMax);
                const flexPart = needs.filter(n => n.dMin !== n.dMax);
                if (flexPart.length > 1) {
                    const rot = staggerOffset % flexPart.length;
                    const rotated = [...flexPart.slice(rot), ...flexPart.slice(0, rot)];
                    needs.length = 0;
                    needs.push(...fixedPart, ...rotated);
                }
            }

            // ── Helpers ───────────────────────────────────────────────────
            function getGaps(blockList) {
                const sorted = [...blockList].sort((a, b) => a.startMin - b.startMin);
                const gaps = [];
                let cursor = gradeStart;
                sorted.forEach(b => {
                    if (b.startMin > cursor) gaps.push({ start: cursor, end: b.startMin, size: b.startMin - cursor });
                    cursor = Math.max(cursor, b.endMin);
                });
                if (cursor < gradeEnd) gaps.push({ start: cursor, end: gradeEnd, size: gradeEnd - cursor });
                return gaps;
            }

            function canFitRemaining(currentPlaced, remainingNeeds) {
                if (remainingNeeds.length === 0) return true;
                const gaps = getGaps(currentPlaced);
                // Each remaining need must have at least one gap in its window
                for (const need of remainingNeeds) {
                    const ok = gaps.some(g => {
                        const es = Math.max(g.start, need.windowStart);
                        const ee = Math.min(g.end, need.windowEnd);
                        return ee - es >= need.dMin;
                    });
                    if (!ok) return false;
                }
                // Total dMin must fit in total gap space
                const totalNeed = remainingNeeds.reduce((s, n) => s + n.dMin, 0);
                const totalGap = gaps.reduce((s, g) => s + g.size, 0);
                if (totalNeed > totalGap) return false;
                return true;
            }

            // ── Step 3: Pack required needs into gaps ─────────────────────
            // For each need (most constrained first):
            //   Try every valid gap. In each gap, try start and end positions.
            //   Accept the first position where residuals are viable AND
            //   all remaining needs can still fit somewhere.
            const placed = [...walls];

            for (let i = 0; i < needs.length; i++) {
                const need = needs[i];
                const remaining = needs.slice(i + 1);
                const gaps = getGaps(placed);

                // Gaps that overlap this need's window
                // ★ CROSS-GRADE: sort by fewest conflicts, then by size
                const trackableType = ['swim', 'special', 'snacks', 'snack'].includes(need.type);
                const validGaps = gaps
                    .map(g => ({
                        start: Math.max(g.start, need.windowStart),
                        end: Math.min(g.end, need.windowEnd),
                        origStart: g.start, origEnd: g.end
                    }))
                    .filter(g => g.end - g.start >= need.dMin)
                    // Sort by size only — conflict avoidance happens at position level
                    .sort((a, b) => (b.end - b.start) - (a.end - a.start));

                let didPlace = false;
                for (const gap of validGaps) {
                    const endPos = gap.end - need.dMin;
                    if (endPos < gap.start) continue;

                    const trackableType = ['swim', 'special', 'snacks', 'snack'].includes(need.type);
                    const isExclusive = need.type === 'swim'; // pool = one grade at a time
                    // Specials with same_division sharing are also exclusive across different divisions
                    const isSpecialExclusive = need.type === 'special' && need._assignedSpecial;

                    // ★ For exclusive types (swim) or specials: scan EVERY 5-min position
                    // For others: sparse scan (start, end, every 15min)
                    const candidateSet = new Set();
                    if (isExclusive || isSpecialExclusive) {
                        for (let t = gap.start; t <= endPos; t += 5) candidateSet.add(t);
                    } else {
                        candidateSet.add(gap.start);
                        if (endPos > gap.start) candidateSet.add(endPos);
                        for (let t = gap.start; t <= endPos; t += 15) candidateSet.add(t);
                    }

                    // Sort: least cross-grade conflicts first, then stagger preference
                    let candidates = [...candidateSet];
                    if (trackableType) {
                        // Pre-compute conflict scores for all candidates
                        candidates = candidates.map(t => ({
                            pos: t,
                            conflicts: getCrossGradeConflicts(need.type, t, t + need.dMin, grade, need.event)
                        }));
                        candidates.sort((a, b) => {
                            if (a.conflicts !== b.conflicts) return a.conflicts - b.conflicts;
                            return (staggerOffset % 2 === 0) ? (a.pos - b.pos) : (b.pos - a.pos);
                        });
                        candidates = candidates.map(c => c.pos);
                    } else {
                        candidates.sort((a, b) => (staggerOffset % 2 === 0) ? (a - b) : (b - a));
                    }

                    for (const pos of candidates) {
                       // Residual check: before and after must be viable
                        const beforeRes = pos - gap.origStart;
                        const afterRes = gap.origEnd - (pos + need.dMin);
                        if (need.dMin === need.dMax) {
                            // Fixed-duration: residuals must be 0 or fillable (no absorption — it would stretch a fixed block)
                            if (beforeRes > 0 && beforeRes < minFill) continue;
                            if (afterRes > 0 && afterRes < minFill) continue;
                        } else {
                            if (beforeRes > ABSORB_MAX && beforeRes < minFill) continue;
                            if (afterRes > ABSORB_MAX && afterRes < minFill) continue;
                        }

                        // ★ Special capacity + cross-division check
                        if (need.type === 'special' && need._assignedSpecial) {
                            if (!canUseSpecialAtTime(need._assignedSpecial, grade, pos, pos + need.dMin)) continue;
                        }

                        // Future viability: can remaining needs still fit?
                        const tempBlock = {
                            startMin: pos, endMin: pos + need.dMin,
                            type: need.type, event: need.event
                        };
                        if (canFitRemaining([...placed, tempBlock], remaining)) {
                            placed.push({
                                startMin: pos, endMin: pos + need.dMin,
                                ...need, _final: true
                            });
                            didPlace = true;
                            break;
                        }
                    }
                    if (didPlace) break;
                }

                // Fallback: place at best available position even without perfect viability
                if (!didPlace) {
                    for (const gap of validGaps) {
                        const endPos2 = gap.end - need.dMin;
                        // For specials, still try to respect capacity even in fallback
                        if (need.type === 'special' && need._assignedSpecial) {
                            let foundFallback = false;
                            for (let t = gap.start; t <= endPos2; t += 5) {
                                // ★ Fixed-duration specials: reject positions that create dead-zone residuals
                                if (need.dMin === need.dMax) {
                                    const beforeRes = t - gap.origStart;
                                    const afterRes = gap.origEnd - (t + need.dMin);
                                    if (beforeRes > 0 && beforeRes < minFill) continue;
                                    if (afterRes > 0 && afterRes < minFill) continue;
                                }
                                if (!canUseSpecialAtTime(need._assignedSpecial, grade, t, t + need.dMin)) continue;
                                placed.push({ startMin: t, endMin: t + need.dMin, ...need, _final: true });
                                didPlace = true; foundFallback = true; break;
                            }
                            if (foundFallback) break;
                        } else {
                            placed.push({ startMin: gap.start, endMin: gap.start + need.dMin, ...need, _final: true });
                            didPlace = true; break;
                        }
                    }
                }

               // ★ Register in cross-grade tracker AND special capacity tracker
                if (didPlace) {
                    const lastPlaced = placed[placed.length - 1];
                    registerCrossGrade(grade, need.type, lastPlaced.startMin, lastPlaced.endMin, need.event);
                    if (need.type === 'special' && need._assignedSpecial) {
                        // ★ Register with dMax as worst-case end — the expand phase may
                        // stretch this block up to dMax, so reserve the full range now
                        // to prevent other grades from placing overlapping specials.
                        const worstCaseEnd = lastPlaced.startMin + (need.dMax || need.dMin || (lastPlaced.endMin - lastPlaced.startMin));
                        registerSpecialUsage(need._assignedSpecial, grade, lastPlaced.startMin, worstCaseEnd);
                    }
                }
            }

            // ── Step 4: Fill remaining gaps with sport slots ──────────────
            // Draft assigned specific sport activities. Use them in order.
            // When drafted sports run out, pull from the priority list (rotation-scored).
            const sportQueue = [...(draftResult.sports || [])];

            // ★ Extend queue with additional sports from the priority list
            // ONLY use common sports (3+ fields) for extra slots.
            // Scarce sports (Trench, Jump Rope, etc.) only come from the draft
            // which already verified field availability via the field ledger.
            const usedSports = new Set(sportQueue.map(s => s.name));
            const priorityList = shoppingList.sports?.priorityList || [];

            // Determine which sports are "common" (many fields available)
            const MIN_FIELDS_FOR_FILL = 3;
            const commonSports = priorityList.filter(sport => {
                const fieldCount = (sport.fields || []).length;
                return fieldCount >= MIN_FIELDS_FOR_FILL;
            });

            // First pass: unused common sports
            for (const sport of commonSports) {
                if (!usedSports.has(sport.name)) {
                    sportQueue.push({ name: sport.name, field: null });
                    usedSports.add(sport.name);
                }
            }
            // Second pass: cycle common sports if still not enough
            let cycleIdx = 0;
            const cycleSource = commonSports.length > 0 ? commonSports : priorityList;
            while (sportQueue.length < 10 && cycleSource.length > 0) {
                const sport = cycleSource[cycleIdx % cycleSource.length];
                sportQueue.push({ name: sport.name, field: null });
                cycleIdx++;
                if (cycleIdx > 20) break;
            }

            let sportIdx = 0;

            const afterGaps = getGaps(placed);
            for (const gap of afterGaps) {
                if (gap.size < sportC.dMin) continue; // absorbed in expand phase

                // Minimum number of blocks needed to fill this gap
                // (each block can be up to dMax, so ceil(gap/dMax) gives the fewest blocks)
                let numSlots = Math.ceil(gap.size / sportC.dMax);
                // Verify all blocks can be at least dMin
                if (numSlots * sportC.dMin > gap.size) numSlots = Math.max(1, numSlots - 1);

                let cursor = gap.start;
                for (let s = 0; s < numSlots; s++) {
                    const sport = sportQueue[sportIdx] || null;
                    if (sport) sportIdx++;

                    placed.push({
                        startMin: cursor, endMin: cursor + sportC.dMin,
                        type: sport ? 'sport' : 'slot',
                        event: sport ? sport.name : 'General Activity Slot',
                        layer: shoppingList.sports?.layer || null,
                        dMin: sportC.dMin, dMax: sportC.dMax,
                        _activityLocked: false,
                        _assignedSport: sport ? sport.name : null,
                        field: sport ? sport.field : null,
                        _source: sport ? 'draft' : 'filler',
                        _sportFallbacks: priorityList.map(s => s.name),
                        _final: true
                    });
                    cursor += sportC.dMin;
                }
            }

            // ── Step 5: Expand — size all blocks to fill regions exactly ──
            // Regions are spans between wall boundaries.
            // Within each region, use perfectFitDistribute to size flex blocks.
            placed.sort((a, b) => a.startMin - b.startMin);

            const template = [];
            // Walk through the day: alternate between walls and flex regions
            let dayCursor = gradeStart;

            // Collect walls in order
            const sortedWalls = walls.sort((a, b) => a.startMin - b.startMin);

            // Build ordered list of ALL boundary points
            const boundaryTimes = new Set([gradeStart, gradeEnd]);
            sortedWalls.forEach(w => { boundaryTimes.add(w.startMin); boundaryTimes.add(w.endMin); });
            // Fixed-duration placed blocks are also boundaries
            placed.filter(b => b.dMin === b.dMax && b._source !== 'phase0').forEach(b => {
                boundaryTimes.add(b.startMin); boundaryTimes.add(b.endMin);
            });
            const boundaries = [...boundaryTimes].sort((a, b) => a - b);

            for (let r = 0; r < boundaries.length - 1; r++) {
                const rStart = boundaries[r];
                const rEnd = boundaries[r + 1];
                const rSize = rEnd - rStart;
                if (rSize <= 0) continue;

                // Is this region a wall?
                const wallHere = placed.find(b =>
                    b._source === 'phase0' && b.startMin <= rStart && b.endMin >= rEnd
                );
                if (wallHere) {
                    // Only add once (first time we encounter this wall)
                    if (!template.some(t => t.startMin === wallHere.startMin && t.endMin === wallHere.endMin)) {
                        template.push({ ...wallHere, _final: true });
                    }
                    continue;
                }

                // Is this a fixed-duration block (swim, snack)?
                const fixedHere = placed.find(b =>
                    b.dMin === b.dMax && b._source !== 'phase0' &&
                    b.startMin <= rStart && b.endMin >= rEnd
                );
                if (fixedHere) {
                    if (!template.some(t => t.startMin === fixedHere.startMin && t.endMin === fixedHere.endMin)) {
                        template.push({ ...fixedHere, _final: true });
                    }
                    continue;
                }

                // Flex region: collect all flex blocks that were placed here
                const flexBlocks = placed.filter(b =>
                    b.startMin >= rStart && b.startMin < rEnd &&
                    b._source !== 'phase0' && !(b.dMin === b.dMax)
                );

                if (flexBlocks.length === 0) {
                    // Empty flex region — create sport fillers
                    if (rSize >= sportC.dMin) {
                        let numF = Math.max(1, Math.ceil(rSize / sportC.dMax));
                        while (numF > 0 && numF * sportC.dMin > rSize) numF--;
                        if (numF === 0 && rSize >= sportC.dMin) numF = 1;

                        const descs = [];
                        for (let f = 0; f < numF; f++) descs.push({ dMin: sportC.dMin, dMax: sportC.dMax });
                        const durs = perfectFitDistribute(descs, rSize);

                        let cur = rStart;
                        for (let f = 0; f < numF; f++) {
                            const sp = sportQueue[sportIdx] || null;
                            if (sp) sportIdx++;
                            template.push({
                                startMin: cur, endMin: cur + durs[f],
                                type: sp ? 'sport' : 'slot',
                                event: sp ? sp.name : 'General Activity Slot',
                                layer: shoppingList.sports?.layer,
                                dMin: sportC.dMin, dMax: sportC.dMax,
                                _activityLocked: false,
                                _assignedSport: sp ? sp.name : null,
                                field: sp ? sp.field : null,
                                _source: sp ? 'draft' : 'filler', _final: true
                            });
                            cur += durs[f];
                        }
                    }
                    // else: tiny region absorbed by adjacent blocks
                    continue;
                }

                // Have flex blocks — perfectFitDistribute to fill region exactly
                const descs = flexBlocks.map(b => ({
                    block: b, dMin: b.dMin, dMax: b.dMax
                }));

                // Check if we need MORE sport fillers to fill this region
                const totalDMax = descs.reduce((s, d) => s + d.dMax, 0);
                if (totalDMax < rSize) {
                    const extraSpace = rSize - totalDMax;
                    let extraCount = Math.ceil(extraSpace / sportC.dMax);
                    for (let e = 0; e < extraCount; e++) {
                        const sp = sportQueue[sportIdx] || null;
                        if (sp) sportIdx++;
                        descs.push({
                            block: {
                                type: sp ? 'sport' : 'slot',
                                event: sp ? sp.name : 'General Activity Slot',
                                layer: shoppingList.sports?.layer,
                                _activityLocked: false,
                                _assignedSport: sp ? sp.name : null,
                                field: sp ? sp.field : null,
                                _source: sp ? 'draft' : 'filler'
                            },
                            dMin: sportC.dMin, dMax: sportC.dMax
                        });
                    }
                }

                // Also check if we have TOO MANY blocks (total dMin > region)
                while (descs.length > 1 && descs.reduce((s, d) => s + d.dMin, 0) > rSize) {
                    descs.pop(); // remove last (least important) filler
                }

                const durs = perfectFitDistribute(
                    descs.map(d => ({ dMin: d.dMin, dMax: d.dMax })),
                    rSize
                );

                let cur = rStart;
                for (let d = 0; d < descs.length; d++) {
                    const dur = durs[d] || descs[d].dMin;
                    if (dur <= 0) continue;
                    const b = descs[d].block;
                    template.push({
                        startMin: cur, endMin: cur + dur,
                        type: b.type, event: b.event,
                        layer: b.layer, field: b.field,
                        dMin: descs[d].dMin, dMax: descs[d].dMax,
                        _source: b._source || 'draft',
                        _activityLocked: b._activityLocked || false,
                        _assignedSpecial: b._assignedSpecial || null,
                        _specialLocation: b._specialLocation || null,
                        _specialDuration: b._specialDuration || null,
                        _assignedSport: b._assignedSport || null,
                        _final: true
                    });
                    cur += dur;
                }
            }

            // ── Step 6: Final gap sweep — absorb any tiny residuals ─────
            // Walk through the sorted template and find gaps between blocks.
            // Tiny gaps (≤ ABSORB_MAX) get absorbed by expanding a neighbor.
            // Gaps ≥ minFill get a sport filler. Dead-zone gaps are logged.
            template.sort((a, b) => a.startMin - b.startMin);

            for (let pass = 0; pass < 3; pass++) {
                let changed = false;
                for (let i = 0; i < template.length - 1; i++) {
                    const gap = template[i + 1].startMin - template[i].endMin;
                    if (gap <= 0) continue;
                    if (gap <= ABSORB_MAX) {
                        // Absorb into whichever neighbor is flex (not fixed-duration, not a wall)
                        const prev = template[i];
                        const next = template[i + 1];
                        const prevFlex = prev.dMin !== prev.dMax && prev._source !== 'phase0';
                        const nextFlex = next.dMin !== next.dMax && next._source !== 'phase0';
                        const prevC = prevFlex ? resolveConstraints(prev.layer, prev.type, prev) : null;
                const nextC = nextFlex ? resolveConstraints(next.layer, next.type, next) : null;

                        if (prevFlex && prevC && (prev.endMin - prev.startMin + gap) <= prevC.dMax) {
                            prev.endMin += gap; changed = true;
                        } else if (nextFlex && nextC && (next.endMin - next.startMin + gap) <= nextC.dMax) {
                            next.startMin -= gap; changed = true;
                        } else {
                            // Neither can absorb within dMax — extend prev anyway (visual cleanliness)
                            if (prevFlex) { prev.endMin += gap; changed = true; }
                            else if (nextFlex) { next.startMin -= gap; changed = true; }
                        }
                    } else if (gap >= sportC.dMin) {
                        // Big enough for a sport slot
                        const sp = sportQueue[sportIdx] || null;
                        if (sp) sportIdx++;
                        template.push({
                            startMin: template[i].endMin, endMin: template[i + 1].startMin,
                            type: sp ? 'sport' : 'slot',
                            event: sp ? sp.name : 'General Activity Slot',
                            layer: shoppingList.sports?.layer,
                            dMin: sportC.dMin, dMax: sportC.dMax,
                            _activityLocked: false,
                            _assignedSport: sp ? sp.name : null,
                            _source: sp ? 'draft' : 'filler', _final: true
                        });
                        template.sort((a, b) => a.startMin - b.startMin);
                        changed = true;
                    }
                    // Dead-zone gaps (ABSORB_MAX < gap < sportC.dMin) — forced absorption
                    else {
                        const prev = template[i];
                        const next = template[i + 1];
                        if (prev._source !== 'phase0') { prev.endMin += gap; changed = true; }
                        else if (next._source !== 'phase0') { next.startMin -= gap; changed = true; }
                    }
                }
                // Also check gap at start and end of day
                if (template.length > 0) {
                    const firstGap = template[0].startMin - gradeStart;
                    if (firstGap > 0 && firstGap <= ABSORB_MAX && template[0]._source !== 'phase0') {
                        template[0].startMin = gradeStart; changed = true;
                    } else if (firstGap >= sportC.dMin) {
                        template.unshift({
                            startMin: gradeStart, endMin: template[0].startMin,
                            type: 'slot', event: 'General Activity Slot',
                            layer: shoppingList.sports?.layer,
                            dMin: sportC.dMin, dMax: sportC.dMax,
                            _source: 'filler', _final: true
                        });
                        changed = true;
                    } else if (firstGap > 0) {
                        template[0].startMin = gradeStart; changed = true;
                    }

                    const lastGap = gradeEnd - template[template.length - 1].endMin;
                    if (lastGap > 0 && lastGap <= ABSORB_MAX && template[template.length - 1]._source !== 'phase0') {
                        template[template.length - 1].endMin = gradeEnd; changed = true;
                    } else if (lastGap >= sportC.dMin) {
                        template.push({
                            startMin: template[template.length - 1].endMin, endMin: gradeEnd,
                            type: 'slot', event: 'General Activity Slot',
                            layer: shoppingList.sports?.layer,
                            dMin: sportC.dMin, dMax: sportC.dMax,
                            _source: 'filler', _final: true
                        });
                        changed = true;
                    } else if (lastGap > 0) {
                        template[template.length - 1].endMin = gradeEnd; changed = true;
                    }
                }
                template.sort((a, b) => a.startMin - b.startMin);
                if (!changed) break;
            }

            if (totalIters < 2) {
                const dead = template.reduce((s, b) => {
                    const dur = b.endMin - b.startMin;
                    if (dur < minFill && b._source === 'filler') return s + dur;
                    return s;
                }, 0);
                log('[PACK] ' + bunk + ': ' + template.length + ' blocks, dead=' + dead);
            }

            // ── Post-pack enforcement: clamp configured specials to exact duration ──
            for (let i = 0; i < template.length; i++) {
                const blk = template[i];
                if ((blk.type || '').toLowerCase() !== 'special') continue;
                const eName = blk.event || blk._assignedSpecial || blk._draftActivity || blk.name;
                if (!eName) continue;
                const cfgDur = getSpecialDuration(eName, activityProperties, globalSettings, null);
                if (!cfgDur || cfgDur <= 0) continue;
                const actualDur = blk.endMin - blk.startMin;
                if (actualDur === cfgDur) continue;
                blk.endMin = blk.startMin + cfgDur;
            }

            // ★★★ FIX v3.4: Post-expand cross-division clamp for specials ★★★
            // The expand phase can stretch blocks far beyond their registered range.
            // We must re-register the ACTUAL expanded range so later grades see it,
            // and shrink/convert blocks that expanded into cross-div conflicts.
            for (let i = 0; i < template.length; i++) {
                const blk = template[i];
                if ((blk.type || '').toLowerCase() !== 'special') continue;
                const sName = blk.event || blk._assignedSpecial || blk.name;
                if (!sName) continue;
                if (!canUseSpecialAtTime(sName, grade, blk.startMin, blk.endMin)) {
                    // Block expanded into a cross-div conflict — try to shrink
                    const origStart = blk.startMin, origEnd = blk.endMin;
                    const minDur = blk.dMin || 20;
                    let found = false;
                    for (let t = origStart; t + minDur <= origEnd; t += 5) {
                        if (canUseSpecialAtTime(sName, grade, t, t + minDur)) {
                            blk.startMin = t;
                            blk.endMin = t + minDur;
                            registerSpecialUsage(sName, grade, blk.startMin, blk.endMin);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        blk.type = 'slot';
                        blk.event = 'General Activity Slot';
                        blk._assignedSpecial = null;
                        blk._activityLocked = false;
                    }
                } else {
                    // Block is OK — but re-register the ACTUAL expanded range
                    // so subsequent grades see the real time footprint
                    registerSpecialUsage(sName, grade, blk.startMin, blk.endMin);
                }
            }

            return template.sort((a, b) => a.startMin - b.startMin);        }

        // =====================================================================
        // PHASE 4: EXECUTE TEMPLATES → bunkTimelines
        // =====================================================================

        function executeTemplates(allTemplates) {
            Object.entries(allTemplates).forEach(([bunk, template]) => {
                if (!template) return;
                const grade = Object.entries(divisions).find(([g, d]) => (d.bunks || []).map(String).includes(String(bunk)))?.[0];
                if (!grade) return;

                bunkTimelines[bunk] = [];
                template.forEach(block => {
                    bunkTimelines[bunk].push({
                        startMin: block.startMin, endMin: block.endMin,
                        type: block.type, event: block.event || block.type,
                        layer: block.layer || null,
                        _classification: block._fixed ? 'pinned' : (block._source === 'filler' ? 'gap' : 'windowed'),
                        _committed: true, _autoGenerated: true,
                        _assignedSpecial: block._assignedSpecial || null,
                        _specialDuration: block._specialDuration || null,
                        _specialLocation: block._specialLocation || null,
                        _assignedSport: block._assignedSport || null,
                        _activityLocked: block._activityLocked || block._fixed || block._source === 'soft_anchor' || false,
                        _fixed: block._fixed || false,
                        _gradeWide: block._gradeWide || false,
                        _noBacktrack: block._noBacktrack || false,
                        _pairedWith: block._pairedWith || null,
                        _isPrepBlock: block._isPrepBlock || false,
                        _isMainBlock: block._isMainBlock || false,
                        _linkedTo: block._linkedTo || null,
                        _fromGapDetection: block._source === 'filler',
                        _microGap: block._microGap || false,
                        _bunkOverride: true,
                        _draftActivity: block._customActivity || block._assignedSport || block._assignedSpecial || null,
                        _draftField: block._customField || block.field || null,
                        _sportFallbacks: block._sportFallbacks || null,
                        _customActivity: block._customActivity || null,
                        _customField: block._customField || null,
                        _customBunks: block._customBunks || null
                    });
                });
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
            });
        }


        // =====================================================================
        // SCORING ENGINE
        // =====================================================================

        const MAX_ITERATIONS = 60;
        const PERFECT_SCORE = 0;
        const STALE_STOP = 12;
        let _iterSeed = 0, bestScore = Infinity, bestTimelines = null;
        let bestWarnings = [], staleCount = 0, totalIters = 0;

        function scoreTimelines(timelines, iterWarnings) {
            let score = 0;
            Object.entries(timelines).forEach(([bunk, timeline]) => {
                // CEL duration violations
                timeline.forEach(block => {
                    if (block._microGap || (block._fromGapDetection && !block.layer)) return;
                    const { dMin } = resolveConstraints(block.layer, (block.type || 'slot').toLowerCase(), block);
                    const dur = block.endMin - block.startMin;
                    if (dur < dMin) score += (dMin - dur) * 200;
                });

                // Gaps
                const gradeKey = Object.entries(divisions).find(([g, d]) => (d.bunks || []).map(String).includes(String(bunk)))?.[0];
                const dayStart = gradeKey ? (parseTimeToMinutes(divisions[gradeKey]?.startTime) || 540) : 540;
                const dayEnd = gradeKey ? (parseTimeToMinutes(divisions[gradeKey]?.endTime) || 960) : 960;
                const sorted = [...timeline].sort((a, b) => a.startMin - b.startMin);
                if (sorted.length > 0 && sorted[0].startMin > dayStart) score += (sorted[0].startMin - dayStart) * 15;
                for (let i = 0; i < sorted.length - 1; i++) { const gap = sorted[i + 1].startMin - sorted[i].endMin; if (gap > 0) score += gap * 15; }
                if (sorted.length > 0 && sorted[sorted.length - 1].endMin < dayEnd) score += (dayEnd - sorted[sorted.length - 1].endMin) * 15;

                // Out of bounds
                if (gradeKey) timeline.forEach(b => { if (b.endMin <= dayStart || b.startMin >= dayEnd) score += 10000; });

                // Undersized filler
                timeline.forEach(b => { if (b._fromGapDetection) { const dur = b.endMin - b.startMin; if (dur < GAP_MIN_DUR) score += (GAP_MIN_DUR - dur) * 50; } });
            });

            iterWarnings.forEach(w => { if (w.type === 'placement_failure') score += 500; if (w.type === 'overlap') score += 1000; });

            // Field contention
            const campStart = Math.min(...Object.values(divisions).map(d => parseTimeToMinutes(d.startTime) || 660));
            const campEnd = Math.max(...Object.values(divisions).map(d => parseTimeToMinutes(d.endTime) || 990));
            for (let t = campStart; t < campEnd; t += CONTENTION_SLICE) {
                const se = Math.min(t + CONTENTION_SLICE, campEnd);
                let cnt = 0;
                Object.entries(timelines).forEach(([bk, tl]) => { for (const b of tl) { if (getFieldImpact(b) === 'consumer' && b.startMin < se && b.endMin > t) { cnt++; break; } } });
                if (cnt > FIELD_CAPACITY) score += (cnt - FIELD_CAPACITY) * 200;
            }
            return score;
        }

        // =====================================================================
        // RESET STATE
        // =====================================================================
        function resetIterState() {
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = []; bunkSpecialAssigned[bunk] = {}; }));
            todaysSpecials.forEach(s => { if (specialCapacityTracker[s.name]) specialCapacityTracker[s.name].assignments = []; });
            Object.keys(sharedLeagueTime).forEach(k => delete sharedLeagueTime[k]);
            resourceCalendar.swim = {};
            Object.keys(fieldLedger).forEach(k => { if (fieldLedger[k]) fieldLedger[k].claims = []; });
            resetCrossGradeTracker();
        }

        // =====================================================================
        // ITERATION LOOP
        // =====================================================================
        log('\n══════════════════════════════════════════════════════════');
        log('WHAT→WHEN→WHERE — cap: ' + MAX_ITERATIONS + ' | stale: ' + STALE_STOP);
        log('══════════════════════════════════════════════════════════');

        // Initialize special capacity trackers
        todaysSpecials.forEach(s => {
            specialCapacityTracker[s.name] = { total: getSpecialCapacity(s.name, activityProperties, globalSettings), assignments: [] };
        });

        // =====================================================================
        // SWIM ROTATION SYSTEM
        // Not every bunk swims every day. The swim layer config has:
        //   bunksPerDay: how many bunks swim each day (default: all)
        //   timesPerWeek: target swims per bunk per week (default: 5)
        // History tracks which bunks swam which days, persisted via cloud sync.
        // =====================================================================

        const swimHistory = {};
        function loadSwimHistory() {
            try {
                const gs = window.loadGlobalSettings?.() || {};
                const stored = gs.swimRotationHistory || gs.app1?.swimRotationHistory;
                if (stored) Object.assign(swimHistory, stored);
                // Also try localStorage
                const ls = localStorage.getItem('campistry_swimRotationHistory');
                if (ls && !stored) Object.assign(swimHistory, JSON.parse(ls));
            } catch (e) { /* ignore */ }
        }
        function saveSwimHistory() {
            try {
                const gs = window.loadGlobalSettings?.() || {};
                if (gs.app1) gs.app1.swimRotationHistory = swimHistory;
                else if (gs) gs.swimRotationHistory = swimHistory;
                localStorage.setItem('campistry_swimRotationHistory', JSON.stringify(swimHistory));
                if (window.IntegrationHooks?.queueChange) {
                    window.IntegrationHooks.queueChange('swimRotationHistory', swimHistory);
                }
            } catch (e) { /* ignore */ }
        }

        function getSwimmersForToday(grade, allBunks, swimLayer, seed) {
            // Read config from: dedicated config → layer properties → defaults
            const gs = window.loadGlobalSettings?.() || {};
            const dedicatedConfig = gs.swimRotationConfig?.[grade] ||
                JSON.parse(localStorage.getItem('campistry_swimRotationConfig') || '{}')?.[grade];
            
            const bunksPerDay = dedicatedConfig?.bunksPerDay || swimLayer.bunksPerDay || swimLayer._bunksPerDay || allBunks.length;
            const timesPerWeek = dedicatedConfig?.timesPerWeek || swimLayer.timesPerWeek || swimLayer._timesPerWeek || 5;

            // If bunksPerDay >= total bunks, everyone swims
            if (bunksPerDay >= allBunks.length) return allBunks;

            // Get this week's Monday
            const weekStart = getMondayOfWeek(currentDate, 0);

            // Count swims this week per bunk
            const weekCounts = {};
            allBunks.forEach(b => { weekCounts[String(b)] = 0; });

            const gradeHistory = swimHistory[grade] || {};
            Object.entries(gradeHistory).forEach(([dateStr, bunksArr]) => {
                if (dateStr >= weekStart && dateStr < currentDate) {
                    (bunksArr || []).forEach(b => {
                        if (weekCounts[String(b)] !== undefined) weekCounts[String(b)]++;
                    });
                }
            });

            // Sort bunks: fewest swims first, break ties with seeded shuffle
            const sorted = [...allBunks].map(b => ({
                bunk: b,
                count: weekCounts[String(b)] || 0,
                rand: ((seed * 2654435761 + parseInt(String(b).replace(/\D/g, '')) * 1597) >>> 0) % 10000
            }));
            sorted.sort((a, b) => {
                if (a.count !== b.count) return a.count - b.count; // fewest swims first
                return a.rand - b.rand; // random among ties
            });

            // ★ Only pick bunks that haven't hit their weekly target yet
            const needsSwim = sorted.filter(s => s.count < timesPerWeek);

            // If no one needs swim, skip entirely — everyone met target
            if (needsSwim.length === 0) {
                if (totalIters < 1) {
                    log('[SWIM-ROT] ' + grade + ': all bunks met ' + timesPerWeek + 'x/week target — no swim today');
                }
                if (!swimHistory[grade]) swimHistory[grade] = {};
                swimHistory[grade][currentDate] = [];
                return [];
            }

            // Pick up to bunksPerDay from those who still need it
            const selected = needsSwim.slice(0, bunksPerDay).map(s => s.bunk);

            // Record today's swimmers in history
            if (!swimHistory[grade]) swimHistory[grade] = {};
            swimHistory[grade][currentDate] = selected.map(String);

            if (totalIters < 1) {
                log('[SWIM-ROT] ' + grade + ': ' + selected.length + '/' + allBunks.length +
                    ' bunks swim today (target: ' + timesPerWeek + 'x/week)' +
                    ' — bunks: ' + selected.join(','));
            }

            return selected;
        }

        // Load swim history at startup
        loadSwimHistory();

        // =====================================================================
        // STAGGER PLANNER — ensures different grades do different things
        // at the same time. Prevents field/pool/location contention.
        // =====================================================================
        function buildStaggerPlan(grades, seed) {
            // Shuffle grades into a random order using seed
            const shuffled = [...grades];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = ((seed * 2654435761 + i * 1597) >>> 0) % (i + 1);
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            // Assign each grade a stagger offset (0, 1, 2, ...)
            const plan = {};
            shuffled.forEach((grade, idx) => {
                plan[grade] = {
                    offset: idx,
                    // Which fraction of the day this grade prefers for each type
                    // Offset 0 → leagues early, swim mid, special late
                    // Offset 1 → swim early, special mid, leagues late
                    // etc. — rotated by offset
                    searchDirection: idx % 2 === 0 ? 'early' : 'late'
                };
            });
            return plan;
        }

        do { // ← ITERATION LOOP

        // Build stagger plan for this iteration
        staggerPlan = buildStaggerPlan(allGrades, _iterSeed);
        if (totalIters < 1) {
            const order = allGrades.map(g => g.replace(' Grade', '') + '=' + (staggerPlan[g] || {}).offset).join(', ');
            log('[STAGGER] ' + order);
        }

        // ── Phase 0: Place all pinned + grade-wide + swim ────────────
        allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = []; bunkSpecialAssigned[bunk] = {}; }));

        // 0a. Pinned (any type)
        const pinnedCount = executePinnedLayers();

        // ★ INJECT DAILY TRIPS — block out time for entire divisions
       const dateKey = window.currentScheduleDate || window.currentDate || '';
        let dailyTrips = [];
        try { const stored = localStorage.getItem('campDailyTrips_' + dateKey); if (stored) dailyTrips = JSON.parse(stored); } catch(e) {}
        if (!dailyTrips.length) dailyTrips = window.loadCurrentDailyData?.()?.dailyTrips || [];
        let tripBlockCount = 0;
        dailyTrips.forEach(trip => {
            const grade = trip.division;
            if (!grade || !divisions[grade]) return;
            if (allowedSet && !allowedSet.has(String(grade))) return;
            const tStart = trip.startMin ?? parseTimeToMinutes(trip.startTime);
            const tEnd = trip.endMin ?? parseTimeToMinutes(trip.endTime);
            if (tStart == null || tEnd == null) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                bunkTimelines[bunk].push({
                    startMin: tStart, endMin: tEnd,
                    type: 'trip', event: trip.event || 'Trip',
                    layer: null, _classification: 'pinned',
                    _committed: true, _fixed: true, _isTrip: true,
                    _activityLocked: true, _noBacktrack: true
                });
                tripBlockCount++;
            });
        });
        if (tripBlockCount > 0) {
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin)));
            log('[0.1] Injected ' + tripBlockCount + ' trip blocks from daily trips');
        }

        // 0b. MRC for swim
        buildResourceCalendar(_iterSeed);

        // 0c. Non-pinned layers that need early placement
        // ★ STAGGERED: Leagues placed in stagger order so different grades
        //   get different time slots. Other layers go to greedy packer.

        // Collect and sort league layers by stagger offset
        const leagueLayers = [];
        const otherNonPinned = [];
        nonPinnedLayers.forEach(layer => {
            const grade = layer.grade || layer.division;
            if (!grade || (allowedSet && !allowedSet.has(String(grade)))) return;
            const t = (layer.type || '').toLowerCase();
            if (t === 'league' || t === 'specialty_league') {
                if (layer._classification !== 'pinned') leagueLayers.push(layer);
            } else {
                otherNonPinned.push(layer);
            }
        });

        // Sort leagues by stagger offset — different order each iteration
        leagueLayers.sort((a, b) => {
            const aOff = (staggerPlan[a.grade || a.division] || { offset: 0 }).offset;
            const bOff = (staggerPlan[b.grade || b.division] || { offset: 0 }).offset;
            return aOff - bOff;
        });

        // Place leagues in staggered order
        leagueLayers.forEach(layer => {
            const grade = layer.grade || layer.division;
            placeLeagueForGrade(grade, layer);
        });

        // Process other non-pinned layers
        otherNonPinned.forEach(layer => {
            const grade = layer.grade || layer.division;
            if (!grade) return;
            const t = (layer.type || '').toLowerCase();
            const bunks = getBunksForGrade(grade, divisions);
            if (!bunks.length) return;

            // Full-grade activities — truly fixed, not soft
            const isFullGrade = activityProperties[layer.event]?.fullGrade || activityProperties[layer.name]?.fullGrade;
            if (isFullGrade && layer._classification !== 'pinned') {
                placeLeagueForGrade(grade, layer);
                return;
            }

            // ★ Swim: handled by greedy packer per-bunk (not pre-placed)
            if (t === 'swim') return;

            // ★ Custom: handled by greedy packer per-bunk (not pre-placed)
            if (t === 'custom') return;

            // ★ All other non-pinned layers (snack, sport, special, etc.)
            // handled by the greedy packer per-bunk — not pre-placed.
        });

        if (totalIters < 2) log('[P0] ' + pinnedCount + ' pinned blocks placed');

        // ── Phase 1: Build shopping lists ────────────────────────────
        const shoppingLists = {};
        allGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                shoppingLists[bunk] = buildBunkShoppingList(bunk, grade);
            });
        });

        if (totalIters < 2) {
            const totalSports = Object.values(shoppingLists).reduce((s, l) => s + l.sports.required, 0);
            const totalSpecials = Object.values(shoppingLists).reduce((s, l) => s + l.specials.required, 0);
            log('[P1] Shopping lists: ' + totalSports + ' sport needs, ' + totalSpecials + ' special needs across ' + Object.keys(shoppingLists).length + ' bunks');
        }

        // ── Phase 2: Draft ───────────────────────────────────────────
        const draftResults = runDraft(shoppingLists);

        if (totalIters < 2) {
            const drafted = Object.values(draftResults);
            const dSports = drafted.reduce((s, d) => s + d.sports.length, 0);
            const dSpecials = drafted.reduce((s, d) => s + d.specials.length, 0);
            log('[P2] Draft assigned: ' + dSports + ' sports, ' + dSpecials + ' specials');
        }

        // ── Phase 3: Greedy pack per-bunk ──────────────────────────
        // ★ Process grades in STAGGER ORDER so early grades' placements
        //   influence later grades via cross-grade tracker
        const allTemplates = {};
        const staggeredGrades = [...allGrades].sort((a, b) =>
            ((staggerPlan[a] || {}).offset || 0) - ((staggerPlan[b] || {}).offset || 0)
        );

        // ★ Compute which bunks swim today per grade (swim rotation)
        const todaysSwimmers = {};
        staggeredGrades.forEach(grade => {
            const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
            if (swimLayer) {
                const allBunks = getBunksForGrade(grade, divisions);
                todaysSwimmers[grade] = new Set(
                    getSwimmersForToday(grade, allBunks, swimLayer, _iterSeed).map(String)
                );
            }
        });

        staggeredGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const swimsToday = todaysSwimmers[grade] ? todaysSwimmers[grade].has(String(bunk)) : true;
                allTemplates[bunk] = greedyPackBunk(
                    bunk, grade,
                    draftResults[bunk] || { sports: [], specials: [], elective: [], generic: [], usedActivities: new Set() },
                    shoppingLists[bunk],
                    (staggerPlan[grade] || { offset: 0 }).offset,
                    swimsToday
                );
            });
        });

        // ── Phase 4: Execute templates ───────────────────────────────
        executeTemplates(allTemplates);

        // ── Propagate sport fallbacks to ALL sport/slot blocks ──────
        // Ensures every sport slot has a fallback list for the post-solver sweep,
        // even if created by Step 5/6 (expand/gap sweep) which may not carry them.
        allGrades.forEach(grade => {
            const pl = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'sport');
            if (!pl) return;
            const priorityList = shoppingLists[getBunksForGrade(grade, divisions)[0]]?.sports?.priorityList || [];
            const fallbackNames = priorityList.map(s => s.name);
            if (!fallbackNames.length) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                (bunkTimelines[bunk] || []).forEach(b => {
                    const t = (b.type || '').toLowerCase();
                    if ((t === 'sport' || t === 'slot') && !b._sportFallbacks) {
                        b._sportFallbacks = fallbackNames;
                    }
                });
            });
        });


        // ── (Safety nets removed — greedy packer produces zero-gap schedules) ──

        // ── Score ────────────────────────────────────────────────────
        const iterWarnings = [];
        const iterScore = scoreTimelines(bunkTimelines, iterWarnings);
        totalIters++;

        // CIL
        extractFragments(bunkTimelines, iterScore);

        const improved = iterScore < bestScore;
        if (improved) {
            bestScore = iterScore;
            bestTimelines = {};
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bestTimelines[bunk] = bunkTimelines[bunk].map(b => ({ ...b })); }));
            bestWarnings = [...warnings]; staleCount = 0;
        } else staleCount++;

        if (improved || totalIters <= 3 || totalIters % 10 === 0) {
            log('[ITER ' + totalIters + '] score=' + iterScore + (improved ? ' ★ BEST' : '') + ' | best=' + bestScore + ' | stale=' + staleCount);
        }

        if (bestScore > PERFECT_SCORE && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS) { _iterSeed++; warnings.length = 0; resetIterState(); }

        } while (bestScore > PERFECT_SCORE && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS);

        // ═══════════════════════════════════════════════════════════════
        log('══════════════════════════════════════════════════════════');
        log('BEST: ' + bestScore + ' after ' + totalIters + ' iterations');
        log('══════════════════════════════════════════════════════════');

        // Restore best
        allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = bestTimelines[bunk] || []; }));
        warnings.length = 0; bestWarnings.forEach(w => warnings.push(w));

        // Debug exports
        window._bunkNeeds = {};
        window._bunkTimelines = JSON.parse(JSON.stringify(bunkTimelines));
        window._autoBuildTimelines = JSON.parse(JSON.stringify(bunkTimelines));


        // =====================================================================
        // STEP 2.6 — VALIDATE
        // =====================================================================
        log('\n[STEP 2.6] Validating...');
        let validationPassed = true;
        allGrades.forEach(grade => {
            const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
            const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const tl = bunkTimelines[bunk] || [];
                for (let i = 0; i < tl.length - 1; i++) { if (tl[i].endMin > tl[i + 1].startMin) { err('[2.6] OVERLAP ' + bunk); validationPassed = false; warnings.push({ type: 'overlap', bunk, grade }); } }
                validateTimelineIntegrity(bunk).forEach(v => { if (v.type === 'undersized') { warn('[2.6] [CEL] ' + v.msg); validationPassed = false; warnings.push({ type: 'duration_violation', bunk, grade, detail: v.msg }); } });
                tl.forEach(b => { if (b.startMin == null || b.endMin == null || b.endMin <= b.startMin) { validationPassed = false; } });
                if (getFreeGaps(bunk, gs, ge).length > 0) warnings.push({ type: 'remaining_gap', bunk, grade });
            });
        });
        log('[2.6] ' + (validationPassed ? '✅ Passed' : '⚠️ Errors'));

        // =====================================================================
        // STEP 2.7 — FORMALIZE
        // =====================================================================
        log('\n[STEP 2.7] Formalizing...');
        const autoSkeleton = [];
        allGrades.forEach(grade => {
            getBunksForGrade(grade, divisions).forEach(bunk => {
                (bunkTimelines[bunk] || []).forEach(block => {
                    autoSkeleton.push({
                        division: grade, _bunk: bunk,
                        startTime: minutesToTimeLabel(block.startMin), endTime: minutesToTimeLabel(block.endMin),
                        startMin: block.startMin, endMin: block.endMin,
                        event: block.event || 'General Activity Slot', type: block.type || 'slot',
                        _autoGenerated: true, _classification: block._classification,
                        _suggestedActivity: block._assignedSpecial || block._assignedSport || null,
                        _activityLocked: block._activityLocked || false,
                        _durationStrict: block._activityLocked || false,
                        _fixed: block._fixed || false, _pinned: block._classification === 'pinned',
                        _isScarce: block._isScarce || false, _specialLocation: block._specialLocation || null,
                        _draftActivity: block._draftActivity || null, _draftField: block._draftField || null
                    });
                });
            });
        });

        window.manualSkeleton = autoSkeleton;
        window._autoSkeleton = autoSkeleton;

        if (window.DivisionTimesSystem) {
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(autoSkeleton, divisions);
            allGrades.forEach(grade => {
                const ds = window.divisionTimes[grade]; if (!ds) return;
                const pbs = {};
                getBunksForGrade(grade, divisions).forEach(bunk => {
                    pbs[String(bunk)] = autoSkeleton.filter(b => b.division === grade && String(b._bunk) === String(bunk))
                        .sort((a, b) => a.startMin - b.startMin)
                        .map((b, i) => ({ startMin: b.startMin, endMin: b.endMin, startTime: b.startTime, endTime: b.endTime, type: b.type, event: b.event, slotIndex: i, _bunk: bunk, _autoGenerated: true }));
                });
                window.divisionTimes[grade]._perBunkSlots = pbs;
            });
            window._perBunkSlots = {};
            allGrades.forEach(grade => { const ds = window.divisionTimes[grade]; if (ds && ds._perBunkSlots) window._perBunkSlots[grade] = ds._perBunkSlots; });
        } else { err('[2.7] DivisionTimesSystem not available'); }

        // Initialize scheduleAssignments
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots || window._perBunkSlots?.[grade];
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = (pbs && pbs[String(bunk)]) || [];
                window.scheduleAssignments[String(bunk)] = new Array(arr.length).fill(null);
            });
        });

        // Write special blocks
        let specialWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots || window._perBunkSlots?.[grade]; if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b => b.type === 'special' && b._assignedSpecial).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin); if (idx === -1) return;
                    const fn = block._specialLocation || block._assignedSpecial;
                    window.scheduleAssignments[String(bunk)][idx] = { field: fn, sport: null, _activity: block._assignedSpecial, _fixed: true, _bunkOverride: true, _activityLocked: true, _isScarce: block._isScarce || false, _autoSpecial: true, _autoMode: true, continuation: false };
                    registerSpecialFieldUsage([idx], fn, String(bunk), block._assignedSpecial, grade, fieldUsageBySlot);
                    if (fn && window.GlobalFieldLocks) window.GlobalFieldLocks.lockField(fn, [idx], { lockedBy: 'auto_special', division: grade, activity: block._assignedSpecial });
                    specialWriteCount++;
                });
            });
        });

        // Write pinned + fixed-type blocks
        let pinnedWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots || window._perBunkSlots?.[grade]; if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b => (b._fixed || b._classification === 'pinned') && b._committed).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1 || window.scheduleAssignments[String(bunk)][idx]) return;
                    // ★ Custom blocks: use customField and customActivity
                    const isCustom = (block.type || '').toLowerCase() === 'custom' && block._customField;
                    window.scheduleAssignments[String(bunk)][idx] = {
                        field: isCustom ? block._customField : block.event,
                        sport: null,
                        _activity: isCustom ? (block._customActivity || block.event) : block.event,
                        _fixed: true, _pinned: true, _bunkOverride: true,
                        _customActivity: block._customActivity || null,
                        _customField: block._customField || null,
                        continuation: false
                    };
                    pinnedWriteCount++;
                });
            });
        });

        // ★ Write custom (non-pinned) blocks — they have pre-assigned fields
        let customWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots || window._perBunkSlots?.[grade]; if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b => (b.type || '').toLowerCase() === 'custom' && b._customField && !b._fixed).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1 || window.scheduleAssignments[String(bunk)][idx]) return;
                    window.scheduleAssignments[String(bunk)][idx] = {
                        field: block._customField,
                        sport: null,
                        _activity: block._customActivity || block.event || 'Custom',
                        _fixed: true, _bunkOverride: true, _activityLocked: true,
                        _customActivity: block._customActivity || null,
                        _customField: block._customField || null,
                        _autoMode: true, continuation: false
                    };
                    // Lock the field so solver/fallback doesn't assign it to others
                    if (block._customField && window.GlobalFieldLocks) {
                        window.GlobalFieldLocks.lockField(block._customField, [idx], {
                            lockedBy: 'auto_custom', division: grade,
                            activity: block._customActivity || 'Custom'
                        });
                    }
                    customWriteCount++;
                });
            });
        });
        if (customWriteCount > 0) log('[2.7] Wrote ' + customWriteCount + ' custom activity blocks');

        window._divisionTimesLocked = true;
        window._autoDivisionTimesBuilt = true;
        window._preGenClearActive = false;

        // Write activity-locked anchor blocks (swim, soft-anchored snacks, etc.)
        // These aren't specials or pinned but have a fixed activity that the solver shouldn't change.
        let anchorWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots || window._perBunkSlots?.[grade]; if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b => b._activityLocked && b._committed && !b._assignedSpecial && !(b._fixed || b._classification === 'pinned')).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1 || window.scheduleAssignments[String(bunk)][idx]) return;
                    window.scheduleAssignments[String(bunk)][idx] = {
                        field: block.event, sport: null, _activity: block.event,
                        _fixed: true, _bunkOverride: true, _activityLocked: true,
                        _autoMode: true, continuation: false
                    };
                    anchorWriteCount++;
                });
            });
        });

        log('[2.7] ✅ ' + specialWriteCount + ' specials, ' + pinnedWriteCount + ' pinned, ' + anchorWriteCount + ' anchors written');

        // Build schedulable blocks for solver
        const schedulableSlotBlocks = [];
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots || window._perBunkSlots?.[grade]; if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                arr.forEach((block, idx) => {
                    if ((block._classification || block.type || '') === 'pinned') return;
                    if ((block.type || '') === 'special') return;
                    if (block._activityLocked) return;
                    const ex = window.scheduleAssignments[String(bunk)][idx];
                    if (ex && ex.field !== 'Free') return;
                    if (ex && ex.field === 'Free' && !ex._fixed) window.scheduleAssignments[String(bunk)][idx] = null;
                    const skipTypes = ['swim', 'snacks', 'lunch', 'dismissal', 'pinned', 'league', 'specialty_league'];
                    if (skipTypes.includes((block.type || '').toLowerCase())) return;

                    // ★ Find the draft-assigned activity for this slot (by matching time)
                    const timelineBlock = (bunkTimelines[bunk] || []).find(b => b.startMin === block.startMin && b.endMin === block.endMin);

                    schedulableSlotBlocks.push({
                        divName: grade, bunk: String(bunk),
                        event: (() => {
                            const t = (block.type || '').toLowerCase();
                            if (t === 'sport' || t === 'sports') return 'Sports Slot';
                            const _dal = window.loadGlobalSettings?.()?.app1?.dailyAutoLayers || {};
                            const gl = (_dal[currentDate] || {})[grade] || [];
                            if (gl.some(l => l.type === 'sport' && block.startMin >= l.startMin && block.endMin <= l.endMin)) return 'Sports Slot';
                            return 'General Activity Slot';
                        })(),
                        type: 'slot', startTime: minutesToTimeLabel(block.startMin), endTime: minutesToTimeLabel(block.endMin),
                        slots: [idx], _durationStrict: false, _autoGenerated: true,
                        _suggestedActivity: timelineBlock?._draftActivity || null,
                        _draftActivity: timelineBlock?._draftActivity || null,
                        _draftField: timelineBlock?._draftField || null,
                        _fromGapDetection: block._fromGapDetection || false,
                        _perBunkSlot: true, _originalType: block.type
                    });
                });
            });
        });
        log('[2.7] ' + schedulableSlotBlocks.length + ' schedulable blocks for solver');


        // =====================================================================
        // STEP 3 — LEAGUE ENGINES (unchanged from v2)
        // =====================================================================
        const yesterdayHistory = (() => {
            const parts = (currentDate || '').split('-').map(Number); if (!parts[0]) return {};
            const d = new Date(parts[0], parts[1] - 1, parts[2]); d.setDate(d.getDate() - 1);
            const yk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            return allDailyData[yk]?.scheduleAssignments || {};
        })();

        log('\n[STEP 3] League engines...');
        const leagueBlocks = (() => {
            const seen = new Set();
            return autoSkeleton.filter(b => { if (b.type !== 'league' && b.type !== 'specialty_league') return false; const k = b.division + '_' + b.startMin; if (seen.has(k)) return false; seen.add(k); return true; })
                .map(b => ({ divName: b.division, bunk: String(b._bunk || ''), event: b.type === 'league' ? 'League Game' : 'Specialty League', type: b.type, startTime: b.startTime || minutesToTimeLabel(b.startMin), endTime: b.endTime || minutesToTimeLabel(b.endMin), startMin: b.startMin, endMin: b.endMin, slots: (() => { const ds = window.divisionTimes?.[b.division]; if (!Array.isArray(ds)) return []; const idx = ds.findIndex(s => s.startMin === b.startMin); return idx >= 0 ? [idx] : []; })(), _autoGenerated: true }));
        })();

        if (leagueBlocks.length > 0) {
            const mla = Array.isArray(window.masterLeagues) ? window.masterLeagues : Object.values(window.masterLeagues || {});
            const lctx = {
                schedulableSlotBlocks: leagueBlocks, fieldUsageBySlot, activityProperties,
                masterLeagues: mla, disabledLeagues: window.disabledLeagues || [],
                masterSpecialtyLeagues: window.masterSpecialtyLeagues || [], disabledSpecialtyLeagues: window.disabledSpecialtyLeagues || [],
                rotationHistory: window.rotationHistory || {}, yesterdayHistory, divisions,
                fieldsBySport: window.fieldsBySport || {}, dailyLeagueSportsUsage: {},
                fillBlock: window.fillBlock || function() {}, fields: getFields(globalSettings),
                disabledFields: globalSettings.app1?.disabledFields || globalSettings.disabledFields || [],
                leagueAssignments: window.leagueAssignments,
                storeLeagueMatchups: function(divName, slots, matchups, gameLabel, sport, leagueName) {
                    const league = mla.find(l => l.name === leagueName);
                    const covDivs = (league?.divisions || [leagueName]).filter(d => autoSkeleton.some(b => b.division === d && b.type === 'league'));
                    (covDivs.length > 0 ? covDivs : [divName]).forEach(div => {
                        const lb = autoSkeleton.find(b => b.division === div && b.type === 'league'); if (!lb) return;
                        if (!window.leagueAssignments[div]) window.leagueAssignments[div] = {};
                        window.leagueAssignments[div][lb.startMin] = { matchups: matchups || [], gameLabel: gameLabel || '', sport: sport || '', leagueName: leagueName || '' };
                    });
                }
            };
            if (window.SchedulerCoreSpecialtyLeagues?.processSpecialtyLeagues) { try { lctx.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'specialty_league'); window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(lctx); } catch (e) { warn('[3] Specialty: ' + e.message); } }
            if (window.SchedulerCoreLeagues?.processRegularLeagues) { try { lctx.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'league'); window.SchedulerCoreLeagues.processRegularLeagues(lctx); } catch (e) { warn('[3] Regular: ' + e.message); } }

            let leagueWriteCount = 0;
            Object.entries(window.leagueAssignments || {}).forEach(([gn, gs]) => {
                const lsb = autoSkeleton.find(b => b.division === gn && b.type === 'league'); if (!lsb) return;
                const asgn = Object.values(gs)[0]; if (!asgn) return;
                const pbs = window.divisionTimes?.[gn]?._perBunkSlots; if (!pbs) return;
                Object.entries(pbs).forEach(([bk, bs]) => {
                    const fi = bs.findIndex(s => s.startMin === lsb.startMin); if (fi === -1 || !window.scheduleAssignments[bk]) return;
                    window.scheduleAssignments[bk][fi] = { field: asgn.sport || 'League Game', sport: asgn.sport || null, _activity: 'League Game', _league: true, _leagueName: asgn.leagueName || '', _gameLabel: asgn.gameLabel || '', matchups: asgn.matchups || [], _fixed: true, continuation: false };
                    leagueWriteCount++;
                });
            });
            log('[3] Wrote ' + leagueWriteCount + ' league slots');
        } else { log('[3] No leagues'); }

        const solverBlocks = schedulableSlotBlocks.filter(b => b.type !== 'league' && b.type !== 'specialty_league');
        log('[3] ✅ ' + solverBlocks.length + ' blocks for solver');

        // =====================================================================
        // STEP 4 — TOTAL SOLVER
        // ★ Solver receives blocks with _draftActivity hints from the draft.
        // =====================================================================
        log('\n[STEP 4] Total Solver...');
        const Solver = window.TotalSolverEngine || window.TotalSolver || window.totalSolverEngine;
        if (Solver && typeof Solver.solveSchedule === 'function') {
            try {
                const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
                const masterFields = gs.app1?.fields || gs.fields || window.fields || [];
                const masterSpecials = gs.app1?.specialActivities || gs.specialActivities || [];
                const builtAP = window.buildActivityProperties ? window.buildActivityProperties(masterSpecials, masterFields) : {};
               masterFields.forEach(f => { (f.activities || []).forEach(a => { if (!builtAP[a]) builtAP[a] = { available: true, sharable: false, sharableWith: { type: 'not_sharable' }, _fromField: true }; if (!builtAP[a]._fields) builtAP[a]._fields = []; builtAP[a]._fields.push(f.name); }); if (f.name) { if (!builtAP[f.name]) builtAP[f.name] = {}; if (f.sharableWith) builtAP[f.name].sharableWith = f.sharableWith; if (f.capacity) builtAP[f.name].capacity = parseInt(f.capacity) || 2; builtAP[f.name].type = 'field'; builtAP[f.name].isField = true; builtAP[f.name].isIndoor = f.isIndoor || false; } });                window.activityProperties = builtAP;
                const fbs = {}; masterFields.forEach(f => { (f.activities || []).forEach(a => { if (!fbs[a]) fbs[a] = []; fbs[a].push(f.name); }); }); window.fieldsBySport = fbs;
                const rh = (window.loadRotationHistory?.() || {}).bunks || window.loadRotationHistory?.() || {};
                const ab = solverBlocks.map(b => ({ bunk: b.bunk, divName: b.divName, slots: b.slots, startTime: b.startTime, endTime: b.endTime, type: b.type || 'slot', event: b.event || 'General Activity Slot', _autoGenerated: true, _startMin: (window.divisionTimes?.[b.divName]?._perBunkSlots?.[b.bunk] || [])[b.slots?.[0]]?.startMin, _autoMode: true, _draftActivity: b._draftActivity, _draftField: b._draftField }));

                const _origLAF = window.SchedulerCoreUtils.loadAndFilterData;
                window.SchedulerCoreUtils.loadAndFilterData = function() { const r = _origLAF.apply(this, arguments); r.fieldsBySport = fbs; r.masterSpecials = []; r.specialActivityNames = []; r.activities = (r.activities || []).filter(a => (a.type || '').toLowerCase() !== 'special'); r.allActivities = (r.allActivities || []).filter(a => (a.type || '').toLowerCase() !== 'special'); return r; };
                const _origPR = window._SolverInternals.precomputeResourceMaps;
                window._SolverInternals.precomputeResourceMaps = function() { _origPR.apply(this, arguments); if (window._SolverInternals.allCandidateOptions) { const a = window._SolverInternals.allCandidateOptions; for (let i = a.length - 1; i >= 0; i--) if (a[i].type === 'special') a.splice(i, 1); } };

                Object.keys(window.scheduleAssignments).forEach(bk => { (window.scheduleAssignments[bk] || []).forEach((s, i) => { if (s && !s._fixed && !s._league && !s._autoSpecial) window.scheduleAssignments[bk][i] = null; }); });
                window.fieldUsageBySlot = window.buildFieldUsageBySlot ? window.buildFieldUsageBySlot() : {};

                const _origAP = window.activityProperties;
                const stripped = {}; Object.entries(window.activityProperties || {}).forEach(([k, v]) => { if (!masterSpecials.some(s => s.name === k)) stripped[k] = v; }); window.activityProperties = stripped;
                Solver.solveSchedule(ab, { activityProperties: builtAP, rotationHistory: rh, divisions, masterFields, masterSpecials: [], fieldsBySport: fbs, dateStr: currentDate || '', disabledFields: gs.app1?.disabledFields || [], yesterdayHistory, isRainy, _autoMode: true });
                window.activityProperties = _origAP;
                window.SchedulerCoreUtils.loadAndFilterData = _origLAF;
                window._SolverInternals.precomputeResourceMaps = _origPR;

                let filled = 0; ab.forEach(b => { const s = (window.scheduleAssignments?.[b.bunk] || [])[b.slots?.[0]]; if (s && !s._league && !s._fixed) filled++; });
                log('[4] ✅ Solver filled ~' + filled + ' slots');

       // Run this AFTER generating to check what the solver actually assigned
(function() {
  const sa = window.scheduleAssignments || {};
  const divs = window.divisions || {};
  const dt = window.divisionTimes || {};
  
  // Count Free blocks and where they are
  let freeCount = 0;
  const freeByGrade = {};
  Object.entries(sa).forEach(([bunk, slots]) => {
    const grade = Object.entries(divs).find(([g, d]) => (d.bunks || []).map(String).includes(String(bunk)))?.[0];
    (slots || []).forEach((s, i) => {
      if (s && s.field === 'Free') {
        freeCount++;
        if (!freeByGrade[grade]) freeByGrade[grade] = [];
        const pbs = dt[grade]?._perBunkSlots?.[bunk]?.[i];
        freeByGrade[grade].push({ bunk, idx: i, time: pbs ? `${pbs.startMin}-${pbs.endMin}` : '?' });
      }
    });
  });
  
  console.log('%c═══ FREE BLOCK ANALYSIS ═══', 'color:#C62828;font-weight:bold');
  console.log(`Total Free: ${freeCount}`);
  Object.entries(freeByGrade).forEach(([g, blocks]) => {
    console.log(`\n${g}: ${blocks.length} Free`);
    blocks.forEach(b => console.log(`  Bunk ${b.bunk} slot ${b.idx} @ ${b.time}`));
  });
  
  // Check: did the solver's bunk-prefixed grouping work?
  // In auto mode, each bunk should be its own group
  console.log('\n%cSlot group key check (first 10 blocks):', 'color:#1565C0;font-weight:bold');
  const firstBunks = Object.keys(sa).slice(0, 3);
  firstBunks.forEach(bunk => {
    const grade = Object.entries(divs).find(([g, d]) => (d.bunks || []).map(String).includes(String(bunk)))?.[0];
    const pbs = dt[grade]?._perBunkSlots?.[bunk] || [];
    console.log(`  Bunk ${bunk} (${grade}): ${pbs.length} per-bunk slots`);
    pbs.slice(0, 3).forEach((s, i) => {
      const assign = sa[bunk]?.[i];
      console.log(`    [${i}] ${s.startMin}-${s.endMin} → ${assign ? (assign.field + ' / ' + assign._activity) : 'NULL'}`);
    });
  });
})();
            } catch (e) { err('[4] ' + e.message); console.error(e); warnings.push({ type: 'solver_error', message: e.message }); }
        } else { warn('[4] Solver not loaded'); }

        // =====================================================================
        // STEP 5 — SAVE
        // =====================================================================
        saveSwimHistory();
        log('\n[STEP 5] Saving...');
        if (window.saveCurrentDailyData) {
            try {
                const clean = {}; Object.entries(window.scheduleAssignments || {}).forEach(([b, s]) => { clean[b] = (s || []).map(x => (x && x.field === 'Free' && !x._fixed) ? null : x); });
                const spbs = {}; Object.keys(window.divisionTimes || {}).forEach(g => { if (window.divisionTimes[g]?._perBunkSlots) spbs[g] = window.divisionTimes[g]._perBunkSlots; });
              // ★★★ SINGLE WRITE: Avoid 8x localStorage churn that causes quota eviction ★★★
                const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                const DAILY_KEY = 'campDailyData_v1';
                const allDaily = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                if (!allDaily[dateKey]) allDaily[dateKey] = {};
                Object.assign(allDaily[dateKey], {
                    scheduleAssignments: clean,
                    leagueAssignments: window.leagueAssignments || {},
                    manualSkeleton: autoSkeleton,
                    _perBunkSlotsData: spbs,
                    _autoGenerated: true,
                    _autoVersion: VERSION,
                    _generatedAt: new Date().toISOString(),
                    _warnings: warnings,
                    divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes || {}
                });
                localStorage.setItem(DAILY_KEY, JSON.stringify(allDaily));
                // Also trigger cloud save via the bridge
                if (typeof window.saveGlobalSettings === 'function') {
                    window.saveGlobalSettings('daily_schedules', allDaily);
                }               log('[5] Saved');
            } catch (e) { warn('[5] Save error: ' + e.message); }
        }
        if (window.SupabaseSyncEngine?.pushSchedule) { try { await window.SupabaseSyncEngine.pushSchedule(window.scheduleAssignments, window.currentScheduleDate || window.currentDate); log('[5] Synced'); } catch (e) { warn('[5] Sync: ' + e.message); } }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        log('\n═══════════════════════════════════════════════════════════');
        log('COMPLETE in ' + elapsed + 's | Warnings: ' + warnings.length);
        warnings.forEach((w, i) => log('  ' + (i + 1) + '. [' + w.type + '] ' + (w.message || JSON.stringify(w))));
        log('═══════════════════════════════════════════════════════════');

        window.dispatchEvent(new CustomEvent('campistry-generation-complete', { detail: { mode: 'auto', version: VERSION, elapsed, warnings } }));
        return { success: true, warnings, elapsed, blocksScheduled: solverBlocks.length, specialBlocksLocked: specialWriteCount };
    };

    log('scheduler_core_auto.js v' + VERSION + ' loaded — WHAT→WHEN→WHERE');
})();
