// =============================================================================
// schedule_merge_engine.js — Unified Schedule Merge Engine
// VERSION: v1.0.0
// =============================================================================
//
// CRITICAL REQUIREMENT B: The Merge
// When Scheduler 2 saves, the system must generate a "Unified Schedule" view
// that combines both datasets into a single master schedule.
//
// MERGE STRATEGY:
// 1. On-the-fly merge for VIEWING (no storage overhead)
// 2. Optional server-side merge for OFFICIAL records
// 3. Conflict detection with multiple resolution strategies
//
// =============================================================================

(function() {
    'use strict';

    console.log("🔀 Schedule Merge Engine v1.0.0 loading...");

    // =========================================================================
    // CONSTANTS
    // =========================================================================
    
    const RESOLUTION_STRATEGIES = {
        FIRST_COME: 'first_come',       // Earlier save wins
        LAST_COME: 'last_come',         // Later save wins
        PRIORITY: 'priority',           // Locked > Draft
        CAPACITY_SHARE: 'capacity_share', // Both if capacity allows
        MANUAL: 'manual'                // Flag for human decision
    };
    
    const CONFLICT_TYPES = {
        FIELD_DOUBLE_BOOK: 'field_double_book',
        CAPACITY_EXCEEDED: 'capacity_exceeded',
        BUNK_COLLISION: 'bunk_collision'
    };

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================
    
    function generateId(prefix = 'id') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    }
    
    function deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }
    
    function getFieldCapacity(fieldName) {
        const props = window.activityProperties?.[fieldName] || {};
        if (props.sharableWith?.capacity) return parseInt(props.sharableWith.capacity) || 1;
        if (props.sharable) return 2;
        return 1;
    }
    
    function isMetadataKey(key) {
        return ['scheduleAssignments', 'leagueAssignments', 'unifiedTimes', 
                'skeleton', 'manualSkeleton', 'subdivisionSchedules',
                '_basedOn', '_mergeInfo'].includes(key);
    }

    // =========================================================================
    // CORE: EXTRACT CLAIMS FROM SOURCES
    // =========================================================================
    
    /**
     * Extract all field claims from schedule data
     * @param {Object} scheduleData - { scheduleAssignments, subdivisionSchedules }
     * @param {Object} metadata - Source information
     * @returns {Array} - Array of claim objects
     */
    function extractClaims(scheduleData, metadata = {}) {
        const claims = [];
        const assignments = scheduleData?.scheduleAssignments || scheduleData;
        
        if (!assignments || typeof assignments !== 'object') return claims;
        
        const allDivisions = window.divisions || {};
        
        for (const [bunkId, slots] of Object.entries(assignments)) {
            if (isMetadataKey(bunkId)) continue;
            if (!Array.isArray(slots)) continue;
            
            // Find which division this bunk belongs to
            let bunkDivision = null;
            let subdivisionId = null;
            
            for (const [divName, divInfo] of Object.entries(allDivisions)) {
                if (divInfo.bunks?.includes(bunkId)) {
                    bunkDivision = divName;
                    break;
                }
            }
            
            // Check subdivisions for scheduler info
            if (scheduleData?.subdivisionSchedules) {
                for (const [subId, subData] of Object.entries(scheduleData.subdivisionSchedules)) {
                    if (subData.divisions?.includes(bunkDivision)) {
                        subdivisionId = subId;
                        break;
                    }
                }
            }
            
            slots.forEach((slotData, slotIndex) => {
                if (!slotData || slotData.continuation) return;
                
                const fieldName = slotData.field || slotData._activity;
                if (!fieldName || fieldName === 'Free' || fieldName === 'free') return;
                if (fieldName === 'Transition/Buffer' || slotData._isTransition) return;
                
                claims.push({
                    claimId: generateId('claim'),
                    bunkId,
                    slotIndex,
                    fieldName,
                    slotData: deepClone(slotData),
                    bunkDivision,
                    subdivisionId,
                    schedulerName: slotData._mergedFrom?.schedulerName || 
                                  metadata.schedulerName || 'Unknown',
                    timestamp: slotData._mergedFrom?.originalTimestamp || 
                              slotData._timestamp || 
                              metadata.timestamp || Date.now(),
                    priority: slotData._locked ? 0 : 1,
                    status: slotData._locked ? 'locked' : 'draft',
                    source: metadata.source || 'unknown'
                });
            });
        }
        
        return claims;
    }

    // =========================================================================
    // CORE: CONFLICT DETECTION
    // =========================================================================
    
    /**
     * Detect conflicts between claims
     * @param {Array} claims - All claims to analyze
     * @returns {Array} - Array of conflict objects
     */
    function detectConflicts(claims) {
        const conflicts = [];
        
        // Group claims by slot + field
        const bySlotField = {};
        
        for (const claim of claims) {
            const key = `${claim.slotIndex}:${claim.fieldName.toLowerCase()}`;
            if (!bySlotField[key]) bySlotField[key] = [];
            bySlotField[key].push(claim);
        }
        
        // Check each group
        for (const [key, groupClaims] of Object.entries(bySlotField)) {
            if (groupClaims.length <= 1) continue;
            
            const fieldName = groupClaims[0].fieldName;
            const slotIndex = groupClaims[0].slotIndex;
            const capacity = getFieldCapacity(fieldName);
            
            // Count unique subdivisions/sources
            const uniqueSources = new Set(groupClaims.map(c => c.subdivisionId || c.source));
            
            if (uniqueSources.size > capacity) {
                conflicts.push({
                    id: generateId('conflict'),
                    type: CONFLICT_TYPES.CAPACITY_EXCEEDED,
                    slotIndex,
                    fieldName,
                    capacity,
                    claimCount: uniqueSources.size,
                    claims: groupClaims,
                    resolution: null,
                    strategy: null
                });
            }
        }
        
        // Check for bunk collisions (same bunk, same slot, different fields)
        const byBunkSlot = {};
        
        for (const claim of claims) {
            const key = `${claim.bunkId}:${claim.slotIndex}`;
            if (!byBunkSlot[key]) byBunkSlot[key] = [];
            byBunkSlot[key].push(claim);
        }
        
        for (const [key, groupClaims] of Object.entries(byBunkSlot)) {
            if (groupClaims.length <= 1) continue;
            
            const uniqueFields = new Set(groupClaims.map(c => c.fieldName.toLowerCase()));
            
            if (uniqueFields.size > 1) {
                conflicts.push({
                    id: generateId('conflict'),
                    type: CONFLICT_TYPES.BUNK_COLLISION,
                    bunkId: groupClaims[0].bunkId,
                    slotIndex: groupClaims[0].slotIndex,
                    fields: [...uniqueFields],
                    claims: groupClaims,
                    resolution: null,
                    strategy: null
                });
            }
        }
        
        console.log(`🔀 Detected ${conflicts.length} conflicts`);
        return conflicts;
    }

    // =========================================================================
    // CORE: CONFLICT RESOLUTION
    // =========================================================================
    
    /**
     * Auto-resolve conflicts using specified strategy
     */
    function resolveConflicts(conflicts, strategy = RESOLUTION_STRATEGIES.PRIORITY) {
        const resolved = [];
        
        for (const conflict of conflicts) {
            const resolvedConflict = { ...conflict };
            
            if (conflict.resolution) {
                resolved.push(resolvedConflict);
                continue;
            }
            
            let winner = null;
            const claims = conflict.claims;
            
            switch (strategy) {
                case RESOLUTION_STRATEGIES.FIRST_COME:
                    winner = claims.reduce((earliest, c) => 
                        (!earliest || c.timestamp < earliest.timestamp) ? c : earliest, null);
                    break;
                    
                case RESOLUTION_STRATEGIES.LAST_COME:
                    winner = claims.reduce((latest, c) => 
                        (!latest || c.timestamp > latest.timestamp) ? c : latest, null);
                    break;
                    
                case RESOLUTION_STRATEGIES.PRIORITY:
                    // Locked (priority 0) beats draft (priority 1)
                    winner = claims.reduce((highest, c) => 
                        (!highest || c.priority < highest.priority) ? c : highest, null);
                    break;
                    
                case RESOLUTION_STRATEGIES.CAPACITY_SHARE:
                    // Allow multiple winners up to capacity
                    const sorted = [...claims].sort((a, b) => a.timestamp - b.timestamp);
                    const capacity = conflict.capacity || 1;
                    
                    resolvedConflict.winners = sorted.slice(0, capacity).map(c => c.claimId);
                    resolvedConflict.losers = sorted.slice(capacity).map(c => c.claimId);
                    resolvedConflict.resolution = resolvedConflict.winners[0];
                    resolvedConflict.strategy = strategy;
                    resolved.push(resolvedConflict);
                    continue;
                    
                default:
                    resolved.push(resolvedConflict);
                    continue;
            }
            
            if (winner) {
                resolvedConflict.resolution = winner.claimId;
                resolvedConflict.winners = [winner.claimId];
                resolvedConflict.losers = claims
                    .filter(c => c.claimId !== winner.claimId)
                    .map(c => c.claimId);
                resolvedConflict.strategy = strategy;
            }
            
            resolved.push(resolvedConflict);
        }
        
        return resolved;
    }

    // =========================================================================
    // CORE: BUILD UNIFIED SCHEDULE
    // =========================================================================
    
    /**
     * Build the final merged schedule from claims and resolutions
     */
    function buildUnifiedSchedule(claims, conflicts) {
        const unified = {
            scheduleAssignments: {},
            _mergeInfo: {
                mergedAt: Date.now(),
                mergedBy: window.AccessControl?.getCurrentUserInfo?.()?.email || 'system',
                claimCount: claims.length,
                conflictCount: conflicts.length
            }
        };
        
        // Build set of losing claim IDs
        const losingIds = new Set();
        for (const conflict of conflicts) {
            (conflict.losers || []).forEach(id => losingIds.add(id));
        }
        
        // Apply all winning claims
        for (const claim of claims) {
            if (losingIds.has(claim.claimId)) {
                console.log(`🔀 Skipping losing claim: ${claim.bunkId}[${claim.slotIndex}] (${claim.fieldName})`);
                continue;
            }
            
            const bunkId = claim.bunkId;
            if (!unified.scheduleAssignments[bunkId]) {
                unified.scheduleAssignments[bunkId] = [];
            }
            
            unified.scheduleAssignments[bunkId][claim.slotIndex] = {
                ...claim.slotData,
                _unifiedFrom: {
                    claimId: claim.claimId,
                    source: claim.source,
                    subdivisionId: claim.subdivisionId,
                    schedulerName: claim.schedulerName,
                    originalTimestamp: claim.timestamp
                }
            };
        }
        
        return unified;
    }

    // =========================================================================
    // MAIN: EXECUTE MERGE
    // =========================================================================
    
    /**
     * Execute a full merge operation
     */
    async function executeMerge(options = {}) {
        const {
            dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0],
            localData = null,
            cloudData = null,
            strategy = RESOLUTION_STRATEGIES.PRIORITY,
            preview = false
        } = options;
        
        console.log('\n' + '═'.repeat(70));
        console.log('🔀 SCHEDULE MERGE ENGINE - STARTING MERGE');
        console.log('═'.repeat(70));
        console.log(`Date: ${dateKey}`);
        console.log(`Strategy: ${strategy}`);
        console.log(`Preview: ${preview}`);
        
        const result = {
            success: false,
            unifiedSchedule: null,
            conflicts: [],
            unresolvedConflicts: [],
            auditLog: null,
            stats: {
                localClaims: 0,
                cloudClaims: 0,
                totalClaims: 0,
                conflicts: 0,
                resolved: 0,
                unresolved: 0,
                mergedBunks: 0,
                mergedSlots: 0
            }
        };
        
        try {
            // Step 1: Get data sources
            let local = localData;
            let cloud = cloudData;
            
            if (!local) {
                const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                local = dailyData[dateKey] || {};
            }
            
            if (!cloud && window.SchedulerCloudFetch?.fetchScheduleFromCloud) {
                cloud = await window.SchedulerCloudFetch.fetchScheduleFromCloud(dateKey);
            }
            
            console.log('🔀 Step 1: Data sources loaded');
            console.log(`   Local: ${Object.keys(local?.scheduleAssignments || {}).length} bunks`);
            console.log(`   Cloud: ${Object.keys(cloud?.scheduleAssignments || {}).length} bunks`);
            
            // Step 2: Extract claims
            console.log('🔀 Step 2: Extracting claims...');
            
            const localClaims = extractClaims(local, {
                source: 'local',
                schedulerName: window.AccessControl?.getCurrentUserInfo?.()?.email || 'Current User',
                timestamp: Date.now()
            });
            
            const cloudClaims = extractClaims(cloud, {
                source: 'cloud',
                timestamp: cloud?._fetchedAt || Date.now() - 60000
            });
            
            const allClaims = [...cloudClaims, ...localClaims];
            
            result.stats.localClaims = localClaims.length;
            result.stats.cloudClaims = cloudClaims.length;
            result.stats.totalClaims = allClaims.length;
            
            // Step 3: Detect conflicts
            console.log('🔀 Step 3: Detecting conflicts...');
            const conflicts = detectConflicts(allClaims);
            result.stats.conflicts = conflicts.length;
            
            // Step 4: Resolve conflicts
            console.log('🔀 Step 4: Resolving conflicts...');
            const resolvedConflicts = resolveConflicts(conflicts, strategy);
            
            result.conflicts = resolvedConflicts;
            result.unresolvedConflicts = resolvedConflicts.filter(c => !c.resolution);
            result.stats.resolved = resolvedConflicts.filter(c => c.resolution).length;
            result.stats.unresolved = result.unresolvedConflicts.length;
            
            // Step 5: Build unified schedule
            console.log('🔀 Step 5: Building unified schedule...');
            const unified = buildUnifiedSchedule(allClaims, resolvedConflicts);
            result.unifiedSchedule = unified;
            
            result.stats.mergedBunks = Object.keys(unified.scheduleAssignments).length;
            result.stats.mergedSlots = Object.values(unified.scheduleAssignments)
                .reduce((sum, slots) => sum + slots.filter(Boolean).length, 0);
            
            // Step 6: Create audit log
            result.auditLog = {
                mergeId: generateId('merge'),
                timestamp: Date.now(),
                dateKey,
                strategy,
                performedBy: window.AccessControl?.getCurrentUserInfo?.() || {},
                stats: result.stats
            };
            
            // Step 7: Save if not preview
            if (!preview && result.unresolvedConflicts.length === 0) {
                console.log('🔀 Step 7: Saving unified schedule...');
                await saveUnifiedSchedule(dateKey, unified, result.auditLog);
            }
            
            result.success = result.unresolvedConflicts.length === 0;
            
            console.log('═'.repeat(70));
            console.log('🔀 MERGE COMPLETE');
            console.log(`   Result: ${result.success ? '✅ SUCCESS' : '⚠️ NEEDS REVIEW'}`);
            console.log('═'.repeat(70) + '\n');
            
        } catch (error) {
            console.error('🔀 Merge failed:', error);
            result.error = error.message;
        }
        
        return result;
    }
    
    /**
     * Save the unified schedule to storage and cloud
     */
    async function saveUnifiedSchedule(dateKey, unified, auditLog) {
        try {
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            
            if (!dailyData[dateKey]) dailyData[dateKey] = {};
            
            dailyData[dateKey] = {
                ...dailyData[dateKey],
                scheduleAssignments: unified.scheduleAssignments,
                _mergeInfo: unified._mergeInfo,
                _lastMerge: auditLog
            };
            
            localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
            window.scheduleAssignments = unified.scheduleAssignments;
            
            if (window.forceSyncToCloud) {
                await window.forceSyncToCloud();
            }
            
            window.dispatchEvent(new CustomEvent('campistry-daily-data-updated'));
            window.dispatchEvent(new CustomEvent('campistry-schedule-merged', {
                detail: { dateKey, auditLog }
            }));
            
            return true;
        } catch (error) {
            console.error('🔀 Save failed:', error);
            return false;
        }
    }

    /**
     * Create unified view without saving (preview/display only)
     */
    async function createUnifiedView(dateKey) {
        const result = await executeMerge({
            dateKey,
            preview: true,
            strategy: RESOLUTION_STRATEGIES.CAPACITY_SHARE
        });
        return result.unifiedSchedule;
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.ScheduleMergeEngine = {
        RESOLUTION_STRATEGIES,
        CONFLICT_TYPES,
        executeMerge,
        createUnifiedView,
        extractClaims,
        detectConflicts,
        resolveConflicts,
        buildUnifiedSchedule,
        getFieldCapacity
    };
    
    console.log("🔀 Schedule Merge Engine v1.0.0 loaded");

})();
