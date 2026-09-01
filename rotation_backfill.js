// =========================================================================
// rotation_backfill.js — One-shot rotation-memory reconcile/backfill
// =========================================================================
// Rebuilds the camp's rotation memory from the saved schedules (the source
// of truth) so every machine scores rotation on complete history:
//
//   1. Hydrates local day-data from cloud daily_schedules (90-day window)
//   2. For every saved day, derives rotation counts with the EXACT rules
//      RotationCloud.save uses (shared RotationCloud.deriveCounts) and
//      diffs them against the stored rotation_counts rows for that date
//   3. Heals every date that is missing or divergent in the cloud
//      (delete-then-upsert per date — idempotent, safe to re-run)
//   4. Rebuilds local historicalCounts from the full day-data, reloads the
//      cloud counts, and re-primes the rotation engine's history cache
//
// Safety: NEVER deletes cloud data for a date whose local copy derives to
// zero activities while the cloud has rows — that signature means the local
// copy is degraded (stripped/partial), and the cloud rows are kept.
//
// CONSOLE USAGE (from flow.html):
//   backfillRotationMemory()                 → reconcile + heal + report
//   backfillRotationMemory({ dryRun: true }) → report only, change nothing
// =========================================================================

(function () {
    'use strict';

    function flattenCloudDate(cloudDateObj) {
        // {bunk: {activity: count}} → {'bunk|activity': count}
        var flat = {};
        Object.keys(cloudDateObj || {}).forEach(function (bunk) {
            var acts = cloudDateObj[bunk] || {};
            Object.keys(acts).forEach(function (act) {
                flat[bunk + '|' + act] = acts[act];
            });
        });
        return flat;
    }

    function mapsEqual(a, b) {
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) {
            if (a[ka[i]] !== b[ka[i]]) return false;
        }
        return true;
    }

    // Local-timezone YYYY-MM-DD (toISOString would roll to the next day in
    // the evening for US camps — wrong boundary for "past dates").
    function localToday() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // ★ HR-8: rotation-epoch reader (Half Reset watermark). The reconcile must
    // never treat pre-epoch cloud rows as drift to heal, never re-upsert
    // pre-epoch dates into rotation_counts, and never rebuild pre-epoch counts
    // — otherwise the daily auto-reconcile would resurrect the reset history.
    function getRotationEpoch() {
        try {
            if (window.SchedulerCoreUtils && typeof window.SchedulerCoreUtils.getRotationEpoch === 'function') {
                return window.SchedulerCoreUtils.getRotationEpoch();
            }
            var e = window.loadGlobalSettings ? window.loadGlobalSettings('rotationEpoch') : null;
            var d = (typeof e === 'string') ? e : (e && e.date);
            return (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
        } catch (_) { return null; }
    }

    window.backfillRotationMemory = async function (opts) {
        opts = opts || {};
        var dryRun = !!opts.dryRun;
        // pastOnly: only reconcile dates strictly BEFORE today (local). Used by
        // the automatic run so it never touches a day that is actively being
        // generated or edited (today / tomorrow-being-built-tonight).
        var pastOnly = !!opts.pastOnly;
        var silent = !!opts.silent;
        var report = { hydrated: false, dates: {}, healed: [], skippedDegraded: [], ok: [], errors: [] };
        var t0 = Date.now();

        console.log('%c🔧 [Backfill] Rotation memory reconcile ' + (dryRun ? '(DRY RUN — no writes)' : '(live)') + (pastOnly ? ' [past dates only]' : '') + ' starting…', 'color:#f59e0b;font-weight:bold;');

        if (!window.RotationCloud || !window.RotationCloud.load || !window.RotationCloud.deriveCounts) {
            console.error('[Backfill] RotationCloud not available — open this from flow.html after login.');
            return null;
        }

        // ---- 1. Pull every saved day from cloud daily_schedules into local
        try {
            if (window.hydrateLocalStorageFromCloud) {
                report.hydrated = await window.hydrateLocalStorageFromCloud(true);
                console.log('[Backfill] Local day-data hydrated from cloud: ' + report.hydrated);
            } else {
                console.warn('[Backfill] hydrateLocalStorageFromCloud unavailable — using local day-data as-is');
            }
        } catch (e) {
            report.errors.push('hydrate: ' + (e.message || e));
            console.warn('[Backfill] Hydrate failed, continuing with local data:', e);
        }

        // ---- 2. Diff every local day against stored cloud rotation_counts
        var allDaily = (window.loadAllDailyData && window.loadAllDailyData()) || {};
        var dateRe = /^\d{4}-\d{2}-\d{2}$/;
        var dates = Object.keys(allDaily).filter(function (d) { return dateRe.test(d); }).sort();
        if (pastOnly) {
            var _cut = localToday();
            dates = dates.filter(function (d) { return d < _cut; });
        }
        // ★ HR-8: restrict the reconcile universe to post-epoch dates. Kept
        // pre-epoch schedules (and any pre-epoch rotation_counts rows) are
        // archive — they must be neither healed nor re-upserted.
        var _hrEpoch = getRotationEpoch();
        if (_hrEpoch) {
            dates = dates.filter(function (d) { return d >= _hrEpoch; });
        }
        if (dates.length === 0) {
            console.error('[Backfill] No local day-data found even after hydrate — nothing to reconcile.');
            return report;
        }

        var cloud = await window.RotationCloud.load(true);
        var countsByDate = (cloud && cloud.countsByDate) || {};

        var toHeal = [];
        dates.forEach(function (dateKey) {
            var day = allDaily[dateKey] || {};
            var derived = window.RotationCloud.deriveCounts(day.scheduleAssignments || {});
            var stored = flattenCloudDate(countsByDate[dateKey]);
            var dTotal = Object.keys(derived).length, sTotal = Object.keys(stored).length;
            var status;
            if (dTotal === 0 && sTotal > 0) {
                // Degraded local copy — cloud knows more than local derives. Keep cloud.
                status = 'SKIP (local copy degraded — keeping ' + sTotal + ' cloud records)';
                report.skippedDegraded.push(dateKey);
            } else if (dTotal === 0 && sTotal === 0) {
                status = 'empty (no rotation activities)';
                report.ok.push(dateKey);
            } else if (mapsEqual(derived, stored)) {
                status = 'in sync (' + sTotal + ' records)';
                report.ok.push(dateKey);
            } else {
                status = 'NEEDS HEAL (derived ' + dTotal + ' vs stored ' + sTotal + ' records)';
                toHeal.push(dateKey);
            }
            report.dates[dateKey] = status;
            if (!silent || status.indexOf('NEEDS HEAL') === 0 || status.indexOf('SKIP') === 0) {
                console.log('[Backfill] ' + dateKey + ': ' + status);
            }
        });

        // ---- 3. Heal divergent/missing dates (sequential, idempotent)
        if (toHeal.length === 0) {
            console.log('%c[Backfill] ✅ Cloud rotation_counts already matches every saved day — nothing to heal.', 'color:#10b981;font-weight:bold;');
        } else if (dryRun) {
            console.log('%c[Backfill] DRY RUN: would heal ' + toHeal.length + ' date(s): ' + toHeal.join(', '), 'color:#f59e0b;font-weight:bold;');
        } else {
            for (var i = 0; i < toHeal.length; i++) {
                var dk = toHeal[i];
                try {
                    var ok = await window.RotationCloud.save(dk, (allDaily[dk] || {}).scheduleAssignments || {});
                    if (ok) { report.healed.push(dk); console.log('[Backfill] ✅ Healed ' + dk); }
                    else { report.errors.push('save failed: ' + dk); console.warn('[Backfill] ⚠️ Save reported failure for ' + dk); }
                } catch (e) {
                    report.errors.push(dk + ': ' + (e.message || e));
                    console.warn('[Backfill] ⚠️ Heal failed for ' + dk + ':', e);
                }
            }
        }

        // ---- 4. Rebuild local stores + re-prime the rotation engine
        if (!dryRun) {
            try {
                if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.rebuildHistoricalCounts) {
                    window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
                    console.log('[Backfill] historicalCounts rebuilt from full day-data');
                }
            } catch (e) { report.errors.push('rebuildHistoricalCounts: ' + (e.message || e)); }
            try {
                var fresh = await window.RotationCloud.load(true);
                if (window.RotationEngine) {
                    if (window.RotationEngine.clearHistoryCache) window.RotationEngine.clearHistoryCache();
                    if (window.RotationEngine.rebuildAllHistory) window.RotationEngine.rebuildAllHistory();
                    if (window.RotationEngine.mergeCloudData) window.RotationEngine.mergeCloudData(fresh);
                }
                console.log('[Backfill] Rotation engine history re-primed from healed data');
            } catch (e) { report.errors.push('re-prime: ' + (e.message || e)); }
        }

        var secs = Math.round((Date.now() - t0) / 100) / 10;
        console.log('%c🔧 [Backfill] Done in ' + secs + 's — ' + report.ok.length + ' in sync, '
            + (dryRun ? toHeal.length + ' would heal' : report.healed.length + ' healed') + ', '
            + report.skippedDegraded.length + ' skipped (degraded local), '
            + report.errors.length + ' errors.', 'color:#10b981;font-weight:bold;');
        if (report.errors.length) console.warn('[Backfill] Errors:', report.errors);

        return report;
    };

    // =====================================================================
    // ★ AUTOMATIC RECONCILE — no console needed.
    // Once per day per device (localStorage throttle), shortly after the app
    // boots, verify past dates' rotation_counts against the saved schedules
    // and silently heal any drift. Guards:
    //   • kill switch: window.__autoRotationReconcile = false
    //   • waits for Supabase client + camp id (retries a few times, then
    //     gives up until next page load)
    //   • never runs while a generation is in progress or a trace is active
    //   • pastOnly — never touches today / a day being built tonight
    // =====================================================================
    var AUTO_KEY = 'campistry_rotation_reconcile_last';
    var _autoAttempts = 0;

    window.autoReconcileRotationMemory = async function (force) {
        if (window.__autoRotationReconcile === false) return null;
        if (window._generationInProgress || (window.GenTrace && window.GenTrace.active)) return null;
        if (!window.CampistryDB || !window.CampistryDB.getClient || !window.CampistryDB.getClient()
            || !window.CampistryDB.getCampId || !window.CampistryDB.getCampId()) {
            return null; // app not ready (logged out / booting)
        }
        if (!force) {
            try {
                if (localStorage.getItem(AUTO_KEY) === localToday()) return null; // already ran today
            } catch (e) { /* no localStorage — run anyway */ }
        }
        var rep = await window.backfillRotationMemory({ pastOnly: true, silent: true });
        try { localStorage.setItem(AUTO_KEY, localToday()); } catch (e) {}
        if (rep && rep.healed && rep.healed.length) {
            console.log('%c[Backfill] Auto-reconcile repaired rotation memory for: ' + rep.healed.join(', '), 'color:#10b981;font-weight:bold;');
        }
        return rep;
    };

    function _armAutoReconcile() {
        _autoAttempts++;
        window.autoReconcileRotationMemory().then(function (rep) {
            // null with attempts left = app not ready yet — retry in 60s
            if (rep === null && _autoAttempts < 5) setTimeout(_armAutoReconcile, 60000);
        }).catch(function () { /* never block boot on reconcile */ });
    }
    // Browser only (document guard keeps node test runs timer-free); wait 25s
    // past load so login, cloud sync, and first render settle first.
    if (typeof document !== 'undefined') {
        setTimeout(_armAutoReconcile, 25000);
    }

    console.log('[RotationBackfill] Ready — auto-verifies daily; manual: backfillRotationMemory() or the 🔧 Verify Memory button in Reports');
})();
