
// ============================================================================
// dashboard.js — Campistry Dashboard Logic (Multi-Tenant) v2.3
// 
// v2.3: CRITICAL FIX - Invitees no longer get owner permissions
//       - Changed STEP 4 fallback from 'owner' to 'viewer'
//
// v2.2: FIXED - Check team membership BEFORE camp ownership
//       FIXED - Prevent team members from creating camps
//
// Handles:
// - Auth check (redirect to landing if not logged in)
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
        // Wait for Supabase
        let attempts = 0;
        while (!window.supabase && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        
        if (!window.supabase) {
            console.error('Supabase not available');
            window.location.href = 'index.html';
            return;
        }
        
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            
            if (!session?.user) {
               console.log('No session, redirecting to login');
                window.location.href = 'index.html';
                return;
            }
            
            currentUser = session.user;
            console.log('📊 User authenticated:', currentUser.email);
            
            // Determine user's role and camp membership
            await determineUserRole();
            
            // Load dashboard data
            await loadDashboardData();
            
            // Show appropriate sections based on role
            setupDashboardForRole();
            
        } catch (e) {
            console.error('Auth check failed:', e);
            window.location.href = 'index.html';
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
            const { data: ownedCamp, error: campError } = await window.supabase
                .from('camps')
                .select('*')
                .eq('owner', currentUser.id)
                .maybeSingle();
            
            console.log('📊 Camp ownership check result:', { ownedCamp, campError });
            
            if (ownedCamp && !campError) {
                console.log('📊 User is a camp owner, camp:', ownedCamp.name);
                userRole = 'owner';
                isTeamMember = false;
                campData = ownedCamp;
                campName = ownedCamp.name || null;
                userName = ownedCamp.owner_name || null;
                
                // Store camp ID
                localStorage.setItem('campistry_user_id', currentUser.id);
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
    // UPDATE WELCOME MESSAGE
    // ========================================
    
    function updateWelcomeMessage() {
        const welcomeSection = document.querySelector('.welcome-section');
        const welcomeTitle = document.querySelector('.welcome-section h1, .welcome-title, #welcomeTitle');
        const welcomeSubtitle = document.querySelector('.welcome-section p, .welcome-subtitle, #welcomeSubtitle');
        
        // Build the personalized welcome
        // Use stored name, or email prefix as fallback
        const displayName = userName || currentUser.email.split('@')[0];
        const displayCamp = campName || 'Your Camp';
        
        console.log('📊 Updating welcome:', { displayName, displayCamp, userName, campName });
        
        // Update the title
        if (welcomeTitle) {
            welcomeTitle.textContent = `Welcome, ${displayName}!`;
        }
        
        // Update the subtitle to show camp name
        if (welcomeSubtitle) {
            welcomeSubtitle.innerHTML = `<span style="color: var(--primary, #6366F1); font-weight: 600;">${displayCamp}</span> — Manage your camp and access all Campistry products.`;
        }
        
        // Also update the campNameDisplay if it exists (legacy support)
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
            
        } else if (userRole === 'owner') {
            // Owner sees everything
            checkAccessControl();
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
            <span class="role-icon">${getRoleIcon(userRole)}</span>
            <span class="role-text">${getRoleDisplayName(userRole)}</span>
        `;
        roleBadge.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: ${getRoleColor(userRole)}15;
            color: ${getRoleColor(userRole)};
            border-radius: 999px;
            font-size: 0.9rem;
            margin-top: 12px;
            border: 1px solid ${getRoleColor(userRole)}30;
            font-weight: 600;
        `;
        
        welcomeSection.appendChild(roleBadge);
        
        // For schedulers, update with subdivision names
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
                const names = subdivisions.map(s => s.name).join(', ');
                badgeElement.innerHTML = `
                    <span class="role-icon">${getRoleIcon(userRole)}</span>
                    <span class="role-text">Scheduler for ${names}</span>
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
            divisionsHtml = '<p style="color: var(--slate-600);"><strong>All divisions</strong> - Full access</p>';
        } else if (userRole === 'viewer') {
            divisionsHtml = '<p style="color: var(--slate-500);">View-only access to all divisions</p>';
        } else if (userRole === 'scheduler') {
            divisionsHtml = '<p style="color: var(--slate-600);"><strong>All divisions</strong> - No restrictions</p>';
        }
        
        permissionsCard.innerHTML = `
            <div class="card-header">
                <h2>Your Permissions</h2>
            </div>
            <div class="permissions-content">
                <div class="permission-row">
                    <span class="permission-label">Role</span>
                    <span class="permission-value">
                        <span class="role-badge-small" style="background: ${getRoleColor(userRole)}15; color: ${getRoleColor(userRole)}; padding: 4px 12px; border-radius: 999px; font-weight: 600;">
                            ${getRoleIcon(userRole)} ${getRoleDisplayName(userRole)}
                        </span>
                    </span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Edit Schedules</span>
                    <span class="permission-value">${userRole === 'viewer' ? '❌ No' : '✅ Yes'}</span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Print</span>
                    <span class="permission-value">✅ Yes</span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Use Camper Locator</span>
                    <span class="permission-value">✅ Yes</span>
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
                }
                .permission-value {
                    color: var(--slate-800);
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
            container.innerHTML = '<p style="color: var(--slate-600);"><strong>All divisions</strong> - Full admin access</p>';
            return;
        }
        
        if (userRole === 'viewer') {
            container.innerHTML = '<p style="color: var(--slate-500);">View-only access - cannot edit any divisions</p>';
            return;
        }
        
        // For schedulers, load their assigned subdivisions
        if (!membership || !membership.subdivision_ids || membership.subdivision_ids.length === 0) {
            container.innerHTML = '<p style="color: var(--slate-600);"><strong>All divisions</strong> - No restrictions</p>';
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
                            <div style="font-weight: 600; color: var(--slate-800);">${sub.name}</div>
                            <div style="font-size: 0.85rem; color: var(--slate-500); margin-top: 4px;">
                                ${sub.divisions && sub.divisions.length > 0 
                                    ? sub.divisions.map(d => `<span class="division-tag">${d}</span>`).join('')
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
            viewer: 'Viewer'
        };
        return names[role] || role || 'Unknown';
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
    
    function getRoleIcon(role) {
        const icons = {
            owner: '👑',
            admin: '⚡',
            scheduler: '📅',
            viewer: '👁️'
        };
        return icons[role] || '👤';
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
                const { data: camps, error } = await window.supabase
                    .from('camps')
                    .select('*')
                    .eq('owner', currentUser.id)
                    .maybeSingle();
                
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
    // LOAD STATS
    // ========================================
    
    async function loadStats() {
        try {
            // Get camp ID - for team members, this is the camp they belong to
            const campId = localStorage.getItem('campistry_user_id') || currentUser.id;
            
            const { data, error } = await window.supabase
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .maybeSingle();
            
            if (data?.state) {
                const state = data.state;
                
                // Count divisions
                const divisions = state.divisions || state.app1?.divisions || {};
                const divisionCount = Object.keys(divisions).length;
                
                // Count bunks
                const bunks = state.bunks || state.app1?.bunks || [];
                const bunkCount = bunks.length;
                
                // Count campers
                let camperCount = 0;
                const bunkMeta = state.bunkMetaData || state.app1?.bunkMetaData || {};
                Object.values(bunkMeta).forEach(meta => {
                    camperCount += meta?.size || 0;
                });
                
                // Update UI
                if (statDivisions) statDivisions.textContent = divisionCount;
                if (statBunks) statBunks.textContent = bunkCount;
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
                ? '<span class="icon">✕</span> Cancel'
                : '<span class="icon">✎</span> Edit';
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
            // Clear local storage
            localStorage.removeItem('campistry_user_id');
            localStorage.removeItem('campistry_auth_user_id');
            localStorage.removeItem('campistry_role');
            localStorage.removeItem('campistry_is_team_member');
            localStorage.removeItem('campistry_camp_id');
            
            await window.supabase.auth.signOut();
            window.location.href = 'index.html';
        } catch (e) {
            console.error('Error logging out:', e);
            window.location.href = 'index.html';
        }
    };
    
    // Alias for HTML compatibility
    window.handleLogout = window.logout;

    // ========================================
    // INITIALIZE
    // ========================================
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAuth);
    } else {
        checkAuth();
    }
    
})();
