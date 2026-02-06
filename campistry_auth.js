// ============================================================================
// campistry_auth.js — FINAL SaaS AUTH ENGINE (HARDENED v3.2)
// v3.2: Security hardening — failed accept returns false, all localStorage
//       keys set (campistry_camp_id + campistry_auth_user_id), 
//       CampistryDB.refresh() before boot
// v3.0: Fixed camp creation with error handling and proper ID setting
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
    // ⭐ Check for pending invite before creating camp
    // v3.2: Returns false on failed accept (no stale localStorage caching)
    // =========================================================================
    async function checkAndAcceptPendingInvite(email, userId) {
        try {
            console.log("🔐 Checking for pending invite for:", email);
            
            const { data: pendingInvite, error: queryError } = await supabase
                .from('camp_users')
                .select('id, role, camp_id, subdivision_ids')
                .eq('email', email.toLowerCase())
                .is('user_id', null)  // Not yet accepted
                .maybeSingle();
            
            if (queryError) {
                console.error("🔐 Error querying pending invite:", queryError);
                return false;
            }
            
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
                
                // ⭐ v3.2 FIX: If accept failed, don't cache stale data
                if (acceptError) {
                    console.error("🔐 Failed to auto-accept invite:", acceptError);
                    return false;
                }
                
                // ⭐ v3.2 FIX: Cache ALL keys including campistry_camp_id
                localStorage.setItem('campistry_camp_id', pendingInvite.camp_id);
                localStorage.setItem('campistry_user_id', pendingInvite.camp_id);
                localStorage.setItem('campistry_auth_user_id', userId);
                localStorage.setItem('campistry_role', pendingInvite.role);
                localStorage.setItem('campistry_is_team_member', 'true');
                
                console.log("🔐 ✅ Invite processed! User is now:", pendingInvite.role);
                return true; // User has an invite - don't create camp
            }
            
            console.log("🔐 No pending invite found");
            return false; // No invite found
        } catch (e) {
            console.error("🔐 Error checking pending invite:", e);
            return false;
        }
    }

    // =========================================================================
    // ⭐ Create camp for new owner with proper error handling
    // v3.2: Sets campistry_camp_id + campistry_auth_user_id
    // =========================================================================
    async function createCampForOwner(userId, campName) {
        console.log("🔐 Creating camp for new owner...");
        
        try {
            const { data: campData, error: campError } = await supabase
                .from("camps")
                .insert([{ 
                    id: userId,      // ⭐ Camp ID = User ID for owners
                    owner: userId,
                    name: campName,
                    address: ''
                }])
                .select()
                .single();
            
            if (campError) {
                console.error("🔐 ❌ Failed to create camp:", campError);
                
                // Check if it's a duplicate key error (camp already exists)
                if (campError.code === '23505') {
                    console.log("🔐 Camp already exists, that's OK");
                    return true;
                }
                
                return false;
            }
            
            console.log("🔐 ✅ Camp created successfully:", campData);
            
            // ⭐ v3.2 FIX: Cache ALL keys including campistry_camp_id
            localStorage.setItem('campistry_camp_id', userId);
            localStorage.setItem('campistry_user_id', userId);
            localStorage.setItem('campistry_auth_user_id', userId);
            localStorage.setItem('campistry_role', 'owner');
            localStorage.setItem('campistry_is_team_member', 'false');
            
            return true;
        } catch (e) {
            console.error("🔐 Exception creating camp:", e);
            return false;
        }
    }

    // =========================================================================
    // Main submit handler
    // =========================================================================
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
                    // =============================================================
                    // SIGNUP FLOW
                    // =============================================================
                    console.log("🔐 Attempting signup...");
                    const { data, error: signupError } = await supabase.auth.signUp({ email, password });
                    user = data?.user;
                    error = signupError;
                    
                    if (user && !error) {
                        // ⭐ Check for pending invite BEFORE creating camp
                        console.log("🔐 Signup successful, checking for pending invite...");
                        const hasInvite = await checkAndAcceptPendingInvite(email, user.id);
                        
                        if (!hasInvite) {
                            // No pending invite - create new camp
                            const campCreated = await createCampForOwner(user.id, campName);
                            
                            if (!campCreated) {
                                showStatus("Account created but camp setup failed. Please try logging in or contact support.", true);
                                // Don't return - let them continue to dashboard which might help
                            }
                        } else {
                            console.log("🔐 User joined via invite - NOT creating new camp");
                        }
                    }
                } else {
                    // =============================================================
                    // LOGIN FLOW
                    // =============================================================
                    console.log("🔐 Attempting login for:", email);
                    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
                    console.log("🔐 Login response:", { hasData: !!data, hasUser: !!data?.user, hasError: !!loginError });
                    user = data?.user;
                    error = loginError;
                    
                    // ⭐ Check for pending invite on login too
                    if (user && !error) {
                        const hasInvite = await checkAndAcceptPendingInvite(email, user.id);
                        
                        // If no invite, check if they own a camp
                        if (!hasInvite) {
                            const { data: existingCamp } = await supabase
                                .from('camps')
                                .select('id, name')
                                .eq('owner', user.id)
                                .maybeSingle();
                            
                            if (existingCamp) {
                                console.log("🔐 User owns camp:", existingCamp.name);
                                // ⭐ v3.2 FIX: Set ALL localStorage keys
                                localStorage.setItem('campistry_camp_id', existingCamp.id);
                                localStorage.setItem('campistry_user_id', existingCamp.id);
                                localStorage.setItem('campistry_auth_user_id', user.id);
                                localStorage.setItem('campistry_role', 'owner');
                                localStorage.setItem('campistry_is_team_member', 'false');
                            } else {
                                console.warn("🔐 ⚠️ User has no camp and no invite!");
                                // Clear any stale cache
                                localStorage.removeItem('campistry_camp_id');
                                localStorage.removeItem('campistry_role');
                                localStorage.removeItem('campistry_is_team_member');
                            }
                        }
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
                
                // ⭐ v3.2 FIX: Force supabase_client.js to re-detect from DB,
                // prevents race where onAuthStateChange set stale _role='viewer'
                if (window.CampistryDB?.refresh) {
                    try { await window.CampistryDB.refresh(); } catch(e) {
                        console.warn("🔐 CampistryDB.refresh() failed:", e);
                    }
                }
                
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
    
    // =========================================================================
    // Boot the main app
    // =========================================================================
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
