// Live updates (OTA) for the Campistry mobile apps.
//
// Loaded LAST on campistry_lite.html and campistry_link_parent.html, and a
// complete no-op on the web — the plugin only exists inside the native shell.
//
// What this file is for: calling notifyAppReady(). The updater plugin treats a
// freshly-installed bundle as unproven until the web layer says "I booted".
// If that never happens — because the bundle is broken — the plugin reverts to
// the last working bundle on the next launch. That automatic rollback is the
// entire safety net behind shipping updates outside the app stores, so this
// call is load-bearing, not bookkeeping.
//
// It runs at the END of the script chain deliberately. Calling it from <head>
// would mark the bundle healthy before any of the app's code had even parsed,
// which would happily "confirm" a bundle whose main script throws on load.
// Everything it waits on is a local file inside the bundle, so this is fast.
(function () {
    'use strict';
    var C = window.Capacitor;
    if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

    var Updater = (C.Plugins || {}).CapacitorUpdater;
    if (!Updater) return;   // app built before the plugin was added

    Updater.notifyAppReady()
        .then(function (r) {
            var b = r && r.bundle;
            if (b) console.log('[ota] running bundle ' + b.version + ' (' + b.status + ')');
        })
        .catch(function (e) {
            // Documented as never failing; if it somehow does, say so loudly —
            // silent failure here means silent rollback later.
            console.error('[ota] notifyAppReady failed', e);
        });

    // Surfaced for support: window.__otaInfo() in a remote debug session tells
    // you which bundle a phone is actually running, which is the first thing
    // you want to know when one device behaves differently from the others.
    window.__otaInfo = function () {
        return Updater.current().then(function (r) {
            console.log('[ota] current', r);
            return r;
        });
    };

    // Same thing, but plain text for the Settings screen. A device that never
    // picked up a shipped fix is otherwise invisible from here — the app looks
    // identical either way, and "did you close and reopen it" only gets a
    // reliable answer once the running build is something the user can just
    // read off the screen instead of us both guessing at it.
    window.campistryOtaVersion = function () {
        return Updater.current()
            .then(function (r) { return (r && r.bundle && r.bundle.version) || null; })
            .catch(function () { return null; });
    };
})();
