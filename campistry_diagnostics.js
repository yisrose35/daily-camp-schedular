// =============================================================================
// campistry_diagnostics.js v1.0 — COMPREHENSIVE DEBUG TOOL
// =============================================================================
//
// Run window.CampistryDiag.fullReport() in the browser console to get
// a complete diagnostic report of the current state.
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔍 Campistry Diagnostics v1.0 loading...');

    const DAILY_DATA_KEY = 'campDailyData_v1';

    // =========================================================================
    // DIAGNOSTIC FUNCTIONS
    // =========================================================================

    function getCurrentDateKey() {
        return window.currentScheduleDate || 
               window.ScheduleOrchestrator?.getCurrentDateKey?.() ||
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('datepicker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function getLocalStorageData(dateKey) {
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return null;
            const all = JSON.parse(raw);
            return dateKey ? all[dateKey] : all;
        } catch (e) {
            return { error: e.message };
        }
    }

    async function getCloudData(dateKey) {
        if (!window.ScheduleDB?.loadAllSchedulersForDate) {
            return { error: 'ScheduleDB not available' };
        }
        
        try {
            const records = await window.ScheduleDB.loadAllSchedulersForDate(dateKey);
            return records || [];
        } catch (e) {
            return { error: e.message };
        }
    }

    // =========================================================================
    // FULL REPORT
    // =========================================================================

    async function fullReport() {
        const dateKey = getCurrentDateKey();
        
        console.log('\n');
        console.log('╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║          🔍 CAMPISTRY DIAGNOSTIC REPORT v1.0                      ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝');
        console.log('Generated:', new Date().toISOString());
        console.log('Date Key:', dateKey);
        console.log('');

        // ─────────────────────────────────────────────────────────────────
        // SECTION 1: MODULES STATUS
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 1. MODULE STATUS                                                │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        
        const modules = {
            'CampistryDB': window.CampistryDB,
            'ScheduleDB': window.ScheduleDB,
            'ScheduleOrchestrator': window.ScheduleOrchestrator,
            'AccessControl': window.AccessControl,
            'PermissionsDB': window.PermissionsDB,
            'ScheduleSync': window.ScheduleSync,
            'UnifiedScheduleSystem': window.UnifiedScheduleSystem,
            'MultiSchedulerSystem': window.MultiSchedulerSystem
        };

        for (const [name, module] of Object.entries(modules)) {
            const status = module ? '✅ Loaded' : '❌ Missing';
            const version = module?.version || module?.VERSION || '';
            console.log(`  ${name}: ${status} ${version}`);
        }
        console.log('');

        // ─────────────────────────────────────────────────────────────────
        // SECTION 2: USER & PERMISSIONS
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 2. USER & PERMISSIONS                                           │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        
        console.log('  Camp ID:', window.CampistryDB?.getCampId?.() || 'unknown');
        console.log('  User ID:', window.CampistryDB?.getUserId?.() || 'unknown');
        console.log('  Role:', window.AccessControl?.getCurrentRole?.() || window.CampistryDB?.getRole?.() || 'unknown');
        console.log('  Is Team Member:', window.CampistryDB?.isTeamMember?.() || 'unknown');
        console.log('  Has Full Access:', window.PermissionsDB?.hasFullAccess?.() || 'unknown');
        
        const editableDivs = window.AccessControl?.getEditableDivisions?.() || 
                            window.PermissionsDB?.getEditableDivisions?.() || [];
        console.log('  Editable Divisions:', editableDivs.length ? editableDivs.join(', ') : 'none');
        
        const allDivs = Object.keys(window.divisions || {});
        console.log('  All Divisions:', allDivs.length ? allDivs.join(', ') : 'none');
        console.log('');

        // ─────────────────────────────────────────────────────────────────
        // SECTION 3: WINDOW GLOBALS
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 3. WINDOW GLOBALS                                               │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        
        const windowBunks = Object.keys(window.scheduleAssignments || {});
        console.log('  scheduleAssignments:', windowBunks.length, 'bunks');
        
        if (windowBunks.length > 0) {
            // Sample first bunk
            const firstBunk = windowBunks[0];
            const firstData = window.scheduleAssignments[firstBunk];
            console.log(`    First bunk "${firstBunk}":`, Array.isArray(firstData) ? `${firstData.length} slots` : typeof firstData);
            
            if (Array.isArray(firstData)) {
                const filledSlots = firstData.filter(s => s && (s.field || s._activity)).length;
                console.log(`    Filled slots: ${filledSlots}/${firstData.length}`);
            }
        }
        
        const leagueBunks = Object.keys(window.leagueAssignments || {});
        console.log('  leagueAssignments:', leagueBunks.length, 'bunks');
        
        console.log('  unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('  isRainyDay:', window.isRainyDay || false);
        console.log('');

        // ─────────────────────────────────────────────────────────────────
        // SECTION 4: LOCAL STORAGE
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 4. LOCAL STORAGE                                                │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        
        const localData = getLocalStorageData(dateKey);
        
        if (localData?.error) {
            console.log('  ❌ Error:', localData.error);
        } else if (!localData) {
            console.log('  No data for', dateKey);
        } else {
            const localBunks = Object.keys(localData.scheduleAssignments || {});
            console.log('  scheduleAssignments:', localBunks.length, 'bunks');
            console.log('  leagueAssignments:', Object.keys(localData.leagueAssignments || {}).length, 'bunks');
            console.log('  unifiedTimes:', (localData.unifiedTimes || []).length, 'slots');
            console.log('  Updated at:', localData._updatedAt || 'unknown');
        }
        
        // Show all dates in localStorage
        const allLocalData = getLocalStorageData();
        if (allLocalData && !allLocalData.error) {
            const dates = Object.keys(allLocalData);
            console.log('  All dates in localStorage:', dates.length);
            if (dates.length > 0 && dates.length <= 10) {
                dates.forEach(d => {
                    const bunks = Object.keys(allLocalData[d]?.scheduleAssignments || {}).length;
                    console.log(`    ${d}: ${bunks} bunks`);
                });
            }
        }
        console.log('');

        // ─────────────────────────────────────────────────────────────────
        // SECTION 5: CLOUD DATA
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 5. CLOUD DATA (daily_schedules table)                           │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        
        const cloudData = await getCloudData(dateKey);
        
        if (cloudData?.error) {
            console.log('  ❌ Error:', cloudData.error);
        } else if (!cloudData || cloudData.length === 0) {
            console.log('  No records for', dateKey);
        } else {
            console.log('  Records found:', cloudData.length);
            console.log('');
            
            cloudData.forEach((record, idx) => {
                const scheduleData = record.schedule_data || {};
                const bunks = Object.keys(scheduleData.scheduleAssignments || {});
                
                console.log(`  Record #${idx + 1}:`);
                console.log(`    ID: ${record.id}`);
                console.log(`    Scheduler: ${record.scheduler_name || 'unknown'} (${record.scheduler_id?.substring(0, 8)}...)`);
                console.log(`    Divisions: ${(record.divisions || []).join(', ') || 'none'}`);
                console.log(`    Bunks: ${bunks.length}`);
                if (bunks.length > 0 && bunks.length <= 10) {
                    console.log(`    Bunk list: ${bunks.join(', ')}`);
                }
                console.log(`    Updated: ${record.updated_at}`);
                console.log('');
            });

            // Check for overlapping bunks (potential issue)
            const allBunkMap = new Map();
            cloudData.forEach(record => {
                const bunks = Object.keys(record.schedule_data?.scheduleAssignments || {});
                bunks.forEach(bunk => {
                    if (!allBunkMap.has(bunk)) {
                        allBunkMap.set(bunk, []);
                    }
                    allBunkMap.get(bunk).push(record.scheduler_name || record.scheduler_id);
                });
            });

            const duplicates = [];
            allBunkMap.forEach((schedulers, bunk) => {
                if (schedulers.length > 1) {
                    duplicates.push({ bunk, schedulers });
                }
            });

            if (duplicates.length > 0) {
                console.log('  ⚠️ DUPLICATE BUNKS FOUND (same bunk in multiple records):');
                duplicates.forEach(d => {
                    console.log(`    ${d.bunk}: owned by ${d.schedulers.join(', ')}`);
                });
                console.log('');
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // SECTION 6: DATA CONSISTENCY CHECK
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 6. DATA CONSISTENCY CHECK                                       │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        
        const windowBunkCount = Object.keys(window.scheduleAssignments || {}).length;
        const localBunkCount = localData ? Object.keys(localData.scheduleAssignments || {}).length : 0;
        
        // Merge cloud bunks
        let cloudBunkCount = 0;
        if (Array.isArray(cloudData)) {
            const cloudBunks = new Set();
            cloudData.forEach(record => {
                Object.keys(record.schedule_data?.scheduleAssignments || {}).forEach(b => cloudBunks.add(b));
            });
            cloudBunkCount = cloudBunks.size;
        }

        console.log('  Bunk counts:');
        console.log(`    Window globals: ${windowBunkCount}`);
        console.log(`    LocalStorage:   ${localBunkCount}`);
        console.log(`    Cloud (merged): ${cloudBunkCount}`);
        
        if (windowBunkCount === localBunkCount && localBunkCount === cloudBunkCount) {
            console.log('  ✅ All sources have consistent bunk counts');
        } else {
            console.log('  ⚠️ INCONSISTENCY DETECTED - bunk counts differ between sources');
            
            if (cloudBunkCount > windowBunkCount) {
                console.log('  💡 Suggestion: Cloud has more data. Run window.ScheduleOrchestrator.loadSchedule() to refresh.');
            } else if (windowBunkCount > cloudBunkCount) {
                console.log('  💡 Suggestion: Window has unsaved data. Run window.ScheduleOrchestrator.saveSchedule() to persist.');
            }
        }
        console.log('');

        // ─────────────────────────────────────────────────────────────────
        // SECTION 7: QUICK ACTIONS
        // ─────────────────────────────────────────────────────────────────
        
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 7. QUICK ACTIONS (copy/paste these commands)                    │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        console.log('');
        console.log('  // Force reload from cloud:');
        console.log('  await window.ScheduleOrchestrator.loadSchedule()');
        console.log('');
        console.log('  // Force save to cloud:');
        console.log('  await window.ScheduleOrchestrator.saveSchedule(null, null, {immediate: true})');
        console.log('');
        console.log('  // Delete my schedule (scheduler):');
        console.log('  await window.ScheduleOrchestrator.deleteSchedule()');
        console.log('');
        console.log('  // Delete all schedules (owner/admin):');
        console.log('  await window.ScheduleOrchestrator.deleteSchedule(null, {deleteAll: true})');
        console.log('');
        console.log('  // Refresh UI:');
        console.log('  window.updateTable?.()');
        console.log('');
        console.log('╚═══════════════════════════════════════════════════════════════════╝');
        console.log('');

        return {
            dateKey,
            windowBunks: windowBunkCount,
            localBunks: localBunkCount,
            cloudBunks: cloudBunkCount,
            cloudRecords: Array.isArray(cloudData) ? cloudData.length : 0,
            consistent: windowBunkCount === localBunkCount && localBunkCount === cloudBunkCount
        };
    }

    // =========================================================================
    // QUICK CHECKS
    // =========================================================================

    function checkBunkOwnership(bunkId) {
        const dateKey = getCurrentDateKey();
        
        console.log(`\n🔍 Checking ownership for bunk: ${bunkId}\n`);
        
        // Window
        const inWindow = window.scheduleAssignments?.[bunkId];
        console.log('In window.scheduleAssignments:', !!inWindow);
        
        // localStorage
        const localData = getLocalStorageData(dateKey);
        const inLocal = localData?.scheduleAssignments?.[bunkId];
        console.log('In localStorage:', !!inLocal);
        
        // Which division?
        const divisions = window.divisions || {};
        let owningDivision = null;
        
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks?.includes(bunkId)) {
                owningDivision = divName;
                break;
            }
        }
        
        console.log('Division:', owningDivision || 'not found');
        
        // Is it in my editable divisions?
        const myDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        const canEdit = owningDivision && myDivisions.includes(owningDivision);
        console.log('Can I edit this bunk:', canEdit);
        
        return { bunkId, inWindow: !!inWindow, inLocal: !!inLocal, division: owningDivision, canEdit };
    }

    async function checkCloudRecordForBunk(bunkId) {
        const dateKey = getCurrentDateKey();
        const cloudData = await getCloudData(dateKey);
        
        console.log(`\n🔍 Checking cloud records for bunk: ${bunkId}\n`);
        
        if (!Array.isArray(cloudData)) {
            console.log('Could not load cloud data');
            return;
        }
        
        const recordsWithBunk = cloudData.filter(record => {
            return record.schedule_data?.scheduleAssignments?.[bunkId] !== undefined;
        });
        
        if (recordsWithBunk.length === 0) {
            console.log('Bunk not found in any cloud record');
        } else {
            console.log(`Found in ${recordsWithBunk.length} record(s):`);
            recordsWithBunk.forEach(record => {
                console.log(`  - ${record.scheduler_name || 'unknown'} (${record.scheduler_id?.substring(0, 8)}...)`);
            });
        }
        
        return recordsWithBunk;
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.CampistryDiag = {
        fullReport,
        checkBunkOwnership,
        checkCloudRecordForBunk,
        getLocalStorageData,
        getCloudData,
        getCurrentDateKey
    };

    console.log('🔍 Campistry Diagnostics v1.0 loaded. Run window.CampistryDiag.fullReport() for full diagnostics.');

})();
