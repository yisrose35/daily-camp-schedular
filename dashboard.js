// ============================================================================
// dashboard.js — Campistry Dashboard Logic (Multi-Tenant) v2.4
// 
// v2.4: SESSION CACHE - Caches RBAC context to sessionStorage so
//       Flow/Me pages can read role instantly (no Supabase re-query).
//       Eliminates 3-second white screen on page transitions.
//
// v2.3: CRITICAL FIX - Invitees no longer get owner permissions
//       - Changed STEP 4 fallback from 'owner' to 'viewer'
//
// v2.2: FIXED - Check team membership BEFORE camp ownership
//       FIXED - Prevent team members from creating camps
//
// Handles:
// - Auth check (redirect to index/login if not logged in)
// - Load/display camp profile (for owners AND team members)
// - Personalized welcome message with user name and camp name
// - Show role badge for ALL users (owner, admin, scheduler, viewer)
// - Show permissions for team members
// - Edit camp name and address (owners only)
// - Change password
// - Display stats from cloud storage
// - Logout
// - RBAC Team Section Visibility (owners only)
// ============================================================================

(function() {
    'use strict';

    // ★★★ CB-75: camp name, subdivision names and division names are
    // owner-controlled and were interpolated RAW into dashboard innerHTML
    // (welcome title, scheduler role badge, subdivision list) → cross-user stored
    // XSS (every team member who opens the dashboard executes the owner's payload).
    // No escaper existed; add one (CampUtils delegate + complete &<>"' fallback).
    const _dashEsc = (s) => (window.CampUtils && window.CampUtils.escapeHtml)
        ? window.CampUtils.escapeHtml(s)
        : String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    // ========================================
    // STATE
    // ========================================
    
    let currentUser = null;
    let campData = null;
    let isEditMode = false;
    let userRole = null;
    let isTeamMember = false;
    let membership = null;
    let userName = null;
    let campName = null;

    // ========================================
    // DOM ELEMENTS
    // ========================================
    
    const navUserEmail = document.getElementById('navUserEmail');
    const campNameDisplay = document.getElementById('campNameDisplay');
    
    // Profile elements
    const profileView = document.getElementById('profileView');
    const profileEditForm = document.getElementById('profileEditForm');
    const profileCampName = document.getElementById('profileCampName');
    const profileAddress = document.getElementById('profileAddress');
    const profileEmail = document.getElementById('profileEmail');
    const editCampName = document.getElementById('editCampName');
    const editAddress = document.getElementById('editAddress');
    const profileError = document.getElementById('profileError');
    const profileSuccess = document.getElementById('profileSuccess');
    
    // Password elements
    const passwordForm = document.getElementById('passwordForm');
    const newPassword = document.getElementById('newPassword');
    const confirmPassword = document.getElementById('confirmPassword');
    const passwordError = document.getElementById('passwordError');
    const passwordSuccess = document.getElementById('passwordSuccess');
    
    // Stats elements
    const statDivisions = document.getElementById('statDivisions');
    const statBunks = document.getElementById('statBunks');
    const statCampers = document.getElementById('statCampers');
    
    // RBAC elements
    const teamAccessSection = document.getElementById('team-access-section');

    // ========================================
    // AUTH CHECK
    // ========================================
    
   async function checkAuth() {
        // ★ FAST-PASS: Check localStorage before giving up
        const cachedUserId = localStorage.getItem('campistry_auth_user_id');
        const cachedCampId = localStorage.getItem('campistry_camp_id');
        const hasLocalAuth = !!(cachedUserId && cachedCampId);
        
        // Wait for Supabase
        let attempts = 0;
        while ((!window.supabase || !window.supabase.auth) && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        
        if (!window.supabase || !window.supabase.auth) {
            if (hasLocalAuth) {
                console.warn('🔑 [Dashboard] Supabase not loaded but cached auth exists — waiting longer');
                // Give it more time since we know user was authenticated
                let extraAttempts = 0;
               while ((!window.supabase || !window.supabase.auth) && extraAttempts < 50) {
                    await new Promise(r => setTimeout(r, 100));
                    extraAttempts++;
                }
                if (!window.supabase || !window.supabase.auth) {
                    console.error('Supabase still not available after extended wait');
                    window.location.href = 'index.html';
                    return;
                }
            } else {
                console.error('Supabase not available');
                window.location.href = 'index.html';
                return;
            }
        }
        
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            
            if (!session?.user) {
                if (hasLocalAuth) {
                    console.warn('🔑 [Dashboard] No session but cached auth — trying refresh');
                    const { data: refreshData, error: refreshError } = await window.supabase.auth.refreshSession();
                    if (refreshError || !refreshData?.session) {
                        console.log('🔑 [Dashboard] Refresh failed — clearing cache, redirecting');
                        localStorage.removeItem('campistry_auth_user_id');
                        localStorage.removeItem('campistry_camp_id');
                        localStorage.removeItem('campistry_role');
                        window.location.href = 'index.html';
                        return;
                    }
                    // Refresh succeeded — use this session
                    currentUser = refreshData.session.user;
                    console.log('🔑 [Dashboard] Session refreshed successfully:', currentUser.email);
                } else {
                    console.log('No session, redirecting to login');
                    window.location.href = 'index.html';
                    return;
                }
            } else {
                currentUser = session.user;
            }
            
           console.log('📊 User authenticated:', currentUser.email);
            
            // Determine user's role and camp membership
            await determineUserRole();
            
            // ★★★ v2.4: Cache RBAC context so Flow/Me pages load instantly ★★★
            cacheRBACContext();

            // ★ Campistry Lite: counselors have no business on the admin
            // dashboard — their home is the mobile companion.
            if (userRole === 'counselor') {
                window.location.replace('campistry_lite.html');
                return;
            }

            // Load dashboard data
            await loadDashboardData();
            
            // Show appropriate sections based on role
            setupDashboardForRole();
            
        } catch (e) {
            console.error('Auth check failed:', e);
            // ★ #V2-3 FIX (mirror flow.html v7.2): the try above also wraps
            // determineUserRole()/loadDashboardData() (DB queries). A transient
            // network/DB error there is NOT an auth failure — bouncing an
            // authenticated user to the login page loses their session and a
            // re-login won't fix a downstream data error. Only redirect when we
            // have no evidence of a valid session; otherwise stay put (degraded
            // dashboard the user can reload), exactly as flow.html does.
            if (currentUser || hasLocalAuth) {
                console.warn('🔑 [Dashboard] Error after auth check, but session/cached auth exists — staying (transient/downstream error, not a logout)');
            } else {
                window.location.href = 'index.html';
            }
        }
    }

    // ========================================
    // ⭐ FIXED v2.3: Check team membership FIRST, then camp ownership
    // ========================================
    
    async function determineUserRole() {
        console.log('📊 Determining user role...');
        
        // =====================================================================
        // ⭐ STEP 1: Check if user is a TEAM MEMBER first (HIGHEST PRIORITY)
        // This ensures invited users get their correct assigned role
        // =====================================================================
        try {
            const { data: memberData, error: memberError } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('user_id', currentUser.id)
                .not('accepted_at', 'is', null)
                .maybeSingle();
            
            console.log('📊 Team member check result:', { memberData, memberError });
            
            if (memberData && !memberError) {
                console.log('📊 ✅ User IS a team member:', memberData.role);
                userRole = memberData.role;
                isTeamMember = true;
                membership = memberData;
                userName = memberData.name || null;
                
                // Fetch the camp details
                const { data: campInfo, error: campInfoError } = await window.supabase
                    .from('camps')
                    .select('name, address')
                    .eq('owner', memberData.camp_id)
                    .maybeSingle();
                
                console.log('📊 Camp info for team member:', { campInfo, campInfoError });
                
                if (campInfo && !campInfoError) {
                    campData = campInfo;
                    campName = campInfo.name || null;
                }
                
                // Store camp ID for cloud storage
                localStorage.setItem('campistry_user_id', memberData.camp_id);
                return; // ⭐ IMPORTANT: Exit here - don't check camp ownership
            }
        } catch (e) {
            console.warn('Error checking team membership:', e);
        }

        // =====================================================================
        // ⭐ STEP 2: Check for PENDING INVITE (auto-accept if found)
        // =====================================================================
        try {
            const { data: pendingInvite } = await window.supabase
                .from('camp_users')
                .select('*')
                .eq('email', currentUser.email.toLowerCase())
                .is('user_id', null)
                .maybeSingle();
            
            if (pendingInvite) {
                console.log('📊 Found pending invite - auto-accepting:', pendingInvite.role);
                
                const { error: acceptError } = await window.supabase
                    .from('camp_users')
                    .update({
                        user_id: currentUser.id,
                        accepted_at: new Date().toISOString()
                    })
                    .eq('id', pendingInvite.id);
                
                if (!acceptError) {
                    console.log('📊 ✅ Invite auto-accepted!');
                    // Recursively call to properly set up role
                    return await determineUserRole();
                }
            }
        } catch (e) {
            console.warn('Error checking pending invite:', e);
        }
        
        // =====================================================================
        // ⭐ STEP 3: Check if user is a CAMP OWNER (only if not a team member)
        // =====================================================================
        try {
            // A super-admin may own MULTIPLE camps (their real camp + debug
            // copies), so .maybeSingle() would throw. Fetch all and pick the
            // ACTIVE one: prefer the camp CampistryDB already resolved (which
            // honors the active-camp selection / debug-copy switch), then the
            // camp whose id == uid (signup convention), then the first.
            const { data: ownedCamps, error: campError } = await window.supabase
                .from('camps')
                .select('*')
                .eq('owner', currentUser.id);

            let ownedCamp = null;
            if (Array.isArray(ownedCamps) && ownedCamps.length > 0 && !campError) {
                const activeId = (window.CampistryDB && window.CampistryDB.getCampId)
                    ? window.CampistryDB.getCampId() : null;
                ownedCamp = ownedCamps.find(c => c.id === activeId) ||
                            ownedCamps.find(c => c.id === currentUser.id) ||
                            ownedCamps[0];
            }

            console.log('📊 Camp ownership check result:', { ownedCamp, campError });

            if (ownedCamp) {
                console.log('📊 User is a camp owner, camp:', ownedCamp.name);
                userRole = 'owner';
                isTeamMember = false;
                campData = ownedCamp;
                campName = ownedCamp.name || null;
                userName = ownedCamp.owner_name || null;

                // Store camp ID (use camp's row ID, not auth user ID)
                localStorage.setItem('campistry_user_id', ownedCamp.id);
                localStorage.setItem('campistry_camp_id', ownedCamp.id);
                return;
            }
        } catch (e) {
            console.warn('Error checking camp ownership:', e);
        }
        
        // =====================================================================
        // ⭐ STEP 4: Fallback - No camp association found
        // ★★★ CRITICAL FIX v2.3: Default to VIEWER for safety ★★★
        // Invited users who fell through should NOT get owner access
        // =====================================================================
        console.log('📊 ⚠️ No camp association found - defaulting to VIEWER for safety');
        userRole = 'viewer';  // ★★★ SAFE DEFAULT - NOT OWNER! ★★★
        isTeamMember = false;
        userName = null;
        campName = null;
        // Don't cache uncertain state
        // localStorage.setItem('campistry_user_id', currentUser.id);
    }

    // ========================================
    // ★★★ v2.4: CACHE RBAC CONTEXT FOR OTHER PAGES ★★★
    // Writes role context to sessionStorage so Flow/Me can read it
    // instantly without re-querying Supabase (eliminates white screen).
    // ========================================
    
   function cacheRBACContext() {
        try {
            const rbacCache = {
                userId: currentUser?.id,
                role: userRole,
                campId: membership?.camp_id || campData?.id || currentUser?.id,
                campName: campName,
                userName: userName,
                isTeamMember: isTeamMember,
                subdivisionIds: membership?.subdivision_ids || [],
                assignedDivisions: membership?.assigned_divisions || [],
                membershipId: membership?.id || null,
                membershipName: membership?.name || null,
                cachedAt: Date.now()
            };
            sessionStorage.setItem('campistry_rbac_cache', JSON.stringify(rbacCache));

            // ★★★ CB-108: assignedDivisions above is the DENORMALIZED
            // camp_users.assigned_divisions snapshot, which goes STALE when an owner
            // edits a subdivision's divisions[] (the member's row isn't touched).
            // Re-resolve the scheduler's divisions from the LIVE subdivisions table
            // by subdivision_ids and overwrite the cache, so Flow/Me read the current
            // scope rather than a stale invite-time snapshot. Best-effort + async;
            // the snapshot stands until this resolves.
            try {
                const _subIds108 = membership?.subdivision_ids || [];
                if (window.supabase && _subIds108.length > 0) {
                    window.supabase.from('subdivisions').select('divisions').in('id', _subIds108)
                        .then(function (res) {
                            if (res.error || !res.data) return;
                            const _live = new Set();
                            res.data.forEach(function (r) { (Array.isArray(r.divisions) ? r.divisions : []).forEach(function (d) { _live.add(d); }); });
                            try {
                                const _c = JSON.parse(sessionStorage.getItem('campistry_rbac_cache') || '{}');
                                _c.assignedDivisions = [..._live];
                                _c.cachedAt = Date.now();
                                sessionStorage.setItem('campistry_rbac_cache', JSON.stringify(_c));
                                console.log('[Dashboard] CB-108: refreshed assignedDivisions from live subdivisions:', _c.assignedDivisions.join(', '));
                            } catch (_) {}
                        })
                        .catch(function () {});
                }
            } catch (_) {}

            // ★★★ v2.5: Also write to localStorage as durable fallback ★★★
            // sessionStorage is cleared on tab close. localStorage persists.
            // access_control.js reads localStorage as last-resort fallback.
            localStorage.setItem('campistry_role', userRole);
            localStorage.setItem('campistry_user_id', rbacCache.campId);
            localStorage.setItem('campistry_camp_id', rbacCache.campId);
            localStorage.setItem('campistry_auth_user_id', currentUser?.id);
            localStorage.setItem('campistry_is_team_member', String(isTeamMember));
            
            console.log('📊 ⚡ RBAC context cached to sessionStorage + localStorage:', rbacCache.role);
        } catch (e) {
            console.warn('📊 Failed to cache RBAC context:', e);
        }
    }

    // ========================================
    // UPDATE WELCOME MESSAGE
    // ========================================
    
    function updateWelcomeMessage() {
        const welcomeSection = document.querySelector('.welcome-section');
        const welcomeTitle = document.querySelector('.welcome-section h1, .welcome-title, #welcomeTitle');
        const welcomeSubtitle = document.querySelector('.welcome-section p, .welcome-subtitle, #welcomeSubtitle');
        
        // Build the personalized welcome
        // Use camp name as primary display, fallback to owner_name, then user_metadata, then email prefix
        const displayName = campName || userName || currentUser.user_metadata?.camp_name || currentUser.email.split('@')[0];
        const displayCamp = campName || currentUser.user_metadata?.camp_name || 'Your Camp';
        
        console.log('📊 Updating welcome:', { displayName, displayCamp, userName, campName });
        
        // Update the title — show camp name, not email
        if (welcomeTitle) {
            welcomeTitle.innerHTML = `Welcome back, <span>${_dashEsc(displayName)}</span>!`;
        }
        
        // Update the subtitle
        if (welcomeSubtitle) {
            welcomeSubtitle.textContent = 'Manage your camp and access all Campistry products from here.';
        }
        
        // Also update the campNameDisplay if it exists
        if (campNameDisplay) {
            campNameDisplay.textContent = displayCamp;
        }
    }

    // ========================================
    // SETUP DASHBOARD FOR ROLE
    // ========================================
    
    function setupDashboardForRole() {
        const editProfileBtn = document.getElementById('editProfileBtn');
        
        // Add role badge for ALL users (including owners)
        addRoleBadge();
        
        if (isTeamMember) {
            // Team members can't edit camp profile
            if (editProfileBtn) {
                editProfileBtn.style.display = 'none';
            }

            // Add "Your Permissions" section for team members
            addPermissionsSection();

            // Hide team management section (only for owners)
            if (teamAccessSection) {
                teamAccessSection.style.display = 'none';
            }

            // Schedulers and admins can see camp dates (read-only)
            if (userRole === 'scheduler' || userRole === 'admin') {
                var campDatesSection = document.getElementById('camp-dates-section');
                if (campDatesSection) campDatesSection.style.display = 'block';
                loadCampDates(true);
            }

        } else if (userRole === 'owner') {
            // Owner sees everything
            checkAccessControl();
            var campDatesSection = document.getElementById('camp-dates-section');
            if (campDatesSection) campDatesSection.style.display = 'block';
            loadCampDates(false);
        }
    }
    
    function addRoleBadge() {
        const welcomeSection = document.querySelector('.welcome-section');
        if (!welcomeSection) return;
        
        // Check if badge already exists
        if (document.querySelector('.role-badge-large')) return;
        
        const roleBadge = document.createElement('div');
        roleBadge.className = 'role-badge-large';
        
        roleBadge.innerHTML = `
            <span class="role-text">${getRoleDisplayName(userRole)}</span>
        `;
        roleBadge.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 16px;
            background: ${getRoleColor(userRole)}12;
            color: ${getRoleColor(userRole)};
            border-radius: 999px;
            font-size: 0.85rem;
            margin-top: 12px;
            border: 1px solid ${getRoleColor(userRole)}25;
            font-weight: 600;
            letter-spacing: 0.02em;
        `;
        
        welcomeSection.appendChild(roleBadge);
        
        // For schedulers, show assigned generation divisions
        if (userRole === 'scheduler' && membership?.subdivision_ids?.length > 0) {
            loadSubdivisionNamesForBadge(roleBadge);
        }
    }
    
    async function loadSubdivisionNamesForBadge(badgeElement) {
        try {
            const { data: subdivisions } = await window.supabase
                .from('subdivisions')
                .select('name')
                .in('id', membership.subdivision_ids);
            
            if (subdivisions && subdivisions.length > 0) {
                const names = subdivisions.map(s => _dashEsc(s.name)).join(', ');
                badgeElement.innerHTML = `
                    <span class="role-text">Scheduler — generates ${names}</span>
                `;
            }
        } catch (e) {
            console.warn('Could not load subdivision names:', e);
        }
    }
    
    function addPermissionsSection() {
        const dashboardGrid = document.querySelector('.dashboard-grid');
        if (!dashboardGrid) return;
        
        // Check if already added
        if (document.querySelector('.permissions-card')) return;
        
        const permissionsCard = document.createElement('section');
        permissionsCard.className = 'dashboard-card permissions-card';
        
        // Get subdivision info
        let divisionsHtml = '<p style="color: var(--slate-500);">Loading...</p>';
        
        if (membership && membership.subdivision_ids && membership.subdivision_ids.length > 0) {
            divisionsHtml = '<p style="color: var(--slate-500);">Loading assigned divisions...</p>';
        } else if (userRole === 'admin') {
            divisionsHtml = '<p style="color: var(--slate-600);"><strong>All divisions</strong> — Full access</p>';
        } else if (userRole === 'viewer') {
            divisionsHtml = '<p style="color: var(--slate-500);">View-only access to all divisions</p>';
        } else if (userRole === 'scheduler') {
            divisionsHtml = '<p style="color: var(--slate-600);"><strong>All divisions</strong> — Full editing access (generate scoped to assigned divisions)</p>';
        }
        
        permissionsCard.innerHTML = `
            <div class="card-header">
                <h2>Your Permissions</h2>
            </div>
            <div class="permissions-content">
                <div class="permission-row">
                    <span class="permission-label">Role</span>
                    <span class="permission-value">
                        <span class="role-badge-small" style="background: ${getRoleColor(userRole)}12; color: ${getRoleColor(userRole)}; padding: 4px 12px; border-radius: 999px; font-weight: 600;">
                            ${getRoleDisplayName(userRole)}
                        </span>
                    </span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Edit Schedules</span>
                    <span class="permission-value">${userRole === 'viewer' ? '✕ No' : '✓ Yes'}</span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Print</span>
                    <span class="permission-value">✓ Yes</span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Use Camper Locator</span>
                    <span class="permission-value">✓ Yes</span>
                </div>
                <div class="permission-divider"></div>
                <div class="permission-row">
                    <span class="permission-label">Assigned Divisions</span>
                </div>
                <div id="assigned-divisions" style="margin-top: 8px;">
                    ${divisionsHtml}
                </div>
            </div>
        `;
        
        // Add styles if not present
        if (!document.getElementById('permissions-styles')) {
            const style = document.createElement('style');
            style.id = 'permissions-styles';
            style.textContent = `
                .permission-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 0;
                }
                .permission-label {
                    color: var(--slate-600);
                    font-weight: 500;
                    font-size: 0.9rem;
                }
                .permission-value {
                    color: var(--slate-800);
                    font-weight: 500;
                    font-size: 0.9rem;
                }
                .permission-divider {
                    height: 1px;
                    background: var(--slate-200);
                    margin: 16px 0;
                }
                .division-tag {
                    display: inline-block;
                    padding: 4px 12px;
                    background: var(--slate-100);
                    border-radius: 999px;
                    font-size: 0.85rem;
                    margin: 4px 4px 4px 0;
                }
                .permissions-card {
                    background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
                }
            `;
            document.head.appendChild(style);
        }
        
        // Insert after first card
        const firstCard = dashboardGrid.firstElementChild;
        if (firstCard) {
            dashboardGrid.insertBefore(permissionsCard, firstCard.nextSibling);
        } else {
            dashboardGrid.appendChild(permissionsCard);
        }
        
        // Load actual subdivision/division data
        loadAssignedDivisions();
    }
    
    async function loadAssignedDivisions() {
        const container = document.getElementById('assigned-divisions');
        if (!container) return;
        
        if (userRole === 'admin') {
            container.innerHTML = '<p style="color: var(--slate-600);"><strong>All divisions</strong> — Full admin access</p>';
            return;
        }
        
        if (userRole === 'viewer') {
            container.innerHTML = '<p style="color: var(--slate-500);">View-only access — cannot edit any divisions</p>';
            return;
        }
        
        // For schedulers, load their assigned subdivisions
        if (!membership || !membership.subdivision_ids || membership.subdivision_ids.length === 0) {
            container.innerHTML = '<p style="color: var(--slate-600);"><strong>All divisions</strong> — No restrictions</p>';
            return;
        }
        
        try {
            const { data: subdivisions } = await window.supabase
                .from('subdivisions')
                .select('*')
                .in('id', membership.subdivision_ids);
            
            if (subdivisions && subdivisions.length > 0) {
                let html = '';
                subdivisions.forEach(sub => {
                    html += `
                        <div style="margin-bottom: 12px; padding: 12px; background: white; border-radius: 8px; border-left: 4px solid ${sub.color || '#6B7280'}; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="font-weight: 600; color: var(--slate-800);">${_dashEsc(sub.name)}</div>
                            <div style="font-size: 0.85rem; color: var(--slate-500); margin-top: 4px;">
                                ${sub.divisions && sub.divisions.length > 0
                                    ? sub.divisions.map(d => `<span class="division-tag">${_dashEsc(d)}</span>`).join('')
                                    : '<em>No divisions assigned</em>'
                                }
                            </div>
                        </div>
                    `;
                });
                container.innerHTML = html;
            } else {
                container.innerHTML = '<p style="color: var(--slate-500);">No subdivisions assigned</p>';
            }
        } catch (e) {
            console.error('Error loading subdivisions:', e);
            container.innerHTML = '<p style="color: var(--slate-500);">Could not load divisions</p>';
        }
    }
    
    function getRoleDisplayName(role) {
        const names = {
            owner: 'Owner',
            admin: 'Admin',
            scheduler: 'Scheduler',
            viewer: 'Viewer',
            counselor: 'Counselor'
        };
        return names[role] || role || 'Unknown';
    }

    function getRoleColor(role) {
        const colors = {
            owner: '#7C3AED',
            admin: '#2563EB',
            scheduler: '#059669',
            viewer: '#6B7280',
            counselor: '#EE6A53'
        };
        return colors[role] || '#6B7280';
    }
    
    function getRoleIcon(role) {
        // No emoji icons — role badges are styled with CSS only
        return '';
    }

    // ========================================
    // LOAD DASHBOARD DATA
    // ========================================
    
    async function loadDashboardData() {
        // Update nav email
        if (navUserEmail) {
            navUserEmail.textContent = currentUser.email;
        }
        
        // Update profile email
        if (profileEmail) {
            profileEmail.textContent = currentUser.email;
        }
        
        // If we're an owner and don't have camp data yet, try to fetch it again
        if (!campData && !isTeamMember) {
            try {
                // Multi-camp owners: fetch all, prefer the real camp (id==uid).
                const { data: campsList, error } = await window.supabase
                    .from('camps')
                    .select('*')
                    .eq('owner', currentUser.id);
                const camps = (Array.isArray(campsList) && campsList.length > 0)
                    ? (campsList.find(c => c.id === currentUser.id) || campsList[0])
                    : null;

                console.log('📊 Secondary camp fetch:', { camps, error });

                if (camps && !error) {
                    campData = camps;
                    campName = camps.name || null;
                    if (camps.owner_name) {
                        userName = camps.owner_name;
                    }
                }
            } catch (e) {
                console.warn('Could not load camp data:', e);
            }
        }
        
        // Get display values
        let displayCampName = campName || currentUser.user_metadata?.camp_name || 'Your Camp';
        let campAddress = campData?.address || '';
        
        console.log('📊 Final display values:', { displayCampName, userName, campAddress });
        
        // Update the personalized welcome message
        updateWelcomeMessage();
        
        // Update profile card displays
        if (profileCampName) {
            profileCampName.textContent = displayCampName || '—';
        }
        if (profileAddress) {
            profileAddress.textContent = campAddress || 'Not set';
        }
        
        // Pre-fill edit form (only relevant for owners)
        if (editCampName) {
            editCampName.value = displayCampName !== 'Your Camp' ? displayCampName : '';
        }
        if (editAddress) {
            editAddress.value = campAddress;
        }
        
        // Load stats from cloud storage
        await loadStats();
    }

    // ========================================
    // CHECK ACCESS CONTROL (RBAC)
    // ========================================
    async function checkAccessControl() {
        // Only show team section for owners
        if (userRole !== 'owner') {
            if (teamAccessSection) teamAccessSection.style.display = 'none';
            return;
        }
        
        const checkRole = async () => {
            if (window.AccessControl) {
                try {
                    if (!window.AccessControl.isInitialized) {
                        await window.AccessControl.initialize();
                    }
                    
                    const role = window.AccessControl.getCurrentRole();
                    console.log('Current user role:', role);
                    
                    if (role === 'owner') {
                        if (teamAccessSection) {
                            teamAccessSection.style.display = 'block';
                            
                            if (window.TeamSubdivisionsUI) {
                                document.getElementById('subdivisions-placeholder')?.remove();
                                document.getElementById('team-placeholder')?.remove();
                                
                                await window.TeamSubdivisionsUI.initialize();
                                window.TeamSubdivisionsUI.renderSubdivisionsCard(
                                    document.getElementById('subdivisions-card')
                                );
                                window.TeamSubdivisionsUI.renderTeamCard(
                                    document.getElementById('team-card')
                                );
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Error checking access control:', err);
                }
            }
        };
        await checkRole();
        
        document.addEventListener('campistry-access-loaded', async (e) => {
            if (e.detail.role === 'owner') {
                if (teamAccessSection) teamAccessSection.style.display = 'block';
                if (window.TeamSubdivisionsUI) {
                    document.getElementById('subdivisions-placeholder')?.remove();
                    document.getElementById('team-placeholder')?.remove();
                    
                    await window.TeamSubdivisionsUI.initialize();
                    window.TeamSubdivisionsUI.renderSubdivisionsCard(
                        document.getElementById('subdivisions-card')
                    );
                    window.TeamSubdivisionsUI.renderTeamCard(
                        document.getElementById('team-card')
                    );
                }
            }
        });
    }

    // ========================================
    // LOAD STATS (from Campistry Me data)
    // ========================================
    
    async function loadStats() {
        try {
            const campId = localStorage.getItem('campistry_camp_id') || localStorage.getItem('campistry_user_id') || currentUser.id;

            // Read per-key rows from camp_state_kv, fall back to legacy blob
            let state = null;
            const { data: kvRows, error: kvErr } = await window.supabase
                .from('camp_state_kv')
                .select('key, value')
                .eq('camp_id', campId);

            if (!kvErr && kvRows && kvRows.length > 0) {
                state = {};
                kvRows.forEach(r => { state[r.key] = r.value; });
            } else {
                const { data } = await window.supabase
                    .from('camp_state')
                    .select('state')
                    .eq('camp_id', campId)
                    .maybeSingle();
                if (data?.state) state = data.state;
            }

            if (state) {
                // ★ Divisions: prefer campStructure (Campistry Me format) over old app1 format
                const campStructure = state.campStructure || {};
                const oldDivisions = state.divisions || state.app1?.divisions || {};
                const divisionCount = Object.keys(campStructure).length || Object.keys(oldDivisions).length;

                // ★ Bunks: count from campStructure grades → bunks arrays, fallback to old flat list
                let bunkCount = 0;
                if (Object.keys(campStructure).length > 0) {
                    Object.values(campStructure).forEach(div => {
                        Object.values(div.grades || {}).forEach(grade => {
                            bunkCount += (grade.bunks || []).length;
                        });
                    });
                } else {
                    const bunks = state.bunks || state.app1?.bunks || [];
                    bunkCount = bunks.length;
                }

                // ★ Campers: count actual roster entries (Campistry Me), fallback to bunkMetaData estimates
                const camperRoster = state.app1?.camperRoster || {};
                let camperCount = Object.keys(camperRoster).length;
                if (camperCount === 0) {
                    const bunkMeta = state.bunkMetaData || state.app1?.bunkMetaData || {};
                    Object.values(bunkMeta).forEach(meta => {
                        camperCount += meta?.size || 0;
                    });
                }

                // Update UI
                if (statDivisions) statDivisions.textContent = divisionCount || '—';
                if (statBunks) statBunks.textContent = bunkCount || '—';
                if (statCampers) statCampers.textContent = camperCount > 0 ? camperCount : '—';
            }
        } catch (e) {
            console.warn('Could not load stats:', e);
        }
    }

    // ========================================
    // EDIT PROFILE (Owners only)
    // ========================================
    
    window.toggleEditMode = function() {
        // Only owners can edit
        if (isTeamMember) {
            alert('Only camp owners can edit the camp profile.');
            return;
        }
        
        isEditMode = !isEditMode;
        
        if (profileView) profileView.style.display = isEditMode ? 'none' : 'block';
        if (profileEditForm) profileEditForm.style.display = isEditMode ? 'flex' : 'none';
        
        const editBtn = document.getElementById('editProfileBtn');
        if (editBtn) {
            editBtn.innerHTML = isEditMode 
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
        }
    };
    
    window.saveProfile = async function() {
        // Double-check only owners can save
        if (isTeamMember) {
            if (profileError) {
                profileError.textContent = 'Only camp owners can edit the camp profile. Contact your camp owner.';
            }
            return;
        }
        
        const newCampName = editCampName?.value.trim();
        const newAddress = editAddress?.value.trim();
        
        if (!newCampName) {
            if (profileError) profileError.textContent = 'Camp name is required.';
            return;
        }
        
        if (profileError) profileError.textContent = '';
        if (profileSuccess) profileSuccess.textContent = '';
        
        try {
            if (campData?.id) {
                const { error } = await window.supabase
                    .from('camps')
                    .update({ name: newCampName, address: newAddress })
                    .eq('id', campData.id);

                if (error) throw error;

                // Keep the saved-settings copies of the name in sync with the
                // camp record. Renaming the camp updated only the DB row; the
                // Live view, Print Center, and Me page read app1.campName /
                // camp_name from settings, which otherwise stay stale (this is
                // why the Live view kept showing the old "Camp Awesome").
                try {
                    if (typeof window.loadGlobalSettings === 'function' &&
                        typeof window.saveGlobalSettings === 'function') {
                        const _gs = window.loadGlobalSettings() || {};
                        if (!_gs.app1) _gs.app1 = {};
                        _gs.app1.campName = newCampName;
                        window.saveGlobalSettings('app1', _gs.app1);
                        window.saveGlobalSettings('campName', newCampName);
                        window.saveGlobalSettings('camp_name', newCampName);
                    }
                } catch (e) {
                    console.warn('[Dashboard] camp-name settings sync failed:', e);
                }
            } else {
                // ⭐ FIX: Double-check this user is NOT a team member before creating
                // Check if they have a pending invite
                const { data: pendingInvite } = await window.supabase
                    .from('camp_users')
                    .select('id')
                    .eq('email', currentUser.email.toLowerCase())
                    .maybeSingle();
                
                if (pendingInvite) {
                    if (profileError) {
                        profileError.textContent = 'You have a pending camp invitation. Please accept it first.';
                    }
                    return;
                }
                
                // Also check if they're already a team member
                const { data: existingMember } = await window.supabase
                    .from('camp_users')
                    .select('id')
                    .eq('user_id', currentUser.id)
                    .maybeSingle();
                
                if (existingMember) {
                    if (profileError) {
                        profileError.textContent = 'You are already a member of another camp.';
                    }
                    return;
                }
                
                // Create new camp
                const { data: newCamp, error } = await window.supabase
                    .from('camps')
                    .insert([{ 
                        owner: currentUser.id, 
                        name: newCampName, 
                        address: newAddress 
                    }])
                    .select()
                    .single();
                
                if (error) throw error;
                campData = newCamp;
            }
            
            // Update local state
            campName = newCampName;
            
            // Update displays
            if (profileCampName) profileCampName.textContent = newCampName;
            if (profileAddress) profileAddress.textContent = newAddress || 'Not set';
            if (campNameDisplay) campNameDisplay.textContent = newCampName;
            
            updateWelcomeMessage();
            
            if (profileSuccess) profileSuccess.textContent = 'Profile updated successfully!';
            
            // Exit edit mode after short delay
            setTimeout(() => {
                window.toggleEditMode();
                if (profileSuccess) profileSuccess.textContent = '';
            }, 1500);
            
        } catch (e) {
            console.error('Error saving profile:', e);
            if (profileError) profileError.textContent = 'Error saving profile. Please try again.';
        }
    };

    // ========================================
    // CANCEL EDIT
    // ========================================
    
    window.cancelEdit = function() {
        window.toggleEditMode();
    };

    // ========================================
    // CHANGE PASSWORD
    // ========================================
    
    window.changePassword = async function() {
        const pw = newPassword?.value;
        const confirm = confirmPassword?.value;
        
        if (passwordError) passwordError.textContent = '';
        if (passwordSuccess) passwordSuccess.textContent = '';
        
        if (!pw || pw.length < 6) {
            if (passwordError) passwordError.textContent = 'Password must be at least 6 characters.';
            return;
        }
        
        if (pw !== confirm) {
            if (passwordError) passwordError.textContent = 'Passwords do not match.';
            return;
        }
        
        try {
            const { error } = await window.supabase.auth.updateUser({ password: pw });
            
            if (error) throw error;
            
            if (passwordSuccess) passwordSuccess.textContent = 'Password changed successfully!';
            if (newPassword) newPassword.value = '';
            if (confirmPassword) confirmPassword.value = '';
            
        } catch (e) {
            console.error('Error changing password:', e);
            if (passwordError) passwordError.textContent = 'Error changing password. Please try again.';
        }
    };

    // ========================================
    // LOGOUT
    // ========================================
    
    window.logout = async function() {
        try {
            // Clear auth keys
            localStorage.removeItem('campistry_user_id');
            localStorage.removeItem('campistry_auth_user_id');
            localStorage.removeItem('campistry_role');
            localStorage.removeItem('campistry_is_team_member');
            localStorage.removeItem('campistry_camp_id');
            
            // ⭐ NEW: Clear camp data keys to prevent data leak to next user
            localStorage.removeItem('campGlobalSettings_v1');
            localStorage.removeItem('campistryGlobalSettings');
            localStorage.removeItem('CAMPISTRY_LOCAL_CACHE');
            localStorage.removeItem('campDailyData_v1');
            
            // ★★★ v2.4: Clear RBAC session cache ★★★
            sessionStorage.removeItem('campistry_rbac_cache');
            
            await window.supabase.auth.signOut();
            window.location.href = 'index.html';
        } catch (e) {
            console.error('Auth check failed:', e);
            // ★ v2.5 FIX: Don't redirect on transient errors if cached auth exists
            const cachedUserId = localStorage.getItem('campistry_auth_user_id');
            const cachedCampId = localStorage.getItem('campistry_camp_id');
            if (cachedUserId && cachedCampId) {
                console.warn('🔑 [Dashboard] Error during auth, but cached auth exists — staying on dashboard');
                // Try to load dashboard with cached data
                try { await loadDashboardData(); setupDashboardForRole(); } catch(e2) { console.warn('Dashboard load with cache failed:', e2); }
            } else {
                window.location.href = 'index.html';
            }
        }
    };
    
    // Alias for HTML compatibility
    window.handleLogout = window.logout;

    // ========================================
    // CAMP DATES
    // ========================================

    async function loadCampDates(readOnly) {
        try {
            var campId = localStorage.getItem('campistry_camp_id') || localStorage.getItem('campistry_user_id') || (membership ? membership.camp_id : null) || currentUser.id;
            var campDates = null;

            var { data: kvRows, error: kvErr } = await window.supabase
                .from('camp_state_kv')
                .select('key, value')
                .eq('camp_id', campId)
                .eq('key', 'campDates');

            if (!kvErr && kvRows && kvRows.length > 0) {
                campDates = kvRows[0].value;
            }

            var startEl = document.getElementById('campStartDate');
            var h1EndEl = document.getElementById('campHalf1End');
            var h2StartEl = document.getElementById('campHalf2Start');
            var endEl = document.getElementById('campEndDate');

            if (campDates) {
                if (startEl && campDates.startDate) startEl.value = campDates.startDate;
                if (h1EndEl && campDates.half1End) h1EndEl.value = campDates.half1End;
                if (h2StartEl && campDates.half2Start) h2StartEl.value = campDates.half2Start;
                if (endEl && campDates.endDate) endEl.value = campDates.endDate;
                updateWeekPreview();
            }

            if (readOnly) {
                [startEl, h1EndEl, h2StartEl, endEl].forEach(function(el) {
                    if (el) { el.disabled = true; el.style.backgroundColor = 'var(--slate-50)'; el.style.color = 'var(--slate-500)'; }
                });
                var actions = document.getElementById('campDatesActions');
                if (actions) actions.style.display = 'none';
            }
        } catch (e) {
            console.warn('Could not load camp dates:', e);
        }
    }

    function buildWeekMap(startDate, endDate) {
        if (!startDate) return null;
        // ★ CB-97: format Dates from their LOCAL components. The dates are built as local midnight
        // (new Date(s+'T00:00:00')); toISOString() converts to UTC, rolling the day back one in every
        // positive-UTC-offset timezone (e.g. Asia/Kolkata showed week boundaries one day early).
        var fmtLocal = function (d) {
            var y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
            return y + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
        };
        var start = new Date(startDate + 'T00:00:00');
        var end = endDate ? new Date(endDate + 'T00:00:00') : null;
        var weeks = [];
        var weekStart = new Date(start);
        var weekNum = 1;
        while (!end || weekStart <= end) {
            var nextSunday = new Date(weekStart);
            var dow = nextSunday.getDay();
            var daysUntilSun = dow === 0 ? 7 : 7 - dow;
            nextSunday.setDate(nextSunday.getDate() + daysUntilSun);
            var weekEnd = (end && nextSunday > end) ? new Date(end) : new Date(nextSunday);
            weekEnd.setDate(weekEnd.getDate() - 1);
            weeks.push({
                week: weekNum,
                start: fmtLocal(weekStart),
                end: fmtLocal(weekEnd)
            });
            weekStart = new Date(nextSunday);
            weekNum++;
            if (weekNum > 52) break;
        }
        return weeks;
    }

    function updateWeekPreview() {
        var startDate = document.getElementById('campStartDate')?.value;
        var endDate = document.getElementById('campEndDate')?.value;
        var h1End = document.getElementById('campHalf1End')?.value;
        var h2Start = document.getElementById('campHalf2Start')?.value;
        var preview = document.getElementById('campDatesWeekPreview');
        if (!preview) return;

        if (!startDate) {
            preview.style.display = 'none';
            return;
        }

        var weeks = buildWeekMap(startDate, endDate);
        if (!weeks || weeks.length === 0) {
            preview.style.display = 'none';
            return;
        }

        var fmt = function(d) {
            var parts = d.split('-');
            return parseInt(parts[1]) + '/' + parseInt(parts[2]);
        };
        var html = '<strong style="color:var(--slate-700);">Week breakdown:</strong><br>';
        var transitionShown = false;
        weeks.forEach(function(w) {
            var halfTag = '';
            if (h1End && h2Start) {
                var isFirstHalf = w.end <= h1End;
                var containsH2Start = w.start <= h2Start && w.end >= h2Start;
                if (!transitionShown && containsH2Start) {
                    html += '<span style="color:#d97706; font-weight:600;">Transition: ' + fmt(h1End) + ' – ' + fmt(h2Start) + '</span><br>';
                    transitionShown = true;
                }
                if (isFirstHalf) halfTag = ' <span style="color:#7C3AED; font-weight:600;">(1st half)</span>';
                else halfTag = ' <span style="color:#2563EB; font-weight:600;">(2nd half)</span>';
            }
            html += 'Week ' + w.week + ': ' + fmt(w.start) + ' – ' + fmt(w.end) + halfTag + '<br>';
        });

        preview.innerHTML = html;
        preview.style.display = 'block';
    }

    window.saveCampDates = async function() {
        var status = document.getElementById('campDatesStatus');
        // ★ CB-98: owner-only write guard. The UI is read-only for admin/scheduler (loadCampDates
        // disables inputs + hides actions), but these global writers had NO role check — a console
        // call or stale UI could overwrite the owner's half boundaries, silently shifting every
        // Per-Half rotation boundary. Mirror saveProfile's isTeamMember gate.
        if (isTeamMember) {
            if (status) { status.textContent = 'Only camp owners can edit camp dates.'; status.style.color = '#dc2626'; }
            return;
        }
        var startDate = document.getElementById('campStartDate')?.value || null;
        var h1End = document.getElementById('campHalf1End')?.value || null;
        var h2Start = document.getElementById('campHalf2Start')?.value || null;
        var endDate = document.getElementById('campEndDate')?.value || null;

        var campDates = {
            startDate: startDate,
            half1End: h1End,
            half2Start: h2Start,
            endDate: endDate
        };

        try {
            var campId = localStorage.getItem('campistry_camp_id') || localStorage.getItem('campistry_user_id') || currentUser.id;
            var { error } = await window.supabase
                .from('camp_state_kv')
                .upsert({ camp_id: campId, key: 'campDates', value: campDates, updated_at: new Date().toISOString() },
                         { onConflict: 'camp_id,key' });

            if (error) throw error;
            // Also update local settings cache so Flow/scheduler pick it up immediately
            if (window.saveGlobalSettings) window.saveGlobalSettings('campDates', campDates);
            if (status) { status.textContent = 'Saved!'; status.style.color = '#059669'; setTimeout(function() { status.textContent = ''; }, 3000); }
            updateWeekPreview();
        } catch (e) {
            console.error('Error saving camp dates:', e);
            if (status) { status.textContent = 'Error saving.'; status.style.color = '#dc2626'; }
        }
    };

    window.clearCampDates = async function() {
        // ★ CB-98: owner-only write guard (see saveCampDates).
        if (isTeamMember) {
            var _st = document.getElementById('campDatesStatus');
            if (_st) { _st.textContent = 'Only camp owners can edit camp dates.'; _st.style.color = '#dc2626'; }
            return;
        }
        document.getElementById('campStartDate').value = '';
        document.getElementById('campHalf1End').value = '';
        document.getElementById('campHalf2Start').value = '';
        document.getElementById('campEndDate').value = '';
        document.getElementById('campDatesWeekPreview').style.display = 'none';

        try {
            var campId = localStorage.getItem('campistry_camp_id') || localStorage.getItem('campistry_user_id') || currentUser.id;
            await window.supabase
                .from('camp_state_kv')
                .upsert({ camp_id: campId, key: 'campDates', value: null, updated_at: new Date().toISOString() },
                         { onConflict: 'camp_id,key' });
            if (window.saveGlobalSettings) window.saveGlobalSettings('campDates', null);
            var status = document.getElementById('campDatesStatus');
            if (status) { status.textContent = 'Cleared.'; status.style.color = 'var(--slate-400)'; setTimeout(function() { status.textContent = ''; }, 3000); }
        } catch (e) {
            console.warn('Error clearing camp dates:', e);
        }
    };

    // Live preview on date change
    ['campStartDate', 'campHalf1End', 'campHalf2Start', 'campEndDate'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', updateWeekPreview);
    });

    // ========================================
    // INITIALIZE
    // ========================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAuth);
    } else {
        checkAuth();
    }

})();
