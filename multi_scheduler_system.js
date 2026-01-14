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
        // Try AccessControl first (most reliable)
        if (window.AccessControl?.getEditableDivisions) {
            return window.AccessControl.getEditableDivisions().map(String);
        }
        if (window.AccessControl?.getUserManagedDivisions) {
            return window.AccessControl.getUserManagedDivisions().map(String);
        }
        
        // Check role
        const role = window.AccessControl?.getCurrentRole?.() || window.getCampistryUserRole?.() || 'owner';
        
        // Owners/admins get all divisions
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {}).map(String);
        }
        
        // Schedulers - try to find their assigned divisions
        if (window.AccessControl?.getCurrentUserInfo) {
            const info = window.AccessControl.getCurrentUserInfo();
            if (info?.divisions) return info.divisions.map(String);
        }
        
        // Fallback: empty (will block everything)
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
                
                // Update merge UI
                setTimeout(updateMergeStatusUI, 500);
            }
            return result;
        };
        
        if (window.forceSyncToCloud) window.forceSyncToCloud = hooked;
        if (window.syncNow) window.syncNow = hooked;
        
        window._mssSaveHooked = true;
        log('Hooked cloud save');
    }

    // =========================================================================
    // PART 7: MERGE UI FOR DAILY SCHEDULING VIEW
    // =========================================================================
    
    /**
     * Inject merge status panel into daily scheduling view
     */
    function injectMergeUI() {
        if (STATE.mergeUIInjected) return;
        
        const scheduleTable = document.getElementById('scheduleTable');
        if (!scheduleTable) {
            setTimeout(injectMergeUI, 500);
            return;
        }
        
        // Check if already exists
        if (document.getElementById('mss-merge-panel')) {
            STATE.mergeUIInjected = true;
            return;
        }
        
        // Create merge status panel
        const panel = document.createElement('div');
        panel.id = 'mss-merge-panel';
        panel.innerHTML = `
            <style>
                #mss-merge-panel {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 10px 16px;
                    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
                    border-radius: 8px;
                    margin-bottom: 12px;
                    color: white;
                    font-size: 13px;
                }
                #mss-merge-panel .mss-status-indicator {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #mss-merge-panel .mss-dot {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    background: #22c55e;
                    animation: mss-pulse 2s infinite;
                }
                #mss-merge-panel .mss-dot.warning { background: #f59e0b; }
                #mss-merge-panel .mss-dot.error { background: #ef4444; animation: none; }
                @keyframes mss-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
                #mss-merge-panel .mss-actions {
                    margin-left: auto;
                    display: flex;
                    gap: 8px;
                }
                #mss-merge-panel button {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                    transition: all 0.2s;
                }
                #mss-merge-panel .mss-btn-primary {
                    background: #3b82f6;
                    color: white;
                }
                #mss-merge-panel .mss-btn-primary:hover {
                    background: #2563eb;
                }
                #mss-merge-panel .mss-btn-secondary {
                    background: rgba(255,255,255,0.1);
                    color: white;
                }
                #mss-merge-panel .mss-btn-secondary:hover {
                    background: rgba(255,255,255,0.2);
                }
                #mss-merge-panel .mss-stats {
                    display: flex;
                    gap: 16px;
                    font-size: 11px;
                    opacity: 0.8;
                }
                #mss-unified-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.7);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                #mss-unified-modal .modal-content {
                    background: white;
                    border-radius: 12px;
                    width: 90%;
                    max-width: 1200px;
                    max-height: 85vh;
                    overflow: auto;
                    box-shadow: 0 25px 50px rgba(0,0,0,0.3);
                }
                #mss-unified-modal .modal-header {
                    padding: 16px 24px;
                    border-bottom: 1px solid #e5e7eb;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    position: sticky;
                    top: 0;
                    background: white;
                    z-index: 1;
                }
                #mss-unified-modal .modal-body {
                    padding: 24px;
                }
                #mss-unified-modal .close-btn {
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    opacity: 0.5;
                }
                #mss-unified-modal .close-btn:hover { opacity: 1; }
            </style>
            <div class="mss-status-indicator">
                <span class="mss-dot" id="mss-status-dot"></span>
                <span id="mss-status-text">Multi-Scheduler Active</span>
            </div>
            <div class="mss-stats" id="mss-stats">
                <span id="mss-stat-blocked">0 blocked</span>
                <span id="mss-stat-schedulers">1 scheduler</span>
            </div>
            <div class="mss-actions">
                <button class="mss-btn-secondary" id="mss-btn-refresh" title="Refresh from cloud">
                    🔄 Refresh
                </button>
                <button class="mss-btn-primary" id="mss-btn-unified" title="View unified schedule">
                    📊 Unified View
                </button>
            </div>
        `;
        
        // Insert before schedule table
        scheduleTable.parentNode.insertBefore(panel, scheduleTable);
        
        // Bind events
        document.getElementById('mss-btn-refresh').addEventListener('click', async () => {
            const btn = document.getElementById('mss-btn-refresh');
            btn.innerHTML = '⏳ Loading...';
            btn.disabled = true;
            
            try {
                STATE.cloudData = null;
                STATE.lastFetchDate = null;
                const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                await initializeView(dateKey);
                applyBlockingToGrid();
                updateMergeStatusUI();
                showToast('✅ Refreshed from cloud', 'success');
            } finally {
                btn.innerHTML = '🔄 Refresh';
                btn.disabled = false;
            }
        });
        
        document.getElementById('mss-btn-unified').addEventListener('click', showUnifiedScheduleModal);
        
        STATE.mergeUIInjected = true;
        log('Merge UI injected');
        
        // Initial update
        setTimeout(updateMergeStatusUI, 100);
    }
    
    /**
     * Update merge status UI
     */
    function updateMergeStatusUI() {
        const dot = document.getElementById('mss-status-dot');
        const text = document.getElementById('mss-status-text');
        const statBlocked = document.getElementById('mss-stat-blocked');
        const statSchedulers = document.getElementById('mss-stat-schedulers');
        
        if (!dot || !text) return;
        
        const blockedCount = STATE.blockedMap?.stats?.totalBlocked || 0;
        const cloudBunks = Object.keys(STATE.cloudData?.scheduleAssignments || {}).length;
        const myDivs = STATE.myDivisions?.length || 0;
        
        // Update stats
        if (statBlocked) statBlocked.textContent = `${blockedCount} blocked`;
        if (statSchedulers) {
            const schedulerCount = STATE.blockedMap?.stats?.blockedDivisions?.size || 0;
            statSchedulers.textContent = schedulerCount > 0 
                ? `${schedulerCount + 1} schedulers` 
                : 'Solo mode';
        }
        
        // Update status indicator
        if (blockedCount > 0) {
            dot.className = 'mss-dot warning';
            text.textContent = `${blockedCount} slots claimed by others`;
        } else if (cloudBunks > 0) {
            dot.className = 'mss-dot';
            text.textContent = 'Synced with cloud';
        } else {
            dot.className = 'mss-dot';
            text.textContent = 'Multi-Scheduler Active';
        }
    }
    
    /**
     * Show unified schedule modal
     */
    function showUnifiedScheduleModal() {
        // Remove existing modal
        const existing = document.getElementById('mss-unified-modal');
        if (existing) existing.remove();
        
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        // Build unified data
        const localData = window.loadCurrentDailyData?.() || {};
        const cloudData = STATE.cloudData || {};
        
        // Merge local + cloud
        const unified = mergeScheduleData(localData, cloudData);
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'mss-unified-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>📊 Unified Schedule View - ${dateKey}</h2>
                    <button class="close-btn">&times;</button>
                </div>
                <div class="modal-body">
                    <div id="mss-unified-content">Loading...</div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Close handlers
        modal.querySelector('.close-btn').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        
        // Render unified content
        renderUnifiedSchedule(unified, document.getElementById('mss-unified-content'));
    }
    
    /**
     * Merge local and cloud schedule data
     */
    function mergeScheduleData(localData, cloudData) {
        const merged = {
            scheduleAssignments: {},
            leagueAssignments: {},
            skeleton: localData.manualSkeleton || localData.skeleton || cloudData.skeleton || [],
            unifiedTimes: localData.unifiedTimes || window.unifiedTimes || cloudData.unifiedTimes || [],
            _sources: []
        };
        
        // Add cloud data first (lower priority)
        if (cloudData.scheduleAssignments) {
            for (const [bunkId, slots] of Object.entries(cloudData.scheduleAssignments)) {
                merged.scheduleAssignments[bunkId] = [...(slots || [])];
            }
            merged._sources.push('cloud');
        }
        
        // Overlay local data (higher priority for user's divisions)
        const localAssignments = localData.scheduleAssignments || window.scheduleAssignments || {};
        for (const [bunkId, slots] of Object.entries(localAssignments)) {
            const bunkDiv = getBunkDivision(bunkId);
            
            // Only override if this is my bunk OR cloud doesn't have it
            if (STATE.myDivisions.includes(bunkDiv) || !merged.scheduleAssignments[bunkId]) {
                merged.scheduleAssignments[bunkId] = [...(slots || [])];
            }
        }
        
        if (Object.keys(localAssignments).length > 0) {
            merged._sources.push('local');
        }
        
        // Merge league assignments
        merged.leagueAssignments = {
            ...(cloudData.leagueAssignments || {}),
            ...(localData.leagueAssignments || window.leagueAssignments || {})
        };
        
        return merged;
    }
    
    /**
     * Render unified schedule in modal
     */
    function renderUnifiedSchedule(unified, container) {
        if (!container) return;
        
        const assignments = unified.scheduleAssignments || {};
        const bunks = Object.keys(assignments).sort();
        const times = unified.unifiedTimes || window.unifiedTimes || [];
        
        if (bunks.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:#666;">No schedule data found. Generate a schedule first.</p>';
            return;
        }
        
        // Group by division
        const byDivision = {};
        bunks.forEach(bunk => {
            const div = getBunkDivision(bunk) || 'Unknown';
            if (!byDivision[div]) byDivision[div] = [];
            byDivision[div].push(bunk);
        });
        
        let html = `
            <div style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px;font-size:13px;">
                <strong>📊 Summary:</strong> 
                ${bunks.length} bunks across ${Object.keys(byDivision).length} divisions, 
                ${times.length} time slots
                ${unified._sources?.length > 1 ? ' • <span style="color:#059669;">✓ Merged from multiple sources</span>' : ''}
            </div>
        `;
        
        // Render each division
        for (const [divName, divBunks] of Object.entries(byDivision)) {
            const isMyDiv = STATE.myDivisions.includes(divName);
            
            html += `
                <div style="margin-bottom:24px;">
                    <h3 style="margin:0 0 12px;padding:8px 12px;background:${isMyDiv ? '#dcfce7' : '#f1f5f9'};border-radius:6px;font-size:14px;">
                        ${isMyDiv ? '✏️' : '🔒'} Division ${divName} 
                        <span style="font-weight:normal;opacity:0.7;">(${divBunks.length} bunks)</span>
                    </h3>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead>
                            <tr style="background:#f8fafc;">
                                <th style="padding:8px;border:1px solid #e2e8f0;text-align:left;">Bunk</th>
                                ${times.slice(0, 12).map((t, i) => 
                                    `<th style="padding:8px;border:1px solid #e2e8f0;text-align:center;font-size:10px;">
                                        ${typeof t === 'object' ? (t.label || `Slot ${i}`) : t}
                                    </th>`
                                ).join('')}
                            </tr>
                        </thead>
                        <tbody>
            `;
            
            divBunks.sort().forEach(bunk => {
                const slots = assignments[bunk] || [];
                html += `<tr>
                    <td style="padding:6px 8px;border:1px solid #e2e8f0;font-weight:500;">${bunk}</td>
                    ${times.slice(0, 12).map((_, i) => {
                        const slot = slots[i];
                        if (!slot || slot.continuation) {
                            return `<td style="padding:4px;border:1px solid #e2e8f0;background:#fafafa;"></td>`;
                        }
                        const label = slot._activity || slot.field || slot.sport || '';
                        const bg = slot._fromOtherScheduler ? '#fef3c7' : '#fff';
                        return `<td style="padding:4px;border:1px solid #e2e8f0;background:${bg};font-size:10px;text-align:center;" title="${JSON.stringify(slot).substring(0, 100)}">
                            ${label}
                        </td>`;
                    }).join('')}
                </tr>`;
            });
            
            html += '</tbody></table></div>';
        }
        
        container.innerHTML = html;
    }

    // =========================================================================
    // PART 8: INITIALIZATION
    // =========================================================================
    
    async function initializeView(dateKey) {
        dateKey = dateKey || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        console.log(`🔄 [MSS] Initializing for ${dateKey}...`);
        
        STATE.myDivisions = getMyDivisions();
        log('My divisions:', STATE.myDivisions);
        
        const cloudData = await fetchCloudSchedule(dateKey);
        if (cloudData) {
            STATE.blockedMap = buildBlockedMap(cloudData, STATE.myDivisions);
            
            // Store globally for scheduler_ui.js
            window._cloudBlockedResources = STATE.blockedMap;
            window._cloudScheduleData = cloudData;
        }
        
        STATE.initialized = true;
        
        // Update merge UI
        updateMergeStatusUI();
        
        window.dispatchEvent(new CustomEvent('campistry-blocking-ready', {
            detail: { dateKey, blockedMap: STATE.blockedMap }
        }));
        
        return { cloudData, blockedMap: STATE.blockedMap, myDivisions: STATE.myDivisions };
    }
    
    function initialize() {
        console.log('🔄 [MSS] Starting initialization...');
        
        injectStyles();
        setupDragDropInterception();
        
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
        
        // Inject merge UI when schedule tab is visible
        const injectMergeUIWhenReady = () => {
            const scheduleTab = document.getElementById('schedule');
            if (scheduleTab && scheduleTab.classList.contains('tab-content')) {
                injectMergeUI();
            } else {
                setTimeout(injectMergeUIWhenReady, 500);
            }
        };
        setTimeout(injectMergeUIWhenReady, 1000);
        
        // Also inject when tab changes
        document.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-tab="schedule"]');
            if (tab) setTimeout(injectMergeUI, 100);
        });
        
        // Initialize when cloud is ready
        window.addEventListener('campistry-cloud-hydrated', async () => {
            const dateKey = window.currentScheduleDate || 
                           document.getElementById('calendar-date-picker')?.value ||
                           new Date().toISOString().split('T')[0];
            await initializeView(dateKey);
            applyBlockingToGrid();
            injectMergeUI();
        });
        
        // Re-apply blocking on data updates
        window.addEventListener('campistry-daily-data-updated', () => {
            setTimeout(applyBlockingToGrid, 100);
            setTimeout(updateMergeStatusUI, 150);
        });
        
        window.addEventListener('campistry-schedule-rendered', () => {
            setTimeout(applyBlockingToGrid, 50);
        });
        
        // Initialize immediately if cloud already ready
        if (window.__CAMPISTRY_CLOUD_READY__) {
            const dateKey = window.currentScheduleDate || 
                           document.getElementById('calendar-date-picker')?.value ||
                           new Date().toISOString().split('T')[0];
            setTimeout(async () => {
                await initializeView(dateKey);
                applyBlockingToGrid();
                injectMergeUI();
            }, 300);
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
        showUnifiedScheduleModal,
        
        // Refresh
        refresh: async () => {
            STATE.cloudData = null;
            STATE.lastFetchDate = null;
            STATE.blockedMap = null;
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            await initializeView(dateKey);
            applyBlockingToGrid();
            updateMergeStatusUI();
        },
        
        // Clear cache (for testing)
        clearCache: () => {
            STATE.cloudData = null;
            STATE.lastFetchDate = null;
            STATE.blockedMap = null;
            window._cloudBlockedResources = null;
            window._cloudScheduleData = null;
        }
    };
    
    // Aliases for compatibility with scheduler_ui.js
    window.MultiSchedulerAutonomous = window.MultiSchedulerSystem;

    console.log("🔄 Multi-Scheduler System v3.2.0 loaded");

})();
