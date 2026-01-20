// =============================================================================
// unified_schedule_system.js v4.0.4 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
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
// ✅ v4.0.4: DIVISION TIMES SUPPORT in time mapping utilities
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v4.0.4 loading...');

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

    /**
     * Build unified times - NOW USES DIVISION TIMES SYSTEM
     * Returns a "virtual" unified times array for backwards compatibility
     */
    function buildUnifiedTimesFromSkeleton(skeleton) {
        if (!skeleton || skeleton.length === 0) return [];
        
        // ★★★ Use new DivisionTimesSystem if available ★★★
        if (window.DivisionTimesSystem) {
            const divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
            
            // Build division-specific times
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(skeleton, divisions);
            
            // Return virtual unified times for backwards compat
            return window.DivisionTimesSystem.buildUnifiedTimesFromDivisionTimes();
        }
        
        // Legacy fallback (should rarely be used)
        console.warn('[UnifiedSchedule] DivisionTimesSystem not loaded, using legacy 30-min grid');
        const INCREMENT_MINS = 30;
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

    /**
     * Find slots for a time range
     * @param {number} startMin - Start time in minutes
     * @param {number} endMin - End time in minutes
     * @param {Array|string} unifiedTimesOrDivision - Either unifiedTimes array OR division/bunk name
     */
    function findSlotsForRange(startMin, endMin, unifiedTimesOrDivision) {
        if (startMin === null || endMin === null) return [];
        
        // ★★★ NEW: Handle division name parameter ★★★
        if (typeof unifiedTimesOrDivision === 'string' && window.divisionTimes) {
            let divName = unifiedTimesOrDivision;
            
            // Check if it's a bunk name
            const divisions = window.divisions || {};
            for (const [dName, dData] of Object.entries(divisions)) {
                if (dData.bunks?.includes(unifiedTimesOrDivision)) {
                    divName = dName;
                    break;
                }
            }
            
            const divSlots = window.divisionTimes[divName] || [];
            const slots = [];
            for (let i = 0; i < divSlots.length; i++) {
                const slot = divSlots[i];
                if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                    slots.push(i);
                }
            }
            return slots;
        }
        
        // Legacy: Handle unifiedTimes array
        const unifiedTimes = Array.isArray(unifiedTimesOrDivision) ? unifiedTimesOrDivision : (window.unifiedTimes || []);
        if (unifiedTimes.length === 0) return [];
        
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

// ... continued in Part 2
