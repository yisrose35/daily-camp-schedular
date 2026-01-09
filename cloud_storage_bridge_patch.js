// ============================================================================
// cloud_storage_bridge_patch.js - Multi-Scheduler Merge Fix
// ============================================================================
// PATCH: Fixes the daily schedule merge logic to properly preserve
// other schedulers' work when saving to cloud.
//
// PROBLEM: Current merge logic in saveToCloud was:
// 1. Only merging at the division level (not bunk level)
// 2. Not properly identifying which divisions each scheduler owns
// 3. Overwriting entire daily_schedules instead of merging
//
// FIX: This patch replaces the merge logic to:
// 1. Load current cloud state
// 2. Identify "my" divisions vs "background" divisions
// 3. Only overwrite "my" divisions' bunk data
// 4. Preserve "background" divisions' bunk data exactly
// ============================================================================

(function() {
    'use strict';

    console.log('[CloudBridgePatch] Loading multi-scheduler merge fix...');

    const DAILY_DATA_KEY = "campDailyData_v1";

    // =========================================================================
    // HELPER: Get divisions I can edit
    // =========================================================================
    
    function getMyDivisions() {
        if (window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs && divs.length > 0) return divs;
        }
        
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs && divs.length > 0) return divs;
        }
        
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            return null; // null = all divisions
        }
        
        return [];
    }

    // =========================================================================
    // HELPER: Get bunks for a set of divisions
    // =========================================================================
    
    function getBunksForDivisions(divisionNames) {
        const divisions = window.divisions || {};
        const bunks = new Set();
        
        for (const divName of divisionNames) {
            const divInfo = divisions[divName];
            if (divInfo && divInfo.bunks) {
                divInfo.bunks.forEach(b => bunks.add(b));
            }
        }
        
        return bunks;
    }

    // =========================================================================
    // SMART MERGE: Merge daily schedules respecting division ownership
    // =========================================================================
    
    function smartMergeDailySchedules(localSchedules, cloudSchedules) {
        const myDivisions = getMyDivisions();
        const divisions = window.divisions || {};
        
        // Owner/Admin: Just use local data (overwrites everything)
        if (myDivisions === null) {
            console.log('[CloudBridgePatch] Owner mode: Using local schedules directly');
            return localSchedules;
        }
        
        // No divisions assigned: Can't save anything
        if (myDivisions.length === 0) {
            console.warn('[CloudBridgePatch] No editable divisions - returning cloud data unchanged');
            return cloudSchedules;
        }
        
        console.log('[CloudBridgePatch] 🔀 Smart merging schedules...');
        console.log(`[CloudBridgePatch]   My divisions: ${myDivisions.join(', ')}`);
        
        // Get my bunks
        const myBunks = getBunksForDivisions(myDivisions);
        console.log(`[CloudBridgePatch]   My bunks: ${myBunks.size}`);
        
        // Start with cloud data as base
        const merged = cloudSchedules ? JSON.parse(JSON.stringify(cloudSchedules)) : {};
        
        // For each date in local data
        for (const [dateKey, dateData] of Object.entries(localSchedules || {})) {
            // Ensure date entry exists
            if (!merged[dateKey]) {
                merged[dateKey] = {};
            }
            
            // If dateData has scheduleAssignments, merge at that level
            if (dateData.scheduleAssignments) {
                if (!merged[dateKey].scheduleAssignments) {
                    merged[dateKey].scheduleAssignments = {};
                }
                
                // Only overwrite MY bunks
                for (const [bunkName, bunkSchedule] of Object.entries(dateData.scheduleAssignments)) {
                    if (myBunks.has(bunkName)) {
                        merged[dateKey].scheduleAssignments[bunkName] = bunkSchedule;
                    }
                }
                
                // Copy other date-level properties
                for (const [key, value] of Object.entries(dateData)) {
                    if (key !== 'scheduleAssignments') {
                        merged[dateKey][key] = value;
                    }
                }
            } else {
                // Legacy format: dateData IS the scheduleAssignments
                for (const [bunkName, bunkSchedule] of Object.entries(dateData)) {
                    if (myBunks.has(bunkName)) {
                        merged[dateKey][bunkName] = bunkSchedule;
                    }
                }
            }
        }
        
        console.log('[CloudBridgePatch] ✅ Merge complete');
        return merged;
    }

    // =========================================================================
    // PATCH: Override scheduleCloudSync to use smart merge
    // =========================================================================
    
    const originalSaveToCloud = window.forceSyncToCloud || window.syncNow;
    
    async function patchedSaveToCloud() {
        console.log('[CloudBridgePatch] 🔄 Starting patched cloud save...');
        
        const role = window.AccessControl?.getCurrentRole?.();
        const isOwner = role === 'owner' || role === 'admin';
        
        // Owners don't need special merge
        if (isOwner) {
            console.log('[CloudBridgePatch] Owner mode - using standard save');
            if (originalSaveToCloud) {
                return originalSaveToCloud();
            }
            return;
        }
        
        // Team members need smart merge
        try {
            // 1. Load current cloud state
            const campId = window.getCampId?.();
            if (!campId || campId === 'demo_camp_001') {
                console.log('[CloudBridgePatch] No valid camp ID');
                return;
            }
            
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) {
                console.log('[CloudBridgePatch] No session');
                return;
            }
            
            // Load current cloud state
            const { data: cloudData } = await window.supabase
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();
            
            const cloudState = cloudData?.state || {};
            const cloudSchedules = cloudState.daily_schedules || {};
            
            // 2. Get local schedules
            let localSchedules = {};
            try {
                const raw = localStorage.getItem(DAILY_DATA_KEY);
                if (raw) localSchedules = JSON.parse(raw);
            } catch (e) {}
            
            // 3. Smart merge
            const mergedSchedules = smartMergeDailySchedules(localSchedules, cloudSchedules);
            
            // 4. Build full state to save
            const localState = window.loadGlobalSettings?.() || {};
            const stateToSave = {
                ...localState,
                daily_schedules: mergedSchedules,
                updated_at: new Date().toISOString()
            };
            
            // 5. Save to cloud
            console.log('[CloudBridgePatch] 💾 Saving merged state to cloud...');
            
            const { error } = await window.supabase
                .from('camp_state')
                .update({ state: stateToSave })
                .eq('camp_id', campId);
            
            if (error) {
                console.error('[CloudBridgePatch] Save error:', error);
                return false;
            }
            
            console.log('[CloudBridgePatch] ✅ Cloud save complete');
            return true;
            
        } catch (e) {
            console.error('[CloudBridgePatch] Error:', e);
            return false;
        }
    }

    // =========================================================================
    // INSTALL PATCH
    // =========================================================================
    
    function installPatch() {
        // Only install if we're a team member (not owner)
        const role = window.AccessControl?.getCurrentRole?.();
        
        if (role && role !== 'owner' && role !== 'admin') {
            console.log('[CloudBridgePatch] Installing smart merge for team member');
            
            // Patch forceSyncToCloud
            if (window.forceSyncToCloud) {
                window._originalForceSyncToCloud = window.forceSyncToCloud;
                window.forceSyncToCloud = patchedSaveToCloud;
            }
            
            // Patch syncNow
            if (window.syncNow) {
                window._originalSyncNow = window.syncNow;
                window.syncNow = patchedSaveToCloud;
            }
            
            console.log('[CloudBridgePatch] ✅ Patch installed');
        } else {
            console.log('[CloudBridgePatch] Owner mode - patch not needed');
        }
    }

    // Wait for AccessControl to be ready
    function waitAndInstall() {
        if (window.AccessControl?.isInitialized) {
            installPatch();
        } else {
            window.addEventListener('campistry-access-loaded', installPatch);
            // Fallback timeout
            setTimeout(() => {
                if (!window._cloudBridgePatchInstalled) {
                    installPatch();
                    window._cloudBridgePatchInstalled = true;
                }
            }, 3000);
        }
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitAndInstall);
    } else {
        setTimeout(waitAndInstall, 500);
    }

    // Export for debugging
    window.CloudBridgePatch = {
        smartMergeDailySchedules,
        getMyDivisions,
        getBunksForDivisions,
        patchedSaveToCloud,
        installPatch
    };

    console.log('[CloudBridgePatch] Loaded');

})();
