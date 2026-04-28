// supabase_schedules.js — Schedule DB operations (load, save, merge, delete)
// Requires: supabase_client.js, supabase_permissions.js
(function() {
    'use strict';
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
    let _initPromise = null;
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
        if (_initPromise) return _initPromise;
        _initPromise = (async () => {
            if (window.CampistryDB?.ready) {
                await window.CampistryDB.ready;
            }
            _isInitialized = true;
            log('Initialized');
            window.dispatchEvent(new CustomEvent('campistry-scheduledb-ready'));
        })();
        return _initPromise;
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
        if (window.AccessControl?.getCurrentUserInfo) {
            const info = window.AccessControl.getCurrentUserInfo();
            if (info?.name) return info.name;
        }
        const membership = window._campistryMembership;
        if (membership?.name) return membership.name;
        const session = window.CampistryDB?.getSession?.();
        if (session?.user?.email) return session.user.email.split('@')[0];
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
    function setLocalData(data) {
        try {
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            logError('Failed to write local storage:', e);
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

        // Carry forward local-only fields not stored in cloud
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
    // PERMISSION ERROR DETECTION
    // =========================================================================
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
    // HELPERS: PERMISSIONS
    // =========================================================================
    function getMyEditableBunks() {
        const role = window.CampistryDB?.getRole?.() || 
                     window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        if (role === 'owner' || role === 'admin') {
            const allBunks = [];
            Object.values(window.divisions || {}).forEach(div => {
                if (div.bunks) allBunks.push(...div.bunks);
            });
            return allBunks.map(String);
        }
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        if (editableDivisions.length === 0) {
            const permBunks = window.PermissionsDB?.getEditableBunks?.() || [];
            if (permBunks.length > 0) return permBunks.map(String);
            logError('No editable bunks found from any source!');
            return [];
        }
        const divisions = window.divisions || {};
        const bunks = [];
        editableDivisions.forEach(divName => {
            const divData = divisions[divName] || divisions[String(divName)];
            if (divData?.bunks) bunks.push(...divData.bunks);
        });
        return bunks.map(String);
    }

    function filterScheduleToMyBunks(scheduleAssignments) {
        const role = window.CampistryDB?.getRole?.() || 
                     window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        if (role === 'owner' || role === 'admin') return scheduleAssignments;
        const myBunks = new Set(getMyEditableBunks());
        if (myBunks.size === 0) {
            logError('No editable bunks found — returning unfiltered, RLS will enforce.');
            return scheduleAssignments;
        }
        const filtered = {};
        Object.entries(scheduleAssignments || {}).forEach(([bunkId, slots]) => {
            if (myBunks.has(String(bunkId))) filtered[bunkId] = slots;
        });
        return filtered;
    }

    function getMyEditableDivisions() {
        const role = window.CampistryDB?.getRole?.() || 
                     window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        if (role === 'owner' || role === 'admin') return Object.keys(window.divisions || {});
        const acDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        if (acDivisions.length > 0) return acDivisions;
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
            
            if (!records || records.length === 0) {
                log('No cloud records, using local data');
                return { success: true, data: getLocalSchedule(dateKey), source: 'local' };
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
        
        if (!client || !campId) return [];
        try {
            const { data, error } = await client
                .from(CONFIG.TABLE_NAME)
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            if (error) {
                logError('Query error:', error);
                if (isPermissionError(error)) {
                    await handlePermissionError('loadAllSchedulersForDate', error);
                } else {
                    if (typeof window.showToast === 'function') window.showToast('Failed to load schedule data — check your connection.', 'error');
                }
                return [];
            }
            log(`Loaded ${data?.length || 0} records for ${dateKey}`);
            return data || [];
            
        } catch (e) {
            logError('loadAllSchedulersForDate failed:', e);
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
                if (typeof window.showToast === 'function') window.showToast('Failed to load schedule range — check your connection.', 'error');
                return [];
            }
            return data || [];
            
        } catch (e) {
            logError('loadDateRange failed:', e);
            return [];
        }
    }
    // =========================================================================
    // MERGE LOGIC
    // =========================================================================
    function mergeSchedules(records) {
        if (!records || records.length === 0) return null;
        
        const mergedAssignments = {};
        const mergedSegments = {};
        const mergedLeagues = {};
        let mergedUnifiedTimes = [];
        let mergedDivisionTimes = {};
        let maxSlots = 0;
        let isRainyDay = false;
        let rainyDayStartTime = null;

        records.forEach(record => {
            const data = record.schedule_data || {};

            // Merge scheduleAssignments (each scheduler owns their bunks)
            if (data.scheduleAssignments) {
                Object.entries(data.scheduleAssignments).forEach(([bunkId, slots]) => {
                    mergedAssignments[bunkId] = slots;
                });
            }

            // Phase 4: merge scheduleSegments per-bunk (same ownership as assignments)
            if (data.scheduleSegments) {
                Object.entries(data.scheduleSegments).forEach(([bunkId, row]) => {
                    mergedSegments[bunkId] = row;
                });
            }
            
            // Merge leagueAssignments
            if (data.leagueAssignments) {
                Object.entries(data.leagueAssignments).forEach(([div, slots]) => {
                    mergedLeagues[div] = slots;
                });
            }
            
            // Use longest unifiedTimes array across all records
            if (data.unifiedTimes && Array.isArray(data.unifiedTimes)) {
                if (data.unifiedTimes.length > mergedUnifiedTimes.length) {
                    mergedUnifiedTimes = data.unifiedTimes;
                    maxSlots = data.unifiedTimes.length;
                }
            }
            
            // Also check record.unified_times (separate column)
            if (record.unified_times && Array.isArray(record.unified_times)) {
                if (record.unified_times.length > mergedUnifiedTimes.length) {
                    mergedUnifiedTimes = record.unified_times;
                    maxSlots = record.unified_times.length;
                }
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

            // Rainy day flag — read from both column and schedule_data for backward compat
            if (record.is_rainy_day || data.isRainyDay || data.rainyDayMode) {
                isRainyDay = true;
            }
            // rainyDayStartTime only lives inside schedule_data
            if (data.rainyDayStartTime != null && rainyDayStartTime == null) {
                rainyDayStartTime = data.rainyDayStartTime;
            }
        });
        
        const deserializedTimes = deserializeUnifiedTimes(mergedUnifiedTimes);

        return {
            scheduleAssignments: mergedAssignments,
            scheduleSegments: mergedSegments,
            leagueAssignments: mergedLeagues,
            unifiedTimes: deserializedTimes,
            divisionTimes: window.DivisionTimesSystem?.deserialize(mergedDivisionTimes) || mergedDivisionTimes,
            slotCount: maxSlots,
            isRainyDay,
            rainyDayStartTime,
            _mergedAt: new Date().toISOString(),
            _recordCount: records.length
        };
    }
    // =========================================================================
    // SAVE OPERATIONS
    // =========================================================================
    async function saveSchedule(dateKey, data, options = {}) {
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

        if (!client || !campId) {
            log('No client or camp ID, saving to local only');
            setLocalSchedule(dateKey, data);
            return { success: true, target: 'local' };
        }

        // NOTE: Schedule day limit is checked in runSkeletonOptimizer (generation time),
        // not here — auto-saves and edits to existing dates should never be blocked.

        try {
            let filteredAssignments;
            if (options.skipFilter) {
                filteredAssignments = data.scheduleAssignments || {};
            } else {
                filteredAssignments = filterScheduleToMyBunks(data.scheduleAssignments || {});
            }

            const filteredBunkCount = Object.keys(filteredAssignments).length;

            // Phase 4: persist scheduleSegments alongside assignments, filtered
            // by the same bunk-ownership rules so we never leak foreign data.
            const rawSegments = data.scheduleSegments || window.scheduleSegments || {};
            const filteredSegments = options.skipFilter ? rawSegments : filterScheduleToMyBunks(rawSegments);

            // Prepare payload
            const payload = {
                scheduleAssignments: filteredAssignments,
                scheduleSegments: filteredSegments,
                leagueAssignments: data.leagueAssignments || {},
                unifiedTimes: serializeUnifiedTimes(data.unifiedTimes || window.unifiedTimes || []),
                slotCount: data.unifiedTimes?.length || window.unifiedTimes?.length || 0,
                // Include division-specific times
                divisionTimes: window.DivisionTimesSystem?.serialize(window.divisionTimes) || {}
            };

            const divisions = getMyEditableDivisions();

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

            if (error) {
                logError('Save failed:', error);
                if (isPermissionError(error)) {
                    await handlePermissionError('saveSchedule', error);
                    return { success: false, error: 'Permission denied', target: 'permission-error', requiresReauth: true };
                }
                setLocalSchedule(dateKey, data);
                return { success: false, error: error.message, target: 'local-fallback' };
            }

            setLocalSchedule(dateKey, data);

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
                        verified = true;
                    }
                } catch (verifyErr) {
                    // retry
                }
            }
            
            if (!verified) {
                return { success: true, target: 'cloud-unverified', bunks: filteredBunkCount, verified: false };
            }

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
    async function deleteSchedule(dateKey) {
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
            deleteLocalSchedule(dateKey);
            return { success: true };
        } catch (e) {
            logError('Delete exception:', e);
            return { success: false, error: e.message };
        }
    }

    // Removes this scheduler's bunks from all records for a date.
    // Necessary because an owner's record may contain copies of this scheduler's bunks.
    async function deleteMyScheduleOnly(dateKey) {
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();
        try {
            const myBunks = getMyEditableBunks();
            if (myBunks.length === 0) return { success: true, message: 'No bunks assigned' };

            const allRecords = await loadAllSchedulersForDate(dateKey);
            if (!allRecords || allRecords.length === 0) {
                deleteLocalSchedule(dateKey);
                return { success: true, message: 'No cloud records' };
            }

            let recordsModified = 0;
            let recordsDeleted = 0;

            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = scheduleData.scheduleAssignments || {};
                const leagues = scheduleData.leagueAssignments || {};

                let modified = false;
                for (const bunk of myBunks) {
                    if (assignments[bunk] !== undefined) { delete assignments[bunk]; modified = true; }
                    if (leagues[bunk] !== undefined) { delete leagues[bunk]; }
                }
                if (!modified) continue;

                if (Object.keys(assignments).length === 0) {
                    const { error } = await client.from(CONFIG.TABLE_NAME).delete().eq('id', record.id);
                    if (error) logError(`Delete record ${record.id} failed:`, error);
                    else recordsDeleted++;
                } else {
                    const { error } = await client
                        .from(CONFIG.TABLE_NAME)
                        .update({ schedule_data: { ...scheduleData, scheduleAssignments: assignments, leagueAssignments: leagues }, updated_at: new Date().toISOString() })
                        .eq('id', record.id);
                    if (error) logError(`Update record ${record.id} failed:`, error);
                    else recordsModified++;
                }
            }

            const remaining = await loadAllSchedulersForDate(dateKey);
            if (remaining.length > 0) {
                setLocalSchedule(dateKey, mergeSchedules(remaining));
            } else {
                deleteLocalSchedule(dateKey);
            }
            return { success: true, recordsModified, recordsDeleted, bunksRemoved: myBunks.length };
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
        console.log('📅 SCHEDULE DB DIAGNOSTIC');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Date Key:', dateKey);
        console.log('');
        console.log('Dependencies:');
        console.log('  Supabase Client:', client ? '✅' : '❌');
        console.log('  Camp ID:', campId || '❌ MISSING');
        console.log('  User ID:', userId || '❌ MISSING');
        console.log('');
        console.log('Permissions:');
        console.log('  Role (CampistryDB):', window.CampistryDB?.getRole?.() || 'unknown');
        console.log('  Role (AccessControl):', window.AccessControl?.getCurrentRole?.() || 'unknown');
        console.log('  Editable Divisions (AccessControl):', window.AccessControl?.getEditableDivisions?.() || []);
        console.log('  Editable Bunks (PermissionsDB):', window.PermissionsDB?.getEditableBunks?.()?.length || 0);
        console.log('  Editable Bunks:', getMyEditableBunks().length);
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

    console.log('📅 [ScheduleDB] loaded');

})();
