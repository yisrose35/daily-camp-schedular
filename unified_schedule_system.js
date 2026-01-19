// =============================================================================
// unified_schedule_system.js v4.0.0 — CAMPISTRY UNIFIED SCHEDULE SYSTEM
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
// CRITICAL FIXES:
// ✅ normalizeUnifiedTimes preserves startMin/endMin (was losing them!)
// ✅ Uses findSlotsForRange() to map skeleton blocks to 30-min slot indices
// ✅ Properly handles variable-length skeleton blocks (60min, 20min, etc.)
// ✅ AUTO-DEBUG: Logs render state to console to help diagnose issues
// ✅ Cloud integration: Listens for cloud-loaded unifiedTimes
// ✅ Version save/load/merge integrated
// ✅ Toolbar hidden by default
// ✅ RBAC and multi-scheduler support
// ✅ v3.5: SPLIT TILE VISUAL FIX - renders split tiles as two rows
// ✅ v3.5.3: LEAGUE MATCHUPS FIX - bunks ≠ league teams, handles array/object formats
// ✅ v4.0: INTEGRATED POST-GENERATION EDITING with smart regeneration
// ✅ v4.0: INTEGRATED PINNED ACTIVITY PRESERVATION
// ✅ v4.0: BYPASS MODE for admin-level access
// ✅ v4.0: Conflict detection and resolution UI
//
// REQUIRES: unified_cloud_schedule_system.js for proper cloud sync
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Unified Schedule System v4.0.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const RENDER_DEBOUNCE_MS = 150;
    let DEBUG = false;
    const HIDE_VERSION_TOOLBAR = true;
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";
    
    let _lastRenderTime = 0;
    let _renderQueued = false;
    let _renderTimeout = null;
    let _initialized = false;
    let _cloudHydrated = false;

    // =========================================================================
    // ROTATION CONFIGURATION (for smart regeneration)
    // =========================================================================
    
    const ROTATION_CONFIG = {
        // Hard rules
        SAME_DAY_PENALTY: Infinity,            // NEVER allow same activity twice in one day

        // Recency penalties (days ago)
        YESTERDAY_PENALTY: 5000,               // Did it yesterday
        TWO_DAYS_AGO_PENALTY: 3000,            // Did it 2 days ago
        THREE_DAYS_AGO_PENALTY: 2000,          // Did it 3 days ago
        FOUR_TO_SEVEN_DAYS_PENALTY: 800,       // Did it 4-7 days ago
        WEEK_PLUS_PENALTY: 200,                // Did it more than a week ago

        // Frequency penalties
        HIGH_FREQUENCY_PENALTY: 1500,          // Done this much more than others
        ABOVE_AVERAGE_PENALTY: 500,            // Done this more than average

        // Variety bonuses (negative = good)
        NEVER_DONE_BONUS: -1500,               // NEVER done this activity before
        UNDER_UTILIZED_BONUS: -800,            // Done less than average

        // Sharing bonus
        ADJACENT_BUNK_BONUS: -100,             // Adjacent bunk doing same activity
        NEARBY_BUNK_BONUS: -30                 // Nearby bunk (within 3) doing same
    };

    // =========================================================================
    // PINNED ACTIVITY STORAGE
    // =========================================================================
    
    let _pinnedSnapshot = {};  // { bunk: { slotIdx: entry } }
    let _pinnedFieldLocks = []; // Track what we locked so we can verify

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
        if (window.SchedulerCoreUtils?.fieldLabel) {
            return window.SchedulerCoreUtils.fieldLabel(f);
        }
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
            if (parent && parent.children.length === 1) {
                parent.style.display = 'none';
            }
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
        // ★★★ Skip loading if post-edit is in progress ★★★
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] 🛡️ Skipping loadScheduleForDate - post-edit in progress');
            console.log('[UnifiedSchedule]   Current scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
            return;
        }

        if (!dateKey) dateKey = getDateKey();
        
        debugLog(`Loading data for: ${dateKey}`);
        
        const dailyData = loadDailyData();
        const dateData = dailyData[dateKey] || {};
        
        // =====================================================================
        // 1. SCHEDULE ASSIGNMENTS - Priority loading
        // =====================================================================
        
        let loadedAssignments = false;
        
        // Priority 1: Window global (set by cloud bridge, version merger, generator)
        if (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0) {
            loadedAssignments = true;
            debugLog('Using window.scheduleAssignments:', Object.keys(window.scheduleAssignments).length);
        }
        // Priority 2: Date-specific localStorage
        else if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            loadedAssignments = true;
            debugLog('Loaded from dateData:', Object.keys(window.scheduleAssignments).length);
        }
        // Priority 3: Root-level legacy
        else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dailyData.scheduleAssignments;
            loadedAssignments = true;
            debugLog('Loaded from root:', Object.keys(window.scheduleAssignments).length);
        }
        
        if (!loadedAssignments) {
            window.scheduleAssignments = window.scheduleAssignments || {};
        }
        
        // =====================================================================
        // 2. LEAGUE ASSIGNMENTS
        // =====================================================================
        
        if (!window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
            if (dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0) {
                window.leagueAssignments = dateData.leagueAssignments;
            } else {
                window.leagueAssignments = {};
            }
        }
        
        // =====================================================================
        // 3. UNIFIED TIMES - Preserve scheduler-generated data
        // =====================================================================
        
        // CRITICAL: Check if unifiedTimes was already loaded from cloud
        // Cloud-loaded times have correct slot count; don't overwrite them
        const cloudLoaded = window._unifiedTimesFromCloud === true;
        
        // Priority 1: Keep existing window.unifiedTimes if valid AND from cloud
        if (cloudLoaded && window.unifiedTimes && window.unifiedTimes.length > 0) {
            debugLog('Using cloud-loaded unifiedTimes:', window.unifiedTimes.length);
            // Don't overwrite - cloud data is authoritative
        }
        // Priority 2: Keep existing window.unifiedTimes if valid (set by scheduler after generation)
        else if (window.unifiedTimes && window.unifiedTimes.length > 0) {
            debugLog('Using existing window.unifiedTimes:', window.unifiedTimes.length);
            // Don't overwrite - scheduler already set this
        }
        // Priority 3: Load from localStorage (saved from previous session)
        else if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
            window.unifiedTimes = normalizeUnifiedTimes(dateData.unifiedTimes);
            debugLog('Loaded unifiedTimes from dateData:', window.unifiedTimes.length);
        }
        // Priority 4: Build from skeleton (fallback)
        else {
            const skeleton = getSkeleton(dateKey);
            if (skeleton.length > 0) {
                window.unifiedTimes = buildUnifiedTimesFromSkeleton(skeleton);
                debugLog('Built unifiedTimes from skeleton:', window.unifiedTimes.length);
            } else {
                window.unifiedTimes = [];
            }
        }
        
        // =====================================================================
        // 4. SKELETON
        // =====================================================================
        
        if (dateData.manualSkeleton && dateData.manualSkeleton.length > 0) {
            window.manualSkeleton = dateData.manualSkeleton;
        } else if (dateData.skeleton && dateData.skeleton.length > 0) {
            window.manualSkeleton = dateData.skeleton;
        }
        
        debugLog('Data state:', {
            assignments: Object.keys(window.scheduleAssignments || {}).length,
            leagues: Object.keys(window.leagueAssignments || {}).length,
            times: (window.unifiedTimes || []).length,
            skeleton: (window.manualSkeleton || window.skeleton || []).length
        });
        
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
               window.dailyOverrideSkeleton ||
               window.manualSkeleton || window.skeleton || [];
    }

    function normalizeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            
            // CRITICAL: Preserve startMin/endMin if present, or compute from Date
            let startMin = t.startMin;
            let endMin = t.endMin;
            
            if (startMin === undefined) {
                startMin = startDate.getHours() * 60 + startDate.getMinutes();
            }
            if (endMin === undefined) {
                endMin = endDate.getHours() * 60 + endDate.getMinutes();
            }
            
            return {
                start: startDate,
                end: endDate,
                startMin: startMin,
                endMin: endMin,
                label: t.label || ''
            };
        });
    }

    /**
     * Build unifiedTimes from skeleton using 30-minute intervals.
     * This matches how scheduler_core_main.js generates the time grid.
     * The scheduler uses INCREMENT_MINS = 30 to create slots.
     */
    function buildUnifiedTimesFromSkeleton(skeleton) {
        const INCREMENT_MINS = 30;
        
        if (!skeleton || skeleton.length === 0) return [];
        
        // Find the earliest start and latest end across ALL divisions
        let minTime = 540; // Default 9 AM
        let maxTime = 960; // Default 4 PM
        let found = false;
        
        skeleton.forEach(block => {
            const startMin = parseTimeToMinutes(block.startTime);
            const endMin = parseTimeToMinutes(block.endTime);
            
            if (startMin !== null) {
                minTime = Math.min(minTime, startMin);
                found = true;
            }
            if (endMin !== null) {
                maxTime = Math.max(maxTime, endMin);
                found = true;
            }
        });
        
        if (!found) return [];
        
        // Round down minTime to nearest 30-min
        minTime = Math.floor(minTime / INCREMENT_MINS) * INCREMENT_MINS;
        
        // Round up maxTime to nearest 30-min
        maxTime = Math.ceil(maxTime / INCREMENT_MINS) * INCREMENT_MINS;
        
        // Generate 30-minute slots from min to max
        const timeSlots = [];
        const baseDate = new Date();
        baseDate.setHours(0, 0, 0, 0);
        
        for (let mins = minTime; mins < maxTime; mins += INCREMENT_MINS) {
            const startDate = new Date(baseDate);
            startDate.setMinutes(mins);
            
            const endDate = new Date(baseDate);
            endDate.setMinutes(mins + INCREMENT_MINS);
            
            timeSlots.push({
                start: startDate,
                end: endDate,
                startMin: mins,
                endMin: mins + INCREMENT_MINS,
                label: `${minutesToTimeLabel(mins)} - ${minutesToTimeLabel(mins + INCREMENT_MINS)}`
            });
        }
        
        debugLog(`Generated ${timeSlots.length} slots (${minutesToTimeLabel(minTime)} - ${minutesToTimeLabel(maxTime)})`);
        
        return timeSlots;
    }

    // =========================================================================
    // SLOT INDEX MAPPING - CRITICAL FOR VARIABLE TIME BLOCKS
    // =========================================================================
    
    /**
     * Get the start time in minutes from a unifiedTimes slot
     */
    function getSlotStartMin(slot) {
        if (!slot) return null;
        if (slot.startMin !== undefined) return slot.startMin;
        if (slot.start instanceof Date) {
            return slot.start.getHours() * 60 + slot.start.getMinutes();
        }
        if (slot.start) {
            const d = new Date(slot.start);
            return d.getHours() * 60 + d.getMinutes();
        }
        return null;
    }

    /**
     * Find ALL slot indices in unifiedTimes that fall within a skeleton block's time range.
     * This is the KEY FIX - skeleton blocks can span multiple 30-min slots.
     */
    function findSlotsForRange(startMin, endMin, unifiedTimes) {
        if (!unifiedTimes || unifiedTimes.length === 0) return [];
        if (startMin === null || endMin === null) return [];
        
        const slots = [];
        
        unifiedTimes.forEach((t, idx) => {
            const slotStart = getSlotStartMin(t);
            if (slotStart !== null && slotStart >= startMin && slotStart < endMin) {
                slots.push(idx);
            }
        });
        
        return slots;
    }
    
    /**
     * Find the FIRST slot index for a time. Uses findSlotsForRange internally.
     */
    function findSlotIndexForTime(targetMin, unifiedTimes) {
        if (!unifiedTimes || unifiedTimes.length === 0 || targetMin === null) {
            return -1;
        }
        
        // First try exact match
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = getSlotStartMin(unifiedTimes[i]);
            if (slotStart === targetMin) {
                return i;
            }
        }
        
        // Try finding slots within a 30-min window
        const slots = findSlotsForRange(targetMin, targetMin + 30, unifiedTimes);
        if (slots.length > 0) return slots[0];
        
        // Closest match (fallback)
        let closest = -1;
        let minDiff = Infinity;
        
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = getSlotStartMin(unifiedTimes[i]);
            if (slotStart !== null) {
                const diff = Math.abs(slotStart - targetMin);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = i;
                }
            }
        }
        
        return closest;
    }
    
    /**
     * Get entry for a skeleton block - searches ALL slots in the bunk's data
     * and finds entries that fall within the block's time range.
     */
    function getEntryForBlock(bunk, startMin, endMin, unifiedTimes) {
        const assignments = window.scheduleAssignments || {};
        
        if (!assignments[bunk]) {
            const fallbackSlots = findSlotsForRange(startMin, endMin, unifiedTimes);
            return { entry: null, slotIdx: fallbackSlots[0] || -1 };
        }
        
        const bunkData = assignments[bunk];
        
        // Method 1: Search ALL slots and match by time
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            
            // Get the time for this slot from unifiedTimes
            let slotStart = null;
            if (unifiedTimes && unifiedTimes[slotIdx]) {
                slotStart = getSlotStartMin(unifiedTimes[slotIdx]);
            }
            
            // Check if this slot's time falls within the skeleton block's range
            if (slotStart !== null && slotStart >= startMin && slotStart < endMin) {
                return { entry, slotIdx };
            }
        }
        
        // Method 2: Use findSlotsForRange as fallback
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        for (const slotIdx of slots) {
            const entry = bunkData[slotIdx];
            if (entry && !entry.continuation) {
                return { entry, slotIdx };
            }
        }
        
        // Method 3: If still nothing, try scanning for entry with matching _blockStart or time metadata
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            
            // Check if entry has time metadata that matches
            const entryStartMin = entry._blockStart || entry._startMin || entry.startMin;
            if (entryStartMin !== undefined && entryStartMin >= startMin && entryStartMin < endMin) {
                return { entry, slotIdx };
            }
        }
        
        return { entry: null, slotIdx: slots[0] || -1 };
    }

    function getSlotTimeRange(slotIdx) {
        const unifiedTimes = window.unifiedTimes || [];
        const slot = unifiedTimes[slotIdx];
        if (!slot) return { startMin: null, endMin: null };
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        return {
            startMin: start.getHours() * 60 + start.getMinutes(),
            endMin: end.getHours() * 60 + end.getMinutes()
        };
    }

    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    }

    // =========================================================================
    // SPLIT TILE DETECTION - v3.5 FIX
    // =========================================================================
    
    /**
     * Detect if a skeleton block is a split tile.
     */
    function isSplitTileBlock(block, bunks, unifiedTimes) {
        if (!block || !block.event) return false;
        
        if (!block.event.includes('/')) return false;
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
            
            const firstEntry = bunkData[firstHalfSlots[0]];
            const secondEntry = bunkData[secondHalfSlots[0]];
            
            if (firstEntry && secondEntry && !firstEntry.continuation && !secondEntry.continuation) {
                const firstAct = formatEntry(firstEntry);
                const secondAct = formatEntry(secondEntry);
                
                if (firstAct && secondAct && firstAct !== secondAct) {
                    debugLog(`Detected split tile: ${block.event} (${firstAct} → ${secondAct})`);
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Expand skeleton blocks, splitting split-tiles into two rows.
     */
    function expandBlocksForSplitTiles(divBlocks, bunks, unifiedTimes) {
        const expandedBlocks = [];
        
        divBlocks.forEach(block => {
            if (isSplitTileBlock(block, bunks, unifiedTimes)) {
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
                
                debugLog(`Expanded split tile: ${block.event} into 2 rows`);
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
        if (entry._isTransition) return '';
        if (entry.continuation) return '';
        
        const activity = entry._activity || '';
        const field = typeof entry.field === 'object' ? entry.field.name : (entry.field || '');
        const sport = entry.sport || '';
        
        if (entry._h2h) {
            return entry._gameLabel || sport || 'League Game';
        }
        
        if (entry._fixed) return activity || field;
        
        if (field && sport && field !== sport) {
            return `${field} – ${sport}`;
        }
        
        return activity || field || '';
    }

    function getEntryBackground(entry, blockEvent) {
        if (!entry) {
            if (blockEvent && isFixedBlockType(blockEvent)) return '#fff8e1';
            return '#f9fafb';
        }
        
        if (entry._isDismissal) return '#ffebee';
        if (entry._isSnack) return '#fff3e0';
        if (entry._isTransition) return '#e8eaf6';
        if (entry._isTrip) return '#e8f5e9';
        if (entry._h2h || entry._isSpecialtyLeague) return '#e3f2fd';
        if (entry._fixed) return '#fff8e1';
        if (entry._fromBackground) return '#f3e5f5';
        if (entry._pinned) return '#fef3c7'; // Yellow tint for pinned
        
        return '#f0f9ff';
    }

    function isFixedBlockType(eventName) {
        if (!eventName) return false;
        const lower = eventName.toLowerCase();
        return lower.includes('lunch') || lower.includes('snack') || 
               lower.includes('swim') || lower.includes('dismissal') ||
               lower.includes('rest') || lower.includes('free');
    }

    function isLeagueBlockType(eventName) {
        if (!eventName) return false;
        return eventName.toLowerCase().includes('league');
    }

    // =========================================================================
    // ACTIVITY PROPERTIES & LOCATIONS
    // =========================================================================

    function getActivityProperties() {
        if (window.activityProperties && Object.keys(window.activityProperties).length > 0) {
            return window.activityProperties;
        }
        
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const props = {};
        
        (app1.fields || []).forEach(f => {
            if (f.name) {
                props[f.name] = {
                    ...f,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || (f.sharableWith?.type === 'all' ? 2 : 1)
                };
            }
        });
        
        (app1.specialActivities || []).forEach(s => {
            if (s.name) {
                props[s.name] = {
                    ...s,
                    type: 'special',
                    capacity: s.sharableWith?.capacity || 1
                };
            }
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
    // RBAC HELPERS
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

    function canEditBunk(bunkName) {
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') return true;
        
        const editableBunks = getEditableBunks();
        return editableBunks.has(bunkName);
    }

    // =========================================================================
    // FIELD USAGE TRACKING
    // =========================================================================

    function buildFieldUsageBySlot(excludeBunks = []) {
        const fieldUsageBySlot = {};
        const assignments = window.scheduleAssignments || {};
        const excludeSet = new Set(excludeBunks);

        for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
            if (excludeSet.has(bunkName)) continue;
            if (!bunkSlots || !Array.isArray(bunkSlots)) continue;

            for (let slotIdx = 0; slotIdx < bunkSlots.length; slotIdx++) {
                const entry = bunkSlots[slotIdx];
                if (!entry || !entry.field) continue;
                if (entry._isTransition || entry.field === TRANSITION_TYPE) continue;

                const fName = fieldLabel(entry.field);
                if (!fName || fName === 'Free') continue;

                if (!fieldUsageBySlot[slotIdx]) {
                    fieldUsageBySlot[slotIdx] = {};
                }

                if (!fieldUsageBySlot[slotIdx][fName]) {
                    fieldUsageBySlot[slotIdx][fName] = {
                        count: 0,
                        bunks: {},
                        divisions: []
                    };
                }

                const usage = fieldUsageBySlot[slotIdx][fName];
                usage.count++;
                usage.bunks[bunkName] = entry._activity || fName;

                const divName = getDivisionForBunk(bunkName);
                if (divName && !usage.divisions.includes(divName)) {
                    usage.divisions.push(divName);
                }
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

    // =========================================================================
    // ROTATION SCORING (for smart regeneration)
    // =========================================================================

    function getActivitiesDoneToday(bunk, beforeSlot) {
        const done = new Set();
        const bunkData = window.scheduleAssignments?.[bunk];
        if (!bunkData) return done;

        for (let i = 0; i < beforeSlot; i++) {
            const entry = bunkData[i];
            if (entry) {
                const actName = entry._activity || entry.sport || fieldLabel(entry.field);
                if (actName && actName.toLowerCase() !== 'free' && !actName.toLowerCase().includes('transition')) {
                    done.add(actName.toLowerCase().trim());
                }
            }
        }
        return done;
    }

    function getActivityCount(bunk, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        return historicalCounts[bunk]?.[activityName] || 0;
    }

    function getDaysSinceActivity(bunk, activityName) {
        const rotationHistory = window.loadRotationHistory?.() || {};
        const bunkHistory = rotationHistory.bunks?.[bunk] || {};
        const lastDone = bunkHistory[activityName];
        
        if (!lastDone) return null;
        
        const now = Date.now();
        const daysSince = Math.floor((now - lastDone) / (24 * 60 * 60 * 1000));
        return daysSince;
    }

    function calculateRotationPenalty(bunk, activityName, slots) {
        if (!activityName || activityName === 'Free') return 0;

        const firstSlot = slots[0];
        const doneToday = getActivitiesDoneToday(bunk, firstSlot);
        const actLower = activityName.toLowerCase().trim();

        // HARD BLOCK: Already done today
        if (doneToday.has(actLower)) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        }

        // Recency penalty
        const daysSince = getDaysSinceActivity(bunk, activityName);
        let recencyPenalty = 0;

        if (daysSince === null) {
            recencyPenalty = ROTATION_CONFIG.NEVER_DONE_BONUS;
        } else if (daysSince === 0) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        } else if (daysSince === 1) {
            recencyPenalty = ROTATION_CONFIG.YESTERDAY_PENALTY;
        } else if (daysSince === 2) {
            recencyPenalty = ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY;
        } else if (daysSince === 3) {
            recencyPenalty = ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY;
        } else if (daysSince <= 7) {
            recencyPenalty = ROTATION_CONFIG.FOUR_TO_SEVEN_DAYS_PENALTY;
        } else {
            recencyPenalty = ROTATION_CONFIG.WEEK_PLUS_PENALTY;
        }

        // Frequency penalty
        const count = getActivityCount(bunk, activityName);
        let frequencyPenalty = 0;
        if (count > 5) {
            frequencyPenalty = ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY;
        } else if (count > 3) {
            frequencyPenalty = ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        } else if (count === 0) {
            frequencyPenalty = ROTATION_CONFIG.UNDER_UTILIZED_BONUS;
        }

        return recencyPenalty + frequencyPenalty;
    }

    // =========================================================================
    // FIELD AVAILABILITY CHECK
    // =========================================================================

    function isFieldAvailable(fieldName, slots, excludeBunk, fieldUsageBySlot, activityProperties) {
        const divName = getDivisionForBunk(excludeBunk);
        
        // Check GlobalFieldLocks
        if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots, divName)) {
            return false;
        }

        // Check disabled fields
        const disabledFields = window.currentDisabledFields || [];
        if (disabledFields.includes(fieldName)) {
            return false;
        }

        // Check capacity
        const props = activityProperties[fieldName] || {};
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable) {
            maxCapacity = 2;
        }

        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
            if (slotUsage && slotUsage.count >= maxCapacity) {
                return false;
            }
        }

        return true;
    }

    // =========================================================================
    // BUILD CANDIDATE OPTIONS (for smart regeneration)
    // =========================================================================

    function buildCandidateOptions(slots, activityProperties, disabledFields = []) {
        const options = [];
        const seenKeys = new Set();
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};

        // From fields (sports) - using fieldsBySport
        const fieldsBySport = settings.fieldsBySport || {};
        for (const [sport, sportFields] of Object.entries(fieldsBySport)) {
            (sportFields || []).forEach(fieldName => {
                if (disabledFields.includes(fieldName)) return;

                if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots)) {
                    return;
                }

                const key = `${fieldName}|${sport}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: fieldName,
                        sport: sport,
                        activityName: sport,
                        type: 'sport'
                    });
                }
            });
        }

        // From special activities
        const specials = app1.specialActivities || [];
        for (const special of specials) {
            if (!special.name) continue;
            if (disabledFields.includes(special.name)) continue;

            if (window.GlobalFieldLocks?.isFieldLocked(special.name, slots)) {
                continue;
            }

            const key = `special|${special.name}`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                options.push({
                    field: special.name,
                    sport: null,
                    activityName: special.name,
                    type: 'special'
                });
            }
        }

        // Also add fields directly if they support general activities
        const fields = app1.fields || [];
        for (const field of fields) {
            if (!field.name || field.available === false) continue;
            if (disabledFields.includes(field.name)) continue;

            if (window.GlobalFieldLocks?.isFieldLocked(field.name, slots)) {
                continue;
            }

            (field.activities || []).forEach(activity => {
                const key = `${field.name}|${activity}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: field.name,
                        sport: activity,
                        activityName: activity,
                        type: 'sport'
                    });
                }
            });
        }

        return options;
    }

    // =========================================================================
    // CALCULATE FULL PENALTY COST
    // =========================================================================

    function calculatePenaltyCost(bunk, slots, pick, fieldUsageBySlot, activityProperties) {
        let penalty = 0;
        const activityName = pick.activityName || pick._activity || pick.sport;
        const fieldName = pick.field;
        const divName = getDivisionForBunk(bunk);

        // Rotation penalty (PRIMARY FACTOR)
        const rotationPenalty = calculateRotationPenalty(bunk, activityName, slots);
        if (rotationPenalty === Infinity) {
            return Infinity;
        }
        penalty += rotationPenalty;

        // Division preference bonus
        const props = activityProperties[fieldName] || {};
        if (props.preferences?.enabled && props.preferences?.list) {
            const prefList = props.preferences.list;
            const idx = prefList.indexOf(divName);
            if (idx !== -1) {
                penalty -= (50 - idx * 5);
            } else if (props.preferences.exclusive) {
                return Infinity;
            } else {
                penalty += 500;
            }
        }

        // Sharing bonus (adjacent bunks doing same activity)
        const myNum = parseInt((bunk.match(/\d+/) || [])[0]) || 0;
        
        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
            if (slotUsage && slotUsage.bunks) {
                for (const otherBunk of Object.keys(slotUsage.bunks)) {
                    if (otherBunk === bunk) continue;
                    const otherNum = parseInt((otherBunk.match(/\d+/) || [])[0]) || 0;
                    const distance = Math.abs(myNum - otherNum);
                    if (distance === 1) {
                        penalty += ROTATION_CONFIG.ADJACENT_BUNK_BONUS;
                    } else if (distance <= 3) {
                        penalty += ROTATION_CONFIG.NEARBY_BUNK_BONUS;
                    }
                }
            }
        }

        // Usage limit check
        const maxUsage = props.maxUsage || 0;
        if (maxUsage > 0) {
            const hist = getActivityCount(bunk, activityName);
            if (hist >= maxUsage) {
                return Infinity;
            }
            if (hist >= maxUsage - 1) {
                penalty += 2000;
            }
        }

        return penalty;
    }

    // =========================================================================
    // FIND BEST ACTIVITY FOR BUNK (Mini-solver)
    // =========================================================================

    function findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, avoidFields = []) {
        const disabledFields = window.currentDisabledFields || [];
        const avoidSet = new Set(avoidFields.map(f => f.toLowerCase()));

        const candidates = buildCandidateOptions(slots, activityProperties, disabledFields);
        
        debugLog(`Finding best activity for ${bunk} at slots ${slots.join(',')}`);
        debugLog(`  ${candidates.length} candidates available, avoiding: ${avoidFields.join(', ')}`);

        const scoredPicks = [];

        for (const cand of candidates) {
            const fieldName = cand.field;
            const activityName = cand.activityName;

            if (avoidSet.has(fieldName.toLowerCase()) || avoidSet.has(activityName?.toLowerCase())) {
                continue;
            }

            if (!isFieldAvailable(fieldName, slots, bunk, fieldUsageBySlot, activityProperties)) {
                continue;
            }

            const cost = calculatePenaltyCost(bunk, slots, cand, fieldUsageBySlot, activityProperties);

            if (cost < Infinity) {
                scoredPicks.push({
                    field: fieldName,
                    sport: cand.sport,
                    activityName: activityName,
                    type: cand.type,
                    cost: cost
                });
            }
        }

        scoredPicks.sort((a, b) => a.cost - b.cost);

        debugLog(`  ${scoredPicks.length} valid picks after filtering`);
        if (scoredPicks.length > 0) {
            debugLog(`  Best pick: ${scoredPicks[0].activityName} on ${scoredPicks[0].field} (cost: ${scoredPicks[0].cost})`);
        }

        return scoredPicks.length > 0 ? scoredPicks[0] : null;
    }

    // =========================================================================
    // APPLY PICK TO BUNK
    // =========================================================================

    function applyPickToBunk(bunk, slots, pick, fieldUsageBySlot, activityProperties) {
        const divName = getDivisionForBunk(bunk);
        const unifiedTimes = window.unifiedTimes || [];
        
        // ★★★ FIX: Get time metadata so getEntryForBlock can find entries across divisions ★★★
        let startMin = null;
        let endMin = null;
        if (slots.length > 0 && unifiedTimes[slots[0]]) {
            startMin = getSlotStartMin(unifiedTimes[slots[0]]);
            const lastSlot = unifiedTimes[slots[slots.length - 1]];
            if (lastSlot) {
                endMin = lastSlot.endMin !== undefined ? lastSlot.endMin : (getSlotStartMin(lastSlot) + 30);
            }
        }
        
        const pickData = {
            field: pick.field,
            sport: pick.sport,
            _fixed: true,
            _activity: pick.activityName,
            _smartRegenerated: true,
            _regeneratedAt: Date.now(),
            _startMin: startMin,
            _endMin: endMin,
            _blockStart: startMin
        };

        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
        }

        slots.forEach((slotIdx, i) => {
            window.scheduleAssignments[bunk][slotIdx] = {
                ...pickData,
                continuation: i > 0
            };
        });
        
        debugLog(`  ✅ Updated window.scheduleAssignments[${bunk}] slots ${slots.join(',')}`);

        // Also call fillBlock if available (for any side effects it may have)
        if (typeof window.fillBlock === 'function') {
            debugLog(`  Also calling fillBlock for ${bunk}`);
            try {
                const firstSlotTime = getSlotTimeRange(slots[0]);
                const lastSlotTime = getSlotTimeRange(slots[slots.length - 1]);
                
                const block = {
                    divName: divName,
                    bunk: bunk,
                    startTime: firstSlotTime.startMin,
                    endTime: lastSlotTime.endMin,
                    slots: slots
                };
                window.fillBlock(block, pickData, fieldUsageBySlot, window.yesterdayHistory || {}, false, activityProperties);
            } catch (e) {
                console.warn(`[UnifiedSchedule] fillBlock error for ${bunk}:`, e);
            }
        }

        // Register field usage
        const fieldName = pick.field;
        for (const slotIdx of slots) {
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            if (!fieldUsageBySlot[slotIdx][fieldName]) {
                fieldUsageBySlot[slotIdx][fieldName] = {
                    count: 0,
                    bunks: {},
                    divisions: []
                };
            }
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++;
            usage.bunks[bunk] = pick.activityName;
            if (divName && !usage.divisions.includes(divName)) {
                usage.divisions.push(divName);
            }
        }

        debugLog(`  ✅ Applied ${pick.activityName} on ${pick.field} to ${bunk}`);
    }

    // =========================================================================
    // SMART REGENERATION FOR CONFLICTS
    // =========================================================================

    function smartRegenerateConflicts(pinnedBunk, pinnedSlots, pinnedField, pinnedActivity, conflicts, bypassMode = false) {
        console.log('\n' + '='.repeat(60));
        console.log('[SmartRegen] ★★★ SMART REGENERATION STARTED ★★★');
        if (bypassMode) {
            console.log('[SmartRegen] 🔓 BYPASS MODE ACTIVE - Operating with ADMIN privileges');
        }
        console.log('='.repeat(60));
        
        debugLog('Pinned:', { bunk: pinnedBunk, slots: pinnedSlots, field: pinnedField, activity: pinnedActivity });
        debugLog('Conflicts:', conflicts.length);

        const activityProperties = getActivityProperties();
        const results = {
            success: true,
            reassigned: [],
            failed: [],
            pinnedLock: null,
            bypassMode: bypassMode
        };

        // STEP 1: Lock the pinned field in GlobalFieldLocks
        if (window.GlobalFieldLocks) {
            const pinnedDivName = getDivisionForBunk(pinnedBunk);
            window.GlobalFieldLocks.lockField(pinnedField, pinnedSlots, {
                lockedBy: 'smart_regen_pinned',
                division: pinnedDivName,
                activity: pinnedActivity,
                bunk: pinnedBunk
            });
            results.pinnedLock = { field: pinnedField, slots: pinnedSlots };
            debugLog('Step 1: Locked pinned field in GlobalFieldLocks');
        }

        // STEP 2: Group conflicts by bunk
        const conflictsByBunk = {};
        for (const conflict of conflicts) {
            if (!conflictsByBunk[conflict.bunk]) {
                conflictsByBunk[conflict.bunk] = new Set();
            }
            conflictsByBunk[conflict.bunk].add(conflict.slot);
        }

        debugLog(`Step 2: ${Object.keys(conflictsByBunk).length} bunks need reassignment`);

        // STEP 3: Build fieldUsageBySlot EXCLUDING conflicting bunks
        const bunksToReassign = Object.keys(conflictsByBunk);
        const fieldUsageBySlot = buildFieldUsageBySlot(bunksToReassign);
        
        // Add the pinned bunk's usage
        for (const slotIdx of pinnedSlots) {
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            if (!fieldUsageBySlot[slotIdx][pinnedField]) {
                fieldUsageBySlot[slotIdx][pinnedField] = {
                    count: 0,
                    bunks: {},
                    divisions: []
                };
            }
            const usage = fieldUsageBySlot[slotIdx][pinnedField];
            usage.count++;
            usage.bunks[pinnedBunk] = pinnedActivity;
        }

        debugLog('Step 3: Built fieldUsageBySlot');

        // STEP 4: Sort and process bunks
        bunksToReassign.sort((a, b) => {
            const numA = parseInt((a.match(/\d+/) || [])[0]) || 0;
            const numB = parseInt((b.match(/\d+/) || [])[0]) || 0;
            return numA - numB;
        });

        debugLog('Step 4: Processing bunks in order:', bunksToReassign.join(', '));

        for (const bunk of bunksToReassign) {
            const slotSet = conflictsByBunk[bunk];
            const slots = [...slotSet].sort((a, b) => a - b);
            
            debugLog(`\nProcessing ${bunk} for slots: ${slots.join(', ')}`);

            const originalEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            const originalActivity = originalEntry?._activity || originalEntry?.sport || fieldLabel(originalEntry?.field);
            
            debugLog(`  Original activity: ${originalActivity || 'none'}`);

            const bestPick = findBestActivityForBunk(
                bunk, 
                slots, 
                fieldUsageBySlot, 
                activityProperties, 
                [pinnedField]
            );

            if (bestPick) {
                applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProperties);
                
                results.reassigned.push({
                    bunk: bunk,
                    slots: slots,
                    from: originalActivity || 'unknown',
                    to: bestPick.activityName,
                    field: bestPick.field,
                    cost: bestPick.cost
                });

                if (window.showToast) {
                    window.showToast(`↪️ ${bunk}: ${originalActivity} → ${bestPick.activityName}`, 'info');
                }
            } else {
                debugLog(`  ⚠️ No valid pick found for ${bunk}, marking as Free`);
                
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
                }

                slots.forEach((slotIdx, i) => {
                    window.scheduleAssignments[bunk][slotIdx] = {
                        field: 'Free',
                        sport: null,
                        continuation: i > 0,
                        _fixed: false,
                        _activity: 'Free',
                        _smartRegenFailed: true,
                        _originalActivity: originalActivity,
                        _failedAt: Date.now()
                    };
                });

                results.failed.push({
                    bunk: bunk,
                    slots: slots,
                    originalActivity: originalActivity,
                    reason: 'No valid alternative found'
                });

                results.success = false;

                if (window.showToast) {
                    window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
                }
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('[SmartRegen] ★★★ REGENERATION COMPLETE ★★★');
        console.log(`  Reassigned: ${results.reassigned.length} bunks`);
        console.log(`  Failed: ${results.failed.length} bunks`);
        if (bypassMode) {
            console.log('  Mode: BYPASS (admin privileges)');
        }
        console.log('='.repeat(60) + '\n');

        // ★★★ VERIFICATION: Confirm changes are in window.scheduleAssignments ★★★
        console.log('[SmartRegen] VERIFICATION - checking window.scheduleAssignments:');
        for (const r of results.reassigned) {
            const bunkData = window.scheduleAssignments?.[r.bunk];
            if (bunkData) {
                const firstSlot = r.slots[0];
                const entry = bunkData[firstSlot];
                const activity = entry?._activity || entry?.field || 'MISSING';
                console.log(`  ✅ Bunk ${r.bunk} slot ${firstSlot}: "${activity}" (expected: "${r.to}")`);
                if (activity !== r.to && activity !== 'MISSING') {
                    console.warn(`  ⚠️ MISMATCH! Entry has "${activity}" but expected "${r.to}"`);
                }
            } else {
                console.error(`  ❌ Bunk ${r.bunk}: NO DATA IN scheduleAssignments!`);
            }
        }

        return results;
    }

    // =========================================================================
    // SMART REASSIGN BUNK ACTIVITY
    // =========================================================================

    function smartReassignBunkActivity(bunk, slots, avoidLocation) {
        debugLog(`smartReassignBunkActivity called for ${bunk}`);
        
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) {
            console.warn(`[UnifiedSchedule] No existing entry for ${bunk} at slot ${slots[0]}`);
            return { success: false };
        }

        const originalActivity = entry._activity || entry.sport || fieldLabel(entry.field);
        const activityProperties = getActivityProperties();
        const fieldUsageBySlot = buildFieldUsageBySlot([bunk]);

        const bestPick = findBestActivityForBunk(
            bunk,
            slots,
            fieldUsageBySlot,
            activityProperties,
            [avoidLocation]
        );

        if (bestPick) {
            applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProperties);

            if (window.showToast) {
                window.showToast(`↪️ ${bunk}: Moved to ${bestPick.activityName}`, 'info');
            }

            return {
                success: true,
                field: bestPick.field,
                activity: bestPick.activityName,
                cost: bestPick.cost
            };
        } else {
            console.warn(`[UnifiedSchedule] ⚠️ No alternative found for ${bunk}, marking as Free`);

            if (!window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
            }

            slots.forEach((slotIdx, i) => {
                window.scheduleAssignments[bunk][slotIdx] = {
                    field: 'Free',
                    sport: null,
                    continuation: i > 0,
                    _fixed: false,
                    _activity: 'Free',
                    _noAlternative: true,
                    _originalActivity: originalActivity,
                    _originalField: avoidLocation
                };
            });

            if (window.showToast) {
                window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
            }

            return { success: false, reason: 'No valid alternative found' };
        }
    }

    // =========================================================================
    // PINNED ACTIVITY PRESERVATION
    // =========================================================================

    /**
     * Scan current scheduleAssignments and capture all pinned entries
     */
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
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => allowedBunks.add(b));
                }
            }
        }
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (allowedBunks && !allowedBunks.has(bunkName)) {
                continue;
            }
            
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                
                if (entry && entry._pinned === true) {
                    if (!_pinnedSnapshot[bunkName]) {
                        _pinnedSnapshot[bunkName] = {};
                    }
                    
                    _pinnedSnapshot[bunkName][slotIdx] = {
                        ...entry,
                        _preservedAt: Date.now()
                    };
                    
                    capturedCount++;
                    
                    const fieldName = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                    if (fieldName && fieldName !== 'Free') {
                        _pinnedFieldLocks.push({
                            field: fieldName,
                            slot: slotIdx,
                            bunk: bunkName,
                            activity: entry._activity || fieldName
                        });
                    }
                }
            }
        }
        
        console.log(`[PinnedPreserve] 📌 Captured ${capturedCount} pinned activities from ${Object.keys(_pinnedSnapshot).length} bunks`);
        
        if (_pinnedFieldLocks.length > 0) {
            console.log(`[PinnedPreserve] 🔒 Will lock ${_pinnedFieldLocks.length} field-slot combinations`);
        }
        
        return _pinnedSnapshot;
    }

    /**
     * Lock all fields used by pinned activities
     */
    function registerPinnedFieldLocks() {
        if (!window.GlobalFieldLocks) {
            console.warn('[PinnedPreserve] GlobalFieldLocks not available');
            return;
        }
        
        const divisions = window.divisions || {};
        let locksRegistered = 0;
        
        for (const lockInfo of _pinnedFieldLocks) {
            const divName = Object.keys(divisions).find(d => 
                divisions[d]?.bunks?.includes(lockInfo.bunk)
            );
            
            const success = window.GlobalFieldLocks.lockField(
                lockInfo.field,
                [lockInfo.slot],
                {
                    lockedBy: 'pinned_activity',
                    division: divName || 'unknown',
                    activity: lockInfo.activity,
                    bunk: lockInfo.bunk,
                    _pinnedLock: true
                }
            );
            
            if (success !== false) {
                locksRegistered++;
            }
        }
        
        console.log(`[PinnedPreserve] 🔒 Registered ${locksRegistered}/${_pinnedFieldLocks.length} field locks for pinned activities`);
    }

    /**
     * Register in fieldUsageBySlot
     */
    function registerPinnedFieldUsage(fieldUsageBySlot, activityProperties) {
        if (!fieldUsageBySlot) return;
        
        const divisions = window.divisions || {};
        
        for (const lockInfo of _pinnedFieldLocks) {
            const slotIdx = lockInfo.slot;
            const fieldName = lockInfo.field;
            
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            
            const props = activityProperties?.[fieldName] || {};
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                maxCapacity = 2;
            }
            
            if (!fieldUsageBySlot[slotIdx][fieldName]) {
                fieldUsageBySlot[slotIdx][fieldName] = {
                    count: 0,
                    divisions: [],
                    bunks: {},
                    _locked: true,
                    _fromPinned: true
                };
            }
            
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++;
            usage.bunks[lockInfo.bunk] = lockInfo.activity;
            
            const divName = Object.keys(divisions).find(d => 
                divisions[d]?.bunks?.includes(lockInfo.bunk)
            );
            if (divName && !usage.divisions.includes(divName)) {
                usage.divisions.push(divName);
            }
        }
        
        console.log(`[PinnedPreserve] 📊 Registered pinned field usage in fieldUsageBySlot`);
    }

    /**
     * Restore all captured pinned activities
     */
    function restorePinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        let restoredCount = 0;
        
        for (const [bunkName, pinnedSlots] of Object.entries(_pinnedSnapshot)) {
            if (!assignments[bunkName]) {
                const totalSlots = (window.unifiedTimes || []).length;
                assignments[bunkName] = new Array(totalSlots);
            }
            
            for (const [slotIdxStr, entry] of Object.entries(pinnedSlots)) {
                const slotIdx = parseInt(slotIdxStr, 10);
                
                assignments[bunkName][slotIdx] = {
                    ...entry,
                    _restoredAt: Date.now()
                };
                
                restoredCount++;
            }
        }
        
        console.log(`[PinnedPreserve] ✅ Restored ${restoredCount} pinned activities`);
        
        return restoredCount;
    }

    /**
     * Get all currently pinned activities
     */
    function getPinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        const pinned = [];
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    pinned.push({
                        bunk: bunkName,
                        slot: slotIdx,
                        activity: entry._activity || entry.field,
                        field: typeof entry.field === 'object' ? entry.field?.name : entry.field,
                        editedAt: entry._editedAt || entry._preservedAt
                    });
                }
            }
        }
        
        return pinned;
    }

    /**
     * Remove the pinned flag from a specific entry
     */
    function unpinActivity(bunk, slotIdx) {
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry) {
            delete entry._pinned;
            delete entry._postEdit;
            entry._unpinnedAt = Date.now();
            
            saveSchedule();
            updateTable();
            
            console.log(`[PinnedPreserve] 📌❌ Unpinned ${bunk} at slot ${slotIdx}`);
            return true;
        }
        return false;
    }

    /**
     * Unpin all activities
     */
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
        
        console.log(`[PinnedPreserve] 📌❌ Unpinned ${unpinnedCount} activities`);
        return unpinnedCount;
    }

    // =========================================================================
    // LEAGUE MATCHUPS RETRIEVAL - v3.5.2 FIX
    // =========================================================================

    function getLeagueMatchups(divName, slotIdx) {
        const leagues = window.leagueAssignments || {};
        
        if (leagues[divName] && leagues[divName][slotIdx]) {
            const data = leagues[divName][slotIdx];
            console.log(`[getLeagueMatchups] ✅ Found matchups for ${divName} at slot ${slotIdx}:`, data);
            return {
                matchups: data.matchups || [],
                gameLabel: data.gameLabel || '',
                sport: data.sport || '',
                leagueName: data.leagueName || ''
            };
        }
        
        if (leagues[divName]) {
            const divSlots = Object.keys(leagues[divName]).map(Number).sort((a, b) => a - b);
            for (const storedSlot of divSlots) {
                if (Math.abs(storedSlot - slotIdx) <= 2) {
                    const data = leagues[divName][storedSlot];
                    if (data && (data.matchups?.length > 0 || data.gameLabel)) {
                        console.log(`[getLeagueMatchups] ✅ Found matchups for ${divName} at nearby slot ${storedSlot} (requested ${slotIdx}):`, data);
                        return {
                            matchups: data.matchups || [],
                            gameLabel: data.gameLabel || '',
                            sport: data.sport || '',
                            leagueName: data.leagueName || ''
                        };
                    }
                }
            }
        }
        
        const rawMasterLeagues = window.masterLeagues || 
                             window.loadGlobalSettings?.()?.app1?.leagues || 
                             [];
        
        let masterLeaguesList = [];
        if (Array.isArray(rawMasterLeagues)) {
            masterLeaguesList = rawMasterLeagues;
        } else if (rawMasterLeagues && typeof rawMasterLeagues === 'object') {
            masterLeaguesList = Object.values(rawMasterLeagues);
        }
        
        const applicableLeagues = masterLeaguesList.filter(league => {
            if (!league || !league.name || !league.divisions) return false;
            return league.divisions.includes(divName);
        });
        
        if (applicableLeagues.length > 0) {
            const league = applicableLeagues[0];
            const teams = league.teams || [];
            
            if (teams.length >= 2) {
                console.log(`[getLeagueMatchups] 📋 Found league "${league.name}" for ${divName} with ${teams.length} teams`);
                
                const displayMatchups = [];
                for (let i = 0; i < teams.length - 1; i += 2) {
                    if (teams[i + 1]) {
                        displayMatchups.push({
                            teamA: teams[i],
                            teamB: teams[i + 1],
                            display: `${teams[i]} vs ${teams[i + 1]}`
                        });
                    }
                }
                if (teams.length % 2 === 1) {
                    displayMatchups.push({
                        teamA: teams[teams.length - 1],
                        teamB: 'BYE',
                        display: `${teams[teams.length - 1]} (BYE)`
                    });
                }
                
                return {
                    matchups: displayMatchups,
                    gameLabel: `${league.name} Game`,
                    sport: league.sports?.[0] || 'League',
                    leagueName: league.name
                };
            }
        }
        
        console.log(`[getLeagueMatchups] ⚠️ No league data found for ${divName} at slot ${slotIdx}`);
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
        
        // ★★★ CRITICAL: Only load from storage if NOT in post-edit mode ★★★
        // When _postEditInProgress is true, we MUST use the in-memory data
        if (!window._postEditInProgress) {
            loadScheduleForDate(dateKey);
        } else {
            console.log('[UnifiedSchedule] 🛡️ RENDER: Using in-memory data (post-edit in progress)');
            console.log('[UnifiedSchedule]   scheduleAssignments has', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        }
        
        const skeleton = getSkeleton(dateKey);
        const unifiedTimes = window.unifiedTimes || [];
        const divisions = window.divisions || {};
        
        console.log('[UnifiedSchedule] RENDER STATE:', {
            dateKey,
            skeletonBlocks: skeleton.length,
            unifiedTimesSlots: unifiedTimes.length,
            scheduleAssignmentsBunks: Object.keys(window.scheduleAssignments || {}).length,
            leagueAssignmentsDivs: Object.keys(window.leagueAssignments || {}).length,
            divisionsCount: Object.keys(divisions).length
        });
        
        container.innerHTML = '';
        
        if (!skeleton || skeleton.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: #6b7280;">
                    <p style="font-size: 1.1rem; margin-bottom: 10px;">No daily schedule structure found for this date.</p>
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
                    <p>No divisions configured. Go to the <strong>Divisions</strong> tab to create divisions.</p>
                </div>
            `;
            return;
        }
        
        const wrapper = document.createElement('div');
        wrapper.className = 'schedule-view-wrapper';
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 24px;';
        
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || divisionsToShow;
        
        divisionsToShow.forEach(divName => {
            const divInfo = divisions[divName];
            if (!divInfo) return;
            
            let bunks = divInfo.bunks || [];
            if (bunks.length === 0) return;
            
            bunks = bunks.slice().sort((a, b) => 
                String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
            );
            
            const isEditable = editableDivisions.includes(divName);
            const table = renderDivisionTable(divName, divInfo, bunks, skeleton, unifiedTimes, isEditable);
            if (table) wrapper.appendChild(table);
        });
        
        container.appendChild(wrapper);
        
        if (window.MultiSchedulerAutonomous?.applyBlockingToGrid) {
            setTimeout(() => window.MultiSchedulerAutonomous.applyBlockingToGrid(), 50);
        }
        
        window.dispatchEvent(new CustomEvent('campistry-schedule-rendered', {
            detail: { dateKey }
        }));
        
        console.log('[UnifiedSchedule] Render complete');
    }

    function renderDivisionTable(divName, divInfo, bunks, skeleton, unifiedTimes, isEditable) {
        let divBlocks = skeleton
            .filter(b => b.division === divName)
            .map(b => ({
                ...b,
                startMin: parseTimeToMinutes(b.startTime),
                endMin: parseTimeToMinutes(b.endTime)
            }))
            .filter(b => b.startMin !== null && b.endMin !== null)
            .sort((a, b) => a.startMin - b.startMin);
        
        if (divBlocks.length === 0) {
            console.log(`[UnifiedSchedule] No skeleton blocks for division: ${divName}`);
            return null;
        }
        
        divBlocks = expandBlocksForSplitTiles(divBlocks, bunks, unifiedTimes);
        
        const table = document.createElement('table');
        table.className = 'schedule-division-table';
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
            background: #fff;
            margin-bottom: 8px;
        `;
        
        const divColor = divInfo.color || '#4b5563';
        
        // HEADER
        const thead = document.createElement('thead');
        
        const tr1 = document.createElement('tr');
        const th = document.createElement('th');
        th.colSpan = 1 + bunks.length;
        th.innerHTML = escapeHtml(divName) + (isEditable ? '' : ' <span style="opacity:0.7">🔒</span>');
        th.style.cssText = `
            background: ${divColor};
            color: #fff;
            padding: 12px 16px;
            font-size: 1.1rem;
            font-weight: 600;
            text-align: left;
        `;
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
        
        // BODY
        const tbody = document.createElement('tbody');
        
        divBlocks.forEach((block, blockIdx) => {
            const timeLabel = `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`;
            
            const tr = document.createElement('tr');
            tr.style.background = blockIdx % 2 === 0 ? '#fff' : '#fafafa';
            
            if (block._isSplitTile) {
                tr.style.background = block._splitHalf === 1 
                    ? (blockIdx % 2 === 0 ? '#f0fdf4' : '#ecfdf5')
                    : (blockIdx % 2 === 0 ? '#fef3c7' : '#fef9c3');
            }
            
            const tdTime = document.createElement('td');
            tdTime.textContent = timeLabel;
            tdTime.style.cssText = 'padding: 10px 12px; font-weight: 500; color: #4b5563; border-right: 1px solid #e5e7eb; white-space: nowrap;';
            
            if (block._isSplitTile) {
                const halfLabel = block._splitHalf === 1 ? '①' : '②';
                tdTime.innerHTML = `${escapeHtml(timeLabel)} <span style="color: #6b7280; font-size: 0.8rem;">${halfLabel}</span>`;
            }
            
            tr.appendChild(tdTime);
            
            if (isLeagueBlockType(block.event)) {
                const td = renderLeagueCell(block, bunks, divName, unifiedTimes, isEditable);
                tr.appendChild(td);
                tbody.appendChild(tr);
                return;
            }
            
            bunks.forEach(bunk => {
                const td = renderBunkCell(block, bunk, divName, unifiedTimes, isEditable);
                tr.appendChild(td);
            });
            
            tbody.appendChild(tr);
        });
        
        table.appendChild(tbody);
        return table;
    }

    function renderLeagueCell(block, bunks, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.colSpan = bunks.length;
        td.style.cssText = `
            padding: 12px 16px;
            background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%);
            border-left: 4px solid #0284c7;
            vertical-align: top;
        `;
        
        const slots = findSlotsForRange(block.startMin, block.endMin, unifiedTimes);
        const slotIdx = slots.length > 0 ? slots[0] : -1;
        
        let leagueInfo = { matchups: [], gameLabel: '', sport: '', leagueName: '' };
        for (const idx of slots) {
            const info = getLeagueMatchups(divName, idx);
            if (info.matchups.length > 0 || info.gameLabel) {
                leagueInfo = info;
                break;
            }
        }
        
        let title = leagueInfo.gameLabel || block.event;
        if (leagueInfo.sport && !title.toLowerCase().includes(leagueInfo.sport.toLowerCase())) {
            title += ` - ${leagueInfo.sport}`;
        }
        
        let html = `<div style="font-weight: 600; font-size: 1rem; color: #0369a1; margin-bottom: 8px;">🏆 ${escapeHtml(title)}</div>`;
        
        if (leagueInfo.matchups && leagueInfo.matchups.length > 0) {
            html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
            
            leagueInfo.matchups.forEach(m => {
                let matchText;
                if (typeof m === 'string') {
                    matchText = m;
                } else if (m.display) {
                    matchText = m.display;
                } else if (m.teamA && m.teamB) {
                    matchText = `${m.teamA} vs ${m.teamB}`;
                    if (m.field) matchText += ` @ ${m.field}`;
                    if (m.sport) matchText += ` (${m.sport})`;
                } else if (m.team1 && m.team2) {
                    matchText = `${m.team1} vs ${m.team2}`;
                    if (m.field) matchText += ` @ ${m.field}`;
                    if (m.sport) matchText += ` (${m.sport})`;
                } else if (m.matchup) {
                    matchText = m.matchup;
                    if (m.field) matchText += ` @ ${m.field}`;
                } else {
                    matchText = JSON.stringify(m);
                }
                
                html += `<div style="background: #fff; padding: 6px 12px; border-radius: 6px; font-size: 0.875rem; font-weight: normal; color: #1e3a5f; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${escapeHtml(matchText)}</div>`;
            });
            
            html += '</div>';
        } else {
            html += '<div style="color: #64748b; font-size: 0.875rem; font-style: italic; font-weight: normal;">No matchups scheduled yet - run schedule generation</div>';
        }
        
        td.innerHTML = html;
        
        if (isEditable && bunks.length > 0) {
            td.style.cursor = 'pointer';
            td.onclick = () => enhancedEditCell(bunks[0], block.startMin, block.endMin, block.event);
        }
        
        return td;
    }

    function renderBunkCell(block, bunk, divName, unifiedTimes, isEditable) {
        const td = document.createElement('td');
        td.style.cssText = 'padding: 8px 10px; text-align: center; border: 1px solid #e5e7eb;';
        
        const { entry, slotIdx } = getEntryForBlock(bunk, block.startMin, block.endMin, unifiedTimes);
        
        // ★★★ DIAGNOSTIC: Log if this bunk was recently modified ★★★
        if (entry && (entry._smartRegenerated || entry._postEdit)) {
            console.log(`[RenderCell] 📊 ${bunk} slot ${slotIdx}: "${entry._activity}" (smartRegen=${!!entry._smartRegenerated}, postEdit=${!!entry._postEdit})`);
        }
        
        // ★★★ DIAGNOSTIC: Log when we DON'T find an entry but scheduleAssignments has data ★★★
        if (!entry && window._postEditInProgress) {
            const bunkData = window.scheduleAssignments?.[bunk];
            if (bunkData) {
                // Check if there's ANY entry in this time range
                const slots = findSlotsForRange(block.startMin, block.endMin, unifiedTimes);
                const foundAny = slots.some(s => bunkData[s] && !bunkData[s].continuation);
                if (foundAny) {
                    console.warn(`[RenderCell] ⚠️ ${bunk} @ ${block.startMin}-${block.endMin}: getEntryForBlock returned null but slots ${slots.join(',')} have data`);
                    slots.forEach(s => {
                        if (bunkData[s]) {
                            console.log(`  Slot ${s}:`, bunkData[s]);
                        }
                    });
                }
            }
        }
        
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
            
            // Add pin indicator
            if (entry._pinned) {
                displayText = '📌 ' + displayText;
            }
        } else if (!entry) {
            if (isFixedBlockType(block.event)) {
                displayText = block.event;
                bgColor = '#fff8e1';
            } else {
                displayText = '';
                bgColor = '#f9fafb';
            }
        }
        
        td.textContent = displayText;
        td.style.background = bgColor;
        
        td.dataset.slot = slotIdx;
        td.dataset.slotIndex = slotIdx;
        td.dataset.bunk = bunk;
        td.dataset.division = divName;
        td.dataset.startMin = block.startMin;
        td.dataset.endMin = block.endMin;
        
        if (isBlocked) {
            td.style.cursor = 'not-allowed';
            td.onclick = () => {
                if (window.showToast) {
                    window.showToast(`🔒 Cannot edit: ${blockedReason}`, 'error');
                } else {
                    alert(`🔒 Cannot edit: ${blockedReason}`);
                }
            };
        } else if (isEditable) {
            td.style.cursor = 'pointer';
            td.onclick = () => enhancedEditCell(bunk, block.startMin, block.endMin, displayText.replace('📌 ', ''));
        } else {
            td.style.cursor = 'default';
        }
        
        return td;
    }

    // =========================================================================
    // APPLY DIRECT EDIT
    // =========================================================================

    function applyDirectEdit(bunk, slots, activity, location, isClear, shouldPin = true) {
        const unifiedTimes = window.unifiedTimes || [];
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
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
                _pinned: shouldPin && !isClear, // Pin by default for post-edit
                _editedAt: Date.now()
            };
            debugLog(`Set bunk ${bunk} slot ${idx}:`, window.scheduleAssignments[bunk][idx]);
        });
        
        if (location && !isClear && window.registerLocationUsage) {
            const divName = getDivisionForBunk(bunk);
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName);
            });
        }
    }

    // =========================================================================
    // BYPASS SAVE
    // =========================================================================

    async function bypassSaveAllBunks(modifiedBunks) {
        console.log('[UnifiedSchedule] 🔓 BYPASS SAVE for bunks:', modifiedBunks);
        
        const dateKey = window.currentScheduleDate || 
                       window.currentDate || 
                       document.getElementById('datePicker')?.value ||
                       new Date().toISOString().split('T')[0];
        
        console.log(`[UnifiedSchedule] 📅 Bypass save using date key: ${dateKey}`);
        
        try {
            localStorage.setItem(`scheduleAssignments_${dateKey}`, JSON.stringify(window.scheduleAssignments));
            
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[dateKey]) {
                allDailyData[dateKey] = {};
            }
            allDailyData[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDailyData[dateKey].leagueAssignments = window.leagueAssignments || {};
            allDailyData[dateKey].unifiedTimes = window.unifiedTimes || [];
            allDailyData[dateKey]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            
            console.log(`[UnifiedSchedule] ✅ Bypass: saved to localStorage before cloud save`);
        } catch (e) {
            console.error('[UnifiedSchedule] Bypass localStorage save error:', e);
        }
        
        if (window.ScheduleDB?.saveSchedule) {
            try {
                const result = await window.ScheduleDB.saveSchedule(dateKey, {
                    scheduleAssignments: window.scheduleAssignments,
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes,
                    _bypassSaveAt: Date.now(),
                    _modifiedBunks: modifiedBunks
                }, { 
                    skipFilter: true,
                    immediate: true
                });
                
                if (result?.success) {
                    console.log('[UnifiedSchedule] ✅ Bypass save successful via ScheduleDB');
                } else {
                    console.error('[UnifiedSchedule] Bypass save error:', result?.error);
                }
                return result;
            } catch (e) {
                console.error('[UnifiedSchedule] Bypass save exception:', e);
            }
        }
        
        console.log('[UnifiedSchedule] 🔓 Fallback: triggering standard save');
        saveSchedule();
        updateTable();
    }

    // =========================================================================
    // SCHEDULER NOTIFICATION
    // =========================================================================

    async function sendSchedulerNotification(affectedBunks, location, activity, notificationType) {
        console.log(`[UnifiedSchedule] 📧 Sending ${notificationType} notification for bunks:`, affectedBunks);
        
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) {
            console.warn('[UnifiedSchedule] Supabase not available for notifications');
            return;
        }
        
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        
        if (!campId) return;
        
        try {
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            
            for (const bunk of affectedBunks) {
                for (const [divName, divData] of Object.entries(divisions)) {
                    if (divData.bunks?.includes(bunk)) {
                        affectedDivisions.add(divName);
                    }
                }
            }
            
            const { data: schedulers } = await supabase
                .from('camp_users')
                .select('user_id, divisions')
                .eq('camp_id', campId)
                .neq('user_id', userId);
            
            if (!schedulers) return;
            
            const notifyUsers = [];
            for (const scheduler of schedulers) {
                const theirDivisions = scheduler.divisions || [];
                if (theirDivisions.some(d => affectedDivisions.has(d))) {
                    notifyUsers.push(scheduler.user_id);
                }
            }
            
            if (notifyUsers.length === 0) return;
            
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
                console.error('[UnifiedSchedule] Notification insert error:', error);
            } else {
                console.log(`[UnifiedSchedule] ✅ Sent ${notificationType} notifications to ${notifyUsers.length} user(s)`);
            }
            
        } catch (e) {
            console.error('[UnifiedSchedule] Notification error:', e);
        }
    }

    // =========================================================================
    // RESOLVE CONFLICTS AND APPLY
    // =========================================================================

    async function resolveConflictsAndApply(bunk, slots, activity, location, editData) {
        const editableConflicts = editData.editableConflicts || [];
        const nonEditableConflicts = editData.nonEditableConflicts || [];
        const resolutionChoice = editData.resolutionChoice || 'notify';
        
        console.log('[UnifiedSchedule] Resolving conflicts...', {
            editable: editableConflicts.length,
            nonEditable: nonEditableConflicts.length,
            resolution: resolutionChoice,
            postEditFlag: window._postEditInProgress
        });
        
        applyDirectEdit(bunk, slots, activity, location, false, true);
        
        if (window.GlobalFieldLocks) {
            const divName = getDivisionForBunk(bunk);
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'post_edit_pinned',
                division: divName,
                activity: activity
            });
        }
        
        let conflictsToResolve = [...editableConflicts];
        const bypassMode = resolutionChoice === 'bypass';
        
        if (bypassMode && nonEditableConflicts.length > 0) {
            console.log('[UnifiedSchedule] 🔓 BYPASS MODE - Acting as ADMIN/OWNER');
            console.log('[UnifiedSchedule] Including non-editable bunks:', nonEditableConflicts.map(c => c.bunk));
            conflictsToResolve = [...conflictsToResolve, ...nonEditableConflicts];
        }
        
        if (conflictsToResolve.length > 0) {
            console.log('[UnifiedSchedule] 🔄 Running smart regeneration for', conflictsToResolve.length, 'conflicts');
            
            const result = smartRegenerateConflicts(
                bunk,
                slots,
                location,
                activity,
                conflictsToResolve,
                bypassMode
            );
            
            console.log('[UnifiedSchedule] Smart regen result:', {
                reassigned: result.reassigned.length,
                failed: result.failed.length
            });

            if (bypassMode) {
                console.log('[UnifiedSchedule] 🔓 Bypass mode - saving ALL modified bunks to cloud');
                const modifiedBunks = [
                    ...result.reassigned.map(r => r.bunk),
                    ...result.failed.map(f => f.bunk)
                ];
                
                // Flag should already be set by applyEdit, but ensure it
                window._postEditInProgress = true;
                window._postEditTimestamp = Date.now();
                
                await bypassSaveAllBunks(modifiedBunks);
                
                if (nonEditableConflicts.length > 0) {
                    const affectedBunks = [...new Set(nonEditableConflicts.map(c => c.bunk))];
                    sendSchedulerNotification(affectedBunks, location, activity, 'bypassed');
                    
                    if (window.showToast) {
                        window.showToast(`🔓 Bypassed permissions - reassigned ${affectedBunks.length} bunk(s)`, 'info');
                    }
                }
            } else if (nonEditableConflicts.length > 0) {
                const affectedBunks = [...new Set(nonEditableConflicts.map(c => c.bunk))];
                console.warn(`[UnifiedSchedule] 📧 Double-booking created: ${affectedBunks.join(', ')}`);
                
                sendSchedulerNotification(affectedBunks, location, activity, 'conflict');
                
                if (window.showToast) {
                    window.showToast(`📧 Notification sent about ${affectedBunks.length} conflict(s)`, 'warning');
                }
            }
        }
        
        console.log('[UnifiedSchedule] resolveConflictsAndApply complete, postEditFlag:', window._postEditInProgress);
    }

    // =========================================================================
    // APPLY EDIT (Main entry point)
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        
        if (slots.length === 0) {
            console.error('[UnifiedSchedule] ❌ No slots found for time range:', startMin, '-', endMin);
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[UnifiedSchedule] Applying edit for ${bunk}:`, { 
            activity, location, startMin, endMin, slots, hasConflict, resolutionChoice, isClear
        });
        
        // ★★★ SET FLAG EARLY - Before any modifications ★★★
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        console.log('[UnifiedSchedule] 🔒 Post-edit protection flag SET');
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        }
        
        if (hasConflict) {
            await resolveConflictsAndApply(bunk, slots, activity, location, editData);
        } else {
            applyDirectEdit(bunk, slots, activity, location, isClear, true);
        }
        
        console.log(`[UnifiedSchedule] ✅ After edit, bunk ${bunk} slot ${slots[0]}:`, window.scheduleAssignments[bunk][slots[0]]);
        
        const currentDate = window.currentScheduleDate || 
                           window.currentDate || 
                           document.getElementById('datePicker')?.value ||
                           new Date().toISOString().split('T')[0];
        
        console.log(`[UnifiedSchedule] 📅 Using date key: ${currentDate}`);
        
        // Save to localStorage
        try {
            localStorage.setItem(`scheduleAssignments_${currentDate}`, JSON.stringify(window.scheduleAssignments));
            
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[currentDate]) {
                allDailyData[currentDate] = {};
            }
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].unifiedTimes = window.unifiedTimes || [];
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            
            console.log(`[UnifiedSchedule] ✅ Saved to localStorage`);
        } catch (e) {
            console.error('[UnifiedSchedule] Failed to save to localStorage:', e);
        }
        
        // Clear flag after a delay
        setTimeout(() => {
            window._postEditInProgress = false;
            console.log('[UnifiedSchedule] 🔓 Post-edit protection flag cleared');
        }, 8000);
        
        console.log('[UnifiedSchedule] 🔄 Triggering UI refresh...');
        console.log('[UnifiedSchedule] 📊 Current scheduleAssignments bunks:', Object.keys(window.scheduleAssignments).length);
        
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunk, slots, activity, location, date: currentDate }
        }));
        
        // Cloud save (don't await - fire and forget)
        saveSchedule();
        
        // ★★★ FORCE IMMEDIATE RENDER ★★★
        console.log('[UnifiedSchedule] 🔄 Calling updateTable() - flag is:', window._postEditInProgress);
        updateTable();
        
        // Second render after a small delay to catch any async updates
        setTimeout(() => {
            console.log('[UnifiedSchedule] 🔄 Second render pass - flag is:', window._postEditInProgress);
            updateTable();
        }, 300);
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
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        let resolutionChoice = 'notify';
        
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
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
                    ${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}
                </div>
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <!-- Activity Name -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Activity Name
                    </label>
                    <input type="text" id="post-edit-activity" 
                        value="${escapeHtml(currentActivity)}"
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
        
        let useOriginalTime = true;
        const originalStartMin = startMin;
        const originalEndMin = endMin;
        
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
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
            timeDisplay.textContent = `${minutesToTimeLabel(times.startMin)} - ${minutesToTimeLabel(times.endMin)}`;
        }
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!location) {
                conflictArea.style.display = 'none';
                return null;
            }
            
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
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
            
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
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
    // ENHANCED EDIT CELL (Main entry point for editing)
    // =========================================================================

    function enhancedEditCell(bunk, startMin, endMin, current) {
        debugLog(`enhancedEditCell called: ${bunk}, ${startMin}-${endMin}, "${current}"`);
        
        if (!canEditBunk(bunk)) {
            alert('You do not have permission to edit this schedule.\n\n(You can only edit your assigned divisions.)');
            return;
        }
        
        showEditModal(bunk, startMin, endMin, current, (editData) => {
            applyEdit(bunk, editData);
        });
    }

    // =========================================================================
    // SIMPLE EDIT CELL (Legacy compatibility)
    // =========================================================================

    function editCell(bunk, startMin, endMin, current) {
        enhancedEditCell(bunk, startMin, endMin, current);
    }

    // =========================================================================
    // SAVE & UPDATE
    // =========================================================================

    function saveSchedule() {
        // ★★★ Use silent save during post-edit to avoid triggering reload events ★★★
        const silent = window._postEditInProgress;
        
        if (silent) {
            console.log('[UnifiedSchedule] 💾 Silent save (post-edit in progress)');
        }
        
        // Call external save function if available
        if (window.saveCurrentDailyData) {
            window.saveCurrentDailyData('scheduleAssignments', window.scheduleAssignments, { silent });
            window.saveCurrentDailyData('leagueAssignments', window.leagueAssignments, { silent });
            window.saveCurrentDailyData('unifiedTimes', window.unifiedTimes, { silent });
        }
    }

    function updateTable() {
        const now = Date.now();
        
        // ★★★ Force immediate render when post-edit is in progress ★★★
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] 🔄 FORCE RENDER (post-edit in progress)');
            _lastRenderTime = now;
            _renderQueued = false;
            if (_renderTimeout) {
                clearTimeout(_renderTimeout);
                _renderTimeout = null;
            }
            const container = document.getElementById('scheduleTable');
            if (container) {
                renderStaggeredView(container);
            } else {
                console.error('[UnifiedSchedule] ❌ scheduleTable container not found!');
            }
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
    // VERSION MANAGEMENT - INTEGRATED
    // =========================================================================
    
    const VersionManager = {
        
        async saveVersion(name) {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return { success: false };
            }
            
            if (!name) {
                name = prompt('Enter a name for this version (e.g., "Draft 1", "Morning Final"):');
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
                alert('Version database not available. Please refresh the page.');
                return { success: false };
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                const existing = versions.find(v => v.name.toLowerCase() === name.toLowerCase());
                
                if (existing) {
                    if (!confirm(`Version "${existing.name}" already exists. Overwrite it?`)) {
                        return { success: false };
                    }
                    
                    if (window.ScheduleVersionsDB.updateVersion) {
                        const result = await window.ScheduleVersionsDB.updateVersion(existing.id, payload);
                        if (result.success) {
                            alert('✅ Version updated successfully!');
                            return { success: true };
                        } else {
                            alert('❌ Error updating: ' + result.error);
                            return { success: false };
                        }
                    }
                }
                
                const result = await window.ScheduleVersionsDB.createVersion(dateKey, name, payload);
                if (result.success) {
                    alert('✅ Version saved successfully!');
                    return { success: true };
                } else {
                    alert('❌ Error saving: ' + result.error);
                    return { success: false };
                }
                
            } catch (err) {
                console.error('Version save error:', err);
                alert('Error saving version: ' + err.message);
                return { success: false };
            }
        },
        
        async loadVersion() {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return;
            }
            
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available.');
                return;
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                
                if (!versions || versions.length === 0) {
                    alert('No saved versions found for this date.');
                    return;
                }
                
                let msg = 'Select a version to load:\n\n';
                versions.forEach((v, i) => {
                    const time = new Date(v.created_at).toLocaleTimeString();
                    msg += `${i + 1}. ${v.name} (${time})\n`;
                });
                
                const choice = prompt(msg);
                if (!choice) return;
                
                const index = parseInt(choice) - 1;
                if (isNaN(index) || !versions[index]) {
                    alert('Invalid selection');
                    return;
                }
                
                const selected = versions[index];
                if (!confirm(`Load "${selected.name}"? This will overwrite the current view.`)) {
                    return;
                }
                
                let data = selected.schedule_data;
                if (typeof data === 'string') {
                    try { data = JSON.parse(data); } catch(e) {}
                }
                
                const assignments = data.scheduleAssignments || data;
                
                window.scheduleAssignments = assignments;
                
                if (data.leagueAssignments) {
                    window.leagueAssignments = data.leagueAssignments;
                }
                
                if (data.unifiedTimes) {
                    window.unifiedTimes = normalizeUnifiedTimes(data.unifiedTimes);
                }
                
                saveSchedule();
                updateTable();
                
                alert('✅ Version loaded!');
                
            } catch (err) {
                console.error('Version load error:', err);
                alert('Error loading version: ' + err.message);
            }
        },
        
        async mergeVersions() {
            const dateKey = getDateKey();
            if (!dateKey) {
                alert('Please select a date first.');
                return { success: false };
            }
            
            if (!window.ScheduleVersionsDB) {
                alert('Version database not available.');
                return { success: false };
            }
            
            if (!confirm(`Merge ALL versions for ${dateKey}?`)) {
                return { success: false };
            }
            
            try {
                const versions = await window.ScheduleVersionsDB.listVersions(dateKey);
                
                if (!versions || versions.length === 0) {
                    alert('No versions to merge.');
                    return { success: false };
                }
                
                debugLog(`[VersionMerger] Merging ${versions.length} versions...`);
                
                const mergedAssignments = {};
                const bunksTouched = new Set();
                let latestLeagueData = null;
                
                versions.forEach(ver => {
                    let scheduleData = ver.schedule_data || ver.data || ver.payload;
                    
                    if (typeof scheduleData === 'string') {
                        try { scheduleData = JSON.parse(scheduleData); } catch(e) {}
                    }
                    
                    if (!scheduleData) return;
                    
                    const assignments = scheduleData.scheduleAssignments || scheduleData;
                    
                    if (assignments && typeof assignments === 'object') {
                        Object.entries(assignments).forEach(([bunkId, slots]) => {
                            mergedAssignments[bunkId] = slots;
                            bunksTouched.add(bunkId);
                        });
                    }
                    
                    if (scheduleData.leagueAssignments) {
                        latestLeagueData = scheduleData.leagueAssignments;
                    }
                });
                
                debugLog(`[VersionMerger] Merged ${bunksTouched.size} bunks from ${versions.length} versions`);
                
                window.scheduleAssignments = mergedAssignments;
                
                if (latestLeagueData) {
                    window.leagueAssignments = latestLeagueData;
                }
                
                saveSchedule();
                updateTable();
                
                alert(`✅ Merged ${versions.length} versions (${bunksTouched.size} bunks).`);
                
                return { success: true, count: versions.length, bunks: bunksTouched.size };
                
            } catch (err) {
                console.error('Version merge error:', err);
                alert('Error merging versions: ' + err.message);
                return { success: false };
            }
        }
    };

    // =========================================================================
    // SCHEDULER HOOKS FOR PINNED ACTIVITIES
    // =========================================================================

    function hookSchedulerGeneration() {
        if (typeof window.runScheduler === 'function' && !window.runScheduler._pinnedHooked) {
            const originalRunScheduler = window.runScheduler;
            
            window.runScheduler = async function(...args) {
                console.log('[UnifiedSchedule] 🚀 Generation starting - capturing pinned activities');
                
                const allowedDivisions = args[0]?.allowedDivisions || null;
                capturePinnedActivities(allowedDivisions);
                
                const result = await originalRunScheduler.apply(this, args);
                
                if (Object.keys(_pinnedSnapshot).length > 0) {
                    console.log('[UnifiedSchedule] 🔄 Generation complete - restoring pinned activities');
                    restorePinnedActivities();
                    saveSchedule();
                }
                
                return result;
            };
            
            window.runScheduler._pinnedHooked = true;
            console.log('[UnifiedSchedule] ✅ Hooked into runScheduler for pinned preservation');
        }
        
        if (typeof window.generateSchedule === 'function' && !window.generateSchedule._pinnedHooked) {
            const originalGenerateSchedule = window.generateSchedule;
            
            window.generateSchedule = async function(...args) {
                console.log('[UnifiedSchedule] 🚀 Generation starting - capturing pinned activities');
                
                const allowedDivisions = args[0]?.allowedDivisions || 
                                        window.selectedDivisionsForGeneration || 
                                        null;
                
                capturePinnedActivities(allowedDivisions);
                
                const result = await originalGenerateSchedule.apply(this, args);
                
                if (Object.keys(_pinnedSnapshot).length > 0) {
                    console.log('[UnifiedSchedule] 🔄 Generation complete - restoring pinned activities');
                    restorePinnedActivities();
                    saveSchedule();
                    updateTable();
                }
                
                return result;
            };
            
            window.generateSchedule._pinnedHooked = true;
            console.log('[UnifiedSchedule] ✅ Hooked into generateSchedule for pinned preservation');
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initScheduleSystem() {
        if (_initialized) return;
        
        const dateKey = getDateKey();
        loadScheduleForDate(dateKey);
        
        // Add styles for modal
        if (!document.getElementById('unified-schedule-styles')) {
            const style = document.createElement('style');
            style.id = 'unified-schedule-styles';
            style.textContent = `
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                
                #${MODAL_ID} input:focus,
                #${MODAL_ID} select:focus {
                    outline: none;
                    border-color: #2563eb;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                }
                
                #${MODAL_ID} button:hover {
                    opacity: 0.9;
                }
                
                #${MODAL_ID} button:active {
                    transform: scale(0.98);
                }
            `;
            document.head.appendChild(style);
        }
        
        // Hook scheduler for pinned preservation
        hookSchedulerGeneration();
        setTimeout(hookSchedulerGeneration, 1000);
        setTimeout(hookSchedulerGeneration, 3000);
        
        _initialized = true;
        debugLog('System initialized');
    }

    function reconcileOrRenderSaved() {
        const dateKey = getDateKey();
        loadScheduleForDate(dateKey);
        updateTable();
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    window.addEventListener('campistry-cloud-hydrated', () => {
        console.log('[UnifiedSchedule] Cloud hydration event received');
        
        // ★★★ Don't overwrite during post-edit ★★★
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] 🛡️ Ignoring cloud hydration - post-edit in progress');
            return;
        }
        
        _cloudHydrated = true;
        
        setTimeout(() => {
            if (!window._postEditInProgress) {
                loadScheduleForDate(getDateKey());
                updateTable();
            }
        }, 100);
    });

    window.addEventListener('campistry-cloud-schedule-loaded', (e) => {
        console.log('[UnifiedSchedule] Cloud schedule loaded:', e.detail);
        
        // ★★★ Don't overwrite during post-edit ★★★
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] 🛡️ Ignoring cloud schedule load - post-edit in progress');
            return;
        }
        
        _cloudHydrated = true;
        setTimeout(() => {
            if (!window._postEditInProgress) {
                updateTable();
            }
        }, 100);
    });

    window.addEventListener('campistry-daily-data-updated', () => {
        console.log('[UnifiedSchedule] Data update event received');
        
        // ★★★ Don't overwrite during post-edit ★★★
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] 🛡️ Ignoring daily data update - post-edit in progress');
            return;
        }
        
        loadScheduleForDate(getDateKey());
        updateTable();
    });

    window.addEventListener('campistry-date-changed', (e) => {
        console.log('[UnifiedSchedule] Date changed:', e.detail?.dateKey);
        
        // ★★★ Don't overwrite during post-edit ★★★
        if (window._postEditInProgress) {
            console.log('[UnifiedSchedule] 🛡️ Ignoring date change - post-edit in progress');
            return;
        }
        
        if (window.UnifiedCloudSchedule?.load) {
            window.UnifiedCloudSchedule.load().then(result => {
                if (!window._postEditInProgress) {
                    if (!result.merged) {
                        loadScheduleForDate(e.detail?.dateKey || getDateKey());
                    }
                    updateTable();
                }
            });
        } else {
            loadScheduleForDate(e.detail?.dateKey || getDateKey());
            updateTable();
        }
    });

    window.addEventListener('campistry-generation-complete', () => {
        console.log('[UnifiedSchedule] Generation complete - saving to cloud');
        
        if (window.UnifiedCloudSchedule?.save) {
            setTimeout(() => {
                window.UnifiedCloudSchedule.save().then(result => {
                    if (result.success) {
                        console.log('[UnifiedSchedule] ✅ Saved to cloud after generation');
                    }
                });
            }, 500);
        }
        
        updateTable();
    });

    window.addEventListener('campistry-generation-starting', (e) => {
        console.log('[UnifiedSchedule] 📡 Received generation-starting event');
        const allowedDivisions = e.detail?.allowedDivisions || null;
        capturePinnedActivities(allowedDivisions);
    });

    // Hide toolbar when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hideVersionToolbar);
    } else {
        hideVersionToolbar();
    }

    setTimeout(hideVersionToolbar, 500);
    setTimeout(hideVersionToolbar, 1500);
    setTimeout(hideVersionToolbar, 3000);

    // =========================================================================
    // EXPORTS
    // =========================================================================

    // Core functions
    window.updateTable = updateTable;
    window.renderStaggeredView = renderStaggeredView;
    window.initScheduleSystem = initScheduleSystem;
    window.saveSchedule = saveSchedule;
    window.loadScheduleForDate = loadScheduleForDate;
    window.reconcileOrRenderSaved = reconcileOrRenderSaved;
    
    // Edit functions
    window.editCell = editCell;
    window.enhancedEditCell = enhancedEditCell;
    window.findFirstSlotForTime = (min) => findSlotIndexForTime(min, window.unifiedTimes);
    window.findSlotsForRange = (start, end) => findSlotsForRange(start, end, window.unifiedTimes);
    
    // Time utilities
    window.parseTimeToMinutes = parseTimeToMinutes;
    window.minutesToTimeLabel = minutesToTimeLabel;
    
    // Entry functions
    window.getEntry = getEntry;
    window.formatEntry = formatEntry;
    
    // RBAC functions
    window.getEditableBunks = getEditableBunks;
    window.canEditBunk = canEditBunk;
    
    // Conflict detection
    window.checkLocationConflict = checkLocationConflict;
    window.getAllLocations = getAllLocations;
    
    // Smart regeneration
    window.smartRegenerateConflicts = smartRegenerateConflicts;
    window.smartReassignBunkActivity = smartReassignBunkActivity;
    window.findBestActivityForBunk = findBestActivityForBunk;
    window.buildFieldUsageBySlot = buildFieldUsageBySlot;
    window.buildCandidateOptions = buildCandidateOptions;
    window.calculateRotationPenalty = calculateRotationPenalty;
    window.isFieldAvailable = isFieldAvailable;
    window.getActivityProperties = getActivityProperties;
    window.applyPickToBunk = applyPickToBunk;
    
    // Bypass and notifications
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
    
    // Version management
    window.ScheduleVersionManager = VersionManager;
    
    // Legacy compatibility
    window.ScheduleVersionMerger = {
        mergeAndPush: async (dateKey) => {
            window.currentScheduleDate = dateKey;
            return await VersionManager.mergeVersions();
        }
    };
    
    // SmartRegenSystem namespace for compatibility
    window.SmartRegenSystem = {
        smartRegenerateConflicts,
        smartReassignBunkActivity,
        findBestActivityForBunk,
        buildFieldUsageBySlot,
        buildCandidateOptions,
        calculateRotationPenalty,
        isFieldAvailable,
        getActivityProperties,
        applyPickToBunk,
        ROTATION_CONFIG
    };
    
    // PinnedActivitySystem namespace
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
    
    // Debug namespace
    window.UnifiedScheduleSystem = {
        version: '4.0.0',
        loadScheduleForDate,
        renderStaggeredView,
        findSlotIndexForTime,
        findSlotsForRange,
        getLeagueMatchups,
        getEntryForBlock,
        buildUnifiedTimesFromSkeleton,
        isSplitTileBlock,
        expandBlocksForSplitTiles,
        VersionManager,
        SmartRegenSystem: window.SmartRegenSystem,
        PinnedActivitySystem: window.PinnedActivitySystem,
        ROTATION_CONFIG,
        DEBUG_ON: () => { DEBUG = true; console.log('[UnifiedSchedule] Debug enabled'); },
        DEBUG_OFF: () => { DEBUG = false; console.log('[UnifiedSchedule] Debug disabled'); },
        
        diagnose: () => {
            const dateKey = getDateKey();
            console.log('=== UNIFIED SCHEDULE SYSTEM v4.0 DIAGNOSTIC ===');
            console.log(`Date: ${dateKey}`);
            console.log(`window.scheduleAssignments: ${Object.keys(window.scheduleAssignments || {}).length} bunks`);
            console.log(`window.unifiedTimes: ${(window.unifiedTimes || []).length} slots`);
            console.log(`window.leagueAssignments: ${Object.keys(window.leagueAssignments || {}).length} divisions`);
            console.log(`Skeleton: ${getSkeleton().length} blocks`);
            console.log(`Divisions: ${Object.keys(window.divisions || {}).join(', ')}`);
            console.log(`Pinned activities: ${getPinnedActivities().length}`);
            console.log(`Post-edit in progress: ${!!window._postEditInProgress}`);
            
            // ★★★ Also show bunk names ★★★
            const bunkNames = Object.keys(window.scheduleAssignments || {});
            console.log(`Bunk names: ${bunkNames.slice(0, 10).join(', ')}${bunkNames.length > 10 ? '...' : ''}`);
        },
        
        // ★★★ List all bunks ★★★
        listBunks: () => {
            const assignments = window.scheduleAssignments || {};
            const bunkNames = Object.keys(assignments).sort((a, b) => 
                String(a).localeCompare(String(b), undefined, { numeric: true })
            );
            console.log(`=== ALL BUNKS (${bunkNames.length}) ===`);
            bunkNames.forEach(name => {
                const data = assignments[name];
                const nonEmpty = data ? data.filter(e => e && !e.continuation).length : 0;
                console.log(`  "${name}" - ${nonEmpty} activities`);
            });
            return bunkNames;
        },
        
        // ★★★ NEW: Check specific bunk data ★★★
        checkBunk: (bunk, slotIdx) => {
            const assignments = window.scheduleAssignments || {};
            const bunkData = assignments[bunk];
            const ut = window.unifiedTimes || [];
            
            console.log(`=== CHECK BUNK: "${bunk}" ===`);
            console.log(`Post-edit flag: ${window._postEditInProgress}`);
            
            if (!bunkData) {
                console.log(`❌ No data for bunk "${bunk}"`);
                console.log(`Available bunks: ${Object.keys(assignments).slice(0, 5).join(', ')}...`);
                return null;
            }
            
            console.log(`Bunk has ${bunkData.length} slots`);
            
            if (slotIdx !== undefined) {
                const entry = bunkData[slotIdx];
                const time = ut[slotIdx];
                const timeStr = time ? minutesToTimeLabel(getSlotStartMin(time)) : '?';
                console.log(`Slot ${slotIdx} (${timeStr}):`, entry);
                return entry;
            }
            
            // Show all non-empty, non-continuation entries
            let count = 0;
            for (let i = 0; i < bunkData.length && count < 10; i++) {
                const entry = bunkData[i];
                if (entry && !entry.continuation) {
                    const time = ut[i];
                    const timeStr = time ? minutesToTimeLabel(getSlotStartMin(time)) : '?';
                    const activity = entry._activity || entry.field || 'unknown';
                    const flags = [];
                    if (entry._smartRegenerated) flags.push('smartRegen');
                    if (entry._postEdit) flags.push('postEdit');
                    if (entry._pinned) flags.push('pinned');
                    console.log(`  [${i}] ${timeStr}: "${activity}" ${flags.length ? `[${flags.join(', ')}]` : ''}`);
                    count++;
                }
            }
            
            return bunkData;
        },
        
        // ★★★ NEW: Force re-render ★★★
        forceRender: () => {
            console.log('[UnifiedSchedule] 🔄 FORCE RENDER requested');
            console.log('  scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
            console.log('  postEditInProgress:', window._postEditInProgress);
            
            // Temporarily set flag to prevent loadScheduleForDate from overwriting
            const wasSet = window._postEditInProgress;
            window._postEditInProgress = true;
            
            const container = document.getElementById('scheduleTable');
            if (container) {
                renderStaggeredView(container);
                console.log('[UnifiedSchedule] ✅ Force render complete');
            } else {
                console.error('[UnifiedSchedule] ❌ scheduleTable container not found');
            }
            
            // Restore flag
            if (!wasSet) {
                setTimeout(() => {
                    window._postEditInProgress = false;
                }, 1000);
            }
        },
        
        // ★★★ NEW: Show recently modified bunks ★★★
        showModified: () => {
            const assignments = window.scheduleAssignments || {};
            const ut = window.unifiedTimes || [];
            
            console.log('=== RECENTLY MODIFIED ENTRIES ===');
            let found = 0;
            
            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!slots) continue;
                for (let i = 0; i < slots.length; i++) {
                    const entry = slots[i];
                    if (entry && (entry._smartRegenerated || entry._postEdit)) {
                        const time = ut[i];
                        const timeStr = time ? minutesToTimeLabel(getSlotStartMin(time)) : '?';
                        const activity = entry._activity || entry.field || 'unknown';
                        const flags = [];
                        if (entry._smartRegenerated) flags.push('smartRegen');
                        if (entry._postEdit) flags.push('postEdit');
                        if (entry._pinned) flags.push('pinned');
                        console.log(`  ${bunk} [${i}] ${timeStr}: "${activity}" [${flags.join(', ')}]`);
                        found++;
                    }
                }
            }
            
            if (found === 0) {
                console.log('  No entries with _smartRegenerated or _postEdit flags found');
            } else {
                console.log(`  Total: ${found} modified entries`);
            }
        },
        
        // ★★★ NEW: Trace a specific cell render ★★★
        traceCell: (bunk, startMin, endMin) => {
            const ut = window.unifiedTimes || [];
            const assignments = window.scheduleAssignments || {};
            
            console.log(`=== TRACE CELL: ${bunk} @ ${startMin}-${endMin} ===`);
            
            // Find slots in range
            const slots = findSlotsForRange(startMin, endMin, ut);
            console.log(`Slots in range: [${slots.join(', ')}]`);
            
            // Check bunk data
            const bunkData = assignments[bunk];
            if (!bunkData) {
                console.log(`❌ No data for bunk "${bunk}"`);
                return;
            }
            
            console.log(`Bunk "${bunk}" has ${bunkData.length} total slots`);
            
            // Show what's in each slot
            slots.forEach(s => {
                const entry = bunkData[s];
                const time = ut[s];
                const timeStr = time ? minutesToTimeLabel(getSlotStartMin(time)) : '?';
                if (entry) {
                    console.log(`  Slot ${s} (${timeStr}):`, entry);
                } else {
                    console.log(`  Slot ${s} (${timeStr}): (empty)`);
                }
            });
            
            // Now call getEntryForBlock
            const result = getEntryForBlock(bunk, startMin, endMin, ut);
            console.log(`getEntryForBlock result: slotIdx=${result.slotIdx}, entry=`, result.entry);
        },
        
        getState: () => ({
            dateKey: getDateKey(),
            assignments: Object.keys(window.scheduleAssignments || {}).length,
            leagues: Object.keys(window.leagueAssignments || {}).length,
            times: (window.unifiedTimes || []).length,
            skeleton: (window.manualSkeleton || window.skeleton || []).length,
            cloudHydrated: _cloudHydrated,
            initialized: _initialized,
            pinnedCount: getPinnedActivities().length,
            postEditInProgress: !!window._postEditInProgress
        })
    };

    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScheduleSystem);
    } else {
        setTimeout(initScheduleSystem, 100);
    }

    console.log('📅 Unified Schedule System v4.0.0 loaded successfully');
    console.log('   Replaces: scheduler_ui.js, render_sync_fix.js, view_schedule_loader_fix.js');
    console.log('   Replaces: schedule_version_merger.js, schedule_version_ui.js');
    console.log('   Replaces: post_generation_edit_system.js (NOW INTEGRATED)');
    console.log('   Replaces: pinned_activity_preservation.js (NOW INTEGRATED)');
    console.log('   REQUIRES: unified_cloud_schedule_system.js for proper cloud sync');
    console.log('   ✅ v3.5: Split tile visual fix');
    console.log('   ✅ v3.5.3: League matchups fix');
    console.log('   ✅ v4.0: Integrated post-generation editing with smart regeneration');
    console.log('   ✅ v4.0: Integrated pinned activity preservation');
    console.log('   ✅ v4.0: Bypass mode for admin-level access');
    console.log('   ✅ v4.0: Conflict detection and resolution UI');

})();
