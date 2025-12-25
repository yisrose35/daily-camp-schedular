// =================================================================
// global_authority.js — Campistry Cloud Authority Spine
// CLOUD-FIRST • NO LOCAL OVERWRITE • LIVE SaaS MODE
// =================================================================
(function () {
  'use strict';

  const AUTH_KEY = "campistry_global_registry";
  let _cache = null;

  // --------------------------------------------------------------
  // SAFE BUNK COLLECTOR (prevents zero-bunk wipes)
  // --------------------------------------------------------------
  function collectBunks() {
    if (Array.isArray(window.getGlobalBunks?.()) && window.getGlobalBunks().length)
      return structuredClone(window.getGlobalBunks());

    if (Array.isArray(window.globalBunks) && window.globalBunks.length)
      return structuredClone(window.globalBunks);

    if (Array.isArray(window.campBunks) && window.campBunks.length)
      return structuredClone(window.campBunks);

    const gs = window.loadGlobalSettings?.() || {};
    if (Array.isArray(gs.bunks) && gs.bunks.length)
      return structuredClone(gs.bunks);

    return [];
  }

  // --------------------------------------------------------------
  // LOAD
  // --------------------------------------------------------------
  async function loadRegistry() {
    if (_cache) return _cache;

    const cloud = await window.loadGlobalSettings?.() || {};
    _cache = {
      divisions: structuredClone(cloud.divisions || {}),
      bunks: structuredClone(cloud.bunks || [])
    };

    localStorage.setItem(AUTH_KEY, JSON.stringify(_cache));
    return _cache;
  }

  // --------------------------------------------------------------
  // SAVE
  // --------------------------------------------------------------
  async function saveRegistry(reg) {
    _cache = reg;
    localStorage.setItem(AUTH_KEY, JSON.stringify(reg));

    await window.saveGlobalSettings("divisions", reg.divisions);
    await window.saveGlobalSettings("bunks", reg.bunks);

    console.log("☁️ Cloud Registry Saved:", {
      divisions: Object.keys(reg.divisions).length,
      bunks: reg.bunks.length
    });
  }

  // --------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------
  window.getGlobalDivisions = () => _cache?.divisions || {};
  window.getGlobalBunks = () => _cache?.bunks || [];

  window.setGlobalDivisions = async function (divs) {
    const reg = await loadRegistry();
    reg.divisions = structuredClone(divs || {});
    await saveRegistry(reg);
  };

  window.setGlobalBunks = async function (bunks) {
    const reg = await loadRegistry();
    reg.bunks = collectBunks().length ? collectBunks() : structuredClone(bunks || []);
    await saveRegistry(reg);
  };

  console.log("🧠 Global Authority cloud spine initialized");
})();
