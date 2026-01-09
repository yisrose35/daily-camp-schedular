// ============================================================================
// scheduler_subdivision_integration.js (v2.2 - DEBUG LOGGING)
// ============================================================================
// CRITICAL FIX: Properly load and preserve schedules from other schedulers
//
// FLOW:
// 1. Before generation: Load existing schedules from cloud
// 2. Extract schedules for divisions we DON'T control (background)
// 3. Pass these as "locked" snapshot to optimizer
// 4. Optimizer restores them and registers field usage
// 5. Generate only for OUR divisions
// 6. Save merged result to cloud
// ============================================================================
(function() {
    'use strict';
    console.log('[SchedulerSubdivisionIntegration] Loading v2.2 (DEBUG)...');
    
    // =========================================================================
    // STORAGE KEYS
    // =========================================================================
    
    const DAILY_DATA_KEY = "campDailyData_v1";
    
    // =========================================================================
    // HELPERS
    // =========================================================================
    
    function getCurrentDate() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }
    
    function getMyEditableDivisions() {
        // Method 1: AccessControl (preferred)
        if (window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs && divs.length > 0) return divs;
        }
        
        // Method 2: SubdivisionScheduleManager
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs && divs.length > 0) return divs;
        }
        
        // Method 3: Owner gets all
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {});
        }
        
        return [];
    }
    
    function getBackgroundDivisions() {
        const all = Object.keys(window.divisions || {});
        const mine = new Set(getMyEditableDivisions());
        return all.filter(d => !mine.has(d));
    }
    
    function isOwnerOrAdmin() {
        const role = window.AccessControl?.getCurrentRole?.();
        return role === 'owner' || role === 'admin';
    }
    
    // =========================================================================
    // LOAD EXISTING SCHEDULES FROM CLOUD
    // =========================================================================
    
    async function loadSchedulesFromCloud() {
        console.log('[Integration] 📡 Loading existing schedules from cloud...');
        
        try {
            if (window.supabase && typeof window.getCampId === 'function') {
                const campId = window.getCampId();
                
                if (campId && campId !== 'demo_camp_001') {
                    const { data: { session } } = await window.supabase.auth.getSession();
                    
                    if (session) {
                        const { data, error } = await window.supabase
                            .from('camp_state')
                            .select('state')
                            .eq('camp_id', campId)
                            .single();
                        
                        if (!error && data?.state) {
                            console.log('[Integration] ✅ Loaded cloud state');
                            
                            // Extract daily schedules
                            if (data.state.daily_schedules) {
                                return data.state.daily_schedules;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Integration] Cloud load failed:', e.message);
        }
        
        // Fallback to localStorage
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) {
                console.log('[Integration] 📂 Using localStorage fallback');
                return JSON.parse(raw);
            }
        } catch (e) {}
        
        console.log('[Integration] ⚠️ No existing schedule data found');
        return {};
    }
    
    // =========================================================================
    // EXTRACT SNAPSHOT FOR BACKGROUND DIVISIONS
    // =========================================================================
    
    function extractBackgroundSnapshot(dailyData, backgroundDivisions, dateKey) {
        const snapshot = {};
        const divisions = window.divisions || {};
        const dateData = dailyData[dateKey];
        
        // ★★★ DEBUG: Show what we're working with ★★★
        console.log('[Integration] 🔍 DEBUG: Extraction starting...');
        console.log(`[Integration]   Date key: "${dateKey}"`);
        console.log(`[Integration]   Background divisions to find: [${backgroundDivisions.join(', ')}]`);
        console.log(`[Integration]   window.divisions keys: [${Object.keys(divisions).join(', ')}]`);
        
        // Show bunks per division
        for (const divKey of Object.keys(divisions)) {
            const divInfo = divisions[divKey];
            const bunkCount = divInfo?.bunks?.length || 0;
            const bunkSample = divInfo?.bunks?.slice(0, 3).join(', ') || 'none';
            console.log(`[Integration]   Division "${divKey}": ${bunkCount} bunks (${bunkSample}${bunkCount > 3 ? '...' : ''})`);
        }
        
        if (!dateData) {
            console.log(`[Integration] ⚠️ No data for date "${dateKey}"`);
            console.log(`[Integration]   Available dates: [${Object.keys(dailyData).slice(0, 5).join(', ')}...]`);
            return snapshot;
        }
        
        // Try both possible locations for schedule data
        const scheduleAssignments = dateData.scheduleAssignments || dateData;
        
        // ★★★ DEBUG: Show what's in the cloud data ★★★
        const allCloudBunks = Object.keys(scheduleAssignments).filter(k => 
            Array.isArray(scheduleAssignments[k]) && scheduleAssignments[k].length > 0
        );
        console.log(`[Integration]   Cloud has ${allCloudBunks.length} bunks with schedules`);
        console.log(`[Integration]   Sample cloud bunks: [${allCloudBunks.slice(0, 10).join(', ')}${allCloudBunks.length > 10 ? '...' : ''}]`);
        
        if (!scheduleAssignments || typeof scheduleAssignments !== 'object') {
            console.log('[Integration] ⚠️ No scheduleAssignments found');
            return snapshot;
        }
        
        let extractedBunks = 0;
        let extractedSlots = 0;
        
        // For each background division
        for (const divName of backgroundDivisions) {
            const divInfo = divisions[divName];
            
            // ★★★ DEBUG: Show division lookup ★★★
            if (!divInfo) {
                console.log(`[Integration]   ❌ Division "${divName}" NOT FOUND in window.divisions`);
                continue;
            }
            
            if (!divInfo.bunks || divInfo.bunks.length === 0) {
                console.log(`[Integration]   ❌ Division "${divName}" has NO bunks array`);
                continue;
            }
            
            console.log(`[Integration]   ✓ Division "${divName}" has ${divInfo.bunks.length} bunks`);
            
            // For each bunk in this division
            for (const bunkName of divInfo.bunks) {
                const bunkSchedule = scheduleAssignments[bunkName];
                
                if (bunkSchedule && Array.isArray(bunkSchedule)) {
                    // Deep copy to avoid mutations
                    snapshot[bunkName] = bunkSchedule.map(slot => 
                        slot ? { ...slot, _locked: true, _backgroundDivision: divName } : null
                    );
                    
                    const filledSlots = bunkSchedule.filter(Boolean).length;
                    extractedBunks++;
                    extractedSlots += filledSlots;
                    
                    console.log(`[Integration]   📋 ${bunkName} (${divName}): ${filledSlots} slots`);
                } else {
                    // ★★★ DEBUG: Show bunks not found ★★★
                    console.log(`[Integration]   ⚠️ Bunk "${bunkName}" (${divName}) not in cloud data`);
                }
            }
        }
        
        console.log(`[Integration] 📦 Extracted: ${extractedBunks} bunks, ${extractedSlots} total slots`);
        return snapshot;
    }
    
    // =========================================================================
    // FILTER SKELETON FOR MY DIVISIONS
    // =========================================================================
    
    function filterSkeletonForDivisions(skeleton, allowedDivisions) {
        if (!allowedDivisions || allowedDivisions.length === 0) {
            return skeleton;
        }
        
        const allowed = new Set(allowedDivisions);
        const original = skeleton.length;
        
        const filtered = skeleton.filter(item => {
            // Keep items without a division (global items)
            if (!item.division) return true;
            return allowed.has(item.division);
        });
        
        console.log(`[Integration] 🔍 Skeleton filtered: ${original} → ${filtered.length} items`);
        return filtered;
    }
    
    // =========================================================================
    // MAIN HOOK: Intercept schedule generation
    // =========================================================================
    
    let originalRunSkeletonOptimizer = null;
    
    async function multiSchedulerWrapper(manualSkeleton, externalOverrides) {
        console.log('\n' + '═'.repeat(70));
        console.log('★★★ MULTI-SCHEDULER INTEGRATION v2.2 (DEBUG) ★★★');
        console.log('═'.repeat(70));
        
        const dateKey = getCurrentDate();
        const myDivisions = getMyEditableDivisions();
        const backgroundDivisions = getBackgroundDivisions();
        const ownerMode = isOwnerOrAdmin();
        
        console.log(`[Integration] 📅 Date: ${dateKey}`);
        console.log(`[Integration] 🎯 My Divisions: ${myDivisions.join(', ') || 'ALL'}`);
        console.log(`[Integration] 🔒 Background Divisions: ${backgroundDivisions.join(', ') || 'NONE'}`);
        console.log(`[Integration] 👑 Owner/Admin Mode: ${ownerMode}`);
        
        // =====================================================================
        // STEP 1: Load existing schedules from cloud
        // =====================================================================
        let existingSnapshot = {};
        
        if (!ownerMode && backgroundDivisions.length > 0) {
            console.log('\n[Integration] STEP 1: Loading background schedules...');
            
            const dailyData = await loadSchedulesFromCloud();
            existingSnapshot = extractBackgroundSnapshot(dailyData, backgroundDivisions, dateKey);
            
            console.log(`[Integration] 📸 Background snapshot: ${Object.keys(existingSnapshot).length} bunks`);
        } else {
            console.log('\n[Integration] STEP 1: Owner mode - no background to preserve');
        }
        
        // =====================================================================
        // STEP 2: Filter skeleton for my divisions only
        // =====================================================================
        console.log('\n[Integration] STEP 2: Filtering skeleton...');
        
        const filteredSkeleton = ownerMode 
            ? manualSkeleton 
            : filterSkeletonForDivisions(manualSkeleton, myDivisions);
        
        // =====================================================================
        // STEP 3: Call original optimizer with snapshot
        // =====================================================================
        console.log('\n[Integration] STEP 3: Running optimizer...');
        console.log(`[Integration]   Skeleton items: ${filteredSkeleton.length}`);
        console.log(`[Integration]   Allowed divisions: ${myDivisions.join(', ') || 'ALL'}`);
        console.log(`[Integration]   Background bunks: ${Object.keys(existingSnapshot).length}`);
        
        // Pass to optimizer:
        // - Filtered skeleton
        // - External overrides
        // - Allowed divisions (null for owner = all)
        // - Existing snapshot (schedules to preserve)
        const allowedDivs = ownerMode ? null : myDivisions;
        const snapshot = Object.keys(existingSnapshot).length > 0 ? existingSnapshot : null;
        
        const result = originalRunSkeletonOptimizer.call(
            window,
            filteredSkeleton,
            externalOverrides,
            allowedDivs,
            snapshot
        );
        
        // =====================================================================
        // STEP 4: Trigger save
        // =====================================================================
        console.log('\n[Integration] STEP 4: Scheduling cloud sync...');
        
        if (typeof window.scheduleCloudSync === 'function') {
            window.scheduleCloudSync();
        }
        
        console.log('\n' + '═'.repeat(70));
        console.log('★★★ MULTI-SCHEDULER INTEGRATION COMPLETE ★★★');
        console.log('═'.repeat(70) + '\n');
        
        return result;
    }
    
    // =========================================================================
    // INSTALL HOOKS
    // =========================================================================
    
    function installHooks() {
        // Hook runSkeletonOptimizer
        if (window.runSkeletonOptimizer && !originalRunSkeletonOptimizer) {
            originalRunSkeletonOptimizer = window.runSkeletonOptimizer;
            
            window.runSkeletonOptimizer = function(manualSkeleton, externalOverrides, allowedDivisions, existingSnapshot) {
                // If called directly with all params, use original
                if (allowedDivisions !== undefined || existingSnapshot !== undefined) {
                    return originalRunSkeletonOptimizer.call(window, manualSkeleton, externalOverrides, allowedDivisions, existingSnapshot);
                }
                
                // Otherwise, wrap with multi-scheduler logic
                return multiSchedulerWrapper(manualSkeleton, externalOverrides);
            };
            
            console.log('[Integration] ✅ Hooked runSkeletonOptimizer');
        }
    }
    
    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    function initialize() {
        console.log('[Integration] Initializing...');
        
        // Wait for dependencies
        const checkDeps = setInterval(() => {
            if (window.runSkeletonOptimizer && window.AccessControl) {
                clearInterval(checkDeps);
                installHooks();
                console.log('[Integration] ✅ Ready');
            }
        }, 100);
        
        // Timeout after 10 seconds
        setTimeout(() => clearInterval(checkDeps), 10000);
    }
    
    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 100);
    }
    
    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.SchedulerSubdivisionIntegration = {
        initialize,
        getMyEditableDivisions,
        getBackgroundDivisions,
        loadSchedulesFromCloud,
        extractBackgroundSnapshot,
        filterSkeletonForDivisions
    };
    
    console.log('[SchedulerSubdivisionIntegration] Module loaded v2.2 (DEBUG)');
})();
