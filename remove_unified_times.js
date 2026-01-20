// =============================================================================
// remove_unified_times.js v1.0 - PERMANENT unifiedTimes REMOVAL PATCH
// =============================================================================
//
// LOAD ORDER: Add this AFTER all scheduler files:
//   1. division_times_system.js
//   2. division_times_integration.js  
//   3. unified_schedule_system.js
//   4. scheduler_core_main.js
//   5. post_edit_system.js
//   6. remove_unified_times.js (THIS FILE)
//
// =============================================================================

(function() {
    'use strict';
    
    const VERSION = '1.0.0';
    
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('🗑️  REMOVING UNIFIED TIMES DEPENDENCY v' + VERSION);
    console.log('═══════════════════════════════════════════════════════════════════════');
    
    // =========================================================================
    // HELPER: Get division for a bunk (robust version)
    // =========================================================================
    function getDivisionForBunk(bunkName) {
        // Try DivisionTimesSystem first
        if (window.DivisionTimesSystem?.getDivisionForBunk) {
            const result = window.DivisionTimesSystem.getDivisionForBunk(bunkName);
            if (result) return result;
        }
        
        // Fallback to manual search
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            if (bunks.some(b => String(b) === String(bunkName))) {
                return divName;
            }
        }
        return null;
    }
    
    // Expose globally
    window.getDivisionForBunk = getDivisionForBunk;
    
    // =========================================================================
    // 1. DEPRECATE: buildUnifiedTimesFromDivisionTimes
    // =========================================================================
    if (window.DivisionTimesSystem) {
        window.DivisionTimesSystem.buildUnifiedTimesFromDivisionTimes = function() {
            console.warn('[DEPRECATED] buildUnifiedTimesFromDivisionTimes called - returning empty array');
            return [];
        };
        console.log('✅ Deprecated DivisionTimesSystem.buildUnifiedTimesFromDivisionTimes');
    }
    
    // =========================================================================
    // 2. REPLACE: getEntryForBlock - Use divisionTimes only
    // =========================================================================
    window.getEntryForBlock = function(bunk, startMin, endMin, _unifiedTimesIgnored) {
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) {
            return { entry: null, slotIdx: -1 };
        }
        const bunkData = assignments[bunk];
        
        // Use divisionTimes for slot lookup
        const divName = getDivisionForBunk(bunk);
        const divSlots = window.divisionTimes?.[divName] || [];
        
        // Find by matching time in divisionTimes
        for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
            const slot = divSlots[slotIdx];
            if (slot.startMin >= startMin && slot.startMin < endMin) {
                return { entry: bunkData[slotIdx] || null, slotIdx };
            }
        }
        
        // Fallback: Check embedded time in entry
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            const entryStartMin = entry._blockStart || entry._startMin || entry.startMin;
            if (entryStartMin !== undefined && entryStartMin >= startMin && entryStartMin < endMin) {
                return { entry, slotIdx };
            }
        }
        
        return { entry: null, slotIdx: -1 };
    };
    console.log('✅ Replaced getEntryForBlock (uses divisionTimes)');
    
    // =========================================================================
    // 3. REPLACE: findSlotsForRange - Division-aware
    // =========================================================================
    window.findSlotsForRange = function(startMin, endMin, bunkOrDivOrArray) {
        if (startMin === null || endMin === null) return [];
        
        // Handle bunk/division name
        if (typeof bunkOrDivOrArray === 'string' && window.divisionTimes) {
            let divName = bunkOrDivOrArray;
            
            // Check if it's a bunk name
            const possibleDiv = getDivisionForBunk(bunkOrDivOrArray);
            if (possibleDiv) divName = possibleDiv;
            
            const divSlots = window.divisionTimes[divName];
            if (divSlots && divSlots.length > 0) {
                const slots = [];
                for (let i = 0; i < divSlots.length; i++) {
                    const slot = divSlots[i];
                    if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                        slots.push(i);
                    }
                }
                return slots;
            }
        }
        
        // Legacy fallback - but warn
        if (Array.isArray(bunkOrDivOrArray) && bunkOrDivOrArray.length > 0) {
            console.warn('[findSlotsForRange] Called with array - using legacy mode');
            const slots = [];
            bunkOrDivOrArray.forEach((t, idx) => {
                let slotStart;
                if (t.startMin !== undefined) slotStart = t.startMin;
                else if (t.start) {
                    const d = new Date(t.start);
                    slotStart = d.getHours() * 60 + d.getMinutes();
                }
                if (slotStart !== undefined && slotStart >= startMin && slotStart < endMin) {
                    slots.push(idx);
                }
            });
            return slots;
        }
        
        return [];
    };
    console.log('✅ Replaced findSlotsForRange (division-aware)');
    
    // =========================================================================
    // 4. REPLACE: getSlotTimeRange - Division-aware
    // =========================================================================
    window.getSlotTimeRange = function(slotIdx, bunkOrDiv) {
        if (bunkOrDiv && window.divisionTimes) {
            let divName = bunkOrDiv;
            const possibleDiv = getDivisionForBunk(bunkOrDiv);
            if (possibleDiv) divName = possibleDiv;
            
            const slot = window.divisionTimes[divName]?.[slotIdx];
            if (slot) {
                return { startMin: slot.startMin, endMin: slot.endMin };
            }
        }
        
        // Legacy fallback with warning
        console.warn('[getSlotTimeRange] Called without bunk/division - deprecated');
        const unifiedTimes = window.unifiedTimes || [];
        const slot = unifiedTimes[slotIdx];
        if (!slot) return { startMin: null, endMin: null };
        
        let startMin, endMin;
        if (slot.startMin !== undefined) {
            startMin = slot.startMin;
            endMin = slot.endMin;
        } else {
            const start = new Date(slot.start);
            const end = new Date(slot.end);
            startMin = start.getHours() * 60 + start.getMinutes();
            endMin = end.getHours() * 60 + end.getMinutes();
        }
        return { startMin, endMin };
    };
    console.log('✅ Replaced getSlotTimeRange (division-aware)');
    
    // =========================================================================
    // 5. REPLACE: findFirstSlotForTime - Division-aware
    // =========================================================================
    window.findFirstSlotForTime = function(targetMin, bunkOrDiv) {
        if (bunkOrDiv && window.divisionTimes) {
            let divName = bunkOrDiv;
            const possibleDiv = getDivisionForBunk(bunkOrDiv);
            if (possibleDiv) divName = possibleDiv;
            
            const divSlots = window.divisionTimes[divName] || [];
            for (let i = 0; i < divSlots.length; i++) {
                if (divSlots[i].startMin === targetMin) return i;
                if (divSlots[i].startMin <= targetMin && divSlots[i].endMin > targetMin) return i;
            }
        }
        return -1;
    };
    console.log('✅ Replaced findFirstSlotForTime (division-aware)');
    
    // =========================================================================
    // 6. CREATE: TimeBasedFieldUsage - Real time-based conflict detection
    // =========================================================================
    window.TimeBasedFieldUsage = {
        getUsageAtTime: function(fieldName, startMin, endMin, excludeBunk = null) {
            const usage = [];
            const divisions = window.divisions || {};
            const fieldLower = fieldName.toLowerCase();
            
            for (const [divName, divData] of Object.entries(divisions)) {
                const divSlots = window.divisionTimes?.[divName] || [];
                
                for (const bunk of (divData.bunks || [])) {
                    if (excludeBunk && String(bunk) === String(excludeBunk)) continue;
                    
                    const assignments = window.scheduleAssignments?.[bunk] || [];
                    
                    for (let idx = 0; idx < divSlots.length; idx++) {
                        const slot = divSlots[idx];
                        
                        // Time overlap check
                        if (slot.startMin < endMin && slot.endMin > startMin) {
                            const entry = assignments[idx];
                            if (!entry || entry.continuation) continue;
                            
                            const entryField = (typeof entry.field === 'object' ? entry.field?.name : entry.field) || '';
                            
                            if (entryField.toLowerCase() === fieldLower) {
                                usage.push({
                                    bunk,
                                    division: divName,
                                    slotIndex: idx,
                                    timeStart: slot.startMin,
                                    timeEnd: slot.endMin,
                                    activity: entry._activity || entryField,
                                    field: entryField
                                });
                            }
                        }
                    }
                }
            }
            return usage;
        },
        
        checkAvailability: function(fieldName, startMin, endMin, capacity = 1, excludeBunk = null) {
            const usage = this.getUsageAtTime(fieldName, startMin, endMin, excludeBunk);
            
            // Find max concurrent usage
            let maxConcurrent = 0;
            const timePoints = new Set();
            usage.forEach(u => {
                timePoints.add(u.timeStart);
                timePoints.add(u.timeEnd);
            });
            
            for (const t of timePoints) {
                const concurrent = usage.filter(u => u.timeStart <= t && u.timeEnd > t).length;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
            }
            
            return {
                available: maxConcurrent < capacity,
                currentUsage: maxConcurrent,
                capacity,
                conflicts: usage
            };
        },
        
        buildUsageMap: function(excludeBunks = []) {
            const map = {};
            const excludeSet = new Set(excludeBunks.map(String));
            const divisions = window.divisions || {};
            
            for (const [divName, divData] of Object.entries(divisions)) {
                const divSlots = window.divisionTimes?.[divName] || [];
                
                for (const bunk of (divData.bunks || [])) {
                    if (excludeSet.has(String(bunk))) continue;
                    
                    const assignments = window.scheduleAssignments?.[bunk] || [];
                    
                    for (let idx = 0; idx < divSlots.length; idx++) {
                        const slot = divSlots[idx];
                        const entry = assignments[idx];
                        
                        if (!entry || entry.continuation || !entry.field) continue;
                        
                        const fieldName = (typeof entry.field === 'object' ? entry.field?.name : entry.field) || '';
                        if (!fieldName || fieldName === 'Free') continue;
                        
                        if (!map[fieldName]) map[fieldName] = [];
                        
                        map[fieldName].push({
                            startMin: slot.startMin,
                            endMin: slot.endMin,
                            division: divName,
                            bunk,
                            activity: entry._activity || fieldName
                        });
                    }
                }
            }
            return map;
        }
    };
    console.log('✅ Created TimeBasedFieldUsage');
    
    // =========================================================================
    // 7. REPLACE: checkLocationConflict - Time-based
    // =========================================================================
    const _originalCheckLocationConflict = window.checkLocationConflict;
    
    window.checkLocationConflict = function(locationName, slots, excludeBunk) {
        const divName = getDivisionForBunk(excludeBunk);
        const divSlots = window.divisionTimes?.[divName] || [];
        
        // Get time range from slots
        let startMin = Infinity, endMin = -Infinity;
        for (const slotIdx of slots) {
            const slot = divSlots[slotIdx];
            if (slot) {
                startMin = Math.min(startMin, slot.startMin);
                endMin = Math.max(endMin, slot.endMin);
            }
        }
        
        if (startMin === Infinity) {
            if (_originalCheckLocationConflict) {
                return _originalCheckLocationConflict(locationName, slots, excludeBunk);
            }
            return { hasConflict: false, conflicts: [] };
        }
        
        // Get capacity
        const activityProperties = window.activityProperties || window.getActivityProperties?.() || {};
        const locationInfo = activityProperties[locationName] || {};
        let maxCapacity = 1;
        if (locationInfo.sharableWith?.capacity) {
            maxCapacity = parseInt(locationInfo.sharableWith.capacity) || 1;
        } else if (locationInfo.sharable) {
            maxCapacity = 2;
        }
        
        // Time-based availability check
        const availability = window.TimeBasedFieldUsage.checkAvailability(
            locationName, startMin, endMin, maxCapacity, excludeBunk
        );
        
        // Check global locks
        let globalLock = null;
        if (window.GlobalFieldLocks) {
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, divName);
            if (lockInfo) globalLock = lockInfo;
        }
        
        const editableBunks = window.getEditableBunks?.() || new Set();
        const conflicts = availability.conflicts.map(c => ({
            bunk: c.bunk,
            slot: c.slotIndex,
            activity: c.activity,
            field: c.field,
            canEdit: editableBunks.has?.(c.bunk) || editableBunks.has?.(String(c.bunk))
        }));
        
        return {
            hasConflict: !availability.available || !!globalLock,
            conflicts,
            editableConflicts: conflicts.filter(c => c.canEdit),
            nonEditableConflicts: conflicts.filter(c => !c.canEdit),
            globalLock,
            canShare: maxCapacity > 1 && availability.currentUsage < maxCapacity,
            currentUsage: availability.currentUsage,
            maxCapacity
        };
    };
    console.log('✅ Replaced checkLocationConflict (time-based)');
    
    // =========================================================================
    // 8. REPLACE: checkCrossDivisionConflict - Time-based
    // =========================================================================
    window.checkCrossDivisionConflict = function(bunk, slotIndex, fieldName) {
        const divName = getDivisionForBunk(bunk);
        if (!divName) return { conflict: false, conflicts: [] };
        
        const slot = window.divisionTimes?.[divName]?.[slotIndex];
        if (!slot) return { conflict: false, conflicts: [] };
        
        const startMin = slot.startMin;
        const endMin = slot.endMin;
        
        // Get capacity
        const activityProperties = window.activityProperties || window.getActivityProperties?.() || {};
        const fieldInfo = activityProperties[fieldName] || {};
        let maxCapacity = 1;
        if (fieldInfo.sharableWith?.capacity) {
            maxCapacity = parseInt(fieldInfo.sharableWith.capacity) || 1;
        } else if (fieldInfo.sharable) {
            maxCapacity = 2;
        }
        
        const availability = window.TimeBasedFieldUsage.checkAvailability(
            fieldName, startMin, endMin, maxCapacity, bunk
        );
        
        return {
            conflict: !availability.available,
            conflicts: availability.conflicts,
            startMin,
            endMin,
            capacity: maxCapacity,
            currentUsage: availability.currentUsage
        };
    };
    console.log('✅ Replaced checkCrossDivisionConflict (time-based)');
    
    // =========================================================================
    // 9. REPLACE: buildFieldUsageBySlot - Division-aware
    // =========================================================================
    window.buildFieldUsageBySlot = function(excludeBunks = []) {
        const fieldUsageBySlot = {};
        const excludeSet = new Set(excludeBunks.map(String));
        const divisions = window.divisions || {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const divSlots = window.divisionTimes?.[divName] || [];
            
            for (const bunk of (divData.bunks || [])) {
                if (excludeSet.has(String(bunk))) continue;
                
                const assignments = window.scheduleAssignments?.[bunk] || [];
                
                for (let slotIdx = 0; slotIdx < assignments.length; slotIdx++) {
                    const entry = assignments[slotIdx];
                    if (!entry || !entry.field || entry._isTransition) continue;
                    
                    const fName = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                    if (!fName || fName === 'Free' || fName === 'Transition/Buffer') continue;
                    
                    const slot = divSlots[slotIdx];
                    
                    if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
                    if (!fieldUsageBySlot[slotIdx][fName]) {
                        fieldUsageBySlot[slotIdx][fName] = { 
                            count: 0, 
                            bunks: {}, 
                            divisions: [],
                            timeRange: slot ? { startMin: slot.startMin, endMin: slot.endMin } : null
                        };
                    }
                    
                    const usage = fieldUsageBySlot[slotIdx][fName];
                    usage.count++;
                    usage.bunks[bunk] = entry._activity || fName;
                    if (divName && !usage.divisions.includes(divName)) {
                        usage.divisions.push(divName);
                    }
                }
            }
        }
        return fieldUsageBySlot;
    };
    console.log('✅ Replaced buildFieldUsageBySlot (division-aware)');
    
    // =========================================================================
    // 10. SET unifiedTimes TO EMPTY
    // =========================================================================
    window.unifiedTimes = [];
    console.log('✅ Set window.unifiedTimes = [] (deprecated)');
    
    // =========================================================================
    // 11. PATCH: saveSchedule to not save unifiedTimes
    // =========================================================================
    const _originalSaveSchedule = window.saveSchedule;
    if (typeof _originalSaveSchedule === 'function') {
        window.saveSchedule = function() {
            const silent = window._postEditInProgress;
            if (window.saveCurrentDailyData) {
                window.saveCurrentDailyData('scheduleAssignments', window.scheduleAssignments, { silent });
                window.saveCurrentDailyData('leagueAssignments', window.leagueAssignments, { silent });
                // NOT saving unifiedTimes - it's deprecated
                window.saveCurrentDailyData('divisionTimes', window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || {}, { silent });
            }
        };
        console.log('✅ Patched saveSchedule (saves divisionTimes, not unifiedTimes)');
    }
    
    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================
    window.UnifiedTimesRemoval = {
        version: VERSION,
        
        verify: function() {
            console.log('\n' + '═'.repeat(60));
            console.log('🔍 UNIFIED TIMES REMOVAL VERIFICATION');
            console.log('═'.repeat(60));
            
            console.log('\n1. window.unifiedTimes:', window.unifiedTimes?.length || 0, 'slots');
            console.log('   Expected: 0 (deprecated)');
            
            console.log('\n2. window.divisionTimes:');
            Object.entries(window.divisionTimes || {}).forEach(([div, slots]) => {
                console.log(`   ${div}: ${slots.length} slots`);
            });
            
            console.log('\n3. Function replacements:');
            console.log('   getEntryForBlock:', typeof window.getEntryForBlock === 'function' ? '✅' : '❌');
            console.log('   findSlotsForRange:', typeof window.findSlotsForRange === 'function' ? '✅' : '❌');
            console.log('   getSlotTimeRange:', typeof window.getSlotTimeRange === 'function' ? '✅' : '❌');
            console.log('   TimeBasedFieldUsage:', typeof window.TimeBasedFieldUsage === 'object' ? '✅' : '❌');
            
            console.log('\n4. Render test (bunk "1"):');
            const bunk = "1";
            const divName = getDivisionForBunk(bunk);
            const divSlots = window.divisionTimes?.[divName] || [];
            divSlots.forEach((slot, i) => {
                const result = window.getEntryForBlock(bunk, slot.startMin, slot.endMin);
                const found = result.entry ? (result.entry._activity || result.entry.field) : 'EMPTY';
                const status = result.slotIdx === i ? '✅' : `❌ (got ${result.slotIdx})`;
                console.log(`   [${i}] ${slot.event}: "${found}" ${status}`);
            });
            
            console.log('\n' + '═'.repeat(60));
        },
        
        testFieldConflict: function(fieldName, startMin, endMin) {
            console.log(`\nField conflict test: ${fieldName} @ ${startMin}-${endMin}`);
            const usage = window.TimeBasedFieldUsage.getUsageAtTime(fieldName, startMin, endMin);
            console.log('Current usage:', usage);
            const avail = window.TimeBasedFieldUsage.checkAvailability(fieldName, startMin, endMin);
            console.log('Availability:', avail);
        }
    };
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('🗑️  UNIFIED TIMES REMOVED - Using divisionTimes directly');
    console.log('');
    console.log('   Verify with: UnifiedTimesRemoval.verify()');
    console.log('   Test field:  UnifiedTimesRemoval.testFieldConflict("Pool", 660, 720)');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');
    
    // Auto-refresh UI
    if (typeof window.updateTable === 'function') {
        setTimeout(() => window.updateTable(), 100);
    }
    
})();
