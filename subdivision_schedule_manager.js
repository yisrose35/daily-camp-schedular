// ============================================================================
// subdivision_schedule_manager.js (v1.2 - OWNER FIX)
// ============================================================================
// MULTI-SCHEDULER SYSTEM: Allows multiple schedulers to create schedules for
// their assigned subdivisions while respecting each other's locked schedules.
//
// FIX in v1.2: 
// - Owners/Admins now implicitly schedule ALL unlocked subdivisions
// - Owners/Admins mark ALL unlocked subdivisions as draft after running
// ============================================================================

(function() {
    'use strict';

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    const SCHEDULE_STATUS = {
        EMPTY: 'empty',
        DRAFT: 'draft',
        LOCKED: 'locked'
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _initialized = false;
    let _currentUserSubdivisions = [];
    let _allSubdivisions = [];
    let _subdivisionSchedules = {};

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        console.log('[SubdivisionScheduler] Initializing...');

        // Wait for AccessControl to be ready
        // FIXED: isInitialized is a getter property
        if (!window.AccessControl?.isInitialized) {
            console.log('[SubdivisionScheduler] Waiting for AccessControl...');
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (window.AccessControl?.isInitialized) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
                setTimeout(() => {
                    clearInterval(check);
                    resolve();
                }, 10000);
            });
        }

        _currentUserSubdivisions = window.AccessControl?.getUserSubdivisions?.() || [];
        _allSubdivisions = window.AccessControl?.getAllSubdivisions?.() || [];

        await loadSubdivisionSchedules();

        _initialized = true;
        console.log('[SubdivisionScheduler] Initialized');
        console.log(`  Current user has access to ${_currentUserSubdivisions.length} subdivisions`);
        console.log(`  Camp has ${_allSubdivisions.length} total subdivisions`);

        window.dispatchEvent(new CustomEvent('subdivisionSchedulerReady'));

        return true;
    }

    // =========================================================================
    // DATA LOADING/SAVING
    // =========================================================================

    async function loadSubdivisionSchedules() {
        const dailyData = window.loadCurrentDailyData?.() || {};
        _subdivisionSchedules = dailyData.subdivisionSchedules || {};

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

    function saveSubdivisionSchedules() {
        window.saveCurrentDailyData?.('subdivisionSchedules', _subdivisionSchedules);
        scheduleCloudSync();
    }

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

    function getEditableSubdivisions() {
        return _currentUserSubdivisions;
    }

    function getAllSubdivisions() {
        return _allSubdivisions;
    }

    function canEditSubdivision(subdivisionId) {
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            return true;
        }
        return _currentUserSubdivisions.some(sub => sub.id === subdivisionId);
    }

    function getSubdivisionForDivision(divisionName) {
        for (const sub of _allSubdivisions) {
            if (sub.divisions?.includes(divisionName)) {
                return sub;
            }
        }
        return null;
    }

    function canEditDivision(divisionName) {
        const sub = getSubdivisionForDivision(divisionName);
        if (!sub) return false;
        return canEditSubdivision(sub.id);
    }

    // =========================================================================
    // SCHEDULE STATUS MANAGEMENT
    // =========================================================================

    function getSubdivisionSchedule(subdivisionId) {
        return _subdivisionSchedules[subdivisionId] || null;
    }

    function getAllSubdivisionSchedules() {
        return { ..._subdivisionSchedules };
    }

    function isSubdivisionLocked(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        return schedule?.status === SCHEDULE_STATUS.LOCKED;
    }

    function isDivisionLocked(divisionName) {
        const sub = getSubdivisionForDivision(divisionName);
        if (!sub) return false;
        return isSubdivisionLocked(sub.id);
    }

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

        const userInfo = window.AccessControl?.getCurrentUserInfo?.() || {
            userId: 'unknown',
            email: 'unknown',
            name: 'Unknown User'
        };

        const scheduleData = extractScheduleDataForSubdivision(subdivisionId);
        const fieldUsageClaims = extractFieldUsageClaimsForSubdivision(subdivisionId);

        schedule.status = SCHEDULE_STATUS.LOCKED;
        schedule.lockedBy = userInfo;
        schedule.lockedAt = Date.now();
        schedule.scheduleData = scheduleData;
        schedule.fieldUsageClaims = fieldUsageClaims;

        saveSubdivisionSchedules();

        console.log(`[SubdivisionScheduler] 🔒 LOCKED: ${schedule.subdivisionName}`);

        window.dispatchEvent(new CustomEvent('subdivisionScheduleLocked', {
            detail: { subdivisionId, schedule }
        }));

        return { success: true, schedule };
    }

    function unlockSubdivisionSchedule(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) {
            return { success: false, error: 'Subdivision not found' };
        }

        if (schedule.status !== SCHEDULE_STATUS.LOCKED) {
            return { success: false, error: 'Schedule is not locked' };
        }

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

        schedule.status = SCHEDULE_STATUS.DRAFT;
        schedule.lockedBy = null;
        schedule.lockedAt = null;

        saveSubdivisionSchedules();

        console.log(`[SubdivisionScheduler] 🔓 UNLOCKED: ${schedule.subdivisionName}`);

        window.dispatchEvent(new CustomEvent('subdivisionScheduleUnlocked', {
            detail: { subdivisionId, schedule }
        }));

        return { success: true, schedule };
    }

    // =========================================================================
    // SCHEDULE DATA EXTRACTION
    // =========================================================================

    function extractScheduleDataForSubdivision(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) return {};

        const divisions = schedule.divisions || [];
        const allDivisions = window.divisions || {};
        const scheduleAssignments = window.scheduleAssignments || {};

        const data = {};

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

    function extractFieldUsageClaimsForSubdivision(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) return {};

        const divisions = schedule.divisions || [];
        const divisionsSet = new Set(divisions);
        const fieldUsageBySlot = window.fieldUsageBySlot || {};

        const claims = {};

        for (const [slotIdx, slotUsage] of Object.entries(fieldUsageBySlot)) {
            for (const [fieldName, usage] of Object.entries(slotUsage || {})) {
                const matchingDivisions = (usage.divisions || []).filter(d => divisionsSet.has(d));
                
                if (matchingDivisions.length > 0) {
                    if (!claims[slotIdx]) claims[slotIdx] = {};
                    
                    claims[slotIdx][fieldName] = {
                        count: usage.count || 1,
                        divisions: matchingDivisions,
                        bunks: {},
                        _lockedBy: subdivisionId
                    };

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

    function getLockedFieldUsageClaims() {
        const claims = {};
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (schedule.status !== SCHEDULE_STATUS.LOCKED) continue;
            if (mySubIds.has(subId)) continue;

            const subClaims = schedule.fieldUsageClaims || {};

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

                    claims[slotIdx][fieldName].count += (usage.count || 0);
                    claims[slotIdx][fieldName].divisions.push(...(usage.divisions || []));
                    claims[slotIdx][fieldName]._lockedSubdivisions.push(subId);

                    if (usage.bunks) {
                        Object.assign(claims[slotIdx][fieldName].bunks, usage.bunks);
                    }
                }
            }
        }

        return claims;
    }

    function isFieldClaimedByOthers(fieldName, slots, divisionContext) {
        const claims = getLockedFieldUsageClaims();
        
        for (const slotIdx of slots) {
            const slotClaims = claims[slotIdx];
            if (!slotClaims) continue;

            const fieldClaim = slotClaims[fieldName];
            if (!fieldClaim) continue;

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

    function getUnscheduledSubdivisionCount(slots) {
        let count = 0;

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (schedule.status === SCHEDULE_STATUS.EMPTY) {
                count++;
            }
        }

        return count;
    }

    function calculateFairResourceShare(fieldName, slots, totalDivisionsNeedingResource) {
        const props = window.activityProperties?.[fieldName] || {};
        
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable) {
            maxCapacity = 2;
        }

        if (totalDivisionsNeedingResource <= 1) {
            return maxCapacity;
        }

        const fairShare = Math.max(1, Math.floor(maxCapacity / totalDivisionsNeedingResource));
        return fairShare;
    }

    function getSmartResourceAllocation(slots) {
        const allocation = {};
        const unscheduledCount = getUnscheduledSubdivisionCount(slots);
        const allFields = window.loadGlobalSettings?.()?.app1?.fields || [];
        const allSpecials = window.loadGlobalSettings?.()?.app1?.specialActivities || [];

        [...allFields, ...allSpecials].forEach(resource => {
            const name = resource.name;
            const remaining = getRemainingFieldCapacity(name, slots);
            const totalNeedingResource = unscheduledCount + 1;
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
    // UPDATE SCHEDULE STATUS
    // =========================================================================

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

        schedule.scheduleData = extractScheduleDataForSubdivision(subdivisionId);
        schedule.fieldUsageClaims = extractFieldUsageClaimsForSubdivision(subdivisionId);

        saveSubdivisionSchedules();
    }

    function markCurrentUserSubdivisionsAsDraft() {
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        if (isOwner) {
            // FIX: Owners mark all UNLOCKED subdivisions as draft
            _allSubdivisions.forEach(sub => {
                const schedule = _subdivisionSchedules[sub.id];
                // Do not touch locked schedules
                if (schedule && schedule.status !== SCHEDULE_STATUS.LOCKED) {
                    markSubdivisionAsDraft(sub.id);
                }
            });
        } else {
            // Standard users only mark their assigned subdivisions
            _currentUserSubdivisions.forEach(sub => {
                markSubdivisionAsDraft(sub.id);
            });
        }
    }

    // =========================================================================
    // RESTORE LOCKED SCHEDULES
    // =========================================================================

    function restoreLockedSchedules() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));

        let restoredCount = 0;

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (mySubIds.has(subId)) continue;
            if (schedule.status !== SCHEDULE_STATUS.LOCKED) continue;

            const scheduleData = schedule.scheduleData || {};

            for (const [bunk, slots] of Object.entries(scheduleData)) {
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = [];
                }

                for (let i = 0; i < slots.length; i++) {
                    if (slots[i]) {
                        window.scheduleAssignments[bunk][i] = JSON.parse(JSON.stringify(slots[i]));
                        window.scheduleAssignments[bunk][i]._locked = true;
                        window.scheduleAssignments[bunk][i]._lockedSubdivision = subId;
                    }
                }
            }

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
    // DIVISION FILTERING
    // =========================================================================

    function getDivisionsToSchedule() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const divisionsToSchedule = [];

        // FIX: Owners implicitly schedule ALL unlocked subdivisions
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            // For owners, we include everything. For users, only assigned.
            if (!isOwner && !mySubIds.has(subId)) continue;
            
            // Never schedule locked subdivisions
            if (schedule.status === SCHEDULE_STATUS.LOCKED) continue;
            
            divisionsToSchedule.push(...(schedule.divisions || []));
        }

        return [...new Set(divisionsToSchedule)];
    }

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

    function isBunkLocked(bunkName) {
        const allDivisions = window.divisions || {};
        
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
    // DEBUG
    // =========================================================================

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

        console.log('\n' + '='.repeat(70));
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.SubdivisionScheduleManager = {
        // Initialization
        initialize,
        // FIXED: isInitialized as getter property
        get isInitialized() { return _initialized; },

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

    console.log('[SubdivisionScheduler] Module loaded v1.2');

})();
