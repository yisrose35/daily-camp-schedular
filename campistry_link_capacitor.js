// Capacitor native-shell glue for Campistry Link (parent portal).
//
// Loaded on every build of campistry_link_parent.html — web and native alike.
// Every branch below is guarded on window.Capacitor.isNativePlatform(), so
// on a plain desktop/mobile browser this file is a complete no-op.
(function() {
    'use strict';
    if (typeof window.Capacitor === 'undefined' || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;

    var Capacitor = window.Capacitor;
    var Plugins = Capacitor.Plugins || {};

    document.addEventListener('DOMContentLoaded', function() {
        // Status bar: opaque, matches the app's light chrome (overlaysWebView
        // is already false via capacitor.config.json, this just sets icon color).
        if (Plugins.StatusBar) {
            Plugins.StatusBar.setStyle({ style: 'LIGHT' }).catch(function() {});
            Plugins.StatusBar.setBackgroundColor({ color: '#FDFCFB' }).catch(function() {});
        }
    });

    // ── Links that leave the bundle ───────────────────────────────────────
    // The app bundles only the portal page, so a relative link to any other
    // page ("Open in Notes →" in the quick-notes widget) would navigate the
    // WebView to a file that isn't there — a dead end with no way back short
    // of force-quitting. External https links (Venmo / PayPal / Cash App
    // payment handoffs) shouldn't hijack the app's own WebView either.
    // Both go to the system browser instead.
    var WEB_ORIGIN = window.__CAMPISTRY_WEB_URL__ || 'https://campistry.org';
    var BUNDLED_PAGES = ['index.html'];
    document.addEventListener('click', function(e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || /^(mailto|tel|sms|blob|data):/i.test(href)) return;

        var url = null;
        if (/^https?:\/\//i.test(href)) {
            url = href;
        } else if (/\.html($|[?#])/i.test(href)) {
            var page = href.replace(/^\.?\//, '').split(/[?#]/)[0];
            if (BUNDLED_PAGES.indexOf(page) !== -1) return;   // in-bundle nav: leave alone
            url = WEB_ORIGIN + '/' + href.replace(/^\.?\//, '');
        } else {
            return;   // file downloads etc. — leave to the WebView delegate
        }
        e.preventDefault();
        if (Plugins.Browser) Plugins.Browser.open({ url: url }).catch(function() {});
    }, true);

    // ── Deep links (parent invite links opened from an email/SMS) ──────────
    // A universal link / app link / custom scheme URL like
    // https://link.campistry.app/invite?token=XXXX or campistrylink://invite?token=XXXX
    // arrives here instead of as a normal window.location.search query string.
    if (Plugins.App && Plugins.App.addListener) {
        Plugins.App.addListener('appUrlOpen', function(data) {
            if (!data || !data.url) return;
            var token = '';
            try { token = new URL(data.url).searchParams.get('invite') || ''; } catch (e) {}
            if (token && typeof window.__handleParentInviteToken === 'function') {
                window.__handleParentInviteToken(token);
            }
        });

        // ── Android hardware back button ────────────────────────────────────
        // Close whatever overlay/drawer is open, else step back through the
        // in-app page history, else let the OS handle it (exits the app —
        // the expected behavior once you're back at Home with nothing open).
        Plugins.App.addListener('backButton', function() {
            var avatarMenu = document.getElementById('avatarMenu');
            if (avatarMenu && avatarMenu.style.display !== 'none' && typeof window.closeAvatarMenu === 'function') {
                window.closeAvatarMenu();
                return;
            }
            var foDrawer = document.getElementById('foDrawer');
            if (foDrawer && foDrawer.classList.contains('open') && typeof window.closeFillOnline === 'function') {
                window.closeFillOnline();
                return;
            }
            var msgCompose = document.getElementById('msgComposeView');
            if (msgCompose && msgCompose.style.display !== 'none' && typeof window.toggleCompose === 'function') {
                window.toggleCompose(false);
                return;
            }
            var msgDetail = document.getElementById('msgDetailView');
            if (msgDetail && msgDetail.style.display !== 'none' && typeof window.closeMsgDetail === 'function') {
                window.closeMsgDetail();
                return;
            }
            var childDetail = document.getElementById('childDetail');
            if (childDetail && childDetail.style.display !== 'none') {
                childDetail.style.display = 'none';
                return;
            }
            if (typeof window.__navBack === 'function' && window.__navBack()) return;
            Plugins.App.exitApp();
        });
    }
})();
