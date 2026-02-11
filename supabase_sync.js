// =============================================================================
// supabase_sync.js v6.1 — CAMPISTRY REALTIME SYNC ENGINE
// =============================================================================
//
// INTEGRATES:
// - Realtime Supabase subscriptions
// - Debounced auto-save with offline queue
// - Multi-scheduler sync (from multi_scheduler_sync_master_patch.js)
// - Hydration flags (from hydration_lock.js, global_bootstrap.js)
// - Force hydration and empty state handling
//
// v6.1 FIXES:
// - ★ CRITICAL: Subscription memory leak fix - proper channel cleanup
// - ★ CRITICAL: Offline queue now persisted to localStorage
// - ★ NEW: Network reconnection handler with exponential backoff
// - ★ IMPROVED: Better subscription status tracking
//
// REPLACES: 
// - realtime_schedule_sync.js
// - multi_scheduler_sync_master_patch.js  
// - hydration_lock.js
// - global_bootstrap.js
// - schedule_autoloader.js
//
// REQUIRES: supabase_client.js, supabase_schedules.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔄 Campistry Sync Engine v6.1 loading...');

    // =========================================================================
    // MIGRATED FLAGS (from hydration_lock.js and global_bootstrap.js)
    // =========================================================================
    
    if (typeof window.__CAMPISTRY_HYDRATED__ === 'undefined') {
        window.__CAMPISTRY_HYDRATED__ = false;
    }
    
    if (typeof window.__CAMPISTRY_CLOUD_READY__ === 'undefined') {
        window.__CAMPISTRY_CLOUD_READY__ = false;
    }
    
    // Fallback: if cloud bridge hasn't initialized in 3 seconds, proceed anyway
    setTimeout(() => {
        if (!window.__CAMPISTRY_CLOUD_READY__) {
            console.warn("[Sync] Cloud bridge timeout - proceeding with local storage");
            window.__CAMPISTRY_CLOUD_READY__ = true;
        }
    }, 3000);

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const CONFIG = {
        SAVE_DEBOUNCE_MS: 500,
        RECONNECT_DELAY_MS: 3000,
        MAX_RETRY_ATTEMPTS: 5,
        RETRY_DELAY_MS: 2000,
        DEBUG: false,
        OFFLINE_QUEUE_KEY: 'campistry_offline_queue_v1',  // ★ NEW: Persistent queue
        RECONNECT_BASE_DELAY_MS: 1000,
        RECONNECT_MAX_DELAY_MS: 30000
    };

    const DAILY_DATA_KEY = 'campDailyData_v1';

    // =========================================================================
    // STATE
    // =========================================================================

    let _isInitialized = false;
    let _subscription = null;
    let _subscriptionChannel = null;  // ★ NEW: Track channel separately
    let _currentDateKey = null;
    let _isOnline = navigator.onLine;
    let _syncStatus = 'idle';
    let _lastSyncTime = 0;
    let _saveTimeout = null;
    let _pendingSave = null;
    let _offlineQueue = [];
    let _remoteChangeCallbacks = [];
    let _statusChangeCallbacks = [];
    let _initialHydrationDone = false;
    let _reconnectAttempts = 0;  // ★ NEW: Track reconnection attempts
    let _reconnectTimeout = null;  // ★ NEW: Reconnect timer

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
    // UTILITY FUNCTIONS
    // =========================================================================

    function getCurrentDateKey() {
        return window.currentScheduleDate || 
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('datepicker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    // =========================================================================
    // ★★★ NEW: OFFLINE QUEUE PERSISTENCE ★★★
    // =========================================================================
    
    function loadOfflineQueue() {
        try {
            const persisted = localStorage.getItem(CONFIG.OFFLINE_QUEUE_KEY);
            if (persisted) {
                _offlineQueue = JSON.parse(persisted);
                log('Loaded offline queue:', _offlineQueue.length, 'items');
            }
        } catch (e) {
            logError('Failed to load offline queue:', e);
            _offlineQueue = [];
        }
    }
    
    function saveOfflineQueue() {
        try {
            localStorage.setItem(CONFIG.OFFLINE_QUEUE_KEY, JSON.stringify(_offlineQueue));
        } catch (e) {
            logError('Failed to save offline queue:', e);
        }
    }
    
    function clearOfflineQueue() {
        _offlineQueue = [];
        try {
            localStorage.removeItem(CONFIG.OFFLINE_QUEUE_KEY);
        } catch (e) {
            // Ignore
        }
    }

    // =========================================================================
    // MULTI-SCHEDULER SYNC: FORCE HYDRATION FROM LOCALSTORAGE
    // =========================================================================

    function forceHydrateFromLocalStorage(dateKey, forceOverwrite = false) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log(`Force hydrating for date: ${dateKey}, forceOverwrite: ${forceOverwrite}`);
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) {
                log('No data in localStorage - clearing window globals');
                window.scheduleAssignments = {};
                window.leagueAssignments = {};
                return false;
            }
            
            const dailyData = JSON.parse(raw);
            const dateData = dailyData[dateKey];
            
            if (!dateData) {
                log('No data for date:', dateKey, '- clearing window globals');
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
                    log('✅ Hydrated scheduleAssignments:', localBunkCount, 'bunks');
                }
            } else {
                window.scheduleAssignments = window.scheduleAssignments || {};
            }
            
            // Hydrate leagueAssignments
            if (dateData.leagueAssignments) {
                if (forceOverwrite || !window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
                    window.leagueAssignments = JSON.parse(JSON.stringify(dateData.leagueAssignments));
                    log('✅ Hydrated leagueAssignments');
                    hydrated = true;
                }
            } else {
                window.leagueAssignments = window.leagueAssignments || {};
            }
            
            // ★★★ FIX: Hydrate unifiedTimes if present ★★★
            if (dateData.unifiedTimes && Array.isArray(dateData.unifiedTimes) && dateData.unifiedTimes.length > 0) {
                if (forceOverwrite || !window.unifiedTimes || window.unifiedTimes.length === 0) {
                    window.unifiedTimes = dateData.unifiedTimes;
                    log('✅ Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
                    hydrated = true;
                }
            }
            
            // Hydrate divisionTimes if present
            if (dateData.divisionTimes && window.DivisionTimesSystem?.deserialize) {
                window.divisionTimes = window.DivisionTimesSystem.deserialize(dateData.divisionTimes);
                log('✅ Hydrated divisionTimes');
            }
            
            return hydrated;
            
        } catch (e) {
            logError('Hydration error:', e);
            return false;
        }
    }

    // =========================================================================
    // MULTI-SCHEDULER SYNC: ENSURE EMPTY STATE FOR UNSCHEDULED DIVISIONS
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
    // MULTI-SCHEDULER SYNC: REFRESH VIEW
    // =========================================================================

   async function refreshMultiSchedulerView(dateKey, forceOverwrite = false) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('Refreshing Multi-Scheduler view for:', dateKey);
        
        // ★★★ v6.2 FIX: Load from CLOUD first so we get all schedulers' data ★★★
        try {
            if (window.ScheduleDB?.loadSchedule && navigator.onLine) {
                const cloudResult = await window.ScheduleDB.loadSchedule(dateKey);
                if (cloudResult?.success && cloudResult.data) {
                    const DAILY_KEY = 'campDailyData_v1';
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    allData[dateKey] = {
                        ...allData[dateKey],
                        scheduleAssignments: cloudResult.data.scheduleAssignments || {},
                        leagueAssignments: cloudResult.data.leagueAssignments || {},
                        unifiedTimes: cloudResult.data.unifiedTimes || allData[dateKey]?.unifiedTimes || [],
                        divisionTimes: cloudResult.data.divisionTimes || allData[dateKey]?.divisionTimes || {}
                    };
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                    log('☁️ Updated localStorage from cloud:', 
                        Object.keys(cloudResult.data.scheduleAssignments || {}).length, 'bunks');
                }
            }
        } catch (e) {
            log('Cloud refresh failed, using localStorage:', e.message);
        }
        
        // Step 1: Force hydrate from localStorage (now contains cloud data)
        forceHydrateFromLocalStorage(dateKey, forceOverwrite);
        
        // Step 2: Ensure empty state for unscheduled divisions
        ensureEmptyStateForUnscheduledDivisions();
        
        // Step 3: Refresh Multi-Scheduler System if available
        if (window.MultiSchedulerSystem?.refresh) {
            try {
                await window.MultiSchedulerSystem.refresh();
                log('✅ MSS refresh complete');
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
            log('✅ Table updated');
        }
    }

    // =========================================================================
    // DIAGNOSTIC FUNCTION
    // =========================================================================

    function diagnoseScheduleSync() {
        const dateKey = getCurrentDateKey();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('🔍 SCHEDULE SYNC DIAGNOSIS v6.1');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Initial hydration done:', _initialHydrationDone);
        console.log('Sync status:', _syncStatus);
        console.log('Online:', _isOnline);
        console.log('Subscription active:', !!_subscription);
        console.log('Offline queue:', _offlineQueue.length, 'items');
        console.log('Reconnect attempts:', _reconnectAttempts);
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
            console.log('unifiedTimes slots:', (dateData.unifiedTimes || []).length);
            
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
        
        console.log('');
        console.log('=== Offline Queue ===');
        if (_offlineQueue.length > 0) {
            _offlineQueue.forEach((item, i) => {
                console.log(`  [${i + 1}] ${item.dateKey} - ${Object.keys(item.data?.scheduleAssignments || {}).length} bunks`);
            });
        } else {
            console.log('  (empty)');
        }
        
        console.log('═══════════════════════════════════════════════════════');
    }

    // =========================================================================
    // MANUAL FORCE REFRESH
    // =========================================================================

    function forceScheduleRefresh(dateKey) {
        dateKey = dateKey || getCurrentDateKey();
        console.log('[Sync] Manual FORCE refresh for:', dateKey);
        
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        
        forceHydrateFromLocalStorage(dateKey, true);
        ensureEmptyStateForUnscheduledDivisions();
        refreshMultiSchedulerView(dateKey, true);
        
        console.log('[Sync] ✅ Manual refresh complete');
    }

    // =========================================================================
    // STATUS INDICATOR UI
    // =========================================================================

    function createStatusIndicator() {
        if (document.getElementById('campistry-sync-status')) return;

        const indicator = document.createElement('div');
        indicator.id = 'campistry-sync-status';
        indicator.style.cssText = `
        display: none;
            position: fixed;
            bottom: 20px;
            left: 20px;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.3);
            z-index: 9999;
            transition: all 0.3s ease;
            cursor: pointer;
        `;
        indicator.title = 'Sync status: idle';
        
        indicator.addEventListener('click', () => {
            diagnoseScheduleSync();
        });
        
        document.body.appendChild(indicator);
    }

    function updateStatusIndicator(status) {
        const indicator = document.getElementById('campistry-sync-status');
        if (!indicator) return;

        const colors = {
            idle: '#10b981',
            saving: '#f59e0b',
            syncing: '#3b82f6',
            error: '#ef4444',
            offline: '#6b7280',
            reconnecting: '#8b5cf6'  // ★ NEW: Purple for reconnecting
        };

        indicator.style.background = colors[status] || colors.idle;
        indicator.title = `Sync status: ${status}`;
        
        if (status === 'syncing' || status === 'saving' || status === 'reconnecting') {
            indicator.style.animation = 'pulse 1s infinite';
        } else {
            indicator.style.animation = 'none';
        }
    }

    // =========================================================================
    // TOAST NOTIFICATIONS
    // =========================================================================

    function showSyncToast(message, isError = false) {
        let container = document.getElementById('campistry-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'campistry-toast-container';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                display: flex;
                flex-direction: column;
                gap: 8px;
            `;
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.style.cssText = `
            background: ${isError ? '#ef4444' : '#1f2937'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-family: system-ui, sans-serif;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
        `;
        toast.textContent = message;
        
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
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            `;
            document.head.appendChild(style);
        }

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // =========================================================================
    // ★★★ FIXED: REALTIME SUBSCRIPTION WITH PROPER CLEANUP ★★★
    // =========================================================================

    async function subscribe(dateKey) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) {
            log('Cannot subscribe: no client or camp ID');
            return false;
        }

        // ★★★ FIX: Proper cleanup before new subscription ★★★
        if (_subscription || _subscriptionChannel) {
            log('Cleaning up existing subscription before creating new one...');
            await unsubscribe();
            // Give Supabase a moment to clean up
            await new Promise(r => setTimeout(r, 100));
        }

        _currentDateKey = dateKey;

        try {
            const channelName = `schedules-${campId}-${dateKey}-${Date.now()}`;  // Unique channel name
            log('Creating subscription channel:', channelName);
            
            _subscriptionChannel = client.channel(channelName);
            
            _subscription = _subscriptionChannel
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
                        _reconnectAttempts = 0;  // Reset on successful subscription
                    } else if (status === 'CHANNEL_ERROR') {
                        updateStatus('error');
                        scheduleReconnect();  // ★ NEW: Auto-reconnect on error
                    } else if (status === 'TIMED_OUT') {
                        updateStatus('error');
                        scheduleReconnect();
                    }
                });

            log('Subscribed to', dateKey);
            return true;

        } catch (e) {
            logError('Subscribe failed:', e);
            scheduleReconnect();
            return false;
        }
    }

    // ★★★ FIXED: Proper unsubscribe with channel removal ★★★
    async function unsubscribe() {
        if (_subscriptionChannel) {
            try {
                log('Removing subscription channel...');
                const client = window.CampistryDB?.getClient?.();
                if (client) {
                    await client.removeChannel(_subscriptionChannel);
                }
            } catch (e) {
                log('Channel removal error (non-fatal):', e.message);
            }
            _subscriptionChannel = null;
        }
        
        if (_subscription) {
            try {
                await _subscription.unsubscribe();
            } catch (e) {
                log('Unsubscribe error (non-fatal):', e.message);
            }
            _subscription = null;
        }
        
        _currentDateKey = null;
    }

    // ★★★ NEW: Network Reconnection Handler ★★★
    function scheduleReconnect() {
        if (_reconnectTimeout) {
            clearTimeout(_reconnectTimeout);
        }
        
        _reconnectAttempts++;
        
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
        const delay = Math.min(
            CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(2, _reconnectAttempts - 1),
            CONFIG.RECONNECT_MAX_DELAY_MS
        );
        
        log(`Scheduling reconnect attempt ${_reconnectAttempts} in ${delay}ms`);
        updateStatus('reconnecting');
        
        _reconnectTimeout = setTimeout(async () => {
            if (!_isOnline) {
                log('Still offline, skipping reconnect');
                return;
            }
            
            log(`Reconnect attempt ${_reconnectAttempts}...`);
            
            const dateKey = _currentDateKey || getCurrentDateKey();
            const success = await subscribe(dateKey);
            
            if (success) {
                log('✅ Reconnection successful');
                showSyncToast('🔄 Reconnected to sync');
                
                // Process any queued saves
                await processOfflineQueue();
                
                // Refresh data from cloud
                if (window.ScheduleDB?.loadSchedule) {
                    const result = await window.ScheduleDB.loadSchedule(dateKey);
                    if (result?.success && result.data) {
                        refreshMultiSchedulerView(dateKey, true);
                    }
                }
            } else if (_reconnectAttempts < CONFIG.MAX_RETRY_ATTEMPTS) {
                scheduleReconnect();
            } else {
                log('Max reconnect attempts reached');
                updateStatus('error');
                showSyncToast('⚠️ Connection lost - refresh page', true);
            }
        }, delay);
    }

    function handleRealtimeChange(payload) {
        const myUserId = window.CampistryDB?.getUserId?.();
        
        if (payload.new?.scheduler_id === myUserId) {
            log('Ignoring own change');
            return;
        }

        if (payload.new?.date_key !== _currentDateKey) {
            log('Ignoring change for different date:', payload.new?.date_key);
            return;
        }

        log('Remote change received:', payload.eventType, 'from', payload.new?.scheduler_name);

        _lastSyncTime = Date.now();

        notifyRemoteChange({
            type: payload.eventType,
            scheduler: payload.new?.scheduler_name || 'Unknown',
            schedulerId: payload.new?.scheduler_id,
            dateKey: payload.new?.date_key,
            data: payload.new?.schedule_data,
            divisions: payload.new?.divisions
        });

        showSyncToast(`📥 Update from ${payload.new?.scheduler_name || 'another scheduler'}`);
        
        // Auto-refresh after remote change
        setTimeout(() => {
            refreshMultiSchedulerView(_currentDateKey, true);
        }, 500);
    }

    // =========================================================================
    // ★★★ FIXED: SAVE QUEUE WITH PERSISTENT OFFLINE QUEUE ★★★
    // =========================================================================

    function queueSave(dateKey, data) {
        _pendingSave = { dateKey, data, timestamp: Date.now() };

        if (_saveTimeout) {
            clearTimeout(_saveTimeout);
        }

        updateStatus('saving');

        _saveTimeout = setTimeout(async () => {
            await executeSave();
        }, CONFIG.SAVE_DEBOUNCE_MS);
    }

    async function executeSave() {
        if (!_pendingSave) return;

        const { dateKey, data } = _pendingSave;
        _pendingSave = null;

        if (!_isOnline) {
            log('Offline - queueing for later');
            _offlineQueue.push({ dateKey, data, timestamp: Date.now() });
            saveOfflineQueue();  // ★★★ FIX: Persist queue ★★★
            updateStatus('offline');
            showSyncToast('📴 Saved offline - will sync when connected');
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
                _offlineQueue.push({ dateKey, data, timestamp: Date.now(), retries: 0 });
                saveOfflineQueue();  // ★★★ FIX: Persist queue ★★★
            }

        } catch (e) {
            logError('Save exception:', e);
            updateStatus('error');
            _offlineQueue.push({ dateKey, data, timestamp: Date.now(), retries: 0 });
            saveOfflineQueue();  // ★★★ FIX: Persist queue ★★★
        }
    }

    async function forceSave() {
        if (_saveTimeout) {
            clearTimeout(_saveTimeout);
            _saveTimeout = null;
        }
        await executeSave();
    }

    // =========================================================================
    // ★★★ FIXED: OFFLINE QUEUE PROCESSING WITH PERSISTENCE ★★★
    // =========================================================================

    function handleOnline() {
        log('Back online');
        _isOnline = true;
        updateStatus('idle');
        
        // Re-subscribe to realtime
        const dateKey = _currentDateKey || getCurrentDateKey();
        if (dateKey) {
            subscribe(dateKey);
        }
        
        // Process any queued saves
        processOfflineQueue();
    }

    function handleOffline() {
        log('Gone offline');
        _isOnline = false;
        updateStatus('offline');
    }

    async function processOfflineQueue() {
        // Load from persistence first
        loadOfflineQueue();
        
        if (_offlineQueue.length === 0) return;

        log('Processing offline queue:', _offlineQueue.length, 'items');
        updateStatus('syncing');
        showSyncToast(`🔄 Syncing ${_offlineQueue.length} queued change(s)...`);

        const queue = [..._offlineQueue];
        _offlineQueue = [];
        saveOfflineQueue();  // Clear persisted queue

        let successCount = 0;
        let failCount = 0;

        for (const item of queue) {
            try {
                const result = await window.ScheduleDB?.saveSchedule?.(item.dateKey, item.data);
                
                if (!result?.success) {
                    item.retries = (item.retries || 0) + 1;
                    if (item.retries < CONFIG.MAX_RETRY_ATTEMPTS) {
                        _offlineQueue.push(item);
                        failCount++;
                    } else {
                        logError('Gave up on save after', item.retries, 'retries');
                        failCount++;
                    }
                } else {
                    successCount++;
                }
            } catch (e) {
                item.retries = (item.retries || 0) + 1;
                if (item.retries < CONFIG.MAX_RETRY_ATTEMPTS) {
                    _offlineQueue.push(item);
                }
                failCount++;
            }

            await new Promise(r => setTimeout(r, 500));
        }

        // Save any remaining items back to persistence
        if (_offlineQueue.length > 0) {
            saveOfflineQueue();
        }

        updateStatus(_offlineQueue.length > 0 ? 'error' : 'idle');
        
        if (successCount > 0) {
            showSyncToast(`✅ Synced ${successCount} change(s)`);
        }
        if (failCount > 0) {
            showSyncToast(`⚠️ ${failCount} change(s) failed to sync`, true);
        }
    }

    // =========================================================================
    // STATUS MANAGEMENT
    // =========================================================================

    function updateStatus(status) {
        if (_syncStatus === status) return;
        
        _syncStatus = status;
        log('Status:', status);

        updateStatusIndicator(status);

        _statusChangeCallbacks.forEach(cb => {
            try {
                cb(status);
            } catch (e) {
                logError('Status callback error:', e);
            }
        });
    }

    function getSyncStatus() {
        const isActive = !!_subscription;
        return {
            status: _syncStatus,
            isOnline: _isOnline,
            lastSync: _lastSyncTime,
            queueLength: _offlineQueue.length,
            currentDate: _currentDateKey,
            initialHydrationDone: _initialHydrationDone,
            reconnectAttempts: _reconnectAttempts,
            subscriptionActive: isActive,
            isSubscribed: isActive  // ★ Alias for compatibility
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
    // FORCE SYNC (MANUAL)
    // =========================================================================

    async function forceSync() {
        if (!_currentDateKey) {
            log('No current date to sync');
            return { success: false, error: 'No date subscribed' };
        }

        updateStatus('syncing');

        try {
            await forceSave();

            const result = await window.ScheduleDB?.loadSchedule?.(_currentDateKey);

            if (result?.success && result.data) {
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
            window.__CAMPISTRY_HYDRATED__ = true;
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
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) return;

        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        // ★★★ NEW: Load persisted offline queue ★★★
        loadOfflineQueue();
        
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        createStatusIndicator();

        _isInitialized = true;
        log('Initialized');

        // Process any queued items from previous session
        if (_offlineQueue.length > 0 && _isOnline) {
            log('Found persisted offline queue, processing...');
            setTimeout(processOfflineQueue, 2000);
        }

        window.dispatchEvent(new CustomEvent('campistry-sync-ready'));
    }

    // Initialize after RBAC is ready
    function initAfterRBAC() {
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
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    // Main ScheduleSync object
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
        
        // Offline queue
        processOfflineQueue,
        clearOfflineQueue,
        
        // Status
        getSyncStatus,
        isOnline: () => _isOnline,
        
        // Toast
        showToast: showSyncToast,
        
        // ★ EXPOSED FOR VERIFICATION - Fix 6
        scheduleReconnect,
        get _reconnectAttempts() { return _reconnectAttempts; },
        
        // State
        get isInitialized() { return _isInitialized; },
        get currentDateKey() { return _currentDateKey; },
        get offlineQueueLength() { return _offlineQueue.length; }
    };

    // Multi-scheduler sync exports (globally accessible)
    window.forceHydrateFromLocalStorage = forceHydrateFromLocalStorage;
    window.ensureEmptyStateForUnscheduledDivisions = ensureEmptyStateForUnscheduledDivisions;
    window.refreshMultiSchedulerView = refreshMultiSchedulerView;
    window.diagnoseScheduleSync = diagnoseScheduleSync;
    window.forceScheduleRefresh = forceScheduleRefresh;

    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================

    if (window.CampistryDB?.ready) {
        window.CampistryDB.ready.then(() => {
            setTimeout(initialize, 150);
            setTimeout(initAfterRBAC, 200);
        });
    } else {
        window.addEventListener('campistry-db-ready', () => {
            setTimeout(initialize, 150);
            setTimeout(initAfterRBAC, 200);
        });
    }

    // Fallback initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initialize, 500);
            setTimeout(initAfterRBAC, 600);
        });
    } else {
        setTimeout(initialize, 500);
        setTimeout(initAfterRBAC, 600);
    }

    console.log('🔄 Campistry Sync Engine v6.1 loaded');
    console.log('   ✅ Realtime subscriptions (with proper cleanup)');
    console.log('   ✅ Multi-scheduler sync integrated');
    console.log('   ✅ Persistent offline queue');
    console.log('   ✅ Network reconnection handler');
    console.log('   Run: diagnoseScheduleSync() to check status');

})();
