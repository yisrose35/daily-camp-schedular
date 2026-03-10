// =================================================================
// auto_build_engine.js — Campistry Auto Build Engine v5.1.0
// =================================================================
// The auto builder does the job of a human scheduler in manual mode:
//   - User gives CONTRACTS (layers): type ranges, time windows, quantities
//   - Auto builder decides: WHAT TYPE, WHERE, HOW LONG
//   - Total solver then picks: WHICH SPECIFIC activity + field
//
// v5.1 — DURATION FIX
//   ★ getSpecialDuration now checks window.getSpecialActivityByName as
//     fallback, and checks all known property names (defaultDuration,
//     duration, durationMin) so duration is never silently lost.
//   ★ getRankedSpecials now carries _durationKnown flag so specials
//     with unknown durations are never picked for sized blocks.
//   ★ Special candidate loop skips any candidate whose duration is
//     unknown — prevents mismatched block sizes entirely.
//   ★ maxSpecDurInWave now uses real durations, never the || 30 fallback,
//     so block boundaries are always correctly sized.
//
// v5.0 — DIVISION RESOURCE PLANNER
//
// Architecture:
//   Phase 1: Commit pinned layers (window <= max duration). Permanent.
//   Phase 2: Sandbox solver — place constrained pieces (leagues, scarce,
//            fixed events) by constraint tightness, most constrained first.
//            All placements tentative until everything fits.
//   Phase 3: Fill gaps — Division Resource Planner counts fields and
//            special capacity, plans rotation waves, builds aligned
//            block structure for the whole division.
//   Phase 4: Validation — verify all constraints met, commit.
//
// Key principles:
//   - Nothing permanent until everything fits (sandbox)
//   - Block sizes come from actual activity durations
//   - Field demand never exceeds supply at any time
//   - Division-aligned block boundaries (no superset fragmentation)
//   - Scarce specials get priority (day-restricted = must schedule today)
//   - Capacity-aware staggering (Gameroom cap 2 → wave bunks through)
//
// OUTPUT feeds existing pipeline unchanged:
//   skeleton → DivisionTimesSystem.buildFromSkeleton()
//            → scheduler_core_main.js (bunk overrides at Step 2)
//            → total_solver_engine.js (fills remaining slots)
// =================================================================

(function() {
'use strict';

var VERSION = '5.1.0';
var DEBUG = true;

function log() { if (DEBUG) console.log.apply(console, ['[AutoBuild]'].concat(Array.prototype.slice.call(arguments))); }
function warn() { console.warn.apply(console, ['[AutoBuild]'].concat(Array.prototype.slice.call(arguments))); }

// =================================================================
// TIME UTILITIES
// =================================================================

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

function snapTo5(val) { return Math.round(val / 5) * 5; }
function uid() { return 'auto_' + Math.random().toString(36).slice(2, 9); }
function overlaps(s1, e1, s2, e2) { return s1 < e2 && e1 > s2; }

// =================================================================
// DATA ACCESS HELPERS
// =================================================================

function getGlobalSettings() { return window.loadGlobalSettings?.() || {}; }
function getSpecialActivities() { var g = getGlobalSettings(); return g.app1?.specialActivities || []; }
function getFields() { var g = getGlobalSettings(); return g.app1?.fields || g.fields || []; }
function getDivisions() { return window.divisions || getGlobalSettings().app1?.divisions || {}; }
function getBunksForDivision(divName) { return getDivisions()[divName]?.bunks || []; }

function getDivisionForGrade(gradeName) {
    var divisions = getDivisions();
    if (divisions[gradeName]) return gradeName;
    for (var divName in divisions) {
        if (divisions[divName].grades && divisions[divName].grades.indexOf(gradeName) >= 0) return divName;
        if (divisions[divName].grade === gradeName) return divName;
    }
    return gradeName;
}

function getDivisionTimes(divName) {
    var div = getDivisions()[divName];
    if (!div) return { start: 540, end: 960 };
    return {
        start: (div.startTime ? parseTime(div.startTime) : 540) || 540,
        end: (div.endTime ? parseTime(div.endTime) : 960) || 960
    };
}

function getSpecialConfig(name) {
    return getSpecialActivities().find(function(s) {
        return s.name?.toLowerCase().trim() === name?.toLowerCase().trim();
    }) || null;
}

// ★★★ v5.1 FIX: getSpecialDuration now checks all known property names
// AND falls back to window.getSpecialActivityByName so duration is never
// silently lost when the live registry uses a different property name.
function getSpecialDuration(name) {
    var config = getSpecialConfig(name);

    // Fallback to live window registry if settings-based config missing or has no duration
    if ((!config || (!config.defaultDuration && !config.duration && !config.durationMin)) &&
        window.getSpecialActivityByName) {
        var liveConfig = window.getSpecialActivityByName(name);
        if (liveConfig) config = liveConfig;
    }

    if (!config) return null;

    // Check all known property names — return the first one that is a positive number
    var dur = config.defaultDuration || config.duration || config.durationMin || null;
    if (dur && parseInt(dur) > 0) return parseInt(dur);
    return null;
}

function isSpecialAvailableOnDay(specialConfig, dayName) {
    if (!specialConfig) return true;
    if (Array.isArray(specialConfig.availableDays) && specialConfig.availableDays.length > 0) {
        return specialConfig.availableDays.map(function(d) { return d.toLowerCase(); }).indexOf(dayName.toLowerCase()) >= 0;
    }
    if (!specialConfig.dayAvailability) return true;
    var avail = specialConfig.dayAvailability;
    if (typeof avail === 'object' && !Array.isArray(avail)) return avail[dayName] !== false;
    if (Array.isArray(avail)) return avail.map(function(d) { return d.toLowerCase(); }).indexOf(dayName.toLowerCase()) >= 0;
    return true;
}

function getSpecialTimeWindow(specialConfig) {
    if (!specialConfig) return null;
    var start = specialConfig.availableFrom || specialConfig.windowStart || specialConfig.startTime;
    var end = specialConfig.availableTo || specialConfig.windowEnd || specialConfig.endTime;
    if (start && end) {
        return { startMin: typeof start === 'number' ? start : parseTime(start), endMin: typeof end === 'number' ? end : parseTime(end) };
    }
    if (Array.isArray(specialConfig.timeRules) && specialConfig.timeRules.length > 0) {
        var availableRules = specialConfig.timeRules.filter(function(r) { return r.type === 'Available' || !r.type; });
        if (availableRules.length > 0) {
            var earliest = Infinity, latest = -Infinity;
            for (var i = 0; i < availableRules.length; i++) {
                var rStart = availableRules[i].startMin != null ? availableRules[i].startMin : (availableRules[i].start ? parseTime(availableRules[i].start) : null);
                var rEnd = availableRules[i].endMin != null ? availableRules[i].endMin : (availableRules[i].end ? parseTime(availableRules[i].end) : null);
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
    var config = getSpecialConfig(specialName);
    if (!config) return true;
    var rules = config.limitUsage;
    if (!rules || !rules.enabled) return true;
    var allowedDivs = rules.divisions;
    if (!allowedDivs || typeof allowedDivs !== 'object') return true;
    if (Array.isArray(allowedDivs)) return allowedDivs.indexOf(divName) >= 0;
    return divName in allowedDivs;
}

function getSpecialCapacity(specialConfig) {
    if (!specialConfig) return 2;
    if (specialConfig.sharableWith) {
        if (specialConfig.sharableWith.capacity !== undefined) {
            var c = parseInt(specialConfig.sharableWith.capacity);
            if (!isNaN(c) && c > 0) return c;
        }
        if (specialConfig.sharableWith.type === 'not_sharable') return 1;
    }
    return parseInt(specialConfig.capacity) || parseInt(specialConfig.maxBunks) || 2;
}

// =================================================================
// ROTATION HISTORY ACCESS
// =================================================================

function getRotationScore(bunkName, activityName) {
    if (window.RotationEngine?.calculateFullRotationScore) return window.RotationEngine.calculateFullRotationScore(bunkName, activityName, 0, {});
    if (window.RotationEngine?.calculateRecencyScore) return window.RotationEngine.calculateRecencyScore(bunkName, activityName, 0);
    return 0;
}

// ★★★ v5.1 FIX: getRankedSpecials now carries _durationKnown flag.
// Specials whose duration cannot be resolved are flagged so they can be
// excluded from block sizing — preventing mismatched slot sizes.
function getRankedSpecials(bunkName, availableNames, fallbackDuration) {
    var ranked = availableNames.map(function(name) {
        var dur = getSpecialDuration(name);
        return {
            name: name,
            score: getRotationScore(bunkName, name),
            duration: dur || fallbackDuration || 30,
            _durationKnown: dur !== null && dur > 0
        };
    });
    ranked.sort(function(a, b) { return a.score - b.score; });
    return ranked;
}

// =================================================================
// FIELD SUPPLY COUNTER
// =================================================================

function countAvailableSportsFields(timeStart, timeEnd, divName) {
    var fields = getFields();
    var count = 0;
    var disabled = window.currentDisabledFields || [];
    fields.forEach(function(f) {
        if (!f.activities || f.activities.length === 0) return;
        if (disabled.indexOf(f.name) >= 0) return;
        if (f.timeRules) {
            for (var i = 0; i < f.timeRules.length; i++) {
                var rule = f.timeRules[i];
                if (rule.type === 'Unavailable' || rule.type === 'unavailable') {
                    var rStart = rule.startMin != null ? rule.startMin : parseTime(rule.start);
                    var rEnd = rule.endMin != null ? rule.endMin : parseTime(rule.end);
                    if (rStart != null && rEnd != null && timeStart < rEnd && timeEnd > rStart) return;
                }
            }
        }
        count++;
    });
    return count;
}

// =================================================================
// PLACEMENT HELPERS
// =================================================================

function findGaps(occupied, divTimes) {
    if (occupied.length === 0) return [{ startMin: divTimes.start, endMin: divTimes.end }];
    var sorted = occupied.slice().sort(function(a, b) { return a.startMin - b.startMin; });
    var gaps = [];
    if (sorted[0].startMin > divTimes.start) gaps.push({ startMin: divTimes.start, endMin: sorted[0].startMin });
    for (var i = 0; i < sorted.length - 1; i++) {
        var gapStart = sorted[i].endMin, gapEnd = sorted[i + 1].startMin;
        if (gapEnd > gapStart + 4) gaps.push({ startMin: gapStart, endMin: gapEnd });
    }
    var lastEnd = sorted[sorted.length - 1].endMin;
    if (lastEnd < divTimes.end) gaps.push({ startMin: lastEnd, endMin: divTimes.end });
    return gaps;
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

function getLayerOp(layer) { return layer.op || layer.operator || layer.quantity?.op || '>='; }
function getLayerDuration(layer) { return layer.durationMin || layer.duration || layer.periodMin || 30; }
function getLayerDurationMax(layer) { return layer.durationMax || layer.duration || layer.durationMin || layer.periodMin || getLayerDuration(layer); }

function isLayerPinned(layer) {
    var windowSize = (layer.endMin || 0) - (layer.startMin || 0);
    var maxDur = getLayerDurationMax(layer);
    if (windowSize > 0 && maxDur > 0 && windowSize <= maxDur) return true;
    if (layer.pinned || layer.pinExact) return true;
    return false;
}

function computeRequirements(typeLayers) {
    var minRequired = 0, maxAllowed = Infinity, hasExact = false;
    typeLayers.forEach(function(layer) {
        var qty = getLayerQty(layer), op = getLayerOp(layer);
        if (op === '=' || op === '==') { minRequired = qty; maxAllowed = qty; hasExact = true; }
        else if (op === '>=' || op === '\u2265') minRequired = Math.max(minRequired, qty);
        else if (op === '<=' || op === '\u2264') maxAllowed = Math.min(maxAllowed, qty);
    });
    return { min: minRequired, max: maxAllowed, hasExact: hasExact };
}

// =================================================================
// CONSTRAINT TIGHTNESS SCORER
// =================================================================

function calculateTightness(piece) {
    var windowSize = piece.windowEnd - piece.windowStart;
    var slack = windowSize - piece.duration;
    if (slack <= 0) return 0;
    var score = slack;
    if (piece.divisionWide) score *= 0.5;
    if (piece.isScarce && piece.capacity && piece.bunksToServe) {
        var slotsNeeded = Math.ceil(piece.bunksToServe / piece.capacity);
        var slotsAvailable = Math.floor(windowSize / piece.duration);
        var pressure = slotsNeeded / Math.max(slotsAvailable, 1);
        score *= (1 / Math.max(pressure, 0.1));
    }
    return score;
}

// =================================================================
// MAIN BUILD FUNCTION
// =================================================================

function build(params) {
    var layers = params.layers, dateStr = params.dateStr;

    log('=======================================================');
    log('AUTO BUILD ENGINE v' + VERSION);
    log('Date: ' + dateStr + ', Layers: ' + layers.length);
    log('=======================================================');

    var warnings = [];
    var parts = dateStr.split('-').map(Number);
    var dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var dayName = dayNames[dow];
    log('Day: ' + dayName);

    var allSpecials = getSpecialActivities();
    var isRainy = !!window.isRainyDay;
    var todaysSpecials = allSpecials.filter(function(s) {
        if (!isSpecialAvailableOnDay(s, dayName)) return false;
        if (!isRainy && s.rainyDayOnly) return false;
        return true;
    });
    var scarceSpecials = todaysSpecials.filter(function(s) { return isScarceSpecial(s, dayName); });
    var regularSpecials = todaysSpecials.filter(function(s) { return !isScarceSpecial(s, dayName); });

    log('Specials: total=' + allSpecials.length + ' today=' + todaysSpecials.length +
        ' scarce=' + scarceSpecials.length + ' regular=' + regularSpecials.length);

    var layersByGrade = {};
    layers.forEach(function(l) {
        var grade = l.grade || l.division || '_all';
        if (!layersByGrade[grade]) layersByGrade[grade] = [];
        layersByGrade[grade].push(Object.assign({}, l));
    });

    var allSkeleton = [], allBunkOverrides = [], bunkTimelines = {};

    // Cross-division scarce tracker
    var globalScarceUsage = {};
    function getGlobalScarceUsage(name, slotStart) { var e = globalScarceUsage[name + '|' + slotStart]; return e ? e.count : 0; }
    function recordGlobalScarce(name, slotStart, count, divName) {
        var key = name + '|' + slotStart;
        if (!globalScarceUsage[key]) globalScarceUsage[key] = { count: 0, division: divName };
        globalScarceUsage[key].count += count;
    }
    function getRemainingGlobalScarce(cfg, forDiv) {
        var name = cfg.name, dur = cfg.defaultDuration || cfg.duration || 30;
        var tw = getSpecialTimeWindow(cfg);
        if (!tw) return 0;
        var cap = getSpecialCapacity(cfg), remaining = 0;
        for (var c = tw.startMin; c + dur <= tw.endMin; c += dur) {
            remaining += Math.max(0, cap - getGlobalScarceUsage(name, c));
        }
        return remaining;
    }
    var globalScarceAPI = { getUsage: getGlobalScarceUsage, record: recordGlobalScarce, getRemaining: getRemainingGlobalScarce };

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
            todaysSpecials: todaysSpecials, warnings: warnings, globalScarceAPI: globalScarceAPI
        });
        allSkeleton = allSkeleton.concat(result.skeleton);
        allBunkOverrides = allBunkOverrides.concat(result.bunkOverrides);
        Object.assign(bunkTimelines, result.bunkTimelines);
    }

    log('\nBUILD COMPLETE: ' + allSkeleton.length + ' skeleton, ' + allBunkOverrides.length + ' overrides');
    return { skeleton: allSkeleton, bunkOverrides: allBunkOverrides, bunkTimelines: bunkTimelines,
             warnings: warnings, _autoGenerated: true, _buildDate: dateStr, _buildVersion: VERSION };
}

// =================================================================
// BUILD FOR GRADE — v5.1 Division Resource Planner
// =================================================================

function buildForGrade(params) {
    var divName = params.divName, bunks = params.bunks, layers = params.layers;
    var dayName = params.dayName, divTimes = params.divTimes;
    var scarceSpecials = params.scarceSpecials, regularSpecials = params.regularSpecials;
    var warnings = params.warnings, globalScarceAPI = params.globalScarceAPI;

    var skeleton = [], bunkOverrides = [], bunkTimelines = {};

    var divScarce = scarceSpecials.filter(function(s) { return isSpecialAvailableForDivision(s.name, divName); });
    var divRegular = regularSpecials.filter(function(s) { return isSpecialAvailableForDivision(s.name, divName); });
    log('  [Div] ' + divName + ': ' + divRegular.length + ' regular, ' + divScarce.length + ' scarce specials');

    var bunkState = {};
    bunks.forEach(function(bunk) {
        bunkState[bunk] = { occupied: [], specialCount: 0, sportCount: 0, usedActivities: [] };
        bunkTimelines[bunk] = [];
    });

    // Classify layers
    var pinnedLayers = [], fixedLayers = [], leagueLayers = [], specialtyLeagueLayers = [];
    var specialLayers = [], sportLayers = [], swimLayers = [], customLayers = [];

    layers.forEach(function(layer, idx) {
        layer._idx = idx;
        var lType = (layer.type || '').toLowerCase();
        var pinned = isLayerPinned(layer);

        if (['lunch', 'snack', 'snacks', 'dismissal'].indexOf(lType) >= 0) {
            if (pinned) pinnedLayers.push(layer); else fixedLayers.push(layer);
        } else if (lType === 'league') {
            if (pinned) pinnedLayers.push(layer); else leagueLayers.push(layer);
        } else if (lType === 'specialty_league') {
            if (pinned) pinnedLayers.push(layer); else specialtyLeagueLayers.push(layer);
        } else if (lType === 'swim') {
            if (pinned) pinnedLayers.push(layer); else swimLayers.push(layer);
        } else if (window.CustomPersistentTiles?.isCustomType?.(lType)) {
            if (pinned) pinnedLayers.push(layer); else customLayers.push(layer);
        } else if (lType === 'special') { specialLayers.push(layer); }
        else if (lType === 'sport' || lType === 'sports') { sportLayers.push(layer); }
        else { customLayers.push(layer); }
    });

    var specialReq = computeRequirements(specialLayers);
    var sportReq = computeRequirements(sportLayers);
    var specialDurMin = specialLayers.length > 0 ? getLayerDuration(specialLayers[0]) : 30;
    var specialDurMax = specialLayers.length > 0 ? getLayerDurationMax(specialLayers[0]) : specialDurMin;
    var sportDurMin = sportLayers.length > 0 ? getLayerDuration(sportLayers[0]) : 30;
    var sportDurMax = sportLayers.length > 0 ? getLayerDurationMax(sportLayers[0]) : sportDurMin;
    var minActivityDur = Math.min(specialDurMin, 20); // sports enforce their own minimum separately

    var sportWindow = sportLayers.length > 0 ? { startMin: sportLayers[0].startMin, endMin: sportLayers[0].endMin } : { startMin: divTimes.start, endMin: divTimes.end };
    var specialWindow = specialLayers.length > 0 ? { startMin: specialLayers[0].startMin, endMin: specialLayers[0].endMin } : { startMin: divTimes.start, endMin: divTimes.end };

    log('  Reqs: Spec min=' + specialReq.min + ' max=' + specialReq.max + ' | Sport min=' + sportReq.min + ' max=' + sportReq.max);
    log('  Durs: Spec ' + specialDurMin + '-' + specialDurMax + ' | Sport ' + sportDurMin + '-' + sportDurMax);

    function markAllBunksOccupied(startMin, endMin, event, type) {
        bunks.forEach(function(bunk) {
            bunkState[bunk].occupied.push({ startMin: startMin, endMin: endMin, event: event, type: type });
            bunkTimelines[bunk].push({ startMin: startMin, endMin: endMin, event: event, type: type, _autoGenerated: true });
        });
    }

    var divisionOccupied = [];

    // ═══════════════════════════════════════════════════════
    // PHASE 1: COMMIT PINNED LAYERS (PERMANENT)
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 1] Committing pinned layers (' + pinnedLayers.length + ')');

    pinnedLayers.forEach(function(layer) {
        var windowSize = (layer.endMin || 0) - (layer.startMin || 0);
        var maxDur = getLayerDurationMax(layer);
        var dur = windowSize > 0 ? Math.min(windowSize, maxDur) : maxDur;
        if (dur <= 0) dur = maxDur || 30;
        var startMin = layer.startMin, endMin = startMin + dur;
        var eventName = layer.event || layer.type;
        var lType = (layer.type || '').toLowerCase();
        var skeletonType = lType === 'league' ? 'league' : lType === 'specialty_league' ? 'specialty_league' : 'pinned';

        skeleton.push({ id: uid(), type: skeletonType, event: eventName, division: divName,
            startTime: fmtTime(startMin), endTime: fmtTime(endMin), pinned: true, _autoGenerated: true });
        divisionOccupied.push({ startMin: startMin, endMin: endMin, event: eventName, type: skeletonType });
        markAllBunksOccupied(startMin, endMin, eventName, skeletonType);

        // Change buffer for swim
        if (lType === 'swim') {
            var gs = getGlobalSettings();
            var changeDur = parseInt(gs.app1?.changeBufferDuration) || parseInt(gs.changeBufferDuration) || 10;
            if (changeDur > 0) {
                if (endMin + changeDur <= divTimes.end) {
                    skeleton.push({ id: uid(), type: 'pinned', event: 'Change', division: divName,
                        startTime: fmtTime(endMin), endTime: fmtTime(endMin + changeDur), pinned: true, _autoGenerated: true });
                    divisionOccupied.push({ startMin: endMin, endMin: endMin + changeDur, event: 'Change', type: 'change' });
                    markAllBunksOccupied(endMin, endMin + changeDur, 'Change', 'change');
                }
                if (startMin - changeDur >= divTimes.start) {
                    var preS = startMin - changeDur;
                    if (!divisionOccupied.some(function(o) { return overlaps(preS, startMin, o.startMin, o.endMin); })) {
                        skeleton.push({ id: uid(), type: 'pinned', event: 'Change', division: divName,
                            startTime: fmtTime(preS), endTime: fmtTime(startMin), pinned: true, _autoGenerated: true });
                        divisionOccupied.push({ startMin: preS, endMin: startMin, event: 'Change', type: 'change' });
                        markAllBunksOccupied(preS, startMin, 'Change', 'change');
                    }
                }
            }
        }

        // Bunk overrides for fixed events
        if (['lunch', 'snack', 'snacks', 'dismissal'].indexOf(lType) >= 0) {
            bunks.forEach(function(bunk) {
                bunkOverrides.push({ bunk: bunk, division: divName, activity: eventName, type: 'pinned',
                    startTime: fmtTime(startMin), endTime: fmtTime(endMin), _autoGenerated: true, _fixedEvent: true });
            });
        }

        log('    PINNED: ' + eventName + ' ' + fmtTime(startMin) + '-' + fmtTime(endMin) + ' (' + dur + 'min)');
    });

    // ═══════════════════════════════════════════════════════
    // PHASE 2: SANDBOX SOLVER — Constrained Pieces
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 2] Sandbox solver');

    var constrainedPieces = [];

    // 2a: Leagues
    leagueLayers.concat(specialtyLeagueLayers).forEach(function(layer) {
        var isSp = (layer.type || '').toLowerCase() === 'specialty_league';
        var durMin = getLayerDuration(layer), durMax = getLayerDurationMax(layer);
        var wStart = layer.startMin, wEnd = layer.endMin || (wStart + durMax);
        var windowSize = wEnd - wStart;
        var dur = Math.min(durMax, windowSize);
        if (dur < durMin) dur = Math.min(durMin, windowSize);
        var qty = getLayerQty(layer);
        for (var i = 0; i < Math.max(qty, 1); i++) {
            constrainedPieces.push({
                eventName: isSp ? 'Specialty League' : 'League Game',
                duration: dur, windowStart: wStart, windowEnd: wEnd,
                divisionWide: true, isScarce: false, type: isSp ? 'specialty_league' : 'league',
                config: null, bunksToServe: bunks.length, capacity: bunks.length
            });
        }
    });

    // 2b: Scarce specials
    divScarce.forEach(function(cfg) {
        var name = cfg.name, dur = cfg.defaultDuration || cfg.duration || 30;
        var tw = getSpecialTimeWindow(cfg);
        if (!tw) { warn('Scarce "' + name + '" no time window'); return; }
        var cap = getSpecialCapacity(cfg);
        if (globalScarceAPI) {
            var rem = globalScarceAPI.getRemaining(cfg, divName);
            if (rem <= 0) { log('    ' + name + ': globally exhausted'); return; }
        }
        var slotsInWindow = Math.floor((tw.endMin - tw.startMin) / dur);
        var totalCap = slotsInWindow * cap;
        var gUsed = 0;
        for (var c = tw.startMin; c + dur <= tw.endMin; c += dur) gUsed += globalScarceAPI.getUsage(name, c);
        var available = Math.max(0, totalCap - gUsed);
        var ranked = bunks.map(function(b) { return { bunk: b, score: getRotationScore(b, name) }; })
            .sort(function(a, b) { return a.score - b.score; });
        var toServe = Math.min(ranked.length, available);
        if (toServe <= 0) { log('    ' + name + ': no capacity'); return; }

        for (var wave = 0; wave < Math.ceil(toServe / cap); wave++) {
            var waveBunks = [];
            for (var bi = wave * cap; bi < Math.min((wave + 1) * cap, toServe); bi++) waveBunks.push(ranked[bi].bunk);
            constrainedPieces.push({
                eventName: name, duration: dur, windowStart: tw.startMin, windowEnd: tw.endMin,
                divisionWide: false, isScarce: true, type: 'scarce_special', config: cfg,
                bunksToServe: waveBunks.length, capacity: cap, assignedBunks: waveBunks
            });
        }
        log('    Scarce: ' + name + ' -> ' + toServe + ' bunks in ' + Math.ceil(toServe / cap) + ' waves');
    });

    // 2c: Fixed events
    fixedLayers.forEach(function(layer) {
        var dur = getLayerDuration(layer);
        constrainedPieces.push({
            eventName: layer.event || layer.type, duration: dur,
            windowStart: layer.startMin, windowEnd: layer.endMin || (layer.startMin + dur),
            divisionWide: true, isScarce: false, type: 'fixed',
            config: null, bunksToServe: bunks.length, capacity: bunks.length
        });
    });

    // 2d: Swim (flexible)
    swimLayers.forEach(function(layer) {
        var dur = getLayerDuration(layer);
        constrainedPieces.push({
            eventName: layer.event || 'Swim', duration: dur,
            windowStart: layer.startMin, windowEnd: layer.endMin || (layer.startMin + dur),
            divisionWide: true, isScarce: false, type: 'swim',
            config: null, bunksToServe: bunks.length, capacity: bunks.length
        });
    });

    // 2e: Custom (flexible)
    customLayers.forEach(function(layer) {
        var dur = getLayerDuration(layer);
        constrainedPieces.push({
            eventName: layer.event || layer.type, duration: dur,
            windowStart: layer.startMin, windowEnd: layer.endMin || (layer.startMin + dur),
            divisionWide: true, isScarce: false, type: 'custom',
            config: null, bunksToServe: bunks.length, capacity: bunks.length
        });
    });

    // Sort by tightness
    constrainedPieces.forEach(function(p) { p._tightness = calculateTightness(p); });
    constrainedPieces.sort(function(a, b) { return a._tightness - b._tightness; });
    log('  Constrained: ' + constrainedPieces.length + ' pieces');

    var sandboxPlacements = [];

    for (var pi = 0; pi < constrainedPieces.length; pi++) {
        var piece = constrainedPieces[pi];
        var bestPos = null, bestScore = Infinity;

        for (var ts = piece.windowStart; ts + piece.duration <= piece.windowEnd; ts += 5) {
            var te = ts + piece.duration;
            var conflict = false;

            if (piece.divisionWide) {
                conflict = divisionOccupied.some(function(o) { return overlaps(ts, te, o.startMin, o.endMin); });
                if (!conflict) conflict = sandboxPlacements.some(function(sp) { return sp.piece.divisionWide && overlaps(ts, te, sp.startMin, sp.endMin); });
            } else {
                var assignedBunks = piece.assignedBunks || bunks;
                for (var bi = 0; bi < assignedBunks.length && !conflict; bi++) {
                    if (bunkState[assignedBunks[bi]].occupied.some(function(o) { return overlaps(ts, te, o.startMin, o.endMin); })) conflict = true;
                }
                if (!conflict) {
                    for (var si = 0; si < sandboxPlacements.length && !conflict; si++) {
                        var sp = sandboxPlacements[si];
                        if (!overlaps(ts, te, sp.startMin, sp.endMin)) continue;
                        if (sp.piece.divisionWide) { conflict = true; continue; }
                        var spBunks = sp.piece.assignedBunks || bunks;
                        for (var sbi = 0; sbi < assignedBunks.length && !conflict; sbi++) {
                            if (spBunks.indexOf(assignedBunks[sbi]) >= 0) conflict = true;
                        }
                    }
                }
            }
            if (conflict) continue;

            var score = 0;
            var testOcc = divisionOccupied.concat(
                sandboxPlacements.map(function(sp) { return { startMin: sp.startMin, endMin: sp.endMin }; }),
                [{ startMin: ts, endMin: te }]
            );
            var testGaps = findGaps(testOcc, divTimes);
            for (var tgi = 0; tgi < testGaps.length; tgi++) {
                var gd = testGaps[tgi].endMin - testGaps[tgi].startMin;
                if (gd >= 5 && gd < minActivityDur) score += 10000;
            }
            if (piece.isScarce && piece.assignedBunks) {
                var sportsAtTime = bunks.length - piece.assignedBunks.length;
                var fieldsAvail = countAvailableSportsFields(ts, te, divName);
                if (sportsAtTime > fieldsAvail) score += (sportsAtTime - fieldsAvail) * 5000;
            }
            score += (ts - piece.windowStart) * 0.1;

            if (score < bestScore) { bestScore = score; bestPos = { startMin: ts, endMin: te }; }
            if (score === 0) break;
        }

        if (!bestPos) {
            warn('  Could not place: ' + piece.eventName);
            warnings.push(divName + ': Could not place ' + piece.eventName);
            continue;
        }

        sandboxPlacements.push({ startMin: bestPos.startMin, endMin: bestPos.endMin, piece: piece });

        if (piece.divisionWide) {
            divisionOccupied.push({ startMin: bestPos.startMin, endMin: bestPos.endMin, event: piece.eventName, type: piece.type });
        }

        if (piece.type === 'league' || piece.type === 'specialty_league') {
            skeleton.push({ id: uid(), type: piece.type, event: piece.eventName, division: divName,
                startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), _autoGenerated: true });
            markAllBunksOccupied(bestPos.startMin, bestPos.endMin, piece.eventName, piece.type);
        } else if (piece.type === 'fixed') {
            skeleton.push({ id: uid(), type: 'pinned', event: piece.eventName, division: divName,
                startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), pinned: true, _autoGenerated: true });
            bunks.forEach(function(bunk) {
                bunkOverrides.push({ bunk: bunk, division: divName, activity: piece.eventName, type: 'pinned',
                    startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), _autoGenerated: true, _fixedEvent: true });
            });
            markAllBunksOccupied(bestPos.startMin, bestPos.endMin, piece.eventName, 'fixed');
        } else if (piece.type === 'swim') {
            skeleton.push({ id: uid(), type: 'pinned', event: piece.eventName, division: divName,
                startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), pinned: true, _autoGenerated: true });
            markAllBunksOccupied(bestPos.startMin, bestPos.endMin, piece.eventName, 'swim');
            var gs = getGlobalSettings();
            var changeDur = parseInt(gs.app1?.changeBufferDuration) || parseInt(gs.changeBufferDuration) || 10;
            if (changeDur > 0) {
                if (bestPos.endMin + changeDur <= divTimes.end) {
                    skeleton.push({ id: uid(), type: 'pinned', event: 'Change', division: divName,
                        startTime: fmtTime(bestPos.endMin), endTime: fmtTime(bestPos.endMin + changeDur), pinned: true, _autoGenerated: true });
                    divisionOccupied.push({ startMin: bestPos.endMin, endMin: bestPos.endMin + changeDur, event: 'Change', type: 'change' });
                    markAllBunksOccupied(bestPos.endMin, bestPos.endMin + changeDur, 'Change', 'change');
                }
                if (bestPos.startMin - changeDur >= divTimes.start) {
                    var preS = bestPos.startMin - changeDur;
                    if (!divisionOccupied.some(function(o) { return overlaps(preS, bestPos.startMin, o.startMin, o.endMin); })) {
                        skeleton.push({ id: uid(), type: 'pinned', event: 'Change', division: divName,
                            startTime: fmtTime(preS), endTime: fmtTime(bestPos.startMin), pinned: true, _autoGenerated: true });
                        divisionOccupied.push({ startMin: preS, endMin: bestPos.startMin, event: 'Change', type: 'change' });
                        markAllBunksOccupied(preS, bestPos.startMin, 'Change', 'change');
                    }
                }
            }
        } else if (piece.type === 'scarce_special') {
            piece.assignedBunks.forEach(function(bunk) {
                skeleton.push({ id: uid(), type: 'slot', event: 'Special Activity', division: divName,
                    startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin),
                    _autoGenerated: true, _bunk: String(bunk), _suggestedActivity: piece.eventName, _scarce: true, _durationStrict: true });
                bunkState[bunk].occupied.push({ startMin: bestPos.startMin, endMin: bestPos.endMin, event: piece.eventName, type: 'scarce' });
                bunkState[bunk].specialCount++;
                bunkState[bunk].usedActivities.push(piece.eventName);
            });
            if (globalScarceAPI && piece.config) globalScarceAPI.record(piece.eventName, bestPos.startMin, piece.assignedBunks.length, divName);
        } else if (piece.type === 'custom') {
            skeleton.push({ id: uid(), type: 'pinned', event: piece.eventName, division: divName,
                startTime: fmtTime(bestPos.startMin), endTime: fmtTime(bestPos.endMin), pinned: true, _autoGenerated: true });
            markAllBunksOccupied(bestPos.startMin, bestPos.endMin, piece.eventName, 'custom');
        }

        log('    ' + piece.eventName + ': ' + fmtTime(bestPos.startMin) + '-' + fmtTime(bestPos.endMin) + ' (score:' + bestScore.toFixed(0) + ')');
    }

    log('  [Phase 2] Done: ' + sandboxPlacements.length + ' pieces placed');

    // ═══════════════════════════════════════════════════════
    // PHASE 3: FILL GAPS — Division Resource Planner
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 3] Filling gaps');

    var specialSlotUsage = {};
    function isSpecAtCap(name, slotStart) { return (specialSlotUsage[name + '|' + slotStart] || 0) >= getSpecialCapacity(getSpecialConfig(name)); }
    function recordSpecUsage(name, slotStart) { var k = name + '|' + slotStart; specialSlotUsage[k] = (specialSlotUsage[k] || 0) + 1; }

    var divGaps = findGaps(divisionOccupied, divTimes);
    log('  Division gaps: ' + divGaps.length);

    for (var dgi = 0; dgi < divGaps.length; dgi++) {
        var gap = divGaps[dgi], gapDur = gap.endMin - gap.startMin;
        if (gapDur < minActivityDur) continue;
        log('    Gap: ' + fmtTime(gap.startMin) + '-' + fmtTime(gap.endMin) + ' (' + gapDur + 'min)');

        var fieldsAvailable = countAvailableSportsFields(gap.startMin, gap.endMin, divName);

        var bunksFree = [], bunksOccupied = [];
        bunks.forEach(function(bunk) {
            var hasNonFiller = bunkState[bunk].occupied.some(function(o) {
                return overlaps(gap.startMin, gap.endMin, o.startMin, o.endMin) && o.type !== 'sport_slot' && o.type !== 'special_slot';
            });
            if (hasNonFiller) bunksOccupied.push(bunk); else bunksFree.push(bunk);
        });
        if (bunksFree.length === 0) continue;

        var bunksNeedSpec = [], bunksDontNeedSpec = [];
        bunksFree.forEach(function(bunk) {
            if (specialReq.min > 0 && bunkState[bunk].specialCount < specialReq.min) bunksNeedSpec.push(bunk);
            else bunksDontNeedSpec.push(bunk);
        });

        // Available specials for this gap — only include those with a KNOWN duration
        // ★★★ v5.1 FIX: Filter out specials with unknown durations to prevent mismatched blocks
        var gapSpecials = [];
        divRegular.forEach(function(cfg) {
            var tw = getSpecialTimeWindow(cfg);
            if (tw && !overlaps(gap.startMin, gap.endMin, tw.startMin, tw.endMin)) return;

            // ★★★ v5.1: Resolve duration using the fixed getSpecialDuration
            var resolvedDur = getSpecialDuration(cfg.name);
            if (!resolvedDur || resolvedDur <= 0) {
                warn('    Skipping "' + cfg.name + '" — duration unknown, cannot size block correctly');
                return;
            }

            // ★★★ v5.1: Only include if the special's duration fits within this gap
            if (resolvedDur > gapDur) return;

            gapSpecials.push({
                name: cfg.name,
                duration: resolvedDur,  // ★ always use resolved duration, never || 30 fallback
                capacity: getSpecialCapacity(cfg),
                config: cfg
            });
        });

        var totalSeats = 0;
        gapSpecials.forEach(function(sp) { totalSeats += sp.capacity; });

        log('      Free: ' + bunksFree.length + ', needSpec: ' + bunksNeedSpec.length +
            ', seats: ' + totalSeats + ', fields: ' + fieldsAvailable);

        var blockPlan = [];
        var cursor = gap.startMin;

        if (bunksNeedSpec.length > 0 && gapSpecials.length > 0 && totalSeats > 0) {
            var wavesNeeded = Math.ceil(bunksNeedSpec.length / totalSeats);
            var specQueue = bunksNeedSpec.slice();
            var waveIdx = 0;

            while (cursor < gap.endMin) {
                var remaining = gap.endMin - cursor;
                if (remaining < minActivityDur) break;

                if (waveIdx < wavesNeeded && specQueue.length > 0) {
                    // ═══ SPECIAL WAVE ═══
                    var waveBunks = specQueue.splice(0, totalSeats);

                    // Step 1: Pick a special for each bunk in this wave
                    var bunkSpecPicks = [];
                    waveBunks.forEach(function(bunk) {
                        var availableNames = gapSpecials.filter(function(sp) {
                            return bunkState[bunk].usedActivities.indexOf(sp.name) < 0 && !isSpecAtCap(sp.name, cursor);
                        }).map(function(sp) { return sp.name; });

                        // ★★★ v5.1: Pass specialDurMin as fallback; _durationKnown flag carried through
                        var ranked = getRankedSpecials(bunk, availableNames, specialDurMin);

                        var picked = null;
                        for (var ri = 0; ri < ranked.length; ri++) {
                            var candidate = ranked[ri];

                            // ★★★ v5.1 FIX: Skip candidates with unknown duration entirely
                            // Cannot safely size a block if we don't know the true duration
                            if (!candidate._durationKnown) {
                                log('        ' + bunk + ': skipping ' + candidate.name + ' — duration unknown');
                                continue;
                            }

                            var candDur = candidate.duration;
                            var leftover = remaining - candDur;

                            // Valid if: leftover is 0 (special fills gap exactly),
                            // or leftover >= sportDurMin (room for a proper sport block)
                            if (leftover === 0 || leftover >= sportDurMin) {
                                picked = candidate;
                                break;
                            }

                            log('        ' + bunk + ': skipping ' + candidate.name + ' (' + candDur + 'min) — leftover ' + leftover + 'min < sportDurMin ' + sportDurMin);
                        }

                        if (picked) {
                            bunkSpecPicks.push({ bunk: bunk, specialName: picked.name, duration: picked.duration });
                            recordSpecUsage(picked.name, cursor);
                            bunkState[bunk].usedActivities.push(picked.name);
                            bunkState[bunk].specialCount++;
                        } else {
                            // No valid special — this bunk does sport
                            bunkSpecPicks.push({ bunk: bunk, specialName: null, duration: 0 });
                        }
                    });

                    // Step 2: Group by duration
                    var durGroups = {};
                    bunkSpecPicks.forEach(function(pick) {
                        if (!pick.specialName) return;
                        var d = pick.duration;
                        if (!durGroups[d]) durGroups[d] = [];
                        durGroups[d].push(pick);
                    });

                    // Step 3: Sort duration groups longest first
                    var sortedDurs = Object.keys(durGroups).map(Number).sort(function(a, b) { return b - a; });

                    // If no specials were picked this wave, advance cursor by sportDurMin and loop
                    if (sortedDurs.length === 0) {
                        waveIdx++;
                        continue;
                    }

                    // Find all unique duration boundaries from this wave
                    var durationBoundaries = new Set();
                    durationBoundaries.add(0);
                    sortedDurs.forEach(function(d) {
                        if (cursor + d <= gap.endMin) durationBoundaries.add(d);
                    });
                    var boundaries = Array.from(durationBoundaries).sort(function(a, b) { return a - b; });

                    // ★★★ v5.1: maxSpecDurInWave uses actual resolved durations, never fallback
                    var maxSpecDurInWave = sortedDurs.length > 0 ? sortedDurs[0] : specialDurMin;
                    maxSpecDurInWave = Math.min(maxSpecDurInWave, remaining);

                    log('      Wave ' + waveIdx + ': maxSpecDur=' + maxSpecDurInWave + ', boundaries=' + boundaries.join(','));

                    for (var bi = 0; bi < boundaries.length; bi++) {
                        var bStart = cursor + boundaries[bi];
                        var bEnd;
                        if (bi + 1 < boundaries.length) {
                            bEnd = cursor + boundaries[bi + 1];
                        } else {
                            bEnd = cursor + maxSpecDurInWave;
                        }
                        if (bEnd <= bStart) continue;
                        if (bEnd > gap.endMin) bEnd = gap.endMin;
                        if (bEnd - bStart < 5) continue;

                        var assigns = {};
                        bunkSpecPicks.forEach(function(pick) {
                            var specDur = pick.duration;
                            if (pick.specialName && boundaries[bi] < specDur) {
                                assigns[pick.bunk] = { type: 'special', suggestedActivity: pick.specialName };
                            } else {
                                assigns[pick.bunk] = { type: 'sport', suggestedActivity: null };
                            }
                        });
                        bunksFree.forEach(function(bunk) {
                            if (assigns[bunk]) return;
                            assigns[bunk] = { type: 'sport', suggestedActivity: null };
                        });

                        blockPlan.push({ startMin: bStart, endMin: bEnd, assignments: assigns });
                    }

                    cursor += maxSpecDurInWave;
                    waveIdx++;
                } else {
                    // ═══ SPORT BLOCK ═══
                    var blockDur = Math.min(sportDurMax, remaining);
                    if (blockDur < sportDurMin && remaining >= sportDurMin) blockDur = sportDurMin;
                    if (blockDur < minActivityDur) break;

                    var assigns2 = {};
                    bunksFree.forEach(function(bunk) { assigns2[bunk] = { type: 'sport', suggestedActivity: null }; });

                    if (blockDur > sportDurMax) blockDur = sportDurMax;

                    // Anti-runt
                    var afterBlock = gap.endMin - (cursor + blockDur);
                    if (afterBlock > 0 && afterBlock < minActivityDur) {
                        if (cursor + blockDur + afterBlock - cursor <= sportDurMax) { blockDur += afterBlock; }
                        else {
                            var totalRem = gap.endMin - cursor;
                            var nBlocks = Math.ceil(totalRem / sportDurMax);
                            blockDur = Math.ceil(totalRem / nBlocks);
                            blockDur = Math.max(blockDur, minActivityDur);
                            blockDur = Math.min(blockDur, sportDurMax);
                        }
                    }

                    var snapped = snapTo5(cursor + blockDur);
                    if (snapped > cursor && snapped <= gap.endMin) blockDur = snapped - cursor;
                    if (blockDur < minActivityDur) break;

                    blockPlan.push({ startMin: cursor, endMin: cursor + blockDur, assignments: assigns2 });
                    cursor += blockDur;
                }
            }
        } else {
            // Pure sport fill
            while (cursor < gap.endMin) {
                var rem = gap.endMin - cursor;
                if (rem < sportDurMin) break;
                var bDur = Math.min(sportDurMax, rem);
                if (bDur < sportDurMin && rem >= sportDurMin) bDur = sportDurMin;
                if (bDur < minActivityDur) break;

                var after = gap.endMin - (cursor + bDur);
                if (after > 0 && after < sportDurMin) {
                    var n = Math.ceil(rem / sportDurMax);
                    bDur = snapTo5(Math.ceil(rem / n));
                    bDur = Math.max(bDur, sportDurMin);
                    bDur = Math.min(bDur, sportDurMax);
                }
                var sn = snapTo5(cursor + bDur);
                if (sn > cursor && sn <= gap.endMin) bDur = sn - cursor;
                if (bDur < minActivityDur) break;

                var a = {};
                bunksFree.forEach(function(bunk) { a[bunk] = { type: 'sport', suggestedActivity: null }; });
                blockPlan.push({ startMin: cursor, endMin: cursor + bDur, assignments: a });
                cursor += bDur;
            }
        }

        // Field supply check
        for (var bpi = 0; bpi < blockPlan.length; bpi++) {
            var sportCount = 0;
            for (var bk in blockPlan[bpi].assignments) { if (blockPlan[bpi].assignments[bk].type === 'sport') sportCount++; }
            if (sportCount > fieldsAvailable) {
                warnings.push(divName + ': field shortage at ' + fmtTime(blockPlan[bpi].startMin));
            }
        }

        // Step 1: Build per-bunk block list from the plan
        var perBunkBlocks = {};
        for (var bpi2 = 0; bpi2 < blockPlan.length; bpi2++) {
            var blk = blockPlan[bpi2];
            for (var bk in blk.assignments) {
                if (!perBunkBlocks[bk]) perBunkBlocks[bk] = [];
                var assign = blk.assignments[bk];
                perBunkBlocks[bk].push({
                    startMin: blk.startMin, endMin: blk.endMin,
                    type: assign.type, suggestedActivity: assign.suggestedActivity || null
                });
            }
        }

        // Step 2: Merge adjacent SPECIAL blocks with same suggestedActivity
        for (var bk2 in perBunkBlocks) {
            var blocks = perBunkBlocks[bk2];
            var merged = [];
            for (var mi = 0; mi < blocks.length; mi++) {
                var curr = blocks[mi];
                if (merged.length > 0) {
                    var prev = merged[merged.length - 1];
                    if (prev.endMin === curr.startMin &&
                        prev.type === curr.type &&
                        prev.suggestedActivity === curr.suggestedActivity &&
                        prev.type === 'special' && prev.suggestedActivity) {
                        prev.endMin = curr.endMin;
                        continue;
                    }
                }
                merged.push({ startMin: curr.startMin, endMin: curr.endMin,
                    type: curr.type, suggestedActivity: curr.suggestedActivity });
            }
            perBunkBlocks[bk2] = merged;
        }

        // Step 2b: Enforce sportDurMin floor — merge short sport blocks with neighbors
        for (var bk2b in perBunkBlocks) {
            var blist = perBunkBlocks[bk2b];
            var fixed = [];
            for (var fi = 0; fi < blist.length; fi++) {
                var blk = blist[fi];
                if (blk.type === 'sport' && (blk.endMin - blk.startMin) < sportDurMin) {
                    if (fi + 1 < blist.length && blist[fi + 1].type === 'sport' && blist[fi + 1].suggestedActivity === blk.suggestedActivity) {
                        blist[fi + 1].startMin = blk.startMin;
                        continue;
                    }
                    if (fixed.length > 0 && fixed[fixed.length - 1].type === 'sport' && fixed[fixed.length - 1].suggestedActivity === blk.suggestedActivity) {
                        fixed[fixed.length - 1].endMin = blk.endMin;
                        continue;
                    }
                }
                fixed.push(blk);
            }
            perBunkBlocks[bk2b] = fixed;
        }

        // ★★★ v5.1 FIX: Step 2c — Validate special block durations match configured durations.
        // If a special block was emitted with the wrong size (e.g. 35min for a 40min special),
        // correct it here before emitting to skeleton. This is a safety net for edge cases
        // where boundary math produces an off-by-one or rounding error.
        for (var bk2c in perBunkBlocks) {
            perBunkBlocks[bk2c].forEach(function(block) {
                if (block.type !== 'special' || !block.suggestedActivity) return;
                var expectedDur = getSpecialDuration(block.suggestedActivity);
                if (!expectedDur || expectedDur <= 0) return;
                var actualDur = block.endMin - block.startMin;
                if (actualDur !== expectedDur) {
                    warn('    Duration mismatch for ' + block.suggestedActivity + ': block=' + actualDur + 'min, expected=' + expectedDur + 'min — correcting endMin');
                    block.endMin = block.startMin + expectedDur;
                }
            });
        }

        // Step 3: Emit skeleton blocks from merged list
        for (var bk3 in perBunkBlocks) {
            var bunkStr3 = String(bk3);
            perBunkBlocks[bk3].forEach(function(block) {
                var evLabel = block.type === 'special' ? 'Special Activity' : 'Sports Slot';
                skeleton.push({ id: uid(), type: 'slot', event: evLabel, division: divName,
                    startTime: fmtTime(block.startMin), endTime: fmtTime(block.endMin),
                    _autoGenerated: true, _bunk: bunkStr3,
                    _suggestedActivity: block.suggestedActivity,
                    // ★★★ v5.1: _durationStrict only set for specials with known durations
                    _durationStrict: block.type === 'special' && block.suggestedActivity ? true : false,
                    // ★★★ v5.1: _sportOnly prevents solver placing specials in pure sport blocks
                    _sportOnly: block.type === 'sport' ? true : false
                });
                bunkState[bk3].occupied.push({ startMin: block.startMin, endMin: block.endMin,
                    event: evLabel, type: block.type + '_slot' });
                bunkTimelines[bk3].push({ startMin: block.startMin, endMin: block.endMin,
                    event: evLabel, type: block.type + '_slot',
                    _autoGenerated: true, _suggestedActivity: block.suggestedActivity });
                if (block.type === 'sport') bunkState[bk3].sportCount++;
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 4: VALIDATION
    // ═══════════════════════════════════════════════════════
    log('\n  [Phase 4] Validation');
    var repairs = 0;

    var requiredFixed = {};
    fixedLayers.forEach(function(l) { requiredFixed[l.event || l.type] = 1; });
    pinnedLayers.forEach(function(l) {
        var lt = (l.type || '').toLowerCase();
        if (['lunch', 'snack', 'snacks', 'dismissal'].indexOf(lt) >= 0) requiredFixed[l.event || l.type] = 1;
    });

    bunks.forEach(function(bunk) {
        var bunkStr = String(bunk);
        Object.keys(requiredFixed).forEach(function(evName) {
            var has = bunkState[bunk].occupied.some(function(o) { return o.event && o.event.toLowerCase() === evName.toLowerCase(); });
            if (!has) {
                var ref = null;
                for (var rb = 0; rb < bunks.length; rb++) {
                    ref = bunkState[bunks[rb]].occupied.find(function(o) { return o.event && o.event.toLowerCase() === evName.toLowerCase(); });
                    if (ref) break;
                }
                if (ref) {
                    bunkOverrides.push({ bunk: bunk, division: divName, activity: evName, type: 'pinned',
                        startTime: fmtTime(ref.startMin), endTime: fmtTime(ref.endMin), _autoGenerated: true, _repair: true });
                    bunkState[bunk].occupied.push({ startMin: ref.startMin, endMin: ref.endMin, event: evName, type: 'fixed' });
                    repairs++;
                }
            }
        });

        var finalGaps = findGaps(bunkState[bunk].occupied, divTimes);
        finalGaps.forEach(function(gap) {
            if (gap.endMin - gap.startMin < minActivityDur) return;
            var covered = skeleton.some(function(s) {
                if (s.division !== divName) return false;
                if (s._bunk && s._bunk !== bunkStr) return false;
                var ss = parseTime(s.startTime), se = parseTime(s.endTime);
                return ss != null && se != null && overlaps(ss, se, gap.startMin, gap.endMin);
            });
            if (!covered) {
                skeleton.push({ id: uid(), type: 'slot', event: 'General Activity Slot', division: divName,
                    startTime: fmtTime(gap.startMin), endTime: fmtTime(gap.endMin),
                    _autoGenerated: true, _bunk: bunkStr, _repair: true });
                repairs++;
            }
        });

        if (specialReq.min > 0 && bunkState[bunk].specialCount < specialReq.min)
            warnings.push(bunk + ': Only ' + bunkState[bunk].specialCount + '/' + specialReq.min + ' specials');
        if (sportReq.min > 0 && bunkState[bunk].sportCount < sportReq.min)
            warnings.push(bunk + ': Only ' + bunkState[bunk].sportCount + '/' + sportReq.min + ' sports');
    });

    Object.values(bunkTimelines).forEach(function(tl) { tl.sort(function(a, b) { return a.startMin - b.startMin; }); });
    log('  [Phase 4] ' + (repairs > 0 ? repairs + ' repairs' : 'All good'));
    return { skeleton: skeleton, bunkOverrides: bunkOverrides, bunkTimelines: bunkTimelines };
}

// =================================================================
// VALIDATION (standalone)
// =================================================================

function validate(layers, dateStr) {
    var errors = [];
    if (!layers || layers.length === 0) { errors.push('No layers defined'); return errors; }
    if (!dateStr) { errors.push('No date specified'); return errors; }
    var pinned = layers.filter(function(l) { return isLayerPinned(l); });
    for (var i = 0; i < pinned.length; i++) {
        for (var j = i + 1; j < pinned.length; j++) {
            var a = pinned[i], b = pinned[j];
            if (a.grade !== b.grade) continue;
            var wA = (a.endMin || 0) - (a.startMin || 0), wB = (b.endMin || 0) - (b.startMin || 0);
            var aEnd = a.startMin + Math.min(wA, getLayerDurationMax(a));
            var bEnd = b.startMin + Math.min(wB, getLayerDurationMax(b));
            if (a.startMin < bEnd && aEnd > b.startMin) errors.push('Overlapping pinned: "' + a.event + '" and "' + b.event + '"');
        }
    }
    return errors;
}

// =================================================================
// PUBLIC API
// =================================================================

window.AutoBuildEngine = {
    build: build, validate: validate,
    getSpecialActivities: getSpecialActivities, getSpecialDuration: getSpecialDuration,
    getSpecialConfig: getSpecialConfig, isScarceSpecial: isScarceSpecial,
    isSpecialAvailableOnDay: isSpecialAvailableOnDay, getRankedSpecials: getRankedSpecials,
    getFields: getFields, getDivisions: getDivisions, getDivisionTimes: getDivisionTimes,
    parseTime: parseTime, fmtTime: fmtTime, VERSION: VERSION
};

log('Auto Build Engine v' + VERSION + ' loaded');
})();
