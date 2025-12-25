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
  let _migrationDone = false;
  
  function migrateLegacyData() {
    // Only migrate once per session
    if (_migrationDone) return;
    _migrationDone = true;
    
    if (localStorage.getItem(UNIFIED_CACHE_KEY)) {
      console.log("☁️ Unified storage exists, skipping migration");
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
    // ⭐ CRITICAL: Ensure divisions/bunks are at root level
    // They might only be inside app1
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
        console.log("☁️ Supabase not available yet");
        return null;
      }
      const { data, error } = await window.supabase.auth.getUser();
      if (error) {
        // Auth session missing is expected before sign-in, don't log as error
        if (error.message?.includes('session')) {
          console.log("☁️ No auth session yet (user not signed in)");
        } else {
          console.warn("☁️ getUser error:", error.message);
        }
        return null;
      }
      if (data?.user) {
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
        // No user is expected before sign-in, don't log as warning
        console.log("☁️ No user yet - will load from cloud after sign-in");
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
      
      let state = data?.state || null;
      
      // ⭐ CRITICAL: Ensure divisions/bunks are at root level
      // They might be stored in app1 from older saves
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
        bunks: (state?.bunks || []).length,
        app1_divisions: Object.keys(state?.app1?.divisions || {}).length
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

      // Add metadata
      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      
      // Remove internal flags before saving
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;
      
      // ⭐ CRITICAL: Ensure divisions and bunks are at root level
      // They might only be inside app1, so copy them up
      if (stateToSave.app1) {
        if (stateToSave.app1.divisions && Object.keys(stateToSave.app1.divisions).length > 0) {
          stateToSave.divisions = stateToSave.app1.divisions;
        }
        if (stateToSave.app1.bunks && stateToSave.app1.bunks.length > 0) {
          stateToSave.bunks = stateToSave.app1.bunks;
        }
      }

      console.log("☁️ Saving to cloud:", {
        camp_id: CAMP_ID,
        user_id: user.id,
        divisions: Object.keys(stateToSave.divisions || {}).length,
        bunks: (stateToSave.bunks || []).length,
        app1_divisions: Object.keys(stateToSave.app1?.divisions || {}).length
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
  let _initializingPromise = null;
  
  async function initialize() {
    // If already initialized, return immediately
    if (_initialized) {
      console.log("☁️ Already initialized, skipping");
      return;
    }
    
    // If currently initializing, wait for that to complete
    if (_initializingPromise) {
      console.log("☁️ Already initializing, waiting...");
      return _initializingPromise;
    }
    
    // Create a promise that will be resolved when done
    _initializingPromise = (async () => {
      console.log("☁️ Starting cloud bridge initialization...");
      
      try {
        // Step 1: Migrate legacy data (only once)
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
          return; // Will set flags in finally block
        }
        
        // Step 4: Try to hydrate from cloud (with timeout protection)
        let hydrated = false;
        try {
          // Add timeout to cloud load
          const cloudPromise = loadFromCloud();
          const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
              console.log("☁️ Cloud load timeout after 5s, using local cache");
              resolve(null);
            }, 5000);
          });
          
          const cloudState = await Promise.race([cloudPromise, timeoutPromise]);
          
          if (cloudState && Object.keys(cloudState).length > 0) {
            // Compare timestamps if available
            const localTime = localData.updated_at ? new Date(localData.updated_at).getTime() : 0;
            const cloudTime = cloudState.updated_at ? new Date(cloudState.updated_at).getTime() : 0;
            
            if (cloudTime > localTime) {
              // Cloud is newer - merge with cloud winning
              const merged = { ...localData, ...cloudState };
              setLocalCache(merged);
              console.log("☁️ Hydrated from cloud (cloud was newer)");
              hydrated = true;
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
              hydrated = true;
            }
          } else {
            console.log("☁️ No cloud data available, using local cache");
          }
        } catch (e) {
          console.warn("☁️ Cloud hydration failed, using local cache:", e);
        }
        
        // ⭐ Dispatch event so other modules know cloud is ready and can reload
        console.log("☁️ Initialization complete, dispatching cloud-hydrated event");
        window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
          detail: { hydrated, hasData: Object.keys(getLocalCache().divisions || {}).length > 0 }
        }));
        
      } catch (e) {
        console.error("☁️ Initialize error:", e);
      } finally {
        // Always mark as initialized and ready
        _initialized = true;
        window.__CAMPISTRY_CLOUD_READY__ = true;
        _initializingPromise = null;
        console.log("☁️ Cloud bridge ready");
      }
    })();
    
    return _initializingPromise;
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
  
  // ⭐ CRITICAL: Re-hydrate when user signs in
  // The initial load might fail if user isn't authenticated yet
  let _rehydrating = false;
  let _lastAuthTime = 0;
  
  function setupAuthListener() {
    if (!window.supabase?.auth) {
      // Supabase not ready yet, try again
      setTimeout(setupAuthListener, 500);
      return;
    }
    
    window.supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("☁️ Auth state change:", event);
      
      // Prevent duplicate handling within 2 seconds
      const now = Date.now();
      if (now - _lastAuthTime < 2000) {
        console.log("☁️ Duplicate auth event within 2s, skipping");
        return;
      }
      _lastAuthTime = now;
      
      if (event === 'SIGNED_IN' && session?.user) {
        // Prevent concurrent re-hydrations
        if (_rehydrating) {
          console.log("☁️ Already re-hydrating, skipping");
          return;
        }
        _rehydrating = true;
        
        console.log("☁️ User signed in, re-hydrating from cloud...");
        
        try {
          // Reset initialization flag to allow re-fetch
          _initialized = false;
          
          // DON'T clear memory cache - keep local data as fallback
          // _memoryCache = null;
          
          // Re-initialize with timeout protection
          const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
              console.log("☁️ Re-hydration timeout after 5s, completing anyway");
              resolve('timeout');
            }, 5000);
          });
          
          const initPromise = initialize();
          
          await Promise.race([initPromise, timeoutPromise]);
          
          // Ensure flags are set even if we timed out
          _initialized = true;
          window.__CAMPISTRY_CLOUD_READY__ = true;
          
          // Notify app to refresh
          const hasData = Object.keys(getLocalCache().divisions || {}).length > 0;
          console.log("☁️ Post-sign-in hydration complete, hasData:", hasData);
          
          window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
            detail: { hydrated: true, hasData, afterSignIn: true }
          }));
          
        } catch (e) {
          console.error("☁️ Re-hydration error:", e);
          // Still mark as ready so app can proceed
          _initialized = true;
          window.__CAMPISTRY_CLOUD_READY__ = true;
        } finally {
          _rehydrating = false;
        }
      }
    });
    
    console.log("☁️ Auth listener registered");
  }
  
  // Setup auth listener
  setupAuthListener();
  
  console.log("☁️ Cloud Bridge API ready (sync + background cloud)");

})();
