// =============================================================================
// division_times_integration.js v1.3.1 — INTEGRATION LAYER
// =============================================================================
//
// v1.3.1 CHANGES:
// - ★★★ FIX: Lock divisionTimes during generation to prevent localStorage
//   restores from overwriting the freshly-built split-aware slot structure.
//   This was causing "No slots found for range" on split tiles and
//   mis-indexed pinned events (missing Lunch, Snacks, etc.)
//
// v1.3 CHANGES:
// - REMOVED unifiedTimes build (fully division-aware)
// - REMOVED patches for Utils, fillBlock, and ScheduleDB (now handled natively)
// - Retained scheduler core patch for skeleton optimization
// - Retained localStorage patch for division times persistence
//
// LOAD ORDER:
// 1. division_times_system.js (core)
// 2. division_times_integration.js (this file)
// 3. Then existing files (scheduler_core_main.js, unified_schedule_system.js, etc.)
//
// =============================================================================

(function() {
    'use strict';

    const VERSION = '1.3.1';
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
            
            // ★★★ INITIALIZE SCHEDULE ASSIGNMENTS PER DIVISION ★★★
            // ★★★ FIX v1.4: Only blank divisions being generated ★★★
            window.scheduleAssignments = window.scheduleAssignments || {};
            
            // Determine which divisions are being generated
            const generatingDivisions = new Set(
                (allowedDivisions || Object.keys(divisions)).map(String)
            );
            
            Object.entries(divisions).forEach(([divName, divData]) => {
                const divSlots = window.DivisionTimesSystem.getSlotsForDivision(divName);
                const slotCount = divSlots.length;
                const isBeingGenerated = generatingDivisions.has(String(divName));
                
                (divData.bunks || []).forEach(bunk => {
                    if (isBeingGenerated) {
                        // Being generated — fresh array
                        window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                    } else if (!window.scheduleAssignments[bunk]) {
                        // Not being generated but doesn't exist — create empty
                        window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                    } else if (window.scheduleAssignments[bunk].length !== slotCount && slotCount > 0) {
                        // Not being generated, wrong size — resize but PRESERVE data
                        const old = window.scheduleAssignments[bunk];
                        const resized = new Array(slotCount).fill(null);
                        for (let i = 0; i < Math.min(old.length, slotCount); i++) {
                            resized[i] = old[i];
                        }
                        window.scheduleAssignments[bunk] = resized;
                    }
                    // else: correct size, not being generated — leave untouched
                });
            });
            // ★★★ RESET FIELD USAGE TRACKER ★★★
            if (window.fieldUsageTracker) {
                window.fieldUsageTracker.clear();
            }

            log('Division times setup complete. Calling original optimizer...');
            
            // ★★★ v1.3.1 FIX: Lock divisionTimes during generation ★★★
            // Without this, every loadCurrentDailyData call inside the optimizer
            // overwrites the freshly-built divisionTimes (which has split-half slots)
            // with the stale localStorage copy (which doesn't), causing
            // "No slots found for range" errors on split tiles and mis-indexed pins.
            window._divisionTimesLocked = true;
            
            try {
                // Call original optimizer
                if (originalRunSkeletonOptimizer) {
                    return originalRunSkeletonOptimizer.call(this, manualSkeleton, externalOverrides, allowedDivisions, existingScheduleSnapshot, existingUnifiedTimes);
                }
            } finally {
                window._divisionTimesLocked = false;
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

                // ★★★ v1.3.1 FIX: Don't overwrite divisionTimes during generation ★★★
                // During schedule generation, divisionTimes is freshly built with
                // proper split-half slots. The localStorage version is stale and
                // lacks split expansion, so restoring it mid-generation breaks
                // slot lookups for split tiles and causes mis-indexed pinned events.
                if (result?.divisionTimes && !window._divisionTimesLocked) {
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
        // patchUtilsFunctions(); // Removed: Handled natively by Utils
        // patchFillBlock(); // Removed: Handled natively
        // patchCloudStorage(); // Removed: Handled natively
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
    console.log('   - localStorage handlers (with generation lock)');
    console.log('   - updateTable (syncs before render)');
    console.log('');
    console.log('   v1.3.1: ★ divisionTimes locked during generation ★');
    console.log('   REMOVED: Utils, fillBlock, ScheduleDB patches (native support enabled)');
    console.log('');
    console.log('   Commands:');
    console.log('   - DivisionTimesIntegration.diagnose()  → Full diagnostic');
    console.log('   - DivisionTimesIntegration.rebuild()   → Force rebuild from skeleton');
    console.log('   - DivisionTimesIntegration.checkField("Basketball", 660, 720)');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');

})();
