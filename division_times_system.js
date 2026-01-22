// =============================================================================
// division_times_system.js v1.2 — CAMPISTRY PER-DIVISION TIME SLOT SYSTEM
// =============================================================================
//
// ★★★ REPLACES THE BROKEN FIXED 30-MIN SLOT SYSTEM ★★★
//
// NEW SYSTEM (THIS FILE):
//   window.divisionTimes = {
//     "Junior Boys": [
//       { slotIndex: 0, startMin: 660, endMin: 720, event: "GA", type: "slot" },
//       { slotIndex: 1, startMin: 720, endMin: 740, event: "Lunch", type: "pinned" },
//     ],
//     ...
//   }
//   Each division has ITS OWN timeline with variable-length blocks!
//
// UPDATES v1.1:
// - Delegated lookup/utility functions to SchedulerCoreUtils to prevent duplication.
//
// UPDATES v1.2:
// - ★★★ SPLIT TILE FIX: Split tiles now create TWO separate slots in divisionTimes ★★★
// - Added expandSplitTiles() function
// - Modified buildDivisionTimesFromSkeleton() to call expandSplitTiles()
//
// =============================================================================

(function() {
    'use strict';

    const VERSION = '1.2.0';
    const DEBUG = true;

    function log(...args) {
        if (DEBUG) console.log('[DivisionTimes]', ...args);
    }

    function logError(...args) {
        console.error('[DivisionTimes] ❌', ...args);
    }

    // =========================================================================
    // TIME PARSING UTILITIES
    // =========================================================================

    /**
     * Parse time string to minutes since midnight
     * Handles: "9:00 AM", "9:00am", "9:00", "14:30", "2:30 PM"
     */
    function parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (!str || typeof str !== 'string') return null;
        
        let s = str.trim().toLowerCase();
        let meridian = null;
        
        // Extract AM/PM
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridian = s.slice(-2);
            s = s.slice(0, -2).trim();
        } else if (s.includes(' am') || s.includes(' pm')) {
            meridian = s.includes(' am') ? 'am' : 'pm';
            s = s.replace(/ am| pm/g, '').trim();
        }
        
        // Parse HH:MM
        const match = s.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        
        if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) return null;
        
        // Convert to 24-hour
        if (meridian === 'pm' && hours !== 12) hours += 12;
        if (meridian === 'am' && hours === 12) hours = 0;
        
        // Auto-detect PM for camp hours (assume 1-7 without meridian = PM)
        if (!meridian && hours >= 1 && hours <= 7) hours += 12;
        
        return hours * 60 + minutes;
    }

    /**
     * Convert minutes to time label
     * 540 → "9:00 AM", 810 → "1:30 PM"
     */
    function minutesToTimeLabel(mins) {
        if (mins === null || mins === undefined) return '';
        let h = Math.floor(mins / 60);
        let m = mins % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
    }

    /**
     * Convert minutes to Date object (for compatibility)
     */
    function minutesToDate(mins) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setMinutes(mins);
        return d;
    }

    // =========================================================================
    // ★★★ SPLIT TILE EXPANSION - v1.2 FIX ★★★
    // =========================================================================

    /**
     * Expand split tiles into two separate time blocks
     * This is CRITICAL - split tiles must create TWO slots, not one!
     * 
     * @param {Array} blocks - Parsed skeleton blocks for a division
     * @returns {Array} Blocks with split tiles expanded into two entries
     */
    function expandSplitTiles(blocks) {
        const expanded = [];
        
        blocks.forEach(block => {
            if (block.type === 'split') {
                // Calculate midpoint
                const midMin = Math.floor((block.startMin + block.endMin) / 2);
                
                // Parse activity names from event or subEvents
                let act1Name = 'Activity 1';
                let act2Name = 'Activity 2';
                
                if (block.subEvents && block.subEvents.length >= 2) {
                    act1Name = block.subEvents[0]?.event || block.subEvents[0] || 'Activity 1';
                    act2Name = block.subEvents[1]?.event || block.subEvents[1] || 'Activity 2';
                } else if (block.event && block.event.includes('/')) {
                    const parts = block.event.split('/').map(s => s.trim());
                    act1Name = parts[0] || 'Activity 1';
                    act2Name = parts[1] || 'Activity 2';
                }
                
                // Create first half slot
                expanded.push({
                    ...block,
                    id: (block.id || block._originalId || Date.now()) + '_half1',
                    startMin: block.startMin,
                    endMin: midMin,
                    event: act1Name,
                    type: 'split_half',
                    _splitHalf: 1,
                    _splitParentEvent: block.event,
                    _splitAct1: act1Name,
                    _splitAct2: act2Name,
                    _originalStartMin: block.startMin,
                    _originalEndMin: block.endMin
                });
                
                // Create second half slot
                expanded.push({
                    ...block,
                    id: (block.id || block._originalId || Date.now()) + '_half2',
                    startMin: midMin,
                    endMin: block.endMin,
                    event: act2Name,
                    type: 'split_half',
                    _splitHalf: 2,
                    _splitParentEvent: block.event,
                    _splitAct1: act1Name,
                    _splitAct2: act2Name,
                    _originalStartMin: block.startMin,
                    _originalEndMin: block.endMin
                });
                
                log(`  ★ Expanded split tile "${block.event}" into two slots:`);
                log(`    [Half 1] ${block.startMin}-${midMin}: ${act1Name}`);
                log(`    [Half 2] ${midMin}-${block.endMin}: ${act2Name}`);
            } else {
                expanded.push(block);
            }
        });
        
        return expanded;
    }

    // =========================================================================
    // CORE: BUILD DIVISION TIMES FROM SKELETON
    // =========================================================================

    /**
     * Build per-division time slots from skeleton
     * This is the CORE function that creates the new data structure
     * 
     * ★★★ v1.2 UPDATE: Now calls expandSplitTiles() to create TWO slots for split tiles ★★★
     * 
     * @param {Array} skeleton - The manual skeleton array
     * @param {Object} divisions - The divisions object { "Junior Boys": { bunks: [...] }, ... }
     * @returns {Object} divisionTimes - { "Junior Boys": [slots...], "Senior Boys": [slots...] }
     */
    function buildDivisionTimesFromSkeleton(skeleton, divisions) {
        log('Building division times from skeleton...');
        log(`  Skeleton items: ${skeleton?.length || 0}`);
        log(`  Divisions: ${Object.keys(divisions || {}).join(', ')}`);

        if (!skeleton || skeleton.length === 0) {
            log('  ⚠️ Empty skeleton, returning empty divisionTimes');
            return {};
        }

        const divisionTimes = {};

        // Group skeleton blocks by division
        const byDivision = {};
        skeleton.forEach(block => {
            const div = block.division;
            if (!div) return;
            if (!byDivision[div]) byDivision[div] = [];
            byDivision[div].push(block);
        });

        // Build slot array for each division
        for (const [divName, blocks] of Object.entries(byDivision)) {
            // Parse times and filter invalid
            const parsed = blocks
                .map(b => ({
                    ...b,
                    startMin: parseTimeToMinutes(b.startTime),
                    endMin: parseTimeToMinutes(b.endTime)
                }))
                .filter(b => b.startMin !== null && b.endMin !== null && b.endMin > b.startMin);

            // Sort by start time
            parsed.sort((a, b) => a.startMin - b.startMin);

            // ★★★ v1.2 FIX: Expand split tiles BEFORE consolidation ★★★
            const withExpandedSplits = expandSplitTiles(parsed);
            
            // Re-sort after expansion (split halves should be in order)
            withExpandedSplits.sort((a, b) => a.startMin - b.startMin);

            // Handle overlapping/nested blocks by merging or splitting
            const consolidated = consolidateBlocks(withExpandedSplits);

            // Create slot array
            divisionTimes[divName] = consolidated.map((block, idx) => ({
                slotIndex: idx,
                startMin: block.startMin,
                endMin: block.endMin,
                duration: block.endMin - block.startMin,
                event: block.event || 'Activity',
                type: block.type || 'slot',
                label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`,
                // Preserve original skeleton data
                _originalId: block.id,
                _subEvents: block.subEvents,
                _smartData: block.smartData,
                // ★★★ v1.2: Preserve split tile metadata ★★★
                _splitHalf: block._splitHalf,
                _splitParentEvent: block._splitParentEvent,
                _splitAct1: block._splitAct1,
                _splitAct2: block._splitAct2,
                _originalStartMin: block._originalStartMin,
                _originalEndMin: block._originalEndMin,
                // For backwards compat: Date objects
                start: minutesToDate(block.startMin),
                end: minutesToDate(block.endMin)
            }));

            log(`  ${divName}: ${divisionTimes[divName].length} slots`);
            if (DEBUG && divisionTimes[divName].length > 0) {
                divisionTimes[divName].forEach((slot, i) => {
                    const splitInfo = slot._splitHalf ? ` [SPLIT HALF ${slot._splitHalf}]` : '';
                    log(`    [${i}] ${slot.label} - ${slot.event} (${slot.type})${splitInfo}`);
                });
            }
        }

        // Ensure all divisions have an entry (even if empty)
        Object.keys(divisions || {}).forEach(divName => {
            if (!divisionTimes[divName]) {
                divisionTimes[divName] = [];
                log(`  ${divName}: 0 slots (no skeleton blocks)`);
            }
        });

        log(`✅ Built divisionTimes for ${Object.keys(divisionTimes).length} divisions`);
        return divisionTimes;
    }

    /**
     * Consolidate overlapping blocks
     * If blocks overlap, we need to handle them intelligently
     * 
     * ★★★ v1.2 UPDATE: Split half blocks should NOT be merged with each other ★★★
     */
    function consolidateBlocks(blocks) {
        if (blocks.length === 0) return [];

        const result = [];
        let current = { ...blocks[0] };

        for (let i = 1; i < blocks.length; i++) {
            const next = blocks[i];

            // Check for overlap
            if (next.startMin < current.endMin) {
                // Blocks overlap - decide how to handle
                if (next.startMin === current.startMin && next.endMin === current.endMin) {
                    // Exact same time - skip duplicate (keep first)
                    log(`    ⚠️ Duplicate block at ${current.startMin}-${current.endMin}, skipping`);
                    continue;
                } else if (next.type === 'split' || current.type === 'split' || 
                           next.type === 'split_half' || current.type === 'split_half') {
                    // Split tiles are special - keep both as separate entries
                    result.push(current);
                    current = { ...next };
                } else {
                    // General overlap - keep both but log warning
                    log(`    ⚠️ Overlapping blocks: ${current.event} (${current.startMin}-${current.endMin}) and ${next.event} (${next.startMin}-${next.endMin})`);
                    result.push(current);
                    current = { ...next };
                }
            } else {
                // No overlap - push current and move to next
                result.push(current);
                current = { ...next };
            }
        }

        // Don't forget the last one
        result.push(current);

        return result;
    }

    // =========================================================================
    // SLOT LOOKUP FUNCTIONS (MOVED TO Utils)
    // =========================================================================
    
    // REMOVED: getSlotsForDivision (use window.SchedulerCoreUtils.getSlotsForDivision)
    // REMOVED: getSlotAtIndex (use window.SchedulerCoreUtils.getSlotAtIndex)
    // REMOVED: findSlotForTime (use window.SchedulerCoreUtils.findSlotForTime)
    // REMOVED: findSlotForTimeRange (use window.SchedulerCoreUtils.findSlotForTimeRange)
    // REMOVED: findSlotsOverlappingRange (use window.SchedulerCoreUtils.findSlotsOverlappingRange)
    // REMOVED: getDivisionForBunk (use window.SchedulerCoreUtils.getDivisionForBunk)
    // REMOVED: getSlotsForBunk (use window.SchedulerCoreUtils.getSlotsForBunk)
    
    /**
     * Find slot for a bunk at a given time
     * (Kept as local helper but using Utils)
     */
    function findSlotForBunkAtTime(bunkName, targetMin) {
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunkName);
        if (!divName) return -1;
        return window.SchedulerCoreUtils?.findSlotForTime(divName, targetMin);
    }

    // =========================================================================
    // ★★★ NEW v1.2: EXACT TIME RANGE SLOT FINDER ★★★
    // =========================================================================
    
    /**
     * Find the exact slot index that matches a specific time range
     * This is CRITICAL for split tiles where we need exact matches
     * 
     * @param {string} divisionName - Division name
     * @param {number} startMin - Start time in minutes
     * @param {number} endMin - End time in minutes
     * @returns {number} Slot index or -1 if not found
     */
    function findExactSlotForTimeRange(divisionName, startMin, endMin) {
        const slots = window.divisionTimes?.[divisionName] || [];
        
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin === startMin && slots[i].endMin === endMin) {
                return i;
            }
        }
        
        // Fallback: find slot that contains this time range
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin <= startMin && slots[i].endMin >= endMin) {
                return i;
            }
        }
        
        return -1;
    }

    // =========================================================================
    // FIELD USAGE TRACKING (TIME-BASED, NOT SLOT-BASED)
    // =========================================================================

    /**
     * NEW: Field usage is tracked by TIME RANGES, not slot indices
     * This properly handles cross-division conflicts
     */
    function createFieldUsageTracker() {
        const _usage = {};

        return {
            register(fieldName, startMin, endMin, division, bunk, activity) {
                if (!fieldName || startMin === null || endMin === null) return false;
                
                const key = fieldName.toLowerCase().trim();
                if (!_usage[key]) _usage[key] = [];
                
                _usage[key].push({
                    startMin,
                    endMin,
                    division,
                    bunk,
                    activity,
                    registeredAt: Date.now()
                });
                
                return true;
            },

            checkAvailability(fieldName, startMin, endMin, capacity = 1, excludeBunk = null) {
                const key = fieldName.toLowerCase().trim();
                const usages = _usage[key] || [];
                
                // Find all overlapping usages
                const conflicts = usages.filter(u => {
                    if (excludeBunk && u.bunk === excludeBunk) return false;
                    return !(endMin <= u.startMin || startMin >= u.endMin);
                });
                
                return {
                    available: conflicts.length < capacity,
                    currentUsage: conflicts.length,
                    capacity,
                    conflicts
                };
            },

            getUsages(fieldName) {
                const key = fieldName.toLowerCase().trim();
                return _usage[key] || [];
            },

            clear() {
                Object.keys(_usage).forEach(k => delete _usage[k]);
            },

            getRawData() {
                return { ..._usage };
            }
        };
    }

    // =========================================================================
    // BACKWARDS COMPATIBILITY: UNIFIED TIMES BRIDGE
    // =========================================================================

   function mapUnifiedSlotToDivision(unifiedSlotIndex, divisionName) {
        console.warn('[DEPRECATED] mapUnifiedSlotToDivision - use divisionTimes directly');
        return -1;
    }

    function mapUnifiedSlotToDivision(unifiedSlotIndex, divisionName) {
        const unifiedTimes = window.unifiedTimes || [];
        // UPDATED: Use Utils
        const divSlots = window.SchedulerCoreUtils?.getSlotsForDivision(divisionName);
        
        if (!unifiedTimes[unifiedSlotIndex]) return -1;
        
        const targetStart = unifiedTimes[unifiedSlotIndex].startMin;
        
        // Find which division slot contains this time (Use Utils)
        return window.SchedulerCoreUtils?.findSlotForTime(divisionName, targetStart);
    }

    // =========================================================================
    // SERIALIZATION FOR STORAGE
    // =========================================================================

    function serializeDivisionTimes(divisionTimes) {
        if (!divisionTimes) return {};
        
        const serialized = {};
        
        for (const [divName, slots] of Object.entries(divisionTimes)) {
            serialized[divName] = slots.map(slot => ({
                slotIndex: slot.slotIndex,
                startMin: slot.startMin,
                endMin: slot.endMin,
                duration: slot.duration,
                event: slot.event,
                type: slot.type,
                label: slot.label,
                start: slot.start instanceof Date ? slot.start.toISOString() : slot.start,
                end: slot.end instanceof Date ? slot.end.toISOString() : slot.end,
                _originalId: slot._originalId,
                _subEvents: slot._subEvents,
                _smartData: slot._smartData,
                // ★★★ v1.2: Serialize split tile metadata ★★★
                _splitHalf: slot._splitHalf,
                _splitParentEvent: slot._splitParentEvent,
                _splitAct1: slot._splitAct1,
                _splitAct2: slot._splitAct2,
                _originalStartMin: slot._originalStartMin,
                _originalEndMin: slot._originalEndMin
            }));
        }
        
        return serialized;
    }

    function deserializeDivisionTimes(serialized) {
        if (!serialized) return {};
        
        const divisionTimes = {};
        
        for (const [divName, slots] of Object.entries(serialized)) {
            divisionTimes[divName] = (slots || []).map(slot => ({
                ...slot,
                start: new Date(slot.start),
                end: new Date(slot.end),
                startMin: slot.startMin,
                endMin: slot.endMin,
                duration: slot.duration || (slot.endMin - slot.startMin),
                slotIndex: slot.slotIndex
            }));
        }
        
        return divisionTimes;
    }

    // =========================================================================
    // SCHEDULE ASSIGNMENT HELPERS
    // =========================================================================

    function initializeBunkAssignments(bunkName) {
        // UPDATED: Use Utils
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunkName);
        const slots = window.SchedulerCoreUtils?.getSlotsForDivision(divName) || [];
        const slotCount = slots.length || 20;
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        
        if (!window.scheduleAssignments[bunkName]) {
            window.scheduleAssignments[bunkName] = new Array(slotCount).fill(null);
        } else if (window.scheduleAssignments[bunkName].length < slotCount) {
            // Expand if needed
            const current = window.scheduleAssignments[bunkName];
            window.scheduleAssignments[bunkName] = new Array(slotCount).fill(null);
            current.forEach((val, i) => {
                window.scheduleAssignments[bunkName][i] = val;
            });
        }
        
        return window.scheduleAssignments[bunkName];
    }

    function getAssignmentAtTime(bunkName, targetMin) {
        const slotIdx = findSlotForBunkAtTime(bunkName, targetMin);
        if (slotIdx === -1) return null;
        return window.scheduleAssignments?.[bunkName]?.[slotIdx] || null;
    }

    function setAssignment(bunkName, slotIndex, assignmentData) {
        // UPDATED: Use Utils
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunkName);
        const slot = window.SchedulerCoreUtils?.getSlotAtIndex(divName, slotIndex);
        
        initializeBunkAssignments(bunkName);
        
        // Enrich with time data
        const enrichedData = {
            ...assignmentData,
            _startMin: slot?.startMin,
            _endMin: slot?.endMin,
            _slotIndex: slotIndex,
            _division: divName
        };
        
        window.scheduleAssignments[bunkName][slotIndex] = enrichedData;
        return enrichedData;
    }

    // =========================================================================
    // DIAGNOSTIC FUNCTIONS
    // =========================================================================

    function diagnose() {
        console.log('\n' + '═'.repeat(70));
        console.log('📊 DIVISION TIMES SYSTEM DIAGNOSTIC v1.2');
        console.log('═'.repeat(70));

        const divisionTimes = window.divisionTimes || {};
        const divisions = Object.keys(divisionTimes);

        console.log(`\nDivisions with times: ${divisions.length}`);
        
        divisions.forEach(divName => {
            const slots = divisionTimes[divName];
            console.log(`\n📁 ${divName}: ${slots.length} slots`);
            slots.forEach((slot, i) => {
                const splitInfo = slot._splitHalf ? ` [SPLIT H${slot._splitHalf}]` : '';
                console.log(`   [${i}] ${slot.label} | ${slot.event} (${slot.type})${splitInfo} | ${slot.duration} min`);
            });
        });

        // Check scheduleAssignments alignment
        console.log('\n📋 Schedule Assignments:');
        const assignments = window.scheduleAssignments || {};
        Object.entries(assignments).forEach(([bunk, slots]) => {
            // UPDATED: Use Utils
            const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunk);
            const divSlots = window.SchedulerCoreUtils?.getSlotsForDivision(divName) || [];
            const filled = (slots || []).filter(s => s && !s.continuation).length;
            const mismatch = divSlots.length !== (slots?.length || 0);
            console.log(`   ${bunk} (${divName}): ${filled} assignments, ${slots?.length || 0} slots ${mismatch ? '⚠️ MISMATCH' : '✅'}`);
        });

        // Check for cross-division time overlaps
        console.log('\n⏰ Cross-Division Time Overlaps:');
        const divNames = Object.keys(divisionTimes);
        for (let i = 0; i < divNames.length; i++) {
            for (let j = i + 1; j < divNames.length; j++) {
                const div1 = divNames[i];
                const div2 = divNames[j];
                const slots1 = divisionTimes[div1];
                const slots2 = divisionTimes[div2];
                
                slots1.forEach((s1, idx1) => {
                    slots2.forEach((s2, idx2) => {
                        if (!(s1.endMin <= s2.startMin || s2.endMin <= s1.startMin)) {
                            const overlapStart = Math.max(s1.startMin, s2.startMin);
                            const overlapEnd = Math.min(s1.endMin, s2.endMin);
                            console.log(`   ${div1}[${idx1}] ↔ ${div2}[${idx2}]: ${minutesToTimeLabel(overlapStart)}-${minutesToTimeLabel(overlapEnd)}`);
                        }
                    });
                });
            }
        }

        console.log('\n' + '═'.repeat(70));
    }

    // =========================================================================
    // BUNK SLOT COUNT UTILITIES (formerly division_times_bunk_fix.js)
    // =========================================================================

    /**
     * Fix all bunk slot counts to match their division's slot count
     */
    function fixAllBunkSlotCounts() {
        console.log('[DivisionTimes] Fixing all bunk slot counts...');
        
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        let fixedCount = 0;
        let errorCount = 0;
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            // UPDATED: Use Utils (assumes getDivisionForBunk handles variations)
            const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunk);
            
            if (!divName) {
                console.warn(`   ⚠️ ${bunk}: No division found`);
                errorCount++;
                return;
            }
            
            const expectedSlots = divisionTimes[divName]?.length || 0;
            const actualSlots = slots?.length || 0;
            
            if (expectedSlots === 0) {
                errorCount++;
                return;
            }
            
            if (actualSlots !== expectedSlots) {
                const newArr = new Array(expectedSlots).fill(null);
                const minLen = Math.min(actualSlots, expectedSlots);
                
                for (let i = 0; i < minLen; i++) {
                    newArr[i] = slots[i];
                }
                
                window.scheduleAssignments[bunk] = newArr;
                fixedCount++;
            }
        });
        
        console.log(`[DivisionTimes] Fixed ${fixedCount} bunks, ${errorCount} errors`);
        window.updateTable?.();
        
        return { fixed: fixedCount, errors: errorCount };
    }
function buildUnifiedTimesFromDivisionTimes(divisionTimes) {
    if (!divisionTimes || Object.keys(divisionTimes).length === 0) {
        return [];
    }
    
    const timePoints = new Set();
    
    Object.values(divisionTimes).forEach(slots => {
        (slots || []).forEach(slot => {
            if (slot.startMin !== undefined) timePoints.add(slot.startMin);
            if (slot.endMin !== undefined) timePoints.add(slot.endMin);
        });
    });
    
    const sortedTimes = [...timePoints].sort((a, b) => a - b);
    const unifiedTimes = [];
    
    for (let i = 0; i < sortedTimes.length - 1; i++) {
        const startMin = sortedTimes[i];
        const endMin = sortedTimes[i + 1];
        
        if (endMin - startMin < 5) continue;
        
        unifiedTimes.push({
            slotIndex: unifiedTimes.length,
            startMin: startMin,
            endMin: endMin,
            duration: endMin - startMin,
            label: `${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}`,
            start: minutesToDate(startMin),
            end: minutesToDate(endMin)
        });
    }
    
    log(`Built unified times: ${unifiedTimes.length} slots`);
    return unifiedTimes;
}
    /**
     * Fill missing pinned slots with their event data
     */
    function fillMissingPinnedSlots() {
        console.log('[DivisionTimes] Filling missing pinned slots...');
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        let filledCount = 0;
        
        Object.entries(divisionTimes).forEach(([divName, slots]) => {
            const divBunks = (divisions[divName]?.bunks || []).map(b => String(b));
            const assignedBunks = Object.keys(assignments).filter(bunk => 
                // UPDATED: Use Utils
                window.SchedulerCoreUtils?.getDivisionForBunk(bunk) === divName
            );
            const allBunks = [...new Set([...divBunks, ...assignedBunks])];
            
            slots.forEach((slot, idx) => {
                if (slot.type !== 'pinned') return;
                
                const eventName = slot.event || 'Pinned Event';
                
                allBunks.forEach(bunk => {
                    if (!assignments[bunk]) {
                        assignments[bunk] = new Array(slots.length).fill(null);
                    }
                    
                    const entry = assignments[bunk][idx];
                    if (!entry) {
                        assignments[bunk][idx] = {
                            field: eventName,
                            sport: null,
                            _fixed: true,
                            _activity: eventName,
                            _pinned: true,
                            _startMin: slot.startMin,
                            _endMin: slot.endMin,
                            _slotIndex: idx,
                            _division: divName,
                            _autoFilled: true
                        };
                        filledCount++;
                    }
                });
            });
        });
        
        console.log(`[DivisionTimes] Filled ${filledCount} missing pinned slots`);
        window.updateTable?.();
        
        return filledCount;
    }

    // =========================================================================
    // ENHANCED DIAGNOSTIC
    // =========================================================================
    
    function diagnoseBunkSlots() {
        console.log('\n' + '═'.repeat(70));
        console.log('🔧 DIVISION TIMES BUNK DIAGNOSTIC v1.2');
        console.log('═'.repeat(70));
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        console.log('\n=== DIVISION STRUCTURE ===');
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const slotCount = divisionTimes[divName]?.length || 0;
            const splitSlots = (divisionTimes[divName] || []).filter(s => s._splitHalf).length;
            console.log(`Division "${divName}": ${bunks.length} bunks, ${slotCount} slots (${splitSlots} from split tiles)`);
        });
        
        console.log('\n=== SLOT ALIGNMENT ===');
        let correctCount = 0, fixedCount = 0, errorCount = 0;
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            // UPDATED: Use Utils
            const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunk);
            const expectedSlots = divisionTimes[divName]?.length || 0;
            const actualSlots = slots?.length || 0;
            
            if (!divName) {
                errorCount++;
            } else if (actualSlots === expectedSlots) {
                correctCount++;
            } else {
                fixedCount++;
                console.log(`   ⚠️ ${bunk}: has ${actualSlots}, should have ${expectedSlots}`);
            }
        });
        
        console.log(`\nSummary: ${correctCount} correct, ${fixedCount} need resize, ${errorCount} no division`);
        
        if (fixedCount > 0) {
            console.log('\n💡 Run fixAllBunkSlotCounts() to fix mismatched arrays');
        }
        
        console.log('\n' + '═'.repeat(70));
    }

    // =========================================================================
    // GENERATION COMPLETE HOOK
    // =========================================================================
    
    function setupGenerationCompleteHook() {
        window.addEventListener('campistry-generation-complete', function(e) {
            console.log('[DivisionTimes] Generation complete - running auto-fixes...');
            
            setTimeout(() => {
                const slotFixes = fixAllBunkSlotCounts();
                const pinnedFills = fillMissingPinnedSlots();
                console.log(`[DivisionTimes] Post-generation: ${slotFixes.fixed} slot resizes, ${pinnedFills} pinned fills`);
            }, 100);
        });
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initialize() {
        log('Initializing Division Times System v' + VERSION);

        // Create global if not exists
        if (!window.divisionTimes) {
            window.divisionTimes = {};
        }

        // Create field usage tracker
        window.fieldUsageTracker = createFieldUsageTracker();
        
        // Setup generation hook
        setupGenerationCompleteHook();

        log('✅ Division Times System initialized');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.DivisionTimesSystem = {
        version: VERSION,

        // Core building
        buildFromSkeleton: buildDivisionTimesFromSkeleton,
        
        // ★★★ v1.2: Expose split tile expansion ★★★
        expandSplitTiles: expandSplitTiles,
        
        // Time parsing
        parseTimeToMinutes,
        minutesToTimeLabel,
        minutesToDate,

        // Utils (Legacy Aliases - kept for simple compat, but implemented in Utils now)
        getSlotsForDivision: (div) => window.SchedulerCoreUtils?.getSlotsForDivision(div) || [],
        
        // ★★★ v1.2: New exact time range finder ★★★
        findExactSlotForTimeRange,
        
        // Conflict detection (delegated)
        createFieldUsageTracker,

        // Backwards compatibility
        buildUnifiedTimesFromDivisionTimes,
        mapUnifiedSlotToDivision,

        // Serialization
        serialize: serializeDivisionTimes,
        deserialize: deserializeDivisionTimes,

        // Assignment helpers
        initializeBunkAssignments,
        getAssignmentAtTime,
        setAssignment,

        // Utils
        fixAllBunkSlotCounts,
        fillMissingPinnedSlots,

        // Diagnostic
        diagnose,
        diagnoseBunkSlots,

        // Internal (for debugging)
        _consolidateBlocks: consolidateBlocks
    };

    // Auto-initialize
    initialize();

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('⏰ DIVISION TIMES SYSTEM v' + VERSION + ' LOADED');
    console.log('');
    console.log('   ★★★ v1.2 FIX: Split tiles now create TWO separate slots! ★★★');
    console.log('   UPDATED: Logic delegated to SchedulerCoreUtils');
    console.log('   Commands:');
    console.log('   - DivisionTimesSystem.diagnose()        → Full diagnostic');
    console.log('   - DivisionTimesSystem.fixAllBunkSlotCounts()');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');

    // Global convenience exports
    window.fixAllBunkSlotCounts = fixAllBunkSlotCounts;
    window.fillMissingPinnedSlots = fillMissingPinnedSlots;

})();
