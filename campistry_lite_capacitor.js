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

    // Biometrics on native lives in campistry_bio_native.js now, shared with
    // Campistry Link so both apps get the same bridge from one implementation.
})();
