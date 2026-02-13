// ============================================================================
// midday_rain_stacker.js — Mid-Day Rain Schedule Stacking Engine (v2.0)
// ============================================================================
// 
// PURPOSE: When rain starts mid-day (or clears mid-day), this engine rebuilds
// the rest of the day's schedule by "calling an audible" — stacking activities
// sequentially from the transition point to the dismissal wall.
//
// v2.0 CHANGES:
//   - Morning/pre-transition schedule is NEVER erased during regeneration
//   - Uses prePlaceMorningAssignments() to map old assignments to new slots by TIME
//   - Marks preserved entries as _pinned so PinnedPreservation system protects them
//   - Eliminates the fragile backup → wipe → restore pattern
//
// CORE CONCEPT:
//   The target skeleton (rainy or regular) is treated as:
//     1. An ordered QUEUE of activities with durations
//     2. A set of FIXED blocks (lunch, snack, dismissal) 
//   
//   Activities are stacked sequentially from the start time.
//   Each activity has a ±25% flex range on its duration.
//   Fixed blocks (snack) float to natural positions in the queue.
//   Dismissal is the hard wall — nothing goes past it.
//
// INCLUDES: After rainy_day_manager.js, before daily_adjustments.js
//
// INTEGRATION:
//   - Called from activateMidDayRainyMode() in daily_adjustments.js
//   - Called from deactivateMidDayRainyMode() (rain clears scenario)
//   - Reads skeleton from savedSkeletons in global settings
//   - Writes rebuilt skeleton to manualSkeleton in daily data
//   - Applies resource overrides (capacity, availability)
//
// ============================================================================

(function() {
'use strict';

console.log('🌧️ Mid-Day Rain Stacker v2.0 loading...');

// =========================================================================
// CONSTANTS
// =========================================================================
const FLEX_PERCENT = 0.25;          // ±25% duration flex
const SNAP_THRESHOLD_MIN = 10;      // Max gap (min) to snap to skeleton boundary
const ROUND_TO_MIN = 5;             // Round rain time to nearest N minutes
const MIN_USEFUL_GAP = 10;          // Gaps smaller than this become transition

// Block types that are "fixed" — they must happen but can float in the queue
const FIXED_BLOCK_EVENTS = ['lunch', 'snack', 'snacks'];
// Block types that are "wall" — they anchor the end of the day
const WALL_BLOCK_EVENTS = ['dismissal'];
// Block types that are non-schedulable (pinned events that aren't activities)
const PINNED_EVENTS = ['lunch', 'snack', 'snacks', 'dismissal', 'arrival', 'davening', 'tefillah', 'mincha'];

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================

function parseTimeToMinutes(str) {
    if (typeof str === 'number') return str;
    if (!str || typeof str !== 'string') return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith('am') || s.endsWith('pm')) {
        mer = s.endsWith('am') ? 'am' : 'pm';
        s = s.replace(/am|pm/g, '').trim();
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
    if (mer) {
        if (hh === 12) hh = mer === 'am' ? 0 : 12;
        else if (mer === 'pm') hh += 12;
    }
    // ★ Handle 24h format (no am/pm) — from <input type="time"> or ISO parsing
    // If no meridiem was found, treat as 24h if hh <= 23
    if (!mer && hh >= 0 && hh <= 23) {
        return hh * 60 + mm;
    }
    if (!mer) return null; // Invalid — no am/pm and invalid hour
    return hh * 60 + mm;
}

function minutesToTime(min) {
    let h = Math.floor(min / 60);
    let m = min % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + m.toString().padStart(2, '0') + ap;
}

function minutesToISO(min, referenceDate) {
    // Build an ISO string using a reference date (today)
    const d = referenceDate ? new Date(referenceDate) : new Date();
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d.toISOString();
}

function roundToNearest(value, increment) {
    return Math.round(value / increment) * increment;
}

function uid() {
    return 'rain_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function isFixedBlock(event) {
    if (!event) return false;
    const lower = event.toLowerCase().trim();
    return FIXED_BLOCK_EVENTS.some(f => lower.includes(f));
}

function isWallBlock(event) {
    if (!event) return false;
    const lower = event.toLowerCase().trim();
    return WALL_BLOCK_EVENTS.some(w => lower.includes(w));
}

function isPinnedEvent(event) {
    if (!event) return false;
    const lower = event.toLowerCase().trim();
    return PINNED_EVENTS.some(p => lower.includes(p));
}

function isSchedulableBlock(block) {
    if (!block) return false;
    const type = (block.type || '').toLowerCase();
    const event = (block.event || '').toLowerCase();
    
    // These types are always schedulable
    if (['slot', 'activity', 'sports', 'special', 'smart'].includes(type)) return true;
    
    // League blocks during rain become specials
    if (['league', 'specialty_league'].includes(type)) return true;
    
    // Pinned events that are actual activities (not lunch/snack/dismissal)
    if (type === 'pinned' && !isPinnedEvent(event)) return true;
    
    return false;
}

// =========================================================================
// FLEX RANGE CALCULATOR
// =========================================================================

function getFlexRange(durationMin) {
    const flex = Math.round(durationMin * FLEX_PERCENT);
    return {
        min: durationMin - flex,
        max: durationMin + flex,
        ideal: durationMin
    };
}

// =========================================================================
// SKELETON PARSER
// =========================================================================

/**
 * Parse a skeleton into an ordered queue of blocks with metadata.
 * 
 * @param {Array} skeleton - The raw skeleton array from savedSkeletons
 * @param {string} divisionName - The division to filter for
 * @returns {Object} { activityQueue, fixedBlocks, wallTime, allBlocks }
 */
function parseSkeletonForDivision(skeleton, divisionName) {
    if (!skeleton || !Array.isArray(skeleton)) {
        console.warn('[RainStacker] No skeleton provided');
        return { activityQueue: [], fixedBlocks: [], wallTime: null, allBlocks: [] };
    }

    // Filter blocks for this division
    const divBlocks = skeleton
        .filter(b => b.division === divisionName || b.division === String(divisionName))
        .map(b => {
            const startMin = parseTimeToMinutes(b.startTime) ?? b.startMin;
            const endMin = parseTimeToMinutes(b.endTime) ?? b.endMin;
            return {
                ...b,
                startMin,
                endMin,
                duration: (endMin && startMin) ? endMin - startMin : (b.duration || 0),
                event: b.event || b.type || 'Unknown'
            };
        })
        .filter(b => b.startMin != null && b.endMin != null)
        .sort((a, b) => a.startMin - b.startMin);

    const activityQueue = [];
    const fixedBlocks = [];
    let wallTime = null;

    divBlocks.forEach(block => {
        if (isWallBlock(block.event)) {
            // Dismissal — this is the hard wall
            wallTime = block.startMin;
            fixedBlocks.push({
                ...block,
                _role: 'wall'
            });
        } else if (isFixedBlock(block.event)) {
            // Snack, Lunch — these float but must happen
            fixedBlocks.push({
                ...block,
                _role: 'fixed',
                duration: block.duration
            });
        } else if (isSchedulableBlock(block)) {
            // Activity blocks — these form the queue
            activityQueue.push({
                ...block,
                _role: 'activity',
                duration: block.duration,
                flex: getFlexRange(block.duration)
            });
        } else {
            // Other pinned events (arrival, davening, etc.) — keep as fixed
            fixedBlocks.push({
                ...block,
                _role: 'fixed',
                duration: block.duration
            });
        }
    });

    return { activityQueue, fixedBlocks, wallTime, allBlocks: divBlocks };
}

// =========================================================================
// SNAP LOGIC
// =========================================================================

/**
 * Check if we should snap to a nearby skeleton block boundary.
 * 
 * @param {number} rainStartMin - The rain start time in minutes
 * @param {Array} allBlocks - All skeleton blocks for the division
 * @returns {number} The effective start time (snapped or original)
 */
function calculateEffectiveStart(rainStartMin, allBlocks) {
    // Round to nearest 5 minutes first
    let effectiveStart = roundToNearest(rainStartMin, ROUND_TO_MIN);
    
    // Look for nearby skeleton block boundaries
    for (const block of allBlocks) {
        const boundary = block.startMin;
        if (boundary > effectiveStart) {
            const gap = boundary - effectiveStart;
            if (gap <= SNAP_THRESHOLD_MIN) {
                console.log(`[RainStacker] Snapping from ${minutesToTime(effectiveStart)} to skeleton boundary at ${minutesToTime(boundary)} (${gap}min gap → transition)`);
                return boundary;
            }
            break; // Only check the next boundary
        }
    }
    
    return effectiveStart;
}

// =========================================================================
// CORE STACKING ALGORITHM
// =========================================================================

/**
 * Stack activities sequentially from startTime to wallTime.
 * 
 * Algorithm:
 *   1. Take the activity queue in order
 *   2. Insert fixed blocks (snack) at their natural queue position
 *   3. Place each block with its ideal duration
 *   4. If the last block doesn't fit, try compressing within flex ranges
 *   5. If still doesn't fit, drop the last activity
 *   6. If there's leftover time, stretch activities within flex ranges
 * 
 * @param {Object} params
 * @param {number} params.startTime - Minutes since midnight to start stacking
 * @param {number} params.wallTime - Dismissal time (hard wall)
 * @param {Array}  params.activityQueue - Ordered activity blocks from skeleton
 * @param {Array}  params.fixedBlocks - Fixed blocks (snack, etc.) that must be placed
 * @param {string} params.divisionName - Division name for the output blocks
 * @returns {Array} Rebuilt skeleton blocks for this division from startTime onward
 */
function stackSchedule({ startTime, wallTime, activityQueue, fixedBlocks, divisionName }) {
    console.log(`[RainStacker] === Stacking for ${divisionName} ===`);
    console.log(`[RainStacker] Start: ${minutesToTime(startTime)}, Wall: ${minutesToTime(wallTime)}`);
    console.log(`[RainStacker] Activities: ${activityQueue.length}, Fixed: ${fixedBlocks.length}`);
    
    if (!wallTime || startTime >= wallTime) {
        console.warn('[RainStacker] No time available to stack');
        return [];
    }

    const totalAvailable = wallTime - startTime;
    
    // =====================================================================
    // PHASE 0: Expand prep blocks (e.g., Skits → Skits Prep + Skits Main)
    // =====================================================================
    
    const expandedQueue = expandPrepBlocks(activityQueue);
    
    // =====================================================================
    // PHASE 1: Build the ordered queue (activities + fixed blocks interleaved)
    // =====================================================================
    
    // Separate fixed blocks that should happen AFTER our start time
    const relevantFixed = fixedBlocks.filter(fb => {
        if (fb._role === 'wall') return false; // Wall handled separately
        // Include fixed blocks whose original time is after our start
        // OR fixed blocks that haven't happened yet (e.g., snack)
        return fb.startMin >= startTime || fb.endMin > startTime;
    });

    // Determine where fixed blocks should be inserted in the queue
    // Strategy: Insert fixed blocks at their relative position among activities
    // If snack was originally the 3rd block, insert it after the 2nd activity
    
    const buildQueue = () => {
        // Skip activities from the skeleton that ended before our start time
        const relevantActivities = expandedQueue.filter(a => a.endMin > startTime);
        
        // Interleave: place fixed blocks at their natural position
        // We determine position by original startMin relative to activities
        const allItems = [
            ...relevantActivities.map(a => ({ ...a, _queueType: a._queueType || 'activity' })),
            ...relevantFixed.map(f => ({ ...f, _queueType: 'fixed' }))
        ].sort((a, b) => a.startMin - b.startMin);
        
        return allItems;
    };

    const orderedQueue = buildQueue();
    
    console.log(`[RainStacker] Queue (${orderedQueue.length} items):`);
    orderedQueue.forEach((item, i) => {
        console.log(`  [${i}] ${item._queueType}: ${item.event} (${item.duration}min, orig ${minutesToTime(item.startMin)}-${minutesToTime(item.endMin)})`);
    });

    // =====================================================================
    // PHASE 2: Initial placement — stack with ideal durations
    // =====================================================================
    
    let cursor = startTime;
    const placed = [];
    const dropped = [];

    for (const item of orderedQueue) {
        const remainingTime = wallTime - cursor;
        
        if (remainingTime <= 0) {
            dropped.push(item);
            continue;
        }

        const duration = item.duration;
        const flex = item._queueType === 'activity' ? getFlexRange(duration) : { min: duration, max: duration, ideal: duration };
        
        if (remainingTime < flex.min) {
            // Can't fit even at minimum — drop it
            console.log(`[RainStacker] Dropping ${item.event}: needs ${flex.min}min, only ${remainingTime}min left`);
            dropped.push(item);
            continue;
        }

        // Place it with ideal duration (or remaining time if less)
        const actualDuration = Math.min(flex.ideal, remainingTime);
        
        placed.push({
            ...item,
            _placedStart: cursor,
            _placedEnd: cursor + actualDuration,
            _placedDuration: actualDuration,
            _flex: flex
        });
        
        cursor += actualDuration;
    }

    console.log(`[RainStacker] After initial placement: ${placed.length} placed, ${dropped.length} dropped, cursor at ${minutesToTime(cursor)}`);

    // =====================================================================
    // PHASE 3: Handle gap between last activity and wall
    // =====================================================================
    
    const gap = wallTime - cursor;
    
    if (gap > 0 && gap <= MIN_USEFUL_GAP) {
        // Tiny gap — absorb into last activity if possible
        const last = placed[placed.length - 1];
        if (last && last._queueType === 'activity') {
            const newDuration = last._placedDuration + gap;
            if (newDuration <= last._flex.max) {
                last._placedEnd = wallTime;
                last._placedDuration = newDuration;
                console.log(`[RainStacker] Absorbed ${gap}min gap into ${last.event} (now ${newDuration}min)`);
            }
        }
    } else if (gap > MIN_USEFUL_GAP) {
        // Significant gap — distribute across activities
        console.log(`[RainStacker] ${gap}min gap remaining — distributing across activities`);
        distributeExtraTime(placed, gap);
    }

    // =====================================================================
    // PHASE 4: Check if last placed activity got squeezed below minimum
    // =====================================================================
    
    for (let i = placed.length - 1; i >= 0; i--) {
        const item = placed[i];
        if (item._queueType === 'activity' && item._placedDuration < item._flex.min) {
            console.log(`[RainStacker] ${item.event} at ${item._placedDuration}min is below minimum ${item._flex.min}min`);
            
            // Try compressing earlier activities to give this one more time
            const needed = item._flex.min - item._placedDuration;
            const recovered = compressEarlierActivities(placed, i, needed);
            
            if (recovered >= needed) {
                // Recalculate positions after compression
                recalculatePositions(placed, startTime);
                console.log(`[RainStacker] Recovered ${recovered}min by compressing earlier activities`);
            } else {
                // Still can't fit — drop this activity and redistribute
                console.log(`[RainStacker] Can't recover enough time — dropping ${item.event}`);
                const removedItem = placed.splice(i, 1)[0];
                dropped.push(removedItem);
                recalculatePositions(placed, startTime);
                
                // Now we have extra time — redistribute
                const newGap = wallTime - (placed.length > 0 ? placed[placed.length - 1]._placedEnd : startTime);
                if (newGap > 0) {
                    distributeExtraTime(placed, newGap);
                }
            }
        }
    }

    // =====================================================================
    // PHASE 4.5: Validate prep/main block coupling
    // =====================================================================
    // If a prep block was placed but its main block was dropped (or vice versa),
    // drop the orphaned prep and redistribute its time.
    
    let couplingChanged = true;
    while (couplingChanged) {
        couplingChanged = false;
        
        for (let i = placed.length - 1; i >= 0; i--) {
            const item = placed[i];
            
            if (item._isPrepBlock) {
                // Check if main block exists in placed
                const mainExists = placed.some(p => p._isMainBlock && p._mainActivity === item._mainActivity);
                if (!mainExists) {
                    console.log(`[RainStacker] Orphaned prep block "${item.event}" — dropping (main was dropped)`);
                    placed.splice(i, 1);
                    dropped.push(item);
                    couplingChanged = true;
                }
            }
            
            if (item._isMainBlock && item._hasPrep) {
                // Check if prep block exists in placed
                const prepExists = placed.some(p => p._isPrepBlock && p._mainActivity === item.event);
                if (!prepExists) {
                    console.log(`[RainStacker] Main block "${item.event}" has no prep — removing _hasPrep flag`);
                    item._hasPrep = false; // Allow it to stand alone
                }
            }
        }
    }
    
    if (placed.length > 0) {
        recalculatePositions(placed, startTime);
        const couplingGap = wallTime - placed[placed.length - 1]._placedEnd;
        if (couplingGap > 0) {
            distributeExtraTime(placed, couplingGap);
        }
    }

    // =====================================================================
    // PHASE 5: Final gap check — ensure we reach the wall
    // =====================================================================
    
    const finalEnd = placed.length > 0 ? placed[placed.length - 1]._placedEnd : startTime;
    const finalGap = wallTime - finalEnd;
    
    if (finalGap > 0) {
        distributeExtraTime(placed, finalGap);
    }

    // =====================================================================
    // PHASE 6: Build output skeleton blocks
    // =====================================================================
    
    const referenceDate = new Date(); // For ISO string generation
    const outputBlocks = [];

    placed.forEach((item, idx) => {
        outputBlocks.push({
            id: uid(),
            _originalId: item._originalId || item.id,
            type: item._queueType === 'fixed' ? 'pinned' : 
                  // ★★★ FIX: Convert league types to 'slot' during rainy day ★★★
                  // The optimizer skips league blocks on rainy days (Steps 4/5),
                  // so league-type blocks in the rebuilt skeleton would become empty.
                  // Converting to 'slot' ensures they get treated as general activity
                  // blocks and receive proper special activity assignments.
                  (['league', 'specialty_league'].includes((item.type || '').toLowerCase())
                      ? 'slot' : item.type || 'special'),
            event: (['league', 'specialty_league'].includes((item.type || '').toLowerCase())
                      ? 'General Activity Slot' : item.event),
            division: divisionName,
            startTime: minutesToTime(item._placedStart),
            endTime: minutesToTime(item._placedEnd),
            startMin: item._placedStart,
            endMin: item._placedEnd,
            duration: item._placedDuration,
            start: minutesToISO(item._placedStart, referenceDate),
            end: minutesToISO(item._placedEnd, referenceDate),
            label: `${minutesToTime(item._placedStart)} - ${minutesToTime(item._placedEnd)}`,
            slotIndex: idx,
            _midDayRebuilt: true,
            _originalDuration: item.duration,
            _flexApplied: item._placedDuration !== item.duration
        });
    });

    // Add the dismissal/wall block at the end
    const wallBlock = fixedBlocks.find(fb => fb._role === 'wall');
    if (wallBlock) {
        const wallEnd = wallBlock.endMin || (wallTime + (wallBlock.duration || 20));
        outputBlocks.push({
            id: uid(),
            _originalId: wallBlock._originalId || wallBlock.id,
            type: 'pinned',
            event: wallBlock.event || 'Dismissal',
            division: divisionName,
            startTime: minutesToTime(wallTime),
            endTime: minutesToTime(wallEnd),
            startMin: wallTime,
            endMin: wallEnd,
            duration: wallEnd - wallTime,
            start: minutesToISO(wallTime, referenceDate),
            end: minutesToISO(wallEnd, referenceDate),
            label: `${minutesToTime(wallTime)} - ${minutesToTime(wallEnd)}`,
            slotIndex: outputBlocks.length,
            _midDayRebuilt: true
        });
    }

    console.log(`[RainStacker] === Final schedule for ${divisionName} ===`);
    outputBlocks.forEach(b => {
        console.log(`  ${b.startTime} - ${b.endTime} | ${b.event} (${b.duration}min) ${b._flexApplied ? '[flexed]' : ''}`);
    });

    return outputBlocks;
}

// =========================================================================
// COMPRESSION & DISTRIBUTION HELPERS
// =========================================================================

/**
 * Compress earlier activities to free up time for a later one.
 * Returns the total minutes recovered.
 */
function compressEarlierActivities(placed, targetIdx, needed) {
    let recovered = 0;
    
    // Work backwards from the item before target
    for (let i = targetIdx - 1; i >= 0 && recovered < needed; i--) {
        const item = placed[i];
        if (item._queueType !== 'activity') continue;
        
        const canShrink = item._placedDuration - item._flex.min;
        if (canShrink <= 0) continue;
        
        const shrinkBy = Math.min(canShrink, needed - recovered);
        item._placedDuration -= shrinkBy;
        recovered += shrinkBy;
        
        console.log(`[RainStacker] Compressed ${item.event} by ${shrinkBy}min (now ${item._placedDuration}min)`);
    }
    
    return recovered;
}

/**
 * Distribute extra time across activity blocks (stretch them).
 */
function distributeExtraTime(placed, extraMinutes) {
    if (extraMinutes <= 0) return;
    
    // Get activities that can stretch (NOT fixed blocks like snack/lunch)
    const stretchable = placed.filter(p => 
        p._queueType === 'activity' && p._placedDuration < p._flex.max
    );
    
    if (stretchable.length === 0) {
        // No flexible activities — extend the last ACTIVITY (skip fixed blocks)
        for (let i = placed.length - 1; i >= 0; i--) {
            if (placed[i]._queueType === 'activity') {
                placed[i]._placedDuration += extraMinutes;
                placed[i]._placedEnd += extraMinutes;
                console.log(`[RainStacker] Force-extended ${placed[i].event} by ${extraMinutes}min (beyond flex, no other options)`);
                break;
            }
        }
        // Recalculate all positions
        if (placed.length > 0) {
            let cursor = placed[0]._placedStart;
            for (const item of placed) {
                item._placedStart = cursor;
                item._placedEnd = cursor + item._placedDuration;
                cursor = item._placedEnd;
            }
        }
        return;
    }
    
    let remaining = extraMinutes;
    
    // Distribute evenly, respecting max flex
    while (remaining > 0) {
        let distributed = 0;
        const canStretch = stretchable.filter(p => p._placedDuration < p._flex.max);
        
        if (canStretch.length === 0) break;
        
        const perItem = Math.max(1, Math.floor(remaining / canStretch.length));
        
        for (const item of canStretch) {
            if (remaining <= 0) break;
            const canAdd = item._flex.max - item._placedDuration;
            const addAmount = Math.min(canAdd, perItem, remaining);
            
            item._placedDuration += addAmount;
            remaining -= addAmount;
            distributed += addAmount;
        }
        
        if (distributed === 0) break; // Safety valve
    }
    
    // Recalculate positions
    if (placed.length > 0) {
        let cursor = placed[0]._placedStart;
        for (const item of placed) {
            item._placedStart = cursor;
            item._placedEnd = cursor + item._placedDuration;
            cursor = item._placedEnd;
        }
    }
    
    if (remaining > 0) {
        // Still have leftover — extend last ACTIVITY (not fixed block)
        for (let i = placed.length - 1; i >= 0; i--) {
            if (placed[i]._queueType === 'activity') {
                placed[i]._placedDuration += remaining;
                placed[i]._placedEnd += remaining;
                // Re-recalculate from that point
                let cursor = placed[i]._placedEnd;
                for (let j = i + 1; j < placed.length; j++) {
                    placed[j]._placedStart = cursor;
                    placed[j]._placedEnd = cursor + placed[j]._placedDuration;
                    cursor = placed[j]._placedEnd;
                }
                break;
            }
        }
    }
}

/**
 * Recalculate start/end positions after modifications.
 */
function recalculatePositions(placed, startTime) {
    let cursor = startTime;
    for (const item of placed) {
        item._placedStart = cursor;
        item._placedEnd = cursor + item._placedDuration;
        cursor = item._placedEnd;
    }
}

// =========================================================================
// MAIN ENTRY POINT: REBUILD SCHEDULE FROM MID-DAY TRANSITION
// =========================================================================

/**
 * Rebuild the schedule for all divisions from a transition point.
 * 
 * This is the main function called when:
 *   - Mid-day rain starts (switch regular → rainy skeleton)
 *   - Mid-day rain clears (switch rainy → regular skeleton)
 * 
 * @param {Object} params
 * @param {number} params.transitionTime - Time rain started/cleared (minutes since midnight)
 * @param {string} params.targetSkeletonName - Name of the skeleton to switch TO
 * @param {boolean} params.isRainStarting - true = switching to rainy, false = switching to regular
 * @param {Object} [params.resourceOverrides] - Optional capacity/availability overrides
 * @returns {Object} { success, rebuiltSkeleton, summary }
 */
function rebuildFromTransition({ transitionTime, targetSkeletonName, isRainStarting, resourceOverrides }) {
    console.log(`\n[RainStacker] ========================================`);
    console.log(`[RainStacker] REBUILD FROM TRANSITION`);
    console.log(`[RainStacker] Time: ${minutesToTime(transitionTime)}`);
    console.log(`[RainStacker] Target skeleton: ${targetSkeletonName}`);
    console.log(`[RainStacker] Direction: ${isRainStarting ? 'Regular → Rainy' : 'Rainy → Regular'}`);
    console.log(`[RainStacker] ========================================\n`);

    // Load target skeleton
    const g = window.loadGlobalSettings?.() || {};
    const savedSkeletons = g.app1?.savedSkeletons || {};
    const targetSkeleton = savedSkeletons[targetSkeletonName];

    if (!targetSkeleton || targetSkeleton.length === 0) {
        console.error(`[RainStacker] Target skeleton "${targetSkeletonName}" not found or empty`);
        return { success: false, error: 'Skeleton not found' };
    }

    // Load current skeleton (the one currently active)
    const dailyData = window.loadCurrentDailyData?.() || {};
    const currentSkeleton = dailyData.manualSkeleton || [];

    // Get divisions
    const divisions = g.app1?.divisions || {};
    const divisionNames = Object.keys(divisions);

    if (divisionNames.length === 0) {
        console.error('[RainStacker] No divisions configured');
        return { success: false, error: 'No divisions' };
    }

    // Round transition time
    const effectiveTransition = roundToNearest(transitionTime, ROUND_TO_MIN);
    
    const rebuiltSkeleton = [];
    const summary = {
        transitionTime: minutesToTime(effectiveTransition),
        divisions: {},
        direction: isRainStarting ? 'rain_starting' : 'rain_clearing'
    };

    // Process each division
    for (const divName of divisionNames) {
        console.log(`\n[RainStacker] --- Processing division: ${divName} ---`);

        // PART A: Keep blocks from CURRENT skeleton that completed before transition
        // ★★★ Also handle blocks IN-PROGRESS at transition time (truncate them) ★★★
        const currentDivBlocks = currentSkeleton
            .filter(b => (b.division === divName || b.division === String(divName)))
            .map(b => ({
                ...b,
                startMin: parseTimeToMinutes(b.startTime) ?? b.startMin,
                endMin: parseTimeToMinutes(b.endTime) ?? b.endMin
            }))
            .filter(b => b.startMin != null && b.endMin != null)
            .sort((a, b) => a.startMin - b.startMin);

        const preservedBlocks = [];
        
        for (const block of currentDivBlocks) {
            if (block.endMin <= effectiveTransition) {
                // Block completed before transition — preserve as-is
                preservedBlocks.push(block);
            } else if (block.startMin < effectiveTransition && block.endMin > effectiveTransition) {
                // ★★★ Block is IN-PROGRESS at transition — truncate to end at transition ★★★
                const truncated = {
                    ...block,
                    endTime: minutesToTime(effectiveTransition),
                    endMin: effectiveTransition,
                    duration: effectiveTransition - block.startMin,
                    end: minutesToISO(effectiveTransition, new Date()),
                    label: `${block.startTime || minutesToTime(block.startMin)} - ${minutesToTime(effectiveTransition)}`,
                    _truncatedAtTransition: true,
                    _originalEndMin: block.endMin
                };
                preservedBlocks.push(truncated);
                console.log(`[RainStacker] Truncated in-progress block "${block.event}" at ${minutesToTime(effectiveTransition)} (was ${minutesToTime(block.startMin)}-${minutesToTime(block.endMin)})`);
            }
            // Blocks that start at or after transition are dropped (will be rebuilt)
        }
        
        // Ensure all preserved blocks have ISO strings for consistency
        const refDate = new Date();
        preservedBlocks.forEach(b => {
            if (!b.start) b.start = minutesToISO(b.startMin, refDate);
            if (!b.end) b.end = minutesToISO(b.endMin, refDate);
            if (!b.label) b.label = `${b.startTime || minutesToTime(b.startMin)} - ${b.endTime || minutesToTime(b.endMin)}`;
        });
        
        console.log(`[RainStacker] Preserving ${preservedBlocks.length} blocks before ${minutesToTime(effectiveTransition)}`);

        // PART B: Parse target skeleton for this division
        const { activityQueue, fixedBlocks, wallTime, allBlocks } = parseSkeletonForDivision(targetSkeleton, divName);

        if (!wallTime) {
            console.warn(`[RainStacker] No dismissal found for ${divName} in target skeleton — using current skeleton's dismissal`);
            // Try to get wall time from current skeleton
            const currentWall = currentDivBlocks.find(b => isWallBlock(b.event));
            if (!currentWall) {
                console.error(`[RainStacker] No dismissal found at all for ${divName}, skipping`);
                continue;
            }
        }

        const effectiveWall = wallTime || currentDivBlocks.find(b => isWallBlock(b.event))?.startMin;
        
        if (!effectiveWall || effectiveTransition >= effectiveWall) {
            console.warn(`[RainStacker] Transition time is at or past dismissal for ${divName}, skipping`);
            // Just keep current skeleton as-is
            rebuiltSkeleton.push(...currentDivBlocks);
            continue;
        }

        // PART C: Calculate effective start time (with snap logic)
        const effectiveStart = calculateEffectiveStart(effectiveTransition, allBlocks);

        // Handle snap gap (transition time)
        if (effectiveStart > effectiveTransition) {
            // Add a transition block for the snap gap
            preservedBlocks.push({
                id: uid(),
                type: 'pinned',
                event: 'Transition',
                division: divName,
                startTime: minutesToTime(effectiveTransition),
                endTime: minutesToTime(effectiveStart),
                startMin: effectiveTransition,
                endMin: effectiveStart,
                duration: effectiveStart - effectiveTransition,
                label: `${minutesToTime(effectiveTransition)} - ${minutesToTime(effectiveStart)}`,
                _midDayRebuilt: true
            });
        }

        // PART D: Stack the new schedule
        const stackedBlocks = stackSchedule({
            startTime: effectiveStart,
            wallTime: effectiveWall,
            activityQueue,
            fixedBlocks,
            divisionName: divName
        });

        // PART E: Combine preserved + stacked
        const divisionResult = [...preservedBlocks, ...stackedBlocks];
        
        // Re-index slot indices
        divisionResult.forEach((block, idx) => {
            block.slotIndex = idx;
        });

        rebuiltSkeleton.push(...divisionResult);

        summary.divisions[divName] = {
            preserved: preservedBlocks.length,
            stacked: stackedBlocks.length,
            dropped: activityQueue.length - stackedBlocks.filter(b => b.type !== 'pinned').length,
            effectiveStart: minutesToTime(effectiveStart),
            wallTime: minutesToTime(effectiveWall)
        };
    }

    // Apply resource overrides if provided
    if (resourceOverrides) {
        applyResourceOverrides(resourceOverrides, isRainStarting);
    }

    // Save the rebuilt skeleton — MUST use all storage paths
    // daily_adjustments.js reads from: campManualSkeleton_{dateKey} (localStorage) 
    //   and app1.dailySkeletons[dateKey] (cloud)
    // optimizer reads from: window.dailyOverrideSkeleton, then falls back to above
    // saveCurrentDailyData saves to: campDailyData_v1[dateKey].manualSkeleton
    // We need ALL of these to be consistent.
    
    window.dailyOverrideSkeleton = rebuiltSkeleton;
    window.saveCurrentDailyData?.('manualSkeleton', rebuiltSkeleton);
    
    // ★★★ FIX: Also save to the paths daily_adjustments.js and the optimizer read ★★★
    const dateKey = window.currentScheduleDate;
    if (dateKey) {
        // Path 1: localStorage (what daily_adjustments loadDailySkeleton reads first)
        try {
            const storageKey = `campManualSkeleton_${dateKey}`;
            localStorage.setItem(storageKey, JSON.stringify(rebuiltSkeleton));
            console.log(`[RainStacker] ✅ Saved skeleton to localStorage (${storageKey})`);
        } catch (e) {
            console.error('[RainStacker] Failed to save skeleton to localStorage:', e);
        }
        
        // Path 2: app1.dailySkeletons (what optimizer's getSkeletonFromAnySource reads)
        try {
            const g = window.loadGlobalSettings?.() || {};
            if (g.app1) {
                if (!g.app1.dailySkeletons) g.app1.dailySkeletons = {};
                g.app1.dailySkeletons[dateKey] = rebuiltSkeleton;
                window.saveGlobalSettings?.('app1', g.app1);
                console.log(`[RainStacker] ✅ Saved skeleton to app1.dailySkeletons`);
            }
        } catch (e) {
            console.error('[RainStacker] Failed to save skeleton to app1:', e);
        }
    }

    console.log(`\n[RainStacker] ========================================`);
    console.log(`[RainStacker] REBUILD COMPLETE`);
    console.log(`[RainStacker] Total blocks: ${rebuiltSkeleton.length}`);
    console.log(`[RainStacker] Summary:`, JSON.stringify(summary, null, 2));
    console.log(`[RainStacker] ========================================\n`);

    return { success: true, rebuiltSkeleton, summary };
}

// =========================================================================
// RESOURCE OVERRIDE BUILDER (fallback — daily_adjustments.js may override)
// =========================================================================

/**
 * Build resource overrides from field configuration.
 * This is a fallback if daily_adjustments.js hasn't been patched yet.
 */
function buildRainyDayResourceOverrides() {
    // Use the patched version from daily_adjustments.js if available
    if (typeof window.buildRainyDayResourceOverrides === 'function') {
        return window.buildRainyDayResourceOverrides();
    }
    
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const overrides = { capacityOverrides: {}, availabilityOverrides: [] };
    
    fields.forEach(f => {
        if (f.rainyDayCapacity != null && f.rainyDayCapacity > 0) {
            overrides.capacityOverrides[f.name] = f.rainyDayCapacity;
        }
        if (f.rainyDayAvailableAllDay === true && f.timeRules && f.timeRules.length > 0) {
            overrides.availabilityOverrides.push(f.name);
        }
    });
    
    return overrides;
}

// Also expose on window as fallback
if (typeof window.buildRainyDayResourceOverrides !== 'function') {
    window.buildRainyDayResourceOverrides = buildRainyDayResourceOverrides;
}

// =========================================================================
// RESOURCE OVERRIDES
// =========================================================================

/**
 * Apply rainy day resource overrides (capacity bumps, availability unlocks).
 * 
 * @param {Object} overrides - { capacityOverrides: { fieldName: newCapacity }, availabilityOverrides: [fieldNames] }
 * @param {boolean} isRainStarting - true = apply overrides, false = revert overrides
 */
function applyResourceOverrides(overrides, isRainStarting) {
    if (!overrides) return;

    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    let changed = false;

    if (isRainStarting) {
        // Apply capacity overrides
        if (overrides.capacityOverrides) {
            for (const [fieldName, newCapacity] of Object.entries(overrides.capacityOverrides)) {
                const field = fields.find(f => f.name === fieldName);
                if (field) {
                    // Store original capacity for later restoration
                    if (!field._preRainyCapacity) {
                        field._preRainyCapacity = field.sharableWith?.capacity || 1;
                    }
                    if (field.sharableWith) {
                        field.sharableWith.capacity = newCapacity;
                        console.log(`[RainStacker] Capacity override: ${fieldName} → ${newCapacity}`);
                        changed = true;
                    }
                }
            }
        }

        // Apply availability overrides (unlock time-restricted fields)
        if (overrides.availabilityOverrides) {
            for (const fieldName of overrides.availabilityOverrides) {
                const field = fields.find(f => f.name === fieldName);
                if (field) {
                    if (!field._preRainyTimeRules) {
                        field._preRainyTimeRules = JSON.parse(JSON.stringify(field.timeRules || []));
                    }
                    field.timeRules = []; // Clear time restrictions
                    console.log(`[RainStacker] Availability override: ${fieldName} → all day`);
                    changed = true;
                }
            }
        }
    } else {
        // Revert overrides
        for (const field of fields) {
            if (field._preRainyCapacity != null) {
                if (field.sharableWith) {
                    field.sharableWith.capacity = field._preRainyCapacity;
                }
                delete field._preRainyCapacity;
                changed = true;
            }
            if (field._preRainyTimeRules) {
                field.timeRules = field._preRainyTimeRules;
                delete field._preRainyTimeRules;
                changed = true;
            }
        }
    }

    if (changed) {
        window.saveGlobalSettings?.('app1', g.app1);
        window.forceSyncToCloud?.();
    }
}

// =========================================================================
// CONVENIENCE WRAPPERS (v2.0 — morning preserved via _pinned)
// =========================================================================

/**
 * Helper: extract endMin from a unifiedTimes slot entry.
 * Handles both .endMin property and .end ISO string formats.
 */
function getSlotEndMin(slot) {
    if (!slot) return undefined;
    if (slot.endMin !== undefined) return slot.endMin;
    if (slot.end) {
        const d = new Date(slot.end);
        return d.getHours() * 60 + d.getMinutes();
    }
    return undefined;
}

/**
 * Handle mid-day rain start.
 * Called when user activates mid-day rain mode.
 * 
 * @param {number} rainStartMinutes - When rain started (minutes since midnight)
 * @param {Object} [resourceOverrides] - Optional resource overrides
 * @returns {Object} Result from rebuildFromTransition
 */
function handleMidDayRainStart(rainStartMinutes, resourceOverrides) {
    const rainySkeletonName = window.getRainyDaySkeletonName?.() || 
                              (window.loadGlobalSettings?.() || {}).rainyDaySkeletonName;
    
    if (!rainySkeletonName) {
        console.error('[RainStacker] No rainy day skeleton configured');
        return { success: false, error: 'No rainy day skeleton configured. Please set one in Rainy Day settings.' };
    }

    // ★★★ Store the current regular skeleton name for later restoration ★★★
    const g = window.loadGlobalSettings?.() || {};
    const dateKey = window.currentScheduleDate;
    const assignments = g.app1?.skeletonAssignments || {};
    if (dateKey) {
        const [Y, M, D] = dateKey.split('-').map(Number);
        let dow = 0;
        if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const regularName = assignments[dayNames[dow]] || assignments['Default'] || '';
        window.saveCurrentDailyData?.('_preRainySkeletonName', regularName);
    }

    // ★★★ FIX: Clear stale league data before rebuild ★★★
    // Same pattern as activateFullDayRainyMode() in daily_adjustments.js.
    // Without this, old leagueAssignments persist and the renderer shows
    // ghost league games in post-transition slots.
    window.leagueAssignments = {};

    // ★★★ v2.0: Snapshot ENTIRE current schedule + times BEFORE rebuild ★★★
    // We capture the full state so prePlaceMorningAssignments() can map
    // morning entries to new slot indices by TIME after the skeleton changes.
    const preRebuildTimes = JSON.parse(JSON.stringify(window.unifiedTimes || []));
    const preRebuildAssignments = JSON.parse(JSON.stringify(window.scheduleAssignments || {}));
    let preservedCount = 0;
    
    // Count how many morning slots we'll preserve (for logging)
    Object.keys(preRebuildAssignments).forEach(bunk => {
        const bunkSlots = preRebuildAssignments[bunk] || [];
        if (!Array.isArray(bunkSlots)) return;
        bunkSlots.forEach((slot, idx) => {
            if (slot && preRebuildTimes[idx]) {
                const endMin = getSlotEndMin(preRebuildTimes[idx]);
                if (endMin !== undefined && endMin <= rainStartMinutes) preservedCount++;
            }
        });
    });
    
    console.log(`[RainStacker] Pre-rebuild snapshot: ${Object.keys(preRebuildAssignments).length} bunks, ${preservedCount} morning slots to preserve`);
    
    // Store for use by prePlaceMorningAssignments() after skeleton rebuild
    window._midDayPreRebuild = {
        assignments: preRebuildAssignments,
        times: preRebuildTimes,
        transitionMinutes: rainStartMinutes
    };

    const result = rebuildFromTransition({
        transitionTime: rainStartMinutes,
        targetSkeletonName: rainySkeletonName,
        isRainStarting: true,
        resourceOverrides
    });
    
    // ★★★ v2.0: Pre-populate morning schedule as _pinned, then regenerate afternoon only ★★★
    if (result.success) {
        prePlaceMorningAssignments(rainStartMinutes);
        triggerPostRebuildGeneration(preservedCount);
    }
    
    return result;
}

/**
 * Handle mid-day rain clear (switch back to regular schedule).
 * 
 * @param {number} clearTimeMinutes - When rain cleared (minutes since midnight)
 * @param {string} regularSkeletonName - Name of the regular day skeleton to restore
 * @param {Object} [resourceOverrides] - Optional resource overrides to revert
 * @returns {Object} Result from rebuildFromTransition
 */
function handleMidDayRainClear(clearTimeMinutes, regularSkeletonName, resourceOverrides) {
    if (!regularSkeletonName) {
        // Try to find the regular skeleton from backup
        const dailyData = window.loadCurrentDailyData?.() || {};
        regularSkeletonName = dailyData._preRainySkeletonName;
        
        if (!regularSkeletonName) {
            console.error('[RainStacker] No regular skeleton name available');
            return { success: false, error: 'No regular skeleton configured for restoration.' };
        }
    }

    // ★★★ v2.0: Snapshot ENTIRE current schedule + times BEFORE rebuild ★★★
    const preRebuildTimes = JSON.parse(JSON.stringify(window.unifiedTimes || []));
    const preRebuildAssignments = JSON.parse(JSON.stringify(window.scheduleAssignments || {}));
    let preservedCount = 0;
    
    Object.keys(preRebuildAssignments).forEach(bunk => {
        const bunkSlots = preRebuildAssignments[bunk] || [];
        if (!Array.isArray(bunkSlots)) return;
        bunkSlots.forEach((slot, idx) => {
            if (slot && preRebuildTimes[idx]) {
                const endMin = getSlotEndMin(preRebuildTimes[idx]);
                if (endMin !== undefined && endMin <= clearTimeMinutes) preservedCount++;
            }
        });
    });
    
    console.log(`[RainStacker] Pre-rebuild snapshot: ${Object.keys(preRebuildAssignments).length} bunks, ${preservedCount} pre-clear slots to preserve`);
    
    window._midDayPreRebuild = {
        assignments: preRebuildAssignments,
        times: preRebuildTimes,
        transitionMinutes: clearTimeMinutes
    };

    const result = rebuildFromTransition({
        transitionTime: clearTimeMinutes,
        targetSkeletonName: regularSkeletonName,
        isRainStarting: false,
        resourceOverrides
    });
    
    // ★★★ v2.0: Pre-populate pre-clear schedule as _pinned, then regenerate post-clear only ★★★
    if (result.success) {
        prePlaceMorningAssignments(clearTimeMinutes);
        triggerPostRebuildGeneration(preservedCount);
    }
    
    return result;
}

// =========================================================================
// SPECIAL ACTIVITY PREP BLOCK SUPPORT
// =========================================================================

/**
 * Expand activities that have prep blocks into two queue entries.
 * Call this BEFORE passing the queue to stackSchedule.
 * 
 * Special activities can have a prepDuration property indicating
 * they need a preparation block before the main activity.
 * e.g., Skits = 30min prep + 60min performance
 * 
 * @param {Array} activityQueue - The activity queue from parseSkeletonForDivision
 * @returns {Array} Expanded queue with prep blocks inserted
 */
function expandPrepBlocks(activityQueue) {
    const expanded = [];
    
    for (const item of activityQueue) {
        const activityName = item.event || '';
        
        // Check if this special activity has a prep duration
        const specialConfig = window.getSpecialActivityByName?.(activityName);
        const prepDuration = specialConfig?.prepDuration || 0;
        
        if (prepDuration > 0) {
            // ★★★ Prep is ADDITIONAL time before the main activity ★★★
            // The skeleton block's duration IS the main activity duration.
            // We add a separate prep block before it.
            
            // Prep block
            expanded.push({
                ...item,
                event: `${activityName} (Prep)`,
                duration: prepDuration,
                flex: getFlexRange(prepDuration),
                _isPrepBlock: true,
                _mainActivity: activityName,
                _queueType: 'activity'
            });
            
            // Main block (keeps original duration)
            expanded.push({
                ...item,
                event: activityName,
                duration: item.duration,
                flex: getFlexRange(item.duration),
                _isMainBlock: true,
                _hasPrep: true,
                _queueType: 'activity'
            });
            
            console.log(`[RainStacker] Expanded ${activityName}: ${prepDuration}min prep + ${item.duration}min main`);
        } else {
            expanded.push(item);
        }
    }
    
    return expanded;
}

// =========================================================================
// v2.0: PRE-PLACE MORNING ASSIGNMENTS
// =========================================================================

/**
 * Pre-place morning/pre-transition assignments into the NEW schedule slots.
 * 
 * After rebuildFromTransition(), the skeleton has changed (morning blocks kept,
 * afternoon rebuilt). The slot indices may have shifted. This function:
 * 1. Takes the pre-rebuild assignments and their old time info
 * 2. Maps each morning assignment to the correct NEW slot index by matching times
 * 3. Places them with _pinned: true so PinnedPreservation protects them during generation
 * 
 * This ensures the morning schedule persists EXACTLY as it was — the optimizer
 * only generates fresh assignments for post-transition slots.
 * 
 * @param {number} transitionMinutes - The transition time (rain start or clear time)
 */
function prePlaceMorningAssignments(transitionMinutes) {
    const preRebuild = window._midDayPreRebuild;
    if (!preRebuild) {
        console.warn('[RainStacker] No pre-rebuild data available for morning placement');
        return;
    }
    
    const { assignments: oldAssignments, times: oldTimes } = preRebuild;
    const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
    const newDivisionTimes = window.divisionTimes || {};
    
    // Initialize scheduleAssignments if needed
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    
    let placedCount = 0;
    let skippedCount = 0;
    
    console.log(`[RainStacker] ★ Pre-placing morning assignments (before ${minutesToTime(transitionMinutes)})...`);

    Object.keys(oldAssignments).forEach(bunk => {
        const oldBunkSlots = oldAssignments[bunk] || [];
        if (!oldBunkSlots || !Array.isArray(oldBunkSlots)) return;
        
        // Find this bunk's division
        const divName = Object.keys(divisions).find(d => 
            divisions[d].bunks?.includes(bunk)
        );
        if (!divName) return;
        
        // Get new slots for this division
        const newSlots = newDivisionTimes[divName] || newDivisionTimes[String(divName)] || [];
        if (newSlots.length === 0) return;
        
        // Ensure bunk array exists in new assignments
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(newSlots.length).fill(null);
        }
        
        // Build time→index map for new slots
        const newTimeMap = new Map();
        newSlots.forEach((slot, idx) => {
            if (slot.startMin !== undefined && slot.endMin !== undefined) {
                newTimeMap.set(`${slot.startMin}-${slot.endMin}`, idx);
            }
        });
        
        // Track which old slots are continuations so we don't double-process
        const processedContinuations = new Set();
        
        oldBunkSlots.forEach((entry, oldIdx) => {
            if (!entry) return;
            if (processedContinuations.has(oldIdx)) return;
            if (entry.continuation) return; // Will be handled by parent
            
            // Get old slot's time info
            const oldSlot = oldTimes[oldIdx];
            if (!oldSlot) return;
            
            let oldStartMin, oldEndMin;
            if (oldSlot.startMin !== undefined) {
                oldStartMin = oldSlot.startMin;
                oldEndMin = oldSlot.endMin;
            } else if (oldSlot.start) {
                const startDate = new Date(oldSlot.start);
                const endDate = new Date(oldSlot.end);
                oldStartMin = startDate.getHours() * 60 + startDate.getMinutes();
                oldEndMin = endDate.getHours() * 60 + endDate.getMinutes();
            } else {
                return; // Can't determine time
            }
            
            // Only preserve slots that ENDED before the transition
            if (oldEndMin > transitionMinutes) {
                skippedCount++;
                return;
            }
            
            // Find matching new slot by time — primary: exact time key
            const timeKey = `${oldStartMin}-${oldEndMin}`;
            let newIdx = newTimeMap.get(timeKey);
            
            // Fallback 1: find slot with exact startMin/endMin match
            if (newIdx === undefined) {
                for (let i = 0; i < newSlots.length; i++) {
                    if (newSlots[i].startMin === oldStartMin && newSlots[i].endMin === oldEndMin) {
                        newIdx = i;
                        break;
                    }
                }
            }
            
            // Fallback 2: closest match within ≤10min tolerance (handles rounding)
            if (newIdx === undefined) {
                let bestMatch = -1;
                let bestDiff = Infinity;
                for (let i = 0; i < newSlots.length; i++) {
                    const diff = Math.abs(newSlots[i].startMin - oldStartMin) + Math.abs(newSlots[i].endMin - oldEndMin);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        bestMatch = i;
                    }
                }
                if (bestMatch >= 0 && bestDiff <= 10) {
                    newIdx = bestMatch;
                }
            }
            
            if (newIdx === undefined || newIdx < 0) {
                console.warn(`[RainStacker] Could not map morning slot for ${bunk} (${oldStartMin}-${oldEndMin})`);
                skippedCount++;
                return;
            }
            
            // Place the entry with _pinned flag so PinnedPreservation protects it
            window.scheduleAssignments[bunk][newIdx] = {
                ...entry,
                _pinned: true,
                _preservedMorning: true,
                _midDayPreserved: true
            };
            placedCount++;
            
            // Also place continuation entries if this was a multi-slot activity
            if (entry._activity) {
                for (let nextOld = oldIdx + 1; nextOld < oldBunkSlots.length; nextOld++) {
                    const nextEntry = oldBunkSlots[nextOld];
                    if (!nextEntry || !nextEntry.continuation) break;
                    if (nextEntry._activity !== entry._activity) break;
                    
                    processedContinuations.add(nextOld);
                    
                    // Map continuation slot by time
                    const nextOldSlot = oldTimes[nextOld];
                    if (!nextOldSlot) break;
                    
                    let nextStartMin, nextEndMin;
                    if (nextOldSlot.startMin !== undefined) {
                        nextStartMin = nextOldSlot.startMin;
                        nextEndMin = nextOldSlot.endMin;
                    } else if (nextOldSlot.start) {
                        const sd = new Date(nextOldSlot.start);
                        const ed = new Date(nextOldSlot.end);
                        nextStartMin = sd.getHours() * 60 + sd.getMinutes();
                        nextEndMin = ed.getHours() * 60 + ed.getMinutes();
                    } else break;
                    
                    if (nextEndMin > transitionMinutes) break; // Don't preserve past transition
                    
                    const nextTimeKey = `${nextStartMin}-${nextEndMin}`;
                    let nextNewIdx = newTimeMap.get(nextTimeKey);
                    if (nextNewIdx === undefined) {
                        for (let i = 0; i < newSlots.length; i++) {
                            if (newSlots[i].startMin === nextStartMin && newSlots[i].endMin === nextEndMin) {
                                nextNewIdx = i;
                                break;
                            }
                        }
                    }
                    
                    if (nextNewIdx !== undefined && nextNewIdx >= 0) {
                        window.scheduleAssignments[bunk][nextNewIdx] = {
                            ...nextEntry,
                            _pinned: true,
                            _preservedMorning: true,
                            _midDayPreserved: true
                        };
                        placedCount++;
                    }
                }
            }
        });
    });
    
    console.log(`[RainStacker] ★ Pre-placed ${placedCount} morning entries as _pinned (${skippedCount} post-transition skipped)`);
    
    // Save immediately so PinnedPreservation can capture them
    window.saveCurrentDailyData?.('scheduleAssignments', window.scheduleAssignments);
}

// =========================================================================
// AUTO-REGENERATION: Trigger schedule generation after skeleton rebuild
// =========================================================================

/**
 * After the stacker rebuilds the skeleton, trigger the scheduler to
 * assign actual activities (sports, specials) to the new time blocks.
 * 
 * v2.0: Morning entries are already placed as _pinned by prePlaceMorningAssignments().
 * The PinnedPreservation system captures them before generation and restores
 * them after, so the optimizer only effectively fills post-transition slots.
 * 
 * The stacker creates the TIME STRUCTURE (when blocks happen).
 * The scheduler fills in the CONTENT (which activity goes where).
 */
function triggerPostRebuildGeneration(preservedSlotCount) {
    // ★★★ v2.1 FIX: Don't auto-generate here ★★★
    // The stacker runs BEFORE daily_adjustments.js sets window.isRainyDay = true,
    // disables outdoor fields, and clears leagueAssignments. If we generate here
    // (even with a 300ms delay), the optimizer may run before all rainy day state
    // is fully configured, causing:
    //   - Leagues appearing in post-transition slots (isRainyDay not set yet)
    //   - Wrong field availability (outdoor fields not disabled yet)
    //   - Stale leagueAssignments persisting
    //
    // Instead, we set a flag that daily_adjustments.js checks after setting up
    // all rainy day state. It then calls triggerMidDayGeneration() which is
    // guaranteed to run with correct state.
    
    console.log('[RainStacker] Skeleton rebuilt. Generation will be triggered by daily_adjustments after state setup.');
    console.log(`[RainStacker] ${preservedSlotCount} pre-transition slots placed as _pinned`);
    
    // Store the count for later use
    window._midDayPendingGeneration = {
        preservedSlotCount,
        timestamp: Date.now()
    };
}

/**
 * [DEPRECATED v2.0] Restore preserved morning schedule assignments after regeneration.
 * 
 * The main flow now uses prePlaceMorningAssignments() + PinnedPreservation:
 *   1. prePlaceMorningAssignments maps old assignments to new slots by TIME
 *   2. Marks them _pinned: true
 *   3. PinnedPreservation captures them before generation
 *   4. Optimizer generates — morning slots are protected
 *   5. PinnedPreservation restores them after generation
 * 
 * This function is kept only as a manual safety net / fallback.
 */
/**
 * Trigger generation after mid-day rain mode is FULLY configured.
 * Called by daily_adjustments.js AFTER:
 *   - window.isRainyDay = true
 *   - outdoor fields disabled
 *   - leagueAssignments cleared
 *   - rainyDayMode saved
 * 
 * This ensures the optimizer runs with correct rainy day state.
 */
function triggerMidDayGeneration() {
    const pending = window._midDayPendingGeneration;
    if (!pending) {
        console.warn('[RainStacker] No pending mid-day generation');
        return;
    }
    
    delete window._midDayPendingGeneration;
    
    console.log('[RainStacker] ★ Triggering mid-day generation (all rainy state configured)');
    console.log(`[RainStacker] isRainyDay=${window.isRainyDay}, leagueAssignments keys=${Object.keys(window.leagueAssignments || {}).length}`);
    
    try {
        if (typeof window.runSkeletonOptimizer !== 'function') {
            console.warn('[RainStacker] runSkeletonOptimizer not available — manual generation required');
            return;
        }
        
        const dailyData = window.loadCurrentDailyData?.() || {};
        let skeleton = dailyData.manualSkeleton || [];
        
        // ★★★ FIX: Check all skeleton sources if primary is empty ★★★
        if (skeleton.length === 0) {
            // Try window.dailyOverrideSkeleton (set by rebuildFromTransition)
            skeleton = window.dailyOverrideSkeleton || [];
            if (skeleton.length > 0) {
                console.log(`[RainStacker] Found skeleton via window.dailyOverrideSkeleton: ${skeleton.length} blocks`);
            }
        }
        if (skeleton.length === 0) {
            // Try localStorage direct
            const dateKey = window.currentScheduleDate;
            try {
                const stored = localStorage.getItem(`campManualSkeleton_${dateKey}`);
                if (stored) skeleton = JSON.parse(stored) || [];
                if (skeleton.length > 0) {
                    console.log(`[RainStacker] Found skeleton via localStorage: ${skeleton.length} blocks`);
                }
            } catch (e) { /* ignore */ }
        }
        if (skeleton.length === 0) {
            // Try app1.dailySkeletons
            const dateKey = window.currentScheduleDate;
            const g = window.loadGlobalSettings?.() || {};
            skeleton = g.app1?.dailySkeletons?.[dateKey] || [];
            if (skeleton.length > 0) {
                console.log(`[RainStacker] Found skeleton via app1.dailySkeletons: ${skeleton.length} blocks`);
            }
        }
        
        if (skeleton.length === 0) {
            console.error('[RainStacker] ❌ No skeleton found from ANY source — manual generation required');
            return;
        }
        
        console.log(`[RainStacker] Running optimizer with ${skeleton.length} skeleton blocks`);
        
        // Ensure leagueAssignments is clean (belt & suspenders)
        window.leagueAssignments = {};
        
        // Dispatch events for PinnedPreservation
        window.dispatchEvent(new CustomEvent('campistry-generation-starting', {
            detail: { source: 'midday-rain-stacker' }
        }));
        
        window.runSkeletonOptimizer(skeleton);
        
        window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
            detail: { source: 'midday-rain-stacker' }
        }));
        
        // Clean up
        delete window._midDayPreRebuild;
        
        console.log('[RainStacker] ✅ Mid-day generation complete');
        
    } catch (e) {
        console.error('[RainStacker] Mid-day generation failed:', e);
    }
    
    // Refresh UI
    window.updateTable?.();
    if (typeof window.renderGrid === 'function') window.renderGrid();
}

function restorePreservedMorningSchedule() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const backup = dailyData.preservedScheduleBackup;
    
    if (!backup || Object.keys(backup).length === 0) {
        console.log('[RainStacker] No morning schedule backup to restore');
        return;
    }
    
    const schedules = window.scheduleAssignments || {};
    let restored = 0;
    
    Object.keys(backup).forEach(bunk => {
        if (!schedules[bunk]) schedules[bunk] = [];
        
        Object.keys(backup[bunk]).forEach(slotIdxStr => {
            const slotIdx = parseInt(slotIdxStr, 10);
            schedules[bunk][slotIdx] = backup[bunk][slotIdx];
            restored++;
        });
    });
    
    window.scheduleAssignments = schedules;
    window.saveCurrentDailyData?.('scheduleAssignments', schedules);
    console.log(`[RainStacker] Restored ${restored} morning schedule entries`);
}

// =========================================================================
// RAIN CLEARS MODAL UI
// =========================================================================

/**
 * Show a modal for when rain clears mid-day.
 * Mirrors the showMidDayRainModal() pattern from daily_adjustments.js
 * but for the reverse direction (rainy → regular).
 */
function showRainClearsModal() {
    // Remove any existing modal
    const existingModal = document.getElementById('rain-clears-modal');
    if (existingModal) existingModal.remove();
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = Math.floor(now.getMinutes() / 5) * 5;
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;
    
    // Get available regular skeletons
    const g = window.loadGlobalSettings?.() || {};
    const savedSkeletons = g.app1?.savedSkeletons || {};
    const rainySkeletonName = g.rainyDaySkeletonName || '';
    const skeletonNames = Object.keys(savedSkeletons)
        .filter(n => n !== rainySkeletonName) // Exclude the rainy skeleton
        .sort();
    
    // Try to find the backed-up regular skeleton name
    const dailyData = window.loadCurrentDailyData?.() || {};
    const backupSkeletonName = dailyData._preRainySkeletonName || '';
    
    const skeletonOptions = skeletonNames.map(n => 
        `<option value="${n}" ${n === backupSkeletonName ? 'selected' : ''}>${n}</option>`
    ).join('');
    
    const modal = document.createElement('div');
    modal.id = 'rain-clears-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    
    modal.innerHTML = `
        <div style="background:white;border-radius:16px;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;">
            <div style="background:linear-gradient(135deg,#fef3c7,#fde68a);padding:20px 24px;border-bottom:1px solid #fcd34d;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <h3 style="margin:0;font-size:1.1rem;color:#92400e;">☀️ Rain Has Cleared</h3>
                    <button id="rain-clears-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#92400e;">×</button>
                </div>
            </div>
            
            <div style="padding:24px;">
                <p style="margin:0 0 16px;color:#64748b;font-size:0.9rem;">
                    This will preserve the rainy day activities that already happened and rebuild 
                    the rest of the day using the regular schedule.
                </p>
                
                <div style="margin-bottom:16px;">
                    <label style="font-weight:600;margin-bottom:6px;display:block;font-size:0.9rem;">When did rain clear?</label>
                    <div style="display:flex;gap:12px;align-items:center;">
                        <input type="time" id="rain-clears-time" value="${currentTimeStr}" 
                               style="flex:1;font-size:16px;padding:10px;border:1px solid #d1d5db;border-radius:8px;">
                        <button id="rain-clears-use-now" 
                                style="white-space:nowrap;padding:10px 16px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;font-size:0.85rem;">
                            Use Now
                        </button>
                    </div>
                </div>
                
                <div style="margin-bottom:16px;">
                    <label style="font-weight:600;margin-bottom:6px;display:block;font-size:0.9rem;">Regular Schedule Template</label>
                    <select id="rain-clears-skeleton" 
                            style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.9rem;">
                        <option value="">Select template...</option>
                        ${skeletonOptions}
                    </select>
                    ${backupSkeletonName ? `<div style="font-size:0.75rem;color:#64748b;margin-top:4px;">Pre-rain template: ${backupSkeletonName}</div>` : ''}
                </div>
                
                <div id="rain-clears-preview" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:16px;">
                    <div style="font-weight:600;margin-bottom:8px;font-size:0.85rem;">Preview:</div>
                    <div id="rain-clears-preview-content" style="font-size:0.85rem;color:#64748b;">Select a template to preview</div>
                </div>
                
                <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:12px;margin-bottom:16px;">
                    <div style="font-weight:600;color:#065f46;margin-bottom:4px;font-size:0.85rem;">☀️ What will happen</div>
                    <div style="font-size:0.8rem;color:#047857;">
                        • Rainy day activities before the clear time are kept<br>
                        • Outdoor fields are re-enabled<br>
                        • Capacity & time overrides are reverted<br>
                        • Remaining time is filled with regular activities
                    </div>
                </div>
            </div>
            
            <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;display:flex;gap:12px;justify-content:flex-end;">
                <button id="rain-clears-cancel" 
                        style="padding:10px 20px;background:white;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;font-size:0.9rem;">
                    Cancel
                </button>
                <button id="rain-clears-confirm" 
                        style="padding:10px 20px;background:#059669;color:white;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;">
                    ☀️ Switch to Regular
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Preview function
    const updatePreview = () => {
        const timeInput = document.getElementById('rain-clears-time');
        const skeletonSelect = document.getElementById('rain-clears-skeleton');
        const previewContent = document.getElementById('rain-clears-preview-content');
        
        if (!timeInput || !skeletonSelect || !previewContent) return;
        
        const skName = skeletonSelect.value;
        if (!skName) {
            previewContent.textContent = 'Select a template to preview';
            return;
        }
        
        const [hours, mins] = timeInput.value.split(':').map(Number);
        const clearMin = hours * 60 + mins;
        
        // Quick analysis — how many rainy slots are preserved vs rebuilt
        const currentSkeleton = dailyData.manualSkeleton || [];
        const divisions = g.app1?.divisions || {};
        const divNames = Object.keys(divisions);
        
        let keptCount = 0;
        let rebuildCount = 0;
        
        divNames.forEach(div => {
            currentSkeleton.filter(b => b.division === div).forEach(b => {
                const endMin = parseTimeToMinutes(b.endTime) ?? b.endMin;
                if (endMin && endMin <= clearMin) keptCount++;
                else rebuildCount++;
            });
        });
        
        previewContent.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:center;">
                <div style="background:#d1fae5;padding:8px;border-radius:6px;">
                    <div style="font-size:18px;font-weight:700;color:#065f46;">${keptCount}</div>
                    <div style="font-size:11px;color:#047857;">✅ Keep (rainy)</div>
                </div>
                <div style="background:#dbeafe;padding:8px;border-radius:6px;">
                    <div style="font-size:18px;font-weight:700;color:#1e40af;">${rebuildCount}</div>
                    <div style="font-size:11px;color:#2563eb;">🔄 Rebuild (regular)</div>
                </div>
            </div>
            <div style="margin-top:8px;font-size:0.8rem;color:#64748b;">
                Using template: <strong>${skName}</strong> from ${minutesToTime(clearMin)} onward
            </div>
        `;
    };
    
    // Event handlers
    document.getElementById('rain-clears-time').addEventListener('change', updatePreview);
    document.getElementById('rain-clears-time').addEventListener('input', updatePreview);
    document.getElementById('rain-clears-skeleton').addEventListener('change', updatePreview);
    
    document.getElementById('rain-clears-use-now').onclick = () => {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, '0');
        document.getElementById('rain-clears-time').value = `${h}:${m}`;
        updatePreview();
    };
    
    document.getElementById('rain-clears-close').onclick = () => modal.remove();
    document.getElementById('rain-clears-cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    document.getElementById('rain-clears-confirm').onclick = () => {
        const timeInput = document.getElementById('rain-clears-time');
        const skeletonSelect = document.getElementById('rain-clears-skeleton');
        
        const skName = skeletonSelect.value;
        if (!skName) {
            alert('Please select a regular schedule template.');
            return;
        }
        
        const [hours, mins] = timeInput.value.split(':').map(Number);
        const clearMin = hours * 60 + mins;
        
        modal.remove();
        
        // Execute the rain clears flow
        executeRainClears(clearMin, skName);
    };
    
    // Initial preview
    updatePreview();
}

/**
 * Execute the full rain-clears flow.
 */
function executeRainClears(clearTimeMin, regularSkeletonName) {
    console.log(`[RainStacker] ☀️ Executing rain clears at ${minutesToTime(clearTimeMin)}`);
    
    // 1. Run the full rain-clear flow (backup + rebuild + regen)
    const resourceOverrides = buildRainyDayResourceOverrides();
    
    const result = handleMidDayRainClear(clearTimeMin, regularSkeletonName, resourceOverrides);
    
    if (!result.success) {
        console.error('[RainStacker] Failed to rebuild:', result.error);
        alert('Failed to rebuild schedule: ' + (result.error || 'Unknown error'));
        return;
    }
    
    // 2. Clear rainy day state
    window.isRainyDay = false;
    window.rainyDayStartTime = null;
    
    window.saveCurrentDailyData?.('rainyDayMode', false);
    window.saveCurrentDailyData?.('rainyDayStartTime', null);
    window.saveCurrentDailyData?.('isRainyDay', false);
    
    // 3. Re-enable outdoor fields
    const dailyData = window.loadCurrentDailyData?.() || {};
    const preRainyDisabled = dailyData.preRainyDayDisabledFields || [];
    const overrides = dailyData.overrides || {};
    overrides.disabledFields = preRainyDisabled;
    window.saveCurrentDailyData?.('overrides', overrides);
    window.saveCurrentDailyData?.('preRainyDayDisabledFields', null);
    window.saveCurrentDailyData?.('_preRainySkeletonName', null);
    
    // 4. Show notification
    if (typeof window.showRainyDayNotification === 'function') {
        window.showRainyDayNotification(false, 0, false, false);
    }
    
    // 5. Re-render UI
    if (typeof window.renderRainyDayPanel === 'function') window.renderRainyDayPanel();
    if (typeof window.renderResourceOverridesUI === 'function') window.renderResourceOverridesUI();
    
    window.forceSyncToCloud?.();
    
    console.log('[RainStacker] ☀️ Rain clears complete');
}

// =========================================================================
// EXPORTS
// =========================================================================

window.MidDayRainStacker = {
    // Main entry points
    handleMidDayRainStart,
    handleMidDayRainClear,
    rebuildFromTransition,
    
    // v2.0: Morning preservation
    prePlaceMorningAssignments,
    
    // Post-rebuild
    triggerPostRebuildGeneration,
    triggerMidDayGeneration,
    restorePreservedMorningSchedule, // Deprecated — kept as fallback
    
    // Rain clears UI
    showRainClearsModal,
    executeRainClears,
    
    // Core algorithm
    stackSchedule,
    parseSkeletonForDivision,
    expandPrepBlocks,
    
    // Helpers
    calculateEffectiveStart,
    applyResourceOverrides,
    buildRainyDayResourceOverrides,
    getFlexRange,
    
    // Constants (exposed for configuration)
    FLEX_PERCENT,
    SNAP_THRESHOLD_MIN,
    ROUND_TO_MIN
};

console.log('🌧️ Mid-Day Rain Stacker v2.0 loaded ✅');
console.log('   Usage: window.MidDayRainStacker.handleMidDayRainStart(rainMinutes)');
console.log('   Usage: window.MidDayRainStacker.handleMidDayRainClear(clearMinutes, skeletonName)');
console.log('   v2.0: Morning schedule preserved via _pinned + PinnedPreservation system');

})();
