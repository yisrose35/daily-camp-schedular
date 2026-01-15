// =============================================================================
// CAMPISTRY MULTI-SCHEDULER SYNC MASTER PATCH v2.0
// =============================================================================
//
// v2.0 CHANGES:
// - FORCE overwrite window.scheduleAssignments after cloud hydration
// - Don't check if window is empty - always use localStorage after merge
// - Add more aggressive timing to ensure we run AFTER cloud bridge
//
// FIXES THREE CRITICAL ISSUES:
//
// ISSUE 1: Scheduler 2 doesn't see Scheduler 1's schedule until generating
// ISSUE 2: Scheduler 1 can't see Scheduler 2's updates without regenerating  
// ISSUE 3: Divisions without schedules show random data instead of empty
//
// INSTALLATION:
// Add this file AFTER all scheduling scripts (especially cloud_storage_bridge.js)
//
// =============================================================================

(function() {
    'use strict';

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🔧 CAMPISTRY MULTI-SCHEDULER SYNC MASTER PATCH v2.0');
    console.log('═══════════════════════════════════════════════════════════════');

    const DEBUG = true;
    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    // Track if we've done initial hydration after cloud merge
    let _initialHydrationDone = false;

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
    // FIX 1: FORCE HYDRATION - ALWAYS OVERWRITE FROM LOCALSTORAGE
    // =========================================================================
    // The key insight: After cloud merge, localStorage has correct data but
    // window.scheduleAssignments has OLD data. We must FORCE overwrite.

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
            
            // ═══════════════════════════════════════════════════════════════
            // CRITICAL CHANGE v2.0: ALWAYS overwrite if forceOverwrite is true
            // This ensures we use the cloud-merged data, not stale window data
            // ═══════════════════════════════════════════════════════════════
            
            let hydrated = false;
            
            // Hydrate scheduleAssignments
            if (dateData.scheduleAssignments) {
                const localBunkCount = Object.keys(dateData.scheduleAssignments).length;
                const windowBunkCount = Object.keys(window.scheduleAssignments || {}).length;
                
                if (forceOverwrite || localBunkCount > 0) {
                    // Check if data is actually different
                    const localFirst = Object.keys(dateData.scheduleAssignments)[0];
                    const windowFirst = Object.keys(window.scheduleAssignments || {})[0];
                    
                    if (forceOverwrite) {
                        log(`FORCE overwriting window.scheduleAssignments`);
                        log(`  localStorage has ${localBunkCount} bunks`);
                        log(`  window had ${windowBunkCount} bunks`);
                        window.scheduleAssignments = JSON.parse(JSON.stringify(dateData.scheduleAssignments));
                        hydrated = true;
                        log('✅ FORCE hydrated scheduleAssignments:', localBunkCount, 'bunks');
                    } else if (!window.scheduleAssignments || windowBunkCount === 0) {
                        window.scheduleAssignments = JSON.parse(JSON.stringify(dateData.scheduleAssignments));
                        hydrated = true;
                        log('✅ Hydrated scheduleAssignments:', localBunkCount, 'bunks');
                    } else {
                        log('ℹ️ window.scheduleAssignments already has data, use forceOverwrite to replace');
                    }
                }
            } else {
                window.scheduleAssignments = {};
                log('⚠️ No scheduleAssignments in localStorage for this date');
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
            
            // Hydrate unifiedTimes
            if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
                if (forceOverwrite || !window.unifiedTimes || window.unifiedTimes.length === 0) {
                    window.unifiedTimes = normalizeUnifiedTimes(dateData.unifiedTimes);
                    window._unifiedTimesFromCloud = true;
                    log('✅ Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
                    hydrated = true;
                }
            }
            
            return hydrated;
            
        } catch (e) {
            console.error('[SyncPatch] Hydration error:', e);
            return false;
        }
    }

    // =========================================================================
    // FIX 2: REFRESH MULTI-SCHEDULER VIEW
    // =========================================================================

    async function refreshMultiSchedulerView(dateKey, forceOverwrite = false) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('Refreshing Multi-Scheduler view for:', dateKey);
        
        // Step 1: Force hydrate from localStorage
        forceHydrateFromLocalStorage(dateKey, forceOverwrite);
        
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
            window.updateTable();
            log('✅ Table updated');
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
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            
            const hasData = bunks.some(bunk => {
                const bunkData = window.scheduleAssignments[bunk];
                if (!bunkData || !Array.isArray(bunkData)) return false;
                return bunkData.some(slot => slot && (slot.field || slot._activity));
            });
            
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
    // EVENT LISTENERS - WITH FORCE OVERWRITE
    // =========================================================================

    // After cloud hydration, FORCE hydrate window globals
    // This is the key fix - we MUST overwrite stale window data
    window.addEventListener('campistry-cloud-hydrated', (e) => {
        log('Cloud hydration event received - will FORCE hydrate');
        
        // Use longer timeout to ensure cloud bridge merge is 100% complete
        setTimeout(() => {
            const dateKey = getCurrentDateKey();
            
            // ═══════════════════════════════════════════════════════════════
            // v2.0: FORCE overwrite window.scheduleAssignments
            // Don't check if empty - always use localStorage after cloud merge
            // ═══════════════════════════════════════════════════════════════
            log('FORCE hydrating window globals from localStorage...');
            const hydrated = forceHydrateFromLocalStorage(dateKey, true); // true = force overwrite
            
            if (hydrated) {
                log('✅ Window globals updated from cloud-merged localStorage');
                ensureEmptyStateForUnscheduledDivisions();
                
                // Update table immediately
                if (window.updateTable) {
                    window.updateTable();
                }
            }
            
            _initialHydrationDone = true;
        }, 300); // 300ms should be after the 100ms in unified_schedule_system
    });

    // After date change, ensure proper hydration
    window.addEventListener('campistry-date-changed', (e) => {
        const dateKey = e.detail?.dateKey || getCurrentDateKey();
        log('Date changed to:', dateKey);
        
        // Clear and re-hydrate
        setTimeout(() => {
            forceHydrateFromLocalStorage(dateKey, true);
            ensureEmptyStateForUnscheduledDivisions();
            refreshMultiSchedulerView(dateKey, true);
        }, 100);
    });

    // Listen for realtime updates
    window.addEventListener('campistry-realtime-update', (e) => {
        log('Realtime update event received');
        refreshMultiSchedulerView(getCurrentDateKey(), true);
    });

    // =========================================================================
    // PATCH: loadScheduleForDate - After initial hydration, prefer localStorage
    // =========================================================================
    
    const originalLoadScheduleForDate = window.loadScheduleForDate;
    
    window.loadScheduleForDate = function(dateKey) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('loadScheduleForDate called for:', dateKey);
        
        // After initial cloud hydration, we should trust localStorage
        // because it contains the merged cloud data
        if (_initialHydrationDone) {
            log('Post-hydration: checking localStorage for updates...');
            // Don't force overwrite here - just fill if empty
            forceHydrateFromLocalStorage(dateKey, false);
        }
        
        // Call original
        if (originalLoadScheduleForDate && typeof originalLoadScheduleForDate === 'function') {
            const result = originalLoadScheduleForDate.call(this, dateKey);
            return result;
        }
        
        ensureEmptyStateForUnscheduledDivisions();
    };

    // =========================================================================
    // PATCH: RealtimeScheduleSync.load to dispatch event
    // =========================================================================
    
    if (window.RealtimeScheduleSync) {
        const originalLoad = window.RealtimeScheduleSync.load;
        
        window.RealtimeScheduleSync.load = async function() {
            log('RealtimeScheduleSync.load intercepted');
            
            const result = await originalLoad?.call(this);
            
            if (result?.success || result?.hasData) {
                // FORCE hydrate after realtime load
                const dateKey = getCurrentDateKey();
                log('Realtime load success, FORCE hydrating...');
                forceHydrateFromLocalStorage(dateKey, true);
                
                window.dispatchEvent(new CustomEvent('campistry-realtime-update', {
                    detail: { success: result?.success, hasData: result?.hasData }
                }));
            }
            
            return result;
        };
        
        log('✅ RealtimeScheduleSync.load patched');
    }

    // =========================================================================
    // PATCH: Supabase realtime channel
    // =========================================================================
    
    if (window.supabase?.channel) {
        const originalChannel = window.supabase.channel.bind(window.supabase);
        
        window.supabase.channel = function(name) {
            const channel = originalChannel(name);
            const originalOn = channel.on.bind(channel);
            
            channel.on = function(event, filter, callback) {
                const wrappedCallback = (payload) => {
                    log('Supabase realtime event:', event);
                    
                    if (callback) callback(payload);
                    
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
        log('RBAC ready, performing FORCE hydration');
        
        const dateKey = getCurrentDateKey();
        
        // ALWAYS force hydrate after RBAC init
        // This ensures we have the correct cloud data
        log('FORCE hydrating after RBAC init...');
        forceHydrateFromLocalStorage(dateKey, true);
        ensureEmptyStateForUnscheduledDivisions();
        
        // Initialize MSS
        if (window.MultiSchedulerSystem?.initializeView) {
            window.MultiSchedulerSystem.initializeView(dateKey).then(() => {
                window.MultiSchedulerSystem.applyBlockingToGrid?.();
                if (window.updateTable) window.updateTable();
                log('✅ Post-RBAC refresh complete');
            });
        } else if (window.updateTable) {
            window.updateTable();
        }
        
        _initialHydrationDone = true;
        
    }, 100);
    
    setTimeout(() => clearInterval(waitForRBAC), 15000);

    // =========================================================================
    // MANUAL FUNCTIONS
    // =========================================================================
    
    window.forceScheduleRefresh = function(dateKey) {
        dateKey = dateKey || getCurrentDateKey();
        log('Manual FORCE refresh for:', dateKey);
        
        // FORCE clear and reload
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window._unifiedTimesFromCloud = false;
        
        forceHydrateFromLocalStorage(dateKey, true);
        ensureEmptyStateForUnscheduledDivisions();
        refreshMultiSchedulerView(dateKey, true);
        
        log('✅ Manual refresh complete');
    };

    window.diagnoseScheduleSync = function() {
        const dateKey = getCurrentDateKey();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('🔍 SCHEDULE SYNC DIAGNOSIS v2.0');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date:', dateKey);
        console.log('Initial hydration done:', _initialHydrationDone);
        console.log('');
        
        console.log('=== Window Globals ===');
        const windowBunks = Object.keys(window.scheduleAssignments || {});
        console.log('scheduleAssignments bunks:', windowBunks.length);
        if (windowBunks.length > 0) {
            const firstBunk = windowBunks[0];
            const firstData = window.scheduleAssignments[firstBunk];
            console.log(`  First bunk "${firstBunk}": ${firstData?.length || 0} slots`);
            if (firstData) {
                const sample = firstData.find(s => s && s.field);
                if (sample) console.log(`  Sample slot: ${JSON.stringify(sample).substring(0, 100)}`);
            }
        }
        console.log('');
        
        console.log('=== LocalStorage ===');
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            const daily = raw ? JSON.parse(raw) : {};
            const dateData = daily[dateKey] || {};
            const localBunks = Object.keys(dateData.scheduleAssignments || {});
            console.log('scheduleAssignments bunks:', localBunks.length);
            if (localBunks.length > 0) {
                const firstBunk = localBunks[0];
                const firstData = dateData.scheduleAssignments[firstBunk];
                console.log(`  First bunk "${firstBunk}": ${firstData?.length || 0} slots`);
                if (firstData) {
                    const sample = firstData.find(s => s && s.field);
                    if (sample) console.log(`  Sample slot: ${JSON.stringify(sample).substring(0, 100)}`);
                }
            }
        } catch (e) {
            console.log('Error:', e);
        }
        console.log('');
        
        console.log('=== Comparison ===');
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            const daily = raw ? JSON.parse(raw) : {};
            const dateData = daily[dateKey] || {};
            
            const windowFirst = Object.keys(window.scheduleAssignments || {})[0];
            const localFirst = Object.keys(dateData.scheduleAssignments || {})[0];
            
            if (windowFirst && localFirst) {
                const windowSlot = window.scheduleAssignments[windowFirst]?.[1];
                const localSlot = dateData.scheduleAssignments[localFirst]?.[1];
                console.log('Window bunk 1 slot 1:', windowSlot?.field || windowSlot?._activity || 'empty');
                console.log('Local bunk 1 slot 1:', localSlot?.field || localSlot?._activity || 'empty');
                console.log('Match:', JSON.stringify(windowSlot) === JSON.stringify(localSlot) ? '✅ YES' : '❌ NO');
            }
        } catch(e) {
            console.log('Comparison error:', e);
        }
        console.log('');
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('💡 Commands:');
        console.log('   forceScheduleRefresh() - Force full refresh');
        console.log('═══════════════════════════════════════════════════════');
    };

    // =========================================================================
    // AGGRESSIVE FINAL CHECK
    // =========================================================================
    // As a last resort, check 2 seconds after load if data matches
    
    setTimeout(() => {
        log('Final data consistency check...');
        const dateKey = getCurrentDateKey();
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return;
            
            const daily = JSON.parse(raw);
            const dateData = daily[dateKey] || {};
            
            if (!dateData.scheduleAssignments) return;
            
            const localBunks = Object.keys(dateData.scheduleAssignments);
            const windowBunks = Object.keys(window.scheduleAssignments || {});
            
            // Check if first bunk's data matches
            if (localBunks.length > 0) {
                const firstBunk = localBunks[0];
                const localSlot1 = dateData.scheduleAssignments[firstBunk]?.[1];
                const windowSlot1 = window.scheduleAssignments?.[firstBunk]?.[1];
                
                const localField = localSlot1?.field || localSlot1?._activity;
                const windowField = windowSlot1?.field || windowSlot1?._activity;
                
                if (localField && localField !== windowField) {
                    log('⚠️ DATA MISMATCH DETECTED!');
                    log(`  Local: ${localField}`);
                    log(`  Window: ${windowField}`);
                    log('  Auto-correcting...');
                    
                    forceHydrateFromLocalStorage(dateKey, true);
                    if (window.updateTable) window.updateTable();
                    
                    log('✅ Auto-correction complete');
                } else {
                    log('✅ Data consistency verified');
                }
            }
        } catch (e) {
            console.error('[SyncPatch] Final check error:', e);
        }
    }, 2000);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ MASTER PATCH v2.0 LOADED');
    console.log('   - FORCE hydration enabled');
    console.log('   - Auto-correction at 2 seconds');
    console.log('   Run diagnoseScheduleSync() to check state');
    console.log('   Run forceScheduleRefresh() to manually refresh');
    console.log('═══════════════════════════════════════════════════════════════');

})();
