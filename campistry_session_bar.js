/* =============================================================================
 * campistry_session_bar.js — saying which session you are looking at, on every page.
 *
 * WHY THIS EXISTS AT ALL. The master key scopes every list in the app to one
 * session. That is only safe if it is impossible to be looking at a scoped view
 * without knowing — a person reading 2nd Half's roster and believing it is today's
 * will conclude that half the camp has vanished, and the one after that will conclude
 * the app is broken.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It is deliberately quiet in the ordinary case. When the camp is simply following
 * its calendar and the session covers today, there is nothing surprising to report:
 * the bar states the session in one small line and offers the picker, and that is
 * all. It does NOT get a colour, a border or an icon, because a page that shouts
 * every day teaches people to stop reading it — which is exactly what would make it
 * useless on the day it matters.
 *
 * It shouts in three cases, and only three:
 *
 *   A PEEK      you are looking somewhere nobody else is. Amber, and it carries the
 *               way back, because a peek you cannot find the exit from is a trap.
 *   A PIN       the camp has been deliberately pointed away from its calendar.
 *               Worth seeing — somebody chose it, and somebody has to unchoose it.
 *   A DROPPED   a pin expired. This is the one message that must be impossible to
 *   PIN         miss, so it is red and there is deliberately no way to dismiss it:
 *               it stays until an owner clears the pin on the dashboard, because a
 *               dismissible notice about a stale scope is a notice somebody
 *               dismisses and then forgets, which is the original problem again.
 *
 * And it renders NOTHING at all inside a planning sandbox: the amber planning bar
 * already says which session that plan is for, and two bars saying the same thing in
 * different colours is how a person learns to read neither.
 *
 * ── THE PEEK IS PER-TAB ────────────────────────────────────────────────────
 *
 * Changing the session here changes it for you, in this tab, until you close it.
 * Nothing is saved. The camp-wide answer is set on the dashboard, and only there,
 * because "what session is the camp in" is a decision and "let me look at the other
 * half for a minute" is not.
 * ========================================================================== */
(function (root) {
    'use strict';
    if (!root || !root.document) return;
    var doc = root.document;
    var BAR_ID = 'campistry-session-bar';
    var U = {};

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function rule() { return root.CampistrySessionScope || null; }
    function scope() {
        try {
            return (typeof root.campistrySessionScope === 'function')
                ? root.campistrySessionScope() : null;
        } catch (e) { return null; }
    }
    function sessions() {
        try {
            var st = (typeof root.loadGlobalSettings === 'function')
                ? (root.loadGlobalSettings() || {}) : {};
            var me = st.campistryMe;
            return (me && Array.isArray(me.sessions)) ? me.sessions : [];
        } catch (e) { return []; }
    }

    /**
     * Is there a choice to make? A camp with one session, or none, gets no bar —
     * offering a picker with one option in it is furniture.
     */
    function hasChoice(list) {
        var named = (list || []).filter(function (s) { return s && String(s.name || '').trim(); });
        return named.length > 1;
    }

    function render() {
        var R = rule();
        var sc = scope();
        var existing = doc.getElementById(BAR_ID);
        var list = sessions();

        function drop() {
            if (existing) existing.remove();
            doc.documentElement.style.removeProperty('--campistry-session-bar-h');
        }

        if (!R || !sc || sc.ruleMissing) return drop();
        // Inside a plan the amber bar has already said it.
        if (sc.source === 'workspace') return drop();
        // A dropped pin is reported even on a camp with one session, because
        // somebody pinned something and needs to know it stopped applying.
        if (!hasChoice(list) && !sc.pinDropped) return drop();

        var bar = existing || doc.createElement('div');
        bar.id = BAR_ID;
        bar.setAttribute('role', 'status');

        var loud = sc.pinDropped ? 'drop' : (sc.source === 'peek' ? 'peek'
                  : (sc.source === 'pin' ? 'pin' : ''));
        var skin = {
            drop: { bg: '#FEF2F2', bd: '#FECACA', fg: '#991B1B' },
            peek: { bg: '#FFFBEB', bd: '#FDE68A', fg: '#92400E' },
            pin:  { bg: '#EFF6FF', bd: '#BFDBFE', fg: '#1E40AF' },
            '':   { bg: 'transparent', bd: 'transparent', fg: '#64748B' }
        }[loud];

        bar.style.cssText = [
            'display:flex', 'align-items:center', 'gap:10px', 'flex-wrap:wrap',
            'font-family:-apple-system,Segoe UI,Arial,sans-serif',
            'font-size:12.5px', 'line-height:1.4',
            'padding:' + (loud ? '8px 14px' : '5px 14px'),
            'background:' + skin.bg, 'color:' + skin.fg,
            'border-bottom:1px solid ' + skin.bd
        ].join(';');

        var opts = '<option value="">Follow the camp'
                 + (sc.pin && !sc.pinDropped ? '' : (sc.session ? ' — ' + esc(sc.session) : ''))
                 + '</option>';
        R.ordered(list).forEach(function (s) {
            var nm = String(s.name || '').trim();
            if (!nm) return;
            opts += '<option value="' + esc(nm) + '"'
                 + (sc.peek === nm ? ' selected' : '') + '>' + esc(nm) + '</option>';
        });

        var html = '';
        if (sc.pinDropped) {
            html += '<strong style="font-weight:700">' + esc(R.droppedNotice(sc)) + '</strong>';
        } else {
            var line = R.describe(sc);
            html += '<span><strong style="font-weight:600">Viewing:</strong> '
                 + esc(line || 'everyone, as of today') + '</span>';
        }
        html += '<span style="flex:1;min-width:20px"></span>';
        html += '<label style="display:inline-flex;align-items:center;gap:6px">'
             + '<span style="opacity:.8">Show</span>'
             + '<select id="' + BAR_ID + '-pick" style="font:inherit;padding:2px 6px;'
             + 'border-radius:5px;border:1px solid ' + (loud ? skin.bd : '#CBD5E1') + ';'
             + 'background:#fff;color:#0F172A">' + opts + '</select></label>';
        if (sc.source === 'peek') {
            html += '<button id="' + BAR_ID + '-back" style="font:inherit;font-weight:600;'
                 + 'padding:3px 11px;border-radius:5px;border:0;cursor:pointer;'
                 + 'background:' + skin.fg + ';color:#fff">Back to '
                 + esc(sc.campSession || 'the camp') + '</button>';
        }

        bar.innerHTML = html;

        if (!existing) {
            // FIRST THING IN THE BODY, so it is above the page's own header rather
            // than floating over it. The planning bar is fixed-position because it
            // must cover everything; this one is part of the document, because it is
            // ordinary information and should scroll away like ordinary information.
            if (doc.body.firstChild) doc.body.insertBefore(bar, doc.body.firstChild);
            else doc.body.appendChild(bar);
        }
        doc.documentElement.style.setProperty('--campistry-session-bar-h',
            (bar.offsetHeight || 28) + 'px');

        var pick = doc.getElementById(BAR_ID + '-pick');
        if (pick) pick.onchange = function () { U.peek(this.value); };
        var back = doc.getElementById(BAR_ID + '-back');
        if (back) back.onclick = function () { U.peek(''); };
    }
    U.render = render;

    /**
     * Look at another session in this tab. '' returns to whatever the camp says.
     *
     * Re-renders the page the blunt way. Every list on every page derives from the
     * as-of date, and there is no registry of what needs redrawing — a reload is the
     * only honest way to be sure nothing is left showing the previous session's
     * children, which is precisely the bug this whole feature exists to prevent.
     */
    U.peek = function (name) {
        if (typeof root.campistrySetPeekSession !== 'function') return;
        var before = root.campistryPeekSession ? root.campistryPeekSession() : '';
        var after = (name && String(name)) || '';
        if (before === after) return;
        root.campistrySetPeekSession(after);
        try { root.location.reload(); } catch (e) { render(); }
    };

    /** The scope, for a page that wants to read it without the runtime helper. */
    U.scope = scope;

    function boot() {
        try { render(); } catch (e) {
            try { console.warn('[session-bar]', e); } catch (_) {}
        }
        // Re-rendered on a scope change AND on a settings load, because the sessions
        // and the pin both arrive with the cloud state — a bar drawn before hydration
        // would name whatever was in the stripped local snapshot.
        function restate() {
            if (typeof root.campistrySessionScopeRefresh === 'function') {
                root.campistrySessionScopeRefresh();
            }
            render();
        }
        try {
            root.addEventListener('campistry-session-scope', render);
            // The sessions and the pin both arrive with the cloud state, so a bar
            // drawn before hydration would name whatever was in the stripped local
            // snapshot — or nothing at all on a first load.
            root.addEventListener('campistry-cloud-hydrated', restate);
            // And another tab (or the dashboard) changing the pin reaches us as a
            // realtime key change. Without this the two tabs disagree about what
            // the camp is showing until somebody reloads.
            root.addEventListener('campistry-remote-change', function (ev) {
                var k = (ev && ev.detail && ev.detail.key) || '';
                if (k === 'campSession' || k === 'campistryMe' || k === 'campDates') restate();
            });
        } catch (_) {}
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();

    root.CampistrySessionBar = U;
})(typeof window !== 'undefined' ? window : null);
