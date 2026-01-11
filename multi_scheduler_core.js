// ============================================================================
// multi_scheduler_core.js - ROLE-BASED SCHEDULE GENERATOR WITH CONFLICT DETECTION
// ============================================================================
// Version: 1.0.0
// 
// This module implements:
// 1. Role-based division access (Owner=all, SchedulerA=1-3, SchedulerB=4-6)
// 2. First-come-first-served resource conflict detection
// 3. Non-destructive generation (preserves existing schedules)
// 4. Blocked resource tracking per time slot
//
// WORKFLOW:
// Step 1: Fetch existing schedule from cloud/localStorage
// Step 2: Extract blocked resources from OTHER schedulers' work
// Step 3: Build blocked resources list per time slot
// Step 4: Generate ONLY for current user's divisions
// Step 5: Merge new schedule with existing (non-destructive)
// ============================================================================

(function() {
    'use strict';

    const DAILY_DATA_KEY = 'campDailyData_v1';

    console.log('🎯 Multi-Scheduler Core v1.0 loading...');

    // =========================================================================
    // ROLE DEFINITIONS
    // =========================================================================

    const ROLES = {
        OWNER: 'owner',
        ADMIN: 'admin',
        SCHEDULER: 'scheduler'
    };

    // =========================================================================
    // BLOCKED RESOURCES TRACKER
    // =========================================================================

    /**
     * Tracks which resources are blocked at each time slot
     * Structure: { slotIndex: { resourceName: { usageCount, maxCapacity, bookedBy: [] } } }
     */
    class BlockedResourcesTracker {
        constructor() {
            this._blocked = {};
            this._capacities = {};
        }

        /**
         * Reset tracker for new generation
         */
        reset() {
            this._blocked = {};
            console.log('[BlockedResources] Tracker reset');
        }

        /**
         * Initialize resource capacities from activity properties
         * @param {Object} activityProperties - Map of activity name to properties
         */
        initializeCapacities(activityProperties) {
            this._capacities = {};

            for (const [name, props] of Object.entries(activityProperties || {})) {
                let capacity = 1; // Default: exclusive use

                if (props.sharableWith?.capacity) {
                    capacity = parseInt(props.sharableWith.capacity) || 1;
                } else if (props.sharable || props.sharableWith?.type === 'all') {
                    capacity = 2; // Default sharable capacity
                }

                this._capacities[name.toLowerCase()] = capacity;
            }

            console.log(`[BlockedResources] Initialized capacities for ${Object.keys(this._capacities).length} resources`);
        }

        /**
         * Get capacity for a resource
         * @param {string} resourceName 
         * @returns {number}
         */
        getCapacity(resourceName) {
            return this._capacities[resourceName.toLowerCase()] || 1;
        }

        /**
         * Mark a resource as used at a specific slot
         * @param {number} slotIndex - Time slot index
         * @param {string} resourceName - Field or activity name
         * @param {string} bookedBy - Who booked it (division or bunk name)
         * @returns {boolean} - True if successfully marked, false if at capacity
         */
        markAsUsed(slotIndex, resourceName, bookedBy) {
            const key = resourceName.toLowerCase();
            const capacity = this.getCapacity(resourceName);

            if (!this._blocked[slotIndex]) {
                this._blocked[slotIndex] = {};
            }

            if (!this._blocked[slotIndex][key]) {
                this._blocked[slotIndex][key] = {
                    resourceName: resourceName,
                    usageCount: 0,
                    maxCapacity: capacity,
                    bookedBy: []
                };
            }

            const slot = this._blocked[slotIndex][key];

            if (slot.usageCount >= slot.maxCapacity) {
                return false; // At capacity
            }

            slot.usageCount++;
            slot.bookedBy.push(bookedBy);
            return true;
        }

        /**
         * Check if a resource is available at a specific slot
         * @param {number} slotIndex - Time slot index
         * @param {string} resourceName - Field or activity name
         * @returns {boolean} - True if available, false if blocked/at capacity
         */
        isAvailable(slotIndex, resourceName) {
            const key = resourceName.toLowerCase();

            if (!this._blocked[slotIndex] || !this._blocked[slotIndex][key]) {
                return true; // Not tracked = available
            }

            const slot = this._blocked[slotIndex][key];
            return slot.usageCount < slot.maxCapacity;
        }

        /**
         * Get remaining capacity for a resource at a slot
         * @param {number} slotIndex 
         * @param {string} resourceName 
         * @returns {number}
         */
        getRemainingCapacity(slotIndex, resourceName) {
            const key = resourceName.toLowerCase();
            const maxCapacity = this.getCapacity(resourceName);

            if (!this._blocked[slotIndex] || !this._blocked[slotIndex][key]) {
                return maxCapacity;
            }

            const slot = this._blocked[slotIndex][key];
            return Math.max(0, slot.maxCapacity - slot.usageCount);
        }

        /**
         * Get all blocked resources at a slot
         * @param {number} slotIndex 
         * @returns {string[]} - Array of fully blocked resource names
         */
        getBlockedAtSlot(slotIndex) {
            if (!this._blocked[slotIndex]) return [];

            const blocked = [];
            for (const [key, info] of Object.entries(this._blocked[slotIndex])) {
                if (info.usageCount >= info.maxCapacity) {
                    blocked.push(info.resourceName);
                }
            }
            return blocked;
        }

        /**
         * Get usage summary for debugging
         * @returns {Object}
         */
        getSummary() {
            const summary = {};
            for (const [slotIdx, resources] of Object.entries(this._blocked)) {
                summary[slotIdx] = {};
                for (const [key, info] of Object.entries(resources)) {
                    summary[slotIdx][info.resourceName] = `${info.usageCount}/${info.maxCapacity} (${info.bookedBy.join(', ')})`;
                }
            }
            return summary;
        }
    }

    // =========================================================================
    // DIVISION ACCESS CONTROL
    // =========================================================================

    /**
     * Get divisions the current user can schedule
     * @returns {string[]} - Array of division names/IDs
     */
    function getUserDivisions() {
        // Check AccessControl first
        if (window.AccessControl?.getUserManagedDivisions) {
            const divisions = window.AccessControl.getUserManagedDivisions();
            if (divisions && divisions.length > 0) {
                return divisions;
            }
        }

        // Check SubdivisionScheduleManager
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divisions = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divisions && divisions.length > 0) {
                return divisions;
            }
        }

        // Fallback: check role
        const role = window.AccessControl?.getCurrentRole?.() || 'owner';
        
        if (role === 'owner' || role === 'admin') {
            // Return all divisions
            return Object.keys(window.divisions || {});
        }

        console.warn('[MultiScheduler] Could not determine user divisions, returning empty');
        return [];
    }

    /**
     * Get bunks belonging to specific divisions
     * @param {string[]} divisions - Division names/IDs
     * @returns {Set<string>} - Set of bunk names
     */
    function getBunksForDivisions(divisions) {
        const bunks = new Set();
        const allDivisions = window.divisions || {};

        for (const divName of divisions) {
            const divInfo = allDivisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => bunks.add(b));
            }
        }

        return bunks;
    }

    /**
     * Get divisions that are NOT managed by the current user
     * @returns {string[]}
     */
    function getOtherDivisions() {
        const myDivisions = new Set(getUserDivisions());
        const allDivisions = Object.keys(window.divisions || {});
        
        return allDivisions.filter(d => !myDivisions.has(d));
    }

    // =========================================================================
    // STEP 1: FETCH EXISTING SCHEDULE
    // =========================================================================

    /**
     * Load the current schedule from localStorage/cloud
     * @param {string} dateKey - Date in YYYY-MM-DD format
     * @returns {Object} - { scheduleAssignments, subdivisionSchedules, fieldUsageClaims }
     */
    async function fetchExistingSchedule(dateKey) {
        console.log(`[MultiScheduler] Step 1: Fetching existing schedule for ${dateKey}...`);

        let scheduleAssignments = {};
        let subdivisionSchedules = {};
        let fieldUsageClaims = {};

        try {
            // Load from localStorage
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) {
                const dailyData = JSON.parse(raw);
                const dateData = dailyData[dateKey] || {};

                scheduleAssignments = dateData.scheduleAssignments || {};
                subdivisionSchedules = dateData.subdivisionSchedules || {};

                // Extract field usage claims from subdivision schedules
                for (const [subId, subSchedule] of Object.entries(subdivisionSchedules)) {
                    if (subSchedule.fieldUsageClaims) {
                        for (const [slotIdx, claims] of Object.entries(subSchedule.fieldUsageClaims)) {
                            if (!fieldUsageClaims[slotIdx]) {
                                fieldUsageClaims[slotIdx] = {};
                            }
                            Object.assign(fieldUsageClaims[slotIdx], claims);
                        }
                    }
                }
            }

            console.log(`[MultiScheduler]   Found ${Object.keys(scheduleAssignments).length} existing bunk schedules`);
            console.log(`[MultiScheduler]   Found ${Object.keys(subdivisionSchedules).length} subdivision records`);

        } catch (e) {
            console.error('[MultiScheduler] Error fetching existing schedule:', e);
        }

        return { scheduleAssignments, subdivisionSchedules, fieldUsageClaims };
    }

    // =========================================================================
    // STEP 2: IDENTIFY BLOCKED RESOURCES FROM OTHER SCHEDULERS
    // =========================================================================

    /**
     * Extract blocked resources from existing schedules (excluding current user's divisions)
     * @param {Object} existingSchedule - From fetchExistingSchedule()
     * @param {string[]} myDivisions - Divisions the current user manages
     * @param {BlockedResourcesTracker} tracker - Tracker to populate
     */
    function extractBlockedResources(existingSchedule, myDivisions, tracker) {
        console.log(`[MultiScheduler] Step 2: Extracting blocked resources...`);
        console.log(`[MultiScheduler]   My divisions: ${myDivisions.join(', ')}`);

        const myDivisionsSet = new Set(myDivisions);
        const myBunks = getBunksForDivisions(myDivisions);
        const { scheduleAssignments, subdivisionSchedules } = existingSchedule;

        let blockedCount = 0;

        // Method 1: Extract from scheduleAssignments (bunk-level data)
        for (const [bunk, slots] of Object.entries(scheduleAssignments || {})) {
            // Skip bunks that belong to MY divisions
            if (myBunks.has(bunk)) {
                continue;
            }

            // This bunk belongs to another scheduler - extract their resource usage
            if (Array.isArray(slots)) {
                slots.forEach((slot, slotIdx) => {
                    if (slot && !slot.continuation) {
                        const resourceName = slot.field || slot._activity;
                        if (resourceName && resourceName !== 'Free' && resourceName !== 'free') {
                            tracker.markAsUsed(slotIdx, resourceName, bunk);
                            blockedCount++;
                        }
                    }
                });
            }
        }

        // Method 2: Extract from subdivisionSchedules (more structured)
        for (const [subId, subSchedule] of Object.entries(subdivisionSchedules || {})) {
            const subDivisions = subSchedule.divisions || [];
            
            // Skip if this subdivision belongs to current user
            const isMySubdivision = subDivisions.some(d => myDivisionsSet.has(d));
            if (isMySubdivision) {
                continue;
            }

            // Skip empty/ungenerated subdivisions
            if (subSchedule.status === 'empty') {
                continue;
            }

            // Extract from fieldUsageClaims (most accurate)
            const claims = subSchedule.fieldUsageClaims || {};
            for (const [slotIdx, slotClaims] of Object.entries(claims)) {
                for (const [fieldName, usage] of Object.entries(slotClaims)) {
                    const count = usage.count || 1;
                    for (let i = 0; i < count; i++) {
                        tracker.markAsUsed(parseInt(slotIdx), fieldName, subSchedule.subdivisionName || subId);
                    }
                    blockedCount++;
                }
            }

            // Also extract from scheduleData if available
            const scheduleData = subSchedule.scheduleData || {};
            for (const [bunk, slots] of Object.entries(scheduleData)) {
                if (Array.isArray(slots)) {
                    slots.forEach((slot, slotIdx) => {
                        if (slot && !slot.continuation) {
                            const resourceName = slot.field || slot._activity;
                            if (resourceName && resourceName !== 'Free') {
                                tracker.markAsUsed(slotIdx, resourceName, bunk);
                            }
                        }
                    });
                }
            }
        }

        console.log(`[MultiScheduler]   Marked ${blockedCount} resource-slot combinations as blocked`);
    }

    // =========================================================================
    // STEP 3 & 4: GENERATE WITH BLOCKED RESOURCES
    // =========================================================================

    /**
     * Filter available resources for a specific slot
     * @param {string[]} allResources - All possible resources
     * @param {number} slotIndex - Time slot
     * @param {BlockedResourcesTracker} tracker - Blocked resources tracker
     * @returns {string[]} - Available resources
     */
    function filterAvailableResources(allResources, slotIndex, tracker) {
        return allResources.filter(resource => tracker.isAvailable(slotIndex, resource));
    }

    /**
     * Assign a resource to a bunk at a slot (with conflict checking)
     * @param {string} bunk - Bunk name
     * @param {number} slotIndex - Time slot
     * @param {string} desiredResource - Resource to assign
     * @param {BlockedResourcesTracker} tracker - Blocked resources tracker
     * @param {string[]} fallbackResources - Alternative resources if desired is blocked
     * @returns {Object|null} - Assignment object or null if impossible
     */
    function assignResourceWithConflictCheck(bunk, slotIndex, desiredResource, tracker, fallbackResources = []) {
        // Try desired resource first
        if (tracker.isAvailable(slotIndex, desiredResource)) {
            tracker.markAsUsed(slotIndex, desiredResource, bunk);
            return {
                field: desiredResource,
                _activity: desiredResource,
                _assignedBy: 'multi_scheduler',
                _timestamp: Date.now()
            };
        }

        // Try fallbacks
        for (const fallback of fallbackResources) {
            if (tracker.isAvailable(slotIndex, fallback)) {
                tracker.markAsUsed(slotIndex, fallback, bunk);
                console.log(`[MultiScheduler] ⚠️ ${bunk} slot ${slotIndex}: "${desiredResource}" blocked, using "${fallback}"`);
                return {
                    field: fallback,
                    _activity: fallback,
                    _assignedBy: 'multi_scheduler',
                    _fallbackFrom: desiredResource,
                    _timestamp: Date.now()
                };
            }
        }

        // No available resource
        console.log(`[MultiScheduler] ❌ ${bunk} slot ${slotIndex}: No available resource (wanted: ${desiredResource})`);
        return null;
    }

    // =========================================================================
    // STEP 5: MERGE NEW SCHEDULE (NON-DESTRUCTIVE)
    // =========================================================================

    /**
     * Merge newly generated schedule with existing (preserving others' work)
     * @param {Object} existingSchedule - Current schedule data
     * @param {Object} newAssignments - Newly generated assignments
     * @param {string[]} myDivisions - Divisions the current user manages
     * @returns {Object} - Merged schedule
     */
    function mergeSchedules(existingSchedule, newAssignments, myDivisions) {
        console.log(`[MultiScheduler] Step 5: Merging schedules (non-destructive)...`);

        const myBunks = getBunksForDivisions(myDivisions);
        const merged = JSON.parse(JSON.stringify(existingSchedule.scheduleAssignments || {}));

        let preservedCount = 0;
        let updatedCount = 0;

        // Preserve ALL existing schedules for bunks NOT in my divisions
        for (const [bunk, slots] of Object.entries(merged)) {
            if (!myBunks.has(bunk)) {
                preservedCount++;
                // Mark as locked so UI shows it's from another scheduler
                if (Array.isArray(slots)) {
                    slots.forEach(slot => {
                        if (slot) {
                            slot._locked = true;
                            slot._fromOtherScheduler = true;
                        }
                    });
                }
            }
        }

        // Update ONLY bunks in my divisions
        for (const [bunk, slots] of Object.entries(newAssignments)) {
            if (myBunks.has(bunk)) {
                merged[bunk] = slots;
                updatedCount++;
            }
        }

        console.log(`[MultiScheduler]   Preserved ${preservedCount} bunks from other schedulers`);
        console.log(`[MultiScheduler]   Updated ${updatedCount} bunks for current user`);

        return merged;
    }

    // =========================================================================
    // MAIN ORCHESTRATOR FUNCTION
    // =========================================================================

    /**
     * Main function to run the multi-scheduler generation
     * @param {Object} options - Generation options
     * @param {Function} coreGenerator - The actual schedule generation function
     * @returns {Promise<Object>} - Generated schedule
     */
    async function runMultiSchedulerGeneration(options = {}) {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const role = window.AccessControl?.getCurrentRole?.() || 'owner';
        const isOwner = role === 'owner' || role === 'admin';

        console.log('\n' + '═'.repeat(70));
        console.log('🎯 MULTI-SCHEDULER GENERATION');
        console.log('═'.repeat(70));
        console.log(`Date: ${dateKey}`);
        console.log(`Role: ${role}`);
        console.log(`Mode: ${isOwner ? 'FULL (Owner)' : 'PARTIAL (Scheduler)'}`);

        // Initialize tracker
        const tracker = new BlockedResourcesTracker();
        
        // Load activity properties for capacities
        const activityProps = window.activityProperties || {};
        tracker.initializeCapacities(activityProps);

        // Get user's divisions
        const myDivisions = getUserDivisions();
        const myBunks = getBunksForDivisions(myDivisions);

        console.log(`\nDivisions to schedule: ${myDivisions.join(', ')}`);
        console.log(`Bunks to schedule: ${myBunks.size} total`);

        if (myDivisions.length === 0) {
            console.error('[MultiScheduler] No divisions assigned to current user!');
            throw new Error('You have no divisions assigned to schedule.');
        }

        // =====================================================================
        // STEP 1: Fetch existing schedule
        // =====================================================================
        const existingSchedule = await fetchExistingSchedule(dateKey);

        // =====================================================================
        // STEP 2: Extract blocked resources (skip for owners doing full gen)
        // =====================================================================
        if (!isOwner) {
            extractBlockedResources(existingSchedule, myDivisions, tracker);
            
            // Debug: Print blocked summary
            const summary = tracker.getSummary();
            if (Object.keys(summary).length > 0) {
                console.log('\n[MultiScheduler] Blocked resources summary:');
                for (const [slot, resources] of Object.entries(summary)) {
                    console.log(`  Slot ${slot}: ${JSON.stringify(resources)}`);
                }
            }
        }

        // =====================================================================
        // STEP 3: Register blocked resources in GlobalFieldLocks
        // =====================================================================
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.reset();
            
            // Register all blocked resources
            for (const [slotIdx, resources] of Object.entries(tracker._blocked)) {
                for (const [key, info] of Object.entries(resources)) {
                    if (info.usageCount >= info.maxCapacity) {
                        window.GlobalFieldLocks.lockField(info.resourceName, [parseInt(slotIdx)], {
                            lockedBy: 'other_scheduler',
                            activity: `Used by: ${info.bookedBy.join(', ')}`,
                            division: 'external'
                        });
                    }
                }
            }
            
            console.log('[MultiScheduler] Registered blocked resources in GlobalFieldLocks');
        }

        // =====================================================================
        // STEP 4: Prepare generation context
        // =====================================================================
        const generationContext = {
            dateKey,
            myDivisions,
            myBunks: [...myBunks],
            blockedResourcesTracker: tracker,
            existingSchedule,
            isOwner,
            
            // Helper function for the generator to check availability
            isResourceAvailable: (slotIndex, resourceName) => {
                return tracker.isAvailable(slotIndex, resourceName);
            },
            
            // Helper to get available resources
            getAvailableResources: (slotIndex, allResources) => {
                return filterAvailableResources(allResources, slotIndex, tracker);
            },
            
            // Helper to mark resource as used
            markResourceUsed: (slotIndex, resourceName, bunk) => {
                return tracker.markAsUsed(slotIndex, resourceName, bunk);
            }
        };

        // Store context globally for other modules to access
        window._multiSchedulerContext = generationContext;

        console.log('\n[MultiScheduler] Generation context prepared');
        console.log('═'.repeat(70) + '\n');

        return generationContext;
    }

    /**
     * Finalize generation - merge and save results
     * @param {Object} newAssignments - Newly generated schedule assignments
     * @returns {Object} - Final merged schedule
     */
    async function finalizeGeneration(newAssignments) {
        const context = window._multiSchedulerContext;
        
        if (!context) {
            console.error('[MultiScheduler] No generation context found!');
            return newAssignments;
        }

        console.log('\n[MultiScheduler] Finalizing generation...');

        // =====================================================================
        // STEP 5: Merge with existing (non-destructive)
        // =====================================================================
        const mergedSchedule = mergeSchedules(
            context.existingSchedule,
            newAssignments,
            context.myDivisions
        );

        // Save to window for UI
        window.scheduleAssignments = mergedSchedule;

        // Extract field usage claims for this user's work
        const fieldUsageClaims = extractFieldUsageClaimsFromAssignments(
            newAssignments,
            context.myBunks
        );

        console.log(`[MultiScheduler] Generation complete!`);
        console.log(`  Total bunks in schedule: ${Object.keys(mergedSchedule).length}`);

        // Clean up
        delete window._multiSchedulerContext;

        return {
            scheduleAssignments: mergedSchedule,
            fieldUsageClaims,
            generatedDivisions: context.myDivisions,
            generatedBunks: context.myBunks
        };
    }

    /**
     * Extract field usage claims from schedule assignments
     * @param {Object} assignments - Schedule assignments
     * @param {string[]} bunks - Bunks to extract from
     * @returns {Object} - Field usage claims by slot
     */
    function extractFieldUsageClaimsFromAssignments(assignments, bunks) {
        const claims = {};
        const bunkSet = new Set(bunks);

        for (const [bunk, slots] of Object.entries(assignments || {})) {
            if (!bunkSet.has(bunk)) continue;

            if (Array.isArray(slots)) {
                slots.forEach((slot, slotIdx) => {
                    if (slot && !slot.continuation) {
                        const resourceName = slot.field || slot._activity;
                        if (resourceName && resourceName !== 'Free') {
                            if (!claims[slotIdx]) claims[slotIdx] = {};
                            if (!claims[slotIdx][resourceName]) {
                                claims[slotIdx][resourceName] = {
                                    count: 0,
                                    bunks: {}
                                };
                            }
                            claims[slotIdx][resourceName].count++;
                            claims[slotIdx][resourceName].bunks[bunk] = resourceName;
                        }
                    }
                });
            }
        }

        return claims;
    }

    // =========================================================================
    // INTEGRATION HOOK - Wrap existing optimizer
    // =========================================================================

    /**
     * Wrap the existing runSkeletonOptimizer with multi-scheduler logic
     */
    function installOptimizerHook() {
        const originalOptimizer = window.runSkeletonOptimizer;
        
        if (!originalOptimizer) {
            console.log('[MultiScheduler] Waiting for runSkeletonOptimizer...');
            setTimeout(installOptimizerHook, 500);
            return;
        }

        if (window._multiSchedulerHooked) {
            console.log('[MultiScheduler] Already hooked');
            return;
        }

        window.runSkeletonOptimizer = async function(skeleton, ...args) {
            try {
                // Prepare multi-scheduler context
                const context = await runMultiSchedulerGeneration();
                
                // Filter skeleton to only include user's divisions
                const filteredSkeleton = filterSkeletonByDivisions(skeleton, context.myDivisions);
                
                console.log(`[MultiScheduler] Running core optimizer with ${filteredSkeleton.length} blocks...`);
                
                // Run the actual optimizer
                await originalOptimizer(filteredSkeleton, ...args);
                
                // Finalize and merge
                const result = await finalizeGeneration(window.scheduleAssignments);
                
                // Save the result
                await saveScheduleToStorage(result);
                
                return result;
                
            } catch (error) {
                console.error('[MultiScheduler] Generation failed:', error);
                throw error;
            }
        };

        window._multiSchedulerHooked = true;
        console.log('[MultiScheduler] ✅ Optimizer hook installed');
    }

    /**
     * Filter skeleton blocks to only include user's divisions
     */
    function filterSkeletonByDivisions(skeleton, divisions) {
        if (!skeleton || !Array.isArray(skeleton)) return [];
        if (!divisions || divisions.length === 0) return skeleton;

        const divisionSet = new Set(divisions.map(String));

        return skeleton.filter(block => {
            // If block has no division filter, include it
            if (!block.division && (!block.divisions || block.divisions.length === 0)) {
                return true;
            }

            // Check single division
            if (block.division && divisionSet.has(String(block.division))) {
                return true;
            }

            // Check divisions array
            if (block.divisions) {
                return block.divisions.some(d => divisionSet.has(String(d)));
            }

            return false;
        });
    }

    /**
     * Save schedule to localStorage and trigger cloud sync
     */
    async function saveScheduleToStorage(result) {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];

        try {
            let dailyData = {};
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) dailyData = JSON.parse(raw);

            if (!dailyData[dateKey]) dailyData[dateKey] = {};

            // Save merged schedule
            dailyData[dateKey].scheduleAssignments = result.scheduleAssignments;

            // Update subdivision schedule for current user
            if (window.SubdivisionScheduleManager?.markCurrentUserSubdivisionsAsDraft) {
                // Let the subdivision manager handle its own data
            }

            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));

            console.log('[MultiScheduler] 💾 Saved to localStorage');

            // Trigger cloud sync
            if (typeof window.forceSyncToCloud === 'function') {
                await window.forceSyncToCloud();
                console.log('[MultiScheduler] ☁️ Cloud sync triggered');
            }

            // Dispatch UI update event
            window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));

        } catch (e) {
            console.error('[MultiScheduler] Save error:', e);
            throw e;
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.MultiSchedulerCore = {
        // Main functions
        runMultiSchedulerGeneration,
        finalizeGeneration,
        
        // Utilities
        getUserDivisions,
        getBunksForDivisions,
        getOtherDivisions,
        filterAvailableResources,
        filterSkeletonByDivisions,
        mergeSchedules,
        
        // Tracker class
        BlockedResourcesTracker,
        
        // Hook installer
        installOptimizerHook,
        
        // Current context
        getContext: () => window._multiSchedulerContext
    };

    // Auto-install hook when ready
    if (document.readyState === 'complete') {
        setTimeout(installOptimizerHook, 100);
    } else {
        window.addEventListener('load', () => setTimeout(installOptimizerHook, 100));
    }

    console.log('🎯 Multi-Scheduler Core v1.0 loaded');
    console.log('   - Role-based division access ✅');
    console.log('   - First-come-first-served conflict detection ✅');
    console.log('   - Non-destructive merging ✅');

})();
