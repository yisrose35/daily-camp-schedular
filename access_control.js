// ============================================================================
// access_control.js — Campistry Role-Based Access Control (Multi-Tenant) v3.1
// ============================================================================
// FIXED VERSION - Addresses:
// 1. Returns FALSE (not true) when not initialized
// 2. Recalculates editable divisions when window.divisions changes
// 3. Better debugging output
// 4. Stricter enforcement at action level
// ============================================================================

(function() {
    'use strict';

    console.log("🔐 Access Control v3.1 (FIXED) loading...");

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
    let _userSubdivisionDetails = []; // Full details of assigned subdivisions
    let _editableDivisions = [];
    let _initialized = false;
    let _isTeamMember = false;
    let _membership = null;
    let _lastDivisionsHash = null; // Track if window.divisions changed

    const ROLES = {
        OWNER: 'owner',
        ADMIN: 'admin',
        SCHEDULER: 'scheduler',
        VIEWER: 'viewer'
    };

    // Role hierarchy for permission checks
    const ROLE_HIERARCHY = {
        owner: 4,
        admin: 3,
        scheduler: 2,
        viewer: 1
    };

    // Beautiful color palette for subdivisions
    const SUBDIVISION_COLORS = [
        '#6366F1', // Indigo
        '#8B5CF6', // Violet  
        '#EC4899', // Pink
        '#F43F5E', // Rose
        '#F97316', // Orange
        '#EAB308', // Yellow
        '#22C55E', // Green
        '#14B8A6', // Teal
        '#06B6D4', // Cyan
        '#3B82F6', // Blue
        '#A855F7', // Purple
        '#10B981', // Emerald
    ];

    // =========================================================================
    // DEBUG MODE
    // =========================================================================
    
    const DEBUG = true; // Set to false in production
    
    function debugLog(...args) {
        if (DEBUG) {
            console.log("🔐 [RBAC DEBUG]", ...args);
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
        
        // Wait for Supabase
        let attempts = 0;
        while (!window.supabase && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        
        if (!window.supabase) {
            console.error("🔐 Supabase not available");
            return;
        }

        // Get current user
        const { data: { user } } = await window.supabase.auth.getUser();
        if (!user) {
            console.log("🔐 No user logged in");
            return;
        }

        _currentUser = user;
        
        // Determine camp ID and user role
        await determineUserContext();
        
        // Load subdivisions for the camp
        await loadSubdivisions();
        
        // Load user's subdivision details if they're a scheduler
        if (_currentRole === ROLES.SCHEDULER && _userSubdivisionIds.length > 0) {
            await loadUserSubdivisionDetails();
        }
        
        // Calculate editable divisions based on role
        calculateEditableDivisions();
        
        _initialized = true;
        
        // Set up observer to recalculate when divisions change
        setupDivisionChangeObserver();
        
        // Dispatch event so UI can update
        window.dispatchEvent(new CustomEvent('campistry-access-loaded', {
            detail: {
                role: _currentRole,
                editableDivisions: _editableDivisions,
                subdivisions: _subdivisions,
                isTeamMember: _isTeamMember,
                userName: _userName,
                campName: _campName,
                userSubdivisionDetails: _userSubdivisionDetails,
                userSubdivisionIds: _userSubdivisionIds
            }
        }));
        
        console.log("🔐 Access control initialized:", {
            role: _currentRole,
            isTeamMember: _isTeamMember,
            userName: _userName,
            campName: _campName,
            userSubdivisionIds: _userSubdivisionIds,
            editableDivisions: _editableDivisions,
            allSubdivisions: _subdivisions.length
        });
        
        // Detailed debug output
        debugLog("=== RBAC STATE ===");
        debugLog("User:", _currentUser?.email);
        debugLog("Role:", _currentRole);
        debugLog("Is Team Member:", _isTeamMember);
        debugLog("User Subdivision IDs:", _userSubdivisionIds);
        debugLog("User Subdivision Details:", _userSubdivisionDetails);
        debugLog("All Subdivisions:", _subdivisions);
        debugLog("Editable Divisions:", _editableDivisions);
        debugLog("window.divisions:", Object.keys(window.divisions || {}));
        debugLog("==================");
    }

    // =========================================================================
    // DIVISION CHANGE OBSERVER
    // =========================================================================
    
    function setupDivisionChangeObserver() {
        // Check periodically if window.divisions has changed
        setInterval(() => {
            const currentHash = JSON.stringify(Object.keys(window.divisions || {}).sort());
            if (currentHash !== _lastDivisionsHash && _lastDivisionsHash !== null) {
                debugLog("window.divisions changed, recalculating editable divisions");
                calculateEditableDivisions();
            }
            _lastDivisionsHash = currentHash;
        }, 1000);
    }

    // =========================================================================
    // DETERMINE USER CONTEXT
    // =========================================================================

    async function determineUserContext() {
        console.log("🔐 Determining user context...");
        
        // First, check if user owns any camps
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
                _userSubdivisionIds = []; // Empty = access to all
                
                // Store in localStorage
                localStorage.setItem('campistry_user_id', _campId);
                localStorage.setItem('campistry_auth_user_id', _currentUser.id);
                return;
            }
        } catch (e) {
            console.warn("🔐 Error checking camp ownership:", e);
        }
        
        // Not an owner - check if they're a team member
        try {
            const { data: memberData, error } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('user_id', _currentUser.id)
                .not('accepted_at', 'is', null)
                .maybeSingle();
            
            debugLog("Team member query result:", { memberData, error });
            
            if (memberData) {
                console.log("🔐 User is a team member:", memberData.role);
                debugLog("Member data subdivision_ids:", memberData.subdivision_ids);
                
                _currentRole = memberData.role || ROLES.VIEWER;
                _isTeamMember = true;
                _campId = memberData.camp_id;
                _userName = memberData.name || _currentUser.email.split('@')[0];
                
                // CRITICAL: Properly load subdivision_ids
                _userSubdivisionIds = memberData.subdivision_ids || [];
                
                // Validate that subdivision_ids is actually an array
                if (!Array.isArray(_userSubdivisionIds)) {
                    console.warn("🔐 subdivision_ids is not an array:", _userSubdivisionIds);
                    _userSubdivisionIds = [];
                }
                
                _membership = memberData;
                
                debugLog("Loaded subdivision IDs:", _userSubdivisionIds);
                
                // Fetch camp name
                const { data: campData } = await window.supabase
                    .from('camps')
                    .select('name')
                    .eq('owner', memberData.camp_id)
                    .maybeSingle();
                
                _campName = campData?.name || 'Your Camp';
                
                // Store camp ID for cloud storage to use
                localStorage.setItem('campistry_user_id', _campId);
                localStorage.setItem('campistry_auth_user_id', _currentUser.id);
                return;
            }
        } catch (e) {
            console.warn("🔐 Error checking team membership:", e);
        }
        
        // User is neither owner nor team member - default to their ID as new camp
        console.log("🔐 User is a new camp owner (first time)");
        _currentRole = ROLES.OWNER;
        _isTeamMember = false;
        _campId = _currentUser.id;
        _campName = 'Your Camp';
        _userName = _currentUser.email.split('@')[0];
        _userSubdivisionIds = [];
        localStorage.setItem('campistry_user_id', _campId);
        localStorage.setItem('campistry_auth_user_id', _currentUser.id);
    }

    /**
     * Get the camp ID (works for both owners and team members)
     */
    function getCampId() {
        if (_campId) return _campId;
        
        // Fallback to localStorage
        const cached = localStorage.getItem('campistry_user_id');
        if (cached && cached !== 'demo_camp_001') return cached;
        
        return _currentUser?.id || 'demo_camp_001';
    }

    // =========================================================================
    // LOAD SUBDIVISIONS
    // =========================================================================

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
            debugLog("Subdivisions:", _subdivisions);

        } catch (e) {
            console.error("🔐 Error loading subdivisions:", e);
            _subdivisions = [];
        }
    }

    /**
     * Load detailed info about user's assigned subdivisions
     */
    async function loadUserSubdivisionDetails() {
        if (!_userSubdivisionIds || _userSubdivisionIds.length === 0) {
            debugLog("No user subdivision IDs to load details for");
            _userSubdivisionDetails = [];
            return;
        }

        debugLog("Loading details for subdivision IDs:", _userSubdivisionIds);

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
            debugLog("User subdivision details:", _userSubdivisionDetails);

        } catch (e) {
            console.error("🔐 Error loading user subdivision details:", e);
            _userSubdivisionDetails = [];
        }
    }

    // =========================================================================
    // CALCULATE EDITABLE DIVISIONS
    // =========================================================================

    function calculateEditableDivisions() {
        const allDivisions = Object.keys(window.divisions || {});
        
        debugLog("Calculating editable divisions...");
        debugLog("All divisions in window.divisions:", allDivisions);
        debugLog("Current role:", _currentRole);
        debugLog("User subdivision IDs:", _userSubdivisionIds);
        
        // Owner and Admin can edit everything
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            _editableDivisions = [...allDivisions];
            console.log("🔐 Full edit access:", _editableDivisions.length, "divisions");
            return;
        }
        
        // Viewer can't edit anything
        if (_currentRole === ROLES.VIEWER) {
            _editableDivisions = [];
            console.log("🔐 View-only access");
            return;
        }
        
        // Scheduler: check subdivision assignments
        if (_currentRole === ROLES.SCHEDULER) {
            // CHANGED: If no subdivision restrictions, scheduler still needs assignments
            // Empty subdivision_ids now means NO ACCESS, not full access
            // This is a policy change - uncomment the old behavior if you want empty = full access
            
            /*
            // OLD BEHAVIOR (empty = full access):
            if (!_userSubdivisionIds || _userSubdivisionIds.length === 0) {
                _editableDivisions = [...allDivisions];
                console.log("🔐 Scheduler with full access (no subdivision restrictions)");
                return;
            }
            */
            
            // NEW BEHAVIOR (empty = no access):
            if (!_userSubdivisionIds || _userSubdivisionIds.length === 0) {
                _editableDivisions = [];
                console.warn("🔐 Scheduler has NO subdivision assignments - no edit access!");
                console.warn("🔐 Assign this scheduler to subdivisions to grant edit access");
                return;
            }
            
            // Get divisions from assigned subdivisions
            const editableDivs = new Set();
            
            // Use the detailed subdivision info if available
            if (_userSubdivisionDetails && _userSubdivisionDetails.length > 0) {
                debugLog("Using user subdivision details to determine editable divisions");
                _userSubdivisionDetails.forEach(sub => {
                    debugLog(`  Subdivision "${sub.name}" has divisions:`, sub.divisions);
                    if (sub.divisions && Array.isArray(sub.divisions)) {
                        sub.divisions.forEach(d => {
                            debugLog(`    Adding "${d}" to editable divisions`);
                            editableDivs.add(d);
                        });
                    }
                });
            } else {
                debugLog("Falling back to looking up subdivisions by ID");
                // Fallback to looking up in all subdivisions
                _userSubdivisionIds.forEach(subId => {
                    const sub = _subdivisions.find(s => s.id === subId);
                    debugLog(`  Looking up subdivision ID ${subId}:`, sub);
                    if (sub && sub.divisions && Array.isArray(sub.divisions)) {
                        sub.divisions.forEach(d => {
                            debugLog(`    Adding "${d}" to editable divisions`);
                            editableDivs.add(d);
                        });
                    }
                });
            }
            
            _editableDivisions = [...editableDivs];
            console.log("🔐 Scheduler restricted to:", _editableDivisions);
            debugLog("Final editable divisions:", _editableDivisions);
            return;
        }
        
        // Default: no edit access
        _editableDivisions = [];
    }

    // =========================================================================
    // PUBLIC API - PERMISSION CHECKS
    // =========================================================================

    /**
     * Check if current user can edit a specific division
     * FIXED: Returns FALSE when not initialized (was returning true)
     */
    function canEditDivision(divisionName) {
        // FIXED: Default to DENY when not initialized
        if (!_initialized) {
            console.warn("🔐 Access control not initialized - DENYING access to", divisionName);
            return false; // CHANGED from true to false
        }
        
        // Owner and Admin can edit all
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return true;
        }
        
        // Viewer can't edit
        if (_currentRole === ROLES.VIEWER) {
            return false;
        }
        
        // Scheduler - check editable divisions
        const canEdit = _editableDivisions.includes(divisionName);
        
        debugLog(`canEditDivision("${divisionName}"): ${canEdit}`, 
            `(editable: [${_editableDivisions.join(', ')}])`);
        
        return canEdit;
    }

    /**
     * Check if current user can edit a specific bunk
     */
    function canEditBunk(bunkName) {
        // FIXED: Default to DENY when not initialized
        if (!_initialized) {
            console.warn("🔐 Access control not initialized - DENYING access to bunk", bunkName);
            return false;
        }
        
        // Viewers can't edit anything
        if (_currentRole === ROLES.VIEWER) return false;
        
        // Owners and admins can edit all bunks
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        
        // Schedulers: check if bunk is in an editable division
        if (_currentRole === ROLES.SCHEDULER) {
            // If no editable divisions, can't edit any bunks
            if (_editableDivisions.length === 0) {
                return false;
            }
            
            // Find which division this bunk belongs to
            const divisions = window.divisions || window.getDivisions?.() || {};
            for (const [divName, divData] of Object.entries(divisions)) {
                if (divData.bunks && divData.bunks.includes(bunkName)) {
                    const canEdit = _editableDivisions.includes(divName);
                    debugLog(`canEditBunk("${bunkName}"): ${canEdit} (belongs to "${divName}")`);
                    return canEdit;
                }
            }
            
            debugLog(`canEditBunk("${bunkName}"): false (bunk not found in any division)`);
            return false;
        }
        
        return false;
    }

    /**
     * Get the division a bunk belongs to
     */
    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || window.getDivisions?.() || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    }

    /**
     * Check if current user can generate schedule for a division
     */
    function canGenerateDivision(divisionName) {
        return canEditDivision(divisionName);
    }

    /**
     * Check if current user can invite other users
     */
    function canInviteUsers() {
        return _currentRole === ROLES.OWNER;
    }

    /**
     * Check if current user can manage subdivisions
     */
    function canManageSubdivisions() {
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    /**
     * Check if current user can edit team members
     */
    function canManageTeam() {
        return _currentRole === ROLES.OWNER;
    }

    /**
     * Check if current user has any edit permissions
     */
    function canEditAnything() {
        if (!_initialized) return false; // FIXED
        if (_currentRole === ROLES.VIEWER) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        return _editableDivisions.length > 0;
    }
    
    /**
     * Check if current user can save/modify data
     */
    function canSave() {
        if (!_initialized) return false; // FIXED
        return _currentRole !== ROLES.VIEWER;
    }

    /**
     * Check if user can print schedules
     */
    function canPrint() {
        return _currentRole !== ROLES.VIEWER;
    }

    /**
     * Check if user can add a division's availability to a field
     * Schedulers can only add their own divisions
     */
    function canAddFieldAvailability(divisionName) {
        if (!_initialized) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        if (_currentRole === ROLES.SCHEDULER) return canEditDivision(divisionName);
        return false;
    }

    /**
     * Check if user can remove a division's availability from a field
     * Schedulers can ONLY remove their own divisions, NOT others
     */
    function canRemoveFieldAvailability(divisionName) {
        if (!_initialized) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        if (_currentRole === ROLES.SCHEDULER) return canEditDivision(divisionName);
        return false;
    }

    /**
     * Check if user has at least a certain role level
     */
    function hasRoleAtLeast(requiredRole) {
        const currentLevel = ROLE_HIERARCHY[_currentRole] || 0;
        const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
        return currentLevel >= requiredLevel;
    }

    /**
     * Get list of divisions user can edit
     */
    function getEditableDivisions() {
        return [..._editableDivisions];
    }

    /**
     * Get list of divisions user can generate
     */
    function getGeneratableDivisions() {
        return getEditableDivisions();
    }

    /**
     * Get user's current role
     */
    function getCurrentRole() {
        return _currentRole;
    }
    
    /**
     * Check if user is a team member (vs owner)
     */
    function isTeamMember() {
        return _isTeamMember;
    }

    /**
     * Check if user is owner
     */
    function isOwner() {
        return _currentRole === ROLES.OWNER;
    }

    /**
     * Check if user is admin or owner
     */
    function isAdmin() {
        return _currentRole === ROLES.ADMIN || _currentRole === ROLES.OWNER;
    }

    /**
     * Check if user is viewer only
     */
    function isViewer() {
        return _currentRole === ROLES.VIEWER;
    }

    /**
     * Get all subdivisions
     */
    function getSubdivisions() {
        return [..._subdivisions];
    }

    /**
     * Alias for getSubdivisions - used by SubdivisionScheduleManager
     */
    function getAllSubdivisions() {
        return [..._subdivisions];
    }

    /**
     * Get current user info object
     */
    function getCurrentUserInfo() {
        if (!_currentUser) return null;
        return {
            userId: _currentUser.id,
            email: _currentUser.email,
            name: _userName || _currentUser.email?.split('@')[0] || 'Unknown'
        };
    }

    /**
     * Get user's assigned subdivisions
     */
    function getUserSubdivisions() {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return [..._subdivisions];
        }
        
        return _subdivisions.filter(s => _userSubdivisionIds.includes(s.id));
    }

    /**
     * Get subdivision name for a division
     */
    function getSubdivisionForDivision(divisionName) {
        for (const sub of _subdivisions) {
            if (sub.divisions && sub.divisions.includes(divisionName)) {
                return sub;
            }
        }
        return null;
    }

    /**
     * Check if a division belongs to user's subdivisions
     */
    function isDivisionInUserSubdivisions(divisionName) {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return true;
        }
        
        const userSubs = getUserSubdivisions();
        return userSubs.some(sub => sub.divisions && sub.divisions.includes(divisionName));
    }

    // =========================================================================
    // WELCOME MESSAGE & PERMISSIONS DISPLAY
    // =========================================================================

    /**
     * Get personalized welcome message
     */
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

    /**
     * Get human-readable permissions text
     */
    function getPermissionsText() {
        if (_currentRole === ROLES.OWNER) {
            return 'Full access to all features';
        }
        
        if (_currentRole === ROLES.ADMIN) {
            return 'Full editing access to all divisions';
        }
        
        if (_currentRole === ROLES.VIEWER) {
            return 'View-only access';
        }
        
        if (_currentRole === ROLES.SCHEDULER) {
            // Get subdivision names
            let names = [];
            
            if (_userSubdivisionDetails && _userSubdivisionDetails.length > 0) {
                names = _userSubdivisionDetails.map(s => s.name);
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

    /**
     * Get role display info for UI
     */
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
            admin: 'Full editing access to all divisions',
            scheduler: 'Edit access to assigned divisions only',
            viewer: 'View-only access to schedules'
        };
        
        return {
            role: _currentRole,
            name: roleNames[_currentRole] || _currentRole,
            color: roleColors[_currentRole] || '#6B7280',
            description: roleDescriptions[_currentRole] || '',
            subdivisionDetails: _userSubdivisionDetails || []
        };
    }

    /**
     * Get permissions summary for display
     */
    function getPermissionsSummary() {
        const permissions = [];
        
        if (_currentRole === ROLES.OWNER) {
            permissions.push({ icon: '👑', text: 'Full access to all features' });
            permissions.push({ icon: '👥', text: 'Manage team members' });
            permissions.push({ icon: '⚙️', text: 'Camp settings' });
        } else if (_currentRole === ROLES.ADMIN) {
            permissions.push({ icon: '✏️', text: 'Edit all divisions and schedules' });
            permissions.push({ icon: '🖨️', text: 'Print any schedule' });
            permissions.push({ icon: '📊', text: 'Full reporting access' });
        } else if (_currentRole === ROLES.SCHEDULER) {
            if (_userSubdivisionDetails && _userSubdivisionDetails.length > 0) {
                const names = _userSubdivisionDetails.map(s => s.name).join(', ');
                permissions.push({ icon: '✏️', text: `Edit: ${names}` });
            } else if (_editableDivisions.length > 0) {
                permissions.push({ icon: '✏️', text: `Edit: ${_editableDivisions.join(', ')}` });
            } else {
                permissions.push({ icon: '⚠️', text: 'No divisions assigned - contact owner' });
            }
            permissions.push({ icon: '🖨️', text: 'Print any schedule' });
            permissions.push({ icon: '👁️', text: 'View all schedules' });
        } else {
            permissions.push({ icon: '👁️', text: 'View all schedules' });
            permissions.push({ icon: '🔍', text: 'Camper lookup' });
            permissions.push({ icon: '❓', text: 'Help & documentation' });
        }
        
        return permissions;
    }

    /**
     * Get the user's name
     */
    function getUserName() {
        return _userName;
    }

    /**
     * Get the camp name
     */
    function getCampName() {
        return _campName;
    }

    /**
     * Get user's assigned subdivision details
     */
    function getUserSubdivisionDetails() {
        return [..._userSubdivisionDetails];
    }
    
    /**
     * Get user's assigned subdivision IDs
     */
    function getUserSubdivisionIds() {
        return [..._userSubdivisionIds];
    }

    // =========================================================================
    // COLOR MANAGEMENT
    // =========================================================================

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
    // V3.0 QUICK-CHECK HELPERS
    // =========================================================================

    /**
     * Check if user can edit (scheduler or higher) - alias for canEditAnything
     */
    function canEdit() {
        return canEditAnything();
    }

    /**
     * Get current role - alias for getCurrentRole
     */
    function getRole() {
        return _currentRole;
    }

    /**
     * Check if user can edit camp setup (Owner/Admin only)
     */
    function canEditSetup() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    /**
     * Check if user can edit field configuration (Owner/Admin only)
     */
    function canEditFields() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    /**
     * Check if user can erase/delete data (Owner only)
     */
    function canEraseData() {
        if (!_initialized) return false;
        return _currentRole === ROLES.OWNER;
    }

    /**
     * Quick check with automatic error message for edit operations
     */
    function checkEditAccess(action) {
        if (!canEdit()) {
            showPermissionDenied(action || 'edit');
            return false;
        }
        return true;
    }

    /**
     * Quick check with automatic error message for setup operations
     */
    function checkSetupAccess(action) {
        if (!canEditSetup()) {
            showPermissionDenied(action || 'modify setup');
            return false;
        }
        return true;
    }

    /**
     * Check division-specific access with automatic error message
     */
    function checkDivisionAccess(divisionName, action) {
        if (!canEditDivision(divisionName)) {
            showPermissionDenied(action || `edit ${divisionName}`);
            return false;
        }
        return true;
    }

    /**
     * Check bunk-specific access with automatic error message
     */
    function checkBunkAccess(bunkName, action) {
        if (!canEditBunk(bunkName)) {
            showPermissionDenied(action || `edit ${bunkName}`);
            return false;
        }
        return true;
    }

    /**
     * Filter list of bunks to only those user can edit
     */
    function filterEditableBunks(bunks) {
        if (!Array.isArray(bunks)) return [];
        if (!_initialized) return []; // FIXED
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return bunks;
        if (!canEdit()) return [];
        return bunks.filter(b => canEditBunk(b));
    }

    /**
     * Filter list of divisions to only those user can edit
     */
    function filterEditableDivisions(divisionNames) {
        if (!Array.isArray(divisionNames)) return [];
        if (!_initialized) return []; // FIXED
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return divisionNames;
        if (!canEdit()) return [];
        return divisionNames.filter(d => canEditDivision(d));
    }

    // =========================================================================
    // SUBDIVISION MANAGEMENT (Owners/Admins only)
    // =========================================================================

    async function createSubdivision(name, divisions = [], color = null) {
        if (!canManageSubdivisions()) {
            console.error("🔐 Not authorized to create subdivisions");
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

    // =========================================================================
    // TEAM MANAGEMENT (Owners only)
    // =========================================================================

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

        debugLog("Creating invite with subdivision_ids:", subdivisionIds);

        try {
            const { data, error } = await window.supabase
                .from('camp_users')
                .insert([{
                    camp_id: campId,
                    email: email.toLowerCase().trim(),
                    name: name || null,
                    role: role,
                    subdivision_ids: subdivisionIds, // CRITICAL: Make sure this is saved
                    invited_by: _currentUser.id,
                    invite_token: inviteToken
                }])
                .select()
                .single();

            if (error) throw error;
            
            debugLog("Invite created with data:", data);

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

        debugLog("Updating team member", id, "with:", updates);

        try {
            const { data, error } = await window.supabase
                .from('camp_users')
                .update(updates)
                .eq('id', id)
                .select()
                .single();

            if (error) throw error;
            
            debugLog("Team member updated:", data);

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

            // Update local state
            _campId = invite.camp_id;
            _currentRole = invite.role;
            _isTeamMember = true;
            _userSubdivisionIds = invite.subdivision_ids || [];
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

    // =========================================================================
    // FIELD LOCKS PERSISTENCE
    // =========================================================================

    async function saveFieldLocks(date, locks, generatedDivisions) {
        const campId = getCampId();
        
        try {
            const { data, error } = await window.supabase
                .from('field_locks')
                .upsert({
                    camp_id: campId,
                    schedule_date: date,
                    locks: locks,
                    generated_divisions: generatedDivisions,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'camp_id,schedule_date'
                })
                .select()
                .single();

            if (error) throw error;

            console.log("🔐 Field locks saved for", date);
            return { data };

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
                .select('*')
                .eq('camp_id', campId)
                .eq('schedule_date', date)
                .maybeSingle();

            if (error) throw error;

            return { 
                data: data || null,
                locks: data?.locks || {},
                generatedDivisions: data?.generated_divisions || []
            };

        } catch (e) {
            console.error("🔐 Error loading field locks:", e);
            return { locks: {}, generatedDivisions: [], error: e.message };
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

    /**
     * Show toast notification for permission denied
     */
    function showPermissionDenied(action = 'perform this action') {
        if (typeof window.showToast === 'function') {
            window.showToast(`You don't have permission to ${action}`, 'error');
        } else {
            // Create inline toast
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
        
        // Don't show for owner/admin with full access
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return;
        
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
        
        if (_currentRole === ROLES.VIEWER) {
            banner.innerHTML = `
                <span style="font-size: 1.2rem;">👁️</span>
                <div>
                    <strong>View Only Mode</strong>
                    <div style="font-size: 0.85rem; color: #92400E;">
                        You can view all schedules but cannot make changes.
                    </div>
                </div>
            `;
        } else if (_currentRole === ROLES.SCHEDULER) {
            const permText = getPermissionsText();
            const editableDivsList = _editableDivisions.length > 0 
                ? _editableDivisions.join(', ')
                : 'None (contact owner to assign subdivisions)';
            
            banner.innerHTML = `
                <span style="font-size: 1.2rem;">🔓</span>
                <div>
                    <strong>${permText}</strong>
                    <div style="font-size: 0.85rem; color: #92400E;">
                        You can edit: ${editableDivsList}
                    </div>
                </div>
            `;
        }
        
        const container = document.getElementById('main-app-container') || document.body;
        const firstChild = container.firstChild;
        container.insertBefore(banner, firstChild);
    }

    // =========================================================================
    // REFRESH
    // =========================================================================

    async function refresh() {
        _initialized = false;
        await initialize();
        renderAccessBanner();
    }
    
    // =========================================================================
    // DEBUG FUNCTIONS
    // =========================================================================
    
    /**
     * Print current RBAC state to console (for debugging)
     */
    function debugPrintState() {
        console.log("🔐 ========== RBAC STATE ==========");
        console.log("Initialized:", _initialized);
        console.log("Current User:", _currentUser?.email);
        console.log("Current Role:", _currentRole);
        console.log("Is Team Member:", _isTeamMember);
        console.log("Camp ID:", _campId);
        console.log("Camp Name:", _campName);
        console.log("User Name:", _userName);
        console.log("User Subdivision IDs:", _userSubdivisionIds);
        console.log("User Subdivision Details:", _userSubdivisionDetails);
        console.log("All Subdivisions:", _subdivisions);
        console.log("Editable Divisions:", _editableDivisions);
        console.log("window.divisions keys:", Object.keys(window.divisions || {}));
        console.log("🔐 ==================================");
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const AccessControl = {
        // Initialization
        initialize,
        refresh,
        get isInitialized() { return _initialized; },
        
        // Permission checks
        canEditDivision,
        canGenerateDivision,
        canInviteUsers,
        canManageSubdivisions,
        canManageTeam,
        canEditAnything,
        canSave,
        canPrint,
        canAddFieldAvailability,
        canRemoveFieldAvailability,
        hasRoleAtLeast,
        
        // V3.0 Quick-check helpers
        canEdit,
        getRole,
        canEditSetup,
        canEditFields,
        canEraseData,
        checkEditAccess,
        checkSetupAccess,
        checkDivisionAccess,
        checkBunkAccess,
        canEditBunk,
        filterEditableBunks,
        filterEditableDivisions,
        getDivisionForBunk,
        
        // Role checks
        isOwner,
        isAdmin,
        isViewer,
        isTeamMember,
        
        // Getters
        getEditableDivisions,
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
        getCampId,
        getUserName,
        getCampName,
        
        // Welcome & Permissions display
        getWelcomeMessage,
        getPermissionsText,
        getRoleDisplay,
        getPermissionsSummary,
        
        // Color management
        getNextSubdivisionColor,
        SUBDIVISION_COLORS,
        
        // Subdivision management
        createSubdivision,
        updateSubdivision,
        deleteSubdivision,
        
        // Team management
        getTeamMembers,
        inviteTeamMember,
        updateTeamMember,
        removeTeamMember,
        acceptInvite,
        
        // Field locks
        saveFieldLocks,
        loadFieldLocks,
        clearFieldLocks,
        
        // UI helpers
        getRoleDisplayName,
        getRoleColor,
        renderAccessBanner,
        showPermissionDenied,
        
        // Debug
        debugPrintState,
        
        // Constants
        ROLES,
        ROLE_HIERARCHY
    };

    window.AccessControl = AccessControl;

    // Auto-initialize when auth is ready
    if (window.supabase) {
        window.supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session) {
                setTimeout(() => initialize(), 500);
            } else if (event === 'SIGNED_OUT') {
                _initialized = false;
                _currentUser = null;
                _currentRole = null;
                _campId = null;
                _campName = null;
                _userName = null;
                _subdivisions = [];
                _userSubdivisionIds = [];
                _userSubdivisionDetails = [];
                _editableDivisions = [];
                _isTeamMember = false;
                _membership = null;
            }
        });
    }

    console.log("🔐 Access Control v3.1 (FIXED) loaded");

})();
