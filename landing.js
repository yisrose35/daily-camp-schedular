// ============================================================================
// landing.js — Campistry Landing Page (HARDENED v3.1)
// ============================================================================
// v3.1 CHANGES:
//   - Added promo code detection during signup (checks promo_codes table)
//   - Promo codes → plan_status='trial', normal codes → plan_status='active'
//   - Removed email confirmation gate (users go straight through)
//
// v3.0 SECURITY FIXES:
//   - Signup: creates camp + sets localStorage BEFORE redirect
//   - Signup: checks for invite (pending OR already-accepted) to prevent phantom camps
//   - Login: detects invite/camp/membership BEFORE redirect
//   - handleLogout: clears ALL localStorage (auth + data keys) BEFORE signOut
//   - Calls CampistryDB.refresh() before redirect to sync in-memory state
// ============================================================================

// ========================================
// GLOBAL STATE
// ========================================
let authMode = 'login';

// Carries what's needed to finish signup/login across the verification-code
// step: { email, campName, accessCode, from: 'signup'|'login' }. 'from'
// decides which post-verify setup path runs — creating a camp (new signup)
// vs. just resolving an existing account's camp/invite (an existing but
// never-confirmed account signing in).
let _pendingAuth = null;

// supabase-js's functions.invoke() collapses every non-2xx response into a
// generic error — the real { error: "..." } body secure-login returns lives
// on res.error.context instead. Same unwrap pattern used for pos-pin-login
// in campistry_snacks_pos.html.
function unwrapFnResult(res) {
    const data = res && res.data;
    if (data && (data.access_token || data.error)) return Promise.resolve(data);
    const err = res && res.error;
    if (err && err.context && typeof err.context.json === 'function') {
        return err.context.json().catch(() => ({ error: (err && err.message) || 'Could not sign in.' }));
    }
    return Promise.resolve({ error: (err && err.message) || 'Could not sign in.' });
}

// ========================================
// SUPABASE HELPER
// ========================================
function getSupabase() {
    if (window.supabase && window.supabase.auth) {
        return window.supabase;
    }
    return null;
}

// ========================================
// AUTH MODAL FUNCTIONS
// ========================================
function openAuthModal(mode = 'login') {
    authMode = mode;
    const authModal = document.getElementById('authModal');
    if (authModal) {
        authModal.style.display = 'flex';

        // Always start on the normal sign-in/sign-up view, never mid-way
        // through a leftover verification-code step from a previous open.
        const modalToggle = document.getElementById('modalToggle');
        const authForm = document.getElementById('authForm');
        const verifyCodeForm = document.getElementById('verifyCodeForm');
        const verifyCodeFooter = document.getElementById('verifyCodeFooter');
        const authFooterDefault = document.getElementById('authFooterDefault');
        if (modalToggle) modalToggle.style.display = 'flex';
        if (authForm) authForm.style.display = 'block';
        if (verifyCodeForm) verifyCodeForm.style.display = 'none';
        if (verifyCodeFooter) verifyCodeFooter.style.display = 'none';
        if (authFooterDefault) authFooterDefault.style.display = 'block';
        _pendingAuth = null;

        updateModalUI();

        const authError = document.getElementById('authError');
        if (authError) authError.textContent = '';
        showAuthInfo('');

        setTimeout(() => {
            if (mode === 'signup') {
                document.getElementById('campName')?.focus();
            } else {
                document.getElementById('authEmail')?.focus();
            }
        }, 100);
    }
}

function closeAuthModal() {
    const authModal = document.getElementById('authModal');
    const authForm = document.getElementById('authForm');
    const authError = document.getElementById('authError');
    const authLoading = document.getElementById('authLoading');
    
    if (authModal) authModal.style.display = 'none';
    if (authForm) authForm.reset();
    if (authError) authError.textContent = '';
    if (authLoading) authLoading.style.display = 'none';
    
    resetFormButton();
}

function openResetModal() {
    const resetModal = document.getElementById('resetPasswordModal');
    const resetRequestView = document.getElementById('resetRequestView');
    const updatePasswordView = document.getElementById('updatePasswordView');
    const resetError = document.getElementById('resetError');
    const resetSuccess = document.getElementById('resetSuccess');
    
    if (resetModal) {
        resetModal.style.display = 'flex';
        if (resetRequestView) resetRequestView.style.display = 'block';
        if (updatePasswordView) updatePasswordView.style.display = 'none';
        if (resetError) resetError.textContent = '';
        if (resetSuccess) resetSuccess.style.display = 'none';
        
        const emailInput = document.getElementById('resetEmail');
        const submitBtn = document.getElementById('resetSubmit');
        if (emailInput) {
            emailInput.disabled = false;
            emailInput.value = '';
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send Reset Link';
        }
        
        setTimeout(() => emailInput?.focus(), 100);
    }
}

function closeResetModal() {
    const resetModal = document.getElementById('resetPasswordModal');
    if (resetModal) resetModal.style.display = 'none';
}

// =========================================================================
// LOGOUT — Clears ALL localStorage (auth + data) BEFORE signOut
// Prevents data leak if page reloads before onAuthStateChange fires
// =========================================================================
function handleLogout() {
    // Auth keys
    localStorage.removeItem('campistry_camp_id');
    localStorage.removeItem('campistry_user_id');
    localStorage.removeItem('campistry_auth_user_id');
    localStorage.removeItem('campistry_role');
    localStorage.removeItem('campistry_is_team_member');
    // Data keys — prevent next user from seeing previous camp data
    localStorage.removeItem('campGlobalSettings_v1');
    localStorage.removeItem('campistryGlobalSettings');
    localStorage.removeItem('CAMPISTRY_LOCAL_CACHE');
    localStorage.removeItem('campDailyData_v1');

    const supabase = getSupabase();
    if (supabase) {
        supabase.auth.signOut().then(() => {
            window.location.reload();
        }).catch(() => {
            window.location.reload();
        });
    } else {
        window.location.reload();
    }
}

// ========================================
// UI HELPERS
// ========================================
function updateModalUI() {
    const modalTitle = document.getElementById('modalTitle');
    const modalSubtitle = document.getElementById('modalSubtitle');
    const formSubmit = document.getElementById('formSubmit');
    const campNameGroup = document.getElementById('campNameGroup');
    const accessCodeGroup = document.getElementById('accessCodeGroup');
    const forgotLink = document.getElementById('forgotPasswordLink');
    
    if (authMode === 'signup') {
        if (modalTitle) modalTitle.textContent = 'Create Account';
        if (modalSubtitle) modalSubtitle.textContent = 'Get started with Campistry today';
        if (formSubmit) formSubmit.textContent = 'Create Account';
        if (campNameGroup) campNameGroup.style.display = 'block';
        if (accessCodeGroup) accessCodeGroup.style.display = 'block';
        if (forgotLink) forgotLink.style.display = 'none';
    } else {
        if (modalTitle) modalTitle.textContent = 'Welcome Back';
        if (modalSubtitle) modalSubtitle.textContent = 'Sign in to your Campistry account';
        if (formSubmit) formSubmit.textContent = 'Sign In';
        if (campNameGroup) campNameGroup.style.display = 'none';
        if (accessCodeGroup) accessCodeGroup.style.display = 'none';
        if (forgotLink) forgotLink.style.display = 'block';
    }

    document.querySelectorAll('.modal-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === authMode);
    });
}

function updateUIForLoggedInState(user) {
    const navActions = document.getElementById('navActions');
    const navActionsLoggedIn = document.getElementById('navActionsLoggedIn');
    if (navActions) navActions.style.display = 'none';
    if (navActionsLoggedIn) navActionsLoggedIn.style.display = 'flex';

    // ★ v3.2 FIX: Auto-redirect authenticated users to dashboard
    // If user has a camp, they should NEVER sit on the landing page
    const cachedCampId = localStorage.getItem('campistry_camp_id');
    if (cachedCampId) {
        console.log('[Landing] Authenticated user with camp detected — redirecting to dashboard');
        window.location.href = 'dashboard.html';
        return;
    }
}

function updateUIForLoggedOutState() {
    const navActions = document.getElementById('navActions');
    const navActionsLoggedIn = document.getElementById('navActionsLoggedIn');
    if (navActions) navActions.style.display = 'flex';
    if (navActionsLoggedIn) navActionsLoggedIn.style.display = 'none';
}

function resetFormButton() {
    const formSubmit = document.getElementById('formSubmit');
    if (formSubmit) {
        formSubmit.disabled = false;
        formSubmit.textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';
    }
}

function showAuthLoading(show, message = 'Connecting...') {
    const authLoading = document.getElementById('authLoading');
    const authLoadingText = document.getElementById('authLoadingText');
    if (authLoading) authLoading.style.display = show ? 'flex' : 'none';
    if (authLoadingText) authLoadingText.textContent = message;
}

function showAuthError(message) {
    const authError = document.getElementById('authError');
    if (authError) {
        authError.textContent = message;
        authError.style.display = message ? 'block' : 'none';
    }
}

// ========================================
// POST-AUTH SETUP — shared by "signup with an immediate session" (only
// possible if Confirm Email is somehow off) and "signup, then verify the
// emailed code" (the normal path once it's on). Creates the camp, or
// accepts a pending invite if this email was invited to an existing camp.
// ========================================
async function finishAccountSetup(supabase, user, campName, accessCode) {
    const email = user.email.toLowerCase();
    try {
        // Query WITHOUT .is('user_id', null) — catches invites that
        // supabase_client.js may have already accepted via race
        const { data: existingInvite } = await supabase
            .from('camp_users')
            .select('id, role, camp_id, subdivision_ids, user_id')
            .eq('email', email)
            .maybeSingle();

        if (existingInvite) {
            // Accept if not yet accepted (may already be done by race)
            if (!existingInvite.user_id) {
                await supabase
                    .from('camp_users')
                    .update({
                        user_id: user.id,
                        accepted_at: new Date().toISOString()
                    })
                    .eq('id', existingInvite.id);
            }
            localStorage.setItem('campistry_camp_id', existingInvite.camp_id);
            localStorage.setItem('campistry_user_id', existingInvite.camp_id);
            localStorage.setItem('campistry_auth_user_id', user.id);
            localStorage.setItem('campistry_role', existingInvite.role);
            localStorage.setItem('campistry_is_team_member', 'true');
            console.log('[Landing] Invite detected, role:', existingInvite.role);
        } else {
            // No invite — create camp (camp ID = user ID for owners)

            // ★★★ ACCESS CODE VALIDATION — ALL SERVER-SIDE ★★★
            if (!accessCode) {
                throw new Error('An access code is required to create a camp. Contact campistryoffice@gmail.com for access.');
            }

            let planStatus = null;
            let trialStartedAt = null;
            let trialHours = null;

            // Validate via Supabase RPC — codes stored in promo_codes table
            try {
                const { data: codeResult, error: codeError } = await supabase
                    .rpc('validate_access_code', { input_code: accessCode });

                console.log('[Landing] Access code check:', codeResult, 'error:', codeError);

                if (codeError) {
                    console.error('[Landing] Access code RPC error:', codeError);
                    throw new Error('Could not verify access code. Please try again.');
                }

                if (!codeResult || !codeResult.valid) {
                    throw new Error('Invalid access code. Contact campistryoffice@gmail.com for access.');
                }

                planStatus = codeResult.plan_status || 'active';
                if (codeResult.trial_hours) {
                    trialStartedAt = new Date().toISOString();
                    trialHours = codeResult.trial_hours;
                }
                console.log('[Landing] ✅ Code accepted →', planStatus, trialHours ? '(' + trialHours + 'h)' : '(no time limit)');
            } catch (codeErr) {
                if (codeErr.message.includes('access code') || codeErr.message.includes('Contact')) {
                    throw codeErr; // Re-throw our own errors
                }
                console.error('[Landing] Code validation failed:', codeErr);
                throw new Error('Could not verify access code. Please try again.');
            }

            const { data: campData, error: campError } = await supabase
                .from('camps')
                .insert([{
                    id: user.id,
                    owner: user.id,
                    name: campName,
                    address: '',
                    plan_status: planStatus,
                    trial_started_at: trialStartedAt,
                    trial_hours: trialHours
                }])
                .select()
                .single();

            if (campError) {
                console.error('[Landing] Camp creation failed:', campError);
                if (campError.code === '23505') {
                    // Duplicate key — camp already exists, that's fine
                    console.log('[Landing] Camp already exists (23505), proceeding');
                } else if (campError.message?.includes('access code')) {
                    throw new Error('Invalid access code. Contact campistryoffice@gmail.com for access.');
                } else {
                    throw new Error('Could not create camp. Please try again.');
                }
            } else {
                console.log('[Landing] ✅ Camp created:', campData);
            }

            localStorage.setItem('campistry_camp_id', user.id);
            localStorage.setItem('campistry_user_id', user.id);
            localStorage.setItem('campistry_auth_user_id', user.id);
            localStorage.setItem('campistry_role', 'owner');
            localStorage.setItem('campistry_is_team_member', 'false');
            console.log('[Landing] Camp created for owner:', user.id);
        }
    } catch (setupErr) {
        console.error('[Landing] Post-signup setup error:', setupErr);
        throw setupErr;
    }
}

// ========================================
// LOGIN SETUP — detect invite/camp/membership for an existing account
// that just authenticated (either via secure-login directly, or after
// finishing email verification on a previously-unconfirmed account).
// ========================================
async function finishLoginSetup(supabase, user) {
    const email = user.email.toLowerCase();
    try {
        const { data: pendingInvite } = await supabase
            .from('camp_users')
            .select('id, role, camp_id, subdivision_ids, user_id')
            .eq('email', email)
            .is('user_id', null)
            .maybeSingle();

        if (pendingInvite) {
            await supabase.from('camp_users').update({
                user_id: user.id,
                accepted_at: new Date().toISOString()
            }).eq('id', pendingInvite.id);

            localStorage.setItem('campistry_camp_id', pendingInvite.camp_id);
            localStorage.setItem('campistry_user_id', pendingInvite.camp_id);
            localStorage.setItem('campistry_auth_user_id', user.id);
            localStorage.setItem('campistry_role', pendingInvite.role);
            localStorage.setItem('campistry_is_team_member', 'true');
        } else {
            // Multi-camp owners (super-admin debug copies): fetch
            // all, pick the real camp (id == uid). Avoid
            // .maybeSingle() which throws on >1 row.
            const { data: ownedCamps } = await supabase
                .from('camps').select('id, name')
                .eq('owner', user.id);
            const ownedCamp = (Array.isArray(ownedCamps) && ownedCamps.length > 0)
                ? (ownedCamps.find(c => c.id === user.id) || ownedCamps[0])
                : null;

            if (ownedCamp) {
                localStorage.setItem('campistry_camp_id', ownedCamp.id);
                localStorage.setItem('campistry_user_id', ownedCamp.id);
                localStorage.setItem('campistry_auth_user_id', user.id);
                localStorage.setItem('campistry_role', 'owner');
                localStorage.setItem('campistry_is_team_member', 'false');
            } else {
                const { data: membership } = await supabase
                    .from('camp_users').select('camp_id, role')
                    .eq('user_id', user.id)
                    .not('accepted_at', 'is', null)
                    .maybeSingle();

                if (membership) {
                    localStorage.setItem('campistry_camp_id', membership.camp_id);
                    localStorage.setItem('campistry_user_id', membership.camp_id);
                    localStorage.setItem('campistry_auth_user_id', user.id);
                    localStorage.setItem('campistry_role', membership.role);
                    localStorage.setItem('campistry_is_team_member', 'true');
                } else {
                    localStorage.removeItem('campistry_camp_id');
                    localStorage.removeItem('campistry_role');
                    localStorage.removeItem('campistry_is_team_member');
                    localStorage.setItem('campistry_auth_user_id', user.id);
                }
            }
        }
    } catch (loginSetupErr) {
        console.error('[Landing] Login setup error:', loginSetupErr);
    }
}

// ========================================
// Shared tail: force supabase_client.js to re-detect, then redirect.
// ========================================
async function completeAuthFlow() {
    if (window.CampistryDB?.refresh) {
        try { await window.CampistryDB.refresh(); } catch (e) {}
    }
    showAuthLoading(true, 'Success! Redirecting...');
    closeAuthModal();
    setTimeout(() => { window.location.href = 'dashboard.html'; }, 500);
}

function showAuthInfo(message) {
    const authInfo = document.getElementById('authInfo');
    if (authInfo) {
        authInfo.textContent = message;
        authInfo.style.display = message ? 'block' : 'none';
    }
}

// ========================================
// VERIFICATION CODE STEP
// (shown after signup, or when an existing-but-unconfirmed account tries
// to log in — same modal, swapped content, no page navigation)
// ========================================
function showVerifyCodeStep(email) {
    const modalToggle = document.getElementById('modalToggle');
    const authForm = document.getElementById('authForm');
    const verifyCodeForm = document.getElementById('verifyCodeForm');
    const verifyCodeFooter = document.getElementById('verifyCodeFooter');
    const authFooterDefault = document.getElementById('authFooterDefault');
    const modalTitle = document.getElementById('modalTitle');
    const modalSubtitle = document.getElementById('modalSubtitle');
    const verifyCodeEmail = document.getElementById('verifyCodeEmail');

    if (modalToggle) modalToggle.style.display = 'none';
    if (authForm) authForm.style.display = 'none';
    if (verifyCodeForm) verifyCodeForm.style.display = 'block';
    if (verifyCodeFooter) verifyCodeFooter.style.display = 'block';
    if (authFooterDefault) authFooterDefault.style.display = 'none';
    if (modalTitle) modalTitle.textContent = 'Check Your Email';
    if (modalSubtitle) modalSubtitle.textContent = 'One more step to secure your account.';
    if (verifyCodeEmail) verifyCodeEmail.textContent = email;

    showAuthError('');
    showAuthInfo('');
    showAuthLoading(false);
    const verifyError = document.getElementById('verifyCodeError');
    if (verifyError) verifyError.textContent = '';
    const codeInput = document.getElementById('verifyCodeInput');
    if (codeInput) { codeInput.value = ''; setTimeout(() => codeInput.focus(), 100); }

    const authModal = document.getElementById('authModal');
    if (authModal) authModal.style.display = 'flex';
}

function hideVerifyCodeStep() {
    const modalToggle = document.getElementById('modalToggle');
    const authForm = document.getElementById('authForm');
    const verifyCodeForm = document.getElementById('verifyCodeForm');
    const verifyCodeFooter = document.getElementById('verifyCodeFooter');
    const authFooterDefault = document.getElementById('authFooterDefault');

    if (modalToggle) modalToggle.style.display = 'flex';
    if (authForm) authForm.style.display = 'block';
    if (verifyCodeForm) verifyCodeForm.style.display = 'none';
    if (verifyCodeFooter) verifyCodeFooter.style.display = 'none';
    if (authFooterDefault) authFooterDefault.style.display = 'block';
    _pendingAuth = null;
    updateModalUI();
}

// ========================================
// MOBILE MENU
// ========================================
function toggleMobileMenu() {
    const toggle = document.getElementById('mobileToggle');
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileOverlay');
    
    const isOpen = drawer?.classList.contains('open');
    
    if (isOpen) {
        toggle?.classList.remove('open');
        drawer?.classList.remove('open');
        overlay?.classList.remove('open');
        document.body.style.overflow = '';
    } else {
        toggle?.classList.add('open');
        drawer?.classList.add('open');
        overlay?.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
}

// ========================================
// NAV SCROLL BEHAVIOR
// ========================================
function initNavScroll() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            requestAnimationFrame(() => {
                if (window.scrollY > 40) {
                    nav.classList.add('nav-scrolled');
                } else {
                    nav.classList.remove('nav-scrolled');
                }
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });
}

// ========================================
// ACTIVE NAV SECTION INDICATOR
// ========================================
function initActiveNav() {
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-links a');
    if (!sections.length || !navLinks.length) return;
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.getAttribute('id');
                navLinks.forEach(link => {
                    link.classList.toggle('active', link.getAttribute('href') === '#' + id);
                });
            }
        });
    }, {
        rootMargin: '-30% 0px -60% 0px',
        threshold: 0
    });
    
    sections.forEach(section => observer.observe(section));
}

// ========================================
// SCROLL REVEAL
// ========================================
function initScrollReveal() {
    const reveals = document.querySelectorAll('.reveal');
    if (!reveals.length) return;
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -40px 0px'
    });
    
    reveals.forEach(el => observer.observe(el));
}

// ========================================
// DOM READY
// ========================================
document.addEventListener('DOMContentLoaded', function() {
    initNavScroll();
    initActiveNav();
    initScrollReveal();
    
    const supabase = getSupabase();
    if (!supabase) {
        console.warn('Supabase client not ready');
    }
    
    document.querySelectorAll('.modal-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            authMode = btn.dataset.mode;
            updateModalUI();
        });
    });

    // =====================================================================
    // AUTH FORM SUBMISSION
    // =====================================================================
    const authForm = document.getElementById('authForm');
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = document.getElementById('authEmail')?.value?.trim();
            const password = document.getElementById('authPassword')?.value;
            const campName = document.getElementById('campName')?.value?.trim();
            const accessCode = document.getElementById('accessCode')?.value?.trim();
            const formSubmit = document.getElementById('formSubmit');

            showAuthError('');
            showAuthInfo('');
            showAuthLoading(false);

            if (!email || !password) {
                showAuthError('Please fill in all fields.');
                return;
            }

            if (authMode === 'signup') {
                if (!campName) {
                    showAuthError('Please enter your camp name.');
                    return;
                }
            }

            if (formSubmit) {
                formSubmit.disabled = true;
                formSubmit.textContent = authMode === 'signup' ? 'Creating...' : 'Signing in...';
            }
            showAuthLoading(true, 'Connecting to server...');

            try {
                const supabase = getSupabase();
                if (!supabase) {
                    throw new Error('Authentication service is not available. Please refresh the page.');
                }

                if (authMode === 'signup') {
                    showAuthLoading(true, 'Creating your account...');
                    const { data, error } = await supabase.auth.signUp({
                        email,
                        password,
                        options: { data: { camp_name: campName, access_code: accessCode } }
                    });

                    if (error) {
                        let errorMessage = error.message;
                        if (error.message.includes('User already registered')) {
                            errorMessage = 'An account with this email already exists. Try signing in instead.';
                        }
                        throw new Error(errorMessage);
                    }

                    if (data?.user && !data?.session) {
                        // Confirm Email is on (the expected setup) — GoTrue
                        // emailed a verification code instead of returning a
                        // session directly. Hand off to the code-entry step;
                        // finishAccountSetup runs after a correct code, not
                        // here.
                        _pendingAuth = { email, campName, accessCode, from: 'signup' };
                        resetFormButton();
                        showVerifyCodeStep(email);
                        return;
                    }

                    // A session came back directly — only happens if
                    // Confirm Email is somehow off. Finish immediately,
                    // same setup the code-verification path runs.
                    const user = data?.user;
                    if (!user) throw new Error('Authentication failed. Please try again.');
                    showAuthLoading(true, 'Setting up your camp...');
                    await finishAccountSetup(supabase, user, campName, accessCode);
                    await completeAuthFlow();
                    return;
                }

                // =========================================================
                // LOGIN — proxied through the secure-login edge function so
                // the account-lockout in migration 105 is actually
                // enforced. A direct signInWithPassword() call here could
                // just skip that check, so every password attempt has to
                // go through the server-side function instead.
                // =========================================================
                showAuthLoading(true, 'Verifying credentials...');
                const fnResult = await supabase.functions
                    .invoke('secure-login', { body: { email, password } })
                    .then(unwrapFnResult);

                if (fnResult?.emailNotConfirmed) {
                    _pendingAuth = { email, from: 'login' };
                    resetFormButton();
                    showVerifyCodeStep(email);
                    return;
                }

                if (fnResult?.error || !fnResult?.access_token) {
                    throw new Error(fnResult?.error || 'Invalid email or password. Please try again.');
                }

                const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
                    access_token: fnResult.access_token,
                    refresh_token: fnResult.refresh_token
                });
                if (sessionError || !sessionData?.user) {
                    throw new Error('Sign-in succeeded but the session could not be established. Please try again.');
                }

                showAuthLoading(true, 'Loading your camp...');
                await finishLoginSetup(supabase, sessionData.user);
                await completeAuthFlow();

            } catch (e) {
                showAuthLoading(false);
                showAuthError(e.message || 'An unexpected error occurred. Please try again.');
                resetFormButton();
            }
        });
    }

    // =====================================================================
    // VERIFICATION CODE SUBMISSION
    // =====================================================================
    const verifyCodeForm = document.getElementById('verifyCodeForm');
    if (verifyCodeForm) {
        verifyCodeForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('verifyCodeInput')?.value?.trim();
            const verifyBtn = document.getElementById('verifyCodeSubmit');
            const verifyError = document.getElementById('verifyCodeError');
            const verifyLoading = document.getElementById('verifyCodeLoading');

            if (verifyError) verifyError.textContent = '';

            if (!_pendingAuth?.email) {
                if (verifyError) verifyError.textContent = 'Something went wrong — please start over.';
                return;
            }
            if (!code || code.length !== 6) {
                if (verifyError) verifyError.textContent = 'Enter the 6-digit code from your email.';
                return;
            }

            if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = 'Verifying...'; }
            if (verifyLoading) verifyLoading.style.display = 'flex';

            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error('Authentication service is not available. Please refresh the page.');

                const { data, error } = await supabase.auth.verifyOtp({
                    email: _pendingAuth.email,
                    token: code,
                    type: 'signup'
                });
                if (error) throw error;

                const user = data?.user;
                if (!user) throw new Error('Verification failed. Please try again.');

                const pending = _pendingAuth;
                _pendingAuth = null;

                if (pending.from === 'signup') {
                    showAuthLoading(true, 'Setting up your camp...');
                    await finishAccountSetup(supabase, user, pending.campName, pending.accessCode);
                } else {
                    showAuthLoading(true, 'Loading your camp...');
                    await finishLoginSetup(supabase, user);
                }
                await completeAuthFlow();

            } catch (err) {
                if (verifyLoading) verifyLoading.style.display = 'none';
                if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = 'Verify & Continue'; }
                if (verifyError) verifyError.textContent = err.message || 'Invalid or expired code. Please try again.';
            }
        });
    }

    const resendCodeLink = document.getElementById('resendCodeLink');
    if (resendCodeLink) {
        resendCodeLink.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!_pendingAuth?.email) return;
            const verifyError = document.getElementById('verifyCodeError');
            const original = resendCodeLink.textContent;
            resendCodeLink.textContent = 'Sending...';
            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error('Authentication service is not available.');
                const { error } = await supabase.auth.resend({ type: 'signup', email: _pendingAuth.email });
                if (error) throw error;
                if (verifyError) { verifyError.textContent = ''; }
                showAuthInfo('A new code has been sent to ' + _pendingAuth.email + '.');
            } catch (err) {
                if (verifyError) verifyError.textContent = err.message || 'Could not resend the code. Please try again.';
            } finally {
                resendCodeLink.textContent = original;
            }
        });
    }

    const verifyCodeBackLink = document.getElementById('verifyCodeBackLink');
    if (verifyCodeBackLink) {
        verifyCodeBackLink.addEventListener('click', (e) => {
            e.preventDefault();
            hideVerifyCodeStep();
        });
    }

    // =====================================================================
    // UNLOCK-LINK LANDING — ?unlock=<token> from the account-lockout email
    // =====================================================================
    (async function checkForUnlockToken(retriesLeft) {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('unlock');
        if (!token) return;

        const supabase = getSupabase();
        if (!supabase) {
            if (retriesLeft === undefined) retriesLeft = 10;
            if (retriesLeft > 0) setTimeout(() => checkForUnlockToken(retriesLeft - 1), 300);
            return;
        }

        // Strip it from the URL immediately so a refresh/share doesn't
        // re-submit the same token.
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);

        try {
            const { data, error } = await supabase.rpc('unlock_account_via_token', { p_token: token });
            openAuthModal('login');
            if (!error && data?.success) {
                showAuthInfo('Your account has been reopened — you can sign in below.');
            } else {
                showAuthError('That unlock link is invalid or has expired. If your account is still locked, request a new one by trying to sign in again.');
            }
        } catch (e) {
            console.error('[Landing] Unlock token check failed:', e);
        }
    })();

    // =====================================================================
    // PASSWORD RESET REQUEST
    // =====================================================================
    const resetRequestForm = document.getElementById('resetRequestForm');
    if (resetRequestForm) {
        resetRequestForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const emailInput = document.getElementById('resetEmail');
            const submitBtn = document.getElementById('resetSubmit');
            const resetError = document.getElementById('resetError');
            const resetSuccess = document.getElementById('resetSuccess');
            const email = emailInput?.value?.trim();
            
            if (!email) {
                if (resetError) resetError.textContent = 'Please enter your email address.';
                return;
            }
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }
            if (resetError) resetError.textContent = '';
            if (resetSuccess) resetSuccess.style.display = 'none';
            
            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error('Authentication service not available. Please refresh the page.');
                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin + '/index.html#reset-password'
                });
                if (error) throw error;
                if (resetSuccess) { resetSuccess.textContent = 'Reset link sent! Check your email.'; resetSuccess.style.display = 'block'; }
                if (emailInput) emailInput.disabled = true;
                if (submitBtn) submitBtn.textContent = 'Email Sent';
            } catch (err) {
                if (resetError) resetError.textContent = err.message || 'Failed to send reset link.';
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Reset Link'; }
            }
        });
    }

    // =====================================================================
    // PASSWORD UPDATE
    // =====================================================================
    const updatePasswordForm = document.getElementById('updatePasswordForm');
    if (updatePasswordForm) {
        updatePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPassword = document.getElementById('newPassword')?.value;
            const confirmPassword = document.getElementById('confirmNewPassword')?.value;
            const submitBtn = document.getElementById('updatePasswordSubmit');
            const updateError = document.getElementById('updateError');
            const updateSuccess = document.getElementById('updateSuccess');
            
            if (updateError) updateError.textContent = '';
            if (updateSuccess) updateSuccess.style.display = 'none';
            if (!newPassword || newPassword.length < 6) {
                if (updateError) updateError.textContent = 'Password must be at least 6 characters.';
                return;
            }
            if (newPassword !== confirmPassword) {
                if (updateError) updateError.textContent = 'Passwords do not match.';
                return;
            }
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Updating...'; }
            
            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error('Authentication service not available');
                const { error } = await supabase.auth.updateUser({ password: newPassword });
                if (error) throw error;
                if (updateSuccess) { updateSuccess.textContent = 'Password updated! Redirecting...'; updateSuccess.style.display = 'block'; }
                if (submitBtn) submitBtn.textContent = 'Password Updated';
                setTimeout(() => { closeResetModal(); window.location.href = 'dashboard.html'; }, 2000);
            } catch (err) {
                if (updateError) updateError.textContent = err.message || 'Failed to update password.';
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Update Password'; }
            }
        });
    }

    function checkForPasswordResetToken() {
        const hash = window.location.hash;
        if (hash.includes('access_token') || hash.includes('type=recovery') || hash === '#reset-password') {
            const resetModal = document.getElementById('resetPasswordModal');
            const resetRequestView = document.getElementById('resetRequestView');
            const updatePasswordView = document.getElementById('updatePasswordView');
            if (resetModal) {
                resetModal.style.display = 'flex';
                if (resetRequestView) resetRequestView.style.display = 'none';
                if (updatePasswordView) updatePasswordView.style.display = 'block';
                setTimeout(() => document.getElementById('newPassword')?.focus(), 100);
            }
        }
    }

    async function checkSession() {
        // ★ v3.2 FIX: Fast-check localStorage BEFORE waiting for Supabase
        // If user has cached auth + camp, redirect immediately to dashboard
        const cachedUserId = localStorage.getItem('campistry_auth_user_id');
        const cachedCampId = localStorage.getItem('campistry_camp_id');
        if (cachedUserId && cachedCampId) {
            console.log('[Landing] checkSession: cached auth found — redirecting to dashboard');
            window.location.href = 'dashboard.html';
            return;
        }

        const supabase = getSupabase();
        if (!supabase) { updateUIForLoggedOutState(); return; }
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) { updateUIForLoggedInState(session.user); }
            else { updateUIForLoggedOutState(); }
        } catch (e) { updateUIForLoggedOutState(); }
    }

    function setupAuthListener() {
        const supabase = getSupabase();
        if (!supabase) { setTimeout(setupAuthListener, 500); return; }
        supabase.auth.onAuthStateChange((event, session) => {
           if (event === 'SIGNED_IN' && session?.user) {
                // ★ v3.2: If user already has a camp, go straight to dashboard
                const cachedCampId = localStorage.getItem('campistry_camp_id');
                if (cachedCampId) {
                    console.log('[Landing] Auth listener: signed-in user has camp — redirecting to dashboard');
                    window.location.href = 'dashboard.html';
                    return;
                }
                updateUIForLoggedInState(session.user);
            } else if (event === 'SIGNED_OUT') {
                updateUIForLoggedOutState();
            } else if (event === 'PASSWORD_RECOVERY') {
                const resetModal = document.getElementById('resetPasswordModal');
                const resetRequestView = document.getElementById('resetRequestView');
                const updatePasswordView = document.getElementById('updatePasswordView');
                if (resetModal) {
                    resetModal.style.display = 'flex';
                    if (resetRequestView) resetRequestView.style.display = 'none';
                    if (updatePasswordView) updatePasswordView.style.display = 'block';
                }
            }
        });
    }

    checkSession();
    checkForPasswordResetToken();
    setupAuthListener();
});

// ========================================
// SMOOTH SCROLL FOR ANCHOR LINKS
// ========================================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (href === '#') return;
        const target = document.querySelector(href);
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});
