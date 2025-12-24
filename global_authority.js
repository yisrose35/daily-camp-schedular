// =================================================================
// global_authority.js — CAMPISTRY GLOBAL AUTHORITY SPINE
// This file restores Divisions & Bunks as first-class Supabase entities
// =================================================================
(function () {
  'use strict';

  const AUTH_KEY = "campistry_global_registry";

  function loadRegistry() {
    try {
      return window.supabaseGlobal?.get(AUTH_KEY) || {
        divisions: [],
        bunks: []
      };
    } catch {
      return { divisions: [], bunks: [] };
    }
  }

  function saveRegistry(reg) {
    window.supabaseGlobal?.set(AUTH_KEY, reg);
  }

  // =======================
  // PUBLIC AUTHORITY API
  // =======================
  window.getGlobalDivisions = function () {
    return loadRegistry().divisions || [];
  };

  window.getGlobalBunks = function () {
    return loadRegistry().bunks || [];
  };

  window.setGlobalDivisions = function (divs) {
    const r = loadRegistry();
    r.divisions = structuredClone(divs);
    saveRegistry(r);
  };

  window.setGlobalBunks = function (bunks) {
    const r = loadRegistry();
    r.bunks = structuredClone(bunks);
    saveRegistry(r);
  };

})();
