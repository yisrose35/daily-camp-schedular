// Haptics, shared by Campistry Lite and Campistry Link.
//
// Two jobs:
//   1. One way to ask for a tap, that works natively and on the web, and that
//      respects the user's preference in a single place.
//   2. Wiring it through the whole app WITHOUT sprinkling a call into every
//      button. A delegated pointerdown listener covers anything that behaves
//      like a control, so new screens get it for free and nobody has to
//      remember.
//
// The preference is namespaced per app, so turning it off in Lite doesn't turn
// it off in Link. Default is ON: a tap you didn't ask for is a much smaller
// annoyance than a dead-feeling app, and it's one toggle away in Settings.
(function () {
    'use strict';

    var NS  = window.__CAMPISTRY_NS || window.__CAMPISTRY_BIO_NS || 'lite';
    var KEY = NS + '_haptics';

    function on() {
        try { return localStorage.getItem(KEY) !== '0'; } catch (_) { return true; }
    }
    function setOn(v) {
        try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) {}
        if (v) fire('light');   // confirm the change in the medium being changed
    }

    function plugin() {
        var C = window.Capacitor;
        if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
        return (C.Plugins || {}).Haptics || null;
    }

    // Native taps are a real actuator and feel like the OS; navigator.vibrate is
    // a blunt buzz and is all the web can offer. Both are better than nothing.
    function fire(style) {
        if (!on()) return;
        var H = plugin();
        if (H) {
            var s = String(style || 'light').toUpperCase();
            if (s === 'SELECTION' && H.selectionChanged) { H.selectionChanged().catch(function () {}); return; }
            if (H.impact) { H.impact({ style: s === 'SELECTION' ? 'LIGHT' : s }).catch(function () {}); return; }
        }
        try {
            if (navigator.vibrate) navigator.vibrate(style === 'medium' ? 14 : style === 'heavy' ? 20 : 8);
        } catch (_) {}
    }

    window.CampistryHaptics = {
        enabled: on,
        setEnabled: setOn,
        tap: function () { fire('light'); },
        impact: fire,
        selection: function () { fire('selection'); },
        // A short double pulse for "that worked" / "that didn't".
        notify: function (kind) {
            if (!on()) return;
            var H = plugin();
            if (H && H.notification) { H.notification({ type: (kind || 'success').toUpperCase() }).catch(function () {}); return; }
            try { if (navigator.vibrate) navigator.vibrate(kind === 'error' ? [12, 60, 12] : [8, 40, 8]); } catch (_) {}
        }
    };

    // ── Delegated wiring ─────────────────────────────────────────────────────
    // pointerdown, not click: the tap should land when the finger lands, which
    // is what makes it feel like the surface responded rather than the app.
    // Anything opting out can carry data-nohaptic.
    var SELECTOR = [
        'button', '[role="button"]', 'a[href]', 'label.lite-switch', 'input[type="checkbox"]',
        '.lite-tab', '.lite-menu-item', '.lite-home-tile', '.lite-seg-btn',
        '.lk-nav-item', '.lk-bnav-item', '.lk-home-tile', '.lk-tab', '.lk-fab'
    ].join(',');

    document.addEventListener('pointerdown', function (e) {
        var el = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
        if (!el || el.disabled || el.closest('[data-nohaptic]')) return;
        fire('light');
    }, true);
})();
