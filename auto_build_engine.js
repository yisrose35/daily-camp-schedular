// =================================================================
// auto_build_engine.js — Campistry Auto Build Engine v3.2.3
// =================================================================
// Converts user-defined LAYERS + special activity config into:
//   1. A skeleton array (per-division time structure)
//   2. Bunk overrides (pre-assigned scarce/specific activities)
//
// These feed DIRECTLY into the existing pipeline:
//   skeleton → DivisionTimesSystem.buildFromSkeleton()
//            → scheduler_core_main.js (bunk overrides at Step 2)
//            → total_solver_engine.js (fills remaining slots)
//
// KEY DESIGN PRINCIPLES:
// - Scarce specials (limited availability) → bunk overrides
// - Fixed events (lunch, snacks, dismissal) → pinned skeleton blocks
// - Specials with known durations → sized skeleton blocks with _durationStrict
// - Sports → generic skeleton blocks (solver picks freely)
// - All existing infrastructure works unchanged
//
// LAYER FORMAT (from auto_schedule_planner.js):
// {
//   type: 'special' | 'sport' | 'lunch' | 'snack' | 'dismissal' | 'custom',
//   event: 'Special Activity' | 'Sports Slot' | 'Lunch' | ...,
//   quantity: { op: '>=', val: 1 } | { op: '=', val: 1 },
//   startMin: 540,    // time window start (minutes)
//   endMin: 1020,     // time window end (minutes)
//   duration: 20,     // activity duration in minutes
//   pinned: false,    // exact time (true) or flexible (false)
//   grade: '3rd Grade'
// }
//
// CHANGELOG:
//   v3.1 — Fixed league layers dropped, snack/lunch misroute, greedy fill,
//          DAW qty/op fields, added Phase 3.5 leagues, operator enforcement
//   v3.2 — Custom persistent tile classifier, auto change buffer insertion,
//          knapsack group packer (Phase 4 rewrite)
//   v3.2.3 — FIX #1: Sport score bias (median-based scoring for fair competition)
//            FIX #2: League force-placement (leagues no longer silently dropped)
//            FIX #3: Minimum duration enforcement (no more 25min sports when range is 30-50)
//   v3.2.4 — FIX #1: Balance enforcement in knapsack solver (sports/specials mix evenly)
//            FIX #2: Duration ceiling enforcement (blocks capped at durationMax, no 60min blocks)
//            FIX #3: League pinned:true removed (was causing Step 3 to skip league classification)
//   v3.2.8 — FIX #1: Scarce capacity reads sharableWith.capacity (was only serving 1 bunk)
//            FIX #2: Phase 4 respects activity configured duration (no more 120min blocks)
//            FIX #3: Per-bunk lunch rescheduling when displaced by scarce overrides
//            FIX #4: getSpecialTimeWindow falls back to timeRules from UI
// =================================================================

(function() {
'use strict';

const VERSION = '3.2.8';
const DEBUG = true;

function log(...args) { if (DEBUG) console.log('[AutoBuild]', ...args); }
function warn(...args) { console.warn('[AutoBuild] ⚠️', ...args); }

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
    let h = Math.floor(min / 60), m = min % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, '0')}${ap}`;
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
    
    // Check availableDays array (from special_activities UI)
    if (Array.isArray(specialConfig.availableDays) && specialConfig.availableDays.length > 0) {
        return specialConfig.availableDays.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
    }
    
    // Legacy: check dayAvailability object or array
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
    
    // ★★★ v3.2.8 FIX #4: Fall back to timeRules from Special Activities UI ★★★
    // The UI stores time restrictions as timeRules array, not as direct properties.
    // Extract the tightest "Available" window from timeRules.
    if (Array.isArray(specialConfig.timeRules) && specialConfig.timeRules.length > 0) {
        const availableRules = specialConfig.timeRules.filter(r => 
            r.type === 'Available' || !r.type
        );
        
        if (availableRules.length > 0) {
            // Use the broadest available window (earliest start, latest end)
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

function isScarceSpecial(specialConfig, dayName) {
    if (!specialConfig) return false;
    
    // ★★★ v3.2.7: availableDays from UI makes it scarce ★★★
    if (Array.isArray(specialConfig.availableDays) && specialConfig.availableDays.length > 0) {
        // Has day restrictions — it's scarce. Check if available today.
        if (!isSpecialAvailableOnDay(specialConfig, dayName)) return false;
        return true;
    }
    
    // Legacy dayAvailability check
    if (specialConfig.dayAvailability) {
        if (!isSpecialAvailableOnDay(specialConfig, dayName)) return false;
        return true;
    }
    
    // mustScheduleWhenAvailable flag also makes it scarce
    if (specialConfig.mustScheduleWhenAvailable) {
        return true;
    }
    
    const window = getSpecialTimeWindow(specialConfig);
    if (window && (window.endMin - window.startMin) < 180) return true;
    
    return false;
}

// ★★★ v3.2.2: Division/grade access check ★★★
// Returns true if the special is allowed for the given division.
// Uses limitUsage from the special_activities config:
//   - limitUsage.enabled=false → open to all
//   - limitUsage.enabled=true → only divisions listed in limitUsage.divisions
function isSpecialAvailableForDivision(specialName, divName) {
    const config = getSpecialConfig(specialName);
    if (!config) return true; // unknown special — allow
    
    const rules = config.limitUsage;
    if (!rules || !rules.enabled) return true; // open to all
    
    // Check if this division is in the allowed list
    const allowedDivs = rules.divisions;
    if (!allowedDivs || typeof allowedDivs !== 'object') return true;
    
    // divisions is an object like { "4th": [], "5th": [], "6th": [] }
    if (Array.isArray(allowedDivs)) {
        return allowedDivs.includes(divName);
    }
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
    
    // ★★★ v3.2.2 FIX: Filter out rainy-day-only specials on normal days ★★★
    // The solver (scheduler_core_loader) excludes rainy-day-only activities in normal mode,
    // so the auto engine must also exclude them to avoid assigning specials the solver can't use.
    const todaysSpecials = allSpecials.filter(s => {
        if (!isSpecialAvailableOnDay(s, dayName)) return false;
        if (!isRainy && s.rainyDayOnly) return false;
        return true;
    });
    const scarceSpecials = todaysSpecials.filter(s => isScarceSpecial(s, dayName));
    const regularSpecials = todaysSpecials.filter(s => !isScarceSpecial(s, dayName));
    
    log(`Specials — total: ${allSpecials.length}, today: ${todaysSpecials.length} (rainy: ${isRainy}), scarce: ${scarceSpecials.length}, regular: ${regularSpecials.length}`);
    
    const layersByGrade = {};
    layers.forEach(l => {
        const grade = l.grade || l.division || '_all';
        if (!layersByGrade[grade]) layersByGrade[grade] = [];
        layersByGrade[grade].push({ ...l });
    });
    
    const allSkeleton = [];
    const allBunkOverrides = [];
    const bunkTimelines = {};
    
    const baseLayersForAll = layersByGrade['_all'] || [];
    delete layersByGrade['_all'];
    
    const divisions = getDivisions();
    const gradesToProcess = Object.keys(layersByGrade).length > 0
        ? Object.keys(layersByGrade)
        : Object.keys(divisions);
    
    for (const gradeName of gradesToProcess) {
        const gradeLayers = [
            ...baseLayersForAll,
            ...(layersByGrade[gradeName] || [])
        ];
        
        if (gradeLayers.length === 0) {
            warn(`No layers for ${gradeName}, skipping`);
            continue;
        }
        
        const divName = getDivisionForGrade(gradeName);
        const bunks = getBunksForDivision(divName);
        const divTimes = getDivisionTimes(divName);
        
        if (bunks.length === 0) {
            warn(`No bunks for division ${divName}`);
            continue;
        }
        
        log(`\nProcessing ${gradeName} (div: ${divName}, ${bunks.length} bunks, ${gradeLayers.length} layers)`);
        
        const result = buildForGrade({
            gradeName,
            divName,
            bunks,
            layers: gradeLayers,
            dayName,
            dateStr,
            divTimes,
            scarceSpecials,
            regularSpecials,
            todaysSpecials,
            warnings
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

function buildForGrade({ gradeName, divName, bunks, layers, dayName, dateStr, divTimes, scarceSpecials, regularSpecials, todaysSpecials, warnings }) {
    const skeleton = [];
    const bunkOverrides = [];
    const bunkTimelines = {};
    
    // ★★★ v3.2.2: Log which specials are available for this division ★★★
    const divAvailableSpecials = regularSpecials.filter(s => isSpecialAvailableForDivision(s.name, divName));
    const divAvailableScarce = scarceSpecials.filter(s => isSpecialAvailableForDivision(s.name, divName));
    if (divAvailableSpecials.length < regularSpecials.length || divAvailableScarce.length < scarceSpecials.length) {
        log(`  [Division Access] ${divName}: ${divAvailableSpecials.length}/${regularSpecials.length} regular specials, ${divAvailableScarce.length}/${scarceSpecials.length} scarce specials available`);
        const blocked = regularSpecials.filter(s => !isSpecialAvailableForDivision(s.name, divName)).map(s => s.name);
        if (blocked.length > 0) log(`  [Division Access] Blocked for ${divName}: ${blocked.join(', ')}`);
    }
    
    // Initialize per-bunk state
    const bunkState = {};
    bunks.forEach(bunk => {
        bunkState[bunk] = {
            occupied: [],        // Array of { startMin, endMin, event, type }
            specialCount: 0,
            sportCount: 0,
            layersSatisfied: {}  // { layerIdx: quantity filled }
        };
        bunkTimelines[bunk] = [];
    });
    
    // =================================================================
    // LAYER CLASSIFICATION (v3.1 — fixed ordering + league support)
    // =================================================================
    // ★ Fixed events MUST be checked BEFORE pinned, otherwise a snack
    //   layer with pinned=true gets misrouted to pinnedLayers.
    // ★ League types now have their own buckets instead of falling
    //   into the customLayers catch-all.
    // =================================================================
    
    const pinnedLayers = [];          // exact time, all bunks (custom pinned, swim)
    const fixedLayers = [];           // windowed (lunch, snack, dismissal)
    const leagueLayers = [];          // ★ v3.1: regular leagues (whole grade)
    const specialtyLeagueLayers = []; // ★ v3.1: specialty leagues (whole grade)
    const specialLayers = [];         // specials >=N whole day
    const sportLayers = [];           // sports >=N whole day
    const customLayers = [];          // anything else
    
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
    
    layers.forEach((layer, idx) => {
        layer._idx = idx;
        const lType = (layer.type || '').toLowerCase();
        
        if (['lunch', 'snack', 'snacks', 'dismissal'].includes(lType)) {
            fixedLayers.push(layer);
        }
        else if (lType === 'league') {
            leagueLayers.push(layer);
        }
        else if (lType === 'specialty_league') {
            specialtyLeagueLayers.push(layer);
        }
        else if (window.CustomPersistentTiles?.isCustomType?.(lType)) {
            pinnedLayers.push(layer);
            log(`    Layer "${layer.event || lType}" → pinned (custom persistent tile)`);
        }
        else if (isLayerPinned(layer)) {
            pinnedLayers.push(layer);
        }
        else if (lType === 'special') {
            specialLayers.push(layer);
        }
        else if (lType === 'sport' || lType === 'sports') {
            sportLayers.push(layer);
        }
        else {
            customLayers.push(layer);
        }
    });
    
    log(`  Classified: ${pinnedLayers.length} pinned, ${fixedLayers.length} fixed, ` +
        `${leagueLayers.length} league, ${specialtyLeagueLayers.length} specialty_league, ` +
        `${specialLayers.length} special, ${sportLayers.length} sport, ${customLayers.length} custom`);
    
    // =================================================================
    // HELPER: Read quantity from a layer
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
    
    // =================================================================
    // Compute required quantities per type
    // =================================================================
    
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
    
    const specialReq = computeRequirements(specialLayers);
    const sportReq = computeRequirements(sportLayers);
    const leagueReq = computeRequirements(leagueLayers);
    const specialtyLeagueReq = computeRequirements(specialtyLeagueLayers);
    
    log(`  Requirements — Specials: min=${specialReq.min}, max=${specialReq.max} | ` +
        `Sports: min=${sportReq.min}, max=${sportReq.max} | ` +
        `Leagues: min=${leagueReq.min}, max=${leagueReq.max}`);
    
    
    // ═════════════════════════════════════════════════════════════════
    // PHASE 1: Place PINNED events (exact time, all bunks)
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 1] Pinned events: ${pinnedLayers.length}`);
    
    pinnedLayers.forEach(layer => {
        const startMin = layer.startMin;
        const endMin = layer.startMin + (getLayerDuration(layer) || (layer.endMin - layer.startMin));
        const eventName = layer.event || layer.type;
        const lType = (layer.type || '').toLowerCase();
        
        skeleton.push({
            id: 'auto_pinned_' + Math.random().toString(36).slice(2, 9),
            type: 'pinned',
            event: eventName,
            division: divName,
            startTime: fmtTime(startMin),
            endTime: fmtTime(endMin),
            pinned: true,
            _autoGenerated: true
        });
        
        let changeDur = 0;
        if (lType === 'swim') {
            const gs = getGlobalSettings();
            changeDur = parseInt(gs.app1?.changeBufferDuration) || parseInt(gs.changeBufferDuration) || 10;
        } else if (window.CustomPersistentTiles?.getChangeDuration) {
            changeDur = window.CustomPersistentTiles.getChangeDuration(lType) || 0;
        }
        
        bunks.forEach(bunk => {
            bunkState[bunk].occupied.push({
                startMin, endMin, event: eventName, type: 'pinned'
            });
            bunkTimelines[bunk].push({
                startMin, endMin, event: eventName, type: 'pinned',
                _autoGenerated: true
            });
            
            if (changeDur > 0 && endMin + changeDur <= divTimes.end) {
                const changeStart = endMin;
                const changeEnd = endMin + changeDur;
                
                bunkState[bunk].occupied.push({
                    startMin: changeStart, endMin: changeEnd,
                    event: 'Change', type: 'change_buffer'
                });
                bunkTimelines[bunk].push({
                    startMin: changeStart, endMin: changeEnd,
                    event: 'Change', type: 'change_buffer',
                    _autoGenerated: true, _changeFor: eventName
                });
                
                skeleton.push({
                    id: 'auto_change_' + Math.random().toString(36).slice(2, 9),
                    type: 'pinned',
                    event: 'Change',
                    division: divName,
                    startTime: fmtTime(changeStart),
                    endTime: fmtTime(changeEnd),
                    pinned: true,
                    _autoGenerated: true,
                    _bunk: bunk,
                    _changeFor: eventName
                });
            }
            
            if (changeDur > 0 && startMin - changeDur >= divTimes.start) {
                const hasBlockBefore = bunkState[bunk].occupied.some(o =>
                    o.endMin > startMin - changeDur && o.endMin <= startMin && o.type !== 'change_buffer'
                );
                if (hasBlockBefore || startMin > divTimes.start + 30) {
                    const preChangeStart = startMin - changeDur;
                    const preChangeEnd = startMin;
                    
                    const overlaps = bunkState[bunk].occupied.some(o =>
                        preChangeStart < o.endMin && preChangeEnd > o.startMin
                    );
                    
                    if (!overlaps) {
                        bunkState[bunk].occupied.push({
                            startMin: preChangeStart, endMin: preChangeEnd,
                            event: 'Change', type: 'change_buffer'
                        });
                        bunkTimelines[bunk].push({
                            startMin: preChangeStart, endMin: preChangeEnd,
                            event: 'Change', type: 'change_buffer',
                            _autoGenerated: true, _changeFor: eventName
                        });
                        
                        skeleton.push({
                            id: 'auto_prechange_' + Math.random().toString(36).slice(2, 9),
                            type: 'pinned',
                            event: 'Change',
                            division: divName,
                            startTime: fmtTime(preChangeStart),
                            endTime: fmtTime(preChangeEnd),
                            pinned: true,
                            _autoGenerated: true,
                            _bunk: bunk,
                            _changeFor: eventName
                        });
                    }
                }
            }
        });
        
        log(`    ${eventName}: ${fmtTime(startMin)}-${fmtTime(endMin)} (pinned, all bunks)` +
            (changeDur > 0 ? ` + ${changeDur}min change buffer` : ''));
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // PHASE 2: Place SCARCE specials (limited availability)
    // ═════════════════════════════════════════════════════════════════
    // E.g., Bubble Lady: Mon/Thu only, 1:00-2:00, capacity 3, 30min each.
    // 8 bunks → bunks 1-3 at 1:00-1:30, bunks 4-6 at 1:30-2:00, bunks 7-8 skip
    // These get bunk overrides so the solver assigns them specifically.
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 2] Scarce specials: ${scarceSpecials.length}`);
    
    scarceSpecials.forEach(specialConfig => {
        const name = specialConfig.name;
        
        // ★★★ v3.2.2: Skip scarce specials not available for this division ★★★
        if (!isSpecialAvailableForDivision(name, divName)) {
            log(`    ${name}: skipped — not available for division "${divName}"`);
            return;
        }
        
        const duration = specialConfig.defaultDuration || specialConfig.duration || 30;
        const timeWindow = getSpecialTimeWindow(specialConfig);
        
        if (!timeWindow) {
            warn(`Scarce special "${name}" has no time window, skipping`);
            return;
        }
        
        const windowStart = timeWindow.startMin;
        const windowEnd = timeWindow.endMin;
        
        // ★★★ v3.2.8 FIX #1: Read capacity from sharableWith (where UI stores it) ★★★
        // Previously read specialConfig.capacity which was undefined, falling back to 1.
        // The actual capacity is in sharableWith.capacity.
        const capacity = parseInt(specialConfig.sharableWith?.capacity)
            || parseInt(specialConfig.capacity)
            || 1;
        
        // Rank bunks by rotation (most overdue first)
        const rankedBunks = bunks.map(bunk => ({
            bunk,
            score: getRotationScore(bunk, name)
        })).sort((a, b) => a.score - b.score);
        
        // Calculate how many bunks can be served
        const slotsAvailable = Math.floor((windowEnd - windowStart) / duration);
        const totalCapacity = slotsAvailable * capacity;
        const bunksToServe = Math.min(bunks.length, totalCapacity);
        
        log(`    ${name}: window ${fmtTime(windowStart)}-${fmtTime(windowEnd)}, ` +
            `duration ${duration}min, capacity ${capacity}, ${slotsAvailable} time slots, ` +
            `serving ${bunksToServe}/${bunks.length} bunks`);
        
        // ★★★ v3.2.8: Check for conflicts with already-occupied time ★★★
        // Scarce overrides should avoid placing bunks at times they already have
        // pinned events (like swim). Skip conflicting times, try next slot.
        let slotCursor = windowStart;
        let served = 0;
        
        while (served < bunksToServe && slotCursor + duration <= windowEnd) {
            const slotStart = slotCursor;
            const slotEnd = slotCursor + duration;
            
            // Assign up to `capacity` bunks to this slot
            for (let c = 0; c < capacity && served < bunksToServe; c++) {
                const bunkInfo = rankedBunks[served];
                const bunk = bunkInfo.bunk;
                
                // ★★★ v3.2.8: Check if this bunk has a conflict at this time ★★★
                const hasConflict = bunkState[bunk].occupied.some(o =>
                    slotStart < o.endMin && slotEnd > o.startMin
                );
                
                if (hasConflict) {
                    log(`      ${bunk}: conflict at ${fmtTime(slotStart)}-${fmtTime(slotEnd)}, deferring`);
                    // Move this bunk to end of queue to try a later slot
                    rankedBunks.push(rankedBunks.splice(served, 1)[0]);
                    continue; // don't increment served, try next bunk in queue
                }
                
                bunkOverrides.push({
                    bunk,
                    division: divName,
                    activity: name,
                    type: 'special',
                    startTime: fmtTime(slotStart),
                    endTime: fmtTime(slotEnd),
                    _autoGenerated: true,
                    _scarce: true
                });
                
                bunkState[bunk].occupied.push({
                    startMin: slotStart, endMin: slotEnd,
                    event: name, type: 'scarce_special'
                });
                bunkState[bunk].specialCount++;
                
                bunkTimelines[bunk].push({
                    startMin: slotStart, endMin: slotEnd,
                    event: name, type: 'scarce_special',
                    _autoGenerated: true
                });
                
                served++;
            }
            
            slotCursor = slotEnd;
        }
        
        if (served < bunksToServe) {
            log(`    ${name}: Could only serve ${served}/${bunksToServe} bunks (time/conflict constraints)`);
            warnings.push(`${name}: Only ${served}/${bunksToServe} bunks could be scheduled`);
        }
        
        // Also add a skeleton block so the optimizer knows this time range exists
        if (served > 0) {
            skeleton.push({
                id: 'auto_scarce_' + Math.random().toString(36).slice(2, 9),
                type: 'slot',
                event: 'Special Activity',
                division: divName,
                startTime: fmtTime(windowStart),
                endTime: fmtTime(Math.min(windowEnd, windowStart + duration * Math.ceil(served / capacity))),
                _autoGenerated: true,
                _scarceEvent: name
            });
        }
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // PHASE 3: Place FIXED/WINDOWED events (lunch, snacks, dismissal)
    // ═════════════════════════════════════════════════════════════════
    // ★★★ v3.2.8 FIX #3: Per-bunk placement when scarce overrides conflict.
    // Previously Phase 3 placed lunch at ONE time for ALL bunks. When a
    // scarce override occupied lunch time for some bunks, lunch was either
    // skipped or moved for everyone. Now bunks with scarce conflicts get
    // individual lunch times via bunk overrides.
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 3] Fixed events: ${fixedLayers.length}`);
    
    const sortedFixed = [...fixedLayers].sort((a, b) => {
        const aSpan = (a.endMin || a.startMin + 60) - a.startMin;
        const bSpan = (b.endMin || b.startMin + 60) - b.startMin;
        return aSpan - bSpan;
    });
    
    sortedFixed.forEach(layer => {
        const duration = getLayerDuration(layer);
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        const eventName = layer.event || layer.type;
        
        // If window === duration, it's effectively pinned (exact time)
        if (windowEnd - windowStart <= duration) {
            skeleton.push({
                id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9),
                type: 'pinned',
                event: eventName,
                division: divName,
                startTime: fmtTime(windowStart),
                endTime: fmtTime(windowStart + duration),
                pinned: true,
                _autoGenerated: true
            });
            
            bunks.forEach(bunk => {
                // ★★★ v3.2.8: Check if bunk has scarce conflict at exact time ★★★
                const hasConflict = bunkState[bunk].occupied.some(o =>
                    o.type === 'scarce_special' &&
                    windowStart < o.endMin && (windowStart + duration) > o.startMin
                );
                
                if (hasConflict) {
                    // Find alternative time for this bunk within a wider window
                    const altPlacement = findPerBunkFixedPlacement(
                        bunk, bunkState[bunk].occupied, eventName, duration,
                        windowStart, windowEnd, divTimes
                    );
                    if (altPlacement) {
                        bunkState[bunk].occupied.push({
                            startMin: altPlacement.startMin, endMin: altPlacement.endMin,
                            event: eventName, type: 'fixed'
                        });
                        bunkTimelines[bunk].push({
                            startMin: altPlacement.startMin, endMin: altPlacement.endMin,
                            event: eventName, type: 'fixed', _autoGenerated: true
                        });
                        bunkOverrides.push({
                            bunk, division: divName, activity: eventName, type: 'pinned',
                            startTime: fmtTime(altPlacement.startMin),
                            endTime: fmtTime(altPlacement.endMin),
                            _autoGenerated: true, _displacedBy: 'scarce_special', _perBunkFixed: true
                        });
                        log(`      ${bunk}: ${eventName} displaced by scarce → moved to ${fmtTime(altPlacement.startMin)}-${fmtTime(altPlacement.endMin)}`);
                    } else {
                        warn(`${bunk}: Could not place ${eventName} — scarce conflict unresolvable at exact time`);
                    }
                } else {
                    bunkState[bunk].occupied.push({
                        startMin: windowStart, endMin: windowStart + duration,
                        event: eventName, type: 'fixed'
                    });
                    bunkTimelines[bunk].push({
                        startMin: windowStart, endMin: windowStart + duration,
                        event: eventName, type: 'fixed', _autoGenerated: true
                    });
                }
            });
            
            log(`    ${eventName}: ${fmtTime(windowStart)}-${fmtTime(windowStart + duration)} (exact fixed)`);
            return;
        }
        
        // ★★★ v3.2.8 FIX #3: Windowed placement with per-bunk scarce awareness ★★★
        // First: find best placement ignoring scarce conflicts (since scarce is per-bunk)
        const sharedOccupied = getSharedOccupied(bunkState, bunks);
        const nonScarceOccupied = sharedOccupied.filter(o => o.type !== 'scarce_special');
        
        // Try placement avoiding only non-scarce conflicts
        let placement = findBestPlacement(
            windowStart, windowEnd, duration,
            nonScarceOccupied,
            divTimes
        );
        
        if (!placement) {
            // Fall back to checking ALL conflicts
            placement = findBestPlacement(
                windowStart, windowEnd, duration,
                sharedOccupied,
                divTimes
            );
        }
        
        if (!placement) {
            warn(`Could not place ${eventName} within ${fmtTime(windowStart)}-${fmtTime(windowEnd)}`);
            warnings.push(`Could not place ${eventName} within its time window`);
            return;
        }
        
        // Add the skeleton block at the main placement time
        skeleton.push({
            id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9),
            type: 'pinned',
            event: eventName,
            division: divName,
            startTime: fmtTime(placement.startMin),
            endTime: fmtTime(placement.endMin),
            pinned: true,
            _autoGenerated: true
        });
        
        // ★★★ v3.2.8: Per-bunk placement — check each bunk for scarce conflicts ★★★
        const isLunchOrSnack = /lunch|snack/i.test(eventName);
        
        bunks.forEach(bunk => {
            const hasConflict = bunkState[bunk].occupied.some(o =>
                o.type === 'scarce_special' &&
                placement.startMin < o.endMin && placement.endMin > o.startMin
            );
            
            if (hasConflict && isLunchOrSnack) {
                // This bunk has Bubble Lady (or similar) during lunch — find alternative
                const altPlacement = findPerBunkFixedPlacement(
                    bunk, bunkState[bunk].occupied, eventName, duration,
                    windowStart, windowEnd, divTimes
                );
                
                if (altPlacement) {
                    bunkState[bunk].occupied.push({
                        startMin: altPlacement.startMin, endMin: altPlacement.endMin,
                        event: eventName, type: 'fixed'
                    });
                    bunkTimelines[bunk].push({
                        startMin: altPlacement.startMin, endMin: altPlacement.endMin,
                        event: eventName, type: 'fixed', _autoGenerated: true
                    });
                    bunkOverrides.push({
                        bunk, division: divName, activity: eventName, type: 'pinned',
                        startTime: fmtTime(altPlacement.startMin),
                        endTime: fmtTime(altPlacement.endMin),
                        _autoGenerated: true, _displacedBy: 'scarce_special', _perBunkFixed: true
                    });
                    log(`      ${bunk}: ${eventName} moved to ${fmtTime(altPlacement.startMin)}-${fmtTime(altPlacement.endMin)} (scarce conflict)`);
                } else {
                    warn(`${bunk}: Could not place ${eventName} — scarce conflict unresolvable`);
                    warnings.push(`${bunk}: ${eventName} could not be placed (scarce conflict)`);
                    // Still mark the standard time as occupied so Phase 4 doesn't fill it
                    bunkState[bunk].occupied.push({
                        startMin: placement.startMin, endMin: placement.endMin,
                        event: eventName, type: 'fixed'
                    });
                    bunkTimelines[bunk].push({
                        startMin: placement.startMin, endMin: placement.endMin,
                        event: eventName, type: 'fixed', _autoGenerated: true
                    });
                }
            } else {
                // No conflict — standard placement
                bunkState[bunk].occupied.push({
                    startMin: placement.startMin, endMin: placement.endMin,
                    event: eventName, type: 'fixed'
                });
                bunkTimelines[bunk].push({
                    startMin: placement.startMin, endMin: placement.endMin,
                    event: eventName, type: 'fixed', _autoGenerated: true
                });
            }
        });
        
        log(`    ${eventName}: ${fmtTime(placement.startMin)}-${fmtTime(placement.endMin)}`);
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // ★ PHASE 3.5: Place LEAGUE skeleton blocks (v3.1 — NEW)
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 3.5] Leagues: ${leagueLayers.length} regular, ${specialtyLeagueLayers.length} specialty`);
    
    const allLeagueLayers = [...leagueLayers, ...specialtyLeagueLayers];
    
    allLeagueLayers.forEach(layer => {
        const isSpecialty = (layer.type || '').toLowerCase() === 'specialty_league';
        const duration = getLayerDuration(layer);
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        const qty = getLayerQty(layer);
        
        const count = Math.max(qty, 1);
        
        for (let i = 0; i < count; i++) {
            let placement = findBestPlacement(
                windowStart, windowEnd, duration,
                getSharedOccupied(bunkState, bunks),
                divTimes
            );
            
            if (!placement) {
                warn(`Could not find gap for league ${i + 1}/${count} — force-placing at window start ${fmtTime(windowStart)}`);
                placement = { startMin: windowStart, endMin: windowStart + duration };
            }
            
            skeleton.push({
                id: 'auto_league_' + Math.random().toString(36).slice(2, 9),
                type: isSpecialty ? 'specialty_league' : 'league',
                event: isSpecialty ? 'Specialty League' : 'League Game',
                division: divName,
                startTime: fmtTime(placement.startMin),
                endTime: fmtTime(placement.endMin),
                _autoGenerated: true
            });
            
            bunks.forEach(bunk => {
                bunkState[bunk].occupied.push({
                    startMin: placement.startMin, endMin: placement.endMin,
                    event: isSpecialty ? 'Specialty League' : 'League Game',
                    type: isSpecialty ? 'specialty_league' : 'league'
                });
                bunkTimelines[bunk].push({
                    startMin: placement.startMin, endMin: placement.endMin,
                    event: isSpecialty ? 'Specialty League' : 'League Game',
                    type: isSpecialty ? 'specialty_league' : 'league',
                    _autoGenerated: true
                });
            });
            
            log(`    ${isSpecialty ? 'Specialty League' : 'League'} #${i + 1}: ` +
                `${fmtTime(placement.startMin)}-${fmtTime(placement.endMin)} (all bunks)`);
        }
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // PHASE 4: KNAPSACK GROUP PACKER (v3.2)
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 4] Knapsack group packer (v3.2.8)...`);
    log(`    Special rules: op=${specialReq.hasExact ? '=' : '>='} min=${specialReq.min} max=${specialReq.max}`);
    log(`    Sport rules: op=${sportReq.hasExact ? '=' : '>='} min=${sportReq.min} max=${sportReq.max}`);
    
    const specialSlotUsage = {};
    
    function getSpecialCapacity(specialName) {
        const config = getSpecialConfig(specialName);
        if (!config) return 2;
        if (config.sharableWith) {
            if (config.sharableWith.capacity !== undefined) {
                const cap = parseInt(config.sharableWith.capacity);
                if (!isNaN(cap) && cap > 0) return cap;
            }
            if (config.sharableWith.type === 'not_sharable') return 1;
        }
        if (config.capacity) return parseInt(config.capacity);
        if (config.maxBunks) return parseInt(config.maxBunks);
        return 2;
    }
    
    function isSpecialAtCapacity(specialName, gapStartMin) {
        const key = specialName + '|' + gapStartMin;
        const used = specialSlotUsage[key] || 0;
        const cap = getSpecialCapacity(specialName);
        return used >= cap;
    }
    
    function recordSpecialUsage(specialName, gapStartMin) {
        const key = specialName + '|' + gapStartMin;
        specialSlotUsage[key] = (specialSlotUsage[key] || 0) + 1;
    }
    
    // Duration hints from layers
    const specialDur = specialLayers.length > 0 ? getLayerDuration(specialLayers[0]) : 30;
    const sportDurMin = sportLayers.length > 0 ? getLayerDuration(sportLayers[0]) : 30;
    const sportDurMax = sportLayers.length > 0 ? getLayerDurationMax(sportLayers[0]) : sportDurMin;
    const sportDurIdeal = Math.round((sportDurMin + sportDurMax) / 2);
    
    const minActivityDur = Math.min(sportDurMin, specialDur, 30);
    const maxActivityDur = Math.max(sportDurMax, specialDur, 50);
    
    // ─────────────────────────────────────────────────────────
    // Build the unified pool of all assignable activities
    // ─────────────────────────────────────────────────────────
    
    function buildActivityPool(bunk, gapStartMin) {
        const pool = [];
        
        const availableSpecialNames = regularSpecials.map(s => s.name);
        const rankedSpecials = getRankedSpecials(bunk, availableSpecialNames);
        rankedSpecials.forEach(s => {
            if (!isSpecialAvailableForDivision(s.name, divName)) return;
            if (gapStartMin !== undefined && isSpecialAtCapacity(s.name, gapStartMin)) return;
            
            // ★★★ v3.2.8 FIX #2: Use configured duration from special config ★★★
            // Previously used the generic specialDur from the layer, which could
            // allow a 30min activity to get a 120min block. Now reads the actual
            // configured duration for each specific special.
            const configuredDuration = getSpecialDuration(s.name) || s.duration || specialDur;
            
            pool.push({
                name: s.name,
                duration: configuredDuration,
                score: s.score,
                type: 'special',
                _fromPool: true,
                _configuredDuration: configuredDuration
            });
        });
        
        // Add sports with duration options (filtered by layer constraints)
        const sportDurations = [];
        if (sportDurMin <= maxActivityDur) sportDurations.push(sportDurMin);
        if (sportDurIdeal !== sportDurMin && sportDurIdeal <= maxActivityDur) sportDurations.push(sportDurIdeal);
        if (sportDurMax !== sportDurIdeal && sportDurMax !== sportDurMin && sportDurMax <= maxActivityDur) sportDurations.push(sportDurMax);
        
        const specialScores = pool.filter(p => p.type === 'special').map(p => p.score);
        const medianSpecialScore = specialScores.length > 0
            ? specialScores.sort((a, b) => a - b)[Math.floor(specialScores.length / 2)]
            : 50;
        
        sportDurations.forEach((dur, idx) => {
            pool.push({
                name: `Sport_${dur}min`,
                duration: dur,
                score: medianSpecialScore + idx,
                type: 'sport',
                _fromPool: true,
                _sportDuration: dur
            });
        });
        
        pool.sort((a, b) => a.score - b.score);
        return pool;
    }
    
    // ─────────────────────────────────────────────────────────
    // Knapsack solver
    // ─────────────────────────────────────────────────────────
    
    function packGap(pool, timeAvailable, constraints) {
        const { maxSpecials, maxSports, usedToday, needSpecials, needSports } = constraints;
        const usedSet = new Set((usedToday || []).map(n => n.toLowerCase()));
        
        const available = pool.filter(a => {
            if (a.type === 'sport') return true;
            return !usedSet.has(a.name.toLowerCase());
        });
        
        if (available.length === 0) return [];
        
        const maxItems = Math.min(6, Math.ceil(timeAvailable / 10));
        
        let bestCombo = null;
        let bestScore = Infinity;
        let bestRemainder = Infinity;
        
        const bothNeeded = (needSpecials > 0 && needSports > 0);
        
        function getBalancedScore(totalScore, specCount, sportCount) {
            if (!bothNeeded) return totalScore;
            if (specCount > 0 && sportCount > 0) return totalScore - 500;
            return totalScore;
        }
        
        function search(idx, remaining, combo, totalScore, specCount, sportCount) {
            const fitThreshold = Math.min(sportDurMin, specialDur, 30);
            if (remaining >= 0 && remaining <= fitThreshold) {
                const balancedScore = getBalancedScore(totalScore, specCount, sportCount);
                if (remaining < bestRemainder ||
                    (remaining === bestRemainder && balancedScore < bestScore)) {
                    bestCombo = [...combo];
                    bestScore = balancedScore;
                    bestRemainder = remaining;
                }
                if (remaining === 0 && (!bothNeeded || (specCount > 0 && sportCount > 0))) return;
            }
            
            if (remaining <= 0 || combo.length >= maxItems) return;
            
            for (let i = idx; i < available.length; i++) {
                const act = available[i];
                if (act.duration > remaining) continue;
                
                if (act.type === 'special' && maxSpecials !== undefined && specCount >= maxSpecials) continue;
                if (act.type === 'sport' && maxSports !== undefined && sportCount >= maxSports) continue;
                
                if (act.type === 'special' && combo.some(c => c.name === act.name)) continue;
                if (act.type === 'sport' && combo.some(c => c.type === 'sport' && c.duration === act.duration)) continue;
                
                combo.push(act);
                search(
                    i + 1,
                    remaining - act.duration,
                    combo,
                    totalScore + act.score,
                    specCount + (act.type === 'special' ? 1 : 0),
                    sportCount + (act.type === 'sport' ? 1 : 0)
                );
                combo.pop();
                
                if (bestRemainder === 0 && (!bothNeeded || bestScore < 0)) return;
            }
        }
        
        search(0, timeAvailable, [], 0, 0, 0);
        
        if (!bestCombo || bestCombo.length === 0) {
            const fits = available.filter(a => a.duration <= timeAvailable);
            if (fits.length > 0) {
                bestCombo = [fits[0]];
            }
        }
        
        // Balance enforcement
        if (bestCombo && bestCombo.length >= 2 && bothNeeded) {
            const specInCombo = bestCombo.filter(c => c.type === 'special').length;
            const sportInCombo = bestCombo.filter(c => c.type === 'sport').length;
            
            if (specInCombo === 0) {
                const specCand = available.find(a => a.type === 'special' && a.duration <= (bestCombo[bestCombo.length - 1]?.duration || timeAvailable));
                if (specCand) bestCombo[bestCombo.length - 1] = specCand;
            } else if (sportInCombo === 0) {
                const sportCand = available.find(a => a.type === 'sport' && a.duration <= (bestCombo[bestCombo.length - 1]?.duration || timeAvailable));
                if (sportCand) bestCombo[bestCombo.length - 1] = sportCand;
            }
        }
        
        if (bestCombo && needSpecials > 0) {
            const specInCombo = bestCombo.filter(c => c.type === 'special').length;
            if (specInCombo === 0) {
                const specCand = available.find(a => a.type === 'special' && a.duration <= timeAvailable);
                if (specCand) {
                    const sportIdx = bestCombo.findIndex(c => c.type === 'sport');
                    if (sportIdx >= 0) bestCombo[sportIdx] = specCand;
                }
            }
        }
        
        return bestCombo || [];
    }
    
    // ─────────────────────────────────────────────────────────
    // ★★★ v3.2.7: Pre-compute UNIFORM gap templates ★★★
    // ─────────────────────────────────────────────────────────
    
    const sharedOccupied = getSharedOccupied(bunkState, bunks);
    const sharedGaps = findGaps(sharedOccupied, divTimes);
    
    const gapTemplates = {};
    sharedGaps.forEach(gap => {
        const gapDur = gap.endMin - gap.startMin;
        if (gapDur < minActivityDur) return;
        
        const template = [];
        let cursor = gap.startMin;
        
        let useSpecial = true;
        while (cursor + minActivityDur <= gap.endMin) {
            const remaining = gap.endMin - cursor;
            let blockDur;
            
            if (useSpecial) {
                blockDur = Math.min(specialDur, remaining, maxActivityDur);
            } else {
                blockDur = Math.min(sportDurMin, remaining, maxActivityDur);
            }
            
            if (remaining < minActivityDur * 2 && remaining <= maxActivityDur) {
                blockDur = remaining;
            }
            
            if (blockDur < minActivityDur) break;
            
            // ★★★ v3.2.8 FIX #2: Cap block duration at maxActivityDur ★★★
            // Prevents creating oversized blocks (e.g., 120min) when gap is large.
            blockDur = Math.min(blockDur, maxActivityDur);
            
            template.push({
                startMin: cursor,
                endMin: cursor + blockDur,
                duration: blockDur,
                preferredType: useSpecial ? 'special' : 'sport'
            });
            
            cursor += blockDur;
            useSpecial = !useSpecial;
        }
        
        // If there's a small remainder, extend the last block (but not beyond max)
        if (cursor < gap.endMin && template.length > 0) {
            const last = template[template.length - 1];
            const extended = last.duration + (gap.endMin - cursor);
            if (extended <= maxActivityDur) {
                last.endMin = gap.endMin;
                last.duration = extended;
            } else {
                // ★★★ v3.2.8: Remainder too large to absorb — add another block ★★★
                const remainderDur = gap.endMin - cursor;
                if (remainderDur >= minActivityDur) {
                    template.push({
                        startMin: cursor,
                        endMin: gap.endMin,
                        duration: remainderDur,
                        preferredType: useSpecial ? 'special' : 'sport'
                    });
                }
            }
        }
        
        gapTemplates[gap.startMin] = template;
        log(`    Gap template ${fmtTime(gap.startMin)}-${fmtTime(gap.endMin)}: ${template.map(t => `${t.duration}min ${t.preferredType}`).join(' + ')}`);
    });
    
    // ─────────────────────────────────────────────────────────
    // Process each bunk USING the shared templates
    // ─────────────────────────────────────────────────────────
    
    bunks.forEach(bunk => {
        const state = bunkState[bunk];
        const gaps = findGaps(state.occupied, divTimes);
        
        if (gaps.length === 0) {
            log(`    ${bunk}: No gaps to fill`);
            return;
        }
        
        const gapsCopy = [...gaps].sort((a, b) => a.startMin - b.startMin);
        let totalGapMinutes = 0;
        gapsCopy.forEach(g => { totalGapMinutes += (g.endMin - g.startMin); });
        
        log(`    ${bunk}: ${gapsCopy.length} gaps (${totalGapMinutes}min total), already ${state.specialCount} specials`);
        
        const usedToday = [];
        bunkTimelines[bunk].forEach(t => {
            if (t.event && t.event !== 'Change') usedToday.push(t.event);
            if (t._hintActivity) usedToday.push(t._hintActivity);
        });
        
        let placedSpecials = state.specialCount;
        let placedSports = state.sportCount;
        
        const specialMaxCap = specialReq.max < Infinity ? specialReq.max : 999;
        const sportMaxCap = sportReq.max < Infinity ? sportReq.max : 999;
        let specialsStillNeeded = Math.max(0, specialReq.min - placedSpecials);
        let sportsStillNeeded = Math.max(0, sportReq.min - placedSports);
        
        for (const gap of gapsCopy) {
            const groupDuration = gap.endMin - gap.startMin;
            if (groupDuration < 5) continue;
            
            let template = gapTemplates[gap.startMin];
            
            if (!template) {
                const templateKeys = Object.keys(gapTemplates).map(Number);
                const closest = templateKeys.find(k => Math.abs(k - gap.startMin) <= 5);
                if (closest !== undefined) template = gapTemplates[closest];
            }
            
            if (!template || template.length === 0) {
                log(`      ${bunk}: No template for gap ${fmtTime(gap.startMin)}-${fmtTime(gap.endMin)}, creating uniform blocks`);
                template = [];
                let tc = gap.startMin;
                let tUseSpec = specialsStillNeeded > 0;
                while (tc + minActivityDur <= gap.endMin) {
                    const tRemaining = gap.endMin - tc;
                    let tDur = tUseSpec ? Math.min(specialDur, tRemaining, maxActivityDur) : Math.min(sportDurMin, tRemaining, maxActivityDur);
                    if (tRemaining < minActivityDur * 2 && tRemaining <= maxActivityDur) tDur = tRemaining;
                    // ★★★ v3.2.8: Cap at maxActivityDur ★★★
                    tDur = Math.min(tDur, maxActivityDur);
                    if (tDur < minActivityDur) break;
                    template.push({ startMin: tc, endMin: tc + tDur, duration: tDur, preferredType: tUseSpec ? 'special' : 'sport' });
                    tc += tDur;
                    tUseSpec = !tUseSpec;
                }
                if (template.length === 0) continue;
            }
            
            const pool = buildActivityPool(bunk, gap.startMin);
            
            for (const tmpl of template) {
                const blockStart = tmpl.startMin;
                const blockEnd = tmpl.endMin;
                const blockDur = tmpl.duration;
                
                let pickType = tmpl.preferredType;
                if (pickType === 'special' && specialsStillNeeded <= 0 && sportsStillNeeded > 0) {
                    pickType = 'sport';
                } else if (pickType === 'sport' && sportsStillNeeded <= 0 && specialsStillNeeded > 0) {
                    pickType = 'special';
                }
                
                if (pickType === 'special') {
                    const availableSpecials = pool.filter(p => p.type === 'special' && !usedToday.includes(p.name.toLowerCase()));
                    if (availableSpecials.length === 0) pickType = 'sport';
                }
                
                const isSpecial = pickType === 'special';
                const eventLabel = isSpecial ? 'Special Activity' : 'Sports Slot';
                
                let hintActivity = null;
                if (isSpecial) {
                    const specCandidates = pool.filter(p => p.type === 'special' && !usedToday.map(u => u.toLowerCase()).includes(p.name.toLowerCase()));
                    if (specCandidates.length > 0) {
                        hintActivity = specCandidates[0].name;
                    }
                }
                
                skeleton.push({
                    id: 'auto_' + (isSpecial ? 'spec' : 'sport') + '_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: eventLabel,
                    division: divName,
                    startTime: fmtTime(blockStart),
                    endTime: fmtTime(blockEnd),
                    _autoGenerated: true,
                    _durationStrict: true,
                    _minDuration: isSpecial ? specialDur : sportDurMin,
                    _bunk: bunk,
                    _targetDuration: blockDur,
                    _hintActivity: hintActivity,
                    _activityGroup: gap.startMin
                });
                
                bunkTimelines[bunk].push({
                    startMin: blockStart, endMin: blockEnd,
                    event: eventLabel,
                    type: isSpecial ? 'special_slot' : 'sport_slot',
                    _durationStrict: true,
                    _minDuration: isSpecial ? specialDur : sportDurMin,
                    _targetDuration: blockDur,
                    _hintActivity: hintActivity,
                    _autoGenerated: true,
                    _activityGroup: gap.startMin
                });
                
                state.occupied.push({
                    startMin: blockStart, endMin: blockEnd,
                    event: eventLabel, type: isSpecial ? 'special_slot' : 'sport_slot'
                });
                
                if (isSpecial) {
                    placedSpecials++;
                    state.specialCount++;
                    specialsStillNeeded = Math.max(0, specialsStillNeeded - 1);
                    
                    if (hintActivity) {
                        recordSpecialUsage(hintActivity, gap.startMin);
                        usedToday.push(hintActivity);
                        
                        bunkOverrides.push({
                            bunk,
                            division: divName,
                            activity: hintActivity,
                            type: 'special',
                            startTime: fmtTime(blockStart),
                            endTime: fmtTime(blockEnd),
                            _autoGenerated: true,
                            _knapsack: true
                        });
                    }
                } else {
                    placedSports++;
                    state.sportCount++;
                    sportsStillNeeded = Math.max(0, sportsStillNeeded - 1);
                    usedToday.push(`Sport_${blockDur}min`);
                }
                
                log(`      ${bunk}: ${isSpecial ? (hintActivity || 'Special') : 'Sport'} (${pickType}, ${blockDur}min) → ${fmtTime(blockStart)}-${fmtTime(blockEnd)}`);
            }
        }
        
        if (specialReq.min > 0 && placedSpecials < specialReq.min) {
            warnings.push(`${bunk}: Only ${placedSpecials}/${specialReq.min} specials placed`);
        }
        if (sportReq.min > 0 && placedSports < sportReq.min) {
            warnings.push(`${bunk}: Only ${placedSports}/${sportReq.min} sports placed`);
        }
        if (specialReq.max < Infinity && placedSpecials > specialReq.max) {
            warnings.push(`${bunk}: ${placedSpecials} specials exceeds max ${specialReq.max}`);
        }
        if (sportReq.max < Infinity && placedSports > sportReq.max) {
            warnings.push(`${bunk}: ${placedSports} sports exceeds max ${sportReq.max}`);
        }
        
        log(`    ${bunk} DONE: ${placedSpecials} specials + ${placedSports} sports (${usedToday.length} total activities)`);
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // PHASE 5: Sort timelines
    // ═════════════════════════════════════════════════════════════════
    
    Object.values(bunkTimelines).forEach(timeline => {
        timeline.sort((a, b) => a.startMin - b.startMin);
    });
    
    return { skeleton, bunkOverrides, bunkTimelines };
}

// =================================================================
// PLACEMENT HELPERS
// =================================================================

/**
 * Get occupied ranges shared across ALL bunks (pinned + scarce events)
 */
function getSharedOccupied(bunkState, bunks) {
    const shared = [];
    const seen = new Set();
    
    bunks.forEach(bunk => {
        bunkState[bunk].occupied.forEach(occ => {
            const key = `${occ.startMin}-${occ.endMin}-${occ.event}`;
            if (occ.type === 'pinned' || occ.type === 'scarce_special' || occ.type === 'fixed' || occ.type === 'league' || occ.type === 'specialty_league' || occ.type === 'change_buffer') {
                if (!seen.has(key)) {
                    seen.add(key);
                    shared.push(occ);
                }
            }
        });
    });
    
    return shared;
}

/**
 * Find the best placement for a fixed event within a window
 */
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
            const distFromCenter = Math.abs(blockCenter - windowCenter);
            
            candidates.push({ startMin: start, endMin: end, score: distFromCenter });
        }
    }
    
    if (candidates.length === 0) return null;
    
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
}

/**
 * ★★★ v3.2.8 NEW: Find alternative placement for a specific bunk's fixed event
 * when a scarce override creates a conflict. Searches:
 * 1. Within the original window (different time than main placement)
 * 2. Right after the scarce activity ends
 * 3. Right before the scarce activity starts
 */
function findPerBunkFixedPlacement(bunk, bunkOccupied, eventName, duration, windowStart, windowEnd, divTimes) {
    // Strategy 1: Find a gap within the original window
    for (let start = windowStart; start + duration <= windowEnd; start += 5) {
        const end = start + duration;
        const hasConflict = bunkOccupied.some(o =>
            start < o.endMin && end > o.startMin
        );
        if (!hasConflict) {
            return { startMin: start, endMin: end };
        }
    }
    
    // Strategy 2: Place right after the conflicting scarce activity
    const scarceBlocks = bunkOccupied.filter(o => o.type === 'scarce_special');
    for (const scarce of scarceBlocks) {
        const afterStart = scarce.endMin;
        const afterEnd = afterStart + duration;
        if (afterEnd <= divTimes.end) {
            const hasConflict = bunkOccupied.some(o =>
                afterStart < o.endMin && afterEnd > o.startMin
            );
            if (!hasConflict) {
                return { startMin: afterStart, endMin: afterEnd };
            }
        }
    }
    
    // Strategy 3: Place right before the conflicting scarce activity
    for (const scarce of scarceBlocks) {
        const beforeEnd = scarce.startMin;
        const beforeStart = beforeEnd - duration;
        if (beforeStart >= divTimes.start) {
            const hasConflict = bunkOccupied.some(o =>
                beforeStart < o.endMin && beforeEnd > o.startMin
            );
            if (!hasConflict) {
                return { startMin: beforeStart, endMin: beforeEnd };
            }
        }
    }
    
    return null;
}

/**
 * Find free gaps in a bunk's timeline
 */
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
        if (gapEnd > gapStart + 5) {
            gaps.push({ startMin: gapStart, endMin: gapEnd });
        }
    }
    
    const lastEnd = sorted[sorted.length - 1].endMin;
    if (lastEnd < divTimes.end) {
        gaps.push({ startMin: lastEnd, endMin: divTimes.end });
    }
    
    return gaps;
}

/**
 * Get total required quantity from layers
 */
function getRequiredQuantity(layers) {
    if (layers.length === 0) return 0;
    let total = 0;
    layers.forEach(l => {
        const qty = l.qty || l.quantity?.val || l.quantity || 1;
        total = Math.max(total, qty);
    });
    return total;
}

// =================================================================
// VALIDATION
// =================================================================

function validate(layers, dateStr) {
    const errors = [];
    
    if (!layers || layers.length === 0) {
        errors.push('No layers defined');
        return errors;
    }
    
    if (!dateStr) {
        errors.push('No date specified');
        return errors;
    }
    
    const pinned = layers.filter(l => l.pinned);
    for (let i = 0; i < pinned.length; i++) {
        for (let j = i + 1; j < pinned.length; j++) {
            const a = pinned[i], b = pinned[j];
            if (a.grade !== b.grade) continue;
            const aEnd = a.startMin + (a.duration || 30);
            const bEnd = b.startMin + (b.duration || 30);
            if (a.startMin < bEnd && aEnd > b.startMin) {
                errors.push(`Overlapping pinned events: "${a.event}" and "${b.event}"`);
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
    
    // Helpers exposed for UI
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
