// =============================================================================
// unified_schedule_system.js v4.1.0 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
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
// ✅ v4.0.5: REFACTOR - Core utilities moved to Shared Utils
// ✅ v4.1.0: ★★★ FULL DIVISIONTIMES INTEGRATION ★★★
//            - Removed window.unifiedTimes dependency
//            - All slot lookups now use window.divisionTimes via SchedulerCoreUtils
//            - Time-based field usage is canonical conflict detection
//            - Data persistence uses divisionTimes directly
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v4.1.0 loading...');

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
    
    function findSlotsForRange(startMin, endMin, divisionOrBunk) {
        return Utils()?.findSlotsForRange?.(startMin, endMin, divisionOrBunk) || [];
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
    
    function canEditBunk(bunk) {
        return Utils()?.canEditBunk?.(bunk) ?? true;
    }
    
    function getEditableBunks() {
        return Utils()?.getEditableBunks?.() || new Set();
    }

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
            console.log('[UnifiedSchedule] 🛡️ Skipping loadScheduleForDate - post-edit in progress');
            return;
        }
        if (!dateKey) dateKey = getDateKey();
        debugLog(`Loading data for: ${dateKey}`);
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey] || {};
        
        // Load schedule assignments
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
        
        // Load league assignments
        if (!window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
            window.leagueAssignments = dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0 
                ? dateData.leagueAssignments : {};
        }
        
        // ★★★ v4.1.0: LOAD DIVISION TIMES (PRIMARY) ★★★
        const cloudLoaded = window._divisionTimesFromCloud === true;
        if (cloudLoaded && window.divisionTimes && Object.keys(window.divisionTimes).length > 0) {
            // Keep cloud data
            debugLog('Using divisionTimes from cloud');
        } else if (window.divisionTimes && Object.keys(window.divisionTimes).length > 0) {
            // Keep existing
            debugLog('Using existing divisionTimes');
        } else if (dateData.divisionTimes && Object.keys(dateData.divisionTimes).length > 0) {
            // Deserialize from storage
            window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(dateData.divisionTimes) || dateData.divisionTimes;
            debugLog('Loaded divisionTimes from storage');
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
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey || getDateKey()] || {};
        return dateData.manualSkeleton || dateData.skeleton || 
               window.dailyOverrideSkeleton || window.manualSkeleton || window.skeleton || [];
    }

    /**
     * Build division times from skeleton
     * ★★★ v4.1.0: This is the CANONICAL way to build time slots ★★★
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
                label: `${minutesToTimeLabel(parseTimeToMinutes(block.startTime))} - ${minutesToTimeLabel(parseTimeToMinutes(block.endTime))}`
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
     * ★★★ v4.1.0: DIVISION-AWARE slot finder ★★★
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
    // ★★★ v4.1.0: CANONICAL cross-division conflict detection ★★★
    
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
        
        checkAvailability: function(fieldName, startMin, endMin, capacity = 1, excludeBunk = null) {
            const usage = this.getUsageAtTime(fieldName, startMin, endMin, excludeBunk);
            
            // Find max concurrent usage
            let maxConcurrent = 0;
            const timePoints = new Set();
            usage.forEach(u => {
                timePoints.add(u.timeStart);
                timePoints.add(u.timeEnd);
            });
            
            for (const t of timePoints) {
                const concurrent = usage.filter(u => u.timeStart <= t && u.timeEnd > t).length;
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
        const divSlots = window.divisionTimes?.[divName] || [];
        
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

    function formatEntry(entry) {
        if (!entry) return '';
        if (entry._isDismissal) return 'Dismissal';
        if (entry._isSnack) return 'Snacks';
        if (entry._isTransition || entry.continuation) return '';
        const activity = entry._activity || '';
        const field = fieldLabel(entry.field);
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
// CONFLICT DETECTION (TIME-BASED - CROSS-DIVISION COMPATIBLE)
// =========================================================================
function checkLocationConflict(locationName, slots, excludeBunk) {
    const assignments = window.scheduleAssignments || {};
    const activityProps = getActivityProperties();
    const locationInfo = activityProps[locationName] || {};
    let maxCapacity = locationInfo.sharableWith?.capacity ? parseInt(locationInfo.sharableWith.capacity) || 1 : (locationInfo.sharable ? 2 : 1);
    const editBunks = getEditableBunks();
    const conflicts = [], usageBySlot = {};
    
    // ★★★ FIX: Get the ACTUAL time range from the editing bunk's division ★★★
    const excludeBunkDiv = getDivisionForBunk(excludeBunk);
    const excludeBunkSlots = window.divisionTimes?.[excludeBunkDiv] || [];
    
    // Build time ranges for the slots being claimed
    const claimedTimeRanges = [];
    for (const slotIdx of slots) {
        const slotInfo = excludeBunkSlots[slotIdx];
        if (slotInfo && slotInfo.startMin !== undefined && slotInfo.endMin !== undefined) {
            claimedTimeRanges.push({ slotIdx, startMin: slotInfo.startMin, endMin: slotInfo.endMin });
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
        // ★★★ NEW: Time-based conflict detection across ALL divisions ★★★
        const divisions = window.divisions || {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const divSlots = window.divisionTimes?.[divName] || [];
            const divBunks = divData.bunks || [];
            
            for (const bunkName of divBunks) {
                if (String(bunkName) === String(excludeBunk)) continue;
                
                const bunkAssignments = assignments[bunkName];
                if (!bunkAssignments) continue;
                
                // Check each slot in THIS bunk's division for time overlap
                for (let idx = 0; idx < divSlots.length; idx++) {
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
                    
                    // ★★★ KEY FIX: Check TIME OVERLAP, not slot index ★★★
                    const slotInfo = divSlots[idx];
                    if (!slotInfo || slotInfo.startMin === undefined) continue;
                    
                    for (const claimed of claimedTimeRanges) {
                        // Time overlap: NOT (end1 <= start2 OR start1 >= end2)
                        const hasOverlap = !(slotInfo.endMin <= claimed.startMin || slotInfo.startMin >= claimed.endMin);
                        
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
                                    overlapStart: Math.max(slotInfo.startMin, claimed.startMin),
                                    overlapEnd: Math.min(slotInfo.endMin, claimed.endMin)
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Check GlobalFieldLocks
    let globalLock = null;
    if (window.GlobalFieldLocks) {
        const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, excludeBunkDiv);
        if (lockInfo) globalLock = lockInfo;
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

    function isFieldAvailable(fName, slots, bunk, fieldUsageBySlot, activityProps) {
        const divName = getDivisionForBunk(bunk);
        if (!divName || slots.length === 0) return false;
        
        // Get time range for these slots
        const divSlots = window.divisionTimes?.[divName] || [];
        if (slots[0] >= divSlots.length) return false;
        
        const startMin = divSlots[slots[0]]?.startMin;
        const endMin = divSlots[slots[slots.length - 1]]?.endMin;
        
        if (startMin === undefined || endMin === undefined) return false;
        
        // Use time-based availability check
        const props = activityProps[fName] || {};
        const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);
        
        const availability = window.TimeBasedFieldUsage.checkAvailability(
            fName, startMin, endMin, maxCapacity, bunk
        );
        
        return availability.available;
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
        const maxUsage = props.maxUsage || 0;
        if (maxUsage > 0) {
            const hist = getActivityCount(bunk, activityName);
            if (hist >= maxUsage) return Infinity;
            if (hist >= maxUsage - 1) penalty += 2000;
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
    
    // ★ Capture the actual TIME RANGE being claimed ★
    let claimedStartMin = null, claimedEndMin = null;
    if (slots.length > 0 && editingDivSlots[slots[0]]) {
        claimedStartMin = editingDivSlots[slots[0]].startMin;
        claimedEndMin = editingDivSlots[slots[slots.length - 1]].endMin;
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
        console.log('[resolveConflictsAndApply] 🔓 BYPASS MODE - including non-editable conflicts');
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
            
            window._postEditInProgress = true;
            window._postEditTimestamp = Date.now();
            
            await bypassSaveAllBunks(modifiedBunks);
            
            const reassignedBunks = result.reassigned.map(r => r.bunk);
            if (reassignedBunks.length > 0) {
                enableBypassRBACView(reassignedBunks);
            }
            
            if (nonEditableConflicts.length > 0) {
                sendSchedulerNotification(
                    [...new Set(nonEditableConflicts.map(c => c.bunk))], 
                    location, activity, 'bypassed'
                );
                if (window.showToast) {
                    window.showToast(`🔓 Bypassed ${nonEditableConflicts.length} bunk(s) from other schedulers`, 'warning');
                }
            }
        }
    }
    
    return result;
}


// =========================================================================
// SMART REGENERATION FOR CONFLICTS (CROSS-DIVISION COMPATIBLE)
// =========================================================================
function smartRegenerateConflicts(pinnedBunk, pinnedSlots, pinnedField, pinnedActivity, conflicts, bypassMode = false, timeContext = {}) {
    console.log('[SmartRegen] ★★★ SMART REGENERATION STARTED ★★★');
    console.log(`[SmartRegen] Pinned: ${pinnedBunk} claiming ${pinnedField}`);
    if (bypassMode) console.log('[SmartRegen] 🔓 BYPASS MODE ACTIVE');
    
    const { claimedStartMin, claimedEndMin, claimingDivision } = timeContext;
    const activityProperties = window.getActivityProperties();
    const results = { success: true, reassigned: [], failed: [], pinnedLock: null, bypassMode };
    
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
        
        // ★ Find the CORRECT slot indices for THIS bunk's division ★
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
            console.warn(`[SmartRegen] ⚠️ No time info for ${bunk}, using raw slots`);
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
            console.log(`[SmartRegen] ✅ ${bunk}: ${originalActivity} → ${bestPick.activityName} @ ${bestPick.field}`);
            
            applyPickToBunkDivisionAware(bunk, actualSlots, conflictDiv, bestPick, fieldUsageBySlot, activityProperties);
            
            results.reassigned.push({ 
                bunk, slots: actualSlots, division: conflictDiv,
                from: originalActivity || 'unknown', 
                to: bestPick.activityName, 
                field: bestPick.field, 
                cost: bestPick.cost 
            });
            
            if (window.showToast) {
                window.showToast(`↪️ ${bunk}: ${originalActivity} → ${bestPick.activityName}`, 'info');
            }
        } else {
            console.log(`[SmartRegen] ❌ ${bunk}: No alternative found`);
            
            if (!window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = new Array(conflictDivSlots.length || 50);
            }
            
            actualSlots.forEach((slotIdx, i) => {
                window.scheduleAssignments[bunk][slotIdx] = {
                    field: 'Free', sport: null, continuation: i > 0,
                    _fixed: false, _activity: 'Free',
                    _smartRegenFailed: true, _originalActivity: originalActivity, _failedAt: Date.now()
                };
            });
            
            results.failed.push({ 
                bunk, slots: actualSlots, division: conflictDiv,
                originalActivity, reason: 'No valid alternative found' 
            });
            results.success = false;
            
            if (window.showToast) {
                window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
            }
        }
    }
    
    console.log(`[SmartRegen] ★★★ COMPLETE: ${results.reassigned.length} reassigned, ${results.failed.length} failed ★★★`);
    return results;
}


// =========================================================================
// HELPER: Find Best Activity (DIVISION-AWARE)
// =========================================================================
function findBestActivityForBunkDivisionAware(bunk, slots, divName, fieldUsageBySlot, activityProperties, avoidFields = []) {
    const disabledFields = window.currentDisabledFields || [];
    const avoidSet = new Set(avoidFields.map(f => (f || '').toLowerCase()));
    
    // Get time range for these slots
    const divSlots = window.divisionTimes?.[divName] || [];
    let startMin = null, endMin = null;
    
    if (slots.length > 0 && divSlots[slots[0]]) {
        startMin = divSlots[slots[0]].startMin;
        endMin = divSlots[slots[slots.length - 1]]?.endMin || (startMin + 30);
    }
    
    const candidates = buildCandidateOptions(slots, activityProperties, disabledFields);
    const scoredPicks = [];
    
    for (const cand of candidates) {
        const fieldLower = (cand.field || '').toLowerCase();
        const actLower = (cand.activityName || '').toLowerCase();
        
        if (avoidSet.has(fieldLower) || avoidSet.has(actLower)) continue;
        
        // Check field availability by TIME
        if (!checkFieldAvailableByTime(cand.field, startMin, endMin, bunk, activityProperties)) continue;
        
        // Also check slot-based for backwards compat
        if (!isFieldAvailable(cand.field, slots, bunk, fieldUsageBySlot, activityProperties)) continue;
        
        const cost = calculatePenaltyCost(bunk, slots, cand, fieldUsageBySlot, activityProperties);
        if (cost < Infinity) {
            scoredPicks.push({ ...cand, cost });
        }
    }
    
    scoredPicks.sort((a, b) => a.cost - b.cost);
    return scoredPicks.length > 0 ? scoredPicks[0] : null;
}


// =========================================================================
// HELPER: Check Field Available By Time (CROSS-DIVISION SAFE)
// =========================================================================
function checkFieldAvailableByTime(fieldName, startMin, endMin, excludeBunk, activityProperties) {
    if (startMin === null || endMin === null) return true;
    
    const props = activityProperties?.[fieldName] || {};
    let maxCapacity = props.sharableWith?.capacity ? parseInt(props.sharableWith.capacity) || 1 : (props.sharable ? 2 : 1);
    
    // Use TimeBasedFieldUsage if available
    if (window.TimeBasedFieldUsage?.checkAvailability) {
        const result = window.TimeBasedFieldUsage.checkAvailability(fieldName, startMin, endMin, maxCapacity, excludeBunk);
        return result.available;
    }
    
    // Fallback: manual check across all divisions
    const divisions = window.divisions || {};
    let usageCount = 0;
    
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
                        usageCount++;
                        if (usageCount >= maxCapacity) return false;
                    }
                }
            }
        }
    }
    
    return true;
}


// =========================================================================
// HELPER: Apply Pick To Bunk (DIVISION-AWARE)
// =========================================================================
function applyPickToBunkDivisionAware(bunk, slots, divName, pick, fieldUsageBySlot, activityProperties) {
    const divSlots = window.divisionTimes?.[divName] || [];
    
    let startMin = null, endMin = null;
    if (slots.length > 0 && divSlots[slots[0]]) {
        startMin = divSlots[slots[0]].startMin;
        const lastSlot = divSlots[slots[slots.length - 1]];
        endMin = lastSlot ? lastSlot.endMin : (startMin + 30);
    }
    
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
        _division: divName
    };
    
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    if (!window.scheduleAssignments[bunk]) {
        window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
    }
    
    slots.forEach((slotIdx, i) => {
        window.scheduleAssignments[bunk][slotIdx] = { ...pickData, continuation: i > 0 };
    });
    
    // Update field usage
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
    
    // Register with TimeBasedFieldUsage if available
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
            applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProps);
            if (window.showToast) window.showToast(`↪️ ${bunk}: Moved to ${bestPick.activityName}`, 'info');
            return { success: true, field: bestPick.field, activity: bestPick.activityName, cost: bestPick.cost };
        } else {
            const divName = getDivisionForBunk(bunk);
            const divSlots = window.divisionTimes?.[divName] || [];
            if (!window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
            }
            slots.forEach((slotIdx, i) => {
                window.scheduleAssignments[bunk][slotIdx] = { 
                    field: 'Free', sport: null, continuation: i > 0, _fixed: false, _activity: 'Free', 
                    _noAlternative: true, _originalActivity: originalActivity, _originalField: avoidLocation 
                };
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
        console.log(`[PinnedPreserve] 📌 Captured ${capturedCount} pinned activities`);
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
    // MAIN RENDER FUNCTION
    // =========================================================================

    function renderStaggeredView(container) {
        if (!container) { container = document.getElementById('scheduleTable'); if (!container) return; }
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        if (!window._postEditInProgress) loadScheduleForDate(dateKey);
        else console.log('[UnifiedSchedule] 🛡️ RENDER: Using in-memory data (post-edit in progress)');
        
        const skeleton = getSkeleton(dateKey);
        const divisions = window.divisions || {};
        
        console.log('[UnifiedSchedule] RENDER STATE:', { 
            dateKey, 
            skeletonBlocks: skeleton.length, 
            divisionTimesCount: Object.keys(window.divisionTimes || {}).length,
            scheduleAssignmentsBunks: Object.keys(window.scheduleAssignments || {}).length, 
            divisionsCount: Object.keys(divisions).length,
            bypassRBACView: _bypassRBACViewEnabled || window._bypassRBACViewEnabled 
        });
        
        container.innerHTML = '';
        if (!skeleton || skeleton.length === 0) {
            container.innerHTML = `<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No daily schedule structure found for this date.</p><p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p></div>`;
            return;
        }
        
        let divisionsToShow = Object.keys(divisions);
        if (divisionsToShow.length === 0 && window.availableDivisions) divisionsToShow = window.availableDivisions;
        divisionsToShow.sort((a, b) => { 
            const numA = parseInt(a), numB = parseInt(b); 
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB; 
            return String(a).localeCompare(String(b)); 
        });
        
        if (divisionsToShow.length === 0) { 
            container.innerHTML = `<div style="padding: 40px; text-align: center; color: #6b7280;"><p>No divisions configured.</p></div>`; 
            return; 
        }
        
        const wrapper = document.createElement('div');
        wrapper.className = 'schedule-view-wrapper';
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 24px;';
        
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || divisionsToShow;
        
        divisionsToShow.forEach(divName => {
            if (!shouldShowDivision(divName)) return;
            const divInfo = divisions[divName];
            if (!divInfo) return;
            let bunks = divInfo.bunks || [];
            if (bunks.length === 0) return;
            bunks = bunks.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
            const isEditable = editableDivisions.includes(divName);
            const table = renderDivisionTable(divName, divInfo, bunks, skeleton, isEditable);
            if (table) wrapper.appendChild(table);
        });
        
        container.appendChild(wrapper);
        if (window.MultiSchedulerAutonomous?.applyBlockingToGrid) setTimeout(() => window.MultiSchedulerAutonomous.applyBlockingToGrid(), 50);
        window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', { detail: { dateKey } }));
    }

    function renderDivisionTable(divName, divInfo, bunks, skeleton, isEditable) {
        // ★★★ v4.1.0: Use divisionTimes directly ★★★
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
                _isSplitTile: !!slot._splitHalf
            }));
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
        th.innerHTML = escapeHtml(divName) + (isEditable ? '' : ' <span style="opacity:0.7">🔒</span>');
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
        divBlocks.forEach((block, blockIdx) => {
            const timeLabel = `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`;
            const tr = document.createElement('tr');
            tr.style.background = blockIdx % 2 === 0 ? '#fff' : '#fafafa';
            if (block._isSplitTile) tr.style.background = block._splitHalf === 1 ? (blockIdx % 2 === 0 ? '#f0fdf4' : '#ecfdf5') : (blockIdx % 2 === 0 ? '#fef3c7' : '#fef9c3');
            
            const tdTime = document.createElement('td'); 
            tdTime.textContent = timeLabel;
            tdTime.style.cssText = 'padding: 10px 12px; font-weight: 500; color: #4b5563; border-right: 1px solid #e5e7eb; white-space: nowrap;';
            if (block._isSplitTile) { 
                const halfLabel = block._splitHalf === 1 ? '①' : '②'; 
                tdTime.innerHTML = `${escapeHtml(timeLabel)} <span style="color: #6b7280; font-size: 0.8rem;">${halfLabel}</span>`; 
            }
            tr.appendChild(tdTime);
            
            if (isLeagueBlockType(block.event)) { 
                tr.appendChild(renderLeagueCell(block, bunks, divName, isEditable)); 
                tbody.appendChild(tr); 
                return; 
            }
            
            bunks.forEach(bunk => tr.appendChild(renderBunkCell(block, bunk, divName, isEditable)));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
    }

    function renderLeagueCell(block, bunks, divName, isEditable) {
        const td = document.createElement('td');
        td.colSpan = bunks.length;
        td.style.cssText = 'padding: 12px 16px; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border-left: 4px solid #0284c7; vertical-align: top;';
        
        // ★★★ v4.1.0: Use division-specific slot lookup ★★★
        const slotIdx = block.slotIndex !== undefined ? block.slotIndex : findFirstSlotForTime(block.startMin, divName);
        let leagueInfo = getLeagueMatchups(divName, slotIdx);
        
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

    function renderBunkCell(block, bunk, divName, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        
        // ★★★ v4.1.0: Use division-specific slot index ★★★
        const slotIdx = block.slotIndex !== undefined ? block.slotIndex : findFirstSlotForTime(block.startMin, divName);
        const entry = getEntry(bunk, slotIdx);
        
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
            td.onclick = () => {
                const existingEntry = window.scheduleAssignments?.[bunk]?.[slotIdx];
                if (typeof openIntegratedEditModal === 'function') {
                    openIntegratedEditModal(bunk, slotIdx, existingEntry);
                } else {
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
        const divName = getDivisionForBunk(bunk);
        const divSlots = window.divisionTimes?.[divName] || [];
        
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
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
            // ★★★ v4.1.0: Save divisionTimes (serialized) ★★★
            const serialized = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes;
            window.saveCurrentDailyData('divisionTimes', serialized, { silent });
        }
    }

    function updateTable() {
        const now = Date.now();
        if (window._postEditInProgress) {
            _lastRenderTime = now; 
            _renderQueued = false; 
            if (_renderTimeout) { clearTimeout(_renderTimeout); _renderTimeout = null; }
            const container = document.getElementById('scheduleTable');
            if (container) renderStaggeredView(container);
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
                    if (container) renderStaggeredView(container); 
                }, RENDER_DEBOUNCE_MS); 
            }
            return;
        }
        _lastRenderTime = now;
        const container = document.getElementById('scheduleTable');
        if (container) renderStaggeredView(container);
    }

    // =========================================================================
    // UTILITY: ESCAPE HTML
    // =========================================================================
    
    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // =========================================================================
    // BYPASS SAVE - CROSS-DIVISION DIRECT UPDATE
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
            allDailyData[dateKey].divisionTimes = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes;
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
                return await fallbackBypassSave(dateKey, modifiedBunks);
            }
            
            console.log(`[UnifiedSchedule] 🔓 Found ${allRecords?.length || 0} scheduler records`);
            
            if (!allRecords || allRecords.length === 0) {
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
            
            console.log(`[UnifiedSchedule] 🔓 Updates needed:`, 
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
                    console.error(`[UnifiedSchedule] ❌ Failed to update ${record.scheduler_name || 'unknown'}:`, updateError);
                    failCount++;
                } else {
                    console.log(`[UnifiedSchedule] ✅ Updated ${record.scheduler_name || 'unknown'} with bunks: ${bunksToUpdate.join(', ')}`);
                    successCount++;
                    updatedSchedulers.push(record.scheduler_name || record.scheduler_id);
                }
            }
            
            // Step 7: Handle orphan bunks
            if (orphanBunks.length > 0) {
                console.log(`[UnifiedSchedule] 🔓 Saving orphan bunks via standard method...`);
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
                    `🔓 Cross-division bypass: ${modifiedBunks.length} bunk(s) in Div ${[...divisionNames].join(', ')}${schedulerInfo}`, 
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
        console.log('[UnifiedSchedule] 🔓 Using fallback bypass save (skipFilter)');
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
                `🔓 Bypass saved: ${modifiedBunks.length} bunk(s)${[...divisionNames].length ? ` in Div ${[...divisionNames].join(', ')}` : ''} - synced`, 
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
        const slots = findSlotsForRange(startMin, endMin, divName);
        
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
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        if (!campId) return;
        try {
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            for (const bunk of affectedBunks) { 
                for (const [divName, divData] of Object.entries(divisions)) { 
                    if (divData.bunks?.some(b => String(b) === String(bunk))) affectedDivisions.add(divName); 
                } 
            }
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
    // APPLY EDIT
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const divName = getDivisionForBunk(bunk);
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = findSlotsForRange(startMin, endMin, divName);
        if (slots.length === 0) { alert('Error: Could not find time slots.'); return; }
        window._postEditInProgress = true; 
        window._postEditTimestamp = Date.now();
        const divSlots = window.divisionTimes?.[divName] || [];
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
        if (hasConflict) await resolveConflictsAndApply(bunk, slots, activity, location, editData);
        else applyDirectEdit(bunk, slots, activity, location, isClear, true);
        const currentDate = window.currentScheduleDate || window.currentDate || document.getElementById('datePicker')?.value || new Date().toISOString().split('T')[0];
        try {
            localStorage.setItem(`scheduleAssignments_${currentDate}`, JSON.stringify(window.scheduleAssignments));
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].divisionTimes = window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes;
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) { console.error('[UnifiedSchedule] Failed to save to localStorage:', e); }
        setTimeout(() => { window._postEditInProgress = false; }, 8000);
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', { detail: { bunk, slots, activity, location, date: currentDate } }));
        saveSchedule(); 
        updateTable();
        setTimeout(() => updateTable(), 300);
    }

    // =========================================================================
    // MODAL UI (LEGACY / DIRECT EDIT)
    // =========================================================================

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const divName = getDivisionForBunk(bunk);
        let currentActivity = currentValue || '', currentField = '', resolutionChoice = 'notify';
        const slots = findSlotsForRange(startMin, endMin, divName);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) { 
                currentField = fieldLabel(entry.field); 
                currentActivity = entry._activity || currentField || currentValue; 
            }
        }
        modal.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;"><h2 style="margin: 0; font-size: 1.25rem; color: #1f2937;">Edit Schedule Cell</h2><button id="post-edit-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #9ca3af;">&times;</button></div><div style="background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px;"><div style="font-weight: 600; color: #374151;">${escapeHtml(bunk)}</div><div style="font-size: 0.875rem; color: #6b7280;" id="post-edit-time-display">${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}</div></div><div style="display: flex; flex-direction: column; gap: 16px;"><div><label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">Activity Name</label><input type="text" id="post-edit-activity" value="${escapeHtml(currentActivity)}" placeholder="e.g., Basketball" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;"><div style="font-size: 0.75rem; color: #9ca3af; margin-top: 4px;">Enter CLEAR or FREE to empty</div></div><div><label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">Location / Field</label><select id="post-edit-location" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box; background: white;"><option value="">-- No specific location --</option><optgroup label="Fields">${locations.filter(l => l.type === 'field').map(l => `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}${l.capacity > 1 ? ` (capacity: ${l.capacity})` : ''}</option>`).join('')}</optgroup><optgroup label="Special Activities">${locations.filter(l => l.type === 'special').map(l => `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}</option>`).join('')}</optgroup></select></div><div id="post-edit-conflict" style="display: none;"></div><div style="display: flex; gap: 12px; margin-top: 8px;"><button id="post-edit-cancel" style="flex: 1; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: white; color: #374151; font-size: 1rem; cursor: pointer; font-weight: 500;">Cancel</button><button id="post-edit-save" style="flex: 1; padding: 12px; border: none; border-radius: 8px; background: #2563eb; color: white; font-size: 1rem; cursor: pointer; font-weight: 500;">Save Changes</button></div></div>`;
        
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            if (!location) { conflictArea.style.display = 'none'; return null; }
            const targetSlots = findSlotsForRange(startMin, endMin, divName);
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            if (conflictCheck.hasConflict) {
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                conflictArea.style.display = 'block';
                let html = `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;"><div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><span style="font-size: 1.25rem;">⚠️</span><strong style="color: #92400e;">Location Conflict Detected</strong></div><p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;"><strong>${escapeHtml(location)}</strong> is already in use:</p>`;
                if (editableBunks.length > 0) html += `<div style="margin-bottom: 8px; padding: 8px; background: #d1fae5; border-radius: 6px;"><div style="font-size: 0.8rem; color: #065f46;"><strong>✓ Can auto-reassign:</strong> ${editableBunks.join(', ')}</div></div>`;
                if (nonEditableBunks.length > 0) html += `<div style="margin-bottom: 8px; padding: 8px; background: #fee2e2; border-radius: 6px;"><div style="font-size: 0.8rem; color: #991b1b;"><strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.join(', ')}</div></div><div style="margin-top: 12px;"><div style="font-weight: 500; color: #374151; margin-bottom: 8px; font-size: 0.875rem;">How to handle their bunks?</div><div style="display: flex; flex-direction: column; gap: 8px;"><label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;"><input type="radio" name="conflict-resolution" value="notify" checked style="margin-top: 2px;"><div><div style="font-weight: 500; color: #374151;">📧 Notify other scheduler</div><div style="font-size: 0.75rem; color: #6b7280;">Create double-booking & send them a warning</div></div></label><label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;"><input type="radio" name="conflict-resolution" value="bypass" style="margin-top: 2px;"><div><div style="font-weight: 500; color: #374151;">🔓 Bypass & reassign (Admin mode)</div><div style="font-size: 0.75rem; color: #6b7280;">Override permissions and use smart regeneration</div></div></label></div></div>`;
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
        
        locationSelect.addEventListener('change', checkAndShowConflicts);
        checkAndShowConflicts();
        
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            if (!activity) { alert('Please enter an activity name.'); return; }
            const targetSlots = findSlotsForRange(startMin, endMin, divName);
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            if (conflictCheck?.hasConflict) {
                onSave({ 
                    activity, location, startMin, endMin, hasConflict: true, 
                    conflicts: conflictCheck.conflicts, 
                    editableConflicts: conflictCheck.editableConflicts || [], 
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [], 
                    resolutionChoice 
                });
            } else {
                onSave({ activity, location, startMin, endMin, hasConflict: false, conflicts: [] });
            }
            closeModal();
        };
        document.getElementById('post-edit-activity').focus(); 
        document.getElementById('post-edit-activity').select();
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

    function buildCascadeResolutionPlan(fieldName, slots, claimingDivision, claimingActivity) {
        console.log('[CascadeClaim] ★★★ BUILDING RESOLUTION PLAN ★★★');
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

    function findAlternativeForBunk(bunk, slots, divName, simulatedUsage, excludeFields = []) {
        const activityProps = getActivityProperties();
        const excludeSet = new Set(excludeFields.map(f => fieldLabel(f)));
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fieldsBySport = settings.fieldsBySport || {};
        const disabledFields = window.currentDisabledFields || [];

        const candidates = [];
        
        for (const [sport, sportFields] of Object.entries(fieldsBySport)) {
            (sportFields || []).forEach(fName => {
                if (excludeSet.has(fName)) return;
                if (disabledFields.includes(fName)) return;
                if (window.GlobalFieldLocks?.isFieldLocked(fName, slots, divName)) return;

                let available = true;
                const props = activityProps[fName] || {};
                const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);

                for (const slotIdx of slots) {
                    const usage = simulatedUsage[slotIdx]?.[fName];
                    if (usage && usage.count >= maxCapacity) { available = false; break; }
                }

                if (available) {
                    const penalty = calculateRotationPenalty(bunk, sport, slots);
                    if (penalty !== Infinity) {
                        candidates.push({ field: fName, activityName: sport, type: 'sport', penalty });
                    }
                }
            });
        }

        (app1.specialActivities || []).forEach(special => {
            if (!special.name) return;
            if (excludeSet.has(special.name)) return;
            if (disabledFields.includes(special.name)) return;
            if (window.GlobalFieldLocks?.isFieldLocked(special.name, slots, divName)) return;

            let available = true;
            const props = activityProps[special.name] || {};
            const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);

            for (const slotIdx of slots) {
                const usage = simulatedUsage[slotIdx]?.[special.name];
                if (usage && usage.count >= maxCapacity) { available = false; break; }
            }

            if (available) {
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
            if (window.GlobalFieldLocks?.isFieldLocked(field.name, slots, divName)) return;

            let available = true;
            const props = activityProps[field.name] || {};
            const maxCapacity = props.sharableWith?.capacity || (props.sharable ? 2 : 1);

            for (const slotIdx of slots) {
                const usage = simulatedUsage[slotIdx]?.[field.name];
                if (usage && usage.count >= maxCapacity) { available = false; break; }
            }

            if (available) {
                (field.activities || []).forEach(activity => {
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
        const times = window.divisionTimes?.[divName] || [];
        const slotInfo = times[slotIdx] || {};
        const timeLabel = slotInfo.label || `${minutesToTimeStr(slotInfo.startMin)} - ${minutesToTimeStr(slotInfo.endMin)}`;

        _currentEditContext = { bunk, slotIdx, divName, bunksInDivision, existingEntry, slotInfo };

        showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEditBunk(bunk));
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
                            ${divSlots.map((t, i) => `<option value="${i}" ${i === slotIdx ? 'selected' : ''}>${t.label || minutesToTimeStr(t.startMin)}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 0.85rem; color: #6b7280;">End</label>
                        <select id="edit-end-slot" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; margin-top: 4px;">
                            ${divSlots.map((t, i) => `<option value="${i}" ${i === slotIdx ? 'selected' : ''}>${t.label || minutesToTimeStr(t.endMin)}</option>`).join('')}
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
        const ctx = _currentEditContext;
        if (!ctx) {
            alert('Edit context lost. Please try again.');
            closeIntegratedEditModal();
            return;
        }
        
        if (scope === 'single') {
            closeIntegratedEditModal();
            showEditModal(
                ctx.bunk,
                ctx.slotInfo?.startMin,
                ctx.slotInfo?.endMin,
                ctx.existingEntry?._activity || '',
                (editData) => applyEdit(ctx.bunk, editData)
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
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999; min-width: 500px; max-width: 620px; max-height: 85vh; overflow-y: auto;`;
        modal.onclick = e => e.stopPropagation();

        const times = window.divisionTimes?.[divName] || [];
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

    // =========================================================================
    // AUTO-BACKUP SYSTEM
    // =========================================================================

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

    // =========================================================================
    // APPLY MULTI-BUNK EDIT
    // =========================================================================

    async function applyMultiBunkEdit(result, notifyAfter = false) {
        const { location, slots, divName, activity, bunks, plan } = result;

        await createAutoBackup(activity, divName);

        const divSlots = window.divisionTimes?.[divName] || [];
        
        for (const bunk of bunks) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
            for (let i = 0; i < slots.length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location, sport: null, _activity: activity,
                    _fixed: true, _pinned: true, _multiBunkEdit: true, continuation: i > 0
                };
            }
        }

        const modifiedBunks = new Set(bunks);
        for (const move of plan) {
            modifiedBunks.add(move.bunk);
            const moveDivName = getDivisionForBunk(move.bunk);
            const moveDivSlots = window.divisionTimes?.[moveDivName] || [];
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = new Array(moveDivSlots.length || 50);
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field, sport: move.to.activity,
                _activity: move.to.activity, _cascadeReassigned: true
            };
        }

        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'multi_bunk_edit', division: divName, activity, bunks
            });
        }

        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

        if (plan.length > 0) enableBypassRBACView(plan.map(p => p.bunk));

        if (notifyAfter && plan.length > 0) {
            const myDivisions = new Set(getMyDivisions());
            const otherMoves = plan.filter(p => !myDivisions.has(p.division));
            if (otherMoves.length > 0) {
                await sendSchedulerNotification(otherMoves.map(p => p.bunk), location, activity, 'bypassed');
            }
        }

        if (typeof renderStaggeredView === 'function') renderStaggeredView();
        showIntegratedToast(`✅ ${bunks.length} bunks assigned to ${location}` + (plan.length > 0 ? ` - ${plan.length} reassigned` : ''), 'success');
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
        
        await createAutoBackup(claim.activity || 'Approved Proposal', claim.division || 'Unknown');

        const { field: location, slots, division: divName, activity, bunks } = claim;
        const plan = proposal.reassignments || [];

        const divSlots = window.divisionTimes?.[divName] || [];
        
        for (const bunk of (bunks || [])) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = new Array(divSlots.length || 50);
            for (let i = 0; i < (slots || []).length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location, sport: null, _activity: activity,
                    _fixed: true, _pinned: true, _fromProposal: true, continuation: i > 0
                };
            }
        }

        const modifiedBunks = new Set(bunks || []);
        for (const move of plan) {
            modifiedBunks.add(move.bunk);
            const moveDivName = getDivisionForBunk(move.bunk);
            const moveDivSlots = window.divisionTimes?.[moveDivName] || [];
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = new Array(moveDivSlots.length || 50);
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field, sport: move.to.activity,
                _activity: move.to.activity, _fromProposal: true
            };
        }

        if (window.GlobalFieldLocks && location && slots) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'approved_proposal', division: divName, activity, bunks
            });
        }

        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        if (typeof bypassSaveAllBunks === 'function') await bypassSaveAllBunks([...modifiedBunks]);

        if (plan.length > 0) enableBypassRBACView(plan.map(p => p.bunk));

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
        toast.style.cssText = `position: fixed; bottom: 20px; right: 20px; background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'}; color: white; padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); z-index: 10000;`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // =========================================================================
    // VERSION MANAGEMENT
    // =========================================================================
    
    const VersionManager = {
        async saveVersion(name) {
            const dateKey = getDateKey();
            if (!dateKey) { alert('Please select a date first.'); return { success: false }; }
            if (!name) { name = prompt('Enter a name for this version:'); if (!name) return { success: false }; }
            const dailyData = loadDailyData(); 
            const dateData = dailyData[dateKey] || {};
            const payload = { 
                scheduleAssignments: window.scheduleAssignments || dateData.scheduleAssignments || {}, 
                leagueAssignments: window.leagueAssignments || dateData.leagueAssignments || {}, 
                divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes || {}
            };
            if (Object.keys(payload.scheduleAssignments).length === 0) { alert('No schedule data to save.'); return { success: false }; }
            if (!window.ScheduleVersionsDB) { alert('Version database not available.'); return { success: false }; }
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                const existing = versions.find(v => v.name.toLowerCase() === name.toLowerCase());
                if (existing) { 
                    if (!confirm(`Version "${existing.name}" already exists. Overwrite?`)) return { success: false }; 
                    if (window.ScheduleVersionsDB.updateVersion) { 
                        const result = await window.ScheduleVersionsDB.updateVersion(existing.id, payload); 
                        if (result.success) { alert('✅ Version updated!'); return { success: true }; } 
                        else { alert('❌ Error: ' + result.error); return { success: false }; } 
                    } 
                }
                const result = await window.ScheduleVersionsDB.createVersion(dateKey, name, payload);
                if (result.success) { alert('✅ Version saved!'); return { success: true }; } 
                else { alert('❌ Error: ' + result.error); return { success: false }; }
            } catch (err) { alert('Error: ' + err.message); return { success: false }; }
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
                if (data.leagueAssignments) window.leagueAssignments = data.leagueAssignments;
                if (data.divisionTimes) window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(data.divisionTimes) || data.divisionTimes;
                saveSchedule(); 
                updateTable(); 
                alert('✅ Version loaded!');
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
                    if (scheduleData.leagueAssignments) latestLeagueData = scheduleData.leagueAssignments;
                    if (scheduleData.divisionTimes) latestDivisionTimes = scheduleData.divisionTimes;
                });
                window.scheduleAssignments = mergedAssignments;
                if (latestLeagueData) window.leagueAssignments = latestLeagueData;
                if (latestDivisionTimes) window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(latestDivisionTimes) || latestDivisionTimes;
                saveSchedule(); 
                updateTable();
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

    // RBAC bypass
    window.enableBypassRBACView = enableBypassRBACView;
    window.disableBypassRBACView = disableBypassRBACView;
    window.shouldShowDivision = shouldShowDivision;
    window.shouldHighlightBunk = shouldHighlightBunk;
    window.bypassSaveAllBunks = bypassSaveAllBunks;

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
        version: '4.1.0',
        
        // Core functions
        loadScheduleForDate, 
        renderStaggeredView, 
        findFirstSlotForTime,
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
            console.log(`TimeBasedFieldUsage: ${window.TimeBasedFieldUsage ? '✅' : '❌'}`);
            console.log(`Pinned activities: ${getPinnedActivities().length}`); 
            console.log(`RBAC bypass view: ${_bypassRBACViewEnabled}`); 
            console.log(`Highlighted bunks: ${[..._bypassHighlightBunks].join(', ') || 'none'}`); 
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
            bypassRBACViewEnabled: _bypassRBACViewEnabled, 
            highlightedBunks: [..._bypassHighlightBunks] 
        })
    };

    // Initialize on DOM ready
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initScheduleSystem);
    else setTimeout(initScheduleSystem, 100);

    console.log('📅 Unified Schedule System v4.1.0 loaded successfully');
    console.log('   ★★★ FULL DIVISIONTIMES INTEGRATION ★★★');
    console.log('   ✅ Division-aware time slot management');
    console.log('   ✅ TimeBasedFieldUsage for cross-division conflicts');
    console.log('   ✅ Removed unifiedTimes dependency');
    console.log('   ✅ Data persistence uses divisionTimes');

})();
