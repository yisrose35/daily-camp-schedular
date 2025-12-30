// ============================================================================
// landing.js — Campistry Landing Page
// 
// Flow:
// - Landing page is public (anyone can browse)
// - Sign Up requires: Camp Name + Email + Password + Access Code
// - Sign In requires: Email + Password only
// - After auth: Redirect to dashboard.html
// - If already logged in: Redirect to dashboard.html
// - Password Reset: Email-based recovery flow
// ============================================================================
(function() {
    'use strict';

    // ========================================
    // CONSTANTS
    // ========================================
    const GLOBAL_ACCESS_CODE = 'jUsTCAmPit2026';

    // ========================================
    // DOM ELEMENTS - AUTH MODAL
    // ========================================
    const authModal = document.getElementById('authModal');
    const authForm = document.getElementById('authForm');
    const modalTitle = document.getElementById('modalTitle');
    const modalSubtitle = document.getElementById('modalSubtitle');
    const formSubmit = document.getElementById('formSubmit');
    const campNameGroup = document.getElementById('campNameGroup');
    const accessCodeGroup = document.getElementById('accessCodeGroup');
    const authError = document.getElementById('authError');
    const modalToggleBtns = document.querySelectorAll('.modal-toggle-btn');

    // Nav elements
    const navActions = document.querySelector('.nav-actions');
    const navActionsLoggedIn = document.querySelector('.nav-actions-logged-in');
    const userMenu = document.getElementById('userMenu');
    const userDropdown = document.getElementById('userDropdown');
    const userEmailDisplay = document.getElementById('userEmailDisplay');
    const userAvatar = document.getElementById('userAvatar');

    let authMode = 'login';

    // ========================================
    // DOM ELEMENTS - PASSWORD RESET MODAL
    // ========================================
    const resetModal = document.getElementById('resetPasswordModal');
    const resetRequestForm = document.getElementById('resetRequestForm');
    const resetRequestView = document.getElementById('resetRequestView');
    const updatePasswordView = document.getElementById('updatePasswordView');
    const updatePasswordForm = document.getElementById('updatePasswordForm');
    const resetError = document.getElementById('resetError');
    const resetSuccess = document.getElementById('resetSuccess');
    const updateError = document.getElementById('updateError');
    const updateSuccess = document.getElementById('updateSuccess');

    // ========================================
    // AUTH MODAL - OPEN/CLOSE
    // ========================================
    window.openAuthModal = function(mode = 'login') {
        authMode = mode;
        if (authModal) authModal.style.display = 'flex';
        updateModalUI();
        
        // Focus first input
        setTimeout(() => {
            if (mode === 'signup') {
                document.getElementById('campName')?.focus();
            } else {
                document.getElementById('authEmail')?.focus();
            }
        }, 100);
    };

    window.closeAuthModal = function() {
        if (authModal) authModal.style.display = 'none';
        if (authForm) authForm.reset();
        if (authError) authError.textContent = '';
    };

    function updateModalUI() {
        if (authMode === 'signup') {
            if (modalTitle) modalTitle.textContent = 'Create Account';
            if (modalSubtitle) modalSubtitle.textContent = 'Get started with Campistry today.';
            if (formSubmit) formSubmit.textContent = 'Create Account';
            if (campNameGroup) campNameGroup.style.display = 'block';
            if (accessCodeGroup) accessCodeGroup.style.display = 'block';
        } else {
            if (modalTitle) modalTitle.textContent = 'Welcome Back';
            if (modalSubtitle) modalSubtitle.textContent = 'Sign in to your Campistry account.';
            if (formSubmit) formSubmit.textContent = 'Sign In';
            if (campNameGroup) campNameGroup.style.display = 'none';
            if (accessCodeGroup) accessCodeGroup.style.display = 'none';
        }

        // Update toggle buttons
        modalToggleBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === authMode);
        });
    }

    // Modal toggle buttons
    modalToggleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            authMode = btn.dataset.mode;
            updateModalUI();
        });
    });

    // Close modal on overlay click
    document.querySelector('.auth-modal-overlay')?.addEventListener('click', closeAuthModal);

    // ========================================
    // AUTH FORM SUBMISSION
    // ========================================
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = document.getElementById('authEmail')?.value?.trim();
            const password = document.getElementById('authPassword')?.value;
            const campName = document.getElementById('campName')?.value?.trim();
            const accessCode = document.getElementById('accessCode')?.value?.trim();

            // Clear previous errors
            if (authError) authError.textContent = '';

            // Validation
            if (!email || !password) {
                if (authError) authError.textContent = 'Please fill in all fields.';
                return;
            }

            // Sign up validation
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

            // Disable submit button
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
                        options: {
                            data: { camp_name: campName }
                        }
                    });
                } else {
                    result = await window.supabase.auth.signInWithPassword({
                        email,
                        password
                    });
                }

                const { data, error } = result;

                if (error) {
                    throw error;
                }

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
                
                // Close modal and redirect
                closeAuthModal();
                window.location.href = 'dashboard.html';

            } catch (e) {
                console.error('🔐 Error:', e);
                if (authError) authError.textContent = e.message || 'An unexpected error occurred.';
                resetFormButton();
            }
        });
    }

    function resetFormButton() {
        if (formSubmit) {
            formSubmit.disabled = false;
            formSubmit.textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';
        }
    }

    // ========================================
    // PASSWORD RESET - OPEN/CLOSE MODAL
    // ========================================
    window.openResetModal = function() {
        if (resetModal) {
            resetModal.style.display = 'flex';
            // Reset state
            if (resetRequestView) resetRequestView.style.display = 'block';
            if (updatePasswordView) updatePasswordView.style.display = 'none';
            if (resetError) resetError.textContent = '';
            if (resetSuccess) resetSuccess.style.display = 'none';
            
            // Re-enable form elements
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
            
            // Focus email field
            setTimeout(() => {
                emailInput?.focus();
            }, 100);
        }
    };

    window.closeResetModal = function() {
        if (resetModal) {
            resetModal.style.display = 'none';
        }
    };

    // Close reset modal on overlay click
    document.querySelector('#resetPasswordModal .auth-modal-overlay')?.addEventListener('click', closeResetModal);

    // ========================================
    // PASSWORD RESET - REQUEST RESET LINK
    // ========================================
    if (resetRequestForm) {
        resetRequestForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const emailInput = document.getElementById('resetEmail');
            const submitBtn = document.getElementById('resetSubmit');
            const email = emailInput?.value?.trim();
            
            if (!email) {
                if (resetError) resetError.textContent = 'Please enter your email address.';
                return;
            }
            
            // Disable button, show loading
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
                
                // Request password reset from Supabase
                const { error } = await window.supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: `${window.location.origin}/landing.html#reset-password`
                });
                
                if (error) {
                    throw error;
                }
                
                // Show success message
                if (resetSuccess) {
                    resetSuccess.textContent = '✓ Reset link sent! Check your email inbox.';
                    resetSuccess.style.display = 'block';
                }
                
                // Disable email field after success
                if (emailInput) emailInput.disabled = true;
                
                // Update button text
                if (submitBtn) {
                    submitBtn.textContent = 'Email Sent';
                    submitBtn.disabled = true;
                }
                
            } catch (err) {
                console.error('Password reset error:', err);
                if (resetError) {
                    resetError.textContent = err.message || 'Failed to send reset link. Please try again.';
                }
                // Re-enable button
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Send Reset Link';
                }
            }
        });
    }

    // ========================================
    // PASSWORD RESET - UPDATE PASSWORD
    // ========================================
    if (updatePasswordForm) {
        updatePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newPwInput = document.getElementById('newPassword');
            const confirmPwInput = document.getElementById('confirmPassword');
            const submitBtn = document.getElementById('updateSubmit');
            
            const newPassword = newPwInput?.value;
            const confirmPassword = confirmPwInput?.value;
            
            // Clear errors
            if (updateError) updateError.textContent = '';
            if (updateSuccess) updateSuccess.style.display = 'none';
            
            // Validate
            if (!newPassword || newPassword.length < 6) {
                if (updateError) updateError.textContent = 'Password must be at least 6 characters.';
                return;
            }
            
            if (newPassword !== confirmPassword) {
                if (updateError) updateError.textContent = 'Passwords do not match.';
                return;
            }
            
            // Disable button, show loading
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Updating...';
            }
            
            try {
                if (!window.supabase) {
                    throw new Error('Authentication service not available');
                }
                
                // Update the password
                const { error } = await window.supabase.auth.updateUser({
                    password: newPassword
                });
                
                if (error) {
                    throw error;
                }
                
                // Show success
                if (updateSuccess) {
                    updateSuccess.textContent = '✓ Password updated successfully! Redirecting...';
                    updateSuccess.style.display = 'block';
                }
                
                // Update button
                if (submitBtn) {
                    submitBtn.textContent = 'Password Updated';
                }
                
                // Redirect to dashboard after 2 seconds
                setTimeout(() => {
                    closeResetModal();
                    window.location.href = 'dashboard.html';
                }, 2000);
                
            } catch (err) {
                console.error('Password update error:', err);
                if (updateError) {
                    updateError.textContent = err.message || 'Failed to update password. Please try again.';
                }
                // Re-enable button
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Update Password';
                }
            }
        });
    }

    // ========================================
    // PASSWORD RESET - CHECK FOR TOKEN ON LOAD
    // ========================================
    function checkForPasswordResetToken() {
        const hash = window.location.hash;
        
        // Supabase includes tokens in the URL hash after clicking reset link
        if (hash.includes('access_token') || hash.includes('type=recovery') || hash === '#reset-password') {
            console.log('🔐 Password reset token detected');
            
            // Open the reset modal with update password view
            if (resetModal) {
                resetModal.style.display = 'flex';
                if (resetRequestView) resetRequestView.style.display = 'none';
                if (updatePasswordView) updatePasswordView.style.display = 'block';
                
                // Focus the new password field
                setTimeout(() => {
                    document.getElementById('newPassword')?.focus();
                }, 100);
            }
        }
    }

    // ========================================
    // LOGOUT
    // ========================================
    window.handleLogout = async function() {
        try {
            if (window.supabase) {
                await window.supabase.auth.signOut();
            }
            updateUIForLoggedOutState();
            console.log('🔐 Logged out successfully');
        } catch (e) {
            console.error('Logout error:', e);
        }
    };

    // ========================================
    // USER MENU
    // ========================================
    window.toggleUserDropdown = function() {
        if (userDropdown) {
            userDropdown.classList.toggle('open');
        }
    };

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (userMenu && !userMenu.contains(e.target)) {
            if (userDropdown) userDropdown.classList.remove('open');
        }
    });

    // ========================================
    // UI STATE MANAGEMENT
    // ========================================
    function updateUIForLoggedInState(user) {
        if (navActions) navActions.style.display = 'none';
        if (navActionsLoggedIn) navActionsLoggedIn.style.display = 'flex';
        if (userMenu) userMenu.style.display = 'block';
        
        if (userEmailDisplay && user?.email) {
            userEmailDisplay.textContent = user.email;
        }
        
        if (userAvatar && user?.email) {
            userAvatar.textContent = user.email.charAt(0).toUpperCase();
        }
    }

    function updateUIForLoggedOutState() {
        if (navActions) navActions.style.display = 'flex';
        if (navActionsLoggedIn) navActionsLoggedIn.style.display = 'none';
        if (userMenu) userMenu.style.display = 'none';
        if (userDropdown) userDropdown.classList.remove('open');
    }

    // ========================================
    // SESSION CHECK
    // ========================================
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

    // ========================================
    // AUTH STATE LISTENER
    // ========================================
    if (window.supabase) {
        window.supabase.auth.onAuthStateChange((event, session) => {
            console.log('🔐 Auth state:', event);
            
            if (event === 'SIGNED_IN' && session?.user) {
                updateUIForLoggedInState(session.user);
            } else if (event === 'SIGNED_OUT') {
                updateUIForLoggedOutState();
            } else if (event === 'PASSWORD_RECOVERY') {
                // User clicked password reset link
                console.log('🔐 Password recovery event');
                if (resetModal) {
                    resetModal.style.display = 'flex';
                    if (resetRequestView) resetRequestView.style.display = 'none';
                    if (updatePasswordView) updatePasswordView.style.display = 'block';
                }
            }
        });
    }

    // ========================================
    // INIT
    // ========================================
    checkSession();
    checkForPasswordResetToken();

})();
