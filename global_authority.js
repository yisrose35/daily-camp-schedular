// =================================================================
// global_authority.js — CAMPISTRY GLOBAL AUTHORITY SPINE
// FIXED VERSION: Uses localStorage (the original used non-existent supabaseGlobal API)
// =================================================================
(function () {
  'use strict';

  const AUTH_KEY = "campistry_global_registry";
  
  // Internal state cache
  let _cache = null;

  // ===================================================================
  // STORAGE LAYER (localStorage with future Supabase sync)
  // ===================================================================
  function loadRegistry() {
    try {
      // Check cache first
      if (_cache) return _cache;
      
      // Load from localStorage
      const stored = localStorage.getItem(AUTH_KEY);
      _cache = stored ? JSON.parse(stored) : { divisions: {}, bunks: [] };
      
      // Ensure proper structure
      if (!_cache.divisions) _cache.divisions = {};
      if (!_cache.bunks) _cache.bunks = [];
      
      return _cache;
    } catch (e) {
      console.error("Failed to load registry:", e);
      return { divisions: {}, bunks: [] };
    }
  }

  function saveRegistry(reg) {
    try {
      _cache = reg;
      localStorage.setItem(AUTH_KEY, JSON.stringify(reg));
    } catch (e) {
      console.error("Failed to save registry:", e);
    }
  }

  // ===================================================================
  // PUBLIC AUTHORITY API
  // ===================================================================
  
  window.getGlobalDivisions = function () {
    const reg = loadRegistry();
    return reg.divisions || {};
  };

  window.getGlobalBunks = function () {
    const reg = loadRegistry();
    return reg.bunks || [];
  };

  window.setGlobalDivisions = function (divs) {
    const reg = loadRegistry();
    reg.divisions = structuredClone(divs || {});
    saveRegistry(reg);
    console.log("✓ Divisions saved:", Object.keys(reg.divisions).length);
  };

  window.setGlobalBunks = function (bunks) {
    const reg = loadRegistry();
    reg.bunks = structuredClone(bunks || []);
    saveRegistry(reg);
    console.log("✓ Bunks saved:", reg.bunks.length);
  };

  // ===================================================================
  // INITIALIZATION
  // ===================================================================
  console.log("🧠 Global Authority initialized");
  loadRegistry();

})();
