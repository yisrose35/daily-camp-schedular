// ============================================================================
// midday_rain_stacker.js — Mid-Day Rain Schedule Stacking Engine (v2.0)
// ============================================================================
// 
// PURPOSE: When rain starts mid-day (or clears mid-day), this engine rebuilds
// the rest of the day's schedule by "calling an audible" — stacking activities
// sequentially from the transition point to the dismissal wall.
//
// v2.0 CHANGES:
//   - Morning/pre-transition schedule is NEVER erased
//   - Uses prePlaceMorningAssignments() to map old assignments to new slots by TIME
//   - Marks preserved entries as _pinned so PinnedPreservation system protects them
//   - Eliminates the fragile backup-wipe-restore pattern
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
const FLEX_PERCENT = 0.25;
const SNAP_THRESHOLD_MIN = 10;
const ROUND_TO_MIN = 5;
const MIN_USEFUL_GAP = 10;
const FIXED_BLOCK_EVENTS = ['lunch', 'snack', 'snacks'];
const WALL_BLOCK_EVENTS = ['dismissal'];
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
    if (!mer && hh >= 0 && hh <= 23) {
        return hh * 60 + mm;
    }
    if (!mer) return null;
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
    if (['slot', 'activity', 'sports', 'special', 'smart'].includes(type)) return true;
    if (['league', 'specialty_league'].includes(type)) return true;
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
function parseSkeletonForDivision(skeleton, divisionName) {
    if (!skeleton || !Array.isArray(skeleton)) {
        console.warn('[RainStacker] No skeleton provided');
        return { activityQueue: [], fixedBlocks: [], wallTime: null, allBlocks: [] };
    }
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
            wallTime = block.startMin;
            fixedBlocks.push({ ...block, _role: 'wall' });
        } else if (isFixedBlock(block.event)) {
            fixedBlocks.push({ ...block, _role: 'fixed', duration: block.duration });
        } else if (isSchedulableBlock(block)) {
            activityQueue.push({ ...block, _role: 'activity', duration: block.duration, flex: getFlexRange(block.duration) });
        } else {
            fixedBlocks.push({ ...block, _role: 'fixed', duration: block.duration });
        }
    });
    return { activityQueue, fixedBlocks, wallTime, allBlocks: divBlocks };
}
// =========================================================================
// SNAP LOGIC
// =========================================================================
function calculateEffectiveStart(rainStartMin, allBlocks) {
    let effectiveStart = roundToNearest(rainStartMin, ROUND_TO_MIN);
    for (const block of allBlocks) {
        const boundary = block.startMin;
        if (boundary > effectiveStart) {
            const gap = boundary - effectiveStart;
            if (gap <= SNAP_THRESHOLD_MIN) {
                console.log(`[RainStacker] Snapping from ${minutesToTime(effectiveStart)} to skeleton boundary at ${minutesToTime(boundary)} (${gap}min gap)`);
                return boundary;
            }
            break;
        }
    }
    return effectiveStart;
}
// =========================================================================
// CORE STACKING ALGORITHM
// =========================================================================
function stackSchedule({ startTime, wallTime, activityQueue, fixedBlocks, divisionName }) {
    console.log(`[RainStacker] === Stacking for ${divisionName} ===`);
    console.log(`[RainStacker] Start: ${minutesToTime(startTime)}, Wall: ${minutesToTime(wallTime)}`);
    console.log(`[RainStacker] Activities: ${activityQueue.length}, Fixed: ${fixedBlocks.length}`);
    if (!wallTime || startTime >= wallTime) {
        console.warn('[RainStacker] No time available to stack');
        return [];
    }
    const totalAvailable = wallTime - startTime;
    const expandedQueue = expandPrepBlocks(activityQueue);
    const relevantFixed = fixedBlocks.filter(fb => {
        if (fb._role === 'wall') return false;
        return fb.startMin >= startTime || fb.endMin > startTime;
    });
    const buildQueue = () => {
        const relevantActivities = expandedQueue.filter(a => a.endMin > startTime);
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
    // PHASE 2: Initial placement
    let cursor = startTime;
    const placed = [];
    const dropped = [];
    for (const item of orderedQueue) {
        const remainingTime = wallTime - cursor;
        if (remainingTime <= 0) { dropped.push(item); continue; }
        const duration = item.duration;
        const flex = item._queueType === 'activity' ? getFlexRange(duration) : { min: duration, max: duration, ideal: duration };
        if (remainingTime < flex.min) {
            console.log(`[RainStacker] Dropping ${item.event}: needs ${flex.min}min, only ${remainingTime}min left`);
            dropped.push(item); continue;
        }
        const actualDuration = Math.min(flex.ideal, remainingTime);
        placed.push({ ...item, _placedStart: cursor, _placedEnd: cursor + actualDuration, _placedDuration: actualDuration, _flex: flex });
        cursor += actualDuration;
    }
    console.log(`[RainStacker] After initial placement: ${placed.length} placed, ${dropped.length} dropped, cursor at ${minutesToTime(cursor)}`);
    // PHASE 3: Handle gap
    const gap = wallTime - cursor;
    if (gap > 0 && gap <= MIN_USEFUL_GAP) {
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
        console.log(`[RainStacker] ${gap}min gap remaining — distributing across activities`);
        distributeExtraTime(placed, gap);
    }
    // PHASE 4: Check squeezed activities
    for (let i = placed.length - 1; i >= 0; i--) {
        const item = placed[i];
        if (item._queueType === 'activity' && item._placedDuration < item._flex.min) {
            const needed = item._flex.min - item._placedDuration;
            const recovered = compressEarlierActivities(placed, i, needed);
            if (recovered >= needed) {
                recalculatePositions(placed, startTime);
            } else {
                const removedItem = placed.splice(i, 1)[0];
                dropped.push(removedItem);
                recalculatePositions(placed, startTime);
                const newGap = wallTime - (placed.length > 0 ? placed[placed.length - 1]._placedEnd : startTime);
                if (newGap > 0) distributeExtraTime(placed, newGap);
            }
        }
    }
    // PHASE 4.5: Validate prep/main coupling
    let couplingChanged = true;
    while (couplingChanged) {
        couplingChanged = false;
        for (let i = placed.length - 1; i >= 0; i--) {
            const item = placed[i];
            if (item._isPrepBlock) {
                const mainExists = placed.some(p => p._isMainBlock && p._mainActivity === item._mainActivity);
                if (!mainExists) { placed.splice(i, 1); dropped.push(item); couplingChanged = true; }
            }
            if (item._isMainBlock && item._hasPrep) {
                const prepExists = placed.some(p => p._isPrepBlock && p._mainActivity === item.event);
                if (!prepExists) item._hasPrep = false;
            }
        }
    }
    if (placed.length > 0) {
        recalculatePositions(placed, startTime);
        const couplingGap = wallTime - placed[placed.length - 1]._placedEnd;
        if (couplingGap > 0) distributeExtraTime(placed, couplingGap);
    }
    // PHASE 5: Final gap
    const finalEnd = placed.length > 0 ? placed[placed.length - 1]._placedEnd : startTime;
    const finalGap = wallTime - finalEnd;
    if (finalGap > 0) distributeExtraTime(placed, finalGap);
    // PHASE 6: Build output
    const referenceDate = new Date();
    const outputBlocks = [];
    placed.forEach((item, idx) => {
        outputBlocks.push({
            id: uid(), _originalId: item._originalId || item.id,
            type: item._queueType === 'fixed' ? 'pinned' : item.type || 'special',
            event: item.event, division: divisionName,
            startTime: minutesToTime(item._placedStart), endTime: minutesToTime(item._placedEnd),
            startMin: item._placedStart, endMin: item._placedEnd,
            duration: item._placedDuration,
            start: minutesToISO(item._placedStart, referenceDate), end: minutesToISO(item._placedEnd, referenceDate),
            label: `${minutesToTime(item._placedStart)} - ${minutesToTime(item._placedEnd)}`,
            slotIndex: idx, _midDayRebuilt: true,
            _originalDuration: item.duration, _flexApplied: item._placedDuration !== item.duration
        });
    });
    const wallBlock = fixedBlocks.find(fb => fb._role === 'wall');
    if (wallBlock) {
        const wallEnd = wallBlock.endMin || (wallTime + (wallBlock.duration || 20));
        outputBlocks.push({
            id: uid(), _originalId: wallBlock._originalId || wallBlock.id,
            type: 'pinned', event: wallBlock.event || 'Dismissal', division: divisionName,
            startTime: minutesToTime(wallTime), endTime: minutesToTime(wallEnd),
            startMin: wallTime, endMin: wallEnd, duration: wallEnd - wallTime,
            start: minutesToISO(wallTime, referenceDate), end: minutesToISO(wallEnd, referenceDate),
            label: `${minutesToTime(wallTime)} - ${minutesToTime(wallEnd)}`,
            slotIndex: outputBlocks.length, _midDayRebuilt: true
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
function compressEarlierActivities(placed, targetIdx, needed) {
    let recovered = 0;
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
function distributeExtraTime(placed, extraMinutes) {
    if (extraMinutes <= 0) return;
    const stretchable = placed.filter(p => p._queueType === 'activity' && p._placedDuration < p._flex.max);
    if (stretchable.length === 0) {
        for (let i = placed.length - 1; i >= 0; i--) {
            if (placed[i]._queueType === 'activity') {
                placed[i]._placedDuration += extraMinutes;
                placed[i]._placedEnd += extraMinutes;
                break;
            }
        }
        if (placed.length > 0) {
            let cursor = placed[0]._placedStart;
            for (const item of placed) { item._placedStart = cursor; item._placedEnd = cursor + item._placedDuration; cursor = item._placedEnd; }
        }
        return;
    }
    let remaining = extraMinutes;
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
        if (distributed === 0) break;
    }
    if (placed.length > 0) {
        let cursor = placed[0]._placedStart;
        for (const item of placed) { item._placedStart = cursor; item._placedEnd = cursor + item._placedDuration; cursor = item._placedEnd; }
    }
    if (remaining > 0) {
        for (let i = placed.length - 1; i >= 0; i--) {
            if (placed[i]._queueType === 'activity') {
                placed[i]._placedDuration += remaining;
                placed[i]._placedEnd += remaining;
                let cursor = placed[i]._placedEnd;
                for (let j = i + 1; j < placed.length; j++) {
                    placed[j]._placedStart = cursor; placed[j]._placedEnd = cursor + placed[j]._placedDuration; cursor = placed[j]._placedEnd;
                }
                break;
            }
        }
    }
}
function recalculatePositions(placed, startTime) {
    let cursor = startTime;
    for (const item of placed) { item._placedStart = cursor; item._placedEnd = cursor + item._placedDuration; cursor = item._placedEnd; }
}
// =========================================================================
// MAIN ENTRY POINT: REBUILD SCHEDULE FROM MID-DAY TRANSITION
// =========================================================================
function rebuildFromTransition({ transitionTime, targetSkeletonName, isRainStarting, resourceOverrides }) {
    console.log(`\n[RainStacker] ========================================`);
    console.log(`[RainStacker] REBUILD FROM TRANSITION`);
    console.log(`[RainStacker] Time: ${minutesToTime(transitionTime)}`);
    console.log(`[RainStacker] Target skeleton: ${targetSkeletonName}`);
    console.log(`[RainStacker] Direction: ${isRainStarting ? 'Regular → Rainy' : 'Rainy → Regular'}`);
    console.log(`[RainStacker] ========================================\n`);
    const g = window.loadGlobalSettings?.() || {};
    const savedSkeletons = g.app1?.savedSkeletons || {};
    const targetSkeleton = savedSkeletons[targetSkeletonName];
    if (!targetSkeleton || targetSkeleton.length === 0) {
        console.error(`[RainStacker] Target skeleton "${targetSkeletonName}" not found or empty`);
        return { success: false, error: 'Skeleton not found' };
    }
    const dailyData = window.loadCurrentDailyData?.() || {};
    const currentSkeleton = dailyData.manualSkeleton || [];
    const divisions = g.app1?.divisions || {};
    const divisionNames = Object.keys(divisions);
    if (divisionNames.length === 0) {
        console.error('[RainStacker] No divisions configured');
        return { success: false, error: 'No divisions' };
    }
    const effectiveTransition = roundToNearest(transitionTime, ROUND_TO_MIN);
    const rebuiltSkeleton = [];
    const summary = { transitionTime: minutesToTime(effectiveTransition), divisions: {}, direction: isRainStarting ? 'rain_starting' : 'rain_clearing' };
    for (const divName of divisionNames) {
        console.log(`\n[RainStacker] --- Processing division: ${divName} ---`);
        const currentDivBlocks = currentSkeleton
            .filter(b => (b.division === divName || b.division === String(divName)))
            .map(b => ({ ...b, startMin: parseTimeToMinutes(b.startTime) ?? b.startMin, endMin: parseTimeToMinutes(b.endTime) ?? b.endMin }))
            .filter(b => b.startMin != null && b.endMin != null)
            .sort((a, b) => a.startMin - b.startMin);
        const preservedBlocks = [];
        for (const block of currentDivBlocks) {
            if (block.endMin <= effectiveTransition) {
                preservedBlocks.push(block);
            } else if (block.startMin < effectiveTransition && block.endMin > effectiveTransition) {
                const truncated = {
                    ...block, endTime: minutesToTime(effectiveTransition), endMin: effectiveTransition,
                    duration: effectiveTransition - block.startMin, end: minutesToISO(effectiveTransition, new Date()),
                    label: `${block.startTime || minutesToTime(block.startMin)} - ${minutesToTime(effectiveTransition)}`,
                    _truncatedAtTransition: true, _originalEndMin: block.endMin
                };
                preservedBlocks.push(truncated);
                console.log(`[RainStacker] Truncated in-progress block "${block.event}" at ${minutesToTime(effectiveTransition)}`);
            }
        }
        const refDate = new Date();
        preservedBlocks.forEach(b => {
            if (!b.start) b.start = minutesToISO(b.startMin, refDate);
            if (!b.end) b.end = minutesToISO(b.endMin, refDate);
            if (!b.label) b.label = `${b.startTime || minutesToTime(b.startMin)} - ${b.endTime || minutesToTime(b.endMin)}`;
        });
        console.log(`[RainStacker] Preserving ${preservedBlocks.length} blocks before ${minutesToTime(effectiveTransition)}`);
        const { activityQueue, fixedBlocks, wallTime, allBlocks } = parseSkeletonForDivision(targetSkeleton, divName);
        if (!wallTime) {
            console.warn(`[RainStacker] No dismissal found for ${divName} in target skeleton`);
            const currentWall = currentDivBlocks.find(b => isWallBlock(b.event));
            if (!currentWall) { console.error(`[RainStacker] No dismissal at all for ${divName}, skipping`); continue; }
        }
        const effectiveWall = wallTime || currentDivBlocks.find(b => isWallBlock(b.event))?.startMin;
        if (!effectiveWall || effectiveTransition >= effectiveWall) {
            console.warn(`[RainStacker] Transition at or past dismissal for ${divName}, skipping`);
            rebuiltSkeleton.push(...currentDivBlocks); continue;
        }
        const effectiveStart = calculateEffectiveStart(effectiveTransition, allBlocks);
        if (effectiveStart > effectiveTransition) {
            preservedBlocks.push({
                id: uid(), type: 'pinned', event: 'Transition', division: divName,
                startTime: minutesToTime(effectiveTransition), endTime: minutesToTime(effectiveStart),
                startMin: effectiveTransition, endMin: effectiveStart,
                duration: effectiveStart - effectiveTransition,
                label: `${minutesToTime(effectiveTransition)} - ${minutesToTime(effectiveStart)}`,
                _midDayRebuilt: true
            });
        }
        const stackedBlocks = stackSchedule({ startTime: effectiveStart, wallTime: effectiveWall, activityQueue, fixedBlocks, divisionName: divName });
        const divisionResult = [...preservedBlocks, ...stackedBlocks];
        divisionResult.forEach((block, idx) => { block.slotIndex = idx; });
        rebuiltSkeleton.push(...divisionResult);
        summary.divisions[divName] = {
            preserved: preservedBlocks.length, stacked: stackedBlocks.length,
            dropped: activityQueue.length - stackedBlocks.filter(b => b.type !== 'pinned').length,
            effectiveStart: minutesToTime(effectiveStart), wallTime: minutesToTime(effectiveWall)
        };
    }
    if (resourceOverrides) applyResourceOverrides(resourceOverrides, isRainStarting);
    window.saveCurrentDailyData?.('manualSkeleton', rebuiltSkeleton);
    window.dailyOverrideSkeleton = rebuiltSkeleton;
    console.log(`\n[RainStacker] REBUILD COMPLETE — Total blocks: ${rebuiltSkeleton.length}`);
    console.log(`[RainStacker] Summary:`, JSON.stringify(summary, null, 2));
    return { success: true, rebuiltSkeleton, summary };
}
// =========================================================================
// RESOURCE OVERRIDES
// =========================================================================
function buildRainyDayResourceOverrides() {
    if (typeof window.buildRainyDayResourceOverrides === 'function') return window.buildRainyDayResourceOverrides();
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    const overrides = { capacityOverrides: {}, availabilityOverrides: [] };
    fields.forEach(f => {
        if (f.rainyDayCapacity != null && f.rainyDayCapacity > 0) overrides.capacityOverrides[f.name] = f.rainyDayCapacity;
        if (f.rainyDayAvailableAllDay === true && f.timeRules && f.timeRules.length > 0) overrides.availabilityOverrides.push(f.name);
    });
    return overrides;
}
if (typeof window.buildRainyDayResourceOverrides !== 'function') window.buildRainyDayResourceOverrides = buildRainyDayResourceOverrides;
function applyResourceOverrides(overrides, isRainStarting) {
    if (!overrides) return;
    const g = window.loadGlobalSettings?.() || {};
    const fields = g.app1?.fields || [];
    let changed = false;
    if (isRainStarting) {
        if (overrides.capacityOverrides) {
            for (const [fieldName, newCapacity] of Object.entries(overrides.capacityOverrides)) {
                const field = fields.find(f => f.name === fieldName);
                if (field) {
                    if (!field._preRainyCapacity) field._preRainyCapacity = field.sharableWith?.capacity || 1;
                    if (field.sharableWith) { field.sharableWith.capacity = newCapacity; changed = true; }
                }
            }
        }
        if (overrides.availabilityOverrides) {
            for (const fieldName of overrides.availabilityOverrides) {
                const field = fields.find(f => f.name === fieldName);
                if (field) {
                    if (!field._preRainyTimeRules) field._preRainyTimeRules = JSON.parse(JSON.stringify(field.timeRules || []));
                    field.timeRules = []; changed = true;
                }
            }
        }
    } else {
        for (const field of fields) {
            if (field._preRainyCapacity != null) {
                if (field.sharableWith) field.sharableWith.capacity = field._preRainyCapacity;
                delete field._preRainyCapacity; changed = true;
            }
            if (field._preRainyTimeRules) {
                field.timeRules = field._preRainyTimeRules;
                delete field._preRainyTimeRules; changed = true;
            }
        }
    }
    if (changed) { window.saveGlobalSettings?.('app1', g.app1); window.forceSyncToCloud?.(); }
}
// =========================================================================
// CONVENIENCE WRAPPERS (v2.0 — morning preserved via _pinned)
// =========================================================================

/**
 * Helper: extract endMin from a unifiedTimes slot entry
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
 */
function handleMidDayRainStart(rainStartMinutes, resourceOverrides) {
    const rainySkeletonName = window.getRainyDaySkeletonName?.() || (window.loadGlobalSettings?.() || {}).rainyDaySkeletonName;
    if (!rainySkeletonName) {
        console.error('[RainStacker] No rainy day skeleton configured');
        return { success: false, error: 'No rainy day skeleton configured. Please set one in Rainy Day settings.' };
    }
    // Store regular skeleton name for later restoration
    const g = window.loadGlobalSettings?.() || {};
    const dateKey = window.currentScheduleDate;
    const skAssignments = g.app1?.skeletonAssignments || {};
    if (dateKey) {
        const [Y, M, D] = dateKey.split('-').map(Number);
        let dow = 0;
        if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const regularName = skAssignments[dayNames[dow]] || skAssignments['Default'] || '';
        window.saveCurrentDailyData?.('_preRainySkeletonName', regularName);
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
                if (endMin !== undefined && endMin <= rainStartMinutes) preservedCount++;
            }
        });
    });
    console.log(`[RainStacker] Pre-rebuild snapshot: ${Object.keys(preRebuildAssignments).length} bunks, ${preservedCount} morning slots to preserve`);
    window._midDayPreRebuild = { assignments: preRebuildAssignments, times: preRebuildTimes, transitionMinutes: rainStartMinutes };

    const result = rebuildFromTransition({ transitionTime: rainStartMinutes, targetSkeletonName: rainySkeletonName, isRainStarting: true, resourceOverrides });

    // ★★★ v2.0: Pre-populate morning schedule as _pinned, then regenerate afternoon only ★★★
    if (result.success) {
        prePlaceMorningAssignments(rainStartMinutes);
        triggerPostRebuildGeneration(preservedCount);
    }
    return result;
}

/**
 * Handle mid-day rain clear.
 */
function handleMidDayRainClear(clearTimeMinutes, regularSkeletonName, resourceOverrides) {
    if (!regularSkeletonName) {
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
    window._midDayPreRebuild = { assignments: preRebuildAssignments, times: preRebuildTimes, transitionMinutes: clearTimeMinutes };

    const result = rebuildFromTransition({ transitionTime: clearTimeMinutes, targetSkeletonName: regularSkeletonName, isRainStarting: false, resourceOverrides });

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
function expandPrepBlocks(activityQueue) {
    const expanded = [];
    for (const item of activityQueue) {
        const activityName = item.event || '';
        const specialConfig = window.getSpecialActivityByName?.(activityName);
        const prepDuration = specialConfig?.prepDuration || 0;
        if (prepDuration > 0) {
            expanded.push({ ...item, event: `${activityName} (Prep)`, duration: prepDuration, flex: getFlexRange(prepDuration), _isPrepBlock: true, _mainActivity: activityName, _queueType: 'activity' });
            expanded.push({ ...item, event: activityName, duration: item.duration, flex: getFlexRange(item.duration), _isMainBlock: true, _hasPrep: true, _queueType: 'activity' });
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
 * After rebuildFromTransition, the skeleton has changed (morning blocks kept,
 * afternoon rebuilt). The slot indices may have shifted. This function:
 * 1. Takes the pre-rebuild assignments and their old time info
 * 2. Maps each morning assignment to the correct NEW slot index by matching times
 * 3. Places them with _pinned: true so PinnedPreservation protects them during generation
 * 
 * This ensures the morning schedule persists EXACTLY as it was — the optimizer
 * only generates fresh assignments for post-transition slots.
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
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    let placedCount = 0;
    let skippedCount = 0;
    console.log(`[RainStacker] ★ Pre-placing morning assignments (before ${minutesToTime(transitionMinutes)})...`);

    Object.keys(oldAssignments).forEach(bunk => {
        const oldBunkSlots = oldAssignments[bunk] || [];
        if (!oldBunkSlots || !Array.isArray(oldBunkSlots)) return;
        const divName = Object.keys(divisions).find(d => divisions[d].bunks?.includes(bunk));
        if (!divName) return;
        const newSlots = newDivisionTimes[divName] || newDivisionTimes[String(divName)] || [];
        if (newSlots.length === 0) return;
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(newSlots.length).fill(null);

        // Build time→index map for new slots
        const newTimeMap = new Map();
        newSlots.forEach((slot, idx) => {
            if (slot.startMin !== undefined && slot.endMin !== undefined) {
                newTimeMap.set(`${slot.startMin}-${slot.endMin}`, idx);
            }
        });
        const processedContinuations = new Set();

        oldBunkSlots.forEach((entry, oldIdx) => {
            if (!entry) return;
            if (processedContinuations.has(oldIdx)) return;
            if (entry.continuation) return;
            const oldSlot = oldTimes[oldIdx];
            if (!oldSlot) return;
            let oldStartMin, oldEndMin;
            if (oldSlot.startMin !== undefined) { oldStartMin = oldSlot.startMin; oldEndMin = oldSlot.endMin; }
            else if (oldSlot.start) {
                const sd = new Date(oldSlot.start); const ed = new Date(oldSlot.end);
                oldStartMin = sd.getHours() * 60 + sd.getMinutes(); oldEndMin = ed.getHours() * 60 + ed.getMinutes();
            } else return;

            // Only preserve slots that ENDED before the transition
            if (oldEndMin > transitionMinutes) { skippedCount++; return; }

            // Find matching new slot by time
            const timeKey = `${oldStartMin}-${oldEndMin}`;
            let newIdx = newTimeMap.get(timeKey);
            // Fallback: exact match scan
            if (newIdx === undefined) {
                for (let i = 0; i < newSlots.length; i++) {
                    if (newSlots[i].startMin === oldStartMin && newSlots[i].endMin === oldEndMin) { newIdx = i; break; }
                }
            }
            // Second fallback: closest within tolerance
            if (newIdx === undefined) {
                let bestMatch = -1, bestDiff = Infinity;
                for (let i = 0; i < newSlots.length; i++) {
                    const diff = Math.abs(newSlots[i].startMin - oldStartMin) + Math.abs(newSlots[i].endMin - oldEndMin);
                    if (diff < bestDiff) { bestDiff = diff; bestMatch = i; }
                }
                if (bestMatch >= 0 && bestDiff <= 10) newIdx = bestMatch;
            }
            if (newIdx === undefined || newIdx < 0) {
                console.warn(`[RainStacker] Could not map morning slot for ${bunk} (${oldStartMin}-${oldEndMin})`);
                skippedCount++; return;
            }

            // Place with _pinned so PinnedPreservation protects it
            window.scheduleAssignments[bunk][newIdx] = { ...entry, _pinned: true, _preservedMorning: true, _midDayPreserved: true };
            placedCount++;

            // Handle continuation entries for multi-slot activities
            if (entry._activity) {
                for (let nextOld = oldIdx + 1; nextOld < oldBunkSlots.length; nextOld++) {
                    const nextEntry = oldBunkSlots[nextOld];
                    if (!nextEntry || !nextEntry.continuation) break;
                    if (nextEntry._activity !== entry._activity) break;
                    processedContinuations.add(nextOld);
                    const nextOldSlot = oldTimes[nextOld];
                    if (!nextOldSlot) break;
                    let nStartMin, nEndMin;
                    if (nextOldSlot.startMin !== undefined) { nStartMin = nextOldSlot.startMin; nEndMin = nextOldSlot.endMin; }
                    else if (nextOldSlot.start) {
                        const sd2 = new Date(nextOldSlot.start); const ed2 = new Date(nextOldSlot.end);
                        nStartMin = sd2.getHours() * 60 + sd2.getMinutes(); nEndMin = ed2.getHours() * 60 + ed2.getMinutes();
                    } else break;
                    if (nEndMin > transitionMinutes) break;
                    const nTimeKey = `${nStartMin}-${nEndMin}`;
                    let nNewIdx = newTimeMap.get(nTimeKey);
                    if (nNewIdx === undefined) {
                        for (let i = 0; i < newSlots.length; i++) {
                            if (newSlots[i].startMin === nStartMin && newSlots[i].endMin === nEndMin) { nNewIdx = i; break; }
                        }
                    }
                    if (nNewIdx !== undefined && nNewIdx >= 0) {
                        window.scheduleAssignments[bunk][nNewIdx] = { ...nextEntry, _pinned: true, _preservedMorning: true, _midDayPreserved: true };
                        placedCount++;
                    }
                }
            }
        });
    });
    console.log(`[RainStacker] ★ Pre-placed ${placedCount} morning entries as _pinned (${skippedCount} post-transition skipped)`);
    window.saveCurrentDailyData?.('scheduleAssignments', window.scheduleAssignments);
}
// =========================================================================
// AUTO-REGENERATION (v2.0 — relies on PinnedPreservation)
// =========================================================================
/**
 * After the stacker rebuilds the skeleton, trigger the scheduler to
 * assign actual activities to the new time blocks.
 * 
 * v2.0: Morning entries are already placed as _pinned by prePlaceMorningAssignments().
 * The PinnedPreservation system captures them before generation and restores
 * them after, so the optimizer only effectively fills post-transition slots.
 */
function triggerPostRebuildGeneration(preservedSlotCount) {
    console.log('[RainStacker] Triggering post-rebuild generation...');
    console.log(`[RainStacker] ${preservedSlotCount} pre-transition slots already placed as _pinned`);
    setTimeout(() => {
        try {
            if (typeof window.runSkeletonOptimizer === 'function') {
                const dailyData = window.loadCurrentDailyData?.() || {};
                const skeleton = dailyData.manualSkeleton || [];
                if (skeleton.length > 0) {
                    console.log(`[RainStacker] Running optimizer with ${skeleton.length} skeleton blocks`);
                    console.log(`[RainStacker] ★ Morning/pre-transition entries are marked _pinned — PinnedPreservation will protect them`);
                    // Dispatch — PinnedPreservation captures all _pinned entries
                    window.dispatchEvent(new CustomEvent('campistry-generation-starting', { detail: { source: 'midday-rain-stacker' } }));
                    // Run optimizer — morning slots protected by PinnedPreservation, afternoon gets fresh assignments
                    window.runSkeletonOptimizer(skeleton);
                    // PinnedPreservation restores morning entries
                    window.dispatchEvent(new CustomEvent('campistry-generation-complete', { detail: { source: 'midday-rain-stacker' } }));
                    // Clean up
                    delete window._midDayPreRebuild;
                    console.log('[RainStacker] ✅ Post-rebuild generation complete (morning preserved via PinnedPreservation)');
                } else {
                    console.warn('[RainStacker] No skeleton available for generation');
                }
            } else {
                console.warn('[RainStacker] runSkeletonOptimizer not available — manual generation required');
            }
        } catch (e) {
            console.error('[RainStacker] Post-rebuild generation failed:', e);
        }
        window.updateTable?.();
        if (typeof window.renderGrid === 'function') window.renderGrid();
    }, 300);
}

/**
 * [DEPRECATED v2.0] Manual fallback to restore morning schedule.
 * The main flow now uses prePlaceMorningAssignments() + PinnedPreservation.
 * Kept only as a manual safety net.
 */
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
function showRainClearsModal() {
    const existingModal = document.getElementById('rain-clears-modal');
    if (existingModal) existingModal.remove();
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = Math.floor(now.getMinutes() / 5) * 5;
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;
    const g = window.loadGlobalSettings?.() || {};
    const savedSkeletons = g.app1?.savedSkeletons || {};
    const rainySkeletonName = g.rainyDaySkeletonName || '';
    const skeletonNames = Object.keys(savedSkeletons).filter(n => n !== rainySkeletonName).sort();
    const dailyData = window.loadCurrentDailyData?.() || {};
    const backupSkeletonName = dailyData._preRainySkeletonName || '';
    const skeletonOptions = skeletonNames.map(n => `<option value="${n}" ${n === backupSkeletonName ? 'selected' : ''}>${n}</option>`).join('');
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
                    This will preserve the rainy day activities that already happened and rebuild the rest of the day using the regular schedule.
                </p>
                <div style="margin-bottom:16px;">
                    <label style="font-weight:600;margin-bottom:6px;display:block;font-size:0.9rem;">When did rain clear?</label>
                    <div style="display:flex;gap:12px;align-items:center;">
                        <input type="time" id="rain-clears-time" value="${currentTimeStr}" style="flex:1;font-size:16px;padding:10px;border:1px solid #d1d5db;border-radius:8px;">
                        <button id="rain-clears-use-now" style="white-space:nowrap;padding:10px 16px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;font-size:0.85rem;">Use Now</button>
                    </div>
                </div>
                <div style="margin-bottom:16px;">
                    <label style="font-weight:600;margin-bottom:6px;display:block;font-size:0.9rem;">Regular Schedule Template</label>
                    <select id="rain-clears-skeleton" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.9rem;">
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
                <button id="rain-clears-cancel" style="padding:10px 20px;background:white;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;font-size:0.9rem;">Cancel</button>
                <button id="rain-clears-confirm" style="padding:10px 20px;background:#059669;color:white;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;">☀️ Switch to Regular</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    const updatePreview = () => {
        const timeInput = document.getElementById('rain-clears-time');
        const skeletonSelect = document.getElementById('rain-clears-skeleton');
        const previewContent = document.getElementById('rain-clears-preview-content');
        if (!timeInput || !skeletonSelect || !previewContent) return;
        const skName = skeletonSelect.value;
        if (!skName) { previewContent.textContent = 'Select a template to preview'; return; }
        const [hours, mins] = timeInput.value.split(':').map(Number);
        const clearMin = hours * 60 + mins;
        const currentSkeleton = dailyData.manualSkeleton || [];
        const divisions = g.app1?.divisions || {};
        const divNames = Object.keys(divisions);
        let keptCount = 0, rebuildCount = 0;
        divNames.forEach(div => {
            currentSkeleton.filter(b => b.division === div).forEach(b => {
                const endMin = parseTimeToMinutes(b.endTime) ?? b.endMin;
                if (endMin && endMin <= clearMin) keptCount++; else rebuildCount++;
            });
        });
        previewContent.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:center;">
                <div style="background:#d1fae5;padding:8px;border-radius:6px;"><div style="font-size:18px;font-weight:700;color:#065f46;">${keptCount}</div><div style="font-size:11px;color:#047857;">✅ Keep (rainy)</div></div>
                <div style="background:#dbeafe;padding:8px;border-radius:6px;"><div style="font-size:18px;font-weight:700;color:#1e40af;">${rebuildCount}</div><div style="font-size:11px;color:#2563eb;">🔄 Rebuild (regular)</div></div>
            </div>
            <div style="margin-top:8px;font-size:0.8rem;color:#64748b;">Using template: <strong>${skName}</strong> from ${minutesToTime(clearMin)} onward</div>`;
    };
    document.getElementById('rain-clears-time').addEventListener('change', updatePreview);
    document.getElementById('rain-clears-time').addEventListener('input', updatePreview);
    document.getElementById('rain-clears-skeleton').addEventListener('change', updatePreview);
    document.getElementById('rain-clears-use-now').onclick = () => {
        const now2 = new Date();
        document.getElementById('rain-clears-time').value = `${String(now2.getHours()).padStart(2,'0')}:${String(Math.floor(now2.getMinutes()/5)*5).padStart(2,'0')}`;
        updatePreview();
    };
    document.getElementById('rain-clears-close').onclick = () => modal.remove();
    document.getElementById('rain-clears-cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.getElementById('rain-clears-confirm').onclick = () => {
        const skName = document.getElementById('rain-clears-skeleton').value;
        if (!skName) { alert('Please select a regular schedule template.'); return; }
        const [hours, mins] = document.getElementById('rain-clears-time').value.split(':').map(Number);
        modal.remove();
        executeRainClears(hours * 60 + mins, skName);
    };
    updatePreview();
}

function executeRainClears(clearTimeMin, regularSkeletonName) {
    console.log(`[RainStacker] ☀️ Executing rain clears at ${minutesToTime(clearTimeMin)}`);
    const resourceOverrides = buildRainyDayResourceOverrides();
    const result = handleMidDayRainClear(clearTimeMin, regularSkeletonName, resourceOverrides);
    if (!result.success) { console.error('[RainStacker] Failed:', result.error); alert('Failed to rebuild schedule: ' + (result.error || 'Unknown error')); return; }
    window.isRainyDay = false;
    window.rainyDayStartTime = null;
    window.saveCurrentDailyData?.('rainyDayMode', false);
    window.saveCurrentDailyData?.('rainyDayStartTime', null);
    window.saveCurrentDailyData?.('isRainyDay', false);
    const dailyData = window.loadCurrentDailyData?.() || {};
    const preRainyDisabled = dailyData.preRainyDayDisabledFields || [];
    const overrides = dailyData.overrides || {};
    overrides.disabledFields = preRainyDisabled;
    window.saveCurrentDailyData?.('overrides', overrides);
    window.saveCurrentDailyData?.('preRainyDayDisabledFields', null);
    window.saveCurrentDailyData?.('_preRainySkeletonName', null);
    if (typeof window.showRainyDayNotification === 'function') window.showRainyDayNotification(false, 0, false, false);
    if (typeof window.renderRainyDayPanel === 'function') window.renderRainyDayPanel();
    if (typeof window.renderResourceOverridesUI === 'function') window.renderResourceOverridesUI();
    window.forceSyncToCloud?.();
    console.log('[RainStacker] ☀️ Rain clears complete');
}
// =========================================================================
// EXPORTS
// =========================================================================
window.MidDayRainStacker = {
    handleMidDayRainStart,
    handleMidDayRainClear,
    rebuildFromTransition,
    prePlaceMorningAssignments,
    triggerPostRebuildGeneration,
    restorePreservedMorningSchedule,
    showRainClearsModal,
    executeRainClears,
    stackSchedule,
    parseSkeletonForDivision,
    expandPrepBlocks,
    calculateEffectiveStart,
    applyResourceOverrides,
    buildRainyDayResourceOverrides,
    getFlexRange,
    FLEX_PERCENT,
    SNAP_THRESHOLD_MIN,
    ROUND_TO_MIN
};
console.log('🌧️ Mid-Day Rain Stacker v2.0 loaded ✅');
console.log('   Usage: window.MidDayRainStacker.handleMidDayRainStart(rainMinutes)');
console.log('   Usage: window.MidDayRainStacker.handleMidDayRainClear(clearMinutes, skeletonName)');
console.log('   v2.0: Morning schedule preserved via _pinned + PinnedPreservation system');
})();
