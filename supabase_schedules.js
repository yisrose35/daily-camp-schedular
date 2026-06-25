// =============================================================================
// supabase_schedules.js v5.4 — CAMPISTRY SCHEDULE DATABASE OPERATIONS
// =============================================================================
//
// Pure data operations for schedules.
//
// REPLACES: Schedule CRUD scattered across cloud_storage_bridge, 
//           unified_cloud_schedule_system, scheduler_data_management
//
// PROVIDES:
// - Load/save schedules per date
// - Multi-scheduler merge logic
// - UnifiedTimes serialization
// - Version management
// - Local storage sync
//
// REQUIRES: supabase_client.js, supabase_permissions.js
//
// v5.4 SECURITY:
// - ★ CRITICAL: Permission-aware error handling in saveSchedule()
// - ★ Detects RLS violations (Postgres 42501, PostgREST 401/403)
// - ★ Separates permission errors (requires reauth) from network errors (retry-safe)
// - ★ Dispatches 'campistry-permission-revoked' event for other modules
// - ★ Forces RBAC re-initialization on permission errors
//
// v5.3 FIXES:
// - ★ CRITICAL: unifiedTimes now properly included in mergeSchedules return
// - ★ Added mergedUnifiedTimes tracking (uses longest array)
// - ★ Improved save verification with exponential backoff
//
// v5.2 UPDATE:
// - Added divisionTimes support in save payload and merge logic
//
// v5.1 FIXES:
// - Fixed filtering to use AccessControl instead of PermissionsDB
// - PermissionsDB was returning empty bunks, causing 0 bunks to be saved
//
// =============================================================================
(function() {
    'use strict';
    console.log('📅 Campistry Schedule DB v5.4 loading...');
    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    const CONFIG = {
        TABLE_NAME: 'daily_schedules',
        LOCAL_STORAGE_KEY: 'campDailyData_v1',
        DEBUG: false,
        VERIFY_MAX_ATTEMPTS: 3,
        VERIFY_BASE_DELAY_MS: 500
    };
    // =========================================================================
    // STATE
    // =========================================================================
    let _isInitialized = false;
    // =========================================================================
    // LOGGING
    // =========================================================================
    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('📅 [ScheduleDB]', ...args);
        }
    }
    function logError(...args) {
        console.error('📅 [ScheduleDB] ERROR:', ...args);
    }
    function logWarn(...args) {
        console.warn('📅 [ScheduleDB] WARN:', ...args);
    }
    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    async function initialize() {
        if (_isInitialized) return;
        // Wait for dependencies
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }
        _isInitialized = true;
        log('Initialized');
        window.dispatchEvent(new CustomEvent('campistry-scheduledb-ready'));
    }
    // =========================================================================
    // HELPERS: SUPABASE ACCESS
    // =========================================================================
    function getClient() {
        return window.CampistryDB?.getClient?.();
    }
    function getCampId() {
        return window.CampistryDB?.getCampId?.();
    }
    function getUserId() {
        return window.CampistryDB?.getUserId?.();
    }
    function getSchedulerName() {
        // Try AccessControl first
        if (window.AccessControl?.getCurrentUserInfo) {
            const info = window.AccessControl.getCurrentUserInfo();
            if (info?.name) return info.name;
        }
        
        // Try membership data
        const membership = window._campistryMembership;
        if (membership?.name) return membership.name;
        
        // Fallback to email
        const session = window.CampistryDB?.getSession?.();
        if (session?.user?.email) {
            return session.user.email.split('@')[0];
        }
        
        return 'Unknown Scheduler';
    }
    // =========================================================================
    // HELPERS: TIME SERIALIZATION
    // =========================================================================
    function serializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        
        return times.map(t => ({
            start: t.start instanceof Date ? t.start.toISOString() : t.start,
            end: t.end instanceof Date ? t.end.toISOString() : t.end,
            startMin: t.startMin ?? (t.start instanceof Date ? t.start.getHours() * 60 + t.start.getMinutes() : null),
            endMin: t.endMin ?? (t.end instanceof Date ? t.end.getHours() * 60 + t.end.getMinutes() : null),
            label: t.label || ''
        }));
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
    // =========================================================================
    // HELPERS: LOCAL STORAGE
    // =========================================================================
    function getLocalData() {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            logError('Failed to read local storage:', e);
            return {};
        }
    }
    function pruneOldDates(data, keepCount) {
        const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
        const dateKeys = Object.keys(data).filter(k => DATE_RE.test(k));
        if (dateKeys.length <= keepCount) return data;
        dateKeys.sort();
        const toRemove = dateKeys.slice(0, dateKeys.length - keepCount);
        toRemove.forEach(k => delete data[k]);
        return data;
    }

    function setLocalData(data) {
        try {
            // ★★★ DAY 17 FIX: bump cap from 5 → 30 dates ★★★
            // This is the most aggressive trimmer — fires on EVERY cloud
            // save's local-write path (setLocalSchedule → setLocalData).
            // With cap=5 it kept overwriting the orchestrator's wider-cap
            // localStorage write back down to 5 dates after every save.
            // That broke getPeriodActivityCount's week-window count and
            // silently disabled exactFrequency / rotationCohort enforcement.
            // 30 matches the orchestrator's setLocalData cap and gives the
            // rotation engine a full month of history to score against.
            pruneOldDates(data, 30);
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                // Step down progressively under genuine quota pressure
                pruneOldDates(data, 14);
                try {
                    localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
                } catch (_) {
                    pruneOldDates(data, 7);
                    try {
                        localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
                    } catch (_) { /* cloud has it */ }
                }
            } else {
                logError('Failed to write local storage:', e);
            }
        }
    }
    function getLocalSchedule(dateKey) {
        const data = getLocalData();
        return data[dateKey] || null;
    }
    // Fields that live only in localStorage and are NEVER uploaded to cloud.
    // When cloud data overwrites local, we must carry these forward so they aren't lost.
    const LOCAL_ONLY_FIELDS = [
        'bunkActivityOverrides',       // per-bunk activity overrides (daily_adjustments)
        'overrides',                   // field/bunk/league overrides
        'autoSkeleton',                // generated skeleton from auto planner
        '_autoGenerated',              // flag: schedule was auto-generated
        '_autoBuildTimelines',         // auto-build bunk timelines
        '_autoGenMeta',                // auto-generation metadata
        'manualSkeleton',              // manual skeleton from master builder
        'skeleton',                    // active skeleton
        'dailyDisabledSportsByField',  // per-day field sport restrictions
        'dailyFieldAvailability',      // per-day field availability
        'disabledSpecialtyLeagues',    // disabled specialty leagues for day
        'dailyActivityBunkRestrictions', // per-day "only available for these bunk(s)" restrictions
        'leagueRoundState',            // league round state
        'leagueDayCounters',           // league day counters
    ];

    function setLocalSchedule(dateKey, schedule) {
        const data = getLocalData();
        const existing = data[dateKey] || {};

        // Sidecar _perBunkSlotsData — _perBunkSlots is a custom array property that
        // JSON.stringify strips. Extract it into a sibling field so it survives the
        // round-trip, matching the convention used by scheduler_core_auto.js save.
        let safe = schedule;
        if (schedule && schedule.divisionTimes) {
            const spbs = {};
            Object.keys(schedule.divisionTimes).forEach(g => {
                const dt = schedule.divisionTimes[g];
                if (dt && dt._perBunkSlots) spbs[g] = dt._perBunkSlots;
            });
            if (Object.keys(spbs).length > 0) {
                safe = Object.assign({}, schedule, { _perBunkSlotsData: spbs });
            }
        }

        // ★★★ FIX: Preserve local-only fields that cloud never stores.
        // Cloud data (scheduleAssignments etc) always wins, but any field
        // in LOCAL_ONLY_FIELDS that is missing from the new data is carried
        // forward from the existing local record — preventing data wipe on
        // every save/load cycle.
        const merged = Object.assign({}, safe);
        LOCAL_ONLY_FIELDS.forEach(field => {
            if (merged[field] === undefined && existing[field] !== undefined) {
                merged[field] = existing[field];
            }
        });

        data[dateKey] = merged;
        setLocalData(data);
    }
    function deleteLocalSchedule(dateKey) {
        const data = getLocalData();
        delete data[dateKey];
        setLocalData(data);
    }

    // =========================================================================
    // ★★★ v5.4 SECURITY: PERMISSION ERROR DETECTION ★★★
    // =========================================================================

    /**
     * Detect whether a Supabase error is a permission/RLS violation.
     * These errors mean the user's role was revoked and retrying is futile.
     */
    function isPermissionError(error) {
        if (!error) return false;
        return (
            error.code === '42501' ||                          // Postgres RLS violation
            error.code === 'PGRST301' ||                      // PostgREST unauthorized
            error.message?.includes('permission denied') ||
            error.message?.includes('row-level security') ||
            error.message?.includes('new row violates') ||
            (error.status && (error.status === 403 || error.status === 401))
        );
    }

    /**
     * Handle a confirmed permission error: notify user, refresh RBAC, dispatch event.
     */
    async function handlePermissionError(operation, error) {
        logError('🚨 PERMISSION ERROR during', operation, '— user may have been revoked');

        // Notify user
        if (typeof window.showToast === 'function') {
            window.showToast('Your permissions have changed. Please refresh or sign in again.', 'error');
        }

        // Force RBAC re-initialization (will pick up new role or detect removal)
        if (window.AccessControl?.refresh) {
            try { await window.AccessControl.refresh(); } catch(e) {
                logWarn('RBAC refresh after permission error failed:', e);
            }
        }

        // Dispatch event so orchestrator + other modules can react
        window.dispatchEvent(new CustomEvent('campistry-permission-revoked', {
            detail: { operation, error: error?.message || 'Permission denied' }
        }));
    }

    // =========================================================================
    // HELPERS: PERMISSIONS (FIXED - Uses AccessControl)
    // =========================================================================
    
    /**
     * Get bunks that the current user can edit.
     * Uses AccessControl (which has correct permissions) instead of PermissionsDB.
     */
    function getMyEditableBunks() {
        const role = window.CampistryDB?.getRole?.() || 
                     window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        // Owners and admins can edit all bunks
        if (role === 'owner' || role === 'admin') {
            const allBunks = [];
            const divisions = window.divisions || {};
            Object.values(divisions).forEach(div => {
                if (div.bunks) allBunks.push(...div.bunks);
            });
            log('Owner/admin - all bunks:', allBunks.length);
            return allBunks.map(String);
        }
        
        // ★ MS-2: for schedulers, scope the SAVE filter to their ASSIGNED
        // divisions (getGeneratableDivisions), not the v3.13 "full editing
        // access" set (getEditableDivisions = every division). Otherwise a
        // scheduler's row absorbs stale copies of every other division
        // (realtime-merged into their memory) stamped with a fresh
        // updated_at — which silently shadows the owner's later edits in
        // the per-bunk newest-wins merge. Explicit cross-division writes
        // still bypass via options.skipFilter.
        let editableDivisions = [];
        if (role === 'scheduler') {
            try { editableDivisions = window.AccessControl?.getGeneratableDivisions?.() || []; } catch (e) {}
            // ★★★ CB-6: do NOT fall back to getEditableDivisions() for a
            // scheduler — under v3.13 that returns EVERY division, so an empty
            // generatable set (AccessControl init race / no subdivisions yet)
            // would make the scheduler's save absorb the whole camp and shadow
            // the owner in the per-bunk merge. Leave it empty; the empty-set
            // handling below blocks the save rather than uploading everything.
        } else {
            editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        }
        log('Editable divisions from AccessControl:', editableDivisions);
        
        if (editableDivisions.length === 0) {
            log('WARNING: No editable divisions from AccessControl, trying PermissionsDB...');
            // Fallback: try PermissionsDB
            const permBunks = window.PermissionsDB?.getEditableBunks?.() || [];
            if (permBunks.length > 0) {
                log('Using PermissionsDB fallback:', permBunks.length, 'bunks');
                return permBunks.map(String);
            }
            logError('No editable bunks found from any source!');
            return [];
        }
        
        // Get bunks for editable divisions
        const divisions = window.divisions || {};
        const bunks = [];
        
        editableDivisions.forEach(divName => {
            const divData = divisions[divName] || divisions[String(divName)];
            if (divData?.bunks) {
                bunks.push(...divData.bunks);
            }
        });
        
        log('Editable bunks:', bunks.length, 'from divisions:', editableDivisions);
        return bunks.map(String);
    }

    /**
     * Filter schedule data to only include bunks the user can edit.
     * FIXED: Uses AccessControl instead of PermissionsDB.
     */
    function filterScheduleToMyBunks(scheduleAssignments) {
        const role = window.CampistryDB?.getRole?.() || 
                     window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        // Owners and admins get everything
        if (role === 'owner' || role === 'admin') {
            log('Full access - no filtering needed');
            return scheduleAssignments;
        }
        
        const myBunks = new Set(getMyEditableBunks());

        if (myBunks.size === 0) {
            logError('WARNING: No editable bunks found! Cannot filter properly.');
            logError('AccessControl divisions:', window.AccessControl?.getEditableDivisions?.());
            logError('PermissionsDB bunks:', window.PermissionsDB?.getEditableBunks?.());
            // ★★★ CB-18 / CB-112: do NOT fail open to the full camp schedule.
            // RLS does not inspect schedule_data content, so returning everything
            // here let a scheduler whose bunk set resolved empty (init race)
            // upload ALL divisions with fresh stamps and shadow the owner. Return
            // empty instead — the empty-save guard then blocks the write and
            // leaves the cloud row intact; the save retries once AccessControl is
            // initialized. (owner/admin already returned the full set above.)
            return {};
        }
        
        const filtered = {};
        let filteredCount = 0;
        let totalCount = 0;
        
        Object.entries(scheduleAssignments || {}).forEach(([bunkId, slots]) => {
            totalCount++;
            if (myBunks.has(String(bunkId))) {
                filtered[bunkId] = slots;
                filteredCount++;
            }
        });
        
        log(`Filtered to my bunks: ${filteredCount} of ${totalCount}`);
        
        if (filteredCount === 0 && totalCount > 0) {
            logError('WARNING: All bunks were filtered out!');
            logError('My editable bunks:', [...myBunks]);
            logError('Schedule bunk IDs:', Object.keys(scheduleAssignments));
        }
        
        return filtered;
    }

    /**
     * Get editable divisions - prefers AccessControl over PermissionsDB
     */
    function getMyEditableDivisions() {
        const role = window.CampistryDB?.getRole?.() || 
                     window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {});
        }
        
        // Prefer AccessControl (properly initialized)
        const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        if (acDivisions.length > 0) {
            return acDivisions;
        }
        
        // Fallback to PermissionsDB
        return window.PermissionsDB?.getEditableDivisions?.() || [];
    }

    // =========================================================================
    // LOAD OPERATIONS
    // =========================================================================
    /**
     * Load schedule for a specific date.
     * Returns merged data from all schedulers.
     */
    async function loadSchedule(dateKey) {
        const client = getClient();
        const campId = getCampId();
        
        if (!client || !campId) {
            log('No client or camp ID, loading from local only');
            return { success: true, data: getLocalSchedule(dateKey), source: 'local' };
        }
        try {
            const records = await loadAllSchedulersForDate(dateKey);

            // CB-2: a transient query failure returns an empty array TAGGED
            // _queryErrored. Do NOT treat that as "the date was deleted" — keep
            // the local cache and surface a fallback so consumers don't wipe
            // memory/localStorage on a momentary network/auth hiccup.
            if (records && records._queryErrored) {
                logError('Cloud query errored for', dateKey, '— preserving local cache (not treating as empty)');
                return { success: false, error: 'query-failed', data: getLocalSchedule(dateKey), source: 'local-fallback' };
            }

            if (!records || records.length === 0) {
                log('No cloud records — clearing local cache for this date');
                deleteLocalSchedule(dateKey);
                return { success: true, data: { scheduleAssignments: {}, leagueAssignments: {}, unifiedTimes: [], divisionTimes: {} }, source: 'cloud', recordCount: 0 };
            }
            const merged = mergeSchedules(records);
            
            // Update local storage with merged data
            setLocalSchedule(dateKey, merged);
            
            return { success: true, data: merged, source: 'cloud', recordCount: records.length };
            
        } catch (e) {
            logError('Load failed:', e);
            return { success: false, error: e.message, data: getLocalSchedule(dateKey), source: 'local-fallback' };
        }
    }
    /**
     * Load all scheduler records for a date (for merging).
     */
    async function loadAllSchedulersForDate(dateKey) {
        const client = getClient();
        const campId = getCampId();
        
        // CB-2: distinguish a TRANSIENT query failure from a genuinely-empty
        // date. A bare [] for both let loadSchedule (and the delete paths)
        // treat a network blip / mid-refresh auth error as "owner deleted
        // everything" and wipe the local cache. We tag the failure array with
        // a non-enumerable _queryErrored flag that rides on the returned
        // instance (race-safe — no shared module state) and is invisible to
        // the many callers that only read .length.
        const _erroredResult = () => { const a = []; try { Object.defineProperty(a, '_queryErrored', { value: true, enumerable: false }); } catch (_) { a._queryErrored = true; } return a; };
        if (!client || !campId) return _erroredResult();
        try {
            const { data, error } = await client
                .from(CONFIG.TABLE_NAME)
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            if (error) {
                logError('Query error:', error);
                return _erroredResult();
            }
            log(`Loaded ${data?.length || 0} records for ${dateKey}`);
            return data || [];

        } catch (e) {
            logError('loadAllSchedulersForDate failed:', e);
            return _erroredResult();
        }
    }

    /**
     * ★★★ CB-70: list the distinct date_keys that have a cloud schedule for this
     * camp. Lightweight (selects only date_key). Lets the calendar overview mark
     * cloud-only / locally-pruned dates as "has schedule" instead of showing a
     * false "No schedule". Returns [] on any error (caller treats as "no extra
     * cloud dates" — purely additive, never removes local markers).
     */
    async function listScheduleDates() {
        const client = getClient();
        const campId = getCampId();
        if (!client || !campId) return [];
        try {
            const { data, error } = await client
                .from(CONFIG.TABLE_NAME)
                .select('date_key')
                .eq('camp_id', campId);
            if (error) { logError('listScheduleDates query error:', error); return []; }
            const seen = {};
            (data || []).forEach(r => { if (r && r.date_key) seen[String(r.date_key).substring(0, 10)] = 1; });
            return Object.keys(seen);
        } catch (e) {
            logError('listScheduleDates failed:', e);
            return [];
        }
    }

    /**
     * Load schedules for a date range.
     */
    async function loadDateRange(startDate, endDate) {
        const client = getClient();
        const campId = getCampId();
        
        if (!client || !campId) return [];
        try {
            const { data, error } = await client
                .from(CONFIG.TABLE_NAME)
                .select('*')
                .eq('camp_id', campId)
                .gte('date_key', startDate)
                .lte('date_key', endDate);
            if (error) {
                logError('Date range query error:', error);
                return [];
            }
            return data || [];
            
        } catch (e) {
            logError('loadDateRange failed:', e);
            return [];
        }
    }
    // =========================================================================
    // MERGE LOGIC - ★★★ FIXED v5.3: unifiedTimes now properly returned ★★★
    // =========================================================================
    /**
     * Merge multiple scheduler records into a single schedule.
     * Each scheduler's bunk data takes precedence for their bunks.
     * UnifiedTimes uses the longest array.
     */
    function mergeSchedules(records) {
        if (!records || records.length === 0) return null;

        const mergedAssignments = {};
        const mergedSegments = {};
        const mergedLeagues = {};
        let mergedUnifiedTimes = [];
        let mergedDivisionTimes = {};
        let maxSlots = 0;
        let isRainyDay = false;
        // ★★★ CB-21: track the auto-mode signals so the PRIMARY load paths
        // (date-change / realtime, which call mergeSchedules) keep them. They
        // were dropped from the return, so post-edit gates / rebuild logic on
        // those paths couldn't tell an auto build from a manual one.
        let mergedAutoGenerated = false;
        let mergedManualSkeleton = null;

        // Sort by updated_at ascending so the most recently saved record wins
        records.sort((a, b) => {
            const ta = a.updated_at || a.created_at || '';
            const tb = b.updated_at || b.created_at || '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

        // ★ MS-3: per-bunk winner is decided by the bunk's DIVISION stamp
        // (payload._divStamps, written at save time) when available, falling
        // back to the row's updated_at. This stops a scoped generation's
        // re-saved STALE copies of other divisions (fresh row timestamp,
        // old content) from shadowing the other scheduler's newer work.
        const _bunkToDiv = {};
        try {
            Object.entries(window.divisions || {}).forEach(([dn, di]) =>
                ((di && di.bunks) || []).forEach(b => { _bunkToDiv[String(b)] = dn; }));
        } catch (e) { /* fall back to row timestamps */ }
        const _bunkEff = {};
        const _segEff = {};
        // ★ MS-4c: the division's GRID (divisionTimes + _perBunkSlotsData)
        // must come from the SAME row that wins the division's CONTENT.
        // The old "keep the version with more slots" rule could pair one
        // scheduler's 12-slot grid with another's 10-slot assignments for
        // the same division — post-edit saves then fail the shape guard
        // ("Slot count mismatch — refusing upload").
        const _divEff = {}, _divWinnerDT = {}, _divWinnerPBS = {};

        records.forEach(record => {
            const data = record.schedule_data || {};
            const _rowMs = Date.parse(record.updated_at || record.created_at || '') || 0;
            const _stamps = data._divStamps || null;
            const _effFor = function (bunkId) {
                const dn = _bunkToDiv[String(bunkId)];
                return (_stamps && dn && _stamps[dn] != null) ? _stamps[dn] : _rowMs;
            };
            try {
                const _divsInRow = new Set();
                Object.keys(data.scheduleAssignments || {}).forEach(b => {
                    const dn = _bunkToDiv[String(b)];
                    if (dn) _divsInRow.add(dn);
                });
                _divsInRow.forEach(dn => {
                    const eff = (_stamps && _stamps[dn] != null) ? _stamps[dn] : _rowMs;
                    if (_divEff[dn] == null || eff > _divEff[dn]) {
                        _divEff[dn] = eff;
                        if (data.divisionTimes && data.divisionTimes[dn]) _divWinnerDT[dn] = data.divisionTimes[dn];
                        if (data._perBunkSlotsData && data._perBunkSlotsData[dn]) _divWinnerPBS[dn] = data._perBunkSlotsData[dn];
                    }
                });
            } catch (eDW) { /* fall back to more-slots merge */ }

            log('Merging from', record.scheduler_name || 'unknown', {
                bunks: Object.keys(data.scheduleAssignments || {}).length,
                slots: data.unifiedTimes?.length || 0
            });

            // Merge scheduleAssignments (each scheduler owns their bunks);
            // per-bunk newest-by-division-stamp wins (>= keeps the legacy
            // ascending-updated_at behavior for ties and unstamped rows)
            if (data.scheduleAssignments) {
                Object.entries(data.scheduleAssignments).forEach(([bunkId, slots]) => {
                    const eff = _effFor(bunkId);
                    // strict > : a CARRIED-FORWARD stamp equals the original
                    // owner's stamp — the original (processed earlier) must
                    // keep the bunk, not the row that merely copied it
                    if (_bunkEff[bunkId] == null || eff > _bunkEff[bunkId]) {
                        _bunkEff[bunkId] = eff;
                        mergedAssignments[bunkId] = slots;
                    }
                });
            }

            // Phase 4: merge scheduleSegments per-bunk (same ownership as assignments)
            if (data.scheduleSegments) {
                Object.entries(data.scheduleSegments).forEach(([bunkId, row]) => {
                    const eff = _effFor(bunkId);
                    if (_segEff[bunkId] == null || eff > _segEff[bunkId]) {
                        _segEff[bunkId] = eff;
                        mergedSegments[bunkId] = row;
                    }
                });
            }
            
            // Merge leagueAssignments
            if (data.leagueAssignments) {
                Object.entries(data.leagueAssignments).forEach(([div, slots]) => {
                    mergedLeagues[div] = slots;
                });
            }
            
            // ★★★ CB-16: unifiedTimes by RECENCY, not longest array. Records are
            // sorted ascending by updated_at, so the newest non-empty value wins
            // (overwrite as we go). The old "longest array" rule meant a REDUCED
            // slot count (a period removed) could never propagate — the stale,
            // longer grid was kept forever and re-persisted. A non-empty guard
            // still prevents an empty array from clobbering a real grid.
            if (data.unifiedTimes && Array.isArray(data.unifiedTimes) && data.unifiedTimes.length > 0) {
                mergedUnifiedTimes = data.unifiedTimes;
                maxSlots = data.unifiedTimes.length;
            }

            // Also check record.unified_times (separate column) — newest non-empty wins
            if (record.unified_times && Array.isArray(record.unified_times) && record.unified_times.length > 0) {
                mergedUnifiedTimes = record.unified_times;
                maxSlots = record.unified_times.length;
            }

            // Merge divisionTimes
            if (data.divisionTimes && Object.keys(data.divisionTimes).length > 0) {
                Object.entries(data.divisionTimes).forEach(([divName, slots]) => {
                    // Keep the version with more slots for each division
                    if (!mergedDivisionTimes[divName] || slots.length > mergedDivisionTimes[divName].length) {
                        mergedDivisionTimes[divName] = slots;
                    }
                });
            }

            // Rainy day flag
            if (record.is_rainy_day) {
                isRainyDay = true;
            }

            // CB-21: auto-mode signals (records sorted ascending → newest wins)
            if (data._autoGenerated === true) mergedAutoGenerated = true;
            if (Array.isArray(data.manualSkeleton) && data.manualSkeleton.length > 0) {
                mergedManualSkeleton = data.manualSkeleton;
            }
        });
        
        // ★★★ #V2-25: STRUCTURE-AWARE PRUNE — kill the cross-scheduler deleted-bunk
        // RESURRECTION bug. The per-bunk merge above re-introduces any bunk present in
        // ANY scheduler's row. So when the owner deletes a bunk from the camp structure,
        // a stale OTHER-scheduler row (saved before the deletion) RESURRECTS it on every
        // load — it pollutes scheduleAssignments, re-persists on the next save, and skews
        // field-conflict counts. Drop any merged bunk no longer in the FULL camp structure.
        //   • Source = app1.divisions (CONFIG-level, shared by all users, NOT the
        //     scope-filtered window.divisions) so we never over-prune a scoped scheduler's
        //     real-but-out-of-scope bunks.
        //   • GUARDED: if the structure isn't definitively loaded (empty), skip entirely —
        //     never wipe a legitimately-loaded schedule during an early/racing load.
        // (Full live reproduction needs 2 accounts; the prune itself is single-account-safe
        //  and is a no-op when no bunk is orphaned.)
        try {
            // Only when MERGING ≥2 scheduler rows — resurrection requires a 2nd (stale)
            // row; a single row is fully replaced by its own upsert so it can't resurrect.
            // This makes single-user loads a guaranteed no-op (zero over-prune risk).
            const _gs = (records.length > 1 && window.loadGlobalSettings) ? window.loadGlobalSettings() : null;
            const _divs = (_gs && _gs.app1 && _gs.app1.divisions) || null;
            if (_divs && Object.keys(_divs).length > 0) {
                const _valid = new Set();
                Object.values(_divs).forEach(d => { if (d && Array.isArray(d.bunks)) d.bunks.forEach(b => _valid.add(String(b))); });
                if (_valid.size > 0) {
                    let _pruned = 0;
                    Object.keys(mergedAssignments).forEach(b => { if (!_valid.has(String(b))) { delete mergedAssignments[b]; _pruned++; } });
                    Object.keys(mergedSegments).forEach(b => { if (!_valid.has(String(b))) { delete mergedSegments[b]; } });
                    if (_pruned > 0) log('★ #V2-25 pruned', _pruned, 'resurrected/orphan bunk(s) not in camp structure');
                }
            }
        } catch (e) { /* non-fatal: never let the prune break a load */ }

        // ★ MS-3: remember the winning per-division stamps so this session's
        // later saves CARRY THEM FORWARD for divisions a scoped generation
        // doesn't touch (without this, the save side has no "prev" and
        // stamps everything NOW — recreating the stale-copy shadowing).
        try {
            const _dk = records[0] && (records[0].date_key || records[0].dateKey);
            if (_dk) {
                const m = {};
                Object.keys(_bunkEff).forEach(b => {
                    const dn = _bunkToDiv[String(b)];
                    if (dn) m[dn] = Math.max(m[dn] || 0, _bunkEff[b] || 0);
                });
                window.__divStampCache = window.__divStampCache || {};
                window.__divStampCache[_dk] = Object.assign({}, window.__divStampCache[_dk] || {}, m);
            }
        } catch (eDS) { /* non-fatal */ }

        // ★ MS-4c: override the more-slots divisionTimes merge with the
        // content-winner's grid per division (keeps grid ≡ content)
        try {
            Object.keys(_divWinnerDT).forEach(dn => { mergedDivisionTimes[dn] = _divWinnerDT[dn]; });
        } catch (eDW2) {}

        // ★★★ FIX: Deserialize unifiedTimes if needed ★★★
        const deserializedTimes = deserializeUnifiedTimes(mergedUnifiedTimes);

        log('Merge complete:', {
            bunks: Object.keys(mergedAssignments).length,
            unifiedTimes: deserializedTimes.length,
            divisionTimes: Object.keys(mergedDivisionTimes).length
        });
        
        return {
            scheduleAssignments: mergedAssignments,
            scheduleSegments: mergedSegments,
            leagueAssignments: mergedLeagues,
            unifiedTimes: deserializedTimes,  // ★★★ FIX: Now included! ★★★
            divisionTimes: window.DivisionTimesSystem?.deserialize(mergedDivisionTimes) || mergedDivisionTimes,
            // ★ MS-4c: content-winner per-bunk grids (consumed by the
            // unified restore so window.divisionTimes._perBunkSlots matches
            // the merged assignments' shape)
            _perBunkSlotsData: Object.keys(_divWinnerPBS).length > 0 ? _divWinnerPBS : undefined,
            slotCount: maxSlots,
            isRainyDay,
            // CB-21: surface the auto-mode signals on the primary merge path
            _autoGenerated: mergedAutoGenerated,
            manualSkeleton: mergedManualSkeleton || undefined,
            _mergedAt: new Date().toISOString(),
            _recordCount: records.length
        };
    }
    // =========================================================================
    // SAVE OPERATIONS — ★★★ v5.4: PERMISSION-AWARE ERROR HANDLING ★★★
    // =========================================================================
    /**
     * Save schedule for a date.
     * Automatically filters to user's divisions and UPSERTs.
     * FIXED in v5.1: Uses AccessControl instead of PermissionsDB for filtering
     * FIXED in v5.3: Improved verification with exponential backoff
     * FIXED in v5.4: Permission-aware error handling (RLS violations vs network errors)
     */
   async function saveSchedule(dateKey, data, options = {}) {
        // ★★★ CROSS-DATE CORRUPTION GUARD (authoritative, lowest-level catch-all) ★★★
        // window._scheduleAssignmentsDate is the AUTHORITATIVE record of which date the
        // current in-memory window.scheduleAssignments belongs to — it is set atomically
        // whenever the schedule is (re)populated for a date (load hydration, generation).
        // Therefore ANY save whose target dateKey differs from it is about to write one
        // day's schedule under another day's key — the dual date-change-handler race.
        // Refuse it. This is enforced at the single lowest choke point, so it covers EVERY
        // caller regardless of which racing path (orchestrator, integration_hooks,
        // visibilitychange/beforeunload, propagation, offline-queue replay, post-edit,
        // realtime) triggered the save.
        //
        // Authority precedence: explicit payload stamp (data._belongsToDate, snapshotted
        // before the async gap) wins; otherwise fall back to the live global. The ONE
        // legitimate cross-date writer — the multi-date propagation save, which writes a
        // date's OWN per-date payload under that date — passes { allowCrossDate: true }
        // and is exempt. Inert until the stamp is first set, so it can never block a
        // legitimate same-date save.
        const _memDate = (data && data._belongsToDate) || window._scheduleAssignmentsDate || null;
        if (!options.allowCrossDate && _memDate && dateKey && _memDate !== dateKey) {
            console.warn('[ScheduleDB.saveSchedule] ★ BLOCKED cross-date save: in-memory schedule belongs to ' +
                         _memDate + ' but target is ' + dateKey + ' — refusing to prevent corruption');
            return { data: null, error: { message: 'cross-date-mismatch' }, success: false, skipped: 'date-mismatch' };
        }
        if (data && Object.prototype.hasOwnProperty.call(data, '_belongsToDate')) {
            try { delete data._belongsToDate; } catch (e) { /* non-fatal */ }
        }

        // ★★★ v5.5 SECURITY: Verify write permission before cloud write ★★★
        if (window.AccessControl?.verifyBeforeWrite && !options.skipVerify) {
            const allowed = await window.AccessControl.verifyBeforeWrite('save schedule to cloud');
            if (!allowed) {
                log('SAVE BLOCKED by verifyBeforeWrite');
                return { data: null, error: { message: 'Write permission denied' } };
            }
        }
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();
        const schedulerName = getSchedulerName();

        const originalBunkCount = Object.keys(data?.scheduleAssignments || {}).length;
        log('saveSchedule called:', dateKey, 'with', originalBunkCount, 'bunks');

        if (!client || !campId || !userId) {
            log('No client/campId/userId yet, saving to local only');
            setLocalSchedule(dateKey, data);
            return { success: true, target: 'local' };
        }

        // NOTE: Schedule day limit is checked in runSkeletonOptimizer (generation time),
        // not here — auto-saves and edits to existing dates should never be blocked.

        // ★★★ DAY 16 FIX: Empty-data wipe guard ★★★
        // Block writes that would wipe a populated cloud row. The orchestrator's
        // doCloudSaveWithVerification has a bunkCount === 0 guard but only for
        // paths that go through it — direct ScheduleDB.saveSchedule callers
        // (visibilitychange/beforeunload fallbacks, propagation paths,
        // offline-queue replays, post-edit bypass saves, iron-gate listener,
        // etc.) bypass that guard. We catch three wipe shapes here:
        //
        //   (a) scheduleAssignments is an empty object {}
        //   (b) scheduleAssignments has bunk keys but every slot is null/empty
        //       AND unifiedTimes is empty — "structural skeleton with no data"
        //   (c) filter-induced empty (filteredBunkCount=0 with original>0,
        //       handled below after filtering)
        //
        // Generated schedules always have unifiedTimes populated, so an empty
        // unifiedTimes alongside bunk keys is a strong wipe signal. Persist the
        // offending stack to localStorage so the source survives reload.
        const sa = data?.scheduleAssignments || {};
        const utLen = Array.isArray(data?.unifiedTimes) ? data.unifiedTimes.length
                    : (Array.isArray(window.unifiedTimes) ? window.unifiedTimes.length : 0);
        let activitySlotCount = 0;
        if (originalBunkCount > 0) {
            outer: for (const bk of Object.keys(sa)) {
                const arr = sa[bk];
                if (!Array.isArray(arr)) continue;
                for (const slot of arr) {
                    if (slot && typeof slot === 'object') {
                        const act = slot._activity || slot.activity || slot.field || slot.sport;
                        if (act && act !== 'Free' && act !== '+ Add') {
                            activitySlotCount++;
                            if (activitySlotCount > 0) break outer;
                        }
                    }
                }
            }
        }
        const wipeShape =
            originalBunkCount === 0 ? 'empty-bunks' :
            (utLen === 0 && activitySlotCount === 0) ? 'structural-skeleton' :
            // ★ Audit fix (FN-14 fallout): bunks + unifiedTimes present but EVERY slot
            //   empty/null is the auto-layer PREVIEW (or a generation that failed to
            //   materialize). Such a payload previously slipped past the guard (utLen>0)
            //   and could overwrite a real cloud schedule with all-nulls. Never persist a
            //   zero-activity schedule over an existing one — clearing a day goes through
            //   delete, not save. (options.allowEmpty still bypasses this when intended.)
            (activitySlotCount === 0) ? 'all-empty-preview' :
            null;
        if (wipeShape && !options.allowEmpty) {
            const trace = {
                ts: new Date().toISOString(),
                dateKey,
                originalBunkCount,
                unifiedTimesLen: utLen,
                activitySlotCount,
                wipeShape,
                skipFilter: !!options.skipFilter,
                stack: (new Error('empty-save-blocked')).stack || ''
            };
            try {
                const key = '__campistry_empty_save_blocks';
                const existing = JSON.parse(localStorage.getItem(key) || '[]');
                existing.push(trace);
                // Keep the last 25 blocks so the log doesn't grow forever
                while (existing.length > 25) existing.shift();
                localStorage.setItem(key, JSON.stringify(existing));
                // Also append to the unified save trace
                const traceKey = '__campistry_save_trace';
                const fullTrace = JSON.parse(localStorage.getItem(traceKey) || '[]');
                fullTrace.push({ ...trace, outcome: 'blocked-' + wipeShape, allowEmpty: false });
                while (fullTrace.length > 50) fullTrace.shift();
                localStorage.setItem(traceKey, JSON.stringify(fullTrace));
            } catch (_) {}
            console.warn('[ScheduleDB.saveSchedule] BLOCKED', wipeShape, 'write for', dateKey, '— see localStorage["__campistry_empty_save_blocks"] for stack');
            return { success: true, target: 'wipe-blocked-' + wipeShape, bunkCount: originalBunkCount };
        }

        // ★ Save trace: log EVERY save attempt (allowed + blocked) so the
        // full save timeline is reconstructable after a reload. Capped at
        // 50 entries to bound localStorage size. Also count activities
        // fully (not early-exit) so the trace reflects actual payload size.
        let fullActivityCount = 0;
        if (originalBunkCount > 0) {
            for (const bk of Object.keys(sa)) {
                const arr = sa[bk];
                if (!Array.isArray(arr)) continue;
                for (const slot of arr) {
                    if (slot && typeof slot === 'object') {
                        const act = slot._activity || slot.activity || slot.field || slot.sport;
                        if (act && act !== 'Free' && act !== '+ Add') fullActivityCount++;
                    }
                }
            }
        }
        try {
            const traceKey = '__campistry_save_trace';
            const trace = JSON.parse(localStorage.getItem(traceKey) || '[]');
            trace.push({
                ts: new Date().toISOString(),
                dateKey,
                originalBunkCount,
                unifiedTimesLen: utLen,
                activitySlotCount: fullActivityCount,
                skipFilter: !!options.skipFilter,
                allowEmpty: !!options.allowEmpty,
                outcome: 'allowed',
                stack: (new Error('save-trace')).stack || ''
            });
            while (trace.length > 50) trace.shift();
            localStorage.setItem(traceKey, JSON.stringify(trace));
        } catch (_) {}

        try {
            // ★★★ FIXED FILTERING - Uses AccessControl instead of PermissionsDB ★★★
            let filteredAssignments;
            if (options.skipFilter) {
                filteredAssignments = data.scheduleAssignments || {};
                log('Skipping filter per options');
            } else {
                // Use our fixed filtering function
                filteredAssignments = filterScheduleToMyBunks(data.scheduleAssignments || {});
            }

            const filteredBunkCount = Object.keys(filteredAssignments).length;
            log(`After filtering: ${filteredBunkCount} bunks (was ${originalBunkCount})`);

            // ★★★ DAY 16 FIX: also block filter-induced empties ★★★
            // A scheduler whose owned bunks don't appear in the input could
            // produce a filtered-empty result. Block this for the same
            // reason — it'd overwrite the (filtered) cloud row with empty.
            if (filteredBunkCount === 0 && originalBunkCount > 0 && !options.allowEmpty) {
                const trace = {
                    ts: new Date().toISOString(),
                    dateKey,
                    originalBunkCount,
                    filteredBunkCount,
                    reason: 'filter-stripped-all',
                    stack: (new Error('empty-save-blocked-by-filter')).stack || ''
                };
                try {
                    const key = '__campistry_empty_save_blocks';
                    const existing = JSON.parse(localStorage.getItem(key) || '[]');
                    existing.push(trace);
                    while (existing.length > 25) existing.shift();
                    localStorage.setItem(key, JSON.stringify(existing));
                    const traceKey = '__campistry_save_trace';
                    const fullTrace = JSON.parse(localStorage.getItem(traceKey) || '[]');
                    fullTrace.push({ ...trace, outcome: 'blocked-filter-stripped' });
                    while (fullTrace.length > 50) fullTrace.shift();
                    localStorage.setItem(traceKey, JSON.stringify(fullTrace));
                } catch (_) {}
                console.warn('[ScheduleDB.saveSchedule] BLOCKED filter-stripped-empty write for', dateKey, '— see localStorage["__campistry_empty_save_blocks"]');
                return { success: true, target: 'empty-blocked-by-filter', bunkCount: 0 };
            }

            // ★★★ CB-1 / CB-38: grid geometry + mode flags must come from the
            // PASSED payload, not live window state. On a cross-date save
            // (allowCrossDate — propagation fanout, offline-queue replay) the
            // window globals (divisionTimes/unifiedTimes/_autoGenerated/skeleton)
            // belong to the date the user is VIEWING, not the date being saved;
            // stamping them onto another date's cloud row contaminated its grid.
            // The legitimate cross-date callers pass that date's own per-date
            // payload (campDailyData_v1[dk] / the offline-queue captured payload),
            // which setLocalSchedule populated with divisionTimes + the
            // _perBunkSlotsData sidecar — so data.* is authoritative there.
            // Same-date saves keep the window fallback (window IS the right date).
            const _allowWindowFallback = !options.allowCrossDate;

            // Phase 4: persist scheduleSegments alongside assignments, filtered
            // by the same bunk-ownership rules so we never leak foreign data.
            const rawSegments = data.scheduleSegments || (_allowWindowFallback ? window.scheduleSegments : null) || {};
            const filteredSegments = options.skipFilter ? rawSegments : filterScheduleToMyBunks(rawSegments);

            // Prepare payload
            const payload = {
                scheduleAssignments: filteredAssignments,
                scheduleSegments: filteredSegments,
                leagueAssignments: data.leagueAssignments || {},
                unifiedTimes: serializeUnifiedTimes(data.unifiedTimes || (_allowWindowFallback ? window.unifiedTimes : null) || []),
                slotCount: data.unifiedTimes?.length || (_allowWindowFallback ? (window.unifiedTimes?.length || 0) : 0),
                // Include division-specific times — prefer the passed payload's
                // own divisionTimes (serialize handles the _perBunkSlots property);
                // only fall back to live window on same-date saves.
                divisionTimes: data.divisionTimes
                    ? (window.DivisionTimesSystem?.serialize(data.divisionTimes) || data.divisionTimes)
                    : (_allowWindowFallback ? (window.DivisionTimesSystem?.serialize(window.divisionTimes) || {}) : {})
            };

            // ★★★ DAY 16b FIX: Persist _perBunkSlotsData (per-grade per-bunk grid)
            // so the auto solver's grid survives the cloud round-trip. Without
            // this, _perBunkSlots — which is a custom property on the array,
            // not part of standard JSON serialization — is lost on save.
            //
            // Prefer caller-provided data._perBunkSlotsData (verifiedScheduleSave
            // builds this). Fall back to extracting from live window.divisionTimes.
            let pbSlotsData = data._perBunkSlotsData;
            if (!pbSlotsData && _allowWindowFallback) {
                // CB-1: only harvest from live window on same-date saves —
                // on a cross-date save window.divisionTimes is the viewed date's.
                const dt = window.divisionTimes || {};
                pbSlotsData = {};
                Object.keys(dt).forEach(g => {
                    if (dt[g]?._perBunkSlots) pbSlotsData[g] = dt[g]._perBunkSlots;
                });
            }
            if (pbSlotsData && Object.keys(pbSlotsData).length > 0) {
                payload._perBunkSlotsData = pbSlotsData;
            }

            // ★ MS-3: per-DIVISION recency stamps. A scoped generation
            // re-saves the whole row, which used to make its STALE copies of
            // unscoped divisions look newest (row updated_at) and shadow the
            // other scheduler's real work in the merge. Stamp each division
            // in this payload: NOW for divisions this generation actually
            // touched (window.__lastGenScope, set by runOptimizer; a null
            // divisions list = unscoped = stamp all), carry forward the last
            // seen stamp for the rest. mergeSchedules prefers these stamps
            // over row updated_at; legacy rows without stamps behave as
            // before.
            try {
                const bunkToDiv = {};
                Object.entries(window.divisions || {}).forEach(([dn, di]) =>
                    ((di && di.bunks) || []).forEach(b => { bunkToDiv[String(b)] = dn; }));
                const gs = window.__lastGenScope;
                const scopeActive = gs && gs.date === dateKey &&
                    (Date.now() - (gs.at || 0)) < 180000 &&
                    Array.isArray(gs.divisions) && gs.divisions.length > 0;
                const scopeSet = scopeActive ? new Set(gs.divisions.map(String)) : null;
                const cachePrev = (window.__divStampCache && window.__divStampCache[dateKey]) || {};
                // ★ MS-3d: on a SCOPED-generation save, out-of-scope divisions
                // are restored BYTE-IDENTICAL from this scheduler's own
                // previous row — content AND stamp. The in-memory copies of
                // out-of-scope divisions are untrustworthy (post-gen passes
                // mutate them, and they're realtime merges of other
                // schedulers' rows), so re-saving them both drifts content
                // and re-stamps it.
                let prevRowAssignments = null, prevRowStamps = {};
                if (scopeActive) {
                    try {
                        const { data: ownRow } = await getClient()
                            .from('daily_schedules')
                            .select('schedule_data')
                            .eq('camp_id', getCampId())
                            .eq('date_key', dateKey)
                            .eq('scheduler_id', getUserId())
                            .maybeSingle();
                        const pd = ownRow && ownRow.schedule_data;
                        if (pd && pd.scheduleAssignments) {
                            prevRowAssignments = pd.scheduleAssignments;
                            prevRowStamps = pd._divStamps || {};
                        }
                    } catch (ePrev) { /* fall back to cache-only carry */ }
                    if (prevRowAssignments) {
                        Object.keys(filteredAssignments).forEach(b => {
                            const dn = bunkToDiv[String(b)];
                            if (dn && !scopeSet.has(dn) && prevRowAssignments[b] !== undefined) {
                                filteredAssignments[b] = prevRowAssignments[b];
                            }
                        });
                    }
                }
                const nowMs = Date.now();
                const stamps = {};
                Object.keys(filteredAssignments).forEach(b => {
                    const dn = bunkToDiv[String(b)];
                    if (!dn || stamps[dn] != null) return;
                    stamps[dn] = (!scopeSet || scopeSet.has(dn))
                        ? nowMs
                        : (prevRowStamps[dn] || cachePrev[dn] || nowMs);
                });
                payload._divStamps = stamps;
                window.__divStampCache = window.__divStampCache || {};
                window.__divStampCache[dateKey] = Object.assign({}, cachePrev, stamps);
            } catch (eStamps) { /* non-fatal — merge falls back to updated_at */ }

            // ★★★ DAY 16b FIX: Round-trip _autoGenerated + manualSkeleton too.
            // These tell the load-side code path "this was an auto build" so
            // post-edit gates / rebuild logic pick the right branch.
            if (data._autoGenerated === true || (_allowWindowFallback && window._autoGenerated === true)) {
                payload._autoGenerated = true;
            }
            // CB-38: on cross-date saves do NOT read window._autoSkeleton/
            // dailyOverrideSkeleton — those are the viewed date's skeleton and
            // would leak onto the target date's row.
            const ms = data.manualSkeleton || (_allowWindowFallback ? (window._autoSkeleton || window.dailyOverrideSkeleton) : null);
            if (Array.isArray(ms) && ms.length > 0) {
                payload.manualSkeleton = ms;
            }

            // Get user's divisions (use AccessControl)
            const divisions = getMyEditableDivisions();
            log('Saving with divisions:', divisions);

            // UPSERT: Insert or update based on (camp_id, date_key, scheduler_id)
            const { data: result, error } = await client
                .from(CONFIG.TABLE_NAME)
                .upsert({
                    camp_id: campId,
                    date_key: dateKey,
                    scheduler_id: userId,
                    scheduler_name: schedulerName,
                    divisions: divisions,
                    schedule_data: payload,
                    unified_times: payload.unifiedTimes,
                    is_rainy_day: data.isRainyDay || false,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'camp_id,date_key,scheduler_id'
                })
                .select();

            // ═══════════════════════════════════════════════════════════════
            // ★★★ v5.4 SECURITY: Permission-aware error handling ★★★
            // Separate RLS/permission errors (requires reauth) from
            // transient network errors (safe to retry / fallback to local)
            // ═══════════════════════════════════════════════════════════════
            if (error) {
                logError('Save failed:', error);
                logError('Error details:', JSON.stringify(error));

                if (isPermissionError(error)) {
                    // ─── PERMISSION ERROR: user's role was likely revoked ───
                    await handlePermissionError('saveSchedule', error);

                    return { 
                        success: false, 
                        error: 'Permission denied', 
                        target: 'permission-error',
                        requiresReauth: true 
                    };
                }

                // ─── TRANSIENT ERROR: safe to fall back to local storage ───
                setLocalSchedule(dateKey, data);
                return { success: false, error: error.message, target: 'local-fallback' };
            }

            // Update local storage with full data (for offline access)
            setLocalSchedule(dateKey, data);

            log('✅ Saved successfully:', {
                bunks: filteredBunkCount,
                slots: payload.slotCount,
                divisions
            });

            // ★★★ IMPROVED v5.3: Verify save with exponential backoff ★★★
            log('Verifying save reached cloud...');
            
            let verified = false;
            let verifyAttempt = 0;
            
            while (!verified && verifyAttempt < CONFIG.VERIFY_MAX_ATTEMPTS) {
                verifyAttempt++;
                const delay = CONFIG.VERIFY_BASE_DELAY_MS * Math.pow(2, verifyAttempt - 1);
                await new Promise(r => setTimeout(r, delay));
                
                try {
                    const { data: verifyData, error: verifyError } = await client
                        .from(CONFIG.TABLE_NAME)
                        .select('updated_at, schedule_data')
                        .eq('camp_id', campId)
                        .eq('date_key', dateKey)
                        .eq('scheduler_id', userId)
                        .single();

                    if (!verifyError && verifyData) {
                        const cloudBunks = Object.keys(verifyData.schedule_data?.scheduleAssignments || {}).length;
                        log(`✅ Save VERIFIED (attempt ${verifyAttempt}): ${cloudBunks} bunks at ${verifyData.updated_at}`);
                        verified = true;
                    } else {
                        log(`Verify attempt ${verifyAttempt} failed:`, verifyError?.message);
                    }
                } catch (verifyErr) {
                    log(`Verify attempt ${verifyAttempt} exception:`, verifyErr.message);
                }
            }
            
            if (!verified) {
                logError('Save verification failed after', CONFIG.VERIFY_MAX_ATTEMPTS, 'attempts');
                return { 
                    success: true, 
                    target: 'cloud-unverified',
                    bunks: filteredBunkCount,
                    verified: false
                };
            }

            // ★ Update starter banner days count after successful save
            if (window.refreshStarterBanner) window.refreshStarterBanner();

            return {
                success: true,
                target: 'cloud',
                bunks: filteredBunkCount,
                verified: true
            };
        } catch (e) {
            logError('Save exception:', e);
            setLocalSchedule(dateKey, data);
            return { success: false, error: e.message, target: 'local-fallback' };
        }
    }
    // =========================================================================
    // DELETE OPERATIONS
    // =========================================================================
    /**
     * Delete ALL schedule data for a date (owners only).
     */
   async function deleteSchedule(dateKey) {
        // ★★★ v5.5 SECURITY: Verify write permission before cloud delete ★★★
        if (window.AccessControl?.verifyBeforeWrite) {
            const allowed = await window.AccessControl.verifyBeforeWrite('delete schedule from cloud');
            if (!allowed) {
                log('DELETE BLOCKED by verifyBeforeWrite');
                return { data: null, error: { message: 'Write permission denied' } };
            }
        }
        const client = getClient();
        const campId = getCampId();
        // Check permissions
        if (!window.PermissionsDB?.hasFullAccess?.()) {
            return { success: false, error: 'Only owners/admins can delete all schedules' };
        }
        try {
            const { error } = await client
                .from(CONFIG.TABLE_NAME)
                .delete()
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            if (error) {
                logError('Delete failed:', error);
                return { success: false, error: error.message };
            }
            // Clear local storage
            deleteLocalSchedule(dateKey);
            log('Deleted all schedules for', dateKey);
            return { success: true };
        } catch (e) {
            logError('Delete exception:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Delete MY bunks from ALL schedule records for a date.
     * This is necessary because another scheduler (like the owner) may have
     * saved records that include my bunks. Simply deleting my own record
     * won't remove my bunks from their records.
     */
    async function deleteMyScheduleOnly(dateKey) {
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();
        log('deleteMyScheduleOnly called for', dateKey);
        try {
            // Step 1: Get my editable bunks
            const myBunks = getMyEditableBunks();
            log('My bunks to delete:', myBunks);
            if (myBunks.length === 0) {
                log('No bunks to delete');
                return { success: true, message: 'No bunks assigned' };
            }
            // ★★★ CB-42: leagueAssignments is DIVISION-keyed, not bunk-keyed, so the
            // old `delete leagues[bunk]` never matched and a scheduler's league
            // games survived their day-delete (then re-merged on reload). Resolve my
            // divisions from my bunks so league entries can be deleted by division.
            const _divResolver42 = (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionForBunk) || window.getDivisionForBunk;
            const _myDivisions42 = new Set();
            if (_divResolver42) myBunks.forEach(function (b) { const d = _divResolver42(b); if (d) _myDivisions42.add(String(d)); });
            // Step 2: Load ALL records for this date
            const allRecords = await loadAllSchedulersForDate(dateKey);
            log('Found', allRecords.length, 'records for', dateKey);
            if (allRecords && allRecords._queryErrored) {
                // CB-2: transient query failure — abort the delete rather than
                // clearing local on a false "no records".
                logError('deleteMyScheduleOnly: cloud query errored for', dateKey, '— aborting, local cache preserved');
                return { success: false, error: 'query-failed', message: 'Cloud query failed — try again' };
            }
            if (!allRecords || allRecords.length === 0) {
                // No records in cloud, just clear local
                deleteLocalSchedule(dateKey);
                return { success: true, message: 'No cloud records' };
            }
            // Step 3: For EACH record, remove my bunks and update
            const myBunkSet = new Set(myBunks);
            let recordsModified = 0;
            let recordsDeleted = 0;
            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = scheduleData.scheduleAssignments || {};
                const leagues = scheduleData.leagueAssignments || {};
                // Count bunks before
                const bunksBefore = Object.keys(assignments).length;
                // Remove my bunks from this record
                let modified = false;
                for (const bunk of myBunks) {
                    if (assignments[bunk] !== undefined) {
                        delete assignments[bunk];
                        modified = true;
                    }
                }
                // ★★★ CB-42: delete league matchups by DIVISION (the map's real key).
                _myDivisions42.forEach(function (div) {
                    if (leagues[div] !== undefined) { delete leagues[div]; modified = true; }
                });
                const bunksAfter = Object.keys(assignments).length;
                log(`Record ${record.scheduler_name}: ${bunksBefore} → ${bunksAfter} bunks`);
                if (!modified) {
                    log('  Skipping - no changes needed');
                    continue;
                }
                // ★★★ CB-12: NEVER write another scheduler's row from here. The
                // original loop did a blind read-modify-write of every record,
                // so a concurrent save by a foreign row's owner (between our
                // SELECT and UPDATE) was clobbered with our stale snapshot. Bunks
                // are per-row-owned (camp_id,date_key,scheduler_id), so my bunks
                // live in MY row; any legacy leakage of my bunks into a foreign
                // row is pruned by the per-bunk merge (#V2-25) on the next load.
                // Only mutate the current user's own record.
                if (String(record.scheduler_id) !== String(userId)) {
                    log('  (skipping foreign scheduler row — not ours to rewrite; merge prunes any legacy leakage)');
                    continue;
                }
                // If record is now empty, delete it entirely
                if (bunksAfter === 0) {
                    log('  Record now empty, deleting...');
                    const { error } = await client
                        .from(CONFIG.TABLE_NAME)
                        .delete()
                        .eq('id', record.id);
                    if (error) {
                        // ★★★ CB-17: a scheduler cannot DELETE rows under RLS
                        // (delete is owner/admin-only), so the DELETE silently
                        // no-ops and the old row resurrects on the next load.
                        // Fall back to UPDATING the row to an empty schedule,
                        // which the scheduler CAN do on their own row — an empty
                        // row carries no bunks so the merge ignores it (effective
                        // delete) and it can't resurrect stale assignments.
                        logError(`  Delete record ${record.id} failed (likely RLS) — emptying row instead:`, error);
                        const { error: upErr } = await client
                            .from(CONFIG.TABLE_NAME)
                            .update({
                                schedule_data: { ...scheduleData, scheduleAssignments: {}, leagueAssignments: {} },
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', record.id);
                        if (upErr) {
                            logError(`  Empty-row fallback also failed for ${record.id}:`, upErr);
                        } else {
                            recordsModified++;
                            log('  ✅ Emptied record (delete fallback)');
                        }
                    } else {
                        recordsDeleted++;
                        log('  ✅ Deleted empty record');
                    }
                } else {
                    // Update the record with bunks removed
                    log(`  Updating record with ${bunksAfter} remaining bunks...`);
                    
                    const updatedData = {
                        ...scheduleData,
                        scheduleAssignments: assignments,
                        leagueAssignments: leagues
                    };
                    const { error } = await client
                        .from(CONFIG.TABLE_NAME)
                        .update({
                            schedule_data: updatedData,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', record.id);
                    if (error) {
                        logError(`  Update record ${record.id} failed:`, error);
                    } else {
                        recordsModified++;
                        log('  ✅ Updated record');
                    }
                }
            }
            log(`Delete complete: ${recordsModified} modified, ${recordsDeleted} deleted`);
            // Step 4: Reload remaining data and update local storage
            const remaining = await loadAllSchedulersForDate(dateKey);
            if (remaining && remaining._queryErrored) {
                // CB-2: re-read errored after a successful delete — leave local
                // cache as-is rather than wiping it on a false empty.
                log('Post-delete re-read errored — leaving local cache untouched');
            } else if (remaining.length > 0) {
                const merged = mergeSchedules(remaining);
                setLocalSchedule(dateKey, merged);
                log('Updated local storage with remaining data:', Object.keys(merged.scheduleAssignments || {}).length, 'bunks');
            } else {
                deleteLocalSchedule(dateKey);
                log('Cleared local storage - no remaining data');
            }
            return { 
                success: true, 
                recordsModified,
                recordsDeleted,
                bunksRemoved: myBunks.length
            };
        } catch (e) {
            logError('deleteMyScheduleOnly exception:', e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // DIAGNOSTIC HELPER
    // =========================================================================
    
    async function diagnose(dateKey) {
        if (!dateKey) {
            dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        }
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();

        console.log('═══════════════════════════════════════════════════════');
        console.log('📅 SCHEDULE DB DIAGNOSTIC v5.4');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date Key:', dateKey);
        console.log('');
        console.log('Dependencies:');
        console.log('  Supabase Client:', client ? '✅' : '❌');
        console.log('  Camp ID:', campId || '❌ MISSING');
        console.log('  User ID:', userId || '❌ MISSING');
        console.log('');
        console.log('Permissions (FIXED):');
        console.log('  Role (CampistryDB):', window.CampistryDB?.getRole?.() || 'unknown');
        console.log('  Role (AccessControl):', window.AccessControl?.getCurrentRole?.() || 'unknown');
        console.log('  Editable Divisions (AccessControl):', window.AccessControl?.getEditableDivisions?.() || []);
        console.log('  Editable Bunks (PermissionsDB):', window.PermissionsDB?.getEditableBunks?.()?.length || 0);
        console.log('  Editable Bunks (FIXED getMyEditableBunks):', getMyEditableBunks().length);
        console.log('');

        if (!client || !campId) {
            console.log('⚠️ Cannot query cloud without client/campId');
            return;
        }

        try {
            const { data, error } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);

            if (error) {
                console.error('Query error:', error);
                return;
            }

            console.log('Cloud Records:', data?.length || 0);
            
            if (data && data.length > 0) {
                data.forEach((record, i) => {
                    const bunks = Object.keys(record.schedule_data?.scheduleAssignments || {}).length;
                    const slots = record.schedule_data?.unifiedTimes?.length || record.unified_times?.length || 0;
                    console.log(`\nRecord ${i + 1}:`);
                    console.log('  Scheduler:', record.scheduler_name || 'Unknown');
                    console.log('  Scheduler ID:', record.scheduler_id);
                    console.log('  Divisions:', JSON.stringify(record.divisions));
                    console.log('  Bunks in schedule_data:', bunks);
                    console.log('  UnifiedTimes slots:', slots);
                    console.log('  Updated:', record.updated_at);
                    
                    if (bunks > 0) {
                        console.log('  Bunk IDs:', Object.keys(record.schedule_data.scheduleAssignments).slice(0, 10).join(', ') + (bunks > 10 ? '...' : ''));
                    }
                });
            } else {
                console.log('\n⚠️ NO RECORDS FOUND IN CLOUD!');
            }

            console.log('\n--- Window Globals ---');
            console.log('window.scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
            console.log('window.unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
            if (Object.keys(window.scheduleAssignments || {}).length > 0) {
                console.log('  Bunk IDs:', Object.keys(window.scheduleAssignments).slice(0, 10).join(', '));
            }

        } catch (e) {
            console.error('Diagnostic error:', e);
        }

        console.log('═══════════════════════════════════════════════════════');
    }

    // =========================================================================
    // EXPORT
    // =========================================================================
    window.ScheduleDB = {
        initialize,
        
        // Read
        loadSchedule,
        loadAllSchedulersForDate,
        listScheduleDates, // ★ CB-70: distinct cloud schedule dates for the calendar overview
        loadDateRange,
        
        // Write
        saveSchedule,
        deleteSchedule,
        deleteMyScheduleOnly,
        
        // Merge
        mergeSchedules,
        
        // Local storage helpers
        getLocalSchedule,
        setLocalSchedule,
        
        // Time helpers
        serializeUnifiedTimes,
        deserializeUnifiedTimes,

        // Permissions helpers (exposed for debugging)
        getMyEditableBunks,
        getMyEditableDivisions,
        
        // Diagnostics
        diagnose,

        // ★★★ DAY 16: inspect empty-save guard hits (survives reload) ★★★
        inspectEmptySaveBlocks: () => {
            try {
                const blocks = JSON.parse(localStorage.getItem('__campistry_empty_save_blocks') || '[]');
                console.log('═══════════════════════════════════════════════════════');
                console.log(`Empty-save blocks captured: ${blocks.length}`);
                console.log('═══════════════════════════════════════════════════════');
                blocks.forEach((b, i) => {
                    console.log(`\n[${i + 1}] ${b.ts} — date=${b.dateKey} originalBunkCount=${b.originalBunkCount} utLen=${b.unifiedTimesLen} actSlots=${b.activitySlotCount}${b.reason ? ' reason=' + b.reason : ''}${b.wipeShape ? ' shape=' + b.wipeShape : ''}`);
                    console.log(b.stack);
                });
                if (blocks.length === 0) console.log('(none — no empty save attempts blocked)');
                console.log('═══════════════════════════════════════════════════════');
                return blocks;
            } catch (e) {
                console.error('inspectEmptySaveBlocks error:', e);
                return [];
            }
        },
        clearEmptySaveBlocks: () => {
            try { localStorage.removeItem('__campistry_empty_save_blocks'); } catch (_) {}
            console.log('Cleared empty-save block log.');
        },

        // ★★★ DAY 16: inspect full save trace (allowed + blocked, survives reload) ★★★
        inspectSaveTrace: (limit = 30) => {
            try {
                const trace = JSON.parse(localStorage.getItem('__campistry_save_trace') || '[]');
                console.log('═══════════════════════════════════════════════════════');
                console.log(`Save trace entries: ${trace.length} (showing last ${Math.min(limit, trace.length)})`);
                console.log('═══════════════════════════════════════════════════════');
                trace.slice(-limit).forEach((t, i) => {
                    console.log(`\n[${i + 1}] ${t.ts} — bunks=${t.originalBunkCount} utLen=${t.unifiedTimesLen} acts=${t.activitySlotCount} skipFilter=${t.skipFilter} → ${t.outcome}`);
                    // Render the stack with the Error-header line stripped, keep all callers
                    const stackLines = (t.stack || '').split('\n').filter(l => !/^Error[:\s]/.test(l));
                    console.log(stackLines.join('\n'));
                });
                if (trace.length === 0) console.log('(no saves traced yet)');
                console.log('═══════════════════════════════════════════════════════');
                return trace;
            } catch (e) {
                console.error('inspectSaveTrace error:', e);
                return [];
            }
        },
        clearSaveTrace: () => {
            try { localStorage.removeItem('__campistry_save_trace'); } catch (_) {}
            console.log('Cleared save trace log.');
        },

        // State
        get isInitialized() { return _isInitialized; }
    };
    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================
    if (window.CampistryDB?.ready) {
        window.CampistryDB.ready.then(() => {
            setTimeout(initialize, 100);
        });
    } else {
        window.addEventListener('campistry-db-ready', () => {
            setTimeout(initialize, 100);
        });
    }

    console.log('📅 [ScheduleDB] v5.4 loaded — permission-aware error handling');
    console.log('   Run: ScheduleDB.diagnose() to check sync status');

})();
