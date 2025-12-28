// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE (FIXED)
// 
// FIXES:
// - Proper async/await for cloud hydration
// - Waits for cloud-hydrated event before initializing UI
// - Graceful degradation if cloud fails
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

    // ⭐ FIXED: Proper async boot with cloud hydration wait
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

    // Check for existing session
    let session = null;
    try {
        const res = await window.supabase.auth.getSession();
        session = res?.data?.session || null;
        console.log("[AUTH] Session exists:", !!session);
    } catch (e) {
        console.warn("[AUTH] getSession failed:", e);
    }

    if (session?.user) {
        await bootOnce();
    } else {
        if (welcomeScreen) welcomeScreen.style.display = 'flex';
        if (mainAppContainer) mainAppContainer.style.display = 'none';
    }

    // Listen for auth state changes
    window.supabase.auth.onAuthStateChange(async (event, session) => {
        console.log("[AUTH] State change:", event);

        if (event === 'SIGNED_IN' && session?.user) {
            await bootOnce();
        }

        if (event === 'SIGNED_OUT') {
            booted = false;
            window.__CAMPISTRY_BOOTED__ = false;
            if (welcomeScreen) welcomeScreen.style.display = 'flex';
            if (mainAppContainer) mainAppContainer.style.display = 'none';
        }
    });
    
    // ⭐ Listen for post-sign-in cloud hydration
    // This happens when user signs in and cloud data is loaded AFTER initial boot
    window.addEventListener('campistry-cloud-hydrated', function(e) {
        if (e.detail?.afterSignIn && e.detail?.hasData) {
            console.log("🔄 Post-sign-in cloud hydration detected, refreshing UI...");
            initializeUIComponents();
        }
    });
});
