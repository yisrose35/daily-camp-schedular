// ============================================================================
// access_control.js — Campistry Role-Based Access Control (Multi-Tenant) v3.8
// ============================================================================
// 
// v3.8 SESSION CACHE:
// - Reads RBAC context from sessionStorage (written by dashboard.js v2.4)
// - Skips all Supabase queries on cache hit → near-instant initialization
// - Cache validated by userId match + 30-minute TTL
// - Eliminates white screen gap between auth and RBAC on Flow/Me pages
//
// v3.7 SECURITY PATCHES:
// - V-002 FIX: All permission checks now fail-closed when !_initialized
// - Removed duplicate canEditPrintTemplates/canDeletePrintTemplates/canPrintSchedules
// - Added real-time Supabase subscription for remote membership changes
// - XSS-safe: showNoAccessWarning uses textContent instead of innerHTML
//
// v3.6 CHANGES:
// - CRITICAL FIX: Invitees no longer get owner permissions (STEP 4 fallback)
// - canEraseData() now allows Admin (not just Owner)
// - Added canEraseAllCampData() for Owner-only nuclear option
//
// v3.5: Check team membership BEFORE camp ownership
// 
// Permission model:
// - OWNER: Full access to everything
// - ADMIN: Full access except delete camp data and invite users
// - SCHEDULER: Edit only assigned divisions, view all (greyed out for others)
// - VIEWER: View only, but can use Print Center and Camper Locator
//
// Division assignment methods (scheduler):
// 1. Via subdivisions (preferred): scheduler assigned to subdivision_ids
// 2. Via direct assignment (fallback): scheduler has assigned_divisions array
//
// EXCEPTIONS (accessible by all roles including viewers):
// - Daily Schedule View (read-only for viewers)
// - Print Center (full functionality)
// - Camper Locator (full functionality)
// ============================================================================

(function() {
    'use strict';

    console.log("🔐 Access Control v3.8 loading...");

    // =========================================================================
    // STATE
    // =========================================================================
    
    let _currentUser = null;
    let _currentRole = null;
    let _campId = null;
    let _campName = null;
    let _userName = null;
    let _subdivisions = [];
    let _userSubdivisionIds = [];
    let _userSubdivisionDetails = [];
    let _directDivisionAssignments = [];
    let _editableDivisions = [];
    let _initialized = false;
    let _isTeamMember = false;
    let _membership = null;
    let _lastDivisionsHash = null;
    let _membershipSubscription = null;  // ★★★ v3.7: Real-time subscription ★★★

    const ROLES = {
        OWNER: 'owner',
        ADMIN: 'admin',
        SCHEDULER: 'scheduler',
        VIEWER: 'viewer'
    };

    const ROLE_HIERARCHY = {
        owner: 4,
        admin: 3,
        scheduler: 2,
        viewer: 1
    };

    const SUBDIVISION_COLORS = [
        '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E', '#F97316', '#EAB308',
        '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6', '#A855F7', '#10B981'
    ];

    // =========================================================================
    // DEBUG MODE
    // =========================================================================
    
    const DEBUG = true;
    
    function debugLog(...args) {
        if (DEBUG) {
            console.log("🔐 [RBAC]", ...args);
        }
    }

    // =========================================================================
    // ★★★ v3.8: SESSION CACHE — Skip Supabase queries on cache hit ★★★
    // Dashboard writes RBAC context to sessionStorage after role resolution.
    // On Flow/Me pages, we read it here for near-instant initialization.
    // =========================================================================

    function tryRestoreFromCache(currentUserId) {
        try {
            const raw = sessionStorage.getItem('campistry_rbac_cache');
            if (!raw) return false;
            
            const cache = JSON.parse(raw);
            
            // Validate: same user, not stale (max 30 minutes)
            if (cache.userId !== currentUserId) {
                console.log("🔐 Cache userId mismatch, ignoring");
                sessionStorage.removeItem('campistry_rbac_cache');
                return false;
            }
            
            const ageMinutes = (Date.now() - cache.cachedAt) / 60000;
            if (ageMinutes > 30) {
                console.log("🔐 Cache expired (" + Math.round(ageMinutes) + "m), ignoring");
                sessionStorage.removeItem('campistry_rbac_cache');
                return false;
            }
            
            // Restore state from cache
            _currentRole = cache.role || ROLES.VIEWER;
            _campId = cache.campId;
            _campName = cache.campName || 'Your Camp';
            _userName = cache.userName || _currentUser.email?.split('@')[0];
            _isTeamMember = cache.isTeamMember || false;
            _userSubdivisionIds = cache.subdivisionIds || [];
            _directDivisionAssignments = cache.assignedDivisions || [];
            
            // Also update localStorage for other modules that read it
            localStorage.setItem('campistry_user_id', _campId);
            localStorage.setItem('campistry_auth_user_id', currentUserId);
            localStorage.setItem('campistry_role', _currentRole);
            localStorage.setItem('campistry_is_team_member', String(_isTeamMember));
            
            return true;
            
        } catch (e) {
            console.warn("🔐 Cache restore error:", e);
            return false;
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_initialized) {
            debugLog("Already initialized, skipping");
            return;
        }
        
        console.log("🔐 Initializing access control...");
        
        let attempts = 0;
        while (!window.supabase && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        
        if (!window.supabase) {
            console.error("🔐 Supabase not available");
            return;
        }

        const { data: { user } } = await window.supabase.auth.getUser();
        if (!user) {
            console.log("🔐 No user logged in");
            return;
        }

        _currentUser = user;
        
        // ★★★ v3.8: TRY SESSION CACHE FIRST ★★★
        if (tryRestoreFromCache(user.id)) {
            console.log("🔐 ⚡ Restored from session cache — skipping Supabase queries");
        } else {
            // Full Supabase resolution (first load / cache miss / cache expired)
            await determineUserContext();
        }
        
        await loadSubdivisions();
        
        if (_currentRole === ROLES.SCHEDULER && _userSubdivisionIds.length > 0) {
            await loadUserSubdivisionDetails();
        }
        
        calculateEditableDivisions();
        
        _initialized = true;
        
        setupDivisionChangeObserver();
        setupMembershipSubscription();  // ★★★ v3.7: Real-time membership updates ★★★
        
        if (_currentRole === ROLES.SCHEDULER && _editableDivisions.length === 0) {
            showNoAccessWarning();
        }
        
        window.dispatchEvent(new CustomEvent('campistry-access-loaded', {
            detail: {
                role: _currentRole,
                editableDivisions: _editableDivisions,
                subdivisions: _subdivisions,
                isTeamMember: _isTeamMember,
                userName: _userName,
                campName: _campName,
                userSubdivisionDetails: _userSubdivisionDetails,
                userSubdivisionIds: _userSubdivisionIds,
                directDivisionAssignments: _directDivisionAssignments
            }
        }));
        
        console.log("🔐 Access control initialized:", {
            role: _currentRole,
            isTeamMember: _isTeamMember,
            userName: _userName,
            campName: _campName,
            userSubdivisionIds: _userSubdivisionIds,
            directDivisionAssignments: _directDivisionAssignments,
            editableDivisions: _editableDivisions,
            allSubdivisions: _subdivisions.length
        });
    }

    function setupDivisionChangeObserver() {
        setInterval(() => {
            const currentHash = JSON.stringify(Object.keys(window.divisions || {}).sort());
            
            // ★★★ FIX: Recalculate when divisions first become available ★★★
            if (_lastDivisionsHash === '[]' && currentHash !== '[]') {
                debugLog("window.divisions populated, recalculating editable divisions");
                calculateEditableDivisions();
                
                // Dispatch event so UI can update
                window.dispatchEvent(new CustomEvent('campistry-divisions-updated', {
                    detail: { editableDivisions: _editableDivisions }
                }));
            }
            // Also recalculate if divisions changed
            else if (currentHash !== _lastDivisionsHash && _lastDivisionsHash !== null) {
                debugLog("window.divisions changed, recalculating editable divisions");
                calculateEditableDivisions();
            }
            
            _lastDivisionsHash = currentHash;
        }, 1000);
    }

    // =========================================================================
    // ★★★ v3.7: REAL-TIME MEMBERSHIP SUBSCRIPTION ★★★
    // If an admin changes this user's role/subdivisions remotely,
    // refresh permissions without requiring a page reload.
    // =========================================================================

    function setupMembershipSubscription() {
        if (!_isTeamMember || !_currentUser || !window.supabase) return;

        try {
            _membershipSubscription = window.supabase
                .channel('my-membership-' + _currentUser.id)
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'camp_users',
                    filter: `user_id=eq.${_currentUser.id}`
                }, (payload) => {
                    console.log('🔐 Membership updated remotely, refreshing permissions...');
                    refresh();
                })
                .subscribe();
            
            debugLog("Real-time membership subscription active");
        } catch (e) {
            console.warn("🔐 Could not set up real-time membership subscription:", e);
        }
    }

    // =========================================================================
    // ⭐ FIXED v3.6: Check team membership FIRST, then camp ownership
    // =========================================================================
    async function determineUserContext() {
        console.log("🔐 Determining user context...");
        
        // =====================================================================
        // ⭐ STEP 1: Check if user is a TEAM MEMBER first (HIGHEST PRIORITY)
        // =====================================================================
        try {
            const { data: memberData, error } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('user_id', _currentUser.id)
                .not('accepted_at', 'is', null)
                .maybeSingle();
            
            console.log("🔐 Team member check result:", { 
                found: !!memberData, 
                role: memberData?.role,
                error: error?.message 
            });
            
            if (memberData && !error) {
                console.log("🔐 ✅ User IS a team member:", memberData.role);
                _currentRole = memberData.role || ROLES.VIEWER;
                _isTeamMember = true;
                _membership = memberData;
                _campId = memberData.camp_id;
                _userName = memberData.name || _currentUser.email.split('@')[0];
                _userSubdivisionIds = memberData.subdivision_ids || [];
                _directDivisionAssignments = memberData.assigned_divisions || [];
                
                const { data: campInfo } = await window.supabase
                    .from('camps')
                    .select('name')
                    .eq('owner', memberData.camp_id)
                    .maybeSingle();
                
                _campName = campInfo?.name || 'Your Camp';
                
                localStorage.setItem('campistry_user_id', _campId);
                localStorage.setItem('campistry_auth_user_id', _currentUser.id);
                
                if (_userSubdivisionIds.length > 0) {
                    console.log("🔐 User has subdivision assignments:", _userSubdivisionIds);
                } else if (_directDivisionAssignments.length > 0) {
                    console.log("🔐 User has direct division assignments:", _directDivisionAssignments);
                } else if (_currentRole === ROLES.SCHEDULER) {
                    console.warn("🔐 ⚠️ SCHEDULER HAS NO DIVISION ASSIGNMENTS!");
                }
                
                return;
            }
        } catch (e) {
            console.warn("🔐 Error checking team membership:", e);
        }

        // =====================================================================
        // ⭐ STEP 2: Check for PENDING INVITE (auto-accept if found)
        // =====================================================================
        try {
            const { data: pendingInvite } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('email', _currentUser.email.toLowerCase())
                .is('user_id', null)
                .maybeSingle();
            
            if (pendingInvite) {
                console.log("🔐 Found pending invite - auto-accepting:", pendingInvite.role);
                
                const { error: acceptError } = await window.supabase
                    .from('camp_users')
                    .update({
                        user_id: _currentUser.id,
                        accepted_at: new Date().toISOString()
                    })
                    .eq('id', pendingInvite.id);
                
                if (!acceptError) {
                    console.log("🔐 ✅ Invite auto-accepted!");
                    return await determineUserContext();
                }
            }
        } catch (e) {
            console.warn("🔐 Error checking pending invite:", e);
        }
        
        // =====================================================================
        // ⭐ STEP 3: Check if user is a CAMP OWNER
        // =====================================================================
        try {
            const { data: ownedCamp } = await window.supabase
                .from('camps')
                .select('*')
                .eq('owner', _currentUser.id)
                .maybeSingle();
            
            if (ownedCamp) {
                console.log("🔐 User is a camp owner");
                _currentRole = ROLES.OWNER;
                _isTeamMember = false;
                _campId = _currentUser.id;
                _campName = ownedCamp.name || 'Your Camp';
                _userName = ownedCamp.owner_name || _currentUser.email.split('@')[0];
                _userSubdivisionIds = [];
                _directDivisionAssignments = [];
                
                localStorage.setItem('campistry_user_id', _campId);
                localStorage.setItem('campistry_auth_user_id', _currentUser.id);
                return;
            }
        } catch (e) {
            console.warn("🔐 Error checking camp ownership:", e);
        }
        
        // =====================================================================
        // ⭐ STEP 4: Fallback - No camp association found
        // ★★★ CRITICAL FIX v3.6: Default to VIEWER for safety ★★★
        // Invited users who fell through should NOT get owner access
        // =====================================================================
        console.log("🔐 ⚠️ No camp association found - defaulting to VIEWER for safety");
        _currentRole = ROLES.VIEWER;  // ★★★ SAFE DEFAULT - NOT OWNER! ★★★
        _isTeamMember = false;
        _campId = _currentUser.id;
        _campName = 'Unknown Camp';
        _userName = _currentUser.email.split('@')[0];
        _userSubdivisionIds = [];
        _directDivisionAssignments = [];
        // Don't cache uncertain state
        // localStorage.setItem('campistry_user_id', _campId);
        // localStorage.setItem('campistry_auth_user_id', _currentUser.id);
    }

    function getCampId() {
        if (_campId) return _campId;
        const cached = localStorage.getItem('campistry_user_id');
        if (cached && cached !== 'demo_camp_001') return cached;
        return _currentUser?.id || 'demo_camp_001';
    }

    async function loadSubdivisions() {
        const campId = getCampId();
        if (!campId) return;

        try {
            const { data, error } = await window.supabase
                .from('subdivisions')
                .select('*')
                .eq('camp_id', campId)
                .order('name');

            if (error) {
                console.warn("🔐 Error loading subdivisions:", error);
                _subdivisions = [];
                return;
            }

            _subdivisions = data || [];
            console.log("🔐 Loaded subdivisions:", _subdivisions.length);
            
            if (_subdivisions.length > 0) {
                debugLog("Subdivision details:", _subdivisions.map(s => ({
                    id: s.id,
                    name: s.name,
                    divisions: s.divisions
                })));
            } else {
                console.warn("🔐 ⚠️ No subdivisions found for this camp!");
                console.warn("🔐 Owner should create subdivisions in Dashboard → Team & Access");
            }

        } catch (e) {
            console.error("🔐 Error loading subdivisions:", e);
            _subdivisions = [];
        }
    }

    async function loadUserSubdivisionDetails() {
        if (!_userSubdivisionIds || _userSubdivisionIds.length === 0) {
            _userSubdivisionDetails = [];
            return;
        }

        try {
            const { data, error } = await window.supabase
                .from('subdivisions')
                .select('id, name, divisions, color')
                .in('id', _userSubdivisionIds);

            if (error) {
                console.warn("🔐 Error loading user subdivision details:", error);
                _userSubdivisionDetails = [];
                return;
            }

            _userSubdivisionDetails = data || [];
            console.log("🔐 Loaded user subdivision details:", _userSubdivisionDetails.length);

        } catch (e) {
            console.error("🔐 Error loading user subdivision details:", e);
            _userSubdivisionDetails = [];
        }
    }

    function calculateEditableDivisions() {
        const allDivisions = Object.keys(window.divisions || {});
        
        debugLog("Calculating editable divisions...");
        debugLog("All divisions from window.divisions:", allDivisions);
        debugLog("Current role:", _currentRole);
        debugLog("User subdivision IDs:", _userSubdivisionIds);
        debugLog("User subdivision details:", _userSubdivisionDetails);
        debugLog("Direct division assignments:", _directDivisionAssignments);
        
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            _editableDivisions = [...allDivisions];
            console.log("🔐 Full edit access:", _editableDivisions.length, "divisions");
            return;
        }
        
        if (_currentRole === ROLES.VIEWER) {
            _editableDivisions = [];
            console.log("🔐 View-only access");
            return;
        }
        
        if (_currentRole === ROLES.SCHEDULER) {
            const editableDivs = new Set();
            
            // Method 1: Via subdivisions (preferred)
            if (_userSubdivisionIds && _userSubdivisionIds.length > 0) {
                if (_userSubdivisionDetails && _userSubdivisionDetails.length > 0) {
                    _userSubdivisionDetails.forEach(sub => {
                        if (sub.divisions && Array.isArray(sub.divisions)) {
                            sub.divisions.forEach(d => editableDivs.add(d));
                        }
                    });
                } else {
                    _userSubdivisionIds.forEach(subId => {
                        const sub = _subdivisions.find(s => s.id === subId);
                        if (sub && sub.divisions && Array.isArray(sub.divisions)) {
                            sub.divisions.forEach(d => editableDivs.add(d));
                        }
                    });
                }
            }
            
            // Method 2: Direct division assignments (fallback)
            if (_directDivisionAssignments && _directDivisionAssignments.length > 0) {
                _directDivisionAssignments.forEach(d => editableDivs.add(d));
            }
            
            // ★★★ FIX: If window.divisions is empty (e.g., on dashboard), 
            // use the divisions from subdivisions directly without filtering ★★★
            if (allDivisions.length === 0 && editableDivs.size > 0) {
                _editableDivisions = [...editableDivs];
                console.log("🔐 Scheduler edit access (from subdivisions):", _editableDivisions.length, "divisions", _editableDivisions);
            } else {
                // Filter against window.divisions if it's populated
                _editableDivisions = allDivisions.filter(d => editableDivs.has(d));
                console.log("🔐 Scheduler edit access:", _editableDivisions.length, "divisions", _editableDivisions);
            }
            
            if (_editableDivisions.length === 0 && editableDivs.size === 0) {
                console.warn("🔐 ⚠️ Scheduler has NO editable divisions!");
            }
        }
    }

    // ★★★ v3.7: XSS-safe — uses textContent instead of innerHTML ★★★
    function showNoAccessWarning() {
        const banner = document.createElement('div');
        banner.id = 'no-access-warning';
        banner.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, #FEE2E2, #FECACA);
            border: 2px solid #EF4444;
            padding: 16px 24px;
            border-radius: 12px;
            z-index: 9999;
            max-width: 500px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            font-family: system-ui, sans-serif;
            display: flex;
            align-items: flex-start;
            gap: 12px;
        `;

        const icon = document.createElement('span');
        icon.style.fontSize = '1.5rem';
        icon.textContent = '⚠️';

        const content = document.createElement('div');
        const title = document.createElement('strong');
        title.style.cssText = 'color: #DC2626; font-size: 1.1rem;';
        title.textContent = 'No Divisions Assigned';
        const message = document.createElement('p');
        message.style.cssText = 'margin: 8px 0 0 0; color: #991B1B; font-size: 0.9rem;';
        message.textContent = 'You are logged in as a Scheduler but haven\'t been assigned any divisions yet. Please contact your camp owner to be assigned to subdivisions.';
        content.appendChild(title);
        content.appendChild(message);

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'background: none; border: none; font-size: 1.2rem; cursor: pointer; padding: 0; color: #DC2626;';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => banner.remove());

        banner.appendChild(icon);
        banner.appendChild(content);
        banner.appendChild(closeBtn);
        
        setTimeout(() => {
            if (document.body) {
                document.body.appendChild(banner);
            }
        }, 1000);
    }

    async function refresh() {
        _initialized = false;
        // ★★★ v3.8: Clear session cache so fresh Supabase data is used ★★★
        try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
        // Clean up old subscription before reinitializing
        if (_membershipSubscription) {
            try { window.supabase?.removeChannel?.(_membershipSubscription); } catch(e) {}
            _membershipSubscription = null;
        }
        await initialize();
    }

    // =========================================================================
    // PERMISSION CHECKS - Division Level
    // ★★★ V-002: All checks fail-closed when !_initialized ★★★
    // =========================================================================

    function canEditDivision(divisionName) {
        if (!_initialized) return false;
        if (!divisionName) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        if (_currentRole === ROLES.VIEWER) return false;
        return _editableDivisions.includes(divisionName);
    }

    function canEditBunk(bunkName) {
        if (!_initialized) return false;
        if (!bunkName) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        if (_currentRole === ROLES.VIEWER) return false;
        
        const divisions = window.divisions || {};
        for (const [divName, divInfo] of Object.entries(divisions)) {
            if (divInfo.bunks && divInfo.bunks.includes(bunkName)) {
                return canEditDivision(divName);
            }
        }
        return false;
    }

    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divInfo] of Object.entries(divisions)) {
            if (divInfo.bunks && divInfo.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    }

    // =========================================================================
    // PERMISSION CHECKS - Feature Level
    // ★★★ V-002: All checks fail-closed when !_initialized ★★★
    // =========================================================================

    function canInviteUsers() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER;
    }

    function canManageSubdivisions() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    function canManageTeam() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER;
    }

    function canDeleteCampData() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER;
    }

    // ★★★ FIXED v3.6: Admin can now erase schedules/history ★★★
    function canEraseData() {
        if (!_initialized) return false;
        // Owner and Admin can erase schedules and history
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    // ★★★ NEW v3.6: Owner-only for nuclear option ★★★
    function canEraseAllCampData() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER;
    }

    /**
     * Check if user can edit/save print templates.
     * Owner and Admin can edit templates; Scheduler and Viewer cannot.
     */
    function canEditPrintTemplates() {
        if (!_initialized || !_currentRole) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    /**
     * Check if user can print schedules.
     * All roles can print (per existing Print Center exception).
     */
    function canPrintSchedules() {
        if (!_initialized) return false;
        return true; // Print Center is accessible to all roles
    }

    /**
     * Check if user can manage (delete) print templates.
     * Only Owner can delete templates.
     */
    function canDeletePrintTemplates() {
        if (!_initialized || !_currentRole) return false;
        return _currentRole === ROLES.OWNER;
    }

    function canEditSetup() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN || _currentRole === ROLES.SCHEDULER;
    }

    function canEditFields() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    function canEditGlobalFields() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    function canEditAnything() {
        if (!_initialized) return false;
        if (_currentRole === ROLES.VIEWER) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        return _editableDivisions.length > 0;
    }
    
    function canSave() {
        if (!_initialized) return false;
        return _currentRole !== ROLES.VIEWER;
    }

    function canGenerateDivision(divisionName) {
        return canEditDivision(divisionName);
    }

    function canRunGenerator() {
        if (!_initialized) return false;
        if (_currentRole === ROLES.VIEWER) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        return _editableDivisions.length > 0;
    }

    // =========================================================================
    // EXCEPTION AREAS - Accessible to ALL including viewers
    // =========================================================================

    function canPrint() {
        return _initialized;
    }

    function canUseCamperLocator() {
        return _initialized;
    }

    function canViewDailySchedule() {
        return _initialized;
    }

    // =========================================================================
    // FIELD AVAILABILITY PERMISSIONS
    // =========================================================================

    function canAddFieldAvailability(divisionName) {
        if (!_initialized) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        if (_currentRole === ROLES.SCHEDULER) return canEditDivision(divisionName);
        return false;
    }

    function canRemoveFieldAvailability(divisionName) {
        if (!_initialized) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        if (_currentRole === ROLES.SCHEDULER) return canEditDivision(divisionName);
        return false;
    }

    function hasRoleAtLeast(requiredRole) {
        if (!_initialized) return false;
        const currentLevel = ROLE_HIERARCHY[_currentRole] || 0;
        const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
        return currentLevel >= requiredLevel;
    }

    // =========================================================================
    // GETTERS & HELPERS
    // =========================================================================

    function getEditableDivisions() {
        return [..._editableDivisions];
    }

    function getUserManagedDivisions() {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return null;
        }
        return getEditableDivisions();
    }

    function getGeneratableDivisions() {
        return getEditableDivisions();
    }

    function getCurrentRole() {
        return _currentRole;
    }
    
    function isTeamMember() {
        return _isTeamMember;
    }

    function isOwner() {
        return _currentRole === ROLES.OWNER;
    }

    function isAdmin() {
        return _currentRole === ROLES.ADMIN || _currentRole === ROLES.OWNER;
    }

    function isViewer() {
        return _currentRole === ROLES.VIEWER;
    }

    function isScheduler() {
        return _currentRole === ROLES.SCHEDULER;
    }

    function getSubdivisions() {
        return [..._subdivisions];
    }

    function getAllSubdivisions() {
        return [..._subdivisions];
    }

    function getCurrentUserInfo() {
        if (!_currentUser) return null;
        return {
            userId: _currentUser.id,
            email: _currentUser.email,
            name: _userName || _currentUser.email?.split('@')[0] || 'Unknown'
        };
    }

    function getUserSubdivisionIds() {
        return [..._userSubdivisionIds];
    }

    function getUserSubdivisionDetails() {
        return [..._userSubdivisionDetails];
    }

    function getUserSubdivisions() {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return [..._subdivisions];
        }
        return _subdivisions.filter(s => _userSubdivisionIds.includes(s.id));
    }

    function getSubdivisionForDivision(divisionName) {
        for (const sub of _subdivisions) {
            if (sub.divisions && sub.divisions.includes(divisionName)) {
                return sub;
            }
        }
        return null;
    }

    function isDivisionInUserSubdivisions(divisionName) {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return true;
        }
        const userSubs = getUserSubdivisions();
        return userSubs.some(sub => sub.divisions && sub.divisions.includes(divisionName));
    }
    
    function getDirectDivisionAssignments() {
        return [..._directDivisionAssignments];
    }

    function getUserName() {
        return _userName;
    }

    function getCampName() {
        return _campName;
    }

    function getRole() {
        return _currentRole;
    }

    function getEditableBunkIds() {
        const myDivisions = getEditableDivisions();
        const divisions = window.divisions || {};
        const bunks = [];

        for (const divName of myDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                bunks.push(...divInfo.bunks);
            }
        }

        return bunks;
    }

    // =========================================================================
    // WELCOME & DISPLAY HELPERS
    // =========================================================================

    function getWelcomeMessage() {
        const name = _userName || 'there';
        const camp = _campName || 'Your Camp';
        
        return {
            title: `Welcome, ${name}!`,
            subtitle: camp,
            role: _currentRole,
            isOwner: !_isTeamMember
        };
    }

    function getPermissionsText() {
        if (_currentRole === ROLES.OWNER) {
            return 'Full access to all features';
        }
        
        if (_currentRole === ROLES.ADMIN) {
            return 'Full editing access (except team management)';
        }
        
        if (_currentRole === ROLES.VIEWER) {
            return 'View-only access (can print and lookup campers)';
        }
        
        if (_currentRole === ROLES.SCHEDULER) {
            if (_editableDivisions.length === 0) {
                return 'Scheduler (no divisions assigned - contact owner)';
            }
            
            let names = [];
            
            if (_userSubdivisionDetails && _userSubdivisionDetails.length > 0) {
                names = _userSubdivisionDetails.map(s => s.name);
            } else if (_directDivisionAssignments && _directDivisionAssignments.length > 0) {
                if (_directDivisionAssignments.length <= 3) {
                    return `Scheduler for ${_directDivisionAssignments.join(', ')}`;
                } else {
                    return `Scheduler for ${_directDivisionAssignments.length} divisions`;
                }
            } else if (_userSubdivisionIds && _userSubdivisionIds.length > 0) {
                const subs = _subdivisions.filter(s => _userSubdivisionIds.includes(s.id));
                names = subs.map(s => s.name);
            }
            
            if (names.length === 0) {
                return 'Scheduler (no divisions assigned)';
            } else if (names.length === 1) {
                return `Scheduler for ${names[0]}`;
            } else if (names.length === 2) {
                return `Scheduler for ${names[0]} and ${names[1]}`;
            } else {
                const last = names.pop();
                return `Scheduler for ${names.join(', ')}, and ${last}`;
            }
        }
        
        return '';
    }

    function getRoleDisplay() {
        const roleNames = {
            owner: 'Owner',
            admin: 'Administrator',
            scheduler: 'Scheduler',
            viewer: 'Viewer'
        };
        
        const roleColors = {
            owner: '#7C3AED',
            admin: '#2563EB',
            scheduler: '#059669',
            viewer: '#6B7280'
        };
        
        const roleDescriptions = {
            owner: 'Full access to all features and team management',
            admin: 'Full editing access to all divisions (no team management)',
            scheduler: 'Edit access to assigned divisions only',
            viewer: 'View-only access (can print and lookup campers)'
        };
        
        return {
            role: _currentRole,
            name: roleNames[_currentRole] || _currentRole,
            color: roleColors[_currentRole] || '#6B7280',
            description: roleDescriptions[_currentRole] || '',
            subdivisionDetails: _userSubdivisionDetails || [],
            directDivisionAssignments: _directDivisionAssignments || []
        };
    }

    function getPermissionsSummary() {
        const permissions = [];
        
        if (_currentRole === ROLES.OWNER) {
            permissions.push({ icon: '👑', text: 'Full access to all features' });
            permissions.push({ icon: '👥', text: 'Manage team members' });
            permissions.push({ icon: '⚙️', text: 'Camp settings & data' });
        } else if (_currentRole === ROLES.ADMIN) {
            permissions.push({ icon: '✏️', text: 'Edit all divisions and schedules' });
            permissions.push({ icon: '🖨️', text: 'Print and export' });
            permissions.push({ icon: '🔒', text: 'Cannot manage team members' });
        } else if (_currentRole === ROLES.SCHEDULER) {
            permissions.push({ icon: '✏️', text: `Edit ${_editableDivisions.length} division(s)` });
            permissions.push({ icon: '👁️', text: 'View all schedules' });
            permissions.push({ icon: '🖨️', text: 'Print and export' });
            permissions.push({ icon: '🎨', text: 'View print templates (cannot save)' });
        } else if (_currentRole === ROLES.VIEWER) {
            permissions.push({ icon: '👁️', text: 'View all schedules' });
            permissions.push({ icon: '🖨️', text: 'Print Center access' });
            permissions.push({ icon: '🔍', text: 'Camper Locator access' });
            permissions.push({ icon: '🖨️', text: 'Print schedules with saved templates' });
        }
        
        return permissions;
    }

    function getNextSubdivisionColor() {
        const usedColors = _subdivisions.map(s => s.color);
        for (const color of SUBDIVISION_COLORS) {
            if (!usedColors.includes(color)) {
                return color;
            }
        }
        return SUBDIVISION_COLORS[_subdivisions.length % SUBDIVISION_COLORS.length];
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    function getRoleDisplayName(role) {
        const names = {
            owner: 'Owner',
            admin: 'Admin',
            scheduler: 'Scheduler',
            viewer: 'Viewer'
        };
        return names[role] || role;
    }

    function getRoleColor(role) {
        const colors = {
            owner: '#7C3AED',
            admin: '#2563EB',
            scheduler: '#059669',
            viewer: '#6B7280'
        };
        return colors[role] || '#6B7280';
    }

    function showPermissionDenied(action = 'perform this action') {
        // ★★★ v3.7: XSS-safe — uses textContent instead of innerHTML ★★★
        if (typeof window.showToast === 'function') {
            window.showToast(`You don't have permission to ${action}`, 'error');
        } else {
            let toast = document.getElementById('rbac-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'rbac-toast';
                toast.style.cssText = `
                    position: fixed;
                    bottom: 24px;
                    left: 50%;
                    transform: translateX(-50%) translateY(100px);
                    padding: 12px 24px;
                    background: #EF4444;
                    color: white;
                    border-radius: 10px;
                    font-weight: 500;
                    font-size: 0.9rem;
                    z-index: 10001;
                    transition: all 0.3s ease;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
                `;
                document.body.appendChild(toast);
            }
            
            toast.textContent = `🔒 You don't have permission to ${action}`;
            toast.style.transform = 'translateX(-50%) translateY(0)';
            
            clearTimeout(toast._timer);
            toast._timer = setTimeout(() => {
                toast.style.transform = 'translateX(-50%) translateY(100px)';
            }, 3000);
        }
        console.warn(`🔐 Permission denied: ${action}`);
    }

    function renderAccessBanner() {
        const existing = document.getElementById('access-control-banner');
        if (existing) existing.remove();
        
        if (!_initialized) return;
        
        if (_currentRole === ROLES.OWNER) return;
        
        const banner = document.createElement('div');
        banner.id = 'access-control-banner';
        banner.style.cssText = `
            background: linear-gradient(135deg, #FEF3C7, #FDE68A);
            border: 1px solid #F59E0B;
            border-radius: 8px;
            padding: 12px 16px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 0.9rem;
        `;
        
        // ★★★ v3.7: XSS-safe — build DOM elements instead of innerHTML ★★★
        const icon = document.createElement('span');
        icon.style.fontSize = '1.2rem';
        const textContainer = document.createElement('div');
        const titleEl = document.createElement('strong');
        const descEl = document.createElement('div');
        descEl.style.fontSize = '0.85rem';

        if (_currentRole === ROLES.VIEWER) {
            icon.textContent = '👁️';
            titleEl.textContent = 'View Only Mode';
            descEl.style.color = '#92400E';
            descEl.textContent = 'You can view all schedules, use Print Center, and Camper Locator.';
        } else if (_currentRole === ROLES.ADMIN) {
            banner.style.background = 'linear-gradient(135deg, #DBEAFE, #BFDBFE)';
            banner.style.borderColor = '#3B82F6';
            icon.textContent = '🔧';
            titleEl.textContent = 'Administrator Mode';
            descEl.style.color = '#1E40AF';
            descEl.textContent = 'Full editing access. Team management requires Owner role.';
        } else if (_currentRole === ROLES.SCHEDULER) {
            const permText = getPermissionsText();
            const editableDivsList = _editableDivisions.length > 0 
                ? _editableDivisions.join(', ')
                : 'None assigned';
            
            banner.style.background = 'linear-gradient(135deg, #D1FAE5, #A7F3D0)';
            banner.style.borderColor = '#10B981';
            icon.textContent = '📅';
            titleEl.textContent = permText;
            descEl.style.color = '#065F46';
            descEl.textContent = `Editable: ${editableDivsList}`;
        }

        textContainer.appendChild(titleEl);
        textContainer.appendChild(descEl);
        banner.appendChild(icon);
        banner.appendChild(textContainer);
        
        const container = document.querySelector('.main-content, #schedule-container, main');
        if (container) {
            container.insertBefore(banner, container.firstChild);
        }
    }

    // =========================================================================
    // ACCESS CHECK HELPERS
    // =========================================================================

    function canEdit() {
        return canEditAnything();
    }

    function checkEditAccess() {
        if (!canEdit()) {
            showPermissionDenied('edit schedules');
            return false;
        }
        return true;
    }

    function checkSetupAccess() {
        if (!canEditSetup()) {
            showPermissionDenied('modify setup');
            return false;
        }
        return true;
    }

    function checkDivisionAccess(divisionName, action) {
        if (!canEditDivision(divisionName)) {
            showPermissionDenied(action || `edit ${divisionName}`);
            return false;
        }
        return true;
    }

    function checkBunkAccess(bunkName, action) {
        if (!canEditBunk(bunkName)) {
            showPermissionDenied(action || `edit ${bunkName}`);
            return false;
        }
        return true;
    }

    function filterEditableBunks(bunks) {
        if (!Array.isArray(bunks)) return [];
        if (!_initialized) return [];
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return bunks;
        if (!canEdit()) return [];
        return bunks.filter(b => canEditBunk(b));
    }

    function filterEditableDivisions(divisionNames) {
        if (!Array.isArray(divisionNames)) return [];
        if (!_initialized) return [];
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return divisionNames;
        if (!canEdit()) return [];
        return divisionNames.filter(d => canEditDivision(d));
    }

    // =========================================================================
    // SCHEDULER ENFORCEMENT
    // =========================================================================

    function filterDivisionsForGeneration(requestedDivisions) {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return requestedDivisions || Object.keys(window.divisions || {});
        }
        
        const myDivisions = getEditableDivisions();
        
        if (!requestedDivisions || requestedDivisions.length === 0) {
            return myDivisions;
        }
        
        return requestedDivisions.filter(d => myDivisions.includes(d));
    }

    async function deleteMyDivisionsOnly(dateKey) {
        console.log('🗑️ [AccessControl] deleteMyDivisionsOnly called for:', dateKey);
        
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            console.log('🗑️ [AccessControl] Owner/Admin - use full delete instead');
            return null;
        }
        
        const myDivisions = getEditableDivisions();
        if (myDivisions.length === 0) {
            return { error: "No divisions assigned" };
        }
        
        console.log('🗑️ [AccessControl] Deleting divisions:', myDivisions);
        
        try {
            if (window.ScheduleDB?.deleteMyScheduleOnly) {
                console.log('🗑️ [AccessControl] Calling ScheduleDB.deleteMyScheduleOnly...');
                const cloudResult = await window.ScheduleDB.deleteMyScheduleOnly(dateKey);
                console.log('🗑️ [AccessControl] Cloud delete result:', cloudResult);
                
                if (!cloudResult?.success) {
                    console.error('🗑️ [AccessControl] Cloud delete failed:', cloudResult?.error);
                }
            } else {
                console.warn('🗑️ [AccessControl] ScheduleDB.deleteMyScheduleOnly not available!');
                const client = window.CampistryDB?.getClient?.() || window.supabase;
                const campId = window.CampistryDB?.getCampId?.() || getCampId();
                const userId = window.CampistryDB?.getUserId?.();
                
                if (client && campId && userId) {
                    console.log('🗑️ [AccessControl] Fallback: direct Supabase delete...');
                    const { error } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('camp_id', campId)
                        .eq('date_key', dateKey)
                        .eq('scheduler_id', userId);
                        
                    if (error) {
                        console.error('🗑️ [AccessControl] Fallback delete error:', error);
                    } else {
                        console.log('🗑️ [AccessControl] Fallback delete successful');
                    }
                }
            }
            
            const divisions = window.divisions || {};
            const bunksToRemove = new Set();
            
            for (const divName of myDivisions) {
                const divInfo = divisions[divName];
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => bunksToRemove.add(b));
                }
            }
            
            if (window.scheduleAssignments) {
                bunksToRemove.forEach(bunk => {
                    delete window.scheduleAssignments[bunk];
                });
                console.log('🗑️ [AccessControl] Cleared', bunksToRemove.size, 'bunks from window.scheduleAssignments');
            }
            
            if (window.leagueAssignments) {
                bunksToRemove.forEach(bunk => {
                    delete window.leagueAssignments[bunk];
                });
            }
            
            if (window.ScheduleDB?.loadSchedule) {
                console.log('🗑️ [AccessControl] Reloading remaining data...');
                await window.ScheduleDB.loadSchedule(dateKey);
            }
            
            return { success: true, deletedDivisions: myDivisions };
            
        } catch (e) {
            console.error('🗑️ [AccessControl] deleteMyDivisionsOnly error:', e);
            return { error: e.message };
        }
    }

    // =========================================================================
    // SUBDIVISION & TEAM MANAGEMENT
    // =========================================================================

    async function createSubdivision(name, divisions = [], color = null) {
        if (!canManageSubdivisions()) {
            return { error: "Not authorized" };
        }

        const subdivisionColor = color || getNextSubdivisionColor();
        const campId = getCampId();

        try {
            const { data, error } = await window.supabase
                .from('subdivisions')
                .insert([{
                    camp_id: campId,
                    name: name,
                    divisions: divisions,
                    color: subdivisionColor
                }])
                .select()
                .single();

            if (error) throw error;

            await loadSubdivisions();
            calculateEditableDivisions();

            return { data };

        } catch (e) {
            console.error("🔐 Error creating subdivision:", e);
            return { error: e.message };
        }
    }

    async function updateSubdivision(id, updates) {
        if (!canManageSubdivisions()) {
            return { error: "Not authorized" };
        }

        try {
            const { data, error } = await window.supabase
                .from('subdivisions')
                .update(updates)
                .eq('id', id)
                .select()
                .single();

            if (error) throw error;

            await loadSubdivisions();
            calculateEditableDivisions();

            return { data };

        } catch (e) {
            console.error("🔐 Error updating subdivision:", e);
            return { error: e.message };
        }
    }

    async function deleteSubdivision(id) {
        if (_currentRole !== ROLES.OWNER) {
            return { error: "Only owner can delete subdivisions" };
        }

        try {
            const { error } = await window.supabase
                .from('subdivisions')
                .delete()
                .eq('id', id);

            if (error) throw error;

            await loadSubdivisions();
            calculateEditableDivisions();

            return { success: true };

        } catch (e) {
            console.error("🔐 Error deleting subdivision:", e);
            return { error: e.message };
        }
    }

    async function getTeamMembers() {
        const campId = getCampId();
        
        try {
            const { data, error } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('camp_id', campId)
                .order('role');

            if (error) throw error;

            return { data: data || [] };

        } catch (e) {
            console.error("🔐 Error loading team:", e);
            return { data: [], error: e.message };
        }
    }

    async function inviteTeamMember(email, role, subdivisionIds = [], name = '') {
        if (!canInviteUsers()) {
            return { error: "Not authorized to invite users" };
        }

        if (!Object.values(ROLES).includes(role)) {
            return { error: "Invalid role" };
        }

        const inviteToken = crypto.randomUUID();
        const campId = getCampId();

        try {
            const { data, error } = await window.supabase
                .from('camp_users')
                .insert([{
                    camp_id: campId,
                    email: email.toLowerCase().trim(),
                    name: name || null,
                    role: role,
                    subdivision_ids: subdivisionIds,
                    invited_by: _currentUser.id,
                    invite_token: inviteToken
                }])
                .select()
                .single();

            if (error) throw error;

            const inviteUrl = `${window.location.origin}/invite.html?token=${inviteToken}`;

            return { 
                data,
                inviteUrl,
                message: `Invite created. Share this link with ${email}: ${inviteUrl}`
            };

        } catch (e) {
            console.error("🔐 Error inviting team member:", e);
            return { error: e.message };
        }
    }

    async function updateTeamMember(id, updates) {
        if (!canManageTeam()) {
            return { error: "Not authorized" };
        }

        try {
            const { data, error } = await window.supabase
                .from('camp_users')
                .update(updates)
                .eq('id', id)
                .select()
                .single();

            if (error) throw error;

            return { data };

        } catch (e) {
            console.error("🔐 Error updating team member:", e);
            return { error: e.message };
        }
    }

    async function removeTeamMember(id) {
        if (!canManageTeam()) {
            return { error: "Not authorized" };
        }

        try {
            const { error } = await window.supabase
                .from('camp_users')
                .delete()
                .eq('id', id);

            if (error) throw error;

            return { success: true };

        } catch (e) {
            console.error("🔐 Error removing team member:", e);
            return { error: e.message };
        }
    }

    async function acceptInvite(inviteToken) {
        if (!_currentUser) {
            return { error: "Must be logged in to accept invite" };
        }

        try {
            const { data: invite, error: findError } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('invite_token', inviteToken)
                .single();

            if (findError || !invite) {
                return { error: "Invalid or expired invite" };
            }

            if (invite.email.toLowerCase() !== _currentUser.email.toLowerCase()) {
                return { error: "This invite was sent to a different email address" };
            }

            const { data, error } = await window.supabase
                .from('camp_users')
                .update({
                    user_id: _currentUser.id,
                    accepted_at: new Date().toISOString(),
                    invite_token: null
                })
                .eq('id', invite.id)
                .select()
                .single();

            if (error) throw error;

            _campId = invite.camp_id;
            _currentRole = invite.role;
            _isTeamMember = true;
            _userSubdivisionIds = invite.subdivision_ids || [];
            _directDivisionAssignments = invite.assigned_divisions || [];
            _userName = invite.name || _currentUser.email.split('@')[0];
            
            localStorage.setItem('campistry_user_id', _campId);
            localStorage.setItem('campistry_auth_user_id', _currentUser.id);
            
            await loadSubdivisions();
            await loadUserSubdivisionDetails();
            calculateEditableDivisions();

            return { data, campId: invite.camp_id };

        } catch (e) {
            console.error("🔐 Error accepting invite:", e);
            return { error: e.message };
        }
    }

    async function assignDivisionsToMember(memberId, divisionNames) {
        if (!canManageTeam()) {
            return { error: "Not authorized" };
        }
        
        try {
            const { data, error } = await window.supabase
                .from('camp_users')
                .update({ assigned_divisions: divisionNames })
                .eq('id', memberId)
                .select()
                .single();
            
            if (error) throw error;
            
            return { data };
        } catch (e) {
            console.error("🔐 Error assigning divisions:", e);
            return { error: e.message };
        }
    }

    // =========================================================================
    // FIELD LOCKS
    // =========================================================================

    async function saveFieldLocks(date, locks) {
        const campId = getCampId();
        
        try {
            const { data, error } = await window.supabase
                .from('field_locks')
                .upsert({
                    camp_id: campId,
                    schedule_date: date,
                    locks: locks
                }, { onConflict: 'camp_id,schedule_date' });

            if (error) throw error;

            return { success: true };

        } catch (e) {
            console.error("🔐 Error saving field locks:", e);
            return { error: e.message };
        }
    }

    async function loadFieldLocks(date) {
        const campId = getCampId();
        
        try {
            const { data, error } = await window.supabase
                .from('field_locks')
                .select('locks')
                .eq('camp_id', campId)
                .eq('schedule_date', date)
                .maybeSingle();

            if (error) throw error;

            return { locks: data?.locks || {} };

        } catch (e) {
            console.error("🔐 Error loading field locks:", e);
            return { locks: {} };
        }
    }

    async function clearFieldLocks(date) {
        const campId = getCampId();
        
        try {
            const { error } = await window.supabase
                .from('field_locks')
                .delete()
                .eq('camp_id', campId)
                .eq('schedule_date', date);

            if (error) throw error;

            return { success: true };

        } catch (e) {
            console.error("🔐 Error clearing field locks:", e);
            return { error: e.message };
        }
    }

    // =========================================================================
    // DEBUG
    // =========================================================================

    function debugPrintState() {
        console.log("🔐 ==== ACCESS CONTROL STATE ====");
        console.log("Initialized:", _initialized);
        console.log("Current User:", _currentUser?.email);
        console.log("Current Role:", _currentRole);
        console.log("Is Team Member:", _isTeamMember);
        console.log("Camp ID:", _campId);
        console.log("Camp Name:", _campName);
        console.log("User Name:", _userName);
        console.log("User Subdivision IDs:", _userSubdivisionIds);
        console.log("User Subdivision Details:", _userSubdivisionDetails);
        console.log("Direct Division Assignments:", _directDivisionAssignments);
        console.log("All Subdivisions:", _subdivisions);
        console.log("Editable Divisions:", _editableDivisions);
        console.log("window.divisions keys:", Object.keys(window.divisions || {}));
        console.log("Membership subscription active:", !!_membershipSubscription);
        console.log("🔐 ==================================");
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const AccessControl = {
        initialize,
        refresh,
        get isInitialized() { return _initialized; },
        
        canEditDivision,
        canEditBunk,
        canGenerateDivision,
        getDivisionForBunk,
        
        canInviteUsers,
        canManageSubdivisions,
        canManageTeam,
        canDeleteCampData,
        canEraseData,
        canEraseAllCampData,  // ★ NEW v3.6
        canEditSetup,
        canEditFields,
        canEditGlobalFields,
        canEditAnything,
        canSave,
        canRunGenerator,
        getEditableBunkIds,
        canPrint,
        canEditPrintTemplates,
        canDeletePrintTemplates,
        canPrintSchedules,
        canUseCamperLocator,
        canViewDailySchedule,
        
        canAddFieldAvailability,
        canRemoveFieldAvailability,
        hasRoleAtLeast,
        
        canEdit,
        getRole,
        checkEditAccess,
        checkSetupAccess,
        checkDivisionAccess,
        checkBunkAccess,
        filterEditableBunks,
        filterEditableDivisions,
        
        isOwner,
        isAdmin,
        isViewer,
        isScheduler,
        isTeamMember,
        
        getEditableDivisions,
        getUserManagedDivisions,
        getGeneratableDivisions,
        getCurrentRole,
        getCurrentUserInfo,
        getSubdivisions,
        getAllSubdivisions,
        getUserSubdivisions,
        getUserSubdivisionDetails,
        getUserSubdivisionIds,
        getSubdivisionForDivision,
        isDivisionInUserSubdivisions,
        getDirectDivisionAssignments,
        getCampId,
        getUserName,
        getCampName,
        
        getWelcomeMessage,
        getPermissionsText,
        getRoleDisplay,
        getPermissionsSummary,
        
        getNextSubdivisionColor,
        SUBDIVISION_COLORS,
        
        createSubdivision,
        updateSubdivision,
        deleteSubdivision,
        
        getTeamMembers,
        inviteTeamMember,
        updateTeamMember,
        removeTeamMember,
        acceptInvite,
        assignDivisionsToMember,
        
        saveFieldLocks,
        loadFieldLocks,
        clearFieldLocks,
        
        getRoleDisplayName,
        getRoleColor,
        renderAccessBanner,
        showPermissionDenied,
        
        debugPrintState,
        
        deleteMyDivisionsOnly,
        filterDivisionsForGeneration,
        
        ROLES,
        ROLE_HIERARCHY
    };

    window.AccessControl = AccessControl;

    if (window.supabase) {
        window.supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session) {
                setTimeout(() => initialize(), 500);
            } else if (event === 'SIGNED_OUT') {
                // Clean up subscription
                if (_membershipSubscription) {
                    try { window.supabase?.removeChannel?.(_membershipSubscription); } catch(e) {}
                    _membershipSubscription = null;
                }
                // ★★★ v3.8: Clear session cache on logout ★★★
                try { sessionStorage.removeItem('campistry_rbac_cache'); } catch(e) {}
                _initialized = false;
                _currentUser = null;
                _currentRole = null;
                _campId = null;
                _campName = null;
                _userName = null;
                _subdivisions = [];
                _userSubdivisionIds = [];
                _userSubdivisionDetails = [];
                _directDivisionAssignments = [];
                _editableDivisions = [];
                _isTeamMember = false;
                _membership = null;
            }
        });
    }

    console.log("🔐 Access Control v3.8 loaded");

})();
