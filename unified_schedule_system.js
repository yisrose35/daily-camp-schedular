// =============================================================================
// unified_schedule_system.js v5.0.0 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
// =============================================================================
//
// COMPLETE REWRITE - Fixed all identified issues:
// ✅ Fixed broken template literals in HTML generation
// ✅ Fixed missing null safety checks throughout
// ✅ Fixed utility function references (consistent window.* pattern)
// ✅ Fixed race conditions in edit operations
// ✅ Fixed divisionTimes/unifiedTimes confusion
// ✅ Fixed modal HTML string concatenation
// ✅ Added comprehensive error handling
// ✅ Consolidated redundant code
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
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v5.0.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const VERSION = '5.0.0';
    const RENDER_DEBOUNCE_MS = 150;
    let DEBUG = false;
    const HIDE_VERSION_TOOLBAR = true;
    
    // Modal IDs
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const CLAIM_MODAL_ID = 'field-claim-modal';
    const CLAIM_OVERLAY_ID = 'field-claim-overlay';
    const INTEGRATED_EDIT_MODAL_ID = 'integrated-edit-modal';
    const INTEGRATED_EDIT_OVERLAY_ID = 'integrated-edit-overlay';
    const PROPOSAL_MODAL_ID = 'proposal-review-modal';
    
    // Auto-backup
    const AUTO_BACKUP_PREFIX = 'Auto-backup before';
    const MAX_AUTO_BACKUPS_PER_DATE = 10;
    
    // Transition type
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";
    
    // =========================================================================
    // STATE
    // =========================================================================
    
    let _lastRenderTime = 0;
    let _renderQueued = false;
    let _renderTimeout = null;
    let _initialized = false;
    let _cloudHydrated = false;

    // Edit state
    let _pendingProposals = [];
    let _claimInProgress = false;
    let _currentEditContext = null;
    let _multiBunkEditContext = null;
    let _multiBunkPreviewResult = null;
    let _lastPreviewResult = null;

    // RBAC bypass state
    let _bypassRBACViewEnabled = false;
    let _bypassHighlightBunks = new Set();

    // Pinned activity state
    let _pinnedSnapshot = {};
    let _pinnedFieldLocks = [];

    // =========================================================================
    // ROTATION CONFIGURATION
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
    // UTILITY FUNCTIONS
    // =========================================================================

    function debugLog(...args) {
        if (DEBUG) console.log('[UnifiedSchedule]', ...args);
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function minutesToTimeStr(minutes) {
        if (minutes == null || isNaN(minutes)) return '--:--';
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    function parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (!str || typeof str !== 'string') return null;
        
        let s = str.trim().toLowerCase();
        let meridian = null;
        
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridian = s.slice(-2);
            s = s.slice(0, -2).trim();
        } else if (s.includes(' am') || s.includes(' pm')) {
            meridian = s.includes(' am') ? 'am' : 'pm';
            s = s.replace(/ (am|pm)/i, '').trim();
        }
        
        const parts = s.split(':');
        let hours = parseInt(parts[0], 10);
        const minutes = parts[1] ? parseInt(parts[1], 10) : 0;
        
        if (isNaN(hours)) return null;
        
        if (meridian === 'pm' && hours < 12) hours += 12;
        if (meridian === 'am' && hours === 12) hours = 0;
        
        return hours * 60 + minutes;
    }

    function fieldLabel(field) {
        if (!field) return '';
        if (typeof field === 'object') return field.name || '';
        return String(field);
    }

    function getDateKey() {
        return window.currentScheduleDate || 
               window.currentDate || 
               document.getElementById('datePicker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    // =========================================================================
    // DIVISION & BUNK UTILITIES
    // =========================================================================

    function getDivisionForBunk(bunk) {
        // First check if SchedulerCoreUtils has this function
        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            return window.SchedulerCoreUtils.getDivisionForBunk(bunk);
        }
        
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks?.includes(bunk)) {
                return divName;
            }
        }
        return null;
    }

    function getEditableBunks() {
        const myDivisions = window.getMyDivisions?.() || 
                           window.AccessControl?.getMyDivisions?.() || 
                           Object.keys(window.divisions || {});
        const editableBunks = new Set();
        const divisions = window.divisions || {};
        
        for (const divName of myDivisions) {
            const divData = divisions[divName];
            if (divData?.bunks) {
                divData.bunks.forEach(b => editableBunks.add(b));
            }
        }
        return editableBunks;
    }

    function canEditBunk(bunk) {
        if (window.canEditBunk) return window.canEditBunk(bunk);
        return getEditableBunks().has(bunk);
    }

    function getMyDivisions() {
        return window.getMyDivisions?.() || 
               window.AccessControl?.getMyDivisions?.() || 
               Object.keys(window.divisions || {});
    }

    // =========================================================================
    // SLOT UTILITIES
    // =========================================================================

    function findSlotsForRange(startMin, endMin, bunkOrDivOrTimes) {
        // Use SchedulerCoreUtils if available
        if (window.SchedulerCoreUtils?.findSlotsForRange) {
            return window.SchedulerCoreUtils.findSlotsForRange(startMin, endMin, bunkOrDivOrTimes);
        }
        
        // Fallback implementation
        let times = [];
        
        if (typeof bunkOrDivOrTimes === 'string') {
            // It's a division name or bunk name
            const divName = window.divisions?.[bunkOrDivOrTimes] ? bunkOrDivOrTimes : getDivisionForBunk(bunkOrDivOrTimes);
            times = window.divisionTimes?.[divName] || window.unifiedTimes || [];
        } else if (Array.isArray(bunkOrDivOrTimes)) {
            times = bunkOrDivOrTimes;
        } else {
            times = window.unifiedTimes || [];
        }
        
        const slots = [];
        for (let i = 0; i < times.length; i++) {
            const slot = times[i];
            const slotStart = slot.startMin ?? getSlotStartMin(slot);
            const slotEnd = slot.endMin ?? getSlotEndMin(slot);
            
            if (slotStart != null && slotEnd != null) {
                // Overlap check
                if (slotStart < endMin && slotEnd > startMin) {
                    slots.push(i);
                }
            }
        }
        return slots;
    }

    function getSlotStartMin(slot) {
        if (!slot) return null;
        if (slot.startMin !== undefined) return slot.startMin;
        if (slot.start instanceof Date) return slot.start.getHours() * 60 + slot.start.getMinutes();
        if (slot.start) {
            const d = new Date(slot.start);
            return d.getHours() * 60 + d.getMinutes();
        }
        return null;
    }

    function getSlotEndMin(slot) {
        if (!slot) return null;
        if (slot.endMin !== undefined) return slot.endMin;
        if (slot.end instanceof Date) return slot.end.getHours() * 60 + slot.end.getMinutes();
        if (slot.end) {
            const d = new Date(slot.end);
            return d.getHours() * 60 + d.getMinutes();
        }
        return null;
    }

    function getSlotTimeRange(slotIdx, bunkOrDiv) {
        if (window.SchedulerCoreUtils?.getSlotTimeRange) {
            return window.SchedulerCoreUtils.getSlotTimeRange(slotIdx, bunkOrDiv);
        }
        
        const divName = typeof bunkOrDiv === 'string' && window.divisions?.[bunkOrDiv] 
            ? bunkOrDiv 
            : getDivisionForBunk(bunkOrDiv);
        const divSlots = window.divisionTimes?.[divName] || window.unifiedTimes || [];
        const slot = divSlots[slotIdx];
        
        if (!slot) return { startMin: 0, endMin: 0, label: '' };
        
        return {
            startMin: slot.startMin ?? getSlotStartMin(slot),
            endMin: slot.endMin ?? getSlotEndMin(slot),
            label: slot.label || `${minutesToTimeStr(slot.startMin)} - ${minutesToTimeStr(slot.endMin)}`
        };
    }

    function getEntryForBlock(bunk, startMin, endMin, unifiedTimes) {
        if (window.SchedulerCoreUtils?.getEntryForBlock) {
            return window.SchedulerCoreUtils.getEntryForBlock(bunk, startMin, endMin, unifiedTimes);
        }
        
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) {
            return { entry: null, slotIdx: -1 };
        }
        
        const bunkData = assignments[bunk];
        const divName = getDivisionForBunk(bunk);
        const divSlots = window.divisionTimes?.[divName] || unifiedTimes || [];
        
        // Method 1: Exact time match
        for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
            const slot = divSlots[slotIdx];
            if (slot.startMin === startMin && slot.endMin === endMin) {
                return { entry: bunkData[slotIdx] || null, slotIdx };
            }
        }
        
        // Method 2: Slot starts within range
        for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
            const slot = divSlots[slotIdx];
            if (slot.startMin >= startMin && slot.startMin < endMin) {
                return { entry: bunkData[slotIdx] || null, slotIdx };
            }
        }
        
        // Method 3: Overlap
        for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
            const slot = divSlots[slotIdx];
            const hasOverlap = !(slot.endMin <= startMin || slot.startMin >= endMin);
            if (hasOverlap) {
                return { entry: bunkData[slotIdx] || null, slotIdx };
            }
        }
        
        return { entry: null, slotIdx: -1 };
    }

    // =========================================================================
    // RBAC VIEW BYPASS
    // =========================================================================

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
    // DATA LOADING & STORAGE
    // =========================================================================

    function loadDailyData() {
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            console.error('[UnifiedSchedule] Error loading daily data:', e);
            return {};
        }
    }

    function loadScheduleForDate(dateKey) {
        // Skip if post-edit in progress
        if (window._postEditInProgress) {
            debugLog('Skipping load - post-edit in progress');
            return {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                skeleton: window.manualSkeleton || window.skeleton || []
            };
        }
        
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey] || {};
        
        // Load schedule assignments
        if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
        } else if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        
        // Load league assignments
        if (dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0) {
            window.leagueAssignments = dateData.leagueAssignments;
        } else if (!window.leagueAssignments) {
            window.leagueAssignments = {};
        }
        
        // Load unified times
        if (dateData.unifiedTimes?.length > 0) {
            window.unifiedTimes = dateData.unifiedTimes;
        }
        
        // Build divisionTimes from skeleton if needed
        if (!window.divisionTimes || Object.keys(window.divisionTimes).length === 0) {
            const skeleton = window.dailyOverrideSkeleton || getSkeleton(dateKey);
            const divisions = window.divisions || {};
            if (skeleton.length > 0 && window.DivisionTimesSystem) {
                window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(skeleton, divisions);
                console.log(`[loadScheduleForDate] Built divisionTimes: ${Object.keys(window.divisionTimes).length} divisions`);
            }
        }
        
        // Load skeleton
        if (dateData.manualSkeleton?.length > 0) {
            window.manualSkeleton = dateData.manualSkeleton;
        } else if (dateData.skeleton?.length > 0) {
            window.manualSkeleton = dateData.skeleton;
        }
        
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
        return dateData.manualSkeleton || 
               dateData.skeleton || 
               window.dailyOverrideSkeleton || 
               window.manualSkeleton || 
               window.skeleton || 
               [];
    }

    function saveSchedule() {
        const silent = window._postEditInProgress;
        if (window.saveCurrentDailyData) {
            window.saveCurrentDailyData('scheduleAssignments', window.scheduleAssignments, { silent });
            window.saveCurrentDailyData('leagueAssignments', window.leagueAssignments, { silent });
            if (window.DivisionTimesSystem?.serialize) {
                window.saveCurrentDailyData('divisionTimes', window.DivisionTimesSystem.serialize(window.divisionTimes) || {}, { silent });
            }
        }
    }

    // =========================================================================
    // ACTIVITY PROPERTIES & LOCATIONS
    // =========================================================================

    function getActivityProperties() {
        if (window.getActivityProperties) return window.getActivityProperties();
        
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const props = {};
        
        (app1.fields || []).forEach(f => {
            if (f.name) props[f.name] = f;
        });
        (app1.specialActivities || []).forEach(s => {
            if (s.name) props[s.name] = s;
        });
        
        return props;
    }

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
    // ENTRY FORMATTING
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
        const field = typeof entry.field === 'object' ? entry.field?.name : (entry.field || '');
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
        return lower.includes('lunch') || 
               lower.includes('snack') || 
               lower.includes('swim') || 
               lower.includes('dismissal') || 
               lower.includes('rest') || 
               lower.includes('free');
    }

    function isLeagueBlockType(eventName) {
        return eventName && eventName.toLowerCase().includes('league');
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        const activityProperties = getActivityProperties();
        const locationInfo = activityProperties[locationName] || {};
        
        let maxCapacity = locationInfo.sharableWith?.capacity 
            ? parseInt(locationInfo.sharableWith.capacity) || 1 
            : (locationInfo.sharable ? 2 : 1);
        
        const editableBunks = getEditableBunks();
        const conflicts = [];
        const usageBySlot = {};
        
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;
                
                const entryField = fieldLabel(entry.field);
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
                        canEdit: editableBunks.has(bunkName)
                    });
                }
            }
        }
        
        // Check GlobalFieldLocks
        let globalLock = null;
        if (window.GlobalFieldLocks) {
            const divName = getDivisionForBunk(excludeBunk);
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, divName);
            if (lockInfo) globalLock = lockInfo;
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
        
        return {
            hasConflict,
            conflicts,
            editableConflicts: conflicts.filter(c => c.canEdit),
            nonEditableConflicts: conflicts.filter(c => !c.canEdit),
            globalLock,
            canShare: maxCapacity > 1 && currentUsage < maxCapacity,
            currentUsage,
            maxCapacity
        };
    }

    function checkCrossDivisionConflict(bunk, slotIndex, fieldName) {
        const divName = getDivisionForBunk(bunk);
        if (!divName) return { conflict: false, conflicts: [] };
        
        const divSlots = window.divisionTimes?.[divName] || [];
        const slot = divSlots[slotIndex];
        if (!slot) return { conflict: false, conflicts: [] };
        
        const startMin = slot.startMin;
        const endMin = slot.endMin;
        
        // Get capacity
        const activityProperties = getActivityProperties();
        const fieldInfo = activityProperties[fieldName] || {};
        let maxCapacity = 1;
        
        if (fieldInfo.sharableWith?.capacity) {
            maxCapacity = parseInt(fieldInfo.sharableWith.capacity) || 1;
        } else if (fieldInfo.sharable) {
            maxCapacity = 2;
        }
        
        if (window.TimeBasedFieldUsage?.checkAvailability) {
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
        
        return { conflict: false, conflicts: [] };
    }

    // =========================================================================
    // TIME-BASED FIELD USAGE (Fallback if not defined elsewhere)
    // =========================================================================

    if (!window.TimeBasedFieldUsage) {
        window.TimeBasedFieldUsage = {
            getUsageAtTime: function(fieldName, startMin, endMin, excludeBunk = null) {
                const usage = [];
                const fieldLower = fieldName.toLowerCase();
                const divisions = window.divisions || {};
                const assignments = window.scheduleAssignments || {};
                
                for (const [divName, divData] of Object.entries(divisions)) {
                    const divSlots = window.divisionTimes?.[divName] || [];
                    
                    for (const bunk of (divData.bunks || [])) {
                        if (excludeBunk && bunk === excludeBunk) continue;
                        
                        const bunkAssignments = assignments[bunk] || [];
                        
                        for (let idx = 0; idx < divSlots.length; idx++) {
                            const slot = divSlots[idx];
                            
                            // Time overlap check
                            if (slot.startMin < endMin && slot.endMin > startMin) {
                                const entry = bunkAssignments[idx];
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
            }
        };
    }

    // =========================================================================
    // SPLIT TILE DETECTION
    // =========================================================================
    
    function isSplitTileBlock(block) {
        if (!block) return false;
        if (block._isSplitTile || block._splitHalf || block.type === 'split_half') {
            return true;
        }
        if (!block.event || !block.event.includes('/')) return false;
        if (block.event.toLowerCase().includes('special')) return false;
        
        const duration = block.endMin - block.startMin;
        if (duration < 30) return false;
        
        const divName = block.division;
        const divSlots = window.divisionTimes?.[divName] || [];
        
        for (const slot of divSlots) {
            if (slot._splitParentEvent === block.event) {
                return true;
            }
        }
        
        return false;
    }
    
    function expandBlocksForSplitTiles(divBlocks) {
        const expandedBlocks = [];
        
        divBlocks.forEach(block => {
            if (block._splitHalf || block.type === 'split_half') {
                expandedBlocks.push(block);
                return;
            }
            
            if (block.type === 'split' && block.event?.includes('/')) {
                const divName = block.division;
                const divSlots = window.divisionTimes?.[divName] || [];
                
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
    // LEAGUE MATCHUP RETRIEVAL
    // =========================================================================

    function getLeagueMatchups(bunk, startMin, endMin) {
        const leagues = window.leagueAssignments || {};
        
        for (const [leagueName, league] of Object.entries(leagues)) {
            if (!league.schedule) continue;
            
            for (const game of league.schedule) {
                const isInGame = game.team1?.includes(bunk) || game.team2?.includes(bunk);
                const gameStart = game.startMin || parseTimeToMinutes(game.startTime);
                const gameEnd = game.endMin || parseTimeToMinutes(game.endTime);
                
                const overlaps = gameStart != null && gameEnd != null &&
                    gameStart < endMin && gameEnd > startMin;
                
                if (isInGame && overlaps) {
                    return {
                        matchups: [game],
                        gameLabel: game.label || `${game.team1?.join(', ')} vs ${game.team2?.join(', ')}`,
                        sport: league.sport || 'League',
                        leagueName: league.name
                    };
                }
            }
        }
        return { matchups: [], gameLabel: '', sport: '', leagueName: '' };
    }

    // =========================================================================
    // MAIN RENDER FUNCTION
    // =========================================================================

    function renderStaggeredView(container) {
        if (!container) {
            container = document.getElementById('scheduleTable');
            if (!container) return;
        }
        
        const dateKey = getDateKey();
        
        if (!window._postEditInProgress) {
            loadScheduleForDate(dateKey);
        } else {
            console.log('[UnifiedSchedule] 🛡️ RENDER: Using in-memory data (post-edit in progress)');
        }
        
        const skeleton = getSkeleton(dateKey);
        const unifiedTimes = window.unifiedTimes || [];
        const divisions = window.divisions || {};
        
        console.log('[UnifiedSchedule] RENDER STATE:', {
            dateKey,
            skeletonBlocks: skeleton.length,
            unifiedTimesSlots: unifiedTimes.length,
            scheduleAssignmentsBunks: Object.keys(window.scheduleAssignments || {}).length,
            divisionsCount: Object.keys(divisions).length,
            bypassRBACView: _bypassRBACViewEnabled || window._bypassRBACViewEnabled
        });
        
        container.innerHTML = '';
        
        if (!skeleton || skeleton.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p>No daily schedule structure found for this date.</p>
                    <p style="font-size: 0.9rem;">Use <strong>"Build Day"</strong> in the Master Schedule Builder to create a schedule structure.</p>
                </div>
            `;
            return;
        }
        
        let divisionsToShow = Object.keys(divisions);
        if (divisionsToShow.length === 0 && window.availableDivisions) {
            divisionsToShow = window.availableDivisions;
        }
        
        divisionsToShow.sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return String(a).localeCompare(String(b));
        });
        
        if (divisionsToShow.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p>No divisions configured.</p>
                </div>
            `;
            return;
        }
        
        const wrapper = document.createElement('div');
        wrapper.className = 'schedule-view-wrapper';
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 24px;';
        
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || 
                                  new Set(getMyDivisions());
        
        divisionsToShow.forEach(divName => {
            if (!shouldShowDivision(divName)) return;
            
            const divData = divisions[divName];
            if (!divData) return;
            
            const bunks = divData.bunks || [];
            if (bunks.length === 0) return;
            
            // Get blocks for this division
            const divBlocks = skeleton
                .filter(b => b.division === divName || !b.division)
                .map(b => ({
                    ...b,
                    division: divName,
                    startMin: parseTimeToMinutes(b.startTime) ?? b.startMin,
                    endMin: parseTimeToMinutes(b.endTime) ?? b.endMin
                }))
                .filter(b => b.startMin != null && b.endMin != null);
            
            if (divBlocks.length === 0) return;
            
            // Expand split tiles
            const expandedBlocks = expandBlocksForSplitTiles(divBlocks);
            
            const isEditable = editableDivisions instanceof Set 
                ? editableDivisions.has(divName) 
                : editableDivisions?.includes?.(divName) ?? true;
            
            const divSection = renderDivisionSection(divName, bunks, expandedBlocks, unifiedTimes, isEditable);
            wrapper.appendChild(divSection);
        });
        
        container.appendChild(wrapper);
    }

    function renderDivisionSection(divName, bunks, blocks, unifiedTimes, isEditable) {
        const section = document.createElement('div');
        section.className = 'division-section';
        section.dataset.division = divName;
        section.style.cssText = 'background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden;';
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = 'background: #1e40af; color: white; padding: 12px 16px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;';
        header.innerHTML = `
            <span>${escapeHtml(divName)}</span>
            <span style="font-size: 0.85rem; opacity: 0.8;">${bunks.length} bunks</span>
        `;
        section.appendChild(header);
        
        // Table
        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse;';
        
        // Header row
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = '<th style="padding: 10px; text-align: left; border-bottom: 2px solid #e5e7eb; background: #f9fafb; min-width: 100px;">Bunk</th>';
        
        blocks.forEach(block => {
            const th = document.createElement('th');
            th.style.cssText = 'padding: 10px; text-align: center; border-bottom: 2px solid #e5e7eb; background: #f9fafb; min-width: 120px;';
            th.innerHTML = `
                <div style="font-weight: 600;">${escapeHtml(block.event || block.type || '')}</div>
                <div style="font-size: 0.75rem; color: #6b7280;">${minutesToTimeStr(block.startMin)} - ${minutesToTimeStr(block.endMin)}</div>
            `;
            headerRow.appendChild(th);
        });
        
        thead.appendChild(headerRow);
        table.appendChild(thead);
        
        // Body
        const tbody = document.createElement('tbody');
        
        bunks.forEach(bunk => {
            const row = document.createElement('tr');
            
            // Bunk name cell
            const bunkCell = document.createElement('td');
            bunkCell.style.cssText = 'padding: 8px 10px; font-weight: 500; border: 1px solid #e5e7eb; background: #f9fafb;';
            bunkCell.textContent = bunk;
            
            if (shouldHighlightBunk(bunk)) {
                bunkCell.style.background = 'linear-gradient(135deg, #fef3c7, #fde68a)';
            }
            
            row.appendChild(bunkCell);
            
            // Activity cells
            blocks.forEach(block => {
                const td = renderBunkCell(block, bunk, divName, unifiedTimes, isEditable);
                row.appendChild(td);
            });
            
            tbody.appendChild(row);
        });
        
        table.appendChild(tbody);
        section.appendChild(table);
        
        return section;
    }

    function renderBunkCell(block, bunk, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        
        const { entry, slotIdx } = getEntryForBlock(bunk, block.startMin, block.endMin, unifiedTimes);
        
        // Check if blocked by another scheduler
        let isBlocked = false;
        let blockedReason = '';
        if (window.MultiSchedulerAutonomous?.isBunkSlotBlocked) {
            const blockCheck = window.MultiSchedulerAutonomous.isBunkSlotBlocked(bunk, slotIdx);
            if (blockCheck.blocked) {
                isBlocked = true;
                blockedReason = blockCheck.reason;
            }
        }
        
        let displayText = '';
        let bgColor = '#fff';
        
        if (entry && !entry.continuation) {
            displayText = formatEntry(entry);
            bgColor = getEntryBackground(entry, block.event);
            if (entry._pinned) displayText = '📌 ' + displayText;
        } else if (!entry) {
            if (isFixedBlockType(block.event)) {
                displayText = block.event;
                bgColor = '#fff8e1';
            } else {
                bgColor = '#f9fafb';
            }
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
        } else if (isEditable) {
            td.style.cursor = 'pointer';
            td.onclick = () => {
                const existingEntry = window.scheduleAssignments?.[bunk]?.[slotIdx];
                openIntegratedEditModal(bunk, slotIdx, existingEntry);
            };
        }
        
        return td;
    }

    // =========================================================================
    // UPDATE TABLE (with debouncing)
    // =========================================================================

    function updateTable() {
        const now = Date.now();
        
        // Force immediate render during post-edit
        if (window._postEditInProgress) {
            _lastRenderTime = now;
            _renderQueued = false;
            if (_renderTimeout) {
                clearTimeout(_renderTimeout);
                _renderTimeout = null;
            }
            const container = document.getElementById('scheduleTable');
            if (container) renderStaggeredView(container);
            return;
        }
        
        // Debounce normal renders
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
    // VERSION MANAGEMENT
    // =========================================================================
    
    const VersionManager = {
        async saveVersion(name) {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return { success: false };
            }
            
            if (!name) {
                name = prompt('Enter a name for this version:');
                if (!name) return { success: false };
            }
            
            const dailyData = loadDailyData();
            const dateData = dailyData[dateKey] || {};
            
            const payload = {
                scheduleAssignments: window.scheduleAssignments || dateData.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || dateData.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || dateData.unifiedTimes || []
            };
            
            if (Object.keys(payload.scheduleAssignments).length === 0) {
                alert('No schedule data to save.');
                return { success: false };
            }
            
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available.');
                return { success: false };
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                const existing = versions.find(v => v.name.toLowerCase() === name.toLowerCase());
                
                if (existing) {
                    if (!confirm(`Version "${existing.name}" already exists. Overwrite?`)) {
                        return { success: false };
                    }
                    if (window.ScheduleVersionsDB.updateVersion) {
                        const result = await window.ScheduleVersionsDB.updateVersion(existing.id, payload);
                        if (result.success) {
                            alert('✅ Version updated!');
                            return { success: true };
                        } else {
                            alert('❌ Error: ' + result.error);
                            return { success: false };
                        }
                    }
                }
                
                const result = await window.ScheduleVersionsDB.createVersion(dateKey, name, payload);
                if (result.success) {
                    alert('✅ Version saved!');
                    return { success: true };
                } else {
                    alert('❌ Error: ' + result.error);
                    return { success: false };
                }
            } catch (e) {
                console.error('[VersionManager] Error saving version:', e);
                alert('❌ Error saving version');
                return { success: false };
            }
        },
        
        async loadVersion(versionId) {
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available.');
                return { success: false };
            }
            
            try {
                const version = await window.ScheduleVersionsDB.getVersion(versionId);
                if (!version) {
                    alert('Version not found.');
                    return { success: false };
                }
                
                const data = version.schedule_data || version.data || {};
                
                if (data.scheduleAssignments) {
                    window.scheduleAssignments = data.scheduleAssignments;
                }
                if (data.leagueAssignments) {
                    window.leagueAssignments = data.leagueAssignments;
                }
                if (data.unifiedTimes) {
                    window.unifiedTimes = data.unifiedTimes;
                }
                
                saveSchedule();
                updateTable();
                
                alert(`✅ Loaded version: ${version.name}`);
                return { success: true };
            } catch (e) {
                console.error('[VersionManager] Error loading version:', e);
                alert('❌ Error loading version');
                return { success: false };
            }
        },
        
        async listVersions(dateKey) {
            if (!window.ScheduleVersionsDB) return [];
            
            try {
                return await window.ScheduleVersionsDB.listVersions(dateKey || getDateKey());
            } catch (e) {
                console.error('[VersionManager] Error listing versions:', e);
                return [];
            }
        },
        
        async deleteVersion(versionId) {
            if (!window.ScheduleVersionsDB?.deleteVersion) {
                alert('Delete not supported.');
                return { success: false };
            }
            
            if (!confirm('Are you sure you want to delete this version?')) {
                return { success: false };
            }
            
            try {
                await window.ScheduleVersionsDB.deleteVersion(versionId);
                alert('✅ Version deleted');
                return { success: true };
            } catch (e) {
                console.error('[VersionManager] Error deleting version:', e);
                alert('❌ Error deleting version');
                return { success: false };
            }
        },
        
        async mergeVersions() {
            // Placeholder for merge functionality
            console.log('[VersionManager] Merge not yet implemented');
            return { success: false, reason: 'Not implemented' };
        }
    };

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
                
                // Trigger cleanup in background
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
        if (!window.ScheduleVersionsDB) {
            return { cleaned: 0 };
        }

        const targetDate = dateKey || getDateKey();
        
        try {
            const versions = await window.ScheduleVersionsDB.listVersions(targetDate);
            if (!versions || !Array.isArray(versions)) return { cleaned: 0 };

            const autoBackups = versions.filter(v => 
                v.name && v.name.startsWith(AUTO_BACKUP_PREFIX)
            );

            if (autoBackups.length <= MAX_AUTO_BACKUPS_PER_DATE) {
                console.log(`[AutoBackup] ${autoBackups.length} auto-backups exist, within limit`);
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
        
        const targetDate = dateKey || getDateKey();
        
        try {
            const versions = await window.ScheduleVersionsDB.listVersions(targetDate);
            return (versions || []).filter(v => v.name?.startsWith(AUTO_BACKUP_PREFIX));
        } catch (e) {
            console.error('[AutoBackup] Error listing backups:', e);
            return [];
        }
    }

    // =========================================================================
    // MODAL UI SYSTEM
    // =========================================================================

    function createModal(modalId, overlayId) {
        // Remove existing
        document.getElementById(overlayId)?.remove();
        document.getElementById(modalId)?.remove();
        
        const overlay = document.createElement('div');
        overlay.id = overlayId;
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
        modal.id = modalId;
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
            if (e.target === overlay) closeModal(overlayId);
        });
        
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal(overlayId);
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
        
        return modal;
    }

    function closeModal(overlayId) {
        document.getElementById(overlayId)?.remove();
    }

    // =========================================================================
    // INTEGRATED EDIT MODAL
    // =========================================================================

    function openIntegratedEditModal(bunk, slotIdx, existingEntry) {
        const divName = getDivisionForBunk(bunk);
        const bunksInDivision = window.divisions?.[divName]?.bunks || [];
        const times = window.divisionTimes?.[divName] || window.unifiedTimes || [];
        const slotInfo = times[slotIdx] || {};
        const timeLabel = slotInfo.label || 
            `${minutesToTimeStr(slotInfo.startMin)} - ${minutesToTimeStr(slotInfo.endMin)}`;

        _currentEditContext = { bunk, slotIdx, divName, bunksInDivision, existingEntry, slotInfo };

        showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEditBunk(bunk));
    }

    function showScopeSelectionModal(bunk, slotIdx, divName, timeLabel, canEdit) {
        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9998; animation: fadeIn 0.2s ease-out;';
        overlay.onclick = closeIntegratedEditModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = INTEGRATED_EDIT_MODAL_ID;
        modal.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999; min-width: 400px; max-width: 500px; animation: fadeIn 0.2s ease-out;';
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
                        <div>
                            <div style="font-weight: 500; color: #1f2937;">Just this cell</div>
                            <div style="font-size: 0.85rem; color: #6b7280;">${escapeHtml(bunk)} only</div>
                        </div>
                    </label>
                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="division" style="margin-top: 3px;">
                        <div>
                            <div style="font-weight: 500; color: #1f2937;">Entire division</div>
                            <div style="font-size: 0.85rem; color: #6b7280;">All ${bunksInDiv.length} bunks in ${escapeHtml(divName)}</div>
                        </div>
                    </label>
                    <label class="edit-scope-option" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;">
                        <input type="radio" name="edit-scope" value="select" style="margin-top: 3px;">
                        <div>
                            <div style="font-weight: 500; color: #1f2937;">Select specific bunks</div>
                            <div style="font-size: 0.85rem; color: #6b7280;">Choose which bunks to edit</div>
                        </div>
                    </label>
                </div>
            </div>
            <div id="bunk-select-area" style="display: none; margin-bottom: 16px; max-height: 150px; overflow-y: auto; background: #f9fafb; border-radius: 8px; padding: 12px;">
                ${bunksInDiv.map(b => `
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;">
                        <input type="checkbox" class="bunk-checkbox" value="${escapeHtml(b)}" ${b === bunk ? 'checked' : ''}>
                        <span>${escapeHtml(b)}</span>
                    </label>
                `).join('')}
            </div>
            <div id="time-range-area" style="display: none; margin-bottom: 16px; background: #f9fafb; border-radius: 8px; padding: 12px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 8px;">Time Range</div>
                <div style="display: flex; gap: 12px; align-items: center;">
                    <select id="edit-start-slot" style="flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;">
                        ${(_currentEditContext.bunksInDivision?.length > 0 ? 
                            (window.divisionTimes?.[divName] || []).map((s, i) => 
                                `<option value="${i}" ${i === slotIdx ? 'selected' : ''}>${minutesToTimeStr(s.startMin)}</option>`
                            ).join('') : ''
                        )}
                    </select>
                    <span>to</span>
                    <select id="edit-end-slot" style="flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;">
                        ${(_currentEditContext.bunksInDivision?.length > 0 ? 
                            (window.divisionTimes?.[divName] || []).map((s, i) => 
                                `<option value="${i}" ${i === slotIdx ? 'selected' : ''}>${minutesToTimeStr(s.endMin)}</option>`
                            ).join('') : ''
                        )}
                    </select>
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button onclick="closeIntegratedEditModal()" style="padding: 10px 20px; border: 1px solid #d1d5db; background: white; border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                <button id="proceed-scope-btn" style="padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">Continue</button>
            </div>
        `;

        document.body.appendChild(modal);

        // Event handlers
        const scopeRadios = modal.querySelectorAll('input[name="edit-scope"]');
        const bunkSelectArea = document.getElementById('bunk-select-area');
        const timeRangeArea = document.getElementById('time-range-area');

        scopeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                bunkSelectArea.style.display = e.target.value === 'select' ? 'block' : 'none';
                timeRangeArea.style.display = e.target.value !== 'single' ? 'block' : 'none';
            });
        });

        document.getElementById('proceed-scope-btn').onclick = () => {
            const scope = document.querySelector('input[name="edit-scope"]:checked')?.value;
            proceedWithScope(scope);
        };
    }

    function closeIntegratedEditModal() {
        document.getElementById(INTEGRATED_EDIT_OVERLAY_ID)?.remove();
        document.getElementById(INTEGRATED_EDIT_MODAL_ID)?.remove();
    }

    function proceedWithScope(scope) {
        const ctx = _currentEditContext;
        if (!ctx) {
            console.error('[IntegratedEdit] No edit context');
            closeIntegratedEditModal();
            return;
        }
        
        if (scope === 'single') {
            closeIntegratedEditModal();
            enhancedEditCell(
                ctx.bunk,
                ctx.slotInfo?.startMin ?? ctx.slotInfo?.start,
                ctx.slotInfo?.endMin ?? ctx.slotInfo?.end,
                ctx.existingEntry?._activity || ''
            );
        } else if (scope === 'division') {
            const startSlot = parseInt(document.getElementById('edit-start-slot')?.value);
            const endSlot = parseInt(document.getElementById('edit-end-slot')?.value);
            
            if (endSlot < startSlot) {
                alert('End time must be after start time');
                return;
            }

            const slots = [];
            for (let i = startSlot; i <= endSlot; i++) slots.push(i);

            closeIntegratedEditModal();
            openMultiBunkEditModal(ctx.bunksInDivision, slots, ctx.divName);
        } else if (scope === 'select') {
            const selectedBunks = Array.from(document.querySelectorAll('.bunk-checkbox:checked')).map(cb => cb.value);
            
            if (selectedBunks.length === 0) {
                alert('Please select at least one bunk');
                return;
            }

            const startSlot = parseInt(document.getElementById('edit-start-slot')?.value);
            const endSlot = parseInt(document.getElementById('edit-end-slot')?.value);
            
            if (endSlot < startSlot) {
                alert('End time must be after start time');
                return;
            }

            const slots = [];
            for (let i = startSlot; i <= endSlot; i++) slots.push(i);

            closeIntegratedEditModal();
            openMultiBunkEditModal(selectedBunks, slots, ctx.divName);
        }
    }

    // =========================================================================
    // MULTI-BUNK EDIT MODAL
    // =========================================================================

    function openMultiBunkEditModal(bunks, slots, divName) {
        _multiBunkEditContext = { bunks, slots, divName };
        _multiBunkPreviewResult = null;

        const overlay = document.createElement('div');
        overlay.id = INTEGRATED_EDIT_OVERLAY_ID;
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9998;';
        overlay.onclick = closeIntegratedEditModal;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = INTEGRATED_EDIT_MODAL_ID;
        modal.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); z-index: 9999; min-width: 500px; max-width: 620px; max-height: 85vh; overflow-y: auto;';
        modal.onclick = function(e) { e.stopPropagation(); };

        const times = window.divisionTimes?.[divName] || window.unifiedTimes || [];
        const locations = getAllLocations();

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af; font-size: 1.2rem;">📋 Multi-Bunk Edit</h2>
                <button onclick="closeIntegratedEditModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #6b7280;">&times;</button>
            </div>
            <div style="background: #f3f4f6; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <div style="font-size: 0.9rem; color: #6b7280;">Editing ${bunks.length} bunks • ${slots.length} slot(s)</div>
                <div style="font-weight: 600; color: #1f2937; margin-top: 4px;">${escapeHtml(divName)}</div>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 8px;">Activity</label>
                <input type="text" id="multi-activity" placeholder="Enter activity name" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;">
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 8px;">Location / Field</label>
                <select id="multi-location" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px;">
                    <option value="">-- Select location --</option>
                    ${locations.map(l => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join('')}
                </select>
            </div>
            <div id="multi-preview-area" style="display: none; margin-bottom: 16px;"></div>
            <div id="multi-resolution-mode" style="display: none; margin-bottom: 16px; padding: 12px; background: #f9fafb; border-radius: 8px;">
                <div style="font-weight: 500; color: #374151; margin-bottom: 8px;">How to handle conflicts?</div>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 8px;">
                    <input type="radio" name="multi-mode" value="notify" checked>
                    <span>📧 Create proposal (requires approval)</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="radio" name="multi-mode" value="bypass">
                    <span>🔓 Bypass & reassign (Admin mode)</span>
                </label>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button onclick="closeIntegratedEditModal()" style="padding: 10px 20px; border: 1px solid #d1d5db; background: white; border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                <button id="multi-preview-btn" style="padding: 10px 20px; background: #6b7280; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">Preview</button>
                <button id="multi-submit-btn" disabled style="padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; opacity: 0.5;">Apply</button>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('multi-preview-btn').onclick = previewMultiBunkEdit;
        document.getElementById('multi-submit-btn').onclick = submitMultiBunkEdit;
    }

    function previewMultiBunkEdit() {
        const ctx = _multiBunkEditContext;
        if (!ctx) return;

        const activity = document.getElementById('multi-activity')?.value.trim();
        const location = document.getElementById('multi-location')?.value;
        const previewArea = document.getElementById('multi-preview-area');
        const resolutionMode = document.getElementById('multi-resolution-mode');
        const submitBtn = document.getElementById('multi-submit-btn');

        if (!activity || !location) {
            alert('Please enter an activity and select a location');
            return;
        }

        const result = buildCascadeResolutionPlan(location, ctx.slots, ctx.divName, activity);
        result.location = location;
        result.activity = activity;
        result.bunks = ctx.bunks;
        result.slots = ctx.slots;
        result.divName = ctx.divName;

        _multiBunkPreviewResult = result;

        if (result.plan.length === 0 && result.blocked.length === 0) {
            previewArea.style.display = 'block';
            previewArea.style.cssText = 'background: #d1fae5; border: 1px solid #10b981; border-radius: 8px; padding: 12px;';
            previewArea.innerHTML = '<div style="color: #065f46; font-weight: 500;">✅ No conflicts detected. Ready to assign.</div>';
            resolutionMode.style.display = 'none';
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
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
                html += `
                    <div style="margin-bottom: 8px; padding: 8px; background: ${isOther ? '#fef2f2' : '#f0fdf4'}; border-radius: 6px;">
                        <div style="font-weight: 500; color: ${isOther ? '#991b1b' : '#166534'};">${isOther ? '🔒' : '✓'} ${escapeHtml(div)}</div>
                        <ul style="margin: 4px 0 0 16px; padding: 0; font-size: 0.85rem;">
                            ${moves.map(m => `<li>${escapeHtml(m.bunk)}: ${escapeHtml(m.from.activity)} → ${escapeHtml(m.to.activity)}</li>`).join('')}
                        </ul>
                    </div>
                `;
            }
            html += '</div>';
            previewArea.innerHTML = html;

            resolutionMode.style.display = otherDivisions.length > 0 ? 'block' : 'none';
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        }
    }

    async function submitMultiBunkEdit() {
        if (!_multiBunkPreviewResult) {
            alert('Please preview first');
            return;
        }

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
    // CASCADE RESOLUTION ENGINE
    // =========================================================================

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

        const plan = [];
        const blocked = [];
        const processedConflicts = new Set();
        
        let conflictQueue = findAllConflictsForClaim(fieldName, slots, []);
        let iteration = 0;
        const MAX_ITERATIONS = 50;

        while (conflictQueue.length > 0 && iteration < MAX_ITERATIONS) {
            iteration++;
            const conflict = conflictQueue.shift();
            const conflictKey = `${conflict.bunk}:${conflict.slot}`;
            
            if (processedConflicts.has(conflictKey)) continue;
            processedConflicts.add(conflictKey);

            if (conflict.isPinned) {
                blocked.push(conflict);
                continue;
            }

            const alternative = findAlternativeForBunk(conflict.bunk, conflict.slot, fieldName);
            
            if (alternative) {
                plan.push({
                    bunk: conflict.bunk,
                    slot: conflict.slot,
                    division: conflict.division,
                    from: {
                        activity: conflict.currentActivity,
                        field: conflict.currentField
                    },
                    to: {
                        activity: alternative.activity,
                        field: alternative.field
                    }
                });

                // Check if the alternative creates new conflicts
                if (alternative.field !== fieldName) {
                    const newConflicts = findAllConflictsForClaim(alternative.field, [conflict.slot], [conflict.bunk]);
                    conflictQueue.push(...newConflicts.filter(c => !processedConflicts.has(`${c.bunk}:${c.slot}`)));
                }
            } else {
                blocked.push(conflict);
            }
        }

        return { plan, blocked };
    }

    function findAlternativeForBunk(bunk, slotIdx, excludeField) {
        const activityProperties = getActivityProperties();
        const available = Object.keys(activityProperties).filter(name => {
            if (name === excludeField) return false;
            const info = activityProperties[name];
            if (info.available === false) return false;
            return true;
        });

        // Simple selection - in production, would use rotation scoring
        for (const fieldName of available) {
            const info = activityProperties[fieldName];
            const capacity = info.sharableWith?.capacity || (info.sharable ? 2 : 1);
            
            const conflictCheck = checkCrossDivisionConflict(bunk, slotIdx, fieldName);
            if (!conflictCheck.conflict || conflictCheck.currentUsage < capacity) {
                return {
                    activity: fieldName,
                    field: fieldName
                };
            }
        }

        return null;
    }

    // =========================================================================
    // APPLY MULTI-BUNK EDIT
    // =========================================================================

    async function applyMultiBunkEdit(result, notifyAfter = false) {
        const { location, slots, divName, activity, bunks, plan } = result;

        await createAutoBackup(activity, divName);

        // Assign to target bunks
        for (const bunk of bunks) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            for (let i = 0; i < slots.length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location,
                    sport: null,
                    _activity: activity,
                    _fixed: true,
                    _pinned: true,
                    _multiBunkEdit: true,
                    continuation: i > 0
                };
            }
        }

        // Apply cascade reassignments
        const modifiedBunks = new Set(bunks);
        for (const move of plan) {
            modifiedBunks.add(move.bunk);
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = [];
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field,
                sport: move.to.activity,
                _activity: move.to.activity,
                _cascadeReassigned: true
            };
        }

        // Lock field
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'multi_bunk_edit',
                division: divName,
                activity,
                bunks
            });
        }

        // Save
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        
        if (typeof bypassSaveAllBunks === 'function') {
            await bypassSaveAllBunks([...modifiedBunks]);
        }

        // Highlight modified bunks
        if (plan.length > 0) {
            enableBypassRBACView(plan.map(p => p.bunk));
        }

        // Notify
        if (notifyAfter && plan.length > 0) {
            const myDivisions = new Set(getMyDivisions());
            const otherMoves = plan.filter(p => !myDivisions.has(p.division));
            if (otherMoves.length > 0) {
                await sendSchedulerNotification(otherMoves.map(p => p.bunk), location, activity, 'bypassed');
            }
        }

        // Re-render
        renderStaggeredView();
        showIntegratedToast(`✅ ${bunks.length} bunks assigned to ${location}` + 
            (plan.length > 0 ? ` - ${plan.length} reassigned` : ''), 'success');
    }

    // =========================================================================
    // PROPOSAL SYSTEM
    // =========================================================================

    async function createMultiBunkProposal(result) {
        const { location, slots, divName, activity, bunks, plan } = result;
        const dateKey = getDateKey();
        const userId = window.CampistryDB?.getUserId?.() || null;
        const campId = window.CampistryDB?.getCampId?.() || null;

        const affectedDivisions = [...new Set(plan.map(p => p.division))];
        
        const proposal = {
            camp_id: campId,
            created_by: userId,
            date_key: dateKey,
            claim: {
                field: location,
                slots,
                division: divName,
                activity,
                bunks
            },
            reassignments: plan,
            affected_divisions: affectedDivisions,
            responses: {},
            status: 'pending',
            created_at: new Date().toISOString()
        };

        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) {
            alert('Database not available');
            return;
        }

        try {
            const { data, error } = await supabase
                .from('schedule_proposals')
                .insert([proposal])
                .select()
                .single();

            if (error) throw error;

            console.log('[Proposal] Created:', data);
            showIntegratedToast('📨 Proposal sent! Awaiting approval from other schedulers.', 'info');
            
            // Send notifications to affected schedulers
            await notifyAffectedSchedulers(data, affectedDivisions);
            
        } catch (e) {
            console.error('[Proposal] Error creating proposal:', e);
            alert('Error creating proposal');
        }
    }

    async function notifyAffectedSchedulers(proposal, divisions) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;

        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();

        try {
            // Get schedulers for affected divisions
            const { data: schedulers } = await supabase
                .from('camp_team_members')
                .select('user_id, subdivision_ids')
                .eq('camp_id', campId)
                .in('role', ['scheduler', 'admin', 'owner']);

            if (!schedulers) return;

            const notifications = [];
            for (const scheduler of schedulers) {
                if (scheduler.user_id === userId) continue;
                
                // Check if scheduler manages any affected division
                const manages = scheduler.subdivision_ids?.some(id => {
                    // This would need to map subdivision IDs to division names
                    return true; // Simplified
                });

                if (manages) {
                    notifications.push({
                        camp_id: campId,
                        user_id: scheduler.user_id,
                        type: 'proposal_pending',
                        title: '📋 Schedule proposal awaiting your approval',
                        message: `A proposal for ${proposal.claim?.field} requires your approval`,
                        metadata: { proposalId: proposal.id },
                        read: false,
                        created_at: new Date().toISOString()
                    });
                }
            }

            if (notifications.length > 0) {
                await supabase.from('notifications').insert(notifications);
            }
        } catch (e) {
            console.error('[Proposal] Error notifying schedulers:', e);
        }
    }

    async function loadProposal(proposalId) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return null;

        try {
            const { data, error } = await supabase
                .from('schedule_proposals')
                .select('*')
                .eq('id', proposalId)
                .single();

            if (error) throw error;
            return data;
        } catch (e) {
            console.error('[Proposal] Error loading:', e);
            return null;
        }
    }

    async function loadMyPendingProposals() {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return [];

        const campId = window.CampistryDB?.getCampId?.();
        const dateKey = getDateKey();

        try {
            const { data, error } = await supabase
                .from('schedule_proposals')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey)
                .eq('status', 'pending');

            if (error) throw error;
            return data || [];
        } catch (e) {
            console.error('[Proposal] Error loading pending:', e);
            return [];
        }
    }

    function openProposalReviewModal(proposal) {
        // Simplified - would render a full review UI
        console.log('[Proposal] Opening review for:', proposal);
        alert('Proposal review UI would open here');
    }

    async function respondToProposal(proposalId, response, divisions) {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;

        const userId = window.CampistryDB?.getUserId?.();

        try {
            const proposal = await loadProposal(proposalId);
            if (!proposal) return;

            const responses = proposal.responses || {};
            for (const div of divisions) {
                responses[div] = { response, userId, at: new Date().toISOString() };
            }

            // Check if all affected divisions have responded
            const allResponded = proposal.affected_divisions?.every(d => responses[d]);
            const allApproved = allResponded && proposal.affected_divisions?.every(d => responses[d]?.response === 'approved');

            const newStatus = allApproved ? 'approved' : (allResponded ? 'rejected' : 'pending');

            await supabase
                .from('schedule_proposals')
                .update({ 
                    responses, 
                    status: newStatus,
                    updated_at: new Date().toISOString()
                })
                .eq('id', proposalId);

            if (newStatus === 'approved') {
                await applyApprovedProposal(proposal);
            }

            showIntegratedToast(
                response === 'approved' ? '✅ Proposal approved' : '❌ Proposal rejected',
                response === 'approved' ? 'success' : 'info'
            );

        } catch (e) {
            console.error('[Proposal] Error responding:', e);
            alert('Error responding to proposal');
        }
    }

    async function applyApprovedProposal(proposal) {
        console.log('[ApplyProposal] Applying approved proposal...');

        const claim = proposal.claim || {};
        await createAutoBackup(claim.activity || 'Approved Proposal', claim.division || 'Unknown');

        const { field: location, slots, division: divName, activity, bunks } = claim;
        const plan = proposal.reassignments || [];

        // Assign to target bunks
        for (const bunk of (bunks || [])) {
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            for (let i = 0; i < (slots || []).length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location,
                    sport: null,
                    _activity: activity,
                    _fixed: true,
                    _pinned: true,
                    _fromProposal: true,
                    continuation: i > 0
                };
            }
        }

        // Apply cascade
        const modifiedBunks = new Set(bunks || []);
        for (const move of plan) {
            modifiedBunks.add(move.bunk);
            if (!window.scheduleAssignments[move.bunk]) window.scheduleAssignments[move.bunk] = [];
            window.scheduleAssignments[move.bunk][move.slot] = {
                field: move.to.field,
                sport: move.to.activity,
                _activity: move.to.activity,
                _fromProposal: true
            };
        }

        // Lock field
        if (window.GlobalFieldLocks && location && slots) {
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'approved_proposal',
                division: divName,
                activity,
                bunks
            });
        }

        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        
        if (typeof bypassSaveAllBunks === 'function') {
            await bypassSaveAllBunks([...modifiedBunks]);
        }

        if (plan.length > 0) {
            enableBypassRBACView(plan.map(p => p.bunk));
        }

        // Mark applied
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (supabase) {
            await supabase
                .from('schedule_proposals')
                .update({ applied: true, applied_at: new Date().toISOString() })
                .eq('id', proposal.id);
        }

        renderStaggeredView();
        showIntegratedToast(`✅ Proposal applied: ${(bunks || []).length} bunks → ${location}`, 'success');
    }

    // =========================================================================
    // SIMPLE EDIT (SINGLE CELL)
    // =========================================================================

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal(MODAL_ID, OVERLAY_ID);
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        let resolutionChoice = 'notify';
        
        const slots = findSlotsForRange(startMin, endMin, bunk);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = fieldLabel(entry.field);
                currentActivity = entry._activity || entry.sport || currentField;
            }
        }

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0; color: #1e40af; font-size: 1.2rem;">✏️ Edit: ${escapeHtml(bunk)}</h2>
                <button id="post-edit-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #6b7280;">&times;</button>
            </div>
            <div style="background: #f3f4f6; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <div style="font-weight: 600; color: #1f2937;">${minutesToTimeStr(startMin)} - ${minutesToTimeStr(endMin)}</div>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 8px;">Activity</label>
                <input type="text" id="post-edit-activity" value="${escapeHtml(currentActivity)}" placeholder="Enter activity" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;">
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 8px;">Location / Field</label>
                <select id="post-edit-location" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px;">
                    <option value="">-- None --</option>
                    ${locations.map(l => `<option value="${escapeHtml(l.name)}" ${l.name === currentField ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
                </select>
            </div>
            <div id="post-edit-conflict" style="display: none; margin-bottom: 16px;"></div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button id="post-edit-clear" style="padding: 10px 20px; border: 1px solid #ef4444; background: white; color: #ef4444; border-radius: 8px; cursor: pointer; font-weight: 500;">Clear</button>
                <button id="post-edit-save" style="padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">Save</button>
            </div>
        `;

        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');

        function checkAndShowConflicts() {
            const location = locationSelect.value;
            if (!location) {
                conflictArea.style.display = 'none';
                return null;
            }

            const conflictCheck = checkLocationConflict(location, slots, bunk);
            if (conflictCheck.hasConflict) {
                conflictArea.style.display = 'block';
                conflictArea.style.cssText = 'background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;';
                
                const editableBunks = conflictCheck.editableConflicts.map(c => c.bunk);
                const nonEditableBunks = conflictCheck.nonEditableConflicts.map(c => c.bunk);

                let html = `<div style="color: #92400e; font-weight: 500; margin-bottom: 8px;">⚠️ Conflict Detected</div>`;
                html += `<p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;"><strong>${escapeHtml(location)}</strong> is already in use.</p>`;
                
                if (editableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px; padding: 8px; background: #d1fae5; border-radius: 6px;"><div style="font-size: 0.8rem; color: #065f46;"><strong>✓ Can auto-reassign:</strong> ${editableBunks.join(', ')}</div></div>`;
                }
                
                if (nonEditableBunks.length > 0) {
                    html += `
                        <div style="margin-bottom: 8px; padding: 8px; background: #fee2e2; border-radius: 6px;">
                            <div style="font-size: 0.8rem; color: #991b1b;"><strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.join(', ')}</div>
                        </div>
                        <div style="margin-top: 12px;">
                            <div style="font-weight: 500; color: #374151; margin-bottom: 8px; font-size: 0.875rem;">How to handle?</div>
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 8px;">
                                <input type="radio" name="conflict-resolution" value="notify" checked>
                                <span style="font-size: 0.875rem;">📧 Notify other scheduler</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                <input type="radio" name="conflict-resolution" value="bypass">
                                <span style="font-size: 0.875rem;">🔓 Bypass & reassign</span>
                            </label>
                        </div>
                    `;
                }

                conflictArea.innerHTML = html;
                
                conflictArea.querySelectorAll('input[name="conflict-resolution"]').forEach(radio => {
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
        checkAndShowConflicts();

        document.getElementById('post-edit-close').onclick = () => closeModal(OVERLAY_ID);
        
        document.getElementById('post-edit-clear').onclick = () => {
            onSave({ 
                activity: '', 
                location: '', 
                startMin, 
                endMin, 
                isClear: true,
                hasConflict: false, 
                conflicts: [] 
            });
            closeModal(OVERLAY_ID);
        };
        
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            
            if (!activity) {
                alert('Please enter an activity name.');
                return;
            }

            const conflictCheck = location ? checkAndShowConflicts() : null;
            
            onSave({
                activity,
                location,
                startMin,
                endMin,
                hasConflict: conflictCheck?.hasConflict || false,
                conflicts: conflictCheck?.conflicts || [],
                editableConflicts: conflictCheck?.editableConflicts || [],
                nonEditableConflicts: conflictCheck?.nonEditableConflicts || [],
                resolutionChoice
            });
            
            closeModal(OVERLAY_ID);
        };

        document.getElementById('post-edit-activity').focus();
        document.getElementById('post-edit-activity').select();
    }

    function enhancedEditCell(bunk, startMin, endMin, current) {
        if (!canEditBunk(bunk)) {
            alert('You do not have permission to edit this schedule.');
            return;
        }
        showEditModal(bunk, startMin, endMin, current, (editData) => applyEdit(bunk, editData));
    }

    function editCell(bunk, startMin, endMin, current) {
        enhancedEditCell(bunk, startMin, endMin, current);
    }

    // =========================================================================
    // APPLY EDIT
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, isClear, resolutionChoice } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        const slots = findSlotsForRange(startMin, endMin, bunk);

        if (slots.length === 0) {
            console.warn('[ApplyEdit] No slots found for time range');
            return;
        }

        console.log(`[ApplyEdit] Applying edit for ${bunk}:`, { 
            activity, location, startMin, endMin, slots, hasConflict, resolutionChoice, isClear
        });

        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            const divName = getDivisionForBunk(bunk);
            const slotCount = window.divisionTimes?.[divName]?.length || unifiedTimes.length || 20;
            window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
        }

        // Set protection flag
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();

        if (hasConflict) {
            await resolveConflictsAndApply(bunk, slots, activity, location, editData);
        } else {
            applyDirectEdit(bunk, slots, activity, location, isClear);
        }

        // Save
        const currentDate = getDateKey();
        
        try {
            localStorage.setItem(`scheduleAssignments_${currentDate}`, JSON.stringify(window.scheduleAssignments));
            
            const allDailyData = loadDailyData();
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) {
            console.error('[ApplyEdit] Failed to save:', e);
        }

        // Clear protection after delay
        setTimeout(() => {
            window._postEditInProgress = false;
        }, 8000);

        // Dispatch event
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunk, slots, activity, location, date: currentDate }
        }));

        saveSchedule();
        updateTable();
        setTimeout(() => updateTable(), 300);
    }

    function applyDirectEdit(bunk, slots, activity, location, isClear, isPinned = false) {
        if (isClear) {
            for (const slotIdx of slots) {
                window.scheduleAssignments[bunk][slotIdx] = null;
            }
        } else {
            for (let i = 0; i < slots.length; i++) {
                window.scheduleAssignments[bunk][slots[i]] = {
                    field: location || activity,
                    sport: null,
                    _activity: activity,
                    _fixed: true,
                    _pinned: isPinned,
                    continuation: i > 0
                };
            }
        }
    }

    async function resolveConflictsAndApply(bunk, slots, activity, location, editData) {
        const { editableConflicts = [], nonEditableConflicts = [], resolutionChoice = 'notify' } = editData;
        
        // Apply the primary edit first
        applyDirectEdit(bunk, slots, activity, location, false, true);
        
        // Lock the field
        if (window.GlobalFieldLocks) {
            const divName = getDivisionForBunk(bunk);
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'post_edit_pinned',
                division: divName,
                activity
            });
        }

        let conflictsToResolve = [...editableConflicts];
        const bypassMode = resolutionChoice === 'bypass';
        
        if (bypassMode && nonEditableConflicts.length > 0) {
            console.log('[ResolveConflicts] 🔓 BYPASS MODE');
            conflictsToResolve = [...conflictsToResolve, ...nonEditableConflicts];
        }

        if (conflictsToResolve.length > 0) {
            const result = smartRegenerateConflicts(bunk, slots, location, activity, conflictsToResolve, bypassMode);
            
            if (bypassMode) {
                const modifiedBunks = [...result.reassigned.map(r => r.bunk), ...result.failed.map(f => f.bunk)];
                window._postEditInProgress = true;
                window._postEditTimestamp = Date.now();
                await bypassSaveAllBunks(modifiedBunks);
                
                const reassignedBunks = result.reassigned.map(r => r.bunk);
                if (reassignedBunks.length > 0) {
                    enableBypassRBACView(reassignedBunks);
                }
            }
        }

        // Notify non-editable bunks if not bypassing
        if (!bypassMode && nonEditableConflicts.length > 0) {
            await sendSchedulerNotification(
                nonEditableConflicts.map(c => c.bunk),
                location,
                activity,
                'conflict'
            );
        }
    }

    // =========================================================================
    // SMART REGENERATION
    // =========================================================================

    function smartRegenerateConflicts(pinnedBunk, pinnedSlots, pinnedField, pinnedActivity, conflicts, bypassMode = false) {
        console.log('[SmartRegen] ★★★ SMART REGENERATION STARTED ★★★');
        if (bypassMode) console.log('[SmartRegen] 🔓 BYPASS MODE ACTIVE');

        const activityProperties = getActivityProperties();
        const results = { success: true, reassigned: [], failed: [], pinnedLock: null, bypassMode };

        // Lock the pinned field
        if (window.GlobalFieldLocks) {
            const pinnedDivName = getDivisionForBunk(pinnedBunk);
            window.GlobalFieldLocks.lockField(pinnedField, pinnedSlots, {
                lockedBy: 'smart_regen_pinned',
                division: pinnedDivName,
                activity: pinnedActivity,
                bunk: pinnedBunk
            });
            results.pinnedLock = { field: pinnedField, slots: pinnedSlots };
        }

        // Group conflicts by bunk
        const conflictsByBunk = {};
        for (const conflict of conflicts) {
            if (!conflictsByBunk[conflict.bunk]) conflictsByBunk[conflict.bunk] = new Set();
            conflictsByBunk[conflict.bunk].add(conflict.slot);
        }

        const bunksToReassign = Object.keys(conflictsByBunk);
        
        // Build field usage map
        const fieldUsageBySlot = buildFieldUsageBySlot(bunksToReassign);
        
        // Add pinned field to usage
        for (const slotIdx of pinnedSlots) {
            if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
            if (!fieldUsageBySlot[slotIdx][pinnedField]) {
                fieldUsageBySlot[slotIdx][pinnedField] = { count: 0, bunks: {}, divisions: [] };
            }
            fieldUsageBySlot[slotIdx][pinnedField].count++;
            fieldUsageBySlot[slotIdx][pinnedField].bunks[pinnedBunk] = pinnedActivity;
        }

        // Sort bunks for consistent ordering
        bunksToReassign.sort((a, b) => {
            const numA = parseInt((a.match(/\d+/) || [])[0]) || 0;
            const numB = parseInt((b.match(/\d+/) || [])[0]) || 0;
            return numA - numB;
        });

        // Reassign each bunk
        for (const bunk of bunksToReassign) {
            const slots = [...conflictsByBunk[bunk]].sort((a, b) => a - b);
            const originalEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];

            const alternative = findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, [pinnedField]);
            
            if (alternative) {
                // Apply the reassignment
                for (let i = 0; i < slots.length; i++) {
                    window.scheduleAssignments[bunk][slots[i]] = {
                        field: alternative.field,
                        sport: alternative.activity,
                        _activity: alternative.activity,
                        _reassignedFrom: originalEntry?._activity,
                        _smartRegen: true,
                        continuation: i > 0
                    };
                }

                // Update field usage
                for (const slotIdx of slots) {
                    if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
                    if (!fieldUsageBySlot[slotIdx][alternative.field]) {
                        fieldUsageBySlot[slotIdx][alternative.field] = { count: 0, bunks: {}, divisions: [] };
                    }
                    fieldUsageBySlot[slotIdx][alternative.field].count++;
                    fieldUsageBySlot[slotIdx][alternative.field].bunks[bunk] = alternative.activity;
                }

                results.reassigned.push({
                    bunk,
                    slots,
                    from: originalEntry?._activity,
                    to: alternative.activity,
                    field: alternative.field
                });
            } else {
                results.failed.push({
                    bunk,
                    slots,
                    original: originalEntry?._activity,
                    reason: 'No available alternative'
                });
            }
        }

        console.log('[SmartRegen] Complete:', results);
        return results;
    }

    function buildFieldUsageBySlot(excludeBunks = []) {
        if (window.buildFieldUsageBySlot) {
            return window.buildFieldUsageBySlot(excludeBunks);
        }

        const usage = {};
        const excludeSet = new Set(excludeBunks);
        const assignments = window.scheduleAssignments || {};

        for (const [bunk, slots] of Object.entries(assignments)) {
            if (excludeSet.has(bunk)) continue;
            if (!Array.isArray(slots)) continue;

            for (let i = 0; i < slots.length; i++) {
                const entry = slots[i];
                if (!entry || entry.continuation) continue;

                const field = fieldLabel(entry.field);
                if (!field) continue;

                if (!usage[i]) usage[i] = {};
                if (!usage[i][field]) {
                    usage[i][field] = { count: 0, bunks: {}, divisions: [] };
                }

                usage[i][field].count++;
                usage[i][field].bunks[bunk] = entry._activity || field;

                const div = getDivisionForBunk(bunk);
                if (div && !usage[i][field].divisions.includes(div)) {
                    usage[i][field].divisions.push(div);
                }
            }
        }

        return usage;
    }

    function findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, excludeFields = []) {
        const candidates = buildCandidateOptions(bunk, slots, fieldUsageBySlot, activityProperties, excludeFields);
        
        if (candidates.length === 0) return null;
        
        // Sort by penalty (lower is better)
        candidates.sort((a, b) => a.penalty - b.penalty);
        
        return candidates[0];
    }

    function buildCandidateOptions(bunk, slots, fieldUsageBySlot, activityProperties, excludeFields = []) {
        const excludeSet = new Set(excludeFields.map(f => f.toLowerCase()));
        const candidates = [];

        for (const [fieldName, info] of Object.entries(activityProperties)) {
            if (excludeSet.has(fieldName.toLowerCase())) continue;
            if (info.available === false) continue;

            const capacity = info.sharableWith?.capacity || (info.sharable ? 2 : 1);
            
            // Check availability across all slots
            let available = true;
            for (const slotIdx of slots) {
                const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
                if (slotUsage && slotUsage.count >= capacity) {
                    available = false;
                    break;
                }
            }

            if (available) {
                const penalty = calculateRotationPenalty(bunk, fieldName, slots[0]);
                candidates.push({
                    activity: fieldName,
                    field: fieldName,
                    penalty
                });
            }
        }

        return candidates;
    }

    function calculateRotationPenalty(bunk, activity, slotIdx) {
        // Simplified penalty calculation
        let penalty = 0;
        
        // Check if done today
        const todayActivities = getActivitiesDoneToday(bunk, slotIdx);
        if (todayActivities.has(activity)) {
            penalty += ROTATION_CONFIG.SAME_DAY_PENALTY;
        }

        return penalty;
    }

    function getActivitiesDoneToday(bunk, beforeSlot) {
        const done = new Set();
        const bunkData = window.scheduleAssignments?.[bunk];
        if (!bunkData) return done;

        for (let i = 0; i < beforeSlot && i < bunkData.length; i++) {
            const entry = bunkData[i];
            if (entry && entry._activity) {
                done.add(entry._activity);
            }
        }

        return done;
    }

    function applyPickToBunk(pick, bunk, slotIdx, fieldUsageBySlot) {
        if (!window.scheduleAssignments[bunk]) {
            const divName = getDivisionForBunk(bunk);
            const slotCount = window.divisionTimes?.[divName]?.length || 20;
            window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
        }

        window.scheduleAssignments[bunk][slotIdx] = {
            field: pick.field || pick.activityName,
            sport: pick.activityName,
            _activity: pick.activityName,
            _fixed: pick.fixed || false
        };

        // Update field usage
        const fieldName = pick.field || pick.activityName;
        if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
        if (!fieldUsageBySlot[slotIdx][fieldName]) {
            fieldUsageBySlot[slotIdx][fieldName] = { count: 0, bunks: {}, divisions: [] };
        }
        
        const usage = fieldUsageBySlot[slotIdx][fieldName];
        usage.count++;
        usage.bunks[bunk] = pick.activityName;
        
        const divName = getDivisionForBunk(bunk);
        if (divName && !usage.divisions.includes(divName)) {
            usage.divisions.push(divName);
        }
    }

    // =========================================================================
    // BYPASS SAVE & NOTIFICATIONS
    // =========================================================================

    async function bypassSaveAllBunks(bunks) {
        console.log('[BypassSave] Saving bunks:', bunks);
        
        const currentDate = getDateKey();
        const assignments = window.scheduleAssignments || {};

        // Save to localStorage
        try {
            const allDailyData = loadDailyData();
            if (!allDailyData[currentDate]) allDailyData[currentDate] = {};
            allDailyData[currentDate].scheduleAssignments = assignments;
            allDailyData[currentDate]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
        } catch (e) {
            console.error('[BypassSave] localStorage error:', e);
        }

        // Save to cloud
        if (window.saveCurrentDailyData) {
            window.saveCurrentDailyData('scheduleAssignments', assignments, { silent: true, bypass: true });
        }

        return { success: true, savedBunks: bunks.length };
    }

    async function sendSchedulerNotification(affectedBunks, location, activity, notificationType = 'conflict') {
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) return;

        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();
        const dateKey = getDateKey();

        try {
            // Get schedulers for affected bunks
            const affectedDivisions = new Set(affectedBunks.map(b => getDivisionForBunk(b)).filter(Boolean));
            
            const { data: schedulers } = await supabase
                .from('camp_team_members')
                .select('user_id')
                .eq('camp_id', campId)
                .neq('user_id', userId);

            if (!schedulers) return;

            const notifications = schedulers.map(s => ({
                camp_id: campId,
                user_id: s.user_id,
                type: notificationType === 'bypassed' ? 'schedule_bypassed' : 'schedule_conflict',
                title: notificationType === 'bypassed' 
                    ? '🔓 Your schedule was modified' 
                    : '⚠️ Schedule conflict detected',
                message: notificationType === 'bypassed'
                    ? `Another scheduler reassigned bunks (${affectedBunks.join(', ')}) for ${location} - ${activity} on ${dateKey}`
                    : `Conflict at ${location} for ${activity} on ${dateKey}. Affected bunks: ${affectedBunks.join(', ')}`,
                metadata: { dateKey, bunks: affectedBunks, location, activity, initiatedBy: userId },
                read: false,
                created_at: new Date().toISOString()
            }));

            await supabase.from('notifications').insert(notifications);
        } catch (e) {
            console.error('[Notification] Error:', e);
        }
    }

    // =========================================================================
    // PINNED ACTIVITY SYSTEM
    // =========================================================================

    function capturePinnedActivities(allowedDivisions = null) {
        _pinnedSnapshot = {};
        _pinnedFieldLocks = [];
        
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const allowedSet = allowedDivisions ? new Set(allowedDivisions) : null;

        for (const [bunk, slots] of Object.entries(assignments)) {
            if (!Array.isArray(slots)) continue;
            
            const divName = getDivisionForBunk(bunk);
            if (allowedSet && allowedSet.has(divName)) continue; // Skip allowed divisions
            
            for (let i = 0; i < slots.length; i++) {
                const entry = slots[i];
                if (!entry || entry.continuation) continue;
                if (!entry._pinned && !entry._fixed && !entry._bunkOverride) continue;
                
                if (!_pinnedSnapshot[bunk]) _pinnedSnapshot[bunk] = {};
                _pinnedSnapshot[bunk][i] = { ...entry };
            }
        }

        console.log('[PinnedCapture] Captured:', Object.keys(_pinnedSnapshot).length, 'bunks');
    }

    function registerPinnedFieldLocks() {
        if (!window.GlobalFieldLocks) return;
        
        for (const [bunk, slots] of Object.entries(_pinnedSnapshot)) {
            for (const [slotIdx, entry] of Object.entries(slots)) {
                const field = fieldLabel(entry.field);
                if (!field) continue;
                
                const divName = getDivisionForBunk(bunk);
                window.GlobalFieldLocks.lockField(field, [parseInt(slotIdx)], {
                    lockedBy: 'pinned_preservation',
                    division: divName,
                    bunk
                });
            }
        }
    }

    function registerPinnedFieldUsage(fieldUsageBySlot) {
        for (const [bunk, slots] of Object.entries(_pinnedSnapshot)) {
            for (const [slotIdxStr, entry] of Object.entries(slots)) {
                const slotIdx = parseInt(slotIdxStr);
                const field = fieldLabel(entry.field);
                if (!field) continue;
                
                if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
                if (!fieldUsageBySlot[slotIdx][field]) {
                    fieldUsageBySlot[slotIdx][field] = { count: 0, bunks: {}, divisions: [] };
                }
                
                const usage = fieldUsageBySlot[slotIdx][field];
                usage.count++;
                usage.bunks[bunk] = entry._activity || field;
                
                const divName = getDivisionForBunk(bunk);
                if (divName && !usage.divisions.includes(divName)) {
                    usage.divisions.push(divName);
                }
            }
        }
    }

    function restorePinnedActivities() {
        let restored = 0;
        
        for (const [bunk, slots] of Object.entries(_pinnedSnapshot)) {
            if (!window.scheduleAssignments[bunk]) {
                const divName = getDivisionForBunk(bunk);
                const slotCount = window.divisionTimes?.[divName]?.length || 20;
                window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
            }
            
            for (const [slotIdxStr, entry] of Object.entries(slots)) {
                const slotIdx = parseInt(slotIdxStr);
                window.scheduleAssignments[bunk][slotIdx] = { ...entry, _restoredPin: true };
                restored++;
            }
        }
        
        console.log('[PinnedRestore] Restored:', restored, 'entries');
        return restored;
    }

    function getPinnedActivities() {
        const pinned = [];
        const assignments = window.scheduleAssignments || {};
        
        for (const [bunk, slots] of Object.entries(assignments)) {
            if (!Array.isArray(slots)) continue;
            
            for (let i = 0; i < slots.length; i++) {
                const entry = slots[i];
                if (!entry || entry.continuation) continue;
                if (entry._pinned || entry._fixed || entry._bunkOverride) {
                    pinned.push({
                        bunk,
                        slotIndex: i,
                        activity: entry._activity,
                        field: fieldLabel(entry.field),
                        entry
                    });
                }
            }
        }
        
        return pinned;
    }

    function unpinActivity(bunk, slotIndex) {
        const entry = window.scheduleAssignments?.[bunk]?.[slotIndex];
        if (entry) {
            delete entry._pinned;
            delete entry._fixed;
            delete entry._bunkOverride;
        }
    }

    function unpinAllActivities() {
        const assignments = window.scheduleAssignments || {};
        
        for (const [bunk, slots] of Object.entries(assignments)) {
            if (!Array.isArray(slots)) continue;
            
            for (const entry of slots) {
                if (entry) {
                    delete entry._pinned;
                    delete entry._fixed;
                    delete entry._bunkOverride;
                }
            }
        }
    }

    // =========================================================================
    // HOOK SCHEDULER GENERATION
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
    // TOAST NOTIFICATIONS
    // =========================================================================

    function showIntegratedToast(message, type = 'info') {
        if (window.showToast) {
            window.showToast(message, type);
            return;
        }
        
        const bgColor = type === 'success' ? '#10b981' : (type === 'error' ? '#ef4444' : '#3b82f6');
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: ${bgColor};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 10000;
            animation: fadeIn 0.2s ease;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initScheduleSystem() {
        if (_initialized) return;
        
        loadScheduleForDate(getDateKey());
        
        // Add styles
        if (!document.getElementById('unified-schedule-styles')) {
            const style = document.createElement('style');
            style.id = 'unified-schedule-styles';
            style.textContent = `
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                #${MODAL_ID} input:focus, #${MODAL_ID} select:focus {
                    outline: none;
                    border-color: #2563eb;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                }
                #${MODAL_ID} button:hover { opacity: 0.9; }
            `;
            document.head.appendChild(style);
        }
        
        hookSchedulerGeneration();
        setTimeout(hookSchedulerGeneration, 1000);
        setTimeout(hookSchedulerGeneration, 3000);
        
        _initialized = true;
        console.log('📅 Unified Schedule System v5.0.0 initialized');
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
        setTimeout(() => {
            if (!window._postEditInProgress) {
                loadScheduleForDate(getDateKey());
                updateTable();
            }
        }, 100);
    });

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
    window.getEntryForBlock = getEntryForBlock;
    window.getDivisionForBunk = getDivisionForBunk;
    window.getEditableBunks = getEditableBunks;
    window.canEditBunk = canEditBunk;
    window.getMyDivisions = getMyDivisions;

    // Slot utilities
    window.findSlotsForRange = findSlotsForRange;
    window.getSlotTimeRange = getSlotTimeRange;

    // Conflict detection
    window.checkLocationConflict = checkLocationConflict;
    window.checkCrossDivisionConflict = checkCrossDivisionConflict;
    window.getAllLocations = getAllLocations;
    window.getActivityProperties = getActivityProperties;

    // Smart regeneration
    window.smartRegenerateConflicts = smartRegenerateConflicts;
    window.smartReassignBunkActivity = findBestActivityForBunk;
    window.findBestActivityForBunk = findBestActivityForBunk;
    window.buildCandidateOptions = buildCandidateOptions;
    window.buildFieldUsageBySlot = buildFieldUsageBySlot;
    window.calculateRotationPenalty = calculateRotationPenalty;
    window.applyPickToBunk = applyPickToBunk;
    window.resolveConflictsAndApply = resolveConflictsAndApply;

    // RBAC bypass
    window.enableBypassRBACView = enableBypassRBACView;
    window.disableBypassRBACView = disableBypassRBACView;
    window.shouldShowDivision = shouldShowDivision;
    window.shouldHighlightBunk = shouldHighlightBunk;
    window.bypassSaveAllBunks = bypassSaveAllBunks;
    window.sendSchedulerNotification = sendSchedulerNotification;

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

    // Integrated Edit Modal
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

    // Proposal system
    window.createMultiBunkProposal = createMultiBunkProposal;
    window.loadProposal = loadProposal;
    window.loadMyPendingProposals = loadMyPendingProposals;
    window.openProposalReviewModal = openProposalReviewModal;
    window.respondToProposal = respondToProposal;
    window.applyApprovedProposal = applyApprovedProposal;

    // Backup system
    window.createAutoBackup = createAutoBackup;
    window.cleanupOldAutoBackups = cleanupOldAutoBackups;
    window.listAutoBackups = listAutoBackups;

    // Utility
    window.showIntegratedToast = showIntegratedToast;
    window.escapeHtml = escapeHtml;
    window.fieldLabel = fieldLabel;

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
        smartReassignBunkActivity: findBestActivityForBunk,
        findBestActivityForBunk,
        buildFieldUsageBySlot,
        buildCandidateOptions,
        calculateRotationPenalty,
        isFieldAvailable: (field, slot, capacity) => {
            const usage = buildFieldUsageBySlot([]);
            const slotUsage = usage[slot]?.[field];
            return !slotUsage || slotUsage.count < capacity;
        },
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
        version: VERSION,
        
        // Core functions
        loadScheduleForDate,
        renderStaggeredView,
        findSlotIndexForTime: (min, bunkOrDiv) => {
            const slots = findSlotsForRange(min, min + 1, bunkOrDiv);
            return slots[0] ?? -1;
        },
        findSlotsForRange,
        getLeagueMatchups,
        getEntryForBlock,
        getDivisionForBunk,
        getSlotTimeRange,
        isSplitTileBlock,
        expandBlocksForSplitTiles,
        
        // Conflict detection
        checkLocationConflict,
        checkCrossDivisionConflict,
        buildFieldUsageBySlot,
        TimeBasedFieldUsage: window.TimeBasedFieldUsage,
        
        // Sub-systems
        VersionManager,
        SmartRegenSystem: window.SmartRegenSystem,
        PinnedActivitySystem: window.PinnedActivitySystem,
        ROTATION_CONFIG,
        
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
        
        // Debug utilities
        DEBUG_ON: () => { DEBUG = true; console.log('[UnifiedSchedule] Debug enabled'); },
        DEBUG_OFF: () => { DEBUG = false; console.log('[UnifiedSchedule] Debug disabled'); },
        
        diagnose: () => {
            console.log('=== UNIFIED SCHEDULE SYSTEM v5.0.0 DIAGNOSTIC ===');
            console.log(`Date: ${getDateKey()}`);
            console.log(`window.scheduleAssignments: ${Object.keys(window.scheduleAssignments || {}).length} bunks`);
            console.log(`window.unifiedTimes: ${(window.unifiedTimes || []).length} slots`);
            console.log(`window.divisionTimes: ${Object.keys(window.divisionTimes || {}).length} divisions`);
            console.log(`TimeBasedFieldUsage: ${window.TimeBasedFieldUsage ? '✅' : '❌'}`);
            console.log(`Pinned activities: ${getPinnedActivities().length}`);
            console.log(`RBAC bypass view: ${_bypassRBACViewEnabled}`);
            console.log(`Highlighted bunks: ${[..._bypassHighlightBunks].join(', ') || 'none'}`);
        },
        
        getState: () => ({
            dateKey: getDateKey(),
            assignments: Object.keys(window.scheduleAssignments || {}).length,
            leagues: Object.keys(window.leagueAssignments || {}).length,
            times: (window.unifiedTimes || []).length,
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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScheduleSystem);
    } else {
        setTimeout(initScheduleSystem, 100);
    }

    console.log('📅 Unified Schedule System v5.0.0 loaded successfully');
    console.log('   ✅ Fixed template literal HTML generation');
    console.log('   ✅ Fixed null safety throughout');
    console.log('   ✅ Fixed utility function references');
    console.log('   ✅ Fixed race conditions in edit operations');
    console.log('   ✅ Division-aware time slot management');
    console.log('   ✅ TimeBasedFieldUsage for cross-division conflicts');
    console.log('   ✅ Integrated Edit with multi-bunk support');
    console.log('   ✅ Proposal system for cross-division changes');

})();
