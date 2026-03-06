// =================================================================
// auto_build_engine.js — Campistry Auto Build Engine v4.1.0
// =================================================================
// Converts user-defined LAYERS + special activity config into:
//   1. A skeleton array (per-bunk time structure)
//   2. Bunk overrides (pre-assigned specific activities)
//
// v4.1 — UNIFIED PUZZLE SOLVER
//
// Architecture:
//   Phase 1 (PRE-WORK): Gather all puzzle pieces. Only truly
//     immovable items (pinned events, leagues) are committed.
//     Scarce assignments + fixed events are DEFERRED to Phase 2.
//   Phase 2 (PUZZLE SOLVE): For each bunk, solve entire day at once.
//     Place all constrained items (scarce, fixed) optimally by trying
//     every valid position and scoring the resulting gap structure.
//     Then fill gaps with real activities from rotation wishlist.
//   Phase 3 (VALIDATION): Repair any gaps or missing events.
//
// Key principles:
//   - Suggestion tags (_suggestedActivity), not overrides
//   - Real activity durations from config (Art=20, Drama=30)
//   - Maximize time (use max of layer range, not min)
//   - No dead gaps (every placement checks feasibility)
//   - Constrained pieces sorted tightest-window-first
//
// OUTPUT feeds existing pipeline unchanged:
//   skeleton → DivisionTimesSystem.buildFromSkeleton()
//            → scheduler_core_main.js (bunk overrides at Step 2)
//            → total_solver_engine.js (fills remaining slots)
// =================================================================

(function() {
'use strict';

const VERSION = '4.1.0';
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
    return h + ':' + m.toString().padStart(2, '0') + ap;
}

function snapTo5(min) { return Math.round(min / 5) * 5; }

// =================================================================
// DATA ACCESS HELPERS
// =================================================================

function getGlobalSettings() { return window.loadGlobalSettings?.() || {}; }
function getSpecialActivities() { const g = getGlobalSettings(); return g.app1?.specialActivities || []; }
function getFields() { const g = getGlobalSettings(); return g.app1?.fields || g.fields || []; }
function getDivisions() { return window.divisions || getGlobalSettings().app1?.divisions || {}; }
function getBunksForDivision(divName) { return getDivisions()[divName]?.bunks || []; }

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
    const div = getDivisions()[divName];
    if (!div) return { start: 540, end: 960 };
    return { start: (div.startTime ? parseTime(div.startTime) : 540) || 540, end: (div.endTime ? parseTime(div.endTime) : 960) || 960 };
}

function getSpecialConfig(name) {
    return getSpecialActivities().find(s => s.name?.toLowerCase().trim() === name?.toLowerCase().trim()) || null;
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
    if (typeof avail === 'object' && !Array.isArray(avail)) return avail[dayName] !== false;
    if (Array.isArray(avail)) return avail.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
    return true;
}

function getSpecialTimeWindow(specialConfig) {
    if (!specialConfig) return null;
    const start = specialConfig.availableFrom || specialConfig.windowStart || specialConfig.startTime;
    const end = specialConfig.availableTo || specialConfig.windowEnd || specialConfig.endTime;
    if (start && end) {
        return { startMin: typeof start === 'number' ? start : parseTime(start), endMin: typeof end === 'number' ? end : parseTime(end) };
    }
    if (Array.isArray(specialConfig.timeRules) && specialConfig.timeRules.length > 0) {
        const availableRules = specialConfig.timeRules.filter(r => r.type === 'Available' || !r.type);
        if (availableRules.length > 0) {
            let earliest = Infinity, latest = -Infinity;
            for (const rule of availableRules) {
                const rStart = rule.startMin ?? (rule.start ? parseTime(rule.start) : null);
                const rEnd = rule.endMin ?? (rule.end ? parseTime(rule.end) : null);
                if (rStart != null && rStart < earliest) earliest = rStart;
                if (rEnd != null && rEnd > latest) latest = rEnd;
            }
            if (earliest < Infinity && latest > -Infinity) return { startMin: earliest, endMin: latest };
        }
    }
    return null;
}

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
    if (window.RotationEngine?.calculateFullRotationScore) return window.RotationEngine.calculateFullRotationScore(bunkName, activityName, 0, {});
    if (window.RotationEngine?.calculateRecencyScore) return window.RotationEngine.calculateRecencyScore(bunkName, activityName, 0);
    return 0;
}

function getRankedSpecials(bunkName, availableSpecials) {
    const ranked = availableSpecials.map(name => ({ name, score: getRotationScore(bunkName, name), duration: getSpecialDuration(name) || 30 }));
    ranked.sort((a, b) => a.score - b.score);
    return ranked;
}

// =================================================================
// PLACEMENT HELPERS
// =================================================================

function findGaps(occupied, divTimes) {
    if (occupied.length === 0) return [{ startMin: divTimes.start, endMin: divTimes.end }];
    const sorted = [...occupied].sort((a, b) => a.startMin - b.startMin);
    const gaps = [];
    if (sorted[0].startMin > divTimes.start) gaps.push({ startMin: divTimes.start, endMin: sorted[0].startMin });
    for (let i = 0; i < sorted.length - 1; i++) {
        const gapStart = sorted[i].endMin, gapEnd = sorted[i + 1].startMin;
        if (gapEnd > gapStart + 4) gaps.push({ startMin: gapStart, endMin: gapEnd });
    }
    const lastEnd = sorted[sorted.length - 1].endMin;
    if (lastEnd < divTimes.end) gaps.push({ startMin: lastEnd, endMin: divTimes.end });
    return gaps;
}

function findPerBunkPlacement(bunkOccupied, duration, windowStart, windowEnd, divTimes) {
    for (let start = windowStart; start + duration <= windowEnd; start += 5) {
        const end = start + duration;
        if (!bunkOccupied.some(o => start < o.endMin && end > o.startMin)) return { startMin: start, endMin: end };
    }
    for (let start = windowEnd; start + duration <= divTimes.end; start += 5) {
        const end = start + duration;
        if (!bunkOccupied.some(o => start < o.endMin && end > o.startMin)) return { startMin: start, endMin: end };
    }
    for (let start = divTimes.start; start + duration <= windowStart; start += 5) {
        const end = start + duration;
        if (!bunkOccupied.some(o => start < o.endMin && end > o.startMin)) return { startMin: start, endMin: end };
    }
    return null;
}

function getSharedOccupied(bunkState, bunks) {
    const shared = [], seen = new Set();
    bunks.forEach(bunk => {
        bunkState[bunk].occupied.forEach(occ => {
            const key = occ.startMin + '-' + occ.endMin + '-' + occ.event;
            if (!seen.has(key)) { seen.add(key); shared.push(occ); }
        });
    });
    return shared;
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
    return layer.op || layer.operator || layer.quantity?.op || '>=';
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

function computeRequirements(typeLayers) {
    let minRequired = 0, maxAllowed = Infinity, hasExact = false;
    typeLayers.forEach(layer => {
        const qty = getLayerQty(layer), op = getLayerOp(layer);
        if (op === '=' || op === '==') { minRequired = qty; maxAllowed = qty; hasExact = true; }
        else if (op === '>=' || op === '\u2265') minRequired = Math.max(minRequired, qty);
        else if (op === '<=' || op === '\u2264') maxAllowed = Math.min(maxAllowed, qty);
    });
    return { min: minRequired, max: maxAllowed, hasExact };
}

// =================================================================
// MAIN BUILD FUNCTION
// =================================================================

function build({ layers, dateStr }) {
    log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
    log('AUTO BUILD ENGINE v' + VERSION);
    log('Date: ' + dateStr + ', Layers: ' + layers.length);
    log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');

    const warnings = [];
    const parts = dateStr.split('-').map(Number);
    const dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[dow];
    log('Day: ' + dayName);

    const allSpecials = getSpecialActivities();
    const isRainy = !!window.isRainyDay;
    const todaysSpecials = allSpecials.filter(function(s) {
        if (!isSpecialAvailableOnDay(s, dayName)) return false;
        if (!isRainy && s.rainyDayOnly) return false;
        return true;
    });
    const scarceSpecials = todaysSpecials.filter(function(s) { return isScarceSpecial(s, dayName); });
    const regularSpecials = todaysSpecials.filter(function(s) { return !isScarceSpecial(s, dayName); });

    log('Specials: total=' + allSpecials.length + ' today=' + todaysSpecials.length + ' scarce=' + scarceSpecials.length + ' regular=' + regularSpecials.length);

    // Group layers by grade
    var layersByGrade = {};
    layers.forEach(function(l) {
        var grade = l.grade || l.division || '_all';
        if (!layersByGrade[grade]) layersByGrade[grade] = [];
        layersByGrade[grade].push(Object.assign({}, l));
    });

    var allSkeleton = [], allBunkOverrides = [], bunkTimelines = {};

    // Cross-division scarce capacity tracker
    var globalScarceUsage = {};

    function getGlobalScarceCapacity(cfg) { return parseInt(cfg.sharableWith?.capacity) || parseInt(cfg.capacity) || 1; }
    function getGlobalScarceSlotUsage(name, slotStart) { var e = globalScarceUsage[name + '|' + slotStart]; return e ? e.count : 0; }
    function getGlobalScarceSlotDivision(name, slotStart) { var e = globalScarceUsage[name + '|' + slotStart]; return e ? e.division : null; }
    function recordGlobalScarceUsage(name, slotStart, count, divName) {
        var key = name + '|' + slotStart;
        if (!globalScarceUsage[key]) globalScarceUsage[key] = { count: 0, division: divName };
        globalScarceUsage[key].count += count;
        if (globalScarceUsage[key].division !== divName) globalScarceUsage[key].division = '_mixed';
    }
    function isSlotAvailableForDivision(cfg, slotStart, divName) {
        var entry = globalScarceUsage[cfg.name + '|' + slotStart];
        if (!entry || entry.count === 0) return true;
        var shareType = cfg.sharableWith?.type || 'not_sharable';
        if (shareType === 'not_sharable') return false;
        if (shareType === 'same_division') return entry.division !== '_mixed' && entry.division === divName;
        if (shareType === 'custom') return (cfg.sharableWith?.divisions || []).includes(divName);
        return true;
    }
    function getRemainingGlobalScarceSlots(cfg, forDiv) {
        var name = cfg.name, dur = cfg.defaultDuration || cfg.duration || 30;
        var tw = getSpecialTimeWindow(cfg);
        if (!tw) return 0;
        var cap = getGlobalScarceCapacity(cfg), remaining = 0;
        for (var c = tw.startMin; c + dur <= tw.endMin; c += dur) {
            if (forDiv && !isSlotAvailableForDivision(cfg, c, forDiv)) continue;
            remaining += Math.max(0, cap - getGlobalScarceSlotUsage(name, c));
        }
        return remaining;
    }

    var globalScarceAPI = {
        getUsage: getGlobalScarceSlotUsage, getDivision: getGlobalScarceSlotDivision,
        record: recordGlobalScarceUsage, getRemaining: getRemainingGlobalScarceSlots,
        getCapacity: getGlobalScarceCapacity, isSlotAvailableForDiv: isSlotAvailableForDivision
    };

    var baseLayersForAll = layersByGrade['_all'] || [];
    delete layersByGrade['_all'];
    var divisions = getDivisions();
    var gradesToProcess = Object.keys(layersByGrade).length > 0 ? Object.keys(layersByGrade) : Object.keys(divisions);

    for (var gi = 0; gi < gradesToProcess.length; gi++) {
        var gradeName = gradesToProcess[gi];
        var gradeLayers = baseLayersForAll.concat(layersByGrade[gradeName] || []);
        if (gradeLayers.length === 0) { warn('No layers for ' + gradeName); continue; }
        var divName = getDivisionForGrade(gradeName);
        var bunks = getBunksForDivision(divName);
        var divTimes = getDivisionTimes(divName);
        if (bunks.length === 0) { warn('No bunks for ' + divName); continue; }
        log('\nProcessing ' + gradeName + ' (div: ' + divName + ', ' + bunks.length + ' bunks, ' + gradeLayers.length + ' layers)');
        var result = buildForGrade({
            gradeName: gradeName, divName: divName, bunks: bunks, layers: gradeLayers,
            dayName: dayName, dateStr: dateStr, divTimes: divTimes,
            scarceSpecials: scarceSpecials, regularSpecials: regularSpecials,
            todaysSpecials: todaysSpecials, warnings: warnings, globalScarceUsage: globalScarceAPI
        });
        allSkeleton = allSkeleton.concat(result.skeleton);
        allBunkOverrides = allBunkOverrides.concat(result.bunkOverrides);
        Object.assign(bunkTimelines, result.bunkTimelines);
    }

    log('\nBUILD COMPLETE: ' + allSkeleton.length + ' skeleton, ' + allBunkOverrides.length + ' overrides');
    return { skeleton: allSkeleton, bunkOverrides: allBunkOverrides, bunkTimelines: bunkTimelines, warnings: warnings, _autoGenerated: true, _buildDate: dateStr, _buildVersion: VERSION };
}

// =================================================================
// BUILD FOR GRADE — v4.1 Unified Puzzle Solver
// =================================================================

function buildForGrade(params) {
    var gradeName = params.gradeName, divName = params.divName, bunks = params.bunks;
    var layers = params.layers, dayName = params.dayName, divTimes = params.divTimes;
    var scarceSpecials = params.scarceSpecials, regularSpecials = params.regularSpecials;
    var warnings = params.warnings, globalScarceUsage = params.globalScarceUsage;

    var skeleton = [], bunkOverrides = [], bunkTimelines = {};

    var divScarce = scarceSpecials.filter(function(s) { return isSpecialAvailableForDivision(s.name, divName); });
    var divRegular = regularSpecials.filter(function(s) { return isSpecialAvailableForDivision(s.name, divName); });
    log('  [Div] ' + divName + ': ' + divRegular.length + ' regular, ' + divScarce.length + ' scarce specials');

    var bunkState = {};
    bunks.forEach(function(bunk) {
        bunkState[bunk] = { occupied: [], specialCount: 0, sportCount: 0, usedActivities: [] };
        bunkTimelines[bunk] = [];
    });

    // CLASSIFY LAYERS
    var pinnedLayers = [], fixedLayers = [], leagueLayers = [], specialtyLeagueLayers = [];
    var specialLayers = [], sportLayers = [], customLayers = [];

    layers.forEach(function(layer, idx) {
        layer._idx = idx;
        var lType = (layer.type || '').toLowerCase();
        if (['lunch', 'snack', 'snacks', 'dismissal'].indexOf(lType) >= 0) fixedLayers.push(layer);
        else if (lType === 'league') leagueLayers.push(layer);
        else if (lType === 'specialty_league') specialtyLeagueLayers.push(layer);
        else if (window.CustomPersistentTiles?.isCustomType?.(lType)) pinnedLayers.push(layer);
        else if (isLayerPinned(layer)) pinnedLayers.push(layer);
        else if (lType === 'special') specialLayers.push(layer);
        else if (lType === 'sport' || lType === 'sports') sportLayers.push(layer);
        else customLayers.push(layer);
    });

    var specialReq = computeRequirements(specialLayers);
    var sportReq = computeRequirements(sportLayers);
    var specialDur = specialLayers.length > 0 ? getLayerDuration(specialLayers[0]) : 30;
    var specialDurMax = specialLayers.length > 0 ? getLayerDurationMax(specialLayers[0]) : specialDur;
    var sportDurMin = sportLayers.length > 0 ? getLayerDuration(sportLayers[0]) : 30;
    var sportDurMax = sportLayers.length > 0 ? getLayerDurationMax(sportLayers[0]) : sportDurMin;
    var minActivityDur = Math.min(sportDurMin, specialDur, 20);

    log('  Reqs: Special min=' + specialReq.min + ' max=' + specialReq.max + ' | Sport min=' + sportReq.min + ' max=' + sportReq.max);
    log('  Durs: Special ' + specialDur + '-' + specialDurMax + ' | Sport ' + sportDurMin + '-' + sportDurMax + ' | minAct=' + minActivityDur);
    // Diagnostic: show raw layer duration fields
    if (sportLayers.length > 0) {
        var sl = sportLayers[0];
        log('  [DIAG] Sport layer[0] raw: durationMin=' + sl.durationMin + ' durationMax=' + sl.durationMax + ' periodMin=' + sl.periodMin + ' duration=' + sl.duration);
    }
    if (specialLayers.length > 0) {
        var spl = specialLayers[0];
        log('  [DIAG] Special layer[0] raw: durationMin=' + spl.durationMin + ' durationMax=' + spl.durationMax + ' periodMin=' + spl.periodMin + ' duration=' + spl.duration);
    }

    function markBunkOccupied(bunk, startMin, endMin, event, type) {
        bunkState[bunk].occupied.push({ startMin: startMin, endMin: endMin, event: event, type: type });
        bunkTimelines[bunk].push({ startMin: startMin, endMin: endMin, event: event, type: type, _autoGenerated: true });
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 1: PRE-WORK — Gather pieces, commit only immovables
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 1] Pre-work');

    // 1a: IMMOVABLE PINNED (swim, custom tiles — exact time, all bunks)
    pinnedLayers.forEach(function(layer) {
        var startMin = layer.startMin;
        var endMin = layer.startMin + (getLayerDuration(layer) || (layer.endMin - layer.startMin));
        var eventName = layer.event || layer.type;
        var lType = (layer.type || '').toLowerCase();

        skeleton.push({
            id: 'auto_pinned_' + Math.random().toString(36).slice(2, 9),
            type: 'pinned', event: eventName, division: divName,
            startTime: fmtTime(startMin), endTime: fmtTime(endMin),
            pinned: true, _autoGenerated: true
        });

        var changeDur = 0;
        if (lType === 'swim') {
            var gs = getGlobalSettings();
            changeDur = parseInt(gs.app1?.changeBufferDuration) || parseInt(gs.changeBufferDuration) || 10;
        } else if (window.CustomPersistentTiles?.getChangeDuration) {
            changeDur = window.CustomPersistentTiles.getChangeDuration(lType) || 0;
        }

        bunks.forEach(function(bunk) {
            markBunkOccupied(bunk, startMin, endMin, eventName, 'pinned');
            if (changeDur > 0 && endMin + changeDur <= divTimes.end) {
                markBunkOccupied(bunk, endMin, endMin + changeDur, 'Change', 'change_buffer');
                skeleton.push({ id: 'auto_change_' + Math.random().toString(36).slice(2, 9), type: 'pinned', event: 'Change', division: divName, startTime: fmtTime(endMin), endTime: fmtTime(endMin + changeDur), pinned: true, _autoGenerated: true, _bunk: String(bunk), _changeFor: eventName });
            }
            if (changeDur > 0 && startMin - changeDur >= divTimes.start) {
                var pStart = startMin - changeDur;
                if (!bunkState[bunk].occupied.some(function(o) { return pStart < o.endMin && startMin > o.startMin; })) {
                    markBunkOccupied(bunk, pStart, startMin, 'Change', 'change_buffer');
                    skeleton.push({ id: 'auto_prechange_' + Math.random().toString(36).slice(2, 9), type: 'pinned', event: 'Change', division: divName, startTime: fmtTime(pStart), endTime: fmtTime(startMin), pinned: true, _autoGenerated: true, _bunk: String(bunk), _changeFor: eventName });
                }
            }
        });
        log('    Pinned: ' + eventName + ' ' + fmtTime(startMin) + '-' + fmtTime(endMin) + (changeDur > 0 ? ' (+' + changeDur + 'min change)' : ''));
    });

    // 1b: SCARCE ASSIGNMENTS — which bunks get which scarce, time TBD
    var scarceAssignments = {};
    bunks.forEach(function(b) { scarceAssignments[b] = []; });

    divScarce.forEach(function(cfg) {
        var name = cfg.name, dur = cfg.defaultDuration || cfg.duration || 30;
        var tw = getSpecialTimeWindow(cfg);
        if (!tw) { warn('Scarce "' + name + '" no time window'); return; }
        var cap = parseInt(cfg.sharableWith?.capacity) || parseInt(cfg.capacity) || 1;
        if (globalScarceUsage) {
            var rem = globalScarceUsage.getRemaining(cfg, divName);
            if (rem <= 0) { log('    ' + name + ': globally exhausted'); return; }
        }
        var ranked = bunks.map(function(b) { return { bunk: b, score: getRotationScore(b, name) }; }).sort(function(a, b) { return a.score - b.score; });
        var slots = Math.floor((tw.endMin - tw.startMin) / dur);
        var totalCap = slots * cap;
        var gUsed = 0;
        if (globalScarceUsage) { for (var c = tw.startMin; c + dur <= tw.endMin; c += dur) gUsed += globalScarceUsage.getUsage(name, c); }
        var toServe = Math.min(ranked.length, Math.max(0, totalCap - gUsed));
        if (toServe <= 0) { log('    ' + name + ': no capacity'); return; }
        for (var i = 0; i < toServe; i++) {
            scarceAssignments[ranked[i].bunk].push({ name: name, duration: dur, windowStart: tw.startMin, windowEnd: tw.endMin, capacity: cap, config: cfg });
        }
        log('    ' + name + ': assigned to ' + toServe + ' bunks (time TBD)');
    });

    // 1c: FIXED EVENT PIECES — store window info, don't place
    var fixedEventPieces = [];
    fixedLayers.forEach(function(layer) {
        var dur = getLayerDuration(layer), wStart = layer.startMin, wEnd = layer.endMin || (wStart + dur);
        var evName = layer.event || layer.type, isPinned = (wEnd - wStart) <= dur;
        fixedEventPieces.push({ eventName: evName, duration: dur, windowStart: wStart, windowEnd: wEnd, isPinned: isPinned });
        log('    Fixed: ' + evName + ' ' + fmtTime(wStart) + '-' + fmtTime(wEnd) + ' ' + dur + 'min ' + (isPinned ? '(exact)' : '(flexible)'));
    });

    // 1d: LEAGUES — division-wide, commit now (must be same for all bunks)
    var fixedEventRanges = [];
    var allLeagues = leagueLayers.concat(specialtyLeagueLayers);
    allLeagues.forEach(function(layer, idx) {
        var isSp = (layer.type || '').toLowerCase() === 'specialty_league';
        var dur = getLayerDuration(layer), wStart = layer.startMin, wEnd = layer.endMin || (wStart + dur);
        var qty = getLayerQty(layer), evName = isSp ? 'Specialty League' : 'League Game';
        var lType = isSp ? 'specialty_league' : 'league';

        for (var i = 0; i < Math.max(qty, 1); i++) {
            var sharedOcc = getSharedOccupied(bunkState, bunks);
            var bestP = null, bestS = Infinity;
            for (var ts = wStart; ts + dur <= wEnd; ts += 5) {
                var te = ts + dur;
                if (sharedOcc.some(function(o) { return ts < o.endMin && te > o.startMin; })) continue;
                var dgs = 0;
                bunks.forEach(function(bunk) {
                    var testOcc = bunkState[bunk].occupied.concat([{ startMin: ts, endMin: te }]);
                    findGaps(testOcc, divTimes).forEach(function(g) {
                        var gd = g.endMin - g.startMin;
                        if (gd >= 5 && gd < minActivityDur) dgs += (minActivityDur - gd) * 10;
                    });
                });
                if (dgs < bestS) { bestS = dgs; bestP = { startMin: ts, endMin: te }; }
                if (dgs === 0) break;
            }
            if (!bestP) { bestP = { startMin: wStart, endMin: wStart + dur }; }
            skeleton.push({ id: 'auto_league_' + Math.random().toString(36).slice(2, 9), type: lType, event: evName, division: divName, startTime: fmtTime(bestP.startMin), endTime: fmtTime(bestP.endMin), _autoGenerated: true });
            bunks.forEach(function(bunk) { markBunkOccupied(bunk, bestP.startMin, bestP.endMin, evName, lType); });
            log('    League: ' + evName + ' ' + fmtTime(bestP.startMin) + '-' + fmtTime(bestP.endMin));
        }
    });

    log('  [Phase 1] Done. Deferred: ' + fixedEventPieces.length + ' fixed, ' + Object.values(scarceAssignments).reduce(function(s, a) { return s + a.length; }, 0) + ' scarce');

    // ═══════════════════════════════════════════════════════
    // PHASE 2: PER-BUNK PUZZLE SOLVER
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 2] Per-bunk puzzle solver');

    var specialSlotUsage = {};
    function getSpecialCap(name) {
        var cfg = getSpecialConfig(name);
        if (!cfg) return 2;
        if (cfg.sharableWith) {
            if (cfg.sharableWith.capacity !== undefined) { var c = parseInt(cfg.sharableWith.capacity); if (!isNaN(c) && c > 0) return c; }
            if (cfg.sharableWith.type === 'not_sharable') return 1;
        }
        return parseInt(cfg.capacity) || parseInt(cfg.maxBunks) || 2;
    }
    function isSpecialAtCapacity(name, slotStart) { return (specialSlotUsage[name + '|' + slotStart] || 0) >= getSpecialCap(name); }
    function recordSpecialUsage(name, slotStart) { var k = name + '|' + slotStart; specialSlotUsage[k] = (specialSlotUsage[k] || 0) + 1; }

    // Scoring: given occupied blocks, how well can remaining layers fit?
    function scoreArrangement(occupied, specCount, sportCount) {
        var gaps = findGaps(occupied, divTimes), score = 0, usable = 0;
        for (var i = 0; i < gaps.length; i++) {
            var gd = gaps[i].endMin - gaps[i].startMin;
            if (gd >= 5 && gd < minActivityDur) score += 10000;
            if (gd >= minActivityDur) {
                usable += gd;
                var lo = gd % minActivityDur;
                if (lo > 0 && lo < 15) score += lo * 5;
            }
        }
        var needed = Math.max(0, specialReq.min - specCount) * specialDur + Math.max(0, sportReq.min - sportCount) * sportDurMin;
        if (usable < needed) score += (needed - usable) * 100;
        return score;
    }

    bunks.forEach(function(bunk) {
        var state = bunkState[bunk], bunkStr = String(bunk);
        log('    ' + bunk + ': Puzzle solving...');

        // ── STEP A: Place CONSTRAINED pieces (scarce + fixed) ──
        var constrained = [];
        (scarceAssignments[bunk] || []).forEach(function(s) {
            constrained.push({ eventName: s.name, duration: s.duration, windowStart: s.windowStart, windowEnd: s.windowEnd, isPinned: false, isScarce: true, type: 'scarce_special', config: s.config });
        });
        fixedEventPieces.forEach(function(f) {
            constrained.push({ eventName: f.eventName, duration: f.duration, windowStart: f.windowStart, windowEnd: f.windowEnd, isPinned: f.isPinned, isScarce: false, type: 'fixed', config: null });
        });

        // Sort: pinned first, then tightest window
        constrained.sort(function(a, b) {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            return (a.windowEnd - a.windowStart - a.duration) - (b.windowEnd - b.windowStart - b.duration);
        });

        var bunkSpecCount = state.specialCount;

        for (var ci = 0; ci < constrained.length; ci++) {
            var piece = constrained[ci];

            if (piece.isPinned) {
                var pStart = piece.windowStart, pEnd = pStart + piece.duration;
                var conflict = state.occupied.some(function(o) { return pStart < o.endMin && pEnd > o.startMin; });
                var placement = conflict ? findPerBunkPlacement(state.occupied, piece.duration, piece.windowStart, piece.windowEnd, divTimes) : { startMin: pStart, endMin: pEnd };
                if (placement) {
                    markBunkOccupied(bunk, placement.startMin, placement.endMin, piece.eventName, piece.type);
                    if (piece.type === 'fixed') {
                        skeleton.push({ id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9), type: 'pinned', event: piece.eventName, division: divName, startTime: fmtTime(placement.startMin), endTime: fmtTime(placement.endMin), pinned: true, _autoGenerated: true, _bunk: bunkStr });
                        bunkOverrides.push({ bunk: bunk, division: divName, activity: piece.eventName, type: 'pinned', startTime: fmtTime(placement.startMin), endTime: fmtTime(placement.endMin), _autoGenerated: true, _fixedEvent: true });
                    }
                    if (piece.isScarce) { bunkSpecCount++; state.specialCount++; }
                    log('        ' + piece.eventName + ': pinned at ' + fmtTime(placement.startMin));
                } else {
                    warn(bunk + ': Could not place ' + piece.eventName);
                    warnings.push(bunk + ': ' + piece.eventName + ' could not be placed');
                }
                continue;
            }

            // WINDOWED: try every valid position, pick best score
            var bestPos = null, bestScore = Infinity;
            for (var ts = piece.windowStart; ts + piece.duration <= piece.windowEnd; ts += 5) {
                var te = ts + piece.duration;
                if (state.occupied.some(function(o) { return ts < o.endMin && te > o.startMin; })) continue;
                var testOcc = state.occupied.concat([{ startMin: ts, endMin: te, event: piece.eventName, type: piece.type }]);
                var sc = scoreArrangement(testOcc, bunkSpecCount + (piece.isScarce ? 1 : 0), state.sportCount);
                if (sc < bestScore) { bestScore = sc; bestPos = { startMin: ts, endMin: te }; }
                if (sc === 0) break;
            }

            if (!bestPos) bestPos = findPerBunkPlacement(state.occupied, piece.duration, piece.windowStart, piece.windowEnd, divTimes);

            if (bestPos) {
                markBunkOccupied(bunk, bestPos.startMin, bestPos.endMin, piece.eventName, piece.type);
                if (piece.isScarce) {
                    skeleton.push({ id: 'auto_scarce_' + Math.random().toString(36).slice(2, 9), type: 'slot', event: 'Special Activity', division: divName, startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), _autoGenerated: true, _bunk: bunkStr, _suggestedActivity: piece.eventName, _scarce: true, _durationStrict: true, _targetDuration: piece.duration });
                    state.usedActivities.push(piece.eventName);
                    bunkSpecCount++; state.specialCount++;
                    if (globalScarceUsage && piece.config) {
                        var slotS = Math.floor((bestPos.startMin - piece.windowStart) / piece.duration) * piece.duration + piece.windowStart;
                        globalScarceUsage.record(piece.eventName, slotS, 1, divName);
                    }
                } else {
                    skeleton.push({ id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9), type: 'pinned', event: piece.eventName, division: divName, startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), pinned: true, _autoGenerated: true, _bunk: bunkStr });
                    bunkOverrides.push({ bunk: bunk, division: divName, activity: piece.eventName, type: 'pinned', startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), _autoGenerated: true, _fixedEvent: true });
                }
                log('        ' + piece.eventName + ': ' + fmtTime(bestPos.startMin) + '-' + fmtTime(bestPos.endMin) + ' (score:' + bestScore + ')');
            } else {
                warn(bunk + ': Could not place ' + piece.eventName);
                warnings.push(bunk + ': ' + piece.eventName + ' could not be placed');
            }
        }

        // Track fixed ranges for Phase 3 validation
        fixedEventPieces.forEach(function(f) {
            var occ = state.occupied.find(function(o) { return o.event && o.event.toLowerCase() === f.eventName.toLowerCase() && o.type === 'fixed'; });
            if (occ) fixedEventRanges.push({ startMin: occ.startMin, endMin: occ.endMin, event: f.eventName, bunk: bunk });
        });

        // ── STEP B: Build activity wishlist from rotation ──
        var usedToday = state.usedActivities.slice();
        var placedSpecials = bunkSpecCount;
        var placedSports = state.sportCount;

        function buildWishlist(cursorTime) {
            var available = divRegular.map(function(s) { return s.name; })
                .filter(function(n) {
                    // Not already used today by this bunk
                    if (usedToday.some(function(u) { return u.toLowerCase() === n.toLowerCase(); })) return false;
                    // Not at capacity
                    if (isSpecialAtCapacity(n, cursorTime)) return false;
                    // Not a scarce special (those are handled in Step A)
                    var cfg = getSpecialConfig(n);
                    if (cfg && isScarceSpecial(cfg, dayName)) return false;
                    // Time window check
                    var tw = cfg ? getSpecialTimeWindow(cfg) : null;
                    if (tw) {
                        if (cursorTime < tw.startMin || cursorTime >= tw.endMin) return false;
                        var actDur = cfg.defaultDuration || cfg.duration || specialDur;
                        if (cursorTime + actDur > tw.endMin) return false;
                    }
                    return true;
                });
            return getRankedSpecials(bunk, available);
        }

        // ── STEP C: Fill gaps with real activity durations ──
        var gaps = findGaps(state.occupied, divTimes);
        log('      ' + bunk + ': ' + gaps.length + ' gaps, needs ' + Math.max(0, specialReq.min - placedSpecials) + 'S + ' + Math.max(0, sportReq.min - placedSports) + 'Sp');

        for (var gi = 0; gi < gaps.length; gi++) {
            var gap = gaps[gi];
            var gapDur = gap.endMin - gap.startMin;
            if (gapDur < 15) continue;

            var cursor = gap.startMin;

            while (cursor < gap.endMin) {
                var remaining = gap.endMin - cursor;
                if (remaining < minActivityDur) break; // runt — Step D handles

                var specNeeded = Math.max(0, specialReq.min - placedSpecials);
                var sprtNeeded = Math.max(0, sportReq.min - placedSports);
                var specMaxed = specialReq.max !== Infinity && placedSpecials >= specialReq.max;
                var sprtMaxed = sportReq.max !== Infinity && placedSports >= sportReq.max;

                // Decide: special or sport?
                var useSpecial = false;
                if (specNeeded > 0 && !specMaxed) useSpecial = true;
                else if (sprtNeeded > 0 && !sprtMaxed) useSpecial = false;
                else if (!specMaxed && specNeeded >= sprtNeeded) useSpecial = true;

                var blockDur = 0, blockType = 'sport', hintActivity = null;

                if (useSpecial) {
                    var wishlist = buildWishlist(cursor);
                    if (wishlist.length > 0) {
                        // Try the most overdue special first
                        var picked = null;
                        for (var wi = 0; wi < wishlist.length; wi++) {
                            var w = wishlist[wi];
                            var actDur = w.duration || specialDur;
                            // Does this duration fit within the layer's range?
                            if (actDur <= remaining) {
                                // Activity fits in remaining gap
                                if (actDur >= specialDur && actDur <= specialDurMax) {
                                    // Within layer range — perfect
                                    picked = { name: w.name, dur: actDur };
                                } else {
                                    // Outside layer range but has a configured duration — use it
                                    // (configured duration takes priority over layer range)
                                    picked = { name: w.name, dur: actDur };
                                }
                                break;
                            }
                        }
                        if (picked) {
                            blockDur = picked.dur;
                            blockType = 'special';
                            hintActivity = picked.name;
                        } else {
                            // No special fits in remaining gap — fall through to sport
                            useSpecial = false;
                        }
                    } else {
                        useSpecial = false;
                    }
                }

                if (!useSpecial || blockDur === 0) {
                    // Sport: use MAX of layer range (maximize time), capped by remaining
                    // But NEVER exceed the layer's configured max
                    blockDur = Math.min(sportDurMax, remaining);
                    if (blockDur < sportDurMin && remaining >= sportDurMin) blockDur = sportDurMin;
                    blockType = 'sport';
                    hintActivity = null;
                }

                // HARD CAP: block must never exceed the layer's duration range
                var layerMax = blockType === 'special' ? specialDurMax : sportDurMax;
                var layerMin = blockType === 'special' ? specialDur : sportDurMin;
                if (blockDur > layerMax) blockDur = layerMax;

                // Anti-runt: if leftover after this block can't fit any activity, absorb it
                // BUT only up to the layer's max duration
                var afterThis = remaining - blockDur;
                if (afterThis > 0 && afterThis < minActivityDur) {
                    if (remaining <= layerMax) {
                        blockDur = remaining; // absorb runt — still within layer max
                    } else {
                        // Can't absorb without exceeding layer max — split instead
                        // Split into N blocks that fit within [layerMin, layerMax]
                        var numBlocks = Math.ceil(remaining / layerMax);
                        blockDur = Math.min(Math.ceil(remaining / numBlocks), layerMax);
                        blockDur = Math.max(blockDur, layerMin);
                    }
                }

                // Final hard cap (defense)
                if (blockDur > layerMax) blockDur = layerMax;

                // Snap to 5-min
                var snapped = snapTo5(cursor + blockDur);
                if (snapped > cursor && snapped <= gap.endMin) blockDur = snapped - cursor;

                if (blockDur < 15) break;

                var blockStart = cursor, blockEnd = cursor + blockDur;
                var eventLabel = blockType === 'special' ? 'Special Activity' : 'Sports Slot';

                skeleton.push({
                    id: 'auto_fill_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot', event: eventLabel, division: divName,
                    startTime: fmtTime(blockStart), endTime: fmtTime(blockEnd),
                    _autoGenerated: true, _bunk: bunkStr,
                    _durationStrict: blockType === 'special' && hintActivity ? true : false,
                    _targetDuration: blockDur,
                    _suggestedActivity: hintActivity
                });
                state.occupied.push({ startMin: blockStart, endMin: blockEnd, event: eventLabel, type: blockType === 'special' ? 'special_slot' : 'sport_slot' });
                bunkTimelines[bunk].push({ startMin: blockStart, endMin: blockEnd, event: eventLabel, type: blockType === 'special' ? 'special_slot' : 'sport_slot', _autoGenerated: true, _suggestedActivity: hintActivity });

                if (hintActivity) {
                    recordSpecialUsage(hintActivity, blockStart);
                    usedToday.push(hintActivity);
                }
                if (blockType === 'special') { placedSpecials++; state.specialCount++; }
                else { placedSports++; state.sportCount++; }

                log('      ' + bunk + ': ' + (hintActivity || blockType) + ' ' + blockDur + 'min ' + fmtTime(blockStart) + '-' + fmtTime(blockEnd));
                cursor = blockEnd;
            }

            // ── STEP D: Dead gap repair for this gap's tail ──
            if (cursor < gap.endMin) {
                var runtDur = gap.endMin - cursor;
                if (runtDur >= 5 && runtDur < minActivityDur) {
                    // Try extending the last placed block
                    var lastBlocks = skeleton.filter(function(s) { return s._bunk === bunkStr && parseTime(s.endTime) === cursor; });
                    if (lastBlocks.length > 0) {
                        var ext = lastBlocks[lastBlocks.length - 1];
                        var extStart = parseTime(ext.startTime);
                        var newDur = gap.endMin - extStart;
                        var extMax = ext.event === 'Special Activity' ? specialDurMax : sportDurMax;

                        if (newDur <= extMax) {
                            ext.endTime = fmtTime(gap.endMin);
                            ext._targetDuration = newDur;
                            var occM = state.occupied.find(function(o) { return o.endMin === cursor && o.startMin === extStart; });
                            if (occM) occM.endMin = gap.endMin;
                            var tlM = bunkTimelines[bunk].find(function(t) { return t.endMin === cursor && t.startMin === extStart; });
                            if (tlM) tlM.endMin = gap.endMin;
                            log('      ' + bunk + ': Extended block to absorb ' + runtDur + 'min runt');
                        } else {
                            // Try shifting adjacent windowed fixed event
                            var absorbed = false;
                            for (var fi = 0; fi < windowedFixedEvents.length && !absorbed; fi++) {
                                var fm = windowedFixedEvents[fi];
                                var fixOcc = state.occupied.find(function(o) {
                                    return o.event && o.event.toLowerCase() === fm.eventName.toLowerCase() && o.type === 'fixed';
                                });
                                if (!fixOcc) continue;
                                // Adjacent?
                                if (fixOcc.startMin !== gap.endMin && fixOcc.endMin !== cursor) continue;
                                var shiftAmt = fixOcc.startMin === gap.endMin ? runtDur : -runtDur;
                                var nfs = fixOcc.startMin + shiftAmt, nfe = fixOcc.endMin + shiftAmt;
                                if (nfs < fm.windowStart || nfe > fm.windowEnd) continue;
                                var others = state.occupied.filter(function(o) { return o !== fixOcc; });
                                if (others.some(function(o) { return nfs < o.endMin && nfe > o.startMin; })) continue;
                                // Shift it
                                var oldFs = fixOcc.startMin;
                                fixOcc.startMin = nfs; fixOcc.endMin = nfe;
                                // Update skeleton
                                var fSk = skeleton.find(function(s) { return s.event && s.event.toLowerCase() === fm.eventName.toLowerCase() && s._bunk === bunkStr; });
                                if (fSk) { fSk.startTime = fmtTime(nfs); fSk.endTime = fmtTime(nfe); }
                                // Update override
                                var fOv = bunkOverrides.find(function(o) { return o.activity && o.activity.toLowerCase() === fm.eventName.toLowerCase() && String(o.bunk) === bunkStr; });
                                if (fOv) { fOv.startTime = fmtTime(nfs); fOv.endTime = fmtTime(nfe); }
                                // Update timeline
                                var fTl = bunkTimelines[bunk].find(function(t) { return t.event && t.event.toLowerCase() === fm.eventName.toLowerCase() && t.startMin === oldFs; });
                                if (fTl) { fTl.startMin = nfs; fTl.endMin = nfe; }
                                // Now extend last activity block
                                ext.endTime = fmtTime(gap.endMin);
                                ext._targetDuration = gap.endMin - extStart;
                                if (occM) occM.endMin = gap.endMin;
                                if (tlM) tlM.endMin = gap.endMin;
                                absorbed = true;
                                log('      ' + bunk + ': Shifted ' + fm.eventName + ' by ' + shiftAmt + 'min to absorb runt');
                            }
                            if (!absorbed && runtDur >= 15) {
                                skeleton.push({
                                    id: 'auto_runt_' + Math.random().toString(36).slice(2, 9),
                                    type: 'slot', event: 'Sports Slot', division: divName,
                                    startTime: fmtTime(cursor), endTime: fmtTime(gap.endMin),
                                    _autoGenerated: true, _bunk: bunkStr, _runt: true,
                                    _durationStrict: false, _targetDuration: runtDur
                                });
                                state.occupied.push({ startMin: cursor, endMin: gap.endMin, event: 'Sports Slot', type: 'runt_slot' });
                                bunkTimelines[bunk].push({ startMin: cursor, endMin: gap.endMin, event: 'Sports Slot', type: 'runt_slot', _autoGenerated: true });
                                log('      ' + bunk + ': Runt ' + runtDur + 'min as short filler');
                            }
                        }
                    }
                }
            }
        }

        // Bunk summary + warnings
        if (specialReq.min > 0 && placedSpecials < specialReq.min) warnings.push(bunk + ': Only ' + placedSpecials + '/' + specialReq.min + ' specials');
        if (sportReq.min > 0 && placedSports < sportReq.min) warnings.push(bunk + ': Only ' + placedSports + '/' + sportReq.min + ' sports');
        log('    ' + bunk + ' DONE: ' + placedSpecials + 'S + ' + placedSports + 'Sp');
    });

    // ═══════════════════════════════════════════════════════
    // PHASE 3: VALIDATION
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 3] Validation');

    var repairs = 0;
    var requiredFixed = {};
    fixedLayers.forEach(function(l) { requiredFixed[l.event || l.type] = getLayerDuration(l); });

    bunks.forEach(function(bunk) {
        var bunkStr = String(bunk);

        // Check all fixed events present
        Object.keys(requiredFixed).forEach(function(evName) {
            var has = bunkState[bunk].occupied.some(function(o) { return o.event && o.event.toLowerCase() === evName.toLowerCase(); });
            if (!has) {
                var ref = fixedEventRanges.find(function(f) { return f.event.toLowerCase() === evName.toLowerCase(); });
                if (ref) {
                    log('    REPAIR: ' + bunk + ' missing ' + evName + ' — adding at ' + fmtTime(ref.startMin));
                    bunkOverrides.push({ bunk: bunk, division: divName, activity: evName, type: 'pinned', startTime: fmtTime(ref.startMin), endTime: fmtTime(ref.endMin), _autoGenerated: true, _repair: true });
                    markBunkOccupied(bunk, ref.startMin, ref.endMin, evName, 'fixed');
                    repairs++;
                } else {
                    warn(bunk + ' missing ' + evName + ' — no reference found');
                }
            }
        });

        // Fill any remaining gaps with generic slots
        var finalGaps = findGaps(bunkState[bunk].occupied, divTimes);
        finalGaps.forEach(function(gap) {
            var gd = gap.endMin - gap.startMin;
            if (gd < minActivityDur) return;
            var covered = skeleton.some(function(s) {
                if (s.division !== divName) return false;
                if (s._bunk && s._bunk !== bunkStr) return false;
                var ss = parseTime(s.startTime), se = parseTime(s.endTime);
                return ss != null && se != null && ss < gap.endMin && se > gap.startMin;
            });
            if (!covered) {
                skeleton.push({
                    id: 'auto_repair_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot', event: 'General Activity Slot', division: divName,
                    startTime: fmtTime(gap.startMin), endTime: fmtTime(gap.endMin),
                    _autoGenerated: true, _bunk: bunkStr, _repair: true
                });
                repairs++;
            }
        });
    });

    // Sort timelines
    Object.values(bunkTimelines).forEach(function(tl) { tl.sort(function(a, b) { return a.startMin - b.startMin; }); });

    log('  [Phase 3] ' + (repairs > 0 ? repairs + ' repairs' : 'All good'));
    return { skeleton: skeleton, bunkOverrides: bunkOverrides, bunkTimelines: bunkTimelines };
}

// =================================================================
// VALIDATION
// =================================================================

function validate(layers, dateStr) {
    var errors = [];
    if (!layers || layers.length === 0) { errors.push('No layers defined'); return errors; }
    if (!dateStr) { errors.push('No date specified'); return errors; }
    var pinned = layers.filter(function(l) { return l.pinned; });
    for (var i = 0; i < pinned.length; i++) {
        for (var j = i + 1; j < pinned.length; j++) {
            var a = pinned[i], b = pinned[j];
            if (a.grade !== b.grade) continue;
            var aEnd = a.startMin + (a.duration || 30);
            var bEnd = b.startMin + (b.duration || 30);
            if (a.startMin < bEnd && aEnd > b.startMin) {
                errors.push('Overlapping pinned: "' + a.event + '" and "' + b.event + '"');
            }
        }
    }
    return errors;
}

// =================================================================
// PUBLIC API
// =================================================================

window.AutoBuildEngine = {
    build: build,
    validate: validate,
    getSpecialActivities: getSpecialActivities,
    getSpecialDuration: getSpecialDuration,
    getSpecialConfig: getSpecialConfig,
    isScarceSpecial: isScarceSpecial,
    isSpecialAvailableOnDay: isSpecialAvailableOnDay,
    getRankedSpecials: getRankedSpecials,
    getFields: getFields,
    getDivisions: getDivisions,
    getDivisionTimes: getDivisionTimes,
    parseTime: parseTime,
    fmtTime: fmtTime,
    VERSION: VERSION
};

log('Auto Build Engine v' + VERSION + ' loaded');

})();
