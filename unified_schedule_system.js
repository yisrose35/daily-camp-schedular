// =============================================================================
// unified_schedule_system.js v4.0.3 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
// =============================================================================
//
// This file REPLACES ALL of the following:
// ❌ scheduler_ui.js
// ❌ render_sync_fix.js  
// ❌ view_schedule_loader_fix.js
// ❌ schedule_version_merger.js
// ❌ schedule_version_ui.js
// ❌ post_generation_edit_system.js (NOW INTEGRATED)
// ❌ pinned_activity_preservation.js (NOW INTEGRATED)
//
// CRITICAL FIXES & FEATURES:
// ✅ v4.0.2: CROSS-DIVISION BYPASS SAVE - updates correct scheduler records directly
// ✅ v4.0.3: INTEGRATED EDIT SYSTEM with multi-bunk support
// ✅ v4.0.3: CASCADE RESOLUTION for field priority claims
// ✅ v4.0.3: PROPOSAL SYSTEM for cross-division changes
// ✅ v4.0.3: AUTO-BACKUP before complex operations
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v4.0.3 loading...');

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
    // RBAC VIEW BYPASS FOR SMART REGENERATION
    // =========================================================================

    let _bypassRBACViewEnabled = false;
    let _bypassHighlightBunks = new Set();

    function enableBypassRBACView(modifiedBunks = []) {
        console.log('[UnifiedSchedule] 👁️ RBAC view bypass ENABLED');
        _bypassRBACViewEnabled = true;
        window._bypassRBACViewEnabled = true;
        
        if (modifiedBunks.length > 0) {
            modifiedBunks.forEach(b => _bypassHighlightBunks.add(String(b)));
            window._bypassHighlightBunks = _bypassHighlightBunks;
        }
        
        updateTable();
        
        if (window.showToast) {
            window.showToast(`👁️ Bypass view: showing ${modifiedBunks.length} reassigned bunk(s)`, 'info');
        }
    }

    function disableBypassRBACView() {
        console.log('[UnifiedSchedule] 👁️ RBAC view bypass DISABLED');
        _bypassRBACViewEnabled = false;
        window._bypassRBACViewEnabled = false;
        _bypassHighlightBunks.clear();
        window._bypassHighlightBunks = new Set();
        updateTable();
    }

    function shouldShowDivision(divName) {
        if (_bypassRBACViewEnabled || window._bypassRBACViewEnabled) {
            return true;
        }
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') return true;
        return window.AccessControl?.canAccessDivision?.(divName) ?? true;
    }

    function shouldHighlightBunk(bunkName) {
        return _bypassHighlightBunks.has(String(bunkName)) || 
               window._bypassHighlightBunks?.has(String(bunkName));
    }

    // =========================================================================
    // ROTATION CONFIGURATION (for smart regeneration)
    // =========================================================================
    
    const ROTATION_CONFIG = {
        SAME_DAY_PENALTY: Infinity,
        YESTERDAY_PENALTY: 5000,
        TWO_DAYS_AGO_PENALTY: 3000,
        THREE_DAYS_AGO_PENALTY: 2000,
        FOUR_TO_SEVEN_DAYS_PENALTY: 800,
        WEEK_PLUS_PENALTY: 200,
        HIGH_FREQUENCY_PENALTY: 1500,
        ABOVE_AVERAGE_PENALTY: 500,
        NEVER_DONE_BONUS: -1500,
        UNDER_UTILIZED_BONUS: -800,
        ADJACENT_BUNK_BONUS: -100,
        NEARBY_BUNK_BONUS: -30
    };

    // =========================================================================
    // PINNED ACTIVITY STORAGE
    // =========================================================================
    
    let _pinnedSnapshot = {};
    let _pinnedFieldLocks = [];

    // =========================================================================
    // TIME UTILITIES
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        let s = str.trim().toLowerCase();
        let meridiem = null;
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridiem = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        } else {
            const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
            if (match24) {
                const h = parseInt(match24[1], 10);
                const m = parseInt(match24[2], 10);
                return h * 60 + m;
            }
            return null;
        }
        const match = s.match(/^(\d{1,2})\s*[:]\s*(\d{2})$/);
        if (!match) return null;
        let hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        if (isNaN(hours) || isNaN(mins) || mins < 0 || mins > 59) return null;
        if (hours === 12) hours = (meridiem === 'am' ? 0 : 12);
        else if (meridiem === 'pm') hours += 12;
        return hours * 60 + mins;
    }

    function minutesToTimeLabel(mins) {
        if (mins === null || mins === undefined) return '';
        const h24 = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
    }

    function minutesToTimeString(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function fieldLabel(f) {
        if (window.SchedulerCoreUtils?.fieldLabel) return window.SchedulerCoreUtils.fieldLabel(f);
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && typeof f.name === "string") return f.name;
        return "";
    }

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
    // DATA LOADING - CLOUD-AWARE
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
            console.log('[UnifiedSchedule] 🛡️ Skipping loadScheduleForDate - post-edit in progress');
            return;
        }
        if (!dateKey) dateKey = getDateKey();
        debugLog(`Loading data for: ${dateKey}`);
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey] || {};
        
        let loadedAssignments = false;
        if (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0) {
            loadedAssignments = true;
        } else if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            loadedAssignments = true;
        } else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dailyData.scheduleAssignments;
            loadedAssignments = true;
        }
        if (!loadedAssignments) window.scheduleAssignments = window.scheduleAssignments || {};
        
        if (!window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
            window.leagueAssignments = dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0 
                ? dateData.leagueAssignments : {};
        }
        
        const cloudLoaded = window._unifiedTimesFromCloud === true;
        if (cloudLoaded && window.unifiedTimes && window.unifiedTimes.length > 0) {
            // Keep cloud data
        } else if (window.unifiedTimes && window.unifiedTimes.length > 0) {
            // Keep existing
        } else if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
            window.unifiedTimes = normalizeUnifiedTimes(dateData.unifiedTimes);
        } else {
            const skeleton = getSkeleton(dateKey);
            window.unifiedTimes = skeleton.length > 0 ? buildUnifiedTimesFromSkeleton(skeleton) : [];
        }
        
        if (dateData.manualSkeleton?.length > 0) window.manualSkeleton = dateData.manualSkeleton;
        else if (dateData.skeleton?.length > 0) window.manualSkeleton = dateData.skeleton;
        
        return {
            scheduleAssignments: window.scheduleAssignments || {},
            leagueAssignments: window.leagueAssignments || {},
            unifiedTimes: window.unifiedTimes || [],
            skeleton: window.manualSkeleton || window.skeleton || []
        };
    }

    function getSkeleton(dateKey) {
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey || getDateKey()] || {};
        return dateData.manualSkeleton || dateData.skeleton || 
               window.dailyOverrideSkeleton || window.manualSkeleton || window.skeleton || [];
    }

    function normalizeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            let startMin = t.startMin, endMin = t.endMin;
            if (startMin === undefined) startMin = startDate.getHours() * 60 + startDate.getMinutes();
            if (endMin === undefined) endMin = endDate.getHours() * 60 + endDate.getMinutes();
            return { start: startDate, end: endDate, startMin, endMin, label: t.label || '' };
        });
    }

    function buildUnifiedTimesFromSkeleton(skeleton) {
        const INCREMENT_MINS = 30;
        if (!skeleton || skeleton.length === 0) return [];
        let minTime = 540, maxTime = 960, found = false;
        skeleton.forEach(block => {
            const startMin = parseTimeToMinutes(block.startTime);
            const endMin = parseTimeToMinutes(block.endTime);
            if (startMin !== null) { minTime = Math.min(minTime, startMin); found = true; }
            if (endMin !== null) { maxTime = Math.max(maxTime, endMin); found = true; }
        });
        if (!found) return [];
        minTime = Math.floor(minTime / INCREMENT_MINS) * INCREMENT_MINS;
        maxTime = Math.ceil(maxTime / INCREMENT_MINS) * INCREMENT_MINS;
        const timeSlots = [];
        const baseDate = new Date(); baseDate.setHours(0, 0, 0, 0);
        for (let mins = minTime; mins < maxTime; mins += INCREMENT_MINS) {
            const startDate = new Date(baseDate); startDate.setMinutes(mins);
            const endDate = new Date(baseDate); endDate.setMinutes(mins + INCREMENT_MINS);
            timeSlots.push({ start: startDate, end: endDate, startMin: mins, endMin: mins + INCREMENT_MINS,
                label: `${minutesToTimeLabel(mins)} - ${minutesToTimeLabel(mins + INCREMENT_MINS)}` });
        }
        return timeSlots;
    }

    // =========================================================================
    // SLOT INDEX MAPPING
    // =========================================================================
    
    function getSlotStartMin(slot) {
        if (!slot) return null;
        if (slot.startMin !== undefined) return slot.startMin;
        if (slot.start instanceof Date) return slot.start.getHours() * 60 + slot.start.getMinutes();
        if (slot.start) { const d = new Date(slot.start); return d.getHours() * 60 + d.getMinutes(); }
        return null;
    }

    function findSlotsForRange(startMin, endMin, unifiedTimes) {
        if (!unifiedTimes || unifiedTimes.length === 0 || startMin === null || endMin === null) return [];
        const slots = [];
        unifiedTimes.forEach((t, idx) => {
            const slotStart = getSlotStartMin(t);
            if (slotStart !== null && slotStart >= startMin && slotStart < endMin) slots.push(idx);
        });
        return slots;
    }
    
    function findSlotIndexForTime(targetMin, unifiedTimes) {
        if (!unifiedTimes || unifiedTimes.length === 0 || targetMin === null) return -1;
        for (let i = 0; i < unifiedTimes.length; i++) {
            if (getSlotStartMin(unifiedTimes[i]) === targetMin) return i;
        }
        const slots = findSlotsForRange(targetMin, targetMin + 30, unifiedTimes);
        if (slots.length > 0) return slots[0];
        let closest = -1, minDiff = Infinity;
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = getSlotStartMin(unifiedTimes[i]);
            if (slotStart !== null) {
                const diff = Math.abs(slotStart - targetMin);
                if (diff < minDiff) { minDiff = diff; closest = i; }
            }
        }
        return closest;
    }
    
    function getEntryForBlock(bunk, startMin, endMin, unifiedTimes) {
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) {
            const fallbackSlots = findSlotsForRange(startMin, endMin, unifiedTimes);
            return { entry: null, slotIdx: fallbackSlots[0] || -1 };
        }
        const bunkData = assignments[bunk];
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            let slotStart = null;
            if (unifiedTimes && unifiedTimes[slotIdx]) slotStart = getSlotStartMin(unifiedTimes[slotIdx]);
            if (slotStart !== null && slotStart >= startMin && slotStart < endMin) return { entry, slotIdx };
        }
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        for (const slotIdx of slots) {
            const entry = bunkData[slotIdx];
            if (entry && !entry.continuation) return { entry, slotIdx };
        }
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            const entryStartMin = entry._blockStart || entry._startMin || entry.startMin;
            if (entryStartMin !== undefined && entryStartMin >= startMin && entryStartMin < endMin) return { entry, slotIdx };
        }
        return { entry: null, slotIdx: slots[0] || -1 };
    }

    function getSlotTimeRange(slotIdx) {
        const unifiedTimes = window.unifiedTimes || [];
        const slot = unifiedTimes[slotIdx];
        if (!slot) return { startMin: null, endMin: null };
        const start = new Date(slot.start), end = new Date(slot.end);
        return { startMin: start.getHours() * 60 + start.getMinutes(), endMin: end.getHours() * 60 + end.getMinutes() };
    }

    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) return divName;
        }
        return null;
    }

    // =========================================================================
    // SPLIT TILE DETECTION
    // =========================================================================
    
    function isSplitTileBlock(block, bunks, unifiedTimes) {
        if (!block || !block.event || !block.event.includes('/')) return false;
        if (block.event.toLowerCase().includes('special')) return false;
        const duration = block.endMin - block.startMin;
        if (duration < 60) return false;
        const midpoint = Math.floor((block.startMin + block.endMin) / 2);
        const firstHalfSlots = findSlotsForRange(block.startMin, midpoint, unifiedTimes);
        const secondHalfSlots = findSlotsForRange(midpoint, block.endMin, unifiedTimes);
        if (firstHalfSlots.length === 0 || secondHalfSlots.length === 0) return false;
        const assignments = window.scheduleAssignments || {};
        for (const bunk of bunks) {
            const bunkData = assignments[bunk];
            if (!bunkData) continue;
            const firstEntry = bunkData[firstHalfSlots[0]], secondEntry = bunkData[secondHalfSlots[0]];
            if (firstEntry && secondEntry && !firstEntry.continuation && !secondEntry.continuation) {
                const firstAct = formatEntry(firstEntry), secondAct = formatEntry(secondEntry);
                if (firstAct && secondAct && firstAct !== secondAct) return true;
            }
        }
        return false;
    }
    
    function expandBlocksForSplitTiles(divBlocks, bunks, unifiedTimes) {
        const expandedBlocks = [];
        divBlocks.forEach(block => {
            if (isSplitTileBlock(block, bunks, unifiedTimes)) {
                const midpoint = Math.floor((block.startMin + block.endMin) / 2);
                expandedBlocks.push({ ...block, endMin: midpoint, _splitHalf: 1, _originalEvent: block.event, _isSplitTile: true });
                expandedBlocks.push({ ...block, startMin: midpoint, _splitHalf: 2, _originalEvent: block.event, _isSplitTile: true });
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

    function formatEntry(entry) {
        if (!entry) return '';
        if (entry._isDismissal) return 'Dismissal';
        if (entry._isSnack) return 'Snacks';
        if (entry._isTransition || entry.continuation) return '';
        const activity = entry._activity || '';
        const field = typeof entry.field === 'object' ? entry.field.name : (entry.field || '');
        const sport = entry.sport || '';
        if (entry._h2h) return entry._gameLabel || sport || 'League Game';
        if (entry._fixed) return activity || field;
        if (field && sport && field !== sport) return `${field} – ${sport}`;
        return activity || field || '';
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

    function isLeagueBlockType(eventName) {
        return eventName && eventName.toLowerCase().includes('league');
    }

    // =========================================================================
    // ACTIVITY PROPERTIES & LOCATIONS
    // =========================================================================

    function getActivityProperties() {
        if (window.activityProperties && Object.keys(window.activityProperties).length > 0) return window.activityProperties;
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const props = {};
        (app1.fields || []).forEach(f => {
            if (f.name) props[f.name] = { ...f, type: 'field', capacity: f.sharableWith?.capacity || (f.sharableWith?.type === 'all' ? 2 : 1) };
        });
        (app1.specialActivities || []).forEach(s => {
            if (s.name) props[s.name] = { ...s, type: 'special', capacity: s.sharableWith?.capacity || 1 };
        });
        return props;
    }

    function getAllLocations() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const locations = [];
        (app1.fields || []).forEach(f => {
            if (f.name && f.available !== false) locations.push({ name: f.name, type: 'field', capacity: f.sharableWith?.capacity || 1 });
        });
        (app1.specialActivities || []).forEach(s => {
            if (s.name) locations.push({ name: s.name, type: 'special', capacity: s.sharableWith?.capacity || 1 });
        });
        return locations;
    }

    // =========================================================================
    // RBAC HELPERS
    // =========================================================================

    function getEditableBunks() {
        const editableBunks = new Set();
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        const divisions = window.divisions || {};
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) divInfo.bunks.forEach(b => editableBunks.add(String(b)));
        }
        if (editableBunks.size === 0) {
            const role = window.AccessControl?.getCurrentRole?.();
            if (!window.AccessControl || role === 'owner' || role === 'admin') {
                Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(b));
            }
        }
        return editableBunks;
    }

    function canEditBunk(bunkName) {
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') return true;
        return getEditableBunks().has(bunkName);
    }

    // =========================================================================
    // FIELD USAGE TRACKING
    // =========================================================================

    function buildFieldUsageBySlot(excludeBunks = []) {
        const fieldUsageBySlot = {};
        const assignments = window.scheduleAssignments || {};
        const excludeSet = new Set(excludeBunks);
        for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
            if (excludeSet.has(bunkName) || !bunkSlots || !Array.isArray(bunkSlots)) continue;
            for (let slotIdx = 0; slotIdx < bunkSlots.length; slotIdx++) {
                const entry = bunkSlots[slotIdx];
                if (!entry || !entry.field || entry._isTransition || entry.field === TRANSITION_TYPE) continue;
                const fName = fieldLabel(entry.field);
                if (!fName || fName === 'Free') continue;
                if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
                if (!fieldUsageBySlot[slotIdx][fName]) fieldUsageBySlot[slotIdx][fName] = { count: 0, bunks: {}, divisions: [] };
                const usage = fieldUsageBySlot[slotIdx][fName];
                usage.count++;
                usage.bunks[bunkName] = entry._activity || fName;
                const divName = getDivisionForBunk(bunkName);
                if (divName && !usage.divisions.includes(divName)) usage.divisions.push(divName);
            }
        }
        return fieldUsageBySlot;
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        const activityProperties = getActivityProperties();
        const locationInfo = activityProperties[locationName] || {};
        let maxCapacity = locationInfo.sharableWith?.capacity ? parseInt(locationInfo.sharableWith.capacity) || 1 : (locationInfo.sharable ? 2 : 1);
        const editableBunks = getEditableBunks();
        const conflicts = [], usageBySlot = {};
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;
                const entryField = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                const entryActivity = entry._activity || entryField;
                const entryLocation = entry._location || entryField;
                const matchesLocation = entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryLocation?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase();
                if (matchesLocation) {
                    usageBySlot[slotIdx].push({ bunk: bunkName, activity: entryActivity || entryField, field: entryField, canEdit: editableBunks.has(bunkName) });
                }
            }
        }
        let globalLock = null;
        if (window.GlobalFieldLocks) {
            const divName = getDivisionForBunk(excludeBunk);
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, divName);
            if (lockInfo) globalLock = lockInfo;
        }
        let hasConflict = !!globalLock, currentUsage = 0;
        for (const slotIdx of slots) {
            const slotUsage = usageBySlot[slotIdx] || [];
            currentUsage = Math.max(currentUsage, slotUsage.length);
            if (slotUsage.length >= maxCapacity) {
                hasConflict = true;
                slotUsage.forEach(u => { if (!conflicts.find(c => c.bunk === u.bunk && c.slot === slotIdx)) conflicts.push({ ...u, slot: slotIdx }); });
            }
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
        const done = new Set();
        const bunkData = window.scheduleAssignments?.[bunk];
        if (!bunkData) return done;
        for (let i = 0; i < beforeSlot; i++) {
            const entry = bunkData[i];
            if (entry) {
                const actName = entry._activity || entry.sport || fieldLabel(entry.field);
                if (actName && actName.toLowerCase() !== 'free' && !actName.toLowerCase().includes('transition')) done.add(actName.toLowerCase().trim());
            }
        }
        return done;
    }

    function getActivityCount(bunk, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        return globalSettings.historicalCounts?.[bunk]?.[activityName] || 0;
    }

    function getDaysSinceActivity(bunk, activityName) {
        const rotationHistory = window.loadRotationHistory?.() || {};
        const lastDone = rotationHistory.bunks?.[bunk]?.[activityName];
        if (!lastDone) return null;
        return Math.floor((Date.now() - lastDone) / (24 * 60 * 60 * 1000));
    }

    function calculateRotationPenalty(bunk, activityName, slots) {
        if (!activityName || activityName === 'Free') return 0;
        const firstSlot = slots[0];
        const doneToday = getActivitiesDoneToday(bunk, firstSlot);
        if (doneToday.has(activityName.toLowerCase().trim())) return ROTATION_CONFIG.SAME_DAY_PENALTY;
        const daysSince = getDaysSinceActivity(bunk, activityName);
        let recencyPenalty = 0;
        if (daysSince === null) recencyPenalty = ROTATION_CONFIG.NEVER_DONE_BONUS;
        else if (daysSince === 0) return ROTATION_CONFIG.SAME_DAY_PENALTY;
        else if (daysSince === 1) recencyPenalty = ROTATION_CONFIG.YESTERDAY_PENALTY;
        else if (daysSince === 2) recencyPenalty = ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY;
        else if (daysSince === 3) recencyPenalty = ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY;
        else if (daysSince <= 7) recencyPenalty = ROTATION_CONFIG.FOUR_TO_SEVEN_DAYS_PENALTY;
        else recencyPenalty = ROTATION_CONFIG.WEEK_PLUS_PENALTY;
        const count = getActivityCount(bunk, activityName);
        let frequencyPenalty = 0;
        if (count > 5) frequencyPenalty = ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY;
        else if (count > 3) frequencyPenalty = ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        else if (count === 0) frequencyPenalty = ROTATION_CONFIG.UNDER_UTILIZED_BONUS;
        return recencyPenalty + frequencyPenalty;
    }

    function isFieldAvailable(fieldName, slots, excludeBunk, fieldUsageBySlot, activityProperties) {
        const divName = getDivisionForBunk(excludeBunk);
        if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots, divName)) return false;
        if ((window.currentDisabledFields || []).includes(fieldName)) return false;
        const props = activityProperties[fieldName] || {};
        let maxCapacity = props.sharableWith?.capacity ? parseInt(props.sharableWith.capacity) || 1 : (props.sharable ? 2 : 1);
        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
            if (slotUsage && slotUsage.count >= maxCapacity) return false;
        }
        return true;
    }

    function buildCandidateOptions(slots, activityProperties, disabledFields = []) {
        const options = [], seenKeys = new Set();
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fieldsBySport = settings.fieldsBySport || {};
        for (const [sport, sportFields] of Object.entries(fieldsBySport)) {
            (sportFields || []).forEach(fieldName => {
                if (disabledFields.includes(fieldName) || window.GlobalFieldLocks?.isFieldLocked(fieldName, slots)) return;
                const key = `${fieldName}|${sport}`;
                if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: fieldName, sport, activityName: sport, type: 'sport' }); }
            });
        }
        for (const special of (app1.specialActivities || [])) {
            if (!special.name || disabledFields.includes(special.name) || window.GlobalFieldLocks?.isFieldLocked(special.name, slots)) continue;
            const key = `special|${special.name}`;
            if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: special.name, sport: null, activityName: special.name, type: 'special' }); }
        }
        for (const field of (app1.fields || [])) {
            if (!field.name || field.available === false || disabledFields.includes(field.name) || window.GlobalFieldLocks?.isFieldLocked(field.name, slots)) continue;
            (field.activities || []).forEach(activity => {
                const key = `${field.name}|${activity}`;
                if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: field.name, sport: activity, activityName: activity, type: 'sport' }); }
            });
        }
        return options;
    }

    function calculatePenaltyCost(bunk, slots, pick, fieldUsageBySlot, activityProperties) {
        let penalty = 0;
        const activityName = pick.activityName || pick._activity || pick.sport;
        const fieldName = pick.field;
        const divName = getDivisionForBunk(bunk);
        const rotationPenalty = calculateRotationPenalty(bunk, activityName, slots);
        if (rotationPenalty === Infinity) return Infinity;
        penalty += rotationPenalty;
        const props = activityProperties[fieldName] || {};
        if (props.preferences?.enabled && props.preferences?.list) {
            const idx = props.preferences.list.indexOf(divName);
            if (idx !== -1) penalty -= (50 - idx * 5);
            else if (props.preferences.exclusive) return Infinity;
            else penalty += 500;
        }
        const myNum = parseInt((bunk.match(/\d+/) || [])[0]) || 0;
        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
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
        const maxUsage = props.maxUsage || 0;
        if (maxUsage > 0) {
            const hist = getActivityCount(bunk, activityName);
            if (hist >= maxUsage) return Infinity;
            if (hist >= maxUsage - 1) penalty += 2000;
        }
        return penalty;
    }

    function findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, avoidFields = []) {
        const disabledFields = window.currentDisabledFields || [];
        const avoidSet = new Set(avoidFields.map(f => f.toLowerCase()));
        const candidates = buildCandidateOptions(slots, activityProperties, disabledFields);
        const scoredPicks = [];
        for (const cand of candidates) {
            if (avoidSet.has(cand.field.toLowerCase()) || avoidSet.has(cand.activityName?.toLowerCase())) continue;
            if (!isFieldAvailable(cand.field, slots, bunk, fieldUsageBySlot, activityProperties)) continue;
            const cost = calculatePenaltyCost(bunk, slots, cand, fieldUsageBySlot, activityProperties);
            if (cost < Infinity) scoredPicks.push({ ...cand, cost });
        }
        scoredPicks.sort((a, b) => a.cost - b.cost);
        return scoredPicks.length > 0 ? scoredPicks[0] : null;
    }

    function applyPickToBunk(bunk, slots, pick, fieldUsageBySlot, activityProperties) {
        const divName = getDivisionForBunk(bunk);
        const unifiedTimes = window.unifiedTimes || [];
        let startMin = null, endMin = null;
        if (slots.length > 0 && unifiedTimes[slots[0]]) {
            startMin = getSlotStartMin(unifiedTimes[slots[0]]);
            const lastSlot = unifiedTimes[slots[slots.length - 1]];
            if (lastSlot) endMin = lastSlot.endMin !== undefined ? lastSlot.endMin : (getSlotStartMin(lastSlot) + 30);
        }
        const pickData = { field: pick.field, sport: pick.sport, _fixed: true, _activity: pick.activityName,
            _smartRegenerated: true, _regeneratedAt: Date.now(), _startMin: startMin, _endMin: endMin, _blockStart: startMin };
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
        slots.forEach((slotIdx, i) => { window.scheduleAssignments[bunk][slotIdx] = { ...pickData, continuation: i > 0 }; });
        if (typeof window.fillBlock === 'function') {
            try {
                const firstSlotTime = getSlotTimeRange(slots[0]), lastSlotTime = getSlotTimeRange(slots[slots.length - 1]);
                const block = { divName, bunk, startTime: firstSlotTime.startMin, endTime: lastSlotTime.endMin, slots };
                window.fillBlock(block, pickData, fieldUsageBySlot, window.yesterdayHistory || {}, false, activityProperties);
            } catch (e) { console.warn(`[UnifiedSchedule] fillBlock error for ${bunk}:`, e); }
        }
        const fieldName = pick.field;
        for (const slotIdx of slots) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fieldName]) fieldUsageBySlot[slotIdx][fieldName] = { count: 0, bunks: {}, divisions: [] };
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++; usage.bunks[bunk] = pick.activityName;
            if (divName && !usage.divisions.includes(divName)) usage.divisions.push(divName);
        }
    }

    // =========================================================================
    // SMART REGENERATION FOR CONFLICTS
    // =========================================================================

    function smartRegenerateConflicts(pinnedBunk, pinnedSlots, pinnedField, pinnedActivity, conflicts, bypassMode = false) {
        console.log('[SmartRegen] ★★★ SMART REGENERATION STARTED ★★★');
        if (bypassMode) console.log('[SmartRegen] 🔓 BYPASS MODE ACTIVE');
        const activityProperties = getActivityProperties();
        const results = { success: true, reassigned: [], failed: [], pinnedLock: null, bypassMode };
        if (window.GlobalFieldLocks) {
            const pinnedDivName = getDivisionForBunk(pinnedBunk);
            window.GlobalFieldLocks.lockField(pinnedField, pinnedSlots, { lockedBy: 'smart_regen_pinned', division: pinnedDivName, activity: pinnedActivity, bunk: pinnedBunk });
            results.pinnedLock = { field: pinnedField, slots: pinnedSlots };
        }
        const conflictsByBunk = {};
        for (const conflict of conflicts) {
            if (!conflictsByBunk[conflict.bunk]) conflictsByBunk[conflict.bunk] = new Set();
            conflictsByBunk[conflict.bunk].add(conflict.slot);
        }
        const bunksToReassign = Object.keys(conflictsByBunk);
        const fieldUsageBySlot = buildFieldUsageBySlot(bunksToReassign);
        for (const slotIdx of pinnedSlots) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][pinnedField]) fieldUsageBySlot[slotIdx][pinnedField] = { count: 0, bunks: {}, divisions: [] };
            fieldUsageBySlot[slotIdx][pinnedField].count++;
            fieldUsageBySlot[slotIdx][pinnedField].bunks[pinnedBunk] = pinnedActivity;
        }
        bunksToReassign.sort((a, b) => { const numA = parseInt((a.match(/\d+/) || [])[0]) || 0, numB = parseInt((b.match(/\d+/) || [])[0]) || 0; return numA - numB; });
        for (const bunk of bunksToReassign) {
            const slots = [...conflictsByBunk[bunk]].sort((a, b) => a - b);
            const originalEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            const originalActivity = originalEntry?._activity || originalEntry?.sport || fieldLabel(originalEntry?.field);
            console.log(`[SmartRegen] Processing ${bunk}: slots=${slots.join(',')}, original=${originalActivity}`);
            const bestPick = findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, [pinnedField]);
            if (bestPick) {
                console.log(`[SmartRegen] ✅ ${bunk}: ${originalActivity} → ${bestPick.activityName} (field: ${bestPick.field})`);
                applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProperties);
                // Verify the data was written
                const verifyEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];
                console.log(`[SmartRegen] VERIFY ${bunk}[${slots[0]}]:`, {
                    _activity: verifyEntry?._activity,
                    field: verifyEntry?.field,
                    sport: verifyEntry?.sport,
                    _smartRegenerated: verifyEntry?._smartRegenerated
                });
                results.reassigned.push({ bunk, slots, from: originalActivity || 'unknown', to: bestPick.activityName, field: bestPick.field, cost: bestPick.cost });
                if (window.showToast) window.showToast(`↪️ ${bunk}: ${originalActivity} → ${bestPick.activityName}`, 'info');
            } else {
                if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
                slots.forEach((slotIdx, i) => {
                    window.scheduleAssignments[bunk][slotIdx] = { field: 'Free', sport: null, continuation: i > 0, _fixed: false, _activity: 'Free', _smartRegenFailed: true, _originalActivity: originalActivity, _failedAt: Date.now() };
                });
                results.failed.push({ bunk, slots, originalActivity, reason: 'No valid alternative found' });
                results.success = false;
                if (window.showToast) window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
            }
        }
        console.log(`[SmartRegen] ★★★ COMPLETE: ${results.reassigned.length} reassigned, ${results.failed.length} failed ★★★`);
        return results;
    }

    function smartReassignBunkActivity(bunk, slots, avoidLocation) {
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) return { success: false };
        const originalActivity = entry._activity || entry.sport || fieldLabel(entry.field);
        const activityProperties = getActivityProperties();
        const fieldUsageBySlot = buildFieldUsageBySlot([bunk]);
        const bestPick = findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, [avoidLocation]);
        if (bestPick) {
            applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProperties);
            if (window.showToast) window.showToast(`↪️ ${bunk}: Moved to ${bestPick.activityName}`, 'info');
            return { success: true, field: bestPick.field, activity: bestPick.activityName, cost: bestPick.cost };
        } else {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
            slots.forEach((slotIdx, i) => {
                window.scheduleAssignments[bunk][slotIdx] = { field: 'Free', sport: null, continuation: i > 0, _fixed: false, _activity: 'Free', _noAlternative: true, _originalActivity: originalActivity, _originalField: avoidLocation };
            });
            if (window.showToast) window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
            return { success: false, reason: 'No valid alternative found' };
        }
    }

    // =========================================================================
    // PINNED ACTIVITY PRESERVATION
    // =========================================================================

    function capturePinnedActivities(allowedDivisions) {
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        _pinnedSnapshot = {}; _pinnedFieldLocks = [];
        let capturedCount = 0;
        let allowedBunks = null;
        if (allowedDivisions && allowedDivisions.length > 0) {
            allowedBunks = new Set();
            for (const divName of allowedDivisions) {
                const divInfo = divisions[divName];
                if (divInfo?.bunks) divInfo.bunks.forEach(b => allowedBunks.add(b));
            }
        }
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (allowedBunks && !allowedBunks.has(bunkName)) continue;
            if (!slots || !Array.isArray(slots)) continue;
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    if (!_pinnedSnapshot[bunkName]) _pinnedSnapshot[bunkName] = {};
                    _pinnedSnapshot[bunkName][slotIdx] = { ...entry, _preservedAt: Date.now() };
                    capturedCount++;
                    const fieldName = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                    if (fieldName && fieldName !== 'Free') _pinnedFieldLocks.push({ field: fieldName, slot: slotIdx, bunk: bunkName, activity: entry._activity || fieldName });
                }
            }
        }
        console.log(`[PinnedPreserve] 📌 Captured ${capturedCount} pinned activities`);
        return _pinnedSnapshot;
    }

    function registerPinnedFieldLocks() {
        if (!window.GlobalFieldLocks) return;
        const divisions = window.divisions || {};
        for (const lockInfo of _pinnedFieldLocks) {
            const divName = Object.keys(divisions).find(d => divisions[d]?.bunks?.includes(lockInfo.bunk));
            window.GlobalFieldLocks.lockField(lockInfo.field, [lockInfo.slot], { lockedBy: 'pinned_activity', division: divName || 'unknown', activity: lockInfo.activity, bunk: lockInfo.bunk, _pinnedLock: true });
        }
    }

    function registerPinnedFieldUsage(fieldUsageBySlot, activityProperties) {
        if (!fieldUsageBySlot) return;
        const divisions = window.divisions || {};
        for (const lockInfo of _pinnedFieldLocks) {
            const slotIdx = lockInfo.slot, fieldName = lockInfo.field;
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][fieldName]) fieldUsageBySlot[slotIdx][fieldName] = { count: 0, divisions: [], bunks: {}, _locked: true, _fromPinned: true };
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++; usage.bunks[lockInfo.bunk] = lockInfo.activity;
            const divName = Object.keys(divisions).find(d => divisions[d]?.bunks?.includes(lockInfo.bunk));
            if (divName && !usage.divisions.includes(divName)) usage.divisions.push(divName);
        }
    }

    function restorePinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        let restoredCount = 0;
        for (const [bunkName, pinnedSlots] of Object.entries(_pinnedSnapshot)) {
            if (!assignments[bunkName]) assignments[bunkName] = new Array((window.unifiedTimes || []).length);
            for (const [slotIdxStr, entry] of Object.entries(pinnedSlots)) {
                assignments[bunkName][parseInt(slotIdxStr, 10)] = { ...entry, _restoredAt: Date.now() };
                restoredCount++;
            }
        }
        console.log(`[PinnedPreserve] ✅ Restored ${restoredCount} pinned activities`);
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
                    pinned.push({ bunk: bunkName, slot: slotIdx, activity: entry._activity || entry.field, field: typeof entry.field === 'object' ? entry.field?.name : entry.field, editedAt: entry._editedAt || entry._preservedAt });
                }
            }
        }
        return pinned;
    }

    function unpinActivity(bunk, slotIdx) {
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry) { delete entry._pinned; delete entry._postEdit; entry._unpinnedAt = Date.now(); saveSchedule(); updateTable(); return true; }
        return false;
    }

    function unpinAllActivities() {
        const assignments = window.scheduleAssignments || {};
        let unpinnedCount = 0;
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) { delete entry._pinned; delete entry._postEdit; entry._unpinnedAt = Date.now(); unpinnedCount++; }
            }
        }
        saveSchedule(); updateTable();
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
            const divSlots = Object.keys(leagues[divName]).map(Number).sort((a, b) => a - b);
            for (const storedSlot of divSlots) {
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
                for (let i = 0; i < teams.length - 1; i += 2) { if (teams[i + 1]) displayMatchups.push({ teamA: teams[i], teamB: teams[i + 1], display: `${teams[i]} vs ${teams[i + 1]}` }); }
                if (teams.length % 2 === 1) displayMatchups.push({ teamA: teams[teams.length - 1], teamB: 'BYE', display: `${teams[teams.length - 1]} (BYE)` });
                return { matchups: displayMatchups, gameLabel: `${league.name} Game`, sport: league.sports?.[0] || 'League', leagueName: league.name };
            }
        }
        return { matchups: [], gameLabel: '', sport: '', leagueName: '' };
    }

    // =========================================================================
    // MAIN RENDER FUNCTION
    // =========================================================================

    function renderStaggeredView(container) {
        if (!container) { container = document.getElementById('scheduleTable'); if (!container) return; }
        const dateKey = getDateKey();
        if (!window._postEditInProgress) loadScheduleForDate(dateKey);
        else console.log('[UnifiedSchedule] 🛡️ RENDER: Using in-memory data (post-edit in progress)');
        const skeleton = getSkeleton(dateKey);
        const unifiedTimes = window.unifiedTimes || [];
        const divisions = window.divisions || {};
        console.log('[UnifiedSchedule] RENDER STATE:', { dateKey, skeletonBlocks: skeleton.length, unifiedTimesSlots: unifiedTimes.length,
            scheduleAssignmentsBunks: Object.keys(window.scheduleAssignments || {}).length, divisionsCount: Object.keys(divisions).length,
            bypassRBACView: _bypassRBACViewEnabled || window._bypassRBACViewEnabled });
        container.innerHTML = '';
        if (!skeleton || skeleton.length === 0) {
            container.innerHTML = `<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No daily schedule structure found for this date.</p><p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p></div>`;
            return;
        }
        let divisionsToShow = Object.keys(divisions);
        if (divisionsToShow.length === 0 && window.availableDivisions) divisionsToShow = window.availableDivisions;
        divisionsToShow.sort((a, b) => { const numA = parseInt(a), numB = parseInt(b); if (!isNaN(numA) && !isNaN(numB)) return numA - numB; return String(a).localeCompare(String(b)); });
        if (divisionsToShow.length === 0) { container.innerHTML = `<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No divisions configured.</p></div>`; return; }
        const wrapper = document.createElement('div');
        wrapper.className = 'schedule-view-wrapper';
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 24px;';
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || divisionsToShow;
        divisionsToShow.forEach(divName => {
            // ★★★ RBAC VIEW BYPASS CHECK ★★★
            if (!shouldShowDivision(divName)) return;
            const divInfo = divisions[divName];
            if (!divInfo) return;
            let bunks = divInfo.bunks || [];
            if (bunks.length === 0) return;
            bunks = bunks.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
            const isEditable = editableDivisions.includes(divName);
            const table = renderDivisionTable(divName, divInfo, bunks, skeleton, unifiedTimes, isEditable);
            if (table) wrapper.appendChild(table);
        });
        container.appendChild(wrapper);
        if (window.MultiSchedulerAutonomous?.applyBlockingToGrid) setTimeout(() => window.MultiSchedulerAutonomous.applyBlockingToGrid(), 50);
        window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', { detail: { dateKey } }));
    }

    function renderDivisionTable(divName, divInfo, bunks, skeleton, unifiedTimes, isEditable) {
        let divBlocks = skeleton.filter(b => b.division === divName).map(b => ({ ...b, startMin: parseTimeToMinutes(b.startTime), endMin: parseTimeToMinutes(b.endTime) }))
            .filter(b => b.startMin !== null && b.endMin !== null).sort((a, b) => a.startMin - b.startMin);
        if (divBlocks.length === 0) return null;
        divBlocks = expandBlocksForSplitTiles(divBlocks, bunks, unifiedTimes);
        const table = document.createElement('table');
        table.className = 'schedule-division-table';
        table.style.cssText = 'width: 100%; border-collapse: collapse; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; background: #fff; margin-bottom: 8px;';
        const divColor = divInfo.color || '#4b5563';
        const thead = document.createElement('thead');
        const tr1 = document.createElement('tr');
        const th = document.createElement('th');
        th.colSpan = 1 + bunks.length;
        th.innerHTML = escapeHtml(divName) + (isEditable ? '' : ' <span style="opacity:0.7">🔒</span>');
        th.style.cssText = `background: ${divColor}; color: #fff; padding: 12px 16px; font-size: 1.1rem; font-weight: 600; text-align: left;`;
        tr1.appendChild(th); thead.appendChild(tr1);
        const tr2 = document.createElement('tr'); tr2.style.background = '#f9fafb';
        const thTime = document.createElement('th'); thTime.textContent = 'Time';
        thTime.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 140px;';
        tr2.appendChild(thTime);
        bunks.forEach(bunk => { const thB = document.createElement('th'); thB.textContent = bunk; thB.style.cssText = 'padding: 10px 12px; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 100px; text-align: center;'; tr2.appendChild(thB); });
        thead.appendChild(tr2); table.appendChild(thead);
        const tbody = document.createElement('tbody');
        divBlocks.forEach((block, blockIdx) => {
            const timeLabel = `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`;
            const tr = document.createElement('tr');
            tr.style.background = blockIdx % 2 === 0 ? '#fff' : '#fafafa';
            if (block._isSplitTile) tr.style.background = block._splitHalf === 1 ? (blockIdx % 2 === 0 ? '#f0fdf4' : '#ecfdf5') : (blockIdx % 2 === 0 ? '#fef3c7' : '#fef9c3');
            const tdTime = document.createElement('td'); tdTime.textContent = timeLabel;
            tdTime.style.cssText = 'padding: 10px 12px; font-weight: 500; color: #4b5563; border-right: 1px solid #e5e7eb; white-space: nowrap;';
            if (block._isSplitTile) { const halfLabel = block._splitHalf === 1 ? '①' : '②'; tdTime.innerHTML = `${escapeHtml(timeLabel)} <span style="color: #6b7280; font-size: 0.8rem;">${halfLabel}</span>`; }
            tr.appendChild(tdTime);
            if (isLeagueBlockType(block.event)) { tr.appendChild(renderLeagueCell(block, bunks, divName, unifiedTimes, isEditable)); tbody.appendChild(tr); return; }
            bunks.forEach(bunk => tr.appendChild(renderBunkCell(block, bunk, divName, unifiedTimes, isEditable)));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
    }

    function renderLeagueCell(block, bunks, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.colSpan = bunks.length;
        td.style.cssText = 'padding: 12px 16px; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border-left: 4px solid #0284c7; vertical-align: top;';
        
        const slots = findSlotsForRange(block.startMin, block.endMin, unifiedTimes);
        let leagueInfo = { matchups: [], gameLabel: '', sport: '', leagueName: '' };
        for (const idx of slots) { 
            const info = getLeagueMatchups(divName, idx); 
            if (info.matchups.length > 0 || info.gameLabel) { leagueInfo = info; break; } 
        }
        
        let title = leagueInfo.gameLabel || block.event;
        if (leagueInfo.sport && !title.toLowerCase().includes(leagueInfo.sport.toLowerCase())) title += ` - ${leagueInfo.sport}`;
        
        let html = `<div style="font-weight: 600; font-size: 1rem; color: #0369a1; margin-bottom: 8px;">🏆 ${escapeHtml(title)}</div>`;
        
        if (leagueInfo.matchups?.length > 0) {
            html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
            leagueInfo.matchups.forEach(m => {
                let matchText = typeof m === 'string' ? m : m.display || (m.teamA && m.teamB ? `${m.teamA} vs ${m.teamB}${m.field ? ` @ ${m.field}` : ''}` : (m.team1 && m.team2 ? `${m.team1} vs ${m.team2}` : (m.matchup || JSON.stringify(m))));
                html += `<div style="background: #fff; padding: 6px 12px; border-radius: 6px; font-size: 0.875rem; color: #1e3a5f; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${escapeHtml(matchText)}</div>`;
            });
            html += '</div>';
        } else {
            html += '<div style="color: #64748b; font-size: 0.875rem; font-style: italic;">No matchups scheduled yet</div>';
        }
        
        td.innerHTML = html;
        
        // ★★★ UPDATED: Use Integrated Edit Modal ★★★
        if (isEditable && bunks.length > 0) { 
            td.style.cursor = 'pointer'; 
            td.onclick = () => {
                const firstBunk = bunks[0];
                const slotIdx = slots[0] || 0;
                const existingEntry = window.scheduleAssignments?.[firstBunk]?.[slotIdx];
                if (typeof openIntegratedEditModal === 'function') {
                    openIntegratedEditModal(firstBunk, slotIdx, existingEntry);
                } else {
                    // Fallback to old behavior
                    enhancedEditCell(firstBunk, block.startMin, block.endMin, block.event);
                }
            };
        }
        
        return td;
    }

    function renderBunkCell(block, bunk, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        const { entry, slotIdx } = getEntryForBlock(bunk, block.startMin, block.endMin, unifiedTimes);
        
        let isBlocked = false, blockedReason = '';
        if (window.MultiSchedulerAutonomous?.isBunkSlotBlocked) { 
            const blockCheck = window.MultiSchedulerAutonomous.isBunkSlotBlocked(bunk, slotIdx); 
            if (blockCheck.blocked) { isBlocked = true; blockedReason = blockCheck.reason; } 
        }
        
        let displayText = '', bgColor = '#fff';
        if (entry && !entry.continuation) { 
            displayText = formatEntry(entry); 
            bgColor = getEntryBackground(entry, block.event); 
            if (entry._pinned) displayText = '📌 ' + displayText; 
        }
        else if (!entry) { 
            if (isFixedBlockType(block.event)) { displayText = block.event; bgColor = '#fff8e1'; } 
            else bgColor = '#f9fafb'; 
        }
        
        td.textContent = displayText;
        td.style.background = bgColor;
        
        // Highlight bypassed bunks
        if (shouldHighlightBunk(bunk)) { 
            td.style.background = 'linear-gradient(135deg, #fef3c7, #fde68a)'; 
            td.style.boxShadow = 'inset 0 0 0 3px #f59e0b'; 
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
                if (window.showToast) window.showToast(`🔒 Cannot edit: ${blockedReason}`, 'error'); 
                else alert(`🔒 Cannot edit: ${blockedReason}`); 
            }; 
        }
        else if (isEditable) { 
            td.style.cursor = 'pointer'; 
            // ★★★ UPDATED: Use Integrated Edit Modal ★★★
            td.onclick = () => {
                const existingEntry = window.scheduleAssignments?.[bunk]?.[slotIdx];
                if (typeof openIntegratedEditModal === 'function') {
                    openIntegratedEditModal(bunk, slotIdx, existingEntry);
                } else {
                    // Fallback to old behavior if integrated modal not loaded
                    enhancedEditCell(bunk, block.startMin, block.endMin, displayText.replace('📌 ', ''));
                }
            };
        }
        return td;
    }
    // =========================================================================
    // APPLY DIRECT EDIT
    // =========================================================================

    function applyDirectEdit(bunk, slots, activity, location, isClear, shouldPin = true) {
        const unifiedTimes = window.unifiedTimes || [];
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        const fieldValue = location ? `${location} – ${activity}` : activity;
        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = { field: isClear ? 'Free' : fieldValue, sport: isClear ? null : activity, continuation: i > 0,
                _fixed: !isClear, _activity: isClear ? 'Free' : activity, _location: location, _postEdit: true, _pinned: shouldPin && !isClear, _editedAt: Date.now() };
        });
        if (location && !isClear && window.registerLocationUsage) {
            const divName = getDivisionForBunk(bunk);
            slots.forEach(idx => window.registerLocationUsage(idx, location, activity, divName));
        }
    }

    // =========================================================================
    // BYPASS SAVE - CROSS-DIVISION DIRECT UPDATE (v4.0.2)
    // =========================================================================

    async function bypassSaveAllBunks(modifiedBunks) {
        console.log('[UnifiedSchedule] 🔓 BYPASS SAVE for bunks:', modifiedBunks);
        const dateKey = window.currentScheduleDate || window.currentDate || document.getElementById('datePicker')?.value || new Date().toISOString().split('T')[0];
        
        // Step 1: Save to localStorage first (immediate backup)
        try {
            localStorage.setItem(`scheduleAssignments_${dateKey}`, JSON.stringify(window.scheduleAssignments));
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[dateKey]) allDailyData[dateKey] = {};
            allDailyData[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDailyData[dateKey].leagueAssignments = window.leagueAssignments || {};
            allDailyData[dateKey].unifiedTimes = window.unifiedTimes || [];
            allDailyData[dateKey]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            console.log('[UnifiedSchedule] ✅ Bypass: saved to localStorage');
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
            console.log('[UnifiedSchedule] 🔓 Loading all scheduler records for cross-division update...');
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            
            if (loadError) {
                console.error('[UnifiedSchedule] Failed to load records:', loadError);
                // Fallback to old method
                return await fallbackBypassSave(dateKey, modifiedBunks);
            }
            
            console.log(`[UnifiedSchedule] 🔓 Found ${allRecords?.length || 0} scheduler records`);
            
            if (!allRecords || allRecords.length === 0) {
                // No existing records - use standard save
                console.log('[UnifiedSchedule] 🔓 No existing records, using standard save');
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
            const recordUpdates = new Map(); // record.id -> { record, bunksToUpdate }
            const orphanBunks = []; // Bunks not in any record (will go to current user)
            
            modifiedBunks.forEach(bunk => {
                const bunkStr = String(bunk);
                const owningRecord = bunkToRecord[bunkStr];
                
                if (owningRecord) {
                    if (!recordUpdates.has(owningRecord.id)) {
                        recordUpdates.set(owningRecord.id, { 
                            record: owningRecord, 
                            bunksToUpdate: [] 
                        });
                    }
                    recordUpdates.get(owningRecord.id).bunksToUpdate.push(bunkStr);
                } else {
                    orphanBunks.push(bunkStr);
                }
            });
            
            console.log(`[UnifiedSchedule] 🔓 Updates needed:`, 
                [...recordUpdates.entries()].map(([id, data]) => 
                    `${data.record.scheduler_name || 'unknown'}: bunks ${data.bunksToUpdate.join(', ')}`
                )
            );
            if (orphanBunks.length > 0) {
                console.log(`[UnifiedSchedule] 🔓 Orphan bunks (will add to your record): ${orphanBunks.join(', ')}`);
            }
            
            // Step 6: Update each record directly
            let successCount = 0;
            let failCount = 0;
            const updatedSchedulers = [];
            
            for (const [recordId, { record, bunksToUpdate }] of recordUpdates) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...(scheduleData.scheduleAssignments || {}) };
                const leagues = { ...(scheduleData.leagueAssignments || {}) };
                
                // Apply updates from window globals
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
                    leagueAssignments: leagues
                };
                
                // Serialize unifiedTimes
                const serializedTimes = window.ScheduleDB?.serializeUnifiedTimes?.(window.unifiedTimes) 
                    || window.unifiedTimes?.map(t => ({
                        start: t.start instanceof Date ? t.start.toISOString() : t.start,
                        end: t.end instanceof Date ? t.end.toISOString() : t.end,
                        startMin: t.startMin,
                        endMin: t.endMin,
                        label: t.label
                    })) || [];
                
                const { error: updateError } = await client
                    .from('daily_schedules')
                    .update({
                        schedule_data: updatedData,
                        unified_times: serializedTimes,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', recordId);
                
                if (updateError) {
                    console.error(`[UnifiedSchedule] ❌ Failed to update ${record.scheduler_name || 'unknown'}:`, updateError);
                    failCount++;
                } else {
                    console.log(`[UnifiedSchedule] ✅ Updated ${record.scheduler_name || 'unknown'} with bunks: ${bunksToUpdate.join(', ')}`);
                    successCount++;
                    updatedSchedulers.push(record.scheduler_name || record.scheduler_id);
                }
            }
            
            // Step 7: Handle orphan bunks (add to current user's record via standard save)
            if (orphanBunks.length > 0) {
                console.log(`[UnifiedSchedule] 🔓 Saving orphan bunks via standard method...`);
                if (window.ScheduleDB?.saveSchedule) {
                    try {
                        await window.ScheduleDB.saveSchedule(dateKey, {
                            scheduleAssignments: window.scheduleAssignments,
                            leagueAssignments: window.leagueAssignments || {},
                            unifiedTimes: window.unifiedTimes
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
                    detail: { 
                        dateKey, 
                        modifiedBunks, 
                        successCount, 
                        failCount,
                        updatedSchedulers,
                        timestamp: Date.now() 
                    } 
                }));
            } catch (e) { 
                console.warn('[UnifiedSchedule] Bypass sync broadcast warning:', e); 
            }
            
            // Step 9: Show toast
            if (window.showToast) {
                const divisions = window.divisions || {};
                const divisionNames = new Set();
                modifiedBunks.forEach(bunk => { 
                    for (const [divName, divData] of Object.entries(divisions)) { 
                        if (divData.bunks?.includes(bunk) || divData.bunks?.includes(String(bunk))) 
                            divisionNames.add(divName); 
                    } 
                });
                const schedulerInfo = updatedSchedulers.length > 0 ? ` (updated: ${updatedSchedulers.join(', ')})` : '';
                window.showToast(
                    `🔓 Cross-division bypass: ${modifiedBunks.length} bunk(s) in Div ${[...divisionNames].join(', ')}${schedulerInfo}`, 
                    failCount === 0 ? 'success' : 'warning'
                );
            }
            
            return { 
                success: failCount === 0, 
                successCount, 
                failCount, 
                updatedSchedulers,
                target: 'cloud-direct' 
            };
            
        } catch (e) {
            console.error('[UnifiedSchedule] Bypass save exception:', e);
            // Fallback to old method
            return await fallbackBypassSave(dateKey, modifiedBunks);
        }
    }
    
    // Fallback method (original behavior)
    async function fallbackBypassSave(dateKey, modifiedBunks) {
        console.log('[UnifiedSchedule] 🔓 Using fallback bypass save (skipFilter)');
        let cloudResult = { success: false };
        if (window.ScheduleDB?.saveSchedule) {
            try {
                cloudResult = await window.ScheduleDB.saveSchedule(dateKey, { 
                    scheduleAssignments: window.scheduleAssignments, 
                    leagueAssignments: window.leagueAssignments || {}, 
                    unifiedTimes: window.unifiedTimes, 
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
                    if (divData.bunks?.includes(bunk) || divData.bunks?.includes(String(bunk))) 
                        divisionNames.add(divName); 
                } 
            });
            window.showToast(
                `🔓 Bypass saved: ${modifiedBunks.length} bunk(s)${[...divisionNames].length ? ` in Div ${[...divisionNames].join(', ')}` : ''} - synced`, 
                'success'
            );
        }
        return cloudResult;
    }

    // =========================================================================
    // SCHEDULER NOTIFICATION
    // =========================================================================

    async function sendSchedulerNotification(affectedBunks, location, activity, notificationType) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        if (!campId) return;
        try {
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            for (const bunk of affectedBunks) { for (const [divName, divData] of Object.entries(divisions)) { if (divData.bunks?.includes(bunk)) affectedDivisions.add(divName); } }
            const { data: schedulers } = await supabase.from('camp_users').select('user_id, divisions').eq('camp_id', campId).neq('user_id', userId);
            if (!schedulers) return;
            const notifyUsers = schedulers.filter(s => (s.divisions || []).some(d => affectedDivisions.has(d))).map(s => s.user_id);
            if (notifyUsers.length === 0) return;
            const notifications = notifyUsers.map(targetUserId => ({
                camp_id: campId, user_id: targetUserId,
                type: notificationType === 'bypassed' ? 'schedule_bypassed' : 'schedule_conflict',
                title: notificationType === 'bypassed' ? '🔓 Your schedule was modified' : '⚠️ Schedule conflict detected',
                message: notificationType === 'bypassed' ? `Another scheduler reassigned bunks (${affectedBunks.join(', ')}) for ${location} - ${activity} on ${dateKey}` : `Conflict at ${location} for ${activity} on ${dateKey}. Affected bunks: ${affectedBunks.join(', ')}`,
                metadata: { dateKey, bunks: affectedBunks, location, activity, initiatedBy: userId },
                read: false, created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        } catch (e) { console.error('[UnifiedSchedule] Notification error:', e); }
    }

    // =========================================================================
    // RESOLVE CONFLICTS AND APPLY
    // =========================================================================

    async function resolveConflictsAndApply(bunk, slots, activity, location, editData) {
        const editableConflicts = editData.editableConflicts || [];
        const nonEditableConflicts = editData.nonEditableConflicts || [];
        const resolutionChoice = editData.resolutionChoice || 'notify';
        applyDirectEdit(bunk, slots, activity, location, false, true);
        if (window.GlobalFieldLocks) { const divName = getDivisionForBunk(bunk); window.GlobalFieldLocks.lockField(location, slots, { lockedBy: 'post_edit_pinned', division: divName, activity }); }
        let conflictsToResolve = [...editableConflicts];
        const bypassMode = resolutionChoice === 'bypass';
        if (bypassMode && nonEditableConflicts.length > 0) { console.log('[UnifiedSchedule] 🔓 BYPASS MODE'); conflictsToResolve = [...conflictsToResolve, ...nonEditableConflicts]; }
        if (conflictsToResolve.length > 0) {
            const result = smartRegenerateConflicts(bunk, slots, location, activity, conflictsToResolve, bypassMode);
            if (bypassMode) {
                const modifiedBunks = [...result.reassigned.map(r => r.bunk), ...result.failed.map(f => f.bunk)];
                window._postEditInProgress = true; window._postEditTimestamp = Date.now();
                await bypassSaveAllBunks(modifiedBunks);
                // ★★★ Enable bypass view to show reassigned bunks ★★★
                const reassignedBunks = result.reassigned.map(r => r.bunk);
                if (reassignedBunks.length > 0) enableBypassRBACView(reassignedBunks);
                if (nonEditableConflicts.length > 0) { sendSchedulerNotification([...new Set(nonEditableConflicts.map(c => c.bunk))], location, activity, 'bypassed'); if (window.showToast) window.showToast(`🔓 Bypassed permissions - reassigned ${nonEditableConflicts.length} bunk(s)`, 'info'); }
            } else if (nonEditableConflicts.length > 0) { sendSchedulerNotification([...new Set(nonEditableConflicts.map(c => c.bunk))], location, activity, 'conflict'); if (window.showToast) window.showToast(`📧 Notification sent about ${nonEditableConflicts.length} conflict(s)`, 'warning'); }
        }
    }

    // =========================================================================
    // APPLY EDIT
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        if (slots.length === 0) { alert('Error: Could not find time slots.'); return; }
        window._postEditInProgress = true; window._postEditTimestamp = Date.now();
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        if (hasConflict) await resolveConflictsAndApply(bunk, slots, activity, location, editData);
        else applyDirectEdit(bunk, slots, activity, location, isClear, true);
        const currentDate = window.currentScheduleDate || window.currentDate || document.getElementById('datePicker')?.value || new Date().toISOString().split('T')[0];
        try {
            localStorage.setItem(`scheduleAssignments_${currentDate}`, JSON.stringify(window.scheduleAssignments));
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].unifiedTimes = window.unifiedTimes || [];
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) { console.error('[UnifiedSchedule] Failed to save to localStorage:', e); }
        setTimeout(() => { window._postEditInProgress = false; }, 8000);
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', { detail: { bunk, slots, activity, location, date: currentDate } }));
        saveSchedule(); updateTable();
        setTimeout(() => updateTable(), 300);
    }

    // =========================================================================
    // MODAL UI (LEGACY / DIRECT EDIT FALLBACK)
    // =========================================================================

    function createModal() {
        document.getElementById(OVERLAY_ID)?.remove(); document.getElementById(MODAL_ID)?.remove();
        const overlay = document.createElement('div'); overlay.id = OVERLAY_ID;
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;';
        const modal = document.createElement('div'); modal.id = MODAL_ID;
        modal.style.cssText = 'background: white; border-radius: 12px; padding: 24px; min-width: 400px; max-width: 500px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-height: 90vh; overflow-y: auto;';
        overlay.appendChild(modal); document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); } });
        return modal;
    }

    function closeModal() { document.getElementById(OVERLAY_ID)?.remove(); }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        let currentActivity = currentValue || '', currentField = '', resolutionChoice = 'notify';
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) { currentField = typeof entry.field === 'object' ? entry.field?.name : (entry.field || ''); currentActivity = entry._activity || currentField || currentValue; }
        }
        modal.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;"><h2 style="margin: 0; font-size: 1.25rem; color: #1f2937;">Edit Schedule Cell</h2><button id="post-edit-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #9ca3af;">&times;</button></div><div style="background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px;"><div style="font-weight: 600; color: #374151;">${bunk}</div><div style="font-size: 0.875rem; color: #6b7280;" id="post-edit-time-display">${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}</div></div><div style="display: flex; flex-direction: column; gap: 16px;"><div><label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">Activity Name</label><input type="text" id="post-edit-activity" value="${escapeHtml(currentActivity)}" placeholder="e.g., Basketball" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;"><div style="font-size: 0.75rem; color: #9ca3af; margin-top: 4px;">Enter CLEAR or FREE to empty</div></div><div><label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">Location / Field</label><select id="post-edit-location" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box; background: white;"><option value="">-- No specific location --</option><optgroup label="Fields">${locations.filter(l => l.type === 'field').map(l => `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}${l.capacity > 1 ? ` (capacity: ${l.capacity})` : ''}</option>`).join('')}</optgroup><optgroup label="Special Activities">${locations.filter(l => l.type === 'special').map(l => `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}</option>`).join('')}</optgroup></select></div><div><button type="button" id="post-edit-time-toggle" style="background: none; border: none; color: #2563eb; font-size: 0.875rem; cursor: pointer; padding: 0; display: flex; align-items: center; gap: 4px;"><span id="post-edit-time-arrow">▶</span> Change time</button><div id="post-edit-time-section" style="display: none; margin-top: 12px;"><div style="display: flex; gap: 12px;"><div style="flex: 1;"><label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">Start Time</label><input type="time" id="post-edit-start" value="${minutesToTimeString(startMin)}" style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;"></div><div style="flex: 1;"><label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">End Time</label><input type="time" id="post-edit-end" value="${minutesToTimeString(endMin)}" style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;"></div></div></div></div><div id="post-edit-conflict" style="display: none;"></div><div style="display: flex; gap: 12px; margin-top: 8px;"><button id="post-edit-cancel" style="flex: 1; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: white; color: #374151; font-size: 1rem; cursor: pointer; font-weight: 500;">Cancel</button><button id="post-edit-save" style="flex: 1; padding: 12px; border: none; border-radius: 8px; background: #2563eb; color: white; font-size: 1rem; cursor: pointer; font-weight: 500;">Save Changes</button></div></div>`;
        let useOriginalTime = true;
        const originalStartMin = startMin, originalEndMin = endMin;
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        const timeToggle = document.getElementById('post-edit-time-toggle'), timeSection = document.getElementById('post-edit-time-section'), timeArrow = document.getElementById('post-edit-time-arrow'), timeDisplay = document.getElementById('post-edit-time-display');
        timeToggle.onclick = () => { const isHidden = timeSection.style.display === 'none'; timeSection.style.display = isHidden ? 'block' : 'none'; timeArrow.textContent = isHidden ? '▼' : '▶'; useOriginalTime = !isHidden; };
        const locationSelect = document.getElementById('post-edit-location'), conflictArea = document.getElementById('post-edit-conflict'), startInput = document.getElementById('post-edit-start'), endInput = document.getElementById('post-edit-end');
        function getEffectiveTimes() { return useOriginalTime ? { startMin: originalStartMin, endMin: originalEndMin } : { startMin: parseTimeToMinutes(startInput.value) || originalStartMin, endMin: parseTimeToMinutes(endInput.value) || originalEndMin }; }
        function updateTimeDisplay() { const times = getEffectiveTimes(); timeDisplay.textContent = `${minutesToTimeLabel(times.startMin)} - ${minutesToTimeLabel(times.endMin)}`; }
        function checkAndShowConflicts() {
            const location = locationSelect.value; const times = getEffectiveTimes();
            if (!location) { conflictArea.style.display = 'none'; return null; }
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            if (conflictCheck.hasConflict) {
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                conflictArea.style.display = 'block';
                let html = `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;"><div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><span style="font-size: 1.25rem;">⚠️</span><strong style="color: #92400e;">Location Conflict Detected</strong></div><p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;"><strong>${location}</strong> is already in use:</p>`;
                if (editableBunks.length > 0) html += `<div style="margin-bottom: 8px; padding: 8px; background: #d1fae5; border-radius: 6px;"><div style="font-size: 0.8rem; color: #065f46;"><strong>✓ Can auto-reassign:</strong> ${editableBunks.join(', ')}</div></div>`;
                if (nonEditableBunks.length > 0) html += `<div style="margin-bottom: 8px; padding: 8px; background: #fee2e2; border-radius: 6px;"><div style="font-size: 0.8rem; color: #991b1b;"><strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.join(', ')}</div></div><div style="margin-top: 12px;"><div style="font-weight: 500; color: #374151; margin-bottom: 8px; font-size: 0.875rem;">How to handle their bunks?</div><div style="display: flex; flex-direction: column; gap: 8px;"><label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;"><input type="radio" name="conflict-resolution" value="notify" checked style="margin-top: 2px;"><div><div style="font-weight: 500; color: #374151;">📧 Notify other scheduler</div><div style="font-size: 0.75rem; color: #6b7280;">Create double-booking & send them a warning</div></div></label><label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;"><input type="radio" name="conflict-resolution" value="bypass" style="margin-top: 2px;"><div><div style="font-weight: 500; color: #374151;">🔓 Bypass & reassign (Admin mode)</div><div style="font-size: 0.75rem; color: #6b7280;">Override permissions and use smart regeneration</div></div></label></div></div>`;
                html += `</div>`; conflictArea.innerHTML = html;
                conflictArea.querySelectorAll('input[name="conflict-resolution"]').forEach(radio => { radio.addEventListener('change', (e) => { resolutionChoice = e.target.value; }); });
                return conflictCheck;
            } else { conflictArea.style.display = 'none'; return null; }
        }
        locationSelect.addEventListener('change', checkAndShowConflicts);
        startInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        endInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        checkAndShowConflicts();
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value; const times = getEffectiveTimes();
            if (!activity) { alert('Please enter an activity name.'); return; }
            if (times.endMin <= times.startMin) { alert('End time must be after start time.'); return; }
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            if (conflictCheck?.hasConflict) onSave({ activity, location, startMin: times.startMin, endMin: times.endMin, hasConflict: true, conflicts: conflictCheck.conflicts, editableConflicts: conflictCheck.editableConflicts || [], nonEditableConflicts: conflictCheck.nonEditableConflicts || [], resolutionChoice });
            else onSave({ activity, location, startMin: times.startMin, endMin: times.endMin, hasConflict: false, conflicts: [] });
            closeModal();
        };
        document.getElementById('post-edit-activity').focus(); document.getElementById('post-edit-activity').select();
    }

    function enhancedEditCell(bunk, startMin, endMin, current) {
        if (!canEditBunk(bunk)) { alert('You do not have permission to edit this schedule.'); return; }
        showEditModal(bunk, startMin, endMin, current, (editData) => applyEdit(bunk, editData));
    }

    function editCell(bunk, startMin, endMin, current) { enhancedEditCell(bunk, startMin, endMin, current); }

    // =========================================================================
    // SAVE & UPDATE
    // =========================================================================

    function saveSchedule() {
        const silent = window._postEditInProgress;
        if (window.saveCurrentDailyData) {
            window.saveCurrentDailyData('scheduleAssignments', window.scheduleAssignments, { silent });
            window.saveCurrentDailyData('leagueAssignments', window.leagueAssignments, { silent });
            window.saveCurrentDailyData('unifiedTimes', window.unifiedTimes, { silent });
        }
    }

    function updateTable() {
        const now = Date.now();
        if (window._postEditInProgress) {
            _lastRenderTime = now; _renderQueued = false; if (_renderTimeout) { clearTimeout(_renderTimeout); _renderTimeout = null; }
            const container = document.getElementById('scheduleTable');
            if (container) renderStaggeredView(container);
            return;
        }
        if (now - _lastRenderTime < RENDER_DEBOUNCE_MS) {
            if (!_renderQueued) { _renderQueued = true; if (_renderTimeout) clearTimeout(_renderTimeout); _renderTimeout = setTimeout(() => { _renderQueued = false; _lastRenderTime = Date.now(); const container = document.getElementById('scheduleTable'); if (container) renderStaggeredView(container); }, RENDER_DEBOUNCE_MS); }
            return;
        }
        _lastRenderTime = now;
        const container = document.getElementById('scheduleTable');
        if (container) renderStaggeredView(container);
    }

    // =========================================================================
    // VERSION MANAGEMENT
    // =========================================================================
    
    const VersionManager = {
        async saveVersion(name) {
            const dateKey = getDateKey();
            if (!dateKey) { alert('Please select a date first.'); return { success: false }; }
            if (!name) { name = prompt('Enter a name for this version:'); if (!name) return { success: false }; }
            const dailyData = loadDailyData(); const dateData = dailyData[dateKey] || {};
            const payload = { scheduleAssignments: window.scheduleAssignments || dateData.scheduleAssignments || {}, leagueAssignments: window.leagueAssignments || dateData.leagueAssignments || {}, unifiedTimes: window.unifiedTimes || dateData.unifiedTimes || [] };
            if (Object.keys(payload.scheduleAssignments).length === 0) { alert('No schedule data to save.'); return { success: false }; }
            if (!window.ScheduleVersionsDB) { alert('Version database not available.'); return { success: false }; }
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                const existing = versions.find(v => v.name.toLowerCase() === name.toLowerCase());
                if (existing) { if (!confirm(`Version "${existing.name}" already exists. Overwrite?`)) return { success: false }; if (window.ScheduleVersionsDB.updateVersion) { const result = await window.ScheduleVersionsDB.updateVersion(existing.id, payload); if (result.success) { alert('✅ Version updated!'); return { success: true }; } else { alert('❌ Error: ' + result.error); return { success: false }; } } }
                const result = await window.ScheduleVersionsDB.createVersion(dateKey, name, payload);
                if (result.success) { alert('✅ Version saved!'); return { success: true }; } else { alert('❌ Error: ' + result.error); return { success: false }; }
            } catch (err) { alert('Error: ' + err.message); return { success: false }; }
        },
        async loadVersion() {
            const dateKey = getDateKey();
            if (!dateKey || !window.ScheduleVersionsDB) { alert('Not available.'); return; }
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                if (!versions?.length) { alert('No saved versions.'); return; }
                let msg = 'Select a version:\n\n'; versions.forEach((v, i) => { msg += `${i + 1}. ${v.name} (${new Date(v.created_at).toLocaleTimeString()})\n`; });
                const choice = prompt(msg); if (!choice) return;
                const index = parseInt(choice) - 1; if (isNaN(index) || !versions[index]) { alert('Invalid selection'); return; }
                const selected = versions[index]; if (!confirm(`Load "${selected.name}"?`)) return;
                let data = selected.schedule_data; if (typeof data === 'string') try { data = JSON.parse(data); } catch(e) {}
                window.scheduleAssignments = data.scheduleAssignments || data;
                if (data.leagueAssignments) window.leagueAssignments = data.leagueAssignments;
                if (data.unifiedTimes) window.unifiedTimes = normalizeUnifiedTimes(data.unifiedTimes);
                saveSchedule(); updateTable(); alert('✅ Version loaded!');
            } catch (err) { alert('Error: ' + err.message); }
        },
        async mergeVersions() {
            const dateKey = getDateKey();
            if (!dateKey || !window.ScheduleVersionsDB) { alert('Not available.'); return { success: false }; }
            if (!confirm(`Merge ALL versions for ${dateKey}?`)) return { success: false };
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                if (!versions?.length) { alert('No versions to merge.'); return { success: false }; }
                const mergedAssignments = {}; const bunksTouched = new Set(); let latestLeagueData = null;
                versions.forEach(ver => {
                    let scheduleData = ver.schedule_data || ver.data || ver.payload;
                    if (typeof scheduleData === 'string') try { scheduleData = JSON.parse(scheduleData); } catch(e) {}
                    if (!scheduleData) return;
                    const assignments = scheduleData.scheduleAssignments || scheduleData;
                    if (assignments && typeof assignments === 'object') Object.entries(assignments).forEach(([bunkId, slots]) => { mergedAssignments[bunkId] = slots; bunksTouched.add(bunkId); });
                    if (scheduleData.leagueAssignments) latestLeagueData = scheduleData.leagueAssignments;
                });
                window.scheduleAssignments = mergedAssignments;
                if (latestLeagueData) window.leagueAssignments = latestLeagueData;
                saveSchedule(); updateTable();
                alert(`✅ Merged ${versions.length} versions (${bunksTouched.size} bunks).`);
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
                if (Object.keys(_pinnedSnapshot).length > 0) { restorePinnedActivities(); saveSchedule(); }
                return result;
            };
            window.runScheduler._pinnedHooked = true;
        }
        if (typeof window.generateSchedule === 'function' && !window.generateSchedule._pinnedHooked) {
            const originalGenerateSchedule = window.generateSchedule;
            window.generateSchedule = async function(...args) {
                capturePinnedActivities(args[0]?.allowedDivisions || window.selectedDivisionsForGeneration || null);
                const result = await originalGenerateSchedule.apply(this, args);
                if (Object.keys(_pinnedSnapshot).length > 0) { restorePinnedActivities(); saveSchedule(); updateTable(); }
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
            const style = document.createElement('style'); style.id = 'unified-schedule-styles';
            style.textContent = `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } #${MODAL_ID} input:focus, #${MODAL_ID} select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); } #${MODAL_ID} button:hover { opacity: 0.9; }`;
            document.head.appendChild(style);
        }
        hookSchedulerGeneration();
        setTimeout(hookSchedulerGeneration, 1000);
        setTimeout(hookSchedulerGeneration, 3000);
        _initialized = true;
    }

    function reconcileOrRenderSaved() { loadScheduleForDate(getDateKey()); updateTable(); }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    window.addEventListener('campistry-cloud-hydrated', () => { if (window._postEditInProgress) return; _cloudHydrated = true; setTimeout(() => { if (!window._postEditInProgress) { loadScheduleForDate(getDateKey()); updateTable(); } }, 100); });
    window.addEventListener('campistry-cloud-schedule-loaded', () => { if (window._postEditInProgress) return; _cloudHydrated = true; setTimeout(() => { if (!window._postEditInProgress) updateTable(); }, 100); });
    window.addEventListener('campistry-daily-data-updated', () => { if (window._postEditInProgress) return; loadScheduleForDate(getDateKey()); updateTable(); });
    window.addEventListener('campistry-date-changed', (e) => { if (window._postEditInProgress) return; if (window.UnifiedCloudSchedule?.load) window.UnifiedCloudSchedule.load().then(result => { if (!window._postEditInProgress) { if (!result.merged) loadScheduleForDate(e.detail?.dateKey || getDateKey()); updateTable(); } }); else { loadScheduleForDate(e.detail?.dateKey || getDateKey()); updateTable(); } });
    window.addEventListener('campistry-generation-complete', () => { if (window.UnifiedCloudSchedule?.save) setTimeout(() => window.UnifiedCloudSchedule.save(), 500); updateTable(); });
    window.addEventListener('campistry-generation-starting', (e) => { capturePinnedActivities(e.detail?.allowedDivisions || null); });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideVersionToolbar);
    else hideVersionToolbar();
    setTimeout(hideVersionToolbar, 500); setTimeout(hideVersionToolbar, 1500); setTimeout(hideVersionToolbar, 3000);

    // =========================================================================
    // FIELD PRIORITY CLAIM & INTEGRATED EDIT SYSTEM (v4.0.3)
    // =========================================================================

    // --- HELPER FUNCTIONS ---

    function getMyDivisions() {
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {});
        }
        return window.AccessControl?.getUserDivisions?.() || 
               window.AccessControl?.getEditableDivisions?.() || [];
    }

    function getBunksForDivision(divName) {
        const divisions = window.divisions || {};
        return divisions[divName]?.bunks || [];
    }

    function minutesToTimeStr(minutes) {
        if (minutes === null || minutes === undefined) return '';
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    // --- CORE: FIND ALL CONFLICTS FOR A FIELD CLAIM ---

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

    // --- CORE: CASCADE RESOLUTION ENGINE ---

    function buildCascadeResolutionPlan(fieldName, slots, claimingDivision, claimingActivity) {
        console.log('[CascadeClaim] ★★★ BUILDING RESOLUTION PLAN ★★★');
        console.log(`[CascadeClaim] Claiming ${fieldName} for ${claimingDivision} (${claimingActivity})`);
        console.log(`[CascadeClaim] Slots: ${slots.join(', ')}`);

        const plan = [];
        const blocked = [];
        const processedConflicts = new Set();
        const fieldUsageBySlot = buildFieldUsageBySlot([]);
        
        // Simulate the claim
        const simulatedUsage = JSON.parse(JSON.stringify(fieldUsageBySlot));
        for (const slotIdx of slots) {
            if (!simulatedUsage[slotIdx]) simulatedUsage[slotIdx] = {};
            simulatedUsage[slotIdx][fieldName] = {
                count: 999,
                bunks: { '_CLAIMED_': claimingActivity },
                divisions: [claimingDivision]
            };
        }

        let conflictQueue = findAllConflictsForClaim(fieldName, slots, []);
        let iteration = 0;
        const MAX_ITERATIONS = 50;

        while (conflictQueue.length > 0 && iteration < MAX_ITERATIONS) {
            iteration++;
            const conflict = conflictQueue.shift();
            const conflictKey = `${conflict.bunk}:${conflict.slot}`;
            
            if (processedConflicts.has(conflictKey)) continue;
            processedConflicts.add(conflictKey);

            console.log(`[CascadeClaim] Processing conflict #${iteration}: ${conflict.bunk} @ slot ${conflict.slot}`);

            // PINNED ALWAYS WINS
            if (conflict.isPinned) {
                console.log(`[CascadeClaim] ❌ BLOCKED: ${conflict.bunk} has PINNED activity`);
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
                console.log(`[CascadeClaim] ❌ BLOCKED: No alternative for ${conflict.bunk}`);
                blocked.push({ ...conflict, reason: 'No alternative activity available' });
                continue;
            }

            console.log(`[CascadeClaim] ✓ Found alternative: ${alternative.activityName} @ ${alternative.field}`);

            plan.push({
                bunk: conflict.bunk,
                slot: conflict.slot,
                division: conflict.division,
                from: { activity: conflict.currentActivity, field: conflict.currentField },
                to: { activity: alternative.activityName, field: alternative.field }
            });

            // Update simulated usage
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

            // Check for ripple effects
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

    // --- HELPER: FIND ALTERNATIVE ACTIVITY FOR A BUNK ---

    function findAlternativeForBunk(bunk, slots, divName, simulatedUsage, excludeFields = []) {
        const activityProperties = getActivityProperties();
        const excludeSet = new Set(excludeFields.map(f => fieldLabel(f)));

        const config = {
            masterFields: window.masterFields || [],
            masterSpecials: window.masterSpecials || []
        };

        const candidates = [];
        
        // Sports
        (config.masterFields || []).forEach(f => {
            if (excludeSet.has(f.name)) return;
            
            (f.activities || []).forEach(sport => {
                let available = true;
                const props = activityProperties[f.name] || {};
                const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);

                for (const slotIdx of slots) {
                    const usage = simulatedUsage[slotIdx]?.[f.name];
                    if (usage && usage.count >= maxCapacity) { available = false; break; }
                    if (window.GlobalFieldLocks?.isFieldLocked(f.name, [slotIdx], divName)) { available = false; break; }
                }

                if (available) {
                    const penalty = calculateRotationPenalty(bunk, sport, slots, activityProperties);
                    if (penalty !== Infinity) {
                        candidates.push({ field: f.name, activityName: sport, type: 'sport', penalty });
                    }
                }
            });
        });

        // Specials
        (config.masterSpecials || []).forEach(s => {
            if (excludeSet.has(s.name)) return;

            let available = true;
            const props = activityProperties[s.name] || {};
            const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);

            for (const slotIdx of slots) {
                const usage = simulatedUsage[slotIdx]?.[s.name];
                if (usage && usage.count >= maxCapacity) { available = false; break; }
                if (window.GlobalFieldLocks?.isFieldLocked(s.name, [slotIdx], divName)) { available = false; break; }
            }

            if (available) {
                const penalty = calculateRotationPenalty(bunk, s.name, slots, activityProperties);
                if (penalty !== Infinity) {
                    candidates.push({ field: s.name, activityName: s.name, type: 'special', penalty });
                }
            }
        });

        candidates.sort((a, b) => a.penalty - b.penalty);
        return candidates[0] || null;
    }

    // --- HELPER: CHECK IF MOVE CREATES NEW CONFLICTS ---

    function checkIfMoveCreatesConflict(bunk, slot, newField, simulatedUsage, alreadyProcessed) {
        const newConflicts = [];
        const activityProperties = getActivityProperties();
        const props = activityProperties[newField] || {};
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

    // --- INTEGRATED EDIT MODAL - ENTRY POINT ---

    function openIntegratedEditModal(bunk, slotIdx, existingEntry = null) {
        closeIntegratedEditModal();

        const divName = getDivisionForBunk(bunk);
        const bunksInDivision = getBunksForDivision(divName);
        const times = window.unifiedTimes || [];
        const slotInfo = times[slotIdx] || {};
        const timeLabel = slotInfo.label || `${minutesToTimeStr(slotInfo.startMin)} - ${minutesToTimeStr(slotInfo.endMin)}`;

        _currentEditContext = { bunk, slotIdx, divName, bunksInDivision, existingEntry, slotInfo };

        showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEditBunk(bunk));
    }

    // --- SCOPE SELECTION MODAL ---

    function showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEdit) {
        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 9998;
            animation: fadeIn 0.2s ease-out;
        `;
        overlay.onclick = closeIntegratedEditModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = INTEGRATED_EDIT_MODAL_ID;
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: white; border-radius: 12px; padding: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999;
            min-width: 400px; max-width: 500px;
            animation: fadeIn 0.2s ease-out;
        `;
        modal.onclick = e => e.stopPropagation();

        const currentActivity = _currentEditContext.existingEntry?._activity || 
                               _currentEditContext.existingEntry?.sport || 
                               _currentEditContext.existingEntry?.field || 'Free';
        const bunksInDiv = _currentEditContext.bunksInDivision || [];

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af; font-size: 1.2rem;">✏️ Edit Schedule</h2>
                <button onclick="closeIntegratedEditModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #6b7280;">&times;</button>
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
                            <div style="font-weight: 500; color: #1f2937;">🏠 Just this bunk</div>
                            <div style="font-size: 0.85rem; color: #6b7280; margin-top: 2px;">Edit ${escapeHtml(bunk)} only</div>
                        </div>
                    </label>

                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="division" style="margin-top: 3px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; color: #1f2937;">👥 Entire division</div>
                            <div style="font-size: 0.85rem; color: #6b7280; margin-top: 2px;">All ${bunksInDiv.length} bunks in ${escapeHtml(divName)}</div>
                        </div>
                    </label>

                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="select" style="margin-top: 3px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; color: #1f2937;">☑️ Select specific bunks</div>
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

            <div id="time-range-area" style="display: none; margin-bottom: 20px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 8px;">Time range:</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div>
                        <label style="font-size: 0.85rem; color: #6b7280;">Start</label>
                        <select id="edit-start-slot" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; margin-top: 4px;">
                            ${(window.unifiedTimes || []).map((t, i) => `<option value="${i}" ${i === slotIdx ? 'selected' : ''}>${t.label || minutesToTimeStr(t.startMin)}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 0.85rem; color: #6b7280;">End</label>
                        <select id="edit-end-slot" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; margin-top: 4px;">
                            ${(window.unifiedTimes || []).map((t, i) => `<option value="${i}" ${i === slotIdx ? 'selected' : ''}>${t.label || minutesToTimeStr(t.endMin)}</option>`).join('')}
                        </select>
                    </div>
                </div>
            </div>

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
        const timeArea = document.getElementById('time-range-area');

        radios.forEach(radio => {
            radio.addEventListener('change', () => {
                const scope = radio.value;
                bunkArea.style.display = scope === 'select' ? 'block' : 'none';
                timeArea.style.display = (scope === 'division' || scope === 'select') ? 'block' : 'none';

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
    
    // ★★★ FIX: Save context BEFORE closing modal ★★★
    const ctx = _currentEditContext;
    if (!ctx) {
        alert('Edit context lost. Please try again.');
        closeIntegratedEditModal();
        return;
    }
    
    if (scope === 'single') {
        closeIntegratedEditModal();
        // Use saved ctx instead of _currentEditContext
        enhancedEditCell(
            ctx.bunk,
            ctx.slotInfo?.startMin ?? ctx.slotInfo?.start,
            ctx.slotInfo?.endMin ?? ctx.slotInfo?.end,
            ctx.existingEntry?._activity || ''
        );
    } else if (scope === 'division') {
        const startSlot = parseInt(document.getElementById('edit-start-slot')?.value);
        const endSlot = parseInt(document.getElementById('edit-end-slot')?.value);
        
        if (endSlot < startSlot) { alert('End time must be after start time'); return; }

        const slots = [];
        for (let i = startSlot; i <= endSlot; i++) slots.push(i);

        closeIntegratedEditModal();
        openMultiBunkEditModal(ctx.bunksInDivision, slots, ctx.divName);
    } else if (scope === 'select') {
        const selectedBunks = Array.from(document.querySelectorAll('.bunk-checkbox:checked')).map(cb => cb.value);
        
        if (selectedBunks.length === 0) { alert('Please select at least one bunk'); return; }

        const startSlot = parseInt(document.getElementById('edit-start-slot')?.value);
        const endSlot = parseInt(document.getElementById('edit-end-slot')?.value);
        
        if (endSlot < startSlot) { alert('End time must be after start time'); return; }

        const slots = [];
        for (let i = startSlot; i <= endSlot; i++) slots.push(i);

        closeIntegratedEditModal();
        openMultiBunkEditModal(selectedBunks, slots, ctx.divName);
    }
}

    // --- MULTI-BUNK EDIT MODAL ---

    function openMultiBunkEditModal(bunks, slots, divName) {
        _multiBunkEditContext = { bunks, slots, divName };
        _multiBunkPreviewResult = null;

        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9998;`;
        overlay.onclick = closeIntegratedEditModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = INTEGRATED_EDIT_MODAL_ID;
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: white; border-radius: 12px; padding: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999;
            min-width: 500px; max-width: 620px; max-height: 85vh; overflow-y: auto;
        `;
        modal.onclick = e => e.stopPropagation();

        const times = window.unifiedTimes || [];
        const startSlot = times[slots[0]];
        const endSlot = times[slots[slots.length - 1]];
        const timeRange = `${minutesToTimeStr(startSlot?.startMin)} - ${minutesToTimeStr(endSlot?.endMin)}`;
        const allLocations = getAllLocations();

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af; font-size: 1.2rem;">🎯 Multi-Bunk Edit</h2>
                <button onclick="closeIntegratedEditModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer;">&times;</button>
            </div>

            <div style="background: #eff6ff; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <div style="font-weight: 500; color: #1e40af;">${escapeHtml(divName)}</div>
                <div style="font-size: 0.9rem; color: #3b82f6; margin-top: 4px;">
                    ${bunks.length} bunks: ${bunks.slice(0, 5).map(b => escapeHtml(b)).join(', ')}${bunks.length > 5 ? ` +${bunks.length - 5} more` : ''}
                </div>
                <div style="font-size: 0.9rem; color: #6b7280; margin-top: 4px;">Time: ${timeRange}</div>
            </div>

            <div style="display: grid; gap: 16px;">
                <div>
                    <label style="display: block; font-weight: 500; margin-bottom: 6px; color: #374151;">📍 Location/Field</label>
                    <select id="multi-edit-location" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px;">
                        <option value="">-- Select --</option>
                        ${allLocations.map(loc => `<option value="${loc.name}">${escapeHtml(loc.name)}</option>`).join('')}
                    </select>
                </div>

                <div>
                    <label style="display: block; font-weight: 500; margin-bottom: 6px; color: #374151;">🎪 Activity Name</label>
                    <input type="text" id="multi-edit-activity" placeholder="e.g., Carnival, Color War"
                        style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;">
                </div>

                <div id="multi-conflict-preview" style="display: none;"></div>

                <div id="multi-resolution-mode" style="display: none;">
                    <label style="display: block; font-weight: 500; margin-bottom: 8px; color: #374151;">⚙️ How to handle other schedulers' bunks?</label>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 12px; background: #f9fafb; border-radius: 8px; border: 2px solid #e5e7eb;">
                            <input type="radio" name="multi-mode" value="notify" checked style="margin-top: 3px;">
                            <div>
                                <div style="font-weight: 500; color: #374151;">📧 Notify & Request Approval</div>
                                <div style="font-size: 0.85rem; color: #6b7280;">Changes require approval first</div>
                            </div>
                        </label>
                        <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 12px; background: #f9fafb; border-radius: 8px; border: 2px solid #e5e7eb;">
                            <input type="radio" name="multi-mode" value="bypass" style="margin-top: 3px;">
                            <div>
                                <div style="font-weight: 500; color: #374151;">🔓 Bypass & Apply Now</div>
                                <div style="font-size: 0.85rem; color: #6b7280;">Changes apply immediately</div>
                            </div>
                        </label>
                    </div>
                </div>
            </div>

            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button onclick="previewMultiBunkEdit()" style="flex: 1; padding: 12px; background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; font-weight: 500; cursor: pointer;">👁️ Preview</button>
                <button id="multi-edit-submit" onclick="submitMultiBunkEdit()" style="flex: 1; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;" disabled>🎯 Apply</button>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('multi-edit-location')?.addEventListener('change', () => {
            document.getElementById('multi-edit-submit').disabled = true;
            document.getElementById('multi-conflict-preview').style.display = 'none';
        });
    }

    // --- PREVIEW & SUBMIT MULTI-BUNK EDIT ---

    function previewMultiBunkEdit() {
        const location = document.getElementById('multi-edit-location')?.value;
        const activity = document.getElementById('multi-edit-activity')?.value?.trim();
        const { bunks, slots, divName } = _multiBunkEditContext;

        if (!location) { alert('Please select a location'); return; }
        if (!activity) { alert('Please enter an activity name'); return; }

        const result = buildCascadeResolutionPlan(location, slots, divName, activity);
        _multiBunkPreviewResult = { ...result, location, slots, divName, activity, bunks };

        const previewArea = document.getElementById('multi-conflict-preview');
        const resolutionMode = document.getElementById('multi-resolution-mode');
        const submitBtn = document.getElementById('multi-edit-submit');

        if (result.plan.length === 0 && result.blocked.length === 0) {
            previewArea.style.display = 'block';
            previewArea.style.cssText = 'background: #d1fae5; border: 1px solid #10b981; border-radius: 8px; padding: 12px;';
            previewArea.innerHTML = `<div style="color: #065f46; font-weight: 500;">✅ No conflicts! Ready to assign.</div>`;
            resolutionMode.style.display = 'none';
            submitBtn.disabled = false;
        } else if (result.blocked.length > 0) {
            previewArea.style.display = 'block';
            previewArea.style.cssText = 'background: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; padding: 12px;';
            previewArea.innerHTML = `
                <div style="color: #991b1b; font-weight: 500;">❌ Cannot complete - pinned activities blocking:</div>
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
            
            let html = `<div style="color: #92400e; font-weight: 500;">⚠️ ${result.plan.length} bunk(s) will be reassigned</div><div style="margin-top: 12px; max-height: 180px; overflow-y: auto;">`;
            for (const [div, moves] of Object.entries(byDivision)) {
                const isOther = !myDivisions.has(div);
                html += `<div style="margin-bottom: 8px; padding: 8px; background: ${isOther ? '#fef2f2' : '#f0fdf4'}; border-radius: 6px;">
                    <div style="font-weight: 500; color: ${isOther ? '#991b1b' : '#166534'};">${isOther ? '🔒' : '✓'} ${escapeHtml(div)}</div>
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

    // --- AUTO-BACKUP SYSTEM ---

    async function createAutoBackup(activityName, divisionName) {
        if (!VersionManager?.saveVersion) {
            console.log('[AutoBackup] VersionManager not available, skipping backup');
            return { success: false, reason: 'VersionManager not available' };
        }

        const backupName = `${AUTO_BACKUP_PREFIX} ${activityName} (${divisionName})`;
        console.log(`[AutoBackup] ★ Creating restore point: ${backupName}`);

        try {
            const result = await VersionManager.saveVersion(backupName);
            
            if (result?.success) {
                console.log(`[AutoBackup] ✅ Backup created successfully`);
                
                // Trigger cleanup in background (don't await)
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

            // Filter to only auto-backups, sorted newest first (they come from DB that way)
            const autoBackups = versions.filter(v => 
                v.name && v.name.startsWith(AUTO_BACKUP_PREFIX)
            );

            if (autoBackups.length <= MAX_AUTO_BACKUPS_PER_DATE) {
                console.log(`[AutoBackup] ${autoBackups.length} auto-backups exist, within limit of ${MAX_AUTO_BACKUPS_PER_DATE}`);
                return { cleaned: 0 };
            }

            // Delete oldest ones (keep the first MAX_AUTO_BACKUPS_PER_DATE)
            const toDelete = autoBackups.slice(MAX_AUTO_BACKUPS_PER_DATE);
            let cleaned = 0;

            for (const old of toDelete) {
                try {
                    if (window.ScheduleVersionsDB.deleteVersion) {
                        await window.ScheduleVersionsDB.deleteVersion(old.id);
                        cleaned++;
                        console.log(`[AutoBackup] 🗑️ Deleted old backup: ${old.name}`);
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

    // --- APPLY MULTI-BUNK EDIT ---

    async function applyMultiBunkEdit(result, notifyAfter = false) {
        const { location, slots, divName, activity, bunks, plan } = result;

        // ★★★ AUTO-BACKUP BEFORE ANY CHANGES ★★★
        await createAutoBackup(activity, divName);

        // Assign to target bunks
        for (const bunk of bunks) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            for (let i = 0; i < slots.length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location, sport: null, _activity: activity,
                    _fixed: true, _pinned: true, _multiBunkEdit: true, continuation: i > 0
                };
            }
        }

        // Apply cascade reassignments
        const modifiedBunks = new Set(bunks);
        for (const move of plan) {
            modifiedBunks.add(move.bunk);
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = [];
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field, sport: move.to.activity,
                _activity: move.to.activity, _cascadeReassigned: true
            };
        }

        // Lock field
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'multi_bunk_edit', division: divName, activity, bunks
            });
        }

        // Save
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

        // Highlight
        if (plan.length > 0) enableBypassRBACView(plan.map(p => p.bunk));

        // Notify
        if (notifyAfter && plan.length > 0) {
            const myDivisions = new Set(getMyDivisions());
            const otherMoves = plan.filter(p => !myDivisions.has(p.division));
            if (otherMoves.length > 0) {
                await sendSchedulerNotification(otherMoves.map(p => p.bunk), location, activity, 'bypassed');
            }
        }

        // Re-render
        if (typeof renderStaggeredView === 'function') renderStaggeredView();
        showIntegratedToast(`✅ ${bunks.length} bunks assigned to ${location}` + (plan.length > 0 ? ` - ${plan.length} reassigned` : ''), 'success');
    }

    // --- CREATE PROPOSAL ---

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

        showIntegratedToast(`📧 Proposal sent to ${affectedDivisions.length} scheduler(s)`, 'info');
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
                (s.divisions || []).some(d => proposal.affected_divisions.includes(d))
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

    // --- PROPOSAL REVIEW & APPROVAL SYSTEM ---

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
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: white; border-radius: 12px; padding: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999;
            min-width: 500px; max-width: 600px; max-height: 80vh; overflow-y: auto;
        `;

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
                <div style="color: #6b7280; font-size: 0.9rem; margin-top: 4px;">
                    Date: ${proposal.date_key || 'Unknown'}
                </div>
            </div>

            <div style="margin-bottom: 16px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 8px;">Changes to your bunks:</div>
                <div style="background: ${myMoves.length > 0 ? '#fef3c7' : '#f0fdf4'}; border-radius: 8px; padding: 12px;">
                    ${myMoves.length === 0 ? 
                        '<div style="color: #166534;">✓ No direct changes to your bunks</div>' :
                        `<ul style="margin: 0; padding-left: 20px; color: #92400e;">
                            ${myMoves.map(m => `<li><strong>${escapeHtml(m.bunk)}</strong>: ${escapeHtml(m.from?.activity || '?')} → ${escapeHtml(m.to?.activity || '?')}</li>`).join('')}
                        </ul>`
                    }
                </div>
            </div>

            <div style="display: flex; gap: 12px;">
                <button onclick="respondToProposal('${proposal.id}', 'approved')" 
                    style="flex: 1; padding: 12px; background: #10b981; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;">
                    ✅ Approve
                </button>
                <button onclick="respondToProposal('${proposal.id}', 'rejected')" 
                    style="flex: 1; padding: 12px; background: #ef4444; color: white; border: none; border-radius: 8px; font-weight: 500; cursor: pointer;">
                    ❌ Reject
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
                response === 'approved' ? '✅ Proposal approved' : '❌ Proposal rejected',
                response === 'approved' ? 'success' : 'info'
            );

        } catch (e) {
            console.error('[RespondProposal] Error:', e);
            alert('Error responding to proposal');
        }
    }

    async function applyApprovedProposal(proposal) {
        console.log('[ApplyProposal] ★ All approvals received, applying...');

        const claim = proposal.claim || {};
        
        // ★★★ AUTO-BACKUP BEFORE APPLYING ★★★
        await createAutoBackup(claim.activity || 'Approved Proposal', claim.division || 'Unknown');

        const { field: location, slots, division: divName, activity, bunks } = claim;
        const plan = proposal.reassignments || [];

        // Assign to target bunks
        for (const bunk of (bunks || [])) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            for (let i = 0; i < (slots || []).length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location, sport: null, _activity: activity,
                    _fixed: true, _pinned: true, _fromProposal: true, continuation: i > 0
                };
            }
        }

        // Apply cascade
        const modifiedBunks = new Set(bunks || []);
        for (const move of plan) {
            modifiedBunks.add(move.bunk);
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = [];
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field, sport: move.to.activity,
                _activity: move.to.activity, _fromProposal: true
            };
        }

        // Lock & save
        if (window.GlobalFieldLocks && location && slots) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'approved_proposal', division: divName, activity, bunks
            });
        }

        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

        if (plan.length > 0) enableBypassRBACView(plan.map(p => p.bunk));

        // Mark applied
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (supabase) {
            await supabase
                .from('schedule_proposals')
                .update({ applied: true, applied_at: new Date().toISOString() })
                .eq('id', proposal.id);
        }

        if (typeof renderStaggeredView === 'function') renderStaggeredView();
        showIntegratedToast(`✅ Proposal applied: ${(bunks || []).length} bunks → ${location}`, 'success');
    }

    async function notifyProposerOfResponse(proposal, response, respondingDivisions) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase || !proposal.created_by) return;

        try {
            await supabase.from('notifications').insert({
                camp_id: proposal.camp_id,
                user_id: proposal.created_by,
                type: 'proposal_response',
                title: response === 'approved' ? '✅ Proposal Approved' : '❌ Proposal Rejected',
                message: `${respondingDivisions.join(', ')} ${response} your claim for ${proposal.claim?.field || 'field'}`,
                metadata: { proposal_id: proposal.id, response },
                read: false,
                created_at: new Date().toISOString()
            });
        } catch (e) { console.error('[NotifyProposer] Error:', e); }
    }

    // --- CLOSE MODAL & TOAST ---

    function closeIntegratedEditModal() {
        document.getElementById(INTEGRATED_EDIT_MODAL_ID)?.remove();
        document.getElementById(INTEGRATED_EDIT_OVERLAY_ID)?.remove();
        document.getElementById(CLAIM_MODAL_ID)?.remove();
        document.getElementById(CLAIM_OVERLAY_ID)?.remove();
        document.getElementById(PROPOSAL_MODAL_ID)?.remove();
        _currentEditContext = null;
    }

    function showIntegratedToast(message, type = 'info') {
        if (window.showToast) { window.showToast(message, type); return; }
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; bottom: 20px; right: 20px;
            background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
            color: white; padding: 12px 20px; border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2); z-index: 10000;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.updateTable = updateTable;
    window.renderStaggeredView = renderStaggeredView;
    window.initScheduleSystem = initScheduleSystem;
    window.saveSchedule = saveSchedule;
    window.loadScheduleForDate = loadScheduleForDate;
    window.reconcileOrRenderSaved = reconcileOrRenderSaved;
    window.editCell = editCell;
    window.enhancedEditCell = enhancedEditCell;
    window.findFirstSlotForTime = (min) => findSlotIndexForTime(min, window.unifiedTimes);
    window.findSlotsForRange = (start, end) => findSlotsForRange(start, end, window.unifiedTimes);
    window.parseTimeToMinutes = parseTimeToMinutes;
    window.minutesToTimeLabel = minutesToTimeLabel;
    window.getEntry = getEntry;
    window.formatEntry = formatEntry;
    window.getEditableBunks = getEditableBunks;
    window.canEditBunk = canEditBunk;
    window.checkLocationConflict = checkLocationConflict;
    window.getAllLocations = getAllLocations;
    window.smartRegenerateConflicts = smartRegenerateConflicts;
    window.smartReassignBunkActivity = smartReassignBunkActivity;
    window.findBestActivityForBunk = findBestActivityForBunk;
    window.buildFieldUsageBySlot = buildFieldUsageBySlot;
    window.buildCandidateOptions = buildCandidateOptions;
    window.calculateRotationPenalty = calculateRotationPenalty;
    window.isFieldAvailable = isFieldAvailable;
    window.getActivityProperties = getActivityProperties;
    window.applyPickToBunk = applyPickToBunk;
    window.bypassSaveAllBunks = bypassSaveAllBunks;
    window.sendSchedulerNotification = sendSchedulerNotification;
    window.getPinnedActivities = getPinnedActivities;
    window.unpinActivity = unpinActivity;
    window.unpinAllActivities = unpinAllActivities;
    window.preservePinnedForRegeneration = (allowedDivisions) => { capturePinnedActivities(allowedDivisions); registerPinnedFieldLocks(); };
    window.restorePinnedAfterRegeneration = () => { const count = restorePinnedActivities(); saveSchedule(); updateTable(); return count; };
    window.ScheduleVersionManager = VersionManager;
    window.ScheduleVersionMerger = { mergeAndPush: async (dateKey) => { window.currentScheduleDate = dateKey; return await VersionManager.mergeVersions(); } };
    window.SmartRegenSystem = { smartRegenerateConflicts, smartReassignBunkActivity, findBestActivityForBunk, buildFieldUsageBySlot, buildCandidateOptions, calculateRotationPenalty, isFieldAvailable, getActivityProperties, applyPickToBunk, ROTATION_CONFIG };
    window.PinnedActivitySystem = { capture: capturePinnedActivities, registerLocks: registerPinnedFieldLocks, registerUsage: registerPinnedFieldUsage, restore: restorePinnedActivities, getAll: getPinnedActivities, unpin: unpinActivity, unpinAll: unpinAllActivities, debug: () => ({ snapshot: _pinnedSnapshot, locks: _pinnedFieldLocks }) };
    
    // ★★★ RBAC BYPASS EXPORTS ★★★
    window.enableBypassRBACView = enableBypassRBACView;
    window.disableBypassRBACView = disableBypassRBACView;
    window.shouldShowDivision = shouldShowDivision;
    window.shouldHighlightBunk = shouldHighlightBunk;
    
    // ★★★ INTEGRATED EDIT EXPORTS (v4.0.3) ★★★
    window.openIntegratedEditModal = openIntegratedEditModal;
    window.closeIntegratedEditModal = closeIntegratedEditModal;
    window.openMultiBunkEditModal = openMultiBunkEditModal;
    window.previewMultiBunkEdit = previewMultiBunkEdit;
    window.submitMultiBunkEdit = submitMultiBunkEdit;
    window.proceedWithScope = proceedWithScope;
    window.applyMultiBunkEdit = applyMultiBunkEdit;
    window.buildCascadeResolutionPlan = buildCascadeResolutionPlan;
    window.findAllConflictsForClaim = findAllConflictsForClaim;
    window.findAlternativeForBunk = findAlternativeForBunk;
    window.createMultiBunkProposal = createMultiBunkProposal;
    window.loadProposal = loadProposal;
    window.loadMyPendingProposals = loadMyPendingProposals;
    window.openProposalReviewModal = openProposalReviewModal;
    window.respondToProposal = respondToProposal;
    window.applyApprovedProposal = applyApprovedProposal;
    window.createAutoBackup = createAutoBackup;
    window.cleanupOldAutoBackups = cleanupOldAutoBackups;
    window.listAutoBackups = listAutoBackups;
    window.getMyDivisions = getMyDivisions;
    window.getBunksForDivision = getBunksForDivision;
    window.showIntegratedToast = showIntegratedToast;

    window.UnifiedScheduleSystem = {
        version: '4.0.3',
        loadScheduleForDate, renderStaggeredView, findSlotIndexForTime, findSlotsForRange, getLeagueMatchups, getEntryForBlock,
        buildUnifiedTimesFromSkeleton, isSplitTileBlock, expandBlocksForSplitTiles, VersionManager,
        SmartRegenSystem: window.SmartRegenSystem, PinnedActivitySystem: window.PinnedActivitySystem, ROTATION_CONFIG,
        IntegratedEditSystem: {
            open: openIntegratedEditModal,
            close: closeIntegratedEditModal,
            openMulti: openMultiBunkEditModal,
            buildPlan: buildCascadeResolutionPlan,
            apply: applyMultiBunkEdit
        },
        ProposalSystem: {
            create: createMultiBunkProposal,
            load: loadProposal,
            loadPending: loadMyPendingProposals,
            openReview: openProposalReviewModal,
            respond: respondToProposal
        },
        AutoBackup: {
            create: createAutoBackup,
            cleanup: cleanupOldAutoBackups,
            list: listAutoBackups
        },
        DEBUG_ON: () => { DEBUG = true; console.log('[UnifiedSchedule] Debug enabled'); },
        DEBUG_OFF: () => { DEBUG = false; console.log('[UnifiedSchedule] Debug disabled'); },
        diagnose: () => { console.log('=== UNIFIED SCHEDULE SYSTEM v4.0.3 DIAGNOSTIC ==='); console.log(`Date: ${getDateKey()}`); console.log(`window.scheduleAssignments: ${Object.keys(window.scheduleAssignments || {}).length} bunks`); console.log(`window.unifiedTimes: ${(window.unifiedTimes || []).length} slots`); console.log(`Pinned activities: ${getPinnedActivities().length}`); console.log(`RBAC bypass view: ${_bypassRBACViewEnabled}`); console.log(`Highlighted bunks: ${[..._bypassHighlightBunks].join(', ') || 'none'}`); },
        getState: () => ({ dateKey: getDateKey(), assignments: Object.keys(window.scheduleAssignments || {}).length, leagues: Object.keys(window.leagueAssignments || {}).length, times: (window.unifiedTimes || []).length, cloudHydrated: _cloudHydrated, initialized: _initialized, pinnedCount: getPinnedActivities().length, postEditInProgress: !!window._postEditInProgress, bypassRBACViewEnabled: _bypassRBACViewEnabled, highlightedBunks: [..._bypassHighlightBunks] })
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initScheduleSystem);
    else setTimeout(initScheduleSystem, 100);

    console.log('📅 Unified Schedule System v4.0.3 loaded successfully');
    console.log('   ✅ v4.0.3: Integrated Edit with multi-bunk support');
    console.log('   ✅ v4.0.3: Cascade resolution with auto-backup');
    console.log('   ✅ v4.0.3: Proposal system for cross-division changes');

})();
