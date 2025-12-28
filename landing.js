// ============================================================================
// landing.js — Campistry Landing Page
// 
// Flow:
// - Landing page is public (anyone can browse)
// - Sign Up requires: Camp Name + Email + Password + Access Code
// - Sign In requires: Email + Password only
// - After auth: Redirect to dashboard.html
// - If already logged in: Redirect to dashboard.html
// ============================================================================

(function() {
    'use strict';

    // ========================================
    // CONSTANTS
    // ========================================
    
    const GLOBAL_ACCESS_CODE = 'jUsTCAmPit2026';

    // ========================================
    // DOM ELEMENTS
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

    let authMode = 'login';

    // ========================================
    // AUTH MODAL
    // ========================================

    window.openAuthModal = function(mode = 'login') {
        authMode = mode;
        updateModalMode();
        
        authModal.classList.add('open');
        document.body.style.overflow = 'hidden';
        
        if (authError) authError.textContent = '';
        
        setTimeout(() => {
            document.getElementById('email')?.focus();
        }, 100);
    };

    window.closeAuthModal = function() {
        authModal.classList.remove('open');
        document.body.style.overflow = '';
        if (authError) authError.textContent = '';
        
        // Clear form
        const email = document.getElementById('email');
        const password = document.getElementById('password');
        const campName = document.getElementById('campName');
        const accessCode = document.getElementById('accessCode');
        
        if (email) email.value = '';
        if (password) password.value = '';
        if (campName) campName.value = '';
        if (accessCode) accessCode.value = '';
    };

    function updateModalMode() {
        modalToggleBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === authMode);
        });

        if (authMode === 'signup') {
            if (modalTitle) modalTitle.textContent = 'Create Your Account';
            if (modalSubtitle) modalSubtitle.textContent = 'Get started with Campistry';
            if (formSubmit) formSubmit.textContent = 'Create Account';
            if (campNameGroup) campNameGroup.style.display = 'block';
            if (accessCodeGroup) accessCodeGroup.style.display = 'block';
        } else {
            if (modalTitle) modalTitle.textContent = 'Welcome Back';
            if (modalSubtitle) modalSubtitle.textContent = 'Sign in to your Campistry account';
            if (formSubmit) formSubmit.textContent = 'Sign In';
            if (campNameGroup) campNameGroup.style.display = 'none';
            if (accessCodeGroup) accessCodeGroup.style.display = 'none';
        }
    }

    // Toggle buttons
    modalToggleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            authMode = btn.dataset.mode;
            updateModalMode();
            if (authError) authError.textContent = '';
        });
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && authModal?.classList.contains('open')) {
            closeAuthModal();
        }
    });

    // ========================================
    // AUTH FORM SUBMISSION
    // ========================================

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email')?.value.trim();
            const password = document.getElementById('password')?.value.trim();
            const campName = document.getElementById('campName')?.value.trim() || '';
            const accessCode = document.getElementById('accessCode')?.value.trim() || '';

            // Validation
            if (!email || !password) {
                if (authError) authError.textContent = 'Please enter email and password.';
                return;
            }

            if (authMode === 'signup') {
                if (!campName) {
                    if (authError) authError.textContent = 'Please enter your camp name.';
                    return;
                }
                
                // Validate access code for signup only
                if (accessCode !== GLOBAL_ACCESS_CODE) {
                    if (authError) authError.textContent = 'Invalid access code. Please check your code and try again.';
                    return;
                }
            }

            // Disable button
            if (formSubmit) {
                formSubmit.disabled = true;
                formSubmit.textContent = 'Please wait...';
            }
            if (authError) authError.textContent = '';

            try {
                let user = null;
                let error = null;

                if (!window.supabase) {
                    throw new Error('Authentication service unavailable. Please refresh and try again.');
                }

                if (authMode === 'signup') {
                    console.log('🔐 Creating account...');
                    const { data, error: signupError } = await window.supabase.auth.signUp({ 
                        email, 
                        password,
                        options: {
                            data: { camp_name: campName }
                        }
                    });
                    user = data?.user;
                    error = signupError;

                    if (user && !error) {
                        console.log('🔐 Signup successful, creating camp record...');
                        try {
                            await window.supabase.from('camps').insert([{ 
                                name: campName, 
                                owner: user.id 
                            }]);
                        } catch (campError) {
                            console.warn('Could not create camp record:', campError);
                        }
                    }
                } else {
                    console.log('🔐 Signing in...');
                    const { data, error: loginError } = await window.supabase.auth.signInWithPassword({ 
                        email, 
                        password 
                    });
                    user = data?.user;
                    error = loginError;
                }

                if (error) {
                    console.error('🔐 Auth error:', error.message);
                    if (authError) authError.textContent = error.message || 'Authentication failed.';
                    resetFormButton();
                    return;
                }

                if (!user) {
                    if (authError) authError.textContent = 'Authentication failed. Please try again.';
                    resetFormButton();
                    return;
                }

                console.log('🔐 Success! Redirecting to dashboard...');
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
    // SESSION CHECK - REDIRECT IF LOGGED IN
    // ========================================

    async function checkSession() {
        if (!window.supabase) return;

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            
            if (session?.user) {
                console.log('🔐 Already logged in, redirecting to dashboard');
                window.location.href = 'dashboard.html';
            }
        } catch (e) {
            console.warn('Session check failed:', e);
        }
    }

    // Wait for Supabase then check session
    const waitForSupabase = setInterval(() => {
        if (window.supabase) {
            clearInterval(waitForSupabase);
            checkSession();
        }
    }, 100);

    setTimeout(() => clearInterval(waitForSupabase), 5000);

    // ========================================
    // CONTACT
    // ========================================

    window.openContact = function() {
        window.location.href = 'mailto:Campistry@gmail.com?subject=Campistry%20Inquiry';
    };

    // ========================================
    // SMOOTH SCROLL
    // ========================================

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // ========================================
    // NAV SCROLL EFFECT
    // ========================================

    const nav = document.querySelector('.nav');

    window.addEventListener('scroll', () => {
        if (nav) {
            if (window.pageYOffset > 100) {
                nav.style.padding = '12px 24px';
                nav.style.background = 'rgba(250, 252, 251, 0.95)';
            } else {
                nav.style.padding = '16px 24px';
                nav.style.background = 'rgba(250, 252, 251, 0.85)';
            }
        }
    });

    // ========================================
    // MOBILE NAVIGATION
    // ========================================

    const mobileToggle = document.querySelector('.nav-mobile-toggle');
    const navLinks = document.querySelector('.nav-links');

    if (mobileToggle && navLinks) {
        mobileToggle.addEventListener('click', () => {
            const isOpen = navLinks.style.display === 'flex';
            
            if (isOpen) {
                navLinks.style.display = 'none';
            } else {
                navLinks.style.cssText = `
                    display: flex;
                    flex-direction: column;
                    position: absolute;
                    top: 100%;
                    left: 0;
                    right: 0;
                    background: white;
                    padding: 24px;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.1);
                    gap: 16px;
                `;
            }
        });
    }

    // ========================================
    // SCROLL ANIMATIONS
    // ========================================

    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const fadeInObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
                fadeInObserver.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.product-card, .feature-card, .pricing-card, .testimonial').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        fadeInObserver.observe(el);
    });

    console.log('🏕️ Campistry Landing Page loaded');

})();
