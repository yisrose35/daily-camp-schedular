// =============================================================================
// unified_cloud_schedule_system.js v1.1 — CAMPISTRY CLOUD SCHEDULE SYNC
// =============================================================================
//
// PURPOSE: Fix the slot index mismatch between stored data and rendered view
// 
// THE PROBLEM:
// - Scheduler generates with 22 slots (its unifiedTimes array)
// - When loading, unifiedTimes gets rebuilt from skeleton → 17 slots
// - Slot indices no longer match → data appears in wrong rows or not at all
//
// THE SOLUTION:
// - Store unifiedTimes WITH the schedule data
// - On load, use the STORED unifiedTimes (don't rebuild)
// - Automatic version overwrite per-scheduler per-date
// - Better camp ID detection with multiple fallbacks
// - Immediate save after generation
//
// =============================================================================

(function() {
    'use strict';

    console.log('☁️ Unified Cloud Schedule System v1.1 loading...');

    const SUPABASE_URL = 'https://jxadnhevclwltyugijkw.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4YWRuaGV2Y2x3bHR5dWdpamt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ1OTk5ODYsImV4cCI6MjA2MDE3NTk4Nn0.9h3J2uvSKB2manFKFj6jCEMfNqcH9lu7dPFDjMJszFk';
    
    // Table for storing unified schedules per scheduler
    // PRIMARY: unified_scheduler_data (new, better structure)
    // FALLBACK: schedule_versions (existing table)
    const UNIFIED_SCHEDULES_TABLE = 'unified_scheduler_data';
    const FALLBACK_TABLE = 'schedule_versions';
    
    let DEBUG = true;
    let _useNewTable = false; // Will be set after checking if table exists
    let _cachedCampId = null; // Cache camp ID after first detection

    // =========================================================================
    // SUPABASE CLIENT
    // =========================================================================

    async function supabaseQuery(endpoint, options = {}) {
        const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
        const headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': options.prefer || 'return=representation'
        };
        
        try {
            const response = await fetch(url, {
                method: options.method || 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                // Check if it's a "table doesn't exist" error
                if (errorText.includes('does not exist') || response.status === 404) {
                    return { _tableNotFound: true };
                }
                throw new Error(`Supabase error: ${response.status} - ${errorText}`);
            }
            
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (err) {
            console.error('[CloudSchedule] Supabase query failed:', err);
            throw err;
        }
    }

    /**
     * Check if the new table exists
     */
    async function checkNewTableExists() {
        try {
            const result = await supabaseQuery(`${UNIFIED_SCHEDULES_TABLE}?limit=1`);
            if (result && !result._tableNotFound) {
                _useNewTable = true;
                if (DEBUG) console.log('[CloudSchedule] ✅ Using new unified_scheduler_data table');
                return true;
            }
        } catch (e) {
            // Table doesn't exist
        }
        
        if (DEBUG) console.log('[CloudSchedule] ⚠️ New table not found, using schedule_versions fallback');
        _useNewTable = false;
        return false;
    }

    // =========================================================================
    // GET CURRENT CONTEXT - IMPROVED CAMP ID DETECTION
    // =========================================================================

    function getCampId() {
        // Return cached if we have it
        if (_cachedCampId) return _cachedCampId;
        
        // Method 1: Direct window global
        if (window.CAMP_ID) {
            _cachedCampId = window.CAMP_ID;
            if (DEBUG) console.log('[CloudSchedule] Camp ID from window.CAMP_ID:', _cachedCampId);
            return _cachedCampId;
        }
        
        // Method 2: localStorage camp_id
        const storedCampId = localStorage.getItem('camp_id');
        if (storedCampId) {
            _cachedCampId = storedCampId;
            if (DEBUG) console.log('[CloudSchedule] Camp ID from localStorage:', _cachedCampId);
            return _cachedCampId;
        }
        
        // Method 3: Extract from campDailyData_v1
        try {
            const dailyDataRaw = localStorage.getItem('campDailyData_v1');
            if (dailyDataRaw) {
                const dailyData = JSON.parse(dailyDataRaw);
                if (dailyData._campId) {
                    _cachedCampId = dailyData._campId;
                    if (DEBUG) console.log('[CloudSchedule] Camp ID from dailyData._campId:', _cachedCampId);
                    return _cachedCampId;
                }
            }
        } catch (e) {}
        
        // Method 4: Extract from cloudStorageBridge
        if (window.cloudStorageBridge?.campId) {
            _cachedCampId = window.cloudStorageBridge.campId;
            if (DEBUG) console.log('[CloudSchedule] Camp ID from cloudStorageBridge:', _cachedCampId);
            return _cachedCampId;
        }
        
        // Method 5: Extract from Supabase session/user metadata
        try {
            const session = localStorage.getItem('sb-jxadnhevclwltyugijkw-auth-token');
            if (session) {
                const parsed = JSON.parse(session);
                const campId = parsed?.user?.user_metadata?.camp_id;
                if (campId) {
                    _cachedCampId = campId;
                    if (DEBUG) console.log('[CloudSchedule] Camp ID from Supabase session:', _cachedCampId);
                    return _cachedCampId;
                }
            }
        } catch (e) {}
        
        // Method 6: Check sessionStorage
        const sessionCampId = sessionStorage.getItem('camp_id');
        if (sessionCampId) {
            _cachedCampId = sessionCampId;
            if (DEBUG) console.log('[CloudSchedule] Camp ID from sessionStorage:', _cachedCampId);
            return _cachedCampId;
        }
        
        // Method 7: Look for camp_id in any localStorage key
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.includes('camp')) {
                    const value = localStorage.getItem(key);
                    // Look for UUID pattern
                    const uuidMatch = value?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                    if (uuidMatch) {
                        _cachedCampId = uuidMatch[0];
                        if (DEBUG) console.log('[CloudSchedule] Camp ID extracted from', key, ':', _cachedCampId);
                        return _cachedCampId;
                    }
                }
            }
        } catch (e) {}
        
        return null;
    }

    // Allow external setting of camp ID
    function setCampId(id) {
        _cachedCampId = id;
        localStorage.setItem('camp_id', id);
        if (DEBUG) console.log('[CloudSchedule] Camp ID set to:', id);
    }

    function getUserId() {
        return window.currentUserId || localStorage.getItem('user_id') || null;
    }

    function getSchedulerName() {
        return window.AccessControl?.getCurrentUserInfo?.()?.name || 
               window.currentUserName || 
               'Unknown Scheduler';
    }

    function getMyDivisions() {
        if (window.AccessControl?.getEditableDivisions) {
            return window.AccessControl.getEditableDivisions();
        }
        return Object.keys(window.divisions || {});
    }

    function getDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    // =========================================================================
    // SAVE SCHEDULE TO CLOUD
    // =========================================================================

    /**
     * Save the current schedule to the cloud.
     * This OVERWRITES any existing data for this scheduler + date combination.
     * 
     * KEY: We save unifiedTimes WITH the schedule data so slot indices stay aligned.
     */
    async function saveScheduleToCloud(dateKey) {
        if (!dateKey) dateKey = getDateKey();
        
        const campId = getCampId();
        const userId = getUserId();
        const schedulerName = getSchedulerName();
        const myDivisions = getMyDivisions();
        
        if (!campId) {
            console.error('[CloudSchedule] No camp ID - cannot save');
            return { success: false, error: 'No camp ID' };
        }
        
        // Get current state
        const scheduleAssignments = window.scheduleAssignments || {};
        const leagueAssignments = window.leagueAssignments || {};
        const unifiedTimes = window.unifiedTimes || [];
        const skeleton = window.manualSkeleton || window.skeleton || [];
        
        // Filter to only MY divisions' bunks
        const myBunks = new Set();
        const divisions = window.divisions || {};
        
        myDivisions.forEach(divName => {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(bunk => myBunks.add(String(bunk)));
            }
        });
        
        // Build payload with only my bunks
        const myScheduleAssignments = {};
        Object.entries(scheduleAssignments).forEach(([bunk, slots]) => {
            if (myBunks.has(String(bunk))) {
                myScheduleAssignments[bunk] = slots;
            }
        });
        
        // Build payload with only my divisions' leagues
        const myLeagueAssignments = {};
        myDivisions.forEach(divName => {
            if (leagueAssignments[divName]) {
                myLeagueAssignments[divName] = leagueAssignments[divName];
            }
        });
        
        const payload = {
            scheduleAssignments: myScheduleAssignments,
            leagueAssignments: myLeagueAssignments,
            unifiedTimes: serializeUnifiedTimes(unifiedTimes),
            skeleton: skeleton,
            divisions: myDivisions,
            slotCount: unifiedTimes.length,
            savedAt: new Date().toISOString()
        };
        
        if (DEBUG) {
            console.log('[CloudSchedule] Saving schedule:', {
                dateKey,
                campId,
                schedulerName,
                divisions: myDivisions,
                bunks: Object.keys(myScheduleAssignments).length,
                slots: unifiedTimes.length,
                useNewTable: _useNewTable
            });
        }
        
        try {
            if (_useNewTable) {
                return await saveToNewTable(campId, dateKey, userId, schedulerName, myDivisions, payload);
            } else {
                return await saveToVersionsTable(campId, dateKey, userId, schedulerName, myDivisions, payload);
            }
        } catch (err) {
            console.error('[CloudSchedule] Save failed:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Save to the NEW unified_scheduler_data table
     */
    async function saveToNewTable(campId, dateKey, userId, schedulerName, divisions, payload) {
        // Check if record exists for this scheduler + date
        const existingQuery = `${UNIFIED_SCHEDULES_TABLE}?camp_id=eq.${campId}&date_key=eq.${dateKey}&scheduler_id=eq.${userId || 'default'}`;
        const existing = await supabaseQuery(existingQuery);
        
        if (existing && existing.length > 0 && !existing._tableNotFound) {
            // UPDATE existing record
            const updateQuery = `${UNIFIED_SCHEDULES_TABLE}?id=eq.${existing[0].id}`;
            await supabaseQuery(updateQuery, {
                method: 'PATCH',
                body: {
                    schedule_data: payload,
                    scheduler_name: schedulerName,
                    divisions: divisions,
                    updated_at: new Date().toISOString()
                }
            });
            
            if (DEBUG) console.log('[CloudSchedule] ✅ Updated existing record (new table)');
        } else {
            // INSERT new record
            await supabaseQuery(UNIFIED_SCHEDULES_TABLE, {
                method: 'POST',
                body: {
                    camp_id: campId,
                    date_key: dateKey,
                    scheduler_id: userId || 'default',
                    scheduler_name: schedulerName,
                    divisions: divisions,
                    schedule_data: payload,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            });
            
            if (DEBUG) console.log('[CloudSchedule] ✅ Inserted new record (new table)');
        }
        
        return { success: true, bunks: Object.keys(payload.scheduleAssignments).length };
    }

    /**
     * Save to the EXISTING schedule_versions table (fallback)
     */
    async function saveToVersionsTable(campId, dateKey, userId, schedulerName, divisions, payload) {
        const versionName = `${schedulerName || 'Scheduler'} - ${divisions.join(',')}`;
        
        // Check if version exists for this scheduler + date
        const existingQuery = `${FALLBACK_TABLE}?camp_id=eq.${campId}&date_key=eq.${dateKey}&name=eq.${encodeURIComponent(versionName)}`;
        const existing = await supabaseQuery(existingQuery);
        
        if (existing && existing.length > 0 && !existing._tableNotFound) {
            // UPDATE existing version
            const updateQuery = `${FALLBACK_TABLE}?id=eq.${existing[0].id}`;
            await supabaseQuery(updateQuery, {
                method: 'PATCH',
                body: {
                    schedule_data: payload,
                    updated_at: new Date().toISOString()
                }
            });
            
            if (DEBUG) console.log('[CloudSchedule] ✅ Updated existing version (fallback table)');
        } else {
            // INSERT new version
            await supabaseQuery(FALLBACK_TABLE, {
                method: 'POST',
                body: {
                    camp_id: campId,
                    date_key: dateKey,
                    name: versionName,
                    schedule_data: payload,
                    created_at: new Date().toISOString()
                }
            });
            
            if (DEBUG) console.log('[CloudSchedule] ✅ Inserted new version (fallback table)');
        }
        
        return { success: true, bunks: Object.keys(payload.scheduleAssignments).length };
    }

    /**
     * Serialize unifiedTimes for storage (dates → ISO strings)
     */
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

    /**
     * Deserialize unifiedTimes from storage (ISO strings → dates)
     */
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
    // LOAD AND MERGE SCHEDULES FROM CLOUD
    // =========================================================================

    /**
     * Load all schedules for a date and merge them.
     * Each scheduler's data includes their unifiedTimes, so we use the one
     * with the most slots as the master.
     */
    async function loadAndMergeSchedules(dateKey) {
        if (!dateKey) dateKey = getDateKey();
        
        const campId = getCampId();
        if (!campId) {
            console.error('[CloudSchedule] No camp ID - cannot load');
            return { success: false, error: 'No camp ID' };
        }
        
        try {
            let records;
            
            if (_useNewTable) {
                records = await loadFromNewTable(campId, dateKey);
            } else {
                records = await loadFromVersionsTable(campId, dateKey);
            }
            
            if (!records || records.length === 0) {
                if (DEBUG) console.log('[CloudSchedule] No cloud records found for', dateKey);
                return { success: true, merged: false, records: 0 };
            }
            
            if (DEBUG) console.log(`[CloudSchedule] Found ${records.length} scheduler record(s) for ${dateKey}`);
            
            // Merge all records
            const mergedAssignments = {};
            const mergedLeagues = {};
            let masterUnifiedTimes = [];
            let maxSlots = 0;
            
            records.forEach(record => {
                const data = record.schedule_data || record;
                if (!data) return;
                
                if (DEBUG) {
                    console.log(`[CloudSchedule] Merging from "${record.scheduler_name || record.name}":`, {
                        divisions: record.divisions || data.divisions,
                        bunks: Object.keys(data.scheduleAssignments || {}).length,
                        slots: data.slotCount || (data.unifiedTimes?.length || 0)
                    });
                }
                
                // Merge scheduleAssignments
                if (data.scheduleAssignments) {
                    Object.entries(data.scheduleAssignments).forEach(([bunk, slots]) => {
                        mergedAssignments[bunk] = slots;
                    });
                }
                
                // Merge leagueAssignments
                if (data.leagueAssignments) {
                    Object.entries(data.leagueAssignments).forEach(([div, slots]) => {
                        mergedLeagues[div] = slots;
                    });
                }
                
                // Use unifiedTimes with most slots as master
                const recordSlots = data.unifiedTimes?.length || 0;
                if (recordSlots > maxSlots) {
                    maxSlots = recordSlots;
                    masterUnifiedTimes = data.unifiedTimes;
                }
            });
            
            // Apply merged data to window
            window.scheduleAssignments = mergedAssignments;
            window.leagueAssignments = mergedLeagues;
            
            // CRITICAL: Use the stored unifiedTimes, not rebuilt
            if (masterUnifiedTimes && masterUnifiedTimes.length > 0) {
                window.unifiedTimes = deserializeUnifiedTimes(masterUnifiedTimes);
                window._unifiedTimesFromCloud = true; // Flag so other systems don't overwrite
                if (DEBUG) console.log(`[CloudSchedule] Using stored unifiedTimes: ${window.unifiedTimes.length} slots`);
            }
            
            // Dispatch event for UI to update
            window.dispatchEvent(new CustomEvent('campistry-cloud-schedule-loaded', {
                detail: {
                    dateKey,
                    bunks: Object.keys(mergedAssignments).length,
                    slots: window.unifiedTimes.length
                }
            }));
            
            if (DEBUG) {
                console.log('[CloudSchedule] ✅ Merge complete:', {
                    totalBunks: Object.keys(mergedAssignments).length,
                    totalDivisions: Object.keys(mergedLeagues).length,
                    unifiedTimesSlots: window.unifiedTimes.length
                });
            }
            
            return { 
                success: true, 
                merged: true, 
                records: records.length,
                bunks: Object.keys(mergedAssignments).length
            };
            
        } catch (err) {
            console.error('[CloudSchedule] Load failed:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Load from NEW unified_scheduler_data table
     */
    async function loadFromNewTable(campId, dateKey) {
        const query = `${UNIFIED_SCHEDULES_TABLE}?camp_id=eq.${campId}&date_key=eq.${dateKey}`;
        const result = await supabaseQuery(query);
        if (result && result._tableNotFound) return [];
        return result || [];
    }

    /**
     * Load from EXISTING schedule_versions table (fallback)
     */
    async function loadFromVersionsTable(campId, dateKey) {
        const query = `${FALLBACK_TABLE}?camp_id=eq.${campId}&date_key=eq.${dateKey}`;
        const result = await supabaseQuery(query);
        if (result && result._tableNotFound) return [];
        return result || [];
    }

    // =========================================================================
    // AUTO-SAVE AFTER GENERATION
    // =========================================================================

    /**
     * Hook into the scheduler's save flow to auto-sync to cloud
     */
    function installAutoSaveHook() {
        // Hook saveCurrentDailyData
        const originalSave = window.saveCurrentDailyData;
        if (originalSave && !originalSave._cloudHooked) {
            window.saveCurrentDailyData = function(key, data) {
                const result = originalSave.call(this, key, data);
                
                // Auto-save to cloud when scheduleAssignments is saved
                if (key === 'scheduleAssignments' || key === 'leagueAssignments' || key === 'unifiedTimes') {
                    // Debounce cloud saves (500ms)
                    if (window._cloudSaveTimeout) clearTimeout(window._cloudSaveTimeout);
                    window._cloudSaveTimeout = setTimeout(() => {
                        saveScheduleToCloud().then(result => {
                            if (result.success) {
                                console.log('[CloudSchedule] ✅ Auto-saved to cloud');
                            }
                        });
                    }, 500);
                }
                
                return result;
            };
            window.saveCurrentDailyData._cloudHooked = true;
            if (DEBUG) console.log('[CloudSchedule] ✅ Hooked saveCurrentDailyData for auto-sync');
        }
        
        // Listen for generation complete event - save IMMEDIATELY
        window.addEventListener('campistry-generation-complete', () => {
            console.log('[CloudSchedule] Generation complete - saving immediately');
            // Clear any pending save and save now
            if (window._cloudSaveTimeout) clearTimeout(window._cloudSaveTimeout);
            saveScheduleToCloud().then(result => {
                if (result.success) {
                    console.log('[CloudSchedule] ✅ Saved after generation');
                    // Dispatch event so other users know
                    window.dispatchEvent(new CustomEvent('campistry-cloud-save-complete', {
                        detail: { dateKey: getDateKey() }
                    }));
                }
            });
        });
        
        // Also hook forceSyncToCloud if it exists
        const originalForceSync = window.forceSyncToCloud;
        if (originalForceSync && !originalForceSync._cloudHooked) {
            window.forceSyncToCloud = async function(...args) {
                const result = await originalForceSync.apply(this, args);
                // After force sync, also save to our system
                setTimeout(() => saveScheduleToCloud(), 100);
                return result;
            };
            window.forceSyncToCloud._cloudHooked = true;
            if (DEBUG) console.log('[CloudSchedule] ✅ Hooked forceSyncToCloud');
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (DEBUG) console.log('[CloudSchedule] Initializing...');
        
        // Wait for cloud hydration event first (indicates camp ID should be available)
        let hydrated = false;
        const hydrationHandler = () => { hydrated = true; };
        window.addEventListener('campistry-cloud-hydrated', hydrationHandler, { once: true });
        
        // Wait up to 10 seconds for hydration OR camp ID
        let attempts = 0;
        while (!getCampId() && !hydrated && attempts < 50) {
            await new Promise(r => setTimeout(r, 200));
            attempts++;
        }
        
        window.removeEventListener('campistry-cloud-hydrated', hydrationHandler);
        
        // Try one more time after hydration
        if (!getCampId() && hydrated) {
            await new Promise(r => setTimeout(r, 500));
        }
        
        const campId = getCampId();
        if (!campId) {
            console.warn('[CloudSchedule] No camp ID found - will retry when available');
            // Set up a listener to initialize later
            window.addEventListener('campistry-cloud-hydrated', () => {
                setTimeout(() => {
                    if (getCampId()) {
                        console.log('[CloudSchedule] Camp ID now available, completing initialization');
                        completeInitialization();
                    }
                }, 500);
            }, { once: true });
            return;
        }
        
        await completeInitialization();
    }
    
    async function completeInitialization() {
        if (DEBUG) console.log('[CloudSchedule] Camp ID:', getCampId());
        
        // Check which table to use
        await checkNewTableExists();
        
        // Install auto-save hook
        installAutoSaveHook();
        
        // Listen for cloud schedule loaded event
        window.addEventListener('campistry-cloud-schedule-loaded', () => {
            if (window.updateTable) {
                setTimeout(() => window.updateTable(), 100);
            }
        });
        
        // Auto-load from cloud on startup
        const dateKey = getDateKey();
        if (dateKey) {
            const result = await loadAndMergeSchedules(dateKey);
            if (result.merged) {
                console.log('[CloudSchedule] ✅ Auto-loaded and merged from cloud');
            }
        }
        
        if (DEBUG) console.log('[CloudSchedule] ✅ Initialization complete');
    }

    // =========================================================================
    // CREATE TABLE IF NOT EXISTS (for first-time setup)
    // =========================================================================

    /**
     * SQL to create the unified_scheduler_data table:
     * 
     * CREATE TABLE IF NOT EXISTS unified_scheduler_data (
     *     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     *     camp_id UUID NOT NULL,
     *     date_key TEXT NOT NULL,
     *     scheduler_id TEXT NOT NULL DEFAULT 'default',
     *     scheduler_name TEXT,
     *     divisions TEXT[],
     *     schedule_data JSONB NOT NULL,
     *     created_at TIMESTAMPTZ DEFAULT NOW(),
     *     updated_at TIMESTAMPTZ DEFAULT NOW(),
     *     UNIQUE(camp_id, date_key, scheduler_id)
     * );
     * 
     * CREATE INDEX idx_unified_camp_date ON unified_scheduler_data(camp_id, date_key);
     * 
     * -- Enable RLS
     * ALTER TABLE unified_scheduler_data ENABLE ROW LEVEL SECURITY;
     * 
     * -- Policy for reading (all camp members can read)
     * CREATE POLICY "Camp members can read schedules" ON unified_scheduler_data
     *     FOR SELECT USING (true);
     * 
     * -- Policy for writing (authenticated users can write)
     * CREATE POLICY "Authenticated users can write schedules" ON unified_scheduler_data
     *     FOR ALL USING (true);
     */

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.UnifiedCloudSchedule = {
        version: '1.1',
        saveScheduleToCloud,
        loadAndMergeSchedules,
        
        // Manual triggers
        save: () => saveScheduleToCloud(getDateKey()),
        load: () => loadAndMergeSchedules(getDateKey()),
        
        // Force refresh: clear local state and reload from cloud
        forceRefresh: async () => {
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            window.unifiedTimes = [];
            window._unifiedTimesFromCloud = false;
            
            const result = await loadAndMergeSchedules(getDateKey());
            if (window.updateTable) window.updateTable();
            return result;
        },
        
        // Camp ID management
        setCampId: setCampId,
        getCampId: getCampId,
        
        // Debug
        DEBUG_ON: () => { DEBUG = true; },
        DEBUG_OFF: () => { DEBUG = false; },
        
        getState: () => ({
            campId: getCampId(),
            userId: getUserId(),
            dateKey: getDateKey(),
            myDivisions: getMyDivisions(),
            scheduleAssignments: Object.keys(window.scheduleAssignments || {}).length,
            unifiedTimes: (window.unifiedTimes || []).length,
            unifiedTimesFromCloud: window._unifiedTimesFromCloud || false,
            useNewTable: _useNewTable,
            cachedCampId: _cachedCampId
        }),
        
        // Check table status
        checkTables: checkNewTableExists,
        
        // Re-initialize
        reinit: () => {
            _cachedCampId = null;
            initialize();
        }
    };

    // Initialize when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 500);
    }

    console.log('☁️ Unified Cloud Schedule System v1.1 loaded');
    console.log('   Better camp ID detection with fallbacks');
    console.log('   Immediate save after generation');
    console.log('   Use: window.UnifiedCloudSchedule.save() to save');
    console.log('   Use: window.UnifiedCloudSchedule.load() to load & merge');
    console.log('   Use: window.UnifiedCloudSchedule.forceRefresh() to reload from cloud');

})();
