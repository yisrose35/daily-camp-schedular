// ============================================================================
// subdivision_schedule_manager.js (v1.12 - SNAPSHOT & INIT FIX)
// ============================================================================
// MULTI-SCHEDULER SYSTEM: Allows multiple schedulers to create schedules for
// their assigned subdivisions while respecting each other's locked schedules.
//
// UPDATE v1.12:
// - Added getLockedScheduleSnapshot() to pass data to Scheduler Core
// - Improved initialization robustness (ensureInitialized)
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
    let _initializingPromise = null;
    let _currentUserSubdivisions = [];
    let _allSubdivisions = [];
    let _subdivisionSchedules = {};

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_initialized) return true;
        if (_initializingPromise) return _initializingPromise;

        _initializingPromise = (async () => {
            console.log('[SubdivisionScheduler] Initializing...');

            // Wait for AccessControl to be ready
            let attempts = 0;
            while (!window.AccessControl?.isInitialized && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            if (!window.AccessControl?.isInitialized) {
                console.warn('[SubdivisionScheduler] AccessControl timed out or not available.');
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
        })();

        return _initializingPromise;
    }

    // Helper to ensure we are ready before doing work
    async function ensureInitialized() {
        if (_initialized) return true;
        return initialize();
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
    // SNAPSHOT GENERATION (CRITICAL FOR INTEGRATION)
    // =========================================================================

    /**
     * Returns a snapshot of schedules from ALL subdivisions NOT assigned to the current user.
     * This allows the scheduler core to "restore" these as fixed blocks.
     */
    function getLockedScheduleSnapshot() {
        const snapshot = {};
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            // 1. Skip Empty
            if (schedule.status === SCHEDULE_STATUS.EMPTY) continue;

            // 2. Logic: Who do we include in the snapshot?
            // If I am Owner: I generally want to see everything, but if I am "editing everything",
            // I might not want them locked. However, typically owners want to preserve what exists
            // unless they explicitly clear it.
            // If I am Scheduler: I MUST see everything that isn't mine as locked.

            let includeInSnapshot = false;

            if (isOwner) {
                // Owner generating: Don't treat anything as "locked" in the snapshot sense
                // because we want the owner to be able to regenerate everything if they choose 'Generate All'.
                // If the owner wants to lock specific divisions, they should do partial generation.
                includeInSnapshot = false;
            } else {
                // Scheduler: Include anything I don't own
                if (!mySubIds.has(subId)) {
                    includeInSnapshot = true;
                }
            }

            if (!includeInSnapshot) continue;

            // Merge schedule data into snapshot
            const subData = schedule.scheduleData || {};
            for (const [bunkName, slots] of Object.entries(subData)) {
                if (!snapshot[bunkName]) {
                    snapshot[bunkName] = slots; // Array of slot objects
                }
            }
        }

        return snapshot;
    }

    // =========================================================================
    // LOCKING ACTIONS
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
    // DATA EXTRACTION & CLAIM MANAGEMENT
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

    function getLockedFieldUsageClaims() {
        const claims = {};
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (schedule.status === SCHEDULE_STATUS.EMPTY) continue;

            let treatAsLock = false;
            if (isOwner) {
                treatAsLock = false; 
            } else {
                // If it's NOT my subdivision, I must respect it (Draft OR Locked)
                if (mySubIds.has(subId)) {
                    treatAsLock = false;
                } else {
                    treatAsLock = true;
                }
            }

            if (!treatAsLock) continue;

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
                    
                    const statusText = schedule.status === SCHEDULE_STATUS.DRAFT ? '(Draft)' : '(Locked)';
                    claims[slotIdx][fieldName]._lockedSubdivisions.push(`${schedule.subdivisionName} ${statusText}`);

                    if (usage.bunks) {
                        Object.assign(claims[slotIdx][fieldName].bunks, usage.bunks);
                    }
                }
            }
        }

        return claims;
    }

    function registerLockedClaimsInGlobalLocks() {
        if (!window.GlobalFieldLocks) {
            console.warn('[SubdivisionScheduler] GlobalFieldLocks not available');
            return;
        }

        const claims = getLockedFieldUsageClaims();
        let registeredCount = 0;
        
        console.log('[SubdivisionScheduler] 🔒 Applying external locks/constraints...');

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
                    const lockMsg = `Constraint: ${(usage._lockedSubdivisions || []).join(', ')}`;

                    window.GlobalFieldLocks.lockField(fieldName, [parseInt(slotIdx)], {
                        lockedBy: 'locked_subdivision',
                        leagueName: null,
                        division: (usage.divisions || []).join(', '),
                        activity: lockMsg
                    });
                    
                    console.log(`   ⛔ Blocked "${fieldName}" at Slot ${slotIdx} (${lockMsg})`);
                    registeredCount++;
                }
            }
        }

        console.log(`[SubdivisionScheduler] Registered ${registeredCount} locked field claims in GlobalFieldLocks`);
    }

    // =========================================================================
    // RESTORE (Legacy / Helper)
    // =========================================================================
    // Note: Scheduler Core uses getLockedScheduleSnapshot() + Step 1.5 instead of this
    // for direct generation, but this is useful for pre-flight checks.

    function restoreLockedSchedules() {
        // This functionality is now largely handled by getLockedScheduleSnapshot passed to the core
        console.log('[SubdivisionScheduler] restoreLockedSchedules called (Legacy Mode)');
        // We keep it for backward compatibility if needed, but it modifies globals directly.
        // The integration layer should prefer passing snapshots.
        return 0; 
    }

    // =========================================================================
    // DIVISION FILTERING & STATUS UPDATE
    // =========================================================================

    function getDivisionsToSchedule() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const divisionsToSchedule = new Set();

        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        // 1. Collect from assigned subdivisions
        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (!isOwner && !mySubIds.has(subId)) continue;
            // Standard users cannot edit locked schedules, but we assume they can generate DRAFTS for their own.
            // If their OWN schedule is locked, they can still generate (overwriting it essentially, 
            // though UI usually asks to unlock first). 
            
            (schedule.divisions || []).forEach(d => divisionsToSchedule.add(d));
        }

        // 2. Owner collects Orphans
        if (isOwner) {
            const allDivisions = Object.keys(window.divisions || {});
            const assignedDivisions = new Set();
            Object.values(_subdivisionSchedules).forEach(sch => {
                (sch.divisions || []).forEach(d => assignedDivisions.add(d));
            });

            allDivisions.forEach(div => {
                if (!assignedDivisions.has(div)) {
                    divisionsToSchedule.add(div);
                }
            });
        }

        return [...divisionsToSchedule];
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

    function markSubdivisionAsDraft(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) return;

        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        if (!isOwner && schedule.status === SCHEDULE_STATUS.LOCKED) {
            // If it's locked, we generally shouldn't be editing it, but if we just generated
            // a schedule, we implicitly transition it to draft or update the lock data.
            // For safety, let's allow updating the data but keep the status if locked?
            // No, generation usually implies a new Draft.
            console.warn('[SubdivisionScheduler] Modifying locked schedule...');
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
            _allSubdivisions.forEach(sub => {
                const schedule = _subdivisionSchedules[sub.id];
                if (schedule) markSubdivisionAsDraft(sub.id);
            });
        } else {
            _currentUserSubdivisions.forEach(sub => {
                markSubdivisionAsDraft(sub.id);
            });
        }
    }

    // =========================================================================
    // UI HELPERS (Unchanged mostly)
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
        if (!sub) return { isLocked: false, canEdit: false, message: 'Division not found' };

        const schedule = _subdivisionSchedules[sub.id];
        if (!schedule) return { isLocked: false, canEdit: false, message: 'Schedule not found' };

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

    function debugPrintStatus() {
        console.log('--- SubdivisionScheduler Status ---');
        console.log('Init:', _initialized);
        console.log('Schedules:', Object.keys(_subdivisionSchedules).length);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.SubdivisionScheduleManager = {
        initialize,
        ensureInitialized,
        get isInitialized() { return _initialized; },
        SCHEDULE_STATUS,
        getEditableSubdivisions,
        getAllSubdivisions,
        canEditSubdivision,
        canEditDivision,
        getSubdivisionForDivision,
        getSubdivisionSchedule,
        getAllSubdivisionSchedules,
        isSubdivisionLocked,
        isDivisionLocked,
        getOtherLockedSubdivisions,
        lockSubdivisionSchedule,
        unlockSubdivisionSchedule,
        getLockedFieldUsageClaims,
        getLockedScheduleSnapshot, // NEW
        markSubdivisionAsDraft,
        markCurrentUserSubdivisionsAsDraft,
        restoreLockedSchedules,
        registerLockedClaimsInGlobalLocks,
        getDivisionsToSchedule,
        getBunksToSchedule,
        isBunkLocked,
        getSubdivisionStatusSummary,
        getDivisionLockStatus,
        debugPrintStatus
    };

    console.log('[SubdivisionScheduler] Module loaded v1.12');

})();
