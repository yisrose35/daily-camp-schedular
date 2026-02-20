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

    const CONFIG = {
        SUPABASE_URL: "https://bzqmhcumuarrbueqttfh.supabase.co",
        SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI",
        
        // Local storage keys
        CACHE_KEYS: {
            CAMP_ID: 'campistry_camp_id',
            USER_ID: 'campistry_user_id',
            AUTH_USER_ID: 'campistry_auth_user_id',
            ROLE: 'campistry_role',
            IS_TEAM_MEMBER: 'campistry_is_team_member'
        },
        
        // Debug mode - set to true to see detailed logs
        DEBUG: true
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
            // ⭐ STEP 1: Check if user is a TEAM MEMBER first (HIGHEST PRIORITY)
            // This ensures invited users get their correct assigned role
            // =================================================================
            const { data: membership, error: memberError } = await _client
                .from('camp_users')
                .select('camp_id, role, name, subdivision_ids, assigned_divisions')
                .eq('user_id', _userId)
                .not('accepted_at', 'is', null)
                .maybeSingle();

            if (!memberError && membership) {
                _campId = membership.camp_id;
                _role = membership.role || 'viewer';
                _isTeamMember = true;
                _roleVerifiedFromDB = true;  // ★★★ V-002: Now DB-verified ★★★
                cacheValues();
                
                // Store membership details for permissions module
                window._campistryMembership = membership;
                
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
                        
                        // Store membership for permissions
                        window._campistryMembership = pendingInvite;
                        
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
            const { data: ownedCamp, error: ownerError } = await _client
                .from('camps')
                .select('id, name')
                .eq('owner', _userId)
                .maybeSingle();

            if (!ownerError && ownedCamp) {
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
            // ★★★ v5.4 FIX: Trust localStorage if landing.js already set role ★★★
            // During signup, landing.js sets role='owner' + camp_id BEFORE the
            // camps.insert() finishes. onAuthStateChange fires detectCampAndRole()
            // which races here before the row exists. Trust localStorage.
            const lsRole = localStorage.getItem(CONFIG.CACHE_KEYS.ROLE);
            const lsCampId = localStorage.getItem(CONFIG.CACHE_KEYS.CAMP_ID);

            if (lsRole && lsCampId && lsRole !== 'viewer') {
                log('⚠️ No camp in DB yet but localStorage says role=' + lsRole + ' — trusting (mid-signup)');
                _campId = lsCampId;
                _role = lsRole;
                _isTeamMember = localStorage.getItem(CONFIG.CACHE_KEYS.IS_TEAM_MEMBER) === 'true';
                _roleVerifiedFromDB = false;  // Will re-verify on next page load
                return;
            }

            log('⚠️ No camp association found - defaulting to VIEWER for safety');
            _campId = _userId;
            _role = 'viewer';
            _isTeamMember = false;
            _roleVerifiedFromDB = true;
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
        
        // Fallback chain for edge cases
        const cached = localStorage.getItem(CONFIG.CACHE_KEYS.CAMP_ID);
        if (cached) return cached;
        
        // Legacy fallback
        const legacy = localStorage.getItem('currentCampId') || 
                      localStorage.getItem('campistry_user_id') ||
                      localStorage.getItem('camp_id');
        if (legacy) return legacy;
        
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

    async function getAccessToken() {
        if (!_session) {
            const { data: { session } } = await _client.auth.getSession();
            _session = session;
        }
        return _session?.access_token || CONFIG.SUPABASE_ANON_KEY;
    }

    // =========================================================================
    // RAW API HELPER (for tables not in supabase-js)
    // =========================================================================

    async function rawQuery(endpoint, options = {}) {
        const token = await getAccessToken();
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
