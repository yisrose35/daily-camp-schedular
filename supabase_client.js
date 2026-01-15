// =============================================================================
// supabase_client.js v5.0 — CAMPISTRY UNIFIED SUPABASE CLIENT
// =============================================================================
//
// THE SINGLE SOURCE OF TRUTH for Supabase connection in Campistry.
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

    console.log('🔌 Campistry Supabase Client v5.0 loading...');

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
    // INITIALIZE SUPABASE CLIENT
    // =========================================================================

    function initClient() {
        // Already initialized
        if (_client) return _client;

        // Check if supabase-js is loaded
        if (typeof supabase !== 'undefined' && supabase.createClient) {
            _client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true
                }
            });
            window.supabase = _client;
            log('Supabase client initialized');
            return _client;
        }
        
        // Try window.supabase (might be loaded differently)
        if (window.supabase) {
            _client = window.supabase;
            log('Using existing window.supabase client');
            return _client;
        }
        
        logError('Supabase JS library not loaded. Include supabase-js before this script.');
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
                    detectCampAndRole().then(() => {
                        notifyAuthChange(event, session);
                    });
                } else if (event === 'SIGNED_OUT') {
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
    // CAMP & ROLE DETECTION
    // =========================================================================

    async function detectCampAndRole() {
        if (!_userId) {
            log('No user ID, cannot detect camp/role');
            return;
        }

        // Try cached values first (for speed)
        const cachedCampId = localStorage.getItem(CONFIG.CACHE_KEYS.CAMP_ID);
        const cachedRole = localStorage.getItem(CONFIG.CACHE_KEYS.ROLE);
        const cachedIsTeam = localStorage.getItem(CONFIG.CACHE_KEYS.IS_TEAM_MEMBER);

        if (cachedCampId && cachedRole) {
            _campId = cachedCampId;
            _role = cachedRole;
            _isTeamMember = cachedIsTeam === 'true';
            log('Using cached camp info:', { campId: _campId, role: _role, isTeamMember: _isTeamMember });
        }

        // Always verify from database (cached values might be stale)
        try {
            // Check 1: Is user a camp owner?
            const { data: ownedCamp, error: ownerError } = await _client
                .from('camps')
                .select('id, name')
                .eq('owner', _userId)
                .maybeSingle();

            if (!ownerError && ownedCamp) {
                _campId = ownedCamp.id;
                _role = 'owner';
                _isTeamMember = false;
                cacheValues();
                log('User is camp owner:', _campId);
                return;
            }

            // Check 2: Is user a team member?
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
                cacheValues();
                
                // Store membership details for permissions module
                window._campistryMembership = membership;
                
                log('User is team member:', { campId: _campId, role: _role });
                return;
            }

            // Check 3: No camp association - treat as new owner
            log('No camp association found - user may be setting up new camp');
            _campId = _userId; // Use user ID as camp ID for new owners
            _role = 'owner';
            _isTeamMember = false;
            cacheValues();

        } catch (e) {
            logError('Camp/role detection failed:', e);
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
        Object.values(CONFIG.CACHE_KEYS).forEach(key => {
            localStorage.removeItem(key);
        });
        _campId = null;
        _role = null;
        _isTeamMember = false;
        delete window._campistryMembership;
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

    function getRole() {
        return _role || localStorage.getItem(CONFIG.CACHE_KEYS.ROLE) || 'viewer';
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
        log('Initialization complete', { campId: _campId, role: _role, isTeamMember: _isTeamMember });

        // Dispatch ready event
        window.dispatchEvent(new CustomEvent('campistry-db-ready', {
            detail: { campId: _campId, role: _role, isTeamMember: _isTeamMember }
        }));

        _readyResolve(true);
        return true;
    }

    // =========================================================================
    // REFRESH (force re-detection of camp/role)
    // =========================================================================

    async function refresh() {
        log('Refreshing camp/role detection...');
        await detectCampAndRole();
        return { campId: _campId, role: _role, isTeamMember: _isTeamMember };
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
            // The CDN exposes 'supabase' as the library with createClient method
            if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
                log('Creating Supabase client...');
                _client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });
                
                // Verify client was created properly
                if (_client && _client.auth) {
                    window.supabase = _client;
                    log('✅ Supabase client created successfully');
                } else {
                    console.error('🔌 Client created but auth is missing!', _client);
                }
            } else if (window.supabase && window.supabase.auth) {
                // Already a valid client
                _client = window.supabase;
                log('Using existing window.supabase client');
            } else {
                console.error('🔌 Supabase JS library not loaded. Expected supabase.createClient to be a function.');
                console.error('🔌 typeof supabase:', typeof supabase);
                if (typeof supabase !== 'undefined') {
                    console.error('🔌 supabase keys:', Object.keys(supabase));
                }
            }
        } catch (e) {
            console.error('🔌 Failed to create Supabase client:', e);
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
