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
      const { data } = await window.supabase?.auth?.getUser?.();
      return data?.user || null;
    } catch (e) {
      console.warn("Failed to get user:", e);
      return null;
    }
  }

  async function loadFromCloud() {
    try {
      if (!window.supabase) return null;
      
      const { data, error } = await window.supabase
        .from(TABLE)
        .select("state")
        .eq("camp_id", CAMP_ID)
        .single();

      if (error) {
        console.warn("Cloud load error:", error.message);
        return null;
      }
      
      return data?.state || null;
    } catch (e) {
      console.warn("Cloud load failed:", e);
      return null;
    }
  }

  async function saveToCloud(state) {
    try {
      if (!window.supabase) return;
      
      const user = await getUser();
      if (!user) {
        console.warn("Cannot save to cloud: no authenticated user");
        return;
      }

      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();

      const { error } = await window.supabase.from(TABLE).upsert({
        camp_id: CAMP_ID,
        owner_id: user.id,
        state
      });
      
      if (error) {
        console.error("Cloud save error:", error.message);
      } else {
        console.log("☁️ Saved to cloud");
      }
    } catch (e) {
      console.error("Cloud save failed:", e);
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
    getLocalCache();
    
    // Step 3: Try to hydrate from cloud (async, non-blocking)
    try {
      const cloudState = await loadFromCloud();
      if (cloudState && Object.keys(cloudState).length > 0) {
        // Cloud has data - merge with local (cloud wins for conflicts)
        const local = getLocalCache();
        const merged = { ...local, ...cloudState };
        setLocalCache(merged);
        console.log("☁️ Hydrated from cloud");
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
    await saveToCloud(getLocalCache());
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

  // Start initialization
  initialize().catch(e => console.error("Cloud bridge init failed:", e));
  
  console.log("☁️ Cloud Bridge API ready (sync + background cloud)");

})();
