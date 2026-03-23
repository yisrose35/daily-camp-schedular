// =============================================================================
// POST-GENERATION EDIT SYSTEM v3.3 - CLIENT UI + INTERACTIVE EDITING
// =============================================================================
// 
// v3.3 CHANGES:
// - RESIZE: Drag top/bottom edge of any block to lengthen/shorten
// - MOVE: Click-drag any block up/down to reposition in time
// - ADD: Double-click empty space to insert new activity (manual or auto-fill)
// - REAL-TIME CONFLICT DETECTION during all interactions
// - Threshold-based drag (5px) so click-to-edit still works
// - Capturing click suppressor prevents edit modal after drag/resize
// - All block types interactive (including lunch, swim, etc.)
// - Rotation history updated on every post-edit save
//
// v3.2 CHANGES:
// - CRITICAL FIX: Owner/Admin permission check now handles uninitialized AccessControl
// - Added fallback chain: AccessControl -> CampistryDB -> localStorage -> allow
// - Prevents owners from being blocked when RBAC hasn't finished loading
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

    console.log('📝 Post-Generation Edit System v3.3 (UI Client) loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const DEBUG = true;
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";

    // REMOVED: ROTATION_CONFIG (Moved to unified_schedule_system.js)

    // =========================================================================
    // v3.3 — POST-EDIT INTERACTIONS CONFIG
    // =========================================================================
    const PEI_PX_PER_MIN = 2.5;
    const PEI_SNAP_MINS = 5;
    const PEI_MIN_BLOCK_DURATION = 10;
    const PEI_LONG_PRESS_MS = 300;
    const PEI_DRAG_THRESHOLD = 5;

    let _peiResizing = false;
    let _peiMoving = false;
    let _peiState = null;
    let _peiTooltip = null;
    let _peiConflictOverlays = [];
    let _peiPendingMove = null;
    let _peiSuppressClick = false;
    let _peiSetupDone = false;

    // Undo stack: array of { bunk, snapshot (deep copy of assignments[bunk]), description }
    const _peiUndoStack = [];
    const PEI_MAX_UNDO = 30;

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
    // EDITABLE BUNKS (RBAC) - ★★★ FIXED v3.2 ★★★
    // =========================================================================

    function getEditableBunks() {
        const editableBunks = new Set();
        const divisions = window.divisions || {};
        
        const isInitialized = window.AccessControl?.isInitialized;
        const role = window.AccessControl?.getCurrentRole?.();
        
        const fallbackRole = window.CampistryDB?.getRole?.() || 
                            localStorage.getItem('campistry_role');
        const effectiveRole = role || fallbackRole;
        
        debugLog('getEditableBunks check:', { 
            hasAccessControl: !!window.AccessControl, 
            isInitialized, 
            role,
            fallbackRole,
            effectiveRole
        });
        
        if (!window.AccessControl || !isInitialized || effectiveRole === 'owner' || effectiveRole === 'admin') {
            for (const divInfo of Object.values(divisions)) {
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => editableBunks.add(String(b)));
                }
            }
            Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(String(b)));
            return editableBunks;
        }
        
        const editableDivisions = window.AccessControl.getEditableDivisions?.() || [];
        
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => editableBunks.add(String(b)));
            }
        }
        
        return editableBunks;
    }

    function canEditBunk(bunkName) {
        const isInitialized = window.AccessControl?.isInitialized;
        const role = window.AccessControl?.getCurrentRole?.();
        
        if (window.AccessControl && (!isInitialized || !role)) {
            const fallbackRole = window.CampistryDB?.getRole?.() || 
                                localStorage.getItem('campistry_role');
            if (fallbackRole === 'owner' || fallbackRole === 'admin') {
                debugLog(`canEditBunk(${bunkName}): Using fallback role = ${fallbackRole}, ALLOWED`);
                return true;
            }
            if (!fallbackRole) {
                debugLog(`canEditBunk(${bunkName}): No role info during init, defaulting to ALLOW`);
                return true;
            }
        }
        
        if (role === 'owner' || role === 'admin') return true;
        
        const editableBunks = getEditableBunks();
        return editableBunks.has(String(bunkName));
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    function checkLocationConflict(locationName, slots, excludeBunk) {
        if (!locationName) {
            return {
                hasConflict: false, conflicts: [],
                editableConflicts: [], nonEditableConflicts: [],
                globalLock: null, canShare: false, currentUsage: 0, maxCapacity: 1
            };
        }
        const assignments = window.scheduleAssignments || {};
        const activityProperties = window.SchedulerCoreUtils?.getActivityProperties?.() ||
                                   window.activityProperties || {};
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
                
                const matchesLocation = 
                    entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryLocation?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase();
                
                if (matchesLocation) {
                    usageBySlot[slotIdx].push({
                        bunk: bunkName,
                        activity: entryActivity || entryField,
                        field: entryField,
                        canEdit: editableBunks.has(String(bunkName))
                    });
                }
            }
        }
        
        let globalLock = null;
        if (window.GlobalFieldLocks) {
            const divName = window.SchedulerCoreUtils?.getDivisionForBunk?.(excludeBunk) ||
                           window.getDivisionForBunk?.(excludeBunk);
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
            hasConflict, conflicts, editableConflicts, nonEditableConflicts,
            globalLock,
            canShare: maxCapacity > 1 && currentUsage < maxCapacity,
            currentUsage, maxCapacity
        };
    }

    // =========================================================================
    // APPLY DIRECT EDIT
    // =========================================================================

    function applyDirectEdit(bunk, slots, activity, location, isClear) {
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk?.(bunk) || 
                        window.getDivisionForBunk?.(bunk);
        const divTimes = window.divisionTimes?.[divName] || [];
        
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
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
        
        if (location && !isClear && window.registerLocationUsage) {
            const divName2 = window.SchedulerCoreUtils?.getDivisionForBunk?.(bunk) ||
                           window.getDivisionForBunk?.(bunk);
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName2);
            });
        }
    }

    // =========================================================================
    // BYPASS SAVE
    // =========================================================================

    async function bypassSaveAllBunks(modifiedBunks) {
        console.log('[PostEdit] 🔓 BYPASS SAVE for bunks:', modifiedBunks);
        
        const dateKey = window.currentScheduleDate || 
                       window.currentDate || 
                       document.getElementById('datePicker')?.value ||
                       new Date().toISOString().split('T')[0];
        
        console.log(`[PostEdit] 📅 Bypass save using date key: ${dateKey}`);
        
        try {
            localStorage.setItem(`scheduleAssignments_${dateKey}`, JSON.stringify(window.scheduleAssignments));
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[dateKey]) allDailyData[dateKey] = {};
            allDailyData[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDailyData[dateKey].leagueAssignments = window.leagueAssignments || {};
            allDailyData[dateKey]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            console.log(`[PostEdit] ✅ Bypass: saved to localStorage before cloud save`);
        } catch (e) {
            console.error('[PostEdit] Bypass localStorage save error:', e);
        }
        
        if (window.ScheduleDB?.saveSchedule) {
            try {
                const result = await window.ScheduleDB.saveSchedule(dateKey, {
                    scheduleAssignments: window.scheduleAssignments,
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes,
                    _bypassSaveAt: Date.now(),
                    _modifiedBunks: modifiedBunks
                }, { skipFilter: true, immediate: true });
                
                if (result?.success) console.log('[PostEdit] ✅ Bypass save successful via ScheduleDB');
                else console.error('[PostEdit] Bypass save error:', result?.error);
                return result;
            } catch (e) {
                console.error('[PostEdit] Bypass save exception:', e);
            }
        }
        
        console.log('[PostEdit] 🔓 Fallback: triggering standard save');
        window.saveSchedule?.();
        window.updateTable?.();
    }

    // =========================================================================
    // SCHEDULER NOTIFICATION
    // =========================================================================

    async function sendSchedulerNotification(affectedBunks, location, activity, notificationType) {
        if (window.__CAMPISTRY_DEMO_MODE__) {
            console.log('[PostEdit] 🎭 Demo mode — skipping scheduler notification');
            return;
        }

        console.log('[PostEdit] 📧 Sending ' + (notificationType || 'conflict') + ' notification for bunks:', affectedBunks);
        
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) { console.warn('[PostEdit] Supabase not available'); return; }
        
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        if (!campId) return;
        
        try {
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            for (const bunk of affectedBunks) {
                for (const [divName, divData] of Object.entries(divisions)) {
                    if (divData.bunks?.includes(bunk)) affectedDivisions.add(divName);
                }
            }
            
            const { data: schedulers } = await supabase
                .from('camp_users').select('user_id, divisions')
                .eq('camp_id', campId).neq('user_id', userId);
            if (!schedulers) return;
            
            const notifyUsers = [];
            for (const scheduler of schedulers) {
                const theirDivisions = scheduler.divisions || [];
                if (theirDivisions.some(d => affectedDivisions.has(d))) notifyUsers.push(scheduler.user_id);
            }
            if (notifyUsers.length === 0) return;
            
            const notifications = notifyUsers.map(targetUserId => ({
                camp_id: campId, user_id: targetUserId,
                type: notificationType === 'bypassed' ? 'schedule_bypassed' : 'schedule_conflict',
                title: notificationType === 'bypassed' ? '🔓 Your schedule was modified' : '⚠️ Schedule conflict detected',
                message: notificationType === 'bypassed'
                    ? `Another scheduler reassigned bunks (${affectedBunks.join(', ')}) for ${location} - ${activity} on ${dateKey}`
                    : `Conflict at ${location} for ${activity} on ${dateKey}. Affected bunks: ${affectedBunks.join(', ')}`,
                metadata: { dateKey, bunks: affectedBunks, location, activity, initiatedBy: userId },
                read: false, created_at: new Date().toISOString()
            }));
            
            const { error } = await supabase.from('notifications').insert(notifications);
            if (error) console.error('[PostEdit] Notification insert error:', error);
            else console.log(`[PostEdit] ✅ Sent ${notificationType} notifications to ${notifyUsers.length} user(s)`);
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
        
        if (window.__CAMPISTRY_DEMO_MODE__ && !activity && activity !== '') {
            console.error('[PostEdit] ❌ Demo: applyEdit called with undefined activity:', editData);
            alert('Error: No activity specified.');
            return;
        }

        const isClear = !activity || activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = window.SchedulerCoreUtils?.findSlotsForRange?.(startMin, endMin, unifiedTimes) || [];
        
        if (slots.length === 0) {
            console.error('[PostEdit] ❌ No slots found for time range:', startMin, '-', endMin);
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[PostEdit] Applying edit for ${bunk}:`, { activity, location, startMin, endMin, slots, hasConflict, resolutionChoice, isClear });
        
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);

        const _oldActivities = [];
        slots.forEach(idx => {
            const old = window.scheduleAssignments[bunk]?.[idx];
            if (old?._activity && !old.continuation && !old._isTransition) {
                const a = old._activity.toLowerCase();
                if (a !== 'free' && !a.includes('transition')) _oldActivities.push(old._activity);
            }
        });

        if (hasConflict) {
            if (typeof window.resolveConflictsAndApply === 'function') {
                await window.resolveConflictsAndApply(bunk, slots, activity, location, editData);
            } else {
                console.error('[PostEdit] ❌ Fatal: window.resolveConflictsAndApply is not defined!');
                alert('System Error: Conflict resolution module not loaded.');
            }
        } else {
            applyDirectEdit(bunk, slots, activity, location, isClear);
        }
        
        console.log(`[PostEdit] ✅ After edit, bunk ${bunk} slot ${slots[0]}:`, window.scheduleAssignments[bunk][slots[0]]);
        
        const currentDate = window.currentScheduleDate || 
                           window.currentDate || 
                           document.getElementById('datePicker')?.value ||
                           new Date().toISOString().split('T')[0];
        
        const storageKey = `scheduleAssignments_${currentDate}`;
        try {
            localStorage.setItem(storageKey, JSON.stringify(window.scheduleAssignments));
        } catch (e) { console.error('[PostEdit] Failed to save to localStorage:', e); }
        
        const unifiedKeyWithDate = `campDailyData_v1_${currentDate}`;
        try {
            const dailyData = JSON.parse(localStorage.getItem(unifiedKeyWithDate) || '{}');
            dailyData.scheduleAssignments = window.scheduleAssignments;
            dailyData._postEditAt = Date.now();
            localStorage.setItem(unifiedKeyWithDate, JSON.stringify(dailyData));
        } catch (e) { console.error('[PostEdit] Failed to save to unified storage (per-date):', e); }
        
        try {
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].unifiedTimes = window.unifiedTimes || [];
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) { console.error('[PostEdit] Failed to save to unified storage (nested):', e); }
        
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        setTimeout(() => { window._postEditInProgress = false; }, 8000);
        
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunk, slots, activity, location, date: currentDate }
        }));
        
        window.saveSchedule?.();

        // Historical counts delta
        try {
            const _gs = window.loadGlobalSettings?.() || {};
            const _hc = _gs.historicalCounts || {};
            if (!_hc[bunk]) _hc[bunk] = {};
            let _newAct = (!isClear && activity) ? activity : null;

            if (_newAct) {
                for (const oldAct of _oldActivities) {
                    if (oldAct.toLowerCase() === _newAct.toLowerCase() && oldAct !== _newAct) { _newAct = oldAct; break; }
                }
            }

            const _oldUnique = {};
            _oldActivities.forEach(a => { _oldUnique[a] = (_oldUnique[a] || 0) + 1; });
            for (const [act, count] of Object.entries(_oldUnique)) {
                const _before = _hc[bunk][act] || 0;
                _hc[bunk][act] = Math.max(0, _before - count);
            }

            const _validActs = window.SchedulerCoreUtils?.getValidActivityNames?.() || new Set();
            if (_newAct && (_validActs.size === 0 || _validActs.has(_newAct))) {
                let _newCount = 0;
                slots.forEach(idx => {
                    const entry = window.scheduleAssignments[bunk]?.[idx];
                    if (entry && !entry.continuation) _newCount++;
                });
                const _before = _hc[bunk][_newAct] || 0;
                _hc[bunk][_newAct] = _before + _newCount;
            }

            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('historicalCounts', _hc);
                if (typeof window.forceSyncToCloud === 'function') setTimeout(() => window.forceSyncToCloud(), 100);
            }
        } catch (_hcErr) { console.error('[PostEdit] Historical counts delta failed:', _hcErr); }

        // Rotation history timestamps
        try {
            const _rotHist = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
            _rotHist.bunks = _rotHist.bunks || {};
            _rotHist.bunks[bunk] = _rotHist.bunks[bunk] || {};
            const _bunkSlots = window.scheduleAssignments?.[bunk] || [];
            const _now = Date.now();
            _rotHist.bunks[bunk] = {};
            _bunkSlots.forEach(entry => {
                if (entry?._activity && !entry.continuation && !entry._isTransition) {
                    const _aLower = entry._activity.toLowerCase();
                    if (_aLower !== 'free' && !_aLower.includes('transition')) {
                        _rotHist.bunks[bunk][entry._activity] = _now;
                    }
                }
            });
            window.saveRotationHistory?.(_rotHist);
        } catch (_re) { console.error('[PostEdit] Rotation history update failed:', _re); }
        
        // Render
        console.log('[PostEdit] 🔄 Calling updateTable() immediately');
        if (typeof window.updateTable === 'function') window.updateTable();
        setTimeout(() => { if (typeof window.updateTable === 'function') window.updateTable(); }, 200);
    }

    // =========================================================================
    // MODAL UI
    // =========================================================================

    function createModal() {
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;';
        
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = 'background:white;border-radius:12px;padding:24px;min-width:400px;max-width:500px;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-height:90vh;overflow-y:auto;';
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        const escHandler = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);
        
        return modal;
    }

    function closeModal() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        let resolutionChoice = 'notify';
        
        const slots = window.SchedulerCoreUtils?.findSlotsForRange?.(startMin, endMin, unifiedTimes) || [];
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = typeof entry.field === 'object' ? entry.field?.name : (entry.field || '');
                currentActivity = entry._activity || currentField || currentValue;
            }
        }
        
        const minutesToTimeLabel = window.SchedulerCoreUtils?.minutesToTimeLabel || 
            function(mins) {
                if (mins === null || mins === undefined) return '';
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
                const ampm = h >= 12 ? 'PM' : 'AM';
                return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
            };
        
        modal.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <h2 style="margin:0;font-size:1.25rem;color:#1f2937;">Edit Schedule Cell</h2>
                <button id="post-edit-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#9ca3af;line-height:1;">&times;</button>
            </div>
            <div style="background:#f3f4f6;padding:12px 16px;border-radius:8px;margin-bottom:20px;">
                <div style="font-weight:600;color:#374151;">${bunk}</div>
                <div style="font-size:0.875rem;color:#6b7280;" id="post-edit-time-display">${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:16px;">
                <div>
                    <label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Activity Name</label>
                    <input type="text" id="post-edit-activity" value="${currentActivity}" placeholder="e.g., Basketball"
                        style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;">
                    <div style="font-size:0.75rem;color:#9ca3af;margin-top:4px;">Enter CLEAR or FREE to empty this slot</div>
                </div>
                <div>
                    <label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Location / Field</label>
                    <select id="post-edit-location" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;background:white;">
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
                <div id="post-edit-conflict" style="display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:8px;">
                    <button id="post-edit-cancel" style="flex:1;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:white;color:#374151;font-size:1rem;cursor:pointer;font-weight:500;">Cancel</button>
                    <button id="post-edit-delete" style="padding:12px 16px;border:none;border-radius:8px;background:#fef2f2;color:#dc2626;font-size:1rem;cursor:pointer;font-weight:600;border:1px solid #fca5a5;">Delete</button>
                    <button id="post-edit-save" style="flex:1;padding:12px;border:none;border-radius:8px;background:#2563eb;color:white;font-size:1rem;cursor:pointer;font-weight:500;">Save Changes</button>
                </div>
            </div>`;
        
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
        // Delete button
        document.getElementById('post-edit-delete').onclick = () => {
            const divName = peiGetDivForBunk(bunk);
            const divSlots = window.divisionTimes?.[divName] || [];
            // Find slot index for this time
            let slotIdx = -1;
            for (let i = 0; i < divSlots.length; i++) {
                if (divSlots[i].startMin <= startMin && divSlots[i].endMin > startMin) { slotIdx = i; break; }
            }
            if (slotIdx >= 0) {
                closeModal();
                peiDeleteBlock(bunk, slotIdx, divName, currentActivity || 'activity');
            } else {
                alert('Could not find this block to delete.');
            }
        };
        
        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');
        
        function getEffectiveTimes() {
            return { startMin, endMin };
        }
        
        locationSelect.addEventListener('change', checkAndShowConflicts);
        checkAndShowConflicts();
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            if (!location) { conflictArea.style.display = 'none'; return null; }
            
            const targetSlots = window.SchedulerCoreUtils?.findSlotsForRange?.(times.startMin, times.endMin, unifiedTimes) || [];
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            
            if (conflictCheck.hasConflict) {
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                
                conflictArea.style.display = 'block';
                let html = `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                        <span style="font-size:1.25rem;">⚠️</span>
                        <strong style="color:#92400e;">Location Conflict Detected</strong>
                    </div>
                    <p style="margin:0 0 8px 0;color:#78350f;font-size:0.875rem;"><strong>${location}</strong> is already in use:</p>`;
                
                if (editableBunks.length > 0) {
                    html += `<div style="margin-bottom:8px;padding:8px;background:#d1fae5;border-radius:6px;"><div style="font-size:0.8rem;color:#065f46;"><strong>✓ Can auto-reassign:</strong> ${editableBunks.join(', ')}</div></div>`;
                }
                
                if (nonEditableBunks.length > 0) {
                    html += `<div style="margin-bottom:8px;padding:8px;background:#fee2e2;border-radius:6px;"><div style="font-size:0.8rem;color:#991b1b;"><strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.join(', ')}</div></div>
                    <div style="margin-top:12px;">
                        <div style="font-weight:500;color:#374151;margin-bottom:8px;font-size:0.875rem;">How to handle their bunks?</div>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:8px;background:white;border-radius:6px;border:2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="notify" checked style="margin-top:2px;">
                                <div><div style="font-weight:500;color:#374151;">📧 Notify other scheduler</div><div style="font-size:0.75rem;color:#6b7280;">Create double-booking & send warning</div></div>
                            </label>
                            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:8px;background:white;border-radius:6px;border:2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="bypass" style="margin-top:2px;">
                                <div><div style="font-weight:500;color:#374151;">🔓 Bypass & reassign (Admin mode)</div><div style="font-size:0.75rem;color:#6b7280;">Override permissions and use smart regeneration</div></div>
                            </label>
                        </div>
                    </div>`;
                }
                html += `</div>`;
                conflictArea.innerHTML = html;
                conflictArea.querySelectorAll('input[name="conflict-resolution"]').forEach(radio => {
                    radio.addEventListener('change', (e) => { resolutionChoice = e.target.value; });
                });
                return conflictCheck;
            } else {
                conflictArea.style.display = 'none';
                return null;
            }
        }
        
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!activity) { alert('Please enter an activity name.'); return; }
            if (times.endMin <= times.startMin) { alert('End time must be after start time.'); return; }
            
            const targetSlots = window.SchedulerCoreUtils?.findSlotsForRange?.(times.startMin, times.endMin, unifiedTimes) || [];
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            
            if (conflictCheck?.hasConflict) {
                onSave({ activity, location, startMin: times.startMin, endMin: times.endMin,
                    hasConflict: true, conflicts: conflictCheck.conflicts,
                    editableConflicts: conflictCheck.editableConflicts || [],
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [],
                    resolutionChoice });
            } else {
                onSave({ activity, location, startMin: times.startMin, endMin: times.endMin, hasConflict: false, conflicts: [] });
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
        const _divNameCheck = window.AccessControl?.getDivisionForBunk?.(bunk);
        if (_divNameCheck && window.AccessControl?.canEditDivision) {
            if (!window.AccessControl.canEditDivision(_divNameCheck)) {
                debugLog('BLOCKED: Cannot edit bunk', bunk, 'in division', _divNameCheck);
                if (typeof window.showToast === 'function') window.showToast('You don\'t have permission to edit ' + _divNameCheck, 'error');
                return;
            }
        }
        debugLog('enhancedEditCell called:', bunk, startMin, endMin, current);
        if (!canEditBunk(bunk)) {
            alert('You do not have permission to edit this schedule.\n\n(You can only edit your assigned divisions.)');
            return;
        }
        showEditModal(bunk, startMin, endMin, current, (editData) => { applyEdit(bunk, editData); });
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
        
        document.addEventListener('click', (e) => {
            const td = e.target.closest('td');
            if (!td) return;
            const table = td.closest('#scheduleTable, .schedule-table, [data-schedule]');
            if (!table) return;
            const onclickStr = td.getAttribute('onclick') || (td.onclick ? td.onclick.toString() : '');
            const isClickable = td.style.cursor === 'pointer' || getComputedStyle(td).cursor === 'pointer';
            if (!isClickable && !onclickStr.includes('editCell')) return;
            
            const match = onclickStr.match(/editCell\s*\(\s*["']?([^"',]+)["']?\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*["']?([^"']*)["']?\s*\)/);
            if (match) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                td.onclick = null; td.removeAttribute('onclick');
                enhancedEditCell(match[1], parseInt(match[2], 10), parseInt(match[3], 10), match[4] || '');
            }
        }, true);
        
        const observer = new MutationObserver(() => { overrideWindowEditCell(); });
        const scheduleContainer = document.getElementById('scheduleTable') || document.getElementById('unified-schedule');
        if (scheduleContainer) observer.observe(scheduleContainer, { childList: true, subtree: true });
        debugLog('Click interceptor installed');
    }

    // =========================================================================
    // v3.3 — POST-EDIT INTERACTIONS: RESIZE / MOVE / ADD / CONFLICT ENGINE
    // =========================================================================

    function peiSnap(min) { return Math.round(min / PEI_SNAP_MINS) * PEI_SNAP_MINS; }

    function peiToLabel(min) {
        const h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'PM' : 'AM';
        return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
    }

    function peiGetDivConfig(divName) { return (window.divisions || {})[divName] || {}; }

    function peiParseTime(v) {
        if (typeof v === 'number') return v;
        return window.SchedulerCoreUtils?.parseTimeToMinutes?.(v) || null;
    }

    function peiGetDivForBunk(bunk) {
        return window.SchedulerCoreUtils?.getDivisionForBunk?.(bunk) ||
               window.AccessControl?.getDivisionForBunk?.(bunk) || null;
    }

    function peiBunkActivities(bunk, divName) {
        const assignments = window.scheduleAssignments?.[bunk] || [];
        const divSlots = window.divisionTimes?.[divName] || [];
        const acts = [];
        for (let i = 0; i < Math.min(assignments.length, divSlots.length); i++) {
            const entry = assignments[i];
            if (!entry || entry.continuation) continue;
            const slot = divSlots[i];
            if (!slot) continue;
            let endIdx = i;
            for (let j = i + 1; j < assignments.length; j++) {
                if (assignments[j] && assignments[j].continuation) endIdx = j;
                else break;
            }
            acts.push({
                entry, slotIdx: i, endSlotIdx: endIdx,
                startMin: slot.startMin,
                endMin: divSlots[endIdx] ? divSlots[endIdx].endMin : slot.endMin,
                duration: (divSlots[endIdx] ? divSlots[endIdx].endMin : slot.endMin) - slot.startMin
            });
        }
        return acts;
    }

    function peiMinutesToTimeString(mins) {
        const h = Math.floor(mins / 60), m = mins % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    function peiTimeStringToMinutes(str) {
        if (!str) return null;
        const p = str.split(':');
        return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
    }

    // ── Conflict Engine (field/capacity only — overlaps are user's intent) ──

    const PEI_ConflictEngine = {
        check(bunk, proposedStart, proposedEnd, fieldName, excludeSlotIdx) {
            const result = { hasConflict: false, fieldConflicts: [], details: [] };
            if (fieldName && fieldName !== 'Free' && fieldName.toLowerCase() !== 'free') {
                let fieldOnly = fieldName;
                if (fieldName.includes(' – ')) fieldOnly = fieldName.split(' – ')[0].trim();
                if (window.TimeBasedFieldUsage?.checkAvailability) {
                    const actProps = (window.activityProperties || {})[fieldOnly] || {};
                    const capacity = actProps.sharableWith?.capacity ? parseInt(actProps.sharableWith.capacity) || 1 : (actProps.sharable ? 2 : 1);
                    const avail = window.TimeBasedFieldUsage.checkAvailability(fieldOnly, proposedStart, proposedEnd, capacity, bunk);
                    if (!avail.available) { result.fieldConflicts = avail.conflicts || []; result.hasConflict = true; }
                }
            }
            return result;
        }
    };

    // ── UI: Tooltip ──
    function peiShowTooltip(x, y, html) {
        if (!_peiTooltip) {
            _peiTooltip = document.createElement('div');
            _peiTooltip.id = 'pei-tooltip';
            _peiTooltip.style.cssText = 'position:fixed;z-index:100001;pointer-events:none;padding:8px 14px;background:#111827;color:#fff;border-radius:8px;font-size:12px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.4);display:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5;max-width:280px;white-space:nowrap;';
            document.body.appendChild(_peiTooltip);
        }
        _peiTooltip.innerHTML = html;
        _peiTooltip.style.display = 'block';
        const vw = window.innerWidth, vh = window.innerHeight;
        _peiTooltip.style.left = '0'; _peiTooltip.style.top = '0';
        const tw = _peiTooltip.offsetWidth, th = _peiTooltip.offsetHeight;
        let left = x, top = y - 10;
        if (left + tw > vw - 12) left = x - tw - 16;
        if (top + th > vh - 12) top = vh - th - 12;
        if (top < 8) top = 8;
        _peiTooltip.style.left = left + 'px'; _peiTooltip.style.top = top + 'px';
    }
    function peiHideTooltip() { if (_peiTooltip) _peiTooltip.style.display = 'none'; }

    // ── UI: Conflict indicators ──
    function peiShowConflictIndicator(block, cr) {
        peiClearConflictIndicators();
        if (!cr.hasConflict) { block.style.boxShadow = '0 0 0 2px #22c55e, 0 0 12px rgba(34,197,94,0.25)'; block._peiShadow = true; return; }
        block.style.boxShadow = '0 0 0 2px #f59e0b, 0 0 12px rgba(245,158,11,0.35)'; block._peiShadow = true;
    }
    function peiClearConflictIndicators() {
        _peiConflictOverlays.forEach(el => el.remove()); _peiConflictOverlays = [];
        document.querySelectorAll('.asg-block[data-pei-bunk]').forEach(blk => { if (blk._peiShadow) { blk.style.boxShadow = ''; blk._peiShadow = false; } });
    }

    function peiShowBanner(msg, type, showUndoHint) {
        document.getElementById('pei-conflict-banner')?.remove();
        const bg = type === 'error' ? '#fef2f2' : (type === 'warning' ? '#fffbeb' : '#f0fdf4');
        const bc = type === 'error' ? '#f87171' : (type === 'warning' ? '#f59e0b' : '#4ade80');
        const tc = type === 'error' ? '#991b1b' : (type === 'warning' ? '#92400e' : '#166534');
        const icon = type === 'error' ? '⚠️' : (type === 'warning' ? '⚡' : '✅');
        const b = document.createElement('div'); b.id = 'pei-conflict-banner';
        b.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100002;padding:12px 24px;background:${bg};border:2px solid ${bc};border-radius:12px;color:${tc};font-size:14px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,0.15);font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;gap:8px;animation:pei-slide-up 0.3s ease-out`;
        let html = icon + ' ' + msg;
        if (showUndoHint && _peiUndoStack.length > 0) {
            html += `<button onclick="window.PostEditInteractions.undo()" style="margin-left:12px;padding:4px 10px;border:1px solid ${bc};border-radius:6px;background:rgba(255,255,255,0.7);color:${tc};font-size:12px;cursor:pointer;font-weight:600;">↩ Undo</button>`;
            html += `<span style="font-size:11px;opacity:0.6;margin-left:4px;">(Ctrl+Z)</span>`;
        }
        b.innerHTML = html; document.body.appendChild(b);
        setTimeout(() => b.remove(), showUndoHint ? 5000 : 3500);
    }

    // ── Helper: mouse Y → time (position-based, not delta) ──
    function peiMouseYToTime(mouseY, col, dayStart) {
        const colRect = col.getBoundingClientRect();
        return peiSnap(dayStart + ((mouseY - colRect.top) / PEI_PX_PER_MIN));
    }

    // ── RESIZE (position-based — smooth, no jump) ──
    function peiStartResize(block, direction, e) {
        if (_peiMoving || _peiResizing) return;
        const divName = block.dataset.peiDivision;
        const dc = peiGetDivConfig(divName);
        const col = block.parentElement;
        _peiResizing = true;
        _peiState = {
            type: 'resize', direction, block, col,
            bunk: block.dataset.peiBunk,
            slotIdx: parseInt(block.dataset.peiSlotIdx, 10),
            origStartMin: parseInt(block.dataset.peiStartMin, 10),
            origEndMin: parseInt(block.dataset.peiEndMin, 10),
            currentStartMin: parseInt(block.dataset.peiStartMin, 10),
            currentEndMin: parseInt(block.dataset.peiEndMin, 10),
            fieldName: block.dataset.peiField || '', divName,
            dayStart: peiParseTime(dc.startTime) || 540,
            dayEnd: peiParseTime(dc.endTime) || 960
        };
        block.style.transition = 'none'; block.style.zIndex = '20';
        document.body.style.cursor = direction === 'top' ? 'n-resize' : 's-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', peiOnResizeMove);
        document.addEventListener('mouseup', peiOnResizeEnd);
    }

    function peiOnResizeMove(e) {
        if (!_peiResizing || !_peiState) return;
        const s = _peiState;
        const mouseTime = peiMouseYToTime(e.clientY, s.col, s.dayStart);
        let newStart = s.origStartMin, newEnd = s.origEndMin;
        if (s.direction === 'top') newStart = Math.max(s.dayStart, Math.min(s.origEndMin - PEI_MIN_BLOCK_DURATION, mouseTime));
        else newEnd = Math.min(s.dayEnd, Math.max(s.origStartMin + PEI_MIN_BLOCK_DURATION, mouseTime));
        s.currentStartMin = newStart; s.currentEndMin = newEnd;
        s.block.style.top = ((newStart - s.dayStart) * PEI_PX_PER_MIN + 2) + 'px';
        s.block.style.height = ((newEnd - newStart) * PEI_PX_PER_MIN - 4) + 'px';
        // Update duration label
        const dur = newEnd - newStart;
        const durLabel = s.block.querySelector('.asg-block-sub:last-child');
        if (durLabel && /\d+min/.test(durLabel.textContent)) durLabel.textContent = dur + 'min';
        // Tooltip at block edge
        const br = s.block.getBoundingClientRect();
        let tip = peiToLabel(newStart) + ' – ' + peiToLabel(newEnd) + ` <span style="opacity:0.6">(${dur}min)</span>`;
        const c = PEI_ConflictEngine.check(s.bunk, newStart, newEnd, s.fieldName, s.slotIdx);
        if (c.fieldConflicts.length > 0) tip += `<br><span style="color:#fcd34d;">⚡ Field: ${c.fieldConflicts.map(x => x.bunk).join(', ')}</span>`;
        peiShowTooltip(br.right + 8, s.direction === 'bottom' ? br.bottom : br.top, tip);
        peiShowConflictIndicator(s.block, c);
    }

    function peiOnResizeEnd() {
        document.removeEventListener('mousemove', peiOnResizeMove);
        document.removeEventListener('mouseup', peiOnResizeEnd);
        if (!_peiResizing || !_peiState) return;
        _peiSuppressClick = true;
        const s = _peiState;
        peiHideTooltip(); peiClearConflictIndicators();
        s.block.style.transition = ''; s.block.style.zIndex = '';
        document.body.style.cursor = ''; document.body.style.userSelect = '';
        if (s.currentStartMin === s.origStartMin && s.currentEndMin === s.origEndMin) { _peiResizing = false; _peiState = null; return; }
        // Update block data attributes to new position
        s.block.dataset.peiStartMin = s.currentStartMin;
        s.block.dataset.peiEndMin = s.currentEndMin;
        // Ensure duration label is final
        const finalDur = s.currentEndMin - s.currentStartMin;
        const durLabel = s.block.querySelector('.asg-block-sub:last-child');
        if (durLabel && /\d+min/.test(durLabel.textContent)) durLabel.textContent = finalDur + 'min';
        const c = PEI_ConflictEngine.check(s.bunk, s.currentStartMin, s.currentEndMin, s.fieldName, s.slotIdx);
        peiApplyTimeChange(s.bunk, s.slotIdx, s.origStartMin, s.origEndMin, s.currentStartMin, s.currentEndMin, s.divName);
        if (c.fieldConflicts.length > 0) peiShowBanner('Resized — field conflict: ' + c.fieldConflicts.map(x => x.bunk).join(', '), 'warning', true);
        else peiShowBanner('Resized to ' + peiToLabel(s.currentStartMin) + ' – ' + peiToLabel(s.currentEndMin), 'success', true);
        _peiResizing = false; _peiState = null;
    }

    // ── MOVE (position-based — grab offset preserved) ──
    function peiStartMove(block, e) {
        if (_peiMoving || _peiResizing) return;
        const startMin = parseInt(block.dataset.peiStartMin, 10), endMin = parseInt(block.dataset.peiEndMin, 10);
        const divName = block.dataset.peiDivision;
        const dc = peiGetDivConfig(divName);
        const col = block.parentElement;
        const grabOffsetPx = e.clientY - block.getBoundingClientRect().top;
        _peiMoving = true;
        _peiState = {
            type: 'move', block, col,
            bunk: block.dataset.peiBunk,
            slotIdx: parseInt(block.dataset.peiSlotIdx, 10),
            origStartMin: startMin, origEndMin: endMin,
            currentStartMin: startMin, currentEndMin: endMin,
            duration: endMin - startMin,
            fieldName: block.dataset.peiField || '',
            divName, dayStart: peiParseTime(dc.startTime) || 540, dayEnd: peiParseTime(dc.endTime) || 960,
            grabOffsetPx
        };
        block.style.transition = 'none'; block.style.zIndex = '20'; block.style.opacity = '0.85'; block.style.cursor = 'grabbing';
        document.body.style.cursor = 'grabbing'; document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', peiOnMoveMove);
        document.addEventListener('mouseup', peiOnMoveEnd);
    }

    function peiOnMoveMove(e) {
        if (!_peiMoving || !_peiState) return;
        const s = _peiState;
        const topTime = peiMouseYToTime(e.clientY - s.grabOffsetPx, s.col, s.dayStart);
        let newStart = Math.max(s.dayStart, Math.min(s.dayEnd - s.duration, topTime));
        s.currentStartMin = newStart; s.currentEndMin = newStart + s.duration;
        s.block.style.top = ((newStart - s.dayStart) * PEI_PX_PER_MIN + 2) + 'px';
        const br = s.block.getBoundingClientRect();
        let tip = '↕ ' + peiToLabel(newStart) + ' – ' + peiToLabel(newStart + s.duration);
        const c = PEI_ConflictEngine.check(s.bunk, newStart, newStart + s.duration, s.fieldName, s.slotIdx);
        if (c.fieldConflicts.length > 0) tip += `<br><span style="color:#fcd34d;">⚡ Field: ${c.fieldConflicts.map(x => x.bunk).join(', ')}</span>`;
        peiShowTooltip(br.right + 8, br.top, tip);
        peiShowConflictIndicator(s.block, c);
    }

    function peiOnMoveEnd() {
        document.removeEventListener('mousemove', peiOnMoveMove);
        document.removeEventListener('mouseup', peiOnMoveEnd);
        if (!_peiMoving || !_peiState) return;
        _peiSuppressClick = true; _peiPendingMove = null;
        const s = _peiState;
        peiHideTooltip(); peiClearConflictIndicators();
        s.block.style.transition = ''; s.block.style.zIndex = ''; s.block.style.opacity = ''; s.block.style.cursor = '';
        document.body.style.cursor = ''; document.body.style.userSelect = '';
        if (s.currentStartMin === s.origStartMin) { _peiMoving = false; _peiState = null; return; }
        // Update block data attributes to new position
        s.block.dataset.peiStartMin = s.currentStartMin;
        s.block.dataset.peiEndMin = s.currentEndMin;
        const c = PEI_ConflictEngine.check(s.bunk, s.currentStartMin, s.currentEndMin, s.fieldName, s.slotIdx);
        peiApplyTimeChange(s.bunk, s.slotIdx, s.origStartMin, s.origEndMin, s.currentStartMin, s.currentEndMin, s.divName);
        if (c.fieldConflicts.length > 0) peiShowBanner('Moved — field conflict: ' + c.fieldConflicts.map(x => x.bunk).join(', '), 'warning', true);
        else peiShowBanner('Moved to ' + peiToLabel(s.currentStartMin) + ' – ' + peiToLabel(s.currentEndMin), 'success', true);
        _peiMoving = false; _peiState = null;
    }

    // ── DELETE ──
    function peiDeleteBlock(bunk, slotIdx, divName, activityName) {
        const assignments = window.scheduleAssignments?.[bunk];
        if (!assignments) return;
        peiSnapshotBunk(bunk, `Delete ${activityName}`);
        const slots = peiFindEntrySlots(assignments, slotIdx);
        slots.forEach(idx => { assignments[idx] = null; });
        peiTriggerReRender();
        peiSave(bunk);
        peiShowBanner('Deleted: ' + activityName, 'success', true);
    }

    // ── Pending move: threshold ──
    function peiOnPendingMoveCheck(e) {
        if (!_peiPendingMove || _peiPendingMove.started) return;
        if (Math.sqrt((e.clientX - _peiPendingMove.startX) ** 2 + (e.clientY - _peiPendingMove.startY) ** 2) >= PEI_DRAG_THRESHOLD) {
            _peiPendingMove.started = true;
            document.removeEventListener('mousemove', peiOnPendingMoveCheck);
            document.removeEventListener('mouseup', peiOnPendingMoveCancel);
            peiStartMove(_peiPendingMove.block, { clientY: _peiPendingMove.startY, preventDefault() {} });
            peiOnMoveMove(e);
        }
    }
    function peiOnPendingMoveCancel() {
        document.removeEventListener('mousemove', peiOnPendingMoveCheck);
        document.removeEventListener('mouseup', peiOnPendingMoveCancel);
        _peiPendingMove = null;
    }

    // ── Click suppressor (capturing phase) ──
    function peiInstallClickSuppressor() {
        document.addEventListener('click', (e) => {
            if (_peiSuppressClick) { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); _peiSuppressClick = false; return; }
            if (_peiResizing || _peiMoving) { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); }
        }, true);
    }


    function peiHandleDoubleClickAdd(col, e) {
        const bunk = col.dataset.peiBunk, divName = col.dataset.peiDivision;
        if (!bunk || !divName || !canEditBunk(bunk)) { if (window.showToast) window.showToast('No permission to edit ' + bunk, 'error'); return; }
        const dc = peiGetDivConfig(divName);
        const dayStart = peiParseTime(dc.startTime) || 540;
        const clickMin = peiSnap(dayStart + ((e.clientY - col.getBoundingClientRect().top) / PEI_PX_PER_MIN));
        const acts = peiBunkActivities(bunk, divName);
        for (const a of acts) { if (a.startMin <= clickMin && a.endMin > clickMin) return; }
        let newStart = clickMin, newEnd = clickMin + 30;
        const nextBlock = acts.find(a => a.startMin > newStart);
        if (nextBlock && newEnd > nextBlock.startMin) newEnd = nextBlock.startMin;
        let prevBlock = null;
        for (let j = acts.length - 1; j >= 0; j--) { if (acts[j].endMin <= newStart) { prevBlock = acts[j]; break; } }
        if (prevBlock && newStart < prevBlock.endMin) { newStart = prevBlock.endMin; newEnd = newStart + 30; if (nextBlock && newEnd > nextBlock.startMin) newEnd = nextBlock.startMin; }
        if (newEnd - newStart < PEI_MIN_BLOCK_DURATION) { peiShowBanner('Not enough space here', 'error'); return; }
        peiShowAddModal(bunk, divName, newStart, newEnd);
    }

    function peiShowAddModal(bunk, divName, startMin, endMin) {
        document.getElementById('pei-add-overlay')?.remove();
        const locations = getAllLocations();
        const fieldOpts = locations.filter(l => l.type === 'field').map(l => `<option value="${l.name}">${l.name}${l.capacity > 1 ? ` (cap:${l.capacity})` : ''}</option>`).join('');
        const specOpts = locations.filter(l => l.type === 'special').map(l => `<option value="${l.name}">${l.name}</option>`).join('');
        const todayDone = new Set();
        peiBunkActivities(bunk, divName).forEach(a => { const n = (a.entry._activity || '').toLowerCase(); if (n && n !== 'free') todayDone.add(n); });
        const suggestions = [];
        const app1 = (window.loadGlobalSettings?.() || {}).app1 || {};
        (app1.fields || []).forEach(f => { if (!f.name || f.available === false) return; (f.activities || f.sports || []).forEach(sport => { const sn = typeof sport === 'string' ? sport : sport.name; if (sn && !todayDone.has(sn.toLowerCase())) suggestions.push({ name: sn, field: f.name }); }); });
        (app1.specialActivities || []).forEach(s => { if (s.name && !todayDone.has(s.name.toLowerCase())) suggestions.push({ name: s.name, field: s.name }); });
        const sugHtml = suggestions.length > 0 ? `<div><label style="display:block;font-weight:500;color:#374151;margin-bottom:8px;">Quick Pick</label><div id="pei-add-suggestions" style="display:flex;flex-wrap:wrap;gap:6px;">${suggestions.slice(0, 8).map(a => `<button class="pei-suggestion-btn" data-activity="${a.name}" data-field="${a.field || ''}" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:20px;background:#fff;font-size:0.8rem;cursor:pointer;color:#374151;transition:all 0.15s;">${a.name}${a.field ? ` <span style='font-size:0.7rem;opacity:0.6'>@ ${a.field}</span>` : ''}</button>`).join('')}</div></div>` : '';

        const overlay = document.createElement('div'); overlay.id = 'pei-add-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100003;display:flex;align-items:center;justify-content:center;animation:pei-fade-in 0.2s ease-out';
        overlay.innerHTML = `<div style="background:#fff;border-radius:16px;padding:28px;min-width:420px;max-width:520px;max-height:85vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><h2 style="margin:0;font-size:1.2rem;color:#1f2937;">Add New Activity</h2><button id="pei-add-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#9ca3af;line-height:1;">&times;</button></div>
            <div style="background:#f3f4f6;padding:12px 16px;border-radius:8px;margin-bottom:20px;"><div style="font-weight:600;color:#374151;">${bunk}</div><div style="font-size:0.875rem;color:#6b7280;">${peiToLabel(startMin)} – ${peiToLabel(endMin)} (${endMin - startMin}min)</div></div>
            <div style="display:flex;flex-direction:column;gap:16px;">
                <div><label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Activity Name</label><input type="text" id="pei-add-activity" placeholder="e.g., Basketball" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;"></div>
                <div><label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Location / Field</label><select id="pei-add-location" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;background:white;"><option value="">-- No location --</option>${fieldOpts ? '<optgroup label="Fields">' + fieldOpts + '</optgroup>' : ''}${specOpts ? '<optgroup label="Specials">' + specOpts + '</optgroup>' : ''}</select></div>
                <div><div id="pei-add-time-toggle" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.875rem;color:#6b7280;"><span id="pei-add-time-arrow">▶</span> Adjust time</div><div id="pei-add-time-section" style="display:none;margin-top:10px;"><div style="display:flex;gap:12px;"><div style="flex:1;"><label style="display:block;font-size:0.8rem;color:#6b7280;margin-bottom:4px;">Start</label><input type="time" id="pei-add-start" value="${peiMinutesToTimeString(startMin)}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:0.9rem;box-sizing:border-box;"></div><div style="flex:1;"><label style="display:block;font-size:0.8rem;color:#6b7280;margin-bottom:4px;">End</label><input type="time" id="pei-add-end" value="${peiMinutesToTimeString(endMin)}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:0.9rem;box-sizing:border-box;"></div></div></div></div>
                <div id="pei-add-conflict-status" style="display:none;"></div>
                ${sugHtml}
                <div style="display:flex;gap:12px;margin-top:4px;"><button id="pei-add-auto" style="flex:1;padding:12px;border:2px dashed #a5b4fc;border-radius:8px;background:#eef2ff;color:#4338ca;font-size:0.95rem;cursor:pointer;font-weight:600;">✨ Auto-fill</button></div>
                <div style="display:flex;gap:12px;"><button id="pei-add-cancel" style="flex:1;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:white;color:#374151;font-size:1rem;cursor:pointer;font-weight:500;">Cancel</button><button id="pei-add-save" style="flex:1;padding:12px;border:none;border-radius:8px;background:#2563eb;color:white;font-size:1rem;cursor:pointer;font-weight:500;">Add Activity</button></div>
            </div></div>`;
        document.body.appendChild(overlay);

        const closeAdd = () => overlay.remove();
        overlay.addEventListener('click', e => { if (e.target === overlay) closeAdd(); });
        document.getElementById('pei-add-close').onclick = closeAdd;
        document.getElementById('pei-add-cancel').onclick = closeAdd;
        document.getElementById('pei-add-time-toggle').onclick = () => { const sec = document.getElementById('pei-add-time-section'); const hidden = sec.style.display === 'none'; sec.style.display = hidden ? 'block' : 'none'; document.getElementById('pei-add-time-arrow').textContent = hidden ? '▼' : '▶'; };
        document.querySelectorAll('.pei-suggestion-btn').forEach(btn => {
            btn.onclick = () => {
                document.getElementById('pei-add-activity').value = btn.dataset.activity;
                const loc = document.getElementById('pei-add-location');
                if (btn.dataset.field) { for (let i = 0; i < loc.options.length; i++) { if (loc.options[i].value === btn.dataset.field) { loc.selectedIndex = i; break; } } }
                document.querySelectorAll('.pei-suggestion-btn').forEach(b => { b.style.background = '#fff'; b.style.borderColor = '#d1d5db'; });
                btn.style.background = '#dbeafe'; btn.style.borderColor = '#3b82f6';
                peiCheckAddConflict(bunk, startMin, endMin);
            };
        });
        document.getElementById('pei-add-auto').onclick = () => {
            const r = peiAutoFill(bunk, divName, startMin, endMin);
            if (r) { document.getElementById('pei-add-activity').value = r.activity; const loc = document.getElementById('pei-add-location'); if (r.field) { for (let i = 0; i < loc.options.length; i++) { if (loc.options[i].value === r.field) { loc.selectedIndex = i; break; } } } peiCheckAddConflict(bunk, startMin, endMin); peiShowBanner('Auto-filled: ' + r.activity, 'success'); }
            else peiShowBanner('No suitable activity found', 'warning');
        };
        document.getElementById('pei-add-location').onchange = () => peiCheckAddConflict(bunk, startMin, endMin);
        document.getElementById('pei-add-activity').oninput = () => peiCheckAddConflict(bunk, startMin, endMin);
        document.getElementById('pei-add-save').onclick = () => {
            const activity = document.getElementById('pei-add-activity').value.trim();
            if (!activity) { alert('Please enter an activity name.'); return; }
            let adjStart = startMin, adjEnd = endMin;
            if (document.getElementById('pei-add-time-section').style.display !== 'none') { adjStart = peiTimeStringToMinutes(document.getElementById('pei-add-start').value) || startMin; adjEnd = peiTimeStringToMinutes(document.getElementById('pei-add-end').value) || endMin; }
            if (adjEnd <= adjStart) { alert('End must be after start.'); return; }
            const location = document.getElementById('pei-add-location').value || null;
            const conflicts = PEI_ConflictEngine.check(bunk, adjStart, adjEnd, location, -1);
            if (conflicts.fieldConflicts.length > 0 && !confirm('Field conflict on ' + location + '. Continue?')) return;
            peiApplyNewBlock(bunk, divName, adjStart, adjEnd, activity, location);
            closeAdd();
            peiShowBanner('Added: ' + activity + ' at ' + peiToLabel(adjStart) + ' – ' + peiToLabel(adjEnd), 'success', true);
        };
        document.getElementById('pei-add-activity').focus();
        document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { closeAdd(); document.removeEventListener('keydown', esc); } });
    }

    function peiCheckAddConflict(bunk, startMin, endMin) {
        const location = document.getElementById('pei-add-location')?.value || '';
        const el = document.getElementById('pei-add-conflict-status');
        if (!el || !location) { if (el) el.style.display = 'none'; return; }
        const c = PEI_ConflictEngine.check(bunk, startMin, endMin, location, -1);
        if (!c.hasConflict) { el.style.display = 'block'; el.style.cssText = 'padding:10px 14px;border-radius:8px;background:#f0fdf4;border:1px solid #86efac;color:#166534;font-size:0.85rem;display:block;'; el.innerHTML = '✅ ' + location + ' is available'; }
        else if (c.fieldConflicts.length > 0) { el.style.display = 'block'; el.style.cssText = 'padding:10px 14px;border-radius:8px;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;font-size:0.85rem;display:block;'; el.innerHTML = '⚠️ ' + location + ' in use by: ' + c.fieldConflicts.map(x => x.bunk).join(', '); }
    }

    // ── Auto-fill ──
    function peiAutoFill(bunk, divName, startMin, endMin) {
        const todayDone = new Set();
        peiBunkActivities(bunk, divName).forEach(a => { const n = (a.entry._activity || '').toLowerCase(); if (n && n !== 'free') todayDone.add(n); });
        const app1 = (window.loadGlobalSettings?.() || {}).app1 || {};
        const candidates = [];
        (app1.fields || []).forEach(f => {
            if (!f.name || f.available === false) return;
            (f.activities || f.sports || []).forEach(sport => {
                const sn = typeof sport === 'string' ? sport : sport.name;
                if (!sn || todayDone.has(sn.toLowerCase())) return;
                const cap = f.sharableWith?.capacity ? parseInt(f.sharableWith.capacity) || 1 : 1;
                let avail = true;
                if (window.TimeBasedFieldUsage?.checkAvailability) avail = window.TimeBasedFieldUsage.checkAvailability(f.name, startMin, endMin, cap, bunk).available;
                candidates.push({ activity: sn, field: f.name, available: avail, score: avail ? (100 - (window.RotationEngine?.getActivityCount?.(bunk, sn) || 0)) : -100 });
            });
        });
        (app1.specialActivities || []).forEach(s => {
            if (!s.name || todayDone.has(s.name.toLowerCase())) return;
            const cap = s.sharableWith?.capacity ? parseInt(s.sharableWith.capacity) || 1 : 1;
            let avail = true;
            if (window.TimeBasedFieldUsage?.checkAvailability) avail = window.TimeBasedFieldUsage.checkAvailability(s.name, startMin, endMin, cap, bunk).available;
            candidates.push({ activity: s.name, field: s.name, available: avail, score: avail ? (100 - (window.RotationEngine?.getActivityCount?.(bunk, s.name) || 0)) : -100 });
        });
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0] || null;
    }

    // ── Undo system ──

    function peiSnapshotBunk(bunk, description) {
        const assignments = window.scheduleAssignments?.[bunk];
        if (!assignments) return;
        // Deep copy via JSON (safe for our data)
        const snapshot = JSON.parse(JSON.stringify(assignments));
        _peiUndoStack.push({ bunk, snapshot, description, timestamp: Date.now() });
        if (_peiUndoStack.length > PEI_MAX_UNDO) _peiUndoStack.shift();
        debugLog('Undo snapshot saved:', description, '(stack size:', _peiUndoStack.length + ')');
    }

    function peiUndo() {
        if (_peiUndoStack.length === 0) {
            peiShowBanner('Nothing to undo', 'warning');
            return;
        }
        const last = _peiUndoStack.pop();
        window.scheduleAssignments[last.bunk] = last.snapshot;
        debugLog('Undo:', last.description, 'for', last.bunk);
        peiTriggerReRender();
        peiSave(last.bunk);
        peiShowBanner('↩ Undid: ' + last.description, 'success');
    }

    // ── Apply changes (safe slot management) ──

    /**
     * Find ALL slot indices that a given entry occupies (primary + continuations).
     * Walks forward from slotIdx while continuations exist.
     */
    function peiFindEntrySlots(assignments, slotIdx) {
        const slots = [slotIdx];
        for (let c = slotIdx + 1; c < assignments.length; c++) {
            if (assignments[c] && assignments[c].continuation) slots.push(c);
            else break;
        }
        return slots;
    }

    function peiApplyTimeChange(bunk, origSlotIdx, origStart, origEnd, newStart, newEnd, divName) {
        const divSlots = window.divisionTimes?.[divName] || [];
        const assignments = window.scheduleAssignments?.[bunk];
        if (!assignments) return;
        const origEntry = assignments[origSlotIdx];
        if (!origEntry) return;

        // Snapshot for undo BEFORE any changes
        const actName = origEntry._activity || origEntry.field || 'block';
        if (newStart !== origStart || newEnd !== origEnd) {
            peiSnapshotBunk(bunk, (newEnd - newStart) !== (origEnd - origStart)
                ? `Resize ${actName} (${origEnd - origStart}m → ${newEnd - newStart}m)`
                : `Move ${actName} to ${peiToLabel(newStart)}`);
        }

        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();

        // 1) Find ALL slots the original entry occupies
        const oldSlots = peiFindEntrySlots(assignments, origSlotIdx);

        // 2) Save a clean copy of the entry (without continuation flag)
        const cleanEntry = Object.assign({}, origEntry, { continuation: false });

        // 3) Clear ONLY the slots this entry occupied
        oldSlots.forEach(idx => { assignments[idx] = null; });

        // 4) Find new target slots by time overlap
        const newSlotIndices = [];
        for (let i = 0; i < divSlots.length; i++) {
            if (divSlots[i].startMin < newEnd && divSlots[i].endMin > newStart) {
                newSlotIndices.push(i);
            }
        }

        if (newSlotIndices.length === 0) {
            debugLog('PEI: No slots found for', newStart, '-', newEnd, '— reverting');
            // Restore original
            oldSlots.forEach((idx, i) => {
                if (i === 0) assignments[idx] = cleanEntry;
                else assignments[idx] = { field: cleanEntry.field, sport: cleanEntry.sport, _activity: cleanEntry._activity, continuation: true };
            });
            window._postEditInProgress = false;
            _peiUndoStack.pop(); // Remove the snapshot we just pushed
            return;
        }

        // 5) Write to new slots — only overwrite null/Free entries, skip occupied entries
        newSlotIndices.forEach((idx, i) => {
            const existing = assignments[idx];
            const isOccupied = existing && !existing.continuation &&
                existing._activity && existing._activity.toLowerCase() !== 'free';
            if (isOccupied && !oldSlots.includes(idx)) {
                // Don't overwrite another activity — skip this slot
                debugLog('PEI: Skipping occupied slot', idx, '(has', existing._activity + ')');
                return;
            }
            if (i === 0 || !assignments[newSlotIndices[0]]) {
                // Primary entry at first available slot
                if (!assignments[newSlotIndices[0]]) {
                    assignments[idx] = Object.assign({}, cleanEntry, {
                        _startMin: newStart, _endMin: newEnd, _blockStart: newStart, _postEdited: true
                    });
                } else if (i > 0) {
                    assignments[idx] = {
                        field: cleanEntry.field, sport: cleanEntry.sport,
                        _activity: cleanEntry._activity, continuation: true, _postEdited: true
                    };
                }
            } else {
                assignments[idx] = {
                    field: cleanEntry.field, sport: cleanEntry.sport,
                    _activity: cleanEntry._activity, continuation: true, _postEdited: true
                };
            }
        });

        // Make sure first written slot is the primary (non-continuation)
        const firstWritten = newSlotIndices.find(idx => assignments[idx] && assignments[idx]._postEdited);
        if (firstWritten !== undefined && assignments[firstWritten]) {
            assignments[firstWritten] = Object.assign({}, cleanEntry, {
                continuation: false, _startMin: newStart, _endMin: newEnd, _blockStart: newStart, _postEdited: true
            });
        }

        // Do NOT re-render — the drag already positioned the block correctly.
        // Re-rendering would snap it back to slot boundaries.
        // Only save the data. Delete/Add/Undo handle their own re-renders.
        peiSave(bunk);
    }

    function peiApplyNewBlock(bunk, divName, startMin, endMin, activity, location) {
        const divSlots = window.divisionTimes?.[divName] || [];
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length);
        const assignments = window.scheduleAssignments[bunk];

        // Snapshot for undo
        peiSnapshotBunk(bunk, `Add ${activity} at ${peiToLabel(startMin)}`);

        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();

        const newSlots = [];
        for (let i = 0; i < divSlots.length; i++) {
            if (divSlots[i].startMin < endMin && divSlots[i].endMin > startMin) newSlots.push(i);
        }
        const fieldValue = location ? location + ' – ' + activity : activity;
        newSlots.forEach((idx, i) => {
            assignments[idx] = {
                field: fieldValue, sport: activity, _activity: activity,
                continuation: i > 0, _fixed: true, _postEdited: true, _pinned: true,
                _startMin: startMin, _endMin: endMin, _blockStart: startMin
            };
        });
        peiTriggerReRender();
        peiSave(bunk);
    }

    function peiTriggerReRender() {
        // Clear augmented flags so observer re-augments after render
        document.querySelectorAll('.asg-wrap[data-pei-augmented]').forEach(w => delete w.dataset.peiAugmented);
        if (window.UnifiedScheduleSystem?.renderStaggeredView) window.UnifiedScheduleSystem.renderStaggeredView();
        else if (window.updateTable) window.updateTable();
        // Re-augment after render completes
        setTimeout(() => {
            peiAugmentGrid();
            window._postEditInProgress = false;
        }, 300);
    }

    function peiSave(bunk) {
        // Ensure flag is set
        window._postEditInProgress = true;
        if (typeof window.resolveAndSaveSchedule === 'function') window.resolveAndSaveSchedule(bunk);
        else if (typeof bypassSaveAllBunks === 'function') bypassSaveAllBunks([bunk]);
        else if (window.ScheduleDB?.saveBunkSchedule) {
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            window.ScheduleDB.saveBunkSchedule(dateKey, bunk, window.scheduleAssignments[bunk]);
        }
        peiUpdateRotationHistory(bunk);
        // Release flag after save settles
        setTimeout(() => { window._postEditInProgress = false; }, 500);
    }

    function peiUpdateRotationHistory(bunk) {
        try {
            const history = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
            history.bunks = history.bunks || {};
            history.bunks[bunk] = history.bunks[bunk] || {};
            const assignments = window.scheduleAssignments?.[bunk] || [];
            const timestamp = Date.now();
            const SKIP = new Set(['free', 'free play', 'free (timeout)', 'transition/buffer', 'regroup', 'lineup', 'bus', 'buffer']);
            for (const entry of assignments) {
                if (!entry || entry.continuation || entry._isTransition) continue;
                const actName = entry._activity || '';
                if (!actName || SKIP.has(actName.toLowerCase())) continue;
                history.bunks[bunk][actName] = timestamp;
            }
            window.saveRotationHistory?.(history);
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            if (window.SchedulerCoreUtils?.reIncrementHistoricalCounts) {
                setTimeout(() => window.SchedulerCoreUtils.reIncrementHistoricalCounts(dateKey, window.scheduleAssignments || {}, true), 200);
            } else if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                setTimeout(() => window.SchedulerCoreUtils.rebuildHistoricalCounts(true), 200);
            }
            debugLog('v3.3: Rotation history updated for', bunk);
        } catch (e) { console.error('[PostEdit] Rotation history update failed:', e); }
    }

    // ── Grid augmentation ──
    function peiAugmentGrid() {
        const wraps = document.querySelectorAll('.asg-wrap');
        if (wraps.length === 0) return;
        wraps.forEach(wrap => {
            if (wrap.dataset.peiAugmented === '1') return;
            const header = wrap.querySelector('.asg-header-title');
            const divName = header ? header.textContent.trim() : '';
            if (!divName) return;
            const divConfig = peiGetDivConfig(divName);
            const dayStart = peiParseTime(divConfig.startTime) || 540;
            const bunks = divConfig.bunks || [];
            const scrollEl = wrap.querySelector('.asg-scroll');
            if (!scrollEl) return;
            // Navigate from any block to find bodyRow (blocks are direct children of bunk columns)
            const firstBlock = scrollEl.querySelector('.asg-block') || scrollEl.querySelector('.asg-free');
            if (!firstBlock) { debugLog('PEI: No blocks found in', divName); return; }
            const bodyRow = firstBlock.parentElement.parentElement;
            // Bunk columns are always the first N children; league overlays are appended after
            const bunkCols = Array.from(bodyRow.children).slice(0, bunks.length);
            if (bunkCols.length !== bunks.length) { debugLog('PEI: column mismatch', bunkCols.length, bunks.length); return; }

            bunkCols.forEach((col, idx) => {
                const bunk = bunks[idx];
                if (!bunk) return;
                col.dataset.peiBunk = bunk; col.dataset.peiDivision = divName;

                // Fix 3: Add "+" buttons to free blocks (no dblclick needed)
                if (canEditBunk(bunk)) {
                    col.querySelectorAll('.asg-free').forEach(freeEl => {
                        const addBtn = document.createElement('div');
                        addBtn.className = 'pei-add-btn';
                        addBtn.innerHTML = '+';
                        addBtn.title = 'Add activity here';
                        addBtn.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;background:rgba(37,99,235,0.1);color:#2563eb;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.2s,background 0.2s;z-index:4;pointer-events:auto;';
                        freeEl.style.position = 'absolute'; // ensure positioning context
                        freeEl.appendChild(addBtn);
                        freeEl.addEventListener('mouseenter', () => { addBtn.style.opacity = '1'; });
                        freeEl.addEventListener('mouseleave', () => { addBtn.style.opacity = '0'; });
                        addBtn.addEventListener('mouseenter', () => { addBtn.style.background = 'rgba(37,99,235,0.2)'; });
                        addBtn.addEventListener('mouseleave', () => { addBtn.style.background = 'rgba(37,99,235,0.1)'; });
                        addBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            peiHandleDoubleClickAdd(col, e);
                        });
                    });
                }
                const bunkActs = peiBunkActivities(bunk, divName);
                const blocks = col.querySelectorAll('.asg-block');
                // Blocks render in same order as peiBunkActivities — match by index
                blocks.forEach((blk, bi) => {
                    const matched = bunkActs[bi];
                    if (!matched) return;
                    blk.dataset.peiBunk = bunk; blk.dataset.peiStartMin = matched.startMin; blk.dataset.peiEndMin = matched.endMin;
                    blk.dataset.peiSlotIdx = matched.slotIdx; blk.dataset.peiDivision = divName;
                    blk.dataset.peiField = matched.entry.field || ''; blk.dataset.peiActivity = matched.entry._activity || '';
                    if (!canEditBunk(bunk)) { blk.style.cursor = 'not-allowed'; return; }
                    blk.style.cursor = 'grab';
                    blk.style.overflow = 'visible'; // Override grid CSS overflow:hidden

                    // Resize handles — INSIDE block bounds so overflow:hidden can't clip
                    const topH = document.createElement('div'); topH.className = 'pei-resize-handle pei-resize-top';
                    topH.style.cssText = 'position:absolute;top:0;left:0;right:0;height:6px;cursor:n-resize;z-index:10;opacity:0;transition:opacity 0.15s;border-radius:5px 5px 0 0;';
                    blk.appendChild(topH);
                    const botH = document.createElement('div'); botH.className = 'pei-resize-handle pei-resize-bottom';
                    botH.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:6px;cursor:s-resize;z-index:10;opacity:0;transition:opacity 0.15s;border-radius:0 0 5px 5px;';
                    blk.appendChild(botH);
                    blk.addEventListener('mouseenter', () => { if (!_peiResizing && !_peiMoving) { topH.style.opacity = '1'; botH.style.opacity = '1'; } });
                    blk.addEventListener('mouseleave', () => { if (!_peiResizing && !_peiMoving) { topH.style.opacity = '0'; botH.style.opacity = '0'; } });
                    topH.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); peiStartResize(blk, 'top', e); });
                    botH.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); peiStartResize(blk, 'bottom', e); });
                    blk.addEventListener('mousedown', e => {
                        if (e.target.classList.contains('pei-resize-handle') || e.target.classList.contains('pei-resize-top') || e.target.classList.contains('pei-resize-bottom')) return;
                        if (e.button !== 0) return;
                        _peiPendingMove = { block: blk, startX: e.clientX, startY: e.clientY, started: false };
                        document.addEventListener('mousemove', peiOnPendingMoveCheck);
                        document.addEventListener('mouseup', peiOnPendingMoveCancel);
                    });
                });
            });
            wrap.dataset.peiAugmented = '1';
        });
    }

    // ── Touch ──
    function peiSetupTouch() {
        if (window.MobileTouchDrag) return;
        document.addEventListener('touchstart', (e) => {
            const target = e.target;
            if (target.classList.contains('pei-resize-handle')) { e.preventDefault(); const block = target.closest('.asg-block'); if (!block) return; peiStartResize(block, target.classList.contains('pei-resize-top') ? 'top' : 'bottom', { clientY: e.touches[0].clientY, preventDefault() {} }); return; }
            const block = target.closest('.asg-block[data-pei-bunk]');
            if (block) { const sy = e.touches[0].clientY; block._peiLP = setTimeout(() => { peiStartMove(block, { clientY: sy, preventDefault() {} }); if (navigator.vibrate) navigator.vibrate(30); }, PEI_LONG_PRESS_MS); block._peiTS = { x: e.touches[0].clientX, y: sy }; }
        }, { passive: false });
        document.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            document.querySelectorAll('.asg-block[data-pei-bunk]').forEach(b => { if (b._peiLP && b._peiTS && Math.sqrt((t.clientX - b._peiTS.x) ** 2 + (t.clientY - b._peiTS.y) ** 2) > 10) { clearTimeout(b._peiLP); b._peiLP = null; } });
            if (_peiResizing) { e.preventDefault(); peiOnResizeMove({ clientX: t.clientX, clientY: t.clientY }); }
            if (_peiMoving) { e.preventDefault(); peiOnMoveMove({ clientX: t.clientX, clientY: t.clientY }); }
        }, { passive: false });
        document.addEventListener('touchend', (e) => {
            document.querySelectorAll('.asg-block[data-pei-bunk]').forEach(b => { if (b._peiLP) { clearTimeout(b._peiLP); b._peiLP = null; } });
            if (_peiResizing) peiOnResizeEnd();
            if (_peiMoving) peiOnMoveEnd();
        });
    }

    // ── Observer ──
    function peiSetupObserver() {
        const target = document.getElementById('unified-schedule') || document.getElementById('scheduleContainer') || document.body;
        const obs = new MutationObserver(() => { clearTimeout(obs._d); obs._d = setTimeout(() => { if (document.querySelectorAll('.asg-wrap:not([data-pei-augmented="1"])').length > 0) peiAugmentGrid(); }, 200); });
        obs.observe(target, { childList: true, subtree: true });
    }

    // ── CSS ──
    function peiInjectStyles() {
        if (document.getElementById('pei-styles')) return;
        const s = document.createElement('style'); s.id = 'pei-styles';
        s.textContent = `.pei-resize-handle{touch-action:none;background:transparent;}.pei-resize-handle:hover{background:rgba(59,130,246,0.4)!important;}@media(pointer:coarse){.pei-resize-handle{height:12px!important;opacity:.5!important}}.asg-block[data-pei-bunk]{touch-action:none;overflow:visible!important;transition:box-shadow 0.2s}.asg-block[data-pei-bunk]:active{cursor:grabbing!important}.pei-conflict-overlay{pointer-events:none;animation:pei-pulse 1s ease-in-out infinite}@keyframes pei-pulse{0%,100%{opacity:.3}50%{opacity:.6}}@keyframes pei-slide-up{from{transform:translate(-50%,20px);opacity:0}to{transform:translate(-50%,0);opacity:1}}@keyframes pei-fade-in{from{opacity:0}to{opacity:1}}.asg-free{cursor:default;position:relative;transition:border-color 0.2s}.asg-free:hover{border-color:#93c5fd!important;background:repeating-linear-gradient(45deg,#eff6ff,#eff6ff 4px,#dbeafe 4px,#dbeafe 8px)!important}.pei-add-btn{font-family:-apple-system,BlinkMacSystemFont,sans-serif;user-select:none;line-height:1;}.pei-add-btn:hover{transform:translate(-50%,-50%) scale(1.15)!important;box-shadow:0 2px 8px rgba(37,99,235,0.3);}[data-pei-bunk]:hover{background:rgba(59,130,246,.01)}`;
        document.head.appendChild(s);
    }

    // ── Master init ──
    function initPostEditInteractions() {
        if (_peiSetupDone) return;
        _peiSetupDone = true;
        peiInjectStyles();
        peiInstallClickSuppressor();
        peiAugmentGrid();
        peiSetupObserver();
        peiSetupTouch();

        // Ctrl+Z / Cmd+Z undo handler
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                // Only handle if no modal/input is focused
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
                if (document.getElementById('pei-add-overlay') || document.getElementById(OVERLAY_ID)) return;
                e.preventDefault();
                peiUndo();
            }
        });

        debugLog('v3.3 Post-Edit Interactions initialized (resize / move / add / undo / conflict engine)');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initPostEditSystem() {
        const missing = [];
        if (typeof window.smartRegenerateConflicts !== 'function') missing.push('smartRegenerateConflicts');
        if (typeof window.resolveConflictsAndApply !== 'function') missing.push('resolveConflictsAndApply');
        if (typeof window.applyPickToBunk !== 'function') missing.push('applyPickToBunk');
        if (missing.length > 0) console.warn('⚠️ [PostEdit] Missing dependencies (will use fallbacks):', missing.join(', '));
        
        if (!document.getElementById('post-edit-styles')) {
            const style = document.createElement('style');
            style.id = 'post-edit-styles';
            style.textContent = `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`;
            document.head.appendChild(style);
        }
        
        initPostEditInteractions();

        console.log('📝 Post-Edit System v3.3 initialized');
        console.log('   ★★★ v3.3: Resize / Move / Add / Real-time conflict detection ★★★');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.initPostEditSystem = initPostEditSystem;
    if (!window.UnifiedScheduleSystem) {
        window.enhancedEditCell = enhancedEditCell;
        window.checkLocationConflict = checkLocationConflict;
        window.getAllLocations = getAllLocations;
        window.getEditableBunks = getEditableBunks;
        window.canEditBunk = canEditBunk;
        window.sendSchedulerNotification = sendSchedulerNotification;
        window.bypassSaveAllBunks = bypassSaveAllBunks;
    } else {
        console.log('[PostEdit] unified_schedule_system.js already loaded — skipping overrides');
    }

    window.PostEditInteractions = {
        augmentRenderedGrid: peiAugmentGrid,
        ConflictEngine: PEI_ConflictEngine,
        autoFillActivity: peiAutoFill,
        init: initPostEditInteractions,
        undo: peiUndo,
        deleteBlock: peiDeleteBlock,
        undoStack: _peiUndoStack
    };

    // =========================================================================
    // PATCH: loadScheduleForDate respect _postEditInProgress
    // =========================================================================

    let _patchRetryCount = 0;
    function patchLoadScheduleForDate() {
        if (window._loadScheduleForDatePatched) return;
        const original = window.loadScheduleForDate;
        if (!original) {
            _patchRetryCount++;
            if (_patchRetryCount <= 10) setTimeout(patchLoadScheduleForDate, 500);
            return;
        }
        window.loadScheduleForDate = function(dateKey) {
            if (window._postEditInProgress) { console.log('[PostEdit] 🛡️ Skipping loadScheduleForDate - post-edit in progress'); return; }
            return original.call(this, dateKey);
        };
        window._loadScheduleForDatePatched = true;
        console.log('[PostEdit] ✅ Patched loadScheduleForDate');
    }

    patchLoadScheduleForDate();
    setTimeout(patchLoadScheduleForDate, 100);
    setTimeout(patchLoadScheduleForDate, 500);
    setTimeout(patchLoadScheduleForDate, 1500);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostEditSystem);
    } else {
        setTimeout(initPostEditSystem, 100);
    }

})();
