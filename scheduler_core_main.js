// ============================================================================
// scheduler_core_main.js (FIXED v17.10 - CAPACITY LOGIC FIX)
// ============================================================================
// ★★★ CRITICAL PROCESSING ORDER ★★★
// 1. Initialize GlobalFieldLocks & LocationUsage (RESET)
// 2. Load Data & Apply Daily Overrides
// 3. Process Bunk Overrides
// 4. Process Elective Tiles
// 5. Process Skeleton Blocks
// 6. ★ SPECIALTY LEAGUES FIRST ★
// 7. ★ REGULAR LEAGUES SECOND ★
// 8. Process Smart Tiles
// 9. Run Total Solver
//
// v17.10: ★★★ FIXED: Capacity calculation - type='all' now returns 999 ★★★
// v17.9: Use exact slot matching for skeleton blocks
// v17.8: Added D2 Diagnostics & Gap Detection Type Coercion Fix
// v17.7: Fixed split tile fillBlock slot usage & solver pick propagation
// v17.6: Fixed Split Tile targeting using exact slot matching vs broad range
// v17.5: Fixed split tile metadata & pinned events
// v17.4: Added DivisionTimesSystem support
// ============================================================================

(function() {
    'use strict';

    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";

    // =========================================================================
    // ★★★ CENTRALIZED CAPACITY FUNCTION (v17.10) ★★★
    // =========================================================================

    /**
     * Get field capacity - SINGLE SOURCE OF TRUTH
     * - type='not_sharable' → 1
     * - type='all' → 999 (unlimited)
     * - type='custom' → configured capacity (default 2)
     */
    function getFieldCapacityLocal(fieldName, activityProperties) {
        // Use centralized utility if available
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        
        // Also check global settings for field config
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || globalSettings.fields || [];
        const fieldConfig = fields.find(f => f.name?.toLowerCase() === fieldName?.toLowerCase());
        
        // Check both activityProperties AND fieldConfig (dual lookup)
        const props = activityProperties?.[fieldName] || fieldConfig || {};
        
        if (props.sharableWith) {
            // ★★★ FIX: type='all' = unlimited (999) ★★★
            if (props.sharableWith.type === 'all') {
                return 999;
            }
            // type='custom' uses configured capacity
            if (props.sharableWith.type === 'custom') {
                return parseInt(props.sharableWith.capacity) || 2;
            }
            // type='not_sharable' - return 1
            if (props.sharableWith.type === 'not_sharable') {
                return 1;
            }
            // Explicit capacity value
            if (props.sharableWith.capacity) {
                return parseInt(props.sharableWith.capacity);
            }
        }
        
        // Legacy sharable boolean
        if (props.sharable) {
            return 2;
        }
        
        return 1; // Default: not sharable
    }

    // Export for external use
    window.getFieldCapacityFromMain = getFieldCapacityLocal;

    // -------------------------------------------------------------------------
    // TIME SLOT HELPERS
    // -------------------------------------------------------------------------

    /**
     * Find exact slot index for a specific time range in a division 
     * @param {string} divName - Division name 
     * @param {number} startMin - Start time in minutes 
     * @param {number} endMin - End time in minutes 
     * @returns {number} Slot index or -1 if not found 
     */
    function findExactSlotForTimeRange(divName, startMin, endMin) {
        // ★★★ v17.10 FIX: Convert divName to string for divisionTimes lookup ★★★
        const divNameStr = String(divName);
        const divSlots = window.divisionTimes?.[divNameStr] || [];
        
        // Exact match
        for (let i = 0; i < divSlots.length; i++) {
            if (divSlots[i].startMin === startMin && divSlots[i].endMin === endMin) {
                return i;
            }
        }
        
        // Containing match
        for (let i = 0; i < divSlots.length; i++) {
            if (divSlots[i].startMin <= startMin && endMin <= divSlots[i].endMin) {
                return i;
            }
        }
        
        return -1;
    }

    // -------------------------------------------------------------------------
    // RAINY DAY MODE HELPERS
    // -------------------------------------------------------------------------

    function isRainyDayModeActive() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    return dailyData.rainyDayMode === true || 
           dailyData.isRainyDay === true ||
           window.isRainyDay === true;
}

    function getRainyDayFieldFilter() {
        if (!isRainyDayModeActive()) return null;

        const g = window.loadGlobalSettings?.() || {};
        const fields = g.app1?.fields || [];

        const outdoorFields = fields
            .filter(f => f.rainyDayAvailable !== true)
            .map(f => f.name);

        const indoorFields = fields
            .filter(f => f.rainyDayAvailable === true)
            .map(f => f.name);

        console.log(`[RainyDay] Mode ACTIVE`);
        console.log(`[RainyDay] Indoor fields (available): ${indoorFields.join(', ') || 'none'}`);
        console.log(`[RainyDay] Outdoor fields (disabled): ${outdoorFields.join(', ') || 'none'}`);

        return {
            disabledFields: outdoorFields,
            indoorFields: indoorFields
        };
    }

    function getRainyDaySpecialActivities() {
        if (!isRainyDayModeActive()) return {
            rainyDayOnly: [],
            regularAvailable: null
        };

        const g = window.loadGlobalSettings?.() || {};
        const specials = g.app1?.specialActivities || [];

        const rainyDayOnly = specials
            .filter(s => s.rainyDayOnly === true)
            .map(s => s.name);

        const regularAvailable = specials
            .filter(s => s.availableOnRainyDay !== false && s.rainyDayOnly !== true)
            .map(s => s.name);

        console.log(`[RainyDay] Rainy-day-only activities: ${rainyDayOnly.join(', ') || 'none'}`);
        console.log(`[RainyDay] Regular activities (still available): ${regularAvailable.join(', ') || 'none'}`);

        return {
            rainyDayOnly,
            regularAvailable
        };
    }

    // -------------------------------------------------------------------------
    // ★★★ LOCATION CONFLICT HELPERS (FIXED v17.10) ★★★
    // -------------------------------------------------------------------------

    function canScheduleAtLocation(activityName, locationName, slots) {
        if (!locationName) return true;

        const comprehensiveUsage = window.buildFieldUsageBySlot?.() || {};
        
        // ★★★ FIX v17.10: Use centralized capacity calculation ★★★
        const maxCapacity = getFieldCapacityLocal(locationName, window.activityProperties);

        for (const slotIdx of slots) {
            const slotUsage = comprehensiveUsage[slotIdx]?.[locationName];
            if (slotUsage) {
                if (slotUsage.count >= maxCapacity) {
                    const activitiesInUse = Object.values(slotUsage.bunks || {});
                    const allSameActivity = activitiesInUse.every(
                        act => act.toLowerCase() === activityName.toLowerCase()
                    );
                    
                    if (!allSameActivity) {
                        console.log(`[LOCATION] ${locationName} blocked at slot ${slotIdx}: ${slotUsage.count}/${maxCapacity} capacity, different activities in use`);
                        return false;
                    }
                }
            }
        }

        return true;
    }

    function registerActivityAtLocation(activityName, locationName, slots, divisionName) {
        if (!locationName) return;

        window.locationUsageBySlot = window.locationUsageBySlot || {};

        for (const slotIdx of slots) {
            if (!window.locationUsageBySlot[slotIdx]) {
                window.locationUsageBySlot[slotIdx] = {};
            }

            if (!window.locationUsageBySlot[slotIdx][locationName]) {
                window.locationUsageBySlot[slotIdx][locationName] = {
                    activity: activityName,
                    division: divisionName,
                    timestamp: Date.now()
                };
            }
        }
    }

    function getLocationForActivity(activityName) {
        if (!activityName) return null;
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specials = globalSettings.app1?.specialActivities || [];

        const special = specials.find(s =>
            s.name.toLowerCase() === activityName.toLowerCase()
        );

        return special?.location || null;
    }

    function getLocationForPinnedEvent(skeletonEvent) {
        // 1. Direct location on skeleton item
        if (skeletonEvent.location) {
            return skeletonEvent.location;
        }
        // 2. Special activity with assigned location
        const specialLoc = getLocationForActivity(skeletonEvent.event);
        if (specialLoc) return specialLoc;
        // 3. ★ v17.11: Pinned tile default location (Snacks→Lunchroom, Lunch→Lunchroom, etc.)
        const pinnedDefault = window.getPinnedTileDefaultLocation?.(skeletonEvent.event);
        if (pinnedDefault) return pinnedDefault;
        return null;
    }

    // --- SCHEDULER API EXPORTS ---

    window.resetLocationUsage = function() {
        window.locationUsageBySlot = {};
        console.log("[LOCATION] Usage tracking reset.");
    };

    window.isLocationAvailable = function(locationName, slots, activityName) {
        return canScheduleAtLocation(activityName, locationName, slots);
    };

    window.registerLocationUsage = function(slotIdxOrArray, locationName, activityName, divisionName) {
        const slots = Array.isArray(slotIdxOrArray) ? slotIdxOrArray : [slotIdxOrArray];
        registerActivityAtLocation(activityName, locationName, slots, divisionName);
    };

    window.canScheduleAtLocation = canScheduleAtLocation;
    window.registerActivityAtLocation = registerActivityAtLocation;
    window.getLocationForActivity = getLocationForActivity;
    window.getLocationForPinnedEvent = getLocationForPinnedEvent;

    // -------------------------------------------------------------------------
    // SWIM/POOL ALIAS SYSTEM
    // -------------------------------------------------------------------------

    const SWIM_POOL_ALIASES = ['swim', 'pool', 'swimming', 'swimming pool'];

    function isSwimOrPool(name) {
        if (!name) return false;
        const lower = name.toLowerCase().trim();
        return SWIM_POOL_ALIASES.some(alias => lower.includes(alias));
    }

    function getCanonicalPoolName(activityProperties) {
        const poolNames = ['Pool', 'pool', 'Swimming Pool', 'swimming pool', 'Swim', 'swim'];
        for (const pn of poolNames) {
            if (activityProperties?.[pn]) return pn;
        }
        return null;
    }

    function resolveSwimPoolName(name, activityProperties) {
        if (!isSwimOrPool(name)) return name;

        const canonical = getCanonicalPoolName(activityProperties);
        if (canonical) {
            console.log(`[ALIAS] Resolved "${name}" to "${canonical}"`);
            return canonical;
        }
        return name;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function normalizeGA(name) {
        if (!name) return null;
        const s = name.toLowerCase().replace(/\s+/g, '');
        const keys = ["generalactivity", "activity", "activty", "ga", "activityslot"];
        return keys.some(k => s.includes(k)) ? "General Activity Slot" : null;
    }

    function normalizeLeague(name) {
        if (!name) return null;
        const s = name.toLowerCase().replace(/\s+/g, '');
        if (s.includes("league") && !s.includes("specialty")) return "League Game";
        return null;
    }

    function normalizeSpecialtyLeague(name) {
        if (!name) return null;
        const s = name.toLowerCase().replace(/\s+/g, '');
        if (s.includes("specialtyleague") || s.includes("specleague")) return "Specialty League";
        return null;
    }

    function isGeneratedType(name) {
        if (!name) return false;
        const s = name.toLowerCase().trim();
        return (
            s.includes("sport") ||
            s.includes("general") ||
            s.includes("activity") ||
            s.includes("special") ||
            s.includes("league")
        );
    }

    // -------------------------------------------------------------------------
    // fillBlock — Buffer/Merge-Safe Inline Writer
    // -------------------------------------------------------------------------
    // v17.7 FIX: Split tile blocks now use explicit slots and properly propagate metadata

    function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, isLeagueFill = false, activityProperties) {
        const Utils = window.SchedulerCoreUtils;
        
        if (!block) {
            console.error('[fillBlock] Block is null/undefined');
            return;
        }
        
        // ★★★ SPECIAL CASE: League blocks with bunks array (teams ≠ bunks) ★★★
        if (block.type === 'league' && block.bunks && !block.bunk && !block.team) {
            console.log(`[fillBlock] League block for ${block.divName} - storing matchups only (teams ≠ bunks)`);
            
            if (pick && (pick._allMatchups || pick._h2h) && block.divName && block.slots?.length > 0) {
                if (!window.leagueAssignments) window.leagueAssignments = {};
                if (!window.leagueAssignments[block.divName]) {
                    window.leagueAssignments[block.divName] = {};
                }
                
                const slotIdx = block.slots[0];
                if (!window.leagueAssignments[block.divName][slotIdx]) {
                    window.leagueAssignments[block.divName][slotIdx] = {
                        matchups: pick._allMatchups || [],
                        gameLabel: pick._gameLabel || block.event || 'League Game',
                        sport: pick.sport || '',
                        leagueName: pick._leagueName || ''
                    };
                    console.log(`[fillBlock] ✅ Stored league matchups for ${block.divName} at slot ${slotIdx}: ${(pick._allMatchups || []).length} matchups`);
                }
            }
            return;
        }
        
        let bunk = block.bunk;
        if (!bunk && block.team) bunk = block.team;
        if (!bunk && block.bunkName) bunk = block.bunkName;
        
        if (!bunk) {
            console.warn('[fillBlock] No bunk found in block:', JSON.stringify(block).substring(0, 200));
            return;
        }
        
        block.bunk = bunk;
        
        if (!block.slots || block.slots.length === 0) {
            if (block.startTime !== undefined && block.endTime !== undefined) {
                block.slots = Utils.findSlotsForRange(block.startTime, block.endTime, block.divName);
            }
            if (!block.slots || block.slots.length === 0) {
                console.warn(`[fillBlock] No slots for ${bunk}, times: ${block.startTime}-${block.endTime}`);
                return;
            }
        }
        
        const fName = Utils.fieldLabel(pick.field);
        const trans = Utils.getTransitionRules(fName, activityProperties);
        const {
            blockStartMin,
            blockEndMin,
            effectiveStart,
            effectiveEnd
        } = Utils.getEffectiveTimeRange(block, trans);
        const zone = trans.zone;

        // ★★★ CRITICAL: Initialize bunk array if not exists ★★★
        if (!window.scheduleAssignments[bunk]) {
            const divName = block.divName || Utils.getDivisionForBunk?.(bunk) || window.DivisionTimesSystem?.getDivisionForBunk(bunk);
            const divSlots = window.divisionTimes?.[divName];
            const slotCount = divSlots?.length || window.unifiedTimes?.length || 50;
            window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
        }

        let writePre = trans.preMin > 0;
        let writePost = trans.postMin > 0;

        const firstSlotIndex = block.slots[0];
        const prevEntry = window.scheduleAssignments[bunk]?.[firstSlotIndex - 1];

        if (writePre && firstSlotIndex > 0) {
            if (prevEntry?._zone === zone && prevEntry?._isTransition && prevEntry?._transitionType === 'Post') {
                writePre = false;
            }
        }

        if (writePre) {
            const preSlots = Utils.findSlotsForRange(blockStartMin, effectiveStart, block.divName);
            preSlots.forEach((slotIndex, i) => {
                if (!window.scheduleAssignments[bunk][slotIndex]) {
                    window.scheduleAssignments[bunk][slotIndex] = {
                        field: TRANSITION_TYPE,
                        sport: trans.label,
                        continuation: i > 0,
                        _fixed: true,
                        _activity: TRANSITION_TYPE,
                        _isTransition: true,
                        _transitionType: "Pre",
                        _zone: zone,
                        _endTime: effectiveStart
                    };
                }
            });
        }

        // ★★★ v17.7 FIX: For split tiles, ALWAYS use explicit block.slots to avoid transition rule interference ★★★
        const isSplitTileBlock = block.fromSplitTile || block._fromSplitTile || pick._fromSplitTile || block._splitTimeStart !== undefined;
        
        let mainSlots;
        if (isSplitTileBlock && block.slots && block.slots.length > 0) {
            // Split tiles have precise slot targeting - use them directly
            mainSlots = block.slots;
            console.log(`[fillBlock] ★ SPLIT TILE: Using explicit slots [${mainSlots.join(',')}] for ${bunk}`);
        } else {
            mainSlots = Utils.findSlotsForRange(effectiveStart, effectiveEnd, block.divName);
            if (mainSlots.length === 0 && block.slots && block.slots.length > 0) {
                if (trans.preMin === 0 && trans.postMin === 0) mainSlots = block.slots;
            }
        }

        if (mainSlots.length === 0) {
            console.error(`FillBlock: NO SLOTS for ${bunk} @ ${block.startTime}`);
            return;
        }

        mainSlots.forEach((slotIndex, i) => {
            const existing = window.scheduleAssignments[bunk][slotIndex];
            
            // ★★★ v17.7 FIX: Check BOTH block.fromSplitTile AND pick._fromSplitTile ★★★
            const canWrite = !existing || 
                            existing._isTransition ||
                            isSplitTileBlock ||  // ← NEW: Allow writes for any split tile block
                            (pick._fromSplitTile && existing._fromSplitTile && 
                             block.startTime !== undefined && existing._startMin !== undefined &&
                             (block.startTime >= existing._endMin || block.endTime <= existing._startMin));
            
            if (canWrite) {
                window.scheduleAssignments[bunk][slotIndex] = {
                    field: fName,
                    sport: pick.sport,
                    continuation: i > 0,
                    _fixed: pick._fixed || false,
                    _h2h: pick._h2h || false,
                    _activity: pick._activity || fName,
                    _allMatchups: pick._allMatchups || null,
                    _gameLabel: pick._gameLabel || null,
                    _zone: zone,
                    _endTime: effectiveEnd,
                    _bunkOverride: pick._bunkOverride || false,
                    // ★★★ v17.7: Store time range AND split tile flag for proper tracking ★★★
                    _startMin: block.startTime,
                    _endMin: block.endTime,
                    _fromSplitTile: isSplitTileBlock || pick._fromSplitTile || false
                };
                window.registerSingleSlotUsage(slotIndex, fName, block.divName, bunk, pick._activity || fName, fieldUsageBySlot, activityProperties);
            } else {
                console.log(`[fillBlock] ⚠️ Skipped write for ${bunk} slot ${slotIndex} - existing: ${existing?._activity}`);
            }
        });

        // Store league matchups
        if ((pick._h2h || pick._allMatchups) && block.divName) {
            if (!window.leagueAssignments) window.leagueAssignments = {};
            if (!window.leagueAssignments[block.divName]) {
                window.leagueAssignments[block.divName] = {};
            }
            
            mainSlots.forEach(slotIndex => {
                if (!window.leagueAssignments[block.divName][slotIndex]) {
                    window.leagueAssignments[block.divName][slotIndex] = {
                        matchups: pick._allMatchups || [],
                        gameLabel: pick._gameLabel || '',
                        sport: pick.sport || '',
                        leagueName: pick._leagueName || ''
                    };
                    console.log(`[fillBlock] ✅ Stored league matchups for ${block.divName} at slot ${slotIndex}: ${(pick._allMatchups || []).length} matchups`);
                }
            });
        }

        if (writePost) {
            const postSlots = Utils.findSlotsForRange(effectiveEnd, blockEndMin, block.divName);
            postSlots.forEach((slotIndex, i) => {
                if (!window.scheduleAssignments[bunk][slotIndex]) {
                    window.scheduleAssignments[bunk][slotIndex] = {
                        field: TRANSITION_TYPE,
                        sport: trans.label,
                        continuation: i > 0,
                        _fixed: true,
                        _activity: TRANSITION_TYPE,
                        _isTransition: true,
                        _transitionType: "Post",
                        _zone: zone,
                        _endTime: blockEndMin
                    };
                }
            });
        }
    }
    window.fillBlock = fillBlock;

    // ============================================================================
    // SMART TILES PROCESSOR
    // ============================================================================

    function processSmartTiles(manualSkeleton, externalOverrides, config, allowedDivisions = null) {
        const Utils = window.SchedulerCoreUtils;
        const {
            divisions,
            activityProperties,
            masterSpecials,
            dailyFieldAvailability,
            historicalCounts,
            specialActivityNames,
            yesterdayHistory,
            fieldUsageBySlot
        } = config;

        const schedulableSlotBlocks = [];
        const knownSpecialNames = new Set();

        (masterSpecials || []).forEach(s => {
            if (s.name) knownSpecialNames.add(s.name.toLowerCase().trim());
        });

        (specialActivityNames || []).forEach(name => {
            knownSpecialNames.add(name.toLowerCase().trim());
        });

        const globalSpecials = window.getGlobalSpecialActivities?.() || [];
        globalSpecials.forEach(s => {
            if (s.name) knownSpecialNames.add(s.name.toLowerCase().trim());
        });

        const smartJobs = window.SmartLogicAdapter?.preprocessSmartTiles?.(
            manualSkeleton,
            externalOverrides,
            masterSpecials
        ) || [];

        const filteredJobs = allowedDivisions 
            ? smartJobs.filter(job => {
                if (allowedDivisions instanceof Set) {
                    return allowedDivisions.has(String(job.division));
                }
                return allowedDivisions.includes(job.division);
            })
            : smartJobs;

        console.log(`[SmartTile] Processing ${filteredJobs.length} smart tile jobs (filtered from ${smartJobs.length})`);

        filteredJobs.forEach((job, jobIdx) => {
            console.log(`\n[SmartTile] Job ${jobIdx + 1}: ${job.division}`);

            const divName = job.division;
            const bunkList = divisions[divName]?.bunks || [];

            if (bunkList.length === 0) {
                console.warn(`[SmartTile] No bunks in division ${divName}`);
                return;
            }

            const result = window.SmartLogicAdapter.generateAssignments(
                bunkList,
                job,
                historicalCounts,
                specialActivityNames,
                activityProperties,
                null,
                dailyFieldAvailability,
                yesterdayHistory
            );

            if (!result) {
                console.error(`[SmartTile] Failed to generate assignments for ${divName}`);
                return;
            }

            const {
                block1Assignments,
                block2Assignments
            } = result;

            function needsGeneration(activityLabel) {
                if (!activityLabel) return false;
                const lower = activityLabel.toLowerCase().trim();
                const genericSlots = [
                    "sports slot", "general activity slot", "general activity",
                    "activity slot", "activity",
                    "special", "special activity", "special activity slot"
                ];

                if (genericSlots.includes(lower)) return true;

                if (lower === "sports") {
                    const isSportsConfigured = activityProperties?.["Sports"] || activityProperties?.["sports"];
                    if (!isSportsConfigured) return true;
                }
                return false;
            }

            function routeActivity(bunk, activityLabel, blockInfo) {
                const startMin = blockInfo.startMin;
                const endMin = blockInfo.endMin;
                const slots = Utils.findSlotsForRange(startMin, endMin, divName);

                if (slots.length === 0) {
                    console.warn(`[SmartTile] No slots for ${bunk} at ${startMin}-${endMin}`);
                    return;
                }

                const existing = window.scheduleAssignments[bunk]?.[slots[0]];
                if (existing && existing._bunkOverride) {
                    console.log(`[SmartTile] ${bunk} has bunk override, skipping`);
                    return;
                }

                if (window.GlobalFieldLocks?.isFieldLocked(activityLabel, slots, divName)) {
                    console.log(`[SmartTile] ${bunk} - ${activityLabel} is LOCKED for ${divName}, trying alternatives`);
                    
                    // Try the other main first, then fallback
                    const alternatives = [];
                    
                    if (activityLabel.toLowerCase().trim() !== (job.main1 || '').toLowerCase().trim()) alternatives.push(job.main1);
                    if (activityLabel.toLowerCase().trim() !== (job.main2 || '').toLowerCase().trim()) alternatives.push(job.main2);
                    if (job.fallbackActivity) alternatives.push(job.fallbackActivity);
                    
                    let placed = false;
                    for (const alt of alternatives) {
                        if (!alt) continue;
                        
                        if (window.GlobalFieldLocks?.isFieldLocked(alt, slots, divName)) {
                            console.log(`[SmartTile] ${bunk} - alt "${alt}" also locked, trying next`);
                            continue;
                        }
                        
                        if (needsGeneration(alt)) {
                            let slotType = "General Activity Slot";
                            const lowerAlt = alt.toLowerCase().trim();
                            if (lowerAlt.includes("sport")) slotType = "Sports Slot";
                            
                            schedulableSlotBlocks.push({
                                divName,
                                bunk,
                                event: slotType,
                                startTime: startMin,
                                endTime: endMin,
                                slots,
                                fromSmartTile: true,
                                _lockedFallback: true
                            });
                            console.log(`[SmartTile] ${bunk} -> QUEUED as "${slotType}" (fallback from locked "${activityLabel}")`);
                            placed = true;
                            break;
                        } else {
                            console.log(`[SmartTile] ${bunk} -> DIRECT FILL: ${alt} (fallback from locked "${activityLabel}")`);
                            window.fillBlock({
                                divName,
                                bunk,
                                startTime: startMin,
                                endTime: endMin,
                                slots
                            }, {
                                field: alt,
                                sport: null,
                                _fixed: true,
                                _activity: alt
                            }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                            placed = true;
                            break;
                        }
                    }
                    
                    if (!placed) {
                        schedulableSlotBlocks.push({
                            divName,
                            bunk,
                            event: "General Activity Slot",
                            startTime: startMin,
                            endTime: endMin,
                            slots,
                            fromSmartTile: true,
                            _lockedFallback: true
                        });
                        console.log(`[SmartTile] ${bunk} -> QUEUED as "General Activity Slot" (all alternatives locked)`);
                    }
                    return;
                }

                if (needsGeneration(activityLabel)) {
                    let slotType = "General Activity Slot";
                    const lower = activityLabel.toLowerCase().trim();
                    if (lower.includes("sport")) slotType = "Sports Slot";
                    else if (lower.includes("special")) slotType = "Special Activity";

                    console.log(`[SmartTile] ${bunk} -> GENERATE: ${slotType}`);

                    schedulableSlotBlocks.push({
                        divName,
                        bunk,
                        event: slotType,
                        startTime: startMin,
                        endTime: endMin,
                        slots,
                        fromSmartTile: true
                    });
                } else {
                    console.log(`[SmartTile] ${bunk} -> DIRECT FILL: ${activityLabel}`);

                   window.fillBlock({
                        divName,
                        bunk,
                        startTime: startMin,
                        endTime: endMin,
                        slots
                    }, {
                        field: activityLabel,
                        sport: null,
                        _fixed: true,
                        _activity: activityLabel
                    }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);

                    // ★ v17.11: Lock field if special activity has a location
                    const smartLocName = getLocationForActivity(activityLabel);
                    if (smartLocName && window.GlobalFieldLocks) {
                        window.GlobalFieldLocks.lockField(smartLocName, slots, {
                            lockedBy: 'smart_tile_special_location',
                            division: divName,
                            activity: `${activityLabel} (smart tile @ ${smartLocName})`
                        });
                        console.log(`[SmartTile] → Locked field "${smartLocName}" for "${activityLabel}"`);
                    }
                }
            }

            console.log(`[SmartTile] Block A (${job.blockA.startMin}-${job.blockA.endMin}):`);
            Object.entries(block1Assignments || {}).forEach(([bunk, act]) => {
                routeActivity(bunk, act, job.blockA);
            });

            if (job.blockB && block2Assignments) {
                console.log(`[SmartTile] Block B (${job.blockB.startMin}-${job.blockB.endMin}):`);
                Object.entries(block2Assignments).forEach(([bunk, act]) => {
                    routeActivity(bunk, act, job.blockB);
                });
            }
        });

        return schedulableSlotBlocks;
    }

    // =========================================================================
    // ★★★ MAIN ENTRY POINT ★★★
    // =========================================================================

    window.runSkeletonOptimizer = async function(manualSkeleton, externalOverrides, allowedDivisions = null, existingScheduleSnapshot = null, existingUnifiedTimes = null) {
        console.log("\n" + "=".repeat(70));
        console.log("★★★ OPTIMIZER STARTED (v17.11 - RBAC + CAPACITY FIX) ★★★");
        // ★★★ SCHEDULER RESTRICTION ★★★
        if (window.AccessControl?.filterDivisionsForGeneration) {
            allowedDivisions = window.AccessControl.filterDivisionsForGeneration(allowedDivisions);
            if (allowedDivisions.length === 0) {
                alert("No divisions assigned. Contact camp owner.");
                return false;
            }
            console.log(`[RBAC] ★ SCHEDULER RESTRICTION APPLIED: Generating for [${allowedDivisions.join(', ')}] only`);
        }
// ★★★ v17.12: Set flag to prevent remote merges during generation ★★★
        window._generationInProgress = true;
        // ★★★ 1. AUTO-DETECT ALLOWED DIVISIONS ★★★
        if (!allowedDivisions) {
            if (window.MultiSchedulerCore && typeof window.MultiSchedulerCore.getUserDivisions === 'function') {
                const userDivs = window.MultiSchedulerCore.getUserDivisions();
                if (userDivs && userDivs.length > 0) {
                    const allDivs = Object.keys(window.divisions || {});
                    if (userDivs.length < allDivs.length) {
                        allowedDivisions = userDivs;
                        console.log(`[RBAC] Auto-detected restricted divisions via MultiScheduler: ${allowedDivisions.join(', ')}`);
                    }
                }
            } 
            else if (window.AccessControl && typeof window.AccessControl.getUserManagedDivisions === 'function') {
                const userDivs = window.AccessControl.getUserManagedDivisions();
                if (userDivs && userDivs.length > 0) {
                    const allDivs = Object.keys(window.divisions || {});
                    if (userDivs.length < allDivs.length) {
                        allowedDivisions = userDivs;
                        console.log(`[RBAC] Auto-detected restricted divisions via AccessControl: ${allowedDivisions.join(', ')}`);
                    }
                }
            }
        }
// ★★★ v17.12: Clear generation flag ★★★
        window._generationInProgress = false;
        // ★★★ 2. FORCE CLOUD LOAD + AUTO-SNAPSHOT FOR PRESERVATION ★★★
        if (allowedDivisions && (!existingScheduleSnapshot || Object.keys(existingScheduleSnapshot).length === 0)) {
            console.log("[OPTIMIZER] Partial generation detected without snapshot. Loading latest from cloud first...");
            
            // ★★★ v17.12 CRITICAL FIX: Force-load from cloud to get ALL schedulers' data ★★★
            // Without this, Scheduler 2 won't see Scheduler 1's data and will overwrite it
            let snapshotSource = null;
            
            try {
                if (window.ScheduleDB?.loadSchedule && navigator.onLine) {
                    const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                    console.log("[OPTIMIZER] ☁️ Force-loading from cloud for date:", dateKey);
                    const cloudResult = await window.ScheduleDB.loadSchedule(dateKey);
                    
                    if (cloudResult?.success && cloudResult.data?.scheduleAssignments) {
                        const cloudBunks = Object.keys(cloudResult.data.scheduleAssignments).length;
                        console.log(`[OPTIMIZER] ☁️ Cloud returned ${cloudBunks} bunks from ${cloudResult.recordCount || '?'} scheduler records`);
                        
                        // Merge cloud data INTO window.scheduleAssignments (preserving any local-only changes)
                        const cloudAssignments = cloudResult.data.scheduleAssignments;
                        const localAssignments = window.scheduleAssignments || {};
                        
                        // Cloud data for OTHER schedulers' bunks takes priority
                        // Local data for MY bunks takes priority (in case I just made edits)
                        const myBunks = new Set(
                            window.AccessControl?.getEditableBunks?.() ||
                            window.CloudPermissions?.getEditableBunks?.() || []
                        );
                        
                        const merged = {};
                        // First, add all cloud bunks (other schedulers' data)
                        for (const [bunk, slots] of Object.entries(cloudAssignments)) {
                            merged[bunk] = slots;
                        }
                        // Then overlay MY bunks from local (in case I have unsaved edits)
                        for (const [bunk, slots] of Object.entries(localAssignments)) {
                            if (myBunks.has(bunk) || myBunks.has(String(bunk))) {
                                merged[bunk] = slots;
                            }
                        }
                        
                        window.scheduleAssignments = merged;
                        snapshotSource = merged;
                        
                        // ★★★ v17.12: Also merge leagueAssignments from cloud ★★★
                        if (cloudResult.data.leagueAssignments) {
                            const cloudLeagues = cloudResult.data.leagueAssignments || {};
                            const localLeagues = window.leagueAssignments || {};
                            const myDivisions = new Set(
                                window.AccessControl?.getEditableDivisions?.() || []
                            );
                            const mergedLeagues = { ...cloudLeagues };
                            for (const [divName, divData] of Object.entries(localLeagues)) {
                                if (myDivisions.has(divName)) {
                                    mergedLeagues[divName] = divData;
                                }
                            }
                            window.leagueAssignments = mergedLeagues;
                        }
                        
                        // Also hydrate divisionTimes if available
                        if (cloudResult.data.divisionTimes) {
                            window.divisionTimes = window.DivisionTimesSystem?.deserialize?.(cloudResult.data.divisionTimes) || cloudResult.data.divisionTimes;
                        }
                        
                        console.log(`[OPTIMIZER] ☁️ Merged snapshot: ${Object.keys(merged).length} total bunks (${myBunks.size} mine)`);
                    }
                }
            } catch (e) {
                console.warn("[OPTIMIZER] ☁️ Cloud load failed, falling back to local data:", e.message);
            }
            
            // Fallback: use whatever is in window.scheduleAssignments or localStorage
            if (!snapshotSource || Object.keys(snapshotSource).length === 0) {
                snapshotSource = window.scheduleAssignments;
            }
            
            if (!snapshotSource || Object.keys(snapshotSource).length === 0) {
                const currentData = window.loadCurrentDailyData?.() || {};
                snapshotSource = currentData.scheduleAssignments;
            }
            if (snapshotSource && Object.keys(snapshotSource).length > 0) {
                existingScheduleSnapshot = JSON.parse(JSON.stringify(snapshotSource));
                if (!existingUnifiedTimes) {
                    existingUnifiedTimes = window.DivisionTimesSystem?.buildUnifiedTimesFromDivisionTimes?.(window.divisionTimes) || window.unifiedTimes;
                }
                console.log(`[OPTIMIZER] ✅ Preserved snapshot of ${Object.keys(existingScheduleSnapshot).length} bunks for background restoration.`);
            } else {
                console.warn("[OPTIMIZER] ⚠️ No existing schedule found to preserve. Generating fresh.");
            }
        }
        
        // ★★★ SECURITY: NORMALIZE ALLOWED DIVISIONS ★★★
        let allowedDivisionsSet = null;
        if (allowedDivisions && Array.isArray(allowedDivisions)) {
            allowedDivisionsSet = new Set(allowedDivisions.map(String));
            console.log(`★★★ PARTIAL MODE ACTIVE: Generating for [${Array.from(allowedDivisionsSet).join(', ')}] only ★★★`);
        }
        console.log("=".repeat(70));

        // ★★★ RESET disabled fields & Location Usage ★★★
        window.currentDisabledFields = [];

        if (window.resetLocationUsage) {
            window.resetLocationUsage();
        } else {
            window.locationUsageBySlot = {};
        }

        const Utils = window.SchedulerCoreUtils;
        const config = Utils.loadAndFilterData();
        window.activityProperties = config.activityProperties;
        window.unifiedTimes = [];

        // =====================================================================
        // MERGE DAILY FIELD AVAILABILITY INTO PROPERTIES
        // =====================================================================
        let { dailyFieldAvailability } = config;
        
        if (dailyFieldAvailability && Object.keys(dailyFieldAvailability).length > 0) {
            console.log("[OPTIMIZER] Merging Daily Field Availability Rules...");
            Object.keys(dailyFieldAvailability).forEach(fieldName => {
                const rules = dailyFieldAvailability[fieldName];
                if (rules && rules.length > 0) {
                    if (!window.activityProperties[fieldName]) {
                        window.activityProperties[fieldName] = {};
                    }
                    window.activityProperties[fieldName].timeRules = rules;
                    console.log(`   -> Applied ${rules.length} rule(s) to ${fieldName}`);
                }
            });
        }

        let {
            divisions,
            activityProperties,
            masterLeagues,
            masterSpecialtyLeagues,
            masterSpecials,
            yesterdayHistory,
            rotationHistory,
            disabledLeagues,
            disabledSpecialtyLeagues,
            disabledFields,
            disabledSpecials,
            historicalCounts,
            specialActivityNames,
            bunkMetaData,
            dailyFieldAvailability: _unusedDFA,
            fieldsBySport
        } = config;

        // =========================================================================
        // NUMERIC BUNK SORTING
        // =========================================================================
        Object.keys(divisions).forEach(divName => {
            if (divisions[divName].bunks) {
                divisions[divName].bunks.sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/)?.[0] || 0);
                    const numB = parseInt(b.match(/\d+/)?.[0] || 0);
                    return numA - numB || a.localeCompare(b);
                });
            }
        });

        window.SchedulerCoreUtils._bunkMetaData = bunkMetaData;
        window.SchedulerCoreUtils._sportMetaData = config.sportMetaData || {};

        window.fieldUsageBySlot = {};
        let fieldUsageBySlot = window.fieldUsageBySlot;

        window.scheduleAssignments = {};
        window.leagueAssignments = {};

        if (!manualSkeleton || manualSkeleton.length === 0) return false;

        // =========================================================================
        // ★★★ STEP 0: INITIALIZE GLOBAL FIELD LOCKS ★★★
        // =========================================================================

        console.log("\n[INIT] Resetting GlobalFieldLocks...");
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.reset();
        } else {
            console.error("[INIT] ❌ GlobalFieldLocks not loaded! Field locking will not work!");
        }

        window.fieldReservations = Utils.getFieldReservationsFromSkeleton(manualSkeleton);
        console.log("[INIT] Scanned skeleton for field reservations");

        // =========================================================================
        // ★★★ STEP 0.5: RAINY DAY MODE CHECK ★★★
        // =========================================================================
// Ensure window.isRainyDay is set from daily data
const dailyData = window.loadCurrentDailyData?.() || {};
if (window.isRainyDay === undefined) {
    window.isRainyDay = dailyData.rainyDayMode === true || dailyData.isRainyDay === true;
}
console.log(`[Generation] Rainy Day Mode: ${window.isRainyDay ? 'ACTIVE 🌧️' : 'INACTIVE ☀️'}`);


        const rainyDayFilter = getRainyDayFieldFilter();
        const rainyDaySpecials = getRainyDaySpecialActivities();

        if (rainyDayFilter) {
            console.log("\n" + "☔".repeat(35));
            console.log("★★★ RAINY DAY MODE ACTIVE ★★★");
            console.log("☔".repeat(35));

            const existingDisabled = disabledFields || [];
            disabledFields = [...new Set([...existingDisabled, ...rainyDayFilter.disabledFields])];

            config.disabledFields = disabledFields;
            window.currentDisabledFields = disabledFields;

            console.log(`[RainyDay] Total disabled fields: ${disabledFields.length}`);
            console.log(`[RainyDay] Disabled: ${disabledFields.join(', ')}`);
        } else {
            window.currentDisabledFields = disabledFields || [];
        }

        // =========================================================================
        // ★★★ FIX: Filter Specials based on Rainy Day Mode ★★★
        // =========================================================================

        const isRainyMode = isRainyDayModeActive();

        if (masterSpecials) {
            const originalCount = masterSpecials.length;

            masterSpecials = masterSpecials.filter(s => {
                if (!isRainyMode) {
                    if (s.rainyDayOnly === true || s.rainyDayExclusive === true) return false;
                }

                if (isRainyMode) {
                    if (s.rainyDayAvailable === false || s.availableOnRainyDay === false) return false;
                }

                return true;
            });

            config.masterSpecials = masterSpecials;

            if (config.specialActivityNames) {
                const validNames = new Set(masterSpecials.map(s => s.name));
                config.specialActivityNames = config.specialActivityNames.filter(n => validNames.has(n));
            }

            if (masterSpecials.length !== originalCount) {
                console.log(`[RainyDay] Filtered specials from ${originalCount} to ${masterSpecials.length} (Mode: ${isRainyMode ? 'RAINY 🌧️' : 'SUNNY ☀️'})`);
            }
        }

        // =========================================================================
        // STEP 1: Build Division-Specific Time Slots (NEW SYSTEM)
        // =========================================================================

        console.log('[STEP 1] Building division-specific time slots...');
        
        if (window.DivisionTimesSystem) {
            window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(manualSkeleton, divisions);
            console.log(`[STEP 1] Built divisionTimes for ${Object.keys(window.divisionTimes).length} divisions`);
        
        } else {
            console.warn('[STEP 1] DivisionTimesSystem not loaded, using legacy grid');
            const timePoints = new Set([540, 960]);
            manualSkeleton.forEach(item => {
                const s = Utils.parseTimeToMinutes(item.startTime);
                const e = Utils.parseTimeToMinutes(item.endTime);
                if (s != null) timePoints.add(s);
                if (e != null) timePoints.add(e);
                if (item.type === 'split' && s != null && e != null) {
                    timePoints.add(Math.floor(s + (e - s) / 2));
                }
            });
            const sorted = [...timePoints].sort((a, b) => a - b);
            for (let i = 0; i < sorted.length - 1; i++) {
                if (sorted[i + 1] - sorted[i] >= 5) {
                    const s = Utils.minutesToDate(sorted[i]);
                    const e = Utils.minutesToDate(sorted[i + 1]);
                    window.unifiedTimes.push({ start: s, end: e, startMin: sorted[i], endMin: sorted[i + 1],
                        label: `${Utils.fmtTime(s)} - ${Utils.fmtTime(e)}` });
                }
            }
        }
// ★★★ INITIALIZE WITH DIVISION-SPECIFIC SLOT COUNTS ★★★
        // ★★★ FIX v17.11: ONLY reset bunks for divisions being generated ★★★
        // Previously this blanked ALL divisions, destroying Scheduler 1's data
        Object.keys(divisions).forEach(divName => {
            const divSlots = window.divisionTimes?.[divName] || [];
            const slotCount = divSlots.length > 0 ? divSlots.length : (window.unifiedTimes || []).length;
            
            // ★★★ KEY FIX: Skip initialization for divisions NOT being generated ★★★
            const isBeingGenerated = !allowedDivisionsSet || allowedDivisionsSet.has(String(divName));
            
            (divisions[divName].bunks || []).forEach(bunk => {
                if (isBeingGenerated) {
                    // This division IS being generated — create fresh empty array
                    window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                } else {
                    // This division is NOT being generated — PRESERVE existing data
                    if (!window.scheduleAssignments[bunk]) {
                        // Only create if doesn't exist (shouldn't blank existing)
                        window.scheduleAssignments[bunk] = new Array(slotCount).fill(null);
                    } else if (window.scheduleAssignments[bunk].length !== slotCount && slotCount > 0) {
                        // Resize if needed but KEEP the data
                        const existing = window.scheduleAssignments[bunk];
                        const resized = new Array(slotCount).fill(null);
                        for (let i = 0; i < Math.min(existing.length, slotCount); i++) {
                            resized[i] = existing[i];
                        }
                        window.scheduleAssignments[bunk] = resized;
                    }
                    // else: existing array is correct size — leave it completely alone
                }
            });
        });
        
        // ★★★ v17.10 FIX: Rebuild unifiedTimes from divisionTimes for legacy compatibility ★★★
        if (window.DivisionTimesSystem?.buildUnifiedTimesFromDivisionTimes) {
            window.unifiedTimes = window.DivisionTimesSystem.buildUnifiedTimesFromDivisionTimes(window.divisionTimes);
            console.log(`[STEP 1] Rebuilt unifiedTimes: ${window.unifiedTimes.length} slots for legacy compatibility`);
        }

        // =========================================================================
        // ★★★ STEP 1.5: RESTORE EXISTING SCHEDULE FOR LOCKED DIVISIONS ★★★
        // =========================================================================
        (function() {
            'use strict';

            console.log('[Step1.5Patch] Loading time-mapping restoration patch...');

            const TRANSITION_TYPE = "Transition/Buffer";

            function getTimeSig(t) {
                if (!t) return null;
                if (t instanceof Date) return t.toISOString();
                if (t.start instanceof Date) return t.start.toISOString();
                if (typeof t.start === 'string') return t.start;
                // ★★★ v17.5 FIX: Also use startMin-endMin as signature ★★★
                if (t.startMin !== undefined) return `${t.startMin}-${t.endMin}`;
                return String(t);
            }

            function restoreBackgroundSchedules(snapshot, divisions, allowedDivisions, existingUnifiedTimes) {
                if (!snapshot || Object.keys(snapshot).length === 0) {
                    console.log('[Step1.5] No snapshot to restore');
                    return 0;
                }

                const allowedSet = new Set(allowedDivisions || []);
                let restoredBunks = 0;
                let restoredSlots = 0;

                // ★★★ v17.5 FIX: Build proper time map ★★★
                const newTimeMap = new Map();
                const newUnifiedTimes = window.unifiedTimes || [];
                newUnifiedTimes.forEach((t, i) => {
                    const sig = getTimeSig(t);
                    if (sig) newTimeMap.set(sig, i);
                });

                console.log(`[Step1.5] Mapping existing data to ${newUnifiedTimes.length} slots...`);
                console.log(`[Step1.5]    Snapshot bunks: ${Object.keys(snapshot).length}`);
                console.log(`[Step1.5]    Allowed divisions (will skip): ${allowedDivisions?.join(', ') || 'NONE'}`);

                for (const [bunkName, slots] of Object.entries(snapshot)) {
                    if (!slots || !Array.isArray(slots)) continue;

                    const divName = Object.keys(divisions).find(d => 
                        divisions[d].bunks?.includes(bunkName)
                    );

                    if (divName && allowedSet.has(divName)) {
                        continue;
                    }

                    // ★★★ v17.5 FIX: Use correct slot count for division ★★★
                    const divSlots = window.divisionTimes?.[divName] || [];
                    const targetSlotCount = divSlots.length || newUnifiedTimes.length || slots.length;
                    
                    if (!window.scheduleAssignments[bunkName]) {
                        window.scheduleAssignments[bunkName] = new Array(targetSlotCount).fill(null);
                    }

                    for (let i = 0; i < slots.length; i++) {
                        if (slots[i]) {
                            let targetIndex = i;

                            // ★★★ v17.5: Try direct index mapping first for division-aware restoration ★★★
                            if (targetIndex < targetSlotCount) {
                                window.scheduleAssignments[bunkName][targetIndex] = {
                                    ...slots[i],
                                    _locked: true,
                                    _fromBackground: true,
                                    _backgroundDivision: divName
                                };
                                restoredSlots++;
                            }
                        }
                    }

                    restoredBunks++;
                    console.log(`[Step1.5]    ✓ Restored ${bunkName} (${divName})`);
                }

                console.log(`[Step1.5] ✅ Restored ${restoredBunks} bunks, ${restoredSlots} total slots mapped`);
                return restoredBunks;
            }

            function registerFieldUsageFromRestoredSchedules(snapshot, divisions, allowedDivisions, fieldUsageBySlot, activityProperties, existingUnifiedTimes) {
                if (!snapshot || Object.keys(snapshot).length === 0) {
                    return 0;
                }

                const allowedSet = new Set(allowedDivisions || []);
                let registrations = 0;

                console.log('[Step1.5] Registering field usage from restored schedules...');

                for (const [bunkName, slots] of Object.entries(snapshot)) {
                    if (!slots || !Array.isArray(slots)) continue;

                    const divName = Object.keys(divisions).find(d => 
                        divisions[d].bunks?.includes(bunkName)
                    );

                    if (divName && allowedSet.has(divName)) continue;

                    for (let i = 0; i < slots.length; i++) {
                        const slotData = slots[i];
                        if (!slotData || !slotData.field) continue;

                        const targetIndex = i;
                        const fieldName = slotData.field;
                        const activityName = slotData._activity || fieldName;

                        if (fieldName === TRANSITION_TYPE || slotData._isTransition) continue;

                        if (!fieldUsageBySlot[targetIndex]) {
                            fieldUsageBySlot[targetIndex] = {};
                        }

                        // ★★★ FIX v17.10: Use centralized capacity calculation ★★★
                        const maxCapacity = getFieldCapacityLocal(fieldName, activityProperties);

                        if (!fieldUsageBySlot[targetIndex][fieldName]) {
                            fieldUsageBySlot[targetIndex][fieldName] = {
                                count: 0,
                                divisions: [],
                                bunks: {},
                                _locked: true,
                                _fromBackground: true
                            };
                        }

                        const usage = fieldUsageBySlot[targetIndex][fieldName];
                        usage.count++;
                        usage.bunks[bunkName] = activityName;
                        if (divName && !usage.divisions.includes(divName)) {
                            usage.divisions.push(divName);
                        }

                        if (window.GlobalFieldLocks && usage.count >= maxCapacity) {
                            window.GlobalFieldLocks.lockField(fieldName, [targetIndex], {
                                lockedBy: 'background_schedule',
                                division: divName || 'background',
                                activity: `${activityName} (preserved from other scheduler)`
                            });
                        }

                        if (window.registerLocationUsage) {
                            const location = activityProperties?.[fieldName]?.location || 
                                                     window.getLocationForActivity?.(activityName);
                            if (location) {
                                window.registerLocationUsage(targetIndex, location, activityName, divName);
                            }
                        }

                        registrations++;
                    }
                }

                console.log(`[Step1.5] ✅ Registered ${registrations} field usages`);
                return registrations;
            }

            window.restoreBackgroundSchedules = restoreBackgroundSchedules;
            window.registerFieldUsageFromRestoredSchedules = registerFieldUsageFromRestoredSchedules;

            window.executeStep1_5 = function(snapshot, divisions, allowedDivisions, fieldUsageBySlot, activityProperties, existingUnifiedTimes) {
                console.log('\n[STEP 1.5] ═══════════════════════════════════════════════════');
                console.log('[STEP 1.5] RESTORING BACKGROUND SCHEDULES WITH TIME MAPPING');
                console.log('[STEP 1.5] ═══════════════════════════════════════════════════');

                if (!snapshot || Object.keys(snapshot).length === 0) {
                    console.log('[STEP 1.5] No background snapshot provided - nothing to restore');
                    return { bunksRestored: 0, fieldsRegistered: 0 };
                }

                const bunksRestored = restoreBackgroundSchedules(
                    snapshot, 
                    divisions, 
                    allowedDivisions,
                    existingUnifiedTimes
                );

                const fieldsRegistered = registerFieldUsageFromRestoredSchedules(
                    snapshot,
                    divisions,
                    allowedDivisions,
                    fieldUsageBySlot,
                    activityProperties,
                    existingUnifiedTimes
                );

                console.log('[STEP 1.5] ═══════════════════════════════════════════════════');
                console.log(`[STEP 1.5] COMPLETE: ${bunksRestored} bunks, ${fieldsRegistered} field registrations`);
                console.log('[STEP 1.5] ═══════════════════════════════════════════════════\n');

                return { bunksRestored, fieldsRegistered };
            };

            console.log('[Step1.5Patch] ✅ Loaded');

        })();

        // ★★★ EXECUTE STEP 1.5 WITH TIME MAPPING ★★★
        if (existingScheduleSnapshot && Object.keys(existingScheduleSnapshot).length > 0) {
            window.executeStep1_5(
                existingScheduleSnapshot,
                divisions,
                allowedDivisions,
                fieldUsageBySlot,
                activityProperties,
                existingUnifiedTimes
            );
        } else if (allowedDivisions) {
            console.log('[STEP 1.5] No snapshot provided - generating fresh for allowed divisions only');
        }

        // =========================================================================
        // STEP 2: Process Bunk Overrides (Pinned specific bunks)
        // =========================================================================

        console.log("\n[STEP 2] Processing bunk overrides...");
        const bunkOverrides = window.loadCurrentDailyData?.().bunkActivityOverrides || [];

        bunkOverrides.forEach(override => {
            const activityName = override.activity;
            const overrideType = override.type;
            const startMin = Utils.parseTimeToMinutes(override.startTime);
            const endMin = Utils.parseTimeToMinutes(override.endTime);
            const bunk = override.bunk;
            const divName = Object.keys(divisions).find(d => divisions[d].bunks?.includes(bunk));
            const slots = Utils.findSlotsForRange(startMin, endMin, divName);

            if (!divName || slots.length === 0) {
                console.warn(`[BunkOverride] Skipping ${bunk} - no division found or no slots`);
                return;
            }

            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(divName))) {
                return; 
            }

            console.log(`[BunkOverride] ${bunk}: ${activityName} (${overrideType}) @ ${override.startTime}-${override.endTime}`);

            if (overrideType === 'trip') {
                slots.forEach((slotIndex, i) => {
                    window.scheduleAssignments[bunk][slotIndex] = {
                        field: activityName,
                        sport: null,
                        continuation: i > 0,
                        _fixed: true,
                        _activity: activityName,
                        _isTrip: true,
                        _bunkOverride: true,
                        _zone: 'offsite'
                    };
                });
                console.log(`   → Trip pinned for ${bunk}, no field usage registered`);

            } else if (overrideType === 'sport') {
                let fieldName = activityName;
                const fieldsBySportData = fieldsBySport || {};

                const fieldsForSport = fieldsBySportData[activityName] || [];

                if (fieldsForSport.length > 0) {
                    for (const candidateField of fieldsForSport) {
                        if (window.GlobalFieldLocks?.isFieldLocked(candidateField, slots, divName)) {
                            continue;
                        }

                        // ★★★ FIX v17.10: Use centralized capacity calculation ★★★
                        const maxCapacity = getFieldCapacityLocal(candidateField, activityProperties);

                        let canUse = true;
                        for (const slotIdx of slots) {
                            const usage = fieldUsageBySlot[slotIdx]?.[candidateField];
                            if (usage && usage.count >= maxCapacity) {
                                canUse = false;
                                break;
                            }
                        }

                        if (canUse) {
                            fieldName = candidateField;
                            break;
                        }
                    }
                }

                fillBlock({
                    divName,
                    bunk,
                    startTime: startMin,
                    endTime: endMin,
                    slots
                }, {
                    field: fieldName,
                    sport: activityName,
                    _fixed: true,
                    _activity: activityName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                console.log(`   → Sport ${activityName} assigned to ${bunk} on field ${fieldName}`);

            } else if (overrideType === 'special') {
                if (window.GlobalFieldLocks?.isFieldLocked(activityName, slots, divName)) {
                    console.warn(`   → Special ${activityName} is LOCKED for ${divName}, cannot assign to ${bunk}`);
                    return;
                }

                const locName = getLocationForActivity(activityName);
                if (locName && !canScheduleAtLocation(activityName, locName, slots)) {
                    console.warn(`[BunkOverride] ${activityName} blocked for ${bunk} - location ${locName} in use`);
                    return;
                }

                // ★★★ FIX v17.10: Use centralized capacity calculation ★★★
                const maxCapacity = getFieldCapacityLocal(activityName, activityProperties);

                let hasRoom = true;
                for (const slotIdx of slots) {
                    const usage = fieldUsageBySlot[slotIdx]?.[activityName];
                    if (usage && usage.count >= maxCapacity) {
                        hasRoom = false;
                        break;
                    }
                }

                if (!hasRoom) {
                    console.warn(`   → Special ${activityName} at capacity, cannot assign to ${bunk}`);
                    return;
                }

                fillBlock({
                    divName,
                    bunk,
                    startTime: startMin,
                    endTime: endMin,
                    slots
                }, {
                    field: activityName,
                    sport: null,
                    _fixed: true,
                    _activity: activityName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);

               registerActivityAtLocation(activityName, locName, slots, divName);

                // ★ v17.11: Lock field if special has a location assigned
                if (locName && window.GlobalFieldLocks) {
                    window.GlobalFieldLocks.lockField(locName, slots, {
                        lockedBy: 'special_activity_location',
                        division: divName,
                        activity: `${activityName} (special @ ${locName})`
                    });
                    console.log(`   → Locked field "${locName}" for special "${activityName}"`);
                }

                console.log(`   → Special ${activityName} assigned to ${bunk}`);

            } else {
                console.warn(`   → Unknown override type "${overrideType}", treating as pinned`);
                fillBlock({
                    divName,
                    bunk,
                    startTime: startMin,
                    endTime: endMin,
                    slots
                }, {
                    field: activityName,
                    sport: null,
                    _fixed: true,
                    _activity: activityName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
            }
        });

        console.log(`[BunkOverride] Processed ${bunkOverrides.length} overrides`);

        // =========================================================================
        // STEP 2.5: Process Elective Tiles
        // =========================================================================

        console.log("\n[STEP 2.5] Processing elective tiles...");
        const electiveTiles = manualSkeleton.filter(item => item.type === 'elective');

        electiveTiles.forEach(elective => {
            const electiveDivision = elective.division;
            
            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(electiveDivision))) {
                return;
            }
            
            const activities = elective.electiveActivities || [];
            const startMin = Utils.parseTimeToMinutes(elective.startTime);
            const endMin = Utils.parseTimeToMinutes(elective.endTime);
            const slots = Utils.findSlotsForRange(startMin, endMin, electiveDivision);

            if (activities.length === 0 || slots.length === 0) {
                console.warn(`[Elective] Skipping elective for ${electiveDivision} - no activities or slots`);
                return;
            }

            console.log(`[Elective] ${electiveDivision}: Reserving ${activities.join(', ')} @ ${elective.startTime}-${elective.endTime}`);

            activities.forEach(activityName => {
                let resolvedName = activityName;
                if (isSwimOrPool(activityName)) {
                    resolvedName = resolveSwimPoolName(activityName, activityProperties);
                    if (resolvedName !== activityName) {
                        console.log(`  [ALIAS] Resolved "${activityName}" → "${resolvedName}"`);
                    }
                }

                if (window.GlobalFieldLocks) {
                    window.GlobalFieldLocks.lockFieldForDivision(
                        resolvedName,
                        slots,
                        electiveDivision,
                        `Elective (${electiveDivision})`
                    );
                    console.log(`   → Locked "${resolvedName}" for ${electiveDivision} only`);

                    if (isSwimOrPool(resolvedName)) {
                        SWIM_POOL_ALIASES.forEach(alias => {
                            if (alias.toLowerCase() !== resolvedName.toLowerCase()) {
                                window.GlobalFieldLocks.lockFieldForDivision(
                                    alias,
                                    slots,
                                    electiveDivision,
                                    `Elective (${electiveDivision}) - Pool Alias`
                                );
                            }
                        });
                    }
                }
            });
        });

        console.log(`[Elective] Processed ${electiveTiles.length} elective tiles`);

        // =========================================================================
        // STEP 3: Categorize Skeleton Blocks
        // =========================================================================

        console.log("\n[STEP 3] Categorizing skeleton blocks...");
        const schedulableSlotBlocks = [];
        const leagueBlocks = [];
        const specialtyLeagueBlocks = [];
        const GENERATOR_TYPES = ["slot", "activity", "sports", "special", "league", "specialty_league"];
        
        // ★★★ v17.5: Track pinned events for verification ★★★
        let pinnedEventCount = 0;

        manualSkeleton.forEach(item => {
            // ★★★ DIAGNOSTIC: Log D2 skeleton items to trace slot assignments ★★★
            if (item.division === '2' || item.division === 2) {
                const _diagStart = Utils.parseTimeToMinutes(item.startTime);
                const _diagEnd = Utils.parseTimeToMinutes(item.endTime);
                // ★★★ v17.9 FIX: Use exact slot matching in diagnostic too ★★★
                const _exactSlot = findExactSlotForTimeRange('2', _diagStart, _diagEnd);
                const _diagSlots = _exactSlot !== -1 ? [_exactSlot] : Utils.findSlotsForRange(_diagStart, _diagEnd, '2');
                console.log(`[D2-TRACE] Skeleton: "${item.event}" ${item.startTime}-${item.endTime} (${_diagStart}-${_diagEnd}) type=${item.type} → slots=[${_diagSlots.join(',')}]`);
            }

            const divName = item.division;
            const bunkList = divisions[divName]?.bunks || [];
            if (bunkList.length === 0) return;

            // ★★★ PARTIAL GEN CHECK ★★★
            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(divName))) {
                return;
            }

            const sMin = Utils.parseTimeToMinutes(item.startTime);
            const eMin = Utils.parseTimeToMinutes(item.endTime);

            // ★★★ v17.5 FIX: Process PINNED events FIRST (before overlap check) ★★★
            const isPinnedType = item.type === 'pinned' || 
                                 item.pinned === true ||
                                 ['lunch', 'snacks', 'dismissal', 'regroup', 'swim'].some(
                                     pt => (item.type || '').toLowerCase() === pt ||
                                           (item.event || '').toLowerCase().includes(pt)
                                 );
            
            if (isPinnedType && item.type !== 'split' && item.type !== 'smart') {
                // ★★★ v17.9 FIX: Use exact slot matching for pinned events too ★★★
                const exactSlot = findExactSlotForTimeRange(divName, sMin, eMin);
                const slots = exactSlot !== -1 ? [exactSlot] : Utils.findSlotsForRange(sMin, eMin, divName);
                if (slots.length > 0) {
                    const eventName = item.event || item.type || 'Pinned Event';
                    
                    bunkList.forEach(bunk => {
                        const existing = window.scheduleAssignments[bunk]?.[slots[0]];
                        if (existing && existing._bunkOverride) return;

                        fillBlock({
                            divName,
                            bunk,
                            startTime: sMin,
                            endTime: eMin,
                            slots
                        }, {
                            field: eventName,
                            sport: null,
                            _fixed: true,
                            _pinned: true,
                            _activity: eventName
                        }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                        
                        pinnedEventCount++;
                    });
                    
                    console.log(`[SKELETON] ✅ Filled pinned "${eventName}" for ${divName} (${bunkList.length} bunks)`);

                    // ★ v17.11: Lock physical location if pinned event uses one
                    const pinnedLocName = getLocationForPinnedEvent(item);
                    if (pinnedLocName && window.GlobalFieldLocks) {
                        window.GlobalFieldLocks.lockField(pinnedLocName, slots, {
                            lockedBy: 'pinned_event_location',
                            division: divName,
                            activity: `${eventName} (pinned @ ${pinnedLocName})`
                        });
                        console.log(`[SKELETON] 🔒 Locked "${pinnedLocName}" for pinned "${eventName}" in ${divName}`);
                    }
                }
                return; // Done with this item
            }

            // Skip slots that overlap with pinned events
            if (item.type === 'slot' || GENERATOR_TYPES.includes(item.type)) {
                const hasPinnedOverlap = manualSkeleton.some(other =>
                    other.division === divName &&
                    (other.type === 'pinned' || other.pinned === true) &&
                    Utils.parseTimeToMinutes(other.startTime) < eMin &&
                    Utils.parseTimeToMinutes(other.endTime) > sMin
                );

                if (hasPinnedOverlap) {
                    console.log(`[SKELETON] Skipping ${item.event} for ${divName} - overlaps with pinned event`);
                    return;
                }
            }

            // =========================================================================
            // SPLIT TILE LOGIC
            // =========================================================================
            if (item.type === 'split') {
                console.log(`[SPLIT] ═══════════════════════════════════════════════════════`);
                console.log(`[SPLIT] Processing split tile for ${divName}: ${item.event}`);
                console.log(`[SPLIT] ═══════════════════════════════════════════════════════`);
                
                const sortedBunks = [...bunkList].sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/)?.[0] || 0);
                    const numB = parseInt(b.match(/\d+/)?.[0] || 0);
                    return numA - numB || a.localeCompare(b);
                });
                
                const midMin = Math.floor(sMin + (eMin - sMin) / 2);
                
                const half = Math.ceil(sortedBunks.length / 2);
                const groupA = sortedBunks.slice(0, half);
                const groupB = sortedBunks.slice(half);

                let act1Name, act2Name;
                
                if (item.subEvents && item.subEvents.length >= 2) {
                    const sub0 = item.subEvents[0];
                    const sub1 = item.subEvents[1];
                    act1Name = typeof sub0 === 'string' ? sub0 : (sub0?.event || "Activity 1");
                    act2Name = typeof sub1 === 'string' ? sub1 : (sub1?.event || "Activity 2");
                } else {
                    const parts = (item.event || "").split('/').map(s => s.trim());
                    act1Name = parts[0] || "Activity 1";
                    act2Name = parts[1] || "Activity 2";
                }

                if (isSwimOrPool(act1Name)) {
                    act1Name = resolveSwimPoolName(act1Name, activityProperties);
                }
                if (isSwimOrPool(act2Name)) {
                    act2Name = resolveSwimPoolName(act2Name, activityProperties);
                }

                console.log(`[SPLIT] Main 1 (act1Name): "${act1Name}"`);
                console.log(`[SPLIT] Main 2 (act2Name): "${act2Name}"`);
                console.log(`[SPLIT] Time block: ${sMin} to ${eMin} (midpoint: ${midMin})`);
                console.log(`[SPLIT] Group 1 (${groupA.length} bunks): ${groupA.join(', ')}`);
                console.log(`[SPLIT] Group 2 (${groupB.length} bunks): ${groupB.join(', ')}`);
                console.log(`[SPLIT] ---------------------------------------------------`);
                console.log(`[SPLIT] FIRST HALF (${sMin}-${midMin}):`);
                console.log(`[SPLIT]    Group 1 → ${act1Name} (main 1)`);
                console.log(`[SPLIT]    Group 2 → ${act2Name} (main 2)`);
                console.log(`[SPLIT] SECOND HALF (${midMin}-${eMin}):`);
                console.log(`[SPLIT]    Group 1 → ${act2Name} (main 2) ← SWITCHED`);
                console.log(`[SPLIT]    Group 2 → ${act1Name} (main 1) ← SWITCHED`);
                console.log(`[SPLIT] ---------------------------------------------------`);

                const routeSplitActivity = (bunks, actName, start, end, groupLabel, actLabel) => {
                    // ★★★ FIXED: Find exact slot for this time range ★★★
                    const exactSlot = findExactSlotForTimeRange(divName, start, end);
                    const fallbackSlots = Utils.findSlotsForRange(start, end, divName);
                    const targetSlots = exactSlot !== -1 ? [exactSlot] : fallbackSlots;
                    
                    if (targetSlots.length === 0) {
                        console.warn(`[SPLIT] WARNING: No slots found for range ${start}-${end} in ${divName}`);
                        return;
                    }
                    
                    console.log(`[SPLIT] Using slot ${targetSlots[0]} for time range ${start}-${end}`);
                    const normName = normalizeGA(actName) || actName;
                    const isGen = isGeneratedType(normName);

                    bunks.forEach(b => {
                        // Ensure bunk has proper slot array
                        if (!window.scheduleAssignments[b]) {
                            const divSlots = window.divisionTimes?.[divName] || [];
                            window.scheduleAssignments[b] = new Array(divSlots.length).fill(null);
                        }

                        const existing = window.scheduleAssignments[b]?.[targetSlots[0]];
                        if (existing && existing._bunkOverride) {
                            console.log(`[SPLIT]    ⏭️ ${b} - skipping (has bunk override)`);
                            return;
                        }

                        if (isGen) {
                            // ★★★ v17.7 FIX: Queue for Total Solver with ALL split tile metadata ★★★
                            schedulableSlotBlocks.push({
                                divName,
                                bunk: b,
                                event: normName,
                                type: 'slot',
                                startTime: start,
                                endTime: end,
                                slots: targetSlots,
                                fromSplitTile: true,
                                _fromSplitTile: true,  // ★★★ ADD: Redundant flag for fillBlock compatibility ★★★
                                _splitTimeStart: start,
                                _splitTimeEnd: end,
                                _splitHalf: start < midMin ? 1 : 2
                            });
                            console.log(`[SPLIT]    📋 ${b} → QUEUED for "${normName}" (${start}-${end}) @ slot ${targetSlots[0]}`);
                        } else {
                            // Direct fill into correct slot
                            fillBlock({
                                divName,
                                bunk: b,
                                startTime: start,
                                endTime: end,
                                slots: targetSlots,
                                fromSplitTile: true  // ★★★ ADD: Mark block as split tile ★★★
                            }, {
                                field: actName,
                                sport: null,
                                _fixed: true,
                                _activity: actName,
                                _fromSplitTile: true,
                                _startMin: start,
                                _endMin: end
                            }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                            console.log(`[SPLIT]    ✅ ${b} → FILLED with "${actName}" (${start}-${end}) @ slot ${targetSlots[0]}`);
                        }
                    });
                };

                console.log(`[SPLIT] \n>>> EXECUTING FIRST HALF (${sMin}-${midMin}) <<<`);
                console.log(`[SPLIT] Routing Group 1 to "${act1Name}" (main 1) for time ${sMin}-${midMin}`);
                routeSplitActivity(groupA, act1Name, sMin, midMin, "Group 1", "main 1");
                console.log(`[SPLIT] Routing Group 2 to "${act2Name}" (main 2) for time ${sMin}-${midMin}`);
                routeSplitActivity(groupB, act2Name, sMin, midMin, "Group 2", "main 2");
                
                console.log(`[SPLIT] \n>>> EXECUTING SECOND HALF (${midMin}-${eMin}) - SWITCH <<<`);
                console.log(`[SPLIT] Routing Group 1 to "${act2Name}" (main 2 (switched)) for time ${midMin}-${eMin}`);
                routeSplitActivity(groupA, act2Name, midMin, eMin, "Group 1", "main 2");
                console.log(`[SPLIT] Routing Group 2 to "${act1Name}" (main 1 (switched)) for time ${midMin}-${eMin}`);
                routeSplitActivity(groupB, act1Name, midMin, eMin, "Group 2", "main 1");

                console.log(`[SPLIT] ═══════════════════════════════════════════════════════`);
                console.log(`[SPLIT] ✅ Completed split tile for ${divName}`);
                console.log(`[SPLIT] ═══════════════════════════════════════════════════════\n`);
                return; // Done with this skeleton item
            }

            // =========================================================================
            // NON-SPLIT BLOCKS: Categorize into league/specialty/schedulable
            // =========================================================================
            
            // ★★★ v17.9 FIX: Use EXACT slot matching to prevent boundary overlap issues ★★★
            // findSlotsForRange returns overlapping slots (e.g., [4,5] when slot 4 ends at 880 and slot 5 starts at 880)
            // This causes blocks to target the wrong slot and get filtered out
            const exactSlot = findExactSlotForTimeRange(divName, sMin, eMin);
            const slots = exactSlot !== -1 ? [exactSlot] : Utils.findSlotsForRange(sMin, eMin, divName);
            if (slots.length === 0) return;

            const eventName = item.event || '';
            const normalizedLeague = normalizeLeague(eventName);
            const normalizedSpecialty = normalizeSpecialtyLeague(eventName);
            const normalizedGA = normalizeGA(eventName);

            // Check if it's a specialty league block
            if (normalizedSpecialty || item.type === 'specialty_league') {
                specialtyLeagueBlocks.push({
                    divName,
                    event: eventName,
                    startTime: sMin,
                    endTime: eMin,
                    slots,
                    bunks: bunkList,
                    type: 'specialty_league'
                });
                return;
            }

            // Check if it's a regular league block
            if (normalizedLeague || item.type === 'league') {
                leagueBlocks.push({
                    divName,
                    event: eventName,
                    startTime: sMin,
                    endTime: eMin,
                    slots,
                    bunks: bunkList,
                    type: 'league'
                });
                return;
            }

            // Check if it's a smart tile (handled separately)
            if (item.type === 'smart' || item.smartActivities) {
                return; // Smart tiles are processed in processSmartTiles
            }

            // General activity slot or other schedulable block
            if (normalizedGA || item.type === 'slot' || GENERATOR_TYPES.includes(item.type)) {
                bunkList.forEach(bunk => {
                    const existing = window.scheduleAssignments[bunk]?.[slots[0]];
                    if (existing && existing._bunkOverride) return;

                    schedulableSlotBlocks.push({
                        divName,
                        bunk,
                        event: normalizedGA || eventName,
                        type: 'slot',
                        startTime: sMin,
                        endTime: eMin,
                        slots
                    });
                });
            }
        }); // ★★★ END OF manualSkeleton.forEach ★★★

        // =========================================================================
        // ★★★ STEP 3.5: GAP DETECTION (FIXED with type coercion) ★★★
        // =========================================================================
        
        console.log("\n[STEP 3.5] Detecting unfilled slot gaps in divisionTimes...");
        
        let gapBlocksAdded = 0;
        
        // ★★★ DIAGNOSTIC: Show D2 blocks created so far ★★★
        console.log("[STEP 3.5-DIAG] D2 blocks by slot BEFORE gap detection:");
        const _d2Blocks = schedulableSlotBlocks.filter(b => String(b.divName) === '2');
        const _d2BySlot = {};
        _d2Blocks.forEach(b => {
            const s = b.slots?.[0] ?? 'none';
            _d2BySlot[s] = (_d2BySlot[s] || 0) + 1;
        });
        Object.entries(_d2BySlot).sort((a,b) => Number(a[0]) - Number(b[0])).forEach(([slot, count]) => {
            const marker = (slot === '5' || slot === 5 || slot === '7' || slot === 7) ? ' ← TARGET' : '';
            console.log(`[STEP 3.5-DIAG]    Slot ${slot}: ${count} blocks${marker}`);
        });
        
        // Process each division's divisionTimes for gap detection
        Object.entries(divisions).forEach(([divName, divData]) => {
            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(divName))) {
                return;
            }
            
            const bunkList = divData.bunks || [];
            if (bunkList.length === 0) return;
            
            const divSlots = window.divisionTimes?.[divName] || [];
            
            divSlots.forEach((slot, slotIdx) => {
                if (slot.type !== 'slot') return;
                if (slot._splitHalf) return;
                
                const slotStart = slot.startMin;
                const slotEnd = slot.endMin;
                
                // ★★★ FIXED: Use String() for divName comparison ★★★
                const hasBlocks = schedulableSlotBlocks.some(block => 
                    String(block.divName) === String(divName) &&
                    block.startTime === slotStart &&
                    block.endTime === slotEnd
                );
                
                // ★★★ DIAGNOSTIC: Log D2 gap check results ★★★
                if (String(divName) === '2' && (slotIdx === 5 || slotIdx === 7)) {
                    console.log(`[STEP 3.5-DIAG] D2 slot ${slotIdx} (${slotStart}-${slotEnd}): hasBlocks=${hasBlocks}`);
                }
                
                if (!hasBlocks) {
                    console.log(`[GAP] Adding blocks for ${divName} slot ${slotIdx}: ${slot.label || slot.event} (${slotStart}-${slotEnd})`);
                    
                    bunkList.forEach(bunk => {
                        const existing = window.scheduleAssignments[bunk]?.[slotIdx];
                        if (existing && existing._bunkOverride) return;
                        if (existing && existing._activity && existing._activity !== TRANSITION_TYPE) return;
                        
                        schedulableSlotBlocks.push({
                            divName: String(divName),
                            bunk,
                            event: 'General Activity Slot',
                            type: 'slot',
                            startTime: slotStart,
                            endTime: slotEnd,
                            slots: [slotIdx],
                            _fromGapDetection: true
                        });
                        gapBlocksAdded++;
                    });
                }
            });
        });
        
        if (gapBlocksAdded > 0) {
            console.log(`[STEP 3.5] ✅ Added ${gapBlocksAdded} gap blocks for unfilled slots`);
        } else {
            console.log(`[STEP 3.5] No gaps detected`);
        }
        console.log(`[SKELETON] Categorized: ${specialtyLeagueBlocks.length} specialty league, ${leagueBlocks.length} regular league, ${schedulableSlotBlocks.length} general blocks`);
        console.log(`[SKELETON] ✅ Filled ${pinnedEventCount} pinned event assignments`);

        // =========================================================================
        // ★★★ STEP 4: PROCESS SPECIALTY LEAGUES FIRST ★★★
        // =========================================================================

        console.log("\n" + "=".repeat(50));
        console.log("★★★ STEP 4: SPECIALTY LEAGUES (PRIORITY 1) ★★★");
        console.log("=".repeat(50));

        const leagueContext = {
            schedulableSlotBlocks: specialtyLeagueBlocks,
            fieldUsageBySlot,
            activityProperties,
            masterSpecialtyLeagues,
            disabledSpecialtyLeagues,
            masterLeagues,
            disabledLeagues,
            rotationHistory,
            yesterdayHistory,
            divisions,
            fieldsBySport,
            dailyLeagueSportsUsage: {},
            fillBlock,
            fields: config.masterFields || [],
            leagueAssignments: window.leagueAssignments,
            storeLeagueMatchups: function(divName, slots, matchups, gameLabel, sport, leagueName) {
                if (!window.leagueAssignments[divName]) {
                    window.leagueAssignments[divName] = {};
                }
                for (const slotIdx of slots) {
                    if (!window.leagueAssignments[divName][slotIdx]) {
                        window.leagueAssignments[divName][slotIdx] = {
                            matchups: matchups || [],
                            gameLabel: gameLabel || '',
                            sport: sport || '',
                            leagueName: leagueName || ''
                        };
                        console.log(`[storeLeagueMatchups] ✅ Stored ${(matchups || []).length} matchups for ${divName} at slot ${slotIdx}`);
                    }
                }
            }
        };

        if (window.SchedulerCoreSpecialtyLeagues?.processSpecialtyLeagues) {
            window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(leagueContext);
        }

        // =========================================================================
        // ★★★ STEP 5: PROCESS REGULAR LEAGUES SECOND ★★★
        // =========================================================================

        console.log("\n" + "=".repeat(50));
        console.log("★★★ STEP 5: REGULAR LEAGUES (PRIORITY 2) ★★★");
        console.log("=".repeat(50));

        leagueContext.schedulableSlotBlocks = leagueBlocks;
        if (window.SchedulerCoreLeagues?.processRegularLeagues) {
            window.SchedulerCoreLeagues.processRegularLeagues(leagueContext);
        }

        // =========================================================================
        // ★★★ STEP 5.5: CONSOLIDATE LEAGUE ASSIGNMENTS ★★★
        // =========================================================================

        console.log("\n[STEP 5.5] Consolidating league assignments...");
        
        let activeLeagues = [];
        if (Array.isArray(masterLeagues)) {
            activeLeagues = masterLeagues.filter(l => !disabledLeagues?.includes(l.name));
        } else if (masterLeagues && typeof masterLeagues === 'object') {
            activeLeagues = Object.values(masterLeagues).filter(l => l && !disabledLeagues?.includes(l.name));
        }
        
        let activeSpecialtyLeagues = [];
        if (Array.isArray(masterSpecialtyLeagues)) {
            activeSpecialtyLeagues = masterSpecialtyLeagues.filter(l => !disabledSpecialtyLeagues?.includes(l.id));
        } else if (masterSpecialtyLeagues && typeof masterSpecialtyLeagues === 'object') {
            activeSpecialtyLeagues = Object.values(masterSpecialtyLeagues).filter(l => l && !disabledSpecialtyLeagues?.includes(l.id));
        }
        
        console.log(`[STEP 5.5] Active leagues: ${activeLeagues.length}, Specialty: ${activeSpecialtyLeagues.length}`);
        
        leagueBlocks.forEach(block => {
            const divName = block.divName;
            const slots = block.slots || [];
            if (slots.length === 0) return;
            
            const applicableLeagues = activeLeagues.filter(league => {
                return league.divisions?.includes(divName);
            });
            
            applicableLeagues.forEach(league => {
                const leagueTeams = league.teams || [];
                if (leagueTeams.length < 2) return;
                
                if (!window.leagueAssignments[divName]) {
                    window.leagueAssignments[divName] = {};
                }
                
                const slotIdx = slots[0];
                
                if (window.leagueAssignments[divName][slotIdx]?.matchups?.length > 0) {
                    console.log(`   ✓ ${divName} slot ${slotIdx}: Already has ${window.leagueAssignments[divName][slotIdx].matchups.length} matchups`);
                    return;
                }
                
                let foundMatchups = [];
                let foundGameLabel = league.name + ' Game';
                let foundSport = league.sports?.[0] || '';
                
                const bunks = divisions[divName]?.bunks || [];
                for (const bunk of bunks) {
                    const entry = window.scheduleAssignments[bunk]?.[slotIdx];
                    if (entry && entry._allMatchups && entry._allMatchups.length > 0) {
                        foundMatchups = entry._allMatchups;
                        foundGameLabel = entry._gameLabel || foundGameLabel;
                        foundSport = entry.sport || foundSport;
                        break;
                    }
                }
                
                if (foundMatchups.length === 0 && window.lastLeagueMatchups?.[divName]) {
                    const lastData = window.lastLeagueMatchups[divName];
                    foundMatchups = lastData.matchups || [];
                    foundGameLabel = lastData.gameLabel || foundGameLabel;
                    foundSport = lastData.sport || foundSport;
                }
                
                if (foundMatchups.length === 0 && leagueTeams.length >= 2) {
                    console.log(`   ⚠️ No stored matchups for ${league.name} in ${divName}, generating from team config`);
                    
                    for (let i = 0; i < leagueTeams.length - 1; i += 2) {
                        const teamA = leagueTeams[i];
                        const teamB = leagueTeams[i + 1];
                        if (teamA && teamB) {
                            foundMatchups.push({
                                teamA: teamA,
                                teamB: teamB,
                                display: `${teamA} vs ${teamB}`
                            });
                        }
                    }
                    if (leagueTeams.length % 2 === 1) {
                        foundMatchups.push({
                            teamA: leagueTeams[leagueTeams.length - 1],
                            teamB: 'BYE',
                            display: `${leagueTeams[leagueTeams.length - 1]} (BYE)`
                        });
                    }
                }
                
                if (foundMatchups.length > 0) {
                    window.leagueAssignments[divName][slotIdx] = {
                        matchups: foundMatchups,
                        gameLabel: foundGameLabel,
                        sport: foundSport,
                        leagueName: league.name,
                        teams: leagueTeams
                    };
                    console.log(`   ✅ League "${league.name}" for ${divName} @ slot ${slotIdx}: ${foundMatchups.length} matchups`);
                }
            });
        });
        
        specialtyLeagueBlocks.forEach(block => {
            const divName = block.divName;
            const slots = block.slots || [];
            if (slots.length === 0) return;
            
            const applicableLeagues = activeSpecialtyLeagues.filter(league => {
                return league.divisions?.includes(divName);
            });
            
            applicableLeagues.forEach(league => {
                const leagueTeams = league.teams || [];
                if (leagueTeams.length < 2) return;
                
                if (!window.leagueAssignments[divName]) {
                    window.leagueAssignments[divName] = {};
                }
                
                const slotIdx = slots[0];
                
                if (window.leagueAssignments[divName][slotIdx]?.matchups?.length > 0) {
                    return;
                }
                
                let foundMatchups = [];
                let foundGameLabel = (league.name || league.id) + ' Game';
                let foundSport = league.sport || '';
                
                const bunks = divisions[divName]?.bunks || [];
                for (const bunk of bunks) {
                    const entry = window.scheduleAssignments[bunk]?.[slotIdx];
                    if (entry && entry._allMatchups && entry._allMatchups.length > 0) {
                        foundMatchups = entry._allMatchups;
                        foundGameLabel = entry._gameLabel || foundGameLabel;
                        if (entry.sport) foundSport = entry.sport;
                        break;
                    }
                }
                
                if (foundMatchups.length === 0 && leagueTeams.length >= 2) {
                    for (let i = 0; i < leagueTeams.length - 1; i += 2) {
                        const teamA = leagueTeams[i];
                        const teamB = leagueTeams[i + 1];
                        if (teamA && teamB) {
                            foundMatchups.push({
                                teamA: teamA,
                                teamB: teamB,
                                display: `${teamA} vs ${teamB}`
                            });
                        }
                    }
                }
                
                if (foundMatchups.length > 0) {
                    window.leagueAssignments[divName][slotIdx] = {
                        matchups: foundMatchups,
                        gameLabel: foundGameLabel,
                        sport: foundSport,
                        leagueName: league.name || league.id,
                        teams: leagueTeams,
                        isSpecialtyLeague: true
                    };
                    console.log(`   ✅ Specialty League "${league.name || league.id}" for ${divName} @ slot ${slotIdx}: ${foundMatchups.length} matchups`);
                }
            });
        });
        
        console.log(`[STEP 5.5] League assignments consolidated for ${Object.keys(window.leagueAssignments).length} divisions`);

        // =========================================================================
        // STEP 6: PROCESS SMART TILES
        // =========================================================================

        console.log("\n[STEP 6] Processing Smart Tiles...");
        const smartTileBlocks = processSmartTiles(manualSkeleton, externalOverrides, {
            divisions,
            activityProperties,
            masterSpecials,
            dailyFieldAvailability,
            historicalCounts,
            specialActivityNames,
            yesterdayHistory,
            fieldUsageBySlot
        }, allowedDivisionsSet || allowedDivisions);

        schedulableSlotBlocks.push(...smartTileBlocks);
        console.log(`[SmartTile] Added ${smartTileBlocks.length} blocks to scheduler`);

        // =========================================================================
        // STEP 7: RUN TOTAL SOLVER FOR REMAINING ACTIVITIES
        // =========================================================================

        console.log("\n[STEP 7] Running Total Solver for remaining activities...");

        // ★★★ DIAGNOSTIC: Check D2 slots 5 & 7 status before filter ★★★
        console.log("\n[STEP 7-DIAG] Checking D2 bunk assignments at slots 5 & 7:");
        const _d2BunkSample = divisions['2']?.bunks?.slice(0, 3) || [];
        _d2BunkSample.forEach(bunk => {
            [5, 7].forEach(slotIdx => {
                const entry = window.scheduleAssignments[bunk]?.[slotIdx];
                const status = entry ? `FILLED: ${entry._activity || entry.field || JSON.stringify(entry).substring(0,50)}` : 'NULL ✓';
                console.log(`[STEP 7-DIAG]    Bunk ${bunk} slot ${slotIdx}: ${status}`);
            });
        });
        
        // ★★★ DIAGNOSTIC: Count D2 blocks by target slot ★★★
        const _d2Slot5Count = schedulableSlotBlocks.filter(b => 
            String(b.divName) === '2' && b.slots?.[0] === 5 && !(/league/i.test(b.event))
        ).length;
        const _d2Slot7Count = schedulableSlotBlocks.filter(b => 
            String(b.divName) === '2' && b.slots?.[0] === 7 && !(/league/i.test(b.event))
        ).length;
        console.log(`[STEP 7-DIAG] D2 blocks targeting slot 5: ${_d2Slot5Count}`);
        console.log(`[STEP 7-DIAG] D2 blocks targeting slot 7: ${_d2Slot7Count}`);

        // ★★★ v17.7 FIX: Improved filter to properly handle split tile blocks ★★★
        const remainingActivityBlocks = schedulableSlotBlocks
            .filter(b => {
                const isLeague = /league/i.test(b.event) || b.type === 'league' || b.type === 'specialty_league';
                return !isLeague && !b.processed;
            })
            .filter(block => {
                const s = block.slots;
                if (!s || s.length === 0) return false;
                
                const existing = window.scheduleAssignments[block.bunk]?.[s[0]];
                if (existing && existing._bunkOverride) return false;
                
                // ★★★ v17.7 FIX: Split tile blocks ALWAYS pass filter if slot is empty/transition ★★★
                if (block.fromSplitTile || block._fromSplitTile) {
                    // Empty slot - always allow
                    if (!existing) return true;
                    // Transition type - allow
                    if (existing._activity === TRANSITION_TYPE) return true;
                    // Already has split tile data for SAME time range - skip (duplicate)
                    if (existing._fromSplitTile && existing._startMin === block.startTime && existing._endMin === block.endTime) {
                        return false;
                    }
                    // Otherwise allow - different time range in same slot index (shouldn't happen but be safe)
                    return true;
                }
                
                // ★★★ DIAGNOSTIC: Log D2 slots 5 & 7 filter removals ★★★
                if (existing && existing._activity !== TRANSITION_TYPE) {
                    if (String(block.divName) === '2' && (s[0] === 5 || s[0] === 7)) {
                        console.log(`[FILTER] ★ REMOVED D2 bunk ${block.bunk} slot ${s[0]}: existing._activity="${existing._activity}" existing.field="${existing.field}"`);
                    }
                    return false;
                }
                return !existing || existing._activity === TRANSITION_TYPE;
            })
            .map(b => ({ ...b, _isLeague: false }));

        console.log(`[SOLVER] Processing ${remainingActivityBlocks.length} activity blocks.`);

        if (window.totalSolverEngine && remainingActivityBlocks.length > 0) {
            window.totalSolverEngine.solveSchedule(remainingActivityBlocks, config);
        }

        // =========================================================================
        // STEP 8: Update History
        // =========================================================================

        // ★★★ UPDATE ROTATION HISTORY (timestamps) AND HISTORICAL COUNTS ★★★
        try {
            const newHistory = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
            newHistory.bunks = newHistory.bunks || {};
            newHistory.leagues = newHistory.leagues || {};

            const timestamp = Date.now();

            Object.keys(window.scheduleAssignments || {}).forEach(bunk => {
                (window.scheduleAssignments[bunk] || []).forEach(entry => {
                    if (entry?._activity && !entry.continuation && !entry._isTransition) {
                        const actName = entry._activity;

                        // Skip "Free" and transition types
                        const actLower = actName.toLowerCase();
                        if (actLower === 'free' || actLower.includes('transition')) {
                            return;
                        }

                        // Update rotation history (timestamps)
                        newHistory.bunks[bunk] = newHistory.bunks[bunk] || {};
                        newHistory.bunks[bunk][actName] = timestamp;
                    }
                });
            });

            window.saveRotationHistory?.(newHistory);

            // ★★★ REBUILD HISTORICAL COUNTS FROM ALL SCHEDULES ★★★
            // This ensures counts are accurate even after regeneration (no double-counting)
            if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                // Small delay to ensure schedule is saved first
                setTimeout(() => {
                    window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
                }, 200);
            } else {
                console.warn('[OPTIMIZER] rebuildHistoricalCounts not available - counts may be stale');
            }

            console.log('📊 Rotation history updated, historical counts rebuild scheduled');

        } catch (e) {
            console.error("History update failed:", e);
        }

        window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
        window.updateTable?.();
        window.saveSchedule?.();

        console.log("\n" + "=".repeat(70));
        console.log("★★★ OPTIMIZER FINISHED SUCCESSFULLY ★★★");
        console.log("=".repeat(70));

        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.debugPrintLocks();
        }

        return true;
    };

    // =========================================================================
    // LEGACY ALIAS
    // =========================================================================
    window.runOptimizer = window.runSkeletonOptimizer;

    // =========================================================================
    // ★★★ FIXED v17.10: registerSingleSlotUsage with correct capacity logic ★★★
    // =========================================================================
    function registerSingleSlotUsage(slotIndex, fieldName, divName, bunkName, activityName, fieldUsageBySlot, activityProperties) {
        if (slotIndex == null || !fieldName) return;
        const key = typeof fieldName === 'string' ? fieldName : (fieldName?.name || String(fieldName));
        
        // ★★★ FIX v17.10: Use centralized capacity calculation ★★★
        const cap = getFieldCapacityLocal(key, activityProperties);

        if (!fieldUsageBySlot[slotIndex]) fieldUsageBySlot[slotIndex] = {};
        const existingUsage = fieldUsageBySlot[slotIndex][key] || {
            count: 0,
            divisions: [],
            bunks: {}
        };
        if (existingUsage.count >= cap) return;

        existingUsage.count++;
        if (bunkName) existingUsage.bunks[bunkName] = activityName || key;
        if (divName && !existingUsage.divisions.includes(divName)) existingUsage.divisions.push(divName);
        fieldUsageBySlot[slotIndex][key] = existingUsage;
    }

    window.registerSingleSlotUsage = registerSingleSlotUsage;

    // ★★★ FIX v17.11: Expose core optimizer for division_times_integration.js ★★★
    window._coreRunSkeletonOptimizer = window.runSkeletonOptimizer;

    console.log('⚙️ Scheduler Core Main v17.11 loaded (RBAC + CAPACITY FIX)');

})();
