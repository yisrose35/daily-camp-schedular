// =============================================================================
// supabase_schedules.js v5.0 — CAMPISTRY SCHEDULE DATABASE OPERATIONS
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
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Campistry Schedule DB v5.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const CONFIG = {
        TABLE_NAME: 'daily_schedules',
        LOCAL_STORAGE_KEY: 'campDailyData_v1',
        DEBUG: false
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

    function setLocalSchedule(dateKey, schedule) {
        const data = getLocalData();
        data[dateKey] = schedule;
        setLocalData(data);
    }

    function deleteLocalSchedule(dateKey) {
        const data = getLocalData();
        delete data[dateKey];
        setLocalData(data);
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

    /**
     * Merge multiple scheduler records into a single schedule.
     * Each scheduler's bunk data takes precedence for their bunks.
     * UnifiedTimes uses the longest array.
     */
    function mergeSchedules(records) {
        if (!records || records.length === 0) return null;

        const mergedAssignments = {};
        const mergedLeagues = {};
        let masterUnifiedTimes = [];
        let maxSlots = 0;
        let isRainyDay = false;

        records.forEach(record => {
            const data = record.schedule_data || {};
            
            log('Merging from', record.scheduler_name || 'unknown', {
                bunks: Object.keys(data.scheduleAssignments || {}).length,
                slots: data.unifiedTimes?.length || 0
            });

            // Merge scheduleAssignments (each scheduler owns their bunks)
            if (data.scheduleAssignments) {
                Object.entries(data.scheduleAssignments).forEach(([bunkId, slots]) => {
                    mergedAssignments[bunkId] = slots;
                });
            }

            // Merge leagueAssignments
            if (data.leagueAssignments) {
                Object.entries(data.leagueAssignments).forEach(([div, slots]) => {
                    mergedLeagues[div] = slots;
                });
            }

            // Use longest unifiedTimes
            const times = data.unifiedTimes || [];
            if (times.length > maxSlots) {
                maxSlots = times.length;
                masterUnifiedTimes = times;
            }

            // Rainy day flag
            if (record.is_rainy_day) {
                isRainyDay = true;
            }
        });

        return {
            scheduleAssignments: mergedAssignments,
            leagueAssignments: mergedLeagues,
            unifiedTimes: deserializeUnifiedTimes(masterUnifiedTimes),
            slotCount: maxSlots,
            isRainyDay,
            _mergedAt: new Date().toISOString(),
            _recordCount: records.length
        };
    }

    // =========================================================================
    // SAVE OPERATIONS
    // =========================================================================

    /**
     * Save schedule for a date.
     * Automatically filters to user's divisions and UPSERTs.
     */
    async function saveSchedule(dateKey, data, options = {}) {
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();
        const schedulerName = getSchedulerName();

        if (!client || !campId) {
            log('No client or camp ID, saving to local only');
            setLocalSchedule(dateKey, data);
            return { success: true, target: 'local' };
        }

        try {
            // Filter to user's divisions (unless skipFilter is true)
            let filteredData = data;
            if (!options.skipFilter && window.PermissionsDB?.filterToMyDivisions) {
                const originalAssignments = data.scheduleAssignments || {};
                const filteredAssignments = window.PermissionsDB.filterToMyDivisions(originalAssignments);
                filteredData = { ...data, scheduleAssignments: filteredAssignments };
            }

            // Prepare payload
            const payload = {
                scheduleAssignments: filteredData.scheduleAssignments || {},
                leagueAssignments: filteredData.leagueAssignments || {},
                unifiedTimes: serializeUnifiedTimes(filteredData.unifiedTimes || window.unifiedTimes || []),
                slotCount: filteredData.unifiedTimes?.length || window.unifiedTimes?.length || 0
            };

            // Get user's divisions
            const divisions = window.PermissionsDB?.getEditableDivisions?.() || [];

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
                // Fallback to local
                setLocalSchedule(dateKey, data);
                return { success: false, error: error.message, target: 'local-fallback' };
            }

            // Update local storage with full data (for offline access)
            setLocalSchedule(dateKey, data);

            log('Saved successfully:', {
                bunks: Object.keys(payload.scheduleAssignments).length,
                slots: payload.slotCount
            });

            return { 
                success: true, 
                target: 'cloud',
                bunks: Object.keys(payload.scheduleAssignments).length
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
     * Delete only MY schedule data for a date.
     * Preserves other schedulers' work.
     */
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
        const myBunks = getMyBunks();
        log('My bunks to delete:', myBunks);

        if (myBunks.length === 0) {
            log('No bunks to delete');
            return { success: true, message: 'No bunks assigned' };
        }

        // Step 2: Load ALL records for this date
        const allRecords = await loadAllSchedulersForDate(dateKey);
        log('Found', allRecords.length, 'records for', dateKey);

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
                if (leagues[bunk] !== undefined) {
                    delete leagues[bunk];
                }
            }

            const bunksAfter = Object.keys(assignments).length;
            log(`Record ${record.scheduler_name}: ${bunksBefore} → ${bunksAfter} bunks`);

            if (!modified) {
                log(`  Skipping - no changes needed`);
                continue;
            }

            // If record is now empty, delete it entirely
            if (bunksAfter === 0) {
                log(`  Record now empty, deleting...`);
                const { error } = await client
                    .from(CONFIG.TABLE_NAME)
                    .delete()
                    .eq('id', record.id);

                if (error) {
                    logError(`  Delete record ${record.id} failed:`, error);
                } else {
                    recordsDeleted++;
                    log(`  ✅ Deleted empty record`);
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
                    log(`  ✅ Updated record`);
                }
            }
        }

        log(`Delete complete: ${recordsModified} modified, ${recordsDeleted} deleted`);

        // Step 4: Reload remaining data and update local storage
        const remaining = await loadAllSchedulersForDate(dateKey);
        if (remaining.length > 0) {
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

/**
 * Helper: Get list of bunk IDs that the current user can edit
 */
function getMyBunks() {
    // Try to get from AccessControl/PermissionsDB
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

    // Fallback: if AccessControl not ready, try to get from bunks metadata
    if (bunks.length === 0) {
        const allBunks = window.bunks || [];
        const userSubdivisions = window.AccessControl?.getUserSubdivisionIds?.() || [];
        
        if (userSubdivisions.length > 0 && allBunks.length > 0) {
            // Filter bunks by subdivision
            // This is a fallback - ideally AccessControl should be ready
            log('Warning: Using fallback bunk detection');
        }
    }

    return bunks;
}

    // =========================================================================
    // VERSIONING
    // =========================================================================

    /**
     * Create a named version of the current schedule.
     */
    async function createVersion(dateKey, versionName) {
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();

        // Load current data
        const current = await loadAllSchedulersForDate(dateKey);
        if (!current || current.length === 0) {
            return { success: false, error: 'No schedule data to version' };
        }

        const merged = mergeSchedules(current);

        try {
            const { data, error } = await client
                .from('schedule_versions')
                .insert({
                    camp_id: campId,
                    date_key: dateKey,
                    name: versionName,
                    schedule_data: {
                        scheduleAssignments: merged.scheduleAssignments,
                        leagueAssignments: merged.leagueAssignments,
                        unifiedTimes: serializeUnifiedTimes(merged.unifiedTimes)
                    },
                    created_by: userId
                })
                .select()
                .single();

            if (error) {
                logError('Create version failed:', error);
                return { success: false, error: error.message };
            }

            log('Created version:', versionName);
            return { success: true, version: data };

        } catch (e) {
            logError('Create version exception:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Load all versions for a date.
     */
    async function loadVersions(dateKey) {
        const client = getClient();
        const campId = getCampId();

        try {
            const { data, error } = await client
                .from('schedule_versions')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey)
                .order('created_at', { ascending: false });

            if (error) {
                logError('Load versions failed:', error);
                return [];
            }

            return data || [];

        } catch (e) {
            logError('Load versions exception:', e);
            return [];
        }
    }

    /**
     * Restore a version.
     */
    async function restoreVersion(versionId) {
        const client = getClient();

        try {
            // Load the version
            const { data: version, error: loadError } = await client
                .from('schedule_versions')
                .select('*')
                .eq('id', versionId)
                .single();

            if (loadError || !version) {
                return { success: false, error: 'Version not found' };
            }

            // Save as current schedule
            const result = await saveSchedule(version.date_key, version.schedule_data, { skipFilter: true });
            
            return { success: result.success, dateKey: version.date_key };

        } catch (e) {
            logError('Restore version exception:', e);
            return { success: false, error: e.message };
        }
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
        
        // Versioning
        createVersion,
        loadVersions,
        restoreVersion,
        
        // Local storage helpers
        getLocalSchedule,
        setLocalSchedule,
        
        // Time helpers
        serializeUnifiedTimes,
        deserializeUnifiedTimes,
        
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

})();
