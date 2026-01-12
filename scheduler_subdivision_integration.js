// ============================================================================
// scheduler_subdivision_integration.js (v2.2 - PASS UNIFIED TIMES)
// ============================================================================
// Updated to pass window.unifiedTimes to runSkeletonOptimizer
// ============================================================================

(function() {
    'use strict';

    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    let _originalRunOptimizer = null;
    let _isHooked = false;

    console.log('[Integration] Loading v2.2 (PASS UNIFIED TIMES)...');

    // =========================================================================
    // SKELETON FILTERING
    // =========================================================================

    function filterSkeletonByDivisions(skeleton, allowedDivisions) {
        if (!skeleton || !Array.isArray(skeleton)) return [];
        if (!allowedDivisions || allowedDivisions.length === 0) return skeleton;

        const allowedSet = new Set(allowedDivisions.map(String));

        return skeleton.filter(block => {
            // Include blocks with no division restriction
            if (!block.division && (!block.divisions || block.divisions.length === 0)) {
                return true;
            }

            // Check single division field
            if (block.division && allowedSet.has(String(block.division))) {
                return true;
            }

            // Check divisions array
            if (block.divisions && block.divisions.some(d => allowedSet.has(String(d)))) {
                return true;
            }

            return false;
        });
    }

    function getBunksForDivisions(divisions) {
        const allDivisions = window.divisions || {};
        const bunks = new Set();

        (divisions || []).forEach(divName => {
            const divInfo = allDivisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => bunks.add(b));
            }
        });

        return bunks;
    }

    // =========================================================================
    // STORAGE MANAGEMENT
    // =========================================================================

    function saveScheduleToLocalStorage(scheduleAssignments, myDivisions) {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        if (!scheduleAssignments || Object.keys(scheduleAssignments).length === 0) {
            console.log('[Integration] No scheduleAssignments to save');
            return;
        }
        
        console.log(`[Integration] 💾 Saving schedule for ${dateKey}...`);
        
        try {
            let dailyData = {};
            try {
                const raw = localStorage.getItem(DAILY_DATA_KEY);
                if (raw) dailyData = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = {};
            }
            
            // Save the full merged schedule
            dailyData[dateKey].scheduleAssignments = JSON.parse(JSON.stringify(scheduleAssignments));
            
            // Save skeleton if present
            if (window.skeleton && window.skeleton.length > 0) {
                dailyData[dateKey].skeleton = JSON.parse(JSON.stringify(window.skeleton));
            }
            
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
            
            const bunkCount = Object.keys(scheduleAssignments).length;
            console.log(`[Integration] 💾 Saved ${bunkCount} bunks to localStorage`);
            
        } catch (e) {
            console.error('[Integration] Error saving:', e);
        }
    }

    // =========================================================================
    // BLOCKED RESOURCES EXTRACTION
    // =========================================================================

    /**
     * Extract resources already used by OTHER schedulers
     * @param {Object} existingAssignments - Current scheduleAssignments from storage
     * @param {Set} myBunks - Bunks belonging to current user's divisions
     * @returns {Object} - { slotIndex: { resourceName: usageCount } }
     */
    function extractBlockedResources(existingAssignments, myBunks) {
        const blocked = {};

        for (const [bunk, slots] of Object.entries(existingAssignments || {})) {
            // Skip MY bunks - only track OTHER schedulers' usage
            if (myBunks.has(bunk)) {
                continue;
            }

            if (!Array.isArray(slots)) continue;

            slots.forEach((slot, slotIdx) => {
                if (slot && !slot.continuation) {
                    const resourceName = slot.field || slot._activity;
                    
                    if (resourceName && resourceName !== 'Free' && resourceName !== 'free') {
                        if (!blocked[slotIdx]) blocked[slotIdx] = {};
                        if (!blocked[slotIdx][resourceName]) {
                            blocked[slotIdx][resourceName] = { count: 0, bunks: [] };
                        }
                        blocked[slotIdx][resourceName].count++;
                        blocked[slotIdx][resourceName].bunks.push(bunk);
                    }
                }
            });
        }

        return blocked;
    }

    /**
     * Register blocked resources in GlobalFieldLocks
     */
    function registerBlockedInGlobalLocks(blockedResources, activityProperties) {
        if (!window.GlobalFieldLocks) {
            console.warn('[Integration] GlobalFieldLocks not available');
            return;
        }

        window.GlobalFieldLocks.reset();
        let lockedCount = 0;

        for (const [slotIdx, resources] of Object.entries(blockedResources)) {
            for (const [resourceName, usage] of Object.entries(resources)) {
                // Get capacity for this resource
                const props = activityProperties[resourceName] || {};
                let maxCapacity = 1;
                
                if (props.sharableWith?.capacity) {
                    maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                } else if (props.sharable || props.sharableWith?.type === 'all') {
                    maxCapacity = 2;
                }

                // If at or over capacity, lock it
                if (usage.count >= maxCapacity) {
                    window.GlobalFieldLocks.lockField(resourceName, [parseInt(slotIdx)], {
                        lockedBy: 'other_scheduler',
                        activity: `Used by: ${usage.bunks.join(', ')}`,
                        division: 'external'
                    });
                    lockedCount++;
                }
            }
        }

        console.log(`[Integration] 🔒 Registered ${lockedCount} blocked slots in GlobalFieldLocks`);
    }

    // =========================================================================
    // MAIN INTEGRATION WRAPPER
    // =========================================================================

    function createIntegratedOptimizer(originalOptimizer) {
        return async function integratedRunSkeletonOptimizer(skeleton, arg2, arg3, arg4) {
            const role = window.AccessControl?.getCurrentRole?.();
            const isOwner = role === 'owner' || role === 'admin';
            const SSM = window.SubdivisionScheduleManager;
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            
            // Protect local data during generation
            if (typeof window.protectLocalData === 'function') {
                window.protectLocalData();
            }

            console.log('\n' + '═'.repeat(70));
            console.log('🎯 MULTI-SCHEDULER GENERATION v2.2');
            console.log('═'.repeat(70));
            console.log(`Date: ${dateKey}`);
            console.log(`Role: ${role}`);
            console.log(`Mode: ${isOwner ? 'OWNER (Full Generation)' : 'SCHEDULER (Partial Generation)'}`);

            try {
                // =============================================================
                // STEP 1: Determine user's divisions
                // =============================================================
                let divisionsToSchedule;
                
                if (SSM?.isInitialized) {
                    divisionsToSchedule = SSM.getDivisionsToSchedule();
                } else if (window.AccessControl?.getUserManagedDivisions) {
                    divisionsToSchedule = window.AccessControl.getUserManagedDivisions();
                } else if (isOwner) {
                    divisionsToSchedule = Object.keys(window.divisions || {});
                } else {
                    throw new Error('Cannot determine divisions to schedule');
                }

                const myBunks = getBunksForDivisions(divisionsToSchedule);
                
                console.log(`\nDivisions to schedule: ${divisionsToSchedule.join(', ')}`);
                console.log(`Bunks to schedule: ${myBunks.size} total`);

                if (divisionsToSchedule.length === 0) {
                    throw new Error('No divisions assigned to current user');
                }

                // =============================================================
                // STEP 2: Load existing schedule from CLOUD (critical for multi-scheduler)
                // =============================================================
                console.log('\n[Step 2] Loading existing schedule...');
                
                let existingAssignments = {};
                try {
                    // CRITICAL: Fetch from cloud first to get other schedulers' work
                    if (window.fetchScheduleFromCloud) {
                        console.log('   Fetching from cloud...');
                        const cloudData = await window.fetchScheduleFromCloud(dateKey);
                        if (cloudData) {
                            existingAssignments = cloudData.scheduleAssignments || {};
                            console.log(`   Cloud has ${Object.keys(existingAssignments).length} bunks`);
                        }
                    }
                    
                    // Also check localStorage for any local drafts
                    const raw = localStorage.getItem(DAILY_DATA_KEY);
                    if (raw) {
                        const dailyData = JSON.parse(raw);
                        const localAssignments = dailyData[dateKey]?.scheduleAssignments || {};
                        const localBunkCount = Object.keys(localAssignments).length;
                        
                        if (localBunkCount > 0) {
                            console.log(`   LocalStorage has ${localBunkCount} bunks`);
                            // Merge local on top of cloud
                            existingAssignments = {
                                ...existingAssignments,
                                ...localAssignments
                            };
                        }
                    }
                } catch (e) {
                    console.warn('[Integration] Error loading existing:', e);
                }
                
                const existingBunkCount = Object.keys(existingAssignments).length;
                console.log(`   Found ${existingBunkCount} existing bunk schedules`);

                // =============================================================
                // STEP 3: Extract blocked resources (SCHEDULER MODE ONLY)
                // =============================================================
                if (!isOwner && existingBunkCount > 0) {
                    console.log('\n[Step 3] Extracting blocked resources from other schedulers...');
                    
                    const blockedResources = extractBlockedResources(existingAssignments, myBunks);
                    const blockedSlotCount = Object.keys(blockedResources).length;
                    
                    console.log(`   Found ${blockedSlotCount} slots with blocked resources`);
                    
                    // Debug: Print blocked summary
                    for (const [slot, resources] of Object.entries(blockedResources)) {
                        const resourceList = Object.entries(resources)
                            .map(([name, info]) => `${name}(${info.count})`)
                            .join(', ');
                        console.log(`   Slot ${slot}: ${resourceList}`);
                    }

                    // Register in GlobalFieldLocks
                    const activityProps = window.activityProperties || {};
                    registerBlockedInGlobalLocks(blockedResources, activityProps);
                } else if (isOwner) {
                    console.log('\n[Step 3] Owner mode - skipping blocked resource extraction');
                    if (window.GlobalFieldLocks) {
                        window.GlobalFieldLocks.reset();
                    }
                }

                // =============================================================
                // STEP 4: Prepare schedule space
                // =============================================================
                console.log('\n[Step 4] Preparing schedule space...');
                
                // Start with existing schedule (preserve others' work)
                window.scheduleAssignments = JSON.parse(JSON.stringify(existingAssignments));
                
                // Clear ONLY my bunks for fresh generation
                let clearedCount = 0;
                for (const bunk of myBunks) {
                    if (window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = [];
                        clearedCount++;
                    }
                }
                console.log(`   Cleared ${clearedCount} of my bunks for fresh generation`);
                console.log(`   Preserved ${existingBunkCount - clearedCount} bunks from other schedulers`);

                // =============================================================
                // STEP 5: Filter skeleton for my divisions
                // =============================================================
                const originalLength = skeleton?.length || 0;
                const filteredSkeleton = filterSkeletonByDivisions(skeleton, divisionsToSchedule);
                console.log(`\n[Step 5] Filtered skeleton: ${filteredSkeleton.length} blocks (from ${originalLength})`);

                // =============================================================
                // STEP 6: Run core optimizer
                // =============================================================
                console.log('\n[Step 6] Running core optimizer...');
                
                // CAPTURE CURRENT TIMES BEFORE OPTIMIZER WIPES THEM
                const currentUnifiedTimes = window.unifiedTimes ? JSON.parse(JSON.stringify(window.unifiedTimes)) : [];

                // Pass filtered skeleton and divisions to core
                if (arg2 && !Array.isArray(arg2) && typeof arg2 === 'object' && !arg3) {
                    await originalOptimizer(filteredSkeleton, {
                        ...arg2,
                        divisionsToSchedule,
                        isPartialGeneration: !isOwner
                    });
                } else {
                    await originalOptimizer(
                        filteredSkeleton,
                        arg2,
                        divisionsToSchedule,
                        null, // snapshot handled internally or passed via arg4 if needed, but we rely on window.scheduleAssignments state here
                        currentUnifiedTimes // <--- NEW 5th ARGUMENT
                    );
                }

                // =============================================================
                // STEP 7: Merge and verify (non-destructive)
                // =============================================================
                console.log('\n[Step 7] Verifying merge integrity...');
                
                // Count final bunks
                const finalBunkCount = Object.keys(window.scheduleAssignments || {}).length;
                const myBunksFilled = [...myBunks].filter(b => 
                    window.scheduleAssignments[b] && 
                    window.scheduleAssignments[b].some(s => s && s.field)
                ).length;

                console.log(`   Total bunks in final schedule: ${finalBunkCount}`);
                console.log(`   My bunks with schedules: ${myBunksFilled}/${myBunks.size}`);

                // Verify we didn't overwrite others' work
                let preservedCount = 0;
                for (const [bunk, slots] of Object.entries(existingAssignments)) {
                    if (!myBunks.has(bunk)) {
                        if (window.scheduleAssignments[bunk]) {
                            preservedCount++;
                        } else {
                            console.warn(`   ⚠️ Lost schedule for bunk: ${bunk}`);
                        }
                    }
                }
                console.log(`   Verified preserved: ${preservedCount} bunks from other schedulers`);

                // =============================================================
                // STEP 8: Save to storage
                // =============================================================
                console.log('\n[Step 8] Saving to storage...');
                saveScheduleToLocalStorage(window.scheduleAssignments, divisionsToSchedule);

                // =============================================================
                // STEP 9: Update subdivision status
                // =============================================================
                if (SSM?.markCurrentUserSubdivisionsAsDraft && !isOwner) {
                    console.log('[Step 9] Marking subdivisions as draft...');
                    SSM.markCurrentUserSubdivisionsAsDraft();
                }

                // =============================================================
                // STEP 10: Trigger UI refresh
                // =============================================================
                console.log('\n[Step 10] Refreshing UI...');
                window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
                
                if (typeof window.unprotectLocalData === 'function') {
                    setTimeout(() => window.unprotectLocalData(), 3000);
                }

                console.log('\n' + '═'.repeat(70));
                console.log('✅ GENERATION COMPLETE');
                console.log('═'.repeat(70) + '\n');

            } catch (error) {
                console.error('[Integration] Generation failed:', error);
                
                if (typeof window.unprotectLocalData === 'function') {
                    window.unprotectLocalData();
                }
                
                throw error;
            }
        };
    }

    // =========================================================================
    // HOOK INSTALLATION
    // =========================================================================

    function installHooks() {
        if (_isHooked) return;

        if (typeof window.runSkeletonOptimizer === 'function') {
            _originalRunOptimizer = window.runSkeletonOptimizer;
            window.runSkeletonOptimizer = createIntegratedOptimizer(_originalRunOptimizer);
            console.log('[Integration] ✅ Scheduler hooks installed for multi-scheduler support');
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
            window.currentScheduleDate = newDate;
            
            if (window.SubdivisionScheduleManager?.initialize) {
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
        getBunksForDivisions,
        extractBlockedResources,
        registerBlockedInGlobalLocks,
        saveScheduleToLocalStorage
    };

    // Initialize hooks
    if (document.readyState === 'complete') {
        installHooks();
    } else {
        window.addEventListener('load', installHooks);
    }

    setTimeout(installHooks, 100);

    console.log('[SchedulerSubdivisionIntegration] Module loaded v2.2 (PASS UNIFIED TIMES)');

})();
