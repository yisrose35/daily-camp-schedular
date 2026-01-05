// ============================================================================
// subdivision_schedule_manager.js (v1.0)
// ============================================================================
// MULTI-SCHEDULER SYSTEM: Allows multiple schedulers to create schedules for
// their assigned subdivisions while respecting each other's locked schedules.
//
// KEY FEATURES:
// 1. Schedule Ownership - Each subdivision owns its schedule
// 2. Schedule Locking - Once locked, others can see but not edit
// 3. Cross-Subdivision Awareness - Respects locked field usage
// 4. Smart Resource Sharing - First scheduler leaves room for others
// 5. Field Usage Claims - Locked schedules claim field slots
//
// DATA STRUCTURE (stored in daily data):
// subdivisionSchedules: {
//   "subdivision_uuid": {
//     subdivisionId, subdivisionName, divisions[], status,
//     lockedBy: { userId, email, name },
//     lockedAt, lastModifiedAt, scheduleData, fieldUsageClaims
//   }
// }
// ============================================================================

(function() {
    'use strict';

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    const SCHEDULE_STATUS = {
        EMPTY: 'empty',       // No schedule generated yet
        DRAFT: 'draft',       // Schedule exists but not locked
        LOCKED: 'locked'      // Schedule is finalized and immutable
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _initialized = false;
    let _currentUserSubdivisions = [];  // Subdivisions this user can edit
    let _allSubdivisions = [];          // All subdivisions in camp
    let _subdivisionSchedules = {};     // All subdivision schedules for today

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the subdivision schedule manager
     * Must be called after AccessControl is initialized
     */
    async function initialize() {
        console.log('[SubdivisionScheduler] Initializing...');

        // Wait for AccessControl to be ready
        if (!window.AccessControl?.isInitialized?.()) {
            console.log('[SubdivisionScheduler] Waiting for AccessControl...');
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (window.AccessControl?.isInitialized?.()) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
                // Timeout after 10 seconds
                setTimeout(() => {
                    clearInterval(check);
                    resolve();
                }, 10000);
            });
        }

        // Load current user's subdivision access
        _currentUserSubdivisions = window.AccessControl?.getUserSubdivisions?.() || [];
        _allSubdivisions = window.AccessControl?.getAllSubdivisions?.() || [];

        // Load today's subdivision schedules
        await loadSubdivisionSchedules();

        _initialized = true;
        console.log('[SubdivisionScheduler] Initialized');
        console.log(`  Current user has access to ${_currentUserSubdivisions.length} subdivisions`);
        console.log(`  Camp has ${_allSubdivisions.length} total subdivisions`);

        // Emit initialization event
        window.dispatchEvent(new CustomEvent('subdivisionSchedulerReady'));

        return true;
    }

    /**
     * Check if manager is initialized
     */
    function isInitialized() {
        return _initialized;
    }

    // =========================================================================
    // DATA LOADING/SAVING
    // =========================================================================

    /**
     * Load subdivision schedules for today
     */
    async function loadSubdivisionSchedules() {
        const dailyData = window.loadCurrentDailyData?.() || {};
        _subdivisionSchedules = dailyData.subdivisionSchedules || {};

        // Ensure all subdivisions have entries
        _allSubdivisions.forEach(sub => {
            if (!_subdivisionSchedules[sub.id]) {
                _subdivisionSchedules[sub.id] = {
                    subdivisionId: sub.id,
                    subdivisionName: sub.name,
                    divisions: sub.divisions || [],
                    status: SCHEDULE_STATUS.EMPTY,
                    lockedBy: null,
                    lockedAt: null,
                    lastModifiedAt: null,
                    lastModifiedBy: null,
                    scheduleData: {},
                    fieldUsageClaims: {}
                };
            }
        });

        console.log('[SubdivisionScheduler] Loaded schedules:', Object.keys(_subdivisionSchedules).length);
    }

    /**
     * Save subdivision schedules
     */
    function saveSubdivisionSchedules() {
        window.saveCurrentDailyData?.('subdivisionSchedules', _subdivisionSchedules);
        scheduleCloudSync();
    }

    /**
     * Schedule cloud sync
     */
    let _syncTimeout = null;
    function scheduleCloudSync() {
        clearTimeout(_syncTimeout);
        _syncTimeout = setTimeout(() => {
            if (typeof window.forceSyncToCloud === 'function') {
                console.log('[SubdivisionScheduler] ☁️ Syncing to cloud...');
                window.forceSyncToCloud();
            }
        }, 500);
    }

    // =========================================================================
    // SUBDIVISION ACCESS HELPERS
    // =========================================================================

    /**
     * Get subdivisions the current user can edit
     */
    function getEditableSubdivisions() {
        return _currentUserSubdivisions;
    }

    /**
     * Get all subdivisions in the camp
     */
    function getAllSubdivisions() {
        return _allSubdivisions;
    }

    /**
     * Check if current user can edit a specific subdivision
     */
    function canEditSubdivision(subdivisionId) {
        // Owner/Admin can edit all
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            return true;
        }

        // Check if subdivision is in user's list
        return _currentUserSubdivisions.some(sub => sub.id === subdivisionId);
    }

    /**
     * Get the subdivision for a division name
     */
    function getSubdivisionForDivision(divisionName) {
        for (const sub of _allSubdivisions) {
            if (sub.divisions?.includes(divisionName)) {
                return sub;
            }
        }
        return null;
    }

    /**
     * Check if current user can edit a division
     */
    function canEditDivision(divisionName) {
        const sub = getSubdivisionForDivision(divisionName);
        if (!sub) return false;
        return canEditSubdivision(sub.id);
    }

    // =========================================================================
    // SCHEDULE STATUS MANAGEMENT
    // =========================================================================

    /**
     * Get the schedule for a subdivision
     */
    function getSubdivisionSchedule(subdivisionId) {
        return _subdivisionSchedules[subdivisionId] || null;
    }

    /**
     * Get all subdivision schedules
     */
    function getAllSubdivisionSchedules() {
        return { ..._subdivisionSchedules };
    }

    /**
     * Check if a subdivision's schedule is locked
     */
    function isSubdivisionLocked(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        return schedule?.status === SCHEDULE_STATUS.LOCKED;
    }

    /**
     * Check if a division's schedule is locked
     */
    function isDivisionLocked(divisionName) {
        const sub = getSubdivisionForDivision(divisionName);
        if (!sub) return false;
        return isSubdivisionLocked(sub.id);
    }

    /**
     * Get locked subdivisions that the current user should respect
     * (i.e., not their own)
     */
    function getOtherLockedSubdivisions() {
        const locked = [];
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (schedule.status === SCHEDULE_STATUS.LOCKED && !mySubIds.has(subId)) {
                locked.push(schedule);
            }
        }

        return locked;
    }

    // =========================================================================
    // SCHEDULE LOCKING
    // =========================================================================

    /**
     * Lock a subdivision's schedule
     * @param {string} subdivisionId - The subdivision to lock
     * @returns {object} - Result with success status
     */
    function lockSubdivisionSchedule(subdivisionId) {
        if (!canEditSubdivision(subdivisionId)) {
            return { success: false, error: 'Not authorized to lock this subdivision' };
        }

        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) {
            return { success: false, error: 'Subdivision not found' };
        }

        if (schedule.status === SCHEDULE_STATUS.LOCKED) {
            return { success: false, error: 'Schedule is already locked' };
        }

        if (schedule.status === SCHEDULE_STATUS.EMPTY) {
            return { success: false, error: 'Cannot lock an empty schedule. Generate a schedule first.' };
        }

        // Get current user info
        const userInfo = window.AccessControl?.getCurrentUserInfo?.() || {
            userId: 'unknown',
            email: 'unknown',
            name: 'Unknown User'
        };

        // Extract schedule data for this subdivision's divisions
        const scheduleData = extractScheduleDataForSubdivision(subdivisionId);
        const fieldUsageClaims = extractFieldUsageClaimsForSubdivision(subdivisionId);

        // Update schedule status
        schedule.status = SCHEDULE_STATUS.LOCKED;
        schedule.lockedBy = userInfo;
        schedule.lockedAt = Date.now();
        schedule.scheduleData = scheduleData;
        schedule.fieldUsageClaims = fieldUsageClaims;

        saveSubdivisionSchedules();

        console.log(`[SubdivisionScheduler] 🔒 LOCKED: ${schedule.subdivisionName}`);
        console.log(`  By: ${userInfo.email}`);
        console.log(`  Divisions: ${schedule.divisions.join(', ')}`);
        console.log(`  Field claims: ${Object.keys(fieldUsageClaims).length} slots`);

        // Emit lock event
        window.dispatchEvent(new CustomEvent('subdivisionScheduleLocked', {
            detail: { subdivisionId, schedule }
        }));

        return { success: true, schedule };
    }

    /**
     * Unlock a subdivision's schedule
     * Only the owner/admin or the person who locked it can unlock
     */
    function unlockSubdivisionSchedule(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) {
            return { success: false, error: 'Subdivision not found' };
        }

        if (schedule.status !== SCHEDULE_STATUS.LOCKED) {
            return { success: false, error: 'Schedule is not locked' };
        }

        // Check authorization
        const role = window.AccessControl?.getCurrentRole?.();
        const currentEmail = window.AccessControl?.getCurrentUserInfo?.()?.email;
        const lockedByEmail = schedule.lockedBy?.email;

        const canUnlock = (
            role === 'owner' ||
            role === 'admin' ||
            currentEmail === lockedByEmail
        );

        if (!canUnlock) {
            return { success: false, error: 'Not authorized to unlock. Only the person who locked or an admin can unlock.' };
        }

        // Unlock the schedule
        schedule.status = SCHEDULE_STATUS.DRAFT;
        schedule.lockedBy = null;
        schedule.lockedAt = null;
        // Keep the schedule data - just unlocked for editing

        saveSubdivisionSchedules();

        console.log(`[SubdivisionScheduler] 🔓 UNLOCKED: ${schedule.subdivisionName}`);

        // Emit unlock event
        window.dispatchEvent(new CustomEvent('subdivisionScheduleUnlocked', {
            detail: { subdivisionId, schedule }
        }));

        return { success: true, schedule };
    }

    // =========================================================================
    // SCHEDULE DATA EXTRACTION
    // =========================================================================

    /**
     * Extract schedule assignments for a subdivision's divisions
     */
    function extractScheduleDataForSubdivision(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) return {};

        const divisions = schedule.divisions || [];
        const allDivisions = window.divisions || {};
        const scheduleAssignments = window.scheduleAssignments || {};

        const data = {};

        // Get all bunks in this subdivision's divisions
        divisions.forEach(divName => {
            const bunks = allDivisions[divName]?.bunks || [];
            bunks.forEach(bunk => {
                if (scheduleAssignments[bunk]) {
                    data[bunk] = JSON.parse(JSON.stringify(scheduleAssignments[bunk]));
                }
            });
        });

        return data;
    }

    /**
     * Extract field usage claims for a subdivision
     * These are the slots where this subdivision is using fields
     */
    function extractFieldUsageClaimsForSubdivision(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) return {};

        const divisions = schedule.divisions || [];
        const divisionsSet = new Set(divisions);
        const fieldUsageBySlot = window.fieldUsageBySlot || {};

        const claims = {};

        // Go through all field usage and extract claims for this subdivision
        for (const [slotIdx, slotUsage] of Object.entries(fieldUsageBySlot)) {
            for (const [fieldName, usage] of Object.entries(slotUsage || {})) {
                // Check if any of the divisions match
                const matchingDivisions = (usage.divisions || []).filter(d => divisionsSet.has(d));
                
                if (matchingDivisions.length > 0) {
                    if (!claims[slotIdx]) claims[slotIdx] = {};
                    
                    claims[slotIdx][fieldName] = {
                        count: usage.count || 1,
                        divisions: matchingDivisions,
                        bunks: {},
                        _lockedBy: subdivisionId
                    };

                    // Copy only bunks that belong to this subdivision
                    if (usage.bunks) {
                        const allDivisions = window.divisions || {};
                        const subBunks = new Set();
                        divisions.forEach(d => {
                            (allDivisions[d]?.bunks || []).forEach(b => subBunks.add(b));
                        });

                        for (const [bunk, activity] of Object.entries(usage.bunks)) {
                            if (subBunks.has(bunk)) {
                                claims[slotIdx][fieldName].bunks[bunk] = activity;
                            }
                        }
                    }
                }
            }
        }

        return claims;
    }

    // =========================================================================
    // CROSS-SUBDIVISION FIELD CLAIMS
    // =========================================================================

    /**
     * Get all field usage claims from OTHER locked subdivisions
     * This is what the current scheduler must respect
     */
    function getLockedFieldUsageClaims() {
        const claims = {};
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            // Skip if not locked or if it's our own subdivision
            if (schedule.status !== SCHEDULE_STATUS.LOCKED) continue;
            if (mySubIds.has(subId)) continue;

            const subClaims = schedule.fieldUsageClaims || {};

            // Merge claims
            for (const [slotIdx, slotClaims] of Object.entries(subClaims)) {
                if (!claims[slotIdx]) claims[slotIdx] = {};

                for (const [fieldName, usage] of Object.entries(slotClaims)) {
                    if (!claims[slotIdx][fieldName]) {
                        claims[slotIdx][fieldName] = {
                            count: 0,
                            divisions: [],
                            bunks: {},
                            _lockedSubdivisions: []
                        };
                    }

                    // Accumulate claims
                    claims[slotIdx][fieldName].count += (usage.count || 0);
                    claims[slotIdx][fieldName].divisions.push(...(usage.divisions || []));
                    claims[slotIdx][fieldName]._lockedSubdivisions.push(subId);

                    // Merge bunks
                    if (usage.bunks) {
                        Object.assign(claims[slotIdx][fieldName].bunks, usage.bunks);
                    }
                }
            }
        }

        return claims;
    }

    /**
     * Check if a field is claimed by a locked subdivision at specific slots
     */
    function isFieldClaimedByOthers(fieldName, slots, divisionContext) {
        const claims = getLockedFieldUsageClaims();
        
        for (const slotIdx of slots) {
            const slotClaims = claims[slotIdx];
            if (!slotClaims) continue;

            const fieldClaim = slotClaims[fieldName];
            if (!fieldClaim) continue;

            // Field is claimed by a locked subdivision
            // Check capacity
            const props = window.activityProperties?.[fieldName] || {};
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                maxCapacity = 2;
            }

            if (fieldClaim.count >= maxCapacity) {
                return {
                    claimed: true,
                    claimedBy: fieldClaim._lockedSubdivisions,
                    currentCount: fieldClaim.count,
                    maxCapacity
                };
            }
        }

        return { claimed: false };
    }

    /**
     * Get remaining capacity for a field considering locked claims
     */
    function getRemainingFieldCapacity(fieldName, slots) {
        const claims = getLockedFieldUsageClaims();
        const props = window.activityProperties?.[fieldName] || {};
        
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable) {
            maxCapacity = 2;
        }

        let maxClaimed = 0;

        for (const slotIdx of slots) {
            const slotClaims = claims[slotIdx];
            if (!slotClaims) continue;

            const fieldClaim = slotClaims[fieldName];
            if (fieldClaim) {
                maxClaimed = Math.max(maxClaimed, fieldClaim.count || 0);
            }
        }

        return Math.max(0, maxCapacity - maxClaimed);
    }

    // =========================================================================
    // SMART RESOURCE SHARING
    // =========================================================================

    /**
     * Calculate how many other subdivisions still need to schedule
     * for a given time block
     */
    function getUnscheduledSubdivisionCount(slots) {
        let count = 0;

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (schedule.status === SCHEDULE_STATUS.EMPTY) {
                count++;
            }
        }

        return count;
    }

    /**
     * Calculate fair share of a resource for the current subdivision
     * This helps the first scheduler not be greedy
     */
    function calculateFairResourceShare(fieldName, slots, totalDivisionsNeedingResource) {
        const props = window.activityProperties?.[fieldName] || {};
        
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable) {
            maxCapacity = 2;
        }

        // If no other subdivisions need this, we can use full capacity
        if (totalDivisionsNeedingResource <= 1) {
            return maxCapacity;
        }

        // Otherwise, be fair - leave room for others
        // But always allow at least 1
        const fairShare = Math.max(1, Math.floor(maxCapacity / totalDivisionsNeedingResource));
        return fairShare;
    }

    /**
     * Get smart resource allocation info
     * Returns recommendations for how much of each resource to use
     */
    function getSmartResourceAllocation(slots) {
        const allocation = {};
        const unscheduledCount = getUnscheduledSubdivisionCount(slots);
        const allFields = window.loadGlobalSettings?.()?.app1?.fields || [];
        const allSpecials = window.loadGlobalSettings?.()?.app1?.specialActivities || [];

        // Calculate fair share for each resource
        [...allFields, ...allSpecials].forEach(resource => {
            const name = resource.name;
            const remaining = getRemainingFieldCapacity(name, slots);
            const totalNeedingResource = unscheduledCount + 1; // +1 for current
            const fairShare = calculateFairResourceShare(name, slots, totalNeedingResource);

            allocation[name] = {
                remaining,
                fairShare: Math.min(fairShare, remaining),
                othersWaiting: unscheduledCount
            };
        });

        return allocation;
    }

    // =========================================================================
    // UPDATE SCHEDULE STATUS AFTER GENERATION
    // =========================================================================

    /**
     * Mark a subdivision as having a draft schedule
     * Called after schedule generation
     */
    function markSubdivisionAsDraft(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) return;

        if (schedule.status === SCHEDULE_STATUS.LOCKED) {
            console.warn('[SubdivisionScheduler] Cannot modify locked schedule');
            return;
        }

        schedule.status = SCHEDULE_STATUS.DRAFT;
        schedule.lastModifiedAt = Date.now();
        schedule.lastModifiedBy = window.AccessControl?.getCurrentUserInfo?.()?.email || 'unknown';

        // Update schedule data
        schedule.scheduleData = extractScheduleDataForSubdivision(subdivisionId);
        schedule.fieldUsageClaims = extractFieldUsageClaimsForSubdivision(subdivisionId);

        saveSubdivisionSchedules();
    }

    /**
     * Mark all of current user's subdivisions as draft
     */
    function markCurrentUserSubdivisionsAsDraft() {
        _currentUserSubdivisions.forEach(sub => {
            markSubdivisionAsDraft(sub.id);
        });
    }

    // =========================================================================
    // RESTORE LOCKED SCHEDULE
    // =========================================================================

    /**
     * Restore a locked subdivision's schedule to the current schedule
     * Used when regenerating to preserve locked schedules
     */
    function restoreLockedSchedules() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));

        let restoredCount = 0;

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            // Only restore OTHER subdivisions' locked schedules
            if (mySubIds.has(subId)) continue;
            if (schedule.status !== SCHEDULE_STATUS.LOCKED) continue;

            const scheduleData = schedule.scheduleData || {};

            // Restore each bunk's schedule
            for (const [bunk, slots] of Object.entries(scheduleData)) {
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = [];
                }

                // Overwrite with locked data
                for (let i = 0; i < slots.length; i++) {
                    if (slots[i]) {
                        window.scheduleAssignments[bunk][i] = JSON.parse(JSON.stringify(slots[i]));
                        window.scheduleAssignments[bunk][i]._locked = true;
                        window.scheduleAssignments[bunk][i]._lockedSubdivision = subId;
                    }
                }
            }

            // Restore field usage claims
            const claims = schedule.fieldUsageClaims || {};
            for (const [slotIdx, slotClaims] of Object.entries(claims)) {
                if (!window.fieldUsageBySlot[slotIdx]) {
                    window.fieldUsageBySlot[slotIdx] = {};
                }

                for (const [fieldName, usage] of Object.entries(slotClaims)) {
                    if (!window.fieldUsageBySlot[slotIdx][fieldName]) {
                        window.fieldUsageBySlot[slotIdx][fieldName] = {
                            count: 0,
                            divisions: [],
                            bunks: {}
                        };
                    }

                    const existing = window.fieldUsageBySlot[slotIdx][fieldName];
                    existing.count += usage.count;
                    existing.divisions.push(...(usage.divisions || []));
                    existing._hasLockedClaim = true;

                    if (usage.bunks) {
                        Object.assign(existing.bunks, usage.bunks);
                    }
                }
            }

            restoredCount++;
        }

        console.log(`[SubdivisionScheduler] Restored ${restoredCount} locked subdivision schedules`);
        return restoredCount;
    }

    // =========================================================================
    // INTEGRATION WITH GLOBAL FIELD LOCKS
    // =========================================================================

    /**
     * Register locked subdivision claims in GlobalFieldLocks
     * Called at start of schedule generation
     */
    function registerLockedClaimsInGlobalLocks() {
        if (!window.GlobalFieldLocks) {
            console.warn('[SubdivisionScheduler] GlobalFieldLocks not available');
            return;
        }

        const claims = getLockedFieldUsageClaims();
        let registeredCount = 0;

        for (const [slotIdx, slotClaims] of Object.entries(claims)) {
            for (const [fieldName, usage] of Object.entries(slotClaims)) {
                const props = window.activityProperties?.[fieldName] || {};
                let maxCapacity = 1;
                if (props.sharableWith?.capacity) {
                    maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                } else if (props.sharable) {
                    maxCapacity = 2;
                }

                // If field is at capacity, lock it globally
                if (usage.count >= maxCapacity) {
                    window.GlobalFieldLocks.lockField(fieldName, [parseInt(slotIdx)], {
                        lockedBy: 'locked_subdivision',
                        leagueName: null,
                        division: (usage.divisions || []).join(', '),
                        activity: `Locked by ${(usage._lockedSubdivisions || []).length} subdivision(s)`
                    });
                    registeredCount++;
                }
            }
        }

        console.log(`[SubdivisionScheduler] Registered ${registeredCount} locked field claims in GlobalFieldLocks`);
    }

    // =========================================================================
    // DIVISION FILTERING FOR SCHEDULE GENERATION
    // =========================================================================

    /**
     * Get divisions that the current user should generate schedules for
     * Excludes divisions from locked subdivisions
     */
    function getDivisionsToSchedule() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const divisionsToSchedule = [];

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            // Only include our own subdivisions
            if (!mySubIds.has(subId)) continue;

            // Skip if locked (shouldn't happen but safety check)
            if (schedule.status === SCHEDULE_STATUS.LOCKED) continue;

            // Add divisions from this subdivision
            divisionsToSchedule.push(...(schedule.divisions || []));
        }

        return [...new Set(divisionsToSchedule)];
    }

    /**
     * Get bunks that the current user should generate schedules for
     */
    function getBunksToSchedule() {
        const divisionsToSchedule = getDivisionsToSchedule();
        const allDivisions = window.divisions || {};
        const bunks = [];

        divisionsToSchedule.forEach(divName => {
            const divBunks = allDivisions[divName]?.bunks || [];
            bunks.push(...divBunks);
        });

        return bunks;
    }

    /**
     * Check if a bunk belongs to a locked subdivision
     */
    function isBunkLocked(bunkName) {
        const allDivisions = window.divisions || {};
        
        // Find which division this bunk belongs to
        for (const [divName, divInfo] of Object.entries(allDivisions)) {
            if (divInfo.bunks?.includes(bunkName)) {
                return isDivisionLocked(divName);
            }
        }

        return false;
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    /**
     * Get status summary for all subdivisions
     */
    function getSubdivisionStatusSummary() {
        const summary = [];

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            const canEdit = canEditSubdivision(subId);

            summary.push({
                id: subId,
                name: schedule.subdivisionName,
                divisions: schedule.divisions,
                status: schedule.status,
                lockedBy: schedule.lockedBy,
                lockedAt: schedule.lockedAt,
                canEdit,
                isMySubdivision: canEdit
            });
        }

        return summary;
    }

    /**
     * Get lock status display info for a division
     */
    function getDivisionLockStatus(divisionName) {
        const sub = getSubdivisionForDivision(divisionName);
        if (!sub) {
            return { isLocked: false, canEdit: false, message: 'Division not found' };
        }

        const schedule = _subdivisionSchedules[sub.id];
        if (!schedule) {
            return { isLocked: false, canEdit: false, message: 'Schedule not found' };
        }

        const canEdit = canEditSubdivision(sub.id);
        const isLocked = schedule.status === SCHEDULE_STATUS.LOCKED;

        let message = '';
        if (isLocked) {
            const lockedBy = schedule.lockedBy?.name || schedule.lockedBy?.email || 'Unknown';
            const lockedAt = schedule.lockedAt ? new Date(schedule.lockedAt).toLocaleString() : 'Unknown time';
            message = `Locked by ${lockedBy} at ${lockedAt}`;
        } else if (!canEdit) {
            message = 'You do not have permission to edit this division';
        }

        return {
            isLocked,
            canEdit: canEdit && !isLocked,
            subdivisionId: sub.id,
            subdivisionName: schedule.subdivisionName,
            status: schedule.status,
            lockedBy: schedule.lockedBy,
            lockedAt: schedule.lockedAt,
            message
        };
    }

    // =========================================================================
    // DEBUG UTILITIES
    // =========================================================================

    /**
     * Debug: Print full status
     */
    function debugPrintStatus() {
        console.log('\n' + '='.repeat(70));
        console.log('SUBDIVISION SCHEDULE MANAGER STATUS');
        console.log('='.repeat(70));

        console.log('\nCurrent User Subdivisions:');
        _currentUserSubdivisions.forEach(sub => {
            console.log(`  ${sub.name} (${sub.id})`);
            console.log(`    Divisions: ${sub.divisions?.join(', ') || 'none'}`);
        });

        console.log('\nAll Subdivision Schedules:');
        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            const statusIcon = schedule.status === SCHEDULE_STATUS.LOCKED ? '🔒' :
                              schedule.status === SCHEDULE_STATUS.DRAFT ? '📝' : '⬜';
            const canEdit = canEditSubdivision(subId);
            
            console.log(`\n  ${statusIcon} ${schedule.subdivisionName}`);
            console.log(`     ID: ${subId}`);
            console.log(`     Status: ${schedule.status}`);
            console.log(`     Divisions: ${schedule.divisions?.join(', ') || 'none'}`);
            console.log(`     Can Edit: ${canEdit}`);
            
            if (schedule.lockedBy) {
                console.log(`     Locked By: ${schedule.lockedBy.email}`);
                console.log(`     Locked At: ${new Date(schedule.lockedAt).toLocaleString()}`);
            }

            const claimCount = Object.keys(schedule.fieldUsageClaims || {}).length;
            console.log(`     Field Claims: ${claimCount} slots`);
        }

        console.log('\nLocked Claims from Others:');
        const claims = getLockedFieldUsageClaims();
        const claimSlots = Object.keys(claims);
        console.log(`  ${claimSlots.length} slots with claims`);
        
        claimSlots.slice(0, 5).forEach(slotIdx => {
            console.log(`  Slot ${slotIdx}: ${Object.keys(claims[slotIdx]).join(', ')}`);
        });

        console.log('\n' + '='.repeat(70));
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.SubdivisionScheduleManager = {
        // Initialization
        initialize,
        isInitialized,

        // Constants
        SCHEDULE_STATUS,

        // Subdivision access
        getEditableSubdivisions,
        getAllSubdivisions,
        canEditSubdivision,
        canEditDivision,
        getSubdivisionForDivision,

        // Schedule status
        getSubdivisionSchedule,
        getAllSubdivisionSchedules,
        isSubdivisionLocked,
        isDivisionLocked,
        getOtherLockedSubdivisions,

        // Locking
        lockSubdivisionSchedule,
        unlockSubdivisionSchedule,

        // Cross-subdivision awareness
        getLockedFieldUsageClaims,
        isFieldClaimedByOthers,
        getRemainingFieldCapacity,

        // Smart resource sharing
        getUnscheduledSubdivisionCount,
        calculateFairResourceShare,
        getSmartResourceAllocation,

        // Schedule generation helpers
        markSubdivisionAsDraft,
        markCurrentUserSubdivisionsAsDraft,
        restoreLockedSchedules,
        registerLockedClaimsInGlobalLocks,
        getDivisionsToSchedule,
        getBunksToSchedule,
        isBunkLocked,

        // UI helpers
        getSubdivisionStatusSummary,
        getDivisionLockStatus,

        // Debug
        debugPrintStatus
    };

    console.log('[SubdivisionScheduler] Module loaded');

})();
