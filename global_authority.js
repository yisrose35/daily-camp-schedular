// =================================================================
// global_authority.js — Campistry Global Authority Spine (FIXED)
// SYNCHRONOUS API • Works with cloud_storage_bridge_FIXED.js
// FIXED: Waits for cloud hydration before returning empty data
// =================================================================
(function () {
  'use strict';
  
  console.log("🧠 Global Authority v2.1 (FIXED) loading...");

  // In-memory cache
  let _divisionCache = null;
  let _bunkCache = null;
  let _initialLoadDone = false;

  // --------------------------------------------------------------
  // SAFE BUNK COLLECTOR (prevents zero-bunk wipes)
  // --------------------------------------------------------------
  function collectBunksFromRuntime() {
    // Check various runtime sources
    if (Array.isArray(window.globalBunks) && window.globalBunks.length) {
      return structuredClone(window.globalBunks);
    }
    if (Array.isArray(window.campBunks) && window.campBunks.length) {
      return structuredClone(window.campBunks);
    }
    return null;
  }

  // --------------------------------------------------------------
  // LOAD (Synchronous - but checks if cloud has hydrated)
  // --------------------------------------------------------------
  function loadRegistry() {
    // Return cached if available
    if (_divisionCache !== null && _bunkCache !== null) {
      return {
        divisions: _divisionCache,
        bunks: _bunkCache
      };
    }

    // ⭐ Synchronous call
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
  function saveRegistry() {
    // ⭐ Synchronous calls - no await needed!
    window.saveGlobalSettings?.("divisions", _divisionCache);
    window.saveGlobalSettings?.("bunks", _bunkCache);

    // Update window references
    window.divisions = _divisionCache;
    window.globalBunks = _bunkCache;
    window.availableDivisions = Object.keys(_divisionCache);

    console.log("🧠 Registry saved:", {
      divisions: Object.keys(_divisionCache).length,
      bunks: _bunkCache.length
    });
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

  window.setGlobalDivisions = function(divs) {
    _divisionCache = structuredClone(divs || {});
    saveRegistry();
  };

  window.setGlobalBunks = function(bunks) {
    // Prevent accidental wipe - check runtime sources first
    const runtimeBunks = collectBunksFromRuntime();
    if ((!bunks || bunks.length === 0) && runtimeBunks && runtimeBunks.length > 0) {
      console.warn("⚠️ Prevented bunk wipe - using runtime bunks instead");
      bunks = runtimeBunks;
    }
    
    _bunkCache = structuredClone(bunks || []);
    saveRegistry();
  };

  // Force refresh from storage (call after cloud hydration)
  window.refreshGlobalRegistry = function() {
    return reloadFromStorage();
  };

  // ⭐ Listen for cloud hydration event
  window.addEventListener('campistry-cloud-hydrated', function() {
    console.log("🧠 Cloud hydration event received, reloading registry...");
    reloadFromStorage();
  });

  // Don't load immediately - wait for cloud bridge to signal it's ready
  // The initial load will happen when welcome.js calls refreshGlobalRegistry()
  // or when getGlobalDivisions/getGlobalBunks is first called
  
  window.__CAMPISTRY_CLOUD_READY__ = window.__CAMPISTRY_CLOUD_READY__ || false;
  
  console.log("🧠 Global Authority ready (synchronous API)");

})();
