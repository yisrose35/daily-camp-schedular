// =================================================================
// auto_build_engine.js — Campistry Auto Build Engine v3.2
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
// =================================================================

(function() {
'use strict';

const VERSION = '3.2.2';
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
    return null;
}

function isScarceSpecial(specialConfig, dayName) {
    if (!specialConfig) return false;
    
    if (specialConfig.dayAvailability) {
        if (!isSpecialAvailableOnDay(specialConfig, dayName)) return false;
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
    
    // Helper: determine if a layer is "pinned" (exact time, immovable)
    // The DAW UI uses `anchor:true` on the layer TYPE definition (swim, custom, 
    // lunch, snacks, dismissal). When dropped, anchor layers get op='=' and
    // durationMin === window size. But the layer object itself does NOT carry
    // a `pinned` or `pinExact` flag from the DAW path.
    //
    // Pinned detection rules:
    //   1. layer.pinned === true  (from planner/import path)
    //   2. layer.pinExact === true (from planner path)
    //   3. layer.type is 'swim' or 'custom' (anchor types that aren't fixed events)
    //   4. layer.op === '=' AND the time window equals the duration
    //      (meaning the user set an exact window with no flex)
    //
    // Note: lunch/snack/dismissal are ALSO anchors but they go to fixedLayers,
    //       not pinnedLayers, so they are checked BEFORE this.
    
    function isLayerPinned(layer) {
        const lType = (layer.type || '').toLowerCase();
        
        // Explicit pinned flags (planner/import path)
        if (layer.pinned || layer.pinExact) return true;
        
        // Anchor types that are NOT fixed events (swim, custom)
        if (lType === 'swim' || lType === 'custom') return true;
        
        // ★ v3.2: Custom persistent tiles are always pinned
        if (window.CustomPersistentTiles?.isCustomType?.(lType)) return true;
        
        // DAW anchor detection: op='=' and window size === duration
        // This means the user set an exact time with no flexibility
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
        
        // ★ v3.1 FIX (Bug B): Check fixed event types FIRST
        // This prevents snack/lunch/dismissal from being captured by the
        // pinned check below, even if they have pinned=true or are anchor types
        if (['lunch', 'snack', 'snacks', 'dismissal'].includes(lType)) {
            fixedLayers.push(layer);
        }
        // ★ v3.1 FIX (Bug A): League types get their own handling
        else if (lType === 'league') {
            leagueLayers.push(layer);
        }
        else if (lType === 'specialty_league') {
            specialtyLeagueLayers.push(layer);
        }
        // ★ v3.2: Custom persistent tiles → pinned (like swim)
        else if (window.CustomPersistentTiles?.isCustomType?.(lType)) {
            pinnedLayers.push(layer);
            log(`    Layer "${layer.event || lType}" → pinned (custom persistent tile)`);
        }
        // Pinned/exact-time events (swim, custom, or anything marked pinned)
        else if (isLayerPinned(layer)) {
            pinnedLayers.push(layer);
        }
        // Flexible specials
        else if (lType === 'special') {
            specialLayers.push(layer);
        }
        // Flexible sports
        else if (lType === 'sport' || lType === 'sports') {
            sportLayers.push(layer);
        }
        // Catch-all
        else {
            customLayers.push(layer);
        }
    });
    
    log(`  Classified: ${pinnedLayers.length} pinned, ${fixedLayers.length} fixed, ` +
        `${leagueLayers.length} league, ${specialtyLeagueLayers.length} specialty_league, ` +
        `${specialLayers.length} special, ${sportLayers.length} sport, ${customLayers.length} custom`);
    
    // =================================================================
    // HELPER: Read quantity from a layer (handles both DAW and Planner formats)
    // =================================================================
    // DAW layers use:  { qty: 1, op: '>=' }
    // Planner layers:  { quantity: 1, operator: '>=' } or { quantity: { val: 1, op: '>=' } }
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
    // Compute required quantities per type using ALL layers of that type
    // =================================================================
    // For >= : at least N (can give more if slots allow)
    // For =  : exactly N (hard cap)
    // For <= : at most N (can give fewer)
    // =================================================================
    
    function computeRequirements(typeLayers) {
        let minRequired = 0;    // minimum that MUST be given
        let maxAllowed = Infinity; // maximum that CAN be given
        let hasExact = false;
        
        typeLayers.forEach(layer => {
            const qty = getLayerQty(layer);
            const op = getLayerOp(layer);
            
            if (op === '=' || op === '==') {
                // Exactly this many
                minRequired = qty;
                maxAllowed = qty;
                hasExact = true;
            } else if (op === '>=' || op === '≥') {
                // At least this many
                minRequired = Math.max(minRequired, qty);
            } else if (op === '<=' || op === '≤') {
                // At most this many
                maxAllowed = Math.min(maxAllowed, qty);
            }
        });
        
        // If only >= was given, maxAllowed stays Infinity (fill as many as possible)
        // If only <= was given, minRequired stays 0 (can give zero)
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
    // These have a fixed time (e.g., Swim = 2:00-2:40 exactly)
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
        
        // ★ v3.2: Determine change buffer duration
        // Swim always needs a change; custom persistent tiles may need one too
        let changeDur = 0;
        if (lType === 'swim') {
            // Get configurable change duration (from global settings or default 10)
            const gs = getGlobalSettings();
            changeDur = parseInt(gs.app1?.changeBufferDuration) || parseInt(gs.changeBufferDuration) || 10;
        } else if (window.CustomPersistentTiles?.getChangeDuration) {
            changeDur = window.CustomPersistentTiles.getChangeDuration(lType) || 0;
        }
        
        // Mark occupied for all bunks + insert change buffer
        bunks.forEach(bunk => {
            bunkState[bunk].occupied.push({
                startMin, endMin, event: eventName, type: 'pinned'
            });
            bunkTimelines[bunk].push({
                startMin, endMin, event: eventName, type: 'pinned',
                _autoGenerated: true
            });
            
            // ★ v3.2: Auto-insert change buffer AFTER the pinned event
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
                
                // Also create a per-bunk skeleton block for the change
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
            
            // ★ v3.2: Also insert change buffer BEFORE if swim isn't first thing
            if (changeDur > 0 && startMin - changeDur >= divTimes.start) {
                // Check if there's already something right before this
                const hasBlockBefore = bunkState[bunk].occupied.some(o =>
                    o.endMin > startMin - changeDur && o.endMin <= startMin && o.type !== 'change_buffer'
                );
                // Only insert pre-change if the bunk is coming from another activity
                // (not at the very start of the day)
                if (hasBlockBefore || startMin > divTimes.start + 30) {
                    const preChangeStart = startMin - changeDur;
                    const preChangeEnd = startMin;
                    
                    // Check no overlap with existing
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
    // E.g., Bubble Lady: Mon/Thu only, 1:00-2:00, capacity 4, 30min each.
    // 8 bunks → bunks 1-4 at 1:00-1:30, bunks 5-8 at 1:30-2:00
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
        const capacity = specialConfig.capacity || 1; // how many bunks at once
        
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
            `capacity ${capacity}, ${slotsAvailable} slots, serving ${bunksToServe}/${bunks.length} bunks`);
        
        // Assign bunks to time slots
        let slotCursor = windowStart;
        let served = 0;
        
        while (served < bunksToServe && slotCursor + duration <= windowEnd) {
            const slotStart = slotCursor;
            const slotEnd = slotCursor + duration;
            
            // Assign up to `capacity` bunks to this slot
            for (let c = 0; c < capacity && served < bunksToServe; c++) {
                const bunk = rankedBunks[served].bunk;
                
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
        
        // Also add a skeleton block so the optimizer knows this time range exists
        skeleton.push({
            id: 'auto_scarce_' + Math.random().toString(36).slice(2, 9),
            type: 'slot',
            event: 'Special Activity',
            division: divName,
            startTime: fmtTime(windowStart),
            endTime: fmtTime(Math.min(windowEnd, windowStart + duration * Math.ceil(bunksToServe / capacity))),
            _autoGenerated: true,
            _scarceEvent: name
        });
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // PHASE 3: Place FIXED/WINDOWED events (lunch, snacks, dismissal)
    // ═════════════════════════════════════════════════════════════════
    // These have a time WINDOW but must happen for all bunks.
    // E.g., Lunch can go 12:00-1:00, duration=20min. Find best slot.
    // Sort by window tightness (tightest first = hardest to place).
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 3] Fixed events: ${fixedLayers.length}`);
    
    // Sort by window tightness (tightest first for better placement)
    const sortedFixed = [...fixedLayers].sort((a, b) => {
        const aSpan = (a.endMin || a.startMin + 60) - a.startMin;
        const bSpan = (b.endMin || b.startMin + 60) - b.startMin;
        return aSpan - bSpan;
    });
    
    sortedFixed.forEach(layer => {
        const duration = getLayerDuration(layer);
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        
        // If window === duration, it's effectively pinned (exact time)
        if (windowEnd - windowStart <= duration) {
            // Exact placement
            skeleton.push({
                id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9),
                type: 'pinned',
                event: layer.event || layer.type,
                division: divName,
                startTime: fmtTime(windowStart),
                endTime: fmtTime(windowStart + duration),
                pinned: true,
                _autoGenerated: true
            });
            
            bunks.forEach(bunk => {
                bunkState[bunk].occupied.push({
                    startMin: windowStart,
                    endMin: windowStart + duration,
                    event: layer.event || layer.type,
                    type: 'fixed'
                });
                bunkTimelines[bunk].push({
                    startMin: windowStart,
                    endMin: windowStart + duration,
                    event: layer.event || layer.type,
                    type: 'fixed',
                    _autoGenerated: true
                });
            });
            
            log(`    ${layer.event}: ${fmtTime(windowStart)}-${fmtTime(windowStart + duration)} (exact fixed)`);
            return;
        }
        
        // Windowed: find best placement avoiding conflicts
        const placement = findBestPlacement(
            windowStart, windowEnd, duration,
            getSharedOccupied(bunkState, bunks),
            divTimes
        );
        
        if (!placement) {
            warn(`Could not place ${layer.event} within ${fmtTime(windowStart)}-${fmtTime(windowEnd)}`);
            warnings.push(`Could not place ${layer.event || layer.type} within its time window`);
            return;
        }
        
        skeleton.push({
            id: 'auto_fixed_' + Math.random().toString(36).slice(2, 9),
            type: 'pinned',
            event: layer.event || layer.type,
            division: divName,
            startTime: fmtTime(placement.startMin),
            endTime: fmtTime(placement.endMin),
            pinned: true,
            _autoGenerated: true
        });
        
        bunks.forEach(bunk => {
            bunkState[bunk].occupied.push({
                startMin: placement.startMin,
                endMin: placement.endMin,
                event: layer.event || layer.type,
                type: 'fixed'
            });
            bunkTimelines[bunk].push({
                startMin: placement.startMin,
                endMin: placement.endMin,
                event: layer.event || layer.type,
                type: 'fixed',
                _autoGenerated: true
            });
        });
        
        log(`    ${layer.event}: ${fmtTime(placement.startMin)}-${fmtTime(placement.endMin)}`);
    });
    
    
    // ═════════════════════════════════════════════════════════════════
    // ★ PHASE 3.5: Place LEAGUE skeleton blocks (v3.1 — NEW)
    // ═════════════════════════════════════════════════════════════════
    // Leagues are division-wide: the entire grade plays at once.
    // They get placed like fixed events within their time window.
    // If =1, exactly one league block. If >=1, at least one.
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 3.5] Leagues: ${leagueLayers.length} regular, ${specialtyLeagueLayers.length} specialty`);
    
    const allLeagueLayers = [...leagueLayers, ...specialtyLeagueLayers];
    
    allLeagueLayers.forEach(layer => {
        const isSpecialty = (layer.type || '').toLowerCase() === 'specialty_league';
        const duration = getLayerDuration(layer);
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        const qty = getLayerQty(layer);
        const op = getLayerOp(layer);
        
        // How many league blocks to place
        const count = (op === '<=' || op === '≤') ? Math.min(qty, 1) : qty;
        
        for (let i = 0; i < count; i++) {
            // Find placement within window that doesn't conflict
            const placement = findBestPlacement(
                windowStart, windowEnd, duration,
                getSharedOccupied(bunkState, bunks),
                divTimes
            );
            
            if (!placement) {
                warn(`Could not place league ${i + 1}/${count} within ${fmtTime(windowStart)}-${fmtTime(windowEnd)}`);
                warnings.push(`Could not place ${isSpecialty ? 'Specialty League' : 'League'} within its time window`);
                continue;
            }
            
            skeleton.push({
                id: 'auto_league_' + Math.random().toString(36).slice(2, 9),
                type: isSpecialty ? 'specialty_league' : 'league',
                event: isSpecialty ? 'Specialty League' : 'League Game',
                division: divName,
                startTime: fmtTime(placement.startMin),
                endTime: fmtTime(placement.endMin),
                pinned: true,
                _autoGenerated: true
            });
            
            // Mark occupied for ALL bunks (leagues are division-wide)
            bunks.forEach(bunk => {
                bunkState[bunk].occupied.push({
                    startMin: placement.startMin,
                    endMin: placement.endMin,
                    event: isSpecialty ? 'Specialty League' : 'League Game',
                    type: isSpecialty ? 'specialty_league' : 'league'
                });
                bunkTimelines[bunk].push({
                    startMin: placement.startMin,
                    endMin: placement.endMin,
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
    //
    // NEW APPROACH (replaces v3.1 interleaved filling):
    //   1. Identify "activity groups" — the gaps between pinned/fixed events
    //      (these correspond to "Activity #1", "Activity #2", etc.)
    //   2. For EACH bunk, for EACH gap/group:
    //      a) Check what's already placed (swim + change = done)
    //      b) Pack the gap with activities from the rotation pool
    //         using a knapsack solver that respects durations
    //      c) Each packed activity gets its own sub-slot skeleton block
    //   3. Result: different bunks can have different numbers of
    //      sub-activities within the same activity group.
    //
    // The packer considers ALL activities (specials + sports) in one
    // unified pool ranked by rotation score, then picks the combination
    // whose durations sum to the gap size with the best total score.
    //
    // ═════════════════════════════════════════════════════════════════
    
    log(`  [Phase 4] Knapsack group packer (v3.2.2)...`);
    log(`    Special rules: op=${specialReq.hasExact ? '=' : '>='} min=${specialReq.min} max=${specialReq.max}`);
    log(`    Sport rules: op=${sportReq.hasExact ? '=' : '>='} min=${sportReq.min} max=${sportReq.max}`);
    
    // ★★★ v3.2.2: Capacity tracking — prevent over-assigning specials ★★★
    // Key: "specialName|gapStartMin" → count of bunks assigned
    const specialSlotUsage = {};
    
    function getSpecialCapacity(specialName) {
        const config = getSpecialConfig(specialName);
        if (!config) return 2; // default
        // ★★★ v3.2.2 FIX: sharableWith.capacity is always the max concurrent bunks ★★★
        // The 'type' field (all/custom/not_sharable/same_division) controls which 
        // divisions can share, NOT the count. Always use the explicit capacity.
        if (config.sharableWith) {
            if (config.sharableWith.capacity !== undefined) {
                const cap = parseInt(config.sharableWith.capacity);
                if (!isNaN(cap) && cap > 0) return cap;
            }
            // Only if no explicit capacity, fall back to type-based defaults
            if (config.sharableWith.type === 'not_sharable') return 1;
        }
        // Check capacity directly on special config
        if (config.capacity) return parseInt(config.capacity);
        if (config.maxBunks) return parseInt(config.maxBunks);
        return 2; // default capacity
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
    
    // ─────────────────────────────────────────────────────────
    // Build the unified pool of all assignable activities
    // ─────────────────────────────────────────────────────────
    
    function buildActivityPool(bunk, gapStartMin) {
        const pool = [];
        
        // Add all regular specials with their configured durations
        const availableSpecialNames = regularSpecials.map(s => s.name);
        const rankedSpecials = getRankedSpecials(bunk, availableSpecialNames);
        rankedSpecials.forEach(s => {
            // ★★★ v3.2.2: Skip specials restricted to other divisions ★★★
            if (!isSpecialAvailableForDivision(s.name, divName)) {
                return; // this special is not allowed for this grade/division
            }
            // ★★★ v3.2.2: Skip specials that have hit capacity for this time slot ★★★
            if (gapStartMin !== undefined && isSpecialAtCapacity(s.name, gapStartMin)) {
                log(`      [CAPACITY] ${s.name} at capacity for gap ${gapStartMin} (${specialSlotUsage[s.name + '|' + gapStartMin]}/${getSpecialCapacity(s.name)})`);
                return; // skip — too many bunks already have this special at this time
            }
            pool.push({
                name: s.name,
                duration: s.duration || specialDur,
                score: s.score,
                type: 'special',
                _fromPool: true
            });
        });
        
        // Add sports as generic slots (solver will pick the actual sport)
        // We create a few sport entries with different duration options
        const sportDurations = [sportDurMin];
        if (sportDurIdeal !== sportDurMin) sportDurations.push(sportDurIdeal);
        if (sportDurMax !== sportDurIdeal && sportDurMax !== sportDurMin) sportDurations.push(sportDurMax);
        
        sportDurations.forEach((dur, idx) => {
            pool.push({
                name: `Sport_${dur}min`,
                duration: dur,
                // Sports get a baseline rotation score — slightly worse than specials
                // so specials are preferred when scores are close
                score: 0 + idx,
                type: 'sport',
                _fromPool: true,
                _sportDuration: dur
            });
        });
        
        // Sort entire pool by rotation score (lowest = most overdue = best)
        pool.sort((a, b) => a.score - b.score);
        return pool;
    }
    
    // ─────────────────────────────────────────────────────────
    // Knapsack solver: find best combo of activities that fills
    // a time window exactly (or as close as possible)
    // ─────────────────────────────────────────────────────────
    
    function packGap(pool, timeAvailable, constraints) {
        const { maxSpecials, maxSports, usedToday, needSpecials, needSports } = constraints;
        const usedSet = new Set((usedToday || []).map(n => n.toLowerCase()));
        
        // Filter pool: remove same-day repeats (but keep sport slots, they're generic)
        const available = pool.filter(a => {
            if (a.type === 'sport') return true; // sports are generic, solver picks
            return !usedSet.has(a.name.toLowerCase());
        });
        
        if (available.length === 0) return [];
        
        // Limit search depth based on gap size
        const maxItems = Math.min(6, Math.ceil(timeAvailable / 10));
        
        let bestCombo = null;
        let bestScore = Infinity;
        let bestRemainder = Infinity;
        
        function search(idx, remaining, combo, totalScore, specCount, sportCount) {
            // Perfect or near-perfect fit
            if (remaining >= 0 && remaining < 5) {
                if (remaining < bestRemainder ||
                    (remaining === bestRemainder && totalScore < bestScore)) {
                    bestCombo = [...combo];
                    bestScore = totalScore;
                    bestRemainder = remaining;
                }
                // If perfect fit, done
                if (remaining === 0) return;
            }
            
            // Too deep or no time left
            if (remaining <= 0 || combo.length >= maxItems) return;
            
            for (let i = idx; i < available.length; i++) {
                const act = available[i];
                if (act.duration > remaining) continue;
                
                // Enforce type caps
                if (act.type === 'special' && maxSpecials !== undefined && specCount >= maxSpecials) continue;
                if (act.type === 'sport' && maxSports !== undefined && sportCount >= maxSports) continue;
                
                // No duplicate names in same combo (specials only; sports are generic)
                if (act.type === 'special' && combo.some(c => c.name === act.name)) continue;
                // Only 1 sport entry per duration in combo
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
                
                // Early exit on perfect fit
                if (bestRemainder === 0) return;
            }
        }
        
        search(0, timeAvailable, [], 0, 0, 0);
        
        // If knapsack found nothing, fall back to greedy single pick
        if (!bestCombo || bestCombo.length === 0) {
            // Just pick the first thing that fits
            const fits = available.filter(a => a.duration <= timeAvailable);
            if (fits.length > 0) {
                bestCombo = [fits[0]];
            }
        }
        
        // Ensure minimums are met: if we need specials but got none, swap a sport
        if (bestCombo && needSpecials > 0) {
            const specInCombo = bestCombo.filter(c => c.type === 'special').length;
            if (specInCombo === 0) {
                // Try to replace a sport with a special
                const specCand = available.find(a => a.type === 'special' && a.duration <= timeAvailable);
                if (specCand) {
                    const sportIdx = bestCombo.findIndex(c => c.type === 'sport');
                    if (sportIdx >= 0) {
                        bestCombo[sportIdx] = specCand;
                    }
                }
            }
        }
        
        return bestCombo || [];
    }
    
    // ─────────────────────────────────────────────────────────
    // Process each bunk
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
        
        // Track what's been used today (for no same-day repeats)
        const usedToday = [];
        bunkTimelines[bunk].forEach(t => {
            if (t.event && t.event !== 'Change') usedToday.push(t.event);
            if (t._hintActivity) usedToday.push(t._hintActivity);
        });
        
        // Track layer fulfillment
        let placedSpecials = state.specialCount;
        let placedSports = state.sportCount;
        
        // Calculate remaining needs
        const specialMaxCap = specialReq.max < Infinity ? specialReq.max : 999;
        const sportMaxCap = sportReq.max < Infinity ? sportReq.max : 999;
        let specialsStillNeeded = Math.max(0, specialReq.min - placedSpecials);
        let sportsStillNeeded = Math.max(0, sportReq.min - placedSports);
        
        // ─────────────────────────────────────────────────────
        // For each gap (= activity group), run the packer
        // ─────────────────────────────────────────────────────
        
        for (const gap of gapsCopy) {
            const groupDuration = gap.endMin - gap.startMin;
            if (groupDuration < 5) continue;
            
            // ★★★ v3.2.2: Rebuild pool per gap with capacity-aware filtering ★★★
            const pool = buildActivityPool(bunk, gap.startMin);
            
            // Run the knapsack packer on this gap
            const packed = packGap(pool, groupDuration, {
                maxSpecials: Math.max(0, specialMaxCap - placedSpecials),
                maxSports: Math.max(0, sportMaxCap - placedSports),
                usedToday: usedToday,
                needSpecials: specialsStillNeeded,
                needSports: sportsStillNeeded
            });
            
            if (packed.length === 0) {
                // Nothing packed — create a single GA slot for the solver
                skeleton.push({
                    id: 'auto_ga_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: 'General Activity Slot',
                    division: divName,
                    startTime: fmtTime(gap.startMin),
                    endTime: fmtTime(gap.endMin),
                    _autoGenerated: true,
                    _bunk: bunk,
                    _activityGroup: gap.startMin
                });
                
                bunkTimelines[bunk].push({
                    startMin: gap.startMin, endMin: gap.endMin,
                    event: 'General Activity Slot', type: 'general_slot',
                    _autoGenerated: true, _activityGroup: gap.startMin
                });
                
                state.occupied.push({
                    startMin: gap.startMin, endMin: gap.endMin,
                    event: 'General Activity Slot', type: 'general_slot'
                });
                
                continue;
            }
            
            // Place the packed activities sequentially in the gap
            let cursor = gap.startMin;
            
            for (const act of packed) {
                const blockStart = cursor;
                const blockEnd = Math.min(cursor + act.duration, gap.endMin);
                const blockDur = blockEnd - blockStart;
                
                if (blockDur < 5) break; // safety
                
                const isSpecial = act.type === 'special';
                const eventLabel = isSpecial ? 'Special Activity' : 'Sports Slot';
                
                skeleton.push({
                    id: 'auto_' + (isSpecial ? 'spec' : 'sport') + '_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: eventLabel,
                    division: divName,
                    startTime: fmtTime(blockStart),
                    endTime: fmtTime(blockEnd),
                    _autoGenerated: true,
                    _durationStrict: true,
                    _bunk: bunk,
                    _targetDuration: blockDur,
                    _hintActivity: isSpecial ? act.name : null,
                    _activityGroup: gap.startMin
                });
                
                bunkTimelines[bunk].push({
                    startMin: blockStart, endMin: blockEnd,
                    event: eventLabel,
                    type: isSpecial ? 'special_slot' : 'sport_slot',
                    _durationStrict: true,
                    _targetDuration: blockDur,
                    _hintActivity: isSpecial ? act.name : null,
                    _autoGenerated: true,
                    _activityGroup: gap.startMin
                });
                
                state.occupied.push({
                    startMin: blockStart, endMin: blockEnd,
                    event: eventLabel, type: isSpecial ? 'special_slot' : 'sport_slot'
                });
                
                // Track
                if (isSpecial) {
                    placedSpecials++;
                    state.specialCount++;
                    specialsStillNeeded = Math.max(0, specialsStillNeeded - 1);
                    
                    // ★★★ v3.2.2: Record usage for capacity tracking across bunks ★★★
                    recordSpecialUsage(act.name, gap.startMin);
                    
                    // ★★★ v3.2.1 FIX: Emit bunkOverride so solver pre-assigns this special ★★★
                    bunkOverrides.push({
                        bunk,
                        division: divName,
                        activity: act.name,
                        type: 'special',
                        startTime: fmtTime(blockStart),
                        endTime: fmtTime(blockEnd),
                        _autoGenerated: true,
                        _knapsack: true
                    });
                } else {
                    placedSports++;
                    state.sportCount++;
                    sportsStillNeeded = Math.max(0, sportsStillNeeded - 1);
                }
                usedToday.push(act.name);
                
                cursor = blockEnd;
                
                log(`      ${bunk}: ${isSpecial ? act.name : 'Sport'} (${act.type}, ${blockDur}min) → ${fmtTime(blockStart)}-${fmtTime(blockEnd)}`);
            }
            
            // If leftover time after packing, create a small GA slot
            const leftover = gap.endMin - cursor;
            if (leftover >= 5) {
                skeleton.push({
                    id: 'auto_ga_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: 'General Activity Slot',
                    division: divName,
                    startTime: fmtTime(cursor),
                    endTime: fmtTime(gap.endMin),
                    _autoGenerated: true,
                    _bunk: bunk,
                    _activityGroup: gap.startMin
                });
                
                bunkTimelines[bunk].push({
                    startMin: cursor, endMin: gap.endMin,
                    event: 'General Activity Slot', type: 'general_slot',
                    _autoGenerated: true, _activityGroup: gap.startMin
                });
                
                state.occupied.push({
                    startMin: cursor, endMin: gap.endMin,
                    event: 'General Activity Slot', type: 'general_slot'
                });
                
                log(`      ${bunk}: GA leftover ${fmtTime(cursor)}-${fmtTime(gap.endMin)} (${leftover}min)`);
            }
        }
        
        // ─────────────────────────────────────────────────────
        // Verify layer rules are satisfied
        // ─────────────────────────────────────────────────────
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
 * ★ v3.1: Handle both DAW format (qty) and Planner format (quantity)
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
