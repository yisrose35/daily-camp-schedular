// =============================================================================
// integration_hooks.js v6.3 — CAMPISTRY SCHEDULER INTEGRATION
// =============================================================================
//
// v6.3 FIXES:
// - ★ NEW: CloudPermissions unified permission helper
// - ★ IMPROVED: Better network awareness in save operations
// - ★ IMPROVED: unifiedTimes hydration from cloud
//
// v6.2 FIXES:
// - ★ FIXED DUPLICATE saveGlobalSettings - single authoritative handler
// - ★ AUTO-SAVE BEFORE DATE CHANGE - prevents data loss when switching dates
// - ★ BEFOREUNLOAD HANDLER - saves on page exit
// - ★ SAVE VERIFICATION - confirms cloud writes with retry
// - ★ USER NOTIFICATIONS - shows save status to user
// - ★ CONSOLIDATED PATCHES - removed competing save handlers
//
// v6.1 FIXES:
// - ★ BYPASS SAVE GUARD - Skips remote merge during _postEditInProgress
//
// v6.0 FIXES:
// - ★ BATCHED GLOBAL SETTINGS SYNC - Multiple calls are batched into one cloud write
// - ★ ALL DATA TYPES sync to camp_state (divisions, bunks, activities, fields, etc.)
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔗 Campistry Integration Hooks v6.3 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const CONFIG = {
        SYNC_DEBOUNCE_MS: 500,
        LOCAL_STORAGE_KEY: 'campGlobalSettings_v1',
        DEBUG: true,
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
    // ★★★ NEW: UNIFIED CLOUDPERMISSIONS HELPER ★★★
    // =========================================================================
    
    /**
     * CloudPermissions - Unified permission checking across all systems.
     * Provides consistent role and permission access regardless of which
     * permission system is initialized.
     */
    window.CloudPermissions = {
        /**
         * Get current user's role with priority chain.
         */
        getRole() {
            // Priority: AccessControl > CampistryDB > localStorage
            return window.AccessControl?.getCurrentRole?.() ||
                   window.CampistryDB?.getRole?.() ||
                   localStorage.getItem('campistry_role') || 
                   'viewer';
        },
        
        /**
         * Check if user has owner or admin access.
         */
        hasFullAccess() {
            const role = this.getRole();
            return role === 'owner' || role === 'admin';
        },
        
        /**
         * Check if user is the camp owner.
         */
        isOwner() {
            return this.getRole() === 'owner';
        },
        
        /**
         * Check if user is an admin (includes owner).
         */
        isAdmin() {
            const role = this.getRole();
            return role === 'owner' || role === 'admin';
        },
        
        /**
         * Get editable bunks with proper fallback chain.
         */
        getEditableBunks() {
            // Priority: AccessControl > PermissionsDB > compute from divisions
            const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            if (acDivisions.length > 0) {
                const bunks = [];
                const divisions = window.divisions || {};
                acDivisions.forEach(divName => {
                    const divData = divisions[divName] || divisions[String(divName)];
                    if (divData?.bunks) {
                        bunks.push(...divData.bunks);
                    }
                });
                return bunks.map(String);
            }
            
            // Fallback to PermissionsDB
            const permBunks = window.PermissionsDB?.getEditableBunks?.() || [];
            if (permBunks.length > 0) {
                return permBunks.map(String);
            }
            
            // Full access fallback
            if (this.hasFullAccess()) {
                const allBunks = [];
                const divisions = window.divisions || {};
                Object.values(divisions).forEach(div => {
                    if (div.bunks) allBunks.push(...div.bunks);
                });
                return allBunks.map(String);
            }
            
            return [];
        },
        
        /**
         * Get editable divisions with proper fallback chain.
         */
        getEditableDivisions() {
            // Full access gets everything
            if (this.hasFullAccess()) {
                return Object.keys(window.divisions || {});
            }
            
            // Priority: AccessControl > PermissionsDB
            const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            if (acDivisions.length > 0) {
                return acDivisions;
            }
            
            return window.PermissionsDB?.getEditableDivisions?.() || [];
        },
        
        /**
         * Check if user can edit a specific division.
         */
        canEditDivision(divisionName) {
            if (this.hasFullAccess()) return true;
            return this.getEditableDivisions().includes(divisionName);
        },
        
        /**
         * Check if user can edit a specific bunk.
         */
        canEditBunk(bunkName) {
            if (this.hasFullAccess()) return true;
            return this.getEditableBunks().includes(String(bunkName));
        },
        
        /**
         * Get current user info with fallback chain.
         */
        getUserInfo() {
            // Priority: AccessControl > CampistryDB > membership
            const acInfo = window.AccessControl?.getCurrentUserInfo?.();
            if (acInfo) return acInfo;
            
            const membership = window._campistryMembership;
            if (membership) {
                return {
                    userId: window.CampistryDB?.getUserId?.(),
                    name: membership.name,
                    email: window.CampistryDB?.getSession?.()?.user?.email
                };
            }
            
            const session = window.CampistryDB?.getSession?.();
            if (session?.user) {
                return {
                    userId: session.user.id,
                    email: session.user.email,
                    name: session.user.email?.split('@')[0] || 'Unknown'
                };
            }
            
            return null;
        },
        
        /**
         * Diagnostic function.
         */
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
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
            
            // Update legacy keys for backward compatibility
            localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(data));
            
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
        
        log(`Queued change: ${key}`, typeof value === 'object' ? 
            (Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`) : 
            value);
        
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
        if (_isSyncing) {
            log('Sync already in progress, rescheduling...');
            scheduleBatchSync();
            return;
        }
        
        if (Object.keys(_pendingChanges).length === 0) {
            log('No pending changes to sync');
            return;
        }

        // ★★★ NEW: Check if online before attempting cloud sync ★★★
        if (!navigator.onLine) {
            log('Offline - changes saved locally only');
            _pendingChanges = {};
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
        log('Force sync requested');
        
        if (_syncTimeout) {
            clearTimeout(_syncTimeout);
            _syncTimeout = null;
        }

        const localSettings = getLocalSettings();
        const allChanges = { ...localSettings, ..._pendingChanges };
        _pendingChanges = allChanges;
        
        await executeBatchSync();
        
        return true;
    }

    // =========================================================================
    // VERIFIED SCHEDULE SAVE (WITH RETRY)
    // =========================================================================

    async function verifiedScheduleSave(dateKey, data, attempt = 1) {
        if (!dateKey) dateKey = window.currentScheduleDate;
        if (!data) {
            data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                divisionTimes: window.divisionTimes || {},
                isRainyDay: window.isRainyDay || false
            };
        }

        const bunkCount = Object.keys(data.scheduleAssignments || {}).length;
        log(`[VERIFIED SAVE] Attempt ${attempt}/${CONFIG.SAVE_MAX_RETRIES} - ${bunkCount} bunks for ${dateKey}`);

        if (bunkCount === 0) {
            log('[VERIFIED SAVE] No data to save');
            return { success: true, target: 'empty' };
        }

        // ★★★ NEW: Check if online ★★★
        if (!navigator.onLine) {
            log('[VERIFIED SAVE] Offline - saved to localStorage only');
            showNotification('📴 Saved locally (offline)', 'warning');
            
            // Queue for later via ScheduleSync if available
            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
            
            return { success: true, target: 'localStorage', offline: true };
        }

        if (!window.ScheduleDB?.saveSchedule) {
            log('[VERIFIED SAVE] ScheduleDB not ready, waiting...');
            if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            logError('[VERIFIED SAVE] ScheduleDB never became available');
            return { success: false, error: 'ScheduleDB not available' };
        }

        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();

        if (!campId || !userId) {
            log('[VERIFIED SAVE] Auth not ready, waiting...');
            if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            logError('[VERIFIED SAVE] Auth never became available');
            return { success: false, error: 'Missing authentication' };
        }

        try {
            const result = await window.ScheduleDB.saveSchedule(dateKey, data);
            
            if (result?.success && (result?.target === 'cloud' || result?.target === 'cloud-verified')) {
                console.log('🔗 ✅ Schedule saved to cloud:', bunkCount, 'bunks');
                showNotification(`Saved ${bunkCount} bunks`, 'success');
                return result;
            } else if (result?.target === 'local' || result?.target === 'local-fallback') {
                console.warn('🔗 ⚠️ Schedule saved to LOCAL only, retrying cloud...');
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                showNotification('Saved locally (offline)', 'warning');
                return result;
            } else {
                logError('[VERIFIED SAVE] Save failed:', result?.error);
                if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return verifiedScheduleSave(dateKey, data, attempt + 1);
                }
                showNotification('Save failed', 'error');
                return result;
            }
        } catch (e) {
            logError('[VERIFIED SAVE] Exception:', e);
            if (attempt < CONFIG.SAVE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return verifiedScheduleSave(dateKey, data, attempt + 1);
            }
            showNotification('Save error', 'error');
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // FORCE LOAD FROM CLOUD
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
                
                // ★★★ FIX: Properly hydrate unifiedTimes ★★★
                if (result.data.unifiedTimes?.length > 0) {
                    window.unifiedTimes = result.data.unifiedTimes;
                    log('[CLOUD LOAD] Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
                }
                
                if (result.data.divisionTimes) {
                    window.divisionTimes = result.data.divisionTimes;
                }

                // Update localStorage
                const DAILY_KEY = 'campDailyData_v1';
                try {
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    allData[dateKey] = result.data;
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                } catch (e) { /* ignore */ }

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
    // SINGLE AUTHORITATIVE saveGlobalSettings HANDLER
    // =========================================================================

    /**
     * ★★★ SINGLE AUTHORITATIVE HANDLER ★★★
     * This replaces all other patches. Do NOT patch this function elsewhere.
     */
    window.saveGlobalSettings = function(key, data) {
        // For daily_schedules, use verified save with retry
        if (key === 'daily_schedules') {
            const dateKey = Object.keys(data)[0];
            if (dateKey && data[dateKey]) {
                // Use verified save (async, but return sync for compatibility)
                verifiedScheduleSave(dateKey, data[dateKey])
                    .then(result => {
                        if (!result?.success) {
                            console.warn('🔗 Schedule save issue:', result?.error);
                        }
                    })
                    .catch(e => logError('Schedule save failed:', e));
            }
            return true;
        }
        
        // All other settings go through batched sync
        queueSettingChange(key, data);
        
        return true;
    };

    // Mark as the authoritative handler so other code doesn't re-patch
    window.saveGlobalSettings._isAuthoritativeHandler = true;

    /**
     * loadGlobalSettings - Load settings (from cache or cloud)
     */
    window.loadGlobalSettings = function(key) {
        const settings = getLocalSettings();
        
        if (key) {
            return settings[key] ?? settings.app1?.[key] ?? {};
        }
        
        return settings;
    };

    window.forceSyncToCloud = forceSyncToCloud;

    window.setCloudState = async function(newState, force = false) {
        log('setCloudState called', force ? '(forced)' : '');
        
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
        
        setLocalSettings(emptyState);
        _pendingChanges = emptyState;
        
        await forceSyncToCloud();
        
        return true;
    };

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
                
                const cloudTime = new Date(cloudState.updated_at || 0).getTime();
                const localTime = new Date(localState.updated_at || 0).getTime();
                
                let mergedState;
                if (localTime > cloudTime) {
                    mergedState = { ...cloudState, ...localState };
                    log('Using local state (newer)');
                } else {
                    mergedState = cloudState;
                    log('Using cloud state (newer)');
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
        }
    }

    // =========================================================================
    // WAIT FOR ALL SYSTEMS
    // =========================================================================

    async function waitForSystems() {
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        await new Promise(r => setTimeout(r, 200));
        await hydrateFromCloud();

        console.log('🔗 All systems ready, installing hooks...');
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
        log('Date picker found, hooking...');
        
        if (datePicker.value && !window.currentScheduleDate) {
            window.currentScheduleDate = datePicker.value;
            log('Initial date set:', datePicker.value);
        }

        datePicker.addEventListener('change', async (e) => {
            const newDateKey = e.target.value;
            if (!newDateKey) return;

            const oldDateKey = window.currentScheduleDate;
            console.log('🔗 Date changed:', oldDateKey, '→', newDateKey);

            // ═══════════════════════════════════════════════════════════════
            // ★★★ AUTO-SAVE BEFORE DATE CHANGE ★★★
            // ═══════════════════════════════════════════════════════════════
            if (oldDateKey && oldDateKey !== newDateKey) {
                const currentBunks = Object.keys(window.scheduleAssignments || {}).length;
                if (currentBunks > 0) {
                    console.log('🔗 Auto-saving before date change:', currentBunks, 'bunks');
                    showNotification('Saving...', 'info');
                    try {
                        await verifiedScheduleSave(oldDateKey);
                    } catch (e) {
                        logError('Auto-save failed:', e);
                    }
                }
            }

            window.currentScheduleDate = newDateKey;

            // Subscribe to realtime for this date
            if (window.ScheduleSync?.subscribe) {
                await window.ScheduleSync.subscribe(newDateKey);
            }

            // Load schedule for this date
            if (window.ScheduleDB?.loadSchedule) {
                const result = await window.ScheduleDB.loadSchedule(newDateKey);
                
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                    
                    // ★★★ FIX: Properly hydrate unifiedTimes ★★★
                    if (result.data.unifiedTimes?.length > 0) {
                        window.unifiedTimes = result.data.unifiedTimes;
                    }
                    if (result.data.divisionTimes) {
                        window.divisionTimes = result.data.divisionTimes;
                    }

                    if (window.updateTable) {
                        window.updateTable();
                    }

                    console.log('🔗 Loaded schedule for', newDateKey, {
                        bunks: Object.keys(window.scheduleAssignments).length,
                        slots: window.unifiedTimes?.length || 0,
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
                originalSave.call(this, key, value);

                const dateKey = window.currentScheduleDate;
                if (!dateKey) return;

                const data = {
                    scheduleAssignments: window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    divisionTimes: window.divisionTimes || {},
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
        // Single handler for generation complete
        window.addEventListener('campistry-generation-complete', async (e) => {
            const dateKey = e.detail?.dateKey || window.currentScheduleDate;
            if (!dateKey) return;

            console.log('🔗 Generation complete for', dateKey);

            // Wait for data to settle
            await new Promise(r => setTimeout(r, 1000));

            // Use verified save
            await verifiedScheduleSave(dateKey);
            
            // Rebuild counts if available
            if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
            }
        }, { once: false });

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
            // Skip during post-edit/bypass operations
            if (window._postEditInProgress) {
                console.log('🔗 Skipping remote merge - post-edit in progress');
                return;
            }
            
            console.log('🔗 Remote change received:', change.type, 'from', change.scheduler);

            if (window.ScheduleDB?.loadSchedule && change.dateKey) {
                window.ScheduleDB.loadSchedule(change.dateKey).then(result => {
                    if (window._postEditInProgress) {
                        console.log('🔗 Skipping merge - post-edit started during load');
                        return;
                    }
                    
                    if (result?.success && result.data) {
                        // Use CloudPermissions for filtering
                        const myBunks = new Set(window.CloudPermissions?.getEditableBunks?.() || []);
                        const myAssignments = {};
                        
                        // Keep my current assignments
                        Object.entries(window.scheduleAssignments || {}).forEach(([bunk, data]) => {
                            if (myBunks.has(String(bunk))) {
                                myAssignments[bunk] = data;
                            }
                        });
                        
                        const remoteAssignments = result.data.scheduleAssignments || {};

                        window.scheduleAssignments = {
                            ...remoteAssignments,
                            ...myAssignments
                        };

                        window.leagueAssignments = result.data.leagueAssignments || window.leagueAssignments;
                        
                        // ★★★ FIX: Also update unifiedTimes from remote ★★★
                        if (result.data.unifiedTimes?.length > (window.unifiedTimes?.length || 0)) {
                            window.unifiedTimes = result.data.unifiedTimes;
                        }

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
        // Use CloudPermissions for consistent permission checking
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
                // Use CloudPermissions for consistent permission checking
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

                if (window.updateTable) {
                    window.updateTable();
                }

                console.log('🔗 Erase complete for', dateKey);
            };

            console.log('🔗 Erase hook installed');
        }
    }

    // =========================================================================
    // HOOK: BEFOREUNLOAD - SAVE ON PAGE EXIT
    // =========================================================================

    function hookBeforeUnload() {
        window.addEventListener('beforeunload', (e) => {
            const dateKey = window.currentScheduleDate;
            const bunkCount = Object.keys(window.scheduleAssignments || {}).length;

            if (dateKey && bunkCount > 0) {
                console.log('🔗 Page unloading, final save...');
                
                // Synchronous localStorage save (guaranteed)
                try {
                    const DAILY_KEY = 'campDailyData_v1';
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    allData[dateKey] = {
                        scheduleAssignments: window.scheduleAssignments,
                        leagueAssignments: window.leagueAssignments,
                        unifiedTimes: window.unifiedTimes,
                        divisionTimes: window.divisionTimes,
                        savedAt: new Date().toISOString()
                    };
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                } catch (err) {
                    logError('Final save failed:', err);
                }
                
                // Attempt cloud save (may not complete)
                window.ScheduleDB?.saveSchedule?.(dateKey, {
                    scheduleAssignments: window.scheduleAssignments,
                    leagueAssignments: window.leagueAssignments,
                    unifiedTimes: window.unifiedTimes,
                    divisionTimes: window.divisionTimes
                }).catch(() => {});
            }
        });

        console.log('🔗 beforeunload hook installed');
    }

    // =========================================================================
    // HOOK: AUTO-LOAD FROM CLOUD AFTER HYDRATION
    // =========================================================================

    function hookCloudHydration() {
        window.addEventListener('campistry-cloud-hydrated', async () => {
            if (_scheduleCloudLoadDone) return;
            _scheduleCloudLoadDone = true;

            log('[HOOK] Cloud hydrated, checking for schedule data...');

            await new Promise(r => setTimeout(r, 500));

            const dateKey = window.currentScheduleDate || 
                           document.getElementById('schedule-date-input')?.value ||
                           document.getElementById('datepicker')?.value ||
                           document.getElementById('calendar-date-picker')?.value;
            
            if (!dateKey) {
                log('[HOOK] No date key available');
                return;
            }

            const currentBunks = Object.keys(window.scheduleAssignments || {}).length;
            
            if (currentBunks === 0) {
                log('[HOOK] No local data, fetching from cloud...');
                await forceLoadScheduleFromCloud(dateKey);
            } else {
                log('[HOOK] Local data exists, refreshing from cloud...');
                await forceLoadScheduleFromCloud(dateKey);
            }
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

        // Expose helper functions globally
        window.scheduleCloudSync = function() {
            const dateKey = window.currentScheduleDate;
            if (!dateKey) return;

            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                divisionTimes: window.divisionTimes || {},
                isRainyDay: window.isRainyDay || false
            };

            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
        };

        window.forceCloudSync = async function() {
            await window.ScheduleSync?.forceSync?.();
            await forceSyncToCloud();
        };

        // Expose verified save functions
        window.verifiedScheduleSave = verifiedScheduleSave;
        window.forceLoadScheduleFromCloud = forceLoadScheduleFromCloud;

        console.log('🔗 All hooks installed!');

        window.dispatchEvent(new CustomEvent('campistry-integration-ready'));

        const currentDate = window.currentScheduleDate || document.getElementById('schedule-date-input')?.value || document.getElementById('calendar-date-picker')?.value;
        if (currentDate && window.ScheduleSync?.subscribe) {
            console.log('🔗 Auto-subscribing to current date:', currentDate);
            window.ScheduleSync.subscribe(currentDate);
        }
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
        console.log('SCHEDULE SYNC DIAGNOSTIC v6.3');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Online:', navigator.onLine);
        console.log('Camp ID:', campId || 'MISSING');
        console.log('User ID:', userId?.substring(0, 8) + '...' || 'MISSING');
        console.log('');
        console.log('Window globals:');
        console.log('  scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('  unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('  divisionTimes:', Object.keys(window.divisionTimes || {}).length, 'divisions');
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
                    .select('scheduler_id, scheduler_name, divisions, updated_at, schedule_data, unified_times')
                    .eq('camp_id', campId)
                    .eq('date_key', dateKey);

                console.log('Cloud records:', data?.length || 0);
                if (data && data.length > 0) {
                    let totalCloudBunks = 0;
                    data.forEach((r, i) => {
                        const bunks = Object.keys(r.schedule_data?.scheduleAssignments || {}).length;
                        const slots = r.schedule_data?.unifiedTimes?.length || r.unified_times?.length || 0;
                        totalCloudBunks += bunks;
                        const isMe = r.scheduler_id === userId ? ' ★YOU★' : '';
                        console.log(`  [${i + 1}] ${r.scheduler_name || 'Unknown'}${isMe}`);
                        console.log(`      Divisions: ${JSON.stringify(r.divisions)}`);
                        console.log(`      Bunks: ${bunks}, Slots: ${slots}`);
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

    console.log('🔗 Campistry Integration Hooks v6.3 loaded');
    console.log('   Commands: diagnoseScheduleSync(), verifiedScheduleSave(), forceLoadScheduleFromCloud()');
    console.log('   New: CloudPermissions.diagnose() for unified permission checking');

})();
