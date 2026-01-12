// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// VERSION: v4.1 (UNIVERSAL ADDITIVE MERGE)
// =================================================================
// 
// ARCHITECTURE:
// - EVERY save (Owner AND Scheduler) uses additive merge
// - Always FETCH cloud first, then ADD local changes on top
// - Never DELETE keys from cloud - only UPDATE/ADD
// - No more "Owner Mode" destructive overwrite!
//
// v4.1 CHANGES:
// - Removed destructive "Owner Mode" that wiped other schedulers' work
// - All saves now use safe additive merge pattern
// - Fetch → Base from Cloud → Merge Local → Save
//
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v4.1 (UNIVERSAL ADDITIVE MERGE)");

  // CONFIGURATION
  const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
  const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
    
  const TABLE = "camp_state";
  const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
  const DAILY_DATA_KEY = "campDailyData_v1"; 

  const LEGACY_KEYS = {
    globalSettings: "campGlobalSettings_v1",
    localCache: "CAMPISTRY_LOCAL_CACHE", 
    globalRegistry: "campistry_global_registry"
  };

  // ============================================================================
  // UI FEEDBACK
  // ============================================================================
  function showToast(message, type = 'info') {
      let toast = document.getElementById('cloud-toast');
      if (!toast) {
          toast = document.createElement('div');
          toast.id = 'cloud-toast';
          toast.style.cssText = `
              position: fixed; bottom: 20px; right: 20px;
              padding: 12px 24px; border-radius: 8px; color: white;
              font-family: sans-serif; font-size: 14px; z-index: 9999;
              box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: opacity 0.3s;
          `;
          document.body.appendChild(toast);
      }
      
      if (type === 'success') toast.style.backgroundColor = '#10B981';
      else if (type === 'error') toast.style.backgroundColor = '#EF4444';
      else toast.style.backgroundColor = '#3B82F6';

      toast.textContent = message;
      toast.style.opacity = '1';
      
      if (window._toastTimer) clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => {
          toast.style.opacity = '0';
      }, 3000);
  }

  // ============================================================================
  // CAMP ID MANAGEMENT
  // ============================================================================
  let _cachedCampId = null;
  let _userRole = null;
  let _isTeamMember = false;

  function getCampId() {
    if (_cachedCampId) return _cachedCampId;
    
    const cachedUserId = localStorage.getItem('campistry_user_id');
    if (cachedUserId && cachedUserId !== 'demo_camp_001') {
      _cachedCampId = cachedUserId;
      return _cachedCampId;
    }
    
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const storedSession = localStorage.getItem(key);
          if (storedSession) {
            const parsed = JSON.parse(storedSession);
            if (parsed?.user?.id) {
              return parsed.user.id;
            }
          }
        }
      }
    } catch (e) { console.warn("Error reading storage:", e); }
    
    return "demo_camp_001";
  }

  async function determineUserCampId(userId) {
    if (!userId) return null;
    
    console.log("☁️ Determining camp ID for user:", userId);
    
    try {
      const { data: ownedCamp, error: ownedError } = await window.supabase
        .from('camps')
        .select('owner')
        .eq('owner', userId)
        .maybeSingle();
      
      if (ownedCamp && !ownedError) {
        console.log("☁️ User is a camp owner");
        _isTeamMember = false;
        _userRole = 'owner';
        return userId; 
      }
    } catch (e) {
      console.warn("☁️ Error checking camp ownership:", e);
    }
    
    try {
      const { data: membership, error: memberError } = await window.supabase
        .from('camp_users')
        .select('camp_id, role, subdivision_ids, accepted_at')
        .eq('user_id', userId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      
      if (membership && !memberError) {
        console.log("☁️ User is a team member:", {
          campId: membership.camp_id,
          role: membership.role
        });
        _isTeamMember = true;
        _userRole = membership.role;
        window._campistryMembership = membership;
        return membership.camp_id;
      }
    } catch (e) {
      console.warn("☁️ Error checking team membership:", e);
    }
    
    console.log("☁️ User is a new camp owner (first time)");
    _isTeamMember = false;
    _userRole = 'owner';
    return userId;
  }

  async function updateCampIdCache(userId) {
    if (!userId) return;
    const campId = await determineUserCampId(userId);
    if (campId) {
      _cachedCampId = campId;
      localStorage.setItem('campistry_user_id', campId);
      localStorage.setItem('campistry_auth_user_id', userId);
      console.log("☁️ Camp ID cached:", campId, _isTeamMember ? "(team member)" : "(owner)");
    }
  }

  function clearCampIdCache() {
    _cachedCampId = null;
    _userRole = null;
    _isTeamMember = false;
    localStorage.removeItem('campistry_user_id');
    localStorage.removeItem('campistry_auth_user_id');
    delete window._campistryMembership;
  }

  function getUserRole() { return _userRole; }
  function isTeamMember() { return _isTeamMember; }

  // ============================================================================
  // LOCAL CACHE
  // ============================================================================
  let _memoryCache = null;
  let _cloudSyncPending = false;
  let _syncInProgress = false;
  let _syncTimeout = null;
  let _dailyDataDirty = false;
  let _initialized = false;
  const SCHEMA_VERSION = 2;

  function getLocalCache() {
    if (_memoryCache !== null) return _memoryCache;
    try {
      const raw = localStorage.getItem(UNIFIED_CACHE_KEY);
      _memoryCache = raw ? JSON.parse(raw) : {};
    } catch (e) { _memoryCache = {}; }
    return _memoryCache;
  }
    
  function setLocalCache(state) {
    if (state.daily_schedules) {
        if (!_dailyDataDirty) {
            console.log("☁️ [SYNC] Unbundling daily schedules from cloud...");
            try {
                const currentRaw = localStorage.getItem(DAILY_DATA_KEY);
                const newRaw = JSON.stringify(state.daily_schedules);
                
                if (currentRaw !== newRaw) {
                    localStorage.setItem(DAILY_DATA_KEY, newRaw);
                    setTimeout(() => {
                        console.log("🔥 Dispatching UI refresh for new schedule data...");
                        window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
                        if (window.initScheduleSystem) window.initScheduleSystem();
                        if (window.updateTable) window.updateTable();
                    }, 50);
                }
            } catch(e) { console.error("Failed to save extracted schedules", e); }
        } else {
            console.log("☁️ [SYNC] Skipping daily schedule overwrite - Local changes pending upload.");
        }
        delete state.daily_schedules; 
    }

    _memoryCache = state;
    try {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(state));
      localStorage.setItem(LEGACY_KEYS.globalSettings, JSON.stringify(state));
      localStorage.setItem(LEGACY_KEYS.localCache, JSON.stringify(state));
      localStorage.setItem(LEGACY_KEYS.globalRegistry, JSON.stringify({
        divisions: state.divisions || {},
        bunks: state.bunks || []
      }));
    } catch (e) { console.error("Failed to save local cache:", e); }
  }

  // ============================================================================
  // DIRECT REST API OPERATIONS
  // ============================================================================
  async function getSessionToken() {
    try {
        const { data } = await window.supabase.auth.getSession();
        return data.session?.access_token || null;
    } catch (e) { return null; }
  }

  async function getUser() {
    const { data } = await window.supabase.auth.getUser();
    return data?.user;
  }

  async function loadFromCloud() {
    try {
      const token = await getSessionToken();
      if (!token) return null;
      const campId = getCampId();

      console.log("☁️ Loading from cloud for camp:", campId);

      const url = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}&select=state`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (!response.ok) {
          console.error("☁️ Load failed:", response.status, response.statusText);
          return null;
      }
      const data = await response.json();
      return (data && data.length > 0) ? data[0].state : null;
    } catch (e) { 
        console.error("☁️ Load exception:", e);
        return null; 
    }
  }

  // ============================================================================
  // ★★★ UNIVERSAL ADDITIVE MERGE - SAVE TO CLOUD ★★★
  // 
  // CRITICAL: Everyone (Owner AND Scheduler) uses this SAME safe merge logic.
  // NO destructive overwrites allowed!
  //
  // Algorithm:
  // 1. FETCH cloud data first
  // 2. BASE = copy of cloud data (preserves everything)
  // 3. MERGE: Loop through local data, ADD/UPDATE keys (never delete)
  // 4. SAVE merged result
  // ============================================================================

  async function saveToCloud(state) {
    try {
      showToast("☁️ Saving Schedule...", "info");
      
      const user = await getUser();
      if (!user) {
          showToast("❌ Not logged in", "error");
          return false;
      }
      
      const token = await getSessionToken();
      const campId = getCampId();
      
      if (campId === "demo_camp_001") return false;

      if (_userRole === 'viewer') {
          showToast("❌ View-only access", "error");
          return false;
      }

      // =====================================================================
      // STEP 1: ALWAYS FETCH CLOUD DATA FIRST
      // This is the foundation - we NEVER start from scratch
      // =====================================================================
      console.log('☁️ [SAVE] Step 1: Fetching current cloud state...');
      const cloudState = await loadFromCloud();
      const cloudSchedules = cloudState?.daily_schedules || {};
      
      // Count what cloud has
      const cloudBunkCount = countBunksInSchedule(cloudSchedules);
      console.log(`☁️ [SAVE] Cloud currently has ${cloudBunkCount} total bunk schedules`);

      // =====================================================================
      // STEP 2: BASE OBJECT = DEEP COPY OF CLOUD DATA
      // This ensures we preserve EVERYTHING that's already there
      // =====================================================================
      console.log('☁️ [SAVE] Step 2: Creating base from cloud data (preserving all existing)...');
      const finalSchedule = JSON.parse(JSON.stringify(cloudSchedules));

      // =====================================================================
      // STEP 3: GET LOCAL DATA TO MERGE
      // =====================================================================
      console.log('☁️ [SAVE] Step 3: Loading local data to merge...');
      let localSchedules = {};
      try {
          const schedulesRaw = localStorage.getItem(DAILY_DATA_KEY);
          if (schedulesRaw) {
              localSchedules = JSON.parse(schedulesRaw);
          }
      } catch (e) {
          console.error('☁️ [SAVE] Error reading local data:', e);
      }

      const localBunkCount = countBunksInSchedule(localSchedules);
      console.log(`☁️ [SAVE] Local has ${localBunkCount} bunk schedules to merge`);

      // =====================================================================
      // STEP 4: THE MERGE LOOP - ADDITIVE ONLY, NEVER DELETE
      // For each date in local data:
      //   - Ensure date exists in finalSchedule
      //   - For each bunk: ADD or UPDATE (never delete)
      //   - For unifiedTimes: merge slots (never delete)
      //   - For other metadata: ADD or UPDATE (never delete)
      // =====================================================================
      console.log('☁️ [SAVE] Step 4: Performing ADDITIVE merge (no deletions)...');
      
      // Keys that are metadata, not bunk schedules
      const METADATA_KEYS = ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 
                            'skeleton', 'manualSkeleton', 'subdivisionSchedules'];
      
      for (const [dateKey, localDateData] of Object.entries(localSchedules)) {
          // Ensure date entry exists in finalSchedule
          if (!finalSchedule[dateKey]) {
              finalSchedule[dateKey] = {};
          }
          
          // Normalize structure: ensure scheduleAssignments wrapper exists
          normalizeScheduleStructure(finalSchedule[dateKey]);
          
          // Get local assignments (handle both nested and flat formats)
          const localAssignments = localDateData.scheduleAssignments || localDateData;
          
          // ★★★ MERGE BUNK SCHEDULES - ADD/UPDATE ONLY ★★★
          for (const [key, value] of Object.entries(localAssignments)) {
              // Skip metadata keys - handle them separately
              if (METADATA_KEYS.includes(key)) continue;
              
              // This is a bunk schedule - ADD or UPDATE it
              finalSchedule[dateKey].scheduleAssignments[key] = value;
          }
          
          // ★★★ MERGE UNIFIED TIMES - ADD/UPDATE SLOTS ONLY ★★★
          if (localDateData.unifiedTimes) {
              if (!finalSchedule[dateKey].unifiedTimes) {
                  finalSchedule[dateKey].unifiedTimes = {};
              }
              // Merge each time slot (preserves slots from other schedulers)
              for (const [slotKey, slotData] of Object.entries(localDateData.unifiedTimes)) {
                  finalSchedule[dateKey].unifiedTimes[slotKey] = slotData;
              }
          }
          
          // ★★★ MERGE SKELETON - UPDATE ONLY (shared resource) ★★★
          if (localDateData.skeleton) {
              finalSchedule[dateKey].skeleton = localDateData.skeleton;
          }
          if (localDateData.manualSkeleton) {
              finalSchedule[dateKey].manualSkeleton = localDateData.manualSkeleton;
          }
          
          // ★★★ MERGE LEAGUE ASSIGNMENTS - ADD/UPDATE PER DIVISION ★★★
          if (localDateData.leagueAssignments) {
              if (!finalSchedule[dateKey].leagueAssignments) {
                  finalSchedule[dateKey].leagueAssignments = {};
              }
              for (const [divName, leagueData] of Object.entries(localDateData.leagueAssignments)) {
                  finalSchedule[dateKey].leagueAssignments[divName] = leagueData;
              }
          }
          
          // ★★★ MERGE SUBDIVISION SCHEDULES - ADD/UPDATE PER SUBDIVISION ★★★
          if (localDateData.subdivisionSchedules) {
              if (!finalSchedule[dateKey].subdivisionSchedules) {
                  finalSchedule[dateKey].subdivisionSchedules = {};
              }
              for (const [subId, subData] of Object.entries(localDateData.subdivisionSchedules)) {
                  finalSchedule[dateKey].subdivisionSchedules[subId] = subData;
              }
          }
      }

      // Count final result
      const finalBunkCount = countBunksInSchedule(finalSchedule);
      console.log(`☁️ [SAVE] ✅ Merge complete: Cloud had ${cloudBunkCount} → Now ${finalBunkCount} bunks`);
      
      // Sanity check: we should never LOSE bunks with additive merge
      if (finalBunkCount < cloudBunkCount) {
          console.warn(`☁️ [SAVE] ⚠️ WARNING: Bunk count decreased! This should not happen with additive merge.`);
      }

      // =====================================================================
      // STEP 5: BUILD FINAL STATE TO SAVE
      // =====================================================================
      const stateToSave = { ...(cloudState || state) };
      stateToSave.daily_schedules = finalSchedule;
      stateToSave.schema_version = SCHEMA_VERSION;
      stateToSave.updated_at = new Date().toISOString();
      delete stateToSave._importTimestamp;

      // =====================================================================
      // STEP 6: SAVE TO CLOUD
      // =====================================================================
      console.log('☁️ [SAVE] Step 5: Saving merged data to cloud...');
      
      const ownerId = campId;

      // TRY PATCH FIRST (update existing record)
      const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
      const patchResponse = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ 
            state: stateToSave,
            owner_id: ownerId 
        })
      });

      if (patchResponse.ok) {
          const patchedData = await patchResponse.json();
          if (patchedData && patchedData.length > 0) {
              console.log("☁️ [SAVE] ✅ Success (PATCH)");
              showToast("✅ Schedule Saved!", "success");
              _dailyDataDirty = false;
              
              // Dispatch event so UI can refresh
              window.dispatchEvent(new CustomEvent('campistry-cloud-saved'));
              
              return true;
          }
      }

      // IF PATCH FAILED -> POST (create new record, only for owners)
      if (!_isTeamMember) {
          const postUrl = `${SUPABASE_URL}/rest/v1/${TABLE}`;
          const postResponse = await fetch(postUrl, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
              camp_id: campId,
              owner_id: ownerId,
              state: stateToSave
            })
          });

          if (postResponse.ok) {
            console.log("☁️ [SAVE] ✅ Success (POST - new record)");
            showToast("✅ Schedule Saved!", "success");
            _dailyDataDirty = false;
            return true;
          } else {
            console.error("Save Failed:", postResponse.status);
            showToast("❌ Save Failed", "error");
            return false;
          }
      } else {
          console.error("Team member cannot create new camp state");
          showToast("❌ Camp data not found", "error");
          return false;
      }

    } catch (e) {
      console.error("Save Error:", e);
      showToast("❌ Network Error", "error");
      return false;
    }
  }

  // ============================================================================
  // HELPER: Count bunks in a schedule object
  // ============================================================================
  function countBunksInSchedule(schedules) {
      const METADATA_KEYS = ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 
                            'skeleton', 'manualSkeleton', 'subdivisionSchedules'];
      
      return Object.keys(schedules).reduce((sum, date) => {
          const dateData = schedules[date] || {};
          const assignments = dateData.scheduleAssignments || dateData;
          return sum + Object.keys(assignments).filter(k => !METADATA_KEYS.includes(k)).length;
      }, 0);
  }

  // ============================================================================
  // HELPER: Normalize schedule structure (ensure scheduleAssignments wrapper)
  // ============================================================================
  function normalizeScheduleStructure(dateData) {
      if (!dateData.scheduleAssignments) {
          // Data is in flat format - convert to nested
          const METADATA_KEYS = ['leagueAssignments', 'unifiedTimes', 
                                'skeleton', 'manualSkeleton', 'subdivisionSchedules'];
          
          const existingData = { ...dateData };
          const bunkData = {};
          const metadata = {};
          
          for (const [key, value] of Object.entries(existingData)) {
              if (METADATA_KEYS.includes(key)) {
                  metadata[key] = value;
              } else {
                  bunkData[key] = value;
              }
          }
          
          // Clear and rebuild
          Object.keys(dateData).forEach(k => delete dateData[k]);
          dateData.scheduleAssignments = bunkData;
          Object.assign(dateData, metadata);
      }
  }

  // ============================================================================
  // ★★★ LOAD COMBINED VIEW FROM CLOUD ★★★
  // After any scheduler saves, UI can call this to get ALL data
  // ============================================================================
  
  window.loadCombinedScheduleFromCloud = async function() {
      console.log('☁️ Loading combined schedule from cloud...');
      
      const cloudState = await loadFromCloud();
      if (!cloudState) {
          console.log('☁️ No cloud data found');
          return null;
      }
      
      const cloudSchedules = cloudState.daily_schedules || {};
      const today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
      const todayData = cloudSchedules[today];
      
      if (!todayData) {
          console.log('☁️ No schedule data for today');
          return null;
      }
      
      // Update local storage with cloud data
      const currentLocal = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
      currentLocal[today] = todayData;
      localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(currentLocal));
      
      // Update in-memory
      const assignments = todayData.scheduleAssignments || todayData;
      window.scheduleAssignments = assignments;
      
      if (todayData.leagueAssignments) {
          window.leagueAssignments = todayData.leagueAssignments;
      }
      
      // Get list of divisions that have data
      const divisionsWithData = new Set();
      const divisions = window.divisions || {};
      
      for (const bunkName of Object.keys(assignments)) {
          // Find which division this bunk belongs to
          for (const [divName, divInfo] of Object.entries(divisions)) {
              if (divInfo.bunks && divInfo.bunks.map(String).includes(String(bunkName))) {
                  divisionsWithData.add(divName);
                  break;
              }
          }
      }
      
      console.log(`☁️ Loaded ${Object.keys(assignments).length} bunks from cloud`);
      console.log(`☁️ Divisions with data: [${[...divisionsWithData].join(', ')}]`);
      
      // Update available divisions for UI
      window.availableDivisionsFromCloud = [...divisionsWithData];
      
      return {
          scheduleAssignments: assignments,
          leagueAssignments: todayData.leagueAssignments || {},
          divisionsWithData: [...divisionsWithData]
      };
  };

  // ============================================================================
  // ★★★ CLEAR CLOUD KEYS - For partial resets (New Half, etc.) ★★★
  // This is a DELIBERATE destructive operation, only for owners
  // ============================================================================
  window.clearCloudKeys = async function(keysToReset) {
    if (_isTeamMember && _userRole !== 'admin') {
        showToast("❌ Only owners/admins can clear data", "error");
        return false;
    }
    
    console.log("☁️ clearCloudKeys called for:", keysToReset);
    
    // Fetch current cloud state
    const cloudState = await loadFromCloud() || {};
    
    // Reset specified keys to empty values
    keysToReset.forEach(key => {
      if (key === 'leagueRoundState') cloudState.leagueRoundState = {};
      else if (key === 'leagueHistory') cloudState.leagueHistory = {};
      else if (key === 'specialtyLeagueHistory') cloudState.specialtyLeagueHistory = {};
      else if (key === 'daily_schedules') {
        cloudState.daily_schedules = {};
        localStorage.removeItem(DAILY_DATA_KEY);
      }
      else if (key === 'manualUsageOffsets') cloudState.manualUsageOffsets = {};
      else if (key === 'historicalCounts') cloudState.historicalCounts = {};
      else if (key === 'smartTileHistory') cloudState.smartTileHistory = {};
      else if (key === 'rotationHistory') cloudState.rotationHistory = { bunks: {}, leagues: {} };
      else {
        cloudState[key] = {};
      }
    });
    
    cloudState.updated_at = new Date().toISOString();
    
    // Update memory cache and localStorage
    _memoryCache = cloudState;
    try {
      const stateJSON = JSON.stringify(cloudState);
      localStorage.setItem(UNIFIED_CACHE_KEY, stateJSON);
      localStorage.setItem(LEGACY_KEYS.globalSettings, stateJSON);
      localStorage.setItem(LEGACY_KEYS.localCache, stateJSON);
    } catch (e) {
      console.error("☁️ Failed to update localStorage:", e);
    }
    
    // Direct save to cloud (bypass additive merge for deliberate clear)
    const token = await getSessionToken();
    const campId = getCampId();
    
    const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
    const patchResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ 
          state: cloudState,
          owner_id: campId 
      })
    });
    
    const success = patchResponse.ok;
    console.log("☁️ Partial reset result:", success ? "SUCCESS" : "FAILED");
    return success;
  };
    
  // ============================================================================
  // RESET & IMPORT
  // ============================================================================
  window.resetCloudState = async function() {
    if (_isTeamMember) {
        showToast("❌ Only camp owners can reset data", "error");
        return false;
    }
    
    const emptyState = {
      divisions: {}, bunks: [], app1: { divisions: {}, bunks: [], fields: [], specialActivities: [] },
      daily_schedules: {},
      updated_at: new Date().toISOString()
    };
    localStorage.removeItem(DAILY_DATA_KEY);
    setLocalCache(emptyState);
    
    // Direct save for reset (bypass additive merge - this is deliberate clear)
    const token = await getSessionToken();
    const campId = getCampId();
    
    const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
    const patchResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ 
          state: emptyState,
          owner_id: campId 
      })
    });
    
    return patchResponse.ok;
  };

  window.setCloudState = async function(newState) {
    if (!newState || typeof newState !== 'object') return false;
    newState.updated_at = new Date().toISOString();
    setLocalCache(newState);
    const cloudSuccess = await saveToCloud(newState);
    if (!cloudSuccess) { _cloudSyncPending = true; scheduleCloudSync(); }
    return true;
  };

  // ============================================================================
  // SYNC LOGIC & INIT
  // ============================================================================
    
  function scheduleCloudSync() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _syncTimeout = setTimeout(async () => {
      if (!_cloudSyncPending) return;
      if (_syncInProgress) { scheduleCloudSync(); return; }
      
      _syncInProgress = true;
      _cloudSyncPending = false;
      await saveToCloud(getLocalCache());
      _syncInProgress = false;
    }, 2000);
  }
    
  async function syncNow() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _cloudSyncPending = false;
    _syncInProgress = true;
    const result = await saveToCloud(getLocalCache());
    _syncInProgress = false;
    return result;
  }

  async function initialize() {
    if (_initialized) return;
    
    const user = await getUser();
    if (user) {
        await updateCampIdCache(user.id);
    }
    
    const localData = getLocalCache();
    const hasLocalData = localData && (Object.keys(localData).length > 2);

    if (hasLocalData) {
        finishInit(true);
        loadFromCloud().then(cloudState => {
            if (cloudState) {
                const localTime = localData.updated_at ? new Date(localData.updated_at).getTime() : 0;
                const cloudTime = cloudState.updated_at ? new Date(cloudState.updated_at).getTime() : 0;
                if (cloudTime > localTime) {
                    setLocalCache({ ...localData, ...cloudState });
                    showToast("☁️ Data updated from Cloud", "info");
                }
            }
        });
        return;
    }

    const cloudState = await loadFromCloud();
    if (cloudState) {
       setLocalCache(cloudState);
       finishInit(true);
    } else {
       finishInit(false);
    }
  }

  function finishInit(hasData) {
    _initialized = true;
    window.__CAMPISTRY_CLOUD_READY__ = true;
    window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
      detail: { 
        hydrated: true, 
        hasData,
        isTeamMember: _isTeamMember,
        userRole: _userRole
      }
    }));
  }

  // PUBLIC API
  window.loadGlobalSettings = () => getLocalCache();
  window.saveGlobalSettings = (key, value) => {
    if (_userRole === 'viewer') {
        console.warn("☁️ Viewer cannot save settings");
        return getLocalCache();
    }
    
    const state = getLocalCache();
    state[key] = value;
    state.updated_at = new Date().toISOString();
    setLocalCache(state);
    _cloudSyncPending = true;
    scheduleCloudSync();
    return state;
  };

  window.loadCurrentDailyData = function() {
    try {
        const raw = localStorage.getItem(DAILY_DATA_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch(e) { return {}; }
  };

  window.saveCurrentDailyData = function(key, value) {
    if (_userRole === 'viewer') {
        console.warn("Viewers cannot save daily data");
        return;
    }
    try {
        const data = window.loadCurrentDailyData();
        data[key] = value;
        localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(data));
        
        _cloudSyncPending = true;
        _dailyDataDirty = true; 
        scheduleCloudSync();
    } catch(e) { console.error("Daily Save Error:", e); }
  };

  window.syncNow = syncNow;
  window.forceSyncToCloud = syncNow;
  window.loadFromCloud = loadFromCloud;
  window.scheduleCloudSync = () => {
    _cloudSyncPending = true;
    scheduleCloudSync();
  };
   
  window.getCampistryUserRole = getUserRole;
  window.isCampistryTeamMember = isTeamMember;
  window.getCampId = getCampId;

  setTimeout(() => {
    if(window.supabase) {
        window.supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
                await updateCampIdCache(session.user.id);
                _initialized = false; 
                await initialize();
            } else if (event === 'SIGNED_OUT') {
                clearCampIdCache();
                _memoryCache = null;
            }
        });
    }
  }, 500);

  initialize();
})();
