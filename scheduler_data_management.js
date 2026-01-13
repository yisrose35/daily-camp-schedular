// =============================================================================
// scheduler_data_management.js — Deletion Sync & Regeneration Support
// VERSION: v2.1.0 (SYNC RACE FIX)
// =============================================================================
//
// FIXES THREE CRITICAL ISSUES:
//
// 1. DELETION SYNC: The cloud_storage_bridge's merge logic was RE-INTRODUCING
//    deleted data from the cloud. This fix patches deletion to be EXPLICIT.
//
// 2. ROOT-LEVEL LEGACY DATA: The view_schedule_loader_fix.js was migrating
//    ROOT-level scheduleAssignments back into the date path after deletion.
//
// 3. SYNC RACE CONDITION: After direct PATCH, subsequent syncs could re-introduce
//    data due to timing issues. Now we suppress syncs during deletion.
//
// 4. REGENERATION: When a scheduler wants to regenerate their schedule for a day
//    that already has data in the cloud, we need to:
//    a) Clear ONLY their divisions (preserve other schedulers' work)
//    b) Sync that deletion to cloud BEFORE the merge logic runs
//    c) Then allow fresh generation
//
// INTEGRATES WITH: calendar.js v2.8
// =============================================================================

(function() {
    'use strict';

    console.log("🗑️ Scheduler Data Management v2.1.0 loading...");

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
    const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
    const TABLE = "camp_state";
    const DAILY_DATA_KEY = "campDailyData_v1";
    
    // Sync suppression flag to prevent race conditions during deletion
    window._suppressCloudSync = false;

    // =========================================================================
    // HELPER: Get Auth & Camp Info
    // =========================================================================
    
    async function getAuthInfo() {
        if (!window.supabase) {
            console.warn('🗑️ Supabase not available');
            return null;
        }
        
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) {
                console.warn('🗑️ No active session');
                return null;
            }
            
            const campId = window.getCampId?.() || localStorage.getItem('campistry_user_id');
            if (!campId || campId === 'demo_camp_001') {
                console.warn('🗑️ No valid camp ID (demo mode)');
                return null;
            }
            
            return {
                token: session.access_token,
                campId: campId,
                userId: session.user.id,
                email: session.user.email
            };
        } catch (e) {
            console.error('🗑️ Auth error:', e);
            return null;
        }
    }

    // =========================================================================
    // HELPER: Get User's Editable Divisions & Bunks
    // =========================================================================
    
    function getUserEditableDivisions() {
        // Method 1: AccessControl
        if (window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs?.length > 0) return divs;
        }
        
        // Method 2: SubdivisionScheduleManager
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs?.length > 0) return divs;
        }
        
        // Method 3: Check role - Owner/Admin gets all
        const role = window.AccessControl?.getCurrentRole?.() || 
                    window.getCampistryUserRole?.() || 'owner';
        
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {});
        }
        
        return [];
    }
    
    function getUserEditableBunks() {
        const divisions = getUserEditableDivisions();
        const allDivisions = window.divisions || {};
        const bunks = new Set();
        
        for (const divName of divisions) {
            const divInfo = allDivisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => bunks.add(b));
            }
        }
        
        return bunks;
    }
    
    function isOwnerOrAdmin() {
        const role = window.AccessControl?.getCurrentRole?.() || 
                    window.getCampistryUserRole?.() || 'owner';
        return role === 'owner' || role === 'admin';
    }

    // =========================================================================
    // CORE: DIRECT CLOUD STATE MODIFICATION
    // =========================================================================
    
    /**
     * Directly modify cloud state - bypasses merge logic
     * This is critical for deletions to actually persist
     * 
     * @param {Function} modifyFn - Function that modifies the state object
     * @returns {Promise<boolean>}
     */
    async function modifyCloudStateDirectly(modifyFn) {
        const auth = await getAuthInfo();
        if (!auth) {
            console.log('🗑️ Not authenticated, local-only operation');
            return false;
        }
        
        try {
            // 1. Fetch current cloud state
            const url = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${auth.campId}&select=state`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${auth.token}`,
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store'
                }
            });
            
            if (!response.ok) {
                console.error('🗑️ Failed to fetch cloud state:', response.status);
                return false;
            }
            
            const data = await response.json();
            if (!data || data.length === 0) {
                console.log('🗑️ No cloud data exists yet');
                return true; // Nothing to modify
            }
            
            // 2. Apply modification function
            const cloudState = data[0].state || {};
            modifyFn(cloudState);
            cloudState.updated_at = new Date().toISOString();
            
            // 3. Save back to cloud (PATCH, not merge)
            const patchUrl = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${auth.campId}`;
            const patchResponse = await fetch(patchUrl, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${auth.token}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({ 
                    state: cloudState, 
                    owner_id: auth.campId,
                    updated_at: new Date().toISOString()
                })
            });
            
            if (patchResponse.ok) {
                console.log('🗑️ ✅ Cloud state modified directly');
                return true;
            } else {
                console.error('🗑️ Cloud modification failed:', patchResponse.status);
                return false;
            }
            
        } catch (e) {
            console.error('🗑️ Direct cloud modification error:', e);
            return false;
        }
    }

    // =========================================================================
    // FIX 1: PATCHED eraseCurrentDailyData
    // =========================================================================
    
    /**
     * Fixed version of eraseCurrentDailyData that:
     * - For owners: Deletes entire day
     * - For schedulers: Deletes only their divisions
     * - Directly modifies cloud (bypasses merge)
     * - Also clears ROOT-level legacy data to prevent re-migration
     * - Suppresses sync during operation to prevent race conditions
     */
    async function patchedEraseCurrentDailyData() {
        const dateKey = window.currentScheduleDate;
        console.log(`🗑️ [PATCHED] Erasing schedule for ${dateKey}...`);
        
        const isOwner = isOwnerOrAdmin();
        const myDivisions = getUserEditableDivisions();
        const myBunks = getUserEditableBunks();
        
        console.log(`🗑️ User role: ${isOwner ? 'owner/admin' : 'scheduler'}`);
        console.log(`🗑️ Editable divisions: ${myDivisions.join(', ') || 'ALL'}`);
        
        // Confirmation message varies by role
        let confirmMsg;
        if (isOwner) {
            confirmMsg = `Delete ALL schedules for ${dateKey}?\n\nThis will delete data from ALL schedulers.`;
        } else {
            confirmMsg = `Delete YOUR schedule for ${dateKey}?\n\n` +
                        `Your divisions: ${myDivisions.join(', ')}\n\n` +
                        `Other schedulers' data will be preserved.`;
        }
        
        if (!confirm(confirmMsg)) return;
        
        // ⭐ SUPPRESS SYNC to prevent race conditions
        window._suppressCloudSync = true;
        console.log('🗑️ Sync suppression ON');
        
        try {
            // 1. Modify localStorage - BOTH date-specific AND root-level legacy data
            const all = window.loadAllDailyData?.() || JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
            
            if (isOwner) {
                // Owner deletes entire day
                delete all[dateKey];
                console.log(`🗑️ Deleted entire day from localStorage`);
            } else {
                // Scheduler deletes only their bunks
                if (all[dateKey]?.scheduleAssignments) {
                    let deletedCount = 0;
                    for (const bunkId of myBunks) {
                        if (all[dateKey].scheduleAssignments[bunkId]) {
                            delete all[dateKey].scheduleAssignments[bunkId];
                            deletedCount++;
                        }
                    }
                    console.log(`🗑️ Deleted ${deletedCount} bunks from localStorage (date path)`);
                }
                
                // Also clear subdivision status
                if (all[dateKey]?.subdivisionSchedules) {
                    const myDivisionsSet = new Set(myDivisions);
                    for (const [subId, subData] of Object.entries(all[dateKey].subdivisionSchedules)) {
                        const subDivisions = subData.divisions || [];
                        if (subDivisions.some(d => myDivisionsSet.has(d))) {
                            subData.status = 'empty';
                            subData.scheduleData = {};
                            subData.fieldUsageClaims = {};
                        }
                    }
                }
            }
            
            // ⭐ FIX: Also clear ROOT-level legacy data to prevent re-migration
            if (all.scheduleAssignments) {
                if (isOwner) {
                    delete all.scheduleAssignments;
                    console.log('🗑️ Deleted ROOT scheduleAssignments');
                } else {
                    for (const bunkId of myBunks) {
                        if (all.scheduleAssignments[bunkId]) {
                            delete all.scheduleAssignments[bunkId];
                        }
                    }
                    console.log('🗑️ Cleared bunks from ROOT scheduleAssignments');
                }
            }
            if (all.leagueAssignments) {
                if (isOwner) {
                    delete all.leagueAssignments;
                    console.log('🗑️ Deleted ROOT leagueAssignments');
                }
            }
            
            // Also clear window.scheduleAssignments (in-memory)
            if (window.scheduleAssignments) {
                if (isOwner) {
                    window.scheduleAssignments = {};
                } else {
                    for (const bunkId of myBunks) {
                        delete window.scheduleAssignments[bunkId];
                    }
                }
                console.log('🗑️ Cleared window.scheduleAssignments');
            }
            
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(all));
            
            // 2. Directly modify cloud (bypasses merge logic!)
            const cloudSuccess = await modifyCloudStateDirectly((cloudState) => {
                if (!cloudState.daily_schedules) cloudState.daily_schedules = {};
                
                if (isOwner) {
                    // Owner deletes entire day
                    delete cloudState.daily_schedules[dateKey];
                    console.log(`🗑️ Deleted entire day from cloud`);
                } else {
                    // Scheduler deletes only their bunks
                    const dateData = cloudState.daily_schedules[dateKey];
                    if (dateData?.scheduleAssignments) {
                        for (const bunkId of myBunks) {
                            delete dateData.scheduleAssignments[bunkId];
                        }
                    }
                    
                    // Clear subdivision status
                    if (dateData?.subdivisionSchedules) {
                        const myDivisionsSet = new Set(myDivisions);
                        for (const [subId, subData] of Object.entries(dateData.subdivisionSchedules)) {
                            const subDivisions = subData.divisions || [];
                            if (subDivisions.some(d => myDivisionsSet.has(d))) {
                                subData.status = 'empty';
                                subData.scheduleData = {};
                                subData.fieldUsageClaims = {};
                            }
                        }
                    }
                }
                
                // ⭐ FIX: Also clear ROOT-level data in cloud
                if (cloudState.scheduleAssignments) {
                    if (isOwner) {
                        delete cloudState.scheduleAssignments;
                    } else {
                        for (const bunkId of myBunks) {
                            delete cloudState.scheduleAssignments[bunkId];
                        }
                    }
                    console.log('🗑️ Cleared ROOT cloud scheduleAssignments');
                }
                if (cloudState.leagueAssignments && isOwner) {
                    delete cloudState.leagueAssignments;
                    console.log('🗑️ Cleared ROOT cloud leagueAssignments');
                }
            });
            
            if (cloudSuccess) {
                console.log('🗑️ ✅ Deletion synced to cloud');
            } else {
                console.warn('🗑️ ⚠️ Cloud sync failed, local deletion complete');
            }
            
            // 3. Refresh UI WITHOUT triggering cloud sync
            // Clear cached data first
            window._cloudBlockedResources = null;
            window._cloudScheduleData = null;
            
            // Manually refresh the UI state from localStorage (don't call functions that trigger syncs)
            if (typeof window.updateTable === 'function') {
                window.updateTable();
            }
            
            console.log(`🗑️ ✅ Erase complete for ${dateKey}`);
            
        } finally {
            // ⭐ Re-enable sync after a delay to let UI settle
            setTimeout(() => {
                window._suppressCloudSync = false;
                console.log('🗑️ Sync suppression OFF');
            }, 2000);
        }
    }

    // =========================================================================
    // FIX 2: PATCHED eraseAllDailyData
    // =========================================================================
    
    /**
     * Fixed version of eraseAllDailyData that directly modifies cloud
     * Also clears ROOT-level legacy data
     */
    async function patchedEraseAllDailyData() {
        // Only owners can delete all data
        if (!isOwnerOrAdmin()) {
            alert("Only owners/admins can delete all daily schedules.\n\nUse 'Erase Today' to delete your own schedule.");
            return;
        }
        
        const confirmed = confirm(
            "⚠️ DELETE ALL DAILY SCHEDULES?\n\n" +
            "This will delete schedules for ALL dates from ALL schedulers.\n\n" +
            "This action cannot be undone."
        );
        if (!confirmed) return;
        
        console.log('🗑️ [PATCHED] Erasing all daily data...');
        
        // Suppress sync during operation
        window._suppressCloudSync = true;
        
        try {
            // 1. Clear localStorage completely
            localStorage.removeItem(DAILY_DATA_KEY);
            
            // Also clear any in-memory state
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            
            // 2. Directly clear from cloud (including ROOT level)
            const cloudSuccess = await modifyCloudStateDirectly((cloudState) => {
                cloudState.daily_schedules = {};
                // Also clear ROOT-level legacy data
                delete cloudState.scheduleAssignments;
                delete cloudState.leagueAssignments;
                console.log('🗑️ Cleared daily_schedules and ROOT data in cloud');
            });
            
            if (cloudSuccess) {
                console.log('🗑️ ✅ All daily data erased from cloud');
            }
            
            alert('All daily schedules deleted. Reloading...');
            window.location.reload();
            
        } finally {
            window._suppressCloudSync = false;
        }
    }

    // =========================================================================
    // FIX 3: REGENERATION - Clear Before Generate
    // =========================================================================
    
    /**
     * Clear current user's schedule data before regenerating
     * This ensures a clean slate for the optimizer
     * 
     * @param {string} dateKey - Date to clear
     * @param {boolean} syncToCloud - Whether to sync deletion to cloud
     * @returns {Promise<boolean>}
     */
    async function clearMyScheduleBeforeRegenerate(dateKey, syncToCloud = true) {
        console.log(`🔄 Clearing my schedule before regenerate for ${dateKey}...`);
        
        const myBunks = getUserEditableBunks();
        const myDivisions = getUserEditableDivisions();
        
        console.log(`🔄 My divisions: ${myDivisions.join(', ')}`);
        console.log(`🔄 My bunks: ${myBunks.size} bunks`);
        
        // 1. Clear from window.scheduleAssignments (in-memory)
        if (window.scheduleAssignments) {
            let clearedCount = 0;
            for (const bunkId of myBunks) {
                if (window.scheduleAssignments[bunkId]) {
                    delete window.scheduleAssignments[bunkId];
                    clearedCount++;
                }
            }
            console.log(`🔄 Cleared ${clearedCount} bunks from memory`);
        }
        
        // 2. Clear from localStorage
        try {
            const dailyData = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
            const dateData = dailyData[dateKey];
            
            if (dateData?.scheduleAssignments) {
                for (const bunkId of myBunks) {
                    delete dateData.scheduleAssignments[bunkId];
                }
            }
            
            // Clear subdivision schedule data
            if (dateData?.subdivisionSchedules) {
                const myDivisionsSet = new Set(myDivisions);
                for (const [subId, subData] of Object.entries(dateData.subdivisionSchedules)) {
                    const subDivisions = subData.divisions || [];
                    if (subDivisions.some(d => myDivisionsSet.has(d))) {
                        subData.status = 'empty';
                        subData.scheduleData = {};
                        subData.fieldUsageClaims = {};
                        subData.lockedBy = null;
                        subData.lockedAt = null;
                    }
                }
            }
            
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
            console.log(`🔄 Cleared my data from localStorage`);
            
        } catch (e) {
            console.error('🔄 localStorage clear error:', e);
        }
        
        // 3. Clear from cloud (critical for multi-scheduler!)
        let cloudSuccess = true;
        if (syncToCloud) {
            cloudSuccess = await modifyCloudStateDirectly((cloudState) => {
                if (!cloudState.daily_schedules) return;
                
                const dateData = cloudState.daily_schedules[dateKey];
                if (!dateData) return;
                
                // Clear my bunks
                if (dateData.scheduleAssignments) {
                    for (const bunkId of myBunks) {
                        delete dateData.scheduleAssignments[bunkId];
                    }
                }
                
                // Clear my subdivision status
                if (dateData.subdivisionSchedules) {
                    const myDivisionsSet = new Set(myDivisions);
                    for (const [subId, subData] of Object.entries(dateData.subdivisionSchedules)) {
                        const subDivisions = subData.divisions || [];
                        if (subDivisions.some(d => myDivisionsSet.has(d))) {
                            subData.status = 'empty';
                            subData.scheduleData = {};
                            subData.fieldUsageClaims = {};
                        }
                    }
                }
                
                console.log(`🔄 Cleared my data from cloud`);
            });
        }
        
        // 4. Clear SubdivisionScheduleManager state
        if (window.SubdivisionScheduleManager) {
            const mySubdivisions = window.SubdivisionScheduleManager.getEditableSubdivisions?.() || [];
            for (const sub of mySubdivisions) {
                const schedule = window.SubdivisionScheduleManager.getSubdivisionSchedule?.(sub.id);
                if (schedule) {
                    schedule.status = 'empty';
                    schedule.scheduleData = {};
                    schedule.fieldUsageClaims = {};
                }
            }
        }
        
        console.log(`🔄 ✅ Pre-regenerate clear complete`);
        return cloudSuccess;
    }

    // =========================================================================
    // REGENERATION WORKFLOW
    // =========================================================================
    
    /**
     * Complete regeneration workflow:
     * 1. Clear MY old schedule data (local + cloud)
     * 2. Fetch fresh blocked resources from other schedulers
     * 3. Ready for optimizer to run fresh
     * 
     * @param {Object} options
     * @param {string} options.dateKey - Date to regenerate
     * @returns {Promise<Object>} - Result
     */
    async function regenerateMySchedule(options = {}) {
        const {
            dateKey = window.currentScheduleDate
        } = options;
        
        console.log('\n' + '═'.repeat(60));
        console.log('🔄 REGENERATE SCHEDULE WORKFLOW');
        console.log('═'.repeat(60));
        console.log(`Date: ${dateKey}`);
        
        try {
            // Step 1: Clear my old data first
            console.log('\n🗑️ Step 1: Clearing old schedule data...');
            const clearSuccess = await clearMyScheduleBeforeRegenerate(dateKey, true);
            
            if (!clearSuccess) {
                console.warn('🔄 ⚠️ Cloud clear may have failed');
            }
            
            // Step 2: Fetch fresh blocked resources from cloud
            console.log('\n📥 Step 2: Fetching blocked resources from other schedulers...');
            
            if (window.SchedulerCloudFetch?.initializeSchedulerView) {
                await window.SchedulerCloudFetch.initializeSchedulerView(dateKey);
                console.log('✅ Blocked resources loaded');
            }
            
            // Step 3: Refresh local data state
            console.log('\n🔄 Step 3: Refreshing local state...');
            window.loadCurrentDailyData?.();
            
            // Reinitialize schedule system
            if (window.initScheduleSystem) {
                window.initScheduleSystem();
            }
            
            console.log('\n✅ Ready for schedule generation!');
            console.log('   - Your old schedule has been cleared');
            console.log('   - Other schedulers\' data is preserved');
            console.log('   - Use "Generate Schedule" to create new schedule');
            console.log('═'.repeat(60) + '\n');
            
            return {
                success: true,
                dateKey,
                message: 'Ready for regeneration'
            };
            
        } catch (error) {
            console.error('🔄 Regeneration prep failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // =========================================================================
    // HOOK INTO EXISTING CALENDAR.JS FUNCTIONS
    // =========================================================================
    
    function patchCalendarFunctions() {
        console.log('🗑️ Patching calendar.js functions...');
        
        // Store originals
        const originalEraseCurrentDailyData = window.eraseCurrentDailyData;
        const originalEraseAllDailyData = window.eraseAllDailyData;
        
        // Replace with patched versions
        window.eraseCurrentDailyData = patchedEraseCurrentDailyData;
        window.eraseAllDailyData = patchedEraseAllDailyData;
        
        // Keep originals accessible
        window._originalEraseCurrentDailyData = originalEraseCurrentDailyData;
        window._originalEraseAllDailyData = originalEraseAllDailyData;
        
        console.log('🗑️ ✅ Calendar functions patched');
    }

    // =========================================================================
    // HOOK INTO UI BUTTONS
    // =========================================================================
    
    function hookDeletionButtons() {
        // Hook "Erase Today" button
        const eraseTodayBtn = document.getElementById('eraseTodayBtn');
        if (eraseTodayBtn && !eraseTodayBtn._patched) {
            eraseTodayBtn.onclick = async function(e) {
                e.preventDefault();
                await patchedEraseCurrentDailyData();
            };
            eraseTodayBtn._patched = true;
            console.log('🗑️ ✅ Hooked eraseTodayBtn');
        }
        
        // Hook "Erase All Schedules" button (if exists)
        const eraseAllSchedulesBtn = document.getElementById('eraseAllSchedulesBtn');
        if (eraseAllSchedulesBtn && !eraseAllSchedulesBtn._patched) {
            eraseAllSchedulesBtn.onclick = async function(e) {
                e.preventDefault();
                await patchedEraseAllDailyData();
            };
            eraseAllSchedulesBtn._patched = true;
            console.log('🗑️ ✅ Hooked eraseAllSchedulesBtn');
        }
    }

    // =========================================================================
    // ADD REGENERATE BUTTON TO UI
    // =========================================================================
    
    function addRegenerateButton() {
        // Find container
        const masterScheduler = document.getElementById('master-scheduler-content') ||
                               document.getElementById('master-scheduler');
        if (!masterScheduler) {
            setTimeout(addRegenerateButton, 1000);
            return;
        }
        
        // Check if button already exists
        if (document.getElementById('btn-regenerate-schedule')) return;
        
        // Find or create toolbar
        let toolbar = document.querySelector('.scheduler-action-toolbar, .regenerate-toolbar');
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.className = 'regenerate-toolbar';
            toolbar.style.cssText = `
                display: flex;
                gap: 10px;
                margin-bottom: 16px;
                padding: 12px;
                background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
                border-radius: 8px;
                border: 1px solid #f59e0b;
                flex-wrap: wrap;
                align-items: center;
            `;
            
            // Insert after any existing header
            const header = masterScheduler.querySelector('h2, .header, .title');
            if (header) {
                header.after(toolbar);
            } else {
                masterScheduler.insertBefore(toolbar, masterScheduler.firstChild);
            }
        }
        
        // Create info text
        const infoText = document.createElement('span');
        infoText.style.cssText = `
            font-size: 12px;
            color: #92400e;
            margin-right: auto;
        `;
        infoText.innerHTML = '🔄 <strong>Regenerate:</strong> Clear your schedule and start fresh (preserves other schedulers\' work)';
        toolbar.appendChild(infoText);
        
        // Create regenerate button
        const btn = document.createElement('button');
        btn.id = 'btn-regenerate-schedule';
        btn.innerHTML = '🔄 Clear & Regenerate';
        btn.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 6px;
            border: 1px solid #d97706;
            background: white;
            color: #92400e;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        `;
        
        btn.onmouseover = () => {
            btn.style.background = '#fffbeb';
            btn.style.borderColor = '#b45309';
        };
        btn.onmouseout = () => {
            btn.style.background = 'white';
            btn.style.borderColor = '#d97706';
        };
        
        btn.onclick = async (e) => {
            e.preventDefault();
            
            const dateKey = window.currentScheduleDate;
            const myDivisions = getUserEditableDivisions();
            
            const confirmed = confirm(
                `🔄 REGENERATE YOUR SCHEDULE\n\n` +
                `Date: ${dateKey}\n` +
                `Your divisions: ${myDivisions.join(', ') || 'ALL'}\n\n` +
                `This will:\n` +
                `• Clear your current schedule for this date\n` +
                `• Preserve other schedulers' data\n` +
                `• Sync deletion to cloud\n` +
                `• Prepare for fresh generation\n\n` +
                `Continue?`
            );
            
            if (!confirmed) return;
            
            btn.innerHTML = '⏳ Preparing...';
            btn.disabled = true;
            
            try {
                const result = await regenerateMySchedule({ dateKey });
                
                if (result.success) {
                    alert(
                        '✅ Ready for regeneration!\n\n' +
                        'Your old schedule has been cleared.\n' +
                        'Other schedulers\' data is preserved.\n\n' +
                        'Now click "Generate Schedule" to create your new schedule.'
                    );
                    
                    // Refresh UI
                    if (window.initMasterScheduler) {
                        window.initMasterScheduler();
                    }
                    if (window.updateTable) {
                        window.updateTable();
                    }
                } else {
                    alert('❌ Failed: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                console.error('Regeneration error:', error);
                alert('❌ Error: ' + error.message);
            } finally {
                btn.innerHTML = '🔄 Clear & Regenerate';
                btn.disabled = false;
            }
        };
        
        toolbar.appendChild(btn);
        console.log('🔄 ✅ Added regenerate button');
    }

    // =========================================================================
    // HOOK INTO GENERATE BUTTON
    // =========================================================================
    
    function hookGenerateButton() {
        // Find generate buttons (there may be multiple)
        const generateBtns = document.querySelectorAll(
            '[onclick*="runSkeletonOptimizer"], ' +
            '[onclick*="generateSchedule"], ' +
            '#generateScheduleBtn, ' +
            '#btnGenerateSchedule, ' +
            '.generate-schedule-btn'
        );
        
        generateBtns.forEach(btn => {
            if (btn._regenerateHooked) return;
            
            const originalOnClick = btn.onclick;
            
            btn.onclick = async function(e) {
                const dateKey = window.currentScheduleDate;
                
                // Check if user has existing data
                const dailyData = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
                const dateData = dailyData[dateKey]?.scheduleAssignments || {};
                const myBunks = getUserEditableBunks();
                
                const hasExistingData = [...myBunks].some(b => {
                    const slots = dateData[b];
                    return slots && slots.some(s => s && !s.continuation && s.field);
                });
                
                if (hasExistingData) {
                    const confirmRegen = confirm(
                        `⚠️ You already have a schedule for ${dateKey}.\n\n` +
                        `Generating will REPLACE your current schedule.\n` +
                        `Other schedulers' data will be preserved.\n\n` +
                        `Continue?`
                    );
                    
                    if (!confirmRegen) {
                        e.preventDefault();
                        return false;
                    }
                    
                    // Clear existing data before generation
                    console.log('🔄 Clearing existing data before regenerate...');
                    await clearMyScheduleBeforeRegenerate(dateKey, true);
                    
                    // Reload data
                    window.loadCurrentDailyData?.();
                }
                
                // Call original handler
                if (originalOnClick) {
                    return originalOnClick.call(this, e);
                }
            };
            
            btn._regenerateHooked = true;
            console.log('🔄 ✅ Hooked generate button:', btn.id || btn.className);
        });
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    /**
     * Intercept sync-related functions to respect suppression flag
     */
    function hookCloudSync() {
        // Hook forceSyncToCloud
        const originalSync = window.forceSyncToCloud;
        if (originalSync && !originalSync._suppressed) {
            window.forceSyncToCloud = async function(...args) {
                if (window._suppressCloudSync) {
                    console.log('🗑️ [SYNC INTERCEPTOR] Suppressing forceSyncToCloud');
                    return true; // Pretend success
                }
                return originalSync.apply(this, args);
            };
            window.forceSyncToCloud._suppressed = true;
            console.log('🗑️ ✅ forceSyncToCloud interceptor installed');
        }
        
        // Hook saveCurrentDailyData if it exists (might trigger syncs)
        const originalSave = window.saveCurrentDailyData;
        if (originalSave && !originalSave._suppressed) {
            window.saveCurrentDailyData = function(...args) {
                if (window._suppressCloudSync) {
                    console.log('🗑️ [SYNC INTERCEPTOR] Suppressing saveCurrentDailyData');
                    return; // Skip
                }
                return originalSave.apply(this, args);
            };
            window.saveCurrentDailyData._suppressed = true;
            console.log('🗑️ ✅ saveCurrentDailyData interceptor installed');
        }
    }
    
    function initialize() {
        console.log('🗑️ Initializing data management...');
        
        // Patch calendar.js functions
        patchCalendarFunctions();
        
        // Hook UI buttons
        hookDeletionButtons();
        
        // Hook cloud sync to respect suppression flag
        hookCloudSync();
        setTimeout(hookCloudSync, 1000); // Retry in case it loads later
        
        // Hook generate button
        setTimeout(hookGenerateButton, 1000);
        
        // Add regenerate button
        setTimeout(addRegenerateButton, 2000);
        
        // Re-hook when tabs change
        const origShowTab = window.showTab;
        if (origShowTab) {
            window.showTab = function(tabId) {
                origShowTab.call(this, tabId);
                
                if (tabId === 'master-scheduler') {
                    setTimeout(() => {
                        addRegenerateButton();
                        hookGenerateButton();
                    }, 100);
                }
            };
        }
        
        console.log('🗑️ ✅ Data management initialized');
    }
    
    // Auto-initialize when DOM is ready
    if (document.readyState === 'complete') {
        setTimeout(initialize, 500);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 500));
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.SchedulerDataManagement = {
        // Core functions
        modifyCloudStateDirectly,
        
        // Deletion functions
        patchedEraseCurrentDailyData,
        patchedEraseAllDailyData,
        
        // Regeneration functions
        clearMyScheduleBeforeRegenerate,
        regenerateMySchedule,
        
        // Helpers
        getUserEditableDivisions,
        getUserEditableBunks,
        isOwnerOrAdmin,
        getAuthInfo,
        
        // Manual initialization
        initialize,
        hookDeletionButtons,
        hookGenerateButton,
        hookCloudSync,
        addRegenerateButton
    };
    
    console.log("🗑️ Scheduler Data Management v2.1.0 loaded");

})();
