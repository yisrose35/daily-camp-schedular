// =================================================================
// global_authority.js — Campistry Global Authority Spine v2.2
// =================================================================
// SYNCHRONOUS API • Works with integration_hooks.js v6.0
// 
// FIXES IN v2.2:
// - ★ Properly triggers batched cloud sync after saves
// - ★ Uses forceSyncToCloud for immediate persistence when needed
// - ★ Better logging for sync status
// =================================================================
(function () {
  'use strict';
  
  console.log("🧠 Global Authority v2.2 loading...");

  // In-memory cache
  let _divisionCache = null;
  let _bunkCache = null;
  let _initialLoadDone = false;

  // --------------------------------------------------------------
  // SAFE BUNK COLLECTOR (prevents zero-bunk wipes)
  // --------------------------------------------------------------
  function collectBunksFromRuntime() {
    if (Array.isArray(window.globalBunks) && window.globalBunks.length) {
      return structuredClone(window.globalBunks);
    }
    if (Array.isArray(window.campBunks) && window.campBunks.length) {
      return structuredClone(window.campBunks);
    }
    return null;
  }

  // --------------------------------------------------------------
  // LOAD (Synchronous - returns cached/local data)
  // --------------------------------------------------------------
  function loadRegistry() {
    // Return cached if available
    if (_divisionCache !== null && _bunkCache !== null) {
      return {
        divisions: _divisionCache,
        bunks: _bunkCache
      };
    }

    // Synchronous call to loadGlobalSettings
    const settings = window.loadGlobalSettings?.() || {};
    
    _divisionCache = structuredClone(settings.divisions || {});
    _bunkCache = structuredClone(settings.bunks || []);

    // Also sync to window for legacy compatibility
    window.divisions = _divisionCache;
    window.globalBunks = _bunkCache;
    window.availableDivisions = Object.keys(_divisionCache);

    console.log("🧠 Registry loaded:", {
      divisions: Object.keys(_divisionCache).length,
      bunks: _bunkCache.length
    });
    
    _initialLoadDone = true;
    
    return {
      divisions: _divisionCache,
      bunks: _bunkCache
    };
  }

  // --------------------------------------------------------------
  // RELOAD FROM STORAGE (call after cloud hydration)
  // --------------------------------------------------------------
  function reloadFromStorage() {
    console.log("🧠 Reloading registry from storage...");
    
    // Clear cache to force re-read
    _divisionCache = null;
    _bunkCache = null;
    
    // Reload
    const result = loadRegistry();
    
    // Notify app to refresh UI
    if (result.divisions && Object.keys(result.divisions).length > 0) {
      console.log("🧠 Registry reloaded with data, triggering UI refresh...");
      
      // Re-init UI components if they exist
      setTimeout(() => {
        window.initApp1?.();
        window.initLeagues?.();
        window.initScheduleSystem?.();
        window.updateTable?.();
      }, 100);
    }
    
    return result;
  }

  // --------------------------------------------------------------
  // SAVE (Synchronous with background cloud sync)
  // --------------------------------------------------------------
  function saveRegistry(immediate = false) {
    // Save divisions
    window.saveGlobalSettings?.("divisions", _divisionCache);
    
    // Save bunks
    window.saveGlobalSettings?.("bunks", _bunkCache);

    // Update window references
    window.divisions = _divisionCache;
    window.globalBunks = _bunkCache;
    window.availableDivisions = Object.keys(_divisionCache);

    console.log("🧠 Registry saved:", {
      divisions: Object.keys(_divisionCache).length,
      bunks: _bunkCache.length,
      syncMode: immediate ? 'immediate' : 'batched'
    });

    // ★ If immediate sync requested, force it now
    if (immediate && typeof window.forceSyncToCloud === 'function') {
      console.log("🧠 Triggering immediate cloud sync...");
      window.forceSyncToCloud().catch(err => {
        console.warn("🧠 Immediate sync failed:", err);
      });
    }
  }

  // --------------------------------------------------------------
  // PUBLIC API (All Synchronous)
  // --------------------------------------------------------------
  
  window.getGlobalDivisions = function() {
    if (_divisionCache === null) loadRegistry();
    return _divisionCache || {};
  };
  
  window.getGlobalBunks = function() {
    if (_bunkCache === null) loadRegistry();
    return _bunkCache || [];
  };

  window.setGlobalDivisions = function(divs, immediate = false) {
    _divisionCache = structuredClone(divs || {});
    saveRegistry(immediate);
  };

  window.setGlobalBunks = function(bunks, immediate = false) {
    // Prevent accidental wipe - check runtime sources first
    const runtimeBunks = collectBunksFromRuntime();
    if ((!bunks || bunks.length === 0) && runtimeBunks && runtimeBunks.length > 0) {
      console.warn("⚠️ Prevented bunk wipe - using runtime bunks instead");
      bunks = runtimeBunks;
    }
    
    _bunkCache = structuredClone(bunks || []);
    saveRegistry(immediate);
  };

  // Force refresh from storage (call after cloud hydration)
  window.refreshGlobalRegistry = function() {
    return reloadFromStorage();
  };

  // ★ NEW: Force immediate sync to cloud
  window.syncGlobalRegistryToCloud = async function() {
    console.log("🧠 Force syncing registry to cloud...");
    saveRegistry(true);
    if (typeof window.forceSyncToCloud === 'function') {
      return await window.forceSyncToCloud();
    }
    return true;
  };

  // Listen for cloud hydration event
  window.addEventListener('campistry-cloud-hydrated', function() {
    console.log("🧠 Cloud hydration event received, reloading registry...");
    reloadFromStorage();
  });

  // Listen for settings sync completion
  window.addEventListener('campistry-settings-synced', function(e) {
    const keys = e.detail?.keys || [];
    if (keys.includes('divisions') || keys.includes('bunks')) {
      console.log("🧠 Registry synced to cloud successfully");
    }
  });

  window.__CAMPISTRY_CLOUD_READY__ = window.__CAMPISTRY_CLOUD_READY__ || false;
  
  console.log("🧠 Global Authority v2.2 ready");

})();
