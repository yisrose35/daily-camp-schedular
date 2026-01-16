// ============================================================================
// scheduler_core_main.js (FIXED v16 - SCHEDULER RESTRICTION + STRICT RBAC)
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

        // Get all fields that are NOT rainy-day-available (outdoor fields)
        const outdoorFields = fields
            .filter(f => f.rainyDayAvailable !== true)
            .map(f => f.name);

        // Get indoor fields for logging
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

        // Rainy day only activities - these ONLY appear on rainy days
        const rainyDayOnly = specials
            .filter(s => s.rainyDayOnly === true)
            .map(s => s.name);

        // Activities available on rainy days (most specials by default)
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
    // LOCATION CONFLICT HELPERS (Internal & Exported API)
    // -------------------------------------------------------------------------

    /**
     * Check if a location-based activity can be scheduled at the given slots
     */
    function canScheduleAtLocation(activityName, locationName, slots) {
        if (!locationName) return true; // No location constraint

        const usage = window.locationUsageBySlot || {};

        for (const slotIdx of slots) {
            const slotUsage = usage[slotIdx]?.[locationName];
            if (slotUsage) {
                // Location is in use - check if it's the SAME activity
                // (Multiple bunks doing "Lunch" at Lunchroom is OK)
                // (One bunk doing "Skits" while another does "Lunch" is NOT OK)
                if (slotUsage.activity.toLowerCase() !== activityName.toLowerCase()) {
                    // console.log(`[LOCATION_CONFLICT] ${activityName} blocked at ${locationName} - ${slotUsage.activity} already scheduled`);
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Register that an activity is using a location at specific time slots
     */
    function registerActivityAtLocation(activityName, locationName, slots, divisionName) {
        if (!locationName) return;

        window.locationUsageBySlot = window.locationUsageBySlot || {};

        for (const slotIdx of slots) {
            if (!window.locationUsageBySlot[slotIdx]) {
                window.locationUsageBySlot[slotIdx] = {};
            }

            // Only register if not already registered (first activity wins/claims the type)
            // Or if existing registration matches activity (reinforce)
            if (!window.locationUsageBySlot[slotIdx][locationName]) {
                window.locationUsageBySlot[slotIdx][locationName] = {
                    activity: activityName,
                    division: divisionName,
                    timestamp: Date.now()
                };
                // console.log(`[LOCATION] Registered ${activityName} at ${locationName} for slot ${slotIdx}`);
            }
        }
    }

    /**
     * Get the location for a special activity by name
     */
    function getLocationForActivity(activityName) {
        if (!activityName) return null;
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specials = globalSettings.app1?.specialActivities || [];

        const special = specials.find(s =>
            s.name.toLowerCase() === activityName.toLowerCase()
        );

        return special?.location || null;
    }

    /**
     * Get the location for a pinned event from skeleton
     */
    function getLocationForPinnedEvent(skeletonEvent) {
        // Check if the event has a location assigned directly
        if (skeletonEvent.location) {
            return skeletonEvent.location;
        }

        // Check if it's a special activity with a location
        return getLocationForActivity(skeletonEvent.event);
    }

    // --- PART 6: SCHEDULER API EXPORTS ---

    // 1. Reset Location Usage
    window.resetLocationUsage = function() {
        window.locationUsageBySlot = {};
        console.log("[LOCATION] Usage tracking reset.");
    };

    // 2. Check Location Availability (Adapter for External Scheduler)
    window.isLocationAvailable = function(locationName, slots, activityName) {
        return canScheduleAtLocation(activityName, locationName, slots);
    };

    // 3. Register Location Usage (Adapter for External Scheduler)
    window.registerLocationUsage = function(slotIdxOrArray, locationName, activityName, divisionName) {
        const slots = Array.isArray(slotIdxOrArray) ? slotIdxOrArray : [slotIdxOrArray];
        registerActivityAtLocation(activityName, locationName, slots, divisionName);
    };

    // 4. Standard Exports
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
        // Find the actual pool/swim field name in activity properties
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
        const fName = Utils.fieldLabel(pick.field);
        const trans = Utils.getTransitionRules(fName, activityProperties);
        const {
            blockStartMin,
            blockEndMin,
            effectiveStart,
            effectiveEnd
        } = Utils.getEffectiveTimeRange(block, trans);
        const bunk = block.bunk;
        const zone = trans.zone;

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

        // ★★★ FILTER JOBS BY ALLOWED DIVISIONS ★★★
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

                // ★★★ CHECK IF BUNK HAS AN OVERRIDE FOR THIS TIME ★★★
                const existing = window.scheduleAssignments[bunk]?.[slots[0]];
                if (existing && existing._bunkOverride) {
                    console.log(`[SmartTile] ${bunk} has bunk override, skipping`);
                    return;
                }

                // ★★★ CHECK GLOBAL LOCKS - Pass division context for elective support ★★★
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

    /**
     * @param {Array} manualSkeleton - The base schedule structure
     * @param {Object} externalOverrides - Manual overrides
     * @param {Array<string>|null} allowedDivisions - [OPTIONAL] If provided, only generates for these divisions.
     * @param {Object|null} existingScheduleSnapshot - [OPTIONAL] Snapshot of existing assignments to preserve for locked divisions.
     * @param {Array|null} existingUnifiedTimes - [OPTIONAL] Time grid corresponding to the snapshot (for mapping)
     */
    window.runSkeletonOptimizer = function(manualSkeleton, externalOverrides, allowedDivisions = null, existingScheduleSnapshot = null, existingUnifiedTimes = null) {
        console.log("\n" + "=".repeat(70));
        console.log("★★★ OPTIMIZER STARTED (v16 - SCHEDULER RESTRICTION + STRICT RBAC) ★★★");

        // ★★★ SCHEDULER RESTRICTION ★★★
        // This must be the FIRST thing we do - filter divisions based on user permissions
        if (window.AccessControl?.filterDivisionsForGeneration) {
            allowedDivisions = window.AccessControl.filterDivisionsForGeneration(allowedDivisions);
            if (allowedDivisions.length === 0) {
                alert("No divisions assigned. Contact camp owner.");
                return;
            }
            console.log(`[RBAC] ★ SCHEDULER RESTRICTION APPLIED: Generating for [${allowedDivisions.join(', ')}] only`);
        }

        // ★★★ 1. AUTO-DETECT ALLOWED DIVISIONS ★★★
        // If not explicitly provided, check what the current user is allowed to schedule.
        if (!allowedDivisions) {
            // Priority 1: MultiSchedulerCore (Advanced Logic)
            if (window.MultiSchedulerCore && typeof window.MultiSchedulerCore.getUserDivisions === 'function') {
                const userDivs = window.MultiSchedulerCore.getUserDivisions();
                if (userDivs && userDivs.length > 0) {
                    const allDivs = Object.keys(window.divisions || {});
                    // If userDivs is smaller than allDivs, treat as partial generation
                    if (userDivs.length < allDivs.length) {
                        allowedDivisions = userDivs;
                        console.log(`[RBAC] Auto-detected restricted divisions via MultiScheduler: ${allowedDivisions.join(', ')}`);
                    }
                }
            } 
            // Priority 2: AccessControl (Basic Role)
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
        // If we are doing a partial generation (subset of divisions) and no snapshot was provided,
        // we MUST fetch the current state from memory/storage before we wipe it.
        // This ensures "Background" schedules are not deleted.
        if (allowedDivisions && (!existingScheduleSnapshot || Object.keys(existingScheduleSnapshot).length === 0)) {
            console.log("[OPTIMIZER] Partial generation detected without snapshot. Attempting to preserve existing data...");
            
            // Try memory first
            let snapshotSource = window.scheduleAssignments;
            
            // If memory is empty, try loading from daily data (persistence)
            if (!snapshotSource || Object.keys(snapshotSource).length === 0) {
                 const currentData = window.loadCurrentDailyData?.() || {};
                 snapshotSource = currentData.scheduleAssignments;
            }

            if (snapshotSource && Object.keys(snapshotSource).length > 0) {
                // Deep copy to prevent reference issues during reset
                existingScheduleSnapshot = JSON.parse(JSON.stringify(snapshotSource));
                // Try to grab times if not passed
                if (!existingUnifiedTimes) existingUnifiedTimes = window.unifiedTimes;
                console.log(`[OPTIMIZER] ✅ Preserved snapshot of ${Object.keys(existingScheduleSnapshot).length} bunks for background restoration.`);
            } else {
                console.warn("[OPTIMIZER] ⚠️ No existing schedule found to preserve. Generating fresh.");
            }
        }
        
        // ★★★ SECURITY: NORMALIZE ALLOWED DIVISIONS ★★★
        // Create a strict set for checking access. This prevents type coercion errors (string vs int)
        // and provides O(1) lookups for the "Hard Rule" enforcement.
        let allowedDivisionsSet = null;
        if (allowedDivisions && Array.isArray(allowedDivisions)) {
            allowedDivisionsSet = new Set(allowedDivisions.map(String));
            console.log(`★★★ PARTIAL MODE ACTIVE: Generating for [${Array.from(allowedDivisionsSet).join(', ')}] only ★★★`);
        }
        console.log("=".repeat(70));

        // ★★★ RESET disabled fields & Location Usage at start of each run ★★★
        window.currentDisabledFields = [];

        // Use the API method if available, otherwise manual reset
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
        // CRITICAL UPDATE v11: MERGE DAILY FIELD AVAILABILITY INTO PROPERTIES
        // This ensures the solver respects "Unavailable" times set in Daily Adjustments
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
                    // OVERWRITE or APPEND? Daily adjustments imply strict override.
                    // We'll set it as the primary timeRules for today.
                    window.activityProperties[fieldName].timeRules = rules;
                    console.log(`   -> Applied ${rules.length} rule(s) to ${fieldName}`);
                }
            });
        }

        // Change 'const' to 'let' for disabledFields to allow updates
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
            dailyFieldAvailability: _unusedDFA, // Already extracted above
            fieldsBySport
        } = config;

        // =========================================================================
        // CRITICAL FIX v11: NUMERIC BUNK SORTING
        // Ensure Bunk 9 comes before Bunk 18
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

        // Scan skeleton for field reservations
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

            // Add outdoor fields to disabled list
            const existingDisabled = disabledFields || [];
            disabledFields = [...new Set([...existingDisabled, ...rainyDayFilter.disabledFields])];

            // Update config object so downstream solvers see the disabled fields
            config.disabledFields = disabledFields;

            // ★★★ CRITICAL: Expose disabled fields globally so canBlockFit can check them ★★★
            window.currentDisabledFields = disabledFields;

            console.log(`[RainyDay] Total disabled fields: ${disabledFields.length}`);
            console.log(`[RainyDay] Disabled: ${disabledFields.join(', ')}`);
        } else {
            // Even when not rainy day, expose disabled fields (from manual overrides)
            window.currentDisabledFields = disabledFields || [];
        }

        // =========================================================================
        // ★★★ FIX: Filter Specials based on Rainy Day Mode (STRICT) ★★★
        // =========================================================================
        // This ensures the optimizer ONLY sees appropriate activities for the current weather mode.

        const isRainyMode = isRainyDayModeActive();

        if (masterSpecials) {
            const originalCount = masterSpecials.length;

            masterSpecials = masterSpecials.filter(s => {
                // 1. If Sunny Day (Mode OFF): Remove Rainy Day Exclusives
                //    These are activities marked "Rainy Day Only"
                if (!isRainyMode) {
                    if (s.rainyDayOnly === true || s.rainyDayExclusive === true) return false;
                }

                // 2. If Rainy Day (Mode ON): Remove "Sunny Day Only" items
                //    These are activities where "Available on Rainy Day" is unchecked
                if (isRainyMode) {
                    // Check both property variations for safety
                    if (s.rainyDayAvailable === false || s.availableOnRainyDay === false) return false;
                }

                return true;
            });

            // Sync changes to config references so all downstream logic (Smart Tiles, Solver) obeys the filter
            config.masterSpecials = masterSpecials;

            // Also sync the name list (used for candidate generation)
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
        // This is the key fix for the "Multi-Scheduler" requirement.
        (function() {
            'use strict';

            console.log('[Step1.5Patch] Loading time-mapping restoration patch...');

            const TRANSITION_TYPE = "Transition/Buffer";

            function getTimeSig(t) {
                if (!t) return null;
                if (t instanceof Date) return t.toISOString();
                if (t.start instanceof Date) return t.start.toISOString();
                if (typeof t.start === 'string') return t.start; // ISO string
                return String(t);
            }

            // =========================================================================
            // RESTORE BACKGROUND SCHEDULES INTO scheduleAssignments
            // =========================================================================
            
            /**
             * Restore schedules from the snapshot into window.scheduleAssignments
             * @param {Object} snapshot - { bunkName: [slotAssignments...] }
             * @param {Object} divisions - window.divisions
             * @param {Array} allowedDivisions - divisions we ARE generating (to skip)
             * @param {Array} existingUnifiedTimes - time grid from snapshot
             * @returns {number} - count of bunks restored
             */
            function restoreBackgroundSchedules(snapshot, divisions, allowedDivisions, existingUnifiedTimes) {
                if (!snapshot || Object.keys(snapshot).length === 0) {
                    console.log('[Step1.5] No snapshot to restore');
                    return 0;
                }

                const allowedSet = new Set(allowedDivisions || []);
                let restoredBunks = 0;
                let restoredSlots = 0;

                // Build TIME MAP for new grid (New Time -> New Index)
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

                    // Find which division this bunk belongs to
                    const divName = Object.keys(divisions).find(d => 
                        divisions[d].bunks?.includes(bunkName)
                    );

                    // Skip if this is a division we're generating
                    if (divName && allowedSet.has(divName)) {
                        continue;
                    }

                    // Initialize bunk array if needed
                    if (!window.scheduleAssignments[bunkName]) {
                        window.scheduleAssignments[bunkName] = new Array(window.unifiedTimes.length);
                    }

                    // Restore each slot using Time Mapping if possible
                    for (let i = 0; i < slots.length; i++) {
                        if (slots[i]) {
                            let targetIndex = i;

                            // IF we have time mapping info
                            if (existingUnifiedTimes && existingUnifiedTimes[i]) {
                                const oldSig = getTimeSig(existingUnifiedTimes[i]);
                                if (newTimeMap.has(oldSig)) {
                                    targetIndex = newTimeMap.get(oldSig);
                                } else {
                                    // Old slot time doesn't exist in new grid -> SKIP
                                    continue;
                                }
                            } else if (window.unifiedTimes.length !== slots.length) {
                                // Fallback: Length mismatch and no map.
                                // If array expanded, indexes align? 
                                // Risk of misalignment, but we have no choice.
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

            // =========================================================================
            // REGISTER FIELD USAGE FROM RESTORED SCHEDULES
            // =========================================================================
            
            /**
             * Register field usage for all restored schedules
             * This ensures the solver won't double-book fields
             */
            function registerFieldUsageFromRestoredSchedules(snapshot, divisions, allowedDivisions, fieldUsageBySlot, activityProperties, existingUnifiedTimes) {
                if (!snapshot || Object.keys(snapshot).length === 0) {
                    return 0;
                }

                const allowedSet = new Set(allowedDivisions || []);
                let registrations = 0;

                // Build TIME MAP
                const newTimeMap = new Map();
                window.unifiedTimes.forEach((t, i) => {
                    const sig = getTimeSig(t);
                    if (sig) newTimeMap.set(sig, i);
                });

                console.log('[Step1.5] Registering field usage from restored schedules...');

                for (const [bunkName, slots] of Object.entries(snapshot)) {
                    if (!slots || !Array.isArray(slots)) continue;

                    // Find division
                    const divName = Object.keys(divisions).find(d => 
                        divisions[d].bunks?.includes(bunkName)
                    );

                    // Skip if this is a division we're generating
                    if (divName && allowedSet.has(divName)) continue;

                    for (let i = 0; i < slots.length; i++) {
                        const slotData = slots[i];
                        if (!slotData || !slotData.field) continue;

                        // MAP TARGET INDEX
                        let targetIndex = i;
                        if (existingUnifiedTimes && existingUnifiedTimes[i]) {
                            const oldSig = getTimeSig(existingUnifiedTimes[i]);
                            if (newTimeMap.has(oldSig)) targetIndex = newTimeMap.get(oldSig);
                            else continue;
                        }

                        const fieldName = slotData.field;
                        const activityName = slotData._activity || fieldName;

                        // Skip transitions
                        if (fieldName === TRANSITION_TYPE || slotData._isTransition) continue;

                        // Initialize slot in fieldUsageBySlot
                        if (!fieldUsageBySlot[targetIndex]) {
                            fieldUsageBySlot[targetIndex] = {};
                        }

                        // Get field properties for capacity
                        const props = activityProperties?.[fieldName] || {};
                        let maxCapacity = 1;
                        if (props.sharableWith?.capacity) {
                            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                        } else if (props.sharable) {
                            maxCapacity = 2;
                        }

                        // Register usage
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

                        // If at capacity, lock in GlobalFieldLocks
                        if (window.GlobalFieldLocks && usage.count >= maxCapacity) {
                            window.GlobalFieldLocks.lockField(fieldName, [targetIndex], {
                                lockedBy: 'background_schedule',
                                division: divName || 'background',
                                activity: `${activityName} (preserved from other scheduler)`
                            });
                        }

                        // Also register location usage
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

            // =========================================================================
            // EXPORT FUNCTIONS FOR USE IN scheduler_core_main.js
            // =========================================================================
            
            window.restoreBackgroundSchedules = restoreBackgroundSchedules;
            window.registerFieldUsageFromRestoredSchedules = registerFieldUsageFromRestoredSchedules;

            // =========================================================================
            // COMBINED HELPER
            // =========================================================================
            
            /**
             * Complete Step 1.5: Restore and register background schedules
             */
            window.executeStep1_5 = function(snapshot, divisions, allowedDivisions, fieldUsageBySlot, activityProperties, existingUnifiedTimes) {
                console.log('\n[STEP 1.5] ═══════════════════════════════════════════════════');
                console.log('[STEP 1.5] RESTORING BACKGROUND SCHEDULES WITH TIME MAPPING');
                console.log('[STEP 1.5] ═══════════════════════════════════════════════════');

                if (!snapshot || Object.keys(snapshot).length === 0) {
                    console.log('[STEP 1.5] No background snapshot provided - nothing to restore');
                    return { bunksRestored: 0, fieldsRegistered: 0 };
                }

                // Restore schedules
                const bunksRestored = restoreBackgroundSchedules(
                    snapshot, 
                    divisions, 
                    allowedDivisions,
                    existingUnifiedTimes
                );

                // Register field usage
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

        // ★★★ ACTUALLY EXECUTE STEP 1.5 WITH TIME MAPPING ★★★
        if (existingScheduleSnapshot && Object.keys(existingScheduleSnapshot).length > 0) {
            window.executeStep1_5(
                existingScheduleSnapshot,
                divisions,
                allowedDivisions,
                fieldUsageBySlot,
                activityProperties,
                existingUnifiedTimes // <--- PASSING THE OLD GRID
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
            const overrideType = override.type; // 'trip', 'sport', or 'special'
            const startMin = Utils.parseTimeToMinutes(override.startTime);
            const endMin = Utils.parseTimeToMinutes(override.endTime);
            const slots = Utils.findSlotsForRange(startMin, endMin);
            const bunk = override.bunk;
            const divName = Object.keys(divisions).find(d => divisions[d].bunks?.includes(bunk));

            if (!divName || slots.length === 0) {
                console.warn(`[BunkOverride] Skipping ${bunk} - no division found or no slots`);
                return;
            }

            // ★★★ PARTIAL GEN CHECK (HARD RULE) ★★★
            // If strict mode is on, we MUST skip overrides for divisions we don't own.
            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(divName))) {
                // Skip processing override for locked division (it's already restored in step 1.5)
                return; 
            }

            console.log(`[BunkOverride] ${bunk}: ${activityName} (${overrideType}) @ ${override.startTime}-${override.endTime}`);

            if (overrideType === 'trip') {
                // =====================================================
                // PERSONAL TRIP - Pinned tile, no field usage
                // =====================================================
                // Just fill the bunk's schedule - trips don't use camp fields
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
                // =====================================================
                // SPORT - Find field, register usage, fill schedule
                // =====================================================
                // Find which field this sport is played on
                let fieldName = activityName; // Default: use activity name as field
                const fieldsBySportData = fieldsBySport || {};

                // Check if there's a specific field for this sport
                const fieldsForSport = fieldsBySportData[activityName] || [];

                if (fieldsForSport.length > 0) {
                    // Find the first available field for this sport
                    for (const candidateField of fieldsForSport) {
                        // Check if field is locked (pass division context for elective support)
                        if (window.GlobalFieldLocks?.isFieldLocked(candidateField, slots, divName)) {
                            continue;
                        }

                        // Check capacity
                        const props = activityProperties[candidateField] || {};
                        let maxCapacity = 1;
                        if (props.sharableWith?.capacity) {
                            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                        } else if (props.sharable) {
                            maxCapacity = 2;
                        }

                        // Check current usage
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

                // Fill the schedule AND register field usage
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
                // =====================================================
                // SPECIAL ACTIVITY - Register usage, fill schedule
                // =====================================================
                // Check if the special activity is available (not locked) - pass division context
                if (window.GlobalFieldLocks?.isFieldLocked(activityName, slots, divName)) {
                    console.warn(`   → Special ${activityName} is LOCKED for ${divName}, cannot assign to ${bunk}`);
                    return;
                }

                // ★★★ LOCATION CONFLICT CHECK ★★★
                const locName = getLocationForActivity(activityName);
                if (locName && !canScheduleAtLocation(activityName, locName, slots)) {
                    console.warn(`[BunkOverride] ${activityName} blocked for ${bunk} - location ${locName} in use`);
                    return;
                }

                // Check capacity
                const props = activityProperties[activityName] || {};
                let maxCapacity = 1;
                if (props.sharableWith?.capacity) {
                    maxCapacity = parseInt(props.sharableWith.capacity) || 1;
                } else if (props.sharable) {
                    maxCapacity = 2;
                }

                // Check if there's room
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

                // Fill the schedule AND register field usage
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

                // ★★★ REGISTER LOCATION USAGE ★★★
                registerActivityAtLocation(activityName, locName, slots, divName);
                console.log(`   → Special ${activityName} assigned to ${bunk}`);

            } else {
                // Unknown type - treat as pinned
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
        // STEP 2.5: Process Elective Tiles - Lock activities for other divisions
        // =========================================================================

        console.log("\n[STEP 2.5] Processing elective tiles...");
        const electiveTiles = manualSkeleton.filter(item => item.type === 'elective');

        electiveTiles.forEach(elective => {
            const electiveDivision = elective.division;
            
            // ★★★ PARTIAL GEN CHECK (HARD RULE) ★★★
            // If we are in partial generation mode, SKIP electives for locked divisions.
            // This prevents Scheduler A from processing Scheduler B's electives.
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

            // Lock each activity for OTHER divisions (not the elective division)
            activities.forEach(activityName => {
                // ★★★ SWIM/POOL ALIAS RESOLUTION ★★★
                let resolvedName = activityName;
                if (isSwimOrPool(activityName)) {
                    resolvedName = resolveSwimPoolName(activityName, activityProperties);
                    if (resolvedName !== activityName) {
                        console.log(`  [ALIAS] Resolved "${activityName}" → "${resolvedName}"`);
                    }
                }

                if (window.GlobalFieldLocks) {
                    // Use a special lock that allows the elective division but blocks others
                    window.GlobalFieldLocks.lockFieldForDivision(
                        resolvedName,
                        slots,
                        electiveDivision,
                        `Elective (${electiveDivision})`
                    );
                    console.log(`   → Locked "${resolvedName}" for ${electiveDivision} only`);

                    // Also lock swim/pool aliases if this is a pool activity
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

            // ★★★ PARTIAL GEN CHECK (HARD RULE) ★★★
            // If we are in partial generation mode, SKIP items for locked divisions.
            // This enforces that Scheduler A (1,2,3) cannot schedule 4,5,6.
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
            // SPLIT TILE LOGIC - Groups swap activities at midpoint
            // =========================================================================
            // BEHAVIOR (Example: 8 bunks, time 1:00-3:00, main1/main2):
            //   First half of time (1:00-2:00):
            //     - Lower bunks (1-4) → main 1
            //     - Higher bunks (5-8) → main 2
            //   Second half of time (2:00-3:00) - SWITCH:
            //     - Lower bunks (1-4) → main 2
            //     - Higher bunks (5-8) → main 1
            // =========================================================================
            if (item.type === 'split') {
                console.log(`[SPLIT] ═══════════════════════════════════════════════════════`);
                console.log(`[SPLIT] Processing split tile for ${divName}: ${item.event}`);
                console.log(`[SPLIT] ═══════════════════════════════════════════════════════`);
                
                // ★★★ CRITICAL: Sort bunks numerically BEFORE splitting ★★★
                const sortedBunks = [...bunkList].sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/)?.[0] || 0);
                    const numB = parseInt(b.match(/\d+/)?.[0] || 0);
                    return numA - numB || a.localeCompare(b);
                });
                
                // Calculate midpoint of the time block
                const midMin = Math.floor(sMin + (eMin - sMin) / 2);
                
                // Divide bunks into two groups (lower half and upper half)
                const half = Math.ceil(sortedBunks.length / 2);
                const groupA = sortedBunks.slice(0, half);   // Lower numbered bunks
                const groupB = sortedBunks.slice(half);      // Higher numbered bunks

                // Get activity names from subEvents
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

                // ★★★ Resolve swim/pool aliases ★★★
                if (isSwimOrPool(act1Name)) {
                    act1Name = resolveSwimPoolName(act1Name, activityProperties);
                }
                if (isSwimOrPool(act2Name)) {
                    act2Name = resolveSwimPoolName(act2Name, activityProperties);
                }

                console.log(`[SPLIT] Main 1: "${act1Name}"`);
                console.log(`[SPLIT] Main 2: "${act2Name}"`);
                console.log(`[SPLIT] Time: ${sMin} to ${eMin} (midpoint: ${midMin})`);
                console.log(`[SPLIT] Group 1 (lower): ${groupA.join(', ')}`);
                console.log(`[SPLIT] Group 2 (higher): ${groupB.join(', ')}`);

                // Helper function to route activities to bunks
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

                // FIRST HALF: groupA → main1, groupB → main2
                console.log(`[SPLIT] >>> FIRST HALF (${sMin}-${midMin}) <<<`);
                routeSplitActivity(groupA, act1Name, sMin, midMin, "Group 1", "main 1");
                routeSplitActivity(groupB, act2Name, sMin, midMin, "Group 2", "main 2");
                
                // SECOND HALF (SWITCH): groupA → main2, groupB → main1
                console.log(`[SPLIT] >>> SECOND HALF (${midMin}-${eMin}) - SWITCH <<<`);
                routeSplitActivity(groupA, act2Name, midMin, eMin, "Group 1", "main 2");
                routeSplitActivity(groupB, act1Name, midMin, eMin, "Group 2", "main 1");

                console.log(`[SPLIT] ✅ Completed split tile for ${divName}\n`);
                return;
            }
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
            fields: config.masterFields || []
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
        }, allowedDivisionsSet || allowedDivisions); // Pass strict set if available, or legacy array

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
                // ★★★ SKIP BUNKS WITH OVERRIDES ★★★
                if (existing && existing._bunkOverride) return false;
                return !existing || existing._activity === TRANSITION_TYPE;
            })
            .map(b => ({ ...b,
                _isLeague: false
            }));

        console.log(`[SOLVER] Processing ${remainingActivityBlocks.length} activity blocks.`);

        if (window.totalSolverEngine && remainingActivityBlocks.length > 0) {
            // Pass the updated config with modified disabledFields
            window.totalSolverEngine.solveSchedule(remainingActivityBlocks, config);
        }

        // =========================================================================
        // STEP 8: Update History
        // =========================================================================

        try {
            const newHistory = { ...rotationHistory
            };
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

        // Final lock debug
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.debugPrintLocks();
        }

        return true;
    };

    // =========================================================================
    // LEGACY ALIAS: runOptimizer → runSkeletonOptimizer
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
})();
