// =============================================================================
// trial_guard.js v1.2 — CAMPISTRY FREE TRIAL ENFORCEMENT
// =============================================================================
//
// Runs on ALL app pages. Checks the camp's plan_status and trial_started_at.
//
// LOGIC:
//   plan_status = 'active'|'paid'|'founding_member' → full access, no banner
//   plan_status = 'trial' + within trial window     → countdown banner
//   plan_status = 'trial' + trial expired            → fullscreen lockout
//   plan_status missing / legacy camp                → full access (grandfathered)
//
// The trial_hours is stored on the camp (set during signup from the promo code).
// Default fallback is 48 hours if not specified.
//
// v1.2: Fixed "Upgrade Now" / "Contact Us" buttons to reliably open email client
//
// LOAD: After supabase_client.js and access_control.js on every app page.
// =============================================================================

(function () {
    'use strict';

    const DEFAULT_TRIAL_HOURS = 48;
    const CHECK_INTERVAL_MS = 60 * 1000; // Re-check every 60 seconds
    const CONTACT_EMAIL = 'campistryoffice@gmail.com';
    const MAILTO_URL = 'mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent('Campistry Upgrade Request') + '&body=' + encodeURIComponent("Hi,\nI'd like to upgrade my Campistry account.\n\nThanks!");

    // Skip in demo mode
    if (window.__CAMPISTRY_DEMO_MODE__ || window.location.search.includes('demo=true')) {
        console.log('⏱️ [Trial] Demo mode — skipping');
        return;
    }

    // Skip on landing/invite pages
    const page = window.location.pathname.split('/').pop() || 'index.html';
    if (page === 'index.html' || page === 'invite.html') return;

    console.log('⏱️ [Trial Guard] v1.2 loading...');

    // =========================================================================
    // STATE
    // =========================================================================
    let _isExpired = false;
    let _trialEnd = null;
    let _planStatus = null;
    let _countdownInterval = null;

    // =========================================================================
    // HELPERS
    // =========================================================================

    function openUpgradeEmail() {
        window.location.href = MAILTO_URL;
    }

    async function waitForSupabase(maxMs = 10000) {
        const start = Date.now();
        while (!window.supabase?.auth && (Date.now() - start) < maxMs) {
            await new Promise(r => setTimeout(r, 100));
        }
        return !!window.supabase?.auth;
    }

    function formatTime(ms) {
        if (ms <= 0) return 'Expired';
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    }

    function formatTimeLong(ms) {
        if (ms <= 0) return 'Expired';
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        if (h > 0) return h + ' hour' + (h !== 1 ? 's' : '') + ', ' + m + ' minute' + (m !== 1 ? 's' : '');
        if (m > 0) return m + ' minute' + (m !== 1 ? 's' : '') + ', ' + s + ' second' + (s !== 1 ? 's' : '');
        return s + ' second' + (s !== 1 ? 's' : '');
    }

    // =========================================================================
    // CORE: CHECK TRIAL STATUS
    // =========================================================================

    async function checkTrialStatus() {
        try {
            const ready = await waitForSupabase();
            if (!ready) return;

            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session?.user) return;

            const campId = localStorage.getItem('campistry_camp_id') ||
                           localStorage.getItem('campistry_user_id') ||
                           session.user.id;

            const { data: camp, error } = await window.supabase
                .from('camps')
                .select('trial_started_at, plan_status, trial_hours')
                .eq('id', campId)
                .maybeSingle();

            if (error || !camp) {
                if (error) console.error('⏱️ [Trial] DB error:', error);
                return; // Fail open
            }

            _planStatus = camp.plan_status;

            // ── PAID / ACTIVE: no restrictions ──
            if (['active', 'paid', 'founding_member'].includes(_planStatus)) {
                console.log('⏱️ [Trial] Plan is', _planStatus, '— no restrictions');
                removeBanner();
                removeOverlay();
                _isExpired = false;
                return;
            }

            // ── NO TRIAL DATA (legacy camp): grandfathered in ──
            if (!camp.trial_started_at) {
                return;
            }

            // ── CALCULATE TRIAL WINDOW ──
            const trialHours = camp.trial_hours || DEFAULT_TRIAL_HOURS;
            const trialStart = new Date(camp.trial_started_at).getTime();
            _trialEnd = trialStart + (trialHours * 60 * 60 * 1000);
            const remaining = _trialEnd - Date.now();

            if (remaining <= 0) {
                console.log('⏱️ [Trial] ❌ Expired');
                _isExpired = true;
                showLockoutOverlay();
            } else {
                console.log('⏱️ [Trial] ✅ Active —', formatTime(remaining), 'left');
                _isExpired = false;
                showCountdownBanner(remaining);
                removeOverlay();
            }

        } catch (e) {
            console.error('⏱️ [Trial] Error:', e);
        }
    }

    // =========================================================================
    // UI: COUNTDOWN BANNER
    // =========================================================================

    function showCountdownBanner(remainingMs) {
        if (remainingMs <= 0) return;

        let banner = document.getElementById('trial-countdown-banner');
        if (!banner) {
            // Inject styles once
            if (!document.getElementById('trial-guard-styles')) {
                const style = document.createElement('style');
                style.id = 'trial-guard-styles';
                style.textContent = `
                    @keyframes trialSlideDown { from { transform: translateY(-100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                    @keyframes trialFadeIn { from { opacity: 0; } to { opacity: 1; } }
                    @keyframes trialCardUp { from { transform: translateY(30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                    body.trial-banner-active { padding-top: 40px !important; }
                `;
                document.head.appendChild(style);
            }

            banner = document.createElement('div');
            banner.id = 'trial-countdown-banner';
            banner.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; z-index: 99998;
                background: linear-gradient(135deg, #0F5F6E 0%, #147D91 100%);
                color: white; text-align: center; padding: 8px 16px; font-size: 0.85rem;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                display: flex; align-items: center; justify-content: center; gap: 12px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15); animation: trialSlideDown 0.3s ease-out;
            `;
            banner.innerHTML = `
                <span>⏱️</span>
                <span>Free trial: <strong id="trial-time-left">${formatTime(remainingMs)}</strong> remaining</span>
                <button id="trial-upgrade-btn"
                   style="color:white; background:rgba(255,255,255,0.2); padding:3px 12px; border-radius:4px; border:none; cursor:pointer; font-size:0.8rem; font-weight:600;">
                    Upgrade Now</button>
                <button onclick="this.parentElement.remove();document.body.classList.remove('trial-banner-active');"
                        style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:1.1rem;padding:0 4px;margin-left:4px;"
                        title="Dismiss">×</button>
            `;
            document.body.prepend(banner);
            document.body.classList.add('trial-banner-active');

            // Attach click handler (more reliable than mailto href in dynamic elements)
            var upgradeBtn = document.getElementById('trial-upgrade-btn');
            if (upgradeBtn) upgradeBtn.addEventListener('click', openUpgradeEmail);
        }

        // Live countdown
        if (_countdownInterval) clearInterval(_countdownInterval);
        _countdownInterval = setInterval(() => {
            const left = _trialEnd - Date.now();
            const el = document.getElementById('trial-time-left');
            if (!el) { clearInterval(_countdownInterval); return; }
            if (left <= 0) {
                clearInterval(_countdownInterval);
                showLockoutOverlay();
            } else {
                el.textContent = formatTime(left);
                if (left < 3600000) {
                    const b = document.getElementById('trial-countdown-banner');
                    if (b) b.style.background = 'linear-gradient(135deg, #B91C1C 0%, #DC2626 100%)';
                }
            }
        }, 1000);
    }

    function removeBanner() {
        const b = document.getElementById('trial-countdown-banner');
        if (b) b.remove();
        document.body.classList.remove('trial-banner-active');
        if (_countdownInterval) clearInterval(_countdownInterval);
    }

    // =========================================================================
    // UI: LOCKOUT OVERLAY
    // =========================================================================

    function showLockoutOverlay() {
        removeBanner();
        if (document.getElementById('trial-lockout-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'trial-lockout-overlay';
        overlay.style.cssText = `
            position:fixed; inset:0; z-index:999999;
            background:rgba(15,23,42,0.95); backdrop-filter:blur(8px);
            display:flex; align-items:center; justify-content:center;
            animation:trialFadeIn 0.4s ease-out;
        `;

        overlay.innerHTML = `
            <div style="
                background:white; border-radius:16px; padding:48px 40px; max-width:480px; width:90%;
                text-align:center; box-shadow:0 25px 60px rgba(0,0,0,0.3);
                animation:trialCardUp 0.5s ease-out 0.1s both;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">
                <div style="font-size:3rem;margin-bottom:16px;">⏰</div>
                <h2 style="font-size:1.5rem;font-weight:700;color:#1E293B;margin:0 0 12px;">
                    Your Free Trial Has Ended
                </h2>
                <p style="color:#64748B;font-size:1rem;line-height:1.6;margin:0 0 8px;">
                    Your free trial of Campistry has expired.
                </p>
                <p style="color:#64748B;font-size:0.95rem;line-height:1.6;margin:0 0 32px;">
                    <strong style="color:#0F5F6E;">Don't worry — all your data is saved.</strong><br>
                    Upgrade to continue right where you left off.
                </p>
                <button id="trial-lockout-upgrade-btn"
                   style="
                    display:inline-block; background:linear-gradient(135deg,#0F5F6E,#147D91);
                    color:white; padding:14px 32px; border-radius:10px; font-size:1rem;
                    font-weight:600; border:none; cursor:pointer; margin-bottom:16px;
                    box-shadow:0 4px 12px rgba(20,125,145,0.3); transition:transform 0.15s,box-shadow 0.15s;
                " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px rgba(20,125,145,0.4)'"
                   onmouseout="this.style.transform='';this.style.boxShadow='0 4px 12px rgba(20,125,145,0.3)'"
                >✉️ Contact Us to Upgrade</button>
                <div style="margin-top:8px;">
                    <button id="trial-lockout-email-btn" style="background:none;border:none;color:#94A3B8;font-size:0.85rem;cursor:pointer;text-decoration:underline;">
                        ${CONTACT_EMAIL}</button>
                </div>
                <div style="margin-top:24px;padding-top:20px;border-top:1px solid #E2E8F0;">
                    <button onclick="window.location.href='index.html'"
                        style="background:none;border:1px solid #E2E8F0;color:#64748B;padding:10px 24px;
                        border-radius:8px;font-size:0.9rem;cursor:pointer;transition:background 0.15s;"
                        onmouseover="this.style.background='#F8FAFC'"
                        onmouseout="this.style.background='none'">
                        ← Back to Home</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        // Attach click handlers (more reliable than mailto href in dynamic elements)
        var lockoutBtn = document.getElementById('trial-lockout-upgrade-btn');
        if (lockoutBtn) lockoutBtn.addEventListener('click', openUpgradeEmail);
        var emailBtn = document.getElementById('trial-lockout-email-btn');
        if (emailBtn) emailBtn.addEventListener('click', openUpgradeEmail);

        console.log('⏱️ [Trial] Lockout overlay shown');
    }

    function removeOverlay() {
        const o = document.getElementById('trial-lockout-overlay');
        if (o) { o.remove(); document.body.style.overflow = ''; }
    }

    // =========================================================================
    // INIT
    // =========================================================================

    async function init() {
        await new Promise(r => setTimeout(r, 500)); // Let auth systems boot
        await checkTrialStatus();
        setInterval(checkTrialStatus, CHECK_INTERVAL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // =========================================================================
    // PUBLIC API (debugging / admin console)
    // =========================================================================

    window.CampistryTrial = Object.freeze({
        checkStatus: checkTrialStatus,
        isExpired: () => _isExpired,
        getTrialEnd: () => _trialEnd ? new Date(_trialEnd) : null,
        getPlanStatus: () => _planStatus,
        getTimeRemaining: () => _trialEnd ? Math.max(0, _trialEnd - Date.now()) : null,
        getTimeRemainingFormatted: () => _trialEnd ? formatTimeLong(Math.max(0, _trialEnd - Date.now())) : null,
    });

    console.log('⏱️ [Trial Guard] v1.2 loaded');
})();
