// Push notifications, shared by Campistry Link and Campistry Lite.
//
// A complete no-op on the web and on any build without the plugin, so this can
// ship before the Firebase/APNs credentials exist and simply start working once
// they do.
//
// What it does NOT do: decide whether a parent wants a given notification. That
// lives in their preferences (link_parent_profiles.prefs) and is applied by the
// SENDER, so turning "Photos" off stops the phone buzzing rather than merely
// hiding something after it already has.
(function () {
    'use strict';

    var C = window.Capacitor;
    if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
    var PN = (C.Plugins || {}).PushNotifications;
    if (!PN) return;   // plugin not in this build yet

    var APP = window.__CAMPISTRY_BIO_NS === 'lite' ? 'lite' : 'link';
    var LAST_KEY = APP + '_push_token';

    function db() {
        return window._parentDB || window.supabase || null;
    }

    function platform() {
        try { return C.getPlatform ? C.getPlatform() : 'unknown'; } catch (_) { return 'unknown'; }
    }

    // Registration is deliberately NOT called on first launch. Asking for
    // notification permission before someone has signed in — before the app has
    // shown them anything worth being notified about — is the reliable way to
    // get refused permanently. window.campistryPushRegister() is called after a
    // successful sign-in instead.
    window.campistryPushRegister = function () {
        PN.checkPermissions().then(function (res) {
            if (res && res.receive === 'denied') return;   // respect a previous no
            if (res && res.receive === 'granted') return PN.register();
            return PN.requestPermissions().then(function (r) {
                if (r && r.receive === 'granted') return PN.register();
            });
        }).catch(function (e) { console.warn('[push] permission:', e); });
    };

    // Fires on register(), and again whenever Firebase/APNs reissues the token —
    // which they do silently. Storing it every time is what stops a device going
    // quiet weeks later for no visible reason.
    PN.addListener('registration', function (t) {
        var token = t && t.value;
        if (!token) return;
        try { localStorage.setItem(LAST_KEY, token); } catch (_) {}
        var d = db();
        if (!d || !d.rpc) return;
        d.rpc('register_my_push_token', {
            p_token: token, p_platform: platform(), p_app: APP
        }).then(function (res) {
            if (res && res.error) console.warn('[push] register (migration 054 applied?):', res.error.message);
        }, function () {});
    });

    PN.addListener('registrationError', function (e) {
        // Almost always a missing google-services.json or an APNs key that has
        // not been uploaded — say so rather than failing mutely.
        console.warn('[push] registration failed — is the Firebase/APNs config in this build?', e);
    });

    // Tapping a notification should land on the thing it was about.
    PN.addListener('pushNotificationActionPerformed', function (action) {
        var data = (action && action.notification && action.notification.data) || {};
        var page = data.page || '';
        if (!page) return;
        var go = function () {
            if (typeof window.nav === 'function') window.nav(page);
            else if (typeof window.openApp === 'function') window.openApp(page);
        };
        // The app may still be booting when the tap arrives from a cold start.
        if (document.readyState === 'complete') setTimeout(go, 300);
        else window.addEventListener('load', function () { setTimeout(go, 600); });
    });

    // Foreground arrivals: the OS does not show a banner while the app is open,
    // so surface it in-app rather than letting it vanish.
    PN.addListener('pushNotificationReceived', function (n) {
        var title = (n && n.title) || '';
        var body = (n && n.body) || '';
        var text = [title, body].filter(Boolean).join(' — ');
        if (!text) return;
        if (typeof window.toast === 'function') window.toast(text);
        if (window.CampistryHaptics) window.CampistryHaptics.notify('success');
    });

    // Signing out should stop this device receiving that account's
    // notifications. Called by the apps' sign-out paths.
    window.campistryPushForget = function () {
        var token = null;
        try { token = localStorage.getItem(LAST_KEY); } catch (_) {}
        if (!token) return;
        var d = db();
        if (d && d.rpc) d.rpc('forget_my_push_token', { p_token: token }).catch(function () {});
        try { localStorage.removeItem(LAST_KEY); } catch (_) {}
    };
})();
