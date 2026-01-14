// =============================================================================
// realtime_schedule_sync.js v1.0 — CAMPISTRY REALTIME COLLABORATION
// =============================================================================
//
// PURPOSE: Enable Google Sheets-like real-time collaboration
// - Instant save to cloud after generation
// - Supabase Realtime subscriptions for live updates
// - Visual sync indicators
// - Automatic refresh when other schedulers make changes
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔄 Realtime Schedule Sync v1.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const SUPABASE_URL = 'https://jxadnhevclwltyugijkw.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4YWRuaGV2Y2x3bHR5dWdpamt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ1OTk5ODYsImV4cCI6MjA2MDE3NTk4Nn0.9h3J2uvSKB9lu7dPFDjMJszFk';
    
    // Use the existing camp_daily_data table
    const TABLE_NAME = 'camp_daily_data';
    
    let DEBUG = true;
    let _subscription = null;
    let _campId = null;
    let _lastSyncTime = 0;
    let _pendingSave = null;
    let _saveDebounceMs = 500; // Save 500ms after last change
    let _pollInterval = null;
    let _isOnline = true;

    // =========================================================================
    // CAMP ID DETECTION - Multiple fallback methods
    // =========================================================================

    function getCampId() {
        // Try multiple sources
        if (_campId) return _campId;
        
        // Method 1: Window global
        if (window.CAMP_ID) {
            _campId = window.CAMP_ID;
            return _campId;
        }
        
        // Method 2: localStorage
        const stored = localStorage.getItem('camp_id');
        if (stored) {
            _campId = stored;
            return _campId;
        }
        
        // Method 3: Extract from cloud_storage_bridge logs or data
        const dailyData = localStorage.getItem('campDailyData_v1');
        if (dailyData) {
            try {
                const parsed = JSON.parse(dailyData);
                if (parsed._campId) {
                    _campId = parsed._campId;
                    return _campId;
                }
            } catch (e) {}
        }
        
        // Method 4: Check session storage
        const sessionCamp = sessionStorage.getItem('camp_id');
        if (sessionCamp) {
            _campId = sessionCamp;
            return _campId;
        }
        
        // Method 5: Look for it in Supabase auth
        if (window.supabase?.auth?.getUser) {
            // Will be set async
        }
        
        return null;
    }

    function getDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    function getUserId() {
        return window.currentUserId || 
               localStorage.getItem('user_id') || 
               sessionStorage.getItem('user_id') ||
               'anonymous';
    }

    function getSchedulerName() {
        return window.AccessControl?.getCurrentUserInfo?.()?.name ||
               window.currentUserName ||
               'Scheduler';
    }

    // =========================================================================
    // SYNC STATUS UI
    // =========================================================================

    function createSyncIndicator() {
        // Remove existing
        const existing = document.getElementById('realtime-sync-indicator');
        if (existing) existing.remove();
        
        const indicator = document.createElement('div');
        indicator.id = 'realtime-sync-indicator';
        indicator.innerHTML = `
            <div class="sync-status" style="
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: #1a1a2e;
                color: white;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 13px;
                font-family: -apple-system, sans-serif;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 10000;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.3s ease;
            ">
                <span class="sync-icon">●</span>
                <span class="sync-text">Synced</span>
            </div>
        `;
        document.body.appendChild(indicator);
        return indicator;
    }

    function updateSyncStatus(status, message) {
        let indicator = document.getElementById('realtime-sync-indicator');
        if (!indicator) indicator = createSyncIndicator();
        
        const icon = indicator.querySelector('.sync-icon');
        const text = indicator.querySelector('.sync-text');
        const container = indicator.querySelector('.sync-status');
        
        switch (status) {
            case 'synced':
                icon.style.color = '#4ade80';
                icon.textContent = '●';
                text.textContent = message || 'Synced';
                container.style.background = '#1a1a2e';
                break;
            case 'syncing':
                icon.style.color = '#fbbf24';
                icon.innerHTML = '↻';
                icon.style.animation = 'spin 1s linear infinite';
                text.textContent = message || 'Saving...';
                container.style.background = '#1e3a5f';
                break;
            case 'receiving':
                icon.style.color = '#60a5fa';
                icon.innerHTML = '↓';
                text.textContent = message || 'Receiving update...';
                container.style.background = '#1e3a5f';
                break;
            case 'error':
                icon.style.color = '#f87171';
                icon.textContent = '!';
                text.textContent = message || 'Sync error';
                container.style.background = '#7f1d1d';
                break;
            case 'offline':
                icon.style.color = '#9ca3af';
                icon.textContent = '○';
                text.textContent = message || 'Offline';
                container.style.background = '#374151';
                break;
        }
        
        // Auto-hide after 3 seconds for synced status
        if (status === 'synced') {
            setTimeout(() => {
                container.style.opacity = '0.6';
            }, 3000);
        } else {
            container.style.opacity = '1';
        }
    }

    // Add CSS animation for spinner
    const style = document.createElement('style');
    style.textContent = `
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        #realtime-sync-indicator .sync-icon {
            display: inline-block;
        }
    `;
    document.head.appendChild(style);

    // =========================================================================
    // SAVE TO CLOUD - Immediate with debounce
    // =========================================================================

    async function saveToCloud(immediate = false) {
        const campId = getCampId();
        const dateKey = getDateKey();
        
        if (!campId) {
            console.warn('[RealtimeSync] No camp ID - cannot save');
            return { success: false, error: 'No camp ID' };
        }
        
        // Debounce unless immediate
        if (!immediate) {
            if (_pendingSave) clearTimeout(_pendingSave);
            _pendingSave = setTimeout(() => saveToCloud(true), _saveDebounceMs);
            return { success: true, pending: true };
        }
        
        updateSyncStatus('syncing', 'Saving...');
        
        try {
            // Get current schedule data
            const scheduleAssignments = window.scheduleAssignments || {};
            const leagueAssignments = window.leagueAssignments || {};
            const unifiedTimes = window.unifiedTimes || [];
            
            // Serialize unifiedTimes properly
            const serializedTimes = unifiedTimes.map(t => ({
                start: t.start instanceof Date ? t.start.toISOString() : t.start,
                end: t.end instanceof Date ? t.end.toISOString() : t.end,
                startMin: t.startMin ?? (t.start instanceof Date ? t.start.getHours() * 60 + t.start.getMinutes() : null),
                endMin: t.endMin ?? (t.end instanceof Date ? t.end.getHours() * 60 + t.end.getMinutes() : null),
                label: t.label || ''
            }));
            
            // Build the daily data payload
            const dailyPayload = {
                scheduleAssignments,
                leagueAssignments,
                unifiedTimes: serializedTimes,
                skeleton: window.manualSkeleton || window.skeleton || [],
                lastModifiedBy: getSchedulerName(),
                lastModifiedAt: new Date().toISOString(),
                slotCount: unifiedTimes.length
            };
            
            // Use the existing cloud bridge if available
            if (window.forceSyncToCloud) {
                await window.forceSyncToCloud();
                _lastSyncTime = Date.now();
                updateSyncStatus('synced', 'Saved');
                
                if (DEBUG) console.log('[RealtimeSync] ✅ Saved via cloud bridge');
                return { success: true };
            }
            
            // Direct Supabase save as fallback
            const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}?camp_id=eq.${campId}`, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                }
            });
            
            const existing = await response.json();
            let cloudData = existing?.[0]?.daily_data || {};
            
            // Merge our data into the date key
            cloudData[dateKey] = {
                ...cloudData[dateKey],
                ...dailyPayload
            };
            
            // Save back
            const saveMethod = existing?.length > 0 ? 'PATCH' : 'POST';
            const saveUrl = existing?.length > 0 
                ? `${SUPABASE_URL}/rest/v1/${TABLE_NAME}?id=eq.${existing[0].id}`
                : `${SUPABASE_URL}/rest/v1/${TABLE_NAME}`;
            
            const saveResponse = await fetch(saveUrl, {
                method: saveMethod,
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(saveMethod === 'POST' ? {
                    camp_id: campId,
                    daily_data: cloudData,
                    updated_at: new Date().toISOString()
                } : {
                    daily_data: cloudData,
                    updated_at: new Date().toISOString()
                })
            });
            
            if (!saveResponse.ok) {
                throw new Error(`Save failed: ${saveResponse.status}`);
            }
            
            _lastSyncTime = Date.now();
            updateSyncStatus('synced', 'Saved');
            
            if (DEBUG) console.log('[RealtimeSync] ✅ Saved directly to Supabase');
            return { success: true };
            
        } catch (err) {
            console.error('[RealtimeSync] Save error:', err);
            updateSyncStatus('error', 'Save failed');
            return { success: false, error: err.message };
        }
    }

    // =========================================================================
    // LOAD FROM CLOUD
    // =========================================================================

    async function loadFromCloud() {
        const campId = getCampId();
        const dateKey = getDateKey();
        
        if (!campId) {
            console.warn('[RealtimeSync] No camp ID - cannot load');
            return { success: false, error: 'No camp ID' };
        }
        
        updateSyncStatus('receiving', 'Loading...');
        
        try {
            const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}?camp_id=eq.${campId}`, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                }
            });
            
            if (!response.ok) {
                throw new Error(`Load failed: ${response.status}`);
            }
            
            const data = await response.json();
            const record = data?.[0];
            
            if (!record?.daily_data) {
                updateSyncStatus('synced', 'No cloud data');
                return { success: true, hasData: false };
            }
            
            const dateData = record.daily_data[dateKey];
            if (!dateData) {
                updateSyncStatus('synced', 'No data for date');
                return { success: true, hasData: false };
            }
            
            // Apply to window
            if (dateData.scheduleAssignments) {
                window.scheduleAssignments = dateData.scheduleAssignments;
            }
            if (dateData.leagueAssignments) {
                window.leagueAssignments = dateData.leagueAssignments;
            }
            if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
                window.unifiedTimes = deserializeUnifiedTimes(dateData.unifiedTimes);
                window._unifiedTimesFromCloud = true;
            }
            
            // Update localStorage too
            saveToLocalStorage(dateKey, dateData);
            
            // Refresh UI
            if (window.updateTable) {
                window.updateTable();
            }
            
            _lastSyncTime = Date.now();
            updateSyncStatus('synced', 'Loaded');
            
            if (DEBUG) {
                console.log('[RealtimeSync] ✅ Loaded from cloud:', {
                    bunks: Object.keys(dateData.scheduleAssignments || {}).length,
                    slots: dateData.unifiedTimes?.length || 0
                });
            }
            
            return { success: true, hasData: true };
            
        } catch (err) {
            console.error('[RealtimeSync] Load error:', err);
            updateSyncStatus('error', 'Load failed');
            return { success: false, error: err.message };
        }
    }

    function deserializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => {
            const startDate = new Date(t.start);
            const endDate = new Date(t.end);
            return {
                start: startDate,
                end: endDate,
                startMin: t.startMin ?? (startDate.getHours() * 60 + startDate.getMinutes()),
                endMin: t.endMin ?? (endDate.getHours() * 60 + endDate.getMinutes()),
                label: t.label || ''
            };
        });
    }

    function saveToLocalStorage(dateKey, data) {
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            const dailyData = raw ? JSON.parse(raw) : {};
            dailyData[dateKey] = { ...dailyData[dateKey], ...data };
            localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
        } catch (e) {
            console.warn('[RealtimeSync] localStorage save failed:', e);
        }
    }

    // =========================================================================
    // REALTIME SUBSCRIPTION - Supabase Realtime
    // =========================================================================

    async function setupRealtimeSubscription() {
        const campId = getCampId();
        if (!campId) {
            console.warn('[RealtimeSync] No camp ID - cannot subscribe');
            return false;
        }
        
        // Check if Supabase client is available
        if (!window.supabase) {
            console.log('[RealtimeSync] No Supabase client - using polling fallback');
            startPolling();
            return false;
        }
        
        try {
            // Unsubscribe from existing
            if (_subscription) {
                await _subscription.unsubscribe();
            }
            
            // Subscribe to changes on camp_daily_data
            _subscription = window.supabase
                .channel(`schedule-${campId}`)
                .on('postgres_changes', 
                    { 
                        event: '*', 
                        schema: 'public', 
                        table: TABLE_NAME,
                        filter: `camp_id=eq.${campId}`
                    }, 
                    (payload) => {
                        handleRealtimeUpdate(payload);
                    }
                )
                .subscribe((status) => {
                    if (status === 'SUBSCRIBED') {
                        console.log('[RealtimeSync] ✅ Realtime subscription active');
                        updateSyncStatus('synced', 'Live');
                    } else if (status === 'CHANNEL_ERROR') {
                        console.warn('[RealtimeSync] Subscription error, falling back to polling');
                        startPolling();
                    }
                });
            
            return true;
            
        } catch (err) {
            console.error('[RealtimeSync] Subscription error:', err);
            startPolling();
            return false;
        }
    }

    function handleRealtimeUpdate(payload) {
        if (DEBUG) console.log('[RealtimeSync] Realtime update received:', payload.eventType);
        
        // Don't process our own updates (within 2 seconds of saving)
        if (Date.now() - _lastSyncTime < 2000) {
            if (DEBUG) console.log('[RealtimeSync] Ignoring own update');
            return;
        }
        
        updateSyncStatus('receiving', 'Update received');
        
        // Reload data from cloud
        setTimeout(() => {
            loadFromCloud().then(() => {
                if (window.showToast) {
                    window.showToast('📥 Schedule updated by another user', 'info');
                }
            });
        }, 500);
    }

    // =========================================================================
    // POLLING FALLBACK - For when Realtime isn't available
    // =========================================================================

    function startPolling() {
        if (_pollInterval) clearInterval(_pollInterval);
        
        // Poll every 10 seconds
        _pollInterval = setInterval(async () => {
            if (!_isOnline) return;
            
            const campId = getCampId();
            if (!campId) return;
            
            try {
                const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}?camp_id=eq.${campId}&select=updated_at`, {
                    method: 'GET',
                    headers: {
                        'apikey': SUPABASE_ANON_KEY,
                        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                    }
                });
                
                const data = await response.json();
                const cloudUpdatedAt = new Date(data?.[0]?.updated_at).getTime();
                
                // If cloud is newer than our last sync, reload
                if (cloudUpdatedAt > _lastSyncTime + 2000) {
                    if (DEBUG) console.log('[RealtimeSync] Poll detected newer data');
                    loadFromCloud();
                }
                
            } catch (err) {
                // Silent fail for polling
            }
        }, 10000);
        
        console.log('[RealtimeSync] Polling fallback started (10s interval)');
    }

    function stopPolling() {
        if (_pollInterval) {
            clearInterval(_pollInterval);
            _pollInterval = null;
        }
    }

    // =========================================================================
    // EVENT HOOKS
    // =========================================================================

    function installEventHooks() {
        // Save after generation completes
        window.addEventListener('campistry-generation-complete', () => {
            console.log('[RealtimeSync] Generation complete - saving immediately');
            saveToCloud(true);
        });
        
        // Save after manual edits
        window.addEventListener('campistry-daily-data-updated', () => {
            // Debounced save
            saveToCloud(false);
        });
        
        // Reload on date change
        window.addEventListener('campistry-date-changed', (e) => {
            console.log('[RealtimeSync] Date changed - loading from cloud');
            loadFromCloud();
        });
        
        // Handle online/offline
        window.addEventListener('online', () => {
            _isOnline = true;
            updateSyncStatus('synced', 'Back online');
            loadFromCloud();
        });
        
        window.addEventListener('offline', () => {
            _isOnline = false;
            updateSyncStatus('offline', 'Offline');
        });
        
        // Hook into saveCurrentDailyData if not already hooked
        const originalSave = window.saveCurrentDailyData;
        if (originalSave && !originalSave._realtimeHooked) {
            window.saveCurrentDailyData = function(key, data) {
                const result = originalSave.call(this, key, data);
                
                // Trigger cloud save on schedule changes
                if (key === 'scheduleAssignments' || key === 'leagueAssignments') {
                    saveToCloud(false);
                }
                
                return result;
            };
            window.saveCurrentDailyData._realtimeHooked = true;
            if (DEBUG) console.log('[RealtimeSync] ✅ Hooked saveCurrentDailyData');
        }
        
        if (DEBUG) console.log('[RealtimeSync] ✅ Event hooks installed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        console.log('[RealtimeSync] Initializing...');
        
        // Create sync indicator
        createSyncIndicator();
        updateSyncStatus('syncing', 'Connecting...');
        
        // Wait for camp ID with multiple attempts
        let attempts = 0;
        while (!getCampId() && attempts < 30) {
            await new Promise(r => setTimeout(r, 200));
            attempts++;
            
            // Try to extract from other sources
            if (attempts === 10) {
                // Check if cloud bridge has camp ID
                if (window.cloudStorageBridge?.campId) {
                    _campId = window.cloudStorageBridge.campId;
                }
            }
        }
        
        const campId = getCampId();
        if (!campId) {
            console.warn('[RealtimeSync] No camp ID found - limited functionality');
            updateSyncStatus('error', 'No camp ID');
            return;
        }
        
        console.log('[RealtimeSync] Camp ID:', campId);
        
        // Install event hooks
        installEventHooks();
        
        // Try to setup realtime subscription
        const realtimeOk = await setupRealtimeSubscription();
        
        if (!realtimeOk) {
            // Fallback to polling
            startPolling();
        }
        
        // Initial load from cloud
        await loadFromCloud();
        
        console.log('[RealtimeSync] ✅ Initialization complete');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.RealtimeScheduleSync = {
        version: '1.0',
        
        // Manual controls
        save: () => saveToCloud(true),
        load: loadFromCloud,
        refresh: loadFromCloud,
        
        // Status
        getStatus: () => ({
            campId: getCampId(),
            dateKey: getDateKey(),
            lastSyncTime: _lastSyncTime,
            isOnline: _isOnline,
            hasSubscription: !!_subscription,
            isPolling: !!_pollInterval
        }),
        
        // Debug
        DEBUG_ON: () => { DEBUG = true; },
        DEBUG_OFF: () => { DEBUG = false; },
        
        // Force reconnect
        reconnect: async () => {
            stopPolling();
            if (_subscription) await _subscription.unsubscribe();
            await setupRealtimeSubscription();
        }
    };

    // Initialize when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(initialize, 1000));
    } else {
        setTimeout(initialize, 1000);
    }

    console.log('🔄 Realtime Schedule Sync v1.0 loaded');
    console.log('   Auto-saves on changes');
    console.log('   Listens for updates from other users');
    console.log('   Use: window.RealtimeScheduleSync.save() to force save');
    console.log('   Use: window.RealtimeScheduleSync.load() to force load');

})();
