// ============================================================================
// landing.js — Campistry Landing Page
// 
// Flow:
// - Landing page is public (anyone can browse)
// - Sign Up requires: Camp Name + Email + Password + Access Code
// - Sign In requires: Email + Password only
// - After auth: Redirect to dashboard.html
// - Password Reset: Email-based recovery flow
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
// AUTH MODAL FUNCTIONS (Global - for onclick handlers)
// ========================================
function openAuthModal(mode = 'login') {
    authMode = mode;
    const authModal = document.getElementById('authModal');
    if (authModal) {
        authModal.style.display = 'flex';
        updateModalUI();
        
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
    if (authModal) authModal.style.display = 'none';
    if (authForm) authForm.reset();
    if (authError) authError.textContent = '';
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
        if (window.supabase) {
            await window.supabase.auth.signOut();
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
    const forgotLink = document.querySelector('.forgot-password-link');
    
    if (authMode === 'signup') {
        if (modalTitle) modalTitle.textContent = 'Create Account';
        if (modalSubtitle) modalSubtitle.textContent = 'Get started with Campistry today.';
        if (formSubmit) formSubmit.textContent = 'Create Account';
        if (campNameGroup) campNameGroup.style.display = 'block';
        if (accessCodeGroup) accessCodeGroup.style.display = 'block';
        if (forgotLink) forgotLink.style.display = 'none';
    } else {
        if (modalTitle) modalTitle.textContent = 'Welcome Back';
        if (modalSubtitle) modalSubtitle.textContent = 'Sign in to your Campistry account.';
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

// ========================================
// DOM READY
// ========================================
document.addEventListener('DOMContentLoaded', function() {
    
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
            const authError = document.getElementById('authError');
            const formSubmit = document.getElementById('formSubmit');

            if (authError) authError.textContent = '';

            if (!email || !password) {
                if (authError) authError.textContent = 'Please fill in all fields.';
                return;
            }

            if (authMode === 'signup') {
                if (!campName) {
                    if (authError) authError.textContent = 'Please enter your camp name.';
                    return;
                }
                if (accessCode !== GLOBAL_ACCESS_CODE) {
                    if (authError) authError.textContent = 'Invalid access code. Contact support for access.';
                    return;
                }
            }

            if (formSubmit) {
                formSubmit.disabled = true;
                formSubmit.textContent = authMode === 'signup' ? 'Creating...' : 'Signing in...';
            }

            try {
                if (!window.supabase) {
                    throw new Error('Authentication service not available. Please refresh.');
                }

                let result;
                if (authMode === 'signup') {
                    result = await window.supabase.auth.signUp({
                        email,
                        password,
                        options: { data: { camp_name: campName } }
                    });
                } else {
                    result = await window.supabase.auth.signInWithPassword({ email, password });
                }

                const { data, error } = result;

                if (error) throw error;

                const user = data?.user;

                if (authMode === 'signup' && user && !user.confirmed_at) {
                    if (authError) authError.textContent = 'Please check your email to confirm your account.';
                    resetFormButton();
                    return;
                }

                if (!user) {
                    if (authError) authError.textContent = 'Authentication failed. Please try again.';
                    resetFormButton();
                    return;
                }

                console.log('🔐 Success! Redirecting...');
                closeAuthModal();
                window.location.href = 'dashboard.html';

            } catch (e) {
                console.error('🔐 Error:', e);
                if (authError) authError.textContent = e.message || 'An unexpected error occurred.';
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
                if (!window.supabase) {
                    throw new Error('Authentication service not available');
                }
                
                const { error } = await window.supabase.auth.resetPasswordForEmail(email, {
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
                if (!window.supabase) throw new Error('Authentication service not available');
                
                const { error } = await window.supabase.auth.updateUser({ password: newPassword });
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
        if (!window.supabase) {
            console.log('Supabase not available');
            updateUIForLoggedOutState();
            return;
        }

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
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

    // Auth State Listener
    if (window.supabase) {
        window.supabase.auth.onAuthStateChange((event, session) => {
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
    }

    // Initialize
    checkSession();
    checkForPasswordResetToken();
});
