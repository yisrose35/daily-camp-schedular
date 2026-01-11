// ============================================================================
// scheduler_subdivision_integration.js (v1.5 - STRICT OVERWRITE + STORAGE FIX)
// ============================================================================
// Integrates multi-scheduler functionality with the core schedule generator.
// 
// UPDATES v1.5:
// - Enforces strict overwrite on generation (Owner = All, Scheduler = Theirs).
// - Fixes argument passing from UI to Core (handles 4-arg signature).
// - Passes 'null' snapshot to core to prevent "stickiness" of old data.
// - Maintains v1.4 correct storage location fix (campDailyData_v1[dateKey]).
// ============================================================================

(function() {
    'use strict';

    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    let _originalRunOptimizer = null;
    let _isHooked = false;

    // =========================================================================
    // SKELETON FILTERING
    // =========================================================================

    function filterSkeletonByDivisions(skeleton, allowedDivisions) {
        if (!skeleton || !Array.isArray(skeleton)) return [];
        if (!allowedDivisions || allowedDivisions.length === 0) return skeleton;

        const allowedSet = new Set(allowedDivisions.map(String));

        return skeleton.filter(block => {
            if (!block.divisions || block.divisions.length === 0) {
                return true;
            }

            return block.divisions.some(d => allowedSet.has(String(d)));
        });
    }

    function filterBunksByDivisions(allowedDivisions) {
        const allDivisions = window.divisions || {};
        const allowedBunks = new Set();

        (allowedDivisions || []).forEach(divName => {
            const divInfo = allDivisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => allowedBunks.add(b));
            }
        });

        return allowedBunks;
    }

    // =========================================================================
    // STORAGE MANAGEMENT (v1.4 Logic)
    // =========================================================================

    function saveScheduleToLocalStorage() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
            console.log('[Integration] No scheduleAssignments to save');
            return;
        }
        
        console.log(`[Integration] 💾 Saving scheduleAssignments for ${dateKey}...`);
        
        try {
            // Load existing daily data
            let dailyData = {};
            try {
                const raw = localStorage.getItem(DAILY_DATA_KEY);
                if (raw) dailyData = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            
            // Initialize the DATE KEY object if missing
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = {};
            }
            
            // Save INSIDE the date key
            dailyData[dateKey].scheduleAssignments = JSON.parse(JSON.stringify(window.scheduleAssignments));
            
            // Also save skeleton inside the date key
            if (window.skeleton && window.skeleton.length > 0) {
                dailyData[dateKey].skeleton = JSON.parse(JSON.stringify(window.skeleton));
            }
            
            // Save to localStorage
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
            
            const bunkCount = Object.keys(window.scheduleAssignments).length;
            console.log(`[Integration] 💾 Saved ${bunkCount} bunks to localStorage[${dateKey}].scheduleAssignments`);
            
            // Verify the save
            const verifyRaw = localStorage.getItem(DAILY_DATA_KEY);
            const verifyData = JSON.parse(verifyRaw);
            if (verifyData[dateKey]?.scheduleAssignments) {
                console.log(`[Integration] ✅ Verified: ${Object.keys(verifyData[dateKey].scheduleAssignments).length} bunks saved correctly`);
            } else {
                console.error('[Integration] ❌ Verification failed - data not found at correct path!');
            }
            
        } catch (e) {
            console.error('[Integration] Error saving to localStorage:', e);
        }
    }

    // =========================================================================
    // MAIN INTEGRATION WRAPPER
    // =========================================================================

    function createIntegratedOptimizer(originalOptimizer) {
        // Updated signature to handle variable arguments from UI (v1.5)
        // arg2: usually overrides or options object
        // arg3: usually allowedDivisions
        // arg4: usually snapshot
        return async function integratedRunSkeletonOptimizer(skeleton, arg2, arg3, arg4) {
            const role = window.AccessControl?.getCurrentRole?.();
            const SSM = window.SubdivisionScheduleManager;
            
            // Protect local data before starting
            if (typeof window.protectLocalData === 'function') {
                window.protectLocalData();
            }
            
            if (SSM?.isInitialized) {
                console.log('\n' + '='.repeat(70));
                console.log('★★★ MULTI-SCHEDULER MODE ACTIVE (STRICT OVERWRITE) ★★★');
                console.log('='.repeat(70));

                // 1. Determine Scope
                const divisionsToSchedule = SSM.getDivisionsToSchedule();
                
                if (divisionsToSchedule.length === 0) {
                    console.warn('[Integration] No divisions to schedule!');
                    alert('You have no divisions assigned to schedule. Please contact your camp admin.');
                    if (typeof window.unprotectLocalData === 'function') {
                        window.unprotectLocalData();
                    }
                    return;
                }

                console.log('[Integration] Divisions to schedule:', divisionsToSchedule.join(', '));
                
                // 2. Filter Skeleton (Workload)
                const originalLength = skeleton?.length || 0;
                const filteredSkeleton = filterSkeletonByDivisions(skeleton, divisionsToSchedule);
                console.log(`[Integration] Filtered skeleton: ${filteredSkeleton.length} blocks (from ${originalLength})`);

                // 3. Load Base State (Full Schedule context)
                await loadExistingSchedule();

                // 4. Wipe The Slate Clean (Overwrite Step)
                // We clear ONLY the bunks we are about to schedule.
                // For Owners: This clears everything.
                // For Schedulers: This clears only their bunks.
                const ourBunks = filterBunksByDivisions(divisionsToSchedule);
                clearOurBunksOnly(ourBunks);

                console.log('\n[Integration] Pre-generation setup...');
                
                // 5. Restore Context (Other People's Work)
                console.log('[Integration] Restoring locked schedules...');
                // For Schedulers: Puts other subdivisions' data back into window.scheduleAssignments as LOCKED
                const restoredCount = SSM.restoreLockedSchedules();
                
                // 6. Register Locks
                console.log('[Integration] Registering locked claims in GlobalFieldLocks...');
                SSM.registerLockedClaimsInGlobalLocks();
                
                // 7. Resource Allocation
                console.log('[Integration] Calculating smart resource allocation...');
                const slots = getUniqueSlots(filteredSkeleton);
                const allocation = SSM.getSmartResourceAllocation(slots);

                // 8. Run Core Optimizer
                // CRITICAL: We pass 'null' for snapshot to force the core to generate fresh.
                // We do NOT want it to try and "merge" with old data for the active divisions.
                
                try {
                    // Check signature style
                    if (arg2 && !Array.isArray(arg2) && typeof arg2 === 'object' && !arg3) {
                        // Options object signature
                        await originalOptimizer(filteredSkeleton, {
                            ...arg2,
                            divisionsToSchedule,
                            resourceAllocation: allocation
                        });
                    } else {
                        // Standard 4-arg signature: (skeleton, overrides, allowedDivisions, snapshot)
                        // arg2 = overrides
                        // arg3 = allowedDivisions (ignored, we use our calculated one)
                        // arg4 = snapshot (ignored, forced to null)
                        
                        await originalOptimizer(
                            filteredSkeleton, 
                            arg2, 
                            divisionsToSchedule, 
                            null // <--- FORCE OVERWRITE (Ignore previous UI snapshot)
                        );
                    }
                } catch (e) {
                    console.error("[Integration] Optimization failed:", e);
                    alert("Optimization failed. See console.");
                    return;
                }

                // 9. Save Result
                console.log('\n[Integration] Post-generation cleanup...');
                saveScheduleToLocalStorage();
                
                // 10. Mark Draft Status
                SSM.markCurrentUserSubdivisionsAsDraft();
                
                console.log('[Integration] Schedule generation complete');

            } else {
                // Standard mode (Single Scheduler / No RBAC)
                console.log('[Integration] Standard mode (Full Overwrite)');
                
                // Pass through but ensure null snapshot for consistency in overwrite behavior
                if (arg2 && !Array.isArray(arg2) && typeof arg2 === 'object' && !arg3) {
                    await originalOptimizer(skeleton, arg2);
                } else {
                    await originalOptimizer(skeleton, arg2, arg3, null);
                }
                
                saveScheduleToLocalStorage();
                
                if (typeof window.unprotectLocalData === 'function') {
                    setTimeout(() => {
                        window.unprotectLocalData();
                    }, 3000);
                }
            }
        };
    }

    // =========================================================================
    // HELPER: Load existing schedule from localStorage
    // =========================================================================

    async function loadExistingSchedule() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return;
            
            const dailyData = JSON.parse(raw);
            const dateData = dailyData[dateKey]; // Load from inside date key
            
            if (dateData?.scheduleAssignments) {
                if (!window.scheduleAssignments) {
                    window.scheduleAssignments = {};
                }
                
                for (const [bunk, slots] of Object.entries(dateData.scheduleAssignments)) {
                    if (!window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = slots;
                    }
                }
                console.log(`[Integration] Loaded existing schedule: ${Object.keys(dateData.scheduleAssignments).length} bunks`);
            }
            
            if (dateData?.skeleton) {
                window.skeleton = dateData.skeleton;
            }
        } catch (e) {
            console.warn('[Integration] Error loading existing schedule:', e);
        }
    }

    // =========================================================================
    // HELPER: Clear only our bunks (The Eraser - v1.5)
    // =========================================================================

    function clearOurBunksOnly(ourBunks) {
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
            return;
        }
        
        let clearedCount = 0;
        for (const bunk of ourBunks) {
            if (window.scheduleAssignments[bunk]) {
                // Completely wipe the array to ensure no residual data
                window.scheduleAssignments[bunk] = [];
                clearedCount++;
            }
        }
        
        console.log(`[Integration] 🧹 Cleared ${clearedCount} bunks for FRESH generation`);
    }

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    function getUniqueSlots(skeleton) {
        const slots = new Set();
        (skeleton || []).forEach(block => {
            const slotIdx = Math.floor((block.startTime - 540) / 60);
            if (slotIdx >= 0) slots.add(slotIdx);
        });
        return [...slots];
    }

    // =========================================================================
    // HOOK INSTALLATION
    // =========================================================================

    function installHooks() {
        if (_isHooked) return;

        if (typeof window.runSkeletonOptimizer === 'function') {
            _originalRunOptimizer = window.runSkeletonOptimizer;
            window.runSkeletonOptimizer = createIntegratedOptimizer(_originalRunOptimizer);
            console.log('[Integration] Scheduler hooks installed for multi-scheduler support');
            _isHooked = true;
        } else {
            setTimeout(installHooks, 500);
        }
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    window.addEventListener('schedule-date-changed', function(e) {
        const newDate = e.detail?.date;
        if (newDate) {
            console.log('[Integration] Date changed to:', newDate);
            if (window.SubdivisionScheduleManager?.initialize) {
                window.currentScheduleDate = newDate;
                window.SubdivisionScheduleManager.initialize();
            }
        }
    });

    window.addEventListener('campistry-daily-data-updated', function() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) {
                const dailyData = JSON.parse(raw);
                const dateData = dailyData[dateKey];
                if (dateData?.scheduleAssignments) {
                    window.scheduleAssignments = dateData.scheduleAssignments;
                    console.log('[Integration] Reloaded scheduleAssignments from localStorage');
                }
            }
        } catch (e) {
            console.warn('[Integration] Error reloading:', e);
        }
    });

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.SchedulerSubdivisionIntegration = {
        get isHooked() { return _isHooked; },
        filterSkeletonByDivisions,
        filterBunksByDivisions,
        saveScheduleToLocalStorage
    };

    if (document.readyState === 'complete') {
        installHooks();
    } else {
        window.addEventListener('load', installHooks);
    }

    setTimeout(installHooks, 100);

    console.log('[SchedulerSubdivisionIntegration] Module loaded v1.5 (STRICT OVERWRITE + STORAGE FIX)');

})();
