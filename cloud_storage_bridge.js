// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// FIXED VERSION: v4.0 (Multi-Scheduler Merge Support)
// =================================================================
// KEY FIX: When saving, we now MERGE scheduleAssignments by division
// instead of overwriting. This allows multiple schedulers to work
// independently without losing each other's work.
// =================================================================

(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v4.0 (MULTI-SCHEDULER MERGE MODE)");

  // DIRECT CONFIGURATION
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
  // UI FEEDBACK (TOAST NOTIFICATIONS)
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
  // CAMP ID MANAGEMENT (MULTI-TENANT AWARE)
  // ============================================================================
  let _cachedCampId = null;
  let _userRole = null;
  let _isTeamMember = false;
  let _userDivisions = []; // ★★★ NEW: Track which divisions this user can edit

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
        _userDivisions = null; // null = ALL divisions
        return userId;
      }
    } catch (e) {
      console.warn("☁️ Error checking camp ownership:", e);
    }
    
    try {
      const { data: membership, error: memberError } = await window.supabase
        .from('camp_users')
        .select('camp_id, role, subdivision_ids, assigned_divisions, accepted_at')
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
        
        // ★★★ Determine which divisions this user can edit
        await determineUserDivisions(membership);
        
        window._campistryMembership = membership;
        
        return membership.camp_id;
      }
    } catch (e) {
      console.warn("☁️ Error checking team membership:", e);
    }
    
    console.log("☁️ User is a new camp owner (first time)");
    _isTeamMember = false;
    _userRole = 'owner';
    _userDivisions = null; // null = ALL
    return userId;
  }

  /**
   * ★★★ NEW: Determine which divisions the user can edit ★★★
   */
  async function determineUserDivisions(membership) {
    _userDivisions = [];
    
    if (_userRole === 'owner' || _userRole === 'admin') {
      _userDivisions = null; // null means ALL
      return;
    }
    
    if (_userRole === 'viewer') {
      _userDivisions = []; // empty = NONE
      return;
    }
    
    // Scheduler - get divisions from subdivisions
    const subdivisionIds = membership.subdivision_ids || [];
    const directAssignments = membership.assigned_divisions || [];
    
    if (directAssignments.length > 0) {
      _userDivisions = [...directAssignments];
      console.log("☁️ User divisions (direct):", _userDivisions);
      return;
    }
    
    if (subdivisionIds.length > 0) {
      try {
        const { data: subdivisions } = await window.supabase
          .from('subdivisions')
          .select('divisions')
          .in('id', subdivisionIds);
        
        if (subdivisions) {
          subdivisions.forEach(sub => {
            if (sub.divisions) {
              _userDivisions.push(...sub.divisions);
            }
          });
        }
      } catch (e) {
        console.warn("☁️ Error loading subdivision divisions:", e);
      }
    }
    
    console.log("☁️ User divisions (from subdivisions):", _userDivisions);
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
    _userDivisions = [];
    localStorage.removeItem('campistry_user_id');
    localStorage.removeItem('campistry_auth_user_id');
    delete window._campistryMembership;
  }

  function getUserRole() {
    return _userRole;
  }

  function isTeamMember() {
    return _isTeamMember;
  }
  
  /**
   * ★★★ NEW: Get divisions the current user can edit ★★★
   */
  function getUserDivisions() {
    return _userDivisions; // null = ALL, [] = NONE, [...] = specific list
  }

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
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) return null;
      const data = await response.json();
      return (data && data.length > 0) ? data[0].state : null;
    } catch (e) { return null; }
  }

  // ============================================================================
  // ★★★ CRITICAL FIX: MERGE SCHEDULE ASSIGNMENTS BY DIVISION ★★★
  // ============================================================================
  
  /**
   * Merge local scheduleAssignments with cloud version
   * Only overwrites bunks that belong to user's divisions
   */
  function mergeScheduleAssignments(cloudAssignments, localAssignments, userDivisions) {
    // If user has access to ALL divisions, just return local (they are the authority)
    if (userDivisions === null) {
      console.log("☁️ [MERGE] User has full access - using local assignments");
      return localAssignments;
    }
    
    // If user has NO divisions, return cloud (they can't change anything)
    if (!userDivisions || userDivisions.length === 0) {
      console.log("☁️ [MERGE] User has no edit access - keeping cloud assignments");
      return cloudAssignments || {};
    }
    
    // Get division -> bunks mapping
    const divisions = window.divisions || {};
    const userBunks = new Set();
    
    userDivisions.forEach(divName => {
      const divInfo = divisions[divName];
      if (divInfo?.bunks) {
        divInfo.bunks.forEach(b => userBunks.add(b));
      }
    });
    
    console.log(`☁️ [MERGE] User can edit ${userBunks.size} bunks in ${userDivisions.length} divisions`);
    
    // Start with cloud version as base
    const merged = JSON.parse(JSON.stringify(cloudAssignments || {}));
    
    // Overwrite ONLY user's bunks with local data
    for (const [bunkName, slots] of Object.entries(localAssignments || {})) {
      if (userBunks.has(bunkName)) {
        merged[bunkName] = slots;
        // console.log(`☁️ [MERGE] Applied local changes for ${bunkName}`);
      }
    }
    
    console.log(`☁️ [MERGE] Complete: ${Object.keys(merged).length} bunks in merged result`);
    
    return merged;
  }
  
  /**
   * Merge daily data with proper division-aware merging
   */
  async function mergeDailyDataForSave(localDailyData) {
    // Load current cloud state
    const cloudState = await loadFromCloud();
    const cloudDaily = cloudState?.daily_schedules || {};
    
    const merged = JSON.parse(JSON.stringify(cloudDaily));
    
    for (const [dateKey, dateData] of Object.entries(localDailyData || {})) {
      if (!merged[dateKey]) {
        merged[dateKey] = {};
      }
      
      // Merge scheduleAssignments with division awareness
      if (dateData.scheduleAssignments) {
        merged[dateKey].scheduleAssignments = mergeScheduleAssignments(
          merged[dateKey].scheduleAssignments || {},
          dateData.scheduleAssignments,
          _userDivisions
        );
      }
      
      // Merge subdivisionSchedules (each user manages their own)
      if (dateData.subdivisionSchedules) {
        if (!merged[dateKey].subdivisionSchedules) {
          merged[dateKey].subdivisionSchedules = {};
        }
        
        // Only update subdivisions the user owns
        const mySubIds = window.SubdivisionScheduleManager?.getEditableSubdivisions?.()
          .map(s => s.id) || [];
        
        for (const [subId, subData] of Object.entries(dateData.subdivisionSchedules)) {
          // Owner can update any, schedulers only their own
          if (_userRole === 'owner' || _userRole === 'admin' || mySubIds.includes(subId)) {
            merged[dateKey].subdivisionSchedules[subId] = subData;
          }
        }
      }
      
      // Copy other date-level data (overrides, settings, etc.)
      for (const [key, value] of Object.entries(dateData)) {
        if (key !== 'scheduleAssignments' && key !== 'subdivisionSchedules') {
          // For user-specific overrides like bunkActivityOverrides, merge by bunk ownership
          if (key === 'bunkActivityOverrides' && _userDivisions !== null) {
            merged[dateKey][key] = mergeOverridesByBunk(
              merged[dateKey][key] || [],
              value,
              _userDivisions
            );
          } else {
            merged[dateKey][key] = value;
          }
        }
      }
    }
    
    return merged;
  }
  
  /**
   * Merge bunk activity overrides by division ownership
   */
  function mergeOverridesByBunk(cloudOverrides, localOverrides, userDivisions) {
    if (userDivisions === null) return localOverrides;
    if (!userDivisions || userDivisions.length === 0) return cloudOverrides;
    
    const divisions = window.divisions || {};
    const userBunks = new Set();
    
    userDivisions.forEach(divName => {
      const divInfo = divisions[divName];
      if (divInfo?.bunks) {
        divInfo.bunks.forEach(b => userBunks.add(b));
      }
    });
    
    // Keep cloud overrides for bunks user doesn't own
    const merged = (cloudOverrides || []).filter(o => !userBunks.has(o.bunk));
    
    // Add all local overrides for bunks user owns
    (localOverrides || []).forEach(o => {
      if (userBunks.has(o.bunk)) {
        merged.push(o);
      }
    });
    
    return merged;
  }

  async function saveToCloud(state) {
    try {
      showToast("☁️ Saving Schedule & Settings...", "info");
      
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
          console.warn("☁️ User has viewer role, cannot save");
          return false;
      }

      // Prepare Payload
      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;

      // ★★★ CRITICAL: Merge daily schedules with division awareness ★★★
      try {
        const schedulesRaw = localStorage.getItem(DAILY_DATA_KEY);
        if (schedulesRaw) {
            const localDaily = JSON.parse(schedulesRaw);
            
            // Merge with cloud to preserve other schedulers' work
            const mergedDaily = await mergeDailyDataForSave(localDaily);
            stateToSave.daily_schedules = mergedDaily;
            
            console.log("☁️ Merged schedules bundled into save.");
        }
      } catch(e) { 
        console.warn("Bundle/merge error:", e); 
        // Fallback: just use local
        try {
          const schedulesRaw = localStorage.getItem(DAILY_DATA_KEY);
          if (schedulesRaw) {
            stateToSave.daily_schedules = JSON.parse(schedulesRaw);
          }
        } catch(e2) {}
      }

      const ownerId = campId;

      // 1. TRY PATCH FIRST
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
              console.log("☁️ [REST] ✅ PATCH Success");
              showToast("✅ Schedule Saved!", "success");
              _dailyDataDirty = false;
              return true;
          }
      }

      // 2. IF PATCH FAILED -> POST (only for owners creating new camps)
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
            console.log("☁️ [REST] ✅ POST Success");
            showToast("✅ Schedule Saved!", "success");
            _dailyDataDirty = false;
            return true;
          } else {
            console.error("Save Failed:", postResponse.status);
            showToast("❌ Save Failed (Check Console)", "error");
            return false;
          }
      } else {
          console.error("Team member cannot create new camp state");
          showToast("❌ Cannot save - camp data not found", "error");
          return false;
      }

    } catch (e) {
      console.error("Save Error:", e);
      showToast("❌ Network Error", "error");
      return false;
    }
  }
   
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
        userRole: _userRole,
        userDivisions: _userDivisions
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

  // Daily Data Handlers
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
  window.scheduleCloudSync = () => {
    _cloudSyncPending = true;
    scheduleCloudSync();
  };
  
  // Expose role info for other modules
  window.getCampistryUserRole = getUserRole;
  window.isCampistryTeamMember = isTeamMember;
  window.getCampId = getCampId;
  window.getUserDivisions = getUserDivisions; // ★★★ NEW EXPORT

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
