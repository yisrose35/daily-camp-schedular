/* =============================================================================
 * campistry_workspace_admin.js — the owner's controls: make a plan, make it
 * official.
 *
 * Kept apart from campistry_workspace_ui.js on purpose. That file is the BAR:
 * it is on every page, it must never fail, and all it does is tell you which
 * session you are in and let you leave. This file is the management screen, it
 * lives on the dashboard only, and it is the only thing in the app that can
 * change what the camp IS.
 *
 * Every guard here is duplicated server-side in migration 193 and the server's
 * is the real one — this is the half that explains, not the half that enforces.
 * ========================================================================== */
(function (root) {
    'use strict';
    if (!root || !root.document) return;
    var doc = root.document;
    var A = {};

    function client() {
        try {
            if (root.CampistryDB && root.CampistryDB.getClient) return root.CampistryDB.getClient();
            return root.supabase || null;
        } catch (e) { return null; }
    }
    function campId() {
        try {
            if (root.CampistryDB && root.CampistryDB.getCampId) return root.CampistryDB.getCampId();
            return localStorage.getItem('campistry_camp_id') || null;
        } catch (e) { return null; }
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function say(msg, bad) {
        var el = doc.getElementById('workspacesStatus');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = bad ? '#dc2626' : '#059669';
        if (msg && !bad) setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 4000);
    }

    // ── the dialogs ────────────────────────────────────────────────────────
    // Self-contained, and styled to match the dashboard's own overlays
    // (.dn-qoverlay), because the dashboard has no shared modal helper — the
    // app's confirmDialog/showModal live inside campistry_me.js and are not
    // reachable from here. Hoisting them out of a 19,000-line file to reuse two
    // dialogs would be a bigger and riskier change than writing the two.
    //
    // Both return promises and both resolve rather than reject on cancel, so a
    // caller that forgets to handle the cancel path does nothing instead of
    // throwing in the middle of a promotion.
    function _ensureStyles() {
        if (doc.getElementById('ws-dialog-styles')) return;
        var st = doc.createElement('style');
        st.id = 'ws-dialog-styles';
        st.textContent = [
            '.ws-ovl{position:fixed;inset:0;z-index:2147483100;background:rgba(15,23,42,.42);',
            'backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px}',
            '.ws-card{width:min(480px,calc(100vw - 32px));background:#fff;border-radius:16px;',
            'box-shadow:0 14px 44px rgba(0,0,0,.22);overflow:hidden;font-family:"DM Sans",-apple-system,Segoe UI,Arial,sans-serif;',
            'animation:ws-in .2s cubic-bezier(.16,1,.3,1)}',
            '@keyframes ws-in{from{transform:scale(.94) translateY(14px);opacity:0}to{transform:none;opacity:1}}',
            '.ws-hd{padding:16px 18px 6px;font-size:1.02rem;font-weight:700;color:#0F172A}',
            '.ws-bd{padding:2px 18px 14px;font-size:.87rem;line-height:1.6;color:#334155}',
            '.ws-bd input{width:100%;margin-top:10px;padding:9px 11px;border-radius:9px;',
            'border:1px solid #CBD5E1;font-size:.9rem;font-family:inherit}',
            '.ws-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;',
            'border-top:1px solid #E2E8F0;background:#F8FAFC}',
            '.ws-ft button{font:inherit;font-size:.86rem;font-weight:600;padding:8px 15px;',
            'border-radius:9px;cursor:pointer;border:1px solid transparent}',
            '.ws-ft .ws-no{background:#fff;border-color:#CBD5E1;color:#334155}',
            '.ws-ft .ws-yes{background:#4F46E5;color:#fff}',
            '.ws-ft .ws-yes[disabled]{background:#C7D2FE;cursor:not-allowed}',
            '.ws-ft .ws-danger{background:#DC2626;color:#fff}'
        ].join('');
        doc.head.appendChild(st);
    }

    function _dialog(o) {
        _ensureStyles();
        return new Promise(function (resolve) {
            var ovl = doc.createElement('div');
            ovl.className = 'ws-ovl';
            var needsTyping = !!o.confirmWord;
            ovl.innerHTML =
                '<div class="ws-card" role="dialog" aria-modal="true">'
                + '<div class="ws-hd">' + esc(o.title || '') + '</div>'
                + '<div class="ws-bd">' + (o.bodyHtml || esc(o.body || ''))
                + (o.input !== undefined
                    ? '<input id="ws-dlg-input" type="text" value="' + esc(o.input) + '" ' +
                      'placeholder="' + esc(o.placeholder || '') + '">' : '')
                + (needsTyping
                    ? '<input id="ws-dlg-word" type="text" autocomplete="off" placeholder="Type '
                      + esc(o.confirmWord) + '">' : '')
                + '</div>'
                + '<div class="ws-ft">'
                + '<button type="button" class="ws-no">' + esc(o.cancelText || 'Cancel') + '</button>'
                + '<button type="button" class="' + (o.danger ? 'ws-danger' : 'ws-yes') + '"'
                + (needsTyping ? ' disabled' : '') + '>' + esc(o.okText || 'OK') + '</button>'
                + '</div></div>';
            doc.body.appendChild(ovl);

            var input = ovl.querySelector('#ws-dlg-input');
            var word = ovl.querySelector('#ws-dlg-word');
            var ok = ovl.querySelector('.ws-ft button:last-child');
            var no = ovl.querySelector('.ws-no');

            function done(val) { ovl.remove(); resolve(val); }
            if (word) {
                word.addEventListener('input', function () {
                    ok.disabled = String(this.value || '').trim().toUpperCase() !== o.confirmWord;
                });
            }
            no.onclick = function () { done(null); };
            ok.onclick = function () {
                if (ok.disabled) return;
                done(input ? String(input.value || '').trim() : true);
            };
            // Clicking the backdrop and Escape both cancel, which is what every
            // other overlay in this app does.
            ovl.addEventListener('click', function (e) { if (e.target === ovl) done(null); });
            doc.addEventListener('keydown', function esc_(e) {
                if (!doc.body.contains(ovl)) { doc.removeEventListener('keydown', esc_); return; }
                if (e.key === 'Escape') { doc.removeEventListener('keydown', esc_); done(null); }
            });
            setTimeout(function () { (word || input || ok).focus(); }, 30);
        });
    }
    /** Ask for a line of text. Resolves to the text, or null on cancel. */
    function ask(o) { return _dialog(Object.assign({ okText: 'Save', input: '' }, o)); }
    /** Ask yes/no. Resolves true, or null on cancel. */
    function confirmBox(o) { return _dialog(Object.assign({ okText: 'Yes' }, o)); }

    /** Is this user the camp owner, per the dashboard's own cached RBAC answer? */
    function looksLikeOwner() {
        try {
            var c = JSON.parse(sessionStorage.getItem('campistry_rbac_cache') || '{}');
            // isTeamMember false means they own this camp rather than being on
            // somebody's team. Used ONLY to decide whether to show a setup
            // message; every real permission is checked server-side.
            return c && c.isTeamMember === false;
        } catch (e) { return false; }
    }

    /** The sessions a camp has, to offer as plan names. */
    function sessionNames() {
        try {
            var s = (typeof root.loadGlobalSettings === 'function') ? root.loadGlobalSettings() : {};
            var list = (s.campistryMe && s.campistryMe.sessions) || [];
            return list.map(function (x) { return x && x.name; }).filter(Boolean);
        } catch (e) { return []; }
    }

    A.render = async function () {
        var card = doc.getElementById('workspacesCard');
        var list = doc.getElementById('workspacesList');
        if (!card || !list) return;

        var c = client(), id = campId();
        if (!c || !id) { card.style.display = 'none'; return; }

        var res, d, err = null;
        try {
            res = await c.rpc('list_workspaces', { p_camp_id: id });
            d = res && res.data;
            err = res && res.error;
        } catch (e) { err = e; }

        // THE FUNCTION IS NOT THERE YET. Migrations in this project are pasted
        // into the SQL editor by hand, so "the feature is invisible" is the
        // expected state between shipping the code and running the SQL — and a
        // card that simply hides gives an owner no way to work out why. Say it.
        var missing = err && (
            err.code === 'PGRST202' ||
            /Could not find the function|does not exist|schema cache/i.test(String(err.message || '')));
        if (missing) {
            if (!looksLikeOwner()) { card.style.display = 'none'; return; }
            card.style.display = '';
            var addBtn0 = card.querySelector('.card-header .btn-edit');
            if (addBtn0) addBtn0.style.display = 'none';
            list.innerHTML =
                '<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;'
                + 'padding:11px 13px;border-radius:9px;font-size:.85rem;line-height:1.6">'
                + '<strong>Not switched on yet.</strong> Session planning needs one database '
                + 'migration. Open your Supabase dashboard → SQL Editor, paste the whole of '
                + '<code>migrations/193_session_workspaces.sql</code> and run it, then reload '
                + 'this page.</div>';
            return;
        }

        if (!d || !d.success) { card.style.display = 'none'; return; }

        // Reading the list is staff-level, because a scheduler has to be able to
        // see which session they are in. MANAGING workspaces is owner-only, and
        // the server enforces that — so a non-owner who got this far is shown the
        // list and none of the buttons. Offering a button that comes back
        // "not_owner" teaches people to distrust the screen.
        var canManage = (d.is_owner === true);
        card.style.display = '';
        var addBtn = card.querySelector('.card-header .btn-edit');
        if (addBtn) addBtn.style.display = canManage ? '' : 'none';

        var current = (typeof root.campistryWorkspace === 'function') ? root.campistryWorkspace() : 'live';
        var rows = d.workspaces || [];

        var h = '<div style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:8px;'
              + 'background:' + (current === 'live' ? '#ECFDF5' : 'var(--slate-50,#f8fafc)') + ';'
              + 'border:1px solid ' + (current === 'live' ? '#A7F3D0' : 'var(--slate-200,#e2e8f0)') + ';margin-bottom:8px">'
              + '<strong style="flex:1">Live camp</strong>'
              + (current === 'live'
                    ? '<span style="font-size:.78rem;color:#059669;font-weight:700">You are here</span>'
                    : '<button class="btn-edit" type="button" onclick="CampistryWorkspaceAdmin.go(\'live\')">Open</button>')
              + '</div>';

        if (!rows.length) {
            // The header's "+ New Plan" is easy to miss next to a card full of
            // explanatory text, which is exactly what happened. An empty card
            // gets a real call to action instead of a sentence about one.
            h += '<div style="text-align:center;padding:16px 10px 6px">'
               + '<p style="color:var(--slate-500);font-size:.85rem;margin:0 0 12px">'
               + 'No plans yet. Make one when you want to start building the next session.</p>'
               + (canManage
                    ? '<button class="btn-primary" type="button" '
                      + 'onclick="CampistryWorkspaceAdmin.newSandbox()">Start planning a session</button>'
                    : '')
               + '</div>';
        }

        rows.forEach(function (w) {
            var here = (w.id === current);
            var archived = (w.status === 'archived');
            h += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;'
               + 'border-radius:8px;border:1px solid var(--slate-200,#e2e8f0);margin-bottom:6px;'
               + 'background:' + (here ? '#FFFBEB' : '#fff') + '">'
               + '<strong style="flex:1;min-width:130px">' + esc(w.label)
               + (archived ? ' <span style="font-weight:400;color:var(--slate-500);font-size:.8rem">· past session</span>' : '')
               + '</strong>'
               + (here ? '<span style="font-size:.78rem;color:#92400E;font-weight:700">You are here</span>'
                       : '<button class="btn-edit" type="button" onclick="CampistryWorkspaceAdmin.go(\'' + esc(w.id) + '\')">Open</button>')
               // Making a PAST session official again is legitimate — it is how
               // you undo a promotion you did a day early — so it is offered,
               // with the same confirmation.
               + (canManage
                    ? '<button class="btn-edit" type="button" onclick="CampistryWorkspaceAdmin.promote(\'' + esc(w.id) + '\',\'' + esc(w.label) + '\')">Make official</button>'
                    + '<button class="btn-edit" type="button" style="color:#dc2626" onclick="CampistryWorkspaceAdmin.remove(\'' + esc(w.id) + '\',\'' + esc(w.label) + '\')">Delete</button>'
                    : '')
               + '</div>';
        });

        list.innerHTML = h;
    };

    A.newSandbox = async function () {
        var c = client(), id = campId();
        if (!c || !id) return say('Not connected.', true);
        var suggest = sessionNames();
        var label = await ask({
            title: 'Name this plan',
            bodyHtml: 'A plan is a full copy of your bunks, divisions, periods, routes and league '
                    + 'setup that you can build ahead of time. Nothing in it is live.'
                    + (suggest.length
                        ? '<br><br><span style="color:#64748B">Your sessions: '
                          + esc(suggest.join(', ')) + '</span>'
                        : ''),
            input: suggest[suggest.length - 1] || '2nd Half',
            placeholder: '2nd Half',
            okText: 'Create plan'
        });
        if (!label) return;
        label = String(label).trim();
        if (!label) return;

        var R = root.CampistryWorkspace;
        var wsId = R ? R.idFor(label) : label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        say('Copying the camp into "' + label + '"…');
        try {
            var res = await c.rpc('create_workspace', {
                p_camp_id: id, p_id: wsId, p_label: label,
                p_session: suggest.indexOf(label) >= 0 ? label : null
            });
            var d = res && res.data;
            if (!d || !d.success) {
                return say(d && d.error === 'already_exists'
                    ? 'A plan called that already exists.'
                    : 'Could not create the plan' + (d && d.error ? ': ' + d.error : '.'), true);
            }
            say('"' + label + '" created — ' + (d.copied || 0) + ' things copied. Open it to start planning.');
            A.render();
        } catch (e) {
            say('Could not create the plan — ' + (e && e.message ? e.message : 'unknown error'), true);
        }
    };

    A.go = function (ws) {
        if (root.CampistryWorkspaceUI) root.CampistryWorkspaceUI.switchTo(ws);
    };

    A.promote = async function (wsId, label) {
        var c = client(), id = campId();
        if (!c || !id) return say('Not connected.', true);

        // Two-step, and the second step is typed. This is the one action in the
        // app that changes what every screen, every counsellor's phone and every
        // printed sheet shows, and it is not undoable by a click — the outgoing
        // state is kept, but promoting back is another promotion.
        // One dialog, not three. The typed confirmation lives inside it, so the
        // warning a person is confirming is still on screen while they type.
        var go = await confirmBox({
            title: 'Make "' + label + '" the live camp?',
            bodyHtml: 'Every bunk list, schedule, bus route, period and division in Campistry '
                    + 'becomes this plan\'s, for everybody \u2014 staff, the counsellor app and '
                    + 'every printed sheet.<br><br>'
                    + 'What is live now is <strong>kept</strong> as a past session you can open '
                    + 'and look back at.<br><br>'
                    + '<strong>Campers, families and payments are not affected.</strong>',
            confirmWord: 'MAKE OFFICIAL',
            okText: 'Make official',
            danger: true
        });
        if (!go) return say('Cancelled.', true);

        var archiveLabel = await ask({
            title: 'Name the session being replaced',
            body: 'So you can find it later.',
            input: 'Before ' + label,
            okText: 'Switch over'
        });
        if (archiveLabel === null) return say('Cancelled.', true);

        say('Switching the camp over…');
        try {
            var res = await c.rpc('promote_workspace', {
                p_camp_id: id, p_id: wsId,
                p_archive_label: archiveLabel || null
            });
            var d = res && res.data;
            if (!d || !d.success) {
                return say('Could not switch' + (d && d.error ? ': ' + d.error : '.'), true);
            }
            say('"' + label + '" is now the live camp. The previous one is kept as "'
                + (d.archived_label || d.archived_as) + '".');
            // Everything on screen is now the wrong camp. Reload, for the same
            // reason switchTo does: a page half-hydrated from two different
            // sessions is exactly the confusion this feature exists to prevent.
            try { if (typeof root.flushPendingSettingsSync === 'function') root.flushPendingSettingsSync(); } catch (_) {}
            if (typeof root.campistrySetWorkspace === 'function') root.campistrySetWorkspace('live');
            setTimeout(function () { root.location.reload(); }, 900);
        } catch (e) {
            say('Could not switch — ' + (e && e.message ? e.message : 'unknown error'), true);
        }
    };

    A.remove = async function (wsId, label) {
        var c = client(), id = campId();
        if (!c || !id) return say('Not connected.', true);
        var go = await confirmBox({
            title: 'Delete the plan "' + label + '"?',
            bodyHtml: 'Its bunks, routes, periods and schedules are thrown away.<br><br>'
                    + 'The live camp is not touched.',
            okText: 'Delete plan',
            danger: true
        });
        if (!go) return;
        try {
            var res = await c.rpc('delete_workspace', { p_camp_id: id, p_id: wsId });
            var d = res && res.data;
            if (!d || !d.success) return say('Could not delete' + (d && d.error ? ': ' + d.error : '.'), true);
            say('"' + label + '" deleted.');
            A.render();
        } catch (e) {
            say('Could not delete — ' + (e && e.message ? e.message : 'unknown error'), true);
        }
    };

    root.CampistryWorkspaceAdmin = A;

    function boot() { setTimeout(function () { try { A.render(); } catch (e) {} }, 400); }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
})(typeof window !== 'undefined' ? window : null);
