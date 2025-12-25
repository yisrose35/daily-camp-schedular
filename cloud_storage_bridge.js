// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// FIXED VERSION: Proper sync/async handling + consolidated storage
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v2.0 (FIXED)");

  const TABLE = "camp_state";
  
  // ⭐ UNIFIED storage key - consolidates all previous keys
  const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
  
  // Legacy keys we'll migrate from (read-only, for migration)
  const LEGACY_KEYS = {
    globalSettings: "campGlobalSettings_v1",
    localCache: "CAMPISTRY_LOCAL_CACHE", 
    globalRegistry: "campistry_global_registry"
  };
  
  const CAMP_ID = "fc00ba21-bfb0-4c34-b084-2471bd77d8f9";
  const SCHEMA_VERSION = 2;

  // In-memory cache for synchronous access
  let _memoryCache = null;
  let _cloudSyncPending = false;
  let _initialized = false;

  // ------------------------------------------------------------
  // Migrate from legacy keys (one-time)
  // ------------------------------------------------------------
  function migrateLegacyData() {
    if (localStorage.getItem(UNIFIED_CACHE_KEY)) {
      return; // Already migrated
    }
    
    console.log("🔄 Migrating legacy storage keys...");
    
    let merged = {};
    
    // Priority order: globalSettings > localCache > globalRegistry
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
      // Global registry has divisions/bunks at root level
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
    _memoryCache = state;
    try {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(state));
      
      // ⭐ Also write to legacy keys for backward compatibility
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
        console.warn("☁️ Supabase not available");
        return null;
      }
      const { data, error } = await window.supabase.auth.getUser();
      if (error) {
        console.warn("☁️ getUser error:", error.message);
        return null;
      }
      console.log("☁️ Current user:", data?.user?.email || "none");
      return data?.user || null;
    } catch (e) {
      console.warn("☁️ Failed to get user:", e);
      return null;
    }
  }

  async function loadFromCloud() {
    try {
      if (!window.supabase) {
        console.warn("☁️ Supabase not available for load");
        return null;
      }
      
      const user = await getUser();
      if (!user) {
        console.warn("☁️ No user - cannot load from cloud");
        return null;
      }
      
      console.log("☁️ Loading from cloud for user:", user.id);
      
      const { data, error } = await window.supabase
        .from(TABLE)
        .select("state")
        .eq("camp_id", CAMP_ID)
        .single();

      if (error) {
        // PGRST116 = no rows found, which is OK for new users
        if (error.code === 'PGRST116') {
          console.log("☁️ No cloud data found (new user or first sync)");
          return null;
        }
        console.error("☁️ Cloud load error:", error.message, error.code);
        return null;
      }
      
      console.log("☁️ Cloud data loaded:", {
        hasState: !!data?.state,
        divisions: Object.keys(data?.state?.divisions || {}).length,
        bunks: (data?.state?.bunks || []).length
      });
      
      return data?.state || null;
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

      // Add metadata
      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      
      // Remove internal flags before saving
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;

      console.log("☁️ Saving to cloud:", {
        camp_id: CAMP_ID,
        user_id: user.id,
        divisions: Object.keys(stateToSave.divisions || {}).length,
        bunks: (stateToSave.bunks || []).length
      });

      const { data, error } = await window.supabase
        .from(TABLE)
        .upsert({
          camp_id: CAMP_ID,
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
  function scheduleCloudSync() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _syncTimeout = setTimeout(async () => {
      if (!_cloudSyncPending) return;
      _cloudSyncPending = false;
      await saveToCloud(getLocalCache());
    }, 2000); // 2 second debounce
  }

  // ------------------------------------------------------------
  // Initialize - migrate + hydrate from cloud
  // ------------------------------------------------------------
  async function initialize() {
    if (_initialized) return;
    
    // Step 1: Migrate legacy data
    migrateLegacyData();
    
    // Step 2: Load from local cache first (instant)
    const localData = getLocalCache();
    
    // Step 3: Check if we just imported data (has import timestamp within last 30 seconds)
    const justImported = localData._importTimestamp && 
                         (Date.now() - localData._importTimestamp) < 30000;
    
    if (justImported) {
      console.log("☁️ Recently imported data detected - skipping cloud overwrite");
      // Clear the import flag
      delete localData._importTimestamp;
      setLocalCache(localData);
      _initialized = true;
      window.__CAMPISTRY_CLOUD_READY__ = true;
      return;
    }
    
    // Step 4: Try to hydrate from cloud (async, non-blocking)
    try {
      const cloudState = await loadFromCloud();
      if (cloudState && Object.keys(cloudState).length > 0) {
        // Compare timestamps if available
        const localTime = localData.updated_at ? new Date(localData.updated_at).getTime() : 0;
        const cloudTime = cloudState.updated_at ? new Date(cloudState.updated_at).getTime() : 0;
        
        if (cloudTime > localTime) {
          // Cloud is newer - merge with cloud winning
          const merged = { ...localData, ...cloudState };
          setLocalCache(merged);
          console.log("☁️ Hydrated from cloud (cloud was newer)");
        } else if (localTime > cloudTime) {
          // Local is newer - push to cloud
          console.log("☁️ Local data is newer - will sync to cloud");
          _cloudSyncPending = true;
          scheduleCloudSync();
        } else {
          // Same time or no timestamps - merge with cloud winning (safe default)
          const merged = { ...localData, ...cloudState };
          setLocalCache(merged);
          console.log("☁️ Hydrated from cloud");
        }
      }
    } catch (e) {
      console.warn("Cloud hydration failed, using local cache:", e);
    }
    
    _initialized = true;
    window.__CAMPISTRY_CLOUD_READY__ = true;
  }

  // ------------------------------------------------------------
  // PUBLIC API - SYNCHRONOUS (with background cloud sync)
  // ------------------------------------------------------------
  
  // ⭐ SYNCHRONOUS loadGlobalSettings
  window.loadGlobalSettings = function() {
    return getLocalCache();
  };
  
  // ⭐ SYNCHRONOUS saveGlobalSettings  
  window.saveGlobalSettings = function(key, value) {
    const state = getLocalCache();
    state[key] = value;
    setLocalCache(state);
    
    // Schedule background cloud sync
    _cloudSyncPending = true;
    scheduleCloudSync();
    
    return state;
  };
  
  // Async version for explicit cloud operations
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
  
  // Force immediate cloud sync
  window.forceSyncToCloud = async function() {
    _cloudSyncPending = false;
    if (_syncTimeout) clearTimeout(_syncTimeout);
    const success = await saveToCloud(getLocalCache());
    return success;
  };
  
  // Force cloud refresh
  window.forceRefreshFromCloud = async function() {
    const cloudState = await loadFromCloud();
    if (cloudState) {
      setLocalCache(cloudState);
      console.log("☁️ Force refreshed from cloud");
      return cloudState;
    }
    return getLocalCache();
  };
  
  // ⭐ Diagnostic function - call from console to test cloud
  window.testCloudConnection = async function() {
    console.log("=".repeat(50));
    console.log("☁️ CLOUD CONNECTION TEST");
    console.log("=".repeat(50));
    
    // Test 1: Supabase available?
    console.log("1. Supabase available:", !!window.supabase);
    if (!window.supabase) {
      console.error("❌ Supabase not loaded!");
      return false;
    }
    
    // Test 2: User authenticated?
    const user = await getUser();
    console.log("2. User authenticated:", !!user, user?.email);
    if (!user) {
      console.error("❌ Not logged in!");
      return false;
    }
    
    // Test 3: Can read from cloud?
    console.log("3. Testing cloud read...");
    const cloudData = await loadFromCloud();
    console.log("   Cloud data exists:", !!cloudData);
    if (cloudData) {
      console.log("   Divisions:", Object.keys(cloudData.divisions || {}).length);
      console.log("   Bunks:", (cloudData.bunks || []).length);
    }
    
    // Test 4: Can write to cloud?
    console.log("4. Testing cloud write...");
    const localData = getLocalCache();
    const saveSuccess = await saveToCloud(localData);
    console.log("   Save success:", saveSuccess);
    
    console.log("=".repeat(50));
    console.log(saveSuccess ? "✅ CLOUD CONNECTION OK" : "❌ CLOUD CONNECTION FAILED");
    console.log("=".repeat(50));
    
    return saveSuccess;
  };

  // Start initialization
  initialize().catch(e => console.error("Cloud bridge init failed:", e));
  
  console.log("☁️ Cloud Bridge API ready (sync + background cloud)");

})();
