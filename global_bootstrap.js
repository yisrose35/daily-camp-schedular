// =================================================================
// global_bootstrap.js — Campistry OS Boot Gate
// FIXED VERSION: Simplified synchronous boot
// =================================================================
(function () {
  'use strict';

  window.__CAMPISTRY_READY__ = false;

  function hydrate() {
    try {
      // Initialize the global registry (loads from localStorage)
      const divisions = window.getGlobalDivisions?.() || {};
      const bunks = window.getGlobalBunks?.() || [];
      
      console.log("📦 Boot data:", {
        divisions: Object.keys(divisions).length,
        bunks: bunks.length
      });

      window.__CAMPISTRY_READY__ = true;
      console.log("🧠 Campistry identity spine hydrated.");
      
    } catch (e) {
      console.error("Boot hydration failed:", e);
      window.__CAMPISTRY_READY__ = true;
    }
  }

  // Run immediately
  hydrate();

})();
