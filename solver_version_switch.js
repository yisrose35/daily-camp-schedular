// =============================================================================
// solver_version_switch.js — feature flag wrapper for solver v1 / v2
// =============================================================================
// Reads `globalSettings.app1.solverVersion` (default 'v1') and routes
// runAutoScheduler() to the appropriate implementation.
//
// Toggle in console:
//   const g = window.loadGlobalSettings(); g.app1.solverVersion = 'v2';
//   window.saveGlobalSettings('app1', g.app1);
//
// Loads AFTER scheduler_core_auto.js and scheduler_core_solver_v2.js so both
// `runAutoScheduler` (v1) and `runAutoSchedulerV2` (v2) are present at wrap time.
// =============================================================================
(function () {
  'use strict';

  // Wait until v1 has installed window.runAutoScheduler. flow.html load order
  // already ensures this — but be defensive.
  if (typeof window.runAutoScheduler !== 'function') {
    console.warn('[SolverSwitch] runAutoScheduler not yet defined — switch will install when available');
    document.addEventListener('DOMContentLoaded', install);
    return;
  }
  install();

  function install() {
    if (window._runAutoSchedulerV1) return; // already installed
    if (typeof window.runAutoScheduler !== 'function') return;

    // Capture v1 reference under a stable name so v2 can use it as its seed.
    window._runAutoSchedulerV1 = window.runAutoScheduler;

    // Replace window.runAutoScheduler with the dispatcher.
    window.runAutoScheduler = async function (layers, options) {
      const g = window.loadGlobalSettings?.() || {};
      const v = (g.app1?.solverVersion || 'v1').toLowerCase();

      if (v === 'v3' && typeof window.runAutoSchedulerV3 === 'function') {
        console.log('[SolverSwitch] routing to v3');
        return window.runAutoSchedulerV3(layers, options);
      }
      if (v === 'v2' && typeof window.runAutoSchedulerV2 === 'function') {
        console.log('[SolverSwitch] routing to v2');
        return window.runAutoSchedulerV2(layers, options);
      }
      return window._runAutoSchedulerV1(layers, options);
    };

    console.log('[SolverSwitch] installed. Default = v1. Toggle via globalSettings.app1.solverVersion = "v1"|"v2"|"v3".');
  }
})();
