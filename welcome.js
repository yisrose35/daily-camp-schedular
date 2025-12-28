// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE (FIXED v2)
// 
// FIXES:
// - Properly shows UI even when welcome screen starts hidden
// - Works with CSS class-based visibility
// - Graceful degradation if cloud fails
// ============================================================================

(function() {
    'use strict';
    
    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');
    
    // Helper to show welcome, hide app
    function showWelcome() {
        document.body.classList.remove('show-app');
        document.body.classList.add('show-welcome');
    }
    
    // Helper to show app, hide welcome
    function showApp() {
        document.body.classList.remove('show-welcome');
        document.body.classList.add('show-app');
    }
    
    // ⭐ Main initialization
    async function initializeApp() {
        // Wait for Supabase client
        let attempts = 0;
        while (!window.supabase && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!window.supabase) {
            console.error("Supabase client not available");
            showWelcome();
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

        // ⭐ Boot the app
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

            // ⭐ Show main app, hide welcome
            showApp();

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
            showWelcome();
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
                showWelcome();
            }
        });
        
        // ⭐ Listen for post-sign-in cloud hydration
        window.addEventListener('campistry-cloud-hydrated', function(e) {
            if (e.detail?.afterSignIn && e.detail?.hasData) {
                console.log("🔄 Post-sign-in cloud hydration detected, refreshing UI...");
                initializeUIComponents();
            }
        });
    }
    
    // ⭐ Start initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
        initializeApp();
    }
})();
