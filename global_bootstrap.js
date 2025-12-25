// =================================================================
// global_bootstrap.js — Campistry Cloud Boot Gate (FINAL)
// =================================================================
(function () {
  'use strict';

  async function hydrate() {
    if (window.__CAMPISTRY_HYDRATED__) return;

    const state = await window.loadGlobalSettings();
    localStorage.setItem("CAMPISTRY_LOCAL_CACHE", JSON.stringify(state || {}));

    if (state?.divisions) window.setGlobalDivisions?.(state.divisions);
    if (state?.bunks) window.setGlobalBunks?.(state.bunks);
    if (state?.fields) window.setGlobalFields?.(state.fields);
    if (state?.leagues) window.setGlobalLeagues?.(state.leagues);

    window.__CAMPISTRY_HYDRATED__ = true;
    console.log("☁️ Campistry hydrated from cloud");
  }

  hydrate();
})();
