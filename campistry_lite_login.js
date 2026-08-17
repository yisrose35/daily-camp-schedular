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
    const Bio = window.CampistryLiteBio;

    // "Biometrics" rather than naming a sensor: the same phone may use a face,
    // a fingerprint or an iris, and WebAuthn never tells us which the platform
    // authenticator will actually ask for. Promising the wrong one is worse
    // than saying nothing.
    const BIO_NAME = 'biometrics';

    let bioAvailable = false;
    let signedInUserId = null;   // who we just signed in, to bind an enrolment to

    // The form and the offer pane are the only two full-screen states now —
    // biometrics is a quick-action ABOVE the form (#liteBioQuick), not a
    // separate screen you have to back out of. That is the whole point of
    // this design: cancelling the OS Face ID/fingerprint prompt should leave
    // you looking at a sign-in form you can already type into, the way
    // dismissing Face ID in any other app leaves you on the screen
    // underneath it, not one more tap away from it.
    function showPane(name) {
        const panes = { form: $('liteLoginForm'), offer: $('liteBioOffer') };
        Object.keys(panes).forEach(k => { if (panes[k]) panes[k].hidden = k !== name; });
        const sub = $('liteLoginSub');
        if (sub) { sub.hidden = false; sub.textContent = name === 'offer' ? 'You’re signed in' : 'Sign in to your camp'; }
        $('liteLogin').style.display = '';
    }


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
        el.hidden = !msg;
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
            showPane('form');
            showErr('Authentication service unavailable. Please reload.');
            return;
        }
        bioAvailable = Bio ? await Bio.available() : false;
        $('liteBioLabel').textContent = 'Sign in with biometrics';
        $('liteBioKind').textContent = BIO_NAME;

        let session = null;
        try {
            let { data } = await sb.auth.getSession();
            if (!data?.session && localStorage.getItem('campistry_auth_user_id')) {
                const r = await sb.auth.refreshSession();
                data = r?.data;
            }
            session = data?.session || null;
        } catch (_) { /* fall through to the form */ }

        if (session) {
            // Keep the stored copy fresh — refresh tokens rotate, and a stale
            // one would fail exactly when the user needs it after signing out.
            if (Bio) Bio.saveSession(session);
            // A live session still has to clear biometrics if it's enrolled for
            // this user — that check is the whole point, and the app shell
            // bounces back here until it passes. hasPass() only PEEKS: the app
            // is the one that consumes it, so we don't eat the handoff we just
            // wrote and send the user round again.
            if (Bio && Bio.isEnabledFor(session.user?.id) && !Bio.hasPass()) {
                showPane('form');
                $('liteBioQuick').hidden = false;
                if (session.user?.email) $('liteEmail').value = session.user.email;
                // Some platforms only allow the prompt from a user gesture; the
                // button is the fallback when this auto-attempt is refused.
                autoBio();
                return;
            }
            location.replace(HOME);
            return;
        }

        localStorage.removeItem('campistry_auth_user_id');
        // No live session, but an enrolled device with tokens kept for exactly
        // this case: signed out, and wanting back in with biometrics rather
        // than a password. Same screen either way — sign-in form as the base,
        // biometric offered above it, cancelling it leaves the form untouched.
        if (Bio && Bio.isEnabled() && Bio.storedSession()) {
            showPane('form');
            $('liteBioQuick').hidden = false;
            autoBio();
            return;
        }
        if (Bio) Bio.clearPass();
        showPane('form');
        $('liteBioQuick').hidden = true;
        // Deliberately no autofocus: it opens the keyboard over half the screen
        // before anyone has decided to type, and the accent focus ring on an
        // empty field reads as a validation error.
    }

    // Fire the prompt on open, but only after the sign-in screen has had a
    // real moment on its own — long enough to register as "this is the app,
    // here's the form" before the system sheet arrives on top of it, the way
    // Chase/Amex-style apps pace this. Two frames guarantees the paint before
    // the clock even starts; 650ms after that is the deliberate beat.
    function autoBio() {
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { setTimeout(runBio, 650); });
        });
    }

    async function runBio() {
        const btn = $('liteBioGo');
        btn.disabled = true;
        const ok = await Bio.verify();
        if (!ok) {
            btn.disabled = false;
            const e = Bio.lastError() || '';
            // A plain cancel gets no error text at all — the form is already
            // sitting right there to type into, exactly like dismissing Face
            // ID in any other app just leaves you looking at the screen
            // underneath, with nothing to explain.
            if (!/NotAllowed|cancel/i.test(e)) {
                showErr('Could not verify' + (e ? ' (' + e.split(':')[0] + ')' : '') + '. You can sign in with your password below.');
            }
            return;
        }

        // Verified. If we're only gating a live session there's nothing to
        // restore; if the user had signed out, put the session back first.
        const sb = client();
        let live = null;
        try { live = (await sb.auth.getSession())?.data?.session || null; } catch (_) {}
        if (!live) {
            const stored = Bio.storedSession();
            try {
                const { data, error } = await sb.auth.setSession({
                    access_token: stored.access_token || '',
                    refresh_token: stored.refresh_token
                });
                if (error) throw error;
                if (!data?.session) throw new Error('no session');
                Bio.saveSession(data.session);          // rotated token
                if (data.session.user?.id) localStorage.setItem('campistry_auth_user_id', data.session.user.id);
            } catch (err) {
                // The stored token is dead (revoked, expired, password changed).
                // Drop it and fall back to the password rather than looping —
                // hiding the quick-action too, since retrying it here would
                // just fail the exact same way again.
                Bio.clearSession();
                btn.disabled = false;
                showErr('Your saved sign-in expired. Please use your password once.');
                $('liteBioQuick').hidden = true;
                return;
            }
        }
        location.replace(HOME);
    }

    // Called after a successful password sign-in. Returns true if we're showing
    // the offer (so the caller must not navigate away).
    function maybeOfferBio(userId) {
        if (!bioAvailable || !Bio || Bio.isEnabledFor(userId) || Bio.isDeclined()) return false;
        showErr('');
        showPane('offer');
        return true;
    }

    document.addEventListener('DOMContentLoaded', () => {
        boot();

        $('litePwToggle').addEventListener('click', () => {
            const pw = $('litePassword'), btn = $('litePwToggle');
            const show = pw.type === 'password';
            pw.type = show ? 'text' : 'password';
            btn.setAttribute('aria-pressed', show ? 'true' : 'false');
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            // Keep the caret where it was rather than dumping it at the end.
            const n = pw.value.length;
            try { pw.setSelectionRange(n, n); } catch (_) {}
            pw.focus();
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
                // Typing the password IS the check for this launch, so the app
                // must not bounce straight back here asking for a face.
                if (Bio) Bio.markVerified();
                busy(false);
                signedInUserId = data.user?.id || null;
                if (maybeOfferBio(signedInUserId)) return;
                location.replace(HOME);
            } catch (err) {
                showErr(friendlyAuthError(err));
                busy(false);
            }
        });

        $('liteBioGo').addEventListener('click', () => { showErr(''); runBio(); });

        $('liteBioEnable').addEventListener('click', async () => {
            const btn = $('liteBioEnable');
            btn.disabled = true;
            btn.textContent = 'Setting up…';
            const ok = await Bio.enroll(($('liteEmail').value || '').trim(), null, signedInUserId);
            btn.disabled = false;
            btn.textContent = 'Turn it on';
            if (!ok) {
                const e = Bio.lastError() || '';
                showErr(/NotAllowed/.test(e)
                    ? 'Cancelled. You can turn it on later in Settings.'
                    : 'Could not set up ' + BIO_NAME + (e ? ' (' + e.split(':')[0] + ')' : '') + '.');
                return;
            }
            // Capture the session so biometrics has something to restore.
            try {
                const sb = client();
                Bio.saveSession((await sb.auth.getSession())?.data?.session);
            } catch (_) {}
            location.replace(HOME);
        });

        $('liteBioSkip').addEventListener('click', () => {
            if (Bio) Bio.decline();
            location.replace(HOME);
        });

        $('liteForgot').addEventListener('click', async () => {
            const email = ($('liteEmail').value || '').trim();
            if (!email) { showErr('Enter your email above first, then tap this again.'); $('liteEmail').focus(); return; }
            const sb = client();
            if (!sb) return;
            showErr('');
            // The link is opened from an email, so it lands in a BROWSER. It
            // therefore has to point at a public https page — location.origin
            // is https://localhost inside the app shell, and Lite has no page
            // of its own on the public site, so the old redirect went nowhere.
            const base = (window.__CAMPISTRY_PARENT_URL__ || 'https://link.campistry.org').replace(/\/+$/, '');
            try {
                const { error } = await sb.auth.resetPasswordForEmail(email, {
                    redirectTo: base + '/reset?app=lite'
                });
                // Same reply either way: a different message for an unknown
                // address would tell a stranger which staff emails exist.
                if (error) console.warn('[Lite] reset:', error.message);
                toast('If that email has an account, a reset link is on its way.');
            } catch (err) {
                console.warn('[Lite] reset:', err);
                toast('If that email has an account, a reset link is on its way.');
            }
        });
    });
})();
