// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// FIXED VERSION: v3.7 (Visual Feedback + PATCH-First + Schedules)
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v3.7 (VISUAL FEEDBACK MODE)");

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
      
      // Colors
      if (type === 'success') toast.style.backgroundColor = '#10B981'; // Green
      else if (type === 'error') toast.style.backgroundColor = '#EF4444'; // Red
      else toast.style.backgroundColor = '#3B82F6'; // Blue

      toast.textContent = message;
      toast.style.opacity = '1';
      
      // Auto-hide after 3s
      if (window._toastTimer) clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => {
          toast.style.opacity = '0';
      }, 3000);
  }

  // ============================================================================
  // CAMP ID MANAGEMENT
  // ============================================================================
  let _cachedCampId = null;

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
              _cachedCampId = parsed.user.id;
              localStorage.setItem('campistry_user_id', _cachedCampId);
              return _cachedCampId;
            }
          }
        }
      }
    } catch (e) { console.warn("Error reading storage:", e); }
    return "demo_camp_001";
  }

  function updateCampIdCache(userId) {
    if (userId) {
      _cachedCampId = userId;
      localStorage.setItem('campistry_user_id', userId);
    }
  }

  function clearCampIdCache() {
    _cachedCampId = null;
    localStorage.removeItem('campistry_user_id');
  }

  // ============================================================================
  // LOCAL CACHE
  // ============================================================================
  let _memoryCache = null;
  let _cloudSyncPending = false;
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
        console.log("☁️ [SYNC] Unbundling daily schedules from cloud...");
        try {
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(state.daily_schedules));
        } catch(e) { console.error("Failed to save extracted schedules", e); }
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
    if (data?.user) updateCampIdCache(data.user.id);
    return data?.user;
  }

  async function loadFromCloud() {
    try {
      const token = await getSessionToken();
      if (!token) return null;
      const campId = getCampId();

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

      // Prepare Payload
      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;

      // 🟢 BUNDLE SCHEDULES
      // This explicitly reads the generated schedule from storage and adds it to the save payload
      try {
        const schedulesRaw = localStorage.getItem(DAILY_DATA_KEY);
        if (schedulesRaw) {
            stateToSave.daily_schedules = JSON.parse(schedulesRaw);
            console.log("☁️ Generated schedules bundled into save.");
        }
      } catch(e) { console.warn("Bundle error:", e); }

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
            owner_id: user.id 
        })
      });

      if (patchResponse.ok) {
          const patchedData = await patchResponse.json();
          if (patchedData && patchedData.length > 0) {
              console.log("☁️ [REST] ✅ PATCH Success");
              showToast("✅ Schedule Saved!", "success");
              return true;
          }
      }

      // 2. IF PATCH FAILED -> POST
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
          owner_id: user.id,
          state: stateToSave
        })
      });

      if (postResponse.ok) {
        console.log("☁️ [REST] ✅ POST Success");
        showToast("✅ Schedule Saved!", "success");
        return true;
      } else {
        console.error("Save Failed:", postResponse.status);
        showToast("❌ Save Failed (Check Console)", "error");
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
  let _syncTimeout = null;
  let _syncInProgress = false;
   
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
      detail: { hydrated: true, hasData }
    }));
  }

  // PUBLIC API
  window.loadGlobalSettings = () => getLocalCache();
  window.saveGlobalSettings = (key, value) => {
    const state = getLocalCache();
    state[key] = value;
    state.updated_at = new Date().toISOString();
    setLocalCache(state);
    _cloudSyncPending = true;
    scheduleCloudSync();
    return state;
  };
  window.syncNow = syncNow;
  window.forceSyncToCloud = syncNow;
  window.scheduleCloudSync = () => {
    _cloudSyncPending = true;
    scheduleCloudSync();
  };

  setTimeout(() => {
    if(window.supabase) {
        window.supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
                updateCampIdCache(session.user.id);
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
