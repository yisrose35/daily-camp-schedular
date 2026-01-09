// ============================================================================
// scheduler_subdivision_integration.js (v1.4 - CORRECT STORAGE LOCATION)
// ============================================================================
// Integrates multi-scheduler functionality with the core schedule generator.
// 
// KEY FIX in v1.4:
// - Saves scheduleAssignments INSIDE the date key, not at root level
// - Structure: campDailyData_v1[dateKey].scheduleAssignments
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
    // ★★★ CRITICAL FIX: SAVE TO CORRECT LOCATION ★★★
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
            
            // ★★★ CRITICAL: Initialize the DATE KEY object, not root ★★★
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = {};
            }
            
            // ★★★ CRITICAL: Save INSIDE the date key ★★★
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
        return async function integratedRunSkeletonOptimizer(skeleton, options = {}) {
            const role = window.AccessControl?.getCurrentRole?.();
            const isOwner = role === 'owner' || role === 'admin';

            const SSM = window.SubdivisionScheduleManager;
            
            // Protect local data before starting
            if (typeof window.protectLocalData === 'function') {
                window.protectLocalData();
            }
            
            if (SSM?.isInitialized) {
                console.log('\n' + '='.repeat(70));
                console.log('★★★ MULTI-SCHEDULER MODE ACTIVE ★★★');
                console.log('='.repeat(70));

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

                const otherLocked = SSM.getOtherLockedSubdivisions();
                console.log(`[Integration] ${otherLocked.length} other subdivision(s) have locked/draft schedules`);

                const originalLength = skeleton?.length || 0;
                const filteredSkeleton = filterSkeletonByDivisions(skeleton, divisionsToSchedule);
                console.log(`[Integration] Filtered skeleton: ${filteredSkeleton.length} blocks (from ${originalLength})`);

                // Load existing schedule data
                await loadExistingSchedule();

                // Clear only our bunks
                const ourBunks = filterBunksByDivisions(divisionsToSchedule);
                clearOurBunksOnly(ourBunks);

                console.log('\n[Integration] Pre-generation setup...');
                
                console.log('[Integration] Restoring locked schedules...');
                const restoredCount = SSM.restoreLockedSchedules();
                
                console.log('[Integration] Registering locked claims in GlobalFieldLocks...');
                SSM.registerLockedClaimsInGlobalLocks();
                
                console.log('[Integration] Calculating smart resource allocation...');
                const slots = getUniqueSlots(filteredSkeleton);
                const allocation = SSM.getSmartResourceAllocation(slots);
                
                if (Object.keys(allocation).length > 0) {
                    console.log('[Integration] Smart allocation recommendations:');
                    for (const [resource, info] of Object.entries(allocation)) {
                        if (info.fairShare > 0) {
                            console.log(`  ${resource}: use ${info.fairShare}/${info.totalAvailable}`);
                        }
                    }
                }

                // Run the actual optimizer
                await originalOptimizer(filteredSkeleton, {
                    ...options,
                    divisionsToSchedule,
                    resourceAllocation: allocation
                });

                // Post-generation cleanup
                console.log('\n[Integration] Post-generation cleanup...');
                
                // ★★★ SAVE TO CORRECT LOCATION ★★★
                saveScheduleToLocalStorage();
                
                // Mark subdivisions as draft
                SSM.markCurrentUserSubdivisionsAsDraft();
                
                console.log('[Integration] Schedule generation complete');

            } else {
                // Standard mode
                console.log('[Integration] Standard mode (no subdivision system)');
                await originalOptimizer(skeleton, options);
                
                // Save to localStorage
                saveScheduleToLocalStorage();
                
                // Unprotect in standard mode
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
            
            // ★★★ Load from INSIDE the date key ★★★
            const dateData = dailyData[dateKey];
            
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
            
            // Also load skeleton if available
            if (dateData?.skeleton) {
                window.skeleton = dateData.skeleton;
            }
        } catch (e) {
            console.warn('[Integration] Error loading existing schedule:', e);
        }
    }

    // =========================================================================
    // HELPER: Clear only our bunks
    // =========================================================================

    function clearOurBunksOnly(ourBunks) {
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
            return;
        }
        
        for (const bunk of ourBunks) {
            if (window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = [];
            }
        }
        
        console.log(`[Integration] Cleared ${ourBunks.size} bunks for regeneration`);
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
                // ★★★ Load from INSIDE the date key ★★★
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
        saveScheduleToLocalStorage,
        
        debugState: function() {
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            console.log('\n=== Scheduler Integration State ===');
            console.log('Hooked:', _isHooked);
            console.log('Current Date:', dateKey);
            console.log('window.scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
            
            // Check localStorage structure
            try {
                const raw = localStorage.getItem(DAILY_DATA_KEY);
                if (raw) {
                    const data = JSON.parse(raw);
                    console.log('localStorage root keys:', Object.keys(data));
                    if (data[dateKey]) {
                        console.log(`localStorage[${dateKey}] keys:`, Object.keys(data[dateKey]));
                        if (data[dateKey].scheduleAssignments) {
                            console.log(`localStorage[${dateKey}].scheduleAssignments:`, Object.keys(data[dateKey].scheduleAssignments).length, 'bunks');
                        }
                    }
                }
            } catch(e) {}
            
            const SSM = window.SubdivisionScheduleManager;
            if (SSM?.isInitialized) {
                console.log('SubdivisionScheduleManager: initialized');
                console.log('Divisions to schedule:', SSM.getDivisionsToSchedule());
            }
        }
    };

    if (document.readyState === 'complete') {
        installHooks();
    } else {
        window.addEventListener('load', installHooks);
    }

    setTimeout(installHooks, 100);

    console.log('[SchedulerSubdivisionIntegration] Module loaded v1.4 (CORRECT STORAGE LOCATION)');

})();
