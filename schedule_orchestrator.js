// =============================================================================
// schedule_orchestrator.js v1.6 — CAMPISTRY SCHEDULE ORCHESTRATOR
// =============================================================================
//
// ★★★ THE SINGLE SOURCE OF TRUTH FOR ALL SCHEDULE OPERATIONS ★★★
//
// v1.6 SECURITY:
// - ★ PERMISSION-AWARE RETRIES — immediately aborts retry loop on RLS/permission errors
// - ★ Listens for 'campistry-permission-revoked' event from ScheduleDB + AccessControl
// - ★ Prevents retry storms against Supabase when user's role has been revoked
//
// v1.5 FIXES:
// - ★ RAINY DAY PERSISTENCE - Properly saves/loads isRainyDay and rainyDayStartTime
// - ★ BACKWARD COMPATIBILITY - Checks both isRainyDay and rainyDayMode flags
//
// v1.4 FIXES:
// - ★ REALTIME SUBSCRIPTION - Auto-subscribes when loading a date
// - ★ UNSUBSCRIBE ON DATE CHANGE - Cleans up old subscription before new one
// - ★ IMPROVED TIMEOUT - Uses AbortController for proper cancellation
// - ★ EXPONENTIAL BACKOFF VERIFICATION - 500ms, 1s, 2s delays
// - ★ BETTER MERGE - Properly handles unifiedTimes from all records
// - ★ NETWORK AWARENESS - Graceful offline handling
//
// v1.2 FIXES:
// - ★ SAVE VERIFICATION - confirms data actually reached Supabase
// - ★ USER NOTIFICATIONS - shows save success/failure to user
// - ★ AUTO-SAVE BEFORE DATE CHANGE - prevents data loss
// - ★ BEFOREUNLOAD HANDLER - saves on page exit
// - ★ FORCE CLOUD LOAD - bypasses localStorage cache
// - ★ BETTER DIAGNOSTICS - includes cloud verification
//
// DATA FLOW:
// ┌─────────────────────────────────────────────────────────────────┐
// │  LOAD:   Cloud → localStorage → window globals → UI             │
// │  SAVE:   window globals → localStorage → Cloud → VERIFY         │
// │  DELETE: Cloud (all records) → localStorage → window → UI       │
// └─────────────────────────────────────────────────────────────────┘
//
// EVENTS DISPATCHED:
// - campistry-orchestrator-ready      : Orchestrator initialized
// - campistry-schedule-loading        : Starting to load data
// - campistry-schedule-loaded         : Data loaded and hydrated
// - campistry-schedule-saved          : Data saved to cloud
// - campistry-schedule-deleted        : Data deleted
// - campistry-schedule-error          : An error occurred
//
// =============================================================================

(function() {
    'use strict';

    console.log('🎯 Campistry Schedule Orchestrator v1.6 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const CONFIG = {
        VERSION: '1.6.0',
        DEBUG: false,
        LOCAL_STORAGE_KEY: 'campDailyData_v1',
        
        // Timing
        DEBOUNCE_SAVE_MS: 1000,       // Debounce saves to prevent rapid-fire
        LOAD_TIMEOUT_MS: 10000,       // Max wait for cloud load
        SAVE_VERIFY_BASE_DELAY_MS: 500,  // ★ Exponential backoff base
        MAX_SAVE_RETRIES: 3,          // Retry failed saves
        SAVE_RETRY_DELAY_MS: 2000,    // Delay between retries
        
        // UI
        SHOW_NOTIFICATIONS: true,     // Show save/load notifications
        
        // Events
        EVENTS: {
            READY: 'campistry-orchestrator-ready',
            LOADING: 'campistry-schedule-loading',
            LOADED: 'campistry-schedule-loaded',
            SAVED: 'campistry-schedule-saved',
            DELETED: 'campistry-schedule-deleted',
            ERROR: 'campistry-schedule-error'
        }
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _isInitialized = false;
    let _isLoading = false;
    let _isSaving = false;
    let _currentDateKey = null;
    let _saveTimeout = null;
    let _saveQueue = [];
    let _lastLoadResult = null;
    let _lastSaveTime = 0;
    let _loadAbortController = null;  // ★ NEW: For cancellable loads
    let _permissionRevoked = false;   // ★ v1.6: Stop all saves if permissions revoked

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('🎯 [Orchestrator]', ...args);
        }
    }

    function logError(...args) {
        console.error('🎯 [Orchestrator] ERROR:', ...args);
    }

    function logWarn(...args) {
        console.warn('🎯 [Orchestrator] WARN:', ...args);
    }

    // =========================================================================
    // USER NOTIFICATIONS
    // =========================================================================

    function showNotification(message, type = 'info') {
        if (!CONFIG.SHOW_NOTIFICATIONS) return;

        // Remove any existing notification
        const existing = document.querySelector('.orchestrator-notification');
        if (existing) existing.remove();

        const colors = {
            success: '#22c55e',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#3b82f6'
        };

        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };

        const notification = document.createElement('div');
        notification.className = 'orchestrator-notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: ${colors[type] || colors.info};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 8px;
            animation: orchestratorSlideIn 0.3s ease;
        `;
        notification.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;

        // Add animation keyframes if not present
        if (!document.querySelector('#orchestrator-notification-styles')) {
            const style = document.createElement('style');
            style.id = 'orchestrator-notification-styles';
            style.textContent = `
                @keyframes orchestratorSlideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes orchestratorSlideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(notification);

        // Auto-remove after delay
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            notification.style.animation = 'orchestratorSlideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }

    // =========================================================================
    // EVENT HELPERS
    // =========================================================================

    function dispatch(eventName, detail = {}) {
        log('Dispatching:', eventName, detail);
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }

    // =========================================================================
    // DATE KEY HELPERS
    // =========================================================================

    function getCurrentDateKey() {
        return _currentDateKey || 
               window.currentScheduleDate || 
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('datepicker')?.value ||
               document.getElementById('calendar-date-picker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function setCurrentDateKey(dateKey) {
        _currentDateKey = dateKey;
        window.currentScheduleDate = dateKey;
    }

    // =========================================================================
    // LOCAL STORAGE OPERATIONS
    // =========================================================================

    function getLocalData(dateKey) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            if (!raw) return null;
            
            const allData = JSON.parse(raw);
            return allData[dateKey] || null;
        } catch (e) {
            logError('Failed to read localStorage:', e);
            return null;
        }
    }

    const LOCAL_ONLY_FIELDS = [
        'bunkActivityOverrides',
        'overrides',
        'autoSkeleton',
        '_autoGenerated',
        '_autoBuildTimelines',
        '_autoGenMeta',
        'manualSkeleton',
        'skeleton',
        'dailyDisabledSportsByField',
        'dailyFieldAvailability',
        'disabledSpecialtyLeagues',
        'leagueRoundState',
        'leagueDayCounters',
    ];

    function setLocalData(dateKey, data) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY) || '{}';
            const allData = JSON.parse(raw);
            const existing = allData[dateKey] || {};

            const merged = {
                ...data,
                _updatedAt: new Date().toISOString()
            };

            LOCAL_ONLY_FIELDS.forEach(field => {
                if (merged[field] === undefined && existing[field] !== undefined) {
                    merged[field] = existing[field];
                }
            });

            allData[dateKey] = merged;

            // ★★★ DAY 17 FIX: bump cap from 5 → 30 dates ★★★
            // The previous 5-date cap silently broke exactFrequency / minFrequency /
            // rotationCohort week-counts. Utils.getPeriodActivityCount reads
            // window.loadAllDailyData() which is just this localStorage, so a
            // 7-day-week query on day 8 only saw 4-5 prior days (off-by-1+).
            // Live-observed: Trios 2 got Drama 3x in 3 days with exactFrequency=2,
            // because the count function couldn't see the oldest placement.
            //
            // 30 is enough to cover a full month and span any 'half' period for
            // typical 4-week sessions. localStorage limit (5-10MB per origin) is
            // not at risk: ~30 dates × ~50KB = ~1.5MB. bulkHydrateLocalStorage
            // already trims to 14 only on QuotaExceededError (scheduler_core_utils.js
            // ~2566), so this orchestrator-side cap should match that ceiling.
            const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
            const dateKeys = Object.keys(allData).filter(k => DATE_RE.test(k));
            if (dateKeys.length > 30) {
                dateKeys.sort();
                dateKeys.slice(0, dateKeys.length - 30).forEach(k => delete allData[k]);
            }

            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(allData));
            log('Saved to localStorage:', dateKey);
            return true;
        } catch (e) {
            if (e.name !== 'QuotaExceededError') logError('Failed to write localStorage:', e);
            return false;
        }
    }

    function deleteLocalData(dateKey) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY) || '{}';
            const allData = JSON.parse(raw);
            
            if (allData[dateKey]) {
                delete allData[dateKey];
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(allData));
                log('Deleted from localStorage:', dateKey);
            }
            return true;
        } catch (e) {
            logError('Failed to delete from localStorage:', e);
            return false;
        }
    }

    // =========================================================================
    // ROTATION HISTORY HYDRATION (loads past dates from cloud)
    // =========================================================================

    async function hydrateRotationHistory(todayKey) {
        try {
            if (!window.ScheduleDB?.loadDateRange || !navigator.onLine) return;
            const d = new Date(todayKey + 'T12:00:00');
            d.setDate(d.getDate() - 14);
            const startDate = d.toISOString().split('T')[0];

            const allDaily = JSON.parse(localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY) || '{}');
            const pastDates = Object.keys(allDaily).filter(k => k < todayKey && k >= startDate && allDaily[k]?.scheduleAssignments && Object.keys(allDaily[k].scheduleAssignments).length > 0);
            if (pastDates.length >= 5) return;

            log('Hydrating rotation history from cloud:', startDate, '→', todayKey);
            const records = await window.ScheduleDB.loadDateRange(startDate, todayKey);
            if (!records || records.length === 0) return;

            let hydrated = 0;
            const byDate = {};
            for (const rec of records) {
                const dk = rec.date_key;
                if (!dk || dk === todayKey) continue;
                if (!byDate[dk]) byDate[dk] = [];
                byDate[dk].push(rec);
            }
            for (const [dk, recs] of Object.entries(byDate)) {
                const existing = allDaily[dk] || {};
                if (existing.scheduleAssignments && Object.keys(existing.scheduleAssignments).length > 0) continue;
                const merged = {};
                // ★★★ CB-20: merge multiple scheduler rows for a past date in
                // updated_at ASCENDING order so the NEWEST row wins shared bunks.
                // The query returns rows in arbitrary order, so a stale row could
                // otherwise overwrite a fresher one via Object.assign and poison
                // up to 14 days of rotation history.
                const _recsSorted = recs.slice().sort((a, b) => {
                    const ta = a.updated_at || a.created_at || '';
                    const tb = b.updated_at || b.created_at || '';
                    return ta < tb ? -1 : ta > tb ? 1 : 0;
                });
                for (const rec of _recsSorted) {
                    const sd = rec.schedule_data || {};
                    if (sd.scheduleAssignments) Object.assign(merged, sd.scheduleAssignments);
                }
                if (Object.keys(merged).length > 0) {
                    allDaily[dk] = { ...existing, scheduleAssignments: merged };
                    LOCAL_ONLY_FIELDS.forEach(f => { if (existing[f] !== undefined) allDaily[dk][f] = existing[f]; });
                    hydrated++;
                }
            }
            if (hydrated > 0) {
                // Slim PAST-date entries before persisting — rotation history
                // only needs _activity/sport/field per slot, so strip the rest.
                // This keeps 14 days of allDaily under the localStorage quota.
                //
                // ★★★ CB-3: ONLY slim dates strictly inside the rotation-history
                // window [startDate, todayKey). The previous `dk === todayKey`
                // guard slimmed EVERY other date — including FUTURE dates the
                // user had built ahead (skeleton/leagues/trips/divisionTimes/
                // _perBunkSlotsData), permanently destroying that local data.
                // Future dates and out-of-window past dates are left untouched;
                // and even within the window we carry forward LOCAL_ONLY_FIELDS
                // so historical per-day config (leagueRoundState etc.) survives.
                try {
                    for (const dk of Object.keys(allDaily)) {
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
                        if (!(dk < todayKey && dk >= startDate)) continue; // past, in-window only
                        const d = allDaily[dk];
                        if (!d || !d.scheduleAssignments) continue;
                        const slim = {};
                        for (const bunk of Object.keys(d.scheduleAssignments)) {
                            const slots = d.scheduleAssignments[bunk];
                            if (!Array.isArray(slots)) continue;
                            slim[bunk] = slots.map(e => {
                                if (!e) return null;
                                const out = {};
                                if (e._activity) out._activity = e._activity;
                                else if (e.sport) out.sport = e.sport;
                                else if (e.field) out.field = e.field;
                                if (e.continuation) out.continuation = true;
                                if (e._isTransition) out._isTransition = true;
                                return out;
                            });
                        }
                        const slimmed = { scheduleAssignments: slim };
                        LOCAL_ONLY_FIELDS.forEach(f => { if (d[f] !== undefined) slimmed[f] = d[f]; });
                        allDaily[dk] = slimmed;
                    }
                } catch (_) {}
                // Seed save hashes BEFORE writing to localStorage. This way
                // when something later triggers saveGlobalSettings on the full
                // allDaily object, hydrated past dates compare equal and skip
                // the cloud round-trip.
                try { window._seedSecondarySaveHashes?.(allDaily); } catch (_) {}
                try {
                    localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(allDaily));
                    window.invalidateDailyDataCache?.();
                } catch (_) { /* quota — memory fallback handled elsewhere */ }
                log('✅ Hydrated', hydrated, 'past date(s) for rotation history (slimmed)');
            }
        } catch (e) {
            logWarn('Rotation history hydration failed:', e);
        }
    }

    // =========================================================================
    // WINDOW GLOBALS MANAGEMENT
    // =========================================================================

    function hydrateWindowGlobals(data, ownerDateKey) {
        // ★★★ CROSS-DATE CORRUPTION GUARD (stamp) ★★★
        // Record which date the in-memory schedule belongs to. saveSchedule reads this
        // (via getWindowGlobals → _belongsToDate) and refuses any save whose target date
        // differs — so the dual date-change-handler race can never write one day's
        // schedule under another day's cloud key. Only stamp when the owner date is known
        // (degrades to inert/no-op otherwise; never blocks a legitimate save).
        if (ownerDateKey) window._scheduleAssignmentsDate = ownerDateKey;
        if (!data) {
            log('No data to hydrate, clearing globals');
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            return;
        }

        // Hydrate schedule assignments
        if (data.scheduleAssignments) {
            window.scheduleAssignments = JSON.parse(JSON.stringify(data.scheduleAssignments));
            log('Hydrated scheduleAssignments:', Object.keys(window.scheduleAssignments).length, 'bunks');
        } else {
            window.scheduleAssignments = {};
        }

        // Hydrate league assignments
        if (data.leagueAssignments) {
            window.leagueAssignments = JSON.parse(JSON.stringify(data.leagueAssignments));
            log('Hydrated leagueAssignments');
        } else {
            window.leagueAssignments = {};
        }

        // ★★★ FIX: Hydrate unifiedTimes if present ★★★
        if (data.unifiedTimes?.length > 0) {
            window.unifiedTimes = JSON.parse(JSON.stringify(data.unifiedTimes));
            log('Hydrated unifiedTimes:', window.unifiedTimes.length, 'slots');
        }

        // Hydrate divisionTimes
        if (data.divisionTimes) {
            window.divisionTimes = window.DivisionTimesSystem?.deserialize(data.divisionTimes) || data.divisionTimes;
            log('Hydrated divisionTimes:', Object.keys(window.divisionTimes).length, 'divisions');

            // ★★★ DAY 16b FIX: Restore per-bunk slot grid + _isPerBunk flags.
            // _perBunkSlots is a custom property that JSON.stringify strips
            // (Array doesn't carry own props through serialize), so save-side
            // extracts it into _perBunkSlotsData as a sibling field. The auto
            // solver reads divisionTimes[grade]._perBunkSlots to know each
            // bunk's period grid — without restoring it here the solver sees
            // no grid and produces empty slot arrays on the next generation
            // (live-observed: 35 bunks/0 activities post-reload-then-regen).
            //
            // Also sets _isPerBunk=true so the parallel forceHydrate path
            // in supabase_sync.js correctly recognizes memory as authoritative
            // ("live per-bunk generation") and doesn't clobber it.
            if (data._perBunkSlotsData && typeof data._perBunkSlotsData === 'object') {
                let restored = 0;
                Object.entries(data._perBunkSlotsData).forEach(([divName, perBunkSlots]) => {
                    if (window.divisionTimes[divName]) {
                        window.divisionTimes[divName]._isPerBunk = true;
                        window.divisionTimes[divName]._perBunkSlots = perBunkSlots;
                        restored++;
                    }
                });
                log('Hydrated _perBunkSlots for', restored, 'divisions');
            }
        }

        // ★★★ DAY 16b FIX: Forward auto-generated and manual-skeleton flags
        // so downstream code (auto-mode rebuild, post-edit gates) can detect
        // this was an auto-generated schedule.
        if (data._autoGenerated === true) {
            window._autoGenerated = true;
        }
        if (data.manualSkeleton && Array.isArray(data.manualSkeleton) && data.manualSkeleton.length > 0) {
            window._autoSkeleton = data.manualSkeleton;
        }

        // ★★★ FIX v1.5: Hydrate rainy day state (check both flags for backward compatibility) ★★★
        if (data.isRainyDay === true || data.rainyDayMode === true) {
            window.isRainyDay = true;
            log('Hydrated isRainyDay: true');
        } else if (data.isRainyDay === false) {
            window.isRainyDay = false;
            log('Hydrated isRainyDay: false');
        }
        
        // ★★★ FIX v1.5: Hydrate rainyDayStartTime for mid-day mode ★★★
        if (data.rainyDayStartTime !== null && data.rainyDayStartTime !== undefined) {
            window.rainyDayStartTime = data.rainyDayStartTime;
            log('Hydrated rainyDayStartTime:', data.rainyDayStartTime);
        } else {
            window.rainyDayStartTime = null;
        }
    }

    function getWindowGlobals() {
        return {
            scheduleAssignments: window.scheduleAssignments || {},
            leagueAssignments: window.leagueAssignments || {},
            unifiedTimes: window.unifiedTimes || [],
            divisionTimes: window.divisionTimes || {},
            isRainyDay: window.isRainyDay || false,
            rainyDayStartTime: window.rainyDayStartTime ?? null,  // ★ FIX v1.5: Include for mid-day mode
            rainyDayMode: window.isRainyDay || false,             // ★ FIX v1.5: Backward compatibility
            // ★★★ CROSS-DATE CORRUPTION GUARD: which date this snapshot belongs to.
            // saveSchedule refuses to write it under a different date's key, then strips
            // this marker before persisting. Snapshotted here so the check survives the
            // async gap during which a racing handler may swap window.scheduleAssignments.
            _belongsToDate: window._scheduleAssignmentsDate || null
        };
    }

    function clearWindowGlobals() {
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        log('Cleared window globals');
    }

    // =========================================================================
    // ★★★ IMPROVED: CLOUD VERIFICATION WITH EXPONENTIAL BACKOFF ★★★
    // =========================================================================

    async function verifyCloudSave(dateKey, expectedBunkCount, maxAttempts = 3) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();

        if (!client || !campId || !userId) {
            return { verified: false, reason: 'Not authenticated' };
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // Exponential backoff: 500ms, 1000ms, 2000ms
            const delay = Math.min(CONFIG.SAVE_VERIFY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 2000);
            log(`Verification attempt ${attempt}/${maxAttempts}, waiting ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            
            try {
                const { data, error } = await client
                    .from('daily_schedules')
                    .select('schedule_data, updated_at')
                    .eq('camp_id', campId)
                    .eq('date_key', dateKey)
                    .eq('scheduler_id', userId)
                    .single();

                if (error) {
                    log(`Verify attempt ${attempt} error:`, error.message);
                    continue;
                }

                if (!data) {
                    log(`Verify attempt ${attempt}: No record found`);
                    continue;
                }

                const cloudBunkCount = Object.keys(data.schedule_data?.scheduleAssignments || {}).length;
                log(`Verification attempt ${attempt}: Found ${cloudBunkCount} bunks in cloud`);

                // Allow some variance for filtering (user may not have all divisions)
                if (cloudBunkCount > 0) {
                    return { 
                        verified: true, 
                        cloudBunkCount,
                        updatedAt: data.updated_at,
                        attempt
                    };
                }
            } catch (e) {
                log(`Verify attempt ${attempt} exception:`, e.message);
            }
        }
        
        return { verified: false, reason: `Failed after ${maxAttempts} attempts` };
    }

    // =========================================================================
    // ★★★ IMPROVED: LOAD SCHEDULE WITH ABORTCONTROLLER TIMEOUT ★★★
    // =========================================================================

    async function loadSchedule(dateKey, options = {}) {
        if (!dateKey) dateKey = getCurrentDateKey();
        
        log('═══════════════════════════════════════════════════════');
        log('LOAD SCHEDULE:', dateKey);
        log('═══════════════════════════════════════════════════════');

        if (_isLoading && !options.force) {
            log('Already loading, skipping...');
            return _lastLoadResult;
        }

        // Cancel any previous load
        if (_loadAbortController) {
            _loadAbortController.abort();
        }
        _loadAbortController = new AbortController();

        _isLoading = true;
        setCurrentDateKey(dateKey);
        dispatch(CONFIG.EVENTS.LOADING, { dateKey });

        // ★ v1.6: Reset permission flag on new load (user may have refreshed)
        _permissionRevoked = false;

        let result = {
            success: false,
            source: 'none',
            dateKey,
            data: null,
            bunkCount: 0
        };
        // CB-13: set when the cloud query authoritatively returns 0 records with
        // no error (date genuinely empty/deleted) — distinguishes that from a
        // cloud failure so STEP 2 doesn't resurrect a deleted date from local.
        let cloudConfirmedEmpty = false;

        try {
            // ═══════════════════════════════════════════════════════════════
            // STEP 1: DIRECT CLOUD QUERY WITH PROPER TIMEOUT
            // ═══════════════════════════════════════════════════════════════
            
            const client = window.CampistryDB?.getClient?.();
            const campId = window.CampistryDB?.getCampId?.();

            if (client && campId && navigator.onLine) {
                log('Step 1: Direct cloud query...');
                
                try {
                    // ★★★ IMPROVED: Use AbortController for proper timeout ★★★
                    const timeoutId = setTimeout(() => {
                        _loadAbortController.abort();
                    }, CONFIG.LOAD_TIMEOUT_MS);
                    
                    const { data: records, error } = await client
                        .from('daily_schedules')
                        .select('*')
                        .eq('camp_id', campId)
                        .eq('date_key', dateKey)
                        .abortSignal(_loadAbortController.signal);
                    
                    clearTimeout(timeoutId);

                    if (!error && records && records.length > 0) {
                        // Merge all scheduler records
                        const merged = mergeCloudRecords(records);
                        
                        result = {
                            success: true,
                            source: 'cloud-direct',
                            dateKey,
                            data: merged,
                            bunkCount: Object.keys(merged.scheduleAssignments || {}).length,
                            recordCount: records.length
                        };

                        log('✅ Cloud load success:', result.bunkCount, 'bunks from', records.length, 'records');
                        log('   unifiedTimes:', merged.unifiedTimes?.length || 0, 'slots');
                        log('   isRainyDay:', merged.isRainyDay, 'rainyDayStartTime:', merged.rainyDayStartTime);

                        // Update localStorage cache
                        setLocalData(dateKey, merged);
                    } else if (error) {
                        if (error.name === 'AbortError') {
                            logWarn('Cloud query timed out');
                        } else {
                            logWarn('Cloud query error:', error.message);
                        }
                    } else {
                        // ★★★ CB-13: cloud returned 0 records with NO error while
                        // online+authenticated — the date is authoritatively empty
                        // (e.g. it was deleted). Flag it so STEP 2 does NOT
                        // resurrect it from stale localStorage.
                        log('No cloud records for', dateKey, '— confirmed empty');
                        cloudConfirmedEmpty = true;
                    }
                } catch (cloudErr) {
                    if (cloudErr.name === 'AbortError') {
                        logWarn('Cloud load aborted (timeout or cancelled)');
                    } else {
                        logWarn('Cloud load failed:', cloudErr.message);
                    }
                }
            } else if (!navigator.onLine) {
                logWarn('Offline - using localStorage only');
            } else {
                logWarn('Not authenticated, using localStorage only');
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 2: Fall back to localStorage if cloud failed
            // ═══════════════════════════════════════════════════════════════
            
            if (!result.success && cloudConfirmedEmpty) {
                // ★★★ CB-13: the cloud authoritatively has no records for this
                // date — treat it as genuinely empty. Clear the stale local cache
                // (so it can't resurrect the deleted date now or on a later
                // offline load) and load empty, rather than falling through to
                // the localStorage fallback below.
                log('Step 2: cloud confirmed empty — clearing stale local cache for', dateKey);
                try { deleteLocalData(dateKey); } catch (_) {}
                result = {
                    success: true,
                    source: 'cloud-empty',
                    dateKey,
                    data: { scheduleAssignments: {}, leagueAssignments: {}, unifiedTimes: [] },
                    bunkCount: 0,
                    recordCount: 0
                };
            }

            if (!result.success) {
                log('Step 2: Checking localStorage...');
                const localData = getLocalData(dateKey);

                if (localData) {
                    result = {
                        success: true,
                        source: 'localStorage',
                        dateKey,
                        data: localData,
                        bunkCount: Object.keys(localData.scheduleAssignments || {}).length
                    };
                    log('✅ localStorage load success:', result.bunkCount, 'bunks');
                } else {
                    log('No data in localStorage either');
                    result.success = true; // Empty is still success
                    result.source = 'empty';
                    result.data = {
                        scheduleAssignments: {},
                        leagueAssignments: {},
                        unifiedTimes: []
                    };
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 3: Hydrate window globals
            // ═══════════════════════════════════════════════════════════════
            
            log('Step 3: Hydrating window globals...');
            hydrateWindowGlobals(result.data, dateKey);

            // ═══════════════════════════════════════════════════════════════
            // STEP 3b: Hydrate past dates for rotation history (background)
            // ═══════════════════════════════════════════════════════════════
            hydrateRotationHistory(dateKey);

            // ═══════════════════════════════════════════════════════════════
            // STEP 4: Ensure empty state for all divisions
            // ═══════════════════════════════════════════════════════════════

            log('Step 4: Ensuring empty state for unscheduled divisions...');
            ensureEmptyStateForAllDivisions();

            // ═══════════════════════════════════════════════════════════════
            // STEP 5: Update UI
            // ═══════════════════════════════════════════════════════════════
            
            log('Step 5: Updating UI...');
            if (window.updateTable) {
                window.updateTable();
            }

            _lastLoadResult = result;
            dispatch(CONFIG.EVENTS.LOADED, result);

            // ═══════════════════════════════════════════════════════════════
            // STEP 6: Subscribe to realtime updates for this date
            // ═══════════════════════════════════════════════════════════════

            if (window.ScheduleSync?.subscribe) {
                log('Step 6: Subscribing to realtime for', dateKey);
                window.ScheduleSync.subscribe(dateKey).catch(e => {
                    logWarn('Realtime subscription failed:', e.message);
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // ★★★ DAY 16b FIX: delayed re-apply guard ★★★
            //
            // Live trace showed window.scheduleAssignments gets CLEARED to {}
            // ~300ms after our hydrateWindowGlobals runs (an unidentified
            // downstream path — likely a parallel init that races us). The
            // subsequent rebuild from localStorage is partial (only ~57% of
            // activities survive — anchor blocks like lunch/Change/Main
            // activity/Cleanup are nulled). Final memory state ends at the
            // partial count.
            //
            // Rather than hunt the clearing path through every init listener,
            // re-apply our merged cloud result twice with growing delays.
            // The cloud row is the source of truth; if anyone clobbered
            // memory in between, we restore. Idempotent — safe to re-apply
            // identical data.
            //
            // Only fires when loaded from cloud (source = 'cloud-direct')
            // to avoid replaying stale localStorage on offline paths.
            // ═══════════════════════════════════════════════════════════════
            if (result.source === 'cloud-direct' && result.bunkCount > 0) {
                const stableResult = result.data;
                const reApply = (label) => {
                    try {
                        // ★★★ CB-11: bail if the user navigated to a different date
                        // since this load fired. Without this, the 500ms/2s/5s
                        // timers re-hydrate the OLD date's schedule (stableResult)
                        // over whatever date is now in view.
                        const _liveDate = window._scheduleAssignmentsDate || window.currentScheduleDate;
                        if (_liveDate && dateKey && _liveDate !== dateKey) {
                            log('[load re-apply ' + label + '] date changed (' + dateKey + ' -> ' + _liveDate + ') — skipping stale re-apply');
                            return;
                        }
                        const currentActs = (() => {
                            let n = 0;
                            const sa = window.scheduleAssignments || {};
                            for (const bk of Object.keys(sa)) {
                                for (const s of (sa[bk] || [])) {
                                    if (s && (s._activity || s.activity)) {
                                        const a = s._activity || s.activity;
                                        if (a && a !== 'Free') n++;
                                    }
                                }
                            }
                            return n;
                        })();
                        const expectedActs = (() => {
                            let n = 0;
                            const sa = stableResult?.scheduleAssignments || {};
                            for (const bk of Object.keys(sa)) {
                                for (const s of (sa[bk] || [])) {
                                    if (s && (s._activity || s.activity)) {
                                        const a = s._activity || s.activity;
                                        if (a && a !== 'Free') n++;
                                    }
                                }
                            }
                            return n;
                        })();
                        if (currentActs < expectedActs) {
                            log('[load re-apply ' + label + '] memory drift detected: ' + currentActs + ' < ' + expectedActs + ' — re-applying cloud data');
                            hydrateWindowGlobals(stableResult, dateKey);
                            if (window.updateTable) window.updateTable();
                        }
                    } catch (e) { logWarn('re-apply ' + label + ' failed:', e); }
                };
                setTimeout(() => reApply('500ms'), 500);
                setTimeout(() => reApply('2s'), 2000);
                setTimeout(() => reApply('5s'), 5000);
            }

            log('═══════════════════════════════════════════════════════');
            log('LOAD COMPLETE:', result.source, '-', result.bunkCount, 'bunks');
            log('═══════════════════════════════════════════════════════');

        } catch (e) {
            logError('Load failed:', e);
            result = { success: false, error: e.message, dateKey };
            dispatch(CONFIG.EVENTS.ERROR, { operation: 'load', error: e.message, dateKey });
        } finally {
            _isLoading = false;
            _loadAbortController = null;
        }

        return result;
    }

    /**
     * ★★★ IMPROVED: Merge multiple scheduler records with proper unifiedTimes handling ★★★
     * ★★★ v1.5 FIX: Also properly merge rainy day state from schedule_data ★★★
     */
    function mergeCloudRecords(records) {
        // ★★★ CB-4: delegate the core per-bunk / per-division merge to the
        // canonical ScheduleDB.mergeSchedules, which carries the multi-scheduler
        // fixes (MS-3 per-division recency stamps, MS-4c grid/content-winner
        // pairing, #V2-25 deleted-bunk structural prune). This function's own
        // loop below is a stale duplicate that bypassed every one of them and
        // could resurrect deleted bunks / serve a stale division's grid on the
        // initial flow-page load. Fall back to the local loop only if
        // ScheduleDB is unavailable. mergeSchedules doesn't surface the
        // orchestrator-only signals (_autoGenerated / manualSkeleton /
        // rainyDayStartTime), so layer those back from the records.
        if (window.ScheduleDB?.mergeSchedules && Array.isArray(records) && records.length > 0) {
            try {
                const m = window.ScheduleDB.mergeSchedules(records) || {};
                const sorted = records.slice().sort((a, b) => {
                    const ta = a.updated_at || a.created_at || '';
                    const tb = b.updated_at || b.created_at || '';
                    return ta < tb ? -1 : ta > tb ? 1 : 0;
                });
                let autoGen = m._autoGenerated === true;
                let manualSkel = (Array.isArray(m.manualSkeleton) && m.manualSkeleton.length > 0) ? m.manualSkeleton : null;
                let rdStart = (m.rainyDayStartTime !== undefined && m.rainyDayStartTime !== null) ? m.rainyDayStartTime : null;
                let isRainy = m.isRainyDay === true;
                for (const rec of sorted) {
                    const d = rec.schedule_data || {};
                    if (d._autoGenerated === true) autoGen = true;
                    if (Array.isArray(d.manualSkeleton) && d.manualSkeleton.length > 0) manualSkel = d.manualSkeleton;
                    if (d.rainyDayStartTime !== null && d.rainyDayStartTime !== undefined) rdStart = d.rainyDayStartTime;
                    if (rec.is_rainy_day || d.isRainyDay === true || d.rainyDayMode === true) isRainy = true;
                }
                m._autoGenerated = autoGen;
                m.manualSkeleton = manualSkel;
                m.rainyDayStartTime = rdStart;
                m.isRainyDay = isRainy;
                return m;
            } catch (e) {
                logWarn('ScheduleDB.mergeSchedules failed, falling back to orchestrator local merge:', e);
            }
        }
        const merged = {
            scheduleAssignments: {},
            leagueAssignments: {},
            unifiedTimes: [],
            divisionTimes: {},
            isRainyDay: false,
            rainyDayStartTime: null,
            // ★★★ DAY 16b FIX: capture _perBunkSlotsData so the auto solver's
            // per-bunk grid survives the cloud → memory round-trip. Without
            // this, hydrateWindowGlobals sets divisionTimes via
            // DivisionTimesSystem.deserialize but loses _perBunkSlots, leaving
            // the solver with no period grid to write activities into.
            _perBunkSlotsData: {},
            // Also keep the auto-generated and manual-skeleton signals.
            _autoGenerated: false,
            manualSkeleton: null
        };

        // Sort by updated_at ascending so the most recently saved record wins
        records.sort((a, b) => {
            const ta = a.updated_at || a.created_at || '';
            const tb = b.updated_at || b.created_at || '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

        for (const record of records) {
            const data = record.schedule_data || {};

            // Merge schedule assignments (each scheduler owns their bunks)
            if (data.scheduleAssignments) {
                Object.assign(merged.scheduleAssignments, data.scheduleAssignments);
            }

            // Merge league assignments
            if (data.leagueAssignments) {
                Object.assign(merged.leagueAssignments, data.leagueAssignments);
            }

            // ★★★ FIX: Use longest unifiedTimes array from schedule_data ★★★
            if (data.unifiedTimes && Array.isArray(data.unifiedTimes)) {
                if (data.unifiedTimes.length > merged.unifiedTimes.length) {
                    merged.unifiedTimes = data.unifiedTimes;
                }
            }

            // ★★★ FIX: Also check record.unified_times (separate column) ★★★
            if (record.unified_times && Array.isArray(record.unified_times)) {
                if (record.unified_times.length > merged.unifiedTimes.length) {
                    merged.unifiedTimes = record.unified_times;
                }
            }

            // Merge division times
            if (data.divisionTimes) {
                Object.entries(data.divisionTimes).forEach(([divName, slots]) => {
                    if (!merged.divisionTimes[divName] || slots.length > merged.divisionTimes[divName].length) {
                        merged.divisionTimes[divName] = slots;
                    }
                });
            }

            // ★★★ DAY 16b FIX: Merge _perBunkSlotsData (per-grade per-bunk grid).
            // Multi-scheduler records each own some grades — keep the latest
            // (records are sorted ascending by updated_at, so later wins).
            if (data._perBunkSlotsData && typeof data._perBunkSlotsData === 'object') {
                Object.entries(data._perBunkSlotsData).forEach(([divName, perBunkSlots]) => {
                    merged._perBunkSlotsData[divName] = perBunkSlots;
                });
            }

            // ★★★ DAY 16b FIX: Auto-generated + manual skeleton flags
            if (data._autoGenerated === true) merged._autoGenerated = true;
            if (data.manualSkeleton && Array.isArray(data.manualSkeleton) && data.manualSkeleton.length > 0) {
                merged.manualSkeleton = data.manualSkeleton;
            }

            // ★★★ FIX v1.5: Rainy day flag - check BOTH database column AND inside schedule_data ★★★
            if (record.is_rainy_day || data.isRainyDay === true || data.rainyDayMode === true) {
                merged.isRainyDay = true;
            }

            // ★★★ FIX v1.5: Also capture rainyDayStartTime for mid-day mode ★★★
            if (data.rainyDayStartTime !== null && data.rainyDayStartTime !== undefined) {
                merged.rainyDayStartTime = data.rainyDayStartTime;
            }
        }

        log('Merged records:', {
            bunks: Object.keys(merged.scheduleAssignments).length,
            unifiedTimes: merged.unifiedTimes.length,
            divisionTimes: Object.keys(merged.divisionTimes).length,
            perBunkSlotsGrades: Object.keys(merged._perBunkSlotsData).length,
            autoGenerated: merged._autoGenerated,
            isRainyDay: merged.isRainyDay,
            rainyDayStartTime: merged.rainyDayStartTime
        });

        return merged;
    }

    // =========================================================================
    // CORE: SAVE SCHEDULE (WITH VERIFICATION)
    // =========================================================================

    /**
     * Save current schedule to cloud with verification.
     * Flow:
     * 1. Get data from window globals
     * 2. Save to localStorage immediately
     * 3. Save to cloud
     * 4. VERIFY the save reached cloud
     * 5. Retry if verification fails
     */
   async function saveSchedule(dateKey, data, options = {}) {
        if (!dateKey) dateKey = getCurrentDateKey();
        if (!data) data = getWindowGlobals();

        // ★★★ CROSS-DATE CORRUPTION GUARD (enforce) ★★★
        // If the snapshot belongs to a different date than the save target, a date-change
        // handler race is about to write one day's schedule under another day's key.
        // Refuse it — this makes the dual-handler navigation race (orchestrator vs
        // integration_hooks) structurally incapable of corrupting a day's schedule.
        // Inert when unstamped (_belongsToDate null) so it can never block a legit save.
        if (data && data._belongsToDate && data._belongsToDate !== dateKey) {
            logWarn('★ BLOCKED cross-date save: in-memory schedule belongs to ' + data._belongsToDate +
                    ' but save targets ' + dateKey + ' — refusing to prevent corruption');
            return { success: false, skipped: 'date-mismatch', belongsTo: data._belongsToDate, target: dateKey };
        }
        // Strip the internal marker so it is never persisted into the cloud/local blob.
        if (data && Object.prototype.hasOwnProperty.call(data, '_belongsToDate')) {
            try { delete data._belongsToDate; } catch (e) { /* non-fatal */ }
        }

        const bunkCount = Object.keys(data.scheduleAssignments || {}).length;
        log('SAVE SCHEDULE:', dateKey, bunkCount, 'bunks');

        // ★★★ v1.7 SECURITY: Verify role from DB before any write ★★★
        if (window.AccessControl?.verifyBeforeWrite && !options.skipVerify) {
            const writeAllowed = await window.AccessControl.verifyBeforeWrite('save schedule');
            if (!writeAllowed) {
                log('SAVE BLOCKED — verifyBeforeWrite returned false');
                return { success: false, error: 'Write permission denied', target: 'permission-error' };
            }
        }

        // ★ v1.6 SECURITY: Block saves if permissions were revoked this session
        if (_permissionRevoked) {            logWarn('Save blocked — permissions were revoked this session. Refresh required.');
            showNotification('Permissions changed — please refresh the page', 'error');
            return { success: false, error: 'Permission revoked', target: 'permission-error' };
        }

        // Always save to localStorage immediately
        setLocalData(dateKey, data);

        // Check if offline
        if (!navigator.onLine) {
            log('Offline - saved to localStorage only');
            showNotification('📴 Saved locally (offline)', 'warning');
            return { success: true, target: 'localStorage', offline: true };
        }

        // Debounce cloud saves unless immediate
        if (options.immediate) {
            return await doCloudSaveWithVerification(dateKey, data, options);
        } else {
            queueCloudSave(dateKey, data, options);
            return { success: true, target: 'queued' };
        }
    }

    function queueCloudSave(dateKey, data, options) {
        // Clear existing timeout
        if (_saveTimeout) {
            clearTimeout(_saveTimeout);
        }

        // Queue the save
        _saveQueue = [{ dateKey, data, options }]; // Only keep latest

        // Schedule debounced save
        _saveTimeout = setTimeout(async () => {
            if (_saveQueue.length > 0) {
                const item = _saveQueue.shift();
                await doCloudSaveWithVerification(item.dateKey, item.data, item.options);
            }
        }, CONFIG.DEBOUNCE_SAVE_MS);

        log('Save queued, will execute in', CONFIG.DEBOUNCE_SAVE_MS, 'ms');
    }

    /**
     * Save to cloud with verification and retry logic.
     * ★★★ v1.6: Short-circuits immediately on permission errors ★★★
     */
    async function doCloudSaveWithVerification(dateKey, data, options = {}, attempt = 1) {
        if (_isSaving && !options.force) {
            // ★ Day 24 fix: instead of dropping the save on the floor, WAIT for
            //   the in-flight save to complete then proceed. The previous behavior
            //   silently lost critical post-gen saves (cloud kept the intermediate
            //   state; switching dates and coming back returned the older version).
            log('Save already in progress — waiting for it to finish before proceeding');
            const _waitStart = Date.now();
            const _maxWait = 8000; // 8s ceiling
            while (_isSaving && (Date.now() - _waitStart) < _maxWait) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (_isSaving) {
                logWarn('Save in progress flag stuck for ' + _maxWait + 'ms — proceeding with force to avoid data loss');
                // Fall through and proceed anyway — better to risk a race than lose the user's schedule.
            }
        }

        // ★ v1.6: Check permission flag before attempting
        if (_permissionRevoked) {
            logWarn('Save aborted — permissions revoked');
            return { success: false, error: 'Permission revoked', target: 'permission-error' };
        }

        _isSaving = true;
        const bunkCount = Object.keys(data.scheduleAssignments || {}).length;

        log(`Cloud save attempt ${attempt}/${CONFIG.MAX_SAVE_RETRIES}: ${bunkCount} bunks`);

        if (bunkCount === 0 && !options.allowEmpty) {
            log('No data to save');
            _isSaving = false;
            return { success: true, target: 'empty', bunkCount: 0 };
        }

        // Check if ScheduleDB is available
        if (!window.ScheduleDB?.saveSchedule) {
            logWarn('ScheduleDB not available, saved to localStorage only');
            _isSaving = false;
            showNotification('Saved locally (offline)', 'warning');
            return { success: true, target: 'localStorage' };
        }

        try {
            // ═══════════════════════════════════════════════════════════════
            // STEP 1: Save to cloud
            // ═══════════════════════════════════════════════════════════════
            
            const result = await window.ScheduleDB.saveSchedule(dateKey, data, options);
            
            // ═════════════════════════════════════════════════════════════
            // ★★★ v1.6 SECURITY: Short-circuit on permission errors ★★★
            // Don't retry — the user's role was revoked. Retrying would
            // just hammer the RLS wall 3+ times for no reason.
            // ═════════════════════════════════════════════════════════════
            if (!result?.success) {
                if (result?.target === 'permission-error' || result?.requiresReauth) {
                    logWarn('🚨 Permission error — aborting all retries');
                    _isSaving = false;
                    _permissionRevoked = true;  // Block future saves this session
                    showNotification('Your permissions have changed — please refresh the page', 'error');
                    dispatch(CONFIG.EVENTS.ERROR, { 
                        operation: 'save', 
                        error: 'Permission denied',
                        dateKey,
                        requiresReauth: true 
                    });
                    return { success: false, error: 'Permission denied', target: 'permission-error' };
                }
                throw new Error(result?.error || 'Save failed');
            }

            if (result.target !== 'cloud' && result.target !== 'cloud-verified' && result.target !== 'cloud-unverified') {
                // Saved to local only - retry for cloud
                if (attempt < CONFIG.MAX_SAVE_RETRIES) {
                    log('Saved to local only, retrying for cloud...');
                    _isSaving = false;
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return doCloudSaveWithVerification(dateKey, data, options, attempt + 1);
                }
                
                showNotification('Saved locally (cloud unavailable)', 'warning');
                _isSaving = false;
                return result;
            }

            // ═══════════════════════════════════════════════════════════════
            // STEP 2: VERIFY the save reached cloud (if not already verified)
            // ═══════════════════════════════════════════════════════════════
            
            if (result.verified) {
                log('✅ Save already verified by ScheduleDB');
                _lastSaveTime = Date.now();
                if (!options.silent) showNotification(`Saved ${bunkCount} bunks`, 'success');
                dispatch(CONFIG.EVENTS.SAVED, { dateKey, target: 'cloud-verified', bunkCount });
                _isSaving = false;
                return { success: true, target: 'cloud-verified', bunkCount, verified: true };
            }

            // ★★★ IMPROVED: Verify with exponential backoff ★★★
            const verification = await verifyCloudSave(dateKey, bunkCount);

            if (verification.verified) {
                log('✅ Save VERIFIED:', verification.cloudBunkCount, 'bunks in cloud');
                _lastSaveTime = Date.now();

                if (!options.silent) showNotification(`Saved ${bunkCount} bunks`, 'success');
                dispatch(CONFIG.EVENTS.SAVED, { 
                    dateKey, 
                    target: 'cloud-verified',
                    bunkCount,
                    cloudBunkCount: verification.cloudBunkCount
                });
                
                _isSaving = false;
                return { 
                    success: true, 
                    target: 'cloud-verified',
                    bunkCount,
                    verified: true
                };
            } else {
                // Verification failed - retry
                logWarn('Verification failed:', verification.reason);
                
                if (attempt < CONFIG.MAX_SAVE_RETRIES) {
                    _isSaving = false;
                    await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                    return doCloudSaveWithVerification(dateKey, data, options, attempt + 1);
                }
                
                showNotification('Save may not have synced', 'warning');
                _isSaving = false;
                return { success: true, target: 'cloud-unverified', bunkCount };
            }

        } catch (e) {
            logError('Cloud save exception:', e);
            
            if (attempt < CONFIG.MAX_SAVE_RETRIES) {
                _isSaving = false;
                await new Promise(r => setTimeout(r, CONFIG.SAVE_RETRY_DELAY_MS));
                return doCloudSaveWithVerification(dateKey, data, options, attempt + 1);
            }
            
            showNotification('Save failed', 'error');
            dispatch(CONFIG.EVENTS.ERROR, { operation: 'save', error: e.message, dateKey });
            _isSaving = false;
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // CORE: DELETE SCHEDULE
    // =========================================================================

    /**
     * Delete schedule data.
     * For schedulers: Removes their bunks from ALL records
     * For owners/admins: Deletes all records for the date
     */
   async function deleteSchedule(dateKey, options = {}) {
        if (!dateKey) dateKey = getCurrentDateKey();

        // ★★★ v1.7 SECURITY: Verify role from DB before delete ★★★
        if (window.AccessControl?.verifyBeforeWrite) {
            const writeAllowed = await window.AccessControl.verifyBeforeWrite('delete schedule');
            if (!writeAllowed) {
                log('DELETE BLOCKED — verifyBeforeWrite returned false');
                return { success: false, error: 'Write permission denied' };
            }
        }

        const isFullAccess = window.PermissionsDB?.hasFullAccess?.() || 
                             window.AccessControl?.getCurrentRole?.() === 'owner' ||
                             window.AccessControl?.getCurrentRole?.() === 'admin';

        log('═══════════════════════════════════════════════════════');
        log('DELETE SCHEDULE:', dateKey, isFullAccess ? '(FULL DELETE)' : '(MY DIVISIONS ONLY)');
        log('═══════════════════════════════════════════════════════');

        try {
            let result;

            if (isFullAccess || options.deleteAll) {
                result = await deleteAllSchedules(dateKey);
            } else {
                result = await deleteMyBunksFromAllRecords(dateKey);
            }

            // Clear localStorage
            deleteLocalData(dateKey);

            // Clear window globals
            if (isFullAccess || options.deleteAll) {
                clearWindowGlobals();
            } else {
                clearMyBunksFromGlobals();
            }

            // Reload remaining data from cloud
            await reloadAfterDelete(dateKey);

            // Update UI
            if (window.updateTable) {
                window.updateTable();
            }

            showNotification('Schedule deleted', 'success');
            dispatch(CONFIG.EVENTS.DELETED, { dateKey, ...result });

            log('═══════════════════════════════════════════════════════');
            log('DELETE COMPLETE');
            log('═══════════════════════════════════════════════════════');

            return result;

        } catch (e) {
            logError('Delete failed:', e);
            showNotification('Delete failed', 'error');
            dispatch(CONFIG.EVENTS.ERROR, { operation: 'delete', error: e.message, dateKey });
            return { success: false, error: e.message };
        }
    }

    async function deleteAllSchedules(dateKey) {
        if (!window.ScheduleDB?.deleteSchedule) {
            logWarn('ScheduleDB.deleteSchedule not available');
            return { success: false, error: 'ScheduleDB not available' };
        }

        const result = await window.ScheduleDB.deleteSchedule(dateKey);
        log('Full delete result:', result);
        return result;
    }

    async function deleteMyBunksFromAllRecords(dateKey) {
        log('Deleting my bunks from ALL records...');

        const myBunks = getMyBunks();
        log('My bunks to delete:', myBunks);

        if (myBunks.length === 0) {
            log('No bunks assigned to delete');
            return { success: true, message: 'No bunks assigned' };
        }

        if (window.ScheduleDB?.deleteMyScheduleOnly) {
            const result = await window.ScheduleDB.deleteMyScheduleOnly(dateKey);
            log('ScheduleDB.deleteMyScheduleOnly result:', result);
            return result;
        }

        logWarn('ScheduleDB.deleteMyScheduleOnly not available, using fallback...');
        return await manualDeleteMyBunks(dateKey, myBunks);
    }

    async function manualDeleteMyBunks(dateKey, myBunks) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) {
            logError('Cannot delete: missing client or campId');
            return { success: false, error: 'Database not available' };
        }

        try {
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);

            if (loadError) {
                logError('Failed to load records:', loadError);
                return { success: false, error: loadError.message };
            }

            if (!allRecords || allRecords.length === 0) {
                log('No records found');
                return { success: true, message: 'No records to modify' };
            }

            log('Found', allRecords.length, 'records to process');

            const myBunkSet = new Set(myBunks);
            let recordsModified = 0;
            let recordsDeleted = 0;

            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...scheduleData.scheduleAssignments } || {};
                const leagues = { ...scheduleData.leagueAssignments } || {};

                const bunksBefore = Object.keys(assignments).length;

                let modified = false;
                for (const bunk of myBunks) {
                    if (assignments[bunk] !== undefined) {
                        delete assignments[bunk];
                        modified = true;
                    }
                    if (leagues[bunk] !== undefined) {
                        delete leagues[bunk];
                    }
                }

                const bunksAfter = Object.keys(assignments).length;
                log(`Record ${record.scheduler_name || record.id}: ${bunksBefore} → ${bunksAfter} bunks`);

                if (!modified) continue;

                if (bunksAfter === 0) {
                    const { error: deleteError } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('id', record.id);

                    if (deleteError) {
                        logError('Failed to delete empty record:', deleteError);
                    } else {
                        recordsDeleted++;
                        log('Deleted empty record');
                    }
                } else {
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
                        logError('Failed to update record:', updateError);
                    } else {
                        recordsModified++;
                        log('Updated record');
                    }
                }
            }

            return {
                success: true,
                recordsModified,
                recordsDeleted,
                bunksRemoved: myBunks.length
            };

        } catch (e) {
            logError('Manual delete exception:', e);
            return { success: false, error: e.message };
        }
    }

    function getMyBunks() {
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

    function clearMyBunksFromGlobals() {
        const myBunks = new Set(getMyBunks());

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

        log('Cleared', myBunks.size, 'bunks from window globals');
    }

    async function reloadAfterDelete(dateKey) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();

        if (!client || !campId) return;

        try {
            const { data: records } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);

            if (records && records.length > 0) {
                const merged = mergeCloudRecords(records);
                hydrateWindowGlobals(merged, dateKey);
                setLocalData(dateKey, merged);
                log('Reloaded remaining data:', Object.keys(merged.scheduleAssignments || {}).length, 'bunks');
            } else {
                log('No remaining data after delete');
            }
        } catch (e) {
            logError('Reload after delete failed:', e);
        }
    }

    // =========================================================================
    // HELPER: ENSURE EMPTY STATE
    // =========================================================================

    function ensureEmptyStateForAllDivisions() {
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }

        const divisions = window.divisions || {};

        for (const [divName, divData] of Object.entries(divisions)) {
            const bunks = divData.bunks || [];
            
            const divSlotCount = window.divisionTimes?.[divName]?.length || 
                                 (window.unifiedTimes || []).length || 22;

            for (const bunk of bunks) {
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = new Array(divSlotCount).fill(null);
                }
            }
        }
    }

    // =========================================================================
    // DATE CHANGE HANDLER (WITH AUTO-SAVE)
    // =========================================================================

    async function handleDateChange(newDateKey) {
        if (newDateKey === _currentDateKey) {
            log('Same date, skipping reload');
            return;
        }

        const oldDateKey = _currentDateKey;
        log('Date changed:', oldDateKey, '→', newDateKey);

        // ★★★ Capture transition ownership SYNCHRONOUSLY — before any await.
        // calendar.js sets window._pendingDateTransition immediately before it
        // dispatches campistry-date-changed, so the flag is reliably set in THIS
        // tick. Reading it only after the unsubscribe await below could see it
        // already cleared by integration_hooks, producing a false "not owned"
        // decision and re-opening the race.
        const _ownedByIH = !!(window._pendingDateTransition &&
                              window._pendingDateTransition.to === newDateKey);

        // ═══════════════════════════════════════════════════════════════
        // STEP 1: Unsubscribe from old date's realtime (non-destructive)
        // ═══════════════════════════════════════════════════════════════
        if (window.ScheduleSync?.unsubscribe) {
            log('Unsubscribing from realtime for', oldDateKey);
            try { await window.ScheduleSync.unsubscribe(); } catch (e) { /* non-fatal */ }
        }

        // ═══════════════════════════════════════════════════════════════
        // ★★★ FIX — date round-trip drift (dual date-change handler race) ★★★
        // integration_hooks.js ALSO handles this same date change: it auto-saves
        // the OLD date (while OLD data is still in window.scheduleAssignments)
        // then loads the NEW date, serialized behind window._pendingDateTransition.
        // If THIS handler ALSO runs its own save+load, the two async sequences
        // interleave on the shared window.scheduleAssignments and one of them
        // writes the NEW date's data under the OLD date's cloud key — silently
        // corrupting a day's schedule just by navigating to it. (Same class of
        // bug as commit 6c455045, but that fix only hardened integration_hooks'
        // handler; this orchestrator handler stayed unguarded and reintroduced
        // the race.)
        //
        // Resolution: when integration_hooks owns the transition (its flag is
        // set for THIS target date), DEFER — do not save or load here. Wait for
        // it to finish, then just sync our internal pointer. Fallback: if it
        // never completes (e.g. its date-picker hook isn't installed on this
        // page), take over so the date can never come up blank.
        // ═══════════════════════════════════════════════════════════════
        if (_ownedByIH) {
            log('Transition owned by integration_hooks — deferring orchestrator save/load to avoid race');
            const _waitStart = Date.now();
            while (window._pendingDateTransition &&
                   window._pendingDateTransition.to === newDateKey &&
                   (Date.now() - _waitStart) < 4000) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!(window._pendingDateTransition && window._pendingDateTransition.to === newDateKey)) {
                // integration_hooks completed the save+load. Sync our pointer.
                _currentDateKey = newDateKey;
                // Safety net: only load if it somehow left memory empty.
                if (Object.keys(window.scheduleAssignments || {}).length === 0) {
                    log('Memory empty after integration_hooks transition — orchestrator loading as fallback');
                    await loadSchedule(newDateKey);
                }
                return;
            }
            // integration_hooks never finished — take over (clear flag, fall through).
            logWarn('integration_hooks did not complete date transition in 4s — orchestrator taking over');
            window._pendingDateTransition = null;
        }

        // ═══════════════════════════════════════════════════════════════
        // OWNER PATH: no integration_hooks transition in flight (programmatic
        // load, calendar-view-only path, or takeover) — we save OLD + load NEW.
        // ═══════════════════════════════════════════════════════════════
        if (oldDateKey) {
            const currentBunks = Object.keys(window.scheduleAssignments || {}).length;
            if (currentBunks > 0) {
                log('Auto-saving before date change:', currentBunks, 'bunks');
                try {
                    await saveSchedule(oldDateKey, getWindowGlobals(), { immediate: true, silent: true });
                } catch (e) {
                    logError('Auto-save failed:', e);
                }
            }
        }

        // Load new date (which will also subscribe to realtime)
        await loadSchedule(newDateKey);
    }

    // =========================================================================
    // BEFOREUNLOAD HANDLER
    // =========================================================================

    function setupBeforeUnloadHandler() {
        // ★★★ v1.7 FIX: Also save on visibilitychange (more reliable than beforeunload) ★★★
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                const dateKey = getCurrentDateKey();
                const bunkCount = Object.keys(window.scheduleAssignments || {}).length;
                if (dateKey && bunkCount > 0) {
                    log('Page hidden, saving to localStorage...');
                    try {
                        setLocalData(dateKey, getWindowGlobals());
                    } catch (err) {
                        logError('Visibility save failed:', err);
                    }
                    // Attempt cloud save (visibilitychange gives more time than beforeunload)
                    if (!_permissionRevoked) {
                        window.ScheduleDB?.saveSchedule?.(dateKey, getWindowGlobals(), { immediate: true })
                            .catch(() => {});
                    }
                }
            }
        });

        window.addEventListener('beforeunload', (e) => {
            const dateKey = getCurrentDateKey();
            const bunkCount = Object.keys(window.scheduleAssignments || {}).length;

            if (dateKey && bunkCount > 0) {
                log('Page unloading, saving...');

                // Synchronous localStorage save (guaranteed)
                try {
                    setLocalData(dateKey, getWindowGlobals());
                } catch (err) {
                    logError('Final localStorage save failed:', err);
                }

                // Attempt async cloud save (may not complete)
                if (!_permissionRevoked) {
                    window.ScheduleDB?.saveSchedule?.(dateKey, getWindowGlobals(), { immediate: true })
                        .catch(() => {});
                }
            }
        });

        log('beforeunload + visibilitychange handlers installed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) {
            log('Already initialized');
            return;
        }

        log('Initializing...');

        // Wait for dependencies
        await waitForDependencies();

        // Set up event listeners
        setupEventListeners();

        // Set up beforeunload handler
        setupBeforeUnloadHandler();

        // Load initial data
        const dateKey = getCurrentDateKey();
        if (dateKey) {
            await loadSchedule(dateKey);
        }

        _isInitialized = true;
        log('✅ Orchestrator initialized');

        dispatch(CONFIG.EVENTS.READY, { dateKey });

        // Dispatch legacy event for backward compatibility
        window.__CAMPISTRY_CLOUD_READY__ = true;
        window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
    }

    async function waitForDependencies() {
        log('Waiting for dependencies...');

        // Wait for CampistryDB
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
            log('CampistryDB ready');
        }

        // Wait for ScheduleDB
        if (!window.ScheduleDB) {
            await new Promise(resolve => {
                const handler = () => {
                    window.removeEventListener('campistry-scheduledb-ready', handler);
                    resolve();
                };
                window.addEventListener('campistry-scheduledb-ready', handler);
                setTimeout(resolve, 3000);
            });
        }
        log('ScheduleDB ready');

        // Wait for AccessControl/Permissions
        if (!window.AccessControl && !window.PermissionsDB) {
            await new Promise(resolve => {
                const handler = () => {
                    window.removeEventListener('campistry-rbac-ready', handler);
                    window.removeEventListener('rbac-system-ready', handler);
                    resolve();
                };
                window.addEventListener('campistry-rbac-ready', handler);
                window.addEventListener('rbac-system-ready', handler);
                setTimeout(resolve, 3000);
            });
        }
        log('Permissions ready');
    }

    function setupEventListeners() {
        // Listen for date changes
        window.addEventListener('campistry-date-changed', (e) => {
            handleDateChange(e.detail?.dateKey);
        });

        // Listen for realtime updates from other schedulers
        window.addEventListener('campistry-realtime-update', (e) => {
            log('Realtime update received, reloading...');
            loadSchedule(getCurrentDateKey(), { force: true });
        });

        // Listen for generation complete - MUST be immediate + verified
        window.addEventListener('campistry-generation-complete', async (e) => {
            const dateKey = e.detail?.dateKey || getCurrentDateKey();
            // ★★★ CROSS-DATE GUARD: a generation populates scheduleAssignments for THIS
            // date — stamp it so the post-gen save isn't false-blocked and so any later
            // navigation save can't write this fresh schedule under another date's key.
            window._scheduleAssignmentsDate = dateKey;
            const bunkCount = Object.keys(window.scheduleAssignments || {}).length;
            log('Generation complete, saving immediately...', bunkCount, 'bunks');
            
            // Step 1: Save to localStorage FIRST (synchronous, guaranteed)
            setLocalData(dateKey, getWindowGlobals());
            
            // Step 2: Immediate cloud save with verification (silent — user already saw "Schedule Generated!")
            const result = await saveSchedule(dateKey, getWindowGlobals(), { immediate: true, silent: true });
            if (result?.success) {
                log('✅ Post-generation save confirmed:', result.target);
            } else {
                logWarn('⚠️ Post-generation cloud save issue:', result?.error);
                // Retry once more after a short delay
                setTimeout(async () => {
                    await saveSchedule(dateKey, getWindowGlobals(), { immediate: true, silent: true });
                }, 2000);
            }
        });

        // ★★★ v1.6 SECURITY: Listen for permission revocation from ScheduleDB or AccessControl ★★★
        window.addEventListener('campistry-permission-revoked', (e) => {
            logWarn('🚨 Permission revocation event received:', e.detail);
            _permissionRevoked = true;
            _isSaving = false;

            // Clear save queue to prevent queued saves from firing
            if (_saveTimeout) {
                clearTimeout(_saveTimeout);
                _saveTimeout = null;
            }
            _saveQueue = [];

            showNotification('Your permissions have changed — please refresh the page', 'error');
        });

        // ★★★ v1.6: Listen for role changes (may upgrade or downgrade permissions) ★★★
        window.addEventListener('campistry-role-changed', (e) => {
            log('Role changed event received:', e.detail);
            // Reset permission flag — new role may have different access
            _permissionRevoked = false;
        });

        log('Event listeners set up');
    }

    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    async function diagnose() {
        const dateKey = getCurrentDateKey();
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('🎯 ORCHESTRATOR DIAGNOSIS v1.6');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Version:', CONFIG.VERSION);
        console.log('Initialized:', _isInitialized);
        console.log('Is Loading:', _isLoading);
        console.log('Is Saving:', _isSaving);
        console.log('Permission Revoked:', _permissionRevoked);  // ★ v1.6
        console.log('Online:', navigator.onLine);
        console.log('Current Date Key:', dateKey);
        console.log('Last Save Time:', _lastSaveTime ? new Date(_lastSaveTime).toISOString() : 'Never');
        console.log('');
        
        console.log('=== Window Globals ===');
        const windowBunks = Object.keys(window.scheduleAssignments || {}).length;
        console.log('scheduleAssignments:', windowBunks, 'bunks');
        console.log('leagueAssignments:', Object.keys(window.leagueAssignments || {}).length, 'entries');
        console.log('unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('divisionTimes:', Object.keys(window.divisionTimes || {}).length, 'divisions');
        console.log('isRainyDay:', window.isRainyDay);
        console.log('rainyDayStartTime:', window.rainyDayStartTime);
        console.log('');
        
        console.log('=== LocalStorage ===');
        const localData = getLocalData(dateKey);
        if (localData) {
            const localBunks = Object.keys(localData.scheduleAssignments || {}).length;
            console.log('scheduleAssignments:', localBunks, 'bunks');
            console.log('unifiedTimes:', (localData.unifiedTimes || []).length, 'slots');
            console.log('isRainyDay:', localData.isRainyDay);
            console.log('rainyDayStartTime:', localData.rainyDayStartTime);
            console.log('Updated at:', localData._updatedAt || 'Unknown');
        } else {
            console.log('No data for', dateKey);
        }
        console.log('');
        
        console.log('=== Cloud (Supabase) ===');
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        const userId = window.CampistryDB?.getUserId?.();
        
        console.log('Client:', client ? '✅' : '❌');
        console.log('Camp ID:', campId || '❌');
        console.log('User ID:', userId?.substring(0, 8) + '...' || '❌');
        
        if (client && campId) {
            try {
                const { data, error } = await client
                    .from('daily_schedules')
                    .select('scheduler_id, scheduler_name, divisions, updated_at, schedule_data, unified_times, is_rainy_day')
                    .eq('camp_id', campId)
                    .eq('date_key', dateKey);

                if (error) {
                    console.log('Query error:', error.message);
                } else if (!data || data.length === 0) {
                    console.log('⚠️ NO RECORDS IN CLOUD for', dateKey);
                } else {
                    console.log('Found', data.length, 'record(s):');
                    let totalCloudBunks = 0;
                    data.forEach((r, i) => {
                        const bunks = Object.keys(r.schedule_data?.scheduleAssignments || {}).length;
                        const slots = r.schedule_data?.unifiedTimes?.length || r.unified_times?.length || 0;
                        const isRainy = r.is_rainy_day || r.schedule_data?.isRainyDay || r.schedule_data?.rainyDayMode;
                        const rainyStart = r.schedule_data?.rainyDayStartTime;
                        totalCloudBunks += bunks;
                        const isMe = r.scheduler_id === userId ? ' (YOU)' : '';
                        console.log(`  [${i + 1}] ${r.scheduler_name || 'Unknown'}${isMe}`);
                        console.log(`      Divisions: ${JSON.stringify(r.divisions)}`);
                        console.log(`      Bunks: ${bunks}, Slots: ${slots}`);
                        console.log(`      Rainy: ${isRainy}, StartTime: ${rainyStart}`);
                        console.log(`      Updated: ${r.updated_at}`);
                    });
                    console.log('Total cloud bunks (merged):', totalCloudBunks);
                }
            } catch (e) {
                console.log('Cloud query exception:', e.message);
            }
        }
        console.log('');
        
        console.log('=== Consistency Check ===');
        if (client && campId && windowBunks > 0) {
            const verification = await verifyCloudSave(dateKey, windowBunks, 1);
            if (verification.verified) {
                console.log('✅ Your data is in the cloud');
            } else {
                console.log('⚠️ Your data may NOT be in cloud:', verification.reason);
                console.log('   Run: await ScheduleOrchestrator.saveSchedule(null, null, {immediate: true})');
            }
        }
        console.log('');
        
        console.log('=== Quick Actions ===');
        console.log('// Force save to cloud:');
        console.log('await ScheduleOrchestrator.saveSchedule(null, null, {immediate: true})');
        console.log('');
        console.log('// Force load from cloud:');
        console.log('await ScheduleOrchestrator.loadSchedule(null, {force: true})');
        console.log('');
        console.log('// Delete schedule:');
        console.log('await ScheduleOrchestrator.deleteSchedule()');
        console.log('═══════════════════════════════════════════════════════');
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.ScheduleOrchestrator = {
        // Core operations
        loadSchedule,
        saveSchedule,
        deleteSchedule,
        
        // Date management
        getCurrentDateKey,
        setCurrentDateKey,
        handleDateChange,
        
        // State access
        getWindowGlobals,
        getLocalData,
        
        // Verification
        verifyCloudSave,
        
        // Utilities
        getMyBunks,
        ensureEmptyStateForAllDivisions,
        showNotification,
        
        // Diagnostics
        diagnose,
        
        // ★ EXPOSED FOR VERIFICATION
        CONFIG,
        get _loadAbortController() { return _loadAbortController; },
        
        // Status
        get isInitialized() { return _isInitialized; },
        get isLoading() { return _isLoading; },
        get isSaving() { return _isSaving; },
        get permissionRevoked() { return _permissionRevoked; },  // ★ v1.6
        get version() { return CONFIG.VERSION; }
    };

    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initialize, 200);
        });
    } else {
        setTimeout(initialize, 200);
    }

    console.log('🎯 Campistry Schedule Orchestrator v1.6 loaded — permission-aware retries');

})();
