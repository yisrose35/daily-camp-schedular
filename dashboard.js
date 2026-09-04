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
    const profileContactEmail = document.getElementById('profileContactEmail');
    const profileEmail = document.getElementById('profileEmail');
    const editCampName = document.getElementById('editCampName');
    const editAddress = document.getElementById('editAddress');
    const editContactEmail = document.getElementById('editContactEmail');
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

    // Camp Settings elements (owner-only; migrated from Campistry Me)
    const campSettingsSection = document.getElementById('camp-settings-section');

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
    
    // ========================================
    // CAMP SETUP TABS
    // One zone (Profile & Account, Camp Dates, Sessions & Pricing, Payment,
    // Camp Settings, Team & Access) instead of six stacked sections — role
    // gating hides/shows the TAB BUTTON only; switchSetupTab() owns which
    // panel's content is actually visible. Each panel's content still loads
    // lazily into the DOM the same way it always did (loadCampDates(),
    // loadSessionsSection(), etc.) — switching tabs is pure show/hide, no
    // re-fetch.
    // ========================================

    const SETUP_TAB_PANELS = {
        profile: 'dash-setup-profile',
        dates: 'camp-dates-section',
        payment: 'dash-setup-payment',
        settings: 'camp-settings-section',
        team: 'team-access-section'
    };

    function _setSetupTabVisible(tab, visible) {
        const btn = document.querySelector('.dash-setup-tab[data-tab="' + tab + '"]');
        if (btn) btn.style.display = visible ? '' : 'none';
    }

    // Sessions & Pricing lives inside the "Dates & Pricing" tab now (see
    // camp-dates-section in dashboard.html) but stays owner-only — this
    // toggles just that one card, not the whole tab, so scheduler/admin
    // team members still get their read-only Camp Dates + Attendance
    // History view without seeing pricing.
    function _setSessionsCardVisible(visible) {
        const card = document.getElementById('sessionsCard');
        if (card) card.style.display = visible ? '' : 'none';
    }

    window.switchSetupTab = function(tab) {
        document.querySelectorAll('.dash-setup-tab').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        Object.keys(SETUP_TAB_PANELS).forEach(function(key) {
            const panel = document.getElementById(SETUP_TAB_PANELS[key]);
            if (panel) panel.style.display = (key === tab) ? 'block' : 'none';
        });
    };

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

            // Hide team management, settings, and payment tabs (owner-only —
            // this just controls which Camp Setup tab BUTTONS are reachable;
            // each tab's own panel content still loads lazily below
            // regardless, same as before). Sessions & Pricing is owner-only
            // too, but it's a card inside the Dates & Pricing tab now, not
            // its own tab — hidden separately below so it doesn't hide Camp
            // Dates / Attendance History along with it.
            _setSetupTabVisible('team', false);
            _setSetupTabVisible('settings', false);
            _setSetupTabVisible('payment', false);
            _setSessionsCardVisible(false);

            // Schedulers and admins can see camp dates (read-only)
            if (userRole === 'scheduler' || userRole === 'admin') {
                _setSetupTabVisible('dates', true);
                loadCampDates(true);
            } else {
                _setSetupTabVisible('dates', false);
            }

        } else if (userRole === 'owner') {
            // Owner sees everything
            checkAccessControl();
            _setSetupTabVisible('dates', true);
            _setSessionsCardVisible(true);
            // Sessions must load BEFORE camp dates — loadCampDates() syncs
            // the half-sessions against _dashSessions, which loadSessionsSection()
            // is what populates in the first place.
            loadSessionsSection();
            loadCampDates(false);
            _setSetupTabVisible('settings', true);
            _setSetupTabVisible('payment', true);
            loadCampSettingsSection();
        }
        switchSetupTab('profile');

        // Live notifications (Link messages, Notes reminders) — for every
        // role, not just owners. RLS on `notifications` already scopes reads
        // to owner/admin/scheduler, so other roles just get an empty feed
        // back with no extra gating needed here.
        loadLiveNotifications();
        subscribeToLiveNotifications();
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
        let campContactEmail = campData?.contact_email || '';

        console.log('📊 Final display values:', { displayCampName, userName, campAddress, campContactEmail });

        // Update the personalized welcome message
        updateWelcomeMessage();

        // Update profile card displays
        if (profileCampName) {
            profileCampName.textContent = displayCampName || '—';
        }
        if (profileAddress) {
            profileAddress.textContent = campAddress || 'Not set';
        }
        if (profileContactEmail) {
            profileContactEmail.textContent = campContactEmail || 'Not set';
        }

        // Pre-fill edit form (only relevant for owners)
        if (editCampName) {
            editCampName.value = displayCampName !== 'Your Camp' ? displayCampName : '';
        }
        if (editAddress) {
            editAddress.value = campAddress;
        }
        if (editContactEmail) {
            editContactEmail.value = campContactEmail;
        }

        // Load stats from cloud storage — deliberately NOT awaited. This reads
        // the camp's entire camp_state_kv blob (campStructure, roster,
        // everything), which can take a few seconds on a real camp. It used to
        // block this whole function, which in turn blocked setupDashboardForRole()
        // at the call site below (await loadDashboardData(); setupDashboardForRole();)
        // — so Camp Dates/Sessions & Pricing/Payment/Settings sat waiting on a
        // stats query none of them actually depend on, while Profile & Account
        // (filled in synchronously above) appeared instantly. Firing this
        // without awaiting lets it populate the stat cards whenever it resolves,
        // in parallel with everything else, same as the Telnyx/Stripe Connect
        // status calls right below it already do.
        loadStats();
        // SMS sending number — a self-serve request flow, not a manual field.
        if (campData?.id) loadTelnyxStatus(campData.id);
        // Stripe Connect — where tuition money lands.
        if (campData?.id) {
            loadCampStripeConnectStatus(campData.id);
            if (new URLSearchParams(window.location.search).get('stripeReturn') === '1') {
                syncCampStripeConnectStatus(campData.id);
            }
        }
        // Which Link programs (Photos/Canteen/Shop/Tips/Camper Mail/Pickup)
        // this camp actually offers — read-only for non-owner/admin roles,
        // set_link_program_settings itself is the real (server-side) gate.
        if (campData?.id) loadLinkProgramSettings(campData.id);
    }

    // ========================================
    // CHECK ACCESS CONTROL (RBAC)
    // ========================================
    async function checkAccessControl() {
        // Only show team section for owners
        if (userRole !== 'owner') {
            _setSetupTabVisible('team', false);
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
                            _setSetupTabVisible('team', true);

                            if (window.TeamSubdivisionsUI) {
                                document.getElementById('team-access-summary-placeholder')?.remove();
                                await window.TeamSubdivisionsUI.initialize();
                                window.TeamSubdivisionsUI.renderTeamAccessSummary?.(
                                    document.getElementById('team-access-summary-card')
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
                _setSetupTabVisible('team', true);
                if (window.TeamSubdivisionsUI) {
                    document.getElementById('team-access-summary-placeholder')?.remove();
                    await window.TeamSubdivisionsUI.initialize();
                    window.TeamSubdivisionsUI.renderTeamAccessSummary?.(
                        document.getElementById('team-access-summary-card')
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
        const newContactEmail = editContactEmail?.value.trim() || null;

        if (!newCampName) {
            if (profileError) profileError.textContent = 'Camp name is required.';
            return;
        }
        if (newContactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newContactEmail)) {
            if (profileError) profileError.textContent = 'Camp contact email looks invalid.';
            return;
        }

        if (profileError) profileError.textContent = '';
        if (profileSuccess) profileSuccess.textContent = '';

        try {
            if (campData?.id) {
                // telnyx_from_number is intentionally NOT touched here — it's
                // exclusively system-managed (set once by
                // telnyx-check-registration-status when a self-serve number
                // request is approved), never a manually-edited profile field.
                const { error } = await window.supabase
                    .from('camps')
                    .update({ name: newCampName, address: newAddress, contact_email: newContactEmail })
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
                        address: newAddress,
                        contact_email: newContactEmail
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
            if (profileContactEmail) profileContactEmail.textContent = newContactEmail || 'Not set';
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
    // TEXTING NUMBER — self-serve Telnyx provisioning
    // ========================================

    var _telnyxCampId = null;
    var _telnyxStripe = null;
    var _telnyxCardEl = null;

    async function _telnyxStripePk() {
        // One platform-wide publishable key (config.js) — this used to read a
        // PER-CAMP key a camp owner typed into Settings, which was wrong: the
        // client_secret Stripe.js confirms here is always issued on
        // Campistry's own platform Stripe account (server-side, via
        // STRIPE_SECRET_KEY), so the publishable key has to match THAT
        // account, not whatever key an individual camp owner might paste in.
        return (window.__CAMPISTRY_STRIPE__ && window.__CAMPISTRY_STRIPE__.publishableKey) || '';
    }

    window.loadTelnyxStatus = async function(campId) {
        _telnyxCampId = campId;
        const box = document.getElementById('telnyxStatusBox');
        if (!box) return;
        try {
            const { data, error } = await window.supabase.rpc('get_camp_telnyx_status', { p_camp_id: campId });
            if (error || !data || !data.success) { box.textContent = 'Using Campistry\'s shared number for now.'; return; }
            if (!data.exists) {
                box.innerHTML = '<p style="margin:0 0 10px;">Using Campistry\'s shared number for now. Get your own dedicated number so parents always see the same recognizable number from your camp.</p>' +
                    '<button type="button" class="btn-primary" onclick="openTelnyxRequestModal()">Get a texting number</button>';
                return;
            }
            if (data.status === 'active') {
                box.innerHTML = '<p style="margin:0;"><strong>' + escTelnyx(data.phone_number || '') + '</strong> — active' +
                    (data.requested_at ? ' since ' + new Date(data.requested_at).toLocaleDateString() : '') + '.</p>';
            } else if (data.status === 'rejected' || data.status === 'failed') {
                box.innerHTML = '<p style="margin:0 0 8px;color:#dc2626;">Number request ' + (data.status === 'rejected' ? 'was rejected' : 'failed') + ': ' + escTelnyx(data.error_message || 'Unknown error') + '</p>' +
                    '<button type="button" class="btn-primary" onclick="openTelnyxRequestModal()">Try again</button>';
            } else {
                box.innerHTML = '<p style="margin:0;">Setting up your number for <strong>' + escTelnyx(data.business_legal_name || '') + '</strong> — this usually takes 3–7 business days for carrier approval. We\'ll update this automatically once it\'s active.</p>';
            }
        } catch (e) {
            box.textContent = 'Using Campistry\'s shared number for now.';
        }
    };

    function escTelnyx(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function(c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

    // ========================================
    // LINK PROGRAMS — per-camp on/off switches for parent-facing Link
    // features (migration 106). Any authenticated user can read them
    // (get_link_program_settings), but only owner/admin can flip one
    // (set_link_program_settings enforces that server-side regardless of
    // what this UI shows) — so a non-owner/admin viewer just sees the
    // current state as disabled checkboxes rather than this card being
    // hidden outright.
    // ========================================
    var LINK_PROGRAMS = [
        { key: 'photos', label: 'Photos', desc: 'Facial-recognition folders + HD downloads' },
        { key: 'canteen', label: 'Canteen', desc: 'Add Funds / prepaid camper wallet' },
        { key: 'shop', label: 'Camp Shop', desc: 'Swag & merch store' },
        { key: 'tips', label: 'Tips', desc: 'Parents tipping staff' },
        { key: 'camperMail', label: 'Camper Mail', desc: 'Parents sending mail to their camper' },
        { key: 'pickup', label: 'Pickup & Arrival', desc: 'Bus/dismissal tracking and requests' }
    ];
    var _linkProgramsCampId = null;

    window.loadLinkProgramSettings = async function(campId) {
        _linkProgramsCampId = campId;
        var box = document.getElementById('linkProgramsBox');
        if (!box) return;
        try {
            var canWrite = (typeof userRole === 'string')
                ? ['owner', 'admin'].indexOf(userRole) !== -1
                : true; // unknown role: let the RPC be the real gate, don't hide the control
            var res = await window.supabase.rpc('get_link_program_settings', { p_camp_id: campId });
            var data = res && res.data;
            if (res.error || !data || !data.success) {
                var reason = (res.error && res.error.message) || (data && data.error) || '';
                box.textContent = 'Could not load Link program settings.' + (reason ? ' (' + reason + ')' : '');
                return;
            }
            box.innerHTML = LINK_PROGRAMS.map(function(p) {
                var on = data[p.key] !== false;
                return '<label style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--slate-100,#f1f5f9);cursor:' + (canWrite ? 'pointer' : 'default') + ';">' +
                    '<span><strong style="font-size:0.86rem;">' + p.label + '</strong><br><span style="font-size:0.76rem;color:var(--slate-400);">' + p.desc + '</span></span>' +
                    '<input type="checkbox" ' + (on ? 'checked' : '') + (canWrite ? '' : ' disabled') + ' style="width:18px;height:18px;flex-shrink:0;" onchange="toggleLinkProgram(\'' + p.key + '\', this.checked, this)">' +
                    '</label>';
            }).join('') + '<div id="linkProgramsStatus" style="font-size:0.78rem;color:var(--slate-400);margin-top:8px;"></div>';
        } catch (e) {
            box.textContent = 'Could not load Link program settings.';
        }
    };

    window.toggleLinkProgram = async function(key, enabled, checkboxEl) {
        var statusEl = document.getElementById('linkProgramsStatus');
        if (checkboxEl) checkboxEl.disabled = true;
        if (statusEl) statusEl.textContent = 'Saving…';
        try {
            var settings = {}; settings[key] = enabled;
            var res = await window.supabase.rpc('set_link_program_settings', { p_camp_id: _linkProgramsCampId, p_settings: settings });
            var data = res && res.data;
            if (res.error || !data || !data.success) {
                if (statusEl) statusEl.textContent = 'Could not save — ' + ((data && data.error) || (res.error && res.error.message) || 'try again.');
                if (checkboxEl) { checkboxEl.checked = !enabled; checkboxEl.disabled = false; }
                return;
            }
            if (statusEl) statusEl.textContent = 'Saved.';
            setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2000);
        } catch (e) {
            if (statusEl) statusEl.textContent = 'Could not save — try again.';
            if (checkboxEl) checkboxEl.checked = !enabled;
        } finally {
            if (checkboxEl) checkboxEl.disabled = false;
        }
    };

    window.openTelnyxRequestModal = function() {
        const overlay = document.getElementById('telnyxRequestOverlay');
        if (!overlay) return;
        document.getElementById('telnyxRequestError').textContent = '';
        document.getElementById('telnyxCardStep').style.display = 'none';
        document.getElementById('telnyxNextBtn').style.display = '';
        document.getElementById('telnyxSubmitBtn').style.display = 'none';
        if (campData && campData.address) document.getElementById('telnyxBizAddress').value = campData.address;
        if (campData && campData.contact_email) document.getElementById('telnyxBizEmail').value = campData.contact_email;
        overlay.style.display = 'flex';
    };

    window.closeTelnyxRequestModal = function() {
        const overlay = document.getElementById('telnyxRequestOverlay');
        if (overlay) overlay.style.display = 'none';
    };

    window.telnyxGoToCardStep = async function() {
        const errEl = document.getElementById('telnyxRequestError');
        errEl.textContent = '';
        const businessName = document.getElementById('telnyxBizName').value.trim();
        const ein = document.getElementById('telnyxEin').value.trim();
        const isNonprofit = document.getElementById('telnyxNonprofit').checked;
        const businessAddress = document.getElementById('telnyxBizAddress').value.trim();
        const businessEmail = document.getElementById('telnyxBizEmail').value.trim();
        const businessPhone = document.getElementById('telnyxBizPhone').value.trim();

        if (!businessName || !ein || !businessAddress || !businessEmail || !businessPhone) {
            errEl.textContent = 'Please fill in every field — Telnyx\'s carrier registration requires all of them.';
            return;
        }

        const nextBtn = document.getElementById('telnyxNextBtn');
        nextBtn.disabled = true; nextBtn.textContent = 'Setting up…';
        try {
            const { data, error } = await window.supabase.functions.invoke('telnyx-number-setup', {
                body: { campId: _telnyxCampId, businessName, businessEmail, businessPhone, businessAddress, ein, isNonprofit },
            });
            if (error) throw new Error(error.message || 'Setup failed');
            if (data && data.error) throw new Error(data.error);

            const pk = await _telnyxStripePk();
            if (!pk) throw new Error('Stripe is not configured for this camp yet — set it up in Billing first.');

            document.getElementById('telnyxNextBtn').style.display = 'none';
            document.getElementById('telnyxCardStep').style.display = '';
            const submitBtn = document.getElementById('telnyxSubmitBtn');
            submitBtn.style.display = '';
            submitBtn.disabled = true;

            const mountCard = function() {
                _telnyxStripe = window.Stripe(pk);
                const elements = _telnyxStripe.elements();
                _telnyxCardEl = elements.create('card', { style: { base: { fontSize: '15px', color: '#1e293b' } } });
                _telnyxCardEl.mount('#telnyx-card-element');
                _telnyxCardEl.on('change', function(ev) {
                    document.getElementById('telnyx-card-errors').textContent = ev.error ? ev.error.message : '';
                    submitBtn.disabled = !ev.complete;
                });
                _telnyxCardEl.__clientSecret = data.clientSecret;
            };
            if (!window.Stripe) {
                const script = document.createElement('script');
                script.src = 'https://js.stripe.com/v3/';
                script.onload = mountCard;
                document.head.appendChild(script);
            } else {
                mountCard();
            }
        } catch (e) {
            errEl.textContent = e.message || 'Could not start setup.';
        } finally {
            nextBtn.disabled = false; nextBtn.textContent = 'Continue to payment';
        }
    };

    window.telnyxSubmitRequest = async function() {
        const errEl = document.getElementById('telnyxRequestError');
        const submitBtn = document.getElementById('telnyxSubmitBtn');
        errEl.textContent = '';
        if (!_telnyxStripe || !_telnyxCardEl) { errEl.textContent = 'Card not ready yet.'; return; }

        submitBtn.disabled = true; submitBtn.textContent = 'Processing…';
        try {
            const result = await _telnyxStripe.confirmCardSetup(_telnyxCardEl.__clientSecret, { payment_method: { card: _telnyxCardEl } });
            if (result.error) throw new Error(result.error.message);

            const { data, error } = await window.supabase.functions.invoke('telnyx-number-request', {
                body: { campId: _telnyxCampId },
            });
            if (error) throw new Error(error.message || 'Request failed');
            if (data && data.error) throw new Error(data.error);

            closeTelnyxRequestModal();
            await loadTelnyxStatus(_telnyxCampId);
        } catch (e) {
            errEl.textContent = e.message || 'Could not submit the request.';
            submitBtn.disabled = false; submitBtn.textContent = 'Request number';
        }
    };

    // ========================================
    // STRIPE CONNECT (per-camp tuition billing)
    // ========================================
    // Where a family's tuition/store payment actually lands. Without this,
    // every camp's tuition pools into Campistry's own shared Stripe account
    // (see migrations/077_camp_stripe_connect.sql). Owner-only — a bank
    // account connection is higher-stakes than ordinary billing actions.

    window.loadCampStripeConnectStatus = async function(campId) {
        const box = document.getElementById('campStripeConnectBox');
        if (!box) return;
        try {
            const { data, error } = await window.supabase.rpc('get_camp_stripe_status', { p_camp_id: campId });
            // Surface the real reason instead of a generic message — a missing
            // RPC (migration 077 never pasted into the SQL Editor), an RLS/
            // membership rejection, and a genuine network error all look
            // identical to a camp owner staring at "Could not load Stripe
            // Connect status." with nothing to act on.
            if (error) {
                console.error('[Dashboard] get_camp_stripe_status RPC error:', error);
                box.innerHTML = '<p style="margin:0;color:#dc2626;">Could not load Stripe Connect status: ' +
                    escTelnyx(error.message || String(error)) + '</p>';
                return;
            }
            if (!data || !data.success) {
                const reason = (data && data.error) || 'unknown error';
                console.error('[Dashboard] get_camp_stripe_status returned failure:', data);
                box.innerHTML = '<p style="margin:0;color:#dc2626;">Could not load Stripe Connect status (' + escTelnyx(reason) + ').</p>';
                return;
            }

            const canConnect = userRole === 'owner';
            const ownerNote = canConnect ? '' : '<p style="margin:6px 0 0;font-size:0.78rem;color:var(--slate-400);">Only the camp owner can connect Stripe.</p>';

            if (!data.connected) {
                box.innerHTML = '<p style="margin:0 0 10px;">Right now tuition payments deposit into Campistry\'s account. Connect your camp\'s own Stripe account so payments go straight to your bank.</p>' +
                    (canConnect ? '<button type="button" class="btn-primary" onclick="startCampStripeConnect(this)">Connect your Stripe account</button>' : '') + ownerNote;
            } else if (data.charges_enabled) {
                box.innerHTML = '<p style="margin:0;color:#059669;"><strong>Connected</strong> — tuition payments go directly to your bank account' +
                    (data.connected_at ? ' since ' + new Date(data.connected_at).toLocaleDateString() : '') + '.</p>';
            } else if (data.onboarding_status === 'pending') {
                box.innerHTML = '<p style="margin:0 0 8px;">Onboarding started but not finished yet.</p>' +
                    (canConnect ? '<button type="button" class="btn-primary" onclick="startCampStripeConnect(this)">Finish setup</button>' : '') + ownerNote;
            } else {
                box.innerHTML = '<p style="margin:0 0 8px;color:#dc2626;">Your Stripe account needs attention before it can accept payments again.</p>' +
                    (canConnect ? '<button type="button" class="btn-primary" onclick="startCampStripeConnect(this)">Review account</button>' : '') + ownerNote;
            }
        } catch (e) {
            console.error('[Dashboard] loadCampStripeConnectStatus threw:', e);
            box.innerHTML = '<p style="margin:0;color:#dc2626;">Could not load Stripe Connect status: ' + escTelnyx(e && e.message ? e.message : String(e)) + '</p>';
        }
    };

    window.syncCampStripeConnectStatus = async function(campId) {
        try {
            await window.supabase.functions.invoke('stripe-connect-status-camp', { body: { campId } });
        } catch (e) {
            // best-effort — the webhook is the durable source of truth either way
        }
        await loadCampStripeConnectStatus(campId);
    };

    window.startCampStripeConnect = async function(btn) {
        if (!campData || !campData.id) return;
        // Disable immediately — a double-click here can otherwise race two
        // onboarding requests into creating two different Stripe accounts
        // for the same camp (the server has its own guard too, but this is
        // the cheap first line of defense).
        var originalLabel = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
        try {
            const { data, error } = await window.supabase.functions.invoke('stripe-connect-onboard-camp', {
                body: { campId: campData.id },
            });
            if (error) throw new Error(error.message || 'Could not start Stripe Connect setup');
            if (data && data.error) throw new Error(data.error);
            if (data && data.url) { window.location.href = data.url; return; }
            // No error, but also no URL — treat as failure rather than
            // silently leaving the button stuck on "Connecting…".
            throw new Error('Could not start Stripe Connect setup — no redirect URL returned.');
        } catch (e) {
            const box = document.getElementById('campStripeConnectBox');
            if (box) box.innerHTML = '<p style="margin:0;color:#dc2626;">' + (e.message || 'Could not start Stripe Connect setup.') + '</p>';
            // btn may already be a detached node here (the innerHTML replace
            // above just removed it from the DOM) — restoring its own label
            // is harmless either way and correct when it's still attached
            // (e.g. the box wasn't replaced for some other reason).
            if (btn) { btn.disabled = false; btn.textContent = originalLabel || 'Connect your Stripe account'; }
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
                // Dates saved before this feature existed (or from any prior
                // session) never got their half-sessions auto-created, since
                // that used to only fire on Save — do it here too, on every
                // load, so it's not just new saves that get it. Owner-only
                // (matches saveCampDates' write gate); _dashSessions must
                // already be loaded — see the call order in
                // setupDashboardForRole().
                if (!readOnly) _dashSyncHalfSessions(campDates.startDate, campDates.half1End, campDates.half2Start, campDates.endDate);
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

    // Closed by default — a full week-by-week list is more detail than most
    // owners need to see every time they open this page; the toggle state
    // is kept in this module var (not re-read from anywhere) so it survives
    // updateWeekPreview() re-rendering on every date field change without
    // snapping shut on the user mid-edit.
    var _weekPreviewOpen = false;

    window._toggleWeekPreview = function() {
        _weekPreviewOpen = !_weekPreviewOpen;
        var body = document.getElementById('weekPreviewBody');
        var chev = document.getElementById('weekPreviewChevron');
        if (body) body.style.display = _weekPreviewOpen ? 'block' : 'none';
        if (chev) chev.textContent = _weekPreviewOpen ? '▾' : '▸';
    };

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
        var weeksHtml = '';
        var transitionShown = false;
        weeks.forEach(function(w) {
            var halfTag = '';
            if (h1End && h2Start) {
                var isFirstHalf = w.end <= h1End;
                var containsH2Start = w.start <= h2Start && w.end >= h2Start;
                if (!transitionShown && containsH2Start) {
                    weeksHtml += '<span style="color:#d97706; font-weight:600;">Transition: ' + fmt(h1End) + ' – ' + fmt(h2Start) + '</span><br>';
                    transitionShown = true;
                }
                if (isFirstHalf) halfTag = ' <span style="color:#7C3AED; font-weight:600;">(1st half)</span>';
                else halfTag = ' <span style="color:#2563EB; font-weight:600;">(2nd half)</span>';
            }
            weeksHtml += 'Week ' + w.week + ': ' + fmt(w.start) + ' – ' + fmt(w.end) + halfTag + '<br>';
        });

        preview.innerHTML =
            '<div style="cursor:pointer; user-select:none;" onclick="window._toggleWeekPreview()">' +
                '<span id="weekPreviewChevron">' + (_weekPreviewOpen ? '▾' : '▸') + '</span> ' +
                '<strong style="color:var(--slate-700);">Week breakdown (' + weeks.length + ' weeks)</strong>' +
            '</div>' +
            '<div id="weekPreviewBody" style="display:' + (_weekPreviewOpen ? 'block' : 'none') + '; margin-top:6px;">' + weeksHtml + '</div>';
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
            _dashSyncHalfSessions(startDate, h1End, h2Start, endDate);
        } catch (e) {
            console.error('Error saving camp dates:', e);
            if (status) { status.textContent = 'Error saving.'; status.style.color = '#dc2626'; }
        }
    };

    // Attendance History — snapshots the CURRENT roster/hired staff into
    // camp_person_seasons (migration 088) under a season label, so it
    // survives a CSV re-import wipe or next year's reset. archive_camp_season
    // reads camp_state_kv server-side (not a client payload) — this works the
    // same whether called from here or from campistry_me.js's own automatic
    // archive-before-import prompt, since neither page needs the full roster
    // loaded into memory to trigger it.
    window.archiveCurrentSeasonNow = async function() {
        var input = document.getElementById('seasonArchiveLabel');
        var status = document.getElementById('seasonArchiveStatus');
        var label = (input && input.value || '').trim();
        if (!label) {
            var startEl = document.getElementById('campStartDate');
            var y = (startEl && startEl.value) ? new Date(startEl.value).getFullYear() : new Date().getFullYear();
            label = 'Summer ' + y;
            if (input) input.value = label;
        }
        var btn = document.getElementById('archiveSeasonBtn');
        if (btn) btn.disabled = true;
        if (status) { status.textContent = 'Archiving…'; status.style.color = 'var(--slate-400)'; }
        try {
            var campId = localStorage.getItem('campistry_camp_id') || localStorage.getItem('campistry_user_id') || currentUser.id;
            var { data, error } = await window.supabase.rpc('archive_camp_season', { p_camp_id: campId, p_season_label: label });
            if (error || !data || !data.success) throw (error || new Error((data && data.error) || 'unknown'));
            if (status) { status.textContent = 'Archived ' + (data.saved || 0) + ' — "' + label + '" saved.'; status.style.color = '#059669'; setTimeout(function() { status.textContent = ''; }, 5000); }
        } catch (e) {
            console.error('Error archiving season:', e);
            if (status) { status.textContent = 'Error archiving — try again.'; status.style.color = '#dc2626'; }
        } finally {
            if (btn) btn.disabled = false;
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

    // ========================================
    // CAMP SETTINGS (migrated from Campistry Me: Language & Regional,
    // Stripe, Data Management. Camp Name itself stays on the Camp Profile
    // card above — saveProfile() already writes it everywhere that reads it.)
    // ========================================

    function loadCampSettingsSection() {
        try {
            var gs = (typeof window.loadGlobalSettings === 'function') ? (window.loadGlobalSettings() || {}) : {};
            var cm = gs.campistryMe || {};
            var cs = cm.campSettings || {};
            var localeEl = document.getElementById('settLocale');
            if (localeEl) localeEl.value = cm.locale || 'en-US';
            var hebrewEl = document.getElementById('settHebrewDates');
            if (hebrewEl) hebrewEl.checked = !!cs.showHebrewDates;
            var altEl = document.getElementById('settAltNames');
            if (altEl) altEl.checked = cs.showAltNames !== false;
            var rtlEl = document.getElementById('settRTL');
            if (rtlEl) rtlEl.checked = !!cs.rtl;
        } catch (e) {
            console.warn('Could not load camp settings:', e);
        }
    }

    window.saveLocaleSettings = function() {
        var status = document.getElementById('localeSettingsStatus');
        if (isTeamMember) {
            if (status) { status.textContent = 'Only camp owners can edit camp settings.'; status.style.color = '#dc2626'; }
            return;
        }
        try {
            var gs = window.loadGlobalSettings ? (window.loadGlobalSettings() || {}) : {};
            if (!gs.campistryMe) gs.campistryMe = {};
            gs.campistryMe.locale = document.getElementById('settLocale').value || 'en-US';
            gs.campistryMe.campSettings = {
                showHebrewDates: document.getElementById('settHebrewDates').checked,
                showAltNames: document.getElementById('settAltNames').checked,
                rtl: document.getElementById('settRTL').checked
            };
            if (window.saveGlobalSettings) window.saveGlobalSettings('campistryMe', gs.campistryMe);
            if (status) { status.textContent = 'Saved!'; status.style.color = '#059669'; setTimeout(function() { status.textContent = ''; }, 3000); }
        } catch (e) {
            console.error('Error saving language settings:', e);
            if (status) { status.textContent = 'Error saving.'; status.style.color = '#dc2626'; }
        }
    };

    // ========================================
    // SESSIONS & PRICING (migrated from Campistry Me's Camp Structure page.
    // Registration/Manual Entry/waitlist logic in Me and campistry_register.html
    // keep reading campistryMe.sessions directly — only the editor UI moved.)
    // ========================================

    var _dashSessions = [];
    var _dashEditingSessionIdx = null;
    var _dashBundles = [];
    var _dashEditingBundleIdx = null;
    // Enrolled-count source for the live "X / capacity" shown on each session
    // card below — same campistryMe.enrollments object campistry_me.js reads
    // (window.loadGlobalSettings() returns the identical settings blob), so
    // this needs no separate fetch: it's already hydrated by the time this
    // page loads.
    var _dashEnrollments = {};

    function _dashGenId() {
        return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function _dashSaveSessions() {
        var gs = window.loadGlobalSettings ? (window.loadGlobalSettings() || {}) : {};
        if (!gs.campistryMe) gs.campistryMe = {};
        gs.campistryMe.sessions = _dashSessions;
        if (window.saveGlobalSettings) window.saveGlobalSettings('campistryMe', gs.campistryMe);
    }

    function _dashSaveBundles() {
        var gs = window.loadGlobalSettings ? (window.loadGlobalSettings() || {}) : {};
        if (!gs.campistryMe) gs.campistryMe = {};
        gs.campistryMe.sessionBundles = _dashBundles;
        if (window.saveGlobalSettings) window.saveGlobalSettings('campistryMe', gs.campistryMe);
    }

    function _dashFormatDateRange(startDate, endDate) {
        if (!startDate || !endDate) return '';
        return new Date(startDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
            + ' – ' + new Date(endDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    function loadSessionsSection() {
        try {
            var gs = (typeof window.loadGlobalSettings === 'function') ? (window.loadGlobalSettings() || {}) : {};
            _dashSessions = (gs.campistryMe && gs.campistryMe.sessions) || [];
            _dashBundles = (gs.campistryMe && gs.campistryMe.sessionBundles) || [];
            _dashEnrollments = (gs.campistryMe && gs.campistryMe.enrollments) || {};
            // Backfill stable ids on sessions saved before bundles existed —
            // bundles reference a session by id (array position isn't safe,
            // it shifts on delete/reorder).
            var idsAdded = false;
            _dashSessions.forEach(function(s) { if (!s.id) { s.id = _dashGenId(); idsAdded = true; } });
            if (idsAdded) _dashSaveSessions();
            renderSessionsList();
            renderBundlesList();
            var form = document.getElementById('sessionEditForm');
            if (form) form.style.display = 'none';
            var bform = document.getElementById('bundleEditForm');
            if (bform) bform.style.display = 'none';
        } catch (e) {
            console.warn('Could not load sessions:', e);
        }
    }

    // Keeps a "1st Half" and "2nd Half" session in sync with the Camp Dates
    // halves — created the first time both boundary dates for that half are
    // set, and just date-refreshed (name/price/everything else the owner
    // may have customized left untouched) on every later save. Identified
    // by autoKey rather than name, so renaming one doesn't create a
    // duplicate or lose the sync.
    function _dashSyncHalfSessions(startDate, h1End, h2Start, endDate) {
        var halves = [
            { key: 'half1', label: '1st Half', start: startDate, end: h1End },
            { key: 'half2', label: '2nd Half', start: h2Start, end: endDate }
        ];
        var changed = false;
        halves.forEach(function(h) {
            if (!h.start || !h.end) return;
            // Match by autoKey first, but ALSO fall back to matching by name —
            // a session manually named "1st Half"/"2nd Half" (typed in before
            // Camp Dates halves were ever set, so it has no autoKey) would
            // otherwise never be found here, and this would push a SECOND,
            // zero-priced "1st Half" session alongside the real one. Any
            // reader that does sessions.find(s => s.name === X) then risks
            // resolving to whichever duplicate happens to come first —
            // silently pricing an enrollment at $0 even though the real
            // session has a real price.
            var existing = _dashSessions.find(function(s) { return s.autoKey === h.key; })
                || _dashSessions.find(function(s) { return !s.autoKey && (s.name||'').trim().toLowerCase() === h.label.toLowerCase(); });
            var dates = _dashFormatDateRange(h.start, h.end);
            if (existing) {
                if (!existing.autoKey) { existing.autoKey = h.key; changed = true; } // link the manual entry so it's never duplicated again
                if (existing.startDate !== h.start || existing.endDate !== h.end) {
                    existing.startDate = h.start;
                    existing.endDate = h.end;
                    existing.dates = dates;
                    changed = true;
                }
            } else {
                _dashSessions.push({
                    id: _dashGenId(),
                    autoKey: h.key,
                    name: h.label,
                    startDate: h.start,
                    endDate: h.end,
                    dates: dates,
                    capacity: 0,
                    tuition: 0,
                    earlyBird: 0,
                    earlyBirdDeadline: '',
                    siblingDiscount: 0,
                    paymentPlan: 'full',
                    depositAmount: 0,
                    notes: '',
                    registrationOpen: true
                });
                changed = true;
            }
        });
        if (changed) {
            _dashSaveSessions();
            renderSessionsList();
            renderBundlesList();
        }
    }

    // Sessions and bundles render as ONE list — a bundle is just another
    // thing a parent can pick at registration, not a separate feature area.
    // Sessions first (in their existing order), bundles after, each tagged
    // clearly by a badge so the distinction is still visible in the row.
    function renderSessionsList() {
        var list = document.getElementById('sessionsList');
        if (!list) return;
        if (!_dashSessions.length && !_dashBundles.length) {
            list.innerHTML = '<p style="color:var(--slate-400); font-size:0.85rem; text-align:center; padding:10px;">No sessions yet — set your camp dates above to auto-create 1st/2nd Half sessions, or add one to open registration.</p>';
            return;
        }
        // Live enrolled count per session name — same filter enrollCamper()/
        // the office "Add Application" capacity check already use elsewhere
        // (status enrolled or accepted counts toward the session), just
        // finally surfaced here so accepting someone actually moves a number
        // on this page instead of only affecting an internal count nothing
        // displays.
        var enrolledBySession = {};
        Object.values(_dashEnrollments).forEach(function(e) {
            if (e && (e.status === 'enrolled' || e.status === 'accepted') && e.session) {
                enrolledBySession[e.session] = (enrolledBySession[e.session] || 0) + 1;
            }
        });
        var sessionsHtml = _dashSessions.map(function(s, i) {
            var isOpen = s.registrationOpen !== false;
            var html = '<div style="padding:12px 14px; border-radius:8px; border:1px solid ' + (isOpen ? 'var(--slate-200)' : '#fecaca') + '; background:' + (isOpen ? 'var(--slate-50)' : 'rgba(239,68,68,.04)') + ';">';
            html += '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">';
            html += '<span style="font-size:0.9rem; font-weight:700; color:var(--slate-800);">' + _dashEsc(s.name) + (s.autoKey ? ' <span style="font-size:0.68rem; font-weight:600; color:var(--slate-400);">(synced to Camp Dates)</span>' : '') + '</span>';
            html += '<div style="display:flex; gap:6px; flex-shrink:0;">';
            html += '<button type="button" class="btn-secondary" style="padding:3px 10px; font-size:0.72rem;" onclick="editSessionForm(' + i + ')">Edit</button>';
            html += '<button type="button" class="btn-secondary" style="padding:3px 10px; font-size:0.72rem;' + (isOpen ? '' : ' color:#059669;') + '" onclick="toggleSessionRegistration(' + i + ')">' + (isOpen ? 'Close' : 'Open') + '</button>';
            html += '<button type="button" class="btn-secondary" style="padding:3px 10px; font-size:0.72rem; color:#dc2626;" onclick="deleteSessionEntry(' + i + ')">Delete</button>';
            html += '</div></div>';
            if (s.dates) html += '<div style="font-size:0.75rem; color:var(--slate-500); margin-top:4px;">📅 ' + _dashEsc(s.dates) + '</div>';
            html += '<div style="display:flex; align-items:center; gap:8px; margin-top:6px;">';
            html += '<label style="font-size:0.78rem; color:var(--slate-500);">Price: $</label>';
            html += '<input type="number" step="0.01" min="0" value="' + (s.tuition || '') + '" placeholder="0.00" style="width:100px; padding:4px 8px; border-radius:6px; border:1px solid var(--slate-200); font-size:0.82rem;" onchange="updateSessionPriceInline(' + i + ', this.value, this)">';
            var enrolledCount = enrolledBySession[s.name] || 0;
            if (s.capacity) {
                var overCap = enrolledCount > s.capacity;
                html += '<span style="font-size:0.75rem; font-weight:600; color:' + (overCap ? '#dc2626' : 'var(--slate-500)') + ';">· ' + enrolledCount + ' / ' + s.capacity + ' enrolled' + (overCap ? ' (over capacity)' : '') + '</span>';
            } else if (enrolledCount > 0) {
                html += '<span style="font-size:0.75rem; color:var(--slate-400);">· ' + enrolledCount + ' enrolled</span>';
            }
            html += '</div>';
            html += '<div style="margin-top:6px; font-size:0.7rem; font-weight:700; color:' + (isOpen ? '#059669' : '#dc2626') + ';">' + (isOpen ? 'Registration Open' : 'Registration Closed') + '</div>';
            html += '</div>';
            return html;
        }).join('');

        var sessionsById = {};
        _dashSessions.forEach(function(s) { sessionsById[s.id] = s; });
        var bundlesHtml = _dashBundles.map(function(b, i) {
            var names = (b.sessionIds || []).map(function(id) { return sessionsById[id] ? sessionsById[id].name : '(deleted session)'; });
            var html = '<div style="padding:12px 14px; border-radius:8px; border:1px solid #ddd6fe; background:#f5f3ff;">';
            html += '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">';
            html += '<span style="font-size:0.9rem; font-weight:700; color:var(--slate-800);">' + _dashEsc(b.name) + ' <span style="font-size:0.68rem; font-weight:700; color:#7c3aed; background:#ede9fe; padding:1px 6px; border-radius:4px;">BUNDLE</span></span>';
            html += '<div style="display:flex; gap:6px; flex-shrink:0;">';
            html += '<button type="button" class="btn-secondary" style="padding:3px 10px; font-size:0.72rem;" onclick="editBundleForm(' + i + ')">Edit</button>';
            html += '<button type="button" class="btn-secondary" style="padding:3px 10px; font-size:0.72rem; color:#dc2626;" onclick="deleteBundleEntry(' + i + ')">Delete</button>';
            html += '</div></div>';
            html += '<div style="font-size:0.75rem; color:var(--slate-500); margin-top:4px;">📦 ' + names.map(_dashEsc).join(' + ') + '</div>';
            html += '<div style="font-size:0.82rem; font-weight:700; color:var(--slate-700); margin-top:6px;">$' + Number(b.price || 0).toLocaleString() + '</div>';
            html += '</div>';
            return html;
        }).join('');

        list.innerHTML = sessionsHtml + bundlesHtml;
    }
    // Kept as an alias — several call sites re-render after a bundle
    // add/edit/delete without also wanting to rebuild the sessions half of
    // the list; since both live in one function/list now, it's just that.
    function renderBundlesList() { renderSessionsList(); }

    window.updateSessionPriceInline = function(idx, value, inputEl) {
        if (isTeamMember) return;
        var s = _dashSessions[idx];
        if (!s) return;
        s.tuition = parseFloat(value) || 0;
        _dashSaveSessions();
        // This field has no confirmation banner like the full Edit Session
        // form does, which invited a "type it, then immediately reload to
        // check" test pattern that can race the normal debounced cloud
        // sync — force that sync to run right now instead of waiting, and
        // show a quick inline confirmation so it's not a silent no-op
        // either way.
        if (window.flushPendingSettingsSync) window.flushPendingSettingsSync();
        var el = inputEl || (typeof event !== 'undefined' ? event.target : null);
        var wrap = el && el.parentElement;
        if (wrap) {
            var mark = wrap.querySelector('.ses-price-saved');
            if (!mark) {
                mark = document.createElement('span');
                mark.className = 'ses-price-saved';
                mark.style.cssText = 'font-size:0.72rem;color:#059669;font-weight:600;';
                wrap.appendChild(mark);
            }
            mark.textContent = '✓ Saved';
            clearTimeout(mark._hideTimer);
            mark._hideTimer = setTimeout(function() { mark.textContent = ''; }, 2000);
        }
    };

    function _dashFillSessionForm(s) {
        document.getElementById('sesName').value = s.name || '';
        document.getElementById('sesDatePreset').value = '';
        document.getElementById('sesDatePresetHint').textContent = '';
        document.getElementById('sesStart').value = s.startDate || '';
        document.getElementById('sesEnd').value = s.endDate || '';
        document.getElementById('sesDates').value = s.dates || '';
        document.getElementById('sesCap').value = s.capacity || '';
        document.getElementById('sesTuition').value = s.tuition || '';
        document.getElementById('sesEarly').value = s.earlyBird || '';
        document.getElementById('sesEarlyDate').value = s.earlyBirdDeadline || '';
        document.getElementById('sesSibDisc').value = s.siblingDiscount || '';
        document.getElementById('sesPayPlan').value = s.paymentPlan || 'full';
        document.getElementById('sesDeposit').value = s.depositAmount || '';
        document.getElementById('sesDepositWrap').style.display = (s.paymentPlan === 'deposit') ? 'block' : 'none';
        document.getElementById('sesNotes').value = s.notes || '';
    }

    window.addSessionForm = function() {
        if (isTeamMember) {
            var status0 = document.getElementById('sessionFormStatus');
            if (status0) { status0.textContent = 'Only camp owners can manage sessions.'; status0.style.color = '#dc2626'; }
            return;
        }
        window.cancelBundleForm();
        _dashEditingSessionIdx = null;
        _dashFillSessionForm({});
        var title = document.getElementById('sessionFormTitle');
        if (title) title.textContent = 'Add Session';
        var form = document.getElementById('sessionEditForm');
        if (form) form.style.display = 'block';
        var status = document.getElementById('sessionFormStatus');
        if (status) status.textContent = '';
    };

    window.editSessionForm = function(idx) {
        window.cancelBundleForm();
        _dashEditingSessionIdx = idx;
        _dashFillSessionForm(_dashSessions[idx] || {});
        var title = document.getElementById('sessionFormTitle');
        if (title) title.textContent = 'Edit Session';
        var form = document.getElementById('sessionEditForm');
        if (form) form.style.display = 'block';
        var status = document.getElementById('sessionFormStatus');
        if (status) status.textContent = '';
    };

    window.cancelSessionForm = function() {
        var form = document.getElementById('sessionEditForm');
        if (form) form.style.display = 'none';
        _dashEditingSessionIdx = null;
    };

    // Quick-fill Start/End from the Camp Dates section above — Full Summer /
    // 1st Half / 2nd Half — instead of retyping the same boundaries per session.
    window.applySessionDatePreset = function() {
        var preset = document.getElementById('sesDatePreset').value;
        var hint = document.getElementById('sesDatePresetHint');
        if (!preset) { if (hint) hint.textContent = ''; return; }
        var start = document.getElementById('campStartDate')?.value || '';
        var half1End = document.getElementById('campHalf1End')?.value || '';
        var half2Start = document.getElementById('campHalf2Start')?.value || '';
        var end = document.getElementById('campEndDate')?.value || '';
        var range = { full: [start, end], half1: [start, half1End], half2: [half2Start, end] }[preset];
        if (!range || !range[0] || !range[1]) {
            if (hint) hint.textContent = 'Set Camp Dates above first — that boundary isn\'t filled in yet.';
            return;
        }
        document.getElementById('sesStart').value = range[0];
        document.getElementById('sesEnd').value = range[1];
        if (hint) hint.textContent = 'Filled from Camp Dates — you can still adjust below.';
    };

    window.saveSessionForm = function() {
        var status = document.getElementById('sessionFormStatus');
        if (isTeamMember) {
            if (status) { status.textContent = 'Only camp owners can manage sessions.'; status.style.color = '#dc2626'; }
            return;
        }
        var name = (document.getElementById('sesName').value || '').trim();
        if (!name) {
            if (status) { status.textContent = 'Enter a session name.'; status.style.color = '#dc2626'; }
            return;
        }
        var idx = _dashEditingSessionIdx;
        var existing = (idx != null && _dashSessions[idx]) ? _dashSessions[idx] : null;
        var obj = {
            id: existing ? existing.id : _dashGenId(),
            autoKey: existing ? existing.autoKey : undefined,
            name: name,
            startDate: document.getElementById('sesStart').value || '',
            endDate: document.getElementById('sesEnd').value || '',
            dates: (document.getElementById('sesDates').value || '').trim(),
            capacity: parseInt(document.getElementById('sesCap').value) || 0,
            tuition: parseFloat(document.getElementById('sesTuition').value) || 0,
            earlyBird: parseFloat(document.getElementById('sesEarly').value) || 0,
            earlyBirdDeadline: document.getElementById('sesEarlyDate').value || '',
            siblingDiscount: parseInt(document.getElementById('sesSibDisc').value) || 0,
            paymentPlan: document.getElementById('sesPayPlan').value || 'full',
            depositAmount: parseFloat(document.getElementById('sesDeposit').value) || 0,
            notes: (document.getElementById('sesNotes').value || '').trim(),
            registrationOpen: existing ? (existing.registrationOpen !== false) : true
        };
        if (!obj.dates && obj.startDate && obj.endDate) {
            obj.dates = _dashFormatDateRange(obj.startDate, obj.endDate);
        }
        try {
            if (existing) _dashSessions[idx] = obj;
            else _dashSessions.push(obj);
            _dashSaveSessions();
            renderSessionsList();
            window.cancelSessionForm();
            if (status) { status.textContent = (existing ? 'Session updated.' : 'Session created.'); status.style.color = '#059669'; setTimeout(function() { status.textContent = ''; }, 3000); }
        } catch (e) {
            console.error('Error saving session:', e);
            if (status) { status.textContent = 'Error saving.'; status.style.color = '#dc2626'; }
        }
    };

    window.toggleSessionRegistration = function(idx) {
        if (isTeamMember) return;
        var s = _dashSessions[idx];
        if (!s) return;
        s.registrationOpen = s.registrationOpen === false;
        try {
            _dashSaveSessions();
            renderSessionsList();
        } catch (e) {
            console.error('Error toggling session registration:', e);
        }
    };

    window.deleteSessionEntry = function(idx) {
        if (isTeamMember) return;
        var s = _dashSessions[idx];
        if (!s) return;
        var inBundles = _dashBundles.filter(function(b) { return (b.sessionIds || []).indexOf(s.id) >= 0; });
        var warn = inBundles.length ? (' It\'s used in ' + inBundles.length + ' bundle' + (inBundles.length === 1 ? '' : 's') + ' (' + inBundles.map(function(b) { return b.name; }).join(', ') + ') — deleting it will remove it from ' + (inBundles.length === 1 ? 'that bundle' : 'those bundles') + ' too, and any bundle left with fewer than 2 sessions will be deleted.') : '';
        if (!confirm('Delete session "' + s.name + '"?' + warn)) return;
        try {
            _dashSessions.splice(idx, 1);
            _dashSaveSessions();
            if (inBundles.length) {
                _dashBundles.forEach(function(b) {
                    b.sessionIds = (b.sessionIds || []).filter(function(id) { return id !== s.id; });
                });
                _dashBundles = _dashBundles.filter(function(b) { return (b.sessionIds || []).length >= 2; });
                _dashSaveBundles();
                renderBundlesList();
            }
            renderSessionsList();
        } catch (e) {
            console.error('Error deleting session:', e);
        }
    };

    // ========================================
    // BUNDLES — a combined price for 2+ sessions together (e.g. both
    // halves at $2,000 each individually, but a "Full Summer" bundle of
    // both at $3,500). References sessions by id, not array index, since
    // indices shift on delete/reorder.
    // ========================================

    function _dashRenderBundleSessionChecks(selectedIds) {
        var wrap = document.getElementById('bunSessionChecks');
        if (!wrap) return;
        if (!_dashSessions.length) {
            wrap.innerHTML = '<span style="font-size:0.8rem; color:var(--slate-400);">Add sessions above first.</span>';
            return;
        }
        wrap.innerHTML = _dashSessions.map(function(s) {
            var checked = selectedIds.indexOf(s.id) >= 0 ? ' checked' : '';
            return '<label style="display:flex; align-items:center; gap:6px; font-size:0.85rem; color:var(--slate-700);">'
                + '<input type="checkbox" value="' + _dashEsc(s.id) + '" class="bunSessionCheck"' + checked + '> ' + _dashEsc(s.name)
                + '</label>';
        }).join('');
    }

    window.addBundleForm = function() {
        if (isTeamMember) return;
        if (_dashSessions.length < 2) {
            var status0 = document.getElementById('bundleFormStatus');
            if (status0) { status0.textContent = 'Add at least 2 sessions first — a bundle combines two or more.'; status0.style.color = '#dc2626'; }
            return;
        }
        window.cancelSessionForm();
        _dashEditingBundleIdx = null;
        document.getElementById('bunName').value = '';
        document.getElementById('bunPrice').value = '';
        _dashRenderBundleSessionChecks([]);
        var title = document.getElementById('bundleFormTitle');
        if (title) title.textContent = '📦 Add Bundle';
        var form = document.getElementById('bundleEditForm');
        if (form) form.style.display = 'block';
        var status = document.getElementById('bundleFormStatus');
        if (status) status.textContent = '';
    };

    window.editBundleForm = function(idx) {
        var b = _dashBundles[idx];
        if (!b) return;
        window.cancelSessionForm();
        _dashEditingBundleIdx = idx;
        document.getElementById('bunName').value = b.name || '';
        document.getElementById('bunPrice').value = b.price || '';
        _dashRenderBundleSessionChecks(b.sessionIds || []);
        var title = document.getElementById('bundleFormTitle');
        if (title) title.textContent = '📦 Edit Bundle';
        var form = document.getElementById('bundleEditForm');
        if (form) form.style.display = 'block';
        var status = document.getElementById('bundleFormStatus');
        if (status) status.textContent = '';
    };

    window.cancelBundleForm = function() {
        var form = document.getElementById('bundleEditForm');
        if (form) form.style.display = 'none';
        _dashEditingBundleIdx = null;
    };

    window.saveBundleForm = function() {
        var status = document.getElementById('bundleFormStatus');
        if (isTeamMember) {
            if (status) { status.textContent = 'Only camp owners can manage bundles.'; status.style.color = '#dc2626'; }
            return;
        }
        var name = (document.getElementById('bunName').value || '').trim();
        if (!name) {
            if (status) { status.textContent = 'Enter a bundle name.'; status.style.color = '#dc2626'; }
            return;
        }
        var sessionIds = Array.prototype.map.call(document.querySelectorAll('.bunSessionCheck:checked'), function(el) { return el.value; });
        if (sessionIds.length < 2) {
            if (status) { status.textContent = 'Select at least 2 sessions.'; status.style.color = '#dc2626'; }
            return;
        }
        var idx = _dashEditingBundleIdx;
        var obj = {
            id: (idx != null && _dashBundles[idx]) ? _dashBundles[idx].id : _dashGenId(),
            name: name,
            sessionIds: sessionIds,
            price: parseFloat(document.getElementById('bunPrice').value) || 0
        };
        try {
            if (idx != null && _dashBundles[idx]) _dashBundles[idx] = obj;
            else _dashBundles.push(obj);
            _dashSaveBundles();
            renderBundlesList();
            window.cancelBundleForm();
            if (status) { status.textContent = (idx != null ? 'Bundle updated.' : 'Bundle created.'); status.style.color = '#059669'; setTimeout(function() { status.textContent = ''; }, 3000); }
        } catch (e) {
            console.error('Error saving bundle:', e);
            if (status) { status.textContent = 'Error saving.'; status.style.color = '#dc2626'; }
        }
    };

    window.deleteBundleEntry = function(idx) {
        if (isTeamMember) return;
        var b = _dashBundles[idx];
        if (!b) return;
        if (!confirm('Delete bundle "' + b.name + '"?')) return;
        try {
            _dashBundles.splice(idx, 1);
            _dashSaveBundles();
            renderBundlesList();
        } catch (e) {
            console.error('Error deleting bundle:', e);
        }
    };

    // ========================================
    // LIVE NOTIFICATIONS (Link messages, Notes reminders, schedule changes)
    // Reads from the `notifications` table (see migrations/056_notifications.sql
    // + NOTIFICATIONS_SETUP.md) and renders into #dashNotifLiveList. This is
    // now the entire panel's content — the old static/hardcoded onboarding
    // tips (buildNotifications() in dashboard.html) were removed since they
    // never reflected anything real and couldn't be dismissed.
    //
    // Three writers feed the shared `notifications` table with two different
    // shapes: the source-based one (056) for link_message/notes_reminder —
    // camp-wide, source_id-addressable, read state via notification_reads —
    // and the legacy hand-created one (pre-056, still used by
    // post_edit_system.js's schedule-conflict notices) — per-user via
    // user_id/type/read, source is NULL on those rows. send-broadcast also
    // writes rows with source='broadcast_fallback', but purely as an
    // idempotency ledger (has it already sent this recipient this event) —
    // those were never meant to be shown to anyone and are filtered out here.
    //
    // Preferences (ignore/notify/important per category) are per-BROWSER —
    // stored in localStorage, same convention as this app's other
    // client-only dismissed-suggestion state (e.g.
    // campistry_dismissed_fam_suggestions) — not synced across devices.
    // ========================================

    var _notifChannel = null;
    var _notifPollTimer = null;
    var _notifVisibleRows = []; // [{id, isLegacy}] currently rendered — what "Clear all" acts on
    var _notifIcons = {
        link_message: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        notes_reminder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        schedule_conflict: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 17h.01"/></svg>'
    };
    var _notifColors = { link_message: 'var(--link-color, #2A7A35)', notes_reminder: 'var(--notes-color, #C4891A)', schedule_conflict: '#D97706' };
    var NOTIF_CATEGORY_META = {
        link_message:      { label: 'Parent Messages',  desc: 'A parent sends you a message from Campistry Link.' },
        notes_reminder:    { label: 'Notes Reminders',  desc: 'A reminder you set in Campistry Notes comes due.' },
        schedule_conflict: { label: 'Schedule Changes',  desc: 'Another scheduler edits or overrides a slot you’re also scheduling.' }
    };
    var NOTIF_PREFS_KEY = 'campistry_notif_prefs_v1';
    var NOTIF_PREFS_DEFAULT = { link_message: 'notify', notes_reminder: 'notify', schedule_conflict: 'notify' };

    function _notifPrefs() {
        try { return Object.assign({}, NOTIF_PREFS_DEFAULT, JSON.parse(localStorage.getItem(NOTIF_PREFS_KEY) || '{}')); }
        catch (e) { return Object.assign({}, NOTIF_PREFS_DEFAULT); }
    }
    function _notifSavePrefs(p) {
        try { localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(p)); } catch (e) {}
    }

    function _notifCampId() {
        return localStorage.getItem('campistry_camp_id') || localStorage.getItem('campistry_user_id') || (currentUser && currentUser.id);
    }

    function _notifRelTime(iso) {
        var then = new Date(iso).getTime();
        if (isNaN(then)) return '';
        var diffMin = Math.round((Date.now() - then) / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return diffMin + 'm ago';
        var diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return diffHr + 'h ago';
        return Math.round(diffHr / 24) + 'd ago';
    }

    // Which category a row belongs to — source-based rows map 1:1 on
    // `source`; legacy (source IS NULL) rows map off their `type` column.
    function _notifCategoryOf(n) {
        if (n.source === 'link_message') return 'link_message';
        if (n.source === 'notes_reminder') return 'notes_reminder';
        if (n.source == null && (n.type === 'schedule_conflict' || n.type === 'schedule_bypassed')) return 'schedule_conflict';
        return n.source || null;
    }

    async function loadLiveNotifications() {
        var wrap = document.getElementById('dashNotifLiveList');
        if (!wrap || !window.supabase) return;
        var campId = _notifCampId();
        if (!campId) return;
        try {
            var [notifRes, readsRes] = await Promise.all([
                window.supabase.from('notifications')
                    .select('id, source, source_id, title, body, message, link_target, created_at, type, user_id, metadata, read')
                    .eq('camp_id', campId).order('created_at', { ascending: false }).limit(40),
                currentUser ? window.supabase.from('notification_reads').select('notification_id').eq('user_id', currentUser.id) : Promise.resolve({ data: [] })
            ]);
            if (notifRes.error) { console.warn('[Dashboard] loadLiveNotifications:', notifRes.error.message); return; }
            var readIds = new Set((readsRes.data || []).map(function(r) { return r.notification_id; }));
            var myUid = currentUser && currentUser.id;
            // broadcast_fallback rows are send-broadcast's own idempotency
            // ledger, never meant to be shown. Legacy (source IS NULL) rows
            // are addressed per-user via user_id — 056's SELECT policy widened
            // read access to the whole camp, so without this filter every
            // staff member would see every OTHER scheduler's historical
            // conflict notices too.
            var rows = (notifRes.data || []).filter(function(n) {
                if (n.source === 'broadcast_fallback') return false;
                if (n.source == null) return n.user_id === myUid;
                return true;
            });
            renderLiveNotifications(rows, readIds);
        } catch (e) {
            console.warn('[Dashboard] loadLiveNotifications failed:', e);
        }
    }

    function _notifBuildLinkTarget(n, category) {
        if (n.link_target) return n.link_target;
        return null;
    }

    function _notifBodyText(n, category) {
        if (category === 'schedule_conflict' && n.metadata && n.metadata.dateKey) {
            return (n.message || n.body || '') || ('Check the schedule for ' + n.metadata.dateKey + ' in Flow.');
        }
        return n.body || n.message || '';
    }

    function _updateNotifBadge(count) {
        var badge = document.getElementById('dashNotifBadge');
        if (!badge) return;
        if (count > 0) { badge.style.display = ''; badge.textContent = count > 99 ? '99+' : String(count); }
        else { badge.style.display = 'none'; }
    }

    function renderLiveNotifications(notifs, readIds) {
        var wrap = document.getElementById('dashNotifLiveList');
        if (!wrap) return;
        var prefs = _notifPrefs();

        // A dismissed/read row is filtered out here, not just destyled — the
        // earlier version only used "unread" for the dot/bold treatment and
        // still rendered every row regardless, so dismissing marked it read
        // and then the very next reload rendered it right back (nothing
        // dismissed ever actually left the list).
        var visible = [];
        notifs.forEach(function(n) {
            var category = _notifCategoryOf(n);
            var pref = category ? (prefs[category] || 'notify') : 'notify';
            if (pref === 'ignore') return;
            var unread = n.source == null ? (n.read !== true) : !readIds.has(n.id);
            if (!unread) return;
            visible.push({ n: n, category: category, important: pref === 'important' });
        });
        // Important first, then chronological (rows already arrive newest-first).
        visible.sort(function(a, b) { return (b.important - a.important); });

        _updateNotifBadge(visible.length);
        _notifVisibleRows = visible.map(function(v) { return { id: v.n.id, isLegacy: v.n.source == null }; });
        var clearBtn = document.getElementById('dashNotifClearAllBtn');
        if (clearBtn) clearBtn.style.display = visible.length ? '' : 'none';

        if (!visible.length) {
            wrap.style.display = 'block';
            wrap.innerHTML = '<p style="color:var(--slate-400);font-size:0.85rem;text-align:center;padding:14px 0;">You’re all caught up — no notifications right now.</p>';
            return;
        }
        wrap.style.display = 'block';
        wrap.innerHTML = visible.map(function(v) {
            var n = v.n, category = v.category;
            var icon = _notifIcons[category] || _notifIcons.link_message;
            var color = _notifColors[category] || 'var(--camp-green)';
            // Everything reaching this point is unread — a read/dismissed row
            // never enters `visible` in the first place (see above).
            var unreadDot = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + color + ';margin-right:6px;vertical-align:middle"></span>';
            var importantTag = v.important ? '<span class="dash-notif-important-tag">Important</span>' : '';
            var target = _notifBuildLinkTarget(n, category);
            var bodyText = _notifBodyText(n, category);
            var canReply = category === 'link_message' && n.source_id;

            var card = '<div class="dash-notif-item dash-notif-live dash-notif-unread" style="border-left:3px solid ' + color + ';" id="notifCard_' + n.id + '">'
                + '<div class="dash-notif-icon" style="color:' + color + '">' + icon + '</div>'
                + '<div class="dash-notif-body">'
                + '<p style="cursor:' + (target ? 'pointer' : 'default') + ';" onclick="markNotificationRead(\'' + n.id + '\', ' + (target ? '\'' + target.replace(/'/g, "\\'") + '\'' : 'null') + ')">' + unreadDot + _dashEsc(n.title) + importantTag
                + (bodyText ? '<br><span style="color:var(--slate-400);font-weight:400;">' + _dashEsc(bodyText) + '</span>' : '') + '</p>'
                + '<span class="dash-notif-time">' + _notifRelTime(n.created_at) + '</span>';
            if (canReply) {
                card += '<div><button type="button" class="dash-notif-reply-btn" onclick="toggleNotifQuickReply(\'' + n.id + '\')">Reply</button></div>'
                    + '<div class="dash-notif-reply-box" id="notifReply_' + n.id + '" style="display:none;">'
                    + '<textarea id="notifReplyText_' + n.id + '" placeholder="Type a quick reply…"></textarea>'
                    + '<div class="dash-notif-reply-actions">'
                    + '<button type="button" class="dash-notif-reply-send" onclick="sendNotifQuickReply(\'' + n.id + '\', \'' + (n.source_id || '') + '\')">Send</button>'
                    + '<button type="button" class="dash-notif-reply-cancel" onclick="toggleNotifQuickReply(\'' + n.id + '\')">Cancel</button>'
                    + '</div><span class="dash-notif-reply-status" id="notifReplyStatus_' + n.id + '"></span></div>';
            }
            card += '</div>'
                + '<button type="button" class="dash-notif-dismiss" title="Dismiss" onclick="dismissNotification(\'' + n.id + '\', ' + (n.source == null ? 'true' : 'false') + ')">'
                + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
                + '</div>';
            return card;
        }).join('');
    }

    window.markNotificationRead = async function(notifId, target) {
        try {
            if (currentUser && window.supabase) {
                await window.supabase.from('notification_reads')
                    .upsert({ notification_id: notifId, user_id: currentUser.id }, { onConflict: 'notification_id,user_id', ignoreDuplicates: true });
            }
        } catch (e) {
            console.warn('[Dashboard] markNotificationRead failed:', e);
        }
        if (target) window.location.href = target;
        else loadLiveNotifications();
    };

    // Removes a notification from view for good. Source-based rows (camp-
    // wide) use the notification_reads join table — the row itself has no
    // owner to mutate. Legacy per-user rows (source IS NULL) are mutated
    // directly via their own `read` column, the same mechanism
    // integration_hooks.js's conflict-notify receiver already uses (RLS:
    // notifications_update allows user_id = auth.uid()).
    window.dismissNotification = async function(notifId, isLegacy) {
        var card = document.getElementById('notifCard_' + notifId);
        if (card) card.remove();
        try {
            if (!window.supabase) return;
            if (isLegacy) {
                await window.supabase.from('notifications').update({ read: true }).eq('id', notifId);
            } else if (currentUser) {
                await window.supabase.from('notification_reads')
                    .upsert({ notification_id: notifId, user_id: currentUser.id }, { onConflict: 'notification_id,user_id', ignoreDuplicates: true });
            }
        } catch (e) {
            console.warn('[Dashboard] dismissNotification failed:', e);
        }
        loadLiveNotifications();
    };

    // Dismisses every notification currently in view in one pass, batched
    // per mechanism (one upsert for all source-based ids, one update for
    // all legacy ids) rather than N round trips.
    window.clearAllNotifications = async function() {
        var rows = _notifVisibleRows.slice();
        if (!rows.length) return;
        if (!confirm('Clear all ' + rows.length + ' notification' + (rows.length === 1 ? '' : 's') + '?')) return;
        rows.forEach(function(r) {
            var card = document.getElementById('notifCard_' + r.id);
            if (card) card.remove();
        });
        try {
            if (window.supabase) {
                var legacyIds = rows.filter(function(r) { return r.isLegacy; }).map(function(r) { return r.id; });
                var liveIds = rows.filter(function(r) { return !r.isLegacy; }).map(function(r) { return r.id; });
                var ops = [];
                if (legacyIds.length) {
                    ops.push(window.supabase.from('notifications').update({ read: true }).in('id', legacyIds));
                }
                if (liveIds.length && currentUser) {
                    ops.push(window.supabase.from('notification_reads')
                        .upsert(liveIds.map(function(id) { return { notification_id: id, user_id: currentUser.id }; }), { onConflict: 'notification_id,user_id', ignoreDuplicates: true }));
                }
                await Promise.all(ops);
            }
        } catch (e) {
            console.warn('[Dashboard] clearAllNotifications failed:', e);
        }
        loadLiveNotifications();
    };

    window.toggleNotifQuickReply = function(notifId) {
        var box = document.getElementById('notifReply_' + notifId);
        if (!box) return;
        box.style.display = box.style.display === 'none' ? 'flex' : 'none';
        if (box.style.display === 'flex') {
            var ta = document.getElementById('notifReplyText_' + notifId);
            if (ta) ta.focus();
        }
    };

    // Quick reply from the Dashboard card — mirrors campistry_link_data.js's
    // _insertMessageRow (the same direct link_messages insert the full Link
    // admin composer uses), just without loading that whole app's state.
    // Looks the parent's thread/name/email up fresh from the most recent
    // inbound message in the thread, rather than trusting anything embedded
    // in the notification row itself. `threadId` is the notification's
    // source_id — migration 092 keys link_message notifications on the
    // thread, not the individual message, so this is a thread id, not a
    // message id.
    window.sendNotifQuickReply = async function(notifId, threadId) {
        var status = document.getElementById('notifReplyStatus_' + notifId);
        var ta = document.getElementById('notifReplyText_' + notifId);
        var body = (ta && ta.value || '').trim();
        if (!body) { if (status) status.textContent = 'Enter a reply.'; return; }
        if (!threadId || !window.supabase) { if (status) status.textContent = 'Cannot reply to this message.'; return; }
        if (status) status.textContent = 'Sending…';
        try {
            var srcRes = await window.supabase.from('link_messages')
                .select('thread_id, parent_name, parent_email, camper_name')
                .eq('thread_id', threadId).eq('direction', 'in')
                .order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (srcRes.error || !srcRes.data || !srcRes.data.parent_email) {
                if (status) status.textContent = 'Could not find this conversation.';
                return;
            }
            var src = srcRes.data;
            var campId = _notifCampId();
            var insRes = await window.supabase.from('link_messages').insert({
                camp_id: campId, thread_id: src.thread_id, direction: 'out',
                parent_name: src.parent_name || '', parent_email: src.parent_email,
                camper_name: src.camper_name || null,
                subject: 'Reply from Camp', body: body, channels: ['app'], read: false
            });
            if (insRes.error) { if (status) status.textContent = 'Could not send — try again.'; return; }
            // Best-effort push — never block the reply itself on this.
            if (window.supabase.functions) {
                var preview = body.length > 140 ? body.slice(0, 139) + '...' : body;
                window.supabase.functions.invoke('send-push', {
                    body: { campId: campId, pref: 'notifyMessages', email: src.parent_email, title: 'Reply from Camp', body: preview, data: { page: 'messages' } }
                }).catch(function() {});
            }
            if (status) status.textContent = 'Sent!';
            if (typeof dnToast === 'function') dnToast('Reply sent to ' + (src.parent_name || 'parent'));
            window.dismissNotification(notifId, false);
        } catch (e) {
            console.warn('[Dashboard] sendNotifQuickReply failed:', e);
            if (status) status.textContent = 'Could not send — try again.';
        }
    };

    // ── NOTIFICATION SETTINGS (ignore / notify / important, per category) ──
    window.openNotifSettings = function() {
        var rowsWrap = document.getElementById('notifSettingsRows');
        var overlay = document.getElementById('notifSettingsOverlay');
        if (!rowsWrap || !overlay) return;
        var prefs = _notifPrefs();
        var options = [['ignore', 'Ignore'], ['notify', 'Notify'], ['important', 'Important']];
        rowsWrap.innerHTML = Object.keys(NOTIF_CATEGORY_META).map(function(cat) {
            var meta = NOTIF_CATEGORY_META[cat];
            var current = prefs[cat] || 'notify';
            var buttons = options.map(function(o) {
                return '<button type="button" data-cat="' + cat + '" data-val="' + o[0] + '" class="' + (current === o[0] ? 'active' : '') + '" onclick="_notifSettingsPick(this)">' + o[1] + '</button>';
            }).join('');
            return '<div class="notif-settings-row">'
                + '<span class="notif-settings-row-label">' + _dashEsc(meta.label) + '</span>'
                + '<span class="notif-settings-row-desc">' + _dashEsc(meta.desc) + '</span>'
                + '<div class="notif-settings-seg">' + buttons + '</div>'
                + '</div>';
        }).join('');
        overlay.style.display = 'flex';
    };
    window.closeNotifSettings = function() {
        var overlay = document.getElementById('notifSettingsOverlay');
        if (overlay) overlay.style.display = 'none';
    };
    window._notifSettingsPick = function(btn) {
        var cat = btn.getAttribute('data-cat'), val = btn.getAttribute('data-val');
        var prefs = _notifPrefs();
        prefs[cat] = val;
        _notifSavePrefs(prefs);
        var seg = btn.parentElement;
        Array.prototype.forEach.call(seg.querySelectorAll('button'), function(b) { b.classList.toggle('active', b === btn); });
        loadLiveNotifications();
    };

    function subscribeToLiveNotifications() {
        var campId = _notifCampId();
        if (!campId || !window.supabase) return;
        try {
            if (_notifChannel) window.supabase.removeChannel(_notifChannel);
            _notifChannel = window.supabase.channel('dash-notifs-' + campId)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'camp_id=eq.' + campId }, function() { loadLiveNotifications(); })
                .subscribe();
        } catch (e) {
            console.warn('[Dashboard] notifications realtime subscribe failed:', e);
        }
        // Belt-and-suspenders fallback, same pattern as campistry_link_admin.html's
        // admin message inbox: a 30s poll plus a visibilitychange re-sync in case
        // the realtime socket silently drops.
        if (_notifPollTimer) clearInterval(_notifPollTimer);
        _notifPollTimer = setInterval(loadLiveNotifications, 30000);
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) loadLiveNotifications();
        });
    }

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
