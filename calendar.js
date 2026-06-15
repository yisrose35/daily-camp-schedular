// =================================================================
// calendar.js (FIXED v4.0 - CRITICAL DELETION FIX INTEGRATED)
// =================================================================
// 
// v4.0 CHANGES:
// - CRITICAL FIX: Scheduler deletion now removes bunks from ALL records
// - Integrated deleteMyBunksFromAllRecords() directly into this file
// - No external patches required
// - Full cloud + localStorage + window globals cleanup
//
// =================================================================
(function() {
    'use strict';
    console.log("🗓️ calendar.js v4.0 (DELETION FIX INTEGRATED) loaded");
    
    // ==========================================================
    // 1. STORAGE KEYS - UNIFIED
    // ==========================================================
    
    const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
    const DAILY_DATA_KEY = "campDailyData_v1";
    const ROTATION_HISTORY_KEY = "campRotationHistory_v1";
    const AUTO_SAVE_KEY = "campAutoSave_v2";
    const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";
    const SMART_TILE_SPECIAL_HISTORY_KEY = "smartTileSpecialHistory_v1";
    const LEAGUE_HISTORY_KEY = "campLeagueHistory_v2";
    const SPECIALTY_LEAGUE_HISTORY_KEY = "specialtyLeagueHistory_v1";
    const LEGACY_GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    const LEGACY_GLOBAL_REGISTRY_KEY = "campistry_global_registry";

    // ==========================================================
    // AUDIT LOGGING — fire-and-forget, silent on missing table
    // Run this SQL in Supabase to enable:
    //   CREATE TABLE IF NOT EXISTS camp_audit_log (
    //     id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    //     camp_id     text NOT NULL,
    //     user_id     text NOT NULL,
    //     user_role   text NOT NULL,
    //     action      text NOT NULL,
    //     details     jsonb,
    //     created_at  timestamptz DEFAULT now()
    //   );
    //   ALTER TABLE camp_audit_log ENABLE ROW LEVEL SECURITY;
    //   CREATE POLICY "Camp members can insert audit logs"
    //     ON camp_audit_log FOR INSERT
    //     WITH CHECK (camp_id = (SELECT camps.id FROM camps WHERE auth.uid() = camps.owner
    //                            OR EXISTS (SELECT 1 FROM camp_users WHERE camp_id = camps.id AND user_id = auth.uid())));
    // ==========================================================
    async function logAuditEvent(action, details = {}) {
        try {
            const client = window.CampistryDB?.getClient?.() || window.supabase;
            const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
            const userId = window.CampistryDB?.getUserId?.() || window.AccessControl?.getCurrentUser?.()?.id;
            const role = window.AccessControl?.getCurrentRole?.() || 'unknown';
            if (!client || !campId || !userId) return;
            await client.from('camp_audit_log').insert({
                camp_id: campId,
                user_id: userId,
                user_role: role,
                action,
                details
            });
        } catch (_) {
            // Silent — table may not exist yet
        }
    }
    
    // ==========================================================
    // Helper — formatted date YYYY-MM-DD
    // ==========================================================
    function getTodayString(date = new Date()) {
        date.setHours(12, 0, 0, 0);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // ==========================================================
    // Helper — Check localStorage quota
    // ==========================================================
    function getLocalStorageUsage() {
        let total = 0;
        try {
            for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    total += (localStorage[key].length * 2); // UTF-16 = 2 bytes per char
                }
            }
        } catch (e) {
            console.warn("Could not calculate localStorage usage:", e);
        }
        return total;
    }
    
    function isLocalStorageNearQuota() {
        const usage = getLocalStorageUsage();
        const estimatedQuota = 5 * 1024 * 1024; // 5MB typical limit
        return usage > (estimatedQuota * 0.9); // 90% full
    }
    
    function safeLocalStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                console.warn(`⚠️ localStorage quota exceeded for key: ${key}`);
                // Try to free up space by removing auto-save cache
                if (key !== AUTO_SAVE_KEY) {
                    try {
                        localStorage.removeItem(AUTO_SAVE_KEY);
                        console.log("🗑️ Cleared auto-save cache to free space");
                        localStorage.setItem(key, value);
                        return true;
                    } catch (e2) {
                        console.error("Still cannot save after clearing auto-save:", e2);
                    }
                }
                return false;
            }
            throw e;
        }
    }
    
    // ==========================================================
    // 2. INITIALIZE CALENDAR
    // ==========================================================
    window.currentScheduleDate = getTodayString();
    let datePicker = null;
    
    function onDateChanged() {
    const newDate = datePicker.value;
    if (!newDate) return;
    
    const oldDate = window.currentScheduleDate;
    // ★★★ FIX (date round-trip drift): DO NOT update window.currentScheduleDate
    // here. integration_hooks's input-change handler will set it AFTER the
    // old date is saved and the new date is loaded. Setting it eagerly
    // caused stale-memory saves to overwrite the new date's cloud row.
    // We expose the pending date via a transition flag so any code that
    // needs the upcoming date can read it explicitly.
    window._pendingDateTransition = { from: oldDate, to: newDate, startedAt: Date.now() };

    console.log('🗓️ Date changed:', oldDate, '→', newDate);

    // ★★★ CRITICAL: Dispatch event so orchestrator loads from cloud ★★★
    window.dispatchEvent(new CustomEvent('campistry-date-changed', {
        detail: {
            dateKey: newDate,
            oldDateKey: oldDate
        }
    }));
    
    // These are still needed for non-schedule modules
    window.initDailyAdjustments?.();
    if (document.getElementById('master-scheduler')?.classList.contains('active')) {
        window.initMasterScheduler?.();
    }
}
    
    // ==========================================================
    // 3. DAILY DATA API
    // ==========================================================
    
    // In-memory cache for loadAllDailyData. Reading + JSON.parsing this blob is
    // ~10ms when localStorage is near quota; the solver calls this from inside
    // canBlockFit on every candidate evaluation (~10k+ times per generate),
    // which used to be 130+ seconds of pure parse cost. Cache by raw-string
    // identity so any external setItem (which produces a different raw string)
    // automatically invalidates on the next read.
    let _dailyDataCacheRaw = null;
    let _dailyDataCacheParsed = null;
    let _dailyDataMemoryOverride = null;
    window.invalidateDailyDataCache = function() {
        _dailyDataCacheRaw = null;
        _dailyDataCacheParsed = null;
    };
    window.setDailyDataMemoryOverride = function(data) {
        _dailyDataMemoryOverride = data;
        _dailyDataCacheRaw = null;
        _dailyDataCacheParsed = null;
    };
    window.loadAllDailyData = function() {
        if (_dailyDataMemoryOverride) return _dailyDataMemoryOverride;
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw === _dailyDataCacheRaw && _dailyDataCacheParsed !== null) {
                return _dailyDataCacheParsed;
            }
            const parsed = raw ? JSON.parse(raw) : {};
            _dailyDataCacheRaw = raw;
            _dailyDataCacheParsed = parsed;
            // ★ Seed secondary-save hashes for all dates loaded from disk so
            // the next saveGlobalSettings call can compare against this
            // baseline and skip cloud writes for unchanged dates.
            try { window._seedSecondarySaveHashes?.(parsed); } catch (_) {}
            return parsed;
        } catch {
            return {};
        }
    };
    
    window.loadCurrentDailyData = function() {
        const all = window.loadAllDailyData();
        const date = window.currentScheduleDate;
        if (!all[date]) {
            all[date] = {
                scheduleAssignments: {},
                leagueAssignments: {},
                leagueRoundState: {},
                leagueDayCounters: {},
                bunkActivityOverrides: [],
                overrides: {
                    fields: [],
                    bunks: [],
                    leagues: []
                }
            };
        }
        all[date].leagueDayCounters = all[date].leagueDayCounters || {};
        // ★ FUTURE-DATE RESOURCE PERSISTENCE: fill per-date resource overrides saved
        // via the reliable app1 path (mirrors skeleton/trips). The daily_schedules sync
        // SKIPS dates with no generated schedule, so a maintenance / field-unavailable
        // note set today for a FUTURE date never synced through the schedule path. Here
        // we fill ONLY-WHEN-MISSING so a real schedule's resources are never overwritten.
        try {
            var _rgs = window.loadGlobalSettings && window.loadGlobalSettings();
            var _rbd = _rgs && _rgs.app1 && _rgs.app1.dailyResourcesByDate && _rgs.app1.dailyResourcesByDate[date];
            if (_rbd && typeof _rbd === 'object') {
                var _hasContent = function (v) {
                    if (v === undefined || v === null) return false;
                    if (Array.isArray(v)) return v.length > 0;
                    if (typeof v === 'object') return Object.keys(v).some(function (k) {
                        var vv = v[k];
                        if (Array.isArray(vv)) return vv.length > 0;
                        if (vv && typeof vv === 'object') return Object.keys(vv).length > 0;
                        return vv !== undefined && vv !== null && vv !== false;
                    });
                    return !!v;
                };
                Object.keys(_rbd).forEach(function (rk) {
                    if (!_hasContent(all[date][rk])) all[date][rk] = _rbd[rk];
                });
            }
        } catch (_eRes) { /* ignore — non-fatal enrichment */ }
        window.currentDailyData = all[date];
        return window.currentDailyData;
    };

    window.loadPreviousDailyData = function() {
        try {
            const [Y, M, D] = window.currentScheduleDate.split('-').map(Number);
            const dt = new Date(Y, M - 1, D, 12, 0, 0);
            dt.setDate(dt.getDate() - 1);
            const yesterday = getTodayString(dt);
            const all = window.loadAllDailyData();
            return all[yesterday] || {
                leagueDayCounters: {},
                leagueRoundState: {}
            };
        } catch {
            return {};
        }
    };
    
    window.saveCurrentDailyData = function(key, value) {
        if (!window.AccessControl?.canSave?.()) {
            console.warn('🔐 saveCurrentDailyData: permission denied (role:', window.AccessControl?.getCurrentRole?.(), ')');
            return;
        }
        try {
            const all = window.loadAllDailyData();
            const date = window.currentScheduleDate;
            if (!all[date]) all[date] = {};
            all[date][key] = value;
            
            // Add updated_at INSIDE the date entry, NOT at root level (root-level pollutes Object.keys)
all[date].updated_at = new Date().toISOString();
            
            // Update UI reference immediately
            window.currentDailyData = all[date];
            // 🟢 UNIFIED SAVING: Delegate to Bridge (Same way as Divisions)
            // 'daily_schedules' is the special key the bridge uses to bundle/unbundle this data
            // ★ Only push the bundle when this date has a MATERIALIZED schedule (≥1 real
            //   activity). An empty/preview payload — e.g. a resource-override sync firing
            //   on tab-focus before the schedule re-bundles (loadCurrentOverrides), or a
            //   future-date note — is rejected by the empty-save guard (all-empty-preview),
            //   which spammed the console and triggered verified-save retries. Per-date
            //   resource overrides still persist via the app1 mirror below; clearing a real
            //   day goes through delete, not an empty save — so skipping here loses nothing.
            var _saReal = false, _saScan = all[date] && all[date].scheduleAssignments;
            if (_saScan && typeof _saScan === 'object') {
                for (var _bk in _saScan) {
                    var _sl = _saScan[_bk];
                    if (_sl && typeof _sl === 'object') { for (var _sk in _sl) { if (_sl[_sk]) { _saReal = true; break; } } }
                    else if (_sl) { _saReal = true; }
                    if (_saReal) break;
                }
            }
            if (typeof window.saveGlobalSettings === 'function') {
                if (_saReal) {
                    console.log("☁️ Saving daily data via Bridge (Unified Flow)...");
                    window.saveGlobalSettings('daily_schedules', all);
                }
            } else {
                // Fallback if bridge is missing
                console.warn("⚠️ Bridge not found, falling back to local save");
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
            }

            // ★ FUTURE-DATE RESOURCE PERSISTENCE: mirror per-date RESOURCE overrides
            // (field/activity unavailable for scheduled maintenance, disabled sports,
            // disabled specialty leagues) into app1.dailyResourcesByDate and sync via the
            // reliable 'app1' path — the same route the per-date skeleton/trips use. The
            // daily_schedules sync above SKIPS dates with no generated schedule, so a
            // note set today for a FUTURE date would be lost on a fresh session/device.
            // This path round-trips through camp_state_kv so it's ready on the day.
            try {
                var _RES_KEYS = ['overrides', 'dailyDisabledSportsByField', 'dailyFieldAvailability', 'disabledSpecialtyLeagues'];
                if (_RES_KEYS.indexOf(key) > -1 && typeof window.loadGlobalSettings === 'function' && typeof window.saveGlobalSettings === 'function') {
                    var _sgs = window.loadGlobalSettings() || {};
                    if (!_sgs.app1) _sgs.app1 = {};
                    if (!_sgs.app1.dailyResourcesByDate) _sgs.app1.dailyResourcesByDate = {};
                    if (!_sgs.app1.dailyResourcesByDate[date]) _sgs.app1.dailyResourcesByDate[date] = {};
                    _sgs.app1.dailyResourcesByDate[date][key] = value;
                    window.saveGlobalSettings('app1', _sgs.app1);
                }
            } catch (_eResSave) { /* ignore — daily_schedules path above is the fallback */ }
        } catch (e) {
            console.error("Failed to save daily data:", e);
        }
    };
    
    // ==========================================================
    // 4. ROTATION HISTORY SYSTEMS
    // ==========================================================
    window.loadRotationHistory = function() {
        try {
            const d = localStorage.getItem(ROTATION_HISTORY_KEY);
            const hist = d ? JSON.parse(d) : {};
            hist.bunks = hist.bunks || {};
            hist.leagues = hist.leagues || {};
            return hist;
        } catch {
            return { bunks: {}, leagues: {} };
        }
    };
    
    window.saveRotationHistory = function(hist) {
        try {
            if (!hist || !hist.bunks || !hist.leagues) return;
            safeLocalStorageSet(ROTATION_HISTORY_KEY, JSON.stringify(hist));
            // Route through saveGlobalSettings so the value reaches IDB + Supabase.
            // The previous scheduleCloudSync() call only synced daily_schedules,
            // leaving rotationHistory localStorage-only — fairness scoring
            // collapsed on any second device or after cache clear.
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('rotationHistory', hist);
            }
        } catch (e) {
            console.error("Failed to save rotation history:", e);
        }
    };
    
    // ==========================================================
    // RESET ALL ACTIVITY / SPECIAL ROTATION
    // ==========================================================
    window.eraseRotationHistory = async function() {
        var _role = window.AccessControl?.getCurrentRole?.();
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('erase rotation history');
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // SCHEDULER: Clear rotation history only for assigned divisions
        // ═══════════════════════════════════════════════════════════════
        if (_role === 'scheduler') {
            var myDivisions = window.AccessControl?.getGeneratableDivisions?.() || [];
            if (myDivisions.length === 0) { alert("You don't have any divisions assigned."); return; }
            var myBunks = getBunksForDivisions(myDivisions);
            if (!confirm('Reset rotation history for your divisions (' + myDivisions.join(', ') + ')?\n\nThis cannot be undone.')) return;

            logAuditEvent('erase_rotation_history_partial', { divisions: myDivisions });
            try {
                console.log('🔄 Scheduler: erasing rotation history for', myDivisions);

                // Clear rotation_counts for our bunks only
                await window.RotationCloud?.clearForBunks?.(myBunks);

                // ★★★ CB-90: clear rotation-event completions for OUR bunks only
                // (scheduler scope) so a reset re-places events for them.
                try { window.RotationEvents?.clearAllCompleted?.(null, myBunks); } catch (e) { /* non-fatal */ }

                // Scrub rotationHistory.bunks for our bunks only
                var _rotHist = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
                var bunkSet = new Set(myBunks);
                Object.keys(_rotHist.bunks || {}).forEach(function(bk) {
                    if (bunkSet.has(bk)) delete _rotHist.bunks[bk];
                });
                window.saveRotationHistory?.(_rotHist);

                // Scrub historicalCounts for our bunks
                var _hist = window.loadGlobalSettings?.('historicalCounts') || {};
                Object.keys(_hist).forEach(function(bk) { if (bunkSet.has(bk)) delete _hist[bk]; });
                window.saveGlobalSettings?.('historicalCounts', _hist);

                // Scrub smartTileHistory for our bunks
                var _smartHist = JSON.parse(localStorage.getItem(SMART_TILE_HISTORY_KEY) || '{}');
                Object.keys(_smartHist).forEach(function(bk) { if (bunkSet.has(bk)) delete _smartHist[bk]; });
                safeLocalStorageSet(SMART_TILE_HISTORY_KEY, JSON.stringify(_smartHist));
                window.saveGlobalSettings?.('smartTileHistory', _smartHist);

                // ★★★ CB-71: scrub manualUsageOffsets for our bunks too. The owner
                // branch clears it, but the scheduler branch omitted it — so a manual
                // count offset (e.g. Swim=5 set in the analytics editor) survived the
                // reset and the new period still treated the activity as already-done.
                // (historicalCountedDates is date-keyed/global, intentionally left to
                // the owner — scoping it per-bunk is meaningless and would clobber
                // other schedulers' tracking.)
                var _muo = window.loadGlobalSettings?.('manualUsageOffsets') || {};
                Object.keys(_muo).forEach(function(bk) { if (bunkSet.has(bk)) delete _muo[bk]; });
                window.saveGlobalSettings?.('manualUsageOffsets', _muo);

                console.log('✅ Scheduler rotation history cleared for', myBunks.length, 'bunks');
                alert('Rotation history reset for your divisions!');
                window.location.reload();
            } catch (e) {
                console.error('Failed to reset scheduler rotation history:', e);
                alert('Error resetting history. Check console.');
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // OWNER/ADMIN: Clear everything
        // ═══════════════════════════════════════════════════════════════
        if (!confirm('Reset rotation history and League counters?\n\nThis action cannot be undone.')) return;

        logAuditEvent('erase_rotation_history');
        try {
            console.log("🔄 Erasing rotation history...");

            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);

            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing cloud keys for rotation history...");
                await window.clearCloudKeys([
                    'manualUsageOffsets',
                    'historicalCounts',
                    'historicalCountedDates',
                    'smartTileHistory',
                    'rotationHistory'
                ]);
            } else {
                window.saveGlobalSettings?.('manualUsageOffsets', {});
                window.saveGlobalSettings?.('historicalCounts', {});
                window.saveGlobalSettings?.('historicalCountedDates', {});
                window.saveGlobalSettings?.('smartTileHistory', {});
                window.saveGlobalSettings?.('rotationHistory', { bunks: {}, leagues: {} });

                if (typeof window.forceSyncToCloud === 'function') {
                    await window.forceSyncToCloud();
                }
            }

            // Clear rotation_counts table in Supabase
            await window.RotationCloud?.clearAll?.();

            // ★★★ CB-90: also wipe rotation-event completion stamps. Without this,
            // a full rotation-history reset left evt.completedBunks intact, so a
            // regenerated event permanently skipped every previously-marked bunk.
            try { window.RotationEvents?.clearAllCompleted?.(); } catch (e) { /* non-fatal */ }

            // Clear league round state
            window.leagueRoundState = {};
            window.saveGlobalSettings?.('leagueRoundState', {});

            console.log("✅ All rotation histories cleared.");
            alert("Activity History and Game Counters reset!");
            window.location.reload();
        } catch (e) {
            console.error("Failed to reset history:", e);
            alert("Error resetting history. Check console.");
        }
    };
    
    // ==========================================================
    // START NEW HALF
    // ==========================================================
    window.startNewHalf = async function() {
        var _role = window.AccessControl?.getCurrentRole?.();
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('start new half');
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // SCHEDULER: Scoped new half — only their assigned divisions
        // ═══════════════════════════════════════════════════════════════
        if (_role === 'scheduler') {
            var myDivisions = window.AccessControl?.getGeneratableDivisions?.() || [];
            if (myDivisions.length === 0) { alert("You don't have any divisions assigned."); return; }
            var myBunks = getBunksForDivisions(myDivisions);
            var confirmed = confirm(
                "🏕️ START NEW HALF for your divisions (" + myDivisions.join(', ') + ")\n\n" +
                "This will reset:\n" +
                "  ✓ Activity usage counters for your bunks\n" +
                "  ✓ Rotation history for your bunks\n" +
                "  ✓ Daily schedules for your divisions\n\n" +
                "Other divisions will NOT be affected.\n\n" +
                "Are you sure?"
            );
            if (!confirmed) return;

            logAuditEvent('start_new_half_partial', { divisions: myDivisions });
            try {
                console.log('⭐ SCHEDULER NEW HALF for:', myDivisions);

                // 1. Delete our bunks from all schedule records
                var client = window.CampistryDB?.getClient?.() || window.supabase;
                var campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                if (client && campId && myBunks.length > 0) {
                    var { data: allRecords } = await client.from('daily_schedules').select('*').eq('camp_id', campId);
                    for (var record of (allRecords || [])) {
                        var scheduleData = record.schedule_data || {};
                        var assignments = { ...(scheduleData.scheduleAssignments || {}) };
                        var leagues = { ...(scheduleData.leagueAssignments || {}) };
                        var modified = false;
                        myBunks.forEach(function(bunk) {
                            if (assignments[bunk] !== undefined) { delete assignments[bunk]; modified = true; }
                            if (leagues[bunk] !== undefined) { delete leagues[bunk]; }
                        });
                        if (!modified) continue;
                        if (Object.keys(assignments).length === 0) {
                            await client.from('daily_schedules').delete().eq('id', record.id);
                        } else {
                            await client.from('daily_schedules')
                                .update({ schedule_data: { ...scheduleData, scheduleAssignments: assignments, leagueAssignments: leagues }, updated_at: new Date().toISOString() })
                                .eq('id', record.id);
                        }
                    }
                }

                // 2. Clear localStorage — remove only our bunks from each date
                var allData = window.loadAllDailyData?.() || {};
                Object.keys(allData).forEach(function(dk) {
                    var dateData = allData[dk];
                    if (!dateData) return;
                    myBunks.forEach(function(bunk) {
                        if (dateData.scheduleAssignments) delete dateData.scheduleAssignments[bunk];
                        if (dateData.leagueAssignments) delete dateData.leagueAssignments[bunk];
                    });
                });
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(allData));

                // 3. Clear rotation counts for our bunks
                await window.RotationCloud?.clearForBunks?.(myBunks);

                // ★★★ CB-90: clear rotation-event completions for our bunks (scheduler scope)
                try { window.RotationEvents?.clearAllCompleted?.(null, myBunks); } catch (e) { /* non-fatal */ }

                // 4. Scrub local rotation history for our bunks
                var bunkSet = new Set(myBunks);
                var _rotHist = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
                Object.keys(_rotHist.bunks || {}).forEach(function(bk) { if (bunkSet.has(bk)) delete _rotHist.bunks[bk]; });
                window.saveRotationHistory?.(_rotHist);

                var _hist = window.loadGlobalSettings?.('historicalCounts') || {};
                Object.keys(_hist).forEach(function(bk) { if (bunkSet.has(bk)) delete _hist[bk]; });
                window.saveGlobalSettings?.('historicalCounts', _hist);

                var _smartHist = JSON.parse(localStorage.getItem(SMART_TILE_HISTORY_KEY) || '{}');
                Object.keys(_smartHist).forEach(function(bk) { if (bunkSet.has(bk)) delete _smartHist[bk]; });
                safeLocalStorageSet(SMART_TILE_HISTORY_KEY, JSON.stringify(_smartHist));
                window.saveGlobalSettings?.('smartTileHistory', _smartHist);

                // ★★★ CB-71: scrub manualUsageOffsets for our bunks (owner branch
                // clears it; scheduler branch omitted it → stale offset carried into
                // the new half).
                var _muoNH = window.loadGlobalSettings?.('manualUsageOffsets') || {};
                Object.keys(_muoNH).forEach(function(bk) { if (bunkSet.has(bk)) delete _muoNH[bk]; });
                window.saveGlobalSettings?.('manualUsageOffsets', _muoNH);

                clearBunksFromGlobals(myBunks);

                console.log('⭐ SCHEDULER NEW HALF COMPLETE');
                alert('New half started for your divisions!\n\nReloading page...');
                window.location.reload();
            } catch (e) {
                console.error('Failed to start new half:', e);
                alert('Error starting new half. Check console.');
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // OWNER/ADMIN: Full new half
        // ═══════════════════════════════════════════════════════════════
        if (!confirm(
            "🏕️ START NEW HALF\n\n" +
            "This will reset:\n" +
            "  ✓ Bunk activity usage counters\n" +
            "  ✓ Smart Tile rotation history\n" +
            "  ✓ Regular League game counters (back to Game 1)\n" +
            "  ✓ Specialty League game counters (back to Game 1)\n" +
            "  ✓ All generated daily schedules\n\n" +
            "This will NOT change:\n" +
            "  • Fields configuration\n" +
            "  • Special Activities setup\n" +
            "  • Master Schedule templates\n" +
            "  • Divisions and Bunks\n\n" +
            "Are you sure you want to start a new half?"
        )) return;

        logAuditEvent('start_new_half');
        try {
            console.log("=".repeat(50));
            console.log("⭐ STARTING NEW HALF - Resetting Counters ⭐");
            console.log("=".repeat(50));

            // Clear localStorage
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            localStorage.removeItem(LEAGUE_HISTORY_KEY);
            localStorage.removeItem(SPECIALTY_LEAGUE_HISTORY_KEY);
            localStorage.removeItem(DAILY_DATA_KEY);

            // ★★★ CRITICAL: Directly delete all daily_schedules records from Supabase ★★★
            {
                const client = window.CampistryDB?.getClient?.() || window.supabase;
                const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                if (client && campId) {
                    console.log("🗑️ New half: deleting all daily_schedules from Supabase...");
                    const { error } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('camp_id', campId);
                    if (error) console.error('🗑️ New half: Supabase delete error:', error);
                    else console.log("🗑️ New half: Supabase daily_schedules cleared");
                }
            }

            // ★★★ CRITICAL: Clear ALL cloud keys including new league history keys ★★★
            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing cloud keys for new half...");
                await window.clearCloudKeys([
                    'leagueRoundState',
                    'leagueHistory',
                    'specialtyLeagueHistory',
                    'daily_schedules',
                    'manualUsageOffsets',
                    'historicalCounts',
                    'historicalCountedDates',
                    'smartTileHistory',
                    'rotationHistory'
                ]);
                console.log("☁️ Cloud keys cleared");
            } else {
                window.saveGlobalSettings?.('leagueRoundState', {});
                window.saveGlobalSettings?.('leagueHistory', {});
                window.saveGlobalSettings?.('specialtyLeagueHistory', {});
                window.saveGlobalSettings?.('daily_schedules', {});
                window.saveGlobalSettings?.('manualUsageOffsets', {});
                window.saveGlobalSettings?.('historicalCounts', {});
                window.saveGlobalSettings?.('historicalCountedDates', {});
                window.saveGlobalSettings?.('smartTileHistory', {});
                window.saveGlobalSettings?.('rotationHistory', { bunks: {}, leagues: {} });

                if (typeof window.forceSyncToCloud === 'function') {
                    await window.forceSyncToCloud();
                }
            }

            // Clear rotation_counts table in Supabase
            await window.RotationCloud?.clearAll?.();

            // ★★★ CB-90: wipe rotation-event completion stamps for the new half too
            // (otherwise a regenerated event skips every bunk marked done last half).
            try { window.RotationEvents?.clearAllCompleted?.(); } catch (e) { /* non-fatal */ }

            // Reset league standings and playoff state
            try {
                const _leagues = window.leaguesByName || {};
                Object.values(_leagues).forEach(function(lg) {
                    if (lg) { lg.standings = {}; if (lg.playoff) lg.playoff = { enabled: false, rounds: [] }; }
                });
                if (typeof window.saveLeaguesData === 'function') window.saveLeaguesData();
                const _specLeagues = window.specialtyLeagues || {};
                Object.values(_specLeagues).forEach(function(lg) {
                    if (lg) { lg.standings = {}; if (lg.playoff) lg.playoff = { enabled: false, rounds: [] }; }
                });
                if (typeof window.saveSpecialtyLeaguesData === 'function') window.saveSpecialtyLeaguesData();
            } catch (e) { console.warn('[startNewHalf] league standings reset failed:', e); }

            console.log("⭐ NEW HALF RESET COMPLETE ⭐");

            alert(
                "✅ New Half Started!\n\n" +
                "All activity and league counters have been reset.\n" +
                "The first game generated will now be Game 1.\n\n" +
                "Reloading page..."
            );
            window.location.reload();
        } catch (e) {
            console.error("Failed to start new half:", e);
            alert("Error starting new half. Check console for details.");
        }
    };
    
    // ==========================================================
    // 5. ERASE ALL DATA
    // ==========================================================
    function setupEraseAll() {
        const btn = document.getElementById("eraseAllBtn");
        if (!btn) return;
        
        btn.onclick = async function() {
            // OWNER ONLY - This is the nuclear option
            const role = window.AccessControl?.getCurrentRole?.();
            if (role !== 'owner') {
                window.AccessControl?.showPermissionDenied?.('erase all camp data');
                return;
            }
            if (!confirm("Erase ALL settings, schedules, and rotation histories?\nThis cannot be undone.")) return;
            
            btn.disabled = true;
            btn.textContent = "Erasing...";
            
            try {
                console.log("🗑️ Starting full data erase...");
                
                const localOnlyKeys = [
                    DAILY_DATA_KEY,
                    ROTATION_HISTORY_KEY,
                    AUTO_SAVE_KEY,
                    SMART_TILE_HISTORY_KEY,
                    SMART_TILE_SPECIAL_HISTORY_KEY,
                    LEAGUE_HISTORY_KEY,
                    SPECIALTY_LEAGUE_HISTORY_KEY,
                    "campSchedulerData",
                    "fixedActivities_v2",
                    "leagues",
                    "camp_league_round_state",
                    "camp_league_sport_rotation",
                    "scheduleAssignments",
                    "leagueAssignments"
                ];
                
                localOnlyKeys.forEach(key => {
                    localStorage.removeItem(key);
                    console.log("  Removed:", key);
                });
                
                // ★★★ CRITICAL: Use resetCloudState to properly clear cloud ★★★
                if (typeof window.resetCloudState === 'function') {
                    console.log("☁️ Resetting cloud state...");
                    const success = await window.resetCloudState();
                    console.log("☁️ Cloud reset result:", success ? "SUCCESS" : "FAILED");
                    
                    if (!success) {
                        alert("⚠️ Warning: Cloud sync may have failed.\nLocal data has been cleared, but cloud data may persist.");
                    }
                } else {
                    console.log("⚠️ resetCloudState not available, using fallback...");
                    
                    const emptyState = {
                        divisions: {},
                        bunks: [],
                        app1: {
                            divisions: {}, bunks: [], fields: [], specialActivities: [],
                            allSports: [], bunkMetaData: {}, sportMetaData: {},
                            savedSkeletons: {}, skeletonAssignments: {}
                        },
                        locationZones: {},
                        pinnedTileDefaults: {},
                        leaguesByName: {},
                        leagueRoundState: {},
                        leagueHistory: {},
                        specialtyLeagueHistory: {},
                        daily_schedules: {}, // ★ CRITICAL: Set empty to clear cloud
                        updated_at: new Date().toISOString()
                    };
                    
                    const emptyJSON = JSON.stringify(emptyState);
                    safeLocalStorageSet(UNIFIED_CACHE_KEY, emptyJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_SETTINGS_KEY, emptyJSON);
                    safeLocalStorageSet("CAMPISTRY_LOCAL_CACHE", emptyJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
                        divisions: {},
                        bunks: []
                    }));
                    
                    if (typeof window.forceSyncToCloud === 'function') {
                        await window.forceSyncToCloud();
                    }
                }
                
                console.log("✅ Full data erase complete");
                window.location.reload();
                
            } catch (e) {
                console.error("Erase failed:", e);
                btn.disabled = false;
                btn.textContent = "Erase All Camp Data";
                alert("Error erasing data: " + e.message);
            }
        };
    }
    
    // ==========================================================
    // 6. ★★★ CRITICAL FIX: HELPER FUNCTIONS FOR SCHEDULER DELETE ★★★
    // ==========================================================
    
    /**
     * Get the list of bunk IDs that the current user can edit
     * based on their assigned divisions.
     */
    function getMyEditableBunks() {
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() ||
                                 window.PermissionsDB?.getEditableDivisions?.() || [];

        const divisions = window.divisions || {};
        const bunks = [];

        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                bunks.push(...divInfo.bunks);
            }
        }

        return bunks;
    }

    function getMyAssignedBunks() {
        const assignedDivisions = window.AccessControl?.getGeneratableDivisions?.() || [];
        const divisions = window.divisions || {};
        const bunks = [];
        for (const divName of assignedDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                bunks.push(...divInfo.bunks);
            }
        }
        return bunks;
    }

    function getBunksForDivisions(divisionNames) {
        const divisions = window.divisions || {};
        const bunks = [];
        for (const divName of divisionNames) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                bunks.push(...divInfo.bunks);
            }
        }
        return bunks;
    }

    async function deleteBunksFromAllRecords(dateKey, bunksToDelete) {
        console.log('🗑️ deleteBunksFromAllRecords called for:', dateKey, 'bunks:', bunksToDelete.length);
        const client = window.CampistryDB?.getClient?.() || window.supabase;
        const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
        if (!client || !campId) return { success: false, error: 'Database not available' };
        if (bunksToDelete.length === 0) return { success: true, message: 'No bunks to delete' };

        try {
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules').select('*')
                .eq('camp_id', campId).eq('date_key', dateKey);
            if (loadError) return { success: false, error: loadError.message };
            if (!allRecords || allRecords.length === 0) return { success: true, message: 'No cloud records' };

            const bunkSet = new Set(bunksToDelete);
            let recordsModified = 0, recordsDeleted = 0, bunksRemoved = 0;
            // ★★★ CB-74: track per-record write failures. Previously a mid-loop
            // delete/update error was only counted-or-not and the function ALWAYS
            // returned success:true, so the caller cleared local state and reported
            // success while the cloud still held those bunks → cloud/local diverge
            // and the "deleted" bunks resurrect from cloud on the next load.
            let writeFailures = 0, firstWriteError = null;

            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...(scheduleData.scheduleAssignments || {}) };
                const leagues = { ...(scheduleData.leagueAssignments || {}) };
                let modified = false;
                for (const bunk of bunksToDelete) {
                    if (assignments[bunk] !== undefined) { delete assignments[bunk]; modified = true; bunksRemoved++; }
                    if (leagues[bunk] !== undefined) { delete leagues[bunk]; }
                }
                if (!modified) continue;
                if (Object.keys(assignments).length === 0) {
                    const { error } = await client.from('daily_schedules').delete().eq('id', record.id);
                    if (!error) recordsDeleted++; else { writeFailures++; firstWriteError = firstWriteError || error.message; }
                } else {
                    const { error } = await client.from('daily_schedules')
                        .update({ schedule_data: { ...scheduleData, scheduleAssignments: assignments, leagueAssignments: leagues }, updated_at: new Date().toISOString() })
                        .eq('id', record.id);
                    if (!error) recordsModified++; else { writeFailures++; firstWriteError = firstWriteError || error.message; }
                }
            }
            if (writeFailures > 0) {
                return {
                    success: false,
                    error: (firstWriteError || 'Some records failed to update') + ' (' + writeFailures + ' record(s) failed — cloud may be partially deleted)',
                    recordsModified, recordsDeleted, bunksRemoved, writeFailures
                };
            }
            return { success: true, recordsModified, recordsDeleted, bunksRemoved };
        } catch (e) {
            console.error('🗑️ deleteBunksFromAllRecords exception:', e);
            return { success: false, error: e.message };
        }
    }

    function clearBunksFromGlobals(bunksToDelete) {
        const bunkSet = new Set(bunksToDelete);
        if (window.scheduleAssignments) {
            bunkSet.forEach(bunk => { delete window.scheduleAssignments[bunk]; });
        }
        if (window.leagueAssignments) {
            bunkSet.forEach(bunk => { delete window.leagueAssignments[bunk]; });
        }
    }

    function clearBunksFromLocalStorage(dateKey, bunksToDelete) {
        try {
            const all = window.loadAllDailyData();
            const dateData = all[dateKey];
            if (!dateData) return;
            const bunkSet = new Set(bunksToDelete);
            if (dateData.scheduleAssignments) { bunkSet.forEach(bunk => { delete dateData.scheduleAssignments[bunk]; }); }
            if (dateData.leagueAssignments) { bunkSet.forEach(bunk => { delete dateData.leagueAssignments[bunk]; }); }
            safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
        } catch (e) {
            console.error('🗑️ Failed to clear bunks from localStorage:', e);
        }
    }
    
    /**
     * ★★★ THE CRITICAL FIX ★★★
     * 
     * Delete the current user's bunks from ALL schedule records for a date.
     * 
     * WHY THIS IS NECESSARY:
     * - The owner might save a record containing ALL bunks (including scheduler's)
     * - Simply deleting the scheduler's own record doesn't remove their bunks
     *   from the owner's record
     * - On reload, the owner's record loads → scheduler's bunks reappear!
     * 
     * THE FIX:
     * - Load ALL records for the date
     * - Remove the scheduler's bunks from EVERY record
     * - Update or delete each modified record
     */
    async function deleteMyBunksFromAllRecords(dateKey) {
        console.log('🗑️ [CRITICAL FIX] deleteMyBunksFromAllRecords called for:', dateKey);
        
        const client = window.CampistryDB?.getClient?.() || window.supabase;
        const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
        
        if (!client || !campId) {
            console.error('🗑️ Cannot delete: missing client or campId');
            return { success: false, error: 'Database not available' };
        }
        
        // Step 1: Get my editable bunks
        const myBunks = getMyEditableBunks();
        console.log('🗑️ My bunks to delete:', myBunks);
        
        if (myBunks.length === 0) {
            console.log('🗑️ No bunks assigned to delete');
            return { success: true, message: 'No bunks assigned' };
        }
        
        try {
            // Step 2: Load ALL records for this date
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            
            if (loadError) {
                console.error('🗑️ Failed to load records:', loadError);
                return { success: false, error: loadError.message };
            }
            
            if (!allRecords || allRecords.length === 0) {
                console.log('🗑️ No records found in cloud');
                return { success: true, message: 'No cloud records' };
            }
            
            console.log('🗑️ Found', allRecords.length, 'records to process');
            
            // Step 3: For EACH record, remove my bunks
            const myBunkSet = new Set(myBunks);
            let recordsModified = 0;
            let recordsDeleted = 0;
            let bunksRemoved = 0;
            
            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...(scheduleData.scheduleAssignments || {}) };
                const leagues = { ...(scheduleData.leagueAssignments || {}) };
                
                const bunksBefore = Object.keys(assignments).length;
                
                // Remove my bunks from this record
                let modified = false;
                for (const bunk of myBunks) {
                    if (assignments[bunk] !== undefined) {
                        delete assignments[bunk];
                        modified = true;
                        bunksRemoved++;
                    }
                    if (leagues[bunk] !== undefined) {
                        delete leagues[bunk];
                    }
                }
                
                const bunksAfter = Object.keys(assignments).length;
                console.log(`🗑️ Record ${record.scheduler_name || record.scheduler_id?.substring(0, 8)}: ${bunksBefore} → ${bunksAfter} bunks`);
                
                if (!modified) {
                    console.log('🗑️   Skipping - no changes needed');
                    continue;
                }
                
                // If record is now empty, delete it entirely
                if (bunksAfter === 0) {
                    console.log('🗑️   Record now empty, deleting...');
                    const { error: deleteError } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('id', record.id);
                    
                    if (deleteError) {
                        console.error('🗑️   Delete failed:', deleteError);
                    } else {
                        recordsDeleted++;
                        console.log('🗑️   ✅ Deleted empty record');
                    }
                } else {
                    // Update the record with bunks removed
                    console.log('🗑️   Updating record with', bunksAfter, 'remaining bunks...');
                    
                    const updatedData = {
                        ...scheduleData,
                        scheduleAssignments: assignments,
                        leagueAssignments: leagues
                    };
                    
                    const { error: updateError } = await client
                        .from('daily_schedules')
                        .update({
                            schedule_data: updatedData,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', record.id);
                    
                    if (updateError) {
                        console.error('🗑️   Update failed:', updateError);
                    } else {
                        recordsModified++;
                        console.log('🗑️   ✅ Updated record');
                    }
                }
            }
            
            console.log(`🗑️ Delete complete: ${recordsModified} modified, ${recordsDeleted} deleted, ${bunksRemoved} bunks removed`);
            
            return {
                success: true,
                recordsModified,
                recordsDeleted,
                bunksRemoved
            };
            
        } catch (e) {
            console.error('🗑️ deleteMyBunksFromAllRecords exception:', e);
            return { success: false, error: e.message };
        }
    }
    
    /**
     * Clear the current user's bunks from window globals
     */
    function clearMyBunksFromGlobals() {
        const myBunks = new Set(getMyEditableBunks());
        
        if (window.scheduleAssignments) {
            myBunks.forEach(bunk => {
                delete window.scheduleAssignments[bunk];
            });
        }
        
        if (window.leagueAssignments) {
            myBunks.forEach(bunk => {
                delete window.leagueAssignments[bunk];
            });
        }
        
        console.log('🗑️ Cleared', myBunks.size, 'bunks from window globals');
    }
    
    /**
     * Clear the current user's bunks from localStorage
     */
    function clearMyBunksFromLocalStorage(dateKey) {
        try {
            const all = window.loadAllDailyData();
            const dateData = all[dateKey];
            
            if (!dateData) return;
            
            const myBunks = new Set(getMyEditableBunks());
            
            if (dateData.scheduleAssignments) {
                myBunks.forEach(bunk => {
                    delete dateData.scheduleAssignments[bunk];
                });
            }
            
            if (dateData.leagueAssignments) {
                myBunks.forEach(bunk => {
                    delete dateData.leagueAssignments[bunk];
                });
            }
            
            safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
            console.log('🗑️ Cleared my bunks from localStorage');
        } catch (e) {
            console.error('🗑️ Failed to clear localStorage:', e);
        }
    }
    
    /**
     * Reload remaining schedule data from cloud after deletion
     */
    async function reloadRemainingData(dateKey) {
        if (!window.ScheduleDB?.loadSchedule) {
            console.log('🗑️ ScheduleDB not available for reload');
            return;
        }
        
        try {
            const result = await window.ScheduleDB.loadSchedule(dateKey);
            
            if (result?.success && result.data) {
                // Merge remaining data into window globals
                window.scheduleAssignments = result.data.scheduleAssignments || {};
                window.leagueAssignments = result.data.leagueAssignments || {};
                window._scheduleAssignmentsDate = dateKey; // owner stamp coherent with delete-reload (cross-date guard)

                // Update localStorage
                const all = window.loadAllDailyData();
                all[dateKey] = {
                    ...all[dateKey],
                    scheduleAssignments: result.data.scheduleAssignments || {},
                    leagueAssignments: result.data.leagueAssignments || {}
                };
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
                
                console.log('🗑️ Reloaded', Object.keys(result.data.scheduleAssignments || {}).length, 'bunks from remaining data');
            } else {
                console.log('🗑️ No remaining data after delete');
            }
        } catch (e) {
            console.error('🗑️ Failed to reload remaining data:', e);
        }
    }
    
    // ==========================================================
    // 7. ERASE CURRENT DAY - ★★★ CRITICAL FIX INTEGRATED ★★★
    // ==========================================================
    window.eraseCurrentDailyData = async function() {
        const dateKey = window.currentScheduleDate;
        const role = window.AccessControl?.getCurrentRole?.() || 
                    window.CampistryDB?.getRole?.() || 'viewer';
        
        console.log('🗑️ eraseCurrentDailyData called for:', dateKey, 'role:', role);
        
        // ═══════════════════════════════════════════════════════════════
        // SCHEDULER: Delete only their assigned divisions
        // ═══════════════════════════════════════════════════════════════
        if (role === 'scheduler') {
            const myDivisions = window.AccessControl?.getGeneratableDivisions?.() || [];

            if (myDivisions.length === 0) {
                alert("You don't have any divisions assigned.");
                return;
            }

            const confirmMsg = `Delete schedule for your divisions: ${myDivisions.join(', ')}?\n\n` +
                             `Other divisions' data will be preserved.`;

            if (!confirm(confirmMsg)) return;

            logAuditEvent('erase_today_partial', { dateKey, divisions: myDivisions });
            console.log('🗑️ Scheduler deleting assigned divisions:', myDivisions);

            const myBunks = getBunksForDivisions(myDivisions);
            const cloudResult = await deleteBunksFromAllRecords(dateKey, myBunks);

            if (!cloudResult?.success) {
                console.error('🗑️ Cloud delete failed:', cloudResult?.error);
                alert('Error deleting schedule: ' + (cloudResult?.error || 'Unknown error'));
                return;
            }

            clearBunksFromLocalStorage(dateKey, myBunks);
            clearBunksFromGlobals(myBunks);
            await reloadRemainingData(dateKey);

            if (window.RotationCloud?.save) {
                window.RotationCloud.save(dateKey, window.scheduleAssignments || {});
            }
        }
        // ═══════════════════════════════════════════════════════════════
        // OWNER/ADMIN: Delete everything
        // ═══════════════════════════════════════════════════════════════
        else if (window.AccessControl?.canEraseData?.()) {
            const confirmMsg = `Delete ALL schedule data for ${dateKey}?\n\n` +
                             `This will delete data from ALL schedulers and cannot be undone.`;
            
            if (!confirm(confirmMsg)) return;
            
            logAuditEvent('erase_today', { dateKey });
            console.log('🗑️ Owner/Admin: Full delete');
            
            // Delete from cloud using ScheduleDB
            if (window.ScheduleDB?.deleteSchedule) {
                console.log('🗑️ Calling ScheduleDB.deleteSchedule...');
                const result = await window.ScheduleDB.deleteSchedule(dateKey);
                console.log('🗑️ Full delete result:', result);
            } else {
                // Fallback: Direct delete
                const client = window.CampistryDB?.getClient?.() || window.supabase;
                const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                
                if (client && campId) {
                    const { error } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('camp_id', campId)
                        .eq('date_key', dateKey);
                    
                    if (error) {
                        console.error('🗑️ Direct delete error:', error);
                    }
                }
            }
            
            // Clear localStorage
            const all = window.loadAllDailyData();
            if (all[dateKey]) {
                delete all[dateKey];
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
            }
            
            // Clear ALL window globals
            window.scheduleAssignments = {};
            window.leagueAssignments = {};

            // ★ Delete this date's rotation counts from cloud
            if (window.RotationCloud?.deleteDate) {
                window.RotationCloud.deleteDate(dateKey);
            }
            // ★★★ CB-90: also clear THIS date's rotation-event completion stamps,
            // so a regen of the erased day re-places the event for those bunks
            // instead of treating them as already-done.
            try { window.RotationEvents?.clearCompletedForDate?.(dateKey); } catch (e) { /* non-fatal */ }
            // ★ Delete stale schedule_proposals for this date
            try {
                const _client = window.CampistryDB?.client || window.supabase;
                const _campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                if (_client && _campId) {
                    _client.from('schedule_proposals').delete()
                        .eq('camp_id', _campId).eq('date_key', dateKey).then(function() {});
                }
            } catch (e) { /* best-effort */ }
        }
        // ═══════════════════════════════════════════════════════════════
        // VIEWER: No permission
        // ═══════════════════════════════════════════════════════════════
        else {
            alert('You do not have permission to delete schedules.');
            return;
        }
        
        // ═══════════════════════════════════════════════════════════════
        // CLEAN LEAGUE HISTORY for the deleted date (regular + specialty)
        // ═══════════════════════════════════════════════════════════════
        window.SchedulerCoreLeagues?.cleanupDateFromHistory?.(dateKey);
        window.SchedulerCoreSpecialtyLeagues?.cleanupDateFromHistory?.(dateKey);

        // ═══════════════════════════════════════════════════════════════
        // REBUILD ROTATION COUNTS after delete
        // ═══════════════════════════════════════════════════════════════
        if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
            window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
            console.log('🗑️ Rebuilt historicalCounts after date deletion');
        }
        // Rebuild rotationHistory.bunks from remaining saved days so stale
        // timestamps from the deleted day don't bias the rotation engine.
        try {
            const _allDaily = window.loadAllDailyData?.() || {};
            const _rotHist = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
            // ★★★ CB-72: a scheduler's local loadAllDailyData holds ONLY their bunks,
            // so the unconditional `_rotHist.bunks = {}` full rebuild truncated every
            // other scheduler's rotation history (then saved the truncated map
            // globally). Scope the wipe+rebuild to the scheduler's own bunks; owner/
            // admin (who hold the full local cache) still rebuild everything.
            let _scopedBunkSet72 = null;
            if (role === 'scheduler') {
                const _myDivs72 = window.AccessControl?.getGeneratableDivisions?.() || [];
                const _myBunks72 = getBunksForDivisions(_myDivs72) || [];
                _scopedBunkSet72 = new Set(_myBunks72.map(String));
                Object.keys(_rotHist.bunks || {}).forEach(function (bk) {
                    if (_scopedBunkSet72.has(String(bk))) delete _rotHist.bunks[bk];
                });
            } else {
                _rotHist.bunks = {};
            }
            Object.entries(_allDaily).forEach(function ([dk, dayData]) {
                const _ts = new Date(dk + 'T12:00:00').getTime() || Date.now();
                const _sched = dayData?.scheduleAssignments || {};
                Object.keys(_sched).forEach(function (bk) {
                    if (_scopedBunkSet72 && !_scopedBunkSet72.has(String(bk))) return; // scheduler: only own bunks
                    (_sched[bk] || []).forEach(function (entry) {
                        if (entry?._activity && !entry.continuation && !entry._isTransition) {
                            const _aLower = entry._activity.toLowerCase();
                            if (_aLower !== 'free' && !_aLower.includes('transition')) {
                                if (!_rotHist.bunks[bk]) _rotHist.bunks[bk] = {};
                                if (!_rotHist.bunks[bk][entry._activity] || _rotHist.bunks[bk][entry._activity] < _ts) {
                                    _rotHist.bunks[bk][entry._activity] = _ts;
                                }
                            }
                        }
                    });
                });
            });
            window.saveRotationHistory?.(_rotHist);
        } catch (e) { console.warn('[calendar] rotationHistory rebuild after deletion failed:', e); }

        // ═══════════════════════════════════════════════════════════════
        // REFRESH UI
        // ═══════════════════════════════════════════════════════════════

        console.log('🗑️ Refreshing UI...');
        
        if (window.updateTable) {
            window.updateTable();
        }
        
        if (window.initScheduleSystem) {
            window.initScheduleSystem();
        }
        
        // Dispatch event for other modules
        window.dispatchEvent(new CustomEvent('campistry-schedule-deleted', {
            detail: { dateKey, role }
        }));
        
        console.log('🗑️ ✅ Erase complete');
    };
    
    // ==========================================================
    // 8. ERASE ALL SCHEDULE DAYS - ★ FIXED to sync deletion to cloud ★
    // ==========================================================
    window.eraseAllDailyData = async function() {
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('erase all daily data');
            return;
        }
        const role = window.AccessControl?.getCurrentRole?.();

        // ═══════════════════════════════════════════════════════════════
        // SCHEDULER: Delete only their assigned divisions across all dates
        // ═══════════════════════════════════════════════════════════════
        if (role === 'scheduler') {
            const myDivisions = window.AccessControl?.getGeneratableDivisions?.() || [];
            if (myDivisions.length === 0) {
                alert("You don't have any divisions assigned.");
                return;
            }

            const confirmMsg = `Delete ALL schedule data for your divisions (${myDivisions.join(', ')}) across ALL dates?\n\n` +
                              '⚠️ Other divisions\' data will be preserved.\n\n' +
                              'This action cannot be undone!';
            if (!confirm(confirmMsg)) return;

            logAuditEvent('erase_all_schedules_partial', { divisions: myDivisions });
            console.log('🗑️ Scheduler erasing assigned divisions across all dates:', myDivisions);

            try {
                const client = window.CampistryDB?.getClient?.() || window.supabase;
                const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                const myBunks = getBunksForDivisions(myDivisions);

                if (client && campId && myBunks.length > 0) {
                    const { data: allRecords, error: loadErr } = await client
                        .from('daily_schedules').select('*').eq('camp_id', campId);
                    if (loadErr) throw loadErr;

                    const bunkSet = new Set(myBunks);
                    for (const record of (allRecords || [])) {
                        const scheduleData = record.schedule_data || {};
                        const assignments = { ...(scheduleData.scheduleAssignments || {}) };
                        const leagues = { ...(scheduleData.leagueAssignments || {}) };
                        let modified = false;
                        myBunks.forEach(function(bunk) {
                            if (assignments[bunk] !== undefined) { delete assignments[bunk]; modified = true; }
                            if (leagues[bunk] !== undefined) { delete leagues[bunk]; }
                        });
                        if (!modified) continue;
                        if (Object.keys(assignments).length === 0) {
                            await client.from('daily_schedules').delete().eq('id', record.id);
                        } else {
                            await client.from('daily_schedules')
                                .update({ schedule_data: { ...scheduleData, scheduleAssignments: assignments, leagueAssignments: leagues }, updated_at: new Date().toISOString() })
                                .eq('id', record.id);
                        }
                    }
                }

                // Clear from localStorage — remove only our bunks from each date
                const allData = window.loadAllDailyData?.() || {};
                Object.keys(allData).forEach(function(dk) {
                    const dateData = allData[dk];
                    if (!dateData) return;
                    myBunks.forEach(function(bunk) {
                        if (dateData.scheduleAssignments) delete dateData.scheduleAssignments[bunk];
                        if (dateData.leagueAssignments) delete dateData.leagueAssignments[bunk];
                    });
                });
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(allData));

                clearBunksFromGlobals(myBunks);
                await reloadRemainingData(window.currentScheduleDate);

                console.log('✅ Scheduler division data erased across all dates');
                window.dispatchEvent(new CustomEvent('campistry-schedule-deleted', {
                    detail: { dateKey: '*', role }
                }));
                alert('Schedule data for your divisions has been deleted across all dates.');
                window.location.reload();
            } catch (e) {
                console.error('🗑️ Scheduler erase all failed:', e);
                alert('Error erasing data: ' + e.message);
            }
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // OWNER/ADMIN: Delete everything
        // ═══════════════════════════════════════════════════════════════
        const confirmMsg = 'Delete ALL schedule data for ALL dates?\n\n' +
                          '⚠️ This will permanently delete schedules from all schedulers for all dates.\n\n' +
                          'This action cannot be undone!';

        if (!confirm(confirmMsg)) return;

        logAuditEvent('erase_all_schedules');
        console.log("🗑️ Erasing all daily data...");

        try {
            // Delete all records from cloud
            const client = window.CampistryDB?.getClient?.() || window.supabase;
            const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();

            if (client && campId) {
                console.log('🗑️ Deleting all records from daily_schedules...');
                const { error } = await client
                    .from('daily_schedules')
                    .delete()
                    .eq('camp_id', campId);

                if (error) {
                    console.error('🗑️ Cloud delete error:', error);
                } else {
                    console.log('🗑️ Cloud delete successful');
                }
            }

            // Clear localStorage
            localStorage.removeItem(DAILY_DATA_KEY);

            // Also clear via bridge if available
            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing daily_schedules from cloud bridge...");
                await window.clearCloudKeys(['daily_schedules']);
            } else if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('daily_schedules', {});
                if (typeof window.forceSyncToCloud === 'function') {
                    await window.forceSyncToCloud();
                }
            }

            // Clear window globals
            window.scheduleAssignments = {};
            window.leagueAssignments = {};

            // Clear league gamesPerDate — all schedule-derived game counts are now stale
            window.SchedulerCoreLeagues?.clearAllGamesPerDate?.();
            window.SchedulerCoreSpecialtyLeagues?.clearAllGamesPerDate?.();

            // Clear cloud rotation counts
            window.RotationCloud?.clearAll?.();

            // Reset leagueRoundState — currentRound/sportRotationIndex are stale with no schedules
            window.leagueRoundState = {};
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('leagueRoundState', {});
            }

            // ★★★ CB-57: clear the rotation-history globalSettings keys too.
            // Erase-ALL wiped cloud rotation_counts + every daily schedule but
            // left historicalCounts / historicalCountedDates / rotationHistory /
            // manualUsageOffsets (and the swim/activity history mirrors) intact,
            // so the next generation double-counts against phantom history from
            // now-deleted days. Clear them in memory AND in globalSettings
            // (which mirrors to localStorage + queues the cloud KV write).
            ['historicalCounts', 'historicalCountedDates', 'rotationHistory', 'manualUsageOffsets', 'swimRotationHistory', 'activityHistory'].forEach(function (k) {
                try { window[k] = {}; } catch (_) {}
                try { if (typeof window.saveGlobalSettings === 'function') window.saveGlobalSettings(k, {}); } catch (_) {}
            });
            try { window.RotationEngine?.clearAllHistory?.(); } catch (_) {}
            // ★★★ CB-90: Erase-ALL must also wipe rotation-event completion stamps,
            // else a regenerated event skips every previously-marked bunk.
            try { window.RotationEvents?.clearAllCompleted?.(); } catch (_) {}

            console.log("✅ All daily data erased");

            // Notify other modules
            window.dispatchEvent(new CustomEvent('campistry-schedule-deleted', {
                detail: { dateKey: '*', role }
            }));

            alert('All schedule data has been deleted.');
            window.location.reload();

        } catch (e) {
            console.error('🗑️ Erase all failed:', e);
            alert('Error erasing data: ' + e.message);
        }
    };
    
    // ==========================================================
    // RE-INITIALIZE UI AFTER IMPORT
    // ==========================================================
    function reinitializeUI() {
        console.log("🔄 Re-initializing UI after import...");
        
        try {
            // Re-initialize global authority (divisions/bunks)
            if (typeof window.initGlobalAuthority === 'function') {
                window.initGlobalAuthority();
                console.log("  ✓ Global authority");
            }
            
            // Re-initialize app1 (Setup tab)
            if (typeof window.initApp1 === 'function') {
                window.initApp1();
                console.log("  ✓ App1 (Setup)");
            }
            
            // Re-initialize facilities tab
            if (typeof window.initFacilitiesTab === 'function') {
                window.initFacilitiesTab();
                console.log("  ✓ Facilities");
            }

            // Re-initialize zones tab
            if (typeof window.initZonesTab === 'function') {
                window.initZonesTab();
                console.log("  ✓ Zones");
            }
            
            // Re-initialize leagues
            if (typeof window.initLeaguesTab === 'function') {
                window.initLeaguesTab();
                console.log("  ✓ Leagues");
            } else if (typeof window.initLeagues === 'function') {
                window.initLeagues();
                console.log("  ✓ Leagues");
            }
            
            // Re-initialize specialty leagues
            if (typeof window.initSpecialtyLeagues === 'function') {
                window.initSpecialtyLeagues();
                console.log("  ✓ Specialty Leagues");
            }
            
            // Re-initialize master scheduler
            if (typeof window.initMasterScheduler === 'function') {
                window.initMasterScheduler();
                console.log("  ✓ Master Scheduler");
            }
            
            // Re-initialize daily adjustments
            if (typeof window.initDailyAdjustments === 'function') {
                window.initDailyAdjustments();
                console.log("  ✓ Daily Adjustments");
            }
            
            // Update schedule table if visible
            if (typeof window.updateTable === 'function') {
                window.updateTable();
                console.log("  ✓ Schedule Table");
            }
            
            console.log("✅ UI re-initialization complete!");
            
        } catch (e) {
            console.error("UI re-initialization error:", e);
            // Fall back to page reload if UI init fails
            console.log("⚠️ Falling back to page reload...");
            window.location.reload();
        }
    }
    
    // ==========================================================
    // 9. BACKUP / RESTORE
    // ==========================================================
    function exportAllData() {
        try {
            let globalSettings = window.loadGlobalSettings?.() || {};
            
            if (Object.keys(globalSettings).length === 0) {
                globalSettings = JSON.parse(localStorage.getItem(UNIFIED_CACHE_KEY) || "{}");
            }
            
            const colorIndex = globalSettings.divisionColorIndex || 0;
            
            const backup = {
                globalSettings: globalSettings,
                dailyData: JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || "{}"),
                rotationHistory: JSON.parse(localStorage.getItem(ROTATION_HISTORY_KEY) || "{}"),
                smartTileHistory: JSON.parse(localStorage.getItem(SMART_TILE_HISTORY_KEY) || "{}"),
                smartTileSpecialHistory: JSON.parse(localStorage.getItem(SMART_TILE_SPECIAL_HISTORY_KEY) || "{}"),
                leagueHistory: JSON.parse(localStorage.getItem(LEAGUE_HISTORY_KEY) || "{}"),
                specialtyLeagueHistory: JSON.parse(localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY) || "{}"),
                divisions: globalSettings.divisions || {},
                bunks: globalSettings.bunks || [],
                divisionColorIndex: colorIndex,
                exportVersion: 3,
                exportDate: new Date().toISOString()
            };
            
            const json = JSON.stringify(backup, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `campistry_backup_${getTodayString()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            console.log("✅ Export complete:", {
                divisions: Object.keys(backup.divisions).length,
                bunks: backup.bunks.length,
                colorIndex: colorIndex
            });
            
        } catch (e) {
            console.error("Export error:", e);
            alert("Export failed: " + e.message);
        }
    }
    window.__campistry_exportAllData = exportAllData;
    
    let _importInProgress = false;
    
    function handleFileSelect(e) {
        console.log("📁 handleFileSelect called, importInProgress:", _importInProgress);
        
        if (_importInProgress) {
            console.log("Import already in progress, ignoring duplicate trigger");
            return;
        }
        
        const file = e.target.files?.[0];
        console.log("📁 File from event:", file?.name);
        
        if (!file) {
            console.log("No file selected");
            return;
        }
        
        _importInProgress = true;
        console.log("📁 Starting import of:", file.name);
        
        const input = e.target;
        
        if (!confirm("Importing will overwrite ALL current data.\nProceed?")) {
            input.value = "";
            _importInProgress = false;
            console.log("📁 Import cancelled by user");
            return;
        }
        
        console.log("📥 User confirmed, reading file...");
        
        const reader = new FileReader();
        
        reader.onload = async function(evt) {
            console.log("📥 File read complete, parsing JSON...");
            try {
                const backup = JSON.parse(evt.target.result);
                
                console.log("📥 Importing backup version:", backup.exportVersion || 1);
                console.log("📥 Backup keys:", Object.keys(backup));
                
                // ⭐ Build unified state from backup
                let unifiedState = {};
                
                if (backup.globalSettings) {
                    unifiedState = { ...backup.globalSettings };
                    console.log("  ↳ Loaded globalSettings");
                }
                
                if (backup.divisions && Object.keys(backup.divisions).length > 0) {
                    unifiedState.divisions = backup.divisions;
                    console.log("  ↳ Loaded divisions:", Object.keys(backup.divisions).length);
                }
                if (backup.bunks && backup.bunks.length > 0) {
                    unifiedState.bunks = backup.bunks;
                    console.log("  ↳ Loaded bunks:", backup.bunks.length);
                }
                
                if (backup.divisionColorIndex !== undefined) {
                    unifiedState.divisionColorIndex = backup.divisionColorIndex;
                }
                
                // Handle legacy backups
                if (backup.globalRegistry) {
                    if (backup.globalRegistry.divisions) {
                        unifiedState.divisions = backup.globalRegistry.divisions;
                        console.log("  ↳ Loaded divisions from globalRegistry");
                    }
                    if (backup.globalRegistry.bunks) {
                        unifiedState.bunks = backup.globalRegistry.bunks;
                        console.log("  ↳ Loaded bunks from globalRegistry");
                    }
                }
                
                if (unifiedState.app1) {
                    if (unifiedState.app1.divisions && (!unifiedState.divisions || Object.keys(unifiedState.divisions).length === 0)) {
                        unifiedState.divisions = unifiedState.app1.divisions;
                        console.log("  ↳ Loaded divisions from app1");
                    }
                    if (unifiedState.app1.bunks && (!unifiedState.bunks || unifiedState.bunks.length === 0)) {
                        unifiedState.bunks = unifiedState.app1.bunks;
                        console.log("  ↳ Loaded bunks from app1");
                    }
                    if (unifiedState.app1.fields) {
                        unifiedState.fields = unifiedState.app1.fields;
                        console.log("  ↳ Loaded fields from app1");
                    }
                }
                
                // Restore daily data first (so setCloudState can pick it up if we decide to merge, 
                // but actually setCloudState mostly deals with unifiedState. 
                // We'll manually attach dailyData to unifiedState before calling setCloudState if we want it synced instantly)
                
                if (backup.dailyData) {
                    // Inject into unifiedState so setCloudState sees it and syncs it
                    unifiedState.daily_schedules = backup.dailyData;
                    // Also save locally just in case
                    safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(backup.dailyData));
                    console.log("  ↳ Restored daily data (injected for sync)");
                }
                // ⭐ Use setCloudState to properly update memory cache + cloud
                if (typeof window.setCloudState === 'function') {
                    console.log("☁️ Using setCloudState for import...");
                    const success = await window.setCloudState(unifiedState, true);
                    console.log("☁️ setCloudState result:", success ? "SUCCESS" : "FAILED");
                    
                    if (!success) {
                        console.warn("☁️ Cloud sync failed, but local data was saved");
                    }
                } else {
                    // Fallback: Direct localStorage writes
                    console.log("⚠️ setCloudState not available, using fallback...");
                    const unifiedJSON = JSON.stringify(unifiedState);
                    safeLocalStorageSet(UNIFIED_CACHE_KEY, unifiedJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_SETTINGS_KEY, unifiedJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
                        divisions: unifiedState.divisions || {},
                        bunks: unifiedState.bunks || []
                    }));
                    // ★ #V2-1 tail: CAMPISTRY_LOCAL_CACHE = cross-tab beacon only (value never
                    //   read; campGlobalSettings_v1 written above triggers the same listener).
                    safeLocalStorageSet("CAMPISTRY_LOCAL_CACHE", String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8));
                }
                
                if (backup.rotationHistory) {
                    safeLocalStorageSet(ROTATION_HISTORY_KEY, JSON.stringify(backup.rotationHistory));
                }
                if (backup.smartTileHistory) {
                    safeLocalStorageSet(SMART_TILE_HISTORY_KEY, JSON.stringify(backup.smartTileHistory));
                }
                if (backup.smartTileSpecialHistory) {
                    safeLocalStorageSet(SMART_TILE_SPECIAL_HISTORY_KEY, JSON.stringify(backup.smartTileSpecialHistory));
                }
                if (backup.leagueHistory) {
                    safeLocalStorageSet(LEAGUE_HISTORY_KEY, JSON.stringify(backup.leagueHistory));
                }
                if (backup.specialtyLeagueHistory) {
                    safeLocalStorageSet(SPECIALTY_LEAGUE_HISTORY_KEY, JSON.stringify(backup.specialtyLeagueHistory));
                }
                
                console.log("✅ Import to storage complete:", {
                    divisions: Object.keys(unifiedState.divisions || {}).length,
                    bunks: (unifiedState.bunks || []).length,
                    fields: (unifiedState.fields || unifiedState.app1?.fields || []).length
                });
                
                // Reset import flag
                _importInProgress = false;
                input.value = "";
                
                // ⭐ Show success and reload page (session persists in Supabase)
                alert(
                    "✅ Import successful!\n\n" +
                    "Divisions: " + Object.keys(unifiedState.divisions || {}).length + "\n" +
                    "Bunks: " + (unifiedState.bunks || []).length + "\n\n" +
                    "Reloading..."
                );
                
                // Reload page - Supabase session persists in localStorage
                window.location.reload();
                
            } catch (err) {
                console.error("Import failed:", err);
                alert("Invalid backup file. Error: " + err.message);
                _importInProgress = false;
                input.value = "";
            }
        };
        
        reader.onerror = function() {
            console.error("File read error");
            alert("Failed to read file.");
            _importInProgress = false;
            input.value = "";
        };
        
        reader.readAsText(file);
    }
    window.__campistry_handleFileSelect = handleFileSelect;
    
    // ==========================================================
    // 10. AUTO-SAVE SYSTEM - ★★★ FIXED with quota handling ★★★
    // ==========================================================
    function performAutoSave(silent = true) {
        try {
            // ★★★ FIX: Check if localStorage is near quota ★★★
            if (isLocalStorageNearQuota()) {
                console.warn("⚠️ localStorage near quota, skipping auto-save (data is in cloud)");
                // Try to clear old auto-save to free space
                localStorage.removeItem(AUTO_SAVE_KEY);
                return;
            }
            
            const currentState = window.loadGlobalSettings?.() || {};
            
            const snapshot = {
                timestamp: Date.now(),
                [UNIFIED_CACHE_KEY]: JSON.stringify(currentState),
                [DAILY_DATA_KEY]: localStorage.getItem(DAILY_DATA_KEY),
                [ROTATION_HISTORY_KEY]: localStorage.getItem(ROTATION_HISTORY_KEY),
                [LEAGUE_HISTORY_KEY]: localStorage.getItem(LEAGUE_HISTORY_KEY),
                [SPECIALTY_LEAGUE_HISTORY_KEY]: localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY),
                [SMART_TILE_HISTORY_KEY]: localStorage.getItem(SMART_TILE_HISTORY_KEY),
                [SMART_TILE_SPECIAL_HISTORY_KEY]: localStorage.getItem(SMART_TILE_SPECIAL_HISTORY_KEY)
            };
            
            // ★★★ FIX: Use safe setter with quota handling ★★★
            const saved = safeLocalStorageSet(AUTO_SAVE_KEY, JSON.stringify(snapshot));
            
            if (!saved) {
                console.warn("⚠️ Auto-save skipped due to quota. Data is saved to cloud.");
                if (!silent) {
                    alert("Auto-save skipped (storage full). Your data is safely stored in the cloud.");
                }
                return;
            }
            
            if (!silent) alert("Work saved!");
        } catch (e) {
            // ★★★ FIX: Handle quota error gracefully ★★★
            if (e.name === 'QuotaExceededError') {
                console.warn("⚠️ Auto-save failed: localStorage quota exceeded. Data is in cloud.");
                // Clear auto-save to free space for critical data
                localStorage.removeItem(AUTO_SAVE_KEY);
                if (!silent) {
                    alert("Auto-save skipped (storage full). Your data is safely stored in the cloud.");
                }
            } else {
                console.error("Auto-save failed:", e);
                if (!silent) alert("Save failed: " + e.message);
            }
        }
    }
    
    window.forceAutoSave = function() {
        performAutoSave(false);
    };
    
    window.restoreAutoSave = async function() {
        try {
            const raw = localStorage.getItem(AUTO_SAVE_KEY);
            if (!raw) return alert("No auto-save available.");
            const snap = JSON.parse(raw);
            const date = new Date(snap.timestamp).toLocaleString();
            if (!confirm("Restore auto-save from " + date + "?\nThis will overwrite current data.")) return;
            
            Object.keys(snap).forEach(key => {
                if (key === 'timestamp') return;
                if (snap[key]) {
                    safeLocalStorageSet(key, snap[key]);
                }
            });
            
            if (snap[UNIFIED_CACHE_KEY]) {
                safeLocalStorageSet(LEGACY_GLOBAL_SETTINGS_KEY, snap[UNIFIED_CACHE_KEY]);
                // ★ #V2-1 tail: CAMPISTRY_LOCAL_CACHE = cross-tab beacon only (value never read).
                safeLocalStorageSet("CAMPISTRY_LOCAL_CACHE", String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8));
                
                // Update memory cache via setCloudState
                if (typeof window.setCloudState === 'function') {
                    const state = JSON.parse(snap[UNIFIED_CACHE_KEY]);
                    
                    // Inject schedules if present in snapshot, so they sync too
                    if (snap[DAILY_DATA_KEY]) {
                        state.daily_schedules = JSON.parse(snap[DAILY_DATA_KEY]);
                    }
                    await window.setCloudState(state, true);
                }
            }
            
            alert("Auto-save restored. Reloading...");
            window.location.reload();
        } catch (e) {
            console.error("Restore error:", e);
            alert("Failed to restore backup.");
        }
    };
    
    // ★★★ NEW: Utility to clear localStorage space ★★★
    window.clearLocalStorageCache = function() {
        const keysToRemove = [AUTO_SAVE_KEY, 'CAMPISTRY_LOCAL_CACHE'];
        let freed = 0;
        
        keysToRemove.forEach(key => {
            const item = localStorage.getItem(key);
            if (item) {
                freed += item.length * 2;
                localStorage.removeItem(key);
                console.log(`🗑️ Removed ${key}`);
            }
        });
        
        console.log(`✅ Freed approximately ${(freed / 1024).toFixed(1)} KB`);
        return freed;
    };
    
    // ★★★ NEW: Diagnostic function for localStorage ★★★
    window.diagnoseLocalStorage = function() {
        let total = 0;
        const items = [];
        
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                const size = (localStorage[key].length * 2) / 1024;
                total += size;
                items.push({ key, size: size.toFixed(1) + ' KB' });
            }
        }
        
        items.sort((a, b) => parseFloat(b.size) - parseFloat(a.size));
        
        console.log("=== localStorage Usage ===");
        items.slice(0, 10).forEach(item => {
            console.log(`  ${item.key}: ${item.size}`);
        });
        console.log(`Total: ${(total / 1024).toFixed(2)} MB`);
        console.log(`Near quota: ${isLocalStorageNearQuota()}`);
        
        return { total: (total / 1024).toFixed(2) + ' MB', items };
    };
    
    function startAutoSaveTimer() {
        setInterval(() => performAutoSave(true), 300000); // 5 minutes
        setTimeout(() => performAutoSave(true), 5000); // Initial save after 5s
    }
    
    // ==========================================================
    // 11. INIT CALENDAR
    // ==========================================================
    function initCalendar() {
        datePicker = document.getElementById("calendar-date-picker");
        if (datePicker) {
            datePicker.value = window.currentScheduleDate;
            datePicker.addEventListener("change", onDateChanged);
        }
        setupEraseAll();
        startAutoSaveTimer();
        
        console.log("🗓️ Calendar initialized (FIXED v4.0 - DELETION FIX INTEGRATED)");
    }
    
    window.initCalendar = initCalendar;
    
    // Load day immediately
    window.loadCurrentDailyData();
    
    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCalendar);
    } else {
        initCalendar();
    }
})();

// ==========================================================
// LATE-BIND BACKUP / IMPORT WIRING
// ==========================================================
(function bindBackupWhenReady(){
    let _bound = false;
    
    function wire() {
        if (_bound) return;
        
        const exp = document.getElementById("exportBackupBtn");
        const imp = document.getElementById("importBackupBtn");
        const inp = document.getElementById("importFileInput");
        
        console.log("🔌 Late-bind check:", { exp: !!exp, imp: !!imp, inp: !!inp });
        
        if (!exp || !imp || !inp) {
            console.log("🔌 Elements not ready yet...");
            return;
        }
        
        exp.onclick = function(e) {
            console.log("📤 Export clicked");
            e.preventDefault();
            if (window.__campistry_exportAllData) {
                window.__campistry_exportAllData();
            } else {
                console.error("Export function not found!");
            }
        };
        
        imp.onclick = function(e) {
            console.log("📥 Import button clicked, opening file dialog...");
            e.preventDefault();
            inp.value = "";
            inp.click();
        };
        
        inp.onchange = function(e) {
            console.log("📁 File selected:", e.target.files?.[0]?.name);
            if (window.__campistry_handleFileSelect) {
                window.__campistry_handleFileSelect(e);
            } else {
                console.error("Import handler not found!");
            }
        };
        
        _bound = true;
        console.log("✅ Backup / Import buttons wired successfully");
    }
    setTimeout(wire, 100);
    setTimeout(wire, 300);
    setTimeout(wire, 600);
    setTimeout(wire, 1000);
    setTimeout(wire, 2000);
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    }
})();
