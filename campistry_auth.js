// ============================================================================
// campistry_auth.js — FINAL SaaS AUTH ENGINE (FIXED)
// FIXED VERSION: Better error handling, timeout protection, no hanging
// ============================================================================

(function() {
    'use strict';

    let authMode = "login";

    const emailEl = document.getElementById("auth-email");
    const passEl = document.getElementById("auth-password");
    const campEl = document.getElementById("camp-name-input");
    const statusEl = document.getElementById("auth-status");
    const beginBtn = document.getElementById("begin-btn");
    const loginBtn = document.getElementById("mode-login");
    const signupBtn = document.getElementById("mode-signup");

    // Safety check
    if (!emailEl || !passEl || !beginBtn) {
        console.warn("Auth elements not found - skipping auth init");
        return;
    }

    // Toggle modes
    if (loginBtn) loginBtn.onclick = () => setMode("login");
    if (signupBtn) signupBtn.onclick = () => setMode("signup");

    function setMode(mode) {
        authMode = mode;
        if (loginBtn) loginBtn.classList.toggle("active", mode === "login");
        if (signupBtn) signupBtn.classList.toggle("active", mode === "signup");
        if (campEl) campEl.style.display = mode === "signup" ? "block" : "none";
        if (beginBtn) beginBtn.innerText = mode === "signup" ? "Create Campistry Account" : "Sign In";
    }

    setMode("login");

    function showStatus(message, isError = false) {
        if (statusEl) {
            statusEl.innerText = message;
            statusEl.style.color = isError ? "#dc2626" : "#059669";
        }
    }
    
    function resetButton() {
        if (beginBtn) {
            beginBtn.disabled = false;
            beginBtn.innerText = authMode === "signup" ? "Create Campistry Account" : "Sign In";
        }
    }

    // Main submit
    if (beginBtn) {
        beginBtn.onclick = async () => {
            const email = emailEl.value.trim();
            const password = passEl.value.trim();
            const campName = campEl ? campEl.value.trim() : "";

            if (!email || !password) {
                showStatus("Please enter email and password.", true);
                return;
            }

            if (authMode === "signup" && !campName) {
                showStatus("Please enter your camp name.", true);
                return;
            }

            beginBtn.disabled = true;
            beginBtn.innerText = "Please wait...";
            showStatus("");

            try {
                let user = null;
                let error = null;

                if (authMode === "signup") {
                    console.log("🔐 Attempting signup...");
                    const { data, error: signupError } = await supabase.auth.signUp({ email, password });
                    user = data?.user;
                    error = signupError;

                    if (user && !error) {
                        console.log("🔐 Signup successful, creating camp...");
                        await supabase.from("camps").insert([{ name: campName, owner: user.id }]);
                    }
                } else {
                    console.log("🔐 Attempting login for:", email);
                    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
                    console.log("🔐 Login response:", { hasData: !!data, hasUser: !!data?.user, hasError: !!loginError });
                    user = data?.user;
                    error = loginError;
                }

                if (error) {
                    console.error("🔐 Auth error:", error.message);
                    showStatus(error.message || "Authentication failed.", true);
                    resetButton();
                    return;
                }

                if (!user) {
                    console.error("🔐 No user in response");
                    showStatus("Authentication failed. Please try again.", true);
                    resetButton();
                    return;
                }

                console.log("🔐 Auth successful for:", user.email);
                showStatus("Success! Loading Campistry...");
                
                // Hide welcome screen, show app
                const welcomeScreen = document.getElementById("welcome-screen");
                const mainAppContainer = document.getElementById("main-app-container");
                
                console.log("🔐 Switching screens...");
                if (welcomeScreen) welcomeScreen.style.display = "none";
                if (mainAppContainer) mainAppContainer.style.display = "block";

                // Boot the app
                console.log("🔐 Calling bootCampistryApp...");
                try {
                    await bootCampistryApp();
                    console.log("🔐 Boot complete");
                } catch (bootError) {
                    console.error("🔐 Boot error:", bootError);
                }
                
                // Reset button in case user logs out and back in
                resetButton();

            } catch (e) {
                console.error("🔐 Unexpected auth error:", e);
                showStatus(e.message || "An unexpected error occurred.", true);
                resetButton();
            }
        };
    }

    async function bootCampistryApp() {
        console.log("🚀 Booting Campistry...");
        
        // Check if welcome.js already booted the app
        if (window.__CAMPISTRY_BOOTED__) {
            console.log("🚀 App already booted by welcome.js");
            return;
        }
        
        // Wait for cloud to be ready (with timeout)
        console.log("🚀 Waiting for cloud bridge...");
        let attempts = 0;
        while (!window.__CAMPISTRY_CLOUD_READY__ && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        
        if (window.__CAMPISTRY_CLOUD_READY__) {
            console.log("☁️ Cloud ready after", attempts * 100, "ms");
        } else {
            console.warn("⚠️ Cloud not ready after 5s, proceeding anyway");
            // Force the flag so other code can proceed
            window.__CAMPISTRY_CLOUD_READY__ = true;
        }
        
        // Mark as booted to prevent duplicate boots
        window.__CAMPISTRY_BOOTED__ = true;
        
        // Refresh global registry first
        console.log("🚀 Refreshing global registry...");
        window.refreshGlobalRegistry?.();
        
        // Initialize components
        console.log("🚀 Initializing components...");
        window.initCalendar?.();
        window.initApp1?.();
        window.initLeagues?.();
        window.initScheduleSystem?.();
        window.initDailyAdjustments?.();
        
        console.log("✅ Campistry loaded");
    }

    window.bootCampistryApp = bootCampistryApp;

})();
