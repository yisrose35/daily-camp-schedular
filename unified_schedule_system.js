// =============================================================================
// unified_schedule_system.js v4.1.0 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
// =============================================================================
//
// This file REPLACES ALL of the following:
// [REMOVED] scheduler_ui.js
// [REMOVED] render_sync_fix.js
// [REMOVED] view_schedule_loader_fix.js
// [REMOVED] schedule_version_merger.js
// [REMOVED] schedule_version_ui.js
// [REMOVED] post_generation_edit_system.js (NOW INTEGRATED)
// [REMOVED] pinned_activity_preservation.js (NOW INTEGRATED)
//
// CRITICAL FIXES & FEATURES:
// v4.0.2: CROSS-DIVISION BYPASS SAVE - updates correct scheduler records directly
// v4.0.3: INTEGRATED EDIT SYSTEM with multi-bunk support
// v4.0.3: CASCADE RESOLUTION for field priority claims
// v4.0.3: PROPOSAL SYSTEM for cross-division changes
// v4.0.3: AUTO-BACKUP before complex operations
// v4.0.4: DIVISION TIMES SUPPORT in time mapping utilities
// v4.0.5: REFACTOR - Core utilities moved to Shared Utils
// v4.1.0: FULL DIVISIONTIMES INTEGRATION
//            - Removed window.unifiedTimes dependency
//            - All slot lookups now use window.divisionTimes via SchedulerCoreUtils
//            - Time-based field usage is canonical conflict detection
//            - Data persistence uses divisionTimes directly
//
// =============================================================================

(function() {
    'use strict';

    console.log('[Schedule] Unified Schedule System v4.1.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const RENDER_DEBOUNCE_MS = 150;
    let DEBUG = false;
    const HIDE_VERSION_TOOLBAR = true;
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";
    
    // v4.0.3 New Configs
    const CLAIM_MODAL_ID = 'field-claim-modal';
    const CLAIM_OVERLAY_ID = 'field-claim-overlay';
    const INTEGRATED_EDIT_MODAL_ID = 'integrated-edit-modal';
    const INTEGRATED_EDIT_OVERLAY_ID = 'integrated-edit-overlay';
    const PROPOSAL_MODAL_ID = 'proposal-review-modal';
    const AUTO_BACKUP_PREFIX = 'Auto-backup before';
    const MAX_AUTO_BACKUPS_PER_DATE = 10;
    
    let _lastRenderTime = 0;
    let _renderQueued = false;
    let _renderTimeout = null;
    let _initialized = false;
    let _cloudHydrated = false;

    // v4.0.3 State
    let _pendingProposals = [];
    let _claimInProgress = false;
    let _currentEditContext = null;
    let _multiBunkEditContext = null;
    let _multiBunkPreviewResult = null;
    let _lastPreviewResult = null;

    // =========================================================================
    // UTILITY ALIASES (from SchedulerCoreUtils)
    // =========================================================================
    
    const Utils = () => window.SchedulerCoreUtils || {};
    
    function getDivisionForBunk(bunk) {
        return Utils()?.getDivisionForBunk?.(bunk) || window.getDivisionForBunk?.(bunk);
    }
    
    function getSlotsForDivision(divName) {
        return Utils()?.getSlotsForDivision?.(divName) || window.divisionTimes?.[divName] || [];
    }
    
    function findSlotsForRange(startMin, endMin, divisionOrBunk, bunkName) {
    return Utils()?.findSlotsForRange?.(startMin, endMin, divisionOrBunk, bunkName) || [];
}
    
    function getEntryForBlock(bunk, startMin, endMin) {
        return Utils()?.getEntryForBlock?.(bunk, startMin, endMin) || { entry: null, slotIdx: -1 };
    }
    
    function getSlotTimeRange(slotIdx, bunkOrDiv) {
        return Utils()?.getSlotTimeRange?.(slotIdx, bunkOrDiv) || { startMin: null, endMin: null };
    }
    
    function parseTimeToMinutes(str) {
        return Utils()?.parseTimeToMinutes?.(str) || window.DivisionTimesSystem?.parseTimeToMinutes?.(str);
    }
    
    function minutesToTimeLabel(mins) {
        return Utils()?.minutesToTimeLabel?.(mins) || window.DivisionTimesSystem?.minutesToTimeLabel?.(mins);
    }
    
    function fieldLabel(f) {
        return Utils()?.fieldLabel?.(f) || (typeof f === 'string' ? f : f?.name || '');
    }
    
    function getActivityProperties() {
        return Utils()?.getActivityProperties?.() || window.activityProperties || {};
    }
    
    function getBunksForDivision(divName) {
        return Utils()?.getBunksForDivision?.(divName) || window.divisions?.[divName]?.bunks || [];
    }
    
    function getMyDivisions() {
        return Utils()?.getMyDivisions?.() || window.AccessControl?.getEditableDivisions?.() || Object.keys(window.divisions || {});
    }

    // =========================================================================
    // Slice 4 audit fix — centralized post-edit-in-progress marker.
    // =========================================================================
    // Earlier this was hand-rolled at 4+ sites; some used the cancelable
    // clearTimer pattern, some used a stale uncancelable setTimeout. The
    // legacy uncancelable form raced with the new form and cleared the
    // flag mid-edit on the second edit, exposing the in-flight window to
    // remote sync. Centralized so every caller gets the safe pattern.
    let _postEditWindowMs = 8000;
    function markPostEditInProgress(ms) {
        const d = (typeof ms === 'number' && ms > 0) ? ms : _postEditWindowMs;
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        if (window._postEditClearTimer) clearTimeout(window._postEditClearTimer);
        window._postEditClearTimer = setTimeout(function () {
            window._postEditInProgress = false;
            window._postEditClearTimer = null;
        }, d);
    }
    window.markPostEditInProgress = markPostEditInProgress;

    // =========================================================================
    // Slice 4 audit fix — manual-side legality gate.
    // =========================================================================
    // The auto pipeline has `AutoSolverEngine.commitWriteIfLegal` as its
    // single trust point. The manual side had no equivalent — 17 direct
    // `scheduleAssignments[bunk][i] = …` writes across this file and
    // post_edit_system.js, none of which checked access restrictions,
    // disabledSports for the day, activity-in-field-list for the grade,
    // sharing rules, FieldCombos exclusivity, or cooldown rules. A user
    // could click a cell and plant a violation that the auto pipeline
    // would then preserve via `_pinned`.
    //
    // This helper is the manual-side trust point. It returns:
    //   { ok: true }                   — legal, caller may write
    //   { ok: false, reason: "...", soft: true|false }
    //                                  — illegal. soft=true means caller
    //                                  may surface a confirm prompt and
    //                                  proceed if the user explicitly
    //                                  overrides (e.g. for cooldown
    //                                  reasons the user knows about).
    //                                  soft=false is a hard reject.
    //
    // Callers must pass: bunk, slotIdx, activity, location, grade,
    //                    startMin, endMin, opts:{ allowSoftOverride, forceClear }.
    function commitManualWriteIfLegal(bunk, slotIdx, activity, location, grade, startMin, endMin, opts) {
        opts = opts || {};
        try {
            // Free writes are exempt from rule gates (they release a slot).
            if (opts.forceClear || activity === 'Free' || !activity) {
                return { ok: true };
            }

            // Slice 4 audit R-4 — build a Set of every slot index this
            // write occupies so the template builder below can skip all
            // of them, not just the first. Earlier the builder skipped
            // only `ti === slotIdx`, so a multi-slot write that included
            // an old Lunch at slot+1 falsely templated that Lunch as
            // active and triggered a cooldown false-positive.
            const _skipSlotIndices = new Set();
            _skipSlotIndices.add(slotIdx);
            if (Array.isArray(opts.slotRange)) {
                opts.slotRange.forEach(function (i) { _skipSlotIndices.add(i); });
            }
            const gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
            const fields = (gs.app1 && gs.app1.fields) || [];
            const specials = (gs.app1 && gs.app1.specialActivities) || (window.getAllSpecialActivities ? window.getAllSpecialActivities() : []);
            const fld = location ? fields.find(function (f) { return f && f.name === location; }) : null;
            const spByName = activity ? specials.find(function (s) { return s && s.name === activity; }) : null;
            const gradeKey = grade != null ? String(grade) : null;

            // 1. Field-level access restriction (dual-key).
            if (fld && fld.accessRestrictions && fld.accessRestrictions.enabled) {
                const divs = fld.accessRestrictions.divisions || {};
                if (gradeKey != null && !(gradeKey in divs) && !(grade in divs)) {
                    return { ok: false, soft: false, reason: 'Field ' + location + ' is not allowed for ' + grade };
                }
                const bunkList = divs[gradeKey] || divs[grade];
                if (Array.isArray(bunkList) && bunkList.length > 0
                    && !bunkList.map(String).includes(String(bunk))) {
                    return { ok: false, soft: false, reason: 'Bunk ' + bunk + ' is not in the allowed list for ' + location };
                }
            }

            // 2. Special-level access restriction (when activity is a special).
            if (spByName && spByName.accessRestrictions && spByName.accessRestrictions.enabled) {
                const divs = spByName.accessRestrictions.divisions || {};
                if (gradeKey != null && !(gradeKey in divs) && !(grade in divs)) {
                    return { ok: false, soft: false, reason: 'Special ' + activity + ' is not allowed for ' + grade };
                }
                const bunkList = divs[gradeKey] || divs[grade];
                if (Array.isArray(bunkList) && bunkList.length > 0
                    && !bunkList.map(String).includes(String(bunk))) {
                    return { ok: false, soft: false, reason: 'Bunk ' + bunk + ' is not in the allowed list for ' + activity };
                }
            }

            // 3. Field's per-grade time rules.
            if (fld && Array.isArray(fld.timeRules) && fld.timeRules.length > 0
                && startMin != null && endMin != null) {
                let hasGradeAvail = false, insideAvail = false;
                for (let ri = 0; ri < fld.timeRules.length; ri++) {
                    const r = fld.timeRules[ri];
                    const t = String(r.type || '').toLowerCase();
                    const isUnavail = t === 'unavailable' || r.available === false;
                    const isAvail = t === 'available' || r.available === true;
                    const rs = r.startMin != null ? r.startMin : parseTimeToMinutes(r.start || r.startTime);
                    const re = r.endMin != null ? r.endMin : parseTimeToMinutes(r.end || r.endTime);
                    if (rs == null || re == null || (!isAvail && !isUnavail)) continue;
                    const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                    if (rDivs.length > 0 && gradeKey && !rDivs.includes(gradeKey)) continue;
                    if (isUnavail && rs < endMin && re > startMin) {
                        return { ok: false, soft: false, reason: 'Field ' + location + ' is Unavailable in this time window' };
                    }
                    if (isAvail) {
                        hasGradeAvail = true;
                        if (startMin >= rs && endMin <= re) insideAvail = true;
                    }
                }
                if (hasGradeAvail && !insideAvail) {
                    return { ok: false, soft: false, reason: 'Field ' + location + ' is outside its Available windows for ' + grade };
                }
            }

            // 4. Daily disabled fields / per-field disabled sports.
            const disabledFields = window.dailyDisabledFields
                || (window.currentDayOverrides && window.currentDayOverrides.disabledFields)
                || [];
            if (location && Array.isArray(disabledFields)
                && disabledFields.map(String).indexOf(String(location)) >= 0) {
                return { ok: false, soft: false, reason: 'Field ' + location + ' is disabled for today' };
            }
            const dsByField = window.dailyDisabledSportsByField || {};
            const ds = location ? dsByField[location] : null;
            if (ds && activity) {
                const blocked = (typeof ds.has === 'function') ? ds.has(activity)
                              : (Array.isArray(ds) ? ds.indexOf(activity) >= 0 : false);
                if (blocked) {
                    return { ok: false, soft: false, reason: activity + ' is disabled on ' + location + ' for today' };
                }
            }

            // 5. activity must be in field.activities when the field's activity list is non-empty.
            if (fld && Array.isArray(fld.activities) && fld.activities.length > 0 && activity
                && !spByName) {
                const want = String(activity).toLowerCase();
                const inList = fld.activities.some(function (a) { return String(a).toLowerCase() === want; });
                if (!inList) {
                    return { ok: false, soft: false, reason: activity + ' is not configured for ' + location };
                }
            }

            // 6a. FieldCombos exclusivity — HARD. Two fields can't be
            // physically used at once when they share space (e.g. Full
            // Gym + Gym 1 + Gym 2). Earlier the SchedulingRules call
            // below classified this with cooldowns under SOFT, letting
            // the user confirm-through and double-book a physical
            // court. Split out as a hard check.
            if (location && window.FieldCombos
                && typeof window.FieldCombos.isBlockedByCombo === 'function'
                && startMin != null && endMin != null) {
                try {
                    const _combo = window.FieldCombos.isBlockedByCombo(location, startMin, endMin, bunk);
                    if (_combo && _combo.blocked) {
                        return {
                            ok: false, soft: false,
                            reason: 'Field ' + location + ' conflicts with ' + (_combo.blockingField || 'a combined field') + ' (FieldCombos)'
                        };
                    }
                } catch (_) {}
            }

            // 6b. Cooldown / other SchedulingRules — SOFT (user may want to
            // override). Note: FieldCombos exclusivity is now handled above
            // as a hard violation; remaining checks here are cooldowns and
            // any other user-configurable rule.
            if (window.SchedulingRules && window.SchedulingRules.isCandidateAllowed
                && startMin != null && endMin != null) {
                const cand = {
                    startMin: startMin, endMin: endMin,
                    type: spByName ? 'special' : 'sport',
                    event: activity || '',
                    field: location || ''
                };
                const existing = (window.scheduleAssignments && window.scheduleAssignments[String(bunk)]) || [];
                const template = [];
                for (let ti = 0; ti < existing.length; ti++) {
                    // Slice 4 audit R-4 — skip every slot index this write
                    // occupies, not just slotIdx, so a multi-slot write
                    // doesn't false-positive on its own pre-overwrite content.
                    if (_skipSlotIndices.has(ti)) continue;
                    const w = existing[ti];
                    if (!w || w.continuation) continue;
                    if (w._startMin == null || w._endMin == null) continue;
                    template.push({
                        startMin: w._startMin, endMin: w._endMin,
                        type: w.type || (w._assignedSpecial ? 'special' : (w.field === 'Free' ? 'free' : 'sport')),
                        event: w.event || w._activity || w.sport || '',
                        field: w.field
                    });
                }
                if (!window.SchedulingRules.isCandidateAllowed(cand, template, { mode: 'manual' })) {
                    return { ok: false, soft: true, reason: 'Violates a cooldown rule' };
                }
            }
        } catch (e) {
            // Never let a rule-engine bug block a legal write.
            try { console.warn('[commitManualWriteIfLegal] rule check failed (allowing write):', e && e.message); } catch (_) {}
        }
        return { ok: true };
    }
    window.commitManualWriteIfLegal = commitManualWriteIfLegal;

    function canEditBunk(bunk) {
        // *** FIX: Check initialization state and use fallback chain ***
        const role = window.AccessControl?.getCurrentRole?.();
        const isInitialized = window.AccessControl?.isInitialized;
        
        // If AccessControl exists but isn't initialized, or role is null/undefined, 
        // fall back to CampistryDB or allow by default
        if (window.AccessControl && (!isInitialized || !role)) {
            const fallbackRole = window.CampistryDB?.getRole?.() || 
                                 localStorage.getItem('campistry_role');
            if (fallbackRole === 'owner' || fallbackRole === 'admin') return true;
            // If still no role info, default to ALLOW (don't block the owner)
            if (!fallbackRole) return true;
        }
        
        // Owner/admin always can edit
        if (role === 'owner' || role === 'admin') return true;
        
        // Delegate to Utils if available
        if (Utils()?.canEditBunk) {
            return Utils().canEditBunk(bunk);
        }
        
        // Final fallback: check editable bunks
        const editableBunks = getEditableBunks();
        return editableBunks.has(String(bunk));
    }
    
    function getEditableBunks() {
        const editableBunks = new Set();
        const divisions = window.divisions || {};
        
        // *** FIX: Check initialization state before trusting AccessControl ***
        const isInitialized = window.AccessControl?.isInitialized;
        const role = window.AccessControl?.getCurrentRole?.();
        
        // Fallback role detection
        const effectiveRole = role || 
                              window.CampistryDB?.getRole?.() || 
                              localStorage.getItem('campistry_role');
        
        // If owner/admin (from any source), return all bunks
        if (effectiveRole === 'owner' || effectiveRole === 'admin') {
            Object.values(divisions).forEach(divInfo => {
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => editableBunks.add(String(b)));
                }
            });
            // Also include any bunks in scheduleAssignments
            Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(String(b)));
            return editableBunks;
        }
        
        // If AccessControl not initialized, default to allowing all (safe for owner)
        if (!window.AccessControl || !isInitialized) {
            Object.values(divisions).forEach(divInfo => {
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => editableBunks.add(String(b)));
                }
            });
            Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(String(b)));
            return editableBunks;
        }
        
        // AccessControl is initialized - use its editable divisions
        const editableDivisions = window.AccessControl.getEditableDivisions?.() || [];
        
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => editableBunks.add(String(b)));
            }
        }
        
        // If still empty and role unknown, default to allow (don't block owner)
        if (editableBunks.size === 0 && !role) {
            Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(String(b)));
        }
        
        return editableBunks;
    }

   

    // =========================================================================
// BYPASS CELL HIGHLIGHTING (Cell-specific, User-aware)
// =========================================================================

let _myBypassedCells = new Map();
const BYPASS_HIGHLIGHT_DURATION = 30000;

function markCellsAsBypassed(cellKeys) {
    const now = Date.now();
    cellKeys.forEach(key => _myBypassedCells.set(key, now));
    
    setTimeout(() => {
        const expireTime = Date.now() - BYPASS_HIGHLIGHT_DURATION;
        for (const [key, timestamp] of _myBypassedCells.entries()) {
            if (timestamp < expireTime) {
                _myBypassedCells.delete(key);
            }
        }
        if (typeof updateTable === 'function') updateTable();
    }, BYPASS_HIGHLIGHT_DURATION + 100);
}

function getCellBypassStatus(bunk, slotIdx) {
    const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
    const cellKey = `${bunk}:${slotIdx}`;
    const currentUserId = window.AccessControl?.getCurrentUserId?.();
    
    if (_myBypassedCells.has(cellKey)) {
        return { highlight: true, isMyBypass: true, bypassedByName: 'You' };
    }
    
    if (entry?._bypassModified && entry._bypassedBy && entry._bypassedBy !== currentUserId) {
        return { 
            highlight: true, 
            isMyBypass: false, 
            bypassedByName: entry._bypassedByName || 'Another scheduler'
        };
    }
    
    return { highlight: false, isMyBypass: false, bypassedByName: null };
}

function acknowledgeBypassChanges() {
    const currentUserId = window.AccessControl?.getCurrentUserId?.();
    const assignments = window.scheduleAssignments || {};
    let clearedCount = 0;
    
    for (const [bunk, slots] of Object.entries(assignments)) {
        if (!slots || !Array.isArray(slots)) continue;
        
        for (let i = 0; i < slots.length; i++) {
            const entry = slots[i];
            if (entry?._bypassModified && entry._bypassedBy !== currentUserId) {
                entry._bypassModified = false;
                entry._bypassAcknowledgedAt = Date.now();
                clearedCount++;
            }
        }
    }
    
    if (clearedCount > 0) {
        console.log(`[BypassHighlight] Acknowledged ${clearedCount} bypass changes`);
        window.saveSchedule?.();
        if (typeof updateTable === 'function') updateTable();
    }
    
    return clearedCount;
}

function clearMyBypassHighlights() {
    _myBypassedCells.clear();
    if (typeof updateTable === 'function') updateTable();
}

function enableBypassRBACView(bunks) {
    // Legacy - does nothing now
}

function disableBypassRBACView() {
    clearMyBypassHighlights();
}

    function shouldShowDivision(divName) {
    return true;
}

function shouldHighlightBunk(bunkName) {
    return false; // Now handled by getCellBypassStatus in renderBunkCell
}

    // =========================================================================
    // ROTATION CONFIGURATION (for smart regeneration)
    // =========================================================================
    
    // Use RotationEngine as single source of truth
    const ROTATION_CONFIG = new Proxy({}, {
        get: function(target, prop) {
            return window.RotationEngine?.CONFIG?.[prop] ?? {
                SAME_DAY_PENALTY: Infinity,
                YESTERDAY_PENALTY: 12000,
                TWO_DAYS_AGO_PENALTY: 8000,
                THREE_DAYS_AGO_PENALTY: 5000,
                FOUR_TO_SEVEN_DAYS_PENALTY: 800,
                WEEK_PLUS_PENALTY: 200,
                HIGH_FREQUENCY_PENALTY: 3000,
                ABOVE_AVERAGE_PENALTY: 1200,
                NEVER_DONE_BONUS: -5000,
                UNDER_UTILIZED_BONUS: -2000,
                ADJACENT_BUNK_BONUS: -100,
                NEARBY_BUNK_BONUS: -30
            }[prop];
        }
    });

    // =========================================================================
    // PINNED ACTIVITY STORAGE
    // =========================================================================
    
    let _pinnedSnapshot = {};
    let _pinnedFieldLocks = [];

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function debugLog(...args) {
        if (DEBUG) console.log('[UnifiedSchedule]', ...args);
    }

    // =========================================================================
    // HIDE VERSION TOOLBAR
    // =========================================================================
    
    function hideVersionToolbar() {
        if (!HIDE_VERSION_TOOLBAR) return;
        const toolbar = document.getElementById('version-toolbar-container');
        if (toolbar) {
            toolbar.style.display = 'none';
            const parent = toolbar.parentElement;
            if (parent && parent.children.length === 1) parent.style.display = 'none';
            debugLog('Hidden version toolbar');
        }
    }

    // =========================================================================
    // DATA LOADING - DIVISION TIMES AWARE
    // =========================================================================

    function getDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    function loadDailyData() {
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.error('[UnifiedSchedule] Error loading daily data:', e);
        }
        return {};
    }

    function loadScheduleForDate(dateKey) {
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] [GUARD] Skipping loadScheduleForDate - post-edit in progress');
            return;
        }
        if (!dateKey) dateKey = getDateKey();
        debugLog(`Loading data for: ${dateKey}`);
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey] || {};
        
        // Load schedule assignments
        // ★ v2: Prefer DATE-SPECIFIC data over in-memory state. Previously,
        //   any non-empty window.scheduleAssignments short-circuited the load,
        //   which meant switching dates kept the previous date's schedule
        //   visible (in-memory shadowed cloud/local data for the new date).
        //   In-memory is now a last-resort fallback, not the first choice.
        let loadedAssignments = false;
        if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            window._scheduleAssignmentsDate = dateKey; // bind owner stamp to date-specific load (cross-date corruption guard)
            loadedAssignments = true;
        } else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dailyData.scheduleAssignments;
            window._scheduleAssignmentsDate = dateKey; // bind owner stamp to date-specific load (cross-date corruption guard)
            loadedAssignments = true;
        } else if (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0) {
            // No saved data for this date — keep whatever is in memory (last resort).
            loadedAssignments = true;
        }
        if (!loadedAssignments) window.scheduleAssignments = window.scheduleAssignments || {};

        // Phase 4: restore scheduleSegments (auto-builder segment data).
        // If absent on an older save, rebuild from assignments so the segment
        // store is always populated for segment-aware readers.
        if (dateData.scheduleSegments && Object.keys(dateData.scheduleSegments).length > 0) {
            window.scheduleSegments = dateData.scheduleSegments;
        } else if (dailyData.scheduleSegments && Object.keys(dailyData.scheduleSegments).length > 0) {
            window.scheduleSegments = dailyData.scheduleSegments;
        } else {
            try { window.AutoSegmentModel?.rebuildFromAssignments?.(); } catch (_e) {}
        }

        // Load league assignments
        if (!window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
            window.leagueAssignments = dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0 
                ? dateData.leagueAssignments : {};
        }
        
        // *** v4.1.0: LOAD DIVISION TIMES (PRIMARY) ***
        // ★ Date-switch fix: ALWAYS overwrite _perBunkSlots with the date's saved
        //   data. Previously the reattach gates were "only if empty", which meant
        //   switching dates kept the prior date's _perBunkSlots stale in memory
        //   and the new date's grid rendered whatever was left over.
        const cloudLoaded = window._divisionTimesFromCloud === true;
        const _reattachAll = () => {
            if (!window.divisionTimes) return;
            // ★ MODE ISOLATION (double-lunch fix): per-bunk geometry (_isPerBunk/_perBunkSlots)
            //   is an AUTO-mode construct (each bunk gets its own rotation grid). The MANUAL
            //   flat-table renders from the div-level slot array (divisionTimes[div]); if auto
            //   per-bunk slots drive it — leaked from an auto generation, or a saved
            //   _perBunkSlotsData restored here — the grid mis-maps activities onto the
            //   fine-grained per-bunk slots (whose windows cross the pinned Lunch boundary) and
            //   draws lunch in the wrong columns (looked like a DOUBLE LUNCH). Auto and manual
            //   display geometry must not contaminate each other: in MANUAL mode, strip any
            //   per-bunk geometry and never reattach it, so the render uses div-level slots.
            var _miMode = (window.getCampBuilderMode && window.getCampBuilderMode()) || window._daBuilderMode || 'manual';
            if (_miMode === 'manual') {
                Object.keys(window.divisionTimes).forEach(function (grade) {
                    if (window.divisionTimes[grade]) {
                        delete window.divisionTimes[grade]._perBunkSlots;
                        delete window.divisionTimes[grade]._isPerBunk;
                    }
                });
                return;
            }
            if (!dateData._perBunkSlotsData) return;
            // First, clear any stale _perBunkSlots from grades NOT in this date's data
            Object.keys(window.divisionTimes).forEach(grade => {
                if (!dateData._perBunkSlotsData[grade]) {
                    delete window.divisionTimes[grade]._perBunkSlots;
                    delete window.divisionTimes[grade]._isPerBunk;
                }
            });
            // Then apply this date's _perBunkSlots, overwriting whatever was there
            Object.keys(dateData._perBunkSlotsData).forEach(grade => {
                if (window.divisionTimes[grade]) {
                    window.divisionTimes[grade]._isPerBunk = true;
                    window.divisionTimes[grade]._perBunkSlots = dateData._perBunkSlotsData[grade];
                }
            });
        };

        // ★ Date-switch fix #2: realign scheduleAssignments[bunk][i] so that
        //   each entry's index matches the _perBunkSlots[bunk][i] time-window.
        //   Bug observed: after date round-trip, _perBunkSlots could have an
        //   extra leading 'pre-Swim' slot while scheduleAssignments was saved
        //   at the OLDER (1-shorter) shape — so assignments[0]=Swim landed at
        //   the new index-0 pre-slot, shifting every activity one position off.
        const _realignAssignmentsToSlots = () => {
            const dt = window.divisionTimes || {};
            const sa = window.scheduleAssignments || {};
            Object.keys(dt).forEach(grade => {
                const pbs = dt[grade]?._perBunkSlots;
                if (!pbs) return;
                Object.keys(pbs).forEach(bunk => {
                    const slots = pbs[bunk] || [];
                    const assigns = sa[bunk] || [];
                    if (!Array.isArray(slots) || !Array.isArray(assigns)) return;
                    if (assigns.length === 0) return;
                    // Build slot start-times array. Then walk assigns and place
                    // each at the matching-time index in a new array.
                    const realigned = new Array(slots.length).fill(null);
                    for (let i = 0; i < assigns.length; i++) {
                        const a = assigns[i];
                        if (!a) continue;
                        const t = a._startMin;
                        if (t == null) {
                            // No time info — keep at original index if it exists
                            if (i < realigned.length) realigned[i] = a;
                            continue;
                        }
                        // Find slot whose [startMin, endMin) contains t
                        let placed = false;
                        for (let j = 0; j < slots.length; j++) {
                            const s = slots[j];
                            if (s && s.startMin === t) {
                                realigned[j] = a;
                                placed = true;
                                break;
                            }
                        }
                        if (!placed) {
                            // Fall back: any slot containing this start time
                            for (let j = 0; j < slots.length; j++) {
                                const s = slots[j];
                                if (s && s.startMin <= t && t < s.endMin && !realigned[j]) {
                                    realigned[j] = a;
                                    placed = true;
                                    break;
                                }
                            }
                        }
                        // If still not placed, keep at original index (last resort)
                        if (!placed && i < realigned.length && !realigned[i]) realigned[i] = a;
                    }
                    sa[bunk] = realigned;
                });
            });
            try { window.AutoSegmentModel?.rebuildFromAssignments?.(); } catch (_e) {}
        };
        if (cloudLoaded && window.divisionTimes && Object.keys(window.divisionTimes).length > 0) {
            debugLog('Using divisionTimes from cloud');
            _reattachAll();
            _realignAssignmentsToSlots();
        } else if (window.divisionTimes && Object.keys(window.divisionTimes).length > 0) {
            debugLog('Using existing divisionTimes');
            _reattachAll();
            _realignAssignmentsToSlots();
        } else if (dateData.divisionTimes && Object.keys(dateData.divisionTimes).length > 0) {
            // Deserialize from storage
           window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(dateData.divisionTimes) || dateData.divisionTimes;
            debugLog('Loaded divisionTimes from storage');
            _reattachAll();
            _realignAssignmentsToSlots();
        } else {
            // Build from skeleton
            const skeleton = getSkeleton(dateKey);
            if (skeleton.length > 0) {
                buildDivisionTimesFromSkeleton(skeleton);
            }
        }
        
        if (dateData.manualSkeleton?.length > 0) window.manualSkeleton = dateData.manualSkeleton;
        else if (dateData.skeleton?.length > 0) window.manualSkeleton = dateData.skeleton;
        
        return {
            scheduleAssignments: window.scheduleAssignments || {},
            leagueAssignments: window.leagueAssignments || {},
            divisionTimes: window.divisionTimes || {},
            skeleton: window.manualSkeleton || window.skeleton || []
        };
    }

    function getSkeleton(dateKey) {
        const dk = dateKey || getDateKey();
        const dailyData = loadDailyData();
        const dateData = dailyData[dk] || {};
        let base = (dateData.manualSkeleton?.length ? dateData.manualSkeleton : null)
            || (dateData.skeleton?.length ? dateData.skeleton : null)
            || (window.dailyOverrideSkeleton?.length ? window.dailyOverrideSkeleton : null)
            || (window.manualSkeleton?.length ? window.manualSkeleton : null)
            || window.skeleton
            || [];
        // ★ Union the authoritative per-date Daily-Adjustments skeleton
        //   (campManualSkeleton_<date> — exactly what saveDailySkeleton persists, also
        //   mirrored to window.dailyOverrideSkeleton). dateData.manualSkeleton can lag
        //   behind it (e.g. a division/tile added or edited ONLY in Daily Adjustments —
        //   a 7th-grade 5-6pm tile that never made it into the base skeleton). Without
        //   this, the manual render's divisionTimes rebuild (buildFromSkeleton below)
        //   drops that division entirely and its bunks render blank on every reload.
        //   Deduped by division+time+event+bunk so it's a no-op when base already has
        //   them; read by dateKey from localStorage so it's date-safe (no stale window
        //   global from another date).
        try {
            let daily = null;
            try { const raw = localStorage.getItem('campManualSkeleton_' + dk); if (raw) daily = JSON.parse(raw); } catch (_eRaw) {}
            if ((!Array.isArray(daily) || !daily.length)
                && Array.isArray(window.dailyOverrideSkeleton) && window.dailyOverrideSkeleton.length
                && (window.currentScheduleDate || getDateKey()) === dk) {
                daily = window.dailyOverrideSkeleton;
            }
            if (Array.isArray(daily) && daily.length && daily !== base) {
                const keyOf = b => [b && b.division, b && b.startTime, b && b.endTime, b && b.event, b && b.type, b && b._bunk].join('|');
                const seen = new Set(base.map(keyOf));
                const merged = base.slice();
                daily.forEach(b => { const k = keyOf(b); if (b && !seen.has(k)) { seen.add(k); merged.push(b); } });
                base = merged;
            }
        } catch (_eMerge) {}
        return base;
    }

    /**
     * Build division times from skeleton
     * *** v4.1.0: This is the CANONICAL way to build time slots ***
     */
    function buildDivisionTimesFromSkeleton(skeleton) {
        if (!skeleton || skeleton.length === 0) return {};
        
        const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
        
        if (window.DivisionTimesSystem?.buildFromSkeleton) {
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(skeleton, divisions);
            console.log(`[UnifiedSchedule] Built divisionTimes for ${Object.keys(window.divisionTimes).length} divisions`);
            return window.divisionTimes;
        }
        
        // Fallback: Build minimal divisionTimes structure
        console.warn('[UnifiedSchedule] DivisionTimesSystem not loaded, using fallback');
        window.divisionTimes = {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const divBlocks = skeleton.filter(b => b.division === divName);
            window.divisionTimes[divName] = divBlocks.map((block, idx) => ({
                slotIndex: idx,
                startMin: parseTimeToMinutes(block.startTime),
                endMin: parseTimeToMinutes(block.endTime),
                event: block.event || 'GA',
                type: block.type || 'slot',
                label: `${minutesToTimeLabel(parseTimeToMinutes(block.startTime))} - ${minutesToTimeLabel(parseTimeToMinutes(block.endTime))}`,
                electiveActivities: block.electiveActivities,
                reservedFields: block.reservedFields,
                location: block.location
            })).filter(s => s.startMin !== null && s.endMin !== null);
        }
        
        return window.divisionTimes;
    }

    // =========================================================================
    // SLOT INDEX MAPPING - ALL DIVISION-AWARE
    // =========================================================================
    
    /**
     * Get start time in minutes from a slot
     */
    function getSlotStartMin(slot) {
        if (!slot) return null;
        if (slot.startMin !== undefined) return slot.startMin;
        if (slot.start instanceof Date) return slot.start.getHours() * 60 + slot.start.getMinutes();
        if (slot.start) { const d = new Date(slot.start); return d.getHours() * 60 + d.getMinutes(); }
        return null;
    }

    /**
     * *** v4.1.0: DIVISION-AWARE slot finder ***
     * @param {number} targetMin - Target time in minutes
     * @param {string} bunkOrDiv - Bunk name or division name
     * @returns {number} Slot index or -1
     */
    function findFirstSlotForTime(targetMin, bunkOrDiv) {
        if (!bunkOrDiv) return -1;
        
        let divName = bunkOrDiv;
        const possibleDiv = getDivisionForBunk(bunkOrDiv);
        if (possibleDiv) divName = possibleDiv;
        
        const divSlots = window.divisionTimes?.[divName] || [];
        
        for (let i = 0; i < divSlots.length; i++) {
            if (divSlots[i].startMin === targetMin) return i;
            if (divSlots[i].startMin <= targetMin && divSlots[i].endMin > targetMin) return i;
        }
        
        return -1;
    }

    // =========================================================================
    // TIME-BASED FIELD USAGE SYSTEM
    // =========================================================================
    // *** v4.1.0: CANONICAL cross-division conflict detection ***
    
    window.TimeBasedFieldUsage = {
        getUsageAtTime: function(fieldName, startMin, endMin, excludeBunk = null) {
            const usage = [];
            const divisions = window.divisions || {};
            const fieldLower = fieldName.toLowerCase();
            
            for (const [divName, divData] of Object.entries(divisions)) {
                const divSlots = window.divisionTimes?.[divName] || [];
                
                for (const bunk of (divData.bunks || [])) {
                    if (excludeBunk && String(bunk) === String(excludeBunk)) continue;
                    
                    const assignments = window.scheduleAssignments?.[bunk] || [];
                    
                    for (let idx = 0; idx < divSlots.length; idx++) {
                        const slot = divSlots[idx];
                        
                        // Time overlap check
                        if (slot.startMin < endMin && slot.endMin > startMin) {
                            const entry = assignments[idx];
                            if (!entry || entry.continuation) continue;
                            
                            const entryField = fieldLabel(entry.field);
                            
                            if (entryField.toLowerCase() === fieldLower) {
                                usage.push({
                                    bunk,
                                    division: divName,
                                    slotIndex: idx,
                                    timeStart: slot.startMin,
                                    timeEnd: slot.endMin,
                                    activity: entry._activity || entryField,
                                    field: entryField
                                });
                            }
                        }
                    }
                }
            }
            return usage;
        },
        
       checkAvailability: function(fieldName, startMin, endMin, capacity = 1, excludeBunk = null, forDivision = null) {
            const usage = this.getUsageAtTime(fieldName, startMin, endMin, excludeBunk);
            
            // *** v4.1.1: Cross-division sharing enforcement ***
            const props = (window.activityProperties || {})[fieldName] || {};
            const sharableWith = props.sharableWith || {};
            const sharingType = sharableWith.type || (props.sharable ? 'same_division' : 'not_sharable');
            const callerDiv = forDivision || (excludeBunk ? getDivisionForBunk(excludeBunk) : null);
            
            // If same_division sharing, check for cross-division conflicts first
            if (callerDiv && sharingType !== 'all') {
                const crossDivConflict = usage.some(u => u.division && u.division !== callerDiv);
                if (crossDivConflict && (sharingType === 'same_division' || sharingType === 'not_sharable')) {
                    return {
                        available: false,
                        currentUsage: usage.length,
                        capacity,
                        conflicts: usage,
                        reason: 'cross_division_conflict'
                    };
                }
                if (crossDivConflict && sharingType === 'custom') {
                    const allowedDivs = sharableWith.divisions || [];
                    const badCross = usage.find(u => u.division !== callerDiv && 
                        (!allowedDivs.includes(u.division) || !allowedDivs.includes(callerDiv)));
                    if (badCross) {
                        return {
                            available: false,
                            currentUsage: usage.length,
                            capacity,
                            conflicts: usage,
                            reason: 'custom_division_conflict'
                        };
                    }
                }
            }
            
            // Find max concurrent usage (same-division only for same_division type)
            let maxConcurrent = 0;
            const timePoints = new Set();
            const relevantUsage = (callerDiv && sharingType === 'same_division') 
                ? usage.filter(u => u.division === callerDiv)
                : usage;
            
            relevantUsage.forEach(u => {
                timePoints.add(u.timeStart);
                timePoints.add(u.timeEnd);
            });
            
            for (const t of timePoints) {
                const concurrent = relevantUsage.filter(u => u.timeStart <= t && u.timeEnd > t).length;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
            }
            
            return {
                available: maxConcurrent < capacity,
                currentUsage: maxConcurrent,
                capacity,
                conflicts: usage
            };
        },
        
        buildUsageMap: function(excludeBunks = []) {
            const map = {};
            const excludeSet = new Set(excludeBunks.map(String));
            const divisions = window.divisions || {};
            
            for (const [divName, divData] of Object.entries(divisions)) {
                const divSlots = window.divisionTimes?.[divName] || [];
                
                for (const bunk of (divData.bunks || [])) {
                    if (excludeSet.has(String(bunk))) continue;
                    
                    const assignments = window.scheduleAssignments?.[bunk] || [];
                    
                    for (let idx = 0; idx < divSlots.length; idx++) {
                        const slot = divSlots[idx];
                        const entry = assignments[idx];
                        
                        if (!entry || entry.continuation || !entry.field) continue;
                        
                        const fName = fieldLabel(entry.field);
                        if (!fName || fName === 'Free') continue;
                        
                        if (!map[fName]) map[fName] = [];
                        
                        map[fName].push({
                            startMin: slot.startMin,
                            endMin: slot.endMin,
                            division: divName,
                            bunk,
                            activity: entry._activity || fName
                        });
                    }
                }
            }
            return map;
        }
    };

    // =========================================================================
    // CROSS-DIVISION CONFLICT CHECK (TIME-BASED)
    // =========================================================================
    
    function checkCrossDivisionConflict(bunk, fieldName, slotIndex) {
        const divName = getDivisionForBunk(bunk);
        const slot = window.divisionTimes?.[divName]?.[slotIndex];
        if (!slot) return { conflict: false, conflicts: [] };
        
        const startMin = slot.startMin;
        const endMin = slot.endMin;
        
        // Get capacity
        const activityProps = getActivityProperties();
        const fieldInfo = activityProps[fieldName] || {};
        let maxCapacity = 1;
        if (fieldInfo.sharableWith?.capacity) {
            maxCapacity = parseInt(fieldInfo.sharableWith.capacity) || 1;
        } else if (fieldInfo.sharable) {
            maxCapacity = 2;
        }
        
        const availability = window.TimeBasedFieldUsage.checkAvailability(
            fieldName, startMin, endMin, maxCapacity, bunk
        );
        
        return {
            conflict: !availability.available,
            conflicts: availability.conflicts,
            startMin,
            endMin,
            capacity: maxCapacity,
            currentUsage: availability.currentUsage
        };
    }

    // =========================================================================
    // SPLIT TILE DETECTION & EXPANSION
    // =========================================================================
    
    function isSplitTileBlock(block) {
        if (block._isSplitTile || block._splitHalf || block.type === 'split_half') {
            return true;
        }
        if (!block || !block.event || !block.event.includes('/')) return false;
        if (block.event.toLowerCase().includes('special')) return false;
        
        const duration = block.endMin - block.startMin;
        if (duration < 30) return false;
        
        // Check if divisionTimes has split data
        const divName = block.division;
        const divSlots = window.divisionTimes?.[divName] || [];
        
        for (const slot of divSlots) {
            if (slot._splitParentEvent === block.event) {
                return true;
            }
        }
        
        return false;
    }
    
    function expandBlocksForSplitTiles(divBlocks, divName) {
        const expandedBlocks = [];
        // ★ divisionTimes[div] can be either an Array (normal mode) OR an
        // object with _isPerBunk/_perBunkSlots (auto-mode). Coerce to a flat
        // array of slot objects so .find() works in both shapes.
        let divSlots = window.divisionTimes?.[divName];
        if (!Array.isArray(divSlots)) {
            if (divSlots && divSlots._isPerBunk && divSlots._perBunkSlots) {
                // Use the first bunk's slot list as a representative timeline
                const anyBunk = Object.keys(divSlots._perBunkSlots)[0];
                divSlots = anyBunk ? (divSlots._perBunkSlots[anyBunk] || []) : [];
            } else if (divSlots && typeof divSlots === 'object') {
                // Numeric-keyed object → array
                divSlots = Object.keys(divSlots)
                    .filter(k => /^\d+$/.test(k))
                    .sort((a, b) => Number(a) - Number(b))
                    .map(k => divSlots[k]);
            } else {
                divSlots = [];
            }
        }
        
        divBlocks.forEach(block => {
            // Already expanded
            if (block._splitHalf || block.type === 'split_half') {
                expandedBlocks.push(block);
                return;
            }
            
            // Check if this is a split tile that needs expansion
            if (block.type === 'split' && block.event?.includes('/')) {
                // Look for pre-expanded slots from divisionTimes
                const firstHalfSlot = divSlots.find(s => 
                    s._splitParentEvent === block.event && s._splitHalf === 1
                );
                const secondHalfSlot = divSlots.find(s => 
                    s._splitParentEvent === block.event && s._splitHalf === 2
                );
                
                if (firstHalfSlot && secondHalfSlot) {
                    expandedBlocks.push({
                        ...block,
                        startMin: firstHalfSlot.startMin,
                        endMin: firstHalfSlot.endMin,
                        event: firstHalfSlot.event,
                        _splitHalf: 1,
                        _originalEvent: block.event,
                        _isSplitTile: true
                    });
                    expandedBlocks.push({
                        ...block,
                        startMin: secondHalfSlot.startMin,
                        endMin: secondHalfSlot.endMin,
                        event: secondHalfSlot.event,
                        _splitHalf: 2,
                        _originalEvent: block.event,
                        _isSplitTile: true
                    });
                } else {
                    // Fallback: manual expansion
                    const midpoint = Math.floor((block.startMin + block.endMin) / 2);
                    expandedBlocks.push({
                        ...block,
                        endMin: midpoint,
                        _splitHalf: 1,
                        _originalEvent: block.event,
                        _isSplitTile: true
                    });
                    expandedBlocks.push({
                        ...block,
                        startMin: midpoint,
                        _splitHalf: 2,
                        _originalEvent: block.event,
                        _isSplitTile: true
                    });
                }
            } else {
                expandedBlocks.push(block);
            }
        });
        
        return expandedBlocks;
    }

    // =========================================================================
    // ENTRY ACCESS & FORMATTING
    // =========================================================================

    function getEntry(bunk, slotIndex) {
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) return null;
        return assignments[bunk][slotIndex] || null;
    }

    // ★ Build a Set of "special activity" names (e.g. Gameroom, Canteen, Arts & Crafts)
    //   so we can exclude them from the sharers display. Re-read each call so updates
    //   in settings appear immediately.
    function _specialNamesSet() {
        const out = new Set();
        try {
            const g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            const specials = (g.app1 && g.app1.specialActivities) || [];
            specials.forEach(s => {
                if (s && s.name) out.add(String(s.name).toLowerCase().trim());
            });
        } catch (e) { /* ignore */ }
        return out;
    }

    // ★ Find OTHER bunks (any division) that share this bunk's field at this time.
    //   Sports only — pinned events, electives, leagues, transitions, and special
    //   activities (Gameroom, Canteen, Arts & Crafts, etc.) are skipped.
    function findFieldSharers(bunk, slotIdx, divName) {
        const myEntry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (!myEntry) return [];
        if (myEntry._swimElective || myEntry._isTransition || myEntry.continuation) return [];
        if (myEntry._h2h || myEntry._isSpecialtyLeague || myEntry._allMatchups) return [];
        if (myEntry._isDismissal || myEntry._isSnack) return [];
        if (myEntry._pinned) return [];
        const _myAct = (myEntry._activity || myEntry.sport || '').toLowerCase().trim();
        const _myField = (typeof myEntry.field === 'string' ? myEntry.field
            : (myEntry.field && myEntry.field.name) || '').toLowerCase().trim();
        const NON_SPORTS = ['swim', 'pool', 'swimming', 'lunch', 'snacks', 'snack',
                            'dismissal', 'change', 'free', 'free play', 'free time', 'rest',
                            'regroup', 'flagpole', 'assembly', 'davening', 'shacharis', 'mincha',
                            'maariv', 'tefillah', 'learning', 'shiur'];
        if (NON_SPORTS.some(n => _myAct === n || _myAct.includes(n))) return [];
        // Skip if either the activity or the field is a configured special activity.
        const _specials = _specialNamesSet();
        if (_specials.has(_myAct) || _specials.has(_myField)) return [];
        const myField = (typeof myEntry.field === 'string') ? myEntry.field
            : (myEntry.field && myEntry.field.name ? myEntry.field.name : '');
        if (!myField) return [];
        const myFieldKey = myField.toLowerCase().trim();
        const mySlot = window.divisionTimes?.[divName]?.[slotIdx];
        if (!mySlot || mySlot.startMin == null) return [];
        const myStart = mySlot.startMin, myEnd = mySlot.endMin;
        const sharers = [];
        const seen = new Set();
        const allBunks = window.scheduleAssignments || {};
        for (const otherBunk in allBunks) {
            if (otherBunk === bunk || seen.has(otherBunk)) continue;
            const otherDiv = (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionForBunk
                ? window.SchedulerCoreUtils.getDivisionForBunk(otherBunk)
                : (window.DivisionTimesSystem && window.DivisionTimesSystem.getDivisionForBunk
                    ? window.DivisionTimesSystem.getDivisionForBunk(otherBunk) : null));
            const otherSlots = window.divisionTimes?.[otherDiv] || [];
            const otherEntries = allBunks[otherBunk] || [];
            for (let si = 0; si < otherSlots.length; si++) {
                const oslot = otherSlots[si];
                if (!oslot || oslot.startMin == null) continue;
                if (oslot.startMin >= myEnd || oslot.endMin <= myStart) continue;
                const oentry = otherEntries[si];
                if (!oentry || oentry.continuation) continue;
                const ofield = (typeof oentry.field === 'string') ? oentry.field
                    : (oentry.field && oentry.field.name ? oentry.field.name : '');
                if (!ofield) continue;
                if (ofield.toLowerCase().trim() === myFieldKey) {
                    sharers.push(otherBunk);
                    seen.add(otherBunk);
                    break;
                }
            }
        }
        // Natural sort if available, else default
        if (typeof window.naturalSort === 'function') sharers.sort(window.naturalSort);
        else sharers.sort();
        return sharers;
    }

    // ★ Resolve the location/room to DISPLAY next to an activity name. Sports keep
    //   it in `field`; specials keep it in `_specialLocation`/`_customField`/
    //   `_location`/`_partLocation` (and `field` may hold the special's NAME). Falls
    //   back to the special's configured room via getLocationForActivity. Returns ''
    //   when there's nothing meaningful to show.
    function resolveEntryLocation(entry) {
        if (!entry) return '';
        const name = entry._activity || entry.sport || '';
        let loc = entry._specialLocation || entry._customField || entry._location || entry._partLocation || '';
        if (!loc) {
            const f = fieldLabel(entry.field);
            if (f && f !== 'Free') loc = f;
        }
        // Manual specials store field = the activity name; resolve the configured room.
        if ((!loc || loc.toLowerCase() === name.toLowerCase()) && name && typeof window.getLocationForActivity === 'function') {
            try { const cfg = window.getLocationForActivity(name); if (cfg) loc = fieldLabel(cfg) || cfg; } catch (_e) { /* ignore */ }
        }
        if (!loc || loc === 'Free') return '';
        return loc;
    }

    function formatEntry(entry) {
        if (!entry) return '';
        if (entry._isDismissal) return 'Dismissal';
        if (entry._isSnack) return 'Snacks';
        if (entry._isTransition || entry.continuation) return '';
        // ★ Swim + Elective hybrid: list "Swim" + each reserved elective field.
        if (entry._swimElective) {
            const poolLc = (entry._swimLocation || '').toLowerCase().trim();
            // Try _electiveActivities first; fall back to _reservedFields (minus the pool)
            let acts = entry._electiveActivities || entry._reservedFields || entry.reservedFields || [];
            if (!acts.length && Array.isArray(entry._allReservedFields)) acts = entry._allReservedFields;
            const filtered = acts.filter(function (a) { return (a || '').toLowerCase().trim() !== poolLc; });
            return ['Swim'].concat(filtered).join(', ');
        }
        const field = fieldLabel(entry.field);
        const sport = entry.sport || '';
        if (entry._h2h) return entry._gameLabel || sport || 'League Game';
        // ★ Every cell shows "Activity – Location" (activity name FIRST), for sports
        //   AND specials. Manual specials store field = the activity name, so the real
        //   room is resolved via resolveEntryLocation (special location / configured
        //   room). Location is dropped only when it's empty or identical to the name.
        const name = entry._partLabel || entry._activity || sport || field || '';
        const loc = resolveEntryLocation(entry);
        if (name && loc && loc.toLowerCase() !== name.toLowerCase()) return `${name} – ${loc}`;
        return name || loc || '';
    }

    function getEntryBackground(entry, blockEvent) {
        if (!entry) return blockEvent && isFixedBlockType(blockEvent) ? '#fff8e1' : '#f9fafb';
        if (entry._isDismissal) return '#ffebee';
        if (entry._isSnack) return '#fff3e0';
        if (entry._isTransition) return '#e8eaf6';
        if (entry._isTrip) return '#e8f5e9';
        if (entry._h2h || entry._isSpecialtyLeague) return '#e3f2fd';
        if (entry._fixed) return '#fff8e1';
        if (entry._fromBackground) return '#f3e5f5';
        if (entry._pinned) return '#fef3c7';
        return '#f0f9ff';
    }

    function isFixedBlockType(eventName) {
        if (!eventName) return false;
        const lower = eventName.toLowerCase();
        return lower.includes('lunch') || lower.includes('snack') || lower.includes('swim') || 
               lower.includes('dismissal') || lower.includes('rest') || lower.includes('free');
    }

    // True iff `name` exactly matches a configured league (regular or specialty).
    // Used to distinguish a real league slot from a custom pin whose name merely
    // contains the word "league" (e.g. a "Signup Leagues" placeholder tile).
    window.isConfiguredLeagueName = function (name) {
        if (!name) return false;
        var n = String(name).toLowerCase().trim();
        var gs = (typeof window.loadGlobalSettings === 'function' && window.loadGlobalSettings()) || {};
        var byName = window.leaguesByName || gs.leaguesByName || {};
        if (Object.keys(byName).some(function (k) { return String(k).toLowerCase().trim() === n; })) return true;
        var sp = window.specialtyLeagues || gs.specialtyLeagues || [];
        var arr = Array.isArray(sp) ? sp : Object.values(sp || {});
        return arr.some(function (l) { return l && l.name && String(l.name).toLowerCase().trim() === n; });
    };

    function isLeagueBlockType(eventName, blockType) {
        if (blockType === 'league' || blockType === 'specialty_league') return true;
        // Name fallback for blocks that lost their explicit type — scoped to a
        // REAL configured league. A custom pin whose name merely contains
        // "league" (e.g. "Signup Leagues") must NOT render as a league slot, or
        // it inherits a neighboring league's matchups via the ±2 slot lookup.
        return !!eventName && window.isConfiguredLeagueName(eventName);
    }

    // =========================================================================
    // ACTIVITY PROPERTIES & LOCATIONS
    // =========================================================================

    function getAllLocations() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const locations = [];
        (app1.fields || []).forEach(f => {
            if (f.name && f.available !== false) locations.push({
                name: f.name, type: 'field',
                capacity: f.sharableWith?.capacity || 1,
                activities: f.activities || []
            });
        });
        // Specials feed the edit-modal activity dropdown. Reading ONLY
        // app1.specialActivities left it empty when the specials lived in another
        // copy (the live list / top-level key). Prefer the canonical live list,
        // fall back to app1 then top-level, so the dropdown is always populated.
        let specials = (Array.isArray(app1.specialActivities) && app1.specialActivities.length)
            ? app1.specialActivities : null;
        if (!specials) {
            try {
                if (typeof window.getAllSpecialActivities === 'function') {
                    const live = window.getAllSpecialActivities();
                    if (Array.isArray(live) && live.length) specials = live;
                }
            } catch (e) { /* fall through */ }
        }
        if (!specials) specials = settings.specialActivities || window.specialActivities || [];
        (specials || []).forEach(s => {
            if (s && s.name) locations.push({
                name: s.name, type: 'special',
                capacity: s.sharableWith?.capacity || 1,
                activities: [s.name]
            });
        });
        return locations;
    }

    
    // =========================================================================
// CONFLICT DETECTION (TIME-BASED - CROSS-DIVISION COMPATIBLE)
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
    const activityProps = getActivityProperties();
    const locationInfo = activityProps[locationName] || {};
    let maxCapacity = locationInfo.sharableWith?.capacity ? parseInt(locationInfo.sharableWith.capacity) || 1 : (locationInfo.sharable ? 2 : 1);
   // ★ MS-4b: for CONFLICT CLASSIFICATION, "mine" = bunks in my GENERATION
   // scope (assigned divisions). v3.13 gave schedulers edit access to ALL
   // bunks, so every cross-user conflict looked "editable" and other users'
   // bunks were silently auto-reassigned without the notify/bypass/cancel
   // choice. Owners keep full ownership (their scope is every division).
   let _conflictOwnScope = null;
   try {
       const _gd = window.AccessControl?.getGeneratableDivisions?.();
       const _allDivCount = Object.keys(window.divisions || {}).length;
       if (Array.isArray(_gd) && _gd.length > 0 && _allDivCount > 0 && _gd.length < _allDivCount) {
           _conflictOwnScope = new Set();
           _gd.forEach(dn => (((window.divisions || {})[dn] || {}).bunks || []).forEach(b => _conflictOwnScope.add(String(b))));
       }
   } catch (_eScope) { /* fall back to edit-permission classification */ }
   const editBunksResult = getEditableBunks();
const editBunks = _conflictOwnScope || (editBunksResult instanceof Set ? editBunksResult : new Set(editBunksResult || []));
    const conflicts = [], usageBySlot = {};
    
    // *** FIX: Get the ACTUAL time range from the editing bunk's slots ***
    const excludeBunkDiv = getDivisionForBunk(excludeBunk);
    // *** AUTO MODE: Use per-bunk slots when available (indices are bunk-specific) ***
    const _perBunkData = window.divisionTimes?.[excludeBunkDiv]?._perBunkSlots?.[String(excludeBunk)];
    const excludeBunkSlots = _perBunkData || window.divisionTimes?.[excludeBunkDiv] || [];
    
    // Build time ranges for the slots being claimed.
    // MS-5: prefer the editing bunk's entry-stamped times (_startMin/_endMin)
    // — per-bunk slot tables can be stale/degenerate after merges while the
    // entries carry the solver's real times; mixing the two coordinate
    // systems made real cross-division overlaps invisible.
    const claimedTimeRanges = [];
    for (const slotIdx of slots) {
        const slotInfo = excludeBunkSlots[slotIdx];
        const ownEntry = (assignments[excludeBunk] || [])[slotIdx];
        const cs = (ownEntry && typeof ownEntry._startMin === 'number') ? ownEntry._startMin : (slotInfo ? slotInfo.startMin : undefined);
        const ce = (ownEntry && typeof ownEntry._endMin === 'number') ? ownEntry._endMin : (slotInfo ? slotInfo.endMin : undefined);
        if (cs !== undefined && ce !== undefined) {
            claimedTimeRanges.push({ slotIdx, startMin: cs, endMin: ce });
        }
    }
    
    // Fallback to legacy slot-based check if no time info available
    if (claimedTimeRanges.length === 0) {
        console.warn('[checkLocationConflict] No divisionTimes available, using legacy slot-based check');
        // Legacy behavior - slot index based (same as before)
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                const entry = bunkSlots?.[slotIdx];
                if (!entry || entry.continuation) continue;
                const entryField = fieldLabel(entry.field);
                const entryActivity = entry._activity || entryField;
                const entryLocation = entry._location || entryField;
                const matchesLocation = entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryLocation?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase();
                if (matchesLocation) {
                    usageBySlot[slotIdx].push({ bunk: bunkName, activity: entryActivity || entryField, field: entryField, canEdit: editBunks.has(bunkName) });
                }
            }
        }
    } else {
        // *** NEW: Time-based conflict detection across ALL divisions ***
        const divisions = window.divisions || {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const divSlots = window.divisionTimes?.[divName] || [];
            const divBunks = divData.bunks || [];
            
            for (const bunkName of divBunks) {
                if (String(bunkName) === String(excludeBunk)) continue;
                
                const bunkAssignments = assignments[bunkName];
                if (!bunkAssignments) continue;
                
                // Check each slot in THIS bunk's division for time overlap.
                // MS-5: iterate the full assignment array (entries can exist
                // past the division table's length) and prefer entry-stamped
                // times over the table's — same reasoning as the claimed side.
                const _scanLen = Math.max(divSlots.length, bunkAssignments.length);
                for (let idx = 0; idx < _scanLen; idx++) {
                    const entry = bunkAssignments[idx];
                    if (!entry || entry.continuation) continue;

                    const entryField = fieldLabel(entry.field);
                    const entryActivity = entry._activity || entryField;
                    const entryLocation = entry._location || entryField;

                    // Check if this entry uses the same location
                    const matchesLocation = entryField?.toLowerCase() === locationName.toLowerCase() ||
                        entryLocation?.toLowerCase() === locationName.toLowerCase() ||
                        entryActivity?.toLowerCase() === locationName.toLowerCase();

                    if (!matchesLocation) continue;

                    // *** KEY FIX: Check TIME OVERLAP, not slot index ***
                    const slotInfo = divSlots[idx];
                    const oS = (typeof entry._startMin === 'number') ? entry._startMin : (slotInfo ? slotInfo.startMin : undefined);
                    const oE = (typeof entry._endMin === 'number') ? entry._endMin : (slotInfo ? slotInfo.endMin : undefined);
                    if (oS === undefined || oE === undefined) continue;

                    for (const claimed of claimedTimeRanges) {
                        // Time overlap: NOT (end1 <= start2 OR start1 >= end2)
                        const hasOverlap = !(oE <= claimed.startMin || oS >= claimed.endMin);

                        if (hasOverlap) {
                            if (!usageBySlot[claimed.slotIdx]) usageBySlot[claimed.slotIdx] = [];

                            // Avoid duplicate entries for same bunk in same claimed slot
                            if (!usageBySlot[claimed.slotIdx].find(u => u.bunk === String(bunkName))) {
                                usageBySlot[claimed.slotIdx].push({
                                    bunk: String(bunkName),
                                    division: divName,
                                    activity: entryActivity || entryField,
                                    field: entryField,
                                    canEdit: editBunks.has(String(bunkName)),
                                    theirSlot: idx,
                                    overlapStart: Math.max(oS, claimed.startMin),
                                    overlapEnd: Math.min(oE, claimed.endMin)
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Check GlobalFieldLocks
    // *** Only league games should truly BLOCK an edit ***
    let globalLock = null;
    if (window.GlobalFieldLocks) {
        const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, excludeBunkDiv);
        // Only treat as a hard block if it's a league game lock
        if (lockInfo && (lockInfo.lockedBy === 'league_game' || lockInfo.leagueName || lockInfo.type === 'league')) {
            globalLock = lockInfo;
        }
        // Other locks (pinned, smart_regen, etc.) are soft — post-edit can resolve them
    }
    
    // Determine conflicts based on capacity
    let hasConflict = !!globalLock, currentUsage = 0;
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
    
    // *** AUTO MODE: All non-league conflicts are resolvable via post-edit ***
    // Mark conflicts as auto-resolvable so UI can show them differently
    const _isAutoEditMode = !!window.divisionTimes?.[excludeBunkDiv]?._perBunkSlots;
    if (_isAutoEditMode && !globalLock) {
        conflicts.forEach(c => { c._autoResolvable = true; });
    }
    
    if (conflicts.length > 0) {
        console.log(`[checkLocationConflict] ${locationName}: ${conflicts.length} time-based conflicts found`);
    }
    
    return {
        hasConflict, conflicts,
        editableConflicts: conflicts.filter(c => c.canEdit),
        nonEditableConflicts: conflicts.filter(c => !c.canEdit),
        globalLock, canShare: maxCapacity > 1 && currentUsage < maxCapacity, currentUsage, maxCapacity
    };
}

    // =========================================================================
    // ROTATION SCORING
    // =========================================================================

    function getActivitiesDoneToday(bunk, beforeSlot) {
        return window.SchedulerCoreUtils?.getActivitiesDoneToday?.(bunk, beforeSlot) 
            || new Set();
    }

    function getActivityCount(bunk, activityName) {
        return window.SchedulerCoreUtils?.getActivityCount?.(bunk, activityName) 
            || 0;
    }
    function getDaysSinceActivity(bunk, activityName) {
        return window.SchedulerCoreUtils?.getDaysSinceActivity?.(bunk, activityName, 999) 
            ?? null;
    }

    function calculateRotationPenalty(bunk, activityName, slots) {
        if (!activityName || activityName === 'Free') return 0;
        
        // *** DELEGATE TO ROTATION ENGINE ***
        if (window.RotationEngine?.calculateRotationScore) {
            const divName = getDivisionForBunk(bunk);
            return window.RotationEngine.calculateRotationScore({
                bunkName: bunk,
                activityName: activityName,
                divisionName: divName,
                beforeSlotIndex: slots[0] || 0,
                allActivities: null,
                activityProperties: getActivityProperties()
            });
        }
        
        // Fallback if RotationEngine not loaded
        const firstSlot = slots[0];
        const doneToday = getActivitiesDoneToday(bunk, firstSlot);
        if (doneToday.has(activityName.toLowerCase().trim())) return Infinity;
        return 0;
    }

    function buildCandidateOptions(slots, activityProps, disabledFields = [], divName = null) {
        const options = [], seenKeys = new Set();
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fieldsBySport = settings.fieldsBySport || {};
        
        for (const [sport, sportFields] of Object.entries(fieldsBySport)) {
            (sportFields || []).forEach(fName => {
                if (disabledFields.includes(fName) || window.GlobalFieldLocks?.isFieldLocked(fName, slots, divName)) return;
                const key = `${fName}|${sport}`;
                if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: fName, sport, activityName: sport, type: 'sport' }); }
            });
        }
        for (const special of (app1.specialActivities || [])) {
            if (!special.name || disabledFields.includes(special.name) || window.GlobalFieldLocks?.isFieldLocked(special.name, slots, divName)) continue;
            // * DEMO FIX: Filter rainy-day-only specials on normal days
            if (window.__CAMPISTRY_DEMO_MODE__) {
                const _isRainy = window.isRainyDayModeActive?.() || window.isRainyDay === true;
                if (!_isRainy && (special.rainyDayOnly === true || special.rainyDayExclusive === true)) continue;
                if (_isRainy && special.rainyDayAvailable === false) continue;
            }
            const key = `special|${special.name}`;
            if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: special.name, sport: null, activityName: special.name, type: 'special' }); }
        }
        for (const field of (app1.fields || [])) {
            if (!field.name || field.available === false || disabledFields.includes(field.name) || window.GlobalFieldLocks?.isFieldLocked(field.name, slots, divName)) continue;
            (field.activities || []).forEach(activity => {
                const key = `${field.name}|${activity}`;
                if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: field.name, sport: activity, activityName: activity, type: 'sport' }); }
            });
        }
        return options;
    }

    function isFieldAvailable(fName, slots, bunk, fieldUsageBySlot, activityProps, timeWindow = null) {
        const divName = getDivisionForBunk(bunk);
        if (!divName || slots.length === 0) return false;

        // Get time range for these slots.
        // MS-5b: when the caller already resolved the real window (entry
        // times / per-bunk table), use it — the division-level table can be
        // SHORTER than the bunk's slot index in auto mode, which made the
        // guard below reject every candidate and park bunks at Free.
        const divSlots = window.divisionTimes?.[divName] || [];
        let startMin, endMin;
        if (timeWindow && typeof timeWindow.startMin === 'number' && typeof timeWindow.endMin === 'number') {
            startMin = timeWindow.startMin;
            endMin = timeWindow.endMin;
        } else {
            if (slots[0] >= divSlots.length) return false;
            startMin = divSlots[slots[0]]?.startMin;
            endMin = divSlots[slots[slots.length - 1]]?.endMin;
            if (startMin === undefined || endMin === undefined) return false;
        }
        
        // Use time-based availability check
        const props = activityProps[fName] || {};
        const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);
        
       const availability = window.TimeBasedFieldUsage.checkAvailability(
            fName, startMin, endMin, maxCapacity, bunk
        );
        
        if (!availability.available) return false;

        // *** COMBINED FIELD MUTUAL EXCLUSION CHECK ***
        if (window.FieldCombos?.isInCombo?.(fName)) {
            const comboCheck = window.FieldCombos.isBlockedByCombo(fName, startMin, endMin, bunk);
            if (comboCheck.blocked) return false;
        }

        // *** LOCATION COOLDOWN CHECK ***
        if (window.isLocationInCooldown) {
            const divSlots = window.divisionTimes?.[getDivisionForBunk(bunk)] || [];
            let slotIdx = divSlots.findIndex(s => s.startMin >= startMin);
            if (slotIdx < 0) slotIdx = 0;
            const cooldown = window.isLocationInCooldown(fName, slotIdx, bunk, getDivisionForBunk(bunk));
            if (cooldown?.blocked) return false;
        }

        // *** SEQUENCE RULE CHECK ***
        if (window.checkSequenceViolation) {
            const divSlots = window.divisionTimes?.[getDivisionForBunk(bunk)] || [];
            let slotIdx = divSlots.findIndex(s => s.startMin >= startMin);
            if (slotIdx < 0) slotIdx = 0;
            // `pick` was never a parameter here — referencing it would throw
            // a ReferenceError the moment checkSequenceViolation exists.
            const seqViolation = window.checkSequenceViolation(bunk, fName, slotIdx, getDivisionForBunk(bunk));
            if (seqViolation?.violated) return false;
        }

        return true;
    }


    function calculatePenaltyCost(bunk, slots, pick, fieldUsageBySlot, activityProps) {
        let penalty = 0;
        const activityName = pick.activityName || pick._activity || pick.sport;
        const fName = pick.field;
        const divName = getDivisionForBunk(bunk);
        const rotationPenalty = calculateRotationPenalty(bunk, activityName, slots);
        if (rotationPenalty === Infinity) return Infinity;
        penalty += rotationPenalty;
        const props = activityProps[fName] || {};
        if (props.preferences?.enabled && props.preferences?.list) {
            const idx = props.preferences.list.indexOf(divName);
            if (idx !== -1) penalty -= (50 - idx * 5);
            else if (props.preferences.exclusive) return Infinity;
            else penalty += 500;
        }
        const myNum = parseInt((bunk.match(/\d+/) || [])[0]) || 0;
        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fName];
            if (slotUsage?.bunks) {
                for (const otherBunk of Object.keys(slotUsage.bunks)) {
                    if (otherBunk === bunk) continue;
                    const otherNum = parseInt((otherBunk.match(/\d+/) || [])[0]) || 0;
                    const distance = Math.abs(myNum - otherNum);
                    if (distance === 1) penalty += ROTATION_CONFIG.ADJACENT_BUNK_BONUS;
                    else if (distance <= 3) penalty += ROTATION_CONFIG.NEARBY_BUNK_BONUS;
                }
            }
        }
        const _gpc = window.SchedulerCoreUtils?.getPeriodActivityCount;
        const maxUsage = props.maxUsage || 0;
        if (maxUsage > 0) {
            const maxPeriod = props.maxUsagePeriod || 'half';
            const hist = _gpc ? _gpc(bunk, activityName, maxPeriod) : getActivityCount(bunk, activityName);
            if (hist >= maxUsage) return Infinity;
            if (hist >= maxUsage - 1) penalty += 2000;
        }
        const exactFreq = props.exactFrequency || 0;
        if (exactFreq > 0) {
            const exactPeriod = props.exactFrequencyPeriod || '1week';
            const hist = _gpc ? _gpc(bunk, activityName, exactPeriod) : getActivityCount(bunk, activityName);
            if (hist >= exactFreq) return Infinity;
            if (hist >= exactFreq - 1) penalty += 2000;
            const _efNeeded = exactFreq - hist;
            if (_efNeeded > 0) {
                const _efEsc = window.SchedulerCoreUtils?.getEscalationBonus?.(exactPeriod, _efNeeded);
                penalty -= _efEsc || (100 * _efNeeded);
            }
        }
        return penalty;
    }

    function findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProps, avoidFields = []) {
        const disabledFields = window.currentDisabledFields || [];
        const avoidSet = new Set(avoidFields.map(f => f.toLowerCase()));
        const divName = getDivisionForBunk(bunk);
        const candidates = buildCandidateOptions(slots, activityProps, disabledFields, divName);
        const scoredPicks = [];
        
        for (const cand of candidates) {
            if (avoidSet.has(cand.field.toLowerCase()) || avoidSet.has(cand.activityName?.toLowerCase())) continue;
            if (!isFieldAvailable(cand.field, slots, bunk, fieldUsageBySlot, activityProps)) continue;
            
            // *** v4.1.2 FIX: Enforce accessRestrictions, timeRules & preferences ***
            if (window.SchedulerCoreUtils?.canBlockFit) {
                const divSlots_fb = window.divisionTimes?.[divName] || [];
                const pseudoBlock = {
                    bunk: bunk,
                    divName: divName,
                    startTime: slots.length > 0 && divSlots_fb[slots[0]] ? divSlots_fb[slots[0]].startMin : null,
                    endTime: slots.length > 0 && divSlots_fb[slots[slots.length - 1]] ? divSlots_fb[slots[slots.length - 1]].endMin : null,
                    slots: slots
                };
                if (!window.SchedulerCoreUtils.canBlockFit(pseudoBlock, cand.field, activityProps, fieldUsageBySlot, cand.activityName)) {
                    continue;
                }
            }
            
            const cost = calculatePenaltyCost(bunk, slots, cand, fieldUsageBySlot, activityProps);
            if (cost < Infinity) scoredPicks.push({ ...cand, cost });
        }
        scoredPicks.sort((a, b) => a.cost - b.cost);
        return scoredPicks.length > 0 ? scoredPicks[0] : null;
    }

    function applyPickToBunk(bunk, slots, pick, fieldUsageBySlot, activityProps) {
        const divName = getDivisionForBunk(bunk);
        const divSlots = window.divisionTimes?.[divName] || [];
        
        let startMin = null, endMin = null;
        if (slots.length > 0 && divSlots[slots[0]]) {
            startMin = divSlots[slots[0]].startMin;
            const lastSlot = divSlots[slots[slots.length - 1]];
            if (lastSlot) endMin = lastSlot.endMin;
        }
        
        const pickData = { 
            field: pick.field, sport: pick.sport, _fixed: true, _activity: pick.activityName,
            _smartRegenerated: true, _regeneratedAt: Date.now(), _startMin: startMin, _endMin: endMin, _blockStart: startMin 
        };
        
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) {
            const slotCount = divSlots.length || 50;
            window.scheduleAssignments[bunk] = new Array(slotCount);
        }

        // Slice 4 audit N-2 — gate through the manual rule check. Soft-
        // override is allowed because the picker already vetted basic
        // shape; this catches anything the picker missed (disabledSports,
        // activity-in-field, cooldowns) at commit time.
        if (typeof window.commitManualWriteIfLegal === 'function' && pick.activityName) {
            const _check = window.commitManualWriteIfLegal(
                bunk, slots[0], pick.activityName, pick.field, divName,
                startMin, endMin,
                { allowSoftOverride: true, slotRange: slots }
            );
            if (!_check.ok && !_check.soft) {
                console.warn('[applyPickToBunk] BLOCKED:', _check.reason, 'for', bunk);
                return { ok: false, reason: _check.reason };
            }
        }

        slots.forEach((slotIdx, i) => {
            window.scheduleAssignments[bunk][slotIdx] = { ...pickData, continuation: i > 0 };
        });
        
        // Update field usage
        const fName = pick.field;
        for (const slotIdx of slots) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fName]) fieldUsageBySlot[slotIdx][fName] = { count: 0, bunks: {}, divisions: [] };
            const usage = fieldUsageBySlot[slotIdx][fName];
            usage.count++; 
            usage.bunks[bunk] = pick.activityName;
            if (divName && !usage.divisions.includes(divName)) usage.divisions.push(divName);
        }
        return { ok: true };
    }

    // =========================================================================
    // SMART REGENERATION FOR CONFLICTS
    // =========================================================================
// =========================================================================
// RESOLVE CONFLICTS AND APPLY (CROSS-DIVISION COMPATIBLE)
// =========================================================================
async function resolveConflictsAndApply(bunk, slots, activity, location, editData) {
    const editableConflicts = editData.editableConflicts || [];
    const nonEditableConflicts = editData.nonEditableConflicts || [];
    const resolutionChoice = editData.resolutionChoice || 'notify';
    
    // Get the editing bunk's division and time range
    const editingDiv = getDivisionForBunk(bunk);
    const editingDivSlots = window.divisionTimes?.[editingDiv] || [];

    // ★★★ CB-33: when the editing division uses per-bunk geometry (auto mode),
    // the `slots` indices index into THIS BUNK's _perBunkSlots — not the
    // division-level slot table. Reading editingDivSlots[slots[i]] then yields
    // the wrong time window (or undefined, when divisionTimes[div] is the
    // per-bunk object), producing a wrong field-lock window + wrong smart-regen
    // mapping. Resolve the claimed window from the bunk's per-bunk slots first,
    // falling back to the (flat) division table for manual geometry.
    const _divEntry33 = window.divisionTimes?.[editingDiv];
    const _perBunkSlots33 =
        (_divEntry33 && _divEntry33._isPerBunk && _divEntry33._perBunkSlots && _divEntry33._perBunkSlots[bunk]) ||
        (window._perBunkSlots && window._perBunkSlots[editingDiv] && window._perBunkSlots[editingDiv][bunk]) ||
        null;
    const _claimSlots33 = (Array.isArray(_perBunkSlots33) && _perBunkSlots33.length) ? _perBunkSlots33 : editingDivSlots;

    // * Capture the actual TIME RANGE being claimed *
    let claimedStartMin = null, claimedEndMin = null;
    if (slots.length > 0 && _claimSlots33[slots[0]]) {
        claimedStartMin = _claimSlots33[slots[0]].startMin;
        claimedEndMin = _claimSlots33[slots[slots.length - 1]].endMin;
    }
    
    console.log(`[resolveConflictsAndApply] Claiming ${location} for ${bunk} (${editingDiv}) at ${claimedStartMin}-${claimedEndMin}min`);
    
    // Apply the primary edit first
    applyDirectEdit(bunk, slots, activity, location, false, true);
    
    // Lock the field
    if (window.GlobalFieldLocks) {
        window.GlobalFieldLocks.lockField(location, slots, { 
            lockedBy: 'post_edit_pinned', 
            division: editingDiv, 
            activity,
            startMin: claimedStartMin,
            endMin: claimedEndMin
        });
    }
    
    // Determine which conflicts to resolve
    let conflictsToResolve = [...editableConflicts];
    const bypassMode = resolutionChoice === 'bypass';
    
    if (bypassMode && nonEditableConflicts.length > 0) {
        console.log('[resolveConflictsAndApply] [BYPASS] BYPASS MODE - including non-editable conflicts');
        conflictsToResolve = [...conflictsToResolve, ...nonEditableConflicts];
    }
    
    let result = { success: true, reassigned: [], failed: [] };
    
    if (conflictsToResolve.length > 0) {
        // Pass time context for cross-division slot mapping
        result = smartRegenerateConflicts(
            bunk, slots, location, activity, 
            conflictsToResolve, bypassMode,
            { claimedStartMin, claimedEndMin, claimingDivision: editingDiv }
        );
        
        if (bypassMode) {
    const modifiedBunks = [
        ...result.reassigned.map(r => r.bunk), 
        ...result.failed.map(f => f.bunk)
    ];
    
    markPostEditInProgress();

    await bypassSaveAllBunks(modifiedBunks);

    // ★ Update rotation counts (historicalCounts + rotationHistory + cloud) for
    //   every bunk the bypass touched. applyPostEditCounts is the single source
    //   of truth — it counts non-continuation slots, rebuilds rotationHistory
    //   timestamps, and debounces the RotationCloud.save so a single batched
    //   cloud sync fires for the whole bypass.
    try {
        const _ape = window.SchedulerCoreUtils?.applyPostEditCounts;
        if (_ape) {
            (result.reassigned || []).forEach(r => {
                _ape(r.bunk, r.from ? [r.from] : [], r.to || null, r.slots || []);
            });
            (result.failed || []).forEach(f => {
                _ape(f.bunk, f.originalActivity ? [f.originalActivity] : [], null, f.slots || []);
            });
        }
    } catch (_e) { console.warn('[ConflictBypass] post-edit counts failed:', _e); }

    // Notify the rotation tab so it refreshes after the bypass.
    try {
        const _rcDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunks: modifiedBunks, date: _rcDate, source: 'conflict-bypass' }
        }));
    } catch (_e) { /* non-fatal */ }

    // Track specific cells for temporary highlight
    const bypassedCellKeys = [];
    result.reassigned.forEach(r => {
        (r.slots || []).forEach(slotIdx => {
            bypassedCellKeys.push(`${r.bunk}:${slotIdx}`);
        });
    });
    result.failed.forEach(f => {
        (f.slots || []).forEach(slotIdx => {
            bypassedCellKeys.push(`${f.bunk}:${slotIdx}`);
        });
    });
    
    if (bypassedCellKeys.length > 0) {
        markCellsAsBypassed(bypassedCellKeys);
    }
    
    if (nonEditableConflicts.length > 0) {
        sendSchedulerNotification(
            [...new Set(nonEditableConflicts.map(c => c.bunk))],
            location, activity, 'bypassed'
        );
        if (window.showToast) {
            window.showToast(`Bypassed ${nonEditableConflicts.length} bunk(s) from other schedulers`, 'warning');
        }
    }
}
    }

    // ★ MS-4e: the NOTIFY choice must actually notify. With only other-user
    // conflicts, conflictsToResolve is empty, so the block above never ran —
    // the double-booking was created silently and no notification was ever
    // sent. Fire the conflict notification independently of whether any
    // same-user conflicts needed reassignment.
    if (!bypassMode && nonEditableConflicts.length > 0) {
        try {
            sendSchedulerNotification(
                [...new Set(nonEditableConflicts.map(c => c.bunk))],
                location, activity, 'conflict'
            );
            if (window.showToast) {
                window.showToast('Double-booking created — the other scheduler was notified', 'warning');
            }
        } catch (eN) { console.warn('[resolveConflictsAndApply] notify failed:', eN); }
    }

    return result;
}


// =========================================================================
// SMART REGENERATION FOR CONFLICTS (CROSS-DIVISION COMPATIBLE)
// =========================================================================
function smartRegenerateConflicts(pinnedBunk, pinnedSlots, pinnedField, pinnedActivity, conflicts, bypassMode = false, timeContext = {}) {
    console.log('[SmartRegen] *** SMART REGENERATION STARTED ***');
    console.log(`[SmartRegen] Pinned: ${pinnedBunk} claiming ${pinnedField}`);
    if (bypassMode) console.log('[SmartRegen] [BYPASS] BYPASS MODE ACTIVE');
    
   const { claimedStartMin, claimedEndMin, claimingDivision } = timeContext;
        const _rawActivityProps = window.getActivityProperties();
        let activityProperties = _rawActivityProps;

        // * DEMO FIX: activityProperties may be empty in demo mode
        if (window.__CAMPISTRY_DEMO_MODE__ && (!activityProperties || Object.keys(activityProperties).length === 0)) {
            console.warn('[SmartRegen] [DEMO] Demo: activityProperties empty — rebuilding');
            if (window.refreshActivityPropertiesFromFields) {
                window.refreshActivityPropertiesFromFields();
                activityProperties = window.activityProperties || {};
            }
            if (Object.keys(activityProperties).length === 0) {
                const settings = window.loadGlobalSettings?.() || {};
                const fields = settings.app1?.fields || [];
                const specials = settings.app1?.specialActivities || [];
                fields.forEach(f => {
                    if (f?.name) activityProperties[f.name] = {
                        type: 'field', available: f.available !== false,
                        sharableWith: f.sharableWith || { type: 'not_sharable', capacity: 1 },
                        sharable: f.sharableWith?.type !== 'not_sharable',
                        activities: f.activities || [],
                        rainyDayAvailable: f.rainyDayAvailable === true
                    };
                });
                specials.forEach(s => {
                    if (s?.name) activityProperties[s.name] = {
                        type: 'special', available: true,
                        sharableWith: s.sharableWith || { type: 'not_sharable', capacity: 1 },
                        rainyDayOnly: s.rainyDayOnly === true,
                        rainyDayExclusive: s.rainyDayExclusive === true
                    };
                });
                window.activityProperties = activityProperties;
                console.log('[SmartRegen] [DEMO] Built ' + Object.keys(activityProperties).length + ' entries from settings');
            }
        }    const results = { success: true, reassigned: [], failed: [], pinnedLock: null, bypassMode };
    
    // Lock the pinned field
    if (window.GlobalFieldLocks) {
        const pinnedDivName = getDivisionForBunk(pinnedBunk);
        window.GlobalFieldLocks.lockField(pinnedField, pinnedSlots, { 
            lockedBy: 'smart_regen_pinned', 
            division: pinnedDivName, 
            activity: pinnedActivity, 
            bunk: pinnedBunk,
            startMin: claimedStartMin,
            endMin: claimedEndMin
        });
        results.pinnedLock = { field: pinnedField, slots: pinnedSlots };
    }
    
    // Group conflicts by bunk with TIME information
    const conflictsByBunk = {};
    for (const conflict of conflicts) {
        const conflictBunk = conflict.bunk;
        if (!conflictsByBunk[conflictBunk]) {
            conflictsByBunk[conflictBunk] = {
                rawSlots: new Set(),
                division: conflict.division || getDivisionForBunk(conflictBunk),
                timeOverlaps: []
            };
        }
        conflictsByBunk[conflictBunk].rawSlots.add(conflict.slot);
        
        // Store time overlap info if available
        if (conflict.overlapStart !== undefined && conflict.overlapEnd !== undefined) {
            conflictsByBunk[conflictBunk].timeOverlaps.push({
                start: conflict.overlapStart,
                end: conflict.overlapEnd,
                theirSlot: conflict.theirSlot
            });
        }
    }
    
    const bunksToReassign = Object.keys(conflictsByBunk);
    console.log(`[SmartRegen] Bunks to reassign: ${bunksToReassign.join(', ')}`);
    
    // Build field usage map
    const fieldUsageBySlot = window.buildFieldUsageBySlot ? 
        window.buildFieldUsageBySlot(bunksToReassign) : {};
    
    // Register the pinned field usage
    for (const slotIdx of pinnedSlots) {
        if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
        if (!fieldUsageBySlot[slotIdx][pinnedField]) {
            fieldUsageBySlot[slotIdx][pinnedField] = { count: 0, bunks: {}, divisions: [] };
        }
        fieldUsageBySlot[slotIdx][pinnedField].count++;
        fieldUsageBySlot[slotIdx][pinnedField].bunks[pinnedBunk] = pinnedActivity;
    }
    
    // Sort bunks for consistent processing
    bunksToReassign.sort((a, b) => {
        const numA = parseInt((a.match(/\d+/) || [])[0]) || 0;
        const numB = parseInt((b.match(/\d+/) || [])[0]) || 0;
        return numA - numB;
    });
    
    // Process each conflicting bunk
    for (const bunk of bunksToReassign) {
        const conflictInfo = conflictsByBunk[bunk];
        const conflictDiv = conflictInfo.division;
        const conflictDivSlots = window.divisionTimes?.[conflictDiv] || [];
        
        console.log(`[SmartRegen] Processing ${bunk} (Division: ${conflictDiv})`);
        
        // * Find the CORRECT slot indices for THIS bunk's division *
        let actualSlots = [];
        
        if (conflictInfo.timeOverlaps.length > 0) {
            // Method 1: Use time overlap info (most accurate)
            for (const tr of conflictInfo.timeOverlaps) {
                if (tr.theirSlot !== undefined) {
                    actualSlots.push(tr.theirSlot);
                } else {
                    for (let i = 0; i < conflictDivSlots.length; i++) {
                        const slot = conflictDivSlots[i];
                        if (slot.startMin < tr.end && slot.endMin > tr.start) {
                            actualSlots.push(i);
                        }
                    }
                }
            }
        } else if (claimedStartMin !== null && claimedEndMin !== null) {
            // Method 2: Find slots by claimed time range
            for (let i = 0; i < conflictDivSlots.length; i++) {
                const slot = conflictDivSlots[i];
                if (slot && slot.startMin < claimedEndMin && slot.endMin > claimedStartMin) {
                    actualSlots.push(i);
                }
            }
        } else {
            // Method 3: Fallback - use raw slot indices
            actualSlots = [...conflictInfo.rawSlots];
            console.warn(`[SmartRegen] [!] No time info for ${bunk}, using raw slots`);
        }
        
        actualSlots = [...new Set(actualSlots)].sort((a, b) => a - b);
        
        if (actualSlots.length === 0) {
            console.warn(`[SmartRegen] No valid slots found for ${bunk}, skipping`);
            continue;
        }
        
        console.log(`[SmartRegen] ${bunk}: Actual slots in ${conflictDiv} = [${actualSlots.join(', ')}]`);
        
        // Get the original entry
        const originalEntry = window.scheduleAssignments?.[bunk]?.[actualSlots[0]];
        const originalActivity = originalEntry?._activity || originalEntry?.sport || fieldLabel(originalEntry?.field);
        
        console.log(`[SmartRegen] ${bunk}: Original activity = ${originalActivity}`);
        
        // Find best alternative
        const bestPick = findBestActivityForBunkDivisionAware(
            bunk, actualSlots, conflictDiv,
            fieldUsageBySlot, activityProperties, [pinnedField]
        );
        
        if (bestPick) {
            console.log(`[SmartRegen] [OK] ${bunk}: ${originalActivity} → ${bestPick.activityName} @ ${bestPick.field}`);
            
            applyPickToBunkDivisionAware(bunk, actualSlots, conflictDiv, bestPick, fieldUsageBySlot, activityProperties, { isBypass: bypassMode });
            
            results.reassigned.push({ 
                bunk, slots: actualSlots, division: conflictDiv,
                from: originalActivity || 'unknown', 
                to: bestPick.activityName, 
                field: bestPick.field, 
                cost: bestPick.cost 
            });
            
            if (window.showToast) {
                window.showToast(`-> ${bunk}: ${originalActivity} → ${bestPick.activityName}`, 'info');
            }
        } else {
            console.log(`[SmartRegen] [X] ${bunk}: No alternative found`);
            
            if (!window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = new Array(conflictDivSlots.length || 50);
            }
            
            const currentUserId = window.AccessControl?.getCurrentUserId?.() || 'unknown';
const currentUserName = window.AccessControl?.getCurrentUserName?.() || 'Another scheduler';

actualSlots.forEach((slotIdx, i) => {
    // Slice 4 audit fix — clear the prior fieldUsageBySlot entry for this
    // bunk/slot before parking at Free. Earlier this only mutated
    // scheduleAssignments; the triplet invariant
    // (scheduleAssignments / fieldUsageBySlot / GlobalFieldLocks) drifted
    // — scheduleAssignments said Free, fieldUsageBySlot still showed the
    // old claim, and subsequent capacity checks counted a phantom occupant.
    const _prevEntry = window.scheduleAssignments[bunk][slotIdx];
    const _prevField = _prevEntry ? (_prevEntry.field || _prevEntry.location || null) : null;
    if (_prevField && _prevField !== 'Free' && window.fieldUsageBySlot && window.fieldUsageBySlot[slotIdx]) {
        const fu = window.fieldUsageBySlot[slotIdx][_prevField];
        if (fu) {
            if (fu.bunks && bunk in fu.bunks) delete fu.bunks[bunk];
            fu.count = Math.max(0, (fu.count || 1) - 1);
            if (fu.count === 0) delete window.fieldUsageBySlot[slotIdx][_prevField];
        }
    }

    window.scheduleAssignments[bunk][slotIdx] = {
        field: 'Free', sport: null, continuation: i > 0,
        _fixed: false, _activity: 'Free',
        _smartRegenFailed: true, _originalActivity: originalActivity, _failedAt: Date.now(),
        _bypassModified: bypassMode,
        _bypassedBy: bypassMode ? currentUserId : null,
        _bypassedByName: bypassMode ? currentUserName : null,
        _bypassedAt: bypassMode ? Date.now() : null
    };
});
            
            results.failed.push({ 
                bunk, slots: actualSlots, division: conflictDiv,
                originalActivity, reason: 'No valid alternative found' 
            });
            results.success = false;
            
            if (window.showToast) {
                window.showToast(`${bunk}: No alternative found`, 'warning');
            }
        }
    }
    
    console.log(`[SmartRegen] *** COMPLETE: ${results.reassigned.length} reassigned, ${results.failed.length} failed ***`);
    return results;
}


// =========================================================================
// HELPER: Find Best Activity (DIVISION-AWARE)
// =========================================================================

// MS-5b: resolve the real time window for a bunk's slots. Prefer the
// displaced entry's stamped _startMin/_endMin, then the bunk's per-bunk
// slot table — the division-level table can disagree with both in auto
// mode (per-bunk timelines), which stamped smart-regen replacements at
// the wrong time (observed 850-855 vs the entry's real 905-945 slot).
function _resolveSlotWindow(bunk, divName, slots) {
    const first = window.scheduleAssignments?.[bunk]?.[slots[0]];
    if (first && typeof first._startMin === 'number' && typeof first._endMin === 'number') {
        const last = window.scheduleAssignments?.[bunk]?.[slots[slots.length - 1]];
        return {
            startMin: first._startMin,
            endMin: (last && typeof last._endMin === 'number') ? last._endMin : first._endMin
        };
    }
    const table = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)] || window.divisionTimes?.[divName] || [];
    const s = table[slots[0]], l = table[slots[slots.length - 1]];
    if (s && typeof s.startMin === 'number') {
        return { startMin: s.startMin, endMin: (l && typeof l.endMin === 'number') ? l.endMin : s.startMin + 30 };
    }
    return { startMin: null, endMin: null };
}

 function findBestActivityForBunkDivisionAware(bunk, slots, divName, fieldUsageBySlot, activityProperties, avoidFields = []) {
        const disabledFields = window.currentDisabledFields || [];
        const avoidSet = new Set(avoidFields.map(f => (f || '').toLowerCase()));

        // * DEMO FIX: Ensure activityProperties is populated in demo mode
        if (window.__CAMPISTRY_DEMO_MODE__ && (!activityProperties || Object.keys(activityProperties).length === 0)) {
            activityProperties = window.getActivityProperties?.() || window.activityProperties || {};
            if (Object.keys(activityProperties).length === 0 && window.refreshActivityPropertiesFromFields) {
                window.refreshActivityPropertiesFromFields();
                activityProperties = window.activityProperties || {};
            }
        }

    
    // Get time range for these slots (MS-5b: entry times > per-bunk table > division table)
    const _win = slots.length > 0 ? _resolveSlotWindow(bunk, divName, slots) : { startMin: null, endMin: null };
    let startMin = _win.startMin, endMin = _win.endMin;

    const candidates = buildCandidateOptions(slots, activityProperties, disabledFields, divName);
    const scoredPicks = [];
    
    for (const cand of candidates) {
        const fieldLower = (cand.field || '').toLowerCase();
        const actLower = (cand.activityName || '').toLowerCase();
        
        if (avoidSet.has(fieldLower) || avoidSet.has(actLower)) continue;
        
       // Check field availability by TIME
        if (!checkFieldAvailableByTime(cand.field, startMin, endMin, bunk, activityProperties)) continue;
        
        // Also check slot-based for backwards compat (MS-5b: pass the real window)
        if (!isFieldAvailable(cand.field, slots, bunk, fieldUsageBySlot, activityProperties, { startMin, endMin })) continue;
        
        // *** v4.1.2 FIX: Enforce accessRestrictions, timeRules & preferences ***
        // Without this, bumped bunks get assigned fields/specials their division can't access
        if (window.SchedulerCoreUtils?.canBlockFit) {
            const pseudoBlock = {
                bunk: bunk,
                divName: divName,
                startTime: startMin,
                endTime: endMin,
                slots: slots
            };
            if (!window.SchedulerCoreUtils.canBlockFit(pseudoBlock, cand.field, activityProperties, fieldUsageBySlot, cand.activityName)) {
                continue;
            }
        }
        
        const cost = calculatePenaltyCost(bunk, slots, cand, fieldUsageBySlot, activityProperties);
        if (cost < Infinity) {
            scoredPicks.push({ ...cand, cost });
        }
    }
    
    scoredPicks.sort((a, b) => a.cost - b.cost);
    return scoredPicks.length > 0 ? scoredPicks[0] : null;
}



// =========================================================================
// HELPER: Check Field Available By Time (CROSS-DIVISION SAFE v2)// *** v4.1.1: Now enforces sharableWith.type for cross-division rules ***
// =========================================================================
function checkFieldAvailableByTime(fieldName, startMin, endMin, excludeBunk, activityProperties) {
    if (startMin === null || endMin === null) return true;
    
    const props = activityProperties?.[fieldName] || {};
    const sharableWith = props.sharableWith || {};
    const sharingType = sharableWith.type || (props.sharable ? 'same_division' : 'not_sharable');
    let maxCapacity = 1;
    
    if (sharingType === 'all') { maxCapacity = parseInt(sharableWith.capacity) || 999; }
    else if (sharingType === 'not_sharable') { maxCapacity = 1; }
    else if (sharingType === 'same_division') { maxCapacity = parseInt(sharableWith.capacity) || 2; }
    else if (sharingType === 'custom') { maxCapacity = parseInt(sharableWith.capacity) || 2; }
    else if (sharableWith.capacity) { maxCapacity = parseInt(sharableWith.capacity); }
    else if (props.sharable) { maxCapacity = 2; }
    
    // *** v4.1.1: Determine the division of the bunk being placed ***
    const myDivision = getDivisionForBunk(excludeBunk);
    
    const divisions = window.divisions || {};
    let sameDivUsage = 0;
    
    for (const [dName, divData] of Object.entries(divisions)) {
        const dSlots = window.divisionTimes?.[dName] || [];
        
        for (const b of (divData.bunks || [])) {
            if (String(b) === String(excludeBunk)) continue;
            
            const assignments = window.scheduleAssignments?.[b] || [];
            
            for (let idx = 0; idx < dSlots.length; idx++) {
                const slot = dSlots[idx];
                if (!slot || slot.startMin === undefined) continue;
                
                // Check TIME overlap
                if (slot.startMin < endMin && slot.endMin > startMin) {
                    const entry = assignments[idx];
                    if (!entry || entry.continuation) continue;
                    
                    const entryField = fieldLabel(entry.field) || entry._activity;
                    if (entryField?.toLowerCase() === fieldName.toLowerCase()) {
                        
                        // *** CROSS-DIVISION ENFORCEMENT ***
                        if (sharingType === 'not_sharable') {
                            return false; // Any overlapping usage = blocked
                        }
                        
                        if (sharingType === 'same_division' && dName !== myDivision) {
                            // Different division using this field at overlapping time — BLOCKED
                            return false;
                        }
                        
                        if (sharingType === 'custom') {
                            const allowedDivs = sharableWith.divisions || [];
                            if (dName !== myDivision) {
                                if (!allowedDivs.includes(dName) || !allowedDivs.includes(myDivision)) {
                                    return false;
                                }
                            }
                        }
                        
                        // Same division (or type='all') — count toward capacity
                        sameDivUsage++;
                        if (sameDivUsage >= maxCapacity) return false;
                    }
                }
            }
        }
    }
     // *** COMBINED FIELD MUTUAL EXCLUSION CHECK ***
    if (window.FieldCombos?.isInCombo?.(fieldName)) {
        const comboCheck = window.FieldCombos.isBlockedByCombo(fieldName, startMin, endMin, excludeBunk);
        if (comboCheck.blocked) return false;
    }
    return true;
}


// =========================================================================
// HELPER: Apply Pick To Bunk (DIVISION-AWARE)
// =========================================================================
function applyPickToBunkDivisionAware(bunk, slots, divName, pick, fieldUsageBySlot, activityProperties, bypassInfo = {}) {
    const divSlots = window.divisionTimes?.[divName] || [];

    // MS-5b: read the window BEFORE overwriting the entry below —
    // the displaced entry's stamped times are the truest source.
    const _win = slots.length > 0 ? _resolveSlotWindow(bunk, divName, slots) : { startMin: null, endMin: null };
    let startMin = _win.startMin, endMin = _win.endMin;
    
    const currentUserId = window.AccessControl?.getCurrentUserId?.() || 'unknown';
    const currentUserName = window.AccessControl?.getCurrentUserName?.() || 'Another scheduler';
    
    const pickData = {
        field: pick.field,
        sport: pick.sport || pick.activityName,
        _fixed: true,
        _activity: pick.activityName,
        _smartRegenerated: true,
        _regeneratedAt: Date.now(),
        _startMin: startMin,
        _endMin: endMin,
        _blockStart: startMin,
        _division: divName,
        _bypassModified: bypassInfo.isBypass || false,
        _bypassedBy: bypassInfo.isBypass ? currentUserId : null,
        _bypassedByName: bypassInfo.isBypass ? currentUserName : null,
        _bypassedAt: bypassInfo.isBypass ? Date.now() : null
    };
    
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    if (!window.scheduleAssignments[bunk]) {
        window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
    }

    // Slice 4 audit N-2 — applyPickToBunkDivisionAware is the smart-regen
    // direct-write path. Earlier this trusted findBestActivity's upstream
    // checks, but those don't include disabledSports / activity-in-field /
    // cooldowns at commit. Route through the manual gate; soft-override
    // is allowed because the upstream picker already vetted basic shape.
    if (typeof window.commitManualWriteIfLegal === 'function' && pick.activityName) {
        const _check = window.commitManualWriteIfLegal(
            bunk, slots[0], pick.activityName, pick.field, divName,
            startMin, endMin,
            { allowSoftOverride: true, slotRange: slots }
        );
        if (!_check.ok && !_check.soft) {
            console.warn('[applyPickToBunkDivisionAware] BLOCKED:', _check.reason, 'for', bunk);
            return;
        }
    }

    slots.forEach((slotIdx, i) => {
        window.scheduleAssignments[bunk][slotIdx] = { ...pickData, continuation: i > 0 };
    });
    
    const fieldName = pick.field;
    for (const slotIdx of slots) {
        if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
        if (!fieldUsageBySlot[slotIdx][fieldName]) {
            fieldUsageBySlot[slotIdx][fieldName] = { count: 0, bunks: {}, divisions: [] };
        }
        fieldUsageBySlot[slotIdx][fieldName].count++;
        fieldUsageBySlot[slotIdx][fieldName].bunks[bunk] = pick.activityName;
        if (divName && !fieldUsageBySlot[slotIdx][fieldName].divisions.includes(divName)) {
            fieldUsageBySlot[slotIdx][fieldName].divisions.push(divName);
        }
    }
    
    if (window.TimeBasedFieldUsage?.register && startMin !== null && endMin !== null) {
        window.TimeBasedFieldUsage.register(fieldName, startMin, endMin, divName, bunk, pick.activityName);
    }
}
   

    function smartReassignBunkActivity(bunk, slots, avoidLocation) {
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) return { success: false };
        const originalActivity = entry._activity || entry.sport || fieldLabel(entry.field);
        const activityProps = getActivityProperties();
        const fieldUsageBySlot = window.buildFieldUsageBySlot?.([bunk]) || {};
        const bestPick = findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProps, [avoidLocation]);
        
        if (bestPick) {
            const _pickResult = applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProps);
            if (_pickResult && !_pickResult.ok) {
                return { success: false, reason: _pickResult.reason };
            }
if (window.showToast) window.showToast(`-> ${bunk}: Moved to ${bestPick.activityName}`, 'info');
            return { success: true, field: bestPick.field, activity: bestPick.activityName, cost: bestPick.cost };
        } else {
            const divName = getDivisionForBunk(bunk);
            const divSlots = window.divisionTimes?.[divName] || [];
            if (!window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
            }
            slots.forEach((slotIdx, i) => {
                // Slice 4 audit N-3 — clear prior field's fieldUsageBySlot
                // entry before parking at Free. Mirrors the fix at the
                // smartRegenerateConflicts no-alternative path. Earlier
                // the triplet invariant drifted here too.
                const _prevEntry = window.scheduleAssignments[bunk][slotIdx];
                const _prevField = _prevEntry ? (_prevEntry.field || _prevEntry.location || null) : null;
                if (_prevField && _prevField !== 'Free' && window.fieldUsageBySlot && window.fieldUsageBySlot[slotIdx]) {
                    const fu = window.fieldUsageBySlot[slotIdx][_prevField];
                    if (fu) {
                        if (fu.bunks && bunk in fu.bunks) delete fu.bunks[bunk];
                        fu.count = Math.max(0, (fu.count || 1) - 1);
                        if (fu.count === 0) delete window.fieldUsageBySlot[slotIdx][_prevField];
                    }
                }

                window.scheduleAssignments[bunk][slotIdx] = {
                    field: 'Free', sport: null, continuation: i > 0, _fixed: false, _activity: 'Free',
                    _noAlternative: true, _originalActivity: originalActivity, _originalField: avoidLocation
                };
            });
            if (window.showToast) window.showToast(`${bunk}: No alternative found`, 'warning');
            return { success: false, reason: 'No valid alternative found' };
        }
    }

    // =========================================================================
    // PINNED ACTIVITY PRESERVATION
    // =========================================================================

    function capturePinnedActivities(allowedDivisions) {
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        _pinnedSnapshot = {}; 
        _pinnedFieldLocks = [];
        let capturedCount = 0;
        
        let allowedBunks = null;
        if (allowedDivisions && allowedDivisions.length > 0) {
            allowedBunks = new Set();
            for (const divName of allowedDivisions) {
                const divInfo = divisions[divName];
                if (divInfo?.bunks) divInfo.bunks.forEach(b => allowedBunks.add(String(b)));
            }
        }
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (allowedBunks && !allowedBunks.has(String(bunkName))) continue;
            if (!slots || !Array.isArray(slots)) continue;
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    if (!_pinnedSnapshot[bunkName]) _pinnedSnapshot[bunkName] = {};
                    _pinnedSnapshot[bunkName][slotIdx] = { ...entry, _preservedAt: Date.now() };
                    capturedCount++;
                    const fName = fieldLabel(entry.field);
                    if (fName && fName !== 'Free') {
                        _pinnedFieldLocks.push({ field: fName, slot: slotIdx, bunk: bunkName, activity: entry._activity || fName });
                    }
                }
            }
        }
        console.log(`[PinnedPreserve] [PIN] Captured ${capturedCount} pinned activities`);
        return _pinnedSnapshot;
    }

    function registerPinnedFieldLocks() {
        if (!window.GlobalFieldLocks) return;
        const divisions = window.divisions || {};
        for (const lockInfo of _pinnedFieldLocks) {
            const divName = Object.keys(divisions).find(d => divisions[d]?.bunks?.some(b => String(b) === String(lockInfo.bunk)));
            window.GlobalFieldLocks.lockField(lockInfo.field, [lockInfo.slot], { 
                lockedBy: 'pinned_activity', division: divName || 'unknown', activity: lockInfo.activity, bunk: lockInfo.bunk, _pinnedLock: true 
            });
        }
    }

    function registerPinnedFieldUsage(fieldUsageBySlot, activityProps) {
        if (!fieldUsageBySlot) return;
        const divisions = window.divisions || {};
        for (const lockInfo of _pinnedFieldLocks) {
            const slotIdx = lockInfo.slot, fName = lockInfo.field;
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fName]) fieldUsageBySlot[slotIdx][fName] = { count: 0, divisions: [], bunks: {}, _locked: true, _fromPinned: true };
            const usage = fieldUsageBySlot[slotIdx][fName];
            usage.count++; 
            usage.bunks[lockInfo.bunk] = lockInfo.activity;
            const divName = Object.keys(divisions).find(d => divisions[d]?.bunks?.some(b => String(b) === String(lockInfo.bunk)));
            if (divName && !usage.divisions.includes(divName)) usage.divisions.push(divName);
        }
    }

    function restorePinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        let restoredCount = 0;
        for (const [bunkName, pinnedSlots] of Object.entries(_pinnedSnapshot)) {
            const divName = getDivisionForBunk(bunkName);
            const divSlots = window.divisionTimes?.[divName] || [];
            if (!assignments[bunkName]) assignments[bunkName] = new Array(divSlots.length || 50);
            for (const [slotIdxStr, entry] of Object.entries(pinnedSlots)) {
                assignments[bunkName][parseInt(slotIdxStr, 10)] = { ...entry, _restoredAt: Date.now() };
                restoredCount++;
            }
        }
        console.log(`[PinnedPreserve] [OK] Restored ${restoredCount} pinned activities`);
        return restoredCount;
    }

    function getPinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        const pinned = [];
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    pinned.push({ 
                        bunk: bunkName, slot: slotIdx, activity: entry._activity || entry.field, 
                        field: fieldLabel(entry.field), editedAt: entry._editedAt || entry._preservedAt 
                    });
                }
            }
        }
        return pinned;
    }

    function unpinActivity(bunk, slotIdx) {
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry) { 
            delete entry._pinned; 
            delete entry._postEdit; 
            entry._unpinnedAt = Date.now(); 
            saveSchedule(); 
            updateTable(); 
            return true; 
        }
        return false;
    }

    function unpinAllActivities() {
        const assignments = window.scheduleAssignments || {};
        let unpinnedCount = 0;
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) { 
                    delete entry._pinned; 
                    delete entry._postEdit; 
                    entry._unpinnedAt = Date.now(); 
                    unpinnedCount++; 
                }
            }
        }
        saveSchedule(); 
        updateTable();
        return unpinnedCount;
    }

    // =========================================================================
    // LEAGUE MATCHUPS RETRIEVAL
    // =========================================================================

    function getLeagueMatchups(divName, slotIdx) {
        const leagues = window.leagueAssignments || {};
        if (leagues[divName]?.[slotIdx]) {
            const data = leagues[divName][slotIdx];
            return { matchups: data.matchups || [], gameLabel: data.gameLabel || '', sport: data.sport || '', leagueName: data.leagueName || '' };
        }
        if (leagues[divName]) {
            const divSlotKeys = Object.keys(leagues[divName]).map(Number).sort((a, b) => a - b);
            for (const storedSlot of divSlotKeys) {
                if (Math.abs(storedSlot - slotIdx) <= 2) {
                    const data = leagues[divName][storedSlot];
                    if (data && (data.matchups?.length > 0 || data.gameLabel)) return { matchups: data.matchups || [], gameLabel: data.gameLabel || '', sport: data.sport || '', leagueName: data.leagueName || '' };
                }
            }
        }
        const rawMasterLeagues = window.masterLeagues || window.loadGlobalSettings?.()?.app1?.leagues || [];
        let masterLeaguesList = Array.isArray(rawMasterLeagues) ? rawMasterLeagues : Object.values(rawMasterLeagues);
        const applicableLeagues = masterLeaguesList.filter(l => l?.name && l?.divisions?.includes(divName));
        if (applicableLeagues.length > 0) {
            const league = applicableLeagues[0], teams = league.teams || [];
            if (teams.length >= 2) {
                const displayMatchups = [];
                for (let i = 0; i < teams.length - 1; i += 2) { 
                    if (teams[i + 1]) displayMatchups.push({ teamA: teams[i], teamB: teams[i + 1], display: `${teams[i]} vs ${teams[i + 1]}` }); 
                }
                if (teams.length % 2 === 1) displayMatchups.push({ teamA: teams[teams.length - 1], teamB: 'BYE', display: `${teams[teams.length - 1]} (BYE)` });
                return { matchups: displayMatchups, gameLabel: `${league.name} Game`, sport: league.sports?.[0] || 'League', leagueName: league.name };
            }
        }
        return { matchups: [], gameLabel: '', sport: '', leagueName: '' };
    }

    // =========================================================================
    // TRANSPOSED VIEW (bunks down Y-axis, time across X-axis)
    // =========================================================================

    var TRANSPOSED_INCREMENT_OPTIONS = [10, 15, 20, 30, 40, 45, 60];

    function _getTransposedIncrement() {
        try {
            var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var v = parseInt(gs.scheduleViewIncrement, 10);
            if (TRANSPOSED_INCREMENT_OPTIONS.indexOf(v) >= 0) return v;
        } catch (_) {}
        return 30;
    }

    function _setTransposedIncrement(val) {
        try { window.saveGlobalSettings && window.saveGlobalSettings('scheduleViewIncrement', val); }
        catch (_) {}
    }

    function _renderIncrementPicker() {
        var bar = document.createElement('div');
        bar.className = 'schedule-toolbar';
        bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:12px;font-size:0.85rem;color:#374151;';
        var label = document.createElement('span');
        label.textContent = 'Time increment:';
        label.style.fontWeight = '600';
        bar.appendChild(label);
        var sel = document.createElement('select');
        sel.style.cssText = 'padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.85rem;background:#fff;font-family:inherit;';
        var current = _getTransposedIncrement();
        TRANSPOSED_INCREMENT_OPTIONS.forEach(function (v) {
            var opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v + ' min';
            if (v === current) opt.selected = true;
            sel.appendChild(opt);
        });
        sel.onchange = function () {
            _setTransposedIncrement(parseInt(sel.value, 10));
            updateTable();
        };
        bar.appendChild(sel);
        return bar;
    }

    function _buildTimeColumns(increment) {
        var allTimes = [];
        var boundarySet = {};      // every distinct slot edge across all divisions
        var dt = window.divisionTimes || {};
        Object.keys(dt).forEach(function (divName) {
            (dt[divName] || []).forEach(function (s) {
                if (typeof s.startMin === 'number') { allTimes.push(s.startMin); boundarySet[s.startMin] = true; }
                if (typeof s.endMin === 'number') { allTimes.push(s.endMin); boundarySet[s.endMin] = true; }
            });
        });
        if (allTimes.length === 0) return [];
        var dayStart = Math.min.apply(null, allTimes);
        var dayEnd = Math.max.apply(null, allTimes);
        // ★ Do NOT snap dayStart down to the increment grid. Snapping a 12:20
        //   camp-wide start to 12:00 fabricated a leading column nobody
        //   occupies — rendered as a striped "hasn't started" band for every
        //   bunk. Columns start at the true earliest minute; a day that
        //   already starts on a clean boundary renders exactly as before.
        // The renderer point-samples each column at its startMin
        // (_findSlotIndexAtTime), so a slot shorter than `increment` that
        // falls BETWEEN two grid ticks (e.g. a 25-min 11:50-12:15 Lunch under a
        // 40-min increment: ticks at 11:40 and 12:20 both miss it) is sampled
        // by no column and vanishes entirely. Build the grid from the union of
        // the regular increment ticks AND every slot boundary, so each slot
        // always owns at least one column.
        var pointSet = {};
        for (var t = dayStart; t < dayEnd; t += increment) pointSet[t] = true;
        Object.keys(boundarySet).forEach(function (b) {
            var bn = +b;
            if (bn >= dayStart && bn < dayEnd) pointSet[bn] = true;
        });
        var points = Object.keys(pointSet).map(Number).sort(function (a, b) { return a - b; });
        var cols = [];
        for (var i = 0; i < points.length; i++) {
            cols.push({ startMin: points[i], endMin: (i + 1 < points.length) ? points[i + 1] : dayEnd });
        }
        return cols;
    }

    // ─── Schedule zoom (trackpad pinch / Ctrl+scroll) ────────────────────
    // Trackpad pinch gestures arrive in the browser as wheel events with
    // ctrlKey set: pinch-out (spread) → negative deltaY → zoom IN (bigger,
    // less of the schedule on screen); pinch-in → positive deltaY → zoom
    // OUT (smaller, more on screen). Ctrl+scroll on a mouse maps to the
    // same path. Plain two-finger scrolling (no ctrlKey) passes through.
    var SCHEDULE_ZOOM_KEY = 'campistry_schedule_zoom_v1';
    function _getScheduleZoom() {
        try {
            var z = parseFloat(localStorage.getItem(SCHEDULE_ZOOM_KEY));
            return (z >= 0.4 && z <= 2.5) ? z : 1;
        } catch (_) { return 1; }
    }
    function _applyScheduleZoom(container) {
        var z = _getScheduleZoom();
        container.style.zoom = (z === 1) ? '' : String(z);
    }
    function _wireScheduleZoom(container) {
        if (container._zoomWired) return;
        container._zoomWired = true;
        container.addEventListener('wheel', function (e) {
            if (!e.ctrlKey) return;
            e.preventDefault();   // keep the BROWSER from page-zooming; we zoom the schedule instead
            var z = _getScheduleZoom();
            // Exponential step: equal pinch effort = equal relative change,
            // smooth on trackpads, ~±25% per notch on a ctrl+scroll mouse.
            z *= Math.exp(-e.deltaY * 0.0025);
            z = Math.max(0.4, Math.min(2.5, z));
            z = Math.round(z * 100) / 100;
            try { localStorage.setItem(SCHEDULE_ZOOM_KEY, String(z)); } catch (_) {}
            container.style.zoom = (z === 1) ? '' : String(z);
        }, { passive: false });
    }

    // Compact per-grade time ruler — repeated under each division band so
    // the time axis is visible right next to every grade, not only at the
    // top of the table.
    function _buildGradeTimelineRow(timeColumns) {
        var tr = document.createElement('tr');
        tr.className = 'grade-timeline-row';
        var lead = document.createElement('td');
        lead.textContent = '';
        lead.style.cssText = 'position: sticky; left: 0; z-index: 1; background: #f8fafc; border-right: 2px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; padding: 2px 12px;';
        tr.appendChild(lead);
        timeColumns.forEach(function (col) {
            var td = document.createElement('td');
            var isHour = (col.startMin % 60) === 0;
            td.textContent = minutesToTimeLabel(col.startMin);
            td.style.cssText = 'padding: 2px 6px; background: #f8fafc; color: ' + (isHour ? '#334155' : '#94a3b8') + '; font-weight: ' + (isHour ? '700' : '500') + '; font-size: 0.68rem; white-space: nowrap; border-left: ' + (isHour ? '2px solid #cbd5e1' : '1px solid #f1f5f9') + '; border-bottom: 1px solid #e5e7eb; text-align: left;';
            tr.appendChild(td);
        });
        return tr;
    }

    function _findSlotIndexAtTime(divSlots, colStartMin) {
        if (!divSlots || divSlots.length === 0) return -1;
        for (var i = 0; i < divSlots.length; i++) {
            var s = divSlots[i];
            if (s.startMin <= colStartMin && s.endMin > colStartMin) return i;
        }
        return -1;
    }

    function _entrySignatureForMerge(entry) {
        if (!entry) return '__empty__';
        var keys = ['field', 'sport', '_activity', 'event', 'location', 'swimLocation', 'reservedLocation', '_gameLabel', '_leagueName'];
        return keys.map(function (k) { return entry[k] == null ? '' : String(entry[k]); }).join('|');
    }

    // For a given division slot index, decide whether every bunk in the
    // division has identical content there (Lunch, league, full-grade swim,
    // etc.). When true, the renderer merges those cells into a single cell
    // spanning rowspan = bunks.length so the activity is shown once.
    function _slotIsFullDivisionMerge(slotIdx, bunks, divSlots) {
        if (!bunks || bunks.length < 2) return false;
        // League slots: matchup data lives in leagueAssignments and applies to
        // the whole grade, so always merge regardless of per-bunk entries.
        var slot = divSlots && divSlots[slotIdx];
        if (slot && isLeagueBlockType(slot.event, slot.type)) return true;
        var firstSig = null;
        for (var i = 0; i < bunks.length; i++) {
            var entry = (window.scheduleAssignments && window.scheduleAssignments[bunks[i]]) ? window.scheduleAssignments[bunks[i]][slotIdx] : null;
            var sig = _entrySignatureForMerge(entry);
            if (sig === '__empty__') return false;
            if (firstSig === null) firstSig = sig;
            else if (sig !== firstSig) return false;
        }
        return true;
    }

    function _renderTransposedLeagueCell(block, bunk, divName, slotIdx) {
        var td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; vertical-align: top; border-bottom: 1px solid #e5e7eb; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border-left: 4px solid #0284c7;';

        var leagueInfo = (typeof getLeagueMatchups === 'function') ? getLeagueMatchups(divName, slotIdx) : null;
        if (!leagueInfo) leagueInfo = {};

        // Header is just the game label ("Game 2") — no emoji, no sport. Each
        // matchup line carries its own sport, so a single header sport is
        // wrong whenever the game's matchups play different sports.
        var title = leagueInfo.gameLabel || block.event || 'League';

        var html = '<div style="font-weight: 700; font-size: 0.82rem; color: #0369a1; margin-bottom: 6px;">' + escapeHtml(title) + '</div>';

        var matchups = leagueInfo.matchups || [];
        if (matchups.length > 0) {
            html += '<div style="display: flex; flex-direction: column; gap: 3px;">';
            matchups.forEach(function (m) {
                var line;
                if (typeof m === 'string') {
                    line = m;
                } else if (m && (m.teamA || m.team1)) {
                    var a = m.teamA || m.team1 || '';
                    var b = m.teamB || m.team2 || '';
                    var sport = m.sport || leagueInfo.sport || '';
                    var field = m.field || '';
                    line = a + ' vs ' + b;
                    if (sport) line += ' — ' + (sport.charAt(0).toUpperCase() + sport.slice(1));
                    if (field) line += ' (' + field + ')';
                } else if (m && m.display) {
                    line = m.display;
                } else {
                    line = JSON.stringify(m);
                }
                html += '<div style="background: #fff; padding: 3px 7px; border-radius: 4px; font-size: 0.74rem; color: #1e3a5f; box-shadow: 0 1px 1px rgba(0,0,0,0.04); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + escapeHtml(line) + '</div>';
            });
            html += '</div>';
        } else {
            html += '<div style="color: #64748b; font-size: 0.74rem; font-style: italic;">No matchups yet</div>';
        }
        td.innerHTML = html;
        return td;
    }

    function renderTransposedView(container) {
        if (!container) { container = document.getElementById('scheduleTable'); if (!container) return; }

        // ★★★ PERF FIX: Skip render when the schedule tab is hidden.
        // Multiple callers invoke renderStaggeredView/updateTable during init
        // while the tab has display:none — rendering 7+ divisions of DOM
        // that will never be seen. Instead, mark dirty and render once when
        // the tab becomes visible.
        var _schedTabEl = container.closest('.tab-content') || document.getElementById('schedule');
        if (_schedTabEl && window.getComputedStyle(_schedTabEl).display === 'none') {
            window._scheduleNeedsRender = true;
            return;
        }

        var dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        if (!window._postEditInProgress) loadScheduleForDate(dateKey);

        var skeleton = getSkeleton(dateKey);
        var divisions = window.divisions || {};
        var divisionTimes = window.divisionTimes || {};

        console.log('[UnifiedSchedule] RENDER STATE:', {
            dateKey: dateKey,
            skeletonBlocks: skeleton.length,
            divisionTimesCount: Object.keys(divisionTimes).length,
            scheduleAssignmentsBunks: Object.keys(window.scheduleAssignments || {}).length,
            divisionsCount: Object.keys(divisions).length,
            mode: 'transposed'
        });

        container.innerHTML = '';

        // Pinch-zoom: wire once (survives re-renders — innerHTML resets don't
        // clear the container's own listeners) and re-apply the saved factor.
        // Applies to both the manual flat table and the auto per-division grids.
        _wireScheduleZoom(container);
        _applyScheduleZoom(container);

        // Empty-state (mirrors the legacy view's check)
        if ((!skeleton || skeleton.length === 0) && Object.keys(divisionTimes).length === 0) {
            container.innerHTML = '<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No daily schedule structure found for this date.</p><p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p></div>';
            return;
        }

        // Auto mode delegates per-division to the AutoScheduleGrid (which has
        // its own transposed renderer with time-scaled positioning, league
        // and trip overlays, free-gap clickers, etc.). Manual mode uses the
        // unified flat table built below.
        var currentBuilderMode = (window.getCampBuilderMode && window.getCampBuilderMode()) || window._daBuilderMode || 'manual';
        if (currentBuilderMode === 'auto' && window.AutoScheduleGrid && window.AutoScheduleGrid.render) {
            var divisionsAuto = Object.keys(divisions);
            if (divisionsAuto.length === 0 && window.availableDivisions) divisionsAuto = window.availableDivisions;
            divisionsAuto = (typeof window.getUserDivisionOrder === 'function')
                ? window.getUserDivisionOrder(divisionsAuto)
                : divisionsAuto.sort(function (a, b) {
                    var na = parseInt(a), nb = parseInt(b);
                    if (!isNaN(na) && !isNaN(nb)) return na - nb;
                    return String(a).localeCompare(String(b));
                });
            var autoEditable = (window.AccessControl && window.AccessControl.getEditableDivisions && window.AccessControl.getEditableDivisions()) || divisionsAuto;
            var autoWrapper = document.createElement('div');
            autoWrapper.style.cssText = 'display:flex;flex-direction:column;gap:24px;';
            divisionsAuto.forEach(function (divName) {
                if (!shouldShowDivision(divName)) return;
                var divInfo = divisions[divName];
                if (!divInfo) return;
                // Honor the user-defined bunk order from campStructure verbatim.
                var bunks = (divInfo.bunks || []).slice();
                if (bunks.length === 0) return;
                var isEditable = autoEditable.indexOf(divName) >= 0;
                var el = window.AutoScheduleGrid.render(divName, divInfo, bunks, isEditable);
                if (el) autoWrapper.appendChild(el);
            });
            container.appendChild(autoWrapper);
            window._scheduleNeedsRender = false;
            window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', { detail: { dateKey: dateKey } }));
            return;
        }

        // ★ MODE ISOLATION (double-lunch fix — render rebuild): the manual flat-table draws
        //   from the div-level slot array (divisionTimes[div]). A divisionTimes hydrated from a
        //   save — or left over from auto mode — can carry AUTO per-bunk geometry (fine-grained
        //   slot windows that cross the pinned 12:00 lunch), which mis-maps activities onto the
        //   wrong columns (the "double lunch"); or it can be absent entirely on a cold load.
        //   Rebuild clean div-level geometry from THIS day's manual skeleton so the manual grid
        //   is always driven by its own skeleton, never by auto geometry. buildFromSkeleton is
        //   idempotent for a manual skeleton, and this is gated to manual mode (the auto branch
        //   returned above), so auto rendering is untouched.
        try {
            if (skeleton && skeleton.length && window.DivisionTimesSystem && window.DivisionTimesSystem.buildFromSkeleton) {
                var _miRebuilt = window.DivisionTimesSystem.buildFromSkeleton(skeleton, divisions);
                if (_miRebuilt && Object.keys(_miRebuilt).length) {
                    Object.keys(_miRebuilt).forEach(function (g) {
                        if (_miRebuilt[g]) { delete _miRebuilt[g]._isPerBunk; delete _miRebuilt[g]._perBunkSlots; }
                    });
                    divisionTimes = _miRebuilt;
                    window.divisionTimes = _miRebuilt;
                }
            }
        } catch (_eMIR) { /* non-fatal — fall back to the existing divisionTimes */ }

        // Toolbar with increment picker
        container.appendChild(_renderIncrementPicker());

        // Resolve & sort divisions
        var divisionsToShow = Object.keys(divisions);
        if (divisionsToShow.length === 0 && window.availableDivisions) divisionsToShow = window.availableDivisions;
        divisionsToShow = (typeof window.getUserDivisionOrder === 'function')
            ? window.getUserDivisionOrder(divisionsToShow)
            : divisionsToShow.sort(function (a, b) {
                var na = parseInt(a), nb = parseInt(b);
                if (!isNaN(na) && !isNaN(nb)) return na - nb;
                return String(a).localeCompare(String(b));
            });

        if (divisionsToShow.length === 0) {
            container.innerHTML += '<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No divisions configured.</p></div>';
            return;
        }

        var increment = _getTransposedIncrement();
        var timeColumns = _buildTimeColumns(increment);
        if (timeColumns.length === 0) {
            container.innerHTML += '<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No time slots available for this date.</p></div>';
            return;
        }

        var editableDivisions = (window.AccessControl && window.AccessControl.getEditableDivisions && window.AccessControl.getEditableDivisions()) || divisionsToShow;

        // Build a single big table: columns = bunk + time slots; rows = bunks grouped by division
        var table = document.createElement('table');
        table.className = 'schedule-flat-table';
        table.style.cssText = 'border-collapse: collapse; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; background: #fff; font-size: 0.85rem;';

        // Header
        var thead = document.createElement('thead');
        var thr = document.createElement('tr');
        thr.style.background = '#f3f4f6';
        var thBunk = document.createElement('th');
        thBunk.textContent = 'Bunk';
        thBunk.style.cssText = 'position: sticky; left: 0; z-index: 2; background: #f3f4f6; padding: 10px 12px; font-weight: 700; color: #111827; border-bottom: 2px solid #e5e7eb; min-width: 110px; text-align: left;';
        thr.appendChild(thBunk);
        timeColumns.forEach(function (col) {
            var th = document.createElement('th');
            th.textContent = minutesToTimeLabel(col.startMin);
            var isHour = (col.startMin % 60) === 0;
            var leftBorder = isHour ? '2px solid #cbd5e1' : '1px solid #f1f5f9';
            th.style.cssText = 'padding: 8px 6px; font-weight: ' + (isHour ? '700' : '500') + '; color: ' + (isHour ? '#111827' : '#6b7280') + '; border-bottom: 2px solid #e5e7eb; border-left: ' + leftBorder + '; white-space: nowrap; min-width: 78px; font-size: 0.78rem;';
            thr.appendChild(th);
        });
        thead.appendChild(thr);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');

        divisionsToShow.forEach(function (divName) {
            if (!shouldShowDivision(divName)) return;
            var divInfo = divisions[divName];
            if (!divInfo) return;
            // ★ FN-49: divInfo.bunks already carries the user's Camp Structure
            //   order (drag-reorderable on the Me page) — render it as-is.
            //   The old alphanumeric sort silently discarded custom orders.
            var bunks = (divInfo.bunks || []).slice();
            if (bunks.length === 0) return;
            var divSlots = divisionTimes[divName] || [];
            var divColor = divInfo.color || '#4b5563';
            var isEditable = editableDivisions.indexOf(divName) >= 0;

            // Division group header row
            var ghTr = document.createElement('tr');
            var ghTd = document.createElement('td');
            ghTd.colSpan = 1 + timeColumns.length;
            ghTd.style.cssText = 'background: ' + divColor + '; color: #fff; padding: 8px 12px; font-size: 0.95rem; font-weight: 700; letter-spacing: 0.02em;';
            ghTd.textContent = divName + (isEditable ? '' : ' [LOCKED]');
            ghTr.appendChild(ghTd);
            tbody.appendChild(ghTr);

            // Per-grade time ruler directly under the division band, so the
            // time axis is readable next to every grade when scrolled down.
            tbody.appendChild(_buildGradeTimelineRow(timeColumns));

            // Pre-compute which slots in this division have identical content
            // for every bunk — those will merge into a single rowspan cell.
            var mergeSlots = {}; // slotIdx -> true
            for (var msi = 0; msi < divSlots.length; msi++) {
                if (_slotIsFullDivisionMerge(msi, bunks, divSlots)) mergeSlots[msi] = true;
            }

            bunks.forEach(function (bunk, bi) {
                var tr = document.createElement('tr');
                tr.style.background = bi % 2 === 0 ? '#fff' : '#fafafa';

                var tdBunk = document.createElement('td');
                tdBunk.textContent = bunk;
                tdBunk.style.cssText = 'position: sticky; left: 0; z-index: 1; background: ' + (bi % 2 === 0 ? '#fff' : '#fafafa') + '; padding: 8px 12px; font-weight: 600; color: #1f2937; border-right: 2px solid #e5e7eb; white-space: nowrap;';
                tr.appendChild(tdBunk);

                // For each time column, find which division slot covers it.
                // Render once per slot with colspan = number of columns inside that slot.
                var ci = 0;
                while (ci < timeColumns.length) {
                    var col = timeColumns[ci];
                    var isHourMark = (col.startMin % 60) === 0;
                    var leftBorder = isHourMark ? '2px solid #cbd5e1' : '1px solid #f1f5f9';

                    var slotIdx = _findSlotIndexAtTime(divSlots, col.startMin);

                    // Full-division merge: if this slot merges and we're not the
                    // first bunk, skip the cell — it's covered by the rowspan
                    // from the first bunk's cell above.
                    if (slotIdx >= 0 && mergeSlots[slotIdx] && bi > 0) {
                        var slotForSkip = divSlots[slotIdx];
                        var skipSpan = 1;
                        while (ci + skipSpan < timeColumns.length && timeColumns[ci + skipSpan].startMin < slotForSkip.endMin && timeColumns[ci + skipSpan].startMin >= slotForSkip.startMin) {
                            skipSpan++;
                        }
                        ci += skipSpan;
                        continue;
                    }

                    if (slotIdx < 0) {
                        // No slot — division hasn't started yet or has ended.
                        // Render a greyed-out striped cell so the timeline gap is obvious.
                        var emptyTd = document.createElement('td');
                        emptyTd.style.cssText = 'padding: 6px; border-left: ' + leftBorder + '; border-bottom: 1px solid #f1f5f9; background: repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 5px, #e5e7eb 5px, #e5e7eb 10px); color: #9ca3af;';
                        emptyTd.textContent = '';
                        tr.appendChild(emptyTd);
                        ci++;
                        continue;
                    }
                    var slot = divSlots[slotIdx];
                    // Count subsequent columns that fall inside the same slot.
                    var span = 1;
                    while (ci + span < timeColumns.length && timeColumns[ci + span].startMin < slot.endMin && timeColumns[ci + span].startMin >= slot.startMin) {
                        span++;
                    }
                    // Build a block object compatible with renderBunkCell.
                    var blockObj = {
                        slotIndex: slotIdx,
                        startMin: slot.startMin,
                        endMin: slot.endMin,
                        event: slot.event || 'GA',
                        type: slot.type || 'slot',
                        division: divName,
                        _splitHalf: slot._splitHalf,
                        _splitParentEvent: slot._splitParentEvent,
                        _isSplitTile: !!slot._splitHalf,
                        electiveActivities: slot.electiveActivities,
                        reservedFields: slot.reservedFields,
                        location: slot.location,
                        swimLocation: slot.swimLocation,
                        _preChangeMin: slot._preChangeMin,
                        _postChangeMin: slot._postChangeMin
                    };
                    var td;
                    if (isLeagueBlockType(blockObj.event, blockObj.type)) {
                        td = _renderTransposedLeagueCell(blockObj, bunk, divName, slotIdx);
                    } else {
                        td = renderBunkCell(blockObj, bunk, divName, isEditable);
                    }
                    // Apply the hour-mark left border so the timeline guide
                    // shows up regardless of which renderer produced the cell.
                    td.style.borderLeft = leftBorder;
                    if (span > 1) td.colSpan = span;
                    // Full-division merge: this cell on the first bunk's row
                    // covers all bunks in the division for this slot.
                    if (mergeSlots[slotIdx] && bi === 0 && bunks.length > 1) {
                        td.rowSpan = bunks.length;
                        td.style.verticalAlign = 'middle';
                    }
                    tr.appendChild(td);
                    ci += span;
                }

                tbody.appendChild(tr);
            });
        });

        table.appendChild(tbody);

        var scrollWrap = document.createElement('div');
        scrollWrap.style.cssText = 'overflow-x: auto; border: 1px solid #e5e7eb; border-radius: 8px;';
        scrollWrap.appendChild(table);
        container.appendChild(scrollWrap);

        if (window.MultiSchedulerAutonomous && window.MultiSchedulerAutonomous.applyBlockingToGrid) {
            setTimeout(function () { window.MultiSchedulerAutonomous.applyBlockingToGrid(); }, 50);
        }
        window._scheduleNeedsRender = false;
        window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', { detail: { dateKey: dateKey } }));
    }

    // =========================================================================
    // MAIN RENDER FUNCTION
    // =========================================================================

    // Legacy per-division stacked view, retained as fallback. The default
    // entry point now delegates to renderTransposedView (bunks down Y-axis,
    // time across X-axis). To force the legacy layout, call _renderStaggeredView.
    function renderStaggeredView(container) {
        if (!container) container = document.getElementById('scheduleTable');
        return renderTransposedView(container);
    }

    function _renderStaggeredViewLegacy(container) {
        if (!container) { container = document.getElementById('scheduleTable'); if (!container) return; }
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        if (!window._postEditInProgress) loadScheduleForDate(dateKey);
        else console.log('[UnifiedSchedule] [GUARD] RENDER: Using in-memory data (post-edit in progress)');
        
        const skeleton = getSkeleton(dateKey);
        const divisions = window.divisions || {};
        
        console.log('[UnifiedSchedule] RENDER STATE:', { 
    dateKey, 
    skeletonBlocks: skeleton.length, 
    divisionTimesCount: Object.keys(window.divisionTimes || {}).length,
    scheduleAssignmentsBunks: Object.keys(window.scheduleAssignments || {}).length, 
    divisionsCount: Object.keys(divisions).length,
    bypassCellsTracked: _myBypassedCells?.size || 0
});
        
        container.innerHTML = '';
        if (!skeleton || skeleton.length === 0) {
            // *** AUTO MODE FALLBACK: If divisionTimes + scheduleAssignments exist, proceed without skeleton ***
            const currentBuilderMode = window.getCampBuilderMode?.() || window._daBuilderMode || 'manual';
            const hasDivTimes = window.divisionTimes && Object.keys(window.divisionTimes).length > 0;
            const hasAssignments = window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0;
            if (currentBuilderMode === 'auto' && hasDivTimes && hasAssignments) {
                console.log('[UnifiedSchedule] Auto mode: no skeleton but divisionTimes+assignments exist — proceeding with auto renderer');
            } else {
                container.innerHTML = `<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No daily schedule structure found for this date.</p><p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p></div>`;
                return;
            }
        }
        
        let divisionsToShow = Object.keys(divisions);
        if (divisionsToShow.length === 0 && window.availableDivisions) divisionsToShow = window.availableDivisions;
        if (typeof window.getUserDivisionOrder === 'function') {
            divisionsToShow = window.getUserDivisionOrder(divisionsToShow);
        }
        
        if (divisionsToShow.length === 0) { 
            container.innerHTML = `<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No divisions configured.</p></div>`; 
            return; 
        }
        
        const wrapper = document.createElement('div');
        wrapper.className = 'schedule-view-wrapper';
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 24px;';
        
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || divisionsToShow;
        
      // *** AUTO BUILD: Choose renderer based on CURRENT mode + schedule type ***
        // Must check current mode to prevent stale flag from forcing wrong renderer
        const currentBuilderMode = window.getCampBuilderMode?.() || window._daBuilderMode || 'manual';
const isAutoSchedule = currentBuilderMode === 'auto';
        
        divisionsToShow.forEach(divName => {
            if (!shouldShowDivision(divName)) return;
            const divInfo = divisions[divName];
            if (!divInfo) return;
            let bunks = (divInfo.bunks || []).slice();
            if (bunks.length === 0) return;
            const isEditable = editableDivisions.includes(divName);
            
            let element;
            if (isAutoSchedule) {
                element = renderDivisionTimeline(divName, divInfo, bunks, isEditable);
            } else {
                element = renderDivisionTable(divName, divInfo, bunks, skeleton, isEditable);
            }
            if (element) wrapper.appendChild(element);
        });
        
        container.appendChild(wrapper);
        if (window.MultiSchedulerAutonomous?.applyBlockingToGrid) setTimeout(() => window.MultiSchedulerAutonomous.applyBlockingToGrid(), 50);
        window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', { detail: { dateKey } }));
    }

    function renderDivisionTable(divName, divInfo, bunks, skeleton, isEditable) {
        // *** v4.1.0: Use divisionTimes directly ***
        const divSlots = window.divisionTimes?.[divName] || [];
        
        // Fallback: build from skeleton if divisionTimes not available
        let divBlocks;
        if (divSlots.length > 0) {
            divBlocks = divSlots.map((slot, idx) => ({
                slotIndex: idx,
                startMin: slot.startMin,
                endMin: slot.endMin,
                event: slot.event || 'GA',
                type: slot.type || 'slot',
                division: divName,
                _splitHalf: slot._splitHalf,
                _splitParentEvent: slot._splitParentEvent,
                _isSplitTile: !!slot._splitHalf,
                electiveActivities: slot.electiveActivities,
                reservedFields: slot.reservedFields,
                location: slot.location,
                swimLocation: slot.swimLocation,
                _preChangeMin: slot._preChangeMin,
                _postChangeMin: slot._postChangeMin
            }));
            // Enrich from skeleton for elective/pinned blocks that may be missing data (cached divisionTimes)
            divBlocks.forEach(block => {
                if (block.type === 'elective' || (block.type === 'pinned' && !isFixedBlockType(block.event))) {
                    if (!block.electiveActivities?.length && !block.reservedFields?.length && !block.location) {
                        const match = skeleton.find(s => s.division === divName &&
                            parseTimeToMinutes(s.startTime) === block.startMin &&
                            (s.type === block.type || (block.type === 'pinned' && s.type === 'pinned')));
                        if (match) {
                            block.electiveActivities = match.electiveActivities;
                            block.reservedFields = match.reservedFields;
                            block.location = match.location;
                            block.event = match.event;
                        }
                    }
                }
            });
        } else {
            divBlocks = skeleton.filter(b => b.division === divName).map(b => ({ 
                ...b, 
                startMin: parseTimeToMinutes(b.startTime), 
                endMin: parseTimeToMinutes(b.endTime) 
            })).filter(b => b.startMin !== null && b.endMin !== null).sort((a, b) => a.startMin - b.startMin);
            divBlocks = expandBlocksForSplitTiles(divBlocks, divName);
        }
        
        if (divBlocks.length === 0) return null;
        
        const table = document.createElement('table');
        table.className = 'schedule-division-table';
        table.style.cssText = 'width: 100%; border-collapse: collapse; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; background: #fff; margin-bottom: 8px;';
        
        const divColor = divInfo.color || '#4b5563';
        const thead = document.createElement('thead');
        const tr1 = document.createElement('tr');
        const th = document.createElement('th');
        th.colSpan = 1 + bunks.length;
        th.innerHTML = escapeHtml(divName) + (isEditable ? '' : ' <span style="opacity:0.7">[LOCKED]</span>');
        th.style.cssText = `background: ${divColor}; color: #fff; padding: 12px 16px; font-size: 1.1rem; font-weight: 600; text-align: left;`;
        tr1.appendChild(th); 
        thead.appendChild(tr1);
        
        const tr2 = document.createElement('tr'); 
        tr2.style.background = '#f9fafb';
        const thTime = document.createElement('th'); 
        thTime.textContent = 'Time';
        thTime.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 140px;';
        tr2.appendChild(thTime);
        bunks.forEach(bunk => { 
            const thB = document.createElement('th'); 
            thB.textContent = bunk; 
            thB.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 100px; text-align: center;'; 
            tr2.appendChild(thB); 
        });
        thead.appendChild(tr2); 
        table.appendChild(thead);
        
        const tbody = document.createElement('tbody');
        // *** v3.2: Pre-compute rowspan map for continuation merging ***
// For each bunk, determine which rows should merge (rowspan > 1)
// and which rows should be skipped (continuation cells)
const rowspanMap = {}; // { bunkName: { rowIdx: spanCount } }
const skipMap = {};    // { bunkName: Set<rowIdx> }

bunks.forEach(bunk => {
    rowspanMap[bunk] = {};
    skipMap[bunk] = new Set();
    
    for (let ri = 0; ri < divBlocks.length; ri++) {
        if (skipMap[bunk].has(ri)) continue;
        
        const slotIdx = divBlocks[ri].slotIndex !== undefined 
            ? divBlocks[ri].slotIndex 
            : ri;
        const entry = (window.scheduleAssignments?.[bunk] || [])[slotIdx];
        
        if (!entry || entry.continuation) continue;
        
        // Look ahead: how many continuation rows follow for this bunk?
        let span = 1;
        for (let ni = ri + 1; ni < divBlocks.length; ni++) {
            const nextSlotIdx = divBlocks[ni].slotIndex !== undefined
                ? divBlocks[ni].slotIndex
                : ni;
            const nextEntry = (window.scheduleAssignments?.[bunk] || [])[nextSlotIdx];
            
            if (nextEntry && nextEntry.continuation) {
                span++;
                skipMap[bunk].add(ni);
            } else {
                break;
            }
        }
        
        if (span > 1) {
            rowspanMap[bunk][ri] = span;
        }
    }
});

divBlocks.forEach((block, blockIdx) => {
    const timeLabel = `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`;
    const tr = document.createElement('tr');
    tr.style.background = blockIdx % 2 === 0 ? '#fff' : '#fafafa';
    if (block._isSplitTile) tr.style.background = block._splitHalf === 1 
        ? (blockIdx % 2 === 0 ? '#f0fdf4' : '#ecfdf5') 
        : (blockIdx % 2 === 0 ? '#fef3c7' : '#fef9c3');
    
    const tdTime = document.createElement('td'); 
    tdTime.textContent = timeLabel;
    tdTime.style.cssText = 'padding: 10px 12px; font-weight: 500; color: #4b5563; border-right: 1px solid #e5e7eb; white-space: nowrap;';
    if (block._isSplitTile) { 
        const halfLabel = block._splitHalf === 1 ? '①' : '②'; 
        tdTime.innerHTML = `${escapeHtml(timeLabel)} <span style="color: #6b7280; font-size: 0.8rem;">${halfLabel}</span>`; 
    }
    tr.appendChild(tdTime);
    
    if (isLeagueBlockType(block.event, block.type)) {
        tr.appendChild(renderLeagueCell(block, bunks, divName, isEditable));
        tbody.appendChild(tr);
        return;
    }

    if (block.type === 'elective' || block.type === 'swim_elective' || (block.type === 'pinned' && !isFixedBlockType(block.event))) {
        tr.appendChild(renderFixedBlockCell(block, bunks));
        tbody.appendChild(tr);
        return;
    }
    
    bunks.forEach(bunk => {
        // *** v3.2: Handle continuation merging ***
        if (skipMap[bunk].has(blockIdx)) {
            // This row is a continuation for this bunk — cell already covered by rowspan
            return;
        }
        
        const td = renderBunkCell(block, bunk, divName, isEditable);
        
        // Apply rowspan if this cell spans multiple rows
        const span = rowspanMap[bunk]?.[blockIdx];
        if (span && span > 1) {
            td.rowSpan = span;
            td.style.verticalAlign = 'middle';
            // Show the merged time range duration
            const endBlockIdx = blockIdx + span - 1;
            if (endBlockIdx < divBlocks.length) {
                const duration = divBlocks[endBlockIdx].endMin - divBlocks[blockIdx].startMin;
                if (duration > 0) {
                    const small = document.createElement('div');
                    small.style.cssText = 'font-size: 0.7rem; color: #9ca3af; margin-top: 2px;';
                    small.textContent = `${duration}min`;
                    td.appendChild(small);
                }
            }
        }
        
        tr.appendChild(td);
    });
    tbody.appendChild(tr);
});
        table.appendChild(tbody);
        return table;
    }

    // =========================================================================
    // *** AUTO BUILD: GANTT/TIMELINE RENDERER ***
    // =========================================================================
    
    function renderDivisionTimeline(divName, divInfo, bunks, isEditable) {
        // *** v5.0: Delegate to AutoScheduleGrid for time-scaled per-bunk view ***
        if (window.AutoScheduleGrid?.render) {
            return window.AutoScheduleGrid.render(divName, divInfo, bunks, isEditable);
        }

        // Fallback if auto_schedule_grid.js not loaded
        const container = document.createElement('div');
        container.style.cssText = 'padding:40px; text-align:center; color:#6b7280; background:#fff; border-radius:8px; margin-bottom:16px;';
        container.innerHTML = '<p>Auto schedule grid not loaded.</p>';
        return container;
    }
    
    function _getTimelineBlockStyle(block) {
        const type = block.type || '';
        const event = (block.event || '').toLowerCase();
        if (type === 'pinned' || type === 'fixed' || event.includes('lunch') || event.includes('snack') || event.includes('dismissal'))
            return 'background: linear-gradient(135deg, #fef3c7, #fde68a); color: #92400e; border: 1px solid #f59e0b;';
        if (block._scarce)
            return 'background: linear-gradient(135deg, #fce7f3, #fbcfe8); color: #9d174d; border: 1px solid #ec4899;';
        if (event.includes('special') || type === 'special_slot')
            return 'background: linear-gradient(135deg, #e0e7ff, #c7d2fe); color: #3730a3; border: 1px solid #6366f1;';
        if (event.includes('sport') || type === 'sport_slot')
            return 'background: linear-gradient(135deg, #d1fae5, #a7f3d0); color: #065f46; border: 1px solid #10b981;';
        if (event.includes('league'))
            return 'background: linear-gradient(135deg, #e0f2fe, #bae6fd); color: #075985; border: 1px solid #0284c7;';
        return 'background: linear-gradient(135deg, #f3f4f6, #e5e7eb); color: #374151; border: 1px solid #d1d5db;';
    }

    function renderLeagueCell(block, bunks, divName, isEditable) {        const td = document.createElement('td');
        td.colSpan = bunks.length;
        td.style.cssText = 'padding: 12px 16px; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border-left: 4px solid #0284c7; vertical-align: top;';
        
        // *** v4.1.0: Use division-specific slot lookup ***
        const slotIdx = block.slotIndex !== undefined ? block.slotIndex : findFirstSlotForTime(block.startMin, divName);
        let leagueInfo = getLeagueMatchups(divName, slotIdx);
        
        // Header is just the game label ("Game 2") — no emoji, no sport. Each
        // matchup line carries its own sport, so a single header sport is
        // wrong whenever the game's matchups play different sports.
        let title = leagueInfo.gameLabel || block.event;

        let html = `<div style="font-weight: 600; font-size: 1rem; color: #0369a1; margin-bottom: 8px;">${escapeHtml(title)}</div>`;
        
        if (leagueInfo.matchups?.length > 0) {
            html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
            leagueInfo.matchups.forEach(m => {
                let matchText;
                if (typeof m === 'string') {
                    const atParts = m.split(' @ ');
                    const teams = atParts[0] || '';
                    const fieldPart = atParts[1] || '';
                    let sport = '', field = '';
                    const parenMatch = fieldPart.match(/^(.+?)\s*\((.+?)\)\s*$/);
                    if (parenMatch) { field = parenMatch[1].trim(); sport = parenMatch[2].trim(); }
                    else { field = fieldPart.trim(); }
                    matchText = teams + (sport || field ? ' - ' : '') + (sport ? sport.charAt(0).toUpperCase() + sport.slice(1) : '') + (field ? ' (' + field + ')' : '');
                } else {
                    const sport = m.sport || leagueInfo.sport || '';
                    const field = m.field || '';
                    matchText = (m.teamA && m.teamB) ? `${m.teamA} vs ${m.teamB}${sport || field ? ' - ' : ''}${sport ? sport.charAt(0).toUpperCase() + sport.slice(1) : ''}${field ? ' (' + field + ')' : ''}` : m.display || (m.team1 && m.team2 ? `${m.team1} vs ${m.team2}` : (m.matchup || JSON.stringify(m)));
                }
                html += `<div style="background: #fff; padding: 6px 12px; border-radius: 6px; font-size: 0.875rem; color: #1e3a5f; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${escapeHtml(matchText)}</div>`;
            });
            html += '</div>';
        } else {
            html += '<div style="color: #64748b; font-size: 0.875rem; font-style: italic;">No matchups scheduled yet</div>';
        }
        
        td.innerHTML = html;
        
        if (isEditable && bunks.length > 0) { 
            td.style.cursor = 'pointer'; 
            td.onclick = () => {
                const firstBunk = bunks[0];
                const existingEntry = window.scheduleAssignments?.[firstBunk]?.[slotIdx];
                if (typeof openIntegratedEditModal === 'function') {
                    openIntegratedEditModal(firstBunk, slotIdx, existingEntry);
                } else {
                    enhancedEditCell(firstBunk, block.startMin, block.endMin, block.event);
                }
            };
        }
        
        return td;
    }

    function renderFixedBlockCell(block, bunks) {
        const td = document.createElement('td');
        td.colSpan = bunks.length;
        if (block.type === 'swim_elective') {
            // Sample any stamped bunk entry at this slot — that's the most reliable
            // source of hybrid metadata; the block itself may have older / partial data.
            let stamped = null;
            if (Array.isArray(bunks)) {
                for (let i = 0; i < bunks.length; i++) {
                    const e = window.scheduleAssignments?.[bunks[i]]?.[block.slotIndex];
                    if (e && e._swimElective) { stamped = e; break; }
                }
            }
            const swimLoc = block.swimLocation || (stamped && stamped._swimLocation) || 'Pool';
            const _swimLocLc = (swimLoc || '').toLowerCase().trim();
            // Try multiple sources in order of trustworthiness
            let _seSrc =
                (block.electiveActivities && block.electiveActivities.length) ? block.electiveActivities :
                (stamped && stamped._electiveActivities && stamped._electiveActivities.length) ? stamped._electiveActivities :
                (block.reservedFields && block.reservedFields.length) ? block.reservedFields :
                (stamped && stamped._reservedFields && stamped._reservedFields.length) ? stamped._reservedFields :
                [];
            const _seActsClean = _seSrc.filter(function (a) { return (a || '').toLowerCase().trim() !== _swimLocLc; });
            const label = ['Swim'].concat(_seActsClean).join(', ');
            const pre = parseInt(block._preChangeMin) || 0;
            const post = parseInt(block._postChangeMin) || 0;
            td.style.cssText = 'padding: 0; vertical-align: middle; text-align: center;';
            let inner = '';
            if (pre > 0) inner += `<div style="background:#FEF3C7;color:#92400E;padding:4px 12px;font-size:11px;font-weight:600;border-bottom:1px solid #F59E0B;">Change ${pre}m</div>`;
            inner += `<div style="background:linear-gradient(135deg, #ede9fe, #ddd6fe);border-left: 4px solid #7c3aed;padding:10px 16px;"><span style="font-weight:600;color:#5b21b6;font-size:0.95rem;">${escapeHtml(label)}</span></div>`;
            if (post > 0) inner += `<div style="background:#FEF3C7;color:#92400E;padding:4px 12px;font-size:11px;font-weight:600;border-top:1px solid #F59E0B;">Change ${post}m</div>`;
            td.innerHTML = inner;
        } else if (block.type === 'elective') {
            const acts = block.electiveActivities || block.reservedFields || [];
            const label = acts.join(', ') || block.event || 'Elective';
            td.style.cssText = 'padding: 10px 16px; background: linear-gradient(135deg, #ede9fe, #ddd6fe); border-left: 4px solid #7c3aed; vertical-align: middle; text-align: center;';
            td.innerHTML = `<span style="font-weight:600;color:#5b21b6;font-size:0.95rem;">${escapeHtml(label)}</span>`;
        } else {
            const loc = block.location || (Array.isArray(block.reservedFields) && block.reservedFields.length > 0 ? block.reservedFields.join(', ') : '');
            const label = loc ? `${block.event} - ${loc}` : block.event;
            td.style.cssText = 'padding: 10px 16px; background: linear-gradient(135deg, #fef3c7, #fde68a); border-left: 4px solid #f59e0b; vertical-align: middle; text-align: center;';
            td.innerHTML = `<span style="font-weight:600;color:#92400e;font-size:0.95rem;">${escapeHtml(label)}</span>`;
        }
        return td;
    }

    function renderBunkCell(block, bunk, divName, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        
        // *** v4.1.0: Use division-specific slot index ***
        const slotIdx = block.slotIndex !== undefined ? block.slotIndex : findFirstSlotForTime(block.startMin, divName);
        const entry = getEntry(bunk, slotIdx);
        
        let isBlocked = false, blockedReason = '';
        if (window.MultiSchedulerAutonomous?.isBunkSlotBlocked) { 
            const blockCheck = window.MultiSchedulerAutonomous.isBunkSlotBlocked(bunk, slotIdx); 
            if (blockCheck.blocked) { isBlocked = true; blockedReason = blockCheck.reason; } 
        }
        
        let displayText = '', bgColor = '#fff', htmlContent = null;

        // Elective and pinned (custom) blocks always show their own skeleton data
        if (block.type === 'swim_elective') {
            // Prefer the stamped per-bunk entry for hybrid metadata
            const stampedRBC = (entry && entry._swimElective) ? entry : null;
            const swimLoc = block.swimLocation || (stampedRBC && stampedRBC._swimLocation) || 'Pool';
            const _swimLocLc = (swimLoc || '').toLowerCase().trim();
            let _seSrc =
                (block.electiveActivities && block.electiveActivities.length) ? block.electiveActivities :
                (stampedRBC && stampedRBC._electiveActivities && stampedRBC._electiveActivities.length) ? stampedRBC._electiveActivities :
                (block.reservedFields && block.reservedFields.length) ? block.reservedFields :
                (stampedRBC && stampedRBC._reservedFields && stampedRBC._reservedFields.length) ? stampedRBC._reservedFields :
                [];
            const _seActsClean = _seSrc.filter(function (a) { return (a || '').toLowerCase().trim() !== _swimLocLc; });
            const label = ['Swim'].concat(_seActsClean).join(', ');
            const pre = parseInt(block._preChangeMin) || 0;
            const post = parseInt(block._postChangeMin) || 0;
            if (pre > 0 || post > 0) {
                let inner = '';
                if (pre > 0) inner += `<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;font-size:10px;font-weight:600;border-bottom:1px solid #F59E0B;">Change ${pre}m</div>`;
                inner += `<div style="background:#ede9fe;padding:6px;font-size:0.85rem;font-weight:600;color:#5b21b6;">${escapeHtml(label)}</div>`;
                if (post > 0) inner += `<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;font-size:10px;font-weight:600;border-top:1px solid #F59E0B;">Change ${post}m</div>`;
                htmlContent = inner;
                bgColor = 'transparent';
            } else {
                htmlContent = `<div style="font-size:0.85rem;font-weight:600;color:#5b21b6;">${escapeHtml(label)}</div>`;
                bgColor = '#ede9fe';
            }
        } else if (block.type === 'elective') {
            const acts = block.electiveActivities || block.reservedFields || [];
            const displayName = acts.join(', ') || block.event || 'Elective';
            htmlContent = `<div style="font-size:0.85rem;font-weight:600;color:#5b21b6;">${escapeHtml(displayName)}</div>`;
            bgColor = '#ede9fe';
        } else if (block.type === 'pinned' && block.event && !isFixedBlockType(block.event)) {
            const loc = block.location || (Array.isArray(block.reservedFields) && block.reservedFields.length > 0 ? block.reservedFields.join(', ') : '');
            const combined = loc ? `${block.event} - ${loc}` : block.event;
            htmlContent = `<div style="font-size:0.85rem;font-weight:600;color:#92400e;">${escapeHtml(combined)}</div>`;
            bgColor = '#fff8e1';
        } else if (entry && !entry.continuation) {
            displayText = formatEntry(entry);
            // ★ Sports only: if other bunks share this field at this time, show
            //   "Activity – Location – vs Bunk 2, Bunk 3".
            const _sharers = findFieldSharers(bunk, slotIdx, divName);
            if (_sharers.length) {
                const _names = _sharers.map(b => /^\d/.test(String(b)) ? 'Bunk ' + b : b);
                displayText += ' – vs ' + _names.join(', ');
            }
            bgColor = getEntryBackground(entry, block.event);
            // pinned state tracked internally, no visual prefix needed
        }
        else if (!entry) {
            if (isFixedBlockType(block.event)) { displayText = block.event; bgColor = '#fff8e1'; }
            else bgColor = '#f9fafb';
        }
        
       // *** AUTO BUILDER v2: _subEntries = multiple activities in one slot ***
        if (entry && entry._subEntries && entry._subEntries.length > 0) {
            td.innerHTML = '';
            td.style.padding = '2px';
            td.style.background = bgColor;
            const allSubs = [entry, ...entry._subEntries];
            const totalMin = block.endMin - block.startMin;
            allSubs.forEach((sub, si) => {
                const subDiv = document.createElement('div');
                const subDur = (sub._endMin || block.endMin) - (sub._startMin || block.startMin);
                const hPct = Math.max(30, (subDur / totalMin) * 100);
                const subText = formatEntry(sub);
                const subBg = getEntryBackground(sub, block.event);
                subDiv.style.cssText = 'padding:2px 4px; font-size:0.75rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-radius:3px; margin-bottom:1px; background:' + subBg + ';';
                subDiv.textContent = subText;
                subDiv.title = subText + ' (' + subDur + 'min)';
                td.appendChild(subDiv);
            });
        }
        // *** Split-swim Change → Swim → Change subdivision ***
        else if (entry && !entry.continuation && (entry._splitPreChange > 0 || entry._splitPostChange > 0)) {
            const preMin = entry._splitPreChange || 0;
            const postMin = entry._splitPostChange || 0;
            td.innerHTML = '';
            td.style.padding = '2px';
            td.style.background = bgColor;
            // Pre-Change row
            if (preMin > 0) {
                const preDiv = document.createElement('div');
                preDiv.style.cssText = 'padding:2px 4px;font-size:0.7rem;font-weight:600;color:#92400E;background:#FEF3C7;border:1px solid #F59E0B;border-radius:3px;margin-bottom:2px;text-align:center;';
                preDiv.textContent = 'Change ' + preMin + 'm';
                preDiv.title = 'Pre-change ' + preMin + ' min';
                td.appendChild(preDiv);
            }
            // Swim row
            const swimDiv = document.createElement('div');
            const swimBg = getEntryBackground(entry, block.event);
            swimDiv.style.cssText = 'padding:3px 4px;font-size:0.85rem;font-weight:500;background:' + swimBg + ';border-radius:3px;text-align:center;';
            swimDiv.textContent = formatEntry(entry);
            td.appendChild(swimDiv);
            // Post-Change row
            if (postMin > 0) {
                const postDiv = document.createElement('div');
                postDiv.style.cssText = 'padding:2px 4px;font-size:0.7rem;font-weight:600;color:#92400E;background:#FEF3C7;border:1px solid #F59E0B;border-radius:3px;margin-top:2px;text-align:center;';
                postDiv.textContent = 'Change ' + postMin + 'm';
                postDiv.title = 'Post-change ' + postMin + ' min';
                td.appendChild(postDiv);
            }
        }
        else if (htmlContent) {
            td.innerHTML = htmlContent;
            td.style.background = bgColor;
            td.style.textAlign = 'left';
        } else {
            td.textContent = displayText;
            td.style.background = bgColor;
        }

        // Cell-specific bypass highlighting
const bypassStatus = getCellBypassStatus(bunk, slotIdx);
if (bypassStatus.highlight) {
    if (bypassStatus.isMyBypass) {
        td.style.background = 'linear-gradient(135deg, #ccfbf1, #99f6e4)';
        td.style.boxShadow = 'inset 0 0 0 2px #14b8a6';
    } else {
        td.style.background = 'linear-gradient(135deg, #ede9fe, #ddd6fe)';
        td.style.boxShadow = 'inset 0 0 0 2px #8b5cf6';
        td.title = `Modified by ${bypassStatus.bypassedByName}`;
    }
}
        
        td.dataset.slot = slotIdx; 
        td.dataset.slotIndex = slotIdx; 
        td.dataset.bunk = bunk; 
        td.dataset.division = divName; 
        td.dataset.startMin = block.startMin; 
        td.dataset.endMin = block.endMin;
        
        if (isBlocked) { 
            td.style.cursor = 'not-allowed'; 
            td.onclick = () => { 
                if (window.showToast) window.showToast(`Cannot edit: ${blockedReason}`, 'error');
                else alert(`Cannot edit: ${blockedReason}`); 
            }; 
        }
        else if (isEditable) { 
            td.style.cursor = 'pointer'; 
            td.onclick = () => {
                const existingEntry = window.scheduleAssignments?.[bunk]?.[slotIdx];
                if (typeof openIntegratedEditModal === 'function') {
                    openIntegratedEditModal(bunk, slotIdx, existingEntry);
                } else {
                    enhancedEditCell(bunk, block.startMin, block.endMin, displayText);
                }
            };
        }
        return td;
    }

    // =========================================================================
    // APPLY DIRECT EDIT
    // =========================================================================

   function applyDirectEdit(bunk, slots, activity, location, isClear, shouldPin = true, opts = {}) {
        const divName = getDivisionForBunk(bunk);
        const divSlots = window.divisionTimes?.[divName] || [];

        // Slice 4 audit fix — manual legality gate.
        // Without this, manual edits could plant violations that the
        // auto pipeline would then preserve via _pinned. The auto
        // pipeline's commitWriteIfLegal stops at the manual entry
        // point; this is the manual-side equivalent. Free-writes are
        // exempt (they release a slot).
        if (!isClear && activity && slots.length > 0) {
            const _pbsArr = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)] || [];
            const _firstSlotMeta = _pbsArr[slots[0]] || divSlots[slots[0]];
            const _lastSlotMeta = _pbsArr[slots[slots.length - 1]] || divSlots[slots[slots.length - 1]];
            const _sMin = _firstSlotMeta?.startMin ?? null;
            const _eMin = _lastSlotMeta?.endMin ?? null;
            const _check = commitManualWriteIfLegal(
                bunk, slots[0], activity, location, divName, _sMin, _eMin,
                { allowSoftOverride: !!opts.allowSoftOverride, slotRange: slots }
            );
            if (!_check.ok) {
                if (_check.soft && opts.allowSoftOverride) {
                    // Caller already confirmed the soft-violation prompt; proceed.
                } else if (_check.soft && typeof window.confirm === 'function') {
                    // Soft violation surfaced as user-confirmable prompt.
                    if (!window.confirm('Heads up: ' + _check.reason + '.\n\nPlace anyway?')) {
                        console.log('[applyDirectEdit] User cancelled soft-violation override:', _check.reason);
                        return false;
                    }
                } else {
                    console.warn('[applyDirectEdit] BLOCKED:', _check.reason);
                    if (typeof window.showNotification === 'function') {
                        window.showNotification(_check.reason, 'error');
                    } else if (typeof window.alert === 'function') {
                        window.alert('Cannot place: ' + _check.reason);
                    }
                    return false;
                }
            }
        }
        
        // *** AUTO MODE: Reshape per-bunk slots if edit time doesn't match slot boundaries ***
        const _isAutoMode = !!window.divisionTimes?.[divName]?._perBunkSlots;
        if (_isAutoMode && !isClear && slots.length > 0) {
            const perBunk = window.divisionTimes[divName]._perBunkSlots[String(bunk)];
            if (perBunk && perBunk[slots[0]]) {
                const firstSlot = perBunk[slots[0]];
                const lastSlot = perBunk[slots[slots.length - 1]];
                const editCtx = _currentEditContext || {};
                if (editCtx.isAutoMode && editCtx.startMin != null && editCtx.endMin != null) {
                    if (firstSlot.startMin !== editCtx.startMin || lastSlot.endMin !== editCtx.endMin) {
                        console.log('[applyDirectEdit] Auto mode: reshaping slots for ' + bunk + ' to [' + editCtx.startMin + '-' + editCtx.endMin + ']');
                        const reshaped = ensurePerBunkSlotForRange(bunk, divName, editCtx.startMin, editCtx.endMin);
                        if (reshaped.length > 0) {
                            slots = reshaped;
                        }
                    }
                }
            }
        }
        
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) {
            const perBunk = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)];
            const slotCount = perBunk ? perBunk.length : (divSlots.length || 50);
            window.scheduleAssignments[bunk] = new Array(slotCount);
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
                _pinned: shouldPin && !isClear, 
                _editedAt: Date.now() 
            };
        });
        
        if (location && !isClear && window.registerLocationUsage) {
            slots.forEach(idx => window.registerLocationUsage(idx, location, activity, divName));
        }
    }
    // =========================================================================
    // SAVE & UPDATE
    // =========================================================================

    function saveSchedule() {
        const silent = window._postEditInProgress;
        if (window.saveCurrentDailyData) {
            window.saveCurrentDailyData('scheduleAssignments', window.scheduleAssignments, { silent });
            window.saveCurrentDailyData('leagueAssignments', window.leagueAssignments, { silent });
            // *** v4.1.0: Save divisionTimes (serialized) ***
            const serialized = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes;
            window.saveCurrentDailyData('divisionTimes', serialized, { silent });
        }
        // NOTE: saveSchedule does NOT touch historicalCounts.
        //   - Post-edit callers run applyPostEditCounts (per-bunk delta) and
        //     rely on its debounced RotationCloud.save.
        //   - Generation callers (scheduler_core_main / scheduler_core_auto /
        //     integration_hooks) run rebuildHistoricalCounts(true) themselves
        //     after this save lands.
        //   The previous reIncrement here was running with a post-save
        //   "old" snapshot (= the new schedule) and silently shifted counts
        //   by (newToday − oldToday) on every save. Removed.
        const dateKey = window.currentScheduleDate;
        if (dateKey && window.RotationCloud?.save) {
            window.RotationCloud.save(dateKey, window.scheduleAssignments || {});
        }
    }

    function updateTable() {
        const now = Date.now();
        if (window._postEditInProgress) {
            _lastRenderTime = now; 
            _renderQueued = false; 
            if (_renderTimeout) { clearTimeout(_renderTimeout); _renderTimeout = null; }
            const container = document.getElementById('scheduleTable');
            if (container) renderTransposedView(container);
            return;
        }
        if (now - _lastRenderTime < RENDER_DEBOUNCE_MS) {
            if (!_renderQueued) { 
                _renderQueued = true; 
                if (_renderTimeout) clearTimeout(_renderTimeout); 
                _renderTimeout = setTimeout(() => { 
                    _renderQueued = false; 
                    _lastRenderTime = Date.now(); 
                    const container = document.getElementById('scheduleTable'); 
                    if (container) renderTransposedView(container); 
                }, RENDER_DEBOUNCE_MS); 
            }
            return;
        }
        _lastRenderTime = now;
        const container = document.getElementById('scheduleTable');
        if (container) renderTransposedView(container);
    }

    // =========================================================================
    // UTILITY: ESCAPE HTML
    // =========================================================================
    
    function escapeHtml(str) { return window.CampUtils.escapeHtml(str); }  // → campistry_utils.js (canonical)

    // =========================================================================
    // BYPASS SAVE - CROSS-DIVISION DIRECT UPDATE
    // =========================================================================

    async function bypassSaveAllBunks(modifiedBunks) {
        console.log('[UnifiedSchedule] [BYPASS] BYPASS SAVE for bunks:', modifiedBunks);
        const dateKey = window.currentScheduleDate || window.currentDate || document.getElementById('datePicker')?.value || new Date().toISOString().split('T')[0];

        // Slice 4 audit fix — validate input shape. Earlier this loaded the
        // current scheduleAssignments and uploaded as-is. If local was
        // corrupted (wrong slot count vs divisionTimes from an unsynced
        // per-bunk reshape), the corruption propagated straight to cloud.
        if (window.scheduleAssignments) {
            const corruptedBunks = [];
            for (let i = 0; i < (modifiedBunks || []).length; i++) {
                const bunk = modifiedBunks[i];
                const arr = window.scheduleAssignments[bunk];
                if (!Array.isArray(arr)) continue;
                const divName = (typeof getDivisionForBunk === 'function') ? getDivisionForBunk(bunk) : null;
                const expected = (divName && window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)]?.length)
                              || window.divisionTimes?.[divName]?.length
                              || arr.length;
                if (expected > 0 && arr.length !== expected && Math.abs(arr.length - expected) > 1) {
                    corruptedBunks.push({ bunk: bunk, expected: expected, got: arr.length });
                }
            }
            if (corruptedBunks.length > 0) {
                // ★ MS-4d: SELF-HEAL instead of refusing. Cross-user merges
                // can pair a division's content with a different-shaped local
                // grid (e.g. owner's 10-slot Harmony content vs the
                // scheduler's 12-slot grid) — the safe padding fixer aligns
                // them (grow-with-nulls, never truncate real data). Only
                // refuse if the shapes STILL disagree after the fix.
                console.warn('[UnifiedSchedule] [BYPASS] Slot count mismatch for ' + corruptedBunks.length + ' bunks — attempting reconcile:', corruptedBunks);
                try { window.DivisionTimesSystem?.fixAllBunkSlotCounts?.(); } catch (eFix) {}
                const stillBad = [];
                for (let i = 0; i < corruptedBunks.length; i++) {
                    const cb = corruptedBunks[i];
                    const arr2 = window.scheduleAssignments[cb.bunk];
                    const divName2 = (typeof getDivisionForBunk === 'function') ? getDivisionForBunk(cb.bunk) : null;
                    const expected2 = (divName2 && window.divisionTimes?.[divName2]?._perBunkSlots?.[String(cb.bunk)]?.length)
                                   || window.divisionTimes?.[divName2]?.length
                                   || (arr2 ? arr2.length : 0);
                    if (Array.isArray(arr2) && expected2 > 0 && Math.abs(arr2.length - expected2) > 1) {
                        stillBad.push({ bunk: cb.bunk, expected: expected2, got: arr2.length });
                    }
                }
                if (stillBad.length > 0) {
                    console.warn('[UnifiedSchedule] [BYPASS] Shape mismatch persists after reconcile — refusing upload:', stillBad);
                    if (typeof window.showNotification === 'function') {
                        window.showNotification('Schedule data shape mismatch — save deferred. Refresh recommended.', 'error');
                    }
                    return { success: false, error: 'shape-mismatch', corruptedBunks: stillBad };
                }
                console.log('[UnifiedSchedule] [BYPASS] Reconciled — proceeding with save');
            }
        }
        
        // Step 1: Save to localStorage first (immediate backup)
        try {
            // ★ CB-52: dropped write-only `scheduleAssignments_${dateKey}` mirror (never read) —
            // canonical campDailyData_v1[dateKey] below is the real backup/read path.
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[dateKey]) allDailyData[dateKey] = {};
            allDailyData[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDailyData[dateKey].leagueAssignments = window.leagueAssignments || {};
            allDailyData[dateKey].divisionTimes = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes;
            allDailyData[dateKey]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            console.log('[UnifiedSchedule] [OK] Bypass: saved to localStorage');
        } catch (e) { 
            console.error('[UnifiedSchedule] Bypass localStorage save error:', e); 
        }
        
        // Step 2: Get Supabase client
        const client = window.CampistryDB?.getClient?.() || window.supabase;
        const campId = window.CampistryDB?.getCampId?.();
        
        if (!client || !campId) {
            console.warn('[UnifiedSchedule] No client/campId - local save only');
            return { success: true, target: 'local' };
        }
        
        try {
            // Step 3: Load ALL records for this date
            console.log('[UnifiedSchedule] [BYPASS] Loading all scheduler records for cross-division update...');
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            
            if (loadError) {
                console.error('[UnifiedSchedule] Failed to load records:', loadError);
                return await fallbackBypassSave(dateKey, modifiedBunks);
            }
            
            console.log(`[UnifiedSchedule] [BYPASS] Found ${allRecords?.length || 0} scheduler records`);
            
            if (!allRecords || allRecords.length === 0) {
                console.log('[UnifiedSchedule] [BYPASS] No existing records, using standard save');
                return await fallbackBypassSave(dateKey, modifiedBunks);
            }
            
            // Step 4: Build a map of bunk -> record
            const bunkToRecord = {};
            (allRecords || []).forEach(record => {
                const assignments = record.schedule_data?.scheduleAssignments || {};
                Object.keys(assignments).forEach(bunk => {
                    bunkToRecord[bunk] = record;
                });
            });
            
            // Step 5: Group modified bunks by their owning record
            const recordUpdates = new Map();
            const orphanBunks = [];
            
            modifiedBunks.forEach(bunk => {
                const bunkStr = String(bunk);
                const owningRecord = bunkToRecord[bunkStr];
                
                if (owningRecord) {
                    if (!recordUpdates.has(owningRecord.id)) {
                        recordUpdates.set(owningRecord.id, { record: owningRecord, bunksToUpdate: [] });
                    }
                    recordUpdates.get(owningRecord.id).bunksToUpdate.push(bunkStr);
                } else {
                    orphanBunks.push(bunkStr);
                }
            });
            
            console.log(`[UnifiedSchedule] [BYPASS] Updates needed:`, 
                [...recordUpdates.entries()].map(([id, data]) => 
                    `${data.record.scheduler_name || 'unknown'}: bunks ${data.bunksToUpdate.join(', ')}`
                )
            );
            
            // Step 6: Update each record directly
            let successCount = 0;
            let failCount = 0;
            const updatedSchedulers = [];
            
            for (const [recordId, { record, bunksToUpdate }] of recordUpdates) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...(scheduleData.scheduleAssignments || {}) };
                const leagues = { ...(scheduleData.leagueAssignments || {}) };
                
                bunksToUpdate.forEach(bunk => {
                    if (window.scheduleAssignments[bunk]) {
                        assignments[bunk] = window.scheduleAssignments[bunk];
                    }
                    if (window.leagueAssignments?.[bunk]) {
                        leagues[bunk] = window.leagueAssignments[bunk];
                    }
                });
                
                const updatedData = {
                    ...scheduleData,
                    scheduleAssignments: assignments,
                    leagueAssignments: leagues,
                    divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes
                };
                
                const { error: updateError } = await client
                    .from('daily_schedules')
                    .update({
                        schedule_data: updatedData,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', recordId);
                
                if (updateError) {
                    console.error(`[UnifiedSchedule] [X] Failed to update ${record.scheduler_name || 'unknown'}:`, updateError);
                    failCount++;
                } else {
                    console.log(`[UnifiedSchedule] [OK] Updated ${record.scheduler_name || 'unknown'} with bunks: ${bunksToUpdate.join(', ')}`);
                    successCount++;
                    updatedSchedulers.push(record.scheduler_name || record.scheduler_id);
                }
            }
            
            // Step 7: Handle orphan bunks
            if (orphanBunks.length > 0) {
                console.log(`[UnifiedSchedule] [BYPASS] Saving orphan bunks via standard method...`);
                if (window.ScheduleDB?.saveSchedule) {
                    try {
                        await window.ScheduleDB.saveSchedule(dateKey, {
                            scheduleAssignments: window.scheduleAssignments,
                            leagueAssignments: window.leagueAssignments || {},
                            divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes
                        }, { skipFilter: true, immediate: true });
                        successCount++;
                    } catch (e) {
                        console.error('[UnifiedSchedule] Orphan save error:', e);
                        failCount++;
                    }
                }
            }
            
            // Step 8: Sync and dispatch events
            try {
                if (window.ScheduleSync?.forceSave) await window.ScheduleSync.forceSave();
                if (window.forceSyncToCloud) await window.forceSyncToCloud();
                window.dispatchEvent(new CustomEvent('campistry-bypass-save-complete', { 
                    detail: { dateKey, modifiedBunks, successCount, failCount, updatedSchedulers, timestamp: Date.now() } 
                }));
            } catch (e) { 
                console.warn('[UnifiedSchedule] Bypass sync broadcast warning:', e); 
            }
            
            if (window.showToast) {
                const divisions = window.divisions || {};
                const divisionNames = new Set();
                modifiedBunks.forEach(bunk => { 
                    for (const [divName, divData] of Object.entries(divisions)) { 
                        if (divData.bunks?.some(b => String(b) === String(bunk))) divisionNames.add(divName); 
                    } 
                });
                const schedulerInfo = updatedSchedulers.length > 0 ? ` (updated: ${updatedSchedulers.join(', ')})` : '';
                window.showToast(
                    `Cross-division bypass: ${modifiedBunks.length} bunk(s) in Div ${[...divisionNames].join(', ')}${schedulerInfo}`, 
                    failCount === 0 ? 'success' : 'warning'
                );
            }
            
            return { success: failCount === 0, successCount, failCount, updatedSchedulers, target: 'cloud-direct' };
            
        } catch (e) {
            console.error('[UnifiedSchedule] Bypass save exception:', e);
            return await fallbackBypassSave(dateKey, modifiedBunks);
        }
    }
    
    async function fallbackBypassSave(dateKey, modifiedBunks) {
        console.log('[UnifiedSchedule] [BYPASS] Using fallback bypass save (skipFilter)');
        let cloudResult = { success: false };
        if (window.ScheduleDB?.saveSchedule) {
            try {
                cloudResult = await window.ScheduleDB.saveSchedule(dateKey, { 
                    scheduleAssignments: window.scheduleAssignments, 
                    leagueAssignments: window.leagueAssignments || {}, 
                    divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes,
                    _bypassSaveAt: Date.now(), 
                    _modifiedBunks: modifiedBunks 
                }, { skipFilter: true, immediate: true, forceSync: true });
            } catch (e) { 
                console.error('[UnifiedSchedule] Fallback bypass save exception:', e); 
            }
        }
        
        try {
            if (window.ScheduleSync?.forceSave) await window.ScheduleSync.forceSave();
            if (window.forceSyncToCloud) await window.forceSyncToCloud();
            window.dispatchEvent(new CustomEvent('campistry-bypass-save-complete', { 
                detail: { dateKey, modifiedBunks, timestamp: Date.now() } 
            }));
        } catch (e) { 
            console.warn('[UnifiedSchedule] Fallback sync warning:', e); 
        }
        
        if (window.showToast) {
            const divisions = window.divisions || {};
            const divisionNames = new Set();
            modifiedBunks.forEach(bunk => { 
                for (const [divName, divData] of Object.entries(divisions)) { 
                    if (divData.bunks?.some(b => String(b) === String(bunk))) divisionNames.add(divName); 
                } 
            });
            window.showToast(
                `Bypass saved: ${modifiedBunks.length} bunk(s)${[...divisionNames].length ? ` in Div ${[...divisionNames].join(', ')}` : ''} - synced`, 
                'success'
            );
        }
        return cloudResult;
    }

    // =========================================================================
    // EDIT MODAL (LEGACY FALLBACK)
    // =========================================================================

    function createModal() {
        document.getElementById(OVERLAY_ID)?.remove(); 
        document.getElementById(MODAL_ID)?.remove();
        const overlay = document.createElement('div'); 
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;';
        const modal = document.createElement('div'); 
        modal.id = MODAL_ID;
        modal.style.cssText = 'background: white; border-radius: 12px; padding: 24px; min-width: 400px; max-width: 500px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-height: 90vh; overflow-y: auto;';
        overlay.appendChild(modal); 
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); } });
        return modal;
    }

    function closeModal() { 
        document.getElementById(OVERLAY_ID)?.remove(); 
    }

    function enhancedEditCell(bunk, startMin, endMin, current) {
        if (!canEditBunk(bunk)) { 
            alert('You do not have permission to edit this schedule.'); 
            return; 
        }
        
        const divName = getDivisionForBunk(bunk);

        // ★ AUTO-MODE SLOT RESOLUTION (gap "+ Add" and cell edit).
        //   In auto mode the editor is indexed by PER-BUNK slots:
        //   openIntegratedEditModal reads divisionTimes[div]._perBunkSlots[bunk]
        //   and scheduleAssignments[bunk] is aligned to it. findSlotsForRange,
        //   when NO per-bunk slot overlaps the clicked range (a mid-day gap =
        //   uncovered time), FALLS THROUGH to the division-level slot list and
        //   returns a DIVISION index — which then points at the WRONG per-bunk
        //   slot (e.g. click the 11:30 gap → opens the 12:15 swim). So resolve
        //   strictly against per-bunk slots here, and MATERIALIZE the exact
        //   clicked range when it's an uncovered gap (the same primitive the
        //   save flow uses). Manual mode keeps the division-level lookup.
        const _perBunkSlots = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)];
        let slots;
        if (_perBunkSlots && startMin != null && endMin != null) {
            slots = [];
            for (let i = 0; i < _perBunkSlots.length; i++) {
                const s = _perBunkSlots[i];
                if (!(s.endMin <= startMin || s.startMin >= endMin)) slots.push(i);
            }
            if (slots.length === 0) {
                slots = ensurePerBunkSlotForRange(bunk, divName, startMin, endMin) || [];
            }
        } else {
            slots = findSlotsForRange(startMin, endMin, divName, bunk);
        }

        if (slots.length === 0) {
            alert('Error: Could not find time slots for this block.');
            return;
        }

        const slotIdx = slots[0];
        const existingEntry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        
        // Try to use integrated edit modal if available
        if (typeof openIntegratedEditModal === 'function') {
            openIntegratedEditModal(bunk, slotIdx, existingEntry);
        } else {
            // Fallback to simple prompt
            const newActivity = prompt(`Edit activity for ${bunk}:`, current || '');
            if (newActivity !== null) {
                applyDirectEdit(bunk, slots, newActivity, null, newActivity.toUpperCase() === 'CLEAR' || newActivity === '', true);
                saveSchedule();
                updateTable();
            }
        }
    }

    function editCell(bunk, startMin, endMin, current) { 
        enhancedEditCell(bunk, startMin, endMin, current); 
    }

    // =========================================================================
    // SCHEDULER NOTIFICATION
    // =========================================================================

   async function sendSchedulerNotification(affectedBunks, location, activity, notificationType) {
        // * DEMO FIX: No supabase in demo mode
        if (window.__CAMPISTRY_DEMO_MODE__) {
            console.log('[UnifiedSchedule] [DEMO] Demo mode — skipping notification');
            return;
        }

        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentScheduleDate || window.currentDate || new Date().toISOString().split('T')[0];
        if (!campId) return;
        try {
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            for (const bunk of affectedBunks) {
                for (const [divName, divData] of Object.entries(divisions)) {
                    if (divData.bunks?.some(b => String(b) === String(bunk))) affectedDivisions.add(divName);
                }
            }
            // ★ real column is assigned_divisions (selecting `divisions`
            // errored the query → notifications were never sent)
            const { data: schedulers } = await supabase.from('camp_users').select('user_id, assigned_divisions').eq('camp_id', campId).neq('user_id', userId);
            const notifyUsers = (schedulers || []).filter(s => s.user_id && (s.assigned_divisions || []).some(d => affectedDivisions.has(d))).map(s => s.user_id);
            // ★ include the camp owner (not a camp_users row; camp_id is the owner's uid)
            if (campId && campId !== userId && !notifyUsers.includes(campId)) notifyUsers.push(campId);
            if (notifyUsers.length === 0) return;
            const notifications = notifyUsers.map(targetUserId => ({
                camp_id: campId, user_id: targetUserId,
                type: notificationType === 'bypassed' ? 'schedule_bypassed' : 'schedule_conflict',
                title: notificationType === 'bypassed' ? 'Your schedule was modified' : 'Schedule conflict detected',
                message: notificationType === 'bypassed' ? `Another scheduler reassigned bunks (${affectedBunks.join(', ')}) for ${location} - ${activity} on ${dateKey}` : `Conflict at ${location} for ${activity} on ${dateKey}. Affected bunks: ${affectedBunks.join(', ')}`,
                metadata: { dateKey, bunks: affectedBunks, location, activity, initiatedBy: userId },
                read: false, created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        } catch (e) { console.error('[UnifiedSchedule] Notification error:', e); }
    }

   

    // =========================================================================
    // APPLY EDIT
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const divName = getDivisionForBunk(bunk);

        if (window.__CAMPISTRY_DEMO_MODE__ && !activity && activity !== '') {
            console.error('[UnifiedSchedule] [X] Demo: applyEdit called with undefined activity:', editData);
            alert('Error: No activity specified.');
            return;
        }

        const isClear = !activity || activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const hasPerBunk = !!window.divisionTimes?.[divName]?._perBunkSlots;
        const slots = findSlotsForRange(startMin, endMin, divName, hasPerBunk ? bunk : null);
        if (slots.length === 0) { alert('Error: Could not find time slots.'); return; }

        if (!isClear && window.checkSequenceViolation && slots.length > 0) {
            const _seqCheck = window.checkSequenceViolation(bunk, activity, slots[0], divName);
            if (_seqCheck?.violated) { if (!confirm('Sequence Warning:\n\n' + _seqCheck.reason + '\n\nPlace anyway?')) return; }
        }
        if (!isClear && window.isLocationInCooldown && location && slots.length > 0) {
            const _coolCheck = window.isLocationInCooldown(location, slots[0], bunk, divName);
            if (_coolCheck?.blocked) { if (!confirm('Location Cooldown:\n\n' + _coolCheck.reason + '\n\nPlace anyway?')) return; }
        }

        markPostEditInProgress();
        const divSlots = window.divisionTimes?.[divName] || [];
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);

        // *** CAPTURE old activities BEFORE edit overwrites them ***
        const _oldActivities = [];
        slots.forEach(idx => {
            const old = window.scheduleAssignments[bunk]?.[idx];
            if (old?._activity && !old.continuation && !old._isTransition) {
                const a = old._activity.toLowerCase();
                if (a !== 'free' && !a.includes('transition')) {
                    _oldActivities.push(old._activity);
                }
            }
        });

        if (hasConflict) {
            await resolveConflictsAndApply(bunk, slots, activity, location, editData);
        } else {
            if (hasPerBunk && !isClear && startMin != null && endMin != null) {
                const reshaped = ensurePerBunkSlotForRange(bunk, divName, startMin, endMin);
                if (reshaped.length > 0) {
                    applyDirectEdit(bunk, reshaped, activity, location, isClear, true);
                } else {
                    applyDirectEdit(bunk, slots, activity, location, isClear, true);
                }
            } else {
                applyDirectEdit(bunk, slots, activity, location, isClear, true);
            }
        }

        const currentDate = window.currentScheduleDate || window.currentDate || document.getElementById('datePicker')?.value || new Date().toISOString().split('T')[0];
        try {
            // ★ CB-52: dropped write-only `scheduleAssignments_${currentDate}` mirror (never read).
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].divisionTimes = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes;
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) { console.error('[UnifiedSchedule] Failed to save to localStorage:', e); }
        // Slice 4 audit fix — removed stale `setTimeout(_postEditInProgress
        // = false, 8000)` that raced with the managed clear-timer set above
        // via markPostEditInProgress(). The stale form was uncancelable,
        // so a second edit within the 8s window would fire the first
        // edit's setTimeout, clearing the flag mid-second-edit and exposing
        // it to remote sync.
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', { detail: { bunk, slots, activity, location, date: currentDate } }));
        // Slice 4 audit fix — eliminated double-save. Earlier this called
        // saveSchedule() AND bypassSaveAllBunks([bunk]) back-to-back —
        // two full cloud round-trips per edit. bypassSaveAllBunks already
        // handles cross-division cloud writes correctly; keep it as the
        // single cloud path. saveSchedule() still runs implicitly via
        // bypassSaveAllBunks's localStorage write.
        if (typeof bypassSaveAllBunks === 'function') {
            await bypassSaveAllBunks([bunk]);
        } else {
            // Fallback only if bypass is unavailable.
            saveSchedule();
        }

        // Post-edit counts + rotation history (single shared implementation)
        if (window.SchedulerCoreUtils?.applyPostEditCounts) {
            window.SchedulerCoreUtils.applyPostEditCounts(bunk, _oldActivities, (!isClear && activity) ? activity : null, slots);
        }

        updateTable();
        setTimeout(() => updateTable(), 500);
    }

    // =========================================================================
    // MODAL UI (LEGACY / DIRECT EDIT)
    // =========================================================================

    // ── Helper: get all fields used by leagues in a time range ──────────────
    function _getLeagueFieldsInTimeRange(startMin, endMin) {
        const result = new Set();
        const leagues = window.leagueAssignments || {};
        const divisions = window.divisions || {};
        for (const [dName, divSlots] of Object.entries(leagues)) {
            const dTimes = window.divisionTimes?.[dName] || [];
            for (const [slotIdx, entry] of Object.entries(divSlots)) {
                if (!entry?.matchups?.length) continue;
                const idx = parseInt(slotIdx, 10);
                const slotInfo = dTimes[idx];
                if (!slotInfo) continue;
                // Check time overlap
                if (slotInfo.startMin >= endMin || slotInfo.endMin <= startMin) continue;
                // Parse field names from matchup strings: "Team vs Team @ FieldName (Sport)"
                for (const m of entry.matchups) {
                    const raw = typeof m === 'string' ? m : m?.display || '';
                    const atMatch = raw.match(/@\s*(.+?)\s*\(/);
                    if (atMatch) {
                        const fieldName = atMatch[1].trim();
                        if (fieldName && fieldName !== 'Free') result.add(fieldName.toLowerCase());
                    }
                }
            }
        }
        return result;
    }

    // ── Activity-first field search ─────────────────────────────────────────
    // Returns { open: [{name,capacity,...}], busy: [{name,capacity,conflict,...}] }
    // for fields that support the given activity at the given time range.
    function findFieldsForActivity(activityName, targetSlots, divName, excludeBunk, startMin, endMin) {
        if (!activityName) return { open: [], busy: [], none: true };
        const locs = getAllLocations();
        const matching = locs.filter(l =>
            (l.activities || []).some(a => a.toLowerCase() === activityName.toLowerCase())
        );
        if (matching.length === 0) return { open: [], busy: [], none: true };
        const actProps = getActivityProperties();
        const open = [], busy = [];
        for (const loc of matching) {
            const props = actProps[loc.name] || actProps[loc.name.toLowerCase()] || {};

            // Access restriction check: division not allowed to use this field
            if (props.accessRestrictions?.enabled && divName) {
                const allowedDivs = props.accessRestrictions.divisions || {};
                if (!(divName in allowedDivs)) {
                    busy.push({ ...loc, reason: 'access_restricted' });
                    continue;
                }
            }

            // League lock check: field occupied by a league game at this time
            // GlobalFieldLocks may not be initialized during post-edit, so also
            // scan leagueAssignments directly for field usage at this time range.
            if (window.GlobalFieldLocks?._initialized && targetSlots.length > 0) {
                const lockInfo = window.GlobalFieldLocks.isFieldLocked(loc.name, targetSlots, divName);
                if (lockInfo) {
                    busy.push({ ...loc, reason: 'league_locked', lockInfo });
                    continue;
                }
            }
            // Direct league field usage scan (works even without GlobalFieldLocks init)
            if (startMin != null && endMin != null) {
                const leagueFields = _getLeagueFieldsInTimeRange(startMin, endMin);
                const locLower = loc.name.toLowerCase();
                if (leagueFields.has(locLower)) {
                    busy.push({ ...loc, reason: 'league_locked' });
                    continue;
                }
                // Combo check: if a combo-related field is used by a league
                if (window.FieldCombos?.isInCombo?.(loc.name)) {
                    const exclusiveFields = window.FieldCombos.getExclusiveFields(loc.name);
                    const comboBlocked = exclusiveFields.some(f => leagueFields.has(f.toLowerCase()));
                    if (comboBlocked) {
                        busy.push({ ...loc, reason: 'league_locked' });
                        continue;
                    }
                }
            }

            // Full constraint check: capacity, sharing rules, cross-division, combos
            const timeAvail = (startMin != null && endMin != null)
                ? checkFieldAvailableByTime(loc.name, startMin, endMin, excludeBunk, actProps)
                : true;
            if (!timeAvail) {
                const check = checkLocationConflict(loc.name, targetSlots, excludeBunk);
                busy.push({ ...loc, conflict: check, reason: 'capacity' });
                continue;
            }
            const check = checkLocationConflict(loc.name, targetSlots, excludeBunk);
            if (check.hasConflict) {
                busy.push({ ...loc, conflict: check });
            } else {
                // Check if another bunk is sharing this field (under capacity)
                if (check.currentUsage > 0) {
                    open.push({ ...loc, shared: true, currentUsage: check.currentUsage, maxCapacity: check.maxCapacity });
                } else {
                    open.push(loc);
                }
            }
        }
        return { open, busy, none: false };
    }

    // "Make Room" modal — shows which bunks to displace and their alternatives
    function showMakeRoomModal(activityName, busyFields, targetSlots, divName, bunk, startMin, endMin, onFieldFreed) {
        const existingMR = document.getElementById('make-room-overlay');
        if (existingMR) existingMR.remove();

        const overlay = document.createElement('div');
        overlay.id = 'make-room-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;';

        // Gather displaced bunks per field with alternatives
        const fieldPlans = busyFields.filter(loc => {
            // Only process fields that have a conflict object (skip league-locked / access-restricted)
            return loc.conflict && (loc.conflict.editableConflicts?.length > 0 || loc.conflict.nonEditableConflicts?.length > 0);
        }).map(loc => {
            const conflictBunks = [...new Set([
                ...(loc.conflict.editableConflicts || []).map(c => c.bunk),
                ...(loc.conflict.nonEditableConflicts || []).map(c => c.bunk)
            ])];
            const simUsage = window.buildFieldUsageBySlot?.([]) || {};
            const sharedClaimed = {};
            // Mark this field as taken in sim
            targetSlots.forEach(idx => {
                if (!simUsage[idx]) simUsage[idx] = {};
                simUsage[idx][loc.name] = { count: 999, bunks: {}, divisions: [] };
            });
            const alts = conflictBunks.map(cb => {
                const cbDiv = getDivisionForBunk(cb);
                const cbSlots = findSlotsForRange(startMin, endMin, cbDiv, cb);
                const alt = findAlternativeForBunk(cb, cbSlots.length ? cbSlots : targetSlots, cbDiv, simUsage, [loc.name], sharedClaimed);
                if (alt) {
                    if (!sharedClaimed[alt.field]) sharedClaimed[alt.field] = [];
                    sharedClaimed[alt.field].push({ bunk: cb, div: cbDiv });
                    (cbSlots.length ? cbSlots : targetSlots).forEach(idx => {
                        if (!simUsage[idx]) simUsage[idx] = {};
                        if (!simUsage[idx][alt.field]) simUsage[idx][alt.field] = { count: 0, bunks: {}, divisions: [] };
                        simUsage[idx][alt.field].count++;
                        simUsage[idx][alt.field].bunks[cb] = alt.activityName;
                        if (!simUsage[idx][alt.field].divisions.includes(cbDiv)) simUsage[idx][alt.field].divisions.push(cbDiv);
                    });
                }
                return { bunk: cb, alt, editable: (loc.conflict.editableConflicts || []).some(c => c.bunk === cb) };
            });
            return { loc, conflictBunks, alts };
        });

        // Only show fields where all displaceable bunks have alternatives
        const actionable = fieldPlans.filter(p => p.alts.every(a => a.alt || !a.editable));

        overlay.innerHTML = `<div style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.25);width:500px;max-width:95vw;max-height:85vh;overflow-y:auto;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h2 style="margin:0;font-size:1.1rem;color:#1e40af;">Make Room for ${escapeHtml(activityName)}</h2>
                <button id="mr-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#9ca3af;">&times;</button>
            </div>
            <p style="margin:0 0 16px;font-size:0.875rem;color:#6b7280;">All courts that support <strong>${escapeHtml(activityName)}</strong> are in use. Here's the plan to free one up:</p>
            ${actionable.length === 0 ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#991b1b;font-size:0.875rem;">No room can be made — all displaced bunks have no available alternatives right now.</div>` :
            actionable.map((plan, pi) => `
                <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px;margin-bottom:12px;">
                    <div style="font-weight:600;color:#0369a1;margin-bottom:8px;">Free up: <strong>${escapeHtml(plan.loc.name)}</strong></div>
                    <div style="display:flex;flex-direction:column;gap:6px;">
                    ${plan.alts.map(a => `
                        <div style="display:flex;align-items:center;gap:8px;font-size:0.85rem;">
                            <span style="font-weight:600;color:#374151;min-width:80px;">${escapeHtml(a.bunk)}</span>
                            <span style="color:#9ca3af;">→</span>
                            <span style="color:${a.alt ? '#065f46' : '#991b1b'};">
                                ${a.alt ? `${escapeHtml(a.alt.activityName)}${a.alt.field ? ' @ ' + escapeHtml(a.alt.field) : ''}` : (a.editable ? 'No alternative' : 'Other scheduler')}
                            </span>
                        </div>`).join('')}
                    </div>
                    <button data-plan-idx="${pi}" class="mr-apply-btn" style="margin-top:12px;width:100%;padding:10px;background:#0369a1;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:0.9rem;">
                        Apply — Free ${escapeHtml(plan.loc.name)} for ${escapeHtml(activityName)}
                    </button>
                </div>`).join('')}
            <button id="mr-ignore" style="width:100%;padding:10px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;font-weight:500;cursor:pointer;margin-top:4px;">Place Without a Court (ignore field)</button>
        </div>`;

        document.body.appendChild(overlay);

        overlay.querySelector('#mr-close').onclick = () => overlay.remove();
        overlay.querySelector('#mr-ignore')?.addEventListener('click', () => {
            overlay.remove();
            onFieldFreed(null); // place with no field assignment
        });

        overlay.querySelectorAll('.mr-apply-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const pi = parseInt(btn.dataset.planIdx);
                const plan = actionable[pi];
                overlay.remove();

                // Slice 4 audit R-2 — build counts payload BEFORE writes so
                // peiUndo can invert applyPostEditCounts correctly. We use
                // the pre-edit scheduleAssignments state (captured here)
                // to enumerate each bunk's old activities at the affected
                // slot range.
                const _mrBunks = [bunk].concat((plan.alts || []).map(function (a) { return a.bunk; }).filter(Boolean));
                const _mrCounts = [];
                // Primary bunk counts entry
                const _primaryDiv = getDivisionForBunk(bunk);
                const _primarySlots = findSlotsForRange(startMin, endMin, _primaryDiv, bunk);
                if (_primarySlots && _primarySlots.length > 0) {
                    const _primaryOldActs = _primarySlots
                        .filter(function (i) { return window.scheduleAssignments[bunk]?.[i] && !window.scheduleAssignments[bunk][i].continuation; })
                        .map(function (i) { return window.scheduleAssignments[bunk][i]._activity; })
                        .filter(Boolean);
                    _mrCounts.push({ bunk: bunk, newAct: activityName, oldActs: _primaryOldActs, slots: _primarySlots });
                }
                (plan.alts || []).forEach(function (a) {
                    if (!a || !a.alt || !a.editable) return;
                    const cbDiv = getDivisionForBunk(a.bunk);
                    const cbSlots = findSlotsForRange(startMin, endMin, cbDiv, a.bunk);
                    if (!cbSlots || cbSlots.length === 0) return;
                    const oldActsBeforeWrite = cbSlots
                        .filter(function (i) { return window.scheduleAssignments[a.bunk]?.[i] && !window.scheduleAssignments[a.bunk][i].continuation; })
                        .map(function (i) { return window.scheduleAssignments[a.bunk][i]._activity; })
                        .filter(Boolean);
                    _mrCounts.push({
                        bunk: a.bunk,
                        newAct: a.alt.activityName,
                        oldActs: oldActsBeforeWrite,
                        slots: cbSlots
                    });
                });
                if (typeof window.peiSnapshotTransaction === 'function') {
                    window.peiSnapshotTransaction(_mrBunks, 'Make Room for ' + bunk, { counts: _mrCounts });
                }

                // Slice 4 audit fix — mark post-edit-in-progress so realtime
                // sync doesn't clobber the in-flight cascade.
                markPostEditInProgress();

                // Slice 4 audit fix — validate every displacement at commit
                // time. Earlier these writes trusted the simulation done
                // upstream, but state could change between sim and commit
                // (parallel tab / realtime). We also cap the cascade depth
                // implicitly here: `plan.alts` enumerates only first-level
                // displacements. If a downstream bunk would itself overflow,
                // the commit-time check refuses the move.
                const modifiedBunks = new Set([bunk]);
                const _displacedDeltas = [];
                const _displacedRejected = [];

                for (const { bunk: cb, alt, editable } of plan.alts) {
                    if (!alt || !editable) continue;
                    const cbDiv = getDivisionForBunk(cb);
                    const cbSlots = findSlotsForRange(startMin, endMin, cbDiv, cb);
                    if (!cbSlots || cbSlots.length === 0) continue;
                    const _altCheck = commitManualWriteIfLegal(
                        cb, cbSlots[0], alt.activityName, alt.field, cbDiv,
                        startMin, endMin,
                        { allowSoftOverride: true, slotRange: cbSlots }
                    );
                    if (!_altCheck.ok && !_altCheck.soft) {
                        _displacedRejected.push({ bunk: cb, reason: _altCheck.reason });
                        continue;
                    }
                    if (!window.scheduleAssignments[cb]) window.scheduleAssignments[cb] = [];
                    const oldAct = (cbSlots).filter(i => window.scheduleAssignments[cb]?.[i] && !window.scheduleAssignments[cb][i].continuation)
                        .map(i => window.scheduleAssignments[cb][i]._activity).filter(Boolean);
                    cbSlots.forEach((idx, i) => {
                        window.scheduleAssignments[cb][idx] = {
                            field: alt.field, sport: alt.activityName, _activity: alt.activityName,
                            // _pinned so the next auto-gen doesn't immediately
                            // overwrite this displacement; the user explicitly
                            // chose this alternative.
                            _fixed: true, _pinned: true, _madeRoom: true, continuation: i > 0,
                            _startMin: startMin, _endMin: endMin
                        };
                    });
                    modifiedBunks.add(cb);
                    _displacedDeltas.push({ bunk: cb, oldAct, newAct: alt.activityName, slots: cbSlots });
                }

                if (_displacedRejected.length > 0) {
                    console.warn('[MakeRoom] Rejected ' + _displacedRejected.length + ' displacement(s):',
                        _displacedRejected.map(function (r) { return r.bunk + ': ' + r.reason; }).join('; '));
                    if (typeof window.showNotification === 'function') {
                        window.showNotification('Rejected ' + _displacedRejected.length + ' displacement(s) (rule violations)', 'warning');
                    }
                }

                if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

                // ★ Update counts (historicalCounts + rotationHistory) per bunk
                //   via the shared applyPostEditCounts. It handles slot counting,
                //   timestamps, and a debounced cloud sync.
                try {
                    const _ape = window.SchedulerCoreUtils?.applyPostEditCounts;
                    if (_ape) {
                        _displacedDeltas.forEach(d => _ape(d.bunk, d.oldAct, d.newAct, d.slots));
                    }
                } catch (_e) { console.warn('[Displacement] post-edit counts failed:', _e); }

                // Notify the rotation tab so it refreshes after the displacement.
                try {
                    const _rcDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                    document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
                        detail: { bunks: [...modifiedBunks], date: _rcDate, source: 'displacement' }
                    }));
                } catch (_e) { /* non-fatal */ }

                if (typeof renderStaggeredView === 'function') renderStaggeredView();
                if (typeof updateTable === 'function') updateTable();

                // Build summary of displaced bunk reassignments
                const reassignSummary = plan.alts
                    .filter(a => a.alt && a.editable)
                    .map(a => `${a.bunk} → ${a.alt.activityName}${a.alt.field ? ' @ ' + a.alt.field : ''}`)
                    .join('\n');

                // Now the field is free — proceed with the original edit
                onFieldFreed(plan.loc.name, reassignSummary);
            });
        });
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const divName = getDivisionForBunk(bunk);
        const _hasPerBunk = !!window.divisionTimes?.[divName]?._perBunkSlots;
        let currentActivity = currentValue || '', currentField = '', resolutionChoice = 'notify';
        // ★ Pass the bunk in auto mode. Without it findSlotsForRange falls through
        //   to DIVISION-level slots and returns an index that points at the WRONG
        //   per-bunk entry — pre-filling the activity box with a stale/foreign
        //   value, which then filters the activity dropdown down to nothing. For a
        //   fresh gap this must resolve to the empty materialized slot so the box
        //   stays blank and the dropdown shows every activity.
        const slots = findSlotsForRange(startMin, endMin, divName, _hasPerBunk ? bunk : null);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = fieldLabel(entry.field);
                currentActivity = entry._activity || currentField || currentValue;
            }
        }
        const allActivities = [...new Set(locations.flatMap(l => l.activities || []))].sort();

        modal.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
                <h2 style="margin:0;font-size:1.2rem;color:#1f2937;">Edit Schedule</h2>
                <button id="post-edit-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#9ca3af;">&times;</button>
            </div>
            <div style="background:#f3f4f6;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:0.875rem;">
                <span style="font-weight:600;color:#374151;">${escapeHtml(bunk)}</span>
                <span style="color:#6b7280;margin-left:8px;">${minutesToTimeLabel(startMin)} – ${minutesToTimeLabel(endMin)}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:14px;">
                <div>
                    <label style="display:block;font-weight:600;color:#374151;margin-bottom:6px;">What activity?</label>
                    <input type="text" id="post-edit-activity" list="post-edit-activity-list"
                        value="${escapeHtml(currentActivity)}" placeholder="e.g., Basketball"
                        style="width:100%;padding:10px 12px;border:1.5px solid #6366f1;border-radius:8px;font-size:1rem;box-sizing:border-box;outline:none;">
                    <datalist id="post-edit-activity-list">${allActivities.map(a => `<option value="${escapeHtml(a)}">`).join('')}</datalist>
                    <div style="font-size:0.75rem;color:#9ca3af;margin-top:3px;">Type an activity — the system will find a free court. Enter CLEAR to empty.</div>
                </div>
                <div id="post-edit-field-result" style="display:none;"></div>
                <details id="post-edit-location-wrap" style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
                    <summary style="font-weight:500;color:#6b7280;cursor:pointer;font-size:0.875rem;">Override field manually</summary>
                    <select id="post-edit-location" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;box-sizing:border-box;background:white;margin-top:8px;">
                        <option value="">-- No specific field --</option>
                        <optgroup label="Fields">${locations.filter(l => l.type === 'field').map(l => `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}${l.capacity > 1 ? ` (cap:${l.capacity})` : ''}</option>`).join('')}</optgroup>
                        <optgroup label="Special Activities">${locations.filter(l => l.type === 'special').map(l => `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}</option>`).join('')}</optgroup>
                    </select>
                </details>
                <div id="post-edit-conflict" style="display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:12px;">
                    <button id="post-edit-cancel" style="flex:1;padding:11px;border:1px solid #d1d5db;border-radius:8px;background:white;color:#374151;font-size:0.95rem;cursor:pointer;font-weight:500;">Cancel</button>
                    <button id="post-edit-save" style="flex:1;padding:11px;border:none;border-radius:8px;background:#2563eb;color:white;font-size:0.95rem;cursor:pointer;font-weight:600;">Save Changes</button>
                </div>
            </div>`;

        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;

        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea  = document.getElementById('post-edit-conflict');
        const fieldResult   = document.getElementById('post-edit-field-result');
        const actInput      = document.getElementById('post-edit-activity');

        function renderConflictArea(location) {
            if (!location) { conflictArea.style.display = 'none'; return null; }
            const targetSlots = findSlotsForRange(startMin, endMin, divName, _hasPerBunk ? bunk : null);
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            if (conflictCheck.hasConflict) {
                const allAutoResolvable = conflictCheck.conflicts.every(c => c._autoResolvable);
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                conflictArea.style.display = 'block';
                let html = allAutoResolvable && !conflictCheck.globalLock
                    ? `<div style="background:#dbeafe;border:1px solid #3b82f6;border-radius:8px;padding:12px;"><strong style="color:#1e40af;">Will Auto-Reassign</strong><p style="margin:6px 0 0;font-size:0.85rem;color:#1e3a5f;">${escapeHtml(location)} is in use — affected bunks will be auto-moved:</p>`
                    : `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px;"><strong style="color:#92400e;">Field Conflict</strong><p style="margin:6px 0 0;font-size:0.85rem;color:#78350f;">${escapeHtml(location)} is already in use:</p>`;
                if (editableBunks.length)    html += `<div style="margin-top:8px;padding:6px 8px;background:#d1fae5;border-radius:6px;font-size:0.8rem;color:#065f46;">Can auto-reassign: ${editableBunks.map(escapeHtml).join(', ')}</div>`;
                if (nonEditableBunks.length) html += `<div style="margin-top:6px;padding:6px 8px;background:#fee2e2;border-radius:6px;font-size:0.8rem;color:#991b1b;">✗ Other scheduler's bunks: ${nonEditableBunks.map(escapeHtml).join(', ')}</div>
                    <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
                        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:8px;background:white;border-radius:6px;border:2px solid #d1d5db;"><input type="radio" name="conflict-resolution" value="notify" checked style="margin-top:2px;"><div><div style="font-weight:500;">Override &amp; flag the other scheduler</div><div style="font-size:0.75rem;color:#6b7280;">Take the slot; their conflicting activity is flagged and they're notified</div></div></label>
                        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:8px;background:white;border-radius:6px;border:2px solid #d1d5db;"><input type="radio" name="conflict-resolution" value="bypass" style="margin-top:2px;"><div><div style="font-weight:500;">Override &amp; reschedule the other scheduler</div><div style="font-size:0.75rem;color:#6b7280;">Take the slot; their conflict is auto-rescheduled and they're notified</div></div></label>
                    </div>`;
                html += '</div>';
                conflictArea.innerHTML = html;
                conflictArea.querySelectorAll('input[name="conflict-resolution"]').forEach(r => r.addEventListener('change', e => resolutionChoice = e.target.value));
                return conflictCheck;
            } else {
                conflictArea.style.display = 'none';
                return null;
            }
        }

        // ── Activity-first field search ───────────────────────────────────────
        let _searchTimer;
        function runActivitySearch() {
            const actVal = actInput.value.trim();
            const isClear = !actVal || ['clear','free'].includes(actVal.toLowerCase());
            if (isClear) { fieldResult.style.display = 'none'; locationSelect.value = ''; return; }

            const targetSlots = findSlotsForRange(startMin, endMin, divName, _hasPerBunk ? bunk : null);
            const { open, busy, none } = findFieldsForActivity(actVal, targetSlots, divName, bunk, startMin, endMin);

            if (none) { fieldResult.style.display = 'none'; return; }

            fieldResult.style.display = 'block';
            locationSelect.value = '';

            if (open.length > 0) {
                const fieldButtons = open.map(l => {
                    const bg = l.shared ? '#fffbeb' : '#f0fdf4';
                    const border = l.shared ? '#fcd34d' : '#86efac';
                    const color = l.shared ? '#92400e' : '#065f46';
                    const label = escapeHtml(l.name) + (l.shared ? ' <span style="font-size:0.72rem;opacity:0.8;">! shared</span>' : '') + (l.capacity > 1 ? ' <span style="opacity:0.6;font-size:0.75rem;">(cap:' + l.capacity + ')</span>' : '');
                    return `<button class="pe-field-pick" data-field="${escapeHtml(l.name)}" style="padding:8px 14px;background:${bg};border:1.5px solid ${border};border-radius:8px;font-size:0.85rem;cursor:pointer;font-weight:500;color:${color};transition:all 0.15s;">${label}</button>`;
                }).join('');
                const busyNote = busy.length > 0
                    ? `<div style="margin-top:8px;font-size:0.78rem;color:#9ca3af;">Unavailable: ${busy.map(b => {
                        const reason = b.reason === 'access_restricted' ? 'no access' : b.reason === 'league_locked' ? 'league' : 'in use';
                        return escapeHtml(b.name) + ' <span style="opacity:0.7">(' + reason + ')</span>';
                    }).join(', ')}</div>`
                    : '';
                fieldResult.innerHTML = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;">
                    <div style="font-weight:600;font-size:0.85rem;color:#166534;margin-bottom:8px;">Available fields for ${escapeHtml(actVal)}:</div>
                    <div style="display:flex;flex-wrap:wrap;gap:8px;">${fieldButtons}</div>
                    ${busyNote}
                </div>`;
                fieldResult.querySelectorAll('.pe-field-pick').forEach(btn => {
                    btn.addEventListener('click', () => {
                        fieldResult.querySelectorAll('.pe-field-pick').forEach(b => { b.style.background = '#f0fdf4'; b.style.borderColor = '#86efac'; b.style.color = '#065f46'; });
                        btn.style.background = '#dcfce7'; btn.style.borderColor = '#16a34a'; btn.style.color = '#14532d';
                        locationSelect.value = btn.dataset.field;
                        renderConflictArea(btn.dataset.field);
                    });
                });
            } else {
                fieldResult.innerHTML = `<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px;font-size:0.875rem;color:#78350f;">
                    All fields for <strong>${escapeHtml(actVal)}</strong> are unavailable.
                    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                        <button id="pe-ignore-field" style="padding:7px 14px;background:#fff;border:1px solid #d1d5db;border-radius:6px;font-size:0.82rem;cursor:pointer;font-weight:500;">Place Anyway (no field)</button>
                        <button id="pe-make-room" style="padding:7px 14px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;font-size:0.82rem;cursor:pointer;font-weight:600;">Make Room</button>
                    </div>
                </div>`;
                fieldResult.querySelector('#pe-ignore-field')?.addEventListener('click', () => {
                    locationSelect.value = '';
                    fieldResult.innerHTML = `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;font-size:0.85rem;color:#1e40af;">Will place <strong>${escapeHtml(actVal)}</strong> without a specific field.</div>`;
                });
                fieldResult.querySelector('#pe-make-room')?.addEventListener('click', () => {
                    showMakeRoomModal(actVal, busy, targetSlots, divName, bunk, startMin, endMin, (freedField, reassignSummary) => {
                        if (freedField) {
                            locationSelect.value = freedField;
                        } else {
                            locationSelect.value = '';
                        }
                        // Auto-save immediately — no need to click "Save Changes"
                        document.getElementById('post-edit-save')?.click();
                        // Show summary toast of all changes
                        if (reassignSummary) {
                            showIntegratedToast(`Room made! Reassigned:\n${reassignSummary}`, 'success', 5000);
                        }
                    });
                });
            }
        }

        actInput.addEventListener('input', () => {
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(runActivitySearch, 380);
        });
        locationSelect.addEventListener('change', () => renderConflictArea(locationSelect.value));

        // Run search on open if there's already an activity set
        if (currentActivity && currentActivity.toLowerCase() !== 'free') {
            setTimeout(runActivitySearch, 50);
        } else {
            renderConflictArea(currentField);
        }

        document.getElementById('post-edit-save').onclick = () => {
            const activity = actInput.value.trim();
            const location = locationSelect.value;
            if (!activity) { alert('Please enter an activity name.'); return; }
            const targetSlots = findSlotsForRange(startMin, endMin, divName, _hasPerBunk ? bunk : null);
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            if (conflictCheck?.hasConflict) {
                onSave({ activity, location, startMin, endMin, hasConflict: true,
                    conflicts: conflictCheck.conflicts,
                    editableConflicts: conflictCheck.editableConflicts || [],
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [],
                    resolutionChoice });
            } else {
                onSave({ activity, location, startMin, endMin, hasConflict: false, conflicts: [] });
            }
            closeModal();
        };
        actInput.focus();
        actInput.select();
    }

    // =========================================================================
    // FIELD PRIORITY CLAIM & INTEGRATED EDIT SYSTEM (v4.0.3)
    // =========================================================================

    function minutesToTimeStr(minutes) {
        if (minutes === null || minutes === undefined) return '';
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    function findAllConflictsForClaim(fieldName, slots, excludeBunks = []) {
        const conflicts = [];
        const assignments = window.scheduleAssignments || {};
        const excludeSet = new Set(excludeBunks);

        for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
            if (excludeSet.has(bunkName)) continue;
            if (!bunkSlots || !Array.isArray(bunkSlots)) continue;

            for (const slotIdx of slots) {
                const entry = bunkSlots[slotIdx];
                if (!entry) continue;
                
                const entryField = fieldLabel(entry.field);
                if (entryField !== fieldName) continue;
                
                const divName = getDivisionForBunk(bunkName);
                const isPinned = entry._fixed || entry._pinned || entry._bunkOverride;
                
                conflicts.push({
                    bunk: bunkName,
                    slot: slotIdx,
                    division: divName,
                    currentActivity: entry._activity || entry.sport || entryField,
                    currentField: entryField,
                    isPinned: isPinned,
                    entry: entry
                });
            }
        }

        return conflicts;
    }

    function buildCascadeResolutionPlan(fieldName, slots, claimingDivision, claimingActivity, claimingBunks = []) {
        // No field selected (activity-first "place without court") — no conflicts to resolve
        if (!fieldName) return { success: true, plan: [], blocked: [] };

        console.log('[CascadeClaim] *** BUILDING RESOLUTION PLAN ***');
        console.log(`[CascadeClaim] Claiming ${fieldName} for ${claimingDivision} (${claimingActivity})`);
        console.log(`[CascadeClaim] Slots: ${slots.join(', ')}`);

        const plan = [];
        const blocked = [];
        const processedConflicts = new Set();
        const fieldUsageBySlot = window.buildFieldUsageBySlot?.([]) || {};
        
        const simulatedUsage = JSON.parse(JSON.stringify(fieldUsageBySlot));
        for (const slotIdx of slots) {
            if (!simulatedUsage[slotIdx]) simulatedUsage[slotIdx] = {};
            simulatedUsage[slotIdx][fieldName] = {
                count: 999,
                bunks: { '_CLAIMED_': claimingActivity },
                divisions: [claimingDivision]
            };
        }

       // * Check GlobalFieldLocks for league games / specialty events on this field
        const globalLock = window.GlobalFieldLocks?.isFieldLocked?.(fieldName, slots, claimingDivision);
        if (globalLock) {
            const lockDesc = globalLock.leagueName 
                ? `League game: ${globalLock.leagueName}` 
                : (globalLock.activity || globalLock.lockedBy || 'Another event');
            console.log(`[CascadeClaim] [X] BLOCKED by global lock: ${lockDesc}`);
            return { 
                success: false, 
                plan: [], 
                blocked: [{ 
                    reason: `${lockDesc} is using ${fieldName} during this time. Please reschedule the league game first or choose a different field.`,
                    globalLock: true,
                    lockInfo: globalLock
                }] 
            };
        }

       // * Check for league games using this field (scans leagueAssignments directly — works post-generation)
        const claimDivSlots = window.divisionTimes?.[claimingDivision] || [];
        // *** AUTO MODE: Get time range from per-bunk slots or use first claiming bunk ***
        const _claimPerBunk = claimingBunks.length > 0 
            ? window.divisionTimes?.[claimingDivision]?._perBunkSlots?.[String(claimingBunks[0])]
            : null;
        const _claimSlotSource = _claimPerBunk || claimDivSlots;
        let leagueConflictDesc = null;
        if (_claimSlotSource.length > 0 && slots.length > 0) {
            const claimStartMin = _claimSlotSource[slots[0]]?.startMin;
            const claimEndMin = _claimSlotSource[slots[slots.length - 1]]?.endMin;
            if (claimStartMin != null && claimEndMin != null) {
                const leagueAssignments = window.leagueAssignments || {};
                const fieldLower = fieldName.toLowerCase();
                
                for (const [dName, divLeagues] of Object.entries(leagueAssignments)) {
                    if (leagueConflictDesc) break;
                    const dSlots = window.divisionTimes?.[dName] || [];
                    
                    for (const [slotIdxStr, slotData] of Object.entries(divLeagues || {})) {
                        if (leagueConflictDesc) break;
                        const slotIdx = parseInt(slotIdxStr, 10);
                        const slot = dSlots[slotIdx];
                        if (!slot) continue;
                        
                        // Time overlap check
                        if (slot.startMin >= claimEndMin || slot.endMin <= claimStartMin) continue;
                        
                        // Check if any matchup in this league slot uses our field
                       const matchups = slotData.matchups || [];
                        const usesField = matchups.some(m => {
                            if (typeof m === 'string') {
                                return m.toLowerCase().includes('@ ' + fieldLower) || 
                                       m.toLowerCase().includes('@' + fieldLower);
                            } else if (m && typeof m === 'object') {
                                return (m.field || '').toLowerCase() === fieldLower ||
                                       (m.display || '').toLowerCase().includes('@ ' + fieldLower);
                            }
                            return false;
                        });
                        
                        if (usesField) {
                            leagueConflictDesc = slotData.gameLabel || slotData.leagueName || 'League game';
                            if (dName) leagueConflictDesc += ` (${dName})`;
                            console.log(`[CascadeClaim] Found league conflict: "${leagueConflictDesc}" in ${dName} slot ${slotIdx} uses ${fieldName}`);
                        }
                    }
                }
            }
        }
        if (leagueConflictDesc) {
            console.log(`[CascadeClaim] [X] BLOCKED by league game: ${leagueConflictDesc}`);
            return {
                success: false,
                plan: [],
                blocked: [{
                    reason: `${leagueConflictDesc} is using ${fieldName} during this time. Please reschedule the league game first or choose a different field.`,
                    globalLock: true,
                    lockInfo: { leagueName: leagueConflictDesc, lockedBy: 'league_game' }
                }]
            };
        }
// *** AUTO MODE: findAllConflictsForClaim uses slot indices which are bunk-specific.
        // In auto mode, we need to find conflicts by TIME overlap instead. ***
        const _isAutoMode = !!window.divisionTimes?.[claimingDivision]?._perBunkSlots;
        let conflictQueue;
        if (_isAutoMode && claimDivSlots.length > 0 && slots.length > 0) {
            const _claimStart = claimDivSlots[slots[0]]?.startMin;
            const _claimEnd = claimDivSlots[slots[slots.length - 1]]?.endMin;
            conflictQueue = [];
            if (_claimStart != null && _claimEnd != null) {
                const assignments = window.scheduleAssignments || {};
                const excludeSet = new Set(claimingBunks);
                for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                    if (excludeSet.has(bunkName)) continue;
                    if (!bunkSlots || !Array.isArray(bunkSlots)) continue;
                    const bunkDiv = getDivisionForBunk(bunkName);
                    const bunkPerSlots = window.divisionTimes?.[bunkDiv]?._perBunkSlots?.[String(bunkName)] 
                                      || window.divisionTimes?.[bunkDiv] || [];
                    for (let idx = 0; idx < bunkPerSlots.length; idx++) {
                        const slot = bunkPerSlots[idx];
                        if (!slot || slot.startMin === undefined) continue;
                        if (!(slot.endMin <= _claimStart || slot.startMin >= _claimEnd)) {
                            const entry = bunkSlots[idx];
                            if (!entry) continue;
                            const entryField = fieldLabel(entry.field);
                            if (entryField !== fieldName) continue;
                            conflictQueue.push({
                                bunk: bunkName, slot: idx, division: bunkDiv,
                                currentActivity: entry._activity || entry.sport || entryField,
                                currentField: entryField,
                                isPinned: entry._fixed || entry._pinned || entry._bunkOverride,
                                entry
                            });
                        }
                    }
                }
            }
        } else {
            conflictQueue = findAllConflictsForClaim(fieldName, slots, claimingBunks);
        }
        let iteration = 0;
        const MAX_ITERATIONS = 50;

        while (conflictQueue.length > 0 && iteration < MAX_ITERATIONS) {
            iteration++;
            const conflict = conflictQueue.shift();
            const conflictKey = `${conflict.bunk}:${conflict.slot}`;
            
            if (processedConflicts.has(conflictKey)) continue;
            processedConflicts.add(conflictKey);

            console.log(`[CascadeClaim] Processing conflict #${iteration}: ${conflict.bunk} @ slot ${conflict.slot}`);

            if (conflict.isPinned) {
                console.log(`[CascadeClaim] [X] BLOCKED: ${conflict.bunk} has PINNED activity`);
                blocked.push(conflict);
                continue;
            }

            const alternative = findAlternativeForBunk(
                conflict.bunk,
                [conflict.slot],
                conflict.division,
                simulatedUsage,
                [conflict.currentField]
            );

            if (!alternative) {
                console.log(`[CascadeClaim] [X] BLOCKED: No alternative for ${conflict.bunk}`);
                blocked.push({ ...conflict, reason: 'No alternative activity available' });
                continue;
            }

            console.log(`[CascadeClaim] OK - Found alternative: ${alternative.activityName} @ ${alternative.field}`);

            plan.push({
                bunk: conflict.bunk,
                slot: conflict.slot,
                division: conflict.division,
                from: { activity: conflict.currentActivity, field: conflict.currentField },
                to: { activity: alternative.activityName, field: alternative.field }
            });

            if (simulatedUsage[conflict.slot]?.[conflict.currentField]) {
                simulatedUsage[conflict.slot][conflict.currentField].count--;
                delete simulatedUsage[conflict.slot][conflict.currentField].bunks[conflict.bunk];
            }

            if (!simulatedUsage[conflict.slot]) simulatedUsage[conflict.slot] = {};
            if (!simulatedUsage[conflict.slot][alternative.field]) {
                simulatedUsage[conflict.slot][alternative.field] = { count: 0, bunks: {}, divisions: [] };
            }
            simulatedUsage[conflict.slot][alternative.field].count++;
            simulatedUsage[conflict.slot][alternative.field].bunks[conflict.bunk] = alternative.activityName;

            const newConflicts = checkIfMoveCreatesConflict(
                conflict.bunk, conflict.slot, alternative.field, simulatedUsage, processedConflicts
            );

            if (newConflicts.length > 0) {
                console.log(`[CascadeClaim] Ripple: ${newConflicts.length} new conflicts`);
                conflictQueue.push(...newConflicts);
            }
        }

        const success = blocked.length === 0;
        console.log(`[CascadeClaim] Plan complete: ${plan.length} moves, ${blocked.length} blocked`);

        return { success, plan, blocked };
    }

    function findAlternativeForBunk(bunk, slots, divName, simulatedUsage, excludeFields = [], claimedFields = {}) {
        const activityProps = getActivityProperties();
        const excludeSet = new Set(excludeFields.map(f => fieldLabel(f)));
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fieldsBySport = settings.fieldsBySport || {};
        const disabledFields = window.currentDisabledFields || [];

        // Pre-compute league fields and time range for this slot window
        const divSlots = window.divisionTimes?.[divName] || [];
        const _altStartMin = divSlots[slots[0]]?.startMin;
        const _altEndMin = divSlots[slots[slots.length - 1]]?.endMin;
        const _leagueFields = (_altStartMin != null && _altEndMin != null)
            ? _getLeagueFieldsInTimeRange(_altStartMin, _altEndMin) : new Set();

        function _isFieldBlockedByLeagueOrCombo(fName) {
            if (_leagueFields.has(fName.toLowerCase())) return true;
            if (window.FieldCombos?.isInCombo?.(fName)) {
                const exclusive = window.FieldCombos.getExclusiveFields(fName);
                if (exclusive.some(f => _leagueFields.has(f.toLowerCase()))) return true;
            }
            if (_altStartMin != null && _altEndMin != null) {
                if (!checkFieldAvailableByTime(fName, _altStartMin, _altEndMin, bunk, activityProps)) return true;
            }
            return false;
        }

        // Bunk-level access restriction check
        function _isBunkBlockedByAccess(fName, bunkName) {
            let props = activityProps[fName] || activityProps[fName.toLowerCase()] || {};
            if (!props.accessRestrictions?.enabled) {
                const specialData = window.getSpecialActivityByName?.(fName)
                    || (app1.specialActivities || []).find(s => s.name === fName);
                if (specialData?.accessRestrictions?.enabled) {
                    props = specialData;
                } else {
                    return false;
                }
            }
            const allowedDivs = props.accessRestrictions.divisions || {};
            if (!(divName in allowedDivs)) return true;
            const bunkList = allowedDivs[divName];
            if (Array.isArray(bunkList) && bunkList.length > 0) {
                const bStr = String(bunkName);
                const bNum = parseInt(bunkName);
                if (!bunkList.some(b => String(b) === bStr || parseInt(b) === bNum)) return true;
            }
            return false;
        }

       const candidates = [];

        // Same-day repetition guard: never suggest an activity this bunk already has today
        const _doneToday = getActivitiesDoneToday(bunk, slots[0]);

        // Check if a field is available considering capacity AND sharing rules
        function _isFieldAvailableForBunk(fName) {
            const props = activityProps[fName] || activityProps[fName.toLowerCase()] || {};
            const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);
            const shareType = props.sharableWith?.type || (props.sharable ? 'all' : 'not_sharable');

            // Check claimedFields (cross-division, slot-independent)
            const claimed = claimedFields[fName];
            if (claimed && claimed.length > 0) {
                const totalUsed = claimed.length;
                // Count how many are already using it from simUsage at our slots
                // to avoid double-counting
                if (totalUsed >= maxCapacity) return false;
                if (shareType === 'same_division' || shareType === 'not_sharable') {
                    if (claimed.some(c => c.div !== divName)) return false;
                } else if (shareType === 'custom') {
                    const allowedDivs = props.sharableWith?.divisions || [];
                    if (claimed.some(c => c.div !== divName && !allowedDivs.includes(c.div))) return false;
                }
            }

            for (const slotIdx of slots) {
                const usage = simulatedUsage[slotIdx]?.[fName];
                if (!usage || usage.count === 0) continue;
                if (usage.count >= maxCapacity) return false;
                if (shareType === 'same_division' || shareType === 'not_sharable') {
                    if (usage.divisions && usage.divisions.length > 0 && !usage.divisions.includes(divName)) return false;
                } else if (shareType === 'custom') {
                    const allowedDivs = props.sharableWith?.divisions || [];
                    if (usage.divisions && usage.divisions.some(d => d !== divName && !allowedDivs.includes(d))) return false;
                }
            }
            return true;
        }

        // * DEMO FIX: Use proper field iteration in demo mode
        if (window.__CAMPISTRY_DEMO_MODE__) {
            const isRainyMode = window.isRainyDayModeActive?.() || window.isRainyDay === true;
            const disabledSet = new Set(disabledFields);
            const seenKeys = new Set();

            // Ensure activityProperties is populated
            if (Object.keys(activityProps).length === 0 && window.refreshActivityPropertiesFromFields) {
                window.refreshActivityPropertiesFromFields();
            }

            // Iterate app1.fields (primary source — fieldsBySport may be empty in demo)
            for (const field of (app1.fields || [])) {
                if (!field.name || field.available === false) continue;
                if (excludeSet.has(field.name)) continue;
                if (disabledSet.has(field.name)) continue;
                if (window.GlobalFieldLocks?._initialized && window.GlobalFieldLocks.isFieldLocked(field.name, slots, divName)) continue;
                if (_isFieldBlockedByLeagueOrCombo(field.name)) continue;

                const fp = activityProps[field.name] || {};
                if (!isRainyMode && (fp.rainyDayOnly === true || fp.rainyDayExclusive === true)) continue;
                if (isRainyMode && (fp.rainyDayAvailable === false && field.rainyDayAvailable !== true)) continue;

                // *** FIX: Enforce accessRestrictions for division access ***
                if (fp.accessRestrictions?.enabled) {
                    const allowedDivs = fp.accessRestrictions.divisions || {};
                    if (!(divName in allowedDivs)) continue;
                }
                if (fp.preferences?.enabled && fp.preferences?.exclusive) {
                    const prefList = fp.preferences.list || [];
                    if (prefList.length > 0 && !prefList.includes(divName)) continue;
                }

                let available = true;
                const maxCap = fp.sharableWith?.capacity || (fp.sharable ? 2 : 1);
                for (const slotIdx of slots) {
                    const usage = simulatedUsage[slotIdx]?.[field.name];
                    if (usage && usage.count >= maxCap) { available = false; break; }
                }

                if (available) {
                    (field.activities || []).forEach(activity => {
                        const key = field.name + '|' + activity;
                        if (seenKeys.has(key)) return;
                        seenKeys.add(key);
                        const penalty = calculateRotationPenalty(bunk, activity, slots);
                        if (penalty !== Infinity) {
                            candidates.push({ field: field.name, activityName: activity, type: 'sport', penalty });
                        }
                    });
                }
            }

            // Also add specials
            for (const special of (app1.specialActivities || [])) {
                if (!special.name) continue;
                if (excludeSet.has(special.name) || disabledSet.has(special.name)) continue;
                if (window.GlobalFieldLocks?._initialized && window.GlobalFieldLocks.isFieldLocked(special.name, slots, divName)) continue;
                if (_isFieldBlockedByLeagueOrCombo(special.name)) continue;
                if (!isRainyMode && (special.rainyDayOnly === true || special.rainyDayExclusive === true)) continue;
                if (isRainyMode && special.rainyDayAvailable === false) continue;

                // *** FIX: Enforce accessRestrictions for division access ***
                const sp_props = activityProps[special.name] || {};
                if (sp_props.accessRestrictions?.enabled) {
                    const allowedDivs = sp_props.accessRestrictions.divisions || {};
                    if (!(divName in allowedDivs)) continue;
                }
                if (sp_props.preferences?.enabled && sp_props.preferences?.exclusive) {
                    const prefList = sp_props.preferences.list || [];
                    if (prefList.length > 0 && !prefList.includes(divName)) continue;
                }

                const key = 'special|' + special.name;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);

                let available = true;
                const sp = activityProps[special.name] || {};
                const maxCap = sp.sharableWith?.capacity || (sp.sharable ? 2 : 1);
                for (const slotIdx of slots) {
                    const usage = simulatedUsage[slotIdx]?.[special.name];
                    if (usage && usage.count >= maxCap) { available = false; break; }
                }
                if (available) {
                    const penalty = calculateRotationPenalty(bunk, special.name, slots);
                    if (penalty !== Infinity) {
                        candidates.push({ field: special.name, activityName: special.name, type: 'special', penalty });
                    }
                }
            }

            candidates.sort((a, b) => a.penalty - b.penalty);
            console.log('[findAlternative] [DEMO] Demo: ' + bunk + ': ' + candidates.length + ' candidates, best: ' + (candidates[0]?.activityName || 'none'));
            return candidates[0] || null;
        }

        for (const [sport, sportFields] of Object.entries(fieldsBySport)) {
            if (_doneToday.has(sport.toLowerCase().trim())) continue;

            (sportFields || []).forEach(fName => {
                if (excludeSet.has(fName)) return;
if (disabledFields.includes(fName)) return;
if (window.GlobalFieldLocks?._initialized && window.GlobalFieldLocks.isFieldLocked(fName, slots, divName)) return;
if (_isFieldBlockedByLeagueOrCombo(fName)) return;
if (_isBunkBlockedByAccess(fName, bunk)) return;

// *** FIX: Enforce accessRestrictions & preferences for division access during drip-down ***
const _altProps = activityProps[fName] || {};
if (_altProps.preferences?.enabled && _altProps.preferences?.exclusive) {
    const _prefList = _altProps.preferences.list || [];
    if (_prefList.length > 0 && !_prefList.includes(divName)) return;
}

// * Rainy day filtering: skip rainy-day-only activities on normal days
const isRainyMode = window.isRainyDayModeActive?.() || window.isRainyDay === true;
const fieldProps = activityProps[fName] || {};
if (!isRainyMode && (fieldProps.rainyDayOnly === true || fieldProps.rainyDayExclusive === true)) return;
if (isRainyMode && (fieldProps.rainyDayAvailable === false || fieldProps.availableOnRainyDay === false)) return;

                if (_isFieldAvailableForBunk(fName)) {
                    const penalty = calculateRotationPenalty(bunk, sport, slots);
                    if (penalty !== Infinity) {
                        candidates.push({ field: fName, activityName: sport, type: 'sport', penalty });
                    }
                }
            });
        }

       (app1.specialActivities || []).forEach(special => {
            if (!special.name) return;
            if (_doneToday.has(special.name.toLowerCase().trim())) return;
            if (excludeSet.has(special.name)) return;
            if (disabledFields.includes(special.name)) return;
            if (window.GlobalFieldLocks?._initialized && window.GlobalFieldLocks.isFieldLocked(special.name, slots, divName)) return;
            if (_isFieldBlockedByLeagueOrCombo(special.name)) return;
            if (_isBunkBlockedByAccess(special.name, bunk)) return;

            // * Rainy day filtering for special activities
            const isRainyMode = window.isRainyDayModeActive?.() || window.isRainyDay === true;
            if (!isRainyMode && (special.rainyDayOnly === true || special.rainyDayExclusive === true)) return;
            if (isRainyMode && (special.rainyDayAvailable === false || special.availableOnRainyDay === false || special.isIndoor === false)) return;

            // *** FIX: Enforce preferences for division access during drip-down ***
            const _spProps = activityProps[special.name] || {};
            if (_spProps.preferences?.enabled && _spProps.preferences?.exclusive) {
                const _prefList = _spProps.preferences.list || [];
                if (_prefList.length > 0 && !_prefList.includes(divName)) return;
            }

            if (_isFieldAvailableForBunk(special.name)) {
                const penalty = calculateRotationPenalty(bunk, special.name, slots);
                if (penalty !== Infinity) {
                    candidates.push({ field: special.name, activityName: special.name, type: 'special', penalty });
                }
            }
        });

       (app1.fields || []).forEach(field => {
            if (!field.name || field.available === false) return;
            if (excludeSet.has(field.name)) return;
            if (disabledFields.includes(field.name)) return;
            if (window.GlobalFieldLocks?._initialized && window.GlobalFieldLocks.isFieldLocked(field.name, slots, divName)) return;
            if (_isFieldBlockedByLeagueOrCombo(field.name)) return;
            if (_isBunkBlockedByAccess(field.name, bunk)) return;

            // *** FIX: Enforce preferences for division access during drip-down ***
            const _fProps = activityProps[field.name] || {};
            if (_fProps.preferences?.enabled && _fProps.preferences?.exclusive) {
                const _prefList = _fProps.preferences.list || [];
                if (_prefList.length > 0 && !_prefList.includes(divName)) return;
            }

            if (_isFieldAvailableForBunk(field.name)) {
                (field.activities || []).forEach(activity => {
                    if (_doneToday.has(activity.toLowerCase().trim())) return;
                    const penalty = calculateRotationPenalty(bunk, activity, slots);
                    if (penalty !== Infinity) {
                        candidates.push({ field: field.name, activityName: activity, type: 'sport', penalty });
                    }
                });
            }
        });

        candidates.sort((a, b) => a.penalty - b.penalty);
        
        console.log(`[findAlternative] ${bunk}: Found ${candidates.length} candidates, best: ${candidates[0]?.activityName || 'none'}`);
        
        return candidates[0] || null;
    }

    function checkIfMoveCreatesConflict(bunk, slot, newField, simulatedUsage, alreadyProcessed) {
        const newConflicts = [];
        const activityProps = getActivityProperties();
        const props = activityProps[newField] || {};
        const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);

        const usage = simulatedUsage[slot]?.[newField];
        if (!usage) return [];

        if (usage.count > maxCapacity) {
            for (const [otherBunk, activity] of Object.entries(usage.bunks)) {
                if (otherBunk === bunk || otherBunk === '_CLAIMED_') continue;
                
                const conflictKey = `${otherBunk}:${slot}`;
                if (alreadyProcessed.has(conflictKey)) continue;

                const divName = getDivisionForBunk(otherBunk);
                const entry = window.scheduleAssignments?.[otherBunk]?.[slot];
                const isPinned = entry?._fixed || entry?._pinned || entry?._bunkOverride;

                newConflicts.push({
                    bunk: otherBunk, slot, division: divName,
                    currentActivity: activity, currentField: newField,
                    isPinned, entry
                });
            }
        }

        return newConflicts;
    }

   function openIntegratedEditModal(bunk, slotIdx, existingEntry = null) {
        closeIntegratedEditModal();

        const divName = getDivisionForBunk(bunk);
        const bunksInDivision = getBunksForDivision(divName);
        // *** AUTO MODE: Per-bunk slots have bunk-specific time indices ***
        // In manual mode _perBunkSlots is undefined → perBunkSlots is undefined → uses division-level (unchanged)
        const perBunkSlots = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)];
        const times = perBunkSlots || window.divisionTimes?.[divName] || [];
        const slotInfo = times[slotIdx] || {};        const timeLabel = slotInfo.label || `${minutesToTimeStr(slotInfo.startMin)} - ${minutesToTimeStr(slotInfo.endMin)}`;

        _currentEditContext = { 
            bunk, slotIdx, divName, bunksInDivision, existingEntry, slotInfo,
            // *** AUTO MODE: Store canonical time range for cross-bunk resolution ***
            startMin: slotInfo.startMin ?? null,
            endMin: slotInfo.endMin ?? null,
            isAutoMode: !!window.divisionTimes?.[divName]?._perBunkSlots
        };

        showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEditBunk(bunk));    }
function minutesToTimeString(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function timeStringToMinutes(str) {
        if (!str) return null;
        const parts = str.split(':');
        if (parts.length !== 2) return null;
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
    function showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEdit) {
        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9998; animation: fadeIn 0.2s ease-out;`;
        overlay.onclick = closeIntegratedEditModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = INTEGRATED_EDIT_MODAL_ID;
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999; min-width: 400px; max-width: 500px; animation: fadeIn 0.2s ease-out;`;
        modal.onclick = e => e.stopPropagation();

        const currentActivity = _currentEditContext.existingEntry?._activity || 
                               _currentEditContext.existingEntry?.sport || 
                               _currentEditContext.existingEntry?.field || 'Free';
        const bunksInDiv = _currentEditContext.bunksInDivision || [];
        const divSlots = window.divisionTimes?.[divName] || [];

        modal.innerHTML = `
            <div style="margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af; font-size: 1.2rem;">Edit Schedule</h2>
            </div>
            <div style="background: #f3f4f6; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                <div style="font-size: 0.9rem; color: #6b7280;">Selected Cell</div>
                <div style="font-weight: 600; color: #1f2937; margin-top: 4px;">${escapeHtml(bunk)} • ${escapeHtml(timeLabel)}</div>
                <div style="color: #6b7280; font-size: 0.9rem; margin-top: 2px;">Current: ${escapeHtml(currentActivity)}</div>
            </div>
            <div style="margin-bottom: 20px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 12px;">What would you like to edit?</div>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="single" checked style="margin-top: 3px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; color: #1f2937;">Just this bunk</div>
                            <div style="font-size: 0.85rem; color: #6b7280; margin-top: 2px;">Edit ${escapeHtml(bunk)} only</div>
                        </div>
                    </label>
                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="division" style="margin-top: 3px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; color: #1f2937;">Entire division</div>
                            <div style="font-size: 0.85rem; color: #6b7280; margin-top: 2px;">All ${bunksInDiv.length} bunks in ${escapeHtml(divName)}</div>
                        </div>
                    </label>
                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="select" style="margin-top: 3px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; color: #1f2937;">Select specific bunks</div>
                            <div style="font-size: 0.85rem; color: #6b7280; margin-top: 2px;">Choose which bunks to edit</div>
                        </div>
                    </label>
                </div>
            </div>
            <div id="bunk-selection-area" style="display: none; margin-bottom: 20px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 8px;">Select bunks:</div>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <button onclick="document.querySelectorAll('.bunk-checkbox').forEach(cb=>cb.checked=true)" style="padding: 6px 12px; background: #e5e7eb; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer;">Select All</button>
                    <button onclick="document.querySelectorAll('.bunk-checkbox').forEach(cb=>cb.checked=false)" style="padding: 6px 12px; background: #e5e7eb; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer;">Clear</button>
                </div>
                <div id="bunk-checkboxes" style="max-height: 150px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px;">
                    ${bunksInDiv.map(b => `
                        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.9rem;">
                            <input type="checkbox" class="bunk-checkbox" value="${b}" ${b === bunk ? 'checked' : ''}>
                            <span>${escapeHtml(b)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
            <input type="hidden" id="edit-start-slot" value="${slotIdx}">
            <input type="hidden" id="edit-end-slot" value="${slotIdx}">
            ${_currentEditContext.isAutoMode ? `
            <div id="time-adjust-section" style="margin-bottom: 20px; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 10px; padding: 14px;">
                <div style="font-weight: 500; color: #0369a1; margin-bottom: 10px; font-size: 0.9rem;">Adjust Time</div>
                <div style="display: flex; gap: 12px; align-items: center;">
                    <div style="flex: 1;">
                        <label style="display: block; font-size: 0.8rem; color: #6b7280; margin-bottom: 4px;">Start</label>
                        <input type="time" id="edit-time-start" value="${_currentEditContext.startMin != null ? minutesToTimeString(_currentEditContext.startMin) : ''}" 
                            style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.9rem;">
                    </div>
                    <span style="color: #9ca3af; margin-top: 18px;">→</span>
                    <div style="flex: 1;">
                        <label style="display: block; font-size: 0.8rem; color: #6b7280; margin-bottom: 4px;">End</label>
                        <input type="time" id="edit-time-end" value="${_currentEditContext.endMin != null ? minutesToTimeString(_currentEditContext.endMin) : ''}" 
                            style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.9rem;">
                    </div>
                </div>
                <div style="font-size: 0.75rem; color: #6b7280; margin-top: 6px;">Change the time window for this activity block</div>
            </div>
            ` : ''}
            <div style="display: flex; gap: 12px;">
                <button onclick="closeIntegratedEditModal()" style="flex: 1; padding: 12px; background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; font-weight: 500; cursor: pointer;">Cancel</button>
                <button onclick="proceedWithScope()" style="flex: 1; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;">Continue →</button>
            </div>
        `;

        document.body.appendChild(modal);
        setupScopeModalHandlers();
    }

    function setupScopeModalHandlers() {
        const radios = document.querySelectorAll('input[name="edit-scope"]');
        const bunkArea = document.getElementById('bunk-selection-area');
        const timeArea = null;

        radios.forEach(radio => {
            radio.addEventListener('change', () => {
                const scope = radio.value;
                bunkArea.style.display = scope === 'select' ? 'block' : 'none';
                // Time range is fixed to clicked slot - no UI needed

                document.querySelectorAll('.edit-scope-option').forEach(opt => {
                    opt.style.borderColor = '#e5e7eb';
                    opt.style.background = '#f9fafb';
                });
                radio.closest('.edit-scope-option').style.borderColor = '#2563eb';
                radio.closest('.edit-scope-option').style.background = '#eff6ff';
            });
        });

        document.querySelector('input[name="edit-scope"]:checked')?.dispatchEvent(new Event('change'));
    }

   function proceedWithScope() {
        const scope = document.querySelector('input[name="edit-scope"]:checked')?.value;
        const ctx = _currentEditContext;
        if (!ctx) {
            alert('Edit context lost. Please try again.');
            closeIntegratedEditModal();
            return;
        }

        // *** AUTO MODE: Read adjusted time from UI ***
        let editStartMin = ctx.startMin;
        let editEndMin = ctx.endMin;
        if (ctx.isAutoMode) {
            const startInput = document.getElementById('edit-time-start');
            const endInput = document.getElementById('edit-time-end');
            if (startInput?.value) editStartMin = timeStringToMinutes(startInput.value);
            if (endInput?.value) editEndMin = timeStringToMinutes(endInput.value);
            if (editStartMin != null && editEndMin != null && editEndMin <= editStartMin) {
                alert('End time must be after start time');
                return;
            }
        }
        
        if (scope === 'single') {
            closeIntegratedEditModal();
            showEditModal(
                ctx.bunk,
                editStartMin ?? ctx.slotInfo?.startMin,
                editEndMin ?? ctx.slotInfo?.endMin,
                ctx.existingEntry?._activity || '',
                (editData) => applyEdit(ctx.bunk, editData)
            );
        } else if (scope === 'division' || scope === 'select') {
            const targetBunks = scope === 'division' 
                ? ctx.bunksInDivision 
                : Array.from(document.querySelectorAll('.bunk-checkbox:checked')).map(cb => cb.value);

            if (scope === 'select' && targetBunks.length === 0) { 
                alert('Please select at least one bunk'); 
                return; 
            }

            // *** AUTO MODE: Resolve per-bunk slots by TIME, not shared slot index ***
            if (ctx.isAutoMode && editStartMin != null && editEndMin != null) {
                closeIntegratedEditModal();
                openMultiBunkEditModal(targetBunks, null, ctx.divName, editStartMin, editEndMin);
            } else {
                // Manual mode: use slot indices as before
                const startSlot = parseInt(document.getElementById('edit-start-slot')?.value);
                const endSlot = parseInt(document.getElementById('edit-end-slot')?.value);
                if (endSlot < startSlot) { alert('End time must be after start time'); return; }
                const slots = [];
                for (let i = startSlot; i <= endSlot; i++) slots.push(i);
                closeIntegratedEditModal();
                openMultiBunkEditModal(targetBunks, slots, ctx.divName);
            }
        }
    }

   function openMultiBunkEditModal(bunks, slots, divName, timeStartMin = null, timeEndMin = null) {
        // *** AUTO MODE: Resolve per-bunk slots from time range ***
        const isAutoMode = !!window.divisionTimes?.[divName]?._perBunkSlots;
        let perBunkSlots = null;
        
        if (isAutoMode && timeStartMin != null && timeEndMin != null) {
            perBunkSlots = {};
            bunks.forEach(bunk => {
                const bunkSlots = findSlotsForRange(timeStartMin, timeEndMin, divName, bunk);
                if (bunkSlots.length > 0) perBunkSlots[String(bunk)] = bunkSlots;
            });
            // Use first bunk's slots as the "representative" for UI display
            const firstBunkSlots = perBunkSlots[String(bunks[0])] || [];
            if (!slots || slots.length === 0) slots = firstBunkSlots;
        }

        _multiBunkEditContext = { bunks, slots, divName, perBunkSlots, isAutoMode, timeStartMin, timeEndMin };
        _multiBunkPreviewResult = null;

        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9998;`;
        overlay.onclick = closeIntegratedEditModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = INTEGRATED_EDIT_MODAL_ID;
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999; min-width: 500px; max-width: 620px; max-height: 85vh; overflow-y: auto;`;
        modal.onclick = e => e.stopPropagation();

       const times = window.divisionTimes?.[divName] || [];
        let timeRange;
        if (isAutoMode && timeStartMin != null && timeEndMin != null) {
            timeRange = `${minutesToTimeStr(timeStartMin)} - ${minutesToTimeStr(timeEndMin)}`;
        } else {
            const startSlot = times[slots?.[0]];
            const endSlot = times[slots?.[slots?.length - 1]];
            timeRange = `${minutesToTimeStr(startSlot?.startMin)} - ${minutesToTimeStr(endSlot?.endMin)}`;
        }        const allLocations = getAllLocations();

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af; font-size: 1.2rem;">Multi-Bunk Edit</h2>
                <button onclick="closeIntegratedEditModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer;">&times;</button>
            </div>
            <div style="background: #eff6ff; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <div style="font-weight: 500; color: #1e40af;">${escapeHtml(divName)}</div>
                <div style="font-size: 0.9rem; color: #3b82f6; margin-top: 4px;">
                    ${bunks.length} bunks: ${bunks.slice(0, 5).map(b => escapeHtml(b)).join(', ')}${bunks.length > 5 ? ` +${bunks.length - 5} more` : ''}
                </div>
                <div style="font-size: 0.9rem; color: #6b7280; margin-top: 4px;">Time: ${timeRange}</div>
            </div>
            <div style="display: grid; gap: 14px;">
                <div>
                    <label style="display: block; font-weight: 600; margin-bottom: 6px; color: #374151;">What activity?</label>
                    <input type="text" id="multi-edit-activity" placeholder="e.g., Basketball, Soccer…"
                        style="width: 100%; padding: 10px; border: 1.5px solid #6366f1; border-radius: 8px; box-sizing: border-box; font-size: 0.95rem;">
                    <div style="font-size:0.75rem;color:#9ca3af;margin-top:3px;">Type an activity — the system will find a free court for all bunks.</div>
                </div>
                <div id="multi-field-result" style="display:none;"></div>
                <details id="multi-location-wrap" style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
                    <summary style="font-weight:500;color:#6b7280;cursor:pointer;font-size:0.875rem;">Override field manually</summary>
                    <select id="multi-edit-location" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; margin-top:8px; box-sizing:border-box;">
                        <option value="">-- No specific field --</option>
                        ${allLocations.map(loc => `<option value="${loc.name}">${escapeHtml(loc.name)}</option>`).join('')}
                    </select>
                </details>
                <div id="multi-conflict-preview" style="display: none;"></div>
                <div id="multi-resolution-mode" style="display: none;">
                    <label style="display: block; font-weight: 500; margin-bottom: 8px; color: #374151;">How to handle other schedulers' bunks?</label>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 12px; background: #f9fafb; border-radius: 8px; border: 2px solid #e5e7eb;">
                            <input type="radio" name="multi-mode" value="notify" checked style="margin-top: 3px;">
                            <div>
                                <div style="font-weight: 500; color: #374151;">Notify & Request Approval</div>
                                <div style="font-size: 0.85rem; color: #6b7280;">Changes require approval first</div>
                            </div>
                        </label>
                        <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 12px; background: #f9fafb; border-radius: 8px; border: 2px solid #e5e7eb;">
                            <input type="radio" name="multi-mode" value="bypass" style="margin-top: 3px;">
                            <div>
                                <div style="font-weight: 500; color: #374151;">Bypass & Apply Now</div>
                                <div style="font-size: 0.85rem; color: #6b7280;">Changes apply immediately</div>
                            </div>
                        </label>
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button id="multi-edit-submit" onclick="submitMultiBunkEdit()" style="flex: 1; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;" disabled>Apply</button>
            </div>
        `;

        document.body.appendChild(modal);

        // ── Activity-first search for multi-bunk modal ─────────────────────────
        const multiLocSel  = document.getElementById('multi-edit-location');
        const multiActInput = document.getElementById('multi-edit-activity');
        const multiFieldResult = document.getElementById('multi-field-result');
        if (multiActInput) {
            const allMultiActs = [...new Set(allLocations.flatMap(l => l.activities || []))].sort();
            const multiDl = document.createElement('datalist');
            multiDl.id = 'multi-edit-activity-list';
            multiDl.innerHTML = allMultiActs.map(a => `<option value="${escapeHtml(a)}">`).join('');
            multiActInput.setAttribute('list', 'multi-edit-activity-list');
            multiActInput.after(multiDl);

            const { slots: ctxSlots, divName: ctxDiv, timeStartMin: ctxStart, timeEndMin: ctxEnd, isAutoMode: ctxAuto } = _multiBunkEditContext;
            // Use representative slots from first bunk for the search
            const repSlots = ctxAuto && ctxStart != null
                ? findSlotsForRange(ctxStart, ctxEnd, ctxDiv, bunks[0])
                : (ctxSlots || []);

            let multiSearchTimer;
            function runMultiActivitySearch() {
                const actVal = multiActInput.value.trim();
                if (!actVal || ['clear','free'].includes(actVal.toLowerCase())) {
                    if (multiFieldResult) multiFieldResult.style.display = 'none';
                    if (multiLocSel) multiLocSel.value = '';
                    return;
                }
                const { open, busy, none } = findFieldsForActivity(actVal, repSlots, ctxDiv, bunks[0], ctxStart, ctxEnd);
                if (none || !multiFieldResult) return;
                multiFieldResult.style.display = 'block';
                document.getElementById('multi-edit-submit').disabled = true;
                document.getElementById('multi-conflict-preview').style.display = 'none';
                if (multiLocSel) multiLocSel.value = '';

                if (open.length > 0) {
                    const fieldButtons = open.map(l =>
                        `<button class="multi-field-pick" data-field="${escapeHtml(l.name)}" style="padding:8px 14px;background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;font-size:0.85rem;cursor:pointer;font-weight:500;color:#065f46;transition:all 0.15s;">${escapeHtml(l.name)}${l.capacity > 1 ? ' <span style="opacity:0.6;font-size:0.75rem;">(cap:' + l.capacity + ')</span>' : ''}</button>`
                    ).join('');
                    const busyNote = busy.length > 0
                        ? `<div style="margin-top:8px;font-size:0.78rem;color:#9ca3af;">Unavailable: ${busy.map(b => escapeHtml(b.name)).join(', ')}</div>`
                        : '';
                    multiFieldResult.innerHTML = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;">
                        <div style="font-weight:600;font-size:0.85rem;color:#166534;margin-bottom:8px;">Available fields for ${escapeHtml(actVal)}:</div>
                        <div style="display:flex;flex-wrap:wrap;gap:8px;">${fieldButtons}</div>
                        ${busyNote}
                    </div>`;
                    multiFieldResult.querySelectorAll('.multi-field-pick').forEach(btn => {
                        btn.addEventListener('click', () => {
                            multiFieldResult.querySelectorAll('.multi-field-pick').forEach(b => { b.style.background = '#f0fdf4'; b.style.borderColor = '#86efac'; b.style.color = '#065f46'; });
                            btn.style.background = '#dcfce7'; btn.style.borderColor = '#16a34a'; btn.style.color = '#14532d';
                            if (multiLocSel) multiLocSel.value = btn.dataset.field;
                            // Auto-preview immediately after field selection
                            previewMultiBunkEdit();
                        });
                    });
                } else if (busy.length > 0) {
                    multiFieldResult.innerHTML = `<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px;font-size:0.875rem;color:#78350f;">
                        All fields for <strong>${escapeHtml(actVal)}</strong> are unavailable.
                        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                            <button id="multi-ignore-field" style="padding:7px 14px;background:#fff;border:1px solid #d1d5db;border-radius:6px;font-size:0.82rem;cursor:pointer;">Place Anyway (no field)</button>
                            <button id="multi-make-room" style="padding:7px 14px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;font-size:0.82rem;cursor:pointer;font-weight:600;">Make Room</button>
                        </div>
                    </div>`;
                    multiFieldResult.querySelector('#multi-ignore-field')?.addEventListener('click', () => {
                        if (multiLocSel) multiLocSel.value = '';
                        multiFieldResult.innerHTML = `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;font-size:0.85rem;color:#1e40af;">Will place <strong>${escapeHtml(actVal)}</strong> without a specific field.</div>`;
                        previewMultiBunkEdit();
                    });
                    multiFieldResult.querySelector('#multi-make-room')?.addEventListener('click', () => {
                        showMakeRoomModal(actVal, busy, repSlots, ctxDiv, bunks[0], ctxStart ?? repSlots[0], ctxEnd ?? repSlots[repSlots.length-1], (freedField, reassignSummary) => {
                            if (freedField && multiLocSel) multiLocSel.value = freedField;
                            // Auto-submit immediately
                            document.getElementById('multi-edit-submit')?.click();
                            if (reassignSummary) {
                                showIntegratedToast(`Room made! Reassigned:\n${reassignSummary}`, 'success', 5000);
                            }
                        });
                    });
                } else {
                    multiFieldResult.style.display = 'none';
                }
            }

            multiActInput.addEventListener('input', () => {
                clearTimeout(multiSearchTimer);
                multiSearchTimer = setTimeout(runMultiActivitySearch, 380);
            });
            if (multiLocSel) multiLocSel.addEventListener('change', () => {
                if (multiLocSel.value) {
                    previewMultiBunkEdit();
                } else {
                    document.getElementById('multi-edit-submit').disabled = true;
                    document.getElementById('multi-conflict-preview').style.display = 'none';
                }
            });
        }
    }

    function previewMultiBunkEdit() {
        const location = document.getElementById('multi-edit-location')?.value;
        const activity = document.getElementById('multi-edit-activity')?.value?.trim();
        const { bunks, slots, divName } = _multiBunkEditContext;

        if (!activity) { alert('Please enter an activity name'); return; }
        // location may be empty (activity placed without a specific court) — that's allowed

        const result = buildCascadeResolutionPlan(location, slots, divName, activity, bunks);
        _multiBunkPreviewResult = { 
            ...result, location, slots, divName, activity, bunks,
            // *** AUTO MODE: Carry per-bunk slots and time range through to apply ***
            perBunkSlots: _multiBunkEditContext.perBunkSlots || null,
            isAutoMode: _multiBunkEditContext.isAutoMode || false,
            timeStartMin: _multiBunkEditContext.timeStartMin || null,
            timeEndMin: _multiBunkEditContext.timeEndMin || null
        };

        const previewArea = document.getElementById('multi-conflict-preview');
        const resolutionMode = document.getElementById('multi-resolution-mode');
        const submitBtn = document.getElementById('multi-edit-submit');
// Check for LEAGUE GAME blocks only — other locks are resolvable
const leagueBlocks = result.blocked.filter(b => b.globalLock && 
    (b.lockInfo?.lockedBy === 'league_game' || b.lockInfo?.leagueName));
if (leagueBlocks.length > 0) {
    previewArea.style.display = 'block';
    previewArea.style.cssText = 'background: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 12px;';
    previewArea.innerHTML = `<div style="color: #991b1b; font-weight: 500;">
        Cannot use this field
        <div style="font-weight: 400; margin-top: 6px; font-size: 0.9rem;">${leagueBlocks[0].reason}</div>
    </div>`;
    submitBtn.disabled = true;
    return;
}
// Non-league global locks — treat as resolvable
const softBlocks = result.blocked.filter(b => b.globalLock && !leagueBlocks.includes(b));
if (softBlocks.length > 0) {
    console.log('[PreviewMultiBunk] ' + softBlocks.length + ' soft global locks (non-league) — treating as resolvable');
    // Remove soft blocks from blocked, treat as if they need reassignment
    result.blocked = result.blocked.filter(b => !softBlocks.includes(b));
}
        if (result.plan.length === 0 && result.blocked.length === 0) {
            previewArea.style.display = 'none';
            resolutionMode.style.display = 'none';
            submitBtn.disabled = false;
        } else if (result.blocked.length > 0) {
            previewArea.style.display = 'block';
            previewArea.style.cssText = 'background: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; padding: 12px;';
            previewArea.innerHTML = `
                <div style="color: #991b1b; font-weight: 500;">Cannot complete - pinned activities blocking:</div>
                <ul style="margin: 8px 0 0 20px; padding: 0; color: #b91c1c;">
                    ${result.blocked.map(b => `<li>${escapeHtml(b.bunk)}: ${escapeHtml(b.currentActivity)}</li>`).join('')}
                </ul>
            `;
            resolutionMode.style.display = 'none';
            submitBtn.disabled = true;
        } else {
            const myDivisions = new Set(getMyDivisions());
            const byDivision = {};
            result.plan.forEach(p => {
                if (!byDivision[p.division]) byDivision[p.division] = [];
                byDivision[p.division].push(p);
            });

            const otherDivisions = Object.keys(byDivision).filter(d => !myDivisions.has(d));

            previewArea.style.display = 'block';
            previewArea.style.cssText = 'background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;';
            
            let html = `<div style="color: #92400e; font-weight: 500;">${result.plan.length} bunk(s) will be reassigned</div><div style="margin-top: 12px; max-height: 180px; overflow-y: auto;">`;
            for (const [div, moves] of Object.entries(byDivision)) {
                const isOther = !myDivisions.has(div);
                html += `<div style="margin-bottom: 8px; padding: 8px; background: ${isOther ? '#fef2f2' : '#f0fdf4'}; border-radius: 6px;">
                    <div style="font-weight: 500; color: ${isOther ? '#991b1b' : '#166534'};">${escapeHtml(div)}${isOther ? ' (other scheduler)' : ''}</div>
                    <ul style="margin: 4px 0 0 16px; padding: 0; font-size: 0.85rem;">${moves.map(m => `<li>${escapeHtml(m.bunk)}: ${escapeHtml(m.from.activity)} → ${escapeHtml(m.to.activity)}</li>`).join('')}</ul>
                </div>`;
            }
            html += '</div>';
            previewArea.innerHTML = html;

            resolutionMode.style.display = otherDivisions.length > 0 ? 'block' : 'none';
            submitBtn.disabled = false;
        }
    }

    async function submitMultiBunkEdit() {
        if (!_multiBunkPreviewResult) { alert('Please preview first'); return; }

        const result = _multiBunkPreviewResult;
        const mode = document.querySelector('input[name="multi-mode"]:checked')?.value || 'notify';
        const myDivisions = new Set(getMyDivisions());
        const otherMoves = result.plan.filter(p => !myDivisions.has(p.division));

        if (mode === 'bypass' || otherMoves.length === 0) {
            await applyMultiBunkEdit(result, mode === 'bypass');
        } else {
            await createMultiBunkProposal(result);
        }

        closeIntegratedEditModal();
    }

    // =========================================================================
    // AUTO-BACKUP SYSTEM
    // =========================================================================

    async function createAutoBackup(activityName, divisionName) {
        if (window.__CAMPISTRY_DEMO_MODE__) {
            console.log('[AutoBackup] [DEMO] Demo mode — skipping auto-backup');
            return { success: true, reason: 'demo_mode' };
        }
        if (!VersionManager?.saveVersion) {
            console.log('[AutoBackup] VersionManager not available, skipping backup');
            return { success: false, reason: 'VersionManager not available' };
        }

        const backupName = `${AUTO_BACKUP_PREFIX} ${activityName} (${divisionName})`;
        console.log(`[AutoBackup] * Creating restore point: ${backupName}`);

        try {
            const result = await VersionManager.saveVersion(backupName, { silent: true });
            
            if (result?.success) {
                console.log(`[AutoBackup] [OK] Backup created successfully`);
                cleanupOldAutoBackups().catch(e => 
                    console.warn('[AutoBackup] Cleanup error (non-critical):', e)
                );
                return { success: true, name: backupName };
            } else {
                console.warn('[AutoBackup] Backup may have failed:', result);
                return { success: false, reason: 'Save returned unsuccessful' };
            }
        } catch (e) {
            console.error('[AutoBackup] Error creating backup:', e);
            return { success: false, reason: e.message };
        }
    }

    async function cleanupOldAutoBackups(dateKey = null) {
        if (!VersionManager?.saveVersion || !window.ScheduleVersionsDB) {
            return { cleaned: 0 };
        }

        const targetDate = dateKey || window.currentDate || new Date().toISOString().split('T')[0];
        
        try {
            const versions = await window.ScheduleVersionsDB.listVersions(targetDate);
            if (!versions || !Array.isArray(versions)) return { cleaned: 0 };

            const autoBackups = versions.filter(v => 
                v.name && v.name.startsWith(AUTO_BACKUP_PREFIX)
            );

            if (autoBackups.length <= MAX_AUTO_BACKUPS_PER_DATE) {
                console.log(`[AutoBackup] ${autoBackups.length} auto-backups exist, within limit of ${MAX_AUTO_BACKUPS_PER_DATE}`);
                return { cleaned: 0 };
            }

            const toDelete = autoBackups.slice(MAX_AUTO_BACKUPS_PER_DATE);
            let cleaned = 0;

            for (const old of toDelete) {
                try {
                    if (window.ScheduleVersionsDB.deleteVersion) {
                        await window.ScheduleVersionsDB.deleteVersion(old.id);
                        cleaned++;
                        console.log(`[AutoBackup] [DEL] Deleted old backup: ${old.name}`);
                    }
                } catch (e) {
                    console.warn(`[AutoBackup] Failed to delete ${old.name}:`, e);
                }
            }

            console.log(`[AutoBackup] Cleanup complete: removed ${cleaned} old backups`);
            return { cleaned };
        } catch (e) {
            console.error('[AutoBackup] Cleanup error:', e);
            return { cleaned: 0, error: e.message };
        }
    }

    async function listAutoBackups(dateKey = null) {
        if (!window.ScheduleVersionsDB) return [];
        
        const targetDate = dateKey || window.currentDate || new Date().toISOString().split('T')[0];
        
        try {
            const versions = await window.ScheduleVersionsDB.listVersions(targetDate);
            return (versions || []).filter(v => v.name?.startsWith(AUTO_BACKUP_PREFIX));
        } catch (e) {
            console.error('[AutoBackup] Error listing backups:', e);
            return [];
        }
    }

    // =========================================================================
    // APPLY MULTI-BUNK EDIT
    // =========================================================================

    /**
     * *** AUTO MODE: Reshape a bunk's per-bunk slots to guarantee an exact time window ***
     * Splits overlapping slots so the target range has its own dedicated slot(s).
     * Returns the slot indices that now exactly cover [targetStart, targetEnd].
     */
    function ensurePerBunkSlotForRange(bunkName, divName, targetStart, targetEnd) {
        const perBunkSlots = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunkName)];
        if (!perBunkSlots) return [];

        const newSlots = [];
        const resultIndices = [];

        for (let i = 0; i < perBunkSlots.length; i++) {
            const slot = { ...perBunkSlots[i] };
            const overlapStart = Math.max(slot.startMin, targetStart);
            const overlapEnd = Math.min(slot.endMin, targetEnd);
            const hasOverlap = overlapStart < overlapEnd;

            if (!hasOverlap) {
                newSlots.push(slot);
                continue;
            }

            // Part BEFORE target range
            if (slot.startMin < targetStart) {
                newSlots.push({
                    ...slot,
                    endMin: targetStart,
                    label: minutesToTimeLabel(slot.startMin) + ' - ' + minutesToTimeLabel(targetStart),
                    _splitFrom: i
                });
            }

            // The overlapping part (target slot)
            const targetSlot = {
                ...slot,
                startMin: overlapStart,
                endMin: overlapEnd,
                label: minutesToTimeLabel(overlapStart) + ' - ' + minutesToTimeLabel(overlapEnd),
                _reshapedForEdit: true
            };
            resultIndices.push(newSlots.length);
            newSlots.push(targetSlot);

            // Part AFTER target range
            if (slot.endMin > targetEnd) {
                newSlots.push({
                    ...slot,
                    startMin: targetEnd,
                    endMin: slot.endMin,
                    label: minutesToTimeLabel(targetEnd) + ' - ' + minutesToTimeLabel(slot.endMin),
                    _splitFrom: i
                });
            }
        }

        // If the target range extends beyond all existing slots, add a new slot
        if (resultIndices.length === 0) {
            resultIndices.push(newSlots.length);
            newSlots.push({
                startMin: targetStart,
                endMin: targetEnd,
                event: 'GA',
                type: 'slot',
                label: minutesToTimeLabel(targetStart) + ' - ' + minutesToTimeLabel(targetEnd),
                _reshapedForEdit: true,
                _injected: true
            });
            newSlots.sort(function(a, b) { return a.startMin - b.startMin; });
            resultIndices[0] = newSlots.findIndex(function(s) { return s._reshapedForEdit && s.startMin === targetStart; });
        }

        // Rebuild slotIndex
        newSlots.forEach(function(s, idx) { s.slotIndex = idx; });

        // *** CRITICAL: Remap existing scheduleAssignments to new slot layout ***
        var oldAssignments = window.scheduleAssignments?.[bunkName] || [];
        var newAssignments = new Array(newSlots.length);

        // Map old entries by startMin
        var oldSlotEntries = {};
        for (var oi = 0; oi < perBunkSlots.length; oi++) {
            if (oldAssignments[oi]) {
                oldSlotEntries[perBunkSlots[oi].startMin] = oldAssignments[oi];
            }
        }

        for (var ni = 0; ni < newSlots.length; ni++) {
            if (resultIndices.includes(ni)) continue; // Will be overwritten by edit
            var entry = oldSlotEntries[newSlots[ni].startMin];
            if (entry) {
                newAssignments[ni] = entry;
            } else if (newSlots[ni]._splitFrom !== undefined) {
                var origEntry = oldAssignments[newSlots[ni]._splitFrom];
                if (origEntry) {
                    newAssignments[ni] = { ...origEntry, _splitRemainder: true };
                }
            }
        }

        // Apply
        window.divisionTimes[divName]._perBunkSlots[String(bunkName)] = newSlots;
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        window.scheduleAssignments[bunkName] = newAssignments;

        console.log('[ReshapeSlot] ' + bunkName + ': ' + perBunkSlots.length + ' slots -> ' + newSlots.length + ' slots. Target [' + targetStart + '-' + targetEnd + '] at indices [' + resultIndices.join(',') + ']');

        return resultIndices;
    }

    async function applyMultiBunkEdit(result, notifyAfter = false) {
        const { location, slots, divName, activity, bunks, plan } = result;

        await createAutoBackup(activity, divName);

       const divSlots = window.divisionTimes?.[divName] || [];
        const isAutoMode = !!window.divisionTimes?.[divName]?._perBunkSlots;
        const perBunkSlotMap = result.perBunkSlots || null;

        // *** FIX: Capture old activities per-bunk BEFORE overwriting, for rotation count delta ***
        const oldActivitiesByBunk = {};
        for (const bunk of bunks) {
            let capSlots;
            if (isAutoMode && result.timeStartMin != null && result.timeEndMin != null) {
                capSlots = findSlotsForRange(result.timeStartMin, result.timeEndMin, divName, bunk);
            } else if (perBunkSlotMap?.[String(bunk)]) {
                capSlots = perBunkSlotMap[String(bunk)];
            } else {
                capSlots = slots || [];
            }
            oldActivitiesByBunk[bunk] = (capSlots || [])
                .filter(idx => window.scheduleAssignments[bunk]?.[idx] && !window.scheduleAssignments[bunk][idx].continuation)
                .map(idx => window.scheduleAssignments[bunk][idx]._activity || window.scheduleAssignments[bunk][idx].field)
                .filter(Boolean);
        }

        // Slice 4 audit fix — validate each per-bunk placement BEFORE
        // writing any. Earlier, applyMultiBunkEdit overwrote every
        // selected bunk's slot without checking access / disabledSports
        // / activity-in-field / time-rules. One click could plant
        // violations across an entire division. We now collect
        // rejections, surface them in one summary, and only commit
        // the validated subset.
        const _rejectedBunks = [];
        const _bunkSlotsByBunk = {};
        const _bunkGradeByBunk = {};
        for (const bunk of bunks) {
            let bunkSlots;
            console.log('[applyMultiBunkEdit] ' + bunk + ': isAutoMode=' + isAutoMode + ' timeStartMin=' + result.timeStartMin + ' timeEndMin=' + result.timeEndMin);
            if (isAutoMode && result.timeStartMin != null && result.timeEndMin != null) {
                bunkSlots = ensurePerBunkSlotForRange(bunk, divName, result.timeStartMin, result.timeEndMin);
            } else if (isAutoMode && perBunkSlotMap && perBunkSlotMap[String(bunk)]) {
                bunkSlots = perBunkSlotMap[String(bunk)];
            } else {
                bunkSlots = slots;
            }
            if (!bunkSlots || bunkSlots.length === 0) {
                console.warn('[applyMultiBunkEdit] No slots resolved for ' + bunk + ', skipping');
                continue;
            }
            _bunkSlotsByBunk[bunk] = bunkSlots;
            _bunkGradeByBunk[bunk] = divName;
            const _check = commitManualWriteIfLegal(
                bunk, bunkSlots[0], activity, location, divName,
                result.timeStartMin, result.timeEndMin,
                { allowSoftOverride: !!result.allowSoftOverride, slotRange: bunkSlots }
            );
            if (!_check.ok && !_check.soft) {
                _rejectedBunks.push({ bunk: bunk, reason: _check.reason });
            }
        }
        if (_rejectedBunks.length > 0) {
            const _msg = 'Rejected ' + _rejectedBunks.length + ' of ' + bunks.length + ' bunks:\n'
                + _rejectedBunks.map(function (r) { return '• ' + r.bunk + ': ' + r.reason; }).join('\n')
                + '\n\nApply the remaining ' + (bunks.length - _rejectedBunks.length) + ' bunks anyway?';
            if (typeof window.confirm === 'function' && !window.confirm(_msg)) {
                console.warn('[applyMultiBunkEdit] User cancelled after seeing rejections');
                return;
            }
        }
        const _committedBunks = bunks.filter(function (b) {
            return !_rejectedBunks.some(function (r) { return r.bunk === b; })
                && _bunkSlotsByBunk[b];
        });

        // Slice 4 audit R-2 — undo transaction snapshot covering EVERY
        // bunk we're about to touch (primary committed + cascade plan).
        // Counts payload so peiUndo can call applyPostEditCounts in
        // reverse and historicalCounts / rotationHistory stay correct.
        // Snapshot MUST happen here (after rejections are known, before
        // writes start) so the captured state is genuinely pre-edit.
        const _allTouchedBunks = [];
        _committedBunks.forEach(function (b) { if (_allTouchedBunks.indexOf(b) < 0) _allTouchedBunks.push(b); });
        (plan || []).forEach(function (m) { if (m && m.bunk && _allTouchedBunks.indexOf(m.bunk) < 0) _allTouchedBunks.push(m.bunk); });
        const _undoCounts = [];
        _committedBunks.forEach(function (b) {
            _undoCounts.push({
                bunk: b,
                newAct: activity || null,
                oldActs: oldActivitiesByBunk[b] || [],
                slots: _bunkSlotsByBunk[b] || []
            });
        });
        (plan || []).forEach(function (m) {
            if (!m || !m.bunk) return;
            _undoCounts.push({
                bunk: m.bunk,
                newAct: m.to?.activity || null,
                oldActs: (m.from && m.from.activity) ? [m.from.activity] : [],
                slots: [m.slot]
            });
        });
        if (typeof window.peiSnapshotTransaction === 'function' && _allTouchedBunks.length > 0) {
            window.peiSnapshotTransaction(
                _allTouchedBunks,
                'Multi-bunk edit: ' + bunks.length + ' bunks → ' + (location || activity),
                { counts: _undoCounts }
            );
        }

        for (const bunk of _committedBunks) {
            const bunkSlots = _bunkSlotsByBunk[bunk];
            const perBunk = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)];
            const slotCount = perBunk ? perBunk.length : (divSlots.length || 50);
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(slotCount);

            for (let i = 0; i < bunkSlots.length; i++) {
                window.scheduleAssignments[bunk][bunkSlots[i]] = {
                    field: location, sport: null, _activity: activity,
                    _fixed: true, _pinned: true, _multiBunkEdit: true,
                    continuation: i > 0,
                    _startMin: result.timeStartMin,
                    _endMin: result.timeEndMin
                };
            }
        }
        const modifiedBunks = new Set(_committedBunks);
        // Slice 4 audit fix — validate each cascade move at commit time.
        // Earlier the cascade `plan` was trusted blindly; the simulation
        // ran upstream but state could change between sim and commit.
        // We re-validate here so cross-division cascades don't drop a
        // bunk on a field its grade can't access. Also propagate _pinned
        // so the next auto-gen doesn't immediately overwrite the cascade.
        const _planRejected = [];
        for (const move of plan) {
            const moveDivName = getDivisionForBunk(move.bunk);
            const moveDivSlots = window.divisionTimes?.[moveDivName] || [];
            const moveSlotMeta = (window.divisionTimes?.[moveDivName]?._perBunkSlots?.[String(move.bunk)]
                                  || moveDivSlots)[move.slot];
            const _moveCheck = commitManualWriteIfLegal(
                move.bunk, move.slot,
                move.to?.activity, move.to?.field, moveDivName,
                moveSlotMeta?.startMin ?? null, moveSlotMeta?.endMin ?? null,
                { allowSoftOverride: true }  // user already approved at modal time
            );
            if (!_moveCheck.ok && !_moveCheck.soft) {
                _planRejected.push({ bunk: move.bunk, reason: _moveCheck.reason });
                continue;
            }
            modifiedBunks.add(move.bunk);
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = new Array(moveDivSlots.length || 50);
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field, sport: move.to.activity,
                _activity: move.to.activity, _cascadeReassigned: true,
                _postEdit: true, _pinned: true,
                _startMin: moveSlotMeta?.startMin, _endMin: moveSlotMeta?.endMin
            };
        }
        if (_planRejected.length > 0) {
            console.warn('[applyMultiBunkEdit] Cascade rejected ' + _planRejected.length + ' move(s):',
                _planRejected.map(function (r) { return r.bunk + ': ' + r.reason; }).join('; '));
        }

        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'multi_bunk_edit', division: divName, activity, bunks
            });
        }

        markPostEditInProgress();
        if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

        if (plan.length > 0) enableBypassRBACView(plan.map(p => p.bunk));

        if (notifyAfter && plan.length > 0) {
            const myDivisions = new Set(getMyDivisions());
            const otherMoves = plan.filter(p => !myDivisions.has(p.division));
            if (otherMoves.length > 0) {
                await sendSchedulerNotification(otherMoves.map(p => p.bunk), location, activity, 'bypassed');
            }
        }

        // *** Update rotation counts via shared applyPostEditCounts ***
        //   Per-bunk delta: handles slot counting, rotationHistory timestamps,
        //   and a debounced RotationCloud.save (single batched cloud sync).
        try {
            const _ape = window.SchedulerCoreUtils?.applyPostEditCounts;
            if (_ape) {
                // Primary edited bunks: each gets the new activity at its own
                // resolved slot indices in this division.
                for (const bunk of bunks) {
                    let bunkSlots;
                    if (isAutoMode && result.timeStartMin != null && result.timeEndMin != null) {
                        bunkSlots = findSlotsForRange(result.timeStartMin, result.timeEndMin, divName, bunk);
                    } else if (perBunkSlotMap?.[String(bunk)]) {
                        bunkSlots = perBunkSlotMap[String(bunk)];
                    } else {
                        bunkSlots = slots || [];
                    }
                    _ape(bunk, oldActivitiesByBunk[bunk] || [], activity || null, bunkSlots);
                }
                // Cascade-reassigned bunks (the `plan` array): one slot each.
                for (const move of plan) {
                    const _moveOld = (move.from && move.from.activity) ? [move.from.activity] : [];
                    _ape(move.bunk, _moveOld, move.to?.activity || null, [move.slot]);
                }
            }
            console.log('[applyMultiBunkEdit] Rotation counts updated for', bunks.length, 'bunks');

            // Notify the rotation tab so it refreshes after the multi-bunk edit.
            try {
                const _rcDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
                    detail: { bunks: [...modifiedBunks], date: _rcDate, source: 'multi-bunk-edit' }
                }));
            } catch (_e) { /* non-fatal */ }
        } catch (rcErr) { console.error('[applyMultiBunkEdit] Rotation count update failed:', rcErr); }

        if (typeof renderStaggeredView === 'function') renderStaggeredView();
        showIntegratedToast(`${bunks.length} bunks assigned to ${location}` + (plan.length > 0 ? ` - ${plan.length} reassigned` : ''), 'success');

        // *** AUTO MODE: Check for capacity conflicts within the assigned group and offer rebalancing ***
        if (isAutoMode && location && bunks.length > 1) {
            setTimeout(() => autoModeRebalanceCheck(divName, bunks, location, activity, result.timeStartMin, result.timeEndMin), 400);
        }
    }

    // =========================================================================
    // AUTO MODE REBALANCING (post-edit capacity conflict resolution)
    // =========================================================================

    function autoModeRebalanceCheck(divName, editedBunks, location, activity, timeStartMin, timeEndMin) {
        if (!location) return;
        const activityProps = getActivityProperties();
        const locProps = activityProps[location] || {};
        const fieldCap = locProps.sharableWith?.capacity ? parseInt(locProps.sharableWith.capacity) || 1 : (locProps.sharable ? 2 : 1);

        if (editedBunks.length <= fieldCap) return; // No capacity issue

        // Find which bunks actually overlap in time (in auto mode, staggered times might not all collide)
        const overlapGroups = []; // groups of bunks whose time ranges overlap each other
        const bunkRanges = editedBunks.map(bunk => {
            const perBunkSlots = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)] || [];
            const slotIndices = findSlotsForRange(timeStartMin, timeEndMin, divName, bunk);
            const startMins = slotIndices.map(i => perBunkSlots[i]?.startMin).filter(v => v != null);
            const endMins = slotIndices.map(i => perBunkSlots[i]?.endMin).filter(v => v != null);
            return {
                bunk,
                start: startMins.length ? Math.min(...startMins) : timeStartMin,
                end: endMins.length ? Math.max(...endMins) : timeEndMin
            };
        });

        // Find the maximum overlap at any moment
        let maxOverlap = 0;
        bunkRanges.forEach((a, i) => {
            let count = 0;
            bunkRanges.forEach(b => {
                if (a.start < b.end && a.end > b.start) count++;
            });
            if (count > maxOverlap) maxOverlap = count;
        });

        if (maxOverlap <= fieldCap) return; // Staggered enough — no real conflict

        // Real conflict exists — show rebalancing modal
        const conflictCount = maxOverlap - fieldCap;
        const overBunks = bunkRanges.slice(fieldCap); // simplistic: last N are "overflow"
        showAutoModeRebalanceModal(divName, editedBunks, overBunks.map(b => b.bunk), location, activity, fieldCap, timeStartMin, timeEndMin);
    }

    function showAutoModeRebalanceModal(divName, allBunks, overflowBunks, location, activity, capacity, timeStartMin, timeEndMin) {
        const existingModal = document.getElementById('auto-rebalance-modal');
        if (existingModal) existingModal.remove();
        const existingOv = document.getElementById('auto-rebalance-overlay');
        if (existingOv) existingOv.remove();

        const overlay = document.createElement('div');
        overlay.id = 'auto-rebalance-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000;';
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'auto-rebalance-modal';
        modal.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:14px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.25);z-index:10001;width:480px;max-width:95vw;max-height:85vh;overflow-y:auto;';

        const timeLabel = `${minutesToTimeStr(timeStartMin)} – ${minutesToTimeStr(timeEndMin)}`;
        const sharedSimUsage = window.buildFieldUsageBySlot?.([]) || {};
        const sharedClaimed = {};
        const suggestions = overflowBunks.map(bunk => {
            const bunkDiv = getDivisionForBunk(bunk) || divName;
            const bunkSlots = findSlotsForRange(timeStartMin, timeEndMin, bunkDiv, bunk);
            // Mark the original location as "taken" so findAlternativeForBunk avoids it
            bunkSlots.forEach(idx => {
                if (!sharedSimUsage[idx]) sharedSimUsage[idx] = {};
                sharedSimUsage[idx][location] = { count: 999, bunks: {}, divisions: [] };
            });
            const alt = findAlternativeForBunk(bunk, bunkSlots, bunkDiv, sharedSimUsage, [location], sharedClaimed);
            // Track claimed field so next bunk sees cross-division conflict
            if (alt) {
                if (!sharedClaimed[alt.field]) sharedClaimed[alt.field] = [];
                sharedClaimed[alt.field].push({ bunk, div: bunkDiv });
                bunkSlots.forEach(idx => {
                    if (!sharedSimUsage[idx]) sharedSimUsage[idx] = {};
                    if (!sharedSimUsage[idx][alt.field]) sharedSimUsage[idx][alt.field] = { count: 0, bunks: {}, divisions: [] };
                    sharedSimUsage[idx][alt.field].count++;
                    sharedSimUsage[idx][alt.field].bunks[bunk] = alt.activityName;
                    if (!sharedSimUsage[idx][alt.field].divisions.includes(bunkDiv)) {
                        sharedSimUsage[idx][alt.field].divisions.push(bunkDiv);
                    }
                });
            }
            return { bunk, alt };
        });

        modal.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h2 style="margin:0;font-size:1.15rem;color:#b45309;">Field Capacity Conflict</h2>
                <button id="ar-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#9ca3af;">&times;</button>
            </div>
            <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px;margin-bottom:16px;font-size:0.9rem;color:#78350f;">
                <strong>${escapeHtml(location)}</strong> can hold <strong>${capacity}</strong> bunk${capacity!==1?'s':''} at a time, but <strong>${allBunks.length}</strong> bunks are now assigned there at <strong>${timeLabel}</strong>.
                <div style="margin-top:4px;">${overflowBunks.length} bunk${overflowBunks.length!==1?'s need':'needs'} to be reassigned.</div>
            </div>
            <div style="margin-bottom:16px;">
                <div style="font-weight:600;color:#374151;margin-bottom:10px;font-size:0.95rem;">Suggested reassignments:</div>
                ${suggestions.map(({bunk, alt}) => `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#f9fafb;border-radius:8px;margin-bottom:6px;font-size:0.875rem;">
                        <span style="font-weight:600;color:#374151;min-width:80px;">${escapeHtml(bunk)}</span>
                        <span style="color:#6b7280;">→</span>
                        <span style="color:${alt ? '#065f46' : '#991b1b'};font-weight:500;">${alt ? escapeHtml(alt.activityName) + (alt.field ? ' @ ' + escapeHtml(alt.field) : '') : 'No alternative found'}</span>
                    </div>
                `).join('')}
            </div>
            <div style="display:flex;gap:10px;">
                <button id="ar-keep" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;font-size:0.95rem;cursor:pointer;font-weight:500;">Keep As-Is</button>
                <button id="ar-apply" style="flex:1;padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:0.95rem;cursor:pointer;font-weight:500;"${suggestions.some(s=>!s.alt)?' disabled':''}>Auto-Rebalance</button>
            </div>
        `;

        document.body.appendChild(modal);

        function closeRebalance() { modal.remove(); overlay.remove(); }
        document.getElementById('ar-close').onclick = closeRebalance;
        document.getElementById('ar-keep').onclick = closeRebalance;
        overlay.onclick = closeRebalance;

        document.getElementById('ar-apply').onclick = async () => {
            closeRebalance();
            try {
                // Slice 4 audit R-2 — build counts payload BEFORE writes
                // so peiUndo can invert correctly.
                const _arBunks = suggestions.filter(function (s) { return s.alt; }).map(function (s) { return s.bunk; });
                const _arCounts = [];
                suggestions.forEach(function (s) {
                    if (!s || !s.alt) return;
                    const _arSlots = findSlotsForRange(timeStartMin, timeEndMin, divName, s.bunk);
                    if (!_arSlots || _arSlots.length === 0) return;
                    const oldActsBeforeWrite = _arSlots
                        .filter(function (i) { return window.scheduleAssignments[s.bunk]?.[i] && !window.scheduleAssignments[s.bunk][i].continuation; })
                        .map(function (i) { return window.scheduleAssignments[s.bunk][i]._activity; })
                        .filter(Boolean);
                    _arCounts.push({
                        bunk: s.bunk,
                        newAct: s.alt.activityName,
                        oldActs: oldActsBeforeWrite,
                        slots: _arSlots
                    });
                });
                if (typeof window.peiSnapshotTransaction === 'function' && _arBunks.length > 0) {
                    window.peiSnapshotTransaction(_arBunks, 'Auto-rebalance ' + _arBunks.length + ' bunks', { counts: _arCounts });
                }

                // Slice 4 audit fix — mark post-edit-in-progress so realtime
                // sync can't clobber the in-flight rebalance cascade.
                markPostEditInProgress();

                const modifiedBunks = new Set();
                const _rebalDeltas = [];
                const _rebalRejected = [];
                for (const { bunk, alt } of suggestions) {
                    if (!alt) continue;
                    const bunkSlots = findSlotsForRange(timeStartMin, timeEndMin, divName, bunk);
                    if (!bunkSlots || bunkSlots.length === 0) continue;
                    // Slice 4 audit fix — re-validate at commit time. State
                    // could have changed between modal open and apply.
                    const _altCheck = commitManualWriteIfLegal(
                        bunk, bunkSlots[0], alt.activityName, alt.field, divName,
                        timeStartMin, timeEndMin,
                        { allowSoftOverride: true, slotRange: bunkSlots }
                    );
                    if (!_altCheck.ok && !_altCheck.soft) {
                        _rebalRejected.push({ bunk: bunk, reason: _altCheck.reason });
                        continue;
                    }
                    const perBunk = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunk)];
                    const slotCount = perBunk ? perBunk.length : 50;
                    if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(slotCount);
                    const oldAct = bunkSlots.filter(i => window.scheduleAssignments[bunk]?.[i] && !window.scheduleAssignments[bunk][i].continuation)
                        .map(i => window.scheduleAssignments[bunk][i]._activity).filter(Boolean);
                    for (let i = 0; i < bunkSlots.length; i++) {
                        window.scheduleAssignments[bunk][bunkSlots[i]] = {
                            field: alt.field, sport: alt.activityName, _activity: alt.activityName,
                            // _pinned so the next auto-gen doesn't undo the rebalance.
                            _fixed: true, _pinned: true, _rebalanced: true, continuation: i > 0,
                            _startMin: timeStartMin, _endMin: timeEndMin
                        };
                    }
                    modifiedBunks.add(bunk);
                    _rebalDeltas.push({ bunk, oldAct, newAct: alt.activityName, slots: bunkSlots });
                }
                if (_rebalRejected.length > 0) {
                    console.warn('[AutoRebalance] Rejected ' + _rebalRejected.length + ' suggestion(s):',
                        _rebalRejected.map(function (r) { return r.bunk + ': ' + r.reason; }).join('; '));
                }
                if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

                // ★ Update rotation counts (historicalCounts + rotationHistory +
                //   debounced cloud save) via the shared applyPostEditCounts.
                try {
                    const _ape = window.SchedulerCoreUtils?.applyPostEditCounts;
                    if (_ape) {
                        _rebalDeltas.forEach(d => _ape(d.bunk, d.oldAct, d.newAct, d.slots));
                    }
                } catch (_e) { console.warn('[AutoRebalance] post-edit counts failed:', _e); }

                // Notify the rotation tab so it refreshes after the rebalance.
                try {
                    const _rcDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                    document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
                        detail: { bunks: [...modifiedBunks], date: _rcDate, source: 'auto-rebalance' }
                    }));
                } catch (_e) { /* non-fatal */ }

                if (typeof renderStaggeredView === 'function') renderStaggeredView();
                if (typeof updateTable === 'function') updateTable();
                const rebalSummary = suggestions.filter(s => s.alt).map(s => `${s.bunk} → ${s.alt.activityName}${s.alt.field ? ' @ ' + s.alt.field : ''}`).join('\n');
                showIntegratedToast(`Rebalanced:\n${rebalSummary}`, 'success', 5000);
            } catch (e) { console.error('[AutoRebalance] Failed:', e); showIntegratedToast('Rebalance failed — try again', 'error'); }
        };
    }

    // =========================================================================
    // PROPOSAL SYSTEM
    // =========================================================================

    async function createMultiBunkProposal(result) {
        const { location, slots, divName, activity, bunks, plan } = result;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        const userId = window.CampistryDB?.getUserId?.() || null;
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');

        const myDivisions = new Set(getMyDivisions());
        const affectedDivisions = [...new Set(plan.filter(p => !myDivisions.has(p.division)).map(p => p.division))];

        const proposal = {
            id: `proposal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'multi_bunk_edit',
            status: 'pending',
            created_at: new Date().toISOString(),
            created_by: userId,
            camp_id: campId,
            date_key: dateKey,
            claim: { field: location, slots, division: divName, activity, bunks },
            reassignments: plan,
            affected_divisions: affectedDivisions,
            approvals: {},
            applied: false
        };

        affectedDivisions.forEach(div => proposal.approvals[div] = 'pending');

        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (supabase && campId) {
            try {
                await supabase.from('schedule_proposals').insert(proposal);
                await notifySchedulersOfProposal(proposal);
            } catch (e) { console.error('[CreateProposal] Error:', e); }
        }

        showIntegratedToast(`Proposal sent to ${affectedDivisions.length} scheduler(s)`, 'info');
    }

    async function notifySchedulersOfProposal(proposal) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;

        try {
            const { data: schedulers } = await supabase
                .from('camp_users')
                .select('user_id, divisions')
                .eq('camp_id', proposal.camp_id)
                .neq('user_id', proposal.created_by);

            if (!schedulers) return;

            const notifyUsers = schedulers.filter(s =>
                (s.assigned_divisions || s.divisions || []).some(d => proposal.affected_divisions.includes(d))
            ).map(s => s.user_id);

            if (notifyUsers.length === 0) return;

            const notifications = notifyUsers.map(uid => ({
                camp_id: proposal.camp_id, user_id: uid,
                type: 'schedule_proposal',
                title: '📋 Schedule Change Proposal',
                message: `Request to claim ${proposal.claim.field} for ${proposal.claim.division}`,
                metadata: { proposal_id: proposal.id },
                read: false,
                created_at: new Date().toISOString()
            }));

            await supabase.from('notifications').insert(notifications);
        } catch (e) { console.error('[NotifyProposal] Error:', e); }
    }

    async function loadProposal(proposalId) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (supabase) {
            const { data } = await supabase
                .from('schedule_proposals')
                .select('*')
                .eq('id', proposalId)
                .single();
            return data;
        }
        return _pendingProposals.find(p => p.id === proposalId);
    }

    async function loadMyPendingProposals() {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        const myDivisions = getMyDivisions();
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');

        if (supabase && campId) {
            try {
                const { data } = await supabase
                    .from('schedule_proposals')
                    .select('*')
                    .eq('camp_id', campId)
                    .eq('status', 'pending');
                
                return (data || []).filter(p => 
                    p.affected_divisions?.some(d => myDivisions.includes(d))
                );
            } catch (e) {
                console.error('[LoadProposals] Error:', e);
                return [];
            }
        }
        return _pendingProposals.filter(p => 
            p.status === 'pending' && 
            p.affected_divisions?.some(d => myDivisions.includes(d))
        );
    }

    function openProposalReviewModal(proposalId) {
        loadProposal(proposalId).then(proposal => {
            if (!proposal) { alert('Proposal not found'); return; }
            showProposalReviewUI(proposal);
        });
    }

    function showProposalReviewUI(proposal) {
        closeIntegratedEditModal();

        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9998;`;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = PROPOSAL_MODAL_ID;
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999; min-width: 500px; max-width: 600px; max-height: 80vh; overflow-y: auto;`;

        const myDivisions = new Set(getMyDivisions());
        const myMoves = (proposal.reassignments || []).filter(r => myDivisions.has(r.division));
        const claim = proposal.claim || {};

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af;">📋 Proposal Review</h2>
                <button onclick="closeIntegratedEditModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer;">&times;</button>
            </div>
            <div style="background: #eff6ff; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <div style="font-weight: 500; color: #1e40af;">Claim Request</div>
                <div style="color: #3b82f6; margin-top: 4px;">
                    <strong>${escapeHtml(claim.division || 'Unknown')}</strong> wants 
                    <strong>${escapeHtml(claim.field || 'Unknown')}</strong> 
                    for <strong>${escapeHtml(claim.activity || 'Unknown')}</strong>
                </div>
                <div style="color: #6b7280; font-size: 0.9rem; margin-top: 4px;">Date: ${proposal.date_key || 'Unknown'}</div>
            </div>
            <div style="margin-bottom: 16px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 8px;">Changes to your bunks:</div>
                <div style="background: ${myMoves.length > 0 ? '#fef3c7' : '#f0fdf4'}; border-radius: 8px; padding: 12px;">
                    ${myMoves.length === 0 ? 
                        '<div style="color: #166534;">No direct changes to your bunks</div>' :
                        `<ul style="margin: 0; padding-left: 20px; color: #92400e;">
                            ${myMoves.map(m => `<li><strong>${escapeHtml(m.bunk)}</strong>: ${escapeHtml(m.from?.activity || '?')} → ${escapeHtml(m.to?.activity || '?')}</li>`).join('')}
                        </ul>`
                    }
                </div>
            </div>
            <div style="display: flex; gap: 12px;">
                <button onclick="respondToProposal('${proposal.id}', 'approved')" 
                    style="flex: 1; padding: 12px; background: #10b981; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;">
                    Approve
                </button>
                <button onclick="respondToProposal('${proposal.id}', 'rejected')" 
                    style="flex: 1; padding: 12px; background: #ef4444; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;">
                    Reject
                </button>
            </div>
        `;

        document.body.appendChild(modal);
    }

    async function respondToProposal(proposalId, response) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        const myDivisions = getMyDivisions();

        if (!supabase) {
            alert('Database not available');
            return;
        }

        try {
            const { data: proposal, error } = await supabase
                .from('schedule_proposals')
                .select('*')
                .eq('id', proposalId)
                .single();

            if (error || !proposal) {
                alert('Proposal not found');
                return;
            }

            const approvals = proposal.approvals || {};
            myDivisions.forEach(div => {
                if (proposal.affected_divisions?.includes(div)) {
                    approvals[div] = response;
                }
            });

            const allApproved = (proposal.affected_divisions || []).every(d => approvals[d] === 'approved');
            const anyRejected = (proposal.affected_divisions || []).some(d => approvals[d] === 'rejected');

            let newStatus = 'pending';
            if (allApproved) newStatus = 'approved';
            if (anyRejected) newStatus = 'rejected';

            await supabase
                .from('schedule_proposals')
                .update({ approvals, status: newStatus })
                .eq('id', proposalId);

            if (allApproved && !proposal.applied) {
                await applyApprovedProposal(proposal);
            }

            await notifyProposerOfResponse(proposal, response, myDivisions);

            closeIntegratedEditModal();
            showIntegratedToast(
                response === 'approved' ? 'Proposal approved' : 'Proposal rejected',
                response === 'approved' ? 'success' : 'info'
            );

        } catch (e) {
            console.error('[RespondProposal] Error:', e);
            alert('Error responding to proposal');
        }
    }

    async function applyApprovedProposal(proposal) {
        console.log('[ApplyProposal] * All approvals received, applying...');

        const claim = proposal.claim || {};
        
        await createAutoBackup(claim.activity || 'Approved Proposal', claim.division || 'Unknown');

        const { field: location, slots, division: divName, activity, bunks } = claim;
        const plan = proposal.reassignments || [];

        const divSlots = window.divisionTimes?.[divName] || [];

        // Capture old activities before any overwrites (needed for historicalCounts delta)
        const primaryOldActivities = new Map();
        for (const bunk of (bunks || [])) {
            const existing = window.scheduleAssignments[bunk] || [];
            primaryOldActivities.set(bunk, (slots || []).filter(s => existing[s] && !existing[s].continuation).map(s => existing[s]._activity).filter(Boolean));
        }
        const planOldActivities = new Map();
        for (const move of plan) {
            if (!planOldActivities.has(move.bunk)) planOldActivities.set(move.bunk, []);
            const oldAct = (window.scheduleAssignments[move.bunk] || [])[move.slot]?._activity;
            if (oldAct) planOldActivities.get(move.bunk).push(oldAct);
        }

        // Slice 4 audit R-2 — undo transaction snapshot WITH counts
        // payload covering all primary + cascade bunks affected by this
        // proposal apply. Use primaryOldActivities + planOldActivities
        // already captured above as the inverse-counts source.
        const _propTouchedBunks = [];
        (bunks || []).forEach(function (b) { if (_propTouchedBunks.indexOf(b) < 0) _propTouchedBunks.push(b); });
        (plan || []).forEach(function (m) { if (m && m.bunk && _propTouchedBunks.indexOf(m.bunk) < 0) _propTouchedBunks.push(m.bunk); });
        const _propCounts = [];
        (bunks || []).forEach(function (b) {
            _propCounts.push({
                bunk: b,
                newAct: activity || null,
                oldActs: primaryOldActivities.get(b) || [],
                slots: slots || []
            });
        });
        (plan || []).forEach(function (m) {
            if (!m || !m.bunk) return;
            _propCounts.push({
                bunk: m.bunk,
                newAct: m.to?.activity || null,
                oldActs: planOldActivities.get(m.bunk) || [],
                slots: [m.slot]
            });
        });
        if (typeof window.peiSnapshotTransaction === 'function' && _propTouchedBunks.length > 0) {
            window.peiSnapshotTransaction(_propTouchedBunks, 'Apply proposal: ' + (claim.activity || 'edit'), { counts: _propCounts });
        }

        // Slice 4 audit fix — validate each placement at commit. Approved
        // proposals come from another scheduler's approval flow but the
        // approver's state may differ from local at apply time.
        const _propRejected = [];
        const _firstSlotMeta = (slots && slots.length > 0)
            ? (window.divisionTimes?.[divName]?._perBunkSlots?.[String((bunks || [])[0])]?.[slots[0]]
               || divSlots[slots[0]])
            : null;
        const _propStartMin = _firstSlotMeta?.startMin ?? null;
        const _propEndMin = (slots && slots.length > 0)
            ? ((window.divisionTimes?.[divName]?._perBunkSlots?.[String((bunks || [])[0])]?.[slots[slots.length - 1]]
                || divSlots[slots[slots.length - 1]])?.endMin ?? null)
            : null;

        const _committedPrimary = [];
        for (const bunk of (bunks || [])) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
            if (slots && slots.length > 0) {
                const _check = commitManualWriteIfLegal(
                    bunk, slots[0], activity, location, divName,
                    _propStartMin, _propEndMin,
                    { allowSoftOverride: true, slotRange: slots }
                );
                if (!_check.ok && !_check.soft) {
                    _propRejected.push({ bunk: bunk, reason: _check.reason });
                    continue;
                }
            }
            for (let i = 0; i < (slots || []).length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location, sport: null, _activity: activity,
                    _fixed: true, _pinned: true, _fromProposal: true, continuation: i > 0,
                    _startMin: _propStartMin, _endMin: _propEndMin
                };
            }
            _committedPrimary.push(bunk);
        }

        const modifiedBunks = new Set(_committedPrimary);
        for (const move of plan) {
            const moveDivName = getDivisionForBunk(move.bunk);
            const moveDivSlots = window.divisionTimes?.[moveDivName] || [];
            const moveSlotMeta = (window.divisionTimes?.[moveDivName]?._perBunkSlots?.[String(move.bunk)]
                                  || moveDivSlots)[move.slot];
            const _moveCheck = commitManualWriteIfLegal(
                move.bunk, move.slot,
                move.to?.activity, move.to?.field, moveDivName,
                moveSlotMeta?.startMin ?? null, moveSlotMeta?.endMin ?? null,
                { allowSoftOverride: true }
            );
            if (!_moveCheck.ok && !_moveCheck.soft) {
                _propRejected.push({ bunk: move.bunk, reason: _moveCheck.reason });
                continue;
            }
            modifiedBunks.add(move.bunk);
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = new Array(moveDivSlots.length || 50);
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field, sport: move.to.activity,
                _activity: move.to.activity, _fromProposal: true,
                _postEdit: true, _pinned: true,
                _startMin: moveSlotMeta?.startMin, _endMin: moveSlotMeta?.endMin
            };
        }
        if (_propRejected.length > 0) {
            console.warn('[ApplyProposal] Rejected ' + _propRejected.length + ' placement(s):',
                _propRejected.map(function (r) { return r.bunk + ': ' + r.reason; }).join('; '));
            if (typeof window.showNotification === 'function') {
                window.showNotification('Proposal applied with ' + _propRejected.length + ' rejection(s)', 'warning');
            }
        }

        if (window.GlobalFieldLocks && location && slots) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'approved_proposal', division: divName, activity, bunks
            });
        }

        markPostEditInProgress();
        if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

        if (window.SchedulerCoreUtils?.applyPostEditCounts) {
            for (const bunk of (bunks || [])) {
                window.SchedulerCoreUtils.applyPostEditCounts(bunk, primaryOldActivities.get(bunk) || [], activity, slots);
            }
            for (const move of plan) {
                window.SchedulerCoreUtils.applyPostEditCounts(move.bunk, planOldActivities.get(move.bunk) || [], move.to.activity, [move.slot]);
            }
        }

        // Notify the rotation tab so it refreshes after a proposal is applied.
        try {
            const _rcDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
                detail: { bunks: [...modifiedBunks], date: _rcDate, source: 'proposal-applied' }
            }));
        } catch (_e) { /* non-fatal */ }

        if (plan.length > 0) enableBypassRBACView(plan.map(p => p.bunk));

        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (supabase) {
            await supabase
                .from('schedule_proposals')
                .update({ applied: true, applied_at: new Date().toISOString() })
                .eq('id', proposal.id);
        }

        if (typeof renderStaggeredView === 'function') renderStaggeredView();
        showIntegratedToast(`Proposal applied: ${(bunks || []).length} bunks → ${location}`, 'success');
    }

    async function notifyProposerOfResponse(proposal, response, respondingDivisions) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase || !proposal.created_by) return;

        try {
            await supabase.from('notifications').insert({
                camp_id: proposal.camp_id,
                user_id: proposal.created_by,
                type: 'proposal_response',
                title: response === 'approved' ? 'Proposal Approved' : 'Proposal Rejected',
                message: `${respondingDivisions.join(', ')} ${response} your claim for ${proposal.claim?.field || 'field'}`,
                metadata: { proposal_id: proposal.id, response },
                read: false,
                created_at: new Date().toISOString()
            });
        } catch (e) { console.error('[NotifyProposer] Error:', e); }
    }

    function closeIntegratedEditModal() {
        document.getElementById(INTEGRATED_EDIT_MODAL_ID)?.remove();
        document.getElementById(INTEGRATED_EDIT_OVERLAY_ID)?.remove();
        document.getElementById(CLAIM_MODAL_ID)?.remove();
        document.getElementById(CLAIM_OVERLAY_ID)?.remove();
        document.getElementById(PROPOSAL_MODAL_ID)?.remove();
        _currentEditContext = null;
    }

    function showIntegratedToast(message, type = 'info', duration = 4000) {
        if (window.showToast) { window.showToast(message, type); return; }
        const toast = document.createElement('div');
        toast.style.cssText = `position: fixed; bottom: 20px; right: 20px; background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'}; color: white; padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); z-index: 10000; white-space: pre-line; max-width: 400px;`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    // =========================================================================
    // VERSION MANAGEMENT
    // =========================================================================
    
    const VersionManager = {
        async saveVersion(name, { silent = false } = {}) {
            const dateKey = getDateKey();
            if (!dateKey) { if (!silent) alert('Please select a date first.'); return { success: false }; }
            if (!name) { name = prompt('Enter a name for this version:'); if (!name) return { success: false }; }
            const dailyData = loadDailyData(); 
            const dateData = dailyData[dateKey] || {};
            const payload = {
                scheduleAssignments: window.scheduleAssignments || dateData.scheduleAssignments || {},
                scheduleSegments: window.scheduleSegments || dateData.scheduleSegments || {},
                leagueAssignments: window.leagueAssignments || dateData.leagueAssignments || {},
                divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes || {}
            };
            if (Object.keys(payload.scheduleAssignments).length === 0) { if (!silent) alert('No schedule data to save.'); return { success: false }; }
            if (!window.ScheduleVersionsDB) { if (!silent) alert('Version database not available.'); return { success: false }; }
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                const existing = versions.find(v => v.name.toLowerCase() === name.toLowerCase());
                if (existing) {
                    if (!silent && !confirm(`Version "${existing.name}" already exists. Overwrite?`)) return { success: false };
                    if (window.ScheduleVersionsDB.updateVersion) {
                        const result = await window.ScheduleVersionsDB.updateVersion(existing.id, payload);
                        if (result.success) { if (!silent) alert('Version updated!'); return { success: true }; }
                        else { if (!silent) alert('Error: ' + result.error); return { success: false }; }
                    }
                }
                const result = await window.ScheduleVersionsDB.createVersion(dateKey, name, payload);
                if (result.success) { if (!silent) alert('Version saved!'); return { success: true }; }
                else { if (!silent) alert('Error: ' + result.error); return { success: false }; }
            } catch (err) { if (!silent) alert('Error: ' + err.message); return { success: false }; }
        },
        async loadVersion() {
            const dateKey = getDateKey();
            if (!dateKey || !window.ScheduleVersionsDB) { alert('Not available.'); return; }
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                if (!versions?.length) { alert('No saved versions.'); return; }
                let msg = 'Select a version:\n\n'; 
                versions.forEach((v, i) => { msg += `${i + 1}. ${v.name} (${new Date(v.created_at).toLocaleTimeString()})\n`; });
                const choice = prompt(msg); 
                if (!choice) return;
                const index = parseInt(choice) - 1; 
                if (isNaN(index) || !versions[index]) { alert('Invalid selection'); return; }
                const selected = versions[index]; 
                if (!confirm(`Load "${selected.name}"?`)) return;
                let data = selected.schedule_data; 
                if (typeof data === 'string') try { data = JSON.parse(data); } catch(e) {}
                window.scheduleAssignments = data.scheduleAssignments || data;
                window._scheduleAssignmentsDate = dateKey; // owner stamp coherent with loaded version (cross-date guard)
                // Phase 4: restore segments from the version, or rebuild from assignments.
                if (data.scheduleSegments && Object.keys(data.scheduleSegments).length > 0) {
                    window.scheduleSegments = data.scheduleSegments;
                } else {
                    try { window.AutoSegmentModel?.rebuildFromAssignments?.(); } catch (_e) {}
                }
                if (data.leagueAssignments) window.leagueAssignments = data.leagueAssignments;
                if (data.divisionTimes) window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(data.divisionTimes) || data.divisionTimes;
                saveSchedule();
                updateTable();
                alert('Version loaded!');
            } catch (err) { alert('Error: ' + err.message); }
        },
        async mergeVersions() {
            const dateKey = getDateKey();
            if (!dateKey || !window.ScheduleVersionsDB) { alert('Not available.'); return { success: false }; }
            if (!confirm(`Merge ALL versions for ${dateKey}?`)) return { success: false };
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                if (!versions?.length) { alert('No versions to merge.'); return { success: false }; }
                const mergedAssignments = {};
                const mergedSegments = {};
                const bunksTouched = new Set();
                let latestLeagueData = null;
                let latestDivisionTimes = null;
                versions.forEach(ver => {
                    let scheduleData = ver.schedule_data || ver.data || ver.payload;
                    if (typeof scheduleData === 'string') try { scheduleData = JSON.parse(scheduleData); } catch(e) {}
                    if (!scheduleData) return;
                    const assignments = scheduleData.scheduleAssignments || scheduleData;
                    if (assignments && typeof assignments === 'object') {
                        Object.entries(assignments).forEach(([bunkId, slots]) => {
                            mergedAssignments[bunkId] = slots;
                            bunksTouched.add(bunkId);
                        });
                    }
                    // Phase 4: merge scheduleSegments per-bunk (same ownership pattern)
                    if (scheduleData.scheduleSegments && typeof scheduleData.scheduleSegments === 'object') {
                        Object.entries(scheduleData.scheduleSegments).forEach(([bunkId, row]) => {
                            mergedSegments[bunkId] = row;
                        });
                    }
                    if (scheduleData.leagueAssignments) latestLeagueData = scheduleData.leagueAssignments;
                    if (scheduleData.divisionTimes) latestDivisionTimes = scheduleData.divisionTimes;
                });
                window.scheduleAssignments = mergedAssignments;
                window._scheduleAssignmentsDate = dateKey; // owner stamp coherent with merged versions (cross-date guard)
                if (Object.keys(mergedSegments).length > 0) {
                    window.scheduleSegments = mergedSegments;
                } else {
                    try { window.AutoSegmentModel?.rebuildFromAssignments?.(); } catch (_e) {}
                }
                if (latestLeagueData) window.leagueAssignments = latestLeagueData;
                if (latestDivisionTimes) window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(latestDivisionTimes) || latestDivisionTimes;
                saveSchedule(); 
                updateTable();
                alert(`Merged ${versions.length} versions (${bunksTouched.size} bunks).`);
                return { success: true, count: versions.length, bunks: bunksTouched.size };
            } catch (err) { alert('Error: ' + err.message); return { success: false }; }
        }
    };

    // =========================================================================
    // SCHEDULER HOOKS FOR PINNED ACTIVITIES
    // =========================================================================

    function hookSchedulerGeneration() {
        if (typeof window.runScheduler === 'function' && !window.runScheduler._pinnedHooked) {
            const originalRunScheduler = window.runScheduler;
            window.runScheduler = async function(...args) {
                capturePinnedActivities(args[0]?.allowedDivisions || null);
                const result = await originalRunScheduler.apply(this, args);
                if (Object.keys(_pinnedSnapshot).length > 0) { 
                    restorePinnedActivities(); 
                    saveSchedule(); 
                }
                return result;
            };
            window.runScheduler._pinnedHooked = true;
        }
        if (typeof window.generateSchedule === 'function' && !window.generateSchedule._pinnedHooked) {
            const originalGenerateSchedule = window.generateSchedule;
            window.generateSchedule = async function(...args) {
                capturePinnedActivities(args[0]?.allowedDivisions || window.selectedDivisionsForGeneration || null);
                const result = await originalGenerateSchedule.apply(this, args);
                if (Object.keys(_pinnedSnapshot).length > 0) { 
                    restorePinnedActivities(); 
                    saveSchedule(); 
                    updateTable(); 
                }
                return result;
            };
            window.generateSchedule._pinnedHooked = true;
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initScheduleSystem() {
        if (_initialized) return;
        loadScheduleForDate(getDateKey());
        if (!document.getElementById('unified-schedule-styles')) {
            const style = document.createElement('style'); 
            style.id = 'unified-schedule-styles';
            style.textContent = `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } #${MODAL_ID} input:focus, #${MODAL_ID} select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); } #${MODAL_ID} button:hover { opacity: 0.9; }`;
            document.head.appendChild(style);
        }
        hookSchedulerGeneration();
        setTimeout(hookSchedulerGeneration, 1000);
        setTimeout(hookSchedulerGeneration, 3000);
        _initialized = true;
    }

    function reconcileOrRenderSaved() { 
        loadScheduleForDate(getDateKey()); 
        updateTable(); 
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    window.addEventListener('campistry-cloud-hydrated', () => { 
        if (window._postEditInProgress) return; 
        _cloudHydrated = true; 
        setTimeout(() => { 
            if (!window._postEditInProgress) { 
                loadScheduleForDate(getDateKey()); 
                updateTable(); 
            } 
        }, 100); 
    });
    
    window.addEventListener('campistry-cloud-schedule-loaded', () => { 
        if (window._postEditInProgress) return; 
        _cloudHydrated = true; 
        setTimeout(() => { 
            if (!window._postEditInProgress) updateTable(); 
        }, 100); 
    });
    
    window.addEventListener('campistry-daily-data-updated', () => { 
        if (window._postEditInProgress) return; 
        loadScheduleForDate(getDateKey()); 
        updateTable(); 
    });
    
    window.addEventListener('campistry-date-changed', (e) => { 
        if (window._postEditInProgress) return; 
        if (window.UnifiedCloudSchedule?.load) {
            window.UnifiedCloudSchedule.load().then(result => { 
                if (!window._postEditInProgress) { 
                    if (!result.merged) loadScheduleForDate(e.detail?.dateKey || getDateKey()); 
                    updateTable(); 
                } 
            }); 
        } else { 
            loadScheduleForDate(e.detail?.dateKey || getDateKey()); 
            updateTable(); 
        } 
    });
    
    window.addEventListener('campistry-generation-complete', () => { 
        if (window.UnifiedCloudSchedule?.save) setTimeout(() => window.UnifiedCloudSchedule.save(), 500); 
        updateTable(); 
    });
    
    window.addEventListener('campistry-generation-starting', (e) => { 
        capturePinnedActivities(e.detail?.allowedDivisions || null); 
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideVersionToolbar);
    else hideVersionToolbar();
    setTimeout(hideVersionToolbar, 500); 
    setTimeout(hideVersionToolbar, 1500); 
    setTimeout(hideVersionToolbar, 3000);

    // =========================================================================
    // EXPORTS
    // =========================================================================

    // Core UI functions
    window.updateTable = updateTable;
    window.renderStaggeredView = renderStaggeredView;
    window.initScheduleSystem = initScheduleSystem;
    window.editCell = editCell;
    window.enhancedEditCell = enhancedEditCell;
   window.proceedWithScope = proceedWithScope;
window.closeIntegratedEditModal = closeIntegratedEditModal;
window.previewMultiBunkEdit = previewMultiBunkEdit;
window.submitMultiBunkEdit = submitMultiBunkEdit;

    // Save/Load functions
    window.saveSchedule = saveSchedule;
    window.loadScheduleForDate = loadScheduleForDate;
    window.reconcileOrRenderSaved = reconcileOrRenderSaved;

    // Entry/Bunk functions
    window.getEntry = getEntry;
    window.formatEntry = formatEntry;

    // Conflict detection (time-based, division-aware)
    window.checkLocationConflict = checkLocationConflict;
    window.checkCrossDivisionConflict = checkCrossDivisionConflict;
    window.getAllLocations = getAllLocations;

    // Smart regeneration
    window.smartRegenerateConflicts = smartRegenerateConflicts;
    window.smartReassignBunkActivity = smartReassignBunkActivity;
    window.findBestActivityForBunk = findBestActivityForBunk;
    window.findBestActivityForBunkDivisionAware = findBestActivityForBunkDivisionAware;
window.checkFieldAvailableByTime = checkFieldAvailableByTime;
window.applyPickToBunkDivisionAware = applyPickToBunkDivisionAware;
    window.buildCandidateOptions = buildCandidateOptions;
    window.calculateRotationPenalty = calculateRotationPenalty;
    window.applyPickToBunk = applyPickToBunk;
window.resolveConflictsAndApply = resolveConflictsAndApply;

    // RBAC bypass
    window.enableBypassRBACView = enableBypassRBACView;
    window.disableBypassRBACView = disableBypassRBACView;
    window.shouldShowDivision = shouldShowDivision;
    window.shouldHighlightBunk = shouldHighlightBunk;
    window.bypassSaveAllBunks = bypassSaveAllBunks;
    window.getCellBypassStatus = getCellBypassStatus;
window.markCellsAsBypassed = markCellsAsBypassed;
window.acknowledgeBypassChanges = acknowledgeBypassChanges;
window.clearMyBypassHighlights = clearMyBypassHighlights;

    // Pinned activities
    window.getPinnedActivities = getPinnedActivities;
    window.unpinActivity = unpinActivity;
    window.unpinAllActivities = unpinAllActivities;
    window.preservePinnedForRegeneration = (allowedDivisions) => { 
        capturePinnedActivities(allowedDivisions); 
        registerPinnedFieldLocks(); 
    };
    window.restorePinnedAfterRegeneration = () => { 
        const count = restorePinnedActivities(); 
        saveSchedule(); 
        updateTable(); 
        return count; 
    };

    // Legacy compatibility
    window.ScheduleVersionManager = VersionManager;
    window.ScheduleVersionMerger = { 
        mergeAndPush: async (dateKey) => { 
            window.currentScheduleDate = dateKey; 
            return await VersionManager.mergeVersions(); 
        } 
    };

    // System objects
    window.SmartRegenSystem = { 
        smartRegenerateConflicts, 
        smartReassignBunkActivity, 
        findBestActivityForBunk, 
        buildFieldUsageBySlot: window.buildFieldUsageBySlot,
        buildCandidateOptions, 
        calculateRotationPenalty, 
        isFieldAvailable,
        getActivityProperties,
        applyPickToBunk, 
        ROTATION_CONFIG 
    };
    
    window.PinnedActivitySystem = { 
        capture: capturePinnedActivities, 
        registerLocks: registerPinnedFieldLocks, 
        registerUsage: registerPinnedFieldUsage, 
        restore: restorePinnedActivities, 
        getAll: getPinnedActivities, 
        unpin: unpinActivity, 
        unpinAll: unpinAllActivities, 
        debug: () => ({ snapshot: _pinnedSnapshot, locks: _pinnedFieldLocks }) 
    };

    window.UnifiedScheduleSystem = {
        version: '4.2.0',
        
        // Core functions
        loadScheduleForDate, 
        renderStaggeredView,
        renderDivisionTimeline,        findFirstSlotForTime,
        findSlotsForRange,
        getLeagueMatchups, 
        getEntryForBlock,
        getDivisionForBunk,
        getSlotTimeRange,
        buildDivisionTimesFromSkeleton, 
        isSplitTileBlock, 
        expandBlocksForSplitTiles,
        
        // Conflict detection
        checkLocationConflict, 
        checkCrossDivisionConflict, 
        buildFieldUsageBySlot: window.buildFieldUsageBySlot,
        TimeBasedFieldUsage: window.TimeBasedFieldUsage,
        
        // Sub-systems
        VersionManager,
        SmartRegenSystem: window.SmartRegenSystem, 
        PinnedActivitySystem: window.PinnedActivitySystem, 
        ROTATION_CONFIG,
        
        // Debug utilities
        DEBUG_ON: () => { DEBUG = true; console.log('[UnifiedSchedule] Debug enabled'); },
        DEBUG_OFF: () => { DEBUG = false; console.log('[UnifiedSchedule] Debug disabled'); },
        
        diagnose: () => { 
            console.log('=== UNIFIED SCHEDULE SYSTEM v4.1.0 DIAGNOSTIC ==='); 
            console.log(`Date: ${getDateKey()}`); 
            console.log(`window.scheduleAssignments: ${Object.keys(window.scheduleAssignments || {}).length} bunks`); 
            console.log(`window.divisionTimes: ${Object.keys(window.divisionTimes || {}).length} divisions`);
            Object.entries(window.divisionTimes || {}).forEach(([div, slots]) => {
                console.log(`  ${div}: ${slots.length} slots`);
            });
            console.log(`TimeBasedFieldUsage: ${window.TimeBasedFieldUsage ? '[OK]' : '[X]'}`);
            console.log(`Pinned activities: ${getPinnedActivities().length}`); 
           console.log(`Bypass cells tracked: ${_myBypassedCells?.size || 0}`);
        },
        
        getState: () => ({ 
    dateKey: getDateKey(), 
    assignments: Object.keys(window.scheduleAssignments || {}).length, 
    leagues: Object.keys(window.leagueAssignments || {}).length, 
    divisionTimes: Object.keys(window.divisionTimes || {}).length,
    cloudHydrated: _cloudHydrated, 
    initialized: _initialized, 
    pinnedCount: getPinnedActivities().length, 
    postEditInProgress: !!window._postEditInProgress, 
    bypassCellsTracked: _myBypassedCells?.size || 0
})
    };

    // Initialize on DOM ready
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initScheduleSystem);
    else setTimeout(initScheduleSystem, 100);

    // =========================================================================
    // PRINT CENTER: ROWSPAN MERGING FOR CONTINUATION CELLS
    // =========================================================================
    // When the print center renders per-bunk schedules, activities that
    // span multiple sub-slots show as repeated or empty cells. This
    // post-processes the print preview to merge those cells with rowspan.
    // =========================================================================

    function patchPrintCenter() {
        const originalLiveRefresh = window.pcLiveRefresh;
        if (!originalLiveRefresh) return;

        window.pcLiveRefresh = function() {
            originalLiveRefresh.call(this);
            setTimeout(() => {
                const preview = document.getElementById('pc-preview-content');
                if (!preview) return;
                preview.querySelectorAll('table').forEach(postProcessPrintTable);
            }, 100);
        };
        console.log('[UnifiedSchedule] Print center rowspan patch applied');
    }

    function postProcessPrintTable(table) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (rows.length === 0) return;
        const headerRow = table.querySelector('thead tr:last-child');
        if (!headerRow) return;
        const headers = Array.from(headerRow.querySelectorAll('th'));

        for (let colIdx = 1; colIdx < headers.length; colIdx++) {
            let mergeStart = -1, mergeContent = '', mergeCount = 0;

            for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                const cells = Array.from(rows[rowIdx].querySelectorAll('td'));
                if (cells.length <= colIdx) continue;
                const text = cells[colIdx].textContent.trim();

                if (mergeStart >= 0 && (text === '' || text === '—' || text === mergeContent)) {
                    mergeCount++;
                } else {
                    if (mergeStart >= 0 && mergeCount > 1) {
                        applyPrintRowMerge(rows, mergeStart, mergeCount, colIdx);
                    }
                    mergeStart = rowIdx;
                    mergeContent = text;
                    mergeCount = 1;
                }
            }
            if (mergeStart >= 0 && mergeCount > 1) {
                applyPrintRowMerge(rows, mergeStart, mergeCount, colIdx);
            }
        }
    }

    function applyPrintRowMerge(rows, startRow, count, colIdx) {
        if (startRow < 0 || startRow >= rows.length) return;
        const cells = Array.from(rows[startRow].querySelectorAll('td'));
        if (cells.length <= colIdx) return;
        cells[colIdx].rowSpan = count;
        cells[colIdx].style.verticalAlign = 'middle';
        for (let i = 1; i < count; i++) {
            const nextRow = rows[startRow + i];
            if (!nextRow) continue;
            const nextCells = Array.from(nextRow.querySelectorAll('td'));
            if (nextCells.length > colIdx) nextCells[colIdx].style.display = 'none';
        }
    }

    // Initialize print center patch when ready
    if (window.pcLiveRefresh) {
        patchPrintCenter();
    } else {
        const pcObserver = new MutationObserver(() => {
            if (window.pcLiveRefresh) { patchPrintCenter(); pcObserver.disconnect(); }
        });
        pcObserver.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => pcObserver.disconnect(), 30000);
    }

    console.log('[Schedule] Unified Schedule System v4.1.0 loaded successfully');
    console.log('   *** FULL DIVISIONTIMES INTEGRATION ***');
    console.log('   [OK] Division-aware time slot management');
    console.log('   [OK] TimeBasedFieldUsage for cross-division conflicts');
    console.log('   [OK] Removed unifiedTimes dependency');
    console.log('   [OK] Data persistence uses divisionTimes');
    console.log('   [OK] Print center rowspan merging');

})();
