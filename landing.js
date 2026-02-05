// ============================================================================
// landing.js — Campistry Landing Page
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
// AUTH MODAL FUNCTIONS
// ========================================
function openAuthModal(mode = 'login') {
    authMode = mode;
    const authModal = document.getElementById('authModal');
    if (authModal) {
        authModal.style.display = 'flex';
        updateModalUI();
        
        const authError = document.getElementById('authError');
        if (authError) authError.textContent = '';
        
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

function handleLogout() {
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
                    link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
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
    // Init visual behaviors
    initNavScroll();
    initActiveNav();
    initScrollReveal();
    
    // Verify Supabase
    const supabase = getSupabase();
    if (!supabase) {
        console.warn('Supabase client not ready');
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

            showAuthError('');
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
                if (accessCode !== GLOBAL_ACCESS_CODE) {
                    showAuthError('Invalid access code. Contact campistryoffice@gmail.com for access.');
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

                if (authMode === 'signup' && user && !user.confirmed_at) {
                    showAuthLoading(false);
                    showAuthError('');
                    const authSuccess = document.createElement('div');
                    authSuccess.className = 'auth-success';
                    authSuccess.style.display = 'block';
                    authSuccess.textContent = 'Account created! Please check your email to confirm.';
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

                showAuthLoading(true, 'Success! Redirecting...');
                closeAuthModal();
                
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 500);

            } catch (e) {
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
                    redirectTo: window.location.origin + '/index.html#reset-password'
                });
                
                if (error) throw error;
                
                if (resetSuccess) {
                    resetSuccess.textContent = 'Reset link sent! Check your email inbox.';
                    resetSuccess.style.display = 'block';
                }
                
                if (emailInput) emailInput.disabled = true;
                if (submitBtn) {
                    submitBtn.textContent = 'Email Sent';
                    submitBtn.disabled = true;
                }
                
            } catch (err) {
                if (resetError) resetError.textContent = err.message || 'Failed to send reset link.';
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Send Reset Link';
                }
            }
        });
    }

    // Password Update Form
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
                    updateSuccess.textContent = 'Password updated! Redirecting...';
                    updateSuccess.style.display = 'block';
                }
                if (submitBtn) submitBtn.textContent = 'Password Updated';
                
                setTimeout(() => {
                    closeResetModal();
                    window.location.href = 'dashboard.html';
                }, 2000);
                
            } catch (err) {
                if (updateError) updateError.textContent = err.message || 'Failed to update password.';
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Update Password';
                }
            }
        });
    }

    // Check for Password Reset Token
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

    // Session Check
    async function checkSession() {
        const supabase = getSupabase();
        if (!supabase) {
            updateUIForLoggedOutState();
            return;
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                updateUIForLoggedInState(session.user);
            } else {
                updateUIForLoggedOutState();
            }
        } catch (e) {
            updateUIForLoggedOutState();
        }
    }

    // Auth State Listener
    function setupAuthListener() {
        const supabase = getSupabase();
        if (!supabase) {
            setTimeout(setupAuthListener, 500);
            return;
        }
        
        supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session?.user) {
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

    // Initialize
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
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});
