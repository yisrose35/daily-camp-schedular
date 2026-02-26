// =================================================================
// auto_build_engine.js — Campistry Auto Build Engine v3.0
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
// =================================================================

(function() {
'use strict';

const VERSION = '3.0.0';
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
    // Grade names and division names may be the same thing
    // or grades may be nested inside divisions
    const divisions = getDivisions();
    if (divisions[gradeName]) return gradeName;
    
    // Search for grade inside division config
    for (const [divName, divData] of Object.entries(divisions)) {
        if (divData.grades && divData.grades.includes(gradeName)) return divName;
        if (divData.grade === gradeName) return divName;
    }
    return gradeName; // fallback: treat grade as division
}

function getDivisionTimes(divName) {
    const divisions = getDivisions();
    const div = divisions[divName];
    if (!div) return { start: 540, end: 960 }; // 9am-4pm default
    
    const startMin = div.startTime ? parseTime(div.startTime) : 540;
    const endMin = div.endTime ? parseTime(div.endTime) : 960;
    return { start: startMin || 540, end: endMin || 960 };
}

/**
 * Get special activity config by name
 */
function getSpecialConfig(name) {
    const specials = getSpecialActivities();
    return specials.find(s => 
        s.name?.toLowerCase().trim() === name?.toLowerCase().trim()
    ) || null;
}

/**
 * Get the configured duration for a special activity
 */
function getSpecialDuration(name) {
    const config = getSpecialConfig(name);
    return config?.defaultDuration || config?.duration || null;
}

/**
 * Check if a special activity is available on a given day
 */
function isSpecialAvailableOnDay(specialConfig, dayName) {
    if (!specialConfig) return true; // no config = always available
    if (!specialConfig.dayAvailability) return true; // no day restriction
    
    const avail = specialConfig.dayAvailability;
    if (typeof avail === 'object' && !Array.isArray(avail)) {
        // Object format: { Monday: true, Tuesday: false, ... }
        return avail[dayName] !== false;
    }
    if (Array.isArray(avail)) {
        // Array format: ["Monday", "Thursday"]
        return avail.map(d => d.toLowerCase()).includes(dayName.toLowerCase());
    }
    return true;
}

/**
 * Get time window for a special activity (if configured)
 */
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

/**
 * Determine if a special is "scarce" — limited availability
 * A scarce activity has day restrictions or narrow time windows
 */
function isScarceSpecial(specialConfig, dayName) {
    if (!specialConfig) return false;
    
    // Has day availability AND is available today
    if (specialConfig.dayAvailability) {
        if (!isSpecialAvailableOnDay(specialConfig, dayName)) return false;
        return true; // Has day restrictions = scarce
    }
    
    // Has a narrow time window (less than 3 hours)
    const window = getSpecialTimeWindow(specialConfig);
    if (window && (window.endMin - window.startMin) < 180) return true;
    
    return false;
}

// =================================================================
// ROTATION HISTORY ACCESS
// =================================================================

/**
 * Get rotation score for a bunk/activity pair
 * Lower = more overdue (better candidate)
 */
function getRotationScore(bunkName, activityName) {
    if (window.RotationEngine?.calculateFullRotationScore) {
        return window.RotationEngine.calculateFullRotationScore(bunkName, activityName, 0, {});
    }
    if (window.RotationEngine?.calculateRecencyScore) {
        return window.RotationEngine.calculateRecencyScore(bunkName, activityName, 0);
    }
    return 0;
}

/**
 * Get ranked specials for a bunk (most overdue first)
 */
function getRankedSpecials(bunkName, availableSpecials) {
    const ranked = availableSpecials.map(name => ({
        name,
        score: getRotationScore(bunkName, name),
        duration: getSpecialDuration(name) || 30 // default 30min
    }));
    
    // Sort by score ascending (lower = more overdue = should do first)
    ranked.sort((a, b) => a.score - b.score);
    return ranked;
}

// =================================================================
// MAIN BUILD FUNCTION
// =================================================================

/**
 * Generate skeleton + bunk overrides from layer configuration
 * 
 * @param {Object} params
 * @param {Array} params.layers - Layer objects from the planner UI
 * @param {string} params.dateStr - ISO date string (YYYY-MM-DD)
 * @returns {{ skeleton: Array, bunkOverrides: Array, bunkTimelines: Object, warnings: Array }}
 */
function build({ layers, dateStr }) {
    log('═══════════════════════════════════════════════════════');
    log(`AUTO BUILD ENGINE v${VERSION}`);
    log(`Date: ${dateStr}, Layers: ${layers.length}`);
    log('═══════════════════════════════════════════════════════');
    
    const warnings = [];
    
    // Determine day of week
    const [Y, M, D] = dateStr.split('-').map(Number);
    const dow = new Date(Y, M - 1, D).getDay();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[dow];
    log(`Day: ${dayName}`);
    
    // Get all special activities available today
    const allSpecials = getSpecialActivities();
    const todaysSpecials = allSpecials.filter(s => isSpecialAvailableOnDay(s, dayName));
    const scarceSpecials = todaysSpecials.filter(s => isScarceSpecial(s, dayName));
    const regularSpecials = todaysSpecials.filter(s => !isScarceSpecial(s, dayName));
    
    log(`Specials — total: ${allSpecials.length}, today: ${todaysSpecials.length}, scarce: ${scarceSpecials.length}, regular: ${regularSpecials.length}`);
    
    // Group layers by grade/division
    const layersByGrade = {};
    layers.forEach(l => {
        const grade = l.grade || l.division || '_all';
        if (!layersByGrade[grade]) layersByGrade[grade] = [];
        layersByGrade[grade].push({ ...l });
    });
    
    const allSkeleton = [];
    const allBunkOverrides = [];
    const bunkTimelines = {}; // { bunkName: [{ startMin, endMin, event, activity, ... }] }
    
    // If '_all' layers exist, apply them to every grade
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

// =================================================================
// BUILD FOR A SINGLE GRADE/DIVISION
// =================================================================

function buildForGrade({ gradeName, divName, bunks, layers, dayName, dateStr, divTimes, scarceSpecials, regularSpecials, todaysSpecials, warnings }) {
    const skeleton = [];
    const bunkOverrides = [];
    const bunkTimelines = {};
    
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
    
    // Classify layers
    const pinnedLayers = [];
    const fixedLayers = [];   // windowed (lunch, snack, etc.)
    const specialLayers = []; // specials ≥N whole day
    const sportLayers = [];   // sports ≥N whole day
    const customLayers = [];
    
    layers.forEach((layer, idx) => {
        layer._idx = idx;
        if (layer.pinned) {
            pinnedLayers.push(layer);
        } else if (['lunch', 'snack', 'snacks', 'dismissal'].includes(layer.type?.toLowerCase())) {
            fixedLayers.push(layer);
        } else if (layer.type === 'special') {
            specialLayers.push(layer);
        } else if (layer.type === 'sport' || layer.type === 'sports') {
            sportLayers.push(layer);
        } else {
            customLayers.push(layer);
        }
    });
    
    // ─────────────────────────────────────────────────────────
    // PHASE 1: Place SCARCE specials (limited availability)
    // ─────────────────────────────────────────────────────────
    log(`  [Phase 1] Scarce specials: ${scarceSpecials.length}`);
    
    scarceSpecials.forEach(specialConfig => {
        const name = specialConfig.name;
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
        const bunksToServe = Math.min(rankedBunks.length, totalCapacity);
        
        log(`    ${name}: window ${fmtTime(windowStart)}-${fmtTime(windowEnd)}, dur ${duration}min, capacity ${capacity}, serving ${bunksToServe}/${rankedBunks.length} bunks`);
        
        // Assign bunks to time slots
        let cursor = windowStart;
        let capacityUsed = 0;
        
        for (let i = 0; i < bunksToServe; i++) {
            const bunk = rankedBunks[i].bunk;
            
            if (capacityUsed >= capacity) {
                cursor += duration;
                capacityUsed = 0;
            }
            
            if (cursor + duration > windowEnd) {
                warn(`Not enough time for ${name} - ${bunk} couldn't fit`);
                break;
            }
            
            const startMin = cursor;
            const endMin = cursor + duration;
            
            // Add bunk override
            bunkOverrides.push({
                bunk,
                activity: name,
                type: 'special',
                startTime: fmtTime(startMin),
                endTime: fmtTime(endMin),
                _autoGenerated: true,
                _scarce: true
            });
            
            // Track in bunk state
            bunkState[bunk].occupied.push({
                startMin, endMin, event: name, type: 'scarce_special'
            });
            bunkState[bunk].specialCount++;
            
            // Track in bunk timeline
            bunkTimelines[bunk].push({
                startMin, endMin, event: name, type: 'scarce_special',
                _activity: name, _durationStrict: true, _autoGenerated: true
            });
            
            capacityUsed++;
            
            log(`      → ${bunk}: ${fmtTime(startMin)}-${fmtTime(endMin)}`);
        }
        
        // Create a skeleton block for the scarce activity's time range
        // (so the optimizer knows this time range exists)
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
    
    // ─────────────────────────────────────────────────────────
    // PHASE 2: Place PINNED events (exact time, all bunks)
    // ─────────────────────────────────────────────────────────
    log(`  [Phase 2] Pinned events: ${pinnedLayers.length}`);
    
    pinnedLayers.forEach(layer => {
        const startMin = layer.startMin;
        const endMin = layer.startMin + (layer.duration || (layer.endMin - layer.startMin));
        
        skeleton.push({
            id: 'auto_pinned_' + Math.random().toString(36).slice(2, 9),
            type: 'pinned',
            event: layer.event || layer.type,
            division: divName,
            startTime: fmtTime(startMin),
            endTime: fmtTime(endMin),
            pinned: true,
            _autoGenerated: true
        });
        
        // Mark occupied for all bunks
        bunks.forEach(bunk => {
            bunkState[bunk].occupied.push({
                startMin, endMin, event: layer.event || layer.type, type: 'pinned'
            });
            bunkTimelines[bunk].push({
                startMin, endMin, event: layer.event || layer.type, type: 'pinned',
                _autoGenerated: true
            });
        });
        
        log(`    ${layer.event}: ${fmtTime(startMin)}-${fmtTime(endMin)} (pinned, all bunks)`);
    });
    
    // ─────────────────────────────────────────────────────────
    // PHASE 3: Place FIXED/WINDOWED events (lunch, snacks, etc.)
    // ─────────────────────────────────────────────────────────
    log(`  [Phase 3] Fixed events: ${fixedLayers.length}`);
    
    // Sort by window tightness (tightest first for better placement)
    const sortedFixed = [...fixedLayers].sort((a, b) => {
        const aSpan = (a.endMin || a.startMin + 60) - a.startMin;
        const bSpan = (b.endMin || b.startMin + 60) - b.startMin;
        return aSpan - bSpan;
    });
    
    sortedFixed.forEach(layer => {
        const duration = layer.duration || 20;
        const windowStart = layer.startMin;
        const windowEnd = layer.endMin || (windowStart + duration);
        
        // Find the best placement within the window that doesn't conflict
        // with scarce or pinned events (shared across all bunks)
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
    
    // ─────────────────────────────────────────────────────────
    // PHASE 4: Fill gaps PER BUNK with specials + sports
    // ─────────────────────────────────────────────────────────
    log(`  [Phase 4] Filling gaps per bunk...`);
    
    // Determine required quantities from layers
    const specialRequired = getRequiredQuantity(specialLayers);
    const sportRequired = getRequiredQuantity(sportLayers);
    
    log(`    Required: ≥${specialRequired} specials, ≥${sportRequired} sports per bunk`);
    
    bunks.forEach(bunk => {
        const state = bunkState[bunk];
        const gaps = findGaps(state.occupied, divTimes);
        
        if (gaps.length === 0) {
            log(`    ${bunk}: No gaps to fill`);
            return;
        }
        
        log(`    ${bunk}: ${gaps.length} gaps, ${state.specialCount} specials already`);
        
        // Determine how many more specials/sports this bunk needs
        let specialsNeeded = Math.max(0, specialRequired - state.specialCount);
        let sportsNeeded = sportRequired;
        
        // Get ranked specials for this bunk
        const availableSpecialNames = regularSpecials.map(s => s.name);
        const rankedSpecials = getRankedSpecials(bunk, availableSpecialNames);
        let specialIdx = 0;
        
        // Fill gaps: specials first (they have specific durations), then sports
        const gapsCopy = [...gaps].sort((a, b) => a.startMin - b.startMin);
        
        for (const gap of gapsCopy) {
            let remaining = gap.endMin - gap.startMin;
            let cursor = gap.startMin;
            
            // Fill specials into this gap
            while (remaining > 0 && specialsNeeded > 0 && specialIdx < rankedSpecials.length) {
                const special = rankedSpecials[specialIdx];
                const dur = special.duration;
                
                if (dur > remaining) {
                    // This special doesn't fit, try next
                    specialIdx++;
                    continue;
                }
                
                // Place this special
                const blockStart = cursor;
                const blockEnd = cursor + dur;
                
                // Create a skeleton block with _durationStrict
                skeleton.push({
                    id: 'auto_spec_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: 'Special Activity',
                    division: divName,
                    startTime: fmtTime(blockStart),
                    endTime: fmtTime(blockEnd),
                    _autoGenerated: true,
                    _durationStrict: true,
                    _bunk: bunk,
                    _targetDuration: dur
                });
                
                bunkTimelines[bunk].push({
                    startMin: blockStart,
                    endMin: blockEnd,
                    event: 'Special Activity',
                    type: 'special_slot',
                    _durationStrict: true,
                    _targetDuration: dur,
                    _hintActivity: special.name,
                    _autoGenerated: true
                });
                
                state.occupied.push({
                    startMin: blockStart, endMin: blockEnd,
                    event: 'Special Activity', type: 'special_slot'
                });
                
                cursor = blockEnd;
                remaining = gap.endMin - cursor;
                specialsNeeded--;
                specialIdx++;
                state.specialCount++;
                
                log(`      ${bunk}: Special slot ${fmtTime(blockStart)}-${fmtTime(blockEnd)} (${dur}min, hint: ${special.name})`);
            }
            
          // Fill remaining gap with sports — respect durationMin/durationMax from layers
            while (remaining > 0 && sportsNeeded > 0) {
                // Get duration range from sport layers
                const sportDurMin = (sportLayers[0]?.durationMin || sportLayers[0]?.periodMin || 30);
                const sportDurMax = (sportLayers[0]?.durationMax || sportDurMin);
                const sportDurIdeal = Math.round((sportDurMin + sportDurMax) / 2);
                
                // If remaining time < minimum duration, stop placing sports
                if (remaining < sportDurMin) break;
                
                // Determine this block's duration
                let blockDur = Math.min(sportDurIdeal, remaining);
                // If what's left after this block would be too small for another, absorb it
                const leftover = remaining - blockDur;
                if (leftover > 0 && leftover < sportDurMin) {
                    blockDur = remaining; // absorb remainder into this block
                }
                // Clamp to max
                if (blockDur > sportDurMax && remaining > sportDurMax) {
                    blockDur = sportDurIdeal;
                }
                
                const blockStart = cursor;
                const blockEnd = cursor + blockDur;
                
                skeleton.push({
                    id: 'auto_sport_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: 'Sports Slot',
                    division: divName,
                    startTime: fmtTime(blockStart),
                    endTime: fmtTime(blockEnd),
                    _autoGenerated: true,
                    _bunk: bunk
                });
                
                bunkTimelines[bunk].push({
                    startMin: blockStart,
                    endMin: blockEnd,
                    event: 'Sports Slot',
                    type: 'sport_slot',
                    _autoGenerated: true
                });
                
                state.occupied.push({
                    startMin: blockStart, endMin: blockEnd,
                    event: 'Sports Slot', type: 'sport_slot'
                });
                
                cursor = blockEnd;
                remaining = gap.endMin - cursor;
                sportsNeeded--;
                state.sportCount++;
                
                log(`      ${bunk}: Sport slot ${fmtTime(blockStart)}-${fmtTime(blockEnd)} (${blockDur}min)`);
            }
            
           // If still remaining gap, fill with general activity blocks using duration from layers
            while (remaining >= 15) {
                // Look for duration hints from any activity/custom layers, or fall back to sport layer durations
                const anyDurLayer = customLayers[0] || sportLayers[0];
                const gaDurMin = (anyDurLayer?.durationMin || anyDurLayer?.periodMin || 30);
                const gaDurMax = (anyDurLayer?.durationMax || gaDurMin);
                const gaDurIdeal = Math.round((gaDurMin + gaDurMax) / 2);
                
                if (remaining < gaDurMin) break;
                
                let blockDur = Math.min(gaDurIdeal, remaining);
                const leftover = remaining - blockDur;
                if (leftover > 0 && leftover < gaDurMin) {
                    blockDur = remaining;
                }
                if (blockDur > gaDurMax && remaining > gaDurMax) {
                    blockDur = gaDurIdeal;
                }
                
                const blockStart = cursor;
                const blockEnd = cursor + blockDur;
                
                skeleton.push({
                    id: 'auto_ga_' + Math.random().toString(36).slice(2, 9),
                    type: 'slot',
                    event: 'General Activity Slot',
                    division: divName,
                    startTime: fmtTime(blockStart),
                    endTime: fmtTime(blockEnd),
                    _autoGenerated: true,
                    _bunk: bunk
                });
                
                bunkTimelines[bunk].push({
                    startMin: blockStart,
                    endMin: blockEnd,
                    event: 'General Activity Slot',
                    type: 'general_slot',
                    _autoGenerated: true
                });
                
                state.occupied.push({
                    startMin: blockStart, endMin: blockEnd,
                    event: 'General Activity Slot', type: 'general_slot'
                });
                
                cursor = blockEnd;
                remaining = gap.endMin - cursor;
                
                log(`      ${bunk}: GA slot ${fmtTime(blockStart)}-${fmtTime(blockEnd)} (${blockDur}min)`);
            }
        }
        
        // Verify layer rules are satisfied
        if (specialsNeeded > 0) {
            warnings.push(`${bunk}: Could only fit ${specialRequired - specialsNeeded}/${specialRequired} specials`);
        }
        if (sportsNeeded > 0) {
            warnings.push(`${bunk}: Could only fit ${sportRequired - sportsNeeded}/${sportRequired} sports`);
        }
    });
    
    // ─────────────────────────────────────────────────────────
    // PHASE 5: Add transition buffers between blocks
    // ─────────────────────────────────────────────────────────
    // The existing pipeline handles transitions, so we just need
    // to ensure blocks don't overlap and have small gaps for travel time.
    // This is handled naturally by the gap detection in Phase 4.
    
    // Sort bunk timelines by start time
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
            if (occ.type === 'pinned' || occ.type === 'scarce_special') {
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
    // Try placing at each possible start time (5-minute increments)
    const candidates = [];
    
    for (let start = windowStart; start + duration <= windowEnd; start += 5) {
        const end = start + duration;
        
        // Check for conflicts with occupied ranges
        const hasConflict = occupied.some(occ =>
            start < occ.endMin && end > occ.startMin
        );
        
        if (!hasConflict) {
            // Score: prefer middle of window
            const windowCenter = (windowStart + windowEnd) / 2;
            const blockCenter = (start + end) / 2;
            const distFromCenter = Math.abs(blockCenter - windowCenter);
            
            candidates.push({ startMin: start, endMin: end, score: distFromCenter });
        }
    }
    
    if (candidates.length === 0) return null;
    
    // Pick the one closest to center of window
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
    
    // Gap before first occupied
    if (sorted[0].startMin > divTimes.start) {
        gaps.push({ startMin: divTimes.start, endMin: sorted[0].startMin });
    }
    
    // Gaps between occupied ranges
    for (let i = 0; i < sorted.length - 1; i++) {
        const gapStart = sorted[i].endMin;
        const gapEnd = sorted[i + 1].startMin;
        if (gapEnd > gapStart + 5) { // minimum 5min gap to be useful
            gaps.push({ startMin: gapStart, endMin: gapEnd });
        }
    }
    
    // Gap after last occupied
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
        const qty = l.quantity?.val || l.quantity || 1;
        total = Math.max(total, qty); // use max (layers are alternatives, not additive)
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
    
    // Check for overlapping pinned events
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
