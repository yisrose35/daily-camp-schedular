// =============================================================================
// integration_hooks.js v6.0 — CAMPISTRY SCHEDULER INTEGRATION
// =============================================================================
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

    console.log('🔗 Campistry Integration Hooks v6.0 loading...');

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

    function hookDatePicker() {
        const datePicker = document.getElementById('schedule-date-input');
        if (!datePicker) {
            console.log('🔗 Date picker not found, will retry...');
            setTimeout(hookDatePicker, 1000);
            return;
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
    // HOOK: HANDLE REMOTE CHANGES
    // =========================================================================

    function hookRemoteChanges() {
        if (!window.ScheduleSync?.onRemoteChange) {
            console.log('🔗 ScheduleSync not ready for remote hooks');
            return;
        }

        window.ScheduleSync.onRemoteChange((change) => {
            console.log('🔗 Remote change received:', change.type, 'from', change.scheduler);

            if (window.ScheduleDB?.loadSchedule && change.dateKey) {
                window.ScheduleDB.loadSchedule(change.dateKey).then(result => {
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

})();
