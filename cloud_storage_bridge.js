// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// VERSION: v4.9.4 (PERMISSION HELPER FIX)
// =================================================================
// 
// FEATURES:
// - Universal Additive Merge (no destructive overwrites)
// - Permission enforcement (Schedulers limited to their divisions)
// - Schedule versioning ("Base On" creates new version, preserves original)
// - Auto-Sync Back: Updates local storage with merged state after save
// - RBAC Race Condition Fix: Optimistic load during boot
// - Write Conflict Protection: Smart-weight check to rescue new local work from stale saves
// - Granular Rescue: Protects individual bunk schedules from being wiped by partial cloud saves
// - ★ v4.9.2: UPSERT FIX - Creates camp_state row if missing (fixes silent PATCH failures)
// - ★ v4.9.3: CONSERVATIVE MERGE - Preserves cloud data when RBAC not ready (fixes cross-scheduler overwrites)
// - ★ v4.9.4: PERMISSION HELPER FIX - Check AccessControl BEFORE PermissionsGuard (fixes stale permission cache)
//
// =================================================================
(function () {
  'use strict';
  console.log("☁️ Campistry Cloud Bridge v4.9.4 (PERMISSION HELPER FIX)");
  
  // CONFIGURATION
  const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
  const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
    
  const TABLE = "camp_state";
  const SCHEMA_VERSION = "1.0";
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
  let _memoryCache = null;
  let _cloudSyncPending = false;
  let _dailyDataDirty = false;
  let _syncTimeout = null;
  let _syncInProgress = false;
  let _initialized = false;
  let _userRole = null;
  let _isTeamMember = false;

  // ============================================================================
  // UI HELPERS
  // ============================================================================
  function showToast(msg, type='info') {
    if (window.showToast) {
      window.showToast(msg, type);
    } else {
      console.log(`[Toast ${type}] ${msg}`);
    }
  }

  // ============================================================================
  // AUTH / USER
  // ============================================================================
  async function getUser() {
    if (!window.supabase) return null;
    try {
      const { data: { user } } = await window.supabase.auth.getUser();
      return user;
    } catch { return null; }
  }

  async function getSessionToken() {
    if (!window.supabase) return null;
    try {
      const { data: { session } } = await window.supabase.auth.getSession();
      return session?.access_token;
    } catch { return null; }
  }

  function getCampId() {
    if (_cachedCampId) return _cachedCampId;
    const stored = localStorage.getItem('currentCampId');
    if (stored) {
      _cachedCampId = stored;
      return stored;
    }
    return null;
  }

  async function updateCampIdCache(userId) {
    if (!userId || !window.supabase) return;
    
    // Check camps table first (for owners)
    try {
      const { data: camps } = await window.supabase
        .from('camps')
        .select('id')
        .eq('owner_id', userId)
        .limit(1);
      
      if (camps?.length) {
        _cachedCampId = camps[0].id;
        localStorage.setItem('currentCampId', _cachedCampId);
        _userRole = 'owner';
        _isTeamMember = false;
        return;
      }
    } catch (e) { console.log('camps query failed:', e.message); }
    
    // Check team_members table (for team members)
    try {
      const { data: members } = await window.supabase
        .from('team_members')
        .select('camp_id, role')
        .eq('user_id', userId)
        .limit(1);
      
      if (members?.length) {
        _cachedCampId = members[0].camp_id;
        localStorage.setItem('currentCampId', _cachedCampId);
        _userRole = members[0].role || 'viewer';
        _isTeamMember = true;
        return;
      }
    } catch (e) { console.log('team_members query failed:', e.message); }
  }

  function clearCampIdCache() {
    _cachedCampId = null;
    localStorage.removeItem('currentCampId');
    localStorage.removeItem('campistry_user_id');
    localStorage.removeItem('campistry_auth_user_id');
    delete window._campistryMembership;
  }

  function getUserRole() { return _userRole; }
  function isTeamMember() { return _isTeamMember; }

  // ============================================================================
  // ★★★ PERMISSION HELPERS - v4.9.4 FIX ★★★
  // ============================================================================
  // CRITICAL FIX: Check AccessControl FIRST, then PermissionsGuard
  // PermissionsGuard can have stale data if it initialized before AccessControl
  // ============================================================================
   
  function hasFullAccess() {
    // Check AccessControl first (most reliable when initialized)
    if (window.AccessControl?.isInitialized) {
      const role = window.AccessControl.getCurrentRole?.() || window.AccessControl.role;
      return role === 'owner' || role === 'admin';
    }
    // Fallback to cached role
    return _userRole === 'owner' || _userRole === 'admin';
  }

  function getUserEditableDivisions() {
    // ★★★ v4.9.4 FIX: Check AccessControl FIRST ★★★
    // AccessControl is the authoritative source when RBAC is ready
    if (window.AccessControl?.isInitialized && window.AccessControl.getEditableDivisions) {
      const divs = window.AccessControl.getEditableDivisions();
      if (divs && divs.length > 0) {
        return divs;
      }
    }
    
    // Then check PermissionsGuard (but only if it has actual data)
    if (window.PermissionsGuard?.isInitialized?.() && window.PermissionsGuard.getUserDivisions) {
      const divs = window.PermissionsGuard.getUserDivisions();
      if (divs && divs.length > 0) {
        return divs;
      }
    }
    
    // Fallback for owners/admins
    if (hasFullAccess()) {
      return Object.keys(window.divisions || {});
    }
    
    return [];
  }

  function getUserEditableGrades() {
    // ★★★ v4.9.4 FIX: Check AccessControl FIRST ★★★
    if (window.AccessControl?.isInitialized) {
      // Try canEditBunk method if available
      if (typeof window.AccessControl.getEditableBunks === 'function') {
        const bunks = window.AccessControl.getEditableBunks();
        if (bunks && bunks.length > 0) {
          return new Set(bunks.map(String));
        }
      }
      
      // Otherwise, build from editable divisions
      const divisions = window.AccessControl.getEditableDivisions?.() || [];
      if (divisions.length > 0) {
        const grades = new Set();
        const allDivisions = window.divisions || {};
        
        for (const divId of divisions) {
          const divInfo = allDivisions[divId] || allDivisions[String(divId)];
          if (divInfo?.bunks) {
            divInfo.bunks.forEach(b => grades.add(String(b)));
          }
        }
        
        if (grades.size > 0) {
          return grades;
        }
      }
    }
    
    // Then check PermissionsGuard (but only if it has actual data)
    if (window.PermissionsGuard?.isInitialized?.() && window.PermissionsGuard.getEditableGrades) {
      const grades = window.PermissionsGuard.getEditableGrades();
      if (grades && grades.length > 0) {
        return new Set(grades.map(String));
      }
    }
    
    // Fallback: Build from divisions
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
    
    // ★★★ v4.9.4 FIX: Use AccessControl directly if available ★★★
    if (window.AccessControl?.isInitialized && typeof window.AccessControl.canEditBunk === 'function') {
      return window.AccessControl.canEditBunk(gradeId);
    }
    
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
    } catch { _memoryCache = {}; }
    return _memoryCache;
  }

  function setLocalCache(state) {
    _memoryCache = state;
    try {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(state));
    } catch (e) { console.error("☁️ Cache save error:", e); }
  }

  // ============================================================================
  // CLOUD FETCH
  // ============================================================================
  async function loadFromCloud() {
    const campId = getCampId();
    if (!campId) return null;
    
    const token = await getSessionToken();
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
    
    try {
        const resp = await fetch(url, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${token || SUPABASE_KEY}`
            }
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.length > 0 ? data[0].state : null;
    } catch (e) { 
        console.error("☁️ Load exception:", e);
        return null; 
    }
  }

  // ============================================================================
  // ★★★ SAVE TO CLOUD - WITH PERMISSION ENFORCEMENT + UPSERT FIX ★★★
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
      
      console.log(`☁️ [SAVE] Permissions: Full=${hasFullAccess()}, Grades=${editableGrades.size}, Divs=${editableDivisions.length}`);
      
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
              
              // ★★★ v4.9.4 FIX: Use AccessControl directly when available ★★★
              if (window.AccessControl && window.AccessControl.isInitialized && typeof window.AccessControl.canEditBunk === 'function') {
                  canEdit = window.AccessControl.canEditBunk(gradeId);
              } else {
                  // Fallback: Check our own cache or assume true if owner
                  canEdit = hasFullAccess() || editableGrades.has(String(gradeId));
              }

              // ★★★ OPTIMISTIC OWNERSHIP ★★★
              // If the data is NOT in the cloud, but IS locally, and we are logged in,
              // assume we just created it and have the right to save it
              const inCloud = cloudSchedules[dateKey]?.scheduleAssignments?.[gradeId];
              if (!inCloud && !canEdit) {
                 canEdit = true; 
              }

              if (canEdit) {
                  // User has permission: Apply local changes
                  finalSchedule[dateKey].scheduleAssignments[gradeId] = schedule;
                  savedCount++;
              } else {
                  // User NO permission: PRESERVE existing cloud data
                  if (cloudSchedules[dateKey]?.scheduleAssignments?.[gradeId]) {
                      finalSchedule[dateKey].scheduleAssignments[gradeId] = cloudSchedules[dateKey].scheduleAssignments[gradeId];
                      preservedCount++;
                  } else {
                      blockedCount++;
                  }
              }
          }
          
          // ★★★ MERGE LEAGUE ASSIGNMENTS ★★★
          if (localDateData.leagueAssignments) {
              if (!finalSchedule[dateKey].leagueAssignments) {
                  finalSchedule[dateKey].leagueAssignments = {};
              }
              for (const [divId, leagueData] of Object.entries(localDateData.leagueAssignments)) {
                  const canEditDiv = hasFullAccess() || editableDivisions.includes(String(divId));
                  if (canEditDiv) {
                      finalSchedule[dateKey].leagueAssignments[divId] = leagueData;
                  } else if (cloudSchedules[dateKey]?.leagueAssignments?.[divId]) {
                      finalSchedule[dateKey].leagueAssignments[divId] = cloudSchedules[dateKey].leagueAssignments[divId];
                  }
              }
          }
          
          // ★★★ MERGE UNIFIED TIMES ★★★
          if (localDateData.unifiedTimes) {
              finalSchedule[dateKey].unifiedTimes = localDateData.unifiedTimes;
          }
          
          // ★★★ MERGE SKELETON ★★★
          if (localDateData.skeleton) {
              finalSchedule[dateKey].skeleton = localDateData.skeleton;
          }
      }
      
      console.log(`☁️ [SAVE] Merge complete: Saved=${savedCount}, Preserved=${preservedCount}, Blocked=${blockedCount}`);

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
      // STEP 6: SAVE TO CLOUD (WITH UPSERT LOGIC)
      // =====================================================================
      console.log('☁️ [SAVE] Step 5: Saving to cloud...');
      
      const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
      let patchResponse = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ state: stateToSave, owner_id: campId })
      });
      
      let patchedData = [];
      if (patchResponse.ok) {
          patchedData = await patchResponse.json();
      }
      
      // ★★★ UPSERT FIX: If PATCH returned empty (row doesn't exist), INSERT it ★★★
      if (!patchedData || patchedData.length === 0) {
          console.log('☁️ [SAVE] Row not found, creating new camp_state record...');
          
          const insertUrl = `${SUPABASE_URL}/rest/v1/${TABLE}`;
          const insertResponse = await fetch(insertUrl, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify({ 
              camp_id: campId,
              owner_id: campId,
              state: stateToSave 
            })
          });
          
          if (insertResponse.ok) {
              patchedData = await insertResponse.json();
              console.log('☁️ [SAVE] ✅ Created new camp_state row');
          } else {
              const errorText = await insertResponse.text();
              if (errorText.includes('duplicate') || errorText.includes('unique')) {
                  console.log('☁️ [SAVE] Row was just created by another process, retrying PATCH...');
                  patchResponse = await fetch(patchUrl, {
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
                      patchedData = await patchResponse.json();
                  }
              } else {
                  console.error('☁️ [SAVE] INSERT failed:', insertResponse.status, errorText);
              }
          }
      }
      
      if (patchedData && patchedData.length > 0) {
          console.log("☁️ [SAVE] ✅ Success");
              
          // ★★★ AUTO-SYNC BACK: SAFE UPDATE LOCAL STORAGE ★★★
          try {
              console.log("☁️ [SYNC] Updating local storage with merged state...");
              
              const freshLocal = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
              const mergedBack = { ...finalSchedule };
              
              // ★★★ GRANULAR RESCUE ★★★
              // For each date, check if local has fresh work that wasn't in our save
              for (const [dateKey, localDateData] of Object.entries(freshLocal)) {
                  if (!mergedBack[dateKey]) {
                      mergedBack[dateKey] = localDateData;
                      continue;
                  }
                  
                  const localAssignments = localDateData.scheduleAssignments || localDateData;
                  if (!localAssignments || typeof localAssignments !== 'object') continue;
                  
                  for (const [gradeId, localSchedule] of Object.entries(localAssignments)) {
                      if (METADATA_KEYS.includes(gradeId)) continue;
                      
                      // If local has more slots than what we saved, preserve local
                      const savedSchedule = mergedBack[dateKey]?.scheduleAssignments?.[gradeId];
                      const localSlots = Object.keys(localSchedule || {}).length;
                      const savedSlots = Object.keys(savedSchedule || {}).length;
                      
                      if (localSlots > savedSlots) {
                          if (!mergedBack[dateKey].scheduleAssignments) {
                              mergedBack[dateKey].scheduleAssignments = {};
                          }
                          mergedBack[dateKey].scheduleAssignments[gradeId] = localSchedule;
                      }
                  }
                  
                  // Also preserve local unifiedTimes if richer
                  if (localDateData.unifiedTimes && Array.isArray(localDateData.unifiedTimes)) {
                      const localCount = localDateData.unifiedTimes.length;
                      const savedCount = mergedBack[dateKey]?.unifiedTimes?.length || 0;
                      if (localCount > savedCount) {
                          mergedBack[dateKey].unifiedTimes = localDateData.unifiedTimes;
                      }
                  }
              }
              
              localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(mergedBack));
              
              // Update unified cache too
              const unifiedState = getLocalCache();
              unifiedState.daily_schedules = mergedBack;
              setLocalCache(unifiedState);
              
          } catch (syncErr) {
              console.error("☁️ [SYNC] Local sync error:", syncErr);
          }
          
          showToast("☁️ Schedule saved", "success");
          
          // Dispatch event
          window.dispatchEvent(new CustomEvent('campistry-cloud-saved', {
              detail: { savedCount, preservedCount, blockedCount }
          }));
          
          return true;
      } else {
          console.error("☁️ [SAVE] Failed - no data returned");
          showToast("❌ Save failed", "error");
          return false;
      }
      
    } catch (e) {
      console.error("☁️ Save exception:", e);
      showToast("❌ Save error", "error");
      return false;
    }
  }

  // ============================================================================
  // SCHEDULE VERSIONING SUPPORT
  // ============================================================================
  async function createScheduleBasedOn(sourceDateKey, targetDateKey, name, sourceVersionId) {
    try {
      // Load source data
      const dailyData = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
      const sourceData = dailyData[sourceDateKey];
      
      if (!sourceData) {
        return { success: false, error: 'Source schedule not found' };
      }
      
      // Deep clone
      const clonedData = JSON.parse(JSON.stringify(sourceData));
      
      // Add metadata
      clonedData.basedOn = {
        dateKey: sourceDateKey,
        versionId: sourceVersionId,
        createdAt: new Date().toISOString(),
        createdBy: window.AccessControl?.getUserName?.() || 'Unknown'
      };
      
      // Save to target date
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
    console.log("☁️ [INIT] Starting Read-Side Merge initialization...");
    const user = await getUser();
    if (user) await updateCampIdCache(user.id);
    
    // 1. Fetch Cloud Data
    const cloudState = await loadFromCloud();
    
    // 2. Fetch Local Data
    const localState = getLocalCache();
    let localDaily = {};
    try {
        const raw = localStorage.getItem(DAILY_DATA_KEY);
        if (raw) localDaily = JSON.parse(raw);
    } catch(e) { console.error("Error reading local daily:", e); }
    
    // 3. Merge Strategy
    if (cloudState) {
        console.log("☁️ [INIT] Cloud data found. Merging...");
        
        // A. Global Settings: Cloud wins (usually admin controlled)
        const mergedState = { ...cloudState };
        
        // Ensure divisions are available for permission checks
        if (!window.divisions && mergedState.divisions) {
            window.divisions = mergedState.divisions;
        }
        
        // B. Daily Schedules: Selective Merge
        const cloudDaily = cloudState.daily_schedules || {};
        
        // DEEP CLONE to prevent reference issues
        const mergedDaily = JSON.parse(JSON.stringify(cloudDaily));
        
        // Get Permissions
        const editableGrades = getUserEditableGrades();
        const editableDivisions = getUserEditableDivisions();
        const hasFull = hasFullAccess();
        const rbacReady = window.AccessControl && window.AccessControl.isInitialized;
        
        console.log(`☁️ [INIT] Merge Permissions: RBACReady=${rbacReady}, Full=${hasFull}, Grades=${editableGrades.size}, Divs=${editableDivisions.length}`);
        
        // Overlay Local Data ONLY for editable fields
        let mergedCount = 0;
        let preservedCount = 0;
        let pendingCount = 0;
        
        for (const [dateKey, localDay] of Object.entries(localDaily)) {
            if (!mergedDaily[dateKey]) mergedDaily[dateKey] = {};
            
            const localAssignments = localDay.scheduleAssignments || localDay;
            
            // 1. Schedule Assignments
            if (localAssignments && typeof localAssignments === 'object') {
                if (!mergedDaily[dateKey].scheduleAssignments) {
                    mergedDaily[dateKey].scheduleAssignments = {};
                }
                
                for (const [gradeId, schedule] of Object.entries(localAssignments)) {
                    if (['unifiedTimes', 'skeleton', 'leagueAssignments', 'subdivisionSchedules'].includes(gradeId)) continue;
                    
                    let canEdit = hasFull || editableGrades.has(String(gradeId));
                    
                    // ★★★ v4.9.3 FIX: CONSERVATIVE MERGE WHEN RBAC NOT READY ★★★
                    if (!rbacReady && !hasFull) {
                        const cloudHasData = cloudDaily[dateKey]?.scheduleAssignments?.[gradeId];
                        
                        if (cloudHasData) {
                            canEdit = false;
                            pendingCount++;
                        } else {
                            canEdit = true;
                        }
                    }
                    
                    if (canEdit) {
                        mergedDaily[dateKey].scheduleAssignments[gradeId] = schedule;
                        mergedCount++;
                    } else {
                        preservedCount++;
                    }
                }
            }
            
            // 2. League Assignments
            if (localDay.leagueAssignments) {
                if (!mergedDaily[dateKey].leagueAssignments) {
                    mergedDaily[dateKey].leagueAssignments = {};
                }
                for (const [divId, leagueData] of Object.entries(localDay.leagueAssignments)) {
                    let canEdit = hasFull || editableDivisions.includes(String(divId));
                    
                    if (!rbacReady && !hasFull) {
                        const cloudHasLeague = cloudDaily[dateKey]?.leagueAssignments?.[divId];
                        if (cloudHasLeague) {
                            canEdit = false;
                            pendingCount++;
                        } else {
                            canEdit = true;
                        }
                    }
                    
                    if (canEdit) {
                        mergedDaily[dateKey].leagueAssignments[divId] = leagueData;
                    }
                }
            }
            
            // 3. Unified Times - always take the richer version
            if (localDay.unifiedTimes && Array.isArray(localDay.unifiedTimes)) {
                const localCount = localDay.unifiedTimes.length;
                const cloudCount = mergedDaily[dateKey]?.unifiedTimes?.length || 0;
                if (localCount >= cloudCount) {
                    mergedDaily[dateKey].unifiedTimes = localDay.unifiedTimes;
                }
            }
        }
        
        console.log(`☁️ [INIT] Merge Stats: Applied Local=${mergedCount}, Preserved Cloud=${preservedCount}, Pending Validation=${pendingCount}`);
        
        // 4. Save Result to Storage
        mergedState.daily_schedules = mergedDaily;
        setLocalCache(mergedState); 
        
        if (_memoryCache) _memoryCache.daily_schedules = mergedDaily;
        console.log("☁️ [INIT] Merge complete.");
        finishInit(true);
        
        if (pendingCount > 0) {
            console.log("☁️ [INIT] Performed conservative merge. Waiting for RBAC to re-merge with correct permissions...");
        } else {
            showToast("☁️ Schedule Synced with Cloud", "success");
        }
    } else {
        // Fallback: No cloud data found
        console.log("☁️ [INIT] No cloud data found. Using local.");
        const hasData = localState && Object.keys(localState).length > 0;
        finishInit(hasData);
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

  // ★★★ RBAC LISTENER - Re-run sync when permissions are ready ★★★
  window.addEventListener('campistry-rbac-ready', async () => {
     console.log("☁️ RBAC Ready - Re-running Cloud Merge with correct permissions...");
     await initialize();
  });

  initialize();
})();
