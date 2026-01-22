// =============================================================================
// integration_hooks.js v6.1 — CAMPISTRY SCHEDULER INTEGRATION
// =============================================================================
//
// FIXES IN v6.1:
// - ★ BYPASS SAVE GUARD - Skips remote merge during _postEditInProgress
//
// FIXES IN v6.0:
// - ★ BATCHED GLOBAL SETTINGS SYNC - Multiple calls are batched into one cloud write
// - ★ ALL DATA TYPES sync to camp_state (divisions, bunks, activities, fields, etc.)
// - ★ forceSyncToCloud() properly pushes all pending changes
// - ★ Local storage stays in sync with cloud
// - ★ Debounced auto-sync with 500ms delay
//
// HOW TO USE:
// 1. Include all 4 supabase_*.js files in your HTML
// 2. Include this file AFTER them
// 3. Your existing scheduler will automatically use the new system
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔗 Campistry Integration Hooks v6.1 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const CONFIG = {
        SYNC_DEBOUNCE_MS: 500,        // Batch saves within this window
        LOCAL_STORAGE_KEY: 'campGlobalSettings_v1',
        DEBUG: true
    };

    // =========================================================================
    // STATE
    // =========================================================================
    
    let _pendingChanges = {};          // Accumulated changes to sync
    let _syncTimeout = null;           // Debounce timer
    let _isSyncing = false;            // Prevent re-entry
    let _localCache = null;            // In-memory cache of global settings
    let _lastSyncTime = 0;

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('🔗 [Hooks]', ...args);
        }
    }

    function logError(...args) {
        console.error('🔗 [Hooks] ERROR:', ...args);
    }

    // =========================================================================
    // LOCAL STORAGE HELPERS
    // =========================================================================

    function getLocalSettings() {
        if (_localCache !== null) {
            return _localCache;
        }
        
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            _localCache = raw ? JSON.parse(raw) : {};
            return _localCache;
        } catch (e) {
            logError('Failed to read local settings:', e);
            return {};
        }
    }

    function setLocalSettings(data) {
        try {
            _localCache = data;
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
            
            // Also update legacy keys for backward compatibility
            localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(data));
            
            // Update the global registry cache
            if (data.divisions || data.bunks) {
                localStorage.setItem('campGlobalRegistry_v1', JSON.stringify({
                    divisions: data.divisions || {},
                    bunks: data.bunks || []
                }));
            }
        } catch (e) {
            logError('Failed to write local settings:', e);
        }
    }

    function updateLocalSetting(key, value) {
        const current = getLocalSettings();
        current[key] = value;
        current.updated_at = new Date().toISOString();
        setLocalSettings(current);
    }

    // =========================================================================
    // CLOUD SYNC - BATCHED OPERATIONS
    // =========================================================================

    /**
     * Queue a setting change for batch sync.
     * Multiple calls within SYNC_DEBOUNCE_MS are batched together.
     */
    function queueSettingChange(key, value) {
        // Immediately update local storage
        updateLocalSetting(key, value);
        
        // Add to pending changes
        _pendingChanges[key] = value;
        
        log(`Queued change: ${key}`, typeof value === 'object' ? 
            (Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`) : 
            value);
        
        // Schedule debounced sync
        scheduleBatchSync();
    }

    /**
     * Schedule a batched sync operation.
     */
    function scheduleBatchSync() {
        if (_syncTimeout) {
            clearTimeout(_syncTimeout);
        }
        
        _syncTimeout = setTimeout(async () => {
            await executeBatchSync();
        }, CONFIG.SYNC_DEBOUNCE_MS);
    }

    /**
     * Execute the batched sync to cloud.
     */
    async function executeBatchSync() {
        if (_isSyncing) {
            log('Sync already in progress, rescheduling...');
            scheduleBatchSync();
            return;
        }
        
        if (Object.keys(_pendingChanges).length === 0) {
            log('No pending changes to sync');
            return;
        }

        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        
        if (!client || !campId) {
            log('No client or camp ID, changes saved locally only');
            _pendingChanges = {};
            return;
        }

        _isSyncing = true;
        const changesToSync = { ..._pendingChanges };
        _pendingChanges = {};

        try {
            log('Executing batch sync:', Object.keys(changesToSync));

            // Get current cloud state
            const { data: current, error: fetchError } = await client
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();

            if (fetchError && fetchError.code !== 'PGRST116') {
                // PGRST116 = no rows found, which is fine for new camps
                logError('Failed to fetch current state:', fetchError);
                throw fetchError;
            }

            // Merge changes into current state
            const currentState = current?.state || {};
            const newState = { 
                ...currentState, 
                ...changesToSync,
                updated_at: new Date().toISOString()
            };

            // Upsert to cloud
            const { error: upsertError } = await client
                .from('camp_state')
                .upsert({
                    camp_id: campId,
                    state: newState,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'camp_id'
                });

            if (upsertError) {
                logError('Failed to sync to cloud:', upsertError);
                throw upsertError;
            }

            _lastSyncTime = Date.now();
            
            console.log('☁️ Cloud sync complete:', {
                keys: Object.keys(changesToSync),
                divisions: newState.divisions ? Object.keys(newState.divisions).length : 0,
                bunks: newState.bunks?.length || 0,
                activities: newState.specialActivities?.length || 
                           newState.app1?.specialActivities?.length || 0
            });

            // Dispatch success event
            window.dispatchEvent(new CustomEvent('campistry-settings-synced', {
                detail: { keys: Object.keys(changesToSync) }
            }));

        } catch (e) {
            logError('Batch sync failed:', e);
            
            // Re-queue failed changes for retry
            Object.assign(_pendingChanges, changesToSync);
            
            // Dispatch error event
            window.dispatchEvent(new CustomEvent('campistry-sync-error', {
                detail: { error: e.message, keys: Object.keys(changesToSync) }
            }));
        } finally {
            _isSyncing = false;
        }
    }

    /**
     * Force an immediate sync (bypasses debounce).
     */
    async function forceSyncToCloud() {
        log('Force sync requested');
        
        // Clear any pending debounce
        if (_syncTimeout) {
            clearTimeout(_syncTimeout);
            _syncTimeout = null;
        }

        // Include any local changes that might not be in pending
        const localSettings = getLocalSettings();
        
        // Merge local into pending (local takes precedence for most recent)
        const allChanges = { ...localSettings, ..._pendingChanges };
        _pendingChanges = allChanges;
        
        // Execute immediately
        await executeBatchSync();
        
        return true;
    }

    // =========================================================================
    // BACKWARD COMPATIBILITY LAYER
    // =========================================================================

    /**
     * saveGlobalSettings - Save a setting (queued for batch sync)
     * This is SYNCHRONOUS for callers but queues async cloud sync.
     */
    window.saveGlobalSettings = function(key, data) {
        // For daily_schedules, route to ScheduleDB
        if (key === 'daily_schedules') {
            const dateKey = Object.keys(data)[0];
            if (dateKey && data[dateKey]) {
                // Fire and forget - let ScheduleDB handle it
                window.ScheduleDB?.saveSchedule?.(dateKey, data[dateKey])
                    .catch(e => logError('ScheduleDB save failed:', e));
            }
            return true;
        }
        
        // All other settings go through batched sync
        queueSettingChange(key, data);
        
        // Return synchronously for backward compatibility
        return true;
    };

    /**
     * loadGlobalSettings - Load settings (from cache or cloud)
     * This is SYNCHRONOUS and returns cached data.
     */
    window.loadGlobalSettings = function(key) {
        const settings = getLocalSettings();
        
        if (key) {
            return settings[key] ?? settings.app1?.[key] ?? {};
        }
        
        return settings;
    };

    /**
     * forceSyncToCloud - Exposed globally for other modules
     */
    window.forceSyncToCloud = forceSyncToCloud;

    /**
     * setCloudState - Full state replacement (used by import)
     */
    window.setCloudState = async function(newState, force = false) {
        log('setCloudState called', force ? '(forced)' : '');
        
        // Update local storage
        setLocalSettings(newState);
        
        // Queue all keys for sync
        Object.keys(newState).forEach(key => {
            _pendingChanges[key] = newState[key];
        });
        
        if (force) {
            await forceSyncToCloud();
        } else {
            scheduleBatchSync();
        }
        
        return true;
    };

    /**
     * resetCloudState - Clear all data (used by erase)
     */
    window.resetCloudState = async function() {
        log('resetCloudState called');
        
        const emptyState = {
            divisions: {},
            bunks: [],
            app1: {
                divisions: {}, bunks: [], fields: [], specialActivities: [],
                allSports: [], bunkMetaData: {}, sportMetaData: {},
                savedSkeletons: {}, skeletonAssignments: {}
            },
            locationZones: {},
            pinnedTileDefaults: {},
            leaguesByName: {},
            leagueRoundState: {},
            leagueHistory: {},
            specialtyLeagueHistory: {},
            daily_schedules: {},
            updated_at: new Date().toISOString()
        };
        
        // Clear local
        setLocalSettings(emptyState);
        _pendingChanges = emptyState;
        
        // Sync immediately
        await forceSyncToCloud();
        
        return true;
    };

    /**
     * clearCloudKeys - Clear specific keys from cloud
     */
    window.clearCloudKeys = async function(keys) {
        log('clearCloudKeys called:', keys);
        
        const settings = getLocalSettings();
        keys.forEach(key => {
            settings[key] = key === 'daily_schedules' ? {} : 
                           key === 'bunks' ? [] : {};
            _pendingChanges[key] = settings[key];
        });
        
        setLocalSettings(settings);
        await forceSyncToCloud();
        
        return true;
    };

    // =========================================================================
    // CLOUD HYDRATION ON STARTUP
    // =========================================================================

    async function hydrateFromCloud() {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        
        if (!client || !campId) {
            log('No client/camp ID for hydration');
            return;
        }

        try {
            log('Hydrating from cloud...');
            
            const { data, error } = await client
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();

            if (error) {
                if (error.code === 'PGRST116') {
                    log('No cloud state found, using local');
                } else {
                    logError('Hydration failed:', error);
                }
                return;
            }

            if (data?.state) {
                const cloudState = data.state;
                const localState = getLocalSettings();
                
                // Merge: cloud wins for structure, but preserve any local changes
                // that are newer (based on updated_at)
                const cloudTime = new Date(cloudState.updated_at || 0).getTime();
                const localTime = new Date(localState.updated_at || 0).getTime();
                
                let mergedState;
                if (localTime > cloudTime) {
                    // Local is newer - use local but fill in missing from cloud
                    mergedState = { ...cloudState, ...localState };
                    log('Using local state (newer)');
                } else {
                    // Cloud is newer - use cloud
                    mergedState = cloudState;
                    log('Using cloud state (newer)');
                }
                
                setLocalSettings(mergedState);
                
                // Update window references for legacy code
                window.divisions = mergedState.divisions || {};
                window.globalBunks = mergedState.bunks || [];
                window.availableDivisions = Object.keys(mergedState.divisions || {});
                
                console.log('☁️ Hydrated from cloud:', {
                    divisions: Object.keys(mergedState.divisions || {}).length,
                    bunks: (mergedState.bunks || []).length,
                    activities: (mergedState.app1?.specialActivities || []).length,
                    fields: (mergedState.app1?.fields || []).length
                });
                
                // Dispatch hydration event
                window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
            }
        } catch (e) {
            logError('Hydration exception:', e);
        }
    }

    // =========================================================================
    // WAIT FOR ALL SYSTEMS TO BE READY
    // =========================================================================

    async function waitForSystems() {
        // Wait for CampistryDB
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        // Wait a bit for other modules
        await new Promise(r => setTimeout(r, 200));

        // Hydrate from cloud first
        await hydrateFromCloud();

        console.log('🔗 All systems ready, installing hooks...');
        installHooks();
    }

    // =========================================================================
    // HOOK: AUTO-SUBSCRIBE ON DATE CHANGE
    // =========================================================================

    let _datePickerRetries = 0;
    const MAX_DATE_PICKER_RETRIES = 5;
    let _datePickerHooked = false;

    function hookDatePicker() {
        if (_datePickerHooked) return;
        
        const datePicker = document.getElementById('schedule-date-input') ||
                          document.getElementById('datepicker');
        
        if (!datePicker) {
            _datePickerRetries++;
            if (_datePickerRetries < MAX_DATE_PICKER_RETRIES) {
                // Silent retry
                setTimeout(hookDatePicker, 2000);
            } else if (_datePickerRetries === MAX_DATE_PICKER_RETRIES) {
                log('Date picker not found on this page (normal for Setup tab)');
            }
            return;
        }
        
        _datePickerHooked = true;
        log('Date picker found, hooking...');
        
        // Handle initial value if present
        if (datePicker.value && !window.currentScheduleDate) {
            window.currentScheduleDate = datePicker.value;
            log('Initial date set:', datePicker.value);
        }

        datePicker.addEventListener('change', async (e) => {
            const dateKey = e.target.value;
            if (!dateKey) return;

            console.log('🔗 Date changed to:', dateKey);

            window.currentScheduleDate = dateKey;

            // Subscribe to realtime for this date
            if (window.ScheduleSync?.subscribe) {
                await window.ScheduleSync.subscribe(dateKey);
            }

            // Load schedule for this date
            if (window.ScheduleDB?.loadSchedule) {
                const result = await window.ScheduleDB.loadSchedule(dateKey);
                
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                    
                    if (result.data.unifiedTimes?.length > 0) {
                        window.unifiedTimes = result.data.unifiedTimes;
                    }

                    if (window.updateTable) {
                        window.updateTable();
                    }

                    console.log('🔗 Loaded schedule for', dateKey, {
                        bunks: Object.keys(window.scheduleAssignments).length,
                        source: result.source
                    });
                }
            }
        });

        console.log('🔗 Date picker hook installed');
    }

    // =========================================================================
    // HOOK: AUTO-SAVE ON SCHEDULE CHANGES
    // =========================================================================

    function hookScheduleSave() {
        if (window.saveCurrentDailyData) {
            const originalSave = window.saveCurrentDailyData;

            window.saveCurrentDailyData = function(key, value) {
                // Call original for local storage
                originalSave.call(this, key, value);

                // Queue cloud save for schedule
                const dateKey = window.currentScheduleDate;
                if (!dateKey) return;

                const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };

                if (window.ScheduleSync?.queueSave) {
                    window.ScheduleSync.queueSave(dateKey, data);
                }
            };

            console.log('🔗 Save hook installed');
        }
    }

    // =========================================================================
    // HOOK: GENERATION COMPLETE
    // =========================================================================

    function hookGeneration() {
        window.addEventListener('campistry-generation-complete', async (e) => {
            const dateKey = e.detail?.dateKey || window.currentScheduleDate;
            if (!dateKey) return;

            console.log('🔗 Generation complete for', dateKey);

            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };

            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
        });

        // Intercept generateSchedule if it exists
        if (window.generateSchedule) {
            const originalGenerate = window.generateSchedule;

            window.generateSchedule = async function(dateKey, ...args) {
                const result = await originalGenerate.call(this, dateKey, ...args);

                window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
                    detail: { dateKey }
                }));

                return result;
            };

            console.log('🔗 Generation hook installed');
        }
    }

    // =========================================================================
    // HOOK: HANDLE REMOTE CHANGES (v6.1 - WITH BYPASS GUARD)
    // =========================================================================

    function hookRemoteChanges() {
        if (!window.ScheduleSync?.onRemoteChange) {
            console.log('🔗 ScheduleSync not ready for remote hooks');
            return;
        }

        window.ScheduleSync.onRemoteChange((change) => {
            // ★★★ v6.1 GUARD: Skip during post-edit/bypass operations ★★★
            if (window._postEditInProgress) {
                console.log('🔗 Skipping remote merge - post-edit in progress');
                return;
            }
            
            console.log('🔗 Remote change received:', change.type, 'from', change.scheduler);

            if (window.ScheduleDB?.loadSchedule && change.dateKey) {
                window.ScheduleDB.loadSchedule(change.dateKey).then(result => {
                    // Double-check guard in case state changed during async load
                    if (window._postEditInProgress) {
                        console.log('🔗 Skipping merge - post-edit started during load');
                        return;
                    }
                    
                    if (result?.success && result.data) {
                        const myAssignments = window.PermissionsDB?.filterToMyDivisions?.(window.scheduleAssignments) || {};
                        const remoteAssignments = result.data.scheduleAssignments || {};

                        window.scheduleAssignments = {
                            ...remoteAssignments,
                            ...myAssignments
                        };

                        window.leagueAssignments = result.data.leagueAssignments || window.leagueAssignments;

                        if (window.updateTable) {
                            window.updateTable();
                        }

                        console.log('🔗 Merged remote changes');
                    }
                });
            }
        });

        console.log('🔗 Remote change hook installed');
    }

    // =========================================================================
    // HOOK: BLOCKED CELL RENDERING
    // =========================================================================

    function hookBlockedCells() {
        if (window.updateTable) {
            const originalUpdate = window.updateTable;

            window.updateTable = function(...args) {
                originalUpdate.apply(this, args);
                applyBlockedCellStyles();
            };

            console.log('🔗 Blocked cell hook installed');
        }
    }

    function applyBlockedCellStyles() {
        if (!window.PermissionsDB?.hasFullAccess || window.PermissionsDB.hasFullAccess()) {
            return;
        }

        const editableBunks = new Set(window.PermissionsDB?.getEditableBunks?.() || []);
        
        document.querySelectorAll('.schedule-cell').forEach(cell => {
            const bunkId = cell.dataset?.bunkId;
            if (bunkId && !editableBunks.has(bunkId)) {
                cell.classList.add('blocked-cell');
                cell.title = 'View only - assigned to another scheduler';
            }
        });
    }

    function addBlockedCellStyles() {
        if (document.getElementById('blocked-cell-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'blocked-cell-styles';
        style.textContent = `
            .blocked-cell {
                opacity: 0.6;
                pointer-events: none;
                background: repeating-linear-gradient(
                    45deg,
                    transparent,
                    transparent 5px,
                    rgba(0,0,0,0.03) 5px,
                    rgba(0,0,0,0.03) 10px
                ) !important;
            }
            .blocked-cell::after {
                content: '🔒';
                position: absolute;
                top: 2px;
                right: 2px;
                font-size: 10px;
                opacity: 0.5;
            }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // HOOK: ERASE FUNCTIONS
    // =========================================================================

    function hookEraseFunctions() {
        // Hook eraseAllSchedules if present
        if (typeof window.eraseAllSchedules === 'function') {
            const original = window.eraseAllSchedules;
            
            window.eraseAllSchedules = async function(dateKey) {
                const hasFullAccess = window.PermissionsDB?.hasFullAccess?.() || false;
                
                if (hasFullAccess) {
                    if (!confirm(`Delete ALL schedules for ${dateKey}?\n\nThis will delete data from all schedulers.`)) {
                        return;
                    }
                    await window.ScheduleDB?.deleteSchedule?.(dateKey);
                } else {
                    if (!confirm(`Delete YOUR schedule for ${dateKey}?\n\nOther schedulers' data will be preserved.`)) {
                        return;
                    }
                    await window.ScheduleDB?.deleteMyScheduleOnly?.(dateKey);
                }

                window.scheduleAssignments = {};
                window.leagueAssignments = {};

                const result = await window.ScheduleDB?.loadSchedule?.(dateKey);
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                }

                if (window.updateTable) {
                    window.updateTable();
                }

                console.log('🔗 Erase complete for', dateKey);
            };

            console.log('🔗 Erase hook installed');
        }
    }

    // =========================================================================
    // INSTALL ALL HOOKS
    // =========================================================================

    function installHooks() {
        addBlockedCellStyles();
        hookDatePicker();
        hookScheduleSave();
        hookGeneration();
        hookRemoteChanges();
        hookBlockedCells();
        hookEraseFunctions();

        // Expose helper functions globally
        window.scheduleCloudSync = function() {
            const dateKey = window.currentScheduleDate;
            if (!dateKey) return;

            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };

            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
        };

        window.forceCloudSync = async function() {
            // Sync both schedules and global settings
            await window.ScheduleSync?.forceSync?.();
            await forceSyncToCloud();
        };

        console.log('🔗 All hooks installed!');

        // Dispatch ready event
        window.dispatchEvent(new CustomEvent('campistry-integration-ready'));

        // Auto-subscribe to current date if one is set
        const currentDate = window.currentScheduleDate || document.getElementById('schedule-date-input')?.value;
        if (currentDate && window.ScheduleSync?.subscribe) {
            console.log('🔗 Auto-subscribing to current date:', currentDate);
            window.ScheduleSync.subscribe(currentDate);
        }
    }

    // =========================================================================
    // START
    // =========================================================================

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForSystems);
    } else {
        setTimeout(waitForSystems, 300);
    }
// =============================================================================
// APPEND THIS TO THE END OF integration_hooks.js (BEFORE the closing })(); )
// =============================================================================
// CLOUD SAVE VERIFICATION PATCH v1.0
// Fixes: Schedule not persisting to cloud on new device
// =============================================================================

    // =========================================================================
    // PATCH: VERIFIED SAVE TO CLOUD WITH RETRY
    // =========================================================================

    const SAVE_MAX_RETRIES = 3;
    const SAVE_RETRY_DELAY = 2000;

    async function verifiedScheduleSave(dateKey, data, attempt = 1) {
        if (!dateKey) dateKey = window.currentScheduleDate;
        if (!data) {
            data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };
        }

        const bunkCount = Object.keys(data.scheduleAssignments || {}).length;
        log(`[VERIFIED SAVE] Attempt ${attempt}/${SAVE_MAX_RETRIES} - ${bunkCount} bunks for ${dateKey}`);

        if (bunkCount === 0) {
            log('[VERIFIED SAVE] No data to save');
            return { success: true, target: 'empty' };
        }

        // Check dependencies
        if (!window.ScheduleDB?.saveSchedule) {
            log('[VERIFIED SAVE] ScheduleDB not ready, waiting...');
            if (attempt < SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, SAVE_RETRY_DELAY));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            logError('[VERIFIED SAVE] ScheduleDB never became available');
            return { success: false, error: 'ScheduleDB not available' };
        }

        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();

        if (!campId || !userId) {
            log('[VERIFIED SAVE] Auth not ready, waiting...');
            if (attempt < SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, SAVE_RETRY_DELAY));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            logError('[VERIFIED SAVE] Auth never became available');
            return { success: false, error: 'Missing authentication' };
        }

        try {
            const result = await window.ScheduleDB.saveSchedule(dateKey, data);
            
            if (result?.success && result?.target === 'cloud') {
                console.log('🔗 ✅ VERIFIED: Schedule saved to cloud successfully');
                return result;
            } else if (result?.target === 'local' || result?.target === 'local-fallback') {
                console.warn('🔗 ⚠️ Schedule saved to LOCAL only, retrying cloud...');
                if (attempt < SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, SAVE_RETRY_DELAY));
                    return verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                return result;
            } else {
                logError('[VERIFIED SAVE] Save failed:', result?.error);
                if (attempt < SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, SAVE_RETRY_DELAY));
                    return verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                return result;
            }
        } catch (e) {
            logError('[VERIFIED SAVE] Exception:', e);
            if (attempt < SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, SAVE_RETRY_DELAY));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // PATCH: FORCE LOAD FROM CLOUD (for new devices)
    // =========================================================================

    async function forceLoadScheduleFromCloud(dateKey) {
        if (!dateKey) dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        log('[CLOUD LOAD] Force loading schedule for:', dateKey);

        if (!window.ScheduleDB?.loadSchedule) {
            log('[CLOUD LOAD] ScheduleDB not available');
            return { success: false, error: 'ScheduleDB not available' };
        }

        try {
            const result = await window.ScheduleDB.loadSchedule(dateKey);
            
            if (result?.success && result.data) {
                const bunkCount = Object.keys(result.data.scheduleAssignments || {}).length;
                log(`[CLOUD LOAD] Loaded ${bunkCount} bunks from ${result.source}`);
                
                // Hydrate window globals
                if (result.data.scheduleAssignments) {
                    window.scheduleAssignments = result.data.scheduleAssignments;
                }
                if (result.data.leagueAssignments) {
                    window.leagueAssignments = result.data.leagueAssignments;
                }
                if (result.data.unifiedTimes?.length > 0) {
                    window.unifiedTimes = result.data.unifiedTimes;
                    window._unifiedTimesFromCloud = true;
                }

                // Update localStorage
                const DAILY_KEY = 'campDailyData_v1';
                try {
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    allData[dateKey] = result.data;
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                } catch (e) { /* ignore localStorage errors */ }

                // Refresh UI
                if (window.updateTable) {
                    window.updateTable();
                }

                console.log('🔗 ✅ Schedule loaded from cloud:', bunkCount, 'bunks');
                return result;
            } else {
                log('[CLOUD LOAD] No cloud data found');
                return { success: true, source: 'empty', data: null };
            }
        } catch (e) {
            logError('[CLOUD LOAD] Exception:', e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // PATCH: OVERRIDE saveGlobalSettings FOR daily_schedules
    // =========================================================================

    const _originalSaveGlobalSettings = window.saveGlobalSettings;
    
    window.saveGlobalSettings = function(key, data) {
        // For daily_schedules, use verified save instead of fire-and-forget
        if (key === 'daily_schedules') {
            const dateKey = Object.keys(data)[0];
            if (dateKey && data[dateKey]) {
                // Use verified save with retry
                verifiedScheduleSave(dateKey, data[dateKey])
                    .then(result => {
                        if (!result?.success || result?.target !== 'cloud') {
                            console.warn('🔗 Schedule save may not have reached cloud');
                        }
                    })
                    .catch(e => logError('Verified schedule save failed:', e));
            }
            return true;
        }
        
        // All other settings use original handler
        return _originalSaveGlobalSettings?.call(this, key, data);
    };

    // =========================================================================
    // PATCH: HOOK GENERATION COMPLETE WITH VERIFIED SAVE
    // =========================================================================

    // Remove old listener and add new one with verified save
    window.addEventListener('campistry-generation-complete', async (e) => {
        const dateKey = e.detail?.dateKey || window.currentScheduleDate;
        if (!dateKey) return;

        console.log('🔗 [PATCHED] Generation complete, initiating verified save...');

        // Wait for data to settle
        await new Promise(r => setTimeout(r, 1000));

        const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };

        // Use verified save
        await verifiedScheduleSave(dateKey, data);
    });

    // =========================================================================
    // PATCH: AUTO-LOAD FROM CLOUD AFTER HYDRATION
    // =========================================================================

    let _scheduleCloudLoadDone = false;

    window.addEventListener('campistry-cloud-hydrated', async () => {
        if (_scheduleCloudLoadDone) return;
        _scheduleCloudLoadDone = true;

        log('[PATCH] Cloud hydrated, checking for schedule data...');

        // Wait for ScheduleDB
        await new Promise(r => setTimeout(r, 500));

        const dateKey = window.currentScheduleDate || 
                       document.getElementById('schedule-date-input')?.value ||
                       document.getElementById('datepicker')?.value;
        
        if (!dateKey) {
            log('[PATCH] No date key available');
            return;
        }

        // Check if we already have data
        const currentBunks = Object.keys(window.scheduleAssignments || {}).length;
        
        if (currentBunks === 0) {
            log('[PATCH] No local data, fetching from cloud...');
            await forceLoadScheduleFromCloud(dateKey);
        } else {
            // Still fetch from cloud to get latest merged data
            log('[PATCH] Local data exists, refreshing from cloud...');
            await forceLoadScheduleFromCloud(dateKey);
        }
    });

    // =========================================================================
    // EXPOSE NEW FUNCTIONS GLOBALLY
    // =========================================================================

    window.verifiedScheduleSave = verifiedScheduleSave;
    window.forceLoadScheduleFromCloud = forceLoadScheduleFromCloud;

    // Diagnostic function
    window.diagnoseScheduleSync = async function() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const campId = window.CampistryDB?.getCampId?.();
        const client = window.CampistryDB?.getClient?.();

        console.log('═══════════════════════════════════════════════════════');
        console.log('SCHEDULE SYNC DIAGNOSTIC');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Camp ID:', campId || 'MISSING');
        console.log('');
        console.log('Window globals:');
        console.log('  scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('  unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('');

        if (client && campId) {
            try {
                const { data, error } = await client
                    .from('daily_schedules')
                    .select('scheduler_id, scheduler_name, divisions, updated_at')
                    .eq('camp_id', campId)
                    .eq('date_key', dateKey);

                console.log('Cloud records:', data?.length || 0);
                if (data && data.length > 0) {
                    data.forEach((r, i) => {
                        console.log(`  [${i + 1}] ${r.scheduler_name || 'Unknown'} - divisions: ${JSON.stringify(r.divisions)}`);
                    });
                } else {
                    console.log('  ⚠️ NO RECORDS IN CLOUD!');
                    console.log('  Run: await verifiedScheduleSave()');
                }
            } catch (e) {
                console.log('Cloud query error:', e.message);
            }
        }
        console.log('═══════════════════════════════════════════════════════');
    };

    console.log('🔗 ✅ Cloud save verification patch installed');
    console.log('   New commands:');
    console.log('   - verifiedScheduleSave()        → Save with retry');
    console.log('   - forceLoadScheduleFromCloud()  → Load from cloud');
    console.log('   - diagnoseScheduleSync()        → Check sync status');

// =============================================================================
// END OF PATCH - Make sure this is BEFORE the closing })(); of integration_hooks.js
// =============================================================================
})();
