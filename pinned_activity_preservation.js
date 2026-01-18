// =============================================================================
// PINNED ACTIVITY PRESERVATION SYSTEM
// =============================================================================
// 
// PURPOSE: Ensures that user-pinned activities (from post-generation edits)
// survive full schedule regenerations.
//
// HOW IT WORKS:
// 1. Before generation: Captures all entries with _pinned: true
// 2. Registers their field usage in GlobalFieldLocks to prevent conflicts
// 3. After generation: Restores pinned entries to their original slots
//
// INTEGRATION: Add this file AFTER scheduler_core_main.js and post_edit_system.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('📌 Pinned Activity Preservation System loading...');

    // =========================================================================
    // STORAGE FOR PINNED ACTIVITIES
    // =========================================================================
    
    let _pinnedSnapshot = {};  // { bunk: { slotIdx: entry } }
    let _pinnedFieldLocks = []; // Track what we locked so we can verify

    // =========================================================================
    // CAPTURE PINNED ACTIVITIES (Call before generation)
    // =========================================================================

    /**
     * Scan current scheduleAssignments and capture all pinned entries
     * @param {string[]} allowedDivisions - Optional: only capture from these divisions
     * @returns {object} Snapshot of pinned activities
     */
    function capturePinnedActivities(allowedDivisions) {
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        
        _pinnedSnapshot = {};
        _pinnedFieldLocks = [];
        
        let capturedCount = 0;
        
        // Build set of allowed bunks if divisions filter provided
        let allowedBunks = null;
        if (allowedDivisions && allowedDivisions.length > 0) {
            allowedBunks = new Set();
            for (const divName of allowedDivisions) {
                const divInfo = divisions[divName];
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => allowedBunks.add(b));
                }
            }
        }
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            // Skip if not in allowed divisions
            if (allowedBunks && !allowedBunks.has(bunkName)) {
                continue;
            }
            
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                
                // Check if this is a pinned entry
                if (entry && entry._pinned === true) {
                    if (!_pinnedSnapshot[bunkName]) {
                        _pinnedSnapshot[bunkName] = {};
                    }
                    
                    _pinnedSnapshot[bunkName][slotIdx] = {
                        ...entry,
                        _preservedAt: Date.now()
                    };
                    
                    capturedCount++;
                    
                    // Track field lock info
                    const fieldName = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                    if (fieldName && fieldName !== 'Free') {
                        _pinnedFieldLocks.push({
                            field: fieldName,
                            slot: slotIdx,
                            bunk: bunkName,
                            activity: entry._activity || fieldName
                        });
                    }
                }
            }
        }
        
        console.log(`[PinnedPreserve] 📌 Captured ${capturedCount} pinned activities from ${Object.keys(_pinnedSnapshot).length} bunks`);
        
        if (_pinnedFieldLocks.length > 0) {
            console.log(`[PinnedPreserve] 🔒 Will lock ${_pinnedFieldLocks.length} field-slot combinations`);
        }
        
        return _pinnedSnapshot;
    }

    // =========================================================================
    // REGISTER PINNED FIELD LOCKS (Call during generation setup)
    // =========================================================================

    /**
     * Lock all fields used by pinned activities so they don't get assigned to others
     * Call this AFTER GlobalFieldLocks.reset() but BEFORE any scheduling
     */
    function registerPinnedFieldLocks() {
        if (!window.GlobalFieldLocks) {
            console.warn('[PinnedPreserve] GlobalFieldLocks not available');
            return;
        }
        
        const divisions = window.divisions || {};
        let locksRegistered = 0;
        
        for (const lockInfo of _pinnedFieldLocks) {
            // Find division for this bunk
            const divName = Object.keys(divisions).find(d => 
                divisions[d]?.bunks?.includes(lockInfo.bunk)
            );
            
            const success = window.GlobalFieldLocks.lockField(
                lockInfo.field,
                [lockInfo.slot],
                {
                    lockedBy: 'pinned_activity',
                    division: divName || 'unknown',
                    activity: lockInfo.activity,
                    bunk: lockInfo.bunk,
                    _pinnedLock: true
                }
            );
            
            if (success !== false) {
                locksRegistered++;
            }
        }
        
        console.log(`[PinnedPreserve] 🔒 Registered ${locksRegistered}/${_pinnedFieldLocks.length} field locks for pinned activities`);
    }

    /**
     * Also register in fieldUsageBySlot if that's being used
     */
    function registerPinnedFieldUsage(fieldUsageBySlot, activityProperties) {
        if (!fieldUsageBySlot) return;
        
        const divisions = window.divisions || {};
        
        for (const lockInfo of _pinnedFieldLocks) {
            const slotIdx = lockInfo.slot;
            const fieldName = lockInfo.field;
            
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            
            // Get field capacity
            const props = activityProperties?.[fieldName] || {};
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                maxCapacity = 2;
            }
            
            if (!fieldUsageBySlot[slotIdx][fieldName]) {
                fieldUsageBySlot[slotIdx][fieldName] = {
                    count: 0,
                    divisions: [],
                    bunks: {},
                    _locked: true,
                    _fromPinned: true
                };
            }
            
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++;
            usage.bunks[lockInfo.bunk] = lockInfo.activity;
            
            const divName = Object.keys(divisions).find(d => 
                divisions[d]?.bunks?.includes(lockInfo.bunk)
            );
            if (divName && !usage.divisions.includes(divName)) {
                usage.divisions.push(divName);
            }
        }
        
        console.log(`[PinnedPreserve] 📊 Registered pinned field usage in fieldUsageBySlot`);
    }

    // =========================================================================
    // RESTORE PINNED ACTIVITIES (Call after generation)
    // =========================================================================

    /**
     * Restore all captured pinned activities back into scheduleAssignments
     * @returns {number} Number of entries restored
     */
    function restorePinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        let restoredCount = 0;
        
        for (const [bunkName, pinnedSlots] of Object.entries(_pinnedSnapshot)) {
            // Initialize bunk array if needed
            if (!assignments[bunkName]) {
                const totalSlots = (window.unifiedTimes || []).length;
                assignments[bunkName] = new Array(totalSlots);
            }
            
            for (const [slotIdxStr, entry] of Object.entries(pinnedSlots)) {
                const slotIdx = parseInt(slotIdxStr, 10);
                
                // Restore the pinned entry
                assignments[bunkName][slotIdx] = {
                    ...entry,
                    _restoredAt: Date.now()
                };
                
                restoredCount++;
            }
        }
        
        console.log(`[PinnedPreserve] ✅ Restored ${restoredCount} pinned activities`);
        
        return restoredCount;
    }

    // =========================================================================
    // HOOK INTO SCHEDULER - Automatic Integration
    // =========================================================================

    /**
     * Wrap the main generation function to automatically preserve pinned activities
     */
    function hookSchedulerGeneration() {
        // Hook into runScheduler if it exists
        if (typeof window.runScheduler === 'function' && !window.runScheduler._pinnedHooked) {
            const originalRunScheduler = window.runScheduler;
            
            window.runScheduler = async function(...args) {
                console.log('[PinnedPreserve] 🚀 Generation starting - capturing pinned activities');
                
                // Get allowed divisions from args if provided
                const allowedDivisions = args[0]?.allowedDivisions || null;
                
                // Capture before generation
                capturePinnedActivities(allowedDivisions);
                
                // Run original
                const result = await originalRunScheduler.apply(this, args);
                
                // Restore after generation
                if (Object.keys(_pinnedSnapshot).length > 0) {
                    console.log('[PinnedPreserve] 🔄 Generation complete - restoring pinned activities');
                    restorePinnedActivities();
                    
                    // Save the restored data
                    window.saveSchedule?.();
                }
                
                return result;
            };
            
            window.runScheduler._pinnedHooked = true;
            console.log('[PinnedPreserve] ✅ Hooked into runScheduler');
        }
        
        // Also hook into generateSchedule if different
        if (typeof window.generateSchedule === 'function' && !window.generateSchedule._pinnedHooked) {
            const originalGenerateSchedule = window.generateSchedule;
            
            window.generateSchedule = async function(...args) {
                console.log('[PinnedPreserve] 🚀 Generation starting - capturing pinned activities');
                
                const allowedDivisions = args[0]?.allowedDivisions || 
                                        window.selectedDivisionsForGeneration || 
                                        null;
                
                // Capture before generation
                capturePinnedActivities(allowedDivisions);
                
                // Run original
                const result = await originalGenerateSchedule.apply(this, args);
                
                // Restore after generation
                if (Object.keys(_pinnedSnapshot).length > 0) {
                    console.log('[PinnedPreserve] 🔄 Generation complete - restoring pinned activities');
                    restorePinnedActivities();
                    
                    // Save and refresh
                    window.saveSchedule?.();
                    window.updateTable?.();
                }
                
                return result;
            };
            
            window.generateSchedule._pinnedHooked = true;
            console.log('[PinnedPreserve] ✅ Hooked into generateSchedule');
        }
        
        // Hook into the Step 1.5 pattern used by scheduler_core_main.js
        if (typeof window.executeStep1_5 === 'function' && !window.executeStep1_5._pinnedHooked) {
            const originalStep1_5 = window.executeStep1_5;
            
            window.executeStep1_5 = function(snapshot, divisions, allowedDivisions, fieldUsageBySlot, activityProperties, existingUnifiedTimes) {
                // First, register our pinned field locks BEFORE the background restore
                if (_pinnedFieldLocks.length > 0) {
                    console.log('[PinnedPreserve] 📌 Registering pinned field locks in Step 1.5');
                    registerPinnedFieldLocks();
                    registerPinnedFieldUsage(fieldUsageBySlot, activityProperties);
                }
                
                // Run original
                return originalStep1_5.apply(this, arguments);
            };
            
            window.executeStep1_5._pinnedHooked = true;
            console.log('[PinnedPreserve] ✅ Hooked into executeStep1_5');
        }
    }

    // =========================================================================
    // EVENT-BASED HOOKS (Alternative approach)
    // =========================================================================

    // Listen for generation events
    window.addEventListener('campistry-generation-starting', (e) => {
        console.log('[PinnedPreserve] 📡 Received generation-starting event');
        const allowedDivisions = e.detail?.allowedDivisions || null;
        capturePinnedActivities(allowedDivisions);
    });

    window.addEventListener('campistry-generation-complete', (e) => {
        if (Object.keys(_pinnedSnapshot).length > 0) {
            console.log('[PinnedPreserve] 📡 Received generation-complete event - restoring');
            restorePinnedActivities();
        }
    });

    // =========================================================================
    // MANUAL TRIGGER FUNCTIONS
    // =========================================================================

    /**
     * Manually trigger the full preservation cycle
     * Call this if automatic hooks aren't working
     */
    window.preservePinnedForRegeneration = function(allowedDivisions) {
        capturePinnedActivities(allowedDivisions);
        registerPinnedFieldLocks();
    };

    /**
     * Manually restore after generation
     */
    window.restorePinnedAfterRegeneration = function() {
        const count = restorePinnedActivities();
        window.saveSchedule?.();
        window.updateTable?.();
        return count;
    };

    // =========================================================================
    // UTILITY: View/Clear Pinned Activities
    // =========================================================================

    /**
     * Get all currently pinned activities in the schedule
     */
    window.getPinnedActivities = function() {
        const assignments = window.scheduleAssignments || {};
        const pinned = [];
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    pinned.push({
                        bunk: bunkName,
                        slot: slotIdx,
                        activity: entry._activity || entry.field,
                        field: typeof entry.field === 'object' ? entry.field?.name : entry.field,
                        editedAt: entry._editedAt || entry._preservedAt
                    });
                }
            }
        }
        
        return pinned;
    };

    /**
     * Remove the pinned flag from a specific entry (allows it to be regenerated)
     */
    window.unpinActivity = function(bunk, slotIdx) {
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry) {
            delete entry._pinned;
            delete entry._postEdit;
            entry._unpinnedAt = Date.now();
            
            window.saveSchedule?.();
            window.updateTable?.();
            
            console.log(`[PinnedPreserve] 📌❌ Unpinned ${bunk} at slot ${slotIdx}`);
            return true;
        }
        return false;
    };

    /**
     * Unpin all activities (allows full regeneration)
     */
    window.unpinAllActivities = function() {
        const assignments = window.scheduleAssignments || {};
        let unpinnedCount = 0;
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    delete entry._pinned;
                    delete entry._postEdit;
                    entry._unpinnedAt = Date.now();
                    unpinnedCount++;
                }
            }
        }
        
        window.saveSchedule?.();
        window.updateTable?.();
        
        console.log(`[PinnedPreserve] 📌❌ Unpinned ${unpinnedCount} activities`);
        return unpinnedCount;
    };

    // =========================================================================
    // DEBUG HELPERS
    // =========================================================================

    window.debugPinnedSnapshot = function() {
        console.log('[PinnedPreserve] Current snapshot:', _pinnedSnapshot);
        console.log('[PinnedPreserve] Field locks:', _pinnedFieldLocks);
        return { snapshot: _pinnedSnapshot, locks: _pinnedFieldLocks };
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function init() {
        // Try to hook immediately
        hookSchedulerGeneration();
        
        // Also retry after a delay (in case scheduler loads later)
        setTimeout(hookSchedulerGeneration, 1000);
        setTimeout(hookSchedulerGeneration, 3000);
        
        console.log('📌 Pinned Activity Preservation System initialized');
        console.log('   - Auto-hooks into runScheduler/generateSchedule');
        console.log('   - Listens for campistry-generation-* events');
        console.log('   - Manual: preservePinnedForRegeneration(), restorePinnedAfterRegeneration()');
        console.log('   - Utilities: getPinnedActivities(), unpinActivity(bunk, slot), unpinAllActivities()');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.PinnedActivitySystem = {
        capture: capturePinnedActivities,
        registerLocks: registerPinnedFieldLocks,
        registerUsage: registerPinnedFieldUsage,
        restore: restorePinnedActivities,
        getAll: window.getPinnedActivities,
        unpin: window.unpinActivity,
        unpinAll: window.unpinAllActivities,
        debug: window.debugPinnedSnapshot
    };

    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
