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
        // Clean the URL so ?demo=true doesn't stick around
        const clean = new URL(window.location.href);
        clean.searchParams.delete('demo');
        window.history.replaceState({}, '', clean.toString());
    } else if (params.get('demo') === 'false') {
        localStorage.removeItem('campistry_demo_mode');
        const clean = new URL(window.location.href);
        clean.searchParams.delete('demo');
        window.history.replaceState({}, '', clean.toString());
        // Not in demo mode — exit immediately
        return;
    }

   let DEMO_ACTIVE = localStorage.getItem('campistry_demo_mode') === 'true';

// =====================================================================
// PORTABLE OFFLINE: Auto-enable when opened from file system (USB/folder)
// This ONLY runs when protocol is file:// — never on https://
// =====================================================================
const IS_FILE_PROTOCOL = window.location.protocol === 'file:';

if (IS_FILE_PROTOCOL && !DEMO_ACTIVE) {
    localStorage.setItem('campistry_demo_mode', 'true');
    DEMO_ACTIVE = true;
    console.log('📦 [Portable] file:// detected — offline mode enabled automatically');
}

if (!DEMO_ACTIVE) {
    // Not in demo mode — this script does nothing
    return;
}

    // =========================================================================
    // 2. DEMO MODE IS ON — set global flag immediately
    // =========================================================================

    window.__CAMPISTRY_DEMO_MODE__ = true;

// =====================================================================
// PORTABLE OFFLINE: Auto-load offline_data.json on first run
// Only runs on file:// AND only if localStorage is empty
// =====================================================================
if (IS_FILE_PROTOCOL && !localStorage.getItem('campGlobalSettings_v1')) {
    (async function() {
        try {
            const pagePath = window.location.pathname;
            const dir = pagePath.substring(0, pagePath.lastIndexOf('/') + 1);
            const dataUrl = 'file://' + dir + 'offline_data.json';

            console.log('📦 [Portable] Loading offline_data.json...');
            const resp = await fetch(dataUrl);
            if (!resp.ok) throw new Error('Not found');
            const backup = await resp.json();

            // ★ Write to ALL keys the app reads from
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

            console.log('📦 [Portable] All data loaded! Refreshing...');
            window.location.reload();
        } catch (e) {
            console.warn('📦 [Portable] No offline_data.json found — starting empty');
        }
    })();
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

    // Ensure localStorage cache keys are populated (so app doesn't redirect)
    localStorage.setItem('campistry_camp_id',      DEMO_CAMP_ID);
    localStorage.setItem('campistry_user_id',      DEMO_CAMP_ID);
    localStorage.setItem('campistry_auth_user_id', DEMO_USER_ID);
    localStorage.setItem('campistry_role',         'owner');
    localStorage.setItem('campistry_is_team_member', 'false');

    // ★★★ Clear RBAC session cache so real-mode context doesn't bleed into demo ★★★
    try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}

    // =========================================================================
    // DEMO MODE GUARD — prevent casual console disabling
    // Re-writes the flag if someone removes it via localStorage directly.
    // Only the password modal can truly exit (it sets a bypass flag first).
    // =========================================================================

    let _demoExitAuthorized = false;

    window.addEventListener('storage', (e) => {
        if (e.key === 'campistry_demo_mode' && e.newValue !== 'true' && !_demoExitAuthorized) {
            localStorage.setItem('campistry_demo_mode', 'true');
        }
    });

    // Polling fallback (same-tab storage changes don't fire the event)
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

            // ---- Operation starters ----
            select()          { chain._op = 'select';  return chain; },
            insert(d, opts)   { chain._op = 'insert';  chain._data = d; return chain; },
            upsert(d, opts)   { chain._op = 'upsert';  chain._data = d; return chain; },
            update(d)         { chain._op = 'update';  chain._data = d; return chain; },
            delete()          { chain._op = 'delete';  return chain; },

            // ---- Filters (all are pass-through for the mock) ----
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

            // ---- Modifiers ----
            order()           { return chain; },
            limit()           { return chain; },
            range()           { return chain; },
            csv()             { return chain; },
            single()          { chain._isSingle = true;      return chain; },
            maybeSingle()     { chain._isMaybeSingle = true;  return chain; },

            // ---- Thenable (makes `await` and `.then()` work) ----
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
                // Return empty locks (or we could persist them in LS)
                rows = [];
                break;
            }

            // ·····························································
            // CAMP_SUBDIVISIONS
            // ·····························································
            case 'camp_subdivisions': {
                try {
                    const settings = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
                    rows = settings.subdivisions || [];
                } catch { rows = []; }
                break;
            }

            // ·····························································
            // SCHEDULE_VERSIONS
            // ·····························································
            case 'schedule_versions': {
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
                // Simulate successful subscription
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
        // ---- AUTH ----
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
                // In demo mode, "sign out" just goes back to dashboard
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

        // ---- DATABASE ----
        from(table) {
            return createQueryChain(table);
        },

        // ---- REALTIME ----
        channel(name) {
            return createMockChannel(name);
        },
        removeChannel()     { return Promise.resolve('ok'); },
        removeAllChannels() { return Promise.resolve('ok'); },
        getChannels()       { return []; },

        // ---- STORAGE (if ever needed) ----
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
    //
    // The Supabase CDN <script> tag stays as-is in the HTML (no document.write).
    // We use Object.defineProperty so that:
    //   - Our mock is returned when anything reads `window.supabase`
    //   - The CDN's attempt to set `window.supabase = factory` is silently ignored
    //   - supabase_client.js's `window.supabase = _client` is accepted (it's our mock)
    //
    // When offline at the expo, the CDN script fails to load (harmless console
    // error) but the mock is already in place so the app works perfectly.
    //

    let _demoSupabase = {
        createClient(url, key, opts) {
            console.log('🎭 [Demo] Mock Supabase client created (offline mode)');
            // After this, supabase_client.js sets window.supabase = _client
            // which triggers our setter below with the MOCK_CLIENT value.
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
            // Accept writes that look like an initialized client (from supabase_client.js)
            // These have .auth (object) and .from (function) — i.e. MOCK_CLIENT
            if (val && typeof val.auth === 'object' && typeof val.from === 'function') {
                _demoSupabase = val;
                return;
            }
            // Silently ignore everything else (CDN trying to overwrite with factory)
            console.log('🎭 [Demo] Blocked CDN overwrite of window.supabase');
        }
    });

    // =========================================================================
    // 10. INTERCEPT fetch() FOR SUPABASE REST CALLS (rawQuery uses fetch)
    // =========================================================================

    const _originalFetch = window.fetch;
    window.fetch = function (url, options) {
        if (typeof url === 'string' && url.includes('supabase.co')) {
            // Return an empty successful response
            const body = JSON.stringify([]);
            return Promise.resolve(new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }
        // Non-Supabase URLs: use real fetch (or fail gracefully offline)
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
        // On the landing/login page — skip straight to dashboard
        console.log('🎭 [Demo] Skipping login, redirecting to dashboard...');
        window.location.href = 'dashboard.html';
        return; // Stop further execution of this script
    }

    // =========================================================================
    // 12. FULLSCREEN KIOSK MODE — hide browser chrome for expo presentations
    // =========================================================================

    function enterFullscreen() {
        const el = document.documentElement;
        const rfs = el.requestFullscreen
                 || el.webkitRequestFullscreen
                 || el.mozRequestFullScreen
                 || el.msRequestFullscreen;
        if (rfs) {
            rfs.call(el).catch(() => {
                // Fullscreen requires user gesture — we'll retry on first click
                console.log('🎭 [Demo] Fullscreen needs user gesture, will retry on click');
            });
        }
    }

    function setupFullscreenKiosk() {
        // Try immediately (works if already had a gesture)
        enterFullscreen();

        // Also retry on first user interaction (browsers require a gesture)
        const onFirstInteraction = () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                enterFullscreen();
            }
            document.removeEventListener('click', onFirstInteraction);
            document.removeEventListener('touchstart', onFirstInteraction);
            document.removeEventListener('keydown', onFirstInteraction);
        };
        document.addEventListener('click', onFirstInteraction);
        document.addEventListener('touchstart', onFirstInteraction);
        document.addEventListener('keydown', onFirstInteraction);

        // Re-enter fullscreen if user accidentally exits (e.g. Escape key)
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement && DEMO_ACTIVE) {
                // Small delay then re-enter — prevents rapid toggle
                setTimeout(() => {
                    if (!document.fullscreenElement && DEMO_ACTIVE) {
                        enterFullscreen();
                    }
                }, 500);
            }
        });
        document.addEventListener('webkitfullscreenchange', () => {
            if (!document.webkitFullscreenElement && DEMO_ACTIVE) {
                setTimeout(() => {
                    if (!document.webkitFullscreenElement && DEMO_ACTIVE) {
                        enterFullscreen();
                    }
                }, 500);
            }
        });
    }

    // =========================================================================
    // 13. PASSWORD-PROTECTED EXIT
    // =========================================================================

    const DEMO_EXIT_PASSWORD = 'JewishCamPExpo2026';

    function promptDemoExit() {
        // Build a custom modal instead of using prompt() (which is blocked in fullscreen)
        const overlay = document.createElement('div');
        overlay.id = 'demo-exit-overlay';
        overlay.style.cssText = `
            position:fixed; inset:0; z-index:999999;
            background:rgba(0,0,0,0.6); backdrop-filter:blur(4px);
            display:flex; align-items:center; justify-content:center;
            font-family:Inter,system-ui,sans-serif;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background:white; border-radius:16px; padding:32px; width:360px;
            box-shadow:0 20px 60px rgba(0,0,0,0.3); text-align:center;
        `;
        modal.innerHTML = `
            <div style="font-size:2rem;margin-bottom:12px">🔒</div>
            <h3 style="margin:0 0 8px;color:#1E293B;font-size:1.1rem">Exit Demo Mode</h3>
            <p style="margin:0 0 20px;color:#64748B;font-size:0.9rem">Enter the password to exit demo mode.</p>
            <input id="demo-exit-pw" type="password" placeholder="Password" autocomplete="off" style="
                width:100%; padding:10px 14px; border:2px solid #E2E8F0; border-radius:10px;
                font-size:1rem; outline:none; box-sizing:border-box; transition:border-color 0.2s;
            " />
            <p id="demo-exit-error" style="color:#EF4444;font-size:0.85rem;margin:8px 0 0;min-height:1.2em"></p>
            <div style="display:flex;gap:10px;margin-top:16px">
                <button id="demo-exit-cancel" style="
                    flex:1; padding:10px; border:1px solid #E2E8F0; background:#F8FAFC;
                    border-radius:10px; cursor:pointer; font-size:0.9rem; color:#64748B;
                ">Cancel</button>
                <button id="demo-exit-confirm" style="
                    flex:1; padding:10px; border:none; background:#EF4444;
                    border-radius:10px; cursor:pointer; font-size:0.9rem; color:white; font-weight:600;
                ">Exit Demo</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const pwInput = document.getElementById('demo-exit-pw');
        const errorEl = document.getElementById('demo-exit-error');

        pwInput.focus();

        // Focus styling
        pwInput.addEventListener('focus', () => { pwInput.style.borderColor = '#3B82F6'; });
        pwInput.addEventListener('blur', () => { pwInput.style.borderColor = '#E2E8F0'; });

        function tryExit() {
            if (pwInput.value === DEMO_EXIT_PASSWORD) {
                overlay.remove();
                _demoExitAuthorized = true;  // ★★★ Bypass the guard ★★★
                localStorage.removeItem('campistry_demo_mode');
                try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
                // Exit fullscreen before reload
                if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                console.log('🎭 Demo mode disabled. Reloading...');
                window.location.reload();
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
       banner.innerHTML = `
        <span style="margin-right:8px">🎭</span>
        <span><strong>DEMO MODE</strong> — Offline · All data stored locally</span>
        <button id="demo-reset-btn" title="Reset to original data" style="
            margin-left:auto; background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.3);
            color:white; padding:2px 10px; border-radius:4px; cursor:pointer; font-size:12px;
            margin-right:8px;
        ">🔄 Reset</button>
        <button id="demo-exit-btn" title="Exit demo mode" style="
            background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.3);
            color:white; padding:2px 10px; border-radius:4px; cursor:pointer; font-size:12px;
        ">Exit Demo</button>
    `;
        banner.style.cssText = `
            position:fixed; top:0; left:0; right:0; z-index:99999;
            background:linear-gradient(135deg,#F59E0B,#D97706); color:white;
            padding:6px 16px; font-family:Inter,system-ui,sans-serif; font-size:13px;
            display:flex; align-items:center; box-shadow:0 2px 8px rgba(0,0,0,0.15);
        `;
        document.body.prepend(banner);

        // Push page content down so nothing hides behind the banner
        document.body.style.paddingTop = (banner.offsetHeight) + 'px';

        // ★★★ Reset to original data ★★★
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
        // Keep demo mode flag so it reloads into demo mode and re-imports
        localStorage.setItem('campistry_demo_mode', 'true');
        console.log('📦 Cleared', keysToRemove.length, 'keys. Reloading...');
        window.location.reload();
    });

    // ★★★ Password-protected exit ★★★
    document.getElementById('demo-exit-btn')?.addEventListener('click', () => {
        promptDemoExit();
    });

        // ★★★ Enter fullscreen kiosk mode ★★★
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

    // After the sync engine initializes, override the status indicator
    window.addEventListener('campistry-sync-ready', () => {
        const dot  = document.querySelector('.sync-dot, #syncDot');
        const text = document.querySelector('#syncText');
        if (dot)  { dot.style.background = '#10B981'; dot.classList.remove('syncing', 'error'); }
        if (text) { text.textContent = 'Demo Mode'; }
    });

    // Also patch ScheduleSync.getSyncStatus if it exists
    const _origGetSyncStatus = () => ({
        status: 'idle', isOnline: true, lastSync: Date.now(),
        queueLength: 0, initialHydrationDone: true,
        subscriptionActive: true, isSubscribed: true
    });

    Object.defineProperty(window, 'ScheduleSync', {
        configurable: true,
        set(val) {
            // When the real ScheduleSync is assigned, patch it
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
    // 16. PATCH navigator.onLine — pretend we're online so no "offline" warnings
    // =========================================================================

    Object.defineProperty(navigator, 'onLine', {
        get: () => true,
        configurable: true
    });

    // =========================================================================
    // 17. GLOBAL UTILITY FUNCTIONS
    // =========================================================================

    // ★★★ Password-protected — no more simple toggle ★★★
    window.enableDemoMode = function () {
        localStorage.setItem('campistry_demo_mode', 'true');
        try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
        console.log('🎭 Demo mode enabled. Reloading...');
        window.location.reload();
    };

    window.disableDemoMode = function () {
        promptDemoExit();
    };

    /**
     * Load demo data from a Campistry backup JSON (the format produced by the export function).
     * Run this ONCE while online to populate localStorage, then demo mode will use it.
     *
     * Usage:  loadDemoData(jsonObject)
     *   or:   paste the JSON in console: loadDemoData({ globalSettings: {...}, dailyData: {...}, ... })
     */
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

    /**
     * Quick status check
     */
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

    console.log('🎭 Demo mode ready. Run demoStatus() for details.');

})();
