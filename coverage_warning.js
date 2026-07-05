/* coverage_warning.js
 * ---------------------------------------------------------------------------
 * Dismissable post-generation "coverage warning" widget.
 *
 * Listens for the `campistry-coverage-gaps` event (dispatched by
 * scheduler_core_auto.js after a generation completes) and shows the user a
 * heads-up of which bunks did NOT receive a configured custom-layer activity
 * (e.g. a "connect-to-swim" Water Slide that couldn't find an open adjacent
 * slot within the sharing capacity), along with the reason for each.
 *
 * UX (matches the requested behavior):
 *   • Heads-up CHIP appears first (collapsed) — non-intrusive.
 *   • Click the chip → it OPENS into a panel listing the reasons per bunk.
 *   • "–" collapses the panel back to the chip   (hidden).
 *   • "×" dismisses the warning entirely for this session (x out).
 *   • A generation with zero gaps removes the widget automatically.
 *
 * Self-contained: vanilla JS, injects its own <style>, no app-CSS dependency.
 * ---------------------------------------------------------------------------
 */
(function () {
    if (window.__coverageWarningInit) return;
    window.__coverageWarningInit = true;

    var WRAP_ID = 'campistry-coverage-warn';
    var STYLE_ID = 'campistry-coverage-warn-style';
    var _items = [];     // [{bunk, grade, activity, reason}]
    var _open = false;   // false = chip (collapsed) · true = panel (expanded)

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var css = '' +
        '#' + WRAP_ID + '{position:fixed;right:16px;bottom:16px;z-index:99999;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
        '#' + WRAP_ID + ' *{box-sizing:border-box;}' +
        '#' + WRAP_ID + ' .cw-chip{display:inline-flex;align-items:center;gap:8px;cursor:pointer;' +
            'background:#fffbeb;border:1px solid #f59e0b;color:#92400e;border-radius:9999px;' +
            'padding:8px 14px;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.12);' +
            'user-select:none;transition:background .12s;}' +
        '#' + WRAP_ID + ' .cw-chip:hover{background:#fef3c7;}' +
        '#' + WRAP_ID + ' .cw-chip .cw-caret{opacity:.7;font-size:11px;}' +
        '#' + WRAP_ID + ' .cw-panel{background:#fff;border:1px solid #e5e7eb;border-radius:12px;' +
            'box-shadow:0 10px 30px rgba(0,0,0,.18);overflow:hidden;width:380px;max-width:90vw;}' +
        '#' + WRAP_ID + ' .cw-head{display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;}' +
        '#' + WRAP_ID + ' .cw-head .cw-title{font-size:13px;font-weight:700;flex:1;}' +
        '#' + WRAP_ID + ' .cw-head button{border:none;background:transparent;cursor:pointer;' +
            'color:#92400e;font-size:18px;line-height:1;padding:0 6px;border-radius:6px;}' +
        '#' + WRAP_ID + ' .cw-head button:hover{background:#fde68a;}' +
        '#' + WRAP_ID + ' .cw-body{max-height:320px;overflow:auto;padding:4px 0 2px;}' +
        '#' + WRAP_ID + ' .cw-act{padding:8px 12px 2px;font-size:12.5px;font-weight:700;color:#111827;}' +
        '#' + WRAP_ID + ' .cw-act .cw-count{font-weight:600;color:#6b7280;}' +
        '#' + WRAP_ID + ' .cw-reason{padding:2px 12px 8px;}' +
        '#' + WRAP_ID + ' .cw-bunks{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;}' +
        '#' + WRAP_ID + ' .cw-sugg-label{font-size:11px;font-weight:700;color:#92400e;margin:2px 0 3px;}' +
        '#' + WRAP_ID + ' .cw-sugg{margin:0;padding-left:16px;}' +
        '#' + WRAP_ID + ' .cw-sugg li{font-size:11.5px;color:#4b5563;line-height:1.4;margin-bottom:3px;}' +
        '#' + WRAP_ID + ' .cw-bunk{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;' +
            'padding:2px 7px;font-size:11.5px;color:#374151;}' +
        '#' + WRAP_ID + ' .cw-foot{padding:8px 12px;border-top:1px solid #f3f4f6;font-size:11px;color:#9ca3af;}';
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    function esc(s) { return window.CampUtils.escapeHtml(s); }  // → campistry_utils.js (canonical)

    function chipLabel() {
        var acts = {};
        _items.forEach(function (it) { acts[it.activity || 'Custom'] = 1; });
        var actNames = Object.keys(acts);
        var n = _items.length;
        if (actNames.length === 1) {
            return n + (n === 1 ? ' bunk didn’t get ' : ' bunks didn’t get ') + actNames[0];
        }
        return n + ' coverage gap' + (n === 1 ? '' : 's');
    }

    function buildBody() {
        // group: activity → suggestion-set → [bunks in Me order]
        var byAct = {};
        _items.forEach(function (it) {
            var a = it.activity || 'Custom';
            if (!byAct[a]) byAct[a] = { count: 0, groups: {}, order: [] };
            byAct[a].count++;
            var sugg = Array.isArray(it.suggestions) ? it.suggestions : (it.reason ? [it.reason] : []);
            var key = sugg.join(' ||| ');
            if (!byAct[a].groups[key]) { byAct[a].groups[key] = { suggestions: sugg, bunks: [] }; byAct[a].order.push(key); }
            var label = it.grade ? (it.bunk + ' (' + it.grade + ')') : String(it.bunk);
            byAct[a].groups[key].bunks.push({ label: label, order: (typeof it.order === 'number' ? it.order : 1e9) });
        });
        var html = '';
        Object.keys(byAct).forEach(function (a) {
            var grp = byAct[a];
            html += '<div class="cw-act">' + esc(a) +
                ' <span class="cw-count">· ' + grp.count + ' bunk' + (grp.count === 1 ? '' : 's') + '</span></div>';
            grp.order.forEach(function (key) {
                var g = grp.groups[key];
                g.bunks.sort(function (x, y) { return x.order - y.order; }); // Me-page order
                html += '<div class="cw-reason"><div class="cw-bunks">';
                g.bunks.forEach(function (b) { html += '<span class="cw-bunk">' + esc(b.label) + '</span>'; });
                html += '</div>';
                if (g.suggestions && g.suggestions.length) {
                    html += '<div class="cw-sugg-label">Try:</div><ul class="cw-sugg">';
                    g.suggestions.forEach(function (s) { html += '<li>' + esc(s) + '</li>'; });
                    html += '</ul>';
                }
                html += '</div>';
            });
        });
        return html;
    }

    function render() {
        var wrap = document.getElementById(WRAP_ID);
        if (!_items.length) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); return; }
        if (!document.body) { // DOM not ready yet — retry shortly
            document.addEventListener('DOMContentLoaded', render, { once: true });
            return;
        }
        injectStyle();
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = WRAP_ID;
            document.body.appendChild(wrap);
        }
        if (!_open) {
            wrap.innerHTML = '<div class="cw-chip" role="button" tabindex="0" ' +
                'title="Click to see which bunks missed an activity and why">' +
                '<span>⚠️</span><span>' + esc(chipLabel()) + '</span><span class="cw-caret">▲</span></div>';
            var chip = wrap.querySelector('.cw-chip');
            chip.addEventListener('click', function () { _open = true; render(); });
            chip.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _open = true; render(); }
            });
        } else {
            wrap.innerHTML =
                '<div class="cw-panel">' +
                    '<div class="cw-head">' +
                        '<span>⚠️</span>' +
                        '<span class="cw-title">Coverage heads-up</span>' +
                        '<button class="cw-min" title="Hide" aria-label="Hide">–</button>' +
                        '<button class="cw-close" title="Dismiss" aria-label="Dismiss">×</button>' +
                    '</div>' +
                    '<div class="cw-body">' + buildBody() + '</div>' +
                    '<div class="cw-foot">These bunks didn’t get the activity today — try a suggestion, or accept and move on.</div>' +
                '</div>';
            wrap.querySelector('.cw-min').addEventListener('click', function () { _open = false; render(); });
            wrap.querySelector('.cw-close').addEventListener('click', function () { _items = []; _open = false; render(); });
        }
    }

    function onGaps(e) {
        var d = (e && e.detail) || {};
        _items = Array.isArray(d.items) ? d.items.slice() : [];
        _open = false; // surface as a heads-up chip first; user clicks to expand
        render();
    }

    window.addEventListener('campistry-coverage-gaps', onGaps);
    document.addEventListener('campistry-coverage-gaps', onGaps);

    // Manual re-open hook for console/debug: window.__showCoverageWarning()
    window.__showCoverageWarning = function () {
        if (Array.isArray(window._coverageGaps)) { _items = window._coverageGaps.slice(); _open = true; render(); }
    };

    // =========================================================================
    // ★ FREE / UNFILLED-SLOT WARNING  (separate, MORE urgent than coverage gaps)
    // -------------------------------------------------------------------------
    // A "Free" block means a bunk has NO activity at that time — a real hole in
    // the schedule, not just a missed nice-to-have. The generator dispatches
    // `campistry-schedule-impossibilities` after every gen, but nothing used to
    // listen, so Free blocks landed SILENTLY. This surfaces them loudly: a red
    // banner (top-center, auto-EXPANDED so the user sees it without clicking)
    // listing each unfilled slot's bunk · time · reason. Clears automatically on
    // a clean (zero-Free) generation. Dismissable (×) / collapsible (–).
    // =========================================================================
    var FREE_WRAP_ID = 'campistry-free-warn';
    var FREE_STYLE_ID = 'campistry-free-warn-style';
    var _frees = [];
    var _freeOpen = true;   // start EXPANDED — a hole must not be missed

    function fmtTime(m) {
        if (m == null || isNaN(m)) return '?';
        var h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'am' : 'pm', hh = h % 12; if (hh === 0) hh = 12;
        return hh + ':' + (mm < 10 ? '0' : '') + mm + ap;
    }

    function injectFreeStyle() {
        if (document.getElementById(FREE_STYLE_ID)) return;
        var css = '' +
        '#' + FREE_WRAP_ID + '{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:100000;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:520px;max-width:94vw;}' +
        '#' + FREE_WRAP_ID + ' *{box-sizing:border-box;}' +
        '#' + FREE_WRAP_ID + ' .fw-panel{background:#fff;border:2px solid #dc2626;border-radius:12px;' +
            'box-shadow:0 12px 34px rgba(220,38,38,.28);overflow:hidden;}' +
        '#' + FREE_WRAP_ID + ' .fw-head{display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'background:#fee2e2;border-bottom:1px solid #fecaca;color:#991b1b;cursor:pointer;}' +
        '#' + FREE_WRAP_ID + ' .fw-head .fw-title{font-size:13.5px;font-weight:800;flex:1;}' +
        '#' + FREE_WRAP_ID + ' .fw-head button{border:none;background:transparent;cursor:pointer;' +
            'color:#991b1b;font-size:18px;line-height:1;padding:0 6px;border-radius:6px;}' +
        '#' + FREE_WRAP_ID + ' .fw-head button:hover{background:#fecaca;}' +
        '#' + FREE_WRAP_ID + ' .fw-body{max-height:300px;overflow:auto;padding:6px 0;}' +
        '#' + FREE_WRAP_ID + ' .fw-row{padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12.5px;color:#374151;}' +
        '#' + FREE_WRAP_ID + ' .fw-row:last-child{border-bottom:none;}' +
        '#' + FREE_WRAP_ID + ' .fw-where{font-weight:700;color:#111827;}' +
        '#' + FREE_WRAP_ID + ' .fw-why{color:#6b7280;font-size:11.5px;margin-top:1px;}' +
        '#' + FREE_WRAP_ID + ' .fw-foot{padding:7px 12px;background:#fef2f2;border-top:1px solid #fecaca;' +
            'font-size:11px;color:#991b1b;}';
        var st = document.createElement('style');
        st.id = FREE_STYLE_ID;
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    function renderFree() {
        var wrap = document.getElementById(FREE_WRAP_ID);
        if (!_frees.length) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); return; }
        if (!document.body) { document.addEventListener('DOMContentLoaded', renderFree, { once: true }); return; }
        injectFreeStyle();
        if (!wrap) { wrap = document.createElement('div'); wrap.id = FREE_WRAP_ID; document.body.appendChild(wrap); }
        var n = _frees.length;
        var title = '⛔ ' + n + ' unfilled (Free) slot' + (n === 1 ? '' : 's') + ' in this schedule';
        var head =
            '<div class="fw-head" title="' + (_freeOpen ? 'Collapse' : 'Expand') + '">' +
                '<span>⛔</span><span class="fw-title">' + esc(title) + '</span>' +
                '<button class="fw-min" title="' + (_freeOpen ? 'Collapse' : 'Expand') + '">' + (_freeOpen ? '–' : '+') + '</button>' +
                '<button class="fw-close" title="Dismiss">×</button>' +
            '</div>';
        var bodyHtml = '';
        if (_freeOpen) {
            var rows = '';
            _frees.forEach(function (f) {
                var where = (f.bunk || '?') + (f.grade ? ' (' + f.grade + ')' : '') +
                    (f.start != null ? '  ·  ' + fmtTime(f.start) + '–' + fmtTime(f.end) : '');
                rows += '<div class="fw-row"><div class="fw-where">' + esc(where) + '</div>' +
                        '<div class="fw-why">' + esc(f.reason || 'unfilled slot') + '</div></div>';
            });
            bodyHtml = '<div class="fw-body">' + rows + '</div>' +
                '<div class="fw-foot">These bunks have an empty slot — adjust layers/fields and re-generate, or fill manually.</div>';
        }
        wrap.innerHTML = '<div class="fw-panel">' + head + bodyHtml + '</div>';
        wrap.querySelector('.fw-min').addEventListener('click', function (ev) { ev.stopPropagation(); _freeOpen = !_freeOpen; renderFree(); });
        wrap.querySelector('.fw-close').addEventListener('click', function (ev) { ev.stopPropagation(); _frees = []; renderFree(); });
        wrap.querySelector('.fw-head').addEventListener('click', function () { _freeOpen = !_freeOpen; renderFree(); });
    }

    function onImpossibilities(e) {
        var d = (e && e.detail) || {};
        _frees = Array.isArray(d.items) ? d.items.slice() : [];
        _freeOpen = true;   // always surface expanded — never silent
        renderFree();
    }

    window.addEventListener('campistry-schedule-impossibilities', onImpossibilities);
    document.addEventListener('campistry-schedule-impossibilities', onImpossibilities);
    window.__showFreeWarning = function () { renderFree(); };

    // =====================================================================
    // ★ OVERRIDE-ACCESS WARNING  (amber — Risk #2 "warn but allow")
    // ---------------------------------------------------------------------
    // A bunk OVERRIDE intentionally bypasses a field's access restriction
    // (the user is the boss), but the bypass must never be SILENT. This
    // surfaces an amber, dismissable heads-up listing each override placed
    // on a field its division is access-restricted from. Less urgent than a
    // Free hole (red) — the slot IS filled, just on a restricted field.
    // Dispatched by scheduler_core_main.js after the bunk-override step.
    // Anchored top-RIGHT so it never overlaps the centered Free/coverage panels.
    // =====================================================================
    var OA_WRAP_ID = 'campistry-override-access-warn';
    var OA_STYLE_ID = 'campistry-override-access-warn-style';
    var _oa = [];
    var _oaOpen = true;

    function injectOAStyle() {
        if (document.getElementById(OA_STYLE_ID)) return;
        var css = '' +
        '#' + OA_WRAP_ID + '{position:fixed;top:12px;right:12px;z-index:99999;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:440px;max-width:92vw;}' +
        '#' + OA_WRAP_ID + ' *{box-sizing:border-box;}' +
        '#' + OA_WRAP_ID + ' .oa-panel{background:#fff;border:2px solid #d97706;border-radius:12px;' +
            'box-shadow:0 12px 34px rgba(217,119,6,.26);overflow:hidden;}' +
        '#' + OA_WRAP_ID + ' .oa-head{display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'background:#fef3c7;border-bottom:1px solid #fde68a;color:#92400e;cursor:pointer;}' +
        '#' + OA_WRAP_ID + ' .oa-head .oa-title{font-size:13px;font-weight:800;flex:1;}' +
        '#' + OA_WRAP_ID + ' .oa-head button{border:none;background:transparent;cursor:pointer;' +
            'color:#92400e;font-size:18px;line-height:1;padding:0 6px;border-radius:6px;}' +
        '#' + OA_WRAP_ID + ' .oa-head button:hover{background:#fde68a;}' +
        '#' + OA_WRAP_ID + ' .oa-body{max-height:280px;overflow:auto;padding:6px 0;}' +
        '#' + OA_WRAP_ID + ' .oa-row{padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12.5px;color:#374151;}' +
        '#' + OA_WRAP_ID + ' .oa-row:last-child{border-bottom:none;}' +
        '#' + OA_WRAP_ID + ' .oa-where{font-weight:700;color:#111827;}' +
        '#' + OA_WRAP_ID + ' .oa-why{color:#6b7280;font-size:11.5px;margin-top:1px;}' +
        '#' + OA_WRAP_ID + ' .oa-foot{padding:7px 12px;background:#fffbeb;border-top:1px solid #fde68a;' +
            'font-size:11px;color:#92400e;}';
        var st = document.createElement('style');
        st.id = OA_STYLE_ID;
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    function renderOA() {
        var wrap = document.getElementById(OA_WRAP_ID);
        if (!_oa.length) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); return; }
        if (!document.body) { document.addEventListener('DOMContentLoaded', renderOA, { once: true }); return; }
        injectOAStyle();
        if (!wrap) { wrap = document.createElement('div'); wrap.id = OA_WRAP_ID; document.body.appendChild(wrap); }
        var n = _oa.length;
        var title = n + ' override' + (n === 1 ? '' : 's') + ' on an access-restricted field';
        var head =
            '<div class="oa-head" title="' + (_oaOpen ? 'Collapse' : 'Expand') + '">' +
                '<span>⚠️</span><span class="oa-title">' + esc(title) + '</span>' +
                '<button class="oa-min">' + (_oaOpen ? '–' : '+') + '</button>' +
                '<button class="oa-close" title="Dismiss">×</button>' +
            '</div>';
        var bodyHtml = '';
        if (_oaOpen) {
            var rows = '';
            _oa.forEach(function (w) {
                var where = (w.bunk || '?') + '  ·  ' + (w.activity || w.field || '?') +
                    (w.startMin != null ? '  ·  ' + fmtTime(w.startMin) + '–' + fmtTime(w.endMin) : '');
                var why = (w.division || 'This division') + ' is access-restricted from “' + (w.field || '?') + '” — placed anyway (manual override).';
                rows += '<div class="oa-row"><div class="oa-where">' + esc(where) + '</div>' +
                        '<div class="oa-why">' + esc(why) + '</div></div>';
            });
            bodyHtml = '<div class="oa-body">' + rows + '</div>' +
                '<div class="oa-foot">Overrides win by design. To clear a warning: remove the override, or grant the division access to the field in Facilities.</div>';
        }
        wrap.innerHTML = '<div class="oa-panel">' + head + bodyHtml + '</div>';
        wrap.querySelector('.oa-min').addEventListener('click', function (ev) { ev.stopPropagation(); _oaOpen = !_oaOpen; renderOA(); });
        wrap.querySelector('.oa-close').addEventListener('click', function (ev) { ev.stopPropagation(); _oa = []; renderOA(); });
        wrap.querySelector('.oa-head').addEventListener('click', function () { _oaOpen = !_oaOpen; renderOA(); });
    }

    function onOverrideAccess(e) {
        var d = (e && e.detail) || {};
        _oa = Array.isArray(d.items) ? d.items.slice() : [];
        _oaOpen = true;   // always surface expanded — never silent
        renderOA();
    }

    window.addEventListener('campistry-override-access-warnings', onOverrideAccess);
    document.addEventListener('campistry-override-access-warnings', onOverrideAccess);
    window.__showOverrideAccessWarning = function () { renderOA(); };

    // ---------------------------------------------------------------------
    // ★ OVERRIDE PLAYER MIN/MAX WARNING  (rose — warn-but-allow)
    // ---------------------------------------------------------------------
    // The override placer groups same-sport bunks toward minPlayers and caps
    // campers at maxPlayers, but the user's explicit picks can still leave a
    // sport under min (nothing to combine with) or over max (all fields full).
    // Surfaced here — dismissable, never silent, never blocking. Anchored
    // bottom-RIGHT so it never overlaps the access (top-right) or Free (center)
    // panels. Dispatched by scheduler_core_main.js after the bunk-override step.
    // =====================================================================
    var OP_WRAP_ID = 'campistry-override-player-warn';
    var OP_STYLE_ID = 'campistry-override-player-warn-style';
    var _op = [];
    var _opOpen = true;

    function injectOPStyle() {
        if (document.getElementById(OP_STYLE_ID)) return;
        var css = '' +
        '#' + OP_WRAP_ID + '{position:fixed;bottom:12px;right:12px;z-index:99999;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:440px;max-width:92vw;}' +
        '#' + OP_WRAP_ID + ' *{box-sizing:border-box;}' +
        '#' + OP_WRAP_ID + ' .op-panel{background:#fff;border:2px solid #e11d48;border-radius:12px;' +
            'box-shadow:0 12px 34px rgba(225,29,72,.24);overflow:hidden;}' +
        '#' + OP_WRAP_ID + ' .op-head{display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'background:#ffe4e6;border-bottom:1px solid #fecdd3;color:#9f1239;cursor:pointer;}' +
        '#' + OP_WRAP_ID + ' .op-head .op-title{font-size:13px;font-weight:800;flex:1;}' +
        '#' + OP_WRAP_ID + ' .op-head button{border:none;background:transparent;cursor:pointer;' +
            'color:#9f1239;font-size:18px;line-height:1;padding:0 6px;border-radius:6px;}' +
        '#' + OP_WRAP_ID + ' .op-head button:hover{background:#fecdd3;}' +
        '#' + OP_WRAP_ID + ' .op-body{max-height:280px;overflow:auto;padding:6px 0;}' +
        '#' + OP_WRAP_ID + ' .op-row{padding:6px 12px;border-bottom:1px solid #f3f4f6;font-size:12.5px;color:#374151;}' +
        '#' + OP_WRAP_ID + ' .op-row:last-child{border-bottom:none;}' +
        '#' + OP_WRAP_ID + ' .op-where{font-weight:700;color:#111827;}' +
        '#' + OP_WRAP_ID + ' .op-why{color:#6b7280;font-size:11.5px;margin-top:1px;}' +
        '#' + OP_WRAP_ID + ' .op-foot{padding:7px 12px;background:#fff1f2;border-top:1px solid #fecdd3;' +
            'font-size:11px;color:#9f1239;}';
        var st = document.createElement('style');
        st.id = OP_STYLE_ID;
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    function renderOP() {
        var wrap = document.getElementById(OP_WRAP_ID);
        if (!_op.length) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); return; }
        if (!document.body) { document.addEventListener('DOMContentLoaded', renderOP, { once: true }); return; }
        injectOPStyle();
        if (!wrap) { wrap = document.createElement('div'); wrap.id = OP_WRAP_ID; document.body.appendChild(wrap); }
        var n = _op.length;
        var title = n + ' override sport' + (n === 1 ? '' : 's') + ' outside player min/max';
        var head =
            '<div class="op-head" title="' + (_opOpen ? 'Collapse' : 'Expand') + '">' +
                '<span>⚠️</span><span class="op-title">' + esc(title) + '</span>' +
                '<button class="op-min">' + (_opOpen ? '–' : '+') + '</button>' +
                '<button class="op-close" title="Dismiss">×</button>' +
            '</div>';
        var bodyHtml = '';
        if (_opOpen) {
            var rows = '';
            _op.forEach(function (w) {
                var bunks = Array.isArray(w.bunks) ? w.bunks.join(', ') : '';
                var where = (w.sport || '?') + '  ·  ' + (w.field || '?') + (bunks ? '  ·  ' + bunks : '');
                var why = (w.kind === 'max')
                    ? ('Has ' + (w.campers != null ? w.campers : '?') + ' players — over the max of ' + (w.max || '?') + ' (placed anyway).')
                    : ('Has ' + (w.campers != null ? w.campers : '?') + ' players — needs at least ' + (w.min || '?') + ' (placed anyway).');
                rows += '<div class="op-row"><div class="op-where">' + esc(where) + '</div>' +
                        '<div class="op-why">' + esc(why) + '</div></div>';
            });
            bodyHtml = '<div class="op-body">' + rows + '</div>' +
                '<div class="op-foot">Overrides win by design. To clear: add/remove bunks for that sport, or adjust the sport’s min/max players in Rules.</div>';
        }
        wrap.innerHTML = '<div class="op-panel">' + head + bodyHtml + '</div>';
        wrap.querySelector('.op-min').addEventListener('click', function (ev) { ev.stopPropagation(); _opOpen = !_opOpen; renderOP(); });
        wrap.querySelector('.op-close').addEventListener('click', function (ev) { ev.stopPropagation(); _op = []; renderOP(); });
        wrap.querySelector('.op-head').addEventListener('click', function () { _opOpen = !_opOpen; renderOP(); });
    }

    function onOverridePlayer(e) {
        var d = (e && e.detail) || {};
        _op = Array.isArray(d.items) ? d.items.slice() : [];
        _opOpen = true;   // always surface expanded — never silent
        renderOP();
    }

    window.addEventListener('campistry-override-player-warnings', onOverridePlayer);
    document.addEventListener('campistry-override-player-warnings', onOverridePlayer);
    window.__showOverridePlayerWarning = function () { renderOP(); };

    // =====================================================================
    // ★ LEAGUE BYE / SKIPPED-PERIOD WARNING  (amber — "not enough fields")
    // ---------------------------------------------------------------------
    // When a league period needs more simultaneous games than there are open
    // fields, a matchup is dropped to a BYE — and when NO field is open at
    // all, the entire league period is skipped and the bunks get regular
    // activities (or Free) instead. Both used to land silently (console
    // only). scheduler_core_leagues.js dispatches
    // 'campistry-league-bye-warnings' after every league run with the reason
    // per event; an empty dispatch (clean gen) clears it.
    //
    // A bye is informational, not an error — so this is DELIBERATELY quiet:
    // it surfaces as a small collapsed CHIP (bottom-left, out of the way),
    // and only OPENS into the detail card when the user clicks it. Mirrors
    // the coverage heads-up chip, not the red Free banner.
    // =====================================================================
    var LB_WRAP_ID = 'campistry-league-bye-warn';
    var LB_STYLE_ID = 'campistry-league-bye-warn-style';
    var _lb = [];
    var _lbOpen = false;   // false = chip (collapsed) · true = detail card

    function injectLBStyle() {
        if (document.getElementById(LB_STYLE_ID)) return;
        var css = '' +
        '#' + LB_WRAP_ID + '{position:fixed;left:16px;bottom:16px;z-index:99998;' +
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
        '#' + LB_WRAP_ID + ' *{box-sizing:border-box;}' +
        // collapsed chip — soft amber pill, matches the coverage heads-up chip
        '#' + LB_WRAP_ID + ' .lb-chip{display:inline-flex;align-items:center;gap:8px;cursor:pointer;' +
            'background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:9999px;' +
            'padding:8px 14px;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.10);' +
            'user-select:none;transition:background .12s;}' +
        '#' + LB_WRAP_ID + ' .lb-chip:hover{background:#fef3c7;}' +
        '#' + LB_WRAP_ID + ' .lb-chip .lb-caret{opacity:.6;font-size:11px;}' +
        // expanded detail card — soft, no alarm border
        '#' + LB_WRAP_ID + ' .lb-panel{background:#fff;border:1px solid #e5e7eb;border-radius:12px;' +
            'box-shadow:0 10px 30px rgba(0,0,0,.16);overflow:hidden;width:440px;max-width:90vw;}' +
        '#' + LB_WRAP_ID + ' .lb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;cursor:pointer;}' +
        '#' + LB_WRAP_ID + ' .lb-head .lb-title{font-size:13px;font-weight:700;flex:1;}' +
        '#' + LB_WRAP_ID + ' .lb-head button{border:none;background:transparent;cursor:pointer;' +
            'color:#92400e;font-size:18px;line-height:1;padding:0 6px;border-radius:6px;}' +
        '#' + LB_WRAP_ID + ' .lb-head button:hover{background:#fde68a;}' +
        '#' + LB_WRAP_ID + ' .lb-body{max-height:300px;overflow:auto;padding:4px 0 2px;}' +
        '#' + LB_WRAP_ID + ' .lb-row{padding:7px 12px;border-bottom:1px solid #f3f4f6;font-size:12.5px;color:#374151;}' +
        '#' + LB_WRAP_ID + ' .lb-row:last-child{border-bottom:none;}' +
        '#' + LB_WRAP_ID + ' .lb-where{font-weight:700;color:#111827;}' +
        '#' + LB_WRAP_ID + ' .lb-what{color:#b45309;font-weight:600;font-size:12px;margin-top:1px;}' +
        '#' + LB_WRAP_ID + ' .lb-why{color:#6b7280;font-size:11.5px;margin-top:1px;line-height:1.4;}' +
        '#' + LB_WRAP_ID + ' .lb-foot{padding:8px 12px;border-top:1px solid #f3f4f6;font-size:11px;color:#9ca3af;}';
        var st = document.createElement('style');
        st.id = LB_STYLE_ID;
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    function lbChipLabel() {
        var nBye = 0, nSkip = 0;
        _lb.forEach(function (w) { if (w.kind === 'skipped') nSkip++; else nBye++; });
        var parts = [];
        if (nBye) parts.push(nBye + ' bye' + (nBye === 1 ? '' : 's'));
        if (nSkip) parts.push(nSkip + ' skipped');
        return 'League ' + parts.join(' + ');
    }

    function renderLB() {
        var wrap = document.getElementById(LB_WRAP_ID);
        if (!_lb.length) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); return; }
        if (!document.body) { document.addEventListener('DOMContentLoaded', renderLB, { once: true }); return; }
        injectLBStyle();
        if (!wrap) { wrap = document.createElement('div'); wrap.id = LB_WRAP_ID; document.body.appendChild(wrap); }

        if (!_lbOpen) {
            // Collapsed: a quiet chip. Click to open the detail card.
            wrap.innerHTML = '<div class="lb-chip" role="button" tabindex="0" ' +
                'title="Some league games got a bye — click for details">' +
                '<span>🏳️</span><span>' + esc(lbChipLabel()) + '</span><span class="lb-caret">▲</span></div>';
            var chip = wrap.querySelector('.lb-chip');
            chip.addEventListener('click', function () { _lbOpen = true; renderLB(); });
            chip.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _lbOpen = true; renderLB(); }
            });
            return;
        }

        var rows = '';
        _lb.forEach(function (w) {
            var t = Number(w.time);
            var timeStr = isNaN(t) ? (w.time != null ? String(w.time) : '') : fmtTime(t);
            var where = (w.league || '?') + (w.game != null ? '  ·  Game ' + w.game : '') + (timeStr ? '  ·  ' + timeStr : '');
            var what = (w.kind === 'skipped')
                ? 'League period skipped — no games ran'
                : ((w.team1 || '?') + ' vs ' + (w.team2 || '?') + ' — bye');
            rows += '<div class="lb-row"><div class="lb-where">' + esc(where) + '</div>' +
                    '<div class="lb-what">' + esc(what) + '</div>' +
                    '<div class="lb-why">' + esc(w.reason || 'not enough fields') + '</div></div>';
        });
        wrap.innerHTML =
            '<div class="lb-panel">' +
                '<div class="lb-head">' +
                    '<span>🏳️</span>' +
                    '<span class="lb-title">' + esc(lbChipLabel()) + ' — not enough fields</span>' +
                    '<button class="lb-min" title="Hide" aria-label="Hide">–</button>' +
                    '<button class="lb-close" title="Dismiss" aria-label="Dismiss">×</button>' +
                '</div>' +
                '<div class="lb-body">' + rows + '</div>' +
                '<div class="lb-foot">A bye means a matchup had no open field at its time — free a field then (reservations, other leagues, pins) or add fields for the sport, and re-generate.</div>' +
            '</div>';
        wrap.querySelector('.lb-min').addEventListener('click', function (ev) { ev.stopPropagation(); _lbOpen = false; renderLB(); });
        wrap.querySelector('.lb-close').addEventListener('click', function (ev) { ev.stopPropagation(); _lb = []; _lbOpen = false; renderLB(); });
    }

    function onLeagueByes(e) {
        var d = (e && e.detail) || {};
        _lb = Array.isArray(d.items) ? d.items.slice() : [];
        _lbOpen = false;   // surface as a quiet chip first; user clicks to expand
        renderLB();
    }

    window.addEventListener('campistry-league-bye-warnings', onLeagueByes);
    document.addEventListener('campistry-league-bye-warnings', onLeagueByes);
    window.__showLeagueByeWarning = function () {
        if (Array.isArray(window.__leagueByeReport)) { _lb = window.__leagueByeReport.slice(); _lbOpen = true; renderLB(); }
    };
})();
