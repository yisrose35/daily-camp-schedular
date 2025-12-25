// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE (FIXED)
// 
// FIXES:
// - Proper async/await for cloud hydration
// - No race conditions
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

    // ⭐ FIXED: Proper async boot with await
    async function bootOnce() {
        if (booted) return;
        booted = true;

        if (welcomeScreen) welcomeScreen.style.display = 'none';
        if (mainAppContainer) mainAppContainer.style.display = 'block';

        console.log("🚀 Booting Campistry OS...");

        try {
            // ⭐ Step 1: Wait for cloud storage bridge to initialize
            // The bridge sets __CAMPISTRY_CLOUD_READY__ when done
            let cloudAttempts = 0;
            const maxCloudWait = 50; // 5 seconds max
            
            while (!window.__CAMPISTRY_CLOUD_READY__ && cloudAttempts < maxCloudWait) {
                await new Promise(r => setTimeout(r, 100));
                cloudAttempts++;
            }

            if (window.__CAMPISTRY_CLOUD_READY__) {
                console.log("☁️ Cloud storage ready");
            } else {
                console.warn("⚠️ Cloud storage timeout - using local cache");
            }

            // ⭐ Step 2: Initialize calendar (must be first - sets up storage access)
            if (typeof window.initCalendar === 'function') {
                window.initCalendar();
                console.log("✓ Calendar initialized");
            }

            // ⭐ Step 3: Refresh global registry from storage
            if (typeof window.refreshGlobalRegistry === 'function') {
                window.refreshGlobalRegistry();
                console.log("✓ Global registry refreshed");
            }

            // ⭐ Step 4: Initialize app1 (divisions/bunks UI)
            if (typeof window.initApp1 === 'function') {
                window.initApp1();
                console.log("✓ App1 initialized");
            }

            // ⭐ Step 5: Initialize leagues
            if (typeof window.initLeagues === 'function') {
                window.initLeagues();
                console.log("✓ Leagues initialized");
            }

            // ⭐ Step 6: Initialize schedule system
            if (typeof window.initScheduleSystem === 'function') {
                window.initScheduleSystem();
                console.log("✓ Schedule system initialized");
            }

            // ⭐ Step 7: Initialize any other systems
            if (typeof window.initDailyAdjustments === 'function') {
                window.initDailyAdjustments();
                console.log("✓ Daily adjustments initialized");
            }

            console.log("✅ Campistry boot complete");

        } catch (e) {
            console.error("Boot error:", e);
            alert("Campistry encountered an error during startup. Some features may not work correctly.");
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
            if (welcomeScreen) welcomeScreen.style.display = 'flex';
            if (mainAppContainer) mainAppContainer.style.display = 'none';
        }
    });
});
