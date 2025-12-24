// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE
// FIXED VERSION: Proper session check and auto-login
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {

    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');

    // Wait for Supabase to be available
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

    // Check for existing session
    try {
        const { data: { session } } = await supabase.auth.getSession();

        if (session && session.user) {
            console.log("✅ Existing session found, auto-login...");
            if (welcomeScreen) welcomeScreen.style.display = 'none';
            if (mainAppContainer) mainAppContainer.style.display = 'block';
            bootMainApp();
        } else {
            console.log("No existing session, showing login...");
            if (welcomeScreen) welcomeScreen.style.display = 'flex';
            if (mainAppContainer) mainAppContainer.style.display = 'none';
        }

    } catch (e) {
        console.error("Session check failed:", e);
        if (welcomeScreen) welcomeScreen.style.display = 'flex';
        if (mainAppContainer) mainAppContainer.style.display = 'none';
    }

    function bootMainApp() {
        console.log("🚀 Booting Campistry OS...");
        try {
            window.initCalendar?.();
            window.initApp1?.();
            window.initLeagues?.();
            window.initScheduleSystem?.();
            console.log("✅ Campistry boot complete");
        } catch (e) {
            console.error("Boot error:", e);
        }
    }

    window.bootMainApp = bootMainApp;

    // Listen for auth state changes
    supabase.auth.onAuthStateChange((event, session) => {
        console.log("Auth state change:", event);
        
        if (event === 'SIGNED_IN' && session) {
            if (welcomeScreen) welcomeScreen.style.display = 'none';
            if (mainAppContainer) mainAppContainer.style.display = 'block';
            bootMainApp();
        }
        
        if (event === 'SIGNED_OUT') {
            if (welcomeScreen) welcomeScreen.style.display = 'flex';
            if (mainAppContainer) mainAppContainer.style.display = 'none';
        }
    });

});
