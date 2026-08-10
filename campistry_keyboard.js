// Keeps the focused field visible when the on-screen keyboard opens.
//
// The problem it solves: on Android the WebView is resized when the keyboard
// appears, and the browser's own "scroll the focused element into view" runs
// against the OLD viewport height. A field near the middle or bottom of a long
// form — the message composer, camper mail — ends up under the keyboard or
// shoved off the top. The page looks like it jumped and the box you were typing
// in is cut off.
//
// Shared by Campistry Lite and Campistry Link. Web-safe: without the Capacitor
// Keyboard plugin it falls back to VisualViewport, which real mobile browsers
// support, and does nothing at all on a desktop.
(function () {
    'use strict';

    var FIELD = 'input, textarea, select, [contenteditable="true"]';

    function focused() {
        var el = document.activeElement;
        return el && el.matches && el.matches(FIELD) ? el : null;
    }

    // Centre it rather than merely bringing it on-screen: a field flush against
    // the top of the keyboard is technically visible and horrible to type in.
    function reveal(el, keyboardH) {
        if (!el) return;
        var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        var usable = vh - (keyboardH || 0);
        var r = el.getBoundingClientRect();
        var target = usable / 2 - r.height / 2;
        var delta = r.top - target;
        if (Math.abs(delta) < 24) return;              // already comfortable
        var sc = scrollParent(el);
        if (sc === document.scrollingElement || sc === document.body) {
            window.scrollBy({ top: delta, behavior: 'smooth' });
        } else {
            sc.scrollTop += delta;
        }
    }

    function scrollParent(el) {
        var p = el.parentElement;
        while (p && p !== document.body) {
            var s = getComputedStyle(p);
            if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
            p = p.parentElement;
        }
        return document.scrollingElement || document.body;
    }

    var C = window.Capacitor;
    var native = !!(C && C.isNativePlatform && C.isNativePlatform());
    var KB = native ? (C.Plugins || {}).Keyboard : null;

    if (KB && KB.addListener) {
        // The only reliable signal for how tall the keyboard actually is.
        KB.addListener('keyboardDidShow', function (info) {
            reveal(focused(), (info && info.keyboardHeight) || 0);
        });
        // Some Android keyboards resize again after the first event (emoji row,
        // suggestion strip), so re-check once the dust settles.
        KB.addListener('keyboardWillShow', function (info) {
            setTimeout(function () { reveal(focused(), (info && info.keyboardHeight) || 0); }, 180);
        });
    } else if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', function () {
            var hidden = window.innerHeight - window.visualViewport.height;
            if (hidden > 120) setTimeout(function () { reveal(focused(), 0); }, 60);
        });
    }

    // Focusing a field while the keyboard is already open fires no resize at
    // all, so handle that case directly.
    document.addEventListener('focusin', function (e) {
        if (!e.target || !e.target.matches || !e.target.matches(FIELD)) return;
        setTimeout(function () { reveal(e.target, 0); }, 260);
    });
})();
