/* ============================================================================
   Campistry Lite — biometric sign-in
   ----------------------------------------------------------------------------
   Shared by the sign-in page and the app shell, so there is exactly ONE door:
   campistry_lite_login.html. Biometrics is a second WAY THROUGH that door, not
   a second door — an earlier build put a separate "Unlock" overlay after login,
   which read as two different apps.

   How it hangs together:

     • Enrolment registers a platform authenticator (Face ID / fingerprint) via
       WebAuthn and stores only the credential id. No secret of ours is kept —
       the private key lives in the device's secure hardware.
     • The Supabase session is persisted exactly as before. Biometrics does not
       replace it; it authorises USING it. That is why nothing here touches
       tokens: there is no extra copy of a refresh token to leak.
     • Passing the check sets a flag in sessionStorage, which the browser drops
       when the app is closed. So every fresh launch asks again, and navigating
       login → app inside one launch does not.

   What this is NOT: it is not a second authentication factor against Supabase.
   Anyone who can read localStorage can still read the persisted session, the
   same as any other browser app. It stops a person holding your unlocked phone
   from opening Campistry, which is the threat counselors actually have.
   ============================================================================ */
(function () {
    'use strict';

    var CRED_KEY     = 'lite_bio_cred';      // credential id (base64)
    var DECLINED_KEY = 'lite_bio_declined';  // don't nag after "Not now"
    var VERIFIED_KEY = 'lite_bio_ok';        // sessionStorage — this launch only

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
    function isDeclined() { return ls(function () { return localStorage.getItem(DECLINED_KEY); }, null) === '1'; }
    function decline()    { ls(function () { localStorage.setItem(DECLINED_KEY, '1'); }); }

    function disable() {
        ls(function () { localStorage.removeItem(CRED_KEY); });
        clearVerified();
    }

    // Verified-for-this-launch. sessionStorage, not localStorage, on purpose:
    // closing the app must invalidate it, or the check only ever runs once.
    function markVerified()  { ls(function () { sessionStorage.setItem(VERIFIED_KEY, '1'); }); }
    function isVerified()    { return ls(function () { return sessionStorage.getItem(VERIFIED_KEY); }, null) === '1'; }
    function clearVerified() { ls(function () { sessionStorage.removeItem(VERIFIED_KEY); }); }

    function enroll(email, name) {
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
        isDeclined: isDeclined,
        decline: decline,
        enroll: enroll,
        verify: verify,
        disable: disable,
        markVerified: markVerified,
        isVerified: isVerified,
        clearVerified: clearVerified
    };
})();
