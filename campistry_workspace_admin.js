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

        var res, d;
        try {
            res = await c.rpc('list_workspaces', { p_camp_id: id });
            d = res && res.data;
        } catch (e) { card.style.display = 'none'; return; }

        // not_authorized / not_owner: the card simply is not there. The server
        // refuses the writes anyway, so this is tidiness rather than security.
        if (!d || !d.success) { card.style.display = 'none'; return; }
        card.style.display = '';

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
            h += '<p style="color:var(--slate-500);font-size:.84rem;margin:6px 0 0">'
               + 'No plans yet. Make one when you want to start building next session.</p>';
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
               + '<button class="btn-edit" type="button" onclick="CampistryWorkspaceAdmin.promote(\'' + esc(w.id) + '\',\'' + esc(w.label) + '\')">Make official</button>'
               + '<button class="btn-edit" type="button" style="color:#dc2626" onclick="CampistryWorkspaceAdmin.remove(\'' + esc(w.id) + '\',\'' + esc(w.label) + '\')">Delete</button>'
               + '</div>';
        });

        list.innerHTML = h;
    };

    A.newSandbox = async function () {
        var c = client(), id = campId();
        if (!c || !id) return say('Not connected.', true);
        var suggest = sessionNames();
        var label = root.prompt(
            'Name this plan.' + (suggest.length ? ' Your sessions are: ' + suggest.join(', ') : ''),
            suggest[suggest.length - 1] || '2nd Half');
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
        if (!root.confirm(
            'Make "' + label + '" the live camp?\n\n' +
            'Every bunk list, schedule, bus route and division in Campistry becomes ' +
            'this plan\'s. What is live now is kept as a past session you can look ' +
            'back at.\n\n' +
            'Campers, families and payments are not affected.')) return;
        var typed = root.prompt('Type MAKE OFFICIAL to confirm.');
        if (String(typed || '').trim().toUpperCase() !== 'MAKE OFFICIAL') return say('Cancelled.', true);

        var archiveLabel = root.prompt(
            'What should the session being replaced be called, so you can find it later?',
            'Before ' + label);

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
        if (!root.confirm('Delete the plan "' + label + '"?\n\n' +
            'Its bunks, routes and schedules are thrown away. The live camp is not touched.')) return;
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
