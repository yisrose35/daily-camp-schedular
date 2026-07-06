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
