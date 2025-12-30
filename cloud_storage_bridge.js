// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// FIXED VERSION: v3.4 (Direct REST Mode + Reset + Immediate Sync + Smart Init)
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v3.4 (DIRECT REST + RESET + SYNC + SMART INIT)");

  // DIRECT CONFIGURATION (Bypasses SDK initialization issues)
  const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
  const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
  
  const TABLE = "camp_state";
  const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";

  const LEGACY_KEYS = {
    globalSettings: "campGlobalSettings_v1",
    localCache: "CAMPISTRY_LOCAL_CACHE", 
    globalRegistry: "campistry_global_registry"
  };

  // ============================================================================
  // CAMP ID MANAGEMENT
  // ============================================================================
  let _cachedCampId = null;

  function getCampId() {
    if (_cachedCampId) return _cachedCampId;
    
    // Try localStorage
    const cachedUserId = localStorage.getItem('campistry_user_id');
    if (cachedUserId && cachedUserId !== 'demo_camp_001') {
      _cachedCampId = cachedUserId;
      return _cachedCampId;
    }

    // Try finding Supabase session
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const storedSession = localStorage.getItem(key);
          if (storedSession) {
            const parsed = JSON.parse(storedSession);
            const userId = parsed?.user?.id;
            if (userId) {
              _cachedCampId = userId;
              localStorage.setItem('campistry_user_id', userId);
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
    _memoryCache = state;
    try {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(state));
      // Sync legacy keys for compatibility
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
      console.log("☁️ [REST] Loading state for:", campId);

      const url = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}&select=state`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error("☁️ [REST] Load Failed:", response.status);
        return null;
      }

      const data = await response.json();
      if (data && data.length > 0) {
        console.log("☁️ [REST] ✅ Data received!");
        return data[0].state;
      } else {
        console.log("☁️ [REST] No data found (New User)");
        return null;
      }
    } catch (e) {
      console.error("☁️ [REST] Error:", e);
      return null;
    }
  }

  async function saveToCloud(state) {
    try {
      const user = await getUser();
      if (!user) return false;
      
      const token = await getSessionToken();
      const campId = getCampId();
      
      if (campId === "demo_camp_001") return false;

      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;

      if (stateToSave.app1) {
        if (!stateToSave.divisions && stateToSave.app1.divisions) stateToSave.divisions = stateToSave.app1.divisions;
        if (!stateToSave.bunks && stateToSave.app1.bunks) stateToSave.bunks = stateToSave.app1.bunks;
      }

      console.log("☁️ [REST] Saving via Fetch...");

      const payload = {
        camp_id: campId,
        owner_id: user.id,
        state: stateToSave
      };

      const url = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log("☁️ [REST] ✅ Save Successful");
        return true;
      } else {
        console.error("☁️ [REST] Save Failed:", response.status, response.statusText);
        return false;
      }

    } catch (e) {
      console.error("☁️ [REST] Save Error:", e);
      return false;
    }
  }
  
  // ============================================================================
  // 🟢 NEW: RESET & IMPORT FUNCTIONALITY
  // ============================================================================
  window.resetCloudState = async function() {
    console.log("☁️ [REST] Resetting Cloud State (ERASE ALL)...");
    
    // Create clean empty state
    const emptyState = {
      divisions: {},
      bunks: [],
      app1: {
        divisions: {}, bunks: [], fields: [], specialActivities: [],
        allSports: [], bunkMetaData: {}, sportMetaData: {},
        savedSkeletons: {}, skeletonAssignments: {}
      },
      locationZones: {},
      pinnedTileDefaults: {},
      leaguesByName: {},
      leagueRoundState: {},
      specialtyLeagues: {},
      smartTileHistory: {},
      rotationHistory: { bunks: {}, leagues: {} },
      updated_at: new Date().toISOString()
    };
    
    // Clear local storage
    setLocalCache(emptyState);
    
    // Push empty state to cloud
    return await saveToCloud(emptyState);
  };

  // Import state (JSON file upload) -> Save Locally -> Push to Cloud Immediately
  window.setCloudState = async function(newState) {
    console.log("☁️ [REST] Importing new state...");
    
    if (!newState || typeof newState !== 'object') {
        console.error("☁️ [REST] Invalid state object for import");
        return false;
    }

    // Ensure metadata
    newState.updated_at = new Date().toISOString();
    newState.schema_version = SCHEMA_VERSION;

    // 1. Save to Local Storage Immediately
    setLocalCache(newState);
    console.log("☁️ [REST] Imported state saved to local storage.");

    // 2. Push to Cloud Immediately (Background)
    console.log("☁️ [REST] Pushing imported state to cloud...");
    const cloudSuccess = await saveToCloud(newState);
    
    if (cloudSuccess) {
        console.log("☁️ [REST] Import synced to cloud successfully.");
    } else {
        console.warn("☁️ [REST] Import saved locally but cloud sync failed (will retry later).");
        _cloudSyncPending = true;
        scheduleCloudSync();
    }

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
    }, 1000);
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
    
    console.log("☁️ Initializing Cloud Bridge...");
    const localData = getLocalCache();
    const hasLocalData = localData && Object.keys(localData).length > 0 && 
                         (Object.keys(localData.divisions || {}).length > 0 || 
                          (localData.app1 && Object.keys(localData.app1.divisions || {}).length > 0));

    // 1. Check Local Storage First
    if (hasLocalData) {
        console.log("☁️ Local data found. Using local data first.");
        
        // If "Just Imported" flag exists, trust local implicitly and push to cloud
        if (localData._importTimestamp && (Date.now() - localData._importTimestamp) < 60000) {
             console.log("☁️ Fresh import detected. Pushing to cloud...");
             delete localData._importTimestamp;
             setLocalCache(localData);
             saveToCloud(localData); // Background push
             finishInit(true);
             return;
        }
        
        // If normal local data, we still check cloud *in background* for newer version
        // But we resolve init immediately to show UI
        finishInit(true);
        
        // Background check for cloud updates (Hybrid Sync)
        loadFromCloud().then(cloudState => {
            if (cloudState) {
                const localTime = localData.updated_at ? new Date(localData.updated_at).getTime() : 0;
                const cloudTime = cloudState.updated_at ? new Date(cloudState.updated_at).getTime() : 0;
                
                // Only overwrite local if cloud is strictly newer
                if (cloudTime > localTime) {
                    console.log("☁️ Cloud has newer data. Updating local in background...");
                    setLocalCache({ ...localData, ...cloudState });
                    
                    // Dispatch event to refresh UI if needed (optional)
                    // window.location.reload(); // Aggressive refresh
                    console.log("☁️ Local state updated from cloud background check.");
                } else {
                    console.log("☁️ Local data is up-to-date or newer than cloud.");
                }
            }
        });
        return;
    }

    // 2. If Local Empty, Fetch from Cloud
    console.log("☁️ Local storage empty. Fetching from cloud...");
    const cloudState = await loadFromCloud();
    
    if (cloudState) {
       console.log("☁️ Data found in Cloud. Hydrating...");
       setLocalCache(cloudState);
       finishInit(true);
    } else {
       console.log("☁️ No data in Cloud either. Starting fresh.");
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

  // ============================================================================
  // PUBLIC API
  // ============================================================================
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

  setTimeout(() => {
    if(window.supabase) {
        window.supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
                console.log("☁️ Auth Change: Signed In -> Loading Data...");
                updateCampIdCache(session.user.id);
                // Reset init flag to allow re-check on sign-in
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
