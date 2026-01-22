// =============================================================================
// POST-GENERATION EDIT SYSTEM v3.1 - CLIENT UI ONLY
// =============================================================================
// 
// FEATURES:
// - Modal UI for editing cells post-generation
// - Activity name and location/field selection
// - Optional time change (hidden by default, shown on request)
// - Scans current schedule for field conflicts
// - DELEGATES REGENERATION to unified_schedule_system.js globals:
//   * window.resolveConflictsAndApply
//   * window.smartRegenerateConflicts
// - BYPASS MODE: When scheduler bypasses RBAC, they become admin-like
//   and can modify ANY bunk with full regeneration privileges
//
// INTEGRATION: Add this file AFTER unified_schedule_system.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('📝 Post-Generation Edit System v3.1 (UI Client) loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const DEBUG = true;
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";

    // REMOVED: ROTATION_CONFIG (Moved to unified_schedule_system.js)

    // =========================================================================
    // DEBUG LOGGING
    // =========================================================================

    function debugLog(...args) {
        if (DEBUG) console.log('[PostEdit]', ...args);
    }

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        
        let s = str.trim().toLowerCase();
        let meridiem = null;
        
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridiem = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        
        const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
        if (match24) {
            let h = parseInt(match24[1], 10);
            const m = parseInt(match24[2], 10);
            
            if (meridiem) {
                if (h === 12) h = (meridiem === 'am' ? 0 : 12);
                else if (meridiem === 'pm' && h < 12) h += 12;
            }
            
            return h * 60 + m;
        }
        
        return null;
    }

    function minutesToTimeString(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // =========================================================================
    // GET ALL LOCATIONS (for dropdown)
    // =========================================================================

    function getAllLocations() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const locations = [];
        
        (app1.fields || []).forEach(f => {
            if (f.name && f.available !== false) {
                locations.push({
                    name: f.name,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || 1
                });
            }
        });
        
        (app1.specialActivities || []).forEach(s => {
            if (s.name) {
                locations.push({
                    name: s.name,
                    type: 'special',
                    capacity: s.sharableWith?.capacity || 1
                });
            }
        });
        
        return locations;
    }

    // =========================================================================
    // EDITABLE BUNKS (RBAC)
    // =========================================================================

    function getEditableBunks() {
        const editableBunks = new Set();
        
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        const divisions = window.divisions || {};
        
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => editableBunks.add(String(b)));
            }
        }
        
        // If no RBAC or owner, all bunks are editable
        if (editableBunks.size === 0) {
            const role = window.AccessControl?.getCurrentRole?.();
            if (!window.AccessControl || role === 'owner' || role === 'admin') {
                Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(b));
            }
        }
        
        return editableBunks;
    }

    /**
     * Check if user can edit a specific bunk
     */
    function canEditBunk(bunkName) {
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') return true;
        
        const editableBunks = getEditableBunks();
        return editableBunks.has(bunkName);
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        // UPDATED: Use SchedulerCoreUtils
        const activityProperties = window.SchedulerCoreUtils.getActivityProperties();
        const locationInfo = activityProperties[locationName] || {};
        
        let maxCapacity = 1;
        if (locationInfo.sharableWith?.capacity) {
            maxCapacity = parseInt(locationInfo.sharableWith.capacity) || 1;
        } else if (locationInfo.sharable) {
            maxCapacity = 2;
        }
        
        const editableBunks = getEditableBunks();
        const conflicts = [];
        const usageBySlot = {};
        
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;
                
                const entryField = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                const entryActivity = entry._activity || entryField;
                const entryLocation = entry._location || entryField;
                
                // Check if this entry uses the same location
                const matchesLocation = 
                    entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryLocation?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase();
                
                if (matchesLocation) {
                    usageBySlot[slotIdx].push({
                        bunk: bunkName,
                        activity: entryActivity || entryField,
                        field: entryField,
                        canEdit: editableBunks.has(bunkName)
                    });
                }
            }
        }
        
        // Check GlobalFieldLocks
        let globalLock = null;
        if (window.GlobalFieldLocks) {
            // UPDATED: Use SchedulerCoreUtils
            const divName = window.SchedulerCoreUtils.getDivisionForBunk(excludeBunk);
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, divName);
            if (lockInfo) {
                globalLock = lockInfo;
            }
        }
        
        let hasConflict = !!globalLock;
        let currentUsage = 0;
        
        for (const slotIdx of slots) {
            const slotUsage = usageBySlot[slotIdx] || [];
            currentUsage = Math.max(currentUsage, slotUsage.length);
            
            if (slotUsage.length >= maxCapacity) {
                hasConflict = true;
                slotUsage.forEach(u => {
                    if (!conflicts.find(c => c.bunk === u.bunk && c.slot === slotIdx)) {
                        conflicts.push({ ...u, slot: slotIdx });
                    }
                });
            }
        }
        
        const editableConflicts = conflicts.filter(c => c.canEdit);
        const nonEditableConflicts = conflicts.filter(c => !c.canEdit);
        
        return {
            hasConflict,
            conflicts,
            editableConflicts,
            nonEditableConflicts,
            globalLock,
            canShare: maxCapacity > 1 && currentUsage < maxCapacity,
            currentUsage,
            maxCapacity
        };
    }

    // REMOVED: Rotation Scoring Helpers (Delegated to unified_schedule_system.js)
    // REMOVED: Build Candidate Options (Delegated to unified_schedule_system.js)
    // REMOVED: Penalty Calculation (Delegated to unified_schedule_system.js)
    // REMOVED: findBestActivityForBunk (Delegated to unified_schedule_system.js)
    // REMOVED: applyPickToBunk (Delegated to unified_schedule_system.js)
    // REMOVED: smartRegenerateConflicts (Delegated to unified_schedule_system.js)
    // REMOVED: smartReassignBunkActivity (Delegated to unified_schedule_system.js)
    // REMOVED: resolveConflictsAndApply (Delegated to unified_schedule_system.js)

    // =========================================================================
    // APPLY DIRECT EDIT
    // =========================================================================

    function applyDirectEdit(bunk, slots, activity, location, isClear) {
        // ★ FIX: Use division-specific slot count ★
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunk) || 
                        window.getDivisionForBunk?.(bunk);
        const divTimes = window.divisionTimes?.[divName] || [];
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(divTimes.length || 50);
        }

        const fieldValue = location ? `${location} – ${activity}` : activity;

        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = {
                field: isClear ? 'Free' : fieldValue,
                sport: isClear ? null : activity,
                continuation: i > 0,
                _fixed: !isClear,
                _activity: isClear ? 'Free' : activity,
                _location: location,
                _postEdit: true,
                _editedAt: Date.now()
            };
            debugLog(`Set bunk ${bunk} slot ${idx}:`, window.scheduleAssignments[bunk][idx]);
        });
        
        // Register location usage
        if (location && !isClear && window.registerLocationUsage) {
            // UPDATED: Use SchedulerCoreUtils
            const divName = window.SchedulerCoreUtils.getDivisionForBunk(bunk);
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName);
            });
        }
    }

    // =========================================================================
    // BYPASS SAVE - Save ALL modified bunks (admin-level access)
    // =========================================================================

    async function bypassSaveAllBunks(modifiedBunks) {
        console.log('[PostEdit] 🔓 BYPASS SAVE for bunks:', modifiedBunks);
        
        // ★★★ FIX: Use consistent date key with all fallbacks ★★★
        const dateKey = window.currentScheduleDate || 
                       window.currentDate || 
                       document.getElementById('datePicker')?.value ||
                       new Date().toISOString().split('T')[0];
        
        console.log(`[PostEdit] 📅 Bypass save using date key: ${dateKey}`);
        
        // ★★★ FIX: Save to localStorage IMMEDIATELY before cloud save ★★★
        // This ensures the data is available when updateTable() calls loadScheduleForDate()
        try {
            // Format 1: scheduleAssignments_${date}
            localStorage.setItem(`scheduleAssignments_${dateKey}`, JSON.stringify(window.scheduleAssignments));
            
            // Format 2: campDailyData_v1 (nested)
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[dateKey]) {
                allDailyData[dateKey] = {};
            }
            allDailyData[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDailyData[dateKey].leagueAssignments = window.leagueAssignments || {};
            allDailyData[dateKey].unifiedTimes = window.unifiedTimes || [];
            allDailyData[dateKey]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            
            console.log(`[PostEdit] ✅ Bypass: saved to localStorage before cloud save`);
        } catch (e) {
            console.error('[PostEdit] Bypass localStorage save error:', e);
        }
        
        // ★★★ FIX: Use ScheduleDB.saveSchedule with skipFilter instead of raw upsert ★★★
        // This properly handles the (camp_id, date_key, scheduler_id) constraint
        if (window.ScheduleDB?.saveSchedule) {
            try {
                const result = await window.ScheduleDB.saveSchedule(dateKey, {
                    scheduleAssignments: window.scheduleAssignments,
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes,
                    _bypassSaveAt: Date.now(),
                    _modifiedBunks: modifiedBunks
                }, { 
                    skipFilter: true,  // ★★★ This bypasses RBAC filtering - saves ALL bunks
                    immediate: true    // Don't debounce - save immediately
                });
                
                if (result?.success) {
                    console.log('[PostEdit] ✅ Bypass save successful via ScheduleDB');
                } else {
                    console.error('[PostEdit] Bypass save error:', result?.error);
                }
                return result;
            } catch (e) {
                console.error('[PostEdit] Bypass save exception:', e);
            }
        }
        
        // Fallback: trigger standard save flow (will respect RBAC, but better than nothing)
        console.log('[PostEdit] 🔓 Fallback: triggering standard save');
        window.saveSchedule?.();
        window.updateTable?.();
    }

    // =========================================================================
    // SCHEDULER NOTIFICATION
    // =========================================================================

    async function sendSchedulerNotification(affectedBunks, location, activity, notificationType) {
        console.log(`[PostEdit] 📧 Sending ${notificationType} notification for bunks:`, affectedBunks);
        
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) {
            console.warn('[PostEdit] Supabase not available for notifications');
            return;
        }
        
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        
        if (!campId) return;
        
        try {
            // Find which schedulers own these bunks
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            
            for (const bunk of affectedBunks) {
                for (const [divName, divData] of Object.entries(divisions)) {
                    if (divData.bunks?.includes(bunk)) {
                        affectedDivisions.add(divName);
                    }
                }
            }
            
            // Get schedulers for these divisions
            const { data: schedulers } = await supabase
                .from('camp_users')
                .select('user_id, divisions')
                .eq('camp_id', campId)
                .neq('user_id', userId);
            
            if (!schedulers) return;
            
            // Find schedulers whose divisions include the affected ones
            const notifyUsers = [];
            for (const scheduler of schedulers) {
                const theirDivisions = scheduler.divisions || [];
                if (theirDivisions.some(d => affectedDivisions.has(d))) {
                    notifyUsers.push(scheduler.user_id);
                }
            }
            
            if (notifyUsers.length === 0) return;
            
            // Create notifications
            const notifications = notifyUsers.map(targetUserId => ({
                camp_id: campId,
                user_id: targetUserId,
                type: notificationType === 'bypassed' ? 'schedule_bypassed' : 'schedule_conflict',
                title: notificationType === 'bypassed' 
                    ? '🔓 Your schedule was modified' 
                    : '⚠️ Schedule conflict detected',
                message: notificationType === 'bypassed'
                    ? `Another scheduler reassigned bunks (${affectedBunks.join(', ')}) for ${location} - ${activity} on ${dateKey}`
                    : `Conflict at ${location} for ${activity} on ${dateKey}. Affected bunks: ${affectedBunks.join(', ')}`,
                metadata: {
                    dateKey,
                    bunks: affectedBunks,
                    location,
                    activity,
                    initiatedBy: userId
                },
                read: false,
                created_at: new Date().toISOString()
            }));
            
            const { error } = await supabase
                .from('notifications')
                .insert(notifications);
            
            if (error) {
                console.error('[PostEdit] Notification insert error:', error);
            } else {
                console.log(`[PostEdit] ✅ Sent ${notificationType} notifications to ${notifyUsers.length} user(s)`);
            }
            
        } catch (e) {
            console.error('[PostEdit] Notification error:', e);
        }
    }

    // =========================================================================
    // APPLY EDIT (Main entry point)
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        // UPDATED: Use SchedulerCoreUtils
        const slots = window.SchedulerCoreUtils.findSlotsForRange(startMin, endMin, unifiedTimes);
        
        if (slots.length === 0) {
            console.error('[PostEdit] ❌ No slots found for time range:', startMin, '-', endMin);
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[PostEdit] Applying edit for ${bunk}:`, { 
            activity, location, startMin, endMin, slots, hasConflict, resolutionChoice, isClear
        });
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        }
        
        // ★★★ FIX: Await conflict resolution to prevent race conditions ★★★
        if (hasConflict) {
            // UPDATED: Use window.resolveConflictsAndApply (Global call)
            if (typeof window.resolveConflictsAndApply === 'function') {
                await window.resolveConflictsAndApply(bunk, slots, activity, location, editData);
            } else {
                console.error('[PostEdit] ❌ Fatal: window.resolveConflictsAndApply is not defined! Ensure unified_schedule_system.js is loaded.');
                alert('System Error: Conflict resolution module not loaded.');
            }
        } else {
            applyDirectEdit(bunk, slots, activity, location, isClear);
        }
        
        // Debug
        console.log(`[PostEdit] ✅ After edit, bunk ${bunk} slot ${slots[0]}:`, window.scheduleAssignments[bunk][slots[0]]);
        
        // ★★★ FIX: Use consistent date key - same as bypassSaveAllBunks and unified_schedule_system ★★★
        const currentDate = window.currentScheduleDate || 
                           window.currentDate || 
                           document.getElementById('datePicker')?.value ||
                           new Date().toISOString().split('T')[0];
        
        console.log(`[PostEdit] 📅 Using date key: ${currentDate}`);
        
        const storageKey = `scheduleAssignments_${currentDate}`;
        try {
            localStorage.setItem(storageKey, JSON.stringify(window.scheduleAssignments));
            console.log(`[PostEdit] ✅ Saved to localStorage: ${storageKey}`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to localStorage:', e);
        }
        
        // ★★★ FIX: Save to BOTH storage formats for compatibility ★★★
        // Format 1: campDailyData_v1_${date} (per-date key)
        const unifiedKeyWithDate = `campDailyData_v1_${currentDate}`;
        try {
            const dailyData = JSON.parse(localStorage.getItem(unifiedKeyWithDate) || '{}');
            dailyData.scheduleAssignments = window.scheduleAssignments;
            dailyData._postEditAt = Date.now();
            localStorage.setItem(unifiedKeyWithDate, JSON.stringify(dailyData));
            console.log(`[PostEdit] ✅ Saved to: ${unifiedKeyWithDate}`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to unified storage (per-date):', e);
        }
        
        // Format 2: campDailyData_v1 with nested date keys (what loadScheduleForDate expects)
        const unifiedKeyNested = 'campDailyData_v1';
        try {
            const allDailyData = JSON.parse(localStorage.getItem(unifiedKeyNested) || '{}');
            if (!allDailyData[currentDate]) {
                allDailyData[currentDate] = {};
            }
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].unifiedTimes = window.unifiedTimes || [];
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem(unifiedKeyNested, JSON.stringify(allDailyData));
            console.log(`[PostEdit] ✅ Saved to: ${unifiedKeyNested}[${currentDate}]`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to unified storage (nested):', e);
        }
        
        // Protection flag - prevent cloud hydration from overwriting
        // Note: This flag is also set earlier in resolveConflictsAndApply for bypass mode
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        
        // Clear the flag after a longer timeout to allow for all async operations
        // The patchLoadScheduleForDate will skip loading while this flag is true
        setTimeout(() => {
            window._postEditInProgress = false;
            console.log('[PostEdit] 🔓 Post-edit protection flag cleared');
        }, 8000); // 8 seconds to be safe
        
        // ★★★ FIX: Don't dispatch campistry-daily-data-updated - it triggers a reload ★★★
        // Our in-memory window.scheduleAssignments is already correct
        // Just dispatch a notification event and render directly
        console.log('[PostEdit] 🔄 Triggering UI refresh...');
        
        // ★★★ VERIFICATION: Check window.scheduleAssignments before render ★★★
        console.log('[PostEdit] VERIFICATION before render:');
        console.log(`  Total bunks in scheduleAssignments: ${Object.keys(window.scheduleAssignments || {}).length}`);
        // Log the bunk we just edited
        const editedEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        console.log(`  Edited bunk ${bunk} slot ${slots[0]}: ${editedEntry?._activity || editedEntry?.field || 'MISSING'}`);
        
        // Dispatch post-edit event for any listeners (informational only)
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunk, slots, activity, location, date: currentDate }
        }));
        
        // Cloud save (fire and forget - don't await to keep UI responsive)
        window.saveSchedule?.();
        
        // ★★★ FIX: Render immediately from current memory state ★★★
        // Don't dispatch campistry-daily-data-updated as it triggers loadScheduleForDate()
        // which would re-read from storage and might get stale data
        console.log('[PostEdit] 🔄 Calling updateTable() immediately');
        if (typeof window.updateTable === 'function') {
            window.updateTable();
        }
        
        // Second render after a small delay to catch any async updates
        setTimeout(() => {
            console.log('[PostEdit] 🔄 Second render pass');
            if (typeof window.updateTable === 'function') {
                window.updateTable();
            }
        }, 200);
    }

    // =========================================================================
    // MODAL UI
    // =========================================================================

    function createModal() {
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.2s ease;
        `;
        
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            min-width: 400px;
            max-width: 500px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-height: 90vh;
            overflow-y: auto;
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });
        
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
        
        return modal;
    }

    function closeModal() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations(); // This is defined in Part 1
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        let resolutionChoice = 'notify';
        
        // UPDATED: Use SchedulerCoreUtils
        const slots = window.SchedulerCoreUtils.findSlotsForRange(startMin, endMin, unifiedTimes);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = typeof entry.field === 'object' ? entry.field?.name : (entry.field || '');
                currentActivity = entry._activity || currentField || currentValue;
            }
        }
        
        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="margin: 0; font-size: 1.25rem; color: #1f2937;">Edit Schedule Cell</h2>
                <button id="post-edit-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #9ca3af; line-height: 1;">&times;</button>
            </div>
            
            <div style="background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px;">
                <div style="font-weight: 600; color: #374151;">${bunk}</div>
                <div style="font-size: 0.875rem; color: #6b7280;" id="post-edit-time-display">
                    ${window.SchedulerCoreUtils.minutesToTimeLabel(startMin)} - ${window.SchedulerCoreUtils.minutesToTimeLabel(endMin)}
                </div>
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <!-- Activity Name -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Activity Name
                    </label>
                    <input type="text" id="post-edit-activity" 
                        value="${currentActivity}"
                        placeholder="e.g., Impromptu Carnival, Basketball"
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;">
                    <div style="font-size: 0.75rem; color: #9ca3af; margin-top: 4px;">
                        Enter CLEAR or FREE to empty this slot
                    </div>
                </div>
                
                <!-- Location/Field -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Location / Field
                    </label>
                    <select id="post-edit-location" 
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box; background: white;">
                        <option value="">-- No specific location --</option>
                        <optgroup label="Fields">
                            ${locations.filter(l => l.type === 'field').map(l => 
                                `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}${l.capacity > 1 ? ` (capacity: ${l.capacity})` : ''}</option>`
                            ).join('')}
                        </optgroup>
                        <optgroup label="Special Activities">
                            ${locations.filter(l => l.type === 'special').map(l => 
                                `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}</option>`
                            ).join('')}
                        </optgroup>
                    </select>
                </div>
                
                <!-- Change Time Toggle -->
                <div>
                    <button type="button" id="post-edit-time-toggle" style="
                        background: none;
                        border: none;
                        color: #2563eb;
                        font-size: 0.875rem;
                        cursor: pointer;
                        padding: 0;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    ">
                        <span id="post-edit-time-arrow">▶</span> Change time
                    </button>
                    
                    <div id="post-edit-time-section" style="display: none; margin-top: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <div style="flex: 1;">
                                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">
                                    Start Time
                                </label>
                                <input type="time" id="post-edit-start" 
                                    value="${minutesToTimeString(startMin)}"
                                    style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;">
                            </div>
                            <div style="flex: 1;">
                                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">
                                    End Time
                                </label>
                                <input type="time" id="post-edit-end" 
                                    value="${minutesToTimeString(endMin)}"
                                    style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;">
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Conflict Warning Area -->
                <div id="post-edit-conflict" style="display: none;"></div>
                
                <!-- Buttons -->
                <div style="display: flex; gap: 12px; margin-top: 8px;">
                    <button id="post-edit-cancel" style="
                        flex: 1;
                        padding: 12px;
                        border: 1px solid #d1d5db;
                        border-radius: 8px;
                        background: white;
                        color: #374151;
                        font-size: 1rem;
                        cursor: pointer;
                        font-weight: 500;
                    ">Cancel</button>
                    <button id="post-edit-save" style="
                        flex: 1;
                        padding: 12px;
                        border: none;
                        border-radius: 8px;
                        background: #2563eb;
                        color: white;
                        font-size: 1rem;
                        cursor: pointer;
                        font-weight: 500;
                    ">Save Changes</button>
                </div>
            </div>
        `;
        
        // State
        let useOriginalTime = true;
        const originalStartMin = startMin;
        const originalEndMin = endMin;
        
        // Event handlers
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
        // Time toggle
        const timeToggle = document.getElementById('post-edit-time-toggle');
        const timeSection = document.getElementById('post-edit-time-section');
        const timeArrow = document.getElementById('post-edit-time-arrow');
        const timeDisplay = document.getElementById('post-edit-time-display');
        
        timeToggle.onclick = () => {
            const isHidden = timeSection.style.display === 'none';
            timeSection.style.display = isHidden ? 'block' : 'none';
            timeArrow.textContent = isHidden ? '▼' : '▶';
            useOriginalTime = !isHidden;
        };
        
        // Conflict checking
        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');
        const startInput = document.getElementById('post-edit-start');
        const endInput = document.getElementById('post-edit-end');
        
        function getEffectiveTimes() {
            if (useOriginalTime) {
                return { startMin: originalStartMin, endMin: originalEndMin };
            }
            return {
                startMin: parseTimeToMinutes(startInput.value) || originalStartMin,
                endMin: parseTimeToMinutes(endInput.value) || originalEndMin
            };
        }
        
        function updateTimeDisplay() {
            const times = getEffectiveTimes();
            timeDisplay.textContent = `${window.SchedulerCoreUtils.minutesToTimeLabel(times.startMin)} - ${window.SchedulerCoreUtils.minutesToTimeLabel(times.endMin)}`;
        }
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!location) {
                conflictArea.style.display = 'none';
                return null;
            }
            
            // UPDATED: Use SchedulerCoreUtils
            const targetSlots = window.SchedulerCoreUtils.findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            
            if (conflictCheck.hasConflict) {
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                
                conflictArea.style.display = 'block';
                
                let html = `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 1.25rem;">⚠️</span>
                        <strong style="color: #92400e;">Location Conflict Detected</strong>
                    </div>
                    <p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;">
                        <strong>${location}</strong> is already in use:
                    </p>`;
                
                if (editableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px; padding: 8px; background: #d1fae5; border-radius: 6px;">
                        <div style="font-size: 0.8rem; color: #065f46;">
                            <strong>✓ Can auto-reassign:</strong> ${editableBunks.join(', ')}
                        </div>
                    </div>`;
                }
                
                if (nonEditableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px; padding: 8px; background: #fee2e2; border-radius: 6px;">
                        <div style="font-size: 0.8rem; color: #991b1b;">
                            <strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.join(', ')}
                        </div>
                    </div>
                    
                    <div style="margin-top: 12px;">
                        <div style="font-weight: 500; color: #374151; margin-bottom: 8px; font-size: 0.875rem;">
                            How to handle their bunks?
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="notify" checked style="margin-top: 2px;">
                                <div>
                                    <div style="font-weight: 500; color: #374151;">📧 Notify other scheduler</div>
                                    <div style="font-size: 0.75rem; color: #6b7280;">Create double-booking & send them a warning</div>
                                </div>
                            </label>
                            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="bypass" style="margin-top: 2px;">
                                <div>
                                    <div style="font-weight: 500; color: #374151;">🔓 Bypass & reassign (Admin mode)</div>
                                    <div style="font-size: 0.75rem; color: #6b7280;">Override permissions and use smart regeneration</div>
                                </div>
                            </label>
                        </div>
                    </div>`;
                }
                
                html += `</div>`;
                conflictArea.innerHTML = html;
                
                // Bind radio buttons
                const radioButtons = conflictArea.querySelectorAll('input[name="conflict-resolution"]');
                radioButtons.forEach(radio => {
                    radio.addEventListener('change', (e) => {
                        resolutionChoice = e.target.value;
                    });
                });
                
                return conflictCheck;
            } else {
                conflictArea.style.display = 'none';
                return null;
            }
        }
        
        locationSelect.addEventListener('change', checkAndShowConflicts);
        startInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        endInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        
        checkAndShowConflicts();
        
        // Save handler
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!activity) {
                alert('Please enter an activity name.');
                return;
            }
            
            if (times.endMin <= times.startMin) {
                alert('End time must be after start time.');
                return;
            }
            
            // UPDATED: Use SchedulerCoreUtils
            const targetSlots = window.SchedulerCoreUtils.findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            
            if (conflictCheck?.hasConflict) {
                onSave({
                    activity,
                    location,
                    startMin: times.startMin,
                    endMin: times.endMin,
                    hasConflict: true,
                    conflicts: conflictCheck.conflicts,
                    editableConflicts: conflictCheck.editableConflicts || [],
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [],
                    resolutionChoice: resolutionChoice
                });
            } else {
                onSave({
                    activity,
                    location,
                    startMin: times.startMin,
                    endMin: times.endMin,
                    hasConflict: false,
                    conflicts: []
                });
            }
            
            closeModal();
        };
        
        document.getElementById('post-edit-activity').focus();
        document.getElementById('post-edit-activity').select();
    }

    // =========================================================================
    // ENHANCED EDIT CELL (Main entry point)
    // =========================================================================

    function enhancedEditCell(bunk, startMin, endMin, current) {
        debugLog(`enhancedEditCell called: ${bunk}, ${startMin}-${endMin}, "${current}"`);
        
        // RBAC check
        if (!canEditBunk(bunk)) {
            alert('You do not have permission to edit this schedule.\n\n(You can only edit your assigned divisions.)');
            return;
        }
        
        showEditModal(bunk, startMin, endMin, current, (editData) => {
            applyEdit(bunk, editData);
        });
    }

    // =========================================================================
    // CLICK INTERCEPTOR
    // =========================================================================

    function setupClickInterceptor() {
        const overrideWindowEditCell = () => {
            if (window.editCell && window.editCell !== enhancedEditCell && !window.editCell._isEnhanced) {
                debugLog('Overriding window.editCell');
                window._originalEditCell = window.editCell;
                window.editCell = enhancedEditCell;
                window.editCell._isEnhanced = true;
            }
        };
        
        overrideWindowEditCell();
        setTimeout(overrideWindowEditCell, 500);
        setTimeout(overrideWindowEditCell, 1500);
        setTimeout(overrideWindowEditCell, 3000);
        
        // Capture phase click listener
        document.addEventListener('click', (e) => {
            const td = e.target.closest('td');
            if (!td) return;
            
            const table = td.closest('#scheduleTable, .schedule-table, [data-schedule]');
            if (!table) return;
            
            const onclickStr = td.getAttribute('onclick') || (td.onclick ? td.onclick.toString() : '');
            const isClickable = td.style.cursor === 'pointer' || getComputedStyle(td).cursor === 'pointer';
            
            if (!isClickable && !onclickStr.includes('editCell')) return;
            
            let bunk, startMin, endMin, currentText;
            
            const match = onclickStr.match(/editCell\s*\(\s*["']?([^"',]+)["']?\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*["']?([^"']*)["']?\s*\)/);
            
            if (match) {
                bunk = match[1];
                startMin = parseInt(match[2], 10);
                endMin = parseInt(match[3], 10);
                currentText = match[4] || '';
                
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                td.onclick = null;
                td.removeAttribute('onclick');
                
                enhancedEditCell(bunk, startMin, endMin, currentText);
            }
        }, true);
        
        // Observer for dynamic content
        const observer = new MutationObserver((mutations) => {
            overrideWindowEditCell();
        });
        
        const scheduleContainer = document.getElementById('scheduleTable') || document.getElementById('unified-schedule');
        if (scheduleContainer) {
            observer.observe(scheduleContainer, { childList: true, subtree: true });
        }
        
        debugLog('Click interceptor installed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

   function initPostEditSystem() {
    // Verify dependencies
    const missing = [];
    if (typeof window.smartRegenerateConflicts !== 'function') missing.push('smartRegenerateConflicts');
    if (typeof window.resolveConflictsAndApply !== 'function') missing.push('resolveConflictsAndApply');
    if (typeof window.applyPickToBunk !== 'function') missing.push('applyPickToBunk');
    
    if (missing.length > 0) {
        console.error('❌ [PostEdit] Missing dependencies:', missing.join(', '));
    }
    
    // Add styles
    if (!document.getElementById('post-edit-styles')) {
        const style = document.createElement('style');
        style.id = 'post-edit-styles';
        style.textContent = `
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        `;
        document.head.appendChild(style);
    }
    
    console.log('📝 Post-Edit System v4.0 initialized (consolidated)');
}


        
        

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.initPostEditSystem = initPostEditSystem;
    window.enhancedEditCell = enhancedEditCell;
    window.checkLocationConflict = checkLocationConflict;
    window.getAllLocations = getAllLocations;
    window.getEditableBunks = getEditableBunks;
    window.sendSchedulerNotification = sendSchedulerNotification;
    window.bypassSaveAllBunks = bypassSaveAllBunks;
   
    
    // =========================================================================
    // ★★★ CRITICAL PATCH: Make loadScheduleForDate respect _postEditInProgress ★★★
    // =========================================================================
    // 
    // Problem: When we update window.scheduleAssignments in memory and call updateTable(),
    // renderStaggeredView() calls loadScheduleForDate() which OVERWRITES our changes.
    // 
    // Solution: Patch loadScheduleForDate to skip loading when _postEditInProgress is true.
    // 
    // =========================================================================

    function patchLoadScheduleForDate() {
        if (window._loadScheduleForDatePatched) return;
        
        const original = window.loadScheduleForDate;
        if (!original) {
            console.warn('[PostEdit] loadScheduleForDate not found, will retry...');
            setTimeout(patchLoadScheduleForDate, 500);
            return;
        }

        window.loadScheduleForDate = function(dateKey) {
            // ★★★ Skip loading if post-edit is in progress ★★★
            if (window._postEditInProgress) {
                console.log('[PostEdit] 🛡️ Skipping loadScheduleForDate - post-edit in progress');
                console.log('[PostEdit]   Current scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
                return; // Don't overwrite our in-memory changes
            }
            
            // Call original
            return original.call(this, dateKey);
        };

        window._loadScheduleForDatePatched = true;
        console.log('[PostEdit] ✅ Patched loadScheduleForDate to respect _postEditInProgress flag');
    }

    // Patch immediately and also after delays (in case unified_schedule_system loads later)
    patchLoadScheduleForDate();
    setTimeout(patchLoadScheduleForDate, 100);
    setTimeout(patchLoadScheduleForDate, 500);
    setTimeout(patchLoadScheduleForDate, 1500);

    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostEditSystem);
    } else {
        setTimeout(initPostEditSystem, 100);
    }

})();
