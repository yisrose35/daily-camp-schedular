// =============================================================================
// scheduler_core_auto.js — CAMPISTRY AUTO SCHEDULER CORE v4.0
// =============================================================================
// WHAT → WHEN → WHERE Architecture
//
// Phase 0: Place PINNED layers + trips + grade-wide anchors (leagues)
// Phase 1: Build exhaustive ranked activity lists per bunk (the WHAT)
// Phase 2: Draft-style assignment with live field ledger (the WHERE)
// Phase 3: Greedy pack per-bunk with constraint enforcement (the WHEN)
// Phase 4: Execute templates into bunkTimelines
//
// SUBSYSTEMS:
//   CEL  — Constraint Enforcement Layer (duration validation)
//   MRC  — Multi-Bunk Resource Coordination (swim pool staggering)
//   CIL  — Cross-Iteration Learning (remembers what worked)
//   RT   — Resource Tracker (unified: specials, swim, fields)
//
// v4.0 KEY FIXES:
//   1. Cross-division special conflicts fixed AT PLACEMENT — specials
//      register worst-case (dMax) range; expand phase NEVER stretches
//      specials past their registered time; canUseSpecialAtTime handles
//      all sharing types (not_sharable, same_division, custom, all).
//   2. Field capacity violations fixed — field ledger persists across
//      grades during packing; post-expand validation sweep re-checks
//      every field claim at actual times and swaps violations.
//   3. Swim pool capacity enforcement — pool treated as exclusive
//      resource; one grade at a time gated by canUsePoolAtTime.
//   4. Clean solver integration — no monkey-patching of internal
//      solver functions; stripped activityProperties passed cleanly.
//   5. Diagnostics moved to post-gen callables on window.
//   6. Iteration cap reduced (30 max, 8 stale) with smarter scoring.
//
// PIPELINE (external interface unchanged):
//   Step 0    — Wipe clean
//   Step 1    — Load data + classify layers
//   Step 2    — Phase 0→1→2→3→4 + validate + formalize
//   Step 3    — League engines
//   Step 4    — Total Solver (sport slots only, no specials)
//   Step 5    — Fallback sweep for remaining Free blocks
//   Step 6    — Save + fire campistry-generation-complete
// =============================================================================

(function () {
    'use strict';

    const VERSION = '4.0.0';
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
    function overlaps(aS, aE, bS, bE) { return aS < bE && aE > bS; }
    function snapTo5(val) { return Math.round(val / 5) * 5; }

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
            return {
                startMin: typeof start === 'number' ? start : parseTimeToMinutes(start),
                endMin: typeof end === 'number' ? end : parseTimeToMinutes(end)
            };
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

    function getSpecialDuration(specialName, activityProperties, gs) {
        const props = activityProperties && activityProperties[specialName];
        if (props) {
            const d = props.defaultDuration || props.duration || props.durationMin || props.periodMin;
            if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
        }
        const cfg = getSpecialConfig(specialName, gs);
        if (cfg) {
            const d = cfg.defaultDuration || cfg.duration || cfg.durationMin || cfg.periodMin;
            if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
        }
        if (window.getSpecialActivityByName) {
            const live = window.getSpecialActivityByName(specialName);
            if (live) {
                const d = live.defaultDuration || live.duration || live.durationMin;
                if (d && parseInt(d, 10) > 0) return parseInt(d, 10);
            }
        }
        return null; // null = use layer dMin/dMax range
    }

    function getSpecialCapacity(specialName, activityProperties, gs) {
        const cfg = getSpecialConfig(specialName, gs);
        if (cfg) {
            if (cfg.sharableWith) {
                if (cfg.sharableWith.type === 'not_sharable') return 1;
                const c = parseInt(cfg.sharableWith.capacity);
                if (!isNaN(c) && c > 0) return c;
            }
            const c = parseInt(cfg.capacity) || parseInt(cfg.maxBunks);
            if (!isNaN(c) && c > 0) return c;
        }
        const props = activityProperties && activityProperties[specialName];
        if (props) {
            if (props.sharableWith) {
                if (props.sharableWith.type === 'not_sharable') return 1;
                if (props.sharableWith.capacity) return parseInt(props.sharableWith.capacity) || 1;
            }
            if (props.capacity) return parseInt(props.capacity);
            if (props.maxBunks) return parseInt(props.maxBunks);
        }
        return 2;
    }

    function getSpecialSharingInfo(specialName, activityProperties, gs) {
        let shareType = 'not_sharable', cap = 1, allowedDivs = [];
        const props = activityProperties && activityProperties[specialName];
        if (props && props.sharableWith && props.sharableWith.type) {
            shareType = props.sharableWith.type;
            cap = parseInt(props.sharableWith.capacity) || (shareType === 'not_sharable' ? 1 : 2);
            allowedDivs = props.sharableWith.divisions || [];
        } else {
            const cfg = getSpecialConfig(specialName, gs);
            if (cfg && cfg.sharableWith && cfg.sharableWith.type) {
                shareType = cfg.sharableWith.type;
                cap = parseInt(cfg.sharableWith.capacity) || (shareType === 'not_sharable' ? 1 : 2);
                allowedDivs = cfg.sharableWith.divisions || [];
            }
        }
        return { shareType, capacity: cap, allowedDivisions: allowedDivs };
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
        if (Array.isArray(cfg.availableDays) && cfg.availableDays.length > 0)
            return cfg.availableDays.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
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

    function isSpecialOnField(blockOrName, activityProperties, gs) {
        const loc = typeof blockOrName === 'string'
            ? getLocationForSpecial(blockOrName, activityProperties, gs)
            : (blockOrName._specialLocation || null);
        if (!loc) return false;
        const props = activityProperties && activityProperties[loc];
        if (props && props.type === 'field') return true;
        return (gs?.app1?.fields || []).some(f => f.name === loc);
    }

    function registerSpecialFieldUsage(slotIndices, fieldName, bunkName, activityName, divName, fieldUsageBySlot) {
        for (const slotIdx of slotIndices) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fieldName])
                fieldUsageBySlot[slotIdx][fieldName] = { count: 0, divisions: [], bunks: {}, _locked: false };
            fieldUsageBySlot[slotIdx][fieldName].count++;
            fieldUsageBySlot[slotIdx][fieldName].bunks[bunkName] = activityName;
            if (divName && !fieldUsageBySlot[slotIdx][fieldName].divisions.includes(divName))
                fieldUsageBySlot[slotIdx][fieldName].divisions.push(divName);
        }
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
        if (window.AutoFieldLocks) {
            window.AutoFieldLocks.reset();
            window.AutoFieldLocks.buildFieldPropertyCache();
        }
        if (window.RotationEngine && window.RotationEngine.rebuildAllHistory)
            window.RotationEngine.rebuildAllHistory();
        log('[STEP 0] ✅ Wiped');

        // =====================================================================
        // STEP 1 — LOAD DATA
        // =====================================================================
        log('\n[STEP 1] Loading...');
        if (!layers || layers.length === 0) {
            err('No layers');
            window._preGenClearActive = false;
            return false;
        }

        const globalSettings = getGlobalSettings();
        const divisions = window.divisions || (globalSettings.app1 && globalSettings.app1.divisions) || {};
        const activityProperties = window.activityProperties || {};
        const dailyData = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
        if (window.isRainyDay === undefined)
            window.isRainyDay = dailyData.rainyDayMode === true || dailyData.isRainyDay === true;
        const isRainy = !!window.isRainyDay;

        const currentDate = window.currentScheduleDate || window.currentDate || '';
        let dayName = 'Monday';
        if (currentDate) {
            const parts = currentDate.split('-').map(Number);
            const dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
            dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
        }

        const allDailyData = window.loadAllDailyData ? window.loadAllDailyData() : {};

        // ── Period helpers ────────────────────────────────────────────
        function getMondayOfWeek(dateStr, weeksBack) {
            if (!dateStr) return null;
            const parts = dateStr.split('-').map(Number);
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            const dow = d.getDay();
            const daysToMon = dow === 0 ? 6 : dow - 1;
            d.setDate(d.getDate() - daysToMon - (weeksBack * 7));
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        function getHalfStartDate() {
            const s = globalSettings.app1 || globalSettings;
            return s.halfStartDate || s.currentHalfStart || s.sessionHalfStart || (Object.keys(allDailyData).sort()[0] || null);
        }
        function getPeriodStartDate(period) {
            switch (period) {
                case '1week': return getMondayOfWeek(currentDate, 0);
                case '2weeks': return getMondayOfWeek(currentDate, 1);
                case '3weeks': return getMondayOfWeek(currentDate, 2);
                case '4weeks': return getMondayOfWeek(currentDate, 3);
                default: return getHalfStartDate();
            }
        }
        function getPeriodCount(bunk, specialName, maxUsagePeriod) {
            const periodStart = getPeriodStartDate(maxUsagePeriod || 'half');
            let count = 0;
            Object.entries(allDailyData).forEach(([dateKey, dayData]) => {
                if (dateKey >= currentDate) return;
                if (periodStart && dateKey < periodStart) return;
                const slots = dayData?.scheduleAssignments?.[bunk];
                if (!Array.isArray(slots)) return;
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
        const sharedLeagueTime = {};
        let staggerPlan = {};


        // =====================================================================
        // CEL — CONSTRAINT ENFORCEMENT LAYER
        // =====================================================================
        const GAP_MIN_DUR = 20;
        const GAP_MAX_DUR = 60;
        const CONTENTION_SLICE = 10;

        const TYPE_FLOORS = {
            swim: 30, league: 30, specialty_league: 30, special: 20,
            sport: 25, sports: 25, lunch: 20, snack: 15, snacks: 15,
            dismissal: 10, slot: GAP_MIN_DUR, activity: GAP_MIN_DUR, elective: 20
        };
        const TYPE_CEILINGS = {
            swim: 60, league: 60, specialty_league: 60, special: 60,
            sport: GAP_MAX_DUR, sports: GAP_MAX_DUR, lunch: 45, snack: 30,
            snacks: 30, dismissal: 30, slot: GAP_MAX_DUR, activity: GAP_MAX_DUR, elective: 60
        };

        function resolveConstraints(layer, type, block) {
            const t = (type || layer?.type || 'slot').toLowerCase();
            const typeFloor = TYPE_FLOORS[t] || GAP_MIN_DUR;
            const typeCeiling = TYPE_CEILINGS[t] || GAP_MAX_DUR;
            if (!layer) return { dMin: typeFloor, dMax: typeCeiling, dIdeal: snapTo5(Math.round((typeFloor + typeCeiling) / 2)) };

            const rawMin = layer.durationMin || layer.periodMin || layer.duration || 0;
            const rawMax = layer.durationMax || layer.periodMin || layer.duration || 0;
            const ABSOLUTE_FLOOR = 5;
            let dMin = rawMin > 0 ? Math.max(ABSOLUTE_FLOOR, rawMin) : typeFloor;
            let dMax = Math.max(dMin, rawMax > 0 ? Math.max(ABSOLUTE_FLOOR, rawMax) : typeCeiling);

            // Special override: configured duration locks dMin=dMax
            if (t === 'special') {
                let specDur = null;
                if (layer) {
                    const specName = layer._assignedSpecial || layer._resolvedSpecial || layer.event || layer.name;
                    if (specName) specDur = getSpecialDuration(specName, activityProperties, globalSettings);
                }
                if (!specDur && block && block._specialDuration) specDur = block._specialDuration;
                if (!specDur && block) {
                    const eName = block.event || block._assignedSpecial || block._draftActivity || block.name;
                    if (eName) specDur = getSpecialDuration(eName, activityProperties, globalSettings);
                }
                if (specDur && specDur > 0) { dMin = specDur; dMax = specDur; }
            }

            return { dMin, dMax, dIdeal: snapTo5(Math.round((dMin + dMax) / 2)) };
        }


        // =====================================================================
        // RT — RESOURCE TRACKER (Unified: Specials, Swim Pool, Fields)
        // ★ Single source of truth for all shared-resource capacity.
        // Uses 5-min time buckets. Tracks count + grades per bucket.
        // =====================================================================

        const _resourceBuckets = {};   // { "special:painting": { [minute]: { count, grades: Set } }, ... }

        function _rtKey(type, name) {
            return (type + ':' + (name || '')).toLowerCase();
        }

        function _rtGetBucket(key, minute) {
            if (!_resourceBuckets[key]) _resourceBuckets[key] = {};
            if (!_resourceBuckets[key][minute])
                _resourceBuckets[key][minute] = { count: 0, grades: new Set() };
            return _resourceBuckets[key][minute];
        }

        function rtRegister(type, name, grade, startMin, endMin) {
            const key = _rtKey(type, name);
            for (let m = startMin; m < endMin; m += 5) {
                const b = _rtGetBucket(key, m);
                b.count++;
                if (grade) b.grades.add(grade);
            }
        }

        function rtCanUse(type, name, grade, startMin, endMin, shareType, capacity, allowedDivisions) {
            const key = _rtKey(type, name);
            const buckets = _resourceBuckets[key];
            if (!buckets) return true;

            for (let m = startMin; m < endMin; m += 5) {
                const b = buckets[m];
                if (!b) continue;

                // Capacity check — universal
                if (b.count >= capacity) return false;

                // Cross-division enforcement
                if (b.grades.size > 0 && !b.grades.has(grade)) {
                    if (shareType === 'not_sharable') return false;
                    if (shareType === 'same_division') return false;
                    if (shareType === 'custom') {
                        const existing = [...b.grades];
                        const allOk = existing.every(g => allowedDivisions.includes(g)) && allowedDivisions.includes(grade);
                        if (!allOk) return false;
                    }
                   // shareType === 'all' → no cross-div restriction, only capacity
                }
            }

            // ★ EXACT TIME MATCH: If same-grade bunks are already using this resource,
            // the new bunk must start and end at exactly the same time.
            // No mid-session joins or early departures.
            if (capacity > 1) {
                for (let m = startMin; m < endMin; m += 5) {
                    const b = buckets[m];
                    if (!b || !b.grades.has(grade)) continue;
                    // Found same-grade usage overlapping our window — check boundaries match
                    const beforeBucket = buckets[startMin - 5];
                    if (beforeBucket && beforeBucket.grades.has(grade) && beforeBucket.count > 0) return false;
                    const afterBucket = buckets[endMin];
                    if (afterBucket && afterBucket.grades.has(grade) && afterBucket.count > 0) return false;
                    const endCheckBucket = buckets[endMin - 5];
                    if (!endCheckBucket || !endCheckBucket.grades.has(grade)) return false;
                    break;
                }
            }

            return true;
        }

        function rtReset() {
            Object.keys(_resourceBuckets).forEach(k => delete _resourceBuckets[k]);
        }

        // ── Convenience wrappers ─────────────────────────────────────

        function registerSpecialUsage(specialName, grade, startMin, endMin) {
            rtRegister('special', specialName, grade, startMin, endMin);
        }

        function canUseSpecialAtTime(specialName, grade, startMin, endMin) {
            const info = getSpecialSharingInfo(specialName, activityProperties, globalSettings);
            return rtCanUse('special', specialName, grade, startMin, endMin,
                info.shareType, info.capacity, info.allowedDivisions);
        }

        function registerPoolUsage(grade, startMin, endMin) {
            rtRegister('pool', '_pool', grade, startMin, endMin);
        }

        function canUsePoolAtTime(grade, startMin, endMin) {
            // Pool is exclusive PER GRADE — unlimited bunks within same grade,
            // but zero bunks from any other grade at the same time.
            // We DON'T use rtCanUse here because its capacity check (count >= cap)
            // would block the 2nd bunk of the same grade. Instead we only check
            // whether a DIFFERENT grade has registered in any overlapping bucket.
            const key = _rtKey('pool', '_pool');
            const buckets = _resourceBuckets[key];
            if (!buckets) return true;
            for (let m = startMin; m < endMin; m += 5) {
                const b = buckets[m];
                if (!b) continue;
                // Same grade already registered → fine, any number of bunks OK
                if (b.grades.has(grade)) continue;
                // A DIFFERENT grade is on the pool → blocked
                if (b.grades.size > 0) return false;
            }
            return true;
        }

        // Cross-grade tracker for stagger scoring
        function registerCrossGrade(grade, type, startMin, endMin, eventName) {
            rtRegister('xgrade', type, grade, startMin, endMin);
            if (type === 'special' && eventName) {
                rtRegister('xgrade', 'special:' + eventName, grade, startMin, endMin);
            }
        }

        function getCrossGradeConflicts(type, startMin, endMin, excludeGrade, eventName) {
            const key = (type === 'special' && eventName)
                ? _rtKey('xgrade', 'special:' + eventName)
                : _rtKey('xgrade', type);
            const buckets = _resourceBuckets[key];
            if (!buckets) return 0;
            let conflicts = 0;
            for (let m = startMin; m < endMin; m += 5) {
                const b = buckets[m];
                if (!b) continue;
                conflicts += [...b.grades].filter(g => g !== excludeGrade).length;
            }
            return conflicts;
        }


        // =====================================================================
        // MRC — MULTI-BUNK RESOURCE COORDINATION (Swim staggering)
        // =====================================================================
        const resourceCalendar = { swim: {} };

        function buildResourceCalendar(seed) {
            resourceCalendar.swim = {};
            const swimGrades = [];
            allGrades.forEach(grade => {
                const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
                if (!swimLayer) return;
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
                const bandDur = Math.max(
                    Math.min(...swimGrades.map(g => g.dMax)),
                    snapTo5(Math.floor((poolEnd - poolStart) / swimGrades.length))
                );
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


        // =====================================================================
        // CIL — CROSS-ITERATION LEARNING
        // =====================================================================
        const iterationMemory = { bestPerGrade: {} };

        function extractFragments(timelines) {
            allGrades.forEach(grade => {
                const bunks = getBunksForGrade(grade, divisions);
                let gradeScore = 0;
                const typeTimings = {};
                bunks.forEach(bunk => {
                    const tl = timelines[bunk] || [];
                    const sorted = [...tl].sort((a, b) => a.startMin - b.startMin);
                    const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    if (sorted.length > 0 && sorted[0].startMin > gs) gradeScore += (sorted[0].startMin - gs) * 15;
                    for (let i = 0; i < sorted.length - 1; i++) {
                        const gap = sorted[i + 1].startMin - sorted[i].endMin;
                        if (gap > 0) gradeScore += gap * 15;
                    }
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
                if (!prev || gradeScore < prev.score)
                    iterationMemory.bestPerGrade[grade] = { score: gradeScore, types: typeTimings, iteration: totalIters };
            });
        }

        function getLearnedPreference(grade, type, startMin, endMin) {
            const best = iterationMemory.bestPerGrade[grade];
            if (!best || !best.types[type]) return 0;
            let bestOverlap = 0;
            for (const frag of best.types[type]) {
                const o = Math.max(0, Math.min(frag.end, endMin) - Math.max(frag.start, startMin));
                const dur = endMin - startMin;
                bestOverlap = Math.max(bestOverlap, dur > 0 ? o / dur : 0);
            }
            return -Math.round(bestOverlap * 50);
        }


        // =====================================================================
        // FIELD LEDGER — Tracks field availability in real time.
        // ★ v4.0: Persists across grades during packing (NOT cleared).
        // =====================================================================

        const fieldLedger = {};

        function initFieldLedger() {
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
                if (timeRules.length === 0) {
                    const campStart = Math.min(...Object.values(divisions).map(d => parseTimeToMinutes(d.startTime) || 540));
                    const campEnd = Math.max(...Object.values(divisions).map(d => parseTimeToMinutes(d.endTime) || 990));
                    timeRules.push({ startMin: campStart, endMin: campEnd, divisions: null });
                }
                const sharing = props.sharableWith || {};
                const shareType = sharing.type || 'not_sharable';  // ★ v4.1: Default to NOT sharable
                const capacity = parseInt(sharing.capacity) || (shareType === 'not_sharable' ? 1 : (shareType === 'all' ? 999 : 2));

               fieldLedger[field.name] = {
                    name: field.name, capacity, shareType,
                    allowedDivisions: props.sharableWith?.divisions || [],
                    isIndoor: field.isIndoor || false,
                    timeRules, activities: field.activities || [],
                    claims: []
                };
            });

            // Add special activity locations
            todaysSpecials.forEach(special => {
                const location = getLocationForSpecial(special.name, activityProperties, globalSettings);
                if (location && !fieldLedger[location]) {
                    const cap = getSpecialCapacity(special.name, activityProperties, globalSettings);
                    const cfg = getSpecialConfig(special.name, globalSettings);
                    fieldLedger[location] = {
                        name: location, capacity: cap,
                        shareType: cfg?.sharableWith?.type || 'not_sharable',
                        isIndoor: true,
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
            if (ledger.shareType === 'custom') {
                const allowedDivs = ledger.allowedDivisions || [];
                if (allowedDivs.length > 0) {
                    if (overlapping.some(c => c.grade !== grade && !allowedDivs.includes(c.grade))) return false;
                    if (overlapping.length > 0 && !allowedDivs.includes(grade)) return false;
                } else {
                    if (overlapping.some(c => c.grade !== grade)) return false;
                }
            }

            // ★ EXACT TIME MATCH: Bunks sharing a field must start and end together.
            // No mid-game joins or early departures. If any same-grade claim exists
            // on this field with overlapping time, it must have identical start/end.
            if (overlapping.length > 0 && ledger.capacity > 1) {
                const sameGradeOverlaps = overlapping.filter(c => c.grade === grade);
                if (sameGradeOverlaps.length > 0) {
                    if (sameGradeOverlaps.some(c => c.startMin !== startMin || c.endMin !== endMin)) {
                        return false;
                    }
                }
            }

            return true;
        }

        function claimField(fieldName, startMin, endMin, bunk, grade, activity) {
            if (!isFieldAvailable(fieldName, startMin, endMin, bunk, grade)) return false;
            fieldLedger[fieldName].claims.push({ bunk, grade, activity, startMin, endMin });
            return true;
        }

        function unclaimFieldsForBunk(bunk) {
            Object.values(fieldLedger).forEach(ledger => {
                ledger.claims = ledger.claims.filter(c => c.bunk !== bunk);
            });
        }


        // =====================================================================
        // CONTENTION SCORING
        // =====================================================================

        function getFieldImpact(block) {
            const t = (block.type || '').toLowerCase();
            if (['sport', 'sports', 'slot', 'league', 'specialty_league'].includes(t)) return 'consumer';
            if (t === 'swim') return 'reliever';
            if (t === 'special') return isSpecialOnField(block, activityProperties, globalSettings) ? 'consumer' : 'reliever';
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
                            if (block.startMin < sliceEnd && block.endMin > t) {
                                hasBlock = true;
                                if (getFieldImpact(block) === 'consumer') isCons = true;
                                break;
                            }
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
            else if (t === 'special') impact = (specialName && isSpecialOnField(specialName, activityProperties, globalSettings)) ? 'consumer' : 'reliever';

            if (impact === 'neutral') return 0;
            const demand = getFieldDemand(startMin, endMin, excludeBunk);
            let score = impact === 'reliever' ? -demand : demand;

            if (totalIters >= 2 && excludeBunk) {
                const bunkGrade = Object.entries(divisions).find(([g, d]) => (d.bunks || []).map(String).includes(String(excludeBunk)))?.[0];
                if (bunkGrade) score += getLearnedPreference(bunkGrade, blockType, startMin, endMin);
            }
            return score;
        }


        // =====================================================================
        // GAP / PLACEMENT HELPERS
        // =====================================================================

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

        const _minFillableByGrade = {};
        function getMinFillable(grade) {
            if (_minFillableByGrade[grade]) return _minFillableByGrade[grade];
            const gradeLayers = layersByGrade[grade] || [];
            let minD = Infinity;
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

        function findBestGapPosition(bunk, windowStart, windowEnd, duration, blockType, specialName, grade) {
            const gaps = getFreeGaps(bunk, windowStart, windowEnd);
            const minFill = grade ? getMinFillable(grade) : GAP_MIN_DUR;
            const ABSORB = 10;
            let bestPos = null, bestScore = Infinity;
            for (const gap of gaps) {
                if (gap.end - gap.start < duration) continue;
                for (let cs = gap.start; cs <= gap.end - duration; cs += 5) {
                    const before = cs - gap.start, after = gap.end - (cs + duration);
                    if (before > ABSORB && before < minFill) continue;
                    if (after > ABSORB && after < minFill) continue;
                    const score = scorePositionByContention(cs, cs + duration, blockType, bunk, specialName);
                    if (score < bestScore) { bestScore = score; bestPos = { start: cs, end: cs + duration, gapStart: gap.start, gapEnd: gap.end }; }
                }
            }
            // Snap to gap edges
            if (bestPos) {
                const beforeRes = bestPos.start - bestPos.gapStart;
                const afterRes = bestPos.gapEnd - bestPos.end;
                if (beforeRes > 0 && beforeRes < minFill) bestPos.start = bestPos.gapStart;
                if (afterRes > 0 && afterRes < minFill) bestPos.end = bestPos.gapEnd;
            }
            return bestPos;
        }

        function placeTentativeBlock(bunk, block) {
            bunkTimelines[bunk].push(block);
            bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
        }


        // =====================================================================
        // PERFECT-FIT DISTRIBUTION
        // =====================================================================

        function perfectFitDistribute(blockDescs, target) {
            const n = blockDescs.length;
            if (n === 0) return [];
            if (n === 1) return [Math.max(blockDescs[0].dMin, Math.min(blockDescs[0].dMax, target))];
            const durations = blockDescs.map(b => b.dMin);
            let excess = target - durations.reduce((s, d) => s + d, 0);
            if (excess <= 0) return durations;
            // Maximize each block to dMax before creating additional
            for (let i = 0; i < n && excess > 0; i++) {
                const maxGrow = blockDescs[i].dMax - durations[i];
                if (maxGrow <= 0) continue;
                const give = Math.min(maxGrow, excess);
                durations[i] += give;
                excess -= give;
            }
            if (excess > 0) { for (let i = 0; i < n && excess > 0; i++) { durations[i]++; excess--; } }
            // Snap to 5
            let total = 0;
            for (let i = 0; i < n - 1; i++) {
                durations[i] = snapTo5(durations[i]);
                durations[i] = Math.max(blockDescs[i].dMin, Math.min(blockDescs[i].dMax, durations[i]));
                total += durations[i];
            }
            durations[n - 1] = Math.max(blockDescs[n - 1].dMin, Math.min(blockDescs[n - 1].dMax, target - total));
            return durations;
        }


        // =====================================================================
        // PHASE 0: PLACE PINNED LAYERS
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
                const isCustom = t === 'custom';
                const targetBunks = (isCustom && layer.customBunks && layer.customBunks.length > 0)
                    ? allBunks.filter(b => layer.customBunks.includes(String(b)))
                    : allBunks;
                const eventName = (isCustom && layer.customActivity) ? layer.customActivity : (layer.event || layer.name || layer.type || 'Pinned');

                // ★ v4.0: Cross-division check for pinned specials
                if (t === 'special' && !canUseSpecialAtTime(eventName, grade, layer.startMin, layer.endMin)) return;

                // ★ v4.0: Pool exclusivity for pinned swim
                if (t === 'swim' && !canUsePoolAtTime(grade, layer.startMin, layer.endMin)) return;

                targetBunks.forEach(bunk => {
                    bunkTimelines[bunk].push({
                        startMin: layer.startMin, endMin: layer.endMin,
                        type: isCustom ? 'custom' : (layer.type || 'pinned'),
                        event: eventName, layer,
                        _classification: 'pinned', _committed: true, _fixed: true,
                        _gradeWide: isGradeWide && !isCustom, _activityLocked: true,
                        _noBacktrack: isGradeWide,
                        _customActivity: isCustom ? layer.customActivity : null,
                        _customField: isCustom ? layer.customField : null,
                        _customBunks: isCustom ? layer.customBunks : null
                    });
                    count++;
                });

                if (t === 'special') registerSpecialUsage(eventName, grade, layer.startMin, layer.endMin);
                if (t === 'swim') registerPoolUsage(grade, layer.startMin, layer.endMin);
                if (isCustom && layer.customField) registerCrossGrade(grade, 'custom', layer.startMin, layer.endMin, layer.customActivity);
            });
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk =>
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin)));
            return count;
        }

        // ── League placement ──────────────────────────────────────────
        function placeLeagueForGrade(grade, layer) {
            const bunks = getBunksForGrade(grade, divisions);
            const { dMin, dMax } = resolveConstraints(layer, 'league');
            const leagueName = (() => {
                const league = (Array.isArray(window.masterLeagues) ? window.masterLeagues : Object.values(window.masterLeagues || {}))
                    .find(l => (l.divisions || []).includes(grade));
                return league ? league.name : null;
            })();

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
                return snapTo5(d) < dMin ? dMin : snapTo5(d);
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

            const gradeStagger = staggerPlan[grade] || { offset: 0, searchDirection: 'early' };
            const leagueBand = gradeStagger.typeBands?.league || null;
            const times = [];
            for (let ts = layer.startMin; ts + dMin <= layer.endMin; ts += 5) times.push(ts);
            if (gradeStagger.searchDirection === 'late') times.reverse();

            let bestStart = null, bestScore = Infinity;
            for (const ts of times) {
                const te = ts + dMin;
                if (!bunks.every(bk => !(bunkTimelines[bk] || []).some(b => b.startMin < te && b.endMin > ts))) continue;
               let score = scorePositionByContention(ts, te, 'league', null, null);
                score += getCrossGradeConflicts('league', ts, te, grade) * 10000;
                // Iteration jitter: vary league placement across iterations
                score += (seedJitter(_iterSeed, ts) - 0.5) * 2000;
                // ★ v4.0: Prefer the rotation matrix's league band (strong suggestion)
                if (leagueBand && ts >= leagueBand.start && te <= leagueBand.end) score -= 500;
                else if (leagueBand) score += 200;
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
            return bestStart;
        }


        // =====================================================================
        // PHASE 1: BUILD SHOPPING LISTS
        // =====================================================================

        function buildBunkShoppingList(bunk, grade) {
            const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
            const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
            const bunkSize = (window.getBunkMetaData?.() || window.bunkMetaData || {})[bunk]?.size || 20;

            const timeline = (bunkTimelines[bunk] || []).sort((a, b) => a.startMin - b.startMin);
            const freeWindows = [];
            let cursor = gradeStart;
            timeline.forEach(b => {
                if (b.startMin > cursor) freeWindows.push({ start: cursor, end: b.startMin, duration: b.startMin - cursor });
                cursor = Math.max(cursor, b.endMin);
            });
            if (cursor < gradeEnd) freeWindows.push({ start: cursor, end: gradeEnd, duration: gradeEnd - cursor });

            const placedTypes = {};
            timeline.forEach(b => { const t = (b.type || '').toLowerCase(); placedTypes[t] = (placedTypes[t] || 0) + 1; });

            const remainingNeeds = [];
            nonPinnedLayers.forEach(layer => {
                if ((layer.grade || layer.division) !== grade) return;
                const t = (layer.type || '').toLowerCase();
                const required = layer.qty || layer.quantity || 1;
                const op = layer.op || layer.operator || '>=';
                if (t === 'league' || t === 'specialty_league') {
                    if (timeline.some(b => (b.type || '').toLowerCase() === t)) return;
                }
                const alreadyPlaced = placedTypes[t] || 0;
                const stillNeeded = Math.max(0, required - alreadyPlaced);
                if (stillNeeded <= 0 && op !== '<=' && op !== '≤') return;
                if (op === '<=' || op === '≤') return;
                remainingNeeds.push({ layer, type: t, count: stillNeeded, op });
            });

            // Sport priority list
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
            // Iteration variation: partially shuffle sport order
            if (_iterSeed > 0) {
                const top = Math.min(5, sportPriorityList.length);
                const topSlice = seedShuffle(sportPriorityList.slice(0, top), _iterSeed + parseInt(String(bunk).replace(/\D/g,'')) || 0);
                for (let si = 0; si < top; si++) sportPriorityList[si] = topSlice[si];
            }

            // Special priority list
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

                const specificDuration = getSpecialDuration(s.name, activityProperties, globalSettings);
                const cfg = getSpecialConfig(s.name, globalSettings);
                const location = getLocationForSpecial(s.name, activityProperties, globalSettings);
                const scarce = isScarce(s.name, dayName, globalSettings);
                const timeWindow = getSpecialTimeWindow(cfg);
                const prepDuration = cfg?.prepDuration || 0;

                specialPriorityList.push({
                    name: s.name, type: 'special', rotationScore: score,
                    duration: specificDuration,
                    dMin: specificDuration || specialConstraints.dMin,
                    dMax: specificDuration || specialConstraints.dMax,
                    dIdeal: specificDuration || specialConstraints.dIdeal,
                    isFlexDuration: !specificDuration,
                    capacity: getSpecialCapacity(s.name, activityProperties, globalSettings),
                    location, isScarce: scarce,
                    isIndoor: !isSpecialOnField(s.name, activityProperties, globalSettings),
                    prepDuration,
                    totalDuration: (specificDuration || specialConstraints.dIdeal) + prepDuration,
                    timeWindow, _linkedPair: prepDuration > 0,
                    _layer: specialLayer
                });
            });
           specialPriorityList.sort((a, b) => { if (a.isScarce !== b.isScarce) return a.isScarce ? -1 : 1; return a.rotationScore - b.rotationScore; });
            // Iteration variation: shuffle non-scarce specials
            if (_iterSeed > 0) {
                const scarceEnd = specialPriorityList.findIndex(s => !s.isScarce);
                const nonScarce = scarceEnd >= 0 ? specialPriorityList.splice(scarceEnd) : [];
                if (nonScarce.length > 1) {
                    const shuffled = seedShuffle(nonScarce, _iterSeed + parseInt(String(bunk).replace(/\D/g,'')) || 0);
                    specialPriorityList.push(...shuffled);
                }
            }

            // Snack / elective / other needs
            const otherNeeds = remainingNeeds.filter(n => n.type !== 'sport' && n.type !== 'sports' && n.type !== 'special' && n.type !== 'league' && n.type !== 'specialty_league');
            const snackNeed = otherNeeds.find(n => n.type === 'snack' || n.type === 'snacks');
            let snackOptions = null;
            if (snackNeed) {
                const sc = resolveConstraints(snackNeed.layer, snackNeed.type);
                snackOptions = [];
                for (let t = snackNeed.layer.startMin; t + sc.dMin <= snackNeed.layer.endMin; t += 10)
                    snackOptions.push({ startMin: t, endMin: t + sc.dMin, duration: sc.dMin, type: snackNeed.type, event: snackNeed.layer.event || 'Snacks', layer: snackNeed.layer });
            }
            const electiveNeed = otherNeeds.find(n => n.type === 'elective');
            let electiveInfo = null;
            if (electiveNeed) {
                const ec = resolveConstraints(electiveNeed.layer, 'elective');
                electiveInfo = { type: 'elective', dMin: ec.dMin, dMax: ec.dMax, dIdeal: ec.dIdeal, count: electiveNeed.count, window: { start: electiveNeed.layer.startMin, end: electiveNeed.layer.endMin }, layer: electiveNeed.layer };
            }
            const genericNeeds = otherNeeds.filter(n => n.type !== 'snack' && n.type !== 'snacks' && n.type !== 'elective');

            // Adjacent bunk for pairing
            const allBunks = getBunksForGrade(grade, divisions);
            const myNum = parseInt(String(bunk).replace(/\D/g, '')) || 0;
            let adjacentBunk = null, closestDist = Infinity;
            allBunks.forEach(other => {
                if (other === bunk) return;
                const d = Math.abs((parseInt(String(other).replace(/\D/g, '')) || 0) - myNum);
                if (d < closestDist) { closestDist = d; adjacentBunk = other; }
            });

            return {
                bunk, grade, bunkSize, freeWindows, totalFree: freeWindows.reduce((s, w) => s + w.duration, 0),
                sports: { required: sportCount, priorityList: sportPriorityList, layer: sportLayer, constraints: sportConstraints },
                specials: { required: specialCount, priorityList: specialPriorityList, layer: specialLayer, constraints: specialConstraints },
                snack: snackOptions, elective: electiveInfo, genericNeeds, adjacentBunk
            };
        }


        // =====================================================================
        // PHASE 2: DRAFT-STYLE ASSIGNMENT
        // =====================================================================

        function runDraft(shoppingLists) {
            // ★ v4.0: DO NOT re-init field ledger — keep claims from Phase 0
            const draftResults = {};
            const allBunkList = Object.values(shoppingLists);
            allBunkList.sort((a, b) => {
                const ac = a.sports.required + a.specials.required * 2 + (a.bunkSize < 12 ? 3 : 0) - a.sports.priorityList.length * 0.1;
                const bc = b.sports.required + b.specials.required * 2 + (b.bunkSize < 12 ? 3 : 0) - b.sports.priorityList.length * 0.1;
                return bc - ac;
            });

            allBunkList.forEach(list => {
                draftResults[list.bunk] = { sports: [], specials: [], elective: [], generic: [], usedActivities: new Set(), grade: list.grade };
            });

   
  
            function findTimeForField(fieldName, bunk, grade, duration, freeWindows) {
                for (const win of freeWindows) {
                    if (win.duration < duration) continue;
                    for (let t = win.start; t + duration <= win.end; t += 5) {
                        if (isFieldAvailable(fieldName, t, t + duration, bunk, grade)) return { startMin: t, endMin: t + duration };
                    }
                }
                return null;
            }

            function findAnyWindow(freeWindows, duration) {
                for (const win of freeWindows) { if (win.duration >= duration) return { startMin: win.start, endMin: win.start + duration }; }
                return null;
            }

            function getUpdatedFreeWindows(bunk) {
                const result = draftResults[bunk];
                const claimed = [...result.sports, ...result.specials, ...result.elective, ...result.generic]
                    .map(c => c.claimedTime).filter(Boolean).sort((a, b) => a.startMin - b.startMin);
                const original = shoppingLists[bunk]?.freeWindows || [];
                const updated = [];
                for (const win of original) {
                    let cur = win.start;
                    const ol = claimed.filter(c => c.startMin < win.end && c.endMin > win.start).sort((a, b) => a.startMin - b.startMin);
                    for (const cl of ol) { if (cl.startMin > cur) updated.push({ start: cur, end: cl.startMin, duration: cl.startMin - cur }); cur = Math.max(cur, cl.endMin); }
                    if (cur < win.end) updated.push({ start: cur, end: win.end, duration: win.end - cur });
                }
                return updated.filter(w => w.duration > 0);
            }

            // ★ v4.1: Track which specials are assigned to which grades during draft
            // Prevents assigning the same special to incompatible grades
            const draftSpecialGrades = {}; // { specialName: Set of grades }

            function canDraftSpecialForGrade(specialName, grade) {
                const existing = draftSpecialGrades[specialName];
                if (!existing || existing.size === 0) return true;
                if (existing.has(grade)) return true; // same grade = OK
                // Check sharing rules
                const info = getSpecialSharingInfo(specialName, activityProperties, globalSettings);
                if (info.shareType === 'not_sharable') return false;
                // ★ FIX: same_division means "only same-grade bunks can share AT THE SAME TIME"
                // It does NOT mean the special is exclusive to one grade all day.
                // Different grades use specials at different times (staggered by the packer).
                // The RT (Resource Tracker) enforces same-division at placement time.
                if (info.shareType === 'same_division') return true;
                if (info.shareType === 'custom') {
                    const allowed = info.allowedDivisions || [];
                    const existingGrades = [...existing];
                    return existingGrades.every(g => allowed.includes(g)) && allowed.includes(grade);
                }
                // 'all' sharing or unknown → allow
                return true;
            }

            function registerDraftSpecial(specialName, grade) {
                if (!draftSpecialGrades[specialName]) draftSpecialGrades[specialName] = new Set();
                draftSpecialGrades[specialName].add(grade);
            }

            // Round 1: Scarce specials
            for (const list of allBunkList) {
                const bunk = list.bunk, grade = list.grade, result = draftResults[bunk];
                if (list.specials.required <= 0) continue;
                for (const special of list.specials.priorityList) {
                    if (result.specials.length >= list.specials.required) break;
                    if (!special.isScarce || result.usedActivities.has(special.name)) continue;
                    // ★ v4.1: Cross-division check
                    if (!canDraftSpecialForGrade(special.name, grade)) continue;
                    const fw = getUpdatedFreeWindows(bunk);
                    const dur = special.totalDuration;
                    const time = special.location ? findTimeForField(special.location, bunk, grade, dur, fw) : findAnyWindow(fw, dur);
                    if (!time) continue;
                    if (special.location) claimField(special.location, time.startMin, time.endMin, bunk, grade, special.name);
                    result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                    result.usedActivities.add(special.name);
                    registerDraftSpecial(special.name, grade);
                }
            }

            // Round 2: Regular specials
            for (const list of allBunkList) {
                const bunk = list.bunk, grade = list.grade, result = draftResults[bunk];
                if (result.specials.length >= list.specials.required) continue;
                for (const special of list.specials.priorityList) {
                    if (result.specials.length >= list.specials.required) break;
                    if (result.usedActivities.has(special.name) || special.isScarce) continue;
                    // ★ v4.1: Cross-division check
                    if (!canDraftSpecialForGrade(special.name, grade)) continue;
                    const fw = getUpdatedFreeWindows(bunk);
                    const time = special.location ? findTimeForField(special.location, bunk, grade, special.totalDuration, fw) : findAnyWindow(fw, special.totalDuration);
                    if (!time) continue;
                    if (special.location) claimField(special.location, time.startMin, time.endMin, bunk, grade, special.name);
                    result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                    result.usedActivities.add(special.name);
                    registerDraftSpecial(special.name, grade);
                }
            }

            // Round 3: Sports
            for (const list of allBunkList) {
                const bunk = list.bunk, grade = list.grade, result = draftResults[bunk];
                if (list.sports.required <= 0) continue;
                for (const sport of list.sports.priorityList) {
                    if (result.sports.length >= list.sports.required) break;
                    if (result.usedActivities.has(sport.name)) continue;
                    if (sport.needsPairing && list.adjacentBunk) continue; // defer pairing
                    const fw = getUpdatedFreeWindows(bunk);
                    let claimed = false;
                    for (const field of sport.fields) {
                        const time = findTimeForField(field, bunk, grade, sport.dIdeal, fw);
                        if (time) {
                            claimField(field, time.startMin, time.endMin, bunk, grade, sport.name);
                            result.sports.push({ ...sport, claimedTime: time, claimedField: field });
                            result.usedActivities.add(sport.name);
                            claimed = true;
                            break;
                        }
                    }
                }
            }

            // Round 4: Electives + generic
            for (const list of allBunkList) {
                if (!list.elective) continue;
                const bunk = list.bunk, result = draftResults[bunk];
                const fw = getUpdatedFreeWindows(bunk);
                for (let i = 0; i < list.elective.count; i++) {
                    const time = findAnyWindow(fw, list.elective.dIdeal);
                    if (time) result.elective.push({ type: 'elective', duration: list.elective.dIdeal, claimedTime: time, layer: list.elective.layer });
                }
            }

            return draftResults;
        }
// =====================================================================
        // PHASE 2B: GLOBAL PLANNER (replaces old runDraft call)
        // =====================================================================
        function runGlobalPlanner(shoppingLists) {
            const GP = '[GlobalPlanner]';
            log(GP + ' Starting...');

            const draftResults = {};
            const allBunkList = Object.values(shoppingLists);

            allBunkList.forEach(list => {
                draftResults[list.bunk] = {
                    sports: [], specials: [], elective: [], generic: [],
                    usedActivities: new Set(), grade: list.grade
                };
            });

            const globalSpecialUsage = {};

            function canAssignSpecialToGrade(specialName, grade, startMin, endMin) {
                const info = getSpecialSharingInfo(specialName, activityProperties, globalSettings);
                const existing = globalSpecialUsage[specialName] || [];
                for (const e of existing) {
                    if (e.endMin <= startMin || e.startMin >= endMin) continue;
                    if (e.grade === grade) {
                        const sameGradeCount = existing.filter(x =>
                            x.grade === grade && x.startMin < endMin && x.endMin > startMin
                        ).length;
                        if (sameGradeCount >= info.capacity) return false;
                    } else {
                        if (info.shareType === 'not_sharable') return false;
                        if (info.shareType === 'same_division') return false;
                        if (info.shareType === 'custom') {
                            const allowed = info.allowedDivisions || [];
                            if (allowed.length > 0 && !allowed.includes(grade)) return false;
                            if (allowed.length > 0 && !allowed.includes(e.grade)) return false;
                            if (allowed.length === 0) return false;
                        }
                        const totalCount = existing.filter(x =>
                            x.startMin < endMin && x.endMin > startMin
                        ).length;
                        if (totalCount >= info.capacity) return false;
                    }
                }
                return true;
            }

            function registerSpecialAssignment(specialName, grade, startMin, endMin) {
                if (!globalSpecialUsage[specialName]) globalSpecialUsage[specialName] = [];
                globalSpecialUsage[specialName].push({ grade, startMin, endMin });
            }

            // Shared planner state (reset per grade in the forEach below)
            let _gpCurrentGrade = '';
            const plannerFieldClaims = [];

            function isFieldStillAvailable(fieldName, startMin, endMin, bunk) {
                if (!isFieldAvailable(fieldName, startMin, endMin, bunk, _gpCurrentGrade)) return false;
                const ledger = fieldLedger[fieldName];
                if (!ledger) return false;
                const plannerOverlap = plannerFieldClaims.filter(c =>
                    c.field === fieldName && c.startMin < endMin && c.endMin > startMin && c.bunk !== bunk
                );
                const ledgerOverlap = ledger.claims.filter(c =>
                    c.startMin < endMin && c.endMin > startMin && c.bunk !== bunk
                );
                const totalOverlap = ledgerOverlap.length + plannerOverlap.length;
                return totalOverlap < ledger.capacity;
            }

            function claimFieldForPlanner(fieldName, startMin, endMin, bunk, activity) {
                claimField(fieldName, startMin, endMin, bunk, _gpCurrentGrade, activity);
                plannerFieldClaims.push({ field: fieldName, startMin, endMin, bunk, grade: _gpCurrentGrade, activity });
            }

            // ─── Process each grade ──────────────────────────────────
            allGrades.forEach(grade => {
                _gpCurrentGrade = grade;
                plannerFieldClaims.length = 0; // reset per grade

                const bunks = getBunksForGrade(grade, divisions).map(String);
                if (bunks.length <= 1) {
                    bunks.forEach(bunk => {
                        const sl = shoppingLists[bunk];
                        if (!sl) return;
                        simpleDraftForBunk(bunk, grade, sl, draftResults[bunk]);
                    });
                    return;
                }

                const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;

                // ── Step A: Build per-bunk gap map ───────────────────
                const bunkGaps = {};
                const sportMinDur = {};

                bunks.forEach(bunk => {
                    const sl = shoppingLists[bunk];
                    if (!sl) { bunkGaps[bunk] = []; return; }
                    bunkGaps[bunk] = (sl.freeWindows || []).map(w => ({
                        start: w.start, end: w.end, duration: w.duration
                    }));
                    sportMinDur[bunk] = sl.sports?.constraints?.dMin || 25;
                });

                // ── Step B: Build demand windows ─────────────────────
                const boundaries = new Set();
                boundaries.add(gradeStart);
                boundaries.add(gradeEnd);
                bunks.forEach(bunk => {
                    (bunkGaps[bunk] || []).forEach(g => {
                        boundaries.add(g.start);
                        boundaries.add(g.end);
                    });
                });
                const sortedBounds = [...boundaries].sort((a, b) => a - b);

                const demandWindows = [];
                for (let i = 0; i < sortedBounds.length - 1; i++) {
                    const wStart = sortedBounds[i];
                    const wEnd = sortedBounds[i + 1];
                    if (wEnd - wStart < 5) continue;

                    const demandBunks = bunks.filter(bunk =>
                        (bunkGaps[bunk] || []).some(g => g.start <= wStart && g.end >= wEnd)
                    );

                    if (demandBunks.length >= 2) {
                        demandWindows.push({
                            start: wStart, end: wEnd, duration: wEnd - wStart,
                            bunks: demandBunks
                        });
                    }
                }

                // Merge adjacent windows with same bunk set
                const mergedWindows = [];
                for (const win of demandWindows) {
                    const prev = mergedWindows[mergedWindows.length - 1];
                    if (prev && prev.end === win.start &&
                        prev.bunks.length === win.bunks.length &&
                        prev.bunks.every(b => win.bunks.includes(b))) {
                        prev.end = win.end;
                        prev.duration = prev.end - prev.start;
                    } else {
                        mergedWindows.push({ ...win, bunks: [...win.bunks] });
                    }
                }

                // ── Step C: Compute supply per window ────────────────
                mergedWindows.forEach(win => {
                    let fieldSupply = 0;
                    const availableFields = [];

                    Object.values(fieldLedger).forEach(ledger => {
                        if (isRainy && !ledger.isIndoor) return;
                        if (ledger._isSpecialLocation) return;
                        if (ledger.activities.length === 0) return;

                        const timeOk = ledger.timeRules.some(rule => {
                            if (rule.startMin > win.start || rule.endMin < win.end) return false;
                            if (rule.divisions && !rule.divisions.includes(grade)) return false;
                            return true;
                        });
                        if (!timeOk) return;

                        const overlapping = ledger.claims.filter(c =>
                            c.startMin < win.end && c.endMin > win.start
                        );
                        const crossGrade = overlapping.some(c => c.grade !== grade);

                        let remaining = 0;
                        if (ledger.shareType === 'not_sharable') {
                            remaining = overlapping.length === 0 ? 1 : 0;
                        } else if (ledger.shareType === 'same_division') {
                            if (crossGrade) remaining = 0;
                            else remaining = Math.max(0, ledger.capacity - overlapping.filter(c => c.grade === grade).length);
                        } else if (ledger.shareType === 'custom') {
                            const allowed = ledger.allowedDivisions || [];
                            const blockedCross = overlapping.some(c =>
                                c.grade !== grade && (allowed.length === 0 || !allowed.includes(c.grade))
                            );
                            const notAllowed = overlapping.length > 0 && allowed.length > 0 && !allowed.includes(grade);
                            if (blockedCross || notAllowed) remaining = 0;
                            else remaining = Math.max(0, ledger.capacity - overlapping.length);
                        } else {
                            remaining = Math.max(0, ledger.capacity - overlapping.length);
                        }

                        if (remaining > 0) {
                            fieldSupply += remaining;
                            availableFields.push({
                                name: ledger.name, capacity: ledger.capacity,
                                remaining, activities: ledger.activities,
                                shareType: ledger.shareType
                            });
                        }
                    });

                    win.fieldSupply = fieldSupply;
                    win.availableFields = availableFields;
                    win.demand = win.bunks.length;
                    win.deficit = Math.max(0, win.demand - fieldSupply);
                });

                // ── Step D0: Guarantee required specials per bunk ─────
                // Before allocating sports in windows, assign specials for
                // every bunk that needs them. This ensures specials aren't
                // squeezed out when field supply >= demand (no deficit).
                bunks.forEach(bunk => {
                    const sl = shoppingLists[bunk];
                    if (!sl) return;
                    const result = draftResults[bunk];
                    const needed = (sl.specials?.required || 0) - result.specials.length;
                    if (needed <= 0) return;

                    for (const special of (sl.specials?.priorityList || [])) {
                        if (result.specials.length >= sl.specials.required) break;
                        if (result.usedActivities.has(special.name)) continue;
                        if (!canAssignSpecialToGrade(special.name, grade, gradeStart, gradeEnd)) continue;

                        const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                        const dur = special.totalDuration || special.dMin || 30;
                        const time = special.location
                            ? findTimeForFieldGP(special.location, bunk, grade, dur, fw)
                            : findAnyWindowGP(fw, dur);
                        if (!time) continue;

                        if (special.location) claimFieldForPlanner(special.location, time.startMin, time.endMin, bunk, special.name);
                        registerSpecialAssignment(special.name, grade, time.startMin, time.endMin);
                        result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                        result.usedActivities.add(special.name);
                    }
                });

                // ── Step D: Allocate (tightest first) ────────────────
                const windowsToProcess = mergedWindows
                    .filter(w => w.demand > 0 && w.duration >= 20)
                    .sort((a, b) => {
                        if (b.deficit !== a.deficit) return b.deficit - a.deficit;
                        const ratioA = a.fieldSupply / Math.max(1, a.demand);
                        const ratioB = b.fieldSupply / Math.max(1, b.demand);
                        return ratioA - ratioB;
                    });

               
                const bunkDoneToday = {};
                const bunkAssignedWindows = {};
                bunks.forEach(bunk => {
                    bunkDoneToday[bunk] = new Set();
                    bunkAssignedWindows[bunk] = [];
                });

                for (const win of windowsToProcess) {
                    const unassignedBunks = win.bunks.filter(bunk => {
                        const existing = bunkAssignedWindows[bunk] || [];
                        return !existing.some(a => a.start < win.end && a.end > win.start);
                    });

                    if (unassignedBunks.length === 0) continue;

                    // Recompute field supply
                    let currentFieldSupply = 0;
                    const currentFields = [];
                    win.availableFields.forEach(af => {
                        const ledger = fieldLedger[af.name];
                        if (!ledger) return;
                        const overlap = ledger.claims.filter(c =>
                            c.startMin < win.end && c.endMin > win.start
                        );
                        const crossGrade = overlap.some(c => c.grade !== grade);
                        let remaining = 0;
                        if (ledger.shareType === 'not_sharable') {
                            remaining = overlap.length === 0 ? 1 : 0;
                        } else if (ledger.shareType === 'same_division') {
                            remaining = crossGrade ? 0 : Math.max(0, ledger.capacity - overlap.filter(c => c.grade === grade).length);
                        } else if (ledger.shareType === 'custom') {
                            const allowed = ledger.allowedDivisions || [];
                            const blockedCross = overlap.some(c => c.grade !== grade && (allowed.length === 0 || !allowed.includes(c.grade)));
                            const notAllowed = overlap.length > 0 && allowed.length > 0 && !allowed.includes(grade);
                            remaining = (blockedCross || notAllowed) ? 0 : Math.max(0, ledger.capacity - overlap.length);
                        } else {
                            remaining = Math.max(0, ledger.capacity - overlap.length);
                        }
                        if (remaining > 0) {
                            currentFieldSupply += remaining;
                            currentFields.push({ ...af, remaining });
                        }
                    });

                    const demand = unassignedBunks.length;
                    const deficit = Math.max(0, demand - currentFieldSupply);

                    if (deficit <= 0) {
                        assignSportsToWindow(win, unassignedBunks, currentFields, grade, bunkDoneToday, bunkAssignedWindows);
                    } else {
                        const bunkFlexibility = unassignedBunks.map(bunk => {
                            const sl = shoppingLists[bunk];
                            const otherWindows = (bunkGaps[bunk] || []).filter(g =>
                                g.end <= win.start || g.start >= win.end
                            );
                            const otherSportOpportunities = otherWindows.filter(g =>
                                g.duration >= (sportMinDur[bunk] || 25)
                            ).length;
                            const specialsAvailable = (sl?.specials?.priorityList || []).filter(sp =>
                                !bunkDoneToday[bunk]?.has(sp.name) && sp.totalDuration <= win.duration
                            ).length;
                            return {
                                bunk,
                                flexibility: otherSportOpportunities * 10 + specialsAvailable,
                                specialsAvailable
                            };
                        });

                        bunkFlexibility.sort((a, b) => {
                            const jA = seedJitter(_iterSeed, parseInt(String(a.bunk).replace(/\D/g,'')) || 0) * 5;
                            const jB = seedJitter(_iterSeed, parseInt(String(b.bunk).replace(/\D/g,'')) || 0) * 5;
                            return (b.flexibility + jB) - (a.flexibility + jA);
                        });

                        const specialBunks = bunkFlexibility.slice(0, deficit)
                            .filter(b => b.specialsAvailable > 0)
                            .map(b => b.bunk);
                        const sportBunks = unassignedBunks.filter(b => !specialBunks.includes(b));

                        if (specialBunks.length < deficit) {
                            log(GP + ' ' + grade + ' @ ' + win.start + '-' + win.end +
                                ': deficit=' + deficit + ' but only ' + specialBunks.length +
                                ' bunks have specials available');
                        }

                        assignSpecialsToWindow(win, specialBunks, grade, bunkDoneToday, bunkAssignedWindows);
                        assignSportsToWindow(win, sportBunks, currentFields, grade, bunkDoneToday, bunkAssignedWindows);
                    }
                }

                // ── Handle remaining needs per bunk ──────────────────
                bunks.forEach(bunk => {
                    const sl = shoppingLists[bunk];
                    if (!sl) return;
                    const result = draftResults[bunk];

                    const neededSpecials = Math.max(0, (sl.specials?.required || 0) - result.specials.length);
                    if (neededSpecials > 0) {
                        for (const special of (sl.specials?.priorityList || [])) {
                            if (result.specials.length >= sl.specials.required) break;
                            if (result.usedActivities.has(special.name)) continue;
                            if (!canAssignSpecialToGrade(special.name, grade, gradeStart, gradeEnd)) continue;

                            const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                            const dur = special.totalDuration || special.dMin || 30;
                            const time = special.location
                                ? findTimeForFieldGP(special.location, bunk, grade, dur, fw)
                                : findAnyWindowGP(fw, dur);
                            if (!time) continue;

                            if (special.location) claimFieldForPlanner(special.location, time.startMin, time.endMin, bunk, special.name);
                            registerSpecialAssignment(special.name, grade, time.startMin, time.endMin);
                            result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                            result.usedActivities.add(special.name);
                        }
                    }

                    const neededSports = Math.max(0, (sl.sports?.required || 0) - result.sports.length);
                    if (neededSports > 0) {
                        for (const sport of (sl.sports?.priorityList || [])) {
                            if (result.sports.length >= sl.sports.required) break;
                            if (result.usedActivities.has(sport.name)) continue;
                            const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                            for (const field of (sport.fields || [])) {
                                const time = findTimeForFieldGP(field, bunk, grade, sport.dIdeal, fw);
                                if (time) {
                                    claimFieldForPlanner(field, time.startMin, time.endMin, bunk, sport.name);
                                    result.sports.push({ ...sport, claimedTime: time, claimedField: field });
                                    result.usedActivities.add(sport.name);
                                    break;
                                }
                            }
                        }
                    }

                    if (sl.elective) {
                        const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                        for (let i = 0; i < (sl.elective.count || 0); i++) {
                            const time = findAnyWindowGP(fw, sl.elective.dIdeal);
                            if (time) result.elective.push({
                                type: 'elective', duration: sl.elective.dIdeal,
                                claimedTime: time, layer: sl.elective.layer
                            });
                        }
                    }
                });

                if (windowsToProcess.some(w => w.deficit > 0)) {
                    const deficitWindows = windowsToProcess.filter(w => w.deficit > 0);
                    deficitWindows.forEach(w => {
                        log(GP + ' ' + grade + ' @ ' + w.start + '-' + w.end +
                            ': demand=' + w.demand + ' fieldSupply=' + w.fieldSupply +
                            ' deficit=' + w.deficit);
                    });
                }
            }); // end allGrades.forEach

            // Log summary
            let totalSports = 0, totalSpecials = 0;
            Object.values(draftResults).forEach(r => {
                totalSports += r.sports.length;
                totalSpecials += r.specials.length;
            });
            log(GP + ' ✅ Allocated ' + totalSports + ' sports + ' + totalSpecials + ' specials across ' + Object.keys(draftResults).length + ' bunks');

            return draftResults;

            // ─── Helper: Assign sports to bunks in a window ──────────
            function assignSportsToWindow(win, bunkList, availFields, grade, bunkDoneToday, bunkAssignedWindows) {
                const scoredBunks = bunkList.map(bunk => {
                    const sl = shoppingLists[bunk];
                    const sportsNeeded = (sl?.sports?.required || 0) - (draftResults[bunk]?.sports.length || 0);
                    return { bunk, sportsNeeded };
                }).sort((a, b) => b.sportsNeeded - a.sportsNeeded);

                const fieldSlots = availFields.map(f => ({ ...f }));

                for (const { bunk } of scoredBunks) {
                    const sl = shoppingLists[bunk];
                    if (!sl) continue;
                    const result = draftResults[bunk];
                    if (result.sports.length >= (sl.sports?.required || 0)) continue;

                    const done = bunkDoneToday[bunk] || new Set();

                    for (const sport of (sl.sports?.priorityList || [])) {
                        if (done.has(sport.name) || result.usedActivities.has(sport.name)) continue;

                        let assigned = false;
                        for (const fs of fieldSlots) {
                            if (fs.remaining <= 0) continue;
                            if (!fs.activities.includes(sport.name)) continue;
                            if (!isFieldStillAvailable(fs.name, win.start, win.end, bunk)) continue;

                            claimFieldForPlanner(fs.name, win.start, win.end, bunk, sport.name);
                            fs.remaining--;

                            const claimedTime = { startMin: win.start, endMin: win.end };
                            result.sports.push({ ...sport, claimedTime, claimedField: fs.name });
                            result.usedActivities.add(sport.name);
                            done.add(sport.name);
                            bunkAssignedWindows[bunk].push({ start: win.start, end: win.end, type: 'sport', activity: sport.name });
                            assigned = true;
                            break;
                        }
                        if (assigned) break;
                    }
                }
            }

            // ─── Helper: Assign specials to bunks in a window ────────
            function assignSpecialsToWindow(win, bunkList, grade, bunkDoneToday, bunkAssignedWindows) {
                for (const bunk of bunkList) {
                    const sl = shoppingLists[bunk];
                    if (!sl) continue;
                    const result = draftResults[bunk];
                    const done = bunkDoneToday[bunk] || new Set();

                    for (const special of (sl.specials?.priorityList || [])) {
                        if (done.has(special.name) || result.usedActivities.has(special.name)) continue;
                        if (special.totalDuration > win.duration) continue;
                        if (!canAssignSpecialToGrade(special.name, grade, win.start, win.end)) continue;

                        if (special.location) {
                            if (!isFieldStillAvailable(special.location, win.start, win.end, bunk)) continue;
                            claimFieldForPlanner(special.location, win.start, win.end, bunk, special.name);
                        }

                        registerSpecialAssignment(special.name, grade, win.start, win.end);
                        const claimedTime = { startMin: win.start, endMin: win.end };
                        result.specials.push({ ...special, claimedTime, claimedField: special.location });
                        result.usedActivities.add(special.name);
                        done.add(special.name);
                        bunkAssignedWindows[bunk].push({ start: win.start, end: win.end, type: 'special', activity: special.name });
                        break;
                    }
                }
            }

            // ─── Helper: Simple draft for single-bunk grades ─────────
            function simpleDraftForBunk(bunk, grade, sl, result) {
                for (const special of (sl.specials?.priorityList || [])) {
                    if (result.specials.length >= (sl.specials?.required || 0)) break;
                    if (result.usedActivities.has(special.name)) continue;
                    if (!canAssignSpecialToGrade(special.name, grade,
                        parseTimeToMinutes(divisions[grade]?.startTime) || 540,
                        parseTimeToMinutes(divisions[grade]?.endTime) || 960)) continue;

                    const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                    const dur = special.totalDuration || special.dMin || 30;
                    const time = special.location
                        ? findTimeForFieldGP(special.location, bunk, grade, dur, fw)
                        : findAnyWindowGP(fw, dur);
                    if (!time) continue;

                    if (special.location) claimField(special.location, time.startMin, time.endMin, bunk, grade, special.name);
                    registerSpecialAssignment(special.name, grade, time.startMin, time.endMin);
                    result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                    result.usedActivities.add(special.name);
                }

                for (const sport of (sl.sports?.priorityList || [])) {
                    if (result.sports.length >= (sl.sports?.required || 0)) break;
                    if (result.usedActivities.has(sport.name)) continue;
                    const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                    for (const field of (sport.fields || [])) {
                        const time = findTimeForFieldGP(field, bunk, grade, sport.dIdeal, fw);
                        if (time) {
                            claimField(field, time.startMin, time.endMin, bunk, grade, sport.name);
                            result.sports.push({ ...sport, claimedTime: time, claimedField: field });
                            result.usedActivities.add(sport.name);
                            break;
                        }
                    }
                }

                if (sl.elective) {
                    const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                    for (let i = 0; i < (sl.elective.count || 0); i++) {
                        const time = findAnyWindowGP(fw, sl.elective.dIdeal);
                        if (time) result.elective.push({
                            type: 'elective', duration: sl.elective.dIdeal,
                            claimedTime: time, layer: sl.elective.layer
                        });
                    }
                }
            }

            // ─── Helper: Get updated free windows for a bunk ─────────
            function getUpdatedFreeWindowsForBunk(bunk, sl, result) {
                const claimed = [...(result.sports || []), ...(result.specials || []),
                                 ...(result.elective || []), ...(result.generic || [])]
                    .map(c => c.claimedTime).filter(Boolean)
                    .sort((a, b) => a.startMin - b.startMin);
                const original = sl?.freeWindows || [];
                const updated = [];
                for (const win of original) {
                    let cur = win.start;
                    const ol = claimed.filter(c => c.startMin < win.end && c.endMin > win.start)
                        .sort((a, b) => a.startMin - b.startMin);
                    for (const cl of ol) {
                        if (cl.startMin > cur) updated.push({ start: cur, end: cl.startMin, duration: cl.startMin - cur });
                        cur = Math.max(cur, cl.endMin);
                    }
                    if (cur < win.end) updated.push({ start: cur, end: win.end, duration: win.end - cur });
                }
                return updated.filter(w => w.duration > 0);
            }

            // ─── Helper: Find time in a field's free windows ─────────
            function findTimeForFieldGP(fieldName, bunk, grade, duration, freeWindows) {
                for (const win of freeWindows) {
                    if (win.duration < duration) continue;
                    for (let t = win.start; t + duration <= win.end; t += 5) {
                        if (isFieldAvailable(fieldName, t, t + duration, bunk, grade))
                            return { startMin: t, endMin: t + duration };
                    }
                }
                return null;
            }

            // ─── Helper: Find any free window ────────────────────────
            function findAnyWindowGP(freeWindows, duration) {
                for (const win of freeWindows) {
                    if (win.duration >= duration)
                        return { startMin: win.start, endMin: win.start + duration };
                }
                return null;
            }
        }

        // =====================================================================
        // PHASE 3: GREEDY CONSTRAINT PACKER (per-bunk)
        // ★ v4.0 KEY FIXES:
        //   - Specials register worst-case (dMax) in RT at placement
        //   - Swim gated by canUsePoolAtTime
        //   - Field claims persist — no clearing between grades
        //   - Post-expand validation sweep for fields
        //   - Expand phase NEVER stretches specials past dMax
        // =====================================================================

        function greedyPackBunk(bunk, grade, draftResult, shoppingList, staggerOffset, swimsToday) {
            const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
            const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
            const sportC = shoppingList.sports?.constraints || resolveConstraints(null, 'sport');
            const minFill = getMinFillable(grade);
            const ABSORB_MAX = 10;
            // ★ v4.0: Rotation matrix — preferred time bands per activity type
            const rotation = staggerPlan[grade] || {};
            const typeBands = rotation.typeBands || {};

            // ── Step 1: Walls (Phase 0 blocks) ───────────────────────────
            const walls = (bunkTimelines[bunk] || []).map(b => {
                const t = (b.type || '').toLowerCase();
                const isLeague = t === 'league' || t === 'specialty_league';
                const c = (isLeague && b.layer) ? resolveConstraints(b.layer, t) : null;
                return {
                    startMin: b.startMin, endMin: b.endMin, type: b.type, event: b.event,
                    layer: b.layer, _fixed: true, _source: 'phase0',
                    dMin: c ? c.dMin : (b.endMin - b.startMin),
                    dMax: c ? c.dMax : (b.endMin - b.startMin),
                    _gradeWide: b._gradeWide || false, _activityLocked: true,
                    _classification: b._classification || 'pinned', _noBacktrack: b._noBacktrack || false
                };
            });

            // ── Step 2: Build needs ──────────────────────────────────────
            const needs = [];

            // Swim — MRC band narrows the window (hard constraint for pool exclusivity),
            // but rotation band is only a scoring preference (applied at candidate sort)
            const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
            if (swimLayer && swimsToday !== false && !walls.some(w => (w.type || '').toLowerCase() === 'swim')) {
                const c = resolveConstraints(swimLayer, 'swim');
                const mrc = getSwimWindow(grade);
                let winStart = Math.max(swimLayer.startMin || 0, gradeStart);
                let winEnd = Math.min(swimLayer.endMin || 1440, gradeEnd);
                // MRC narrows (pool exclusivity is a real constraint)
                if (mrc && (Math.min(mrc.end, winEnd) - Math.max(mrc.start, winStart)) >= c.dMin) {
                    winStart = Math.max(mrc.start, winStart);
                    winEnd = Math.min(mrc.end, winEnd);
                }
                needs.push({
                    type: 'swim', event: swimLayer.event || 'Swim', layer: swimLayer,
                    dMin: c.dMin, dMax: c.dMax,
                    windowStart: winStart, windowEnd: winEnd,
                    _activityLocked: true, _source: 'layer'
                });
            }

            // Snack
            const snackLayer = (layersByGrade[grade] || []).find(l => ['snacks', 'snack'].includes((l.type || '').toLowerCase()));
            if (snackLayer && !walls.some(w => ['snacks', 'snack'].includes((w.type || '').toLowerCase()))) {
                const c = resolveConstraints(snackLayer, 'snacks');
                needs.push({
                    type: 'snacks', event: snackLayer.event || 'snacks', layer: snackLayer,
                    dMin: c.dMin, dMax: c.dMax,
                   windowStart: (() => {
                        const base = Math.max(snackLayer.startMin || 0, gradeStart);
                        const end = Math.min(snackLayer.endMin || 1440, gradeEnd);
                        const range = end - base - c.dMin;
                        if (range <= 0 || _iterSeed === 0) return base;
                        const shift = Math.floor(seedJitter(_iterSeed, 777) * Math.min(range, 30));
                        return base + snapTo5(shift);
                    })(),
                    windowEnd: Math.min(snackLayer.endMin || 1440, gradeEnd),
                    _activityLocked: true, _source: 'layer'                });
            }

           // Draft specials — full window, rotation band applied at scoring
            // ★ v4.3: If draft didn't assign enough specials, pick from priority list
            const draftSpecialCount = (draftResult.specials || []).length;
            const requiredSpecials = shoppingList.specials?.required || 0;
            if (draftSpecialCount < requiredSpecials) {
                const usedNames = new Set((draftResult.specials || []).map(s => s.name));
                const priorityList = shoppingList.specials?.priorityList || [];
                for (const special of priorityList) {
                    if (draftResult.specials.length >= requiredSpecials) break;
                    if (usedNames.has(special.name)) continue;
                    draftResult.specials.push({
                        ...special,
                        claimedTime: null,
                        claimedField: special.location || null
                    });
                    usedNames.add(special.name);
                }
            }
            (draftResult.specials || []).forEach(special => {
                const hasFixedDur = special.duration && special.duration > 0;
                const sDMin = hasFixedDur ? special.duration : resolveConstraints(special.layer, 'special', special).dMin;
                const sDMax = hasFixedDur ? special.duration : resolveConstraints(special.layer, 'special', special).dMax;
                needs.push({
                    type: 'special', event: special.name, layer: special.layer,
                    dMin: sDMin, dMax: sDMax,
                    windowStart: gradeStart, windowEnd: gradeEnd,
                    _activityLocked: true, _assignedSpecial: special.name,
                    _specialLocation: special.location, _specialDuration: special.duration,
                    _source: 'draft'
                });
            });

            // Custom windowed layers
            (layersByGrade[grade] || []).filter(l =>
                (l.type || '').toLowerCase() === 'custom' && l._classification !== 'pinned'
            ).forEach(cl => {
                if (cl.customBunks && cl.customBunks.length > 0 && !cl.customBunks.includes(String(bunk))) return;
                const dur = cl.durationMin || cl.periodMin || 30;
                needs.push({
                    type: 'custom', event: cl.customActivity || cl.event || 'Custom', layer: cl,
                    dMin: dur, dMax: cl.durationMax || dur,
                    windowStart: Math.max(cl.startMin || 0, gradeStart),
                    windowEnd: Math.min(cl.endMin || 1440, gradeEnd),
                    _activityLocked: true,
                    _customActivity: cl.customActivity || null, _customField: cl.customField || null,
                    _customBunks: cl.customBunks || null, _source: 'custom-layer'
                });
            });

            // Sort: fixed-duration first, then tighter flexibility
            needs.sort((a, b) => {
                const aFixed = a.dMin === a.dMax ? 0 : 1;
                const bFixed = b.dMin === b.dMax ? 0 : 1;
                if (aFixed !== bFixed) return aFixed - bFixed;
                return ((a.windowEnd - a.windowStart) / Math.max(1, a.dMin)) - ((b.windowEnd - b.windowStart) / Math.max(1, b.dMin));
            });

            // Stagger rotation for flex needs
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

           // ── TEMP DEBUG ───────────────────────────────────────────────
            if (grade === '2nd Grade' && String(bunk) === String(getBunksForGrade(grade, divisions)[0])) {
                console.log('[PACKER-DBG] 2nd Grade bunk ' + bunk + ': ' + needs.length + ' needs');
                needs.forEach(function(n, i) { console.log('  need[' + i + ']: type=' + n.type + ' event=' + (n.event || n._assignedSpecial || '?') + ' dMin=' + n.dMin + ' dMax=' + n.dMax + ' win=' + n.windowStart + '-' + n.windowEnd); });
                var dbgWalls = walls.map(function(w) { return w.startMin + '-' + w.endMin + '(' + w.event + ')'; });
                console.log('  Walls: ' + dbgWalls.join(', '));
                console.log('  draftResult.specials: ' + (draftResult.specials || []).length);
                console.log('  shoppingList.specials.required: ' + (shoppingList.specials?.required || 0));
                console.log('  shoppingList.specials.priorityList: ' + (shoppingList.specials?.priorityList?.length || 0));
                (shoppingList.specials?.priorityList || []).forEach(function(s) { console.log('    priority: ' + s.name + ' dur=' + s.totalDuration + ' scarce=' + s.isScarce); });
                (draftResult.specials || []).forEach(function(s) { console.log('    draft special: ' + s.name + ' dur=' + s.totalDuration); });
            }

            // ── Helpers ───────────────────────────────────────────────────
            function getGaps(blockList) {
                const sorted = [...blockList].sort((a, b) => a.startMin - b.startMin);
                const gaps = [];
                let cur = gradeStart;
                sorted.forEach(b => { if (b.startMin > cur) gaps.push({ start: cur, end: b.startMin, size: b.startMin - cur }); cur = Math.max(cur, b.endMin); });
                if (cur < gradeEnd) gaps.push({ start: cur, end: gradeEnd, size: gradeEnd - cur });
                return gaps;
            }

            function canFitRemaining(currentPlaced, remainingNeeds) {
                if (remainingNeeds.length === 0) return true;
                const gaps = getGaps(currentPlaced);
                for (const need of remainingNeeds) {
                    const ok = gaps.some(g => {
                        const es = Math.max(g.start, need.windowStart);
                        const ee = Math.min(g.end, need.windowEnd);
                        return ee - es >= need.dMin;
                    });
                    if (!ok) return false;
                }
                const totalNeed = remainingNeeds.reduce((s, n) => s + n.dMin, 0);
                const totalGap = gaps.reduce((s, g) => s + g.size, 0);
                return totalNeed <= totalGap;
            }

            // ── Step 3: Pack needs into gaps ──────────────────────────────
            const placed = [...walls];

            for (let i = 0; i < needs.length; i++) {
                const need = needs[i];
                const remaining = needs.slice(i + 1);
                const gaps = getGaps(placed);
                const validGaps = gaps
                    .map(g => ({ start: Math.max(g.start, need.windowStart), end: Math.min(g.end, need.windowEnd), origStart: g.start, origEnd: g.end }))
                    .filter(g => g.end - g.start >= need.dMin)
                    .sort((a, b) => (b.end - b.start) - (a.end - a.start));

                let didPlace = false;
                for (const gap of validGaps) {
                    const isSwim = need.type === 'swim';
                    const isSpecial = need.type === 'special' && need._assignedSpecial;
                    const step = (isSwim || isSpecial) ? 5 : 15;
                    const candidates = [];
                    for (let t = gap.start; t <= gap.end - need.dMin; t += step) candidates.push(t);
                    if (step > 5 && gap.end - need.dMin > gap.start) candidates.push(gap.end - need.dMin);

                    // Sort by weighted score: cross-grade conflicts + rotation band preference
                    // Rotation band is a STRONG SUGGESTION, not a hard constraint.
                    // In-band positions get a bonus; out-of-band get a mild penalty.
                    if (['swim', 'special', 'snacks', 'snack'].includes(need.type)) {
                        const band = typeBands[need.type] || typeBands[need.type === 'snacks' ? 'snack' : need.type] || null;
                      candidates.sort((a, b) => {
                            let scoreA = getCrossGradeConflicts(need.type, a, a + need.dMin, grade, need.event) * 100;
                            let scoreB = getCrossGradeConflicts(need.type, b, b + need.dMin, grade, need.event) * 100;
                            // Rotation band preference: -50 if inside, +20 if outside
                            if (band) {
                                scoreA += (a >= band.start && (a + need.dMin) <= band.end) ? -50 : 20;
                                scoreB += (b >= band.start && (b + need.dMin) <= band.end) ? -50 : 20;
                            }
                            // Iteration jitter: vary time placement
                            scoreA += (seedJitter(_iterSeed, a) - 0.5) * 80;
                            scoreB += (seedJitter(_iterSeed, b) - 0.5) * 80;
                            if (scoreA !== scoreB) return scoreA - scoreB;
                            return (staggerOffset % 2 === 0) ? (a - b) : (b - a);
                        });
                    }

                    for (const pos of candidates) {
                        const beforeRes = pos - gap.origStart;
                        const afterRes = gap.origEnd - (pos + need.dMin);
                        if (need.dMin === need.dMax) {
                            if (beforeRes > 0 && beforeRes < minFill) continue;
                            if (afterRes > 0 && afterRes < minFill) continue;
                        } else {
                            if (beforeRes > ABSORB_MAX && beforeRes < minFill) continue;
                            if (afterRes > ABSORB_MAX && afterRes < minFill) continue;
                        }

                        // ★ v4.0: Special cross-division check
                        if (isSpecial && !canUseSpecialAtTime(need._assignedSpecial, grade, pos, pos + need.dMin)) continue;

                        // ★ v4.0: Pool exclusivity check for swim
                        if (isSwim && !canUsePoolAtTime(grade, pos, pos + need.dMin)) continue;

                        const tempBlock = { startMin: pos, endMin: pos + need.dMin, type: need.type, event: need.event };
                        if (canFitRemaining([...placed, tempBlock], remaining)) {
                            placed.push({ startMin: pos, endMin: pos + need.dMin, ...need, _final: true });
                            didPlace = true;
                            break;
                        }
                    }
                    if (didPlace) break;
                }

                // Fallback
                if (!didPlace) {
                    for (const gap of validGaps) {
                        for (let t = gap.start; t <= gap.end - need.dMin; t += 5) {
                            if (need.type === 'special' && need._assignedSpecial && !canUseSpecialAtTime(need._assignedSpecial, grade, t, t + need.dMin)) continue;
                            if (need.type === 'swim' && !canUsePoolAtTime(grade, t, t + need.dMin)) continue;
                            if (need.dMin === need.dMax) {
                                const br = t - gap.origStart, ar = gap.origEnd - (t + need.dMin);
                                if (br > 0 && br < minFill) continue;
                                if (ar > 0 && ar < minFill) continue;
                            }
                            placed.push({ startMin: t, endMin: t + need.dMin, ...need, _final: true });
                            didPlace = true;
                            break;
                        }
                        if (didPlace) break;
                    }
                }

                // ★ Swim fallback: if MRC-narrowed window failed, retry with full layer window.
                // MRC is a preference for pool exclusivity staggering, not a hard constraint.
                // Better to have swim at a non-ideal time than no swim at all.
                if (!didPlace && need.type === 'swim' && need.layer) {
                    const fullWinStart = Math.max(need.layer.startMin || 0, gradeStart);
                    const fullWinEnd = Math.min(need.layer.endMin || 1440, gradeEnd);
                    // Only retry if full window is actually wider than what we tried
                    if (fullWinEnd - fullWinStart > need.windowEnd - need.windowStart) {
                        const remaining = needs.slice(i + 1);
                        const fullGaps = getGaps(placed)
                            .map(g => ({ start: Math.max(g.start, fullWinStart), end: Math.min(g.end, fullWinEnd), origStart: g.start, origEnd: g.end }))
                            .filter(g => g.end - g.start >= need.dMin)
                            .sort((a, b) => (b.end - b.start) - (a.end - a.start));
                        for (const gap of fullGaps) {
                            for (let t = gap.start; t <= gap.end - need.dMin; t += 5) {
                                if (!canUsePoolAtTime(grade, t, t + need.dMin)) continue;
                                const beforeRes = t - gap.origStart;
                                const afterRes = gap.origEnd - (t + need.dMin);
                                // Relaxed residual: only reject truly tiny (1-5 min) gaps
                                if (beforeRes > 0 && beforeRes <= 5) continue;
                                if (afterRes > 0 && afterRes <= 5) continue;
                                const tempBlock = { startMin: t, endMin: t + need.dMin, type: 'swim', event: need.event };
                                if (canFitRemaining([...placed, tempBlock], remaining)) {
                                    placed.push({ startMin: t, endMin: t + need.dMin, ...need, _final: true });
                                    didPlace = true; break;
                                }
                            }
                            if (didPlace) break;
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
                    if (need.type === 'swim') {
                        const worstCaseEnd = lastPlaced.startMin + (need.dMax || need.dMin);
                        registerPoolUsage(grade, lastPlaced.startMin, worstCaseEnd);
                    }
                }
            }

            // ── Step 4: Fill remaining gaps with sport slots ──────────────
            const usedSportsForBunk = new Set();
            (draftResult.sports || []).forEach(s => usedSportsForBunk.add(s.name));
            const priorityList = shoppingList.sports?.priorityList || [];

            function findSportWithField(startMin, endMin) {
                // Unused draft sports first
                for (const ds of (draftResult.sports || [])) {
                    if (usedSportsForBunk.has(ds.name)) continue;
                    const sportInfo = priorityList.find(s => s.name === ds.name);
                    if (sportInfo) {
                        for (const fn of (sportInfo.fields || [])) {
                            if (isFieldAvailable(fn, startMin, endMin, bunk, grade)) return { name: ds.name, field: fn };
                        }
                    }
                }
                // Unused from rotation list
                for (const sport of priorityList) {
                    if (usedSportsForBunk.has(sport.name)) continue;
                    for (const fn of (sport.fields || [])) {
                        if (isFieldAvailable(fn, startMin, endMin, bunk, grade)) return { name: sport.name, field: fn };
                    }
                }
                // Allow repeats
                for (const sport of priorityList) {
                    for (const fn of (sport.fields || [])) {
                        if (isFieldAvailable(fn, startMin, endMin, bunk, grade)) return { name: sport.name, field: fn };
                    }
                }
                return null;
            }

            const afterGaps = getGaps(placed);
            for (const gap of afterGaps) {
                if (gap.size < sportC.dMin) continue;
                let numSlots = Math.ceil(gap.size / sportC.dMax);
                if (numSlots * sportC.dMin > gap.size) numSlots = Math.max(1, numSlots - 1);
                let cursor = gap.start;
                for (let s = 0; s < numSlots; s++) {
                    const sportPick = findSportWithField(cursor, cursor + sportC.dMax);
                    if (sportPick) {
                        claimField(sportPick.field, cursor, cursor + sportC.dMax, bunk, grade, sportPick.name);
                        usedSportsForBunk.add(sportPick.name);
                    }
                    placed.push({
                        startMin: cursor, endMin: cursor + sportC.dMin,
                        type: sportPick ? 'sport' : 'slot',
                        event: sportPick ? sportPick.name : 'General Activity Slot',
                        layer: shoppingList.sports?.layer, dMin: sportC.dMin, dMax: sportC.dMax,
                        _activityLocked: false,
                        _assignedSport: sportPick ? sportPick.name : null,
                        field: sportPick ? sportPick.field : null,
                        _source: sportPick ? 'capacity_checked' : 'filler',
                        _sportFallbacks: priorityList.map(s => s.name), _final: true
                    });
                    cursor += sportC.dMin;
                }
            }

            // ── Step 5: Expand — size all blocks to fill regions exactly ──
            placed.sort((a, b) => a.startMin - b.startMin);
            const template = [];
            const boundaryTimes = new Set([gradeStart, gradeEnd]);
            walls.forEach(w => { boundaryTimes.add(w.startMin); boundaryTimes.add(w.endMin); });
            placed.filter(b => b.dMin === b.dMax && b._source !== 'phase0').forEach(b => { boundaryTimes.add(b.startMin); boundaryTimes.add(b.endMin); });
            const boundaries = [...boundaryTimes].sort((a, b) => a - b);

            for (let r = 0; r < boundaries.length - 1; r++) {
                const rStart = boundaries[r], rEnd = boundaries[r + 1], rSize = rEnd - rStart;
                if (rSize <= 0) continue;

                const wallHere = placed.find(b => b._source === 'phase0' && b.startMin <= rStart && b.endMin >= rEnd);
                if (wallHere) { if (!template.some(t => t.startMin === wallHere.startMin && t.endMin === wallHere.endMin)) template.push({ ...wallHere, _final: true }); continue; }

                const fixedHere = placed.find(b => b.dMin === b.dMax && b._source !== 'phase0' && b.startMin <= rStart && b.endMin >= rEnd);
                if (fixedHere) { if (!template.some(t => t.startMin === fixedHere.startMin && t.endMin === fixedHere.endMin)) template.push({ ...fixedHere, _final: true }); continue; }

                const flexBlocks = placed.filter(b => b.startMin >= rStart && b.startMin < rEnd && b._source !== 'phase0' && !(b.dMin === b.dMax));
                if (flexBlocks.length === 0) {
                    if (rSize >= sportC.dMin) {
                        let numF = Math.max(1, Math.ceil(rSize / sportC.dMax));
                        while (numF > 0 && numF * sportC.dMin > rSize) numF--;
                        if (numF === 0 && rSize >= sportC.dMin) numF = 1;
                        const descs = [];
                        for (let f = 0; f < numF; f++) descs.push({ dMin: sportC.dMin, dMax: sportC.dMax });
                        const durs = perfectFitDistribute(descs, rSize);
                        let cur = rStart;
                        for (let f = 0; f < numF; f++) {
                            const sp = findSportWithField(cur, cur + durs[f]);
                            if (sp) { claimField(sp.field, cur, cur + durs[f], bunk, grade, sp.name); usedSportsForBunk.add(sp.name); }
                            template.push({
                                startMin: cur, endMin: cur + durs[f], type: sp ? 'sport' : 'slot',
                                event: sp ? sp.name : 'General Activity Slot', layer: shoppingList.sports?.layer,
                                dMin: sportC.dMin, dMax: sportC.dMax, _activityLocked: false,
                                _assignedSport: sp ? sp.name : null, field: sp ? sp.field : null,
                                _source: sp ? 'capacity_checked' : 'filler', _final: true
                            });
                            cur += durs[f];
                        }
                    }
                    continue;
                }

                const descs = flexBlocks.map(b => {
                    // ★ v4.0: Specials NEVER expand beyond dMax — prevents cross-div conflict
                    const isSpec = (b.type || '').toLowerCase() === 'special';
                    return { block: b, dMin: b.dMin, dMax: isSpec ? b.dMax : b.dMax };
                });
                const totalDMax = descs.reduce((s, d) => s + d.dMax, 0);
                if (totalDMax < rSize) {
                    const extraSpace = rSize - totalDMax;
                    let extraCount = Math.ceil(extraSpace / sportC.dMax);
                    for (let e = 0; e < extraCount; e++) {
                        const sp = findSportWithField(rStart, rStart + sportC.dMax);
                        if (sp) { claimField(sp.field, rStart, rStart + sportC.dMax, bunk, grade, sp.name); usedSportsForBunk.add(sp.name); }
                        descs.push({
                            block: { type: sp ? 'sport' : 'slot', event: sp ? sp.name : 'General Activity Slot', layer: shoppingList.sports?.layer, _activityLocked: false, _assignedSport: sp ? sp.name : null, field: sp ? sp.field : null, _source: sp ? 'capacity_checked' : 'filler' },
                            dMin: sportC.dMin, dMax: sportC.dMax
                        });
                    }
                }
                while (descs.length > 1 && descs.reduce((s, d) => s + d.dMin, 0) > rSize) descs.pop();

                const durs = perfectFitDistribute(descs.map(d => ({ dMin: d.dMin, dMax: d.dMax })), rSize);
                let cur = rStart;
                for (let d = 0; d < descs.length; d++) {
                    const dur = durs[d] || descs[d].dMin;
                    if (dur <= 0) continue;
                    const b = descs[d].block;
                    template.push({
                        startMin: cur, endMin: cur + dur, type: b.type, event: b.event,
                        layer: b.layer, field: b.field, dMin: descs[d].dMin, dMax: descs[d].dMax,
                        _source: b._source || 'draft', _activityLocked: b._activityLocked || false,
                        _assignedSpecial: b._assignedSpecial || null, _specialLocation: b._specialLocation || null,
                        _specialDuration: b._specialDuration || null, _assignedSport: b._assignedSport || null,
                        _final: true
                    });
                    cur += dur;
                }
            }

            // ── Step 6: Gap sweep — absorb residuals ─────────────────────
            template.sort((a, b) => a.startMin - b.startMin);
            for (let pass = 0; pass < 3; pass++) {
                let changed = false;
                for (let i = 0; i < template.length - 1; i++) {
                    const gap = template[i + 1].startMin - template[i].endMin;
                    if (gap <= 0) continue;
                    if (gap <= ABSORB_MAX) {
                        const prev = template[i], next = template[i + 1];
                        const prevFlex = prev.dMin !== prev.dMax && prev._source !== 'phase0';
                        const nextFlex = next.dMin !== next.dMax && next._source !== 'phase0';
                        // ★ v4.0: Don't absorb into specials (would violate dMax constraint)
                        const prevIsSpecial = (prev.type || '').toLowerCase() === 'special';
                        const nextIsSpecial = (next.type || '').toLowerCase() === 'special';
                        if (prevFlex && !prevIsSpecial) { prev.endMin += gap; changed = true; }
                        else if (nextFlex && !nextIsSpecial) { next.startMin -= gap; changed = true; }
                        else if (prevFlex) { prev.endMin += gap; changed = true; }
                        else if (nextFlex) { next.startMin -= gap; changed = true; }
                    } else if (gap >= sportC.dMin) {
                        const sp = findSportWithField(template[i].endMin, template[i + 1].startMin);
                        if (sp) { claimField(sp.field, template[i].endMin, template[i + 1].startMin, bunk, grade, sp.name); usedSportsForBunk.add(sp.name); }
                        template.push({
                            startMin: template[i].endMin, endMin: template[i + 1].startMin,
                            type: sp ? 'sport' : 'slot', event: sp ? sp.name : 'General Activity Slot',
                            layer: shoppingList.sports?.layer, dMin: sportC.dMin, dMax: sportC.dMax,
                            _activityLocked: false, _assignedSport: sp ? sp.name : null,
                            field: sp ? sp.field : null, _source: sp ? 'capacity_checked' : 'filler', _final: true
                        });
                        template.sort((a, b) => a.startMin - b.startMin);
                        changed = true;
                    } else {
                        // Dead zone — forced absorption into non-special neighbor
                        const prev = template[i], next = template[i + 1];
                        const prevIsSpec = (prev.type || '').toLowerCase() === 'special';
                        const nextIsSpec = (next.type || '').toLowerCase() === 'special';
                        if (prev._source !== 'phase0' && !prevIsSpec) { prev.endMin += gap; changed = true; }
                        else if (next._source !== 'phase0' && !nextIsSpec) { next.startMin -= gap; changed = true; }
                        else if (prev._source !== 'phase0') { prev.endMin += gap; changed = true; }
                        else if (next._source !== 'phase0') { next.startMin -= gap; changed = true; }
                    }
                }
                // Day edges
                if (template.length > 0) {
                    const firstGap = template[0].startMin - gradeStart;
                    if (firstGap > 0 && firstGap <= ABSORB_MAX && template[0]._source !== 'phase0') { template[0].startMin = gradeStart; changed = true; }
                    else if (firstGap >= sportC.dMin) { template.unshift({ startMin: gradeStart, endMin: template[0].startMin, type: 'slot', event: 'General Activity Slot', layer: shoppingList.sports?.layer, dMin: sportC.dMin, dMax: sportC.dMax, _source: 'filler', _final: true }); changed = true; }
                    else if (firstGap > 0) { template[0].startMin = gradeStart; changed = true; }

                    const lastGap = gradeEnd - template[template.length - 1].endMin;
                    if (lastGap > 0 && lastGap <= ABSORB_MAX && template[template.length - 1]._source !== 'phase0') { template[template.length - 1].endMin = gradeEnd; changed = true; }
                    else if (lastGap >= sportC.dMin) { template.push({ startMin: template[template.length - 1].endMin, endMin: gradeEnd, type: 'slot', event: 'General Activity Slot', layer: shoppingList.sports?.layer, dMin: sportC.dMin, dMax: sportC.dMax, _source: 'filler', _final: true }); changed = true; }
                    else if (lastGap > 0) { template[template.length - 1].endMin = gradeEnd; changed = true; }
                }
                template.sort((a, b) => a.startMin - b.startMin);
                if (!changed) break;
            }

            // ── Step 7: Post-expand enforcement ──────────────────────────
            // Clamp configured specials to exact duration
            for (const blk of template) {
                if ((blk.type || '').toLowerCase() !== 'special') continue;
                const eName = blk.event || blk._assignedSpecial;
                if (!eName) continue;
                const cfgDur = getSpecialDuration(eName, activityProperties, globalSettings);
                if (cfgDur && cfgDur > 0 && (blk.endMin - blk.startMin) !== cfgDur) {
                    blk.endMin = blk.startMin + cfgDur;
                }
            }

            // ★ v4.0: Post-expand field validation — re-check all capacity_checked sport claims
            // ★ v4.1 FIX: Re-sync field ledger FIRST so later grades see actual expanded times.
            // 1. Unclaim all stale pre-expansion claims for this bunk
            unclaimFieldsForBunk(bunk);
            // 2. Re-claim at actual expanded times; demote blocks that can't re-claim
            for (const blk of template) {
                if (!blk.field || blk._source === 'phase0') continue;
                const canReclaim = claimField(blk.field, blk.startMin, blk.endMin, bunk, grade, blk.event || blk._assignedSport || 'sport');
                if (!canReclaim) {
                    // Field is no longer available at expanded time — find alternative
                    const alt = findSportWithField(blk.startMin, blk.endMin);
                    if (alt && claimField(alt.field, blk.startMin, blk.endMin, bunk, grade, alt.name)) {
                        blk.field = alt.field;
                        blk.event = alt.name;
                        blk._assignedSport = alt.name;
                    } else {
                        // No alternative — demote to unassigned slot
                        blk.field = null;
                        blk.type = 'slot';
                        blk.event = 'General Activity Slot';
                        blk._assignedSport = null;
                        blk._source = 'filler';
                    }
                }
            }

            return template.sort((a, b) => a.startMin - b.startMin);
        }


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
                        _activityLocked: block._activityLocked || block._fixed || false,
                        _fixed: block._fixed || false, _gradeWide: block._gradeWide || false,
                        _noBacktrack: block._noBacktrack || false,
                        _fromGapDetection: block._source === 'filler',
                        _bunkOverride: true,
                        _draftActivity: block._customActivity || block._assignedSport || block._assignedSpecial || null,
                        _draftField: block._customField || block.field || null,
                        _sportFallbacks: block._sportFallbacks || null,
                        _customActivity: block._customActivity || null,
                        _customField: block._customField || null,
                        _customBunks: block._customBunks || null,
                        _source: block._source || null
                    });
                });
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
            });
        }


        // =====================================================================
        // SCORING ENGINE
        // =====================================================================

        const MAX_ITERATIONS = 30;
        const STALE_STOP = 8;
       let _iterSeed = 0, bestScore = Infinity, bestTimelines = null;
        let bestWarnings = [], staleCount = 0, totalIters = 0;

        // Seeded jitter for iteration variation
        function seedJitter(seed, index) {
            return (((seed * 2654435761 + index * 1597) >>> 0) % 1000) / 1000;
        }
        function seedShuffle(arr, seed) {
            const a = [...arr];
            for (let i = a.length - 1; i > 0; i--) {
                const j = ((seed * 2654435761 + i * 1597) >>> 0) % (i + 1);
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        }

        function scoreTimelines(timelines, iterWarnings) {
            let score = 0;
            const campStart = Math.min(...Object.values(divisions).map(d => parseTimeToMinutes(d.startTime) || 660));
            const campEnd = Math.max(...Object.values(divisions).map(d => parseTimeToMinutes(d.endTime) || 990));

            Object.entries(timelines).forEach(([bunk, timeline]) => {
                const gradeKey = Object.entries(divisions).find(([g, d]) => (d.bunks || []).map(String).includes(String(bunk)))?.[0];
                const dayStart = gradeKey ? (parseTimeToMinutes(divisions[gradeKey]?.startTime) || 540) : 540;
                const dayEnd = gradeKey ? (parseTimeToMinutes(divisions[gradeKey]?.endTime) || 960) : 960;
                const sorted = [...timeline].sort((a, b) => a.startMin - b.startMin);

                // Gaps
                if (sorted.length > 0 && sorted[0].startMin > dayStart) score += (sorted[0].startMin - dayStart) * 15;
                for (let i = 0; i < sorted.length - 1; i++) { const gap = sorted[i + 1].startMin - sorted[i].endMin; if (gap > 0) score += gap * 15; }
                if (sorted.length > 0 && sorted[sorted.length - 1].endMin < dayEnd) score += (dayEnd - sorted[sorted.length - 1].endMin) * 15;

                // Duration violations
                timeline.forEach(block => {
                    if (block._fromGapDetection && !block.layer) return;
                    const { dMin } = resolveConstraints(block.layer, (block.type || 'slot').toLowerCase(), block);
                    const dur = block.endMin - block.startMin;
                    if (dur < dMin) score += (dMin - dur) * 200;
                });

                // Out of bounds
                if (gradeKey) timeline.forEach(b => { if (b.endMin <= dayStart || b.startMin >= dayEnd) score += 10000; });
            });

            iterWarnings.forEach(w => { if (w.type === 'placement_failure') score += 500; if (w.type === 'overlap') score += 1000; });

            // Field contention
            for (let t = campStart; t < campEnd; t += CONTENTION_SLICE) {
                const se = Math.min(t + CONTENTION_SLICE, campEnd);
                let cnt = 0;
                Object.entries(timelines).forEach(([bk, tl]) => {
                    for (const b of tl) { if (getFieldImpact(b) === 'consumer' && b.startMin < se && b.endMin > t) { cnt++; break; } }
                });
                if (cnt > 26) score += (cnt - 26) * 200;
            }
            return score;
        }


        // =====================================================================
        // SWIM ROTATION
        // =====================================================================

        const swimHistory = {};
        function loadSwimHistory() {
            try {
                const gs = getGlobalSettings();
                const stored = gs.swimRotationHistory || gs.app1?.swimRotationHistory;
                if (stored) Object.assign(swimHistory, stored);
                const ls = localStorage.getItem('campistry_swimRotationHistory');
                if (ls && !stored) Object.assign(swimHistory, JSON.parse(ls));
            } catch (e) { /* ignore */ }
        }
        function saveSwimHistory() {
            try {
                const gs = getGlobalSettings();
                if (gs.app1) gs.app1.swimRotationHistory = swimHistory;
                localStorage.setItem('campistry_swimRotationHistory', JSON.stringify(swimHistory));
                if (window.IntegrationHooks?.queueChange) window.IntegrationHooks.queueChange('swimRotationHistory', swimHistory);
            } catch (e) { /* ignore */ }
        }

        function getSwimmersForToday(grade, allBunks, swimLayer, seed) {
            const gs = getGlobalSettings();
            const dedicatedConfig = gs.swimRotationConfig?.[grade] || JSON.parse(localStorage.getItem('campistry_swimRotationConfig') || '{}')?.[grade];
            const bunksPerDay = dedicatedConfig?.bunksPerDay || swimLayer.bunksPerDay || swimLayer._bunksPerDay || allBunks.length;
            const timesPerWeek = dedicatedConfig?.timesPerWeek || swimLayer.timesPerWeek || swimLayer._timesPerWeek || 5;
            if (bunksPerDay >= allBunks.length) return allBunks;

            const weekStart = getMondayOfWeek(currentDate, 0);
            const weekCounts = {};
            allBunks.forEach(b => { weekCounts[String(b)] = 0; });
            const gradeHistory = swimHistory[grade] || {};
            Object.entries(gradeHistory).forEach(([dateStr, bunksArr]) => {
                if (dateStr >= weekStart && dateStr < currentDate) {
                    (bunksArr || []).forEach(b => { if (weekCounts[String(b)] !== undefined) weekCounts[String(b)]++; });
                }
            });

            const sorted = [...allBunks].map(b => ({
                bunk: b, count: weekCounts[String(b)] || 0,
                rand: ((seed * 2654435761 + parseInt(String(b).replace(/\D/g, '')) * 1597) >>> 0) % 10000
            }));
            sorted.sort((a, b) => a.count !== b.count ? a.count - b.count : a.rand - b.rand);
            const needsSwim = sorted.filter(s => s.count < timesPerWeek);
            if (needsSwim.length === 0) {
                if (!swimHistory[grade]) swimHistory[grade] = {};
                swimHistory[grade][currentDate] = [];
                return [];
            }
            const selected = needsSwim.slice(0, bunksPerDay).map(s => s.bunk);
            if (!swimHistory[grade]) swimHistory[grade] = {};
            swimHistory[grade][currentDate] = selected.map(String);
            return selected;
        }

        loadSwimHistory();


        // =====================================================================
        // CROSS-GRADE ROTATION MATRIX
        // =====================================================================
        // Creates a Latin-square rotation so at any time of day, each grade
        // PREFERS to be doing a DIFFERENT activity type. This is a STRONG
        // SUGGESTION to the scheduler — not a hard constraint. If the band
        // doesn't work (walls, capacity, windows), the block can still go
        // anywhere in the allowed window. The preference is applied via
        // scoring bonuses at candidate evaluation time.
        //
        // Staggerable types (in priority order):
        //   swim    — exclusive pool, off-field
        //   league  — heavy field use, all bunks on fields
        //   special — usually off-field (indoor/location-based)
        //   sport   — fills remaining time, field-heavy
        //
        // The matrix divides each grade's day into bands and assigns a
        // preferred type per band. Candidate positions that fall inside
        // the assigned band get a scoring bonus; positions outside get
        // a mild penalty. The iteration loop tries different shuffles
        // to find the best rotation arrangement.
        // =====================================================================

        function buildRotationMatrix(grades, seed) {
            // ★ v4.2: Only stagger OFF-FIELD types. Sport is never in the matrix.
            // The matrix answers: "When should this grade do its off-field activities?"
            // Sport fills whatever time remains — no band needed.
            //
            // Off-field types (take bunks OFF fields, relieving contention):
            //   swim    — exclusive pool
            //   league  — on fields BUT all bunks together (concentrated, not spread)
            //   special — usually indoor/location-based
            //   snack   — off-field break
            //
            // Each grade gets a rotated subset of these based on what layers it has.
            // The day is divided into bands equal to the MAXIMUM off-field count
            // across all grades. Grades with fewer off-field types leave some bands
            // empty (no preference = sport fills naturally).

            // Seeded shuffle
            const shuffled = [...grades];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = ((seed * 2654435761 + i * 1597) >>> 0) % (i + 1);
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            // Determine which off-field types each grade has
            const gradeInfo = {};
            let maxOffField = 0;
            shuffled.forEach(grade => {
                const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                const layers = layersByGrade[grade] || [];
                const offField = [];
                if (layers.some(l => (l.type || '').toLowerCase() === 'swim')) offField.push('swim');
                if (layers.some(l => { const t = (l.type || '').toLowerCase(); return t === 'league' || t === 'specialty_league'; })) offField.push('league');
                if (layers.some(l => (l.type || '').toLowerCase() === 'special')) offField.push('special');
                if (layers.some(l => ['snack', 'snacks'].includes((l.type || '').toLowerCase()))) offField.push('snack');
                gradeInfo[grade] = { start: gs, end: ge, duration: ge - gs, offField };
                if (offField.length > maxOffField) maxOffField = offField.length;
            });

            // If no grade has any off-field types, skip rotation entirely
            if (maxOffField === 0) {
                const plan = {};
                shuffled.forEach((grade, idx) => {
                    plan[grade] = { offset: idx, searchDirection: idx % 2 === 0 ? 'early' : 'late', sequence: [], typeBands: {}, gradeStart: gradeInfo[grade].start, gradeEnd: gradeInfo[grade].end };
                });
                return plan;
            }

            // Divide the day into bands — one per off-field slot (max across grades)
            // Minimum 3 bands so off-field activities spread across early/mid/late
            const bandCount = Math.max(3, maxOffField);

            const plan = {};
            shuffled.forEach((grade, idx) => {
                const info = gradeInfo[grade];
                const bandDur = Math.floor(info.duration / bandCount);

                // Assign this grade's off-field types to rotated band positions
                // Band position = (original_position + grade_offset) % bandCount
                const typeBands = {};
                const sequence = [];
                info.offField.forEach((type, typeIdx) => {
                    const bandPos = (typeIdx + idx) % bandCount;
                    const bandStart = info.start + bandPos * bandDur;
                    const bandEnd = (bandPos === bandCount - 1) ? info.end : (bandStart + bandDur);
                    typeBands[type] = { start: bandStart, end: bandEnd };
                    sequence.push(type);
                });

                plan[grade] = {
                    offset: idx,
                    searchDirection: idx % 2 === 0 ? 'early' : 'late',
                    sequence,
                    typeBands,   // ONLY contains off-field types, never sport
                    gradeStart: info.start,
                    gradeEnd: info.end
                };
            });

            // Log the matrix
            if (totalIters < 1) {
                log('[ROTATION MATRIX] Off-field activity bands (sport fills remaining time):');
                shuffled.forEach(grade => {
                    const p = plan[grade];
                    if (p.sequence.length === 0) {
                        log('  ' + grade + ': no off-field types — all sport');
                        return;
                    }
                    const bandStr = Object.entries(p.typeBands)
                        .sort((a, b) => a[1].start - b[1].start)
                        .map(([t, b]) => t + '=' + minutesToTimeLabel(b.start) + '-' + minutesToTimeLabel(b.end))
                        .join(', ');
                    log('  ' + grade + ': [' + p.sequence.join(', ') + '] ' + bandStr);
                });
            }

            return plan;
        }


        // =====================================================================
        // RESET STATE (for iteration loop)
        // =====================================================================
        function resetIterState() {
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = []; }));
            Object.keys(sharedLeagueTime).forEach(k => delete sharedLeagueTime[k]);
            resourceCalendar.swim = {};
            // ★ v4.0: Reset resource tracker + field ledger between iterations
            rtReset();
            initFieldLedger();
        }


        // =====================================================================
        // ITERATION LOOP
        // =====================================================================
        log('\n══════════════════════════════════════════════════════════');
        log('WHAT→WHEN→WHERE — cap: ' + MAX_ITERATIONS + ' | stale: ' + STALE_STOP);
        log('══════════════════════════════════════════════════════════');

        let todaysSwimmers = {};

        do {
            staggerPlan = buildRotationMatrix(allGrades, _iterSeed);
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = []; }));

            // Init field ledger for this iteration
            initFieldLedger();

            // Phase 0: Pinned + trips + leagues
            const pinnedCount = executePinnedLayers();

            // Inject daily trips
            let tripBlockCount = 0;
            let dailyTrips = [];
            try { const stored = localStorage.getItem('campDailyTrips_' + (window.currentScheduleDate || '')); if (stored) dailyTrips = JSON.parse(stored); } catch(e) {}
            if (!dailyTrips.length) dailyTrips = dailyData?.dailyTrips || [];
            dailyTrips.forEach(trip => {
                const grade = trip.division;
                if (!grade || !divisions[grade]) return;
                if (allowedSet && !allowedSet.has(String(grade))) return;
                const tStart = trip.startMin ?? parseTimeToMinutes(trip.startTime);
                const tEnd = trip.endMin ?? parseTimeToMinutes(trip.endTime);
                if (tStart == null || tEnd == null) return;
                getBunksForGrade(grade, divisions).forEach(bunk => {
                    bunkTimelines[bunk].push({
                        startMin: tStart, endMin: tEnd, type: 'trip', event: trip.event || 'Trip',
                        layer: null, _classification: 'pinned', _committed: true, _fixed: true,
                        _isTrip: true, _activityLocked: true, _noBacktrack: true
                    });
                    tripBlockCount++;
                });
            });
            if (tripBlockCount > 0) allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin)));

            buildResourceCalendar(_iterSeed);

            // Leagues in stagger order
            const leagueLayers = nonPinnedLayers.filter(l => {
                const grade = l.grade || l.division;
                if (!grade || (allowedSet && !allowedSet.has(String(grade)))) return false;
                const t = (l.type || '').toLowerCase();
                return (t === 'league' || t === 'specialty_league') && l._classification !== 'pinned';
            });
            leagueLayers.sort((a, b) => ((staggerPlan[a.grade || a.division] || {}).offset || 0) - ((staggerPlan[b.grade || b.division] || {}).offset || 0));
            leagueLayers.forEach(layer => placeLeagueForGrade(layer.grade || layer.division, layer));

            // Full-grade non-pinned
            nonPinnedLayers.forEach(layer => {
                const grade = layer.grade || layer.division;
                if (!grade) return;
                const t = (layer.type || '').toLowerCase();
                if (t === 'league' || t === 'specialty_league' || t === 'swim' || t === 'custom') return;
                const isFullGrade = activityProperties[layer.event]?.fullGrade || activityProperties[layer.name]?.fullGrade;
                if (isFullGrade && layer._classification !== 'pinned') placeLeagueForGrade(grade, layer);
            });

            // Phase 1: Shopping lists
            const shoppingLists = {};
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { shoppingLists[bunk] = buildBunkShoppingList(bunk, grade); }));

            // Phase 2: Draft
            const draftResults = runGlobalPlanner(shoppingLists);

            // ★ v4.0: Clear ONLY DRAFT field claims — keep pinned/phase0 claims
            // The draft used temporary times. The packer will re-claim at actual times.
            Object.values(fieldLedger).forEach(ledger => {
                ledger.claims = ledger.claims.filter(c => {
                    // Keep claims from Phase 0 blocks (walls)
                    const bunkTl = bunkTimelines[c.bunk] || [];
                    return bunkTl.some(b => b._fixed && overlaps(b.startMin, b.endMin, c.startMin, c.endMin));
                });
            });

            // Phase 3: Greedy pack in stagger order
            const allTemplates = {};
            const staggeredGrades = [...allGrades].sort((a, b) => ((staggerPlan[a] || {}).offset || 0) - ((staggerPlan[b] || {}).offset || 0));

            todaysSwimmers = {};
            staggeredGrades.forEach(grade => {
                const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
                if (swimLayer) {
                    todaysSwimmers[grade] = new Set(getSwimmersForToday(grade, getBunksForGrade(grade, divisions), swimLayer, _iterSeed).map(String));
                }
            });

            staggeredGrades.forEach(grade => {
                getBunksForGrade(grade, divisions).forEach(bunk => {
                    const swimsToday = todaysSwimmers[grade] ? todaysSwimmers[grade].has(String(bunk)) : true;
                    allTemplates[bunk] = greedyPackBunk(
                        bunk, grade,
                        draftResults[bunk] || { sports: [], specials: [], elective: [], generic: [], usedActivities: new Set() },
                        shoppingLists[bunk], (staggerPlan[grade] || { offset: 0 }).offset, swimsToday
                    );
                });
            });

            // Phase 4: Execute
            executeTemplates(allTemplates);

            // Propagate sport fallbacks
            allGrades.forEach(grade => {
                const pl = shoppingLists[getBunksForGrade(grade, divisions)[0]]?.sports?.priorityList || [];
                const fallbackNames = pl.map(s => s.name);
                if (!fallbackNames.length) return;
                getBunksForGrade(grade, divisions).forEach(bunk => {
                    (bunkTimelines[bunk] || []).forEach(b => {
                        const t = (b.type || '').toLowerCase();
                        if ((t === 'sport' || t === 'slot') && !b._sportFallbacks) b._sportFallbacks = fallbackNames;
                    });
                });
            });

            // Score
            const iterWarnings = [];
            const iterScore = scoreTimelines(bunkTimelines, iterWarnings);
            totalIters++;
            extractFragments(bunkTimelines);

            const improved = iterScore < bestScore;
            if (improved) {
                bestScore = iterScore;
                bestTimelines = {};
                allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bestTimelines[bunk] = bunkTimelines[bunk].map(b => ({ ...b })); }));
                bestWarnings = [...warnings];
                staleCount = 0;
            } else staleCount++;

            if (improved || totalIters <= 3 || totalIters % 10 === 0) {
                log('[ITER ' + totalIters + '] score=' + iterScore + (improved ? ' ★ BEST' : '') + ' | best=' + bestScore + ' | stale=' + staleCount);
            }

            if (bestScore > 0 && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS) { _iterSeed++; warnings.length = 0; resetIterState(); }

        } while (bestScore > 0 && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS);

        log('══════════════════════════════════════════════════════════');
        log('BEST: ' + bestScore + ' after ' + totalIters + ' iterations');
        log('══════════════════════════════════════════════════════════');

        // Restore best
        allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = bestTimelines[bunk] || []; }));
        warnings.length = 0;
        bestWarnings.forEach(w => warnings.push(w));

        // Debug exports
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
                for (let i = 0; i < tl.length - 1; i++) {
                    if (tl[i].endMin > tl[i + 1].startMin) {
                        err('[2.6] OVERLAP ' + bunk);
                        validationPassed = false;
                        warnings.push({ type: 'overlap', bunk, grade });
                    }
                }
                tl.forEach(b => { if (b.startMin == null || b.endMin == null || b.endMin <= b.startMin) validationPassed = false; });
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
                        _specialLocation: block._specialLocation || null,
                        _draftActivity: block._draftActivity || null, _draftField: block._draftField || null
                    });
                });
            });
        });

        window.manualSkeleton = autoSkeleton;
        window._autoSkeleton = autoSkeleton;

        // Build divisionTimes
        if (window.DivisionTimesSystem) {
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(autoSkeleton, divisions);
            allGrades.forEach(grade => {
                const ds = window.divisionTimes[grade];
                if (!ds) return;
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
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = (pbs && pbs[String(bunk)]) || [];
                window.scheduleAssignments[String(bunk)] = new Array(arr.length).fill(null);
            });
        });

        // Write special blocks
        let specialWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b => b.type === 'special' && b._assignedSpecial).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1) return;
                    const fn = block._specialLocation || block._assignedSpecial;
                    window.scheduleAssignments[String(bunk)][idx] = {
                        field: fn, sport: null, _activity: block._assignedSpecial,
                        _fixed: true, _bunkOverride: true, _activityLocked: true,
                        _autoSpecial: true, _autoMode: true, continuation: false
                    };
                    registerSpecialFieldUsage([idx], fn, String(bunk), block._assignedSpecial, grade, fieldUsageBySlot);
                    // ★ v4.0: Write to BOTH lock systems — AutoFieldLocks for the solver,
                    // GlobalFieldLocks for downstream code (fillers, post-edit, canBlockFit)
                    if (fn && window.AutoFieldLocks) {
                        window.AutoFieldLocks.lockField(fn, block.startMin, block.endMin, grade, block._assignedSpecial, 'auto_special');
                    }
                    if (fn && window.GlobalFieldLocks) {
                        window.GlobalFieldLocks.lockField(fn, [idx], { lockedBy: 'auto_special', division: grade, activity: block._assignedSpecial, startMin: block.startMin, endMin: block.endMin });
                    }
                    specialWriteCount++;
                });
            });
        });

        // Write pinned + custom blocks
        let pinnedWriteCount = 0, customWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1 || window.scheduleAssignments[String(bunk)][idx]) return;

                    const isCustom = (block.type || '').toLowerCase() === 'custom' && block._customField;
                    if (block._fixed || block._classification === 'pinned' || isCustom) {
                        window.scheduleAssignments[String(bunk)][idx] = {
                            field: isCustom ? block._customField : block.event,
                            sport: null,
                            _activity: isCustom ? (block._customActivity || block.event) : block.event,
                            _fixed: true, _pinned: block._classification === 'pinned',
                            _bunkOverride: true, _activityLocked: isCustom || false,
                            _customActivity: block._customActivity || null,
                            _customField: block._customField || null,
                            _autoMode: true, continuation: false
                        };
                        if (isCustom) {
                            customWriteCount++;
                            if (block._customField) {
                                if (window.AutoFieldLocks) {
                                    window.AutoFieldLocks.lockField(block._customField, block.startMin, block.endMin, grade, block._customActivity || 'Custom', 'auto_custom');
                                }
                                if (window.GlobalFieldLocks) {
                                    window.GlobalFieldLocks.lockField(block._customField, [idx], { lockedBy: 'auto_custom', division: grade, activity: block._customActivity || 'Custom', startMin: block.startMin, endMin: block.endMin });
                                }
                            }
                        } else pinnedWriteCount++;
                    }
                });
            });
        });

        // Write capacity-checked sport blocks
        let sportWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b =>
                    (b.type === 'sport' || b.type === 'slot') && b._source === 'capacity_checked' && b._assignedSport && b.field
                ).forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1 || !window.scheduleAssignments[String(bunk)] || window.scheduleAssignments[String(bunk)][idx]) return;
                    window.scheduleAssignments[String(bunk)][idx] = {
                        field: block.field, sport: block._assignedSport,
                        _activity: block._assignedSport, _fixed: true, _bunkOverride: true,
                        _activityLocked: false, _autoMode: true, _capacityChecked: true, continuation: false
                    };
                    if (!fieldUsageBySlot[idx]) fieldUsageBySlot[idx] = {};
                    if (!fieldUsageBySlot[idx][block.field]) fieldUsageBySlot[idx][block.field] = { count: 0, bunks: {} };
                    fieldUsageBySlot[idx][block.field].count++;
                    fieldUsageBySlot[idx][block.field].bunks[String(bunk)] = block._assignedSport;
                    sportWriteCount++;
                });
            });
        });

        // Write anchor blocks (swim, snacks, etc.)
        let anchorWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            if (!pbs) return;
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

        window._divisionTimesLocked = true;
        window._autoDivisionTimesBuilt = true;
        window._preGenClearActive = false;

        log('[2.7] ✅ ' + specialWriteCount + ' specials, ' + pinnedWriteCount + ' pinned, ' + sportWriteCount + ' sports, ' + anchorWriteCount + ' anchors, ' + customWriteCount + ' custom');

        // ★ v4.0: Sync auto locks → GlobalFieldLocks so downstream code (fillers, post-edit, canBlockFit) sees them
        if (window.AutoFieldLocks?.syncToGlobalFieldLocks) {
            window.AutoFieldLocks.syncToGlobalFieldLocks();
        }

        // Build schedulable blocks for solver
        const schedulableSlotBlocks = [];
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                arr.forEach((block, idx) => {
                    if ((block._classification || block.type || '') === 'pinned') return;
                    if ((block.type || '') === 'special') return;
                    if (block._activityLocked) return;
                    const ex = window.scheduleAssignments[String(bunk)][idx];
                    if (ex && ex._fixed) return;
                    if (ex && ex.field === 'Free' && !ex._fixed) window.scheduleAssignments[String(bunk)][idx] = null;
                    const skipTypes = ['swim', 'snacks', 'lunch', 'dismissal', 'pinned', 'league', 'specialty_league'];
                    if (skipTypes.includes((block.type || '').toLowerCase())) return;

                    const timelineBlock = (bunkTimelines[bunk] || []).find(b => b.startMin === block.startMin && b.endMin === block.endMin);
                    schedulableSlotBlocks.push({
                        divName: grade, bunk: String(bunk),
                        event: 'General Activity Slot', type: 'slot',
                        startTime: minutesToTimeLabel(block.startMin), endTime: minutesToTimeLabel(block.endMin),
                        slots: [idx], _durationStrict: false, _autoGenerated: true,
                        _draftActivity: timelineBlock?._draftActivity || null,
                        _draftField: timelineBlock?._draftField || null,
                        _fromGapDetection: block._fromGapDetection || false,
                        _perBunkSlot: true
                    });
                });
            });
        });


        // =====================================================================
        // STEP 3 — LEAGUE ENGINES
        // =====================================================================
        log('\n[STEP 3] League engines...');
        const yesterdayHistory = (() => {
            const parts = (currentDate || '').split('-').map(Number);
            if (!parts[0]) return {};
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            d.setDate(d.getDate() - 1);
            const yk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            return allDailyData[yk]?.scheduleAssignments || {};
        })();

        const leagueBlocks = (() => {
            const seen = new Set();
            return autoSkeleton.filter(b => {
                if (b.type !== 'league' && b.type !== 'specialty_league') return false;
                const k = b.division + '_' + b.startMin;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            }).map(b => ({
                divName: b.division, bunk: String(b._bunk || ''),
                event: b.type === 'league' ? 'League Game' : 'Specialty League',
                type: b.type, startTime: b.startTime, endTime: b.endTime,
                startMin: b.startMin, endMin: b.endMin,
               slots: (() => {
                    const dt = window.divisionTimes?.[b.division];
                    // ★ FIX: Use per-bunk slots in auto mode — division-level slots don't cover all times
                    if (dt?._perBunkSlots) {
                        const anyBunk = Object.keys(dt._perBunkSlots)[0];
                        const bunkSlots = dt._perBunkSlots[anyBunk] || [];
                        const idx = bunkSlots.findIndex(s => s.startMin === b.startMin);
                        if (idx >= 0) return [idx];
                    }
                    if (!Array.isArray(dt)) return [];
                    const idx = dt.findIndex(s => s.startMin === b.startMin);
                    return idx >= 0 ? [idx] : [];
                })(),                _autoGenerated: true
            }));
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
                disabledFields: globalSettings.app1?.disabledFields || [],
                leagueAssignments: window.leagueAssignments,
                storeLeagueMatchups: function(divName, slots, matchups, gameLabel, sport, leagueName) {
                    const league = mla.find(l => l.name === leagueName);
                    const covDivs = (league?.divisions || [leagueName]).filter(d => autoSkeleton.some(b => b.division === d && b.type === 'league'));
                    (covDivs.length > 0 ? covDivs : [divName]).forEach(div => {
                        const lb = autoSkeleton.find(b => b.division === div && b.type === 'league');
                        if (!lb) return;
                        if (!window.leagueAssignments[div]) window.leagueAssignments[div] = {};
                        window.leagueAssignments[div][lb.startMin] = { matchups: matchups || [], gameLabel: gameLabel || '', sport: sport || '', leagueName: leagueName || '' };
                    });
                }
            };
            if (window.SchedulerCoreSpecialtyLeagues?.processSpecialtyLeagues) { try { lctx.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'specialty_league'); window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(lctx); } catch (e) { warn('[3] Specialty: ' + e.message); } }
            if (window.SchedulerCoreLeagues?.processRegularLeagues) { try { lctx.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'league'); window.SchedulerCoreLeagues.processRegularLeagues(lctx); } catch (e) { warn('[3] Regular: ' + e.message); } }

            let leagueWriteCount = 0;
            Object.entries(window.leagueAssignments || {}).forEach(([gn, gs]) => {
                const lsb = autoSkeleton.find(b => b.division === gn && b.type === 'league');
                if (!lsb) return;
                const asgn = Object.values(gs)[0];
                if (!asgn) return;
                const pbs = window.divisionTimes?.[gn]?._perBunkSlots;
                if (!pbs) return;
                Object.entries(pbs).forEach(([bk, bs]) => {
                    const fi = bs.findIndex(s => s.startMin === lsb.startMin);
                    if (fi === -1 || !window.scheduleAssignments[bk]) return;
                    window.scheduleAssignments[bk][fi] = {
                        field: asgn.sport || 'League Game', sport: asgn.sport || null,
                        _activity: 'League Game', _league: true, _leagueName: asgn.leagueName || '',
                        _gameLabel: asgn.gameLabel || '', matchups: asgn.matchups || [],
                        _fixed: true, continuation: false
                    };
                    leagueWriteCount++;
                });
            });
            log('[3] Wrote ' + leagueWriteCount + ' league slots');
        }

        const solverBlocks = schedulableSlotBlocks.filter(b => b.type !== 'league' && b.type !== 'specialty_league');
        log('[3] ✅ ' + solverBlocks.length + ' blocks for solver');


        // =====================================================================
        // STEP 4 — AUTO SOLVER (sport slots only, no specials)
        // ★ v4.0: Uses AutoSolverEngine (purpose-built for auto mode).
        //   Falls back to TotalSolverEngine if AutoSolverEngine isn't loaded.
        // =====================================================================
        log('\n[STEP 4] Solving remaining sport slots...');

        // ★ FIX: Ensure activityProperties is populated from stored fields before solving
        if (window.refreshActivityPropertiesFromFields && (!window.activityProperties || Object.keys(window.activityProperties).length === 0)) {
            window.refreshActivityPropertiesFromFields();
            log('[4] Refreshed activityProperties: ' + Object.keys(window.activityProperties).length + ' entries');
        }

        // Prepare config for the solver
        const solverConfig = (() => {
            const gs = getGlobalSettings();
           const masterFields = gs.app1?.fields || gs.fields || window.fields || [];
                // ★ Normalize sharing types before passing to solver
                masterFields.forEach(f => {
                    if (!f.sharableWith) return;
                    if (f.sharableWith.type === 'custom' && (!Array.isArray(f.sharableWith.divisions) || f.sharableWith.divisions.length === 0)) {
                        f.sharableWith.type = 'same_division';
                    }
                    if (f.sharableWith.type === 'all') f.sharableWith.type = 'same_division';
                    if (f.sharableWith.type === 'same_division' && (!f.sharableWith.capacity || parseInt(f.sharableWith.capacity) < 2)) {
                        f.sharableWith.capacity = 2;
                    }
                });
            masterFields.forEach(f => {
    if (f.sharableWith) {
        if (f.sharableWith.type === 'custom' && (!Array.isArray(f.sharableWith.divisions) || f.sharableWith.divisions.length === 0)) {
            f.sharableWith.type = 'same_division';
        }
        if (f.sharableWith.type === 'all') f.sharableWith.type = 'same_division';
    }
});
            const masterSpecials = gs.app1?.specialActivities || gs.specialActivities || [];

            // Build fieldsBySport map
            const fbs = {};
            masterFields.forEach(f => { (f.activities || []).forEach(a => { if (!fbs[a]) fbs[a] = []; fbs[a].push(f.name); }); });
            window.fieldsBySport = fbs;

            return {
                activityProperties: window.activityProperties || {},
                masterFields,
                masterSpecials,
                divisions,
                fieldsBySport: fbs,
                disabledFields: gs.app1?.disabledFields || [],
                dateStr: currentDate || '',
                yesterdayHistory,
                isRainy,
                rotationHistory: (window.loadRotationHistory?.() || {}).bunks || window.loadRotationHistory?.() || {},
                _autoMode: true
            };
        })();

        // Clear non-fixed assignments before solving
        Object.keys(window.scheduleAssignments).forEach(bk => {
            (window.scheduleAssignments[bk] || []).forEach((s, i) => {
                if (s && !s._fixed && !s._league && !s._autoSpecial) window.scheduleAssignments[bk][i] = null;
            });
        });
        window.fieldUsageBySlot = window.buildFieldUsageBySlot ? window.buildFieldUsageBySlot() : {};

        // Build solver input blocks
        const solverInputBlocks = solverBlocks.map(b => ({
            bunk: b.bunk, divName: b.divName, slots: b.slots,
            startTime: b.startTime, endTime: b.endTime,
            type: b.type || 'slot', event: b.event || 'General Activity Slot',
            _autoGenerated: true, _autoMode: true,
            _draftActivity: b._draftActivity, _draftField: b._draftField
        }));

        if (window.AutoSolverEngine && typeof window.AutoSolverEngine.solve === 'function') {
            // ★ PRIMARY: Auto Solver Engine — purpose-built for auto mode
            try {
                const result = window.AutoSolverEngine.solve(solverInputBlocks, solverConfig);
                log('[4] ✅ AutoSolver: ' + result.filled + ' filled, ' + result.free + ' Free');

                // Run fallback sweep for remaining Free blocks
                if (result.free > 0) {
                    const fallbackFilled = window.AutoSolverEngine.fallbackSweep(solverConfig);
                    if (fallbackFilled > 0) log('[4] Fallback sweep filled ' + fallbackFilled + ' more');
                }
            } catch (e) {
                err('[4] AutoSolver error: ' + e.message);
                console.error(e);
                warnings.push({ type: 'solver_error', message: e.message });
            }
        } else {
            // ★ FALLBACK: TotalSolverEngine (manual solver with clean AP swap)
            const Solver = window.TotalSolverEngine || window.TotalSolver || window.totalSolverEngine;
            if (Solver && typeof Solver.solveSchedule === 'function') {
                try {
                    const masterSpecials = solverConfig.masterSpecials || [];
                    // Strip specials from AP so manual solver doesn't assign them
                    const strippedAP = {};
                    Object.entries(window.activityProperties || {}).forEach(([k, v]) => {
                        if (!masterSpecials.some(s => s.name === k)) strippedAP[k] = v;
                    });
                    const savedAP = window.activityProperties;
                    window.activityProperties = strippedAP;

                    Solver.solveSchedule(solverInputBlocks, {
                        ...solverConfig,
                        activityProperties: strippedAP,
                        masterSpecials: []
                    });

                    window.activityProperties = savedAP;

                    let filled = 0;
                    solverInputBlocks.forEach(b => {
                        const s = (window.scheduleAssignments?.[b.bunk] || [])[b.slots?.[0]];
                        if (s && !s._league && !s._fixed) filled++;
                    });
                    log('[4] ✅ Fallback TotalSolver filled ~' + filled + ' slots');
                } catch (e) {
                    err('[4] TotalSolver fallback: ' + e.message);
                    console.error(e);
                    warnings.push({ type: 'solver_error', message: e.message });
                }
            } else { warn('[4] No solver loaded'); }
        }


        // =====================================================================

        // =====================================================================
        // STEP 4.5 — POST-SOLVE CONSTRAINT ENFORCEMENT (LOOPED)
        // =====================================================================
        // Repeatedly scans the schedule for violations and demotes offenders
        // until clean. THEN runs fallback sweep, THEN validates once more.
        // Catches: cross-division, capacity, same-day repeats.
        // Ignores: custom, game X (league fields), immutable entries.
        // =====================================================================
        log('\n[STEP 4.5] Post-solve constraint enforcement...');

       const postSolveAP = window.activityProperties || {};
        const postSolveSA = window.scheduleAssignments || {};
        const postSolveDT = window.divisionTimes || {};

        // ★ Normalize sharing types in activityProperties for constraint checks
        // 'custom' with empty divisions and 'all' are orphaned states → treat as same_division
        Object.values(postSolveAP).forEach(props => {
            if (!props.sharableWith) return;
            const sw = props.sharableWith;
            if (sw.type === 'custom' && (!Array.isArray(sw.divisions) || sw.divisions.length === 0)) {
                sw.type = 'same_division';
            }
            if (sw.type === 'all') sw.type = 'same_division';
            if (sw.type === 'same_division' && (!sw.capacity || parseInt(sw.capacity) < 2)) {
                sw.capacity = 2;
            }
        });
        const CSWEEP_IGNORE_FIELDS = new Set(['free', 'no field', 'lunch', 'snacks', 'dismissal', 'swim', 'pool', 'custom']);
        const isLeagueField = (fn) => /^game\s*\d+$/i.test(fn);
        const CSWEEP_IGNORE_ACTS = new Set(['free', 'lunch', 'snacks', 'dismissal', 'swim', 'pool', 'league game']);

        // ── Bunk→grade lookup ──
        const csweepBunkGrade = {};
        Object.entries(divisions).forEach(([g, d]) => {
            (d.bunks || []).forEach(b => { csweepBunkGrade[String(b)] = g; });
        });

        function runConstraintSweep() {
            let fixes = 0;

            // ── Build time-keyed field usage map ──
            const fieldMap = new Map();
            let totalIndexed = 0;
            Object.entries(postSolveSA).forEach(([bunk, slots]) => {
                if (!Array.isArray(slots)) return;
                const grade = csweepBunkGrade[bunk] || '';
                const pbs = postSolveDT[grade]?._perBunkSlots?.[bunk] || [];
                if (pbs.length === 0 && slots.some(e => e && e.field && e.field !== 'Free')) {
                    console.warn('[4.5-DBG] Bunk ' + bunk + ' (' + grade + '): has assignments but 0 perBunkSlots — CANNOT CHECK');
                }
                slots.forEach((entry, idx) => {
                    if (!entry || !entry.field || entry.field === 'Free') return;
                    if (entry.continuation || entry._league) return;
                    const fn = entry.field.toLowerCase().trim();
                    if (CSWEEP_IGNORE_FIELDS.has(fn) || isLeagueField(fn)) return;
                    const slot = pbs[idx];
                    if (!slot || slot.startMin == null || slot.endMin == null) return;
                    if (!fieldMap.has(fn)) fieldMap.set(fn, []);
                    fieldMap.get(fn).push({ startMin: slot.startMin, endMin: slot.endMin, bunk, grade, idx, field: entry.field });
                    totalIndexed++;
                });
            });
            console.log('[4.5-DBG] Indexed ' + totalIndexed + ' entries across ' + fieldMap.size + ' fields');
            // Targeted dump for fields the validator flags but sweep misses
            ['outdoor court', 'field e', 'field d'].forEach(fname => {
                const entries = fieldMap.get(fname);
                if (entries && entries.length > 0) {
                    const detail = entries.map(e => e.bunk + '(' + e.grade + ')s' + e.idx + '@' + e.startMin + '-' + e.endMin).join(' | ');
                    console.log('[4.5-DUMP] "' + fname + '": ' + entries.length + ' entries → ' + detail);
                } else {
                    console.warn('[4.5-DUMP] "' + fname + '": NOT IN FIELDMAP');
                }
            });

           // ── Build field sharing lookup from globalSettings (authoritative source) ──
            const _csweepGS = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            const _csweepFields = _csweepGS.app1?.fields || _csweepGS.fields || [];
            const _csweepFieldMap = new Map();
            _csweepFields.forEach(f => {
                if (!f.name) return;
                const sw = f.sharableWith || {};
                let type = sw.type || 'not_sharable';
                const divs = Array.isArray(sw.divisions) ? sw.divisions : [];
                // Normalize orphaned types
                if (type === 'custom' && divs.length === 0) type = 'same_division';
                if (type === 'all') type = 'same_division';
                _csweepFieldMap.set(f.name.toLowerCase().trim(), {
                    type,
                    capacity: parseInt(sw.capacity) || (type === 'not_sharable' ? 1 : 2),
                    divisions: divs
                });
            });

        // ── A) Cross-division + capacity enforcement ──
            fieldMap.forEach((usages, fieldNorm) => {
                const fieldSharing = _csweepFieldMap.get(fieldNorm) || {};
                const shareType = fieldSharing.type || 'not_sharable';
                const cap = fieldSharing.capacity || (shareType === 'not_sharable' ? 1 : 2);
                for (let i = 0; i < usages.length; i++) {
                    const u = usages[i];
                    const sa = postSolveSA[u.bunk]?.[u.idx];
                    if (!sa || sa.field === 'Free') continue;
                    if (sa._pinned || sa._league || sa._autoSpecial) continue;

                    const overlapping = usages.filter((o, j) =>
                        j !== i && o.bunk !== u.bunk &&
                        o.startMin < u.endMin && o.endMin > u.startMin &&
                        postSolveSA[o.bunk]?.[o.idx]?.field !== 'Free'
                    );

                    let violation = false;
                    if (overlapping.length >= cap) violation = true;
                    if (!violation && (shareType === 'not_sharable' || shareType === 'same_division') &&
                        overlapping.some(o => o.grade !== u.grade)) violation = true;
                   if (!violation && shareType === 'custom') {
                        const allowed = fieldSharing.divisions || [];
                        if (allowed.length > 0) {
                            if (overlapping.some(o => o.grade !== u.grade && !allowed.includes(o.grade))) violation = true;
                            if (!violation && overlapping.length > 0 && !allowed.includes(u.grade)) violation = true;
                        } else {
                            // Empty allowed list = treat as same_division
                            if (overlapping.some(o => o.grade !== u.grade)) violation = true;
                        }
                    }
                    if (violation) {
                        console.log('[4.5-VIOLATION] ' + fieldNorm + ': bunk ' + u.bunk + ' (' + u.grade + ') @ ' + u.startMin + '-' + u.endMin +
                            ' | shareType=' + shareType + ' cap=' + cap +
                            ' | overlaps=' + overlapping.map(o => o.bunk + '(' + o.grade + ')@' + o.startMin + '-' + o.endMin).join(', ') +
                            ' | sa._fixed=' + !!sa._fixed + ' _pinned=' + !!sa._pinned + ' _league=' + !!sa._league + ' _autoSpecial=' + !!sa._autoSpecial);
                        postSolveSA[u.bunk][u.idx] = {
                            field: 'Free', sport: null, _activity: 'Free',
                            _autoMode: true, _constraintDemoted: true, continuation: false
                        };
                        fixes++;
                    }
                }
            });

            // ── B) Same-day repetition enforcement ──
            Object.entries(postSolveSA).forEach(([bunk, slots]) => {
                if (!Array.isArray(slots)) return;
                const seenActs = new Map();
                slots.forEach((entry, idx) => {
                    if (!entry || entry.field === 'Free' || entry.continuation) return;
                    if (entry._pinned || entry._league || entry._autoSpecial) return;
                    const act = (entry._activity || entry.sport || entry.field || '').toLowerCase().trim();
                    if (!act || CSWEEP_IGNORE_ACTS.has(act)) return;
                    if (seenActs.has(act)) {
                        postSolveSA[bunk][idx] = {
                            field: 'Free', sport: null, _activity: 'Free',
                            _autoMode: true, _constraintDemoted: true,
                            _demotedReason: 'same_day_repeat', continuation: false
                        };
                        fixes++;
                    } else {
                        seenActs.set(act, idx);
                    }
                });
            });

            return fixes;
        }

        // ── Loop until clean ──
        let totalConstraintFixes = 0;
        let sweepPass = 0;
        while (sweepPass < 5) {
            sweepPass++;
            const fixes = runConstraintSweep();
            totalConstraintFixes += fixes;
            if (fixes === 0) break;
            log('[4.5] Pass ' + sweepPass + ': demoted ' + fixes);
        }

        // ── Re-fill demoted slots ──
        if (totalConstraintFixes > 0 && window.AutoSolverEngine?.fallbackSweep) {
            const refilled = window.AutoSolverEngine.fallbackSweep(solverConfig);
            if (refilled > 0) log('[4.5] Re-filled ' + refilled + ' demoted slots');
            // Final validation after fallback
            const postFallbackFixes = runConstraintSweep();
            totalConstraintFixes += postFallbackFixes;
            if (postFallbackFixes > 0) log('[4.5] Post-fallback: demoted ' + postFallbackFixes + ' more');
        }

        if (totalConstraintFixes > 0) {
            log('[4.5] Total constraint fixes: ' + totalConstraintFixes);
            warnings.push({ type: 'constraint_demotions', count: totalConstraintFixes });
        } else {
            log('[4.5] ✅ No violations');
        }

        // STEP 5 — SAVE
        // =====================================================================
        saveSwimHistory();
        log('\n[STEP 5] Saving...');
        if (window.saveCurrentDailyData) {
            try {
                // ★ v4.0: Strip Free entries and internal flags to reduce size
                const clean = {};
                Object.entries(window.scheduleAssignments || {}).forEach(([b, s]) => {
                    clean[b] = (s || []).map(x => {
                        if (!x || (x.field === 'Free' && !x._fixed)) return null;
                        // Strip internal flags that aren't needed for reload
                        const { _autoSolved, _capacityChecked, _source, _sportFallbacks, ...keep } = x;
                        return keep;
                    });
                });

                const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                const DAILY_KEY = 'campDailyData_v1';
                const allDaily = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                if (!allDaily[dateKey]) allDaily[dateKey] = {};

                // ★ v4.0: DON'T write _perBunkSlotsData or full divisionTimes to localStorage
                // They're huge (37 bunks × N slots) and can be rebuilt from manualSkeleton.
                // The load path in division_times_integration.js already handles this rebuild.
                Object.assign(allDaily[dateKey], {
                    scheduleAssignments: clean,
                    leagueAssignments: window.leagueAssignments || {},
                    manualSkeleton: autoSkeleton,
                    _autoGenerated: true, _autoVersion: VERSION,
                    _generatedAt: new Date().toISOString(),
                    _rebuildPerBunkSlots: true  // flag tells load path to rebuild from skeleton
                });

                // ★ v4.0: Progressive save — try full, then trim old dates on quota error
                try {
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allDaily));
                } catch (quotaErr) {
                    if (quotaErr.name === 'QuotaExceededError') {
                        warn('[5] localStorage quota hit — trimming old dates...');
                        // Remove dates older than 2 weeks
                        const twoWeeksAgo = new Date();
                        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
                        const cutoff = twoWeeksAgo.toISOString().split('T')[0];
                        let trimmed = 0;
                        Object.keys(allDaily).forEach(dk => {
                            if (dk < cutoff) { delete allDaily[dk]; trimmed++; }
                        });
                        if (trimmed > 0) log('[5] Trimmed ' + trimmed + ' old date(s)');
                        try {
                            localStorage.setItem(DAILY_KEY, JSON.stringify(allDaily));
                        } catch (e2) {
                            // Still too big — save ONLY today's data
                            warn('[5] Still over quota — saving only today');
                            const todayOnly = { [dateKey]: allDaily[dateKey] };
                            try { localStorage.setItem(DAILY_KEY, JSON.stringify(todayOnly)); }
                            catch (e3) { err('[5] Cannot save to localStorage at all: ' + e3.message); }
                        }
                    } else throw quotaErr;
                }

                // Cloud save gets the FULL data including _perBunkSlotsData (no quota limit)
                if (typeof window.saveGlobalSettings === 'function') {
                    const spbs = {};
                    Object.keys(window.divisionTimes || {}).forEach(g => {
                        if (window.divisionTimes[g]?._perBunkSlots) spbs[g] = window.divisionTimes[g]._perBunkSlots;
                    });
                    allDaily[dateKey]._perBunkSlotsData = spbs;
                    allDaily[dateKey].divisionTimes = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes || {};
                    window.saveGlobalSettings('daily_schedules', allDaily);
                }
                log('[5] Saved');
            } catch (e) { warn('[5] Save error: ' + e.message); }
        }
        if (window.SupabaseSyncEngine?.pushSchedule) {
            try { await window.SupabaseSyncEngine.pushSchedule(window.scheduleAssignments, window.currentScheduleDate || window.currentDate); log('[5] Synced'); }
            catch (e) { warn('[5] Sync: ' + e.message); }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        log('\n═══════════════════════════════════════════════════════════');
        log('COMPLETE in ' + elapsed + 's | Warnings: ' + warnings.length);
        warnings.forEach((w, i) => log('  ' + (i + 1) + '. [' + w.type + '] ' + (w.message || JSON.stringify(w))));
        log('═══════════════════════════════════════════════════════════');

        window.dispatchEvent(new CustomEvent('campistry-generation-complete', { detail: { mode: 'auto', version: VERSION, elapsed, warnings } }));


        // =====================================================================
        // POST-GEN DIAGNOSTICS (callable, not inline)
        // =====================================================================

        window._freeBlockReport = function() {
            const sa = window.scheduleAssignments || {};
            const dt = window.divisionTimes || {};
            let freeCount = 0;
            const freeByGrade = {};
            Object.entries(sa).forEach(([bunk, slots]) => {
                const grade = Object.entries(divisions).find(([g, d]) => (d.bunks || []).map(String).includes(String(bunk)))?.[0];
                (slots || []).forEach((s, i) => {
                    if (s && s.field === 'Free') {
                        freeCount++;
                        if (!freeByGrade[grade]) freeByGrade[grade] = [];
                        const pbs = dt[grade]?._perBunkSlots?.[bunk]?.[i];
                        freeByGrade[grade].push({ bunk, idx: i, time: pbs ? pbs.startMin + '-' + pbs.endMin : '?' });
                    }
                });
            });
            console.log('%c═══ FREE BLOCK REPORT ═══', 'color:#C62828;font-weight:bold');
            console.log('Total Free: ' + freeCount);
            Object.entries(freeByGrade).forEach(([g, blocks]) => {
                console.log('\n' + g + ': ' + blocks.length + ' Free');
                blocks.forEach(b => console.log('  Bunk ' + b.bunk + ' slot ' + b.idx + ' @ ' + b.time));
            });
        };

        window._swimReport = function() {
            console.log('%c═══ SWIM REPORT ═══', 'color:#1565C0;font-weight:bold');
            allGrades.forEach(grade => {
                const bunks = getBunksForGrade(grade, divisions);
                const swimmers = todaysSwimmers?.[grade] || new Set();
                console.log(grade + ': ' + swimmers.size + '/' + bunks.length + ' bunks swim today — ' + [...swimmers].join(', '));
            });
        };

        window._rotationReport = function() {
            console.log('%c═══ ROTATION MATRIX REPORT ═══', 'color:#6A1B9A;font-weight:bold');
            console.log('Off-field types are staggered. Sport fills remaining time (not in matrix).');
            console.log('Goal: minimize grades competing for fields simultaneously.\n');
            allGrades.forEach(grade => {
                const p = staggerPlan[grade] || {};
                const seq = (p.sequence || []).join(', ') || '(none)';
                const bands = Object.entries(p.typeBands || {})
                    .sort((a, b) => a[1].start - b[1].start)
                    .map(([t, b]) => '  ' + t.padEnd(8) + ' ' + minutesToTimeLabel(b.start) + ' – ' + minutesToTimeLabel(b.end))
                    .join('\n');
                console.log(grade + ': off-field=[' + seq + ']');
                if (bands) console.log(bands);
                else console.log('  (all sport — no off-field types)');
            });
            // Time-slice analysis with field contention count
            console.log('\n%cTime-slice analysis (⚽=on fields, 🏊=off-field):', 'font-weight:bold');
            const campStart = Math.min(...allGrades.map(g => parseTimeToMinutes(divisions[g]?.startTime) || 540));
            const campEnd = Math.max(...allGrades.map(g => parseTimeToMinutes(divisions[g]?.endTime) || 960));
            for (let t = campStart; t < campEnd; t += 30) {
                let onFields = 0;
                const doing = allGrades.map(grade => {
                    const gs = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    const ge = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                    if (t < gs || t >= ge) return null;
                    const p = staggerPlan[grade] || {};
                    const tb = p.typeBands || {};
                    for (const [type, band] of Object.entries(tb)) {
                        if (t >= band.start && t < band.end) return grade.replace(' Grade','') + '=' + type;
                    }
                    onFields++;
                    return grade.replace(' Grade','') + '=⚽';
                }).filter(Boolean).join(', ');
                const total = allGrades.filter(g => { const gs = parseTimeToMinutes(divisions[g]?.startTime) || 540; const ge = parseTimeToMinutes(divisions[g]?.endTime) || 960; return t >= gs && t < ge; }).length;
                console.log('  ' + minutesToTimeLabel(t) + ': ' + doing + '  [' + onFields + '/' + total + ' on fields]');
            }
        };

        return { success: true, warnings, elapsed, blocksScheduled: solverBlocks.length, specialBlocksLocked: specialWriteCount };
    };

    log('scheduler_core_auto.js v' + VERSION + ' loaded — WHAT→WHEN→WHERE');
})();
