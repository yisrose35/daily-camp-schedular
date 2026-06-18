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
                    window.supabase = _client;
                    log('✅ Supabase client created successfully');
                    return _client;
                } else {
                    logError('Client created but auth is missing!', _client);
                }
            } else if (window.supabase && window.supabase.auth) {
                _client = window.supabase;
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
            // ⭐ STEP 0: Honor an explicit ACTIVE-CAMP SELECTION (debug-copy
            //    feature). A super-admin can clone another camp into a sandbox
            //    camp they own and "switch into" it; switching writes a row to
            //    active_camp_selection. We honor it here ONLY if the user is
            //    genuinely entitled to that camp (owns it, or accepted member),
            //    mirroring the server-side get_user_camp_id() entitlement check.
            //    This keeps client and server scoped to the SAME camp.
            // =================================================================
            try {
                const { data: sel } = await _client
                    .from('active_camp_selection')
                    .select('camp_id')
                    .eq('user_id', _userId)
                    .maybeSingle();
                const selCampId = sel && sel.camp_id;
                if (selCampId) {
                    // (a) Does the user OWN the selected camp?
                    const { data: ownedSel } = await _client
                        .from('camps')
                        .select('id, name')
                        .eq('id', selCampId)
                        .eq('owner', _userId)
                        .maybeSingle();
                    if (ownedSel) {
                        _campId = ownedSel.id;
                        _role = 'owner';
                        _isTeamMember = false;
                        _roleVerifiedFromDB = true;
                        cacheValues();
                        log('✅ Active-camp selection honored (owned):', _campId);
                        return;
                    }
                    // (b) Is the user an accepted MEMBER of the selected camp?
                    const { data: memberSel } = await _client
                        .from('camp_users')
                        .select('camp_id, role, name, subdivision_ids, assigned_divisions, accepted_at')
                        .eq('user_id', _userId)
                        .eq('camp_id', selCampId)
                        .not('accepted_at', 'is', null)
                        .limit(1);
                    const ms = (Array.isArray(memberSel) && memberSel.length > 0) ? memberSel[0] : null;
                    if (ms) {
                        _campId = ms.camp_id;
                        _role = ms.role || 'viewer';
                        _isTeamMember = true;
                        _roleVerifiedFromDB = true;
                        cacheValues();
                        window._campistryMembership = Object.freeze(ms);
                        log('✅ Active-camp selection honored (member):', _campId);
                        return;
                    }
                    // Selection is stale / not entitled — fall through to normal
                    // detection. The server ignores it too, so they stay in sync.
                    log('⚠️ Active-camp selection not entitled, ignoring:', selCampId);
                }
            } catch (selErr) {
                // active_camp_selection table may not exist yet (migration 010
                // not applied). That's fine — behave exactly as before.
                log('Active-camp selection check skipped:', selErr && selErr.message);
            }

            // =================================================================
            // ⭐ STEP 1: Check if user is a TEAM MEMBER first (HIGHEST PRIORITY)
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
            const { data: ownedCamps, error: ownerError } = await _client
                .from('camps')
                .select('id, name')
                .eq('owner', _userId);

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
            log('⚠️ No camp association found - defaulting to VIEWER for safety');
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

    // Switch the active camp to `campId`. Writes the server-side selection
    // (so RLS scopes to it), purges local caches, and re-detects. Caller is
    // responsible for reloading the page afterwards. Entitlement is enforced
    // by RLS + get_user_camp_id(); a camp the user can't access is ignored.
    async function setActiveCamp(campId) {
        if (!campId) throw new Error('setActiveCamp: campId required');
        if (!_userId) throw new Error('setActiveCamp: not authenticated');
        const { error } = await _client
            .from('active_camp_selection')
            .upsert({ user_id: _userId, camp_id: campId, updated_at: new Date().toISOString() },
                    { onConflict: 'user_id' });
        if (error) throw error;
        try { localStorage.setItem(CONFIG.CACHE_KEYS.ACTIVE_CAMP_ID, campId); } catch (_) {}
        purgeCampDataCaches();
        return await refresh();
    }

    // Clear the active-camp selection → fall back to the user's default camp
    // (their real owned camp / most-recent membership).
    async function clearActiveCamp() {
        if (_userId) {
            try {
                await _client.from('active_camp_selection').delete().eq('user_id', _userId);
            } catch (_) {}
        }
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
                    window.supabase = _client;
                    log('✅ Supabase client created successfully');
                } else {
                    logError('Client created but auth is missing!', _client);
                }
            } else if (window.supabase && window.supabase.auth) {
                _client = window.supabase;
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
