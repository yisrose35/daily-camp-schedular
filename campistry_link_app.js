/* =============================================================================
   campistry_link_app.js — Campistry Link · App Shell
   Turns the parent portal from "a website" into "an app":
     • Service-worker registration (installable PWA, instant repeat loads)
     • History-integrated navigation — Android back gesture / iOS swipe-back
       moves between pages and closes sheets instead of leaving the app
     • "More" bottom sheet for the mobile tab bar
     • Pull-to-refresh
     • Install prompts (Android beforeinstallprompt + iOS add-to-home-screen)
     • Light haptic feedback on navigation taps
   Must load AFTER the inline portal script (needs window.nav & friends).
   ============================================================================= */
(function () {
    'use strict';

    var LinkApp = window.LinkApp = { _layers: [] };

    var standalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    if (standalone) document.documentElement.classList.add('lk-standalone');
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isTouch = window.matchMedia('(hover: none)').matches;

    // ── Service worker ────────────────────────────────────────────────────────
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('link_sw.js').catch(function () {});
        });
    }

    function haptic() {
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
    }

    // ── History-integrated navigation ─────────────────────────────────────────
    // Back gesture pops: open sheet/drawer first, then previous page — the app
    // only exits from Home, like a native app.
    var navCore = window.nav;
    var currentPage = 'home';
    var poppingLayer = false;

    // Pages with their own tab in the bottom bar; everything else lights "More"
    var TAB_PAGES = ['home', 'messages', 'canteen', 'photos'];
    function syncMoreTab(p) {
        var more = document.querySelector('.lk-bnav-item[data-more]');
        if (more) more.classList.toggle('active', TAB_PAGES.indexOf(p) === -1);
    }

    if (typeof navCore === 'function') {
        try { history.replaceState({ lkPage: 'home' }, '', '#home'); } catch (e) {}

        window.nav = function (p) {
            // Leaving a page with layers open — drop their history entries silently
            LinkApp._layers = [];
            navCore(p);
            syncMoreTab(p);
            if (p !== currentPage) {
                currentPage = p;
                try { history.pushState({ lkPage: p }, '', '#' + p); } catch (e) {}
            }
            haptic();
            LinkApp.closeMoreSheet(true);
        };

        window.addEventListener('popstate', function (e) {
            if (LinkApp._layers.length) {
                var close = LinkApp._layers.pop();
                poppingLayer = true;
                try { close(); } catch (err) {}
                poppingLayer = false;
                return;
            }
            var p = (e.state && e.state.lkPage) || 'home';
            currentPage = p;
            navCore(p);
            syncMoreTab(p);
        });
    }

    // A "layer" is anything stacked over the page: detail views, drawers,
    // sheets. Opening pushes a history entry; back (or the X button, which
    // routes through history.back()) closes it.
    LinkApp.pushLayer = function (closeFn) {
        LinkApp._layers.push(closeFn);
        try { history.pushState({ lkLayer: LinkApp._layers.length, lkPage: currentPage }, ''); } catch (e) {}
    };
    LinkApp.popLayer = function (closeFn) {
        if (poppingLayer) { closeFn(); return; }               // already inside popstate
        var i = LinkApp._layers.lastIndexOf(closeFn);
        if (i === -1) { closeFn(); return; }                    // wasn't tracked — just close
        try { history.back(); } catch (e) { LinkApp._layers.splice(i, 1); closeFn(); }
    };

    function wrapLayer(openName, closeName) {
        var open = window[openName], close = window[closeName];
        if (typeof open !== 'function' || typeof close !== 'function') return;
        window[openName] = function () {
            var r = open.apply(this, arguments);
            LinkApp.pushLayer(close);
            return r;
        };
        window[closeName] = function () { LinkApp.popLayer(close); };
    }
    wrapLayer('openMsg', 'closeMsgDetail');
    wrapLayer('openFillOnline', 'closeFillOnline');
    wrapLayer('openTipSheet', 'closeTipSheet');

    // Child detail (its close is an inline style toggle in the HTML)
    if (typeof window.showChild === 'function') {
        var showChildCore = window.showChild;
        var closeChildCore = function () {
            var el = document.getElementById('childDetail');
            if (el) el.style.display = 'none';
        };
        window.showChild = function () {
            var r = showChildCore.apply(this, arguments);
            LinkApp.pushLayer(closeChildCore);
            return r;
        };
        window.lkCloseChildDetail = function () { LinkApp.popLayer(closeChildCore); };
    }

    // ── "More" bottom sheet (mobile tab bar overflow) ─────────────────────────
    var MORE_ITEMS = [
        { p: 'children',  l: 'My Children',     i: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
        { p: 'schedule',  l: 'Schedule',        i: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
        { p: 'forms',     l: 'Forms & Docs',    i: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
        { p: 'lists',     l: 'Lists',           i: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><polyline points="3 6 4 7 6 5"/><polyline points="3 12 4 13 6 11"/><polyline points="3 18 4 19 6 17"/>' },
        { p: 'mail',      l: 'Camper Mail',     i: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
        { p: 'pickup',    l: 'Pickup & Arrival',i: '<path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3"/><rect x="9" y="11" width="14" height="10" rx="2"/><circle cx="12" cy="16" r="1"/>' },
        { p: 'tips',      l: 'Tips',            i: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><line x1="12" y1="6" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="18"/>' },
        { p: 'payments',  l: 'Payments',        i: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>' },
        { p: 'health',    l: 'Health',          i: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
        { p: 'emergency', l: 'Emergency',       i: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
        { p: 'settings',  l: 'Settings',        i: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' }
    ];

    function buildMoreSheet() {
        var bd = document.createElement('div');
        bd.className = 'lk-sheet-backdrop';
        bd.id = 'lkMoreBackdrop';
        bd.onclick = function () { LinkApp.closeMoreSheet(); };
        var sh = document.createElement('div');
        sh.className = 'lk-sheet';
        sh.id = 'lkMoreSheet';
        var grid = MORE_ITEMS.map(function (m) {
            return '<button class="lk-sheet-item" data-page="' + m.p + '" onclick="nav(\'' + m.p + '\')">' +
                '<div class="lk-sheet-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + m.i + '</svg></div>' +
                '<span>' + m.l + '</span></button>';
        }).join('');
        sh.innerHTML = '<div class="lk-sheet-grab"></div><div class="lk-sheet-title">All of Link</div><div class="lk-sheet-grid">' + grid + '</div>';
        document.body.appendChild(bd);
        document.body.appendChild(sh);
    }

    var moreCloseFn = function () {
        var bd = document.getElementById('lkMoreBackdrop');
        var sh = document.getElementById('lkMoreSheet');
        if (bd) bd.classList.remove('open');
        if (sh) sh.classList.remove('open');
        var mb = document.querySelector('.lk-bnav-item[data-more]');
        if (mb) mb.classList.remove('active');
    };
    LinkApp.openMoreSheet = function () {
        var bd = document.getElementById('lkMoreBackdrop');
        var sh = document.getElementById('lkMoreSheet');
        if (!bd || !sh) return;
        haptic();
        bd.classList.add('open');
        sh.classList.add('open');
        var mb = document.querySelector('.lk-bnav-item[data-more]');
        if (mb) mb.classList.add('active');
        LinkApp.pushLayer(moreCloseFn);
    };
    LinkApp.closeMoreSheet = function (silent) {
        var sh = document.getElementById('lkMoreSheet');
        if (!sh || !sh.classList.contains('open')) return;
        if (silent) {
            // nav() already ate the layer stack — just hide, keep history as-is
            moreCloseFn();
            var i = LinkApp._layers.indexOf(moreCloseFn);
            if (i !== -1) LinkApp._layers.splice(i, 1);
            return;
        }
        LinkApp.popLayer(moreCloseFn);
    };

    // ── Pull-to-refresh (touch devices, at top of page) ───────────────────────
    function buildPTR() {
        var el = document.createElement('div');
        el.className = 'lk-ptr';
        el.id = 'lkPtr';
        el.innerHTML = '<div class="lk-ptr-spinner"></div>';
        document.body.appendChild(el);

        var startY = 0, pulling = false, pull = 0, READY_AT = 64;
        document.addEventListener('touchstart', function (e) {
            if (window.scrollY > 0) return;
            if (document.querySelector('.lk-sheet.open, .fo-drawer.open, .lk-overlay.open')) return;
            if (document.getElementById('parentAuthOverlay') &&
                document.getElementById('parentAuthOverlay').style.display === 'flex') return;
            startY = e.touches[0].clientY;
            pulling = true;
            pull = 0;
        }, { passive: true });
        document.addEventListener('touchmove', function (e) {
            if (!pulling) return;
            var dist = e.touches[0].clientY - startY;
            if (dist <= 0 || window.scrollY > 0) { pull = 0; el.style.setProperty('--pull', '0px'); el.classList.remove('ready'); return; }
            pull = Math.min(dist * 0.45, 96); // rubber-band resistance
            el.style.setProperty('--pull', pull + 'px');
            el.classList.toggle('ready', pull >= READY_AT);
        }, { passive: true });
        document.addEventListener('touchend', function () {
            if (!pulling) return;
            pulling = false;
            if (pull >= READY_AT && window.scrollY <= 0) {
                el.classList.add('refreshing');
                haptic();
                setTimeout(function () { location.reload(); }, 350);
            } else {
                el.style.setProperty('--pull', '0px');
                el.classList.remove('ready');
            }
        }, { passive: true });
    }

    // ── Install prompts ───────────────────────────────────────────────────────
    var DISMISS_KEY = 'lk_install_dismissed_v1';
    var deferredPrompt = null;

    function dismissed() {
        try { return !!localStorage.getItem(DISMISS_KEY); } catch (e) { return true; }
    }
    function showInstallBanner(html, onAction) {
        if (standalone || dismissed()) return;
        var b = document.createElement('div');
        b.className = 'lk-install-banner';
        b.id = 'lkInstallBanner';
        b.innerHTML =
            '<img src="link_icon_192.png" alt="" class="lk-install-icon">' +
            '<div class="lk-install-text">' + html + '</div>' +
            (onAction ? '<button class="lk-install-btn" id="lkInstallGo">Install</button>' : '') +
            '<button class="lk-install-x" id="lkInstallX" aria-label="Dismiss">✕</button>';
        document.body.appendChild(b);
        requestAnimationFrame(function () { b.classList.add('show'); });
        document.getElementById('lkInstallX').onclick = function () {
            b.classList.remove('show');
            setTimeout(function () { b.remove(); }, 300);
            try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
        };
        if (onAction) document.getElementById('lkInstallGo').onclick = function () {
            onAction();
            b.classList.remove('show');
            setTimeout(function () { b.remove(); }, 300);
        };
    }

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        setTimeout(function () {
            showInstallBanner('<strong>Get the Link app</strong><span>Add to your home screen for the full experience</span>', function () {
                if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
            });
        }, 6000);
    });

    if (isIOS && !standalone && isTouch) {
        // iOS has no install event — show a one-time hint
        setTimeout(function () {
            showInstallBanner('<strong>Get the Link app</strong><span>Tap <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> then &ldquo;Add to Home Screen&rdquo;</span>', null);
        }, 6000);
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    buildMoreSheet();
    if (isTouch) buildPTR();
})();
