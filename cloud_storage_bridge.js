// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// VERSION: v4.0 (SIMPLIFIED MULTI-SCHEDULER)
// =================================================================
// 
// ARCHITECTURE:
// - Each scheduler works ONLY on their divisions (others don't exist)
// - Save is SIMPLE: Add my bunks to cloud, preserve others
// - No complex merge logic - just append!
// - Field conflicts prevented by GlobalFieldLocks.loadFromCloud()
//
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v4.0 (SIMPLIFIED MULTI-SCHEDULER)");

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
  // ★★★ HELPER: GET MY BUNKS ★★★
  // ============================================================================
  
  function getMyBunks() {
      const myBunks = new Set();
      
      // Get my divisions
      let myDivisions = [];
      
      if (window.AccessControl?.getEditableDivisions) {
          myDivisions = window.AccessControl.getEditableDivisions() || [];
      }
      if (myDivisions.length === 0 && window.AccessControl?.getUserDivisions) {
          myDivisions = window.AccessControl.getUserDivisions() || [];
      }
      if (myDivisions.length === 0 && window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
          myDivisions = window.SubdivisionScheduleManager.getDivisionsToSchedule() || [];
      }
      if (myDivisions.length === 0 && window._campistryMembership?.assigned_divisions) {
          myDivisions = window._campistryMembership.assigned_divisions;
      }
      
      // Owner/Admin: null means ALL bunks
      const role = window.AccessControl?.getCurrentRole?.() || _userRole;
      if (!_isTeamMember || role === 'owner' || role === 'admin') {
          return null; // null = all bunks (no filtering)
      }
      
      if (myDivisions.length === 0) {
          console.warn('☁️ [SAVE] No divisions assigned - cannot determine bunks');
          return new Set(); // Empty = can't save anything
      }
      
      // Get bunks for my divisions
      const divisions = window.divisions || {};
      for (const divId of myDivisions) {
          const divInfo = divisions[divId] || divisions[String(divId)];
          if (divInfo && divInfo.bunks) {
              divInfo.bunks.forEach(b => myBunks.add(String(b)));
          }
      }
      
      console.log(`☁️ [SAVE] My divisions: [${myDivisions.join(', ')}] → ${myBunks.size} bunks`);
      return myBunks;
  }

  // ============================================================================
  // ★★★ SIMPLIFIED SAVE TO CLOUD ★★★
  // Just add my bunks, preserve others - no complex merge!
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

      // Prepare base state
      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;

      // =====================================================================
      // ★★★ SIMPLE SAVE LOGIC ★★★
      // =====================================================================
      try {
        const schedulesRaw = localStorage.getItem(DAILY_DATA_KEY);
        if (schedulesRaw) {
            const localSchedules = JSON.parse(schedulesRaw);
            const myBunks = getMyBunks();
            
            // OWNER MODE: Just use local data directly
            if (myBunks === null) {
                console.log('☁️ [SAVE] Owner mode - saving all local data');
                stateToSave.daily_schedules = localSchedules;
            } 
            // TEAM MEMBER MODE: Add my bunks to cloud, preserve others
            else if (myBunks.size > 0) {
                console.log('☁️ [SAVE] Team member mode - merging my bunks with cloud');
                
                // 1. Load current cloud state
                const cloudState = await loadFromCloud();
                const cloudSchedules = cloudState?.daily_schedules || {};
                
                // 2. Start with cloud data (preserves other schedulers' work)
                const merged = JSON.parse(JSON.stringify(cloudSchedules));
                
                // 3. Add/update MY bunks only
                for (const [dateKey, dateData] of Object.entries(localSchedules)) {
                    // Ensure date entry exists with proper structure
                    if (!merged[dateKey]) {
                        merged[dateKey] = { scheduleAssignments: {} };
                    }
                    
                    // Handle case where cloud data might be in direct format (no scheduleAssignments wrapper)
                    // Convert to nested format if needed
                    if (!merged[dateKey].scheduleAssignments) {
                        // Cloud data is in direct format - wrap it
                        const existingData = { ...merged[dateKey] };
                        merged[dateKey] = { scheduleAssignments: existingData };
                    }
                    
                    // Get assignments from local data (handle both formats)
                    const localAssignments = dateData.scheduleAssignments || dateData;
                    
                    // Only add MY bunks
                    for (const [bunkName, schedule] of Object.entries(localAssignments)) {
                        // Skip non-bunk properties
                        if (bunkName === 'scheduleAssignments' || bunkName === 'leagueAssignments' || bunkName === 'unifiedTimes') {
                            continue;
                        }
                        if (myBunks.has(String(bunkName))) {
                            merged[dateKey].scheduleAssignments[bunkName] = schedule;
                        }
                    }
                    
                    // Copy other metadata (leagueAssignments, etc.)
                    if (dateData.leagueAssignments) {
                        if (!merged[dateKey].leagueAssignments) {
                            merged[dateKey].leagueAssignments = {};
                        }
                        // Only copy league assignments for my divisions
                        const myDivisions = window.AccessControl?.getEditableDivisions?.() || 
                                          window.SubdivisionScheduleManager?.getDivisionsToSchedule?.() || [];
                        for (const [divName, leagueData] of Object.entries(dateData.leagueAssignments)) {
                            if (myDivisions.includes(divName)) {
                                merged[dateKey].leagueAssignments[divName] = leagueData;
                            }
                        }
                    }
                }
                
                // Log what we're saving
                const cloudBunkCount = Object.keys(cloudSchedules).reduce((sum, date) => {
                    const assignments = cloudSchedules[date]?.scheduleAssignments || cloudSchedules[date] || {};
                    return sum + Object.keys(assignments).length;
                }, 0);
                
                const mergedBunkCount = Object.keys(merged).reduce((sum, date) => {
                    const assignments = merged[date]?.scheduleAssignments || merged[date] || {};
                    return sum + Object.keys(assignments).length;
                }, 0);
                
                console.log(`☁️ [SAVE] Cloud had ${cloudBunkCount} bunks → Now ${mergedBunkCount} bunks`);
                
                stateToSave.daily_schedules = merged;
            } else {
                console.warn('☁️ [SAVE] No bunks to save - aborting');
                showToast("❌ No permissions", "error");
                return false;
            }
        }
      } catch(e) { 
          console.error("☁️ [SAVE] Bundle error:", e);
      }

      const ownerId = campId;

      // TRY PATCH FIRST
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
              console.log("☁️ [SAVE] ✅ Success");
              showToast("✅ Schedule Saved!", "success");
              _dailyDataDirty = false;
              
              // Dispatch event so UI can refresh from cloud
              window.dispatchEvent(new CustomEvent('campistry-cloud-saved'));
              
              return true;
          }
      }

      // IF PATCH FAILED -> POST (only for owners)
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
            console.log("☁️ [SAVE] ✅ Created new record");
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
  // RESET & IMPORT
  // ============================================================================
  window.resetCloudState = async function() {
    if (_isTeamMember) {
        showToast("❌ Only camp owners can reset data", "error");
        return false;
    }
    
    const emptyState = {
      divisions: {}, bunks: [], app1: { divisions: {}, bunks: [], fields: [], specialActivities: [] },
      updated_at: new Date().toISOString()
    };
    localStorage.removeItem(DAILY_DATA_KEY);
    setLocalCache(emptyState);
    return await saveToCloud(emptyState);
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
  window.loadFromCloud = loadFromCloud; // Expose for GlobalFieldLocks
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
