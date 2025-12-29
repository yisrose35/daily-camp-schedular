// ============================================================================
// welcome.js — CAMPISTRY BOOT ENGINE (MINIMAL)
// 
// No welcome screen. No auth checks. Dashboard already verified authentication.
// This script just boots the app immediately.
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
    console.log("🚀 Starting Campistry Flow...");

    // Show main app immediately
    const mainAppContainer = document.getElementById('main-app-container');
    if (mainAppContainer) mainAppContainer.style.display = 'block';

    // Hide welcome screen if it exists
    const welcomeScreen = document.getElementById('welcome-screen');
    if (welcomeScreen) welcomeScreen.style.display = 'none';

    // Wait for Supabase (needed for cloud sync, not for auth)
    let attempts = 0;
    while (!window.supabase && attempts < 30) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    // Boot the app
    await bootApp();

    // Listen for sign out (redirect to landing)
    if (window.supabase?.auth) {
        window.supabase.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') {
                window.location.href = 'landing.html';
            }
        });
    }
});

// ============================================================================
// BOOT APP
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

    console.log("✅ Campistry ready");
}

// Re-init UI after cloud hydration
window.addEventListener('campistry-cloud-hydrated', () => {
    if (window.__CAMPISTRY_BOOTED__) {
        window.refreshGlobalRegistry?.();
        window.initApp1?.();
    }
});
