/* ============================================================================
   Campistry Lite — standalone sign-in
   ----------------------------------------------------------------------------
   Lite installs to the home screen as its own app, so it needs its own front
   door rather than bouncing to the marketing site's landing page. This is a
   sign-in ONLY screen: it calls the same supabase.auth.signInWithPassword the
   desktop landing page uses, against the same project, so credentials, session
   storage and RLS behave identically. Account creation deliberately lives on
   the main site — camps are provisioned there and members arrive by invite.
   ============================================================================ */
(function () {
    'use strict';

    const HOME = 'campistry_lite.html';
    const $ = id => document.getElementById(id);

    function toast(msg) {
        const el = $('liteToast');
        if (!el) return;
        el.textContent = msg;
        el.style.display = '';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { el.style.display = 'none'; }, 3400);
    }

    function showErr(msg) {
        const el = $('liteLoginErr');
        if (!el) return;
        el.textContent = msg || '';
        el.style.display = msg ? '' : 'none';
    }

    function busy(on, label) {
        const btn = $('liteLoginBtn');
        if (!btn) return;
        btn.disabled = on;
        btn.textContent = on ? (label || 'Signing in…') : 'Sign in';
    }

    // Supabase's messages are written for developers; these are for counselors.
    function friendlyAuthError(err) {
        const m = String((err && err.message) || err || '');
        if (/Invalid login credentials/i.test(m)) return 'That email or password isn’t right.';
        if (/Email not confirmed/i.test(m)) return 'Confirm your email address first — check your inbox for the invite.';
        if (/rate|too many/i.test(m)) return 'Too many attempts. Wait a moment and try again.';
        if (/network|fetch|Failed to fetch/i.test(m)) return 'Can’t reach Campistry. Check your connection.';
        return m || 'Could not sign in.';
    }

    function client() {
        return window.supabase || (window.CampistrySupabase && window.CampistrySupabase.client) || null;
    }

    async function boot() {
        const sb = client();
        if (!sb) {
            document.getElementById('liteLogin').style.display = '';
            showErr('Authentication service unavailable. Please reload.');
            return;
        }
        // Already signed in (or a refreshable session on disk) → straight in, so
        // reopening the installed app doesn't ask again.
        try {
            let { data } = await sb.auth.getSession();
            if (!data?.session && localStorage.getItem('campistry_auth_user_id')) {
                const r = await sb.auth.refreshSession();
                data = r?.data;
            }
            if (data?.session) { location.replace(HOME); return; }
        } catch (_) { /* show the form */ }

        localStorage.removeItem('campistry_auth_user_id');
        $('liteLogin').style.display = '';
        $('liteEmail').focus();
    }

    document.addEventListener('DOMContentLoaded', () => {
        boot();

        $('litePwToggle').addEventListener('click', () => {
            const pw = $('litePassword');
            const show = pw.type === 'password';
            pw.type = show ? 'text' : 'password';
            $('litePwToggle').textContent = show ? 'Hide' : 'Show';
            $('litePwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        });

        $('liteLoginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            showErr('');
            const email = ($('liteEmail').value || '').trim();
            const password = $('litePassword').value || '';
            if (!email || !password) { showErr('Enter your email and password.'); return; }

            const sb = client();
            if (!sb) { showErr('Authentication service unavailable. Please reload.'); return; }

            busy(true);
            try {
                const { data, error } = await sb.auth.signInWithPassword({ email, password });
                if (error) throw error;
                if (!data?.session) throw new Error('Could not start a session. Please try again.');
                // Same cache key the rest of Campistry reads, so Lite's auth gate
                // can refresh a session instead of bouncing back here.
                if (data.user?.id) localStorage.setItem('campistry_auth_user_id', data.user.id);
                location.replace(HOME);
            } catch (err) {
                showErr(friendlyAuthError(err));
                busy(false);
            }
        });

        $('liteForgot').addEventListener('click', async () => {
            const email = ($('liteEmail').value || '').trim();
            if (!email) { showErr('Enter your email above first, then tap this again.'); $('liteEmail').focus(); return; }
            const sb = client();
            if (!sb) return;
            showErr('');
            try {
                const { error } = await sb.auth.resetPasswordForEmail(email, {
                    redirectTo: location.origin + '/index.html'
                });
                if (error) throw error;
                toast('Reset link sent — check your email.');
            } catch (err) {
                showErr(friendlyAuthError(err));
            }
        });
    });
})();
