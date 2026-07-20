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

    // ★★★ CB-7: this file had NO HTML escaper, interpolating user-controlled
    // bunk / activity / field / location names raw into innerHTML across the
    // edit modal, conflict panel, drag tooltip and availability banner — a
    // broad stored/attribute XSS (a bunk or field named with an <img onerror>
    // executes in the editor's session). Delegate to the shared CampUtils
    // escaper (complete &<>"' set) with a local fallback so it works even if
    // campistry_utils.js hasn't loaded yet.
    const escHtml = (s) => (window.CampUtils && window.CampUtils.escapeHtml)
        ? window.CampUtils.escapeHtml(s)
        : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const DEBUG = false;
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";

    // REMOVED: ROTATION_CONFIG (Moved to unified_schedule_system.js)

    // =========================================================================
    // v3.3 — POST-EDIT INTERACTIONS CONFIG
    // =========================================================================
    const PEI_PX_PER_MIN = 2.5;
    const PEI_SNAP_MINS = 5;
    const PEI_MIN_BLOCK_DURATION = 5;
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

    // Undo stack — Slice 4 audit promoted this from { bunk, snapshot } to a
    // transaction shape so multi-bunk edits and displacements can also be
    // undone atomically. Each entry is now:
    //   { bunks: [{ bunk, snapshot }, ...],
    //     counts: [{ bunk, newAct, oldActs, slots }, ...],   // for inverse applyPostEditCounts
    //     description, timestamp, dateKey }
    //
    // Persisted to sessionStorage so page reload doesn't lose history.
    const _peiUndoStack = [];
    const PEI_MAX_UNDO = 30;
    const PEI_UNDO_STORAGE_KEY = '_peiUndoStack_v2';

    function _peiSaveUndoStack() {
        try {
            const dateKey = window.currentScheduleDate || '';
            const payload = { dateKey: dateKey, stack: _peiUndoStack };
            sessionStorage.setItem(PEI_UNDO_STORAGE_KEY, JSON.stringify(payload));
        } catch (_) { /* sessionStorage may be unavailable / over quota */ }
    }
    function _peiRestoreUndoStack() {
        try {
            const raw = sessionStorage.getItem(PEI_UNDO_STORAGE_KEY);
            if (!raw) return;
            const payload = JSON.parse(raw);
            // Only restore if the saved stack belongs to the date the user
            // is viewing — otherwise an undo would clobber a different day.
            const dateKey = window.currentScheduleDate || '';
            if (payload.dateKey !== dateKey) return;
            if (Array.isArray(payload.stack)) {
                _peiUndoStack.length = 0;
                payload.stack.forEach(function (e) { _peiUndoStack.push(e); });
            }
        } catch (_) {}
    }
    // Restore on next tick so currentScheduleDate is populated.
    setTimeout(_peiRestoreUndoStack, 0);

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
        
        (window.getGlobalSpecialActivities?.() || app1.specialActivities || []).forEach(s => {
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
        // ★ Direct-fill label resolution (Swim etc.) — shared helpers live in
        //   unified_schedule_system.js: NO facility assigned anywhere →
        //   unlimited; facility assigned off the exact name (Swim general
        //   activity / pool-named field / legacy poolLaneCapacity) → that
        //   facility's limits govern the label.
        const _lblShare = window.resolveLabelSharing?.(locationName, activityProperties);
        if (_lblShare === 'unlimited') maxCapacity = Infinity;
        else if (_lblShare && _lblShare.sharableWith && window.labelSharingCapacity) {
            maxCapacity = window.labelSharingCapacity(_lblShare.sharableWith, maxCapacity);
        }
        
        // ★ MS-4b: conflict classification uses GENERATION scope — see
        // unified_schedule_system.checkLocationConflict for the rationale
        let _conflictOwnScope = null;
        try {
            const _gd = window.AccessControl?.getGeneratableDivisions?.();
            const _allDivCount = Object.keys(window.divisions || {}).length;
            if (Array.isArray(_gd) && _gd.length > 0 && _allDivCount > 0 && _gd.length < _allDivCount) {
                _conflictOwnScope = new Set();
                _gd.forEach(dn => (((window.divisions || {})[dn] || {}).bunks || []).forEach(b => _conflictOwnScope.add(String(b))));
            }
        } catch (_eScope) { /* fall back */ }
        const editableBunks = _conflictOwnScope || getEditableBunks();
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

    function applyDirectEdit(bunk, slots, activity, location, isClear, opts = {}) {
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk?.(bunk) ||
                        window.getDivisionForBunk?.(bunk);
        const divTimes = window.divisionTimes?.[divName] || [];

        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(divTimes.length || 50);
        }

        const fieldValue = location ? `${location} – ${activity}` : activity;

        // Per-cell display-name ALIAS / CUSTOM TEXT: shown on the schedule (and
        // print / live view) instead of the real activity name. Custom-text
        // blocks (free text, no real activity behind them) always keep their
        // text; an alias is kept only when it differs from the activity.
        const _dn = (!isClear && opts.customText)
            ? String(opts.displayName || activity || '').trim() || null
            : ((!isClear && opts.displayName && String(opts.displayName).trim()
                && String(opts.displayName).trim().toLowerCase() !== String(activity).trim().toLowerCase())
                ? String(opts.displayName).trim() : null);

        // Manual edits always use deduct mode for travel-time (user sets the times)
        const _travelInfo = (!isClear && location)
            ? (window.getTravelForField?.(location, true) || window.getTravelForSpecialActivity?.(location, true) || null)
            : null;

        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = {
                field: isClear ? 'Free' : fieldValue,
                sport: isClear ? null : activity,
                continuation: i > 0,
                _fixed: !isClear,
                _activity: isClear ? 'Free' : activity,
                _displayName: _dn,
                _customText: !isClear && !!opts.customText,
                _appendText: (!isClear && opts.appendText && String(opts.appendText).trim()) ? String(opts.appendText).trim() : null,
                _location: location,
                _postEdit: true,
                _editedAt: Date.now(),
                _travelPre:  _travelInfo ? _travelInfo.preMin  : 0,
                _travelPost: _travelInfo ? _travelInfo.postMin : 0,
                _travelZone: _travelInfo ? _travelInfo.zoneName : null,
                _travelMode: _travelInfo ? 'deduct' : null
            };
            debugLog(`Set bunk ${bunk} slot ${idx}:`, window.scheduleAssignments[bunk][idx]);
        });

        // Seam-merge: if adjacent slot is same off-campus zone, drop the boundary travel
        if (_travelInfo && window.scheduleAssignments[bunk]) {
            const arr = window.scheduleAssignments[bunk];
            slots.forEach(idx => {
                const prev = arr[idx - 1], cur = arr[idx], next = arr[idx + 1];
                if (cur && prev && prev._travelZone && prev._travelZone === cur._travelZone) {
                    prev._travelPost = 0;
                    cur._travelPre = 0;
                }
                if (cur && next && next._travelZone && next._travelZone === cur._travelZone) {
                    cur._travelPost = 0;
                    next._travelPre = 0;
                }
            });
        }
        
        if (location && !isClear && window.registerLocationUsage) {
            const divName2 = window.SchedulerCoreUtils?.getDivisionForBunk?.(bunk) ||
                           window.getDivisionForBunk?.(bunk);
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName2);
            });
        }
    }

    // =========================================================================
    // APPEND TEXT ("keep the name, add more to it")
    // =========================================================================
    // In-place decorate of the existing entry — nothing else about it changes
    // (activity, field, rotation, pins). Delegates to the unified system's
    // implementation when it's loaded; otherwise does the same thing locally.
    function peiApplyAppendText(bunk, startMin, endMin, text) {
        if (typeof window.applyAppendTextEdit === 'function') {
            return window.applyAppendTextEdit(bunk, startMin, endMin, text);
        }
        const unifiedTimes = window.unifiedTimes || [];
        const slots = window.SchedulerCoreUtils?.findSlotsForRange?.(startMin, endMin, unifiedTimes) || [];
        const row = window.scheduleAssignments?.[bunk];
        if (!slots.length || !row) { alert('Error: Could not find this block to update.'); return false; }
        const clean = String(text || '').trim();

        function baseLabel(entry) {
            if (entry._displayName && entry._appendText) {
                const suf = ' — ' + entry._appendText;
                if (String(entry._displayName).endsWith(suf)) {
                    const b = String(entry._displayName).slice(0, -suf.length);
                    return entry._appendOnly ? (b || '') : b;
                }
            }
            if (entry._displayName) return entry._displayName;
            return window.SchedulerCoreUtils?.formatEntry?.(entry) || entry._activity || entry.field || '';
        }

        if (typeof window.markPostEditInProgress === 'function') window.markPostEditInProgress();
        let touched = 0;
        slots.forEach(idx => {
            const entry = row[idx];
            if (!entry || entry.continuation) return;
            const base = baseLabel(entry);
            const hadRealAlias = !!entry._displayName && !entry._appendOnly;
            if (clean) {
                entry._appendText = clean;
                entry._displayName = base ? base + ' — ' + clean : clean;
                entry._appendOnly = !hadRealAlias;
            } else {
                if (entry._appendOnly) entry._displayName = null;
                else if (entry._appendText) entry._displayName = base || null;
                entry._appendText = null;
                delete entry._appendOnly;
            }
            entry._postEdit = true;
            entry._editedAt = Date.now();
            touched++;
        });
        if (!touched) { alert('Nothing to add text to in this slot.'); return false; }
        window.saveSchedule?.();
        if (typeof window.updateTable === 'function') window.updateTable();
        return true;
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
            // ★ CB-52: dropped the write-only `scheduleAssignments_${dateKey}` mirror — it was
            // never read anywhere (the recovery path reads campDailyData_v1[dateKey] below), so it
            // only burned localStorage quota and hastened QuotaExceededError on the canonical write.
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
        const dateKey = window.currentScheduleDate || window.currentDate || new Date().toISOString().split('T')[0];
        if (!campId) return;

        try {
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            for (const bunk of affectedBunks) {
                for (const [divName, divData] of Object.entries(divisions)) {
                    if (divData.bunks?.includes(bunk)) affectedDivisions.add(divName);
                }
            }

            // ★ camp_users stores division scope in assigned_divisions
            // (selecting the nonexistent `divisions` column errored the whole
            // query, so notifications were NEVER sent)
            const { data: schedulers } = await supabase
                .from('camp_users').select('user_id, assigned_divisions')
                .eq('camp_id', campId).neq('user_id', userId);

            const notifyUsers = [];
            for (const scheduler of (schedulers || [])) {
                if (!scheduler.user_id) continue;
                const theirDivisions = scheduler.assigned_divisions || [];
                if (theirDivisions.some(d => affectedDivisions.has(d))) notifyUsers.push(scheduler.user_id);
            }
            // ★ the camp OWNER schedules every division but is not a
            // camp_users row — include them (camp_id is the owner's uid)
            if (campId && campId !== userId && !notifyUsers.includes(campId)) notifyUsers.push(campId);
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
    // ACCESS-RESTRICTION CHECK (soft — WARN, never hard-block a post-edit)
    // =========================================================================
    // Mirrors the generator's two access gates so a post-edit warning matches
    // what the solver would have refused:
    //   • specials → isSpecialAvailableForBunk (scheduler_core_auto.js)
    //   • fields   → accessRestrictions (canBlockFit, scheduler_core_utils.js)
    // Returns { allowed, label } where label is the restricted name to name in
    // the warning. Fails OPEN (allowed) on any error — this must never block.
    function peiIsActivityAllowedForBunk(activity, location, bunk) {
        const div = peiGetDivForBunk(bunk);
        if (!div) return { allowed: true };
        const gs = window.globalSettings || null;

        // The restriction lives on the chosen field/special; a special can also be
        // typed straight into the activity box with no location. Check both names.
        const names = [];
        if (location) names.push(location);
        if (activity && String(activity).toLowerCase() !== String(location || '').toLowerCase()) names.push(activity);

        const specials = window.getGlobalSpecialActivities?.() ||
            (window.loadGlobalSettings?.() || {}).app1?.specialActivities || [];
        const props = window.SchedulerCoreUtils?.getActivityProperties?.() || window.activityProperties || {};

        for (const name of names) {
            const lname = String(name).toLowerCase();
            const isSpecial = specials.some(s => s && String(s.name).toLowerCase() === lname);
            if (isSpecial) {
                if (typeof window.isSpecialAvailableForBunk === 'function') {
                    try {
                        if (!window.isSpecialAvailableForBunk(name, div, bunk, gs)) return { allowed: false, label: name };
                    } catch (_) { /* fail open */ }
                }
                continue;
            }
            // Field accessRestrictions (replicates canBlockFit's division/bunk gate).
            const ar = props[name]?.accessRestrictions;
            if (ar?.enabled) {
                const divRules = ar.divisions || {};
                if (Object.keys(divRules).length > 0) {
                    const divStr = String(div);
                    if (!(divStr in divRules) && !(div in divRules)) return { allowed: false, label: name };
                    const divRule = divRules[divStr] || divRules[div];
                    if (Array.isArray(divRule) && divRule.length > 0) {
                        const bStr = String(bunk), bNum = parseInt(bunk, 10);
                        if (!divRule.some(b => String(b) === bStr || parseInt(b, 10) === bNum)) return { allowed: false, label: name };
                    }
                }
            }
        }
        return { allowed: true };
    }

    // =========================================================================
    // APPLY EDIT (Main entry point)
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice, displayName, customText, appendText } = editData;
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

        // ── Period boundary check — block placements that span period gaps ──
        if (!isClear) {
            const _peDivName = peiGetDivForBunk(bunk);
            const _pePeriods = _peDivName && window.campPeriods && window.campPeriods[_peDivName];
            if (_pePeriods && _pePeriods.length > 0) {
                const _peInPeriod = _pePeriods.some(p => p.startMin <= startMin && p.endMin >= endMin);
                if (!_peInPeriod) {
                    const _pePNames = _pePeriods.filter(p => p.endMin > startMin && p.startMin < endMin).map(p => p.name || '').filter(Boolean);
                    const _peMsg = 'This placement spans a period boundary' + (_pePNames.length > 1 ? ' (' + _pePNames.join(' → ') + ')' : '') + '.\n\nActivities must fit entirely within one bell-schedule period.\n\nPlace anyway?';
                    if (!window.confirm(_peMsg)) return;
                }
            }
        }

        console.log(`[PostEdit] Applying edit for ${bunk}:`, { activity, location, startMin, endMin, slots, hasConflict, resolutionChoice, isClear });

        // ★ Manual-mode cooldown check — soft confirm if the edit would violate a rule
        //   (skipped for custom text: free text is a label, not a real activity)
        if (!isClear && !customText && window.SchedulingRules && !editData._cooldownChecked) {
            try {
                const tmpl = window.SchedulingRules.buildTemplateFromBunkSlots(bunk, slots);
                const candidate = {
                    startMin: startMin, endMin: endMin,
                    type: window.SchedulingRules.inferTypeFromActivity(activity),
                    event: activity, field: location || null
                };
                const result = window.SchedulingRules.checkCandidateDetailed(candidate, tmpl, { mode: 'manual' });
                if (!result.allowed) {
                    const msg = result.violated.map(r => '• ' + window.SchedulingRules.describeRule(r)).join('\n');
                    const proceed = window.confirm('This placement violates the following cooldown rule(s):\n\n' + msg + '\n\nPlace anyway?');
                    if (!proceed) return;
                    editData._cooldownChecked = true;
                }
            } catch (e) { console.warn('[PostEdit] cooldown check failed:', e); }
        }

        // ★ Access-restriction soft warning — if the chosen activity/field/special
        //   is not allowed for this bunk/grade, WARN but let the user place it
        //   anyway. Post-edits are intentional overrides; we never hard-block them.
        if (!isClear && !customText && !editData._accessChecked) {
            try {
                const acc = peiIsActivityAllowedForBunk(activity, location, bunk);
                if (!acc.allowed) {
                    const _div = peiGetDivForBunk(bunk) || 'this division';
                    const proceed = window.confirm(
                        '"' + acc.label + '" is not normally allowed for ' + bunk + ' (' + _div + ') — it has an access restriction.\n\n' +
                        'This is a manual override, so you can still place it here.\n\nPlace anyway?'
                    );
                    if (!proceed) return;
                    editData._accessChecked = true;
                }
            } catch (e) { console.warn('[PostEdit] access check failed:', e); }
        }

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
            applyDirectEdit(bunk, slots, activity, location, isClear, { displayName, customText, appendText });
        }
        
        console.log(`[PostEdit] ✅ After edit, bunk ${bunk} slot ${slots[0]}:`, window.scheduleAssignments[bunk][slots[0]]);
        
        const currentDate = window.currentScheduleDate || 
                           window.currentDate || 
                           document.getElementById('datePicker')?.value ||
                           new Date().toISOString().split('T')[0];
        
        // ★ CB-52: removed the two write-only mirrors `scheduleAssignments_${currentDate}` and
        // `campDailyData_v1_${currentDate}` — neither is read anywhere in the repo; they only burned
        // localStorage quota and brought the canonical campDailyData_v1 write (below) closer to
        // QuotaExceededError. The canonical map keyed by currentDate is the real read/recovery path.
        try {
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].unifiedTimes = window.unifiedTimes || [];
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) { console.error('[PostEdit] Failed to save to unified storage (nested):', e); }
        
        // Slice 4 audit R-1 — use the cancelable marker helper. The legacy
        // uncancelable setTimeout raced with the new pattern: a second edit
        // within 8s would fire the first edit's stale timer and clear the
        // flag mid-second-edit, exposing the in-flight window to remote sync.
        if (typeof window.markPostEditInProgress === 'function') {
            window.markPostEditInProgress(8000);
        } else {
            window._postEditInProgress = true;
            window._postEditTimestamp = Date.now();
        }

        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunk, slots, activity, location, date: currentDate }
        }));
        
        window.saveSchedule?.();

        // Post-edit counts + rotation history (single shared implementation)
        // Custom text is a label, not a real activity — credit nothing for it
        // (old activities are still debited since the slot was overwritten).
        if (window.SchedulerCoreUtils?.applyPostEditCounts) {
            window.SchedulerCoreUtils.applyPostEditCounts(bunk, _oldActivities, (!isClear && activity && !customText) ? activity : null, slots);
        }
        
        // Render
        console.log('[PostEdit] 🔄 Calling updateTable() immediately');
        if (typeof window.updateTable === 'function') window.updateTable();
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
        // width:min(...,94vw) — roomy on desktop so the report sections aren't
        // bunched together, still shrinks cleanly on small screens.
        modal.style.cssText = 'background:white;border-radius:12px;padding:26px 28px;width:min(760px,94vw);box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-height:92vh;overflow-y:auto;';
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        let _mdModalOverlay = false;
        overlay.addEventListener('mousedown', (e) => { _mdModalOverlay = (e.target === overlay); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay && _mdModalOverlay) closeModal(); });
        const escHandler = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);
        
        return modal;
    }

    function closeModal() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    // =========================================================================
    // BUNK MINI REPORT — inline "what has this bunk done" panel for post-edit
    // Surfaces rotation history + today's schedule + open fields so the user
    // doesn't have to leave the edit modal and open the reports page.
    //   • Access-filtered: only activities this bunk is actually allowed to do.
    //   • Shows each activity's configured max usage / limit.
    //   • Live: highlights the activity you're typing/picking and flags repeats
    //     or limit breaches (re-rendered via renderBunkReportBody on input).
    // =========================================================================

    // Configured max-usage per activity (specials carry maxUsage/maxUsagePeriod;
    // sports have no rotation cap → unlimited). Returns { max, period } | null.
    function _reportActivityLimit(activityName, specialsCfg) {
        const key = (activityName || '').toLowerCase().trim();
        for (const s of specialsCfg) {
            if (!s || !s.name || s.name.toLowerCase().trim() !== key) continue;
            const mx = parseInt(s.maxUsage, 10);
            if (mx > 0) return { max: mx, period: s.maxUsagePeriod || null };
        }
        return null;
    }

    // Whether this bunk is allowed to do the activity (honors accessRestrictions).
    // Specials use the exposed duplicate-safe check; sports are allowed if any
    // hosting field is open to the bunk's division. Fails OPEN so a lookup bug
    // never wrongly hides a legitimate option.
    function _reportBunkCanAccess(activityName, bunk, divName, gs) {
        try {
            const RE = window.RotationEngine;
            if (RE && RE.isSpecialActivity && RE.isSpecialActivity(activityName)) {
                if (typeof window.isSpecialAvailableForBunk === 'function') {
                    return window.isSpecialAvailableForBunk(activityName, divName, bunk, gs);
                }
                return true;
            }
            const key = (activityName || '').toLowerCase().trim();
            const fields = ((gs && gs.app1) || {}).fields || [];
            const hosts = fields.filter(f => (f.activities || [])
                .some(a => String(a).toLowerCase().trim() === key));
            if (!hosts.length) return true; // unknown mapping — don't hide
            for (const f of hosts) {
                const ar = f.accessRestrictions;
                if (!ar || !ar.enabled) return true;            // an open field hosts it
                const divs = ar.divisions || {};
                if (!Object.keys(divs).length) return true;     // toggled on, no grades = misconfig → open
                const dk = (String(divName) in divs) ? String(divName)
                    : ((divName in divs) ? divName : null);
                if (dk === null) continue;                       // this field blocks the division
                const bunkList = divs[dk];
                if (!Array.isArray(bunkList) || bunkList.length === 0) return true; // all bunks in div
                const bunkStr = String(bunk), bunkNum = parseInt(bunk, 10);
                if (bunkList.some(b => String(b) === bunkStr || parseInt(b, 10) === bunkNum)) return true;
            }
            return false;
        } catch (e) {
            return true; // fail open
        }
    }

    // Normalize a checkLocationConflict result into a report availability entry.
    // Status is derived from usage vs capacity (NOT hasConflict) so a sharable
    // field with room left reads as 'partial', not falsely 'free'. `users` holds
    // the occupying bunk/activity when the field is full (conflicts populated).
    function _reportAvailEntry(check) {
        const usage = Math.max(0, check.currentUsage || 0);
        const max = Math.max(1, check.maxCapacity || 1);
        const status = usage <= 0 ? 'free' : (usage < max ? 'partial' : 'busy');
        const seen = new Set();
        const users = [];
        (check.conflicts || []).forEach(c => {
            const key = (c.bunk || '') + '|' + (c.activity || '');
            if (seen.has(key)) return;
            seen.add(key);
            users.push({ bunk: c.bunk, activity: c.activity });
        });
        return { status, usage, max, users };
    }

    // Expose so the unified editor can normalize with identical semantics.
    window.PostEditReportAvail = _reportAvailEntry;

    // ── Cloud rotation counts ──────────────────────────────────────────────
    // The authoritative per-bunk/activity usage lives in the cloud
    // (rotation_counts, synced from camp state), NOT local historicalCounts
    // which can be stale after another scheduler generates. RotationCloud.load()
    // is async (30s-cached), so the report renders immediately with the local
    // count, then re-renders once the cloud snapshot resolves.
    let _reportCloudCache = null;
    function _ciGet(obj, key) {
        if (!obj) return undefined;
        if (obj[key] != null) return obj[key];
        const lk = String(key).toLowerCase().trim();
        for (const k in obj) if (k.toLowerCase().trim() === lk) return obj[k];
        return undefined;
    }
    function _cloudDaysSince(lastDateStr) {
        if (!lastDateStr) return null;
        const today = window.currentScheduleDate ||
            (typeof window.currentDate === 'string' ? window.currentDate : null);
        if (!today) return null;
        const a = new Date(today + 'T12:00:00'), b = new Date(lastDateStr + 'T12:00:00');
        if (isNaN(a) || isNaN(b)) return null;
        return Math.max(0, Math.round((a - b) / 86400000));
    }
    // Fire the async cloud load after the panel mounts; re-render the body with
    // the proper counts once it resolves. Self-contained so no caller wiring.
    function _reportScheduleCloudHydrate(bunk, divName, ctx, startMin, endMin) {
        try {
            if (!window.RotationCloud || typeof window.RotationCloud.load !== 'function') return;
            setTimeout(() => {
                if (!document.getElementById('post-edit-report-body')) return;
                Promise.resolve(window.RotationCloud.load()).then(data => {
                    if (!data || !data.counts) return;
                    _reportCloudCache = data;
                    try { window.RotationEngine?.mergeCloudData?.(data); } catch (_) { }
                    const el = document.getElementById('post-edit-report-body');
                    if (!el) return;
                    const sel = document.getElementById('post-edit-activity')?.value || '';
                    el.innerHTML = renderBunkReportBody(bunk, divName, ctx.locations, ctx.locationAvailMap, sel, startMin, endMin);
                }).catch(() => { });
            }, 0);
        } catch (_) { /* offline / no cloud — keep local counts */ }
    }

    // Build the location + availability context the report needs for the
    // "Open fields at this time" section. Self-contained so the report can be
    // rendered from any modal (including the unified_schedule_system editor)
    // without the caller precomputing anything.
    function _reportBuildContext(bunk, startMin, endMin) {
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        const slots = window.SchedulerCoreUtils?.findSlotsForRange?.(startMin, endMin, unifiedTimes) || [];
        const locationAvailMap = {};
        for (const loc of locations) {
            try {
                locationAvailMap[loc.name] = _reportAvailEntry(checkLocationConflict(loc.name, slots, bunk));
            } catch (_) {
                locationAvailMap[loc.name] = { status: 'free', usage: 0, max: 1, users: [] };
            }
        }
        return _reportAugmentFields(bunk, startMin, endMin, locations, locationAvailMap);
    }

    // checkLocationConflict only sees normal entry.field usage. League games live
    // in window.leagueAssignments matchup strings and pinned/custom tiles reserve
    // their real facility via entry._reservedFields — both invisible to it. Fold
    // those in (from the unified helpers) so the report's field sections include
    // league venues + custom pinned fields and mark them busy. Works on copies so
    // the caller's dropdown data is untouched. Returns { locations, locationAvailMap }.
    function _titleCaseField(s) {
        return String(s || '').replace(/\b\w/g, c => c.toUpperCase());
    }
    function _reportAugmentFields(bunk, startMin, endMin, locations, locationAvailMap) {
        const outLocs = (locations || []).slice();
        const outMap = Object.assign({}, locationAvailMap || {});
        try {
            const lg = (typeof window.getLeagueFieldsInTimeRange === 'function')
                ? window.getLeagueFieldsInTimeRange(startMin, endMin) : null;
            const pn = (typeof window.getPinnedReservedFieldsInTimeRange === 'function')
                ? window.getPinnedReservedFieldsInTimeRange(startMin, endMin, bunk) : null;
            const known = new Map(outLocs.map(l => [String(l.name).toLowerCase().trim(), l]));
            const mark = (set, label) => {
                if (!set || typeof set.forEach !== 'function') return;
                set.forEach(nl => {
                    const key = String(nl).toLowerCase().trim();
                    if (!key) return;
                    let loc = known.get(key);
                    if (!loc) {
                        loc = { name: _titleCaseField(key), type: 'field', capacity: 1, activities: [] };
                        known.set(key, loc);
                        outLocs.push(loc);
                    }
                    const prev = outMap[loc.name] || { status: 'free', usage: 0, max: 1, users: [] };
                    const users = (prev.users && prev.users.length) ? prev.users : [{ activity: label, bunk: '' }];
                    outMap[loc.name] = { status: 'busy', usage: Math.max(1, prev.usage || 0), max: prev.max || 1, users };
                });
            };
            mark(lg, 'League game');
            mark(pn, 'Reserved (pinned)');
        } catch (e) { debugLog('reportAugmentFields error', e); }
        return { locations: outLocs, locationAvailMap: outMap };
    }
    // Expose so the unified editor's context builder folds in the same fields.
    window.PostEditReportAugment = _reportAugmentFields;

    // Re-renderable inner body of the report. `selectedActivity` is the value
    // currently in the modal's activity field, used for live highlighting/flags.
    function renderBunkReportBody(bunk, divName, locations, locationAvailMap, selectedActivity, startMin, endMin) {
        try {
            const RE = window.RotationEngine;
            const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            const app1 = gs.app1 || {};
            const specialsCfg = (window.getGlobalSpecialActivities && window.getGlobalSpecialActivities())
                || app1.specialActivities || [];
            const selKey = (selectedActivity || '').toLowerCase().trim();
            // Prefer the authoritative cloud snapshot when it has loaded.
            const cloudCounts = _reportCloudCache && _reportCloudCache.counts
                ? (_ciGet(_reportCloudCache.counts, bunk) || {}) : null;
            const cloudLast = _reportCloudCache && _reportCloudCache.lastDone
                ? (_ciGet(_reportCloudCache.lastDone, bunk) || {}) : null;
            const _skip = (name) => {
                const low = (name || '').toLowerCase().trim();
                return !low || low === 'free' || low === 'free play'
                    || low.indexOf('transition') !== -1 || low.indexOf('lunch') !== -1
                    || low.indexOf('buffer') !== -1 || low.indexOf('regroup') !== -1;
            };

            // --- 1) What this bunk already has scheduled TODAY ---
            const todayActs = [];
            const todayLower = new Set();
            (peiBunkActivities(bunk, divName) || []).forEach(a => {
                const name = a.entry && a.entry._activity;
                if (_skip(name)) return;
                todayActs.push({ name, startMin: a.startMin });
                todayLower.add(name.toLowerCase().trim());
            });
            todayActs.sort((a, b) => a.startMin - b.startMin);

            // --- 2) Rotation totals: what they've done, how many times, vs limit ---
            //        (access-filtered to only what this bunk may do) ---
            const masterActs = (RE && RE.getAllActivityNames) ? RE.getAllActivityNames() : [];
            const masterSet = new Set(masterActs.map(a => (a || '').toLowerCase().trim()));
            const allActs = masterActs.filter(act => _reportBunkCanAccess(act, bunk, divName, gs));
            const accessibleSet = new Set(allActs.map(a => (a || '').toLowerCase().trim()));
            const done = [];
            const never = [];
            allActs.forEach(act => {
                const key = (act || '').toLowerCase().trim();
                // Count: cloud snapshot is authoritative; fall back to local.
                let count;
                if (cloudCounts) count = _ciGet(cloudCounts, act) || 0;
                else count = (RE && RE.getActivityCount) ? (RE.getActivityCount(bunk, act) || 0) : 0;
                // Recency: derive from cloud lastDone when available.
                let daysSince;
                if (cloudLast) daysSince = _cloudDaysSince(_ciGet(cloudLast, act));
                else daysSince = (RE && RE.getDaysSinceActivity) ? RE.getDaysSinceActivity(bunk, act) : null;
                const isToday = todayLower.has(key);
                const limit = _reportActivityLimit(act, specialsCfg);
                const rec = { act, count, daysSince, isToday, limit, sel: key === selKey };
                if (count > 0 || isToday) done.push(rec); else never.push(rec);
            });
            done.sort((a, b) => (b.count - a.count) || a.act.localeCompare(b.act));
            never.sort((a, b) => a.act.localeCompare(b.act));

            // --- 2b) Suggestions: what this bunk SHOULD get next ---
            // Primary source is the same rotation+availability scorer the auto
            // Quick-Pick uses (open now, fair by history). If nothing is open we
            // fall back to a pure history ranking (new first, then longest-ago).
            const doneByKey = {};
            done.forEach(d => { doneByKey[d.act.toLowerCase().trim()] = d; });
            const reasonFor = (key) => {
                const d = doneByKey[key];
                if (!d || d.count <= 0) return 'new for this bunk';
                if (d.daysSince && d.daysSince >= 1) return `not in ${d.daysSince}d`;
                return `only ${d.count}× so far`;
            };
            const suggestions = [];
            const sugSeen = new Set();
            const pushSug = (activity, field, open) => {
                const k = (activity || '').toLowerCase().trim();
                if (!k || sugSeen.has(k) || todayLower.has(k)) return;
                if (masterSet.has(k) && !accessibleSet.has(k)) return; // restricted
                const d = doneByKey[k];
                if (d && d.limit && d.count >= d.limit.max) return;    // at limit
                sugSeen.add(k);
                suggestions.push({ activity, field: field && field !== activity ? field : null, reason: reasonFor(k), open });
            };
            try {
                const cand = (typeof peiAutoFillCandidates === 'function')
                    ? peiAutoFillCandidates(bunk, divName, startMin, endMin) : [];
                for (const c of cand) { pushSug(c.activity, c.field, true); if (suggestions.length >= 3) break; }
            } catch (_) { /* scorer unavailable */ }
            if (suggestions.length < 3) {
                // History fallback: never-done first, then longest-since / least-played.
                const pool = [...never.map(n => ({ act: n.act, ds: Infinity, ct: 0 })),
                    ...done.map(d => ({ act: d.act, ds: (d.daysSince == null ? 0 : d.daysSince), ct: d.count }))]
                    .sort((a, b) => (b.ds - a.ds) || (a.ct - b.ct) || a.act.localeCompare(b.act));
                for (const p of pool) { pushSug(p.act, null, false); if (suggestions.length >= 3) break; }
            }

            // --- 3) Field status at THIS time slot (fields + facility-hosted
            //        general activities; specials are activities, not courts) ---
            const fieldLocs = (locations || []).filter(l => l.type === 'field' || l.type === 'general');
            const openF = [], busyF = [];
            fieldLocs.forEach(l => {
                const av = locationAvailMap[l.name] || { status: 'free', usage: 0, max: 1, users: [] };
                (av.status === 'busy' ? busyF : openF).push({ l, av });
            });
            // Open ones first (free before partial), then busy alphabetical.
            openF.sort((a, b) => (a.av.status === b.av.status ? a.l.name.localeCompare(b.l.name) : (a.av.status === 'free' ? -1 : 1)));
            busyF.sort((a, b) => a.l.name.localeCompare(b.l.name));

            const recencyLabel = (d) => {
                if (d === 0) return 'today';
                if (d === 1) return 'yesterday';
                if (d && d > 1) return d + 'd ago';
                return null;
            };
            const periodLabel = (p) => p === 'half' ? '/half' : p === 'week' ? '/wk' : p === 'month' ? '/mo' : '';

            // --- Summary stats ---
            const triedCount = done.filter(d => d.count > 0).length;
            const totalDone = done.reduce((s, d) => s + d.count, 0);
            const maxCount = Math.max(1, ...done.map(d => d.count));

            // --- Live note for the activity currently being entered ---
            const note = (bg, bd, fg, txt) => `<div style="display:flex;gap:7px;align-items:flex-start;background:${bg};border:1px solid ${bd};color:${fg};border-radius:8px;padding:8px 11px;font-size:0.78rem;line-height:1.35;margin-bottom:12px;"><span style="width:6px;height:6px;border-radius:50%;background:${fg};margin-top:6px;flex:0 0 auto;"></span><span>${txt}</span></div>`;
            let noteHtml = '';
            if (selKey) {
                const inDone = done.find(d => d.sel);
                const inNever = never.find(d => d.sel);
                const known = inDone || inNever;
                if (known) {
                    if (todayLower.has(selKey)) {
                        noteHtml = note('#fef2f2', '#fecaca', '#b91c1c', `<b>${escHtml(known.act)}</b> is already scheduled for this bunk today.`);
                    } else if (inDone && inDone.limit && inDone.count >= inDone.limit.max) {
                        noteHtml = note('#fef2f2', '#fecaca', '#b91c1c', `<b>${escHtml(known.act)}</b> is at its limit (${inDone.count}/${inDone.limit.max}${periodLabel(inDone.limit.period)}).`);
                    } else if (inNever) {
                        noteHtml = note('#f0fdf4', '#bbf7d0', '#15803d', `First time — this bunk hasn't done <b>${escHtml(known.act)}</b> yet.`);
                    } else {
                        const rec = recencyLabel(inDone.daysSince);
                        noteHtml = note('#eff6ff', '#bfdbfe', '#1d4ed8', `<b>${escHtml(inDone.act)}</b>: done ${inDone.count}×${inDone.limit ? ` (max ${inDone.limit.max}${periodLabel(inDone.limit.period)})` : ''}${rec ? `, last ${rec}` : ''}.`);
                    }
                } else if (masterSet.has(selKey) && !accessibleSet.has(selKey)) {
                    noteHtml = note('#fffbeb', '#fde68a', '#b45309', `<b>${escHtml(selectedActivity.trim())}</b> is restricted — this bunk isn't allowed to do it.`);
                }
            }

            // --- Reusable bits ---
            const chip = (label, bg, fg, extra) => `<span style="display:inline-flex;align-items:center;background:${bg};color:${fg};border-radius:20px;padding:3px 10px;font-size:0.72rem;font-weight:500;margin:0 4px 4px 0;">${label}${extra || ''}</span>`;
            const sectionTitle = (t, badge) => `<div style="display:flex;align-items:center;gap:6px;margin:14px 0 7px 0;"><span style="font-weight:700;color:#6b7280;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;">${t}</span>${badge != null ? `<span style="background:#eef2ff;color:#4338ca;font-size:0.65rem;font-weight:700;border-radius:10px;padding:1px 7px;">${badge}</span>` : ''}<span style="flex:1;height:1px;background:#f0f0f2;"></span></div>`;
            const empty = (t) => `<div style="color:#9ca3af;font-size:0.75rem;font-style:italic;">${t}</div>`;

            // --- Stat strip ---
            const statPill = (n, l, c) => `<div style="flex:1;text-align:center;background:#f9fafb;border:1px solid #eef0f2;border-radius:8px;padding:7px 4px;">
                <div style="font-size:1.05rem;font-weight:700;color:${c};line-height:1.1;">${n}</div>
                <div style="font-size:0.62rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;margin-top:1px;">${l}</div></div>`;
            const statHtml = `<div style="display:flex;gap:8px;margin-bottom:6px;">
                ${statPill(totalDone, 'Total done', '#4338ca')}
                ${statPill(triedCount, 'Activities', '#0f766e')}
                ${statPill(never.length, 'Not tried', '#b45309')}
            </div>`;

            // --- Suggestions (clickable → fills the activity field) ---
            const sugHtml = suggestions.length ? `
                <div style="background:#f5f6ff;border:1px solid #e0e3fb;border-radius:10px;padding:10px 12px;margin:12px 0 2px;">
                    <div style="font-weight:700;color:#4338ca;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:7px;">Suggested for this bunk</div>
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        ${suggestions.map(s => `<button type="button" class="pe-suggest-btn" data-activity="${escHtml(s.activity)}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;background:#fff;border:1px solid #d9ddf7;border-radius:8px;padding:7px 10px;cursor:pointer;font-family:inherit;">
                            <span style="display:flex;flex-direction:column;line-height:1.2;">
                                <span style="font-weight:600;color:#312e81;font-size:0.82rem;">${escHtml(s.activity)}${s.field ? `<span style="font-weight:400;color:#9ca3af;font-size:0.72rem;"> @ ${escHtml(s.field)}</span>` : ''}</span>
                                <span style="color:#6366f1;font-size:0.68rem;">${escHtml(s.reason)}${s.open ? ' · open now' : ''}</span>
                            </span>
                            <span style="color:#6366f1;font-size:0.9rem;font-weight:700;flex:0 0 auto;">+</span>
                        </button>`).join('')}
                    </div>
                </div>` : '';

            // --- Scheduled today ---
            const todayHtml = todayActs.length
                ? todayActs.map(a => chip(escHtml(a.name), '#dbeafe', '#1e40af')).join('')
                : empty('Nothing scheduled yet today');

            // --- Rotation balance (bar rows) ---
            const doneRows = done.length
                ? done.map(d => {
                    const rec = d.isToday ? 'today' : (recencyLabel(d.daysSince) || '');
                    const atLimit = d.limit && d.count >= d.limit.max;
                    const pct = Math.round((d.count / maxCount) * 100);
                    const barColor = atLimit ? '#ef4444' : (d.sel ? '#4f46e5' : '#818cf8');
                    const rowBg = d.sel ? 'background:#eef2ff;' : '';
                    const limitBadge = d.limit ? `<span style="color:${atLimit ? '#dc2626' : '#9ca3af'};font-weight:500;">/${d.limit.max}${periodLabel(d.limit.period)}</span>` : '';
                    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;${rowBg}">
                        <span style="flex:0 0 34%;color:#374151;font-size:0.76rem;${d.sel ? 'font-weight:700;' : 'font-weight:500;'}white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(d.act)}</span>
                        <span style="flex:1;height:7px;background:#eef0f5;border-radius:4px;overflow:hidden;"><span style="display:block;height:100%;width:${pct}%;background:${barColor};border-radius:4px;"></span></span>
                        <span style="flex:0 0 auto;font-size:0.74rem;color:${atLimit ? '#dc2626' : '#4b5563'};font-weight:700;white-space:nowrap;">${d.count}${limitBadge}</span>
                        <span style="flex:0 0 52px;text-align:right;font-size:0.68rem;color:#9ca3af;white-space:nowrap;">${rec}</span>
                    </div>`;
                }).join('')
                : empty('No prior activity history');

            // --- Not yet done ---
            const neverHtml = never.length
                ? never.map(d => {
                    const bg = d.sel ? '#c7d2fe' : '#fef3c7';
                    const fg = d.sel ? '#3730a3' : '#92400e';
                    const ex = d.limit ? `<span style="opacity:0.65;font-weight:400;margin-left:5px;">max ${d.limit.max}${periodLabel(d.limit.period)}</span>` : '';
                    return chip(escHtml(d.act), bg, fg, ex);
                }).join('')
                : empty('Every accessible activity has been done');

            // --- Open fields now ---
            const openHtml = openF.length
                ? openF.map(({ l, av }) => {
                    const partial = av.status === 'partial';
                    const ex = partial ? `<span style="opacity:0.7;font-weight:400;margin-left:5px;">${av.usage}/${av.max}</span>` : '';
                    return chip(escHtml(l.name), partial ? '#fef9c3' : '#dcfce7', partial ? '#854d0e' : '#166534', ex);
                }).join('')
                : empty('No open fields at this time');

            // --- In-use fields (with what's occupying them) ---
            const usedHtml = busyF.length
                ? busyF.map(({ l, av }) => {
                    const who = [...new Set((av.users || []).map(u => u.activity || u.bunk).filter(Boolean))];
                    const lbl = who.length ? `<span style="opacity:0.75;font-weight:400;margin-left:5px;">${escHtml(who.slice(0, 2).join(', '))}${who.length > 2 ? ` +${who.length - 2}` : ''}</span>` : '';
                    return chip(escHtml(l.name), '#fee2e2', '#991b1b', lbl);
                }).join('')
                : empty('No fields in use at this time');

            return `
                ${noteHtml}
                ${statHtml}
                ${sugHtml}
                ${sectionTitle('Scheduled today', todayActs.length || null)}
                <div>${todayHtml}</div>
                ${sectionTitle('Rotation balance', triedCount || null)}
                <div style="max-height:168px;overflow-y:auto;margin:0 -2px;">${doneRows}</div>
                ${sectionTitle('Not yet done', never.length || null)}
                <div>${neverHtml}</div>
                ${sectionTitle('Open fields now', openF.length || null)}
                <div>${openHtml}</div>
                ${sectionTitle('In use now', busyF.length || null)}
                <div>${usedHtml}</div>`;
        } catch (e) {
            debugLog('renderBunkReportBody error', e);
            return '';
        }
    }

    // Shared collapsible card wrapper for the report (identical markup wherever
    // the report is shown). `bodyHtml` is the pre-rendered inner body.
    function _reportCardHtml(bunk, bodyHtml) {
        return `
            <details id="post-edit-bunk-report" open style="background:#fff;border:1px solid #e8eaed;border-radius:12px;padding:0;margin-bottom:16px;box-shadow:0 1px 3px rgba(16,24,40,0.05);overflow:hidden;">
                <summary style="list-style:none;cursor:pointer;outline:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:linear-gradient(180deg,#fafbff,#f4f6fb);border-bottom:1px solid #eef0f4;">
                    <span style="display:flex;align-items:center;gap:8px;">
                        <span style="width:26px;height:26px;border-radius:7px;background:#eef2ff;color:#4338ca;display:inline-flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:800;">${escHtml((bunk || '?').trim().charAt(0).toUpperCase())}</span>
                        <span style="display:flex;flex-direction:column;line-height:1.15;">
                            <span style="font-weight:700;color:#111827;font-size:0.9rem;">${escHtml(bunk)}</span>
                            <span style="font-weight:500;color:#9ca3af;font-size:0.68rem;">Activity report</span>
                        </span>
                    </span>
                    <span style="width:8px;height:8px;border-right:2px solid #c4c7ce;border-bottom:2px solid #c4c7ce;transform:rotate(45deg);display:inline-block;margin-right:2px;"></span>
                </summary>
                <div id="post-edit-report-body" style="padding:12px 14px 14px;">${bodyHtml}</div>
            </details>`;
    }

    function renderBunkMiniReport(bunk, divName, locations, locationAvailMap, startMin, endMin) {
        try {
            _reportScheduleCloudHydrate(bunk, divName, { locations, locationAvailMap }, startMin, endMin);
            return _reportCardHtml(bunk, renderBunkReportBody(bunk, divName, locations, locationAvailMap, '', startMin, endMin));
        } catch (e) {
            debugLog('renderBunkMiniReport error', e);
            return '';
        }
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        let currentCustomText = '';
        let currentAppendText = '';
        let resolutionChoice = 'notify';

        const slots = window.SchedulerCoreUtils?.findSlotsForRange?.(startMin, endMin, unifiedTimes) || [];
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = typeof entry.field === 'object' ? entry.field?.name : (entry.field || '');
                currentActivity = entry._activity || currentField || currentValue;
                currentCustomText = entry._displayName || '';
                // Appended suffix: show ONLY the added part in the text box (the
                // append checkbox below is pre-checked for it).
                currentAppendText = entry._appendText || '';
                if (currentAppendText) currentCustomText = currentAppendText;
                // Custom-text block: the "activity" is just the typed text — keep
                // the activity box empty so re-saving stays a custom-text write.
                if (entry._customText) { currentActivity = ''; currentField = ''; }
            }
        }

        // Compute per-location availability at this time slot
        const locationAvailMap = {};
        for (const loc of locations) {
            locationAvailMap[loc.name] = _reportAvailEntry(checkLocationConflict(loc.name, slots, bunk));
        }
        // Report context: original availability + league/pinned fields folded in.
        // Kept separate from the dropdown's `locations` so the picker is unchanged.
        const _reportRC = _reportAugmentFields(bunk, startMin, endMin, locations, locationAvailMap);
        const _avOrd = { free: 0, partial: 1, busy: 2 };
        const fieldLocsSorted = [...locations.filter(l => l.type === 'field')].sort((a, b) =>
            (_avOrd[(locationAvailMap[a.name] || {}).status] ?? 0) -
            (_avOrd[(locationAvailMap[b.name] || {}).status] ?? 0)
        );
        const specialLocsSorted = [...locations.filter(l => l.type === 'special')].sort((a, b) =>
            (_avOrd[(locationAvailMap[a.name] || {}).status] ?? 0) -
            (_avOrd[(locationAvailMap[b.name] || {}).status] ?? 0)
        );
        function _locOptHtml(loc) {
            const av = locationAvailMap[loc.name] || { status: 'free', usage: 0, max: 1 };
            let label = escHtml(loc.name);
            if (av.status === 'free') {
                if (loc.capacity > 1) label += ` (cap:${loc.capacity})`;
                label += ' ✓';
            } else if (av.status === 'partial') {
                label += ` — ${av.usage}/${av.max} in use`;
            } else {
                label += ' — in use';
            }
            return `<option value="${escHtml(loc.name)}" ${loc.name === currentField ? 'selected' : ''}>${label}</option>`;
        }
        const divName_ = peiGetDivForBunk(bunk);
        const quickCandidates = peiAutoFillCandidates(bunk, divName_, startMin, endMin).slice(0, 5);
        const quickPickHtml = quickCandidates.length > 0 ? `<div id="post-edit-quickpick" style="margin-top:2px;">
            <label style="display:block;font-weight:500;color:#374151;margin-bottom:8px;font-size:0.875rem;">Quick Pick <span style="font-weight:400;color:#9ca3af;font-size:0.75rem;">— best available for this slot</span></label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">${quickCandidates.map(c => `<button class="pe-quick-btn" data-activity="${escHtml(c.activity)}" data-field="${escHtml(c.field || '')}" style="padding:5px 12px;border:1px solid #d1d5db;border-radius:20px;background:#fff;font-size:0.8rem;cursor:pointer;color:#374151;white-space:nowrap;">${escHtml(c.activity)}${c.field && c.field !== c.activity ? ` <span style="font-size:0.7rem;color:#9ca3af">@ ${escHtml(c.field)}</span>` : ''}</button>`).join('')}</div>
            </div>` : '';

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
            <div style="background:#f3f4f6;padding:12px 16px;border-radius:8px;margin-bottom:16px;">
                <div style="font-weight:600;color:#374151;">${escHtml(bunk)}</div>
                <div style="font-size:0.875rem;color:#6b7280;" id="post-edit-time-display">${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}</div>
            </div>
            ${renderBunkMiniReport(bunk, divName_, _reportRC.locations, _reportRC.locationAvailMap, startMin, endMin)}
            <div style="display:flex;flex-direction:column;gap:16px;">
                <div>
                    <label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Activity Name</label>
                    <input type="text" id="post-edit-activity" value="${escHtml(currentActivity)}" placeholder="e.g., Basketball"
                        style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;">
                    <div style="font-size:0.75rem;color:#9ca3af;margin-top:4px;">Enter CLEAR or FREE to empty this slot</div>
                </div>
                <div>
                    <label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Custom text <span style="font-weight:400;color:#9ca3af;">(optional)</span></label>
                    <input type="text" id="post-edit-custom-text" value="${escHtml(currentCustomText)}" placeholder="Type anything — e.g. Color War Breakout!"
                        style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;">
                    <div style="font-size:0.75rem;color:#9ca3af;margin-top:4px;">Shows on the schedule, print &amp; live view exactly as typed. With an activity above it just renames it; with no activity it becomes a free-text block.</div>
                    <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:0.82rem;color:#374151;cursor:pointer;user-select:none;">
                        <input type="checkbox" id="post-edit-append-mode" ${currentAppendText ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;">
                        Add to the existing name instead of replacing it <span style="color:#9ca3af;">(e.g. "Basketball – Court 1 — bring water")</span>
                    </label>
                </div>
                <div>
                    <label style="display:block;font-weight:500;color:#374151;margin-bottom:6px;">Location / Field</label>
                    <select id="post-edit-location" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;background:white;">
                        <option value="">-- No specific location --</option>
                        <optgroup label="Fields">${fieldLocsSorted.map(_locOptHtml).join('')}</optgroup>
                        <optgroup label="Special Activities">${specialLocsSorted.map(_locOptHtml).join('')}</optgroup>
                    </select>
                </div>
                <div id="post-edit-conflict" style="display:none;"></div>
                ${quickPickHtml}
                <div style="display:flex;gap:10px;margin-top:4px;">
                    <button id="post-edit-autofill" style="flex:1;padding:11px;border:2px dashed #a5b4fc;border-radius:8px;background:#eef2ff;color:#4338ca;font-size:0.95rem;cursor:pointer;font-weight:600;">⚡ Auto Fill &amp; Apply</button>
                </div>
                <div style="display:flex;gap:10px;margin-top:8px;">
                    <button id="post-edit-cancel" style="flex:1;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:white;color:#374151;font-size:1rem;cursor:pointer;font-weight:500;">Cancel</button>
                    <button id="post-edit-delete" style="padding:12px 16px;border:none;border-radius:8px;background:#fef2f2;color:#dc2626;font-size:1rem;cursor:pointer;font-weight:600;border:1px solid #fca5a5;">Delete</button>
                    <button id="post-edit-save" style="flex:1;padding:12px;border:none;border-radius:8px;background:#2563eb;color:white;font-size:1rem;cursor:pointer;font-weight:500;">Save Changes</button>
                </div>
            </div>`;
        
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;

        // Live-refresh the report body to reflect the activity being typed/picked.
        let _reportRaf = null;
        function refreshReport() {
            const body = document.getElementById('post-edit-report-body');
            if (!body) return;
            if (_reportRaf) cancelAnimationFrame(_reportRaf);
            _reportRaf = requestAnimationFrame(() => {
                const sel = (document.getElementById('post-edit-activity')?.value || '');
                body.innerHTML = renderBunkReportBody(bunk, divName_, _reportRC.locations, _reportRC.locationAvailMap, sel, startMin, endMin);
            });
        }
        document.getElementById('post-edit-activity').addEventListener('input', refreshReport);

        document.getElementById('post-edit-autofill').onclick = () => {
            const pick = quickCandidates[0] || peiAutoFill(bunk, divName_, startMin, endMin);
            if (!pick) { alert('No suitable activity found based on current constraints.'); return; }
            const locationVal = (pick.field && pick.field !== pick.activity) ? pick.field : null;
            const conflictCheck = locationVal ? checkLocationConflict(locationVal, slots, bunk) : null;
            closeModal();
            onSave({
                activity: pick.activity, location: locationVal,
                startMin, endMin,
                hasConflict: !!conflictCheck?.hasConflict,
                conflicts: conflictCheck?.conflicts || [],
                editableConflicts: conflictCheck?.editableConflicts || [],
                nonEditableConflicts: conflictCheck?.nonEditableConflicts || [],
                resolutionChoice: 'notify'
            });
            peiShowBanner('Auto-filled: ' + pick.activity, 'success', true);
        };

        modal.querySelectorAll('.pe-quick-btn').forEach(btn => {
            btn.onclick = () => {
                document.getElementById('post-edit-activity').value = btn.dataset.activity;
                const loc = document.getElementById('post-edit-location');
                const fieldVal = btn.dataset.field;
                if (fieldVal) {
                    for (let i = 0; i < loc.options.length; i++) {
                        if (loc.options[i].value === fieldVal) { loc.selectedIndex = i; break; }
                    }
                } else {
                    loc.selectedIndex = 0;
                }
                modal.querySelectorAll('.pe-quick-btn').forEach(b => { b.style.background = '#fff'; b.style.borderColor = '#d1d5db'; });
                btn.style.background = '#dbeafe'; btn.style.borderColor = '#3b82f6';
                checkAndShowConflicts();
                refreshReport();
            };
        });

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
                    <p style="margin:0 0 8px 0;color:#78350f;font-size:0.875rem;"><strong>${escHtml(location)}</strong> is already in use:</p>`;

                if (editableBunks.length > 0) {
                    html += `<div style="margin-bottom:8px;padding:8px;background:#d1fae5;border-radius:6px;"><div style="font-size:0.8rem;color:#065f46;"><strong>✓ Can auto-reassign:</strong> ${editableBunks.map(escHtml).join(', ')}</div></div>`;
                }

                if (nonEditableBunks.length > 0) {
                    html += `<div style="margin-bottom:8px;padding:8px;background:#fee2e2;border-radius:6px;"><div style="font-size:0.8rem;color:#991b1b;"><strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.map(escHtml).join(', ')}</div></div>
                    <div style="margin-top:12px;">
                        <div style="font-weight:500;color:#374151;margin-bottom:8px;font-size:0.875rem;">How to handle their bunks?</div>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:8px;background:white;border-radius:6px;border:2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="notify" checked style="margin-top:2px;">
                                <div><div style="font-weight:500;color:#374151;">Override &amp; flag the other scheduler</div><div style="font-size:0.75rem;color:#6b7280;">Take the slot; their conflicting activity is flagged and they're notified</div></div>
                            </label>
                            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:8px;background:white;border-radius:6px;border:2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="bypass" style="margin-top:2px;">
                                <div><div style="font-weight:500;color:#374151;">Override &amp; reschedule the other scheduler</div><div style="font-size:0.75rem;color:#6b7280;">Take the slot; their conflict is auto-rescheduled and they're notified</div></div>
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
            let customTextVal = document.getElementById('post-edit-custom-text')?.value.trim() || '';
            const appendMode = !!document.getElementById('post-edit-append-mode')?.checked;
            let appendTextVal = '';
            const times = getEffectiveTimes();

            if (times.endMin <= times.startMin) { alert('End time must be after start time.'); return; }

            // APPEND mode: keep what the cell already says and add the text after it.
            if (appendMode && (customTextVal || currentAppendText)) {
                const activityChanged = activity && activity.toLowerCase() !== String(currentActivity || '').toLowerCase();
                const locationChanged = location && location.toLowerCase() !== String(currentField || '').toLowerCase();
                if (!activityChanged && !locationChanged) {
                    // Nothing else changed → safe in-place decorate.
                    peiApplyAppendText(bunk, times.startMin, times.endMin, customTextVal);
                    closeModal();
                    return;
                }
                // Activity/field changed too → normal rewrite with composed label.
                appendTextVal = customTextVal;
                if (activity) {
                    const base = (location && location.toLowerCase() !== activity.toLowerCase()) ? activity + ' – ' + location : activity;
                    customTextVal = customTextVal ? base + ' — ' + customTextVal : '';
                }
            }

            // Custom-text-only save: no activity typed, just free text — place it
            // as a custom text block (no field claim, no rotation credit).
            if (!activity && customTextVal) {
                onSave({ activity: customTextVal, displayName: customTextVal, customText: true,
                    location: '', startMin: times.startMin, endMin: times.endMin,
                    hasConflict: false, conflicts: [] });
                closeModal();
                return;
            }
            if (!activity) { alert('Enter an activity name — or type custom text below to place free text.'); return; }

            const targetSlots = window.SchedulerCoreUtils?.findSlotsForRange?.(times.startMin, times.endMin, unifiedTimes) || [];
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;

            if (conflictCheck?.hasConflict) {
                onSave({ activity, location, displayName: customTextVal, appendText: appendTextVal, startMin: times.startMin, endMin: times.endMin,
                    hasConflict: true, conflicts: conflictCheck.conflicts,
                    editableConflicts: conflictCheck.editableConflicts || [],
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [],
                    resolutionChoice });
            } else {
                onSave({ activity, location, displayName: customTextVal, appendText: appendTextVal, startMin: times.startMin, endMin: times.endMin, hasConflict: false, conflicts: [] });
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

    /**
     * Find the bunk container element (column in legacy, row in transposed)
     * and the block container (the column itself in legacy, the strip in transposed).
     * Returns { container, blockContainer, isTransposed } or null.
     */
    function peiFindBunkContainer(wrap, bunk, bunkIdx) {
        if (!wrap) return null;
        const isTransposed = !!wrap.querySelector('.asg-tx-scroll');
        if (isTransposed) {
            const rows = wrap.querySelectorAll('.asg-tx-row:not(.asg-tx-headrow)');
            for (const row of rows) {
                const bunkEl = row.querySelector('.asg-tx-bunk');
                if (bunkEl && bunkEl.textContent.trim() === bunk) {
                    const strip = row.querySelector('.asg-tx-strip');
                    return { container: row, blockContainer: strip || row, isTransposed: true };
                }
            }
            return null;
        }
        // Legacy: navigate via first block
        const scrollEl = wrap.querySelector('.asg-scroll');
        if (!scrollEl) return null;
        const firstBlock = scrollEl.querySelector('.asg-block') || scrollEl.querySelector('.asg-free');
        if (!firstBlock) return null;
        const bodyRow = firstBlock.parentElement.parentElement;
        const col = bodyRow.children[bunkIdx];
        if (!col) return null;
        return { container: col, blockContainer: col, isTransposed: false };
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
                // ★ Direct-fill label resolution (Swim etc., shared helper in
                //   unified_schedule_system.js): no facility anywhere →
                //   unlimited (skip the capacity check); facility assigned off
                //   the exact name → use THAT facility's capacity.
                const _lblAv = window.resolveLabelSharing?.(fieldOnly, window.activityProperties);
                if (window.TimeBasedFieldUsage?.checkAvailability && _lblAv !== 'unlimited') {
                    const allProps = window.activityProperties || {};
                    let actProps = allProps[fieldOnly];
                    if (!actProps) {
                        const lower = fieldOnly.toLowerCase();
                        for (const key in allProps) {
                            if (key.toLowerCase() === lower) { actProps = allProps[key]; break; }
                        }
                    }
                    actProps = actProps || {};
                    let capacity = actProps.sharableWith?.capacity ? parseInt(actProps.sharableWith.capacity) || 1 : (actProps.sharable ? 2 : 1);
                    if (_lblAv && _lblAv.sharableWith && window.labelSharingCapacity) {
                        capacity = window.labelSharingCapacity(_lblAv.sharableWith, capacity);
                    }
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
        document.querySelectorAll('.asg-block[data-pei-bunk], .asg-tx-block[data-pei-bunk]').forEach(blk => { if (blk._peiShadow) { blk.style.boxShadow = ''; blk._peiShadow = false; } });
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
        // Update duration label — find by content since resize handles are appended after
        const dur = newEnd - newStart;
        const allSubs = s.block.querySelectorAll('.asg-block-sub');
        for (const sub of allSubs) { if (/\d+min/.test(sub.textContent)) { sub.textContent = dur + 'min'; break; } }
        // Tooltip at block edge
        const br = s.block.getBoundingClientRect();
        let tip = peiToLabel(newStart) + ' – ' + peiToLabel(newEnd) + ` <span style="opacity:0.6">(${dur}min)</span>`;
        const c = PEI_ConflictEngine.check(s.bunk, newStart, newEnd, s.fieldName, s.slotIdx);
        if (c.fieldConflicts.length > 0) tip += `<br><span style="color:#fcd34d;">⚡ Field: ${c.fieldConflicts.map(x => escHtml(x.bunk)).join(', ')}</span>`;
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
        const allSubsEnd = s.block.querySelectorAll('.asg-block-sub');
        for (const sub of allSubsEnd) { if (/\d+min/.test(sub.textContent)) { sub.textContent = finalDur + 'min'; break; } }
        const c = PEI_ConflictEngine.check(s.bunk, s.currentStartMin, s.currentEndMin, s.fieldName, s.slotIdx);
        peiApplyTimeChange(s.bunk, s.slotIdx, s.origStartMin, s.origEndMin, s.currentStartMin, s.currentEndMin, s.divName);
        // Directly inject free gap from what we know
        const _col = s.col, _bunk = s.bunk, _divName = s.divName, _dayStart = s.dayStart;
        let gapStart = -1, gapEnd = -1;
        if (s.currentEndMin < s.origEndMin) { gapStart = s.currentEndMin; gapEnd = s.origEndMin; }     // shortened bottom
        else if (s.currentStartMin > s.origStartMin) { gapStart = s.origStartMin; gapEnd = s.currentStartMin; } // shortened top
        if (gapStart >= 0 && (gapEnd - gapStart) >= PEI_MIN_BLOCK_DURATION) {
            // Remove any existing injected free in this column that overlaps
            _col.querySelectorAll('.pei-injected-free').forEach(el => {
                const elTop = parseFloat(el.style.top);
                const newTop = (gapStart - _dayStart) * PEI_PX_PER_MIN + 2;
                // If existing gap is adjacent/overlapping, merge by removing old
                const existingGapStart = _dayStart + ((elTop - 2) / PEI_PX_PER_MIN);
                const existingGapEnd = existingGapStart + ((parseFloat(el.style.height) + 4) / PEI_PX_PER_MIN);
                // Merge: if gaps touch or overlap, expand our gap range and remove old
                if (existingGapStart <= gapEnd + PEI_SNAP_MINS && existingGapEnd >= gapStart - PEI_SNAP_MINS) {
                    gapStart = Math.min(gapStart, existingGapStart);
                    gapEnd = Math.max(gapEnd, existingGapEnd);
                    el.remove();
                }
            });
            peiInjectFreeGapDirect(_col, gapStart, gapEnd, _dayStart, _bunk, _divName);
        }
        if (c.fieldConflicts.length > 0) peiShowBanner('Resized — field conflict: ' + c.fieldConflicts.map(x => x.bunk).join(', '), 'warning', true);
        else peiShowBanner('Resized to ' + peiToLabel(s.currentStartMin) + ' – ' + peiToLabel(s.currentEndMin), 'success', true);
        _peiResizing = false; _peiState = null;
    }

    /**
     * Scan a bunk column for all free time gaps and inject combined "+" blocks.
     * Replaces per-resize gap injection — naturally combines multiple resizes.
     */
    function peiScanAndInjectGaps(col, bunk, divName, dayStart, dayEnd) {
        // Remove existing injected free/blocks in this column
        col.querySelectorAll('.pei-injected-free').forEach(el => el.remove());

        // Build a list of occupied time ranges from assignments
        const assignments = window.scheduleAssignments?.[bunk] || [];
        const divSlots = window.divisionTimes?.[divName] || [];
        const occupied = []; // [{startMin, endMin}]

        for (let i = 0; i < Math.min(assignments.length, divSlots.length); i++) {
            const entry = assignments[i];
            if (!entry || entry.continuation) continue;
            // Use custom times if available, otherwise slot boundaries
            const start = entry._startMin !== undefined ? entry._startMin : divSlots[i].startMin;
            const end = entry._endMin !== undefined ? entry._endMin : divSlots[i].endMin;
            // Walk continuations to find true end
            let trueEnd = end;
            if (!entry._postEdited) {
                for (let j = i + 1; j < assignments.length; j++) {
                    if (assignments[j] && assignments[j].continuation && divSlots[j]) {
                        trueEnd = divSlots[j].endMin;
                    } else break;
                }
            }
            occupied.push({ startMin: start, endMin: Math.max(end, trueEnd) });
        }

        // Sort by start time
        occupied.sort((a, b) => a.startMin - b.startMin);

        // Find gaps between occupied ranges
        let cursor = dayStart;
        for (const occ of occupied) {
            if (occ.startMin > cursor + PEI_MIN_BLOCK_DURATION) {
                // Gap from cursor to occ.startMin
                peiInjectFreeGapDirect(col, cursor, occ.startMin, dayStart, bunk, divName);
            }
            cursor = Math.max(cursor, occ.endMin);
        }
        // Gap at the end
        if (dayEnd > cursor + PEI_MIN_BLOCK_DURATION) {
            peiInjectFreeGapDirect(col, cursor, dayEnd, dayStart, bunk, divName);
        }
    }

    /**
     * Inject a single free-space block at an absolute time range.
     */
    function peiInjectFreeGapDirect(col, gapStart, gapEnd, dayStart, bunk, divName) {
        const gapDur = gapEnd - gapStart;
        if (gapDur < PEI_MIN_BLOCK_DURATION) return;

        const topPx = (gapStart - dayStart) * PEI_PX_PER_MIN + 2;
        const heightPx = gapDur * PEI_PX_PER_MIN - 4;

        const freeEl = document.createElement('div');
        freeEl.className = 'asg-free pei-injected-free';
        freeEl.style.cssText = `position:absolute;left:3px;right:3px;top:${topPx}px;height:${heightPx}px;border-radius:5px;background:repeating-linear-gradient(45deg,#f9fafb,#f9fafb 4px,#f3f4f6 4px,#f3f4f6 8px);border:1px dashed #d1d5db;display:flex;align-items:center;justify-content:center;z-index:0;transition:border-color 0.2s;`;

        if (canEditBunk(bunk)) {
            freeEl.style.gap = '6px';

            const addBtn = document.createElement('div');
            addBtn.className = 'pei-add-btn';
            addBtn.innerHTML = '+';
            addBtn.title = `Add activity (${gapDur}min)`;
            addBtn.style.cssText = 'width:26px;height:26px;border-radius:50%;background:rgba(37,99,235,0.1);color:#2563eb;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.2s,background 0.2s,transform 0.15s;z-index:4;flex-shrink:0;';
            freeEl.appendChild(addBtn);

            const autoBtn = document.createElement('div');
            autoBtn.className = 'pei-autofill-btn';
            autoBtn.innerHTML = '⚡';
            autoBtn.title = `Auto-fill this gap`;
            autoBtn.style.cssText = 'padding:2px 8px;border-radius:999px;background:rgba(124,58,237,0.1);color:#7c3aed;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.2s,background 0.2s;z-index:4;white-space:nowrap;flex-shrink:0;letter-spacing:0.01em;';
            freeEl.appendChild(autoBtn);

            freeEl.addEventListener('mouseenter', () => { addBtn.style.opacity = '1'; autoBtn.style.opacity = '1'; freeEl.style.borderColor = '#93c5fd'; });
            freeEl.addEventListener('mouseleave', () => { addBtn.style.opacity = '0'; autoBtn.style.opacity = '0'; freeEl.style.borderColor = '#d1d5db'; });
            addBtn.addEventListener('mouseenter', () => { addBtn.style.background = 'rgba(37,99,235,0.2)'; });
            addBtn.addEventListener('mouseleave', () => { addBtn.style.background = 'rgba(37,99,235,0.1)'; });
            autoBtn.addEventListener('mouseenter', () => { autoBtn.style.background = 'rgba(124,58,237,0.2)'; });
            autoBtn.addEventListener('mouseleave', () => { autoBtn.style.background = 'rgba(124,58,237,0.1)'; });

            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                peiShowAddModal(bunk, divName, gapStart, gapEnd);
            });

            autoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pick = peiAutoFill(bunk, divName, gapStart, gapEnd);
                if (!pick) { peiShowBanner('No suitable activity found for this gap', 'warning'); return; }
                peiApplyNewBlock(bunk, divName, gapStart, gapEnd, pick.activity, pick.field || null);
                peiShowBanner(`✓ Auto-filled: ${pick.activity}`, 'success', true);
            });
        }

        col.appendChild(freeEl);
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
        if (c.fieldConflicts.length > 0) tip += `<br><span style="color:#fcd34d;">⚡ Field: ${c.fieldConflicts.map(x => escHtml(x.bunk)).join(', ')}</span>`;
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
        const fieldOpts = locations.filter(l => l.type === 'field').map(l => `<option value="${escHtml(l.name)}">${escHtml(l.name)}${l.capacity > 1 ? ` (cap:${l.capacity})` : ''}</option>`).join('');
        const specOpts = locations.filter(l => l.type === 'special').map(l => `<option value="${escHtml(l.name)}">${escHtml(l.name)}</option>`).join('');
        // Build constraint-aware suggestions by generating many candidates and taking top 8
        const allCandidates = peiAutoFillCandidates(bunk, divName, startMin, endMin);
        const suggestions = allCandidates.slice(0, 8);
        const sugHtml = suggestions.length > 0 ? `<div><label style="display:block;font-weight:500;color:#374151;margin-bottom:8px;">Quick Pick</label><div id="pei-add-suggestions" style="display:flex;flex-wrap:wrap;gap:6px;">${suggestions.map(a => `<button class="pei-suggestion-btn" data-activity="${escHtml(a.activity)}" data-field="${escHtml(a.field || '')}" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:20px;background:#fff;font-size:0.8rem;cursor:pointer;color:#374151;transition:all 0.15s;">${escHtml(a.activity)}${a.field && a.field !== a.activity ? ` <span style='font-size:0.7rem;opacity:0.6'>@ ${escHtml(a.field)}</span>` : ''}</button>`).join('')}</div></div>` : '';

        const overlay = document.createElement('div'); overlay.id = 'pei-add-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100003;display:flex;align-items:center;justify-content:center;animation:pei-fade-in 0.2s ease-out';
        overlay.innerHTML = `<div style="background:#fff;border-radius:16px;padding:28px;min-width:420px;max-width:520px;max-height:85vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><h2 style="margin:0;font-size:1.2rem;color:#1f2937;">Add New Activity</h2><button id="pei-add-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#9ca3af;line-height:1;">&times;</button></div>
            <div style="background:#f3f4f6;padding:12px 16px;border-radius:8px;margin-bottom:20px;"><div style="font-weight:600;color:#374151;">${escHtml(bunk)}</div><div style="font-size:0.875rem;color:#6b7280;">${peiToLabel(startMin)} – ${peiToLabel(endMin)} (${endMin - startMin}min)</div></div>
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
        let _mdAddOverlay = false;
        overlay.addEventListener('mousedown', e => { _mdAddOverlay = (e.target === overlay); });
        overlay.addEventListener('click', e => { if (e.target === overlay && _mdAddOverlay) closeAdd(); });
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
        if (!c.hasConflict) { el.style.display = 'block'; el.style.cssText = 'padding:10px 14px;border-radius:8px;background:#f0fdf4;border:1px solid #86efac;color:#166534;font-size:0.85rem;display:block;'; el.innerHTML = '✅ ' + escHtml(location) + ' is available'; }
        else if (c.fieldConflicts.length > 0) { el.style.display = 'block'; el.style.cssText = 'padding:10px 14px;border-radius:8px;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;font-size:0.85rem;display:block;'; el.innerHTML = '⚠️ ' + escHtml(location) + ' in use by: ' + c.fieldConflicts.map(x => escHtml(x.bunk)).join(', '); }
    }

    // ── Grade-usability gate for suggestions ──
    // A Quick-Pick / Auto-fill suggestion must be BOTH currently available AND
    // actually usable by this bunk's grade (division). These mirror the solver's
    // own gates — canBlockFit's accessRestrictions logic (scheduler_core_utils.js)
    // and isSpecialAvailableForBunk (scheduler_core_auto.js) — so we never offer
    // an activity that generation itself would reject.
    function peiAccessRestrictionsAllow(rules, divName, bunk) {
        if (!rules || !rules.enabled) return true;
        const divisions = rules.divisions || {};
        // Toggle on but no grades picked = misconfig → treat as NO restriction
        // (matches canBlockFit / auto+total solver parity).
        if (Object.keys(divisions).length === 0) return true;
        const divNameStr = String(divName);
        if (!(divNameStr in divisions) && !(divName in divisions)) return false;
        const divRule = divisions[divNameStr] || divisions[divName];
        // Non-empty per-bunk list = only those bunks in this grade may use it.
        if (Array.isArray(divRule) && divRule.length > 0) {
            const bunkStr = String(bunk);
            const bunkNum = parseInt(bunk);
            if (!divRule.some(b => String(b) === bunkStr || parseInt(b) === bunkNum)) return false;
        }
        return true;
    }

    function peiFieldUsableByGrade(field, sportName, divName, bunk) {
        // Per-date "only these bunk(s) today" restriction (field- or sport-scoped).
        if (window.SchedulerCoreUtils?.isBunkRestrictedFromTarget?.(bunk, sportName, field.name, divName)) return false;
        // Per-date sport-disabled-on-this-field ("Kickball off Baseball Field 1 today").
        const dd = (window.loadCurrentDailyData?.() || {}).dailyDisabledSportsByField || {};
        const blocked = dd[field.name];
        if (Array.isArray(blocked) && sportName && blocked.includes(sportName)) return false;
        // Field access restrictions (division + per-bunk), read straight off the
        // raw field config so this holds even when activityProperties isn't built.
        return peiAccessRestrictionsAllow(field.accessRestrictions, divName, bunk);
    }

    function peiSpecialUsableByGrade(special, divName, bunk, settings) {
        // Canonical gate: honors division access + per-bunk + per-date bunk-only.
        if (typeof window.isSpecialAvailableForBunk === 'function') {
            try { return window.isSpecialAvailableForBunk(special.name, divName, bunk, settings); } catch (_) { /* fall through */ }
        }
        if (window.SchedulerCoreUtils?.isBunkRestrictedFromTarget?.(bunk, special.name, null, divName)) return false;
        return peiAccessRestrictionsAllow(special.accessRestrictions, divName, bunk);
    }

    // ── Auto-fill (constraint-aware) ──
    function peiAutoFillCandidates(bunk, divName, startMin, endMin) {
        // 1) What has this bunk already done today (activities AND fields)?
        const todayActivities = new Set();
        const todayFields = new Set();
        peiBunkActivities(bunk, divName).forEach(a => {
            const actName = (a.entry._activity || '').toLowerCase();
            const fieldName = (typeof a.entry.field === 'string' ? a.entry.field : '').toLowerCase();
            if (actName && actName !== 'free') todayActivities.add(actName);
            if (fieldName && fieldName !== 'free' && !fieldName.includes('–')) todayFields.add(fieldName);
            if (fieldName.includes('–')) { const f = fieldName.split('–')[0].trim().toLowerCase(); if (f) todayFields.add(f); }
        });

        // 2) Check rainy day status
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const isRainyDay = settings.rainyDays?.[currentDate] ||
                           window.SkeletonSandbox?.isRainyDay?.(currentDate) || false;

        // 3) Build candidates
        const candidates = [];

        const allProps = window.SchedulerCoreUtils?.getActivityProperties?.() ||
                         window.activityProperties || {};

        (app1.fields || []).forEach(f => {
            if (!f.name || f.available === false) return;
            if (todayFields.has(f.name.toLowerCase())) return;
            if (f.rainyDayOnly && !isRainyDay) return;
            if (f.outdoors && isRainyDay && !f.rainyDayOnly) return;

            const fieldProps = allProps[f.name] || allProps[f.name.toLowerCase()] || {};
            const fieldMax = fieldProps.maxUsage != null ? parseInt(fieldProps.maxUsage) : Infinity;
            const _gpc = window.SchedulerCoreUtils?.getPeriodActivityCount;

            (f.activities || f.sports || []).forEach(sport => {
                const sn = typeof sport === 'string' ? sport : sport.name;
                if (!sn || todayActivities.has(sn.toLowerCase())) return;
                // Only suggest what this bunk's grade may actually use.
                if (!peiFieldUsableByGrade(f, sn, divName, bunk)) return;
                const cap = f.sharableWith?.capacity ? parseInt(f.sharableWith.capacity) || 1 : 1;
                if (window.TimeBasedFieldUsage?.checkAvailability) {
                    if (!window.TimeBasedFieldUsage.checkAvailability(f.name, startMin, endMin, cap, bunk).available) return;
                }
                const fieldMaxPeriod = fieldProps.maxUsagePeriod || 'half';
                const usageCount = (_gpc && fieldMax < Infinity) ? _gpc(bunk, sn, fieldMaxPeriod) : (window.RotationEngine?.getActivityCount?.(bunk, sn) || 0);
                if (usageCount >= fieldMax) return;
                const daysSince = window.RotationEngine?.getDaysSinceActivity?.(bunk, sn, 0);
                let score = 100 - usageCount;
                if (daysSince === null) score += 20;
                else if (daysSince >= 7) score += 10;
                else if (daysSince >= 3) score += 5;
                // ★ Avoid-unless-needed (soft rule): keep it available but rank it
                //   dead last so auto-fill only reaches for it when nothing else fits.
                if (window.SchedulerCoreUtils?.isSportAvoidedUnlessNeeded?.(divName, sn)) score -= 100000;
                candidates.push({ activity: sn, field: f.name, score });
            });
        });

        (window.getGlobalSpecialActivities?.() || app1.specialActivities || []).forEach(s => {
            if (!s.name || todayActivities.has(s.name.toLowerCase())) return;
            if (s.rainyDayOnly && !isRainyDay) return;
            if (s.outdoors && isRainyDay && !s.rainyDayOnly) return;
            // Only suggest specials this bunk's grade may actually use.
            if (!peiSpecialUsableByGrade(s, divName, bunk, settings)) return;
            const cap = s.sharableWith?.capacity ? parseInt(s.sharableWith.capacity) || 1 : 1;
            if (window.TimeBasedFieldUsage?.checkAvailability) {
                if (!window.TimeBasedFieldUsage.checkAvailability(s.name, startMin, endMin, cap, bunk).available) return;
            }
            const specProps = allProps[s.name] || allProps[s.name.toLowerCase()] || {};
            const specMax = specProps.maxUsage != null ? parseInt(specProps.maxUsage) : Infinity;
            const _gpc2 = window.SchedulerCoreUtils?.getPeriodActivityCount;
            const specMaxPeriod = specProps.maxUsagePeriod || 'half';
            const usageCount = (_gpc2 && specMax < Infinity) ? _gpc2(bunk, s.name, specMaxPeriod) : (window.RotationEngine?.getActivityCount?.(bunk, s.name) || 0);
            if (usageCount >= specMax) return;
            const specExact = specProps.exactFrequency != null ? parseInt(specProps.exactFrequency) : 0;
            var _exactEscBonus = 0;
            if (specExact > 0) {
                const exactPeriod = specProps.exactFrequencyPeriod || '1week';
                const exactCount = _gpc2 ? _gpc2(bunk, s.name, exactPeriod) : usageCount;
                if (exactCount >= specExact) return;
                const needed = specExact - exactCount;
                _exactEscBonus = window.SchedulerCoreUtils?.getEscalationBonus?.(exactPeriod, needed) || 0;
            }
            const daysSince = window.RotationEngine?.getDaysSinceActivity?.(bunk, s.name, 0);
            let score = 100 - usageCount + _exactEscBonus;
            if (daysSince === null) score += 20;
            else if (daysSince >= 7) score += 10;
            else if (daysSince >= 3) score += 5;
            // ★ Avoid-unless-needed parity for a special sharing a rule-listed name.
            if (window.SchedulerCoreUtils?.isSportAvoidedUnlessNeeded?.(divName, s.name)) score -= 100000;
            candidates.push({ activity: s.name, field: s.name, score });
        });

        candidates.sort((a, b) => b.score - a.score);
        return candidates;
    }

    function peiAutoFill(bunk, divName, startMin, endMin) {
        const candidates = peiAutoFillCandidates(bunk, divName, startMin, endMin);
        debugLog('Auto-fill candidates for', bunk, ':', candidates.length, 'options. Top 3:', candidates.slice(0, 3));
        return candidates[0] || null;
    }

    // ── Undo system ──

    // Single-bunk snapshot — back-compat wrapper around peiSnapshotTransaction.
    function peiSnapshotBunk(bunk, description) {
        peiSnapshotTransaction([bunk], description);
    }
    window.peiSnapshotBunk = peiSnapshotBunk;

    // Multi-bunk transaction snapshot. Captures the FULL pre-edit state of
    // every affected bunk plus the historicalCounts delta inverse needed
    // to roll counts back. Without this, undoing a multi-bunk edit either
    // did nothing or — worse — silently popped an earlier 1-bunk edit and
    // restored its state.
    function peiSnapshotTransaction(bunks, description, opts) {
        opts = opts || {};
        if (!Array.isArray(bunks) || bunks.length === 0) return;
        const tx = {
            description: description,
            timestamp: Date.now(),
            dateKey: window.currentScheduleDate || '',
            bunks: [],
            counts: opts.counts || []  // [{ bunk, newAct, oldActs, slots }, ...]
        };
        for (let i = 0; i < bunks.length; i++) {
            const b = bunks[i];
            const assignments = window.scheduleAssignments?.[b];
            if (!assignments) continue;
            try {
                tx.bunks.push({ bunk: b, snapshot: JSON.parse(JSON.stringify(assignments)) });
            } catch (_) {}
        }
        if (tx.bunks.length === 0) return;
        _peiUndoStack.push(tx);
        if (_peiUndoStack.length > PEI_MAX_UNDO) _peiUndoStack.shift();
        _peiSaveUndoStack();
        debugLog('Undo transaction saved:', description, '(bunks:', tx.bunks.length, 'stack size:', _peiUndoStack.length + ')');
    }
    window.peiSnapshotTransaction = peiSnapshotTransaction;

    function peiUndo() {
        if (_peiUndoStack.length === 0) {
            peiShowBanner('Nothing to undo', 'warning');
            return;
        }
        const tx = _peiUndoStack.pop();
        _peiSaveUndoStack();

        // Mark post-edit-in-progress so realtime sync doesn't race the restore.
        if (typeof window.markPostEditInProgress === 'function') {
            window.markPostEditInProgress();
        } else {
            window._postEditInProgress = true;
        }

        // Back-compat: old { bunk, snapshot } shape.
        if (tx.bunk && tx.snapshot) {
            window.scheduleAssignments[tx.bunk] = tx.snapshot;
            peiTriggerReRender();
            peiSave(tx.bunk);
            peiShowBanner('↩ Undid: ' + tx.description, 'success');
            return;
        }

        // New transaction shape.
        for (let i = 0; i < tx.bunks.length; i++) {
            const e = tx.bunks[i];
            window.scheduleAssignments[e.bunk] = e.snapshot;
        }

        // Slice 4 audit R-3 — invert per UNIQUE original activity instead of
        // just oldActs[0]. applyPostEditCounts's signature is
        // (bunk, oldActivities, newActivity, slots) so it can apply one
        // (oldArr → newSingle) per call. If the original slot range had
        // multiple distinct activities (Lunch + Soccer + Free), we loop
        // and call _ape once per original activity.
        try {
            const _ape = window.SchedulerCoreUtils?.applyPostEditCounts;
            if (_ape && Array.isArray(tx.counts)) {
                // Step 1: strip new activities via _ape (also rebuilds rotationHistory)
                for (let i = 0; i < tx.counts.length; i++) {
                    const c = tx.counts[i];
                    if (!c || !c.bunk) continue;
                    if (c.newAct) {
                        _ape(c.bunk, [c.newAct], null, c.slots || []);
                    }
                }
                // Step 2: re-add originals by exact frequency. Load once,
                // accumulate all changes, save once — avoids stale-read
                // race when multiple bunks are in the counts array.
                const _gs2 = window.loadGlobalSettings?.() || {};
                const _hc = _gs2.historicalCounts || {};
                let _hcDirty = false;
                for (let i = 0; i < tx.counts.length; i++) {
                    const c = tx.counts[i];
                    if (!c || !c.bunk) continue;
                    const _oldFreq = {};
                    (c.oldActs || []).forEach(function (a) { if (a) _oldFreq[a] = (_oldFreq[a] || 0) + 1; });
                    if (Object.keys(_oldFreq).length === 0) continue;
                    if (!_hc[c.bunk]) _hc[c.bunk] = {};
                    for (const [act, count] of Object.entries(_oldFreq)) {
                        _hc[c.bunk][act] = (_hc[c.bunk][act] || 0) + count;
                    }
                    _hcDirty = true;
                }
                if (_hcDirty && window.saveGlobalSettings) {
                    window.saveGlobalSettings('historicalCounts', _hc);
                }
            }
        } catch (e) { console.warn('[peiUndo] counts inverse failed:', e?.message || e); }

        peiTriggerReRender();
        // Cloud sync via bypass save covers all affected bunks.
        if (typeof window.bypassSaveAllBunks === 'function') {
            window.bypassSaveAllBunks(tx.bunks.map(function (e) { return e.bunk; }));
        } else {
            for (let i = 0; i < tx.bunks.length; i++) peiSave(tx.bunks[i].bunk);
        }
        peiShowBanner('↩ Undid: ' + tx.description + ' (' + tx.bunks.length + ' bunk' + (tx.bunks.length > 1 ? 's' : '') + ')', 'success');
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', { detail: { undo: true } }));
    }
    window.peiUndo = peiUndo;

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

        // Slice 4 audit fix — drag-resize / drag-move had ZERO validation
        // before. A user could drag a block onto a window outside the
        // field's Available time-rule and it would stick. Route through
        // the manual gate. Free / null activities are exempt.
        const _actName = origEntry._activity || origEntry.field || '';
        const _location = origEntry._location || origEntry.field || null;
        if (_actName && _actName !== 'Free' && typeof window.commitManualWriteIfLegal === 'function') {
            const _check = window.commitManualWriteIfLegal(
                bunk, origSlotIdx, _actName, _location, divName,
                newStart, newEnd, { allowSoftOverride: false }
            );
            if (!_check.ok) {
                if (_check.soft && typeof window.confirm === 'function') {
                    if (!window.confirm('Heads up: ' + _check.reason + '.\n\nApply anyway?')) {
                        return;
                    }
                } else if (!_check.soft) {
                    if (typeof peiShowBanner === 'function') {
                        peiShowBanner('Cannot place: ' + _check.reason, 'error');
                    } else {
                        console.warn('[peiApplyTimeChange] BLOCKED:', _check.reason);
                    }
                    return;
                }
            }
        }

        // Snapshot for undo BEFORE any changes
        const actName = origEntry._activity || origEntry.field || 'block';
        if (newStart !== origStart || newEnd !== origEnd) {
            peiSnapshotBunk(bunk, (newEnd - newStart) !== (origEnd - origStart)
                ? `Resize ${actName} (${origEnd - origStart}m → ${newEnd - newStart}m)`
                : `Move ${actName} to ${peiToLabel(newStart)}`);
        }

        // Use the centralized marker (defined in unified_schedule_system).
        if (typeof window.markPostEditInProgress === 'function') {
            window.markPostEditInProgress();
        } else {
            window._postEditInProgress = true;
            window._postEditTimestamp = Date.now();
        }

        // 1) Find ALL slots the original entry occupies
        const oldSlots = peiFindEntrySlots(assignments, origSlotIdx);

        // 2) Save a clean copy of the entry (without continuation flag)
        // Recalculate travel time for the new position
        const location = origEntry._location || origEntry._travelZone;
        if (location && (window.getTravelForField || window.getTravelForSpecialActivity)) {
            const travelInfo = window.getTravelForField?.(location, true) || window.getTravelForSpecialActivity?.(location, true) || null;
            if (travelInfo) {
                origEntry._travelPre = travelInfo.preMin;
                origEntry._travelPost = travelInfo.postMin;
                origEntry._travelZone = travelInfo.zoneName;
                origEntry._travelMode = 'deduct';
            }
        }
        const cleanEntry = Object.assign({}, origEntry, { continuation: false });

        // 3) Clear ONLY the slots this entry occupied
        oldSlots.forEach(idx => { assignments[idx] = null; });

        // 4) Find new target slots — only claim if block covers meaningful portion
        const newSlotIndices = [];
        for (let i = 0; i < divSlots.length; i++) {
            const overlapStart = Math.max(newStart, divSlots[i].startMin);
            const overlapEnd = Math.min(newEnd, divSlots[i].endMin);
            const overlap = overlapEnd - overlapStart;
            if (overlap > PEI_SNAP_MINS) {
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

        // ★ DATA-LOSS GUARD: if EVERY target slot was occupied by another
        // activity, the write loop above skipped all of them and wrote NOTHING —
        // but step 3 already cleared oldSlots, so the dragged block would be
        // silently DELETED (the newSlotIndices.length===0 revert above does not
        // cover this case). Restore the block to its original slots, re-render to
        // snap it back, drop the undo snapshot, and abort.
        const _wroteSomething = newSlotIndices.some(idx => assignments[idx] && assignments[idx]._postEdited);
        if (!_wroteSomething) {
            debugLog('PEI: all target slots occupied — reverting (no silent delete)');
            oldSlots.forEach((idx, i) => {
                if (i === 0) assignments[idx] = cleanEntry;
                else assignments[idx] = { field: cleanEntry.field, sport: cleanEntry.sport, _activity: cleanEntry._activity, continuation: true };
            });
            window._postEditInProgress = false;
            _peiUndoStack.pop(); // remove the snapshot we just pushed
            if (typeof peiShowBanner === 'function') peiShowBanner('Cannot move there — those slots are occupied', 'error', true);
            if (typeof window.updateTable === 'function') window.updateTable(); // snap the block back to its original position
            return;
        }

        // Make sure first written slot is the primary (non-continuation)
        const firstWritten = newSlotIndices.find(idx => assignments[idx] && assignments[idx]._postEdited);
        if (firstWritten !== undefined && assignments[firstWritten]) {
            assignments[firstWritten] = Object.assign({}, cleanEntry, {
                continuation: false, _startMin: newStart, _endMin: newEnd, _blockStart: newStart, _postEdited: true
            });
        }

        // Seam-merge: drop boundary travel for adjacent same-zone blocks
        if (cleanEntry._travelZone) {
            newSlotIndices.forEach(idx => {
                const cur = assignments[idx], prev = assignments[idx - 1], next = assignments[idx + 1];
                if (cur && prev && prev._travelZone === cur._travelZone) { prev._travelPost = 0; cur._travelPre = 0; }
                if (cur && next && next._travelZone === cur._travelZone) { cur._travelPost = 0; next._travelPre = 0; }
            });
        }

        // Do NOT re-render — the drag already positioned the block correctly.
        // Re-rendering would snap it back to slot boundaries.
        // Only save the data. Delete/Add/Undo handle their own re-renders.
        // Save data without triggering re-render (DOM is already correct)
        peiSaveQuiet(bunk);
    }

    function peiApplyNewBlock(bunk, divName, startMin, endMin, activity, location) {
        const divSlots = window.divisionTimes?.[divName] || [];
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length);
        const assignments = window.scheduleAssignments[bunk];

        // Slice 4 audit fix — double-click Add was the easiest path to
        // plant a violation. Route through the manual gate.
        if (activity && activity !== 'Free' && typeof window.commitManualWriteIfLegal === 'function') {
            // Resolve slotIdx for the gate (first overlapping slot).
            let _firstIdx = -1;
            for (let i = 0; i < divSlots.length; i++) {
                if (divSlots[i].endMin > startMin && divSlots[i].startMin < endMin) { _firstIdx = i; break; }
            }
            const _check = window.commitManualWriteIfLegal(
                bunk, _firstIdx, activity, location, divName,
                startMin, endMin, { allowSoftOverride: false }
            );
            if (!_check.ok) {
                if (_check.soft && typeof window.confirm === 'function') {
                    if (!window.confirm('Heads up: ' + _check.reason + '.\n\nAdd anyway?')) return;
                } else if (!_check.soft) {
                    if (typeof peiShowBanner === 'function') {
                        peiShowBanner('Cannot add: ' + _check.reason, 'error');
                    } else {
                        console.warn('[peiApplyNewBlock] BLOCKED:', _check.reason);
                    }
                    return;
                }
            }
        }

        peiSnapshotBunk(bunk, `Add ${activity} at ${peiToLabel(startMin)}`);
        if (typeof window.markPostEditInProgress === 'function') {
            window.markPostEditInProgress();
        } else {
            window._postEditInProgress = true;
            window._postEditTimestamp = Date.now();
        }

        // Find slots that overlap with new block's time and are free
        const targetSlots = [];
        for (let i = 0; i < divSlots.length; i++) {
            const overlapStart = Math.max(startMin, divSlots[i].startMin);
            const overlapEnd = Math.min(endMin, divSlots[i].endMin);
            if (overlapEnd <= overlapStart) continue; // no overlap
            const existing = assignments[i];
            const isOccupied = existing && existing._activity &&
                existing._activity.toLowerCase() !== 'free' && !existing.continuation;
            if (!isOccupied) targetSlots.push(i);
        }

        if (targetSlots.length === 0) {
            debugLog('PEI: No free slots for', startMin, '-', endMin);
            _peiUndoStack.pop();
            window._postEditInProgress = false;
            peiShowBanner('No space available in that time range', 'error');
            return;
        }

        const fieldValue = location ? location + ' – ' + activity : activity;
        targetSlots.forEach((idx, i) => {
            assignments[idx] = {
                field: fieldValue, sport: activity, _activity: activity,
                continuation: i > 0, _fixed: true, _postEdited: true, _pinned: true,
                _startMin: startMin, _endMin: endMin, _blockStart: startMin
            };
        });

        // Inject visual block directly + remove the free gap
        peiInjectActivityBlock(bunk, divName, startMin, endMin, activity, location);
        // Re-scan gaps in this column (the added block fills a gap)
        const dc = peiGetDivConfig(divName);
        const dayStart = peiParseTime(dc.startTime) || 540;
        const dayEnd = peiParseTime(dc.endTime) || 960;
        const bunkIdx = (dc.bunks || []).indexOf(bunk);
        if (bunkIdx >= 0) {
            const wrap = Array.from(document.querySelectorAll('.asg-wrap')).find(w => {
                const h = w.querySelector('.asg-header-title');
                return h && h.textContent.trim() === divName;
            });
            if (wrap) {
                const found = peiFindBunkContainer(wrap, bunk, bunkIdx);
                if (found) setTimeout(() => peiScanAndInjectGaps(found.blockContainer, bunk, divName, dayStart, dayEnd), 600);
            }
        }

        peiSaveQuiet(bunk);
        window._postEditInProgress = false;
    }

    /**
     * Inject a visual activity block into the DOM at a specific time position.
     * Used when adding activities into gaps created by resizing.
     */
    function peiInjectActivityBlock(bunk, divName, startMin, endMin, activity, location) {
        const divConfig = peiGetDivConfig(divName);
        const dayStart = peiParseTime(divConfig.startTime) || 540;
        const bunks = divConfig.bunks || [];
        const bunkIdx = bunks.indexOf(bunk);
        if (bunkIdx < 0) return;

        // Find the bunk container (column in legacy, row in transposed)
        const wrap = Array.from(document.querySelectorAll('.asg-wrap')).find(w => {
            const h = w.querySelector('.asg-header-title');
            return h && h.textContent.trim() === divName;
        });
        if (!wrap) return;
        const found = peiFindBunkContainer(wrap, bunk, bunkIdx);
        if (!found) return;
        const col = found.blockContainer;

        const topPx = (startMin - dayStart) * PEI_PX_PER_MIN + 2;
        const heightPx = (endMin - startMin) * PEI_PX_PER_MIN - 4;
        const dur = endMin - startMin;

        const blk = document.createElement('div');
        blk.className = 'asg-block pei-injected-block';
        blk.style.cssText = `position:absolute;top:${topPx}px;left:3px;right:3px;height:${heightPx}px;background:#d1fae5;border:1px solid #6ee7b7;color:#065f46;border-radius:5px;overflow:visible;display:flex;flex-direction:column;justify-content:center;padding:3px 6px;box-sizing:border-box;cursor:grab;z-index:1;`;
        blk.dataset.peiBunk = bunk;
        blk.dataset.peiStartMin = startMin;
        blk.dataset.peiEndMin = endMin;
        blk.dataset.peiDivision = divName;
        blk.dataset.peiField = location || '';
        blk.dataset.peiActivity = activity;
        blk.dataset.peiSlotIdx = '-1'; // sub-entry, no direct slot

        // Content
        if (heightPx >= 35) {
            const nameEl = document.createElement('div');
            nameEl.className = 'asg-block-name';
            nameEl.style.cssText = 'font-size:0.68rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nameEl.textContent = activity;
            blk.appendChild(nameEl);
            if (location && location !== activity) {
                const subEl = document.createElement('div');
                subEl.className = 'asg-block-sub';
                subEl.style.cssText = 'font-size:0.58rem;opacity:0.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                subEl.textContent = location;
                blk.appendChild(subEl);
            }
            const durEl = document.createElement('div');
            durEl.className = 'asg-block-sub';
            durEl.style.cssText = 'font-size:0.58rem;opacity:0.72;';
            durEl.textContent = dur + 'min';
            blk.appendChild(durEl);
        } else {
            blk.textContent = activity;
            blk.style.fontSize = '0.63rem';
            blk.style.fontWeight = '700';
        }
        blk.title = activity + '\n' + peiToLabel(startMin) + ' – ' + peiToLabel(endMin) + ' (' + dur + 'min)';

        col.appendChild(blk);
        debugLog('PEI: Injected activity block', activity, 'at', peiToLabel(startMin), '-', peiToLabel(endMin));
    }

    function peiTriggerReRender() {
        // Clean up injected elements (re-render creates proper ones)
        document.querySelectorAll('.pei-injected-free, .pei-injected-block').forEach(el => el.remove());
        // Clear augmented flags so observer re-augments after render
        document.querySelectorAll('.asg-wrap[data-pei-augmented]').forEach(w => delete w.dataset.peiAugmented);
        if (window.UnifiedScheduleSystem?.renderStaggeredView) window.UnifiedScheduleSystem.renderStaggeredView();
        else if (window.updateTable) window.updateTable();
        // Re-augment + fix custom positions after render completes
        setTimeout(() => {
            peiAugmentGrid();
            peiReapplyCustomPositions();
            window._postEditInProgress = false;
        }, 300);
    }

    /**
     * After a full re-render, the grid renderer positions blocks at slot boundaries.
     * This fixup pass finds any entries with _postEdited + custom _startMin/_endMin
     * and repositions their DOM blocks to match the user's custom sizing.
     * Also injects free-gap "+" buttons for any freed space.
     */
    function peiReapplyCustomPositions() {
        const wraps = document.querySelectorAll('.asg-wrap[data-pei-augmented="1"]');
        wraps.forEach(wrap => {
            const header = wrap.querySelector('.asg-header-title');
            const divName = header ? header.textContent.trim() : '';
            if (!divName) return;
            const divConfig = peiGetDivConfig(divName);
            const dayStart = peiParseTime(divConfig.startTime) || 540;
            const dayEnd = peiParseTime(divConfig.endTime) || 960;
            const totalMin = dayEnd - dayStart;
            const bunks = divConfig.bunks || [];
            const divSlots = window.divisionTimes?.[divName] || [];
            const isTransposed = !!wrap.querySelector('.asg-tx-scroll');

            bunks.forEach((bunk, idx) => {
                const found = peiFindBunkContainer(wrap, bunk, idx);
                if (!found) return;
                const bunkActs = peiBunkActivities(bunk, divName);
                const blockSel = isTransposed ? '.asg-tx-block' : '.asg-block';
                const blocks = found.blockContainer.querySelectorAll(blockSel);

                blocks.forEach((blk, bi) => {
                    const matched = bunkActs[bi];
                    if (!matched) return;
                    const entry = matched.entry;
                    if (!entry._postEdited || entry._startMin === undefined || entry._endMin === undefined) return;

                    const slotStart = matched.startMin;
                    const slotEnd = matched.endMin;
                    const customStart = entry._startMin;
                    const customEnd = entry._endMin;

                    if (customStart !== slotStart || customEnd !== slotEnd) {
                        if (isTransposed) {
                            // Transposed: horizontal layout — use left/width percentages
                            const pctL = ((customStart - dayStart) / totalMin) * 100;
                            const pctW = ((customEnd - customStart) / totalMin) * 100;
                            blk.style.left = pctL + '%';
                            blk.style.width = 'calc(' + pctW + '% - 2px)';
                        } else {
                            // Legacy: vertical layout — use top/height pixels
                            const newTopPx = (customStart - dayStart) * PEI_PX_PER_MIN + 2;
                            const newHeightPx = (customEnd - customStart) * PEI_PX_PER_MIN - 4;
                            blk.style.top = newTopPx + 'px';
                            blk.style.height = newHeightPx + 'px';
                        }

                        blk.dataset.peiStartMin = customStart;
                        blk.dataset.peiEndMin = customEnd;

                        const dur = customEnd - customStart;
                        const subSel = isTransposed ? '.asg-tx-block-sub' : '.asg-block-sub';
                        const allSubs = blk.querySelectorAll(subSel);
                        for (const sub of allSubs) {
                            if (/\d+min/.test(sub.textContent)) { sub.textContent = dur + 'min'; break; }
                        }

                        if (customEnd < slotEnd && (slotEnd - customEnd) >= PEI_MIN_BLOCK_DURATION) {
                            peiInjectFreeGapDirect(found.blockContainer, customEnd, slotEnd, dayStart, bunk, divName);
                        }
                        if (customStart > slotStart && (customStart - slotStart) >= PEI_MIN_BLOCK_DURATION) {
                            peiInjectFreeGapDirect(found.blockContainer, slotStart, customStart, dayStart, bunk, divName);
                        }
                    }
                });
            });
        });
        debugLog('Custom positions re-applied after re-render');
    }

    function peiSave(bunk) {
        // Full save — may trigger re-render. Use for delete/undo/add.
        // Slice 4 audit R-1 — markPostEditInProgress (cancelable timer)
        // replaces the legacy uncancelable setTimeout.
        if (typeof window.markPostEditInProgress === 'function') {
            window.markPostEditInProgress(4000);
        } else {
            window._postEditInProgress = true;
        }
        if (typeof window.resolveAndSaveSchedule === 'function') window.resolveAndSaveSchedule(bunk);
        else if (typeof bypassSaveAllBunks === 'function') bypassSaveAllBunks([bunk]);
        else if (window.ScheduleDB?.saveBunkSchedule) {
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            window.ScheduleDB.saveBunkSchedule(dateKey, bunk, window.scheduleAssignments[bunk]);
        }
        peiUpdateRotationHistory(bunk);
    }

    /**
     * Save data to localStorage + cloud WITHOUT triggering re-render.
     * Used for resize/move where the DOM is already visually correct.
     */
    function peiSaveQuiet(bunk) {
        // Slice 4 audit R-1 — peiSaveQuiet fires on every drag-resize / move.
        // The legacy 4s uncancelable setTimeout raced badly: a second drag
        // within 4s would fire the first drag's stale timer mid-second-edit.
        // markPostEditInProgress's cancelable pattern is the correct form.
        if (typeof window.markPostEditInProgress === 'function') {
            window.markPostEditInProgress(4000);
        } else {
            window._postEditInProgress = true;
        }
        const dateKey = window.currentScheduleDate || window.currentDate ||
            document.getElementById('datePicker')?.value || new Date().toISOString().split('T')[0];
        // Save to localStorage
        try {
            // ★ CB-52: removed the write-only `scheduleAssignments_${dateKey}` and
            // `campDailyData_v1_${dateKey}` mirrors (never read anywhere) — only the canonical
            // campDailyData_v1 map below is read. Drops two redundant per-edit quota writes.
            const allDaily = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDaily[dateKey]) allDaily[dateKey] = {};
            allDaily[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDaily[dateKey]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDaily));
        } catch (e) { debugLog('peiSaveQuiet localStorage error:', e); }
        // Cloud save (fire and forget — no re-render)
        if (window.ScheduleDB?.saveBunkSchedule) {
            window.ScheduleDB.saveBunkSchedule(dateKey, bunk, window.scheduleAssignments[bunk]);
        } else {
            window.saveSchedule?.();
        }
        peiUpdateRotationHistory(bunk);
        // No setTimeout needed — markPostEditInProgress's cancelable timer
        // (set at the top of this function) handles the clear.
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
            // historicalCounts are already updated synchronously by
            // SchedulerCoreUtils.applyPostEditCounts (called from submitEdit).
            // The previous setTimeout(reIncrement) here ran on top of that delta
            // with a stale "old" snapshot (post-save allDaily), which silently
            // double-corrupted the count. Removed — applyPostEditCounts is the
            // single source of truth for post-edit count deltas.
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
            if (!divName) { wrap.dataset.peiAugmented = '1'; return; }
            const divConfig = peiGetDivConfig(divName);
            const dayStart = peiParseTime(divConfig.startTime) || 540;
            const bunks = divConfig.bunks || [];

            // Detect transposed view (.asg-tx-scroll) vs legacy (.asg-scroll)
            const isTransposed = !!wrap.querySelector('.asg-tx-scroll');
            const scrollEl = wrap.querySelector('.asg-tx-scroll') || wrap.querySelector('.asg-scroll');
            if (!scrollEl) { wrap.dataset.peiAugmented = '1'; return; }

            if (isTransposed) {
                // ── Transposed view: rows = bunks, each row has .asg-tx-bunk + .asg-tx-strip ──
                const rows = scrollEl.querySelectorAll('.asg-tx-row:not(.asg-tx-headrow)');
                rows.forEach((row) => {
                    const bunkEl = row.querySelector('.asg-tx-bunk');
                    const strip = row.querySelector('.asg-tx-strip');
                    if (!bunkEl || !strip) return;
                    const bunk = bunkEl.textContent.trim();
                    if (!bunk) return;
                    row.dataset.peiBunk = bunk; row.dataset.peiDivision = divName;

                    // Add "+" buttons to free blocks
                    if (canEditBunk(bunk)) {
                        strip.querySelectorAll('.asg-tx-free').forEach(freeEl => {
                            if (freeEl.querySelector('.pei-add-btn')) return;
                            const addBtn = document.createElement('div');
                            addBtn.className = 'pei-add-btn';
                            addBtn.innerHTML = '+';
                            addBtn.title = 'Add activity here';
                            addBtn.style.cssText = 'width:26px;height:26px;border-radius:50%;background:rgba(37,99,235,0.1);color:#2563eb;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.2s,background 0.2s,transform 0.15s;z-index:4;pointer-events:auto;';
                            freeEl.appendChild(addBtn);
                            freeEl.addEventListener('mouseenter', () => { addBtn.style.opacity = '1'; });
                            freeEl.addEventListener('mouseleave', () => { addBtn.style.opacity = '0'; });
                            addBtn.addEventListener('mouseenter', () => { addBtn.style.background = 'rgba(37,99,235,0.2)'; });
                            addBtn.addEventListener('mouseleave', () => { addBtn.style.background = 'rgba(37,99,235,0.1)'; });
                            addBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                peiHandleDoubleClickAdd(row, e);
                            });
                        });
                    }
                    const bunkActs = peiBunkActivities(bunk, divName);
                    const blocks = strip.querySelectorAll('.asg-tx-block');
                    blocks.forEach((blk, bi) => {
                        const matched = bunkActs[bi];
                        if (!matched) return;
                        blk.dataset.peiBunk = bunk; blk.dataset.peiStartMin = matched.startMin; blk.dataset.peiEndMin = matched.endMin;
                        blk.dataset.peiSlotIdx = matched.slotIdx; blk.dataset.peiDivision = divName;
                        blk.dataset.peiField = matched.entry.field || ''; blk.dataset.peiActivity = matched.entry._activity || '';
                        if (!canEditBunk(bunk)) { blk.style.cursor = 'not-allowed'; return; }
                        blk.style.cursor = 'grab';

                        // Resize handles — left/right for transposed (horizontal) layout
                        const leftH = document.createElement('div'); leftH.className = 'pei-resize-handle pei-resize-top';
                        leftH.style.cssText = 'position:absolute;top:0;left:0;bottom:0;width:6px;cursor:w-resize;z-index:10;opacity:0;transition:opacity 0.15s;border-radius:5px 0 0 5px;';
                        blk.appendChild(leftH);
                        const rightH = document.createElement('div'); rightH.className = 'pei-resize-handle pei-resize-bottom';
                        rightH.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:6px;cursor:e-resize;z-index:10;opacity:0;transition:opacity 0.15s;border-radius:0 5px 5px 0;';
                        blk.appendChild(rightH);
                        blk.addEventListener('mouseenter', () => { if (!_peiResizing && !_peiMoving) { leftH.style.opacity = '1'; rightH.style.opacity = '1'; } });
                        blk.addEventListener('mouseleave', () => { if (!_peiResizing && !_peiMoving) { leftH.style.opacity = '0'; rightH.style.opacity = '0'; } });
                        leftH.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); peiStartResize(blk, 'top', e); });
                        rightH.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); peiStartResize(blk, 'bottom', e); });
                        blk.addEventListener('mousedown', e => {
                            if (e.target.classList.contains('pei-resize-handle') || e.target.classList.contains('pei-resize-top') || e.target.classList.contains('pei-resize-bottom')) return;
                            if (e.button !== 0) return;
                            _peiPendingMove = { block: blk, startX: e.clientX, startY: e.clientY, started: false };
                            document.addEventListener('mousemove', peiOnPendingMoveCheck);
                            document.addEventListener('mouseup', peiOnPendingMoveCancel);
                        });
                    });
                });
            } else {
                // ── Legacy view: columns = bunks ──
                const firstBlock = scrollEl.querySelector('.asg-block') || scrollEl.querySelector('.asg-free');
                if (!firstBlock) { debugLog('PEI: No blocks found in', divName); wrap.dataset.peiAugmented = '1'; return; }
                const bodyRow = firstBlock.parentElement.parentElement;
                const bunkCols = Array.from(bodyRow.children).slice(0, bunks.length);
                if (bunkCols.length !== bunks.length) { debugLog('PEI: column mismatch', bunkCols.length, bunks.length); wrap.dataset.peiAugmented = '1'; return; }

                bunkCols.forEach((col, idx) => {
                    const bunk = bunks[idx];
                    if (!bunk) return;
                    col.dataset.peiBunk = bunk; col.dataset.peiDivision = divName;

                    // Add "+" buttons to free blocks
                    if (canEditBunk(bunk)) {
                        col.querySelectorAll('.asg-free').forEach(freeEl => {
                            if (freeEl.querySelector('.pei-add-btn')) return;
                            const addBtn = document.createElement('div');
                            addBtn.className = 'pei-add-btn';
                            addBtn.innerHTML = '+';
                            addBtn.title = 'Add activity here';
                            addBtn.style.cssText = 'width:26px;height:26px;border-radius:50%;background:rgba(37,99,235,0.1);color:#2563eb;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.2s,background 0.2s,transform 0.15s;z-index:4;pointer-events:auto;';
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
                    blocks.forEach((blk, bi) => {
                        const matched = bunkActs[bi];
                        if (!matched) return;
                        blk.dataset.peiBunk = bunk; blk.dataset.peiStartMin = matched.startMin; blk.dataset.peiEndMin = matched.endMin;
                        blk.dataset.peiSlotIdx = matched.slotIdx; blk.dataset.peiDivision = divName;
                        blk.dataset.peiField = matched.entry.field || ''; blk.dataset.peiActivity = matched.entry._activity || '';
                        if (!canEditBunk(bunk)) { blk.style.cursor = 'not-allowed'; return; }
                        blk.style.cursor = 'grab';
                        blk.style.overflow = 'visible';

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
            }
            wrap.dataset.peiAugmented = '1';
        });
    }

    // ── Touch ──
    function peiSetupTouch() {
        if (window.MobileTouchDrag) return;
        document.addEventListener('touchstart', (e) => {
            const target = e.target;
            if (target.classList.contains('pei-resize-handle')) { e.preventDefault(); const block = target.closest('.asg-block, .asg-tx-block'); if (!block) return; peiStartResize(block, target.classList.contains('pei-resize-top') ? 'top' : 'bottom', { clientY: e.touches[0].clientY, preventDefault() {} }); return; }
            const block = target.closest('.asg-block[data-pei-bunk], .asg-tx-block[data-pei-bunk]');
            if (block) { const sy = e.touches[0].clientY; block._peiLP = setTimeout(() => { peiStartMove(block, { clientY: sy, preventDefault() {} }); if (navigator.vibrate) navigator.vibrate(30); }, PEI_LONG_PRESS_MS); block._peiTS = { x: e.touches[0].clientX, y: sy }; }
        }, { passive: false });
        document.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            document.querySelectorAll('.asg-block[data-pei-bunk], .asg-tx-block[data-pei-bunk]').forEach(b => { if (b._peiLP && b._peiTS && Math.sqrt((t.clientX - b._peiTS.x) ** 2 + (t.clientY - b._peiTS.y) ** 2) > 10) { clearTimeout(b._peiLP); b._peiLP = null; } });
            if (_peiResizing) { e.preventDefault(); peiOnResizeMove({ clientX: t.clientX, clientY: t.clientY }); }
            if (_peiMoving) { e.preventDefault(); peiOnMoveMove({ clientX: t.clientX, clientY: t.clientY }); }
        }, { passive: false });
        document.addEventListener('touchend', (e) => {
            document.querySelectorAll('.asg-block[data-pei-bunk], .asg-tx-block[data-pei-bunk]').forEach(b => { if (b._peiLP) { clearTimeout(b._peiLP); b._peiLP = null; } });
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
        s.textContent = `.pei-resize-handle{touch-action:none;background:transparent;}.pei-resize-handle:hover{background:rgba(59,130,246,0.4)!important;}@media(pointer:coarse){.pei-resize-handle{height:12px!important;width:12px!important;opacity:.5!important}}.asg-block[data-pei-bunk],.asg-tx-block[data-pei-bunk]{touch-action:none;overflow:visible!important;transition:box-shadow 0.2s}.asg-block[data-pei-bunk]:active,.asg-tx-block[data-pei-bunk]:active{cursor:grabbing!important}.pei-conflict-overlay{pointer-events:none;animation:pei-pulse 1s ease-in-out infinite}@keyframes pei-pulse{0%,100%{opacity:.3}50%{opacity:.6}}@keyframes pei-slide-up{from{transform:translate(-50%,20px);opacity:0}to{transform:translate(-50%,0);opacity:1}}@keyframes pei-fade-in{from{opacity:0}to{opacity:1}}.asg-free,.asg-tx-free{cursor:default;position:relative;transition:border-color 0.2s}.asg-free:hover,.asg-tx-free:hover{border-color:#93c5fd!important;background:repeating-linear-gradient(45deg,#eff6ff,#eff6ff 4px,#dbeafe 4px,#dbeafe 8px)!important}.pei-add-btn{font-family:-apple-system,BlinkMacSystemFont,sans-serif;user-select:none;line-height:1;transition:transform 0.15s,opacity 0.2s,background 0.2s;}.pei-add-btn:hover{transform:scale(1.15)!important;box-shadow:0 2px 8px rgba(37,99,235,0.3);}[data-pei-bunk]:hover{background:rgba(59,130,246,.01)}`;
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

    // Bunk activity report — exposed so any edit modal (including the active
    // one in unified_schedule_system.js) can render the same panel. Builds its
    // own location/availability context from the time range.
    window.PostEditReport = {
        // opts.locations / opts.locationAvailMap let the caller pass a correctly
        // computed availability map (the unified editor knows the right per-bunk
        // slots); otherwise a best-effort context is built here.
        panelHtml(bunk, divName, startMin, endMin, selectedActivity, opts) {
            try {
                divName = divName || peiGetDivForBunk(bunk);
                const ctx = (opts && opts.locationAvailMap) ? opts : _reportBuildContext(bunk, startMin, endMin);
                _reportScheduleCloudHydrate(bunk, divName, ctx, startMin, endMin);
                return _reportCardHtml(bunk, renderBunkReportBody(bunk, divName, ctx.locations, ctx.locationAvailMap, selectedActivity || '', startMin, endMin));
            } catch (e) { debugLog('PostEditReport.panelHtml error', e); return ''; }
        },
        bodyHtml(bunk, divName, startMin, endMin, selectedActivity, opts) {
            try {
                divName = divName || peiGetDivForBunk(bunk);
                const ctx = (opts && opts.locationAvailMap) ? opts : _reportBuildContext(bunk, startMin, endMin);
                return renderBunkReportBody(bunk, divName, ctx.locations, ctx.locationAvailMap, selectedActivity || '', startMin, endMin);
            } catch (e) { debugLog('PostEditReport.bodyHtml error', e); return ''; }
        }
    };

    // One-time delegation: clicking a suggestion fills the modal's activity
    // field (works for both the <input> and the unified <select>) and fires
    // input/change so the report + conflict UI refresh.
    if (!window.__peSuggestWired) {
        window.__peSuggestWired = true;
        document.addEventListener('click', (e) => {
            const btn = e.target.closest && e.target.closest('.pe-suggest-btn');
            if (!btn) return;
            e.preventDefault(); e.stopPropagation();
            const act = btn.getAttribute('data-activity');
            const input = document.getElementById('post-edit-activity');
            if (!act || !input) return;
            input.value = act;
            if (input.tagName === 'SELECT' && input.value !== act) {
                const opt = document.createElement('option');
                opt.value = act; opt.textContent = act;
                input.appendChild(opt); input.value = act;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            try { input.focus(); } catch (_) { }
        }, true);
    }

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
        reapplyCustomPositions: peiReapplyCustomPositions,
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
