// ============================================================================
// access_control.js — Campistry Role-Based Access Control (Multi-Tenant) v3.5
// ============================================================================
// UPDATED VERSION v3.5 - FIXED: Check team membership BEFORE camp ownership
// 
// Permission model:
// - OWNER: Full access to everything
// - ADMIN: Full access except delete camp data and invite users
// - SCHEDULER: Edit only assigned divisions, view all (greyed out for others)
// - VIEWER: View only, but can use Print Center and Camper Locator
//
// Division assignment methods (scheduler):
// 1. Via subdivisions (preferred): scheduler assigned to subdivision_ids, divisions come from subdivision
// 2. Via direct assignment (fallback): scheduler has assigned_divisions array directly
//
// EXCEPTIONS (accessible by all roles including viewers):
// - Daily Schedule View (read-only for viewers)
// - Print Center (full functionality)
// - Camper Locator (full functionality)
// ============================================================================

(function() {
    'use strict';

    console.log("🔐 Access Control v3.5 loading...");

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
    let _directDivisionAssignments = []; // ⭐ NEW: Direct division assignments fallback
    let _editableDivisions = [];
    let _initialized = false;
    let _isTeamMember = false;
    let _membership = null;
    let _lastDivisionsHash = null;

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
        
        await determineUserContext();
        await loadSubdivisions();
        
        if (_currentRole === ROLES.SCHEDULER && _userSubdivisionIds.length > 0) {
            await loadUserSubdivisionDetails();
        }
        
        calculateEditableDivisions();
        
        _initialized = true;
        
        setupDivisionChangeObserver();
        
        // ⭐ Show warning banner if scheduler has no access
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
            if (currentHash !== _lastDivisionsHash && _lastDivisionsHash !== null) {
                debugLog("window.divisions changed, recalculating editable divisions");
                calculateEditableDivisions();
            }
            _lastDivisionsHash = currentHash;
        }, 1000);
    }

    // =========================================================================
    // ⭐ FIXED: Check team membership FIRST, then camp ownership
    // =========================================================================
    async function determineUserContext() {
        console.log("🔐 Determining user context...");
        
        // =====================================================================
        // ⭐ STEP 1: Check if user is a TEAM MEMBER first (HIGHEST PRIORITY)
        // This ensures invited users get their correct assigned role
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
                subdivision_ids: memberData?.subdivision_ids,
                assigned_divisions: memberData?.assigned_divisions,
                error: error?.message 
            });
            
            if (memberData) {
                console.log("🔐 ✅ User IS a team member:", memberData.role);
                
                _currentRole = memberData.role || ROLES.VIEWER;
                _isTeamMember = true;
                _campId = memberData.camp_id;
                _userName = memberData.name || _currentUser.email.split('@')[0];
                _userSubdivisionIds = memberData.subdivision_ids || [];
                _directDivisionAssignments = memberData.assigned_divisions || [];
                
                if (!Array.isArray(_userSubdivisionIds)) {
                    console.warn("🔐 subdivision_ids is not an array:", _userSubdivisionIds);
                    _userSubdivisionIds = [];
                }
                
                if (!Array.isArray(_directDivisionAssignments)) {
                    _directDivisionAssignments = [];
                }
                
                _membership = memberData;
                
                // Get camp name
                const { data: campData } = await window.supabase
                    .from('camps')
                    .select('name')
                    .eq('owner', memberData.camp_id)
                    .maybeSingle();
                
                _campName = campData?.name || 'Your Camp';
                
                localStorage.setItem('campistry_user_id', _campId);
                localStorage.setItem('campistry_auth_user_id', _currentUser.id);
                
                // Log warning if scheduler has no assignments
                if (_currentRole === ROLES.SCHEDULER && 
                    _userSubdivisionIds.length === 0 && 
                    _directDivisionAssignments.length === 0) {
                    console.warn("🔐 ⚠️ SCHEDULER HAS NO SUBDIVISION OR DIVISION ASSIGNMENTS!");
                }
                
                return; // ⭐ IMPORTANT: Exit here - don't check camp ownership
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
                    // Recursively call to set up role properly
                    return await determineUserContext();
                }
            }
        } catch (e) {
            console.warn("🔐 Error checking pending invite:", e);
        }
        
        // =====================================================================
        // ⭐ STEP 3: Check if user is a CAMP OWNER (only if not a team member)
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
        // ⭐ STEP 4: Fallback - New camp owner (first time user)
        // =====================================================================
        console.log("🔐 User is a new camp owner (first time)");
        _currentRole = ROLES.OWNER;
        _isTeamMember = false;
        _campId = _currentUser.id;
        _campName = 'Your Camp';
        _userName = _currentUser.email.split('@')[0];
        _userSubdivisionIds = [];
        _directDivisionAssignments = [];
        localStorage.setItem('campistry_user_id', _campId);
        localStorage.setItem('campistry_auth_user_id', _currentUser.id);
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
            
            // ⭐ Log subdivision details for debugging
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
        debugLog("All divisions:", allDivisions);
        debugLog("Current role:", _currentRole);
        debugLog("User subdivision IDs:", _userSubdivisionIds);
        debugLog("Direct division assignments:", _directDivisionAssignments);
        
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
        
        // Scheduler: check subdivision assignments AND direct assignments
        if (_currentRole === ROLES.SCHEDULER) {
            const editableDivs = new Set();
            
            // ⭐ Method 1: Via subdivisions (preferred)
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
                
                if (editableDivs.size > 0) {
                    _editableDivisions = [...editableDivs];
                    console.log("🔐 Scheduler access via subdivisions:", _editableDivisions);
                    return;
                }
            }
            
            // ⭐ Method 2: Via direct division assignments (fallback)
            if (_directDivisionAssignments && _directDivisionAssignments.length > 0) {
                _directDivisionAssignments.forEach(d => {
                    if (allDivisions.includes(d)) {
                        editableDivs.add(d);
                    }
                });
                
                if (editableDivs.size > 0) {
                    _editableDivisions = [...editableDivs];
                    console.log("🔐 Scheduler access via direct assignments:", _editableDivisions);
                    return;
                }
            }
            
            // No access configured
            _editableDivisions = [];
            console.warn("🔐 Scheduler has NO edit access - no subdivisions or divisions assigned!");
            return;
        }
        
        _editableDivisions = [];
    }

    // =========================================================================
    // NO ACCESS WARNING
    // =========================================================================
    
    function showNoAccessWarning() {
        // Check if already shown
        if (document.getElementById('no-access-warning-banner')) return;
        
        const banner = document.createElement('div');
        banner.id = 'no-access-warning-banner';
        banner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: linear-gradient(135deg, #FEE2E2, #FECACA);
            border-bottom: 2px solid #EF4444;
            padding: 16px 24px;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            font-family: 'Outfit', sans-serif;
        `;
        
        banner.innerHTML = `
            <span style="font-size: 1.5rem;">⚠️</span>
            <div>
                <strong style="color: #991B1B;">No Divisions Assigned</strong>
                <div style="color: #B91C1C; font-size: 0.9rem;">
                    You're logged in as a Scheduler but haven't been assigned any divisions yet. 
                    Please contact the camp owner to be assigned to subdivisions.
                </div>
            </div>
            <button id="dismiss-no-access-warning" style="
                background: #B91C1C;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                margin-left: 20px;
            ">Dismiss</button>
        `;
        
        document.body.prepend(banner);
        
        // Add dismiss handler
        document.getElementById('dismiss-no-access-warning').onclick = () => {
            banner.remove();
        };
        
        // Also adjust main content
        const mainApp = document.getElementById('main-app-container');
        if (mainApp) {
            mainApp.style.marginTop = '80px';
        }
    }

    // =========================================================================
    // PERMISSION CHECKS - Core
    // =========================================================================

    function canEditDivision(divisionName) {
        if (!_initialized) {
            console.warn("🔐 Access control not initialized - DENYING access to", divisionName);
            return false;
        }
        
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return true;
        }
        
        if (_currentRole === ROLES.VIEWER) {
            return false;
        }
        
        return _editableDivisions.includes(divisionName);
    }

    function canEditBunk(bunkName) {
        if (!_initialized) {
            return false;
        }
        
        if (_currentRole === ROLES.VIEWER) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        
        if (_currentRole === ROLES.SCHEDULER) {
            if (_editableDivisions.length === 0) return false;
            
            const divisions = window.divisions || {};
            for (const [divName, divData] of Object.entries(divisions)) {
                if (divData.bunks && divData.bunks.includes(bunkName)) {
                    return _editableDivisions.includes(divName);
                }
            }
            return false;
        }
        
        return false;
    }

    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    }

    // =========================================================================
    // PERMISSION CHECKS - Feature-Level
    // =========================================================================

    function canInviteUsers() {
        return _currentRole === ROLES.OWNER;
    }

    function canManageSubdivisions() {
        return _currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN;
    }

    function canManageTeam() {
        return _currentRole === ROLES.OWNER;
    }

    function canDeleteCampData() {
        return _currentRole === ROLES.OWNER;
    }

    function canEraseData() {
        if (!_initialized) return false;
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
    // EXCEPTION AREAS - These are accessible to ALL including viewers
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

    // NEW: For Scheduler UI
    function getUserManagedDivisions() {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return null; // Implies ALL
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
            permissions.push({ icon: '🖨️', text: 'Print any schedule' });
            permissions.push({ icon: '📊', text: 'Full reporting access' });
        } else if (_currentRole === ROLES.SCHEDULER) {
            if (_editableDivisions.length > 0) {
                permissions.push({ icon: '✏️', text: `Edit: ${_editableDivisions.join(', ')}` });
            } else {
                permissions.push({ icon: '⚠️', text: 'No divisions assigned - contact owner' });
            }
            permissions.push({ icon: '👁️', text: 'View all divisions (read-only for others)' });
            permissions.push({ icon: '🖨️', text: 'Print any schedule' });
        } else {
            permissions.push({ icon: '👁️', text: 'View all schedules' });
            permissions.push({ icon: '🖨️', text: 'Print any schedule' });
            permissions.push({ icon: '🔍', text: 'Camper lookup' });
        }
        
        return permissions;
    }

    function getUserName() {
        return _userName;
    }

    function getCampName() {
        return _campName;
    }

    function getUserSubdivisionDetails() {
        return [..._userSubdivisionDetails];
    }
    
    function getUserSubdivisionIds() {
        return [..._userSubdivisionIds];
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
    // V3.3 QUICK-CHECK HELPERS
    // =========================================================================

    function canEdit() {
        return canEditAnything();
    }

    function getRole() {
        return _currentRole;
    }

    function checkEditAccess(action) {
        if (!canEdit()) {
            showPermissionDenied(action || 'edit');
            return false;
        }
        return true;
    }

    function checkSetupAccess(action) {
        if (!canEditSetup()) {
            showPermissionDenied(action || 'modify setup');
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
    // SUBDIVISION & TEAM MANAGEMENT
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
    
    // =========================================================================
    // DIRECT DIVISION ASSIGNMENT (Alternative to subdivisions)
    // =========================================================================
    
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

    // Helper to get all bunk IDs for the current user's editable divisions
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
        
        if (_currentRole === ROLES.VIEWER) {
            banner.innerHTML = `
                <span style="font-size: 1.2rem;">👁️</span>
                <div>
                    <strong>View Only Mode</strong>
                    <div style="font-size: 0.85rem; color: #92400E;">
                        You can view all schedules, use Print Center, and Camper Locator.
                    </div>
                </div>
            `;
        } else if (_currentRole === ROLES.ADMIN) {
            banner.style.background = 'linear-gradient(135deg, #DBEAFE, #BFDBFE)';
            banner.style.borderColor = '#3B82F6';
            banner.innerHTML = `
                <span style="font-size: 1.2rem;">🔧</span>
                <div>
                    <strong>Administrator Mode</strong>
                    <div style="font-size: 0.85rem; color: #1E40AF;">
                        Full editing access. Team management requires Owner role.
                    </div>
                </div>
            `;
        } else if (_currentRole === ROLES.SCHEDULER) {
            const permText = getPermissionsText();
            const editableDivsList = _editableDivisions.length > 0 
                ? _editableDivisions.join(', ')
                : 'None (contact owner to assign subdivisions)';
            
            if (_editableDivisions.length === 0) {
                banner.style.background = 'linear-gradient(135deg, #FEE2E2, #FECACA)';
                banner.style.borderColor = '#EF4444';
                banner.innerHTML = `
                    <span style="font-size: 1.2rem;">⚠️</span>
                    <div>
                        <strong style="color: #991B1B;">${permText}</strong>
                        <div style="font-size: 0.85rem; color: #B91C1C;">
                            You haven't been assigned any divisions yet. Contact the camp owner.
                        </div>
                    </div>
                `;
            } else {
                banner.innerHTML = `
                    <span style="font-size: 1.2rem;">📝</span>
                    <div>
                        <strong>${permText}</strong>
                        <div style="font-size: 0.85rem; color: #92400E;">
                            Can edit: ${editableDivsList} • Other divisions are view-only (greyed out)
                        </div>
                    </div>
                `;
            }
        }
        
        const container = document.getElementById('main-app-container') || document.body;
        const firstChild = container.firstChild;
        container.insertBefore(banner, firstChild);
    }

    async function refresh() {
        _initialized = false;
        await initialize();
        renderAccessBanner();
    }
    
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
        console.log("Direct Division Assignments:", _directDivisionAssignments);
        console.log("All Subdivisions:", _subdivisions);
        console.log("Editable Divisions:", _editableDivisions);
        console.log("window.divisions keys:", Object.keys(window.divisions || {}));
        console.log("🔐 ==================================");
    }

    // =========================================================================
    // SCHEDULER ENFORCEMENT - Delete own divisions only
    // =========================================================================
    
   async function deleteMyDivisionsOnly(dateKey) {
    console.log('🗑️ [AccessControl] deleteMyDivisionsOnly called for:', dateKey);
    
    if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
        // Owners/admins should use full delete
        console.log('🗑️ [AccessControl] Owner/Admin - use full delete instead');
        return null;
    }
    
    const myDivisions = getEditableDivisions();
    if (myDivisions.length === 0) {
        return { error: "No divisions assigned" };
    }
    
    console.log('🗑️ [AccessControl] Deleting divisions:', myDivisions);
    
    try {
        // ★★★ CRITICAL FIX: Delete from cloud FIRST using ScheduleDB ★★★
        if (window.ScheduleDB?.deleteMyScheduleOnly) {
            console.log('🗑️ [AccessControl] Calling ScheduleDB.deleteMyScheduleOnly...');
            const cloudResult = await window.ScheduleDB.deleteMyScheduleOnly(dateKey);
            console.log('🗑️ [AccessControl] Cloud delete result:', cloudResult);
            
            if (!cloudResult?.success) {
                console.error('🗑️ [AccessControl] Cloud delete failed:', cloudResult?.error);
                // Continue anyway to clear local state
            }
        } else {
            console.warn('🗑️ [AccessControl] ScheduleDB.deleteMyScheduleOnly not available!');
            // Fallback: try direct Supabase delete
            const client = window.CampistryDB?.getClient?.() || window.supabase;
            const campId = window.CampistryDB?.getCampId?.() || (typeof getCampId === 'function' ? getCampId() : _campId);
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
        
        // ★★★ Now clear window globals for my divisions ★★★
        const divisions = window.divisions || {};
        const bunksToRemove = new Set();
        
        for (const divName of myDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => bunksToRemove.add(b));
            }
        }
        
        // Clear from window.scheduleAssignments
        if (window.scheduleAssignments) {
            bunksToRemove.forEach(bunk => {
                delete window.scheduleAssignments[bunk];
            });
            console.log('🗑️ [AccessControl] Cleared', bunksToRemove.size, 'bunks from window.scheduleAssignments');
        }
        
        // Clear from window.leagueAssignments
        if (window.leagueAssignments) {
            bunksToRemove.forEach(bunk => {
                delete window.leagueAssignments[bunk];
            });
        }
        
        // ★★★ Reload remaining schedules from cloud ★★★
        if (window.ScheduleDB?.loadSchedule) {
            console.log('🗑️ [AccessControl] Reloading remaining schedules from cloud...');
            const remaining = await window.ScheduleDB.loadSchedule(dateKey);
            
            if (remaining?.success && remaining.data) {
                // Merge remaining data (from other schedulers) into window globals
                if (remaining.data.scheduleAssignments) {
                    window.scheduleAssignments = remaining.data.scheduleAssignments;
                }
                if (remaining.data.leagueAssignments) {
                    window.leagueAssignments = remaining.data.leagueAssignments;
                }
                console.log('🗑️ [AccessControl] Reloaded', Object.keys(remaining.data.scheduleAssignments || {}).length, 'bunks from other schedulers');
            }
        }
        
        // Dispatch deletion event for UI refresh
        window.dispatchEvent(new CustomEvent('campistry-schedule-deleted', {
            detail: { dateKey, divisions: myDivisions }
        }));
        
        console.log('🗑️ [AccessControl] ✅ Delete complete');
        return { success: true, deletedDivisions: myDivisions };
        
    } catch (e) {
        console.error('🗑️ [AccessControl] Delete error:', e);
        return { error: e.message };
    }
}
    
    function filterDivisionsForGeneration(requestedDivisions) {
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return requestedDivisions;
        if (_currentRole === ROLES.VIEWER) return [];
        
        const myDivisions = getEditableDivisions();
        if (!requestedDivisions || requestedDivisions.length === 0) return myDivisions;
        return requestedDivisions.filter(d => myDivisions.includes(d));
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
        canEditSetup,
        canEditFields,
        canEditGlobalFields,
        canEditAnything,
        canSave,
        canRunGenerator,
        getEditableBunkIds,
        canPrint,
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
        
        // ★ NEW SCHEDULER ENFORCEMENT EXPORTS ★
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

    console.log("🔐 Access Control v3.5 loaded");

})();
