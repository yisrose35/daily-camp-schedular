// ============================================================================
// landing.js — Campistry Landing Page (FIXED v2)
// 
// FIXES:
// - Better Supabase initialization checking
// - Defensive checks for supabase.auth
// - Retry logic for auth service
// - Improved error messages
// ============================================================================

// ========================================
// CONSTANTS
// ========================================
const GLOBAL_ACCESS_CODE = 'jUsTCAmPit2026';

// ========================================
// GLOBAL STATE
// ========================================
let authMode = 'login';

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
// AUTH MODAL FUNCTIONS (Global - for onclick handlers)
// ========================================
function openAuthModal(mode = 'login') {
    authMode = mode;
    const authModal = document.getElementById('authModal');
    if (authModal) {
        authModal.style.display = 'flex';
        updateModalUI();
        
        // Clear any previous errors
        const authError = document.getElementById('authError');
        if (authError) authError.textContent = '';
        
        setTimeout(() => {
            if (mode === 'signup') {
                document.getElementById('campName')?.focus();
            } else {
                document.getElementById('authEmail')?.focus();
            }
        }, 100);
    } else {
        console.error('Auth modal not found!');
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

async function handleLogout() {
    try {
        const supabase = getSupabase();
        if (supabase) {
            await supabase.auth.signOut();
        }
        updateUIForLoggedOutState();
        console.log('🔐 Logged out successfully');
    } catch (e) {
        console.error('Logout error:', e);
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
    
    if (authLoading) {
        authLoading.style.display = show ? 'flex' : 'none';
    }
    if (authLoadingText) {
        authLoadingText.textContent = message;
    }
}

function showAuthError(message) {
    const authError = document.getElementById('authError');
    if (authError) {
        authError.textContent = message;
        authError.style.display = message ? 'block' : 'none';
    }
}

// ========================================
// MOBILE MENU TOGGLE
// ========================================
function toggleMobileMenu() {
    // TODO: Implement mobile menu toggle
    console.log('Mobile menu toggle - implement as needed');
}

// ========================================
// DOM READY
// ========================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 Landing page initializing...');
    
    // Verify Supabase is available
    const supabase = getSupabase();
    if (!supabase) {
        console.error('⚠️ Supabase client not ready - window.supabase:', window.supabase);
        console.error('⚠️ window.supabase.auth:', window.supabase?.auth);
    } else {
        console.log('✅ Supabase client available');
    }
    
    // Modal Toggle Buttons
    document.querySelectorAll('.modal-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            authMode = btn.dataset.mode;
            updateModalUI();
        });
    });

    // Auth Form Submission
    const authForm = document.getElementById('authForm');
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = document.getElementById('authEmail')?.value?.trim();
            const password = document.getElementById('authPassword')?.value;
            const campName = document.getElementById('campName')?.value?.trim();
            const accessCode = document.getElementById('accessCode')?.value?.trim();
            const formSubmit = document.getElementById('formSubmit');

            // Clear previous errors
            showAuthError('');
            showAuthLoading(false);

            // Validate inputs
            if (!email || !password) {
                showAuthError('Please fill in all fields.');
                return;
            }

            if (authMode === 'signup') {
                if (!campName) {
                    showAuthError('Please enter your camp name.');
                    return;
                }
                if (accessCode !== GLOBAL_ACCESS_CODE) {
                    showAuthError('Invalid access code. Contact campistryoffice@gmail.com for access.');
                    return;
                }
            }

            // Disable button and show loading
            if (formSubmit) {
                formSubmit.disabled = true;
                formSubmit.textContent = authMode === 'signup' ? 'Creating...' : 'Signing in...';
            }
            showAuthLoading(true, 'Connecting to server...');

            try {
                // Check if Supabase is available
                const supabase = getSupabase();
                if (!supabase) {
                    throw new Error('Authentication service is not available. Please refresh the page.');
                }

                let result;
                if (authMode === 'signup') {
                    showAuthLoading(true, 'Creating your account...');
                    result = await supabase.auth.signUp({
                        email,
                        password,
                        options: { data: { camp_name: campName } }
                    });
                } else {
                    showAuthLoading(true, 'Verifying credentials...');
                    result = await supabase.auth.signInWithPassword({ email, password });
                }

                const { data, error } = result;

                if (error) {
                    // Provide more helpful error messages
                    let errorMessage = error.message;
                    
                    if (error.message.includes('Invalid login credentials')) {
                        errorMessage = 'Invalid email or password. Please try again.';
                    } else if (error.message.includes('Email not confirmed')) {
                        errorMessage = 'Please check your email to confirm your account before signing in.';
                    } else if (error.message.includes('User already registered')) {
                        errorMessage = 'An account with this email already exists. Try signing in instead.';
                    }
                    
                    throw new Error(errorMessage);
                }

                const user = data?.user;

                // Handle email confirmation for signups
                if (authMode === 'signup' && user && !user.confirmed_at) {
                    showAuthLoading(false);
                    showAuthError('');
                    const authSuccess = document.createElement('div');
                    authSuccess.className = 'auth-success';
                    authSuccess.style.display = 'block';
                    authSuccess.textContent = '✓ Account created! Please check your email to confirm.';
                    document.getElementById('authError')?.parentNode?.insertBefore(
                        authSuccess, 
                        document.getElementById('authError')
                    );
                    resetFormButton();
                    return;
                }

                if (!user) {
                    throw new Error('Authentication failed. Please try again.');
                }

                console.log('🔐 Success! Redirecting...');
                showAuthLoading(true, 'Success! Redirecting...');
                closeAuthModal();
                
                // Small delay for UX
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 500);

            } catch (e) {
                console.error('🔐 Auth Error:', e);
                showAuthLoading(false);
                showAuthError(e.message || 'An unexpected error occurred. Please try again.');
                resetFormButton();
            }
        });
    }

    // Password Reset Request Form
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
            
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Sending...';
            }
            if (resetError) resetError.textContent = '';
            if (resetSuccess) resetSuccess.style.display = 'none';
            
            try {
                const supabase = getSupabase();
                if (!supabase) {
                    throw new Error('Authentication service not available. Please refresh the page.');
                }
                
                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin + '/landing.html#reset-password'
                });
                
                if (error) throw error;
                
                if (resetSuccess) {
                    resetSuccess.textContent = '✓ Reset link sent! Check your email inbox.';
                    resetSuccess.style.display = 'block';
                }
                
                if (emailInput) emailInput.disabled = true;
                if (submitBtn) {
                    submitBtn.textContent = 'Email Sent';
                    submitBtn.disabled = true;
                }
                
            } catch (err) {
                console.error('Password reset error:', err);
                if (resetError) resetError.textContent = err.message || 'Failed to send reset link.';
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Send Reset Link';
                }
            }
        });
    }

    // Password Update Form (after clicking reset link)
    const updatePasswordForm = document.getElementById('updatePasswordForm');
    if (updatePasswordForm) {
        updatePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newPassword = document.getElementById('newPassword')?.value;
            const confirmPassword = document.getElementById('confirmPassword')?.value;
            const submitBtn = document.getElementById('updateSubmit');
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
            
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Updating...';
            }
            
            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error('Authentication service not available');
                
                const { error } = await supabase.auth.updateUser({ password: newPassword });
                if (error) throw error;
                
                if (updateSuccess) {
                    updateSuccess.textContent = '✓ Password updated! Redirecting...';
                    updateSuccess.style.display = 'block';
                }
                if (submitBtn) submitBtn.textContent = 'Password Updated';
                
                setTimeout(() => {
                    closeResetModal();
                    window.location.href = 'dashboard.html';
                }, 2000);
                
            } catch (err) {
                console.error('Password update error:', err);
                if (updateError) updateError.textContent = err.message || 'Failed to update password.';
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Update Password';
                }
            }
        });
    }

    // Check for Password Reset Token in URL
    function checkForPasswordResetToken() {
        const hash = window.location.hash;
        if (hash.includes('access_token') || hash.includes('type=recovery') || hash === '#reset-password') {
            console.log('🔐 Password reset token detected');
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

    // Session Check
    async function checkSession() {
        const supabase = getSupabase();
        if (!supabase) {
            console.log('Supabase not available for session check');
            updateUIForLoggedOutState();
            return;
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                console.log('🔐 User logged in:', session.user.email);
                updateUIForLoggedInState(session.user);
            } else {
                updateUIForLoggedOutState();
            }
        } catch (e) {
            console.error('Session check error:', e);
            updateUIForLoggedOutState();
        }
    }

    // Auth State Listener - with defensive check
    function setupAuthListener() {
        const supabase = getSupabase();
        if (!supabase) {
            console.warn('⚠️ Cannot setup auth listener - Supabase not ready');
            // Retry after a short delay
            setTimeout(setupAuthListener, 500);
            return;
        }
        
        supabase.auth.onAuthStateChange((event, session) => {
            console.log('🔐 Auth state:', event);
            
            if (event === 'SIGNED_IN' && session?.user) {
                updateUIForLoggedInState(session.user);
            } else if (event === 'SIGNED_OUT') {
                updateUIForLoggedOutState();
            } else if (event === 'PASSWORD_RECOVERY') {
                console.log('🔐 Password recovery event');
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
        
        console.log('✅ Auth listener setup complete');
    }

    // Initialize
    checkSession();
    checkForPasswordResetToken();
    setupAuthListener();
    
    console.log('✅ Landing page initialized');
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
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});
