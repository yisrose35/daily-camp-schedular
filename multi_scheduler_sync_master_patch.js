// =============================================================================
// CAMPISTRY MULTI-SCHEDULER SYNC MASTER PATCH v1.0
// =============================================================================
//
// FIXES THREE CRITICAL ISSUES:
//
// ISSUE 1: Scheduler 2 doesn't see Scheduler 1's schedule until generating their own
//   → Root Cause: Cloud merge saves to localStorage but window.scheduleAssignments
//     isn't hydrated, so the render shows empty/stale data
//   → Fix: Force hydrate window globals after cloud merge
//
// ISSUE 2: Scheduler 1 can't see Scheduler 2's updates without regenerating
//   → Root Cause: Realtime updates load data but don't refresh MultiSchedulerSystem
//     blocking or trigger proper re-render
//   → Fix: Hook realtime events to trigger full refresh including MSS
//
// ISSUE 3: Divisions without schedules show random data instead of empty
//   → Root Cause: No explicit empty state handling
//   → Fix: Initialize empty arrays for divisions without schedule data
//
// INSTALLATION:
// 1. Add this file to your project
// 2. Load it AFTER these scripts (order matters):
//    - cloud_storage_bridge.js
//    - unified_schedule_system.js
//    - multi_scheduler_system.js
//    - realtime_schedule_sync.js
//
// In your HTML:
//   <script src="/multi_scheduler_sync_master_patch.js"></script>
//
// =============================================================================

(function() {
    'use strict';

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🔧 CAMPISTRY MULTI-SCHEDULER SYNC MASTER PATCH v1.0');
    console.log('═══════════════════════════════════════════════════════════════');

    const DEBUG = true;
    const DAILY_DATA_KEY = 'campDailyData_v1';

    function log(...args) {
        if (DEBUG) console.log('[SyncPatch]', ...args);
    }

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    function getCurrentDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    function normalizeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            return {
                start: startDate,
                end: endDate,
                startMin: t.startMin ?? (startDate.getHours() * 60 + startDate.getMinutes()),
                endMin: t.endMin ?? (endDate.getHours() * 60 + endDate.getMinutes()),
                label: t.label || ''
            };
        });
    }

    // =========================================================================
    // FIX 1: FORCE HYDRATION AFTER CLOUD MERGE
    // =========================================================================

    function forceHydrateFromLocalStorage(dateKey) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('Force hydrating window globals for date:', dateKey);
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) {
                log('No data in localStorage');
                window.scheduleAssignments = window.scheduleAssignments || {};
                window.leagueAssignments = window.leagueAssignments || {};
                return false;
            }
            
            const dailyData = JSON.parse(raw);
            const dateData = dailyData[dateKey];
            
            if (!dateData) {
                log('No data for date:', dateKey, '- setting empty state');
                window.scheduleAssignments = {};
                window.leagueAssignments = {};
                return false;
            }
            
            let hydrated = false;
            
            // Hydrate scheduleAssignments (always, to ensure we have latest)
            if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
                // Only hydrate if window is empty OR if this is a fresh load (not after generation)
                if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
                    window.scheduleAssignments = dateData.scheduleAssignments;
                    hydrated = true;
                    log('✅ Hydrated scheduleAssignments:', Object.keys(window.scheduleAssignments).length, 'bunks');
                }
            } else {
                // Ensure we have at least an empty object
                window.scheduleAssignments = window.scheduleAssignments || {};
            }
            
            // Hydrate leagueAssignments
            if (dateData.leagueAssignments && Object.keys(dateData.leagueAssignments).length > 0) {
                if (!window.leagueAssignments || Object.keys(window.leagueAssignments).length === 0) {
                    window.leagueAssignments = dateData.leagueAssignments;
                    hydrated = true;
                    log('✅ Hydrated leagueAssignments');
                }
            } else {
                window.leagueAssignments = window.leagueAssignments || {};
            }
            
            // Hydrate unifiedTimes
            if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
                if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
                    window.unifiedTimes = normalizeUnifiedTimes(dateData.unifiedTimes);
                    window._unifiedTimesFromCloud = true;
                    hydrated = true;
                    log('✅ Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
                }
            }
            
            return hydrated;
            
        } catch (e) {
            console.error('[SyncPatch] Hydration error:', e);
            return false;
        }
    }

    // =========================================================================
    // FIX 2: REFRESH MULTI-SCHEDULER SYSTEM AFTER UPDATES
    // =========================================================================

    async function refreshMultiSchedulerView(dateKey) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('Refreshing Multi-Scheduler view for:', dateKey);
        
        // Step 1: Force hydrate from localStorage
        forceHydrateFromLocalStorage(dateKey);
        
        // Step 2: Ensure empty state for unscheduled divisions
        ensureEmptyStateForUnscheduledDivisions();
        
        // Step 3: Refresh Multi-Scheduler System
        if (window.MultiSchedulerSystem?.refresh) {
            try {
                log('Triggering MultiSchedulerSystem.refresh()');
                await window.MultiSchedulerSystem.refresh();
                log('✅ MSS refresh complete');
            } catch (err) {
                console.warn('[SyncPatch] MSS refresh error:', err);
            }
        } else if (window.MultiSchedulerSystem?.initializeView) {
            try {
                await window.MultiSchedulerSystem.initializeView(dateKey);
                window.MultiSchedulerSystem.applyBlockingToGrid?.();
            } catch (err) {
                console.warn('[SyncPatch] MSS init error:', err);
            }
        }
        
        // Step 4: Update the table
        if (window.updateTable) {
            setTimeout(() => {
                window.updateTable();
                log('✅ Table updated');
            }, 100);
        }
    }

    // =========================================================================
    // FIX 3: EMPTY STATE HANDLING
    // =========================================================================

    function ensureEmptyStateForUnscheduledDivisions() {
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        
        const divisions = window.divisions || {};
        const slotCount = (window.unifiedTimes || []).length || 22;
        
        // For each division
        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            
            // Check if ANY bunk in this division has meaningful data
            const hasData = bunks.some(bunk => {
                const bunkData = window.scheduleAssignments[bunk];
                if (!bunkData || !Array.isArray(bunkData)) return false;
                return bunkData.some(slot => slot && (slot.field || slot._activity));
            });
            
            // If no data, ensure bunks are initialized with empty arrays
            // This ensures they show as empty rather than undefined
            if (!hasData) {
                bunks.forEach(bunk => {
                    if (!window.scheduleAssignments[bunk]) {
                        window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                    }
                });
            }
        }
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    // 1. After cloud hydration, force hydrate window globals
    window.addEventListener('campistry-cloud-hydrated', (e) => {
        log('Cloud hydration event received');
        
        setTimeout(() => {
            const dateKey = getCurrentDateKey();
            const hydrated = forceHydrateFromLocalStorage(dateKey);
            
            if (hydrated) {
                ensureEmptyStateForUnscheduledDivisions();
                
                // Update table
                if (window.updateTable) {
                    window.updateTable();
                }
            }
        }, 200);
    });

    // 2. After date change, ensure proper hydration
    window.addEventListener('campistry-date-changed', (e) => {
        const dateKey = e.detail?.dateKey || getCurrentDateKey();
        log('Date changed to:', dateKey);
        
        // Clear old data
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window._unifiedTimesFromCloud = false;
        
        setTimeout(() => {
            forceHydrateFromLocalStorage(dateKey);
            ensureEmptyStateForUnscheduledDivisions();
            refreshMultiSchedulerView(dateKey);
        }, 100);
    });

    // 3. Listen for realtime updates and dispatch refresh
    window.addEventListener('campistry-realtime-update', (e) => {
        log('Realtime update event received');
        refreshMultiSchedulerView();
    });

    // =========================================================================
    // PATCH: Intercept loadScheduleForDate
    // =========================================================================
    
    const originalLoadScheduleForDate = window.loadScheduleForDate;
    
    window.loadScheduleForDate = function(dateKey) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('loadScheduleForDate called for:', dateKey);
        
        // FIX: If window globals are empty, try localStorage first
        if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
            log('Window empty, checking localStorage...');
            forceHydrateFromLocalStorage(dateKey);
        }
        
        // Call original
        if (originalLoadScheduleForDate && typeof originalLoadScheduleForDate === 'function') {
            return originalLoadScheduleForDate.call(this, dateKey);
        }
        
        ensureEmptyStateForUnscheduledDivisions();
    };

    // =========================================================================
    // PATCH: Intercept RealtimeScheduleSync.load to dispatch event
    // =========================================================================
    
    if (window.RealtimeScheduleSync) {
        const originalLoad = window.RealtimeScheduleSync.load;
        
        window.RealtimeScheduleSync.load = async function() {
            log('RealtimeScheduleSync.load intercepted');
            
            const result = await originalLoad?.call(this);
            
            // Dispatch event for our refresh logic
            if (result?.success || result?.hasData) {
                window.dispatchEvent(new CustomEvent('campistry-realtime-update', {
                    detail: { success: result?.success, hasData: result?.hasData }
                }));
            }
            
            return result;
        };
        
        log('✅ RealtimeScheduleSync.load patched');
    }

    // =========================================================================
    // PATCH: Hook into Supabase realtime channel
    // =========================================================================
    
    if (window.supabase?.channel) {
        const originalChannel = window.supabase.channel.bind(window.supabase);
        
        window.supabase.channel = function(name) {
            const channel = originalChannel(name);
            const originalOn = channel.on.bind(channel);
            
            channel.on = function(event, filter, callback) {
                const wrappedCallback = (payload) => {
                    log('Supabase realtime event:', event);
                    
                    // Call original
                    if (callback) callback(payload);
                    
                    // Dispatch our event after a delay
                    setTimeout(() => {
                        window.dispatchEvent(new CustomEvent('campistry-realtime-update', {
                            detail: { event, timestamp: Date.now() }
                        }));
                    }, 700);
                };
                
                return originalOn(event, filter, wrappedCallback);
            };
            
            return channel;
        };
        
        log('✅ Supabase channel patched');
    }

    // =========================================================================
    // INITIALIZATION: Run after RBAC is ready
    // =========================================================================
    
    const waitForRBAC = setInterval(() => {
        if (!window.AccessControl?.isInitialized) return;
        
        clearInterval(waitForRBAC);
        log('RBAC ready, performing initial hydration check');
        
        const dateKey = getCurrentDateKey();
        
        // Check if we need to hydrate
        if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
            log('Window globals empty after RBAC, hydrating...');
            forceHydrateFromLocalStorage(dateKey);
            ensureEmptyStateForUnscheduledDivisions();
            
            // Initialize MSS
            if (window.MultiSchedulerSystem?.initializeView) {
                window.MultiSchedulerSystem.initializeView(dateKey).then(() => {
                    window.MultiSchedulerSystem.applyBlockingToGrid?.();
                    if (window.updateTable) window.updateTable();
                });
            } else if (window.updateTable) {
                window.updateTable();
            }
        }
        
    }, 100);
    
    // Timeout after 15 seconds
    setTimeout(() => clearInterval(waitForRBAC), 15000);

    // Also check if cloud is already ready
    if (window.__CAMPISTRY_CLOUD_READY__) {
        log('Cloud already ready, running initial setup');
        setTimeout(() => {
            const dateKey = getCurrentDateKey();
            forceHydrateFromLocalStorage(dateKey);
            ensureEmptyStateForUnscheduledDivisions();
            if (window.updateTable) window.updateTable();
        }, 500);
    }

    // =========================================================================
    // DIAGNOSTIC & MANUAL FUNCTIONS
    // =========================================================================
    
    window.forceScheduleRefresh = function(dateKey) {
        dateKey = dateKey || getCurrentDateKey();
        log('Manual refresh triggered for:', dateKey);
        
        // Clear current state
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window._unifiedTimesFromCloud = false;
        
        // Hydrate and refresh
        forceHydrateFromLocalStorage(dateKey);
        ensureEmptyStateForUnscheduledDivisions();
        refreshMultiSchedulerView(dateKey);
        
        log('✅ Manual refresh complete');
    };

    window.diagnoseScheduleSync = function() {
        const dateKey = getCurrentDateKey();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('🔍 SCHEDULE SYNC DIAGNOSIS');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('');
        
        console.log('=== Window Globals ===');
        console.log('scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
        console.log('leagueAssignments divisions:', Object.keys(window.leagueAssignments || {}).length);
        console.log('unifiedTimes slots:', (window.unifiedTimes || []).length);
        console.log('_unifiedTimesFromCloud:', window._unifiedTimesFromCloud);
        console.log('');
        
        console.log('=== LocalStorage ===');
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            const daily = raw ? JSON.parse(raw) : {};
            const dateData = daily[dateKey] || {};
            console.log('Has dateData:', !!Object.keys(dateData).length);
            console.log('scheduleAssignments bunks:', Object.keys(dateData.scheduleAssignments || {}).length);
            console.log('leagueAssignments divisions:', Object.keys(dateData.leagueAssignments || {}).length);
            console.log('unifiedTimes slots:', (dateData.unifiedTimes || []).length);
        } catch (e) {
            console.log('Error reading localStorage:', e);
        }
        console.log('');
        
        console.log('=== Multi-Scheduler System ===');
        console.log('isInitialized:', window.MultiSchedulerSystem?.isInitialized?.());
        console.log('myDivisions:', JSON.stringify(window.MultiSchedulerSystem?.getMyDivisions?.()));
        const mssState = window.MultiSchedulerSystem?.getState?.();
        console.log('blockedMap divisions:', JSON.stringify([...(mssState?.blockedMap?.stats?.blockedDivisions || [])]));
        console.log('');
        
        console.log('=== Access Control ===');
        console.log('isInitialized:', window.AccessControl?.isInitialized);
        console.log('role:', window.AccessControl?.getCurrentRole?.());
        console.log('editableDivisions:', JSON.stringify(window.AccessControl?.getEditableDivisions?.()));
        console.log('');
        
        console.log('=== System State ===');
        console.log('__CAMPISTRY_CLOUD_READY__:', window.__CAMPISTRY_CLOUD_READY__);
        console.log('');
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('💡 Commands:');
        console.log('   forceScheduleRefresh() - Force full refresh');
        console.log('   window.MultiSchedulerSystem.refresh() - Refresh MSS');
        console.log('═══════════════════════════════════════════════════════');
    };

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ MASTER PATCH LOADED');
    console.log('   Run diagnoseScheduleSync() to check state');
    console.log('   Run forceScheduleRefresh() to manually refresh');
    console.log('═══════════════════════════════════════════════════════════════');

})();
