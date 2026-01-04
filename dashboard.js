// ============================================================================
// dashboard.js — Campistry Dashboard Logic (Multi-Tenant) v2.0
// 
// Handles:
// - Auth check (redirect to landing if not logged in)
// - Load/display camp profile (for owners AND team members)
// - Personalized welcome message with user name and camp name
// - Show role and permissions for team members
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
            window.location.href = 'landing.html';
            return;
        }
        
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            
            if (!session?.user) {
                console.log('No session, redirecting to landing');
                window.location.href = 'landing.html';
                return;
            }
            
            currentUser = session.user;
            console.log('User authenticated:', currentUser.email);
            
            // Determine user's role and camp membership
            await determineUserRole();
            
            // Load dashboard data
            await loadDashboardData();
            
            // Show appropriate sections based on role
            setupDashboardForRole();
            
        } catch (e) {
            console.error('Auth check failed:', e);
            window.location.href = 'landing.html';
        }
    }

    // ========================================
    // DETERMINE USER ROLE
    // ========================================
    
    async function determineUserRole() {
        console.log('📊 Determining user role...');
        
        // First check if user owns any camps
        try {
            const { data: ownedCamp } = await window.supabase
                .from('camps')
                .select('*')
                .eq('owner', currentUser.id)
                .maybeSingle();
            
            if (ownedCamp) {
                console.log('📊 User is a camp owner');
                userRole = 'owner';
                isTeamMember = false;
                campData = ownedCamp;
                campName = ownedCamp.name || 'Your Camp';
                userName = ownedCamp.owner_name || currentUser.email.split('@')[0];
                return;
            }
        } catch (e) {
            console.warn('Error checking camp ownership:', e);
        }
        
        // Not an owner - check if they're a team member
        try {
            const { data: memberData } = await window.supabase
                .from('camp_users')
                .select('*, camps:camp_id(name, address, owner)')
                .eq('user_id', currentUser.id)
                .not('accepted_at', 'is', null)
                .maybeSingle();
            
            if (memberData) {
                console.log('📊 User is a team member:', memberData.role);
                userRole = memberData.role;
                isTeamMember = true;
                membership = memberData;
                userName = memberData.name || currentUser.email.split('@')[0];
                
                // Get camp data from the join
                if (memberData.camps) {
                    campData = {
                        name: memberData.camps.name,
                        address: memberData.camps.address,
                        owner: memberData.camps.owner
                    };
                    campName = memberData.camps.name || 'Your Camp';
                }
                
                // Store camp ID for cloud storage
                localStorage.setItem('campistry_user_id', memberData.camp_id);
                return;
            }
        } catch (e) {
            console.warn('Error checking team membership:', e);
        }
        
        // User is neither - they're a new user (this shouldn't normally happen from dashboard)
        console.log('📊 User has no camp association');
        userRole = 'owner'; // Default to owner for new users
        isTeamMember = false;
        userName = currentUser.email.split('@')[0];
        campName = 'Your Camp';
    }

    // ========================================
    // UPDATE WELCOME MESSAGE
    // ========================================
    
    function updateWelcomeMessage() {
        // Find the welcome section - it might have different structures
        const welcomeSection = document.querySelector('.welcome-section');
        const welcomeTitle = document.querySelector('.welcome-section h1, .welcome-title, #welcomeTitle');
        const welcomeSubtitle = document.querySelector('.welcome-section p, .welcome-subtitle, #welcomeSubtitle');
        
        // Build the personalized welcome
        const displayName = userName || 'there';
        const displayCamp = campName || 'Your Camp';
        
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
        
        console.log('📊 Welcome message updated:', `Welcome, ${displayName}!`, `Camp: ${displayCamp}`);
    }

    // ========================================
    // SETUP DASHBOARD FOR ROLE
    // ========================================
    
    function setupDashboardForRole() {
        const editProfileBtn = document.getElementById('editProfileBtn');
        const profileCard = document.querySelector('.profile-card');
        
        if (isTeamMember) {
            // Team members can't edit camp profile
            if (editProfileBtn) {
                editProfileBtn.style.display = 'none';
            }
            
            // Add role badge to profile card
            addRoleBadge();
            
            // Add "Your Permissions" section
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
        
        // Get permissions text
        const permissionsText = getPermissionsText();
        
        roleBadge.innerHTML = `
            <span class="role-icon">${getRoleIcon(userRole)}</span>
            <span class="role-text">${permissionsText}</span>
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
        `;
        
        welcomeSection.appendChild(roleBadge);
    }
    
    /**
     * Get human-readable permissions text
     * e.g., "Scheduler for Grades 1, 2, and 3"
     */
    function getPermissionsText() {
        if (userRole === 'owner') {
            return 'Owner — Full access to all features';
        }
        
        if (userRole === 'admin') {
            return 'Administrator — Full editing access';
        }
        
        if (userRole === 'viewer') {
            return 'Viewer — View-only access';
        }
        
        if (userRole === 'scheduler') {
            // We'll update this after loading subdivisions
            if (membership?.subdivision_ids?.length > 0) {
                return 'Scheduler — Loading divisions...';
            }
            return 'Scheduler — Full editing access';
        }
        
        return userRole || 'Unknown';
    }
    
    /**
     * Update the role badge with actual subdivision names
     */
    async function updateRoleBadgeWithSubdivisions() {
        if (userRole !== 'scheduler' || !membership?.subdivision_ids?.length) return;
        
        try {
            const { data: subdivisions } = await window.supabase
                .from('subdivisions')
                .select('name')
                .in('id', membership.subdivision_ids);
            
            if (subdivisions && subdivisions.length > 0) {
                const names = subdivisions.map(s => s.name);
                let text = '';
                
                if (names.length === 1) {
                    text = `Scheduler for ${names[0]}`;
                } else if (names.length === 2) {
                    text = `Scheduler for ${names[0]} and ${names[1]}`;
                } else {
                    const last = names.pop();
                    text = `Scheduler for ${names.join(', ')}, and ${last}`;
                }
                
                // Update the badge
                const badge = document.querySelector('.role-badge-large .role-text');
                if (badge) {
                    badge.textContent = text;
                }
            }
        } catch (e) {
            console.warn('Could not load subdivision names for badge:', e);
        }
    }
    
    function addPermissionsSection() {
        const dashboardGrid = document.querySelector('.dashboard-grid');
        if (!dashboardGrid) return;
        
        // Check if already exists
        if (document.querySelector('.permissions-card')) return;
        
        // Create permissions card
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
                    <span class="permission-value">${userRole === 'viewer' ? '❌ No' : '✅ Yes'}</span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can View All</span>
                    <span class="permission-value">✅ Yes</span>
                </div>
                <div class="permission-divider"></div>
                <div class="permission-section">
                    <h4 style="margin: 0 0 8px; color: var(--slate-700);">Assigned Divisions</h4>
                    <div id="assigned-divisions">${divisionsHtml}</div>
                </div>
            </div>
        `;
        
        // Add custom styles
        if (!document.getElementById('permissions-styles')) {
            const style = document.createElement('style');
            style.id = 'permissions-styles';
            style.textContent = `
                .permission-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 0;
                    border-bottom: 1px solid var(--slate-100);
                }
                .permission-label {
                    color: var(--slate-600);
                    font-weight: 500;
                }
                .permission-value {
                    font-weight: 600;
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
        
        // Update the role badge with subdivision names
        updateRoleBadgeWithSubdivisions();
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
        
        // Get camp name - either from owned camp or team membership
        let displayCampName = campName || campData?.name || currentUser.user_metadata?.camp_name || 'Your Camp';
        let campAddress = campData?.address || '';
        
        // If owner and no campData yet, try to fetch it
        if (!campData && !isTeamMember) {
            try {
                const { data: camps, error } = await window.supabase
                    .from('camps')
                    .select('*')
                    .eq('owner', currentUser.id)
                    .maybeSingle();
                
                if (camps && !error) {
                    campData = camps;
                    displayCampName = camps.name || displayCampName;
                    campAddress = camps.address || '';
                    campName = displayCampName;
                    
                    // Also get owner name if available
                    if (camps.owner_name) {
                        userName = camps.owner_name;
                    }
                }
            } catch (e) {
                console.warn('Could not load camp data:', e);
            }
        }
        
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
            editCampName.value = displayCampName;
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
                ? 'Cancel'
                : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                   </svg> Edit`;
        }
        
        if (profileError) profileError.textContent = '';
        if (profileSuccess) profileSuccess.textContent = '';
    };
    
    window.cancelEdit = function() {
        isEditMode = false;
        
        if (profileView) profileView.style.display = 'block';
        if (profileEditForm) profileEditForm.style.display = 'none';
        
        const editBtn = document.getElementById('editProfileBtn');
        if (editBtn) {
            editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
               </svg> Edit`;
        }
        
        if (editCampName) editCampName.value = profileCampName?.textContent || '';
        if (editAddress) editAddress.value = profileAddress?.textContent === 'Not set' ? '' : profileAddress?.textContent || '';
        
        if (profileError) profileError.textContent = '';
        if (profileSuccess) profileSuccess.textContent = '';
    };

    // Profile form submission
    if (profileEditForm) {
        profileEditForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Only owners can submit
            if (isTeamMember) return;
            
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
                    const { data, error } = await window.supabase
                        .from('camps')
                        .insert([{ 
                            name: newCampName, 
                            address: newAddress,
                            owner: currentUser.id 
                        }])
                        .select()
                        .single();
                    
                    if (error) throw error;
                    campData = data;
                }
                
                const { error: metaError } = await window.supabase.auth.updateUser({
                    data: { camp_name: newCampName }
                });
                if (metaError) {
                    console.error('Failed to update camp name metadata:', metaError);
                }
                
                // Update local state
                campName = newCampName;
                
                // Update displays
                if (campNameDisplay) campNameDisplay.textContent = newCampName;
                if (profileCampName) profileCampName.textContent = newCampName;
                if (profileAddress) profileAddress.textContent = newAddress || 'Not set';
                
                // Update welcome message
                updateWelcomeMessage();
                
                if (profileSuccess) profileSuccess.textContent = 'Profile updated successfully!';
                
                setTimeout(() => {
                    cancelEdit();
                }, 1500);
                
            } catch (err) {
                console.error('Profile update error:', err);
                if (profileError) profileError.textContent = err.message || 'Failed to update profile.';
            }
        });
    }

    // ========================================
    // CHANGE PASSWORD
    // ========================================
    
    if (passwordForm) {
        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const password = newPassword?.value;
            const confirm = confirmPassword?.value;
            
            if (passwordError) passwordError.textContent = '';
            if (passwordSuccess) passwordSuccess.textContent = '';
            
            if (!password || password.length < 6) {
                if (passwordError) passwordError.textContent = 'Password must be at least 6 characters.';
                return;
            }
            
            if (password !== confirm) {
                if (passwordError) passwordError.textContent = 'Passwords do not match.';
                return;
            }
            
            try {
                const { error } = await window.supabase.auth.updateUser({
                    password: password
                });
                
                if (error) throw error;
                
                if (passwordSuccess) passwordSuccess.textContent = 'Password updated successfully!';
                
                if (newPassword) newPassword.value = '';
                if (confirmPassword) confirmPassword.value = '';
                
            } catch (err) {
                console.error('Password update error:', err);
                if (passwordError) passwordError.textContent = err.message || 'Failed to update password.';
            }
        });
    }

    // ========================================
    // LOGOUT
    // ========================================
    
    window.handleLogout = async function() {
        try {
            // Clear camp ID cache
            localStorage.removeItem('campistry_user_id');
            localStorage.removeItem('campistry_auth_user_id');
            localStorage.removeItem('campistry_user_context');
            
            await window.supabase.auth.signOut();
            window.location.href = 'landing.html';
        } catch (e) {
            console.error('Logout error:', e);
            window.location.href = 'landing.html';
        }
    };

    // ========================================
    // AUTH STATE LISTENER
    // ========================================
    
    function setupAuthListener() {
        if (!window.supabase?.auth) {
            setTimeout(setupAuthListener, 200);
            return;
        }
        
        window.supabase.auth.onAuthStateChange((event, session) => {
            console.log('Auth state changed:', event);
            
            if (event === 'SIGNED_OUT') {
                localStorage.removeItem('campistry_user_id');
                localStorage.removeItem('campistry_auth_user_id');
                localStorage.removeItem('campistry_user_context');
                window.location.href = 'landing.html';
            }
        });
    }

    // ========================================
    // INIT
    // ========================================
    
    checkAuth();
    setupAuthListener();
    
    console.log('📊 Campistry Dashboard v2.0 loaded (multi-tenant)');
})();
