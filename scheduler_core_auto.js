
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
                const sharing = props.sharableWith || {};
                const shareType = sharing.type || 'not_sharable';  // ★ v4.1: Default to NOT sharable
                const capacity = parseInt(sharing.capacity) || (shareType === 'not_sharable' ? 1 : (shareType === 'all' ? 999 : 2));

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
                // ★ v5.1: Penalize positions that create un-fillable dead zones
                // Check gap between this league and adjacent walls
                const leagueDur = expandLeagueDur(ts, bunks);
                const leagueEnd = ts + leagueDur;
                const _minFill = getMinFillable(grade);
                bunks.forEach(bk => {
                    const tl = bunkTimelines[bk] || [];
                    // Check gap BEFORE this league
                    let prevEnd = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                    tl.forEach(b => { if (b.endMin <= ts && b.endMin > prevEnd) prevEnd = b.endMin; });
                    const gapBefore = ts - prevEnd;
                    if (gapBefore > 0 && gapBefore < _minFill) score += 5000;
                    // Check gap AFTER this league
                    let nextStart = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                    tl.forEach(b => { if (b.startMin >= leagueEnd && b.startMin < nextStart) nextStart = b.startMin; });
                    const gapAfter = nextStart - leagueEnd;
                    if (gapAfter > 0 && gapAfter < _minFill) score += 5000;
                });
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
                    // Shuffle bunks for variety across iterations
                    const shuffled = _iterSeed > 0 ? seedShuffle([...bunks], _iterSeed) : [...bunks];
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
        } // end dead code guard


        // =====================================================================
        // PHASE 3: TIME-SWEEP SPORT FILLER (v8.0)
        // Replaces the old greedyPackBunk. Processes ALL 38 bunks simultaneously.
        // Walls never move. Sports + fields assigned together. Sharing-aware.
        // =====================================================================

        function timeSweepFillAll(shoppingLists, draftResults, allGrades) {
            var allTemplates = {};
            log('[Phase3] ★ timeSweepFillAll v8.0: starting for ' + allGrades.length + ' grades');

            // ── Helper: build a template block with all required fields ──
            function makeBlock(opts) {
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
                var bunks = getBunksForGrade(grade, divisions);
                var gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                var gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;

                for (var bi = 0; bi < bunks.length; bi++) {
                    var bunk = bunks[bi];
                    var shoppingList = shoppingLists[bunk];
                    var draftResult = draftResults[bunk];
                    if (!shoppingList || !draftResult) continue;

                    var sportC = shoppingList.sports?.constraints || resolveConstraints(null, 'sport');
                    var fillMinDur = Math.max(sportC.dMin || 25, TYPE_FLOORS.sport || 25);
                    var sportCeiling = Math.min(sportC.dMax || 60, TYPE_CEILINGS.sport || 60, 60);
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
                        var c = (isLeague && b.layer) ? resolveConstraints(b.layer, bType) : null;
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

                    // Rotation events
                    if (window.RotationEvents && typeof window.RotationEvents.getNeedsForBunk === 'function') {
                        try {
                            var reNeeds = window.RotationEvents.getNeedsForBunk(String(bunk), currentDate);
                            if (reNeeds && reNeeds.length) {
                                for (var ri = 0; ri < reNeeds.length; ri++) {
                                    var rn = reNeeds[ri];
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
                            needs.push({ type: 'special', event: special.name, layer: special.layer,
                                dMin: sDMin, dMax: sDMax, windowStart: gradeStart, windowEnd: gradeEnd,
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

                    // Sort needs: tightest window first (ratio of window to duration)
                    // This ensures snack (20min window) is placed before swim (90min window)
                    // before specials (full-day window). Tight windows MUST go first or they
                    // get blocked by earlier placements.
                    needs.sort(function(a, b) {
                        var aWindow = (a.windowEnd - a.windowStart) / Math.max(1, a.dMin);
                        var bWindow = (b.windowEnd - b.windowStart) / Math.max(1, b.dMin);
                        return aWindow - bWindow; // smallest ratio = tightest fit = first
                    });

                    // ── 2: Place each need into the best-fitting gap ──
                    for (var ni = 0; ni < needs.length; ni++) {
                        var need = needs[ni];
                        var gaps = findGaps(template, gradeStart, gradeEnd);
                        var bestStart = -1, bestDur = 0, bestScore = Infinity;

                        for (var gj = 0; gj < gaps.length; gj++) {
                            var gap = gaps[gj];
                            var es = Math.max(gap.start, need.windowStart || gradeStart);
                            var ee = Math.min(gap.end, need.windowEnd || gradeEnd);
                            if (ee - es < need.dMin) continue;
                            var dur = Math.min(need.dMax, ee - es);

                            // Resource checks: scan 5-min increments for valid placement
                            if (need.type === 'swim') {
                                var poolFound = false;
                                for (var pt = es; pt + need.dMin <= ee; pt += 5) {
                                    var pEnd = Math.min(pt + dur, ee);
                                    if (pEnd - pt < need.dMin) continue;
                                    if (canUsePoolAtTime(grade, pt, pEnd)) { es = pt; dur = pEnd - pt; poolFound = true; break; }
                                }
                                if (!poolFound) continue;
                            }
                            if (need.type === 'special' && need._assignedSpecial) {
                                var specFound = false;
                                for (var st = es; st + need.dMin <= ee; st += 5) {
                                    var sEnd = Math.min(st + dur, ee);
                                    if (sEnd - st < need.dMin) continue;
                                    if (canUseSpecialAtTime(need._assignedSpecial, grade, st, sEnd)) { es = st; dur = sEnd - st; specFound = true; break; }
                                }
                                if (!specFound) continue;
                            }

                            var score = (ee - es) - dur; // tightest fit = lowest score
                            if (score < bestScore) { bestScore = score; bestStart = es; bestDur = dur; }
                        }

                        if (bestStart >= 0) {
                            var placeEnd = bestStart + bestDur;
                            // Register resources
                            if (need.type === 'swim') { registerCrossGrade(grade, 'swim', bestStart, placeEnd, need.event); registerPoolUsage(grade, bestStart, placeEnd); }
                            if (need.type === 'special' && need._assignedSpecial) {
                                registerCrossGrade(grade, 'special', bestStart, placeEnd, need.event);
                                registerSpecialUsage(need._assignedSpecial, grade, bestStart, placeEnd);
                                placedSpecialNames.add(need._assignedSpecial);
                            }
                            if (['snacks', 'snack'].includes((need.type || '').toLowerCase())) { registerCrossGrade(grade, need.type, bestStart, placeEnd, need.event); }
                            if (need.type === 'custom') { registerCrossGrade(grade, 'custom', bestStart, placeEnd, need._customActivity || need.event); }

                            template.push(makeBlock({
                                startMin: bestStart, endMin: placeEnd, type: need.type, event: need.event,
                                layer: need.layer, dMin: need.dMin, dMax: need.dMax,
                                _source: 'need', _activityLocked: need._activityLocked || false,
                                _assignedSpecial: need._assignedSpecial || null,
                                _specialLocation: need._specialLocation || null, _specialDuration: need._specialDuration || null,
                                _customActivity: need._customActivity || null, _customField: need._customField || null,
                                _customBunks: need._customBunks || null,
                                _rotationEventId: need._rotationEventId || null, _rotationEventLocation: need._rotationEventLocation || null,
                                _rotationEventColor: need._rotationEventColor || null, _final: true
                            }));
                        } else {
                            log('[Phase3] ERROR: could not place ' + need.type + '/' + need.event + ' for bunk ' + bunk + ' — no gap fits within window ' + need.windowStart + '-' + need.windowEnd);
                        }
                    }

                    bunkMeta[bunk] = { grade: grade, template: template, sportC: sportC, fillMinDur: fillMinDur,
                        sportCeiling: sportCeiling, priorityList: priorityList, gradeStart: gradeStart, gradeEnd: gradeEnd,
                        draftSports: draftResult.sports || [], sportLayer: shoppingList.sports?.layer || null };
                }
            }

            // ══════════════════════════════════════════════════════════
            // STEP 3: Compute sport gaps for all bunks
            // ══════════════════════════════════════════════════════════
            var sportGaps = [];
            var allBunkIds = Object.keys(bunkMeta);
            for (var k = 0; k < allBunkIds.length; k++) {
                var bId = allBunkIds[k];
                var meta = bunkMeta[bId];
                var gaps = findGaps(meta.template, meta.gradeStart, meta.gradeEnd);
                for (var gk = 0; gk < gaps.length; gk++) {
                    sportGaps.push({ bunk: bId, grade: meta.grade, start: gaps[gk].start, end: gaps[gk].end, cursor: gaps[gk].start, filled: false });
                }
            }
            log('[Phase3] ' + sportGaps.length + ' sport gaps across ' + allBunkIds.length + ' bunks');

            // ══════════════════════════════════════════════════════════
            // STEP 4: Time-sweep sport assignment (THE CORE)
            // ══════════════════════════════════════════════════════════

            // Track used sports per bunk
            var usedSports = {};
            for (var ui = 0; ui < allBunkIds.length; ui++) {
                usedSports[allBunkIds[ui]] = new Set();
            }

            // Find sport + field for a bunk at a given time window
            function findSportField(bunk, grade, startMin, endMin, meta) {
                var pList = meta.priorityList;
                var used = usedSports[bunk];
                // Pass 1: drafted sports not yet used
                for (var d = 0; d < (meta.draftSports || []).length; d++) {
                    var ds = meta.draftSports[d];
                    if (used.has(ds.name)) continue;
                    var sportInfo = pList.find(function(s) { return s.name === ds.name; });
                    if (!sportInfo) continue;
                    for (var f = 0; f < (sportInfo.fields || []).length; f++) {
                        if (isFieldAvailable(sportInfo.fields[f], startMin, endMin, bunk, grade, ds.name))
                            return { name: ds.name, field: sportInfo.fields[f] };
                    }
                }
                // Pass 2: unused priority list sports
                for (var p = 0; p < pList.length; p++) {
                    if (used.has(pList[p].name)) continue;
                    for (var f2 = 0; f2 < (pList[p].fields || []).length; f2++) {
                        if (isFieldAvailable(pList[p].fields[f2], startMin, endMin, bunk, grade, pList[p].name))
                            return { name: pList[p].name, field: pList[p].fields[f2] };
                    }
                }
                // Pass 3: allow sport reuse
                for (var p2 = 0; p2 < pList.length; p2++) {
                    for (var f3 = 0; f3 < (pList[p2].fields || []).length; f3++) {
                        if (isFieldAvailable(pList[p2].fields[f3], startMin, endMin, bunk, grade, pList[p2].name))
                            return { name: pList[p2].name, field: pList[p2].fields[f3] };
                    }
                }
                return null;
            }

            // Collect time boundaries and sweep
            var boundarySet = {};
            for (var sg = 0; sg < sportGaps.length; sg++) {
                boundarySet[sportGaps[sg].start] = true;
                boundarySet[sportGaps[sg].end] = true;
            }
            var boundaries = Object.keys(boundarySet).map(Number).sort(function(a, b) { return a - b; });

            for (var ti = 0; ti < boundaries.length; ti++) {
                var T = boundaries[ti];

                // Find gaps whose cursor is at or before T and end is past T
                var activeGaps = [];
                for (var ag = 0; ag < sportGaps.length; ag++) {
                    var sgap = sportGaps[ag];
                    if (sgap.filled) continue;
                    if (sgap.cursor <= T && sgap.end > T) activeGaps.push(sgap);
                }
                if (activeGaps.length === 0) continue;

                // Group by grade for coordinated field sharing
                var gradeGroups = {};
                for (var gg = 0; gg < activeGaps.length; gg++) {
                    var gr = activeGaps[gg].grade;
                    if (!gradeGroups[gr]) gradeGroups[gr] = [];
                    gradeGroups[gr].push(activeGaps[gg]);
                }

                var gradeKeys = Object.keys(gradeGroups);
                for (var ggi = 0; ggi < gradeKeys.length; ggi++) {
                    var group = gradeGroups[gradeKeys[ggi]];
                    // Sort by urgency: smallest remaining gap = highest priority
                    group.sort(function(a, b) { return (a.end - a.cursor) - (b.end - b.cursor); });

                    for (var bi2 = 0; bi2 < group.length; bi2++) {
                        var gapItem = group[bi2];
                        var m = bunkMeta[gapItem.bunk];
                        if (!m) continue;

                        var effectiveStart = Math.max(gapItem.cursor, T);
                        var remaining = gapItem.end - effectiveStart;
                        if (remaining <= 0) continue;

                        // Calculate sport duration: fill up to ceiling, split if needed
                        var dur = Math.min(remaining, m.sportCeiling);
                        if (dur < m.fillMinDur) continue; // too small, handle in Step 5

                        // If remaining > ceiling, only take one ceiling-worth
                        var endMin = effectiveStart + dur;

                        var result = findSportField(gapItem.bunk, gapItem.grade, effectiveStart, endMin, m);
                        if (result) {
                            claimField(result.field, effectiveStart, endMin, gapItem.bunk, gapItem.grade, result.name);
                            usedSports[gapItem.bunk].add(result.name);
                            m.template.push(makeBlock({
                                startMin: effectiveStart, endMin: endMin,
                                type: 'sport', event: result.name,
                                layer: m.sportLayer, field: result.field,
                                dMin: m.sportC.dMin, dMax: m.sportCeiling,
                                _source: 'sport-fill', _assignedSport: result.name,
                                _sportFallbacks: m.priorityList.map(function(s) { return s.name; }), _final: true
                            }));
                        } else {
                            // No field — create slot for downstream solver
                            m.template.push(makeBlock({
                                startMin: effectiveStart, endMin: endMin,
                                type: 'slot', event: 'General Activity Slot',
                                layer: m.sportLayer, field: null,
                                dMin: m.sportC.dMin, dMax: m.sportCeiling,
                                _source: 'sport-fill',
                                _sportFallbacks: m.priorityList.map(function(s) { return s.name; }), _final: true
                            }));
                        }
                        gapItem.cursor = endMin;
                        if (gapItem.cursor >= gapItem.end) gapItem.filled = true;
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
                        // Big enough for a sport
                        var numBlocks = Math.max(1, Math.ceil(gapSize / fMeta.sportCeiling));
                        var blockDur = Math.floor(gapSize / numBlocks);
                        var cursor = rgap.start;
                        for (var nb = 0; nb < numBlocks; nb++) {
                            var bDur = (nb === numBlocks - 1) ? (rgap.end - cursor) : blockDur;
                            if (bDur < fMeta.fillMinDur && nb > 0) {
                                // Too small — extend previous block
                                var prev = tmpl[tmpl.length - 1];
                                if (prev && !prev._fixed) prev.endMin = rgap.end;
                                break;
                            }
                            var rResult = findSportField(fBunk, fMeta.grade, cursor, cursor + bDur, fMeta);
                            if (rResult) {
                                claimField(rResult.field, cursor, cursor + bDur, fBunk, fMeta.grade, rResult.name);
                                usedSports[fBunk].add(rResult.name);
                            }
                            tmpl.push(makeBlock({
                                startMin: cursor, endMin: cursor + bDur,
                                type: rResult ? 'sport' : 'slot', event: rResult ? rResult.name : 'General Activity Slot',
                                layer: fMeta.sportLayer, field: rResult ? rResult.field : null,
                                dMin: fMeta.sportC.dMin, dMax: fMeta.sportCeiling,
                                _source: 'filler', _assignedSport: rResult ? rResult.name : null,
                                _sportFallbacks: fMeta.priorityList.map(function(s) { return s.name; }), _final: true
                            }));
                            cursor += bDur;
                        }
                    } else {
                        // Too small for a sport — absorb into adjacent non-fixed block
                        tmpl.sort(function(a, b) { return a.startMin - b.startMin; });
                        var absorbed = false;
                        for (var m2 = 0; m2 < tmpl.length; m2++) {
                            // Find block ending at gap start
                            if (tmpl[m2].endMin === rgap.start && !tmpl[m2]._fixed) {
                                var m2Dur = tmpl[m2].endMin - tmpl[m2].startMin;
                                var m2Max = ['sport', 'slot'].includes((tmpl[m2].type || '').toLowerCase()) ? fMeta.sportCeiling : (tmpl[m2].dMax || Infinity);
                                if (m2Dur + gapSize <= m2Max) { tmpl[m2].endMin += gapSize; absorbed = true; break; }
                            }
                            // Find block starting at gap end
                            if (tmpl[m2].startMin === rgap.end && !tmpl[m2]._fixed) {
                                var m2Dur2 = tmpl[m2].endMin - tmpl[m2].startMin;
                                var m2Max2 = ['sport', 'slot'].includes((tmpl[m2].type || '').toLowerCase()) ? fMeta.sportCeiling : (tmpl[m2].dMax || Infinity);
                                if (m2Dur2 + gapSize <= m2Max2) { tmpl[m2].startMin -= gapSize; absorbed = true; break; }
                            }
                        }
                        if (!absorbed) {
                            // Can't absorb — create slot (scorer will handle the duration violation)
                            tmpl.push(makeBlock({
                                startMin: rgap.start, endMin: rgap.end,
                                type: 'slot', event: 'General Activity Slot',
                                layer: fMeta.sportLayer, field: null,
                                dMin: gapSize, dMax: fMeta.sportCeiling,
                                _source: 'filler', _final: true
                            }));
                        }
                    }
                }
            }

            // ══════════════════════════════════════════════════════════
            // STEP 6: Validate and return
            // ══════════════════════════════════════════════════════════
            var totalWarnings = 0;
            for (var vi = 0; vi < allBunkIds.length; vi++) {
                var vBunk = allBunkIds[vi];
                var vMeta = bunkMeta[vBunk];
                var vTmpl = vMeta.template;
                vTmpl.sort(function(a, b) { return a.startMin - b.startMin; });

                var vGaps = findGaps(vTmpl, vMeta.gradeStart, vMeta.gradeEnd);
                if (vGaps.length > 0) {
                    log('[Phase3] WARN: bunk ' + vBunk + ' has ' + vGaps.length + ' unfilled gaps');
                    totalWarnings++;
                }

                allTemplates[vBunk] = vTmpl;
            }

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
                bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin);
            });
        }


        // =====================================================================
        // SCORING ENGINE
        // =====================================================================

        const MAX_ITERATIONS = 40;
        const STALE_STOP = 12;
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
                if (sorted.length > 0 && sorted[0].startMin > dayStart) score += scoreGap(sorted[0].startMin - dayStart);
                for (let i = 0; i < sorted.length - 1; i++) { const gap = sorted[i + 1].startMin - sorted[i].endMin; score += scoreGap(gap); }
                if (sorted.length > 0 && sorted[sorted.length - 1].endMin < dayEnd) score += scoreGap(dayEnd - sorted[sorted.length - 1].endMin);

                // Duration violations — ★ v6.0: Much heavier penalty than Free blocks.
                // A duration violation is NEVER acceptable. Prefer a Free over a short sport.
                timeline.forEach(block => {
                    if (block._fromGapDetection && !block.layer) return;
                    const { dMin } = resolveConstraints(block.layer, (block.type || 'slot').toLowerCase(), block);
                    const dur = block.endMin - block.startMin;
                    if (dur < dMin) score += (dMin - dur) * 10000 + 100000;
                });

                // Out of bounds
                if (gradeKey) timeline.forEach(b => { if (b.endMin <= dayStart || b.startMin >= dayEnd) score += 10000; });
            });

            iterWarnings.forEach(w => { if (w.type === 'placement_failure') score += 500; if (w.type === 'overlap') score += 1000; });

            // ── Per-grade field saturation scoring ──
            // For each time slice, count how many bunks per grade need a field
            // vs how many field slots that grade can actually use.
            // Heavily penalize any slice where demand > supply (causes Frees).
            for (let t = campStart; t < campEnd; t += 5) {
                const se = t + 5;

                // Count field consumers per grade at this time
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

                // Count available field capacity per grade at this time
                // using the field ledger (already initialized for this iteration)
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

                        // Check cross-grade blocking
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

                    // Penalize saturation: the more demand exceeds supply, the worse
                    const deficit = demand - supply;
                    if (deficit > 0) {
                        // Each over-capacity bunk is very likely to become a Free
                        score += deficit * 5000;
                    } else if (supply > 0 && demand > 0) {
                        // Mild penalty for tight margins (supply barely >= demand)
                        const ratio = demand / supply;
                        if (ratio > 0.8) score += Math.round((ratio - 0.8) * 500);
                    }
                });

                // Also penalize total cross-camp contention (original check, relaxed threshold)
                let totalCnt = 0;
                Object.values(gradeConsumers).forEach(c => { totalCnt += c; });
                if (totalCnt > 20) score += (totalCnt - 20) * 100;
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
                allGrades.forEach(grade => getBunksForGrade(grade, divisions).forEach(bunk => bunkTimelines[bunk].sort((a, b) => a.startMin - b.startMin)));
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
            {
                let preplacedCount = 0;
                let preplacedByGrade = {};
                allGrades.forEach(grade => {
                    preplacedByGrade[grade] = 0;
                    getBunksForGrade(grade, divisions).forEach(bunk => {
                        const draft = draftResults[bunk];
                        if (!draft || !draft.specials || !draft.specials.length) return;
                        // Only take 1 special per bunk (the first one from the fair draft)
                        const special = draft.specials[0];
                        if (!special || !special.claimedTime) return;
                        const sStart = special.claimedTime.startMin;
                        const sEnd = special.claimedTime.endMin;
                        const fieldName = special.claimedField || special.location;

                        // ★ v8.1: Simulate whether ALL required layers still fit after placing this special.
                        // Build the full wall list (Phase 0 + this special), then check if each
                        // required layer (swim, snack, custom) can find a gap within its window.
                        const gradeStart = parseTimeToMinutes(divisions[grade]?.startTime) || 540;
                        const gradeEnd = parseTimeToMinutes(divisions[grade]?.endTime) || 960;
                        const simWalls = (bunkTimelines[bunk] || []).map(w => ({ s: w.startMin, e: w.endMin }));
                        simWalls.push({ s: sStart, e: sEnd }); // add the proposed special
                        simWalls.sort((a, b) => a.s - b.s);
                        // Compute gaps after adding the special
                        const simGaps = [];
                        let simCur = gradeStart;
                        for (const w of simWalls) {
                            if (w.s > simCur) simGaps.push({ s: simCur, e: w.s });
                            simCur = Math.max(simCur, w.e);
                        }
                        if (simCur < gradeEnd) simGaps.push({ s: simCur, e: gradeEnd });

                        const gradeLayers = layersByGrade[grade] || [];
                        let blocksRequired = false;
                        for (const ll of gradeLayers) {
                            const lt = (ll.type || '').toLowerCase();
                            if (!['swim', 'snack', 'snacks', 'custom'].includes(lt)) continue;
                            if (lt === 'custom' && ll._classification === 'pinned') continue; // already a wall
                            if (ll.startMin == null || ll.endMin == null) continue;
                            const lc = resolveConstraints(ll, lt);
                            const needDMin = lc.dMin || 15;
                            // Check if ANY gap overlaps the layer window with enough room
                            let canFit = false;
                            for (const gap of simGaps) {
                                const overlapStart = Math.max(gap.s, ll.startMin);
                                const overlapEnd = Math.min(gap.e, ll.endMin);
                                if (overlapEnd - overlapStart >= needDMin) { canFit = true; break; }
                            }
                            if (!canFit) {
                                blocksRequired = true;
                                log('[Phase2.5] Skipping special "' + special.name + '" for bunk ' + bunk + ' — would block ' + lt + ' (no gap >= ' + needDMin + 'min in window ' + ll.startMin + '-' + ll.endMin + ')');
                                break;
                            }
                        }
                        if (blocksRequired) return;

                        // Add as immovable wall in bunkTimelines
                        bunkTimelines[bunk].push({
                            startMin: sStart, endMin: sEnd,
                            type: 'special', event: special.name,
                            layer: special._layer || null,
                            _classification: 'pinned', _committed: true, _fixed: true,
                            _gradeWide: false, _activityLocked: true, _noBacktrack: false,
                            _assignedSpecial: special.name,
                            _specialLocation: fieldName,
                            _specialDuration: special.duration || (sEnd - sStart),
                            _isSpecialLocation: true, _source: 'pre-placed'
                        });

                        // Register in resource tracker
                        registerSpecialUsage(special.name, grade, sStart, sEnd);
                        registerCrossGrade(grade, 'special', sStart, sEnd, special.name);

                        // Claim field
                        if (fieldName && fieldLedger[fieldName]) {
                            fieldLedger[fieldName].claims.push({
                                bunk: bunk, grade: grade, activity: special.name,
                                startMin: sStart, endMin: sEnd
                            });
                        }

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
               log('[ITER ' + totalIters + '] score=' + iterScore + (improved ? ' ★ BEST' : '') + ' | best=' + bestScore + ' | stale=' + staleCount + ' | estFree=' + iterFreeEstimate);            }

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
