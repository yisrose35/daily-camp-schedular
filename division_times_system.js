// =============================================================================
// division_times_system.js v1.0 — CAMPISTRY PER-DIVISION TIME SLOT SYSTEM
// =============================================================================
//
// ★★★ REPLACES THE BROKEN FIXED 30-MIN SLOT SYSTEM ★★★
//
// OLD SYSTEM (BROKEN):
//   window.unifiedTimes = [30-min slots] - ALL divisions use same indices
//   Problem: Activity 1:20-2:45 doesn't fit 30-min boundaries
//   Problem: Division A has 11:00-12:00 lunch, Division B has 11:30-12:30 lunch
//            - Both get different slot indices for "lunch" causing chaos
//
// NEW SYSTEM (THIS FILE):
//   window.divisionTimes = {
//     "Junior Boys": [
//       { slotIndex: 0, startMin: 660, endMin: 720, event: "GA", type: "slot" },
//       { slotIndex: 1, startMin: 720, endMin: 740, event: "Lunch", type: "pinned" },
//     ],
//     "Senior Boys": [
//       { slotIndex: 0, startMin: 660, endMin: 750, event: "GA", type: "slot" },
//       { slotIndex: 1, startMin: 750, endMin: 770, event: "Lunch", type: "pinned" },
//     ]
//   }
//   Each division has ITS OWN timeline with variable-length blocks!
//
// =============================================================================

(function() {
    'use strict';

    const VERSION = '1.0.0';
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
    // CORE: BUILD DIVISION TIMES FROM SKELETON
    // =========================================================================

    /**
     * Build per-division time slots from skeleton
     * This is the CORE function that creates the new data structure
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

            // Handle overlapping/nested blocks by merging or splitting
            const consolidated = consolidateBlocks(parsed);

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
                // For backwards compat: Date objects
                start: minutesToDate(block.startMin),
                end: minutesToDate(block.endMin)
            }));

            log(`  ${divName}: ${divisionTimes[divName].length} slots`);
            if (DEBUG && divisionTimes[divName].length > 0) {
                divisionTimes[divName].forEach((slot, i) => {
                    log(`    [${i}] ${slot.label} - ${slot.event} (${slot.type})`);
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
                } else if (next.type === 'split' || current.type === 'split') {
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
    // SLOT LOOKUP FUNCTIONS
    // =========================================================================

    /**
     * Get all slots for a division
     */
    function getSlotsForDivision(divisionName) {
        return window.divisionTimes?.[divisionName] || [];
    }

    /**
     * Get slot at a specific index for a division
     */
    function getSlotAtIndex(divisionName, slotIndex) {
        return window.divisionTimes?.[divisionName]?.[slotIndex] || null;
    }

    /**
     * Find which slot contains a given time (in minutes)
     * Returns slot index or -1 if not found
     */
    function findSlotForTime(divisionName, targetMin) {
        const slots = getSlotsForDivision(divisionName);
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin <= targetMin && targetMin < slots[i].endMin) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Find slot index by exact time range match
     * Returns slot index or -1 if not found
     */
    function findSlotForTimeRange(divisionName, startMin, endMin) {
        const slots = getSlotsForDivision(divisionName);
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin === startMin && slots[i].endMin === endMin) {
                return i;
            }
        }
        // Fallback: find slot that contains this range
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin <= startMin && endMin <= slots[i].endMin) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Find all slots that overlap with a time range
     * Returns array of slot indices
     */
    function findSlotsOverlappingRange(divisionName, startMin, endMin) {
        const slots = getSlotsForDivision(divisionName);
        const result = [];
        for (let i = 0; i < slots.length; i++) {
            // Check for overlap: !(endMin <= slot.startMin || startMin >= slot.endMin)
            if (!(endMin <= slots[i].startMin || startMin >= slots[i].endMin)) {
                result.push(i);
            }
        }
        return result;
    }

    /**
     * Get division name for a bunk
     */
    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    }

    /**
     * Get slots for a bunk (via its division)
     */
    function getSlotsForBunk(bunkName) {
        const divName = getDivisionForBunk(bunkName);
        return divName ? getSlotsForDivision(divName) : [];
    }

    /**
     * Find slot for a bunk at a given time
     */
    function findSlotForBunkAtTime(bunkName, targetMin) {
        const divName = getDivisionForBunk(bunkName);
        if (!divName) return -1;
        return findSlotForTime(divName, targetMin);
    }

    // =========================================================================
    // CROSS-DIVISION CONFLICT DETECTION
    // =========================================================================

    /**
     * Check if two divisions have overlapping time slots at a field
     * This is CRITICAL for detecting conflicts like:
     *   Junior Boys @ Basketball 11:00-12:00
     *   Senior Boys @ Basketball 11:30-12:30
     * 
     * The slot indices are different, but the TIMES overlap!
     */
    function checkTimeOverlapConflict(div1, slot1Idx, div2, slot2Idx) {
        const slot1 = getSlotAtIndex(div1, slot1Idx);
        const slot2 = getSlotAtIndex(div2, slot2Idx);
        
        if (!slot1 || !slot2) return false;
        
        // Check actual time overlap
        return !(slot1.endMin <= slot2.startMin || slot2.endMin <= slot1.startMin);
    }

    /**
     * Get all divisions that have time slots overlapping with a given slot
     * Returns: [{ division, slotIndex, overlapStart, overlapEnd }, ...]
     */
    function findOverlappingDivisionSlots(divisionName, slotIndex) {
        const slot = getSlotAtIndex(divisionName, slotIndex);
        if (!slot) return [];

        const overlaps = [];
        const allDivisions = Object.keys(window.divisionTimes || {});

        for (const otherDiv of allDivisions) {
            if (otherDiv === divisionName) continue;

            const otherSlots = getSlotsForDivision(otherDiv);
            for (let i = 0; i < otherSlots.length; i++) {
                const other = otherSlots[i];
                
                // Check for time overlap
                if (!(slot.endMin <= other.startMin || other.endMin <= slot.startMin)) {
                    const overlapStart = Math.max(slot.startMin, other.startMin);
                    const overlapEnd = Math.min(slot.endMin, other.endMin);
                    
                    overlaps.push({
                        division: otherDiv,
                        slotIndex: i,
                        slot: other,
                        overlapStart,
                        overlapEnd,
                        overlapDuration: overlapEnd - overlapStart
                    });
                }
            }
        }

        return overlaps;
    }

    // =========================================================================
    // FIELD USAGE TRACKING (TIME-BASED, NOT SLOT-BASED)
    // =========================================================================

    /**
     * NEW: Field usage is tracked by TIME RANGES, not slot indices
     * This properly handles cross-division conflicts
     * 
     * Structure:
     * {
     *   "Basketball Court": [
     *     { startMin: 660, endMin: 720, division: "Junior Boys", bunk: "Bunk 1" },
     *     { startMin: 720, endMin: 780, division: "Senior Boys", bunk: "Bunk 5" },
     *   ]
     * }
     */
    function createFieldUsageTracker() {
        const _usage = {};

        return {
            /**
             * Register a field usage
             */
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

            /**
             * Check if field is available at a time range
             * Returns: { available: boolean, conflicts: [...] }
             */
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

            /**
             * Get all usages for a field
             */
            getUsages(fieldName) {
                const key = fieldName.toLowerCase().trim();
                return _usage[key] || [];
            },

            /**
             * Clear all usages (for regeneration)
             */
            clear() {
                Object.keys(_usage).forEach(k => delete _usage[k]);
            },

            /**
             * Get raw data (for debugging)
             */
            getRawData() {
                return { ..._usage };
            }
        };
    }

    // =========================================================================
    // BACKWARDS COMPATIBILITY: UNIFIED TIMES BRIDGE
    // =========================================================================

    /**
     * For code that still uses window.unifiedTimes, we can create a "virtual"
     * unified times array that represents the UNION of all division times.
     * 
     * This is for READING ONLY during transition period.
     * New code should use division-specific lookups.
     */
    function buildUnifiedTimesFromDivisionTimes() {
        const divisionTimes = window.divisionTimes || {};
        const allTimePoints = new Set();

        // Collect all unique time points
        Object.values(divisionTimes).forEach(slots => {
            slots.forEach(slot => {
                allTimePoints.add(slot.startMin);
                allTimePoints.add(slot.endMin);
            });
        });

        // Sort time points
        const sorted = [...allTimePoints].sort((a, b) => a - b);
        
        // Build unified slots from consecutive time points
        const unifiedSlots = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            unifiedSlots.push({
                start: minutesToDate(sorted[i]),
                end: minutesToDate(sorted[i + 1]),
                startMin: sorted[i],
                endMin: sorted[i + 1],
                label: `${minutesToTimeLabel(sorted[i])} - ${minutesToTimeLabel(sorted[i + 1])}`,
                _isVirtualUnified: true
            });
        }

        return unifiedSlots;
    }

    /**
     * Map old-style slot index to new division-specific slot
     * This helps during migration
     */
    function mapUnifiedSlotToDivision(unifiedSlotIndex, divisionName) {
        const unifiedTimes = window.unifiedTimes || [];
        const divSlots = getSlotsForDivision(divisionName);
        
        if (!unifiedTimes[unifiedSlotIndex]) return -1;
        
        const targetStart = unifiedTimes[unifiedSlotIndex].startMin;
        
        // Find which division slot contains this time
        return findSlotForTime(divisionName, targetStart);
    }

    // =========================================================================
    // SERIALIZATION FOR STORAGE
    // =========================================================================

    /**
     * Serialize divisionTimes for localStorage/Supabase storage
     */
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
                // Date objects to ISO strings
                start: slot.start instanceof Date ? slot.start.toISOString() : slot.start,
                end: slot.end instanceof Date ? slot.end.toISOString() : slot.end,
                // Preserve metadata
                _originalId: slot._originalId,
                _subEvents: slot._subEvents,
                _smartData: slot._smartData
            }));
        }
        
        return serialized;
    }

    /**
     * Deserialize divisionTimes from storage
     */
    function deserializeDivisionTimes(serialized) {
        if (!serialized) return {};
        
        const divisionTimes = {};
        
        for (const [divName, slots] of Object.entries(serialized)) {
            divisionTimes[divName] = (slots || []).map(slot => ({
                ...slot,
                // ISO strings back to Date objects
                start: new Date(slot.start),
                end: new Date(slot.end),
                // Ensure numeric fields
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

    /**
     * Initialize schedule assignments array for a bunk
     * Uses the division's slot count, not global unifiedTimes
     */
    function initializeBunkAssignments(bunkName) {
        const divName = getDivisionForBunk(bunkName);
        const slots = getSlotsForDivision(divName);
        const slotCount = slots.length || 20; // Default fallback
        
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

    /**
     * Get assignment for a bunk at a specific time
     */
    function getAssignmentAtTime(bunkName, targetMin) {
        const slotIdx = findSlotForBunkAtTime(bunkName, targetMin);
        if (slotIdx === -1) return null;
        return window.scheduleAssignments?.[bunkName]?.[slotIdx] || null;
    }

    /**
     * Set assignment for a bunk at a slot
     * Includes time metadata for cross-division conflict detection
     */
    function setAssignment(bunkName, slotIndex, assignmentData) {
        const divName = getDivisionForBunk(bunkName);
        const slot = getSlotAtIndex(divName, slotIndex);
        
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
        console.log('📊 DIVISION TIMES SYSTEM DIAGNOSTIC');
        console.log('═'.repeat(70));

        const divisionTimes = window.divisionTimes || {};
        const divisions = Object.keys(divisionTimes);

        console.log(`\nDivisions with times: ${divisions.length}`);
        
        divisions.forEach(divName => {
            const slots = divisionTimes[divName];
            console.log(`\n📁 ${divName}: ${slots.length} slots`);
            slots.forEach((slot, i) => {
                console.log(`   [${i}] ${slot.label} | ${slot.event} (${slot.type}) | ${slot.duration} min`);
            });
        });

        // Check scheduleAssignments alignment
        console.log('\n📋 Schedule Assignments:');
        const assignments = window.scheduleAssignments || {};
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = getDivisionForBunk(bunk);
            const divSlots = getSlotsForDivision(divName);
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

        log('✅ Division Times System initialized');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.DivisionTimesSystem = {
        version: VERSION,

        // Core building
        buildFromSkeleton: buildDivisionTimesFromSkeleton,
        
        // Time parsing
        parseTimeToMinutes,
        minutesToTimeLabel,
        minutesToDate,

        // Slot lookups
        getSlotsForDivision,
        getSlotAtIndex,
        findSlotForTime,
        findSlotForTimeRange,
        findSlotsOverlappingRange,
        getDivisionForBunk,
        getSlotsForBunk,
        findSlotForBunkAtTime,

        // Conflict detection
        checkTimeOverlapConflict,
        findOverlappingDivisionSlots,
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

        // Diagnostic
        diagnose,

        // Internal (for debugging)
        _consolidateBlocks: consolidateBlocks
    };

    // Auto-initialize
    initialize();

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('⏰ DIVISION TIMES SYSTEM v' + VERSION + ' LOADED');
    console.log('');
    console.log('   NEW ARCHITECTURE: Per-division variable-length time slots');
    console.log('   REPLACES: Fixed 30-minute grid shared across all divisions');
    console.log('');
    console.log('   Commands:');
    console.log('   - DivisionTimesSystem.diagnose()        → Full diagnostic');
    console.log('   - DivisionTimesSystem.getSlotsForDivision("Junior Boys")');
    console.log('   - DivisionTimesSystem.findSlotForTime("Junior Boys", 720)');
    console.log('   - DivisionTimesSystem.buildFromSkeleton(skeleton, divisions)');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');
// =========================================================================
    // ENHANCED BUNK LOOKUP (from division_times_bunk_fix.js)
    // =========================================================================
    
    /**
     * Enhanced bunk-to-division lookup with type coercion
     * Handles string vs number mismatches, leading zeros, etc.
     */
    function getDivisionForBunkEnhanced(bunkName) {
        if (!bunkName) return null;
        
        const divisions = window.divisions || {};
        const bunkStr = String(bunkName).trim();
        const bunkNum = parseInt(bunkName, 10);
        const bunkLower = bunkStr.toLowerCase();
        
        for (const [divName, divData] of Object.entries(divisions)) {
            if (!divData.bunks || !Array.isArray(divData.bunks)) continue;
            
            const found = divData.bunks.some(b => {
                if (b === bunkName) return true;  // Exact match
                if (String(b) === bunkStr) return true;  // String match
                if (!isNaN(bunkNum) && parseInt(b, 10) === bunkNum) return true;  // Numeric match
                if (String(b).toLowerCase() === bunkLower) return true;  // Case-insensitive
                return false;
            });
            
            if (found) return divName;
        }
        
        return null;
    }

    // =========================================================================
    // BUNK SLOT COUNT UTILITIES
    // =========================================================================
    
    /**
     * Fix all bunk slot counts to match their division's slot count
     */
    function fixAllBunkSlotCounts() {
        console.log('[DivisionTimes] Fixing all bunk slot counts...');
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        let fixedCount = 0;
        let errorCount = 0;
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = getDivisionForBunkEnhanced(bunk);
            
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
                getDivisionForBunkEnhanced(bunk) === divName
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
    // ENHANCED DIAGNOSTIC
    // =========================================================================
    
    function diagnoseBunkSlots() {
        console.log('\n' + '═'.repeat(70));
        console.log('🔧 DIVISION TIMES BUNK DIAGNOSTIC');
        console.log('═'.repeat(70));
        
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        
        console.log('\n=== DIVISION STRUCTURE ===');
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const slotCount = divisionTimes[divName]?.length || 0;
            console.log(`Division "${divName}": ${bunks.length} bunks, ${slotCount} slots`);
        });
        
        console.log('\n=== SLOT ALIGNMENT ===');
        let correctCount = 0, fixedCount = 0, errorCount = 0;
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = getDivisionForBunkEnhanced(bunk);
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
    // EXPORTS (add to existing DivisionTimesSystem object)
    // =========================================================================
    
    // Update getDivisionForBunk to use enhanced version
    window.DivisionTimesSystem.getDivisionForBunk = getDivisionForBunkEnhanced;
    
    // Add new utilities
    window.DivisionTimesSystem.fixAllBunkSlotCounts = fixAllBunkSlotCounts;
    window.DivisionTimesSystem.fillMissingPinnedSlots = fillMissingPinnedSlots;
    window.DivisionTimesSystem.diagnoseBunkSlots = diagnoseBunkSlots;
    
    // Global exports for convenience
    window.fixAllBunkSlotCounts = fixAllBunkSlotCounts;
    window.fillMissingPinnedSlots = fillMissingPinnedSlots;
    window.getDivisionForBunk = getDivisionForBunkEnhanced;
    
    // Legacy compatibility
    window.BunkFix = {
        diagnose: diagnoseBunkSlots,
        fixSlotCounts: fixAllBunkSlotCounts,
        getDivisionForBunk: getDivisionForBunkEnhanced,
        version: '2.0 (integrated)'
    };
    
    // Setup hooks
    setupGenerationCompleteHook();
    
    console.log('[DivisionTimes] ✅ Bunk fix utilities integrated');
})();
