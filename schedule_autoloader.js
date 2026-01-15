// =============================================================================
// SCHEDULE CLOUD SYNC FIX v1.1
// =============================================================================
//
// FIXES TWO CRITICAL ISSUES:
//
// ISSUE 1: AutoLoader skips cloud fetch if localStorage has ANY data, even if
//          that data is stale or from a different session.
//
// ISSUE 2: ScheduleDB.saveSchedule() has DEBUG=false so we can't see if saves
//          are succeeding or failing.
//
// FIX: 
// - After cloud hydration, ALWAYS force a cloud fetch
// - Add verbose logging to track save operations
// - Patch ScheduleDB.saveSchedule to log results
//
// INSTALLATION: Add this file AFTER schedule_autoloader.js and supabase_schedules.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Schedule AutoLoader Cloud Fix v1.0 loading...');

    const DEBUG = true;
    const DAILY_DATA_KEY = 'campDailyData_v1';

    function log(...args) {
        if (DEBUG) console.log('[AutoLoaderFix]', ...args);
    }

    function getCurrentDateKey() {
        return window.currentScheduleDate || 
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('datepicker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    // =========================================================================
    // CORE FIX: Force cloud load and merge with local
    // =========================================================================

    async function forceCloudLoadAndMerge(dateKey) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log(`Force loading from cloud for: ${dateKey}`);

        // Check if ScheduleDB is available
        if (!window.ScheduleDB?.loadSchedule) {
            log('ScheduleDB not available, waiting...');
            return false;
        }

        try {
            // Call ScheduleDB.loadSchedule which queries daily_schedules table
            // and merges all scheduler records
            const result = await window.ScheduleDB.loadSchedule(dateKey);
            
            log('Cloud load result:', {
                success: result?.success,
                source: result?.source,
                recordCount: result?.recordCount,
                bunks: result?.data ? Object.keys(result.data.scheduleAssignments || {}).length : 0
            });

            if (result?.success && result.data) {
                const cloudData = result.data;
                
                // Hydrate window globals from cloud data
                if (cloudData.scheduleAssignments && Object.keys(cloudData.scheduleAssignments).length > 0) {
                    window.scheduleAssignments = cloudData.scheduleAssignments;
                    log(`✅ Hydrated scheduleAssignments: ${Object.keys(cloudData.scheduleAssignments).length} bunks`);
                }

                if (cloudData.leagueAssignments) {
                    window.leagueAssignments = cloudData.leagueAssignments;
                    log('✅ Hydrated leagueAssignments');
                }

                if (cloudData.unifiedTimes && cloudData.unifiedTimes.length > 0) {
                    // Normalize the times
                    window.unifiedTimes = cloudData.unifiedTimes.map(t => {
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
                    log(`✅ Hydrated unifiedTimes: ${window.unifiedTimes.length} slots`);
                }

                // Update localStorage to match cloud
                try {
                    const allData = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
                    allData[dateKey] = {
                        scheduleAssignments: window.scheduleAssignments,
                        leagueAssignments: window.leagueAssignments,
                        unifiedTimes: cloudData.unifiedTimes // Keep serialized form
                    };
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(allData));
                    log('✅ Updated localStorage with cloud data');
                } catch (e) {
                    log('Warning: Could not update localStorage:', e.message);
                }

                // Refresh the UI
                if (window.updateTable) {
                    window.updateTable();
                    log('✅ Table updated');
                }

                // Dispatch event
                window.dispatchEvent(new CustomEvent('campistry-cloud-schedule-loaded', {
                    detail: { dateKey, source: 'cloud-fix', recordCount: result.recordCount }
                }));

                return true;
            } else {
                log('No cloud data returned or load failed');
                return false;
            }

        } catch (e) {
            log('Error loading from cloud:', e);
            return false;
        }
    }

    // =========================================================================
    // HOOK: After cloud hydration, force schedule load
    // =========================================================================

    let _hasLoadedAfterHydration = false;

    window.addEventListener('campistry-cloud-hydrated', () => {
        if (_hasLoadedAfterHydration) return;
        _hasLoadedAfterHydration = true;

        log('Cloud hydration detected, forcing schedule load...');
        
        // Wait a bit for other systems to initialize
        setTimeout(async () => {
            const dateKey = getCurrentDateKey();
            await forceCloudLoadAndMerge(dateKey);
        }, 500);
    });

    // Also hook into integration ready
    window.addEventListener('campistry-integration-ready', () => {
        if (_hasLoadedAfterHydration) return;
        
        log('Integration ready, checking for cloud schedule...');
        
        setTimeout(async () => {
            const dateKey = getCurrentDateKey();
            const hasLocalData = window.scheduleAssignments && 
                                Object.keys(window.scheduleAssignments).length > 0;
            
            // Always try cloud to get latest merged data
            log(`Has local data: ${hasLocalData}, forcing cloud check anyway...`);
            await forceCloudLoadAndMerge(dateKey);
            
            _hasLoadedAfterHydration = true;
        }, 300);
    });

    // =========================================================================
    // MANUAL TRIGGER
    // =========================================================================

    window.forceLoadCloudSchedule = async function(dateKey) {
        return await forceCloudLoadAndMerge(dateKey || getCurrentDateKey());
    };

    // =========================================================================
    // DIAGNOSTIC
    // =========================================================================

    window.diagnoseScheduleCloudSync = async function() {
        const client = window.CampistryDB?.getClient?.() || window.supabase;
        const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
        const dateKey = getCurrentDateKey();

        console.log('='.repeat(60));
        console.log('SCHEDULE CLOUD SYNC DIAGNOSTIC');
        console.log('='.repeat(60));
        console.log('Camp ID:', campId);
        console.log('Date Key:', dateKey);
        console.log('');

        if (!client || !campId) {
            console.error('No Supabase client or camp ID');
            return;
        }

        try {
            // Query daily_schedules table
            const { data, error } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);

            if (error) {
                console.error('Query error:', error);
                return;
            }

            console.log('RECORDS IN daily_schedules TABLE:', data?.length || 0);

            if (data && data.length > 0) {
                data.forEach((record, i) => {
                    console.log(`\nRecord ${i + 1}:`);
                    console.log('  Scheduler ID:', record.scheduler_id);
                    console.log('  Scheduler Name:', record.scheduler_name);
                    console.log('  Divisions:', record.divisions);
                    console.log('  Updated:', record.updated_at);
                    console.log('  Bunks:', Object.keys(record.schedule_data?.scheduleAssignments || {}).length);
                });
            } else {
                console.log('\n⚠️ NO DATA IN daily_schedules TABLE!');
                console.log('The schedule was NOT saved to the cloud.');
            }

            console.log('\n--- Current Window State ---');
            console.log('window.scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
            console.log('window.unifiedTimes:', (window.unifiedTimes || []).length, 'slots');

            console.log('\n--- LocalStorage State ---');
            try {
                const raw = localStorage.getItem(DAILY_DATA_KEY);
                const allData = raw ? JSON.parse(raw) : {};
                const dateData = allData[dateKey];
                console.log(`localStorage[${dateKey}]:`, dateData ? 
                    `${Object.keys(dateData.scheduleAssignments || {}).length} bunks` : 
                    'NO DATA');
            } catch (e) {
                console.log('localStorage error:', e.message);
            }

        } catch (e) {
            console.error('Exception:', e);
        }
    };

    console.log('📅 Schedule Cloud Sync Fix v1.1 loaded');
    console.log('   Commands:');
    console.log('   - forceLoadCloudSchedule()      → Force load from cloud');
    console.log('   - diagnoseScheduleCloudSync()   → Check cloud/local state');

    // =========================================================================
    // PATCH: Add verbose logging to ScheduleDB.saveSchedule
    // =========================================================================

    const originalSaveSchedule = window.ScheduleDB?.saveSchedule;
    
    if (originalSaveSchedule && window.ScheduleDB) {
        window.ScheduleDB.saveSchedule = async function(dateKey, data, options = {}) {
            console.log('📅 [SaveTracker] saveSchedule called:', {
                dateKey,
                bunks: Object.keys(data?.scheduleAssignments || {}).length,
                slots: (data?.unifiedTimes || window.unifiedTimes || []).length
            });

            try {
                const result = await originalSaveSchedule.call(window.ScheduleDB, dateKey, data, options);
                
                console.log('📅 [SaveTracker] saveSchedule result:', {
                    success: result?.success,
                    target: result?.target,
                    error: result?.error,
                    bunks: result?.bunks
                });

                if (result?.success && result?.target === 'cloud') {
                    console.log('📅 [SaveTracker] ✅ Schedule saved to cloud successfully!');
                } else if (result?.target === 'local' || result?.target === 'local-fallback') {
                    console.warn('📅 [SaveTracker] ⚠️ Schedule saved to LOCAL only, not cloud');
                    console.warn('   Reason:', result?.error || 'No client/campId or cloud save failed');
                }

                return result;
            } catch (e) {
                console.error('📅 [SaveTracker] ❌ saveSchedule exception:', e);
                throw e;
            }
        };
        
        log('✅ Patched ScheduleDB.saveSchedule with verbose logging');
    } else {
        log('⚠️ ScheduleDB.saveSchedule not found yet, will retry...');
        
        // Retry after ScheduleDB initializes
        window.addEventListener('campistry-scheduledb-ready', () => {
            const saveSchedule = window.ScheduleDB?.saveSchedule;
            if (saveSchedule && !saveSchedule._patched) {
                const original = saveSchedule;
                window.ScheduleDB.saveSchedule = async function(dateKey, data, options = {}) {
                    console.log('📅 [SaveTracker] saveSchedule called:', {
                        dateKey,
                        bunks: Object.keys(data?.scheduleAssignments || {}).length
                    });
                    const result = await original.call(window.ScheduleDB, dateKey, data, options);
                    console.log('📅 [SaveTracker] saveSchedule result:', result);
                    return result;
                };
                window.ScheduleDB.saveSchedule._patched = true;
                console.log('📅 [SaveTracker] ✅ Late-patched ScheduleDB.saveSchedule');
            }
        });
    }

})();
