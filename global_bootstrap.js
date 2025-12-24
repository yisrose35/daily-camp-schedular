// =================================================================
// global_bootstrap.js — Campistry OS Boot Gate
// Ensures identity loads BEFORE any UI or scheduler code runs
// =================================================================
(function () {
  'use strict';

  window.__CAMPISTRY_READY__ = false;

  async function hydrate() {
    // wait for auth
    while (!window.supabase || !window.supabase.auth) {
      await new Promise(r => setTimeout(r, 30));
    }

    // force-load identity registry
    window.getGlobalDivisions();
    window.getGlobalBunks();

    window.__CAMPISTRY_READY__ = true;
    console.warn("🧠 Campistry identity spine hydrated.");
  }

  hydrate();
})();
