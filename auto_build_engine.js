// =================================================================
// auto_build_engine.js — Campistry Auto Build Engine v4.0.0
// =================================================================
// Converts user-defined LAYERS + special activity config into:
//   1. A skeleton array (per-bunk time structure)
//   2. Bunk overrides (pre-assigned specific activities)
//
// v4.0 REWRITE — Per-bunk intelligent scheduling
//
// KEY CHANGES FROM v3.x:
// - Scarce activities discovered from Special Activities config,
//   NOT from layers. User sets "Horses: Mon/Thu" in config, engine
//   finds it automatically.
// - Leagues are the ONLY division-wide placement. Everything else
//   is built per-bunk.
// - Phase 4 (filler) thinks per-bunk: checks rotation history,
//   picks activity type + duration based on what that bunk needs,
//   sizes skeleton slots to real activity durations.
// - Soft feasibility check after each high-priority placement
//   verifies the rest of the day still fits.
//
// PHASE ORDER:
//   1. Discover & place SCARCE activities (per-bunk, with soft verify)
//   2. Place LIMITED/PINNED tiles (per-bunk, with soft verify)
//   3. Place LEAGUES (division-wide, with soft verify)
//   4. Intelligent filler (per-bunk, rotation-aware)
//   5. Validation
//
// OUTPUT feeds existing pipeline unchanged:
//   skeleton → DivisionTimesSystem.buildFromSkeleton()
//            → scheduler_core_main.js (bunk overrides at Step 2)
//            → total_solver_engine.js (fills remaining slots)
// =================================================================

(function() {
'use strict';

const VERSION = '4.0.0';
const DEBUG = true;

function log(...args) { if (DEBUG) console.log('[AutoBuild]', ...args); }
function warn(...args) { console.warn('[AutoBuild]', ...args); }

// =================================================================
// TIME UTILITIES
// =================================================================

function parseTime(str) {
    if (typeof str === 'number') return str;
    if (!str || typeof str !== 'string') return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith('am') || s.endsWith('pm')) {
        mer = s.slice(-2);
        s = s.slice(0, -2).trim();
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    if (mer === 'am' && hh === 12) hh = 0;
    else if (mer === 'pm' && hh !== 12) hh += 12;
    return hh * 60 + mm;
}

function fmtTime(min) {
    if (min == null) return '?';
    let h = Math.floor(min / 60), m = min % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')}${ap}`;
}

function snapTo5(min) {
    return Math.round(min / 5) * 5;
}

// =================================================================
// DATA ACCESS HELPERS
// =================================================================

function getGlobalSettings() {
    return window.loadGlobalSettings?.() || {};
}

function getSpecialActivities() {
    const g = getGlobalSettings();
    return g.app1?.specialActivities || [];
}

function getFields() {
    const g = getGlobalSettings();
    return g.app1?.fields || g.fields || [];
}

function getDivisions() {
    return window.divisions || getGlobalSettings().app1?.divisions || {};
}

function getBunksForDivision(divName) {
    const divisions = getDivisions();
    return divisions[divName]?.bunks || [];
}

function getDivisionForGrade(gradeName) {
    const divisions = getDivisions();
    if (divisions[gradeName]) return gradeName;
    for (const [divName, divData] of Object.entries(divisions)) {
        if (divData.grades && divData.grades.includes(gradeName)) return divName;
        if (divData.grade === gradeName) return divName;
    }
    return gradeName;
}

function getDivisionTimes(divName) {
    const divisions = getDivisions();
    const div = divisions[divName];
    if (!div) return { start: 540, end: 960 };
    const startMin = div.startTime ? parseTime(div.startTime) : 540;
    const endMin = div.endTime ? parseTime(div.endTime) : 960;
    return { start: startMin || 540, end: endMin || 960 };
}

function getSpecialConfig(name) {
    const specials = getSpecialActivities();
    return specials.find(s =>
        s.name?.toLowerCase().trim() === name?.toLowerCase().trim()
    ) || null;
}

function getSpecialDuration(name) {
    const config = getSpecialConfig(name);
    return config?.defaultDuration || config?.duration || null;
}

function isSpecialAvailableOnDay(specialConfig, dayName) {
    if (!specialConfig) return true;
    if (Array.isArray(specialConfig.availableDays) && specialConfig.availableDays.length > 0) {
        return specialConfig.availableDays.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
    }
    if (!specialConfig.dayAvailability) return true;
    const avail = specialConfig.dayAvailability;
    if (typeof avail === 'object' && !Array.isArray(avail)) {
        return avail[dayName] !== false;
    }
    if (Array.isArray(avail)) {
        return avail.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
    }
    return true;
}

function getSpecialTimeWindow(specialConfig) {
    if (!specialConfig) return null;
    const start = specialConfig.availableFrom || specialConfig.windowStart || specialConfig.startTime;
    const end = specialConfig.availableTo || specialConfig.windowEnd || specialConfig.endTime;
    if (start && end) {
        return {
            startMin: typeof start === 'number' ? start : parseTime(start),
            endMin: typeof end === 'number' ? end : parseTime(end)
        };
    }
    if (Array.isArray(specialConfig.timeRules) && specialConfig.timeRules.length > 0) {
        const availableRules = specialConfig.timeRules.filter(r =>
            r.type === 'Available' || !r.type
        );
        if (availableRules.length > 0) {
            let earliest = Infinity, latest = -Infinity;
            for (const rule of availableRules) {
                const rStart = rule.startMin ?? (rule.start ? parseTime(rule.start) : null);
                const rEnd = rule.endMin ?? (rule.end ? parseTime(rule.end) : null);
                if (rStart != null && rStart < earliest) earliest = rStart;
                if (rEnd != null && rEnd > latest) latest = rEnd;
            }
            if (earliest < Infinity && latest > -Infinity) {
                return { startMin: earliest, endMin: latest };
            }
        }
    }
    return null;
}

// Scarce = only available on certain days (not every day)
function isScarceSpecial(specialConfig, dayName) {
    if (!specialConfig) return false;
    if (!isSpecialAvailableOnDay(specialConfig, dayName)) return false;
    if (Array.isArray(specialConfig.availableDays) && specialConfig.availableDays.length > 0) return true;
    if (specialConfig.dayAvailability) return true;
    if (specialConfig.mustScheduleWhenAvailable) return true;
    return false;
}

function isSpecialAvailableForDivision(specialName, divName) {
    const config = getSpecialConfig(specialName);
    if (!config) return true;
    const rules = config.limitUsage;
    if (!rules || !rules.enabled) return true;
    const allowedDivs = rules.divisions;
    if (!allowedDivs || typeof allowedDivs !== 'object') return true;
    if (Array.isArray(allowedDivs)) return allowedDivs.includes(divName);
    return divName in allowedDivs;
}

// =================================================================
// ROTATION HISTORY ACCESS
// =================================================================

function getRotationScore(bunkName, activityName) {
    if (window.RotationEngine?.calculateFullRotationScore) {
        return window.RotationEngine.calculateFullRotationScore(bunkName, activityName, 0, {});
    }
    if (window.RotationEngine?.calculateRecencyScore) {
        return window.RotationEngine.calculateRecencyScore(bunkName, activityName, 0);
    }
    return 0;
}

function getRankedSpecials(bunkName, availableSpecials) {
    const ranked = availableSpecials.map(name => ({
        name,
        score: getRotationScore(bunkName, name),
        duration: getSpecialDuration(name) || 30
    }));
    ranked.sort((a, b) => a.score - b.score);
    return ranked;
}

// =================================================================
// PLACEMENT HELPERS
// =================================================================

function findGaps(occupied, divTimes) {
    if (occupied.length === 0) {
        return [{ startMin: divTimes.start, endMin: divTimes.end }];
    }
    const sorted = [...occupied].sort((a, b) => a.startMin - b.startMin);
    const gaps = [];
    if (sorted[0].startMin > divTimes.start) {
        gaps.push({ startMin: divTimes.start, endMin: sorted[0].startMin });
    }
    for (let i = 0; i < sorted.length - 1; i++) {
        const gapStart = sorted[i].endMin;
        const gapEnd = sorted[i + 1].startMin;
        if (gapEnd > gapStart + 4) {
            gaps.push({ startMin: gapStart, endMin: gapEnd });
        }
    }
    const lastEnd = sorted[sorted.length - 1].endMin;
    if (lastEnd < divTimes.end) {
        gaps.push({ startMin: lastEnd, endMin: divTimes.end });
    }
    return gaps;
}

function findBestPlacement(windowStart, windowEnd, duration, occupied, divTimes) {
    const candidates = [];
    for (let start = windowStart; start + duration <= windowEnd; start += 5) {
        const end = start + duration;
        const hasConflict = occupied.some(occ =>
            start < occ.endMin && end > occ.startMin
        );
        if (!hasConflict) {
            const windowCenter = (windowStart + windowEnd) / 2;
            const blockCenter = (start + end) / 2;
            candidates.push({ startMin: start, endMin: end, score: Math.abs(blockCenter - windowCenter) });
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
}

function findPerBunkPlacement(bunkOccupied, duration, windowStart, windowEnd, divTimes) {
    // Try within window
    for (let start = windowStart; start + duration <= windowEnd; start += 5) {
        const end = start + duration;
        if (!bunkOccupied.some(o => start < o.endMin && end > o.startMin)) {
            return { startMin: start, endMin: end };
        }
    }
    // Try after window within day
    for (let start = windowEnd; start + duration <= divTimes.end; start += 5) {
        const end = start + duration;
        if (!bunkOccupied.some(o => start < o.endMin && end > o.startMin)) {
            return { startMin: start, endMin: end };
        }
    }
    // Try before window within day
    for (let start = divTimes.start; start + duration <= windowStart; start += 5) {
        const end = start + duration;
        if (!bunkOccupied.some(o => start < o.endMin && end > o.startMin)) {
            return { startMin: start, endMin: end };
        }
    }
    return null;
}

function getSharedOccupied(bunkState, bunks) {
    const shared = [];
    const seen = new Set();
    bunks.forEach(bunk => {
        bunkState[bunk].occupied.forEach(occ => {
            const key = `${occ.startMin}-${occ.endMin}-${occ.event}`;
            if (!seen.has(key)) {
                seen.add(key);
                shared.push(occ);
            }
        });
    });
    return shared;
}

// =================================================================
// SOFT FEASIBILITY CHECK
// =================================================================
// After placing a high-priority item, check whether remaining gaps
// can still fit the remaining layer requirements for this bunk.

function softFeasibilityCheck(bunkOccupied, divTimes, remainingLayers) {
    const gaps = findGaps(bunkOccupied, divTimes);
    let totalGapMinutes = 0;
    gaps.forEach(g => { totalGapMinutes += (g.endMin - g.startMin); });

    let totalNeededMinutes = 0;
    for (const req of remainingLayers) {
        totalNeededMinutes += (req.count * req.duration);
    }

    return totalGapMinutes >= totalNeededMinutes;
}

// =================================================================
// LAYER HELPERS
// =================================================================

function getLayerQty(layer) {
    if (layer.qty != null) return layer.qty;
    if (layer.quantity != null) {
        if (typeof layer.quantity === 'object') return layer.quantity.val || 1;
        return layer.quantity;
    }
    return 1;
}

function getLayerOp(layer) {
    if (layer.op) return layer.op;
    if (layer.operator) return layer.operator;
    if (layer.quantity?.op) return layer.quantity.op;
    return '>=';
}

function getLayerDuration(layer) {
    return layer.durationMin || layer.periodMin || layer.duration || 30;
}

function getLayerDurationMax(layer) {
    return layer.durationMax || getLayerDuration(layer);
}

function isLayerPinned(layer) {
    const lType = (layer.type || '').toLowerCase();
    if (layer.pinned || layer.pinExact) return true;
    if (lType === 'swim' || lType === 'custom') return true;
    if (window.CustomPersistentTiles?.isCustomType?.(lType)) return true;
    const op = layer.op || layer.operator || '>=';
    if (op === '=') {
        const windowSize = (layer.endMin || 0) - (layer.startMin || 0);
        const dur = layer.durationMin || layer.periodMin || layer.duration || 0;
        if (dur > 0 && windowSize > 0 && windowSize <= dur) return true;
    }
    return false;
}

function isLayerLimited(layer) {
    // Limited = quantity is 1, or time window is tight relative to duration
    const qty = getLayerQty(layer);
    if (qty === 1) return true;
    const dur = getLayerDuration(layer);
    const windowSize = (layer.endMin || 0) - (layer.startMin || 0);
    if (dur > 0 && windowSize > 0 && windowSize < dur * 2) return true;
    return false;
}

function computeRequirements(typeLayers) {
    let minRequired = 0;
    let maxAllowed = Infinity;
    let hasExact = false;
    typeLayers.forEach(layer => {
        const qty = getLayerQty(layer);
        const op = getLayerOp(layer);
        if (op === '=' || op === '==') {
            minRequired = qty;
            maxAllowed = qty;
            hasExact = true;
        } else if (op === '>=' || op === '≥') {
            minRequired = Math.max(minRequired, qty);
        } else if (op === '<=' || op === '≤') {
            maxAllowed = Math.min(maxAllowed, qty);
        }
    });
    return { min: minRequired, max: maxAllowed, hasExact };
}

// =================================================================
// MAIN BUILD FUNCTION
// =================================================================

function build({ layers, dateStr }) {
    log('═══════════════════════════════════════════════════════');
    log(`AUTO BUILD ENGINE v${VERSION}`);
    log(`Date: ${dateStr}, Layers: ${layers.length}`);
    log('═══════════════════════════════════════════════════════');

    const warnings = [];
    const [Y, M, D] = dateStr.split('-').map(Number);
    const dow = new Date(Y, M - 1, D).getDay();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[dow];
    log(`Day: ${dayName}`);

    const allSpecials = getSpecialActivities();
    const isRainy = !!window.isRainyDay;

    const todaysSpecials = allSpecials.filter(s => {
        if (!isSpecialAvailableOnDay(s, dayName)) return false;
        if (!isRainy && s.rainyDayOnly) return false;
        return true;
    });
    // Scarce = only available certain days. Discovered from config, NOT layers.
    const scarceSpecials = todaysSpecials.filter(s => isScarceSpecial(s, dayName));
    const regularSpecials = todaysSpecials.filter(s => !isScarceSpecial(s, dayName));

    log(`Specials — total: ${allSpecials.length}, today: ${todaysSpecials.length} (rainy: ${isRainy}), scarce: ${scarceSpecials.length}, regular: ${regularSpecials.length}`);

    // Group layers by grade
    const layersByGrade = {};
    layers.forEach(l => {
        const grade = l.grade || l.division || '_all';
        if (!layersByGrade[grade]) layersByGrade[grade] = [];
        layersByGrade[grade].push({ ...l });
    });

    const allSkeleton = [];
    const allBunkOverrides = [];
    const bunkTimelines = {};

    // Cross-division scarce capacity tracker
    const globalScarceUsage = {};

    function getGlobalScarceCapacity(specialConfig) {
        return parseInt(specialConfig.sharableWith?.capacity)
            || parseInt(specialConfig.capacity) || 1;
    }

    function getGlobalScarceSlotUsage(name, slotStartMin) {
        const entry = globalScarceUsage[name + '|' + slotStartMin];
        return entry ? entry.count : 0;
    }

    function getGlobalScarceSlotDivision(name, slotStartMin) {
        const entry = globalScarceUsage[name + '|' + slotStartMin];
        return entry ? entry.division : null;
    }

    function recordGlobalScarceUsage(name, slotStartMin, count, divisionName) {
        const key = name + '|' + slotStartMin;
        if (!globalScarceUsage[key]) {
            globalScarceUsage[key] = { count: 0, division: divisionName };
        }
        globalScarceUsage[key].count += count;
        if (globalScarceUsage[key].division !== divisionName) {
            globalScarceUsage[key].division = '_mixed';
        }
    }

    function isSlotAvailableForDivision(specialConfig, slotStartMin, divName) {
        const name = specialConfig.name;
        const entry = globalScarceUsage[name + '|' + slotStartMin];
        if (!entry || entry.count === 0) return true;
        const shareType = specialConfig.sharableWith?.type || 'not_sharable';
        const ownerDiv = entry.division;
        if (shareType === 'not_sharable') return false;
        if (shareType === 'same_division') {
            if (ownerDiv === '_mixed') return false;
            return ownerDiv === divName;
        }
        if (shareType === 'custom') {
            return (specialConfig.sharableWith?.divisions || []).includes(divName);
        }
        return true; // 'all'
    }

    function getRemainingGlobalScarceSlots(specialConfig, forDivision) {
        const name = specialConfig.name;
        const duration = specialConfig.defaultDuration || specialConfig.duration || 30;
        const timeWindow = getSpecialTimeWindow(specialConfig);
        if (!timeWindow) return 0;
        const capacity = getGlobalScarceCapacity(specialConfig);
        let remaining = 0;
        for (let cursor = timeWindow.startMin; cursor + duration <= timeWindow.endMin; cursor += duration) {
            if (forDivision && !isSlotAvailableForDivision(specialConfig, cursor, forDivision)) continue;
            const used = getGlobalScarceSlotUsage(name, cursor);
            remaining += Math.max(0, capacity - used);
        }
        return remaining;
    }

    const globalScarceAPI = {
        getUsage: getGlobalScarceSlotUsage,
        getDivision: getGlobalScarceSlotDivision,
        record: recordGlobalScarceUsage,
        getRemaining: getRemainingGlobalScarceSlots,
        getCapacity: getGlobalScarceCapacity,
        isSlotAvailableForDiv: isSlotAvailableForDivision
    };

    // Process each grade
    const baseLayersForAll = layersByGrade['_all'] || [];
    delete layersByGrade['_all'];
    const divisions = getDivisions();
    const gradesToProcess = Object.keys(layersByGrade).length > 0
        ? Object.keys(layersByGrade)
        : Object.keys(divisions);

    for (const gradeName of gradesToProcess) {
        const gradeLayers = [...baseLayersForAll, ...(layersByGrade[gradeName] || [])];
        if (gradeLayers.length === 0) { warn(`No layers for ${gradeName}, skipping`); continue; }

        const divName = getDivisionForGrade(gradeName);
        const bunks = getBunksForDivision(divName);
        const divTimes = getDivisionTimes(divName);
        if (bunks.length === 0) { warn(`No bunks for division ${divName}`); continue; }

        log(`\nProcessing ${gradeName} (div: ${divName}, ${bunks.length} bunks, ${gradeLayers.length} layers)`);

        const result = buildForGrade({
            gradeName, divName, bunks, layers: gradeLayers,
            dayName, dateStr, divTimes,
            scarceSpecials, regularSpecials, todaysSpecials,
            warnings, globalScarceUsage: globalScarceAPI
        });

        allSkeleton.push(...result.skeleton);
        allBunkOverrides.push(...result.bunkOverrides);
        Object.assign(bunkTimelines, result.bunkTimelines);
    }

    log('\n═══════════════════════════════════════════════════════');
    log(`BUILD COMPLETE: ${allSkeleton.length} skeleton blocks, ${allBunkOverrides.length} bunk overrides`);
    log('═══════════════════════════════════════════════════════\n');

    return {
        skeleton: allSkeleton,
        bunkOverrides: allBunkOverrides,
        bunkTimelines,
        warnings,
        _autoGenerated: true,
        _buildDate: dateStr,
        _buildVersion: VERSION
    };
}

// =================================================================
// BUILD FOR GRADE — v4.0 Per-Bunk Architecture
// =================================================================

function buildForGrade({ gradeName, divName, bunks, layers, dayName, dateStr, divTimes, scarceSpecials, regularSpecials, todaysSpecials, warnings, globalScarceUsage }) {
    const skeleton = [];
    const bunkOverrides = [];
    const bunkTimelines = {};

    // Filter specials available for this division
    const divScarce = scarceSpecials.filter(s => isSpecialAvailableForDivision(s.name, divName));
    const divRegular = regularSpecials.filter(s => isSpecialAvailableForDivision(s.name, divName));

    log(`  [Division Access] ${divName}: ${divRegular.length} regular specials, ${divScarce.length} scarce specials`);

    // Initialize per-bunk state
    const bunkState = {};
    bunks.forEach(bunk => {
        bunkState[bunk] = {
            occupied: [],
            specialCount: 0,
            sportCount: 0,
            usedActivities: []
        };
        bunkTimelines[bunk] = [];
    });

    // =================================================================
    // CLASSIFY LAYERS
    // =================================================================

    const pinnedLayers = [];
    const fixedLayers = [];
    const leagueLayers = [];
    const specialtyLeagueLayers = [];
    const specialLayers = [];
    const sportLayers = [];
    const customLayers = [];

    layers.forEach((layer, idx) => {
        layer._idx = idx;
        const lType = (layer.type || '').toLowerCase();

        if (['lunch', 'snack', 'snacks', 'dismissal'].includes(lType)) {
            fixedLayers.push(layer);
        } else if (lType === 'league') {
            leagueLayers.push(layer);
        } else if (lType === 'specialty_league') {
            specialtyLeagueLayers.push(layer);
        } else if (window.CustomPersistentTiles?.isCustomType?.(lType)) {
            pinnedLayers.push(layer);
        } else if (isLayerPinned(layer)) {
            pinnedLayers.push(layer);
        } else if (lType === 'special') {
            specialLayers.push(layer);
        } else if (lType === 'sport' || lType === 'sports') {
            sportLayers.push(layer);
        } else {
            customLayers.push(layer);
        }
    });

    const specialReq = computeRequirements(specialLayers);
    const sportReq = computeRequirements(sportLayers);

    const specialDur = specialLayers.length > 0 ? getLayerDuration(specialLayers[0]) : 30;
    const specialDurMax = specialLayers.length > 0 ? getLayerDurationMax(specialLayers[0]) : specialDur;
    const sportDurMin = sportLayers.length > 0 ? getLayerDuration(sportLayers[0]) : 30;
    const sportDurMax = sportLayers.length > 0 ? getLayerDurationMax(sportLayers[0]) : sportDurMin;
    const minActivityDur = Math.min(sportDurMin, specialDur);

    log(`  Classified: ${pinnedLayers.length} pinned, ${fixedLayers.length} fixed, ` +
        `${leagueLayers.length} league, ${specialtyLeagueLayers.length} specialty_league, ` +
        `${specialLayers.length} special, ${sportLayers.length} sport`);
    log(`  Requirements — Specials: min=${specialReq.min}, max=${specialReq.max} | ` +
        `Sports: min=${sportReq.min}, max=${sportReq.max}`);

    // Helper: compute what layers still need to be satisfied for soft checks
    function getRemainingNeeds(bunkSpecialCount, bunkSportCount) {
        const needs = [];
        const specStill = Math.max(0, specialReq.min - bunkSpecialCount);
        const sportStill = Math.max(0, sportReq.min - bunkSportCount);
        if (specStill > 0) needs.push({ count: specStill, duration: specialDur });
        if (sportStill > 0) needs.push({ count: sportStill, duration: sportDurMin });
        // Fixed events that haven't been placed yet are handled separately
        return needs;
    }

    // Helper: add occupied + timeline entry for a bunk
    function markBunkOccupied(bunk, startMin, endMin, event, type) {
        bunkState[bunk].occupied.push({ startMin, endMin, event, type });
        bunkTimelines[bunk].push({ startMin, endMin, event, type, _autoGenerated: true });
    }

    // ═════════════════════════════════════════════════════════════════
    // PHASE 1: SCARCE ACTIVITIES (discovered from config, per-bunk)
    // ═════════════════════════════════════════════════════════════════

    log(`\n  [Phase 1] Scarce activities: ${divScarce.length}`);

    divScarce.forEach(specialConfig => {
        const name = specialConfig.name;
        const duration = specialConfig.defaultDuration || specialConfig.duration || 30;
        const timeWindow = getSpecialTimeWindow(specialConfig);

        if (!timeWindow) {
            warn(`Scarce "${name}" has no time window, skipping`);
            return;
        }

        const windowStart = timeWindow.startMin;
        const windowEnd = timeWindow.endMin;
        const capacity = parseInt(specialConfig.sharableWith?.capacity)
            || parseInt(specialConfig.capacity) || 1;

        // Check global cross-division capacity
        if (globalScarceUsage) {
            const remaining = globalScarceUsage.getRemaining(specialConfig, divName);
            if (remaining <= 0) {
                log(`    ${name}: skipped — globally exhausted for ${divName}`);
                return;
            }
        }

        // Rank bunks by rotation (most overdue first)
        const rankedBunks = bunks.map(bunk => ({
            bunk, score: getRotationScore(bunk, name)
        })).sort((a, b) => a.score - b.score);

        const slotsAvailable = Math.floor((windowEnd - windowStart) / duration);
        const totalCapacity = slotsAvailable * capacity;
        let globalUsed = 0;
        if (globalScarceUsage) {
            for (let c = windowStart; c + duration <= windowEnd; c += duration) {
                globalUsed += globalScarceUsage.getUsage(name, c);
            }
        }
        const bunksToServe = Math.min(bunks.length, Math.max(0, totalCapacity - globalUsed));

        if (bunksToServe <= 0) {
            log(`    ${name}: no capacity remaining`);
            return;
        }

        log(`    ${name}: window ${fmtTime(windowStart)}-${fmtTime(windowEnd)}, ` +
            `dur ${duration}min, cap ${capacity}, serving up to ${bunksToServe} bunks`);

        let slotCursor = windowStart;
        let served = 0;

        while (served < bunksToServe && slotCursor + duration <= windowEnd) {
            const slotStart = slotCursor;
            const slotEnd = slotCursor + duration;

            // Check global capacity + division sharing
            let slotGlobalUsed = globalScarceUsage ? globalScarceUsage.getUsage(name, slotStart) : 0;
            let slotDivBlocked = false;
            if (slotGlobalUsed > 0 && globalScarceUsage?.isSlotAvailableForDiv) {
                slotDivBlocked = !globalScarceUsage.isSlotAvailableForDiv(specialConfig, slotStart, divName);
            }
            if (capacity - slotGlobalUsed <= 0 || slotDivBlocked) {
                slotCursor = slotEnd;
                continue;
            }

            let assignedThisSlot = 0;
            const slotRemainingCap = capacity - slotGlobalUsed;

            for (let c = 0; c < slotRemainingCap && served < bunksToServe; c++) {
                const bunkInfo = rankedBunks[served];
                const bunk = bunkInfo.bunk;

                // Check conflict with this bunk's existing schedule
                const hasConflict = bunkState[bunk].occupied.some(o =>
                    slotStart < o.endMin && slotEnd > o.startMin
                );

                if (hasConflict) {
                    // Defer this bunk to try later slot
                    rankedBunks.push(rankedBunks.splice(served, 1)[0]);
                    continue;
                }

                // Soft feasibility: does the rest of the day still work?
                const testOccupied = [...bunkState[bunk].occupied, { startMin: slotStart, endMin: slotEnd }];
                const remainingNeeds = getRemainingNeeds(bunkState[bunk].specialCount + 1, bunkState[bunk].sportCount);
                // Add fixed layer needs
                fixedLayers.forEach(fl => {
                    const flDur = getLayerDuration(fl);
                    if (!testOccupied.some(o => o.event === (fl.event || fl.type))) {
                        remainingNeeds.push({ count: 1, duration: flDur });
                    }
                });

                if (!softFeasibilityCheck(testOccupied, divTimes, remainingNeeds)) {
                    log(`      ${bunk}: scarce ${name} at ${fmtTime(slotStart)} fails feasibility, skipping`);
                    rankedBunks.push(rankedBunks.splice(served, 1)[0]);
                    continue;
                }

                // Place it — as a tagged slot, NOT an override
                // The solver will read _suggestedActivity and validate before assigning
                markBunkOccupied(bunk, slotStart, slotEnd, name, 'scarce_special');
                bunkState[bunk].specialCount++;
                bunkState[bunk].usedActivities.push(name);

                // Per-bunk skeleton slot with suggestion tag
                skeleton.push({
                    id: 'auto_scarce_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: 'Special Activity',
                    division: divName,
                    startTime: fmtTime(slotStart),
                    endTime: fmtTime(slotEnd),
                    _autoGenerated: true,
                    _bunk: String(bunk),
                    _suggestedActivity: name,
                    _scarce: true,
                    _durationStrict: true,
                    _targetDuration: duration
                });

                log(`      ${bunk}: ${name} @ ${fmtTime(slotStart)}-${fmtTime(slotEnd)}`);
                served++;
                assignedThisSlot++;
            }

            if (assignedThisSlot > 0 && globalScarceUsage) {
                globalScarceUsage.record(name, slotStart, assignedThisSlot, divName);
            }
            slotCursor = slotEnd;
        }

        if (served < bunksToServe) {
            warnings.push(`${name}: Only ${served}/${bunksToServe} bunks scheduled`);
        }
        log(`    ${name}: placed ${served} bunks`);
    });

    // ═════════════════════════════════════════════════════════════════
    // PHASE 2: PINNED + FIXED + LIMITED (per-bunk aware)
    // ═════════════════════════════════════════════════════════════════

    log(`\n  [Phase 2] Pinned/Fixed/Limited tiles`);

    // 2a: Pinned events (exact time, all bunks) — swim, custom tiles
    pinnedLayers.forEach(layer => {
        const startMin = layer.startMin;
        const endMin = layer.startMin + (getLayerDuration(layer) || (layer.endMin - layer.startMin));
        const eventName = layer.event || layer.type;
        const lType = (layer.type || '').toLowerCase();

        // Division-wide skeleton block
        skeleton.push({
            id: 'auto_pinned_' + Math.random().toString(36).slice(2, 9),
            type: 'pinned', event: eventName, division: divName,
            startTime: fmtTime(startMin), endTime: fmtTime(endMin),
            pinned: true, _autoGenerated: true
        });

        // Change buffer handling
        let changeDur = 0;
        if (lType === 'swim') {
            const gs = getGlobalSettings();
            changeDur = parseInt(gs.app1?.changeBufferDuration) || parseInt(gs.changeBufferDuration) || 10;
        } else if (window.CustomPersistentTiles?.getChangeDuration) {
            changeDur = window.CustomPersistentTiles.getChangeDuration(lType) || 0;
        }

        bunks.forEach(bunk => {
            markBunkOccupied(bunk, startMin, endMin, eventName, 'pinned');

            if (changeDur > 0 && endMin + changeDur <= divTimes.end) {
                const cStart = endMin, cEnd = endMin + changeDur;
                markBunkOccupied(bunk, cStart, cEnd, 'Change', 'change_buffer');
                skeleton.push({
                    id: 'auto_change_' + Math.random().toString(36).slice(2, 9),
                    type: 'pinned', event: 'Change', division: divName,
                    startTime: fmtTime(cStart), endTime: fmtTime(cEnd),
                    pinned: true, _autoGenerated: true, _bunk: String(bunk), _changeFor: eventName
                });
            }
            if (changeDur > 0 && startMin - changeDur >= divTimes.start) {
                const pStart = startMin - changeDur, pEnd = startMin;
                const overlaps = bunkState[bunk].occupied.some(o =>
                    pStart < o.endMin && pEnd > o.startMin
                );
                if (!overlaps) {
                    markBunkOccupied(bunk, pStart, pEnd, 'Change', 'change_buffer');
                    skeleton.push({
                        id: 'auto_prechange_' + Math.random().toString(36).slice(2, 9),
                        type: 'pinned', event: 'Change', division: divName,
                        startTime: fmtTime(pStart), endTime: fmtTime(pEnd),
                        pinned: true, _autoGenerated: true, _bunk: String(bunk), _changeFor: eventName
                    });
                }
            }
        });

        log(`    Pinned: ${eventName} ${fmtTime(startMin)}-${fmtTime(endMin)}` +
            (changeDur > 0 ? ` (+${changeDur}min change)` : ''));
    });

    // 2b: Fixed events (lunch, snack, dismissal) — per-bunk placement
    const fixedEventRanges = [];

    fixedLayers.forEach(layer => {
        const duration = getLayerDuration(layer);
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        const eventName = layer.event || layer.type;
        const isPinned = (windowEnd - windowStart) <= duration;

        log(`    Fixed: ${eventName} window=${fmtTime(windowStart)}-${fmtTime(windowEnd)} dur=${duration}min ${isPinned ? '(pinned)' : '(windowed)'}`);

        bunks.forEach(bunk => {
            let placement;
            if (isPinned) {
                // Check for conflict with this bunk's occupied time
                const hasConflict = bunkState[bunk].occupied.some(o =>
                    windowStart < o.endMin && (windowStart + duration) > o.startMin
                );
                if (hasConflict) {
                    placement = findPerBunkPlacement(bunkState[bunk].occupied, duration, windowStart, windowEnd, divTimes);
                } else {
                    placement = { startMin: windowStart, endMin: windowStart + duration };
                }
            } else {
                // Windowed: find best spot for this bunk
                placement = findBestPlacement(windowStart, windowEnd, duration, bunkState[bunk].occupied, divTimes);
                if (!placement) {
                    placement = findPerBunkPlacement(bunkState[bunk].occupied, duration, windowStart, windowEnd, divTimes);
                }
            }

            if (placement) {
                markBunkOccupied(bunk, placement.startMin, placement.endMin, eventName, 'fixed');
                // Per-bunk skeleton block
                skeleton.push({
                    id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9),
                    type: 'pinned', event: eventName, division: divName,
                    startTime: fmtTime(placement.startMin), endTime: fmtTime(placement.endMin),
                    pinned: true, _autoGenerated: true, _bunk: String(bunk)
                });
                // Bunk override so Step 2 picks it up
                bunkOverrides.push({
                    bunk, division: divName, activity: eventName, type: 'pinned',
                    startTime: fmtTime(placement.startMin), endTime: fmtTime(placement.endMin),
                    _autoGenerated: true, _fixedEvent: true
                });
            } else {
                warn(`${bunk}: Could not place ${eventName}`);
                warnings.push(`${bunk}: ${eventName} could not be placed`);
            }
        });

        // Track for reference (use first bunk's placement as the canonical range)
        const firstBunkOcc = bunkState[bunks[0]]?.occupied.find(o =>
            o.event?.toLowerCase() === eventName.toLowerCase() && o.type === 'fixed'
        );
        if (firstBunkOcc) {
            fixedEventRanges.push({ startMin: firstBunkOcc.startMin, endMin: firstBunkOcc.endMin, event: eventName });
        }
    });

    // ═════════════════════════════════════════════════════════════════
    // PHASE 3: LEAGUES (division-wide)
    // ═════════════════════════════════════════════════════════════════

    log(`\n  [Phase 3] Leagues: ${leagueLayers.length} regular, ${specialtyLeagueLayers.length} specialty`);

    const allLeagueLayers = [...leagueLayers, ...specialtyLeagueLayers];

    allLeagueLayers.forEach(layer => {
        const isSpecialty = (layer.type || '').toLowerCase() === 'specialty_league';
        const duration = getLayerDuration(layer);
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        const qty = getLayerQty(layer);
        const eventName = isSpecialty ? 'Specialty League' : 'League Game';

        for (let i = 0; i < Math.max(qty, 1); i++) {
            let placement = findBestPlacement(
                windowStart, windowEnd, duration,
                getSharedOccupied(bunkState, bunks), divTimes
            );
            if (!placement) {
                warn(`League ${i+1}: force-placing at ${fmtTime(windowStart)}`);
                placement = { startMin: windowStart, endMin: windowStart + duration };
            }

            skeleton.push({
                id: 'auto_league_' + Math.random().toString(36).slice(2, 9),
                type: isSpecialty ? 'specialty_league' : 'league',
                event: eventName, division: divName,
                startTime: fmtTime(placement.startMin), endTime: fmtTime(placement.endMin),
                _autoGenerated: true
            });

            bunks.forEach(bunk => {
                markBunkOccupied(bunk, placement.startMin, placement.endMin, eventName,
                    isSpecialty ? 'specialty_league' : 'league');
            });

            log(`    ${eventName} #${i+1}: ${fmtTime(placement.startMin)}-${fmtTime(placement.endMin)} (all bunks)`);
        }
    });

    // ═════════════════════════════════════════════════════════════════
    // PHASE 4: INTELLIGENT FILLER (per-bunk, rotation-aware)
    // ═════════════════════════════════════════════════════════════════
    // For each bunk:
    //   1. Find this bunk's actual gaps
    //   2. For each gap, decide what type of activity is needed
    //   3. Check rotation — what hasn't this bunk done recently?
    //   4. Size the skeleton slot to the chosen activity's real duration
    //   5. Fill the rest of the gap with the next needed type
    // ═════════════════════════════════════════════════════════════════

    log(`\n  [Phase 4] Intelligent filler (per-bunk)`);

    // Capacity tracking for specials across bunks within this grade
    const specialSlotUsage = {};
    function isSpecialAtCapacity(specialName, slotStartMin) {
        const key = specialName + '|' + slotStartMin;
        const used = specialSlotUsage[key] || 0;
        const config = getSpecialConfig(specialName);
        const cap = config?.sharableWith?.capacity ? parseInt(config.sharableWith.capacity) :
            (config?.sharableWith?.type === 'not_sharable' ? 1 : 2);
        return used >= cap;
    }
    function recordSpecialUsage(specialName, slotStartMin) {
        const key = specialName + '|' + slotStartMin;
        specialSlotUsage[key] = (specialSlotUsage[key] || 0) + 1;
    }

    bunks.forEach(bunk => {
        const state = bunkState[bunk];
        const gaps = findGaps(state.occupied, divTimes);

        if (gaps.length === 0) {
            log(`    ${bunk}: No gaps to fill`);
            return;
        }

        let placedSpecials = state.specialCount;
        let placedSports = state.sportCount;
        const usedToday = [...state.usedActivities];

        log(`    ${bunk}: ${gaps.length} gaps, already ${placedSpecials}S/${placedSports}Sp`);

        // Track blocks placed in this bunk's gaps so we can extend the last one
        let lastPlacedBlock = null;

        for (const gap of gaps) {
            let cursor = gap.startMin;
            lastPlacedBlock = null; // reset per gap

            while (cursor < gap.endMin) {
                const remaining = gap.endMin - cursor;

                // If remaining time is less than any layer minimum, absorb into previous block
                // or create an undersized slot if there's nothing to absorb into
                if (remaining < minActivityDur) {
                    if (lastPlacedBlock) {
                        const maxAllowed = lastPlacedBlock._pickType === 'special' ? specialDurMax : sportDurMax;
                        const extended = lastPlacedBlock._blockDur + remaining;
                        if (extended <= maxAllowed) {
                            // Extend the previous skeleton block and timeline entry
                            lastPlacedBlock.skeletonRef.endTime = fmtTime(cursor + remaining);
                            lastPlacedBlock.skeletonRef._targetDuration = extended;
                            lastPlacedBlock.timelineRef.endMin = cursor + remaining;
                            lastPlacedBlock.occupiedRef.endMin = cursor + remaining;
                            if (lastPlacedBlock.overrideRef) {
                                lastPlacedBlock.overrideRef.endTime = fmtTime(cursor + remaining);
                            }
                            log(`      ${bunk}: Absorbed ${remaining}min remainder into previous block (now ${extended}min)`);
                            break;
                        }
                    }
                    // No previous block to absorb into (e.g. gap after a league)
                    // Create a slot anyway — the solver can handle slightly short durations
                    if (remaining >= 15) {
                        const gapEvent = (placedSpecials <= placedSports && !specialsMaxed) ? 'Special Activity' : 'Sports Slot';
                        skeleton.push({
                            id: 'auto_short_' + Math.random().toString(36).slice(2, 9),
                            type: 'slot', event: gapEvent, division: divName,
                            startTime: fmtTime(cursor), endTime: fmtTime(cursor + remaining),
                            _autoGenerated: true, _bunk: String(bunk),
                            _durationStrict: false, _targetDuration: remaining
                        });
                        state.occupied.push({ startMin: cursor, endMin: cursor + remaining, event: gapEvent, type: 'short_slot' });
                        bunkTimelines[bunk].push({ startMin: cursor, endMin: cursor + remaining, event: gapEvent, type: 'short_slot', _autoGenerated: true });
                        log(`      ${bunk}: Short gap ${remaining}min → ${gapEvent} ${fmtTime(cursor)}-${fmtTime(cursor + remaining)}`);
                    }
                    break;
                }

                // Decide: does this bunk need a special or a sport?
                const specialsNeeded = Math.max(0, specialReq.min - placedSpecials);
                const sportsNeeded = Math.max(0, sportReq.min - placedSports);
                const specialsMaxed = specialReq.max !== Infinity && placedSpecials >= specialReq.max;
                const sportsMaxed = sportReq.max !== Infinity && placedSports >= sportReq.max;

                let pickType;
                if (specialsNeeded > 0 && !specialsMaxed) {
                    pickType = 'special';
                } else if (sportsNeeded > 0 && !sportsMaxed) {
                    pickType = 'sport';
                } else if (!specialsMaxed && !sportsMaxed) {
                    pickType = (placedSpecials <= placedSports) ? 'special' : 'sport';
                } else if (!specialsMaxed) {
                    pickType = 'special';
                } else if (!sportsMaxed) {
                    pickType = 'sport';
                } else {
                    pickType = 'sport';
                }

                // Get the minimum duration for the chosen type
                const typeMinDur = pickType === 'special' ? specialDur : sportDurMin;
                const typeMaxDur = pickType === 'special' ? specialDurMax : sportDurMax;

                // If remaining is less than this type's minimum, try the other type
                if (remaining < typeMinDur) {
                    const otherType = pickType === 'special' ? 'sport' : 'special';
                    const otherMin = otherType === 'special' ? specialDur : sportDurMin;
                    if (remaining >= otherMin) {
                        pickType = otherType;
                    } else {
                        // Neither type fits at minimum — absorb into previous or skip
                        if (lastPlacedBlock) {
                            const maxAllowed = lastPlacedBlock._pickType === 'special' ? specialDurMax : sportDurMax;
                            const extended = lastPlacedBlock._blockDur + remaining;
                            if (extended <= maxAllowed) {
                                lastPlacedBlock.skeletonRef.endTime = fmtTime(cursor + remaining);
                                lastPlacedBlock.skeletonRef._targetDuration = extended;
                                lastPlacedBlock.timelineRef.endMin = cursor + remaining;
                                lastPlacedBlock.occupiedRef.endMin = cursor + remaining;
                                if (lastPlacedBlock.overrideRef) {
                                    lastPlacedBlock.overrideRef.endTime = fmtTime(cursor + remaining);
                                }
                                log(`      ${bunk}: Absorbed ${remaining}min (below min) into previous block`);
                            }
                        }
                        break;
                    }
                }

                // Recalculate min/max for the (possibly switched) type
                const effectiveMinDur = pickType === 'special' ? specialDur : sportDurMin;
                const effectiveMaxDur = pickType === 'special' ? specialDurMax : sportDurMax;

                let blockDur;
                let hintActivity = null;
                let eventLabel;

                if (pickType === 'special') {
                    // Build list of specials valid at this time
                    const blockEndTime = cursor + (specialDurMax || 60); // rough end
                    const availableNames = divRegular.map(s => s.name)
                        .filter(n => !usedToday.map(u => u.toLowerCase()).includes(n.toLowerCase()))
                        .filter(n => !isSpecialAtCapacity(n, cursor))
                        .filter(n => {
                            // Exclude scarce specials — they're handled in Phase 1
                            const cfg = getSpecialConfig(n);
                            if (cfg && isScarceSpecial(cfg, dayName)) return false;
                            // Check time window: if the special has a time restriction,
                            // the current cursor must be within that window
                            const tw = cfg ? getSpecialTimeWindow(cfg) : null;
                            if (tw) {
                                if (cursor < tw.startMin || cursor >= tw.endMin) return false;
                                // Also ensure the activity's duration fits within the window
                                const actDur = cfg.defaultDuration || cfg.duration || specialDur;
                                if (cursor + actDur > tw.endMin) return false;
                            }
                            return true;
                        });

                    const ranked = getRankedSpecials(bunk, availableNames);

                    if (ranked.length > 0) {
                        const best = ranked[0];
                        const actDuration = best.duration || specialDur;
                        blockDur = Math.min(actDuration, remaining, effectiveMaxDur);
                        blockDur = snapTo5(blockDur);
                        if (blockDur < effectiveMinDur) blockDur = effectiveMinDur;
                        if (blockDur > remaining) blockDur = remaining;
                        hintActivity = best.name;
                        eventLabel = 'Special Activity';
                    } else {
                        // No specials left, switch to sport
                        pickType = 'sport';
                    }
                }

                if (pickType === 'sport') {
                    blockDur = Math.min(sportDurMax, remaining);
                    blockDur = snapTo5(blockDur);
                    if (blockDur < sportDurMin) blockDur = sportDurMin;
                    if (blockDur > remaining) blockDur = remaining;
                    eventLabel = 'Sports Slot';
                }

                // Anti-runt: if leftover after this block would be too small, absorb it
                const afterThis = remaining - blockDur;
                if (afterThis > 0 && afterThis < minActivityDur) {
                    if (remaining <= effectiveMaxDur) {
                        blockDur = remaining; // take the whole gap
                    } else {
                        // Split evenly
                        blockDur = snapTo5(Math.ceil(remaining / 2));
                        if (blockDur < effectiveMinDur) blockDur = effectiveMinDur;
                    }
                }

                if (blockDur < 5) break; // safety

                const blockEnd = cursor + blockDur;

                // Create per-bunk skeleton block with suggestion tag
                const skelBlock = {
                    id: 'auto_fill_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: eventLabel,
                    division: divName,
                    startTime: fmtTime(cursor),
                    endTime: fmtTime(blockEnd),
                    _autoGenerated: true,
                    _bunk: String(bunk),
                    _durationStrict: true,
                    _targetDuration: blockDur,
                    _suggestedActivity: hintActivity || null
                };
                skeleton.push(skelBlock);

                // Track in bunk state
                const occEntry = {
                    startMin: cursor, endMin: blockEnd,
                    event: eventLabel, type: pickType === 'special' ? 'special_slot' : 'sport_slot'
                };
                state.occupied.push(occEntry);

                const tlEntry = {
                    startMin: cursor, endMin: blockEnd,
                    event: eventLabel, type: pickType === 'special' ? 'special_slot' : 'sport_slot',
                    _autoGenerated: true, _suggestedActivity: hintActivity || null
                };
                bunkTimelines[bunk].push(tlEntry);

                // Track special usage for capacity (even though solver confirms)
                if (hintActivity) {
                    recordSpecialUsage(hintActivity, cursor);
                    usedToday.push(hintActivity);
                }

                if (pickType === 'special') {
                    placedSpecials++;
                    state.specialCount++;
                } else {
                    placedSports++;
                    state.sportCount++;
                }

                // Track for absorb logic
                lastPlacedBlock = {
                    skeletonRef: skelBlock,
                    timelineRef: tlEntry,
                    occupiedRef: occEntry,
                    overrideRef: null,
                    _pickType: pickType,
                    _blockDur: blockDur
                };

                log(`      ${bunk}: ${pickType === 'special' ? (hintActivity || 'Special') : 'Sport'} ${blockDur}min → ${fmtTime(cursor)}-${fmtTime(blockEnd)}`);

                cursor = blockEnd;
            }
        }

        // Warnings
        if (specialReq.min > 0 && placedSpecials < specialReq.min) {
            warnings.push(`${bunk}: Only ${placedSpecials}/${specialReq.min} specials`);
        }
        if (sportReq.min > 0 && placedSports < sportReq.min) {
            warnings.push(`${bunk}: Only ${placedSports}/${sportReq.min} sports`);
        }

        log(`    ${bunk} DONE: ${placedSpecials}S + ${placedSports}Sp`);
    });

    // ═════════════════════════════════════════════════════════════════
    // PHASE 5: VALIDATION
    // ═════════════════════════════════════════════════════════════════

    log(`\n  [Phase 5] Validation`);

    let repairs = 0;

    // Check every bunk has all fixed events
    const requiredFixed = {};
    fixedLayers.forEach(l => {
        const name = l.event || l.type;
        requiredFixed[name] = getLayerDuration(l);
    });

    bunks.forEach(bunk => {
        Object.keys(requiredFixed).forEach(eventName => {
            const has = bunkState[bunk].occupied.some(o =>
                o.event?.toLowerCase() === eventName.toLowerCase()
            );
            if (!has) {
                const range = fixedEventRanges.find(f =>
                    f.event.toLowerCase() === eventName.toLowerCase()
                );
                if (range) {
                    log(`    REPAIR: ${bunk} missing ${eventName} — adding at ${fmtTime(range.startMin)}`);
                    bunkOverrides.push({
                        bunk, division: divName, activity: eventName, type: 'pinned',
                        startTime: fmtTime(range.startMin), endTime: fmtTime(range.endMin),
                        _autoGenerated: true, _repair: true
                    });
                    markBunkOccupied(bunk, range.startMin, range.endMin, eventName, 'fixed');
                    repairs++;
                } else {
                    warn(`${bunk} missing ${eventName} — no reference placement found`);
                }
            }
        });

        // Check for unfilled gaps and create skeleton blocks
        const gaps = findGaps(bunkState[bunk].occupied, divTimes);
        gaps.forEach(gap => {
            const gapDur = gap.endMin - gap.startMin;
            if (gapDur < minActivityDur) return;
            // Check if skeleton already covers this gap
            const covered = skeleton.some(s => {
                if (s.division !== divName) return false;
                if (s._bunk && s._bunk !== String(bunk)) return false;
                const sStart = parseTime(s.startTime);
                const sEnd = parseTime(s.endTime);
                return sStart != null && sEnd != null && sStart < gap.endMin && sEnd > gap.startMin;
            });
            if (!covered) {
                skeleton.push({
                    id: 'auto_repair_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot', event: 'General Activity Slot', division: divName,
                    startTime: fmtTime(gap.startMin), endTime: fmtTime(gap.endMin),
                    _autoGenerated: true, _bunk: String(bunk), _repair: true
                });
                repairs++;
            }
        });
    });

    // Sort all timelines
    Object.values(bunkTimelines).forEach(tl => tl.sort((a, b) => a.startMin - b.startMin));

    log(`  [Phase 5] ${repairs > 0 ? repairs + ' repairs' : 'All good'}`);

    return { skeleton, bunkOverrides, bunkTimelines };
}

// =================================================================
// VALIDATION
// =================================================================

function validate(layers, dateStr) {
    const errors = [];
    if (!layers || layers.length === 0) { errors.push('No layers defined'); return errors; }
    if (!dateStr) { errors.push('No date specified'); return errors; }
    const pinned = layers.filter(l => l.pinned);
    for (let i = 0; i < pinned.length; i++) {
        for (let j = i + 1; j < pinned.length; j++) {
            const a = pinned[i], b = pinned[j];
            if (a.grade !== b.grade) continue;
            const aEnd = a.startMin + (a.duration || 30);
            const bEnd = b.startMin + (b.duration || 30);
            if (a.startMin < bEnd && aEnd > b.startMin) {
                errors.push(`Overlapping pinned: "${a.event}" and "${b.event}"`);
            }
        }
    }
    return errors;
}

// =================================================================
// PUBLIC API
// =================================================================

window.AutoBuildEngine = {
    build,
    validate,
    getSpecialActivities,
    getSpecialDuration,
    getSpecialConfig,
    isScarceSpecial,
    isSpecialAvailableOnDay,
    getRankedSpecials,
    getFields,
    getDivisions,
    getDivisionTimes,
    parseTime,
    fmtTime,
    VERSION
};

log(`Auto Build Engine v${VERSION} loaded`);

})();
