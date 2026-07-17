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
                     'liteStaffAssignments', 'liteSmsSettings', 'camp_name', 'fields'];
    const SMS_BATCH_SIZE = 100;

    // ─── State ──────────────────────────────────────────────────────────
    let campId = null;
    let role = null;
    let userEmail = null;
    let campDisplayName = '';
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
    let currentApp = null;            // null = home launcher; else a LITE_APPS id
    let selectedDivision = null;      // head-staff Roster division chip
    let rosterQuery = '';
    let nowTargetMin = null;          // Locate time selection; null = live "now"
    let locateQuery = '';
    let rotationData = null;          // cached RotationCloud.load() result

    // Schedule tab
    let schedScope = 'division';      // 'division' | 'grade'
    let schedMode = 'schedule';       // 'schedule' | 'now'
    let schedSel = null;              // selected division/grade chip
    let bunkQuery = '';               // Schedule bunk / facility search
    // Reports tab
    let repView = 'usage';            // 'usage' | 'avail'
    let repScope = 'division';        // 'division' | 'grade'
    let repSel = null;
    let repBunkQuery = '';
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

            // Resolve the real camp name (getCampName often falls back to a
            // placeholder when Lite is opened directly, not via the dashboard).
            campDisplayName = await resolveCampName();

            // Chrome: avatar, menu identity, role badge
            const ini = avatarInitials();
            document.getElementById('liteAvatarInitials').textContent = ini;
            document.getElementById('liteMenuAvatar').textContent = ini;
            document.getElementById('liteRoleBadge').textContent = roleLabel(role);
            document.getElementById('liteMenuUser').textContent = userEmail;
            if (!isHeadStaff()) {
                const dash = document.getElementById('liteMenuDashboard');
                if (dash) dash.style.display = 'none';
            }

            wireChrome();

            // Always land on the home launcher — the user picks a Lite app there.
            document.getElementById('liteSplash').style.display = 'none';
            document.getElementById('liteApp').style.display = '';
            goHome();
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

    // Resolve the real camp name from the first trustworthy source.
    async function resolveCampName() {
        const bad = new Set(['', 'your camp', 'unknown camp', 'my camp']);
        const clean = v => {
            const s = (v == null ? '' : String(v)).trim();
            return (s && !bad.has(s.toLowerCase())) ? s : null;
        };

        // 1) AccessControl (its full DB resolution reads camps.name)
        let n = clean(window.AccessControl?.getCampName?.());
        if (n) return n;

        // 2) camp_state_kv camp_name (set when an owner edits the camp name)
        n = clean(camp.campName);
        if (n) return n;

        // 3) camps table directly (id or owner == campId)
        try {
            const { data } = await window.supabase
                .from('camps').select('name')
                .or(`id.eq.${campId},owner.eq.${campId}`).limit(1).maybeSingle();
            n = clean(data && data.name);
            if (n) return n;
        } catch (_) { /* RLS or none — fall through */ }

        // 4) signup metadata
        try {
            const { data: { user } } = await window.supabase.auth.getUser();
            n = clean(user && user.user_metadata && user.user_metadata.camp_name);
            if (n) return n;
        } catch (_) {}

        return '';
    }

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
            camp.fields = byKey.fields || app1.fields || [];
            camp.campName = (typeof byKey.camp_name === 'string') ? byKey.camp_name
                          : (byKey.camp_name && byKey.camp_name.value) || '';
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

    // Grade-level keys (app1.divisions is grade-keyed: each is a grade with bunks)
    function gradeKeys() { return Object.keys(camp.divisions || {}); }

    // Chips + bunks for a scope ('division' → parent divisions, 'grade' → grades)
    function scopeChips(scope) { return scope === 'grade' ? gradeKeys() : parentDivisions(); }
    function bunksForScope(scope, sel) {
        if (!sel) return [];
        return scope === 'grade' ? ((camp.divisions[sel] && camp.divisions[sel].bunks) || []) : bunksForParent(sel);
    }

    // Segmented control (mode / scope toggles)
    function segHTML(id, options, active) {
        return `<div class="lite-seg" id="${id}">${options.map(o =>
            `<button type="button" class="lite-seg-btn${o.val === active ? ' active' : ''}" data-val="${o.val}">${esc(o.label)}</button>`).join('')}</div>`;
    }

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
        facilities: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 13v.01"/><path d="M9 17v.01"/></svg>',
        locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
        roster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        league: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
        staff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/><path d="M19 8h4"/><path d="M21 6v4"/></svg>',
        messaging: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };

    // ─── Lite apps (home launcher) — mirrors the website dashboard suite,
    //     using each product's real logo. Flow is live; the rest are the
    //     Lite versions still to come. ────────────────────────────────────
    const HEAD = ['owner', 'admin', 'scheduler', 'viewer'];
    const CORAL_THEME = { accent: '#EE6A53', dark: '#DA4B32', tint: '#FEF2EF' };
    const LITE_APPS = [
        { id: 'flow', name: 'Flow', title: 'Flow Lite', logo: 'Flow_clean.png', color: '#147D91',
          theme: { accent: '#147D91', dark: '#0F5F6E', tint: '#E6F4F7' },
          roles: HEAD, status: 'available',
          tabs: [{ id: 'today', label: 'Schedule' }, { id: 'locate', label: 'Locate' }, { id: 'reports', label: 'Reports' }] },
        { id: 'me',     name: 'Me',     logo: 'Me_clean.png',     color: '#F59E0B', theme: { accent: '#F59E0B', dark: '#B45309', tint: '#FEF3C7' }, roles: HEAD, status: 'soon' },
        { id: 'go',     name: 'Go',     logo: 'Go_clean.png',     color: '#0EA5E9', theme: { accent: '#0EA5E9', dark: '#0369A1', tint: '#E0F2FE' }, roles: HEAD, status: 'soon' },
        { id: 'health', name: 'Health', logo: 'Health_clean.png', color: '#6B21A8', theme: { accent: '#6B21A8', dark: '#581C87', tint: '#F3E8FF' }, roles: HEAD, status: 'soon' },
        { id: 'live',   name: 'Live',   logo: 'Live_clean.png',   color: '#2563EB', theme: { accent: '#2563EB', dark: '#1D4ED8', tint: '#DBEAFE' }, roles: HEAD, status: 'soon' },
        { id: 'snacks', name: 'Snacks', logo: 'Snacks_clean.png', color: '#78350F', theme: { accent: '#78350F', dark: '#5C2E0E', tint: '#F3EBE3' }, roles: HEAD, status: 'soon' },
        { id: 'link',   name: 'Link',   logo: 'Link_clean.png',   color: '#2A7A35', theme: { accent: '#2A7A35', dark: '#1F5A28', tint: '#E4F3E6' }, roles: HEAD, status: 'soon' },
        { id: 'notes',  name: 'Notes',  logo: 'Notes_clean.png',  color: '#C4891A', theme: { accent: '#C4891A', dark: '#9A6A12', tint: '#FBF0D8' }, roles: HEAD, status: 'soon' },
        { id: 'counselor', name: 'My Camp', title: 'My Camp', tag: 'Your bunk, schedule & league',
          logo: 'Lite_clean.png', color: '#EE6A53', theme: CORAL_THEME, roles: ['counselor'], status: 'available',
          tabs: [{ id: 'today', label: 'My Day' }, { id: 'roster', label: 'My Bunk' }, { id: 'league', label: 'League' }] }
    ];

    // Per-app internal theming: each app runs in its product color; the Lite
    // shell (home launcher) reverts to coral.
    function applyTheme(app) {
        const root = document.getElementById('liteApp');
        const t = app && app.theme;
        if (t) {
            root.style.setProperty('--accent', t.accent);
            root.style.setProperty('--accent-dark', t.dark);
            root.style.setProperty('--accent-tint', t.tint);
        } else {
            root.style.removeProperty('--accent');
            root.style.removeProperty('--accent-dark');
            root.style.removeProperty('--accent-tint');
        }
    }

    function appsForRole() { return LITE_APPS.filter(a => a.roles.includes(role)); }

    // ─── Home launcher ──────────────────────────────────────────────────
    function greeting() {
        const h = new Date().getHours();
        return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    }
    function firstName(n) { return String(n || '').trim().split(/\s+/)[0]; }

    function renderHome() {
        const view = document.getElementById('view-home');
        const apps = appsForRole();
        const campName = campDisplayName;
        const single = apps.length === 1;

        view.innerHTML = heroCardHTML(campName)
            + `<div class="lite-launch-grid${single ? ' single' : ''}">${apps.map(tileHTML).join('')}</div>`;

        view.querySelectorAll('.lite-launch-tile[data-app]').forEach(t =>
            t.addEventListener('click', () => openApp(t.dataset.app)));
        const heroBtn = view.querySelector('#liteHeroMenuBtn');
        if (heroBtn) heroBtn.addEventListener('click', toggleMenu);

        startClock();
        renderWeather();
    }

    function heroCardHTML(campName) {
        const name = campName ? esc(campName) : 'your camp';
        return `<div class="lite-hero-card">
            <button class="lite-hero-settings" id="liteHeroMenuBtn" aria-label="Account & settings"><span>${esc(avatarInitials())}</span></button>
            <div class="lite-hero-greeting">${greeting()},</div>
            <div class="lite-hero-welcome">Welcome back, <span>${name}</span>!</div>
            <div class="lite-hero-sub">Your camp, in your pocket — every Campistry app, on the go.</div>
            <div class="lite-hero-widget lite-hero-clock">
                <div class="time" id="liteClockTime">--:--</div>
                <div class="date" id="liteClockDate"></div>
            </div>
            <div class="lite-hero-widget lite-hero-weather">
                <div class="wx-icon" id="liteWxIcon">${WX_SVG.cloud}</div>
                <div>
                    <div class="wx-temp" id="liteWxTemp">--°</div>
                    <div class="wx-desc" id="liteWxDesc">Loading…</div>
                </div>
            </div>
        </div>`;
    }

    function tileHTML(app) {
        const soon = app.status !== 'available';
        return `<button class="lite-launch-tile${soon ? ' soon' : ''}" ${soon ? 'disabled' : `data-app="${app.id}"`} style="--ql:${app.color}">
            ${soon ? '<span class="lite-launch-soon">Soon</span>' : ''}
            <img src="${app.logo}" class="lite-launch-logo" alt="">
            <span class="lite-launch-name">${esc(app.name)}</span>
        </button>`;
    }

    // ─── Clock + weather (hero widgets, ported from the website dashboard) ─
    let _clockTimer = null;
    let _weatherCache = null;
    const WX_SVG = {
        sun: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
        cloud: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
        rain: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="16" y1="13" x2="16" y2="21"/><line x1="8" y1="13" x2="8" y2="21"/><line x1="12" y1="15" x2="12" y2="23"/><path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/></svg>'
    };

    function startClock() {
        updateClock();
        if (_clockTimer) clearInterval(_clockTimer);
        _clockTimer = setInterval(updateClock, 10000);
    }
    function updateClock() {
        const t = document.getElementById('liteClockTime');
        const d = document.getElementById('liteClockDate');
        if (!t && !d) { if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; } return; }
        const now = new Date();
        if (t) t.textContent = fmtMin(now.getHours() * 60 + now.getMinutes());
        if (d) d.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }

    function wxDesc(code) {
        if (code === 0) return 'Clear sky';
        if (code <= 3) return 'Partly cloudy';
        if (code <= 49) return 'Foggy';
        if (code <= 59) return 'Drizzle';
        if (code <= 69) return 'Rain';
        if (code <= 79) return 'Snow';
        if (code <= 86) return 'Showers';
        if (code >= 95) return 'Thunderstorm';
        return 'Mixed';
    }
    function wxIcon(code) {
        if (code === 0) return WX_SVG.sun;
        if (code <= 3) return WX_SVG.cloud;
        return WX_SVG.rain;
    }
    function paintWeather(temp, code) {
        const tEl = document.getElementById('liteWxTemp');
        const dEl = document.getElementById('liteWxDesc');
        const iEl = document.getElementById('liteWxIcon');
        if (tEl) tEl.textContent = Math.round(temp) + '°F';
        if (dEl) dEl.textContent = wxDesc(code);
        if (iEl) iEl.innerHTML = wxIcon(code);
    }
    function renderWeather() {
        if (_weatherCache) { paintWeather(_weatherCache.temperature, _weatherCache.weathercode); return; }
        if (window.location.protocol === 'file:') {
            const dEl = document.getElementById('liteWxDesc');
            if (dEl) dEl.textContent = 'Live weather when deployed';
            return;
        }
        // Open-Meteo, no key. Best-effort geolocation, else a sensible default.
        const fetchAt = (lat, lon) => {
            fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=fahrenheit`)
                .then(r => r.json())
                .then(data => {
                    if (data && data.current_weather) {
                        _weatherCache = data.current_weather;
                        paintWeather(_weatherCache.temperature, _weatherCache.weathercode);
                    }
                })
                .catch(() => { const d = document.getElementById('liteWxDesc'); if (d) d.textContent = 'Check back later'; });
        };
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                p => fetchAt(p.coords.latitude, p.coords.longitude),
                () => fetchAt(40.7128, -74.006),
                { timeout: 4000, maximumAge: 3600000 }
            );
        } else {
            fetchAt(40.7128, -74.006);
        }
    }

    function openApp(id) {
        const app = LITE_APPS.find(a => a.id === id);
        if (!app || app.status !== 'available') return;
        currentApp = id;
        applyTheme(app);
        document.getElementById('view-home').style.display = 'none';
        setHeader('', '');   // no title bar in-app — just back + avatar
        document.getElementById('liteApp').setAttribute('data-screen', 'app');
        buildTabs(app.tabs);
        switchTab(app.tabs[0].id);
    }

    function goHome() {
        currentApp = null;
        applyTheme(null);
        document.querySelectorAll('.lite-view').forEach(v => { if (v.id !== 'view-home') v.style.display = 'none'; });
        document.getElementById('liteApp').setAttribute('data-screen', 'home');
        setHeaderHome();
        renderHome();
        animateIn(document.getElementById('view-home'));
        try { window.scrollTo({ top: 0 }); } catch (_) {}
    }

    function setHeader(title, sub) {
        document.getElementById('liteHeaderTitle').textContent = title;
        document.getElementById('liteHeaderSub').textContent = sub || '';
    }
    function setHeaderHome() {
        document.getElementById('liteHeaderTitle').innerHTML = 'Campistry <span>Lite</span>';
        document.getElementById('liteHeaderSub').textContent = campDisplayName;
    }

    function animateIn(el) {
        if (!el) return;
        el.classList.remove('anim'); void el.offsetWidth; el.classList.add('anim');
    }

    function buildTabs(tabs) {
        const bar = document.getElementById('liteTabbar');
        bar.innerHTML = '';
        (tabs || []).forEach(t => {
            const btn = document.createElement('button');
            btn.className = 'lite-tab';
            btn.dataset.tab = t.id;
            btn.innerHTML = `<span class="lite-tab-ic">${TAB_ICONS[t.id] || ''}</span><span>${esc(t.label)}</span>`;
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
        if (view) { view.style.display = ''; animateIn(view); }
        renderView(id);
        try { window.scrollTo({ top: 0 }); } catch (_) {}
    }

    function renderView(id) {
        if (id === 'today') renderToday();
        else if (id === 'locate') renderLocate();
        else if (id === 'reports') renderReports();
        else if (id === 'roster') renderRoster();
        else if (id === 'league') renderLeague();
        else if (id === 'staff') renderStaff();
        else if (id === 'messaging') renderMessaging();
    }

    function toggleMenu(e) {
        if (e) e.stopPropagation();
        const menu = document.getElementById('liteMenu');
        menu.style.display = menu.style.display === 'none' ? '' : 'none';
    }

    function wireChrome() {
        document.getElementById('liteBackBtn').addEventListener('click', goHome);
        const menu = document.getElementById('liteMenu');
        document.getElementById('liteMenuBtn').addEventListener('click', toggleMenu);
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

        // Counselor: just their bunk(s) timeline — no controls.
        if (isCounselor()) {
            view.innerHTML = dateStripHTML() + `<div id="liteTodayBody">${loadingHTML()}</div>`;
            wireDateStrip(view, () => renderToday());
            const body = view.querySelector('#liteTodayBody');
            const bunks = myBunks();
            if (!bunks.length) {
                body.innerHTML = emptyHTML('🏕️',
                    'No bunk assigned to you yet.<br>Ask your head staff to assign your bunk in Campistry Lite → My Camp.');
                return;
            }
            const sched = await getSchedule(currentDate);
            if (activeTab !== 'today') return;
            body.innerHTML = (!sched || !sched.scheduleAssignments)
                ? emptyHTML('📭', `No schedule published for ${friendlyDate(currentDate)} yet.`)
                : bunks.map(b => bunkCardHTML(b, sched)).join('');
            return;
        }

        // Head staff / viewer: date + scope + (mode) + search + chips + body
        const isFac = schedScope === 'facility';
        view.innerHTML = dateStripHTML()
            + segHTML('liteSchedScope', [
                { val: 'division', label: 'By division' },
                { val: 'grade', label: 'By grade' },
                { val: 'facility', label: 'By facility' }
              ], schedScope)
            + (isFac ? '' : segHTML('liteSchedMode', [{ val: 'schedule', label: 'Schedule' }, { val: 'now', label: 'Now' }], schedMode))
            + `<div class="lite-field" style="margin-bottom:10px;">
                 <input class="lite-input" id="liteBunkSearch" type="search" placeholder="${isFac ? 'Search a facility…' : 'Search a bunk…'}" value="${esc(bunkQuery)}" autocomplete="off">
               </div>`
            + `<div id="liteSchedChips"></div><div id="liteSchedBody">${loadingHTML()}</div>`;
        wireDateStrip(view, () => renderToday());
        view.querySelectorAll('#liteSchedScope .lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { schedScope = b.dataset.val; schedSel = null; bunkQuery = ''; renderToday(); }));
        const modeSeg = view.querySelector('#liteSchedMode');
        if (modeSeg) modeSeg.querySelectorAll('.lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { schedMode = b.dataset.val; renderToday(); }));
        const inp = view.querySelector('#liteBunkSearch');
        inp.addEventListener('input', () => { bunkQuery = inp.value; renderSchedChips(view); renderSchedBody(view); });

        renderSchedChips(view);
        await renderSchedBody(view);
    }

    function renderSchedChips(view) {
        const el = view.querySelector('#liteSchedChips');
        if (!el) return;
        // Facility scope / search / Now mode all show everything → no chips
        if (schedScope === 'facility' || bunkQuery.trim() || schedMode === 'now') { el.innerHTML = ''; return; }
        const chips = scopeChips(schedScope);
        if (!chips.length) { el.innerHTML = ''; return; }
        if (!schedSel || !chips.includes(schedSel)) schedSel = chips[0];
        el.innerHTML = chipRowHTML(chips, schedSel);
        el.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { schedSel = ch.dataset.val; renderSchedChips(view); renderSchedBody(view); }));
    }

    async function renderSchedBody(view) {
        const body = view.querySelector('#liteSchedBody');
        if (!body) return;
        const sched = await getSchedule(currentDate);
        if (activeTab !== 'today') return;
        if (!sched || !sched.scheduleAssignments || !Object.keys(sched.scheduleAssignments).length) {
            body.innerHTML = emptyHTML('📭', `No schedule published for ${friendlyDate(currentDate)} yet.`);
            return;
        }

        const q = bunkQuery.trim().toLowerCase();

        // By facility → who's using what facility, when, and by whom
        if (schedScope === 'facility') {
            body.innerHTML = facilityCardsHTML(sched, q);
            return;
        }

        if (q) {
            const hits = allBunkRows(sched).map(r => r.bunk).filter(b => b.toLowerCase().includes(q));
            body.innerHTML = hits.length ? hits.map(b => bunkCardHTML(b, sched)).join('')
                                         : emptyHTML('🔍', 'No bunk matches your search.');
            return;
        }
        if (schedMode === 'now') { body.innerHTML = nowSnapshotHTML(sched, schedScope); return; }

        const bunks = bunksForScope(schedScope, schedSel);
        body.innerHTML = bunks.length ? bunks.map(b => bunkCardHTML(b, sched)).join('')
                                      : emptyHTML('📭', 'No bunks here.');
    }

    // The folded-in "Now" view — every bunk's current activity, grouped by scope.
    function nowSnapshotHTML(sched, scope) {
        const min = nowMinutes();
        const rows = allBunkRows(sched).map(r => {
            const entries = normalizeBunkEntries(r.bunk, sched);
            return {
                bunk: r.bunk,
                group: scope === 'grade' ? (divKeyForBunk(r.bunk) || r.parent) : r.parent,
                entry: entryCovering(entries, min),
                upcoming: nextEntry(entries, min)
            };
        });
        const byGroup = {};
        rows.forEach(r => { (byGroup[r.group] = byGroup[r.group] || []).push(r); });
        return `<div class="lite-note" style="margin:-2px 2px 10px;">● Happening right now · ${esc(fmtMin(min))}</div>`
            + Object.keys(byGroup).map(g => `
            <div class="lite-card lite-bunk-card">
                <div class="lite-bunk-head"><span class="lite-bunk-name">${esc(g)}</span><span class="lite-bunk-div">${byGroup[g].length}</span></div>
                ${byGroup[g].map(r => `<div class="lite-slot">
                    <div class="lite-slot-time"><div class="t1">${esc(r.bunk)}</div></div>
                    <div class="lite-slot-body">${r.entry
                        ? `<div class="lite-slot-activity">${esc(r.entry.title)}</div>${r.entry.location && r.entry.location !== r.entry.title ? `<div class="lite-slot-loc">📍 ${esc(r.entry.location)}</div>` : ''}`
                        : `<div class="lite-slot-activity" style="color:var(--muted);">${r.upcoming ? `Free · next ${esc(r.upcoming.title)} ${esc(fmtMin(r.upcoming.startMin))}` : 'Nothing scheduled'}</div>`}</div>
                </div>`).join('')}
            </div>`).join('');
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
    // Shared time helpers (used by Schedule/Now, Facilities, Locate)
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

    // ════════════════════════════════════════════════════════════════════
    // FACILITIES  (who is using what facility, when, and by whom)
    // Rendered inside Schedule under the "By facility" scope.
    // ════════════════════════════════════════════════════════════════════

    // All facility names known to the camp (configured fields ∪ ones in use)
    function facilityNames() {
        const out = new Set();
        (camp.fields || []).forEach(f => {
            const n = (typeof f === 'string') ? f : (f && (f.name || f.field || f.id));
            if (n) out.add(String(n));
        });
        return out;
    }

    // Build facility → [{bunk, parent, activity, startMin, endMin}] for a schedule
    function facilityUsage(sched) {
        const byFac = {};
        allBunkRows(sched).forEach(({ bunk, parent }) => {
            normalizeBunkEntries(bunk, sched).forEach(e => {
                if (!e.location) return;
                (byFac[e.location] = byFac[e.location] || []).push({
                    bunk, parent, activity: e.title, startMin: e.startMin, endMin: e.endMin
                });
            });
        });
        return byFac;
    }

    // Per-facility booking cards for a schedule, optionally filtered by query.
    function facilityCardsHTML(sched, q) {
        const byFac = facilityUsage(sched);
        let facs = Object.keys(byFac).sort();
        if (q) facs = facs.filter(f => f.toLowerCase().includes(q));
        if (!facs.length) {
            return emptyHTML('🏟️', q ? 'No facility matches your search.' : 'No facility bookings for this day.');
        }
        const nowMin = nowMinutes();
        const isToday = currentDate === todayKey();
        return facs.map(f => {
            const uses = byFac[f].slice().sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
            return `<div class="lite-card lite-bunk-card">
                <div class="lite-bunk-head">
                    <span class="lite-bunk-name">📍 ${esc(f)}</span>
                    <span class="lite-bunk-div">${uses.length} booking${uses.length === 1 ? '' : 's'}</span>
                </div>
                ${uses.map(u => {
                    const isNow = isToday && u.startMin != null && u.endMin != null && nowMin >= u.startMin && nowMin < u.endMin;
                    return `<div class="lite-slot${isNow ? ' now' : ''}">
                        <div class="lite-slot-time">
                            <div class="t1">${u.startMin != null ? esc(fmtMin(u.startMin)) : '—'}</div>
                            <div class="t2">${u.endMin != null ? esc(fmtMin(u.endMin)) : ''}</div>
                        </div>
                        <div class="lite-slot-body">
                            <div class="lite-slot-activity">${esc(u.bunk)}</div>
                            <div class="lite-slot-loc">${esc(u.parent)} · ${esc(u.activity)}</div>
                        </div>
                    </div>`;
                }).join('')}
            </div>`;
        }).join('');
    }

    // Merge overlapping [start,end] blocks; return sorted, merged list.
    function mergeBlocks(blocks) {
        const bs = blocks.filter(b => b[0] != null && b[1] != null).sort((a, b) => a[0] - b[0]);
        const out = [];
        bs.forEach(b => {
            const last = out[out.length - 1];
            if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
            else out.push([b[0], b[1]]);
        });
        return out;
    }
    // Free windows within [dayMin, dayMax] given merged busy blocks.
    function freeWindows(busy, dayMin, dayMax) {
        const free = [];
        let cursor = dayMin;
        busy.forEach(([s, e]) => {
            if (s > cursor) free.push([cursor, s]);
            cursor = Math.max(cursor, e);
        });
        if (cursor < dayMax) free.push([cursor, dayMax]);
        return free;
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
        view.innerHTML = segHTML('liteRepView',
                [{ val: 'usage', label: 'Rotation & Usage' }, { val: 'avail', label: 'Availability' }], repView)
            + `<div id="liteRepBody">${loadingHTML()}</div>`;
        view.querySelectorAll('#liteRepView .lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { repView = b.dataset.val; renderReports(); }));
        const bodyEl = view.querySelector('#liteRepBody');
        if (repView === 'avail') await renderAvailability(bodyEl);
        else await renderUsage(bodyEl);
    }

    // Rotation & Usage — scope toggle + bunk search + per-bunk usage bars
    async function renderUsage(bodyEl) {
        const data = await ensureRotation();
        if (activeTab !== 'reports' || repView !== 'usage') return;
        if (!data || !data.counts) {
            bodyEl.innerHTML = emptyHTML('📊', 'Rotation data isn\'t available yet. Generate a schedule first, or check back after today\'s activities are saved.');
            return;
        }
        bodyEl.innerHTML = segHTML('liteRepScope',
                [{ val: 'division', label: 'By division' }, { val: 'grade', label: 'By grade' }], repScope)
            + `<div class="lite-field" style="margin-bottom:10px;">
                 <input class="lite-input" id="liteRepSearch" type="search" placeholder="Search a bunk…" value="${esc(repBunkQuery)}" autocomplete="off">
               </div>
               <div id="liteRepChips"></div><div id="liteRepUsage"></div>`;
        bodyEl.querySelectorAll('#liteRepScope .lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { repScope = b.dataset.val; repSel = null; renderReports(); }));
        const inp = bodyEl.querySelector('#liteRepSearch');
        inp.addEventListener('input', () => { repBunkQuery = inp.value; paintUsage(bodyEl, data); });
        paintUsage(bodyEl, data);
    }

    function paintUsage(bodyEl, data) {
        const chipsEl = bodyEl.querySelector('#liteRepChips');
        const usageEl = bodyEl.querySelector('#liteRepUsage');
        const q = repBunkQuery.trim().toLowerCase();
        let bunks;
        if (q) {
            chipsEl.innerHTML = '';
            bunks = allBunks().filter(b => b.toLowerCase().includes(q));
        } else {
            const chips = scopeChips(repScope);
            if (chips.length) {
                if (!repSel || !chips.includes(repSel)) repSel = chips[0];
                chipsEl.innerHTML = chipRowHTML(chips, repSel);
                chipsEl.querySelectorAll('.lite-chip').forEach(ch =>
                    ch.addEventListener('click', () => { repSel = ch.dataset.val; paintUsage(bodyEl, data); }));
            } else chipsEl.innerHTML = '';
            bunks = bunksForScope(repScope, repSel);
        }
        usageEl.innerHTML = bunks.length ? bunks.map(b => usageCardHTML(b, data)).join('')
                                         : emptyHTML('📊', q ? 'No bunk matches your search.' : 'No bunks here.');
    }

    function usageCardHTML(bunk, data) {
        const counts = data.counts[bunk] || {};
        const acts = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
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
                <div class="lite-usage-top"><span class="lite-usage-name">${esc(act)}</span><span class="lite-usage-count">${n}×</span></div>
                <div class="lite-usage-bar"><span style="width:${Math.round((n / max) * 100)}%"></span></div>
            </div>`).join('')}
        </div>`;
    }

    // Availability — what's free and when, per facility, for the selected date
    async function renderAvailability(bodyEl) {
        bodyEl.innerHTML = dateStripHTML() + `<div id="liteAvailBody">${loadingHTML()}</div>`;
        wireDateStrip(bodyEl, () => renderReports());
        const sched = await getSchedule(currentDate);
        if (activeTab !== 'reports' || repView !== 'avail') return;
        const abody = bodyEl.querySelector('#liteAvailBody');

        const byFac = {};
        let dayMin = Infinity, dayMax = -Infinity;
        if (sched && sched.scheduleAssignments) {
            allBunkRows(sched).forEach(({ bunk }) => normalizeBunkEntries(bunk, sched).forEach(e => {
                if (!e.location || e.startMin == null || e.endMin == null) return;
                (byFac[e.location] = byFac[e.location] || []).push([e.startMin, e.endMin]);
                dayMin = Math.min(dayMin, e.startMin); dayMax = Math.max(dayMax, e.endMin);
            }));
        }
        // Configured facilities that were never used are available all day.
        facilityNames().forEach(f => { if (!byFac[f]) byFac[f] = []; });

        const facs = Object.keys(byFac).sort();
        if (!facs.length || dayMin === Infinity) {
            abody.innerHTML = emptyHTML('🏟️', `No facility data for ${friendlyDate(currentDate)}.`);
            return;
        }
        abody.innerHTML = `<div class="lite-note" style="margin:-2px 2px 10px;">Open times on ${esc(friendlyDate(currentDate))} · camp day ${esc(fmtMin(dayMin))}–${esc(fmtMin(dayMax))}</div>`
            + facs.map(f => {
                const busy = mergeBlocks(byFac[f]);
                const free = freeWindows(busy, dayMin, dayMax);
                const freeTxt = !busy.length ? 'Open all day'
                    : (free.length ? free.map(([s, e]) => `${fmtMin(s)}–${fmtMin(e)}`).join(' · ') : 'Fully booked');
                const badge = !busy.length ? 'open' : (free.length ? `${free.length} open` : 'full');
                return `<div class="lite-card">
                    <div class="lite-usage-top" style="margin-bottom:6px;">
                        <span class="lite-usage-name" style="font-weight:700;">📍 ${esc(f)}</span>
                        <span class="lite-usage-count">${esc(badge)}</span>
                    </div>
                    <div class="lite-slot-loc"><b>Available:</b> ${esc(freeTxt)}</div>
                </div>`;
            }).join('');
    }

    // ════════════════════════════════════════════════════════════════════
    // SHARED UI BITS
    // ════════════════════════════════════════════════════════════════════

    function dateStripHTML() {
        const isToday = currentDate === todayKey();
        const chevL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg>';
        const chevR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>';
        return `<div class="lite-datebar">
            <button type="button" class="lite-date-arrow" id="liteDatePrev" aria-label="Previous day">${chevL}</button>
            <div class="lite-date-pill">
                <div class="lite-date-day">${esc(friendlyDate(currentDate))}</div>
                <div class="lite-date-tag${isToday ? ' today' : ''}">${isToday ? 'Today' : 'Tap to change'}</div>
                <input type="date" id="liteDatePick" value="${esc(currentDate)}" aria-label="Pick a date">
            </div>
            <button type="button" class="lite-date-arrow" id="liteDateNext" aria-label="Next day">${chevR}</button>
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

    function avatarInitials() {
        const src = (userName && userName.trim()) || (userEmail || '').replace(/@.*/, '') || '?';
        const parts = src.split(/[.\s_\-]+/).filter(Boolean);
        const two = ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
        return (two || src[0] || '?').toUpperCase();
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
