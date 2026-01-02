// ============================================================================
// access_control.js — Campistry Role-Based Access Control (Multi-Tenant)
// ============================================================================
// Provides permission checks throughout the app
// Everyone sees everything, editing is restricted by role/subdivision
// Properly handles team members connecting to the main camp
// ============================================================================

(function() {
    'use strict';

    console.log("🔐 Access Control v1.2 (Multi-Tenant) loading...");

    // =========================================================================
    // STATE
    // =========================================================================
    
    let _currentUser = null;
    let _currentRole = null;
    let _campId = null;
    let _subdivisions = [];
    let _userSubdivisionIds = [];
    let _editableDivisions = [];
    let _initialized = false;
    let _isTeamMember = false;
    let _membership = null;

    const ROLES = {
        OWNER: 'owner',
        ADMIN: 'admin',
        SCHEDULER: 'scheduler',
        VIEWER: 'viewer'
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
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_initialized) return;
        
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
        
        // Calculate editable divisions based on role
        calculateEditableDivisions();
        
        _initialized = true;
        
        // Dispatch event so UI can update
        window.dispatchEvent(new CustomEvent('campistry-access-loaded', {
            detail: {
                role: _currentRole,
                editableDivisions: _editableDivisions,
                subdivisions: _subdivisions,
                isTeamMember: _isTeamMember
            }
        }));
        
        console.log("🔐 Access control initialized:", {
            role: _currentRole,
            isTeamMember: _isTeamMember,
            editableDivisions: _editableDivisions.length,
            subdivisions: _subdivisions.length
        });
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
                .select('owner')
                .eq('owner', _currentUser.id)
                .maybeSingle();
            
            if (ownedCamp) {
                console.log("🔐 User is a camp owner");
                _currentRole = ROLES.OWNER;
                _isTeamMember = false;
                _campId = _currentUser.id;
                _userSubdivisionIds = []; // Empty = access to all
                
                // Store in localStorage
                localStorage.setItem('campistry_user_id', _campId);
                return;
            }
        } catch (e) {
            console.warn("🔐 Error checking camp ownership:", e);
        }
        
        // Not an owner - check if they're a team member
        try {
            const { data: memberData } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('user_id', _currentUser.id)
                .not('accepted_at', 'is', null)
                .maybeSingle();
            
            if (memberData) {
                console.log("🔐 User is a team member:", memberData.role);
                _currentRole = memberData.role || ROLES.VIEWER;
                _isTeamMember = true;
                _campId = memberData.camp_id;
                _userSubdivisionIds = memberData.subdivision_ids || [];
                _membership = memberData;
                
                // Store camp ID for cloud storage to use
                localStorage.setItem('campistry_user_id', _campId);
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
        _userSubdivisionIds = [];
        localStorage.setItem('campistry_user_id', _campId);
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

        } catch (e) {
            console.error("🔐 Error loading subdivisions:", e);
            _subdivisions = [];
        }
    }

    // =========================================================================
    // CALCULATE EDITABLE DIVISIONS
    // =========================================================================

    function calculateEditableDivisions() {
        const allDivisions = Object.keys(window.divisions || {});
        
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
            // If no subdivision restrictions, can edit all
            if (!_userSubdivisionIds || _userSubdivisionIds.length === 0) {
                _editableDivisions = [...allDivisions];
                console.log("🔐 Scheduler with full access");
                return;
            }
            
            // Get divisions from assigned subdivisions
            const editableDivs = new Set();
            _userSubdivisionIds.forEach(subId => {
                const sub = _subdivisions.find(s => s.id === subId);
                if (sub && sub.divisions) {
                    sub.divisions.forEach(d => editableDivs.add(d));
                }
            });
            
            _editableDivisions = [...editableDivs];
            console.log("🔐 Scheduler restricted to:", _editableDivisions);
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
     */
    function canEditDivision(divisionName) {
        if (!_initialized) {
            console.warn("🔐 Access control not initialized yet");
            return true; // Default to allow during initialization
        }
        
        // Owner and Admin can edit all
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) {
            return true;
        }
        
        // Viewer can't edit
        if (_currentRole === ROLES.VIEWER) {
            return false;
        }
        
        return _editableDivisions.includes(divisionName);
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
        if (_currentRole === ROLES.VIEWER) return false;
        if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN) return true;
        return _editableDivisions.length > 0;
    }
    
    /**
     * Check if current user can save/modify data
     */
    function canSave() {
        return _currentRole !== ROLES.VIEWER;
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
     * Get all subdivisions
     */
    function getSubdivisions() {
        return [..._subdivisions];
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

    async function inviteTeamMember(email, role, subdivisionIds = []) {
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

            // Update local state
            _campId = invite.camp_id;
            _currentRole = invite.role;
            _isTeamMember = true;
            _userSubdivisionIds = invite.subdivision_ids || [];
            
            localStorage.setItem('campistry_user_id', _campId);
            
            await loadSubdivisions();
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
            const userSubs = getUserSubdivisions();
            const subNames = userSubs.map(s => s.name).join(', ') || 'All';
            
            banner.innerHTML = `
                <span style="font-size: 1.2rem;">🔓</span>
                <div>
                    <strong>You can edit: ${subNames}</strong>
                    <div style="font-size: 0.85rem; color: #92400E;">
                        ${_editableDivisions.join(', ') || 'No divisions assigned'}
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
        
        // Getters
        getEditableDivisions,
        getGeneratableDivisions,
        getCurrentRole,
        isTeamMember,
        getSubdivisions,
        getUserSubdivisions,
        getSubdivisionForDivision,
        isDivisionInUserSubdivisions,
        getCampId,
        
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
        
        // Constants
        ROLES
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
                _subdivisions = [];
                _editableDivisions = [];
                _isTeamMember = false;
                _membership = null;
            }
        });
    }

    console.log("🔐 Access Control module loaded (Multi-Tenant)");

})();
