// ============================================================================
// welcome.js — CAMPISTRY BOOT ENGINE v2.0 (CLEAN)
// 
// Handles app bootstrapping for Campistry Flow.
// Auth is handled by the inline script in flow.html.
// This file provides bootApp() and acts as a fallback if the inline
// auth script is not present.
// ============================================================================

// ============================================================================
// BOOT APP — Called by inline auth script after session is verified
// ============================================================================

async function bootApp() {
    if (window.__CAMPISTRY_BOOTED__) {
        console.log("🚀 Already booted");
        return;
    }
    window.__CAMPISTRY_BOOTED__ = true;

    console.log("🚀 Booting Campistry...");

    // Initialize calendar
    window.initCalendar?.();
    console.log("✓ Calendar");

    // Wait for cloud data (short timeout)
    if (!window.__CAMPISTRY_CLOUD_READY__) {
        await new Promise((resolve) => {
            const handler = () => {
                window.removeEventListener('campistry-cloud-hydrated', handler);
                clearTimeout(timeout);
                resolve();
            };
            window.addEventListener('campistry-cloud-hydrated', handler);
            const timeout = setTimeout(() => {
                window.removeEventListener('campistry-cloud-hydrated', handler);
                window.__CAMPISTRY_CLOUD_READY__ = true;
                resolve();
            }, 2000);
        });
    }
    console.log("✓ Cloud");

    // Initialize UI
    window.refreshGlobalRegistry?.();
    window.initApp1?.();
    window.initLeagues?.();
    window.initScheduleSystem?.();
    window.initDailyAdjustments?.();

    console.log("✅ Campistry Flow loaded");
}

// Make bootApp available globally
window.bootApp = bootApp;

// ============================================================================
// FALLBACK AUTH CHECK
// Only runs if the inline auth script in flow.html is NOT present.
// This keeps backward compatibility if welcome.js is loaded on a page
// that doesn't have the inline auth block.
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
    // Inline auth in flow.html handles everything — just defer to it
    if (window.__CAMPISTRY_AUTH_INLINE__) {
        console.log("🚀 [welcome.js] Inline auth present, deferring");
        return;
    }

    console.log("🚀 [welcome.js] No inline auth detected, running fallback auth check...");

    // Wait for Supabase
    let attempts = 0;
    while ((!window.supabase || !window.supabase.auth) && attempts < 30) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    // ★ FAST-PASS: Check localStorage before redirecting
    const cachedUserId = localStorage.getItem('campistry_auth_user_id');
    const cachedCampId = localStorage.getItem('campistry_camp_id');
    const hasLocalAuth = !!(cachedUserId && cachedCampId);
    // Fallback only if inline script missing (shouldn't happen in production)
    console.log("🚀 [welcome.js] No inline auth — simple localStorage check");
    
    if (!localStorage.getItem('campistry_auth_user_id') || 
        !localStorage.getItem('campistry_camp_id')) {
        window.location.href = 'index.html';
        return;
    }

    await bootApp();
});
