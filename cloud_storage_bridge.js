// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// VERSION: v4.4 (ROBUST MERGE + DEBUGGING)
// =================================================================
// 
// FEATURES:
// - Universal Additive Merge (no destructive overwrites)
// - Permission enforcement (Schedulers limited to their divisions)
// - Schedule versioning ("Base On" creates new version, preserves original)
// - Read access for everyone, write access by division
//
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v4.4 (ROBUST MERGE)");

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
  // STATE
  // ============================================================================
  let _cachedCampId = null;
  let _userRole = null;
  let _isTeamMember = false;
  let _memoryCache = null;
  let _cloudSyncPending = false;
  let _syncInProgress = false;
  let _syncTimeout = null;
  let _dailyDataDirty = false;
  let _initialized = false;
  const SCHEMA_VERSION = 3; 

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
      else if (type === 'warning') toast.style.backgroundColor = '#F59E0B';
      else toast.style.backgroundColor = '#3B82F6';

      toast.textContent = message;
      toast.style.opacity = '1';
      
      if (window._toastTimer) clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
  }

  // ============================================================================
  // CAMP ID & USER MANAGEMENT
  // ============================================================================
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
            if (parsed?.user?.id) return parsed.user.id;
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
      const { data: ownedCamp } = await window.supabase
        .from('camps').select('owner').eq('owner', userId).maybeSingle();
      
      if (ownedCamp) {
        _isTeamMember = false;
        _userRole = 'owner';
        return userId; 
      }
    } catch (e) { console.warn("☁️ Error checking ownership:", e); }
    
    try {
      const { data: membership } = await window.supabase
        .from('camp_users')
        .select('camp_id, role, subdivision_ids, accepted_at')
        .eq('user_id', userId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      
      if (membership) {
        _isTeamMember = true;
        _userRole = membership.role;
        window._campistryMembership = membership;
        return membership.camp_id;
      }
    } catch (e) { console.warn("☁️ Error checking membership:", e); }
    
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
  // PERMISSION HELPERS
  // ============================================================================
   
  function hasFullAccess() {
    return _userRole === 'owner' || _userRole === 'admin';
  }

  function getUserEditableDivisions() {
    if (window.PermissionsGuard?.getUserDivisions) {
      return window.PermissionsGuard.getUserDivisions();
    }
    if (window.AccessControl?.getEditableDivisions) {
      return window.AccessControl.getEditableDivisions() || [];
    }
    if (hasFullAccess()) {
      return Object.keys(window.divisions || {});
    }
    return [];
  }

  function getUserEditableGrades() {
    if (window.PermissionsGuard?.getEditableGrades) {
      return new Set(window.PermissionsGuard.getEditableGrades());
    }
    
    const grades = new Set();
    const divisions = getUserEditableDivisions();
    const allDivisions = window.divisions || {};
    
    for (const divId of divisions) {
      const divInfo = allDivisions[divId] || allDivisions[String(divId)];
      if (divInfo?.bunks) {
        divInfo.bunks.forEach(b => grades.add(String(b)));
      }
    }
    
    return grades;
  }

  function canEditGrade(gradeId) {
    if (hasFullAccess()) return true;
    if (_userRole === 'viewer') return false;
    return getUserEditableGrades().has(String(gradeId));
  }

  // ============================================================================
  // LOCAL CACHE
  // ============================================================================
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
            // console.log("☁️ [SYNC] Unbundling daily schedules from cloud...");
            try {
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(state.daily_schedules));
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
                    if (window.initScheduleSystem) window.initScheduleSystem();
                    if (window.updateTable) window.updateTable();
                }, 50);
            } catch(e) { console.error("Failed to save schedules", e); }
        }
        delete state.daily_schedules; 
    }

    _memoryCache = state;
    try {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(state));
      localStorage.setItem(LEGACY_KEYS.globalSettings, JSON.stringify(state));
    } catch (e) { console.error("Failed to save local cache:", e); }
  }

  // ============================================================================
  // REST API OPERATIONS
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
          'Cache-Control': 'no-cache'
        }
      });

      if (!response.ok) {
          console.error("☁️ Load failed:", response.status);
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
  // ★★★ SAVE TO CLOUD - WITH PERMISSION ENFORCEMENT ★★★
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
      // STEP 1: FETCH CLOUD STATE
      // =====================================================================
      console.log('☁️ [SAVE] Step 1: Fetching current cloud state...');
      const cloudState = await loadFromCloud();
      const cloudSchedules = cloudState?.daily_schedules || {};

      // =====================================================================
      // STEP 2: BASE = CLOUD DATA
      // =====================================================================
      // CRITICAL: Start with the cloud state so anything NOT in local is preserved automatically
      const finalSchedule = JSON.parse(JSON.stringify(cloudSchedules));

      // =====================================================================
      // STEP 3: GET LOCAL DATA
      // =====================================================================
      console.log('☁️ [SAVE] Step 3: Loading local data...');
      let localSchedules = {};
      try {
          const schedulesRaw = localStorage.getItem(DAILY_DATA_KEY);
          if (schedulesRaw) localSchedules = JSON.parse(schedulesRaw);
      } catch (e) { console.error('☁️ [SAVE] Error reading local:', e); }

      // =====================================================================
      // STEP 4: PERMISSION-ENFORCED MERGE
      // =====================================================================
      console.log('☁️ [SAVE] Step 4: Permission-enforced merge...');
      
      const METADATA_KEYS = ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 
                             'skeleton', 'manualSkeleton', 'subdivisionSchedules'];
      
      const editableGrades = getUserEditableGrades();
      const editableDivisions = getUserEditableDivisions();
      let blockedCount = 0;
      let savedCount = 0;
      let preservedCount = 0;
      
      for (const [dateKey, localDateData] of Object.entries(localSchedules)) {
          if (!finalSchedule[dateKey]) finalSchedule[dateKey] = {};
          if (!finalSchedule[dateKey].scheduleAssignments) {
              finalSchedule[dateKey].scheduleAssignments = {};
          }
          
          const localAssignments = localDateData.scheduleAssignments || localDateData;
          
          // ★★★ MERGE BUNK SCHEDULES WITH PERMISSION CHECK ★★★
          for (const [gradeId, schedule] of Object.entries(localAssignments)) {
              if (METADATA_KEYS.includes(gradeId)) continue;
              
              // PERMISSION CHECK: Can user edit this grade?
              let canEdit = false;
              
              // Use AccessControl if initialized
              if (window.AccessControl && window.AccessControl.isInitialized && typeof window.AccessControl.canEditBunk === 'function') {
                  canEdit = window.AccessControl.canEditBunk(gradeId);
              } else {
                  // Fallback: Check our own cache or assume true if owner
                  canEdit = hasFullAccess() || editableGrades.has(String(gradeId));
                  
                  // If AccessControl isn't ready but we're a scheduler, this might fail incorrectly.
                  // We default to PRESERVING data if we're unsure to prevent data loss.
                  if (!canEdit && !hasFullAccess() && !window.AccessControl?.isInitialized) {
                      console.warn(`🛡️ AccessControl not ready for "${gradeId}". Defaulting to deny-and-preserve.`);
                  }
              }

              if (canEdit) {
                  // User has permission: Apply local changes
                  finalSchedule[dateKey].scheduleAssignments[gradeId] = schedule;
                  savedCount++;
              } else {
                  // User NO permission: PRESERVE existing cloud data
                  // Since finalSchedule is initialized as a clone of cloudSchedules,
                  // we only need to restore if we somehow wiped it or if we want to be explicit.
                  if (cloudSchedules[dateKey] && 
                      cloudSchedules[dateKey].scheduleAssignments && 
                      cloudSchedules[dateKey].scheduleAssignments[gradeId]) {
                      
                      finalSchedule[dateKey].scheduleAssignments[gradeId] = cloudSchedules[dateKey].scheduleAssignments[gradeId];
                      preservedCount++;
                  } else {
                      // Blocked: It's new in local, but not in cloud, and user can't create it.
                      blockedCount++;
                      // console.warn(`🛡️ [BLOCKED] "${gradeId}" - permission denied & not in cloud`);
                  }
              }
          }
          
          // Merge other data
          if (localDateData.unifiedTimes) {
              if (!finalSchedule[dateKey].unifiedTimes) finalSchedule[dateKey].unifiedTimes = {};
              for (const [slotKey, slotData] of Object.entries(localDateData.unifiedTimes)) {
                  finalSchedule[dateKey].unifiedTimes[slotKey] = slotData;
              }
          }
          
          if (localDateData.skeleton) {
              finalSchedule[dateKey].skeleton = localDateData.skeleton;
          }
          
          if (localDateData.leagueAssignments) {
              if (!finalSchedule[dateKey].leagueAssignments) finalSchedule[dateKey].leagueAssignments = {};
              for (const [divId, leagueData] of Object.entries(localDateData.leagueAssignments)) {
                  if (hasFullAccess() || editableDivisions.includes(divId) || editableDivisions.includes(String(divId))) {
                      finalSchedule[dateKey].leagueAssignments[divId] = leagueData;
                  }
              }
          }
          
          if (localDateData.subdivisionSchedules) {
              if (!finalSchedule[dateKey].subdivisionSchedules) finalSchedule[dateKey].subdivisionSchedules = {};
              Object.assign(finalSchedule[dateKey].subdivisionSchedules, localDateData.subdivisionSchedules);
          }
      }

      console.log(`☁️ [SAVE] Stats: Saved=${savedCount}, Preserved=${preservedCount}, Blocked=${blockedCount}`);

      // =====================================================================
      // STEP 5: BUILD FINAL STATE
      // =====================================================================
      const stateToSave = { ...(cloudState || state) };
      stateToSave.daily_schedules = finalSchedule;
      stateToSave.schema_version = SCHEMA_VERSION;
      stateToSave.updated_at = new Date().toISOString();
      
      if (window.ScheduleVersioning?.prepareForCloudSync) {
          const versionData = window.ScheduleVersioning.prepareForCloudSync();
          stateToSave.schedule_versions = versionData.schedule_versions;
      }

      // =====================================================================
      // STEP 6: SAVE TO CLOUD
      // =====================================================================
      console.log('☁️ [SAVE] Step 5: Saving to cloud...');
      
      const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
      const patchResponse = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ state: stateToSave, owner_id: campId })
      });

      if (patchResponse.ok) {
          const patchedData = await patchResponse.json();
          if (patchedData && patchedData.length > 0) {
              console.log("☁️ [SAVE] ✅ Success");
              showToast("✅ Schedule Saved!", "success");
              _dailyDataDirty = false;
              window.dispatchEvent(new CustomEvent('campistry-cloud-saved'));
              return true;
          }
      }

      // POST for new records (owners only)
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
            body: JSON.stringify({ camp_id: campId, owner_id: campId, state: stateToSave })
          });

          if (postResponse.ok) {
            console.log("☁️ [SAVE] ✅ Created new record");
            showToast("✅ Schedule Saved!", "success");
            _dailyDataDirty = false;
            return true;
          }
      }
      
      console.error("☁️ Save Failed:", patchResponse.status, patchResponse.statusText);
      showToast("❌ Save Failed: " + patchResponse.status, "error");
      return false;

    } catch (e) {
      console.error("Save Error:", e);
      showToast("❌ Network Error", "error");
      return false;
    }
  }

  // ============================================================================
  // ★★★ CREATE SCHEDULE VERSION ("BASE ON" FEATURE) ★★★
  // ============================================================================

  /**
   * Create a new schedule based on an existing one
   * CRITICAL: This preserves the original and creates a NEW copy
   * * @param {string} sourceDateKey - Source date to copy from
   * @param {string} targetDateKey - Target date for new schedule
   * @param {string} name - Name for the new version
   * @param {string} sourceVersionId - Optional specific version to copy
   * @returns {Object} - { success, versionId, error }
   */
  async function createScheduleBasedOn(sourceDateKey, targetDateKey, name, sourceVersionId = null) {
    console.log(`☁️ Creating schedule for ${targetDateKey} based on ${sourceDateKey}`);
    
    try {
      // Load source data
      let sourceData = null;
      
      if (window.ScheduleVersioning && sourceVersionId) {
        // Get specific version
        sourceData = window.ScheduleVersioning.getVersionData(sourceDateKey, sourceVersionId);
      } else {
        // Get current schedule for date
        const dailyData = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
        sourceData = dailyData[sourceDateKey];
      }
      
      if (!sourceData) {
        return { success: false, error: `No schedule found for ${sourceDateKey}` };
      }
      
      // DEEP CLONE - Critical for preserving original
      const clonedData = JSON.parse(JSON.stringify(sourceData));
      
      // Add metadata
      clonedData._basedOn = {
        date: sourceDateKey,
        versionId: sourceVersionId,
        copiedAt: new Date().toISOString(),
        copiedBy: window.AccessControl?.getCurrentUserName?.() || 'Unknown'
      };
      
      // Save to target date
      const dailyData = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
      dailyData[targetDateKey] = clonedData;
      localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
      
      // Create version record if versioning is available
      if (window.ScheduleVersioning) {
        window.ScheduleVersioning.createVersion(targetDateKey, name, sourceVersionId);
      }
      
      // Sync to cloud
      _dailyDataDirty = true;
      await syncNow();
      
      console.log(`☁️ ✅ Created schedule for ${targetDateKey} based on ${sourceDateKey}`);
      
      window.dispatchEvent(new CustomEvent('campistry-schedule-created', {
        detail: { sourceDateKey, targetDateKey, name }
      }));
      
      return { success: true };
      
    } catch (e) {
      console.error("☁️ Error creating schedule:", e);
      return { success: false, error: e.message };
    }
  }

  // ============================================================================
  // SYNC & INIT
  // ============================================================================
    
  function scheduleCloudSync() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _syncTimeout = setTimeout(async () => {
      if (!_cloudSyncPending || _syncInProgress) return;
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
    if (user) await updateCampIdCache(user.id);
    
    const localData = getLocalCache();
    const hasLocalData = localData && Object.keys(localData).length > 2;

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
      detail: { hydrated: true, hasData, isTeamMember: _isTeamMember, userRole: _userRole }
    }));
  }

  // ============================================================================
  // CLEAR / RESET
  // ============================================================================
  
  window.clearCloudKeys = async function(keysToReset) {
    if (_isTeamMember && _userRole !== 'admin') {
        showToast("❌ Only owners/admins can clear data", "error");
        return false;
    }
    
    const cloudState = await loadFromCloud() || {};
    keysToReset.forEach(key => {
      if (key === 'daily_schedules') {
        cloudState.daily_schedules = {};
        localStorage.removeItem(DAILY_DATA_KEY);
      } else {
        cloudState[key] = {};
      }
    });
    cloudState.updated_at = new Date().toISOString();
    
    const token = await getSessionToken();
    const campId = getCampId();
    const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
    const response = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state: cloudState, owner_id: campId })
    });
    
    return response.ok;
  };

  window.resetCloudState = async function() {
    if (_isTeamMember) {
        showToast("❌ Only owners can reset data", "error");
        return false;
    }
    
    const emptyState = {
      divisions: {}, bunks: [], daily_schedules: {},
      updated_at: new Date().toISOString()
    };
    localStorage.removeItem(DAILY_DATA_KEY);
    setLocalCache(emptyState);
    
    const token = await getSessionToken();
    const campId = getCampId();
    const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
    const response = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state: emptyState, owner_id: campId })
    });
    
    return response.ok;
  };

  // ============================================================================
  // PUBLIC API
  // ============================================================================
  window.loadGlobalSettings = () => getLocalCache();
  window.saveGlobalSettings = (key, value) => {
    if (_userRole === 'viewer') return getLocalCache();
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
        return JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
    } catch(e) { return {}; }
  };

  window.saveCurrentDailyData = function(key, value) {
    if (_userRole === 'viewer') return;
    try {
        const data = window.loadCurrentDailyData();
        data[key] = value;
        localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(data));
        _cloudSyncPending = true;
        _dailyDataDirty = true; 
        scheduleCloudSync();
    } catch(e) { console.error("Daily Save Error:", e); }
  };

  // Permission-aware save for schedule assignments
  window.saveScheduleAssignments = function(dateKey, assignments) {
    if (_userRole === 'viewer') {
      showToast("❌ View-only access", "error");
      return false;
    }
    
    const editableGrades = getUserEditableGrades();
    const filtered = {};
    let blocked = 0;
    
    for (const [gradeId, schedule] of Object.entries(assignments)) {
      if (hasFullAccess() || editableGrades.has(String(gradeId))) {
        filtered[gradeId] = schedule;
      } else {
        blocked++;
      }
    }
    
    if (blocked > 0) {
      showToast(`⚠️ ${blocked} grades skipped (outside your divisions)`, "warning");
    }
    
    const data = window.loadCurrentDailyData();
    if (!data[dateKey]) data[dateKey] = {};
    data[dateKey].scheduleAssignments = {
      ...(data[dateKey].scheduleAssignments || {}),
      ...filtered
    };
    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(data));
    _cloudSyncPending = true;
    _dailyDataDirty = true;
    scheduleCloudSync();
    
    return true;
  };

  window.syncNow = syncNow;
  window.forceSyncToCloud = syncNow;
  window.loadFromCloud = loadFromCloud;
  window.createScheduleBasedOn = createScheduleBasedOn;
  window.scheduleCloudSync = () => { _cloudSyncPending = true; scheduleCloudSync(); };
  window.getCampistryUserRole = getUserRole;
  window.isCampistryTeamMember = isTeamMember;
  window.getCampId = getCampId;
  window.canEditGrade = canEditGrade;
  window.hasFullAccess = hasFullAccess;

  // Auth state listener
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
