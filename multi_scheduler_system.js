// =============================================================================
// multi_scheduler_system.js — COMPLETE AUTONOMOUS MULTI-SCHEDULER SYSTEM
// VERSION: v3.2.0 (PRODUCTION - WITH MERGE UI)
// =============================================================================
//
// This SINGLE FILE replaces ALL of the following:
// ❌ multi_scheduler_core.js
// ❌ multi_scheduler_integration.js  
// ❌ scheduler_cloud_fetch.js
// ❌ schedule_merge_engine.js
// ❌ scheduler_ui_blocking.js
// ❌ unified_schedule_view.js
// ❌ multi_scheduler_autonomous.js
//
// WHAT THIS FILE DOES:
// ✅ Automatically fetches other schedulers' data when view opens
// ✅ Automatically blocks claimed resources visually (red stripes + 🔒)
// ✅ Automatically prevents editing/dragging onto blocked slots
// ✅ Automatically merges on save (via existing cloud_storage_bridge.js)
// ✅ Adds merge status indicator to daily scheduling view
// ✅ Provides unified schedule view toggle
// ✅ NO MANUAL BUTTONS for basic operation - everything is autonomous
//
// REQUIREMENTS:
// - cloud_storage_bridge.js must be loaded first
// - scheduler_ui.js must use the patched version with data-* attributes
//
// RACE CONDITION FIXES (v3.2.0):
// - Fetch deduplication with promise tracking
// - Debounced UI updates
// - Sync suppression during deletion
// - Proper cleanup on date change
//
// =============================================================================

(function() {
    'use strict';

    console.log("🔄 Multi-Scheduler System v3.2.0 (WITH MERGE UI) loading...");

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const CONFIG = {
        SUPABASE_URL: "https://bzqmhcumuarrbueqttfh.supabase.co",
        SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI",
        TABLE: "camp_state",
        VERSIONS_TABLE: "schedule_versions",
        DAILY_DATA_KEY: "campDailyData_v1",
        FETCH_TIMEOUT_MS: 10000,
        DEBOUNCE_MS: 100,
        DEBUG: false
    };

    // =========================================================================
    // STATE (Private to prevent external mutation)
    // =========================================================================
    
    const STATE = {
        cloudData: null,
        blockedMap: null,
        myDivisions: [],
        lastFetchDate: null,
        fetchInProgress: false,
        fetchPromise: null,           // Track pending fetch to prevent duplicates
        initialized: false,
        mergeUIInjected: false,
        hookInstalled: {
            updateTable: false,
            datePicker: false,
            generator: false,
            cloudSave: false
        }
    };

    // =========================================================================
    // STYLES
    // =========================================================================
    
    const STYLES = `
        /* Blocked cell (other scheduler owns it) */
        .blocked-by-other {
            position: relative !important;
            background: repeating-linear-gradient(
                45deg,
                rgba(239, 68, 68, 0.08),
                rgba(239, 68, 68, 0.08) 5px,
                rgba(239, 68, 68, 0.15) 5px,
                rgba(239, 68, 68, 0.15) 10px
            ) !important;
            cursor: not-allowed !important;
        }
        
        .blocked-by-other::before {
            content: '🔒';
            position: absolute;
            top: 2px;
            right: 4px;
            font-size: 10px;
            opacity: 0.7;
            z-index: 5;
        }
        
        .blocked-by-other::after {
            content: attr(data-blocked-reason);
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: #1e293b;
            color: white;
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 11px;
            white-space: nowrap;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s;
            z-index: 1000;
            pointer-events: none;
        }
        
        .blocked-by-other:hover::after {
            opacity: 1;
            visibility: visible;
        }
        
        /* Partially blocked (some capacity left) */
        .partially-blocked {
            position: relative !important;
            background: linear-gradient(135deg, rgba(251, 191, 36, 0.15) 0%, transparent 50%) !important;
        }
        
        .partially-blocked::before {
            content: '⚠️';
            position: absolute;
            top: 2px;
            right: 4px;
            font-size: 10px;
            opacity: 0.7;
        }
        
        /* Locked row */
        tr.locked-by-other-scheduler {
            opacity: 0.7;
        }
        
        tr.locked-by-other-scheduler td:first-child::after {
            content: ' 🔒';
            font-size: 10px;
        }
        
        /* Drag blocked feedback */
        .drag-blocked {
            outline: 2px dashed #ef4444 !important;
            animation: mss-shake 0.3s;
        }
        
        @keyframes mss-shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-3px); }
            75% { transform: translateX(3px); }
        }
        
        /* Status toast */
        #mss-toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            background: #ef4444;
            color: white;
            border-radius: 8px;
            font-size: 14px;
            z-index: 10000;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
        }
        
        #mss-toast.show {
            opacity: 1;
        }
    `;

    function injectStyles() {
        if (document.getElementById('mss-styles')) return;
        const style = document.createElement('style');
        style.id = 'mss-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    // =========================================================================
    // LOGGING
    // =========================================================================
    
    function log(...args) {
        if (CONFIG.DEBUG) console.log('🔄 [MSS]', ...args);
    }

    // =========================================================================
    // PART 1: CLOUD DATA FETCHING (with race condition fixes)
    // =========================================================================
    
    async function fetchCloudSchedule(dateKey) {
        // Return cached data if available for same date
        if (STATE.lastFetchDate === dateKey && STATE.cloudData) {
            log('Using cached data for', dateKey);
            return STATE.cloudData;
        }
        
        // RACE CONDITION FIX: Deduplicate concurrent fetches by returning pending promise
        if (STATE.fetchInProgress && STATE.fetchPromise) {
            log('Fetch already in progress, waiting...');
            return STATE.fetchPromise;
        }
        
        STATE.fetchInProgress = true;
        
        // Store the promise so concurrent calls can wait for it
        STATE.fetchPromise = (async () => {
            log('Fetching cloud data for', dateKey);
            
            try {
                // Validate Supabase is available
                if (!window.supabase) {
                    console.warn('🔄 [MSS] Supabase not initialized');
                    return null;
                }
                
                const { data: { session } } = await window.supabase.auth.getSession();
                if (!session) {
                    log('No active session');
                    return null;
                }
                
                const campId = window.getCampId?.() || 
                              window._currentCampId || 
                              localStorage.getItem('currentCampId');
                              
                if (!campId || campId === 'demo_camp_001') {
                    log('No valid camp ID');
                    return null;
                }
                
                // Fetch with timeout to prevent hanging
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
                
                const response = await fetch(
                    `${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.TABLE}?camp_id=eq.${campId}&select=state`,
                    {
                        headers: {
                            'apikey': CONFIG.SUPABASE_KEY,
                            'Authorization': `Bearer ${session.access_token}`,
                            'Content-Type': 'application/json',
                            'Cache-Control': 'no-cache'
                        },
                        signal: controller.signal
                    }
                );
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    console.warn(`🔄 [MSS] Fetch failed: HTTP ${response.status}`);
                    return null;
                }
                
                const rows = await response.json();
                if (!rows?.length) {
                    log('No cloud data found');
                    return null;
                }
                
                const state = rows[0].state || {};
                const dailySchedules = state.daily_schedules || {};
                const dateData = dailySchedules[dateKey] || {};
                
                STATE.cloudData = {
                    scheduleAssignments: dateData.scheduleAssignments || {},
                    leagueAssignments: dateData.leagueAssignments || {},
                    skeleton: dateData.skeleton || dateData.manualSkeleton || [],
                    unifiedTimes: dateData.unifiedTimes || [],
                    _fetchedAt: Date.now(),
                    _source: 'cloud'
                };
                
                STATE.lastFetchDate = dateKey;
                
                console.log(`🔄 [MSS] Fetched cloud data: ${Object.keys(STATE.cloudData.scheduleAssignments).length} bunks`);
                
                return STATE.cloudData;
                
            } catch (error) {
                if (error.name === 'AbortError') {
                    console.warn('🔄 [MSS] Fetch timed out');
                } else {
                    console.error('🔄 [MSS] Fetch error:', error);
                }
                return null;
            } finally {
                // CRITICAL: Always reset flags to prevent deadlock
                STATE.fetchInProgress = false;
                STATE.fetchPromise = null;
            }
        })();
        
        return STATE.fetchPromise;
    }
    
    /**
     * Get camp ID from various sources
     */
    function getCampId() {
        return window.getCampId?.() || 
               window._currentCampId ||
               localStorage.getItem('currentCampId') ||
               localStorage.getItem('campistry_user_id');
    }

    // =========================================================================
    // PART 2: BUILD BLOCKED RESOURCES MAP
    // =========================================================================
    
    function buildBlockedMap(cloudData, myDivisions) {
        log('Building blocked map...');
        
        const blocked = {
            bySlotField: {},
            byBunkSlot: {},
            stats: { 
                totalBlocked: 0,
                blockedFields: new Set(),
                blockedDivisions: new Set()
            }
        };
        
        if (!cloudData?.scheduleAssignments) return blocked;
        
        const myDivisionsSet = new Set(myDivisions.map(String));
        
        for (const [bunkId, slots] of Object.entries(cloudData.scheduleAssignments)) {
            if (!Array.isArray(slots)) continue;
            
            const bunkDiv = getBunkDivision(bunkId);
            
            // Skip bunks I own
            if (bunkDiv && myDivisionsSet.has(String(bunkDiv))) continue;
            
            slots.forEach((slot, slotIndex) => {
                if (!slot || slot.continuation) return;
                
                const fieldName = slot.field || slot._activity;
                if (!fieldName || fieldName === 'Free' || fieldName === 'free') return;
                
                // Track by slot/field
                if (!blocked.bySlotField[slotIndex]) blocked.bySlotField[slotIndex] = {};
                if (!blocked.bySlotField[slotIndex][fieldName]) {
                    blocked.bySlotField[slotIndex][fieldName] = {
                        count: 0,
                        maxCapacity: getFieldCapacity(fieldName),
                        claimedBy: [],
                        isBlocked: false
                    };
                }
                
                const record = blocked.bySlotField[slotIndex][fieldName];
                record.count++;
                if (bunkDiv && !record.claimedBy.includes(bunkDiv)) {
                    record.claimedBy.push(bunkDiv);
                    blocked.stats.blockedDivisions.add(bunkDiv);
                }
                if (record.count >= record.maxCapacity) {
                    record.isBlocked = true;
                    blocked.stats.totalBlocked++;
                    blocked.stats.blockedFields.add(fieldName);
                }
                
                // Track by bunk/slot
                if (!blocked.byBunkSlot[bunkId]) blocked.byBunkSlot[bunkId] = {};
                blocked.byBunkSlot[bunkId][slotIndex] = { fieldName, division: bunkDiv };
            });
        }
        
        console.log(`🔄 [MSS] Blocked map: ${blocked.stats.totalBlocked} slots, ${blocked.stats.blockedDivisions.size} divisions`);
        return blocked;
    }
    
    function getFieldCapacity(fieldName) {
        const props = window.activityProperties?.[fieldName] || {};
        if (props.sharableWith?.capacity) return parseInt(props.sharableWith.capacity) || 1;
        if (props.sharable || props.sharableWith?.type === 'all') return 2;
        return 1;
    }
    
    function getBunkDivision(bunkId) {
        if (window.bunkMetaData?.[bunkId]?.division) {
            return window.bunkMetaData[bunkId].division;
        }
        if (window.divisions) {
            for (const [divName, divData] of Object.entries(window.divisions)) {
                if (divData.bunks?.includes(bunkId) || divData.bunks?.includes(String(bunkId))) {
                    return divName;
                }
            }
        }
        return null;
    }
    
    function getMyDivisions() {
        // PRIORITY 1: AccessControl.getEditableDivisions (most reliable for schedulers)
        if (window.AccessControl?.isInitialized && window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs && divs.length > 0) {
                console.log('🔄 [MSS] My divisions (from AccessControl.getEditableDivisions):', divs);
                return divs.map(String);
            }
        }
        
        // PRIORITY 2: AccessControl.getUserManagedDivisions
        if (window.AccessControl?.getUserManagedDivisions) {
            const divs = window.AccessControl.getUserManagedDivisions();
            // null means "all divisions" for owners/admins
            if (divs === null) {
                const allDivs = Object.keys(window.divisions || {}).map(String);
                console.log('🔄 [MSS] My divisions (owner/admin - all):', allDivs);
                return allDivs;
            }
            if (divs && divs.length > 0) {
                console.log('🔄 [MSS] My divisions (from getUserManagedDivisions):', divs);
                return divs.map(String);
            }
        }
        
        // PRIORITY 3: SubdivisionScheduleManager
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs && divs.length > 0) {
                console.log('🔄 [MSS] My divisions (from SubdivisionScheduleManager):', divs);
                return divs.map(String);
            }
        }
        
        // PRIORITY 4: Check role - owners/admins get all
        const role = window.AccessControl?.getCurrentRole?.() || 
                    window.getCampistryUserRole?.() || 
                    'owner';
        
        if (role === 'owner' || role === 'admin') {
            const allDivs = Object.keys(window.divisions || {}).map(String);
            console.log('🔄 [MSS] My divisions (role-based, all):', allDivs);
            return allDivs;
        }
        
        // PRIORITY 5: Check team membership data
        if (window._campistryMembership?.assigned_divisions) {
            const divs = window._campistryMembership.assigned_divisions;
            console.log('🔄 [MSS] My divisions (from membership):', divs);
            return divs.map(String);
        }
        
        // PRIORITY 6: Check for direct division assignments
        if (window.AccessControl?._directDivisionAssignments) {
            const divs = window.AccessControl._directDivisionAssignments;
            if (divs && divs.length > 0) {
                console.log('🔄 [MSS] My divisions (from direct assignments):', divs);
                return divs.map(String);
            }
        }
        
        // FALLBACK: Return empty (will block everything - safest for unknown users)
        console.warn('🔄 [MSS] Could not determine divisions - returning empty');
        return [];
    }

    // =========================================================================
    // PART 3: AVAILABILITY CHECKS
    // =========================================================================
    
    function isResourceAvailable(fieldName, slotIndex) {
        if (!STATE.blockedMap?.bySlotField) return { available: true };
        
        const slotData = STATE.blockedMap.bySlotField[slotIndex];
        if (!slotData?.[fieldName]) return { available: true };
        
        const fieldData = slotData[fieldName];
        if (fieldData.isBlocked) {
            return {
                available: false,
                reason: `Claimed by ${fieldData.claimedBy.join(', ')}`
            };
        }
        return { available: true, remaining: fieldData.maxCapacity - fieldData.count };
    }
    
    function isBunkSlotBlocked(bunkId, slotIndex) {
        const bunkDiv = getBunkDivision(bunkId);
        
        // My bunk - not blocked
        if (bunkDiv && STATE.myDivisions.includes(bunkDiv)) {
            return { blocked: false };
        }
        
        // Check if cloud has data for this bunk
        if (STATE.blockedMap?.byBunkSlot?.[bunkId]?.[slotIndex]) {
            const info = STATE.blockedMap.byBunkSlot[bunkId][slotIndex];
            return {
                blocked: true,
                reason: info.division || 'Another scheduler'
            };
        }
        
        return { blocked: false };
    }

    // =========================================================================
    // PART 4: VISUAL BLOCKING
    // =========================================================================
    
    function applyBlockingToGrid() {
        if (!STATE.blockedMap) return;
        
        log('Applying visual blocking...');
        
        const cells = document.querySelectorAll('td[data-slot], .schedule-cell[data-slot]');
        let count = 0;
        
        cells.forEach(cell => {
            cell.classList.remove('blocked-by-other', 'partially-blocked');
            delete cell.dataset.blockedReason;
            
            const slotIndex = parseInt(cell.dataset.slot || cell.dataset.slotIndex);
            const bunkId = cell.dataset.bunk;
            
            if (isNaN(slotIndex)) return;
            
            // Check bunk ownership
            if (bunkId) {
                const check = isBunkSlotBlocked(bunkId, slotIndex);
                if (check.blocked) {
                    cell.classList.add('blocked-by-other');
                    cell.dataset.blockedReason = `🔒 ${check.reason}`;
                    count++;
                    return;
                }
            }
            
            // Check field availability
            const fieldName = cell.dataset.field || cell.dataset.activity;
            if (fieldName) {
                const avail = isResourceAvailable(fieldName, slotIndex);
                if (!avail.available) {
                    cell.classList.add('blocked-by-other');
                    cell.dataset.blockedReason = `🔒 ${avail.reason}`;
                    count++;
                } else if (avail.remaining !== undefined && avail.remaining < getFieldCapacity(fieldName)) {
                    cell.classList.add('partially-blocked');
                    cell.dataset.blockedReason = `⚠️ ${avail.remaining} spots left`;
                }
            }
        });
        
        // Mark blocked rows
        document.querySelectorAll('tr[data-bunk]').forEach(row => {
            row.classList.remove('locked-by-other-scheduler');
            const bunkId = row.dataset.bunk;
            if (!bunkId) return;
            const bunkDiv = getBunkDivision(bunkId);
            if (bunkDiv && !STATE.myDivisions.includes(bunkDiv)) {
                row.classList.add('locked-by-other-scheduler');
            }
        });
        
        if (count > 0) {
            console.log(`🔄 [MSS] Applied blocking to ${count} cells`);
        }
    }

    // =========================================================================
    // PART 5: DRAG-DROP INTERCEPTION
    // =========================================================================
    
    function setupDragDropInterception() {
        log('Setting up drag-drop interception...');
        
        document.addEventListener('dragover', (e) => {
            const cell = e.target.closest('td[data-slot], .schedule-cell[data-slot]');
            if (!cell) return;
            
            const slotIndex = parseInt(cell.dataset.slot);
            const bunkId = cell.dataset.bunk;
            
            if (isNaN(slotIndex)) return;
            
            // Check bunk blocking
            if (bunkId) {
                const check = isBunkSlotBlocked(bunkId, slotIndex);
                if (check.blocked) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'none';
                    cell.classList.add('drag-blocked');
                    return;
                }
            }
            
            cell.classList.remove('drag-blocked');
        }, true);
        
        document.addEventListener('drop', (e) => {
            const cell = e.target.closest('td[data-slot], .schedule-cell[data-slot]');
            if (!cell) return;
            
            cell.classList.remove('drag-blocked');
            
            const slotIndex = parseInt(cell.dataset.slot);
            const bunkId = cell.dataset.bunk;
            
            if (bunkId) {
                const check = isBunkSlotBlocked(bunkId, slotIndex);
                if (check.blocked) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    showToast(`Cannot edit: ${check.reason}`);
                    return false;
                }
            }
        }, true);
        
        document.addEventListener('dragleave', (e) => {
            const cell = e.target.closest('td[data-slot]');
            if (cell) cell.classList.remove('drag-blocked');
        }, true);
        
        document.addEventListener('dragend', () => {
            document.querySelectorAll('.drag-blocked').forEach(el => el.classList.remove('drag-blocked'));
        }, true);
    }
    
    function showToast(message) {
        if (window.showToast) {
            window.showToast(`🔒 ${message}`, 'error');
            return;
        }
        
        let toast = document.getElementById('mss-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'mss-toast';
            document.body.appendChild(toast);
        }
        
        toast.textContent = `🔒 ${message}`;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // =========================================================================
    // PART 6: HOOKS
    // =========================================================================
    
    function hookUpdateTable() {
        if (!window.updateTable || window._mssUpdateTableHooked) return;
        
        const original = window.updateTable;
        window.updateTable = function(...args) {
            const result = original.apply(this, args);
            setTimeout(applyBlockingToGrid, 50);
            return result;
        };
        
        window._mssUpdateTableHooked = true;
        log('Hooked updateTable');
    }
    
    function hookDatePicker() {
        const picker = document.getElementById('calendar-date-picker');
        if (!picker || picker._mssHooked) return;
        
        picker.addEventListener('change', async (e) => {
            console.log(`🔄 [MSS] Date changed to ${e.target.value}`);
            STATE.cloudData = null;
            STATE.lastFetchDate = null;
            STATE.blockedMap = null;
            await initializeView(e.target.value);
        });
        
        picker._mssHooked = true;
        log('Hooked date picker');
    }
    
    function hookGenerator() {
        if (!window.runSkeletonOptimizer || window._mssGeneratorHooked) return;
        
        const original = window.runSkeletonOptimizer;
        window.runSkeletonOptimizer = async function(skeleton, overrides, allowedDivisions, existingSnapshot, ...rest) {
            log('Generator starting - injecting blocked resources...');
            
            // Ensure fresh cloud data
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            if (!STATE.blockedMap) await initializeView(dateKey);
            
            // Inject cloud data into snapshot
            if (STATE.cloudData?.scheduleAssignments && !existingSnapshot) {
                existingSnapshot = {};
            }
            
            if (STATE.cloudData?.scheduleAssignments) {
                for (const [bunkId, slots] of Object.entries(STATE.cloudData.scheduleAssignments)) {
                    const bunkDiv = getBunkDivision(bunkId);
                    if (bunkDiv && STATE.myDivisions.includes(bunkDiv)) continue;
                    
                    if (!existingSnapshot[bunkId]) existingSnapshot[bunkId] = [];
                    
                    if (Array.isArray(slots)) {
                        slots.forEach((slot, idx) => {
                            if (slot && !slot.continuation) {
                                existingSnapshot[bunkId][idx] = {
                                    ...slot,
                                    _locked: true,
                                    _fromOtherScheduler: true
                                };
                            }
                        });
                    }
                }
                log(`Injected ${Object.keys(STATE.cloudData.scheduleAssignments).length} cloud bunks`);
            }
            
            return original.call(this, skeleton, overrides, allowedDivisions, existingSnapshot, ...rest);
        };
        
        window._mssGeneratorHooked = true;
        log('Hooked generator');
    }
    
    function hookCloudSave() {
        const original = window.forceSyncToCloud || window.syncNow;
        if (!original || window._mssSaveHooked) return;
        
        const hooked = async function(...args) {
            // RACE CONDITION FIX: Check if sync is suppressed (during deletion)
            if (window._suppressCloudSync) {
                log('Sync suppressed, skipping');
                return false;
            }
            
            const result = await original.apply(this, args);
            if (result) {
                // Clear cache after save
                STATE.cloudData = null;
                STATE.lastFetchDate = null;
                log('Save complete - cache cleared');
            }
            return result;
        };
        
        if (window.forceSyncToCloud) window.forceSyncToCloud = hooked;
        if (window.syncNow) window.syncNow = hooked;
        
        window._mssSaveHooked = true;
        log('Hooked cloud save');
    }

    // =========================================================================
    // PART 7: HIDE UNWANTED UI ELEMENTS
    // =========================================================================
    
    /**
     * Hide the version toolbar buttons (Save Version, Load Version, Merge & Sync)
     * and suppress the "grades skipped" toast
     */
    function hideUnwantedUI() {
        // Hide version toolbar container
        const versionToolbar = document.getElementById('version-toolbar-container');
        if (versionToolbar) {
            versionToolbar.style.display = 'none';
            log('Hidden version toolbar');
        }
        
        // Also hide parent wrapper if it only contains the toolbar
        const toolbarWrapper = versionToolbar?.parentElement;
        if (toolbarWrapper && toolbarWrapper.children.length === 1) {
            toolbarWrapper.style.display = 'none';
        }
        
        // Suppress "grades skipped" toast by overriding showToast temporarily
        const originalShowToast = window.showToast;
        if (originalShowToast && !window._mssToastPatched) {
            window.showToast = function(message, type) {
                // Suppress the "grades skipped" message
                if (message && message.includes('grades skipped')) {
                    log('Suppressed "grades skipped" toast');
                    return;
                }
                return originalShowToast.call(this, message, type);
            };
            window._mssToastPatched = true;
        }
    }

    // =========================================================================
    // PART 8: INITIALIZATION
    // =========================================================================
    
    async function initializeView(dateKey) {
        dateKey = dateKey || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        console.log(`🔄 [MSS] Initializing for ${dateKey}...`);
        
        // Get divisions (with detailed logging)
        STATE.myDivisions = getMyDivisions();
        console.log('🔄 [MSS] My editable divisions:', STATE.myDivisions);
        
        const cloudData = await fetchCloudSchedule(dateKey);
        if (cloudData) {
            STATE.blockedMap = buildBlockedMap(cloudData, STATE.myDivisions);
            
            // Store globally for scheduler_ui.js
            window._cloudBlockedResources = STATE.blockedMap;
            window._cloudScheduleData = cloudData;
            
            // Log what's being blocked for debugging
            console.log('🔄 [MSS] Blocked divisions:', [...(STATE.blockedMap?.stats?.blockedDivisions || [])]);
        } else {
            console.log('🔄 [MSS] No cloud data found');
        }
        
        STATE.initialized = true;
        
        window.dispatchEvent(new CustomEvent('campistry-blocking-ready', {
            detail: { dateKey, blockedMap: STATE.blockedMap, myDivisions: STATE.myDivisions }
        }));
        
        return { cloudData, blockedMap: STATE.blockedMap, myDivisions: STATE.myDivisions };
    }
    
    function initialize() {
        console.log('🔄 [MSS] Starting initialization...');
        
        injectStyles();
        setupDragDropInterception();
        
        // Hide unwanted UI elements (version toolbar, etc.)
        hideUnwantedUI();
        setTimeout(hideUnwantedUI, 1000);
        setTimeout(hideUnwantedUI, 3000);
        
        // Set up hooks (with retries for late-loading modules)
        const setupHooks = () => {
            hookUpdateTable();
            hookDatePicker();
            hookGenerator();
            hookCloudSave();
        };
        
        setupHooks();
        setTimeout(setupHooks, 500);
        setTimeout(setupHooks, 1500);
        
        // Initialize when BOTH cloud is ready AND access control is loaded
        const initWhenReady = async () => {
            // Wait for AccessControl to be initialized
            if (!window.AccessControl?.isInitialized) {
                console.log('🔄 [MSS] Waiting for AccessControl...');
                return;
            }
            
            const dateKey = window.currentScheduleDate || 
                           document.getElementById('calendar-date-picker')?.value ||
                           new Date().toISOString().split('T')[0];
            await initializeView(dateKey);
            applyBlockingToGrid();
        };
        
        // Listen for cloud ready
        window.addEventListener('campistry-cloud-hydrated', async () => {
            await initWhenReady();
        });
        
        // Listen for access control ready (re-initialize with correct permissions)
        window.addEventListener('campistry-access-loaded', async () => {
            console.log('🔄 [MSS] Access control loaded, re-initializing with correct permissions...');
            STATE.cloudData = null;  // Force re-fetch
            STATE.lastFetchDate = null;
            await initWhenReady();
        });
        
        // Also listen for RBAC ready event
        window.addEventListener('campistry-rbac-ready', async () => {
            console.log('🔄 [MSS] RBAC ready, refreshing blocked map...');
            STATE.myDivisions = getMyDivisions();
            if (STATE.cloudData) {
                STATE.blockedMap = buildBlockedMap(STATE.cloudData, STATE.myDivisions);
                window._cloudBlockedResources = STATE.blockedMap;
                applyBlockingToGrid();
            }
        });
        
        // Re-apply blocking on data updates
        window.addEventListener('campistry-daily-data-updated', () => {
            setTimeout(applyBlockingToGrid, 100);
        });
        
        window.addEventListener('campistry-schedule-rendered', () => {
            setTimeout(applyBlockingToGrid, 50);
        });
        
        // Initialize immediately if both cloud and access are already ready
        if (window.__CAMPISTRY_CLOUD_READY__ && window.AccessControl?.isInitialized) {
            setTimeout(initWhenReady, 300);
        } else if (window.__CAMPISTRY_CLOUD_READY__) {
            // Cloud is ready but AccessControl might not be - wait a bit
            setTimeout(initWhenReady, 1000);
            setTimeout(initWhenReady, 2000);
        }
        
        console.log('🔄 [MSS] Initialization complete');
    }

    // Start
    if (document.readyState === 'complete') {
        setTimeout(initialize, 100);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 100));
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    // Stub function for compatibility (merge UI removed)
    function updateMergeStatusUI() { }
    function showUnifiedScheduleModal() {
        alert('Unified View has been removed. Use the regular schedule view instead.');
    }
    
    window.MultiSchedulerSystem = {
        // State
        getState: () => ({ ...STATE }),
        getBlockedMap: () => STATE.blockedMap,
        getCloudData: () => STATE.cloudData,
        getMyDivisions: () => [...STATE.myDivisions],
        isInitialized: () => STATE.initialized,
        
        // Checks
        isResourceAvailable,
        isBunkSlotBlocked,
        getBunkDivision,
        getFieldCapacity,
        
        // Actions
        initializeView,
        applyBlockingToGrid,
        fetchCloudSchedule,
        hideUnwantedUI,
        
        // Refresh
        refresh: async () => {
            STATE.cloudData = null;
            STATE.lastFetchDate = null;
            STATE.blockedMap = null;
            STATE.myDivisions = getMyDivisions();
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            await initializeView(dateKey);
            applyBlockingToGrid();
        },
        
        // Clear cache (for testing)
        clearCache: () => {
            STATE.cloudData = null;
            STATE.lastFetchDate = null;
            STATE.blockedMap = null;
            window._cloudBlockedResources = null;
            window._cloudScheduleData = null;
        },
        
        // Debug helper
        debugPermissions: () => {
            console.log('=== MSS Debug ===');
            console.log('My divisions:', STATE.myDivisions);
            console.log('Blocked divisions:', [...(STATE.blockedMap?.stats?.blockedDivisions || [])]);
            console.log('AccessControl.getEditableDivisions:', window.AccessControl?.getEditableDivisions?.());
            console.log('AccessControl.getCurrentRole:', window.AccessControl?.getCurrentRole?.());
            console.log('AccessControl.isInitialized:', window.AccessControl?.isInitialized);
        }
    };
    
    // Aliases for compatibility with scheduler_ui.js
    window.MultiSchedulerAutonomous = window.MultiSchedulerSystem;

    console.log("🔄 Multi-Scheduler System v3.2.0 loaded");

})();
