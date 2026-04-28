/* =========================================================================
 * Cloud Audit — paste into the browser console
 *
 * Usage:
 *   1. Open DevTools → Console
 *   2. Paste this entire script
 *   3. CloudAudit.run()    ← runs all checks and prints a report
 *
 * Assumes NOTHING works. Tests every cloud module from scratch:
 *   - Module existence
 *   - Auth / dependency state
 *   - CloudPermissions
 *   - ScheduleDB
 *   - ScheduleSync
 *   - Integration hooks wiring
 *   - Live Supabase load for current date
 * ========================================================================= */

(function () {
    'use strict';

    const results = [];

    function pass(label, detail) {
        results.push({ status: 'PASS', label, detail: detail || '' });
        console.log(`  ✅ PASS  ${label}${detail ? ' — ' + detail : ''}`);
    }
    function fail(label, detail) {
        results.push({ status: 'FAIL', label, detail: detail || '' });
        console.error(`  ❌ FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    }
    function warn(label, detail) {
        results.push({ status: 'WARN', label, detail: detail || '' });
        console.warn(`  ⚠️ WARN  ${label}${detail ? ' — ' + detail : ''}`);
    }

    function section(title) {
        console.groupCollapsed(`%c── ${title} ──`, 'font-weight:bold; color:#6366f1');
    }
    function sectionEnd() { console.groupEnd(); }

    // -------------------------------------------------------------------------
    // 1. MODULE EXISTENCE
    // -------------------------------------------------------------------------
    function checkModules() {
        section('1. Module existence');

        const required = [
            'ScheduleDB',
            'ScheduleSync',
            'CloudPermissions',
            'saveGlobalSettings',
            'loadGlobalSettings',
            'forceSyncToCloud',
            'verifiedScheduleSave',
            'forceLoadScheduleFromCloud',
            'saveGlobalFields',
            'getGlobalFields',
            'normalizeFieldForSave',
            'syncAllDataToCloud',
            'saveGlobalSpecialActivities',
            'getGlobalSpecialActivities',
            'getAllGlobalSports',
            'saveGlobalSkeletons',
            'getGlobalSkeletons',
            'saveGlobalLeagues',
            'getGlobalLeagues',
            'saveRainyDaySpecials',
            'getRainyDaySpecials',
            'saveSmartTileHistory',
            'getSmartTileHistory',
            'saveLeagueHistory',
            'getLeagueHistory',
            'saveSpecialtyLeagueHistory',
            'getSpecialtyLeagueHistory',
            'saveGlobalPrintTemplates',
            'getGlobalPrintTemplates',
        ];

        for (const name of required) {
            if (typeof window[name] !== 'undefined') {
                pass(`window.${name}`, typeof window[name]);
            } else {
                fail(`window.${name}`, 'not defined');
            }
        }

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 2. AUTH / DEPENDENCY STATE
    // -------------------------------------------------------------------------
    function checkAuth() {
        section('2. Auth / dependency state');

        // CampistryDB
        if (window.CampistryDB) {
            pass('window.CampistryDB', 'present');
            const client = window.CampistryDB.client || window.CampistryDB._client || window.CampistryDB.supabase;
            if (client) pass('CampistryDB.client', 'present');
            else warn('CampistryDB.client', 'cannot locate supabase client reference');
        } else {
            fail('window.CampistryDB', 'not defined — auth/DB layer missing');
        }

        // AccessControl
        if (window.AccessControl) {
            pass('window.AccessControl', 'present');
            const role = typeof window.AccessControl.getRole === 'function'
                ? window.AccessControl.getRole()
                : window.AccessControl.role;
            if (role) pass('AccessControl.role', String(role));
            else warn('AccessControl.role', 'could not read role');
        } else {
            fail('window.AccessControl', 'not defined — RBAC layer missing');
        }

        // Camp ID
        const campId = window.CAMP_ID || window.campId
            || (typeof window.loadGlobalSettings === 'function' && window.loadGlobalSettings()?.campId);
        if (campId) pass('camp_id', String(campId));
        else fail('camp_id', 'could not determine — check CAMP_ID or loadGlobalSettings().campId');

        // User ID
        let userId = null;
        try {
            userId = window.CampistryDB?.userId
                || window.CampistryDB?.currentUserId
                || window.CampistryDB?.session?.user?.id;
        } catch (_) {}
        if (userId) pass('user_id', String(userId).substring(0, 8) + '…');
        else warn('user_id', 'not accessible via CampistryDB — may be fine if not yet loaded');

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 3. HYDRATION STATE
    // -------------------------------------------------------------------------
    function checkHydration() {
        section('3. Hydration state');

        if (window.__CAMPISTRY_HYDRATED__) pass('__CAMPISTRY_HYDRATED__', 'true');
        else fail('__CAMPISTRY_HYDRATED__', 'false — loadGlobalSettings data not hydrated yet');

        if (window.__CAMPISTRY_CLOUD_READY__) pass('__CAMPISTRY_CLOUD_READY__', 'true');
        else warn('__CAMPISTRY_CLOUD_READY__', 'false — cloud not ready yet (may still be loading)');

        if (Array.isArray(window.divisions) && window.divisions.length > 0) {
            pass('window.divisions', `${window.divisions.length} divisions loaded`);
        } else {
            warn('window.divisions', 'empty or missing — settings may not be hydrated');
        }

        if (window.currentScheduleDate) pass('window.currentScheduleDate', String(window.currentScheduleDate));
        else warn('window.currentScheduleDate', 'not set — date picker may not have fired yet');

        if (window.scheduleAssignments && typeof window.scheduleAssignments === 'object') {
            const keys = Object.keys(window.scheduleAssignments).length;
            pass('window.scheduleAssignments', `${keys} top-level keys`);
        } else {
            warn('window.scheduleAssignments', 'empty or missing — normal before first load');
        }

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 4. CLOUD PERMISSIONS
    // -------------------------------------------------------------------------
    function checkCloudPermissions() {
        section('4. CloudPermissions');

        const cp = window.CloudPermissions;
        if (!cp) { fail('CloudPermissions', 'not defined'); sectionEnd(); return; }
        pass('CloudPermissions', 'defined');

        // Frozen check
        if (Object.isFrozen(cp)) pass('CloudPermissions frozen', 'yes');
        else warn('CloudPermissions frozen', 'not frozen — may be monkey-patched');

        // Methods
        for (const method of ['getRole', 'hasFullAccess', 'getEditableBunks',
            'getEditableDivisions', 'canEditDate', 'isOwner', 'isAdmin']) {
            if (typeof cp[method] === 'function') pass(`CloudPermissions.${method}`, 'function');
            else fail(`CloudPermissions.${method}`, 'missing');
        }

        // Call them safely
        try {
            const role = cp.getRole();
            if (role) pass('CloudPermissions.getRole()', String(role));
            else warn('CloudPermissions.getRole()', 'returned falsy');
        } catch (e) { fail('CloudPermissions.getRole()', e.message); }

        try {
            const full = cp.hasFullAccess();
            pass('CloudPermissions.hasFullAccess()', String(full));
        } catch (e) { fail('CloudPermissions.hasFullAccess()', e.message); }

        try {
            const bunks = cp.getEditableBunks();
            if (Array.isArray(bunks)) pass('CloudPermissions.getEditableBunks()', `${bunks.length} bunks`);
            else warn('CloudPermissions.getEditableBunks()', 'non-array result: ' + typeof bunks);
        } catch (e) { fail('CloudPermissions.getEditableBunks()', e.message); }

        try {
            const divs = cp.getEditableDivisions();
            if (Array.isArray(divs)) pass('CloudPermissions.getEditableDivisions()', `${divs.length} divisions`);
            else warn('CloudPermissions.getEditableDivisions()', 'non-array result: ' + typeof divs);
        } catch (e) { fail('CloudPermissions.getEditableDivisions()', e.message); }

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 5. SCHEDULE DB
    // -------------------------------------------------------------------------
    function checkScheduleDB() {
        section('5. ScheduleDB');

        const db = window.ScheduleDB;
        if (!db) { fail('ScheduleDB', 'not defined'); sectionEnd(); return; }
        pass('ScheduleDB', 'defined');

        for (const method of ['isInitialized', 'getMyEditableBunks', 'getMyEditableDivisions',
            'loadSchedule', 'saveSchedule', 'deleteSchedule', 'diagnose']) {
            if (typeof db[method] === 'function') pass(`ScheduleDB.${method}`, 'function');
            else fail(`ScheduleDB.${method}`, 'missing');
        }

        try {
            const init = db.isInitialized();
            if (init) pass('ScheduleDB.isInitialized()', 'true');
            else warn('ScheduleDB.isInitialized()', 'false — call ScheduleDB.init() first');
        } catch (e) { fail('ScheduleDB.isInitialized()', e.message); }

        try {
            const bunks = db.getMyEditableBunks();
            if (Array.isArray(bunks)) pass('ScheduleDB.getMyEditableBunks()', `${bunks.length} bunks`);
            else warn('ScheduleDB.getMyEditableBunks()', 'non-array: ' + typeof bunks);
        } catch (e) { fail('ScheduleDB.getMyEditableBunks()', e.message); }

        try {
            const divs = db.getMyEditableDivisions();
            if (Array.isArray(divs)) pass('ScheduleDB.getMyEditableDivisions()', `${divs.length} divisions`);
            else warn('ScheduleDB.getMyEditableDivisions()', 'non-array: ' + typeof divs);
        } catch (e) { fail('ScheduleDB.getMyEditableDivisions()', e.message); }

        // Time serialization round-trip
        try {
            if (typeof window.normalizeFieldForSave === 'function') {
                const dummy = {
                    name: '__audit_test__',
                    activities: ['Test'],
                    available: true,
                    sharableWith: { type: 'not_sharable' },
                    limitUsage: { enabled: false },
                    timeRules: [{ type: 'Available', start: '9:00am', end: '11:00am' }],
                    rainyDayAvailable: false
                };
                const norm = window.normalizeFieldForSave(dummy);
                const r = norm.timeRules[0];
                if (r.startMin === 540 && r.endMin === 660) {
                    pass('normalizeFieldForSave time round-trip', `9:00am→${r.startMin}, 11:00am→${r.endMin}`);
                } else {
                    fail('normalizeFieldForSave time round-trip', `expected 540/660, got ${r.startMin}/${r.endMin}`);
                }
            } else {
                warn('normalizeFieldForSave', 'not available — skipping round-trip test');
            }
        } catch (e) { fail('normalizeFieldForSave round-trip', e.message); }

        // Merge test (no network)
        try {
            if (typeof db._mergeSchedules === 'function' || typeof db.mergeSchedules === 'function') {
                const merge = db._mergeSchedules || db.mergeSchedules;
                const cloud = { bunk1: { p1: 'Swimming' } };
                const local = { bunk2: { p1: 'Arts' } };
                const editableBunks = ['bunk2'];
                const merged = merge(cloud, local, editableBunks);
                const hasCloud = merged.bunk1?.p1 === 'Swimming';
                const hasLocal = merged.bunk2?.p1 === 'Arts';
                if (hasCloud && hasLocal) pass('ScheduleDB merge logic', 'cloud+local correctly merged');
                else fail('ScheduleDB merge logic', `cloud=${hasCloud}, local=${hasLocal}`);
            } else {
                warn('ScheduleDB merge', 'internal merge function not exposed — skipping merge unit test');
            }
        } catch (e) { fail('ScheduleDB merge', e.message); }

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 6. SCHEDULE SYNC
    // -------------------------------------------------------------------------
    function checkScheduleSync() {
        section('6. ScheduleSync');

        const ss = window.ScheduleSync;
        if (!ss) { fail('ScheduleSync', 'not defined'); sectionEnd(); return; }
        pass('ScheduleSync', 'defined');

        for (const method of ['getSyncStatus', 'isInitialized', 'subscribe',
            'unsubscribe', 'queueScheduleSave', 'processOfflineQueue', 'diagnose']) {
            if (typeof ss[method] === 'function') pass(`ScheduleSync.${method}`, 'function');
            else fail(`ScheduleSync.${method}`, 'missing');
        }

        try {
            const init = ss.isInitialized ? ss.isInitialized() : ss.initialized;
            if (init) pass('ScheduleSync.isInitialized()', 'true');
            else warn('ScheduleSync.isInitialized()', 'false — sync not started yet');
        } catch (e) { fail('ScheduleSync.isInitialized()', e.message); }

        try {
            const status = ss.getSyncStatus();
            if (status && typeof status === 'object') {
                pass('ScheduleSync.getSyncStatus()', 'returned object');
                if ('connected' in status) pass('status.connected', String(status.connected));
                else warn('status.connected', 'field missing');
                if ('online' in status) pass('status.online', String(status.online));
                else warn('status.online', 'field missing');
                if ('offlineQueueSize' in status || 'queueSize' in status) {
                    const qs = status.offlineQueueSize ?? status.queueSize ?? 0;
                    if (qs > 0) warn('offline queue', `${qs} items pending — will retry on reconnect`);
                    else pass('offline queue', '0 pending items');
                } else {
                    warn('offline queue size', 'field not in status — check getSyncStatus()');
                }
            } else {
                fail('ScheduleSync.getSyncStatus()', 'returned ' + typeof status);
            }
        } catch (e) { fail('ScheduleSync.getSyncStatus()', e.message); }

        try {
            const isOnline = navigator.onLine;
            pass('navigator.onLine', String(isOnline));
        } catch (e) { warn('navigator.onLine', e.message); }

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 7. INTEGRATION HOOKS WIRING
    // -------------------------------------------------------------------------
    function checkHooks() {
        section('7. Integration hooks wiring');

        // saveGlobalSettings authoritative handler
        const sgs = window.saveGlobalSettings;
        if (!sgs) { fail('saveGlobalSettings', 'not defined'); }
        else {
            pass('saveGlobalSettings', 'defined');
            if (sgs._isAuthoritativeHandler) pass('saveGlobalSettings._isAuthoritativeHandler', 'true');
            else warn('saveGlobalSettings._isAuthoritativeHandler', 'false — integration_hooks may not have loaded yet');

            if (sgs._cloudHelpersHooked) pass('saveGlobalSettings._cloudHelpersHooked', 'true');
            else warn('saveGlobalSettings._cloudHelpersHooked', 'false — cloud_sync_helpers may not have loaded yet');
        }

        // loadGlobalSettings
        if (typeof window.loadGlobalSettings === 'function') {
            try {
                const s = window.loadGlobalSettings();
                if (s && typeof s === 'object') pass('loadGlobalSettings()', `object with ${Object.keys(s).length} keys`);
                else warn('loadGlobalSettings()', 'returned empty or non-object');
            } catch (e) { fail('loadGlobalSettings()', e.message); }
        } else {
            fail('loadGlobalSettings', 'not a function');
        }

        // diagnoseScheduleSync
        if (typeof window.diagnoseScheduleSync === 'function') pass('diagnoseScheduleSync', 'function');
        else warn('diagnoseScheduleSync', 'not exposed — minor (used for debugging only)');

        // forceSyncToCloud
        if (typeof window.forceSyncToCloud === 'function') pass('forceSyncToCloud', 'function');
        else fail('forceSyncToCloud', 'missing');

        // verifiedScheduleSave
        if (typeof window.verifiedScheduleSave === 'function') pass('verifiedScheduleSave', 'function');
        else fail('verifiedScheduleSave', 'missing');

        // forceLoadScheduleFromCloud
        if (typeof window.forceLoadScheduleFromCloud === 'function') pass('forceLoadScheduleFromCloud', 'function');
        else fail('forceLoadScheduleFromCloud', 'missing');

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // 8. LIVE SUPABASE LOAD (async — runs after sync checks)
    // -------------------------------------------------------------------------
    async function checkLiveCloud() {
        section('8. Live Supabase load');

        if (!window.ScheduleDB || typeof window.ScheduleDB.loadSchedule !== 'function') {
            fail('live load', 'ScheduleDB.loadSchedule not available — skipping');
            sectionEnd();
            return;
        }

        const date = window.currentScheduleDate;
        if (!date) {
            warn('live load', 'no currentScheduleDate set — using today');
        }

        const testDate = date || new Date().toISOString().slice(0, 10);

        try {
            console.log(`    Attempting ScheduleDB.loadSchedule("${testDate}")…`);
            const result = await window.ScheduleDB.loadSchedule(testDate);

            if (result === null || result === undefined) {
                warn('live load', 'returned null/undefined — no schedule for this date yet (may be normal)');
            } else if (typeof result === 'object') {
                const keys = Object.keys(result).length;
                pass('live load', `returned object with ${keys} top-level keys for date ${testDate}`);
            } else {
                warn('live load', 'unexpected return type: ' + typeof result);
            }
        } catch (e) {
            // Distinguish permission errors from network errors
            if (e.message?.includes('permission') || e.message?.includes('RLS') || e.message?.includes('denied')) {
                fail('live load', `RLS/permission error: ${e.message}`);
            } else if (e.message?.includes('fetch') || e.message?.includes('network') || e.message?.includes('Failed')) {
                fail('live load', `Network error: ${e.message}`);
            } else {
                fail('live load', e.message);
            }
        }

        // Also test loadGlobalSettings round-trip against cloud
        if (typeof window.syncAllDataToCloud === 'function') {
            try {
                await window.syncAllDataToCloud();
                pass('syncAllDataToCloud()', 'ran without throwing');
            } catch (e) {
                fail('syncAllDataToCloud()', e.message);
            }
        }

        sectionEnd();
    }

    // -------------------------------------------------------------------------
    // MAIN
    // -------------------------------------------------------------------------
    async function run() {
        console.log('%c╔══════════════════════════════════════════════════╗', 'color:#6366f1;font-weight:bold');
        console.log('%c║           CLOUD AUDIT — campistry                ║', 'color:#6366f1;font-weight:bold');
        console.log('%c╚══════════════════════════════════════════════════╝', 'color:#6366f1;font-weight:bold');
        console.log('');

        checkModules();
        checkAuth();
        checkHydration();
        checkCloudPermissions();
        checkScheduleDB();
        checkScheduleSync();
        checkHooks();
        await checkLiveCloud();

        // Summary
        const passes = results.filter(r => r.status === 'PASS').length;
        const warns  = results.filter(r => r.status === 'WARN').length;
        const fails  = results.filter(r => r.status === 'FAIL').length;

        console.log('');
        console.log('%c─────────────────────────────────────────────────', 'color:#6366f1');
        console.log(`%cSUMMARY:  ✅ ${passes} passed   ⚠️ ${warns} warnings   ❌ ${fails} failed`,
            fails > 0 ? 'font-weight:bold;color:#ef4444'
                : warns > 0 ? 'font-weight:bold;color:#f59e0b'
                    : 'font-weight:bold;color:#22c55e');
        console.log('%c─────────────────────────────────────────────────', 'color:#6366f1');

        if (fails > 0) {
            console.log('%cFailed checks:', 'font-weight:bold;color:#ef4444');
            results.filter(r => r.status === 'FAIL').forEach(r =>
                console.log(`  ❌ ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
        }
        if (warns > 0) {
            console.log('%cWarnings:', 'font-weight:bold;color:#f59e0b');
            results.filter(r => r.status === 'WARN').forEach(r =>
                console.log(`  ⚠️ ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
        }

        console.log('');
        console.log('Full results available at: window.CloudAudit._last');
        window.CloudAudit._last = results;

        return { passes, warns, fails, results };
    }

    window.CloudAudit = { run, _last: null };
    console.log('CloudAudit loaded — call CloudAudit.run() to start');
})();
