// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE (UPDATED)
// 
// UPDATED FOR LANDING PAGE FLOW:
// - If user is already authenticated (logged in via landing page), skip
//   the welcome screen entirely and go straight to the app
// - Welcome screen only shows if NOT authenticated
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {

    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');

    // Wait for Supabase client
    let attempts = 0;
    while (!window.supabase && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    if (!window.supabase) {
        console.error("Supabase client not available");
        if (welcomeScreen) welcomeScreen.style.display = 'flex';
        return;
    }

    let booted = false;

    // ⭐ Initialize UI components (call after cloud is ready)
    function initializeUIComponents() {
        console.log("🔧 Initializing UI components...");
        
        try {
            // Refresh global registry from storage (now has cloud data)
            if (typeof window.refreshGlobalRegistry === 'function') {
                window.refreshGlobalRegistry();
                console.log("✓ Global registry refreshed");
            }

            // Initialize app1 (divisions/bunks UI)
            if (typeof window.initApp1 === 'function') {
                window.initApp1();
                console.log("✓ App1 initialized");
            }

            // Initialize leagues
            if (typeof window.initLeagues === 'function') {
                window.initLeagues();
                console.log("✓ Leagues initialized");
            }

            // Initialize schedule system
            if (typeof window.initScheduleSystem === 'function') {
                window.initScheduleSystem();
                console.log("✓ Schedule system initialized");
            }

            // Initialize daily adjustments
            if (typeof window.initDailyAdjustments === 'function') {
                window.initDailyAdjustments();
                console.log("✓ Daily adjustments initialized");
            }

            console.log("✅ Campistry boot complete");
        } catch (e) {
            console.error("UI initialization error:", e);
        }
    }

    // ⭐ Boot the app (skip welcome screen)
    async function bootOnce() {
        if (booted) return;
        
        // Check if already booted by another script
        if (window.__CAMPISTRY_BOOTED__) {
            console.log("🚀 App already booted");
            booted = true;
            return;
        }
        
        booted = true;
        window.__CAMPISTRY_BOOTED__ = true;

        // ⭐ SKIP WELCOME SCREEN - go straight to app
        if (welcomeScreen) welcomeScreen.style.display = 'none';
        if (mainAppContainer) mainAppContainer.style.display = 'block';

        console.log("🚀 Booting Campistry OS...");

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
            initializeUIComponents();

        } catch (e) {
            console.error("Boot error:", e);
            initializeUIComponents();
        }
    }

    // ⭐ CHECK FOR EXISTING SESSION FIRST
    // If user logged in via landing page, they'll already have a session
    let session = null;
    try {
        const res = await window.supabase.auth.getSession();
        session = res?.data?.session || null;
        console.log("[AUTH] Session exists:", !!session);
    } catch (e) {
        console.warn("[AUTH] getSession failed:", e);
    }

    if (session?.user) {
        // ⭐ USER IS ALREADY LOGGED IN - skip welcome, boot app immediately
        console.log("[AUTH] User already authenticated:", session.user.email);
        await bootOnce();
    } else {
        // ⭐ NO SESSION - Redirect to landing page for login
        console.log("[AUTH] No session - redirecting to landing page");
        window.location.href = 'index.html';
        return;
    }

    // Listen for auth state changes
    window.supabase.auth.onAuthStateChange(async (event, session) => {
        console.log("[AUTH] State change:", event);

        if (event === 'SIGNED_IN' && session?.user && !booted) {
            // If somehow signed in while on this page, boot the app
            await bootOnce();
        }

        if (event === 'SIGNED_OUT') {
            // ⭐ ON LOGOUT: Redirect to landing page
            console.log("[AUTH] Signed out - redirecting to landing page");
            window.location.href = 'index.html';
        }
    });
    
    // ⭐ Listen for post-sign-in cloud hydration
    window.addEventListener('campistry-cloud-hydrated', function(e) {
        if (e.detail?.afterSignIn && e.detail?.hasData) {
            console.log("🔄 Post-sign-in cloud hydration detected, refreshing UI...");
            initializeUIComponents();
        }
    });
});
