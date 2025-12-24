// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE
// Replaces local passcode + localStorage gate with Supabase account gate
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {

    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');
    const campNameInput = document.getElementById('camp-name-input');
    const welcomeTitle = document.getElementById('welcome-title');
    const beginBtn = document.getElementById('begin-btn');
    const welcomeText = welcomeScreen.querySelector('p');

    // =========================================================================
    // CORE BOOT (UNCHANGED)
    // =========================================================================
    function bootMainApp() {
        console.log("Booting Campistry OS...");

        window.initCalendar?.();
        window.initApp1?.();
        window.initLeagues?.();
        window.initScheduleSystem?.();
    }

    // =========================================================================
    // CLOUD-AWARE APP FLOW
    // =========================================================================
    async function runAppFlow() {

        const { data: auth } = await supabase.auth.getUser();
        const user = auth?.user;
        if (!user) return;

        // Load camp account
        const { data: camp } = await supabase
            .from("camps")
            .select("*")
            .eq("owner", user.id)
            .maybeSingle();

        if (camp) {
            welcomeScreen.style.display = 'none';
            mainAppContainer.style.display = 'block';
            bootMainApp();
        }
    }

    // =========================================================================
    // MAIN ENTRY
    // =========================================================================
    const { data: auth } = await supabase.auth.getUser();

    if (auth.user) {
        await runAppFlow();
    } else {
        welcomeScreen.style.display = 'flex';
        mainAppContainer.style.display = 'none';
    }
});
