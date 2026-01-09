// ============================================================================
// multi_scheduler_coordinator.js - Cross-Scheduler Schedule Preservation
// ============================================================================
// VERSION 1.0 - Ensures schedulers respect each other's generated schedules
//
// PROBLEM SOLVED:
// When Scheduler A (divisions 1,2,3) generates, then Scheduler B (4,5,6) generates,
// Scheduler B must:
//   1. NOT touch divisions 1,2,3 at all
//   2. See what fields are already used by 1,2,3
//   3. Only fill in remaining slots (like a jigsaw puzzle)
//
// APPROACH:
// - Store schedule data keyed by division in daily_schedules
// - Before generation, load existing schedules from cloud
// - Extract "other division" schedules as locked background
// - Pass to optimizer as existingScheduleSnapshot
// - Register field usage so solver respects existing assignments
// ============================================================================

(function() {
    'use strict';

    console.log('[MultiSchedulerCoordinator] Loading v1.0...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const DAILY_DATA_KEY = "campDailyData_v1";
    const DEBUG = true;

    function debugLog(...args) {
        if (DEBUG) console.log('[MSC]', ...args);
    }

    // =========================================================================
    // CORE: Get divisions the current user CAN edit
    // =========================================================================
    
    function getMyDivisions() {
        // Method 1: From AccessControl (preferred)
        if (window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs && divs.length > 0) {
                debugLog('My divisions (from AccessControl):', divs);
                return divs;
            }
        }

        // Method 2: From SubdivisionScheduleManager
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs && divs.length > 0) {
                debugLog('My divisions (from SubdivisionScheduleManager):', divs);
                return divs;
            }
        }

        // Method 3: Owner gets all
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            const allDivs = Object.keys(window.divisions || {});
            debugLog('My divisions (owner - all):', allDivs);
            return allDivs;
        }

        debugLog('WARNING: Could not determine user divisions');
        return [];
    }

    // =========================================================================
    // CORE: Get ALL divisions (from global registry)
    // =========================================================================
    
    function getAllDivisions() {
        return Object.keys(window.divisions || {});
    }

    // =========================================================================
    // CORE: Get divisions I should NOT touch (background/locked)
    // =========================================================================
    
    function getBackgroundDivisions() {
        const all = getAllDivisions();
        const mine = new Set(getMyDivisions());
        const background = all.filter(d => !mine.has(d));
        debugLog('Background divisions (locked):', background);
        return background;
    }

    // =========================================================================
    // LOAD EXISTING SCHEDULES FROM CLOUD
    // =========================================================================
    
    async function loadExistingSchedulesFromCloud() {
        debugLog('Loading existing schedules from cloud...');
        
        try {
            // Try to get fresh data from cloud
            if (window.supabase && typeof window.getCampId === 'function') {
                const campId = window.getCampId();
                const { data: { session } } = await window.supabase.auth.getSession();
                
                if (session && campId && campId !== 'demo_camp_001') {
                    const { data, error } = await window.supabase
                        .from('camp_state')
                        .select('state')
                        .eq('camp_id', campId)
                        .single();
                    
                    if (!error && data?.state?.daily_schedules) {
                        debugLog('Loaded schedules from cloud');
                        return data.state.daily_schedules;
                    }
                }
            }
        } catch (e) {
            console.warn('[MSC] Cloud load error:', e);
        }
        
        // Fallback to localStorage
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) {
                debugLog('Loaded schedules from localStorage (fallback)');
                return JSON.parse(raw);
            }
        } catch (e) {
            console.warn('[MSC] LocalStorage load error:', e);
        }
        
        return {};
    }

    // =========================================================================
    // EXTRACT BUNK SCHEDULES FOR SPECIFIC DIVISIONS
    // =========================================================================
    
    function extractBunkSchedulesForDivisions(dailyData, divisionNames, dateKey) {
        const snapshot = {};
        const divisions = window.divisions || {};
        const dateData = dailyData[dateKey];
        
        if (!dateData || !dateData.scheduleAssignments) {
            debugLog(`No schedule data found for ${dateKey}`);
            return snapshot;
        }
        
        const scheduleAssignments = dateData.scheduleAssignments;
        const divisionSet = new Set(divisionNames);
        
        // For each division we want to extract
        for (const divName of divisionNames) {
            const divInfo = divisions[divName];
            if (!divInfo || !divInfo.bunks) continue;
            
            // For each bunk in this division
            for (const bunkName of divInfo.bunks) {
                if (scheduleAssignments[bunkName]) {
                    // Deep copy the schedule
                    snapshot[bunkName] = JSON.parse(JSON.stringify(scheduleAssignments[bunkName]));
                    debugLog(`  Extracted ${bunkName} (${divName}): ${snapshot[bunkName].filter(Boolean).length} slots`);
                }
            }
        }
        
        return snapshot;
    }

    // =========================================================================
    // GET LOCKED SCHEDULE SNAPSHOT (Main Entry Point)
    // =========================================================================
    
    async function getLockedScheduleSnapshot(dateKey) {
        debugLog('='.repeat(60));
        debugLog('BUILDING LOCKED SCHEDULE SNAPSHOT');
        debugLog('='.repeat(60));
        
        const backgroundDivisions = getBackgroundDivisions();
        
        if (backgroundDivisions.length === 0) {
            debugLog('No background divisions - snapshot is empty');
            return {};
        }
        
        debugLog('Background divisions to preserve:', backgroundDivisions);
        
        // Load existing schedules
        const dailyData = await loadExistingSchedulesFromCloud();
        
        // Extract bunk schedules for background divisions
        const snapshot = extractBunkSchedulesForDivisions(dailyData, backgroundDivisions, dateKey);
        
        const bunkCount = Object.keys(snapshot).length;
        const slotCount = Object.values(snapshot).reduce((sum, slots) => sum + (slots?.filter(Boolean).length || 0), 0);
        
        debugLog(`Snapshot built: ${bunkCount} bunks, ${slotCount} filled slots`);
        debugLog('='.repeat(60));
        
        return snapshot;
    }

    // =========================================================================
    // REGISTER FIELD USAGE FROM SNAPSHOT
    // =========================================================================
    
    function registerFieldUsageFromSnapshot(snapshot, fieldUsageBySlot, activityProperties) {
        debugLog('Registering field usage from snapshot...');
        
        const divisions = window.divisions || {};
        let registrations = 0;
        
        for (const [bunkName, slots] of Object.entries(snapshot)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            // Find division for this bunk
            const divName = Object.keys(divisions).find(d => divisions[d].bunks?.includes(bunkName));
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const slotData = slots[slotIdx];
                if (!slotData || !slotData.field) continue;
                
                const fieldName = slotData.field;
                const activityName = slotData._activity || fieldName;
                
                // Skip transitions
                if (fieldName === 'Transition/Buffer' || slotData._isTransition) continue;
                
                // Register in fieldUsageBySlot
                if (!fieldUsageBySlot[slotIdx]) {
                    fieldUsageBySlot[slotIdx] = {};
                }
                
                if (!fieldUsageBySlot[slotIdx][fieldName]) {
                    fieldUsageBySlot[slotIdx][fieldName] = {
                        count: 0,
                        divisions: [],
                        bunks: {},
                        _locked: true,
                        _fromSnapshot: true
                    };
                }
                
                const usage = fieldUsageBySlot[slotIdx][fieldName];
                usage.count++;
                usage.bunks[bunkName] = activityName;
                if (divName && !usage.divisions.includes(divName)) {
                    usage.divisions.push(divName);
                }
                
                // Also register in GlobalFieldLocks if at capacity
                if (window.GlobalFieldLocks && activityProperties) {
                    const props = activityProperties[fieldName] || {};
                    let maxCapacity = 1;
                    if (props.sharableWith?.capacity) {
                        maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                    } else if (props.sharable) {
                        maxCapacity = 2;
                    }
                    
                    if (usage.count >= maxCapacity) {
                        window.GlobalFieldLocks.lockField(fieldName, [slotIdx], {
                            lockedBy: 'background_schedule',
                            division: divName || 'unknown',
                            activity: `Scheduled: ${activityName}`
                        });
                    }
                }
                
                registrations++;
            }
        }
        
        debugLog(`Registered ${registrations} field usages from snapshot`);
    }

    // =========================================================================
    // RESTORE SNAPSHOT INTO SCHEDULE ASSIGNMENTS
    // =========================================================================
    
    function restoreSnapshotToAssignments(snapshot, scheduleAssignments) {
        debugLog('Restoring snapshot to scheduleAssignments...');
        
        let restored = 0;
        
        for (const [bunkName, slots] of Object.entries(snapshot)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            // Initialize bunk array if needed
            if (!scheduleAssignments[bunkName]) {
                scheduleAssignments[bunkName] = new Array(slots.length);
            }
            
            // Copy each slot
            for (let i = 0; i < slots.length; i++) {
                if (slots[i]) {
                    scheduleAssignments[bunkName][i] = {
                        ...slots[i],
                        _locked: true,
                        _fromBackgroundScheduler: true
                    };
                    restored++;
                }
            }
        }
        
        debugLog(`Restored ${restored} slot assignments`);
        return restored;
    }

    // =========================================================================
    // SAVE SCHEDULE BY DIVISION (After generation)
    // =========================================================================
    
    function saveScheduleByDivision(dateKey) {
        debugLog('Saving schedule data by division...');
        
        const scheduleAssignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const myDivisions = new Set(getMyDivisions());
        
        // Load existing daily data
        let dailyData = {};
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) dailyData = JSON.parse(raw);
        } catch (e) {}
        
        // Ensure date entry exists
        if (!dailyData[dateKey]) {
            dailyData[dateKey] = {};
        }
        
        // Merge new assignments with existing (only for MY divisions)
        const existingAssignments = dailyData[dateKey].scheduleAssignments || {};
        
        // Start with existing assignments
        const mergedAssignments = { ...existingAssignments };
        
        // Overwrite only MY divisions' bunks
        for (const divName of myDivisions) {
            const divInfo = divisions[divName];
            if (!divInfo || !divInfo.bunks) continue;
            
            for (const bunkName of divInfo.bunks) {
                if (scheduleAssignments[bunkName]) {
                    mergedAssignments[bunkName] = scheduleAssignments[bunkName];
                }
            }
        }
        
        dailyData[dateKey].scheduleAssignments = mergedAssignments;
        dailyData[dateKey].lastModified = new Date().toISOString();
        dailyData[dateKey].lastModifiedBy = window.AccessControl?.getCurrentUserInfo?.()?.email || 'unknown';
        
        // Save locally
        localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
        
        debugLog(`Saved schedules for ${myDivisions.size} divisions`);
        
        return dailyData;
    }

    // =========================================================================
    // FILTER SKELETON FOR MY DIVISIONS ONLY
    // =========================================================================
    
    function filterSkeletonForMyDivisions(skeleton) {
        const myDivisions = new Set(getMyDivisions());
        
        if (myDivisions.size === 0) {
            debugLog('WARNING: No divisions to filter for');
            return skeleton;
        }
        
        const filtered = skeleton.filter(item => {
            if (!item.division) return true; // Keep items without division
            return myDivisions.has(item.division);
        });
        
        debugLog(`Filtered skeleton: ${skeleton.length} -> ${filtered.length} items`);
        return filtered;
    }

    // =========================================================================
    // MAIN INTEGRATION: Wrap runSkeletonOptimizer
    // =========================================================================
    
    async function runMultiSchedulerGeneration(manualSkeleton, externalOverrides) {
        console.log('\n' + '█'.repeat(70));
        console.log('███ MULTI-SCHEDULER COORDINATOR - STARTING GENERATION ███');
        console.log('█'.repeat(70) + '\n');
        
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        debugLog('Date:', dateKey);
        
        const myDivisions = getMyDivisions();
        const backgroundDivisions = getBackgroundDivisions();
        const isOwner = window.AccessControl?.getCurrentRole?.() === 'owner' || 
                       window.AccessControl?.getCurrentRole?.() === 'admin';
        
        console.log('📋 My Divisions:', myDivisions.join(', ') || 'ALL');
        console.log('🔒 Background Divisions:', backgroundDivisions.join(', ') || 'NONE');
        console.log('👤 Is Owner/Admin:', isOwner);
        
        // Step 1: Get existing schedules from cloud (other schedulers' work)
        let existingSnapshot = {};
        
        if (!isOwner && backgroundDivisions.length > 0) {
            console.log('\n🔍 Loading existing schedules from cloud...');
            existingSnapshot = await getLockedScheduleSnapshot(dateKey);
            console.log(`📦 Loaded snapshot: ${Object.keys(existingSnapshot).length} bunks`);
        }
        
        // Step 2: Filter skeleton to only my divisions
        const filteredSkeleton = filterSkeletonForMyDivisions(manualSkeleton);
        
        // Step 3: Call the optimizer with:
        //   - Filtered skeleton (only my divisions)
        //   - allowedDivisions (my divisions)
        //   - existingSnapshot (other divisions' schedules to preserve)
        
        console.log('\n🚀 Calling optimizer...');
        console.log(`   Skeleton items: ${filteredSkeleton.length}`);
        console.log(`   Allowed divisions: ${myDivisions.join(', ')}`);
        console.log(`   Existing snapshot bunks: ${Object.keys(existingSnapshot).length}`);
        
        // Run the optimizer
        const result = window.runSkeletonOptimizer(
            filteredSkeleton,
            externalOverrides,
            myDivisions.length > 0 ? myDivisions : null,  // allowedDivisions
            Object.keys(existingSnapshot).length > 0 ? existingSnapshot : null  // existingScheduleSnapshot
        );
        
        // Step 4: Save the results (only my divisions)
        if (result) {
            console.log('\n💾 Saving generated schedules...');
            saveScheduleByDivision(dateKey);
            
            // Trigger cloud sync
            if (typeof window.scheduleCloudSync === 'function') {
                window.scheduleCloudSync();
            }
        }
        
        console.log('\n' + '█'.repeat(70));
        console.log('███ MULTI-SCHEDULER COORDINATOR - COMPLETE ███');
        console.log('█'.repeat(70) + '\n');
        
        return result;
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    const MultiSchedulerCoordinator = {
        // Main entry point
        runMultiSchedulerGeneration,
        
        // Utilities
        getMyDivisions,
        getAllDivisions,
        getBackgroundDivisions,
        getLockedScheduleSnapshot,
        
        // For integration
        registerFieldUsageFromSnapshot,
        restoreSnapshotToAssignments,
        saveScheduleByDivision,
        filterSkeletonForMyDivisions,
        loadExistingSchedulesFromCloud
    };
    
    window.MultiSchedulerCoordinator = MultiSchedulerCoordinator;
    
    console.log('[MultiSchedulerCoordinator] Loaded v1.0');
    
})();
