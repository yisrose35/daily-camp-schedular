// ============================================================================
// dashboard.js — Campistry Dashboard Logic
// 
// Handles:
// - Auth check (redirect to landing if not logged in)
// - Load/display camp profile
// - Edit camp name and address
// - Change password
// - Display stats from cloud storage
// - Logout
// ============================================================================

(function() {
    'use strict';

    // ========================================
    // STATE
    // ========================================
    
    let currentUser = null;
    let campData = null;
    let isEditMode = false;

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
            
            // Load dashboard data
            await loadDashboardData();
            
        } catch (e) {
            console.error('Auth check failed:', e);
            window.location.href = 'landing.html';
        }
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
        
        // Get camp name from user metadata or camps table
        let campName = currentUser.user_metadata?.camp_name || '';
        let campAddress = '';
        
        // Try to get from camps table
        try {
            const { data: camps, error } = await window.supabase
                .from('camps')
                .select('*')
                .eq('owner', currentUser.id)
                .single();
            
            if (camps && !error) {
                campData = camps;
                campName = camps.name || campName;
                campAddress = camps.address || '';
            }
        } catch (e) {
            console.warn('Could not load camp data:', e);
        }
        
        // Update displays
        if (campNameDisplay) {
            campNameDisplay.textContent = campName || 'Your Camp';
        }
        if (profileCampName) {
            profileCampName.textContent = campName || '—';
        }
        if (profileAddress) {
            profileAddress.textContent = campAddress || 'Not set';
        }
        
        // Pre-fill edit form
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
    // LOAD STATS
    // ========================================
    
    async function loadStats() {
        try {
            // Try to get from camp_state table (cloud storage)
            const { data, error } = await window.supabase
                .from('camp_state')
                .select('state')
                .eq('owner_id', currentUser.id)
                .single();
            
            if (data?.state) {
                const state = data.state;
                
                // Count divisions
                const divisions = state.divisions || state.app1?.divisions || {};
                const divisionCount = Object.keys(divisions).length;
                
                // Count bunks
                const bunks = state.bunks || state.app1?.bunks || [];
                const bunkCount = bunks.length;
                
                // Count campers (from bunkMetaData)
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
    // EDIT PROFILE
    // ========================================
    
    window.toggleEditMode = function() {
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
        
        // Clear messages
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
        
        // Reset form to current values
        if (editCampName) editCampName.value = profileCampName?.textContent || '';
        if (editAddress) editAddress.value = profileAddress?.textContent === 'Not set' ? '' : profileAddress?.textContent || '';
        
        // Clear messages
        if (profileError) profileError.textContent = '';
        if (profileSuccess) profileSuccess.textContent = '';
    };

    // Profile form submission
    if (profileEditForm) {
        profileEditForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newCampName = editCampName?.value.trim();
            const newAddress = editAddress?.value.trim();
            
            if (!newCampName) {
                if (profileError) profileError.textContent = 'Camp name is required.';
                return;
            }
            
            if (profileError) profileError.textContent = '';
            if (profileSuccess) profileSuccess.textContent = '';
            
            try {
                // Update camps table
                if (campData?.id) {
                    // Update existing
                    const { error } = await window.supabase
                        .from('camps')
                        .update({ name: newCampName, address: newAddress })
                        .eq('id', campData.id);
                    
                    if (error) throw error;
                } else {
                    // Insert new
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
                
                // Update user metadata
                await window.supabase.auth.updateUser({
                    data: { camp_name: newCampName }
                });
                
                // Update UI
                if (campNameDisplay) campNameDisplay.textContent = newCampName;
                if (profileCampName) profileCampName.textContent = newCampName;
                if (profileAddress) profileAddress.textContent = newAddress || 'Not set';
                
                if (profileSuccess) profileSuccess.textContent = 'Profile updated successfully!';
                
                // Exit edit mode after short delay
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
                
                // Clear form
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
            await window.supabase.auth.signOut();
            window.location.href = 'landing.html';
        } catch (e) {
            console.error('Logout error:', e);
            // Force redirect anyway
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
                window.location.href = 'landing.html';
            }
        });
    }

    // ========================================
    // INIT
    // ========================================
    
    checkAuth();
    setupAuthListener();
    
    console.log('📊 Campistry Dashboard loaded');

})();
