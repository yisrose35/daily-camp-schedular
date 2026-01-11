// ============================================================================
// cloud_storage_bridge.js v5.0 - MULTI-SCHEDULER MERGE FIX
// ============================================================================
// CRITICAL FIX: Properly handles date-keyed schedule storage
// CRITICAL FIX: Fetch-Merge-Update pattern for multi-scheduler support
// 
// The daily_schedules structure in cloud MUST be:
// {
//   "2026-01-11": {
//     scheduleAssignments: { bunk: slots },
//     skeleton: [...],
//     subdivisionSchedules: {...}
//   }
// }
// 
// NOT the flat structure:
// {
//   bunk1: slots,
//   bunk2: slots
// }
// ============================================================================

(function () {
    "use strict";
    
    const VERSION = "5.1";
    const STORAGE_KEY = "campGlobalSettings_v1";
    const DAILY_DATA_KEY = "campDailyData_v1";
    
    console.log(`☁️ Campistry Cloud Bridge v${VERSION} (MULTI-SCHEDULER MERGE FIX + SAVE LOCK)`);

    // =========================================================================
    // STATE
    // =========================================================================
    
    let _campId = null;
    let _userRole = null;
    let _userDivisions = [];
    let _memoryCache = {};
    let _dailyDataDirty = false;
    let _localDataProtected = false;
    let _syncTimeout = null;
    let _saveLock = false;  // Prevent parallel saves
    let _pendingSave = null; // Queue for pending save

    // =========================================================================
    // PROTECTION FLAGS (for generation)
    // =========================================================================
    
    window.protectLocalData = function() {
        _localDataProtected = true;
        console.log("☁️ [PROTECT] Local data protected during generation");
    };
    
    window.unprotectLocalData = function() {
        _localDataProtected = false;
        console.log("☁️ [PROTECT] Local data protection lifted");
    };

    // =========================================================================
    // HELPER: Get current user's divisions
    // =========================================================================
    
    function getUserDivisions() {
        if (window.AccessControl?.getUserManagedDivisions) {
            return window.AccessControl.getUserManagedDivisions() || [];
        }
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            return window.SubdivisionScheduleManager.getDivisionsToSchedule() || [];
        }
        return [];
    }

    function getBunksForDivisions(divisions) {
        const bunks = new Set();
        const allDivisions = window.divisions || {};
        
        (divisions || []).forEach(divName => {
            const divInfo = allDivisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => bunks.add(b));
            }
        });
        
        return bunks;
    }

    function isOwnerOrAdmin() {
        const role = window.AccessControl?.getCurrentRole?.();
        return role === 'owner' || role === 'admin';
    }

    // =========================================================================
    // CAMP ID RESOLUTION
    // =========================================================================
    
    async function getCampId() {
        if (_campId) return _campId;
        
        const { data: { user } } = await window.supabase.auth.getUser();
        if (!user) return null;
        
        console.log("☁️ Determining camp ID for user:", user.id);
        
        // Check if user is a camp owner
        const { data: ownerData } = await window.supabase
            .from('camps')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle();
            
        if (ownerData) {
            _campId = ownerData.id;
            _userRole = 'owner';
            console.log("☁️ User is a camp owner");
            console.log("☁️ Camp ID cached:", _campId, "(owner)");
            return _campId;
        }
        
        // Check if user is a team member
        const { data: memberData } = await window.supabase
            .from('camp_team_members')
            .select('camp_id, role')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .maybeSingle();
            
        if (memberData) {
            _campId = memberData.camp_id;
            _userRole = memberData.role;
            console.log("☁️ User is a team member:", { campId: _campId, role: _userRole });
            console.log("☁️ Camp ID cached:", _campId, "(team member)");
            return _campId;
        }
        
        console.warn("☁️ No camp found for user");
        return null;
    }

    // =========================================================================
    // MIGRATE LEGACY ROOT DATA
    // =========================================================================
    
    function migrateLegacyCloudData(cloudData, dateKey) {
        if (!cloudData) return cloudData;
        
        // Keys that should be inside date-specific objects
        const scheduleKeys = ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 'manualSkeleton', 'skeleton'];
        
        let needsMigration = false;
        
        // Check if any schedule keys exist at ROOT level
        for (const key of scheduleKeys) {
            if (cloudData[key] !== undefined) {
                needsMigration = true;
                break;
            }
        }
        
        // Also check if there are bunk-like keys at root (flat structure)
        const rootKeys = Object.keys(cloudData);
        const hasFlatBunks = rootKeys.some(key => {
            // If the key looks like a bunk name and value is an array of slots
            return Array.isArray(cloudData[key]) && 
                   !['unifiedTimes', 'skeleton', 'manualSkeleton'].includes(key) &&
                   !key.match(/^\d{4}-\d{2}-\d{2}$/);
        });
        
        if (hasFlatBunks) {
            console.log("☁️ [MIGRATE] Detected FLAT bunk structure at root level");
            needsMigration = true;
        }
        
        if (!needsMigration) return cloudData;
        
        console.log("☁️ [MIGRATE] Migrating legacy cloud data structure...");
        
        // Initialize date key if needed
        if (!cloudData[dateKey]) {
            cloudData[dateKey] = {};
        }
        
        // Migrate schedule keys
        for (const key of scheduleKeys) {
            if (cloudData[key] !== undefined) {
                if (!cloudData[dateKey][key]) {
                    console.log(`☁️ [MIGRATE] Moving ROOT "${key}" to date ${dateKey}`);
                    cloudData[dateKey][key] = cloudData[key];
                }
                delete cloudData[key];
            }
        }
        
        // Migrate flat bunk structure
        if (hasFlatBunks) {
            const migratedAssignments = {};
            const keysToDelete = [];
            
            for (const key of rootKeys) {
                if (Array.isArray(cloudData[key]) && 
                    !['unifiedTimes', 'skeleton', 'manualSkeleton'].includes(key) &&
                    !key.match(/^\d{4}-\d{2}-\d{2}$/)) { // Not a date key
                    
                    migratedAssignments[key] = cloudData[key];
                    keysToDelete.push(key);
                }
            }
            
            if (Object.keys(migratedAssignments).length > 0) {
                console.log(`☁️ [MIGRATE] Moving ${Object.keys(migratedAssignments).length} flat bunks to scheduleAssignments`);
                cloudData[dateKey].scheduleAssignments = {
                    ...(cloudData[dateKey].scheduleAssignments || {}),
                    ...migratedAssignments
                };
                
                keysToDelete.forEach(key => delete cloudData[key]);
            }
        }
        
        return cloudData;
    }

    // =========================================================================
    // LOCAL CACHE MANAGEMENT
    // =========================================================================
    
    function setLocalCache(state) {
        // Handle daily_schedules specially
        if (state.daily_schedules) {
            if (!_dailyDataDirty && !_localDataProtected) {
                console.log("☁️ [SYNC] Unbundling daily schedules from cloud...");
                
                try {
                    const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                    
                    // Migrate any legacy structure
                    let cloudDailyData = migrateLegacyCloudData(state.daily_schedules, dateKey);
                    
                    // Load current localStorage
                    let localDailyData = {};
                    try {
                        const raw = localStorage.getItem(DAILY_DATA_KEY);
                        if (raw) localDailyData = JSON.parse(raw);
                    } catch (e) { /* ignore */ }
                    
                    // Merge cloud data with local (cloud wins for structure, but preserve local edits)
                    const merged = mergeCloudWithLocal(cloudDailyData, localDailyData, dateKey);
                    
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(merged));
                    
                    setTimeout(() => {
                        console.log("🔥 Dispatching UI refresh for new schedule data...");
                        window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
                        if (window.initScheduleSystem) window.initScheduleSystem();
                        if (window.updateTable) window.updateTable();
                    }, 50);
                    
                } catch (e) {
                    console.error("☁️ Failed to unbundle daily schedules:", e);
                }
            } else {
                console.log("☁️ [SYNC] Skipping daily overwrite - Local data protected or dirty");
            }
            delete state.daily_schedules;
        }
        
        // Handle other keys normally
        for (const [key, value] of Object.entries(state)) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (e) {
                console.warn(`☁️ Failed to cache ${key}:`, e);
            }
        }
        
        _memoryCache = { ..._memoryCache, ...state };
    }

    function mergeCloudWithLocal(cloudData, localData, dateKey) {
        const merged = { ...localData };
        
        // Copy all date keys from cloud
        for (const key of Object.keys(cloudData)) {
            if (key.match(/^\d{4}-\d{2}-\d{2}$/)) {
                // It's a date key - merge carefully
                if (!merged[key]) {
                    merged[key] = cloudData[key];
                } else {
                    // Merge date-specific data
                    merged[key] = {
                        ...merged[key],
                        ...cloudData[key],
                        // For scheduleAssignments, merge at bunk level
                        scheduleAssignments: {
                            ...(merged[key].scheduleAssignments || {}),
                            ...(cloudData[key].scheduleAssignments || {})
                        },
                        subdivisionSchedules: {
                            ...(merged[key].subdivisionSchedules || {}),
                            ...(cloudData[key].subdivisionSchedules || {})
                        }
                    };
                }
            }
        }
        
        return merged;
    }

    // =========================================================================
    // LOAD FROM CLOUD
    // =========================================================================
    
    async function loadFromCloud() {
        const campId = await getCampId();
        if (!campId) return null;
        
        console.log("☁️ Loading from cloud for camp:", campId);
        
        const { data, error } = await window.supabase
            .from('camp_settings')
            .select('settings')
            .eq('camp_id', campId)
            .maybeSingle();
            
        if (error) {
            console.error("☁️ Load error:", error);
            return null;
        }
        
        if (data?.settings) {
            setLocalCache(data.settings);
            window.__CAMPISTRY_CLOUD_READY__ = true;
            window.dispatchEvent(new Event('campistry-cloud-hydrated'));
            return data.settings;
        }
        
        window.__CAMPISTRY_CLOUD_READY__ = true;
        window.dispatchEvent(new Event('campistry-cloud-hydrated'));
        return null;
    }

    // =========================================================================
    // ★★★ CRITICAL: SAVE TO CLOUD WITH FETCH-MERGE-UPDATE ★★★
    // =========================================================================
    
    async function saveToCloud(localState) {
        // ================================================================
        // SAVE LOCK: Prevent parallel saves from racing
        // ================================================================
        if (_saveLock) {
            console.log("☁️ [SAVE] Already saving, queueing this request...");
            return new Promise((resolve) => {
                _pendingSave = async () => {
                    const result = await saveToCloud(localState);
                    resolve(result);
                };
            });
        }
        
        _saveLock = true;
        
        const campId = await getCampId();
        if (!campId) {
            console.warn("☁️ Cannot save - no camp ID");
            _saveLock = false;
            return false;
        }
        
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const userDivisions = getUserDivisions();
        const myBunks = getBunksForDivisions(userDivisions);
        const isOwner = isOwnerOrAdmin();
        
        console.log(`☁️ [SAVE] Role: ${isOwner ? 'owner' : 'scheduler'}`);
        console.log(`☁️ [SAVE] My divisions: [${userDivisions.join(', ')}] → ${myBunks.size} bunks`);
        
        try {
            // ================================================================
            // STEP 1: FETCH CURRENT CLOUD STATE
            // ================================================================
            console.log("☁️ [SAVE] Step 1: Fetching current cloud state...");
            
            const { data: currentData, error: fetchError } = await window.supabase
                .from('camp_settings')
                .select('settings')
                .eq('camp_id', campId)
                .maybeSingle();
                
            if (fetchError) {
                console.error("☁️ [SAVE] Fetch error:", fetchError);
                _saveLock = false;
                return false;
            }
            
            let cloudState = currentData?.settings || {};
            let cloudDailySchedules = cloudState.daily_schedules || {};
            
            // Migrate any legacy structure in cloud
            cloudDailySchedules = migrateLegacyCloudData(cloudDailySchedules, dateKey);
            
            // ================================================================
            // STEP 2: PREPARE LOCAL DAILY DATA
            // ================================================================
            console.log("☁️ [SAVE] Step 2: Preparing local daily data...");
            
            let localDailyData = {};
            try {
                const raw = localStorage.getItem(DAILY_DATA_KEY);
                if (raw) localDailyData = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            
            const localDateData = localDailyData[dateKey] || {};
            const localAssignments = localDateData.scheduleAssignments || {};
            
            // ================================================================
            // STEP 3: MERGE LOGIC (CRITICAL FOR MULTI-SCHEDULER)
            // ================================================================
            console.log("☁️ [SAVE] Step 3: Merging schedules...");
            
            // Get cloud's date-specific data
            let cloudDateData = cloudDailySchedules[dateKey] || {};
            let cloudAssignments = cloudDateData.scheduleAssignments || {};
            
            const cloudBunkCount = Object.keys(cloudAssignments).length;
            console.log(`☁️ [SAVE] Cloud has ${cloudBunkCount} bunks for ${dateKey}`);
            
            let mergedAssignments;
            
            if (isOwner) {
                // ============================================================
                // OWNER MODE: Full overwrite for date
                // ============================================================
                console.log("☁️ [SAVE] Owner mode - full save");
                mergedAssignments = localAssignments;
                
            } else {
                // ============================================================
                // SCHEDULER MODE: Fetch-Merge-Update (FIXED)
                // ============================================================
                console.log("☁️ [SAVE] Scheduler mode - merge with cloud");
                
                // Start with cloud's assignments
                mergedAssignments = { ...cloudAssignments };
                
                // CRITICAL FIX: First REMOVE all cloud bunks that belong to MY divisions
                // This ensures we don't keep stale data from my divisions
                let removedCount = 0;
                for (const bunk of Object.keys(mergedAssignments)) {
                    if (myBunks.has(bunk)) {
                        delete mergedAssignments[bunk];
                        removedCount++;
                    }
                }
                console.log(`☁️ [SAVE] Removed ${removedCount} old bunks from my divisions`);
                
                // Count preserved bunks (from OTHER schedulers)
                const preservedCount = Object.keys(mergedAssignments).length;
                console.log(`☁️ [SAVE] Preserved ${preservedCount} bunks from other schedulers`);
                
                // THEN add all my local bunks
                let myBunkCount = 0;
                for (const bunk of Object.keys(localAssignments)) {
                    if (myBunks.has(bunk)) {
                        mergedAssignments[bunk] = localAssignments[bunk];
                        myBunkCount++;
                    }
                }
                console.log(`☁️ [SAVE] Added ${myBunkCount} bunks from my divisions`);
            }
            
            const mergedBunkCount = Object.keys(mergedAssignments).length;
            console.log(`☁️ [SAVE] Cloud had ${cloudBunkCount} bunks → Now ${mergedBunkCount} bunks`);
            
            // ================================================================
            // STEP 4: BUILD FINAL STATE
            // ================================================================
            
            // Merge the date-specific data
            const mergedDateData = {
                ...cloudDateData,
                ...localDateData,
                scheduleAssignments: mergedAssignments,
                // Merge subdivision schedules too
                subdivisionSchedules: {
                    ...(cloudDateData.subdivisionSchedules || {}),
                    ...(localDateData.subdivisionSchedules || {})
                }
            };
            
            // Build final daily_schedules
            const finalDailySchedules = {
                ...cloudDailySchedules,
                [dateKey]: mergedDateData
            };
            
            // Build final state (merge with non-daily data)
            const stateToSave = { ...cloudState };
            
            // Copy non-daily keys from local
            for (const [key, value] of Object.entries(localState || {})) {
                if (key !== 'daily_schedules') {
                    stateToSave[key] = value;
                }
            }
            
            // Set the merged daily schedules
            stateToSave.daily_schedules = finalDailySchedules;
            
            // ================================================================
            // STEP 5: SAVE TO CLOUD
            // ================================================================
            console.log("☁️ [SAVE] Step 5: Saving to cloud...");
            
            const { error: saveError } = await window.supabase
                .from('camp_settings')
                .upsert({
                    camp_id: campId,
                    settings: stateToSave,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'camp_id' });
                
            if (saveError) {
                console.error("☁️ [SAVE] Save error:", saveError);
                _saveLock = false;
                return false;
            }
            
            console.log("☁️ [SAVE] ✅ Success");
            _dailyDataDirty = false;
            
            // Release lock and process any pending save
            _saveLock = false;
            if (_pendingSave) {
                const pendingFn = _pendingSave;
                _pendingSave = null;
                setTimeout(pendingFn, 100);
            }
            
            return true;
            
        } catch (e) {
            console.error("☁️ [SAVE] Exception:", e);
            _saveLock = false;
            return false;
        }
    }

    // =========================================================================
    // CLEAR CLOUD KEYS (for delete operations)
    // =========================================================================
    
    async function clearCloudKeys(keys) {
        console.log("☁️ [CLEAR] Clearing keys:", keys);
        
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const isOwner = isOwnerOrAdmin();
        const myBunks = getBunksForDivisions(getUserDivisions());
        
        // Load current local data
        let localDailyData = {};
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) localDailyData = JSON.parse(raw);
        } catch (e) { /* ignore */ }
        
        // Clear the specified keys appropriately
        for (const key of keys) {
            if (key === 'daily_schedules') {
                if (isOwner) {
                    // Owner clears everything
                    localDailyData = {};
                } else {
                    // Scheduler only clears their bunks
                    if (localDailyData[dateKey]?.scheduleAssignments) {
                        const assignments = localDailyData[dateKey].scheduleAssignments;
                        for (const bunk of Object.keys(assignments)) {
                            if (myBunks.has(bunk)) {
                                delete assignments[bunk];
                            }
                        }
                    }
                }
            } else if (localDailyData[dateKey]) {
                // Clear specific key in current date
                delete localDailyData[dateKey][key];
            }
        }
        
        // Save back to localStorage
        localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(localDailyData));
        
        // Sync to cloud
        await forceSyncToCloud();
    }

    // =========================================================================
    // RESET CLOUD STATE (for Erase All)
    // =========================================================================
    
    async function resetCloudState() {
        console.log("☁️ [RESET] Resetting cloud state...");
        
        const campId = await getCampId();
        if (!campId) return false;
        
        // Clear localStorage
        localStorage.removeItem(DAILY_DATA_KEY);
        localStorage.removeItem(STORAGE_KEY);
        
        // Reset cloud
        const emptyState = {
            daily_schedules: {},
            [STORAGE_KEY]: {}
        };
        
        const { error } = await window.supabase
            .from('camp_settings')
            .upsert({
                camp_id: campId,
                settings: emptyState,
                updated_at: new Date().toISOString()
            }, { onConflict: 'camp_id' });
            
        if (error) {
            console.error("☁️ [RESET] Error:", error);
            return false;
        }
        
        console.log("☁️ [RESET] ✅ Success");
        return true;
    }

    // =========================================================================
    // FORCE SYNC (Debounced)
    // =========================================================================
    
    async function forceSyncToCloud() {
        clearTimeout(_syncTimeout);
        
        return new Promise((resolve) => {
            _syncTimeout = setTimeout(async () => {
                console.log("☁️ [FORCE SYNC] Starting...");
                
                // Gather all local data
                const localState = {};
                
                try {
                    const globalRaw = localStorage.getItem(STORAGE_KEY);
                    if (globalRaw) localState[STORAGE_KEY] = JSON.parse(globalRaw);
                } catch (e) { /* ignore */ }
                
                try {
                    const dailyRaw = localStorage.getItem(DAILY_DATA_KEY);
                    if (dailyRaw) localState.daily_schedules = JSON.parse(dailyRaw);
                } catch (e) { /* ignore */ }
                
                const result = await saveToCloud(localState);
                resolve(result);
                
            }, 300);
        });
    }

    // =========================================================================
    // AUTO-SAVE INTERCEPTOR
    // =========================================================================
    
    function setupAutoSave() {
        const originalSetItem = localStorage.setItem.bind(localStorage);
        
        localStorage.setItem = function(key, value) {
            originalSetItem(key, value);
            
            if (key === DAILY_DATA_KEY) {
                _dailyDataDirty = true;
                
                // Debounced cloud sync
                clearTimeout(_syncTimeout);
                _syncTimeout = setTimeout(async () => {
                    if (_dailyDataDirty && !_localDataProtected) {
                        await forceSyncToCloud();
                    }
                }, 2000);
            }
        };
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    async function initialize() {
        if (!window.supabase) {
            console.warn("☁️ Supabase not available, waiting...");
            setTimeout(initialize, 500);
            return;
        }
        
        setupAutoSave();
        await loadFromCloud();
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    // Helper for multi-scheduler to fetch schedule directly from cloud
    async function fetchScheduleFromCloud(dateKey) {
        const campId = await getCampId();
        if (!campId) return null;
        
        console.log(`☁️ [FETCH] Getting schedule for ${dateKey} from cloud...`);
        
        const { data, error } = await window.supabase
            .from('camp_settings')
            .select('settings')
            .eq('camp_id', campId)
            .maybeSingle();
            
        if (error || !data?.settings) {
            console.log(`☁️ [FETCH] No cloud data found`);
            return null;
        }
        
        const dailySchedules = data.settings.daily_schedules || {};
        const dateData = dailySchedules[dateKey] || {};
        const assignments = dateData.scheduleAssignments || {};
        
        console.log(`☁️ [FETCH] Found ${Object.keys(assignments).length} bunks for ${dateKey}`);
        
        return {
            scheduleAssignments: assignments,
            subdivisionSchedules: dateData.subdivisionSchedules || {},
            skeleton: dateData.skeleton || null,
            unifiedTimes: dateData.unifiedTimes || null
        };
    }
    
    window.loadFromCloud = loadFromCloud;
    window.saveToCloud = saveToCloud;
    window.forceSyncToCloud = forceSyncToCloud;
    window.clearCloudKeys = clearCloudKeys;
    window.resetCloudState = resetCloudState;
    window.getCampId = getCampId;
    window.fetchScheduleFromCloud = fetchScheduleFromCloud;
    
    // Start initialization
    if (document.readyState === 'complete') {
        setTimeout(initialize, 100);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 100));
    }

})();
