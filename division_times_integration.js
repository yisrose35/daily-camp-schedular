// =============================================================================
// division_times_integration.js v1.1 — INTEGRATION LAYER
// =============================================================================
//
// v1.1 CHANGES:
// - Added skeleton parameter fallback to window.manualSkeleton, 
//   window.dailyOverrideSkeleton, or localStorage when parameter is empty
// - Fixed division 4,5,6 getting wrong slot counts
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

    const VERSION = '1.1.0';
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
    // HELPER: GET SKELETON FROM ANY SOURCE
    // =========================================================================

    function getSkeletonFromAnySource() {
        // Priority 1: Window globals
        if (window.manualSkeleton && window.manualSkeleton.length > 0) {
            log('Using skeleton from window.manualSkeleton: ' + window.manualSkeleton.length + ' items');
            return window.manualSkeleton;
        }
        
        if (window.dailyOverrideSkeleton && window.dailyOverrideSkeleton.length > 0) {
            log('Using skeleton from window.dailyOverrideSkeleton: ' + window.dailyOverrideSkeleton.length + ' items');
            return window.dailyOverrideSkeleton;
        }
        
        // Priority 2: localStorage with date key
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const storageKey = 'campManualSkeleton_' + dateKey;
        
        try {
            const stored = localStorage.getItem(storageKey);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && parsed.length > 0) {
                    log('Using skeleton from localStorage (' + storageKey + '): ' + parsed.length + ' items');
                    // Also set window globals for consistency
                    window.manualSkeleton = parsed;
                    window.dailyOverrideSkeleton = parsed;
                    return parsed;
                }
            }
        } catch (e) {
            log('Failed to load skeleton from localStorage:', e);
        }
        
        // Priority 3: app1 globals
        try {
            const app1 = window.app1 || window.loadGlobalSettings?.()?.app1;
            if (app1?.dailySkeletons?.[dateKey]?.length > 0) {
                log('Using skeleton from app1.dailySkeletons: ' + app1.dailySkeletons[dateKey].length + ' items');
                return app1.dailySkeletons[dateKey];
            }
        } catch (e) {
            log('Failed to load from app1:', e);
        }
        
        log('WARNING: No skeleton found from any source!');
        return [];
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
            
            // ★★★ FIX v1.1: Fallback if skeleton parameter is empty ★★★
            if (!manualSkeleton || manualSkeleton.length === 0) {
                log('Skeleton parameter empty, checking fallbacks...');
                manualSkeleton = getSkeletonFromAnySource();
            }
            
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
                if (newSlot.startMin === startMin) {
                    window.scheduleAssignments[bunk][newIdx] = assignment;
                    log(`  Migrated slot ${oldIdx} → ${newIdx} (${startMin} min)`);
                    break;
                }
            }
        });
    }

    // =========================================================================
    // PATCH: UTILS FUNCTIONS
    // =========================================================================

    function patchUtilsFunctions() {
        log('Patching utility functions...');

        const patchUtils = () => {
            const Utils = window.SchedulerCoreUtils || window.Utils;
            if (!Utils) {
                setTimeout(patchUtils, 100);
                return;
            }

            const originalFindSlotsForRange = Utils.findSlotsForRange;

            Utils.findSlotsForRange = function(startMin, endMin, divisionNameOrBunk) {
                if (startMin === null || endMin === null) return [];

                // Try to use division-aware logic
                if (divisionNameOrBunk && window.divisionTimes) {
                    let divName = divisionNameOrBunk;
                    
                    // Check if it's a bunk name, get division
                    const divisions = window.divisions || {};
                    for (const [dName, dData] of Object.entries(divisions)) {
                        if (dData.bunks?.includes(divisionNameOrBunk)) {
                            divName = dName;
                            break;
                        }
                    }
                    
                    const divSlots = window.divisionTimes[divName];
                    if (divSlots && divSlots.length > 0) {
                        const result = [];
                        for (let i = 0; i < divSlots.length; i++) {
                            const slot = divSlots[i];
                            // Check for overlap
                            if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                                result.push(i);
                            }
                        }
                        
                        return result;
                    }
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
                    // Ensure block has divName for slot calculation
                    block.divName = divName;
                    
                    // ★★★ FIX: Use division-specific slot count ★★★
                    const divSlots = window.divisionTimes[divName];
                    if (!window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = new Array(divSlots.length).fill(null);
                    }
                }

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
                        
                        log(`Restored divisionTimes: ${Object.keys(window.divisionTimes).length} divisions`);
                    }

                    return result;
                };
            }

            log('✅ Patched ScheduleDB');
        };

        waitForScheduleDB();
    }

    // =========================================================================
    // PATCH: LOCAL STORAGE
    // =========================================================================

    function patchLocalStorage() {
        log('Patching localStorage handlers...');

        // Patch saveCurrentDailyData if it exists
        const originalSaveCurrentDailyData = window.saveCurrentDailyData;

        if (typeof originalSaveCurrentDailyData === 'function') {
            window.saveCurrentDailyData = function(key, value) {
                // If saving full data, include divisionTimes
                if (key === undefined && typeof value === 'object') {
                    value.divisionTimes = window.DivisionTimesSystem?.serialize(window.divisionTimes) || {};
                }
                
                return originalSaveCurrentDailyData.call(this, key, value);
            };
        }

        // Patch loadCurrentDailyData if it exists
        const originalLoadCurrentDailyData = window.loadCurrentDailyData;

        if (typeof originalLoadCurrentDailyData === 'function') {
            window.loadCurrentDailyData = function() {
                const result = originalLoadCurrentDailyData ? 
                    originalLoadCurrentDailyData.call(this) : {};

                // If divisionTimes exists in loaded data, restore it
                if (result?.divisionTimes) {
                    window.divisionTimes = window.DivisionTimesSystem?.deserialize(result.divisionTimes) || {};
                    log('Restored divisionTimes from localStorage');
                }

                return result;
            };
        }

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
                    const skeleton = getSkeletonFromAnySource();
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
        window.checkCrossDivisionConflict = function(bunk, slotIndex, fieldName) {
            const divName = window.DivisionTimesSystem?.getDivisionForBunk(bunk);
            if (!divName) return { conflict: false };

            const slot = window.divisionTimes?.[divName]?.[slotIndex];
            if (!slot) return { conflict: false };

            const startMin = slot.startMin;
            const endMin = slot.endMin;

            // Check all other divisions for overlapping time slots using this field
            const conflicts = [];
            const divisions = window.divisions || {};

            for (const [otherDiv, divData] of Object.entries(divisions)) {
                if (otherDiv === divName) continue;

                const otherSlots = window.divisionTimes?.[otherDiv] || [];
                for (let i = 0; i < otherSlots.length; i++) {
                    const otherSlot = otherSlots[i];
                    
                    // Check time overlap
                    if (otherSlot.startMin < endMin && otherSlot.endMin > startMin) {
                        // Time overlaps - check if any bunk in this division uses the same field
                        for (const otherBunk of (divData.bunks || [])) {
                            const assignment = window.scheduleAssignments?.[otherBunk]?.[i];
                            if (assignment?.field === fieldName) {
                                conflicts.push({
                                    division: otherDiv,
                                    bunk: otherBunk,
                                    slot: i,
                                    time: `${otherSlot.startMin}-${otherSlot.endMin}`
                                });
                            }
                        }
                    }
                }
            }

            return {
                conflict: conflicts.length > 0,
                conflicts
            };
        };

        log('✅ Cross-division conflict detection ready');
    }

    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    function setupDiagnostics() {
        window.DivisionTimesIntegration = {
            version: VERSION,
            
            // Full diagnostic
            diagnose: () => {
                console.log('\n' + '═'.repeat(70));
                console.log('📊 DIVISION TIMES INTEGRATION DIAGNOSTIC v' + VERSION);
                console.log('═'.repeat(70));

                // Check skeleton sources
                console.log('\n=== SKELETON SOURCES ===');
                console.log('window.manualSkeleton:', window.manualSkeleton?.length || 'empty');
                console.log('window.dailyOverrideSkeleton:', window.dailyOverrideSkeleton?.length || 'empty');
                const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                const storageKey = 'campManualSkeleton_' + dateKey;
                try {
                    const stored = localStorage.getItem(storageKey);
                    const parsed = stored ? JSON.parse(stored) : null;
                    console.log('localStorage (' + storageKey + '):', parsed?.length || 'empty');
                } catch(e) {
                    console.log('localStorage: error reading');
                }

                // Check divisionTimes
                console.log('\n=== DIVISION TIMES ===');
                const divisionTimes = window.divisionTimes || {};
                Object.entries(divisionTimes).forEach(([div, slots]) => {
                    console.log(`  ${div}: ${slots.length} slots`);
                });

                // Check scheduleAssignments alignment
                console.log('\n=== SCHEDULE ASSIGNMENTS ALIGNMENT ===');
                const divisions = window.divisions || {};
                Object.entries(divisions).forEach(([divName, divData]) => {
                    const expected = divisionTimes[divName]?.length || 0;
                    const sample = divData.bunks?.[0];
                    const actual = window.scheduleAssignments?.[sample]?.length || 0;
                    const status = actual === expected ? '✅' : '❌';
                    console.log(`  ${divName}: ${actual}/${expected} ${status}`);
                });

                console.log('\n=== BACKWARDS COMPAT:');
                console.log(`   window.unifiedTimes: ${(window.unifiedTimes || []).length} virtual slots`);
                console.log(`   window.divisionTimes: ${Object.keys(window.divisionTimes || {}).length} divisions`);

                console.log('\n' + '═'.repeat(70));
            },

            // Force rebuild from skeleton
            rebuild: () => {
                const skeleton = getSkeletonFromAnySource();
                const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
                
                if (skeleton.length === 0) {
                    console.warn('Cannot rebuild: No skeleton found from any source');
                    return false;
                }
                
                window.divisionTimes = window.DivisionTimesSystem?.buildFromSkeleton(skeleton, divisions) || {};
                window.unifiedTimes = window.DivisionTimesSystem?.buildUnifiedTimesFromDivisionTimes() || [];
                
                // Also fix any misaligned scheduleAssignments
                Object.entries(divisions).forEach(([divName, divData]) => {
                    const expected = window.divisionTimes[divName]?.length || 0;
                    (divData.bunks || []).forEach(bunk => {
                        const current = window.scheduleAssignments?.[bunk];
                        if (current && current.length > expected) {
                            window.scheduleAssignments[bunk] = current.slice(0, expected);
                            console.log('Trimmed ' + bunk + ' to ' + expected + ' slots');
                        } else if (!current) {
                            window.scheduleAssignments[bunk] = new Array(expected).fill(null);
                        }
                    });
                });
                
                console.log('✅ Rebuilt divisionTimes from skeleton');
                window.DivisionTimesSystem?.diagnose?.();
                return true;
            },

            // Check a specific field's availability
            checkField: (fieldName, startMin, endMin) => {
                if (window.fieldUsageTracker) {
                    const result = window.fieldUsageTracker.checkAvailability(fieldName, startMin, endMin);
                    console.log(`Field "${fieldName}" at ${startMin}-${endMin}:`, result);
                    return result;
                }
            },
            
            // Get skeleton from any source (exposed for debugging)
            getSkeletonFromAnySource
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

        // Auto-rebuild if skeleton exists but divisionTimes is empty
        setTimeout(() => {
            const skeleton = getSkeletonFromAnySource();
            if (skeleton.length > 0 && 
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
    console.log('   v1.1 FIX: Skeleton parameter fallback to window/localStorage');
    console.log('');
    console.log('   Commands:');
    console.log('   - DivisionTimesIntegration.diagnose()  → Full diagnostic');
    console.log('   - DivisionTimesIntegration.rebuild()   → Force rebuild from skeleton');
    console.log('   - DivisionTimesIntegration.checkField("Basketball", 660, 720)');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');

})();
