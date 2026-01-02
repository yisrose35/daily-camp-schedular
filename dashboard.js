// ============================================================================
// dashboard.js — Campistry Dashboard Logic (Multi-Tenant)
// 
// Handles:
// - Auth check (redirect to landing if not logged in)
// - Load/display camp profile (for owners AND team members)
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
                
                // Get camp data from the join
                if (memberData.camps) {
                    campData = {
                        name: memberData.camps.name,
                        address: memberData.camps.address,
                        owner: memberData.camps.owner
                    };
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
        userRole = null;
        isTeamMember = false;
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
        
        const roleBadge = document.createElement('div');
        roleBadge.className = 'role-badge-large';
        roleBadge.innerHTML = `
            <span class="role-icon">${getRoleIcon(userRole)}</span>
            <span class="role-text">You are a <strong>${getRoleDisplayName(userRole)}</strong></span>
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
    
    function addPermissionsSection() {
        const dashboardGrid = document.querySelector('.dashboard-grid');
        if (!dashboardGrid) return;
        
        // Create permissions card
        const permissionsCard = document.createElement('section');
        permissionsCard.className = 'dashboard-card permissions-card';
        
        // Get subdivision info
        let divisionsHtml = '<p style="color: var(--slate-500);">Loading...</p>';
        
        if (membership && membership.subdivision_ids && membership.subdivision_ids.length > 0) {
            // Will be populated after subdivisions load
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
                        <span class="role-${userRole}">${getRoleDisplayName(userRole)}</span>
                    </span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Edit</span>
                    <span class="permission-value">${userRole === 'viewer' ? '❌ No' : '✅ Yes'}</span>
                </div>
                <div class="permission-row">
                    <span class="permission-label">Can Generate Schedules</span>
                    <span class="permission-value">${userRole === 'viewer' ? '❌ No' : '✅ Yes'}</span>
                </div>
                <div class="permission-divider"></div>
                <div class="permission-section">
                    <h4 style="margin: 0 0 8px; color: var(--slate-700);">Assigned Divisions</h4>
                    <div id="assigned-divisions">${divisionsHtml}</div>
                </div>
            </div>
        `;
        
        // Add custom styles
        const style = document.createElement('style');
        style.textContent = `
            .permission-row {
                display: flex;
                justify-content: space-between;
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
        `;
        document.head.appendChild(style);
        
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
                        <div style="margin-bottom: 12px; padding: 12px; background: var(--slate-50); border-radius: 8px; border-left: 4px solid ${sub.color || '#6B7280'};">
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
        let campName = campData?.name || currentUser.user_metadata?.camp_name || '';
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
                    campName = camps.name || campName;
                    campAddress = camps.address || '';
                }
            } catch (e) {
                console.warn('Could not load camp data:', e);
            }
        }
        
        // Update displays
        if (campNameDisplay) {
            if (isTeamMember) {
                campNameDisplay.textContent = campName || 'Your Camp';
            } else {
                campNameDisplay.textContent = campName || 'Your Camp';
            }
        }
        if (profileCampName) {
            profileCampName.textContent = campName || '—';
        }
        if (profileAddress) {
            profileAddress.textContent = campAddress || 'Not set';
        }
        
        // Pre-fill edit form (only relevant for owners)
        if (editCampName) {
            editCampName.value = campName;
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
                
                if (campNameDisplay) campNameDisplay.textContent = newCampName;
                if (profileCampName) profileCampName.textContent = newCampName;
                if (profileAddress) profileAddress.textContent = newAddress || 'Not set';
                
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
                window.location.href = 'landing.html';
            }
        });
    }

    // ========================================
    // INIT
    // ========================================
    
    checkAuth();
    setupAuthListener();
    
    console.log('📊 Campistry Dashboard loaded (multi-tenant)');

})();
