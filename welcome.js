// ============================================================================
// welcome.js — CAMPISTRY BOOT ENGINE (NO SIGN-IN SCREEN)
// 
// Authentication happens on landing.html, not here.
// This script:
// - Checks if user is authenticated
// - If YES: Hide welcome screen, boot app immediately
// - If NO: Redirect to landing.html
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');

    // Hide welcome screen immediately (we don't need it anymore)
    if (welcomeScreen) welcomeScreen.style.display = 'none';

    // Wait for Supabase client
    let attempts = 0;
    while (!window.supabase && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    if (!window.supabase) {
        console.error("Supabase client not available");
        window.location.href = 'landing.html';
        return;
    }

    // Check for existing session
    let session = null;
    try {
        const res = await window.supabase.auth.getSession();
        session = res?.data?.session || null;
        console.log("[AUTH] Session check:", session ? "authenticated" : "not authenticated");
    } catch (e) {
        console.warn("[AUTH] getSession failed:", e);
    }

    if (!session?.user) {
        // NOT AUTHENTICATED - Redirect to landing page
        console.log("[AUTH] No session - redirecting to landing page");
        window.location.href = 'landing.html';
        return;
    }

    // AUTHENTICATED - Boot the app immediately
    console.log("[AUTH] User authenticated:", session.user.email);
    
    // Show main app container
    if (mainAppContainer) mainAppContainer.style.display = 'block';

    // Boot the app
    await bootApp();

    // Listen for sign out
    window.supabase.auth.onAuthStateChange((event, session) => {
        console.log("[AUTH] State change:", event);
        if (event === 'SIGNED_OUT') {
            console.log("[AUTH] Signed out - redirecting to landing page");
            window.location.href = 'landing.html';
        }
    });
});

// ============================================================================
// BOOT APP
// ============================================================================

let booted = false;

async function bootApp() {
    if (booted || window.__CAMPISTRY_BOOTED__) {
        console.log("🚀 App already booted");
        return;
    }

    booted = true;
    window.__CAMPISTRY_BOOTED__ = true;

    console.log("🚀 Booting Campistry...");

    try {
        // Initialize calendar first
        window.initCalendar?.();
        console.log("✓ Calendar initialized");

        // Wait for cloud data with short timeout
        if (!window.__CAMPISTRY_CLOUD_READY__) {
            console.log("⏳ Waiting for cloud...");
            await new Promise((resolve) => {
                const handler = () => {
                    window.removeEventListener('campistry-cloud-hydrated', handler);
                    clearTimeout(timeout);
                    resolve();
                };
                window.addEventListener('campistry-cloud-hydrated', handler);
                const timeout = setTimeout(() => {
                    window.removeEventListener('campistry-cloud-hydrated', handler);
                    console.warn("⚠️ Cloud timeout");
                    window.__CAMPISTRY_CLOUD_READY__ = true;
                    resolve();
                }, 3000);
            });
        }

        console.log("☁️ Cloud ready");
        
        // Initialize UI components
        initializeUI();

    } catch (e) {
        console.error("Boot error:", e);
        initializeUI();
    }
}

function initializeUI() {
    console.log("🔧 Initializing UI components...");

    try {
        if (typeof window.refreshGlobalRegistry === 'function') {
            window.refreshGlobalRegistry();
            console.log("✓ Global registry refreshed");
        }
        if (typeof window.initApp1 === 'function') {
            window.initApp1();
            console.log("✓ App1 initialized");
        }
        if (typeof window.initLeagues === 'function') {
            window.initLeagues();
            console.log("✓ Leagues initialized");
        }
        if (typeof window.initScheduleSystem === 'function') {
            window.initScheduleSystem();
            console.log("✓ Schedule system initialized");
        }
        if (typeof window.initDailyAdjustments === 'function') {
            window.initDailyAdjustments();
            console.log("✓ Daily adjustments initialized");
        }
        console.log("✅ Campistry boot complete");
    } catch (e) {
        console.error("UI initialization error:", e);
    }
}

// Listen for post-sign-in cloud hydration
window.addEventListener('campistry-cloud-hydrated', function(e) {
    if (e.detail?.afterSignIn && e.detail?.hasData) {
        console.log("🔄 Post-sign-in cloud hydration detected, refreshing UI...");
        initializeUI();
    }
});
