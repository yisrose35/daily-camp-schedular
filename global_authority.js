// =================================================================
// global_authority.js — Campistry Global Authority Spine (FIXED)
// SYNCHRONOUS API • Works with cloud_storage_bridge_FIXED.js
// =================================================================
(function () {
  'use strict';
  
  console.log("🧠 Global Authority v2.0 (FIXED) loading...");

  // In-memory cache
  let _divisionCache = null;
  let _bunkCache = null;

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
  // LOAD (Synchronous)
  // --------------------------------------------------------------
  function loadRegistry() {
    // Return cached if available
    if (_divisionCache !== null && _bunkCache !== null) {
      return {
        divisions: _divisionCache,
        bunks: _bunkCache
      };
    }

    // ⭐ Synchronous call - no await needed!
    const settings = window.loadGlobalSettings?.() || {};
    
    _divisionCache = structuredClone(settings.divisions || {});
    _bunkCache = structuredClone(settings.bunks || []);

    // Also sync to window for legacy compatibility
    window.divisions = _divisionCache;
    window.globalBunks = _bunkCache;
    window.availableDivisions = Object.keys(_divisionCache);

    window.__CAMPISTRY_CLOUD_READY__ = true;
    
    console.log("🧠 Registry loaded:", {
      divisions: Object.keys(_divisionCache).length,
      bunks: _bunkCache.length
    });
    
    return {
      divisions: _divisionCache,
      bunks: _bunkCache
    };
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

  // Force refresh from storage
  window.refreshGlobalRegistry = function() {
    _divisionCache = null;
    _bunkCache = null;
    return loadRegistry();
  };

  // Initialize immediately
  loadRegistry();
  
  console.log("🧠 Global Authority ready (synchronous API)");

})();
