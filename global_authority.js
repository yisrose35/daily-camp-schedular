// =================================================================
// global_authority.js — Campistry Cloud Authority Spine
// LOCAL CACHE + CANONICAL CLOUD PERSISTENCE
// =================================================================
(function () {
  'use strict';

  const AUTH_KEY = "campistry_global_registry";

  let _cache = null;

  // --------------------------------------------------------------
  // LOAD (cloud-first)
  // --------------------------------------------------------------
  async function loadRegistry() {
    try {
      if (_cache) return _cache;

      const cloud = await window.loadGlobalSettings();
      if (cloud && (cloud.divisions || cloud.bunks)) {
        _cache = {
          divisions: cloud.divisions || {},
          bunks: cloud.bunks || []
        };
        localStorage.setItem(AUTH_KEY, JSON.stringify(_cache));
        return _cache;
      }

      const stored = localStorage.getItem(AUTH_KEY);
      _cache = stored ? JSON.parse(stored) : { divisions: {}, bunks: [] };
      return _cache;
    } catch (e) {
      console.error("Failed to load registry:", e);
      return { divisions: {}, bunks: [] };
    }
  }

  // --------------------------------------------------------------
  // SAVE (dual write)
  // --------------------------------------------------------------
  async function saveRegistry(reg) {
    try {
      _cache = reg;
      localStorage.setItem(AUTH_KEY, JSON.stringify(reg));
      await window.saveGlobalSettings("divisions", reg.divisions);
      await window.saveGlobalSettings("bunks", reg.bunks);
    } catch (e) {
      console.error("Failed to save registry:", e);
    }
  }

  // --------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------
  window.getGlobalDivisions = function () {
    return loadRegistry().divisions || {};
  };

  window.getGlobalBunks = function () {
    return loadRegistry().bunks || [];
  };

  window.setGlobalDivisions = function (divs) {
    loadRegistry().then(reg => {
      reg.divisions = structuredClone(divs || {});
      saveRegistry(reg);
      console.log("☁️ Divisions saved to cloud:", Object.keys(reg.divisions).length);
    });
  };

  window.setGlobalBunks = function (bunks) {
    loadRegistry().then(reg => {
      reg.bunks = structuredClone(bunks || []);
      saveRegistry(reg);
      console.log("☁️ Bunks saved to cloud:", reg.bunks.length);
    });
  };

  console.log("🧠 Global Authority cloud spine initialized");

})();
