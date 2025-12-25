// =================================================================
// global_bootstrap.js — Campistry OS Boot Gate (CLOUD-FIRST)
// =================================================================
(function () {
  'use strict';

  window.__CAMPISTRY_READY__ = false;

  async function hydrate() {
    try {
      // 🔥 Canonical cloud hydration
      const state = await window.loadGlobalSettings();

      // Re-hydrate local cache for offline safety
      localStorage.setItem("CAMPISTRY_LOCAL_CACHE", JSON.stringify(state || {}));

      // Apply canonical state to global registries
      if (state?.divisions) window.setGlobalDivisions?.(state.divisions);
      if (state?.bunks) window.setGlobalBunks?.(state.bunks);
      if (state?.fields) window.setGlobalFields?.(state.fields);
      if (state?.leagues) window.setGlobalLeagues?.(state.leagues);
      if (state?.daily_overrides) window.setGlobalDailyOverrides?.(state.daily_overrides);

      console.log("☁️ Cloud boot state loaded:", Object.keys(state || {}).length);

      window.__CAMPISTRY_READY__ = true;
      console.log("🧠 Campistry cloud spine hydrated.");

    } catch (e) {
      console.error("Cloud boot failed, falling back to local skeleton:", e);
      window.__CAMPISTRY_READY__ = true;
    }
  }

  hydrate();
})();
