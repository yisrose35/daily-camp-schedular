// Native biometrics bridge, shared by Campistry Lite and Campistry Link.
//
// campistry_lite_biometric.js implements the feature with WebAuthn platform
// authenticators, which is right on the web and useless inside a native
// WebView: Android's WebView has no WebAuthn at all, and iOS WKWebView will not
// serve it to a capacitor:// origin. Left alone, the Face ID / fingerprint lock
// reports "not available" on exactly the devices it was built for.
//
// So on native only, swap the two capability checks and the two crypto calls
// for the native biometric plugin. Everything else is untouched: this writes
// the SAME localStorage keys the module reads, so isEnabled / isEnabledFor /
// saveSession / disable and every caller in either app keep working as-is.
//
// Load AFTER campistry_lite_biometric.js. A complete no-op on the web.
(function () {
    'use strict';
    var C = window.Capacitor;
    if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

    // @aparajita/capacitor-biometric-auth registers its native side under this
    // name. We talk to the raw bridge rather than the package's ESM wrapper:
    // Campistry has no build step, and that wrapper imports '@capacitor/core'
    // by bare specifier. If the plugin is absent, leave the WebAuthn path alone
    // — an honest "not available" beats a thrown error.
    var NB = (C.Plugins || {}).BiometricAuthNative;

    // Must match campistry_lite_biometric.js, including its namespace default.
    var NS       = window.__CAMPISTRY_BIO_NS || 'lite';
    var APP_NAME = window.__CAMPISTRY_BIO_APP || 'Campistry Lite';
    var CRED_KEY = NS + '_bio_cred';
    var USER_KEY = NS + '_bio_user';

    function install() {
        var Bio = window.CampistryBio || window.CampistryLiteBio;
        if (!Bio || !NB) return;

        var lastError = null;

        // checkBiometry() → { isAvailable, biometryType, deviceIsSecure, reason }
        function checkAvailable() {
            return Promise.resolve(NB.checkBiometry()).then(function (r) {
                if (!r) return 'Biometrics are not available on this device';
                if (r.isAvailable) return null;
                return r.reason || (r.deviceIsSecure
                    ? 'No biometrics enrolled on this device'
                    : 'No screen lock set up on this device');
            }).catch(function (e) {
                return 'Could not check: ' + ((e && (e.message || e.name)) || 'unknown');
            });
        }

        // internalAuthenticate() resolves on success, rejects on failure/cancel.
        // allowDeviceCredential lets someone fall back to their passcode rather
        // than being locked out by a wet or gloved finger.
        function prompt(reason) {
            return Promise.resolve(NB.internalAuthenticate({
                reason: reason,
                allowDeviceCredential: true,
                androidTitle: APP_NAME,
                androidSubtitle: reason,
                cancelTitle: 'Cancel'
            })).then(function () { return true; }).catch(function (e) {
                lastError = (e && (e.message || e.code || e.name)) || 'cancelled';
                return false;
            });
        }

        Bio.why = function () { return checkAvailable(); };
        Bio.available = function () { return checkAvailable().then(function (r) { return !r; }); };
        Bio.lastError = function () { return lastError; };

        Bio.enroll = function (email, name, userId) {
            return prompt('Turn on biometric unlock for ' + APP_NAME).then(function (ok) {
                if (!ok) return false;
                try {
                    // 'native' stands in for the WebAuthn credential id: the OS
                    // holds the real secret, we only record THAT it is on and
                    // for whom, exactly as the WebAuthn path does.
                    localStorage.setItem(CRED_KEY, 'native');
                    if (userId) localStorage.setItem(USER_KEY, userId);
                } catch (_) { return false; }
                Bio.markVerified();
                return true;
            });
        };

        Bio.verify = function () {
            var enrolled = null;
            try { enrolled = localStorage.getItem(CRED_KEY); } catch (_) {}
            if (!enrolled) return Promise.resolve(false);
            return prompt('Unlock ' + APP_NAME).then(function (ok) {
                if (ok) Bio.markVerified();
                return ok;
            });
        };
    }

    if (window.CampistryBio || window.CampistryLiteBio) install();
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
    else install();
})();
