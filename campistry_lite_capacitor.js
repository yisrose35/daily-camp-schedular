// Capacitor native-shell glue for Campistry Lite (staff mobile companion).
//
// Loaded on every build of campistry_lite.html and campistry_lite_login.html —
// web and native alike. Every branch below is guarded on
// Capacitor.isNativePlatform(), so on a plain desktop/mobile browser this file
// is a complete no-op. Capacitor injects its bridge before page scripts run,
// so window.Capacitor is already there by the time this executes.
(function () {
    'use strict';
    if (typeof window.Capacitor === 'undefined' || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;

    var Capacitor = window.Capacitor;
    var Plugins = Capacitor.Plugins || {};

    // Where the full desktop site lives. The native app bundles only the Lite
    // files, so anything else has to open in the system browser against the
    // real origin — a relative link would 404 inside the bundle.
    var WEB_ORIGIN = window.__CAMPISTRY_WEB_URL__ || 'https://campistry.org';

    // This file is loaded late in campistry_lite.html's dynamic script chain
    // (after the Supabase SDK), by which point DOMContentLoaded has usually
    // already fired — so don't wait for an event that has been and gone.
    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    ready(function () {
        if (Plugins.StatusBar) {
            Plugins.StatusBar.setStyle({ style: 'LIGHT' }).catch(function () {});
            Plugins.StatusBar.setBackgroundColor({ color: '#F7F2EF' }).catch(function () {});
        }
    });

    // ── Links that leave the bundle ──────────────────────────────────────────
    // Settings' "Open full Campistry ↗" is <a href="dashboard.html">, and the
    // account menu has the same. dashboard.html is NOT bundled (it's the
    // desktop app), so following it natively dead-ends the WebView with no way
    // back short of force-quitting. Send these to the system browser instead.
    var BUNDLED_PAGES = ['index.html', 'campistry_lite.html', 'campistry_lite_login.html'];
    document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || /^(mailto|tel|sms):/i.test(href)) return;

        var url = null;
        if (/^https?:\/\//i.test(href)) {
            url = href;
        } else if (/\.html($|[?#])/i.test(href)) {
            var page = href.replace(/^\.?\//, '').split(/[?#]/)[0];
            if (BUNDLED_PAGES.indexOf(page) !== -1) return;   // in-bundle nav: leave alone
            url = WEB_ORIGIN + '/' + href.replace(/^\.?\//, '');
        } else {
            return;
        }
        e.preventDefault();
        if (Plugins.Browser) Plugins.Browser.open({ url: url }).catch(function () {});
    }, true);

    // ── Android hardware back button ─────────────────────────────────────────
    // Registering a listener REPLACES Capacitor's default (history.back, else
    // exit), so this has to cover the whole chain itself. Lite already routes
    // app/settings navigation through history.pushState, so the last two steps
    // just delegate to that.
    if (Plugins.App && Plugins.App.addListener) {
        Plugins.App.addListener('backButton', function () {
            // 1. Account menu
            var menu = document.getElementById('liteMenu');
            if (menu && menu.style.display !== 'none') { menu.style.display = 'none'; return; }

            // 2. Bottom sheet (delete confirm, pickers, rainy day, thread view…).
            // Dispatch the backdrop click the sheet already listens for, so the
            // module runs its own closeSheet() and clears its internal handle.
            var backdrop = document.querySelector('.lite-sheet-backdrop');
            if (backdrop) {
                backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return;
            }

            // 3. Inside an app or the Settings screen → let Lite's own popstate
            // handler return to the launcher.
            var st = window.history.state;
            if (st && (st.liteApp || st.liteSettings)) { window.history.back(); return; }

            // 4. Home launcher with nothing open → leave the app.
            if (Plugins.App.exitApp) Plugins.App.exitApp();
        });
    }

    // ── Biometric app lock ───────────────────────────────────────────────────
    // campistry_lite_biometric.js uses WebAuthn platform authenticators, which
    // do NOT work in a native WebView: Android's WebView has no WebAuthn at
    // all, and iOS WKWebView won't serve it to a capacitor:// origin. Left
    // alone, Lite's Face ID / fingerprint lock silently reports "not
    // available" on the very devices it was built for.
    //
    // So on native only, swap the two capability checks and the two crypto
    // calls for the native biometric plugin. Everything else about the feature
    // — the enabled flag, whose credential it is, the stored-session handoff,
    // the one-shot pass — is untouched: this writes the SAME localStorage keys
    // the module reads, so isEnabled/isEnabledFor/saveSession/disable and every
    // caller in campistry_lite.js keep working as-is.
    var CRED_KEY = 'lite_bio_cred';   // must match campistry_lite_biometric.js
    var USER_KEY = 'lite_bio_user';

    function installNativeBio() {
        var Bio = window.CampistryLiteBio;
        // @aparajita/capacitor-biometric-auth registers its native side under
        // this name. We talk to the raw bridge rather than the package's ESM
        // wrapper: Campistry has no build step, and the wrapper imports
        // '@capacitor/core' by bare specifier. If the plugin is absent, leave
        // the WebAuthn path alone — an honest "not available" beats a throw.
        var NB = Plugins.BiometricAuthNative;
        if (!Bio || !NB) return;

        var lastError = null;

        // checkBiometry() → { isAvailable, biometryType, deviceIsSecure, reason, code }
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
        // allowDeviceCredential lets a counselor fall back to their passcode
        // rather than being locked out by a wet or gloved finger.
        function prompt(reason) {
            return Promise.resolve(NB.internalAuthenticate({
                reason: reason,
                allowDeviceCredential: true,
                androidTitle: 'Campistry Lite',
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
            return prompt('Turn on biometric unlock for Campistry Lite').then(function (ok) {
                if (!ok) return false;
                try {
                    // 'native' stands in for the WebAuthn credential id: the OS
                    // holds the real secret, we only record THAT it's on and
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
            return prompt('Unlock Campistry Lite').then(function (ok) {
                if (ok) Bio.markVerified();
                return ok;
            });
        };
    }

    // Load order guarantees this runs after campistry_lite_biometric.js (both
    // pages list it immediately after), so the module is already there.
    if (window.CampistryLiteBio) installNativeBio();
    else ready(installNativeBio);

    // ── TEMPORARY on-device diagnostics ──────────────────────────────────────
    // Sign-in reports "Can't reach Campistry" on device, but the exact same
    // bundle signs in fine from a localhost origin in a desktop browser — so
    // whatever breaks is specific to the WebView and invisible from here.
    // This prints the facts that would distinguish the candidates. Login screen
    // only, native only. REMOVE once the cause is known.
    ready(function () {
        if (!document.getElementById('liteLoginBtn')) return;   // login page only

        var box = document.createElement('pre');
        box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;margin:0;'
            + 'max-height:45vh;overflow:auto;background:#111;color:#0f0;font-size:10px;'
            + 'line-height:1.35;padding:8px;white-space:pre-wrap;';
        box.textContent = 'diagnostics running…';
        document.body.appendChild(box);

        var lines = [];
        function say(k, v) { lines.push(k + ': ' + v); box.textContent = lines.join('\n'); }

        say('origin', location.origin);
        say('online', navigator.onLine);
        say('supabase sdk', typeof window.supabase);
        say('client ready', !!(window.supabase && window.supabase.auth));
        say('config url', (window.__CAMPISTRY_SUPABASE__ || {}).url || 'MISSING');
        say('plugins', Object.keys(Plugins).join(',') || 'NONE');
        say('webview', (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['?'])[0]);

        var cfg = window.__CAMPISTRY_SUPABASE__ || {};
        // Raw fetch, no SDK in the way: separates "network blocked" from
        // "the SDK is misconfigured".
        fetch(cfg.url + '/auth/v1/health', { headers: { apikey: cfg.anonKey || '' } })
            .then(function (r) { say('raw fetch', 'HTTP ' + r.status); })
            .catch(function (e) { say('raw fetch', 'FAILED ' + (e && e.name) + ': ' + (e && e.message)); })
            .then(function () {
                // And the same call the sign-in button makes, with bad creds:
                // a 400 means the path works and the real problem is elsewhere.
                var sb = window.supabase && window.supabase.auth ? window.supabase : null;
                if (!sb) { say('sdk auth', 'NO CLIENT'); return; }
                return sb.auth.signInWithPassword({ email: 'probe@example.com', password: 'wrong-on-purpose' })
                    .then(function (r) { say('sdk auth', r.error ? (r.error.status + ' ' + r.error.message) : 'unexpected success'); })
                    .catch(function (e) { say('sdk auth', 'THREW ' + (e && e.name) + ': ' + (e && e.message)); });
            });
    });
})();
