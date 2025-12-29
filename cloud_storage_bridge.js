// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// FIXED VERSION: Proper sync/async handling + consolidated storage
// v2.3 - Fixed getCampId() for Supabase v2 + proper user isolation
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v2.3 (FIXED)");

  const TABLE = "camp_state";
  
  // ⭐ UNIFIED storage key - consolidates all previous keys
  const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
  
  // Legacy keys we'll migrate from (read-only, for migration)
  const LEGACY_KEYS = {
    globalSettings: "campGlobalSettings_v1",
    localCache: "CAMPISTRY_LOCAL_CACHE", 
    globalRegistry: "campistry_global_registry"
  };
  
  // ============================================================================
  // CAMP ID MANAGEMENT - User Isolation
  // ============================================================================
  
  // Cache the camp ID once we have it
  let _cachedCampId = null;

  function getCampId() {
    // Return cached value if available
    if (_cachedCampId) {
      return _cachedCampId;
    }
    
    // Try to find Supabase session in localStorage (v2 format)
    // Supabase v2 stores auth in keys like: sb-<project-ref>-auth-token
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const storedSession = localStorage.getItem(key);
          if (storedSession) {
            const parsed = JSON.parse(storedSession);
            // Supabase v2 stores user in different structures depending on version
            const userId = parsed?.user?.id || 
                          parsed?.currentSession?.user?.id ||
                          parsed?.session?.user?.id;
            if (userId) {
              _cachedCampId = userId;
              localStorage.setItem('campistry_user_id', userId);
              console.log("☁️ getCampId: Found user ID from Supabase storage");
              return _cachedCampId;
            }
          }
        }
      }
    } catch (e) {
      console.warn("☁️ getCampId: Error reading Supabase storage:", e);
    }
    
    // Try our own cached user ID (persists across page reloads)
    const cachedUserId = localStorage.getItem('campistry_user_id');
    if (cachedUserId && cachedUserId !== 'demo_camp_001') {
      _cachedCampId = cachedUserId;
      console.log("☁️ getCampId: Using cached user ID");
      return _cachedCampId;
    }
    
    // Fallback for development/testing - should not happen in production
    console.warn("☁️ getCampId: No user ID found, using fallback");
    return "demo_camp_001";
  }

  // Call this when auth state changes to update the cache
  function updateCampIdCache(userId) {
    if (userId) {
      _cachedCampId = userId;
      localStorage.setItem('campistry_user_id', userId);
      console.log("☁️ updateCampIdCache: User ID cached");
    }
  }
  
  // Clear the cache on sign out
  function clearCampIdCache() {
    _cachedCampId = null;
    localStorage.removeItem('campistry_user_id');
    console.log("☁️ clearCampIdCache: User ID cache cleared");
  }

  const SCHEMA_VERSION = 2;

  // In-memory cache for synchronous access
  let _memoryCache = null;
  let _cloudSyncPending = false;
  let _initialized = false;

  // ------------------------------------------------------------
  // Migrate from legacy keys (one-time)
  // ------------------------------------------------------------
  let _migrationDone = false;
  
  function migrateLegacyData() {
    if (_migrationDone) return;
    _migrationDone = true;
    
    if (localStorage.getItem(UNIFIED_CACHE_KEY)) {
      console.log("☁️ Unified storage exists, skipping migration");
      return;
    }
    
    console.log("🔄 Migrating legacy storage keys...");
    
    let merged = {};
    
    try {
      const gs = JSON.parse(localStorage.getItem(LEGACY_KEYS.globalSettings) || "{}");
      merged = { ...merged, ...gs };
    } catch (e) { console.warn("Legacy migration: globalSettings parse failed", e); }
    
    try {
      const lc = JSON.parse(localStorage.getItem(LEGACY_KEYS.localCache) || "{}");
      merged = { ...merged, ...lc };
    } catch (e) { console.warn("Legacy migration: localCache parse failed", e); }
    
    try {
      const gr = JSON.parse(localStorage.getItem(LEGACY_KEYS.globalRegistry) || "{}");
      if (gr.divisions) merged.divisions = gr.divisions;
      if (gr.bunks) merged.bunks = gr.bunks;
    } catch (e) { console.warn("Legacy migration: globalRegistry parse failed", e); }
    
    if (Object.keys(merged).length > 0) {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(merged));
      console.log("✅ Legacy data migrated to unified storage");
    }
  }

  // ------------------------------------------------------------
  // Local cache operations (SYNCHRONOUS)
  // ------------------------------------------------------------
  function getLocalCache() {
    if (_memoryCache !== null) {
      return _memoryCache;
    }
    
    try {
      const raw = localStorage.getItem(UNIFIED_CACHE_KEY);
      _memoryCache = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("Failed to parse local cache:", e);
      _memoryCache = {};
    }
    
    return _memoryCache;
  }
  
  function setLocalCache(state) {
    // Ensure divisions/bunks are at root level
    if (state.app1) {
      if ((!state.divisions || Object.keys(state.divisions).length === 0) && 
          state.app1.divisions && Object.keys(state.app1.divisions).length > 0) {
        state.divisions = state.app1.divisions;
      }
      if ((!state.bunks || state.bunks.length === 0) && 
          state.app1.bunks && state.app1.bunks.length > 0) {
        state.bunks = state.app1.bunks;
      }
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
    } catch (e) {
      console.error("Failed to save local cache:", e);
    }
  }

  // ------------------------------------------------------------
  // Cloud operations (ASYNC - background sync)
  // ------------------------------------------------------------
  async function getUser() {
    try {
      if (!window.supabase) {
        console.log("☁️ Supabase not available yet");
        return null;
      }
      const { data, error } = await window.supabase.auth.getUser();
      if (error) {
        if (error.message?.includes('session')) {
          console.log("☁️ No auth session yet (user not signed in)");
        } else {
          console.warn("☁️ getUser error:", error.message);
        }
        return null;
      }
      if (data?.user) {
        // Update the cache whenever we successfully get the user
        updateCampIdCache(data.user.id);
        console.log("☁️ Current user:", data.user.email);
      }
      return data?.user || null;
    } catch (e) {
      console.warn("☁️ Failed to get user:", e);
      return null;
    }
  }

  async function loadFromCloud() {
    try {
      if (!window.supabase) {
        console.log("☁️ Supabase not available for load");
        return null;
      }
      
      const user = await getUser();
      if (!user) {
        console.log("☁️ No user yet - will load from cloud after sign-in");
        return null;
      }
      
      const campId = getCampId();
      console.log("☁️ Loading from cloud for camp_id:", campId.substring(0, 8) + "...");
      
      const { data, error } = await window.supabase
        .from(TABLE)
        .select("state")
        .eq("camp_id", campId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          console.log("☁️ No cloud data found (new user or first sync)");
          return null;
        }
        console.error("☁️ Cloud load error:", error.message, error.code);
        return null;
      }
      
      let state = data?.state || null;
      
      if (state && state.app1) {
        if ((!state.divisions || Object.keys(state.divisions).length === 0) && 
            state.app1.divisions && Object.keys(state.app1.divisions).length > 0) {
          state.divisions = state.app1.divisions;
          console.log("☁️ Copied divisions from app1 to root");
        }
        if ((!state.bunks || state.bunks.length === 0) && 
            state.app1.bunks && state.app1.bunks.length > 0) {
          state.bunks = state.app1.bunks;
          console.log("☁️ Copied bunks from app1 to root");
        }
      }
      
      console.log("☁️ Cloud data loaded:", {
        hasState: !!state,
        divisions: Object.keys(state?.divisions || {}).length,
        bunks: (state?.bunks || []).length
      });
      
      return state;
    } catch (e) {
      console.error("☁️ Cloud load failed:", e);
      return null;
    }
  }

  async function saveToCloud(state) {
    try {
      if (!window.supabase) {
        console.error("☁️ Supabase not available for save");
        return false;
      }
      
      const user = await getUser();
      if (!user) {
        console.error("☁️ Cannot save to cloud: no authenticated user");
        return false;
      }

      const campId = getCampId();
      
      // Sanity check - don't save if using demo fallback
      if (campId === "demo_camp_001") {
        console.error("☁️ Cannot save to cloud: no valid camp_id (still using demo fallback)");
        return false;
      }

      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;
      
      if (stateToSave.app1) {
        if (stateToSave.app1.divisions && Object.keys(stateToSave.app1.divisions).length > 0) {
          stateToSave.divisions = stateToSave.app1.divisions;
        }
        if (stateToSave.app1.bunks && stateToSave.app1.bunks.length > 0) {
          stateToSave.bunks = stateToSave.app1.bunks;
        }
      }

      console.log("☁️ Saving to cloud:", {
        camp_id: campId.substring(0, 8) + "...",
        user_id: user.id.substring(0, 8) + "...",
        divisions: Object.keys(stateToSave.divisions || {}).length,
        bunks: (stateToSave.bunks || []).length
      });

      const { data, error } = await window.supabase
        .from(TABLE)
        .upsert({
          camp_id: campId,
          owner_id: user.id,
          state: stateToSave
        }, {
          onConflict: 'camp_id'
        })
        .select();
      
      if (error) {
        console.error("☁️ Cloud save error:", error.message, error.code, error.details);
        return false;
      }
      
      console.log("☁️ ✅ Saved to cloud successfully");
      return true;
    } catch (e) {
      console.error("☁️ Cloud save failed:", e);
      return false;
    }
  }
  
  // Debounced cloud sync
  let _syncTimeout = null;
  let _syncInProgress = false;
  
  function scheduleCloudSync() {
    console.log("☁️ Scheduling cloud sync...");
    if (_syncTimeout) {
      clearTimeout(_syncTimeout);
    }
    _syncTimeout = setTimeout(async () => {
      if (!_cloudSyncPending) {
        return;
      }
      if (_syncInProgress) {
        scheduleCloudSync();
        return;
      }
      _syncInProgress = true;
      _cloudSyncPending = false;
      console.log("☁️ Performing cloud sync...");
      await saveToCloud(getLocalCache());
      _syncInProgress = false;
    }, 500);
  }
  
  // Immediate sync for critical operations
  async function syncNow() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _cloudSyncPending = false;
    if (_syncInProgress) {
      console.log("☁️ Sync already in progress, waiting...");
      await new Promise(r => setTimeout(r, 1000));
    }
    _syncInProgress = true;
    const result = await saveToCloud(getLocalCache());
    _syncInProgress = false;
    return result;
  }

  // ------------------------------------------------------------
  // Initialize - migrate + hydrate from cloud
  // ------------------------------------------------------------
  let _initializingPromise = null;
  
  async function initialize() {
    if (_initialized) {
      return;
    }
    
    if (_initializingPromise) {
      return _initializingPromise;
    }
    
    _initializingPromise = (async () => {
      console.log("☁️ Starting cloud bridge initialization...");
      
      try {
        migrateLegacyData();
        
        const localData = getLocalCache();
        
        const justImported = localData._importTimestamp && 
                             (Date.now() - localData._importTimestamp) < 30000;
        
        if (justImported) {
          console.log("☁️ Recently imported data detected - skipping cloud overwrite");
          delete localData._importTimestamp;
          setLocalCache(localData);
          return;
        }
        
        let user = null;
        try {
          const { data } = await window.supabase?.auth?.getUser() || {};
          user = data?.user;
          if (user) {
            updateCampIdCache(user.id);
          }
        } catch (e) {
          // Ignore auth errors during init
        }
        
        if (!user) {
          console.log("☁️ No user - skipping cloud fetch (will load after sign-in)");
          return;
        }
        
        console.log("☁️ User authenticated, fetching from cloud...");
        const cloudState = await loadFromCloud();
        
        if (cloudState && Object.keys(cloudState).length > 0) {
          const localTime = localData.updated_at ? new Date(localData.updated_at).getTime() : 0;
          const cloudTime = cloudState.updated_at ? new Date(cloudState.updated_at).getTime() : 0;
          
          if (cloudTime >= localTime) {
            const merged = { ...localData, ...cloudState };
            setLocalCache(merged);
            console.log("☁️ Hydrated from cloud");
          } else {
            console.log("☁️ Local data is newer - will sync to cloud");
            _cloudSyncPending = true;
            scheduleCloudSync();
          }
        }
        
      } catch (e) {
        console.error("☁️ Initialize error:", e);
      } finally {
        _initialized = true;
        window.__CAMPISTRY_CLOUD_READY__ = true;
        _initializingPromise = null;
        
        const hasData = Object.keys(getLocalCache().divisions || {}).length > 0;
        console.log("☁️ Cloud bridge ready, hasData:", hasData);
        
        window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
          detail: { hydrated: true, hasData }
        }));
      }
    })();
    
    return _initializingPromise;
  }

  // ------------------------------------------------------------
  // PUBLIC API - SYNCHRONOUS (with background cloud sync)
  // ------------------------------------------------------------
  
  window.loadGlobalSettings = function() {
    return getLocalCache();
  };
  
  window.saveGlobalSettings = function(key, value) {
    console.log("☁️ saveGlobalSettings called:", key);
    const state = getLocalCache();
    state[key] = value;
    state.updated_at = new Date().toISOString();
    
    if (state._importTimestamp) {
        console.log("☁️ Clearing import timestamp flag");
        delete state._importTimestamp;
    }
    
    setLocalCache(state);
    
    _cloudSyncPending = true;
    scheduleCloudSync();
    
    return state;
  };
  
  window.loadGlobalSettingsAsync = async function() {
    await initialize();
    return getLocalCache();
  };
  
  window.saveGlobalSettingsAsync = async function(key, value) {
    const state = getLocalCache();
    state[key] = value;
    setLocalCache(state);
    await saveToCloud(state);
    return state;
  };
  
  // ⭐ SET/IMPORT STATE - Updates memory cache and localStorage
  // This is used for IMPORTS to work WITHOUT page reload
  window.setCloudState = async function(newState, syncToCloud = true) {
    console.log("☁️ setCloudState called - importing data");
    
    if (!newState || typeof newState !== 'object') {
      console.error("☁️ setCloudState: Invalid state provided");
      return false;
    }
    
    // Ensure divisions/bunks are at root level
    if (newState.app1) {
      if (newState.app1.divisions && Object.keys(newState.app1.divisions).length > 0) {
        if (!newState.divisions || Object.keys(newState.divisions).length === 0) {
          newState.divisions = newState.app1.divisions;
        }
      }
      if (newState.app1.bunks && newState.app1.bunks.length > 0) {
        if (!newState.bunks || newState.bunks.length === 0) {
          newState.bunks = newState.app1.bunks;
        }
      }
    }
    
    // Add timestamp
    newState.updated_at = new Date().toISOString();
    
    // ⭐ CRITICAL: Update memory cache FIRST
    _memoryCache = newState;
    
    // Save to localStorage
    try {
      const stateJSON = JSON.stringify(newState);
      localStorage.setItem(UNIFIED_CACHE_KEY, stateJSON);
      localStorage.setItem(LEGACY_KEYS.globalSettings, stateJSON);
      localStorage.setItem(LEGACY_KEYS.localCache, stateJSON);
      localStorage.setItem(LEGACY_KEYS.globalRegistry, JSON.stringify({
        divisions: newState.divisions || {},
        bunks: newState.bunks || []
      }));
      console.log("☁️ State imported to memory cache and localStorage");
    } catch (e) {
      console.error("☁️ Failed to save imported state:", e);
      return false;
    }
    
    // Sync to cloud if requested
    if (syncToCloud) {
      const success = await syncNow();
      console.log("☁️ Cloud sync after import:", success ? "SUCCESS" : "FAILED");
      return success;
    }
    
    return true;
  };
  
  // ⭐ RESET ALL DATA - Properly clears memory cache, localStorage, AND cloud
  window.resetCloudState = async function(newState = null) {
    console.log("☁️ resetCloudState called - clearing all data");
    
    const emptyState = newState || {
      divisions: {},
      bunks: [],
      app1: {
        divisions: {},
        bunks: [],
        fields: [],
        specialActivities: [],
        allSports: [],
        bunkMetaData: {},
        sportMetaData: {},
        savedSkeletons: {},
        skeletonAssignments: {}
      },
      locationZones: {},
      pinnedTileDefaults: {},
      leaguesByName: {},
      leagueRoundState: {},
      specialtyLeagues: {},
      smartTileHistory: {},
      manualUsageOffsets: {},
      historicalCounts: {},
      rotationHistory: { bunks: {}, leagues: {} },
      updated_at: new Date().toISOString()
    };
    
    _memoryCache = emptyState;
    
    try {
      const stateJSON = JSON.stringify(emptyState);
      localStorage.setItem(UNIFIED_CACHE_KEY, stateJSON);
      localStorage.setItem(LEGACY_KEYS.globalSettings, stateJSON);
      localStorage.setItem(LEGACY_KEYS.localCache, stateJSON);
      localStorage.setItem(LEGACY_KEYS.globalRegistry, JSON.stringify({
        divisions: {},
        bunks: []
      }));
      console.log("☁️ Local storage cleared");
    } catch (e) {
      console.error("☁️ Failed to clear localStorage:", e);
    }
    
    const success = await syncNow();
    console.log("☁️ Cloud reset result:", success ? "SUCCESS" : "FAILED");
    return success;
  };
  
  // ⭐ CLEAR SPECIFIC KEYS - For partial resets (like New Half)
  window.clearCloudKeys = async function(keysToReset) {
    console.log("☁️ clearCloudKeys called for:", keysToReset);
    
    const state = getLocalCache();
    
    keysToReset.forEach(key => {
      if (key === 'leagueRoundState') state.leagueRoundState = {};
      else if (key === 'manualUsageOffsets') state.manualUsageOffsets = {};
      else if (key === 'historicalCounts') state.historicalCounts = {};
      else if (key === 'smartTileHistory') state.smartTileHistory = {};
      else if (key === 'rotationHistory') state.rotationHistory = { bunks: {}, leagues: {} };
      else delete state[key];
    });
    
    state.updated_at = new Date().toISOString();
    
    setLocalCache(state);
    
    const success = await syncNow();
    console.log("☁️ Partial reset result:", success ? "SUCCESS" : "FAILED");
    return success;
  };
  
  // Force immediate cloud sync
  window.forceSyncToCloud = async function() {
    console.log("☁️ Force sync to cloud requested");
    
    const state = getLocalCache();
    if (state._importTimestamp) {
      console.log("☁️ Clearing import timestamp before sync");
      delete state._importTimestamp;
      setLocalCache(state);
    }
    
    const success = await syncNow();
    console.log("☁️ Force sync result:", success ? "SUCCESS" : "FAILED");
    return success;
  };
  
  window.syncNow = syncNow;
  
  window.clearImportFlag = function() {
    const state = getLocalCache();
    if (state._importTimestamp) {
      delete state._importTimestamp;
      setLocalCache(state);
      console.log("☁️ Import timestamp cleared");
    } else {
      console.log("☁️ No import timestamp to clear");
    }
  };
  
  window.forceRefreshFromCloud = async function() {
    const cloudState = await loadFromCloud();
    if (cloudState) {
      setLocalCache(cloudState);
      console.log("☁️ Force refreshed from cloud");
      return cloudState;
    }
    return getLocalCache();
  };
  
  // ⭐ Diagnostic function
  window.testCloudConnection = async function() {
    console.log("=".repeat(50));
    console.log("☁️ CLOUD CONNECTION TEST");
    console.log("=".repeat(50));
    
    console.log("1. Supabase available:", !!window.supabase);
    if (!window.supabase) {
      console.error("❌ Supabase not loaded!");
      return false;
    }
    
    const user = await getUser();
    console.log("2. User authenticated:", !!user, user?.email);
    if (!user) {
      console.error("❌ Not logged in!");
      return false;
    }
    
    const campId = getCampId();
    console.log("3. Camp ID:", campId.substring(0, 8) + "...");
    console.log("   (Full ID):", campId);
    
    console.log("4. Testing cloud read...");
    const cloudData = await loadFromCloud();
    console.log("   Cloud data exists:", !!cloudData);
    if (cloudData) {
      console.log("   Divisions:", Object.keys(cloudData.divisions || {}).length);
      console.log("   Bunks:", (cloudData.bunks || []).length);
    }
    
    console.log("5. Testing cloud write...");
    const localData = getLocalCache();
    const saveSuccess = await saveToCloud(localData);
    console.log("   Save success:", saveSuccess);
    
    console.log("=".repeat(50));
    console.log(saveSuccess ? "✅ CLOUD CONNECTION OK" : "❌ CLOUD CONNECTION FAILED");
    console.log("=".repeat(50));
    
    return saveSuccess;
  };
  
  // ⭐ Debug function to see current state
  window.debugCloudState = function() {
    console.log("=".repeat(50));
    console.log("☁️ CLOUD STATE DEBUG");
    console.log("=".repeat(50));
    console.log("Cached Camp ID:", _cachedCampId);
    console.log("Stored Camp ID:", localStorage.getItem('campistry_user_id'));
    console.log("Initialized:", _initialized);
    console.log("Sync Pending:", _cloudSyncPending);
    console.log("Sync In Progress:", _syncInProgress);
    
    const state = getLocalCache();
    console.log("Local State Keys:", Object.keys(state));
    console.log("Divisions:", Object.keys(state.divisions || {}).length);
    console.log("Bunks:", (state.bunks || []).length);
    console.log("=".repeat(50));
    
    return state;
  };

  // Start initialization
  initialize().catch(e => console.error("Cloud bridge init failed:", e));
  
  // Re-hydrate when user signs in
  let _rehydrating = false;
  let _lastAuthTime = 0;
  
  function setupAuthListener() {
    if (!window.supabase?.auth) {
      setTimeout(setupAuthListener, 500);
      return;
    }
    
    window.supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("☁️ Auth state change:", event);
      
      const now = Date.now();
      if (now - _lastAuthTime < 2000) {
        console.log("☁️ Duplicate auth event within 2s, skipping");
        return;
      }
      _lastAuthTime = now;
      
      // Handle sign out - clear the cache
      if (event === 'SIGNED_OUT') {
        console.log("☁️ User signed out, clearing cache");
        clearCampIdCache();
        _memoryCache = null;
        _initialized = false;
        return;
      }
      
      if (event === 'SIGNED_IN' && session?.user) {
        if (_rehydrating) {
          console.log("☁️ Already re-hydrating, skipping");
          return;
        }
        _rehydrating = true;
        
        // ⭐ CRITICAL: Update camp ID cache FIRST before any queries
        updateCampIdCache(session.user.id);
        console.log("☁️ User signed in:", session.user.email);
        
        try {
          const campId = getCampId();
          console.log("☁️ Fetching data from cloud with camp_id:", campId.substring(0, 8) + "...");
          
          const startTime = Date.now();
          
          const { data, error } = await window.supabase
            .from(TABLE)
            .select("state")
            .eq("camp_id", campId)
            .single();
          
          const fetchTime = Date.now() - startTime;
          console.log(`☁️ Cloud fetch completed in ${fetchTime}ms`);
          
          if (error) {
            if (error.code !== 'PGRST116') {
              console.error("☁️ Cloud fetch error:", error.message);
            } else {
              console.log("☁️ No cloud data yet (new user)");
            }
          } else if (data?.state) {
            let cloudState = data.state;
            
            if (cloudState.app1?.divisions && Object.keys(cloudState.app1.divisions).length > 0) {
              if (!cloudState.divisions || Object.keys(cloudState.divisions).length === 0) {
                cloudState.divisions = cloudState.app1.divisions;
              }
            }
            if (cloudState.app1?.bunks && cloudState.app1.bunks.length > 0) {
              if (!cloudState.bunks || cloudState.bunks.length === 0) {
                cloudState.bunks = cloudState.app1.bunks;
              }
            }
            
            console.log("☁️ Cloud data retrieved:", {
              divisions: Object.keys(cloudState.divisions || {}).length,
              bunks: (cloudState.bunks || []).length
            });
            
            const localData = getLocalCache();
            const merged = { ...localData, ...cloudState };
            setLocalCache(merged);
            
            console.log("☁️ Local cache updated from cloud");
          }
          
          _initialized = true;
          _initializingPromise = null;
          window.__CAMPISTRY_CLOUD_READY__ = true;
          
          const hasData = Object.keys(getLocalCache().divisions || {}).length > 0;
          console.log("☁️ Post-sign-in hydration complete, hasData:", hasData);
          
          window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
            detail: { hydrated: true, hasData, afterSignIn: true }
          }));
          
        } catch (e) {
          console.error("☁️ Re-hydration error:", e);
          _initialized = true;
          _initializingPromise = null;
          window.__CAMPISTRY_CLOUD_READY__ = true;
          
          window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
            detail: { hydrated: false, hasData: false, afterSignIn: true, error: true }
          }));
        } finally {
          _rehydrating = false;
        }
      }
    });
    
    console.log("☁️ Auth listener registered");
  }
  
  setupAuthListener();
  
  // ============================================================================
  // ROTATION HISTORY FUNCTIONS
  // ============================================================================

  window.loadRotationHistory = function() {
    const g = window.loadGlobalSettings?.() || {};
    return g.rotationHistory || { bunks: {}, leagues: {} };
  };

  window.saveRotationHistory = function(history) {
    window.saveGlobalSettings?.("rotationHistory", history);
    window.forceSyncToCloud?.();
  };

  window.loadHistoricalCounts = function() {
    const g = window.loadGlobalSettings?.() || {};
    return g.historicalCounts || {};
  };

  window.saveHistoricalCounts = function(counts) {
    window.saveGlobalSettings?.("historicalCounts", counts);
    window.forceSyncToCloud?.();
  };

  window.loadYesterdayHistory = function() {
    const g = window.loadGlobalSettings?.() || {};
    return g.yesterdayHistory || {};
  };
  
  window.saveYesterdayHistory = function(history) {
    window.saveGlobalSettings?.("yesterdayHistory", history);
    window.forceSyncToCloud?.();
  };

  console.log("☁️ Cloud Bridge API ready (sync + background cloud)");

})();
