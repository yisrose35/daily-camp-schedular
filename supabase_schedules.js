// =============================================================================
// supabase_schedules.js v5.1 — CAMPISTRY SCHEDULE DATABASE OPERATIONS
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
// v5.1 FIXES:
// - Fixed filtering to use AccessControl instead of PermissionsDB
// - PermissionsDB was returning empty bunks, causing 0 bunks to be saved
//
// =============================================================================
(function() {
    'use strict';
    console.log('📅 Campistry Schedule DB v5.1 loading...');
    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    const CONFIG = {
        TABLE_NAME: 'daily_schedules',
        LOCAL_STORAGE_KEY: 'campDailyData_v1',
        DEBUG: true  // Enable debug logging
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
        
        // For schedulers, use AccessControl's editable divisions (it's properly initialized)
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
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
            // Return original to avoid saving empty - let RLS handle it
            return scheduleAssignments;
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
    // SAVE OPERATIONS (FIXED - Uses AccessControl for filtering)
    // =========================================================================
    /**
     * Save schedule for a date.
     * Automatically filters to user's divisions and UPSERTs.
     * 
     * FIXED in v5.1: Uses AccessControl instead of PermissionsDB for filtering
     */
    async function saveSchedule(dateKey, data, options = {}) {
        const client = getClient();
        const campId = getCampId();
        const userId = getUserId();
        const schedulerName = getSchedulerName();

        const originalBunkCount = Object.keys(data?.scheduleAssignments || {}).length;
        log('saveSchedule called:', dateKey, 'with', originalBunkCount, 'bunks');

        if (!client || !campId) {
            log('No client or camp ID, saving to local only');
            setLocalSchedule(dateKey, data);
            return { success: true, target: 'local' };
        }

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

            // Prepare payload
            const payload = {
                scheduleAssignments: filteredAssignments,
                leagueAssignments: data.leagueAssignments || {},
                unifiedTimes: serializeUnifiedTimes(data.unifiedTimes || window.unifiedTimes || []),
                slotCount: data.unifiedTimes?.length || window.unifiedTimes?.length || 0
            };

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

            if (error) {
                logError('Save failed:', error);
                logError('Error details:', JSON.stringify(error));
                // Fallback to local
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

            return { 
                success: true, 
                target: 'cloud',
                bunks: filteredBunkCount
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
                    log('  Skipping - no changes needed');
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
                        logError(`  Delete record ${record.id} failed:`, error);
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
                    console.log(`\nRecord ${i + 1}:`);
                    console.log('  Scheduler:', record.scheduler_name || 'Unknown');
                    console.log('  Scheduler ID:', record.scheduler_id);
                    console.log('  Divisions:', JSON.stringify(record.divisions));
                    console.log('  Bunks in schedule_data:', bunks);
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

    console.log('📅 [ScheduleDB] v5.1 loaded with AccessControl filtering fix');
    console.log('   Run: ScheduleDB.diagnose() to check sync status');

})();
