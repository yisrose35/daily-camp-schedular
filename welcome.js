// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE (FINAL SaaS SAFE VERSION)
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
        welcomeScreen?.style.display = 'flex';
        return;
    }

    let booted = false;

    async function bootOnce() {
        if (booted) return;
        booted = true;

        welcomeScreen?.style.display = 'none';
        mainAppContainer?.style.display = 'block';

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

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
            console.log("✅ Existing session found, auto-login...");
            await bootOnce();
        } else {
            welcomeScreen?.style.display = 'flex';
            mainAppContainer?.style.display = 'none';
        }
    } catch (e) {
        console.error("Session check failed:", e);
        welcomeScreen?.style.display = 'flex';
        mainAppContainer?.style.display = 'none';
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log("Auth state change:", event);
        if (event === 'SIGNED_IN' && session?.user) {
            await bootOnce();
        }
        if (event === 'SIGNED_OUT') {
            booted = false;
            welcomeScreen?.style.display = 'flex';
            mainAppContainer?.style.display = 'none';
        }
    });

});
