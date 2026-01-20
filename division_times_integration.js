// =============================================================================
// division_times_integration.js v1.0 — INTEGRATION LAYER
// =============================================================================
//
// This file patches the existing scheduler systems to use the new
// per-division time slot system instead of the fixed 30-minute grid.
//
// LOAD ORDER:
// 1. division_times_system.js (core)
// 2. division_times_integration.js (this file)
// 3. Then existing files (scheduler_core_main.js, unified_schedule_system.js, etc.)
//
// =============================================================================

(function() {
    'use strict';

    const VERSION = '1.0.0';
    const DEBUG = true;

    function log(...args) {
        if (DEBUG) console.log('[DivTimesIntegration]', ...args);
    }

    // =========================================================================
    // WAIT FOR DEPENDENCIES
    // =========================================================================

    function waitForDependencies() {
        return new Promise(resolve => {
            const check = () => {
                if (window.DivisionTimesSystem) {
                    resolve();
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });
    }

    // =========================================================================
    // PATCH: SCHEDULER CORE - runSkeletonOptimizer
    // =========================================================================

    function patchSchedulerCore() {
        log('Patching scheduler core...');

        // Store original if exists
        const originalRunSkeletonOptimizer = window.runSkeletonOptimizer;

        // Create wrapper that builds divisionTimes first
        window.runSkeletonOptimizer = function(manualSkeleton, externalOverrides, allowedDivisions = null, existingScheduleSnapshot = null, existingUnifiedTimes = null) {
            console.log('\n' + '═'.repeat(70));
            console.log('★★★ DIVISION TIMES INTEGRATION - PRE-OPTIMIZER SETUP ★★★');
            console.log('═'.repeat(70));

            const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
            
            // ★★★ BUILD DIVISION-SPECIFIC TIMES ★★★
            log('Building division-specific time slots...');
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(manualSkeleton, divisions);
            
            // ★★★ ALSO BUILD UNIFIED TIMES FOR BACKWARDS COMPAT ★★★
            // This creates a "virtual" unified times from the union of all division times
            window.unifiedTimes = window.DivisionTimesSystem.buildUnifiedTimesFromDivisionTimes();
            log(`Built virtual unifiedTimes: ${window.unifiedTimes.length} slots`);

            // ★★★ INITIALIZE SCHEDULE ASSIGNMENTS PER DIVISION ★★★
            window.scheduleAssignments = window.scheduleAssignments || {};
            
            Object.entries(divisions).forEach(([divName, divData]) => {
                const divSlots = window.DivisionTimesSystem.getSlotsForDivision(divName);
                const slotCount = divSlots.length;
                
                (divData.bunks || []).forEach(bunk => {
                    if (!window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                    } else if (window.scheduleAssignments[bunk].length !== slotCount) {
                        // Resize array to match division's slot count
                        const old = window.scheduleAssignments[bunk];
                        window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                        // Try to migrate data by time matching (not index)
                        if (old && existingUnifiedTimes) {
                            migrateAssignmentsByTime(bunk, old, existingUnifiedTimes, divSlots);
                        }
                    }
                });
            });

            // ★★★ RESET FIELD USAGE TRACKER ★★★
            if (window.fieldUsageTracker) {
                window.fieldUsageTracker.clear();
            }

            log('Division times setup complete. Calling original optimizer...');
            
            // Call original optimizer
            if (originalRunSkeletonOptimizer) {
                return originalRunSkeletonOptimizer.call(this, manualSkeleton, externalOverrides, allowedDivisions, existingScheduleSnapshot, existingUnifiedTimes);
            }
        };

        log('✅ Patched runSkeletonOptimizer');
    }

    /**
     * Migrate assignments from old slot indices to new by matching times
     */
    function migrateAssignmentsByTime(bunk, oldAssignments, oldUnifiedTimes, newDivSlots) {
        if (!oldAssignments || !oldUnifiedTimes || !newDivSlots) return;

        log(`Migrating assignments for ${bunk}...`);

        oldAssignments.forEach((assignment, oldIdx) => {
            if (!assignment || assignment.continuation) return;

            // Get time from old slot
            const oldSlot = oldUnifiedTimes[oldIdx];
            if (!oldSlot) return;

            const startMin = oldSlot.startMin ?? (oldSlot.start instanceof Date ? 
                oldSlot.start.getHours() * 60 + oldSlot.start.getMinutes() : null);
            
            if (startMin === null) return;

            // Find matching new slot by time
            for (let newIdx = 0; newIdx < newDivSlots.length; newIdx++) {
                const newSlot = newDivSlots[newIdx];
                if (newSlot.startMin <= startMin && startMin < newSlot.endMin) {
                    window.scheduleAssignments[bunk][newIdx] = {
                        ...assignment,
                        _migratedFrom: oldIdx,
                        _startMin: newSlot.startMin,
                        _endMin: newSlot.endMin
                    };
                    log(`  ${bunk}[${oldIdx}] → [${newIdx}] (${assignment._activity || assignment.field})`);
                    break;
                }
            }
        });
    }

    // =========================================================================
    // PATCH: Utils.findSlotsForRange - DIVISION AWARE
    // =========================================================================

    function patchUtilsFunctions() {
        log('Patching utility functions...');

        // Wait for SchedulerCoreUtils to exist
        const patchUtils = () => {
            const Utils = window.SchedulerCoreUtils;
            if (!Utils) {
                setTimeout(patchUtils, 100);
                return;
            }

            // Store original
            const originalFindSlotsForRange = Utils.findSlotsForRange;

            // NEW: Division-aware version
            Utils.findSlotsForRange = function(startMin, endMin, divisionNameOrBunk = null) {
                // If division/bunk provided, use new system
                if (divisionNameOrBunk) {
                    let divName = divisionNameOrBunk;
                    
                    // Check if it's a bunk name
                    const divisions = window.divisions || {};
                    for (const [dName, dData] of Object.entries(divisions)) {
                        if (dData.bunks?.includes(divisionNameOrBunk)) {
                            divName = dName;
                            break;
                        }
                    }

                    const divSlots = window.DivisionTimesSystem?.getSlotsForDivision(divName) || [];
                    const result = [];
                    
                    for (let i = 0; i < divSlots.length; i++) {
                        const slot = divSlots[i];
                        // Check if slot overlaps with range
                        if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                            result.push(i);
                        }
                    }
                    
                    return result;
                }

                // Fallback to original for backwards compat
                if (originalFindSlotsForRange) {
                    return originalFindSlotsForRange.call(this, startMin, endMin);
                }

                // Ultimate fallback using virtual unifiedTimes
                const slots = [];
                const unifiedTimes = window.unifiedTimes || [];
                for (let i = 0; i < unifiedTimes.length; i++) {
                    const slot = unifiedTimes[i];
                    const slotStart = slot.startMin ?? (slot.start instanceof Date ?
                        slot.start.getHours() * 60 + slot.start.getMinutes() : null);
                    if (slotStart !== null && slotStart >= startMin && slotStart < endMin) {
                        slots.push(i);
                    }
                }
                return slots;
            };

            // Add new helper
            Utils.findSlotForDivision = function(divisionName, startMin, endMin) {
                return window.DivisionTimesSystem?.findSlotForTimeRange(divisionName, startMin, endMin) ?? -1;
            };

            Utils.getDivisionSlots = function(divisionName) {
                return window.DivisionTimesSystem?.getSlotsForDivision(divisionName) || [];
            };

            log('✅ Patched SchedulerCoreUtils');
        };

        patchUtils();
    }

    // =========================================================================
    // PATCH: fillBlock - USE DIVISION TIMES
    // =========================================================================

    function patchFillBlock() {
        log('Patching fillBlock...');

        const waitForFillBlock = () => {
            if (typeof window.fillBlock !== 'function') {
                setTimeout(waitForFillBlock, 100);
                return;
            }

            const originalFillBlock = window.fillBlock;

            window.fillBlock = function(block, pick, fieldUsageBySlot, yesterdayHistory, isRainyDay, activityProperties) {
                const bunk = block.bunk || block.bunkName || block.team;
                if (!bunk) {
                    console.warn('[fillBlock] No bunk in block:', block);
                    return originalFillBlock?.apply(this, arguments);
                }

                // Get division for this bunk
                const divName = window.DivisionTimesSystem?.getDivisionForBunk(bunk);
                
                if (divName && window.divisionTimes?.[divName]) {
                    // Use division-specific slot lookup
                    const divSlots = window.DivisionTimesSystem.getSlotsForDivision(divName);
                    
                    // Find slot by time range
                    const startMin = block.startTime;
                    const endMin = block.endTime;
                    
                    let slotIdx = -1;
                    for (let i = 0; i < divSlots.length; i++) {
                        if (divSlots[i].startMin === startMin || 
                            (divSlots[i].startMin <= startMin && startMin < divSlots[i].endMin)) {
                            slotIdx = i;
                            break;
                        }
                    }

                    if (slotIdx >= 0) {
                        // Update block with correct slots
                        block.slots = [slotIdx];
                        block._divisionSlotIndex = slotIdx;
                        block._divisionName = divName;
                    }

                    // Register with time-based field tracker
                    if (window.fieldUsageTracker && pick.field) {
                        const slot = divSlots[slotIdx];
                        if (slot) {
                            window.fieldUsageTracker.register(
                                pick.field,
                                slot.startMin,
                                slot.endMin,
                                divName,
                                bunk,
                                pick._activity || pick.sport
                            );
                        }
                    }
                }

                // Call original
                return originalFillBlock?.apply(this, arguments);
            };

            log('✅ Patched fillBlock');
        };

        waitForFillBlock();
    }

    // =========================================================================
    // PATCH: CLOUD STORAGE - SAVE/LOAD DIVISION TIMES
    // =========================================================================

    function patchCloudStorage() {
        log('Patching cloud storage...');

        const waitForScheduleDB = () => {
            if (!window.ScheduleDB) {
                setTimeout(waitForScheduleDB, 100);
                return;
            }

            const originalSaveSchedule = window.ScheduleDB.saveSchedule;

            window.ScheduleDB.saveSchedule = async function(dateKey, data, options = {}) {
                // Add divisionTimes to the data being saved
                const enrichedData = {
                    ...data,
                    divisionTimes: window.DivisionTimesSystem?.serialize(window.divisionTimes) || {},
                    // Keep unifiedTimes for backwards compat
                    unifiedTimes: data.unifiedTimes || window.unifiedTimes || []
                };

                log(`Saving schedule with divisionTimes for ${Object.keys(window.divisionTimes || {}).length} divisions`);

                return originalSaveSchedule.call(this, dateKey, enrichedData, options);
            };

            // Patch load to restore divisionTimes
            const originalLoadSchedule = window.ScheduleDB.loadSchedule;

            if (originalLoadSchedule) {
                window.ScheduleDB.loadSchedule = async function(dateKey) {
                    const result = await originalLoadSchedule.call(this, dateKey);

                    if (result?.data?.divisionTimes) {
                        log('Restoring divisionTimes from cloud...');
                        window.divisionTimes = window.DivisionTimesSystem?.deserialize(result.data.divisionTimes) || {};
                        
                        // Rebuild virtual unifiedTimes
                        window.unifiedTimes = window.DivisionTimesSystem?.buildUnifiedTimesFromDivisionTimes() || [];
                        
                        log(`Restored divisionTimes for ${Object.keys(window.divisionTimes).length} divisions`);
                    }

                    return result;
                };
            }

            log('✅ Patched ScheduleDB');
        };

        waitForScheduleDB();
    }

    // =========================================================================
    // PATCH: LOCAL STORAGE HANDLERS
    // =========================================================================

    function patchLocalStorage() {
        log('Patching localStorage handlers...');

        // Patch saveCurrentDailyData if it exists
        const originalSaveCurrentDailyData = window.saveCurrentDailyData;

        window.saveCurrentDailyData = function(key, value) {
            // If saving the whole schedule object, include divisionTimes
            if (key === 'scheduleAssignments' || key === 'all') {
                // Also save divisionTimes
                const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                try {
                    const allData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    if (!allData[dateKey]) allData[dateKey] = {};
                    allData[dateKey].divisionTimes = window.DivisionTimesSystem?.serialize(window.divisionTimes) || {};
                    localStorage.setItem('campDailyData_v1', JSON.stringify(allData));
                } catch (e) {
                    console.error('Error saving divisionTimes to localStorage:', e);
                }
            }

            if (originalSaveCurrentDailyData) {
                return originalSaveCurrentDailyData.call(this, key, value);
            }
        };

        // Patch loadCurrentDailyData if it exists
        const originalLoadCurrentDailyData = window.loadCurrentDailyData;

        window.loadCurrentDailyData = function() {
            const result = originalLoadCurrentDailyData ? originalLoadCurrentDailyData.call(this) : {};

            // If divisionTimes exists in loaded data, restore it
            if (result?.divisionTimes) {
                window.divisionTimes = window.DivisionTimesSystem?.deserialize(result.divisionTimes) || {};
                log('Restored divisionTimes from localStorage');
            }

            return result;
        };

        log('✅ Patched localStorage handlers');
    }

    // =========================================================================
    // PATCH: UI RENDERING
    // =========================================================================

    function patchUIRendering() {
        log('Patching UI rendering...');

        // Patch updateTable if it exists
        const waitForUpdateTable = () => {
            if (typeof window.updateTable !== 'function') {
                setTimeout(waitForUpdateTable, 200);
                return;
            }

            const originalUpdateTable = window.updateTable;

            window.updateTable = function(...args) {
                // Ensure divisionTimes is synced before rendering
                if (!window.divisionTimes || Object.keys(window.divisionTimes).length === 0) {
                    const skeleton = window.dailyOverrideSkeleton || window.manualSkeleton || [];
                    const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
                    
                    if (skeleton.length > 0) {
                        window.divisionTimes = window.DivisionTimesSystem?.buildFromSkeleton(skeleton, divisions) || {};
                        window.unifiedTimes = window.DivisionTimesSystem?.buildUnifiedTimesFromDivisionTimes() || [];
                    }
                }

                return originalUpdateTable?.apply(this, args);
            };

            log('✅ Patched updateTable');
        };

        waitForUpdateTable();
    }

    // =========================================================================
    // ENHANCED FIELD CONFLICT DETECTION
    // =========================================================================

    function setupFieldConflictDetection() {
        log('Setting up enhanced field conflict detection...');

        /**
         * Check if assigning a field to a bunk would conflict with other divisions
         * This uses TIME-BASED comparison, not slot indices!
         */
        window.checkFieldConflictAcrossDivisions = function(fieldName, bunk, slotIndex, capacity = 1) {
            const divName = window.DivisionTimesSystem?.getDivisionForBunk(bunk);
            const slot = window.DivisionTimesSystem?.getSlotAtIndex(divName, slotIndex);
            
            if (!slot) return { hasConflict: false };

            // Check time-based usage
            if (window.fieldUsageTracker) {
                const result = window.fieldUsageTracker.checkAvailability(
                    fieldName,
                    slot.startMin,
                    slot.endMin,
                    capacity,
                    bunk // exclude self
                );

                if (!result.available) {
                    return {
                        hasConflict: true,
                        conflicts: result.conflicts,
                        timeRange: `${window.DivisionTimesSystem.minutesToTimeLabel(slot.startMin)} - ${window.DivisionTimesSystem.minutesToTimeLabel(slot.endMin)}`
                    };
                }
            }

            return { hasConflict: false };
        };

        log('✅ Field conflict detection ready');
    }

    // =========================================================================
    // DIAGNOSTIC ENHANCEMENTS
    // =========================================================================

    function setupDiagnostics() {
        window.DivisionTimesIntegration = {
            version: VERSION,
            diagnose: () => {
                console.log('\n' + '═'.repeat(70));
                console.log('📊 DIVISION TIMES INTEGRATION DIAGNOSTIC');
                console.log('═'.repeat(70));

                console.log('\n1. DIVISION TIMES:');
                window.DivisionTimesSystem?.diagnose();

                console.log('\n2. FIELD USAGE TRACKER:');
                const tracker = window.fieldUsageTracker;
                if (tracker) {
                    const raw = tracker.getRawData();
                    Object.entries(raw).forEach(([field, usages]) => {
                        console.log(`   ${field}: ${usages.length} usages`);
                        usages.forEach(u => {
                            console.log(`     ${window.DivisionTimesSystem.minutesToTimeLabel(u.startMin)}-${window.DivisionTimesSystem.minutesToTimeLabel(u.endMin)} | ${u.division} | ${u.bunk}`);
                        });
                    });
                } else {
                    console.log('   Not initialized');
                }

                console.log('\n3. BACKWARDS COMPAT:');
                console.log(`   window.unifiedTimes: ${(window.unifiedTimes || []).length} virtual slots`);
                console.log(`   window.divisionTimes: ${Object.keys(window.divisionTimes || {}).length} divisions`);

                console.log('\n' + '═'.repeat(70));
            },

            // Force rebuild from skeleton
            rebuild: () => {
                const skeleton = window.dailyOverrideSkeleton || window.manualSkeleton || [];
                const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
                
                window.divisionTimes = window.DivisionTimesSystem?.buildFromSkeleton(skeleton, divisions) || {};
                window.unifiedTimes = window.DivisionTimesSystem?.buildUnifiedTimesFromDivisionTimes() || [];
                
                console.log('✅ Rebuilt divisionTimes from skeleton');
                window.DivisionTimesSystem?.diagnose();
            },

            // Check a specific field's availability
            checkField: (fieldName, startMin, endMin) => {
                if (window.fieldUsageTracker) {
                    const result = window.fieldUsageTracker.checkAvailability(fieldName, startMin, endMin);
                    console.log(`Field "${fieldName}" at ${startMin}-${endMin}:`, result);
                    return result;
                }
            }
        };
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        log('Initializing Division Times Integration v' + VERSION);

        await waitForDependencies();

        // Apply all patches
        patchSchedulerCore();
        patchUtilsFunctions();
        patchFillBlock();
        patchCloudStorage();
        patchLocalStorage();
        patchUIRendering();
        setupFieldConflictDetection();
        setupDiagnostics();

        log('✅ All patches applied');

        // Auto-rebuild if skeleton exists
        setTimeout(() => {
            if ((window.dailyOverrideSkeleton || window.manualSkeleton)?.length > 0 && 
                (!window.divisionTimes || Object.keys(window.divisionTimes).length === 0)) {
                log('Auto-rebuilding divisionTimes from existing skeleton...');
                window.DivisionTimesIntegration?.rebuild();
            }
        }, 500);
    }

    // Start initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('🔗 DIVISION TIMES INTEGRATION v' + VERSION + ' LOADED');
    console.log('');
    console.log('   Patches applied to:');
    console.log('   - runSkeletonOptimizer (builds divisionTimes before generation)');
    console.log('   - SchedulerCoreUtils.findSlotsForRange (division-aware)');
    console.log('   - fillBlock (uses division slots)');
    console.log('   - ScheduleDB (saves/loads divisionTimes)');
    console.log('   - localStorage handlers');
    console.log('   - updateTable (syncs before render)');
    console.log('');
    console.log('   Commands:');
    console.log('   - DivisionTimesIntegration.diagnose()  → Full diagnostic');
    console.log('   - DivisionTimesIntegration.rebuild()   → Force rebuild from skeleton');
    console.log('   - DivisionTimesIntegration.checkField("Basketball", 660, 720)');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');

})();
