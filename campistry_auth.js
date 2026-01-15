// ============================================================================
// campistry_auth.js — FINAL SaaS AUTH ENGINE (FIXED v2.0)
// FIXED VERSION: Better error handling, timeout protection, no hanging
// v2.0: Added pending invite check to prevent team members becoming owners
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

    // =========================================================================
    // ⭐ NEW: Check for pending invite before creating camp
    // =========================================================================
    async function checkAndAcceptPendingInvite(email, userId) {
        try {
            const { data: pendingInvite } = await supabase
                .from('camp_users')
                .select('id, role, camp_id')
                .eq('email', email.toLowerCase())
                .is('user_id', null)  // Not yet accepted
                .maybeSingle();
            
            if (pendingInvite) {
                console.log("🔐 ✅ Found pending invite:", pendingInvite.role);
                
                // Auto-accept the invite
                const { error: acceptError } = await supabase
                    .from('camp_users')
                    .update({
                        user_id: userId,
                        accepted_at: new Date().toISOString()
                    })
                    .eq('id', pendingInvite.id);
                
                if (acceptError) {
                    console.error("🔐 Failed to auto-accept invite:", acceptError);
                    return false;
                }
                
                console.log("🔐 ✅ Invite auto-accepted! User is now:", pendingInvite.role);
                return true; // User has an invite - don't create camp
            }
            
            return false; // No invite found
        } catch (e) {
            console.error("🔐 Error checking pending invite:", e);
            return false;
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
                        // ⭐ FIX: Check for pending invite BEFORE creating camp
                        console.log("🔐 Signup successful, checking for pending invite...");
                        const hasInvite = await checkAndAcceptPendingInvite(email, user.id);
                        
                        if (!hasInvite) {
                            // No pending invite - create new camp as usual
                            console.log("🔐 No pending invite, creating new camp...");
                            await supabase.from("camps").insert([{ name: campName, owner: user.id }]);
                        } else {
                            console.log("🔐 User joined via invite - NOT creating new camp");
                        }
                    }
                } else {
                    console.log("🔐 Attempting login for:", email);
                    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
                    console.log("🔐 Login response:", { hasData: !!data, hasUser: !!data?.user, hasError: !!loginError });
                    user = data?.user;
                    error = loginError;
                    
                    // ⭐ FIX: Also check for pending invite on login
                    if (user && !error) {
                        await checkAndAcceptPendingInvite(email, user.id);
                    }
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
        
        // Check if already booted
        if (window.__CAMPISTRY_BOOTED__) {
            console.log("🚀 App already booted");
            return;
        }
        
        // ⭐ Wait for cloud hydration event with short timeout
        console.log("🚀 Waiting for cloud data...");
        
        const cloudReady = await new Promise((resolve) => {
            // Set up event listener
            const handler = (e) => {
                console.log("🚀 Cloud hydration event received");
                window.removeEventListener('campistry-cloud-hydrated', handler);
                clearTimeout(timeout);
                resolve(true);
            };
            window.addEventListener('campistry-cloud-hydrated', handler);
            
            // Short timeout - cloud fetch should be fast
            const timeout = setTimeout(() => {
                console.warn("⚠️ Cloud timeout after 3s, checking cache...");
                window.removeEventListener('campistry-cloud-hydrated', handler);
                
                // Check if we have data in cache already
                const cache = JSON.parse(localStorage.getItem('CAMPISTRY_UNIFIED_STATE') || '{}');
                if (Object.keys(cache.divisions || {}).length > 0) {
                    console.log("✓ Found data in cache");
                    resolve(true);
                } else {
                    console.warn("⚠️ No data in cache");
                    resolve(false);
                }
            }, 3000);
        });
        
        // Mark as booted
        window.__CAMPISTRY_BOOTED__ = true;
        window.__CAMPISTRY_CLOUD_READY__ = true;
        
        // Refresh registry and initialize
        console.log("🚀 Initializing UI...");
        window.refreshGlobalRegistry?.();
        window.initCalendar?.();
        window.initApp1?.();
        window.initLeagues?.();
        window.initScheduleSystem?.();
        window.initDailyAdjustments?.();
        
        console.log("✅ Campistry loaded");
    }
    window.bootCampistryApp = bootCampistryApp;
})();
