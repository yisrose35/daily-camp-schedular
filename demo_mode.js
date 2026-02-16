// =============================================================================
// demo_mode.js — CAMPISTRY OFFLINE DEMO MODE
// =============================================================================
//
// PURPOSE: Enables full offline operation for expo/demo presentations.
// Creates a mock Supabase client that intercepts ALL cloud operations
// and routes them through localStorage — the app works identically.
//
// ACTIVATION:
//   Option 1: URL parameter  →  ?demo=true   (on any page)
//   Option 2: Console        →  enableDemoMode()
//
// DEACTIVATION:
//   Option 1: URL parameter  →  ?demo=false
//   Option 2: Console        →  disableDemoMode()
//
// SETUP FOR EXPO:
//   1. While online — log in normally, configure all camp data & schedules
//   2. Visit any page with ?demo=true   (this caches the flag)
//   3. At the expo — everything works without internet!
//
// =============================================================================

(function () {
    'use strict';

    // =========================================================================
    // 1. ACTIVATION CHECK
    // =========================================================================

    const params = new URLSearchParams(window.location.search);

    if (params.get('demo') === 'true') {
        localStorage.setItem('campistry_demo_mode', 'true');
        const clean = new URL(window.location.href);
        clean.searchParams.delete('demo');
        window.history.replaceState({}, '', clean.toString());
    } else if (params.get('demo') === 'false') {
        localStorage.removeItem('campistry_demo_mode');
        const clean = new URL(window.location.href);
        clean.searchParams.delete('demo');
        window.history.replaceState({}, '', clean.toString());
        return;
    }

   let DEMO_ACTIVE = localStorage.getItem('campistry_demo_mode') === 'true';

// =====================================================================
// PORTABLE OFFLINE: Auto-enable when opened from file system (USB/folder)
// =====================================================================
const IS_FILE_PROTOCOL = window.location.protocol === 'file:';

if (IS_FILE_PROTOCOL && !DEMO_ACTIVE) {
    localStorage.setItem('campistry_demo_mode', 'true');
    DEMO_ACTIVE = true;
    console.log('📦 [Portable] file:// detected — offline mode enabled automatically');
}

if (!DEMO_ACTIVE) {
    return;
}

    // =========================================================================
    // 2. DEMO MODE IS ON — set global flag immediately
    // =========================================================================

    window.__CAMPISTRY_DEMO_MODE__ = true;

// =====================================================================
// PORTABLE OFFLINE: Auto-load offline_data.json on first run
// =====================================================================
if (window.__OFFLINE_DATA__) {
    const backup = window.__OFFLINE_DATA__;
    console.log('📦 [Portable] Loading embedded offline data...');

    if (backup.globalSettings) {
        const gs = JSON.stringify(backup.globalSettings);
        localStorage.setItem('campGlobalSettings_v1', gs);
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', gs);
        localStorage.setItem('campistryGlobalSettings', gs);
        localStorage.setItem('CAMPISTRY_UNIFIED_STATE', gs);
    }
    if (backup.dailyData) {
        localStorage.setItem('campDailyData_v1', JSON.stringify(backup.dailyData));
    }
    if (backup.rotationHistory) {
        localStorage.setItem('campRotationHistory_v1', JSON.stringify(backup.rotationHistory));
    }
    if (backup.leagueHistory) {
        localStorage.setItem('campLeagueHistory_v2', JSON.stringify(backup.leagueHistory));
    }
    if (backup.specialtyLeagueHistory) {
        localStorage.setItem('campSpecialtyLeagueHistory_v1', JSON.stringify(backup.specialtyLeagueHistory));
    }
    if (backup.skeletons) {
        Object.entries(backup.skeletons).forEach(([key, val]) => {
            localStorage.setItem(key, JSON.stringify(val));
        });
    }
    if (backup.globalSettings?.divisions) {
        localStorage.setItem('campGlobalRegistry_v1', JSON.stringify({
            divisions: backup.globalSettings.divisions,
            bunks: backup.globalSettings.bunks || backup.globalSettings.app1?.bunks || []
        }));
    }

    console.log('📦 [Portable] All data loaded!');
    delete window.__OFFLINE_DATA__;
}
console.log('%c🎭 CAMPISTRY DEMO MODE ACTIVE', 'color:#F59E0B;font-size:16px;font-weight:bold');
    console.log('%c   All data is local — no internet required.', 'color:#F59E0B');
    console.log('%c   Disable: disableDemoMode()  or  ?demo=false', 'color:#999');

    // =========================================================================
    // 3. DEMO IDENTITY (reuse existing cached IDs when possible)
    // =========================================================================

    const DEMO_USER_ID  = localStorage.getItem('campistry_auth_user_id')
                       || localStorage.getItem('campistry_user_id')
                       || 'demo-user-' + Date.now();
    const DEMO_CAMP_ID  = localStorage.getItem('campistry_camp_id') || DEMO_USER_ID;
    const DEMO_EMAIL    = 'demo@campistry.com';
    const DEMO_CAMP_NAME = (() => {
        try {
            const s = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
            return s.campName || s.camp_name || 'Demo Camp';
        } catch { return 'Demo Camp'; }
    })();

    localStorage.setItem('campistry_camp_id',      DEMO_CAMP_ID);
    localStorage.setItem('campistry_user_id',      DEMO_CAMP_ID);
    localStorage.setItem('campistry_auth_user_id', DEMO_USER_ID);
    localStorage.setItem('campistry_role',         'owner');
    localStorage.setItem('campistry_is_team_member', 'false');

    try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}

    // =========================================================================
    // DEMO MODE GUARD
    // =========================================================================

    let _demoExitAuthorized = false;

    window.addEventListener('storage', (e) => {
        if (e.key === 'campistry_demo_mode' && e.newValue !== 'true' && !_demoExitAuthorized) {
            localStorage.setItem('campistry_demo_mode', 'true');
        }
    });

    setInterval(() => {
        if (!_demoExitAuthorized && localStorage.getItem('campistry_demo_mode') !== 'true') {
            localStorage.setItem('campistry_demo_mode', 'true');
        }
    }, 1000);

    // =========================================================================
    // 4. MOCK USER & SESSION
    // =========================================================================

    const MOCK_USER = {
        id: DEMO_USER_ID,
        email: DEMO_EMAIL,
        email_confirmed_at: '2025-01-01T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: new Date().toISOString(),
        app_metadata: {},
        user_metadata: { camp_name: DEMO_CAMP_NAME },
        aud: 'authenticated',
        role: 'authenticated'
    };

    const MOCK_SESSION = {
        access_token: 'demo-access-token',
        refresh_token: 'demo-refresh-token',
        expires_in: 999999,
        expires_at: Math.floor(Date.now() / 1000) + 999999,
        token_type: 'bearer',
        user: MOCK_USER
    };

    // =========================================================================
    // 5. MOCK QUERY BUILDER  (chainable + thenable, just like real Supabase)
    // =========================================================================

    function createQueryChain(table) {
        const chain = {
            _table: table,
            _op: 'select',
            _data: null,
            _filters: {},
            _isSingle: false,
            _isMaybeSingle: false,

            select()          { chain._op = 'select';  return chain; },
            insert(d, opts)   { chain._op = 'insert';  chain._data = d; return chain; },
            upsert(d, opts)   { chain._op = 'upsert';  chain._data = d; return chain; },
            update(d)         { chain._op = 'update';  chain._data = d; return chain; },
            delete()          { chain._op = 'delete';  return chain; },

            eq(col, val)      { chain._filters[col] = val; return chain; },
            neq()             { return chain; },
            not()             { return chain; },
            in()              { return chain; },
            is()              { return chain; },
            or()              { return chain; },
            gt()              { return chain; },
            lt()              { return chain; },
            gte()             { return chain; },
            lte()             { return chain; },
            like()            { return chain; },
            ilike()           { return chain; },
            contains()        { return chain; },
            containedBy()     { return chain; },
            overlaps()        { return chain; },
            match()           { return chain; },
            filter()          { return chain; },

            order()           { return chain; },
            limit()           { return chain; },
            range()           { return chain; },
            csv()             { return chain; },
            single()          { chain._isSingle = true;      return chain; },
            maybeSingle()     { chain._isMaybeSingle = true;  return chain; },

            then(resolve, reject) {
                try {
                    const result = resolveMockQuery(chain);
                    return Promise.resolve(result).then(resolve, reject);
                } catch (e) {
                    return Promise.reject(e).then(resolve, reject);
                }
            }
        };
        return chain;
    }

    // =========================================================================
    // 6. QUERY RESOLUTION — returns table-appropriate mock data
    // =========================================================================

    function resolveMockQuery(chain) {
        const { _table, _op, _data, _filters, _isSingle, _isMaybeSingle } = chain;

        // --- WRITES: just succeed, return the payload ---
        if (_op === 'insert' || _op === 'upsert' || _op === 'update') {
            const rows = _data ? (Array.isArray(_data) ? _data : [_data]) : [];
            return { data: rows, error: null, count: rows.length };
        }
        if (_op === 'delete') {
            return { data: [], error: null };
        }

        // --- READS: return table-specific data from localStorage ---
        let rows = [];

        switch (_table) {

            // ·····························································
            // CAMPS — make the demo user appear as camp owner
            // ·····························································
            case 'camps': {
                if (_filters.owner === DEMO_USER_ID || _filters.id === DEMO_CAMP_ID) {
                    rows = [{
                        id: DEMO_CAMP_ID,
                        name: DEMO_CAMP_NAME,
                        owner: DEMO_USER_ID,
                        owner_name: 'Demo Director',
                        created_at: '2025-01-01T00:00:00Z'
                    }];
                }
                break;
            }

            // ·····························································
            // CAMP_USERS — no team members (user is owner, not invitee)
            // ·····························································
            case 'camp_users': {
                rows = [];   // owner, not a team member
                break;
            }

            // ·····························································
            // CAMP_STATE — return localStorage global settings
            // ·····························································
            case 'camp_state': {
                try {
                    const raw = localStorage.getItem('campGlobalSettings_v1');
                    const state = raw ? JSON.parse(raw) : {};
                    rows = [{
                        camp_id: DEMO_CAMP_ID,
                        state: state,
                        updated_at: state.updated_at || new Date().toISOString()
                    }];
                } catch {
                    rows = [{ camp_id: DEMO_CAMP_ID, state: {}, updated_at: new Date().toISOString() }];
                }
                break;
            }

            // ·····························································
            // DAILY_SCHEDULES — return localStorage schedule for queried date
            // ·····························································
            case 'daily_schedules': {
                try {
                    const allDaily = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    const dateKey  = _filters.date_key;

                    if (dateKey && allDaily[dateKey]) {
                        const d = allDaily[dateKey];
                        rows = [{
                            camp_id: DEMO_CAMP_ID,
                            date_key: dateKey,
                            scheduler_id: DEMO_USER_ID,
                            scheduler_name: 'Demo Director',
                            divisions: Object.keys(window.divisions || {}),
                            schedule_data: {
                                scheduleAssignments: d.scheduleAssignments || {},
                                leagueAssignments:  d.leagueAssignments  || {},
                                unifiedTimes:       d.unifiedTimes       || [],
                                divisionTimes:      d.divisionTimes      || {},
                                slotCount:          (d.unifiedTimes || []).length
                            },
                            unified_times: d.unifiedTimes || [],
                            is_rainy_day:  d.isRainyDay || false,
                            updated_at:    d.savedAt || d._updatedAt || new Date().toISOString()
                        }];
                    }
                } catch (e) {
                    console.warn('[Demo] Error reading daily data:', e);
                }
                break;
            }

            // ·····························································
            // FIELD_LOCKS
            // ·····························································
            case 'field_locks': {
                rows = [];
                break;
            }

            // ·····························································
            // ★ FIX #1: SUBDIVISIONS — used by access_control.js &
            // team_subdivisions_ui.js for dashboard Divisions & Team cards.
            // Previously missing — queries fell through to default: []
            // which meant AccessControl loaded 0 subdivisions in demo mode.
            // Auto-generates from camp division structure if none saved.
            // ·····························································
            case 'subdivisions': {
                try {
                    const settings = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
                    let subs = settings.subdivisions || [];
                    if (subs.length === 0) {
                        const divNames = Object.keys(settings.divisions || settings.campStructure || {});
                        if (divNames.length > 0) {
                            const colors = ['#7C3AED','#2563EB','#059669','#D97706','#DC2626','#8B5CF6','#0891B2','#65A30D'];
                            subs = [{
                                id: 'demo-sub-all',
                                camp_id: DEMO_CAMP_ID,
                                name: 'All Divisions',
                                divisions: divNames,
                                color: colors[0],
                                created_at: '2025-01-01T00:00:00Z'
                            }];
                        }
                    } else {
                        subs = subs.map((s, i) => ({
                            ...s,
                            camp_id: s.camp_id || DEMO_CAMP_ID,
                            id: s.id || ('demo-sub-' + i)
                        }));
                    }
                    rows = subs;
                } catch { rows = []; }
                break;
            }

            // ·····························································
            // CAMP_SUBDIVISIONS (legacy alias)
            // ·····························································
            case 'camp_subdivisions': {
                try {
                    const settings = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
                    rows = settings.subdivisions || [];
                } catch { rows = []; }
                break;
            }

            // ·····························································
            // ★ FIX #2: SCHEDULE_VERSIONS — return mock version data for
            // post-edit verification queries. Previously returned [] which
            // with .single() produced PGRST116 "not found" error popup.
            // Now returns real data from localStorage so verification passes.
            // ·····························································
            case 'schedule_versions': {
                try {
                    const dateKey = _filters.date_key;
                    if (dateKey) {
                        const allDaily = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                        const d = allDaily[dateKey];
                        if (d) {
                            rows = [{
                                camp_id: DEMO_CAMP_ID,
                                date_key: dateKey,
                                scheduler_id: _filters.scheduler_id || DEMO_USER_ID,
                                scheduler_name: 'Demo Director',
                                schedule_data: {
                                    scheduleAssignments: d.scheduleAssignments || {},
                                    leagueAssignments: d.leagueAssignments || {},
                                    unifiedTimes: d.unifiedTimes || [],
                                    divisionTimes: d.divisionTimes || {}
                                },
                                updated_at: d._postEditAt
                                    ? new Date(d._postEditAt).toISOString()
                                    : (d.savedAt || new Date().toISOString())
                            }];
                        }
                    }
                } catch (e) {
                    console.warn('[Demo] Error reading schedule_versions:', e);
                }
                break;
            }

            // ·····························································
            // NOTIFICATIONS — return empty (no pending notifications in demo)
            // ·····························································
            case 'notifications': {
                rows = [];
                break;
            }

            // ·····························································
            // SCHEDULE_PROPOSALS — return empty
            // ·····························································
            case 'schedule_proposals': {
                rows = [];
                break;
            }

            // ·····························································
            // ANY OTHER TABLE — empty
            // ·····························································
            default:
                rows = [];
        }

        // --- Apply single/maybeSingle modifiers ---
        if (_isSingle) {
            return { data: rows[0] || null, error: rows.length === 0 ? { code: 'PGRST116', message: 'not found' } : null };
        }
        if (_isMaybeSingle) {
            return { data: rows[0] || null, error: null };
        }
        return { data: rows, error: null };
    }

    // =========================================================================
    // 7. MOCK REALTIME CHANNEL
    // =========================================================================

    function createMockChannel(name) {
        const ch = {
            _name: name,
            on()          { return ch; },
            subscribe(cb) {
                if (typeof cb === 'function') setTimeout(() => cb('SUBSCRIBED'), 50);
                return ch;
            },
            unsubscribe() { return Promise.resolve('ok'); },
            send()        { return Promise.resolve('ok'); }
        };
        return ch;
    }

    // =========================================================================
    // 8. MOCK SUPABASE CLIENT (the full mock that supabase_client.js will use)
    // =========================================================================

    const _authChangeCallbacks = [];

    const MOCK_CLIENT = {
        auth: {
            getSession() {
                return Promise.resolve({ data: { session: MOCK_SESSION }, error: null });
            },
            getUser() {
                return Promise.resolve({ data: { user: MOCK_USER }, error: null });
            },
            onAuthStateChange(callback) {
                if (typeof callback === 'function') _authChangeCallbacks.push(callback);
                return {
                    data: {
                        subscription: {
                            id: 'demo-sub',
                            unsubscribe: () => {}
                        }
                    }
                };
            },
            signInWithPassword({ email, password }) {
                return Promise.resolve({ data: { user: MOCK_USER, session: MOCK_SESSION }, error: null });
            },
            signUp({ email, password, options }) {
                return Promise.resolve({ data: { user: MOCK_USER, session: MOCK_SESSION }, error: null });
            },
            signOut() {
                window.location.href = 'dashboard.html';
                return Promise.resolve({ error: null });
            },
            updateUser(updates) {
                return Promise.resolve({ data: { user: { ...MOCK_USER, ...updates } }, error: null });
            },
            resetPasswordForEmail() {
                return Promise.resolve({ data: {}, error: null });
            },
            refreshSession() {
                return Promise.resolve({ data: { session: MOCK_SESSION }, error: null });
            }
        },

        from(table) {
            return createQueryChain(table);
        },

        channel(name) {
            return createMockChannel(name);
        },
        removeChannel()     { return Promise.resolve('ok'); },
        removeAllChannels() { return Promise.resolve('ok'); },
        getChannels()       { return []; },

        storage: {
            from() {
                return {
                    upload:   () => Promise.resolve({ data: { path: 'demo' }, error: null }),
                    download: () => Promise.resolve({ data: new Blob(), error: null }),
                    remove:   () => Promise.resolve({ data: [], error: null }),
                    list:     () => Promise.resolve({ data: [], error: null }),
                    getPublicUrl() { return { data: { publicUrl: '' } }; }
                };
            }
        }
    };

    // =========================================================================
    // 9. INSTALL MOCK — protect window.supabase so the CDN can't overwrite it
    // =========================================================================

    let _demoSupabase = {
        createClient(url, key, opts) {
            console.log('🎭 [Demo] Mock Supabase client created (offline mode)');
            return MOCK_CLIENT;
        }
    };

    Object.defineProperty(window, 'supabase', {
        configurable: true,
        enumerable: true,
        get() {
            return _demoSupabase;
        },
        set(val) {
            if (val && typeof val.auth === 'object' && typeof val.from === 'function') {
                _demoSupabase = val;
                return;
            }
            console.log('🎭 [Demo] Blocked CDN overwrite of window.supabase');
        }
    });

    // =========================================================================
    // 10. INTERCEPT fetch() FOR SUPABASE REST CALLS
    // =========================================================================

    const _originalFetch = window.fetch;
    window.fetch = function (url, options) {
        if (typeof url === 'string' && url.includes('supabase.co')) {
            const body = JSON.stringify([]);
            return Promise.resolve(new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }
        return _originalFetch.call(this, url, options).catch(err => {
            console.warn('🎭 [Demo] Fetch failed (offline):', typeof url === 'string' ? url.substring(0, 80) : 'request');
            return new Response('', { status: 0, statusText: 'offline' });
        });
    };

    // =========================================================================
    // 11. AUTO-REDIRECT: Skip login page in demo mode
    // =========================================================================

    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    if (currentPage === 'index.html' || currentPage === '') {
        console.log('🎭 [Demo] Skipping login, redirecting to dashboard...');
        window.location.href = 'dashboard.html';
        return;
    }

    // =========================================================================
    // 12. FULLSCREEN KIOSK MODE
    // =========================================================================

    function enterFullscreen() {
        const el = document.documentElement;
        const rfs = el.requestFullscreen
                 || el.webkitRequestFullscreen
                 || el.mozRequestFullScreen
                 || el.msRequestFullscreen;
        if (rfs) {
            rfs.call(el).catch(() => {
                console.log('🎭 [Demo] Fullscreen needs user gesture, will retry on click');
            });
        }
    }

    function setupFullscreenKiosk() {
        const goFull = () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                enterFullscreen();
            }
        };
        ['click', 'touchstart', 'keydown', 'mousemove', 'mousedown', 'scroll'].forEach(evt => {
            document.addEventListener(evt, goFull, { passive: true });
        });
        goFull();
    }

    // =========================================================================
    // 13. PASSWORD-PROTECTED EXIT
    // =========================================================================

    const DEMO_EXIT_PASSWORD = 'JewishCamPExpo2026';

    function promptDemoExit() {
        const overlay = document.createElement('div');
        overlay.id = 'demo-exit-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:999999; background:rgba(0,0,0,0.6); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; font-family:Inter,system-ui,sans-serif;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background:white; border-radius:16px; padding:32px; width:360px; box-shadow:0 20px 60px rgba(0,0,0,0.3); text-align:center;';
        modal.innerHTML = '<div style="font-size:2rem;margin-bottom:12px">🔒</div>' +
            '<h3 style="margin:0 0 8px;color:#1E293B;font-size:1.1rem">Exit Demo Mode</h3>' +
            '<p style="margin:0 0 20px;color:#64748B;font-size:0.9rem">Enter the password to exit demo mode.</p>' +
            '<input id="demo-exit-pw" type="password" placeholder="Password" autocomplete="off" style="width:100%; padding:10px 14px; border:2px solid #E2E8F0; border-radius:10px; font-size:1rem; outline:none; box-sizing:border-box; transition:border-color 0.2s;" />' +
            '<p id="demo-exit-error" style="color:#EF4444;font-size:0.85rem;margin:8px 0 0;min-height:1.2em"></p>' +
            '<div style="display:flex;gap:10px;margin-top:16px">' +
            '<button id="demo-exit-cancel" style="flex:1; padding:10px; border:1px solid #E2E8F0; background:#F8FAFC; border-radius:10px; cursor:pointer; font-size:0.9rem; color:#64748B;">Cancel</button>' +
            '<button id="demo-exit-confirm" style="flex:1; padding:10px; border:none; background:#EF4444; border-radius:10px; cursor:pointer; font-size:0.9rem; color:white; font-weight:600;">Exit Demo</button>' +
            '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const pwInput = document.getElementById('demo-exit-pw');
        const errorEl = document.getElementById('demo-exit-error');

        pwInput.focus();
        pwInput.addEventListener('focus', () => { pwInput.style.borderColor = '#3B82F6'; });
        pwInput.addEventListener('blur', () => { pwInput.style.borderColor = '#E2E8F0'; });

        function tryExit() {
            if (pwInput.value === DEMO_EXIT_PASSWORD) {
                overlay.remove();
                _demoExitAuthorized = true;
                localStorage.removeItem('campistry_demo_mode');
                try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
                if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
               console.log('🎭 Demo mode disabled. Closing...');
                window.close();
                setTimeout(() => { window.location.reload(); }, 500);
            } else {
                errorEl.textContent = 'Incorrect password';
                pwInput.value = '';
                pwInput.style.borderColor = '#EF4444';
                pwInput.focus();
                setTimeout(() => { errorEl.textContent = ''; pwInput.style.borderColor = '#E2E8F0'; }, 2000);
            }
        }

        document.getElementById('demo-exit-confirm').addEventListener('click', tryExit);
        pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryExit(); });
        document.getElementById('demo-exit-cancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // =========================================================================
    // 14. VISUAL DEMO MODE INDICATOR
    // =========================================================================

    function addDemoBanner() {
        if (document.getElementById('campistry-demo-banner')) return;

        const banner = document.createElement('div');
        banner.id = 'campistry-demo-banner';
        banner.innerHTML = '<span style="margin-right:8px">🎭</span>' +
            '<span><strong>DEMO MODE</strong> — Offline · All data stored locally</span>' +
            '<button id="demo-reset-btn" title="Reset to original data" style="margin-left:auto; background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.3); color:white; padding:2px 10px; border-radius:4px; cursor:pointer; font-size:12px; margin-right:8px;">🔄 Reset</button>' +
            '<button id="demo-exit-btn" title="Exit demo mode" style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.3); color:white; padding:2px 10px; border-radius:4px; cursor:pointer; font-size:12px;">Exit Demo</button>';
        banner.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:99999; background:linear-gradient(135deg,#F59E0B,#D97706); color:white; padding:6px 16px; font-family:Inter,system-ui,sans-serif; font-size:13px; display:flex; align-items:center; box-shadow:0 2px 8px rgba(0,0,0,0.15);';
        document.body.prepend(banner);

        document.body.style.paddingTop = (banner.offsetHeight) + 'px';

    document.getElementById('demo-reset-btn')?.addEventListener('click', () => {
        if (!confirm('Reset all data back to the original? This cannot be undone.')) return;
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (
                key.startsWith('camp') ||
                key.startsWith('CAMPISTRY') ||
                key.startsWith('schedule') ||
                key.startsWith('campistry')
            )) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        localStorage.setItem('campistry_demo_mode', 'true');
        console.log('📦 Cleared', keysToRemove.length, 'keys. Reloading...');
        window.location.reload();
    });

    document.getElementById('demo-exit-btn')?.addEventListener('click', () => {
        promptDemoExit();
    });

        setupFullscreenKiosk();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addDemoBanner);
    } else {
        addDemoBanner();
    }

    // =========================================================================
    // 15. PATCH SYNC STATUS — always show "synced" in demo mode
    // =========================================================================

    window.addEventListener('campistry-sync-ready', () => {
        const dot  = document.querySelector('.sync-dot, #syncDot');
        const text = document.querySelector('#syncText');
        if (dot)  { dot.style.background = '#10B981'; dot.classList.remove('syncing', 'error'); }
        if (text) { text.textContent = 'Demo Mode'; }
    });

    const _origGetSyncStatus = () => ({
        status: 'idle', isOnline: true, lastSync: Date.now(),
        queueLength: 0, initialHydrationDone: true,
        subscriptionActive: true, isSubscribed: true
    });

    Object.defineProperty(window, 'ScheduleSync', {
        configurable: true,
        set(val) {
            if (val && typeof val === 'object') {
                val.getSyncStatus = _origGetSyncStatus;
                val.isOnline = () => true;
            }
            Object.defineProperty(window, 'ScheduleSync', {
                value: val, writable: true, configurable: true
            });
        },
        get() { return undefined; }
    });

    // =========================================================================
    // 16. PATCH navigator.onLine
    // =========================================================================

    Object.defineProperty(navigator, 'onLine', {
        get: () => true,
        configurable: true
    });

    // =========================================================================
    // 17. GLOBAL UTILITY FUNCTIONS
    // =========================================================================

    window.enableDemoMode = function () {
        localStorage.setItem('campistry_demo_mode', 'true');
        try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
        console.log('🎭 Demo mode enabled. Reloading...');
        window.location.reload();
    };

    window.disableDemoMode = function () {
        promptDemoExit();
    };

    window.loadDemoData = function (backup) {
        if (!backup) {
            console.error('Usage: loadDemoData({ globalSettings: {...}, dailyData: {...}, ... })');
            return;
        }
        try {
            if (backup.globalSettings) {
                localStorage.setItem('campGlobalSettings_v1', JSON.stringify(backup.globalSettings));
                localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(backup.globalSettings));
                console.log('✅ Global settings loaded');
            }
            if (backup.dailyData) {
                localStorage.setItem('campDailyData_v1', JSON.stringify(backup.dailyData));
                console.log('✅ Daily schedule data loaded (' + Object.keys(backup.dailyData).length + ' dates)');
            }
            if (backup.rotationHistory) {
                localStorage.setItem('campRotationHistory_v1', JSON.stringify(backup.rotationHistory));
            }
            if (backup.smartTileHistory) {
                localStorage.setItem('campSmartTileHistory_v1', JSON.stringify(backup.smartTileHistory));
            }
            if (backup.leagueHistory) {
                localStorage.setItem('campLeagueHistory_v1', JSON.stringify(backup.leagueHistory));
            }
            if (backup.specialtyLeagueHistory) {
                localStorage.setItem('campSpecialtyLeagueHistory_v1', JSON.stringify(backup.specialtyLeagueHistory));
            }
            console.log('🎭 Demo data loaded! Refresh the page to see it.');
        } catch (e) {
            console.error('Failed to load demo data:', e);
        }
    };

    window.demoStatus = function () {
        const globalRaw = localStorage.getItem('campGlobalSettings_v1');
        const dailyRaw  = localStorage.getItem('campDailyData_v1');
        const global = globalRaw ? JSON.parse(globalRaw) : {};
        const daily  = dailyRaw  ? JSON.parse(dailyRaw)  : {};

        console.log('═══════════════════════════════════════════');
        console.log('🎭 CAMPISTRY DEMO MODE STATUS');
        console.log('═══════════════════════════════════════════');
        console.log('Active:       ', DEMO_ACTIVE);
        console.log('Fullscreen:   ', !!document.fullscreenElement || !!document.webkitFullscreenElement);
        console.log('User ID:      ', DEMO_USER_ID);
        console.log('Camp ID:      ', DEMO_CAMP_ID);
        console.log('Camp Name:    ', DEMO_CAMP_NAME);
        console.log('Divisions:    ', Object.keys(global.divisions || global.campStructure || {}).length);
        console.log('Activities:   ', Object.keys(global.activityProperties || global.app1?.activityProperties || {}).length);
        console.log('Scheduled Days:', Object.keys(daily).length);
        console.log('Page:         ', currentPage);
        console.log('═══════════════════════════════════════════');
        console.log('Commands:  disableDemoMode()  |  demoStatus()  |  loadDemoData(json)');
    };

// =====================================================================
    // PORTABLE OFFLINE: Fix absolute links to use relative paths
    // =====================================================================
    function fixAbsoluteLinks() {
        document.querySelectorAll('a').forEach(a => {
            const href = a.getAttribute('href');
            if (href && href.includes('campistry.org/')) {
                const filename = href.split('/').pop();
                a.setAttribute('href', filename);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fixAbsoluteLinks);
    } else {
        fixAbsoluteLinks();
    }

    // =========================================================================
    // 18. OFFLINE SAFETY NET — Ensure all init events fire even if SDK fails
    // =========================================================================
    // When offline (not file:// protocol, e.g. cached PWA or service worker),
    // the Supabase CDN script fails to load. flow.html and campistry_me.html
    // chain supabase_client.js to load only AFTER the CDN script succeeds,
    // so supabase_client.js never loads, CampistryDB never inits, and every
    // downstream system hangs waiting for 'campistry-db-ready'.
    // This safety net detects that condition and bootstraps everything.
    // =========================================================================

    function ensureOfflineBootstrap() {
        const BOOT_TIMEOUT = 4000;

        setTimeout(() => {
            // If CampistryDB already initialized normally, nothing to do
            if (window.CampistryDB?.isInitialized?.()) {
                console.log('🎭 [Demo] CampistryDB initialized normally — safety net not needed');
                return;
            }

            console.warn('🎭 [Demo] CampistryDB not initialized after ' + BOOT_TIMEOUT + 'ms — activating offline safety net');

            // ── Step 1: Ensure window.supabase points to MOCK_CLIENT ──
            // The property may still be the {createClient} wrapper if the
            // CDN never loaded and supabase_client.js never called createClient.
            if (!window.supabase || !window.supabase.auth) {
                if (window.supabase && typeof window.supabase.createClient === 'function') {
                    const mockClient = window.supabase.createClient('', '');
                    try {
                        Object.defineProperty(window, 'supabase', {
                            configurable: true, enumerable: true,
                            value: mockClient, writable: true
                        });
                    } catch (e) {
                        window.supabase = mockClient;
                    }
                    console.log('🎭 [Demo] Resolved mock client from createClient()');
                }
            }

            // ── Step 2: Bootstrap CampistryDB if missing or uninitialized ──
            if (!window.CampistryDB) {
                window.CampistryDB = {
                    client: window.supabase || null,
                    initialize: () => Promise.resolve(true),
                    refresh: () => Promise.resolve({ campId: DEMO_CAMP_ID, role: 'owner' }),
                    ready: Promise.resolve(true),
                    isInitialized: () => true,
                    getClient: () => window.supabase || null,
                    getCampId: () => DEMO_CAMP_ID,
                    getUserId: () => DEMO_USER_ID,
                    getSession: () => MOCK_SESSION,
                    getAccessToken: () => Promise.resolve('demo-access-token'),
                    getRole: () => 'owner',
                    isRoleVerified: () => true,
                    isOwner: () => true,
                    isAdmin: () => true,
                    isTeamMember: () => false,
                    isAuthenticated: () => true,
                    onAuthChange: () => {},
                    rawQuery: () => Promise.resolve(null),
                    config: Object.freeze({})
                };
                console.log('🎭 [Demo] Created fallback CampistryDB');
            } else if (!window.CampistryDB.isInitialized?.()) {
                // CampistryDB object exists but never finished init — patch it
                if (!window.CampistryDB.getCampId?.()) {
                    window.CampistryDB.getCampId = () => DEMO_CAMP_ID;
                }
                if (!window.CampistryDB.getUserId?.()) {
                    window.CampistryDB.getUserId = () => DEMO_USER_ID;
                }
                if (!window.CampistryDB.getRole?.() || window.CampistryDB.getRole() === 'viewer') {
                    window.CampistryDB.getRole = () => 'owner';
                }
                window.CampistryDB.isRoleVerified = () => true;
                console.log('🎭 [Demo] Patched existing CampistryDB with demo values');
            }

            // ── Step 3: Fire campistry-db-ready ──
            window.dispatchEvent(new CustomEvent('campistry-db-ready', {
                detail: { campId: DEMO_CAMP_ID, role: 'owner', isTeamMember: false, roleVerified: true }
            }));

            // ── Step 4: Force cloud hydration from localStorage ──
            setTimeout(() => {
                if (!window.__CAMPISTRY_CLOUD_READY__) {
                    try {
                        const raw = localStorage.getItem('campGlobalSettings_v1');
                        if (raw) {
                            const settings = JSON.parse(raw);
                            window.divisions = settings.divisions || settings.campStructure || {};
                            window.globalBunks = settings.bunks || settings.app1?.bunks || [];
                            window.availableDivisions = Object.keys(window.divisions);
                        }
                    } catch (e) {
                        console.warn('🎭 [Demo] Hydration error:', e);
                    }
                    window.__CAMPISTRY_CLOUD_READY__ = true;
                    window.__CAMPISTRY_HYDRATED__ = true;
                    window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated'));
                    console.log('🎭 [Demo] Cloud hydration forced from localStorage');
                }
            }, 500);

            // ── Step 5: Fire ScheduleDB ready ──
            setTimeout(() => {
                if (!window.ScheduleDB?.isInitialized) {
                    window.dispatchEvent(new CustomEvent('campistry-scheduledb-ready'));
                    console.log('🎭 [Demo] ScheduleDB ready forced');
                }
            }, 800);

            // ── Step 6: Fire RBAC events ──
            setTimeout(() => {
                if (!window.AccessControl?.isInitialized) {
                    window.dispatchEvent(new CustomEvent('rbac-system-ready', {
                        detail: { role: 'owner', isOwner: true }
                    }));
                    window.dispatchEvent(new CustomEvent('campistry-rbac-ready', {
                        detail: { role: 'owner', isOwner: true }
                    }));
                    console.log('🎭 [Demo] RBAC events forced');
                }
            }, 1000);

            // ── Step 7: Last resort — force-show app if loading screen stuck ──
            setTimeout(() => {
                const loadingScreen = document.getElementById('auth-loading-screen');
                const mainApp = document.getElementById('main-app-container') ||
                               document.getElementById('main-content');

                if (loadingScreen && getComputedStyle(loadingScreen).display !== 'none') {
                    console.warn('🎭 [Demo] Loading screen still visible after 6s — force-showing app');
                    loadingScreen.style.display = 'none';
                    if (mainApp) mainApp.style.display = 'block';
                    window.__CAMPISTRY_BOOTED__ = true;
                    window.refreshGlobalRegistry?.();
                    window.initCalendar?.();
                    window.initApp1?.();
                    window.initLeagues?.();
                    window.initScheduleSystem?.();
                    window.initDailyAdjustments?.();
                }
            }, 6000);

        }, BOOT_TIMEOUT);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureOfflineBootstrap);
    } else {
        ensureOfflineBootstrap();
    }

    console.log('🎭 Demo mode ready. Run demoStatus() for details.');

})();
