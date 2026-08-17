/* ============================================================================
   Campistry Lite — biometric sign-in
   ----------------------------------------------------------------------------
   Shared by the sign-in page and the app shell, so there is exactly ONE door:
   campistry_lite_login.html. Biometrics is a second WAY THROUGH that door, not
   a second door — an earlier build put a separate "Unlock" overlay after login,
   which read as two different apps.

   How it hangs together:

     • Enrolment registers a platform authenticator (face, fingerprint, …) via
       WebAuthn and stores the credential id, plus the id of the user it was
       enrolled for. No secret of ours is kept — the private key lives in the
       device's secure hardware.
     • The enrolment is bound to that user. On a shared phone, someone else
       signing in is NOT covered by your face; the mismatch reads as
       not-enrolled and the stale credential is dropped. That binding is why
       signing out can leave the enrolment alone — signing back in as yourself
       still works, and nobody else inherits it.
     • The Supabase session is persisted exactly as before. Biometrics does not
       replace it; it authorises USING it. That is why nothing here touches
       tokens: there is no extra copy of a refresh token to leak.
     • Passing the check writes a ONE-SHOT pass that the app consumes on the
       next load. It is deliberately not a "verified for this session" flag:
       sessionStorage survives a reload in the same tab, so such a flag would
       make the check fire once and never again for the life of that tab.

   What this is NOT: it is not a second authentication factor against Supabase.
   Anyone who can read localStorage can still read the persisted session, the
   same as any other browser app. It stops a person holding your unlocked phone
   from opening Campistry, which is the threat counselors actually have.

   The sign-out trade-off, stated plainly: while biometrics is on, signing out
   is LOCAL — the refresh token is kept on this device so biometrics can get
   you back in, instead of forcing the password every time. That is how banking
   apps behave, and it is the only way "sign in using biometrics" can mean
   anything on the sign-in screen. It does mean a signed-out phone still holds a
   usable token until biometrics is turned off, which revokes the session for
   real and wipes it. Turning it off is therefore the "forget this device"
   action, and the UI says so.
   ============================================================================ */
(function () {
    'use strict';

    // One implementation, two apps. Campistry Link sets these before loading
    // this file; Lite sets nothing and keeps its original key names exactly, so
    // no already-enrolled device is disturbed.
    var NS       = window.__CAMPISTRY_BIO_NS || 'lite';
    var APP_NAME = window.__CAMPISTRY_BIO_APP || 'Campistry Lite';

    var CRED_KEY     = NS + '_bio_cred';      // credential id (base64)
    var USER_KEY     = NS + '_bio_user';      // whose credential it is
    var SESS_KEY     = NS + '_bio_session';   // tokens to restore after sign-out
    var DECLINED_KEY = NS + '_bio_declined';  // don't nag after "Not now"
    var PASS_KEY     = NS + '_bio_pass';      // one-shot handoff, see passFresh()
    var PASS_TTL_MS  = 60000;                 // generous for a slow cold boot

    var lastError = null;   // real cause of the last failed enrol/verify

    function ls(fn, def) { try { return fn(); } catch (e) { return def; } }

    function b64(buf) {
        var bytes = new Uint8Array(buf), s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }
    function unb64(s) {
        var bin = atob(s), a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
    }
    function randomBytes(n) {
        var a = new Uint8Array(n);
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
        return a;
    }

    // Platform authenticator only — a roaming USB key is not what "unlock with
    // biometrics" means to a counselor, and WebAuthn needs a secure context anyway.
    // Returns the REASON when unavailable: "it doesn't work" with no cause is
    // impossible to act on, for the user or for us.
    function why() {
        try {
            if (!window.PublicKeyCredential) return Promise.resolve('This browser has no biometric support');
            if (!window.isSecureContext) return Promise.resolve('Needs a secure (https) connection');
            if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)
                return Promise.resolve('This browser has no biometric support');
            return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
                .then(function (ok) { return ok ? null : 'No screen lock set up on this device'; })
                .catch(function (e) { return 'Could not check: ' + (e && e.name ? e.name : 'unknown'); });
        } catch (e) { return Promise.resolve('Could not check: ' + (e && e.name ? e.name : 'unknown')); }
    }
    function available() { return why().then(function (r) { return !r; }); }

    function isEnabled()  { return !!ls(function () { return localStorage.getItem(CRED_KEY); }, null); }
    function credUser()   { return ls(function () { return localStorage.getItem(USER_KEY); }, null); }
    // "Not now" means not now, not never. Kept in sessionStorage so the offer
    // comes back on the next sign-in — a permanent suppression left people with
    // no route to biometrics at all unless they went hunting in Settings.
    function isDeclined() { return ls(function () { return sessionStorage.getItem(DECLINED_KEY); }, null) === '1'; }
    function decline()    { ls(function () { sessionStorage.setItem(DECLINED_KEY, '1'); }); }

    // Enrolled AND enrolled for THIS person. A credential left behind by the
    // previous user must not gate — or unlock — the new one's session, so a
    // mismatch is treated as not-enrolled and the stale entry is discarded.
    function isEnabledFor(userId) {
        if (!isEnabled()) return false;
        var owner = credUser();
        if (!userId) return true;              // caller doesn't know yet — don't destroy anything
        if (owner && owner !== userId) { disable(); return false; }
        return true;
    }

    // Tokens kept ONLY while biometrics is on, so signing out can still leave a
    // biometric route back in — which is what "sign in using biometrics"
    // means to anyone who has used a banking app. Turning biometrics off wipes
    // them again. See the header note on what this does and does not protect.
    function saveSession(session) {
        if (!session || !session.refresh_token || !isEnabled()) return;
        ls(function () {
            localStorage.setItem(SESS_KEY, JSON.stringify({
                access_token: session.access_token || '',
                refresh_token: session.refresh_token
            }));
        });
    }
    function storedSession() {
        var raw = ls(function () { return localStorage.getItem(SESS_KEY); }, null);
        if (!raw) return null;
        try { var s = JSON.parse(raw); return s && s.refresh_token ? s : null; }
        catch (e) { return null; }
    }
    function clearSession() { ls(function () { localStorage.removeItem(SESS_KEY); }); }

    function disable() {
        ls(function () {
            localStorage.removeItem(CRED_KEY);
            localStorage.removeItem(USER_KEY);
        });
        clearSession();
        clearPass();
    }

    // A one-shot handoff, not a session flag. The login page writes it, the app
    // consumes it on the very next load, and it expires on its own — so every
    // fresh load of the app asks again, including a plain browser reload.
    // The pass lives in localStorage, NOT sessionStorage. It has to survive a
    // WebView reload: the live-update plugin reloads the app during startup to
    // apply a pending bundle, and sessionStorage does not survive that — so
    // someone who had just passed the check was asked for their face a second
    // time, on nearly every launch while updates were shipping. It stays safe
    // because it is still one-shot (consumed on read) and still expires after
    // PASS_TTL_MS, so it can never become a "verified forever" flag.
    function markVerified() {
        ls(function () { localStorage.setItem(PASS_KEY, String(Date.now())); });
    }
    function passFresh() {
        var raw = ls(function () { return localStorage.getItem(PASS_KEY); }, null);
        if (!raw) return false;
        var t = parseInt(raw, 10);
        return !!t && (Date.now() - t) < PASS_TTL_MS;
    }
    function hasPass()     { return passFresh(); }               // peek
    function consumePass() { var ok = passFresh(); clearPass(); return ok; }
    function clearPass()   { ls(function () { localStorage.removeItem(PASS_KEY); sessionStorage.removeItem(PASS_KEY); }); }

    // "Closed the app" and "walked away for a while" should both demand the
    // face/fingerprint again, the way a banking app does. Biometrics as built
    // above only ever gates a genuine cold start — the page load that runs
    // isEnabled()/hasPass() at boot. Capacitor keeps the WebView and all its
    // JS state alive across a plain background/foreground cycle (switching
    // apps, screen lock, a phone call), so without this, once past that first
    // gate the session stays open indefinitely no matter how long the phone
    // sits untouched — nothing ever re-runs the boot check on its own.
    //
    // RELOCK_MS is a grace window, not a hard rule: under it, a quick
    // app-switch (checking a text, glancing at another app) doesn't nag for
    // a face on every return, which is how the apps this was modeled on
    // actually behave too. At or past it, the next foreground clears the
    // one-shot pass and fires 'campistry-bio-relock' — each app's own page
    // listens for that and re-shows its unlock screen exactly as it would on
    // a cold launch, reusing that same logic rather than duplicating it here.
    var BG_KEY = NS + '_bio_bg_at';
    var RELOCK_MS = 30000;

    function markBackgrounded()  { ls(function () { localStorage.setItem(BG_KEY, String(Date.now())); }); }
    function clearBackgrounded() { ls(function () { localStorage.removeItem(BG_KEY); }); }
    function wasAwayLongEnough() {
        var raw = ls(function () { return localStorage.getItem(BG_KEY); }, null);
        if (!raw) return false;
        var t = parseInt(raw, 10);
        return !!t && (Date.now() - t) >= RELOCK_MS;
    }

    (function wireAppLifecycle() {
        var C = window.Capacitor;
        var AppPlugin = C && (C.Plugins || {}).App;
        if (!AppPlugin || !AppPlugin.addListener) return;   // web, or build without the plugin
        AppPlugin.addListener('appStateChange', function (state) {
            if (!state) return;
            if (state.isActive === false) { markBackgrounded(); return; }
            if (state.isActive === true) {
                var relock = isEnabled() && wasAwayLongEnough();
                clearBackgrounded();
                if (relock) {
                    clearPass();
                    try { window.dispatchEvent(new CustomEvent('campistry-bio-relock')); } catch (_) {}
                }
            }
        });
    })();

    function enroll(email, name, userId) {
        return navigator.credentials.create({ publicKey: {
            challenge: randomBytes(32),
            rp: { name: APP_NAME },          // rp.id omitted → current origin
            user: {
                id: randomBytes(16),
                name: email || 'campistry',
                displayName: name || email || APP_NAME + ' user'
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: {
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                residentKey: 'preferred'
            },
            timeout: 60000
        } }).then(function (cred) {
            if (!cred) return false;
            ls(function () {
                localStorage.setItem(CRED_KEY, b64(cred.rawId));
                if (userId) localStorage.setItem(USER_KEY, userId);
                else localStorage.removeItem(USER_KEY);
                localStorage.removeItem(DECLINED_KEY);
            });
            markVerified();
            return true;
        }).catch(function (e) {
            // Keep the real cause. A silent false here is exactly why this
            // looked like "nothing happens when I turn it on".
            lastError = (e && e.name) ? e.name : 'unknown';
            if (e && e.message) lastError += ': ' + e.message;
            return false;
        });
    }

    function verify() {
        var id = ls(function () { return localStorage.getItem(CRED_KEY); }, null);
        if (!id) return Promise.resolve(false);
        var allow;
        try { allow = [{ type: 'public-key', id: unb64(id) }]; }
        catch (e) { return Promise.resolve(false); }
        return navigator.credentials.get({ publicKey: {
            challenge: randomBytes(32),
            allowCredentials: allow,
            userVerification: 'required',
            timeout: 60000
        } }).then(function (assertion) {
            if (!assertion) return false;
            markVerified();
            return true;
        }).catch(function (e) {
            lastError = (e && e.name) ? e.name : 'unknown';
            if (e && e.message) lastError += ': ' + e.message;
            return false;
        });
    }

    // CampistryBio is the name to use; CampistryLiteBio is kept because Lite
    // already refers to it in several places.
    window.CampistryBio = window.CampistryLiteBio = {
        available: available,
        why: why,
        lastError: function () { return lastError; },
        isEnabled: isEnabled,
        isEnabledFor: isEnabledFor,
        saveSession: saveSession,
        storedSession: storedSession,
        clearSession: clearSession,
        isDeclined: isDeclined,
        decline: decline,
        enroll: enroll,
        verify: verify,
        disable: disable,
        markVerified: markVerified,
        hasPass: hasPass,
        consumePass: consumePass,
        clearPass: clearPass
    };
})();
