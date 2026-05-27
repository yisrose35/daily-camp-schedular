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

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

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
})();
