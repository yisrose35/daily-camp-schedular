// =============================================================================
// scheduler_data_management.js — Deletion Sync & Regeneration Support
// VERSION: v2.2.1 (CAMP ID FIX)
// =============================================================================
//
// FIXES FIVE CRITICAL ISSUES:
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
// 4. SCHEDULE VERSIONS TABLE: The schedule_version_merger.js was reconstructing
//    data from the schedule_versions Supabase table. Now we delete those records.
//
// 5. CAMP ID LOOKUP: Fixed getCampId to work for owners (via camps table) and
//    team members (via team_members table) with proper fallback chain.
//
// 6. REGENERATION: When a scheduler wants to regenerate their schedule for a day
//    that already has data in the cloud, we need to:
//    a) Clear ONLY their divisions (preserve other schedulers' work)
//    b) Sync that deletion to cloud BEFORE the merge logic runs
//    c) Then allow fresh generation
//
// INTEGRATES WITH: calendar.js v2.8, schedule_versions_db.js
// =============================================================================

(function() {
    'use strict';

    console.log("🗑️ Scheduler Data Management v2.2.1 loading...");

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
        
        const { data: { session } } = await window.supabase.auth.getSession();
        if (!session?.user) {
            console.warn('🗑️ No session');
            return null;
        }
        
        // Get camp_id from multiple sources (robust fallback chain)
        let campId = window._currentCampId || localStorage.getItem('currentCampId');
        console.log(`🗑️ [getAuthInfo] Check 1 - window/localStorage: ${campId || 'none'}`);
        
        if (!campId) {
            // Try to find it from camp_state localStorage
            const all = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
            campId = all.camp_id;
            console.log(`🗑️ [getAuthInfo] Check 2 - campDailyData: ${campId || 'none'}`);
        }
        
        if (!campId && window.CloudBridge?.campId) {
            campId = window.CloudBridge.campId;
            console.log(`🗑️ [getAuthInfo] Check 3 - CloudBridge: ${campId || 'none'}`);
        }
        
        // Try AccessControl which often has the camp ID
        if (!campId && window.AccessControl?.campId) {
            campId = window.AccessControl.campId;
            console.log(`🗑️ [getAuthInfo] Check 3b - AccessControl: ${campId || 'none'}`);
        }
        
        // Try from URL query params or path
        if (!campId) {
            const urlParams = new URLSearchParams(window.location.search);
            campId = urlParams.get('campId') || urlParams.get('camp_id');
            if (campId) {
                console.log(`🗑️ [getAuthInfo] Check 3c - URL params: ${campId}`);
            }
        }
        
        if (!campId) {
            // Try camps table (for owners)
            try {
                console.log(`🗑️ [getAuthInfo] Check 4 - Querying camps table for owner ${session.user.id}...`);
                const { data: ownerCamps, error } = await window.supabase
                    .from('camps')
                    .select('id')
                    .eq('owner', session.user.id)
                    .limit(1);
                if (error) {
                    console.log(`🗑️ [getAuthInfo] camps query error:`, error.message);
                } else if (ownerCamps?.length) {
                    campId = ownerCamps[0].id;
                    console.log(`🗑️ [getAuthInfo] Check 4 - Found camp: ${campId}`);
                } else {
                    console.log(`🗑️ [getAuthInfo] Check 4 - No camps found for owner`);
                }
            } catch (e) {
                console.log('🗑️ camps query failed:', e.message);
            }
        }
        
        if (!campId) {
            // Query team_members to find our camp (for schedulers/admins)
            try {
                console.log(`🗑️ [getAuthInfo] Check 5 - Querying team_members for user ${session.user.id}...`);
                const { data, error } = await window.supabase
                    .from('camp_users')
                    .select('camp_id')
                    .eq('user_id', session.user.id)
                    .limit(1);
                if (error) {
                    console.log(`🗑️ [getAuthInfo] team_members query error:`, error.message);
                } else if (data?.length) {
                    campId = data[0].camp_id;
                    console.log(`🗑️ [getAuthInfo] Check 5 - Found camp: ${campId}`);
                } else {
                    console.log(`🗑️ [getAuthInfo] Check 5 - No team_members found`);
                }
            } catch (e) {
                console.log('🗑️ team_members query failed:', e.message);
            }
        }
        
        // Cache for future use
        if (campId) {
            window._currentCampId = campId;
            localStorage.setItem('currentCampId', campId);
            console.log(`🗑️ [getAuthInfo] ✅ Camp ID found and cached: ${campId}`);
        } else {
            console.warn(`🗑️ [getAuthInfo] ❌ Could not find camp ID!`);
        }
        
        return { session, campId };
    }

    // =========================================================================
    // HELPER: Get User Role & Permissions
    // =========================================================================
    
    function isOwnerOrAdmin() {
        const ac = window.AccessControl;
        if (ac?.isInitialized) {
            const role = ac.getRole?.() || ac.role;
            return role === 'owner' || role === 'admin';
        }
        // Fallback
        return false;
    }
    
    function getUserEditableDivisions() {
        const ac = window.AccessControl;
        if (ac?.isInitialized && typeof ac.getEditableDivisions === 'function') {
            return ac.getEditableDivisions();
        }
        return [];
    }
    
    function getUserEditableBunks() {
        const divisions = getUserEditableDivisions();
        if (!divisions.length) return [];
        
        // Get all bunks for these divisions
        const bunks = [];
        const registry = window.GlobalAuthority?.getRegistry?.();
        
        if (registry?.bunks) {
            for (const [bunkId, bunk] of Object.entries(registry.bunks)) {
                if (divisions.includes(String(bunk.division))) {
                    bunks.push(String(bunkId));
                }
            }
        } else {
            // Fallback: Get from DOM or global bunks
            const allBunks = window.bunks || [];
            for (const bunk of allBunks) {
                if (divisions.includes(String(bunk.division))) {
                    bunks.push(String(bunk.id));
                }
            }
        }
        
        return bunks;
    }

    // =========================================================================
    // HELPER: Direct Cloud Modification (bypasses merge)
    // =========================================================================
    
    async function modifyCloudStateDirectly(modifierFn) {
        const authInfo = await getAuthInfo();
        if (!authInfo?.campId) {
            console.warn('🗑️ Cannot modify cloud: no camp ID');
            return false;
        }
        
        try {
            // Fetch current state
            const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${authInfo.campId}`, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${authInfo.session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                console.warn('🗑️ Failed to fetch cloud state');
                return false;
            }
            
            const rows = await response.json();
            if (!rows.length) {
                console.warn('🗑️ No cloud state found');
                return false;
            }
            
            const cloudState = rows[0].state || {};
            
            // Apply modification
            modifierFn(cloudState);
            
            // PATCH back
            const patchResponse = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${authInfo.campId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${authInfo.session.access_token}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({ state: cloudState })
            });
            
            if (patchResponse.ok) {
                console.log('🗑️ ✅ Cloud state modified directly');
                return true;
            } else {
                console.warn('🗑️ PATCH failed:', patchResponse.status);
                return false;
            }
            
        } catch (err) {
            console.error('🗑️ Cloud modification error:', err);
            return false;
        }
    }

    // =========================================================================
    // NEW: Delete Schedule Versions from Supabase
    // =========================================================================
    
    /**
     * Deletes schedule_versions records for a given date.
     * This prevents the VersionMerger from reconstructing deleted data.
     * 
     * @param {string} dateKey - The date (YYYY-MM-DD format)
     * @param {string[]} subdivisionIds - Optional: specific subdivisions to delete (for schedulers)
     * @param {boolean} deleteAll - If true, delete all versions for the date
     */
    async function deleteScheduleVersions(dateKey, subdivisionIds = null, deleteAll = false) {
        console.log(`🗑️ [deleteScheduleVersions] Starting for ${dateKey}, deleteAll=${deleteAll}`);
        
        const authInfo = await getAuthInfo();
        console.log(`🗑️ [deleteScheduleVersions] authInfo:`, {
            hasSession: !!authInfo?.session,
            campId: authInfo?.campId || 'NONE'
        });
        
        if (!authInfo?.campId) {
            console.warn('🗑️ Cannot delete versions: no camp ID found');
            return false;
        }
        
        try {
            console.log(`🗑️ Deleting schedule_versions for ${dateKey} from camp ${authInfo.campId}...`);
            
            // Build the query
            let url = `${SUPABASE_URL}/rest/v1/schedule_versions?camp_id=eq.${authInfo.campId}&schedule_date=eq.${dateKey}`;
            
            // If not deleting all, filter by subdivision_id
            if (!deleteAll && subdivisionIds && subdivisionIds.length > 0) {
                // Delete only versions for specific subdivisions
                url += `&subdivision_id=in.(${subdivisionIds.map(id => `"${id}"`).join(',')})`;
            }
            
            console.log(`🗑️ DELETE URL: ${url}`);
            
            const response = await fetch(url, {
                method: 'DELETE',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${authInfo.session.access_token}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                }
            });
            
            if (response.ok) {
                const deleted = await response.json();
                console.log(`🗑️ ✅ Deleted ${deleted.length} schedule_versions records`);
                return true;
            } else {
                const errText = await response.text();
                console.warn('🗑️ Failed to delete schedule_versions:', response.status, errText);
                return false;
            }
            
        } catch (err) {
            console.error('🗑️ schedule_versions deletion error:', err);
            return false;
        }
    }
    
    /**
     * Get the user's subdivision IDs for partial deletion
     */
    function getUserSubdivisionIds() {
        const ac = window.AccessControl;
        if (ac?.isInitialized) {
            return ac.userSubdivisionIds || [];
        }
        return [];
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
     * - Deletes schedule_versions to prevent VersionMerger reconstruction
     * - Suppresses sync during operation to prevent race conditions
     */
    async function patchedEraseCurrentDailyData() {
        const dateKey = window.currentScheduleDate;
        console.log(`🗑️ [PATCHED] Erasing schedule for ${dateKey}...`);
        
        const isOwner = isOwnerOrAdmin();
        const myDivisions = getUserEditableDivisions();
        const myBunks = getUserEditableBunks();
        const mySubdivisionIds = getUserSubdivisionIds();
        
        console.log(`🗑️ User role: ${isOwner ? 'owner/admin' : 'scheduler'}`);
        console.log(`🗑️ Editable divisions: ${myDivisions.join(', ') || 'ALL'}`);
        console.log(`🗑️ Subdivision IDs: ${mySubdivisionIds.join(', ') || 'ALL'}`);
        
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
            // ⭐ STEP 0: Delete schedule_versions FIRST to prevent VersionMerger reconstruction
            if (isOwner) {
                await deleteScheduleVersions(dateKey, null, true);
            } else {
                await deleteScheduleVersions(dateKey, mySubdivisionIds, false);
            }
            
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
     * Also clears ROOT-level legacy data and schedule_versions
     */
    async function patchedEraseAllDailyData() {
        // Only owners can delete all data
        if (!isOwnerOrAdmin()) {
            alert("Only owners/admins can delete all daily schedules.\n\nUse 'Erase Today' to delete your own schedule.");
            return;
        }
        
        if (!confirm("Delete ALL daily schedules for ALL dates?\n\nThis action cannot be undone.")) {
            return;
        }
        
        console.log('🗑️ [PATCHED] Erasing ALL daily schedules...');
        
        // ⭐ SUPPRESS SYNC
        window._suppressCloudSync = true;
        console.log('🗑️ Sync suppression ON');
        
        try {
            // ⭐ STEP 0: Delete ALL schedule_versions for this camp
            const authInfo = await getAuthInfo();
            if (authInfo?.campId) {
                try {
                    const url = `${SUPABASE_URL}/rest/v1/schedule_versions?camp_id=eq.${authInfo.campId}`;
                    const response = await fetch(url, {
                        method: 'DELETE',
                        headers: {
                            'apikey': SUPABASE_KEY,
                            'Authorization': `Bearer ${authInfo.session.access_token}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation'
                        }
                    });
                    if (response.ok) {
                        const deleted = await response.json();
                        console.log(`🗑️ ✅ Deleted ${deleted.length} total schedule_versions records`);
                    }
                } catch (err) {
                    console.warn('🗑️ Could not delete schedule_versions:', err);
                }
            }
            
            // 1. Clear localStorage
            const all = window.loadAllDailyData?.() || JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
            
            // Find all date keys
            const dateKeys = Object.keys(all).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key));
            
            for (const dateKey of dateKeys) {
                delete all[dateKey];
            }
            
            // Clear ROOT-level legacy data too
            delete all.scheduleAssignments;
            delete all.leagueAssignments;
            
            console.log(`🗑️ Cleared ${dateKeys.length} days and ROOT data from localStorage`);
            
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(all));
            
            // Clear in-memory
            window.scheduleAssignments = {};
            
            // 2. Clear from cloud
            const cloudSuccess = await modifyCloudStateDirectly((cloudState) => {
                cloudState.daily_schedules = {};
                delete cloudState.scheduleAssignments;
                delete cloudState.leagueAssignments;
                console.log('🗑️ Cleared all daily_schedules and ROOT data from cloud');
            });
            
            if (cloudSuccess) {
                console.log('🗑️ ✅ All schedules deleted from cloud');
            }
            
            // 3. Refresh UI
            window._cloudBlockedResources = null;
            window._cloudScheduleData = null;
            
            if (typeof window.updateTable === 'function') {
                window.updateTable();
            }
            
            console.log('🗑️ ✅ All daily schedules erased');
            
        } finally {
            setTimeout(() => {
                window._suppressCloudSync = false;
                console.log('🗑️ Sync suppression OFF');
            }, 2000);
        }
    }

    // =========================================================================
    // FIX 3: PATCHED saveCurrentDailyData (to avoid overwrite issues)
    // =========================================================================
    
    // This wraps the original to ensure proper division filtering
    function createSaveWrapper(originalSave) {
        return async function patchedSave() {
            if (window._suppressCloudSync) {
                console.log('🗑️ [SYNC INTERCEPTOR] Suppressing saveCurrentDailyData');
                return;
            }
            return originalSave.apply(this, arguments);
        };
    }

    // =========================================================================
    // FIX 4: Regenerate Button for Schedulers
    // =========================================================================
    
    /**
     * Adds a "Regenerate My Schedule" button for schedulers
     * This clears their divisions and allows fresh generation
     */
    async function regenerateMySchedule() {
        const dateKey = window.currentScheduleDate;
        const myDivisions = getUserEditableDivisions();
        const myBunks = getUserEditableBunks();
        const mySubdivisionIds = getUserSubdivisionIds();
        
        if (!myDivisions.length) {
            alert('You do not have any divisions assigned to regenerate.');
            return;
        }
        
        const confirmMsg = `Regenerate schedule for ${dateKey}?\n\n` +
            `This will clear your divisions (${myDivisions.join(', ')}) and generate fresh.\n\n` +
            `Other schedulers' work will be preserved.`;
        
        if (!confirm(confirmMsg)) return;
        
        console.log(`🔄 Regenerating schedule for divisions: ${myDivisions.join(', ')}`);
        
        // ⭐ SUPPRESS SYNC
        window._suppressCloudSync = true;
        console.log('🗑️ Sync suppression ON for regeneration');
        
        try {
            // Delete schedule versions for my subdivisions
            await deleteScheduleVersions(dateKey, mySubdivisionIds, false);
            
            // 1. Clear my data from localStorage
            const all = window.loadAllDailyData?.() || JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
            
            if (all[dateKey]?.scheduleAssignments) {
                for (const bunkId of myBunks) {
                    delete all[dateKey].scheduleAssignments[bunkId];
                }
                console.log(`🔄 Cleared ${myBunks.length} bunks from localStorage`);
            }
            
            // Clear subdivision status
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
            
            // Clear ROOT-level for my bunks
            if (all.scheduleAssignments) {
                for (const bunkId of myBunks) {
                    delete all.scheduleAssignments[bunkId];
                }
            }
            
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(all));
            
            // 2. Clear my data from cloud
            await modifyCloudStateDirectly((cloudState) => {
                if (!cloudState.daily_schedules?.[dateKey]) return;
                
                const dateData = cloudState.daily_schedules[dateKey];
                
                if (dateData.scheduleAssignments) {
                    for (const bunkId of myBunks) {
                        delete dateData.scheduleAssignments[bunkId];
                    }
                }
                
                // Clear subdivision status
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
                
                // Clear ROOT-level
                if (cloudState.scheduleAssignments) {
                    for (const bunkId of myBunks) {
                        delete cloudState.scheduleAssignments[bunkId];
                    }
                }
            });
            
            // Clear memory
            if (window.scheduleAssignments) {
                for (const bunkId of myBunks) {
                    delete window.scheduleAssignments[bunkId];
                }
            }
            window._cloudBlockedResources = null;
            window._cloudScheduleData = null;
            
            console.log('🔄 ✅ Data cleared, ready for regeneration');
            
            // Re-enable sync before regeneration
            window._suppressCloudSync = false;
            console.log('🗑️ Sync suppression OFF');
            
            // 3. Trigger the optimizer
            if (typeof window.runSkeletonOptimizer === 'function') {
                console.log('🔄 Running optimizer...');
                await window.runSkeletonOptimizer();
            } else if (typeof window.initMasterScheduler === 'function') {
                console.log('🔄 Running master scheduler...');
                await window.initMasterScheduler();
            } else {
                alert('Schedule cleared. Please click "Run Optimizer" to generate fresh schedule.');
            }
            
        } catch (err) {
            console.error('🔄 Regeneration error:', err);
            window._suppressCloudSync = false;
        }
    }

    // =========================================================================
    // INSTALLATION: Patch calendar.js functions
    // =========================================================================
    
    function patchCalendarFunctions() {
        console.log('🗑️ Patching calendar.js functions...');
        
        // Replace window functions
        if (typeof window.eraseCurrentDailyData === 'function') {
            window._originalEraseCurrentDailyData = window.eraseCurrentDailyData;
            window.eraseCurrentDailyData = patchedEraseCurrentDailyData;
            console.log('🗑️ ✅ Patched eraseCurrentDailyData');
        }
        
        if (typeof window.eraseAllDailyData === 'function') {
            window._originalEraseAllDailyData = window.eraseAllDailyData;
            window.eraseAllDailyData = patchedEraseAllDailyData;
            console.log('🗑️ ✅ Patched eraseAllDailyData');
        }
        
        console.log('🗑️ ✅ Calendar functions patched');
    }

    function hookEraseButtons() {
        // Hook the Erase Today button
        const eraseTodayBtn = document.getElementById('eraseTodayBtn');
        if (eraseTodayBtn) {
            // Remove existing onclick
            eraseTodayBtn.onclick = null;
            eraseTodayBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await patchedEraseCurrentDailyData();
            });
            console.log('🗑️ ✅ Hooked eraseTodayBtn');
        }
        
        // Hook the Erase All button
        const eraseAllBtn = document.getElementById('eraseAllSchedulesBtn');
        if (eraseAllBtn) {
            eraseAllBtn.onclick = null;
            eraseAllBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await patchedEraseAllDailyData();
            });
            console.log('🗑️ ✅ Hooked eraseAllSchedulesBtn');
        }
    }

    // =========================================================================
    // INSTALLATION: Hook cloud sync to respect suppression
    // =========================================================================
    
    function hookCloudSync() {
        // Intercept forceSyncToCloud
        if (typeof window.forceSyncToCloud === 'function') {
            const originalSync = window.forceSyncToCloud;
            window.forceSyncToCloud = async function(...args) {
                if (window._suppressCloudSync) {
                    console.log('🗑️ [SYNC INTERCEPTOR] Suppressing forceSyncToCloud');
                    return true; // Pretend success
                }
                return originalSync.apply(this, args);
            };
            console.log('🗑️ ✅ forceSyncToCloud interceptor installed');
        }
        
        // Intercept saveCurrentDailyData
        if (typeof window.saveCurrentDailyData === 'function') {
            const originalSave = window.saveCurrentDailyData;
            window.saveCurrentDailyData = async function(...args) {
                if (window._suppressCloudSync) {
                    console.log('🗑️ [SYNC INTERCEPTOR] Suppressing saveCurrentDailyData');
                    return;
                }
                return originalSave.apply(this, args);
            };
            console.log('🗑️ ✅ saveCurrentDailyData interceptor installed');
        }
    }

    // =========================================================================
    // UI: Add Regenerate Button
    // =========================================================================
    
    function addRegenerateButton() {
        // Only add for schedulers (non-owners)
        if (isOwnerOrAdmin()) {
            console.log('🔄 Owner/admin - regenerate button not needed');
            return;
        }
        
        // Find the toolbar or button container
        const toolbar = document.querySelector('.calendar-toolbar') || 
                       document.querySelector('#calendar-controls') ||
                       document.querySelector('.btn-group');
        
        if (!toolbar) {
            console.log('🔄 No toolbar found for regenerate button');
            return;
        }
        
        // Check if already added
        if (document.getElementById('regenerateScheduleBtn')) {
            return;
        }
        
        const btn = document.createElement('button');
        btn.id = 'regenerateScheduleBtn';
        btn.className = 'btn btn-warning btn-sm';
        btn.innerHTML = '🔄 Regenerate My Schedule';
        btn.title = 'Clear your schedule and generate fresh (preserves other schedulers)';
        btn.style.marginLeft = '5px';
        btn.onclick = regenerateMySchedule;
        
        toolbar.appendChild(btn);
        console.log('🔄 ✅ Added regenerate button');
    }

    // =========================================================================
    // INITIALIZE
    // =========================================================================
    
    function initialize() {
        console.log('🗑️ Initializing data management...');
        
        // Patch calendar functions
        patchCalendarFunctions();
        
        // Hook erase buttons
        hookEraseButtons();
        
        // Hook cloud sync
        hookCloudSync();
        
        // Export functions
        window.patchedEraseCurrentDailyData = patchedEraseCurrentDailyData;
        window.patchedEraseAllDailyData = patchedEraseAllDailyData;
        window.regenerateMySchedule = regenerateMySchedule;
        window.deleteScheduleVersions = deleteScheduleVersions;
        
        console.log('🗑️ ✅ Data management initialized');
    }

    // Run when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        // Small delay to ensure other scripts have loaded
        setTimeout(initialize, 100);
    }
    
    // Add regenerate button after RBAC init
    const checkForRBAC = setInterval(() => {
        const ac = window.AccessControl;
        if (ac?.isInitialized) {
            clearInterval(checkForRBAC);
            setTimeout(addRegenerateButton, 500);
        }
    }, 200);
    
    // Timeout after 10 seconds
    setTimeout(() => clearInterval(checkForRBAC), 10000);

    console.log("🗑️ Scheduler Data Management v2.2.1 loaded");

})();
