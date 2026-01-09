// ============================================================================
// subdivision_schedule_manager.js (v1.13 - PROPER BACKGROUND RESTORATION)
// ============================================================================
// MULTI-SCHEDULER SYSTEM: Allows multiple schedulers to create schedules for
// their assigned subdivisions while respecting each other's locked schedules.
//
// KEY FIX in v1.13:
// - Properly extracts and saves scheduleData when marking as draft
// - Background restoration now works by loading from cloud first
// - Added debug logging for restoration process
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
    let _currentDateKey = null;

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        console.log('[SubdivisionScheduler] Initializing v1.13...');

        // Wait for AccessControl to be ready
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
        
        // Get current date
        _currentDateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];

        await loadSubdivisionSchedules();

        _initialized = true;
        console.log('[SubdivisionScheduler] Initialized');
        console.log(`  Current user has access to ${_currentUserSubdivisions.length} subdivisions`);
        console.log(`  Camp has ${_allSubdivisions.length} total subdivisions`);
        console.log(`  Current date: ${_currentDateKey}`);

        window.dispatchEvent(new CustomEvent('subdivisionSchedulerReady'));

        return true;
    }

    // =========================================================================
    // DATA LOADING/SAVING
    // =========================================================================

    async function loadSubdivisionSchedules() {
        // First, load from local daily data
        const dailyData = window.loadCurrentDailyData?.() || {};
        const dateData = dailyData[_currentDateKey] || dailyData;
        _subdivisionSchedules = dateData.subdivisionSchedules || {};
        
        console.log('[SubdivisionScheduler] Loading schedules for date:', _currentDateKey);
        console.log('[SubdivisionScheduler] Found subdivision schedules:', Object.keys(_subdivisionSchedules).length);

        // Initialize any missing subdivisions
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
            } else {
                // Ensure divisions list is up to date
                _subdivisionSchedules[sub.id].subdivisionName = sub.name;
                _subdivisionSchedules[sub.id].divisions = sub.divisions || [];
            }
        });

        console.log('[SubdivisionScheduler] Loaded schedules:', Object.keys(_subdivisionSchedules).length);
        
        // Debug: log status of each subdivision
        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            console.log(`  [${schedule.status}] ${schedule.subdivisionName}: ${schedule.divisions?.join(', ') || 'no divisions'}`);
            if (schedule.scheduleData && Object.keys(schedule.scheduleData).length > 0) {
                console.log(`      Has ${Object.keys(schedule.scheduleData).length} bunks of saved data`);
            }
        }
    }

    function saveSubdivisionSchedules() {
        // Save to the correct date key
        const dailyData = window.loadCurrentDailyData?.() || {};
        
        if (!dailyData[_currentDateKey]) {
            dailyData[_currentDateKey] = {};
        }
        
        dailyData[_currentDateKey].subdivisionSchedules = _subdivisionSchedules;
        
        // Save the whole thing
        try {
            localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
        } catch (e) {
            console.error('[SubdivisionScheduler] Failed to save:', e);
        }
        
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
            // Include both LOCKED and DRAFT schedules from OTHER users
            if (schedule.status !== SCHEDULE_STATUS.EMPTY && !mySubIds.has(subId)) {
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

        // Extract current schedule data
        const scheduleData = extractScheduleDataForSubdivision(subdivisionId);
        const fieldUsageClaims = extractFieldUsageClaimsForSubdivision(subdivisionId);

        schedule.status = SCHEDULE_STATUS.LOCKED;
        schedule.lockedBy = userInfo;
        schedule.lockedAt = Date.now();
        schedule.scheduleData = scheduleData;
        schedule.fieldUsageClaims = fieldUsageClaims;

        saveSubdivisionSchedules();

        console.log(`[SubdivisionScheduler] 🔒 LOCKED: ${schedule.subdivisionName}`);
        console.log(`[SubdivisionScheduler]   Saved ${Object.keys(scheduleData).length} bunks`);

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
            return { success: false, error: 'Not authorized to unlock.' };
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
        let bunkCount = 0;
        let slotCount = 0;

        divisions.forEach(divName => {
            const bunks = allDivisions[divName]?.bunks || [];
            bunks.forEach(bunk => {
                if (scheduleAssignments[bunk] && scheduleAssignments[bunk].length > 0) {
                    // Deep copy and filter out empty slots
                    const bunkData = scheduleAssignments[bunk].map(slot => 
                        slot ? JSON.parse(JSON.stringify(slot)) : null
                    );
                    
                    // Only save if there's actual data
                    const hasData = bunkData.some(s => s !== null);
                    if (hasData) {
                        data[bunk] = bunkData;
                        bunkCount++;
                        slotCount += bunkData.filter(s => s !== null).length;
                    }
                }
            });
        });

        console.log(`[SubdivisionScheduler] Extracted ${bunkCount} bunks, ${slotCount} slots for ${schedule.subdivisionName}`);

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
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (schedule.status === SCHEDULE_STATUS.EMPTY) continue;

            let treatAsLock = false;

            if (isOwner) {
                treatAsLock = false; 
            } else {
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

    function isFieldClaimedByOthers(fieldName, slots, divisionContext) {
        const claims = getLockedFieldUsageClaims();
        const props = window.activityProperties?.[fieldName] || {};
        
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable) {
            maxCapacity = 2;
        }

        let totalClaimed = 0;
        const claimedBy = new Set();

        for (const slotIdx of slots) {
            const slotClaims = claims[slotIdx];
            if (!slotClaims || !slotClaims[fieldName]) continue;

            const fieldClaim = slotClaims[fieldName];
            const otherDivisions = (fieldClaim.divisions || []).filter(d => d !== divisionContext);
            
            if (otherDivisions.length > 0) {
                totalClaimed = Math.max(totalClaimed, fieldClaim.count || 0);
                (fieldClaim._lockedSubdivisions || []).forEach(s => claimedBy.add(s));
            }
        }

        const remainingCapacity = Math.max(0, maxCapacity - totalClaimed);

        return {
            claimed: totalClaimed > 0,
            claimedBy: [...claimedBy],
            totalClaimed,
            maxCapacity,
            remainingCapacity
        };
    }

    function getRemainingFieldCapacity(fieldName, slots) {
        const result = isFieldClaimedByOthers(fieldName, slots, null);
        return result.remainingCapacity;
    }

    function getUnscheduledSubdivisionCount() {
        let count = 0;
        for (const schedule of Object.values(_subdivisionSchedules)) {
            if (schedule.status === SCHEDULE_STATUS.EMPTY) {
                count++;
            }
        }
        return count;
    }

    function calculateFairResourceShare(resourceName, totalAvailable) {
        const totalSubdivisions = _allSubdivisions.length;
        if (totalSubdivisions === 0) return totalAvailable;

        const mySubCount = _currentUserSubdivisions.length;
        if (mySubCount === 0) return 0;

        const fairShare = Math.floor((mySubCount / totalSubdivisions) * totalAvailable);
        return Math.max(1, fairShare);
    }

    function getSmartResourceAllocation(slots) {
        const allocation = {};
        const unscheduledCount = getUnscheduledSubdivisionCount();
        
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || [];
        const specials = globalSettings.app1?.specialActivities || [];

        const allResources = [
            ...fields.map(f => f.name),
            ...specials.map(s => s.name)
        ];

        for (const resourceName of allResources) {
            const props = window.activityProperties?.[resourceName] || {};
            
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                maxCapacity = 2;
            }

            const totalAvailable = slots.length * maxCapacity;
            const claimInfo = isFieldClaimedByOthers(resourceName, slots, null);
            const currentUsage = claimInfo.totalClaimed;
            const remaining = totalAvailable - currentUsage;
            const fairShare = calculateFairResourceShare(resourceName, remaining);

            allocation[resourceName] = {
                fairShare,
                currentUsage,
                remaining,
                totalAvailable,
                maxCapacity,
                othersWaiting: unscheduledCount
            };
        }

        return allocation;
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
    // ★★★ CRITICAL FIX: RESTORE LOCKED SCHEDULES ★★★
    // =========================================================================

    function restoreLockedSchedules() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        let restoredBunks = 0;
        let restoredSlots = 0;

        console.log('[SubdivisionScheduler] Restoring background schedules...');
        console.log(`[SubdivisionScheduler]   My subdivisions: ${[..._currentUserSubdivisions.map(s => s.name)].join(', ') || 'none'}`);
        console.log(`[SubdivisionScheduler]   Is Owner/Admin: ${isOwner}`);

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            // Owners don't need to restore anything as "locked" - they can edit everything
            if (isOwner) continue;
            
            // Skip my own subdivisions
            if (mySubIds.has(subId)) {
                console.log(`[SubdivisionScheduler]   Skipping my subdivision: ${schedule.subdivisionName}`);
                continue;
            }
            
            // Skip empty subdivisions
            if (schedule.status === SCHEDULE_STATUS.EMPTY) {
                console.log(`[SubdivisionScheduler]   Skipping empty: ${schedule.subdivisionName}`);
                continue;
            }

            const scheduleData = schedule.scheduleData || {};
            const bunkCount = Object.keys(scheduleData).length;
            
            if (bunkCount === 0) {
                console.log(`[SubdivisionScheduler]   ${schedule.subdivisionName} has no saved schedule data`);
                continue;
            }

            console.log(`[SubdivisionScheduler]   ✓ Restoring ${schedule.subdivisionName}: ${bunkCount} bunks`);

            for (const [bunk, slots] of Object.entries(scheduleData)) {
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = [];
                }

                for (let i = 0; i < slots.length; i++) {
                    if (slots[i]) {
                        window.scheduleAssignments[bunk][i] = JSON.parse(JSON.stringify(slots[i]));
                        window.scheduleAssignments[bunk][i]._locked = true;
                        window.scheduleAssignments[bunk][i]._lockedSubdivision = subId;
                        restoredSlots++;
                    }
                }
                restoredBunks++;
            }

            // Also restore field usage claims
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
        }

        console.log(`[SubdivisionScheduler] Restored ${restoredBunks} bunks, ${restoredSlots} slots from background schedules`);
        return restoredBunks;
    }

    // =========================================================================
    // DIVISION FILTERING
    // =========================================================================

    function getDivisionsToSchedule() {
        const mySubIds = new Set(_currentUserSubdivisions.map(s => s.id));
        const divisionsToSchedule = new Set();

        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        for (const [subId, schedule] of Object.entries(_subdivisionSchedules)) {
            if (!isOwner && !mySubIds.has(subId)) continue;
            if (!isOwner && schedule.status === SCHEDULE_STATUS.LOCKED) continue;
            
            (schedule.divisions || []).forEach(d => divisionsToSchedule.add(d));
        }

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
                isMySubdivision: canEdit,
                hasSavedData: Object.keys(schedule.scheduleData || {}).length > 0
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
    // ★★★ CRITICAL FIX: MARK AS DRAFT WITH PROPER DATA EXTRACTION ★★★
    // =========================================================================

    function markSubdivisionAsDraft(subdivisionId) {
        const schedule = _subdivisionSchedules[subdivisionId];
        if (!schedule) {
            console.warn(`[SubdivisionScheduler] Cannot mark draft - subdivision ${subdivisionId} not found`);
            return;
        }

        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        if (!isOwner && schedule.status === SCHEDULE_STATUS.LOCKED) {
            console.warn('[SubdivisionScheduler] Cannot modify locked schedule');
            return;
        }

        // ★★★ KEY: Extract and save the current schedule data ★★★
        const scheduleData = extractScheduleDataForSubdivision(subdivisionId);
        const fieldUsageClaims = extractFieldUsageClaimsForSubdivision(subdivisionId);
        
        const hasSavedData = Object.keys(scheduleData).length > 0;

        schedule.status = hasSavedData ? SCHEDULE_STATUS.DRAFT : SCHEDULE_STATUS.EMPTY;
        schedule.lastModifiedAt = Date.now();
        schedule.lastModifiedBy = window.AccessControl?.getCurrentUserInfo?.()?.email || 'unknown';
        schedule.scheduleData = scheduleData;
        schedule.fieldUsageClaims = fieldUsageClaims;

        console.log(`[SubdivisionScheduler] Marked ${schedule.subdivisionName} as ${schedule.status}`);
        console.log(`[SubdivisionScheduler]   Saved ${Object.keys(scheduleData).length} bunks of data`);

        saveSubdivisionSchedules();
    }

    function markCurrentUserSubdivisionsAsDraft() {
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';

        console.log('[SubdivisionScheduler] Marking subdivisions as draft...');

        if (isOwner) {
            // Owner marks ALL subdivisions with data
            _allSubdivisions.forEach(sub => {
                markSubdivisionAsDraft(sub.id);
            });
        } else {
            // Schedulers only mark THEIR subdivisions
            _currentUserSubdivisions.forEach(sub => {
                markSubdivisionAsDraft(sub.id);
            });
        }
    }

    // =========================================================================
    // DEBUG
    // =========================================================================

    function debugPrintStatus() {
        console.log('\n' + '='.repeat(70));
        console.log('SUBDIVISION SCHEDULE MANAGER STATUS v1.13');
        console.log('='.repeat(70));
        console.log('Current Date:', _currentDateKey);

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
            const dataCount = Object.keys(schedule.scheduleData || {}).length;
            
            console.log(`\n  ${statusIcon} ${schedule.subdivisionName}`);
            console.log(`     ID: ${subId}`);
            console.log(`     Status: ${schedule.status}`);
            console.log(`     Divisions: ${schedule.divisions?.join(', ') || 'none'}`);
            console.log(`     Can Edit: ${canEdit}`);
            console.log(`     Saved Bunks: ${dataCount}`);
            
            if (schedule.lockedBy) {
                console.log(`     Locked By: ${schedule.lockedBy.email}`);
            }
        }

        console.log('\n' + '='.repeat(70));
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.SubdivisionScheduleManager = {
        initialize,
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
        isFieldClaimedByOthers,
        getRemainingFieldCapacity,

        getUnscheduledSubdivisionCount,
        calculateFairResourceShare,
        getSmartResourceAllocation,

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

    console.log('[SubdivisionScheduler] Module loaded v1.13 (Proper Background Restoration)');

})();
