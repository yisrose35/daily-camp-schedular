// =============================================================================
// campistry_access_sections.js — enforce per-section access in the browser
//
// Loads the caller's access (get_my_access, migration 048), resolves levels
// against the shared registry (campistry_capabilities.js), and then:
//
//   1. hides nav entries for sections at 'none'
//   2. blocks the section body if one is opened anyway (deep link, stale tab)
//   3. marks 'view' sections read-only, disabling their write controls
//   4. exposes Sections.can/canEdit/requireEdit for code-level gates
//   5. scrubs restricted data out of the cached app blob, and preserves it on
//      save so a restricted user can't overwrite what they can't see
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW A PAGE OPTS IN
//
//   <script>window.__CAMPISTRY_PRODUCT__ = 'me';</script>
//   <script src="campistry_capabilities.js"></script>
//   <script src="campistry_access_sections.js"></script>
//
// The product key tells us which app's sections to gate. Nav entries are found
// by the attributes the pages already use — [data-page] and [data-tab] — so no
// markup had to be renamed to make this work.
//
// ─────────────────────────────────────────────────────────────────────────────
// FAIL OPEN, DELIBERATELY
//
// Every failure path here grants access rather than denying it, matching
// product_access_guard.js. A network blip, a missing RPC (migration not yet
// applied), an unresolvable membership — none of those should lock a
// legitimate head counselor out of the schedule mid-morning. RLS and role
// checks remain the real security boundary; this layer is about showing people
// the right thing.
//
// The one exception is an explicit 'none' from a resolved access record. That
// is a decision someone made, and it is honoured.
// =============================================================================
(function () {
    'use strict';

    var PRODUCT = window.__CAMPISTRY_PRODUCT__ ||
        (document.currentScript && document.currentScript.getAttribute('data-product'));

    var S = {};
    var _access = null;         // { role, products, preset, overrides }
    var _levels = null;         // capability key -> level
    var _ready = false;
    var _unrestricted = true;   // until proven otherwise
    var _listeners = [];

    function CAPS() { return window.CampistryCapabilities || null; }

    // ── resolution ───────────────────────────────────────────────────────────

    /** Level for a capability. Accepts 'billing' (this app) or 'me.billing'. */
    S.level = function (key) {
        if (_unrestricted || !_levels) return 'edit';
        var full = key.indexOf('.') >= 0 ? key : (PRODUCT + '.' + key);
        var lvl = _levels[full];
        // Not in the registry at all -> not a section we gate. Allow it rather
        // than blocking a page we simply haven't catalogued.
        return lvl === undefined ? 'edit' : lvl;
    };
    S.can = function (key) { return S.level(key) !== 'none'; };
    S.canEdit = function (key) { return S.level(key) === 'edit'; };
    S.isReady = function () { return _ready; };
    S.isUnrestricted = function () { return _unrestricted; };
    S.getAccess = function () { return _access; };

    /**
     * Guard for a write action. Returns true when allowed; otherwise tells the
     * user why and returns false, so callers read as:
     *     if (!Sections.requireEdit('billing')) return;
     */
    S.requireEdit = function (key, whatFor) {
        if (S.canEdit(key)) return true;
        var cap = CAPS() && CAPS().get(key.indexOf('.') >= 0 ? key : PRODUCT + '.' + key);
        var name = (cap && cap.label) || 'this section';
        var msg = S.level(key) === 'none'
            ? 'You don\'t have access to ' + name + '.'
            : 'You have view-only access to ' + name + (whatFor ? ' — ' + whatFor + ' needs edit access.' : '.');
        toast(msg);
        return false;
    };

    S.onReady = function (fn) {
        if (_ready) { try { fn(S); } catch (e) {} return; }
        _listeners.push(fn);
    };

    function toast(msg) {
        var fn = window.showToast || window.toast;
        if (typeof fn === 'function') { try { fn(msg, 'warning'); return; } catch (e) {} }
        console.warn('[Access]', msg);
    }

    // ── loading ──────────────────────────────────────────────────────────────

    function db() {
        var d = window.CampistryDB;
        return {
            client: d && d.getClient && d.getClient(),
            campId: d && d.getCampId && d.getCampId()
        };
    }

    function load() {
        var h = db();
        if (!h.client || !h.campId) return Promise.resolve(null);
        try {
            return h.client.rpc('get_my_access', { p_camp_id: h.campId }).then(function (res) {
                if (res.error || !res.data) return null;
                return res.data;
            }, function () { return null; });
        } catch (e) { return Promise.resolve(null); }
    }

    function apply(data) {
        var C = CAPS();
        if (!data || !data.success || !C) { finish(); return; }

        if (data.unrestricted) { finish(); return; }

        _access = {
            role: data.role,
            // An empty products array from the RPC means "not restricted by
            // product", not "no products" — passing [] to the resolver would
            // deny every app.
            products: (Array.isArray(data.products) && data.products.length) ? data.products : null,
            preset: data.preset || null,
            overrides: data.overrides || {}
        };

        if (C.isUnconfigured(_access)) { finish(); return; }   // legacy full access

        _levels = C.resolveAll(_access);
        _unrestricted = false;
        finish();
    }

    function finish() {
        _ready = true;
        if (!_unrestricted) {
            gateNav();
            gateOpenSection();
            watchNav();
        }
        document.documentElement.setAttribute('data-access-ready', '1');
        _listeners.forEach(function (fn) { try { fn(S); } catch (e) {} });
        _listeners = [];
        try {
            window.dispatchEvent(new CustomEvent('campistry-access-ready', { detail: { sections: S } }));
        } catch (e) {}
    }

    // ── DOM gating ───────────────────────────────────────────────────────────

    function navNodes() {
        return Array.prototype.slice.call(
            document.querySelectorAll('[data-page],[data-tab]')
        ).filter(function (n) {
            // Only nav controls, not the panes they reveal.
            return !/(^|\s)(tab-content|snacks-page|me-page|lk-page)(\s|$)/.test(n.className || '');
        });
    }

    function sectionOf(node) {
        return node.getAttribute('data-page') || node.getAttribute('data-tab') || '';
    }

    function gateNav() {
        navNodes().forEach(function (n) {
            var sec = sectionOf(n);
            if (!sec) return;
            var lvl = S.level(sec);
            if (lvl === 'none') {
                n.style.display = 'none';
                n.setAttribute('data-access-hidden', '1');
            } else if (lvl === 'view') {
                n.setAttribute('data-access-view', '1');
            }
        });
        // Hide a nav group label whose every entry is now gone, so the sidebar
        // doesn't show a heading with nothing under it.
        ['.sidebar-label', '.lk-nav-label', '.nav-label'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (label) {
                var any = false, n = label.nextElementSibling;
                while (n && !n.matches(sel)) {
                    if ((n.hasAttribute('data-page') || n.hasAttribute('data-tab')) &&
                        n.style.display !== 'none') { any = true; break; }
                    n = n.nextElementSibling;
                }
                if (!any) label.style.display = 'none';
            });
        });
    }

    var PANE_SELECTORS = ['.tab-content', '.snacks-page', '.me-page', '.lk-page'];

    function paneFor(section) {
        return document.getElementById('page-' + section) ||
               document.getElementById('tab-' + section) ||
               document.querySelector('[data-section-pane="' + section + '"]');
    }

    function blockedHtml(cap) {
        var name = (cap && cap.label) || 'this section';
        return '<div style="max-width:460px;margin:56px auto;text-align:center;padding:32px 26px;' +
            'background:#fff;border:1px solid #E2E8F0;border-radius:16px;">' +
            '<div style="width:46px;height:46px;border-radius:50%;background:#FEF2F2;color:#DC2626;' +
            'display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">' +
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
            '<h2 style="font-size:1.05rem;font-weight:700;color:#0F172A;margin:0 0 7px;">' +
            'No access to ' + esc(name) + '</h2>' +
            '<p style="font-size:.86rem;color:#64748B;line-height:1.55;margin:0;">' +
            'Your account isn\'t set up to open this section. The camp owner can change that in ' +
            'Staff &amp; Access.</p></div>';
    }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : s;
        return d.innerHTML;
    }

    /**
     * If a blocked section is the one currently showing — a deep link, a
     * restored tab, or markup that starts with it active — replace its body and
     * move the user somewhere they're allowed.
     */
    function gateOpenSection() {
        var C = CAPS();
        PANE_SELECTORS.forEach(function (sel) {
            document.querySelectorAll(sel + '.active').forEach(function (pane) {
                var id = (pane.id || '').replace(/^(page|tab)-/, '');
                if (!id || S.level(id) !== 'none') return;
                pane.innerHTML = blockedHtml(C && C.get(PRODUCT + '.' + id));
                var first = firstAllowedNav();
                if (first) first.click();
            });
        });
        markViewOnlyPanes();
    }

    function firstAllowedNav() {
        return navNodes().filter(function (n) {
            return n.style.display !== 'none' && S.level(sectionOf(n)) !== 'none' &&
                   (n.tagName === 'BUTTON' || n.tagName === 'A');
        })[0] || null;
    }

    // ── read-only enforcement ────────────────────────────────────────────────
    //
    // A 'view' section has to stay READABLE while refusing every write. That
    // rules out a blanket click blocker: clicking a table row to look at a
    // camper is exactly what view access is for.
    //
    // So the rule is deny-by-default on form controls, with a safe list for the
    // things that only read. Over-disabling a filter is a small annoyance;
    // leaving a Save button live in a read-only section is the bug this exists
    // to prevent, so the balance leans to disabling.
    var SAFE_RE = /search|filter|find|print|export|download|csv|pdf|close|cancel|back|refresh|reload|copy|sort|toggle|expand|collapse|tab|next|prev|page|zoom|logout|sign out/i;

    function isSafeControl(el) {
        if (el.hasAttribute('data-access-safe')) return true;
        if (el.hasAttribute('data-page') || el.hasAttribute('data-tab')) return true;
        if (el.type === 'search') return true;
        if (el.closest('.access-ro-banner')) return true;
        // Nav and chrome outside the section body.
        if (el.closest('.sidebar, .app-header, .lk-nav, .snacks-bnav, .lk-bnav, .ops-tabs, .lk-tabs, .tabs')) return true;
        var hay = [
            el.id, el.className, el.name,
            el.getAttribute('placeholder'), el.getAttribute('aria-label'),
            el.getAttribute('title'), (el.textContent || '').slice(0, 40)
        ].join(' ');
        return SAFE_RE.test(hay);
    }

    var RO_TITLE = 'View only — you don\'t have edit access to this section.';

    function disableWithin(root) {
        root.querySelectorAll('button, input, select, textarea, [contenteditable="true"]').forEach(function (el) {
            if (el.hasAttribute('data-access-locked')) return;
            if (isSafeControl(el)) return;
            el.setAttribute('data-access-locked', '1');
            if (el.getAttribute('contenteditable') === 'true') {
                el.setAttribute('contenteditable', 'false');
            } else {
                el.disabled = true;
            }
            el.style.opacity = '0.5';
            el.style.cursor = 'not-allowed';
            if (!el.title) el.title = RO_TITLE;
        });
    }

    /** The section currently on screen, or '' if none is. */
    function activeSection() {
        for (var i = 0; i < PANE_SELECTORS.length; i++) {
            var pane = document.querySelector(PANE_SELECTORS[i] + '.active');
            if (pane && pane.id) return pane.id.replace(/^(page|tab)-/, '');
        }
        return '';
    }

    function markViewOnlyPanes() {
        PANE_SELECTORS.forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (pane) {
                var id = (pane.id || '').replace(/^(page|tab)-/, '');
                if (!id || S.level(id) !== 'view') return;
                pane.setAttribute('data-access-readonly', '1');
                if (!pane.querySelector('.access-ro-banner')) {
                    var b = document.createElement('div');
                    b.className = 'access-ro-banner';
                    b.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 13px;margin-bottom:14px;' +
                        'background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;' +
                        'font-size:.79rem;color:#92400E;';
                    b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                        'stroke-width="2" style="flex-shrink:0"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
                        '<circle cx="12" cy="12" r="3"/></svg><span>View only — you can read this section but not change it.</span>';
                    pane.insertBefore(b, pane.firstChild);
                }
                disableWithin(pane);
            });
        });

        // Modals are appended to <body>, not into the pane, so a pane-scoped
        // sweep misses them entirely — and a row click in a view-only list
        // opens exactly such a modal with a live Save button. Lock any open
        // overlay while the section on screen is view-only.
        var sec = activeSection();
        if (sec && S.level(sec) === 'view') {
            document.querySelectorAll(
                '.modal-overlay, .ops-overlay, .me-overlay, .lk-overlay, [role="dialog"]'
            ).forEach(function (ov) {
                var shown = ov.classList.contains('open') || ov.classList.contains('active') ||
                            (ov.style.display && ov.style.display !== 'none');
                if (shown) disableWithin(ov);
            });
        }
    }

    /**
     * Pages re-render their panes constantly, which wipes the banner and
     * re-enables controls. Re-apply after nav clicks and on mutations rather
     * than assuming one pass holds.
     */
    function watchNav() {
        document.addEventListener('click', function (e) {
            var n = e.target && e.target.closest && e.target.closest('[data-page],[data-tab]');
            if (!n) return;
            var sec = sectionOf(n);
            if (sec && S.level(sec) === 'none') {
                e.preventDefault(); e.stopPropagation();
                toast('You don\'t have access to that section.');
                return;
            }
            setTimeout(function () { gateOpenSection(); }, 60);
        }, true);

        try {
            var mo = new MutationObserver(function () {
                clearTimeout(mo._t);
                mo._t = setTimeout(markViewOnlyPanes, 150);
            });
            mo.observe(document.body, { childList: true, subtree: true });
        } catch (e) {}
    }

    /**
     * Whole-page guard, for a section that lives on its own page rather than as
     * a pane — the POS terminal is one. Blocks the page at 'none' and locks its
     * controls at 'view'.
     *
     * Declared on the page as:
     *   <script src="campistry_access_sections.js" data-guard-section="pos"></script>
     */
    S.guardPage = function (section) {
        S.onReady(function () {
            var lvl = S.level(section);
            if (lvl === 'edit') return;
            var C = CAPS();
            var cap = C && C.get(PRODUCT + '.' + section);
            if (lvl === 'none') {
                document.documentElement.style.overflow = 'hidden';
                var o = document.createElement('div');
                o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#F8FAFC;' +
                    'display:flex;align-items:center;justify-content:center;padding:24px;' +
                    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
                o.innerHTML = blockedHtml(cap) +
                    '<style>.access-page-home{display:block;margin-top:16px;color:#4F46E5;font-weight:600;}</style>';
                (document.body || document.documentElement).appendChild(o);
            } else {
                // view: lock every write control on the page.
                disableWithin(document.body);
                var b = document.createElement('div');
                b.className = 'access-ro-banner';
                b.style.cssText = 'position:sticky;top:0;z-index:9999;display:flex;align-items:center;gap:8px;' +
                    'padding:9px 14px;background:#FFFBEB;border-bottom:1px solid #FDE68A;' +
                    'font-size:.8rem;color:#92400E;';
                b.textContent = 'View only — you can read ' +
                    ((cap && cap.label) || 'this page') + ' but not change it.';
                if (document.body.firstChild) document.body.insertBefore(b, document.body.firstChild);
            }
        });
    };

    // ── data scrub + save preservation ───────────────────────────────────────
    //
    // Several apps hydrate ONE blob per app from camp_state_kv, so data for a
    // hidden section arrives alongside data for a visible one. Two consequences,
    // both handled here:
    //
    //   scrub    — drop restricted branches from the cached copy, so the data
    //              isn't sitting in localStorage/IDB on that person's laptop
    //   preserve — on save, put the untouched branches back from the pre-scrub
    //              snapshot, so a restricted user's save can't blank out the
    //              billing they never saw
    //
    // The map below is the only place that knows which storage branch belongs
    // to which capability. Anything not listed is simply not scrubbed.

    var BRANCHES = {
        'me.billing':  [['campistryMe', 'families'], ['campistryMe', 'payments']],
        'me.payroll':  [['campistryMe', 'payroll'], ['campistryMe', 'youthCorps']],
        'me.analytics': [['campistryMe', 'finExpenses'], ['campistryMe', 'finPayments']],
        'snacks.accounts': [['campistrySnacks', 'accounts']],
        'link.tips':   [['campistryLink', 'tips']]
    };

    var _preserved = null;

    S.scrubSettings = function (gs) {
        if (_unrestricted || !gs) return gs;
        _preserved = _preserved || {};
        Object.keys(BRANCHES).forEach(function (capKey) {
            if (S.level(capKey) !== 'none') return;
            BRANCHES[capKey].forEach(function (path) {
                var parent = gs[path[0]];
                if (!parent || typeof parent !== 'object') return;
                if (Object.prototype.hasOwnProperty.call(parent, path[1])) {
                    _preserved[path.join('.')] = parent[path[1]];
                    delete parent[path[1]];
                }
            });
        });
        return gs;
    };

    /** Put back what we scrubbed, so a save doesn't blank it. */
    S.preserveOnSave = function (gs) {
        if (_unrestricted || !gs || !_preserved) return gs;
        Object.keys(_preserved).forEach(function (flat) {
            var path = flat.split('.');
            if (!gs[path[0]] || typeof gs[path[0]] !== 'object') gs[path[0]] = {};
            gs[path[0]][path[1]] = _preserved[flat];
        });
        return gs;
    };

    // ── boot ─────────────────────────────────────────────────────────────────

    function boot() {
        if (!PRODUCT) { finish(); return; }
        var tries = 0;
        (function poll() {
            var h = db();
            if (h.client && typeof h.client.rpc === 'function' && h.campId) {
                load().then(apply, function () { finish(); });
                return;
            }
            if (++tries > 60) { finish(); return; }   // ~15s then fail open
            setTimeout(poll, 250);
        })();
    }

    // A page can declare the single section it IS, rather than hosting panes.
    var GUARD = document.currentScript && document.currentScript.getAttribute('data-guard-section');

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    if (GUARD) S.guardPage(GUARD);

    window.CampistrySections = S;
})();
