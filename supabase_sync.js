// =============================================================================
// supabase_sync.js v5.0 — CAMPISTRY REALTIME SYNC ENGINE
// =============================================================================
//
// Handles live synchronization between multiple schedulers.
//
// REPLACES: realtime_schedule_sync.js, parts of cloud_storage_bridge.js
//
// PROVIDES:
// - Supabase Realtime subscriptions
// - Debounced auto-save
// - Optimistic updates with conflict resolution
// - Offline queue with retry
// - Sync status tracking
// - Visual indicators
//
// REQUIRES: supabase_client.js, supabase_schedules.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔄 Campistry Realtime Sync v5.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const CONFIG = {
        SAVE_DEBOUNCE_MS: 500,       // Wait 500ms after last change before saving
        RECONNECT_DELAY_MS: 3000,    // Wait 3s before reconnecting
        MAX_RETRY_ATTEMPTS: 5,       // Max retries for failed saves
        RETRY_DELAY_MS: 2000,        // Delay between retries
        DEBUG: false
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _isInitialized = false;
    let _subscription = null;
    let _currentDateKey = null;
    let _isOnline = navigator.onLine;
    let _syncStatus = 'idle'; // idle | saving | syncing | error | offline
    let _lastSyncTime = 0;
    let _saveTimeout = null;
    let _pendingSave = null;
    let _offlineQueue = [];
    let _remoteChangeCallbacks = [];
    let _statusChangeCallbacks = [];

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('🔄 [Sync]', ...args);
        }
    }

    function logError(...args) {
        console.error('🔄 [Sync] ERROR:', ...args);
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) return;

        // Wait for dependencies
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        // Setup online/offline listeners
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Create status indicator UI
        createStatusIndicator();

        _isInitialized = true;
        log('Initialized');

        window.dispatchEvent(new CustomEvent('campistry-sync-ready'));
    }

    // =========================================================================
    // SUPABASE REALTIME SUBSCRIPTION
    // =========================================================================

    /**
     * Subscribe to changes for a specific date.
     */
    async function subscribe(dateKey) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) {
            log('Cannot subscribe: no client or camp ID');
            return false;
        }

        // Unsubscribe from previous
        if (_subscription) {
            await unsubscribe();
        }

        _currentDateKey = dateKey;

        try {
            // Subscribe to changes on daily_schedules for this camp + date
            _subscription = client
                .channel(`schedules-${campId}-${dateKey}`)
                .on('postgres_changes', 
                    {
                        event: '*',
                        schema: 'public',
                        table: 'daily_schedules',
                        filter: `camp_id=eq.${campId}`
                    },
                    handleRealtimeChange
                )
                .subscribe((status) => {
                    log('Subscription status:', status);
                    if (status === 'SUBSCRIBED') {
                        updateStatus('idle');
                    } else if (status === 'CHANNEL_ERROR') {
                        updateStatus('error');
                    }
                });

            log('Subscribed to', dateKey);
            return true;

        } catch (e) {
            logError('Subscribe failed:', e);
            return false;
        }
    }

    /**
     * Unsubscribe from current channel.
     */
    async function unsubscribe() {
        if (_subscription) {
            try {
                await _subscription.unsubscribe();
            } catch (e) {
                log('Unsubscribe error (non-fatal):', e);
            }
            _subscription = null;
        }
        _currentDateKey = null;
    }

    /**
     * Handle incoming realtime changes.
     */
    function handleRealtimeChange(payload) {
        const myUserId = window.CampistryDB?.getUserId?.();
        
        // Ignore our own changes
        if (payload.new?.scheduler_id === myUserId) {
            log('Ignoring own change');
            return;
        }

        // Only process changes for current date
        if (payload.new?.date_key !== _currentDateKey) {
            log('Ignoring change for different date:', payload.new?.date_key);
            return;
        }

        log('Remote change received:', payload.eventType, 'from', payload.new?.scheduler_name);

        // Update last sync time
        _lastSyncTime = Date.now();

        // Notify callbacks
        notifyRemoteChange({
            type: payload.eventType, // INSERT | UPDATE | DELETE
            scheduler: payload.new?.scheduler_name || 'Unknown',
            schedulerId: payload.new?.scheduler_id,
            dateKey: payload.new?.date_key,
            data: payload.new?.schedule_data,
            divisions: payload.new?.divisions
        });

        // Show visual indicator
        showSyncToast(`📥 Update from ${payload.new?.scheduler_name || 'another scheduler'}`);
    }

    // =========================================================================
    // SAVE QUEUE (DEBOUNCED)
    // =========================================================================

    /**
     * Queue a save operation (debounced).
     * Multiple calls within the debounce window will be merged.
     */
    function queueSave(dateKey, data) {
        // Store pending save
        _pendingSave = { dateKey, data, timestamp: Date.now() };

        // Clear existing timeout
        if (_saveTimeout) {
            clearTimeout(_saveTimeout);
        }

        // Update status
        updateStatus('saving');

        // Schedule save after debounce period
        _saveTimeout = setTimeout(async () => {
            await executeSave();
        }, CONFIG.SAVE_DEBOUNCE_MS);
    }

    /**
     * Execute the pending save.
     */
    async function executeSave() {
        if (!_pendingSave) return;

        const { dateKey, data } = _pendingSave;
        _pendingSave = null;

        // Check if offline
        if (!_isOnline) {
            log('Offline - queueing for later');
            _offlineQueue.push({ dateKey, data, timestamp: Date.now() });
            updateStatus('offline');
            return;
        }

        try {
            updateStatus('syncing');

            const result = await window.ScheduleDB?.saveSchedule?.(dateKey, data);

            if (result?.success) {
                _lastSyncTime = Date.now();
                updateStatus('idle');
                log('Save complete');
            } else {
                logError('Save failed:', result?.error);
                updateStatus('error');
                // Queue for retry
                _offlineQueue.push({ dateKey, data, timestamp: Date.now(), retries: 0 });
            }

        } catch (e) {
            logError('Save exception:', e);
            updateStatus('error');
            _offlineQueue.push({ dateKey, data, timestamp: Date.now(), retries: 0 });
        }
    }

    /**
     * Force an immediate save (skip debounce).
     */
    async function forceSave() {
        if (_saveTimeout) {
            clearTimeout(_saveTimeout);
            _saveTimeout = null;
        }
        await executeSave();
    }

    // =========================================================================
    // OFFLINE QUEUE PROCESSING
    // =========================================================================

    function handleOnline() {
        log('Back online');
        _isOnline = true;
        updateStatus('idle');
        processOfflineQueue();
    }

    function handleOffline() {
        log('Gone offline');
        _isOnline = false;
        updateStatus('offline');
    }

    async function processOfflineQueue() {
        if (_offlineQueue.length === 0) return;

        log('Processing offline queue:', _offlineQueue.length, 'items');
        updateStatus('syncing');

        const queue = [..._offlineQueue];
        _offlineQueue = [];

        for (const item of queue) {
            try {
                const result = await window.ScheduleDB?.saveSchedule?.(item.dateKey, item.data);
                
                if (!result?.success) {
                    item.retries = (item.retries || 0) + 1;
                    if (item.retries < CONFIG.MAX_RETRY_ATTEMPTS) {
                        _offlineQueue.push(item);
                    } else {
                        logError('Gave up on save after', item.retries, 'retries');
                    }
                }
            } catch (e) {
                item.retries = (item.retries || 0) + 1;
                if (item.retries < CONFIG.MAX_RETRY_ATTEMPTS) {
                    _offlineQueue.push(item);
                }
            }

            // Small delay between saves
            await new Promise(r => setTimeout(r, 500));
        }

        updateStatus(_offlineQueue.length > 0 ? 'error' : 'idle');
    }

    // =========================================================================
    // STATUS MANAGEMENT
    // =========================================================================

    function updateStatus(status) {
        if (_syncStatus === status) return;
        
        _syncStatus = status;
        log('Status:', status);

        // Update UI indicator
        updateStatusIndicator(status);

        // Notify callbacks
        _statusChangeCallbacks.forEach(cb => {
            try {
                cb(status);
            } catch (e) {
                logError('Status callback error:', e);
            }
        });
    }

    function getSyncStatus() {
        return {
            status: _syncStatus,
            isOnline: _isOnline,
            lastSync: _lastSyncTime,
            queueLength: _offlineQueue.length,
            currentDate: _currentDateKey
        };
    }

    // =========================================================================
    // CALLBACKS
    // =========================================================================

    function onRemoteChange(callback) {
        if (typeof callback === 'function') {
            _remoteChangeCallbacks.push(callback);
        }
        return () => {
            _remoteChangeCallbacks = _remoteChangeCallbacks.filter(cb => cb !== callback);
        };
    }

    function notifyRemoteChange(data) {
        _remoteChangeCallbacks.forEach(cb => {
            try {
                cb(data);
            } catch (e) {
                logError('Remote change callback error:', e);
            }
        });
    }

    function onStatusChange(callback) {
        if (typeof callback === 'function') {
            _statusChangeCallbacks.push(callback);
        }
        return () => {
            _statusChangeCallbacks = _statusChangeCallbacks.filter(cb => cb !== callback);
        };
    }

    // =========================================================================
    // UI: STATUS INDICATOR
    // =========================================================================

    let _statusIndicator = null;

    function createStatusIndicator() {
        // Check if already exists
        if (document.getElementById('campistry-sync-status')) return;

        const indicator = document.createElement('div');
        indicator.id = 'campistry-sync-status';
        indicator.innerHTML = `
            <style>
                #campistry-sync-status {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    padding: 8px 16px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-family: system-ui, sans-serif;
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    transition: all 0.3s ease;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                }
                #campistry-sync-status.idle {
                    background: #10b981;
                    color: white;
                }
                #campistry-sync-status.saving,
                #campistry-sync-status.syncing {
                    background: #3b82f6;
                    color: white;
                }
                #campistry-sync-status.error {
                    background: #ef4444;
                    color: white;
                }
                #campistry-sync-status.offline {
                    background: #6b7280;
                    color: white;
                }
                #campistry-sync-status .dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: currentColor;
                }
                #campistry-sync-status.syncing .dot,
                #campistry-sync-status.saving .dot {
                    animation: pulse 1s infinite;
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
                #campistry-sync-status.hidden {
                    opacity: 0;
                    transform: translateY(20px);
                    pointer-events: none;
                }
            </style>
            <span class="dot"></span>
            <span class="text">Synced</span>
        `;
        
        document.body.appendChild(indicator);
        _statusIndicator = indicator;

        // Auto-hide after idle
        setTimeout(() => {
            if (_syncStatus === 'idle') {
                indicator.classList.add('hidden');
            }
        }, 3000);
    }

    function updateStatusIndicator(status) {
        if (!_statusIndicator) return;

        _statusIndicator.className = status;
        const textEl = _statusIndicator.querySelector('.text');

        switch (status) {
            case 'idle':
                textEl.textContent = 'Synced';
                setTimeout(() => {
                    if (_syncStatus === 'idle') {
                        _statusIndicator.classList.add('hidden');
                    }
                }, 2000);
                break;
            case 'saving':
                textEl.textContent = 'Saving...';
                _statusIndicator.classList.remove('hidden');
                break;
            case 'syncing':
                textEl.textContent = 'Syncing...';
                _statusIndicator.classList.remove('hidden');
                break;
            case 'error':
                textEl.textContent = 'Sync Error';
                _statusIndicator.classList.remove('hidden');
                break;
            case 'offline':
                textEl.textContent = 'Offline';
                _statusIndicator.classList.remove('hidden');
                break;
        }
    }

    // =========================================================================
    // UI: TOAST NOTIFICATIONS
    // =========================================================================

    function showSyncToast(message, type = 'info') {
        // Create toast container if needed
        let container = document.getElementById('campistry-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'campistry-toast-container';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10001;
                display: flex;
                flex-direction: column;
                gap: 8px;
            `;
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.style.cssText = `
            background: ${type === 'error' ? '#ef4444' : '#1f2937'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-family: system-ui, sans-serif;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
        `;
        toast.textContent = message;
        
        // Add animation keyframes if not present
        if (!document.getElementById('campistry-toast-styles')) {
            const style = document.createElement('style');
            style.id = 'campistry-toast-styles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        container.appendChild(toast);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // =========================================================================
    // FORCE SYNC (MANUAL)
    // =========================================================================

    async function forceSync() {
        if (!_currentDateKey) {
            log('No current date to sync');
            return { success: false, error: 'No date subscribed' };
        }

        updateStatus('syncing');

        try {
            // Force save any pending changes
            await forceSave();

            // Reload from cloud
            const result = await window.ScheduleDB?.loadSchedule?.(_currentDateKey);

            if (result?.success && result.data) {
                // Notify about the refresh
                notifyRemoteChange({
                    type: 'REFRESH',
                    dateKey: _currentDateKey,
                    data: result.data
                });
            }

            updateStatus('idle');
            return { success: true };

        } catch (e) {
            logError('Force sync failed:', e);
            updateStatus('error');
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.ScheduleSync = {
        initialize,
        
        // Subscription
        subscribe,
        unsubscribe,
        
        // Callbacks
        onRemoteChange,
        onStatusChange,
        
        // Save queue
        queueSave,
        forceSave,
        forceSync,
        
        // Status
        getSyncStatus,
        isOnline: () => _isOnline,
        
        // Toast (for external use)
        showToast: showSyncToast,
        
        // State
        get isInitialized() { return _isInitialized; },
        get currentDateKey() { return _currentDateKey; }
    };

    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================

    if (window.CampistryDB?.ready) {
        window.CampistryDB.ready.then(() => {
            setTimeout(initialize, 150);
        });
    } else {
        window.addEventListener('campistry-db-ready', () => {
            setTimeout(initialize, 150);
        });
    }
// =========================================================================
    // MULTI-SCHEDULER SYNC SYSTEM (integrated from multi_scheduler_sync_master_patch.js)
    // =========================================================================
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    let _initialHydrationDone = false;
    
    function getCurrentDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    // =========================================================================
    // FORCE HYDRATION FROM LOCALSTORAGE
    // =========================================================================
    
    function forceHydrateFromLocalStorage(dateKey, forceOverwrite = false) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        console.log(`[Sync] Force hydrating for date: ${dateKey}, forceOverwrite: ${forceOverwrite}`);
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) {
                console.log('[Sync] No data in localStorage - clearing window globals');
                window.scheduleAssignments = {};
                window.leagueAssignments = {};
                return false;
            }
            
            const dailyData = JSON.parse(raw);
            const dateData = dailyData[dateKey];
            
            if (!dateData) {
                console.log('[Sync] No data for date:', dateKey, '- clearing window globals');
                window.scheduleAssignments = {};
                window.leagueAssignments = {};
                return false;
            }
            
            let hydrated = false;
            
            // Hydrate scheduleAssignments
            if (dateData.scheduleAssignments) {
                const localBunkCount = Object.keys(dateData.scheduleAssignments).length;
                const windowBunkCount = Object.keys(window.scheduleAssignments || {}).length;
                
                if (forceOverwrite || windowBunkCount === 0) {
                    window.scheduleAssignments = JSON.parse(JSON.stringify(dateData.scheduleAssignments));
                    hydrated = true;
                    console.log('[Sync] ✅ Hydrated scheduleAssignments:', localBunkCount, 'bunks');
                }
            } else {
                window.scheduleAssignments = window.scheduleAssignments || {};
            }
            
            // Hydrate leagueAssignments  
            if (dateData.leagueAssignments) {
                if (forceOverwrite || !window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
                    window.leagueAssignments = JSON.parse(JSON.stringify(dateData.leagueAssignments));
                    console.log('[Sync] ✅ Hydrated leagueAssignments');
                    hydrated = true;
                }
            } else {
                window.leagueAssignments = window.leagueAssignments || {};
            }
            
            // Hydrate divisionTimes if present
            if (dateData.divisionTimes && window.DivisionTimesSystem?.deserialize) {
                window.divisionTimes = window.DivisionTimesSystem.deserialize(dateData.divisionTimes);
                console.log('[Sync] ✅ Hydrated divisionTimes');
            }
            
            return hydrated;
            
        } catch (e) {
            console.error('[Sync] Hydration error:', e);
            return false;
        }
    }

    // =========================================================================
    // ENSURE EMPTY STATE FOR UNSCHEDULED DIVISIONS
    // =========================================================================
    
    function ensureEmptyStateForUnscheduledDivisions() {
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        
        const divisions = window.divisions || {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            
            // Use division-specific slot count
            const divSlotCount = window.divisionTimes?.[divName]?.length || 
                                 (window.unifiedTimes || []).length || 8;
            
            const hasData = bunks.some(bunk => {
                const bunkData = window.scheduleAssignments[bunk];
                if (!bunkData || !Array.isArray(bunkData)) return false;
                return bunkData.some(slot => slot && (slot.field || slot._activity));
            });
            
            if (!hasData) {
                bunks.forEach(bunk => {
                    if (!window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = new Array(divSlotCount).fill(null);
                    }
                });
            }
        }
    }

    // =========================================================================
    // REFRESH MULTI-SCHEDULER VIEW
    // =========================================================================
    
    async function refreshMultiSchedulerView(dateKey, forceOverwrite = false) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        console.log('[Sync] Refreshing Multi-Scheduler view for:', dateKey);
        
        // Step 1: Force hydrate from localStorage
        forceHydrateFromLocalStorage(dateKey, forceOverwrite);
        
        // Step 2: Ensure empty state for unscheduled divisions
        ensureEmptyStateForUnscheduledDivisions();
        
        // Step 3: Refresh Multi-Scheduler System if available
        if (window.MultiSchedulerSystem?.refresh) {
            try {
                await window.MultiSchedulerSystem.refresh();
                console.log('[Sync] ✅ MSS refresh complete');
            } catch (err) {
                console.warn('[Sync] MSS refresh error:', err);
            }
        } else if (window.MultiSchedulerSystem?.initializeView) {
            try {
                await window.MultiSchedulerSystem.initializeView(dateKey);
                window.MultiSchedulerSystem.applyBlockingToGrid?.();
            } catch (err) {
                console.warn('[Sync] MSS init error:', err);
            }
        }
        
        // Step 4: Update the table
        if (window.updateTable) {
            window.updateTable();
            console.log('[Sync] ✅ Table updated');
        }
    }

    // =========================================================================
    // DIAGNOSTIC FUNCTIONS
    // =========================================================================
    
    window.diagnoseScheduleSync = function() {
        const dateKey = getCurrentDateKey();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('🔍 SCHEDULE SYNC DIAGNOSIS');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Initial hydration done:', _initialHydrationDone);
        console.log('');
        
        console.log('=== Window Globals ===');
        const windowBunks = Object.keys(window.scheduleAssignments || {});
        console.log('scheduleAssignments bunks:', windowBunks.length);
        console.log('divisionTimes divisions:', Object.keys(window.divisionTimes || {}).length);
        console.log('unifiedTimes slots:', (window.unifiedTimes || []).length);
        
        if (windowBunks.length > 0) {
            const firstBunk = windowBunks[0];
            const firstData = window.scheduleAssignments[firstBunk];
            console.log(`First bunk "${firstBunk}": ${firstData?.length || 0} slots`);
        }
        console.log('');
        
        console.log('=== LocalStorage ===');
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            const daily = raw ? JSON.parse(raw) : {};
            const dateData = daily[dateKey] || {};
            const localBunks = Object.keys(dateData.scheduleAssignments || {});
            console.log('scheduleAssignments bunks:', localBunks.length);
            
            if (localBunks.length > 0 && windowBunks.length > 0) {
                const firstBunk = localBunks[0];
                const windowSlot = window.scheduleAssignments[firstBunk]?.[0];
                const localSlot = dateData.scheduleAssignments[firstBunk]?.[0];
                const match = JSON.stringify(windowSlot) === JSON.stringify(localSlot);
                console.log('Window/Local match:', match ? '✅ YES' : '❌ NO');
            }
        } catch (e) {
            console.log('Error:', e.message);
        }
        
        console.log('═══════════════════════════════════════════════════════');
    };

    window.forceScheduleRefresh = function(dateKey) {
        dateKey = dateKey || getCurrentDateKey();
        console.log('[Sync] Manual FORCE refresh for:', dateKey);
        
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        
        forceHydrateFromLocalStorage(dateKey, true);
        ensureEmptyStateForUnscheduledDivisions();
        refreshMultiSchedulerView(dateKey, true);
        
        console.log('[Sync] ✅ Manual refresh complete');
    };

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================
    
    // After cloud hydration, force hydrate window globals
    window.addEventListener('campistry-cloud-hydrated', (e) => {
        console.log('[Sync] Cloud hydration event received');
        
        setTimeout(() => {
            const dateKey = getCurrentDateKey();
            const hydrated = forceHydrateFromLocalStorage(dateKey, true);
            
            if (hydrated) {
                console.log('[Sync] ✅ Window globals updated from localStorage');
                ensureEmptyStateForUnscheduledDivisions();
                if (window.updateTable) window.updateTable();
            }
            
            _initialHydrationDone = true;
        }, 300);
    });

    // After date change, ensure proper hydration
    window.addEventListener('campistry-date-changed', (e) => {
        const dateKey = e.detail?.dateKey || getCurrentDateKey();
        console.log('[Sync] Date changed to:', dateKey);
        
        setTimeout(() => {
            forceHydrateFromLocalStorage(dateKey, true);
            ensureEmptyStateForUnscheduledDivisions();
            refreshMultiSchedulerView(dateKey, true);
        }, 100);
    });

    // Listen for realtime updates
    window.addEventListener('campistry-realtime-update', (e) => {
        console.log('[Sync] Realtime update event received');
        refreshMultiSchedulerView(getCurrentDateKey(), true);
    });

    // =========================================================================
    // INITIALIZATION - Run after RBAC is ready
    // =========================================================================
    
    const initMultiSchedulerSync = () => {
        const waitForRBAC = setInterval(() => {
            if (!window.AccessControl?.isInitialized) return;
            
            clearInterval(waitForRBAC);
            console.log('[Sync] RBAC ready, performing initial hydration');
            
            const dateKey = getCurrentDateKey();
            forceHydrateFromLocalStorage(dateKey, true);
            ensureEmptyStateForUnscheduledDivisions();
            
            if (window.MultiSchedulerSystem?.initializeView) {
                window.MultiSchedulerSystem.initializeView(dateKey).then(() => {
                    window.MultiSchedulerSystem.applyBlockingToGrid?.();
                    if (window.updateTable) window.updateTable();
                });
            } else if (window.updateTable) {
                window.updateTable();
            }
            
            _initialHydrationDone = true;
        }, 100);
        
        setTimeout(() => clearInterval(waitForRBAC), 15000);
    };
    
    // Start initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMultiSchedulerSync);
    } else {
        setTimeout(initMultiSchedulerSync, 100);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.forceHydrateFromLocalStorage = forceHydrateFromLocalStorage;
    window.ensureEmptyStateForUnscheduledDivisions = ensureEmptyStateForUnscheduledDivisions;
    window.refreshMultiSchedulerView = refreshMultiSchedulerView;

    console.log('[Sync] ✅ Multi-scheduler sync system initialized');
})();
