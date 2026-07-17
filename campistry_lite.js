// ============================================================================
// CAMPISTRY LITE — mobile companion app
// ============================================================================
// Two experiences on one page, branched by role:
//
//   HEAD STAFF (owner / admin / scheduler)
//     Today      — any division/bunk's schedule for any date
//     Roster     — camper search + per-bunk browse
//     Staff      — counselor↔bunk assignments + counselor invites
//     Messaging  — SMS opt-in settings + daily activity text blast
//
//   COUNSELOR (new 'counselor' role, read-only)
//     Today      — their assigned bunk(s) schedule
//     Roster     — their bunk roster (contacts, allergies, dietary)
//     League     — their league team(s), standings, today's matchup
//
// Data sources (all existing):
//   daily_schedules      — via window.ScheduleDB.loadSchedule(dateKey)
//   camp_state_kv        — read directly (app1, campStructure, leaguesByName,
//                          specialtyLeagues) + two NEW keys owned by this app:
//                            liteStaffAssignments  { email: {name, phone, bunks[], smsOptIn} }
//                            liteSmsSettings       { enabled, audience, footer }
//   supabase edge fn     — send-sms (Twilio) for the daily activity texts
//
// Counselors are READ-ONLY by RLS (migration 015) and by access_control.js.
// All writes here happen from head-staff sessions only.
// ============================================================================

(function () {
    'use strict';

    const HEAD_ROLES = ['owner', 'admin', 'scheduler'];
    const KV_KEYS = ['app1', 'campStructure', 'leaguesByName', 'specialtyLeagues',
                     'liteStaffAssignments', 'liteSmsSettings'];
    const SMS_BATCH_SIZE = 100;

    // ─── State ──────────────────────────────────────────────────────────
    let campId = null;
    let role = null;
    let userEmail = null;
    let userName = null;

    const camp = {
        divisions: {},        // app1.divisions (grade-keyed: {parentDivision, bunks[]})
        structure: {},        // campStructure (parent-division-keyed)
        roster: {},           // app1.camperRoster ({ "First Last": {...} })
        leagues: {},          // leaguesByName
        specialty: {},        // specialtyLeagues (id-keyed)
        staff: {},            // liteStaffAssignments
        sms: { enabled: false, audience: 'counselors', footer: '' },
        stateLoaded: false,
        stateError: null
    };

    let currentDate = todayKey();
    let activeTab = 'today';
    let selectedDivision = null;      // head-staff Today/Roster division chip
    let rosterQuery = '';
    let nowTargetMin = null;          // Now/Locate time selection; null = live "now"
    let nowGroupBy = 'division';      // Now view grouping: 'division' | 'field'
    let locateQuery = '';
    let reportsDivision = null;       // Reports division selection
    let rotationData = null;          // cached RotationCloud.load() result
    const scheduleCache = {};         // dateKey -> merged schedule data (or null)
    const schedulePending = {};       // dateKey -> Promise

    // ════════════════════════════════════════════════════════════════════
    // BOOT
    // ════════════════════════════════════════════════════════════════════

    async function boot() {
        try {
            setSplash('Signing you in…');

            // Wait for the Supabase client (loaded just before this script)
            let tries = 0;
            while ((!window.supabase || !window.supabase.auth) && tries < 60) {
                await sleep(100);
                tries++;
            }
            if (!window.supabase || !window.supabase.auth) {
                setSplash('Could not start. Check your connection and reload.');
                return;
            }

            // Auth gate (same policy as flow.html/dashboard.js: only bounce to
            // login when there is genuinely no session and no cached auth)
            const cachedAuth = localStorage.getItem('campistry_auth_user_id');
            let session = null;
            try {
                const res = await window.supabase.auth.getSession();
                session = res?.data?.session || null;
            } catch (e) {
                console.warn('[Lite] getSession failed:', e);
            }
            if (!session && cachedAuth) {
                try {
                    const r = await window.supabase.auth.refreshSession();
                    session = r?.data?.session || null;
                } catch (_) { /* fall through */ }
            }
            if (!session) {
                localStorage.removeItem('campistry_auth_user_id');
                window.location.href = 'index.html';
                return;
            }
            userEmail = (session.user?.email || '').toLowerCase();

            window.supabase.auth.onAuthStateChange((event) => {
                if (event === 'SIGNED_OUT') window.location.href = 'index.html';
            });

            // Camp + role resolution
            setSplash('Loading your camp…');
            try { if (window.CampistryDB?.ready) await window.CampistryDB.ready; } catch (_) {}
            try { await window.AccessControl?.initialize?.(); } catch (e) { console.warn('[Lite] AccessControl init:', e); }

            campId = window.AccessControl?.getCampId?.()
                  || window.CampistryDB?.getCampId?.()
                  || localStorage.getItem('campistry_camp_id');
            role = window.AccessControl?.getCurrentRole?.()
                || window.CampistryDB?.getRole?.()
                || localStorage.getItem('campistry_role')
                || 'viewer';
            userName = window.AccessControl?.getUserName?.() || null;

            if (!campId) {
                setSplash('No camp found for this account. Ask your camp owner for an invite.');
                return;
            }

            // Camp state (structure, roster, leagues, Lite settings)
            await loadCampState();

            // Reveal app
            document.getElementById('liteCampName').textContent =
                window.AccessControl?.getCampName?.() || '';
            const badge = document.getElementById('liteRoleBadge');
            badge.textContent = roleLabel(role);
            document.getElementById('liteMenuUser').textContent = userEmail;
            if (!isHeadStaff()) {
                const dash = document.getElementById('liteMenuDashboard');
                if (dash) dash.style.display = 'none';
            }

            buildTabs();
            wireChrome();
            switchTab('today');

            document.getElementById('liteSplash').style.display = 'none';
            document.getElementById('liteApp').style.display = '';
        } catch (e) {
            console.error('[Lite] Boot failed:', e);
            setSplash('Something went wrong loading Campistry Lite. Pull to refresh or reload.');
        }
    }

    function isHeadStaff() { return HEAD_ROLES.includes(role); }
    function isCounselor() { return role === 'counselor'; }

    // ════════════════════════════════════════════════════════════════════
    // DATA
    // ════════════════════════════════════════════════════════════════════

    async function loadCampState() {
        try {
            const { data, error } = await window.supabase
                .from('camp_state_kv')
                .select('key, value')
                .eq('camp_id', campId)
                .in('key', KV_KEYS);

            if (error) throw error;

            const byKey = {};
            (data || []).forEach(r => { byKey[r.key] = r.value; });

            const app1 = byKey.app1 || {};
            camp.divisions = app1.divisions || {};
            camp.roster = app1.camperRoster || {};
            camp.structure = byKey.campStructure || {};
            camp.leagues = byKey.leaguesByName || {};
            camp.specialty = byKey.specialtyLeagues || {};
            camp.staff = byKey.liteStaffAssignments || {};
            camp.sms = Object.assign({ enabled: false, audience: 'counselors', footer: '' },
                                     byKey.liteSmsSettings || {});
            camp.stateLoaded = true;
            camp.stateError = null;

            // Some shared helpers (ScheduleDB merge prune, division lookups)
            // read window.divisions when present.
            window.divisions = camp.divisions;
        } catch (e) {
            // Viewers (and any RLS-denied role) still get schedule-only mode:
            // daily_schedules SELECT is role-agnostic, camp_state_kv is not.
            console.warn('[Lite] camp_state_kv read failed (schedule-only mode):', e?.message || e);
            camp.stateLoaded = false;
            camp.stateError = e?.message || String(e);
        }
    }

    async function saveKV(key, value) {
        const { error } = await window.supabase
            .from('camp_state_kv')
            .upsert(
                { camp_id: campId, key, value, updated_at: new Date().toISOString() },
                { onConflict: 'camp_id,key' }
            );
        if (error) throw error;
    }

    function getSchedule(dateKey) {
        if (Object.prototype.hasOwnProperty.call(scheduleCache, dateKey)) {
            return Promise.resolve(scheduleCache[dateKey]);
        }
        if (schedulePending[dateKey]) return schedulePending[dateKey];

        schedulePending[dateKey] = (async () => {
            try {
                if (!window.ScheduleDB?.loadSchedule) return null;
                const res = await window.ScheduleDB.loadSchedule(dateKey);
                const payload = (res && res.success && res.data) ? res.data : null;
                scheduleCache[dateKey] = payload;
                return payload;
            } catch (e) {
                console.warn('[Lite] loadSchedule failed:', e);
                return null;
            } finally {
                delete schedulePending[dateKey];
            }
        })();
        return schedulePending[dateKey];
    }

    function invalidateSchedule(dateKey) { delete scheduleCache[dateKey]; }

    // ─── Camp-structure helpers ─────────────────────────────────────────

    // Parent divisions in display order (campStructure preferred)
    function parentDivisions() {
        const fromStructure = Object.keys(camp.structure || {});
        if (fromStructure.length) return fromStructure;
        // Fallback: derive from grade-keyed app1.divisions
        const set = [];
        Object.entries(camp.divisions || {}).forEach(([gradeKey, d]) => {
            const p = d?.parentDivision || gradeKey;
            if (!set.includes(p)) set.push(p);
        });
        return set;
    }

    // All bunks under a parent division (union across its grades)
    function bunksForParent(parent) {
        const out = [];
        const s = camp.structure?.[parent];
        if (s && s.grades) {
            const order = s.gradeOrder || Object.keys(s.grades);
            order.forEach(g => (s.grades[g]?.bunks || []).forEach(b => { if (!out.includes(b)) out.push(b); }));
            if (out.length) return out;
        }
        Object.entries(camp.divisions || {}).forEach(([gradeKey, d]) => {
            const p = d?.parentDivision || gradeKey;
            if (p === parent) (d?.bunks || []).forEach(b => { if (!out.includes(b)) out.push(b); });
        });
        return out;
    }

    // The grade-level division key (matches divisionTimes/leagueAssignments keys)
    function divKeyForBunk(bunk) {
        for (const [key, d] of Object.entries(camp.divisions || {})) {
            if (Array.isArray(d?.bunks) && d.bunks.includes(bunk)) return key;
        }
        return null;
    }

    function parentForBunk(bunk) {
        const key = divKeyForBunk(bunk);
        if (key) return camp.divisions[key]?.parentDivision || key;
        const c = Object.values(camp.roster || {}).find(x => x?.bunk === bunk);
        return c?.division || null;
    }

    function allBunks() {
        const out = [];
        Object.values(camp.divisions || {}).forEach(d =>
            (d?.bunks || []).forEach(b => { if (!out.includes(b)) out.push(b); }));
        return out;
    }

    // Counselor's assigned bunks (from liteStaffAssignments, matched by email)
    function myBunks() {
        const rec = camp.staff?.[userEmail];
        return (rec && Array.isArray(rec.bunks)) ? rec.bunks.filter(Boolean) : [];
    }

    function campersInBunk(bunk) {
        return Object.entries(camp.roster || {})
            .filter(([, c]) => c && c.bunk === bunk)
            .map(([name, c]) => ({ name, ...c }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // ─── League helpers ─────────────────────────────────────────────────

    // Merged league list: [{name, teams[], divisions[], standings, sport}]
    function allLeagues() {
        const out = [];
        Object.values(camp.leagues || {}).forEach(l => {
            if (!l || l.enabled === false) return;
            out.push({
                name: l.name, teams: l.teams || [], divisions: l.divisions || [],
                standings: l.standings || {}, sports: l.sports || []
            });
        });
        Object.values(camp.specialty || {}).forEach(l => {
            if (!l || l.enabled === false) return;
            out.push({
                name: l.name, teams: l.teams || [], divisions: l.divisions || [],
                standings: l.standings || {}, sports: l.sport ? [l.sport] : [], specialty: true
            });
        });
        return out;
    }

    // A bunk's team in a league = majority vote across its campers' teams
    // (team membership is stored per-camper; a well-formed camp is unanimous)
    function bunkTeamForLeague(bunk, leagueName) {
        const votes = {};
        campersInBunk(bunk).forEach(c => {
            const t = (c.teams && c.teams[leagueName]) || c.team;
            if (t) votes[t] = (votes[t] || 0) + 1;
        });
        let best = null, n = 0;
        Object.entries(votes).forEach(([t, v]) => { if (v > n) { best = t; n = v; } });
        return best;
    }

    // ════════════════════════════════════════════════════════════════════
    // CHROME (header, menu, tabs)
    // ════════════════════════════════════════════════════════════════════

    const TAB_ICONS = {
        today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
        now: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
        locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
        roster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        league: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
        staff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/><path d="M19 8h4"/><path d="M21 6v4"/></svg>',
        messaging: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };

    function tabsForRole() {
        // Flow Lite: comprehensive, read-only, on-the-go view of all of Flow.
        // Head staff AND viewers get the full read-only picture ("see everything").
        if (isHeadStaff() || isViewerRole()) {
            return [
                { id: 'today', label: 'Schedule' },
                { id: 'now', label: 'Now' },
                { id: 'locate', label: 'Locate' },
                { id: 'reports', label: 'Reports' }
            ];
        }
        // Counselor keeps their bunk-level personal companion.
        return [
            { id: 'today', label: 'My Day' },
            { id: 'roster', label: 'My Bunk' },
            { id: 'league', label: 'League' }
        ];
    }

    function isViewerRole() { return !isHeadStaff() && !isCounselor(); }

    function buildTabs() {
        const bar = document.getElementById('liteTabbar');
        bar.innerHTML = '';
        tabsForRole().forEach(t => {
            const btn = document.createElement('button');
            btn.className = 'lite-tab';
            btn.dataset.tab = t.id;
            btn.innerHTML = `${TAB_ICONS[t.id] || ''}<span>${esc(t.label)}</span>`;
            btn.addEventListener('click', () => switchTab(t.id));
            bar.appendChild(btn);
        });
    }

    function switchTab(id) {
        activeTab = id;
        document.querySelectorAll('.lite-tab').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === id));
        document.querySelectorAll('.lite-view').forEach(v => { v.style.display = 'none'; });
        const view = document.getElementById('view-' + id);
        if (view) view.style.display = '';
        renderView(id);
        try { window.scrollTo({ top: 0 }); } catch (_) {}
    }

    function renderView(id) {
        if (id === 'today') renderToday();
        else if (id === 'now') renderNow();
        else if (id === 'locate') renderLocate();
        else if (id === 'reports') renderReports();
        else if (id === 'roster') renderRoster();
        else if (id === 'league') renderLeague();
        else if (id === 'staff') renderStaff();
        else if (id === 'messaging') renderMessaging();
    }

    function wireChrome() {
        const menu = document.getElementById('liteMenu');
        document.getElementById('liteMenuBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === 'none' ? '' : 'none';
        });
        document.addEventListener('click', () => { menu.style.display = 'none'; });
        menu.addEventListener('click', (e) => e.stopPropagation());

        document.getElementById('liteSignOut').addEventListener('click', async () => {
            try { await window.supabase.auth.signOut(); } catch (_) {}
            ['campistry_auth_user_id', 'campistry_camp_id', 'campistry_role',
             'campistry_user_id', 'campistry_is_team_member'].forEach(k => {
                try { localStorage.removeItem(k); } catch (_) {}
            });
            window.location.href = 'index.html';
        });
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: TODAY (schedule)
    // ════════════════════════════════════════════════════════════════════

    async function renderToday() {
        const view = document.getElementById('view-today');
        view.innerHTML = dateStripHTML() + `<div id="liteTodayBody">${loadingHTML()}</div>`;
        wireDateStrip(view, () => renderToday());

        const body = view.querySelector('#liteTodayBody');
        const sched = await getSchedule(currentDate);
        if (activeTab !== 'today') return; // user navigated away mid-fetch

        let bunks;
        if (isCounselor()) {
            bunks = myBunks();
            if (!bunks.length) {
                body.innerHTML = emptyHTML('🏕️',
                    'No bunk assigned to you yet.<br>Ask your head staff to assign your bunk in Campistry Lite → Staff.');
                return;
            }
        } else {
            // Head staff / viewer: division chips + that division's bunks
            const parents = parentDivisions();
            const schedBunks = sched ? Object.keys(sched.scheduleAssignments || {}) : [];
            if (!parents.length && !schedBunks.length) {
                body.innerHTML = emptyHTML('📭', 'No schedule found for this day.');
                return;
            }
            if (parents.length) {
                if (!selectedDivision || !parents.includes(selectedDivision)) selectedDivision = parents[0];
                body.innerHTML = chipRowHTML(parents, selectedDivision) + '<div id="liteDivBunks"></div>';
                body.querySelectorAll('.lite-chip').forEach(ch =>
                    ch.addEventListener('click', () => { selectedDivision = ch.dataset.val; renderToday(); }));
                bunks = bunksForParent(selectedDivision);
            } else {
                bunks = schedBunks.sort();
            }
        }

        const target = body.querySelector('#liteDivBunks') || body;
        if (!sched || !sched.scheduleAssignments) {
            target.innerHTML = emptyHTML('📭', `No schedule published for ${friendlyDate(currentDate)} yet.`);
            return;
        }

        const cards = bunks.map(b => bunkCardHTML(b, sched)).join('');
        target.innerHTML = cards || emptyHTML('📭', 'No bunks in this division.');
    }

    function bunkCardHTML(bunk, sched) {
        const entries = normalizeBunkEntries(bunk, sched);
        const parent = parentForBunk(bunk);
        let rows;
        if (!entries.length) {
            rows = `<div class="lite-empty" style="padding:18px;">No activities scheduled.</div>`;
        } else {
            const nowMin = nowMinutes();
            const isToday = currentDate === todayKey();
            rows = entries.map(e => {
                const isNow = isToday && e.startMin != null && e.endMin != null
                    && nowMin >= e.startMin && nowMin < e.endMin;
                let bodyHtml = `<div class="lite-slot-activity">${esc(e.title)}</div>`;
                if (e.location && e.location !== e.title) {
                    bodyHtml += `<div class="lite-slot-loc">📍 ${esc(e.location)}</div>`;
                }
                if (e.league) {
                    const team = bunkTeamForLeague(bunk, e.league);
                    bodyHtml = `<span class="lite-league-badge">League · ${esc(e.league)}</span>` + bodyHtml;
                    (e.matchups || []).forEach(m => {
                        const mine = team && m.toLowerCase().includes(team.toLowerCase());
                        bodyHtml += `<div class="lite-matchup${mine ? ' mine' : ''}">${mine ? '⭐ ' : ''}${esc(m)}</div>`;
                    });
                }
                return `<div class="lite-slot${isNow ? ' now' : ''}">
                    <div class="lite-slot-time">
                        <div class="t1">${e.startMin != null ? esc(fmtMin(e.startMin)) : '—'}</div>
                        <div class="t2">${e.endMin != null ? esc(fmtMin(e.endMin)) : ''}</div>
                    </div>
                    <div class="lite-slot-body">${bodyHtml}</div>
                </div>`;
            }).join('');
        }
        return `<div class="lite-card lite-bunk-card">
            <div class="lite-bunk-head">
                <span class="lite-bunk-name">${esc(bunk)}</span>
                ${parent ? `<span class="lite-bunk-div">${esc(parent)}</span>` : ''}
            </div>
            ${rows}
        </div>`;
    }

    // Turn scheduleAssignments[bunk] into clean, sorted display rows
    function normalizeBunkEntries(bunk, sched) {
        const raw = (sched.scheduleAssignments || {})[bunk];
        if (!Array.isArray(raw)) return [];
        const divKey = divKeyForBunk(bunk);
        const divSlots = (sched.divisionTimes || {})[divKey] || [];

        const out = [];
        raw.forEach((e, idx) => {
            if (!e || e.continuation) return;
            let startMin = numOrNull(e._startMin);
            let endMin = numOrNull(e._endMin);
            if (startMin == null && divSlots[idx]) {
                startMin = numOrNull(divSlots[idx].startMin);
                endMin = numOrNull(divSlots[idx].endMin);
            }
            // Extend end time across continuation slots that carry their own times
            for (let j = idx + 1; j < raw.length; j++) {
                const c = raw[j];
                if (!c || !c.continuation) break;
                const ce = numOrNull(c._endMin);
                if (ce != null && (endMin == null || ce > endMin)) endMin = ce;
            }

            const isLeague = !!(e._h2h || e._leagueName ||
                (typeof e.field === 'string' && e.field.startsWith('League: ')));
            const location = fieldLabel(e.field);
            let title;
            if (isLeague) {
                title = e._gameLabel || e.sport || e._leagueName || 'League Game';
            } else {
                title = e.sport || e._activity || location || 'Activity';
            }
            out.push({
                title,
                location: isLeague ? null : location,
                startMin, endMin,
                league: isLeague ? (e._leagueName || String(e.field || '').replace(/^League:\s*/, '')) : null,
                matchups: isLeague ? (e._allMatchups || []) : null
            });
        });
        out.sort((a, b) => (a.startMin ?? 99999) - (b.startMin ?? 99999));
        return out;
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: ROSTER
    // ════════════════════════════════════════════════════════════════════

    function renderRoster() {
        const view = document.getElementById('view-roster');

        if (!camp.stateLoaded) {
            view.innerHTML = emptyHTML('🔒', 'Roster data isn\'t available for your role.');
            return;
        }

        if (isCounselor()) {
            const bunks = myBunks();
            if (!bunks.length) {
                view.innerHTML = emptyHTML('🏕️', 'No bunk assigned to you yet.');
                return;
            }
            view.innerHTML = bunks.map(b => {
                const campers = campersInBunk(b);
                return `<div class="lite-section-label">${esc(b)} · ${campers.length} camper${campers.length === 1 ? '' : 's'}</div>`
                    + (campers.length
                        ? campers.map(camperCardHTML).join('')
                        : emptyHTML('🧒', 'No campers in the roster for this bunk yet.'));
            }).join('');
            wireCamperCards(view);
            return;
        }

        // Head staff / viewer: search + division browse
        const parents = parentDivisions();
        if (!selectedDivision || !parents.includes(selectedDivision)) selectedDivision = parents[0] || null;
        view.innerHTML = `
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteRosterSearch" type="search"
                       placeholder="Search campers…" value="${esc(rosterQuery)}">
            </div>
            <div id="liteRosterBody"></div>`;

        const input = view.querySelector('#liteRosterSearch');
        input.addEventListener('input', () => {
            rosterQuery = input.value;
            renderRosterBody(view.querySelector('#liteRosterBody'), parents);
        });
        renderRosterBody(view.querySelector('#liteRosterBody'), parents);
    }

    function renderRosterBody(body, parents) {
        const q = rosterQuery.trim().toLowerCase();
        if (q) {
            const hits = Object.entries(camp.roster || {})
                .filter(([name]) => name.toLowerCase().includes(q))
                .map(([name, c]) => ({ name, ...c }))
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, 50);
            body.innerHTML = hits.length
                ? hits.map(camperCardHTML).join('')
                : emptyHTML('🔍', 'No campers match your search.');
            wireCamperCards(body);
            return;
        }

        if (!parents.length) {
            body.innerHTML = emptyHTML('🧒', 'No camp structure set up yet.');
            return;
        }
        let html = chipRowHTML(parents, selectedDivision) + '<div id="liteRosterBunks"></div>';
        body.innerHTML = html;
        body.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { selectedDivision = ch.dataset.val; renderRosterBody(body, parents); }));

        const holder = body.querySelector('#liteRosterBunks');
        holder.innerHTML = bunksForParent(selectedDivision).map(b => {
            const campers = campersInBunk(b);
            return `<div class="lite-section-label">${esc(b)} · ${campers.length}</div>`
                + campers.map(camperCardHTML).join('');
        }).join('') || emptyHTML('🧒', 'No bunks in this division.');
        wireCamperCards(holder);
    }

    function camperCardHTML(c) {
        const flags = [];
        if (c.allergies) flags.push('<span class="lite-flag">Allergy</span>');
        if (c.dietary) flags.push('<span class="lite-flag diet">Dietary</span>');
        const details = [];
        if (c.allergies) details.push(dtdd('Allergies', c.allergies));
        if (c.medications) details.push(dtdd('Medications', c.medications));
        if (c.dietary) details.push(dtdd('Dietary', c.dietary));
        if (c.parent1Name || c.parent1Phone) {
            details.push(dtdd('Parent', `${esc(c.parent1Name || '')}${c.parent1Phone
                ? ` · <a href="tel:${esc(c.parent1Phone)}">${esc(c.parent1Phone)}</a>` : ''}`, true));
        }
        if (c.emergencyName || c.emergencyPhone) {
            details.push(dtdd('Emergency', `${esc(c.emergencyName || '')}${c.emergencyRel ? ` (${esc(c.emergencyRel)})` : ''}${c.emergencyPhone
                ? ` · <a href="tel:${esc(c.emergencyPhone)}">${esc(c.emergencyPhone)}</a>` : ''}`, true));
        }
        const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
        return `<div class="lite-card lite-camper">
            <button class="lite-camper-row" type="button">
                <span>
                    <span class="lite-camper-name">${esc(c.name)}</span>
                    ${meta ? `<div class="lite-camper-meta">${esc(meta)}</div>` : ''}
                </span>
                <span class="lite-camper-flags">${flags.join('')}</span>
            </button>
            <div class="lite-camper-details" style="display:none;">
                ${details.length ? `<dl style="margin:0;">${details.join('')}</dl>`
                                 : '<div style="padding-top:10px;">No additional info on file.</div>'}
            </div>
        </div>`;
    }

    function dtdd(label, value, isHtml) {
        return `<dt>${esc(label)}</dt><dd>${isHtml ? value : esc(value)}</dd>`;
    }

    function wireCamperCards(root) {
        root.querySelectorAll('.lite-camper-row').forEach(row => {
            row.addEventListener('click', () => {
                const d = row.parentElement.querySelector('.lite-camper-details');
                if (d) d.style.display = d.style.display === 'none' ? '' : 'none';
            });
        });
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: LEAGUE (counselor)
    // ════════════════════════════════════════════════════════════════════

    async function renderLeague() {
        const view = document.getElementById('view-league');
        const bunks = myBunks();
        if (!camp.stateLoaded) {
            view.innerHTML = emptyHTML('🔒', 'League data isn\'t available for your role.');
            return;
        }
        if (!bunks.length) {
            view.innerHTML = emptyHTML('🏕️', 'No bunk assigned to you yet.');
            return;
        }

        view.innerHTML = loadingHTML();
        const sched = await getSchedule(todayKey());
        if (activeTab !== 'league') return;

        const sections = [];
        bunks.forEach(bunk => {
            const parent = parentForBunk(bunk);
            const divKey = divKeyForBunk(bunk);
            allLeagues().forEach(lg => {
                // League applies if its divisions[] mention the bunk's parent
                // division or grade-key (or it has no division scoping at all)
                const divs = lg.divisions || [];
                const applies = !divs.length || divs.includes(parent) || divs.includes(divKey);
                if (!applies) return;

                const team = bunkTeamForLeague(bunk, lg.name);
                const rec = team && lg.standings ? lg.standings[team] : null;
                const recTxt = rec ? `${rec.w ?? 0}W – ${rec.l ?? 0}L${rec.t ? ` – ${rec.t}T` : ''}` : '';

                // Today's matchup for this league from the bunk's schedule
                let matchupHtml = '';
                if (sched) {
                    const entries = normalizeBunkEntries(bunk, sched)
                        .filter(e => e.league === lg.name);
                    entries.forEach(e => {
                        (e.matchups || []).forEach(m => {
                            const mine = team && m.toLowerCase().includes(team.toLowerCase());
                            matchupHtml += `<div class="lite-matchup${mine ? ' mine' : ''}">${mine ? '⭐ ' : ''}${esc(m)}${e.startMin != null ? ` · ${esc(fmtMin(e.startMin))}` : ''}</div>`;
                        });
                    });
                }

                const standRows = Object.entries(lg.standings || {})
                    .map(([t, s]) => ({ t, w: s?.w ?? 0, l: s?.l ?? 0, tie: s?.t ?? 0 }))
                    .sort((a, b) => b.w - a.w || a.l - b.l)
                    .map(r => `<tr class="${team && r.t === team ? 'mine' : ''}">
                        <td>${esc(r.t)}</td><td>${r.w}</td><td>${r.l}</td><td>${r.tie}</td></tr>`)
                    .join('');

                sections.push(`<div class="lite-card">
                    <div class="lite-team-hero">
                        <div class="league">${esc(lg.name)}${bunks.length > 1 ? ` · ${esc(bunk)}` : ''}</div>
                        <div class="team">${team ? esc(team) : 'No team assigned'}</div>
                        ${recTxt ? `<div class="record">${esc(recTxt)}</div>` : ''}
                    </div>
                    ${matchupHtml ? `<div class="lite-section-label" style="margin-top:0;">Today's game</div>${matchupHtml}` : ''}
                    ${standRows ? `<div class="lite-section-label">Standings</div>
                        <table class="lite-standings">
                            <thead><tr><th>Team</th><th>W</th><th>L</th><th>T</th></tr></thead>
                            <tbody>${standRows}</tbody>
                        </table>` : ''}
                </div>`);
            });
        });

        view.innerHTML = sections.join('')
            || emptyHTML('🏆', 'No leagues are set up for your division yet.');
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: STAFF (head staff — counselor assignments + invites)
    // ════════════════════════════════════════════════════════════════════

    function canEditStaff() { return isHeadStaff(); }

    async function renderStaff() {
        const view = document.getElementById('view-staff');
        if (!canEditStaff()) { view.innerHTML = emptyHTML('🔒', 'Head staff only.'); return; }

        // Which counselor invites exist / are accepted (best effort)
        let members = [];
        try {
            const { data } = await window.supabase
                .from('camp_users')
                .select('email, name, role, accepted_at, invite_token')
                .eq('camp_id', campId)
                .eq('role', 'counselor');
            members = data || [];
        } catch (_) { /* non-fatal */ }
        if (activeTab !== 'staff') return;

        const byEmail = {};
        members.forEach(m => { byEmail[(m.email || '').toLowerCase()] = m; });

        const emails = Object.keys(camp.staff || {}).sort();
        const rows = emails.map(email => {
            const rec = camp.staff[email] || {};
            const member = byEmail[email];
            const status = member
                ? (member.accepted_at
                    ? '<span class="lite-pill green">Joined</span>'
                    : '<span class="lite-pill gray">Invited</span>')
                : '<span class="lite-pill gray">Not invited</span>';
            const bunkPills = (rec.bunks || []).map(b => `<span class="lite-pill">${esc(b)}</span>`).join('')
                || '<span class="lite-pill gray">No bunk</span>';
            return `<div class="lite-card lite-staff-row" data-email="${esc(email)}">
                <div class="lite-staff-info">
                    <div class="lite-staff-name">${esc(rec.name || email)}</div>
                    <div class="lite-staff-meta">${esc(email)}${rec.phone ? ` · ${esc(rec.phone)}` : ''}</div>
                    <div>${bunkPills} ${status} ${rec.smsOptIn ? '<span class="lite-pill green">SMS ✓</span>' : ''}</div>
                </div>
                <button class="lite-btn secondary" style="min-height:38px;padding:0 14px;font-size:0.82rem;" data-edit="${esc(email)}">Edit</button>
            </div>`;
        }).join('');

        view.innerHTML = `
            <button class="lite-btn block" id="liteAddStaff">＋ Add counselor</button>
            <div class="lite-note">Counselors sign in with their own account and see only their
            assigned bunk's schedule, roster and league team.
            ${window.AccessControl?.canInviteUsers?.() ? '' :
              'Only the camp <b>owner</b> can send new invites — you can still assign bunks here.'}</div>
            <div class="lite-section-label">Counselors</div>
            ${rows || emptyHTML('👋', 'No counselors yet. Tap "Add counselor" to set one up.')}`;

        view.querySelector('#liteAddStaff').addEventListener('click', () => staffSheet(null));
        view.querySelectorAll('[data-edit]').forEach(btn =>
            btn.addEventListener('click', () => staffSheet(btn.dataset.edit)));
    }

    function staffSheet(email) {
        const existing = email ? (camp.staff[email] || {}) : {};
        const bunks = allBunks();
        const chosen = new Set(existing.bunks || []);

        const sheet = openSheet(`
            <h3 class="lite-sheet-title">${email ? 'Edit counselor' : 'Add counselor'}</h3>
            <div class="lite-field"><label>Name</label>
                <input class="lite-input" id="stName" value="${esc(existing.name || '')}" placeholder="First Last"></div>
            <div class="lite-field"><label>Email (their login)</label>
                <input class="lite-input" id="stEmail" type="email" value="${esc(email || '')}"
                       ${email ? 'disabled' : ''} placeholder="counselor@example.com"></div>
            <div class="lite-field"><label>Mobile phone (for SMS)</label>
                <input class="lite-input" id="stPhone" type="tel" value="${esc(existing.phone || '')}" placeholder="+1 555 123 4567"></div>
            <div class="lite-field"><label>Assigned bunk(s)</label>
                <div class="lite-bunk-picker" id="stBunks">
                    ${bunks.map(b => `<button type="button" class="lite-chip${chosen.has(b) ? ' active' : ''}" data-b="${esc(b)}">${esc(b)}</button>`).join('')
                      || '<span class="lite-note">No bunks configured yet (set up divisions in Campistry Me).</span>'}
                </div></div>
            <div class="lite-field" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <label style="margin:0;">Receives daily schedule texts</label>
                <label class="lite-switch"><input type="checkbox" id="stSms" ${existing.smsOptIn ? 'checked' : ''}><span class="slider"></span></label>
            </div>
            <div id="stError" class="lite-warn" style="display:none;"></div>
            <div style="display:flex;gap:10px;margin-top:14px;">
                ${email ? '<button class="lite-btn danger" id="stDelete">Remove</button>' : ''}
                <button class="lite-btn" style="flex:1;" id="stSave">${email ? 'Save' : 'Save & invite'}</button>
            </div>`);

        sheet.querySelectorAll('#stBunks .lite-chip').forEach(ch =>
            ch.addEventListener('click', () => {
                const b = ch.dataset.b;
                if (chosen.has(b)) { chosen.delete(b); ch.classList.remove('active'); }
                else { chosen.add(b); ch.classList.add('active'); }
            }));

        const showErr = (msg) => {
            const el = sheet.querySelector('#stError');
            el.innerHTML = msg; el.style.display = '';
        };

        if (email) {
            sheet.querySelector('#stDelete').addEventListener('click', async () => {
                delete camp.staff[email];
                try {
                    await saveKV('liteStaffAssignments', camp.staff);
                    closeSheet(); toast('Counselor removed'); renderStaff();
                } catch (e) { showErr('Could not save: ' + esc(e.message)); }
            });
        }

        sheet.querySelector('#stSave').addEventListener('click', async () => {
            const name = sheet.querySelector('#stName').value.trim();
            const em = (email || sheet.querySelector('#stEmail').value).trim().toLowerCase();
            const phone = sheet.querySelector('#stPhone').value.trim();
            const smsOptIn = sheet.querySelector('#stSms').checked;
            if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { showErr('Enter a valid email address.'); return; }

            camp.staff[em] = { name, phone, bunks: [...chosen], smsOptIn };
            const btn = sheet.querySelector('#stSave');
            btn.disabled = true; btn.textContent = 'Saving…';
            try {
                await saveKV('liteStaffAssignments', camp.staff);
            } catch (e) {
                btn.disabled = false; btn.textContent = 'Save';
                showErr('Could not save: ' + esc(e.message));
                return;
            }

            // New counselor + caller is owner → create the invite too
            let inviteMsg = '';
            if (!email && window.AccessControl?.canInviteUsers?.()) {
                try {
                    const res = await window.AccessControl.inviteTeamMember(em, 'counselor', [], name);
                    if (res?.inviteUrl) {
                        inviteMsg = res.inviteUrl;
                        // Best-effort invite email (same edge fn the team UI uses)
                        try {
                            await window.supabase.functions.invoke('send-invite-email', {
                                body: { email: em, inviteUrl: res.inviteUrl, role: 'Counselor', invitedBy: userName || userEmail }
                            });
                        } catch (_) {}
                    } else if (res?.error && !/already been invited/i.test(res.error)) {
                        console.warn('[Lite] invite failed:', res.error);
                    }
                } catch (e) { console.warn('[Lite] invite failed:', e); }
            }

            closeSheet();
            renderStaff();
            if (inviteMsg) {
                try { await navigator.clipboard.writeText(inviteMsg); toast('Saved — invite link copied to clipboard'); }
                catch (_) { toast('Saved — invite sent'); }
            } else {
                toast('Saved');
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: MESSAGING (head staff — SMS settings + daily blast)
    // ════════════════════════════════════════════════════════════════════

    async function renderMessaging() {
        const view = document.getElementById('view-messaging');
        if (!isHeadStaff()) { view.innerHTML = emptyHTML('🔒', 'Head staff only.'); return; }

        const s = camp.sms;
        view.innerHTML = `
            <div class="lite-card">
                <div class="lite-card-title">Daily schedule texts</div>
                <div class="lite-field" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                    <label style="margin:0;">Camp opted in to SMS</label>
                    <label class="lite-switch"><input type="checkbox" id="smsEnabled" ${s.enabled ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="lite-field"><label>Send to</label>
                    <select class="lite-select" id="smsAudience">
                        <option value="counselors" ${s.audience === 'counselors' ? 'selected' : ''}>Counselors (opted-in staff)</option>
                        <option value="parents" ${s.audience === 'parents' ? 'selected' : ''}>Parents (camper contacts)</option>
                        <option value="both" ${s.audience === 'both' ? 'selected' : ''}>Counselors + parents</option>
                    </select></div>
                <div class="lite-field"><label>Footer (optional, added to every text)</label>
                    <input class="lite-input" id="smsFooter" value="${esc(s.footer || '')}" placeholder="e.g. Reply STOP to opt out"></div>
                <button class="lite-btn block secondary" id="smsSaveSettings">Save settings</button>
                <div class="lite-note">Each person gets their own text listing that day's activities
                for their bunk. Sending uses your camp's Twilio account via the
                <code>send-sms</code> function — see CAMPISTRY_LITE.md for setup.
                Only text people who have agreed to receive messages.</div>
            </div>

            <div class="lite-card">
                <div class="lite-card-title">Send today's schedule</div>
                <div id="smsBlastBody">${loadingHTML()}</div>
            </div>

            <div class="lite-card">
                <div class="lite-card-title">Test message</div>
                <div class="lite-field"><label>Phone number</label>
                    <input class="lite-input" id="smsTestPhone" type="tel" placeholder="+1 555 123 4567"></div>
                <button class="lite-btn block secondary" id="smsTestSend">Send me a test</button>
            </div>`;

        view.querySelector('#smsSaveSettings').addEventListener('click', async (ev) => {
            camp.sms = {
                enabled: view.querySelector('#smsEnabled').checked,
                audience: view.querySelector('#smsAudience').value,
                footer: view.querySelector('#smsFooter').value.trim()
            };
            const b = ev.currentTarget; b.disabled = true;
            try { await saveKV('liteSmsSettings', camp.sms); toast('Settings saved'); renderMessaging(); }
            catch (e) { toast('Save failed: ' + e.message); b.disabled = false; }
        });

        view.querySelector('#smsTestSend').addEventListener('click', async (ev) => {
            const phone = view.querySelector('#smsTestPhone').value.trim();
            if (!phone) { toast('Enter a phone number first'); return; }
            const b = ev.currentTarget; b.disabled = true; b.textContent = 'Sending…';
            const sched = await getSchedule(currentDate);
            const anyBunk = sched ? Object.keys(sched.scheduleAssignments || {})[0] : null;
            const body = anyBunk
                ? composeMessage(anyBunk, sched, null)
                : `Campistry test: SMS is configured correctly! (${friendlyDate(currentDate)})`;
            const results = await sendSms([{ to: phone, body }]);
            b.disabled = false; b.textContent = 'Send me a test';
            toast(results.ok ? `Test sent to ${phone}` : `Failed: ${results.error}`);
        });

        // Blast preview
        const blast = view.querySelector('#smsBlastBody');
        const sched = await getSchedule(currentDate);
        if (activeTab !== 'messaging') return;

        if (!s.enabled) {
            blast.innerHTML = `<div class="lite-warn">SMS is turned off. Flip on "Camp opted in to SMS"
                above and save to enable sending.</div>`;
            return;
        }
        if (!sched || !sched.scheduleAssignments) {
            blast.innerHTML = emptyHTML('📭', `No schedule published for ${friendlyDate(currentDate)} yet — nothing to send.`);
            return;
        }

        const recipients = buildRecipients(sched);
        if (!recipients.length) {
            blast.innerHTML = `<div class="lite-warn">No opted-in recipients found.
                ${s.audience !== 'parents' ? 'Add counselor phone numbers and turn on their SMS toggle in the Staff tab.' : ''}
                ${s.audience !== 'counselors' ? 'Parent numbers come from the camper roster (parent phone field).' : ''}</div>`;
            return;
        }

        const previews = recipients.slice(0, 3).map(r =>
            `<div class="lite-preview-msg"><b>${esc(r.label)}</b>\n${esc(r.body)}</div>`).join('');
        blast.innerHTML = `
            <div class="lite-note"><b>${recipients.length}</b> recipient${recipients.length === 1 ? '' : 's'}
                for <b>${esc(friendlyDate(currentDate))}</b> (${esc(s.audience)}).</div>
            ${previews}
            ${recipients.length > 3 ? `<div class="lite-note">…and ${recipients.length - 3} more.</div>` : ''}
            <button class="lite-btn block" id="smsSendBlast">Send ${recipients.length} text${recipients.length === 1 ? '' : 's'}</button>`;

        blast.querySelector('#smsSendBlast').addEventListener('click', async (ev) => {
            const b = ev.currentTarget;
            if (!confirm(`Send ${recipients.length} SMS message(s) now?`)) return;
            b.disabled = true; b.textContent = 'Sending…';
            const res = await sendSms(recipients.map(r => ({ to: r.phone, body: r.body })));
            b.disabled = false;
            if (res.ok) {
                toast(`Sent ${res.sent} · failed ${res.failed}`);
                b.textContent = `Done — sent ${res.sent}${res.failed ? `, failed ${res.failed}` : ''}`;
            } else {
                toast('Send failed: ' + res.error);
                b.textContent = 'Retry send';
            }
        });
    }

    // Build the per-person recipient list for the current date's blast
    function buildRecipients(sched) {
        const s = camp.sms;
        const out = [];
        const seen = new Set();

        if (s.audience === 'counselors' || s.audience === 'both') {
            Object.entries(camp.staff || {}).forEach(([email, rec]) => {
                if (!rec?.smsOptIn || !rec.phone || !(rec.bunks || []).length) return;
                const bunk = rec.bunks[0]; // primary bunk drives the message
                const body = composeMessage(bunk, sched, rec.name, rec.bunks);
                if (!body) return;
                const key = 'p:' + rec.phone;
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ phone: rec.phone, body, label: `${rec.name || email} (${rec.bunks.join(', ')})` });
            });
        }

        if (s.audience === 'parents' || s.audience === 'both') {
            Object.entries(camp.roster || {}).forEach(([name, c]) => {
                if (!c?.parent1Phone || !c.bunk) return;
                const body = composeMessage(c.bunk, sched, name.split(' ')[0]);
                if (!body) return;
                const key = 'p:' + c.parent1Phone + ':' + c.bunk;
                if (seen.has(key)) return; // one text per parent per bunk (siblings share)
                seen.add(key);
                out.push({ phone: c.parent1Phone, body, label: `${name} — parent (${c.bunk})` });
            });
        }
        return out;
    }

    // One person's daily text: bunk schedule as compact lines
    function composeMessage(bunk, sched, firstName, extraBunks) {
        const bunks = (extraBunks && extraBunks.length) ? extraBunks : [bunk];
        const parts = [];
        parts.push(`Campistry — ${friendlyDate(currentDate)}`);
        if (firstName) parts[0] = `Hi ${firstName}! ` + parts[0];

        let any = false;
        bunks.forEach(b => {
            const entries = normalizeBunkEntries(b, sched);
            if (!entries.length) return;
            any = true;
            if (bunks.length > 1) parts.push(`\n${b}:`);
            entries.forEach(e => {
                const t = e.startMin != null ? fmtMin(e.startMin) : '';
                let line = `${t ? t + ' ' : ''}${e.title}`;
                if (e.location && e.location !== e.title) line += ` @ ${e.location}`;
                if (e.league && e.matchups && e.matchups.length) {
                    const team = bunkTeamForLeague(b, e.league);
                    const mine = team && e.matchups.find(m => m.toLowerCase().includes(team.toLowerCase()));
                    if (mine) line += ` — ${mine}`;
                }
                parts.push(line);
            });
        });
        if (!any) return null;
        if (camp.sms.footer) parts.push(camp.sms.footer);
        return parts.join('\n').slice(0, 1500);
    }

    async function sendSms(messages) {
        try {
            let sent = 0, failed = 0;
            for (let i = 0; i < messages.length; i += SMS_BATCH_SIZE) {
                const chunk = messages.slice(i, i + SMS_BATCH_SIZE);
                const { data, error } = await window.supabase.functions.invoke('send-sms', {
                    body: { messages: chunk }
                });
                if (error) throw new Error(error.message || 'send-sms function error');
                if (data?.error) throw new Error(data.error);
                sent += data?.sent || 0;
                failed += data?.failed || 0;
            }
            return { ok: true, sent, failed };
        } catch (e) {
            console.error('[Lite] SMS send failed:', e);
            return { ok: false, error: e.message || String(e) };
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: NOW  (whole-camp live snapshot — the roaming head-counselor view)
    // ════════════════════════════════════════════════════════════════════

    function effectiveNowMin() {
        return (nowTargetMin != null) ? nowTargetMin : nowMinutes();
    }

    function entryCovering(entries, min) {
        for (const e of entries) {
            if (e.startMin != null && e.endMin != null && min >= e.startMin && min < e.endMin) return e;
        }
        return null;
    }
    function nextEntry(entries, min) {
        for (const e of entries) { if (e.startMin != null && e.startMin > min) return e; }
        return null;
    }

    // Every bunk in the camp, tagged with its parent division (structure first,
    // then any schedule-only bunks so nothing is hidden — "see everything").
    function allBunkRows(sched) {
        const out = [];
        const parents = parentDivisions();
        const seen = new Set();
        parents.forEach(p => bunksForParent(p).forEach(b => {
            if (!seen.has(b)) { seen.add(b); out.push({ parent: p, bunk: b }); }
        }));
        Object.keys((sched && sched.scheduleAssignments) || {}).forEach(b => {
            if (!seen.has(b)) { seen.add(b); out.push({ parent: parentForBunk(b) || 'Other', bunk: b }); }
        });
        return out;
    }

    function timeBarHTML() {
        const eff = effectiveNowMin();
        const live = nowTargetMin == null;
        return `<div class="lite-nowbar">
            <button type="button" class="lite-now-step" id="liteNowMinus" aria-label="15 minutes earlier">−15</button>
            <div class="lite-now-label">
                <div class="t">${esc(fmtMin(eff))}</div>
                <div class="s">${live ? '● Live now' : 'Peeking ahead · tap Now'}</div>
            </div>
            <button type="button" class="lite-now-step" id="liteNowPlus" aria-label="15 minutes later">+15</button>
            <button type="button" class="lite-now-reset${live ? ' live' : ''}" id="liteNowReset">Now</button>
        </div>`;
    }
    function wireTimeBar(view, rerender) {
        const clamp = (m) => Math.max(0, Math.min(24 * 60 - 1, m));
        view.querySelector('#liteNowMinus').addEventListener('click', () => { nowTargetMin = clamp(effectiveNowMin() - 15); rerender(); });
        view.querySelector('#liteNowPlus').addEventListener('click', () => { nowTargetMin = clamp(effectiveNowMin() + 15); rerender(); });
        view.querySelector('#liteNowReset').addEventListener('click', () => { nowTargetMin = null; rerender(); });
    }

    async function renderNow() {
        const view = document.getElementById('view-now');
        view.innerHTML = timeBarHTML()
            + `<div class="lite-chiprow" id="liteNowGroup">
                 <button type="button" class="lite-chip ${nowGroupBy === 'division' ? 'active' : ''}" data-g="division">By division</button>
                 <button type="button" class="lite-chip ${nowGroupBy === 'field' ? 'active' : ''}" data-g="field">By field</button>
               </div>
               <div id="liteNowBody">${loadingHTML()}</div>`;
        wireTimeBar(view, renderNow);
        view.querySelectorAll('#liteNowGroup .lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { nowGroupBy = ch.dataset.g; renderNow(); }));

        const sched = await getSchedule(todayKey());
        if (activeTab !== 'now') return;
        const body = view.querySelector('#liteNowBody');
        if (!sched || !sched.scheduleAssignments || !Object.keys(sched.scheduleAssignments).length) {
            body.innerHTML = emptyHTML('📭', 'No schedule published for today yet.');
            return;
        }

        const min = effectiveNowMin();
        const rows = allBunkRows(sched).map(r => {
            const entries = normalizeBunkEntries(r.bunk, sched);
            return { ...r, entry: entryCovering(entries, min), upcoming: nextEntry(entries, min) };
        });

        if (nowGroupBy === 'field') {
            // Group by where bunks physically are right now
            const byPlace = {};
            rows.forEach(r => {
                if (!r.entry) return;
                const place = r.entry.location || r.entry.title || 'Unassigned';
                (byPlace[place] = byPlace[place] || []).push(r);
            });
            const places = Object.keys(byPlace).sort();
            if (!places.length) { body.innerHTML = emptyHTML('🌙', 'Nothing scheduled at this time.'); return; }
            body.innerHTML = places.map(place => `
                <div class="lite-card lite-bunk-card">
                    <div class="lite-bunk-head">
                        <span class="lite-bunk-name">📍 ${esc(place)}</span>
                        <span class="lite-bunk-div">${byPlace[place].length} here</span>
                    </div>
                    ${byPlace[place].map(r => `<div class="lite-slot">
                        <div class="lite-slot-body">
                            <div class="lite-slot-activity">${esc(r.bunk)}</div>
                            <div class="lite-slot-loc">${esc(r.parent)} · ${esc(r.entry.title)}</div>
                        </div>
                    </div>`).join('')}
                </div>`).join('');
            return;
        }

        // Group by division (default)
        const byDiv = {};
        rows.forEach(r => { (byDiv[r.parent] = byDiv[r.parent] || []).push(r); });
        const divs = Object.keys(byDiv);
        body.innerHTML = divs.map(div => `
            <div class="lite-card lite-bunk-card">
                <div class="lite-bunk-head">
                    <span class="lite-bunk-name">${esc(div)}</span>
                    <span class="lite-bunk-div">${byDiv[div].length} bunk${byDiv[div].length === 1 ? '' : 's'}</span>
                </div>
                ${byDiv[div].map(r => {
                    if (r.entry) {
                        return `<div class="lite-slot">
                            <div class="lite-slot-time"><div class="t1">${esc(r.bunk)}</div></div>
                            <div class="lite-slot-body">
                                <div class="lite-slot-activity">${esc(r.entry.title)}</div>
                                ${r.entry.location && r.entry.location !== r.entry.title ? `<div class="lite-slot-loc">📍 ${esc(r.entry.location)}</div>` : ''}
                            </div>
                        </div>`;
                    }
                    const up = r.upcoming;
                    return `<div class="lite-slot">
                        <div class="lite-slot-time"><div class="t1">${esc(r.bunk)}</div></div>
                        <div class="lite-slot-body">
                            <div class="lite-slot-activity" style="color:var(--lite-muted);">${up ? `Free · next: ${esc(up.title)} at ${esc(fmtMin(up.startMin))}` : 'Nothing scheduled'}</div>
                        </div>
                    </div>`;
                }).join('')}
            </div>`).join('');
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: LOCATE  (find a camper → where they are right now / at a time)
    // ════════════════════════════════════════════════════════════════════

    function renderLocate() {
        const view = document.getElementById('view-locate');
        if (!camp.stateLoaded || !Object.keys(camp.roster || {}).length) {
            view.innerHTML = `<div class="lite-field" style="margin-bottom:10px;">
                    <input class="lite-input" id="liteLocateSearch" type="search" placeholder="Search camper…" disabled>
                </div>`
                + emptyHTML('🧒', camp.stateLoaded
                    ? 'No campers in the roster yet. Add them in Campistry Me.'
                    : 'Roster data isn\'t available for your role.');
            return;
        }
        view.innerHTML = timeBarHTML()
            + `<div class="lite-field" style="margin:10px 0;">
                 <input class="lite-input" id="liteLocateSearch" type="search"
                        placeholder="Search a camper by name…" value="${esc(locateQuery)}" autocomplete="off">
               </div>
               <div id="liteLocateBody"></div>`;
        wireTimeBar(view, renderLocate);
        const input = view.querySelector('#liteLocateSearch');
        input.addEventListener('input', () => { locateQuery = input.value; renderLocateBody(view.querySelector('#liteLocateBody')); });
        renderLocateBody(view.querySelector('#liteLocateBody'));
    }

    async function renderLocateBody(body) {
        const q = locateQuery.trim().toLowerCase();
        if (!q) { body.innerHTML = emptyHTML('🔎', 'Type a camper\'s name to find where they are.'); return; }

        const matches = Object.keys(camp.roster || {})
            .filter(n => n.toLowerCase().includes(q))
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 20);
        if (!matches.length) { body.innerHTML = emptyHTML('🚫', `No camper matches "${esc(locateQuery)}".`); return; }

        const sched = await getSchedule(todayKey());
        if (activeTab !== 'locate') return;
        const min = effectiveNowMin();

        body.innerHTML = matches.map(name => {
            const c = camp.roster[name] || {};
            const bunk = c.bunk;
            const parent = bunk ? (parentForBunk(bunk) || c.division || '') : (c.division || '');
            let where = `<div class="lite-slot-loc">No bunk on file</div>`;
            if (bunk && sched && sched.scheduleAssignments) {
                const entries = normalizeBunkEntries(bunk, sched);
                const e = entryCovering(entries, min);
                if (e) {
                    where = `<div class="lite-slot-activity">${esc(e.title)}</div>
                        <div class="lite-slot-loc">${e.location && e.location !== e.title ? '📍 ' + esc(e.location) + ' · ' : ''}${esc(fmtMin(e.startMin))}–${esc(fmtMin(e.endMin))}</div>`;
                } else {
                    const up = nextEntry(entries, min);
                    where = `<div class="lite-slot-loc" style="color:var(--lite-muted);">${up ? `Free now · next: ${esc(up.title)} at ${esc(fmtMin(up.startMin))}` : 'Nothing scheduled at this time'}</div>`;
                }
            } else if (bunk) {
                where = `<div class="lite-slot-loc" style="color:var(--lite-muted);">No schedule published for today</div>`;
            }
            return `<div class="lite-card lite-bunk-card">
                <div class="lite-bunk-head">
                    <span class="lite-bunk-name">${esc(name)}</span>
                    <span class="lite-bunk-div">${esc([bunk, parent].filter(Boolean).join(' · '))}</span>
                </div>
                <div class="lite-slot"><div class="lite-slot-body">${where}</div></div>
            </div>`;
        }).join('');
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: REPORTS  (Bunk Rotation & Usage — from rotation_counts)
    // ════════════════════════════════════════════════════════════════════

    async function ensureRotation(force) {
        if (rotationData && !force) return rotationData;
        if (!window.RotationCloud || !window.RotationCloud.load) return null;
        try {
            rotationData = await window.RotationCloud.load(!!force);
        } catch (e) {
            console.warn('[Lite] RotationCloud.load failed:', e);
            rotationData = null;
        }
        return rotationData;
    }

    async function renderReports() {
        const view = document.getElementById('view-reports');
        view.innerHTML = loadingHTML();
        const data = await ensureRotation();
        if (activeTab !== 'reports') return;

        if (!data || !data.counts) {
            view.innerHTML = emptyHTML('📊', 'Rotation data isn\'t available yet. Generate a schedule first, or check back after today\'s activities are saved.');
            return;
        }

        const parents = parentDivisions();
        if (!parents.length) { view.innerHTML = emptyHTML('📊', 'No divisions configured yet.'); return; }
        if (!reportsDivision || !parents.includes(reportsDivision)) reportsDivision = parents[0];

        view.innerHTML = `<div class="lite-section-label" style="margin-top:4px;">Bunk Rotation &amp; Usage</div>`
            + chipRowHTML(parents, reportsDivision)
            + `<div id="liteReportsBody"></div>`;
        view.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { reportsDivision = ch.dataset.val; renderReports(); }));

        const bodyEl = view.querySelector('#liteReportsBody');
        const bunks = bunksForParent(reportsDivision);
        if (!bunks.length) { bodyEl.innerHTML = emptyHTML('📊', 'No bunks in this division.'); return; }

        bodyEl.innerHTML = bunks.map(bunk => {
            const counts = data.counts[bunk] || {};
            const acts = Object.entries(counts)
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1]);
            const total = acts.reduce((s, [, n]) => s + n, 0);
            if (!acts.length) {
                return `<div class="lite-card lite-bunk-card">
                    <div class="lite-bunk-head"><span class="lite-bunk-name">${esc(bunk)}</span><span class="lite-bunk-div">no activity yet</span></div>
                </div>`;
            }
            const max = acts[0][1];
            return `<div class="lite-card lite-bunk-card">
                <div class="lite-bunk-head">
                    <span class="lite-bunk-name">${esc(bunk)}</span>
                    <span class="lite-bunk-div">${total} total</span>
                </div>
                ${acts.map(([act, n]) => `<div class="lite-usage-row">
                    <div class="lite-usage-top">
                        <span class="lite-usage-name">${esc(act)}</span>
                        <span class="lite-usage-count">${n}×</span>
                    </div>
                    <div class="lite-usage-bar"><span style="width:${Math.round((n / max) * 100)}%"></span></div>
                </div>`).join('')}
            </div>`;
        }).join('');
    }

    // ════════════════════════════════════════════════════════════════════
    // SHARED UI BITS
    // ════════════════════════════════════════════════════════════════════

    function dateStripHTML() {
        return `<div class="lite-datestrip">
            <button type="button" id="liteDatePrev" aria-label="Previous day">‹</button>
            <div class="lite-date-label">
                <div class="day">${esc(friendlyDate(currentDate))}</div>
                <div class="sub">${currentDate === todayKey() ? 'Today · tap to pick a date' : 'Tap to pick a date'}</div>
                <input type="date" id="liteDatePick" value="${esc(currentDate)}">
            </div>
            <button type="button" id="liteDateNext" aria-label="Next day">›</button>
        </div>`;
    }

    function wireDateStrip(view, rerender) {
        view.querySelector('#liteDatePrev').addEventListener('click', () => { currentDate = shiftDate(currentDate, -1); rerender(); });
        view.querySelector('#liteDateNext').addEventListener('click', () => { currentDate = shiftDate(currentDate, 1); rerender(); });
        view.querySelector('#liteDatePick').addEventListener('change', (e) => {
            if (e.target.value) { currentDate = e.target.value; rerender(); }
        });
    }

    function chipRowHTML(items, active) {
        return `<div class="lite-chiprow">${items.map(i =>
            `<button type="button" class="lite-chip${i === active ? ' active' : ''}" data-val="${esc(i)}">${esc(i)}</button>`).join('')}</div>`;
    }

    function loadingHTML() {
        return `<div class="lite-empty"><div class="lite-splash-spinner" style="margin:0 auto 10px;"></div>Loading…</div>`;
    }

    function emptyHTML(icon, msg) {
        return `<div class="lite-empty"><div class="lite-empty-icon">${icon}</div>${msg}</div>`;
    }

    let sheetEl = null;
    function openSheet(innerHTML) {
        closeSheet();
        sheetEl = document.createElement('div');
        sheetEl.className = 'lite-sheet-backdrop';
        sheetEl.innerHTML = `<div class="lite-sheet">${innerHTML}</div>`;
        sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet(); });
        document.body.appendChild(sheetEl);
        return sheetEl;
    }
    function closeSheet() {
        if (sheetEl) { sheetEl.remove(); sheetEl = null; }
    }

    let toastTimer = null;
    function toast(msg) {
        const el = document.getElementById('liteToast');
        el.textContent = msg;
        el.style.display = '';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3200);
    }

    function setSplash(msg) {
        const el = document.getElementById('liteSplashStatus');
        if (el) el.textContent = msg;
    }

    // ════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ════════════════════════════════════════════════════════════════════

    function esc(v) {
        return String(v ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fieldLabel(field) {
        if (!field) return '';
        if (typeof field === 'string') return field;
        if (typeof field === 'object' && field.name) return field.name;
        return String(field);
    }

    function numOrNull(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function fmtMin(min) {
        if (window.DivisionTimesSystem?.minutesToTimeLabel) {
            try { return window.DivisionTimesSystem.minutesToTimeLabel(min); } catch (_) {}
        }
        let h = Math.floor(min / 60), m = min % 60;
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${String(m).padStart(2, '0')} ${ap}`;
    }

    function nowMinutes() {
        const d = new Date();
        return d.getHours() * 60 + d.getMinutes();
    }

    function todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function shiftDate(key, delta) {
        const [y, m, d] = key.split('-').map(Number);
        const dt = new Date(y, m - 1, d + delta);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }

    function friendlyDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function roleLabel(r) {
        return { owner: 'Owner', admin: 'Admin', scheduler: 'Scheduler', viewer: 'Viewer', counselor: 'Counselor' }[r] || r;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ─── Go ─────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
