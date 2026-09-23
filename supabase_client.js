// =============================================================================
// supabase_client.js v5.3 — CAMPISTRY UNIFIED SUPABASE CLIENT
// =============================================================================
//
// THE SINGLE SOURCE OF TRUTH for Supabase connection in Campistry.
//
// v5.3: SECURITY PATCH - V-002 fix
//       - getRole() now fails closed to 'viewer' when not yet initialized
//       - Stale localStorage cache treated as UI hints only, never for
//         permission decisions before DB verification completes
//
// v5.2: CRITICAL FIX - Invitees no longer get owner permissions
//       - Changed STEP 4 fallback from 'owner' to 'viewer'
//       - Don't cache uncertain role state
//
// v5.1: FIXED - Check team membership BEFORE camp ownership
//
// REPLACES: All scattered Supabase URL/key definitions across files
//
// PROVIDES:
// - Supabase client initialization
// - Authentication state management
// - Camp ID caching with robust fallback chain
// - Role detection (owner/admin/scheduler/viewer)
// - Ready promise for initialization coordination
//
// =============================================================================

(function() {
    'use strict';

    // ── Every call that names a camper carries their ID ─────────────────────
    // campistry_camper_id_rpc.js (loaded before this file) wraps the client's
    // rpc(); the id comes from the roster, which is keyed by exactly the names
    // the staff pages send. See that file for what it will and will not do.
    function _camperIdFromRoster(campId, name) {
        try {
            var g = (typeof window.loadGlobalSettings === 'function') ? window.loadGlobalSettings() : null;
            var r = g && g.app1 && g.app1.camperRoster;
            var c = r && r[name];
            // A page that keeps its own copy of the roster (Campistry Lite reads
            // app1 straight from the cloud) registers it here.
            if (!c && window.__camperIdRoster && typeof window.__camperIdRoster === 'object') {
                c = window.__camperIdRoster[name];
            }
            return (c && c.camperId != null && /^\d+$/.test(String(c.camperId))) ? c.camperId : null;
        } catch (_) { return null; }
    }
    // Registered globally as well, so the module can wrap a client that was
    // created before it loaded (pages that load this file dynamically).
    window.__camperIdResolve = _camperIdFromRoster;
    function _withCamperIds(client) {
        if (client && window.CampistryCamperIdRpc) {
            window.CampistryCamperIdRpc.wrap(client, _camperIdFromRoster);
            window.CampistryCamperIdRpc.wrapFetch(_camperIdFromRoster);
        }
        return _withEraseGuard(client);
    }

    // ── After an erase or a merge, a page opened before it reloads ───────────
    // The owner's rule: "when a child is erased we force a reload that clears
    // the cache." A page opened before a camper was erased (or merged away)
    // still holds them — in memory and in this browser's cache — and would
    // write them back on its next save. The server moves the camp's cache
    // version on with every erase and merge (migration 260). Before this page
    // saves camp data, and whenever it wakes up or comes back into view, it
    // asks for that version; if it has moved on since the page loaded, the
    // page clears its local camp data and reloads instead of saving.
    const _EG = { tab: null, checkedAt: 0, pending: null, reloading: false };
    function _egStoreKey(camp) { return 'campistry_cache_epoch:' + camp; }
    function _egReload(camp, server) {
        if (_EG.reloading) return;
        _EG.reloading = true;
        // Everything this page still holds is from before the erase: nothing of
        // it may be sent — not a queued save, not the save-on-leave (TED-037).
        window.__campistryStalePage = true;
        try { localStorage.setItem(_egStoreKey(camp), String(server)); } catch (_) {}
        try { console.warn('[SupabaseClient] a camper was erased or merged on another computer — clearing this page\'s copy and reloading'); } catch (_) {}
        try {
            const msg = 'A camper was erased on another computer. Reloading to get the latest…';
            if (typeof window.showToast === 'function') window.showToast(msg, 'warning');
            else if (typeof window.toast === 'function') window.toast(msg, 'warning');
        } catch (_) {}
        Promise.resolve()
            .then(function () { try { purgeCampDataCaches(); } catch (_) {} })
            .then(function () { return window.LocalCacheIDB && window.LocalCacheIDB.clear ? window.LocalCacheIDB.clear() : null; })
            .catch(function () {})
            .then(function () { setTimeout(function () { location.reload(); }, 600); });
    }
    // Resolves true when this page may go on (its copy is current), false when
    // it is reloading. Asks the server at most every `maxAgeMs`.
    function _eraseGuardCheck(rpc, client, maxAgeMs) {
        if (_EG.reloading) return Promise.resolve(false);
        const camp = getCampId();
        if (!camp) return Promise.resolve(true);
        if (_EG.tab !== null && Date.now() - _EG.checkedAt < maxAgeMs) return Promise.resolve(true);
        if (_EG.pending) return _EG.pending;
        _EG.pending = Promise.resolve(rpc.call(client, 'get_camp_cache_epoch', { p_camp_id: camp }))
            .then(function (res) {
                const server = res && !res.error && res.data != null ? Number(res.data) : null;
                if (server === null || !isFinite(server)) return true;       // not staff, or not migrated: carry on
                _EG.checkedAt = Date.now();
                let stored = null;
                try { const v = localStorage.getItem(_egStoreKey(camp)); stored = v == null ? null : Number(v); } catch (_) {}
                // This page's own starting point: what its cache was current
                // as of (first check), then what it has seen since.
                if (_EG.tab === null) _EG.tab = (stored !== null && isFinite(stored)) ? stored : server;
                if (server > _EG.tab) { _egReload(camp, server); return false; }
                try { localStorage.setItem(_egStoreKey(camp), String(server)); } catch (_) {}
                return true;
            }, function () { return true; })
            .then(function (ok) { _EG.pending = null; return ok; });
        return _EG.pending;
    }
    // The erasing page itself is current: it moves its own starting point on.
    function _eraseGuardAdvance(epoch) {
        const camp = getCampId();
        const n = Number(epoch);
        if (!camp || !isFinite(n)) return;
        // Only this page's own erase moved the version on (exactly one step).
        // If another computer erased or merged in between, this page is out of
        // date like any other, and reloads (TED-041).
        if (_EG.tab !== null && n !== _EG.tab + 1) { _egReload(camp, n); return; }
        _EG.tab = n;
        _EG.checkedAt = Date.now();
        try { localStorage.setItem(_egStoreKey(camp), String(_EG.tab)); } catch (_) {}
    }
    window.__campistryEraseGuardAdvance = _eraseGuardAdvance;
    // Below the client: every request this page sends to the camp's server.
    // While the page is reloading after an erase, no write leaves it — this is
    // what stops the save-on-leave (a plain keepalive fetch) and any other raw
    // write (TED-037). And a call to the server's own functions (refunds,
    // auto-reloads — they carry a camper's number) first checks the version
    // afresh (TED-040).
    function _installEraseGuardFetch(client, rawRpc) {
        if (typeof window.fetch !== 'function' || window.fetch.__eraseGuardFetch) return;
        const rawFetch = window.fetch.bind(window);
        const base = String(CONFIG.SUPABASE_URL || '');
        const wrapped = function (input, init) {
            let url = '', method = 'GET';
            try {
                url = typeof input === 'string' ? input : (input && input.url) || '';
                method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            } catch (_) {}
            const ours = base && url.indexOf(base) === 0;
            const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
            const isRpcRead = /\/rest\/v1\/rpc\/get_camp_cache_epoch/.test(url);
            if (ours && write && !isRpcRead && (_EG.reloading || window.__campistryStalePage)) {
                return Promise.resolve(new Response(JSON.stringify({ message: 'This page is reloading: a camper was erased on another computer.' }),
                    { status: 409, headers: { 'Content-Type': 'application/json' } }));
            }
            if (ours && write && /\/functions\/v1\//.test(url)) {
                return _eraseGuardCheck(rawRpc, client, 0).then(function (ok) {
                    return ok ? rawFetch(input, init)
                              : new Response(JSON.stringify({ error: 'page_reloading' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
                });
            }
            return rawFetch(input, init);
        };
        wrapped.__eraseGuardFetch = true;
        Object.keys(window.fetch).forEach(function (k) { try { wrapped[k] = window.fetch[k]; } catch (_) {} });
        window.fetch = wrapped;
    }
    function _withEraseGuard(client) {
        if (!client || client.__eraseGuarded || typeof client.from !== 'function' || typeof client.rpc !== 'function') return client;
        client.__eraseGuarded = true;
        const rawRpc = client.rpc;
        const blocked = { data: null, error: { message: 'A camper was erased on another computer — this page is reloading.' } };
        // Hold a request until the check says this page's copy is current.
        function guardThen(builder, maxAgeMs) {
            if (!builder || typeof builder.then !== 'function') return builder;
            const rawThen = builder.then.bind(builder);
            builder.then = function (onOk, onErr) {
                return _eraseGuardCheck(rawRpc, client, maxAgeMs).then(function (ok) {
                    return ok ? rawThen(onOk, onErr) : Promise.resolve(blocked).then(onOk, onErr);
                });
            };
            return builder;
        }
        const rawFrom = client.from.bind(client);
        client.from = function (table) {
            const qb = rawFrom(table);
            // Camp documents: checked right before every write. Other tables: at most every 15 s.
            const maxAge = table === 'camp_state_kv' ? 0 : 15000;
            ['insert', 'upsert', 'update', 'delete'].forEach(function (m) {
                const raw = qb && qb[m];
                if (typeof raw !== 'function') return;
                qb[m] = function () { return guardThen(raw.apply(qb, arguments), maxAge); };
            });
            return qb;
        };
        client.rpc = function (fn) {
            const b = rawRpc.apply(client, arguments);
            return fn === 'get_camp_cache_epoch' ? b : guardThen(b, 15000);
        };
        // The server's own functions (refunds, auto-reloads — they act on a
        // camper by number): a fresh check first, every time (TED-040).
        try {
            const guardFns = function (fns) {
                if (!fns || typeof fns.invoke !== 'function' || fns.__eraseGuarded) return fns;
                const rawInvoke = fns.invoke.bind(fns);
                fns.invoke = function () {
                    const args = arguments;
                    return _eraseGuardCheck(rawRpc, client, 0).then(function (ok) {
                        return ok ? rawInvoke.apply(null, args)
                                  : { data: null, error: { message: 'This page is reloading: a camper was erased on another computer.' } };
                    });
                };
                fns.__eraseGuarded = true;
                return fns;
            };
            // supabase-js builds a NEW functions client on every access (a
            // getter), so the guard goes on the getter, not on one instance.
            let proto = client, desc = null;
            while (proto && !desc) { desc = Object.getOwnPropertyDescriptor(proto, 'functions'); proto = Object.getPrototypeOf(proto); }
            if (desc && typeof desc.get === 'function') {
                Object.defineProperty(client, 'functions', {
                    configurable: true,
                    get: function () { return guardFns(desc.get.call(client)); }
                });
            } else {
                guardFns(client.functions);
            }
        } catch (_) {}
        try { _installEraseGuardFetch(client, rawRpc); } catch (_) {}
        // A page that wakes (a laptop opened, a tab brought back) checks at once.
        try {
            const wake = function () {
                if (document.visibilityState === 'visible') { _EG.checkedAt = 0; _eraseGuardCheck(rawRpc, client, 0); }
            };
            document.addEventListener('visibilitychange', wake);
            window.addEventListener('focus', wake);
            window.addEventListener('online', wake);
            // …and a page just opened from this browser's cache, once the camp
            // is known, without waiting for its first save.
            [2500, 8000].forEach(function (ms) {
                setTimeout(function () { _eraseGuardCheck(rawRpc, client, 0); }, ms);
            });
        } catch (_) {}
        return client;
    }


    console.log('🔌 Campistry Supabase Client v5.3 loading...');

    // =========================================================================
    // CONFIGURATION - SINGLE SOURCE OF TRUTH
    // =========================================================================
    // URL and anon key MUST come from config.js (gitignored). Copy config.example.js
    // to config.js and set your Supabase url/anonKey. No fallback — key is not in repo.
    // =========================================================================

    const _injected = typeof window !== 'undefined' && window.__CAMPISTRY_SUPABASE__;
    const CONFIG = {
        SUPABASE_URL: (_injected && window.__CAMPISTRY_SUPABASE__.url) || '',
        SUPABASE_ANON_KEY: (_injected && window.__CAMPISTRY_SUPABASE__.anonKey) || '',

        // Local storage keys
        CACHE_KEYS: {
            CAMP_ID: 'campistry_camp_id',
            USER_ID: 'campistry_user_id',
            AUTH_USER_ID: 'campistry_auth_user_id',
            ROLE: 'campistry_role',
            IS_TEAM_MEMBER: 'campistry_is_team_member',
            // Debug-copy feature: which camp the user has explicitly switched
            // into (their own camp or a debug copy). UI hint only — the server
            // enforces entitlement via active_camp_selection + get_user_camp_id().
            ACTIVE_CAMP_ID: 'campistry_active_camp_id',
            IS_SUPER_ADMIN: 'campistry_is_super_admin'
        },

        // Debug mode - set to true to see detailed logs
        DEBUG: false
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _client = null;
    let _session = null;
    let _campId = null;
    let _userId = null;
    let _role = null;
    let _isTeamMember = false;
    let _isInitialized = false;
    let _roleVerifiedFromDB = false;  // ★★★ V-002: Track whether role is DB-verified ★★★
    let _readyResolve = null;
    let _readyPromise = new Promise(resolve => { _readyResolve = resolve; });
    let _authChangeCallbacks = [];

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('🔌 [SupabaseClient]', ...args);
        }
    }

    function logError(...args) {
        console.error('🔌 [SupabaseClient] ERROR:', ...args);
    }

    // =========================================================================
    // CLIENT INITIALIZATION
    // =========================================================================

    function initClient() {
        if (_client) return _client;

        if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
            logError('Missing Supabase config. Copy config.example.js to config.js and set url + anonKey.');
            return null;
        }

        try {
            if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
                log('Creating Supabase client...');
                _client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });
                
                if (_client && _client.auth) {
                    window.supabase = _withCamperIds(_client);
                    log('✅ Supabase client created successfully');
                    return _client;
                } else {
                    logError('Client created but auth is missing!', _client);
                }
            } else if (window.supabase && window.supabase.auth) {
                _client = _withCamperIds(window.supabase);
                log('Using existing window.supabase client');
                return _client;
            } else {
                logError('Supabase JS library not loaded. Include supabase-js before this script.');
            }
        } catch (e) {
            logError('Failed to create client:', e);
        }
        
        return null;
    }

    // =========================================================================
    // AUTHENTICATION
    // =========================================================================

    async function initAuth() {
        const client = initClient();
        if (!client) return false;

        try {
            // Get current session
            const { data: { session }, error } = await client.auth.getSession();
            
            if (error) {
                logError('Failed to get session:', error);
                return false;
            }

            _session = session;

            if (session?.user) {
                _userId = session.user.id;
                log('User authenticated:', session.user.email);
                
                // Detect camp and role
                await detectCampAndRole();
            } else {
                log('No active session');
            }

            // Listen for auth changes
            client.auth.onAuthStateChange((event, session) => {
                log('Auth state changed:', event);
                _session = session;
                _userId = session?.user?.id || null;

                if (event === 'SIGNED_IN') {
                    // ★★★ V-002 FIX: Mark role as unverified during re-detection ★★★
                    _roleVerifiedFromDB = false;
                    detectCampAndRole().then(() => {
                        notifyAuthChange(event, session);
                    });
                } else if (event === 'SIGNED_OUT') {
                    _roleVerifiedFromDB = false;
                    clearCache();
                    notifyAuthChange(event, session);
                } else {
                    notifyAuthChange(event, session);
                }
            });

            return true;
        } catch (e) {
            logError('Auth initialization failed:', e);
            return false;
        }
    }

    // =========================================================================
    // ⭐ FIXED v5.2: Check team membership FIRST, then camp ownership
    // =========================================================================

    async function detectCampAndRole() {
        // Public pages (the hosted card page, register, etc.) only ever call
        // anon RPCs — they have no use for camp/role at all. Without this a
        // signed-in visitor who doesn't own THIS camp triggers the owner-camp
        // lookup, fails it 3x, and logs a scary "this is a bug" error on every
        // auth state change. Opt out by setting the flag before this script.
        if (typeof window !== 'undefined' && window.__CAMPISTRY_PUBLIC_PAGE__) {
            log('Public page — skipping camp/role detection');
            return;
        }
        if (!_userId) {
            log('No user ID, cannot detect camp/role');
            return;
        }

        // Try cached values first (for speed) — UI hints only, not for permission decisions
        const cachedCampId = localStorage.getItem(CONFIG.CACHE_KEYS.CAMP_ID);
        const cachedRole = localStorage.getItem(CONFIG.CACHE_KEYS.ROLE);
        const cachedIsTeam = localStorage.getItem(CONFIG.CACHE_KEYS.IS_TEAM_MEMBER);

        if (cachedCampId && cachedRole) {
            _campId = cachedCampId;
            _role = cachedRole;
            _isTeamMember = cachedIsTeam === 'true';
            // ★★★ V-002: DO NOT mark as verified — this is just the cache ★★★
            log('Using cached camp info (unverified hint):', { campId: _campId, role: _role, isTeamMember: _isTeamMember });
        }

        // Always verify from database (cached values might be stale)
        try {
            // =================================================================
            // ⭐ STEP 1: Check if user is a TEAM MEMBER first (HIGHEST PRIORITY)
            //    NOTE (Debug Copy): a super-admin "switches into" a debug copy
            //    by joining it as a team member (camp_users row, role owner).
            //    So this same path naturally resolves the active copy for them.
            // This ensures invited users get their correct assigned role
            // =================================================================
            // Multi-camp users: .maybeSingle() throws on >1 rows, so a user
            // who belongs to two camps would crash through to STEP 4 (viewer
            // with own UUID as campId) and write to the wrong camp_id.
            // Pick the most-recently-joined camp deterministically. The
            // server-side get_user_camp_id() helper uses the same rule.
            const { data: memberships, error: memberError } = await _client
                .from('camp_users')
                .select('camp_id, role, name, subdivision_ids, assigned_divisions, accepted_at')
                .eq('user_id', _userId)
                .not('accepted_at', 'is', null)
                .order('accepted_at', { ascending: false })
                .limit(1);
            const membership = (Array.isArray(memberships) && memberships.length > 0) ? memberships[0] : null;

            if (!memberError && membership) {
                _campId = membership.camp_id;
                _role = membership.role || 'viewer';
                _isTeamMember = true;
                _roleVerifiedFromDB = true;  // ★★★ V-002: Now DB-verified ★★★
                cacheValues();
                
                // Store membership details for permissions module. Frozen
                // so an XSS payload can't replace it with a synthetic
                // {role:'owner', camp_id:victimCamp} before the next
                // DB verify catches up.
                window._campistryMembership = Object.freeze(membership);
                
                log('✅ User IS a team member (DB-verified):', { campId: _campId, role: _role });
                return; // ⭐ IMPORTANT: Exit here - don't check camp ownership
            }

            // =================================================================
            // ⭐ STEP 2: Check for PENDING INVITE (auto-accept if found)
            // =================================================================
            const userEmail = _session?.user?.email;
            if (userEmail) {
                const { data: pendingInvite } = await _client
                    .from('camp_users')
                    .select('id, camp_id, role, subdivision_ids, assigned_divisions')
                    .eq('email', userEmail.toLowerCase())
                    .is('user_id', null)
                    .maybeSingle();
                
                if (pendingInvite) {
                    log('Found pending invite - auto-accepting:', pendingInvite.role);
                    
                    // Auto-accept the invite
                    const { error: acceptError } = await _client
                        .from('camp_users')
                        .update({
                            user_id: _userId,
                            accepted_at: new Date().toISOString()
                        })
                        .eq('id', pendingInvite.id);
                    
                    if (!acceptError) {
                        _campId = pendingInvite.camp_id;
                        _role = pendingInvite.role || 'viewer';
                        _isTeamMember = true;
                        _roleVerifiedFromDB = true;  // ★★★ V-002: DB-verified ★★★
                        cacheValues();
                        
                        // Store membership for permissions (frozen — see above).
                        window._campistryMembership = Object.freeze(pendingInvite);
                        
                        log('✅ Invite auto-accepted, user is now:', _role);
                        return;
                    } else {
                        logError('Failed to accept invite:', acceptError);
                    }
                }
            }

            // =================================================================
            // ⭐ STEP 3: Check if user is a CAMP OWNER (only if not a team member)
            // =================================================================
            // A user may own MULTIPLE camps once debug copies exist. Resolve
            // deterministically: prefer the camp whose id == uid (signup
            // convention = the user's "real" camp). Copies are only entered
            // via the explicit active-camp selection handled in STEP 0.
            //
            // Retried up to 3 times with a short backoff: an owner account was
            // observed getting an empty (not erroring) result here on the very
            // first query right after boot, then the identical query returning
            // all owned camps correctly a moment later when re-run by hand —
            // classic session/JWT-propagation-not-fully-settled-yet symptom.
            // The consequence of trusting that first empty read was severe (it
            // silently fell through to STEP 4 and started treating a real
            // camp owner as having no camp at all), so this is worth a few
            // hundred ms of retry rather than resolving wrong with confidence.
            let ownedCamps = null, ownerError = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const res = await _client.from('camps').select('id, name').eq('owner', _userId);
                ownedCamps = res.data;
                ownerError = res.error;
                if (!ownerError && Array.isArray(ownedCamps) && ownedCamps.length > 0) break;
                if (attempt < 2) {
                    logError(`Owner-camp lookup came back empty on attempt ${attempt + 1}/3 (error=${ownerError ? ownerError.message : 'none'}) — retrying...`);
                    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
                }
            }

            const ownedCamp = (!ownerError && Array.isArray(ownedCamps) && ownedCamps.length > 0)
                ? (ownedCamps.find(c => c.id === _userId) || ownedCamps[0])
                : null;

            if (ownedCamp) {
                _campId = ownedCamp.id;
                _role = 'owner';
                _isTeamMember = false;
                _roleVerifiedFromDB = true;  // ★★★ V-002: DB-verified ★★★
                cacheValues();
                log('User is camp owner:', _campId);
                return;
            }

            // =================================================================
            // ⭐ STEP 4: No camp association found
            // ★★★ CRITICAL FIX v5.2: Default to VIEWER for safety, not OWNER ★★★
            // New users will be redirected to create a camp in the auth flow
            // Invited users who fell through should NOT get owner access
            // =================================================================
            // Always logged (not gated on DEBUG) — this is the fallback that
            // silently masqueraded a real owner as a viewer with a fake
            // campId before the retry above existed, so it needs to be
            // impossible to miss in the console if it's ever hit for real.
            logError('No camp association found after retries — defaulting to VIEWER. If this account should own or belong to a camp, this is a bug, not expected behavior.', { userId: _userId, ownerError });
            _campId = _userId;
            _role = 'viewer';  // ★★★ SAFE DEFAULT - NOT OWNER! ★★★
            _isTeamMember = false;
            _roleVerifiedFromDB = true;  // ★★★ V-002: Still verified (verified as "no association") ★★★
            // Don't cache uncertain state - let next page load verify
            // cacheValues();

        } catch (e) {
            logError('Camp/role detection failed:', e);
            // ★★★ V-002: On error, do NOT mark as verified — use safe default ★★★
            _roleVerifiedFromDB = false;
            // Use cached values if database query failed
        }
    }

    function cacheValues() {
        if (_campId) localStorage.setItem(CONFIG.CACHE_KEYS.CAMP_ID, _campId);
        if (_role) localStorage.setItem(CONFIG.CACHE_KEYS.ROLE, _role);
        localStorage.setItem(CONFIG.CACHE_KEYS.IS_TEAM_MEMBER, String(_isTeamMember));
        if (_userId) localStorage.setItem(CONFIG.CACHE_KEYS.USER_ID, _userId);
        localStorage.setItem(CONFIG.CACHE_KEYS.AUTH_USER_ID, _userId || '');
    }

    function clearCache() {
        // Auth keys (existing)
        Object.values(CONFIG.CACHE_KEYS).forEach(key => {
            localStorage.removeItem(key);
        });
        _campId = null;
        _role = null;
        _isTeamMember = false;
        _roleVerifiedFromDB = false;
        delete window._campistryMembership;
        
        // ⭐ NEW: Clear camp data keys on sign-out
        localStorage.removeItem('campGlobalSettings_v1');
        localStorage.removeItem('campistryGlobalSettings');
        localStorage.removeItem('CAMPISTRY_LOCAL_CACHE');
        localStorage.removeItem('campDailyData_v1');
    }

    // =========================================================================
    // AUTH CHANGE NOTIFICATIONS
    // =========================================================================

    function onAuthChange(callback) {
        if (typeof callback === 'function') {
            _authChangeCallbacks.push(callback);
        }
        // Return unsubscribe function
        return () => {
            _authChangeCallbacks = _authChangeCallbacks.filter(cb => cb !== callback);
        };
    }

    function notifyAuthChange(event, session) {
        _authChangeCallbacks.forEach(cb => {
            try {
                cb(event, session);
            } catch (e) {
                logError('Auth change callback error:', e);
            }
        });
    }

    // =========================================================================
    // PUBLIC API - GETTERS
    // =========================================================================

    function getClient() {
        return _client;
    }

    function getCampId() {
        if (_campId) return _campId;
        // Cached value from a verified detection round.
        const cached = localStorage.getItem(CONFIG.CACHE_KEYS.CAMP_ID);
        if (cached) return cached;
        // Slice 2 audit fix: removed the unauthenticated legacy localStorage
        // chain (currentCampId / campistry_user_id / camp_id). Anyone with
        // DOM access could write any camp_id and the client would honor
        // it without verifying membership. RLS still blocks server reads,
        // but the client UI rendered empty-but-suggestive states for
        // foreign camps. Return null and force callers to wait for
        // verified detection.
        return null;
    }

    function getUserId() {
        return _userId || _session?.user?.id || null;
    }

    function getSession() {
        return _session;
    }

    // ★★★ V-002 FIX: getRole() fails closed when not DB-verified ★★★
    // Stale localStorage cache should never drive permission decisions
    function getRole() {
        if (_roleVerifiedFromDB && _role) {
            return _role;
        }
        // If not yet DB-verified, fail closed to viewer
        // The cached value is only a UI hint for loading screens
        if (!_isInitialized) {
            return 'viewer';  // Fail-closed before init completes
        }
        return _role || localStorage.getItem(CONFIG.CACHE_KEYS.ROLE) || 'viewer';
    }

    // ★★★ V-002: Expose whether role has been verified from database ★★★
    function isRoleVerified() {
        return _roleVerifiedFromDB;
    }

    function isOwner() {
        return getRole() === 'owner';
    }

    function isAdmin() {
        return getRole() === 'admin' || getRole() === 'owner';
    }

    function isTeamMember() {
        if (_isTeamMember !== null) return _isTeamMember;
        return localStorage.getItem(CONFIG.CACHE_KEYS.IS_TEAM_MEMBER) === 'true';
    }

    function isAuthenticated() {
        return !!_session?.user;
    }

    function isInitialized() {
        return _isInitialized;
    }

    // =========================================================================
    // SESSION TOKEN (for direct REST API calls)
    // =========================================================================

    // Slice 2 audit fix: do NOT silently fall back to the anon key when a
    // session token isn't available. Earlier, a logged-in user whose JWT
    // had expired would keep "saving" — the writes hit the REST endpoint
    // with the anon key, which RLS treats as unauthenticated. Saves
    // returned 401, the client surfaced "permission denied" toasts, and
    // the user had no UI affordance to re-auth — data drifted off cloud
    // while local cache filled up.
    //
    // Now: refresh the session if we have a refresh token; if we still
    // can't get an access token, return null and surface a re-auth
    // event. Callers who need a token must check for null.
    async function getAccessToken() {
        if (!_session?.access_token) {
            try {
                const { data: { session } } = await _client.auth.getSession();
                _session = session;
            } catch (_) {}
        }
        // Treat tokens within 60s of expiry as already-stale and refresh.
        const expIso = _session?.expires_at ? _session.expires_at * 1000 : 0;
        if (_session?.access_token && expIso > 0 && expIso - Date.now() < 60000) {
            try {
                const { data: { session } } = await _client.auth.refreshSession();
                if (session?.access_token) _session = session;
            } catch (_) {}
        }
        if (!_session?.access_token) {
            // Surface a re-auth signal exactly once per missing-token episode.
            if (!window._campistryAuthExpiredFired) {
                window._campistryAuthExpiredFired = true;
                try {
                    window.dispatchEvent(new CustomEvent('campistry-auth-expired'));
                } catch (_) {}
                console.warn('[CampistryDB] No access token — user must re-authenticate.');
            }
            return null;
        }
        // Reset the latched signal once we have a valid token again.
        window._campistryAuthExpiredFired = false;
        return _session.access_token;
    }

    // =========================================================================
    // RAW API HELPER (for tables not in supabase-js)
    // =========================================================================

    async function rawQuery(endpoint, options = {}) {
        const token = await getAccessToken();
        if (!token) {
            // No session — fail fast rather than send the anon key and
            // pretend things are fine (the previous behavior). Callers
            // get a clear "no auth" signal and can route to login.
            return { error: { message: 'Not authenticated', code: 'NO_AUTH' } };
        }
        const url = `${CONFIG.SUPABASE_URL}/rest/v1/${endpoint}`;

        const headers = {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': options.prefer || 'return=representation'
        };

        try {
            const response = await fetch(url, {
                method: options.method || 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Supabase API error ${response.status}: ${errorText}`);
            }

            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (e) {
            logError('Raw query failed:', e);
            throw e;
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) {
            return true;
        }

        log('Initializing...');

        const client = initClient();
        if (!client) {
            logError('Failed to initialize Supabase client');
            _readyResolve(false);
            return false;
        }

        await initAuth();

        _isInitialized = true;
        log('Initialization complete', { campId: _campId, role: _role, isTeamMember: _isTeamMember, roleVerified: _roleVerifiedFromDB });

        // Dispatch ready event
        window.dispatchEvent(new CustomEvent('campistry-db-ready', {
            detail: { campId: _campId, role: _role, isTeamMember: _isTeamMember, roleVerified: _roleVerifiedFromDB }
        }));

        _readyResolve(true);
        return true;
    }

    // =========================================================================
    // REFRESH (force re-detection of camp/role)
    // =========================================================================

    async function refresh() {
        log('Refreshing camp/role detection...');
        _roleVerifiedFromDB = false;  // ★★★ V-002: Mark as unverified during refresh ★★★
        await detectCampAndRole();
        return { campId: _campId, role: _role, isTeamMember: _isTeamMember, roleVerified: _roleVerifiedFromDB };
    }

    // =========================================================================
    // DEBUG-COPY / ACTIVE-CAMP SWITCHING
    // =========================================================================

    // Is the current user on the platform super-admin allow-list? Cached for
    // the session. Returns false (fail-closed) if the table/policy is absent.
    async function checkSuperAdmin() {
        try {
            if (!_userId) return false;
            const { data, error } = await _client
                .from('super_admins')
                .select('user_id')
                .eq('user_id', _userId)
                .maybeSingle();
            const isSA = !error && !!data;
            try { localStorage.setItem(CONFIG.CACHE_KEYS.IS_SUPER_ADMIN, String(isSA)); } catch (_) {}
            return isSA;
        } catch (_) {
            return false;
        }
    }

    function isSuperAdmin() {
        // Synchronous UI hint from cache; call checkSuperAdmin() for the
        // authoritative answer. Never used for a security decision (RLS is).
        return localStorage.getItem(CONFIG.CACHE_KEYS.IS_SUPER_ADMIN) === 'true';
    }

    // Purge the camp-scoped local caches so a camp switch loads the target
    // camp fresh from cloud instead of showing the previous camp's data.
    function purgeCampDataCaches() {
        const dataKeys = [
            'campGlobalSettings_v1', 'campistryGlobalSettings', 'CAMPISTRY_LOCAL_CACHE',
            'campDailyData_v1', 'campGlobalRegistry_v1', 'campistry_settings_camp_id'
        ];
        try { dataKeys.forEach(k => localStorage.removeItem(k)); } catch (_) {}
        // Date-keyed layer / skeleton caches.
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && (k.indexOf('campAutoLayers_') === 0 ||
                          k.indexOf('campManualSkeleton_') === 0)) {
                    localStorage.removeItem(k);
                }
            }
        } catch (_) {}
        // The big IndexedDB warm cache.
        try { if (window.LocalCacheIDB && window.LocalCacheIDB.clear) window.LocalCacheIDB.clear(); } catch (_) {}
    }

    // IDs of debug copies this super-admin owns the debugging session for.
    async function _myDebugCopyIds() {
        try {
            const { data } = await _client
                .from('debug_copies')
                .select('copy_camp_id')
                .eq('super_admin_id', _userId);
            return (data || []).map(r => r.copy_camp_id);
        } catch (_) { return []; }
    }

    // Remove every debug-copy membership this user holds, so they hold at most
    // one at a time (keeps detection unambiguous and avoids .maybeSingle crashes
    // elsewhere). Real-camp memberships are never touched.
    async function _leaveAllDebugCopies() {
        const copies = await _myDebugCopyIds();
        if (copies.length) {
            try {
                await _client.from('camp_users')
                    .delete().eq('user_id', _userId).in('camp_id', copies);
            } catch (_) {}
        }
    }

    // Switch the active camp to a DEBUG COPY by joining it as a team-member
    // owner — the same path every module uses to resolve the active camp. Then
    // purge local caches and re-detect. Caller reloads the page afterwards.
    async function setActiveCamp(campId) {
        if (!campId) throw new Error('setActiveCamp: campId required');
        if (!_userId) throw new Error('setActiveCamp: not authenticated');
        await _leaveAllDebugCopies();
        const copies = await _myDebugCopyIds();
        if (copies.indexOf(campId) >= 0) {
            // camp_users.email is NOT NULL — use the super-admin's own email.
            const myEmail = (_session && _session.user && _session.user.email) ||
                            localStorage.getItem('campistry_user_email') || 'super-admin@campistry.local';
            // role must satisfy camp_users_role_check; 'owner' is not a valid
            // camp_users role (owners live in camps.owner). 'admin' grants full
            // write access (create/edit/generate) — enough to debug the copy.
            const { error } = await _client.from('camp_users').insert({
                camp_id: campId,
                user_id: _userId,
                email: myEmail,
                role: 'admin',
                accepted_at: new Date().toISOString()
            });
            if (error) throw error;
        }
        try { localStorage.setItem(CONFIG.CACHE_KEYS.ACTIVE_CAMP_ID, campId); } catch (_) {}
        purgeCampDataCaches();
        return await refresh();
    }

    // Leave any debug copy → fall back to the user's real owned camp.
    async function clearActiveCamp() {
        await _leaveAllDebugCopies();
        try { localStorage.removeItem(CONFIG.CACHE_KEYS.ACTIVE_CAMP_ID); } catch (_) {}
        purgeCampDataCaches();
        return await refresh();
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.CampistryDB = {
        // Core
        client: null, // Will be set after init
        initialize,
        refresh,
        ready: _readyPromise,
        isInitialized,
        
        // Getters
        getClient,
        getCampId,
        getUserId,
        getSession,
        getAccessToken,
        getRole,
        isRoleVerified,  // ★★★ V-002: New export ★★★
        
        // Role checks
        isOwner,
        isAdmin,
        isTeamMember,
        isAuthenticated,

        // Debug-copy / active-camp switching
        checkSuperAdmin,
        isSuperAdmin,
        setActiveCamp,
        clearActiveCamp,

        // Auth listeners
        onAuthChange,
        
        // Raw API access
        rawQuery,
        
        // Config (read-only)
        config: Object.freeze({ ...CONFIG })
    };

    // Make client accessible after init
    Object.defineProperty(window.CampistryDB, 'client', {
        get: () => _client
    });

    // =========================================================================
    // AUTO-INITIALIZE (SYNCHRONOUS CLIENT CREATION)
    // =========================================================================

    // Create client IMMEDIATELY so window.supabase is available right away
    (function initClientNow() {
        try {
            if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
                log('Creating Supabase client...');
                _client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });
                
                if (_client && _client.auth) {
                    window.supabase = _withCamperIds(_client);
                    log('✅ Supabase client created successfully');
                } else {
                    logError('Client created but auth is missing!', _client);
                }
            } else if (window.supabase && window.supabase.auth) {
                _client = _withCamperIds(window.supabase);
                log('Using existing window.supabase client');
            } else {
                logError('Supabase JS library not loaded. Expected supabase.createClient to be a function.');
                if (typeof supabase !== 'undefined') {
                    logError('supabase keys:', Object.keys(supabase));
                }
            }
        } catch (e) {
            logError('Failed to create Supabase client:', e);
        }
    })();

    // Full initialization (auth, camp detection) happens async
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initialize, 100);
        });
    } else {
        setTimeout(initialize, 100);
    }

    // Backward compatibility - expose getCampId globally
    window.getCampId = getCampId;

})();
