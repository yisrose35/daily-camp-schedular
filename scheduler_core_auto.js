
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
        // ★ v7.0: Filter out daily-disabled specials from resource overrides
        const dailyDisabledSpecials = (dailyData?.overrides?.disabledSpecials) || [];
        const todaysSpecials = allSpecials.filter(s => {
            if (!isSpecialAvailableOnDay(s.name, dayName, isRainy, globalSettings)) return false;
            if (dailyDisabledSpecials.includes(s.name)) return false;
            return true;
        });
        const scarceSpecials = todaysSpecials.filter(s => isScarce(s.name, dayName, globalSettings));
        log('[STEP 1] Specials: ' + todaysSpecials.length + ' (' + scarceSpecials.length + ' scarce)' + (dailyDisabledSpecials.length ? ' | disabled: ' + dailyDisabledSpecials.join(', ') : ''));

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

            // ★ v10.5: Fix rawMax — durationMax must NOT fall back to periodMin (that's a minimum).
            // Fallback chain: explicit max → explicit duration (locks both) → type ceiling.
            const rawMin = layer.durationMin || layer.periodMin || layer.duration || 0;
            const rawMax = layer.durationMax || layer.duration || 0;
            const ABSOLUTE_FLOOR = 5;
            let dMin = rawMin > 0 ? Math.max(ABSOLUTE_FLOOR, rawMin) : typeFloor;
            let dMax = rawMax > 0 ? Math.max(dMin, Math.max(ABSOLUTE_FLOOR, rawMax)) : Math.max(dMin, typeCeiling);

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

            // ★ v11.6: Window is the hard constraint — if the layer's time window
            // is smaller than dMin, clamp dMin/dMax to fit the window.
            // A 30-min activity in a 20-min window must become 20 min.
            if (layer && layer.startMin != null && layer.endMin != null) {
                const windowSize = layer.endMin - layer.startMin;
                if (windowSize > 0 && windowSize < dMin) {
                    dMin = Math.max(ABSOLUTE_FLOOR, windowSize);
                    dMax = Math.max(dMin, Math.min(dMax, windowSize));
                }
                if (windowSize > 0 && dMax > windowSize) {
                    dMax = windowSize;
                }
            }

            // ★ v10.5: Invariant — dMax must never be less than dMin
            if (dMax < dMin) dMax = dMin;

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

        // ── Rotation event concurrency tracking ─────────────────────
        // Rotation events work like activities: concurrency is PER GRADE,
        // no cross-division mixing. If concurrency=2, at any 10-min slot
        // only 2 bunks from the SAME grade can be there. A different grade
        // must wait until that slot is free. Uses the same rtRegister/rtCanUse
        // infrastructure as pool & specials — gets exact-time-match enforcement
        // for free (all bunks sharing a slot must start/end at the same time).

        function registerRotationEventUsage(eventId, grade, startMin, endMin) {
            if (!eventId) return;
            rtRegister('rotevt', eventId, grade, startMin, endMin);
        }

        function canUseRotationSlotAtTime(eventId, concurrency, grade, startMin, endMin) {
            if (!eventId || !concurrency) return true;
            // not_sharable = only same-grade bunks can share the slot
            return rtCanUse('rotevt', eventId, grade, startMin, endMin,
                'not_sharable', concurrency, []);
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
            const baseDisabled = globalSettings.app1?.disabledFields || globalSettings.disabledFields || [];
            // ★ v7.0: Read daily disabled fields from ALL sources (not just window.currentDisabledFields)
            let dailyDisabledFromOverrides = [];
            const ovNested = dailyData?.overrides || {};
            if (ovNested.disabledFields?.length) {
                dailyDisabledFromOverrides = ovNested.disabledFields;
            } else {
                // Fallback: dedicated localStorage key
                try {
                    const dateKey = window.currentScheduleDate || '';
                    const stored = localStorage.getItem('campResourceOverrides_' + dateKey);
                    if (stored) {
                        const parsed = JSON.parse(stored);
                        if (parsed?.overrides?.disabledFields?.length) dailyDisabledFromOverrides = parsed.overrides.disabledFields;
                    }
                } catch(e) {}
            }
            const dailyDisabled = [...new Set([...(window.currentDisabledFields || []), ...dailyDisabledFromOverrides])];
            const disabled = [...new Set([...baseDisabled, ...dailyDisabled])];
            // Also update window.currentDisabledFields so other modules see it
            window.currentDisabledFields = disabled;
            const dailyDisabledSports = dailyData.dailyDisabledSportsByField || ovNested.dailyDisabledSportsByField || {};

            fields.forEach(field => {
                if (disabled.includes(field.name)) return;
                const props = activityProperties[field.name] || {};
                const timeRules = [];
                const unavailableRules = [];
                if (props.timeRules && Array.isArray(props.timeRules)) {
                    props.timeRules.forEach(rule => {
                        if (rule.type === 'Unavailable' || rule.available === false) {
                            unavailableRules.push({
                                startMin: rule.startMin ?? parseTimeToMinutes(rule.start),
                                endMin: rule.endMin ?? parseTimeToMinutes(rule.end),
                                divisions: rule.divisions || null
                            });
                        } else if (rule.type === 'Available' || !rule.type) {
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
                // ★ v9.6: Read sharing from BOTH activityProperties AND field config
                const sharing = props.sharableWith || field.sharableWith || {};
                const shareType = sharing.type || sharing.shareType || 'not_sharable';
                const capacity = parseInt(sharing.capacity) || parseInt(field.capacity) || (shareType === 'not_sharable' ? 1 : (shareType === 'all' ? 999 : 2));

               fieldLedger[field.name] = {
                    name: field.name, capacity, shareType,
                    allowedDivisions: props.sharableWith?.divisions || [],
                    isIndoor: field.isIndoor || false,
                    timeRules, unavailableRules,
                    disabledSports: dailyDisabledSports[field.name] || [],
                    activities: field.activities || [],
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

        function isFieldAvailable(fieldName, startMin, endMin, bunk, grade, activity) {
            const ledger = fieldLedger[fieldName];
            if (!ledger) return false;

            // Rainy: no outdoor fields
            if (isRainy && !ledger.isIndoor) return false;

            // Unavailable rules check — if any unavailable rule overlaps, block it
            if (ledger.unavailableRules && ledger.unavailableRules.length > 0) {
                const unavail = ledger.unavailableRules.some(rule => {
                    if (rule.divisions && !rule.divisions.includes(grade)) return false;
                    return rule.startMin < endMin && rule.endMin > startMin;
                });
                if (unavail) return false;
            }

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
            // Skip this for special locations — bunks rotate through independently.
            if (overlapping.length > 0 && ledger.capacity > 1 && !ledger._isSpecialLocation) {
                const sameGradeOverlaps = overlapping.filter(c => c.grade === grade);
                if (sameGradeOverlaps.length > 0) {
                    if (sameGradeOverlaps.some(c => c.startMin !== startMin || c.endMin !== endMin)) {
                        return false;
                    }
                }
            }

            // Sport restriction check — field may have certain sports disabled for the day
            if (activity && ledger.disabledSports && ledger.disabledSports.length > 0) {
                if (ledger.disabledSports.includes(activity)) return false;
            }

            return true;
        }

        function claimField(fieldName, startMin, endMin, bunk, grade, activity) {
            if (!isFieldAvailable(fieldName, startMin, endMin, bunk, grade, activity)) return false;
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
            minD = Math.min(minD, TYPE_FLOORS.sport || 25);
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
            // ★ v10.5: Only distribute excess if still within dMax (don't exceed ceiling)
            if (excess > 0) { for (let i = 0; i < n && excess > 0; i++) { if (durations[i] < blockDescs[i].dMax) { durations[i]++; excess--; } } }
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
            // ★ v11.3: Validate all timelines after pinned layer placement
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk =>
                ensureTimelineIntegrity(bunk)));
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
                d = snapTo5(d) < dMin ? dMin : snapTo5(d);
 
                // ★ v5.2: Smart expansion — if leftover creates a dead zone,
                // SHRINK the league to make room for a fillable activity.
                // A 35min league + 25min sport is better than a 50min league + 10min gap.
                const _mf = getMinFillable(grade);
                const availableSpace = nextWall - start;
                const leftover = availableSpace - d;
                if (leftover > 0 && leftover < _mf) {
                    // Option A: expand to wall ONLY if still within dMax (never exceed)
                    if (availableSpace <= dMax) {
                        d = availableSpace;
                    } else {
                        // Option B: shrink league so leftover becomes >= minFillable
                        const shrunkTarget = availableSpace - _mf;
                        if (shrunkTarget >= dMin) {
                            const shrunk = snapTo5(shrunkTarget);
                            if (shrunk >= dMin) d = shrunk;
                        }
                    }
                    // ★ v6.0: Hard cap — league must NEVER exceed dMax
                    d = Math.min(d, dMax);
                }

                return d;
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
                    ensureTimelineIntegrity(bunk);
                });
                return ss;
            }

            const gradeStagger = staggerPlan[grade] || { offset: 0, searchDirection: 'early' };
            const leagueBand = gradeStagger.typeBands?.league || null;
            const times = [];
            for (let ts = layer.startMin; ts + dMin <= layer.endMin; ts += 5) times.push(ts);
            if (gradeStagger.searchDirection === 'late') times.reverse();

            // ★ v11.0: League Placement Flexibility — collect top 4 candidates,
            // use _iterSeed to vary which one is selected across iterations.
            var leagueCandidates = [];
            for (const ts of times) {
                const te = ts + dMin;
                if (!bunks.every(bk => !(bunkTimelines[bk] || []).some(b => b.startMin < te && b.endMin > ts))) continue;
              let score = scorePositionByContention(ts, te, 'league', null, null);
                score += getCrossGradeConflicts('league', ts, te, grade) * 10000;
                // ★ v4.0: Prefer the rotation matrix's league band (strong suggestion)
                if (leagueBand && ts >= leagueBand.start && te <= leagueBand.end) score -= 500;
                else if (leagueBand) score += 200;
                // ★ v5.1: Penalize positions that create un-fillable dead zones
                const leagueDur = expandLeagueDur(ts, bunks);
                const leagueEnd = ts + leagueDur;
                const _minFill = getMinFillable(grade);
                bunks.forEach(bk => {
                    const tl = bunkTimelines[bk] || [];
                    let prevEnd = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    tl.forEach(b => { if (b.endMin <= ts && b.endMin > prevEnd) prevEnd = b.endMin; });
                    const gapBefore = ts - prevEnd;
                    if (gapBefore > 0 && gapBefore < _minFill) score += 5000;
                    let nextStart = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                    tl.forEach(b => { if (b.startMin >= leagueEnd && b.startMin < nextStart) nextStart = b.startMin; });
                    const gapAfter = nextStart - leagueEnd;
                    if (gapAfter > 0 && gapAfter < _minFill) score += 5000;
                });

                // ★ v14.0: SPECIAL-AWARE LEAGUE SCORING — penalize positions that
                // leave no gap large enough for the grade's specials.
                // Check PER BUNK (not merged) since walls are per-bunk.
                var gradeSpecialLayers = (layersByGrade[grade] || []).filter(function(l) {
                    return (l.type || '').toLowerCase() === 'special';
                });
                if (gradeSpecialLayers.length > 0) {
                    var maxSpecialDur = 0;
                    gradeSpecialLayers.forEach(function(sl) {
                        var sdName = sl.event || sl.name || '';
                        var sdCfg = getSpecialDuration(sdName, activityProperties, globalSettings);
                        var sdDur = sdCfg || resolveConstraints(sl, 'special').dMin || 30;
                        if (sdDur > maxSpecialDur) maxSpecialDur = sdDur;
                    });

                    // Check EACH bunk — after league, does it still have a gap >= maxSpecialDur?
                    var gs2Start = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    var gs2End = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                    var bunksWithNoRoom = 0;
                    bunks.forEach(function(bk) {
                        var bkWalls = (bunkTimelines[bk] || []).map(function(b) { return { s: b.startMin, e: b.endMin }; });
                        bkWalls.push({ s: ts, e: leagueEnd }); // simulate league
                        bkWalls.sort(function(a, b) { return a.s - b.s; });
                        var maxGap = 0, prev2 = gs2Start;
                        bkWalls.forEach(function(w) {
                            if (w.s > prev2) maxGap = Math.max(maxGap, w.s - prev2);
                            prev2 = Math.max(prev2, w.e);
                        });
                        if (gs2End > prev2) maxGap = Math.max(maxGap, gs2End - prev2);
                        if (maxGap < maxSpecialDur) bunksWithNoRoom++;
                    });

                    if (bunksWithNoRoom > 0) {
                        // Penalize proportionally — more bunks blocked = worse
                        score += bunksWithNoRoom * 5000;
                    }
                }
                leagueCandidates.push({ start: ts, score: score });
            }
            // Sort by score, keep top 4 distinct positions
            leagueCandidates.sort(function(a, b) { return a.score - b.score; });
            var uniqueCandidates = [];
            var seenStarts = {};
            for (var lci = 0; lci < leagueCandidates.length && uniqueCandidates.length < 4; lci++) {
                if (!seenStarts[leagueCandidates[lci].start]) {
                    seenStarts[leagueCandidates[lci].start] = true;
                    uniqueCandidates.push(leagueCandidates[lci]);
                }
            }
            if (uniqueCandidates.length === 0) { warn('[P0] No free league gap for ' + grade); return null; }
            // Select candidate based on _iterSeed — different iteration = different position
            var candidateIdx = _iterSeed % uniqueCandidates.length;
            if (!uniqueCandidates[candidateIdx]) { warn('[P0] League candidate undefined at idx=' + candidateIdx + ' len=' + uniqueCandidates.length + ' for ' + grade); return null; }
            var bestStart = uniqueCandidates[candidateIdx].start;

            const expandedDur = expandLeagueDur(bestStart, bunks);
            bunks.forEach(bunk => {
                bunkTimelines[bunk].push({
                    startMin: bestStart, endMin: bestStart + expandedDur,
                    type: layer.type || 'league', event: layer.event || 'League Game',
                    layer, _classification: 'windowed', _committed: true,
                    _gradeWide: true, _activityLocked: true, _noBacktrack: true
                });
                ensureTimelineIntegrity(bunk);
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
                // ★ v11.0: Multi-day awareness — adjust score based on week history
                if (weekActivityHistory) {
                    var bunkHist = weekActivityHistory[String(bunk)] || {};
                    var recentDays = getRecentDays(currentDate, 5);
                    var daysSince = Infinity;
                    for (var rd = 0; rd < recentDays.length; rd++) {
                        if ((bunkHist[recentDays[rd]] || []).indexOf(name) >= 0) { daysSince = rd + 1; break; }
                    }
                    if (daysSince <= 1) score += 3000;         // done yesterday — avoid
                    else if (daysSince <= 2) score += 1000;    // done 2 days ago — mild avoid
                    else if (daysSince >= 4) score -= 500;     // overdue — prioritize
                    var streak = countConsecutiveStreak(bunkHist, currentDate, name);
                    if (streak >= 3) score += 10000 * streak;  // long streak is terrible
                }
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
            // ★ v11.0: When bias = sportVariety, skip shuffle to preserve rotation-optimal order
            if (_iterSeed > 0 && iterationBias.category !== 'sportVariety') {
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
        // PHASE 2B: GLOBAL TIME-SWEEP PLANNER v2.0
        // =====================================================================
        //
        // Replaces grade-by-grade processing with global fair allocation:
        //   Phase A: Scarce-first special allocation (round-robin across grades)
        //   Phase B: Chronological sport fill (urgency-first across all bunks)
        //   Phase C: Elective cleanup
        //
        // Key improvement: ALL bunks across ALL grades are visible simultaneously.
        // No grade can hog resources before another grade runs.
        // =====================================================================

        function runGlobalPlanner(shoppingLists) {
            const GP = '[GlobalPlanner]';
            log(GP + ' Starting time-sweep planner...');

            // ═══════════════════════════════════════════════════════
            // INIT
            // ═══════════════════════════════════════════════════════
            const draftResults = {};
            const allBunkList = Object.values(shoppingLists);
            allBunkList.forEach(list => {
                draftResults[list.bunk] = {
                    sports: [], specials: [], elective: [], generic: [],
                    usedActivities: new Set(), grade: list.grade
                };
            });

            const globalSpecialUsage = {};
            const globalFieldClaims = [];

            function canAssignSpecialToGrade(specialName, grade, startMin, endMin) {
                var info = getSpecialSharingInfo(specialName, activityProperties, globalSettings);
                var existing = globalSpecialUsage[specialName] || [];
                for (var i = 0; i < existing.length; i++) {
                    var e = existing[i];
                    if (e.endMin <= startMin || e.startMin >= endMin) continue;
                    if (e.grade === grade) {
                        var sameGradeCount = existing.filter(function(x) {
                            return x.grade === grade && x.startMin < endMin && x.endMin > startMin;
                        }).length;
                        if (sameGradeCount >= info.capacity) return false;
                    } else {
                        if (info.shareType === 'not_sharable') return false;
                        if (info.shareType === 'same_division') return false;
                        if (info.shareType === 'custom') {
                            var allowed = info.allowedDivisions || [];
                            if (allowed.length > 0 && !allowed.includes(grade)) return false;
                            if (allowed.length > 0 && !allowed.includes(e.grade)) return false;
                            if (allowed.length === 0) return false;
                        }
                        var totalCount = existing.filter(function(x) {
                            return x.startMin < endMin && x.endMin > startMin;
                        }).length;
                        if (totalCount >= info.capacity) return false;
                    }
                }
                return true;
            }

            function registerSpecialAssignment(specialName, grade, startMin, endMin) {
                if (!globalSpecialUsage[specialName]) globalSpecialUsage[specialName] = [];
                globalSpecialUsage[specialName].push({ grade: grade, startMin: startMin, endMin: endMin });
            }

            function isFieldStillAvailableGP(fieldName, startMin, endMin, bunk, grade) {
                if (!isFieldAvailable(fieldName, startMin, endMin, bunk, grade)) return false;
                var ledger = fieldLedger[fieldName];
                if (!ledger) return false;
                var plannerOverlap = globalFieldClaims.filter(function(c) {
                    return c.field === fieldName && c.startMin < endMin && c.endMin > startMin && c.bunk !== bunk;
                });
                var ledgerOverlap = ledger.claims.filter(function(c) {
                    return c.startMin < endMin && c.endMin > startMin && c.bunk !== bunk;
                });
                return (ledgerOverlap.length + plannerOverlap.length) < ledger.capacity;
            }

            function claimFieldGlobal(fieldName, startMin, endMin, bunk, grade, activity) {
                claimField(fieldName, startMin, endMin, bunk, grade, activity);
                globalFieldClaims.push({ field: fieldName, startMin: startMin, endMin: endMin, bunk: bunk, grade: grade, activity: activity });
            }

            function getUpdatedFreeWindowsForBunk(bunk, sl, result) {
                var claimed = [].concat(result.sports || [], result.specials || [], result.elective || [], result.generic || [])
                    .map(function(c) { return c.claimedTime; }).filter(Boolean)
                    .sort(function(a, b) { return a.startMin - b.startMin; });
                var original = sl && sl.freeWindows ? sl.freeWindows : [];
                var updated = [];
                for (var i = 0; i < original.length; i++) {
                    var win = original[i];
                    if (!win || win.start == null || win.end == null) continue;
                    var cur = win.start;
                    var ol = claimed.filter(function(c) { return c.startMin < win.end && c.endMin > win.start; })
                        .sort(function(a, b) { return a.startMin - b.startMin; });
                    for (var j = 0; j < ol.length; j++) {
                        if (ol[j].startMin > cur) updated.push({ start: cur, end: ol[j].startMin, duration: ol[j].startMin - cur });
                        cur = Math.max(cur, ol[j].endMin);
                    }
                    if (cur < win.end) updated.push({ start: cur, end: win.end, duration: win.end - cur });
                }
                return updated.filter(function(w) { return w.duration > 0; });
            }

            // Find time within a specific range (for stagger band preference)
            function findTimeInRange(fieldName, bunk, grade, dur, freeWindows, rangeStart, rangeEnd, specialName) {
                for (var i = 0; i < freeWindows.length; i++) {
                    var win = freeWindows[i];
                    if (!win || win.start == null) continue;
                    var effStart = Math.max(win.start, rangeStart);
                    var effEnd = Math.min(win.end, rangeEnd);
                    if (effEnd - effStart < dur) continue;
                    for (var t = effStart; t + dur <= effEnd; t += 5) {
                        if (fieldName && !isFieldStillAvailableGP(fieldName, t, t + dur, bunk, grade)) continue;
                        if (specialName && !canAssignSpecialToGrade(specialName, grade, t, t + dur)) continue;
                        return { startMin: t, endMin: t + dur };
                    }
                }
                return null;
            }

            // Find time anywhere in free windows
            function findTimeAnywhere(fieldName, bunk, grade, dur, freeWindows, specialName) {
                for (var i = 0; i < freeWindows.length; i++) {
                    var win = freeWindows[i];
                    if (!win || win.start == null) continue;
                    if (win.duration < dur) continue;
                    for (var t = win.start; t + dur <= win.end; t += 5) {
                        if (fieldName && !isFieldStillAvailableGP(fieldName, t, t + dur, bunk, grade)) continue;
                        if (specialName && !canAssignSpecialToGrade(specialName, grade, t, t + dur)) continue;
                        return { startMin: t, endMin: t + dur };
                    }
                }
                return null;
            }

            function findTimeForFieldGP(fieldName, bunk, grade, duration, freeWindows) {
                for (var i = 0; i < freeWindows.length; i++) {
                    var win = freeWindows[i];
                    if (win.duration < duration) continue;
                    for (var t = win.start; t + duration <= win.end; t += 5) {
                        if (isFieldStillAvailableGP(fieldName, t, t + duration, bunk, grade))
                            return { startMin: t, endMin: t + duration };
                    }
                }
                return null;
            }

            function findAnyWindowGP(freeWindows, duration) {
                for (var i = 0; i < freeWindows.length; i++) {
                    if (freeWindows[i].duration >= duration)
                        return { startMin: freeWindows[i].start, endMin: freeWindows[i].start + duration };
                }
                return null;
            }

            // ═══════════════════════════════════════════════════════
            // PHASE A: GAME PLAN — Scarce-First Special Allocation
            // ═══════════════════════════════════════════════════════

            // A1: Compute scarcity for each special
            var specialDemand = {};
            allBunkList.forEach(function(list) {
                var priorityList = list.specials && list.specials.priorityList ? list.specials.priorityList : [];
                priorityList.forEach(function(special, idx) {
                    if (!specialDemand[special.name]) {
                        specialDemand[special.name] = {
                            name: special.name,
                            bunks: [],
                            capacity: special.capacity || 1,
                            location: special.location,
                            duration: special.totalDuration || special.dMin || 30,
                            isScarce: special.isScarce,
                            specialItem: special
                        };
                    }
                    specialDemand[special.name].bunks.push({
                        bunk: list.bunk, grade: list.grade,
                        rotationScore: special.rotationScore
                    });
                });
            });

            // A2: Sort specials by scarcity (most contended first)
            var sortedSpecials = Object.values(specialDemand).sort(function(a, b) {
                if (a.isScarce !== b.isScarce) return a.isScarce ? -1 : 1;
                var ratioA = a.bunks.length / Math.max(1, a.capacity);
                var ratioB = b.bunks.length / Math.max(1, b.capacity);
                if (ratioB !== ratioA) return ratioB - ratioA;
                return a.capacity - b.capacity;
            });

            log(GP + ' Phase A: ' + sortedSpecials.length + ' specials to distribute (scarce-first)');

            // A3: For each special, assign round-robin across grades
            for (var si = 0; si < sortedSpecials.length; si++) {
                var specialInfo = sortedSpecials[si];

                // Group requesting bunks by grade
                var gradeGroups = {};
                specialInfo.bunks.forEach(function(b) {
                    if (!gradeGroups[b.grade]) gradeGroups[b.grade] = [];
                    gradeGroups[b.grade].push(b);
                });

                // Sort within each grade by rotation score (most needed first)
                Object.values(gradeGroups).forEach(function(group) {
                    group.sort(function(a, b) { return a.rotationScore - b.rotationScore; });
                });

                // Shuffle grade order for iteration variety
                var gradeOrder = _iterSeed > 0
                    ? seedShuffle(Object.keys(gradeGroups), _iterSeed + si)
                    : Object.keys(gradeGroups);
                var gradeQueues = {};
                gradeOrder.forEach(function(g) { gradeQueues[g] = gradeGroups[g].slice(); });

                // Round-robin: one bunk per grade per round
                var anyLeft = true;
                while (anyLeft) {
                    anyLeft = false;
                    for (var gi = 0; gi < gradeOrder.length; gi++) {
                        var grade = gradeOrder[gi];
                        var queue = gradeQueues[grade];
                        if (!queue || queue.length === 0) continue;

                        while (queue.length > 0) {
                            var candidate = queue[0];
                            var bunk = candidate.bunk;
                            var sl = shoppingLists[bunk];
                            var result = draftResults[bunk];

                            if (result.specials.length >= (sl.specials && sl.specials.required ? sl.specials.required : 0)) {
                                queue.shift(); continue;
                            }
                            if (result.usedActivities.has(specialInfo.name)) {
                                queue.shift(); continue;
                            }

                            var fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                            var dur = specialInfo.duration;
                            var time = null;

                            // Prefer stagger band
                            var specialBand = staggerPlan[grade] && staggerPlan[grade].typeBands
                                ? staggerPlan[grade].typeBands.special : null;
                            if (specialBand) {
                                time = findTimeInRange(specialInfo.location, bunk, grade, dur, fw,
                                    specialBand.start, specialBand.end, specialInfo.name);
                            }
                            // Fallback: anywhere
                            if (!time) {
                                time = findTimeAnywhere(specialInfo.location, bunk, grade, dur, fw, specialInfo.name);
                            }

                            queue.shift();
                            if (!time) continue;

                            // Assign
                            if (specialInfo.location) {
                                claimFieldGlobal(specialInfo.location, time.startMin, time.endMin, bunk, grade, specialInfo.name);
                            }
                            registerSpecialAssignment(specialInfo.name, grade, time.startMin, time.endMin);

                            var fullItem = (sl.specials && sl.specials.priorityList || [])
                                .find(function(s) { return s.name === specialInfo.name; }) || specialInfo.specialItem;
                            result.specials.push({
                                name: fullItem.name, type: fullItem.type || 'special',
                                rotationScore: fullItem.rotationScore, duration: fullItem.duration,
                                dMin: fullItem.dMin, dMax: fullItem.dMax, dIdeal: fullItem.dIdeal,
                                isFlexDuration: fullItem.isFlexDuration, capacity: fullItem.capacity,
                                location: fullItem.location, isScarce: fullItem.isScarce,
                                isIndoor: fullItem.isIndoor, prepDuration: fullItem.prepDuration,
                                totalDuration: fullItem.totalDuration, timeWindow: fullItem.timeWindow,
                                _linkedPair: fullItem._linkedPair, _layer: fullItem._layer,
                                claimedTime: time, claimedField: specialInfo.location
                            });
                            result.usedActivities.add(specialInfo.name);
                            anyLeft = true;
                            break; // next grade (round-robin)
                        }
                    }
                }
            }

            // A4: Fallback — bunks still missing specials
            allBunkList.forEach(function(list) {
                var bunk = list.bunk, grade = list.grade;
                var result = draftResults[bunk];
                var sl = shoppingLists[bunk];
                var required = sl.specials && sl.specials.required ? sl.specials.required : 0;
                if (result.specials.length >= required) return;

                var priorityList = sl.specials && sl.specials.priorityList ? sl.specials.priorityList : [];
                for (var i = 0; i < priorityList.length; i++) {
                    if (result.specials.length >= required) break;
                    var special = priorityList[i];
                    if (result.usedActivities.has(special.name)) continue;

                    var fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                    var dur = special.totalDuration || special.dMin || 30;
                    var time = findTimeAnywhere(special.location, bunk, grade, dur, fw, special.name);
                    if (!time) continue;

                    if (special.location) claimFieldGlobal(special.location, time.startMin, time.endMin, bunk, grade, special.name);
                    registerSpecialAssignment(special.name, grade, time.startMin, time.endMin);
                    result.specials.push({
                        name: special.name, type: special.type || 'special',
                        rotationScore: special.rotationScore, duration: special.duration,
                        dMin: special.dMin, dMax: special.dMax, dIdeal: special.dIdeal,
                        isFlexDuration: special.isFlexDuration, capacity: special.capacity,
                        location: special.location, isScarce: special.isScarce,
                        isIndoor: special.isIndoor, prepDuration: special.prepDuration,
                        totalDuration: special.totalDuration, timeWindow: special.timeWindow,
                        _linkedPair: special._linkedPair, _layer: special._layer,
                        claimedTime: time, claimedField: special.location
                    });
                    result.usedActivities.add(special.name);
                }
            });

            // Log Phase A results
            var phaseASpecials = 0;
            var phaseAByGrade = {};
            Object.entries(draftResults).forEach(function(entry) {
                var bunk = entry[0], r = entry[1];
                if (!phaseAByGrade[r.grade]) phaseAByGrade[r.grade] = { got: 0, total: 0 };
                phaseAByGrade[r.grade].total++;
                if (r.specials.length > 0) { phaseAByGrade[r.grade].got++; phaseASpecials++; }
            });
            log(GP + ' Phase A complete: ' + phaseASpecials + ' bunks got specials');
            Object.keys(phaseAByGrade).sort().forEach(function(g) {
                log(GP + '   Grade ' + g + ': ' + phaseAByGrade[g].got + '/' + phaseAByGrade[g].total);
            });

            // ═══════════════════════════════════════════════════════
            // PHASE B: TIME SWEEP — Chronological Sport Assignment
            // ═══════════════════════════════════════════════════════

            // B1: Collect all time boundaries
            var allBoundaries = new Set();
            allBunkList.forEach(function(list) {
                var fw = getUpdatedFreeWindowsForBunk(list.bunk, shoppingLists[list.bunk], draftResults[list.bunk]);
                fw.forEach(function(w) { allBoundaries.add(w.start); allBoundaries.add(w.end); });
            });
            var sortedTimes = Array.from(allBoundaries).sort(function(a, b) { return a - b; });

            // B2: Build time slots and walk forward
            var sportMinDurDefault = 25;
            for (var ti = 0; ti < sortedTimes.length - 1; ti++) {
                var slotStart = sortedTimes[ti];
                var slotEnd = sortedTimes[ti + 1];
                if (slotEnd - slotStart < sportMinDurDefault) continue;

                // Find bunks free during this slot that still need sports
                var freeBunks = [];
                for (var bi = 0; bi < allBunkList.length; bi++) {
                    var list = allBunkList[bi];
                    var result = draftResults[list.bunk];
                    var sl = shoppingLists[list.bunk];
                    var sportsRequired = sl.sports && sl.sports.required ? sl.sports.required : 0;
                    if (result.sports.length >= sportsRequired) continue;
                    var fw = getUpdatedFreeWindowsForBunk(list.bunk, sl, result);
                    var fits = fw.some(function(w) { return w.start <= slotStart && w.end >= slotEnd; });
                    if (!fits) continue;

                    // Count future opportunities for urgency ranking
                    var sportMin = sl.sports && sl.sports.constraints ? sl.sports.constraints.dMin : sportMinDurDefault;
                    var futureOps = fw.filter(function(w) { return w.start >= slotEnd && w.duration >= sportMin; }).length;
                    freeBunks.push({ bunk: list.bunk, grade: list.grade, futureOps: futureOps, sl: sl });
                }

                if (freeBunks.length === 0) continue;

                // Sort: fewest future opportunities first (most urgent)
                freeBunks.sort(function(a, b) { return a.futureOps - b.futureOps; });

                // Assign sports
                for (var fi = 0; fi < freeBunks.length; fi++) {
                    var bunkInfo = freeBunks[fi];
                    var bunk = bunkInfo.bunk, grade = bunkInfo.grade;
                    var result = draftResults[bunk];
                    var sl = shoppingLists[bunk];
                    if (result.sports.length >= (sl.sports && sl.sports.required ? sl.sports.required : 0)) continue;

                    var sportList = sl.sports && sl.sports.priorityList ? sl.sports.priorityList : [];
                    for (var spi = 0; spi < sportList.length; spi++) {
                        var sport = sportList[spi];
                        if (result.usedActivities.has(sport.name)) continue;

                        var assigned = false;
                        var fields = sport.fields || [];
                        for (var fli = 0; fli < fields.length; fli++) {
                            if (!isFieldStillAvailableGP(fields[fli], slotStart, slotEnd, bunk, grade)) continue;
                            claimFieldGlobal(fields[fli], slotStart, slotEnd, bunk, grade, sport.name);
                            result.sports.push({
                                name: sport.name, type: 'sport', rotationScore: sport.rotationScore,
                                dMin: sport.dMin, dMax: sport.dMax, dIdeal: sport.dIdeal,
                                fields: sport.fields, needsPairing: sport.needsPairing,
                                playerReqs: sport.playerReqs, bunkSize: sport.bunkSize,
                                isIndoor: sport.isIndoor, _layer: sport._layer,
                                claimedTime: { startMin: slotStart, endMin: slotEnd },
                                claimedField: fields[fli]
                            });
                            result.usedActivities.add(sport.name);
                            assigned = true;
                            break;
                        }
                        if (assigned) break;
                    }
                }
            }

            // B3: Fallback — bunks still needing sports
            allBunkList.forEach(function(list) {
                var bunk = list.bunk, grade = list.grade;
                var result = draftResults[bunk];
                var sl = shoppingLists[bunk];
                var required = sl.sports && sl.sports.required ? sl.sports.required : 0;
                if (result.sports.length >= required) return;

                var sportList = sl.sports && sl.sports.priorityList ? sl.sports.priorityList : [];
                for (var i = 0; i < sportList.length; i++) {
                    if (result.sports.length >= required) break;
                    var sport = sportList[i];
                    if (result.usedActivities.has(sport.name)) continue;
                    var fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                    var fields = sport.fields || [];
                    for (var j = 0; j < fields.length; j++) {
                        var time = findTimeForFieldGP(fields[j], bunk, grade, sport.dIdeal, fw);
                        if (time) {
                            claimFieldGlobal(fields[j], time.startMin, time.endMin, bunk, grade, sport.name);
                            result.sports.push({
                                name: sport.name, type: 'sport', rotationScore: sport.rotationScore,
                                dMin: sport.dMin, dMax: sport.dMax, dIdeal: sport.dIdeal,
                                fields: sport.fields, needsPairing: sport.needsPairing,
                                playerReqs: sport.playerReqs, bunkSize: sport.bunkSize,
                                isIndoor: sport.isIndoor, _layer: sport._layer,
                                claimedTime: time, claimedField: fields[j]
                            });
                            result.usedActivities.add(sport.name);
                            break;
                        }
                    }
                }
            });

            // ═══════════════════════════════════════════════════════
            // PHASE C: CLEANUP — Electives
            // ═══════════════════════════════════════════════════════
            allBunkList.forEach(function(list) {
                var sl = shoppingLists[list.bunk];
                if (!sl || !sl.elective) return;
                var result = draftResults[list.bunk];
                var fw = getUpdatedFreeWindowsForBunk(list.bunk, sl, result);
                for (var i = 0; i < (sl.elective.count || 0); i++) {
                    var time = findAnyWindowGP(fw, sl.elective.dIdeal);
                    if (time) result.elective.push({
                        type: 'elective', duration: sl.elective.dIdeal,
                        claimedTime: time, layer: sl.elective.layer
                    });
                }
            });

            // Log final summary
            var totalSports = 0, totalSpecials = 0;
            Object.values(draftResults).forEach(function(r) {
                totalSports += r.sports.length;
                totalSpecials += r.specials.length;
            });
            log(GP + ' Phase B complete: ' + totalSports + ' sports assigned');
            log(GP + ' TOTAL: ' + totalSports + ' sports + ' + totalSpecials + ' specials across ' + Object.keys(draftResults).length + ' bunks');

            return draftResults;
        }

        // ★ LEGACY: old runDraft removed (was dead code, replaced by runGlobalPlanner)

        // ★ LEGACY: old simpleDraftForBunk removed (handled by global algorithm)

        // ★ LEGACY: old assignSportsToWindow / assignSpecialsToWindow removed

        // NOTE: The following line is needed so the iteration loop at line ~3854
        // can still call runGlobalPlanner. The old runDraft function was already
        // dead code (line 3854 calls runGlobalPlanner directly).

        // KEEP THESE — referenced by other code paths:
        // (none needed — all helpers are now inside runGlobalPlanner)

        // ─── OLD CODE REMOVED: runDraft + old runGlobalPlanner ───
        // Replaced by the time-sweep planner above.
        if (false) { // dead code guard — keeps JS parser happy
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

            // ─── PRE-PASS: Assign 1 special to every bunk across all grades ──
            // Process grades in round-robin to ensure fair distribution.
            // Each grade gets one bunk assigned per round until all bunks have a special.
            {
                const gradeQueues = {};
                allGrades.forEach(grade => {
                    const bunks = getBunksForGrade(grade, divisions).map(String);
                    // ★ v10.0: Repair-driven — prioritize failed bunks in subsequent iterations
                    var shuffled;
                    if (totalIters > 1 && Object.keys(repairTargets.failedBunks).length > 0) {
                        shuffled = [...bunks].sort(function(a, b) {
                            var aFailed = repairTargets.failedBunks[a] ? 1 : 0;
                            var bFailed = repairTargets.failedBunks[b] ? 1 : 0;
                            if (aFailed !== bFailed) return bFailed - aFailed; // failed first
                            return 0;
                        });
                        // Still shuffle within the groups for variety
                        var failedGroup = shuffled.filter(function(b) { return repairTargets.failedBunks[b]; });
                        var okGroup = shuffled.filter(function(b) { return !repairTargets.failedBunks[b]; });
                        if (_iterSeed > 0) { seedShuffle(failedGroup, _iterSeed); seedShuffle(okGroup, _iterSeed); }
                        shuffled = failedGroup.concat(okGroup);
                    } else {
                        shuffled = _iterSeed > 0 ? seedShuffle([...bunks], _iterSeed) : [...bunks];
                    }
                    gradeQueues[grade] = shuffled;
                });

                let anyAssigned = true;
                while (anyAssigned) {
                    anyAssigned = false;
                    allGrades.forEach(grade => {
                        _gpCurrentGrade = grade;
                        const queue = gradeQueues[grade];
                        if (!queue || queue.length === 0) return;

                        const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                        const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;

                        // Find next bunk that still needs a special
                        while (queue.length > 0) {
                            const bunk = queue[0];
                            const sl = shoppingLists[bunk];
                            const result = draftResults[bunk];
                            if (!sl || result.specials.length >= (sl.specials?.required || 0)) {
                                queue.shift();
                                continue;
                            }

                            let assigned = false;
                            const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                            for (const special of (sl.specials?.priorityList || [])) {
                                if (result.usedActivities.has(special.name)) continue;
                                const dur = special.totalDuration || special.dMin || 30;

                                // Scan all free windows for a valid time
                                let time = null;
                                for (const win of fw) {
                                    if (win.duration < dur) continue;
                                    for (let t = win.start; t + dur <= win.end; t += 5) {
                                        if (special.location && !isFieldAvailable(special.location, t, t + dur, bunk, grade)) continue;
                                        if (!canAssignSpecialToGrade(special.name, grade, t, t + dur)) continue;
                                        time = { startMin: t, endMin: t + dur };
                                        break;
                                    }
                                    if (time) break;
                                }
                                if (!time) continue;

                                if (special.location) claimFieldForPlanner(special.location, time.startMin, time.endMin, bunk, special.name);
                                registerSpecialAssignment(special.name, grade, time.startMin, time.endMin);
                                result.specials.push({ ...special, claimedTime: time, claimedField: special.location });
                                result.usedActivities.add(special.name);
                                assigned = true;
                                break;
                            }

                            queue.shift();
                            if (assigned) { anyAssigned = true; break; }
                        }
                    });
                }

                // Log results
                let prePassSpecials = 0;
                const prePassByGrade = {};
                const prePassFailed = [];
                Object.entries(draftResults).forEach(([bunk, r]) => {
                    const g = r.grade;
                    if (!prePassByGrade[g]) prePassByGrade[g] = { got: 0, total: 0 };
                    prePassByGrade[g].total++;
                    if (r.specials.length > 0) { prePassByGrade[g].got++; prePassSpecials++; }
                    else {
                        const sl = shoppingLists[bunk];
                        if (sl && (sl.specials?.required || 0) > 0) prePassFailed.push(bunk + '(g' + g + ')');
                    }
                });
                log(GP + ' Pre-pass: assigned ' + prePassSpecials + ' specials across all grades');
                Object.entries(prePassByGrade).sort((a,b) => a[0]-b[0]).forEach(([g, info]) => {
                    log(GP + '   Grade ' + g + ': ' + info.got + '/' + info.total + ' bunks got specials');
                });
                if (prePassFailed.length > 0) log(GP + '   Failed bunks: ' + prePassFailed.join(', '));
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

                // ── Step D0: (handled by cross-grade pre-pass above) ────

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

                            const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                            const dur = special.totalDuration || special.dMin || 30;
                            const time = special.location
                                ? findTimeForFieldGP(special.location, bunk, grade, dur, fw)
                                : findAnyWindowGP(fw, dur);
                            if (!time) continue;
                            if (!canAssignSpecialToGrade(special.name, grade, time.startMin, time.endMin)) continue;

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
                    // Don't give extra specials beyond what's required
                    if (result.specials.length >= (sl.specials?.required || 1)) continue;
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

                    const fw = getUpdatedFreeWindowsForBunk(bunk, sl, result);
                    const dur = special.totalDuration || special.dMin || 30;
                    const time = special.location
                        ? findTimeForFieldGP(special.location, bunk, grade, dur, fw)
                        : findAnyWindowGP(fw, dur);
                    if (!time) continue;
                    if (!canAssignSpecialToGrade(special.name, grade, time.startMin, time.endMin)) continue;

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
                    if (!win || win.start == null) continue;
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
                    if (!win || win.start == null) continue;
                    if (win.duration >= duration)
                        return { startMin: win.start, endMin: win.start + duration };
                }
                return null;
            }
        } // end dead code guard


        // =====================================================================
        // ★ v10.0: TIMELINE INTEGRITY GUARD — sort + fix overlaps after every insertion
        // Defined at outer scope so Phase 0, Phase 2.5, and Phase 3 can all use it.
        // ★ v11.3: COMPREHENSIVE TIMELINE VALIDATOR
        // Single function that fixes overlaps, dMin/dMax, and window violations.
        // Called after every major mutation. This is the system's safety net.
        function ensureTimelineIntegrity(bunk) {
            var tl = bunkTimelines[bunk];
            if (!tl || tl.length === 0) return;

            // Pass 1: Sort and fix overlaps
            tl.sort(function(a, b) { return a.startMin - b.startMin; });
            for (var i = 0; i < tl.length - 1; i++) {
                if (tl[i].endMin > tl[i+1].startMin) {
                    if (!tl[i]._fixed && tl[i+1]._fixed) {
                        tl[i].endMin = tl[i+1].startMin;
                    } else if (!tl[i+1]._fixed && tl[i]._fixed) {
                        tl[i+1].startMin = tl[i].endMin;
                    } else if (!tl[i]._fixed && !tl[i+1]._fixed) {
                        // Both flexible — keep longer, trim shorter
                        var dur1 = tl[i].endMin - tl[i].startMin;
                        var dur2 = tl[i+1].endMin - tl[i+1].startMin;
                        if (dur1 >= dur2) tl[i+1].startMin = tl[i].endMin;
                        else tl[i].endMin = tl[i+1].startMin;
                    } else {
                        // Both fixed — force trim the later one
                        tl[i+1].startMin = tl[i].endMin;
                    }
                }
            }

            // Pass 2: Remove zero/negative duration blocks
            tl = tl.filter(function(b) { return b.endMin > b.startMin; });

            // Pass 3: Enforce dMin/dMax and window for non-fixed blocks
            for (var j = 0; j < tl.length; j++) {
                var blk = tl[j];
                if (blk._fixed) continue;
                var bt = (blk.type || '').toLowerCase();
                var dur = blk.endMin - blk.startMin;

                // Resolve constraints
                var constraints = resolveConstraints(blk.layer, bt, blk);
                var dMin = constraints.dMin;
                var dMax = constraints.dMax;
                blk.dMin = dMin;
                blk.dMax = dMax;

                // Enforce layer window
                if (blk.layer && !['sport', 'slot'].includes(bt)) {
                    if (blk.layer.startMin != null && blk.startMin < blk.layer.startMin) {
                        blk.startMin = blk.layer.startMin;
                    }
                    if (blk.layer.endMin != null && blk.endMin > blk.layer.endMin) {
                        blk.endMin = blk.layer.endMin;
                    }
                    dur = blk.endMin - blk.startMin;
                    if (dur <= 0) { tl.splice(j, 1); j--; continue; }
                }

                // Enforce dMax
                if (dur > dMax) {
                    blk.endMin = blk.startMin + dMax;
                    blk.endMin = Math.round(blk.endMin / 5) * 5;
                    dur = blk.endMin - blk.startMin;
                }

                // Enforce dMin — try extending into adjacent gap
                if (dur < dMin) {
                    var nextS = (j < tl.length - 1) ? tl[j+1].startMin : 1440;
                    var availR = nextS - blk.endMin;
                    if (dur + availR >= dMin && blk.startMin + dMin <= nextS) {
                        blk.endMin = blk.startMin + Math.min(dMin, dMax);
                        blk.endMin = Math.round(blk.endMin / 5) * 5;
                    } else {
                        var prevE = (j > 0) ? tl[j-1].endMin : 0;
                        var availL = blk.startMin - prevE;
                        if (dur + availL >= dMin) {
                            blk.startMin = blk.endMin - Math.min(dMin, dMax);
                            blk.startMin = Math.round(blk.startMin / 5) * 5;
                        }
                    }
                }
            }

            // Pass 4: Final overlap cleanup (extensions may have created new overlaps)
            tl.sort(function(a, b) { return a.startMin - b.startMin; });
            for (var k = 0; k < tl.length - 1; k++) {
                if (tl[k].endMin > tl[k+1].startMin) {
                    if (tl[k]._fixed) tl[k+1].startMin = tl[k].endMin;
                    else tl[k].endMin = tl[k+1].startMin;
                }
            }
            bunkTimelines[bunk] = tl.filter(function(b) { return b.endMin > b.startMin; });
        }

        // =====================================================================
        // PHASE 3: TIME-SWEEP SPORT FILLER (v8.0)
        // Replaces the old greedyPackBunk. Processes ALL 38 bunks simultaneously.
        // Walls never move. Sports + fields assigned together. Sharing-aware.
        // =====================================================================

        function timeSweepFillAll(shoppingLists, draftResults, allGrades) {
            var allTemplates = {};
            log('[Phase3] ★ timeSweepFillAll v8.0: starting for ' + allGrades.length + ' grades');

            // ★ Smart rotation: compute daily quotas (resets each iteration)
            var rotationQuotas = null;
            if (window.RotationEvents && typeof window.RotationEvents.getRotationQuotas === 'function') {
                try {
                    rotationQuotas = window.RotationEvents.getRotationQuotas(currentDate);
                    var _rqKeys = Object.keys(rotationQuotas || {});
                    if (_rqKeys.length > 0) {
                        _rqKeys.forEach(function(eid) {
                            var q = rotationQuotas[eid];
                            log('[Phase3] Rotation "' + q.eventName + '": ' + q.remainingCount + ' remaining, ' + q.daysLeft + ' days left, target=' + q.dailyTarget + (q.isLastDay ? ' (LAST DAY)' : ''));
                        });
                    }
                } catch (e) { console.warn('[Phase3] rotation quota computation failed:', e); }
            }

            // ── Helper: build a template block with all required fields ──
            // ★ v9.6: Hard guard — snap to 5min, enforce dMin/dMax, reject invalid blocks
            function makeBlock(opts) {
                // Snap all blocks to 5-min boundaries
                opts.startMin = Math.round(opts.startMin / 5) * 5;
                opts.endMin = Math.round(opts.endMin / 5) * 5;
                if (opts.endMin <= opts.startMin) opts.endMin = opts.startMin + 5;

                var blockType = (opts.type || 'slot').toLowerCase();

                // ★ v11.3: Enforce dMin/dMax for ALL block types, not just sport/slot.
                // Fixed blocks are still exempt (pinned by user), but everything else
                // must respect its constraints.
                if (!opts._fixed) {
                    var blockDur = opts.endMin - opts.startMin;
                    var maxDur = opts.dMax || (TYPE_CEILINGS[blockType] || 60);
                    var minDur = opts.dMin || (TYPE_FLOORS[blockType] || 20);

                    // Enforce layer window if available
                    if (opts.layer) {
                        if (opts.layer.startMin != null && opts.startMin < opts.layer.startMin) {
                            opts.startMin = Math.round(opts.layer.startMin / 5) * 5;
                        }
                        if (opts.layer.endMin != null && opts.endMin > opts.layer.endMin) {
                            opts.endMin = Math.round(opts.layer.endMin / 5) * 5;
                        }
                        blockDur = opts.endMin - opts.startMin;
                        if (blockDur <= 0) return null;
                    }

                    // Enforce dMax
                    if (blockDur > maxDur) {
                        opts.endMin = opts.startMin + maxDur;
                        opts.endMin = Math.round(opts.endMin / 5) * 5;
                        blockDur = opts.endMin - opts.startMin;
                    }
                    // Enforce dMin — extend to meet minimum if possible
                    if (minDur > 0 && blockDur < minDur) {
                        var extended = opts.startMin + minDur;
                        extended = Math.round(extended / 5) * 5;
                        // Respect layer window ceiling when extending
                        var extCeiling = (opts.layer && opts.layer.endMin != null) ? opts.layer.endMin : Infinity;
                        if (extended - opts.startMin <= maxDur && extended <= extCeiling) {
                            opts.endMin = extended;
                            blockDur = extended - opts.startMin;
                        }
                    }
                    // Final snap check
                    blockDur = opts.endMin - opts.startMin;
                    if (blockDur < 5) return null;
                }
                return {
                    startMin: opts.startMin, endMin: opts.endMin,
                    type: opts.type || 'slot', event: opts.event || '',
                    layer: opts.layer || null, field: opts.field || null,
                    dMin: opts.dMin || (opts.endMin - opts.startMin),
                    dMax: opts.dMax || (opts.endMin - opts.startMin),
                    _fixed: opts._fixed || false, _source: opts._source || 'sport-fill',
                    _activityLocked: opts._activityLocked || false,
                    _assignedSport: opts._assignedSport || null,
                    _assignedSpecial: opts._assignedSpecial || null,
                    _specialLocation: opts._specialLocation || null,
                    _specialDuration: opts._specialDuration || null,
                    _gradeWide: opts._gradeWide || false, _noBacktrack: opts._noBacktrack || false,
                    _sportFallbacks: opts._sportFallbacks || null,
                    _customActivity: opts._customActivity || null,
                    _customField: opts._customField || null,
                    _customBunks: opts._customBunks || null,
                    _rotationEventId: opts._rotationEventId || null,
                    _rotationEventLocation: opts._rotationEventLocation || null,
                    _rotationEventColor: opts._rotationEventColor || null,
                    _final: opts._final || false
                };
            }

            // ── Helper: add sport/slot blocks, auto-splitting if over dMax ──
            // This is the ONLY way sport/slot blocks should be created.
            // Guarantees no block exceeds ceiling and no split is below fillMin.
            function addSportBlocks(targetArray, startMin, endMin, opts, ceiling, fillMin) {
                var totalDur = endMin - startMin;
                if (totalDur <= ceiling) {
                    // Fits in one block
                    opts.startMin = startMin;
                    opts.endMin = endMin;
                    var _b = makeBlock(opts); if (_b) targetArray.push(_b);
                    return;
                }
                // Split into evenly-sized blocks
                var numBlocks = Math.ceil(totalDur / ceiling);
                while (numBlocks > 1 && Math.floor(totalDur / numBlocks) < fillMin) numBlocks--;
                var blockDur = Math.round(totalDur / numBlocks / 5) * 5; // snap to 5
                if (blockDur < fillMin) blockDur = Math.floor(totalDur / numBlocks);
                var cursor = startMin;
                for (var i = 0; i < numBlocks; i++) {
                    var dur = (i === numBlocks - 1) ? (endMin - cursor) : blockDur;
                    var blockOpts = {};
                    for (var k in opts) blockOpts[k] = opts[k];
                    blockOpts.startMin = cursor;
                    blockOpts.endMin = cursor + dur;
                    var _b2 = makeBlock(blockOpts); if (_b2) targetArray.push(_b2);
                    cursor += dur;
                }
            }

            // ── Helper: find gaps between sorted blocks ──
            function findGaps(blocks, gStart, gEnd) {
                var sorted = blocks.slice().sort(function(a, b) { return a.startMin - b.startMin; });
                var gaps = [];
                var cur = gStart;
                for (var i = 0; i < sorted.length; i++) {
                    if (sorted[i].startMin > cur) gaps.push({ start: cur, end: sorted[i].startMin });
                    cur = Math.max(cur, sorted[i].endMin);
                }
                if (cur < gEnd) gaps.push({ start: cur, end: gEnd });
                return gaps;
            }

            // ══════════════════════════════════════════════════════════
            // STEP 1 & 2: Extract walls + place needs (swim/snack/custom/rotation)
            // ══════════════════════════════════════════════════════════
            var bunkMeta = {};

            for (var gi = 0; gi < allGrades.length; gi++) {
                var grade = allGrades[gi];
                var bunks = getBunksForGrade(grade, divisions).slice(); // copy for shuffle
                // ★ v11.2: VIP bunk profiling — sort by constraint tightness FIRST,
                // then shuffle within equal-tightness groups for fairness.
                // Most constrained bunks (lowest slack) get scheduled first = more options.
                if (feasibilityMap) {
                    bunks.sort(function(a, b) {
                        var fa = feasibilityMap[a], fb = feasibilityMap[b];
                        var sa = fa ? fa.slack : 999, sb = fb ? fb.slack : 999;
                        // Also check if bunk failed in previous iteration (repair target)
                        var ra = repairTargets.failedBunks[a] ? -100 : 0;
                        var rb = repairTargets.failedBunks[b] ? -100 : 0;
                        return (sa + ra) - (sb + rb); // tightest + failed first
                    });
                }
                // Then apply seeded shuffle within similar-slack bands (±20 min)
                var _shufSeed = _iterSeed * 31 + gi;
                for (var si = bunks.length - 1; si > 0; si--) {
                    _shufSeed = (_shufSeed * 1103515245 + 12345) & 0x7fffffff;
                    var sj = _shufSeed % (si + 1);
                    // Only swap if within same tightness band
                    var sA = feasibilityMap ? (feasibilityMap[bunks[si]] || {}).slack || 999 : 999;
                    var sB = feasibilityMap ? (feasibilityMap[bunks[sj]] || {}).slack || 999 : 999;
                    if (Math.abs(sA - sB) <= 20) {
                        var _tmp = bunks[si]; bunks[si] = bunks[sj]; bunks[sj] = _tmp;
                    }
                }
                var gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                var gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;

                for (var bi = 0; bi < bunks.length; bi++) {
                    var bunk = bunks[bi];
                    var shoppingList = shoppingLists[bunk];
                    var draftResult = draftResults[bunk];
                    if (!shoppingList || !draftResult) continue;

                    var sportC = shoppingList.sports?.constraints || resolveConstraints(null, 'sport');
                    // ★ v10.5: fillMinDur must respect user's dMin — never override with type floor
                    var userDMin = sportC.dMin || TYPE_FLOORS.sport || 25;
                    var fillMinDur = Math.max(userDMin, TYPE_FLOORS.sport || 25);
                    // ★ v10.5: Adaptive fillMinDur — but NEVER below the user's configured dMin
                    var bunkFeasibility = feasibilityMap ? feasibilityMap[bunk] : null;
                    if (bunkFeasibility && bunkFeasibility.slack < 30) {
                        fillMinDur = Math.max(userDMin, fillMinDur - 5);
                    }
                    // ★ v10.5: sportCeiling respects user's dMax — removed hard 60 cap
                    var sportCeiling = Math.min(sportC.dMax || 60, TYPE_CEILINGS.sport || 60);
                    var priorityList = shoppingList.sports?.priorityList || [];
                    var swimsToday = todaysSwimmers[grade] ? todaysSwimmers[grade].has(String(bunk)) : false;
                    var template = [];
                    var placedSpecialNames = new Set();

                    // ── 1a: Copy walls from bunkTimelines ────────────
                    var timeline = bunkTimelines[bunk] || [];
                    for (var wi = 0; wi < timeline.length; wi++) {
                        var b = timeline[wi];
                        var bType = (b.type || '').toLowerCase();
                        var isLeague = bType === 'league' || bType === 'specialty_league';
                        // ★ v14.0: Resolve constraints for specials too (not just leagues).
                        // This ensures pre-placed specials carry their configured dMin/dMax
                        // from getSpecialDuration(), not just their actual placed duration.
                        var c = null;
                        if (isLeague && b.layer) {
                            c = resolveConstraints(b.layer, bType);
                        } else if (bType === 'special' && b._assignedSpecial) {
                            var spCfgDur = getSpecialDuration(b._assignedSpecial, activityProperties, globalSettings);
                            if (spCfgDur && spCfgDur > 0) {
                                c = { dMin: spCfgDur, dMax: spCfgDur };
                            }
                        }
                        template.push(makeBlock({
                            startMin: b.startMin, endMin: b.endMin,
                            type: b.type, event: b.event,
                            layer: b.layer, field: b.field || null,
                            dMin: c ? c.dMin : (b.endMin - b.startMin),
                            dMax: c ? c.dMax : (b.endMin - b.startMin),
                            _fixed: true, _source: 'phase0',
                            _gradeWide: b._gradeWide || false,
                            _activityLocked: true,
                            _noBacktrack: b._noBacktrack || false,
                            _assignedSpecial: b._assignedSpecial || null,
                            _specialLocation: b._specialLocation || null,
                            _specialDuration: b._specialDuration || null
                        }));
                        if (bType === 'special' && b.event) placedSpecialNames.add(b.event);
                    }

                    // ── 1b: Build needs (non-sport layers not yet walls) ──
                    var needs = [];

                    // Swim
                    var swimLayer = (layersByGrade[grade] || []).find(function(l) { return (l.type || '').toLowerCase() === 'swim'; });
                    if (swimLayer && swimsToday && !template.some(function(w) { return (w.type || '').toLowerCase() === 'swim'; })) {
                        var sc = resolveConstraints(swimLayer, 'swim');
                        var mrc = getSwimWindow(grade);
                        var sWinStart = Math.max(swimLayer.startMin || 0, gradeStart);
                        var sWinEnd = Math.min(swimLayer.endMin || 1440, gradeEnd);
                        if (mrc && (Math.min(mrc.end, sWinEnd) - Math.max(mrc.start, sWinStart)) >= sc.dMin) {
                            sWinStart = Math.max(mrc.start, sWinStart);
                            sWinEnd = Math.min(mrc.end, sWinEnd);
                        }
                        needs.push({ type: 'swim', event: swimLayer.event || 'Swim', layer: swimLayer,
                            dMin: sc.dMin, dMax: sc.dMax, windowStart: sWinStart, windowEnd: sWinEnd,
                            _activityLocked: true, _source: 'need' });
                    }

                    // Snack
                    var snackLayer = (layersByGrade[grade] || []).find(function(l) { return ['snacks', 'snack'].includes((l.type || '').toLowerCase()); });
                    if (snackLayer && !template.some(function(w) { return ['snacks', 'snack'].includes((w.type || '').toLowerCase()); })) {
                        var snC = resolveConstraints(snackLayer, 'snacks');
                        needs.push({ type: 'snacks', event: snackLayer.event || 'snacks', layer: snackLayer,
                            dMin: snC.dMin, dMax: snC.dMax,
                            windowStart: Math.max(snackLayer.startMin || 0, gradeStart),
                            windowEnd: Math.min(snackLayer.endMin || 1440, gradeEnd),
                            _activityLocked: true, _source: 'need' });
                    }

                    // Rotation events — skip if already placed as a wall or quota met
                    if (window.RotationEvents && typeof window.RotationEvents.getNeedsForBunk === 'function') {
                        try {
                            var reNeeds = window.RotationEvents.getNeedsForBunk(String(bunk), currentDate);
                            if (reNeeds && reNeeds.length) {
                                for (var ri = 0; ri < reNeeds.length; ri++) {
                                    var rn = reNeeds[ri];
                                    // Skip if already a wall (placed by Phase 0)
                                    var reAlreadyWall = template.some(function(w) {
                                        return w._fixed && w.event === rn.event && w.type === rn.type;
                                    });
                                    if (reAlreadyWall) continue;
                                    // ★ Smart rotation: skip if daily quota already met (unless last day)
                                    if (rotationQuotas && rn._rotationEventId) {
                                        var _rq3 = rotationQuotas[rn._rotationEventId];
                                        if (_rq3 && !_rq3.isLastDay && _rq3.placed >= _rq3.dailyTarget) continue;
                                    }
                                    rn.windowStart = Math.max(rn.windowStart, gradeStart);
                                    rn.windowEnd = Math.min(rn.windowEnd, gradeEnd);
                                    if (rn.windowEnd - rn.windowStart >= rn.dMin) needs.push(rn);
                                }
                            }
                        } catch (e) { console.warn('[Phase3] rotation event needs failed for bunk ' + bunk, e); }
                    }

                    // Draft specials (only if not already pre-placed as walls)
                    var specialsAlreadyWalls = template.some(function(w) { return w._source === 'phase0' && (w.type || '').toLowerCase() === 'special'; });
                    if (!specialsAlreadyWalls && draftResult.specials && draftResult.specials.length > 0) {
                        var gradeSpecialLayer = (layersByGrade[grade] || []).find(function(l) { return (l.type || '').toLowerCase() === 'special'; });
                        var _specialFallbackList = (shoppingList.specials?.priorityList || []).map(function(sp) {
                            return { name: sp.name, location: sp.location, duration: sp.totalDuration || sp.dMin || 30 };
                        });
                        (draftResult.specials || []).forEach(function(special) {
                            if (placedSpecialNames.has(special.name)) return;
                            var hasFixedDur = special.duration && special.duration > 0;
                            var effectiveLayer = special.layer || gradeSpecialLayer || null;
                            var sDMin = hasFixedDur ? special.duration : resolveConstraints(effectiveLayer, 'special', special).dMin;
                            var sDMax = hasFixedDur ? special.duration : resolveConstraints(effectiveLayer, 'special', special).dMax;
                            // ★ v11.1: Use layer window, not grade bounds, for special placement
                            var _spWinStart = Math.max((effectiveLayer && effectiveLayer.startMin) || gradeStart, gradeStart);
                            var _spWinEnd = Math.min((effectiveLayer && effectiveLayer.endMin) || gradeEnd, gradeEnd);
                            needs.push({ type: 'special', event: special.name, layer: special.layer,
                                dMin: sDMin, dMax: sDMax, windowStart: _spWinStart, windowEnd: _spWinEnd,
                                _activityLocked: true, _assignedSpecial: special.name,
                                _specialLocation: special.location, _specialDuration: special.duration,
                                _specialFallbacks: _specialFallbackList, _source: 'need' });
                        });
                    }

                    // Custom windowed layers — skip if already a wall or outside grade window
                    (layersByGrade[grade] || []).filter(function(l) {
                        return (l.type || '').toLowerCase() === 'custom' && l._classification !== 'pinned';
                    }).forEach(function(cl) {
                        if (cl.customBunks && cl.customBunks.length > 0 && !cl.customBunks.includes(String(bunk))) return;
                        // Skip if already placed as a wall
                        var alreadyWall = template.some(function(w) {
                            return w._fixed && (w.type || '').toLowerCase() === 'custom' &&
                                   w.event === (cl.customActivity || cl.event || 'Custom');
                        });
                        if (alreadyWall) return;
                        // Skip if window is outside grade bounds
                        var winStart = Math.max(cl.startMin || 0, gradeStart);
                        var winEnd = Math.min(cl.endMin || 1440, gradeEnd);
                        if (winEnd <= winStart) return;
                        var dur = cl.durationMin || cl.periodMin || 30;
                        if (winEnd - winStart < dur) return; // window too small
                        needs.push({ type: 'custom', event: cl.customActivity || cl.event || 'Custom', layer: cl,
                            dMin: dur, dMax: cl.durationMax || dur,
                            windowStart: winStart, windowEnd: winEnd,
                            _activityLocked: true, _customActivity: cl.customActivity || null,
                            _customField: cl.customField || null, _customBunks: cl.customBunks || null, _source: 'need' });
                    });

                    // ══════════════════════════════════════════════════════════
                    // ★ v9.1: INTELLIGENT CONSTRAINT SOLVER (ICS)
                    // Self-thinking scheduling AI with:
                    //   - AC-3 arc consistency (prune impossible positions early)
                    //   - MCV heuristic (most constrained variable first)
                    //   - LCV heuristic (least constraining value — maximize future options)
                    //   - Nogood learning (remember failed combinations)
                    //   - Full backtracking with constraint propagation
                    // ══════════════════════════════════════════════════════════

                    // ★ v11.4: DURATION NEGOTIATION — compute how much time this need
                    // SHOULD take, considering what other needs still require.
                    // Prevents greedy dMax from starving neighbors.
                    function negotiateDuration(need, otherNeeds, gapSize, fMin) {
                        // Total minimum time other needs require
                        var otherMinTotal = 0;
                        for (var on = 0; on < otherNeeds.length; on++) {
                            otherMinTotal += otherNeeds[on].dMin || 0;
                        }
                        // Sport slots need at least fMin each — estimate sport blocks needed
                        var sportSlotsNeeded = Math.max(0, Math.floor((gapSize - otherMinTotal - (need.dMin || 0)) / fMin));
                        var sportMinTotal = sportSlotsNeeded * fMin;

                        // Available time for THIS need = gapSize - what others minimally need - sport minimums
                        var availForNeed = gapSize - otherMinTotal - sportMinTotal;
                        // Clamp between dMin and dMax
                        var idealDur = Math.max(need.dMin || 0, Math.min(need.dMax || 60, availForNeed));
                        // Snap to 5
                        idealDur = Math.round(idealDur / 5) * 5;
                        return Math.max(need.dMin || 0, idealDur);
                    }

                    // Generate ALL valid positions for a need (every 5-min increment)
                    function getValidPositions(need, tmpl, gs, ge, fMin, otherNeeds) {
                        var positions = [];
                        var gaps = findGaps(tmpl, gs, ge);
                        for (var g = 0; g < gaps.length; g++) {
                            var gap = gaps[g];
                            var ws = Math.max(gap.start, need.windowStart || gs);
                            var we = Math.min(gap.end, need.windowEnd || ge);
                            if (we - ws < need.dMin) continue;
                            // ★ v11.4: Negotiate duration instead of greedily taking dMax
                            var gapSize = gap.end - gap.start;
                            var dur;
                            if (otherNeeds && otherNeeds.length > 0) {
                                dur = negotiateDuration(need, otherNeeds, gapSize, fMin);
                                dur = Math.min(dur, we - ws); // can't exceed available window
                            } else {
                                dur = Math.min(need.dMax, we - ws);
                            }

                            // Scan every 5-min position within the valid range
                            for (var pos = gap.start; pos + dur <= gap.end; pos += 5) {
                                if (pos < ws || pos + dur > we) continue;

                                // Resource checks
                                var ok = true;
                                if (need.type === 'swim') {
                                    ok = canUsePoolAtTime(grade, pos, pos + dur);
                                }
                                if (need.type === 'special' && need._assignedSpecial) {
                                    ok = canUseSpecialAtTime(need._assignedSpecial, grade, pos, pos + dur);
                                }
                                if (need.type === 'rotation_event' && need._rotationEventId) {
                                    ok = canUseRotationSlotAtTime(need._rotationEventId, need._rotationEventConcurrency || 1, grade, pos, pos + dur);
                                }
                                if (!ok) continue;

                                // ★ Cooldown rule check
                                if (window.SchedulingRules && !window.SchedulingRules.isCandidateAllowed(
                                    { startMin: pos, endMin: pos + dur, type: need.type, event: need.event,
                                      field: need._customField || null,
                                      _assignedSpecial: need._assignedSpecial || null,
                                      _specialLocation: need._specialLocation || null },
                                    tmpl, { auto: true })) continue;

                                // Score: dead gap penalty + LCV (how much flexibility remains for others)
                                var lGap = pos - gap.start;
                                var rGap = gap.end - (pos + dur);
                                var deadCount = 0;
                                if (lGap > 0 && lGap < fMin) deadCount++;
                                if (rGap > 0 && rGap < fMin) deadCount++;
                                positions.push({ start: pos, dur: dur, deadGaps: deadCount, lGap: lGap, rGap: rGap });
                            }
                            // Also try exact gap-end alignment (may not be on 5-min boundary)
                            var endAligned = gap.end - dur;
                            if (endAligned >= ws && endAligned >= gap.start && endAligned + dur <= we) {
                                var ok2 = true;
                                if (need.type === 'swim') ok2 = canUsePoolAtTime(grade, endAligned, endAligned + dur);
                                if (need.type === 'special' && need._assignedSpecial) ok2 = canUseSpecialAtTime(need._assignedSpecial, grade, endAligned, endAligned + dur);
                                if (need.type === 'rotation_event' && need._rotationEventId) ok2 = canUseRotationSlotAtTime(need._rotationEventId, need._rotationEventConcurrency || 1, grade, endAligned, endAligned + dur);
                                if (ok2 && window.SchedulingRules) {
                                    ok2 = window.SchedulingRules.isCandidateAllowed(
                                        { startMin: endAligned, endMin: endAligned + dur, type: need.type, event: need.event,
                                          field: need._customField || null,
                                          _assignedSpecial: need._assignedSpecial || null,
                                          _specialLocation: need._specialLocation || null },
                                        tmpl, { auto: true });
                                }
                                if (ok2) {
                                    var rG = gap.end - (endAligned + dur);
                                    positions.push({ start: endAligned, dur: dur, deadGaps: rG > 0 && rG < fMin ? 1 : 0, lGap: endAligned - gap.start, rGap: rG });
                                }
                            }
                        }
                        // Deduplicate
                        var seen = {};
                        positions = positions.filter(function(p) { var k = p.start; if (seen[k]) return false; seen[k] = true; return true; });
                        return positions;
                    }

                    // ── INTELLIGENT SCORING ENGINE ──
                    // Simulates the ENTIRE remaining day to evaluate each position.
                    // Like a chess engine: plays out the game, scores the result.
                    function scorePlacement(pos, need, otherNeeds, tmpl, gs, ge, fMin, sCeiling) {
                        var simBlock = { startMin: pos.start, endMin: pos.start + pos.dur };
                        var simTmpl = tmpl.concat([simBlock]);
                        var score = 0;

                        // 1. LCV: count remaining options for other needs (flexibility)
                        var totalOptions = 0;
                        for (var i = 0; i < otherNeeds.length; i++) {
                            var opts = getValidPositions(otherNeeds[i], simTmpl, gs, ge, fMin).length;
                            if (opts === 0) return -99999; // would kill another need — worst possible
                            totalOptions += opts;
                        }
                        score += totalOptions * 10; // more options = better

                        // 2. Gap quality: simulate how well sports would fill the remaining gaps
                        var gaps = findGaps(simTmpl, gs, ge);
                        var perfectGaps = 0, deadGaps = 0, totalGapTime = 0;
                        for (var g = 0; g < gaps.length; g++) {
                            var gSize = gaps[g].end - gaps[g].start;
                            totalGapTime += gSize;
                            if (gSize < fMin) {
                                deadGaps++; // unfillable — bad
                            } else if (gSize <= sCeiling) {
                                perfectGaps++; // one sport fills it perfectly
                            } else if (gSize % sCeiling === 0 || (gSize / Math.ceil(gSize / sCeiling)) >= fMin) {
                                perfectGaps++; // evenly splittable — good
                            }
                        }
                        score += perfectGaps * 50;   // reward fillable gaps
                        score -= deadGaps * 500;     // heavily penalize dead gaps
                        score -= pos.deadGaps * 200;  // penalize dead gaps from this placement

                        // 2b. ★ v11.4: Neighbor starvation check — would remaining needs
                        // still fit at their dMin in the leftover gaps?
                        var otherMinTotal = 0;
                        for (var om = 0; om < otherNeeds.length; om++) otherMinTotal += otherNeeds[om].dMin || 0;
                        if (totalGapTime < otherMinTotal) {
                            score -= (otherMinTotal - totalGapTime) * 300; // starvation penalty
                        }

                        // 3. Balance: prefer positions that create evenly-sized gaps
                        if (gaps.length >= 2) {
                            var sizes = gaps.map(function(g) { return g.end - g.start; });
                            var avg = totalGapTime / gaps.length;
                            var variance = 0;
                            for (var v = 0; v < sizes.length; v++) {
                                variance += (sizes[v] - avg) * (sizes[v] - avg);
                            }
                            score -= Math.floor(variance / 100); // less variance = better
                        }

                        // 4. Iteration learning: bonus for positions that historically scored well
                        score += iterationMemoryBank.getBonus(grade, need.type, pos.start) * 5;

                        // 5. ★ v11.0: Guided iteration bias — amplify relevant penalties
                        if (iterationBias.category === 'gaps') {
                            score -= deadGaps * 800; // 4x extra penalty when gaps are the issue
                        }
                        if (iterationBias.category === 'missingLayers') {
                            if (['swim', 'snack', 'snacks', 'special'].indexOf(need.type) >= 0) score += 500;
                        }

                        return score;
                    }

                    // AC-3: propagate constraints — if any need has 0 options, fail early
                    function arcConsistent(needsList, tmpl, gs, ge, fMin) {
                        for (var i = 0; i < needsList.length; i++) {
                            var positions = getValidPositions(needsList[i], tmpl, gs, ge, fMin);
                            if (positions.length === 0) return false;
                        }
                        return true;
                    }

                    // Main solver: MCV + LCV + AC-3 + backtracking
                    function solveCSP(needsList, tmpl, gs, ge, fMin, depth, nogoods) {
                        if (needsList.length === 0) return [];
                        if (depth > 15) return null; // ★ v10.0: increased from 10 to handle complex bunks

                        // AC-3: check all needs have at least one option
                        if (!arcConsistent(needsList, tmpl, gs, ge, fMin)) return null;

                        // MCV: pick the need with fewest valid positions
                        // ★ v11.4: Pass other needs for duration negotiation
                        var bestIdx = 0, bestCount = Infinity;
                        var allPositions = [];
                        for (var n = 0; n < needsList.length; n++) {
                            var _others = needsList.slice(0, n).concat(needsList.slice(n + 1));
                            var positions = getValidPositions(needsList[n], tmpl, gs, ge, fMin, _others);
                            allPositions[n] = positions;
                            if (positions.length < bestCount) {
                                bestCount = positions.length;
                                bestIdx = n;
                            }
                        }

                        var chosen = needsList[bestIdx];
                        var positions = allPositions[bestIdx];
                        var remaining = needsList.slice(0, bestIdx).concat(needsList.slice(bestIdx + 1));

                        // Intelligent scoring: simulate future consequences of each position
                        // ★ v10.0: Adaptive candidate limit — explore more at top of tree, prune deeper
                        var candidateLimit = Math.min(positions.length, depth < 4 ? 12 : (depth < 8 ? 8 : 5));
                        // Pre-sort by dead gaps to get best candidates first
                        positions.sort(function(a, b) { return a.deadGaps - b.deadGaps; });
                        var topPositions = positions.slice(0, candidateLimit);

                        var scoredPositions = topPositions.map(function(pos) {
                            var iq = scorePlacement(pos, chosen, remaining, tmpl, gs, ge, fMin, sportCeiling);
                            return { pos: pos, score: -iq }; // negate so lower = better for sort
                        });
                        scoredPositions.sort(function(a, b) { return a.score - b.score; });

                        // Try each position (best first)
                        for (var p = 0; p < scoredPositions.length; p++) {
                            var pos = scoredPositions[p].pos;
                            // Nogood check
                            var nogoodKey = chosen.type + '@' + pos.start;
                            if (nogoods[nogoodKey]) continue;

                            var simBlock = { startMin: pos.start, endMin: pos.start + pos.dur };
                            var simTmpl = tmpl.concat([simBlock]);

                            // ★ v10.0: Inline forward check — prune before recursing
                            var wipeout = false;
                            for (var fc = 0; fc < remaining.length; fc++) {
                                if (getValidPositions(remaining[fc], simTmpl, gs, ge, fMin).length === 0) {
                                    wipeout = true; break;
                                }
                            }
                            if (wipeout) { nogoods[nogoodKey] = true; continue; }

                            var result = solveCSP(remaining, simTmpl, gs, ge, fMin, depth + 1, nogoods);
                            if (result !== null) {
                                result.unshift({ need: chosen, start: pos.start, dur: pos.dur });
                                return result;
                            }
                            // Nogood learning: this position failed, remember it
                            nogoods[nogoodKey] = true;
                        }
                        return null;
                    }

                    // Run the intelligent solver
                    var nogoods = {}; // learned failures
                    var solution = solveCSP(needs, template, gradeStart, gradeEnd, fillMinDur, 0, nogoods);

                    if (solution) {
                        for (var si = 0; si < solution.length; si++) {
                            var sol = solution[si];
                            var need = sol.need;
                            var placeEnd = sol.start + sol.dur;

                            // Register resources
                            if (need.type === 'swim') { registerCrossGrade(grade, 'swim', sol.start, placeEnd, need.event); registerPoolUsage(grade, sol.start, placeEnd); }
                            if (need.type === 'special' && need._assignedSpecial) {
                                registerCrossGrade(grade, 'special', sol.start, placeEnd, need.event);
                                registerSpecialUsage(need._assignedSpecial, grade, sol.start, placeEnd);
                                placedSpecialNames.add(need._assignedSpecial);
                            }
                            if (['snacks', 'snack'].includes((need.type || '').toLowerCase())) { registerCrossGrade(grade, need.type, sol.start, placeEnd, need.event); }
                            if (need.type === 'custom') { registerCrossGrade(grade, 'custom', sol.start, placeEnd, need._customActivity || need.event); }
                            if (need.type === 'rotation_event' && need._rotationEventId) { registerRotationEventUsage(need._rotationEventId, grade, sol.start, placeEnd); registerCrossGrade(grade, 'rotation_event', sol.start, placeEnd, need.event); }

                            var blk = makeBlock({
                                startMin: sol.start, endMin: placeEnd, type: need.type, event: need.event,
                                layer: need.layer, dMin: need.dMin, dMax: need.dMax,
                                _source: need._source || 'need', _activityLocked: need._activityLocked || false,
                                _assignedSpecial: need._assignedSpecial || null,
                                _specialLocation: need._specialLocation || null, _specialDuration: need._specialDuration || null,
                                _customActivity: need._customActivity || null, _customField: need._customField || null,
                                _customBunks: need._customBunks || null,
                                _rotationEventId: need._rotationEventId || null, _rotationEventLocation: need._rotationEventLocation || null,
                                _rotationEventColor: need._rotationEventColor || null, _final: true
                            });
                            if (blk) template.push(blk);
                            // ★ Rotation quota: increment placed counter on successful CSP placement
                            if (need.type === 'rotation_event' && need._rotationEventId && rotationQuotas) {
                                var _rq = rotationQuotas[need._rotationEventId];
                                if (_rq) _rq.placed++;
                            }
                        }
                    } else {
                        // ★ v11.0: CONSTRAINT RELAXATION — structured fallback when CSP fails
                        // Try each need with progressive relaxation levels before giving up
                        for (var fi2 = 0; fi2 < needs.length; fi2++) {
                            var need = needs[fi2];
                            var positions = getValidPositions(need, template, gradeStart, gradeEnd, fillMinDur);
                            var relaxationType = null, relaxationDetail = null;

                            // Level 0: Try original constraints
                            if (positions.length === 0) {
                                // Level 1: Shift time window ±15min
                                var shifted = {};
                                for (var _sk in need) shifted[_sk] = need[_sk];
                                shifted.windowStart = Math.max(gradeStart, (need.windowStart || gradeStart) - 15);
                                shifted.windowEnd = Math.min(gradeEnd, (need.windowEnd || gradeEnd) + 15);
                                positions = getValidPositions(shifted, template, gradeStart, gradeEnd, fillMinDur);
                                if (positions.length > 0) { relaxationType = 'time_shift'; relaxationDetail = '±15min window shift'; }
                            }
                            if (positions.length === 0) {
                                // Level 2: Reduce dMin by 5min (never below type floor)
                                var shortened = {};
                                for (var _sk2 in need) shortened[_sk2] = need[_sk2];
                                var typeFloor = TYPE_FLOORS[(need.type || 'slot').toLowerCase()] || 15;
                                if (need.dMin > typeFloor + 5) {
                                    shortened.dMin = Math.max(typeFloor, need.dMin - 5);
                                    shortened.dMax = Math.max(shortened.dMin, (need.dMax || 60) - 5);
                                    positions = getValidPositions(shortened, template, gradeStart, gradeEnd, fillMinDur);
                                    if (positions.length > 0) { relaxationType = 'duration_reduce'; relaxationDetail = '-5min duration'; need = shortened; }
                                }
                            }
                            if (positions.length === 0) {
                                // Level 3: Combined shift + reduce
                                var combined = {};
                                for (var _sk3 in need) combined[_sk3] = need[_sk3];
                                combined.windowStart = Math.max(gradeStart, (need.windowStart || gradeStart) - 15);
                                combined.windowEnd = Math.min(gradeEnd, (need.windowEnd || gradeEnd) + 15);
                                var typeFloor2 = TYPE_FLOORS[(need.type || 'slot').toLowerCase()] || 15;
                                if (need.dMin > typeFloor2 + 5) {
                                    combined.dMin = Math.max(typeFloor2, need.dMin - 5);
                                    combined.dMax = Math.max(combined.dMin, (need.dMax || 60) - 5);
                                }
                                positions = getValidPositions(combined, template, gradeStart, gradeEnd, fillMinDur);
                                if (positions.length > 0) { relaxationType = 'combined'; relaxationDetail = 'shift+reduce'; need = combined; }
                            }
                            if (positions.length === 0) {
                                // Level 4: Wide shift ±30min
                                var wide = {};
                                for (var _sk4 in need) wide[_sk4] = need[_sk4];
                                wide.windowStart = Math.max(gradeStart, (need.windowStart || gradeStart) - 30);
                                wide.windowEnd = Math.min(gradeEnd, (need.windowEnd || gradeEnd) + 30);
                                positions = getValidPositions(wide, template, gradeStart, gradeEnd, fillMinDur);
                                if (positions.length > 0) { relaxationType = 'wide_shift'; relaxationDetail = '±30min window shift'; }
                            }

                            if (positions.length > 0) {
                                var pos = positions[0];
                                var placeEnd = pos.start + pos.dur;
                                if (need.type === 'swim') { registerCrossGrade(grade, 'swim', pos.start, placeEnd, need.event); registerPoolUsage(grade, pos.start, placeEnd); }
                                if (need.type === 'special' && need._assignedSpecial) {
                                    registerCrossGrade(grade, 'special', pos.start, placeEnd, need.event);
                                    registerSpecialUsage(need._assignedSpecial, grade, pos.start, placeEnd);
                                    placedSpecialNames.add(need._assignedSpecial);
                                }
                                if (['snacks', 'snack'].includes((need.type || '').toLowerCase())) { registerCrossGrade(grade, need.type, pos.start, placeEnd, need.event); }
                                if (need.type === 'custom') { registerCrossGrade(grade, 'custom', pos.start, placeEnd, need._customActivity || need.event); }
                                if (need.type === 'rotation_event' && need._rotationEventId) { registerRotationEventUsage(need._rotationEventId, grade, pos.start, placeEnd); registerCrossGrade(grade, 'rotation_event', pos.start, placeEnd, need.event); }
                                var blk = makeBlock({
                                    startMin: pos.start, endMin: placeEnd, type: need.type, event: need.event,
                                    layer: need.layer, dMin: need.dMin, dMax: need.dMax,
                                    _source: need._source || 'need', _activityLocked: need._activityLocked || false,
                                    _assignedSpecial: need._assignedSpecial || null,
                                    _specialLocation: need._specialLocation || null, _specialDuration: need._specialDuration || null,
                                    _customActivity: need._customActivity || null, _customField: need._customField || null,
                                    _customBunks: need._customBunks || null,
                                    _rotationEventId: need._rotationEventId || null, _rotationEventLocation: need._rotationEventLocation || null,
                                    _rotationEventColor: need._rotationEventColor || null, _final: true,
                                    _relaxed: !!relaxationType, _relaxationType: relaxationType, _relaxationDetail: relaxationDetail
                                });
                                if (need.type === 'rotation_event' && need._rotationEventId && rotationQuotas) {
                                    var _rq2 = rotationQuotas[need._rotationEventId];
                                    if (_rq2) _rq2.placed++;
                                }
                                if (blk) template.push(blk);
                                if (relaxationType) log('[Phase3] CSP-Relax: ' + need.type + '/' + need.event + ' for bunk ' + bunk + ' via ' + relaxationDetail);
                            } else {
                                log('[Phase3] CSP: could not place ' + need.type + '/' + need.event + ' for bunk ' + bunk + ' (even with relaxation)');
                            }
                        }
                    }

                    bunkMeta[bunk] = { grade: grade, template: template, sportC: sportC, fillMinDur: fillMinDur,
                        sportCeiling: sportCeiling, priorityList: priorityList, gradeStart: gradeStart, gradeEnd: gradeEnd,
                        draftSports: draftResult.sports || [], sportLayer: shoppingList.sports?.layer || null };
                }
            }

            // ══════════════════════════════════════════════════════════
            // ★ v9.2: INTELLIGENT SPORT ENGINE
            // Plans the entire sport layout for all bunks simultaneously.
            // For each bunk: analyzes all gaps, computes optimal splits,
            // assigns sport+field with variety awareness and field sharing.
            // ══════════════════════════════════════════════════════════

            var allBunkIds = Object.keys(bunkMeta);
            var usedSports = {};
            for (var ui = 0; ui < allBunkIds.length; ui++) usedSports[allBunkIds[ui]] = new Set();

            // ★ v9.3 LEVEL 1: GLOBAL FIELD DEMAND MAP
            // Counts how many bunks need each field at each 30-min time slot.
            // Fields with HIGH demand are scarce — save them for bunks with fewer alternatives.
            var fieldDemand = {}; // { "fieldName:timeSlot" → demandCount }
            for (var fd = 0; fd < allBunkIds.length; fd++) {
                var fdMeta = bunkMeta[allBunkIds[fd]];
                var fdGaps = findGaps(fdMeta.template, fdMeta.gradeStart, fdMeta.gradeEnd);
                for (var fg = 0; fg < fdGaps.length; fg++) {
                    var fgStart = fdGaps[fg].start, fgEnd = fdGaps[fg].end;
                    // For each sport this bunk could play, mark its fields as demanded
                    for (var fp = 0; fp < fdMeta.priorityList.length; fp++) {
                        var fSport = fdMeta.priorityList[fp];
                        for (var ff = 0; ff < (fSport.fields || []).length; ff++) {
                            var slot = fSport.fields[ff] + ':' + Math.floor(fgStart / 30) * 30;
                            fieldDemand[slot] = (fieldDemand[slot] || 0) + 1;
                        }
                    }
                }
            }

            // ★ v11.2: PREDICTIVE FIELD PRESSURE — real-time utilization ratio per field per time slot
            // Helps findBestSport steer bunks away from fields approaching capacity
            function getFieldPressure(fieldName, startMin, endMin) {
                var ledger = fieldLedger[fieldName];
                if (!ledger) return 0;
                var cap = ledger.capacity || 1;
                var maxClaims = 0;
                for (var t = startMin; t < endMin; t += 5) {
                    var claims = 0;
                    for (var ci = 0; ci < ledger.claims.length; ci++) {
                        if (ledger.claims[ci].startMin < t + 5 && ledger.claims[ci].endMin > t) claims++;
                    }
                    if (claims > maxClaims) maxClaims = claims;
                }
                return maxClaims / cap; // 0 = empty, 1 = at capacity
            }

            // Find best sport + field with CROSS-BUNK AWARENESS
            // Prefers fields with LOW global demand (leaves scarce fields for others)
            function findBestSport(bunk, grade, startMin, endMin, meta, used) {
                var pList = meta.priorityList;
                var timeSlot = Math.floor(startMin / 30) * 30;
                var candidates = [];

                // Collect ALL available sport+field combos
                for (var p = 0; p < pList.length; p++) {
                    var sport = pList[p];
                    var isUsed = used.has(sport.name);
                    var isDrafted = (meta.draftSports || []).some(function(ds) { return ds.name === sport.name; });
                    for (var f = 0; f < (sport.fields || []).length; f++) {
                        if (!isFieldAvailable(sport.fields[f], startMin, endMin, bunk, grade, sport.name)) continue;
                        // Score: drafted unused > unused > reuse. Low demand > high demand.
                        var demand = fieldDemand[sport.fields[f] + ':' + timeSlot] || 0;
                        var score = 0;
                        if (isDrafted && !isUsed) score += 1000;  // best: drafted, not used
                        else if (!isUsed) score += 500;            // good: not used
                        // else: reuse, score stays 0
                        score -= demand * 10;                      // prefer LOW demand fields
                        // ★ v11.0: Multi-day awareness in sport selection
                        if (weekActivityHistory) {
                            var _bh = weekActivityHistory[String(bunk)] || {};
                            var _ds = Infinity;
                            var _rd = getRecentDays(currentDate, 5);
                            for (var _ri = 0; _ri < _rd.length; _ri++) {
                                if ((_bh[_rd[_ri]] || []).indexOf(sport.name) >= 0) { _ds = _ri + 1; break; }
                            }
                            if (_ds <= 1) score -= 300;           // done yesterday — avoid
                            else if (_ds >= 4) score += 200;       // overdue — prefer
                        }
                        // ★ v11.0: Cross-bunk awareness — defer scarce fields
                        if (gradeFieldBudget) {
                            var _bk = grade + ':' + timeSlot;
                            var _bi = gradeFieldBudget[_bk];
                            if (_bi && _bi.demand > _bi.total && candidates.length >= 3) {
                                score -= 200; // I have alternatives, leave scarce fields for others
                            }
                        }
                        // ★ v11.2: Predictive field pressure — avoid fields near capacity
                        var _fp = getFieldPressure(sport.fields[f], startMin, endMin);
                        if (_fp >= 0.8) score -= 150;       // field is nearly full
                        else if (_fp <= 0.2) score += 100;  // field is mostly empty — good
                        candidates.push({ name: sport.name, field: sport.fields[f], score: score });
                    }
                }

                if (candidates.length === 0) return null;
                // Pick the highest-scoring candidate
                candidates.sort(function(a, b) { return b.score - a.score; });
                // ★ Cooldown rule filter — walk candidates in score order, skip blocked
                if (window.SchedulingRules && meta && meta.template) {
                    for (var ci = 0; ci < candidates.length; ci++) {
                        var cand = candidates[ci];
                        var ok = window.SchedulingRules.isCandidateAllowed(
                            { startMin: startMin, endMin: endMin, type: 'sport',
                              event: cand.name, field: cand.field },
                            meta.template, { auto: true });
                        if (ok) return { name: cand.name, field: cand.field };
                    }
                    return null; // all candidates blocked by cooldown
                }
                return { name: candidates[0].name, field: candidates[0].field };
            }

            // Compute optimal split plan for a gap — returns array of {start, end}
            function planGapSplit(gapStart, gapEnd, ceiling, fillMin) {
                var gapSize = gapEnd - gapStart;
                if (gapSize < fillMin) return []; // too small
                if (gapSize <= ceiling) return [{ start: gapStart, end: gapEnd }]; // one block

                // Compute ideal number of blocks where each is in [fillMin, ceiling]
                var numBlocks = Math.ceil(gapSize / ceiling);
                // Ensure each block >= fillMin
                while (numBlocks > 1 && Math.floor(gapSize / numBlocks) < fillMin) numBlocks--;
                var blockDur = Math.round(gapSize / numBlocks / 5) * 5; // snap to 5
                if (blockDur < fillMin) blockDur = Math.floor(gapSize / numBlocks);

                var plan = [];
                var cursor = gapStart;
                for (var i = 0; i < numBlocks; i++) {
                    var dur = (i === numBlocks - 1) ? (gapEnd - cursor) : blockDur;
                    plan.push({ start: cursor, end: cursor + dur });
                    cursor += dur;
                }
                return plan;
            }

            // ★ v9.5: SHARING-AWARE SPORT ENGINE
            // Phase A: Group same-grade bunks with matching gap times → assign shared fields
            // Phase B: Fill remaining gaps individually
            log('[Phase3] Sharing-Aware Sport Engine: planning ' + allBunkIds.length + ' bunks');

            // Phase A: Coordinated sharing — same-grade bunks with matching gaps share fields
            var gradeGroupedBunks = {};
            for (var gi2 = 0; gi2 < allBunkIds.length; gi2++) {
                var gb = allBunkIds[gi2];
                var gm = bunkMeta[gb];
                if (!gradeGroupedBunks[gm.grade]) gradeGroupedBunks[gm.grade] = [];
                gradeGroupedBunks[gm.grade].push(gb);
            }

            Object.keys(gradeGroupedBunks).forEach(function(gradeKey) {
                var gradeBunks = gradeGroupedBunks[gradeKey];
                if (gradeBunks.length <= 1) return; // no sharing possible with 1 bunk

                // Collect all gap blocks across bunks in this grade
                var allGapBlocks = []; // { bunk, start, end }
                for (var gb2 = 0; gb2 < gradeBunks.length; gb2++) {
                    var gbMeta = bunkMeta[gradeBunks[gb2]];
                    var gbGaps = findGaps(gbMeta.template, gbMeta.gradeStart, gbMeta.gradeEnd);
                    for (var gg2 = 0; gg2 < gbGaps.length; gg2++) {
                        var gPlan = planGapSplit(gbGaps[gg2].start, gbGaps[gg2].end, gbMeta.sportCeiling, gbMeta.fillMinDur);
                        for (var gp = 0; gp < gPlan.length; gp++) {
                            allGapBlocks.push({ bunk: gradeBunks[gb2], start: gPlan[gp].start, end: gPlan[gp].end, filled: false });
                        }
                    }
                }

                // ★ v11.0: PROACTIVE SHARING ALIGNMENT
                // Detect overlapping (not identical) gaps between bunks in the same grade.
                // Re-split them to create aligned blocks that the sharing pass can match.
                for (var ai = 0; ai < allGapBlocks.length; ai++) {
                    for (var aj = ai + 1; aj < allGapBlocks.length; aj++) {
                        var aA = allGapBlocks[ai], aB = allGapBlocks[aj];
                        if (aA.bunk === aB.bunk || aA.filled || aB.filled) continue;
                        if (aA.start === aB.start && aA.end === aB.end) continue; // already exact match
                        var oStart = Math.max(aA.start, aB.start);
                        var oEnd = Math.min(aA.end, aB.end);
                        var aFillMin = bunkMeta[aA.bunk].fillMinDur;
                        if (oEnd - oStart < aFillMin) continue;
                        // Check if a shared-capacity field exists for this overlap window
                        var hasSharedField = false;
                        var _flKeys = Object.keys(fieldLedger);
                        for (var _fk = 0; _fk < _flKeys.length; _fk++) {
                            var _fl = fieldLedger[_flKeys[_fk]];
                            if (_fl.capacity >= 2 && !_fl._isSpecialLocation && _fl.activities.length > 0) {
                                if (isFieldAvailable(_flKeys[_fk], oStart, oEnd, aA.bunk, gradeKey)) {
                                    hasSharedField = true; break;
                                }
                            }
                        }
                        if (!hasSharedField) continue;
                        // Align: carve out the overlap as new exact-match blocks
                        var aCeiling = bunkMeta[aA.bunk].sportCeiling;
                        var sharedDur = Math.min(oEnd - oStart, aCeiling);
                        var aBeforeA = oStart - aA.start, aAfterA = aA.end - (oStart + sharedDur);
                        var aBeforeB = oStart - aB.start, aAfterB = aB.end - (oStart + sharedDur);
                        // Replace A and B with aligned blocks
                        aA.start = oStart; aA.end = oStart + sharedDur; aA._alignedForSharing = true;
                        aB.start = oStart; aB.end = oStart + sharedDur; aB._alignedForSharing = true;
                        // Add back leftover fragments
                        if (aBeforeA >= aFillMin) allGapBlocks.push({ bunk: aA.bunk, start: oStart - aBeforeA, end: oStart, filled: false });
                        if (aAfterA >= aFillMin) allGapBlocks.push({ bunk: aA.bunk, start: oStart + sharedDur, end: oStart + sharedDur + aAfterA, filled: false });
                        if (aBeforeB >= aFillMin) allGapBlocks.push({ bunk: aB.bunk, start: oStart - aBeforeB, end: oStart, filled: false });
                        if (aAfterB >= aFillMin) allGapBlocks.push({ bunk: aB.bunk, start: oStart + sharedDur, end: oStart + sharedDur + aAfterB, filled: false });
                        break; // move on after first alignment per block
                    }
                }

                // Group by exact time match (same start AND end)
                var timeGroups = {};
                for (var tg = 0; tg < allGapBlocks.length; tg++) {
                    var key = allGapBlocks[tg].start + '-' + allGapBlocks[tg].end;
                    if (!timeGroups[key]) timeGroups[key] = [];
                    timeGroups[key].push(allGapBlocks[tg]);
                }

                // For groups with 2+ bunks at same time: assign SHARED fields
                Object.keys(timeGroups).forEach(function(timeKey) {
                    var group = timeGroups[timeKey];
                    if (group.length < 2) return; // no sharing needed
                    var startMin = group[0].start, endMin = group[0].end;
                    var gMeta = bunkMeta[group[0].bunk];

                    // Find a sport+field that can host multiple bunks (capacity > 1)
                    var pList = gMeta.priorityList;
                    for (var sp = 0; sp < pList.length; sp++) {
                        var sport = pList[sp];
                        for (var sf = 0; sf < (sport.fields || []).length; sf++) {
                            var fieldName = sport.fields[sf];
                            var ledger = fieldLedger[fieldName];
                            if (!ledger || ledger.capacity < 2) continue;

                            // Check how many bunks can share this field
                            var shareable = [];
                            for (var sb = 0; sb < group.length; sb++) {
                                if (group[sb].filled) continue;
                                if (isFieldAvailable(fieldName, startMin, endMin, group[sb].bunk, gradeKey, sport.name)) {
                                    shareable.push(group[sb]);
                                    if (shareable.length >= ledger.capacity) break;
                                }
                            }

                            if (shareable.length >= 2) {
                                // Assign ALL shareable bunks to this field at the same time
                                for (var sh = 0; sh < shareable.length; sh++) {
                                    claimField(fieldName, startMin, endMin, shareable[sh].bunk, gradeKey, sport.name);
                                    usedSports[shareable[sh].bunk].add(sport.name);
                                    var shMeta = bunkMeta[shareable[sh].bunk];
                                    var shBlk = makeBlock({
                                        startMin: startMin, endMin: endMin,
                                        type: 'sport', event: sport.name,
                                        layer: shMeta.sportLayer, field: fieldName,
                                        dMin: shMeta.sportC.dMin, dMax: shMeta.sportCeiling,
                                        _source: 'sport-fill', _assignedSport: sport.name,
                                        _sportFallbacks: shMeta.priorityList.map(function(s) { return s.name; }),
                                        _final: true
                                    });
                                    if (shBlk) shMeta.template.push(shBlk);
                                    shareable[sh].filled = true;
                                }
                                break; // done with this time group for this sport
                            }
                        }
                        if (group.every(function(g) { return g.filled; })) break;
                    }
                });

                // Mark filled blocks so Phase B skips them
                for (var mf = 0; mf < allGapBlocks.length; mf++) {
                    if (allGapBlocks[mf].filled) {
                        // Already handled by sharing
                    }
                }
            });

            // ══════════════════════════════════════════════════════════
            // ★ v11.0: BOTTLENECK-FIRST SCHEDULING + CROSS-BUNK BUDGET
            // Build contention heatmap and grade field budget before Phase B.
            // Sort gap assignments by contention (highest deficit first).
            // ══════════════════════════════════════════════════════════

            var gradeFieldBudget = {};
            var contentionMap = {};
            var campStartGlobal = Math.min.apply(null, allGrades.map(function(g) { return parseTimeToMinutes(divisions[g]?.startTime) || 540; }));
            var campEndGlobal = Math.max.apply(null, allGrades.map(function(g) { return parseTimeToMinutes(divisions[g]?.endTime) || 960; }));

            // Build supply map: field capacity per grade per 30-min slot
            for (var ct = campStartGlobal; ct < campEndGlobal; ct += 30) {
                var ctEnd = Math.min(ct + 30, campEndGlobal);
                allGrades.forEach(function(cGrade) {
                    var supply = 0;
                    Object.values(fieldLedger).forEach(function(ledger) {
                        if (isRainy && !ledger.isIndoor) return;
                        if (ledger._isSpecialLocation) return;
                        if (ledger.activities.length === 0) return;
                        var timeOk = ledger.timeRules.some(function(rule) {
                            return rule.startMin <= ct && rule.endMin >= ctEnd &&
                                   (!rule.divisions || rule.divisions.indexOf(cGrade) >= 0);
                        });
                        if (!timeOk) return;
                        var claims = ledger.claims.filter(function(c) { return c.startMin < ctEnd && c.endMin > ct; });
                        var crossGrade = claims.some(function(c) { return c.grade !== cGrade; });
                        if (ledger.shareType === 'not_sharable') { if (claims.length === 0) supply += 1; }
                        else if (ledger.shareType === 'same_division') { if (!crossGrade) supply += Math.max(0, ledger.capacity - claims.filter(function(c) { return c.grade === cGrade; }).length); }
                        else { supply += Math.max(0, ledger.capacity - claims.length); }
                    });
                    contentionMap[ct + ':' + cGrade] = { supply: supply, demand: 0, bunks: [] };
                });
            }

            // Build demand map: count bunks needing fields per grade per 30-min slot
            allBunkIds.forEach(function(cBunk) {
                var cMeta = bunkMeta[cBunk];
                if (!cMeta) return;
                var cGaps = findGaps(cMeta.template, cMeta.gradeStart, cMeta.gradeEnd);
                cGaps.forEach(function(cGap) {
                    for (var ct2 = Math.floor(cGap.start / 30) * 30; ct2 < cGap.end; ct2 += 30) {
                        var cKey = ct2 + ':' + cMeta.grade;
                        if (contentionMap[cKey]) {
                            contentionMap[cKey].demand++;
                            contentionMap[cKey].bunks.push(cBunk);
                        }
                    }
                });
            });

            // Build grade field budget from contention map
            Object.keys(contentionMap).forEach(function(cKey) {
                var entry = contentionMap[cKey];
                entry.deficit = entry.demand - entry.supply;
                gradeFieldBudget[cKey] = { total: entry.supply, demand: entry.demand, perBunk: entry.demand > 0 ? Math.floor(entry.supply / entry.demand) : entry.supply };
            });

            // Build contention-sorted gap queue for Phase B
            var gapQueue = [];
            allBunkIds.forEach(function(qBunk) {
                var qMeta = bunkMeta[qBunk];
                if (!qMeta) return;
                var qGaps = findGaps(qMeta.template, qMeta.gradeStart, qMeta.gradeEnd);
                qGaps.forEach(function(qGap) {
                    if (qGap.end - qGap.start < qMeta.fillMinDur) return;
                    var maxDeficit = 0;
                    for (var qt = Math.floor(qGap.start / 30) * 30; qt < qGap.end; qt += 30) {
                        var qEntry = contentionMap[qt + ':' + qMeta.grade];
                        if (qEntry && qEntry.deficit > maxDeficit) maxDeficit = qEntry.deficit;
                    }
                    gapQueue.push({ bunk: qBunk, gap: qGap, contention: maxDeficit });
                });
            });
            gapQueue.sort(function(a, b) { return b.contention - a.contention; });
            log('[Phase3] Bottleneck queue: ' + gapQueue.length + ' gaps, max contention=' + (gapQueue.length > 0 ? gapQueue[0].contention : 0));

            // Phase B: AGGRESSIVE gap filling — BOTTLENECK-FIRST ORDER
            // Processes gaps by contention (most constrained time windows first)
            for (var si = 0; si < gapQueue.length; si++) {
                var sBunk = gapQueue[si].bunk;
                var sMeta = bunkMeta[sBunk];
                var sGaps = [gapQueue[si].gap]; // process one gap at a time from the queue

                for (var sg = 0; sg < sGaps.length; sg++) {
                    var gap = sGaps[sg];
                    var gapSize = gap.end - gap.start;
                    if (gapSize < sMeta.fillMinDur) continue;

                    // Try to fill the entire gap with sport blocks that each have a field
                    var cursor = gap.start;
                    var maxAttempts = 20; // safety limit

                    while (cursor < gap.end && maxAttempts-- > 0) {
                        var remaining = gap.end - cursor;
                        if (remaining < sMeta.fillMinDur) break;

                        var dur = Math.min(remaining, sMeta.sportCeiling);
                        // Check if remainder after this block would be dead
                        var leftover = remaining - dur;
                        if (leftover > 0 && leftover < sMeta.fillMinDur) {
                            dur = Math.floor(remaining / 2);
                            if (dur < sMeta.fillMinDur) dur = remaining;
                        }
                        if (dur > sMeta.sportCeiling) dur = sMeta.sportCeiling;

                        var blockEnd = cursor + dur;
                        var result = null;

                        // Strategy 1: full duration from cursor
                        result = findBestSport(sBunk, sMeta.grade, cursor, blockEnd, sMeta, usedSports[sBunk]);

                        // Strategy 2: try shorter durations (scan from fillMinDur up)
                        if (!result) {
                            for (var tryDur = sMeta.fillMinDur; tryDur <= dur; tryDur += 5) {
                                result = findBestSport(sBunk, sMeta.grade, cursor, cursor + tryDur, sMeta, usedSports[sBunk]);
                                if (result) { blockEnd = cursor + tryDur; break; }
                            }
                        }

                        // Strategy 3: try from the END of the gap working backward
                        if (!result && gap.end - sMeta.fillMinDur >= cursor) {
                            for (var tryEnd = gap.end; tryEnd - sMeta.fillMinDur >= cursor; tryEnd -= 5) {
                                var tryStart = Math.max(cursor, tryEnd - sMeta.sportCeiling);
                                result = findBestSport(sBunk, sMeta.grade, tryStart, tryEnd, sMeta, usedSports[sBunk]);
                                if (result) { cursor = tryStart; blockEnd = tryEnd; break; }
                            }
                        }

                        if (result) {
                            claimField(result.field, cursor, blockEnd, sBunk, sMeta.grade, result.name);
                            usedSports[sBunk].add(result.name);
                        }
                        var blk = makeBlock({
                            startMin: cursor, endMin: blockEnd,
                            type: result ? 'sport' : 'slot',
                            event: result ? result.name : 'General Activity Slot',
                            layer: sMeta.sportLayer, field: result ? result.field : null,
                            dMin: sMeta.sportC.dMin, dMax: sMeta.sportCeiling,
                            _source: 'sport-fill',
                            _assignedSport: result ? result.name : null,
                            _sportFallbacks: sMeta.priorityList.map(function(s) { return s.name; }),
                            _final: true
                        });
                        if (blk) sMeta.template.push(blk);
                        cursor = blockEnd;
                    }
                }
            }

            // ══════════════════════════════════════════════════════════
            // STEP 5: Fill remaining gaps
            // ══════════════════════════════════════════════════════════
            for (var fi = 0; fi < allBunkIds.length; fi++) {
                var fBunk = allBunkIds[fi];
                var fMeta = bunkMeta[fBunk];
                var tmpl = fMeta.template;
                tmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                var remainingGaps = findGaps(tmpl, fMeta.gradeStart, fMeta.gradeEnd);
                for (var rg = 0; rg < remainingGaps.length; rg++) {
                    var rgap = remainingGaps[rg];
                    var gapSize = rgap.end - rgap.start;
                    if (gapSize <= 0) continue;

                    if (gapSize >= fMeta.fillMinDur) {
                        // Use addSportBlocks — it auto-splits if gap exceeds ceiling
                        var rResult = findBestSport(fBunk, fMeta.grade, rgap.start, rgap.end, fMeta, usedSports[fBunk]);
                        if (rResult) {
                            claimField(rResult.field, rgap.start, rgap.end, fBunk, fMeta.grade, rResult.name);
                            usedSports[fBunk].add(rResult.name);
                        }
                        addSportBlocks(tmpl, rgap.start, rgap.end, {
                            type: rResult ? 'sport' : 'slot',
                            event: rResult ? rResult.name : 'General Activity Slot',
                            layer: fMeta.sportLayer, field: rResult ? rResult.field : null,
                            dMin: fMeta.sportC.dMin, dMax: fMeta.sportCeiling,
                            _source: 'filler',
                            _assignedSport: rResult ? rResult.name : null,
                            _sportFallbacks: fMeta.priorityList.map(function(s) { return s.name; }),
                            _final: true
                        }, fMeta.sportCeiling, fMeta.fillMinDur);
                    } else {
                        // Too small for a sport — absorb into adjacent non-fixed block
                        tmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                        var absorbed = false;
                        // ★ v10.5: Use block's own dMax for absorb limit, not sportCeiling
                        for (var m2 = 0; m2 < tmpl.length; m2++) {
                            // Find block ending at gap start
                            if (tmpl[m2].endMin === rgap.start && !tmpl[m2]._fixed) {
                                var m2Dur = tmpl[m2].endMin - tmpl[m2].startMin;
                                var m2Max = tmpl[m2].dMax || fMeta.sportCeiling;
                                if (m2Dur + gapSize <= m2Max) { tmpl[m2].endMin += gapSize; absorbed = true; break; }
                            }
                            // Find block starting at gap end
                            if (tmpl[m2].startMin === rgap.end && !tmpl[m2]._fixed) {
                                var m2Dur2 = tmpl[m2].endMin - tmpl[m2].startMin;
                                var m2Max2 = tmpl[m2].dMax || fMeta.sportCeiling;
                                if (m2Dur2 + gapSize <= m2Max2) { tmpl[m2].startMin -= gapSize; absorbed = true; break; }
                            }
                        }
                        if (!absorbed) {
                            // Can't absorb — create slot only if >= dMin
                            var _lastResort = makeBlock({
                                startMin: rgap.start, endMin: rgap.end,
                                type: 'slot', event: 'General Activity Slot',
                                layer: fMeta.sportLayer, field: null,
                                dMin: fMeta.fillMinDur, dMax: fMeta.sportCeiling,
                                _source: 'filler', _final: true
                            });
                            if (_lastResort) tmpl.push(_lastResort);
                            // else: gap is below dMin, left unfilled (scorer handles it)
                        }
                    }
                }
            }

            // ══════════════════════════════════════════════════════════
            // STEP 6: Validate, enforce dMax, and return
            // ══════════════════════════════════════════════════════════
            var totalWarnings = 0;
            for (var vi = 0; vi < allBunkIds.length; vi++) {
                var vBunk = allBunkIds[vi];
                var vMeta = bunkMeta[vBunk];
                var vTmpl = vMeta.template;
                vTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                // ★ v10.5: Merge any below-dMin sport/slot blocks into adjacent blocks
                // Uses block's own dMax (not sportCeiling) to prevent exceeding configured max
                for (var mi = vTmpl.length - 1; mi >= 0; mi--) {
                    var mBlk = vTmpl[mi];
                    if (mBlk._fixed) continue;
                    var mType = (mBlk.type || '').toLowerCase();
                    if (!['sport', 'slot'].includes(mType)) continue;
                    var mDur = mBlk.endMin - mBlk.startMin;
                    if (mDur >= vMeta.fillMinDur) continue;
                    // This block is too short — merge into neighbor
                    var merged = false;
                    // Try merging into previous block
                    if (mi > 0 && !vTmpl[mi-1]._fixed) {
                        var prevType = (vTmpl[mi-1].type || '').toLowerCase();
                        var prevMaxDur = vTmpl[mi-1].dMax || vMeta.sportCeiling;
                        if (['sport', 'slot'].includes(prevType) && (vTmpl[mi-1].endMin - vTmpl[mi-1].startMin) + mDur <= prevMaxDur) {
                            vTmpl[mi-1].endMin = mBlk.endMin;
                            vTmpl.splice(mi, 1);
                            merged = true;
                        }
                    }
                    // Try merging into next block
                    if (!merged && mi < vTmpl.length - 1 && !vTmpl[mi+1]._fixed) {
                        var nextType = (vTmpl[mi+1].type || '').toLowerCase();
                        var nextMaxDur = vTmpl[mi+1].dMax || vMeta.sportCeiling;
                        if (['sport', 'slot'].includes(nextType) && (vTmpl[mi+1].endMin - vTmpl[mi+1].startMin) + mDur <= nextMaxDur) {
                            vTmpl[mi+1].startMin = mBlk.startMin;
                            vTmpl.splice(mi, 1);
                            merged = true;
                        }
                    }
                    // If can't merge, remove it (leave as gap for scorer)
                    if (!merged && mDur < 10) {
                        vTmpl.splice(mi, 1);
                    }
                }
                vTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                // ★ v9.7: OVERLAP RESOLUTION — remove overlapping blocks
                for (var oi = vTmpl.length - 1; oi > 0; oi--) {
                    if (vTmpl[oi].startMin < vTmpl[oi-1].endMin) {
                        // Overlap! Keep the fixed/longer one, trim or remove the other
                        if (vTmpl[oi]._fixed && !vTmpl[oi-1]._fixed) {
                            // Trim prev to end before this block
                            vTmpl[oi-1].endMin = vTmpl[oi].startMin;
                            if (vTmpl[oi-1].endMin <= vTmpl[oi-1].startMin) vTmpl.splice(oi-1, 1);
                        } else if (!vTmpl[oi]._fixed && vTmpl[oi-1]._fixed) {
                            // Trim this block to start after prev
                            vTmpl[oi].startMin = vTmpl[oi-1].endMin;
                            if (vTmpl[oi].endMin <= vTmpl[oi].startMin) vTmpl.splice(oi, 1);
                        } else {
                            // Both same priority — keep longer, remove shorter
                            var durPrev = vTmpl[oi-1].endMin - vTmpl[oi-1].startMin;
                            var durCur = vTmpl[oi].endMin - vTmpl[oi].startMin;
                            if (durPrev >= durCur) {
                                vTmpl[oi].startMin = vTmpl[oi-1].endMin;
                                if (vTmpl[oi].endMin <= vTmpl[oi].startMin) vTmpl.splice(oi, 1);
                            } else {
                                vTmpl[oi-1].endMin = vTmpl[oi].startMin;
                                if (vTmpl[oi-1].endMin <= vTmpl[oi-1].startMin) vTmpl.splice(oi-1, 1);
                            }
                        }
                    }
                }
                vTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                // ★ v10.5: BELOW-dMIN SWEEP — use block's own dMin, not just fillMinDur
                for (var di = vTmpl.length - 1; di >= 0; di--) {
                    var dBlk = vTmpl[di];
                    if (dBlk._fixed) continue;
                    var dType = (dBlk.type || '').toLowerCase();
                    if (!['sport', 'slot'].includes(dType)) continue;
                    var dDur = dBlk.endMin - dBlk.startMin;
                    // Use the block's own dMin if available, fall back to fillMinDur
                    var dMinReq = Math.max(dBlk.dMin || 0, vMeta.fillMinDur);
                    var dMaxLimit = dBlk.dMax || vMeta.sportCeiling;
                    if (dDur >= dMinReq) continue;

                    // Try to extend into adjacent gap (not into another block)
                    var nextStart = (di < vTmpl.length - 1) ? vTmpl[di+1].startMin : vMeta.gradeEnd;
                    var availRight = nextStart - dBlk.endMin;
                    if (dDur + availRight >= dMinReq) {
                        var extTarget = Math.min(dMinReq, dMaxLimit);
                        dBlk.endMin = dBlk.startMin + extTarget;
                        dBlk.endMin = Math.round(dBlk.endMin / 5) * 5;
                        continue;
                    }
                    var prevEnd = (di > 0) ? vTmpl[di-1].endMin : vMeta.gradeStart;
                    var availLeft = dBlk.startMin - prevEnd;
                    if (dDur + availLeft >= dMinReq) {
                        var extTarget2 = Math.min(dMinReq, dMaxLimit);
                        dBlk.startMin = dBlk.endMin - extTarget2;
                        dBlk.startMin = Math.round(dBlk.startMin / 5) * 5;
                        continue;
                    }
                    // Can't fix — merge into neighbor, respecting neighbor's dMax
                    if (di > 0 && !vTmpl[di-1]._fixed && ['sport','slot'].includes((vTmpl[di-1].type||'').toLowerCase())) {
                        var neighborMax = vTmpl[di-1].dMax || vMeta.sportCeiling;
                        if ((vTmpl[di-1].endMin - vTmpl[di-1].startMin) + dDur <= neighborMax) {
                            vTmpl[di-1].endMin = dBlk.endMin;
                            vTmpl.splice(di, 1);
                        }
                    } else if (di < vTmpl.length - 1 && !vTmpl[di+1]._fixed && ['sport','slot'].includes((vTmpl[di+1].type||'').toLowerCase())) {
                        var neighborMax2 = vTmpl[di+1].dMax || vMeta.sportCeiling;
                        if ((vTmpl[di+1].endMin - vTmpl[di+1].startMin) + dDur <= neighborMax2) {
                            vTmpl[di+1].startMin = dBlk.startMin;
                            vTmpl.splice(di, 1);
                        }
                    } else if (di > 0 && !vTmpl[di-1]._fixed) {
                        // ★ v10.5: Absorb into ANY non-fixed neighbor (not just sport/slot)
                        vTmpl[di-1].endMin = dBlk.endMin;
                        vTmpl.splice(di, 1);
                    } else if (di < vTmpl.length - 1 && !vTmpl[di+1]._fixed) {
                        vTmpl[di+1].startMin = dBlk.startMin;
                        vTmpl.splice(di, 1);
                    } else {
                        // Between two fixed walls — try to force dMin by extending into
                        // the smaller adjacent gap (even if it overlaps a wall slightly),
                        // then re-resolve. If truly impossible, merge into the nearest
                        // non-fixed neighbor anywhere in the timeline.
                        var dFixed = false;
                        if (['sport', 'slot'].includes(dType)) {
                            // ★ v14.0: Try to extend to dMin even between walls.
                            // If the gap between walls IS the block, extend to fill the
                            // entire wall-to-wall space (it's the best we can do).
                            var wallLeft = (di > 0) ? vTmpl[di-1].endMin : vMeta.gradeStart;
                            var wallRight = (di < vTmpl.length - 1) ? vTmpl[di+1].startMin : vMeta.gradeEnd;
                            var wallGap = wallRight - wallLeft;
                            if (wallGap >= dMinReq) {
                                // There IS enough space between walls — center the block
                                dBlk.startMin = wallLeft;
                                dBlk.endMin = wallLeft + Math.min(dMinReq, dMaxLimit);
                                dBlk.endMin = Math.round(dBlk.endMin / 5) * 5;
                                dFixed = true;
                            } else if (wallGap > 0) {
                                // Wall gap < dMin — fill the entire gap and accept it
                                dBlk.startMin = wallLeft;
                                dBlk.endMin = wallRight;
                                // If still < ABSOLUTE_FLOOR (5min), merge into nearest non-fixed
                                if (wallGap < 5) {
                                    // Find any non-fixed neighbor in the whole timeline
                                    for (var dmi = 0; dmi < vTmpl.length; dmi++) {
                                        if (dmi === di || vTmpl[dmi]._fixed) continue;
                                        if (['sport','slot'].includes((vTmpl[dmi].type||'').toLowerCase())) {
                                            var nmMax = vTmpl[dmi].dMax || vMeta.sportCeiling;
                                            if ((vTmpl[dmi].endMin - vTmpl[dmi].startMin) + dDur <= nmMax) {
                                                // Absorb: give time to this neighbor
                                                if (vTmpl[dmi].endMin === dBlk.startMin) vTmpl[dmi].endMin = dBlk.endMin;
                                                else if (vTmpl[dmi].startMin === dBlk.endMin) vTmpl[dmi].startMin = dBlk.startMin;
                                                vTmpl.splice(di, 1);
                                                dFixed = true;
                                                break;
                                            }
                                        }
                                    }
                                    if (!dFixed) { vTmpl.splice(di, 1); dFixed = true; }
                                } else {
                                    dFixed = true; // Kept at wall-to-wall size
                                }
                            }
                        }
                        if (!dFixed) {
                            // For swim/snack/special or truly unfixable: remove
                            vTmpl.splice(di, 1);
                        }
                    }
                }
                vTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                // ★ v10.0: Integrity check after below-dMin sweep
                bunkTimelines[vBunk] = vTmpl;
                ensureTimelineIntegrity(vBunk);
                vTmpl = bunkTimelines[vBunk];

                var vGaps = findGaps(vTmpl, vMeta.gradeStart, vMeta.gradeEnd);
                // ★ v10.1: PERFECTION PASS — fill remaining gaps by extending neighbors or creating blocks
                if (vGaps.length > 0) {
                    for (var vgi = 0; vgi < vGaps.length; vgi++) {
                        var vGap = vGaps[vgi];
                        var vGapDur = vGap.end - vGap.start;
                        if (vGapDur <= 0) continue;
                        var filled = false;

                        // ★ v10.2: Only extend sport/slot blocks — never swim/snack/special/league
                        var EXTENDABLE_TYPES = { sport: 1, slot: 1, sports: 1 };

                        // Strategy 1: Extend previous sport/slot block to cover the gap
                        var prevBlock = null;
                        for (var pb = vTmpl.length - 1; pb >= 0; pb--) {
                            if (vTmpl[pb].endMin <= vGap.start && !vTmpl[pb]._fixed
                                && EXTENDABLE_TYPES[(vTmpl[pb].type || '').toLowerCase()]) {
                                prevBlock = vTmpl[pb]; break;
                            }
                        }
                        // ★ v10.5: Use block's own dMax for extension limit
                        if (prevBlock && prevBlock.endMin === vGap.start) {
                            var maxExt = prevBlock.dMax || vMeta.sportCeiling || 60;
                            var newDur = (vGap.end) - prevBlock.startMin;
                            if (newDur <= maxExt) {
                                prevBlock.endMin = vGap.end;
                                filled = true;
                            }
                        }

                        // Strategy 2: Pull next sport/slot block backward to cover the gap
                        if (!filled) {
                            var nextBlock = null;
                            for (var nb = 0; nb < vTmpl.length; nb++) {
                                if (vTmpl[nb].startMin >= vGap.end && !vTmpl[nb]._fixed
                                    && EXTENDABLE_TYPES[(vTmpl[nb].type || '').toLowerCase()]) {
                                    nextBlock = vTmpl[nb]; break;
                                }
                            }
                            if (nextBlock && nextBlock.startMin === vGap.end) {
                                var newDur2 = nextBlock.endMin - vGap.start;
                                var maxExt2 = nextBlock.dMax || vMeta.sportCeiling || 60;
                                if (newDur2 <= maxExt2) {
                                    nextBlock.startMin = vGap.start;
                                    filled = true;
                                }
                            }
                        }

                        // Strategy 3: Create a new sport block to fill the gap (even if short)
                        if (!filled) {
                            addSportBlocks(vTmpl, vGap.start, vGap.end, {
                                type: 'slot', event: 'General Activity Slot',
                                layer: vMeta.sportLayer, field: null,
                                dMin: Math.min(vGapDur, vMeta.fillMinDur), dMax: vMeta.sportCeiling,
                                _source: 'perfection-fill',
                                _sportFallbacks: vMeta.priorityList ? vMeta.priorityList.map(function(s) { return s.name; }) : [],
                                _final: true
                            }, vMeta.sportCeiling || 60, Math.min(vGapDur, vMeta.fillMinDur));
                            filled = true;
                        }
                    }
                    vTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                    // Recheck gaps after filling
                    var remainingGaps = findGaps(vTmpl, vMeta.gradeStart, vMeta.gradeEnd);
                    if (remainingGaps.length > 0) {
                        log('[Phase3] WARN: bunk ' + vBunk + ' has ' + remainingGaps.length + ' unfilled gaps after perfection pass');
                        totalWarnings++;
                    }
                }

                allTemplates[vBunk] = vTmpl;
            }

            // ══════════════════════════════════════════════════════════
            // ★ v9.4: SELF-HEALING — fix missing required layers BEFORE scoring
            // After sports fill all gaps, check if any required layer is missing.
            // If so, sacrifice a sport block and replace it with the layer.
            // ══════════════════════════════════════════════════════════
            var healCount = 0;
            for (var hi = 0; hi < allBunkIds.length; hi++) {
                var hBunk = allBunkIds[hi];
                var hMeta = bunkMeta[hBunk];
                // ★ v10.3: Use live bunkTimelines, not potentially stale template reference
                var hTmpl = bunkTimelines[hBunk] || hMeta.template;
                hTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                var hGrade = hMeta.grade;
                var hLayers = layersByGrade[hGrade] || [];

                for (var hl = 0; hl < hLayers.length; hl++) {
                    var hll = hLayers[hl];
                    var hlt = (hll.type || '').toLowerCase();
                    if (!['swim', 'snack', 'snacks', 'special'].includes(hlt)) continue;

                    // ★ v10.4: For specials, resolve the actual name from draft results
                    var hSpecialName = null, hSpecialLocation = null, hSpecialDuration = null;
                    if (hlt === 'special') {
                        var hDraft = draftResults[hBunk];
                        if (hDraft && hDraft.specials && hDraft.specials.length > 0) {
                            var hDraftSpecial = hDraft.specials[0];
                            hSpecialName = hDraftSpecial.name;
                            hSpecialLocation = hDraftSpecial.location || hDraftSpecial.claimedField;
                            hSpecialDuration = hDraftSpecial.duration;
                        }
                        // If no draft special exists for this bunk, skip — nothing real to place
                        if (!hSpecialName) continue;
                    }

                    // Check if already placed
                    var hHasIt = hTmpl.some(function(b) {
                        var bt = (b.type || '').toLowerCase();
                        if (hlt === 'special') return bt === 'special';
                        return bt === hlt || (hlt === 'snacks' && bt === 'snack');
                    });
                    if (hHasIt) continue;

                    // Missing! Find a sport/slot block to sacrifice
                    var hlc = resolveConstraints(hll, hlt);
                    var hNeedDMin = (hlt === 'special' && hSpecialDuration) ? hSpecialDuration : (hlc.dMin || 15);
                    var hWinStart = hll.startMin || hMeta.gradeStart;
                    var hWinEnd = hll.endMin || hMeta.gradeEnd;

                    // ★ v10.2: Two-pass search — first inside the window, then ANYWHERE
                    // Missing swim is unacceptable. Better at a non-ideal time than not at all.
                    var hBestIdx = -1, hBestFit = Infinity;
                    for (var hsi = 0; hsi < hTmpl.length; hsi++) {
                        var hblk = hTmpl[hsi];
                        if (hblk._fixed) continue;
                        var hbt = (hblk.type || '').toLowerCase();
                        if (!['sport', 'slot'].includes(hbt)) continue;
                        if (hblk.startMin < hWinStart || hblk.endMin > hWinEnd) continue;
                        var hblkDur = hblk.endMin - hblk.startMin;
                        if (hblkDur < hNeedDMin) continue;
                        var hfit = Math.abs(hblkDur - hNeedDMin);
                        if (hfit < hBestFit) { hBestFit = hfit; hBestIdx = hsi; }
                    }
                    // Pass 2: If nothing found in window, search the ENTIRE day
                    if (hBestIdx < 0) {
                        for (var hsi2 = 0; hsi2 < hTmpl.length; hsi2++) {
                            var hblk2 = hTmpl[hsi2];
                            if (hblk2._fixed) continue;
                            var hbt2 = (hblk2.type || '').toLowerCase();
                            if (!['sport', 'slot'].includes(hbt2)) continue;
                            var hblkDur2 = hblk2.endMin - hblk2.startMin;
                            if (hblkDur2 < hNeedDMin) continue;
                            var hfit2 = Math.abs(hblkDur2 - hNeedDMin);
                            if (hfit2 < hBestFit) { hBestFit = hfit2; hBestIdx = hsi2; }
                        }
                    }
                    // ★ v14.0 Pass 3: Merge two adjacent sport/slot blocks to create space
                    if (hBestIdx < 0) {
                        for (var hmi = 0; hmi < hTmpl.length - 1; hmi++) {
                            var hm1 = hTmpl[hmi], hm2 = hTmpl[hmi + 1];
                            if (hm1._fixed || hm2._fixed) continue;
                            var hm1t = (hm1.type || '').toLowerCase();
                            var hm2t = (hm2.type || '').toLowerCase();
                            if (!['sport', 'slot'].includes(hm1t) || !['sport', 'slot'].includes(hm2t)) continue;
                            if (hm1.endMin !== hm2.startMin) continue;
                            var hCombined = hm2.endMin - hm1.startMin;
                            if (hCombined >= hNeedDMin) {
                                hm1.endMin = hm2.endMin;
                                hTmpl.splice(hmi + 1, 1);
                                hBestIdx = hmi;
                                hBestFit = Math.abs(hCombined - hNeedDMin);
                                break;
                            }
                        }
                    }

                    if (hBestIdx >= 0) {
                        var hVictim = hTmpl[hBestIdx];
                        // ★ v11.1: Clamp placement to layer window
                        var hPlaceStart = Math.max(hVictim.startMin, hWinStart);
                        var hNewEnd = Math.min(hPlaceStart + (hlc.dMax || hNeedDMin), hVictim.endMin, hWinEnd);
                        var hRemainStart = hNewEnd;
                        var hRemainEnd = hVictim.endMin;
                        // Also fill the gap before the clamped start
                        var hPreGap = hPlaceStart - hVictim.startMin;

                        // Replace with the required layer
                        var hEventName = hlt === 'special' ? hSpecialName : (hll.event || hlt);
                        hTmpl[hBestIdx] = makeBlock({
                            startMin: hPlaceStart, endMin: hNewEnd,
                            type: hlt === 'snacks' ? 'snacks' : hlt,
                            event: hEventName,
                            layer: hll, dMin: hNeedDMin, dMax: hlc.dMax || hNeedDMin,
                            _source: 'self-heal', _activityLocked: true, _final: true,
                            _assignedSpecial: hlt === 'special' ? hSpecialName : null,
                            _specialLocation: hlt === 'special' ? hSpecialLocation : null,
                            _isSpecialLocation: hlt === 'special'
                        }) || hTmpl[hBestIdx]; // fallback if makeBlock returns null

                        // ★ v11.1: Fill the pre-gap (victim start to clamped start) with sport
                        if (hPreGap >= 10) {
                            addSportBlocks(hTmpl, hVictim.startMin, hPlaceStart, {
                                type: 'slot', event: 'General Activity Slot',
                                layer: hMeta.sportLayer, field: null,
                                dMin: Math.min(hPreGap, hMeta.fillMinDur || 20), dMax: hMeta.sportCeiling,
                                _source: 'self-heal-pregap', _final: true
                            }, hMeta.sportCeiling, Math.min(hPreGap, hMeta.fillMinDur || 20));
                        }

                        // ★ v10.3: Fill remainder with sport — NEVER extend layer past dMax
                        var hRemainDur = hRemainEnd - hRemainStart;
                        if (hRemainDur >= 10) {
                            addSportBlocks(hTmpl, hRemainStart, hRemainEnd, {
                                type: 'slot', event: 'General Activity Slot',
                                layer: hMeta.sportLayer, field: null,
                                dMin: Math.min(hRemainDur, hMeta.fillMinDur),
                                dMax: hMeta.sportCeiling,
                                _source: 'self-heal',
                                _sportFallbacks: hMeta.priorityList.map(function(s) { return s.name; }),
                                _final: true
                            }, hMeta.sportCeiling, Math.min(hRemainDur, hMeta.fillMinDur));
                        }
                        // If remainder < 10min, leave it — small gap is better than layer above dMax
                        healCount++;
                    }
                }
                hTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                // ★ v10.0: Integrity check after self-healing
                bunkTimelines[hBunk] = hTmpl;
                ensureTimelineIntegrity(hBunk);
                hTmpl = bunkTimelines[hBunk];
            }
            if (healCount > 0) log('[Phase3] 🔧 Self-healed ' + healCount + ' missing layers');

            // ★ Self-healing for rotation events — sacrifice sport block if missing
            var rotHealCount = 0;
            if (rotationQuotas && window.RotationEvents && typeof window.RotationEvents.getNeedsForBunk === 'function') {
                for (var rhi = 0; rhi < allBunkIds.length; rhi++) {
                    var rhBunk = allBunkIds[rhi];
                    var rhMeta = bunkMeta[rhBunk];
                    var rhTmpl = rhMeta.template;
                    // Check if bunk has a rotation event block already
                    var rhHasRot = rhTmpl.some(function(b) { return b._source === 'rotation_event' && b._rotationEventId; });
                    if (rhHasRot) continue;
                    // Get rotation needs for this bunk
                    try {
                        var rhNeeds = window.RotationEvents.getNeedsForBunk(String(rhBunk), currentDate);
                        if (!rhNeeds || !rhNeeds.length) continue;
                        for (var rni = 0; rni < rhNeeds.length; rni++) {
                            var rhNeed = rhNeeds[rni];
                            // Check quota — only self-heal if under target or last day
                            if (rotationQuotas[rhNeed._rotationEventId]) {
                                var rhQ = rotationQuotas[rhNeed._rotationEventId];
                                if (!rhQ.isLastDay && rhQ.placed >= rhQ.dailyTarget) continue;
                            }
                            var rhDur = rhNeed.dMin || 15;
                            var rhWinStart = Math.max(rhNeed.windowStart || 0, rhMeta.gradeStart);
                            var rhWinEnd = Math.min(rhNeed.windowEnd || 1440, rhMeta.gradeEnd);
                            // Find a sport/slot block to sacrifice within the window
                            var rhBestIdx = -1, rhBestFit = Infinity;
                            for (var rhsi = 0; rhsi < rhTmpl.length; rhsi++) {
                                var rhblk = rhTmpl[rhsi];
                                if (rhblk._fixed) continue;
                                var rhbt = (rhblk.type || '').toLowerCase();
                                if (!['sport', 'slot'].includes(rhbt)) continue;
                                if (rhblk.startMin < rhWinStart || rhblk.endMin > rhWinEnd) continue;
                                var rhblkDur = rhblk.endMin - rhblk.startMin;
                                if (rhblkDur < rhDur) continue;
                                var rhfit = Math.abs(rhblkDur - rhDur);
                                if (rhfit < rhBestFit) { rhBestFit = rhfit; rhBestIdx = rhsi; }
                            }
                            if (rhBestIdx >= 0) {
                                var rhVictim = rhTmpl[rhBestIdx];
                                var rhNewEnd = Math.min(rhVictim.startMin + (rhNeed.dMax || rhDur), rhVictim.endMin);
                                var rhRemainStart = rhNewEnd;
                                var rhRemainEnd = rhVictim.endMin;
                                // Replace with rotation event block
                                rhTmpl[rhBestIdx] = makeBlock({
                                    startMin: rhVictim.startMin, endMin: rhNewEnd,
                                    type: 'rotation_event', event: rhNeed.event,
                                    layer: rhNeed.layer, dMin: rhDur, dMax: rhNeed.dMax || rhDur,
                                    _source: 'rotation_event', _activityLocked: true, _final: true,
                                    _rotationEventId: rhNeed._rotationEventId,
                                    _rotationEventLocation: rhNeed._rotationEventLocation,
                                    _rotationEventColor: rhNeed._rotationEventColor
                                }) || rhTmpl[rhBestIdx];
                                // Fill remainder with sport slot
                                if (rhRemainEnd - rhRemainStart >= rhMeta.fillMinDur) {
                                    addSportBlocks(rhTmpl, rhRemainStart, rhRemainEnd, {
                                        type: 'slot', event: 'General Activity Slot',
                                        layer: rhMeta.sportLayer, field: null,
                                        dMin: rhMeta.sportC.dMin, dMax: rhMeta.sportCeiling,
                                        _source: 'self-heal',
                                        _sportFallbacks: rhMeta.priorityList.map(function(s) { return s.name; }),
                                        _final: true
                                    }, rhMeta.sportCeiling, rhMeta.fillMinDur);
                                } else if (rhRemainEnd - rhRemainStart > 0) {
                                    rhTmpl[rhBestIdx].endMin = rhRemainEnd;
                                }
                                // Increment quota counter
                                if (rotationQuotas[rhNeed._rotationEventId]) {
                                    rotationQuotas[rhNeed._rotationEventId].placed++;
                                }
                                rotHealCount++;
                                break; // one rotation event per bunk
                            }
                        }
                    } catch (e) { /* skip */ }
                    rhTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                }
            }
            if (rotHealCount > 0) log('[Phase3] 🔧 Self-healed ' + rotHealCount + ' missing rotation events');

            // ★ v10.3: SWIM/SNACK GUARANTEE — absolute last resort forced placement
            // Uses bunkTimelines[bunk] directly (not stale gMeta.template references).
            var guaranteeCount = 0;
            for (var gbi = 0; gbi < allBunkIds.length; gbi++) {
                var gBunk = allBunkIds[gbi];
                var gMeta = bunkMeta[gBunk];
                if (!gMeta) continue;
                var gGrade = gMeta.grade;
                var gLayers = layersByGrade[gGrade] || [];

                for (var gli = 0; gli < gLayers.length; gli++) {
                    var gll = gLayers[gli];
                    var glt = (gll.type || '').toLowerCase();
                    if (glt !== 'swim' && glt !== 'snack' && glt !== 'snacks') continue;

                    // ★ BUG FIX: Read LIVE timeline, not stale template reference
                    var gTmpl = bunkTimelines[gBunk] || [];

                    var gHasIt = gTmpl.some(function(b) {
                        var bt = (b.type || '').toLowerCase();
                        return bt === glt || (glt === 'snacks' && bt === 'snack') || (glt === 'snack' && bt === 'snacks');
                    });
                    if (gHasIt) continue;

                    var glc = resolveConstraints(gll, glt);
                    var gNeedDMin = glc.dMin || (glt === 'swim' ? 30 : 15);
                    var gNeedDMax = glc.dMax || gNeedDMin;

                    // Find the largest non-fixed sport/slot block anywhere in the day
                    var gBestIdx = -1, gBestDur = 0;
                    for (var gsi = 0; gsi < gTmpl.length; gsi++) {
                        var gblk = gTmpl[gsi];
                        if (gblk._fixed) continue;
                        var gbt = (gblk.type || '').toLowerCase();
                        if (gbt !== 'sport' && gbt !== 'slot') continue;
                        var gblkDur = gblk.endMin - gblk.startMin;
                        if (gblkDur >= gNeedDMin && gblkDur > gBestDur) {
                            gBestDur = gblkDur;
                            gBestIdx = gsi;
                        }
                    }

                    // ★ v14.0: If no single sport block is big enough, try merging
                    // two adjacent sport/slot blocks to create enough space.
                    if (gBestIdx < 0) {
                        for (var gmi = 0; gmi < gTmpl.length - 1; gmi++) {
                            var gm1 = gTmpl[gmi], gm2 = gTmpl[gmi + 1];
                            if (gm1._fixed || gm2._fixed) continue;
                            var gm1t = (gm1.type || '').toLowerCase();
                            var gm2t = (gm2.type || '').toLowerCase();
                            if (!['sport', 'slot'].includes(gm1t) || !['sport', 'slot'].includes(gm2t)) continue;
                            // Must be adjacent (no gap between them)
                            if (gm1.endMin !== gm2.startMin) continue;
                            var gCombinedDur = gm2.endMin - gm1.startMin;
                            if (gCombinedDur >= gNeedDMin) {
                                // Merge: extend first block to cover both, remove second
                                gm1.endMin = gm2.endMin;
                                gTmpl.splice(gmi + 1, 1);
                                gBestIdx = gmi;
                                gBestDur = gCombinedDur;
                                log('[Phase3] ⚡ Merged 2 adjacent sport blocks for ' + glt + ' guarantee (bunk ' + gBunk + ')');
                                break;
                            }
                        }
                    }

                    if (gBestIdx >= 0) {
                        var gVictim = gTmpl[gBestIdx];
                        // ★ v11.1: Clamp to layer window AND dMax
                        var gLayerWinStart = gll.startMin || gMeta.gradeStart;
                        var gLayerWinEnd = gll.endMin || gMeta.gradeEnd;
                        var gPlaceStart = Math.max(gVictim.startMin, gLayerWinStart);
                        var gLayerEnd = Math.min(gPlaceStart + gNeedDMax, gVictim.endMin, gLayerWinEnd);
                        var gRemainStart = gLayerEnd;
                        var gRemainEnd = gVictim.endMin;
                        var gPreGap = gPlaceStart - gVictim.startMin;

                        gTmpl[gBestIdx] = makeBlock({
                            startMin: gPlaceStart, endMin: gLayerEnd,
                            type: glt === 'snacks' ? 'snacks' : glt,
                            event: gll.event || glt,
                            layer: gll, dMin: gNeedDMin, dMax: gNeedDMax,
                            _source: 'guarantee', _activityLocked: true, _final: true, _fixed: false
                        }) || gTmpl[gBestIdx];

                        // ★ v11.1: Fill pre-gap from clamping
                        if (gPreGap >= 10) {
                            addSportBlocks(gTmpl, gVictim.startMin, gPlaceStart, {
                                type: 'slot', event: 'General Activity Slot',
                                layer: gMeta.sportLayer, field: null,
                                dMin: Math.min(gPreGap, gMeta.fillMinDur || 20), dMax: gMeta.sportCeiling || 60,
                                _source: 'guarantee-pregap', _final: true
                            }, gMeta.sportCeiling || 60, Math.min(gPreGap, gMeta.fillMinDur || 20));
                        }
                        // Fill remainder with sport — NEVER extend the layer past dMax
                        var gRemainDur = gRemainEnd - gRemainStart;
                        if (gRemainDur >= 10) {
                            addSportBlocks(gTmpl, gRemainStart, gRemainEnd, {
                                type: 'slot', event: 'General Activity Slot',
                                layer: gMeta.sportLayer, field: null,
                                dMin: Math.min(gRemainDur, gMeta.fillMinDur || 20),
                                dMax: gMeta.sportCeiling || 60,
                                _source: 'guarantee-remainder', _final: true
                            }, gMeta.sportCeiling || 60, Math.min(gRemainDur, gMeta.fillMinDur || 20));
                        }

                        gTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                        bunkTimelines[gBunk] = gTmpl;
                        ensureTimelineIntegrity(gBunk);
                        guaranteeCount++;
                        log('[Phase3] ⚡ GUARANTEED ' + glt + ' for bunk ' + gBunk + ' (' + gNeedDMin + '-' + gNeedDMax + 'min, took ' + gBestDur + 'min sport block)');
                    } else {
                        warn('[Phase3] ❌ Cannot guarantee ' + glt + ' for bunk ' + gBunk + ' — no sport blocks >= ' + gNeedDMin + 'min to sacrifice');
                    }
                }
            }
            if (guaranteeCount > 0) log('[Phase3] ⚡ Forced ' + guaranteeCount + ' missing swim/snack placements');

            // ══════════════════════════════════════════════════════════
            // ★ v13.1: SMART FINISHER — three safe passes, never reconstructs
            // Pass A: Inject missing snacks/needs into gaps
            // Pass B: Rebalance durations (steal from oversized neighbors)
            // Pass C: Extend flexible blocks to fill remaining gaps
            //
            // SAFETY: Only ADDS blocks and ADJUSTS durations. Never removes,
            // never reconstructs, never moves walls.
            // ══════════════════════════════════════════════════════════

            // ── Pass A: Inject missing required needs into gaps ──────
            var injectCount = 0;
            for (var ia = 0; ia < allBunkIds.length; ia++) {
                var iaBunk = allBunkIds[ia];
                var iaMeta = bunkMeta[iaBunk];
                if (!iaMeta) continue;
                var iaGrade = iaMeta.grade;
                var iaTl = bunkTimelines[iaBunk] || [];
                var iaLayers = layersByGrade[iaGrade] || [];

                // Check what types this bunk already has
                var iaHas = {};
                for (var ih = 0; ih < iaTl.length; ih++) {
                    var iht = (iaTl[ih].type || '').toLowerCase();
                    if (iht === 'snack') iht = 'snacks';
                    iaHas[iht] = true;
                }

                for (var il = 0; il < iaLayers.length; il++) {
                    var ial = iaLayers[il];
                    var iat = (ial.type || '').toLowerCase();
                    if (iat === 'snack') iat = 'snacks';
                    if (['snacks', 'swim', 'special'].indexOf(iat) < 0) continue;
                    if (iaHas[iat]) continue;
                    if (iat === 'swim') {
                        var iaSwimsToday = todaysSwimmers[iaGrade] ? todaysSwimmers[iaGrade].has(String(iaBunk)) : false;
                        if (!iaSwimsToday) continue;
                    }
                    if (iat === 'special') {
                        var iaDraft = draftResults[iaBunk];
                        if (!iaDraft || !iaDraft.specials || !iaDraft.specials.length) continue;
                    }

                    var iac = resolveConstraints(ial, iat);
                    var iaWinS = ial.startMin || iaMeta.gradeStart;
                    var iaWinE = ial.endMin || iaMeta.gradeEnd;
                    var iaEvent = iat === 'special' ? draftResults[iaBunk].specials[0].name : (ial.event || iat);

                    // Find the best gap for this need
                    iaTl.sort(function(a, b) { return a.startMin - b.startMin; });
                    var iaGaps = findGaps(iaTl, iaMeta.gradeStart, iaMeta.gradeEnd);
                    var iaBestGap = null, iaBestScore = -Infinity;

                    for (var ig = 0; ig < iaGaps.length; ig++) {
                        var gap = iaGaps[ig];
                        var gapDur = gap.end - gap.start;
                        if (gapDur < iac.dMin) continue;
                        // Prefer gaps within the need's time window
                        var oS = Math.max(gap.start, iaWinS), oE = Math.min(gap.end, iaWinE);
                        var overlap = oE - oS;
                        var score = overlap >= iac.dMin ? overlap * 10 : gapDur;
                        if (score > iaBestScore) { iaBestScore = score; iaBestGap = gap; }
                    }
                    // Fallback: any gap at all
                    if (!iaBestGap) {
                        for (var ig2 = 0; ig2 < iaGaps.length; ig2++) {
                            if (iaGaps[ig2].end - iaGaps[ig2].start >= 5) { iaBestGap = iaGaps[ig2]; break; }
                        }
                    }

                    // ★ v14.0: If NO gaps exist at all, force-split the largest sport/slot
                    // block to create room. This is the absolute last resort — a bunk MUST
                    // have its required snack/swim even if it means shortening a sport.
                    if (!iaBestGap && ['snacks', 'swim'].indexOf(iat) >= 0) {
                        var fsBestIdx = -1, fsBestDur = 0;
                        for (var fsi = 0; fsi < iaTl.length; fsi++) {
                            var fsBlk = iaTl[fsi];
                            if (fsBlk._fixed || isPhase0(fsBlk)) continue;
                            var fsBt = (fsBlk.type || '').toLowerCase();
                            if (!['sport', 'slot'].includes(fsBt)) continue;
                            var fsDur = fsBlk.endMin - fsBlk.startMin;
                            // Sport must be big enough that splitting leaves both halves >= 5min
                            if (fsDur >= iac.dMin + 5 && fsDur > fsBestDur) {
                                fsBestDur = fsDur;
                                fsBestIdx = fsi;
                            }
                        }
                        if (fsBestIdx >= 0) {
                            // Create a synthetic gap by shrinking this sport block
                            var fsSport = iaTl[fsBestIdx];
                            var fsPlaceStart = Math.max(fsSport.startMin, iaWinS);
                            var fsPlaceEnd = fsPlaceStart + iac.dMin;
                            fsPlaceEnd = Math.min(fsPlaceEnd, fsSport.endMin);
                            fsPlaceEnd = Math.round(fsPlaceEnd / 5) * 5;

                            // Shrink the sport block
                            var fsOrigEnd = fsSport.endMin;
                            fsSport.endMin = fsPlaceStart;
                            // Remainder sport after the snack
                            if (fsOrigEnd - fsPlaceEnd >= 5) {
                                iaTl.push({
                                    startMin: fsPlaceEnd, endMin: fsOrigEnd,
                                    type: fsSport.type, event: fsSport.event,
                                    layer: fsSport.layer, field: fsSport.field,
                                    dMin: fsSport.dMin, dMax: fsSport.dMax,
                                    _source: 'inject-split', _assignedSport: fsSport._assignedSport,
                                    _sportFallbacks: fsSport._sportFallbacks
                                });
                            }
                            // Remove zero-length original if needed
                            if (fsSport.endMin <= fsSport.startMin) { iaTl.splice(fsBestIdx, 1); }

                            // Insert the snack/swim
                            iaTl.push({
                                startMin: fsPlaceStart, endMin: fsPlaceEnd,
                                type: iat === 'snacks' ? 'snacks' : iat, event: iaEvent, layer: ial,
                                dMin: iac.dMin, dMax: iac.dMax,
                                _source: 'finisher-force-split', _activityLocked: true, _final: true
                            });
                            iaTl.sort(function(a, b) { return a.startMin - b.startMin; });
                            bunkTimelines[iaBunk] = iaTl;
                            iaHas[iat] = true;
                            injectCount++;
                            log('[Phase3] ★ FORCE-INJECT: split sport block to place ' + iat + ' for bunk ' + iaBunk);
                            continue;
                        }
                    }

                    if (iaBestGap) {
                        // Place the need: take dMin from the gap, let rebalancer adjust later
                        var placeStart = Math.max(iaBestGap.start, iaWinS);
                        var placeDur = Math.min(iac.dMin, iaBestGap.end - placeStart);
                        if (placeDur < 5) { placeStart = iaBestGap.start; placeDur = Math.min(iac.dMin, iaBestGap.end - iaBestGap.start); }
                        var placeEnd = placeStart + placeDur;
                        placeEnd = Math.round(placeEnd / 5) * 5;
                        if (placeEnd <= placeStart) placeEnd = placeStart + 5;

                        // If we're taking space from a sport block, shrink it
                        for (var is2 = 0; is2 < iaTl.length; is2++) {
                            var isb = iaTl[is2];
                            if (isb._fixed || isPhase0(isb)) continue;
                            var isbt = (isb.type || '').toLowerCase();
                            if (['sport', 'slot'].indexOf(isbt) < 0) continue;
                            // If this sport block contains our placement, split it
                            if (isb.startMin <= placeStart && isb.endMin >= placeEnd) {
                                var origEnd = isb.endMin;
                                isb.endMin = placeStart; // shrink sport to end before need
                                // Add remainder sport after need if room
                                if (origEnd - placeEnd >= 5) {
                                    iaTl.push({
                                        startMin: placeEnd, endMin: origEnd,
                                        type: isb.type, event: isb.event, layer: isb.layer, field: isb.field,
                                        dMin: isb.dMin, dMax: isb.dMax, _source: 'split-remainder',
                                        _assignedSport: isb._assignedSport, _sportFallbacks: isb._sportFallbacks
                                    });
                                }
                                // Remove sport if zero-length
                                if (isb.endMin <= isb.startMin) { iaTl.splice(is2, 1); is2--; }
                                break;
                            }
                        }

                        // Insert the need block
                        iaTl.push({
                            startMin: placeStart, endMin: placeEnd,
                            type: iat === 'snacks' ? 'snacks' : iat, event: iaEvent, layer: ial,
                            dMin: iac.dMin, dMax: iac.dMax,
                            _source: 'finisher-inject', _activityLocked: true, _final: true,
                            _assignedSpecial: iat === 'special' ? iaEvent : null
                        });
                        iaTl.sort(function(a, b) { return a.startMin - b.startMin; });
                        bunkTimelines[iaBunk] = iaTl;
                        iaHas[iat] = true;
                        injectCount++;
                    }
                }
            }
            if (injectCount > 0) log('[Phase3] ★ INJECT: placed ' + injectCount + ' missing needs into gaps');

            // ── Pass B: Rebalance durations ──────────────────────────
            var rebalanceTotal = 0;
            for (var rbi = 0; rbi < allBunkIds.length; rbi++) {
                var rbBunk = allBunkIds[rbi];
                var rbTmpl = bunkTimelines[rbBunk] || [];
                rbTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                var rbChanged = true, rbPasses = 0;
                while (rbChanged && rbPasses < 8) {
                    rbChanged = false; rbPasses++;
                    for (var rbj = 0; rbj < rbTmpl.length; rbj++) {
                        var rbBlk = rbTmpl[rbj];
                        var rbType = (rbBlk.type || '').toLowerCase();
                        var rbDur = rbBlk.endMin - rbBlk.startMin;
                        var rbC = resolveConstraints(rbBlk.layer, rbType, rbBlk);
                        if (rbDur >= rbC.dMin) continue;
                        var rbDeficit = Math.ceil((rbC.dMin - rbDur) / 5) * 5;
                        if (rbDeficit < 5) continue;
                        // Steal from previous neighbor
                        if (rbj > 0 && !isPhase0(rbTmpl[rbj-1])) {
                            var don = rbTmpl[rbj-1];
                            var donC = resolveConstraints(don.layer, (don.type || '').toLowerCase(), don);
                            var surplus = Math.floor(((don.endMin - don.startMin) - donC.dMin) / 5) * 5;
                            if (surplus >= 5) {
                                var steal = Math.min(rbDeficit, surplus);
                                don.endMin -= steal; rbBlk.startMin -= steal;
                                rbChanged = true; rebalanceTotal++; continue;
                            }
                        }
                        // Steal from next neighbor
                        if (rbj < rbTmpl.length - 1 && !isPhase0(rbTmpl[rbj+1])) {
                            var don2 = rbTmpl[rbj+1];
                            var don2C = resolveConstraints(don2.layer, (don2.type || '').toLowerCase(), don2);
                            var surplus2 = Math.floor(((don2.endMin - don2.startMin) - don2C.dMin) / 5) * 5;
                            if (surplus2 >= 5) {
                                var steal2 = Math.min(rbDeficit, surplus2);
                                don2.startMin += steal2; rbBlk.endMin += steal2;
                                rbChanged = true; rebalanceTotal++; continue;
                            }
                        }
                    }
                }
                bunkTimelines[rbBunk] = rbTmpl;
            }
            if (rebalanceTotal > 0) log('[Phase3] ★ REBALANCE: fixed ' + rebalanceTotal + ' duration imbalances');

            // ── Pass C: Fill remaining gaps ──────────────────────────
            for (var fc = 0; fc < allBunkIds.length; fc++) {
                var fcBunk = allBunkIds[fc];
                var fcMeta = bunkMeta[fcBunk];
                if (!fcMeta) continue;
                var fcTl = bunkTimelines[fcBunk] || [];
                fcTl.sort(function(a, b) { return a.startMin - b.startMin; });
                var fcGaps = findGaps(fcTl, fcMeta.gradeStart, fcMeta.gradeEnd);
                for (var fg = 0; fg < fcGaps.length; fg++) {
                    var fgGap = fcGaps[fg];
                    var fgDur = fgGap.end - fgGap.start;
                    if (fgDur <= 0) continue;
                    // Try extending previous block
                    var extended = false;
                    for (var fe = fcTl.length - 1; fe >= 0; fe--) {
                        if (fcTl[fe].endMin === fgGap.start && !isPhase0(fcTl[fe])) {
                            var feMax = fcTl[fe].dMax || (TYPE_CEILINGS[(fcTl[fe].type || '').toLowerCase()] || 60);
                            if ((fcTl[fe].endMin - fcTl[fe].startMin) + fgDur <= feMax) {
                                fcTl[fe].endMin = fgGap.end; extended = true; break;
                            }
                        }
                    }
                    if (extended) continue;
                    // Try extending next block
                    for (var fn = 0; fn < fcTl.length; fn++) {
                        if (fcTl[fn].startMin === fgGap.end && !isPhase0(fcTl[fn])) {
                            var fnMax = fcTl[fn].dMax || (TYPE_CEILINGS[(fcTl[fn].type || '').toLowerCase()] || 60);
                            if ((fcTl[fn].endMin - fcTl[fn].startMin) + fgDur <= fnMax) {
                                fcTl[fn].startMin = fgGap.start; extended = true; break;
                            }
                        }
                    }
                    if (extended) continue;
                    // Create filler slot
                    if (fgDur >= 5) {
                        // ★ v14.0: Set dMin to actual gap size (we can't make it bigger),
                        // but set dMax to sportCeiling so rebalancer can extend it later.
                        fcTl.push({
                            startMin: fgGap.start, endMin: fgGap.end,
                            type: 'slot', event: 'General Activity Slot',
                            layer: fcMeta.sportLayer, field: null,
                            dMin: fgDur, dMax: fcMeta.sportCeiling || 60,
                            _source: 'gap-fill', _final: true,
                            _sportFallbacks: fcMeta.priorityList ? fcMeta.priorityList.map(function(s) { return s.name; }) : []
                        });
                    }
                }
                fcTl.sort(function(a, b) { return a.startMin - b.startMin; });
                bunkTimelines[fcBunk] = fcTl;
                allTemplates[fcBunk] = fcTl;
            }

            // ★ v11.4: ZERO-GAP FINALIZER
            // Eliminate every remaining gap by distributing time to adjacent
            // flexible blocks. A gap-free schedule means zero Frees.
            // ══════════════════════════════════════════════════════════
            for (var zgi = 0; zgi < allBunkIds.length; zgi++) {
                var zgBunk = allBunkIds[zgi];
                var zgMeta = bunkMeta[zgBunk];
                if (!zgMeta) continue;
                var zgTmpl = bunkTimelines[zgBunk] || [];
                zgTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                var zgGaps = findGaps(zgTmpl, zgMeta.gradeStart, zgMeta.gradeEnd);
                for (var zg = 0; zg < zgGaps.length; zg++) {
                    var zgGap = zgGaps[zg];
                    var zgDur = zgGap.end - zgGap.start;
                    if (zgDur <= 0) continue;

                    // Strategy 1: Extend previous non-fixed block to cover gap
                    var zgPrev = null;
                    for (var zp = zgTmpl.length - 1; zp >= 0; zp--) {
                        if (zgTmpl[zp].endMin === zgGap.start && !zgTmpl[zp]._fixed) { zgPrev = zgTmpl[zp]; break; }
                    }
                    if (zgPrev) {
                        var zgPrevDur = zgPrev.endMin - zgPrev.startMin;
                        var zgPrevMax = zgPrev.dMax || (TYPE_CEILINGS[(zgPrev.type || '').toLowerCase()] || 60);
                        // Only extend if within dMax — respect constraints
                        if (zgPrevDur + zgDur <= zgPrevMax) {
                            zgPrev.endMin = zgGap.end;
                            continue;
                        }
                        // Partial extend: take as much as dMax allows
                        var zgCanTake = zgPrevMax - zgPrevDur;
                        if (zgCanTake >= 5) {
                            zgPrev.endMin += zgCanTake;
                            zgGap.start = zgPrev.endMin;
                            zgDur = zgGap.end - zgGap.start;
                            if (zgDur <= 0) continue;
                        }
                    }

                    // Strategy 2: Pull next non-fixed block backward
                    var zgNext = null;
                    for (var zn = 0; zn < zgTmpl.length; zn++) {
                        if (zgTmpl[zn].startMin === zgGap.end && !zgTmpl[zn]._fixed) { zgNext = zgTmpl[zn]; break; }
                    }
                    if (zgNext) {
                        var zgNextDur = zgNext.endMin - zgNext.startMin;
                        var zgNextMax = zgNext.dMax || (TYPE_CEILINGS[(zgNext.type || '').toLowerCase()] || 60);
                        if (zgNextDur + zgDur <= zgNextMax) {
                            zgNext.startMin = zgGap.start;
                            continue;
                        }
                        var zgCanTake2 = zgNextMax - zgNextDur;
                        if (zgCanTake2 >= 5) {
                            zgNext.startMin -= zgCanTake2;
                            continue;
                        }
                    }

                    // Strategy 3: Create a minimal sport/slot block for the remaining gap
                    if (zgDur >= 5) {
                        // ★ v14.0: dMin = actual gap size (can't extend past walls),
                        // dMax = sportCeiling so rebalancer can grow it if space opens.
                        var zgBlk = makeBlock({
                            startMin: zgGap.start, endMin: zgGap.end,
                            type: 'slot', event: 'General Activity Slot',
                            layer: zgMeta.sportLayer, field: null,
                            dMin: zgDur, dMax: zgMeta.sportCeiling || 60,
                            _source: 'zero-gap', _final: true
                        });
                        if (zgBlk) zgTmpl.push(zgBlk);
                    }
                }
                zgTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                bunkTimelines[zgBunk] = zgTmpl;
            }

            // ══════════════════════════════════════════════════════════
            // ★ v11.5b: DURATION REBALANCER (rewritten)
            // Core insight: _fixed means "user-pinned, don't move". But system-
            // generated blocks (guarantee, self-heal, pre-placed) are NOT user-
            // pinned — they just happen to be _fixed to prevent Phase 3 from
            // reshuffling them. The rebalancer runs AFTER Phase 3, so it's safe
            // to shrink ANY block that has surplus above its dMin.
            //
            // Rule: ANY block can DONATE time if it has surplus above dMin.
            //       ANY block can RECEIVE time if it's below dMin.
            //       Only truly user-pinned blocks (Phase 0 pinned layers with
            //       _classification === 'pinned' AND _source === 'phase0') are
            //       exempt from donating.
            // ══════════════════════════════════════════════════════════
            // ★ v11.5c: Phase 0 blocks are IMMOVABLE — cannot be moved, shrunk, or shifted.
            // This includes pinned layers, leagues, trips, and bunk overrides.
            function isPhase0(blk) {
                if (blk._classification === 'pinned') return true;
                if (blk._source === 'phase0') return true;
                var bt = (blk.type || '').toLowerCase();
                if (bt === 'league' || bt === 'specialty_league') return true;
                if (bt === 'lunch' || bt === 'dismissal') return true;
                if (blk._isTrip) return true;
                if (blk._bunkOverride && blk._source === 'capacity_checked') return true;
                return false;
            }

            var rebalanceTotal = 0;
            for (var rbi = 0; rbi < allBunkIds.length; rbi++) {
                var rbBunk = allBunkIds[rbi];
                var rbTmpl = bunkTimelines[rbBunk] || [];
                rbTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                var rbChanged = true, rbPasses = 0;
                while (rbChanged && rbPasses < 8) {
                    rbChanged = false;
                    rbPasses++;

                    for (var rbj = 0; rbj < rbTmpl.length; rbj++) {
                        var rbBlk = rbTmpl[rbj];
                        var rbType = (rbBlk.type || '').toLowerCase();
                        var rbDur = rbBlk.endMin - rbBlk.startMin;
                        var rbC = resolveConstraints(rbBlk.layer, rbType, rbBlk);

                        // Is this block below its dMin?
                        if (rbDur >= rbC.dMin) continue;
                        var rbDeficit = rbC.dMin - rbDur;
                        // Snap deficit to 5-min
                        rbDeficit = Math.ceil(rbDeficit / 5) * 5;
                        if (rbDeficit < 5) continue;

                        // Try stealing from the PREVIOUS block (even if _fixed, unless user-pinned)
                        if (rbj > 0 && !isPhase0(rbTmpl[rbj-1])) {
                            var donor = rbTmpl[rbj-1];
                            var donorDur = donor.endMin - donor.startMin;
                            var donorC = resolveConstraints(donor.layer, (donor.type || '').toLowerCase(), donor);
                            var donorSurplus = donorDur - donorC.dMin;
                            donorSurplus = Math.floor(donorSurplus / 5) * 5;

                            if (donorSurplus >= 5) {
                                var steal = Math.min(rbDeficit, donorSurplus);
                                steal = Math.round(steal / 5) * 5;
                                if (steal >= 5) {
                                    donor.endMin -= steal;
                                    rbBlk.startMin -= steal;
                                    rbChanged = true;
                                    rebalanceTotal++;
                                    log('[REBAL] ' + rbType + ' bunk=' + rbBunk + ' +' + steal + 'min from prev ' + (donor.type || '') + ' (' + (donorDur) + '→' + (donor.endMin - donor.startMin) + ')');
                                    continue;
                                }
                            }
                        }

                        // Try stealing from the NEXT block
                        if (rbj < rbTmpl.length - 1 && !isPhase0(rbTmpl[rbj+1])) {
                            var donor2 = rbTmpl[rbj+1];
                            var donor2Dur = donor2.endMin - donor2.startMin;
                            var donor2C = resolveConstraints(donor2.layer, (donor2.type || '').toLowerCase(), donor2);
                            var donor2Surplus = donor2Dur - donor2C.dMin;
                            donor2Surplus = Math.floor(donor2Surplus / 5) * 5;

                            if (donor2Surplus >= 5) {
                                var steal2 = Math.min(rbDeficit, donor2Surplus);
                                steal2 = Math.round(steal2 / 5) * 5;
                                if (steal2 >= 5) {
                                    donor2.startMin += steal2;
                                    rbBlk.endMin += steal2;
                                    rbChanged = true;
                                    rebalanceTotal++;
                                    log('[REBAL] ' + rbType + ' bunk=' + rbBunk + ' +' + steal2 + 'min from next ' + (donor2.type || '') + ' (' + (donor2Dur) + '→' + (donor2.endMin - donor2.startMin) + ')');
                                    continue;
                                }
                            }
                        }

                        // Try stealing from non-adjacent blocks (search outward)
                        for (var rbk = 1; rbk <= 3 && rbDeficit > 0; rbk++) {
                            // Look left
                            var li = rbj - rbk;
                            if (li >= 0 && !isPhase0(rbTmpl[li])) {
                                var ld = rbTmpl[li];
                                var ldDur = ld.endMin - ld.startMin;
                                var ldC = resolveConstraints(ld.layer, (ld.type || '').toLowerCase(), ld);
                                var ldSurplus = Math.floor((ldDur - ldC.dMin) / 5) * 5;
                                if (ldSurplus >= 5) {
                                    // Check that no intermediate block is Phase 0 (immovable)
                                    var lBlocked = false;
                                    for (var lchk = li + 1; lchk < rbj; lchk++) {
                                        if (isPhase0(rbTmpl[lchk])) { lBlocked = true; break; }
                                    }
                                    if (lBlocked) continue;
                                    var lsteal = Math.min(rbDeficit, ldSurplus);
                                    lsteal = Math.round(lsteal / 5) * 5;
                                    if (lsteal >= 5) {
                                        // Shrink the donor and shift everything between donor and victim
                                        ld.endMin -= lsteal;
                                        for (var lshift = li + 1; lshift <= rbj; lshift++) {
                                            rbTmpl[lshift].startMin -= lsteal;
                                            rbTmpl[lshift].endMin -= lsteal;
                                        }
                                        rbBlk.endMin += lsteal; // give back to victim at the end
                                        rbDeficit -= lsteal;
                                        rbChanged = true;
                                        rebalanceTotal++;
                                        log('[REBAL] ' + rbType + ' bunk=' + rbBunk + ' +' + lsteal + 'min from ' + rbk + '-away ' + (ld.type || ''));
                                    }
                                }
                            }
                            // Look right
                            var ri = rbj + rbk;
                            if (ri < rbTmpl.length && !isPhase0(rbTmpl[ri]) && rbDeficit > 0) {
                                var rd = rbTmpl[ri];
                                var rdDur = rd.endMin - rd.startMin;
                                var rdC = resolveConstraints(rd.layer, (rd.type || '').toLowerCase(), rd);
                                var rdSurplus = Math.floor((rdDur - rdC.dMin) / 5) * 5;
                                if (rdSurplus >= 5) {
                                    // Check that no intermediate block is Phase 0 (immovable)
                                    var rBlocked = false;
                                    for (var rchk = rbj + 1; rchk < ri; rchk++) {
                                        if (isPhase0(rbTmpl[rchk])) { rBlocked = true; break; }
                                    }
                                    if (rBlocked) continue;
                                    var rsteal = Math.min(rbDeficit, rdSurplus);
                                    rsteal = Math.round(rsteal / 5) * 5;
                                    if (rsteal >= 5) {
                                        rd.startMin += rsteal;
                                        for (var rshift = ri - 1; rshift >= rbj; rshift--) {
                                            rbTmpl[rshift].endMin += rsteal;
                                            rbTmpl[rshift].startMin += rsteal;
                                        }
                                        rbBlk.startMin -= rsteal;
                                        rbDeficit -= rsteal;
                                        rbChanged = true;
                                        rebalanceTotal++;
                                        log('[REBAL] ' + rbType + ' bunk=' + rbBunk + ' +' + rsteal + 'min from ' + rbk + '-away ' + (rd.type || ''));
                                    }
                                }
                            }
                        }
                    }
                }
                bunkTimelines[rbBunk] = rbTmpl;
            }
            if (rebalanceTotal > 0) log('[Phase3] ★ REBALANCE: fixed ' + rebalanceTotal + ' duration imbalances');

            // ★ v10.5: FINAL CONSTRAINT ENFORCEMENT SWEEP
            // Last-pass safety net: clamp every block to its dMin/dMax.
            // Catches any violations introduced by merge/absorb/extend passes.
            // ══════════════════════════════════════════════════════════
            var enforceFixCount = 0;
            for (var ei = 0; ei < allBunkIds.length; ei++) {
                var eBunk = allBunkIds[ei];
                var eMeta = bunkMeta[eBunk];
                var eTmpl = bunkTimelines[eBunk] || allTemplates[eBunk] || [];
                eTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                for (var ej = 0; ej < eTmpl.length; ej++) {
                    var eBlk = eTmpl[ej];
                    if (eBlk._fixed) continue;
                    var eType = (eBlk.type || '').toLowerCase();
                    var eDur = eBlk.endMin - eBlk.startMin;

                    // Resolve the authoritative constraints for this block
                    var eConstraints = resolveConstraints(eBlk.layer, eType, eBlk);
                    var eDMin = eConstraints.dMin;
                    var eDMax = eConstraints.dMax;

                    // ★ v14.0: Gap-filler blocks (sport/slot created to fill a specific gap)
                    // should use their actual size as dMin, not the layer's dMin.
                    // They were CREATED to fill that exact gap — their purpose IS their size.
                    var eIsGapFiller = ['sport', 'slot'].includes(eType) &&
                        (eBlk._source === 'gap-fill' || eBlk._source === 'zero-gap' ||
                         eBlk._source === 'self-heal' || eBlk._source === 'guarantee' ||
                         eBlk._source === 'guarantee-pregap' || eBlk._source === 'guarantee-remainder' ||
                         eBlk._source === 'finisher-inject' || eBlk._source === 'inject-split' ||
                         eBlk._source === 'split-remainder' || eBlk._source === 'self-heal-pregap');
                    if (eIsGapFiller && eDur >= 5 && eDur < eDMin) {
                        // This block was made to fill a gap — its actual size IS its dMin
                        eDMin = eDur;
                    }

                    // Also update the block's stored dMin/dMax to match resolved values
                    eBlk.dMin = eDMin;
                    eBlk.dMax = eDMax;

                    // ★ v11.3: Fix dMax violations for ALL types, not just sport/slot
                    if (eDur > eDMax) {
                        var eOrigEnd = eBlk.endMin;
                        eBlk.endMin = eBlk.startMin + eDMax;
                        eBlk.endMin = Math.round(eBlk.endMin / 5) * 5;
                        var eRemain = eOrigEnd - eBlk.endMin;
                        if (eRemain >= eMeta.fillMinDur) {
                            var eRemBlk = makeBlock({
                                startMin: eBlk.endMin, endMin: eOrigEnd,
                                type: 'slot', event: 'General Activity Slot',
                                layer: eMeta.sportLayer, field: null,
                                dMin: eMeta.sportC.dMin, dMax: eMeta.sportCeiling,
                                _source: 'enforce-split', _final: true
                            });
                            if (eRemBlk) { eTmpl.splice(ej + 1, 0, eRemBlk); }
                        }
                        enforceFixCount++;
                        log('[Phase3] ENFORCE: shrunk ' + eType + ' for bunk ' + eBunk + ' from ' + eDur + ' to ' + eDMax + 'min (dMax)');
                    }

                    // ★ v11.1: WINDOW ENFORCEMENT — clamp blocks to their layer's time window
                    if (eBlk.layer && !['sport', 'slot'].includes(eType)) {
                        var eLayerStart = eBlk.layer.startMin;
                        var eLayerEnd = eBlk.layer.endMin;
                        if (eLayerStart != null && eBlk.startMin < eLayerStart) {
                            log('[Phase3] ENFORCE: clamped ' + eType + '/' + (eBlk.event || '') + ' for bunk ' + eBunk + ' start from ' + eBlk.startMin + ' to ' + eLayerStart + ' (window)');
                            eBlk.startMin = eLayerStart;
                            enforceFixCount++;
                        }
                        if (eLayerEnd != null && eBlk.endMin > eLayerEnd) {
                            log('[Phase3] ENFORCE: clamped ' + eType + '/' + (eBlk.event || '') + ' for bunk ' + eBunk + ' end from ' + eBlk.endMin + ' to ' + eLayerEnd + ' (window)');
                            eBlk.endMin = eLayerEnd;
                            enforceFixCount++;
                        }
                        // Recalc duration after clamping
                        eDur = eBlk.endMin - eBlk.startMin;
                        if (eDur <= 0) { eTmpl.splice(ej, 1); ej--; continue; }
                    }

                    // ★ v11.3 + v14.0: Fix dMin violations for ALL types
                    if (eDur < eDMin) {
                        var eNextStart = (ej < eTmpl.length - 1) ? eTmpl[ej+1].startMin : (eMeta.gradeEnd || 960);
                        var eAvailR = eNextStart - eBlk.endMin;
                        var eFixed = false;
                        if (eDur + eAvailR >= eDMin) {
                            eBlk.endMin = eBlk.startMin + Math.min(eDMin, eDMax);
                            eBlk.endMin = Math.round(eBlk.endMin / 5) * 5;
                            enforceFixCount++;
                            eFixed = true;
                            log('[Phase3] ENFORCE: extended ' + eType + ' for bunk ' + eBunk + ' from ' + eDur + ' to ' + (eBlk.endMin - eBlk.startMin) + 'min (dMin)');
                        } else {
                            var ePrevEnd = (ej > 0) ? eTmpl[ej-1].endMin : (eMeta.gradeStart || 540);
                            var eAvailL = eBlk.startMin - ePrevEnd;
                            if (eDur + eAvailL >= eDMin) {
                                eBlk.startMin = eBlk.endMin - Math.min(eDMin, eDMax);
                                eBlk.startMin = Math.round(eBlk.startMin / 5) * 5;
                                enforceFixCount++;
                                eFixed = true;
                                log('[Phase3] ENFORCE: extended-left ' + eType + ' for bunk ' + eBunk + ' from ' + eDur + ' to ' + (eBlk.endMin - eBlk.startMin) + 'min (dMin)');
                            }
                        }
                        // ★ v14.0: If neither extension worked, merge into nearest sport/slot neighbor
                        if (!eFixed && ['sport', 'slot'].includes(eType)) {
                            var eMerged = false;
                            // Try merging into previous sport/slot
                            if (ej > 0 && ['sport','slot'].includes((eTmpl[ej-1].type||'').toLowerCase())) {
                                var ePrevMax = eTmpl[ej-1].dMax || (TYPE_CEILINGS[(eTmpl[ej-1].type||'').toLowerCase()] || 60);
                                if ((eTmpl[ej-1].endMin - eTmpl[ej-1].startMin) + eDur <= ePrevMax) {
                                    eTmpl[ej-1].endMin = eBlk.endMin;
                                    eTmpl.splice(ej, 1); ej--;
                                    eMerged = true;
                                    enforceFixCount++;
                                    log('[Phase3] ENFORCE: merged sub-dMin ' + eType + ' into prev for bunk ' + eBunk);
                                }
                            }
                            // Try merging into next sport/slot
                            if (!eMerged && ej < eTmpl.length - 1 && ['sport','slot'].includes((eTmpl[ej+1].type||'').toLowerCase())) {
                                var eNextMax = eTmpl[ej+1].dMax || (TYPE_CEILINGS[(eTmpl[ej+1].type||'').toLowerCase()] || 60);
                                if ((eTmpl[ej+1].endMin - eTmpl[ej+1].startMin) + eDur <= eNextMax) {
                                    eTmpl[ej+1].startMin = eBlk.startMin;
                                    eTmpl.splice(ej, 1); ej--;
                                    eMerged = true;
                                    enforceFixCount++;
                                    log('[Phase3] ENFORCE: merged sub-dMin ' + eType + ' into next for bunk ' + eBunk);
                                }
                            }
                            if (!eMerged) {
                                warn('[Phase3] ENFORCE: could not fix sub-dMin ' + eType + ' (' + eDur + '<' + eDMin + ') for bunk ' + eBunk + ' — trapped between walls');
                            }
                        }
                    }
                }

                eTmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                bunkTimelines[eBunk] = eTmpl;
                allTemplates[eBunk] = eTmpl;
            }
            // ★ v14.0: SPECIAL DURATION ENFORCEMENT — runs on ALL blocks including _fixed.
            // Specials with configured durations must be exactly that duration.
            // This catches any specials that were pre-placed at wrong duration.
            var specialFixCount = 0;
            for (var si = 0; si < allBunkIds.length; si++) {
                var sBunk = allBunkIds[si];
                var sTmpl = bunkTimelines[sBunk] || [];
                for (var sj = 0; sj < sTmpl.length; sj++) {
                    var sBlk = sTmpl[sj];
                    if ((sBlk.type || '').toLowerCase() !== 'special') continue;
                    var sName = sBlk._assignedSpecial || sBlk.event || '';
                    if (!sName) continue;
                    var sCfgDur = getSpecialDuration(sName, activityProperties, globalSettings);
                    if (!sCfgDur || sCfgDur <= 0) continue;
                    var sActualDur = sBlk.endMin - sBlk.startMin;
                    if (sActualDur === sCfgDur) continue;
                    // Duration mismatch — fix it
                    var sNewEnd = sBlk.startMin + sCfgDur;
                    // Check we don't overlap the next block
                    var sNextStart = (sj < sTmpl.length - 1) ? sTmpl[sj+1].startMin : (bunkMeta[sBunk] ? bunkMeta[sBunk].gradeEnd : 960);
                    if (sNewEnd <= sNextStart) {
                        sBlk.endMin = sNewEnd;
                        sBlk._specialDuration = sCfgDur;
                        sBlk.dMin = sCfgDur;
                        sBlk.dMax = sCfgDur;
                        specialFixCount++;
                    } else {
                        // Try shifting start earlier
                        var sNewStart = sBlk.endMin - sCfgDur;
                        var sPrevEnd = (sj > 0) ? sTmpl[sj-1].endMin : (bunkMeta[sBunk] ? bunkMeta[sBunk].gradeStart : 540);
                        if (sNewStart >= sPrevEnd) {
                            sBlk.startMin = sNewStart;
                            sBlk._specialDuration = sCfgDur;
                            sBlk.dMin = sCfgDur;
                            sBlk.dMax = sCfgDur;
                            specialFixCount++;
                        } else {
                            warn('[Phase3] SPECIAL-ENFORCE: cannot fix ' + sName + ' for bunk ' + sBunk + ' (need ' + sCfgDur + 'min, have ' + sActualDur + 'min, no room)');
                        }
                    }
                }
            }
            if (specialFixCount > 0) log('[Phase3] ★ SPECIAL-ENFORCE: fixed ' + specialFixCount + ' special duration(s) to configured values');

            if (enforceFixCount > 0) log('[Phase3] ★ ENFORCE: fixed ' + enforceFixCount + ' constraint violations in final sweep');

            log('[Phase3] ★ timeSweepFillAll complete: ' + Object.keys(allTemplates).length + ' bunks, ' + totalWarnings + ' warnings');
            return allTemplates;
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
                        _source: block._source || null,
                        _rotationEventId: block._rotationEventId || null,
                        _rotationEventLocation: block._rotationEventLocation || null,
                        _rotationEventColor: block._rotationEventColor || null
                    });
                });
                // ★ v11.3: Validate after template execution
                ensureTimelineIntegrity(bunk);
            });
        }


        // =====================================================================
        // SCORING ENGINE
        // =====================================================================

        const MAX_ITERATIONS = 25;  // ★ v14.0: raised slightly — elite breeding may find improvements late
        const BASE_STALE_STOP = 8;
       let _iterSeed = 0, bestScore = Infinity, bestTimelines = null;
        let bestWarnings = [], staleCount = 0, totalIters = 0;

        // =====================================================================
        // ★ v14.0: TABU LIST — remember seeds that produced bad results
        // Prevents wasting iterations revisiting configurations that failed.
        // Each entry: { seed, score, reasons[], forbidUntilIter }
        // =====================================================================
        const TABU_TENURE = 5; // How many iterations to remember a bad seed
        const tabuList = new Map(); // seed → { score, reasons, forbidUntilIter }

        function recordTabuSeed(seed, score, reasons) {
            tabuList.set(seed, {
                score, reasons,
                failedAtIter: totalIters,
                forbidUntilIter: totalIters + TABU_TENURE
            });
        }

        function isSeedTabu(seed) {
            const entry = tabuList.get(seed);
            return entry && totalIters < entry.forbidUntilIter;
        }

        function getNextSeed(currentSeed) {
            let candidate = Math.max(0, currentSeed + 1);
            let attempts = 0;
            while (isSeedTabu(candidate) && attempts < 15) {
                candidate++;
                attempts++;
            }
            return candidate;
        }

        // =====================================================================
        // ★ v14.0: ELITE PRESERVATION — keep top N schedules, breed from them
        // Instead of only tracking the single best, we keep a pool of elite
        // results and use their seeds as starting points for future iterations.
        // =====================================================================
        const ELITE_SIZE = 5;
        const elitePool = []; // { score, seed, timelines, warnings, freeEstimate }

        function updateElitePool(score, seed, timelines, iterWarnings, freeEst) {
            const entry = {
                score, seed, freeEstimate: freeEst,
                timelines: {},
                warnings: [...iterWarnings]
            };
            // Deep copy timelines
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => {
                entry.timelines[bunk] = (timelines[bunk] || []).map(b => ({ ...b }));
            }));

            if (elitePool.length < ELITE_SIZE) {
                elitePool.push(entry);
                elitePool.sort((a, b) => a.score - b.score);
            } else {
                // Replace worst elite if this is better
                const worst = elitePool[elitePool.length - 1];
                if (score < worst.score) {
                    elitePool[elitePool.length - 1] = entry;
                    elitePool.sort((a, b) => a.score - b.score);
                }
            }
        }

        function getEliteBreedSeed() {
            if (elitePool.length === 0) return null;
            // Pick a random elite and mutate its seed slightly
            const idx = totalIters % elitePool.length;
            const elite = elitePool[idx];
            // Mutate: +1 to +5 from elite seed (always positive to prevent negative modulo bugs)
            const mutation = ((totalIters * 7 + 3) % 5) + 1; // 1 to 5
            return Math.abs(elite.seed + mutation);
        }

        // =====================================================================
        // ★ v14.0: DYNAMIC STOPPING — adaptive stale threshold
        // When improving fast, be patient. When stuck, stop sooner.
        // Also considers: if all penalties are structural, stop immediately.
        // =====================================================================
        function getDynamicStaleStop() {
            // Base threshold
            var threshold = BASE_STALE_STOP;

            // If we have elites and the best is very good, be less patient
            if (elitePool.length >= 3) {
                var bestElite = elitePool[0].score;
                var worstElite = elitePool[elitePool.length - 1].score;
                // If elites are clustered (< 10% spread), convergence is happening — reduce patience
                if (worstElite > 0 && (worstElite - bestElite) / worstElite < 0.10) {
                    threshold = Math.max(4, threshold - 2);
                }
            }

            // If best score is already 0, stop immediately
            if (bestScore === 0) return 0;

            // If recent improvement rate is high, be more patient
            if (totalIters > 5 && staleCount === 0) {
                threshold = Math.min(12, threshold + 2);
            }

            return threshold;
        }

        // ★ v11.0: GUIDED ITERATION — decompose score into categories for bias
        var iterationScoreBreakdown = { gaps: 0, durationViolations: 0, missingLayers: 0, sportVariety: 0, fieldSaturation: 0, estimatedFrees: 0 };
        var iterationBias = { category: null, strength: 0, history: [] };

        function computeIterationBias(breakdown, totalScore) {
            var entries = [];
            Object.keys(breakdown).forEach(function(k) { if (breakdown[k] > 0) entries.push({ cat: k, val: breakdown[k] }); });
            if (entries.length === 0) { iterationBias.category = null; iterationBias.strength = 0; return; }
            entries.sort(function(a, b) { return b.val - a.val; });
            iterationBias.category = entries[0].cat;
            iterationBias.strength = Math.min(1.0, entries[0].val / (totalScore || 1));
            iterationBias.history.push({ cat: entries[0].cat, val: entries[0].val });
            if (iterationBias.history.length > 5) iterationBias.history.shift();
        }

        // ★ Rotation quotas — computed once for scoring; timeSweepFillAll computes its own with placed counters
        var rotationQuotasForScoring = null;
        if (window.RotationEvents && typeof window.RotationEvents.getRotationQuotas === 'function') {
            try { rotationQuotasForScoring = window.RotationEvents.getRotationQuotas(currentDate); } catch (e) {}
        }

        // ★ v9.3: ITERATION LEARNING — remembers what works across iterations
        // Tracks which time positions for each need type produced good scores.
        // Later iterations bias toward positions that historically scored well.
        var iterationMemoryBank = {
            // { "grade:needType:timeSlot" → { totalScore, count, avgScore } }
            patterns: {},
            record: function(grade, needType, startMin, score) {
                var key = grade + ':' + needType + ':' + Math.floor(startMin / 30) * 30; // 30-min buckets
                if (!this.patterns[key]) this.patterns[key] = { totalScore: 0, count: 0 };
                this.patterns[key].totalScore += score;
                this.patterns[key].count++;
            },
            getBonus: function(grade, needType, startMin) {
                var key = grade + ':' + needType + ':' + Math.floor(startMin / 30) * 30;
                var p = this.patterns[key];
                if (!p || p.count < 2) return 0;
                // Lower avg score = better (scores are penalties). Invert for bonus.
                var avgScore = p.totalScore / p.count;
                return Math.max(0, 100 - Math.floor(avgScore / 1000));
            }
        };

        // ★ v10.0: REPAIR-DRIVEN ITERATION — track what failed to bias next iteration
        var repairTargets = {
            failedBunks: {},
            successfulBunks: {},
            update: function(timelines) {
                this.failedBunks = {};
                this.successfulBunks = {};
                var self = this;
                Object.keys(timelines).forEach(function(bunk) {
                    var tl = (timelines[bunk] || []).slice();
                    var hasSpecial = tl.some(function(b) { return b.type === 'special'; });
                    var hasSwim = tl.some(function(b) { return b.type === 'swim'; });
                    var hasSnack = tl.some(function(b) { return b.type === 'snacks' || b.type === 'snack'; });
                    var deadGaps = 0;
                    tl.sort(function(a, b) { return a.startMin - b.startMin; });
                    for (var i = 0; i < tl.length - 1; i++) {
                        var gap = tl[i+1].startMin - tl[i].endMin;
                        if (gap > 0 && gap < 25) deadGaps++;
                    }
                    if (!hasSpecial || !hasSwim || !hasSnack || deadGaps > 0) {
                        self.failedBunks[bunk] = {
                            missingSpecial: !hasSpecial, deadGaps: deadGaps,
                            missingLayers: [!hasSwim && 'swim', !hasSnack && 'snack'].filter(Boolean)
                        };
                    } else {
                        self.successfulBunks[bunk] = true;
                    }
                });
            }
        };

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
            // ★ v11.0: Track breakdown by category for guided iteration
            var bd = { gaps: 0, durationViolations: 0, missingLayers: 0, sportVariety: 0, fieldSaturation: 0, estimatedFrees: 0 };
            const campStart = Math.min(...Object.values(divisions).map(d => parseTimeToMinutes(d.startTime) || 660));
            const campEnd = Math.max(...Object.values(divisions).map(d => parseTimeToMinutes(d.endTime) || 990));

            // ── Bunk→grade lookup ──
            const _bunkGradeCache = {};
            allGrades.forEach(g => getBunksForGrade(g, divisions).forEach(b => { _bunkGradeCache[String(b)] = g; }));

            Object.entries(timelines).forEach(([bunk, timeline]) => {
                const gradeKey = _bunkGradeCache[String(bunk)] || '';
                const dayStart = gradeKey ? (parseTimeToMinutes(divisions[gradeKey]?.startTime) || 540) : 540;
                const dayEnd = gradeKey ? (parseTimeToMinutes(divisions[gradeKey]?.endTime) || 960) : 960;
                const sorted = [...timeline].sort((a, b) => a.startMin - b.startMin);

                // Gaps — ★ v6.0: Dead zones (gaps < 25min) get 10× penalty
                const _mfScore = getMinFillable(gradeKey || '') || GAP_MIN_DUR;
                const scoreGap = (g) => g <= 0 ? 0 : (g < _mfScore ? g * 150 : g * 15);
                if (sorted.length > 0 && sorted[0].startMin > dayStart) { var _gp = scoreGap(sorted[0].startMin - dayStart); score += _gp; bd.gaps += _gp; }
                for (let i = 0; i < sorted.length - 1; i++) { const gap = sorted[i + 1].startMin - sorted[i].endMin; var _gp2 = scoreGap(gap); score += _gp2; bd.gaps += _gp2; }
                if (sorted.length > 0 && sorted[sorted.length - 1].endMin < dayEnd) { var _gp3 = scoreGap(dayEnd - sorted[sorted.length - 1].endMin); score += _gp3; bd.gaps += _gp3; }

                // Duration violations — ★ v10.5: Penalize BOTH dMin and dMax violations.
                timeline.forEach(block => {
                    if (block._fromGapDetection && !block.layer) return;
                    const { dMin, dMax } = resolveConstraints(block.layer, (block.type || 'slot').toLowerCase(), block);
                    const dur = block.endMin - block.startMin;
                    if (dur < dMin) { var _dv = (dMin - dur) * 10000 + 100000; score += _dv; bd.durationViolations += _dv; }
                    if (dur > dMax) { var _dv2 = (dur - dMax) * 8000 + 80000; score += _dv2; bd.durationViolations += _dv2; }
                });

                // Relaxation penalty — ★ v11.0: mild penalty for relaxed blocks
                timeline.forEach(block => {
                    if (block._relaxed) { score += 500; bd.missingLayers += 500; }
                });

                // ★ v11.1: Window violation penalty — activities outside their layer window
                timeline.forEach(block => {
                    if (!block.layer) return;
                    var layerStart = block.layer.startMin, layerEnd = block.layer.endMin;
                    if (layerStart != null && block.startMin < layerStart) { var _wvp = (layerStart - block.startMin) * 5000 + 50000; score += _wvp; bd.durationViolations += _wvp; }
                    if (layerEnd != null && block.endMin > layerEnd) { var _wvp2 = (block.endMin - layerEnd) * 5000 + 50000; score += _wvp2; bd.durationViolations += _wvp2; }
                });

                // Out of bounds
                if (gradeKey) timeline.forEach(b => { if (b.endMin <= dayStart || b.startMin >= dayEnd) { score += 10000; bd.gaps += 10000; } });
            });

            iterWarnings.forEach(w => { if (w.type === 'placement_failure') { score += 500; bd.missingLayers += 500; } if (w.type === 'overlap') { score += 1000; bd.gaps += 1000; } });

            // ★ v9.3 LEVEL 3: SCHEDULE QUALITY SCORING
            Object.entries(timelines).forEach(([bunk, timeline]) => {
                const sorted = [...timeline].sort((a, b) => a.startMin - b.startMin);
                const sportNames = [];
                for (let i = 0; i < sorted.length; i++) {
                    const t = (sorted[i].type || '').toLowerCase();
                    if (t === 'sport' && sorted[i]._assignedSport) sportNames.push(sorted[i]._assignedSport);

                    // Back-to-back same activity penalty
                    if (i > 0) {
                        const prevName = sorted[i-1]._assignedSport || sorted[i-1].event;
                        const curName = sorted[i]._assignedSport || sorted[i].event;
                        if (prevName && curName && prevName === curName && t === 'sport') {
                            score += 2000; bd.sportVariety += 2000;
                        }
                    }
                }
                // Sport variety: penalize if too few unique sports
                const uniqueSports = new Set(sportNames);
                if (sportNames.length >= 3 && uniqueSports.size < Math.min(3, sportNames.length)) {
                    var _svp = (sportNames.length - uniqueSports.size) * 1000;
                    score += _svp; bd.sportVariety += _svp;
                }

                // ★ v11.0: Multi-day streak penalty
                if (weekActivityHistory) {
                    var bunkHist = weekActivityHistory[String(bunk)] || {};
                    sportNames.forEach(function(sport) {
                        var streak = 0;
                        var recentDays = getRecentDays(currentDate, 5);
                        for (var d = 0; d < recentDays.length; d++) {
                            if ((bunkHist[recentDays[d]] || []).indexOf(sport) >= 0) streak++;
                            else break;
                        }
                        if (streak >= 3) { var _sp = 5000 * (streak - 2); score += _sp; bd.sportVariety += _sp; }
                    });
                }

                // Missing required layers penalty
                const types = new Set(sorted.map(b => (b.type || '').toLowerCase()));
                const gradeKey = _bunkGradeCache[String(bunk)] || '';
                const gradeLayers = layersByGrade[gradeKey] || [];
                for (const ll of gradeLayers) {
                    const lt = (ll.type || '').toLowerCase();
                    if (['swim', 'snack', 'snacks', 'special'].includes(lt)) {
                        const hasIt = sorted.some(b => (b.type || '').toLowerCase() === lt || (lt === 'snacks' && (b.type || '').toLowerCase() === 'snack'));
                        if (!hasIt) { score += 20000; bd.missingLayers += 20000; }
                    }
                }

                // ★ Missing rotation event penalty
                if (rotationQuotasForScoring) {
                    const hasRot = sorted.some(b => b._source === 'rotation_event' && b._rotationEventId);
                    if (!hasRot) {
                        Object.values(rotationQuotasForScoring).forEach(q => {
                            if (q.remainingBunks && q.remainingBunks.has(String(bunk))) {
                                var _rp = q.isLastDay ? 50000 : 15000;
                                score += _rp; bd.missingLayers += _rp;
                            }
                        });
                    }
                }
            });

            // ── Per-grade field saturation scoring ──
            for (let t = campStart; t < campEnd; t += 5) {
                const se = t + 5;
                const gradeConsumers = {};
                Object.entries(timelines).forEach(([bk, tl]) => {
                    const g = _bunkGradeCache[String(bk)];
                    if (!g) return;
                    for (const b of tl) {
                        if (b.startMin < se && b.endMin > t && getFieldImpact(b) === 'consumer') {
                            gradeConsumers[g] = (gradeConsumers[g] || 0) + 1;
                            break;
                        }
                    }
                });

                Object.entries(gradeConsumers).forEach(([grade, demand]) => {
                    let supply = 0;
                    Object.values(fieldLedger).forEach(ledger => {
                        if (isRainy && !ledger.isIndoor) return;
                        if (ledger._isSpecialLocation) return;
                        if (ledger.activities.length === 0) return;
                        const timeOk = ledger.timeRules.some(rule => {
                            if (rule.startMin > t || rule.endMin < se) return false;
                            if (rule.divisions && !rule.divisions.includes(grade)) return false;
                            return true;
                        });
                        if (!timeOk) return;
                        const claims = ledger.claims.filter(c => c.startMin < se && c.endMin > t);
                        const crossGrade = claims.some(c => c.grade !== grade);
                        if (ledger.shareType === 'not_sharable') {
                            if (claims.length === 0) supply += 1;
                        } else if (ledger.shareType === 'same_division') {
                            if (!crossGrade) supply += Math.max(0, ledger.capacity - claims.filter(c => c.grade === grade).length);
                        } else {
                            supply += Math.max(0, ledger.capacity - claims.length);
                        }
                    });

                    const deficit = demand - supply;
                    if (deficit > 0) {
                        var _fsp = deficit * 5000;
                        score += _fsp; bd.fieldSaturation += _fsp;
                    } else if (supply > 0 && demand > 0) {
                        const ratio = demand / supply;
                        if (ratio > 0.8) { var _fsp2 = Math.round((ratio - 0.8) * 500); score += _fsp2; bd.fieldSaturation += _fsp2; }
                    }
                });

                let totalCnt = 0;
                Object.values(gradeConsumers).forEach(c => { totalCnt += c; });
                if (totalCnt > 20) { var _fsp3 = (totalCnt - 20) * 100; score += _fsp3; bd.fieldSaturation += _fsp3; }
            }

            // ★ v11.0: Store breakdown for guided iteration
            iterationScoreBreakdown = bd;
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

        // =====================================================================
        // ★ v11.0: MULTI-DAY AWARENESS — weekly activity history
        // =====================================================================

        var weekActivityHistory = {};
        function loadWeekHistory() {
            try {
                var gs = getGlobalSettings();
                var stored = gs.activityHistory || (gs.app1 && gs.app1.activityHistory);
                if (stored) Object.keys(stored).forEach(function(k) { weekActivityHistory[k] = stored[k]; });
                var ls = localStorage.getItem('campistry_activityHistory');
                if (ls && !stored) {
                    var parsed = JSON.parse(ls);
                    Object.keys(parsed).forEach(function(k) { weekActivityHistory[k] = parsed[k]; });
                }
            } catch (e) { /* ignore */ }
        }
        function saveWeekHistory(timelines) {
            try {
                // Record today's sport assignments per bunk
                Object.keys(timelines).forEach(function(bunk) {
                    if (!weekActivityHistory[bunk]) weekActivityHistory[bunk] = {};
                    var sports = [];
                    (timelines[bunk] || []).forEach(function(b) {
                        if ((b.type || '').toLowerCase() === 'sport' && b._assignedSport) {
                            sports.push(b._assignedSport);
                        }
                    });
                    if (sports.length > 0) weekActivityHistory[bunk][currentDate] = sports;
                });
                // Prune history older than 2 weeks
                var cutoff = getMondayOfWeek(currentDate, -1); // Monday of last week
                Object.keys(weekActivityHistory).forEach(function(bunk) {
                    var hist = weekActivityHistory[bunk];
                    Object.keys(hist).forEach(function(dateStr) {
                        if (dateStr < cutoff) delete hist[dateStr];
                    });
                });
                var gs = getGlobalSettings();
                if (gs.app1) gs.app1.activityHistory = weekActivityHistory;
                localStorage.setItem('campistry_activityHistory', JSON.stringify(weekActivityHistory));
                if (window.IntegrationHooks && window.IntegrationHooks.queueChange) {
                    window.IntegrationHooks.queueChange('activityHistory', weekActivityHistory);
                }
            } catch (e) { /* ignore */ }
        }

        // Helper: get array of date strings for last N days (most recent first)
        function getRecentDays(today, count) {
            var days = [];
            var d = new Date(today + 'T12:00:00');
            for (var i = 1; i <= count; i++) {
                var prev = new Date(d.getTime() - i * 86400000);
                var yyyy = prev.getFullYear();
                var mm = String(prev.getMonth() + 1).padStart(2, '0');
                var dd = String(prev.getDate()).padStart(2, '0');
                days.push(yyyy + '-' + mm + '-' + dd);
            }
            return days;
        }

        // Helper: count consecutive days a bunk played a sport (going backward from today)
        function countConsecutiveStreak(bunkHist, today, sport) {
            var streak = 0;
            var recentDays = getRecentDays(today, 7);
            for (var d = 0; d < recentDays.length; d++) {
                if ((bunkHist[recentDays[d]] || []).indexOf(sport) >= 0) streak++;
                else break;
            }
            return streak;
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
        loadWeekHistory();


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
        log('WHAT→WHEN→WHERE — cap: ' + MAX_ITERATIONS + ' | stale: ' + BASE_STALE_STOP + ' (adaptive)');
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
            if (tripBlockCount > 0) allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => ensureTimelineIntegrity(bunk)));

            // ★ v7.0: Inject bunk-specific overrides as pinned blocks
            // Re-load fresh from localStorage to catch recently added overrides
            let overrideBlockCount = 0;
            const freshDailyData = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
            let bunkOverrides = freshDailyData?.bunkActivityOverrides || dailyData?.bunkActivityOverrides || [];
            // Fallback: dedicated localStorage key (same pattern as trips)
            if (bunkOverrides.length === 0) {
                try {
                    const stored = localStorage.getItem('campBunkOverrides_' + (window.currentScheduleDate || ''));
                    if (stored) { const parsed = JSON.parse(stored); if (Array.isArray(parsed)) bunkOverrides = parsed; }
                } catch(e) {}
            }
            if (totalIters < 1) log('[P0] Bunk overrides found: ' + bunkOverrides.length + ' | bunkTimelines keys: ' + Object.keys(bunkTimelines).length);
            bunkOverrides.forEach(ov => {
                if (!ov.bunk || !ov.activity) return;
                const tStart = ov.startMin ?? parseTimeToMinutes(ov.startTime);
                const tEnd = ov.endMin ?? parseTimeToMinutes(ov.endTime);
                if (tStart == null || tEnd == null) {
                    if (totalIters < 1) warn('[P0] Override skipped — bad times: ' + ov.activity + ' start=' + ov.startTime + ' end=' + ov.endTime);
                    return;
                }
                const bunk = String(ov.bunk);
                if (!bunkTimelines[bunk]) {
                    if (totalIters < 1) warn('[P0] Override skipped — bunk not found: "' + bunk + '" (available: ' + Object.keys(bunkTimelines).slice(0, 5).join(', ') + '...)');
                    return;
                }
                // ★ v7.0: Auto-detect type from field ledger — don't rely on UI type tag
                const bunkGrade = Object.keys(divisions).find(g =>
                    getBunksForGrade(g, divisions).map(String).includes(bunk)
                ) || '';
                const sportName = ov.activity;

                // Check if ANY field hosts this activity (case-insensitive) → it's a sport
                const sportNameLower = sportName.toLowerCase().trim();
                let isSport = false;
                for (const fn of Object.keys(fieldLedger)) {
                    if (fieldLedger[fn].activities.some(a => a.toLowerCase().trim() === sportNameLower)) {
                        isSport = true;
                        break;
                    }
                }
                const blockType = isSport ? 'sport' : (ov.type === 'special' ? 'special' : 'custom');

                // Auto-assign field if not specified
                let assignedField = ov.location || null;
                if (!assignedField && isSport) {
                    for (const fn of Object.keys(fieldLedger)) {
                        const ledger = fieldLedger[fn];
                        if (!ledger.activities.some(a => a.toLowerCase().trim() === sportNameLower)) continue;
                        if (isFieldAvailable(fn, tStart, tEnd, bunk, bunkGrade, sportName)) {
                            assignedField = fn;
                            break;
                        }
                    }
                }
                if (totalIters < 1) log('[P0] Override "' + sportName + '" for ' + bunk + ': type=' + blockType + ' field=' + (assignedField || 'NONE'));

                bunkTimelines[bunk].push({
                    startMin: tStart, endMin: tEnd,
                    type: blockType, event: ov.activity,
                    field: assignedField,
                    layer: null, _classification: 'pinned', _committed: true, _fixed: true,
                    _bunkOverride: true, _activityLocked: true, _noBacktrack: true,
                    _assignedSport: isSport ? ov.activity : null,
                    _source: 'capacity_checked'
                });
                // Claim the field
                if (assignedField && bunkGrade) {
                    claimField(assignedField, tStart, tEnd, bunk, bunkGrade, ov.activity);
                }
                overrideBlockCount++;
            });
            if (overrideBlockCount > 0) {
                log('[P0] Injected ' + overrideBlockCount + ' bunk overrides');
                allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => ensureTimelineIntegrity(bunk)));
            }

            buildResourceCalendar(_iterSeed);

            // ★ v7.0: Load disabled leagues from daily overrides
            const dailyDisabledLeagues = dailyData?.overrides?.leagues || [];
            const dailyDisabledSpecialtyLeagues = dailyData?.disabledSpecialtyLeagues || [];
            window.disabledLeagues = dailyDisabledLeagues; // Expose for league engine

            // Leagues in stagger order (filter out disabled)
            const leagueLayers = nonPinnedLayers.filter(l => {
                const grade = l.grade || l.division;
                if (!grade || (allowedSet && !allowedSet.has(String(grade)))) return false;
                const t = (l.type || '').toLowerCase();
                if ((t === 'league' || t === 'specialty_league') && l._classification === 'pinned') return false;
                if (t !== 'league' && t !== 'specialty_league') return false;
                // Check if this league is disabled
                const leagueName = l.event || l.name || '';
                if (dailyDisabledLeagues.includes(leagueName) || dailyDisabledLeagues.includes(grade)) return false;
                if (t === 'specialty_league' && dailyDisabledSpecialtyLeagues.includes(leagueName)) return false;
                return true;
            });
            leagueLayers.sort((a, b) => ((staggerPlan[a.grade || a.division] || {}).offset || 0) - ((staggerPlan[b.grade || b.division] || {}).offset || 0));
            // ★ v9.6: Respect league qty/quantity — place multiple league blocks if configured
            leagueLayers.forEach(layer => {
                var leagueCount = parseInt(layer.qty) || parseInt(layer.quantity) || parseInt(layer.count) || 1;
                for (var lc = 0; lc < leagueCount; lc++) {
                    // Clear shared time cache so second league finds a NEW time
                    var leagueName = (() => {
                        var lg = (Array.isArray(window.masterLeagues) ? window.masterLeagues : Object.values(window.masterLeagues || {}))
                            .find(function(l) { return (l.divisions || []).includes(layer.grade || layer.division); });
                        return lg ? lg.name : null;
                    })();
                    if (lc > 0 && leagueName && sharedLeagueTime[leagueName] != null) {
                        delete sharedLeagueTime[leagueName]; // force new time search
                    }
                    placeLeagueForGrade(layer.grade || layer.division, layer);
                }
            });

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
            // ★ v10.4: Expose draft results for post-build healing to look up special names
            window._autoBuildDraftResults = draftResults;

            // ★ v7.0: Clear ALL draft field claims — keep only Phase 0 walls
            Object.values(fieldLedger).forEach(ledger => {
                ledger.claims = ledger.claims.filter(c => {
                    const bunkTl = bunkTimelines[c.bunk] || [];
                    return bunkTl.some(b => b._fixed && overlaps(b.startMin, b.endMin, c.startMin, c.endMin));
                });
            });

            // ═══════════════════════════════════════════════════════════
            // ★ v7.0: SIMULTANEOUS ALL-BUNK SOLVER
            // All 38 bunks processed together — specials pre-placed for
            // ALL bunks BEFORE any sport filling begins.
            // ═══════════════════════════════════════════════════════════

            const allTemplates = {};
            const staggeredGrades = [...allGrades].sort((a, b) => ((staggerPlan[a] || {}).offset || 0) - ((staggerPlan[b] || {}).offset || 0));

            todaysSwimmers = {};

            // ★ v10.0: FEASIBILITY PRE-COMPUTATION — know which bunks are tight before solving
            var feasibilityMap = {};
            allGrades.forEach(function(fGrade) {
                var fgs = parseTimeToMinutes(divisions[fGrade]?.startTime) || 540;
                var fge = parseTimeToMinutes(divisions[fGrade]?.endTime) || 960;
                getBunksForGrade(fGrade, divisions).forEach(function(fBunk) {
                    var pinnedDur = 0;
                    (bunkTimelines[fBunk] || []).forEach(function(b) { pinnedDur += (b.endMin - b.startMin); });
                    var availableMin = (fge - fgs) - pinnedDur;
                    var sl = shoppingLists[fBunk] || {};
                    var requiredMin = 0;
                    if (sl.swim) requiredMin += (sl.swim?.constraints?.dMin || 30);
                    if (sl.snack) requiredMin += (sl.snack?.constraints?.dMin || 15);
                    if (sl.specials && sl.specials.length) requiredMin += 20;
                    var sportMin = sl.sports?.constraints?.dMin || 25;
                    var sportSlots = Math.max(1, Math.floor((availableMin - requiredMin) / sportMin));
                    requiredMin += sportSlots * sportMin;
                    var slack = availableMin - requiredMin;
                    feasibilityMap[fBunk] = { availableMin: availableMin, requiredMin: requiredMin, slack: slack, grade: fGrade };
                });
            });
            staggeredGrades.forEach(grade => {
                const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
                if (swimLayer) {
                    todaysSwimmers[grade] = new Set(getSwimmersForToday(grade, getBunksForGrade(grade, divisions), swimLayer, _iterSeed).map(String));
                }
            });

            // ── Phase 2.5: Pre-place ALL specials as walls for ALL bunks ──
            // The GlobalPlanner fairly assigned 1 special per bunk with time+field.
            // By converting these to immovable walls BEFORE the packer runs,
            // no bunk can steal specials from other bunks during gap-fill.
            // ★ v10.0: SMART SPECIAL PLACEMENT — multi-position search with full feasibility simulation
            // Instead of trying ONE position and giving up, tries ALL valid positions and picks the best.
            {
                let preplacedCount = 0;
                let preplacedByGrade = {};

                // Helper: compute gaps between walls
                function spComputeGaps(walls, gs, ge) {
                    var sorted = walls.slice().sort(function(a, b) { return a.s - b.s; });
                    var gaps = [], cur = gs;
                    for (var i = 0; i < sorted.length; i++) {
                        if (sorted[i].s > cur) gaps.push({ s: cur, e: sorted[i].s });
                        cur = Math.max(cur, sorted[i].e);
                    }
                    if (cur < ge) gaps.push({ s: cur, e: ge });
                    return gaps;
                }
                // Helper: check if a required layer can fit in any gap
                function spCanLayerFit(gaps, ll) {
                    var lt = (ll.type || '').toLowerCase();
                    var lc = resolveConstraints(ll, lt);
                    var needDMin = lc.dMin || 15;
                    for (var g = 0; g < gaps.length; g++) {
                        var os = Math.max(gaps[g].s, ll.startMin);
                        var oe = Math.min(gaps[g].e, ll.endMin);
                        if (oe - os >= needDMin) return true;
                    }
                    return false;
                }

                // Process grades in most-constrained-first order
                var gradesByConstraint = allGrades.slice().sort(function(a, b) {
                    var aSlack = 0, bSlack = 0, aCount = 0, bCount = 0;
                    getBunksForGrade(a, divisions).forEach(function(bk) {
                        var f = feasibilityMap[bk]; if (f) { aSlack += f.slack; aCount++; }
                    });
                    getBunksForGrade(b, divisions).forEach(function(bk) {
                        var f = feasibilityMap[bk]; if (f) { bSlack += f.slack; bCount++; }
                    });
                    return (aCount ? aSlack / aCount : 999) - (bCount ? bSlack / bCount : 999);
                });

                gradesByConstraint.forEach(grade => {
                    preplacedByGrade[grade] = 0;
                    var gradeLayers = layersByGrade[grade] || [];
                    var gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    var gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;

                    // Sort bunks: most constrained first
                    var bunkOrder = getBunksForGrade(grade, divisions).slice();
                    bunkOrder.sort(function(a, b) {
                        var fa = feasibilityMap[a], fb = feasibilityMap[b];
                        return (fa ? fa.slack : 999) - (fb ? fb.slack : 999);
                    });

                    bunkOrder.forEach(bunk => {
                        const draft = draftResults[bunk];
                        if (!draft || !draft.specials || !draft.specials.length) return;
                        const special = draft.specials[0];
                        if (!special || !special.claimedTime) return;
                        // ★ v14.0: Always use configured duration from special_activities config.
                        // Draft duration may be wrong; getSpecialDuration() is authoritative.
                        const configuredDur = getSpecialDuration(special.name || special.event || '', activityProperties, globalSettings);
                        const specialDur = configuredDur || special.duration || (special.claimedTime.endMin - special.claimedTime.startMin);
                        const fieldName = special.claimedField || special.location;
                        const draftStart = special.claimedTime.startMin;

                        var sportFillMin = Math.max((shoppingLists[bunk]?.sports?.constraints?.dMin || 25), TYPE_FLOORS.sport || 25);
                        // ★ v10.0: Use adaptive fillMinDur for constrained bunks
                        var bf = feasibilityMap[bunk];
                        if (bf && bf.slack < 30) sportFillMin = Math.max(20, sportFillMin - 5);

                        var existingWalls = (bunkTimelines[bunk] || []).map(w => ({ s: w.startMin, e: w.endMin }));
                        var allGapsForBunk = spComputeGaps(existingWalls, gradeStart, gradeEnd);

                        // ★ v14.0: Pre-compute which required layers ALREADY fit in current gaps.
                        // Only layers that currently fit can block special placement.
                        // If a layer already can't fit (e.g., snack window has no viable gap),
                        // don't let it veto the special — the special isn't the cause.
                        var layersThatCurrentlyFit = [];
                        for (var pli = 0; pli < gradeLayers.length; pli++) {
                            var pll = gradeLayers[pli];
                            var plt = (pll.type || '').toLowerCase();
                            if (!['swim', 'snack', 'snacks', 'custom'].includes(plt)) continue;
                            if (plt === 'custom' && pll._classification === 'pinned') continue;
                            if (pll.startMin == null || pll.endMin == null) continue;
                            if (spCanLayerFit(allGapsForBunk, pll)) {
                                layersThatCurrentlyFit.push(pll);
                            }
                        }

                        // ★ Try ALL valid positions for this special
                        var candidatePositions = [];
                        var _sp25_rtBlockCount = 0, _sp25_layerBlockCount = 0, _sp25_gapTooSmall = 0;
                        for (var gi = 0; gi < allGapsForBunk.length; gi++) {
                            var gap = allGapsForBunk[gi];
                            if (gap.e - gap.s < specialDur) { _sp25_gapTooSmall++; continue; }

                            for (var pos = gap.s; pos + specialDur <= gap.e; pos += 5) {
                                // Resource check: can this special run at this time?
                                if (!canUseSpecialAtTime(special.name, grade, pos, pos + specialDur)) { _sp25_rtBlockCount++; continue; }

                                // Simulate adding special at this position
                                var withSpecial = existingWalls.concat([{ s: pos, e: pos + specialDur }]);
                                var gapsAfter = spComputeGaps(withSpecial, gradeStart, gradeEnd);

                                // HARD CHECK: only check layers that CURRENTLY fit.
                                // If a layer already doesn't fit, the special isn't to blame.
                                var allLayersFit = true;
                                for (var li = 0; li < layersThatCurrentlyFit.length; li++) {
                                    var ll = layersThatCurrentlyFit[li];
                                    if (!spCanLayerFit(gapsAfter, ll)) { allLayersFit = false; break; }
                                }
                                if (!allLayersFit) { _sp25_layerBlockCount++; continue; }

                                // Score this position
                                var score = 0;
                                var deadGapCount = 0;
                                var gapSizes = [];
                                for (var ag = 0; ag < gapsAfter.length; ag++) {
                                    var gSize = gapsAfter[ag].e - gapsAfter[ag].s;
                                    if (gSize <= 0) continue;
                                    gapSizes.push(gSize);
                                    if (gSize < sportFillMin) { deadGapCount++; score -= 500; }
                                    else { score += 50; } // fillable gap bonus
                                }

                                // Wall-aligned bonus (flush against existing blocks)
                                var leftGap = pos - gap.s;
                                var rightGap = gap.e - (pos + specialDur);
                                if (leftGap === 0 || rightGap === 0) score += 100;
                                if (leftGap === 0 && rightGap === 0) score += 50; // perfect fit

                                // Balance: prefer even gap distribution
                                if (gapSizes.length >= 2) {
                                    var totalGap = 0;
                                    for (var gs2 = 0; gs2 < gapSizes.length; gs2++) totalGap += gapSizes[gs2];
                                    var avgGap = totalGap / gapSizes.length;
                                    var variance = 0;
                                    for (var vs = 0; vs < gapSizes.length; vs++) variance += (gapSizes[vs] - avgGap) * (gapSizes[vs] - avgGap);
                                    score -= Math.floor(variance / 100);
                                }

                                // Draft position bonus (preserve GlobalPlanner's intent)
                                if (pos === draftStart) score += 200;

                                candidatePositions.push({ pos: pos, score: score, deadGapCount: deadGapCount });
                            }

                            // Also try end-aligned position (may not be on 5-min boundary)
                            var endPos = gap.e - specialDur;
                            if (endPos >= gap.s && endPos !== gap.s && endPos % 5 !== 0) {
                                if (canUseSpecialAtTime(special.name, grade, endPos, endPos + specialDur)) {
                                    var withSpecialEnd = existingWalls.concat([{ s: endPos, e: endPos + specialDur }]);
                                    var gapsAfterEnd = spComputeGaps(withSpecialEnd, gradeStart, gradeEnd);
                                    var layersFitEnd = true;
                                    for (var lei = 0; lei < layersThatCurrentlyFit.length; lei++) {
                                        var lle = layersThatCurrentlyFit[lei];
                                        if (!spCanLayerFit(gapsAfterEnd, lle)) { layersFitEnd = false; break; }
                                    }
                                    if (layersFitEnd) {
                                        var endScore = 100; // wall-aligned
                                        var endDeadGaps = 0;
                                        for (var eg = 0; eg < gapsAfterEnd.length; eg++) {
                                            var egSize = gapsAfterEnd[eg].e - gapsAfterEnd[eg].s;
                                            if (egSize > 0 && egSize < sportFillMin) { endDeadGaps++; endScore -= 500; }
                                            else if (egSize > 0) endScore += 50;
                                        }
                                        if (endPos === draftStart) endScore += 200;
                                        candidatePositions.push({ pos: endPos, score: endScore, deadGapCount: endDeadGaps });
                                    }
                                }
                            }
                        }

                        // ★ v14.0: If no positions found at full configured duration,
                        // try progressively shorter durations (down to type floor).
                        // A shorter special is far better than no special at all.
                        if (candidatePositions.length === 0) {
                            var spTypeFloor = TYPE_FLOORS.special || 20;
                            var triedDur = specialDur;
                            while (candidatePositions.length === 0 && triedDur > spTypeFloor) {
                                triedDur = Math.max(spTypeFloor, triedDur - 5);
                                for (var rgi = 0; rgi < allGapsForBunk.length; rgi++) {
                                    var rgap = allGapsForBunk[rgi];
                                    if (rgap.e - rgap.s < triedDur) continue;
                                    for (var rpos = rgap.s; rpos + triedDur <= rgap.e; rpos += 5) {
                                        if (!canUseSpecialAtTime(special.name, grade, rpos, rpos + triedDur)) continue;
                                        var rwithSpecial = existingWalls.concat([{ s: rpos, e: rpos + triedDur }]);
                                        var rgapsAfter = spComputeGaps(rwithSpecial, gradeStart, gradeEnd);
                                        var rallFit = true;
                                        for (var rli = 0; rli < layersThatCurrentlyFit.length; rli++) {
                                            var rll = layersThatCurrentlyFit[rli];
                                            if (!spCanLayerFit(rgapsAfter, rll)) { rallFit = false; break; }
                                        }
                                        if (rallFit) candidatePositions.push({ pos: rpos, score: -100, deadGapCount: 0 });
                                    }
                                }
                            }
                            if (candidatePositions.length > 0 && totalIters < 1) {
                                warn('[Phase2.5] Reduced ' + special.name + ' from ' + specialDur + 'min to ' + triedDur + 'min for bunk ' + bunk + ' (will be corrected by SPECIAL-ENFORCE if room exists later)');
                            }
                        }

                        // Pick the best position
                        if (candidatePositions.length === 0) {
                            if (totalIters < 1) {
                                var gapSummary = allGapsForBunk.map(function(g) { return (g.e - g.s) + 'min'; }).join(', ');
                                warn('[Phase2.5] Cannot pre-place ' + special.name + ' (' + specialDur + 'min) for bunk ' + bunk + ' in ' + grade +
                                    ' — gaps: [' + gapSummary + '] | blocked: RT=' + _sp25_rtBlockCount + ' layers=' + _sp25_layerBlockCount + ' gapTooSmall=' + _sp25_gapTooSmall);
                            }
                            return; // defer to CSP
                        }

                        candidatePositions.sort(function(a, b) {
                            if (a.deadGapCount !== b.deadGapCount) return a.deadGapCount - b.deadGapCount;
                            return b.score - a.score;
                        });
                        var best = candidatePositions[0];

                        // Place the special at the best position
                        var bestStart = best.pos;
                        var bestEnd = bestStart + specialDur;

                        bunkTimelines[bunk].push({
                            startMin: bestStart, endMin: bestEnd,
                            type: 'special', event: special.name,
                            layer: special._layer || null,
                            _classification: 'pinned', _committed: true, _fixed: true,
                            _gradeWide: false, _activityLocked: true, _noBacktrack: false,
                            _assignedSpecial: special.name,
                            _specialLocation: fieldName,
                            _specialDuration: specialDur,
                            _isSpecialLocation: true, _source: 'pre-placed'
                        });

                        registerSpecialUsage(special.name, grade, bestStart, bestEnd);
                        registerCrossGrade(grade, 'special', bestStart, bestEnd, special.name);

                        if (fieldName && fieldLedger[fieldName]) {
                            fieldLedger[fieldName].claims.push({
                                bunk: bunk, grade: grade, activity: special.name,
                                startMin: bestStart, endMin: bestEnd
                            });
                        }

                        ensureTimelineIntegrity(bunk);
                        preplacedCount++;
                        preplacedByGrade[grade]++;
                    });
                });
                log('[Phase2.5] ★ PRE-PLACED ' + preplacedCount + ' specials as walls across ALL bunks');
                allGrades.forEach(grade => {
                    log('[Phase2.5]   Grade ' + grade + ': ' + preplacedByGrade[grade] + '/' + getBunksForGrade(grade, divisions).length + ' bunks got specials');
                });
            }

            // ── Phase 3: Time-sweep sport filler (v8.0) ──
            // All bunks processed simultaneously. Walls never move.
            const sweepResult = timeSweepFillAll(shoppingLists, draftResults, allGrades);
            Object.assign(allTemplates, sweepResult);

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

            // ══════════════════════════════════════════════════════════
            // ★ v11.2: SWAP-BASED LOCAL SEARCH (Post-Placement Optimization)
            // After the full schedule is built, try swapping sport assignments
            // between bunks to improve field utilization and reduce Frees.
            // ══════════════════════════════════════════════════════════
            {
                var swapCount = 0;

                allGrades.forEach(function(swapGrade) {
                    var swapBunks = getBunksForGrade(swapGrade, divisions);
                    if (swapBunks.length < 2) return;

                    // Collect all sport blocks per bunk
                    var bunkSportBlocks = {};
                    swapBunks.forEach(function(sb) {
                        bunkSportBlocks[sb] = (bunkTimelines[sb] || []).filter(function(b) {
                            return (b.type || '').toLowerCase() === 'sport' && b._assignedSport && b.field && !b._fixed;
                        });
                    });

                    // Try pairwise swaps within the same time window
                    for (var si1 = 0; si1 < swapBunks.length; si1++) {
                        for (var si2 = si1 + 1; si2 < swapBunks.length; si2++) {
                            var b1 = swapBunks[si1], b2 = swapBunks[si2];
                            var blocks1 = bunkSportBlocks[b1] || [];
                            var blocks2 = bunkSportBlocks[b2] || [];

                            for (var sb1 = 0; sb1 < blocks1.length; sb1++) {
                                for (var sb2 = 0; sb2 < blocks2.length; sb2++) {
                                    var blk1 = blocks1[sb1], blk2 = blocks2[sb2];
                                    // Only swap if at the same time (exact match for sharing rules)
                                    if (blk1.startMin !== blk2.startMin || blk1.endMin !== blk2.endMin) continue;
                                    if (blk1._assignedSport === blk2._assignedSport) continue; // already same

                                    // Check if swap is valid (each bunk can use the other's field)
                                    var can1use2 = isFieldAvailable(blk2.field, blk1.startMin, blk1.endMin, b1, swapGrade, blk2._assignedSport);
                                    var can2use1 = isFieldAvailable(blk1.field, blk2.startMin, blk2.endMin, b2, swapGrade, blk1._assignedSport);
                                    if (!can1use2 || !can2use1) continue;

                                    // Check if swap improves variety for both bunks
                                    var b1Sports = new Set(blocks1.map(function(x) { return x._assignedSport; }));
                                    var b2Sports = new Set(blocks2.map(function(x) { return x._assignedSport; }));
                                    var b1Before = b1Sports.size, b2Before = b2Sports.size;

                                    // Simulate swap
                                    b1Sports.delete(blk1._assignedSport); b1Sports.add(blk2._assignedSport);
                                    b2Sports.delete(blk2._assignedSport); b2Sports.add(blk1._assignedSport);
                                    var b1After = b1Sports.size, b2After = b2Sports.size;

                                    if (b1After + b2After > b1Before + b2Before) {
                                        // Swap improves total variety — do it
                                        var tmpSport = blk1._assignedSport, tmpField = blk1.field, tmpEvent = blk1.event;
                                        blk1._assignedSport = blk2._assignedSport; blk1.field = blk2.field; blk1.event = blk2.event;
                                        blk2._assignedSport = tmpSport; blk2.field = tmpField; blk2.event = tmpEvent;
                                        swapCount++;
                                    }
                                }
                            }
                        }
                    }
                });
                if (swapCount > 0) log('[Phase3+] ★ Swap optimizer: ' + swapCount + ' beneficial swaps');
            }

           // ── Quick-solve simulation: count slots that can't find any field ──
            // Mirrors auto_solver_engine logic exactly: sharing rules, capacity,
            // cross-division, exact time match, same-day repeat
            let iterFreeEstimate = 0;
            {
                // Build time-based field index from all packer claims
                const simFieldIndex = new Map();
                Object.values(fieldLedger).forEach(ledger => {
                    const fn = ledger.name.toLowerCase().trim();
                    if (!simFieldIndex.has(fn)) simFieldIndex.set(fn, []);
                    ledger.claims.forEach(c => {
                        simFieldIndex.get(fn).push({ ...c, fieldNorm: fn });
                    });
                });

                // Build per-bunk activity sets (all committed activities)
                const simBunkDone = {};
                allGrades.forEach(grade => {
                    getBunksForGrade(grade, divisions).forEach(bunk => {
                        const done = new Set();
                        (bunkTimelines[bunk] || []).forEach(b => {
                            const act = (b._assignedSport || b._assignedSpecial || b.event || '').toLowerCase().trim();
                            if (act && act !== 'general activity slot') done.add(act);
                        });
                        simBunkDone[String(bunk)] = done;
                    });
                });

                // Simulate solving each unassigned sport/slot block
                allGrades.forEach(grade => {
                    getBunksForGrade(grade, divisions).forEach(bunk => {
                        const bunkStr = String(bunk);
                        const done = simBunkDone[bunkStr];

                        (bunkTimelines[bunk] || []).forEach(block => {
                            const t = (block.type || '').toLowerCase();
                            if (t !== 'sport' && t !== 'slot') return;
                            if (block._activityLocked || block._fixed) return;
                            if (block._source === 'capacity_checked' && (block.field || block._draftField)) return;

                            const startMin = block.startMin;
                            const endMin = block.endMin;
                            const sportList = block._sportFallbacks || [];
                            let found = false;

                            for (const sportName of sportList) {
                                const sportNorm = sportName.toLowerCase().trim();
                                // Same-day repeat check
                                if (done.has(sportNorm)) continue;

                                // Find fields for this sport
                                for (const fn of Object.keys(fieldLedger)) {
                                    const ledger = fieldLedger[fn];
                                    if (ledger._isSpecialLocation) continue;
                                    if (!ledger.activities.includes(sportName)) continue;
                                    if (isRainy && !ledger.isIndoor) continue;

                                    // Time rules
                                    const timeOk = ledger.timeRules.some(rule => {
                                        if (rule.startMin > startMin || rule.endMin < endMin) return false;
                                        if (rule.divisions && !rule.divisions.includes(grade)) return false;
                                        return true;
                                    });
                                    if (!timeOk) continue;

                                    const fnNorm = fn.toLowerCase().trim();
                                    const entries = simFieldIndex.get(fnNorm) || [];
                                    const overlapping = entries.filter(e =>
                                        e.startMin < endMin && e.endMin > startMin && e.bunk !== bunkStr
                                    );

                                    // Sharing rules (mirrors isFieldAvailableByTime exactly)
                                    const st = ledger.shareType || 'same_division';
                                    const cap = ledger.capacity || 2;
                                    let blocked = false;

                                    if (st === 'not_sharable') {
                                        if (overlapping.length > 0) blocked = true;
                                    } else if (st === 'same_division') {
                                        if (overlapping.some(e => e.grade !== grade)) blocked = true;
                                        if (!blocked && overlapping.filter(e => e.grade === grade).length >= cap) blocked = true;
                                    } else if (st === 'custom') {
                                        const allowed = ledger.allowedDivisions || [];
                                        if (allowed.length > 0) {
                                            if (overlapping.some(e => e.grade !== grade && !allowed.includes(e.grade))) blocked = true;
                                            if (!blocked && overlapping.length > 0 && !allowed.includes(grade)) blocked = true;
                                        } else {
                                            if (overlapping.some(e => e.grade !== grade)) blocked = true;
                                        }
                                        if (!blocked && overlapping.length >= cap) blocked = true;
                                    } else {
                                        if (overlapping.length >= cap) blocked = true;
                                    }
                                    if (blocked) continue;

                                    // Exact time match
                                    if (overlapping.length > 0 && cap > 1) {
                                        const sameGrade = overlapping.filter(e => e.grade === grade);
                                        if (sameGrade.length > 0 && sameGrade.some(e => e.startMin !== startMin || e.endMin !== endMin)) continue;
                                    }

                                    // ✅ Can place — record simulated claim
                                    if (!simFieldIndex.has(fnNorm)) simFieldIndex.set(fnNorm, []);
                                    simFieldIndex.get(fnNorm).push({
                                        startMin, endMin, bunk: bunkStr, grade,
                                        activity: sportName, fieldNorm: fnNorm
                                    });
                                    done.add(sportNorm);
                                    found = true;
                                    break;
                                }
                                if (found) break;
                            }

                            if (!found) iterFreeEstimate++;
                        });
                    });
                });
            }

            // Score
            const iterWarnings = [];
            let iterScore = scoreTimelines(bunkTimelines, iterWarnings);
            // ★ Massive penalty for estimated Frees — #1 priority to minimize
            iterScore += iterFreeEstimate * 50000;
            iterationScoreBreakdown.estimatedFrees = iterFreeEstimate * 50000;
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

            // ★ v14.0: Update elite pool with this iteration's result
            updateElitePool(iterScore, _iterSeed, bunkTimelines, iterWarnings, iterFreeEstimate);

            // ★ v14.0: Record tabu for bad seeds (high free count or missing layers)
            {
                var tabuReasons = [];
                if (iterFreeEstimate > 3) tabuReasons.push('high_frees_' + iterFreeEstimate);
                var _mls = iterationScoreBreakdown.missingLayers || 0;
                if (_mls > 0) tabuReasons.push('missing_layers');
                var _gs = iterationScoreBreakdown.gaps || 0;
                if (_gs > 50000) tabuReasons.push('dead_gaps');
                if (tabuReasons.length > 0) {
                    recordTabuSeed(_iterSeed, iterScore, tabuReasons);
                }
            }

            // ★ v9.3: Record placement patterns from this iteration for learning
            allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => {
                (bunkTimelines[bunk] || []).forEach(b => {
                    var t = (b.type || '').toLowerCase();
                    if (['swim', 'snacks', 'snack', 'special'].includes(t)) {
                        iterationMemoryBank.record(grade, t, b.startMin, iterScore);
                    }
                });
            }));

            // ★ v14.0: Dynamic stale threshold
            var STALE_STOP = getDynamicStaleStop();

            if (improved || totalIters <= 3 || totalIters % 5 === 0) {
               log('[ITER ' + totalIters + '] score=' + iterScore + (improved ? ' ★ BEST' : '') + ' | best=' + bestScore + ' | stale=' + staleCount + '/' + STALE_STOP + ' | estFree=' + iterFreeEstimate + ' | elites=' + elitePool.length + ' | tabu=' + tabuList.size);
            }

            // ★ v10.0: Update repair targets for next iteration
            repairTargets.update(bunkTimelines);

            // ★ v11.0: Compute iteration bias from score breakdown
            computeIterationBias(iterationScoreBreakdown, iterScore);

            // ★ v11.2: Quality-aware termination — detect structurally unfixable scores
            var _qat = false;
            if (staleCount >= 3 && bestScore > 0) {
                var _bd = iterationScoreBreakdown;
                var _fixable = _bd.gaps + _bd.durationViolations + _bd.missingLayers + _bd.sportVariety;
                var _structural = _bd.fieldSaturation + _bd.estimatedFrees;
                if (_fixable === 0 && _structural > 0) {
                    log('[ITER ' + totalIters + '] ★ Quality-aware stop: remaining score (' + bestScore + ') is structural (field saturation/frees) — further iteration cannot improve');
                    _qat = true;
                }
            }

            // ★ v14.0: Select next seed using tabu + elite breeding
            if (!_qat && bestScore > 0 && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS) {
                // Strategy: alternate between elite breeding and tabu-aware increment
                if (elitePool.length >= 2 && totalIters % 3 === 0) {
                    // Every 3rd iteration: breed from an elite
                    var breedSeed = getEliteBreedSeed();
                    if (breedSeed !== null && !isSeedTabu(breedSeed)) {
                        _iterSeed = breedSeed;
                        if (totalIters <= 10) log('[ITER] Breeding from elite seed → ' + _iterSeed);
                    } else {
                        _iterSeed = getNextSeed(_iterSeed);
                    }
                } else {
                    // Normal: increment but skip tabu seeds
                    _iterSeed = getNextSeed(_iterSeed);
                }
                warnings.length = 0;
                resetIterState();
            }

        } while (!_qat && bestScore > 0 && staleCount < STALE_STOP && totalIters < MAX_ITERATIONS);

        log('══════════════════════════════════════════════════════════');
        log('BEST: ' + bestScore + ' after ' + totalIters + ' iterations' + (_qat ? ' (structural limit reached)' : ''));
        log('Elite pool: ' + elitePool.length + ' schedules | Tabu list: ' + tabuList.size + ' seeds forbidden');
        if (elitePool.length > 0) {
            log('Elite scores: ' + elitePool.map(function(e) { return e.score + '(seed=' + e.seed + ')'; }).join(', '));
        }
        log('══════════════════════════════════════════════════════════');

        // ★ v14.0: Restore from best elite (which may be better than bestTimelines
        // if a later iteration improved an elite via breeding)
        var restoreSource = bestTimelines;
        if (elitePool.length > 0 && elitePool[0].score <= bestScore) {
            restoreSource = elitePool[0].timelines;
            bestScore = elitePool[0].score;
            log('Restoring from elite pool (score=' + bestScore + ')');
        }
        allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => { bunkTimelines[bunk] = (restoreSource && restoreSource[bunk]) || []; }));
        warnings.length = 0;
        bestWarnings.forEach(w => warnings.push(w));

        // Debug exports
        window._bunkTimelines = JSON.parse(JSON.stringify(bunkTimelines));
        window._autoBuildTimelines = JSON.parse(JSON.stringify(bunkTimelines));

        // ─── Mark rotation event completions (so tomorrow's build skips these bunks) ───
        // Read directly from bunkTimelines because scheduleAssignments hasn't been written yet.
        // Any block where _source === 'rotation_event' (from timeSweepFillAll needs) means a
        // rotation event was successfully placed for that bunk.
        try {
            if (window.RotationEvents && typeof window.RotationEvents.markCompleted === 'function' && currentDate) {
                const byEvent = {}; // { eventId: Set<bunk> }
                allGrades.forEach(grade => {
                    getBunksForGrade(grade, divisions).forEach(bunk => {
                        const tl = bunkTimelines[bunk] || [];
                        tl.forEach(b => {
                            if (b && b._source === 'rotation_event' && b._rotationEventId) {
                                if (!byEvent[b._rotationEventId]) byEvent[b._rotationEventId] = new Set();
                                byEvent[b._rotationEventId].add(String(bunk));
                            }
                        });
                    });
                });
                let totalMarked = 0;
                Object.entries(byEvent).forEach(([eid, bunkSet]) => {
                    const bunks = Array.from(bunkSet);
                    window.RotationEvents.markCompleted(eid, currentDate, bunks);
                    totalMarked += bunks.length;
                });
                if (totalMarked > 0) log('[2.5+] ✅ Rotation events: marked ' + totalMarked + ' bunk completions');
            }
        } catch (e) {
            console.warn('[scheduler_core_auto] Rotation event completion tracking failed:', e);
        }


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

        // Write rotation event blocks (camp-wide pass-through activities)
        let rotationEventWriteCount = 0;
        allGrades.forEach(grade => {
            const pbs = window.divisionTimes?.[grade]?._perBunkSlots;
            if (!pbs) return;
            getBunksForGrade(grade, divisions).forEach(bunk => {
                const arr = pbs[String(bunk)] || [];
                (bunkTimelines[bunk] || []).filter(b => b._source === 'rotation_event').forEach(block => {
                    const idx = arr.findIndex(s => s.startMin === block.startMin && s.endMin === block.endMin);
                    if (idx === -1) return;
                   window.scheduleAssignments[String(bunk)][idx] = {
                        field: block._rotationEventLocation || block.event,
                        sport: null,
                        _activity: block.event,
                        _fixed: true,
                        _pinned: true,
                        _bunkOverride: true,
                        _activityLocked: true,
                        _autoSpecial: true,
                        _isRotationEvent: true,
                        _rotationEventId: block._rotationEventId || null,
                        _rotationEventColor: block._rotationEventColor || null,
                        _autoMode: true,
                        continuation: false
                    };
                    rotationEventWriteCount++;                });
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
                        // ★ FIX: Sport overrides arrive as fixed blocks with event="Basketball"
                        // but no court assigned. Look up an available court at write time.
                        let resolvedField = isCustom ? block._customField : block.event;
                        let resolvedSport = null;
                        const blockType = (block.type || '').toLowerCase();
                        const isSportOverride = !isCustom && blockType === 'sport';

                        if (isSportOverride) {
                            const sportName = block.event;
                            const app1 = window.loadGlobalSettings?.().app1 || {};
                            const allFields = app1.fields || [];
                            const courts = allFields
                                .filter(f => (f.activities || []).some(a =>
                                    String(a).toLowerCase().trim() === String(sportName).toLowerCase().trim()
                                ))
                                .map(f => f.name);

                            // Pick first court not already claimed at this time across the day
                            let pickedCourt = null;
                            for (const court of courts) {
                                let inUse = false;
                                // Check existing scheduleAssignments for cross-bunk conflicts at this time
                                for (const [otherBunk, otherSlots] of Object.entries(window.scheduleAssignments || {})) {
                                    if (String(otherBunk) === String(bunk)) continue;
                                    if (!Array.isArray(otherSlots)) continue;
                                    // Find that bunk's grade + per-bunk slots to resolve times
                                    const otherGrade = Object.entries(divisions).find(([g, d]) =>
                                        (d.bunks || []).map(String).includes(String(otherBunk))
                                    )?.[0];
                                    const otherPbs = otherGrade ? (window.divisionTimes?.[otherGrade]?._perBunkSlots?.[String(otherBunk)] || []) : [];
                                    for (let oi = 0; oi < otherSlots.length; oi++) {
                                        const oe = otherSlots[oi];
                                        if (!oe || oe.continuation) continue;
                                        const oslot = otherPbs[oi];
                                        if (!oslot) continue;
                                        if (oslot.endMin <= block.startMin || oslot.startMin >= block.endMin) continue;
                                        const oField = typeof oe.field === 'object' ? oe.field?.name : oe.field;
                                        if (oField && String(oField).toLowerCase() === String(court).toLowerCase()) {
                                            inUse = true; break;
                                        }
                                    }
                                    if (inUse) break;
                                }
                                if (!inUse) { pickedCourt = court; break; }
                            }

                            // Last resort: take first court even if "in use" — override is user-mandated
                            if (!pickedCourt && courts.length > 0) {
                                pickedCourt = courts[0];
                                console.warn(`[Override] No clean court for ${sportName}, forcing ${pickedCourt} for ${bunk}`);
                            }

                            if (pickedCourt) {
                                resolvedField = pickedCourt;
                                resolvedSport = sportName;
                                console.log(`[Override] ${bunk}: ${sportName} → ${pickedCourt}`);
                            } else {
                                console.warn(`[Override] No fields configured for sport "${sportName}" — keeping activity name as field`);
                            }
                        }

                        window.scheduleAssignments[String(bunk)][idx] = {
                            field: resolvedField,
                            sport: resolvedSport,
                            _activity: isCustom ? (block._customActivity || block.event) : block.event,
                            _fixed: true, _pinned: block._classification === 'pinned',
                            _bunkOverride: true, _activityLocked: isCustom || false,
                            _customActivity: block._customActivity || null,
                            _customField: block._customField || null,
                            _autoMode: true, continuation: false
                        };

                        // Lock the resolved court so other writers/solvers can't double-book it
                        if (isSportOverride && resolvedField && resolvedField !== block.event) {
                            if (window.AutoFieldLocks) {
                                window.AutoFieldLocks.lockField(resolvedField, block.startMin, block.endMin, grade, resolvedSport, 'auto_override');
                            }
                            if (window.GlobalFieldLocks) {
                                window.GlobalFieldLocks.lockField(resolvedField, [idx], { lockedBy: 'auto_override', division: grade, activity: resolvedSport, startMin: block.startMin, endMin: block.endMin });
                            }
                        }                        if (isCustom) {
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

        log('[2.7] ✅ ' + specialWriteCount + ' specials, ' + pinnedWriteCount + ' pinned, ' + sportWriteCount + ' sports, ' + anchorWriteCount + ' anchors, ' + customWriteCount + ' custom, ' + rotationEventWriteCount + ' rotation events');

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
                    if ((block.type || '') === 'rotation_event') return;
                    if (block._activityLocked) return;
                    const ex = window.scheduleAssignments[String(bunk)][idx];
                    if (ex && ex._fixed) return;
                    if (ex && ex.field === 'Free' && !ex._fixed) window.scheduleAssignments[String(bunk)][idx] = null;
                    const skipTypes = ['swim', 'snacks', 'lunch', 'dismissal', 'pinned', 'league', 'specialty_league', 'rotation_event'];
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
                divName: b.division,
                // ★ v6.0: Set bunks array (not single bunk) so fillBlock takes the league path
                // League teams ≠ bunks — fillBlock stores matchups when it sees bunks array
                bunks: getBunksForGrade(b.division, divisions).map(String),
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
            // ★ v6.0: Override fillBlock to also copy matchup data onto the block object
            // The default fillBlock stores in leagueAssignments but doesn't modify the block
            const origFillBlock = lctx.fillBlock;
            lctx.fillBlock = function(block, pick, fubs, yh, isLeague, ap) {
                // Call original to store in leagueAssignments
                if (origFillBlock) origFillBlock(block, pick, fubs, yh, isLeague, ap);
                // Also copy matchup data directly onto the block for our writeback
                if (pick && block) {
                    if (pick._allMatchups) block._allMatchups = pick._allMatchups;
                    if (pick._gameLabel) block._gameLabel = pick._gameLabel;
                    if (pick._leagueName) block._leagueName = pick._leagueName;
                    if (pick.sport) block._sport = pick.sport;
                    if (pick._h2h) block._h2h = pick._h2h;
                }
            };
            if (window.SchedulerCoreSpecialtyLeagues?.processSpecialtyLeagues) { try { lctx.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'specialty_league'); window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(lctx); } catch (e) { warn('[3] Specialty: ' + e.message); } }
            if (window.SchedulerCoreLeagues?.processRegularLeagues) { try { lctx.schedulableSlotBlocks = leagueBlocks.filter(b => b.type === 'league'); window.SchedulerCoreLeagues.processRegularLeagues(lctx); } catch (e) { warn('[3] Regular: ' + e.message); } }

            // ★ v6.0: Read matchups from processed leagueBlocks → populate leagueAssignments + scheduleAssignments
            let leagueWriteCount = 0;
            leagueBlocks.forEach(lb => {
                const matchups = lb._allMatchups || [];
                const sport = lb._sport || lb.sport || '';
                const leagueName = lb._leagueName || lb._activity || '';
                const gameLabel = lb._gameLabel || '';

                // Write to leagueAssignments (authoritative source for grid renderer)
                if (!window.leagueAssignments[lb.divName]) window.leagueAssignments[lb.divName] = {};
                window.leagueAssignments[lb.divName][lb.startMin] = {
                    matchups, gameLabel, sport, leagueName
                };

                // Write to scheduleAssignments for each bunk (triggers league row detection in grid)
                const pbs = window.divisionTimes?.[lb.divName]?._perBunkSlots;
                if (!pbs) return;
                Object.entries(pbs).forEach(([bk, bs]) => {
                    const fi = bs.findIndex(s => s.startMin === lb.startMin);
                    if (fi === -1 || !window.scheduleAssignments[bk]) return;
                    window.scheduleAssignments[bk][fi] = {
                        field: sport || 'League Game', sport: sport || null,
                        _activity: 'League Game', _league: true, _leagueName: leagueName,
                        _gameLabel: gameLabel, matchups: matchups,
                        _fixed: true, continuation: false
                    };
                    leagueWriteCount++;
                });
            });

            // Also read from storeLeagueMatchups callback results (if any)
            Object.entries(window.leagueAssignments || {}).forEach(([gn, gs]) => {
                Object.entries(gs).forEach(([startMinStr, asgn]) => {
                    if (!asgn || !asgn.matchups || asgn.matchups.length === 0) return;
                    const pbs = window.divisionTimes?.[gn]?._perBunkSlots;
                    if (!pbs) return;
                    Object.entries(pbs).forEach(([bk, bs]) => {
                        const fi = bs.findIndex(s => s.startMin === parseInt(startMinStr));
                        if (fi === -1 || !window.scheduleAssignments[bk]) return;
                        const existing = window.scheduleAssignments[bk][fi];
                        if (existing && existing._league && existing.matchups && existing.matchups.length > 0) return; // already written
                        window.scheduleAssignments[bk][fi] = {
                            field: asgn.sport || 'League Game', sport: asgn.sport || null,
                            _activity: 'League Game', _league: true, _leagueName: asgn.leagueName || '',
                            _gameLabel: asgn.gameLabel || '', matchups: asgn.matchups || [],
                            _fixed: true, continuation: false
                        };
                        leagueWriteCount++;
                    });
                });
            });
            log('[3] Wrote ' + leagueWriteCount + ' league slots');

            // ★ v6.0: Write matchup info back to bunkTimelines league blocks
            // Source 1: processed leagueBlocks (have _allMatchups after processRegularLeagues)
            // ★ v6.0: Write ALL matchups to every bunk's league block (leagues are grade-wide, not bunk-based)
            // Source 1: processed leagueBlocks
            leagueBlocks.forEach(lb => {
                const matchups = lb._allMatchups || [];
                const sport = lb._sport || lb.sport || '';
                const leagueName = lb._leagueName || lb._activity || '';
                const gameLabel = lb._gameLabel || '';
                const divBunks = getBunksForGrade(lb.divName, divisions);
                divBunks.forEach(bk => {
                    const tl = bunkTimelines[bk] || [];
                    const block = tl.find(b => (b.type || '').toLowerCase() === 'league' && b.startMin === lb.startMin);
                    if (!block) return;
                    block._matchups = matchups;
                    block._leagueSport = sport;
                    block._leagueName = leagueName;
                    block._gameLabel = gameLabel;
                    // Show all matchups summary on event (grade-wide, teams ≠ bunks)
                    if (matchups.length > 0) {
                        block.event = matchups.join(' | ');
                    } else if (sport) {
                        block.event = 'League - ' + sport;
                    }
                });
            });

            // Source 2: window.leagueAssignments
            Object.entries(window.leagueAssignments || {}).forEach(([divName, slots]) => {
                const bunks = getBunksForGrade(divName, divisions);
                Object.entries(slots).forEach(([startMinStr, asgn]) => {
                    const startMin = parseInt(startMinStr);
                    if (!asgn || !asgn.matchups || asgn.matchups.length === 0) return;
                    bunks.forEach(bk => {
                        const tl = bunkTimelines[bk] || [];
                        const block = tl.find(b =>
                            (b.type || '').toLowerCase() === 'league' && b.startMin === startMin
                        );
                        if (!block || block._matchups) return;
                        block._matchups = asgn.matchups;
                        block._leagueSport = asgn.sport || '';
                        block._leagueName = asgn.leagueName || '';
                        block._gameLabel = asgn.gameLabel || '';
                        if (asgn.matchups.length > 0) {
                            block.event = asgn.matchups.join(' | ');
                        } else if (asgn.sport) {
                            block.event = 'League - ' + asgn.sport;
                        }
                    });
                });
            });
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

                // ★ v7.0: Aggressive fallback — run multiple sweep passes to eliminate Free blocks
                let totalFallbackFilled = 0;
                for (let sweep = 0; sweep < 5 && result.free - totalFallbackFilled > 0; sweep++) {
                    const swept = window.AutoSolverEngine.fallbackSweep(solverConfig);
                    totalFallbackFilled += swept;
                    if (swept === 0) break; // no progress
                }
                if (totalFallbackFilled > 0) log('[4] Fallback sweeps filled ' + totalFallbackFilled + ' more');
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

        // ★ v10.2: STEP 4.9 — FINAL PERFECTION PASS
        // Eliminate remaining Frees by extending adjacent SPORT activities only.
        // NEVER extend swim/snack/special/league/lunch/dismissal/trip — they have strict duration bounds.
        // =====================================================================
        {
            var perfFreeCount = 0, perfFixedCount = 0;
            var perfSA = window.scheduleAssignments || {};
            var perfDT = window.divisionTimes || {};
            var perfDivisions = window.divisions || {};

            // Activities that must NOT be extended (they have strict dMin/dMax)
            var PERF_NO_EXTEND = ['swim', 'snack', 'snacks', 'lunch', 'dismissal', 'trip', 'league',
                'specialty_league', 'custom', 'rotation_event'];
            function perfCanExtend(slotEntry) {
                if (!slotEntry || slotEntry.field === 'Free') return false;
                if (slotEntry._fixed || slotEntry._pinned || slotEntry._league || slotEntry._autoSpecial || slotEntry._isRotationEvent) return false;
                var act = (slotEntry._activity || slotEntry.sport || slotEntry.field || '').toLowerCase();
                for (var i = 0; i < PERF_NO_EXTEND.length; i++) {
                    if (act.indexOf(PERF_NO_EXTEND[i]) !== -1) return false;
                }
                return true;
            }

            Object.entries(perfSA).forEach(function(entry) {
                var bunk = entry[0], slots = entry[1];
                if (!Array.isArray(slots)) return;
                var grade = '';
                for (var g in perfDivisions) {
                    if ((perfDivisions[g].bunks || []).map(String).includes(String(bunk))) { grade = g; break; }
                }
                var pbs = perfDT[grade]?._perBunkSlots?.[bunk] || perfDT[grade] || [];

                slots.forEach(function(slotEntry, idx) {
                    if (!slotEntry || slotEntry.field !== 'Free') return;
                    perfFreeCount++;
                    var slot = pbs[idx];
                    if (!slot) return;

                    // Strategy 1: Extend previous SPORT slot to absorb this Free
                    if (idx > 0 && perfCanExtend(slots[idx - 1])) {
                        slots[idx] = {
                            field: slots[idx - 1].field,
                            sport: slots[idx - 1].sport,
                            _activity: slots[idx - 1]._activity || slots[idx - 1].sport,
                            _autoMode: true, _autoSolved: true, _perfectionExtend: true,
                            continuation: true
                        };
                        perfFixedCount++;
                        return;
                    }

                    // Strategy 2: Pull next SPORT slot backward to absorb this Free
                    if (idx < slots.length - 1 && perfCanExtend(slots[idx + 1])) {
                        slots[idx] = {
                            field: slots[idx + 1].field,
                            sport: slots[idx + 1].sport,
                            _activity: slots[idx + 1]._activity || slots[idx + 1].sport,
                            _autoMode: true, _autoSolved: true, _perfectionExtend: true,
                            continuation: true
                        };
                        perfFixedCount++;
                        return;
                    }

                    // Strategy 3: Search further for ANY sport slot to extend
                    for (var si = idx - 2; si >= 0; si--) {
                        if (perfCanExtend(slots[si])) {
                            // Mark all slots between si and idx as continuation of that sport
                            for (var fi = si + 1; fi <= idx; fi++) {
                                if (!slots[fi] || slots[fi].field === 'Free' || slots[fi].continuation) {
                                    slots[fi] = {
                                        field: slots[si].field, sport: slots[si].sport,
                                        _activity: slots[si]._activity || slots[si].sport,
                                        _autoMode: true, _autoSolved: true, _perfectionExtend: true,
                                        continuation: true
                                    };
                                } else break; // don't overwrite non-Free slots
                            }
                            perfFixedCount++;
                            return;
                        }
                    }
                    for (var si2 = idx + 2; si2 < slots.length; si2++) {
                        if (perfCanExtend(slots[si2])) {
                            for (var fi2 = si2 - 1; fi2 >= idx; fi2--) {
                                if (!slots[fi2] || slots[fi2].field === 'Free' || slots[fi2].continuation) {
                                    slots[fi2] = {
                                        field: slots[si2].field, sport: slots[si2].sport,
                                        _activity: slots[si2]._activity || slots[si2].sport,
                                        _autoMode: true, _autoSolved: true, _perfectionExtend: true,
                                        continuation: true
                                    };
                                } else break;
                            }
                            perfFixedCount++;
                            return;
                        }
                    }
                });
            });

            if (perfFreeCount > 0) {
                log('\n[STEP 4.9] Perfection pass: ' + perfFreeCount + ' Frees found, ' + perfFixedCount + ' fixed by extending sport neighbors');
            }
        }

        // STEP 5 — SAVE
        // =====================================================================
        saveSwimHistory();
        saveWeekHistory(bunkTimelines);
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

        // ★ v9.3 LEVEL 4: CONFLICT DIAGNOSIS — explains WHY issues exist and suggests fixes
        {
            const _bgc = {};
            allGrades.forEach(g => getBunksForGrade(g, divisions).forEach(b => { _bgc[String(b)] = g; }));
            const diagnoses = [];

            // Check each bunk for missing required layers
            Object.entries(bunkTimelines).forEach(([bunk, tl]) => {
                const grade = _bgc[String(bunk)];
                if (!grade) return;
                const types = tl.map(b => (b.type || '').toLowerCase());
                const gradeLayers = layersByGrade[grade] || [];

                for (const ll of gradeLayers) {
                    const lt = (ll.type || '').toLowerCase();
                    if (!['swim', 'snack', 'snacks', 'special'].includes(lt)) continue;
                    const hasIt = types.includes(lt) || (lt === 'snacks' && types.includes('snack'));
                    if (hasIt) continue;

                    // Diagnose WHY it's missing
                    const winStart = ll.startMin, winEnd = ll.endMin;
                    if (winStart == null || winEnd == null) continue;
                    const lc = resolveConstraints(ll, lt);
                    const wallsInWindow = tl.filter(b => b.startMin < winEnd && b.endMin > winStart);
                    const wallNames = wallsInWindow.map(b => b.event || b.type).join(', ');
                    const totalWallTime = wallsInWindow.reduce((s, b) => s + Math.min(b.endMin, winEnd) - Math.max(b.startMin, winStart), 0);
                    const windowSize = winEnd - winStart;
                    const freeInWindow = windowSize - totalWallTime;

                    var diagnosis = 'Bunk ' + bunk + ' missing ' + lt.toUpperCase();
                    if (freeInWindow < lc.dMin) {
                        diagnosis += ': window ' + winStart + '-' + winEnd + ' (' + windowSize + 'min) has only ' + freeInWindow + 'min free (need ' + lc.dMin + 'min). Blocked by: ' + wallNames;
                        diagnosis += '. FIX: widen ' + lt + ' window or move conflicting activities.';
                    } else {
                        diagnosis += ': window has ' + freeInWindow + 'min free but placement failed. May be a resource conflict (pool/capacity).';
                    }
                    diagnoses.push(diagnosis);
                }

                // Check for dead gaps
                const sorted = [...tl].sort((a, b) => a.startMin - b.startMin);
                for (let i = 0; i < sorted.length - 1; i++) {
                    const gapSize = sorted[i + 1].startMin - sorted[i].endMin;
                    if (gapSize > 0 && gapSize < 25) {
                        diagnoses.push('Bunk ' + bunk + ' dead gap ' + gapSize + 'min between ' + (sorted[i].event || sorted[i].type) + ' and ' + (sorted[i+1].event || sorted[i+1].type) + '. FIX: adjust adjacent activity durations or layer windows.');
                    }
                }

                // Check for back-to-back same sport
                for (let i = 0; i < sorted.length - 1; i++) {
                    if (sorted[i]._assignedSport && sorted[i]._assignedSport === sorted[i+1]._assignedSport) {
                        diagnoses.push('Bunk ' + bunk + ' has ' + sorted[i]._assignedSport + ' back-to-back. FIX: add more sport variety to the rotation.');
                    }
                }
            });

            if (diagnoses.length > 0) {
                log('\n🧠 INTELLIGENT DIAGNOSIS (' + diagnoses.length + ' issues):');
                diagnoses.forEach(function(d, i) { log('  ' + (i + 1) + '. ' + d); });

                // ★ v9.4 SELF-HEALING: Automatically fix diagnosed issues
                log('\n🔧 SELF-HEALING: Attempting to fix ' + diagnoses.length + ' issues...');
                var healed = 0;

                Object.entries(bunkTimelines).forEach(function(entry) {
                    var bunk = entry[0], tl = entry[1];
                    var grade = _bgc[String(bunk)];
                    if (!grade) return;
                    var gradeLayers = layersByGrade[grade] || [];
                    var sorted = tl.sort(function(a, b) { return a.startMin - b.startMin; });

                    for (var li = 0; li < gradeLayers.length; li++) {
                        var ll = gradeLayers[li];
                        var lt = (ll.type || '').toLowerCase();
                        if (!['swim', 'snack', 'snacks', 'special'].includes(lt)) continue;

                        // ★ v10.4: For specials, resolve actual name from draft
                        var phSpecialName = null, phSpecialLoc = null;
                        if (lt === 'special') {
                            var phDraft = window._autoBuildDraftResults ? window._autoBuildDraftResults[bunk] : null;
                            if (phDraft && phDraft.specials && phDraft.specials.length > 0) {
                                phSpecialName = phDraft.specials[0].name;
                                phSpecialLoc = phDraft.specials[0].location || phDraft.specials[0].claimedField;
                            }
                            if (!phSpecialName) continue; // no real special to place
                        }

                        var hasIt = sorted.some(function(b) {
                            var bt = (b.type || '').toLowerCase();
                            if (lt === 'special') return bt === 'special';
                            return bt === lt || (lt === 'snacks' && bt === 'snack');
                        });
                        if (hasIt) continue;

                        // This bunk is missing a required layer. Find a sport block to replace.
                        var lc = resolveConstraints(ll, lt);
                        var needDMin = lc.dMin || 15;
                        var winStart = ll.startMin || 0, winEnd = ll.endMin || 1440;

                        // Find the best sport block to sacrifice (within window, closest to dMin)
                        var bestIdx = -1, bestFit = Infinity;
                        for (var si2 = 0; si2 < sorted.length; si2++) {
                            var blk = sorted[si2];
                            var bt = (blk.type || '').toLowerCase();
                            if (!['sport', 'slot'].includes(bt)) continue;
                            if (blk._fixed) continue;
                            if (blk.startMin < winStart || blk.endMin > winEnd) continue;
                            var blkDur = blk.endMin - blk.startMin;
                            if (blkDur < needDMin) continue;
                            // Prefer blocks closest to the needed duration (least waste)
                            var fit = Math.abs(blkDur - needDMin);
                            if (fit < bestFit) { bestFit = fit; bestIdx = si2; }
                        }

                        if (bestIdx >= 0) {
                            var victim = sorted[bestIdx];
                            var newStart = victim.startMin;
                            var newEnd = Math.min(newStart + (lc.dMax || needDMin), victim.endMin);
                            var remainderStart = newEnd;
                            var remainderEnd = victim.endMin;

                            // Replace the sport block with the required layer
                            var phEventName = lt === 'special' ? phSpecialName : (ll.event || lt);
                            sorted[bestIdx] = {
                                startMin: newStart, endMin: newEnd,
                                type: lt === 'snacks' ? 'snacks' : lt,
                                event: phEventName,
                                layer: ll,
                                _classification: 'windowed', _committed: true, _autoGenerated: true,
                                _activityLocked: true, _fixed: false, _source: 'self-heal',
                                _assignedSpecial: lt === 'special' ? phSpecialName : null,
                                _specialLocation: lt === 'special' ? phSpecialLoc : null,
                                _isSpecialLocation: lt === 'special',
                                _bunkOverride: true
                            };

                            // If there's remaining space, create a sport slot for it
                            if (remainderEnd - remainderStart >= 25) {
                                sorted.push({
                                    startMin: remainderStart, endMin: remainderEnd,
                                    type: 'slot', event: 'General Activity Slot',
                                    layer: null, _classification: 'gap', _committed: true,
                                    _autoGenerated: true, _fixed: false, _source: 'self-heal',
                                    _sportFallbacks: null, _bunkOverride: true
                                });
                            } else if (remainderEnd - remainderStart > 0) {
                                // Extend the new block to fill the remainder (avoid dead gap)
                                sorted[bestIdx].endMin = remainderEnd;
                            }

                            sorted.sort(function(a, b) { return a.startMin - b.startMin; });
                            healed++;
                            log('  🔧 Bunk ' + bunk + ': replaced ' + victim.event + ' (' + victim.startMin + '-' + victim.endMin + ') with ' + lt.toUpperCase());
                        }
                    }

                    // Fix dead gaps: extend adjacent sport blocks
                    sorted.sort(function(a, b) { return a.startMin - b.startMin; });
                    for (var di = 0; di < sorted.length - 1; di++) {
                        var gapSize = sorted[di + 1].startMin - sorted[di].endMin;
                        if (gapSize > 0 && gapSize < 25) {
                            // Extend prev if it's a sport/slot
                            var prevT = (sorted[di].type || '').toLowerCase();
                            var nextT = (sorted[di + 1].type || '').toLowerCase();
                            if (['sport', 'slot'].includes(prevT) && !sorted[di]._fixed) {
                                sorted[di].endMin += gapSize; healed++;
                            } else if (['sport', 'slot'].includes(nextT) && !sorted[di + 1]._fixed) {
                                sorted[di + 1].startMin -= gapSize; healed++;
                            }
                        }
                    }

                    bunkTimelines[bunk] = sorted;
                });

                if (healed > 0) {
                    log('  🔧 HEALED ' + healed + ' issues. Re-saving...');
                    // Re-save after healing
                    try {
                        if (window.saveBunkTimelinesAsAssignments) window.saveBunkTimelinesAsAssignments(bunkTimelines);
                        else if (window.saveScheduleFromTimelines) window.saveScheduleFromTimelines(bunkTimelines);
                    } catch(e) { /* save handled elsewhere */ }
                }
            } else {
                log('\n🧠 INTELLIGENT DIAGNOSIS: No issues detected — schedule is clean.');
            }
        }

        log('═══════════════════════════════════════════════════════════');

        // ★ v7.0: Mark local generation time — prevents cloud sync from overwriting fresh results
        window._localGenerationTimestamp = Date.now();

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
