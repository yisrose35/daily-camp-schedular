// ============================================================================
// cloud_storage_bridge.js v5.3 - ACCESSCONTROL + GLOBALAUTHORITY FIX
// ============================================================================
// CRITICAL FIX: isInitialized is a PROPERTY not a function
// CRITICAL FIX: Proper try-catch around AccessControl calls
// CRITICAL FIX: Hydrates GlobalAuthority with divisions/bunks from cloud
// CRITICAL FIX: Fetch-Merge-Update pattern for multi-scheduler support
// ============================================================================

(function () {
    "use strict";
    
    const VERSION = "5.3";
    const STORAGE_KEY = "campGlobalSettings_v1";
    const DAILY_DATA_KEY = "campDailyData_v1";
    
    console.log(`☁️ Campistry Cloud Bridge v${VERSION} (ACCESSCONTROL + GLOBALAUTHORITY FIX)`);

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
    let _saveLock = false;
    let _pendingSave = null;
    let _initRetries = 0;
    const MAX_INIT_RETRIES = 20;

    // =========================================================================
    // HELPER: Check if AccessControl is ready (handles both property and method)
    // =========================================================================
    
    function isAccessControlReady() {
        try {
            if (!window.AccessControl) return false;
            
            // Check if isInitialized is a function or property
            if (typeof window.AccessControl.isInitialized === 'function') {
                return window.AccessControl.isInitialized();
            }
            // It's a property (boolean)
            if (typeof window.AccessControl.isInitialized === 'boolean') {
                return window.AccessControl.isInitialized;
            }
            // Try _isInitialized as fallback
            if (typeof window.AccessControl._isInitialized === 'boolean') {
                return window.AccessControl._isInitialized;
            }
            // Check if it has essential methods as proxy for being ready
            if (window.AccessControl.getCurrentRole && window.AccessControl.getEditableDivisions) {
                return true;
            }
            return false;
        } catch (e) {
            console.warn("☁️ Error checking AccessControl ready state:", e);
            return false;
        }
    }

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
        try {
            if (window.AccessControl?.getEditableDivisions) {
                return window.AccessControl.getEditableDivisions() || [];
            }
            if (window.AccessControl?.getUserManagedDivisions) {
                return window.AccessControl.getUserManagedDivisions() || [];
            }
            if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
                return window.SubdivisionScheduleManager.getDivisionsToSchedule() || [];
            }
        } catch (e) {
            console.warn("☁️ Error getting user divisions:", e);
        }
        return [];
    }

    function getBunksForDivisions(divisions) {
        const bunks = new Set();
        const allDivisions = window.divisions || {};
        
        (divisions || []).forEach(divName => {
            const divInfo = allDivisions[divName] || allDivisions[String(divName)];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => bunks.add(String(b)));
            }
        });
        
        return bunks;
    }

    function isOwnerOrAdmin() {
        try {
            const role = window.AccessControl?.getCurrentRole?.() || _userRole;
            return role === 'owner' || role === 'admin';
        } catch (e) {
            return _userRole === 'owner' || _userRole === 'admin';
        }
    }

    // =========================================================================
    // CAMP ID RESOLUTION - SAFE ACCESS TO ACCESSCONTROL
    // =========================================================================
    
    async function getCampId() {
        if (_campId) return _campId;
        
        // ================================================================
        // PRIORITY 1: Use AccessControl's context (MOST RELIABLE)
        // ================================================================
        try {
            if (isAccessControlReady()) {
                // Try getCampId first
                if (typeof window.AccessControl.getCampId === 'function') {
                    const acCampId = window.AccessControl.getCampId();
                    if (acCampId) {
                        _campId = acCampId;
                        _userRole = window.AccessControl.getCurrentRole?.() || 'scheduler';
                        console.log("☁️ Got camp ID from AccessControl.getCampId():", _campId);
                        window.__CAMPISTRY_CAMP_ID__ = _campId;
                        return _campId;
                    }
                }
                
                // Try getCampContext
                if (typeof window.AccessControl.getCampContext === 'function') {
                    const ctx = window.AccessControl.getCampContext();
                    if (ctx?.campId) {
                        _campId = ctx.campId;
                        _userRole = ctx.role || 'scheduler';
                        console.log("☁️ Got camp ID from AccessControl.getCampContext():", _campId);
                        window.__CAMPISTRY_CAMP_ID__ = _campId;
                        return _campId;
                    }
                }
                
                // Try internal state
                if (window.AccessControl._campId) {
                    _campId = window.AccessControl._campId;
                    _userRole = window.AccessControl._role || 'scheduler';
                    console.log("☁️ Got camp ID from AccessControl._campId:", _campId);
                    window.__CAMPISTRY_CAMP_ID__ = _campId;
                    return _campId;
                }
            }
        } catch (e) {
            console.warn("☁️ Error accessing AccessControl:", e);
        }
        
        // ================================================================
        // PRIORITY 2: Check global cache
        // ================================================================
        if (window.__CAMPISTRY_CAMP_ID__) {
            _campId = window.__CAMPISTRY_CAMP_ID__;
            _userRole = window.__CAMPISTRY_USER_ROLE__ || 'scheduler';
            console.log("☁️ Got camp ID from global cache:", _campId);
            return _campId;
        }
        
        // ================================================================
        // PRIORITY 3: Check localStorage cache
        // ================================================================
        try {
            const cachedCampId = localStorage.getItem('campistry_camp_id');
            if (cachedCampId && cachedCampId !== 'undefined' && cachedCampId !== 'null') {
                _campId = cachedCampId;
                _userRole = localStorage.getItem('campistry_user_role') || 'scheduler';
                console.log("☁️ Got camp ID from localStorage:", _campId);
                window.__CAMPISTRY_CAMP_ID__ = _campId;
                return _campId;
            }
        } catch (e) {
            console.warn("☁️ Error reading localStorage:", e);
        }
        
        // ================================================================
        // PRIORITY 4: AccessControl exists but not ready - return null to retry
        // ================================================================
        if (window.AccessControl && !isAccessControlReady()) {
            console.log("☁️ AccessControl exists but not ready yet...");
            return null;
        }
        
        // ================================================================
        // PRIORITY 5: Direct Supabase query (last resort)
        // ================================================================
        if (!window.supabase) {
            console.warn("☁️ Supabase not available");
            return null;
        }
        
        try {
            const { data: { user } } = await window.supabase.auth.getUser();
            if (!user) {
                console.warn("☁️ No authenticated user");
                return null;
            }
            
            console.log("☁️ Attempting direct Supabase query for user:", user.id);
            
            // Try camps table (owner check)
            try {
                const { data: ownerData } = await window.supabase
                    .from('camps')
                    .select('id')
                    .eq('owner_id', user.id)
                    .maybeSingle();
                    
                if (ownerData?.id) {
                    _campId = ownerData.id;
                    _userRole = 'owner';
                    window.__CAMPISTRY_CAMP_ID__ = _campId;
                    window.__CAMPISTRY_USER_ROLE__ = _userRole;
                    localStorage.setItem('campistry_camp_id', _campId);
                    localStorage.setItem('campistry_user_role', _userRole);
                    console.log("☁️ User is camp owner:", _campId);
                    return _campId;
                }
            } catch (e) {
                console.warn("☁️ Owner query failed:", e.message);
            }
            
            // Try camp_team_members table
            try {
                const { data: memberData } = await window.supabase
                    .from('camp_team_members')
                    .select('camp_id, role')
                    .eq('user_id', user.id)
                    .eq('status', 'active')
                    .maybeSingle();
                    
                if (memberData?.camp_id) {
                    _campId = memberData.camp_id;
                    _userRole = memberData.role || 'scheduler';
                    window.__CAMPISTRY_CAMP_ID__ = _campId;
                    window.__CAMPISTRY_USER_ROLE__ = _userRole;
                    localStorage.setItem('campistry_camp_id', _campId);
                    localStorage.setItem('campistry_user_role', _userRole);
                    console.log("☁️ User is team member:", _campId);
                    return _campId;
                }
            } catch (e) {
                console.warn("☁️ Team member query failed:", e.message);
            }
            
        } catch (e) {
            console.error("☁️ getCampId exception:", e);
        }
        
        console.warn("☁️ Could not determine camp ID");
        return null;
    }

    // =========================================================================
    // ★★★ HYDRATE GLOBAL AUTHORITY ★★★
    // =========================================================================
    
    function hydrateGlobalAuthority(state) {
        console.log("☁️ [HYDRATE] Hydrating GlobalAuthority from cloud data...");
        
        try {
            // Extract divisions and bunks from state
            let divisions = state.divisions || state.app1?.divisions || {};
            let bunks = state.bunks || state.app1?.bunks || [];
            let fields = state.fields || state.app1?.fields || [];
            
            // Also check STORAGE_KEY wrapper
            if (state[STORAGE_KEY]) {
                divisions = state[STORAGE_KEY].divisions || divisions;
                bunks = state[STORAGE_KEY].bunks || bunks;
                fields = state[STORAGE_KEY].fields || fields;
                
                // Check app1 inside STORAGE_KEY
                if (state[STORAGE_KEY].app1) {
                    divisions = state[STORAGE_KEY].app1.divisions || divisions;
                    bunks = state[STORAGE_KEY].app1.bunks || bunks;
                    fields = state[STORAGE_KEY].app1.fields || fields;
                }
            }
            
            const divCount = typeof divisions === 'object' ? Object.keys(divisions).length : 0;
            const bunkCount = Array.isArray(bunks) ? bunks.length : 0;
            const fieldCount = Array.isArray(fields) ? fields.length : 0;
            
            console.log(`☁️ [HYDRATE] Found: ${divCount} divisions, ${bunkCount} bunks, ${fieldCount} fields`);
            
            // Hydrate GlobalAuthority if available
            if (window.GlobalAuthority) {
                if (divCount > 0 && typeof window.GlobalAuthority.setDivisions === 'function') {
                    window.GlobalAuthority.setDivisions(divisions);
                    console.log("☁️ [HYDRATE] ✅ Set divisions in GlobalAuthority");
                }
                if (bunkCount > 0 && typeof window.GlobalAuthority.setBunks === 'function') {
                    window.GlobalAuthority.setBunks(bunks);
                    console.log("☁️ [HYDRATE] ✅ Set bunks in GlobalAuthority");
                }
                if (fieldCount > 0 && typeof window.GlobalAuthority.setFields === 'function') {
                    window.GlobalAuthority.setFields(fields);
                    console.log("☁️ [HYDRATE] ✅ Set fields in GlobalAuthority");
                }
                
                // Trigger reload if available
                if (typeof window.GlobalAuthority.reload === 'function') {
                    window.GlobalAuthority.reload();
                }
            }
            
            // Also set on window directly for legacy compatibility
            if (divCount > 0) {
                window.divisions = divisions;
            }
            if (bunkCount > 0) {
                window.bunks = bunks;
            }
            if (fieldCount > 0) {
                window.fields = fields;
            }
            
            // Dispatch event for UI refresh
            window.dispatchEvent(new CustomEvent('campistry-data-hydrated', {
                detail: { divisions: divCount, bunks: bunkCount, fields: fieldCount }
            }));
            
        } catch (e) {
            console.error("☁️ [HYDRATE] Error hydrating GlobalAuthority:", e);
        }
    }

    // =========================================================================
    // MIGRATE LEGACY ROOT DATA
    // =========================================================================
    
    function migrateLegacyCloudData(cloudData, dateKey) {
        if (!cloudData) return cloudData;
        
        const scheduleKeys = ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 'manualSkeleton', 'skeleton'];
        
        let needsMigration = false;
        
        for (const key of scheduleKeys) {
            if (cloudData[key] !== undefined) {
                needsMigration = true;
                break;
            }
        }
        
        const rootKeys = Object.keys(cloudData);
        const hasFlatBunks = rootKeys.some(key => {
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
        
        if (!cloudData[dateKey]) {
            cloudData[dateKey] = {};
        }
        
        for (const key of scheduleKeys) {
            if (cloudData[key] !== undefined) {
                if (!cloudData[dateKey][key]) {
                    console.log(`☁️ [MIGRATE] Moving ROOT "${key}" to date ${dateKey}`);
                    cloudData[dateKey][key] = cloudData[key];
                }
                delete cloudData[key];
            }
        }
        
        if (hasFlatBunks) {
            const migratedAssignments = {};
            const keysToDelete = [];
            
            for (const key of rootKeys) {
                if (Array.isArray(cloudData[key]) && 
                    !['unifiedTimes', 'skeleton', 'manualSkeleton'].includes(key) &&
                    !key.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    
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
        // ★★★ HYDRATE GLOBAL AUTHORITY FIRST ★★★
        hydrateGlobalAuthority(state);
        
        if (state.daily_schedules) {
            if (!_dailyDataDirty && !_localDataProtected) {
                console.log("☁️ [SYNC] Unbundling daily schedules from cloud...");
                
                try {
                    const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                    
                    let cloudDailyData = migrateLegacyCloudData(state.daily_schedules, dateKey);
                    
                    let localDailyData = {};
                    try {
                        const raw = localStorage.getItem(DAILY_DATA_KEY);
                        if (raw) localDailyData = JSON.parse(raw);
                    } catch (e) { /* ignore */ }
                    
                    const merged = mergeCloudWithLocal(cloudDailyData, localDailyData, dateKey);
                    
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(merged));
                    
                    setTimeout(() => {
                        console.log("🔥 Dispatching UI refresh for new schedule data...");
                        window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
                        if (typeof window.initScheduleSystem === 'function') window.initScheduleSystem();
                        if (typeof window.updateTable === 'function') window.updateTable();
                    }, 50);
                    
                } catch (e) {
                    console.error("☁️ Failed to unbundle daily schedules:", e);
                }
            } else {
                console.log("☁️ [SYNC] Skipping daily overwrite - Local data protected or dirty");
            }
            delete state.daily_schedules;
        }
        
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
        
        for (const key of Object.keys(cloudData)) {
            if (key.match(/^\d{4}-\d{2}-\d{2}$/)) {
                if (!merged[key]) {
                    merged[key] = cloudData[key];
                } else {
                    merged[key] = {
                        ...merged[key],
                        ...cloudData[key],
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
        if (!campId) {
            console.warn("☁️ Cannot load - no camp ID yet");
            return null;
        }
        
        console.log("☁️ Loading from cloud for camp:", campId);
        
        try {
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
                console.log("☁️ ✅ Loaded settings from cloud");
                setLocalCache(data.settings);
                window.__CAMPISTRY_CLOUD_READY__ = true;
                window.dispatchEvent(new Event('campistry-cloud-hydrated'));
                return data.settings;
            }
            
            console.log("☁️ No cloud data found for this camp");
            window.__CAMPISTRY_CLOUD_READY__ = true;
            window.dispatchEvent(new Event('campistry-cloud-hydrated'));
            return null;
            
        } catch (e) {
            console.error("☁️ Load exception:", e);
            return null;
        }
    }

    // =========================================================================
    // ★★★ CRITICAL: SAVE TO CLOUD WITH FETCH-MERGE-UPDATE ★★★
    // =========================================================================
    
    async function saveToCloud(localState) {
        // Save lock to prevent parallel saves
        if (_saveLock) {
            console.log("☁️ [SAVE] Already saving, queueing...");
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
            
            let cloudDateData = cloudDailySchedules[dateKey] || {};
            let cloudAssignments = cloudDateData.scheduleAssignments || {};
            
            const cloudBunkCount = Object.keys(cloudAssignments).length;
            console.log(`☁️ [SAVE] Cloud has ${cloudBunkCount} bunks for ${dateKey}`);
            
            let mergedAssignments;
            
            if (isOwner) {
                console.log("☁️ [SAVE] Owner mode - full save");
                mergedAssignments = localAssignments;
                
            } else {
                console.log("☁️ [SAVE] Scheduler mode - merge with cloud");
                
                // Start with cloud's assignments
                mergedAssignments = { ...cloudAssignments };
                
                // CRITICAL FIX: First REMOVE all cloud bunks that belong to MY divisions
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
            
            const mergedDateData = {
                ...cloudDateData,
                ...localDateData,
                scheduleAssignments: mergedAssignments,
                subdivisionSchedules: {
                    ...(cloudDateData.subdivisionSchedules || {}),
                    ...(localDateData.subdivisionSchedules || {})
                }
            };
            
            const finalDailySchedules = {
                ...cloudDailySchedules,
                [dateKey]: mergedDateData
            };
            
            const stateToSave = { ...cloudState };
            
            for (const [key, value] of Object.entries(localState || {})) {
                if (key !== 'daily_schedules') {
                    stateToSave[key] = value;
                }
            }
            
            stateToSave.daily_schedules = finalDailySchedules;
            stateToSave.updated_at = new Date().toISOString();
            
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
            
            // Release lock and process pending
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
    // FETCH SCHEDULE FROM CLOUD (for multi-scheduler)
    // =========================================================================
    
    async function fetchScheduleFromCloud(dateKey) {
        const campId = await getCampId();
        if (!campId) {
            console.log(`☁️ [FETCH] No camp ID available`);
            return null;
        }
        
        console.log(`☁️ [FETCH] Getting schedule for ${dateKey} from cloud...`);
        
        try {
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
        } catch (e) {
            console.error("☁️ [FETCH] Exception:", e);
            return null;
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
        
        let localDailyData = {};
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) localDailyData = JSON.parse(raw);
        } catch (e) { /* ignore */ }
        
        for (const key of keys) {
            if (key === 'daily_schedules') {
                if (isOwner) {
                    localDailyData = {};
                } else {
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
                delete localDailyData[dateKey][key];
            }
        }
        
        localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(localDailyData));
        
        await forceSyncToCloud();
    }

    // =========================================================================
    // RESET CLOUD STATE (for Erase All)
    // =========================================================================
    
    async function resetCloudState() {
        console.log("☁️ [RESET] Resetting cloud state...");
        
        const campId = await getCampId();
        if (!campId) return false;
        
        localStorage.removeItem(DAILY_DATA_KEY);
        localStorage.removeItem(STORAGE_KEY);
        
        const emptyState = {
            daily_schedules: {},
            [STORAGE_KEY]: {}
        };
        
        try {
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
        } catch (e) {
            console.error("☁️ [RESET] Exception:", e);
            return false;
        }
    }

    // =========================================================================
    // FORCE SYNC (Debounced)
    // =========================================================================
    
    async function forceSyncToCloud() {
        clearTimeout(_syncTimeout);
        
        return new Promise((resolve) => {
            _syncTimeout = setTimeout(async () => {
                console.log("☁️ [FORCE SYNC] Starting...");
                
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
    // INITIALIZATION - SAFE, NON-CRASHING
    // =========================================================================
    
    async function initialize() {
        try {
            if (!window.supabase) {
                console.warn("☁️ Supabase not available, waiting...");
                setTimeout(initialize, 500);
                return;
            }
            
            setupAutoSave();
            
            // Check if AccessControl is ready using our safe helper
            const acReady = isAccessControlReady();
            
            if (!acReady && _initRetries < MAX_INIT_RETRIES) {
                _initRetries++;
                console.log(`☁️ Waiting for AccessControl (${_initRetries}/${MAX_INIT_RETRIES})...`);
                setTimeout(initialize, 250);
                return;
            }
            
            // Try to load from cloud
            const success = await loadFromCloud();
            
            if (!success && _initRetries < MAX_INIT_RETRIES) {
                _initRetries++;
                console.log(`☁️ Load failed, retry ${_initRetries}/${MAX_INIT_RETRIES}...`);
                setTimeout(initialize, 500);
                return;
            }
            
            if (!success) {
                console.warn("☁️ Could not load from cloud, proceeding with local data");
                window.__CAMPISTRY_CLOUD_READY__ = true;
                window.dispatchEvent(new Event('campistry-cloud-hydrated'));
            }
            
            console.log("☁️ Cloud bridge initialization complete");
            
        } catch (e) {
            console.error("☁️ Initialization error:", e);
            // Don't crash - fire hydration event anyway
            window.__CAMPISTRY_CLOUD_READY__ = true;
            window.dispatchEvent(new Event('campistry-cloud-hydrated'));
        }
    }
    
    // Listen for RBAC ready event
    window.addEventListener('campistry-rbac-ready', async () => {
        console.log("☁️ RBAC ready event received, reloading cloud data...");
        
        try {
            // Clear cached camp ID to force refresh from AccessControl
            _campId = null;
            
            const campId = await getCampId();
            if (campId) {
                await loadFromCloud();
            }
        } catch (e) {
            console.error("☁️ Error handling RBAC ready:", e);
        }
    });

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.loadFromCloud = loadFromCloud;
    window.saveToCloud = saveToCloud;
    window.forceSyncToCloud = forceSyncToCloud;
    window.clearCloudKeys = clearCloudKeys;
    window.resetCloudState = resetCloudState;
    window.getCampId = getCampId;
    window.fetchScheduleFromCloud = fetchScheduleFromCloud;
    window.hydrateGlobalAuthority = hydrateGlobalAuthority;
    
    // Start initialization
    if (document.readyState === 'complete') {
        setTimeout(initialize, 100);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 100));
    }

})();
