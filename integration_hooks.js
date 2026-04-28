// integration_hooks.js — Camp settings sync, schedule save hooks, remote change handling
// Requires: supabase_client.js, supabase_schedules.js, supabase_sync.js

(function() {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const CONFIG = {
        SYNC_DEBOUNCE_MS: 500,
        LOCAL_STORAGE_KEY: 'campGlobalSettings_v1',
        DEBUG: false,
        SAVE_MAX_RETRIES: 3,
        SAVE_RETRY_DELAY_MS: 2000,
        SHOW_NOTIFICATIONS: true
    };

    // =========================================================================
    // STATE
    // =========================================================================
    
    let _pendingChanges = {};
    let _syncTimeout = null;
    let _isSyncing = false;
    let _localCache = null;
    let _lastSyncTime = 0;
    let _datePickerHooked = false;
    let _datePickerRetries = 0;
    let _scheduleCloudLoadDone = false;
    let _remoteChangeDebounce = null;
    
    let _lastSaveKey = null;
    let _lastSaveTime = 0;
    let _saveInProgress = false;
    const SAVE_DEDUP_MS = 3000; // Ignore duplicate saves within 3 seconds

    // Store the TRUE original saveGlobalSettings before ANY patches
    const _trueOriginalSaveGlobalSettings = window.saveGlobalSettings;

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
    // ROLE HELPERS
    // =========================================================================

    function _canWriteCampState() {
        const role = window.AccessControl?.getCurrentRole?.() ||
                     window.CampistryDB?.getRole?.() ||
                     localStorage.getItem('campistry_role') || 
                     'viewer';
        return role === 'owner' || role === 'admin';
    }

    // =========================================================================
    // CLOUDPERMISSIONS — unified permission checking across all systems
    // =========================================================================

    window.CloudPermissions = {
        getRole() {
            return window.AccessControl?.getCurrentRole?.() ||
                   window.CampistryDB?.getRole?.() ||
                   localStorage.getItem('campistry_role') ||
                   'viewer';
        },
        hasFullAccess() { const r = this.getRole(); return r === 'owner' || r === 'admin'; },
        isOwner() { return this.getRole() === 'owner'; },
        isAdmin() { const r = this.getRole(); return r === 'owner' || r === 'admin'; },

        getEditableBunks() {
            const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            if (acDivisions.length > 0) {
                const bunks = [];
                const divisions = window.divisions || {};
                acDivisions.forEach(divName => {
                    const divData = divisions[divName] || divisions[String(divName)];
                    if (divData?.bunks) bunks.push(...divData.bunks);
                });
                return bunks.map(String);
            }
            const permBunks = window.PermissionsDB?.getEditableBunks?.() || [];
            if (permBunks.length > 0) return permBunks.map(String);
            if (this.hasFullAccess()) {
                const allBunks = [];
                Object.values(window.divisions || {}).forEach(div => { if (div.bunks) allBunks.push(...div.bunks); });
                return allBunks.map(String);
            }
            return [];
        },

        getEditableDivisions() {
            if (this.hasFullAccess()) return Object.keys(window.divisions || {});
            const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            if (acDivisions.length > 0) return acDivisions;
            return window.PermissionsDB?.getEditableDivisions?.() || [];
        },

        canEditDivision(divisionName) {
            return this.hasFullAccess() || this.getEditableDivisions().includes(divisionName);
        },

        canEditBunk(bunkName) {
            return this.hasFullAccess() || this.getEditableBunks().includes(String(bunkName));
        },

        getUserInfo() {
            const acInfo = window.AccessControl?.getCurrentUserInfo?.();
            if (acInfo) return acInfo;
            const membership = window._campistryMembership;
            if (membership) return { userId: window.CampistryDB?.getUserId?.(), name: membership.name, email: window.CampistryDB?.getSession?.()?.user?.email };
            const session = window.CampistryDB?.getSession?.();
            if (session?.user) return { userId: session.user.id, email: session.user.email, name: session.user.email?.split('@')[0] || 'Unknown' };
            return null;
        },

        diagnose() {
            console.log('═══════════════════════════════════════════════════════');
            console.log('🔐 CLOUDPERMISSIONS DIAGNOSTIC');
            console.log('═══════════════════════════════════════════════════════');
            console.log('Role:', this.getRole());
            console.log('Has Full Access:', this.hasFullAccess());
            console.log('Is Owner:', this.isOwner());
            console.log('Editable Divisions:', this.getEditableDivisions());
            console.log('Editable Bunks:', this.getEditableBunks().length);
            console.log('User Info:', this.getUserInfo());
            console.log('');
            console.log('Sources:');
            console.log('  AccessControl role:', window.AccessControl?.getCurrentRole?.());
            console.log('  CampistryDB role:', window.CampistryDB?.getRole?.());
            console.log('  localStorage role:', localStorage.getItem('campistry_role'));
            console.log('═══════════════════════════════════════════════════════');
        }
    };
    Object.freeze(window.CloudPermissions);
    Object.defineProperty(window, 'CloudPermissions', {
        value: window.CloudPermissions,
        writable: false,
        configurable: false
    });
    // =========================================================================
    // USER NOTIFICATIONS
    // =========================================================================

    function showNotification(message, type = 'info') {
        if (!CONFIG.SHOW_NOTIFICATIONS) return;

        // Remove any existing notification from this module
        const existing = document.querySelector('.hooks-notification');
        if (existing) existing.remove();

        const colors = {
            success: '#22c55e',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#3b82f6'
        };

        const notification = document.createElement('div');
        notification.className = 'hooks-notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 70px;
            right: 20px;
            background: ${colors[type] || colors.info};
            color: white;
            padding: 10px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 999998;
            animation: hooksSlideIn 0.3s ease;
        `;
        notification.textContent = message;

        if (!document.querySelector('#hooks-notification-styles')) {
            const style = document.createElement('style');
            style.id = 'hooks-notification-styles';
            style.textContent = `
                @keyframes hooksSlideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), type === 'error' ? 5000 : 2500);
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
            // Strip large data from Go before writing to shared settings
            const lite = Object.assign({}, data);
            if (lite.campistryGo) {
                lite.campistryGo = Object.assign({}, lite.campistryGo);
                delete lite.campistryGo.savedRoutes;
                delete lite.campistryGo.addresses; // stored separately in Go's own key
            }
            const json = JSON.stringify(lite);
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, json);
            localStorage.setItem('CAMPISTRY_LOCAL_CACHE', json);

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

    function queueSettingChange(key, value) {
        updateLocalSetting(key, value);
        _pendingChanges[key] = value;
        scheduleBatchSync();
    }

    function scheduleBatchSync() {
        if (_syncTimeout) {
            clearTimeout(_syncTimeout);
        }
        
        _syncTimeout = setTimeout(async () => {
            await executeBatchSync();
        }, CONFIG.SYNC_DEBOUNCE_MS);
    }

    async function executeBatchSync() {
        if (_isSyncing) { scheduleBatchSync(); return; }
        if (Object.keys(_pendingChanges).length === 0) return;
        if (!navigator.onLine) { _pendingChanges = {}; return; }

        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) { _pendingChanges = {}; return; }

        // Schedulers/viewers cannot access camp_state (RLS). Attempting would
        // propagate a 403 through forceSyncToCloud → saveDailySkeleton → generation.
        if (!_canWriteCampState()) {
            _pendingChanges = {};
            _lastSyncTime = Date.now();
            return;
        }

        _isSyncing = true;
        const changesToSync = { ..._pendingChanges };
        _pendingChanges = {};

        try {

            const { data: current, error: fetchError } = await client
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();

            if (fetchError && fetchError.code !== 'PGRST116') {
                logError('Failed to fetch current state:', fetchError);
                throw fetchError;
            }

            const currentState = current?.state || {};
            const newState = { 
                ...currentState, 
                ...changesToSync,
                updated_at: new Date().toISOString()
            };

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

            _lastSelfWriteAt = Date.now();

            if (_settingsBroadcastChannel) {
                _settingsBroadcastChannel.send({
                    type: 'broadcast',
                    event: 'settings-changed',
                    payload: {}
                }).catch(() => {});
            }

            _lastSyncTime = Date.now();
            
            console.log('☁️ Cloud sync complete:', {
                keys: Object.keys(changesToSync),
                divisions: newState.divisions ? Object.keys(newState.divisions).length : 0,
                bunks: newState.bunks?.length || 0
            });

            window.dispatchEvent(new CustomEvent('campistry-settings-synced', {
                detail: { keys: Object.keys(changesToSync) }
            }));

        } catch (e) {
            logError('Batch sync failed:', e);
            Object.assign(_pendingChanges, changesToSync);
            
            window.dispatchEvent(new CustomEvent('campistry-sync-error', {
                detail: { error: e.message, keys: Object.keys(changesToSync) }
            }));
        } finally {
            _isSyncing = false;
        }
    }

    async function forceSyncToCloud() {
        if (_syncTimeout) { clearTimeout(_syncTimeout); _syncTimeout = null; }

        if (!_canWriteCampState()) { _pendingChanges = {}; return true; }

        // Invalidate cache so we re-read what was most recently written to localStorage.
        // Callers like campistry_me.save() write directly before invoking us, leaving
        // _localCache stale — pushing a stale snapshot corrupts subsequent hydrations.
        _localCache = null;

        const localSettings = getLocalSettings();
        const allChanges = { ...localSettings, ..._pendingChanges };
        _pendingChanges = allChanges;

        await executeBatchSync();

        return true;
    }

    // =========================================================================
    // VERIFIED SCHEDULE SAVE (WITH RETRY AND DEDUPLICATION)
    // =========================================================================

    async function verifiedScheduleSave(dateKey, data, attempt = 1) {
        if (!dateKey) dateKey = window.currentScheduleDate;
        if (!data) {
            data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                divisionTimes: window.divisionTimes || {},
                isRainyDay: window.isRainyDay || false,
                rainyDayStartTime: window.rainyDayStartTime ?? null,
                rainyDayMode: window.isRainyDay || false
            };
        }

        const bunkCount = Object.keys(data.scheduleAssignments || {}).length;
        const now = Date.now();
        const saveKey = `${dateKey}:${bunkCount}`;

        if (attempt === 1) {
            if (_saveInProgress) return { success: true, target: 'deduplicated', reason: 'in-progress' };
            if (_lastSaveKey === saveKey && (now - _lastSaveTime) < SAVE_DEDUP_MS) {
                return { success: true, target: 'deduplicated', reason: 'recent-duplicate' };
            }
            _saveInProgress = true;
            _lastSaveKey = saveKey;
            _lastSaveTime = now;
        }

        if (bunkCount === 0) { _saveInProgress = false; return { success: true, target: 'empty' }; }

        if (!navigator.onLine) {
            showNotification('📴 Saved locally (offline)', 'warning');
            _saveInProgress = false;
            if (window.ScheduleSync?.queueSave) window.ScheduleSync.queueSave(dateKey, data);
            return { success: true, target: 'localStorage', offline: true };
        }

        if (!window.ScheduleDB?.saveSchedule) {
            if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            _saveInProgress = false;
            return { success: false, error: 'ScheduleDB not available' };
        }

        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();

        if (!campId || !userId) {
            if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            _saveInProgress = false;
            return { success: false, error: 'Missing authentication' };
        }

        try {
            const result = await window.ScheduleDB.saveSchedule(dateKey, data);

            if (result?.target === 'plan-limit') {
                showNotification(result.error?.message || 'Schedule limit reached. Upgrade for unlimited.', 'warning');
                _saveInProgress = false;
                return result;
            }

            if (result?.success && (result?.target === 'cloud' || result?.target === 'cloud-verified')) {
                showNotification(`Saved ${bunkCount} bunks`, 'success');
                _saveInProgress = false;
                return result;
            } else if (result?.target === 'local' || result?.target === 'local-fallback') {
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                showNotification('Saved locally (offline)', 'warning');
                _saveInProgress = false;
                return result;
            } else {
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                showNotification('Save failed', 'error');
                _saveInProgress = false;
                return result;
            }
        } catch (e) {
            if ((e.message && e.message.includes('Starter plan limit')) || e.code === 'P0001') {
                showNotification('Starter plan limit reached. Upgrade for unlimited access.', 'warning');
                _saveInProgress = false;
                return { success: false, error: e.message, target: 'plan-limit' };
            }
            if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            showNotification('Save error', 'error');
            _saveInProgress = false;
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // FORCE LOAD FROM CLOUD
    // =========================================================================

    async function forceLoadScheduleFromCloud(dateKey) {
        if (!dateKey) dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        if (!window.ScheduleDB?.loadSchedule) return { success: false, error: 'ScheduleDB not available' };

        try {
            const result = await window.ScheduleDB.loadSchedule(dateKey);

            if (result?.success && result.data) {
                if (result.data.scheduleAssignments) window.scheduleAssignments = result.data.scheduleAssignments;
                if (result.data.leagueAssignments) window.leagueAssignments = result.data.leagueAssignments;
                if (result.data.unifiedTimes?.length > 0) window.unifiedTimes = result.data.unifiedTimes;
                if (result.data.divisionTimes) window.divisionTimes = result.data.divisionTimes;

                if (result.data.isRainyDay === true || result.data.rainyDayMode === true) window.isRainyDay = true;
                else if (result.data.isRainyDay === false) window.isRainyDay = false;

                window.rainyDayStartTime = (result.data.rainyDayStartTime != null) ? result.data.rainyDayStartTime : null;

                try {
                    const allData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    allData[dateKey] = result.data;
                    localStorage.setItem('campDailyData_v1', JSON.stringify(allData));
                } catch (e) { /* ignore */ }

                if (window.updateTable) window.updateTable();

                if (window.SchedulerCoreUtils?.hydrateLocalStorageFromCloud) {
                    window.SchedulerCoreUtils.hydrateLocalStorageFromCloud().catch(() => {});
                }
                return result;
            } else {
                return { success: true, source: 'empty', data: null };
            }
        } catch (e) {
            logError('forceLoadScheduleFromCloud exception:', e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // SINGLE AUTHORITATIVE saveGlobalSettings HANDLER
    // =========================================================================

    // When key === 'daily_schedules', callers pass the full campDailyData_v1 object
    // (all dates). Persist the full object to localStorage, cloud-sync the current date
    // with retry, and sync all other dates (propagation changes) without retry.
    window.saveGlobalSettings = function(key, data) {
        if (key === 'daily_schedules') {
            try {
                localStorage.setItem('campDailyData_v1', JSON.stringify(data));
            } catch (e) {
                logError('saveGlobalSettings localStorage write failed:', e);
            }

            const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
            const allDateKeys = Object.keys(data).filter(k =>
                DATE_REGEX.test(k) && data[k] && typeof data[k] === 'object'
            );

            if (allDateKeys.length === 0) return true;

            const currentDate = window.currentScheduleDate ||
                                document.getElementById('schedule-date-input')?.value ||
                                document.getElementById('datepicker')?.value;

            const primaryDateKey = allDateKeys.includes(currentDate)
                ? currentDate
                : allDateKeys.find(k => data[k]?.scheduleAssignments) || allDateKeys[0];

            if (primaryDateKey && data[primaryDateKey]) {
                verifiedScheduleSave(primaryDateKey, data[primaryDateKey])
                    .then(result => { if (!result?.success) console.warn('🔗 Primary schedule save issue:', result?.error); })
                    .catch(e => logError('Primary schedule save failed:', e));
            }

            // Secondary dates: propagation changes (field/activity rename, league future-dates).
            // skipFilter:true because propagation changes affect all bunks, not just this scheduler's.
            const secondaryDateKeys = allDateKeys.filter(k =>
                k !== primaryDateKey && data[k]?.scheduleAssignments &&
                Object.keys(data[k].scheduleAssignments).length > 0
            );

            if (secondaryDateKeys.length > 0 && window.ScheduleDB?.saveSchedule) {
                Promise.all(
                    secondaryDateKeys.map(dk =>
                        window.ScheduleDB.saveSchedule(dk, data[dk], { skipFilter: true })
                            .then(r => { if (!r?.success) console.warn(`🔗 Secondary save failed: ${dk}`, r?.error); })
                            .catch(e => console.warn(`🔗 Secondary save error: ${dk}`, e.message))
                    )
                );
            }

            return true;
        }

        queueSettingChange(key, data);
        return true;
    };

    window.saveGlobalSettings._isAuthoritativeHandler = true;

    window.loadGlobalSettings = function(key) {
        const settings = getLocalSettings();
        
        if (key) {
            return settings[key] ?? settings.app1?.[key] ?? {};
        }
        
        return settings;
    };

    window.forceSyncToCloud = forceSyncToCloud;

    window.setCloudState = async function(newState, force = false) {
        
        setLocalSettings(newState);
        
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

    window.resetCloudState = async function() {
        
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
        
        setLocalSettings(emptyState);
        _pendingChanges = emptyState;
        
        await forceSyncToCloud();
        
        return true;
    };

    window.clearCloudKeys = async function(keys) {
        
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

        if (!client || !campId) return;

        function _hydrateFromLocal() {
            const localState = getLocalSettings();
            if (localState && Object.keys(localState).length > 0) {
                window.divisions = localState.divisions || window.divisions || {};
                window.globalBunks = localState.bunks || window.globalBunks || [];
                window.availableDivisions = Object.keys(window.divisions);
            }
            window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
        }

        try {
            const { data, error } = await client
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();

            if (error) {
                // PGRST116 = no rows; 42501 = RLS denial (expected for scheduler role)
                if (error.code !== 'PGRST116' && error.code !== '42501') {
                    logError('Hydration failed:', error);
                }
                _hydrateFromLocal();
                return;
            }

            if (data?.state) {
                const cloudState = data.state;
                const localState = getLocalSettings();
                const cloudTime = new Date(cloudState.updated_at || 0).getTime();
                const localTime = new Date(localState.updated_at || 0).getTime();

                let mergedState = localTime > cloudTime
                    ? { ...cloudState, ...localState }
                    : cloudState;

                // Deep-merge app1 so local-only keys like builderMode survive cloud sync
                if (localState.app1 || cloudState.app1) {
                    mergedState.app1 = { ...(cloudState.app1 || {}), ...(localState.app1 || {}) };
                }

                setLocalSettings(mergedState);
                window.divisions = mergedState.divisions || {};
                window.globalBunks = mergedState.bunks || [];
                window.availableDivisions = Object.keys(mergedState.divisions || {});

                console.log('☁️ Hydrated from cloud:', {
                    divisions: Object.keys(mergedState.divisions || {}).length,
                    bunks: (mergedState.bunks || []).length
                });

                window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
            }
        } catch (e) {
            logError('Hydration exception:', e);
            _hydrateFromLocal();
        }
    }

    // =========================================================================
    // CAMP_STATE REALTIME SUBSCRIPTION
    // =========================================================================

    let _campStateChannel = null;
    let _lastSelfWriteAt = 0;
    let _campStateDebounceTimer = null;
    let _campStateSubscribed = false;
    let _settingsBroadcastChannel = null;
    let _settingsBroadcastSubscribed = false;

    // All roles subscribe to a broadcast channel so schedulers receive admin setting changes
    // without needing postgres_changes access (which RLS blocks for non-admin roles).
    function _subscribeToSettingsBroadcast(client, campId) {
        if (_settingsBroadcastSubscribed) return;
        _settingsBroadcastSubscribed = true;
        try {
            _settingsBroadcastChannel = client
                .channel(`camp-settings-${campId}`)
                .on('broadcast', { event: 'settings-changed' }, function () {
                    if (_canWriteCampState()) return; // admin already re-hydrates via postgres_changes
                    if (window.CloudPermissions?.loadUserSubdivisionDetails) {
                        window.CloudPermissions.loadUserSubdivisionDetails().catch(e =>
                            console.warn('[integration_hooks] subdivision refresh failed:', e)
                        );
                    }
                })
                .subscribe(function (status) {
                    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        _settingsBroadcastSubscribed = false;
                        _settingsBroadcastChannel = null;
                    }
                });
        } catch (e) {
            console.warn('[integration_hooks] settings broadcast subscribe failed:', e);
            _settingsBroadcastSubscribed = false;
        }
    }

    async function subscribeToCampState() {
        if (_campStateSubscribed) return;
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        if (!client || !campId) return;

        _subscribeToSettingsBroadcast(client, campId);

        // RLS blocks scheduler/viewer from postgres_changes on camp_state
        if (!_canWriteCampState()) return;

        _campStateSubscribed = true;
        try {
            const channelName = `camp-state-${campId}-${Date.now()}`;
            _campStateChannel = client.channel(channelName)
                .on('postgres_changes', {
                    event: '*', schema: 'public', table: 'camp_state', filter: `camp_id=eq.${campId}`
                }, function () {
                    if (Date.now() - _lastSelfWriteAt < 3000) return; // ignore self-echo
                    if (_campStateDebounceTimer) clearTimeout(_campStateDebounceTimer);
                    _campStateDebounceTimer = setTimeout(async function () {
                        _campStateDebounceTimer = null;
                        await hydrateFromCloud();
                    }, 200);
                })
                .subscribe(function (status) {
                    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') _campStateSubscribed = false;
                });
        } catch (e) {
            logError('camp_state subscribe failed:', e);
            _campStateSubscribed = false;
        }
    }

    window.addEventListener('campistry-cloud-hydrated', function () {
        if (!_campStateSubscribed) subscribeToCampState();
    });

    // =========================================================================
    // WAIT FOR ALL SYSTEMS
    // =========================================================================

    async function waitForSystems() {
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        await new Promise(r => setTimeout(r, 200));
        await hydrateFromCloud();
        installHooks();
    }

    // =========================================================================
    // HOOK: DATE PICKER (WITH AUTO-SAVE)
    // =========================================================================

    const MAX_DATE_PICKER_RETRIES = 5;

    function hookDatePicker() {
        if (_datePickerHooked) return;
        
        const datePicker = document.getElementById('schedule-date-input') ||
                          document.getElementById('datepicker') ||
                          document.getElementById('calendar-date-picker');
        
        if (!datePicker) {
            _datePickerRetries++;
            if (_datePickerRetries < MAX_DATE_PICKER_RETRIES) {
                setTimeout(hookDatePicker, 2000);
            } else if (_datePickerRetries === MAX_DATE_PICKER_RETRIES) {
                log('Date picker not found on this page');
            }
            return;
        }
        
        _datePickerHooked = true;

        if (datePicker.value && !window.currentScheduleDate) {
            window.currentScheduleDate = datePicker.value;
        }

        datePicker.addEventListener('change', async (e) => {
            const newDateKey = e.target.value;
            if (!newDateKey) return;

            const oldDateKey = window.currentScheduleDate;

            if (oldDateKey && oldDateKey !== newDateKey) {
                const currentBunks = Object.keys(window.scheduleAssignments || {}).length;
                if (currentBunks > 0) {
                    showNotification('Saving...', 'info');
                    try { await verifiedScheduleSave(oldDateKey); } catch (e) { logError('Auto-save failed:', e); }
                }
            }

            window.currentScheduleDate = newDateKey;

            if (window.ScheduleSync?.subscribe) await window.ScheduleSync.subscribe(newDateKey);

            if (window.ScheduleDB?.loadSchedule) {
                const result = await window.ScheduleDB.loadSchedule(newDateKey);
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                    if (result.data.unifiedTimes?.length > 0) window.unifiedTimes = result.data.unifiedTimes;
                    if (result.data.divisionTimes) window.divisionTimes = result.data.divisionTimes;
                    if (result.data.isRainyDay === true || result.data.rainyDayMode === true) window.isRainyDay = true;
                    else if (result.data.isRainyDay === false) window.isRainyDay = false;
                    window.rainyDayStartTime = (result.data.rainyDayStartTime != null) ? result.data.rainyDayStartTime : null;
                    if (window.updateTable) window.updateTable();
                }
            }
        });
    }

    // =========================================================================
    // HOOK: AUTO-SAVE ON SCHEDULE CHANGES
    // =========================================================================

    function hookScheduleSave() {
        if (window.saveCurrentDailyData) {
            const originalSave = window.saveCurrentDailyData;
            window.saveCurrentDailyData = function(key, value) {
                originalSave.call(this, key, value);
                const dateKey = window.currentScheduleDate;
                if (!dateKey) return;
                const data = {
                    scheduleAssignments: window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.divisionTimes || {},
                    isRainyDay: window.isRainyDay || false,
                    rainyDayStartTime: window.rainyDayStartTime ?? null,
                    rainyDayMode: window.isRainyDay || false
                };
                if (window.ScheduleSync?.queueSave) window.ScheduleSync.queueSave(dateKey, data);
            };
        }
    }

    // =========================================================================
    // HOOK: GENERATION COMPLETE
    // =========================================================================

    function hookGeneration() {
        window.addEventListener('campistry-generation-complete', async (e) => {
            const dateKey = e.detail?.dateKey || window.currentScheduleDate;
            if (!dateKey) return;

            // Capture pre-generation schedule so reIncrementHistoricalCounts can subtract old counts correctly.
            let oldScheduleSnapshot = null;
            try {
                const preSave = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                oldScheduleSnapshot = preSave[dateKey]?.scheduleAssignments || null;
            } catch (_) {}

            // Merge into existing localStorage entry to preserve auto-mode keys
            // (_perBunkSlotsData, _autoGenerated, manualSkeleton) written by the auto-builder.
            try {
                const allData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                const existing = allData[dateKey] || {};
                Object.assign(existing, {
                    scheduleAssignments: window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes || {},
                    isRainyDay: window.isRainyDay || false,
                    rainyDayStartTime: window.rainyDayStartTime ?? null,
                    _savedAt: Date.now()
                });
                allData[dateKey] = existing;
                localStorage.setItem('campDailyData_v1', JSON.stringify(allData));
            } catch (lsErr) {
                console.error('🔗 localStorage save failed:', lsErr);
            }

            await verifiedScheduleSave(dateKey);

            // Stamp rotation history so next-day variety scoring knows what ran today
            try {
                const newSched = window.scheduleAssignments || {};
                const history = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
                history.bunks = history.bunks || {};
                const timestamp = Date.now();
                const SKIP = new Set(['free', 'free play', 'free (timeout)', 'transition/buffer', 'regroup', 'lineup', 'bus', 'buffer']);
                Object.keys(newSched).forEach(bunk => {
                    history.bunks[bunk] = history.bunks[bunk] || {};
                    (newSched[bunk] || []).forEach(entry => {
                        if (!entry || entry.continuation || entry._isTransition) return;
                        const actName = entry._activity || '';
                        if (!actName || SKIP.has(actName.toLowerCase())) return;
                        history.bunks[bunk][actName] = timestamp;
                    });
                });
                window.saveRotationHistory?.(history);
            } catch (rhErr) {
                console.error('🔗 Rotation history update failed:', rhErr);
            }

            if (window.SchedulerCoreUtils?.reIncrementHistoricalCounts) {
                window.SchedulerCoreUtils.reIncrementHistoricalCounts(dateKey, window.scheduleAssignments || {}, true, oldScheduleSnapshot);
            } else if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
            }
        }, { once: false });

        if (window.generateSchedule) {
            const originalGenerate = window.generateSchedule;
            window.generateSchedule = async function(dateKey, ...args) {
                if (window.AccessControl?.verifyBeforeWrite) {
                    const allowed = await window.AccessControl.verifyBeforeWrite('generate schedule');
                    if (!allowed) { console.warn('🔗 Generation BLOCKED — write permission denied'); return null; }
                }
                const result = await originalGenerate.call(this, dateKey, ...args);
                window.dispatchEvent(new CustomEvent('campistry-generation-complete', { detail: { dateKey } }));
                return result;
            };
        }
    }

    // =========================================================================
    // HOOK: HANDLE REMOTE CHANGES
    // =========================================================================

    function hookRemoteChanges() {
        if (!window.ScheduleSync?.onRemoteChange) return;

        window.ScheduleSync.onRemoteChange((change) => {
            if (window._postEditInProgress || window._generationInProgress) return;

            if (_remoteChangeDebounce) clearTimeout(_remoteChangeDebounce);
            _remoteChangeDebounce = setTimeout(() => {
                _remoteChangeDebounce = null;
                _processRemoteChange(change);
            }, 400);
        });
    }

    function _processRemoteChange(change) {
        const viewingDate = window.currentScheduleDate ||
            document.getElementById('schedule-date-input')?.value ||
            document.getElementById('calendar-date-picker')?.value;
        if (change.dateKey && viewingDate && change.dateKey !== viewingDate) return;

        if (!window.ScheduleDB?.loadSchedule || !change.dateKey) return;

        window.ScheduleDB.loadSchedule(change.dateKey).then(result => {
            if (window._postEditInProgress || window._generationInProgress) return;
            if (!result?.success || !result.data) return;

            const myBunks = new Set(
                window.AccessControl?.getEditableBunks?.() ||
                window.CloudPermissions?.getEditableBunks?.() || []
            );

            const cloudAssignments = result.data.scheduleAssignments || {};
            const currentAssignments = window.scheduleAssignments || {};

            // Start with cloud (all schedulers merged), overlay MY current work to preserve it
            const merged = { ...cloudAssignments };
            for (const [bunk, slots] of Object.entries(currentAssignments)) {
                if (myBunks.has(bunk) || myBunks.has(String(bunk))) merged[bunk] = slots;
            }
            window.scheduleAssignments = merged;

            // League assignments keyed by division name — same merge pattern
            if (result.data.leagueAssignments) {
                const myDivisions = new Set(window.AccessControl?.getEditableDivisions?.() || []);
                const mergedLeagues = { ...result.data.leagueAssignments };
                for (const [divName, divData] of Object.entries(window.leagueAssignments || {})) {
                    if (myDivisions.has(divName)) mergedLeagues[divName] = divData;
                }
                window.leagueAssignments = mergedLeagues;
            }

            if (result.data.unifiedTimes?.length > (window.unifiedTimes?.length || 0)) {
                window.unifiedTimes = result.data.unifiedTimes;
            }
            if (result.data.divisionTimes) {
                const localGenTime = window._localGenerationTimestamp || 0;
                if (Date.now() - localGenTime > 60000) window.divisionTimes = result.data.divisionTimes;
            }

            if (result.data.isRainyDay === true || result.data.rainyDayMode === true) window.isRainyDay = true;
            else if (result.data.isRainyDay === false) window.isRainyDay = false;
            if (result.data.rainyDayStartTime != null) window.rainyDayStartTime = result.data.rainyDayStartTime;

            try {
                const allData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                allData[change.dateKey] = {
                    scheduleAssignments: merged,
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.divisionTimes || {}
                };
                localStorage.setItem('campDailyData_v1', JSON.stringify(allData));
            } catch (e) { /* ignore */ }

            // Warn if another user edited a bunk I'm currently working on
            const conflictBunks = [];
            for (const bunk of myBunks) {
                if (cloudAssignments[bunk] && currentAssignments[bunk] &&
                    JSON.stringify(cloudAssignments[bunk]) !== JSON.stringify(currentAssignments[bunk])) {
                    conflictBunks.push(bunk);
                }
            }
            if (conflictBunks.length > 0 && window.showToast) {
                const names = conflictBunks.slice(0, 3).join(', ') + (conflictBunks.length > 3 ? '…' : '');
                window.showToast(`Another user also edited ${names} — your version was kept.`, 'warning');
            }

            if (window.updateTable) window.updateTable();
        });
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
        }
    }

    function applyBlockedCellStyles() {
        if (window.CloudPermissions?.hasFullAccess?.()) {
            return;
        }

        const editableBunks = new Set(window.CloudPermissions?.getEditableBunks?.() || []);
        
        document.querySelectorAll('.schedule-cell').forEach(cell => {
            const bunkId = cell.dataset?.bunkId;
            if (bunkId && !editableBunks.has(String(bunkId))) {
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
        if (typeof window.eraseAllSchedules === 'function') {
            const original = window.eraseAllSchedules;
            
           window.eraseAllSchedules = async function(dateKey) {
                if (window.AccessControl?.verifyBeforeWrite) {
                    const allowed = await window.AccessControl.verifyBeforeWrite('erase schedules');
                    if (!allowed) { console.warn('🔗 Erase BLOCKED — write permission denied'); return; }
                }

                const hasFullAccess = window.CloudPermissions?.hasFullAccess?.() || false;
                
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

                if (window.updateTable) window.updateTable();
            };
        }
    }

    // =========================================================================
    // HOOK: BEFOREUNLOAD - SAVE ON PAGE EXIT
    // =========================================================================

    function hookBeforeUnload() {
        window.addEventListener('beforeunload', () => {
            const dateKey = window.currentScheduleDate;
            const bunkCount = Object.keys(window.scheduleAssignments || {}).length;
            if (!dateKey || bunkCount === 0) return;

            const payload = {
                scheduleAssignments: window.scheduleAssignments,
                leagueAssignments: window.leagueAssignments,
                unifiedTimes: window.unifiedTimes,
                divisionTimes: window.divisionTimes,
                isRainyDay: window.isRainyDay || false,
                rainyDayStartTime: window.rainyDayStartTime ?? null,
                rainyDayMode: window.isRainyDay || false,
                savedAt: new Date().toISOString()
            };

            try {
                const allData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                allData[dateKey] = payload;
                localStorage.setItem('campDailyData_v1', JSON.stringify(allData));
            } catch (err) { logError('Final save failed:', err); }

            window.ScheduleDB?.saveSchedule?.(dateKey, payload).catch(() => {});
        });
    }

    // =========================================================================
    // HOOK: AUTO-LOAD FROM CLOUD AFTER HYDRATION
    // =========================================================================

    function hookCloudHydration() {
        window.addEventListener('campistry-cloud-hydrated', async () => {
            if (_scheduleCloudLoadDone) return;
            _scheduleCloudLoadDone = true;

            await new Promise(r => setTimeout(r, 500));

            const dateKey = window.currentScheduleDate ||
                           document.getElementById('schedule-date-input')?.value ||
                           document.getElementById('datepicker')?.value ||
                           document.getElementById('calendar-date-picker')?.value;

            if (!dateKey) return;
            await forceLoadScheduleFromCloud(dateKey);
        });
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
        hookBeforeUnload();
        hookCloudHydration();

        window.addEventListener('campistry-sync-error', () => {
            if (typeof window.showToast === 'function') {
                window.showToast('Cloud save failed — your changes are queued and will retry. Check your connection.', 'error');
            }
        });

        // Flush settings saved while offline once reconnected
        window.addEventListener('online', () => {
            setTimeout(() => {
                forceSyncToCloud().catch(e => console.warn('[integration_hooks] Reconnect sync failed:', e));
            }, 1500);
        });

        window.scheduleCloudSync = function() {
            const dateKey = window.currentScheduleDate;
            if (!dateKey) return;
            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                divisionTimes: window.divisionTimes || {},
                isRainyDay: window.isRainyDay || false,
                rainyDayStartTime: window.rainyDayStartTime ?? null,
                rainyDayMode: window.isRainyDay || false
            };
            if (window.ScheduleSync?.queueSave) window.ScheduleSync.queueSave(dateKey, data);
        };

        window.forceCloudSync = async function() {
            await window.ScheduleSync?.forceSync?.();
            await forceSyncToCloud();
        };

        window.verifiedScheduleSave = verifiedScheduleSave;
        window.forceLoadScheduleFromCloud = forceLoadScheduleFromCloud;

        window.dispatchEvent(new CustomEvent('campistry-integration-ready'));

        const currentDate = window.currentScheduleDate || document.getElementById('schedule-date-input')?.value || document.getElementById('calendar-date-picker')?.value;
        if (currentDate && window.ScheduleSync?.subscribe) window.ScheduleSync.subscribe(currentDate);
    }

    // =========================================================================
    // DIAGNOSTIC FUNCTION
    // =========================================================================

    window.diagnoseScheduleSync = async function() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();
        const client = window.CampistryDB?.getClient?.();

        console.log('═══════════════════════════════════════════════════════');
        console.log('SCHEDULE SYNC DIAGNOSTIC');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Online:', navigator.onLine);
        console.log('Camp ID:', campId || 'MISSING');
        console.log('User ID:', userId?.substring(0, 8) + '...' || 'MISSING');
        console.log('Can write camp_state:', _canWriteCampState());
        console.log('');
        console.log('Window globals:');
        console.log('  scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('  unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('  divisionTimes:', Object.keys(window.divisionTimes || {}).length, 'divisions');
        console.log('  isRainyDay:', window.isRainyDay);
        console.log('  rainyDayStartTime:', window.rainyDayStartTime);
        console.log('');
        console.log('CloudPermissions:');
        console.log('  Role:', window.CloudPermissions?.getRole?.());
        console.log('  Has Full Access:', window.CloudPermissions?.hasFullAccess?.());
        console.log('  Editable Divisions:', window.CloudPermissions?.getEditableDivisions?.()?.length || 0);
        console.log('  Editable Bunks:', window.CloudPermissions?.getEditableBunks?.()?.length || 0);
        console.log('');

        if (client && campId) {
            try {
                const { data, error } = await client
                    .from('daily_schedules')
                    .select('scheduler_id, scheduler_name, divisions, updated_at, schedule_data, unified_times, is_rainy_day')
                    .eq('camp_id', campId)
                    .eq('date_key', dateKey);

                console.log('Cloud records:', data?.length || 0);
                if (data && data.length > 0) {
                    let totalCloudBunks = 0;
                    data.forEach((r, i) => {
                        const bunks = Object.keys(r.schedule_data?.scheduleAssignments || {}).length;
                        const slots = r.schedule_data?.unifiedTimes?.length || r.unified_times?.length || 0;
                        const isRainy = r.is_rainy_day || r.schedule_data?.isRainyDay || r.schedule_data?.rainyDayMode;
                        const rainyStart = r.schedule_data?.rainyDayStartTime;
                        totalCloudBunks += bunks;
                        const isMe = r.scheduler_id === userId ? ' ★YOU★' : '';
                        console.log(`  [${i + 1}] ${r.scheduler_name || 'Unknown'}${isMe}`);
                        console.log(`      Divisions: ${JSON.stringify(r.divisions)}`);
                        console.log(`      Bunks: ${bunks}, Slots: ${slots}`);
                        console.log(`      Rainy: ${isRainy}, StartTime: ${rainyStart}`);
                        console.log(`      Updated: ${r.updated_at}`);
                    });
                    console.log('');
                    console.log('Total cloud bunks:', totalCloudBunks);
                } else {
                    console.log('  ⚠️ NO RECORDS IN CLOUD!');
                    console.log('  Run: await verifiedScheduleSave()');
                }
            } catch (e) {
                console.log('Cloud query error:', e.message);
            }
        }
        console.log('');
        console.log('Quick Actions:');
        console.log('  await verifiedScheduleSave()        // Save with retry');
        console.log('  await forceLoadScheduleFromCloud()  // Load from cloud');
        console.log('  CloudPermissions.diagnose()         // Check permissions');
        console.log('═══════════════════════════════════════════════════════');
    };

    // =========================================================================
    // START
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForSystems);
    } else {
        setTimeout(waitForSystems, 300);
    }

    console.log('🔗 [integration_hooks] loaded');

})();
