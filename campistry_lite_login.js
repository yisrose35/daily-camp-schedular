/* ============================================================================
   Campistry Lite — standalone sign-in + staff self-signup
   ----------------------------------------------------------------------------
   Lite installs to the home screen as its own app, so it needs its own front
   door rather than bouncing to the marketing site's landing page. Sign-in
   calls the same supabase.auth.signInWithPassword the desktop landing page
   uses, against the same project, so credentials, session storage and RLS
   behave identically.

   Create-account mirrors landing.js's own invite-detection logic exactly
   (see its "SIGNUP: Create camp or accept invite" branch) rather than
   opening a new, unauthenticated path onto camp_users: an admin still has to
   create the camp_users row first (Team management, or the hiring pipeline's
   "Invite to Lite" action in campistry_me.js) — this screen just lets a
   hired staff member accept that invite by typing their email + a new
   password directly here, instead of needing to open a separate emailed
   link first. Sign up with an email that has no pending invite still
   creates a real login (Supabase doesn't let us check camp_users before
   auth — RLS requires a session), but boot()'s existing "No camp found for
   this account" screen in campistry_lite.js is what actually gates entry,
   so nothing sensitive is exposed by that order.
   ============================================================================ */
(function () {
    'use strict';

    const HOME = 'campistry_lite.html';
    const $ = id => document.getElementById(id);
    const Bio = window.CampistryLiteBio;

    // Where the "confirm your email" link should land. location.origin is
    // correct on the web (whatever domain this page is actually served
    // from), but inside the native app it's the internal capacitor://
    // scheme — meaningless once the link is opened from a phone's email
    // app in a real browser. Falls back to the same real web origin
    // campistry_lite_capacitor.js already uses for every other case of
    // "native needs a genuine https:// URL."
    function emailRedirectTo() {
        try {
            if (window.Capacitor?.isNativePlatform?.()) {
                return (window.__CAMPISTRY_WEB_URL__ || 'https://campistry.org') + '/campistry_lite_login.html';
            }
        } catch (_) {}
        return location.origin + location.pathname;
    }

    // "Biometrics" rather than naming a sensor: the same phone may use a face,
    // a fingerprint or an iris, and WebAuthn never tells us which the platform
    // authenticator will actually ask for. Promising the wrong one is worse
    // than saying nothing.
    const BIO_NAME = 'biometrics';

    let bioAvailable = false;
    let signedInUserId = null;   // who we just signed in, to bind an enrolment to
    let authMode = 'signin';     // 'signin' | 'signup' — which branch the form submit takes

    function setAuthMode(mode) {
        authMode = mode;
        showErr('');
        const signup = mode === 'signup';
        $('liteModeSignin').classList.toggle('active', !signup);
        $('liteModeSignup').classList.toggle('active', signup);
        $('litePwConfirmField').hidden = !signup;
        $('litePasswordConfirm').required = signup;
        $('litePassword').autocomplete = signup ? 'new-password' : 'current-password';
        $('liteLoginSub').textContent = signup ? 'Create your account' : 'Sign in to your camp';
        $('liteLoginBtn').textContent = signup ? 'Create account' : 'Sign in';
        $('liteForgot').hidden = signup;
        $('liteFootSignin').hidden = signup;
        $('liteFootSignup').hidden = !signup;
        // A biometric quick-unlock only ever applies to an existing account.
        if (signup) $('liteBioQuick').hidden = true;
    }

    // The form and the offer pane are the only two full-screen states now —
    // biometrics is a quick-action ABOVE the form (#liteBioQuick), not a
    // separate screen you have to back out of. That is the whole point of
    // this design: cancelling the OS Face ID/fingerprint prompt should leave
    // you looking at a sign-in form you can already type into, the way
    // dismissing Face ID in any other app leaves you on the screen
    // underneath it, not one more tap away from it.
    function showPane(name) {
        const panes = { form: $('liteLoginForm'), offer: $('liteBioOffer'), verify: $('liteVerifyForm') };
        Object.keys(panes).forEach(k => { if (panes[k]) panes[k].hidden = k !== name; });
        // The mode toggle and its footnotes belong to the form pane only —
        // they'd read as a stray extra choice sitting above the post-sign-in
        // biometric offer or the verification-code pane.
        const formOnly = name === 'form';
        $('liteLoginModes').hidden = !formOnly;
        $('liteFootSignin').hidden = !formOnly || authMode === 'signup';
        $('liteFootSignup').hidden = !formOnly || authMode !== 'signup';
        const sub = $('liteLoginSub');
        if (sub) {
            sub.hidden = false;
            sub.textContent = name === 'offer' ? 'You’re signed in'
                : name === 'verify' ? 'Check your email'
                : (authMode === 'signup' ? 'Create your account' : 'Sign in to your camp');
        }
        $('liteLogin').style.display = '';
    }

    let pendingVerifyEmail = null;   // whose code the verify pane is waiting on

    function showVerifyPane(email) {
        pendingVerifyEmail = email;
        const label = $('liteVerifyEmail');
        if (label) label.textContent = email;
        const err = $('liteVerifyErr');
        if (err) { err.hidden = true; err.textContent = ''; }
        const code = $('liteVerifyCode');
        if (code) code.value = '';
        showPane('verify');
        setTimeout(() => code && code.focus(), 100);
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
        const idle = authMode === 'signup' ? 'Create account' : 'Sign in';
        const doing = authMode === 'signup' ? 'Creating account…' : 'Signing in…';
        btn.textContent = on ? (label || doing) : idle;
    }

    // Supabase's messages are written for developers; these are for counselors.
    function friendlyAuthError(err) {
        const m = String((err && err.message) || err || '');
        if (/Invalid login credentials/i.test(m)) return 'That email or password isn’t right.';
        if (/Email not confirmed/i.test(m)) return 'Confirm your email address first — check your inbox for the invite.';
        if (/User already registered|already been registered/i.test(m)) return 'An account already exists for that email — try Sign In instead.';
        if (/Password should be at least/i.test(m)) return 'Choose a password with at least 6 characters.';
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

        // A camp can hand a hired staff member a direct link
        // (campistry_lite_login.html?mode=signup) instead of "open the app,
        // find Create Account" — same screen, just pre-selected.
        try {
            if (new URLSearchParams(location.search).get('mode') === 'signup') setAuthMode('signup');
        } catch (_) {}
    }

    // Fire the prompt on open, but only after the sign-in screen has had a
    // real moment on its own — long enough to register as "this is the app,
    // here's the form" before the system sheet arrives on top of it. 650ms
    // still read as immediate; 1.5s is a real, deliberate pause modeled on
    // how banking apps pace this. Two frames guarantees the paint before the
    // clock even starts.
    function autoBio() {
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { setTimeout(runBio, 1500); });
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

    // Shared tail for "we now have a real, usable session for a brand-new
    // account" — reached either straight from signUp() (when this project's
    // Auth settings don't require confirmation) or from a successful
    // verifyOtp() code check (when they do). Mirrors landing.js's own
    // "SIGNUP: accept invite" branch exactly — an admin must have already
    // created this camp_users row (Team management, or campistry_me.js's
    // "Invite to Lite" action) for there to be anything to claim. Query
    // WITHOUT .is('user_id', null): a race with another tab/flow may have
    // already accepted it.
    async function claimInviteAndEnter(sb, email, user) {
        if (user?.id) localStorage.setItem('campistry_auth_user_id', user.id);
        try {
            const { data: invite } = await sb
                .from('camp_users')
                .select('id, role, camp_id, user_id')
                .eq('email', email.toLowerCase())
                .maybeSingle();
            if (invite) {
                if (!invite.user_id) {
                    await sb.from('camp_users')
                        .update({ user_id: user.id, accepted_at: new Date().toISOString() })
                        .eq('id', invite.id);
                }
                localStorage.setItem('campistry_camp_id', invite.camp_id);
                localStorage.setItem('campistry_role', invite.role);
                localStorage.setItem('campistry_is_team_member', 'true');
            }
            // No invite found: still proceed — campistry_lite.js's own
            // boot() shows "No camp found for this account" clearly,
            // rather than this screen guessing at a different message
            // for what is ultimately the same unresolved-camp state.
        } catch (claimErr) {
            console.warn('[Lite] invite claim failed:', claimErr);
        }

        if (Bio) Bio.markVerified();
        busy(false);
        signedInUserId = user?.id || null;
        if (maybeOfferBio(signedInUserId)) return;
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

        $('liteModeSignin').addEventListener('click', () => setAuthMode('signin'));
        $('liteModeSignup').addEventListener('click', () => setAuthMode('signup'));
        $('liteFootToSignup').addEventListener('click', () => setAuthMode('signup'));

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

            if (authMode === 'signup') {
                const confirm = $('litePasswordConfirm').value || '';
                if (password !== confirm) { showErr('Those passwords don’t match.'); return; }
                if (password.length < 6) { showErr('Choose a password with at least 6 characters.'); return; }

                busy(true);
                try {
                    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: emailRedirectTo() } });
                    if (error) throw error;
                    if (!data?.session) {
                        // This project's Auth settings require email confirmation —
                        // the account exists but isn't usable yet. Same code-entry
                        // mechanism landing.js already uses for the main site (see
                        // showVerifyPane above) rather than relying on the emailed
                        // link, which a shared template can't guarantee shows.
                        busy(false);
                        showVerifyPane(email);
                        return;
                    }
                    await claimInviteAndEnter(sb, email, data.user);
                } catch (err) {
                    showErr(friendlyAuthError(err));
                    busy(false);
                }
                return;
            }

            busy(true);
            try {
                const { data, error } = await sb.auth.signInWithPassword({ email, password });
                if (error) {
                    if (/Email not confirmed/i.test(error.message || '')) {
                        busy(false);
                        showVerifyPane(email);
                        return;
                    }
                    throw error;
                }
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

        $('liteVerifyForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const errEl = $('liteVerifyErr');
            const say = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = !msg; } };
            const code = ($('liteVerifyCode').value || '').trim();
            // Not hardcoded to 6: Supabase's email OTP length is a project
            // setting, and this project's is actually 8 — a strict {6} check
            // silently rejected every correct code a real user typed. Accept
            // the range Supabase itself allows and let verifyOtp be the real
            // authority on whether the code is right.
            if (!/^\d{6,10}$/.test(code)) { say('Enter the verification code from your email.'); return; }
            const sb = client();
            if (!sb || !pendingVerifyEmail) { say('Something went wrong — go back and try again.'); return; }
            const btn = $('liteVerifyBtn');
            btn.disabled = true; btn.textContent = 'Verifying…';
            try {
                // type:'signup' is the OTP *type* (confirming a signup token),
                // not a claim about when it was sent — correct both right
                // after signup and for an existing unconfirmed account
                // retrying login. Same call landing.js relies on.
                const { data, error } = await sb.auth.verifyOtp({ email: pendingVerifyEmail, token: code, type: 'signup' });
                if (error) throw error;
                if (!data?.user) throw new Error('Verification failed. Please try again.');
                await claimInviteAndEnter(sb, pendingVerifyEmail, data.user);
            } catch (err) {
                say(friendlyAuthError(err) || 'Invalid or expired code.');
                btn.disabled = false; btn.textContent = 'Verify';
            }
        });

        $('liteVerifyResend').addEventListener('click', async () => {
            const sb = client();
            if (!sb || !pendingVerifyEmail) return;
            const btn = $('liteVerifyResend');
            const original = btn.textContent;
            btn.textContent = 'Sending…'; btn.disabled = true;
            try {
                const { error } = await sb.auth.resend({ type: 'signup', email: pendingVerifyEmail });
                const errEl = $('liteVerifyErr');
                if (error) { if (errEl) { errEl.textContent = friendlyAuthError(error); errEl.hidden = false; } }
                else { toast('A new code has been sent to ' + pendingVerifyEmail + '.'); }
            } catch (_) {
                toast('Could not resend — check your connection.');
            } finally {
                btn.textContent = original; btn.disabled = false;
            }
        });

        $('liteVerifyBack').addEventListener('click', () => {
            pendingVerifyEmail = null;
            setAuthMode('signin');
            showPane('form');
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
