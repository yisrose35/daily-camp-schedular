// ============================================================================
// campistry_lite_admin.js — Campistry Lite control panel (desktop, owner-facing)
// ============================================================================
// campistry.org's own Lite surface is NOT the mobile tile launcher — every
// app already has its own full page here, so a second launcher would just
// be a watered-down duplicate. This page is the actual control panel FOR
// the on-the-go Lite/counselor experience:
//   Team & Signups     — every counselor invited to Lite, and whether they've
//                         actually signed in yet (camp_users.role='counselor').
//   What Counselors See — the visibility policy Lite enforces for counselors
//                         (campistryMe.counselorVisibility), same catalogue
//                         campistry_visibility.js already drives everywhere.
// ============================================================================

(function() {
    'use strict';

    var _counselors = [];   // camp_users rows, role='counselor'
    var _query = '';

    function $(id) { return document.getElementById(id); }
    function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
    function toast(msg, isError) {
        var t = $('laToast'); if (!t) return;
        t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
        setTimeout(function() { t.className = 'toast'; }, 2600);
    }

    // ── Auth / role gate ─────────────────────────────────────────────────
    // Same bar Lite's own office view uses (owner/admin/manager/scheduler);
    // a counselor has no reason to be on this page at all.
    var HEAD_ROLES = ['owner', 'admin', 'manager', 'scheduler'];

    async function ready() {
        var tries = 0;
        while (!window.AccessControl && tries < 60) { await new Promise(function(r){ setTimeout(r, 150); }); tries++; }
        if (!window.AccessControl) return false;
        try {
            if (!window.AccessControl.isInitialized) await window.AccessControl.initialize();
        } catch (e) { console.error('[LiteAdmin] AccessControl init failed:', e); }
        return true;
    }

    // ── Data: counselor roster ───────────────────────────────────────────
    async function loadCounselors() {
        var campId = window.AccessControl && window.AccessControl.getCampId && window.AccessControl.getCampId();
        if (!campId || !window.supabase) { _counselors = []; return; }
        try {
            var res = await window.supabase
                .from('camp_users')
                .select('id,name,email,user_id,accepted_at,invite_token,created_at')
                .eq('camp_id', campId)
                .eq('role', 'counselor')
                .order('name');
            if (res.error) throw res.error;
            _counselors = res.data || [];
        } catch (e) {
            console.error('[LiteAdmin] loadCounselors failed:', e);
            _counselors = [];
        }
    }

    function joined(row) { return !!(row.user_id || row.accepted_at); }

    function renderTeam() {
        var total = _counselors.length;
        var joinedN = _counselors.filter(joined).length;
        $('laStatTotal').textContent = total;
        $('laStatJoined').textContent = joinedN;
        $('laStatPending').textContent = total - joinedN;

        var q = _query.toLowerCase();
        var rows = _counselors.filter(function(r) {
            if (!q) return true;
            return String(r.name || '').toLowerCase().indexOf(q) >= 0 ||
                   String(r.email || '').toLowerCase().indexOf(q) >= 0;
        });

        var body = $('laTeamBody');
        if (!rows.length) {
            body.innerHTML = '<div class="empty-state">' + (total ? 'No counselors match your search.' : 'No counselors invited to Campistry Lite yet — invite them from Me → Hiring.') + '</div>';
            return;
        }
        var h = '<table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Invited</th><th></th></tr></thead><tbody>';
        rows.forEach(function(r) {
            var isJoined = joined(r);
            var invitedAt = r.created_at ? new Date(r.created_at).toLocaleDateString() : '—';
            var inviteUrl = r.invite_token ? (window.location.origin + '/invite.html?token=' + r.invite_token) : '';
            h += '<tr>'
                + '<td>' + esc(r.name || '(no name)') + '</td>'
                + '<td>' + esc(r.email || '') + '</td>'
                + '<td>' + (isJoined ? '<span class="badge badge-green">Signed up</span>' : '<span class="badge badge-amber">Invited — pending</span>') + '</td>'
                + '<td>' + invitedAt + '</td>'
                + '<td>' + (!isJoined && inviteUrl ? '<button class="btn btn-secondary btn-sm" data-copy="' + esc(inviteUrl) + '">Copy invite link</button>' : '') + '</td>'
                + '</tr>';
        });
        h += '</tbody></table>';
        body.innerHTML = h;

        body.querySelectorAll('[data-copy]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var url = btn.getAttribute('data-copy');
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(function(){ toast('Invite link copied'); }).catch(function(){ toast('Could not copy link', true); });
                } else {
                    toast('Invite link: ' + url);
                }
            });
        });
    }

    // ── What counselors can see ──────────────────────────────────────────
    function visPolicy() {
        var V = window.CampistryVisibility;
        if (!V) return {};
        var me = (window.loadGlobalSettings && window.loadGlobalSettings('campistryMe')) || {};
        return me.counselorVisibility || V.defaults();
    }
    async function saveVisPolicy(pol) {
        var me = (window.loadGlobalSettings && window.loadGlobalSettings('campistryMe')) || {};
        me.counselorVisibility = pol;
        if (window.saveGlobalSettings) window.saveGlobalSettings('campistryMe', me);
    }

    function renderVisibility() {
        var V = window.CampistryVisibility;
        var body = $('laVisBody'), count = $('laVisCount');
        if (!V) { body.innerHTML = '<div class="empty-state">Visibility settings unavailable.</div>'; return; }
        var pol = visPolicy(), items = V.toggleable();
        var on = items.filter(function(f){ return V.isVisible(pol, f.key); }).length;
        count.textContent = on + ' of ' + items.length + ' details shared';
        body.innerHTML = items.map(function(f) {
            return '<div class="lite-adm-row" data-vis-key="' + esc(f.key) + '">'
                + '<div class="lite-adm-row-title">' + esc(f.label) + '</div>'
                + '<span class="toggle' + (V.isVisible(pol, f.key) ? ' on' : '') + '" data-vis-toggle="' + esc(f.key) + '"></span>'
                + '</div>';
        }).join('');
        body.querySelectorAll('[data-vis-toggle]').forEach(function(el) {
            el.addEventListener('click', function() {
                var V2 = window.CampistryVisibility;
                var pol2 = Object.assign({}, visPolicy());
                var key = el.getAttribute('data-vis-toggle');
                pol2[key] = !V2.isVisible(pol2, key);
                saveVisPolicy(pol2);
                renderVisibility();
            });
        });
    }

    // ── Boot ──────────────────────────────────────────────────────────────
    async function refresh() {
        await loadCounselors();
        renderTeam();
        renderVisibility();
    }

    async function init() {
        var ok = await ready();
        if (!ok) { toast('Could not load — check your connection and reload.', true); return; }
        var role = window.AccessControl.getCurrentRole ? window.AccessControl.getCurrentRole() : null;
        if (!HEAD_ROLES.includes(role)) {
            window.location.href = 'dashboard.html';
            return;
        }
        var name = window.AccessControl.getUserName ? window.AccessControl.getUserName() : null;
        var emailEl = $('navUserEmail'); if (emailEl) emailEl.textContent = name || '';
        var avatar = $('liteAdmAvatar');
        if (avatar) avatar.textContent = (name || 'A').trim().split(/\s+/).map(function(p){ return p[0]; }).join('').slice(0, 2).toUpperCase();

        var search = $('laTeamSearch');
        if (search) search.addEventListener('input', function() { _query = search.value.trim(); renderTeam(); });

        await refresh();
    }

    window.CampistryLiteAdmin = { init: init, refresh: refresh };
})();
