// =============================================================================
// schedule_orchestrator.js v1.0 — CAMPISTRY SCHEDULE ORCHESTRATOR
// =============================================================================
//
// ★★★ THE SINGLE SOURCE OF TRUTH FOR ALL SCHEDULE OPERATIONS ★★★
//
// This module coordinates ALL schedule loading, saving, and deletion.
// It eliminates race conditions by providing a single entry point for
// data operations and a clear event system.
//
// REPLACES THE NEED FOR:
// - schedule_autoloader.js (cloud loading)
// - multi_scheduler_sync_master_patch.js (hydration patches)
// - unified_times_master_fix.js (time persistence patches)
// - Multiple competing event listeners
//
// DATA FLOW:
// ┌─────────────────────────────────────────────────────────────────┐
// │  LOAD:   Cloud → localStorage → window globals → UI            │
// │  SAVE:   window globals → localStorage → Cloud                 │
// │  DELETE: Cloud (all records) → localStorage → window → UI      │
// └─────────────────────────────────────────────────────────────────┘
//
// EVENTS DISPATCHED:
// - campistry-orchestrator-ready     : Orchestrator initialized
// - campistry-schedule-loading       : Starting to load data
// - campistry-schedule-loaded        : Data loaded and hydrated
// - campistry-schedule-saved         : Data saved to cloud
// - campistry-schedule-deleted       : Data deleted
// - campistry-schedule-error         : An error occurred
//
// =============================================================================

(function() {
    'use strict';

    console.log('🎯 Campistry Schedule Orchestrator v1.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const CONFIG = {
        VERSION: '1.0.0',
        DEBUG: true,
        LOCAL_STORAGE_KEY: 'campDailyData_v1',
        
        // Timing
        DEBOUNCE_SAVE_MS: 1000,      // Debounce saves to prevent rapid-fire
        LOAD_TIMEOUT_MS: 10000,       // Max wait for cloud load
        
        // Events
        EVENTS: {
            READY: 'campistry-orchestrator-ready',
            LOADING: 'campistry-schedule-loading',
            LOADED: 'campistry-schedule-loaded',
            SAVED: 'campistry-schedule-saved',
            DELETED: 'campistry-schedule-deleted',
            ERROR: 'campistry-schedule-error'
        }
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _isInitialized = false;
    let _isLoading = false;
    let _currentDateKey = null;
    let _saveTimeout = null;
    let _saveQueue = [];
    let _lastLoadResult = null;

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('🎯 [Orchestrator]', ...args);
        }
    }

    function logError(...args) {
        console.error('🎯 [Orchestrator] ERROR:', ...args);
    }

    function logWarn(...args) {
        console.warn('🎯 [Orchestrator] WARN:', ...args);
    }

    // =========================================================================
    // EVENT HELPERS
    // =========================================================================

    function dispatch(eventName, detail = {}) {
        log('Dispatching:', eventName, detail);
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }

    // =========================================================================
    // DATE KEY HELPERS
    // =========================================================================

    function getCurrentDateKey() {
        return _currentDateKey || 
               window.currentScheduleDate || 
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('datepicker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function setCurrentDateKey(dateKey) {
        _currentDateKey = dateKey;
        window.currentScheduleDate = dateKey;
    }

    // =========================================================================
    // LOCAL STORAGE OPERATIONS
    // =========================================================================

    function getLocalData(dateKey) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            if (!raw) return null;
            
            const allData = JSON.parse(raw);
            return allData[dateKey] || null;
        } catch (e) {
            logError('Failed to read localStorage:', e);
            return null;
        }
    }

    function setLocalData(dateKey, data) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY) || '{}';
            const allData = JSON.parse(raw);
            
            allData[dateKey] = {
                ...data,
                _updatedAt: new Date().toISOString()
            };
            
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(allData));
            log('Saved to localStorage:', dateKey);
            return true;
        } catch (e) {
            logError('Failed to write localStorage:', e);
            return false;
        }
    }

    function deleteLocalData(dateKey) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY) || '{}';
            const allData = JSON.parse(raw);
            
            if (allData[dateKey]) {
                delete allData[dateKey];
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(allData));
                log('Deleted from localStorage:', dateKey);
            }
            return true;
        } catch (e) {
            logError('Failed to delete from localStorage:', e);
            return false;
        }
    }

    // =========================================================================
    // WINDOW GLOBALS MANAGEMENT
    // =========================================================================

    function hydrateWindowGlobals(data) {
        if (!data) {
            log('No data to hydrate, clearing globals');
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            return;
        }

        // Hydrate schedule assignments
        if (data.scheduleAssignments) {
            window.scheduleAssignments = JSON.parse(JSON.stringify(data.scheduleAssignments));
            log('Hydrated scheduleAssignments:', Object.keys(window.scheduleAssignments).length, 'bunks');
        } else {
            window.scheduleAssignments = {};
        }

        // Hydrate league assignments
        if (data.leagueAssignments) {
            window.leagueAssignments = JSON.parse(JSON.stringify(data.leagueAssignments));
            log('Hydrated leagueAssignments');
        } else {
            window.leagueAssignments = {};
        }

        // Hydrate unified times
        if (data.unifiedTimes && data.unifiedTimes.length > 0) {
            window.unifiedTimes = normalizeUnifiedTimes(data.unifiedTimes);
            window._unifiedTimesFromCloud = true;
            log('Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
        }

        // Hydrate rainy day flag
        if (typeof data.isRainyDay === 'boolean') {
            window.isRainyDay = data.isRainyDay;
        }
    }

    function getWindowGlobals() {
        return {
            scheduleAssignments: window.scheduleAssignments || {},
            leagueAssignments: window.leagueAssignments || {},
            unifiedTimes: window.unifiedTimes || [],
            isRainyDay: window.isRainyDay || false
        };
    }

    function clearWindowGlobals() {
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        // Don't clear unifiedTimes - those come from skeleton
        log('Cleared window globals');
    }

    // =========================================================================
    // UNIFIED TIMES NORMALIZATION
    // =========================================================================

    function normalizeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        
        return times.map(t => {
            // Handle both serialized ISO strings and minute values
            let startMin = t.startMin;
            let endMin = t.endMin;

            if (t.start && typeof t.start === 'string' && t.start.includes('T')) {
                const startDate = new Date(t.start);
                startMin = startDate.getHours() * 60 + startDate.getMinutes();
            }

            if (t.end && typeof t.end === 'string' && t.end.includes('T')) {
                const endDate = new Date(t.end);
                endMin = endDate.getHours() * 60 + endDate.getMinutes();
            }

            return {
                start: t.start,
                end: t.end,
                startMin: startMin ?? t.startMin,
                endMin: endMin ?? t.endMin,
                label: t.label || ''
            };
        });
    }

    // =========================================================================
    // CORE: LOAD SCHEDULE
    // =========================================================================

    /**
     * Load schedule for a date.
     * 
     * Priority:
     * 1. Cloud (daily_schedules table) - merges all scheduler records
     * 2. localStorage (fallback if cloud unavailable)
     * 
     * After loading, hydrates window globals and updates UI.
     */
    async function loadSchedule(dateKey, options = {}) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('═══════════════════════════════════════════════════════');
        log('LOAD SCHEDULE:', dateKey);
        log('═══════════════════════════════════════════════════════');

        if (_isLoading) {
            log('Already loading, skipping...');
            return _lastLoadResult;
        }

        _isLoading = true;
        setCurrentDateKey(dateKey);
        dispatch(CONFIG.EVENTS.LOADING, { dateKey });

        let result = {
            success: false,
            source: 'none',
            dateKey,
            data: null,
            bunkCount: 0
        };

        try {
            // ═══════════════════════════════════════════════════════════════
            // STEP 1: Try to load from cloud
            // ═══════════════════════════════════════════════════════════════
            
            if (window.ScheduleDB?.loadSchedule) {
                log('Step 1: Loading from cloud...');
                
                const cloudResult = await Promise.race([
                    window.ScheduleDB.loadSchedule(dateKey),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Cloud timeout')), CONFIG.LOAD_TIMEOUT_MS)
                    )
                ]);

                if (cloudResult?.success && cloudResult.data) {
                    result = {
                        success: true,
                        source: 'cloud',
                        dateKey,
                        data: cloudResult.data,
                        bunkCount: Object.keys(cloudResult.data.scheduleAssignments || {}).length,
                        recordCount: cloudResult.recordCount
                    };
                    
                    log('✅ Cloud load success:', result.bunkCount, 'bunks from', result.recordCount, 'records');
                    
                    // Save to localStorage for offline access
                    setLocalData(dateKey, cloudResult.data);
                } else {
                    log('Cloud returned no data, checking localStorage...');
                }
            } else {
                logWarn('ScheduleDB not available, using localStorage only');
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 2: Fall back to localStorage if needed
            // ═══════════════════════════════════════════════════════════════
            
            if (!result.success) {
                log('Step 2: Checking localStorage...');
                const localData = getLocalData(dateKey);
                
                if (localData) {
                    result = {
                        success: true,
                        source: 'localStorage',
                        dateKey,
                        data: localData,
                        bunkCount: Object.keys(localData.scheduleAssignments || {}).length
                    };
                    log('✅ localStorage load success:', result.bunkCount, 'bunks');
                } else {
                    log('No data in localStorage either');
                    result.success = true; // Empty is still success
                    result.source = 'empty';
                    result.data = {
                        scheduleAssignments: {},
                        leagueAssignments: {},
                        unifiedTimes: []
                    };
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 3: Hydrate window globals
            // ═══════════════════════════════════════════════════════════════
            
            log('Step 3: Hydrating window globals...');
            hydrateWindowGlobals(result.data);

            // ═══════════════════════════════════════════════════════════════
            // STEP 4: Ensure empty state for all divisions
            // ═══════════════════════════════════════════════════════════════
            
            log('Step 4: Ensuring empty state for unscheduled divisions...');
            ensureEmptyStateForAllDivisions();

            // ═══════════════════════════════════════════════════════════════
            // STEP 5: Update UI
            // ═══════════════════════════════════════════════════════════════
            
            log('Step 5: Updating UI...');
            if (window.updateTable) {
                window.updateTable();
            }

            _lastLoadResult = result;
            dispatch(CONFIG.EVENTS.LOADED, result);

            log('═══════════════════════════════════════════════════════');
            log('LOAD COMPLETE:', result.source, '-', result.bunkCount, 'bunks');
            log('═══════════════════════════════════════════════════════');

        } catch (e) {
            logError('Load failed:', e);
            result = { success: false, error: e.message, dateKey };
            dispatch(CONFIG.EVENTS.ERROR, { operation: 'load', error: e.message, dateKey });
        } finally {
            _isLoading = false;
        }

        return result;
    }

    // =========================================================================
    // CORE: SAVE SCHEDULE
    // =========================================================================

    /**
     * Save current schedule to cloud.
     * 
     * Flow:
     * 1. Get data from window globals
     * 2. Filter to user's editable divisions
     * 3. Save to localStorage immediately
     * 4. Save to cloud (debounced)
     */
    async function saveSchedule(dateKey, data, options = {}) {
        if (!dateKey) dateKey = getCurrentDateKey();
        if (!data) data = getWindowGlobals();

        log('SAVE SCHEDULE:', dateKey, Object.keys(data.scheduleAssignments || {}).length, 'bunks');

        // Always save to localStorage immediately
        setLocalData(dateKey, data);

        // Debounce cloud saves
        if (options.immediate) {
            return await doCloudSave(dateKey, data, options);
        } else {
            queueCloudSave(dateKey, data, options);
            return { success: true, target: 'queued' };
        }
    }

    function queueCloudSave(dateKey, data, options) {
        // Clear existing timeout
        if (_saveTimeout) {
            clearTimeout(_saveTimeout);
        }

        // Queue the save
        _saveQueue = [{ dateKey, data, options }]; // Only keep latest

        // Schedule debounced save
        _saveTimeout = setTimeout(async () => {
            if (_saveQueue.length > 0) {
                const item = _saveQueue.shift();
                await doCloudSave(item.dateKey, item.data, item.options);
            }
        }, CONFIG.DEBOUNCE_SAVE_MS);

        log('Save queued, will execute in', CONFIG.DEBOUNCE_SAVE_MS, 'ms');
    }

    async function doCloudSave(dateKey, data, options = {}) {
        if (!window.ScheduleDB?.saveSchedule) {
            logWarn('ScheduleDB not available, saved to localStorage only');
            return { success: true, target: 'localStorage' };
        }

        try {
            const result = await window.ScheduleDB.saveSchedule(dateKey, data, options);
            
            if (result?.success) {
                log('✅ Cloud save success');
                dispatch(CONFIG.EVENTS.SAVED, { dateKey, target: 'cloud' });
            } else {
                logError('Cloud save failed:', result?.error);
                dispatch(CONFIG.EVENTS.ERROR, { operation: 'save', error: result?.error, dateKey });
            }

            return result;
        } catch (e) {
            logError('Cloud save exception:', e);
            dispatch(CONFIG.EVENTS.ERROR, { operation: 'save', error: e.message, dateKey });
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // CORE: DELETE SCHEDULE
    // =========================================================================

    /**
     * Delete schedule data.
     * 
     * For schedulers: Removes their bunks from ALL records (not just their own)
     * For owners/admins: Deletes all records for the date
     * 
     * This is the CRITICAL fix - we must remove bunks from other people's records
     * because the owner may have saved data that includes everyone's bunks.
     */
    async function deleteSchedule(dateKey, options = {}) {
        if (!dateKey) dateKey = getCurrentDateKey();

        const isFullAccess = window.PermissionsDB?.hasFullAccess?.() || 
                            window.AccessControl?.getCurrentRole?.() === 'owner' ||
                            window.AccessControl?.getCurrentRole?.() === 'admin';

        log('═══════════════════════════════════════════════════════');
        log('DELETE SCHEDULE:', dateKey, isFullAccess ? '(FULL DELETE)' : '(MY DIVISIONS ONLY)');
        log('═══════════════════════════════════════════════════════');

        try {
            let result;

            if (isFullAccess || options.deleteAll) {
                // ═══════════════════════════════════════════════════════════
                // OWNER/ADMIN: Delete everything
                // ═══════════════════════════════════════════════════════════
                result = await deleteAllSchedules(dateKey);
            } else {
                // ═══════════════════════════════════════════════════════════
                // SCHEDULER: Remove only their bunks from ALL records
                // ═══════════════════════════════════════════════════════════
                result = await deleteMyBunksFromAllRecords(dateKey);
            }

            // Clear localStorage
            deleteLocalData(dateKey);

            // Clear window globals
            if (isFullAccess || options.deleteAll) {
                clearWindowGlobals();
            } else {
                clearMyBunksFromGlobals();
            }

            // Reload remaining data from cloud
            await reloadAfterDelete(dateKey);

            // Update UI
            if (window.updateTable) {
                window.updateTable();
            }

            dispatch(CONFIG.EVENTS.DELETED, { dateKey, ...result });

            log('═══════════════════════════════════════════════════════');
            log('DELETE COMPLETE');
            log('═══════════════════════════════════════════════════════');

            return result;

        } catch (e) {
            logError('Delete failed:', e);
            dispatch(CONFIG.EVENTS.ERROR, { operation: 'delete', error: e.message, dateKey });
            return { success: false, error: e.message };
        }
    }

    /**
     * Delete ALL records for a date (owner/admin only)
     */
    async function deleteAllSchedules(dateKey) {
        if (!window.ScheduleDB?.deleteSchedule) {
            logWarn('ScheduleDB.deleteSchedule not available');
            return { success: false, error: 'ScheduleDB not available' };
        }

        const result = await window.ScheduleDB.deleteSchedule(dateKey);
        log('Full delete result:', result);
        return result;
    }

    /**
     * ★★★ CRITICAL FIX ★★★
     * 
     * Delete MY bunks from ALL schedule records.
     * 
     * This is necessary because:
     * - The owner might have saved a record that contains MY bunks
     * - Simply deleting my own record won't remove my bunks from the owner's record
     * - We must iterate through ALL records and surgically remove my bunks
     */
    async function deleteMyBunksFromAllRecords(dateKey) {
        log('Deleting my bunks from ALL records...');

        // Get my editable bunks
        const myBunks = getMyBunks();
        log('My bunks to delete:', myBunks);

        if (myBunks.length === 0) {
            log('No bunks assigned to delete');
            return { success: true, message: 'No bunks assigned' };
        }

        // Use ScheduleDB's implementation which handles this correctly
        if (window.ScheduleDB?.deleteMyScheduleOnly) {
            const result = await window.ScheduleDB.deleteMyScheduleOnly(dateKey);
            log('ScheduleDB.deleteMyScheduleOnly result:', result);
            return result;
        }

        // Fallback: Manual implementation
        logWarn('ScheduleDB.deleteMyScheduleOnly not available, using fallback...');
        return await manualDeleteMyBunks(dateKey, myBunks);
    }

    /**
     * Fallback manual implementation of bunk deletion
     */
    async function manualDeleteMyBunks(dateKey, myBunks) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) {
            logError('Cannot delete: missing client or campId');
            return { success: false, error: 'Database not available' };
        }

        try {
            // Load ALL records for this date
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);

            if (loadError) {
                logError('Failed to load records:', loadError);
                return { success: false, error: loadError.message };
            }

            if (!allRecords || allRecords.length === 0) {
                log('No records found');
                return { success: true, message: 'No records to modify' };
            }

            log('Found', allRecords.length, 'records to process');

            const myBunkSet = new Set(myBunks);
            let recordsModified = 0;
            let recordsDeleted = 0;

            // Process each record
            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...scheduleData.scheduleAssignments } || {};
                const leagues = { ...scheduleData.leagueAssignments } || {};

                const bunksBefore = Object.keys(assignments).length;

                // Remove my bunks
                let modified = false;
                for (const bunk of myBunks) {
                    if (assignments[bunk] !== undefined) {
                        delete assignments[bunk];
                        modified = true;
                    }
                    if (leagues[bunk] !== undefined) {
                        delete leagues[bunk];
                    }
                }

                const bunksAfter = Object.keys(assignments).length;
                log(`Record ${record.scheduler_name || record.id}: ${bunksBefore} → ${bunksAfter} bunks`);

                if (!modified) {
                    continue;
                }

                // If record is now empty, delete it
                if (bunksAfter === 0) {
                    const { error: deleteError } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('id', record.id);

                    if (deleteError) {
                        logError('Failed to delete empty record:', deleteError);
                    } else {
                        recordsDeleted++;
                        log('Deleted empty record');
                    }
                } else {
                    // Update the record
                    const updatedData = {
                        ...scheduleData,
                        scheduleAssignments: assignments,
                        leagueAssignments: leagues
                    };

                    const { error: updateError } = await client
                        .from('daily_schedules')
                        .update({
                            schedule_data: updatedData,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', record.id);

                    if (updateError) {
                        logError('Failed to update record:', updateError);
                    } else {
                        recordsModified++;
                        log('Updated record');
                    }
                }
            }

            return {
                success: true,
                recordsModified,
                recordsDeleted,
                bunksRemoved: myBunks.length
            };

        } catch (e) {
            logError('Manual delete exception:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Get bunks that belong to the current user's editable divisions
     */
    function getMyBunks() {
        // Try AccessControl first
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || 
                                 window.PermissionsDB?.getEditableDivisions?.() || [];

        const divisions = window.divisions || {};
        const bunks = [];

        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                bunks.push(...divInfo.bunks);
            }
        }

        return bunks;
    }

    /**
     * Clear only my bunks from window globals
     */
    function clearMyBunksFromGlobals() {
        const myBunks = new Set(getMyBunks());

        if (window.scheduleAssignments) {
            myBunks.forEach(bunk => {
                delete window.scheduleAssignments[bunk];
            });
        }

        if (window.leagueAssignments) {
            myBunks.forEach(bunk => {
                delete window.leagueAssignments[bunk];
            });
        }

        log('Cleared', myBunks.size, 'bunks from window globals');
    }

    /**
     * Reload remaining data after delete
     */
    async function reloadAfterDelete(dateKey) {
        if (!window.ScheduleDB?.loadSchedule) {
            return;
        }

        const result = await window.ScheduleDB.loadSchedule(dateKey);
        
        if (result?.success && result.data) {
            hydrateWindowGlobals(result.data);
            setLocalData(dateKey, result.data);
            log('Reloaded remaining data:', Object.keys(result.data.scheduleAssignments || {}).length, 'bunks');
        } else {
            log('No remaining data after delete');
        }
    }

    // =========================================================================
    // HELPER: ENSURE EMPTY STATE
    // =========================================================================

    function ensureEmptyStateForAllDivisions() {
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }

        const divisions = window.divisions || {};

        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            
            // ★★★ FIX: Use division-specific slot count, not global unifiedTimes ★★★
            const divSlotCount = window.divisionTimes?.[divName]?.length || 
                                 (window.unifiedTimes || []).length || 22;

            for (const bunk of bunks) {
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = new Array(divSlotCount).fill(null);
                }
            }
        }
    }

    // =========================================================================
    // DATE CHANGE HANDLER
    // =========================================================================

    async function handleDateChange(newDateKey) {
        if (newDateKey === _currentDateKey) {
            log('Same date, skipping reload');
            return;
        }

        log('Date changed:', _currentDateKey, '→', newDateKey);
        await loadSchedule(newDateKey);
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) {
            log('Already initialized');
            return;
        }

        log('Initializing...');

        // Wait for dependencies
        await waitForDependencies();

        // Set up event listeners
        setupEventListeners();

        // Load initial data
        const dateKey = getCurrentDateKey();
        if (dateKey) {
            await loadSchedule(dateKey);
        }

        _isInitialized = true;
        log('✅ Orchestrator initialized');

        dispatch(CONFIG.EVENTS.READY, { dateKey });

        // Also dispatch legacy event for backward compatibility
        window.__CAMPISTRY_CLOUD_READY__ = true;
        window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
    }

    async function waitForDependencies() {
        log('Waiting for dependencies...');

        // Wait for CampistryDB
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
            log('CampistryDB ready');
        }

        // Wait for ScheduleDB
        if (!window.ScheduleDB) {
            await new Promise(resolve => {
                const handler = () => {
                    window.removeEventListener('campistry-scheduledb-ready', handler);
                    resolve();
                };
                window.addEventListener('campistry-scheduledb-ready', handler);
                setTimeout(resolve, 3000); // Timeout fallback
            });
        }
        log('ScheduleDB ready');

        // Wait for AccessControl/Permissions
        if (!window.AccessControl && !window.PermissionsDB) {
            await new Promise(resolve => {
                const handler = () => {
                    window.removeEventListener('campistry-rbac-ready', handler);
                    window.removeEventListener('rbac-system-ready', handler);
                    resolve();
                };
                window.addEventListener('campistry-rbac-ready', handler);
                window.addEventListener('rbac-system-ready', handler);
                setTimeout(resolve, 3000); // Timeout fallback
            });
        }
        log('Permissions ready');
    }

    function setupEventListeners() {
        // Listen for date changes
        window.addEventListener('campistry-date-changed', (e) => {
            handleDateChange(e.detail?.dateKey);
        });

        // Listen for realtime updates from other schedulers
        window.addEventListener('campistry-realtime-update', (e) => {
            log('Realtime update received, reloading...');
            loadSchedule(getCurrentDateKey());
        });

        // Listen for generation complete
        window.addEventListener('campistry-generation-complete', (e) => {
            const dateKey = e.detail?.dateKey || getCurrentDateKey();
            log('Generation complete, saving...');
            saveSchedule(dateKey, getWindowGlobals(), { immediate: true });
        });

        log('Event listeners set up');
    }

    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    function diagnose() {
        const dateKey = getCurrentDateKey();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('🎯 ORCHESTRATOR DIAGNOSIS');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Version:', CONFIG.VERSION);
        console.log('Initialized:', _isInitialized);
        console.log('Is Loading:', _isLoading);
        console.log('Current Date Key:', dateKey);
        console.log('');
        
        console.log('=== Window Globals ===');
        console.log('scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('leagueAssignments:', Object.keys(window.leagueAssignments || {}).length, 'bunks');
        console.log('unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('');
        
        console.log('=== LocalStorage ===');
        const localData = getLocalData(dateKey);
        if (localData) {
            console.log('scheduleAssignments:', Object.keys(localData.scheduleAssignments || {}).length, 'bunks');
            console.log('Updated at:', localData._updatedAt);
        } else {
            console.log('No data for', dateKey);
        }
        console.log('');
        
        console.log('=== Dependencies ===');
        console.log('CampistryDB:', !!window.CampistryDB);
        console.log('ScheduleDB:', !!window.ScheduleDB);
        console.log('AccessControl:', !!window.AccessControl);
        console.log('PermissionsDB:', !!window.PermissionsDB);
        console.log('');
        
        console.log('=== User Permissions ===');
        console.log('Role:', window.AccessControl?.getCurrentRole?.() || 'unknown');
        console.log('Editable Divisions:', window.AccessControl?.getEditableDivisions?.() || []);
        console.log('My Bunks:', getMyBunks());
        console.log('═══════════════════════════════════════════════════════');
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.ScheduleOrchestrator = {
        // Core operations
        loadSchedule,
        saveSchedule,
        deleteSchedule,
        
        // Date management
        getCurrentDateKey,
        setCurrentDateKey,
        handleDateChange,
        
        // State access
        getWindowGlobals,
        getLocalData,
        
        // Utilities
        getMyBunks,
        ensureEmptyStateForAllDivisions,
        
        // Diagnostics
        diagnose,
        
        // Status
        get isInitialized() { return _isInitialized; },
        get isLoading() { return _isLoading; },
        get version() { return CONFIG.VERSION; }
    };

    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================

    // Initialize when DOM is ready and dependencies are available
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initialize, 200);
        });
    } else {
        setTimeout(initialize, 200);
    }

    console.log('🎯 Campistry Schedule Orchestrator v1.0 loaded');

})();
