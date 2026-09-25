// ============================================================================
// campistry_lite_admin.js — Campistry Lite control panel (desktop, owner-facing)
// ============================================================================
// campistry.org's own Lite surface is NOT the mobile tile launcher — every
// app already has its own full page here, so a second launcher would just
// be a watered-down duplicate. This page is the actual control panel FOR
// the on-the-go Lite/counselor experience:
//   Team & Signups      — every counselor invited to Lite, and whether
//                          they've actually signed in yet
//                          (camp_users.role='counselor').
//   What Counselors See — the visibility policy Lite enforces for
//                          counselors (campistryMe.counselorVisibility),
//                          grouped by area, plus which of their own app
//                          tabs (My Day/My Bunk/League/…) are turned on.
//                          Both live in the same policy object — field keys
//                          flat, tabs under policy.tabs — and both are read
//                          by campistry_lite.js's counselor experience
//                          (counselorTabs()/CampistryVisibility.isVisible()).
// ============================================================================

(function() {
    'use strict';

    var _counselors = [];   // camp_users rows, role='counselor'
    var _query = '';
    var _activePage = 'team';

    // Groups the flat CampistryVisibility catalogue into areas so the owner
    // can scan and act on a whole category at once instead of one long list.
    // A key not listed here (a future field) falls into "Other" rather than
    // vanishing — see OTHER_LABEL below.
    var CATEGORIES = [
        { label: 'Camp Life', keys: ['leagueTeam', 'swim', 'bunkmates', 'shirtSize'] },
        { label: 'Health & Safety', keys: ['allergies', 'dietary', 'medStatus', 'medications', 'medicalNotes', 'physician', 'emergency'] },
        { label: 'Family & Home', keys: ['parent', 'homeAddress', 'summerAddress'] },
        { label: 'Personal', keys: ['birthday', 'school'] },
        { label: 'Staff Notes', keys: ['notes'] }
    ];
    var OTHER_LABEL = 'Other';

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

    // ── What counselors can see (camper-detail fields, grouped) ──────────
    function visPolicy() {
        var me = (window.loadGlobalSettings && window.loadGlobalSettings('campistryMe')) || {};
        var V = window.CampistryVisibility;
        return me.counselorVisibility || (V ? V.defaults() : {});
    }
    async function savePolicy(pol) {
        var me = (window.loadGlobalSettings && window.loadGlobalSettings('campistryMe')) || {};
        me.counselorVisibility = pol;
        if (window.saveGlobalSettings) window.saveGlobalSettings('campistryMe', me);
    }

    function groupedFields(items) {
        var byKey = {}; items.forEach(function(f) { byKey[f.key] = f; });
        var used = {};
        var groups = CATEGORIES.map(function(cat) {
            var fields = cat.keys.map(function(k) { used[k] = true; return byKey[k]; }).filter(Boolean);
            return { label: cat.label, fields: fields };
        }).filter(function(g) { return g.fields.length; });
        var rest = items.filter(function(f) { return !used[f.key]; });
        if (rest.length) groups.push({ label: OTHER_LABEL, fields: rest });
        return groups;
    }

    function renderVisibility() {
        var V = window.CampistryVisibility;
        var body = $('laVisBody'), count = $('laVisCount');
        if (!V) { body.innerHTML = '<div class="empty-state">Visibility settings unavailable.</div>'; return; }
        var pol = visPolicy(), items = V.toggleable();
        var q = _query.toLowerCase();
        var visibleItems = q ? items.filter(function(f) { return f.label.toLowerCase().indexOf(q) >= 0; }) : items;
        var on = items.filter(function(f) { return V.isVisible(pol, f.key); }).length;
        count.textContent = on + ' of ' + items.length + ' camper details shared with every counselor';

        var groups = groupedFields(visibleItems);
        if (!groups.length) {
            body.innerHTML = '<div class="empty-state">No details match your search.</div>';
            return;
        }
        body.innerHTML = groups.map(function(g) {
            var rows = g.fields.map(function(f) {
                return '<div class="lite-adm-row" data-vis-key="' + esc(f.key) + '">'
                    + '<div class="lite-adm-row-title">' + esc(f.label) + '</div>'
                    + '<span class="toggle' + (V.isVisible(pol, f.key) ? ' on' : '') + '" data-vis-toggle="' + esc(f.key) + '"></span>'
                    + '</div>';
            }).join('');
            return '<div class="card"><div class="card-header"><h2>' + esc(g.label) + '</h2></div><div class="card-body">' + rows + '</div></div>';
        }).join('');

        body.querySelectorAll('[data-vis-toggle]').forEach(function(el) {
            el.addEventListener('click', function() {
                var pol2 = Object.assign({}, visPolicy());
                var key = el.getAttribute('data-vis-toggle');
                pol2[key] = !V.isVisible(pol2, key);
                savePolicy(pol2);
                renderVisibility();
            });
        });
    }

    function setAllFields(on) {
        var V = window.CampistryVisibility;
        if (!V) return;
        var pol = Object.assign({}, visPolicy());
        V.toggleable().forEach(function(f) { pol[f.key] = on; });
        savePolicy(pol);
        renderVisibility();
        toast(on ? 'Everything turned on' : 'Everything turned off');
    }

    // ── Counselor app features (which tabs a counselor sees at all) ─────
    // Static list, not read from LITE_APPS (this page never loads
    // campistry_lite.js) — kept in sync by hand since the counselor tab set
    // changes rarely. Keys match campistry_lite.js's LITE_APPS 'counselor'
    // entry's tab ids exactly; counselorTabs() there reads this same
    // policy.tabs object.
    var COUNSELOR_TABS = [
        { id: 'today', label: 'My Day' },
        { id: 'roster', label: 'My Bunk' },
        { id: 'league', label: 'League' },
        { id: 'tips', label: 'Tips' },
        { id: 'announcements', label: 'Messages' },
        { id: 'transport', label: 'Transport' }
    ];

    function renderTabs() {
        var body = $('laTabsBody');
        var pol = visPolicy();
        var tp = pol.tabs || {};
        body.innerHTML = COUNSELOR_TABS.map(function(t, i) {
            var on = tp[t.id] !== false;
            return '<div class="lite-adm-row" data-tab-key="' + esc(t.id) + '">'
                + '<div class="lite-adm-row-title">' + esc(t.label) + '</div>'
                + '<span class="toggle' + (on ? ' on' : '') + '" data-tab-toggle="' + esc(t.id) + '"></span>'
                + '</div>';
        }).join('');
        body.querySelectorAll('[data-tab-toggle]').forEach(function(el) {
            el.addEventListener('click', function() {
                var pol2 = Object.assign({}, visPolicy());
                var tp2 = Object.assign({}, pol2.tabs || {});
                var key = el.getAttribute('data-tab-toggle');
                tp2[key] = !(tp2[key] !== false);
                // Never let every tab go off — a counselor needs somewhere to land.
                var stillOn = COUNSELOR_TABS.filter(function(t) { return tp2[t.id] !== false; });
                if (!stillOn.length) { toast('At least one tab has to stay on', true); return; }
                pol2.tabs = tp2;
                savePolicy(pol2);
                renderTabs();
            });
        });
    }

    // ── Boot ──────────────────────────────────────────────────────────────
    async function refresh() {
        await loadCounselors();
        renderTeam();
        renderVisibility();
        renderTabs();
    }

    function onPageChange(page) {
        _activePage = page;
        var search = $('laHeaderSearch');
        if (search) search.placeholder = page === 'visibility' ? 'Search settings...' : 'Search counselors...';
    }

    async function init() {
        var ok = await ready();
        if (!ok) { toast('Could not load — check your connection and reload.', true); return; }
        var role = window.AccessControl.getCurrentRole ? window.AccessControl.getCurrentRole() : null;
        if (!HEAD_ROLES.includes(role)) {
            window.location.href = 'dashboard.html';
            return;
        }

        var search = $('laHeaderSearch');
        if (search) search.addEventListener('input', function() {
            _query = search.value.trim();
            if (_activePage === 'visibility') renderVisibility(); else renderTeam();
        });
        var allOn = $('laVisAllOn'); if (allOn) allOn.addEventListener('click', function() { setAllFields(true); });
        var allOff = $('laVisAllOff'); if (allOff) allOff.addEventListener('click', function() { setAllFields(false); });

        await refresh();
    }

    window.CampistryLiteAdmin = { init: init, refresh: refresh, onPageChange: onPageChange };
})();
