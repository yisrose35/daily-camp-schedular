// ============================================================================
// scheduler_core_main.js (FIXED v17 - FOREACH CLOSURE FIX)
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
// v17 FIX: Fixed forEach loop that wasn't properly closed, causing Steps 4-8
//          to be nested inside the loop instead of after it.
// ============================================================================

(function() {
    'use strict';

    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";

    // -------------------------------------------------------------------------
    // RAINY DAY MODE HELPERS
    // -------------------------------------------------------------------------

    function isRainyDayModeActive() {
        const dailyData = window.loadCurrentDailyData?.() || {};
        return dailyData.rainyDayMode === true;
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
    // LOCATION CONFLICT HELPERS
    // -------------------------------------------------------------------------

    function canScheduleAtLocation(activityName, locationName, slots) {
        if (!locationName) return true;

        // ★★★ FIX: Use comprehensive field usage from ALL divisions ★★★
        // buildFieldUsageBySlot() scans scheduleAssignments for ALL bunks,
        // not just the current scheduler's real-time reservations
        const comprehensiveUsage = window.buildFieldUsageBySlot?.() || {};
        
        // Get capacity for this location from global settings
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || globalSettings.fields || [];
        const fieldConfig = fields.find(f => f.name?.toLowerCase() === locationName.toLowerCase());
        
        let maxCapacity = 1;
        if (fieldConfig?.sharableWith?.capacity) {
            maxCapacity = parseInt(fieldConfig.sharableWith.capacity) || 1;
        } else if (fieldConfig?.sharable) {
            maxCapacity = 2;
        }
        
        // Also check activityProperties for capacity info
        const actProps = window.activityProperties?.[locationName] || {};
        if (actProps.sharableWith?.capacity) {
            maxCapacity = Math.max(maxCapacity, parseInt(actProps.sharableWith.capacity) || 1);
        } else if (actProps.sharable) {
            maxCapacity = Math.max(maxCapacity, 2);
        }

        for (const slotIdx of slots) {
            const slotUsage = comprehensiveUsage[slotIdx]?.[locationName];
            if (slotUsage) {
                // Check if at capacity
                if (slotUsage.count >= maxCapacity) {
                    // Field is at capacity - check if all users are same activity (shareable case)
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
        if (skeletonEvent.location) {
            return skeletonEvent.location;
        }
        return getLocationForActivity(skeletonEvent.event);
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

    function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, isLeagueFill = false, activityProperties) {
        const Utils = window.SchedulerCoreUtils;
        
        // ★★★ SAFETY: Handle missing block gracefully ★★★
        if (!block) {
            console.error('[fillBlock] Block is null/undefined');
            return;
        }
        
        // ★★★ SPECIAL CASE: League blocks with bunks array (teams ≠ bunks) ★★★
        // When league cores call fillBlock with a league block, the block has a `bunks` array
        // (all bunks in division) but NO specific `bunk` property because:
        // - League TEAMS are separate entities defined in leagues.js
        // - Teams consist of people from MULTIPLE bunks
        // - We should NOT write to individual bunk schedules for league games
        // - Instead, store the matchup data at the DIVISION level
        if (block.type === 'league' && block.bunks && !block.bunk && !block.team) {
            console.log(`[fillBlock] League block for ${block.divName} - storing matchups only (teams ≠ bunks)`);
            
            // Store league matchups at division level
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
            return; // Don't try to write to individual bunks for league blocks
        }
        
        // If bunk is missing, try to get it from alternative properties (leagues use different format)
        let bunk = block.bunk;
        if (!bunk && block.team) bunk = block.team;
        if (!bunk && block.bunkName) bunk = block.bunkName;
        
        if (!bunk) {
            console.warn('[fillBlock] No bunk found in block:', JSON.stringify(block).substring(0, 200));
            return;
        }
        
        // Normalize bunk to the block object
        block.bunk = bunk;
        
        // ★★★ SAFETY: Compute slots if missing ★★★
        if (!block.slots || block.slots.length === 0) {
            if (block.startTime !== undefined && block.endTime !== undefined) {
                block.slots = Utils.findSlotsForRange(block.startTime, block.endTime);
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
        // bunk already extracted above
        const zone = trans.zone;

        // ★★★ CRITICAL: Initialize bunk array if not exists (MUST be done FIRST) ★★★
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
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
            const preSlots = Utils.findSlotsForRange(blockStartMin, effectiveStart);
            preSlots.forEach((slotIndex, i) => {
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
            });
        }

        let mainSlots = Utils.findSlotsForRange(effectiveStart, effectiveEnd);
        if (mainSlots.length === 0 && block.slots && block.slots.length > 0) {
            if (trans.preMin === 0 && trans.postMin === 0) mainSlots = block.slots;
        }

        if (mainSlots.length === 0) {
            console.error(`FillBlock: NO SLOTS for ${bunk} @ ${block.startTime}`);
            return;
        }

        mainSlots.forEach((slotIndex, i) => {
            const existing = window.scheduleAssignments[bunk][slotIndex];
            if (!existing || existing._isTransition) {
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
                    _bunkOverride: pick._bunkOverride || false
                };
                window.registerSingleSlotUsage(slotIndex, fName, block.divName, bunk, pick._activity || fName, fieldUsageBySlot, activityProperties);
            }
        });

        // ★★★ CRITICAL: Store league matchups in leagueAssignments by DIVISION ★★★
        // League teams are SEPARATE from bunks - matchups must be stored by division/slot
        // This allows the UI to retrieve team matchups without scanning bunks
        if ((pick._h2h || pick._allMatchups) && block.divName) {
            if (!window.leagueAssignments) window.leagueAssignments = {};
            if (!window.leagueAssignments[block.divName]) {
                window.leagueAssignments[block.divName] = {};
            }
            
            mainSlots.forEach(slotIndex => {
                // Only set if not already set (first write wins for this slot)
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
            const postSlots = Utils.findSlotsForRange(effectiveEnd, blockEndMin);
            postSlots.forEach((slotIndex, i) => {
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
                    "activity slot", "activity"
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
                const slots = Utils.findSlotsForRange(startMin, endMin);

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
                    console.log(`[SmartTile] ${bunk} - ${activityLabel} is LOCKED for ${divName}, skipping`);
                    return;
                }

                if (needsGeneration(activityLabel)) {
                    let slotType = "General Activity Slot";
                    const lower = activityLabel.toLowerCase().trim();
                    if (lower.includes("sport")) slotType = "Sports Slot";

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

    window.runSkeletonOptimizer = function(manualSkeleton, externalOverrides, allowedDivisions = null, existingScheduleSnapshot = null, existingUnifiedTimes = null) {
        console.log("\n" + "=".repeat(70));
        console.log("★★★ OPTIMIZER STARTED (v17 - FOREACH CLOSURE FIX) ★★★");

        // ★★★ SCHEDULER RESTRICTION ★★★
        if (window.AccessControl?.filterDivisionsForGeneration) {
            allowedDivisions = window.AccessControl.filterDivisionsForGeneration(allowedDivisions);
            if (allowedDivisions.length === 0) {
                alert("No divisions assigned. Contact camp owner.");
                return false;
            }
            console.log(`[RBAC] ★ SCHEDULER RESTRICTION APPLIED: Generating for [${allowedDivisions.join(', ')}] only`);
        }

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

        // ★★★ 2. AUTO-SNAPSHOT FOR PRESERVATION ★★★
        if (allowedDivisions && (!existingScheduleSnapshot || Object.keys(existingScheduleSnapshot).length === 0)) {
            console.log("[OPTIMIZER] Partial generation detected without snapshot. Attempting to preserve existing data...");
            
            let snapshotSource = window.scheduleAssignments;
            
            if (!snapshotSource || Object.keys(snapshotSource).length === 0) {
                 const currentData = window.loadCurrentDailyData?.() || {};
                 snapshotSource = currentData.scheduleAssignments;
            }

            if (snapshotSource && Object.keys(snapshotSource).length > 0) {
                existingScheduleSnapshot = JSON.parse(JSON.stringify(snapshotSource));
                if (!existingUnifiedTimes) existingUnifiedTimes = window.unifiedTimes;
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
        // STEP 1: Build Time Grid
        // =========================================================================

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
                window.unifiedTimes.push({
                    start: s,
                    end: e,
                    label: `${Utils.fmtTime(s)} - ${Utils.fmtTime(e)}`
                });
            }
        }

        Object.keys(divisions).forEach(divName => {
            (divisions[divName]?.bunks || []).forEach(b => window.scheduleAssignments[b] = new Array(window.unifiedTimes.length));
        });

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

                const newTimeMap = new Map();
                window.unifiedTimes.forEach((t, i) => {
                    const sig = getTimeSig(t);
                    if (sig) newTimeMap.set(sig, i);
                });

                console.log(`[Step1.5] Mapping existing data to ${window.unifiedTimes.length} slots...`);
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

                    if (!window.scheduleAssignments[bunkName]) {
                        window.scheduleAssignments[bunkName] = new Array(window.unifiedTimes.length);
                    }

                    for (let i = 0; i < slots.length; i++) {
                        if (slots[i]) {
                            let targetIndex = i;

                            if (existingUnifiedTimes && existingUnifiedTimes[i]) {
                                const oldSig = getTimeSig(existingUnifiedTimes[i]);
                                if (newTimeMap.has(oldSig)) {
                                    targetIndex = newTimeMap.get(oldSig);
                                } else {
                                    continue;
                                }
                            } else if (window.unifiedTimes.length !== slots.length) {
                                // Length mismatch, proceed with caution
                            }

                            if (targetIndex < window.scheduleAssignments[bunkName].length) {
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

                const newTimeMap = new Map();
                window.unifiedTimes.forEach((t, i) => {
                    const sig = getTimeSig(t);
                    if (sig) newTimeMap.set(sig, i);
                });

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

                        let targetIndex = i;
                        if (existingUnifiedTimes && existingUnifiedTimes[i]) {
                            const oldSig = getTimeSig(existingUnifiedTimes[i]);
                            if (newTimeMap.has(oldSig)) targetIndex = newTimeMap.get(oldSig);
                            else continue;
                        }

                        const fieldName = slotData.field;
                        const activityName = slotData._activity || fieldName;

                        if (fieldName === TRANSITION_TYPE || slotData._isTransition) continue;

                        if (!fieldUsageBySlot[targetIndex]) {
                            fieldUsageBySlot[targetIndex] = {};
                        }

                        const props = activityProperties?.[fieldName] || {};
                        let maxCapacity = 1;
                        if (props.sharableWith?.capacity) {
                            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                        } else if (props.sharable) {
                            maxCapacity = 2;
                        }

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
            const slots = Utils.findSlotsForRange(startMin, endMin);
            const bunk = override.bunk;
            const divName = Object.keys(divisions).find(d => divisions[d].bunks?.includes(bunk));

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

                        const props = activityProperties[candidateField] || {};
                        let maxCapacity = 1;
                        if (props.sharableWith?.capacity) {
                            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                        } else if (props.sharable) {
                            maxCapacity = 2;
                        }

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

                const props = activityProperties[activityName] || {};
                let maxCapacity = 1;
                if (props.sharableWith?.capacity) {
                    maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                } else if (props.sharable) {
                    maxCapacity = 2;
                }

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
            const slots = Utils.findSlotsForRange(startMin, endMin);

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

        manualSkeleton.forEach(item => {
            const divName = item.division;
            const bunkList = divisions[divName]?.bunks || [];
            if (bunkList.length === 0) return;

            // ★★★ PARTIAL GEN CHECK ★★★
            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(divName))) {
                return;
            }

            const sMin = Utils.parseTimeToMinutes(item.startTime);
            const eMin = Utils.parseTimeToMinutes(item.endTime);

            // Skip slots that overlap with pinned events
            if (item.type === 'slot' || GENERATOR_TYPES.includes(item.type)) {
                const hasPinnedOverlap = manualSkeleton.some(other =>
                    other.division === divName &&
                    other.type === 'pinned' &&
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
                    const slots = Utils.findSlotsForRange(start, end);
                    if (slots.length === 0) {
                        console.warn(`[SPLIT] WARNING: No slots found for range ${start}-${end}`);
                        return;
                    }

                    const normName = normalizeGA(actName) || actName;
                    const isGen = isGeneratedType(normName);

                    bunks.forEach(b => {
                        const existing = window.scheduleAssignments[b]?.[slots[0]];
                        if (existing && existing._bunkOverride) {
                            console.log(`[SPLIT]    ⏭️ ${b} - skipping (has bunk override)`);
                            return;
                        }

                        if (isGen) {
                            schedulableSlotBlocks.push({
                                divName,
                                bunk: b,
                                event: normName,
                                type: 'slot',
                                startTime: start,
                                endTime: end,
                                slots,
                                fromSplitTile: true
                            });
                            console.log(`[SPLIT]    📋 ${b} → QUEUED for "${normName}"`);
                        } else {
                            fillBlock({
                                divName,
                                bunk: b,
                                startTime: start,
                                endTime: end,
                                slots
                            }, {
                                field: actName,
                                sport: null,
                                _fixed: true,
                                _activity: actName,
                                _fromSplitTile: true
                            }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                            console.log(`[SPLIT]    ✅ ${b} → FILLED with "${actName}"`);
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
            
            const slots = Utils.findSlotsForRange(sMin, eMin);
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

            // Check if it's a pinned event
            if (item.type === 'pinned' || item.pinned) {
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
                        _activity: eventName
                    }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
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

        console.log(`[SKELETON] Categorized: ${specialtyLeagueBlocks.length} specialty league, ${leagueBlocks.length} regular league, ${schedulableSlotBlocks.length} general blocks`);

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
            // ★★★ NEW: Provide direct access to leagueAssignments for league cores ★★★
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
        // League teams are SEPARATE from bunks - they're defined in leagues.js
        // This step ensures window.leagueAssignments is properly populated with
        // team-based matchups at the division level for UI rendering
        // =========================================================================

        console.log("\n[STEP 5.5] Consolidating league assignments...");
        
        // Get all active leagues - handle both array and object formats
        let activeLeagues = [];
        if (Array.isArray(masterLeagues)) {
            activeLeagues = masterLeagues.filter(l => !disabledLeagues?.includes(l.name));
        } else if (masterLeagues && typeof masterLeagues === 'object') {
            // masterLeagues might be an object keyed by league name
            activeLeagues = Object.values(masterLeagues).filter(l => l && !disabledLeagues?.includes(l.name));
        }
        
        let activeSpecialtyLeagues = [];
        if (Array.isArray(masterSpecialtyLeagues)) {
            activeSpecialtyLeagues = masterSpecialtyLeagues.filter(l => !disabledSpecialtyLeagues?.includes(l.id));
        } else if (masterSpecialtyLeagues && typeof masterSpecialtyLeagues === 'object') {
            activeSpecialtyLeagues = Object.values(masterSpecialtyLeagues).filter(l => l && !disabledSpecialtyLeagues?.includes(l.id));
        }
        
        console.log(`[STEP 5.5] Active leagues: ${activeLeagues.length}, Specialty: ${activeSpecialtyLeagues.length}`);
        
        // Process regular league blocks - store team matchups at division level
        leagueBlocks.forEach(block => {
            const divName = block.divName;
            const slots = block.slots || [];
            if (slots.length === 0) return;
            
            // Find leagues that apply to this division
            const applicableLeagues = activeLeagues.filter(league => {
                return league.divisions?.includes(divName);
            });
            
            applicableLeagues.forEach(league => {
                const leagueTeams = league.teams || [];
                if (leagueTeams.length < 2) return;
                
                // Initialize division in leagueAssignments
                if (!window.leagueAssignments[divName]) {
                    window.leagueAssignments[divName] = {};
                }
                
                // Store at first slot of the block
                const slotIdx = slots[0];
                
                // Check if already populated (by fillBlock or earlier)
                if (window.leagueAssignments[divName][slotIdx]?.matchups?.length > 0) {
                    console.log(`   ✓ ${divName} slot ${slotIdx}: Already has ${window.leagueAssignments[divName][slotIdx].matchups.length} matchups`);
                    return;
                }
                
                // Try to get matchups from multiple sources:
                let foundMatchups = [];
                let foundGameLabel = league.name + ' Game';
                let foundSport = league.sports?.[0] || '';
                
                // Source 1: Check bunk entries for _allMatchups
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
                
                // Source 2: Check window.lastLeagueMatchups (if set by league core)
                if (foundMatchups.length === 0 && window.lastLeagueMatchups?.[divName]) {
                    const lastData = window.lastLeagueMatchups[divName];
                    foundMatchups = lastData.matchups || [];
                    foundGameLabel = lastData.gameLabel || foundGameLabel;
                    foundSport = lastData.sport || foundSport;
                }
                
                // Source 3: Generate round-robin matchups from team configuration
                // This is a fallback when the league core didn't store matchups
                if (foundMatchups.length === 0 && leagueTeams.length >= 2) {
                    console.log(`   ⚠️ No stored matchups for ${league.name} in ${divName}, generating from team config`);
                    
                    // Generate round-robin matchups
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
                    // Handle odd number of teams
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
        
        // Process specialty league blocks similarly
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
                
                // Check if already populated
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
                
                // Fallback: Generate from team config
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

        try {
            const newHistory = { ...rotationHistory };
            const timestamp = Date.now();
            Object.keys(divisions).forEach(divName => {
                divisions[divName].bunks.forEach(b => {
                    let lastActivity = null;
                    for (const entry of window.scheduleAssignments[b] || []) {
                        if (entry?._activity && entry._activity !== TRANSITION_TYPE && entry._activity !== lastActivity) {
                            lastActivity = entry._activity;
                            newHistory.bunks ??= {};
                            newHistory.bunks[b] ??= {};
                            newHistory.bunks[b][entry._activity] = timestamp;
                        }
                    }
                });
            });
            window.saveRotationHistory?.(newHistory);
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

    function registerSingleSlotUsage(slotIndex, fieldName, divName, bunkName, activityName, fieldUsageBySlot, activityProperties) {
        if (slotIndex == null || !fieldName) return;
        const key = typeof fieldName === 'string' ? fieldName : (fieldName?.name || String(fieldName));
        const rawProps = (activityProperties && activityProperties[key]) || {
            available: true,
            sharable: false,
            sharableWith: {
                type: 'not_sharable',
                capacity: 1
            }
        };
        const cap = rawProps?.sharableWith?.capacity || (rawProps?.sharable ? 2 : 1);

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

    console.log('⚙️ Scheduler Core Main v17.3 loaded (CROSS-DIVISION FIELD CONFLICT FIX)');

})();
