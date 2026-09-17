/* =============================================================================
 * campistry_workspace_ui.js — the bar that makes it impossible to forget which
 * session you are editing.
 *
 * A sandbox that looks like the live camp is the ONE failure this feature must
 * not have. An office that spends an afternoon building next half's bunks in
 * what they thought was a sandbox, and was live, has wrecked the running camp;
 * an office that builds them in live thinking it was a sandbox has the same
 * problem from the other direction. So the indicator is not a subtle chip in a
 * corner — it is a full-width bar, a colour nothing else in the app uses, fixed
 * to the top, and it is on EVERY page rather than only the ones that happen to
 * remember to draw it.
 *
 * It mounts itself on load. There is nothing for a page to call and therefore
 * nothing a page can forget.
 *
 * In live it renders NOTHING — no bar, no layout shift, no spacer. A camp that
 * never uses this feature must not be able to tell it exists.
 * ========================================================================== */
(function (root) {
    'use strict';
    if (!root || !root.document) return;
    var doc = root.document;
    var U = {};

    var BAR_ID = 'campistry-workspace-bar';
    var _state = { workspaces: [], selected: 'live', label: '', session: '',
                   loaded: false, canManage: false };
    // Set once, so a reload to pick up the server's workspace can never become a
    // loop. It does not survive the reload it triggers, which is the point: after
    // that reload sessionStorage agrees with the server and the branch is not
    // reached again.
    var _reloadedForWs = false;

    function rule() { return root.CampistryWorkspace || null; }
    function current() {
        return (typeof root.campistryWorkspace === 'function') ? root.campistryWorkspace() : 'live';
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
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

    // ── the bar ────────────────────────────────────────────────────────────
    function render() {
        var R = rule();
        var ws = current();
        var existing = doc.getElementById(BAR_ID);

        // Live: no bar at all, and the spacer comes off with it.
        if (!R || R.isLive(ws)) {
            if (existing) existing.remove();
            doc.documentElement.style.removeProperty('--campistry-ws-bar-h');
            if (doc.body) doc.body.style.removeProperty('padding-top');
            return;
        }

        var info = R.banner({ workspace: ws, label: _state.label || ws });
        var bar = existing || doc.createElement('div');
        bar.id = BAR_ID;
        bar.setAttribute('role', 'status');
        bar.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483000',
            // Amber. Deliberately not any of the app's own palette: this must not
            // read as part of the page it is sitting on.
            'background:repeating-linear-gradient(135deg,#78350F 0 14px,#92400E 14px 28px)',
            'color:#FEF3C7', 'font-family:-apple-system,Segoe UI,Arial,sans-serif',
            'font-size:13px', 'line-height:1.35', 'padding:8px 14px',
            'display:flex', 'align-items:center', 'gap:12px', 'flex-wrap:wrap',
            'box-shadow:0 2px 10px rgba(0,0,0,.28)'
        ].join(';');

        var opts = '<option value="live">Live camp</option>';
        (_state.workspaces || []).forEach(function (w) {
            opts += '<option value="' + esc(w.id) + '"' + (w.id === ws ? ' selected' : '') + '>'
                 + esc(w.label) + (w.status === 'archived' ? ' (past)' : '') + '</option>';
        });

        // Which campers this sandbox is showing. Said out loud because it is the
        // one thing that is NOT a copy: the roster is live, and what a sandbox
        // changes is the DATE it is read at. An office building 2nd Half's bunks
        // needs to know it is looking at 2nd Half's children and not today's.
        var who = '';
        if (_state.session) {
            who = '<span style="background:#451A03;border:1px solid rgba(254,243,199,.45);'
                + 'border-radius:5px;padding:2px 8px;white-space:nowrap">Campers: '
                + esc(_state.session) + '</span>';
        }

        bar.innerHTML =
            '<strong style="font-weight:700;letter-spacing:.02em">PLANNING: '
                + esc(_state.label || ws).toUpperCase() + '</strong>'
            + who
            + '<span style="opacity:.92;flex:1;min-width:220px">' + esc(info.detail) + '</span>'
            + '<select id="' + BAR_ID + '-pick" style="font:inherit;padding:3px 7px;border-radius:5px;'
                + 'border:1px solid rgba(254,243,199,.5);background:#451A03;color:#FEF3C7">'
                + opts + '</select>'
            + '<button id="' + BAR_ID + '-live" style="font:inherit;font-weight:700;padding:4px 12px;'
                + 'border-radius:5px;border:0;cursor:pointer;background:#FEF3C7;color:#78350F">'
                + esc(info.action) + '</button>';

        if (!existing) doc.body.appendChild(bar);

        // Push the page down by the bar's real height, measured rather than
        // guessed: it wraps on a phone and a fixed guess would cover the header.
        var h = bar.offsetHeight || 38;
        doc.documentElement.style.setProperty('--campistry-ws-bar-h', h + 'px');
        doc.body.style.paddingTop = h + 'px';

        var pick = doc.getElementById(BAR_ID + '-pick');
        if (pick) pick.onchange = function () { U.switchTo(this.value); };
        var live = doc.getElementById(BAR_ID + '-live');
        if (live) live.onclick = function () { U.switchTo('live'); };
    }
    U.render = render;

    /**
     * Say something went wrong, without a blocking dialog.
     *
     * The bar is on every page and those pages do not share a modal, so this
     * prefers the app's toast, falls back to a line on the bar itself, and never
     * uses alert(): a modal browser dialog thrown up by a status bar is both out
     * of place and, on a phone, hard to get rid of.
     *
     * A failed switch is also self-evident — the bar has not changed and you are
     * still where you were — so this is a nudge, not the primary signal.
     */
    function trouble(msg) {
        try {
            if (typeof root.toast === 'function') { root.toast(msg, 'error'); return; }
        } catch (_) {}
        var bar = doc.getElementById(BAR_ID);
        if (bar) {
            var note = doc.getElementById(BAR_ID + '-note');
            if (!note) {
                note = doc.createElement('span');
                note.id = BAR_ID + '-note';
                note.style.cssText = 'background:#FEF3C7;color:#7F1D1D;border-radius:5px;'
                    + 'padding:2px 8px;font-weight:700';
                bar.appendChild(note);
            }
            note.textContent = msg;
            clearTimeout(note._t);
            note._t = setTimeout(function () { if (note.parentNode) note.remove(); }, 6000);
            return;
        }
        if (root.console) root.console.warn('[Workspace] ' + msg);
    }

    // ── talking to the server ──────────────────────────────────────────────
    U.refresh = async function () {
        var c = client(), id = campId();
        if (!c || !id) { _state.loaded = true; render(); return _state; }
        try {
            var res = await c.rpc('list_workspaces', { p_camp_id: id });
            var d = res && res.data;
            if (d && d.success) {
                _state.workspaces = d.workspaces || [];
                _state.loaded = true;
                // The SERVER decides what this user is looking at. If it says
                // live — because the sandbox was promoted or deleted while this
                // tab sat open — the tab moves to live rather than carrying on
                // writing to keys nothing owns any more.
                var serverWs = d.selected || 'live';
                // What this tab actually LOADED ITS DATA WITH, captured before we
                // overwrite it below.
                var bootWs = current();
                var found = (_state.workspaces || []).filter(function (w) { return w.id === serverWs; })[0];
                _state.selected = serverWs;
                _state.label = found ? found.label : '';
                _state.session = (found && found.session) || '';
                // Set the workspace even when the id has not changed: the SESSION
                // may have (a plan can be pointed at a different one), and presence
                // reads the session, not the id.
                if (typeof root.campistrySetWorkspace === 'function') {
                    root.campistrySetWorkspace(serverWs, _state.session);
                }

                // THE TAB BOOTED ON THE WRONG WORKSPACE'S DATA.
                //
                // The selection is kept per user ON THE SERVER, but this tab reads
                // it out of sessionStorage, which a brand new browser does not have.
                // So opening the app fresh while the server has you in a plan boots
                // the whole page on LIVE's keys, and then this function puts the
                // plan's bar on top of it — a page reading live, labelled as a plan.
                // Saving from there would write live's bunks into the plan.
                //
                // Same cure as switchTo's: reload, because every page hydrates its
                // operational state once at boot and nothing short of a reload
                // re-reads it.
                if (serverWs !== bootWs && !_reloadedForWs) {
                    // Only if the choice actually persisted. Where sessionStorage is
                    // unavailable — private windows, blocked site data — the reload
                    // would come back in exactly the same state and loop forever, so
                    // there we stay put and say so. The bar is still correct; it is
                    // the page under it that is stale.
                    var stuck = false;
                    try { stuck = (sessionStorage.getItem('campistry_workspace') || 'live') !== serverWs; }
                    catch (_) { stuck = true; }
                    if (stuck) {
                        if (root.console) {
                            root.console.warn('[Workspace] this tab loaded "' + bootWs + '" but the '
                                + 'server has you in "' + serverWs + '", and the choice will not '
                                + 'persist here — reload manually to see the right data.');
                        }
                        trouble('Showing the wrong session’s data — please reload.');
                    } else {
                        _reloadedForWs = true;
                        setTimeout(function () { root.location.reload(); }, 40);
                        return _state;
                    }
                }
            }
        } catch (e) {
            // A failed refresh must never leave a sandbox bar up for a workspace
            // we can no longer confirm, nor take one down for one we can. Leave
            // the last known state alone and say so in the console.
            if (root.console) root.console.warn('[Workspace] could not list workspaces:', e && e.message);
        }
        render();
        return _state;
    };

    /**
     * Move this browser to a workspace and reload.
     *
     * The reload is not laziness. Every page in this app hydrates its operational
     * state once at boot into module-level variables; swapping the underlying
     * keys underneath a live page would leave half the screen on one half's data
     * and half on the other, which is precisely the confusion this feature exists
     * to remove. A reload is the only honest way to change which camp you are
     * looking at.
     */
    U.switchTo = async function (ws) {
        var c = client(), id = campId();
        var target = (ws && String(ws)) || 'live';
        if (target === current()) return;
        if (c && id) {
            try {
                var res = await c.rpc('select_workspace', { p_camp_id: id, p_workspace: target });
                var d = res && res.data;
                if (d && !d.success) {
                    trouble('Could not switch: ' + (d.error || 'unknown'));
                    return;
                }
            } catch (e) {
                trouble('Could not switch sessions — check your connection and try again.');
                return;
            }
        }
        // Carry the target's session across the reload, so the page that comes
        // back already shows the right half's campers on its first render.
        var tgt = (_state.workspaces || []).filter(function (w) { return w.id === target; })[0];
        if (typeof root.campistrySetWorkspace === 'function') {
            root.campistrySetWorkspace(target, (tgt && tgt.session) || '');
        }
        // Flush anything queued before the keys move under us.
        try { if (typeof root.flushPendingSettingsSync === 'function') root.flushPendingSettingsSync(); } catch (_) {}
        setTimeout(function () { root.location.reload(); }, 60);
    };

    /** Called by the sync layer when it refuses a live-only write. */
    root.campistryWorkspaceRefused = function (keys, ws) {
        var R = rule();
        var msg = (R && R.canWrite(keys[0], ws).message) ||
                  'That change is live-only — switch back to the live session.';
        try {
            if (typeof root.toast === 'function') { root.toast(msg, 'error'); return; }
        } catch (_) {}
        if (root.console) root.console.warn('[Workspace] refused: ' + keys.join(', '));
    };

    U.state = function () { return _state; };

    // Mount as soon as there is a body to mount onto. Nothing to call, so
    // nothing to forget.
    function boot() {
        render();                 // instant, from sessionStorage — no flash of live
        U.refresh();              // then confirm with the server
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();

    root.CampistryWorkspaceUI = U;
})(typeof window !== 'undefined' ? window : null);
