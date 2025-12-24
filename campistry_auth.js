// ============================================================================
// campistry_auth.js — FINAL SaaS AUTH ENGINE
// FIXED VERSION: Better error handling and null checks
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
                    const { data, error: signupError } = await supabase.auth.signUp({ email, password });
                    user = data?.user;
                    error = signupError;

                    if (user && !error) {
                        await supabase.from("camps").insert([{ name: campName, owner: user.id }]);
                    }
                } else {
                    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
                    user = data?.user;
                    error = loginError;
                }

                if (error) {
                    showStatus(error.message || "Authentication failed.", true);
                    beginBtn.disabled = false;
                    beginBtn.innerText = authMode === "signup" ? "Create Campistry Account" : "Sign In";
                    return;
                }

                if (!user) {
                    showStatus("Authentication failed. Please try again.", true);
                    beginBtn.disabled = false;
                    beginBtn.innerText = authMode === "signup" ? "Create Campistry Account" : "Sign In";
                    return;
                }

                showStatus("Success! Loading Campistry...");
                
                document.getElementById("welcome-screen").style.display = "none";
                document.getElementById("main-app-container").style.display = "block";

                bootCampistryApp();

            } catch (e) {
                console.error("Auth error:", e);
                showStatus("An unexpected error occurred.", true);
                beginBtn.disabled = false;
                beginBtn.innerText = authMode === "signup" ? "Create Campistry Account" : "Sign In";
            }
        };
    }

    function bootCampistryApp() {
        console.log("🚀 Booting Campistry...");
        window.initCalendar?.();
        window.initApp1?.();
        window.initLeagues?.();
        window.initScheduleSystem?.();
        console.log("✅ Campistry loaded");
    }

    window.bootCampistryApp = bootCampistryApp;

})();
