// =============================================================================
// scheduler_cloud_fetch.js — Real-Time Cloud Fetch for Multi-Scheduler Blocking
// VERSION: v1.0.0
// =============================================================================
//
// PURPOSE:
// When Scheduler 2 opens the scheduling view, this module fetches Scheduler 1's
// COMMITTED data from the cloud and returns a "blocked resources" map.
//
// CRITICAL REQUIREMENT A: Resource Locking
// - Fetch other schedulers' saved schedules from Supabase
// - Build a slot-by-slot map of what's already claimed
// - Provide this to the UI so those slots appear "blocked"
//
// =============================================================================

(function() {
    'use strict';

    console.log("☁️ Scheduler Cloud Fetch v1.0.0 loading...");

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
    const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
    const TABLE = "camp_state";
    
    // =========================================================================
    // CORE: Fetch Fresh Schedule from Cloud
    // =========================================================================
    
    /**
     * Fetches the LATEST schedule data directly from Supabase
     * This bypasses localStorage to ensure we get other schedulers' commits
     * 
     * @param {string} dateKey - The date to fetch (YYYY-MM-DD)
     * @returns {Promise<Object>} - { scheduleAssignments, subdivisionSchedules, fieldUsageClaims }
     */
    async function fetchScheduleFromCloud(dateKey) {
        console.log(`☁️ [CloudFetch] Fetching fresh data for ${dateKey}...`);
        
        try {
            // 1. Get auth token
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) {
                console.warn('☁️ [CloudFetch] No active session');
                return null;
            }
            
            // 2. Get camp ID
            const campId = window.getCampId?.() || localStorage.getItem('campistry_user_id');
            if (!campId || campId === 'demo_camp_001') {
                console.warn('☁️ [CloudFetch] No valid camp ID');
                return null;
            }
            
            // 3. Fetch from Supabase REST API (bypasses any caching)
            const url = `${SUPABASE_URL}/rest/v1/${TABLE}?camp_id=eq.${campId}&select=state`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            });
            
            if (!response.ok) {
                console.error('☁️ [CloudFetch] HTTP error:', response.status);
                return null;
            }
            
            const data = await response.json();
            
            if (!data || data.length === 0) {
                console.log('☁️ [CloudFetch] No cloud data found');
                return null;
            }
            
            const state = data[0].state;
            const dailySchedules = state?.daily_schedules || {};
            const dateData = dailySchedules[dateKey] || {};
            
            console.log(`☁️ [CloudFetch] Retrieved data for ${dateKey}:`, {
                hasDailySchedules: !!dailySchedules[dateKey],
                bunkCount: Object.keys(dateData.scheduleAssignments || {}).length,
                subdivisionCount: Object.keys(dateData.subdivisionSchedules || {}).length
            });
            
            return {
                scheduleAssignments: dateData.scheduleAssignments || {},
                subdivisionSchedules: dateData.subdivisionSchedules || {},
                leagueAssignments: dateData.leagueAssignments || {},
                unifiedTimes: dateData.unifiedTimes || [],
                skeleton: dateData.skeleton || dateData.manualSkeleton || [],
                _fetchedAt: Date.now(),
                _fromCloud: true
            };
            
        } catch (error) {
            console.error('☁️ [CloudFetch] Error:', error);
            return null;
        }
    }
    
    // =========================================================================
    // CORE: Build Blocked Resources Map
    // =========================================================================
    
    /**
     * Analyzes cloud data and builds a map of blocked resources
     * This tells Scheduler 2 what Scheduler 1 has already claimed
     * 
     * @param {Object} cloudData - Data from fetchScheduleFromCloud()
     * @param {string[]} myDivisions - Divisions the current user CAN edit
     * @returns {Object} - BlockedResourcesMap
     */
    function buildBlockedResourcesMap(cloudData, myDivisions) {
        console.log('☁️ [CloudFetch] Building blocked resources map...');
        console.log('☁️ [CloudFetch] My divisions:', myDivisions);
        
        const blocked = {
            // Map of slotIndex -> fieldName -> { count, claimedBy, maxCapacity, isBlocked }
            bySlotField: {},
            // Map of bunkId -> slotIndex -> claimInfo
            byBunkSlot: {},
            // Summary stats
            stats: {
                totalBlockedSlots: 0,
                totalBlockedFields: 0,
                blockedBySubdivision: {}
            }
        };
        
        if (!cloudData) {
            console.log('☁️ [CloudFetch] No cloud data to analyze');
            return blocked;
        }
        
        const myDivisionsSet = new Set(myDivisions || []);
        const allDivisions = window.divisions || {};
        
        // Build set of MY bunks (bunks I'm allowed to edit)
        const myBunks = new Set();
        for (const divName of myDivisions || []) {
            const divInfo = allDivisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => myBunks.add(b));
            }
        }
        
        // Process scheduleAssignments to find OTHER schedulers' claims
        const assignments = cloudData.scheduleAssignments || {};
        
        for (const [bunkId, slots] of Object.entries(assignments)) {
            // Skip if this is MY bunk
            if (myBunks.has(bunkId)) {
                continue;
            }
            
            // Find which division this bunk belongs to
            let bunkDivision = null;
            for (const [divName, divInfo] of Object.entries(allDivisions)) {
                if (divInfo.bunks?.includes(bunkId)) {
                    bunkDivision = divName;
                    break;
                }
            }
            
            // Skip if I own this division
            if (bunkDivision && myDivisionsSet.has(bunkDivision)) {
                continue;
            }
            
            // This bunk belongs to ANOTHER scheduler - record their claims
            if (!Array.isArray(slots)) continue;
            
            slots.forEach((slotData, slotIndex) => {
                if (!slotData || slotData.continuation) return;
                
                const fieldName = slotData.field || slotData._activity;
                if (!fieldName || fieldName === 'Free' || fieldName === 'free') return;
                if (fieldName === 'Transition/Buffer' || slotData._isTransition) return;
                
                // Record in bySlotField
                if (!blocked.bySlotField[slotIndex]) {
                    blocked.bySlotField[slotIndex] = {};
                }
                
                if (!blocked.bySlotField[slotIndex][fieldName]) {
                    const capacity = getFieldCapacity(fieldName);
                    blocked.bySlotField[slotIndex][fieldName] = {
                        count: 0,
                        maxCapacity: capacity,
                        claimedBy: [],
                        bunks: [],
                        isBlocked: false
                    };
                }
                
                const record = blocked.bySlotField[slotIndex][fieldName];
                record.count++;
                record.bunks.push(bunkId);
                
                if (bunkDivision && !record.claimedBy.includes(bunkDivision)) {
                    record.claimedBy.push(bunkDivision);
                }
                
                // Mark as blocked if at or over capacity
                if (record.count >= record.maxCapacity) {
                    record.isBlocked = true;
                    blocked.stats.totalBlockedSlots++;
                }
                
                // Record in byBunkSlot
                if (!blocked.byBunkSlot[bunkId]) {
                    blocked.byBunkSlot[bunkId] = {};
                }
                blocked.byBunkSlot[bunkId][slotIndex] = {
                    fieldName,
                    division: bunkDivision,
                    slotData: slotData
                };
            });
        }
        
        // Count unique blocked fields
        const blockedFieldSet = new Set();
        for (const slotFields of Object.values(blocked.bySlotField)) {
            for (const [fieldName, info] of Object.entries(slotFields)) {
                if (info.isBlocked) {
                    blockedFieldSet.add(`${fieldName}`);
                }
            }
        }
        blocked.stats.totalBlockedFields = blockedFieldSet.size;
        
        console.log('☁️ [CloudFetch] Blocked resources map built:', blocked.stats);
        
        return blocked;
    }
    
    /**
     * Get field capacity from activity properties
     */
    function getFieldCapacity(fieldName) {
        const props = window.activityProperties?.[fieldName] || {};
        
        if (props.sharableWith?.capacity) {
            return parseInt(props.sharableWith.capacity) || 1;
        }
        if (props.sharable || props.sharableWith?.type === 'all') {
            return 2;
        }
        return 1;
    }
    
    // =========================================================================
    // CORE: Check if Resource is Available
    // =========================================================================
    
    /**
     * Check if a specific field at a specific slot is available
     * This is called by drag-drop handlers to validate moves
     * 
     * @param {string} fieldName - The field/resource to check
     * @param {number} slotIndex - The time slot index
     * @param {Object} blockedMap - From buildBlockedResourcesMap()
     * @returns {Object} - { available, reason, claimedBy, remainingCapacity }
     */
    function isResourceAvailable(fieldName, slotIndex, blockedMap) {
        if (!blockedMap || !blockedMap.bySlotField) {
            return { available: true, reason: null };
        }
        
        const slotData = blockedMap.bySlotField[slotIndex];
        if (!slotData) {
            return { available: true, reason: null };
        }
        
        const fieldData = slotData[fieldName];
        if (!fieldData) {
            return { available: true, reason: null };
        }
        
        if (fieldData.isBlocked) {
            return {
                available: false,
                reason: `Already booked by ${fieldData.claimedBy.join(', ')}`,
                claimedBy: fieldData.claimedBy,
                remainingCapacity: 0,
                currentUsage: fieldData.count,
                maxCapacity: fieldData.maxCapacity
            };
        }
        
        return {
            available: true,
            reason: null,
            remainingCapacity: fieldData.maxCapacity - fieldData.count,
            currentUsage: fieldData.count,
            maxCapacity: fieldData.maxCapacity
        };
    }
    
    /**
     * Check availability for a range of slots (for multi-slot activities)
     * 
     * @param {string} fieldName 
     * @param {number[]} slotIndices - Array of slot indices
     * @param {Object} blockedMap 
     * @returns {Object}
     */
    function isResourceAvailableForRange(fieldName, slotIndices, blockedMap) {
        const results = slotIndices.map(idx => ({
            slotIndex: idx,
            ...isResourceAvailable(fieldName, idx, blockedMap)
        }));
        
        const blocked = results.filter(r => !r.available);
        
        return {
            available: blocked.length === 0,
            blockedSlots: blocked,
            allResults: results
        };
    }
    
    // =========================================================================
    // INTEGRATION: Main Initialization Function
    // =========================================================================
    
    /**
     * Main function called when Scheduler 2 opens the scheduling view
     * Fetches cloud data, builds blocked map, and stores it globally
     * 
     * @param {string} dateKey - Date to fetch
     * @returns {Promise<Object>} - { cloudData, blockedMap, myDivisions }
     */
    async function initializeSchedulerView(dateKey) {
        console.log('\n' + '═'.repeat(60));
        console.log('☁️ INITIALIZING SCHEDULER VIEW WITH CLOUD BLOCKING');
        console.log('═'.repeat(60));
        
        const result = {
            cloudData: null,
            blockedMap: null,
            myDivisions: [],
            success: false
        };
        
        try {
            // 1. Determine current user's divisions
            result.myDivisions = getUserDivisions();
            console.log('☁️ My divisions:', result.myDivisions);
            
            // 2. Fetch fresh data from cloud
            result.cloudData = await fetchScheduleFromCloud(dateKey);
            
            if (!result.cloudData) {
                console.log('☁️ No cloud data - this may be the first schedule');
                result.blockedMap = { bySlotField: {}, byBunkSlot: {}, stats: {} };
                result.success = true;
                return result;
            }
            
            // 3. Build blocked resources map
            result.blockedMap = buildBlockedResourcesMap(result.cloudData, result.myDivisions);
            
            // 4. Store globally for UI access
            window._cloudBlockedResources = result.blockedMap;
            window._cloudScheduleData = result.cloudData;
            
            // 5. Register blocks in GlobalFieldLocks if available
            if (window.GlobalFieldLocks) {
                registerBlocksInGlobalFieldLocks(result.blockedMap);
            }
            
            // 6. Dispatch event for UI to update
            window.dispatchEvent(new CustomEvent('campistry-blocked-resources-ready', {
                detail: result
            }));
            
            result.success = true;
            console.log('☁️ Scheduler view initialized successfully');
            console.log('═'.repeat(60) + '\n');
            
        } catch (error) {
            console.error('☁️ Initialization failed:', error);
            result.error = error.message;
        }
        
        return result;
    }
    
    /**
     * Get user's editable divisions
     */
    function getUserDivisions() {
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
        
        // Method 3: Owner gets all
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {});
        }
        
        return [];
    }
    
    /**
     * Register blocked resources in GlobalFieldLocks
     */
    function registerBlocksInGlobalFieldLocks(blockedMap) {
        if (!window.GlobalFieldLocks) return;
        
        console.log('☁️ Registering blocks in GlobalFieldLocks...');
        let count = 0;
        
        for (const [slotIndex, fields] of Object.entries(blockedMap.bySlotField)) {
            for (const [fieldName, info] of Object.entries(fields)) {
                if (info.isBlocked) {
                    window.GlobalFieldLocks.lockField(fieldName, [parseInt(slotIndex)], {
                        lockedBy: 'other_scheduler',
                        activity: `Claimed by: ${info.claimedBy.join(', ')}`,
                        division: info.claimedBy[0] || 'external'
                    });
                    count++;
                }
            }
        }
        
        console.log(`☁️ Registered ${count} field locks`);
    }
    
    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.SchedulerCloudFetch = {
        // Core functions
        fetchScheduleFromCloud,
        buildBlockedResourcesMap,
        initializeSchedulerView,
        
        // Availability checks
        isResourceAvailable,
        isResourceAvailableForRange,
        
        // Utilities
        getFieldCapacity,
        getUserDivisions,
        
        // Access cached data
        getBlockedMap: () => window._cloudBlockedResources,
        getCloudData: () => window._cloudScheduleData
    };
    
    // Also expose for global access
    window.fetchScheduleFromCloud = fetchScheduleFromCloud;
    
    console.log("☁️ Scheduler Cloud Fetch v1.0.0 loaded");

})();
