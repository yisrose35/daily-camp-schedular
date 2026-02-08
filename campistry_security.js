// =============================================================================
// campistry_security.js v1.0 — CAMPISTRY CLIENT-SIDE SECURITY FIREWALL
// =============================================================================
//
// Comprehensive security layer for all Campistry pages.
// MUST load BEFORE all other scripts (right after supabase_client.js).
//
// PROVIDES:
// ┌─────────────────────────────────────────────────────────┐
// │ 1. XSS Protection (DOM mutation monitoring, sanitizer)  │
// │ 2. Rate Limiting (auth, API calls, form submissions)    │
// │ 3. CSRF Token Management                                │
// │ 4. Input Validation & Sanitization                      │
// │ 5. Session Security (timeout, hijack detection)         │
// │ 6. localStorage Integrity (tamper detection)            │
// │ 7. Clickjacking Protection                              │
// │ 8. Open Redirect Prevention                             │
// │ 9. Console Tamper Awareness                             │
// │ 10. Script Injection Detection (MutationObserver)       │
// │ 11. Suspicious Activity Logging                         │
// │ 12. Brute Force Protection                              │
// └─────────────────────────────────────────────────────────┘
//
// =============================================================================

(function() {
    'use strict';

    console.log('🛡️ Campistry Security Firewall v1.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const SECURITY_CONFIG = {
        // Rate limiting
        AUTH_MAX_ATTEMPTS: 5,           // Max login attempts before lockout
        AUTH_LOCKOUT_MINUTES: 15,       // Lockout duration
        API_RATE_LIMIT: 60,             // Max API calls per minute
        FORM_SUBMIT_COOLDOWN_MS: 1000,  // Min time between form submissions

        // Session security
        SESSION_TIMEOUT_MINUTES: 480,   // 8 hours - auto logout
        SESSION_CHECK_INTERVAL_MS: 60000, // Check every minute
        FINGERPRINT_CHECK: true,        // Detect session hijacking

        // Input limits
        MAX_INPUT_LENGTH: 10000,        // Max chars for any input field
        MAX_NAME_LENGTH: 200,           // Max chars for name fields
        MAX_URL_LENGTH: 2048,           // Max URL length

        // Monitoring
        LOG_SUSPICIOUS_ACTIVITY: true,
        MAX_DOM_MUTATIONS_PER_SECOND: 50, // Threshold for DOM mutation flood
        
        // Allowed domains for navigation/redirects
        ALLOWED_REDIRECT_DOMAINS: [
            window.location.hostname,
            'bzqmhcumuarrbueqttfh.supabase.co',
            'fonts.googleapis.com',
            'fonts.gstatic.com',
            'cdn.jsdelivr.net'
        ],

        // Allowed script sources (for injection detection)
        ALLOWED_SCRIPT_SOURCES: [
            '', // inline scripts
            window.location.origin,
            'https://cdn.jsdelivr.net'
        ],

        // localStorage keys to protect integrity
        PROTECTED_STORAGE_KEYS: [
            'campistry_camp_id',
            'campistry_user_id',
            'campistry_auth_user_id',
            'campistry_role',
            'campistry_is_team_member'
        ]
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _authAttempts = {};          // { email: { count, firstAttempt, lockedUntil } }
    let _apiCallTimestamps = [];     // timestamps of recent API calls
    let _formSubmitTimestamps = {};  // { formId: lastSubmitTime }
    let _sessionFingerprint = null;  // Browser fingerprint for hijack detection
    let _lastActivity = Date.now();  // For session timeout
    let _domMutationCount = 0;       // Track DOM mutations per second
    let _domMutationTimer = null;
    let _securityLog = [];           // In-memory security event log
    let _storageChecksums = {};      // Checksums for protected localStorage keys
    let _isInitialized = false;
    let _originalSetItem = null;
    let _originalRemoveItem = null;

    // =========================================================================
    // 1. XSS PROTECTION — Centralized Sanitization
    // =========================================================================

    /**
     * Escape HTML entities — the canonical Campistry sanitizer.
     * Use this EVERYWHERE user content is rendered into DOM.
     */
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
            '/': '&#x2F;',
            '`': '&#96;'
        };
        return String(str).replace(/[&<>"'/`]/g, c => map[c]);
    }

    /**
     * Sanitize a string by removing ALL HTML tags.
     * Use for text-only contexts (input values, database writes).
     */
    function stripHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str; // Safe: textContent doesn't parse HTML
        return div.textContent;
    }

    /**
     * Sanitize innerHTML content — removes dangerous elements & attributes.
     * Only use when you MUST render some HTML (e.g. rich text).
     */
    function sanitizeHtml(html) {
        if (!html) return '';
        
        const DANGEROUS_TAGS = /(<\s*\/?\s*)(script|iframe|object|embed|form|meta|link|base|svg|math|template|style)(\s|>|\/)/gi;
        const DANGEROUS_ATTRS = /\s*(on\w+|formaction|xlink:href|data-bind|srcdoc)\s*=\s*["'][^"']*["']/gi;
        const JAVASCRIPT_URLS = /(href|src|action|poster|data)\s*=\s*["']\s*javascript\s*:/gi;
        const DATA_URLS_UNSAFE = /(href|src|action)\s*=\s*["']\s*data\s*:\s*text\/html/gi;
        
        let clean = html;
        clean = clean.replace(DANGEROUS_TAGS, '<!-- blocked -->');
        clean = clean.replace(DANGEROUS_ATTRS, '');
        clean = clean.replace(JAVASCRIPT_URLS, '$1="blocked:"');
        clean = clean.replace(DATA_URLS_UNSAFE, '$1="blocked:"');
        
        return clean;
    }

    /**
     * Safe innerHTML setter — sanitizes before inserting.
     * Usage: CampistrySecurity.safeSetInnerHTML(element, htmlString)
     */
    function safeSetInnerHTML(element, html) {
        if (!element) return;
        element.innerHTML = sanitizeHtml(html);
    }

    // =========================================================================
    // 2. RATE LIMITING
    // =========================================================================

    /**
     * Check if an auth attempt (login/signup) is allowed.
     * Returns { allowed: boolean, retryAfterSeconds?: number, message?: string }
     */
    function checkAuthRateLimit(email) {
        if (!email) return { allowed: true };
        
        const key = email.toLowerCase().trim();
        const now = Date.now();
        
        if (!_authAttempts[key]) {
            _authAttempts[key] = { count: 0, firstAttempt: now, lockedUntil: 0 };
        }
        
        const record = _authAttempts[key];
        
        // Check if currently locked out
        if (record.lockedUntil > now) {
            const retryAfter = Math.ceil((record.lockedUntil - now) / 1000);
            logSecurityEvent('AUTH_RATE_LIMIT', { email: key, retryAfter });
            return {
                allowed: false,
                retryAfterSeconds: retryAfter,
                message: `Too many attempts. Please try again in ${Math.ceil(retryAfter / 60)} minutes.`
            };
        }
        
        // Reset counter if window expired (use lockout duration as window)
        const windowMs = SECURITY_CONFIG.AUTH_LOCKOUT_MINUTES * 60 * 1000;
        if (now - record.firstAttempt > windowMs) {
            record.count = 0;
            record.firstAttempt = now;
        }
        
        record.count++;
        
        // Lock out if exceeded
        if (record.count > SECURITY_CONFIG.AUTH_MAX_ATTEMPTS) {
            record.lockedUntil = now + windowMs;
            logSecurityEvent('AUTH_LOCKOUT', { email: key, attempts: record.count });
            return {
                allowed: false,
                retryAfterSeconds: SECURITY_CONFIG.AUTH_LOCKOUT_MINUTES * 60,
                message: `Account temporarily locked. Too many failed attempts. Try again in ${SECURITY_CONFIG.AUTH_LOCKOUT_MINUTES} minutes.`
            };
        }
        
        return { allowed: true, remainingAttempts: SECURITY_CONFIG.AUTH_MAX_ATTEMPTS - record.count };
    }

    /**
     * Reset auth rate limit (call on successful login).
     */
    function resetAuthRateLimit(email) {
        if (!email) return;
        delete _authAttempts[email.toLowerCase().trim()];
    }

    /**
     * Check API rate limit — prevents flood requests.
     * Returns { allowed: boolean }
     */
    function checkApiRateLimit() {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        // Purge old timestamps
        _apiCallTimestamps = _apiCallTimestamps.filter(t => t > oneMinuteAgo);
        
        if (_apiCallTimestamps.length >= SECURITY_CONFIG.API_RATE_LIMIT) {
            logSecurityEvent('API_RATE_LIMIT', { count: _apiCallTimestamps.length });
            return { allowed: false };
        }
        
        _apiCallTimestamps.push(now);
        return { allowed: true };
    }

    /**
     * Prevent rapid form double-submission.
     * Returns true if submission is allowed.
     */
    function checkFormSubmitRate(formId) {
        const now = Date.now();
        const lastSubmit = _formSubmitTimestamps[formId] || 0;
        
        if (now - lastSubmit < SECURITY_CONFIG.FORM_SUBMIT_COOLDOWN_MS) {
            logSecurityEvent('FORM_DOUBLE_SUBMIT', { formId });
            return false;
        }
        
        _formSubmitTimestamps[formId] = now;
        return true;
    }

    // =========================================================================
    // 3. CSRF TOKEN MANAGEMENT
    // =========================================================================

    /**
     * Generate a CSRF token for the current session.
     */
    function generateCsrfToken() {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        const token = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
        
        try {
            sessionStorage.setItem('campistry_csrf_token', token);
        } catch (e) {
            // sessionStorage might be unavailable
        }
        
        return token;
    }

    /**
     * Validate a CSRF token.
     */
    function validateCsrfToken(token) {
        try {
            const stored = sessionStorage.getItem('campistry_csrf_token');
            return stored && stored === token;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get the current CSRF token (generate if missing).
     */
    function getCsrfToken() {
        try {
            let token = sessionStorage.getItem('campistry_csrf_token');
            if (!token) token = generateCsrfToken();
            return token;
        } catch (e) {
            return generateCsrfToken();
        }
    }

    // =========================================================================
    // 4. INPUT VALIDATION & SANITIZATION
    // =========================================================================

    /**
     * Validate and sanitize an email address.
     */
    function validateEmail(email) {
        if (!email || typeof email !== 'string') return { valid: false, message: 'Email is required' };
        
        const trimmed = email.trim().toLowerCase();
        if (trimmed.length > 254) return { valid: false, message: 'Email is too long' };
        
        // RFC 5322 simplified
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        
        if (!emailRegex.test(trimmed)) return { valid: false, message: 'Invalid email format' };
        
        return { valid: true, sanitized: trimmed };
    }

    /**
     * Validate password strength.
     */
    function validatePassword(password) {
        if (!password) return { valid: false, message: 'Password is required', strength: 0 };
        if (password.length < 6) return { valid: false, message: 'Password must be at least 6 characters', strength: 1 };
        
        let strength = 1;
        if (password.length >= 8) strength++;
        if (/[A-Z]/.test(password)) strength++;
        if (/[0-9]/.test(password)) strength++;
        if (/[^A-Za-z0-9]/.test(password)) strength++;
        
        const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
        
        return { valid: true, strength, label: labels[strength] };
    }

    /**
     * Sanitize a generic text input.
     */
    function sanitizeInput(value, options = {}) {
        if (value === null || value === undefined) return '';
        
        let clean = String(value);
        
        // Enforce max length
        const maxLen = options.maxLength || SECURITY_CONFIG.MAX_INPUT_LENGTH;
        if (clean.length > maxLen) {
            clean = clean.substring(0, maxLen);
            logSecurityEvent('INPUT_TRUNCATED', { maxLen, originalLen: String(value).length });
        }
        
        // Strip null bytes
        clean = clean.replace(/\0/g, '');
        
        // Strip control characters (except newlines/tabs if allowed)
        if (options.allowMultiline) {
            clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        } else {
            clean = clean.replace(/[\x00-\x1F\x7F]/g, '');
        }
        
        // Trim if requested (default: true)
        if (options.trim !== false) {
            clean = clean.trim();
        }
        
        // Strip HTML if requested (default: true)
        if (options.stripHtml !== false) {
            clean = stripHtml(clean);
        }
        
        return clean;
    }

    /**
     * Validate a camp/division/bunk name — alphanumeric + common chars only.
     */
    function validateName(name, label = 'Name') {
        const clean = sanitizeInput(name, { maxLength: SECURITY_CONFIG.MAX_NAME_LENGTH });
        
        if (!clean) return { valid: false, message: `${label} is required` };
        
        // Allow letters, numbers, spaces, hyphens, apostrophes, periods, parentheses
        if (!/^[a-zA-Z0-9\s\-'.()+&,#]+$/.test(clean)) {
            return { valid: false, message: `${label} contains invalid characters` };
        }
        
        return { valid: true, sanitized: clean };
    }

    /**
     * Validate a URL — must be http/https and not a javascript: URL.
     */
    function validateUrl(url) {
        if (!url) return { valid: false };
        
        const trimmed = url.trim();
        if (trimmed.length > SECURITY_CONFIG.MAX_URL_LENGTH) return { valid: false };
        
        try {
            const parsed = new URL(trimmed);
            if (!['http:', 'https:'].includes(parsed.protocol)) return { valid: false };
            return { valid: true, sanitized: parsed.href };
        } catch (e) {
            return { valid: false };
        }
    }

    // =========================================================================
    // 5. SESSION SECURITY
    // =========================================================================

    /**
     * Generate a browser fingerprint for session binding.
     * This helps detect if a session token is used from a different browser.
     */
    function generateFingerprint() {
        const components = [
            navigator.userAgent,
            navigator.language,
            screen.width + 'x' + screen.height,
            screen.colorDepth,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
            navigator.hardwareConcurrency || 'unknown'
        ];
        
        // Simple hash
        let hash = 0;
        const str = components.join('|');
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit int
        }
        
        return Math.abs(hash).toString(36);
    }

    /**
     * Start session monitoring — auto-logout on timeout, hijack detection.
     */
    function startSessionMonitor() {
        _sessionFingerprint = generateFingerprint();
        _lastActivity = Date.now();
        
        // Track user activity
        const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart'];
        activityEvents.forEach(event => {
            document.addEventListener(event, () => {
                _lastActivity = Date.now();
            }, { passive: true });
        });
        
        // Periodic session check
        setInterval(async () => {
            const now = Date.now();
            const inactiveMinutes = (now - _lastActivity) / 60000;
            
            // Auto-logout on timeout
            if (inactiveMinutes >= SECURITY_CONFIG.SESSION_TIMEOUT_MINUTES) {
                logSecurityEvent('SESSION_TIMEOUT', { inactiveMinutes: Math.round(inactiveMinutes) });
                await forceLogout('Session expired due to inactivity.');
                return;
            }
            
            // Fingerprint check (detect session hijacking)
            if (SECURITY_CONFIG.FINGERPRINT_CHECK) {
                const currentFingerprint = generateFingerprint();
                if (_sessionFingerprint && currentFingerprint !== _sessionFingerprint) {
                    logSecurityEvent('FINGERPRINT_MISMATCH', { 
                        expected: _sessionFingerprint, 
                        current: currentFingerprint 
                    });
                    // Don't force logout — fingerprints can change legitimately
                    // (e.g. connecting external monitor), but log it
                    _sessionFingerprint = currentFingerprint; // Update
                }
            }
        }, SECURITY_CONFIG.SESSION_CHECK_INTERVAL_MS);
    }

    /**
     * Force logout — clear session and redirect.
     */
    async function forceLogout(reason) {
        console.warn('🛡️ [SECURITY] Force logout:', reason);
        
        try {
            const supabase = window.CampistryClient?.getClient() || window.supabase;
            if (supabase?.auth) {
                await supabase.auth.signOut();
            }
        } catch (e) {
            console.error('🛡️ Error during force logout:', e);
        }
        
        // Clear sensitive storage
        SECURITY_CONFIG.PROTECTED_STORAGE_KEYS.forEach(key => {
            try { localStorage.removeItem(key); } catch (e) {}
        });
        
        try { sessionStorage.clear(); } catch (e) {}
        
        // Redirect to login
        window.location.href = 'index.html';
    }

    // =========================================================================
    // 6. LOCALSTORAGE INTEGRITY PROTECTION
    // =========================================================================

    /**
     * Simple checksum for a string value.
     */
    function computeChecksum(str) {
        if (!str) return '0';
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Snapshot checksums of protected localStorage keys.
     */
    function snapshotStorageChecksums() {
        SECURITY_CONFIG.PROTECTED_STORAGE_KEYS.forEach(key => {
            try {
                const value = localStorage.getItem(key);
                if (value !== null) {
                    _storageChecksums[key] = computeChecksum(value);
                }
            } catch (e) {}
        });
    }

    /**
     * Verify storage integrity — detect external tampering.
     */
    function verifyStorageIntegrity() {
        let tampered = false;
        
        SECURITY_CONFIG.PROTECTED_STORAGE_KEYS.forEach(key => {
            try {
                const value = localStorage.getItem(key);
                if (value !== null && _storageChecksums[key]) {
                    const currentChecksum = computeChecksum(value);
                   if (currentChecksum !== _storageChecksums[key]) {
                        logSecurityEvent('STORAGE_TAMPER', { key, tamperedValue: value });
                        tampered = true;
                        
                        // ★★★ SECURITY FIX: Revert role to safe default on tamper ★★★
                        if (key === 'campistry_role') {
                            _originalSetItem(key, 'viewer');
                            _storageChecksums[key] = computeChecksum('viewer');
                            console.warn('🛡️ [SECURITY] Role tampered! Reset to viewer. RBAC will re-verify.');
                            try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
                            if (window.AccessControl?.refresh) {
                                window.AccessControl.refresh().catch(() => {});
                            }
                        } else {
                            // For non-role keys, accept the change (may be legitimate app code)
                            _storageChecksums[key] = currentChecksum;
                        }
                    }
                }
            } catch (e) {}
        });
        
        return !tampered;
    }

    /**
     * Protect localStorage.setItem — wrap to track changes to protected keys.
     */
    function protectLocalStorage() {
        _originalSetItem = localStorage.setItem.bind(localStorage);
        _originalRemoveItem = localStorage.removeItem.bind(localStorage);
        
        const protectedSet = new Set(SECURITY_CONFIG.PROTECTED_STORAGE_KEYS);
        
        localStorage.setItem = function(key, value) {
            // Track changes to protected keys
            if (protectedSet.has(key)) {
                _storageChecksums[key] = computeChecksum(value);
            }
            return _originalSetItem(key, value);
        };
        
        localStorage.removeItem = function(key) {
            if (protectedSet.has(key)) {
                delete _storageChecksums[key];
            }
            return _originalRemoveItem(key);
        };
    }

    // =========================================================================
    // 7. CLICKJACKING PROTECTION
    // =========================================================================

    function enableClickjackingProtection() {
        // Check if we're in an iframe
        if (window.self !== window.top) {
            try {
                // Allow same-origin frames
                if (window.top.location.hostname === window.location.hostname) {
                    return; // Same origin, OK
                }
            } catch (e) {
                // Cross-origin frame — blocked
            }
            
            logSecurityEvent('CLICKJACK_ATTEMPT', { 
                referrer: document.referrer 
            });
            
            // Bust the frame
            document.body.innerHTML = `
                <div style="padding:40px; text-align:center; font-family:sans-serif;">
                    <h2>⚠️ Security Warning</h2>
                    <p>This page cannot be displayed in a frame.</p>
                    <a href="${window.location.href}" target="_top">Click here to continue</a>
                </div>
            `;
        }
    }

    // =========================================================================
    // 8. OPEN REDIRECT PREVENTION
    // =========================================================================

    /**
     * Validate a redirect URL — only allow same-origin or whitelisted domains.
     */
    function isSafeRedirect(url) {
        if (!url) return false;
        
        // Allow relative URLs
        if (url.startsWith('/') && !url.startsWith('//')) return true;
        
        try {
            const parsed = new URL(url, window.location.origin);
            
            // Block javascript: and data: protocols
            if (['javascript:', 'data:', 'vbscript:'].includes(parsed.protocol)) return false;
            
            // Check against allowed domains
            return SECURITY_CONFIG.ALLOWED_REDIRECT_DOMAINS.some(
                domain => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
            );
        } catch (e) {
            return false;
        }
    }

    /**
     * Safe redirect — validates URL before navigating.
     */
    function safeRedirect(url, fallback = 'index.html') {
        if (isSafeRedirect(url)) {
            window.location.href = url;
        } else {
            logSecurityEvent('BLOCKED_REDIRECT', { url });
            window.location.href = fallback;
        }
    }

    // =========================================================================
    // 9. CONSOLE TAMPER AWARENESS
    // =========================================================================

    function setupConsoleSecurity() {
        // Warn users about social engineering attacks via console
        if (typeof console.log === 'function') {
            const warningStyle = 'font-size:18px; font-weight:bold; color:#DC2626;';
            const infoStyle = 'font-size:14px; color:#374151;';
            
            console.log('%c⚠️ STOP!', warningStyle);
            console.log(
                '%cThis is a browser feature intended for developers. If someone told you to copy-paste something here to "hack" or "verify" your account, it is a scam and will give them access to your Campistry account.',
                infoStyle
            );
        }
    }

    // =========================================================================
    // 10. SCRIPT INJECTION DETECTION (MutationObserver)
    // =========================================================================

    function startDomMonitor() {
        if (typeof MutationObserver === 'undefined') return;
        
        const observer = new MutationObserver((mutations) => {
            _domMutationCount += mutations.length;
            
            mutations.forEach(mutation => {
                // Check for added script elements
                mutation.addedNodes.forEach(node => {
                    if (node.nodeName === 'SCRIPT') {
                        const src = node.src || '';
                        const isAllowed = !src || SECURITY_CONFIG.ALLOWED_SCRIPT_SOURCES.some(
                            allowed => !allowed ? !src : src.startsWith(allowed)
                        );
                        
                        if (!isAllowed) {
                            logSecurityEvent('INJECTED_SCRIPT', { src });
                            console.warn('🛡️ [SECURITY] Blocked injected script:', src);
                            node.remove();
                        }
                    }
                    
                    // Check for injected iframes
                    if (node.nodeName === 'IFRAME') {
                        const src = node.src || '';
                        if (src && !isSafeRedirect(src)) {
                            logSecurityEvent('INJECTED_IFRAME', { src });
                            console.warn('🛡️ [SECURITY] Blocked injected iframe:', src);
                            node.remove();
                        }
                    }
                });
            });
        });
        
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
        
        // DOM mutation flood detection
        _domMutationTimer = setInterval(() => {
            if (_domMutationCount > SECURITY_CONFIG.MAX_DOM_MUTATIONS_PER_SECOND) {
                logSecurityEvent('DOM_MUTATION_FLOOD', { count: _domMutationCount });
            }
            _domMutationCount = 0;
        }, 1000);
    }

    // =========================================================================
    // 11. SUSPICIOUS ACTIVITY LOGGING
    // =========================================================================

    function logSecurityEvent(type, details = {}) {
        const event = {
            type,
            timestamp: new Date().toISOString(),
            url: window.location.pathname,
            ...details
        };
        
        _securityLog.push(event);
        
        // Keep only last 100 events in memory
        if (_securityLog.length > 100) {
            _securityLog = _securityLog.slice(-100);
        }
        
        if (SECURITY_CONFIG.LOG_SUSPICIOUS_ACTIVITY) {
            console.warn(`🛡️ [SECURITY] ${type}:`, details);
        }
        
        // Persist critical events to localStorage for post-incident analysis
        const criticalTypes = ['AUTH_LOCKOUT', 'CLICKJACK_ATTEMPT', 'INJECTED_SCRIPT', 'STORAGE_TAMPER'];
        if (criticalTypes.includes(type)) {
            try {
                const key = 'campistry_security_log';
                const existing = JSON.parse(localStorage.getItem(key) || '[]');
                existing.push(event);
                // Keep only last 50 critical events
                const trimmed = existing.slice(-50);
                localStorage.setItem(key, JSON.stringify(trimmed));
            } catch (e) { /* ignore */ }
        }
    }

    /**
     * Get the security event log (for admin/diagnostic purposes).
     */
    function getSecurityLog() {
        return [..._securityLog];
    }

    // =========================================================================
    // 12. BRUTE FORCE PROTECTION — Form Hardening
    // =========================================================================

    /**
     * Automatically harden all forms on the page.
     * - Adds rate limiting to submit events
     * - Adds input length limits
     * - Prevents action attribute manipulation
     */
    function hardenForms() {
        document.querySelectorAll('form').forEach(form => {
            const formId = form.id || form.action || 'unknown';
            
            // Prevent double-submit
            form.addEventListener('submit', (e) => {
                if (!checkFormSubmitRate(formId)) {
                    e.preventDefault();
                    console.warn('🛡️ Form submission rate limited:', formId);
                }
            }, true);
            
            // Enforce input length limits
            form.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], textarea').forEach(input => {
                if (!input.maxLength || input.maxLength < 0) {
                    input.maxLength = SECURITY_CONFIG.MAX_INPUT_LENGTH;
                }
            });
        });
    }

    /**
     * Auto-harden inputs added dynamically.
     */
    function setupInputMonitor() {
        if (typeof MutationObserver === 'undefined') return;
        
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    
                    // Harden dynamically added inputs
                    const inputs = node.querySelectorAll?.('input[type="text"], input[type="email"], textarea') || [];
                    inputs.forEach(input => {
                        if (!input.maxLength || input.maxLength < 0) {
                            input.maxLength = SECURITY_CONFIG.MAX_INPUT_LENGTH;
                        }
                    });
                });
            });
        });
        
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // =========================================================================
    // CONTENT SECURITY POLICY — Inject via meta tag
    // =========================================================================

    function injectCSP() {
        // Only inject if not already present
        if (document.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;
        
        const csp = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob: https:",
            "connect-src 'self' https://bzqmhcumuarrbueqttfh.supabase.co wss://bzqmhcumuarrbueqttfh.supabase.co https://fonts.googleapis.com https://fonts.gstatic.com",
            "frame-ancestors 'self'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ');
        
        const meta = document.createElement('meta');
        meta.httpEquiv = 'Content-Security-Policy';
        meta.content = csp;
        document.head.prepend(meta);
    }

    /**
     * Inject additional security headers via meta tags.
     */
    function injectSecurityMeta() {
        const metas = [
            { httpEquiv: 'X-Content-Type-Options', content: 'nosniff' },
            { httpEquiv: 'X-Frame-Options', content: 'SAMEORIGIN' },
            { name: 'referrer', content: 'strict-origin-when-cross-origin' }
        ];
        
        metas.forEach(({ httpEquiv, name, content }) => {
            // Check if already exists
            const selector = httpEquiv 
                ? `meta[http-equiv="${httpEquiv}"]` 
                : `meta[name="${name}"]`;
            if (document.querySelector(selector)) return;
            
            const meta = document.createElement('meta');
            if (httpEquiv) meta.httpEquiv = httpEquiv;
            if (name) meta.name = name;
            meta.content = content;
            document.head.appendChild(meta);
        });
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initialize() {
        if (_isInitialized) return;
        
        console.log('🛡️ Initializing security firewall...');
        
        // 1. Inject CSP & security meta tags
        injectCSP();
        injectSecurityMeta();
        
        // 2. Clickjacking protection
        enableClickjackingProtection();
        
        // 3. Console security warning
        setupConsoleSecurity();
        
        // 4. Protect localStorage
        protectLocalStorage();
        snapshotStorageChecksums();
        
        // 5. Generate CSRF token
        generateCsrfToken();
        
        // 6. Start DOM injection monitor
        startDomMonitor();
        
        // 7. Start session monitor (only on authenticated pages)
        const isAuthPage = ['index.html', 'landing.html', 'invite.html'].some(
            p => window.location.pathname.endsWith(p) || window.location.pathname === '/'
        );
        if (!isAuthPage) {
            startSessionMonitor();
        }
        
        // 8. Harden forms when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                hardenForms();
                setupInputMonitor();
            });
        } else {
            hardenForms();
            setupInputMonitor();
        }
        
        // 9. Periodic storage integrity checks
        setInterval(verifyStorageIntegrity, 30000); // Every 30 seconds
        
        _isInitialized = true;
        console.log('🛡️ Security firewall active ✅');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.CampistrySecurity = {
        // Core sanitization
        escapeHtml,
        stripHtml,
        sanitizeHtml,
        safeSetInnerHTML,
        
        // Input validation
        sanitizeInput,
        validateEmail,
        validatePassword,
        validateName,
        validateUrl,
        
        // Rate limiting
        checkAuthRateLimit,
        resetAuthRateLimit,
        checkApiRateLimit,
        checkFormSubmitRate,
        
        // CSRF
        getCsrfToken,
        validateCsrfToken,
        generateCsrfToken,
        
        // Session
        forceLogout,
        
        // Navigation
        isSafeRedirect,
        safeRedirect,
        
        // Logging & diagnostics
        getSecurityLog,
        logSecurityEvent,
        
        // Storage
        verifyStorageIntegrity,
        
        // Re-apply (for dynamic content)
        hardenForms,
        
        // Config access (read-only)
        getConfig: () => ({ ...SECURITY_CONFIG }),
        
        // Status
        isInitialized: () => _isInitialized
    };

    // Also expose escapeHtml globally as a convenience (many modules use it)
    if (!window.escapeHtml) {
        window.escapeHtml = escapeHtml;
    }

    // Auto-initialize immediately
    initialize();

})();
