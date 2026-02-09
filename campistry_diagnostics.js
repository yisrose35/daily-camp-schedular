// =============================================================================
// campistry_diagnostics.js v2.0 — COMPREHENSIVE EXPO AUDIT SUITE
// =============================================================================
//
// REPLACES v1.0. Run window.CampistryDiag.expoAudit() for full pre-expo check.
//
// AUDIT CATEGORIES:
//   1.  Module Loading — every JS module expected on the page
//   2.  Auth & RBAC — session, role, permissions, boundaries
//   3.  Data Integrity — divisions, bunks, fields, activities, leagues
//   4.  Cloud Sync — Supabase connection, read/write, realtime
//   5.  Schedule Pipeline — skeleton → divisionTimes → solver → assignments
//   6.  Tab Init Functions — every sidebar tab can initialize without error
//   7.  UI/DOM Integrity — critical elements exist, no orphaned listeners
//   8.  Post-Edit System — edit modal, conflict resolution, pinned preservation
//   9.  Rainy Day System — activation, field filtering, skeleton swap, mid-day
//  10.  Print & Output — print center, camper locator, validator, report
//  11.  Demo Mode — offline readiness, mock Supabase, fetch interception
//  12.  Cross-Division — field locks, capacity, sharing rules
//  13.  Performance — localStorage size, memory, event listener count
//  14.  Console Error Trap — captures errors during audit
//
// USAGE:
//   window.CampistryDiag.expoAudit()          — Full audit (all 14 categories)
//   window.CampistryDiag.quickCheck()          — Fast 30-second check (critical only)
//   window.CampistryDiag.auditCategory(n)      — Run single category (1-14)
//   window.CampistryDiag.stressTest()          — Generate + validate + edit cycle
//   window.CampistryDiag.tabWalkthrough()      — Auto-switch every tab & check init
//   window.CampistryDiag.fullReport()          — Legacy v1.0 report (preserved)
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔍 Campistry Diagnostics v2.0 (Expo Audit Suite) loading...');

    const DAILY_DATA_KEY = 'campDailyData_v1';
    const VERSION = '2.0';

    // =========================================================================
    // AUDIT RESULT COLLECTOR
    // =========================================================================

    let _auditResults = { pass: 0, fail: 0, warn: 0, skip: 0, details: [] };
    let _capturedErrors = [];
    let _originalConsoleError = null;

    function resetResults() {
        _auditResults = { pass: 0, fail: 0, warn: 0, skip: 0, details: [] };
        _capturedErrors = [];
    }

    function pass(category, test, detail) {
        _auditResults.pass++;
        _auditResults.details.push({ status: '✅', category, test, detail });
    }

    function fail(category, test, detail) {
        _auditResults.fail++;
        _auditResults.details.push({ status: '❌', category, test, detail });
    }

    function warn(category, test, detail) {
        _auditResults.warn++;
        _auditResults.details.push({ status: '⚠️', category, test, detail });
    }

    function skip(category, test, detail) {
        _auditResults.skip++;
        _auditResults.details.push({ status: '⏭️', category, test, detail });
    }

    function startErrorCapture() {
        _capturedErrors = [];
        _originalConsoleError = console.error;
        console.error = function() {
            _capturedErrors.push(Array.from(arguments).join(' '));
            _originalConsoleError.apply(console, arguments);
        };
    }

    function stopErrorCapture() {
        if (_originalConsoleError) {
            console.error = _originalConsoleError;
            _originalConsoleError = null;
        }
        return _capturedErrors;
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function getCurrentDateKey() {
        return window.currentScheduleDate ||
               window.ScheduleOrchestrator?.getCurrentDateKey?.() ||
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('calendar-date-picker')?.value ||
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

    function safeCall(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    function getSettings() {
        return safeCall(() => window.loadGlobalSettings?.() || {}, {});
    }

    // =========================================================================
    // CATEGORY 1: MODULE LOADING
    // =========================================================================

    function auditModuleLoading() {
        const CAT = '1. Modules';

        // Core infrastructure modules
        const coreModules = {
            'supabase (CDN/Client)':        () => !!window.supabase,
            'CampistryDB':                  () => !!window.CampistryDB,
            'CampistrySecurity':            () => !!window.CampistrySecurity,
            'AccessControl':                () => !!window.AccessControl,
            'PermissionsGuard':             () => !!window.PermissionsGuard,
        };

        // Cloud & sync modules
        const cloudModules = {
            'ScheduleDB':                   () => !!window.ScheduleDB,
            'ScheduleSync':                 () => !!window.ScheduleSync,
            'ScheduleOrchestrator':         () => !!window.ScheduleOrchestrator,
            'CloudSyncHelpers':             () => !!window.forceSyncToCloud,
        };

        // Scheduler core modules
        const schedulerModules = {
            'SchedulerCoreUtils':           () => !!window.SchedulerCoreUtils,
            'RotationEngine':               () => !!window.RotationEngine,
            'totalSolverEngine':            () => !!window.totalSolverEngine,
            'GlobalFieldLocks':             () => !!window.GlobalFieldLocks,
            'DivisionTimesSystem':          () => !!window.DivisionTimesSystem,
            'runSkeletonOptimizer':         () => typeof window.runSkeletonOptimizer === 'function',
            'SchedulerCoreLeagues':         () => !!window.SchedulerCoreLeagues,
            'SchedulerCoreSpecialtyLeagues':() => !!window.SchedulerCoreSpecialtyLeagues,
            'SchedulerLogicFillers':        () => !!(window.findBestSportActivity || window.findBestGeneralActivity),
        };

        // UI & system modules
        const uiModules = {
            'UnifiedScheduleSystem':        () => !!window.UnifiedScheduleSystem,
            'PostEditSystem':               () => !!(window.openPostEditModal || window.PostEditSystem),
            'PinnedActivityPreservation':    () => !!(window.capturePinnedActivities || window.PinnedPreservation),
            'RainyDayManager':              () => !!(window.activateRainyDayMode || window.RainyDayManager),
            'SubdivisionScheduleManager':   () => !!window.SubdivisionScheduleManager,
        };

        // Tab init functions
        const tabInits = {
            'initApp1 (Setup)':             () => typeof window.initApp1 === 'function',
            'initLocationsTab':             () => typeof window.initLocationsTab === 'function',
            'initFieldsTab':                () => typeof window.initFieldsTab === 'function',
            'initSpecialActivitiesTab':     () => typeof window.initSpecialActivitiesTab === 'function',
            'initLeagues':                  () => typeof window.initLeagues === 'function',
            'initSpecialtyLeagues':         () => typeof window.initSpecialtyLeagues === 'function',
            'initMasterScheduler':          () => typeof window.initMasterScheduler === 'function',
            'initDailyAdjustments':         () => typeof window.initDailyAdjustments === 'function',
            'updateTable (Schedule View)':  () => typeof window.updateTable === 'function',
            'initCamperLocator':            () => typeof window.initCamperLocator === 'function',
            'initReportTab':                () => typeof window.initReportTab === 'function',
            'initPrintCenter':              () => typeof window.initPrintCenter === 'function',
            'initUpdatesTab':               () => typeof window.initUpdatesTab === 'function',
            'initHelperTab':                () => typeof window.initHelperTab === 'function',
        };

        // Utility functions
        const utilFunctions = {
            'loadGlobalSettings':           () => typeof window.loadGlobalSettings === 'function',
            'saveGlobalSettings':           () => typeof window.saveGlobalSettings === 'function',
            'loadCurrentDailyData':         () => typeof window.loadCurrentDailyData === 'function',
            'saveCurrentDailyData':         () => typeof window.saveCurrentDailyData === 'function',
            'escapeHtml':                   () => typeof window.escapeHtml === 'function',
            'refreshGlobalRegistry':        () => typeof window.refreshGlobalRegistry === 'function',
            'validateSchedule':             () => typeof window.validateSchedule === 'function',
            'bootApp':                      () => typeof window.bootApp === 'function',
            'initCalendar':                 () => typeof window.initCalendar === 'function',
        };

        const allGroups = [
            ['Core Infrastructure', coreModules],
            ['Cloud & Sync', cloudModules],
            ['Scheduler Core', schedulerModules],
            ['UI & Systems', uiModules],
            ['Tab Init Functions', tabInits],
            ['Utility Functions', utilFunctions],
        ];

        for (const [groupName, modules] of allGroups) {
            for (const [name, check] of Object.entries(modules)) {
                try {
                    if (check()) {
                        pass(CAT, `${groupName}: ${name}`, 'Loaded');
                    } else {
                        fail(CAT, `${groupName}: ${name}`, 'NOT LOADED');
                    }
                } catch (e) {
                    fail(CAT, `${groupName}: ${name}`, 'Error checking: ' + e.message);
                }
            }
        }
    }

    // =========================================================================
    // CATEGORY 2: AUTH & RBAC
    // =========================================================================

    async function auditAuthRBAC() {
        const CAT = '2. Auth & RBAC';

        // Supabase session
        if (window.__CAMPISTRY_DEMO_MODE__) {
            pass(CAT, 'Demo Mode Active', 'Supabase is mocked — skipping session check');
        } else if (window.supabase) {
            try {
                const { data: { session }, error } = await window.supabase.auth.getSession();
                if (session) {
                    pass(CAT, 'Supabase Session', `User: ${session.user?.email}`);
                } else {
                    fail(CAT, 'Supabase Session', 'No active session — user not logged in');
                }
                if (error) warn(CAT, 'Session Error', error.message);
            } catch (e) {
                fail(CAT, 'Supabase Session', 'Exception: ' + e.message);
            }
        } else {
            fail(CAT, 'Supabase Client', 'window.supabase is not available');
        }

        // AccessControl initialization
        if (window.AccessControl) {
            const role = window.AccessControl.getCurrentRole?.();
            const campId = window.AccessControl.getCampId?.();
            const editable = window.AccessControl.getEditableDivisions?.() || [];
            const allDivs = Object.keys(window.divisions || {});

            if (role) {
                pass(CAT, 'Role Resolved', role);
            } else {
                fail(CAT, 'Role Resolved', 'No role — AccessControl may not have initialized');
            }

            if (campId) {
                pass(CAT, 'Camp ID', campId.substring(0, 12) + '...');
            } else {
                warn(CAT, 'Camp ID', 'Not set');
            }

            if (role === 'owner' || role === 'admin') {
                if (editable.length === allDivs.length || allDivs.length === 0) {
                    pass(CAT, 'Full Access', `${role} has access to all ${allDivs.length} divisions`);
                } else {
                    warn(CAT, 'Full Access', `${role} only has ${editable.length}/${allDivs.length} divisions`);
                }
            } else if (role === 'scheduler') {
                if (editable.length > 0) {
                    pass(CAT, 'Scheduler Divisions', `Access to: ${editable.join(', ')}`);
                } else {
                    fail(CAT, 'Scheduler Divisions', 'Scheduler has 0 editable divisions');
                }
            } else if (role === 'viewer') {
                pass(CAT, 'Viewer Role', 'Read-only mode');
            }

            // Session cache check
            try {
                const cache = JSON.parse(sessionStorage.getItem('campistry_rbac_cache') || 'null');
                if (cache && cache.role) {
                    pass(CAT, 'RBAC Session Cache', `Cached role: ${cache.role}, age: ${Math.round((Date.now() - cache.cachedAt) / 1000)}s`);
                } else {
                    warn(CAT, 'RBAC Session Cache', 'Not cached — Flow/Me page transitions may have white screen');
                }
            } catch (e) {
                warn(CAT, 'RBAC Session Cache', 'Parse error');
            }
        } else {
            fail(CAT, 'AccessControl Module', 'Not loaded');
        }

        // Security firewall
        if (window.CampistrySecurity?.isInitialized?.()) {
            pass(CAT, 'Security Firewall', 'Active');
            const log = window.CampistrySecurity.getSecurityLog?.() || [];
            if (log.length > 0) {
                warn(CAT, 'Security Events', `${log.length} event(s) logged — review with CampistrySecurity.getSecurityLog()`);
            } else {
                pass(CAT, 'Security Events', 'Clean — no events');
            }
        } else {
            warn(CAT, 'Security Firewall', 'Not initialized');
        }
    }

    // =========================================================================
    // CATEGORY 3: DATA INTEGRITY
    // =========================================================================

    function auditDataIntegrity() {
        const CAT = '3. Data Integrity';
        const settings = getSettings();
        const app1 = settings.app1 || {};

        // Divisions
        const divisions = window.divisions || {};
        const divKeys = Object.keys(divisions);
        if (divKeys.length > 0) {
            pass(CAT, 'Divisions', `${divKeys.length} divisions: ${divKeys.join(', ')}`);

            let totalBunks = 0;
            let emptyDivs = [];
            for (const [name, data] of Object.entries(divisions)) {
                const bunks = data.bunks || [];
                totalBunks += bunks.length;
                if (bunks.length === 0) emptyDivs.push(name);
            }

            if (totalBunks > 0) {
                pass(CAT, 'Bunks', `${totalBunks} bunks across ${divKeys.length} divisions`);
            } else {
                fail(CAT, 'Bunks', 'No bunks defined in any division');
            }

            if (emptyDivs.length > 0) {
                warn(CAT, 'Empty Divisions', `${emptyDivs.join(', ')} have 0 bunks`);
            }
        } else {
            fail(CAT, 'Divisions', 'No divisions loaded in window.divisions');
        }

        // Fields
        const fields = app1.fields || settings.fields || [];
        if (fields.length > 0) {
            pass(CAT, 'Fields', `${fields.length} fields defined`);

            // Validate field structure
            let fieldIssues = 0;
            fields.forEach(f => {
                if (!f.name) fieldIssues++;
                if (!f.sharableWith || !f.sharableWith.type) fieldIssues++;
            });
            if (fieldIssues > 0) {
                warn(CAT, 'Field Structure', `${fieldIssues} field(s) have missing name or sharableWith.type`);
            } else {
                pass(CAT, 'Field Structure', 'All fields have valid name and sharing config');
            }

            // Check for rainy day configured fields
            const rainyFields = fields.filter(f => f.rainyDayAvailable === true);
            const outdoorFields = fields.filter(f => f.rainyDayAvailable !== true);
            pass(CAT, 'Rainy Day Fields', `${rainyFields.length} indoor/available, ${outdoorFields.length} outdoor-only`);
        } else {
            fail(CAT, 'Fields', 'No fields defined');
        }

        // Special Activities
        const specials = app1.specialActivities || [];
        if (specials.length > 0) {
            pass(CAT, 'Special Activities', `${specials.length} defined`);

            let missingType = specials.filter(s => s.type !== 'Special').length;
            if (missingType > 0) {
                warn(CAT, 'Special Activity Type', `${missingType} activity/activities missing type:'Special' — scheduler may filter them out`);
            } else {
                pass(CAT, 'Special Activity Type', 'All have type:Special');
            }
        } else {
            warn(CAT, 'Special Activities', 'None defined');
        }

        // activityProperties registry
        const actProps = window.activityProperties || {};
        const propCount = Object.keys(actProps).length;
        if (propCount > 0) {
            pass(CAT, 'Activity Properties Registry', `${propCount} entries`);
        } else {
            warn(CAT, 'Activity Properties Registry', 'Empty — run refreshGlobalRegistry() or switch to Fields tab');
        }

        // Leagues
        const leagues = safeCall(() => {
            const g = getSettings();
            return g.app1?.leagues || g.leagues || [];
        }, []);

        if (leagues.length > 0) {
            pass(CAT, 'Leagues', `${leagues.length} league(s) configured`);
        } else {
            skip(CAT, 'Leagues', 'None configured (optional)');
        }

        // Specialty Leagues
        const specLeagues = safeCall(() => {
            return Object.keys(window.specialtyLeagues || {}).length;
        }, 0);

        if (specLeagues > 0) {
            pass(CAT, 'Specialty Leagues', `${specLeagues} configured`);
        } else {
            skip(CAT, 'Specialty Leagues', 'None configured (optional)');
        }

        // Skeletons
        const savedSkeletons = app1.savedSkeletons || {};
        const skelCount = Object.keys(savedSkeletons).length;
        if (skelCount > 0) {
            pass(CAT, 'Saved Skeletons', `${skelCount} template(s): ${Object.keys(savedSkeletons).join(', ')}`);
        } else {
            warn(CAT, 'Saved Skeletons', 'No skeleton templates saved — needed for scheduling');
        }

        // Current day's skeleton
        const dateKey = getCurrentDateKey();
        const dailyData = safeCall(() => window.loadCurrentDailyData?.() || {}, {});
        const currentSkeleton = dailyData.manualSkeleton || [];
        if (currentSkeleton.length > 0) {
            pass(CAT, `Today's Skeleton (${dateKey})`, `${currentSkeleton.length} blocks loaded`);
        } else {
            warn(CAT, `Today's Skeleton (${dateKey})`, 'No skeleton for today — load one in Daily Adjustments');
        }

        // Location Zones
        const zones = safeCall(() => {
            const g = getSettings();
            return g.app1?.locationZones || g.locationZones || {};
        }, {});
        const zoneCount = Object.keys(zones).length;
        if (zoneCount > 0) {
            pass(CAT, 'Location Zones', `${zoneCount} zone(s)`);
        } else {
            skip(CAT, 'Location Zones', 'None configured (optional)');
        }

        // globalBunks consistency
        const globalBunks = window.globalBunks || [];
        const divisionBunks = [];
        for (const data of Object.values(divisions)) {
            (data.bunks || []).forEach(b => divisionBunks.push(b));
        }
        if (globalBunks.length === divisionBunks.length) {
            pass(CAT, 'globalBunks Consistency', `${globalBunks.length} bunks match divisions`);
        } else {
            warn(CAT, 'globalBunks Consistency', `globalBunks has ${globalBunks.length} but divisions have ${divisionBunks.length} — may need refreshGlobalRegistry()`);
        }
    }

    // =========================================================================
    // CATEGORY 4: CLOUD SYNC
    // =========================================================================

    async function auditCloudSync() {
        const CAT = '4. Cloud Sync';

        if (window.__CAMPISTRY_DEMO_MODE__) {
            pass(CAT, 'Demo Mode', 'All cloud operations are mocked — offline safe');
            skip(CAT, 'Cloud Read/Write', 'Skipped in demo mode');
            return;
        }

        // ScheduleDB
        if (window.ScheduleDB) {
            pass(CAT, 'ScheduleDB', 'Available');

            // Try loading current date
            const dateKey = getCurrentDateKey();
            try {
                const result = await window.ScheduleDB.loadSchedule(dateKey);
                if (result?.success) {
                    const bunks = Object.keys(result.data?.scheduleAssignments || {}).length;
                    pass(CAT, 'Cloud Read', `Loaded ${dateKey}: ${bunks} bunks, source: ${result.source || 'unknown'}`);
                } else {
                    warn(CAT, 'Cloud Read', `Load returned success=false for ${dateKey}`);
                }
            } catch (e) {
                fail(CAT, 'Cloud Read', `Exception: ${e.message}`);
            }
        } else {
            fail(CAT, 'ScheduleDB', 'Not available');
        }

        // ScheduleOrchestrator
        if (window.ScheduleOrchestrator?.isInitialized) {
            pass(CAT, 'ScheduleOrchestrator', `Initialized, v${window.ScheduleOrchestrator.version || '?'}`);
        } else {
            warn(CAT, 'ScheduleOrchestrator', 'Not initialized');
        }

        // Realtime subscription
        if (window.ScheduleSync) {
            pass(CAT, 'ScheduleSync Module', 'Available');
        } else {
            warn(CAT, 'ScheduleSync Module', 'Not loaded — realtime updates won\'t work');
        }

        // Cloud sync helpers
        if (typeof window.forceSyncToCloud === 'function') {
            pass(CAT, 'forceSyncToCloud', 'Available');
        } else {
            warn(CAT, 'forceSyncToCloud', 'Not available');
        }

        // Check saveGlobalSettings cloud path
        if (typeof window.saveGlobalSettings === 'function') {
            pass(CAT, 'saveGlobalSettings', 'Available (cloud-backed)');
        } else {
            fail(CAT, 'saveGlobalSettings', 'Missing — data won\'t persist to cloud');
        }
    }

    // =========================================================================
    // CATEGORY 5: SCHEDULE PIPELINE
    // =========================================================================

    function auditSchedulePipeline() {
        const CAT = '5. Schedule Pipeline';
        const dateKey = getCurrentDateKey();

        // divisionTimes
        const dt = window.divisionTimes || {};
        const dtDivs = Object.keys(dt);
        if (dtDivs.length > 0) {
            let totalSlots = 0;
            const breakdown = [];
            dtDivs.forEach(d => {
                const count = (dt[d] || []).length;
                totalSlots += count;
                breakdown.push(`${d}:${count}`);
            });
            pass(CAT, 'divisionTimes', `${dtDivs.length} divisions, ${totalSlots} total slots [${breakdown.join(', ')}]`);
        } else {
            warn(CAT, 'divisionTimes', 'Empty — no schedule has been generated yet (this is OK before first generation)');
        }

        // scheduleAssignments
        const assignments = window.scheduleAssignments || {};
        const assignedBunks = Object.keys(assignments);
        if (assignedBunks.length > 0) {
            let filledSlots = 0;
            let emptySlots = 0;
            let freeSlots = 0;
            let transitionSlots = 0;

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                for (const slot of slots) {
                    if (!slot) { emptySlots++; continue; }
                    const act = (slot._activity || slot.field || '').toLowerCase();
                    if (act === 'free' || act === 'free (timeout)') freeSlots++;
                    else if (act === 'transition/buffer' || slot._isTransition) transitionSlots++;
                    else filledSlots++;
                }
            }

            pass(CAT, 'scheduleAssignments', `${assignedBunks.length} bunks`);
            pass(CAT, 'Slot Breakdown', `${filledSlots} filled, ${freeSlots} free, ${transitionSlots} transitions, ${emptySlots} empty`);

            if (freeSlots > filledSlots && filledSlots > 0) {
                warn(CAT, 'Free Slot Ratio', `More free slots (${freeSlots}) than filled (${filledSlots}) — solver may have struggled`);
            }
        } else {
            skip(CAT, 'scheduleAssignments', 'No schedule generated yet');
        }

        // leagueAssignments
        const leagues = window.leagueAssignments || {};
        const leagueBunks = Object.keys(leagues);
        if (leagueBunks.length > 0) {
            let matchupCount = 0;
            for (const data of Object.values(leagues)) {
                for (const slotData of Object.values(data || {})) {
                    if (slotData?.matchups?.length) matchupCount += slotData.matchups.length;
                }
            }
            pass(CAT, 'leagueAssignments', `${leagueBunks.length} bunks with ${matchupCount} matchups`);
        } else {
            skip(CAT, 'leagueAssignments', 'No league games scheduled');
        }

        // Bunk ↔ Division slot count consistency
        const divisions = window.divisions || {};
        let slotMismatches = [];
        for (const [divName, data] of Object.entries(divisions)) {
            const expectedSlots = (dt[divName] || []).length;
            if (expectedSlots === 0) continue;
            for (const bunk of (data.bunks || [])) {
                const actual = assignments[bunk]?.length || 0;
                if (actual > 0 && actual !== expectedSlots) {
                    slotMismatches.push(`${bunk}: has ${actual}, expected ${expectedSlots}`);
                }
            }
        }
        if (slotMismatches.length > 0) {
            warn(CAT, 'Bunk Slot Counts', `${slotMismatches.length} mismatch(es): ${slotMismatches.slice(0, 5).join('; ')}${slotMismatches.length > 5 ? '...' : ''}`);
        } else if (assignedBunks.length > 0) {
            pass(CAT, 'Bunk Slot Counts', 'All bunks match their division slot counts');
        }

        // Solver engine readiness
        if (window.totalSolverEngine?.solveSchedule) {
            pass(CAT, 'Solver Engine', 'Ready');
        } else {
            fail(CAT, 'Solver Engine', 'totalSolverEngine.solveSchedule not available');
        }

        // Rotation engine
        if (window.RotationEngine) {
            pass(CAT, 'Rotation Engine', 'Loaded');
            const history = safeCall(() => window.loadRotationHistory?.() || {}, {});
            const historyDates = Object.keys(history);
            pass(CAT, 'Rotation History', `${historyDates.length} date(s) in history`);
        } else {
            warn(CAT, 'Rotation Engine', 'Not loaded — rotation fairness won\'t work');
        }

        // GlobalFieldLocks
        if (window.GlobalFieldLocks) {
            pass(CAT, 'GlobalFieldLocks', 'Available');
            const lockedFields = safeCall(() => Object.keys(window.GlobalFieldLocks.getLockedFields?.() || {}).length, 0);
            if (lockedFields > 0) {
                pass(CAT, 'Field Locks Active', `${lockedFields} fields currently locked`);
            }
        } else {
            warn(CAT, 'GlobalFieldLocks', 'Not loaded');
        }

        // Pinned activities
        const pinnedCount = safeCall(() => {
            let count = 0;
            for (const slots of Object.values(assignments)) {
                if (!Array.isArray(slots)) continue;
                for (const s of slots) {
                    if (s && s._pinned === true) count++;
                }
            }
            return count;
        }, 0);
        if (pinnedCount > 0) {
            pass(CAT, 'Pinned Activities', `${pinnedCount} pinned entries found — will be preserved on regeneration`);
        }
    }

    // =========================================================================
    // CATEGORY 6: TAB INIT FUNCTIONS
    // =========================================================================

    function auditTabInits() {
        const CAT = '6. Tab Init';

        const tabs = [
            ['setup', 'initApp1'],
            ['locations', 'initLocationsTab'],
            ['fields', 'initFieldsTab'],
            ['special_activities', 'initSpecialActivitiesTab'],
            ['leagues', 'initLeagues'],
            ['specialty-leagues', 'initSpecialtyLeagues'],
            ['master-scheduler', 'initMasterScheduler'],
            ['daily-adjustments', 'initDailyAdjustments'],
            ['schedule', 'updateTable'],
            ['camper-locator', 'initCamperLocator'],
            ['report', 'initReportTab'],
            ['print', 'initPrintCenter'],
            ['updates', 'initUpdatesTab'],
            ['helper', 'initHelperTab'],
        ];

        for (const [tabId, fnName] of tabs) {
            // Check DOM container exists
            const container = document.getElementById(tabId);
            if (!container) {
                fail(CAT, `DOM: #${tabId}`, 'Element not found in page');
                continue;
            } else {
                pass(CAT, `DOM: #${tabId}`, 'Exists');
            }

            // Check init function exists
            const fn = window[fnName];
            if (typeof fn === 'function') {
                pass(CAT, `Fn: ${fnName}()`, 'Defined');
            } else {
                fail(CAT, `Fn: ${fnName}()`, 'NOT a function');
            }
        }
    }

    // =========================================================================
    // CATEGORY 7: UI / DOM INTEGRITY
    // =========================================================================

    function auditUIDom() {
        const CAT = '7. UI/DOM';

        // Critical layout elements
        const criticalElements = [
            'main-app-container',
            'sidebar',
            'hamburgerBtn',
            'calendar-date-picker',
            'scheduleTable',
            'master-scheduler-content',
            'daily-adjustments-content',
            'print-content',
            'report-content',
            'helper-content',
            'updates-content',
        ];

        for (const id of criticalElements) {
            if (document.getElementById(id)) {
                pass(CAT, `Element #${id}`, 'Present');
            } else {
                fail(CAT, `Element #${id}`, 'MISSING from DOM');
            }
        }

        // Main app container visible
        const mainApp = document.getElementById('main-app-container');
        if (mainApp) {
            const display = getComputedStyle(mainApp).display;
            if (display !== 'none') {
                pass(CAT, 'Main App Visible', `display: ${display}`);
            } else {
                fail(CAT, 'Main App Visible', 'display:none — auth loading screen may be stuck');
            }
        }

        // Auth loading screen should be hidden
        const authScreen = document.getElementById('auth-loading-screen');
        if (authScreen) {
            const display = getComputedStyle(authScreen).display;
            if (display === 'none') {
                pass(CAT, 'Auth Loading Screen', 'Hidden (good)');
            } else {
                fail(CAT, 'Auth Loading Screen', `Still visible (display: ${display}) — app may not have booted`);
            }
        }

        // Active sidebar tab
        const activeTab = document.querySelector('.sidebar-item.active');
        if (activeTab) {
            pass(CAT, 'Active Sidebar Tab', activeTab.dataset?.tab || 'unknown');
        } else {
            warn(CAT, 'Active Sidebar Tab', 'None active');
        }

        // Date picker value
        const datePicker = document.getElementById('calendar-date-picker');
        if (datePicker?.value) {
            pass(CAT, 'Date Picker', datePicker.value);
        } else {
            warn(CAT, 'Date Picker', 'No date set');
        }

        // Check for orphaned modals/overlays
        const modals = document.querySelectorAll('[id*="modal"], [id*="overlay"]');
        const visibleModals = Array.from(modals).filter(m => {
            const style = getComputedStyle(m);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (visibleModals.length > 0) {
            warn(CAT, 'Open Modals', `${visibleModals.length} modal(s) visible: ${visibleModals.map(m => m.id).join(', ')}`);
        } else {
            pass(CAT, 'Open Modals', 'None (clean state)');
        }

        // Check for error toast/notification
        const errorToasts = document.querySelectorAll('.toast-error, .error-notification, [class*="error"]');
        const visibleErrors = Array.from(errorToasts).filter(e => {
            const style = getComputedStyle(e);
            return style.display !== 'none' && style.opacity !== '0';
        });
        if (visibleErrors.length > 0) {
            warn(CAT, 'Visible Error Elements', `${visibleErrors.length} error-styled element(s) on screen`);
        }
    }

    // =========================================================================
    // CATEGORY 8: POST-EDIT SYSTEM
    // =========================================================================

    function auditPostEditSystem() {
        const CAT = '8. Post-Edit';

        // Core functions
        const editFunctions = {
            'openPostEditModal':          window.openPostEditModal,
            'resolveConflictsAndApply':    window.resolveConflictsAndApply,
            'smartRegenerateConflicts':    window.smartRegenerateConflicts,
            'capturePinnedActivities':     window.capturePinnedActivities,
            'restorePinnedActivities':     window.restorePinnedActivities,
        };

        for (const [name, fn] of Object.entries(editFunctions)) {
            if (typeof fn === 'function') {
                pass(CAT, name, 'Available');
            } else {
                // Some may be nested in modules
                const altCheck = name === 'capturePinnedActivities' ? window.PinnedPreservation?.capture :
                                 name === 'restorePinnedActivities' ? window.PinnedPreservation?.restore : null;
                if (typeof altCheck === 'function') {
                    pass(CAT, name, 'Available (via module)');
                } else {
                    warn(CAT, name, 'Not found — post-generation editing may not work');
                }
            }
        }

        // UnifiedScheduleSystem
        if (window.UnifiedScheduleSystem) {
            pass(CAT, 'UnifiedScheduleSystem', 'Loaded');
            if (typeof window.UnifiedScheduleSystem.getFieldUsageAtTime === 'function') {
                pass(CAT, 'getFieldUsageAtTime', 'Available for conflict detection');
            }
        } else {
            warn(CAT, 'UnifiedScheduleSystem', 'Not loaded');
        }
    }

    // =========================================================================
    // CATEGORY 9: RAINY DAY SYSTEM
    // =========================================================================

    function auditRainyDay() {
        const CAT = '9. Rainy Day';

        // Core functions
        const rainyFunctions = {
            'activateRainyDayMode':       window.activateRainyDayMode,
            'deactivateRainyDayMode':     window.deactivateRainyDayMode,
            'activateMidDayRainyMode':    window.activateMidDayRainyMode,
            'isRainyDayModeActive':       window.isRainyDayModeActive,
            'getRainyDayAvailableFields': window.getRainyDayAvailableFields,
            'getRainyDayUnavailableFields': window.getRainyDayUnavailableFields,
        };

        for (const [name, fn] of Object.entries(rainyFunctions)) {
            if (typeof fn === 'function') {
                pass(CAT, name, 'Available');
            } else {
                warn(CAT, name, 'Not found');
            }
        }

        // Current rainy day state
        const isRainy = safeCall(() => {
            if (window.isRainyDayModeActive?.()) return true;
            if (window.isRainyDay === true) return true;
            const daily = window.loadCurrentDailyData?.() || {};
            return daily.rainyDayMode === true || daily.isRainyDay === true;
        }, false);

        pass(CAT, 'Current State', isRainy ? '🌧️ RAINY DAY ACTIVE' : '☀️ Normal mode');

        // Rainy day skeleton configured?
        const rainySkeletonName = safeCall(() => {
            const g = getSettings();
            return g.rainyDaySkeletonName || null;
        }, null);

        if (rainySkeletonName) {
            pass(CAT, 'Rainy Skeleton', `Configured: "${rainySkeletonName}"`);
            // Verify it actually exists in savedSkeletons
            const savedSkeletons = safeCall(() => getSettings().app1?.savedSkeletons || {}, {});
            if (savedSkeletons[rainySkeletonName]) {
                pass(CAT, 'Rainy Skeleton Exists', `Found with ${savedSkeletons[rainySkeletonName].length} blocks`);
            } else {
                fail(CAT, 'Rainy Skeleton Exists', `"${rainySkeletonName}" NOT FOUND in saved skeletons`);
            }
        } else {
            skip(CAT, 'Rainy Skeleton', 'Not configured (optional)');
        }

        // Field availability for rainy day
        const settings = getSettings();
        const fields = settings.app1?.fields || [];
        const indoor = fields.filter(f => f.rainyDayAvailable === true);
        const outdoor = fields.filter(f => f.rainyDayAvailable !== true);
        pass(CAT, 'Field Split', `${indoor.length} rain-available, ${outdoor.length} outdoor-only out of ${fields.length} total`);

        if (indoor.length === 0 && fields.length > 0) {
            warn(CAT, 'No Indoor Fields', 'No fields marked as rainy day available — rainy mode would have 0 fields');
        }
    }

    // =========================================================================
    // CATEGORY 10: PRINT & OUTPUT
    // =========================================================================

    function auditPrintOutput() {
        const CAT = '10. Print & Output';

        // Print Center
        if (typeof window.initPrintCenter === 'function') {
            pass(CAT, 'Print Center', 'Init function available');
        } else {
            fail(CAT, 'Print Center', 'initPrintCenter not found');
        }

        // Camper Locator
        if (typeof window.initCamperLocator === 'function') {
            pass(CAT, 'Camper Locator', 'Init function available');
        } else {
            fail(CAT, 'Camper Locator', 'initCamperLocator not found');
        }

        // Validator
        if (typeof window.validateSchedule === 'function') {
            pass(CAT, 'Schedule Validator', 'validateSchedule() available');
        } else {
            fail(CAT, 'Schedule Validator', 'validateSchedule not found');
        }

        // Report
        if (typeof window.initReportTab === 'function') {
            pass(CAT, 'Report Tab', 'Init function available');
        } else {
            warn(CAT, 'Report Tab', 'initReportTab not found');
        }

        // Diagnostic tools
        const diagTools = {
            'diagnoseFields':           typeof window.diagnoseFields === 'function',
            'diagnoseSpecialActivities': typeof window.diagnoseSpecialActivities === 'function',
            'RBACDiagnostics':          !!window.RBACDiagnostics,
            'ScheduleOrchestrator.diagnose': typeof window.ScheduleOrchestrator?.diagnose === 'function',
        };

        for (const [name, available] of Object.entries(diagTools)) {
            if (available) {
                pass(CAT, `Diag: ${name}`, 'Available');
            } else {
                skip(CAT, `Diag: ${name}`, 'Not loaded');
            }
        }
    }

    // =========================================================================
    // CATEGORY 11: DEMO MODE
    // =========================================================================

    function auditDemoMode() {
        const CAT = '11. Demo Mode';

        const isDemoActive = window.__CAMPISTRY_DEMO_MODE__ === true;
        const localFlag = localStorage.getItem('campistry_demo_mode') === 'true';

        if (isDemoActive) {
            pass(CAT, 'Demo Mode', 'ACTIVE — offline operations will work');
        } else if (localFlag) {
            warn(CAT, 'Demo Mode', 'Flag in localStorage but window flag not set — may need page reload');
        } else {
            pass(CAT, 'Demo Mode', 'Not active (normal online mode)');
        }

        // Verify fetch interception (only relevant in demo mode)
        if (isDemoActive) {
            // Check that supabase is mocked
            if (window.supabase && typeof window.supabase.from === 'function') {
                pass(CAT, 'Mock Supabase', 'supabase.from() is available');
            } else {
                fail(CAT, 'Mock Supabase', 'supabase client may not be properly mocked');
            }

            pass(CAT, 'Activation Method', 'Add ?demo=true to any URL, or run enableDemoMode() in console');
            pass(CAT, 'Deactivation Method', 'Add ?demo=false to any URL, or run disableDemoMode() in console');
        }
    }

    // =========================================================================
    // CATEGORY 12: CROSS-DIVISION & FIELD SHARING
    // =========================================================================

    function auditCrossDivision() {
        const CAT = '12. Cross-Division';
        const settings = getSettings();
        const fields = settings.app1?.fields || [];

        // Sharing type breakdown
        let notSharable = 0, sameDivision = 0, customShare = 0, allShare = 0, noType = 0;
        fields.forEach(f => {
            const type = f.sharableWith?.type;
            if (type === 'not_sharable') notSharable++;
            else if (type === 'same_division') sameDivision++;
            else if (type === 'custom') customShare++;
            else if (type === 'all') allShare++;
            else noType++;
        });

        pass(CAT, 'Sharing Breakdown', `not_sharable:${notSharable} same_div:${sameDivision} custom:${customShare} all:${allShare} undefined:${noType}`);
        if (noType > 0) {
            warn(CAT, 'Undefined Sharing', `${noType} field(s) have no sharableWith.type — will default to not_sharable`);
        }

        // Capacity validation
        let badCapacity = 0;
        fields.forEach(f => {
            const cap = f.sharableWith?.capacity;
            if (cap !== undefined && (isNaN(parseInt(cap)) || parseInt(cap) < 1)) {
                badCapacity++;
            }
        });
        if (badCapacity > 0) {
            warn(CAT, 'Invalid Capacities', `${badCapacity} field(s) have invalid capacity values`);
        } else {
            pass(CAT, 'Capacity Values', 'All valid');
        }

        // Division-limited fields
        const limitedFields = fields.filter(f => f.limitUsage?.enabled === true);
        if (limitedFields.length > 0) {
            pass(CAT, 'Division-Limited Fields', `${limitedFields.length} field(s) with priority/restriction rules`);
        }

        // GlobalFieldLocks integration
        if (window.GlobalFieldLocks) {
            const otherUsage = safeCall(() => window.GlobalFieldLocks.getOtherSchedulerFieldUsage?.() || {}, {});
            const otherCount = Object.keys(otherUsage).length;
            if (otherCount > 0) {
                pass(CAT, 'Other Scheduler Locks', `${otherCount} field(s) locked by other schedulers`);
            } else {
                pass(CAT, 'Other Scheduler Locks', 'None (owner/admin or no other schedulers active)');
            }
        }
    }

    // =========================================================================
    // CATEGORY 13: PERFORMANCE
    // =========================================================================

    function auditPerformance() {
        const CAT = '13. Performance';

        // localStorage usage
        let totalLSSize = 0;
        let largestKey = '';
        let largestSize = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key) || '';
                const size = (key.length + val.length) * 2; // UTF-16
                totalLSSize += size;
                if (size > largestSize) {
                    largestSize = size;
                    largestKey = key;
                }
            }
            const totalMB = (totalLSSize / 1024 / 1024).toFixed(2);
            const largestMB = (largestSize / 1024 / 1024).toFixed(2);

            if (totalLSSize < 4 * 1024 * 1024) {
                pass(CAT, 'localStorage Usage', `${totalMB}MB total (limit ~5MB)`);
            } else {
                warn(CAT, 'localStorage Usage', `${totalMB}MB — approaching 5MB limit!`);
            }
            pass(CAT, 'Largest Key', `"${largestKey}" = ${largestMB}MB`);
        } catch (e) {
            warn(CAT, 'localStorage', `Error measuring: ${e.message}`);
        }

        // Event listener estimate (MutationObserver count)
        const scripts = document.querySelectorAll('script[src]');
        pass(CAT, 'Script Tags', `${scripts.length} external scripts loaded`);

        // scheduleAssignments size
        const assignmentSize = safeCall(() => {
            return JSON.stringify(window.scheduleAssignments || {}).length;
        }, 0);
        if (assignmentSize > 0) {
            const sizeMB = (assignmentSize / 1024 / 1024).toFixed(3);
            if (assignmentSize > 2 * 1024 * 1024) {
                warn(CAT, 'scheduleAssignments Size', `${sizeMB}MB — very large, may slow save/load`);
            } else {
                pass(CAT, 'scheduleAssignments Size', `${sizeMB}MB`);
            }
        }

        // Count divisions × bunks × slots for complexity estimate
        const divisions = window.divisions || {};
        let totalCells = 0;
        for (const [divName, data] of Object.entries(divisions)) {
            const bunks = (data.bunks || []).length;
            const slots = (window.divisionTimes?.[divName] || []).length;
            totalCells += bunks * slots;
        }
        pass(CAT, 'Schedule Complexity', `${totalCells} total cells (bunks × slots)`);
    }

    // =========================================================================
    // CATEGORY 14: CONSOLE ERROR TRAP
    // =========================================================================

    function auditConsoleErrors() {
        const CAT = '14. Console Errors';

        const errors = stopErrorCapture();
        if (errors.length === 0) {
            pass(CAT, 'During Audit', 'No console.error calls captured ✨');
        } else {
            fail(CAT, 'During Audit', `${errors.length} error(s) captured:`);
            errors.forEach((err, i) => {
                fail(CAT, `Error ${i + 1}`, err.substring(0, 200));
            });
        }
    }

    // =========================================================================
    // REPORT PRINTER
    // =========================================================================

    function printReport(title) {
        const { pass: p, fail: f, warn: w, skip: s, details } = _auditResults;
        const total = p + f + w + s;

        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════════════╗');
        console.log(`║  🔍 ${title.padEnd(62)}║`);
        console.log('╠══════════════════════════════════════════════════════════════════════╣');
        console.log(`║  ✅ PASS: ${String(p).padEnd(6)} ❌ FAIL: ${String(f).padEnd(6)} ⚠️ WARN: ${String(w).padEnd(6)} ⏭️ SKIP: ${String(s).padEnd(4)}║`);
        console.log(`║  Total checks: ${String(total).padEnd(52)}║`);
        console.log('╚══════════════════════════════════════════════════════════════════════╝');

        if (f === 0 && w === 0) {
            console.log('\n  🎉 PERFECT SCORE — Ready for the expo!\n');
        } else if (f === 0) {
            console.log(`\n  ✅ No failures! ${w} warning(s) to review.\n`);
        } else {
            console.log(`\n  🚨 ${f} FAILURE(S) NEED FIXING before the expo.\n`);
        }

        // Group by category
        const categories = {};
        for (const d of details) {
            if (!categories[d.category]) categories[d.category] = [];
            categories[d.category].push(d);
        }

        for (const [cat, items] of Object.entries(categories)) {
            const catFails = items.filter(i => i.status === '❌').length;
            const catWarns = items.filter(i => i.status === '⚠️').length;
            const catIcon = catFails > 0 ? '❌' : catWarns > 0 ? '⚠️' : '✅';

            console.log(`\n${catIcon} ─── ${cat} ─── (${items.length} checks)`);

            // Show failures and warnings first, then passes
            const sorted = [...items].sort((a, b) => {
                const order = { '❌': 0, '⚠️': 1, '⏭️': 2, '✅': 3 };
                return (order[a.status] || 4) - (order[b.status] || 4);
            });

            for (const item of sorted) {
                // Collapse passes in verbose categories
                if (item.status === '✅' && items.length > 10) {
                    continue; // Skip passes when there are many items
                }
                console.log(`   ${item.status} ${item.test}: ${item.detail}`);
            }

            // Show collapsed pass count
            const passCount = items.filter(i => i.status === '✅').length;
            if (passCount > 0 && items.length > 10) {
                console.log(`   ✅ ...and ${passCount} more passing checks`);
            }
        }

        console.log('\n' + '═'.repeat(70));
    }

    // =========================================================================
    // MAIN AUDIT FUNCTIONS
    // =========================================================================

    async function expoAudit() {
        resetResults();
        startErrorCapture();

        const startTime = performance.now();

        console.log('%c🔍 CAMPISTRY EXPO AUDIT v2.0', 'color:#1AACCA;font-size:18px;font-weight:bold');
        console.log('%c   Running comprehensive pre-expo diagnostics...', 'color:#666');
        console.log('   Date:', new Date().toISOString());
        console.log('   Current schedule date:', getCurrentDateKey());
        console.log('');

        auditModuleLoading();
        await auditAuthRBAC();
        auditDataIntegrity();
        await auditCloudSync();
        auditSchedulePipeline();
        auditTabInits();
        auditUIDom();
        auditPostEditSystem();
        auditRainyDay();
        auditPrintOutput();
        auditDemoMode();
        auditCrossDivision();
        auditPerformance();
        auditConsoleErrors();

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`\n⏱️ Audit completed in ${elapsed}s`);

        printReport(`CAMPISTRY EXPO AUDIT v${VERSION} — ${getCurrentDateKey()}`);

        return _auditResults;
    }

    async function quickCheck() {
        resetResults();
        startErrorCapture();

        console.log('%c⚡ CAMPISTRY QUICK CHECK', 'color:#F59E0B;font-size:16px;font-weight:bold');

        auditModuleLoading();
        auditDataIntegrity();
        auditSchedulePipeline();
        auditUIDom();
        auditConsoleErrors();

        printReport('QUICK CHECK');
        return _auditResults;
    }

    async function auditCategory(n) {
        resetResults();
        startErrorCapture();

        const categories = {
            1:  ['1. Module Loading',       auditModuleLoading],
            2:  ['2. Auth & RBAC',          auditAuthRBAC],
            3:  ['3. Data Integrity',        auditDataIntegrity],
            4:  ['4. Cloud Sync',           auditCloudSync],
            5:  ['5. Schedule Pipeline',     auditSchedulePipeline],
            6:  ['6. Tab Init Functions',    auditTabInits],
            7:  ['7. UI/DOM Integrity',      auditUIDom],
            8:  ['8. Post-Edit System',      auditPostEditSystem],
            9:  ['9. Rainy Day System',      auditRainyDay],
            10: ['10. Print & Output',       auditPrintOutput],
            11: ['11. Demo Mode',            auditDemoMode],
            12: ['12. Cross-Division',       auditCrossDivision],
            13: ['13. Performance',          auditPerformance],
            14: ['14. Console Errors',       auditConsoleErrors],
        };

        const cat = categories[n];
        if (!cat) {
            console.log('Invalid category. Use 1-14.');
            return;
        }

        console.log(`%c🔍 Auditing: ${cat[0]}`, 'color:#1AACCA;font-size:14px;font-weight:bold');
        await cat[1]();
        stopErrorCapture();
        printReport(cat[0]);
        return _auditResults;
    }

    // =========================================================================
    // GENERATION AUDIT — Deep analysis of generated schedule quality
    // =========================================================================
    // Run AFTER a schedule has been generated (or pass generate:true to auto-generate)
    //
    // Checks:
    //   A. Cross-division conflicts (same field, same time, different divisions)
    //   B. Same-day activity repetitions per bunk
    //   C. Same-day field repetitions per bunk
    //   D. Capacity violations (too many bunks on one field)
    //   E. Split tile correctness (groups swap, both halves filled, no overlap)
    //   F. Smart tile correctness (swap between blocks, capacity-aware)
    //   G. League generation (matchups exist, fields locked, no conflicts)
    //   H. Specialty league generation (same + gamesPerFieldSlot respected)
    //   I. Rotation fairness (activity distribution across bunks in division)
    //   J. Multi-day spread (if rotation history exists)
    //   K. Empty/Free slot analysis (solver exhaustion detection)
    //   L. Field lock integrity (GlobalFieldLocks respected)
    //   M. Pinned activity preservation
    //   N. Elective exclusivity (reserved resources only for that division)
    //   O. Transition/buffer correctness
    // =========================================================================

    async function generationAudit(options = {}) {
        const { generate = false } = options;
        resetResults();

        console.log('%c🔬 GENERATION QUALITY AUDIT', 'color:#EF4444;font-size:18px;font-weight:bold');
        console.log('%c   Deep analysis of schedule generation correctness...', 'color:#666');

        const divisions = window.divisions || {};
        const divNames = Object.keys(divisions);
        const assignments = window.scheduleAssignments || {};
        const dt = window.divisionTimes || {};
        const settings = getSettings();
        const app1 = settings.app1 || {};
        const fields = app1.fields || [];
        const actProps = window.activityProperties || {};

        if (divNames.length === 0) {
            fail('Pre-check', 'Divisions', 'No divisions — cannot audit');
            printReport('GENERATION AUDIT — ABORTED');
            return _auditResults;
        }

        // Optionally generate first
        if (generate) {
            const dailyData = safeCall(() => window.loadCurrentDailyData?.() || {}, {});
            const skeleton = dailyData.manualSkeleton || [];
            if (skeleton.length === 0) {
                fail('Pre-check', 'Skeleton', 'No skeleton loaded — cannot generate');
                printReport('GENERATION AUDIT — ABORTED');
                return _auditResults;
            }
            console.log(`\n⚙️ Generating schedule (${skeleton.length} skeleton blocks)...`);
            const t0 = performance.now();
            try {
                window.runSkeletonOptimizer(skeleton);
                console.log(`✅ Generated in ${((performance.now() - t0) / 1000).toFixed(2)}s\n`);
            } catch (e) {
                fail('Pre-check', 'Generation', `CRASHED: ${e.message}`);
                printReport('GENERATION AUDIT — CRASHED');
                return _auditResults;
            }
        }

        const assignedBunks = Object.keys(assignments);
        if (assignedBunks.length === 0) {
            fail('Pre-check', 'Assignments', 'scheduleAssignments is empty — generate a schedule first (or pass {generate:true})');
            printReport('GENERATION AUDIT — NO DATA');
            return _auditResults;
        }

        pass('Pre-check', 'Data Available', `${assignedBunks.length} bunks, ${divNames.length} divisions`);

        // Build bunk→division map
        const bunkDiv = {};
        for (const [d, data] of Object.entries(divisions)) {
            for (const b of (data.bunks || [])) bunkDiv[String(b)] = d;
        }

        // Build field config lookup
        const fieldConfig = {};
        fields.forEach(f => { if (f.name) fieldConfig[f.name.toLowerCase()] = f; });

        // =====================================================================
        // A. CROSS-DIVISION FIELD CONFLICTS
        // =====================================================================
        const CAT_A = 'A. Cross-Div Conflicts';
        {
            // For each time slot, find which fields are used by which divisions
            const conflictsByTime = {}; // { startMin: { fieldName: { divisions: Set, bunks: [] } } }
            let crossDivConflicts = 0;

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                const div = bunkDiv[bunk];
                if (!div) continue;
                const divSlots = dt[div] || [];

                for (let i = 0; i < slots.length; i++) {
                    const entry = slots[i];
                    if (!entry || entry._isTransition || entry.continuation) continue;
                    const fieldName = (typeof entry.field === 'object' ? entry.field?.name : entry.field) || '';
                    const act = (entry._activity || fieldName || '').toLowerCase();
                    if (!fieldName || ['free', 'free (timeout)', 'transition/buffer', 'no field'].includes(act)) continue;
                    if (act.startsWith('league:')) continue; // leagues handle their own locking

                    const slotInfo = divSlots[i];
                    const timeKey = slotInfo ? `${slotInfo.startMin}-${slotInfo.endMin}` : `slot_${i}`;

                    if (!conflictsByTime[timeKey]) conflictsByTime[timeKey] = {};
                    if (!conflictsByTime[timeKey][fieldName]) conflictsByTime[timeKey][fieldName] = { divisions: new Set(), bunks: [] };

                    conflictsByTime[timeKey][fieldName].divisions.add(div);
                    conflictsByTime[timeKey][fieldName].bunks.push(bunk);
                }
            }

            // Check sharing rules
            for (const [timeKey, fieldMap] of Object.entries(conflictsByTime)) {
                for (const [fieldName, usage] of Object.entries(fieldMap)) {
                    if (usage.divisions.size <= 1) continue;

                    const fc = fieldConfig[fieldName.toLowerCase()];
                    const shareType = fc?.sharableWith?.type || 'not_sharable';

                    if (shareType === 'not_sharable') {
                        crossDivConflicts++;
                        fail(CAT_A, `${fieldName} @ ${timeKey}`, `NOT SHARABLE but used by ${[...usage.divisions].join(' & ')} (${usage.bunks.length} bunks)`);
                    } else if (shareType === 'same_division') {
                        crossDivConflicts++;
                        fail(CAT_A, `${fieldName} @ ${timeKey}`, `SAME_DIVISION only but used by ${[...usage.divisions].join(' & ')}`);
                    } else if (shareType === 'custom') {
                        const allowedDivs = fc?.sharableWith?.divisions || [];
                        const usingDivs = [...usage.divisions];
                        const unauthorized = usingDivs.filter(d => !allowedDivs.includes(d));
                        if (unauthorized.length > 0) {
                            crossDivConflicts++;
                            fail(CAT_A, `${fieldName} @ ${timeKey}`, `Custom sharing violated: ${unauthorized.join(', ')} not in allowed list`);
                        }
                    }
                    // type='all' allows cross-division — check capacity
                    const cap = parseInt(fc?.sharableWith?.capacity) || 999;
                    if (usage.bunks.length > cap) {
                        crossDivConflicts++;
                        fail(CAT_A, `${fieldName} @ ${timeKey} Capacity`, `${usage.bunks.length} bunks exceed capacity ${cap}`);
                    }
                }
            }

            if (crossDivConflicts === 0) {
                pass(CAT_A, 'All Fields', 'No cross-division sharing violations detected');
            }
        }

        // =====================================================================
        // B. SAME-DAY ACTIVITY REPETITIONS
        // =====================================================================
        const CAT_B = 'B. Same-Day Repeats';
        {
            const IGNORED = new Set(['free', 'free (timeout)', 'free play', 'lunch', 'snacks', 'dismissal',
                'transition/buffer', 'regroup', 'lineup', 'bus', 'swim', 'pool', 'canteen',
                'gameroom', 'game room', 'davening', 'mincha', 'buffer', 'no field']);
            let totalRepeats = 0;
            const repeatDetails = [];

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                const seenActivities = {};

                for (let i = 0; i < slots.length; i++) {
                    const entry = slots[i];
                    if (!entry || entry.continuation || entry._isTransition) continue;
                    const act = (entry._activity || entry.field || '').toLowerCase().trim();
                    if (!act || IGNORED.has(act) || act.startsWith('league:')) continue;

                    if (seenActivities[act] !== undefined) {
                        totalRepeats++;
                        repeatDetails.push(`${bunk}: "${act}" at slots ${seenActivities[act]} & ${i}`);
                    } else {
                        seenActivities[act] = i;
                    }
                }
            }

            if (totalRepeats === 0) {
                pass(CAT_B, 'Activity Uniqueness', 'No bunk does the same activity twice in one day');
            } else {
                fail(CAT_B, 'Activity Repeats', `${totalRepeats} repeat(s) found`);
                repeatDetails.slice(0, 10).forEach(d => fail(CAT_B, 'Detail', d));
                if (repeatDetails.length > 10) warn(CAT_B, 'Truncated', `...and ${repeatDetails.length - 10} more`);
            }
        }

        // =====================================================================
        // C. SAME-DAY FIELD REPETITIONS
        // =====================================================================
        const CAT_C = 'C. Field Repeats';
        {
            const IGNORED_FIELDS = new Set(['free', 'free (timeout)', 'no field', 'transition/buffer']);
            let fieldRepeats = 0;

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                const seenFields = {};

                for (let i = 0; i < slots.length; i++) {
                    const entry = slots[i];
                    if (!entry || entry.continuation || entry._isTransition) continue;
                    const f = (typeof entry.field === 'object' ? entry.field?.name : entry.field || '').toLowerCase().trim();
                    if (!f || IGNORED_FIELDS.has(f) || f.startsWith('league:')) continue;

                    if (seenFields[f] !== undefined) {
                        fieldRepeats++;
                        if (fieldRepeats <= 5) warn(CAT_C, `${bunk}`, `Field "${f}" used at slots ${seenFields[f]} & ${i}`);
                    } else {
                        seenFields[f] = i;
                    }
                }
            }

            if (fieldRepeats === 0) {
                pass(CAT_C, 'Field Uniqueness', 'No bunk uses the same field twice');
            } else {
                warn(CAT_C, 'Field Repeats Total', `${fieldRepeats} repeat(s) — bunks revisiting same location`);
            }
        }

        // =====================================================================
        // D. CAPACITY VIOLATIONS (per time slot)
        // =====================================================================
        const CAT_D = 'D. Capacity';
        {
            let capacityViolations = 0;
            // Build field usage per time window
            const fieldTimeUsage = {}; // { fieldName: { timeKey: { count, divs, bunks } } }

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                const div = bunkDiv[bunk];
                if (!div) continue;
                const divSlots = dt[div] || [];

                for (let i = 0; i < slots.length; i++) {
                    const entry = slots[i];
                    if (!entry || entry._isTransition || entry.continuation) continue;
                    const f = (typeof entry.field === 'object' ? entry.field?.name : entry.field || '').toLowerCase().trim();
                    if (!f || f === 'free' || f === 'free (timeout)' || f === 'no field' || f.startsWith('league:')) continue;

                    const slotInfo = divSlots[i];
                    const timeKey = slotInfo ? `${slotInfo.startMin}-${slotInfo.endMin}` : `s${i}`;

                    if (!fieldTimeUsage[f]) fieldTimeUsage[f] = {};
                    if (!fieldTimeUsage[f][timeKey]) fieldTimeUsage[f][timeKey] = { count: 0, divs: new Set(), bunks: [] };
                    fieldTimeUsage[f][timeKey].count++;
                    fieldTimeUsage[f][timeKey].divs.add(div);
                    fieldTimeUsage[f][timeKey].bunks.push(bunk);
                }
            }

            for (const [fieldName, timeMap] of Object.entries(fieldTimeUsage)) {
                const fc = fieldConfig[fieldName];
                const shareType = fc?.sharableWith?.type || 'not_sharable';
                let cap;
                if (shareType === 'not_sharable') cap = 1;
                else if (shareType === 'all') cap = 999;
                else cap = parseInt(fc?.sharableWith?.capacity) || 2;

                for (const [timeKey, usage] of Object.entries(timeMap)) {
                    if (usage.count > cap) {
                        capacityViolations++;
                        if (capacityViolations <= 8) {
                            fail(CAT_D, `${fieldName} @ ${timeKey}`, `${usage.count} bunks (capacity: ${cap}) — divs: ${[...usage.divs].join(', ')}`);
                        }
                    }
                }
            }

            if (capacityViolations === 0) {
                pass(CAT_D, 'All Fields', 'No capacity violations');
            } else {
                fail(CAT_D, 'Total', `${capacityViolations} capacity violation(s)`);
            }
        }

        // =====================================================================
        // E. SPLIT TILE CORRECTNESS
        // =====================================================================
        const CAT_E = 'E. Split Tiles';
        {
            // Detect split tiles by looking for _fromSplitTile flag
            const splitBunks = {};
            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                for (let i = 0; i < slots.length; i++) {
                    const entry = slots[i];
                    if (entry && entry._fromSplitTile) {
                        if (!splitBunks[bunk]) splitBunks[bunk] = [];
                        splitBunks[bunk].push({ slot: i, activity: entry._activity || entry.field, startMin: entry._startMin, endMin: entry._endMin, half: entry._splitHalf });
                    }
                }
            }

            const splitBunkCount = Object.keys(splitBunks).length;
            if (splitBunkCount === 0) {
                skip(CAT_E, 'Split Tiles', 'No split tiles in current schedule');
            } else {
                pass(CAT_E, 'Split Tile Count', `${splitBunkCount} bunks have split tile assignments`);

                // Validate: each bunk should have exactly 2 split entries (half 1 and half 2)
                let incorrectSplits = 0;
                for (const [bunk, entries] of Object.entries(splitBunks)) {
                    if (entries.length !== 2) {
                        incorrectSplits++;
                        if (incorrectSplits <= 5) warn(CAT_E, `${bunk}`, `Has ${entries.length} split entries (expected 2)`);
                    } else {
                        // Verify they have different activities (the swap)
                        const acts = entries.map(e => (e.activity || '').toLowerCase());
                        if (acts[0] === acts[1]) {
                            incorrectSplits++;
                            if (incorrectSplits <= 5) warn(CAT_E, `${bunk}`, `Both halves have same activity "${acts[0]}" — no swap occurred`);
                        }
                    }
                }

                // Verify group swap: within a division, Group A's half-1 should be Group B's half-2
                for (const divName of divNames) {
                    const divBunks = (divisions[divName]?.bunks || []).filter(b => splitBunks[b]);
                    if (divBunks.length < 2) continue;

                    const half1Acts = {};
                    divBunks.forEach(b => {
                        const h1 = (splitBunks[b] || []).find(e => e.half === 1 || e.startMin === Math.min(...(splitBunks[b] || []).map(x => x.startMin || 0)));
                        if (h1) half1Acts[b] = (h1.activity || '').toLowerCase();
                    });

                    const uniqueActs = new Set(Object.values(half1Acts));
                    if (uniqueActs.size >= 2) {
                        pass(CAT_E, `Div ${divName} Swap`, `${divBunks.length} bunks split across ${uniqueActs.size} activities`);
                    } else if (uniqueActs.size === 1) {
                        warn(CAT_E, `Div ${divName} Swap`, `All bunks have same first-half activity — split may not be working`);
                    }
                }

                if (incorrectSplits === 0 && splitBunkCount > 0) {
                    pass(CAT_E, 'Split Structure', 'All split tiles have proper 2-half structure with activity swap');
                }
            }
        }

        // =====================================================================
        // F. SMART TILE CORRECTNESS
        // =====================================================================
        const CAT_F = 'F. Smart Tiles';
        {
            // Smart tiles: look for blocks where the skeleton had type='smart'
            const dailyData = safeCall(() => window.loadCurrentDailyData?.() || {}, {});
            const skeleton = dailyData.manualSkeleton || [];
            const smartItems = skeleton.filter(s => s.type === 'smart');

            if (smartItems.length === 0) {
                skip(CAT_F, 'Smart Tiles', 'No smart tiles in skeleton');
            } else {
                pass(CAT_F, 'Smart Tile Count', `${smartItems.length} smart tile(s) in skeleton`);

                // For each smart tile, verify that bunks in the division got different activities
                // and that there's a swap between blocks
                smartItems.forEach((item, idx) => {
                    const div = item.division;
                    if (!div || !divisions[div]) return;
                    const divBunks = divisions[div].bunks || [];
                    const Utils = window.SchedulerCoreUtils;
                    const startMin = Utils?.parseTimeToMinutes?.(item.startTime);
                    const endMin = Utils?.parseTimeToMinutes?.(item.endTime);

                    if (startMin == null || endMin == null) {
                        warn(CAT_F, `Smart #${idx + 1}`, 'Cannot parse time range');
                        return;
                    }

                    // Find what each bunk got during this time range
                    const bunkActivities = {};
                    divBunks.forEach(b => {
                        const slots = assignments[b];
                        if (!Array.isArray(slots)) return;
                        const divSlots = dt[div] || [];
                        for (let i = 0; i < slots.length; i++) {
                            const slotInfo = divSlots[i];
                            if (!slotInfo) continue;
                            if (slotInfo.startMin >= startMin && slotInfo.endMin <= endMin) {
                                const entry = slots[i];
                                if (entry && !entry._isTransition && !entry.continuation) {
                                    if (!bunkActivities[b]) bunkActivities[b] = [];
                                    bunkActivities[b].push((entry._activity || entry.field || '').toLowerCase());
                                }
                            }
                        }
                    });

                    const allActs = new Set();
                    Object.values(bunkActivities).forEach(acts => acts.forEach(a => allActs.add(a)));
                    allActs.delete('free');
                    allActs.delete('free (timeout)');

                    if (allActs.size >= 2) {
                        pass(CAT_F, `Smart #${idx + 1} (${div})`, `${allActs.size} different activities distributed: ${[...allActs].slice(0, 4).join(', ')}`);
                    } else if (allActs.size === 1) {
                        warn(CAT_F, `Smart #${idx + 1} (${div})`, `All bunks got the same activity "${[...allActs][0]}" — smart distribution may have failed`);
                    } else {
                        warn(CAT_F, `Smart #${idx + 1} (${div})`, 'No meaningful activities found in this time range');
                    }
                });
            }
        }

        // =====================================================================
        // G. LEAGUE GENERATION
        // =====================================================================
        const CAT_G = 'G. Leagues';
        {
            const leagueAssignments = window.leagueAssignments || {};
            const leagueBunks = Object.keys(leagueAssignments);

            if (leagueBunks.length === 0) {
                const leagueSkeletonItems = safeCall(() => {
                    const daily = window.loadCurrentDailyData?.() || {};
                    return (daily.manualSkeleton || []).filter(s => s.type === 'league');
                }, []);
                if (leagueSkeletonItems.length === 0) {
                    skip(CAT_G, 'Leagues', 'No league tiles in skeleton');
                } else {
                    warn(CAT_G, 'League Tiles Without Data', `${leagueSkeletonItems.length} league tile(s) in skeleton but leagueAssignments is empty`);
                }
            } else {
                pass(CAT_G, 'League Assignments', `${leagueBunks.length} bunks have league data`);

                // Count unique matchups
                let totalMatchups = 0;
                const leagueNames = new Set();
                for (const bunkData of Object.values(leagueAssignments)) {
                    for (const slotData of Object.values(bunkData || {})) {
                        if (slotData?.matchups?.length) {
                            totalMatchups += slotData.matchups.length;
                            if (slotData.leagueName) leagueNames.add(slotData.leagueName);
                        }
                    }
                }
                pass(CAT_G, 'Matchups', `${totalMatchups} matchup(s) across ${leagueNames.size} league(s): ${[...leagueNames].join(', ')}`);

                // Check that league fields are locked (in scheduleAssignments they appear as "League: X")
                let leagueEntries = 0;
                for (const slots of Object.values(assignments)) {
                    if (!Array.isArray(slots)) continue;
                    for (const s of slots) {
                        if (s && (s._activity || '').startsWith('League:')) leagueEntries++;
                    }
                }
                if (leagueEntries > 0) {
                    pass(CAT_G, 'League Locks', `${leagueEntries} schedule entries locked with "League:" prefix`);
                }
            }
        }

        // =====================================================================
        // H. SPECIALTY LEAGUE GENERATION
        // =====================================================================
        const CAT_H = 'H. Specialty Leagues';
        {
            const specLeagueItems = safeCall(() => {
                const daily = window.loadCurrentDailyData?.() || {};
                return (daily.manualSkeleton || []).filter(s => s.type === 'specialty_league');
            }, []);

            if (specLeagueItems.length === 0) {
                skip(CAT_H, 'Specialty Leagues', 'No specialty league tiles in skeleton');
            } else {
                pass(CAT_H, 'Skeleton Tiles', `${specLeagueItems.length} specialty league tile(s)`);

                // Look for specialty league entries in assignments
                let specLeagueEntries = 0;
                for (const slots of Object.values(assignments)) {
                    if (!Array.isArray(slots)) continue;
                    for (const s of slots) {
                        if (s && (s._activity || '').toLowerCase().includes('specialty')) specLeagueEntries++;
                    }
                }
                if (specLeagueEntries > 0) {
                    pass(CAT_H, 'Specialty Entries', `${specLeagueEntries} schedule entries for specialty leagues`);
                } else {
                    warn(CAT_H, 'Specialty Entries', 'No specialty league entries found in schedule — generation may have failed');
                }
            }
        }

        // =====================================================================
        // I. ROTATION FAIRNESS (within each division)
        // =====================================================================
        const CAT_I = 'I. Rotation Fairness';
        {
            const IGNORED = new Set(['free', 'free (timeout)', 'free play', 'lunch', 'snacks', 'dismissal',
                'transition/buffer', 'regroup', 'lineup', 'bus', 'buffer', 'no field',
                'canteen', 'gameroom', 'game room', 'davening', 'mincha']);

            let fairnessIssues = 0;

            for (const divName of divNames) {
                const divBunks = divisions[divName]?.bunks || [];
                if (divBunks.length < 2) continue;

                // Count activities per bunk
                const bunkActivityCounts = {};
                divBunks.forEach(b => {
                    bunkActivityCounts[b] = {};
                    const slots = assignments[b];
                    if (!Array.isArray(slots)) return;
                    for (const entry of slots) {
                        if (!entry || entry._isTransition || entry.continuation) continue;
                        const act = (entry._activity || entry.field || '').toLowerCase().trim();
                        if (IGNORED.has(act) || act.startsWith('league:')) continue;
                        bunkActivityCounts[b][act] = (bunkActivityCounts[b][act] || 0) + 1;
                    }
                });

                // Get all unique activities in this division
                const allDivActs = new Set();
                Object.values(bunkActivityCounts).forEach(counts => Object.keys(counts).forEach(a => allDivActs.add(a)));

                // Check distribution: for each activity, max - min across bunks should be ≤ 1
                for (const act of allDivActs) {
                    const counts = divBunks.map(b => bunkActivityCounts[b]?.[act] || 0);
                    const min = Math.min(...counts);
                    const max = Math.max(...counts);
                    const spread = max - min;

                    if (spread > 2) {
                        fairnessIssues++;
                        if (fairnessIssues <= 8) {
                            warn(CAT_I, `${divName}: "${act}"`, `Spread of ${spread} (min:${min}, max:${max}) — some bunks getting it ${spread}× more`);
                        }
                    }
                }

                // Total activity count per bunk should be roughly equal
                const totalPerBunk = divBunks.map(b => Object.values(bunkActivityCounts[b] || {}).reduce((s, n) => s + n, 0));
                const minTotal = Math.min(...totalPerBunk);
                const maxTotal = Math.max(...totalPerBunk);
                if (maxTotal - minTotal > 3) {
                    warn(CAT_I, `${divName} Total Balance`, `Bunk totals range from ${minTotal} to ${maxTotal} (spread: ${maxTotal - minTotal})`);
                } else {
                    pass(CAT_I, `${divName} Total Balance`, `Bunk totals: ${minTotal}–${maxTotal} (spread: ${maxTotal - minTotal})`);
                }
            }

            if (fairnessIssues === 0) {
                pass(CAT_I, 'Activity Fairness', 'All activities distributed evenly across bunks (spread ≤ 2)');
            } else {
                warn(CAT_I, 'Fairness Total', `${fairnessIssues} activity/division pair(s) with uneven distribution`);
            }
        }

        // =====================================================================
        // J. MULTI-DAY SPREAD (if rotation history exists)
        // =====================================================================
        const CAT_J = 'J. Multi-Day Spread';
        {
            const history = safeCall(() => window.loadRotationHistory?.() || {}, {});
            const historyDates = Object.keys(history);

            if (historyDates.length < 2) {
                skip(CAT_J, 'Multi-Day', `Only ${historyDates.length} date(s) in rotation history — need 2+ to evaluate spread`);
            } else {
                pass(CAT_J, 'History Depth', `${historyDates.length} dates in rotation history`);

                // Check if RotationEngine has scoring functions
                if (window.RotationEngine?.calculateRecencyScore) {
                    // Sample a few bunks and check their worst recency score
                    const sampleBunks = assignedBunks.slice(0, Math.min(6, assignedBunks.length));
                    let yesterdayRepeats = 0;

                    sampleBunks.forEach(bunk => {
                        const slots = assignments[bunk];
                        if (!Array.isArray(slots)) return;
                        for (const entry of slots) {
                            if (!entry || entry._isTransition || entry.continuation) continue;
                            const act = entry._activity || entry.field;
                            if (!act || act.toLowerCase() === 'free') continue;

                            const score = window.RotationEngine.calculateRecencyScore(bunk, act, 0);
                            if (score >= 12000) { // YESTERDAY_PENALTY
                                yesterdayRepeats++;
                            }
                        }
                    });

                    if (yesterdayRepeats === 0) {
                        pass(CAT_J, 'Recency (sampled)', 'No activities repeated from yesterday in sampled bunks');
                    } else {
                        warn(CAT_J, 'Recency (sampled)', `${yesterdayRepeats} activity/bunk pairs repeat from yesterday`);
                    }
                } else {
                    skip(CAT_J, 'Recency Scoring', 'RotationEngine not available for scoring');
                }
            }
        }

        // =====================================================================
        // K. EMPTY / FREE SLOT ANALYSIS
        // =====================================================================
        const CAT_K = 'K. Slot Analysis';
        {
            let totalFilled = 0, totalFree = 0, totalEmpty = 0, totalTransition = 0, totalLeague = 0;
            const freeByDiv = {};

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                const div = bunkDiv[bunk] || 'unknown';
                if (!freeByDiv[div]) freeByDiv[div] = { free: 0, filled: 0 };

                for (const s of slots) {
                    if (!s) { totalEmpty++; continue; }
                    const act = (s._activity || s.field || '').toLowerCase();
                    if (s._isTransition) { totalTransition++; continue; }
                    if (s.continuation) continue;
                    if (act === 'free' || act === 'free (timeout)') { totalFree++; freeByDiv[div].free++; }
                    else if (act.startsWith('league:')) { totalLeague++; freeByDiv[div].filled++; }
                    else { totalFilled++; freeByDiv[div].filled++; }
                }
            }

            pass(CAT_K, 'Overall', `Filled:${totalFilled} Free:${totalFree} Transition:${totalTransition} League:${totalLeague} Empty:${totalEmpty}`);

            const freeRatio = totalFilled > 0 ? (totalFree / (totalFilled + totalFree) * 100).toFixed(1) : 0;
            if (freeRatio > 20) {
                fail(CAT_K, 'Free Ratio', `${freeRatio}% of schedulable slots are FREE — solver failed to fill many slots`);
            } else if (freeRatio > 10) {
                warn(CAT_K, 'Free Ratio', `${freeRatio}% free — some solver timeouts`);
            } else {
                pass(CAT_K, 'Free Ratio', `${freeRatio}% free — excellent fill rate`);
            }

            // Per-division breakdown
            for (const [div, counts] of Object.entries(freeByDiv)) {
                const ratio = counts.filled > 0 ? (counts.free / (counts.filled + counts.free) * 100).toFixed(1) : 0;
                if (ratio > 15) {
                    warn(CAT_K, `${div} Free`, `${ratio}% (${counts.free}/${counts.filled + counts.free})`);
                }
            }
        }

        // =====================================================================
        // L. FIELD LOCK INTEGRITY
        // =====================================================================
        const CAT_L = 'L. Field Locks';
        {
            if (window.GlobalFieldLocks) {
                const locked = safeCall(() => window.GlobalFieldLocks.getLockedFields?.() || {}, {});
                const lockedCount = Object.keys(locked).length;
                pass(CAT_L, 'GlobalFieldLocks', `${lockedCount} field(s) currently locked`);

                // Verify no assignments violate locks
                let lockViolations = 0;
                for (const [bunk, slots] of Object.entries(assignments)) {
                    if (!Array.isArray(slots)) continue;
                    const div = bunkDiv[bunk];
                    for (let i = 0; i < slots.length; i++) {
                        const entry = slots[i];
                        if (!entry || entry._isTransition) continue;
                        const f = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                        if (!f || f.toLowerCase() === 'free') continue;

                        const lockInfo = window.GlobalFieldLocks.isFieldLocked?.(f, [i], div);
                        if (lockInfo && lockInfo.lockedBy !== 'pinned_activity' && lockInfo.lockedBy !== 'pinned_event_location') {
                            lockViolations++;
                            if (lockViolations <= 5) {
                                warn(CAT_L, `Violation`, `${bunk} slot ${i}: "${f}" locked by ${lockInfo.lockedBy}`);
                            }
                        }
                    }
                }
                if (lockViolations === 0) {
                    pass(CAT_L, 'Lock Respect', 'No assignments violate field locks');
                }
            } else {
                skip(CAT_L, 'GlobalFieldLocks', 'Module not loaded');
            }
        }

        // =====================================================================
        // M. PINNED ACTIVITY PRESERVATION
        // =====================================================================
        const CAT_M = 'M. Pinned Activities';
        {
            let pinnedCount = 0;
            let pinnedIntact = 0;
            for (const slots of Object.values(assignments)) {
                if (!Array.isArray(slots)) continue;
                for (const s of slots) {
                    if (s && s._pinned === true) {
                        pinnedCount++;
                        if (s._activity || s.field) pinnedIntact++;
                    }
                }
            }

            if (pinnedCount === 0) {
                skip(CAT_M, 'Pinned', 'No pinned activities in schedule');
            } else {
                pass(CAT_M, 'Pinned Count', `${pinnedCount} pinned, ${pinnedIntact} have valid data`);
                if (pinnedIntact < pinnedCount) {
                    fail(CAT_M, 'Pinned Data', `${pinnedCount - pinnedIntact} pinned entries lost their activity data`);
                } else {
                    pass(CAT_M, 'Pinned Integrity', 'All pinned activities preserved with data');
                }
            }
        }

        // =====================================================================
        // N. TRANSITION/BUFFER CORRECTNESS
        // =====================================================================
        const CAT_N = 'N. Transitions';
        {
            let transCount = 0;
            let orphanedTrans = 0;

            for (const [bunk, slots] of Object.entries(assignments)) {
                if (!Array.isArray(slots)) continue;
                for (let i = 0; i < slots.length; i++) {
                    const s = slots[i];
                    if (!s || !s._isTransition) continue;
                    transCount++;

                    // Verify transition is adjacent to a real activity
                    const prev = i > 0 ? slots[i - 1] : null;
                    const next = i < slots.length - 1 ? slots[i + 1] : null;
                    const hasPrevActivity = prev && !prev._isTransition && prev._activity;
                    const hasNextActivity = next && !next._isTransition && next._activity;
                    if (!hasPrevActivity && !hasNextActivity) {
                        orphanedTrans++;
                    }
                }
            }

            if (transCount === 0) {
                skip(CAT_N, 'Transitions', 'No transition/buffer entries');
            } else {
                pass(CAT_N, 'Transition Count', `${transCount} transition entries`);
                if (orphanedTrans > 0) {
                    warn(CAT_N, 'Orphaned Transitions', `${orphanedTrans} transition(s) not adjacent to any activity`);
                } else {
                    pass(CAT_N, 'Transition Adjacency', 'All transitions properly adjacent to activities');
                }
            }
        }

        printReport('GENERATION QUALITY AUDIT');
        return _auditResults;
    }

    // Alias for backward compatibility
    async function stressTest(options = {}) {
        return generationAudit({ generate: true, ...options });
    }

    // =========================================================================
    // TAB WALKTHROUGH — Switch every tab and check for errors
    // =========================================================================

    async function tabWalkthrough() {
        console.log('%c🚶 TAB WALKTHROUGH — Switching through all tabs', 'color:#8B5CF6;font-size:16px;font-weight:bold');

        const tabs = [
            'setup', 'locations', 'fields', 'special_activities',
            'leagues', 'specialty-leagues', 'master-scheduler',
            'daily-adjustments', 'schedule', 'camper-locator',
            'report', 'print', 'updates', 'helper'
        ];

        const results = [];
        startErrorCapture();

        for (const tabId of tabs) {
            _capturedErrors = [];

            try {
                if (typeof window.showTab === 'function') {
                    window.showTab(tabId);
                } else {
                    // Manual tab switch
                    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
                    document.getElementById(tabId)?.classList.add('active');
                }

                // Wait for any async init
                await new Promise(r => setTimeout(r, 300));

                const errors = [..._capturedErrors];
                const container = document.getElementById(tabId);
                const hasContent = container && container.innerHTML.trim().length > 50;

                if (errors.length === 0 && hasContent) {
                    results.push({ tab: tabId, status: '✅', errors: 0, hasContent: true });
                    console.log(`  ✅ ${tabId} — OK (${container.innerHTML.length} chars)`);
                } else if (errors.length > 0) {
                    results.push({ tab: tabId, status: '❌', errors: errors.length, hasContent });
                    console.log(`  ❌ ${tabId} — ${errors.length} error(s):`);
                    errors.forEach(e => console.log(`      ${e.substring(0, 120)}`));
                } else {
                    results.push({ tab: tabId, status: '⚠️', errors: 0, hasContent: false });
                    console.log(`  ⚠️ ${tabId} — No content rendered`);
                }
            } catch (e) {
                results.push({ tab: tabId, status: '❌', errors: 1, hasContent: false });
                console.log(`  ❌ ${tabId} — Exception: ${e.message}`);
            }
        }

        stopErrorCapture();

        // Switch back to setup
        if (typeof window.showTab === 'function') {
            window.showTab('setup');
        }

        const passing = results.filter(r => r.status === '✅').length;
        console.log(`\n📊 ${passing}/${tabs.length} tabs loaded cleanly`);

        return results;
    }

    // =========================================================================
    // LEGACY v1.0 FUNCTIONS (preserved)
    // =========================================================================

    async function fullReport() {
        const dateKey = getCurrentDateKey();

        console.log('\n');
        console.log('╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║          🔍 CAMPISTRY DIAGNOSTIC REPORT v2.0                      ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝');
        console.log('Generated:', new Date().toISOString());
        console.log('Date Key:', dateKey);
        console.log('');

        // Section 1: Modules
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
            'MultiSchedulerSystem': window.MultiSchedulerSystem,
            'DivisionTimesSystem': window.DivisionTimesSystem,
            'GlobalFieldLocks': window.GlobalFieldLocks,
            'RotationEngine': window.RotationEngine,
            'CampistrySecurity': window.CampistrySecurity,
            'totalSolverEngine': window.totalSolverEngine,
            'SchedulerCoreUtils': window.SchedulerCoreUtils,
            'RainyDayManager': window.activateRainyDayMode ? { loaded: true } : null,
            'PinnedPreservation': window.capturePinnedActivities ? { loaded: true } : null,
        };

        for (const [name, module] of Object.entries(modules)) {
            const status = module ? '✅ Loaded' : '❌ Missing';
            const version = module?.version || module?.VERSION || '';
            console.log(`  ${name}: ${status} ${version}`);
        }
        console.log('');

        // Section 2: User & Permissions
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 2. USER & PERMISSIONS                                           │');
        console.log('└─────────────────────────────────────────────────────────────────┘');

        console.log('  Camp ID:', window.AccessControl?.getCampId?.() || window.CampistryDB?.getCampId?.() || 'unknown');
        console.log('  Role:', window.AccessControl?.getCurrentRole?.() || window.CampistryDB?.getRole?.() || 'unknown');
        const editableDivs = window.AccessControl?.getEditableDivisions?.() || [];
        console.log('  Editable Divisions:', editableDivs.length ? editableDivs.join(', ') : 'none');
        console.log('  All Divisions:', Object.keys(window.divisions || {}).join(', ') || 'none');
        console.log('');

        // Section 3: Window Globals
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 3. WINDOW GLOBALS                                               │');
        console.log('└─────────────────────────────────────────────────────────────────┘');

        console.log('  currentScheduleDate:', window.currentScheduleDate || 'not set');
        console.log('  divisions:', Object.keys(window.divisions || {}).length, 'divisions');
        console.log('  globalBunks:', (window.globalBunks || []).length, 'bunks');
        console.log('  scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('  leagueAssignments:', Object.keys(window.leagueAssignments || {}).length, 'bunks');
        console.log('  divisionTimes:', Object.keys(window.divisionTimes || {}).length, 'divisions');
        console.log('  unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('  activityProperties:', Object.keys(window.activityProperties || {}).length, 'entries');
        console.log('  isRainyDay:', window.isRainyDay || false);
        console.log('  Demo Mode:', window.__CAMPISTRY_DEMO_MODE__ || false);
        console.log('');

        // Section 4: Local Storage
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 4. LOCAL STORAGE                                                │');
        console.log('└─────────────────────────────────────────────────────────────────┘');

        const localData = getLocalStorageData(dateKey);
        if (localData && !localData.error) {
            console.log('  scheduleAssignments:', Object.keys(localData.scheduleAssignments || {}).length, 'bunks');
            console.log('  leagueAssignments:', Object.keys(localData.leagueAssignments || {}).length, 'bunks');
            console.log('  unifiedTimes:', (localData.unifiedTimes || []).length, 'slots');
        } else {
            console.log('  No data for', dateKey);
        }
        console.log('');

        // Section 5: Cloud Data
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 5. CLOUD DATA                                                   │');
        console.log('└─────────────────────────────────────────────────────────────────┘');

        const cloudData = await getCloudData(dateKey);
        if (Array.isArray(cloudData)) {
            console.log('  Records found:', cloudData.length);
            cloudData.forEach((record, idx) => {
                const bunks = Object.keys(record.schedule_data?.scheduleAssignments || {});
                console.log(`  Record #${idx + 1}: ${record.scheduler_name || 'unknown'} — ${bunks.length} bunks — ${(record.divisions || []).join(', ')}`);
            });
        } else {
            console.log('  Error:', cloudData?.error || 'unknown');
        }
        console.log('');

        // Section 6: Data Consistency
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 6. DATA CONSISTENCY                                             │');
        console.log('└─────────────────────────────────────────────────────────────────┘');

        const windowBunkCount = Object.keys(window.scheduleAssignments || {}).length;
        const localBunkCount = localData ? Object.keys(localData.scheduleAssignments || {}).length : 0;
        let cloudBunkCount = 0;
        if (Array.isArray(cloudData)) {
            const cloudBunks = new Set();
            cloudData.forEach(r => Object.keys(r.schedule_data?.scheduleAssignments || {}).forEach(b => cloudBunks.add(b)));
            cloudBunkCount = cloudBunks.size;
        }

        console.log(`  Window: ${windowBunkCount} | localStorage: ${localBunkCount} | Cloud: ${cloudBunkCount}`);
        if (windowBunkCount === localBunkCount && localBunkCount === cloudBunkCount) {
            console.log('  ✅ All sources consistent');
        } else {
            console.log('  ⚠️ INCONSISTENCY — sources differ');
        }
        console.log('');

        // Section 7: Quick Actions
        console.log('┌─────────────────────────────────────────────────────────────────┐');
        console.log('│ 7. QUICK ACTIONS                                                │');
        console.log('└─────────────────────────────────────────────────────────────────┘');
        console.log('');
        console.log('  // Full expo audit:');
        console.log('  await window.CampistryDiag.expoAudit()');
        console.log('');
        console.log('  // Tab walkthrough:');
        console.log('  await window.CampistryDiag.tabWalkthrough()');
        console.log('');
        console.log('  // Stress test (generate + validate):');
        console.log('  await window.CampistryDiag.stressTest()');
        console.log('');
        console.log('  // Force reload from cloud:');
        console.log('  await window.ScheduleOrchestrator.loadSchedule()');
        console.log('');
        console.log('  // Force save to cloud:');
        console.log('  await window.ScheduleOrchestrator.saveSchedule(null, null, {immediate: true})');
        console.log('');
    }

    // Legacy helpers
    function checkBunkOwnership(bunkId) {
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const inWindow = !!assignments[bunkId];
        const owningDivision = Object.entries(divisions).find(([, d]) => (d.bunks || []).includes(bunkId))?.[0] || 'none';
        const canEdit = window.AccessControl?.canEditBunk?.(bunkId) ?? true;
        return { bunkId, inWindow, division: owningDivision, canEdit };
    }

    async function checkCloudRecordForBunk(bunkId) {
        const dateKey = getCurrentDateKey();
        const cloudData = await getCloudData(dateKey);
        if (!Array.isArray(cloudData)) return [];
        return cloudData.filter(r => r.schedule_data?.scheduleAssignments?.[bunkId] !== undefined);
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.CampistryDiag = {
        // v2.0 Expo Audit
        expoAudit,
        quickCheck,
        auditCategory,
        stressTest,
        generationAudit,
        tabWalkthrough,

        // v1.0 Legacy (preserved)
        fullReport,
        checkBunkOwnership,
        checkCloudRecordForBunk,
        getLocalStorageData,
        getCloudData,
        getCurrentDateKey,

        // Version
        version: VERSION,
    };

    console.log('🔍 Campistry Diagnostics v2.0 loaded.');
    console.log('   → await CampistryDiag.expoAudit()              Full 14-category system audit');
    console.log('   → await CampistryDiag.generationAudit()         Deep schedule quality audit (on existing schedule)');
    console.log('   → await CampistryDiag.generationAudit({generate:true})  Generate + audit in one shot');
    console.log('   → await CampistryDiag.quickCheck()              Fast critical checks');
    console.log('   → await CampistryDiag.tabWalkthrough()          Switch & test every tab');
    console.log('   → await CampistryDiag.fullReport()              Legacy diagnostic report');

})();
