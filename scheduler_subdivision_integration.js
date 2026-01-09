// ============================================================================
// scheduler_subdivision_integration.js (v1.2 - PROPER LOCAL STORAGE SAVE)
// ============================================================================
// Integrates multi-scheduler functionality with the core schedule generator.
// This file hooks into the existing runSkeletonOptimizer and adds:
// 1. Division filtering (only schedule divisions the user has access to)
// 2. Background schedule restoration (restore other schedulers' locked work)
// 3. Field lock enforcement (respect locked schedules' field usage)
// 4. ★★★ PROPER LOCAL STORAGE SAVE after generation ★★★
// ============================================================================

(function() {
    'use strict';

    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    // Store original functions
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
    // ★★★ CRITICAL: SAVE SCHEDULE TO LOCALSTORAGE ★★★
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
            
            // Initialize date entry if needed
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = {};
            }
            
            // Deep copy scheduleAssignments
            dailyData[dateKey].scheduleAssignments = JSON.parse(JSON.stringify(window.scheduleAssignments));
            
            // Also save skeleton if available
            if (window.skeleton && window.skeleton.length > 0) {
                dailyData[dateKey].skeleton = JSON.parse(JSON.stringify(window.skeleton));
            }
            
            // Save to localStorage
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
            
            const bunkCount = Object.keys(window.scheduleAssignments).length;
            console.log(`[Integration] 💾 Saved ${bunkCount} bunks to localStorage`);
            
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

            // Always run in multi-scheduler mode (even for owners, for consistency)
            const SSM = window.SubdivisionScheduleManager;
            
            if (SSM?.isInitialized) {
                console.log('\n' + '='.repeat(70));
                console.log('★★★ MULTI-SCHEDULER MODE ACTIVE ★★★');
                console.log('='.repeat(70));

                // Step 1: Determine which divisions to schedule
                const divisionsToSchedule = SSM.getDivisionsToSchedule();
                
                if (divisionsToSchedule.length === 0) {
                    console.warn('[Integration] No divisions to schedule!');
                    alert('You have no divisions assigned to schedule. Please contact your camp admin.');
                    return;
                }

                console.log('[Integration] Divisions to schedule:', divisionsToSchedule.join(', '));

                // Step 2: Check for other locked/draft subdivisions
                const otherLocked = SSM.getOtherLockedSubdivisions();
                console.log(`[Integration] ${otherLocked.length} other subdivision(s) have locked/draft schedules`);

                // Step 3: Filter skeleton to only include relevant divisions
                const originalLength = skeleton?.length || 0;
                const filteredSkeleton = filterSkeletonByDivisions(skeleton, divisionsToSchedule);
                console.log(`[Integration] Filtered skeleton: ${filteredSkeleton.length} blocks (from ${originalLength})`);

                // Step 4: Initialize scheduleAssignments with existing data
                // ★★★ CRITICAL: Load existing data first
                await loadExistingSchedule();

                // Step 5: Clear ONLY our bunks, preserve others
                const ourBunks = filterBunksByDivisions(divisionsToSchedule);
                clearOurBunksOnly(ourBunks);

                // Step 6: Pre-generation setup
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

                // Step 7: Run the actual optimizer with filtered skeleton
                await originalOptimizer(filteredSkeleton, {
                    ...options,
                    divisionsToSchedule,
                    resourceAllocation: allocation
                });

                // Step 8: Post-generation cleanup
                console.log('\n[Integration] Post-generation cleanup...');
                
                // ★★★ CRITICAL: Save to localStorage FIRST
                saveScheduleToLocalStorage();
                
                // Mark our subdivisions as draft
                SSM.markCurrentUserSubdivisionsAsDraft();
                
                console.log('[Integration] Schedule generation complete');

            } else {
                // Fallback to standard mode
                console.log('[Integration] Standard mode (no subdivision system)');
                await originalOptimizer(skeleton, options);
                
                // ★★★ Still save to localStorage
                saveScheduleToLocalStorage();
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
            const dateData = dailyData[dateKey];
            
            if (dateData?.scheduleAssignments) {
                // Initialize window.scheduleAssignments if needed
                if (!window.scheduleAssignments) {
                    window.scheduleAssignments = {};
                }
                
                // Merge existing data
                for (const [bunk, slots] of Object.entries(dateData.scheduleAssignments)) {
                    if (!window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = slots;
                    }
                }
                
                console.log(`[Integration] Loaded existing schedule: ${Object.keys(dateData.scheduleAssignments).length} bunks`);
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
        
        // Only clear bunks we own
        for (const bunk of ourBunks) {
            if (window.scheduleAssignments[bunk]) {
                // Mark as cleared but keep the array structure
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

        // Hook into runSkeletonOptimizer
        if (typeof window.runSkeletonOptimizer === 'function') {
            _originalRunOptimizer = window.runSkeletonOptimizer;
            window.runSkeletonOptimizer = createIntegratedOptimizer(_originalRunOptimizer);
            console.log('[Integration] Scheduler hooks installed for multi-scheduler support');
            _isHooked = true;
        } else {
            // Retry later
            setTimeout(installHooks, 500);
        }
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    // Listen for date changes
    window.addEventListener('schedule-date-changed', function(e) {
        const newDate = e.detail?.date;
        if (newDate) {
            console.log('[Integration] Date changed to:', newDate);
            // Reinitialize SubdivisionScheduleManager for new date
            if (window.SubdivisionScheduleManager?.initialize) {
                window.currentScheduleDate = newDate;
                window.SubdivisionScheduleManager.initialize();
            }
        }
    });

    // Listen for UI refresh requests
    window.addEventListener('campistry-daily-data-updated', function() {
        // Reload from localStorage
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
        saveScheduleToLocalStorage,
        
        // Debug
        debugState: function() {
            console.log('\n=== Scheduler Integration State ===');
            console.log('Hooked:', _isHooked);
            console.log('Current Date:', window.currentScheduleDate);
            console.log('scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
            
            const SSM = window.SubdivisionScheduleManager;
            if (SSM?.isInitialized) {
                console.log('SubdivisionScheduleManager: initialized');
                console.log('Divisions to schedule:', SSM.getDivisionsToSchedule());
                console.log('Other locked:', SSM.getOtherLockedSubdivisions().map(s => s.subdivisionName));
            }
        }
    };

    // Install hooks when ready
    if (document.readyState === 'complete') {
        installHooks();
    } else {
        window.addEventListener('load', installHooks);
    }

    // Also try immediately
    setTimeout(installHooks, 100);

    console.log('[SchedulerSubdivisionIntegration] Module loaded v1.2 (with localStorage save)');

})();
