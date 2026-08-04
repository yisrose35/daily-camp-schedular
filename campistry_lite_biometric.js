/* ============================================================================
   Campistry Lite — biometric sign-in
   ----------------------------------------------------------------------------
   Shared by the sign-in page and the app shell, so there is exactly ONE door:
   campistry_lite_login.html. Biometrics is a second WAY THROUGH that door, not
   a second door — an earlier build put a separate "Unlock" overlay after login,
   which read as two different apps.

   How it hangs together:

     • Enrolment registers a platform authenticator (Face ID / fingerprint) via
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
   ============================================================================ */
(function () {
    'use strict';

    var CRED_KEY     = 'lite_bio_cred';      // credential id (base64)
    var USER_KEY     = 'lite_bio_user';      // whose credential it is
    var DECLINED_KEY = 'lite_bio_declined';  // don't nag after "Not now"
    var PASS_KEY     = 'lite_bio_pass';      // sessionStorage — one-shot handoff
    var PASS_TTL_MS  = 60000;                // generous for a slow cold boot

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

    // Platform authenticator only — a roaming USB key is not what "Face ID"
    // means to a counselor, and WebAuthn needs a secure context regardless.
    function available() {
        try {
            if (!window.PublicKeyCredential || !window.isSecureContext) return Promise.resolve(false);
            if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false);
            return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
                .then(function (ok) { return !!ok; })
                .catch(function () { return false; });
        } catch (e) { return Promise.resolve(false); }
    }

    function isEnabled()  { return !!ls(function () { return localStorage.getItem(CRED_KEY); }, null); }
    function credUser()   { return ls(function () { return localStorage.getItem(USER_KEY); }, null); }
    function isDeclined() { return ls(function () { return localStorage.getItem(DECLINED_KEY); }, null) === '1'; }
    function decline()    { ls(function () { localStorage.setItem(DECLINED_KEY, '1'); }); }

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

    function disable() {
        ls(function () {
            localStorage.removeItem(CRED_KEY);
            localStorage.removeItem(USER_KEY);
        });
        clearPass();
    }

    // A one-shot handoff, not a session flag. The login page writes it, the app
    // consumes it on the very next load, and it expires on its own — so every
    // fresh load of the app asks again, including a plain browser reload.
    function markVerified() {
        ls(function () { sessionStorage.setItem(PASS_KEY, String(Date.now())); });
    }
    function passFresh() {
        var raw = ls(function () { return sessionStorage.getItem(PASS_KEY); }, null);
        if (!raw) return false;
        var t = parseInt(raw, 10);
        return !!t && (Date.now() - t) < PASS_TTL_MS;
    }
    function hasPass()     { return passFresh(); }               // peek
    function consumePass() { var ok = passFresh(); clearPass(); return ok; }
    function clearPass()   { ls(function () { sessionStorage.removeItem(PASS_KEY); }); }

    function enroll(email, name, userId) {
        return navigator.credentials.create({ publicKey: {
            challenge: randomBytes(32),
            rp: { name: 'Campistry Lite' },   // rp.id omitted → current origin
            user: {
                id: randomBytes(16),
                name: email || 'campistry',
                displayName: name || email || 'Campistry user'
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
        }).catch(function () { return false; });
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
        }).catch(function () { return false; });
    }

    window.CampistryLiteBio = {
        available: available,
        isEnabled: isEnabled,
        isEnabledFor: isEnabledFor,
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
