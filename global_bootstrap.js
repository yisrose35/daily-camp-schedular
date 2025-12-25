// =================================================================
// global_bootstrap.js — Campistry Hydration (FIXED/SIMPLIFIED)
// 
// NOTE: Most hydration is now handled by:
// - cloud_storage_bridge.js (initializes on load)
// - welcome.js (boots app after auth)
// 
// This file just ensures the flag is set if cloud bridge
// hasn't loaded yet
// =================================================================
(function () {
    'use strict';

    // Ensure flag exists
    if (typeof window.__CAMPISTRY_CLOUD_READY__ === 'undefined') {
        window.__CAMPISTRY_CLOUD_READY__ = false;
    }

    // If cloud bridge hasn't initialized in 3 seconds, proceed anyway
    setTimeout(() => {
        if (!window.__CAMPISTRY_CLOUD_READY__) {
            console.warn("⚠️ Cloud bridge timeout - proceeding with local storage");
            window.__CAMPISTRY_CLOUD_READY__ = true;
        }
    }, 3000);

    console.log("🔧 Global bootstrap ready");
})();
