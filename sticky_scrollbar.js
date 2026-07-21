/**
 * sticky_scrollbar.js
 * -----------------------------------------------------------------------------
 * When a wide, horizontally-scrolling container (a big roster table) is taller
 * than the viewport, its own scrollbar sits far below the fold — you have to
 * scroll to the bottom of the table just to scroll it sideways. This pins a
 * proxy horizontal scrollbar to the bottom of the screen whenever such a
 * container is in view and overflowing, and keeps the two in sync both ways.
 *
 * Opt-in per element with class "sticky-x-scroll" or attribute
 * [data-sticky-scroll]; by default every ".me-tw" (Campistry Me tables) is
 * enrolled. Pure DOM, no dependencies, safe to include anywhere.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    var SELECTOR = '.me-tw, .sticky-x-scroll, [data-sticky-scroll]';
    var bar = null;      // the fixed proxy scrollbar element
    var inner = null;    // its inner spacer (drives the scrollbar thumb width)
    var active = null;   // the container the proxy currently mirrors
    var syncing = false; // reentrancy guard between the two scroll listeners

    function ensureBar() {
        if (bar) return;
        bar = document.createElement('div');
        bar.id = '__stickyXScroll';
        bar.style.cssText = [
            'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:1000',
            'overflow-x:auto', 'overflow-y:hidden', 'height:14px',
            'background:rgba(255,255,255,.85)', 'box-shadow:0 -1px 4px rgba(0,0,0,.08)',
            'display:none'
        ].join(';');
        inner = document.createElement('div');
        inner.style.cssText = 'height:1px;';
        bar.appendChild(inner);
        bar.addEventListener('scroll', function () {
            if (syncing || !active) return;
            syncing = true;
            active.scrollLeft = bar.scrollLeft;
            syncing = false;
        });
        document.body.appendChild(bar);
    }

    function hideBar() {
        if (bar) bar.style.display = 'none';
        active = null;
    }

    // Pick the best candidate: an overflowing container whose own scrollbar is
    // below the viewport bottom but whose top is above it (i.e. in view).
    function pick() {
        var candidates = document.querySelectorAll(SELECTOR);
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var best = null;
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.scrollWidth - el.clientWidth < 2) continue;         // not overflowing
            var r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;                 // hidden
            if (r.top > vh || r.bottom < 40) continue;                 // fully off-screen
            if (r.bottom <= vh + 1) continue;                          // own scrollbar already visible
            best = el;                                                 // last in-view wins (usually the one being used)
        }
        return best;
    }

    function update() {
        ensureBar();
        var el = pick();
        if (!el) { hideBar(); return; }
        active = el;
        var r = el.getBoundingClientRect();
        // Match the proxy's width/offset to the container so the thumb lines up.
        bar.style.left = Math.max(0, r.left) + 'px';
        bar.style.right = Math.max(0, (window.innerWidth || document.documentElement.clientWidth) - r.right) + 'px';
        inner.style.width = el.scrollWidth + 'px';
        bar.style.display = 'block';
        syncing = true;
        bar.scrollLeft = el.scrollLeft;
        syncing = false;

        if (!el.__stickyBound) {
            el.__stickyBound = true;
            el.addEventListener('scroll', function () {
                if (syncing || active !== el) return;
                syncing = true;
                bar.scrollLeft = el.scrollLeft;
                syncing = false;
            });
        }
    }

    var raf = null;
    function schedule() {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = null; update(); });
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Tables re-render on data changes — watch the DOM so the bar re-evaluates.
    if (window.MutationObserver) {
        var mo = new MutationObserver(schedule);
        document.addEventListener('DOMContentLoaded', function () {
            mo.observe(document.body, { childList: true, subtree: true });
            schedule();
        });
    }
    if (document.readyState !== 'loading') schedule();
    else document.addEventListener('DOMContentLoaded', schedule);

    window.StickyScrollbar = { refresh: schedule };
})();
