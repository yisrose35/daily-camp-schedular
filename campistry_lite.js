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
    // Lite is installed as its own app, so it signs in on its own page rather
    // than bouncing to the marketing site.
    const LOGIN_PAGE = 'campistry_lite_login.html';
    const SMS_BATCH_SIZE = 100;

    // ─── State ──────────────────────────────────────────────────────────
    let campId = null;
    let role = null;
    let userEmail = null;
    let userId = null;
    let campDisplayName = '';
    let userName = null;

    const camp = {
        divisions: {},        // app1.divisions (grade-keyed: {parentDivision, bunks[]})
        divisionOrder: [],    // app1.divisionOrder — parent order set on the Me page
        structure: {},        // campStructure (parent-division-keyed)
        roster: {},           // app1.camperRoster ({ "First Last": {...} })
        leagues: {},          // leaguesByName
        specialty: {},        // specialtyLeagues (id-keyed)
        specialActivities: [],// app1.specialActivities ([{ name, ... }])
        staff: {},            // liteStaffAssignments
        productAccess: null,  // camp_users.product_access — null = unrestricted
        sms: { enabled: false, audience: 'counselors', footer: '' },
        stateLoaded: false,
        stateError: null
    };

    let currentDate = todayKey();
    let activeTab = 'today';
    let currentApp = null;            // null = home launcher; else a LITE_APPS id
    let settingsOpen = false;         // Settings screen visible
    let appUnlocked = false;          // biometric lock cleared this session
    let selectedDivision = null;      // head-staff Roster division chip
    let rosterQuery = '';
    let meRosterQuery = '';           // Me Lite roster search
    let meDivision = null;            // Me Lite roster division chip ('' = all)
    let meMedType = 'All';            // Me Lite medical filter: All/Allergy/Meds/Dietary
    let meMedDivision = 'All';        // Me Lite medical division chip
    let meStaffQuery = '';            // Me Lite staff directory search
    let liveRollDivision = 'All';     // Live Lite roll-call division chip
    let liveChangesQuery = '';        // Live Lite changes search
    const liveDayCache = {};          // dateKey → live daily state (attendance/absences/earlyPickups)
    const liveDayPending = {};        // dateKey → in-flight promise
    let healthData = null;            // cached campistryHealth (dispensingLog, …)
    let healthPending = null;         // in-flight load promise
    let healthMedsQuery = '';         // Health Lite meds board search
    let healthRosterQuery = '';       // Health Lite roster search
    let healthDivision = 'All';       // Health Lite meds/roster division chip
    let healthTripScope = null;       // Health Lite trip: selected division ('All' = whole camp)
    let linkMsgs = null;              // cached link_messages rows
    let linkMsgPending = null;
    let linkForms = null;             // flattened forms from camp_state_kv link_forms
    let linkLists = null;             // link_lists from camp_state_kv
    let linkThreadQuery = '';         // Link Lite messages search
    let linkMsgFilter = 'all';        // all | unread | important | archived
    let linkComposeMode = 'camper';   // division | grade | camper
    let linkComposeRecipients = [];   // [{ type:'division'|'grade'|'camper', name }]
    let linkComposeQuery = '';        // Link Lite compose camper search
    let linkComposeAttach = { form: null, list: null };
    let linkComposeSubject = '';      // persist across attach re-renders
    let linkComposeBody = '';
    let notesArr = null;              // cached notes array (campistryNotes:<userId>)
    let notesPending = null;
    let notesView = 'all';            // all | pinned | reminders | shared | trash
    let notesQuery = '';
    let notesEditorId = null;         // null = list view; else editing this note id
    let notesSaveTimer = null;
    let campUsers = null;             // camp_users (for the note-share picker)
    let nowTargetMin = null;          // Locate time selection; null = live "now"
    let locateQuery = '';
    let rotationData = null;          // cached RotationCloud.load() result

    // Schedule tab
    let schedScope = 'division';      // 'division' | 'grade'
    let schedMode = 'schedule';       // 'schedule' | 'time' | 'grid' | 'now'
    let searchOpen = false;           // search field is collapsed until asked for
    let rainyOn = false;              // mirrors the loaded day's rainy flag
    let schedSel = null;              // selected division/grade chip
    let bunkQuery = '';               // Schedule bunk / facility search
    // Reports tab
    let repView = 'usage';            // 'usage' | 'avail'
    let repScope = 'division';        // 'division' | 'grade'
    let repSel = null;
    let repBunkQuery = '';
    let availQuery = '';              // Availability facility search
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
                window.location.href = LOGIN_PAGE;
                return;
            }
            userEmail = (session.user?.email || '').toLowerCase();

            window.supabase.auth.onAuthStateChange((event) => {
                if (event === 'SIGNED_OUT') window.location.href = LOGIN_PAGE;
            });

            // Camp + role resolution
            setSplash('Loading your camp…');
            try { if (window.CampistryDB?.ready) await window.CampistryDB.ready; } catch (_) {}
            try { await window.AccessControl?.initialize?.(); } catch (e) { console.warn('[Lite] AccessControl init:', e); }

            // Resolve camp_id the SAME way the desktop does — CampistryDB first
            // (the DB-verified `campistry_camp_id`). AccessControl.getCampId()
            // falls back to the user's own id, which for a team-member/admin is
            // NOT the camp id, so preferring it made Lite read a different camp's
            // messages/state than the desktop. CampistryDB is the shared source.
            campId = window.CampistryDB?.getCampId?.()
                  || window.AccessControl?.getCampId?.()
                  || localStorage.getItem('campistry_camp_id');
            role = window.AccessControl?.getCurrentRole?.()
                || window.CampistryDB?.getRole?.()
                || localStorage.getItem('campistry_role')
                || 'viewer';
            userName = window.AccessControl?.getUserName?.() || null;
            userId = window.CampistryDB?.getUserId?.() || localStorage.getItem('campistry_auth_user_id') || null;

            if (!campId) {
                setSplash('No camp found for this account. Ask your camp owner for an invite.');
                return;
            }

            await loadProductAccess();

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
            wirePullToRefresh();
            goHome();
            maybeLockOnBoot();   // biometric app lock, if enabled
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

    // Strip debug-copy decoration: "[COPY] Camp Areivim — 2026-07-06 15:44" → "Camp Areivim"
    function tidyCampName(s) {
        if (!s) return s;
        let out = String(s).replace(/^\s*\[copy\]\s*/i, '');
        out = out.replace(/\s*[—–-]\s*\d{4}-\d{2}-\d{2}[\sT].*$/, '');
        return out.trim() || String(s).trim();
    }

    // Resolve the real camp name from the first trustworthy source.
    async function resolveCampName() {
        const bad = new Set(['', 'your camp', 'unknown camp', 'my camp']);
        const clean = v => {
            const s = tidyCampName((v == null ? '' : String(v)).trim());
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
            // Authoritative parent-division order from Me; manualColumnOrder is
            // the legacy key for camps that never saved a division reorder.
            camp.divisionOrder = (Array.isArray(app1.divisionOrder) && app1.divisionOrder.length)
                ? app1.divisionOrder
                : (Array.isArray(app1.manualColumnOrder) ? app1.manualColumnOrder : []);
            camp.roster = app1.camperRoster || {};
            camp.structure = byKey.campStructure || {};
            camp.leagues = byKey.leaguesByName || {};
            camp.specialty = byKey.specialtyLeagues || {};
            camp.specialActivities = app1.specialActivities || [];
            _specialNames = null;   // reset lazy cache when config reloads
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

    // Live daily state (attendance / absences / early pickups) — synced to the
    // cloud by the office Live app under camp_state_kv key `liveDaily_<date>`.
    // Read-only here. Returns the day payload or null.
    function loadLiveDay(dateKey) {
        if (Object.prototype.hasOwnProperty.call(liveDayCache, dateKey)) {
            return Promise.resolve(liveDayCache[dateKey]);
        }
        if (liveDayPending[dateKey]) return liveDayPending[dateKey];
        liveDayPending[dateKey] = (async () => {
            try {
                const { data, error } = await window.supabase
                    .from('camp_state_kv').select('value')
                    .eq('camp_id', campId).eq('key', 'liveDaily_' + dateKey).maybeSingle();
                if (error) throw error;
                const payload = (data && data.value) ? data.value : null;
                liveDayCache[dateKey] = payload;
                return payload;
            } catch (e) {
                console.warn('[Lite] loadLiveDay failed:', e?.message || e);
                return null;
            } finally {
                delete liveDayPending[dateKey];
            }
        })();
        return liveDayPending[dateKey];
    }

    function invalidateLiveDay(dateKey) { delete liveDayCache[dateKey]; }

    // Health data (dispensingLog, …) — stored in camp_state_kv key `campistryHealth`
    // (the same key the office Health app / global settings use). Read + write here.
    function loadHealth(force) {
        if (healthData && !force) return Promise.resolve(healthData);
        if (healthPending) return healthPending;
        healthPending = (async () => {
            try {
                const { data, error } = await window.supabase
                    .from('camp_state_kv').select('value')
                    .eq('camp_id', campId).eq('key', 'campistryHealth').maybeSingle();
                if (error) throw error;
                healthData = (data && data.value) ? data.value : {};
            } catch (e) {
                console.warn('[Lite] loadHealth failed:', e?.message || e);
                healthData = healthData || {};
            } finally {
                healthPending = null;
            }
            return healthData;
        })();
        return healthPending;
    }

    // Append a dispensing record and persist. Read-latest → append → upsert so a
    // concurrent office/other-device write isn't clobbered by a stale copy.
    async function logMedGiven(camperName, medication) {
        const fresh = await loadHealth(true);
        const hd = Object.assign({ dispensingLog: [], sickVisits: [], doctorVisits: [], bedwettingLog: [], medicalForms: {} }, fresh);
        if (!Array.isArray(hd.dispensingLog)) hd.dispensingLog = [];
        hd.dispensingLog.push({
            camperName, medication, status: 'Given',
            nurse: userName || 'Staff',
            timestamp: new Date().toISOString(),
            date: healthTodayISO(), time: healthNowTime()
        });
        await saveKV('campistryHealth', hd);
        healthData = hd;   // reflect immediately
        return hd;
    }

    function healthTodayISO() { return new Date().toISOString().split('T')[0]; }
    function healthNowTime() { return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }

    // Only head staff mark meds; everyone else sees the live status read-only.
    // (Swap this one predicate for a `nurse` role check later.)
    function canGiveMeds() { return ['owner', 'admin', 'scheduler'].includes(role); }

    // ─── Link data (messages + forms/lists) ─────────────────────────────
    function loadLinkMessages(force) {
        if (linkMsgs && !force) return Promise.resolve(linkMsgs);
        if (linkMsgPending) return linkMsgPending;
        linkMsgPending = (async () => {
            try {
                const { data, error } = await window.supabase
                    .from('link_messages')
                    .select('id,thread_id,direction,parent_name,parent_email,camper_name,subject,body,read,archived,important,hidden_for_admin,created_at')
                    .eq('camp_id', campId).order('created_at', { ascending: true }).limit(500);
                if (error) throw error;
                // Exclude anything hidden from the admin/staff inbox (soft delete).
                linkMsgs = (data || []).filter(m => !m.hidden_for_admin);
            } catch (e) { console.warn('[Lite] loadLinkMessages failed:', e?.message || e); linkMsgs = linkMsgs || []; }
            finally { linkMsgPending = null; }
            return linkMsgs;
        })();
        return linkMsgPending;
    }

    async function loadLinkFormsLists() {
        try {
            const { data, error } = await window.supabase
                .from('camp_state_kv').select('key,value').eq('camp_id', campId).in('key', ['link_forms', 'link_lists']);
            if (error) throw error;
            const byKey = {}; (data || []).forEach(r => { byKey[r.key] = r.value; });
            const lf = byKey.link_forms || {};
            linkForms = [].concat(
                (lf.digital || []).map(f => ({ ...f, _cat: 'Form' })),
                (lf.printReturn || []).map(f => ({ ...f, _cat: 'Print & return' })),
                (lf.documents || []).map(f => ({ ...f, _cat: 'Document' }))
            ).filter(Boolean);
            linkLists = Array.isArray(byKey.link_lists) ? byKey.link_lists : [];
        } catch (e) { console.warn('[Lite] loadLinkFormsLists failed:', e?.message || e); linkForms = linkForms || []; linkLists = linkLists || []; }
    }

    // Send a message the same way the desktop does — a link_messages row the
    // parent portal reads (email/SMS channels are best-effort placeholders there).
    async function sendLinkMessage(opts) {
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const row = {
            id, camp_id: campId, thread_id: opts.threadId || id, direction: 'out',
            parent_name: opts.parentName || '', parent_email: opts.parentEmail || '',
            camper_name: opts.camperName || null, subject: opts.subject || '',
            body: opts.body || '', channels: ['app'], read: false
        };
        const { error } = await window.supabase.from('link_messages').insert(row);
        if (error) throw error;
        if (linkMsgs) linkMsgs.push({ ...row, created_at: new Date().toISOString() });
        return row;
    }

    function linkLabelOf(item) { return item && (item.name || item.title || item.label || 'Untitled'); }

    // ─── Notes data (per-user, private-unless-shared) ───────────────────
    // Stored in the `campistry_notes` table with per-user RLS (owner sees + edits
    // their own; recipients read notes shared with their email). One row per note.
    function rowToNote(r) {
        return {
            id: r.id, ownerId: r.owner_id, title: r.title || '', body: r.body || '',
            color: r.color || 'yellow', pinned: !!r.pinned, tags: r.tags || [],
            sharedWith: Array.isArray(r.shared_with) ? r.shared_with : [], isShared: !!r.is_shared,
            reminder: r.reminder || null, trashed: !!r.trashed,
            createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
            updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now()
        };
    }
    function noteToRow(n) {
        return {
            id: n.id, camp_id: campId, owner_id: userId,
            title: n.title || '', body: n.body || '', color: n.color || 'yellow',
            pinned: !!n.pinned, tags: n.tags || [],
            shared_with: (n.sharedWith || []).map(e => String(e).trim().toLowerCase()).filter(Boolean),
            is_shared: !!n.isShared, reminder: n.reminder || null, trashed: !!n.trashed,
            updated_at: new Date().toISOString()
        };
    }
    // A note is editable only by its owner (a note created locally has no ownerId yet).
    function canEditNote(n) { return !!n && (!n.ownerId || n.ownerId === userId); }

    function loadNotes(force) {
        if (notesArr && !force) return Promise.resolve(notesArr);
        if (notesPending) return notesPending;
        notesPending = (async () => {
            try {
                const { data, error } = await window.supabase
                    .from('campistry_notes').select('*').eq('camp_id', campId);
                if (error) throw error;
                notesArr = (data || []).map(rowToNote);
            } catch (e) { console.warn('[Lite] loadNotes failed:', e?.message || e); notesArr = notesArr || []; }
            finally { notesPending = null; }
            return notesArr;
        })();
        return notesPending;
    }

    async function upsertNote(n) {
        if (!canEditNote(n)) return;
        n.ownerId = userId; n.updatedAt = Date.now();
        try {
            const { error } = await window.supabase.from('campistry_notes').upsert(noteToRow(n), { onConflict: 'id' });
            if (error) throw error;
        } catch (e) { console.warn('[Lite] upsertNote failed:', e?.message || e); }
    }
    async function deleteNoteRow(id) {
        try { const { error } = await window.supabase.from('campistry_notes').delete().eq('id', id); if (error) throw error; }
        catch (e) { console.warn('[Lite] deleteNoteRow failed:', e?.message || e); }
    }
    function scheduleNoteSave(n) {
        clearTimeout(notesSaveTimer);
        notesSaveTimer = setTimeout(() => upsertNote(n), 700);
    }

    const NOTE_COLORS = ['yellow', 'peach', 'pink', 'blue', 'green', 'purple', 'slate'];
    function noteById(id) { return (notesArr || []).find(n => n.id === id); }

    // Camp members (from camp_users) — the pool for the note-share picker.
    // Which products this member may open. Same source and same rules as the
    // desktop's product_access_guard: owner and admin get everything, and an
    // unresolvable membership fails OPEN rather than locking someone out.
    async function loadProductAccess() {
        camp.productAccess = null;
        try {
            if (role === 'owner' || !userId || !window.supabase) return;
            const { data, error } = await window.supabase
                .from('camp_users').select('role,product_access')
                .eq('camp_id', campId).eq('user_id', userId).maybeSingle();
            if (error || !data) return;                              // fail open
            if (String(data.role || '').toLowerCase() === 'admin') return;
            if (Array.isArray(data.product_access)) camp.productAccess = data.product_access;
        } catch (e) {
            console.warn('[Lite] product access lookup failed:', e?.message || e);
        }
    }

    async function loadCampUsers() {
        if (campUsers) return campUsers;
        try {
            const { data, error } = await window.supabase
                .from('camp_users').select('email,name,role').eq('camp_id', campId);
            if (error) throw error;
            campUsers = (data || []).filter(u => u && u.email);
        } catch (e) { console.warn('[Lite] loadCampUsers failed:', e?.message || e); campUsers = campUsers || []; }
        return campUsers;
    }

    // Update a link_messages flag column (read/important/archived), cloud + local.
    async function updateLinkFlag(id, field, value) {
        const patch = {}; patch[field] = !!value;
        const m = (linkMsgs || []).find(x => x.id === id);
        if (m) m[field] = !!value;   // optimistic
        try {
            const { error } = await window.supabase.from('link_messages').update(patch).eq('id', id).eq('camp_id', campId);
            if (error) throw error;
        } catch (e) { console.warn('[Lite] link flag update failed:', e?.message || e); }
    }

    // Thread-level flag: apply to every message in the thread (matches how the
    // desktop stores per-message flags; a thread reads as important/archived).
    async function setThreadFlag(thread, field, value) {
        await Promise.all(thread.msgs.map(m => updateLinkFlag(m.id, field, value)));
    }
    async function markThreadRead(thread) {
        const unread = thread.msgs.filter(m => m.direction === 'in' && !m.read);
        if (!unread.length) return;
        await Promise.all(unread.map(m => updateLinkFlag(m.id, 'read', true)));
    }

    function canDeleteMessages() { return ['owner', 'admin'].includes(role); }
    // Per-user Lite preferences (localStorage). `confirmDelete` defaults on.
    function litePref(key, def) {
        try { const p = JSON.parse(localStorage.getItem('campistry_lite_prefs') || '{}'); return key in p ? p[key] : def; }
        catch (e) { return def; }
    }
    function setLitePref(key, val) {
        try { const p = JSON.parse(localStorage.getItem('campistry_lite_prefs') || '{}'); p[key] = val; localStorage.setItem('campistry_lite_prefs', JSON.stringify(p)); }
        catch (e) {}
    }
    // "Delete" is an admin-side soft hide (hidden_for_admin) — it disappears from
    // the staff inbox but the parent keeps their copy (get_my_messages ignores it).
    async function deleteThread(thread) {
        try {
            await Promise.all(thread.msgs.map(m =>
                window.supabase.from('link_messages').update({ hidden_for_admin: true }).eq('id', m.id).eq('camp_id', campId)));
            const ids = new Set(thread.msgs.map(m => m.id));
            linkMsgs = (linkMsgs || []).filter(m => !ids.has(m.id));
            toast('Conversation deleted');
        } catch (e) { toast('Could not delete — try again'); }
        paintLinkThreads();
    }
    function confirmDeleteThread(key) {
        const t = linkThreads().find(x => x.key === key);
        if (!t) return;
        openSheet(`<div class="lite-sheet-title">Delete conversation?</div>
            <div class="lite-note" style="margin-top:-6px;">This removes the conversation with <b>${esc(t.parentName || 'this parent')}</b> from your inbox. The parent keeps their copy.</div>
            <label class="lite-check-row"><input type="checkbox" id="liteDontAsk"><span>Don't ask again</span></label>
            <div class="lite-compose-actions">
                <button class="lite-btn secondary" id="liteDelCancel">Cancel</button>
                <button class="lite-btn danger" id="liteDelConfirm">Delete</button>
            </div>`);
        if (!sheetEl) return;
        sheetEl.querySelector('#liteDelCancel').addEventListener('click', closeSheet);
        sheetEl.querySelector('#liteDelConfirm').addEventListener('click', () => {
            if (sheetEl.querySelector('#liteDontAsk')?.checked) setLitePref('confirmDelete', false);
            closeSheet();
            deleteThread(t);
        });
    }

    // Grade names (structure order), for compose "by grade".
    function allGrades() {
        const out = [];
        Object.values(camp.structure || {}).forEach(s =>
            (s.gradeOrder || Object.keys(s.grades || {})).forEach(g => { if (!out.includes(g)) out.push(g); }));
        if (out.length) return out;
        Object.values(camp.roster || {}).forEach(c => { if (c && c.grade && !out.includes(c.grade)) out.push(c.grade); });
        return out;
    }

    // ─── Camp-structure helpers ─────────────────────────────────────────

    // ── Display order ───────────────────────────────────────────────────
    // Mirrors the Me page's _sortedDivisions / _sortedGrades so every list here
    // reads in the order the camp arranged: divisions by app1.divisionOrder
    // (manualColumnOrder for legacy camps), grades by their division's
    // gradeOrder, bunks by the order stored on the grade.
    function orderBy(names, order) {
        const pos = {};
        (order || []).forEach((k, i) => { pos[k] = i; });
        return names.slice().sort((a, b) => {
            const ai = pos[a] == null ? 9999 : pos[a];
            const bi = pos[b] == null ? 9999 : pos[b];
            if (ai !== bi) return ai - bi;
            return String(a).localeCompare(String(b));
        });
    }
    // Me's fallback when no explicit order was ever saved: numeric-aware.
    function naturalSort(names) {
        return names.slice().sort((a, b) => {
            const na = parseInt(a, 10), nb = parseInt(b, 10);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return String(a).localeCompare(String(b));
        });
    }

    // Grade-level keys (app1.divisions is grade-keyed: each is a grade with
    // bunks), walked division by division so grades come out in Me's order.
    function gradeKeys() {
        const out = [];
        parentDivisions().forEach(p => {
            const s = camp.structure?.[p];
            if (!s || !s.grades) return;
            const keys = Object.keys(s.grades);
            const ord = Array.isArray(s.gradeOrder) ? s.gradeOrder : [];
            (ord.length ? orderBy(keys, ord) : keys).forEach(g => { if (!out.includes(g)) out.push(g); });
        });
        // Grades that only exist in app1.divisions trail the structured ones.
        Object.keys(camp.divisions || {}).forEach(g => { if (!out.includes(g)) out.push(g); });
        return out;
    }

    // The bunks of one grade, preferring campStructure's order (what Me writes).
    function bunksForGrade(grade) {
        for (const p of Object.keys(camp.structure || {})) {
            const g = camp.structure[p]?.grades?.[grade];
            if (g && Array.isArray(g.bunks) && g.bunks.length) return g.bunks;
        }
        return (camp.divisions?.[grade] && camp.divisions[grade].bunks) || [];
    }

    // Chips + bunks for a scope ('division' → parent divisions, 'grade' → grades)
    function scopeChips(scope) { return scope === 'grade' ? gradeKeys() : parentDivisions(); }
    function bunksForScope(scope, sel) {
        if (!sel) return [];
        return scope === 'grade' ? bunksForGrade(sel) : bunksForParent(sel);
    }

    // Segmented control (mode / scope toggles)
    function segHTML(id, options, active) {
        return `<div class="lite-seg" id="${id}">${options.map(o =>
            `<button type="button" class="lite-seg-btn${o.val === active ? ' active' : ''}" data-val="${o.val}">${esc(o.label)}</button>`).join('')}</div>`;
    }

    // Parent divisions in the order set on the Me page.
    function parentDivisions() {
        let names = Object.keys(camp.structure || {});
        if (!names.length) {
            // Fallback: derive from grade-keyed app1.divisions
            names = [];
            Object.entries(camp.divisions || {}).forEach(([gradeKey, d]) => {
                const p = d?.parentDivision || gradeKey;
                if (!names.includes(p)) names.push(p);
            });
        }
        const ord = Array.isArray(camp.divisionOrder) ? camp.divisionOrder : [];
        return ord.length ? orderBy(names, ord) : naturalSort(names);
    }

    // All bunks under a parent division (union across its grades, in Me's order)
    function bunksForParent(parent) {
        const out = [];
        const s = camp.structure?.[parent];
        if (s && s.grades) {
            // orderBy over ALL grade keys, not gradeOrder alone — a grade added
            // after the last reorder is missing from gradeOrder and would
            // otherwise drop its bunks entirely.
            const keys = Object.keys(s.grades);
            const ord = Array.isArray(s.gradeOrder) ? s.gradeOrder : [];
            (ord.length ? orderBy(keys, ord) : keys)
                .forEach(g => (s.grades[g]?.bunks || []).forEach(b => { if (!out.includes(b)) out.push(b); }));
            if (out.length) return out;
        }
        Object.entries(camp.divisions || {}).forEach(([gradeKey, d]) => {
            const p = d?.parentDivision || gradeKey;
            if (p === parent) (d?.bunks || []).forEach(b => { if (!out.includes(b)) out.push(b); });
        });
        return out;
    }

    // Loose name matching. Config and the saved schedule don't always spell a
    // bunk/division identically ("Bunk לב" vs "לב", stray spaces, case), and an
    // exact-only lookup silently yields an empty day. Normalize before comparing.
    function normKey(s) {
        return String(s ?? '').trim().toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/^(?:bunk|shiur|kita)\s+/i, '');
    }
    // Exact key first, then a normalized match. Returns the object's real key.
    function matchKey(obj, name) {
        if (!obj || name == null) return null;
        if (Object.prototype.hasOwnProperty.call(obj, name)) return name;
        const want = normKey(name);
        if (!want) return null;
        return Object.keys(obj).find(k => normKey(k) === want) || null;
    }
    function sameName(a, b) { return normKey(a) === normKey(b); }

    // The grade-level division key (matches divisionTimes/leagueAssignments keys)
    function divKeyForBunk(bunk) {
        const divs = camp.divisions || {};
        for (const [key, d] of Object.entries(divs)) {
            if (Array.isArray(d?.bunks) && d.bunks.includes(bunk)) return key;
        }
        for (const [key, d] of Object.entries(divs)) {
            if (Array.isArray(d?.bunks) && d.bunks.some(b => sameName(b, bunk))) return key;
        }
        return null;
    }

    // Resolve which key of a schedule sub-map (divisionTimes / leagueAssignments)
    // holds this bunk's division. Tries the grade key, the parent division, and a
    // normalized match, so a naming mismatch never blanks out the day.
    function divKeyIn(map, bunk) {
        if (!map) return null;
        const grade = divKeyForBunk(bunk);
        const parent = parentForBunk(bunk);
        for (const cand of [grade, parent]) {
            const k = matchKey(map, cand);
            if (k) return k;
        }
        // Last resort: a division key whose configured bunks include this bunk.
        for (const key of Object.keys(map)) {
            const d = camp.divisions?.[key] || camp.divisions?.[matchKey(camp.divisions || {}, key)];
            if (d && Array.isArray(d.bunks) && d.bunks.some(b => sameName(b, bunk))) return key;
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
        // Division → grade → bunk, so the camp's own order carries through.
        parentDivisions().forEach(p =>
            bunksForParent(p).forEach(b => { if (!out.includes(b)) out.push(b); }));
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
        meRoster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        meMedical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
        meStaff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/><path d="M19 8h4"/><path d="M21 6v4"/></svg>',
        liveRoll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
        liveChanges: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
        healthMeds: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><path d="m8.5 8.5 7 7"/></svg>',
        healthRoster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        healthTrip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 19V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v13"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M4 19h16"/><path d="M12 8v7"/></svg>',
        linkMessages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        linkCompose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
        notesList: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
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
        { id: 'me',     name: 'Me',     title: 'Me Lite', logo: 'Me_clean.png', color: '#F59E0B',
          theme: { accent: '#F59E0B', dark: '#B45309', tint: '#FEF3C7' }, roles: HEAD, status: 'available',
          tabs: [{ id: 'meRoster', label: 'Roster' }, { id: 'meMedical', label: 'Medical' }, { id: 'meStaff', label: 'Staff' }] },
        { id: 'go',     name: 'Go',     logo: 'Go_clean.png',     color: '#0EA5E9', theme: { accent: '#0EA5E9', dark: '#0369A1', tint: '#E0F2FE' }, roles: HEAD, status: 'soon' },
        { id: 'health', name: 'Health', title: 'Health Lite', logo: 'Health_clean.png', color: '#6B21A8',
          theme: { accent: '#6B21A8', dark: '#581C87', tint: '#F3E8FF' }, roles: HEAD, status: 'available',
          tabs: [{ id: 'healthMeds', label: 'Meds' }, { id: 'healthRoster', label: 'Roster' }, { id: 'healthTrip', label: 'Trip' }] },
        { id: 'live',   name: 'Live',   title: 'Live Lite', logo: 'Live_clean.png', color: '#2563EB',
          theme: { accent: '#2563EB', dark: '#1D4ED8', tint: '#DBEAFE' }, roles: HEAD, status: 'available',
          tabs: [{ id: 'liveRoll', label: 'Roll Call' }, { id: 'liveChanges', label: 'Changes' }] },
        { id: 'link',   name: 'Link',   title: 'Link Lite', logo: 'Link_clean.png', color: '#2A7A35',
          theme: { accent: '#2A7A35', dark: '#1F5A28', tint: '#E4F3E6' }, roles: HEAD, status: 'available',
          tabs: [{ id: 'linkMessages', label: 'Messages' }, { id: 'linkCompose', label: 'Compose' }] },
        { id: 'notes',  name: 'Notes',  title: 'Notes Lite', logo: 'Notes_clean.png', color: '#C4891A',
          theme: { accent: '#C4891A', dark: '#9A6A12', tint: '#FBF0D8' }, roles: HEAD, status: 'available',
          tabs: [{ id: 'notesList', label: 'Notes' }] },
        { id: 'guard',  name: 'Guard',
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6z"/><polyline points="9.2 12 11.2 14 15 10.2"/></svg>',
          color: '#4338CA',
          theme: { accent: '#4338CA', dark: '#3730A3', tint: '#EEF2FF' }, roles: HEAD, status: 'soon' },
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

    // Per-user app access, read from the SAME place the desktop uses
    // (camp_users.product_access, managed by the owner in the Team screen) so
    // Lite and the website can never disagree. Mirrors product_access_guard.js:
    // the camp owner and admins get everything, an unresolvable membership
    // fails OPEN, and everyone else needs the product in their list.
    function allowedAppIds() {
        return Array.isArray(camp.productAccess) ? camp.productAccess : null;   // null = unrestricted
    }
    function canOpenApp(id) {
        const app = LITE_APPS.find(a => a.id === id);
        if (!app || !app.roles.includes(role)) return false;
        const allow = allowedAppIds();
        // 'counselor' is the counselor role's own home, not a grantable product.
        if (!allow || id === 'counselor') return true;
        return allow.includes(id);
    }
    function appsForRole() {
        return LITE_APPS.filter(a => a.roles.includes(role) && canOpenApp(a.id));
    }

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
            + `<div class="lite-launch-grid${single ? ' single' : ''}">${apps.map(a => tileHTML(a)).join('')}</div>`;

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
            <span class="lite-launch-icon-box">
                ${app.icon
                    ? `<span class="lite-launch-logo lite-launch-icon">${app.icon}</span>`
                    : `<img src="${app.logo}" class="lite-launch-logo" alt="">`}
            </span>
            <span class="lite-launch-name">${esc(app.name)}</span>
            ${soon ? '<span class="lite-launch-soon">Soon</span>' : ''}
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
        // Also gate here, not just in the launcher — a restored history entry or
        // a hand-typed state must not open an app the user can't have.
        if (!canOpenApp(id)) { goHome(); toast('You don’t have access to ' + app.name); return; }
        currentApp = id;
        applyTheme(app);
        // Push a history entry so the phone's back gesture returns to the
        // launcher (dashboard) instead of leaving the site.
        try { history.pushState({ liteApp: id }, ''); } catch (_) {}
        document.getElementById('view-home').style.display = 'none';
        setHeader('', '');   // no title bar in-app — just back + avatar
        document.getElementById('liteApp').setAttribute('data-screen', 'app');
        haptic();
        buildTabs(app.tabs);
        switchTab(app.tabs[0].id, 'push');
    }

    function goHome() {
        currentApp = null;
        settingsOpen = false;
        applyTheme(null);
        showNotesFab(false);
        document.querySelectorAll('.lite-view').forEach(v => { v.style.display = 'none'; });
        document.getElementById('view-home').style.display = '';   // was hidden by openApp
        document.getElementById('liteApp').setAttribute('data-screen', 'home');
        setHeaderHome();
        renderHome();
        animateIn(document.getElementById('view-home'), 'pop');
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

    // Pull-to-refresh. A standalone app has no browser reload, so without this
    // the only way to get fresh data is to kill and reopen it.
    function wirePullToRefresh() {
        const main = document.getElementById('liteMain') || document.querySelector('.lite-main');
        if (!main || main.dataset.ptr) return;
        main.dataset.ptr = '1';
        const ind = document.createElement('div');
        ind.className = 'lite-ptr';
        ind.innerHTML = '<span class="lite-ptr-spin"></span>';
        main.parentNode.insertBefore(ind, main);
        let y0 = null, dy = 0, armed = false, busy = false;
        const THRESHOLD = 72;
        document.addEventListener('touchstart', e => {
            if (busy || e.touches.length !== 1) return;
            armed = window.scrollY <= 0 && !document.querySelector('.lite-sheet-backdrop');
            y0 = armed ? e.touches[0].clientY : null; dy = 0;
        }, { passive: true });
        document.addEventListener('touchmove', e => {
            if (y0 == null || busy) return;
            dy = e.touches[0].clientY - y0;
            if (dy <= 0) { ind.style.height = '0px'; return; }
            ind.style.height = Math.min(dy * 0.45, THRESHOLD) + 'px';
            ind.classList.toggle('ready', dy * 0.45 >= THRESHOLD - 4);
        }, { passive: true });
        document.addEventListener('touchend', async () => {
            if (y0 == null || busy) { y0 = null; return; }
            const go = dy * 0.45 >= THRESHOLD - 4;
            y0 = null;
            if (!go) { ind.style.height = '0px'; ind.classList.remove('ready'); return; }
            busy = true; haptic(10);
            ind.style.height = THRESHOLD + 'px';
            ind.classList.add('busy');
            try { await refreshCurrent(); } catch (_) {}
            ind.style.height = '0px';
            ind.classList.remove('ready', 'busy');
            busy = false;
        });
    }

    // Drop cached data for what's on screen and re-render it.
    async function refreshCurrent() {
        Object.keys(scheduleCache).forEach(k => delete scheduleCache[k]);
        campUsers = null;
        try { await loadCampState(); } catch (_) {}
        if (currentApp) renderView(activeTab); else renderHome();
        // Give the repaint a beat so the gesture doesn't snap back instantly.
        await new Promise(r => setTimeout(r, 320));
    }

    // A short tick on tap. Real apps confirm a press physically; on the web
    // that's the Vibration API, which iOS Safari ignores — so it's a bonus on
    // Android, never a dependency.
    function haptic(ms) {
        try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (_) {}
    }

    // Screens push in from the right and pop back to the right, the way a
    // native stack behaves, instead of every view doing the same fade.
    function animateIn(el, dir) {
        if (!el) return;
        el.classList.remove('anim', 'anim-push', 'anim-pop');
        void el.offsetWidth;
        el.classList.add(dir === 'pop' ? 'anim-pop' : dir === 'push' ? 'anim-push' : 'anim');
    }

    function buildTabs(tabs) {
        const bar = document.getElementById('liteTabbar');
        bar.innerHTML = '';
        (tabs || []).forEach(t => {
            const btn = document.createElement('button');
            btn.className = 'lite-tab';
            btn.dataset.tab = t.id;
            btn.innerHTML = `<span class="lite-tab-ic">${TAB_ICONS[t.id] || ''}</span><span>${esc(t.label)}</span>`;
            btn.addEventListener('click', () => { haptic(); switchTab(t.id); });
            bar.appendChild(btn);
        });
    }

    function switchTab(id, dir) {
        activeTab = id;
        if (id !== 'notesList') { notesEditorId = null; showNotesFab(false); }
        document.querySelectorAll('.lite-tab').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === id));
        document.querySelectorAll('.lite-view').forEach(v => { v.style.display = 'none'; });
        const view = document.getElementById('view-' + id);
        if (view) { view.style.display = ''; animateIn(view, dir); }
        renderView(id);
        try { window.scrollTo({ top: 0 }); } catch (_) {}
    }

    function renderView(id) {
        if (id === 'today') renderToday();
        else if (id === 'locate') renderLocate();
        else if (id === 'reports') renderReports();
        else if (id === 'roster') renderRoster();
        else if (id === 'meRoster') renderMeRoster();
        else if (id === 'meMedical') renderMeMedical();
        else if (id === 'meStaff') renderMeStaff();
        else if (id === 'liveRoll') renderLiveRoll();
        else if (id === 'liveChanges') renderLiveChanges();
        else if (id === 'healthMeds') renderHealthMeds();
        else if (id === 'healthRoster') renderHealthRoster();
        else if (id === 'healthTrip') renderHealthTrip();
        else if (id === 'linkMessages') renderLinkMessages();
        else if (id === 'linkCompose') renderLinkCompose();
        else if (id === 'notesList') renderNotes();
        else if (id === 'league') renderLeague();
        else if (id === 'staff') renderStaff();
        else if (id === 'messaging') renderMessaging();
    }

    function toggleMenu(e) {
        if (e) e.stopPropagation();
        const menu = document.getElementById('liteMenu');
        menu.style.display = menu.style.display === 'none' ? '' : 'none';
    }

    // ════════════════════════════════════════════════════════════════════
    // SETTINGS SCREEN  (chrome — not a Lite app)
    // ════════════════════════════════════════════════════════════════════

    function openSettings() {
        settingsOpen = true;
        showNotesFab(false);
        try { history.pushState({ liteSettings: true }, ''); } catch (_) {}
        document.querySelectorAll('.lite-view').forEach(v => { v.style.display = 'none'; });
        const v = document.getElementById('view-settings');
        v.style.display = '';
        document.getElementById('liteApp').setAttribute('data-screen', 'settings');
        renderSettings();
        animateIn(v);
        try { window.scrollTo({ top: 0 }); } catch (_) {}
    }

    async function renderSettings() {
        const v = document.getElementById('view-settings');
        const bioAvail = await biometricAvailable();
        const bioOn = !!litePref('biometricLock', false);
        const confirmDel = !!litePref('confirmDelete', true);
        const roleLabel = cap(role || 'viewer');
        const camp = campDisplayName ? esc(campDisplayName) : '';

        v.innerHTML = `
            <div class="lite-settings-head">
                <button class="lite-settings-back" id="liteSettingsBack" aria-label="Back">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <div class="lite-settings-title">Settings</div>
            </div>

            <div class="lite-set-account">
                <div class="lite-set-avatar">${esc(avatarInitials())}</div>
                <div class="lite-set-id">
                    <div class="lite-set-name">${esc(userName || userEmail || 'Your account')}</div>
                    <div class="lite-set-sub">${esc(userEmail || '')}</div>
                    <div class="lite-set-tags"><span class="lite-pill">${esc(roleLabel)}</span>${camp ? `<span class="lite-pill gray">${camp}</span>` : ''}</div>
                </div>
            </div>

            <div class="lite-set-section-label">Security</div>
            <div class="lite-card lite-set-row" id="liteBioRow">
                <div class="lite-set-row-main">
                    <div class="lite-set-row-title">Biometric app lock</div>
                    <div class="lite-set-row-sub" id="liteBioSub">${bioAvail
                        ? 'Require Face ID / fingerprint to open Campistry Lite'
                        : 'Not available on this device or browser'}</div>
                </div>
                <span class="lite-toggle${bioOn ? ' on' : ''}${bioAvail ? '' : ' disabled'}" id="liteBioToggle"></span>
            </div>
            ${bioOn ? `<button class="lite-link-row" id="liteBioTest">Test unlock now</button>` : ''}

            <div class="lite-set-section-label">Messages</div>
            <div class="lite-card lite-set-row" id="liteConfirmRow">
                <div class="lite-set-row-main">
                    <div class="lite-set-row-title">Confirm before deleting</div>
                    <div class="lite-set-row-sub">Ask for confirmation on a delete swipe</div>
                </div>
                <span class="lite-toggle${confirmDel ? ' on' : ''}" id="liteConfirmToggle"></span>
            </div>

            <div class="lite-set-section-label">This app</div>
            <div class="lite-set-guide">
                <p><b>Campistry Lite is your camp, on your phone.</b> It's a standalone app — add it to your home screen (Share → <i>Add to Home Screen</i>) and it opens full-screen like any native app.</p>
                <p><b>Signing in.</b> You stay signed in on this device; use <i>Sign out</i> below to switch accounts. For a shared or lost phone, turn on <b>Biometric app lock</b> above so only you can open it.</p>
                <p><b>What you can do here</b> depends on your role (<b>${esc(roleLabel)}</b>): head staff get Flow, Me, Live, Health and Link; counselors get their bunk. Everything reads from the same cloud as the desktop Campistry.</p>
            </div>
            <a href="dashboard.html" class="lite-link-row">Open full Campistry ↗</a>
            <button class="lite-link-row danger" id="liteSettingsSignout">Sign out</button>
            <div class="lite-set-version">Campistry Lite${camp ? ' · ' + camp : ''}</div>`;

        v.querySelector('#liteSettingsBack').addEventListener('click', () => { if (history.state && history.state.liteSettings) history.back(); else { settingsOpen = false; goHome(); } });
        v.querySelector('#liteConfirmToggle').addEventListener('click', () => { setLitePref('confirmDelete', !litePref('confirmDelete', true)); renderSettings(); });
        v.querySelector('#liteSettingsSignout').addEventListener('click', () => document.getElementById('liteSignOut').click());
        const bioToggle = v.querySelector('#liteBioToggle');
        if (bioAvail) bioToggle.addEventListener('click', () => toggleBiometric(!bioOn));
        const bioTest = v.querySelector('#liteBioTest');
        if (bioTest) bioTest.addEventListener('click', async () => { const ok = await verifyBiometric(); toast(ok ? 'Unlocked ✓' : 'Could not verify'); });
    }

    // ─── Biometric app lock (WebAuthn platform authenticator) ────────────
    function biometricAvailable() {
        try {
            if (!window.PublicKeyCredential || !window.isSecureContext) return Promise.resolve(false);
            return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
        } catch (e) { return Promise.resolve(false); }
    }
    function randomBytes(n) { const a = new Uint8Array(n); (window.crypto || {}).getRandomValues?.(a); return a; }
    function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
    function unb64(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

    async function toggleBiometric(on) {
        if (on) {
            try {
                const cred = await navigator.credentials.create({ publicKey: {
                    challenge: randomBytes(32),
                    rp: { name: 'Campistry Lite' },
                    user: { id: randomBytes(16), name: userEmail || 'campistry', displayName: userName || 'Campistry user' },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
                    timeout: 60000
                } });
                if (!cred) throw new Error('no credential');
                localStorage.setItem('lite_biometric_cred', b64(cred.rawId));
                setLitePref('biometricLock', true);
                appUnlocked = true;
                toast('Biometric lock on');
            } catch (e) { toast('Could not set up biometrics'); }
        } else {
            localStorage.removeItem('lite_biometric_cred');
            setLitePref('biometricLock', false);
            toast('Biometric lock off');
        }
        renderSettings();
    }

    async function verifyBiometric() {
        try {
            const idB64 = localStorage.getItem('lite_biometric_cred');
            const allow = idB64 ? [{ type: 'public-key', id: unb64(idB64) }] : [];
            const assertion = await navigator.credentials.get({ publicKey: {
                challenge: randomBytes(32),
                allowCredentials: allow,
                userVerification: 'required',
                timeout: 60000
            } });
            return !!assertion;
        } catch (e) { return false; }
    }

    // Show the lock screen on boot / resume when enabled; returns true if locked.
    function biometricLockEnabled() {
        return !!litePref('biometricLock', false) && !!localStorage.getItem('lite_biometric_cred');
    }
    function showLock() {
        appUnlocked = false;
        const el = document.getElementById('liteLock');
        const sub = document.getElementById('liteLockSub');
        if (sub) sub.textContent = campDisplayName ? campDisplayName : 'Locked';
        if (el) el.style.display = '';
    }
    function hideLock() {
        appUnlocked = true;
        const el = document.getElementById('liteLock');
        if (el) el.style.display = 'none';
    }
    async function attemptUnlock() {
        const ok = await verifyBiometric();
        if (ok) hideLock();
        else toast('Could not verify — try again');
    }
    function maybeLockOnBoot() {
        if (!biometricLockEnabled()) { appUnlocked = true; return; }
        showLock();
        // Prompt immediately (some platforms require a user gesture; the Unlock
        // button is the fallback if the auto-prompt is blocked).
        attemptUnlock();
    }

    function wireChrome() {
        // Back chevron → return to the launcher (dashboard). Route through
        // history so the hardware/browser back does the same thing.
        document.getElementById('liteBackBtn').addEventListener('click', () => {
            if (history.state && history.state.liteApp) history.back();
            else goHome();
        });
        window.addEventListener('popstate', () => { if (settingsOpen) { settingsOpen = false; goHome(); } else if (currentApp) goHome(); });
        const menu = document.getElementById('liteMenu');
        document.getElementById('liteMenuBtn').addEventListener('click', toggleMenu);
        document.addEventListener('click', () => { menu.style.display = 'none'; });
        menu.addEventListener('click', (e) => e.stopPropagation());

        // Settings screen entry point.
        const settingsBtn = document.getElementById('liteMenuSettings');
        if (settingsBtn) settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('liteMenu').style.display = 'none';
            openSettings();
        });

        // Biometric lock screen buttons.
        const lockBtn = document.getElementById('liteLockUnlock');
        if (lockBtn) lockBtn.addEventListener('click', () => attemptUnlock());
        const lockOut = document.getElementById('liteLockSignout');
        if (lockOut) lockOut.addEventListener('click', () => document.getElementById('liteSignOut').click());
        // Re-lock when the app returns to the foreground.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && appUnlocked && biometricLockEnabled()) { showLock(); attemptUnlock(); }
        });

        document.getElementById('liteSignOut').addEventListener('click', async () => {
            try { await window.supabase.auth.signOut(); } catch (_) {}
            ['campistry_auth_user_id', 'campistry_camp_id', 'campistry_role',
             'campistry_user_id', 'campistry_is_team_member'].forEach(k => {
                try { localStorage.removeItem(k); } catch (_) {}
            });
            window.location.href = LOGIN_PAGE;
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

        // Head staff / viewer. Phone real estate is the scarce resource, so the
        // controls collapse to ONE row: two labelled pickers plus search and
        // overflow as icons. Everything else opens in a sheet on demand.
        const isFac = schedScope === 'facility';
        ensureSchedSel();
        view.innerHTML = dateStripHTML()
            + toolbarHTML(isFac)
            + (searchOpen ? `<div class="lite-searchrow">
                 <input class="lite-input" id="liteBunkSearch" type="search" placeholder="${isFac ? 'Search a facility…' : 'Search a bunk…'}" value="${esc(bunkQuery)}" autocomplete="off">
               </div>` : '')
            + `<div id="liteSchedBody">${loadingHTML()}</div>`;
        wireDateStrip(view, () => renderToday());
        const onMode = () => openPicker('View', [
            { val: 'schedule', label: 'By bunk', hint: 'Each bunk’s full day' },
            { val: 'time', label: 'By time', hint: 'One card per period' },
            { val: 'grid', label: 'Grid', hint: 'Everything at once' },
            { val: 'now', label: 'Now', hint: 'What’s happening this minute' }
        ], schedMode, v => { schedMode = v; renderToday(); });
        view.querySelector('#liteWhoBtn')?.addEventListener('click', openWhoPicker);
        view.querySelector('#liteModeBtn')?.addEventListener('click', onMode);
        view.querySelector('#liteSearchBtn')?.addEventListener('click', () => {
            searchOpen = !searchOpen;
            if (!searchOpen && bunkQuery) bunkQuery = '';
            renderToday();
        });
        view.querySelector('#liteMoreBtn')?.addEventListener('click', openMoreSheet);
        const inp = view.querySelector('#liteBunkSearch');
        if (inp) {
            inp.addEventListener('input', () => { bunkQuery = inp.value; renderSchedBody(view); });
            inp.focus();
        }
        const schedBody = view.querySelector('#liteSchedBody');
        if (schedBody && !schedBody.dataset.gamesWired) {
            schedBody.dataset.gamesWired = '1';
            schedBody.addEventListener('click', (ev) => {
                const link = ev.target.closest('.lite-league-link');
                if (link) {
                    let data; try { data = JSON.parse(link.dataset.games || '{}'); } catch { return; }
                    openLeagueGamesSheet(data);
                    return;
                }
                const cell = ev.target.closest('.lite-grid-cell[data-p]');
                if (cell) { openGridCellSheet(Number(cell.dataset.p), Number(cell.dataset.b)); return; }
                const slot = ev.target.closest('.lite-slot[data-slot]');
                if (slot) {
                    const r = slotRefs[Number(slot.dataset.slot)];
                    if (r) openSlotSheet(r.bunk, r.entry);
                }
            });
        }

        await renderSchedBody(view);
    }

    const SCOPE_LABEL = { division: 'Divisions', grade: 'Grades', facility: 'Facilities' };
    const MODE_LABEL = { schedule: 'By bunk', time: 'By time', grid: 'Grid', now: 'Now' };
    const ICO = {
        caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg>',
        more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="20 6 9 17 4 12"/></svg>'
    };

    // Default the selection to the first available group for the scope.
    function ensureSchedSel() {
        if (schedScope === 'facility') return;
        const chips = scopeChips(schedScope);
        if (!chips.length) { schedSel = null; return; }
        if (!schedSel || !chips.includes(schedSel)) schedSel = chips[0];
    }
    function whoLabel() {
        if (schedScope === 'facility') return 'Facilities';
        return schedSel || SCOPE_LABEL[schedScope] || 'Divisions';
    }

    // One dropdown for WHO you're looking at. Divisions, grades and facilities
    // used to be a scope picker plus a horizontal chip row — two rows and two
    // interactions for one decision. Grouped sections do the same job in a
    // sheet, and pick the scope implicitly from whatever you tap.
    function openWhoPicker() {
        const divisions = parentDivisions();
        const grades = gradeKeys();
        const section = (label, items, scope) => items.length
            ? `<div class="lite-pick-group">${esc(label)}</div>` + items.map(v => `
                <button type="button" class="lite-pick${schedScope === scope && schedSel === v ? ' on' : ''}" data-scope="${scope}" data-val="${esc(v)}">
                    <span class="lite-pick-main">${esc(v)}</span>
                    ${schedScope === scope && schedSel === v ? ICO.check : ''}
                </button>`).join('')
            : '';
        openSheet(`
            <div class="lite-sheet-head">
                <div class="lite-sheet-title" style="margin:0;">Show</div>
                <button class="lite-sheet-close" id="litePickClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="lite-picklist lite-picklist-scroll">
                ${section('Divisions', divisions, 'division')}
                ${section('Grades', grades, 'grade')}
                <div class="lite-pick-group">Facilities</div>
                <button type="button" class="lite-pick${schedScope === 'facility' ? ' on' : ''}" data-scope="facility" data-val="">
                    <span class="lite-pick-main">All facilities<span class="lite-pick-hint">Who's using what, and when</span></span>
                    ${schedScope === 'facility' ? ICO.check : ''}
                </button>
            </div>`);
        document.getElementById('litePickClose').addEventListener('click', closeSheet);
        document.querySelectorAll('.lite-pick[data-scope]').forEach(b =>
            b.addEventListener('click', () => {
                closeSheet();
                schedScope = b.dataset.scope;
                schedSel = b.dataset.val || null;
                bunkQuery = ''; searchOpen = false;
                renderToday();
            }));
    }

    // Each picker is captioned, so it says what it controls as well as what's
    // currently chosen — a bare "Day Camp" pill doesn't explain itself.
    function ctrlHTML(id, caption, value) {
        return `<button type="button" class="lite-ctrl grow" id="${id}">
            <span class="lite-ctrl-txt">
                <span class="lite-ctrl-cap">${esc(caption)}</span>
                <span class="lite-ctrl-val">${esc(value)}</span>
            </span>${ICO.caret}</button>`;
    }
    function toolbarHTML(isFac) {
        return `<div class="lite-ctrlbar">
            ${ctrlHTML('liteWhoBtn', 'Show', whoLabel())}
            ${isFac ? '' : ctrlHTML('liteModeBtn', 'View', MODE_LABEL[schedMode] || 'By bunk')}
            <button type="button" class="lite-ctrl icon${searchOpen || bunkQuery.trim() ? ' on' : ''}" id="liteSearchBtn" aria-label="Search">${ICO.search}</button>
            <button type="button" class="lite-ctrl icon${rainyOn ? ' alert' : ''}" id="liteMoreBtn" aria-label="More">${ICO.more}</button>
        </div>`;
    }

    // One-choice list in a sheet — reads better on a phone than a cramped
    // segmented control, and has room to explain what each option does.
    function openPicker(title, options, current, onPick) {
        openSheet(`
            <div class="lite-sheet-head">
                <div class="lite-sheet-title" style="margin:0;">${esc(title)}</div>
                <button class="lite-sheet-close" id="litePickClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="lite-picklist">${options.map(o => `
                <button type="button" class="lite-pick${o.val === current ? ' on' : ''}" data-val="${esc(o.val)}">
                    <span class="lite-pick-main">${esc(o.label)}${o.hint ? `<span class="lite-pick-hint">${esc(o.hint)}</span>` : ''}</span>
                    ${o.val === current ? ICO.check : ''}
                </button>`).join('')}</div>`);
        document.getElementById('litePickClose').addEventListener('click', closeSheet);
        document.querySelectorAll('.lite-pick').forEach(b =>
            b.addEventListener('click', () => { closeSheet(); onPick(b.dataset.val); }));
    }

    function openMoreSheet() {
        const canRain = canEditSchedule();
        openSheet(`
            <div class="lite-sheet-head">
                <div class="lite-sheet-title" style="margin:0;">More</div>
                <button class="lite-sheet-close" id="liteMoreClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="lite-picklist">
                ${canRain ? `<button type="button" class="lite-pick${rainyOn ? ' on' : ''}" id="liteRainBtn">
                    <span class="lite-pick-main">Rainy day<span class="lite-pick-hint">${rainyOn ? 'On — review indoor moves' : 'Mark the day and move activities indoors'}</span></span>
                    ${rainyOn ? ICO.check : ''}
                </button>` : `<div class="lite-note" style="padding:6px 2px;">Nothing else here yet.</div>`}
            </div>`);
        document.getElementById('liteMoreClose').addEventListener('click', closeSheet);
        document.getElementById('liteRainBtn')?.addEventListener('click', openRainySheet);
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
        slotRefs = [];   // rebuilt as the cards render
        // Keep the overflow icon's rainy marker in step with the loaded day.
        rainyOn = isRainyDay(sched);
        document.getElementById('liteMoreBtn')?.classList.toggle('alert', rainyOn);

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
        if (!bunks.length) { body.innerHTML = emptyHTML('📭', 'No bunks here.'); return; }
        if (schedMode === 'time') { body.innerHTML = timelineHTML(sched, bunks); return; }
        if (schedMode === 'grid') { body.innerHTML = gridHTML(sched, bunks); return; }
        body.innerHTML = bunks.map(b => bunkCardHTML(b, sched)).join('');
    }

    // ─── Period-first + grid views ──────────────────────────────────────
    // Both read the same structure: the day's distinct start times, and what
    // each bunk is doing at each one. Bunks in a division can run slightly
    // different period lengths, so periods are keyed on START time (the shared
    // boundary) and the end shown is the longest any bunk runs.
    function buildPeriods(bunks, sched) {
        const map = new Map();
        bunks.forEach(b => {
            normalizeBunkEntries(b, sched).forEach(e => {
                if (e.startMin == null) return;
                let p = map.get(e.startMin);
                if (!p) { p = { startMin: e.startMin, endMin: e.endMin, byBunk: {} }; map.set(e.startMin, p); }
                if (e.endMin != null && (p.endMin == null || e.endMin > p.endMin)) p.endMin = e.endMin;
                p.byBunk[b] = e;
            });
        });
        return Array.from(map.values()).sort((a, b) => a.startMin - b.startMin);
    }

    function periodIsNow(p) {
        if (currentDate !== todayKey() || p.startMin == null) return false;
        const m = nowMinutes();
        return m >= p.startMin && (p.endMin == null || m < p.endMin);
    }

    function timeCellHTML(p) {
        return `<div class="lite-slot-time">
            <div class="t1">${esc(fmtMin(p.startMin))}</div>
            <div class="t2">${p.endMin != null ? esc(fmtMin(p.endMin)) : ''}</div>
        </div>`;
    }

    // View 1 — period-first. One section per time slot; bunks doing the same
    // thing collapse onto a single row, which is most of a division on a
    // league/lunch period.
    function timelineHTML(sched, bunks) {
        const periods = buildPeriods(bunks, sched);
        if (!periods.length) return emptyHTML('📭', 'No activities scheduled.');
        return periods.map(p => {
            const groups = new Map();
            Object.keys(p.byBunk).forEach(b => {
                const e = p.byBunk[b];
                const key = [e.kind, e.title, e.location || '', e.league || ''].join('|');
                let g = groups.get(key);
                if (!g) { g = { e, bunks: [] }; groups.set(key, g); }
                g.bunks.push(b);
            });
            const covered = Object.keys(p.byBunk).length;
            const rows = Array.from(groups.values()).map(g => {
                const e = g.e;
                const all = g.bunks.length === bunks.length && bunks.length > 1;
                const who = all
                    ? `<span class="lite-who all">All bunks</span>`
                    : g.bunks.map(b => `<span class="lite-who">${esc(b)}</span>`).join('');
                let body = `<div class="lite-slot-activity">${KIND_BADGE[e.kind] || ''}${esc(e.title)}</div>`;
                if (e.location) body += `<div class="lite-slot-loc">${esc(e.location)}</div>`;
                if (e.league) {
                    const payload = esc(JSON.stringify({ league: e.league, label: e.title, matchups: e.matchups || [], team: '' }));
                    body = `<span class="lite-league-badge">League · ${esc(e.league)}</span>`
                        + `<button type="button" class="lite-league-link" data-games="${payload}">View matchups &amp; games ›</button>`;
                }
                return `<div class="lite-tl-row kind-${e.kind}">
                    ${body}<div class="lite-who-row">${who}</div>
                </div>`;
            }).join('');
            return `<div class="lite-card lite-bunk-card${periodIsNow(p) ? ' now' : ''}">
                <div class="lite-bunk-head">
                    <span class="lite-bunk-name">${esc(fmtMin(p.startMin))}${p.endMin != null ? ` – ${esc(fmtMin(p.endMin))}` : ''}</span>
                    <span class="lite-bunk-div">${covered} bunk${covered === 1 ? '' : 's'}</span>
                </div>
                ${rows}
            </div>`;
        }).join('');
    }

    // View 2 — the whole division at once: periods down, bunks across. The time
    // column and bunk header stay pinned while the body scrolls both ways; tap a
    // cell for the full detail.
    let gridCache = { periods: [], bunks: [] };
    function gridHTML(sched, bunks) {
        const periods = buildPeriods(bunks, sched);
        if (!periods.length) return emptyHTML('📭', 'No activities scheduled.');
        gridCache = { periods, bunks };
        const head = bunks.map(b => `<th class="lite-grid-bunk">${esc(b)}</th>`).join('');
        const rows = periods.map((p, pi) => {
            const cells = bunks.map((b, bi) => {
                const e = p.byBunk[b];
                if (!e) return `<td class="lite-grid-cell empty"></td>`;
                const label = e.league ? e.league : e.title;
                const sub = e.league ? e.title : (e.location || '');
                return `<td class="lite-grid-cell kind-${e.kind}" data-p="${pi}" data-b="${bi}">
                    <span class="g1">${esc(label)}</span>${sub ? `<span class="g2">${esc(sub)}</span>` : ''}
                </td>`;
            }).join('');
            return `<tr class="${periodIsNow(p) ? 'now' : ''}">
                <th class="lite-grid-time">
                    <span class="t1">${esc(fmtMin(p.startMin))}</span>
                    ${p.endMin != null ? `<span class="t2">${esc(fmtMin(p.endMin))}</span>` : ''}
                </th>${cells}
            </tr>`;
        }).join('');
        return `<div class="lite-grid-wrap">
            <table class="lite-grid">
                <thead><tr><th class="lite-grid-corner">Time</th>${head}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="lite-note" style="margin:8px 2px 0;">Scroll sideways for more bunks · tap a cell for detail</div>`;
    }

    // ─── Rainy day (Lite) ───────────────────────────────────────────────
    // Lite can't run the solver, so it does the two things that matter without
    // one: flag the day (the office app reads the same isRainyDay/rainyDayMode
    // in the schedule payload) and walk the user through moving whatever is
    // stuck outdoors. A field is rainy-safe only if rainyDayAvailable === true,
    // matching rainy_day_manager.getRainyDayUnavailableFields.
    function isRainyDay(sched) { return !!(sched && (sched.isRainyDay || sched.rainyDayMode)); }
    function fieldIsIndoor(name) {
        if (!name) return false;
        const f = fieldList().find(x => sameName(x.name, name));
        return !!(f && f.rainyDayAvailable === true);
    }
    function indoorFields() { return fieldList().filter(f => f.rainyDayAvailable === true); }

    // Everything currently sitting on a field that isn't rainy-safe.
    function outdoorEntries(sched, bunks) {
        const out = [];
        bunks.forEach(bunk => {
            normalizeBunkEntries(bunk, sched).forEach(e => {
                if (e.kind === 'league' || !e.location) return;
                // A location we don't know at all isn't evidence of outdoors.
                if (!fieldList().some(f => sameName(f.name, e.location))) return;
                if (!fieldIsIndoor(e.location)) out.push({ bunk, entry: e });
            });
        });
        return out.sort((a, b) => (a.entry.startMin ?? 0) - (b.entry.startMin ?? 0));
    }

    // First indoor field that hosts this activity and is free then; otherwise
    // any free indoor field. null when everything indoors is taken.
    function suggestIndoor(sched, item, taken) {
        const busyKey = loc => `${normKey(loc)}|${item.entry.startMin}`;
        const free = f => {
            if (taken.has(busyKey(f.name))) return false;
            return locationBusyAt(sched, f.name, item.entry.startMin, item.entry.endMin, item.bunk).length === 0;
        };
        const hosts = indoorFields().filter(f => (f.activities || []).some(a => sameName(a, item.entry.title)));
        return hosts.find(free) || indoorFields().find(free) || null;
    }

    let rainyPlan = [];
    async function openRainySheet() {
        const sched = await getSchedule(currentDate);
        const on = isRainyDay(sched);
        const bunks = bunksForScope(schedScope, schedSel);
        const stuck = on ? outdoorEntries(sched, bunks) : [];
        const taken = new Set();
        rainyPlan = stuck.map(item => {
            const pick = suggestIndoor(sched, item, taken);
            if (pick) taken.add(`${normKey(pick.name)}|${item.entry.startMin}`);
            return { ...item, to: pick ? pick.name : '' };
        });
        renderRainySheet(sched, on);
    }

    function renderRainySheet(sched, on) {
        const indoor = indoorFields();
        const rows = rainyPlan.map((r, i) => {
            const opts = [`<option value="">Leave as is</option>`].concat(indoor.map(f =>
                `<option value="${esc(f.name)}"${sameName(f.name, r.to) ? ' selected' : ''}>${esc(f.name)}</option>`)).join('');
            return `<div class="lite-rain-row">
                <div class="lite-rain-what"><b>${esc(r.bunk)}</b> · ${esc(r.entry.title)}</div>
                <div class="lite-rain-meta">${esc(fmtMin(r.entry.startMin))} · now at ${esc(r.entry.location)}</div>
                <select class="lite-input" data-rain="${i}">${opts}</select>
            </div>`;
        }).join('');
        const canMove = rainyPlan.some(r => r.to);
        openSheet(`
            <div class="lite-sheet-head">
                <div class="lite-sheet-title" style="margin:0;">Rainy day</div>
                <button class="lite-sheet-close" id="liteRainClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <button class="lite-btn ${on ? 'secondary' : ''} block" id="liteRainToggle" style="margin-top:4px;">
                ${on ? 'Turn rainy day off' : 'Turn rainy day on for this day'}
            </button>
            <div class="lite-note" style="margin-top:8px;">${on
                ? 'The office app sees this day as rainy.'
                : 'Marks the day rainy everywhere, then helps you move activities indoors.'}</div>
            ${!on ? '' : (!indoor.length
                ? `<div class="lite-conflict" style="margin-top:12px;">No fields are marked available on rainy days, so there's nowhere to move to. Set that up in the office app under facilities.</div>`
                : !rainyPlan.length
                    ? `<div class="lite-note" style="margin-top:12px;">Nothing is scheduled outdoors right now.</div>`
                    : `<div class="lite-sheet-title" style="margin:16px 0 2px;">Move indoors (${rainyPlan.length})</div>
                       <div class="lite-note" style="margin-bottom:8px;">Suggested indoor spots that are free at that time.</div>
                       ${rows}
                       <button class="lite-btn block" id="liteRainApply" style="margin-top:12px;" ${canMove ? '' : 'disabled'}>Move them indoors</button>`)}`);
        const q = id => document.getElementById(id);
        q('liteRainClose').addEventListener('click', closeSheet);
        q('liteRainToggle').addEventListener('click', () => toggleRainy(!on));
        document.querySelectorAll('[data-rain]').forEach(sel =>
            sel.addEventListener('change', e => { rainyPlan[Number(sel.dataset.rain)].to = e.target.value; renderRainySheet(sched, on); }));
        const ap = q('liteRainApply');
        if (ap) ap.addEventListener('click', applyRainyPlan);
    }

    async function toggleRainy(on) {
        const sched = await getSchedule(currentDate);
        if (!sched) { toast('No schedule for this day yet'); return; }
        sched.isRainyDay = on;
        sched.rainyDayMode = on;          // the office app reads both
        const btn = document.getElementById('liteRainToggle');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        const res = await saveLiteSchedule(sched);
        if (!res.ok) { delete scheduleCache[currentDate]; closeSheet(); toast(res.error || 'Could not save'); return; }
        toast(on ? 'Rainy day on' : 'Rainy day off');
        const view = document.getElementById('view-today');
        if (view) await renderToday();
        if (on) openRainySheet(); else closeSheet();
    }

    async function applyRainyPlan() {
        const moves = rainyPlan.filter(r => r.to);
        if (!moves.length) return;
        const btn = document.getElementById('liteRainApply');
        if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }
        const sched = await getSchedule(currentDate);
        moves.forEach(r => {
            const assigns = sched.scheduleAssignments || (sched.scheduleAssignments = {});
            const key = matchKey(assigns, r.bunk) || r.bunk;
            let arr = assigns[key];
            if (!Array.isArray(arr)) arr = assigns[key] = [];
            let ti = arr.findIndex(e => e && !e.continuation && numOrNull(e._startMin) === r.entry.startMin);
            if (ti < 0) ti = (r.entry.idx != null ? r.entry.idx : arr.length);
            while (arr.length <= ti) arr.push(null);
            arr[ti] = buildEditEntry(r.entry.title, r.to, r.entry.startMin, r.entry.endMin, false);
        });
        const res = await saveLiteSchedule(sched);
        closeSheet();
        if (!res.ok) { delete scheduleCache[currentDate]; toast(res.error || 'Could not save'); }
        else toast(`Moved ${moves.length} activit${moves.length === 1 ? 'y' : 'ies'} indoors`);
        const view = document.getElementById('view-today');
        if (view) await renderSchedBody(view);
    }

    // ─── Post-edit (change an activity on the fly) ──────────────────────
    function canEditSchedule() { return isHeadStaff(); }

    function fieldList() {
        const arr = Array.isArray(camp.fields) ? camp.fields : Object.values(camp.fields || {});
        return arr.filter(f => f && f.name);
    }
    // Everything that can be scheduled: sports offered by fields + specials.
    function activityOptions() {
        const set = new Set();
        fieldList().forEach(f => (f.activities || []).forEach(a => { if (a) set.add(String(a)); }));
        const sp = Array.isArray(camp.specialActivities) ? camp.specialActivities : Object.values(camp.specialActivities || {});
        sp.forEach(s => { if (s && s.name) set.add(String(s.name)); });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    // Fields that host an activity (all of them when the activity is unknown).
    function locationOptions(activity) {
        const all = fieldList();
        if (!activity) return all;
        const hosts = all.filter(f => (f.activities || []).some(a => sameName(a, activity)));
        return hosts.length ? hosts : all;
    }

    // Who else is already using this location at this time.
    function locationBusyAt(sched, location, startMin, endMin, exceptBunk) {
        if (!location || startMin == null) return [];
        const hits = [];
        allBunkRows(sched).forEach(({ bunk }) => {
            if (sameName(bunk, exceptBunk)) return;
            normalizeBunkEntries(bunk, sched).forEach(e => {
                if (!e.location || e.startMin == null) return;
                if (!sameName(e.location, location)) return;
                const aEnd = endMin ?? (startMin + 1), bEnd = e.endMin ?? (e.startMin + 1);
                if (startMin < bEnd && e.startMin < aEnd) hits.push(bunk);
            });
        });
        return Array.from(new Set(hits));
    }

    // Write one slot back to the cloud, in the shape the desktop post-edit uses
    // so the office app reads it as an ordinary manual edit.
    function buildEditEntry(activity, location, startMin, endMin, isClear) {
        if (isClear) {
            return { field: 'Free', sport: null, _activity: 'Free', continuation: false,
                     _postEdit: true, _liteEdit: true, _editedAt: Date.now(),
                     _startMin: startMin, _endMin: endMin };
        }
        return {
            field: location ? `${location} – ${activity}` : activity,
            sport: activity, _activity: activity, _location: location || null,
            continuation: false, _fixed: true,
            _postEdit: true, _liteEdit: true, _editedAt: Date.now(),
            _startMin: startMin, _endMin: endMin
        };
    }

    async function applyLiteEdit(bunk, entry, activity, location, isClear) {
        const sched = await getSchedule(currentDate);
        if (!sched) return { ok: false, error: 'No schedule loaded.' };
        if (!sched.scheduleAssignments) sched.scheduleAssignments = {};
        const assigns = sched.scheduleAssignments;
        const key = matchKey(assigns, bunk) || bunk;
        let arr = assigns[key];
        if (!Array.isArray(arr)) arr = assigns[key] = [];

        // Target the slot holding this activity; fall back to its grid index.
        let ti = arr.findIndex(e => e && !e.continuation && numOrNull(e._startMin) === entry.startMin);
        if (ti < 0) ti = (entry.idx != null ? entry.idx : arr.length);
        while (arr.length <= ti) arr.push(null);
        arr[ti] = buildEditEntry(activity, location, entry.startMin, entry.endMin, isClear);
        // Drop continuation slots that belonged to the replaced activity.
        for (let j = ti + 1; j < arr.length; j++) {
            if (arr[j] && arr[j].continuation) arr[j] = null; else break;
        }

        const res = await saveLiteSchedule(sched);
        if (!res.ok) {
            // Re-read from cloud so the UI never shows an edit that didn't land.
            delete scheduleCache[currentDate];
        }
        return res;
    }

    // A slot with no start/end comes back from deserialize as new Date(undefined)
    // — an Invalid Date. ScheduleDB.saveSchedule re-serializes on the way out and
    // calls .toISOString() on it, which throws and loses the whole edit. Strip
    // those before saving so serialize falls back to the plain startMin/endMin.
    function stripInvalidDates(sched) {
        const bad = d => d instanceof Date && isNaN(d.getTime());
        const fix = s => { if (s && typeof s === 'object') { if (bad(s.start)) delete s.start; if (bad(s.end)) delete s.end; } };
        Object.values(sched.divisionTimes || {}).forEach(slots => {
            if (Array.isArray(slots)) slots.forEach(fix);
            const pb = slots && slots._perBunkSlots;
            if (pb) Object.values(pb).forEach(a => { if (Array.isArray(a)) a.forEach(fix); });
        });
        if (Array.isArray(sched.unifiedTimes)) sched.unifiedTimes.forEach(fix);
    }

    // Shared cloud write for post-edits and rainy-day changes.
    async function saveLiteSchedule(sched) {
        if (!window.ScheduleDB?.saveSchedule) return { ok: false, error: 'Saving is unavailable here.' };
        try { stripInvalidDates(sched); } catch (_) { /* non-fatal */ }
        try {
            const res = await window.ScheduleDB.saveSchedule(currentDate, sched);
            if (res && (res.success === false || res.error)) {
                return { ok: false, error: (res.error && res.error.message) || 'Save was rejected.' };
            }
            scheduleCache[currentDate] = sched;
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : 'Save failed.' };
        }
    }

    // The edit sheet: pick an activity, then a location, with live conflicts.
    let editDraft = null;
    async function openEditSheet(bunk, entry) {
        const sched = await getSchedule(currentDate);
        editDraft = {
            bunk, entry,
            activity: entry.kind === 'league' ? '' : (entry.title || ''),
            location: entry.location || ''
        };
        renderEditSheet(sched);
    }

    function renderEditSheet(sched) {
        const d = editDraft; if (!d) return;
        const acts = activityOptions();
        const locs = locationOptions(d.activity);
        const busy = locationBusyAt(sched, d.location, d.entry.startMin, d.entry.endMin, d.bunk);
        const when = `${fmtMin(d.entry.startMin)}${d.entry.endMin != null ? ' – ' + fmtMin(d.entry.endMin) : ''}`;
        const actOpts = [`<option value="">Choose an activity…</option>`]
            .concat(acts.map(a => `<option value="${esc(a)}"${sameName(a, d.activity) ? ' selected' : ''}>${esc(a)}</option>`))
            .join('');
        const locOpts = [`<option value="">No specific location</option>`]
            .concat(locs.map(f => {
                const inUse = locationBusyAt(sched, f.name, d.entry.startMin, d.entry.endMin, d.bunk);
                const tag = inUse.length ? ` — in use by ${inUse.join(', ')}` : '';
                return `<option value="${esc(f.name)}"${sameName(f.name, d.location) ? ' selected' : ''}>${esc(f.name)}${esc(tag)}</option>`;
            })).join('');
        openSheet(`
            <div class="lite-sheet-head">
                <div>
                    <div class="lite-sheet-title" style="margin:0;">Edit ${esc(d.bunk)}</div>
                    <div class="lite-slot-loc">${esc(when)}</div>
                </div>
                <button class="lite-sheet-close" id="liteEditClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="lite-field"><label>Activity</label>
                <select class="lite-input" id="liteEditAct">${actOpts}</select></div>
            <div class="lite-field"><label>Location</label>
                <select class="lite-input" id="liteEditLoc">${locOpts}</select></div>
            ${busy.length ? `<div class="lite-conflict">Double-booked: ${esc(busy.join(', '))} ${busy.length === 1 ? 'is' : 'are'} already at ${esc(d.location)} then.</div>` : ''}
            <button class="lite-btn block" id="liteEditSave" style="margin-top:12px;">Save change</button>
            <button class="lite-btn secondary block" id="liteEditClear" style="margin-top:8px;">Clear this slot</button>
            <div class="lite-note" style="margin-top:10px;">Saves to the same schedule the office app uses.</div>`);
        const q = id => document.getElementById(id);
        q('liteEditClose').addEventListener('click', closeSheet);
        q('liteEditAct').addEventListener('change', e => {
            d.activity = e.target.value;
            const still = locationOptions(d.activity).some(f => sameName(f.name, d.location));
            if (!still) d.location = '';
            renderEditSheet(sched);
        });
        q('liteEditLoc').addEventListener('change', e => { d.location = e.target.value; renderEditSheet(sched); });
        q('liteEditSave').addEventListener('click', () => commitEdit(false));
        q('liteEditClear').addEventListener('click', () => commitEdit(true));
    }

    async function commitEdit(isClear) {
        const d = editDraft; if (!d) return;
        if (!isClear && !d.activity) { toast('Choose an activity first'); return; }
        const btn = document.getElementById(isClear ? 'liteEditClear' : 'liteEditSave');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        const res = await applyLiteEdit(d.bunk, d.entry, d.activity, d.location, isClear);
        closeSheet();
        toast(res.ok ? (isClear ? 'Slot cleared' : 'Schedule updated') : (res.error || 'Could not save'));
        editDraft = null;
        const view = document.getElementById('view-today');
        if (view) await renderSchedBody(view);
    }

    function openGridCellSheet(pi, bi) {
        const p = gridCache.periods[pi], bunk = gridCache.bunks[bi];
        const e = p && bunk ? p.byBunk[bunk] : null;
        if (e) openSlotSheet(bunk, e);
    }

    // Detail for one bunk's slot, with the edit entry point for staff who can.
    function openSlotSheet(bunk, e) {
        if (!e) return;
        const when = `${fmtMin(e.startMin)}${e.endMin != null ? ' – ' + fmtMin(e.endMin) : ''}`;
        let body = '';
        if (e.league) {
            body += `<span class="lite-league-badge">League · ${esc(e.league)}</span>`;
            body += `<div class="lite-sheet-title" style="margin:2px 0 8px;">${esc(e.title)}</div>`;
            const rows = (e.matchups || []).map(m => {
                const g = (m && typeof m === 'object' && 'teams' in m) ? m : parseMatchup(m);
                const meta = [g.field, g.sport].filter(Boolean).map(esc).join(' · ');
                return `<div class="lite-game-row"><div class="lite-game-teams">${esc(g.teams)}</div>${meta ? `<div class="lite-game-meta">${meta}</div>` : ''}</div>`;
            }).join('');
            body += `<div class="lite-games-list">${rows || '<div class="lite-empty" style="padding:14px;">No matchups listed yet.</div>'}</div>`;
        } else {
            body += `<div class="lite-sheet-title" style="margin:2px 0 4px;">${KIND_BADGE[e.kind] || ''}${esc(e.title)}</div>`;
            if (e.location) body += `<div class="lite-slot-loc" style="margin-bottom:6px;">${esc(e.location)}</div>`;
        }
        openSheet(`
            <div class="lite-sheet-head">
                <div>
                    <div class="lite-sheet-title" style="margin:0;">${esc(bunk)}</div>
                    <div class="lite-slot-loc">${esc(when)}</div>
                </div>
                <button class="lite-sheet-close" id="liteCellClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div style="margin-top:10px;">${body}</div>
            ${canEditSchedule() && !e.league
                ? `<button class="lite-btn block" id="liteCellEdit" style="margin-top:14px;">Change this activity</button>`
                : ''}`);
        const c = document.getElementById('liteCellClose');
        if (c) c.addEventListener('click', closeSheet);
        const ed = document.getElementById('liteCellEdit');
        if (ed) ed.addEventListener('click', () => openEditSheet(bunk, e));
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
                        ? `<div class="lite-slot-activity">${esc(r.entry.title)}</div>${r.entry.location && r.entry.location !== r.entry.title ? `<div class="lite-slot-loc">${esc(r.entry.location)}</div>` : ''}`
                        : `<div class="lite-slot-activity" style="color:var(--muted);">${r.upcoming ? `Free · next ${esc(r.upcoming.title)} ${esc(fmtMin(r.upcoming.startMin))}` : 'Nothing scheduled'}</div>`}</div>
                </div>`).join('')}
            </div>`).join('');
    }

    // Slot rows in the bunk view carry a reference so a tap can reopen the same
    // detail/edit sheet the grid uses. Leagues keep their matchups link instead.
    let slotRefs = [];
    function slotRef(bunk, e) {
        if (e.league) return '';
        const i = slotRefs.push({ bunk, entry: e }) - 1;
        return ` data-slot="${i}"`;
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
                const badge = KIND_BADGE[e.kind] || '';
                let bodyHtml = `<div class="lite-slot-activity">${badge}${esc(e.title)}</div>`;
                if (e.location) {
                    bodyHtml += `<div class="lite-slot-loc">${esc(e.location)}</div>`;
                }
                if (e.league) {
                    const team = bunkTeamForLeague(bunk, e.league);
                    const payload = esc(JSON.stringify({
                        league: e.league, label: e.title,
                        matchups: e.matchups || [], team: team || ''
                    }));
                    bodyHtml = `<span class="lite-league-badge">League · ${esc(e.league)}</span>`
                        + `<button type="button" class="lite-league-link" data-games="${payload}">View matchups &amp; games ›</button>`;
                }
                const ref = slotRef(bunk, e);
                return `<div class="lite-slot${isNow ? ' now' : ''} kind-${e.kind}${ref ? ' tappable' : ''}"${ref}>
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

    // True iff `name` exactly matches a configured league (regular or specialty).
    // Mirrors window.isConfiguredLeagueName — lets us tell a REAL league slot from
    // a custom pin whose title merely contains the word "league".
    function isConfiguredLeagueNameLite(name) {
        if (!name) return false;
        const n = String(name).toLowerCase().trim();
        if (Object.keys(camp.leagues || {}).some(k => String(k).toLowerCase().trim() === n)) return true;
        const sp = camp.specialty || {};
        const arr = Array.isArray(sp) ? sp : Object.values(sp || {});
        return arr.some(l => l && l.name && String(l.name).toLowerCase().trim() === n);
    }
    // A real league slot is one whose DIVISION block is typed 'league'
    // (or 'specialty_league'), or whose event name is a configured league.
    // NOT a per-bunk entry whose title happens to contain "league".
    function slotIsLeagueBlock(slot) {
        if (!slot) return false;
        const t = String(slot.type || '').toLowerCase();
        if (t === 'league' || t === 'specialty_league') return true;
        return isConfiguredLeagueNameLite(slot.event);
    }
    // Normalize a matchup (string "A vs B @ Field (Sport)" or an object) into
    // { teams, field, sport } for the games sheet.
    function normalizeMatchup(m, defSport) {
        if (typeof m === 'string') return parseMatchup(m);
        if (m && typeof m === 'object') {
            const teams = (m.teamA && m.teamB) ? `${m.teamA} vs ${m.teamB}`
                        : (m.team1 && m.team2) ? `${m.team1} vs ${m.team2}`
                        : (m.display || m.matchup || '');
            return { teams: teams || '', field: m.field || '', sport: m.sport || defSport || '' };
        }
        return { teams: String(m ?? ''), field: '', sport: '' };
    }
    // Matchup data for a league slot lives in leagueAssignments[div][slotIdx]
    // (division-keyed, with a fuzzy ±2 slot lookup) — NOT in the per-bunk entry.
    function getLeagueMatchupsLite(sched, divKey, slotIdx) {
        const div = (sched.leagueAssignments || {})[divKey];
        if (!div) return null;
        let data = div[slotIdx];
        if (!data) {
            const keys = Object.keys(div).map(Number).filter(k => !isNaN(k)).sort((a, b) => a - b);
            for (const k of keys) {
                if (Math.abs(k - slotIdx) <= 2 && div[k] && ((div[k].matchups && div[k].matchups.length) || div[k].gameLabel)) {
                    data = div[k]; break;
                }
            }
        }
        if (!data) return null;
        const sport = data.sport || '';
        return {
            gameLabel: data.gameLabel || '', leagueName: data.leagueName || '', sport,
            matchups: (data.matchups || []).map(m => normalizeMatchup(m, sport))
        };
    }

    // A tile the USER pinned via a custom layer. Deliberately narrow: _pinned,
    // _fixed and _classification:'pinned' are solver bookkeeping (pair locks,
    // regen preservation, post-edits, specials snapped to a fixed time) and land
    // on ordinary generated activities too — keying off them badged plain
    // Football/Hockey as "Pinned". The solver only fills _customActivity /
    // _customField when the source layer's type is 'custom', so that — and an
    // explicitly custom-typed entry — is the honest signal.
    // Names configured as special activities (app1.specialActivities), lowercased.
    let _specialNames = null;
    function specialNames() {
        if (_specialNames) return _specialNames;
        _specialNames = new Set();
        const arr = Array.isArray(camp.specialActivities) ? camp.specialActivities : Object.values(camp.specialActivities || {});
        arr.forEach(s => { const n = s && s.name; if (n) _specialNames.add(normKey(n)); });
        return _specialNames;
    }
    // A special activity placed by the solver. The engine writes these as
    // { field: <location>, sport: null, _activity: <name>, _assignedSpecial: <name>,
    //   _specialLocation: <location>, _fixed: true } — so they look a lot like a
    // pinned tile (no sport, _fixed) and, when a camp names a special's location
    // after the special itself, field === the activity name too. These markers,
    // plus the configured specials list, are what actually tell them apart.
    function isSpecialEntry(e) {
        if (e._assignedSpecial || e._specialLocation) return true;
        const set = specialNames();
        if (!set.size) return false;
        return [e._activity, e._assignedSport, e.event].some(c => c && set.has(normKey(c)));
    }

    // Standard skeleton tiles (lunch, swim, dismissal…) are pinned too, but they
    // aren't the *custom* tiles the user wants surfaced.
    const STANDARD_TILE_RE = /^(lunch|snacks?|dismissal|regroup|rest|swim|davening|breakfast|supper|dinner|line ?up|change|wake ?up|shower)\b/i;
    function isCustomPin(e) {
        // A post-edit (desktop or Lite) also carries _location and _fixed, but
        // it's a hand-placed activity, not a pinned tile.
        if (e._postEdit) return false;
        // Auto builder: only a 'custom'-type layer fills these.
        if (e._customActivity || e._customField) return true;
        // Manual builder: a pinned tile that reserves facilities.
        if (Array.isArray(e._reservedFields) && e._reservedFields.length) return true;
        if (e._location) return true;
        if (String(e.type || e._layerType || '').toLowerCase() === 'custom') return true;
        // Manual builder, no facilities: the tile fills field = _activity = the
        // event name with no sport. A generated activity carries a sport; a
        // special carries its own markers and is ruled out before we get here.
        if ((e._pinned === true || e._fixed === true) && !e.sport) {
            const act = String(e._activity || e.event || '').trim();
            if (act && sameName(fieldLabel(e.field), act) && !STANDARD_TILE_RE.test(act)) return true;
        }
        return false;
    }

    // Where an entry happens. A pinned tile names itself in `field`, so its real
    // facilities come from _reservedFields / _location (a tile can reserve
    // several, e.g. "Field 1, Field 2"). Returns '' when there's nothing to add
    // beyond the title.
    function entryLocation(e, title) {
        const rf = Array.isArray(e._reservedFields) ? e._reservedFields.filter(Boolean) : [];
        if (rf.length) return rf.map(f => fieldLabel(f)).filter(Boolean).join(', ');
        if (e._location) return fieldLabel(e._location);
        if (e.swimLocation || e._swimLocation) return fieldLabel(e.swimLocation || e._swimLocation);
        if (e._customField) return fieldLabel(e._customField);
        const f = fieldLabel(e.field);
        return (f && !sameName(f, title)) ? f : '';
    }

    // Classify a non-league entry. (League slots are detected upstream via
    // slotIsLeagueBlock / _league / _h2h.)
    function entryKind(e) {
        if (e._isTrip || String(e.type || '').toLowerCase() === 'trip') return 'trip';
        if (e._reserved || e.isReserved || e.reservedLocation || e._classification === 'reserved') return 'reserved';
        // Explicit custom-pin markers win — a user who pins a tile for a special
        // still meant to pin it. Otherwise a special is never a pinned tile, so
        // rule it out before the name/shape heuristic below can misread it.
        // A post-edit also carries _location, but it's a hand-placed activity.
        if (!e._postEdit && (e._customActivity || e._customField
            || (Array.isArray(e._reservedFields) && e._reservedFields.length) || e._location)) return 'pinned';
        if (isSpecialEntry(e)) return 'regular';
        if (isCustomPin(e)) return 'pinned';
        return 'regular';
    }
    // Mirror window.getActivityDisplayName (+ custom-pin fields), which Lite can't
    // call directly (scheduler_core_utils isn't loaded here).
    function entryDisplayName(e) {
        if (e._displayName) return e._displayName;
        if (e._partLabel) return e._partLabel;
        if (e._partNumber && e._totalParts && e._activity) return e._activity + ' ' + e._partNumber + '/' + e._totalParts;
        return e._customActivity || e._assignedSport || e.sport || e._activity || e.event || fieldLabel(e.field) || 'Activity';
    }

    // Re-index a bunk's entries onto the division slot grid by matching each
    // entry's own _startMin to a slot's startMin. Mirrors the desktop grid's
    // realignment: the two arrays are supposed to be index-aligned, but a slot
    // with no per-bunk cell (e.g. a division-wide league period) shifts every
    // later entry, so entry i ends up read against the wrong period. Returns the
    // input untouched when the indices already agree.
    function realignToSlots(raw, divSlots) {
        if (!Array.isArray(raw)) return raw;
        if (!Array.isArray(divSlots) || !divSlots.length) return raw;
        let drift = false;
        for (let i = 0; i < Math.min(raw.length, divSlots.length); i++) {
            const a = raw[i], s = divSlots[i];
            if (a && s && numOrNull(a._startMin) != null && numOrNull(s.startMin) != null
                && a._startMin !== s.startMin) { drift = true; break; }
        }
        if (!drift) return raw;
        const out = new Array(Math.max(divSlots.length, raw.length)).fill(null);
        const leftover = [];
        raw.forEach((e, i) => {
            if (!e) return;
            const t = numOrNull(e._startMin);
            let placed = false;
            if (t != null) {
                for (let j = 0; j < divSlots.length; j++) {
                    if (divSlots[j] && divSlots[j].startMin === t && !out[j]) { out[j] = e; placed = true; break; }
                }
            }
            if (!placed) leftover.push([i, e]);
        });
        // Anything without a matching slot keeps its original index when free.
        leftover.forEach(([i, e]) => { if (i < out.length && !out[i]) out[i] = e; });
        return out;
    }

    // Times for a slot when neither the entry nor this division's slot grid
    // supplies them (a league-only division whose grid wasn't saved, or a game
    // parked past the end of the grid). Every source here is time-exact — we
    // never borrow another division's period grid, since a wrong time is worse
    // than no time. Returns nulls when nothing trustworthy is found.
    function fallbackTimes(sched, divKey, bunk, idx, leagueName, gameLabel) {
        const assigns = sched.scheduleAssignments || {};
        const pick = pe => ({ startMin: numOrNull(pe._startMin), endMin: numOrNull(pe._endMin) });

        // 1) A sibling bunk in the SAME division sitting at the same slot index.
        const sibs = (camp.divisions?.[divKey]?.bunks) || (divKey ? bunksForParent(divKey) : []);
        for (const s of sibs) {
            if (sameName(s, bunk)) continue;
            const arr = assigns[matchKey(assigns, s)];
            const pe = Array.isArray(arr) ? arr[idx] : null;
            if (pe && numOrNull(pe._startMin) != null) return pick(pe);
        }
        // 2) Any bunk anywhere playing this exact league game (leagues span
        //    divisions, so a peer division usually carries the real times).
        const ln = normKey(leagueName), gl = normKey(gameLabel);
        if (ln || gl) {
            for (const k of Object.keys(assigns)) {
                const arr = assigns[k];
                if (!Array.isArray(arr)) continue;
                for (const pe of arr) {
                    if (!pe || numOrNull(pe._startMin) == null) continue;
                    const peL = normKey(pe._leagueName), peG = normKey(pe._gameLabel);
                    if ((ln && peL && peL === ln) || (gl && peG && peG === gl)) return pick(pe);
                }
            }
        }
        // 3) The camp-wide unified period grid.
        const ut = Array.isArray(sched.unifiedTimes) ? sched.unifiedTimes[idx] : null;
        if (ut && numOrNull(ut.startMin) != null) {
            return { startMin: numOrNull(ut.startMin), endMin: numOrNull(ut.endMin) };
        }
        return { startMin: null, endMin: null };
    }

    // Turn a bunk's day into clean, sorted display rows. Iterates DIVISION slots
    // (not just per-bunk entries) so real league games — whose matchups live in
    // leagueAssignments and whose per-bunk cell may be empty — always render.
    function normalizeBunkEntries(bunk, sched) {
        const assignMap = sched.scheduleAssignments || {};
        const raw = assignMap[matchKey(assignMap, bunk)];
        const dtMap = sched.divisionTimes || {};
        const divKey = divKeyIn(dtMap, bunk);
        // League matchups may sit under a differently-spelled division key.
        const leagueKey = divKeyIn(sched.leagueAssignments || {}, bunk) || divKey;
        const leagueDiv = (sched.leagueAssignments || {})[leagueKey] || {};
        const allDivSlots = (divKey != null ? dtMap[divKey] : null) || [];
        // divisionTimes can hold a per-bunk slot grid; prefer it when present.
        const perBunk = allDivSlots && allDivSlots._perBunkSlots;
        const perBunkSlots = perBunk ? perBunk[matchKey(perBunk, bunk)] : null;
        const divSlots = Array.isArray(perBunkSlots) ? perBunkSlots : allDivSlots;
        const slotLen = Array.isArray(divSlots) ? divSlots.length : 0;
        // Entry i and slot i drift apart whenever a slot has no per-bunk cell (a
        // league period, say). Re-index entries onto the slot whose start time
        // they actually match — same realignment the desktop grid does — so an
        // activity isn't read against the wrong period.
        const aligned = realignToSlots(raw, divSlots);
        const hasRaw = Array.isArray(aligned);
        // Cover league games parked at a slot index beyond the grids we have.
        const leagueMax = Object.keys(leagueDiv)
            .map(Number).filter(k => !isNaN(k)).reduce((a, b) => Math.max(a, b), -1) + 1;
        const n = Math.max(hasRaw ? aligned.length : 0, slotLen, leagueMax);
        if (!n) return [];

        const out = [];
        const seenLeague = new Set();
        for (let idx = 0; idx < n; idx++) {
            const e = hasRaw ? aligned[idx] : null;
            const slot = Array.isArray(divSlots) ? divSlots[idx] : null;
            // A real league game: entry carries _league/_h2h/matchups (auto + manual),
            // the division slot is a league block, or leagueAssignments has a game
            // stored at this slot (authoritative — survives odd slot typing).
            const entryIsLeague = !!(e && (e._league || e._h2h
                || (Array.isArray(e._allMatchups) && e._allMatchups.length > 0)
                || (Array.isArray(e.matchups) && e.matchups.length > 0)));
            const la = leagueDiv[idx];
            const laIsLeague = !!(la && ((la.matchups && la.matchups.length) || la.gameLabel || la.leagueName));
            const isLeague = entryIsLeague || laIsLeague || slotIsLeagueBlock(slot);

            if (isLeague) {
                if (e && e.continuation) continue;
                // NOTE: numOrNull(null) === 0, so guard on `e` before reading — a
                // league slot with no per-bunk cell must fall back to slot times,
                // not silently become 0 (which rendered as "12:00 AM").
                let startMin = e ? numOrNull(e._startMin) : null;
                let endMin = e ? numOrNull(e._endMin) : null;
                if (startMin == null && slot) { startMin = numOrNull(slot.startMin); endMin = numOrNull(slot.endMin); }
                const li = getLeagueMatchupsLite(sched, leagueKey, idx);
                const defSport = (li && li.sport) || (e && e.sport) || '';
                const entryMatchups = (e && Array.isArray(e._allMatchups) && e._allMatchups.length) ? e._allMatchups
                    : (e && Array.isArray(e.matchups) && e.matchups.length) ? e.matchups : [];
                const matchups = (li && li.matchups.length) ? li.matchups
                    : entryMatchups.map(m => normalizeMatchup(m, defSport));
                const leagueName = (li && li.leagueName) || (e && e._leagueName)
                    || (slot && slot.event) || String((e && e.field) || '').replace(/^League:\s*/i, '') || 'League';
                const title = (li && li.gameLabel) || (e && e._gameLabel) || (e && e.sport) || 'League Game';
                // A league-only division may have no slot grid saved at all — recover
                // the time from a sibling bunk, a peer division playing the same game,
                // or the camp-wide period grid, so the row isn't stuck showing "—".
                if (startMin == null) {
                    const ft = fallbackTimes(sched, divKey, bunk, idx, leagueName, title);
                    startMin = ft.startMin; endMin = ft.endMin;
                }
                // Guard against emitting the same game twice across merged/continuation slots.
                const key = leagueName + '|' + title + '|' + (startMin ?? '');
                if (seenLeague.has(key)) continue;
                seenLeague.add(key);
                out.push({ title, kind: 'league', location: null, startMin, endMin, league: leagueName, matchups, idx });
                continue;
            }

            if (!e || e.continuation) continue;
            // A cleared slot is empty, not an activity called "Free".
            if (['free', 'free play'].includes(normKey(e._activity || e.field || e.event))) continue;
            let startMin = numOrNull(e._startMin);
            let endMin = numOrNull(e._endMin);
            if (startMin == null && slot) { startMin = numOrNull(slot.startMin); endMin = numOrNull(slot.endMin); }
            if (startMin == null) {
                const ft = fallbackTimes(sched, divKey, bunk, idx, '', '');
                startMin = ft.startMin; endMin = ft.endMin;
            }
            // Extend end time across continuation slots that carry their own times
            if (hasRaw) for (let j = idx + 1; j < aligned.length; j++) {
                const c = aligned[j];
                if (!c || !c.continuation) break;
                const ce = numOrNull(c._endMin);
                if (ce != null && (endMin == null || ce > endMin)) endMin = ce;
            }
            const kind = entryKind(e);
            const title = entryDisplayName(e);
            const location = entryLocation(e, title);
            out.push({
                title, kind,
                location: location || null,
                startMin, endMin, league: null, matchups: null, idx
            });
        }
        out.sort((a, b) => (a.startMin ?? 99999) - (b.startMin ?? 99999));
        return out;
    }

    const KIND_BADGE = {
        pinned:   '<span class="lite-kind-badge pinned">Pinned</span>',
        reserved: '<span class="lite-kind-badge reserved">Reserved</span>',
        trip:     '<span class="lite-kind-badge trip">Trip</span>'
    };

    // "Team A vs Team B @ Field (Sport)" → parts. Bye/Chinuch lines lack "@".
    function parseMatchup(s) {
        const str = String(s || '').trim();
        const at = str.match(/^(.+?)\s*@\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/);
        if (at && at[2]) return { teams: at[1].trim(), field: at[2].trim(), sport: (at[3] || '').trim() };
        return { teams: str, field: '', sport: '' };
    }

    function openLeagueGamesSheet(data) {
        const rows = (data.matchups || []).map(m => {
            const g = (m && typeof m === 'object' && 'teams' in m) ? m : parseMatchup(m);
            const mine = data.team && String(g.teams || '').toLowerCase().includes(String(data.team).toLowerCase());
            const meta = [g.field, g.sport].filter(Boolean).map(esc).join(' · ');
            return `<div class="lite-game-row${mine ? ' mine' : ''}">
                <div class="lite-game-teams">${esc(g.teams)}${mine ? '<span class="lite-game-you">Your game</span>' : ''}</div>
                ${meta ? `<div class="lite-game-meta">${meta}</div>` : ''}
            </div>`;
        }).join('') || `<div class="lite-empty" style="padding:16px;">No matchups listed yet.</div>`;
        const subtitle = data.label && data.label !== data.league ? ' · ' + esc(data.label) : '';
        openSheet(`
            <div class="lite-sheet-head">
                <div class="lite-sheet-title" style="margin:0;">${esc(data.league || 'League')}${subtitle}</div>
                <button class="lite-sheet-close" id="liteGamesClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="lite-games-list">${rows}</div>`);
        const c = document.getElementById('liteGamesClose');
        if (c) c.addEventListener('click', closeSheet);
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
    // VIEW: ME LITE — full roster + search → tap a camper for everything
    // ════════════════════════════════════════════════════════════════════

    function renderMeRoster() {
        const view = document.getElementById('view-meRoster');

        if (!camp.stateLoaded) {
            view.innerHTML = emptyHTML('', 'Roster data isn\'t available for your role.');
            return;
        }
        if (!Object.keys(camp.roster || {}).length) {
            view.innerHTML = emptyHTML('', 'No campers in the roster yet.<br>Add campers on the Me page in full Campistry.');
            return;
        }

        view.innerHTML = `
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteMeSearch" type="search"
                       placeholder="Search all campers…" value="${esc(meRosterQuery)}">
            </div>
            <div id="liteMeBody"></div>`;

        const input = view.querySelector('#liteMeSearch');
        input.addEventListener('input', () => {
            meRosterQuery = input.value;
            renderMeRosterBody(view.querySelector('#liteMeBody'));
        });
        renderMeRosterBody(view.querySelector('#liteMeBody'));
    }

    function renderMeRosterBody(body) {
        const q = meRosterQuery.trim().toLowerCase();

        // Search mode: flat, ranked list across the whole camp.
        if (q) {
            const hits = Object.entries(camp.roster || {})
                .map(([name, c]) => ({ name, ...c }))
                .filter(c => meCamperMatches(c, q))
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, 60);
            body.innerHTML = hits.length
                ? `<div class="lite-section-label">${hits.length} match${hits.length === 1 ? '' : 'es'}</div>`
                    + hits.map(meCamperRowHTML).join('')
                : emptyHTML('', 'No campers match your search.');
            wireMeRoster(body);
            return;
        }

        // Browse mode: at-a-glance strip, then division chips (+ "All"), then bunk-grouped list.
        const parents = parentDivisions();
        const chips = ['All', ...parents];
        if (meDivision === null) meDivision = 'All';
        if (!chips.includes(meDivision)) meDivision = 'All';

        let html = campGlanceHTML() + chipRowHTML(chips, meDivision) + '<div id="liteMeGroups"></div>';
        body.innerHTML = html;
        body.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { meDivision = ch.dataset.val; renderMeRosterBody(body); }));

        const holder = body.querySelector('#liteMeGroups');
        const divs = meDivision === 'All' ? parents : [meDivision];
        let out = '';
        divs.forEach(p => {
            bunksForParent(p).forEach(b => {
                const campers = campersInBunk(b);
                if (!campers.length) return;
                out += `<div class="lite-section-label">${esc(b)} · ${campers.length}</div>`
                    + campers.map(meCamperRowHTML).join('');
            });
        });
        holder.innerHTML = out || emptyHTML('', 'No campers in this division.');
        wireMeRoster(holder);
    }

    function meCamperMatches(c, q) {
        const hay = [c.name, c.bunk, c.division, c.grade, c.school,
                     c.parent1Name, c.parent2Name, c.altFirstName, c.altLastName]
            .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    }

    function meCamperRowHTML(c) {
        const flags = [];
        if (c.allergies) flags.push('<span class="lite-flag">Allergy</span>');
        if (c.medications) flags.push('<span class="lite-flag med">Meds</span>');
        if (c.dietary) flags.push('<span class="lite-flag diet">Dietary</span>');
        const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
        return `<div class="lite-card lite-camper">
            <button class="lite-camper-row" type="button" data-camper="${esc(c.name)}">
                <span>
                    <span class="lite-camper-name">${esc(c.name)}</span>
                    ${meta ? `<div class="lite-camper-meta">${esc(meta)}</div>` : ''}
                </span>
                <span class="lite-camper-flags">${flags.join('')}
                    <svg class="lite-camper-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
                </span>
            </button>
        </div>`;
    }

    function wireMeRoster(root) {
        root.querySelectorAll('.lite-camper-row[data-camper]').forEach(row =>
            row.addEventListener('click', () => openCamperDetail(row.dataset.camper)));
    }

    // ─── Full camper detail (bottom sheet) — every field on file ──────────
    function openCamperDetail(name) {
        const c = camp.roster?.[name];
        if (!c) return;
        openSheet(camperDetailHTML(name, c));
        if (sheetEl) {
            const close = sheetEl.querySelector('#liteCamperClose');
            if (close) close.addEventListener('click', closeSheet);
        }
    }

    function camperDetailHTML(name, c) {
        const preferred = [c.altFirstName, c.altLastName].filter(Boolean).join(' ').trim();
        const age = ageFrom(c.dob);
        const placement = [c.division, c.grade, c.bunk].filter(Boolean).join(' · ');

        const sections = [];

        // Personal
        sections.push(dSection('Personal', [
            preferred ? dRow('Preferred name', preferred) : '',
            c.dob ? dRow('Date of birth', age != null ? `${fmtDate(c.dob)} · ${age} yrs` : fmtDate(c.dob)) : '',
            dRow('Gender', c.gender)
        ]));

        // School
        sections.push(dSection('School', [
            dRow('School', c.school),
            dRow('Grade', c.schoolGrade),
            dRow('Teacher', c.teacher)
        ]));

        // Placement
        sections.push(dSection('Placement', [
            dRow('Division', c.division),
            dRow('Grade', c.grade),
            dRow('Bunk', c.bunk)
        ]));

        // Parents / guardians
        sections.push(dSection('Parents & guardians', [
            dRow('Parent 1', c.parent1Name),
            dRow('Phone', c.parent1Phone, 'tel'),
            dRow('Email', c.parent1Email, 'mail'),
            dRow('Parent 2', c.parent2Name),
            dRow('Phone', c.parent2Phone, 'tel')
        ]));

        // Address
        const cityStateZip = ([c.city, c.state].filter(Boolean).join(', ') + (c.zip ? ` ${c.zip}` : '')).trim();
        sections.push(dSection('Address', [
            dRow('Street', c.street),
            dRow('City / State / Zip', cityStateZip)
        ]));

        // Emergency
        const emergWho = [c.emergencyName, c.emergencyRel ? `(${c.emergencyRel})` : ''].filter(Boolean).join(' ');
        sections.push(dSection('Emergency contact', [
            dRow('Contact', emergWho),
            dRow('Phone', c.emergencyPhone, 'tel')
        ]));

        // Teams
        const teamRows = [];
        if (c.teams && typeof c.teams === 'object') {
            Object.entries(c.teams).forEach(([lg, tm]) => { if (tm) teamRows.push(dRow(lg, tm)); });
        }
        if (!teamRows.length && c.team) teamRows.push(dRow('Team', c.team));
        sections.push(dSection('Teams', teamRows));

        // Medical (highlighted) — rendered as its own emphasized block
        const medRows = [];
        if (c.allergies) medRows.push(dRow('Allergies', c.allergies));
        if (c.medications) medRows.push(dRow('Medications', c.medications));
        if (c.dietary) medRows.push(dRow('Dietary', c.dietary));
        const medBlock = medRows.length
            ? `<div class="lite-detail-section lite-detail-med">
                   <div class="lite-detail-title">Medical</div>
                   <dl class="lite-detail-dl">${medRows.join('')}</dl>
               </div>`
            : '';

        // Notes
        const notesBlock = c.notes
            ? `<div class="lite-detail-section">
                   <div class="lite-detail-title">Notes</div>
                   <div class="lite-detail-notes">${esc(c.notes)}</div>
               </div>`
            : '';

        return `
            <div class="lite-detail-head">
                <div>
                    <div class="lite-sheet-title" style="margin:0;">${esc(name)}</div>
                    ${placement ? `<div class="lite-detail-sub">${esc(placement)}</div>` : ''}
                </div>
                <button class="lite-sheet-close" id="liteCamperClose" aria-label="Close">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            ${medBlock}
            ${sections.join('')}
            ${notesBlock}`;
    }

    // One section: title + <dl> of rows. Skips itself if it has no live rows.
    function dSection(title, rows) {
        const live = (rows || []).filter(Boolean);
        if (!live.length) return '';
        return `<div class="lite-detail-section">
            <div class="lite-detail-title">${esc(title)}</div>
            <dl class="lite-detail-dl">${live.join('')}</dl>
        </div>`;
    }

    // One label/value row; returns '' when value is empty so sections self-prune.
    function dRow(label, value, hrefType) {
        const v = (value == null ? '' : String(value)).trim();
        if (!v) return '';
        let val;
        if (hrefType === 'tel') val = `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}">${esc(v)}</a>`;
        else if (hrefType === 'mail') val = `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
        else val = esc(v);
        return `<dt>${esc(label)}</dt><dd>${val}</dd>`;
    }

    function ageFrom(dob) {
        if (!dob) return null;
        const d = new Date(dob);
        if (isNaN(d.getTime())) return null;
        const now = new Date();
        let a = now.getFullYear() - d.getFullYear();
        const m = now.getMonth() - d.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
        return (a >= 0 && a < 120) ? a : null;
    }

    function fmtDate(dob) {
        const d = new Date(dob);
        if (isNaN(d.getTime())) return String(dob);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // ─── At-a-glance: headcounts + birthdays (top of Roster tab) ──────────
    function campStats() {
        const roster = camp.roster || {};
        const names = Object.keys(roster);
        const bunkSet = new Set();
        let medical = 0;
        names.forEach(n => {
            const c = roster[n];
            if (c?.bunk) bunkSet.add(c.bunk);
            if (c && (c.allergies || c.medications || c.dietary)) medical++;
        });
        return { total: names.length, bunks: bunkSet.size, divisions: parentDivisions().length, medical };
    }

    function statTileHTML(num, label) {
        return `<div class="lite-stat"><div class="lite-stat-num">${num}</div><div class="lite-stat-lbl">${esc(label)}</div></div>`;
    }

    // Month/day of a dob, timezone-safe for ISO strings (no Date() drift).
    function dobMonthDay(dob) {
        if (!dob) return null;
        const s = String(dob);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return { month: +m[2], day: +m[3] };
        const d = new Date(s);
        if (isNaN(d.getTime())) return null;
        return { month: d.getMonth() + 1, day: d.getDate() };
    }

    // Campers whose birthday falls within the next 7 days (today included).
    function birthdaysThisWeek() {
        const today = new Date();
        const out = [];
        Object.entries(camp.roster || {}).forEach(([name, c]) => {
            const md = dobMonthDay(c?.dob);
            if (!md) return;
            for (let i = 0; i < 7; i++) {
                const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
                if (d.getMonth() + 1 === md.month && d.getDate() === md.day) {
                    out.push({ name, bunk: c.bunk, inDays: i,
                        when: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }) });
                    break;
                }
            }
        });
        return out.sort((a, b) => a.inDays - b.inDays);
    }

    function campGlanceHTML() {
        const s = campStats();
        const bdays = birthdaysThisWeek();
        let html = `<div class="lite-stat-row">
            ${statTileHTML(s.total, 'Campers')}
            ${statTileHTML(s.bunks, 'Bunks')}
            ${statTileHTML(s.divisions, s.divisions === 1 ? 'Division' : 'Divisions')}
            ${statTileHTML(s.medical, 'Medical')}
        </div>`;
        if (bdays.length) {
            html += `<div class="lite-bday-card">
                <div class="lite-bday-head">🎂 Birthdays this week</div>
                ${bdays.slice(0, 8).map(b => `<div class="lite-bday-row">
                    <span class="lite-bday-name">${esc(b.name)}</span>
                    <span class="lite-bday-meta">${b.bunk ? esc(b.bunk) + ' · ' : ''}<b>${esc(b.when)}</b></span>
                </div>`).join('')}
                ${bdays.length > 8 ? `<div class="lite-bday-more">+${bdays.length - 8} more</div>` : ''}
            </div>`;
        }
        return html;
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: ME LITE — Medical (camp-wide allergy / meds / dietary safety list)
    // ════════════════════════════════════════════════════════════════════

    function renderMeMedical() {
        const view = document.getElementById('view-meMedical');
        if (!camp.stateLoaded) {
            view.innerHTML = emptyHTML('', 'Roster data isn\'t available for your role.');
            return;
        }

        const types = ['All', 'Allergy', 'Meds', 'Dietary'];
        if (!types.includes(meMedType)) meMedType = 'All';
        const parents = parentDivisions();
        const divChips = ['All', ...parents];
        if (!divChips.includes(meMedDivision)) meMedDivision = 'All';

        view.innerHTML = `
            <div class="lite-seg" id="liteMedSeg">${types.map(t =>
                `<button type="button" class="lite-seg-btn${t === meMedType ? ' active' : ''}" data-val="${t}">${t}</button>`).join('')}</div>
            ${chipRowHTML(divChips, meMedDivision)}
            <div id="liteMedBody"></div>`;

        view.querySelectorAll('#liteMedSeg .lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { meMedType = b.dataset.val; renderMeMedical(); }));
        view.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { meMedDivision = ch.dataset.val; renderMeMedical(); }));

        const body = view.querySelector('#liteMedBody');
        const inDiv = (c) => meMedDivision === 'All' || (c.division === meMedDivision)
            || bunksForParent(meMedDivision).includes(c.bunk);
        const typeMatch = (c) =>
            (meMedType === 'All' && (c.allergies || c.medications || c.dietary)) ||
            (meMedType === 'Allergy' && c.allergies) ||
            (meMedType === 'Meds' && c.medications) ||
            (meMedType === 'Dietary' && c.dietary);

        const hits = Object.entries(camp.roster || {})
            .map(([name, c]) => ({ name, ...c }))
            .filter(c => typeMatch(c) && inDiv(c))
            .sort((a, b) => (a.bunk || '').localeCompare(b.bunk || '') || a.name.localeCompare(b.name));

        if (!hits.length) {
            body.innerHTML = emptyHTML('', meMedType === 'All'
                ? 'No campers have medical info on file for this division.'
                : `No campers flagged for ${meMedType.toLowerCase()} here.`);
            return;
        }

        // Group by bunk for quick "who at the pool right now" scanning.
        const byBunk = {};
        hits.forEach(c => { (byBunk[c.bunk || 'Unassigned'] = byBunk[c.bunk || 'Unassigned'] || []).push(c); });
        body.innerHTML = `<div class="lite-section-label">${hits.length} camper${hits.length === 1 ? '' : 's'}</div>`
            + Object.entries(byBunk).map(([bunk, list]) =>
                `<div class="lite-section-label">${esc(bunk)} · ${list.length}</div>` + list.map(medRowHTML).join('')
            ).join('');
        wireMeRoster(body);
    }

    function medRowHTML(c) {
        const facts = [];
        if (c.allergies) facts.push(`<div class="lite-med-fact allergy"><span>Allergy</span>${esc(c.allergies)}</div>`);
        if (c.medications) facts.push(`<div class="lite-med-fact meds"><span>Meds</span>${esc(c.medications)}</div>`);
        if (c.dietary) facts.push(`<div class="lite-med-fact diet"><span>Dietary</span>${esc(c.dietary)}</div>`);
        const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
        return `<div class="lite-card lite-med-card">
            <button class="lite-camper-row" type="button" data-camper="${esc(c.name)}">
                <span>
                    <span class="lite-camper-name">${esc(c.name)}</span>
                    ${meta ? `<div class="lite-camper-meta">${esc(meta)}</div>` : ''}
                </span>
                <svg class="lite-camper-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <div class="lite-med-facts">${facts.join('')}</div>
        </div>`;
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: ME LITE — Staff (bunk → counselor contact directory, tap-to-call)
    // ════════════════════════════════════════════════════════════════════

    function renderMeStaff() {
        const view = document.getElementById('view-meStaff');
        if (!camp.stateLoaded) {
            view.innerHTML = emptyHTML('', 'Staff data isn\'t available for your role.');
            return;
        }
        const staff = camp.staff || {};
        if (!Object.keys(staff).length) {
            view.innerHTML = emptyHTML('', 'No staff assignments yet.<br>Assign counselors to bunks in full Campistry to see the directory here.');
            return;
        }

        view.innerHTML = `
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteStaffSearch" type="search"
                       placeholder="Search bunk or counselor…" value="${esc(meStaffQuery)}">
            </div>
            <div id="liteStaffBody"></div>`;
        const input = view.querySelector('#liteStaffSearch');
        input.addEventListener('input', () => { meStaffQuery = input.value; renderMeStaffBody(view.querySelector('#liteStaffBody')); });
        renderMeStaffBody(view.querySelector('#liteStaffBody'));
    }

    function renderMeStaffBody(body) {
        const staff = camp.staff || {};
        const q = meStaffQuery.trim().toLowerCase();

        // Build bunk → [{name, phone, email}] from the assignments.
        const byBunk = {};
        Object.entries(staff).forEach(([email, rec]) => {
            const person = { name: rec.name || email, phone: rec.phone || '', email };
            (rec.bunks || []).forEach(b => { (byBunk[b] = byBunk[b] || []).push(person); });
        });

        // Order bunks by camp structure, then any extras.
        const ordered = allBunks().filter(b => byBunk[b]);
        Object.keys(byBunk).forEach(b => { if (!ordered.includes(b)) ordered.push(b); });

        const rows = ordered.filter(bunk => {
            if (!q) return true;
            if (bunk.toLowerCase().includes(q)) return true;
            return byBunk[bunk].some(p => (p.name || '').toLowerCase().includes(q));
        });

        if (!rows.length) {
            body.innerHTML = emptyHTML('', q ? 'No bunk or counselor matches your search.' : 'No bunks assigned yet.');
            return;
        }

        body.innerHTML = rows.map(bunk => {
            const people = byBunk[bunk];
            const parent = parentForBunk(bunk);
            return `<div class="lite-card lite-staff-card">
                <div class="lite-staff-bunk">${esc(bunk)}${parent ? `<span>${esc(parent)}</span>` : ''}</div>
                ${people.map(p => `<div class="lite-staff-person">
                    <div class="lite-staff-who">
                        <div class="lite-staff-name">${esc(p.name)}</div>
                        ${p.phone ? `<div class="lite-staff-meta">${esc(p.phone)}</div>` : '<div class="lite-staff-meta">No phone on file</div>'}
                    </div>
                    ${p.phone ? `<a class="lite-call-btn" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}" aria-label="Call ${esc(p.name)}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                        Call
                    </a>` : ''}
                </div>`).join('')}
            </div>`;
        }).join('');
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: LIVE LITE — Roll Call (who's here today) + Changes (pickups/late)
    // ════════════════════════════════════════════════════════════════════

    // A camper's live status for the day, mirroring the office Live logic:
    //   left    — logged as an early pickup (was here, went home early)
    //   absent  — in the absences list, or attendance flag false; reason kept
    //   present — everything else (default)
    function liveStatusFor(name, day) {
        const pick = (day.earlyPickups || []).find(p => p.name === name);
        if (pick) return { status: 'left', pickup: pick };
        const ab = (day.absences || []).find(a => a.name === name);
        if (ab) return { status: 'absent', reason: ab.reason || 'absent', absence: ab };
        if (day.attendance && day.attendance[name] === false) return { status: 'absent', reason: 'absent' };
        return { status: 'present' };
    }

    function liveTallies(day) {
        let present = 0, absent = 0, left = 0, late = 0;
        Object.keys(camp.roster || {}).forEach(name => {
            const s = liveStatusFor(name, day);
            if (s.status === 'left') left++;
            else if (s.status === 'absent') { absent++; if (s.reason === 'late') late++; }
            else present++;
        });
        return { present, absent, left, late };
    }

    async function renderLiveRoll() {
        const view = document.getElementById('view-liveRoll');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'Attendance isn\'t available for your role.'); return; }

        view.innerHTML = dateStripHTML() + `<div id="liteRollBody">${loadingHTML()}</div>`;
        wireDateStrip(view, () => renderLiveRoll());
        const body = view.querySelector('#liteRollBody');

        const day = await loadLiveDay(currentDate);
        if (activeTab !== 'liveRoll') return;

        if (!day) {
            body.innerHTML = emptyHTML('', `No attendance recorded for ${friendlyDate(currentDate)} yet.<br>Roll call happens in the office Live app.`);
            return;
        }
        if (!Object.keys(camp.roster || {}).length) {
            body.innerHTML = emptyHTML('', 'No campers in the roster yet.');
            return;
        }

        const t = liveTallies(day);
        const parents = parentDivisions();
        const chips = ['All', ...parents];
        if (!chips.includes(liveRollDivision)) liveRollDivision = 'All';

        const strip = `<div class="lite-stat-row live">
            ${statTileHTML(t.present, 'Present')}
            ${statTileHTML(t.absent, 'Absent')}
            ${statTileHTML(t.left, 'Left early')}
        </div>`;

        body.innerHTML = strip + chipRowHTML(chips, liveRollDivision) + '<div id="liteRollGroups"></div>';
        body.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { liveRollDivision = ch.dataset.val; renderLiveRoll(); }));

        const holder = body.querySelector('#liteRollGroups');
        const divs = liveRollDivision === 'All' ? parents : [liveRollDivision];
        let out = '';
        divs.forEach(p => {
            bunksForParent(p).forEach(b => {
                const campers = campersInBunk(b);
                if (!campers.length) return;
                const here = campers.filter(c => liveStatusFor(c.name, day).status !== 'absent').length;
                out += `<div class="lite-section-label">${esc(b)} · ${here}/${campers.length} here</div>`
                    + campers.map(c => liveRollRowHTML(c, liveStatusFor(c.name, day))).join('');
            });
        });
        holder.innerHTML = out || emptyHTML('', 'No bunks in this division.');
        wireMeRoster(holder);   // rows are tappable → full camper detail sheet
    }

    function liveRollRowHTML(c, s) {
        let pill;
        if (s.status === 'present') pill = '<span class="lite-status present">Here</span>';
        else if (s.status === 'left') pill = `<span class="lite-status left">Left early</span>`;
        else pill = `<span class="lite-status absent">${esc(s.reason === 'late' ? 'Late / not in' : cap(s.reason || 'Absent'))}</span>`;
        const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
        return `<div class="lite-card lite-camper">
            <button class="lite-camper-row" type="button" data-camper="${esc(c.name)}">
                <span>
                    <span class="lite-camper-name">${esc(c.name)}</span>
                    ${meta ? `<div class="lite-camper-meta">${esc(meta)}</div>` : ''}
                </span>
                <span class="lite-camper-flags">${pill}</span>
            </button>
        </div>`;
    }

    async function renderLiveChanges() {
        const view = document.getElementById('view-liveChanges');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'This isn\'t available for your role.'); return; }

        view.innerHTML = dateStripHTML()
            + `<div class="lite-field" style="margin:10px 0;">
                   <input class="lite-input" id="liteChangesSearch" type="search" placeholder="Search camper…" value="${esc(liveChangesQuery)}">
               </div>
               <div id="liteChangesBody">${loadingHTML()}</div>`;
        wireDateStrip(view, () => renderLiveChanges());
        const search = view.querySelector('#liteChangesSearch');
        search.addEventListener('input', () => { liveChangesQuery = search.value; paintLiveChanges(view.querySelector('#liteChangesBody')); });

        const day = await loadLiveDay(currentDate);
        if (activeTab !== 'liveChanges') return;
        if (!day) {
            view.querySelector('#liteChangesBody').innerHTML =
                emptyHTML('', `No dismissal changes or late arrivals logged for ${friendlyDate(currentDate)}.`);
            return;
        }
        paintLiveChanges(view.querySelector('#liteChangesBody'), day);
    }

    function paintLiveChanges(body, day) {
        if (!day) day = liveDayCache[currentDate];
        if (!day) { body.innerHTML = emptyHTML('', 'Nothing logged for this day.'); return; }
        const q = liveChangesQuery.trim().toLowerCase();
        const hit = (n) => !q || String(n || '').toLowerCase().includes(q);

        const late = (day.absences || []).filter(a => a.reason === 'late' && hit(a.name));
        const pickups = (day.earlyPickups || []).filter(p => hit(p.name));

        if (!late.length && !pickups.length) {
            body.innerHTML = emptyHTML('', q ? 'No matching changes.'
                : `No dismissal changes or late arrivals for ${friendlyDate(currentDate)}.`);
            return;
        }

        let html = '';
        if (late.length) {
            html += `<div class="lite-section-label">Late arrivals · ${late.length}</div>`
                + late.map(a => changeCardHTML(a.name, 'Late arrival', 'late',
                    a.notes || '', a.time || '')).join('');
        }
        if (pickups.length) {
            html += `<div class="lite-section-label">Dismissal changes & early pickups · ${pickups.length}</div>`
                + pickups.map(p => {
                    const bits = [];
                    if (p.pickupTime) bits.push('Pickup ' + p.pickupTime);
                    if (p.pickedUpBy) bits.push('by ' + p.pickedUpBy);
                    return changeCardHTML(p.name, p.reason || 'Early pickup', 'pickup',
                        bits.join(' · '), '');
                }).join('');
        }
        body.innerHTML = html;
        body.querySelectorAll('[data-camper]').forEach(el =>
            el.addEventListener('click', () => openCamperDetail(el.dataset.camper)));
    }

    function changeCardHTML(name, label, kind, detail, time) {
        const c = camp.roster?.[name] || {};
        const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
        return `<div class="lite-card lite-change" data-camper="${esc(name)}">
            <div class="lite-change-top">
                <span class="lite-camper-name">${esc(name)}</span>
                <span class="lite-status ${kind === 'late' ? 'absent' : 'left'}">${esc(label)}</span>
            </div>
            ${meta ? `<div class="lite-camper-meta">${esc(meta)}</div>` : ''}
            ${detail ? `<div class="lite-change-detail">${esc(detail)}${time ? ` · ${esc(time)}` : ''}</div>` : ''}
        </div>`;
    }

    function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: HEALTH LITE — Meds board (live give-status) · Roster · Trip
    // ════════════════════════════════════════════════════════════════════

    function camperMeds(c) {
        return String((c && c.medications) || '').split(',').map(m => m.trim()).filter(Boolean);
    }

    // name||med → the dispensing entry for a med given today (status Given).
    function givenTodayMap(hd) {
        const m = new Map(), today = healthTodayISO();
        ((hd && hd.dispensingLog) || []).forEach(d => {
            if (d && d.date === today && (d.status === 'Given' || !d.status)) m.set(d.camperName + '||' + d.medication, d);
        });
        return m;
    }

    function inHealthScope(c, division) {
        return division === 'All' || c.division === division || bunksForParent(division).includes(c.bunk);
    }

    // A camper's meds as give/receive rows + an allergy banner. Shared by the
    // Meds board and the Trip pack list.
    function healthCamperBlockHTML(name, c, gmap, canGive) {
        const meds = camperMeds(c);
        if (!meds.length) return '';
        const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
        const allergy = c.allergies ? `<div class="lite-health-allergy">Allergy · ${esc(c.allergies)}</div>` : '';
        const rows = meds.map(med => {
            const entry = gmap.get(name + '||' + med);
            let right;
            if (entry) right = `<span class="lite-status present">Given${entry.time ? ' · ' + esc(entry.time) : ''}</span>`;
            else if (canGive) right = `<button class="lite-give-btn" data-give-name="${esc(name)}" data-give-med="${esc(med)}">Give</button>`;
            else right = `<span class="lite-status absent">Not given</span>`;
            return `<div class="lite-med-line"><span class="lite-med-nm">${esc(med)}</span>${right}</div>`;
        }).join('');
        return `<div class="lite-card lite-health-card">
            <div class="lite-health-head" data-camper="${esc(name)}">
                <span class="lite-camper-name">${esc(name)}</span>
                ${meta ? `<span class="lite-camper-meta">${esc(meta)}</span>` : ''}
            </div>
            ${allergy}
            <div class="lite-health-meds">${rows}</div>
        </div>`;
    }

    function wireHealthGive(root, rerender) {
        root.querySelectorAll('.lite-health-head[data-camper]').forEach(h =>
            h.addEventListener('click', () => openCamperDetail(h.dataset.camper)));
        root.querySelectorAll('.lite-give-btn').forEach(btn =>
            btn.addEventListener('click', async () => {
                btn.disabled = true; btn.textContent = 'Saving…';
                try {
                    await logMedGiven(btn.dataset.giveName, btn.dataset.giveMed);
                    toast(btn.dataset.giveMed + ' given to ' + btn.dataset.giveName);
                    rerender();
                } catch (e) {
                    btn.disabled = false; btn.textContent = 'Give';
                    toast('Could not save — try again');
                }
            }));
    }

    // ─── Meds board (today) ──────────────────────────────────────────────
    async function renderHealthMeds() {
        const view = document.getElementById('view-healthMeds');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'Health data isn\'t available for your role.'); return; }
        view.innerHTML = `<div class="lite-health-today">Today · ${esc(friendlyDate(todayKey()))}</div>
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteHealthSearch" type="search" placeholder="Search camper or medication…" value="${esc(healthMedsQuery)}">
            </div>
            <div id="liteHealthBody">${loadingHTML()}</div>`;
        const input = view.querySelector('#liteHealthSearch');
        input.addEventListener('input', () => { healthMedsQuery = input.value; paintHealthMeds(); });
        await loadHealth();
        if (activeTab !== 'healthMeds') return;
        paintHealthMeds();
    }

    function paintHealthMeds() {
        const body = document.getElementById('liteHealthBody');
        if (!body) return;
        const hd = healthData || {};
        const gmap = givenTodayMap(hd);
        const canGive = canGiveMeds();
        const q = healthMedsQuery.trim().toLowerCase();
        const parents = parentDivisions();
        const chips = ['All', ...parents];
        if (!chips.includes(healthDivision)) healthDivision = 'All';

        const withMeds = Object.entries(camp.roster || {})
            .map(([n, c]) => ({ name: n, ...c }))
            .filter(c => camperMeds(c).length);
        const totalDoses = withMeds.reduce((s, c) => s + camperMeds(c).length, 0);
        const givenToday = gmap.size;

        const strip = `<div class="lite-stat-row live">
            ${statTileHTML(withMeds.length, 'On meds')}
            ${statTileHTML(givenToday, 'Given')}
            ${statTileHTML(Math.max(0, totalDoses - givenToday), 'Remaining')}
        </div>`;

        const match = (c) => {
            if (!inHealthScope(c, healthDivision)) return false;
            if (!q) return true;
            return c.name.toLowerCase().includes(q) || camperMeds(c).some(m => m.toLowerCase().includes(q));
        };
        const shown = withMeds.filter(match);

        let list = '';
        if (!withMeds.length) list = emptyHTML('', 'No medications on file. Add med info to campers in Campistry Me.');
        else if (!shown.length) list = emptyHTML('', 'No campers match here.');
        else {
            const byBunk = {};
            shown.forEach(c => { (byBunk[c.bunk || 'No bunk'] = byBunk[c.bunk || 'No bunk'] || []).push(c); });
            list = Object.entries(byBunk).map(([bunk, arr]) =>
                `<div class="lite-section-label">${esc(bunk)} · ${arr.length}</div>`
                + arr.map(c => healthCamperBlockHTML(c.name, c, gmap, canGive)).join('')
            ).join('');
        }

        body.innerHTML = strip + chipRowHTML(chips, healthDivision) + `<div id="liteHealthList">${list}</div>`;
        body.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { healthDivision = ch.dataset.val; paintHealthMeds(); }));
        wireHealthGive(body.querySelector('#liteHealthList'), paintHealthMeds);
        if (!canGive) {
            const note = document.createElement('div');
            note.className = 'lite-note';
            note.textContent = 'Read-only — ask a head-staff account to mark meds given.';
            body.appendChild(note);
        }
    }

    // ─── Health roster (allergy + med reference) ─────────────────────────
    function renderHealthRoster() {
        const view = document.getElementById('view-healthRoster');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'Roster isn\'t available for your role.'); return; }
        if (!Object.keys(camp.roster || {}).length) { view.innerHTML = emptyHTML('', 'No campers in the roster yet.'); return; }
        view.innerHTML = `
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteHRSearch" type="search" placeholder="Search campers…" value="${esc(healthRosterQuery)}">
            </div>
            <div id="liteHRBody"></div>`;
        const input = view.querySelector('#liteHRSearch');
        input.addEventListener('input', () => { healthRosterQuery = input.value; paintHealthRoster(); });
        paintHealthRoster();
    }

    function paintHealthRoster() {
        const body = document.getElementById('liteHRBody');
        if (!body) return;
        const q = healthRosterQuery.trim().toLowerCase();
        const parents = parentDivisions();
        const chips = ['All', ...parents];
        if (!chips.includes(healthDivision)) healthDivision = 'All';

        const rowFor = (name, c) => {
            const meta = [c.bunk, c.division].filter(Boolean).join(' · ');
            const facts = [];
            if (c.allergies) facts.push(`<div class="lite-med-fact allergy"><span>Allergy</span>${esc(c.allergies)}</div>`);
            if (c.medications) facts.push(`<div class="lite-med-fact meds"><span>Meds</span>${esc(c.medications)}</div>`);
            if (c.dietary) facts.push(`<div class="lite-med-fact diet"><span>Dietary</span>${esc(c.dietary)}</div>`);
            return `<div class="lite-card lite-med-card">
                <button class="lite-camper-row" type="button" data-camper="${esc(name)}">
                    <span><span class="lite-camper-name">${esc(name)}</span>${meta ? `<div class="lite-camper-meta">${esc(meta)}</div>` : ''}</span>
                    <svg class="lite-camper-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                ${facts.length ? `<div class="lite-med-facts">${facts.join('')}</div>` : ''}
            </div>`;
        };

        if (q) {
            const hits = Object.entries(camp.roster || {})
                .map(([n, c]) => ({ name: n, ...c }))
                .filter(c => meCamperMatches(c, q))
                .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
            body.innerHTML = (hits.length ? `<div class="lite-section-label">${hits.length} match${hits.length === 1 ? '' : 'es'}</div>`
                + hits.map(c => rowFor(c.name, c)).join('') : emptyHTML('', 'No campers match your search.'));
            wireMeRoster(body);
            return;
        }

        const divs = healthDivision === 'All' ? parents : [healthDivision];
        let out = '';
        divs.forEach(p => bunksForParent(p).forEach(b => {
            const campers = campersInBunk(b);
            if (!campers.length) return;
            out += `<div class="lite-section-label">${esc(b)} · ${campers.length}</div>` + campers.map(c => rowFor(c.name, c)).join('');
        }));
        body.innerHTML = chipRowHTML(chips, healthDivision) + `<div id="liteHRGroups">${out || emptyHTML('', 'No campers in this division.')}</div>`;
        body.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { healthDivision = ch.dataset.val; paintHealthRoster(); }));
        wireMeRoster(body.querySelector('#liteHRGroups'));
    }

    // ─── Trip pack list (required meds for a group) ──────────────────────
    async function renderHealthTrip() {
        const view = document.getElementById('view-healthTrip');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'Health data isn\'t available for your role.'); return; }
        const parents = parentDivisions();
        const chips = ['All', ...parents];
        if (healthTripScope === null || !chips.includes(healthTripScope)) healthTripScope = 'All';
        view.innerHTML = `<div class="lite-note">Meds &amp; allergies to take along — pick the group going on the trip.</div>`
            + chipRowHTML(chips, healthTripScope) + `<div id="liteTripBody">${loadingHTML()}</div>`;
        view.querySelectorAll('.lite-chip').forEach(ch =>
            ch.addEventListener('click', () => { healthTripScope = ch.dataset.val; renderHealthTrip(); }));
        await loadHealth();
        if (activeTab !== 'healthTrip') return;
        paintHealthTrip();
    }

    function paintHealthTrip() {
        const body = document.getElementById('liteTripBody');
        if (!body) return;
        const hd = healthData || {};
        const gmap = givenTodayMap(hd);
        const canGive = canGiveMeds();
        const parents = parentDivisions();
        const divs = healthTripScope === 'All' ? parents : [healthTripScope];

        const groups = [];
        let camperCount = 0, doseCount = 0;
        divs.forEach(p => bunksForParent(p).forEach(b => {
            const withMeds = campersInBunk(b).filter(c => camperMeds(c).length);
            if (!withMeds.length) return;
            camperCount += withMeds.length;
            withMeds.forEach(c => { doseCount += camperMeds(c).length; });
            groups.push({ bunk: b, campers: withMeds });
        }));

        if (!groups.length) { body.innerHTML = emptyHTML('', 'No medications needed for this group — nothing to pack.'); return; }

        const header = `<div class="lite-trip-summary"><b>${camperCount}</b> camper${camperCount === 1 ? '' : 's'} need ${doseCount} med${doseCount === 1 ? '' : 's'} on this trip</div>`;
        const list = groups.map(g =>
            `<div class="lite-section-label">${esc(g.bunk)} · ${g.campers.length}</div>`
            + g.campers.map(c => healthCamperBlockHTML(c.name, c, gmap, canGive)).join('')
        ).join('');
        body.innerHTML = header + `<div id="liteTripList">${list}</div>`;
        wireHealthGive(body.querySelector('#liteTripList'), paintHealthTrip);
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: LINK LITE — Messages (inbox + threads + reply) · Compose
    // ════════════════════════════════════════════════════════════════════

    // Group messages into threads keyed by thread_id (fallback parent|camper).
    function linkThreads() {
        const map = new Map();
        (linkMsgs || []).forEach(m => {
            const key = m.thread_id || ((m.parent_name || '') + '|' + (m.camper_name || ''));
            if (!map.has(key)) map.set(key, { key, parentName: m.parent_name || '', parentEmail: m.parent_email || '', camperName: m.camper_name || '', msgs: [] });
            const t = map.get(key);
            t.msgs.push(m);
            if (m.parent_name && !t.parentName) t.parentName = m.parent_name;
            if (m.parent_email && !t.parentEmail) t.parentEmail = m.parent_email;
            if (m.camper_name && !t.camperName) t.camperName = m.camper_name;
        });
        const arr = [...map.values()].map(t => {
            t.msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            t.last = t.msgs[t.msgs.length - 1];
            t.unread = t.msgs.filter(m => m.direction === 'in' && !m.read).length;
            t.important = t.msgs.some(m => m.important);
            t.archived = t.msgs.length > 0 && t.msgs.every(m => m.archived);
            return t;
        });
        arr.sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
        return arr;
    }

    async function renderLinkMessages() {
        const view = document.getElementById('view-linkMessages');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'Messages aren\'t available for your role.'); return; }
        view.innerHTML = `
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteLinkSearch" type="search" placeholder="Search messages…" value="${esc(linkThreadQuery)}">
            </div>
            <div id="liteLinkBody">${loadingHTML()}</div>`;
        const input = view.querySelector('#liteLinkSearch');
        input.addEventListener('input', () => { linkThreadQuery = input.value; paintLinkThreads(); });
        await loadLinkMessages();
        if (activeTab !== 'linkMessages') return;
        paintLinkThreads();
    }

    const LINK_FILTERS = ['all', 'unread', 'important', 'archived'];
    const LINK_FILTER_LABEL = { all: 'All', unread: 'Unread', important: 'Important', archived: 'Archived' };

    function paintLinkThreads() {
        const body = document.getElementById('liteLinkBody');
        if (!body) return;
        const q = linkThreadQuery.trim().toLowerCase();
        let threads = linkThreads();
        // Filter: archived is its own bucket; the others exclude archived.
        if (linkMsgFilter === 'archived') threads = threads.filter(t => t.archived);
        else {
            threads = threads.filter(t => !t.archived);
            if (linkMsgFilter === 'unread') threads = threads.filter(t => t.unread);
            else if (linkMsgFilter === 'important') threads = threads.filter(t => t.important);
        }
        if (q) threads = threads.filter(t =>
            (t.parentName + ' ' + t.camperName + ' ' + (t.last.subject || '') + ' ' + (t.last.body || '')).toLowerCase().includes(q));

        const chips = `<div class="lite-seg" id="liteMsgFilter">${LINK_FILTERS.map(f =>
            `<button type="button" class="lite-seg-btn${f === linkMsgFilter ? ' active' : ''}" data-val="${f}">${LINK_FILTER_LABEL[f]}</button>`).join('')}</div>`;

        const list = threads.length ? threads.map(t => {
            const who = t.parentName || 'Parent';
            const sub = [t.camperName ? esc(t.camperName) : '', t.last.subject ? esc(t.last.subject) : ''].filter(Boolean).join(' · ');
            const dir = t.last.direction === 'in' ? '' : 'You: ';
            const preview = esc((t.last.body || '').replace(/\[\[(form|list):[^\]]+\]\]/g, '').trim().slice(0, 80));
            const star = `<button class="lite-thread-act${t.important ? ' on' : ''}" data-act="important" data-key="${esc(t.key)}" title="${t.important ? 'Unmark important' : 'Mark important'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="${t.important ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>`;
            const arch = `<button class="lite-thread-act" data-act="archive" data-key="${esc(t.key)}" title="${t.archived ? 'Unarchive' : 'Archive'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>`;
            const readBtn = t.unread ? `<button class="lite-thread-act" data-act="read" data-key="${esc(t.key)}" title="Mark read">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></button>` : '';
            const archLabel = t.archived ? 'Unarchive' : 'Archive';
            return `<div class="lite-swipe">
                <div class="lite-swipe-bg">
                    <span class="lite-swipe-arch">${archLabel}</span>
                    <span class="lite-swipe-del">Delete</span>
                </div>
                <div class="lite-card lite-thread lite-swipe-fg" data-key="${esc(t.key)}">
                    <div class="lite-thread-top">
                        <span class="lite-camper-name">${esc(who)}</span>
                        ${t.unread ? `<span class="lite-unread-dot" aria-label="${t.unread} unread"></span>` : ''}
                        ${t.important ? '<span class="lite-imp-dot" title="Important"></span>' : ''}
                        <span class="lite-thread-time">${esc(shortWhen(t.last.created_at))}</span>
                    </div>
                    ${sub ? `<div class="lite-camper-meta">${sub}</div>` : ''}
                    <div class="lite-thread-preview">${dir}${preview || '(attachment)'}</div>
                    <div class="lite-thread-actions">${star}${arch}${readBtn}</div>
                </div>
            </div>`;
        }).join('') : emptyHTML('', q ? 'No messages match your search.'
            : linkMsgFilter === 'all' ? 'No messages yet. Tap Compose to write a parent.'
            : `No ${LINK_FILTER_LABEL[linkMsgFilter].toLowerCase()} messages.`);

        body.innerHTML = chips + list;
        body.querySelectorAll('#liteMsgFilter .lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { linkMsgFilter = b.dataset.val; paintLinkThreads(); }));
        body.querySelectorAll('.lite-thread-act[data-act]').forEach(btn =>
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const t = linkThreads().find(x => x.key === btn.dataset.key);
                if (!t) return;
                const act = btn.dataset.act;
                if (act === 'important') await setThreadFlag(t, 'important', !t.important);
                else if (act === 'archive') await setThreadFlag(t, 'archived', !t.archived);
                else if (act === 'read') await markThreadRead(t);
                paintLinkThreads();
            }));
        body.querySelectorAll('.lite-swipe-fg[data-key]').forEach(el =>
            el.addEventListener('click', () => { if (el.dataset.swiped !== '1') openLinkThread(el.dataset.key); }));
        wireThreadSwipe(body);
    }

    // Swipe a thread card: right-to-left → delete, left-to-right → archive.
    // Pointer events (mouse + touch); vertical scroll stays with the browser.
    function wireThreadSwipe(root) {
        const THRESH = 78;
        root.querySelectorAll('.lite-swipe').forEach(sw => {
            const fg = sw.querySelector('.lite-swipe-fg');
            if (!fg) return;
            let startX = 0, startY = 0, dx = 0, dragging = false, decided = false, horiz = false;
            fg.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.lite-thread-act')) return;
                dragging = true; decided = false; horiz = false; startX = e.clientX; startY = e.clientY; dx = 0;
                fg.style.transition = 'none';
            });
            fg.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                const mx = e.clientX - startX, my = e.clientY - startY;
                if (!decided && (Math.abs(mx) > 8 || Math.abs(my) > 8)) { decided = true; horiz = Math.abs(mx) > Math.abs(my); }
                if (!horiz) return;
                e.preventDefault();
                try { fg.setPointerCapture(e.pointerId); } catch (_) {}
                dx = mx;
                fg.style.transform = `translateX(${Math.max(-150, Math.min(150, dx))}px)`;
                sw.classList.toggle('reveal-del', dx < -18);
                sw.classList.toggle('reveal-arch', dx > 18);
                fg.dataset.swiped = Math.abs(dx) > 8 ? '1' : '';
            });
            const end = () => {
                if (!dragging) return;
                dragging = false;
                fg.style.transition = ''; fg.style.transform = '';
                sw.classList.remove('reveal-del', 'reveal-arch');
                const key = fg.dataset.key;
                if (horiz && dx < -THRESH) {
                    if (!canDeleteMessages()) toast('Only an owner or admin can delete');
                    else if (litePref('confirmDelete', true)) confirmDeleteThread(key);
                    else { const t = linkThreads().find(x => x.key === key); if (t) deleteThread(t); }
                } else if (horiz && dx > THRESH) {
                    const t = linkThreads().find(x => x.key === key);
                    if (t) setThreadFlag(t, 'archived', !t.archived).then(() => { toast(t.archived ? 'Unarchived' : 'Archived'); paintLinkThreads(); });
                }
                setTimeout(() => { fg.dataset.swiped = ''; }, 60);
            };
            fg.addEventListener('pointerup', end);
            fg.addEventListener('pointercancel', end);
        });
    }

    function openLinkThread(key) {
        const t = linkThreads().find(x => x.key === key);
        if (!t) return;
        // Opening a thread marks its incoming messages read (cloud + local).
        if (t.unread) markThreadRead(t).then(() => { if (activeTab === 'linkMessages') paintLinkThreads(); });
        const bubbles = t.msgs.map(m => {
            const tokens = (m.body || '').match(/\[\[(form|list):[^\]]+\]\]/g) || [];
            const clean = esc((m.body || '').replace(/\[\[(form|list):[^\]]+\]\]/g, '').trim());
            const chips = tokens.map(tok => {
                const isForm = tok.startsWith('[[form');
                return `<span class="lite-attach-chip">${isForm ? 'Form' : 'List'} attached</span>`;
            }).join('');
            return `<div class="lite-bubble ${m.direction === 'in' ? 'in' : 'out'}">
                ${m.subject ? `<div class="lite-bubble-subj">${esc(m.subject)}</div>` : ''}
                ${clean ? `<div>${clean}</div>` : ''}
                ${chips ? `<div class="lite-bubble-attach">${chips}</div>` : ''}
                <div class="lite-bubble-time">${esc(shortWhen(m.created_at))}</div>
            </div>`;
        }).join('');
        const canReply = t.parentName || t.parentEmail;
        openSheet(`
            <div class="lite-detail-head">
                <div><div class="lite-sheet-title" style="margin:0;">${esc(t.parentName || 'Conversation')}</div>
                    ${t.camperName ? `<div class="lite-detail-sub">${esc(t.camperName)}</div>` : ''}</div>
                <button class="lite-sheet-close" id="liteThreadClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="lite-thread-scroll">${bubbles}</div>
            ${canReply ? `<div class="lite-reply-row">
                <input class="lite-input" id="liteReplyInput" type="text" placeholder="Reply to ${esc(t.parentName || 'parent')}…">
                <button class="lite-btn" id="liteReplySend">Send</button>
            </div>` : `<div class="lite-note">No parent contact on file to reply to.</div>`}`);
        if (!sheetEl) return;
        sheetEl.querySelector('#liteThreadClose').addEventListener('click', closeSheet);
        const sendBtn = sheetEl.querySelector('#liteReplySend');
        if (sendBtn) sendBtn.addEventListener('click', async () => {
            const inp = sheetEl.querySelector('#liteReplyInput');
            const text = (inp.value || '').trim();
            if (!text) return;
            sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
            try {
                await sendLinkMessage({ threadId: t.key.includes('|') ? undefined : t.key, parentName: t.parentName, parentEmail: t.parentEmail, camperName: t.camperName, subject: t.last.subject ? ('Re: ' + t.last.subject.replace(/^Re:\s*/i, '')) : 'Message', body: text });
                toast('Reply sent');
                closeSheet();
                paintLinkThreads();
            } catch (e) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; toast('Could not send — try again'); }
        });
    }

    // ─── Compose ─────────────────────────────────────────────────────────
    async function renderLinkCompose() {
        const view = document.getElementById('view-linkCompose');
        if (!camp.stateLoaded) { view.innerHTML = emptyHTML('', 'Compose isn\'t available for your role.'); return; }
        if (linkForms === null || linkLists === null) await loadLinkFormsLists();
        if (activeTab !== 'linkCompose') return;
        paintLinkCompose();
    }

    function hasRecipient(type, name) {
        return linkComposeRecipients.some(r => r.type === type && r.name === name);
    }
    function toggleRecipient(type, name) {
        const i = linkComposeRecipients.findIndex(r => r.type === type && r.name === name);
        if (i >= 0) linkComposeRecipients.splice(i, 1);
        else linkComposeRecipients.push({ type, name });
    }
    function campersForRecipient(r) {
        if (r.type === 'camper') return [r.name];
        const field = r.type === 'grade' ? 'grade' : 'division';
        return Object.entries(camp.roster || {}).filter(([, c]) => c && c[field] === r.name).map(([n]) => n);
    }
    // Resolve all selected recipients → de-duped parent targets (contact required).
    function resolveComposeTargets() {
        const seen = new Set(), out = [];
        linkComposeRecipients.forEach(r => campersForRecipient(r).forEach(name => {
            if (seen.has(name)) return;
            const c = camp.roster[name]; if (!c) return;
            if (!(c.parent1Name || c.parent1Email)) return;
            seen.add(name);
            out.push({ camperName: name, parentName: c.parent1Name || '', parentEmail: c.parent1Email || '' });
        }));
        return out;
    }

    function paintLinkCompose() {
        const view = document.getElementById('view-linkCompose');
        const attach = linkComposeAttach;
        const attachChips = [
            attach.form ? `<span class="lite-attach-chip">Form · ${esc(linkLabelOf(attach.form))} <button data-clear="form">×</button></span>` : '',
            attach.list ? `<span class="lite-attach-chip">List · ${esc(linkLabelOf(attach.list))} <button data-clear="list">×</button></span>` : ''
        ].filter(Boolean).join('');
        const recipChips = linkComposeRecipients.map((r, i) => {
            const tag = r.type === 'division' ? 'Division' : r.type === 'grade' ? 'Grade' : '';
            return `<span class="lite-attach-chip">${tag ? tag + ' · ' : ''}${esc(r.name)} <button data-remove="${i}">×</button></span>`;
        }).join('');
        const targets = resolveComposeTargets();
        const modes = [['division', 'By division'], ['grade', 'By grade'], ['camper', 'Campers']];

        view.innerHTML = `
            <div class="lite-compose">
                <label class="lite-lbl">To</label>
                ${recipChips ? `<div class="lite-recip-chips">${recipChips}</div>
                    <div class="lite-note" style="margin:2px 2px 8px;">${targets.length} parent${targets.length === 1 ? '' : 's'}</div>` : ''}
                <div class="lite-seg" id="liteRecMode">${modes.map(([m, l]) =>
                    `<button type="button" class="lite-seg-btn${m === linkComposeMode ? ' active' : ''}" data-val="${m}">${l}</button>`).join('')}</div>
                <div id="liteRecPicker"></div>
                <label class="lite-lbl">Subject</label>
                <input class="lite-input" id="liteMsgSubj" type="text" placeholder="Subject" value="${esc(linkComposeSubject)}">
                <label class="lite-lbl">Message</label>
                <textarea class="lite-input lite-textarea" id="liteMsgBody" rows="5" placeholder="Write your message…">${esc(linkComposeBody)}</textarea>
                ${attachChips ? `<div class="lite-attach-row">${attachChips}</div>` : ''}
                <div class="lite-compose-actions">
                    <button class="lite-btn secondary" id="liteAttachBtn">Attach form / list</button>
                    <button class="lite-btn" id="liteSendBtn">Send</button>
                </div>
            </div>`;

        paintRecPicker(view.querySelector('#liteRecPicker'));
        view.querySelectorAll('#liteRecMode .lite-seg-btn').forEach(b =>
            b.addEventListener('click', () => { linkComposeMode = b.dataset.val; paintRecPicker(view.querySelector('#liteRecPicker')); }));
        view.querySelectorAll('.lite-recip-chips [data-remove]').forEach(btn =>
            btn.addEventListener('click', () => { linkComposeRecipients.splice(+btn.dataset.remove, 1); paintLinkCompose(); }));

        const subjEl = view.querySelector('#liteMsgSubj');
        const bodyEl = view.querySelector('#liteMsgBody');
        subjEl.addEventListener('input', () => { linkComposeSubject = subjEl.value; });
        bodyEl.addEventListener('input', () => { linkComposeBody = bodyEl.value; });
        view.querySelectorAll('[data-clear]').forEach(btn => btn.addEventListener('click', () => { linkComposeAttach[btn.dataset.clear] = null; paintLinkCompose(); }));
        view.querySelector('#liteAttachBtn').addEventListener('click', openAttachPicker);
        view.querySelector('#liteSendBtn').addEventListener('click', doComposeSend);
    }

    function paintRecPicker(box) {
        if (!box) return;
        const mode = linkComposeMode;
        if (mode === 'division' || mode === 'grade') {
            const items = mode === 'division' ? parentDivisions() : allGrades();
            box.innerHTML = items.length
                ? `<div class="lite-chiprow wrap">${items.map(n =>
                    `<button type="button" class="lite-chip${hasRecipient(mode, n) ? ' active' : ''}" data-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>`
                : `<div class="lite-note">None configured.</div>`;
            box.querySelectorAll('[data-pick]').forEach(btn =>
                btn.addEventListener('click', () => { toggleRecipient(mode, btn.dataset.pick); paintLinkCompose(); }));
            return;
        }
        // Camper mode: search + tap to toggle
        box.innerHTML = `<input class="lite-input" id="liteRecSearch" type="search" placeholder="Search campers…" value="${esc(linkComposeQuery)}"><div id="liteRecResults"></div>`;
        const search = box.querySelector('#liteRecSearch');
        const results = box.querySelector('#liteRecResults');
        const paint = () => {
            const q = (search.value || '').trim().toLowerCase();
            linkComposeQuery = search.value;
            if (!q) { results.innerHTML = ''; return; }
            const hits = Object.entries(camp.roster || {}).filter(([n]) => n.toLowerCase().includes(q)).slice(0, 10);
            results.innerHTML = hits.length ? hits.map(([n, c]) => {
                const on = hasRecipient('camper', n);
                const contact = [c.bunk, c.parent1Name].filter(Boolean).join(' · ') || 'No parent on file';
                return `<button class="lite-rec-hit${on ? ' on' : ''}" data-name="${esc(n)}"><span class="lite-camper-name">${esc(n)}</span><div class="lite-camper-meta">${esc(contact)}</div></button>`;
            }).join('') : `<div class="lite-note">No campers match.</div>`;
            results.querySelectorAll('.lite-rec-hit').forEach(btn =>
                btn.addEventListener('click', () => { toggleRecipient('camper', btn.dataset.name); paintLinkCompose(); }));
        };
        search.addEventListener('input', paint);
        paint();
    }

    function openAttachPicker() {
        const forms = linkForms || [], lists = linkLists || [];
        if (!forms.length && !lists.length) { toast('No forms or lists were created on the desktop yet'); return; }
        const item = (kind, it) => `<button class="lite-pick-row" data-kind="${kind}" data-id="${esc(it.id)}"><span class="lite-camper-name">${esc(linkLabelOf(it))}</span><div class="lite-camper-meta">${kind === 'form' ? esc(it._cat || 'Form') : (it.items ? it.items.length + ' items' : 'List')}</div></button>`;
        openSheet(`
            <div class="lite-sheet-title">Attach a form or list</div>
            <div class="lite-note" style="margin-top:-6px;">These come from the desktop — Lite can attach them, not create them.</div>
            ${forms.length ? `<div class="lite-section-label">Forms</div>${forms.map(f => item('form', f)).join('')}` : ''}
            ${lists.length ? `<div class="lite-section-label">Lists</div>${lists.map(l => item('list', l)).join('')}` : ''}`);
        if (!sheetEl) return;
        sheetEl.querySelectorAll('.lite-pick-row').forEach(btn => btn.addEventListener('click', () => {
            const kind = btn.dataset.kind;
            const src = kind === 'form' ? forms : lists;
            const it = src.find(x => String(x.id) === btn.dataset.id);
            if (it) linkComposeAttach[kind] = it;
            closeSheet(); paintLinkCompose();
        }));
    }

    async function doComposeSend() {
        const view = document.getElementById('view-linkCompose');
        const targets = resolveComposeTargets();
        if (!targets.length) { toast('Add a recipient with a parent on file'); return; }
        const subj = ((view.querySelector('#liteMsgSubj') || {}).value ?? linkComposeSubject).trim();
        const baseBody = ((view.querySelector('#liteMsgBody') || {}).value ?? linkComposeBody).trim();
        const attach = linkComposeAttach;
        if (!subj) { toast('Subject is required'); return; }
        if (!baseBody && !attach.form && !attach.list) { toast('Write a message or attach a form/list'); return; }
        const btn = view.querySelector('#liteSendBtn'); btn.disabled = true; btn.textContent = 'Sending…';
        try {
            // One message per parent; the form token carries that camper's name.
            for (const t of targets) {
                let body = baseBody;
                if (attach.form) body += `\n\n[[form:${attach.form.id}:${t.camperName || ''}]]`;
                if (attach.list) body += `\n\n[[list:${attach.list.id}]]`;
                await sendLinkMessage({ parentName: t.parentName, parentEmail: t.parentEmail, camperName: t.camperName, subject: subj, body });
            }
            toast(targets.length === 1 ? ('Message sent to ' + (targets[0].parentName || targets[0].camperName))
                : ('Sent to ' + targets.length + ' parents'));
            linkComposeRecipients = []; linkComposeQuery = ''; linkComposeAttach = { form: null, list: null };
            linkComposeSubject = ''; linkComposeBody = '';
            paintLinkCompose();
        } catch (e) { btn.disabled = false; btn.textContent = 'Send'; toast('Could not send — try again'); }
    }

    function shortWhen(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const now = new Date(), diff = now - d;
        if (diff < 60000) return 'now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // ════════════════════════════════════════════════════════════════════
    // VIEW: NOTES LITE — list (grid) + full-screen editor
    // ════════════════════════════════════════════════════════════════════

    const NOTES_VIEWS = [
        ['all', 'All'], ['pinned', 'Pinned'], ['reminders', 'Reminders'], ['shared', 'Shared'], ['trash', 'Trash']
    ];
    function notesMatchesView(n) {
        if (notesView === 'trash') return !!n.trashed;
        if (n.trashed) return false;
        if (notesView === 'pinned') return !!n.pinned;
        if (notesView === 'reminders') return !!n.reminder;
        if (notesView === 'shared') return !!n.isShared;
        return true;
    }

    async function renderNotes() {
        const view = document.getElementById('view-notesList');
        if (notesArr === null || campUsers === null) { view.innerHTML = loadingHTML(); await Promise.all([loadNotes(), loadCampUsers()]); }
        if (activeTab !== 'notesList') return;
        if (notesEditorId) { renderNoteEditor(); return; }
        paintNotesList();
    }

    function paintNotesList() {
        const view = document.getElementById('view-notesList');
        const q = notesQuery.trim().toLowerCase();
        let list = (notesArr || []).filter(notesMatchesView);
        if (q) list = list.filter(n => ((n.title || '') + ' ' + (n.body || '')).toLowerCase().includes(q));
        list.sort((a, b) => {
            if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });

        const chips = `<div class="lite-chiprow">${NOTES_VIEWS.map(([v, l]) =>
            `<button type="button" class="lite-chip${v === notesView ? ' active' : ''}" data-nv="${v}">${l}</button>`).join('')}</div>`;

        const cards = list.length ? `<div class="lite-notes-grid">${list.map(noteCardHTML).join('')}</div>`
            : emptyHTML('', q ? 'No notes match your search.'
                : notesView === 'trash' ? 'Trash is empty.'
                : notesView === 'all' ? 'No notes yet. Tap + to write one.'
                : `No ${notesView} notes.`);

        view.innerHTML = `
            <div class="lite-field" style="margin-bottom:10px;">
                <input class="lite-input" id="liteNotesSearch" type="search" placeholder="Search notes…" value="${esc(notesQuery)}">
            </div>
            ${chips}
            <div id="liteNotesBody">${cards}</div>`;

        const s = view.querySelector('#liteNotesSearch');
        s.addEventListener('input', () => { notesQuery = s.value; paintNotesBody(); });
        view.querySelectorAll('[data-nv]').forEach(c => c.addEventListener('click', () => { notesView = c.dataset.nv; paintNotesList(); }));
        showNotesFab(true);
        wireNoteCards(view);
    }

    // The FAB is a standalone element in #liteApp (outside the animated views);
    // show it only on the notes list, wire its click once.
    function showNotesFab(show) {
        const fab = document.getElementById('liteNoteNew');
        if (!fab) return;
        fab.style.display = show ? '' : 'none';
        if (show && !fab._wired) { fab._wired = true; fab.addEventListener('click', createNote); }
    }

    function paintNotesBody() {
        // lighter repaint on search (keeps focus in the search box)
        const body = document.getElementById('liteNotesBody');
        if (!body) return;
        const q = notesQuery.trim().toLowerCase();
        let list = (notesArr || []).filter(notesMatchesView);
        if (q) list = list.filter(n => ((n.title || '') + ' ' + (n.body || '')).toLowerCase().includes(q));
        list.sort((a, b) => (!!a.pinned !== !!b.pinned) ? (a.pinned ? -1 : 1) : (b.updatedAt || 0) - (a.updatedAt || 0));
        body.innerHTML = list.length ? `<div class="lite-notes-grid">${list.map(noteCardHTML).join('')}</div>`
            : emptyHTML('', q ? 'No notes match your search.' : 'No notes here.');
        wireNoteCards(body);
    }

    function noteCardHTML(n) {
        const title = n.title ? esc(n.title) : '';
        const body = n.body ? esc(n.body) : '<span class="lite-note-empty">Empty note</span>';
        const when = n.updatedAt ? new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
        return `<button class="lite-note-card" data-note="${esc(n.id)}" data-color="${esc(n.color || 'yellow')}">
            ${n.pinned ? '<span class="lite-note-pin">📌</span>' : ''}
            ${title ? `<div class="lite-note-title">${title}</div>` : ''}
            <div class="lite-note-body">${body}</div>
            <div class="lite-note-foot">${n.reminder ? '<span class="lite-note-badge">⏰</span>' : ''}${n.isShared ? '<span class="lite-note-badge">↗</span>' : ''}<span class="lite-note-date">${esc(when)}</span></div>
        </button>`;
    }
    function wireNoteCards(root) {
        root.querySelectorAll('.lite-note-card[data-note]').forEach(c =>
            c.addEventListener('click', () => { notesEditorId = c.dataset.note; renderNoteEditor(); }));
    }

    function createNote() {
        const n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ownerId: userId, title: '', body: '', color: 'yellow', pinned: false, trashed: false, sharedWith: [], isShared: false, reminder: null, createdAt: Date.now(), updatedAt: Date.now() };
        notesArr = (notesArr || []).concat(n);
        notesEditorId = n.id;
        upsertNote(n);
        renderNoteEditor();
    }

    // ─── Full-screen note editor ─────────────────────────────────────────
    function renderNoteEditor() {
        showNotesFab(false);
        const view = document.getElementById('view-notesList');
        const n = noteById(notesEditorId);
        if (!n) { notesEditorId = null; paintNotesList(); return; }
        const inTrash = !!n.trashed;
        const canEdit = canEditNote(n);
        const ro = !canEdit || inTrash;           // read-only inputs
        const reminderVal = n.reminder ? toLocalDatetime(n.reminder) : '';
        const shareChips = (n.sharedWith || []).map(e =>
            `<span class="lite-attach-chip">${esc(e)}${canEdit ? ` <button data-unshare="${esc(e)}">×</button>` : ''}</span>`).join('');

        view.innerHTML = `
            <div class="lite-note-editor">
                <div class="lite-note-ed-head">
                    <button class="lite-settings-back" id="liteNoteBack" aria-label="Back to notes">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    ${canEdit ? `<div class="lite-note-ed-actions">
                        <button class="lite-note-act${n.pinned ? ' on' : ''}" id="liteNotePin" aria-label="Pin">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="${n.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
                        </button>
                        <button class="lite-note-act" id="liteNoteTrash" aria-label="${inTrash ? 'Restore' : 'Delete'}">
                            ${inTrash
                                ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/></svg>'
                                : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'}
                        </button>
                    </div>` : ''}
                </div>
                ${!canEdit ? '<div class="lite-note-ro">Shared with you · read-only</div>' : ''}
                <input class="lite-note-title-input" id="liteNoteTitle" placeholder="Title" value="${esc(n.title || '')}" ${ro ? 'disabled' : ''}>
                <textarea class="lite-note-body-input" id="liteNoteBody" placeholder="Start writing…" ${ro ? 'disabled' : ''}>${esc(n.body || '')}</textarea>
                ${canEdit && !inTrash ? `<div class="lite-note-colors">${NOTE_COLORS.map(c =>
                    `<button class="lite-note-dot${c === (n.color || 'yellow') ? ' on' : ''}" data-color="${c}" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>` : ''}

                ${canEdit && !inTrash ? `
                <div class="lite-note-section">
                    <div class="lite-note-sec-label">Reminder</div>
                    <input class="lite-input" id="liteNoteReminder" type="datetime-local" value="${esc(reminderVal)}">
                    ${n.reminder ? '<button class="lite-link-btn" id="liteNoteReminderClear">Clear reminder</button>' : ''}
                </div>
                <div class="lite-note-section">
                    <div class="lite-note-sec-label">Shared with</div>
                    ${shareChips ? `<div class="lite-attach-row">${shareChips}</div>` : '<div class="lite-note" style="margin:0 0 6px;">Not shared yet</div>'}
                    ${shareOptionsHTML(n)}
                </div>` : (shareChips ? `<div class="lite-note-section"><div class="lite-note-sec-label">Shared with</div><div class="lite-attach-row">${shareChips}</div></div>` : '')}

                <div class="lite-note-meta">${inTrash ? 'In Trash · ' : ''}${n.reminder ? '⏰ ' + fmtDate(n.reminder) + ' · ' : ''}Edited ${n.updatedAt ? new Date(n.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</div>
                ${canEdit && inTrash ? '<button class="lite-btn danger block" id="liteNotePurge" style="margin-top:14px;">Delete forever</button>' : ''}
            </div>`;
        view.setAttribute('data-color', n.color || 'yellow');

        view.querySelector('#liteNoteBack').addEventListener('click', () => { flushNoteSave(); notesEditorId = null; paintNotesList(); });
        if (!canEdit) return;   // shared-to-me notes are read-only; no edit wiring

        const titleEl = view.querySelector('#liteNoteTitle');
        const bodyEl = view.querySelector('#liteNoteBody');
        const onEdit = () => { const nn = noteById(notesEditorId); if (!nn) return; nn.title = titleEl.value; nn.body = bodyEl.value; scheduleNoteSave(nn); };
        if (titleEl && !ro) titleEl.addEventListener('input', onEdit);
        if (bodyEl && !ro) bodyEl.addEventListener('input', onEdit);

        const pinBtn = view.querySelector('#liteNotePin');
        if (pinBtn) pinBtn.addEventListener('click', () => { const nn = noteById(notesEditorId); if (!nn) return; nn.pinned = !nn.pinned; upsertNote(nn); renderNoteEditor(); });
        const trashBtn = view.querySelector('#liteNoteTrash');
        if (trashBtn) trashBtn.addEventListener('click', () => {
            const nn = noteById(notesEditorId); if (!nn) return; nn.trashed = !nn.trashed; upsertNote(nn);
            toast(nn.trashed ? 'Moved to Trash' : 'Restored'); notesEditorId = null; paintNotesList();
        });
        view.querySelectorAll('.lite-note-dot').forEach(d => d.addEventListener('click', () => {
            const nn = noteById(notesEditorId); if (!nn) return; nn.color = d.dataset.color; upsertNote(nn); renderNoteEditor();
        }));
        const remEl = view.querySelector('#liteNoteReminder');
        if (remEl) remEl.addEventListener('change', () => {
            const nn = noteById(notesEditorId); if (!nn) return; nn.reminder = remEl.value ? new Date(remEl.value).toISOString() : null; upsertNote(nn); renderNoteEditor();
        });
        const remClear = view.querySelector('#liteNoteReminderClear');
        if (remClear) remClear.addEventListener('click', () => { const nn = noteById(notesEditorId); if (!nn) return; nn.reminder = null; upsertNote(nn); renderNoteEditor(); });
        const shareSel = view.querySelector('#liteNoteShareSelect');
        if (shareSel) shareSel.addEventListener('change', () => {
            const email = (shareSel.value || '').trim().toLowerCase();
            if (!email) return;
            const nn = noteById(notesEditorId); if (!nn) return;
            nn.sharedWith = Array.from(new Set([...(nn.sharedWith || []), email]));
            nn.isShared = nn.sharedWith.length > 0; upsertNote(nn); renderNoteEditor();
            toast('Shared with ' + email);
        });
        view.querySelectorAll('[data-unshare]').forEach(btn => btn.addEventListener('click', () => {
            const nn = noteById(notesEditorId); if (!nn) return;
            nn.sharedWith = (nn.sharedWith || []).filter(e => e !== btn.dataset.unshare);
            nn.isShared = nn.sharedWith.length > 0; upsertNote(nn); renderNoteEditor();
        }));
        const purge = view.querySelector('#liteNotePurge');
        if (purge) purge.addEventListener('click', () => {
            const id = notesEditorId;
            notesArr = (notesArr || []).filter(x => x.id !== id);
            deleteNoteRow(id); toast('Note deleted'); notesEditorId = null; paintNotesList();
        });
    }
    function flushNoteSave() { if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; const nn = noteById(notesEditorId); if (nn) upsertNote(nn); } }
    function toLocalDatetime(iso) {
        const d = new Date(iso); if (isNaN(d.getTime())) return '';
        const pad = x => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    // Dropdown of camp members not already shared with (and not yourself).
    function shareOptionsHTML(n) {
        const shared = new Set((n.sharedWith || []).map(e => String(e).toLowerCase()));
        const me = (userEmail || '').toLowerCase();
        const eligible = (campUsers || []).filter(u => {
            const e = String(u.email || '').toLowerCase();
            return e && e !== me && !shared.has(e);
        }).sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
        if (!eligible.length) {
            return `<div class="lite-note" style="margin:0;">${(campUsers || []).length ? 'Everyone in the camp is already added.' : 'No other camp members to share with.'}</div>`;
        }
        return `<select class="lite-input lite-select" id="liteNoteShareSelect">
            <option value="">Add a camp member…</option>
            ${eligible.map(u => `<option value="${esc(u.email)}">${esc(u.name || u.email)}${u.role ? ' · ' + esc(cap(u.role)) : ''}</option>`).join('')}
        </select>`;
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
        // Dedupe on the normalized name so a bunk the schedule spells differently
        // ("Bunk לב" vs "לב") doesn't produce a second, duplicate row.
        parents.forEach(p => bunksForParent(p).forEach(b => {
            const k = normKey(b);
            if (!seen.has(k)) { seen.add(k); out.push({ parent: p, bunk: b }); }
        }));
        Object.keys((sched && sched.scheduleAssignments) || {}).forEach(b => {
            const k = normKey(b);
            if (!seen.has(k)) { seen.add(k); out.push({ parent: parentForBunk(b) || 'Other', bunk: b }); }
        });
        return out;
    }

    function minutesToHHMM(min) {
        const h = Math.floor(min / 60), m = min % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    function timeBarHTML() {
        const eff = effectiveNowMin();
        const live = nowTargetMin == null;
        return `<div class="lite-nowbar">
            <button type="button" class="lite-now-step" id="liteNowMinus" aria-label="15 minutes earlier">−15</button>
            <div class="lite-now-label">
                <div class="t">${esc(fmtMin(eff))}</div>
                <div class="s">${live ? '● Live now · tap to set a time' : 'Tap to set a time'}</div>
                <input type="time" id="liteNowPick" value="${esc(minutesToHHMM(eff))}" aria-label="Pick a time">
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
        const pick = view.querySelector('#liteNowPick');
        if (pick) pick.addEventListener('change', (e) => {
            const v = e.target.value;  // "HH:MM"
            if (!v) return;
            const [h, m] = v.split(':').map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) { nowTargetMin = clamp(h * 60 + m); rerender(); }
        });
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
                    <span class="lite-bunk-name">${esc(f)}</span>
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
    // "What's free right now / at [time]" — the on-the-go HC tool.
    async function renderAvailability(bodyEl) {
        bodyEl.innerHTML = dateStripHTML() + timeBarHTML()
            + `<div class="lite-field" style="margin-bottom:10px;">
                 <input class="lite-input" id="liteAvailSearch" type="search" placeholder="Need a court, field…? Search a facility" value="${esc(availQuery)}" autocomplete="off">
               </div>
               <div id="liteAvailBody">${loadingHTML()}</div>`;
        wireDateStrip(bodyEl, () => renderReports());
        wireTimeBar(bodyEl, () => renderReports());
        const inp = bodyEl.querySelector('#liteAvailSearch');
        inp.addEventListener('input', () => { availQuery = inp.value; paintAvail(bodyEl); });
        await paintAvail(bodyEl);
    }

    async function paintAvail(bodyEl) {
        const abody = bodyEl.querySelector('#liteAvailBody');
        if (!abody) return;
        const sched = await getSchedule(currentDate);
        if (activeTab !== 'reports' || repView !== 'avail') return;

        // facility → sorted bookings (used ∪ configured-but-empty)
        const byFac = facilityUsage(sched || {});
        facilityNames().forEach(f => { if (!byFac[f]) byFac[f] = []; });
        let facs = Object.keys(byFac).sort();
        const q = availQuery.trim().toLowerCase();
        if (q) facs = facs.filter(f => f.toLowerCase().includes(q));

        if (!facs.length) {
            abody.innerHTML = emptyHTML('', q ? 'No facility matches your search.' : 'No facilities set up yet.');
            return;
        }

        const min = effectiveNowMin();
        const free = [], busy = [];
        facs.forEach(f => {
            const books = byFac[f].slice().sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
            const cur = books.find(b => b.startMin != null && b.endMin != null && min >= b.startMin && min < b.endMin);
            if (cur) {
                busy.push({ f, occ: cur });
            } else {
                const next = books.find(b => b.startMin != null && b.startMin > min);
                free.push({ f, until: next ? next.startMin : null });
            }
        });
        free.sort((a, b) => (b.until == null) - (a.until == null) || (a.f.localeCompare(b.f)));

        const freeCards = free.length ? free.map(x => `<div class="lite-card lite-avail-card free">
                <div class="lite-avail-row">
                    <span class="lite-avail-name">📍 ${esc(x.f)}</span>
                    <span class="lite-pill green">${x.until != null ? 'free until ' + esc(fmtMin(x.until)) : 'free all day'}</span>
                </div>
            </div>`).join('') : `<div class="lite-empty" style="padding:16px;">Nothing free at ${esc(fmtMin(min))}.</div>`;

        const busyCards = busy.map(x => `<div class="lite-card lite-avail-card">
                <div class="lite-avail-row">
                    <span class="lite-avail-name">📍 ${esc(x.f)}</span>
                    <span class="lite-pill gray">opens ${esc(fmtMin(x.occ.endMin))}</span>
                </div>
                <div class="lite-slot-loc">In use — ${esc(x.occ.bunk)} · ${esc(x.occ.activity)}</div>
            </div>`).join('');

        abody.innerHTML =
            `<div class="lite-section-label" style="margin-top:2px;">✅ Free at ${esc(fmtMin(min))} · ${free.length}</div>`
            + freeCards
            + (busy.length ? `<div class="lite-section-label">In use · ${busy.length}</div>` + busyCards : '');
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

    // Content-shaped placeholders rather than a spinner: the page keeps its
    // layout while data arrives, so nothing jumps when it lands.
    function loadingHTML(rows) {
        const card = `<div class="lite-card lite-bunk-card lite-skel-card">
            <div class="lite-bunk-head"><span class="lite-skel lite-skel-line w40"></span><span class="lite-skel lite-skel-line w20"></span></div>
            ${Array.from({ length: 3 }, () => `<div class="lite-slot">
                <div class="lite-slot-time"><span class="lite-skel lite-skel-line w80"></span></div>
                <div class="lite-slot-body">
                    <span class="lite-skel lite-skel-line w60"></span>
                    <span class="lite-skel lite-skel-line w35"></span>
                </div>
            </div>`).join('')}
        </div>`;
        return `<div class="lite-skel-wrap" aria-busy="true" aria-label="Loading">${card.repeat(rows || 2)}</div>`;
    }

    function emptyHTML(icon, msg) {
        // icon param kept for call-site compatibility but no longer rendered —
        // clean text-only empty state (no emoji).
        return `<div class="lite-empty">${msg}</div>`;
    }

    let sheetEl = null;
    function openSheet(innerHTML) {
        closeSheet();
        sheetEl = document.createElement('div');
        sheetEl.className = 'lite-sheet-backdrop';
        sheetEl.innerHTML = `<div class="lite-sheet"><span class="lite-sheet-grip" aria-hidden="true"></span>${innerHTML}</div>`;
        sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet(); });
        document.body.appendChild(sheetEl);
        wireSheetDrag(sheetEl.querySelector('.lite-sheet'));
        haptic(6);
        return sheetEl;
    }

    // Drag the sheet down to dismiss — it tracks your finger and either snaps
    // back or flies out, which is the single gesture people expect from a
    // bottom sheet and its absence is what makes one feel like a web modal.
    function wireSheetDrag(sheet) {
        if (!sheet) return;
        let y0 = null, dy = 0, scrolled = 0;
        sheet.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) return;
            scrolled = sheet.scrollTop;
            y0 = e.touches[0].clientY; dy = 0;
            sheet.style.transition = 'none';
        }, { passive: true });
        sheet.addEventListener('touchmove', e => {
            if (y0 == null) return;
            dy = e.touches[0].clientY - y0;
            // Only drag when already at the top, so inner scrolling still works.
            if (scrolled > 0 || dy < 0) return;
            sheet.style.transform = `translateY(${dy}px)`;
        }, { passive: true });
        sheet.addEventListener('touchend', () => {
            if (y0 == null) return;
            sheet.style.transition = '';
            sheet.style.transform = '';
            if (scrolled === 0 && dy > 90) { haptic(6); closeSheet(); }
            y0 = null;
        });
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
