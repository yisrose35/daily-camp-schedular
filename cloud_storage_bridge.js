// =================================================================
// cloud_storage_bridge.js — Campistry Unified Cloud Storage Engine
// FIXED VERSION: Increased timeouts + Retry logic for large datasets
// v2.5 - Fixes "Sign-in cloud fetch timed out" on large accounts
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge v2.5 (High Latency Fix)");

  const TABLE = "camp_state";
  const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
  
  // ⭐ INCREASED TIMEOUT: 5000ms -> 20000ms (20 seconds)
  // Large datasets (like the one in your logs) need more time to download.
  const QUERY_TIMEOUT_MS = 20000; 
  
  const LEGACY_KEYS = {
    globalSettings: "campGlobalSettings_v1",
    localCache: "CAMPISTRY_LOCAL_CACHE", 
    globalRegistry: "campistry_global_registry"
  };
  
  // ============================================================================
  // UTILITY: Promise with timeout
  // ============================================================================
  function withTimeout(promise, ms, errorMessage = "Operation timed out") {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(errorMessage)), ms)
      )
    ]);
  }

  // Helper to retry operations
  async function withRetry(fn, retries = 2, delay = 1000) {
    try {
      return await fn();
    } catch (err) {
      if (retries <= 0) throw err;
      console.warn(`☁️ Operation failed, retrying... (${retries} attempts left)`);
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay);
    }
  }
  
  // ============================================================================
  // CAMP ID MANAGEMENT - User Isolation
  // ============================================================================
  
  let _cachedCampId = null;

  function getCampId() {
    if (_cachedCampId) return _cachedCampId;
    
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const storedSession = localStorage.getItem(key);
          if (storedSession) {
            const parsed = JSON.parse(storedSession);
            const userId = parsed?.user?.id || parsed?.session?.user?.id;
            if (userId) {
              _cachedCampId = userId;
              localStorage.setItem('campistry_user_id', userId);
              return _cachedCampId;
            }
          }
        }
      }
    } catch (e) {
      console.warn("☁️ getCampId: Error reading Supabase storage:", e);
    }
    
    const cachedUserId = localStorage.getItem('campistry_user_id');
    if (cachedUserId && cachedUserId !== 'demo_camp_001') {
      _cachedCampId = cachedUserId;
      return _cachedCampId;
    }
    
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

  const SCHEMA_VERSION = 2;
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
    if (localStorage.getItem(UNIFIED_CACHE_KEY)) return;
    
    let merged = {};
    try {
      const gs = JSON.parse(localStorage.getItem(LEGACY_KEYS.globalSettings) || "{}");
      merged = { ...merged, ...gs };
    } catch (e) {}
    try {
      const lc = JSON.parse(localStorage.getItem(LEGACY_KEYS.localCache) || "{}");
      merged = { ...merged, ...lc };
    } catch (e) {}
    
    if (Object.keys(merged).length > 0) {
      localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(merged));
    }
  }

  // ------------------------------------------------------------
  // Local cache operations
  // ------------------------------------------------------------
  function getLocalCache() {
    if (_memoryCache !== null) return _memoryCache;
    try {
      const raw = localStorage.getItem(UNIFIED_CACHE_KEY);
      _memoryCache = raw ? JSON.parse(raw) : {};
    } catch (e) {
      _memoryCache = {};
    }
    return _memoryCache;
  }
  
  function setLocalCache(state) {
    // Hoist app1 data if root is empty
    if (state.app1) {
      if ((!state.divisions || Object.keys(state.divisions).length === 0) && 
          state.app1.divisions) {
        state.divisions = state.app1.divisions;
      }
      if ((!state.bunks || state.bunks.length === 0) && state.app1.bunks) {
        state.bunks = state.app1.bunks;
      }
    }
    
    _memoryCache = state;
    try {
      const str = JSON.stringify(state);
      localStorage.setItem(UNIFIED_CACHE_KEY, str);
      localStorage.setItem(LEGACY_KEYS.globalSettings, str);
      localStorage.setItem(LEGACY_KEYS.localCache, str);
    } catch (e) {
      console.error("Failed to save local cache:", e);
    }
  }

  // ------------------------------------------------------------
  // Cloud operations
  // ------------------------------------------------------------
  async function getUser() {
    try {
      if (!window.supabase) return null;
      const { data, error } = await withTimeout(
        window.supabase.auth.getUser(),
        5000, // Keep short timeout for auth checks
        "getUser timed out"
      );
      if (error) return null;
      if (data?.user) updateCampIdCache(data.user.id);
      return data?.user || null;
    } catch (e) {
      return null;
    }
  }

  async function loadFromCloud() {
    try {
      if (!window.supabase) return null;
      
      const user = await getUser();
      if (!user) return null;
      
      const campId = getCampId();
      console.log("☁️ Loading from cloud for camp_id:", campId.substring(0, 8) + "...");
      
      // Retry logic added here
      const fetchOperation = async () => {
        return await window.supabase
          .from(TABLE)
          .select("state")
          .eq("camp_id", campId)
          .single();
      };

      // Use longer timeout and retry wrapper
      const { data, error } = await withTimeout(
        withRetry(fetchOperation, 1, 1000), // Retry once if it fails
        QUERY_TIMEOUT_MS,
        "Cloud load query timed out"
      );

      if (error) {
        if (error.code === 'PGRST116') {
          console.log("☁️ No cloud data found (fresh start)");
          return null;
        }
        console.error("☁️ Cloud load error:", error.message);
        return null;
      }
      
      let state = data?.state || null;
      
      // Ensure data is hoisted correctly immediately upon load
      if (state && state.app1) {
         if ((!state.divisions || Object.keys(state.divisions).length === 0) && 
            state.app1.divisions) {
          state.divisions = state.app1.divisions;
        }
        if ((!state.bunks || state.bunks.length === 0) && state.app1.bunks) {
          state.bunks = state.app1.bunks;
        }
      }
      
      return state;
    } catch (e) {
      console.error("☁️ Cloud load failed:", e.message);
      return null;
    }
  }

  async function saveToCloud(state) {
    try {
      if (!window.supabase) return false;
      const user = await getUser();
      if (!user) return false;

      const campId = getCampId();
      if (campId === "demo_camp_001") return false;

      state.schema_version = SCHEMA_VERSION;
      state.updated_at = new Date().toISOString();
      
      const stateToSave = { ...state };
      delete stateToSave._importTimestamp;
      
      // Ensure we are saving complete data
      if (stateToSave.app1) {
         if (stateToSave.app1.divisions) stateToSave.divisions = stateToSave.app1.divisions;
         if (stateToSave.app1.bunks) stateToSave.bunks = stateToSave.app1.bunks;
      }

      const { error } = await withTimeout(
        window.supabase
          .from(TABLE)
          .upsert({
            camp_id: campId,
            owner_id: user.id,
            state: stateToSave
          }, { onConflict: 'camp_id' }),
        QUERY_TIMEOUT_MS,
        "Cloud save timed out"
      );
      
      if (error) {
        console.error("☁️ Cloud save error:", error.message);
        return false;
      }
      
      console.log("☁️ ✅ Saved to cloud successfully");
      return true;
    } catch (e) {
      console.error("☁️ Cloud save failed:", e.message);
      return false;
    }
  }
  
  // Debounced cloud sync
  let _syncTimeout = null;
  let _syncInProgress = false;
  
  function scheduleCloudSync() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _syncTimeout = setTimeout(async () => {
      if (!_cloudSyncPending) return;
      if (_syncInProgress) {
        scheduleCloudSync();
        return;
      }
      _syncInProgress = true;
      _cloudSyncPending = false;
      console.log("☁️ Performing cloud sync...");
      await saveToCloud(getLocalCache());
      _syncInProgress = false;
    }, 2000); // Increased debounce to prevent rapid-fire saves
  }
  
  async function syncNow() {
    if (_syncTimeout) clearTimeout(_syncTimeout);
    _cloudSyncPending = false;
    if (_syncInProgress) await new Promise(r => setTimeout(r, 1000));
    _syncInProgress = true;
    const result = await saveToCloud(getLocalCache());
    _syncInProgress = false;
    return result;
  }

  // ------------------------------------------------------------
  // Initialize
  // ------------------------------------------------------------
  let _initializingPromise = null;
  
  async function initialize() {
    if (_initialized) return;
    if (_initializingPromise) return _initializingPromise;
    
    _initializingPromise = (async () => {
      console.log("☁️ Starting cloud bridge initialization...");
      
      try {
        migrateLegacyData();
        const localData = getLocalCache();
        
        // Try to get user
        let user = null;
        try {
          const { data } = await withTimeout(window.supabase?.auth?.getUser() || Promise.resolve({}), 3000);
          user = data?.user;
          if (user) updateCampIdCache(user.id);
        } catch (e) {}
        
        if (!user) {
          console.log("☁️ No user - using local data");
          _initialized = true;
          window.__CAMPISTRY_CLOUD_READY__ = true;
          return;
        }
        
        console.log("☁️ User authenticated, fetching from cloud...");
        // This will now use the longer timeout
        const cloudState = await loadFromCloud();
        
        if (cloudState && Object.keys(cloudState).length > 0) {
          const localTime = localData.updated_at ? new Date(localData.updated_at).getTime() : 0;
          const cloudTime = cloudState.updated_at ? new Date(cloudState.updated_at).getTime() : 0;
          
          if (cloudTime >= localTime) {
            setLocalCache({ ...localData, ...cloudState });
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
        const hasData = Object.keys(getLocalCache().divisions || {}).length > 0;
        window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
          detail: { hydrated: true, hasData }
        }));
      }
    })();
    
    return _initializingPromise;
  }

  // ------------------------------------------------------------
  // PUBLIC API
  // ------------------------------------------------------------
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
  
  window.setCloudState = async (newState, syncToCloud = true) => {
    if (!newState) return false;
    newState.updated_at = new Date().toISOString();
    setLocalCache(newState);
    if (syncToCloud) await syncNow();
    return true;
  };

  window.forceSyncToCloud = async () => {
    const state = getLocalCache();
    delete state._importTimestamp;
    setLocalCache(state);
    return await syncNow();
  };

  // ------------------------------------------------------------
  // AUTH LISTENER (The critical part for your issue)
  // ------------------------------------------------------------
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
      if (now - _lastAuthTime < 2000) return;
      _lastAuthTime = now;
      
      if (event === 'SIGNED_OUT') {
        clearCampIdCache();
        _memoryCache = null;
        _initialized = false;
        return;
      }
      
      if (event === 'SIGNED_IN' && session?.user) {
        if (_rehydrating) return;
        _rehydrating = true;
        
        updateCampIdCache(session.user.id);
        
        try {
          const campId = getCampId();
          console.log("☁️ Fetching data (High Timeout) for camp_id:", campId);
          
          const startTime = Date.now();
          
          // Use the increased timeout here too
          const fetchOp = async () => window.supabase
              .from(TABLE)
              .select("state")
              .eq("camp_id", campId)
              .single();
              
          const { data, error } = await withTimeout(
            withRetry(fetchOp, 1, 1000), // Retry once
            QUERY_TIMEOUT_MS, // 20 seconds
            "Sign-in cloud fetch timed out"
          );
          
          console.log(`☁️ Cloud fetch completed in ${Date.now() - startTime}ms`);
          
          if (error) {
            console.error("☁️ Cloud fetch error:", error.message);
          } else if (data?.state) {
            const cloudState = data.state;
            const merged = { ...getLocalCache(), ...cloudState };
            
            // Explicit hoist check
            if (merged.app1) {
                if (!merged.divisions || Object.keys(merged.divisions).length === 0) {
                    merged.divisions = merged.app1.divisions || {};
                }
                if (!merged.bunks || merged.bunks.length === 0) {
                    merged.bunks = merged.app1.bunks || [];
                }
            }
            
            setLocalCache(merged);
            console.log("☁️ Local cache updated from cloud. Items:", (merged.bunks||[]).length);
          }
          
          _initialized = true;
          window.__CAMPISTRY_CLOUD_READY__ = true;
          
          const hasData = Object.keys(getLocalCache().divisions || {}).length > 0;
          
          window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
            detail: { hydrated: true, hasData, afterSignIn: true }
          }));
          
        } catch (e) {
          console.error("☁️ Re-hydration error:", e.message);
          
          // Even on error, we must signal ready so the app doesn't hang
          _initialized = true;
          window.__CAMPISTRY_CLOUD_READY__ = true;
          window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated', { 
            detail: { hydrated: false, hasData: false, error: true }
          }));
        } finally {
          _rehydrating = false;
        }
      }
    });
  }
  
  setupAuthListener();
  initialize().catch(e => console.error("Cloud bridge init failed:", e));

  // Forward compatibility
  window.syncNow = syncNow;
  window.loadRotationHistory = () => (window.loadGlobalSettings() || {}).rotationHistory || {};
  window.saveRotationHistory = (h) => { window.saveGlobalSettings("rotationHistory", h); };

})();
