// ============================================================================
// welcome.js — CAMPISTRY CLOUD BOOT ENGINE (PRODUCTION SAFE)
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {

  const welcomeScreen = document.getElementById('welcome-screen');
  const mainAppContainer = document.getElementById('main-app-container');

  // Defensive semicolon to prevent concat/minify glue bugs
  ;

  // Wait for Supabase
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

  async function bootOnce() {
    if (booted) return;
    booted = true;

    if (welcomeScreen) welcomeScreen.style.display = 'none';
    if (mainAppContainer) mainAppContainer.style.display = 'block';

    console.log("🚀 Booting Campistry OS...");

    try {
      (async () => {
        let tries = 0;
        // Wait for global_authority.js to signal cloud readiness
        while (!window.__CAMPISTRY_CLOUD_READY__ && tries < 120) {
          await new Promise(r => setTimeout(r, 100));
          tries++;
        }

        console.log("☁️ Cloud Ready:", window.__CAMPISTRY_CLOUD_READY__);

        window.initCalendar?.();
        window.initApp1?.();
        window.initLeagues?.();
        window.initScheduleSystem?.();
        
        console.log("✅ Campistry boot complete");
      })();

    } catch (e) {
      console.error("Boot error:", e);
    }
  }

  // SAFE session check (cannot throw syntax errors)
  let session = null;
  try {
    const res = await supabase.auth.getSession();
    session = res?.data?.session || null;
    console.log("[AUTH] session exists?", !!session);
  } catch (e) {
    console.warn("[AUTH] getSession failed:", e);
  }

  if (session?.user) {
    await bootOnce();
  } else {
    if (welcomeScreen) welcomeScreen.style.display = 'flex';
    if (mainAppContainer) mainAppContainer.style.display = 'none';
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    console.log("[AUTH] state:", event);

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
