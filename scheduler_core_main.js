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
        // Prefer live in-memory cache from special_activities.js over stale storage snapshot
        const specials = window.getGlobalSpecialActivities?.() || globalSettings.app1?.specialActivities || [];

        const special = specials.find(s =>
            s.name.toLowerCase() === activityName.toLowerCase()
        );

        return special?.location || null;
    }

    // ★ Canonical category normalizer — collapses the fuzzy label variants a user
    //   might type so "sport"/"sports", "special"/"specials"/"special activity"/
    //   "special activities", and "activity"/"activities"/"general activity"/
    //   "general" each map to ONE category. Returns 'special' | 'sport' | 'general',
    //   or null for a SPECIFIC named activity (e.g. "Pickleball", "Lake"). Anchored
    //   to the whole label so a real activity that merely contains the word (e.g.
    //   "Special Olympics") is NOT swallowed.
    function normalizeCategoryLabel(v) {
        if (!v) return null;
        const s = String(v).toLowerCase().trim().replace(/\s+/g, ' ').replace(/\s+slot$/, '').trim();
        if (/^special(s)?( activit(y|ies))?$/.test(s)) return 'special';
        if (/^sport(s)?$/.test(s)) return 'sport';
        if (s === 'general' || /^(general )?activit(y|ies)$/.test(s)) return 'general';
        return null;
    }
    window.normalizeCategoryLabel = normalizeCategoryLabel;

    function getLocationForPinnedEvent(skeletonEvent) {
        // 1. Direct location on skeleton item
        if (skeletonEvent.location && typeof skeletonEvent.location === 'string') {
            return skeletonEvent.location;
        }
        // 2. Special activity with assigned location
        const specialLoc = getLocationForActivity(skeletonEvent.event);
        if (specialLoc && typeof specialLoc === 'string') return specialLoc;
        // 3. ★ v17.11: Pinned tile default location (Snacks→Lunchroom, Lunch→Lunchroom, etc.)
        const pinnedDefault = window.getPinnedTileDefaultLocation?.(skeletonEvent.event);
        if (pinnedDefault && typeof pinnedDefault === 'string') return pinnedDefault;
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

    // The skeleton tile palette has three fillable kinds: a "Sports" tile
    // (event "Sports Slot") may ONLY hold a sport, a "Special Activity" tile may
    // ONLY hold a special, and a flexible "Activity" tile ("General Activity
    // Slot") may hold either. Derive that kind from the raw event label here —
    // BEFORE normalizeGA() collapses "Special Activity" into "General Activity
    // Slot" (it matches the 'activity' substring) and erases the restriction.
    // The solver reads _slotKind to keep the pools separate. 'any' = flexible.
    function slotKindOf(eventName) {
        const s = String(eventName || '').toLowerCase().trim();
        if (s === 'sports slot' || s === 'sport slot') return 'sport';
        if (s === 'special activity') return 'special';
        return 'any';
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
    // computeManualSpecialFeatures — port of the AUTO builder's Day-19 special
    // placement features (durations[] best-fit, multiPart part-labeling, prep
    // lead-in) into the MANUAL builder. Returns a metadata patch to merge onto
    // the written slot, or null. EVERY branch is gated on the special opting in
    // (durations.length>1 / multiPart.enabled / prepDuration>0), so ordinary
    // sports and specials that don't configure these get null → zero behavior
    // change. Mirrors scheduler_core_auto.js getMultiPartInfo (L959) and the
    // duration/prep handling there.
    // -------------------------------------------------------------------------
    function computeManualSpecialFeatures(actName, tileStart, tileEnd, bunk, activityProperties) {
        if (!actName) return null;
        // ★ Read the canonical special config DIRECTLY (mirrors the AUTO builder,
        //   which reads getSpecialConfig / getSpecialActivityByName rather than the
        //   derived activityProperties). Several activityProperties rebuilders
        //   whitelist fields and drop durations/multiPart/prep, and at least one
        //   runs mid-generation — so the activityProperties handed to fillBlock can
        //   lack these fields even though buildActivityProperties now copies them.
        //   Reading the config store directly makes the features robust to which
        //   activityProperties object happens to be live. Falls back to the passed
        //   activityProperties (covers non-special activities / no config store).
        let props = null;
        if (typeof window.getSpecialActivityByName === 'function') {
            try { props = window.getSpecialActivityByName(actName); } catch (e) { props = null; }
        }
        if (!props && activityProperties) {
            props = activityProperties[actName] ||
                activityProperties[Object.keys(activityProperties).find(k => k.toLowerCase() === String(actName).toLowerCase())];
        }
        if (!props) return null;
        const tileLen = (typeof tileStart === 'number' && typeof tileEnd === 'number') ? (tileEnd - tileStart) : 0;
        let out = null;

        // durations[] best-fit: pick the largest configured duration that fits the
        // tile (smallest if none fit). Honors the user's allowed lengths instead
        // of always stretching the special across the whole tile. When the chosen
        // length is shorter than the tile, _endMin is clamped so the special shows
        // its real duration (the validator derives times from divisionTimes, not
        // _endMin, so this never creates phantom conflicts).
        if (Array.isArray(props.durations) && props.durations.length > 1 && tileLen > 0) {
            const _ds = props.durations.map(d => parseInt(d) || 0).filter(d => d > 0);
            if (_ds.length) {
                const _fit = _ds.filter(d => d <= tileLen);
                const _best = _fit.length ? Math.max.apply(null, _fit) : Math.min.apply(null, _ds);
                if (_best > 0 && _best < tileLen) {
                    out = out || {};
                    out._endMin = tileStart + _best;
                    out._durationBestFit = _best;
                }
            }
        }

        // multiPart: stamp part number/label so the schedule shows "VR Lab 1/2".
        // _activity stays the base name (rotation counts by base); the visible
        // name comes from _partLabel via Utils.getActivityDisplayName. The
        // daysBetween/totalParts placement gate lives in calculateLimitScore.
        const mp = props.multiPart;
        if (mp && mp.enabled) {
            const total = parseInt(mp.totalParts) || 0;
            if (total > 0) {
                const prior = (window.RotationEngine && typeof window.RotationEngine.getActivityCount === 'function')
                    ? (window.RotationEngine.getActivityCount(bunk, actName) || 0) : 0;
                const partNo = prior + 1;
                if (partNo <= total) {
                    const part = (Array.isArray(mp.parts) && mp.parts[partNo - 1]) ? mp.parts[partNo - 1] : null;
                    const partName = (part && typeof part.name === 'string' && part.name.trim()) ? part.name.trim() : null;
                    const partLoc = (part && typeof part.location === 'string' && part.location.trim()) ? part.location.trim() : null;
                    out = out || {};
                    out._partNumber = partNo;
                    out._totalParts = total;
                    out._partLabel = (partName ? partName : actName) + ' ' + partNo + '/' + total;
                    // ★ per-part LOCATION: the auto builder places each part in its own
                    //   room (parts[i].location). Port it: the writer overrides the slot's
                    //   field to this room and registers usage under it, so the part is
                    //   actually placed (and reserved) in its own room — not the base
                    //   special location. Whole-tile (not sub-slot), so it maps cleanly to
                    //   the manual slot model. Null when the part has no own location.
                    if (partLoc) out._partLocation = partLoc;
                }
            }
        }

        // prep: reserve the lead-in time as a prep sub-block. Same-location prep
        // needs no extra field reservation (the bunk already holds the location
        // for the whole tile); the print sheet splits [Prep][activity] visually,
        // mirroring the zone travel buffer.
        const prepDur = parseInt(props.prepDuration) || 0;
        if (prepDur > 0 && tileLen > prepDur + 4) {
            out = out || {};
            out._prepDuration = prepDur;
            out._prepLabel = (props.prepConfig && typeof props.prepConfig.label === 'string' && props.prepConfig.label.trim())
                ? props.prepConfig.label.trim() : (actName + ' Prep');
            out._prepLocation = (props.prepConfig && typeof props.prepConfig.location === 'string') ? props.prepConfig.location.trim() : '';
        }
        return out;
    }
    window.computeManualSpecialFeatures = computeManualSpecialFeatures;

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
        if ((block.type === 'league' || block.type === 'specialty_league') && block.bunks && !block.bunk && !block.team) {
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
        
        // ★ Config-level shut-off (Facilities AVAILABLE/UNAVAILABLE toggle):
        //   never write a placement whose SPECIAL or host FIELD is disabled.
        //   activityProperties carries the `available` flag for both specials and
        //   fields (buildActivityProperties). This is the universal manual-mode
        //   chokepoint — it covers every caller (rotation-special at L1559,
        //   direct-fill, bunk-override, smart-tile) that passes _fixed:true,
        //   several of which only checked capacity/"had-today", never availability.
        //   League fills are exempt (handled/returned above) and label/transition
        //   writes (Swim, Free, Change) have no activityProperties entry so they
        //   pass through untouched.
        if (!isLeagueFill && activityProperties) {
            const _avLook = (n) => {
                if (!n) return undefined;
                return activityProperties[n] || activityProperties[String(n).toLowerCase().trim()];
            };
            const _apAct = _avLook(pick && pick._activity);
            const _apFld = _avLook(pick && pick.field);
            if ((_apAct && _apAct.available === false) || (_apFld && _apFld.available === false)) {
                console.log('[fillBlock] skip — "' + ((pick && (pick._activity || pick.field)) || '?') +
                    '" is UNAVAILABLE in Facilities (config toggle off)');
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

        // ★ Day-19 special features (durations best-fit / multiPart / prep) for
        //   MANUAL mode. Computed once per fill; gated — null for ordinary fills.
        const _specActName = pick._activity || pick.activityName || pick.sport || fName;
        const _specFeat = computeManualSpecialFeatures(_specActName, block.startTime, block.endTime, bunk, activityProperties);

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
                const _entry = {
                    field: fName,
                    sport: pick.sport,
                    continuation: i > 0,
                    _fixed: pick._fixed || false,
                    _h2h: pick._h2h || false,
                    _activity: pick._activity || pick.activityName || pick.sport || fName,
                    _allMatchups: pick._allMatchups || null,
                    _gameLabel: pick._gameLabel || null,
                    _zone: zone,
                    _endTime: effectiveEnd,
                    _bunkOverride: pick._bunkOverride || false,
                    // ★★★ v17.7: Store time range AND split tile flag for proper tracking ★★★
                    _startMin: block.startTime,
                    _endMin: block.endTime,
                    _fromSplitTile: isSplitTileBlock || pick._fromSplitTile || false,
                    // ★ Persist the pinned flag so downstream capacity sweeps (STEP 7.55
                    //   + the daily_adjustments capacity-repair gate) can protect pinned
                    //   whole-division events (Learning Groups, Snacks, etc.). Without this
                    //   the flag was dropped here, so a custom-named pinned period not in the
                    //   sweep's skip-list was treated as a cap-1 room and demoted to Free for
                    //   all-but-one bunk — breaking the full-division cell merge.
                    _pinned: pick._pinned || false,
                    // ★ Field-less direct-fill label (e.g. a rotation tile's Swim / Pickleball
                    //   option with NO configured field): `field` here is only a display label,
                    //   not a bookable room. The STEP 7.55 room-capacity sweep skips entries
                    //   carrying this flag so N bunks on the SAME label aren't treated as N
                    //   occupants of one phantom cap-1 room (which demoted all-but-one → Free →
                    //   STEP 7.6 refilled them with GENERIC SPORTS — the "it's giving out sports"
                    //   bug). Default false → zero change for every real field / special placement.
                    _noRoomCap: pick._noRoomCap || false
                };
                // ★ Away (off-campus) tile (e.g. an away league game): stamp travel
                //   to/from on the lead slot so grids + print render the 🚶 Travel
                //   buffers. Field is in the away zone → getTravelForField returns its
                //   travel; fall back to the zone's configured travel for label fields.
                if (i === 0 && block._isAway && block._awayZone) {
                    let _lt = (fName && fName !== 'Free') ? window.getTravelForField?.(fName, true) : null;
                    if (!_lt) {
                        const _zaway = (window.getAwayZones?.() || []).find(z => z.name === block._awayZone);
                        if (_zaway && _zaway.travelTimeMin > 0) _lt = { preMin: _zaway.travelTimeMin, postMin: _zaway.travelTimeMin, zoneName: _zaway.name };
                    }
                    if (_lt) {
                        _entry._travelPre = _lt.preMin;
                        _entry._travelPost = _lt.postMin;
                        _entry._travelZone = _lt.zoneName;
                        _entry._travelMode = 'deduct';
                    }
                }
                if (_specFeat) {
                    // part label on every slot (so continuations also display it)
                    if (_specFeat._partLabel) {
                        _entry._partNumber = _specFeat._partNumber;
                        _entry._totalParts = _specFeat._totalParts;
                        _entry._partLabel = _specFeat._partLabel;
                    }
                    // ★ per-part location: place this part in its own room (whole-tile
                    //   override; usage registered under it below).
                    if (_specFeat._partLocation) {
                        _entry.field = _specFeat._partLocation;
                        _entry._partLocation = _specFeat._partLocation;
                    }
                    // prep + duration clamp apply to the first slot only
                    if (i === 0) {
                        if (_specFeat._prepDuration) {
                            _entry._prepDuration = _specFeat._prepDuration;
                            _entry._prepLabel = _specFeat._prepLabel;
                            _entry._prepLocation = _specFeat._prepLocation;
                        }
                        if (_specFeat._endMin && mainSlots.length === 1) {
                            _entry._endMin = _specFeat._endMin;
                            _entry._durationBestFit = _specFeat._durationBestFit;
                        }
                    }
                }
                window.scheduleAssignments[bunk][slotIndex] = _entry;
                window.registerSingleSlotUsage(slotIndex, _entry.field, block.divName, bunk, pick._activity || _entry.field, fieldUsageBySlot, activityProperties);
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

        // ★ Specific-activity smart tiles: every sport hosted by at least one
        //   field. Lets a tile name a concrete sport (e.g. main2 = "Pickleball")
        //   and have it SOLVER-placed on a real hosting field instead of
        //   literal-filled with the sport name as its own location.
        const knownSportNames = new Set();
        // lowercase sport name → array of field names that host it (for the rotation's
        // specific-sport feasibility gate: a sport with NO open hosting field at a window
        // must fall through to the next option rather than become a generic Sport).
        const _sportFieldMap = {};
        const _addSportField = (sport, field) => {
            const k = String(sport || '').toLowerCase().trim();
            if (!k || !field) return;
            (_sportFieldMap[k] = _sportFieldMap[k] || []);
            if (!_sportFieldMap[k].includes(field)) _sportFieldMap[k].push(field);
        };
        try {
            const _lfd = window.SchedulerCoreUtils?.loadAndFilterData?.() || {};
            Object.keys(_lfd.fieldsBySport || {}).forEach(sp => {
                knownSportNames.add(String(sp).toLowerCase().trim());
                (_lfd.fieldsBySport[sp] || []).forEach(f => _addSportField(sp, (f && f.name) || f));
            });
            (_lfd.masterFields || []).forEach(f => ((f && f.activities) || []).forEach(a => {
                if (!a) return;
                knownSportNames.add(String(a).toLowerCase().trim());
                _addSportField(a, f.name);
            }));
        } catch (_) {}

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

        // =====================================================================
        // ★ SENIORITY-FIRST PLACEMENT (oldest → youngest).
        //   Policy: once placement reaches smart tiles, the OLDEST bunks are
        //   scheduled first and the system works its way down oldest → youngest,
        //   so the oldest divisions get FIRST pick of the limited specials.
        //   (Previously they were processed last and only got leftovers — the
        //   8th/9th-grade starvation bug.) Single source of truth:
        //   window.getDivisionAgeOrder (index 0 = most senior = oldest) — the
        //   SAME age order leagues + field-quality seniority use, so column order,
        //   field priority and special priority all agree. Younger divisions still
        //   keep a minimum share via the fair-share special quota further below:
        //   seniority only decides WHO goes first; the quota's Math.max(1,…) floor
        //   reserves a slice for everyone.
        // =====================================================================
        const _seniorityRank = (() => {
            const map = {};
            try {
                const order = (typeof window.getDivisionAgeOrder === 'function')
                    ? window.getDivisionAgeOrder(Object.keys(divisions || {}))
                    : Object.keys(divisions || {});
                order.forEach((d, i) => { map[String(d)] = i; });
            } catch (_) {}
            return map;
        })();
        const _senOf = (d) => {
            const r = _seniorityRank[String(d)];
            return (r === undefined) ? 1e9 : r;
        };
        const _numSeniorityDivs = Object.keys(_seniorityRank).length || 1;

        // Process the smart-tile jobs oldest-division-first (stable WITHIN a
        // division so connected-tile / block sequencing is unchanged). Every
        // downstream pass (window pooling, guarantee pre-pass, rotation quota,
        // and the per-bunk claim loop) iterates this array, so the oldest claim
        // scarce specials before younger divisions do.
        (function _sortJobsBySeniority() {
            const _origIdx = new Map();
            filteredJobs.forEach((j, i) => _origIdx.set(j, i));
            filteredJobs.sort((a, b) =>
                (_senOf(a.division) - _senOf(b.division)) ||
                (_origIdx.get(a) - _origIdx.get(b)));
        })();
        console.log(`[SmartTile SENIORITY] oldest→youngest: ${[...new Set(filteredJobs.map(j => j.division))].map(d => `${d}(#${_senOf(d)})`).join(' > ')}`);

        // =====================================================================
        // ★ V44.3: CAMP-WIDE SPECIAL BUDGET PRE-CALCULATION
        // For each time window, total up available special slots (division-aware),
        // rank ALL bunks across ALL divisions by fairness, and mark the top N
        // as having budget. Everyone else routes to fallback before the solver runs.
        // Key format: "divName|bunk|startMin|endMin" → true (has budget) / false (no budget)
        // =====================================================================
        const smartTileBudget = {};

        // ★ CONNECTED-GROUP AWARENESS: per pair-group, per bunk, the set of open/
        //   fallback activities already handed out (e.g. "swim"). Specials already
        //   dedupe day-wide via _bunkSpecialsToday; this stops a bunk getting the
        //   SAME open activity twice across connected tiles (the "2 swims" bug) —
        //   the repeat is swapped for a fresh sport instead. Keyed by pairGroup so
        //   it only binds tiles the user explicitly linked. { group: { bunk: Set } }
        const _groupOpenUsed = {};

        // ★ CONNECTED-GROUP ROTATION: per pair-group, per bunk, the set of OPTION
        //   labels (e.g. "sports"/"special"/"swim") already handed out across the
        //   connected tiles. The rotation skips a bunk's already-used options so each
        //   bunk walks through ALL the configured options once — that's the
        //   "across N connected tiles, get all N" behaviour. { group: { bunk: Set } }
        const _groupOptsUsed = {};

        // Helper — is this activity label a special-type that needs generation?
        const _isSpecialLabel = v => !!v && v.toLowerCase().trim().includes('special');

        // ★ SINGLE-TILE ROTATION MODE: one smart tile (no Block B) whose config
        //   names 2+ distinct options rotates PER BUNK across DAYS — e.g.
        //   main1=Special, main2=Pickleball, fallback=Swim → each bunk cycles
        //   special → Pickleball → Swim on consecutive days (staggered across
        //   bunks so scarce capacity spreads), instead of splitting the
        //   division within the day. Rotation jobs run their own placement
        //   loop; keep them OUT of the scarce-special budget pre-calc so its
        //   claims don't consume capacity the rotation never uses.
        const _rotationOptions = (job) => {
            if (!job || job.blockB || job.multiGuarantee) return null;
            // ★ Rotation options by connected-tile count:
            //   • 1 tile (or standalone) → all three [Main 1, Main 2, Fallback]: each bunk
            //     picks ONE, with Main 1/Main 2 preferred (tried first) and the Fallback
            //     reachable when neither main can be placed.
            //   • 2 tiles → [Main 1, Main 2]: each bunk gets BOTH mains (e.g. Special+Swim).
            //   • 3+ tiles → [Main 1, Fallback, Main 2]: the Fallback is promoted so every
            //     bunk walks all three across the group.
            const _gs = job.groupSize;
            let ordered;
            if (_gs === 2) ordered = [job.main1, job.main2];
            else if (_gs >= 3) ordered = [job.main1, job.fallbackActivity, job.main2];
            else ordered = [job.main1, job.main2, job.fallbackActivity];
            const seen = new Set(); const opts = [];
            ordered.forEach(v => {
                const t = String(v || '').trim(); const k = t.toLowerCase();
                if (!t || seen.has(k)) return; seen.add(k); opts.push(t);
            });
            return opts.length >= 2 ? opts : null;
        };

        // Group jobs by time window key so we can pool capacity across divisions
        const _windowJobs = {};
        filteredJobs.forEach(job => {
            if (job.multiGuarantee) return;   // self-handled by the multi-tile guarantee pre-pass + placement branch
            [job.blockA, job.blockB].forEach(block => {
                if (!block) return;
                const wk = `${block.startMin}|${block.endMin}`;
                if (!_windowJobs[wk]) _windowJobs[wk] = [];
                if (!_windowJobs[wk].find(j => j.division === job.division)) {
                    _windowJobs[wk].push(job);
                }
            });
        });

        const _globalPriority = window.loadGlobalSettings?.()?.smartTilePriority || {};
        const _allSpecialNames = (window.getGlobalSpecialActivities?.() || []).map(s => s.name);

        // ★ GRADE ACCESS PRIORITY (manual parity with the auto solver).
        //   Each special whose Access & Restrictions enable a Priority Order
        //   contributes per-grade rank votes (priorityList index). Under capacity
        //   contention, bunks of higher-priority grades are ranked first in the
        //   pre-allocation below, so they claim the limited special before
        //   lower-priority grades — the same effect as the grade-processing order
        //   in scheduler_core_auto.js. STRICT NO-OP when no special uses priority
        //   (comparator returns 0 → bunk ranking is byte-identical to before).
        const _specialGradePriority = (() => {
            const score = {}, count = {};
            const _specials = (window.getGlobalSpecialActivities?.() || window.getAllSpecialActivities?.() || []);
            _specials.forEach(s => {
                const ar = s && s.accessRestrictions;
                if (ar && ar.usePriority && Array.isArray(ar.priorityList) && ar.priorityList.length > 0) {
                    ar.priorityList.forEach((g, idx) => {
                        score[g] = (score[g] || 0) + idx;
                        count[g] = (count[g] || 0) + 1;
                    });
                }
            });
            return { score, count, active: Object.keys(score).length > 0 };
        })();
        // Compare two divisions by grade priority: lower average vote rank = higher
        // priority; grades with no votes sort AFTER ranked grades (mirrors auto's
        // tie-break at scheduler_core_auto.js). Returns 0 when priority is inactive.
        function _gradePriorityCmp(divA, divB) {
            if (!_specialGradePriority.active) return 0;
            const cA = _specialGradePriority.count[divA] || 0;
            const cB = _specialGradePriority.count[divB] || 0;
            if (cA === 0 && cB === 0) return 0;
            if (cA === 0) return 1;
            if (cB === 0) return -1;
            return (_specialGradePriority.score[divA] / cA) - (_specialGradePriority.score[divB] / cB);
        }

      // Overlap-based claim tracker — keyed by the special's PHYSICAL FACILITY (its
        // configured location) rather than its name, so two DIFFERENTLY-named specials
        // that live in the SAME room (e.g. "Arts & Crafts" and "Leather" both hosted in
        // "Arts & Crafts Shack") can't be scheduled there at the same time. A room runs
        // one activity at a time; the sharability/capacity rules below apply only to
        // multiple bunks doing the SAME activity. Self-hosted specials (location == name,
        // or no location) fall back to the name key → identical to the old behavior.
        const _specialClaims = {}; // facilityKey → [{startMin, endMin, divName, actLower}]
        // Resolve a special to the key its claims are tracked under: its configured
        // facility when present, else the special's own name.
        function _claimKey(name) {
            const resolver = window.getLocationForActivity || getLocationForActivity;
            const loc = (typeof resolver === 'function') ? resolver(name) : null;
            return String(loc || name).toLowerCase().trim();
        }
        function _getSharableWith(name) {
            const key = Object.keys(activityProperties || {}).find(k => k.toLowerCase() === name.toLowerCase());
            return (activityProperties?.[name] || activityProperties?.[key] || {}).sharableWith || null;
        }
        function _canClaim(name, startMin, endMin, maxCap, requesterDiv) {
            const lower = name.toLowerCase();
            const existing = _specialClaims[_claimKey(name)] || [];
            const overlapping = existing.filter(c => c.startMin < endMin && c.endMin > startMin);
            if (overlapping.length === 0) return true;
            // ★ A facility hosts ONE activity at a time — if this room is already held by
            //   a DIFFERENT special in an overlapping window, it can't take this one too
            //   (regardless of either special's sharability/capacity).
            if (overlapping.some(c => c.actLower && c.actLower !== lower)) return false;
            const sw = _getSharableWith(name);
            // Not sharable: hard cap of 1, cross-division always blocked
            if (!sw || sw.type === 'not_sharable') {
                const crossDiv = overlapping.find(c => c.divName !== requesterDiv);
                if (crossDiv) return false;
                const sameDivClaims = overlapping.filter(c => c.divName === requesterDiv);
                return sameDivClaims.length < 1;
            }
            // Same-division only: block if any OTHER division already claimed it
            if (sw.type === 'same_division' || sw.type === 'division_only') {
                const crossDiv = overlapping.find(c => c.divName && c.divName !== requesterDiv);
                if (crossDiv) return false;
                return overlapping.length < maxCap;
            }
            // Unlimited cross-division sharing
            if (sw.type === 'all') return true;
            // Custom capacity: allow up to cap (cross-division)
            return overlapping.length < maxCap;
        }
        function _registerClaim(name, startMin, endMin, divName) {
            const key = _claimKey(name);
            if (!_specialClaims[key]) _specialClaims[key] = [];
            _specialClaims[key].push({ startMin, endMin, divName, actLower: name.toLowerCase() });
        }

        // ★ BUNK-LEVEL ROTATION GATE — single source of truth (rotation_engine.js).
        //   Every OTHER manual special-placement path scores candidates through
        //   RotationEngine.calculateLimitScore; the Smart Tile budget pre-pass,
        //   guarantee pre-pass (_seatSpecials) and the per-bunk rotation loop did
        //   NOT, so smart-placed specials ignored: frequencyDays cooldown,
        //   availableDays weekday, multiPart daysBetween/totalParts, rotationCohort,
        //   and even the maxUsage / exactFrequency ceilings. calculateLimitScore
        //   returns Infinity exactly when the special must NOT be placed for this
        //   bunk — re-use it so the swap engine matches the rest of the builder.
        //   Fail-open (only block on an explicit Infinity) so nothing is silently
        //   dropped if the engine isn't loaded; blocked specials simply route the
        //   bunk to its fallback/open activity, so slots are never left empty.
        const _specialGateBlocks = (bunk, divName, specialName) => {
            const RE = window.RotationEngine;
            if (!RE || typeof RE.calculateLimitScore !== 'function' || !specialName) return false;
            try { return RE.calculateLimitScore(bunk, specialName, activityProperties, divName) === Infinity; }
            catch (_eGate) { return false; }
        };

        // ★ FIELD-LESS DIRECT-FILL CAPACITY (e.g. Pickleball).
        //   A rotation/tile option that is NOT a configured field, special, or hosted
        //   sport is placed as its own label — exactly like Swim (the "direct fill"
        //   branch): the cell just reads "Pickleball", no solver and no real field
        //   needed. Most such labels are unlimited (Swim — everyone can go), but some
        //   have a real-world cap the camp hasn't modeled as a field (e.g. only 2
        //   pickleball nets). Hardcode those caps here and enforce them CAMP-WIDE per
        //   overlapping window via this tracker, so the 3rd bunk falls through to its
        //   next rotation option (like a scarce special does) instead of over-filling.
        //   Name match is loose so spelling variants ("Pickleball"/"Pickelball") resolve.
        const _directFillClaims = {}; // labelKey → [{startMin, endMin}]
        function _directFillCap(label) {
            const n = String(label || '').toLowerCase().replace(/[^a-z]/g, '');
            if (n.includes('pickle') || n.includes('pickel')) return 2; // pickleball: 2 bunks at a time
            return Infinity; // Swim and other field-less labels are uncapped
        }
        function _canClaimDirectFill(label, startMin, endMin) {
            const cap = _directFillCap(label);
            if (cap === Infinity) return true;
            const key = String(label || '').toLowerCase().trim();
            const overlapping = (_directFillClaims[key] || []).filter(c => c.startMin < endMin && c.endMin > startMin);
            return overlapping.length < cap;
        }
        function _registerDirectFillClaim(label, startMin, endMin) {
            if (_directFillCap(label) === Infinity) return;
            const key = String(label || '').toLowerCase().trim();
            (_directFillClaims[key] = _directFillClaims[key] || []).push({ startMin, endMin });
        }

        // ★ SAME-DAY SPECIAL TRACKER (per bunk, accumulates across windows in
        //   processing order). Two purposes, both of which the budget lacked:
        //   (1) NO DOUBLES — a bunk is never handed a special it already has
        //       today (the budget ranks every window by UNCHANGING historical
        //       counts, so the same least-used special was re-picked window
        //       after window). (2) RESTORE THE A/B SWAP — ranking bunks with
        //       fewer specials-so-far first means a bunk that already got a
        //       special this day yields the next window to a bunk that got the
        //       open activity, so each bunk alternates special↔sport instead of
        //       the same "deserving" bunks hogging specials in every window.
        //   Keyed by bunk (globally unique, same as historicalCounts).
        const _bunkSpecialsToday = {};
        // ★ SEED FROM THE EXISTING SCHEDULE — the doubling fix. By the time smart
        //   tiles run (STEP 6) a bunk may ALREADY hold a special placed by an
        //   earlier pass: STEP 1.5 background-schedule restore (locked divisions),
        //   STEP 2 bunk overrides, STEP 2.5 elective tiles, or a pinned special.
        //   The tracker started empty and was blind to all of these, so the budget /
        //   guarantee / rotation passes would re-hand the SAME special to a bunk that
        //   already had it today — the "bunks already have specials, now doubled" bug.
        //   Scan each bunk's current assignments and pre-load every known special it
        //   already holds so every downstream dedup check (.has(name)) and the
        //   fewest-specials-first ranking treat it as already-served. Additive and
        //   self-limiting: only KNOWN special names are seeded, so sports/swim/empty
        //   slots are untouched and an uncontended day is unchanged.
        try {
            const _sa = window.scheduleAssignments || {};
            Object.keys(_sa).forEach(bunk => {
                const arr = _sa[bunk];
                if (!Array.isArray(arr)) return;
                arr.forEach(e => {
                    if (!e || e.continuation) return;
                    const act = String(e._activity || e.field || '').toLowerCase().trim();
                    if (act && knownSpecialNames.has(act)) {
                        (_bunkSpecialsToday[bunk] = _bunkSpecialsToday[bunk] || new Set()).add(act);
                    }
                });
            });
        } catch (_e) { /* fail-open: an unreadable schedule just means no pre-seed */ }
        const _todayCount = b => (_bunkSpecialsToday[b] ? _bunkSpecialsToday[b].size : 0);

        // ★ GUARANTEED SWAP (kill-switch: window.__smartTileGuaranteeSwap = false).
        //   For a TWO-period Smart pair the user ticked "Guarantee each bunk gets
        //   both" on (smartData.guaranteeSwap) — Main 1 = the limited/special side,
        //   Main 2 = the open side — make Period B the exact per-bunk INVERSE of
        //   Period A (special↔sport). Deterministic → every bunk gets exactly one special and
        //   one sport, never a double, regardless of capacity luck. The Period-A
        //   special count k is chosen so NEITHER period runs short: k ∈ [N−C_B, C_A]
        //   aimed at the capacity-proportional split, so the ratio FLEXES to the two
        //   periods' capacities (60/40 if that's what fits) rather than a forced
        //   50/50. Genuine total shortage (C_A+C_B < N) can't seat everyone; it then
        //   maximizes coverage. These pairs are handled here and EXCLUDED from the
        //   per-window budget below, so the inverse mapping is authoritative
        //   (routeActivity applies smartTileBudget: a name → that special, false →
        //   the fallback sport).
        const _gsEnabled = (window.__smartTileGuaranteeSwap !== false);
        // Triggered by the per-tile "Guarantee each bunk gets both" checkbox in the
        // Smart Tile dialog (smartData.guaranteeSwap → job.guaranteeSwap). Gated by
        // the global kill-switch and limited to real two-period pairs.
        function _isGuaranteedSwapPair(job) {
            return !!(_gsEnabled && job && job.guaranteeSwap && job.blockB && !_rotationOptions(job));
        }
        // Seat each bunk (in fairness order) into the least-historical claimable
        // special in a window; returns { bunk: specialName } for those seated. Uses
        // the shared claim tracker so cross-division capacity is respected.
        function _seatSpecials(bunksInOrder, startMin, endMin, divName, avail) {
            const out = {};
            bunksInOrder.forEach(bunk => {
                const hist = historicalCounts[bunk] || {};
                const _had = _bunkSpecialsToday[bunk];
                const cands = [...avail].sort((a, b) => (hist[a.name] || 0) - (hist[b.name] || 0));
                for (const s of cands) {
                    if (_had && _had.has(s.name.toLowerCase())) continue; // no double — bunk already has this special today
                    if (_specialGateBlocks(bunk, divName, s.name)) continue;   // cooldown/availableDays/multiPart/cohort/ceiling
                    if (!_canClaim(s.name, startMin, endMin, s.capacity || 1, divName)) continue;
                    _registerClaim(s.name, startMin, endMin, divName);
                    out[bunk] = s.name;
                    (_bunkSpecialsToday[bunk] = _bunkSpecialsToday[bunk] || new Set()).add(s.name.toLowerCase());
                    break;
                }
            });
            return out;
        }
        // ★ DEPRIVATION-ORDERED GUARANTEE PRE-PASS. Both the 2-tile swap and the 3+
        //   tile multi-guarantee reserve scarce special rooms BEFORE the per-window
        //   budget. When rooms are tighter than camp-wide demand, whichever divisions
        //   are processed FIRST win them — so a fixed order starves the SAME divisions
        //   every day. Instead, order the guarantee divisions by cumulative deprivation
        //   (avg specials-per-bunk so far, from the cloud rotation history): the
        //   division that has gone longest without specials reserves FIRST. Because the
        //   history is cumulative, a division starved today drops to the front
        //   tomorrow → "didn't get it today, gets it tomorrow", rotating the shortage
        //   across divisions instead of pinning it on one. Within a unit, bunks are
        //   still ranked by their own fairness score (least-used first).
        const _mgGroups = {};
        filteredJobs.forEach(job => {
            if (!job.multiGuarantee) return;
            const gid = job.guaranteeGroupId || (job.division + '|' + (job.pairGroup || '?'));
            (_mgGroups[gid] = _mgGroups[gid] || { div: job.division, blocks: [] }).blocks.push(job.blockA);
        });
        const _divDeprivation = (div) => {
            const bunks = (divisions[div] && divisions[div].bunks) || [];
            if (!bunks.length) return Infinity;
            let tot = 0;
            bunks.forEach(b => { const h = historicalCounts[b] || {}; tot += _allSpecialNames.reduce((s, n) => s + (h[n] || 0), 0); });
            return tot / bunks.length;
        };
        const _guaranteeUnits = [];
        filteredJobs.forEach(job => { if (_isGuaranteedSwapPair(job)) _guaranteeUnits.push({ kind: 'pair', div: job.division, job }); });
        Object.values(_mgGroups).forEach(grp => { _guaranteeUnits.push({ kind: 'multi', div: grp.div, grp }); });
        // Oldest division first (seniority policy), then most-deprived, then name.
        // Seniority decides WHO reserves the scarce special rooms first; deprivation
        // only breaks ties between equally-senior units (rare — seniority is unique
        // per division) so the day-to-day rotation stays a stable fallback.
        _guaranteeUnits.sort((a, b) =>
            (_senOf(a.div) - _senOf(b.div)) ||
            (_divDeprivation(a.div) - _divDeprivation(b.div)) ||
            String(a.div).localeCompare(String(b.div)));
        if (_guaranteeUnits.length) console.log(`[SmartTile FAIR-ORDER] ${_guaranteeUnits.map(u => `${u.div}(${_divDeprivation(u.div).toFixed(1)})`).join(' < ')}`);

        _guaranteeUnits.forEach(unit => {
            const divName = unit.div;
            const bunkList = (divisions[divName] && divisions[divName].bunks) || [];
            const N = bunkList.length;
            if (N === 0) return;
            // Rank bunks by fairness (least special usage first); the configured
            // per-division priority only BREAKS TIES, not overrides fairness.
            const divPriority = _globalPriority[divName] || [];
            const ordered = [...bunkList].map(b => {
                const h = historicalCounts[b] || {};
                return { b, usage: _allSpecialNames.reduce((s, n) => s + (h[n] || 0), 0), prioRank: divPriority.includes(b) ? 0 : 1 };
            }).sort((x, y) => (x.usage - y.usage) || (x.prioRank - y.prioRank) || (Math.random() - 0.5)).map(r => r.b);

            if (unit.kind === 'pair') {
                const job = unit.job;
                const A = job.blockA, B = job.blockB;
                const availA = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(A.startMin, A.endMin, divName, activityProperties, dailyFieldAvailability) || [];
                const availB = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(B.startMin, B.endMin, divName, activityProperties, dailyFieldAvailability) || [];
                const C_A = availA.reduce((s, x) => s + (x.capacity || 1), 0);
                const C_B = availB.reduce((s, x) => s + (x.capacity || 1), 0);
                // k bunks do the special in Period A (the rest do it in Period B). Clamp
                // to [N−C_B, C_A] so neither period is asked to seat more specials than it
                // can hold; aim at the capacity-proportional split within that window.
                const lo = Math.max(0, N - C_B), hi = Math.min(N, C_A);
                let k;
                if (lo <= hi) {
                    const target = Math.round(N * C_A / ((C_A + C_B) || 1));
                    k = Math.max(lo, Math.min(hi, target));
                } else {
                    k = hi;   // C_A + C_B < N → can't give everyone one; seat the most we can
                }
                const seatA = _seatSpecials(ordered.slice(0, k), A.startMin, A.endMin, divName, availA);   // special in A → sport in B
                const seatB = _seatSpecials(ordered.slice(k), B.startMin, B.endMin, divName, availB);      // sport in A → special in B
                bunkList.forEach(b => {
                    smartTileBudget[`${divName}|${b}|${A.startMin}|${A.endMin}`] = seatA[b] || false;
                    smartTileBudget[`${divName}|${b}|${B.startMin}|${B.endMin}`] = seatB[b] || false;
                });
                console.log(`[SmartTile GUARANTEE] ${divName}: N=${N} capA=${C_A} capB=${C_B} k=${k} → A-special=${Object.keys(seatA).length}, B-special=${Object.keys(seatB).length}`);
            } else {
                const grp = unit.grp;
                const blocks = grp.blocks.slice().sort((a, b) => a.startMin - b.startMin);
                const avail = blocks.map(b => window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(b.startMin, b.endMin, divName, activityProperties, dailyFieldAvailability) || []);
                const cap = avail.map(a => a.reduce((s, x) => s + (x.capacity || 1), 0));
                const seated = blocks.map(() => 0);
                let total = 0;
                ordered.forEach(bunk => {
                    // try the period with the most remaining special headroom first
                    const tryOrder = blocks.map((_, i) => i).sort((i, j) => (cap[j] - seated[j]) - (cap[i] - seated[i]));
                    let gotName = null, gotIdx = -1;
                    for (const i of tryOrder) {
                        const s = _seatSpecials([bunk], blocks[i].startMin, blocks[i].endMin, divName, avail[i]);
                        if (s[bunk]) { gotName = s[bunk]; gotIdx = i; break; }
                    }
                    blocks.forEach((b, i) => {
                        smartTileBudget[`${divName}|${bunk}|${b.startMin}|${b.endMin}`] = (i === gotIdx) ? gotName : false;
                    });
                    if (gotIdx >= 0) { seated[gotIdx]++; total++; }
                });
                console.log(`[SmartTile GUARANTEE-MULTI] ${divName}: N=${N} tiles=${blocks.length} caps=[${cap.join(',')}] seated=${total}/${N} perTile=[${seated.join(',')}]`);
            }
        });

        // =====================================================================
        // ★ FAIR-SHARE SPECIAL ROOMS ACROSS OVERLAPPING ROTATION TILES (per-facility)
        //   + SENIORITY RESERVATION (runs BEFORE the per-window budget below).
        //   Two ROTATION smart tiles whose TIME windows overlap (e.g. div 7 @930-1010
        //   and div 8/9 @970-1020) compete for the same shared special ROOMS. Each tile
        //   gets a per-window quota = the SUM, over each special ROOM it can access, of
        //   that room's capacity split (by special-demand) among the overlapping tiles
        //   that can ALSO access it. Properties:
        //     • A room only ONE tile can access → that tile gets its full capacity (no cap)
        //       → uncontended windows are a STRICT NO-OP (quota = full accessible pool).
        //     • Heavily contended rooms → each tile gets a fair slice.
        //   ★ WHY THIS MOVED ABOVE THE BUDGET: the per-window budget pre-pass (below)
        //   claims special rooms for BUDGET-mode tiles (e.g. div 7's "Special / Swim"
        //   swap) and runs BEFORE the rotation placement loop where 8th/9th-grade
        //   rotation tiles claim. So a JUNIOR budget division in an overlapping window
        //   used to lock the shared rooms first, starving the SENIOR rotation divisions
        //   (observed live: 8th/9th "Special" @970-1020 found every room already held by
        //   div 7 @930-1010, a phantom claim div 7 never even placed). Fix: build the
        //   quota here and let the senior rotation divisions RESERVE their fair share of
        //   rooms up-front (filteredJobs is seniority-sorted oldest→youngest), so the
        //   budget can only hand junior divisions what's left.
        //   "Demand" ≈ bunks / option-count; quota is an UPPER bound (real claiming still
        //   respects room availability, so an unused quota never wastes a room).
        // =====================================================================
        const _rotSpecialQuota = {};   // `${div}|${start}|${end}` -> max specials claimable
        const _rotSpecialClaimed = {}; // same key -> running count
        // ★ Per-division special PRIORITY weight: a division gets this many times its
        //   normal demand in the fair-share split, so it claims a BIGGER slice of the
        //   contended special rooms. Default is SENIORITY-DERIVED — the oldest division
        //   (rank 0) gets the largest weight, the youngest the smallest, so under
        //   contention the oldest claim more of the shared rooms while the quota's
        //   Math.max(1,…) floor still reserves a minimum slice for younger divisions.
        //   (Replaces the old hardcoded { '9': 8 } band-aid.) A runtime override via
        //   window.__smartTileSpecialWeight still wins per-division.
        const _specialWeightMap = window.__smartTileSpecialWeight || null;
        const _specialWeight = (d) => {
            if (_specialWeightMap && _specialWeightMap[d]) return _specialWeightMap[d];
            const r = _seniorityRank[String(d)];
            return (r === undefined) ? 1 : (_numSeniorityDivs - r);
        };
        (function _buildRotationSpecialQuotas() {
            const rj = [];
            filteredJobs.forEach(job => {
                const opts = _rotationOptions(job);
                if (!opts || !job.blockA) return;
                if (!opts.some(o => normalizeCategoryLabel(o) === 'special'
                    || knownSpecialNames.has(String(o).toLowerCase().trim()))) return;
                const b = job.blockA;
                const bunks = (divisions[job.division]?.bunks || []).length || 1;
                const avail = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(
                    b.startMin, b.endMin, job.division, activityProperties, dailyFieldAvailability) || [];
                const facs = new Map(); // facilityKey -> capacity (max seen)
                avail.forEach(s => {
                    const k = _claimKey(s.name);
                    const c = (s.capacity && s.capacity > 0) ? s.capacity : 1;
                    facs.set(k, Math.max(facs.get(k) || 0, c));
                });
                if (!facs.size) return;
                rj.push({ div: job.division, s: b.startMin, e: b.endMin, demand: (bunks / Math.max(1, opts.length)) * _specialWeight(job.division), facs, key: `${job.division}|${b.startMin}|${b.endMin}` });
            });
            rj.forEach(j => {
                let q = 0, contended = false;
                j.facs.forEach((cap, f) => {
                    let denom = 0, sharers = 0;
                    rj.forEach(k => { if (k.s < j.e && k.e > j.s && k.facs.has(f)) { denom += k.demand; sharers++; } });
                    if (denom > 0) q += cap * j.demand / denom;
                    if (sharers > 1) contended = true;
                });
                // No contention on ANY accessible room → leave uncapped (Infinity) so this is a
                // byte-for-byte no-op for the common case.
                _rotSpecialQuota[j.key] = contended ? Math.max(1, Math.floor(q + 1e-9)) : Infinity;
                if (contended) console.log(`[SmartTile FAIR-SPECIAL] ${j.div} @${j.s}-${j.e}: quota ${_rotSpecialQuota[j.key]} (fair share of ${j.facs.size} accessible room(s))`);
            });
        })();

        // ★ SENIORITY RESERVATION: senior rotation divisions lock their fair-share
        //   special rooms NOW, before the budget pre-pass can hand them to a junior
        //   budget division in an overlapping window. Only CONTENDED windows (finite
        //   quota) reserve — uncontended is a strict no-op. The rotation placement loop
        //   later CONSUMES these reservations (they are already claimed for the division).
        const _rotReserved = {}; // `${div}|${start}|${end}` -> [specialName,...] pre-claimed rooms
        (function _reserveRotationSpecials() {
            filteredJobs.forEach(job => {
                const opts = _rotationOptions(job);
                if (!opts || !job.blockA) return;
                if (!opts.some(o => normalizeCategoryLabel(o) === 'special'
                    || knownSpecialNames.has(String(o).toLowerCase().trim()))) return;
                const divName = job.division;
                const b = job.blockA;
                const wQ = `${divName}|${b.startMin}|${b.endMin}`;
                const quota = _rotSpecialQuota[wQ];
                if (quota === undefined || quota === Infinity) return; // only contended windows
                let toReserve = Math.min(quota, (divisions[divName]?.bunks || []).length);
                if (toReserve <= 0) return;
                const avail = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(
                    b.startMin, b.endMin, divName, activityProperties, dailyFieldAvailability) || [];
                for (const sp of avail) {
                    if (toReserve <= 0) break;
                    if (!_canClaim(sp.name, b.startMin, b.endMin, sp.capacity || 1, divName)) continue;
                    _registerClaim(sp.name, b.startMin, b.endMin, divName);
                    (_rotReserved[wQ] = _rotReserved[wQ] || []).push(sp.name);
                    toReserve--;
                }
                if (_rotReserved[wQ] && _rotReserved[wQ].length)
                    console.log(`[SmartTile SENIORITY-RESERVE] ${divName} @${b.startMin}-${b.endMin}: reserved ${_rotReserved[wQ].length} room(s) [${_rotReserved[wQ].join(', ')}]`);
            });
        })();

        Object.entries(_windowJobs).forEach(([wk, wJobs]) => {
            const [startMin, endMin] = wk.split('|').map(Number);

            // Only process windows where at least one job has a fallback-able special main
            // (rotation-mode jobs place themselves — excluding them keeps the budget's
            // claim registrations from eating capacity the rotation never consumes)
            const fallbackableJobs = wJobs.filter(j => !_rotationOptions(j) && !_isGuaranteedSwapPair(j) && (_isSpecialLabel(j.fallbackFor) || _isSpecialLabel(j.main2)));
            if (fallbackableJobs.length === 0) return;

            // Total special capacity for this window — deduplicated by name
            // A special with capacity=1 counts as 1 slot regardless of how many divisions can use it
            const _uniqueSpecials = new Map();
            fallbackableJobs.forEach(job => {
                const available = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(
                    startMin, endMin, job.division, activityProperties, dailyFieldAvailability
                ) || [];
                available.forEach(a => {
                    if (!_uniqueSpecials.has(a.name)) {
                        _uniqueSpecials.set(a.name, a.capacity);
                    }
                });
            });
            const totalCapacity = [..._uniqueSpecials.values()].reduce((s, c) => s + c, 0);

            // Collect all bunks across fallbackable divisions and rank by fairness
            const _bunkRankings = [];
            fallbackableJobs.forEach(job => {
                const divName = job.division;
                const bunkList = divisions[divName]?.bunks || [];
                const divPriority = _globalPriority[divName] || [];
                bunkList.forEach(bunk => {
                    const bunkHist = historicalCounts[bunk] || {};
                    const totalUsage = _allSpecialNames.reduce((s, n) => s + (bunkHist[n] || 0), 0);
                    // ★ Priority is a TIEBREAKER only — keep fairness (usage) pure and
                    //   rank the configured per-division priority list separately below.
                    const prioRank = divPriority.includes(bunk) ? 0 : 1;
                    _bunkRankings.push({ bunk, divName, usage: totalUsage, prioRank });
                });
            });

            // Build per-division special availability map
            const _divSpecialMap = new Map();
            fallbackableJobs.forEach(job => {
                const avail = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(
                    startMin, endMin, job.division, activityProperties, dailyFieldAvailability
                ) || [];
                _divSpecialMap.set(job.division, avail.map(a => a.name));
            });

            // Build special pool with deduplicated capacity
            const _specialPool = new Map();
            _uniqueSpecials.forEach((cap, name) => _specialPool.set(name, cap));

            // Sort by SENIORITY first (oldest division → youngest), then fairness
            // WITHIN a division (fewest specials today, then fewest cumulatively),
            // then the configured priority list as a final tiebreak. Seniority
            // decides the cross-division order; fairness still rotates specials
            // among bunks of the SAME division across the week.
            _bunkRankings.sort((a, b) =>
                (_senOf(a.divName) - _senOf(b.divName)) ||
                (_todayCount(a.bunk) - _todayCount(b.bunk)) ||
                (a.usage - b.usage) ||
                _gradePriorityCmp(a.divName, b.divName) ||
                (a.prioRank - b.prioRank) ||
                (Math.random() - 0.5));
            _bunkRankings.forEach(entry => {
                const bk = `${entry.divName}|${entry.bunk}|${startMin}|${endMin}`;
                const hist = historicalCounts[entry.bunk] || {};
                const divSpecials = _divSpecialMap.get(entry.divName) || [];
                const _today = _bunkSpecialsToday[entry.bunk];
                const candidates = [..._specialPool.entries()]
                    .filter(([name, rem]) => rem > 0 && divSpecials.includes(name)
                        && !(_today && _today.has(name.toLowerCase())))
                    .sort((a, b) => (hist[a[0]] || 0) - (hist[b[0]] || 0));
               let _assigned = false;
               for (const [candidateName] of candidates) {
                    if (_specialGateBlocks(entry.bunk, entry.divName, candidateName)) continue;   // cooldown/availableDays/multiPart/cohort/ceiling
                    const _maxCap = _uniqueSpecials.get(candidateName) || 1;
                    if (!_canClaim(candidateName, startMin, endMin, _maxCap, entry.divName)) continue;
                    _specialPool.set(candidateName, _specialPool.get(candidateName) - 1);
                    _registerClaim(candidateName, startMin, endMin, entry.divName);
                    smartTileBudget[bk] = candidateName;
                    (_bunkSpecialsToday[entry.bunk] = _bunkSpecialsToday[entry.bunk] || new Set())
                        .add(candidateName.toLowerCase());
                    _assigned = true;
                    break;
                }
                if (!_assigned) smartTileBudget[bk] = false;});

            console.log(`[SmartTile V44.3] Window ${wk}: ${totalCapacity} special slots across ${_bunkRankings.length} bunks (${fallbackableJobs.map(j => j.division).join(', ')})`);
        });

        window.__smartTileBudget = smartTileBudget; // debug

        // =====================================================================
        // ★ V44.3: CAMP-WIDE PRE-ALLOCATION (budget calculated above)
        // =====================================================================
        // Step A: Group jobs by time window key "startMin|endMin"
        // A time window can have multiple divisions running smart tiles simultaneously
        const jobsByTimeWindow = {};
        filteredJobs.forEach(job => {
            if (job.multiGuarantee) return;   // self-handled by the multi-tile guarantee pre-pass + placement branch
            // Block A window
            const keyA = `${job.blockA.startMin}|${job.blockA.endMin}`;
            if (!jobsByTimeWindow[keyA]) jobsByTimeWindow[keyA] = [];
            jobsByTimeWindow[keyA].push({ job, block: 'A', blockInfo: job.blockA });

            // Block B window (if exists)
            if (job.blockB) {
                const keyB = `${job.blockB.startMin}|${job.blockB.endMin}`;
                if (!jobsByTimeWindow[keyB]) jobsByTimeWindow[keyB] = [];
                jobsByTimeWindow[keyB].push({ job, block: 'B', blockInfo: job.blockB });
            }
        });

        console.log(`[SmartTile V44.3] Time windows to pre-allocate: ${Object.keys(jobsByTimeWindow).length}`);

        // Step B: For each time window, calculate total available special slots
        // and rank all bunks across all participating divisions
        // preAllocation[divisionName][bunkName][blockKey] = 'special' | 'fallback'
        const preAllocation = {};

        Object.entries(jobsByTimeWindow).forEach(([windowKey, entries]) => {
            const [startMin, endMin] = windowKey.split('|').map(Number);

            console.log(`\n[PreAlloc] Window ${windowKey} (${entries.length} division(s)):`);

            // B1: Collect ALL available specials across all divisions in this window
            // keeping division restrictions in mind
            // Result: Map of specialName -> { totalCapacity, divisionsAllowed: Set }
            const specialPoolMap = {};

            entries.forEach(({ job }) => {
                const divName = job.division;
                const divSpecials = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(
                    startMin, endMin, divName,
                    activityProperties, dailyFieldAvailability
                ) || [];
                divSpecials.forEach(s => {
                    if (!specialPoolMap[s.name]) {
                        specialPoolMap[s.name] = {
                            capacity: s.capacity,
                            remaining: s.capacity,
                            divisionsAllowed: new Set(),
                            props: s.props
                        };
                    }
                    specialPoolMap[s.name].divisionsAllowed.add(divName);
                });
            });

            const totalSpecialSlots = Object.values(specialPoolMap)
                .reduce((sum, s) => sum + s.capacity, 0);

            console.log(`[PreAlloc]   Total special slots: ${totalSpecialSlots}`);
            console.log(`[PreAlloc]   Specials: ${Object.entries(specialPoolMap).map(([n,s]) => `${n}(${s.capacity})`).join(', ')}`);

            // B2: Collect ALL bunks across all divisions in this window
            // with their fairness scores
            const allBunkEntries = []; // { bunk, divName, job, fairnessScore }

           const priorityQueue = window.loadGlobalSettings?.()?.smartTilePriority || {};

            entries.forEach(({ job }) => {
                const divName = job.division;
                const bunkList = divisions[divName]?.bunks || [];
                const divPriority = priorityQueue[divName] || [];

               bunkList.forEach(bunk => {
                    const bunkHist = historicalCounts[bunk] || {};
                    const totalUsage = _allSpecialNames.reduce((s, n) => s + (bunkHist[n] || 0), 0);
                    // ★ Priority is a TIEBREAKER only — fairness (usage) stays pure;
                    //   the configured priority list + per-division priority break ties below.
                    const prioRank = divPriority.includes(bunk) ? 0 : 1;
                    allBunkEntries.push({ bunk, divName, usage: totalUsage, prioRank });
                });
            });

            // B3: Sort by SENIORITY first (oldest division → youngest), then fairness
            // WITHIN a division (fewest specials cumulatively), then the configured
            // priority list as a final tiebreak. Seniority decides the cross-division
            // order; fairness rotates specials among same-division bunks over the week.
            allBunkEntries.sort((a, b) =>
                (_senOf(a.divName) - _senOf(b.divName)) ||
                (a.usage - b.usage) ||
                _gradePriorityCmp(a.divName, b.divName) ||
                (a.prioRank - b.prioRank) ||
                (Math.random() - 0.5));

            console.log(`[PreAlloc]   Bunks: ${allBunkEntries.length}, Total slots: ${totalSpecialSlots}`);

            // B4: Assign budget top-down until capacity exhausted
            let remaining = totalSpecialSlots;
            allBunkEntries.forEach(({ bunk, divName }) => {
                if (!preAllocation[divName]) preAllocation[divName] = {};
                if (!preAllocation[divName][bunk]) preAllocation[divName][bunk] = {};
                preAllocation[divName][bunk][windowKey] = remaining > 0
                    ? { result: 'special' }
                    : { result: 'fallback' };
                if (remaining > 0) remaining--;
            });        });

        console.log(`\n[SmartTile V44.3] Pre-allocation complete. Passing to jobs...`);
        window.__smartPreAllocation = preAllocation; // debug

        const sharedCapacityTracker = {}; // kept for legacy compat

        // (Rotation special-quota build + seniority reservation moved ABOVE the budget
        //  pre-pass — see "FAIR-SHARE SPECIAL ROOMS … + SENIORITY RESERVATION" block.)

        // =====================================================================
        // ★ CAMP-WIDE QUEUE for SCARCE CAPPED labels (e.g. Pickleball = 2 nets).
        //   The cap is CAMP-WIDE (the whole camp shares the nets, enforced per
        //   overlapping window by _directFillClaims), but each division's rotation
        //   tile is a separate job. A per-division queue let whichever division ran
        //   first grab both nets every day and STARVE the others (confirmed live:
        //   div 9 took Pickleball daily, div 8's winners were chosen but never
        //   placed → counts frozen at 0 → won forever). So pool EVERY rotation
        //   bunk that wants the label in a shared time window into ONE queue and
        //   give the cap-many slots to the least-recent bunks CAMP-WIDE. Counts are
        //   read straight from saved schedules (not getActivityCount — that gates on
        //   getValidActivityNames). The per-job loop below just consults these maps.
        // =====================================================================
        const _cappedWinners = {}; // labelNorm -> Set(bunk) (camp-wide winners)
        const _winnerLabel = {};   // bunk -> raw label it won (placed up front in its job)
        const _mayTakeCapped = (opt, optNorm, bunk) =>
            (_directFillCap(opt) === Infinity) || !!(_cappedWinners[optNorm] && _cappedWinners[optNorm].has(bunk));
        (function _allocCampWideCappedQueue() {
            const _allDaily = (window.loadAllDailyData && window.loadAllDailyData()) || {};
            const _todayKey = window.currentScheduleDate || '';
            const _pastDatesDesc = Object.keys(_allDaily)
                .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!_todayKey || d < _todayKey))
                .sort((a, b) => b.localeCompare(a)); // most recent first → index = days-ago
            const _lrStats = (bunk, labelNorm) => {
                let n = 0, ago = 1e9;
                for (let di = 0; di < _pastDatesDesc.length; di++) {
                    const sched = (_allDaily[_pastDatesDesc[di]] && _allDaily[_pastDatesDesc[di]].scheduleAssignments
                        && _allDaily[_pastDatesDesc[di]].scheduleAssignments[bunk]) || [];
                    for (let i = 0; i < sched.length; i++) {
                        const e = sched[i];
                        if (!e || e.continuation || e._isTransition) continue;
                        if (String(e._activity || '').toLowerCase().trim() === labelNorm) { n++; if (di < ago) ago = di; break; }
                    }
                }
                return { count: n, ago };
            };
            // Group every rotation job's capped-label demand by (label + window). Bunks
            //   from DIFFERENT divisions sharing a window+label land in the same group →
            //   one pool, one cap.
            const groups = {}; // `${norm}|${start}|${end}` -> { raw, norm, cap, start, end, bunks:Set }
            filteredJobs.forEach(job => {
                const opts = _rotationOptions(job);
                if (!opts || !job.blockA) return;
                const start = job.blockA.startMin, end = job.blockA.endMin;
                const slots = Utils.findSlotsForRange(start, end, job.division);
                const seen = new Set();
                opts.forEach(o => {
                    const norm = String(o || '').toLowerCase().trim();
                    if (_directFillCap(o) === Infinity || seen.has(norm)) return;
                    seen.add(norm);
                    const key = `${norm}|${start}|${end}`;
                    const g = groups[key] || (groups[key] = { raw: o, norm, cap: _directFillCap(o), start, end, bunks: new Set() });
                    (divisions[job.division]?.bunks || []).forEach(bunk => {
                        const ex = (slots && slots[0] != null) ? window.scheduleAssignments[bunk]?.[slots[0]] : null;
                        if (ex && ex._bunkOverride) return; // overridden bunks untouchable
                        g.bunks.add(bunk);
                    });
                });
            });
            const claimed = new Set(); // a bunk wins at most one capped label
            Object.keys(groups).forEach(key => {
                const g = groups[key];
                const ranked = Array.from(g.bunks)
                    .filter(b => !claimed.has(b))
                    .map(b => { const s = _lrStats(b, g.norm); return { bunk: b, c: s.count, ago: s.ago }; })
                    .sort((a, b) => (a.c - b.c) || (b.ago - a.ago) || String(a.bunk).localeCompare(String(b.bunk)));
                const winners = ranked.slice(0, g.cap);
                winners.forEach(w => { claimed.add(w.bunk); _winnerLabel[w.bunk] = g.raw; (_cappedWinners[g.norm] = _cappedWinners[g.norm] || new Set()).add(w.bunk); });
                console.log(`[SmartTile] CAMP-WIDE QUEUE "${g.norm}" @${g.start}-${g.end} (cap ${g.cap}): winners [${winners.map(x => x.bunk + ':' + x.c).join(', ')}] of ${ranked.length} bunks camp-wide [${ranked.map(x => x.bunk + ':' + x.c).join(', ')}]`);
            });
        })();

        filteredJobs.forEach((job, jobIdx) => {

            console.log(`\n[SmartTile] Job ${jobIdx + 1}: ${job.division}`);

            const divName = job.division;
            const bunkList = divisions[divName]?.bunks || [];

            if (bunkList.length === 0) {
                console.warn(`[SmartTile] No bunks in division ${divName}`);
                return;
            }

            // ★ MULTI-TILE GUARANTEE placement: this tile is one period of a 3+ tile
            //   connected group. The pre-pass already chose (and claimed) each bunk's
            //   single special period; here we lay down THIS period — the reserved
            //   special, or the sport fallback — and self-handle the job (like the
            //   rotation branch does) so the 2-block A/B machinery is skipped.
            if (job.multiGuarantee) {
                const _mgSlots = Utils.findSlotsForRange(job.blockA.startMin, job.blockA.endMin, divName);
                if (_mgSlots.length === 0) {
                    console.warn(`[SmartTile] MULTI-GUARANTEE: no slots for ${divName} at ${job.blockA.startMin}-${job.blockA.endMin}`);
                    return;
                }
                const _mgFb = String(job.fallbackActivity || 'Sport');
                const _mgFbEvent = _mgFb.toLowerCase().includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                bunkList.forEach(bunk => {
                    const _ex = window.scheduleAssignments[bunk]?.[_mgSlots[0]];
                    if (_ex && _ex._bunkOverride) return;
                    const _bv = smartTileBudget[`${divName}|${bunk}|${job.blockA.startMin}|${job.blockA.endMin}`];
                    if (typeof _bv === 'string' && _bv) {
                        console.log(`[SmartTile] ${bunk} -> MULTI-GUARANTEE special: ${_bv}`);
                        window.fillBlock({ divName, bunk, startTime: job.blockA.startMin, endTime: job.blockA.endMin, slots: _mgSlots }, { field: _bv, sport: null, _fixed: true, _activity: _bv }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                        const _mgLoc = getLocationForActivity(_bv);
                        if (_mgLoc && window.GlobalFieldLocks) {
                            window.GlobalFieldLocks.lockField(_mgLoc, _mgSlots, { lockedBy: 'smart_tile_multi_guarantee', division: divName, activity: `${_bv} (multi-guarantee)` });
                        }
                    } else {
                        console.log(`[SmartTile] ${bunk} -> MULTI-GUARANTEE ${_mgFbEvent}`);
                        schedulableSlotBlocks.push({ divName, bunk, event: _mgFbEvent, startTime: job.blockA.startMin, endTime: job.blockA.endMin, slots: _mgSlots, fromSmartTile: true, _smartTileFallback: true });
                    }
                });
                return;
            }

            // ★ SINGLE-TILE ROTATION MODE: each bunk walks the configured
            //   options cycle offset by (day + bunk index) — so every bunk
            //   experiences Special on day 1, Pickleball on day 2, Swim on
            //   day 3 (etc.), while on any single day the division spreads a
            //   third per option (scarce capacity stays sane). Same date
            //   regenerated → same assignment (deterministic). Infeasible
            //   options fall through to the bunk's next option in the cycle.
            const _rotOpts = _rotationOptions(job);
            if (_rotOpts) {
                const _dayNum = (() => {
                    try { const d = String(window.currentScheduleDate || '').split('-'); const n = Math.floor(Date.UTC(+d[0], +d[1] - 1, +d[2]) / 86400000); return isFinite(n) ? n : 0; } catch (_) { return 0; }
                })();
                const _rStart = job.blockA.startMin, _rEnd = job.blockA.endMin;
                const _rotSlots = Utils.findSlotsForRange(_rStart, _rEnd, divName);
                if (_rotSlots.length === 0) {
                    console.warn(`[SmartTile] ROTATION: no slots for ${divName} at ${_rStart}-${_rEnd}`);
                    return;
                }
                // ★ Connected-group rotation: offset this tile's cycle by its position
                //   in the group so each bunk gets a DIFFERENT option per connected tile
                //   (→ all options across the group); _usedOpts blocks any repeat.
                const _grp = job.pairGroup, _grpOff = job.groupIndex || 0;
                console.log(`[SmartTile] ROTATION MODE ${divName}${_grp ? ' (group ' + _grp + ' #' + _grpOff + ')' : ''}: [${_rotOpts.join(' → ')}], offset ${(_dayNum + _grpOff) % _rotOpts.length}`);
                // ★ Scarce capped labels (Pickleball) are owned by the CAMP-WIDE queue computed
                //   once before this loop (_cappedWinners / _winnerLabel / _mayTakeCapped). Winners
                //   for THIS division are placed up front below; non-winners skip the label.
                bunkList.forEach((bunk, _bIdx) => {
                    const _rEx = window.scheduleAssignments[bunk]?.[_rotSlots[0]];
                    if (_rEx && _rEx._bunkOverride) return;
                    const _usedOpts = _grp ? ((_groupOptsUsed[_grp] = _groupOptsUsed[_grp] || {})[bunk] = _groupOptsUsed[_grp][bunk] || new Set()) : null;
                    let _placed = false, _placedOpt = null;
                    // ★ DIVISION-WIDE QUEUE: if this bunk is one of the least-recent winners for a
                    //   scarce capped label (e.g. Pickleball), give it that label UP FRONT — overriding
                    //   its day-rotation primary — so the cap-many slots always go to the longest-
                    //   waiting bunks across the whole CAMP, not this day's offset turn-group.
                    //   Placed as a FIELD-LESS label (the camp-wide queue already enforces the cap, and
                    //   this is the path proven to persist + be counted next day; the solver-restricted
                    //   "real court" route silently dropped placements under cross-division contention,
                    //   which froze a starved division's counts at 0).
                    const _wonRaw = _winnerLabel[bunk];
                    if (_wonRaw && _canClaimDirectFill(_wonRaw, _rStart, _rEnd)) {
                        _registerDirectFillClaim(_wonRaw, _rStart, _rEnd);
                        console.log(`[SmartTile] ${bunk} -> ROTATION QUEUE (least-recent, camp-wide): ${_wonRaw}`);
                        window.fillBlock({ divName, bunk, startTime: _rStart, endTime: _rEnd, slots: _rotSlots }, { field: _wonRaw, sport: null, _fixed: true, _activity: _wonRaw, _noRoomCap: true }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                        _placed = true; _placedOpt = String(_wonRaw).toLowerCase().trim();
                    }
                    for (let _o = 0; _o < _rotOpts.length && !_placed; _o++) {
                        const opt = _rotOpts[(_dayNum + _bIdx + _grpOff + _o) % _rotOpts.length];
                        const optNorm = opt.toLowerCase().trim();
                        if (_usedOpts && _usedOpts.has(optNorm)) continue; // already got this option in the group
                        _placedOpt = optNorm;
                        if (needsGeneration(opt)) {
                            if (optNorm.includes('special')) {
                                // Category SPECIAL → this bunk's least-done claimable special
                                // it hasn't already had TODAY (day-wide, across all groups).
                                const _avail = window.SmartLogicAdapter?.getAvailableSpecialsForTimeBlock?.(_rStart, _rEnd, divName, activityProperties, dailyFieldAvailability) || [];
                                const _h = historicalCounts[bunk] || {};
                                const _had = _bunkSpecialsToday[bunk];
                                _avail.sort((a, b) => (_h[a.name] || 0) - (_h[b.name] || 0));
                                // ★ Fair-share cap: stop claiming specials once this division has taken
                                //   its fair share of the rooms shared with an OVERLAPPING rotation tile,
                                //   leaving the rest for the later division. Infinity quota (uncontended)
                                //   never trips this → no behavior change.
                                const _wQ = `${divName}|${_rStart}|${_rEnd}`;
                                const _atQuota = (_rotSpecialQuota[_wQ] !== undefined)
                                    && ((_rotSpecialClaimed[_wQ] || 0) >= _rotSpecialQuota[_wQ]);
                                if (_atQuota) console.log(`[SmartTile] ${bunk} -> ROTATION "Special" at fair-share cap (${_rotSpecialQuota[_wQ]}/window, shared rooms) → next option`);
                                // ★ Consume a seniority-RESERVED room first — already claimed
                                //   up-front for this senior division before the budget pre-pass
                                //   ran, so a junior budget division in an overlapping window
                                //   couldn't steal it. Skip _canClaim: the room is already ours.
                                const _resvList = _rotReserved[_wQ];
                                if (!_atQuota && _resvList && _resvList.length) {
                                    for (let _ri = 0; _ri < _resvList.length; _ri++) {
                                        const _rn = _resvList[_ri];
                                        if (_had && _had.has(_rn.toLowerCase())) continue;       // already had today
                                        if (typeof window.isSpecialAvailableForBunk === 'function'
                                            && !window.isSpecialAvailableForBunk(_rn, divName, bunk, window.loadGlobalSettings?.())) continue;
                                        if (_specialGateBlocks(bunk, divName, _rn)) continue;    // cooldown/availableDays/multiPart/cohort/ceiling
                                        _resvList.splice(_ri, 1);                                 // consume (already claimed)
                                        _rotSpecialClaimed[_wQ] = (_rotSpecialClaimed[_wQ] || 0) + 1;
                                        (_bunkSpecialsToday[bunk] = _bunkSpecialsToday[bunk] || new Set()).add(_rn.toLowerCase());
                                        console.log(`[SmartTile] ${bunk} -> ROTATION special (reserved): ${_rn}`);
                                        window.fillBlock({ divName, bunk, startTime: _rStart, endTime: _rEnd, slots: _rotSlots }, { field: _rn, sport: null, _fixed: true, _activity: _rn }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                                        _placed = true; break;
                                    }
                                }
                                for (const sp of ((_atQuota || _placed) ? [] : _avail)) {
                                    if (_had && _had.has(sp.name.toLowerCase())) continue; // already had this special today
                                    // ★ Bunk-level access — getAvailableSpecialsForTimeBlock filters the
                                    //   pool at DIVISION level only, so a special restricted to specific
                                    //   bunks within an allowed grade could otherwise be rotated onto a
                                    //   bunk that has no access (e.g. "Sushi" gated to certain bunks).
                                    if (typeof window.isSpecialAvailableForBunk === 'function'
                                        && !window.isSpecialAvailableForBunk(sp.name, divName, bunk, window.loadGlobalSettings?.())) continue;
                                    if (_specialGateBlocks(bunk, divName, sp.name)) continue;   // cooldown/availableDays/multiPart/cohort/ceiling
                                    if (!_canClaim(sp.name, _rStart, _rEnd, sp.capacity || 1, divName)) continue;
                                    _registerClaim(sp.name, _rStart, _rEnd, divName);
                                    _rotSpecialClaimed[_wQ] = (_rotSpecialClaimed[_wQ] || 0) + 1;
                                    (_bunkSpecialsToday[bunk] = _bunkSpecialsToday[bunk] || new Set()).add(sp.name.toLowerCase());
                                    console.log(`[SmartTile] ${bunk} -> ROTATION special: ${sp.name}`);
                                    window.fillBlock({ divName, bunk, startTime: _rStart, endTime: _rEnd, slots: _rotSlots }, { field: sp.name, sport: null, _fixed: true, _activity: sp.name }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                                    _placed = true; break;
                                }
                                // Diagnostic: why the "Special" rotation step couldn't place (so a
                                // fall-through to Pickleball/Swim is explained, not silent). Per
                                // candidate, show WHO holds it (which special/division/time window) —
                                // this reveals when a budget-mode division in an overlapping window
                                // claimed the facility away from this rotation tile.
                                if (!_placed) {
                                    const _diag = _avail.map(s => {
                                        if (_had && _had.has(s.name.toLowerCase())) return `${s.name}=had-today`;
                                        const _ov = (_specialClaims[_claimKey(s.name)] || []).filter(c => c.startMin < _rEnd && c.endMin > _rStart);
                                        if (_ov.length) return `${s.name}⟵[${_ov.map(c => `${c.actLower}@${c.startMin}-${c.endMin}·${c.divName}`).join('|')}]`;
                                        return `${s.name}=blocked(other)`;
                                    }).join(', ');
                                    console.log(`[SmartTile] ${bunk} -> ROTATION "Special" unplaceable @${_rStart}-${_rEnd} (${_avail.length} cand): ${_diag || 'none available'} → next option`);
                                }
                            } else {
                                const _gT = optNorm.includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                                console.log(`[SmartTile] ${bunk} -> ROTATION ${_gT}`);
                                schedulableSlotBlocks.push({ divName, bunk, event: _gT, startTime: _rStart, endTime: _rEnd, slots: _rotSlots, fromSmartTile: true });
                                _placed = true;
                            }
                        } else if (knownSpecialNames.has(optNorm)) {
                            const _had2 = _bunkSpecialsToday[bunk];
                            if (!(_had2 && _had2.has(optNorm)) && !_specialGateBlocks(bunk, divName, opt)) { // skip if already had today OR rotation-gated (cooldown/availableDays/multiPart/cohort/ceiling)
                                const _rsw = _getSharableWith(opt); const _rcap = (_rsw && _rsw.capacity) || 1;
                                if (_canClaim(opt, _rStart, _rEnd, _rcap, divName)) {
                                    _registerClaim(opt, _rStart, _rEnd, divName);
                                    (_bunkSpecialsToday[bunk] = _bunkSpecialsToday[bunk] || new Set()).add(optNorm);
                                    console.log(`[SmartTile] ${bunk} -> ROTATION specific special: ${opt}`);
                                    window.fillBlock({ divName, bunk, startTime: _rStart, endTime: _rEnd, slots: _rotSlots }, { field: opt, sport: null, _fixed: true, _activity: opt }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                                    _placed = true;
                                }
                            }
                        } else if (knownSportNames.has(optNorm) && !optNorm.includes('swim')) {
                            // ★ A user who NAMES a specific sport in a smart tile wants that sport
                            //   placed — even when no field is open for it. So: if one of the
                            //   sport's hosting fields can fit here, hand it to the solver to book
                            //   a REAL field (allowedActivities). If NONE can fit (court locked /
                            //   time-ruled / disabled — e.g. "Pickleball court" blocked 970-1020),
                            //   place the sport as its OWN field-less LABEL (_noRoomCap, like Swim)
                            //   instead of handing the solver an unplaceable block that it would
                            //   silently DROP to a GENERIC sport (the "they got sports" bug). Either
                            //   way the cell reads the named sport — never a random Sport, never a
                            //   fall-through. Un-mapped sports keep the solver-restricted path.
                            const _spFields = _sportFieldMap[optNorm];
                            const _spFits = !(_spFields && _spFields.length) || typeof Utils.canBlockFit !== 'function'
                                || _spFields.some(_ff => Utils.canBlockFit({ divName, division: divName, bunk, startTime: _rStart, endTime: _rEnd, startMin: _rStart, endMin: _rEnd, slots: _rotSlots }, _ff, activityProperties, fieldUsageBySlot, opt));
                            // ★ A scarce CAPPED sport (e.g. Pickleball) is owned by the division-wide
                            //   QUEUE above: only its pre-chosen least-recent winners may take it, and
                            //   they were already placed UP FRONT — so a bunk reaching this branch for a
                            //   capped sport is a non-winner and must skip to its next option (otherwise
                            //   every bunk whose rotation touches Pickleball floods the solver with
                            //   court requests and the same 2 get booked every day). Uncapped sports are
                            //   unaffected (_mayTakeCapped → true).
                            if (_spFits && _mayTakeCapped(opt, optNorm, bunk)) {
                                console.log(`[SmartTile] ${bunk} -> ROTATION specific sport: ${opt} (solver-restricted)`);
                                schedulableSlotBlocks.push({ divName, bunk, event: opt, startTime: _rStart, endTime: _rEnd, slots: _rotSlots, fromSmartTile: true, allowedActivities: [opt] });
                                _placed = true;
                            } else if (_directFillCap(opt) === Infinity && _o === 0 && _canClaimDirectFill(opt, _rStart, _rEnd)) {
                                // UNCAPPED sport with no open field → place as its OWN field-less label,
                                // but ONLY for the bunk whose PRIMARY slot this is (_o===0). (A capped
                                // sport like Pickleball never lands here — it's handled by the queue.)
                                _registerDirectFillClaim(opt, _rStart, _rEnd);
                                console.log(`[SmartTile] ${bunk} -> ROTATION specific sport: ${opt} (no open field → placed as field-less label)`);
                                window.fillBlock({ divName, bunk, startTime: _rStart, endTime: _rEnd, slots: _rotSlots }, { field: opt, sport: null, _fixed: true, _activity: opt, _noRoomCap: true }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                                _placed = true;
                            } else {
                                const _why = (_directFillCap(opt) !== Infinity && !_mayTakeCapped(opt, optNorm, bunk)) ? 'not a least-recent queue winner this window'
                                    : (_o !== 0) ? 'fell through here (not its turn)'
                                    : 'no open field';
                                console.log(`[SmartTile] ${bunk} -> ROTATION specific sport "${opt}" ${_why} → next option`);
                            }
                        } else {
                            // ★ Direct-fill label (Swim, Pickleball, …): placed as its OWN label
                            //   — no solver, no real field needed (the cell just reads the label,
                            //   even when nothing hosts it). _noRoomCap marks it field-less so the
                            //   STEP 7.55 room-capacity sweep leaves it alone (otherwise N bunks on
                            //   one label collapse onto a phantom cap-1 room → demoted → refilled
                            //   with generic sports). A few labels carry a hardcoded real-world cap
                            //   (e.g. 2 pickleball nets, _directFillCap): when that window is full,
                            //   leave _placed false so the bunk falls through to its NEXT rotation
                            //   option (Swim) — exactly like a scarce special does.
                            //   ★ A CAPPED label (Pickleball — common when the camp has NO court for it,
                            //   so it never reaches the named-sport branch above) goes to the pre-chosen
                            //   LEAST-RECENT winners only (_mayTakeCapped). A bunk that merely fell through
                            //   here, or a non-winner, skips to its next option (Swim) — without this guard
                            //   the same starved bunks grabbed the 2 nets every day (the rotation bug).
                            //   Uncapped labels (Swim, ∞ cap) are exempt and place for anyone, unchanged.
                            if (!_mayTakeCapped(opt, optNorm, bunk)) {
                                console.log(`[SmartTile] ${bunk} -> ROTATION "${opt}" (cap ${_directFillCap(opt)}/window) not a least-recent winner this window → next option`);
                            } else if (_canClaimDirectFill(opt, _rStart, _rEnd)) {
                                _registerDirectFillClaim(opt, _rStart, _rEnd);
                                console.log(`[SmartTile] ${bunk} -> ROTATION direct fill: ${opt}`);
                                window.fillBlock({ divName, bunk, startTime: _rStart, endTime: _rEnd, slots: _rotSlots }, { field: opt, sport: null, _fixed: true, _activity: opt, _noRoomCap: true }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                                _placed = true;
                            } else {
                                console.log(`[SmartTile] ${bunk} -> ROTATION "${opt}" at capacity (${_directFillCap(opt)}/window) → next option`);
                            }
                        }
                    }
                    if (_placed && _usedOpts && _placedOpt) _usedOpts.add(_placedOpt);
                    if (!_placed) {
                        console.log(`[SmartTile] ${bunk} -> ROTATION exhausted → Sports Slot`);
                        schedulableSlotBlocks.push({ divName, bunk, event: 'Sports Slot', startTime: _rStart, endTime: _rEnd, slots: _rotSlots, fromSmartTile: true, _smartTileFallback: true });
                    }
                });
                return; // rotation handled this job — skip the A/B split machinery
            }

            const result = window.SmartLogicAdapter.generateAssignments(
                bunkList,
                job,
                historicalCounts,
                specialActivityNames,
                activityProperties,
                null,
                dailyFieldAvailability,
                yesterdayHistory,
                sharedCapacityTracker,
                preAllocation[job.division] || {}
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
                // ★ Fuzzy: any category variant (sport/sports, special/specials/
                //   special activity/…, activity/activities/general activity) is a
                //   generic slot the solver fills; a specific name (null) is not.
                const cat = normalizeCategoryLabel(activityLabel);
                if (!cat) return false;
                // Preserve the legacy guard: a camp that literally configured a
                // "Sports" activity means THAT activity, not the sport category.
                if (cat === 'sport' && (activityProperties?.["Sports"] || activityProperties?.["sports"])) return false;
                return true;
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

               // ★ V44.3: Budget intercept — only for generic slot types (Sports/Special/Activity)
                // Direct-fill activities like Swim bypass the budget system entirely
                const _bk = `${divName}|${bunk}|${startMin}|${endMin}`;
                const _budgetVal = smartTileBudget[_bk];
                const _fbAct = job.fallbackActivity || '';
                const _isDirectFill = activityLabel && !needsGeneration(activityLabel) && !knownSpecialNames.has(activityLabel.toLowerCase().trim());

                // ★ SPECIFIC-ACTIVITY TILES: when the tile CONFIG names a concrete
                //   activity (main1/main2/fallback = "Pickleball" or "Lake" rather
                //   than a category), honor that exact choice — the scarce-special
                //   budget machinery must not swap it out. Adapter-RESOLVED specials
                //   (a name chosen FROM a generic "Special Activity" side) are not
                //   in the configured set, so V44.3 budget fairness still governs
                //   those. Swim-style direct-fill labels keep their classic path.
                const _lblNorm = (activityLabel || '').toLowerCase().trim();
                const _cfgSpecificSet = [job.main1, job.main2, job.fallbackActivity]
                    .filter(v => v && !needsGeneration(v))
                    .map(v => String(v).toLowerCase().trim());
                const _isUserSpecific = _cfgSpecificSet.includes(_lblNorm);
                if (_isUserSpecific && knownSpecialNames.has(_lblNorm)) {
                    // Specific SPECIAL: claim-checked direct fill — capacity and
                    // cross-division sharing enforced via the same claim tracker
                    // the budget system uses; falls back when at capacity.
                    // ★ No-doubles guard: this path bypasses the budget pre-pass, so it
                    //   also has to honor the day-wide tracker — otherwise a bunk that
                    //   already holds this exact special (from another tile/window or an
                    //   earlier pass) would be handed it a second time. If already had
                    //   today, route to the fallback instead of doubling.
                    // ★ Rotation gate: likewise honor _specialGateBlocks here — every
                    //   OTHER placement path consults it, but this explicit-name route
                    //   skipped it, so a tile that NAMES a special (main1="Sushi") placed
                    //   it every day ignoring frequencyDays cooldown / availableDays /
                    //   multiPart spacing (the "too close to each other" divergence). The
                    //   budget must not SWAP a user's explicit choice for fairness, but a
                    //   hard rotation constraint (on cooldown, not available today, part 1
                    //   not done) is not fairness — route to the fallback when it trips.
                    const _alreadyHad = _bunkSpecialsToday[bunk] && _bunkSpecialsToday[bunk].has(_lblNorm);
                    const _gated = _specialGateBlocks(bunk, divName, activityLabel);
                    const _blocked = _alreadyHad || _gated;
                    const _blockWhy = _alreadyHad ? 'already had today' : 'rotation-gated (cooldown/availableDays/multiPart)';
                    const _sw = _getSharableWith(activityLabel);
                    const _swCap = (_sw && _sw.capacity) || 1;
                    if (!_blocked && _canClaim(activityLabel, startMin, endMin, _swCap, divName)) {
                        _registerClaim(activityLabel, startMin, endMin, divName);
                        (_bunkSpecialsToday[bunk] = _bunkSpecialsToday[bunk] || new Set()).add(_lblNorm);
                        console.log(`[SmartTile] ${bunk} -> SPECIFIC special: ${activityLabel}`);
                        window.fillBlock({ divName, bunk, startTime: startMin, endTime: endMin, slots }, { field: activityLabel, sport: null, _fixed: true, _activity: activityLabel }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                    } else if (_blocked && _fbAct && needsGeneration(_fbAct)) {
                        const _fbT = _fbAct.toLowerCase().includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                        console.log(`[SmartTile] ${bunk} -> SPECIFIC special "${activityLabel}" ${_blockWhy} → ${_fbT}`);
                        schedulableSlotBlocks.push({ divName, bunk, event: _fbT, startTime: startMin, endTime: endMin, slots, fromSmartTile: true, _smartTileFallback: true });
                    } else if (_blocked && _fbAct) {
                        console.log(`[SmartTile] ${bunk} -> SPECIFIC special "${activityLabel}" ${_blockWhy} → DIRECT FILL: ${_fbAct}`);
                        window.fillBlock({ divName, bunk, startTime: startMin, endTime: endMin, slots }, { field: _fbAct, sport: null, _fixed: true, _activity: _fbAct }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                    } else if (_fbAct && needsGeneration(_fbAct)) {
                        const _fbT = _fbAct.toLowerCase().includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                        console.log(`[SmartTile] ${bunk} -> SPECIFIC special "${activityLabel}" at capacity → ${_fbT}`);
                        schedulableSlotBlocks.push({ divName, bunk, event: _fbT, startTime: startMin, endTime: endMin, slots, fromSmartTile: true, _smartTileFallback: true });
                    } else if (_fbAct) {
                        console.log(`[SmartTile] ${bunk} -> SPECIFIC special "${activityLabel}" at capacity → DIRECT FILL: ${_fbAct}`);
                        window.fillBlock({ divName, bunk, startTime: startMin, endTime: endMin, slots }, { field: _fbAct, sport: null, _fixed: true, _activity: _fbAct }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                    }
                    return;
                }
                if (_isUserSpecific && knownSportNames.has(_lblNorm) && !_lblNorm.includes('swim')) {
                    // Specific SPORT: hand the solver a block restricted to this one
                    // activity so it resolves a real hosting field (capacity, sharing,
                    // rotation all enforced). If no hosting field is feasible, the
                    // solver drops the restriction and picks generally.
                    console.log(`[SmartTile] ${bunk} -> SPECIFIC sport: ${activityLabel} (solver-placed, restricted)`);
                    schedulableSlotBlocks.push({ divName, bunk, event: activityLabel, startTime: startMin, endTime: endMin, slots, fromSmartTile: true, allowedActivities: [activityLabel] });
                    return;
                }

                if (_budgetVal === false && !_isDirectFill) {
                    if (_fbAct && needsGeneration(_fbAct)) {
                        const fbSlotType = _fbAct.toLowerCase().includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                        console.log(`[SmartTile V44.3] ${bunk} -> NO BUDGET → ${fbSlotType}`);
                        schedulableSlotBlocks.push({ divName, bunk, event: fbSlotType, startTime: startMin, endTime: endMin, slots, fromSmartTile: true, _smartTileFallback: true });
                    } else if (_fbAct) {
                        // ★ CONNECTED-GROUP AWARENESS: don't direct-fill the SAME open
                        //   activity (e.g. swim) twice for a bunk across connected tiles
                        //   — give a fresh sport instead so connected periods vary.
                        const _grp = job.pairGroup, _fbKey = String(_fbAct).toLowerCase().trim();
                        if (_grp && _groupOpenUsed[_grp] && _groupOpenUsed[_grp][bunk] && _groupOpenUsed[_grp][bunk].has(_fbKey)) {
                            console.log(`[SmartTile] ${bunk} -> "${_fbAct}" would REPEAT in connected group ${_grp} → Sports Slot instead`);
                            schedulableSlotBlocks.push({ divName, bunk, event: 'Sports Slot', startTime: startMin, endTime: endMin, slots, fromSmartTile: true, _smartTileFallback: true });
                        } else {
                            if (_grp) {
                                _groupOpenUsed[_grp] = _groupOpenUsed[_grp] || {};
                                _groupOpenUsed[_grp][bunk] = _groupOpenUsed[_grp][bunk] || new Set();
                                _groupOpenUsed[_grp][bunk].add(_fbKey);
                            }
                            console.log(`[SmartTile V44.3] ${bunk} -> NO BUDGET → DIRECT FILL: ${_fbAct}`);
                            window.fillBlock({ divName, bunk, startTime: startMin, endTime: endMin, slots }, { field: _fbAct, sport: null, _fixed: true, _activity: _fbAct }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                        }
                    }
                    return;
                }
             if (typeof _budgetVal === 'string' && !_isDirectFill) {
                    console.log(`[SmartTile V44.3] ${bunk} -> PRE-ASSIGNED: ${_budgetVal} (adapter said: ${activityLabel})`);
                    _registerClaim(_budgetVal, startMin, endMin, divName);
                    window.fillBlock({ divName, bunk, startTime: startMin, endTime: endMin, slots }, { field: _budgetVal, sport: null, _fixed: true, _activity: _budgetVal }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                    return;
                
                
                
                }

               // ★★★ FULL GRADE: Fill ALL bunks in division ★★★
               const _isFG = window.isFullGradeForDivision ? window.isFullGradeForDivision(activityLabel, divName) : (activityProperties[activityLabel]?.fullGrade || activityProperties[activityLabel]?._fullGrade);

                if (_isFG && !needsGeneration(activityLabel)) {
                    console.log(`[SmartTile] ★ FULL GRADE: "${activityLabel}" → filling ALL bunks in ${divName}`);
                    bunkList.forEach(fgBunk => {
                        const fgEx = window.scheduleAssignments[fgBunk]?.[slots[0]];
                        if (fgEx && fgEx._bunkOverride) return;
                        window.fillBlock({
                            divName, bunk: fgBunk, startTime: startMin, endTime: endMin, slots
                        }, {
                            field: activityLabel, sport: null, _fixed: true,
                            _activity: activityLabel, _fullGrade: true
                        }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                    });
                    return; // Already filled all bunks
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

                    // ★ V44.3: Check camp-wide budget for special slots
                    const _fbAct = job.fallbackActivity || '';
                    const _isFallbackable = slotType === 'Special Activity' && _fbAct;

                   if (_isFallbackable) {
                        const budgetVal = smartTileBudget[`${divName}|${bunk}|${startMin}|${endMin}`];

                        if (budgetVal === false) {
                            // No budget — route to fallback
                            if (needsGeneration(_fbAct)) {
                                const fbLower = _fbAct.toLowerCase();
                                const fbSlotType = fbLower.includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                                console.log(`[SmartTile V44.3] ${bunk} -> NO BUDGET → ${fbSlotType} (fallback: ${_fbAct})`);
                                schedulableSlotBlocks.push({
                                    divName, bunk,
                                    event: fbSlotType,
                                    startTime: startMin, endTime: endMin, slots,
                                    fromSmartTile: true,
                                    _smartTileFallback: true
                                });
                            } else {
                                console.log(`[SmartTile V44.3] ${bunk} -> NO BUDGET → DIRECT FILL: ${_fbAct}`);
                                window.fillBlock({
                                    divName, bunk, startTime: startMin, endTime: endMin, slots
                                }, {
                                    field: _fbAct, sport: null, _fixed: true, _activity: _fbAct
                                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                            }
                            return;
                        }

                        if (typeof budgetVal === 'string') {
                            // Pre-assigned specific special — fill directly, solver never touches it
                            console.log(`[SmartTile V44.3] ${bunk} -> PRE-ASSIGNED: ${budgetVal}`);
                            window.fillBlock({
                                divName, bunk, startTime: startMin, endTime: endMin, slots
                            }, {
                                field: budgetVal, sport: null, _fixed: true, _activity: budgetVal
                            }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                            return;
                        }
                    }
                    console.log(`[SmartTile] ${bunk} -> GENERATE: ${slotType}`);
                    schedulableSlotBlocks.push({
                        divName, bunk,
                        event: slotType,
                        startTime: startMin, endTime: endMin, slots,
                        fromSmartTile: true,
                        _fallbackActivity: _fbAct,
                        _isFallbackable: _isFallbackable
                    });

              } else {
                    if (knownSpecialNames.has(activityLabel.toLowerCase().trim())) {
                        const _maxCap = (() => {
                            const props = activityProperties[activityLabel] || activityProperties[Object.keys(activityProperties).find(k => k.toLowerCase() === activityLabel.toLowerCase())] || {};
                            const s = props.sharableWith;
                            if (!s || s.type === 'not_sharable') return 1;
                            if (s.type === 'custom') return parseInt(s.capacity) || 1;
                            return 999;
                        })();
                       if (!_canClaim(activityLabel, startMin, endMin, _maxCap, divName)) {
                            const _fb2 = job.fallbackActivity || '';
                            console.log(`[SmartTile V44.3] ${bunk} -> SPECIAL CLAIMED → fallback: ${_fb2 || 'Sports Slot'}`);
                            if (_fb2 && needsGeneration(_fb2)) {
                                const _fbType = _fb2.toLowerCase().includes('sport') ? 'Sports Slot' : 'General Activity Slot';
                                schedulableSlotBlocks.push({ divName, bunk, event: _fbType, startTime: startMin, endTime: endMin, slots, fromSmartTile: true, _smartTileFallback: true });
                            } else if (_fb2) {
                                window.fillBlock({ divName, bunk, startTime: startMin, endTime: endMin, slots }, { field: _fb2, sport: null, _fixed: true, _activity: _fb2 }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                            } else {
                                schedulableSlotBlocks.push({ divName, bunk, event: 'Sports Slot', startTime: startMin, endTime: endMin, slots, fromSmartTile: true });
                            }
                            return;
                        }
                      _registerClaim(activityLabel, startMin, endMin, divName);
                    }
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

        window.__smartCapTracker = sharedCapacityTracker; // debug
        return schedulableSlotBlocks;
    }

    // =========================================================================
    // ★★★ MAIN ENTRY POINT ★★★
    // =========================================================================

    window.runSkeletonOptimizer = async function(manualSkeleton, externalOverrides, allowedDivisions = null, existingScheduleSnapshot = null, existingUnifiedTimes = null) {
        console.log("\n" + "=".repeat(70));
       console.log("★★★ OPTIMIZER STARTED (v17.12 - SMART TILE CAMP-WIDE BUDGET) ★★★")

        // ★★★ STARTER PLAN: Check schedule day limit BEFORE generating ★★★
        try {
            var _client = window.CampistryDB?.getClient?.() || window.supabase;
            var _campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('campistry_camp_id');
            var _dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            if (_client && _campId) {
                var _limitRes = await _client.rpc('check_schedule_limit', { p_camp_id: _campId, p_date_key: _dateKey });
                if (!_limitRes.error && _limitRes.data && _limitRes.data.allowed === false) {
                    console.warn('[OPTIMIZER] Blocked by starter plan limit:', _limitRes.data);
                    alert('Schedule day limit reached (' + _limitRes.data.used + '/' + _limitRes.data.max + ' days used). Upgrade for unlimited scheduling.');
                    window.dispatchEvent(new CustomEvent('campistry-plan-limit', {
                        detail: { type: 'schedule', used: _limitRes.data.used, max: _limitRes.data.max }
                    }));
                    return false;
                }
            }
        } catch (_e) {
            console.warn('[OPTIMIZER] Schedule limit check failed, proceeding:', _e);
        }

        // ★★★ SCHEDULER RESTRICTION ★★★
        if (window.AccessControl?.filterDivisionsForGeneration) {
            allowedDivisions = await window.AccessControl.filterDivisionsForGeneration(allowedDivisions);
            if (allowedDivisions.length === 0) {
                alert("No divisions assigned. Contact camp owner.");
                return false;
            }
            console.log(`[RBAC] ★ DIVISION FILTER APPLIED: Generating for [${allowedDivisions.join(', ')}] only`);
        }
// ★★★ v17.12: Set flag to prevent remote merges during generation ★★★
        window._generationInProgress = true;

       // ★★★ STEP 0: FULL DAILY SCHEDULE WIPE (RBAC-AWARE) ★★★
        // Before ANY generation, wipe today's schedule for the divisions being generated.
        // ★★★ v3.13: Partial wipe when generating a SUBSET of divisions (any role) ★★★
        // This prevents stale data (old leagues, ghost assignments) from bleeding in.
        {// ★ AUTO BUILD: Skip wipe — AutoBuildPrep already did a full wipe
            if (window._skipGenerationWipe) {
                console.log('[STEP 0] ⏭️ Skipping wipe — AutoBuildPrep already wiped');
            } else {
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            const role = window.AccessControl?.getCurrentRole?.() ||
                        window.CampistryDB?.getRole?.() || 'owner';
            const allDivisionKeys = Object.keys(window.divisions || {});
            const isPartialGeneration = allowedDivisions &&
                allowedDivisions.length > 0 &&
                allowedDivisions.length < allDivisionKeys.length;

            console.log(`[STEP 0] ★ DAILY SCHEDULE WIPE for ${dateKey} (role: ${role}, partial: ${isPartialGeneration})`);

            if (isPartialGeneration) {
                // ═══ PARTIAL: Only wipe selected divisions' bunks ═══
                const myDivisions = allowedDivisions ||
                                    window.AccessControl?.getGeneratableDivisions?.() || [];
                const divisions = window.divisions || {};
                const myBunks = new Set();
                
                myDivisions.forEach(divName => {
                    (divisions[divName]?.bunks || []).forEach(b => myBunks.add(b));
                });
                
                console.log(`[STEP 0] Partial mode (${role}): wiping ${myBunks.size} bunks from [${myDivisions.join(', ')}]`);
                
                // 0a. Clear only MY bunks from window globals
                myBunks.forEach(bunk => {
                    delete window.scheduleAssignments?.[bunk];
                    delete window.leagueAssignments?.[bunk];
                });
                
                // 0b. Clear only MY bunks from localStorage
                try {
                    const DAILY_KEY = 'campDailyData_v1';
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    if (allData[dateKey]) {
                        myBunks.forEach(bunk => {
                            delete allData[dateKey]?.scheduleAssignments?.[bunk];
                            delete allData[dateKey]?.leagueAssignments?.[bunk];
                        });
                        localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                    }
                } catch (e) {
                    console.warn('[STEP 0] localStorage clear failed:', e);
                }
                
                // 0c. Cloud: delete only MY record (ScheduleDB uses scheduler_id)
                try {
                    if (window.ScheduleDB?.deleteMyRecord) {
                        window.ScheduleDB.deleteMyRecord(dateKey)
                            .then(() => console.log('[STEP 0] ☁️ My cloud record deleted'))
                            .catch(e => console.warn('[STEP 0] Cloud delete error:', e.message));
                    } else {
                        const client = window.CampistryDB?.getClient?.() || window.supabase;
                        const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                        const userId = window.CampistryDB?.getUserId?.() || 
                                      (client?.auth?.getUser ? (await client.auth.getUser())?.data?.user?.id : null);
                        if (client && campId && userId) {
                            client
                                .from('daily_schedules')
                                .delete()
                                .eq('camp_id', campId)
                                .eq('date_key', dateKey)
                                .eq('scheduler_id', userId)
                                .then(({ error }) => {
                                    if (error) console.warn('[STEP 0] Cloud delete error:', error.message);
                                    else console.log('[STEP 0] ☁️ My cloud record deleted for', dateKey);
                                });
                        }
                    }
                } catch (e) {
                    console.warn('[STEP 0] Cloud delete failed:', e);
                }
                
            } else {
                // ═══ FULL GENERATION: Wipe everything ═══
                console.log('[STEP 0] Full generation mode: wiping all divisions');
                
                // 0a. Clear all window globals
                window.scheduleAssignments = {};
                window.leagueAssignments = {};
                
                // 0b. Clear all from localStorage
                try {
                    const DAILY_KEY = 'campDailyData_v1';
                    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
                    if (allData[dateKey]) {
                        allData[dateKey].scheduleAssignments = {};
                        allData[dateKey].leagueAssignments = {};
                        localStorage.setItem(DAILY_KEY, JSON.stringify(allData));
                    }
                } catch (e) {
                    console.warn('[STEP 0] localStorage clear failed:', e);
                }
                
                // 0c. Delete ALL records from cloud for this date
                try {
                    const client = window.CampistryDB?.getClient?.() || window.supabase;
                    const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                    if (client && campId) {
                        client
                            .from('daily_schedules')
                            .delete()
                            .eq('camp_id', campId)
                            .eq('date_key', dateKey)
                            .then(({ error }) => {
                                if (error) console.warn('[STEP 0] Cloud delete error:', error.message);
                                else console.log('[STEP 0] ☁️ All cloud records deleted for', dateKey);
                            });
                    }
                } catch (e) {
                    console.warn('[STEP 0] Cloud delete failed:', e);
                }
            }

            // 0d. Clear GlobalFieldLocks (always — they get rebuilt during generation)
            if (window.GlobalFieldLocks?.clearAllLocks) {
                window.GlobalFieldLocks.clearAllLocks();
                console.log('[STEP 0] Cleared GlobalFieldLocks');
            }

            // 0e. Block stale cloud rehydration during generation
            window._preGenClearActive = true;

            console.log('[STEP 0] ★ WIPE COMPLETE — generating from clean slate');
                }
        }

        // ★★★ 0f. HYDRATE ROTATION HISTORY FROM CLOUD ★★★
        // The rotation engine reads past schedules from campDailyData_v1 in localStorage.
        // If the user opened a fresh browser or cleared cache, past dates are missing.
        // Load the last 14 days from the cloud so rotation scoring has history.
        try {
            // Pre-trim localStorage to prevent quota issues
            try {
                const rawDaily = localStorage.getItem('campDailyData_v1');
                if (rawDaily && rawDaily.length > 500000) {
                    const trimData = JSON.parse(rawDaily);
                    const trimKeys = Object.keys(trimData).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
                    if (trimKeys.length > 14) {
                        while (trimKeys.length > 14) delete trimData[trimKeys.shift()];
                        localStorage.setItem('campDailyData_v1', JSON.stringify(trimData));
                        window.invalidateDailyDataCache?.();
                        console.log(`[STEP 0f] Pre-trimmed localStorage to ${Object.keys(trimData).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).length} dates`);
                    }
                }
            } catch (trimErr) { /* ignore trim failures */ }

            if (window.ScheduleDB?.loadDateRange && navigator.onLine) {
                const today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                const d = new Date(today + 'T12:00:00');
                d.setDate(d.getDate() - 14);
                const startDate = d.toISOString().split('T')[0];
                console.log(`[STEP 0f] Hydrating rotation history: ${startDate} → ${today}`);
                const records = await window.ScheduleDB.loadDateRange(startDate, today);
                if (records && records.length > 0) {
                    const allDaily = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    const LOCAL_ONLY = ['bunkActivityOverrides','overrides','autoSkeleton','_autoGenerated','_autoBuildTimelines','_autoGenMeta','manualSkeleton','skeleton','dailyDisabledSportsByField','dailyFieldAvailability','disabledSpecialtyLeagues','dailyActivityBunkRestrictions','leagueRoundState','leagueDayCounters'];
                    let hydrated = 0;
                    const byDate = {};
                    for (const rec of records) {
                        const dk = rec.date_key;
                        if (!dk || dk === today) continue;
                        if (!byDate[dk]) byDate[dk] = [];
                        byDate[dk].push(rec);
                    }
                    for (const [dk, recs] of Object.entries(byDate)) {
                        const existing = allDaily[dk] || {};
                        if (existing.scheduleAssignments && Object.keys(existing.scheduleAssignments).length > 0) continue;
                        const merged = {};
                        for (const rec of recs) {
                            const sd = rec.schedule_data || {};
                            if (sd.scheduleAssignments) Object.assign(merged, sd.scheduleAssignments);
                        }
                        if (Object.keys(merged).length > 0) {
                            const entry = { ...existing, scheduleAssignments: merged };
                            LOCAL_ONLY.forEach(f => { if (existing[f] !== undefined) entry[f] = existing[f]; });
                            allDaily[dk] = entry;
                            hydrated++;
                        }
                    }
                    if (hydrated > 0) {
                        // Trim to last 14 days to reduce localStorage size
                        const allDateKeys = Object.keys(allDaily).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
                        while (allDateKeys.length > 14) {
                            delete allDaily[allDateKeys.shift()];
                        }
                        // ★ Slim past-date entries: rotation history only reads
                        // _activity / sport / field per slot, so we strip
                        // everything else (zones, time ranges, league pairings,
                        // hybrid metadata, divisionTimes, etc) before persisting.
                        // This shrinks 14 days of allDaily by ~80–90%.
                        const _slimPastDate = (d) => {
                            if (!d || typeof d !== 'object') return d;
                            const slimSched = {};
                            const sa = d.scheduleAssignments || {};
                            for (const bunk of Object.keys(sa)) {
                                const slots = sa[bunk];
                                if (!Array.isArray(slots)) continue;
                                slimSched[bunk] = slots.map(e => {
                                    if (!e) return null;
                                    const out = {};
                                    if (e._activity) out._activity = e._activity;
                                    else if (e.sport) out.sport = e.sport;
                                    else if (e.field) out.field = e.field;
                                    if (e.continuation) out.continuation = true;
                                    if (e._isTransition) out._isTransition = true;
                                    return out;
                                });
                            }
                            const out = { scheduleAssignments: slimSched };
                            // CB-5: preserve local-only per-day config on slimmed
                            // entries (matches the hydrate carry-forward above).
                            LOCAL_ONLY.forEach(f => { if (d[f] !== undefined) out[f] = d[f]; });
                            return out;
                        };
                        for (const dk of Object.keys(allDaily)) {
                            if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
                            // ★★★ CB-5: only slim PAST, in-window dates. The old
                            // `dk === today` guard slimmed every OTHER date —
                            // including FUTURE dates the user built ahead —
                            // stripping their leagues/divisionTimes/skeleton/
                            // _perBunkSlotsData and propagating the slim to cloud.
                            if (!(dk < today && dk >= startDate)) continue;
                            allDaily[dk] = _slimPastDate(allDaily[dk]);
                        }
                        // ★ Seed secondary-save hashes so the next saveGlobalSettings
                        // call doesn't fan out cloud saves for these unchanged dates.
                        try { window._seedSecondarySaveHashes?.(allDaily); } catch (_) {}
                        try {
                            localStorage.setItem('campDailyData_v1', JSON.stringify(allDaily));
                            window.invalidateDailyDataCache?.();
                            console.log(`[STEP 0f] ✅ Hydrated ${hydrated} past date(s) from cloud (${records.length} records, slimmed)`);
                        } catch (quotaErr) {
                            console.warn('[STEP 0f] localStorage quota exceeded, using in-memory fallback');
                            if (window.setDailyDataMemoryOverride) {
                                window.setDailyDataMemoryOverride(allDaily);
                                console.log(`[STEP 0f] ✅ Hydrated ${hydrated} past date(s) into memory fallback`);
                            }
                        }
                    } else {
                        console.log(`[STEP 0f] All past dates already in localStorage`);
                    }
                } else {
                    console.log(`[STEP 0f] No cloud records for past dates`);
                }
            }
        } catch (e) {
            console.warn('[STEP 0f] History hydration failed:', e);
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
// ★★★ v17.12: generation flag stays true — cleared at end of runSkeletonOptimizer ★★★
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
                    rules.forEach(r => console.log(`   -> ${fieldName}: ${r.type} ${r.start}-${r.end} (${r.startMin ?? '?'}-${r.endMin ?? '?'} min)`));
                }
            });
        } else {
            console.log("[OPTIMIZER] No Daily Field Availability Rules to merge.");
        }

        // ★★★ ROTATION HISTORY: Rebuild local + load cloud (mirrors auto mode) ★★★
        if (window.RotationEngine && window.RotationEngine.rebuildAllHistory) {
            window.RotationEngine.rebuildAllHistory();
            console.log('[MANUAL] ★ RotationEngine.rebuildAllHistory() complete');
        }

        if (window.RotationCloud?.load) {
            try {
                const rotData = await window.RotationCloud.load(true); // force refresh
                if (rotData?.counts && Object.keys(rotData.counts).length > 0) {
                    // 1. Merge cloud counts into config.historicalCounts.
                    //    Subtract today's row so a regenerate isn't biased against
                    //    the activities the previous draft happened to use.
                    //    (Today's contribution is re-added after generation
                    //    completes via the post-gen rebuild.)
                    if (!config.historicalCounts) config.historicalCounts = {};
                    const _today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                    const _todayCloud = (rotData.countsByDate && rotData.countsByDate[_today]) || {};
                    for (const [bunk, activities] of Object.entries(rotData.counts)) {
                        if (!config.historicalCounts[bunk]) config.historicalCounts[bunk] = {};
                        const _todayBunk = _todayCloud[bunk] || {};
                        for (const [act, count] of Object.entries(activities)) {
                            const _historical = count - (_todayBunk[act] || 0);
                            if (_historical > 0) config.historicalCounts[bunk][act] = _historical;
                            else delete config.historicalCounts[bunk][act];
                        }
                    }

                    // 2. Also persist to globalSettings so it survives across sessions
                    const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
                    if (gs) {
                        gs.historicalCounts = config.historicalCounts;
                        if (typeof window.saveGlobalSettings === 'function') {
                            window.saveGlobalSettings('historicalCounts', gs.historicalCounts);
                        }
                    }

                    // 3. Merge cloud lastDone + counts into RotationEngine's
                    //    history cache so recency scoring works even when
                    //    localStorage allDailyData is incomplete
                    if (window.RotationEngine?.mergeCloudData) {
                        window.RotationEngine.mergeCloudData(rotData);
                    }

                    console.log('[MANUAL] ☁️ Loaded ' + Object.keys(rotData.counts).length + ' bunk rotation records from cloud');
                }
            } catch (e) {
                console.warn('[MANUAL] RotationCloud load failed: ' + e.message);
            }
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
        // BUNK ORDER: respect user-defined order from campStructure.
        // The previous numeric sort overrode drag-reorder choices made in
        // Campistry Me — divisions[divName].bunks already arrives in the
        // correct user-chosen order from app1.js, so leave it alone.
        // =========================================================================

        window.SchedulerCoreUtils._bunkMetaData = bunkMetaData;
        window.SchedulerCoreUtils._sportMetaData = config.sportMetaData || {};

        window.fieldUsageBySlot = {};
        let fieldUsageBySlot = window.fieldUsageBySlot;

        // ★ LG-6: a SCOPED (partial) generation must not lose OTHER divisions'
        //   league matchups. window.leagueAssignments here holds the cloud-merged,
        //   all-divisions map (built in the partial-mode preamble ~L1819). The wipe
        //   below clears it and only the regenerated (allowed) divisions get
        //   re-filled, so the unscoped divisions' matchups would vanish and then be
        //   saved as gone. Snapshot them now and restore after Step 1.5.
        const _preservedLeagueAssignments = (allowedDivisionsSet && window.leagueAssignments && typeof window.leagueAssignments === 'object')
            ? JSON.parse(JSON.stringify(window.leagueAssignments)) : null;

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
                // ★ Config-level shut-off: the Facilities tab AVAILABLE/UNAVAILABLE
                //   toggle writes available:false onto the special. Mirror the auto
                //   builder (scheduler_core_auto.js todaysSpecials filter) so the
                //   manual builder's total solver never gets a disabled special in
                //   config.masterSpecials. The SmartTile path already gates on this
                //   (smart_logic_adapter.js props.available === false), but the total
                //   solver's candidate generation only checked the per-date disable
                //   set — so a toggled-off special still got placed in manual mode.
                if (s.available === false) return false;

                if (!isRainyMode) {
                    if (s.rainyDayOnly === true || s.rainyDayExclusive === true) return false;
                }

                if (isRainyMode) {
                    if (s.rainyDayAvailable === false || s.availableOnRainyDay === false) return false;
                }

                // ★ v7.0: Filter out daily-disabled specials
                if (disabledSpecials && disabledSpecials.length > 0) {
                    if (disabledSpecials.includes(s.name)) return false;
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
            // ★ MODE ISOLATION (double-lunch fix): _autoDivisionTimesBuilt is an
            //   AUTO-pipeline flag — when the auto solver pre-builds per-bunk
            //   divisionTimes it sets this so the shared runSkeletonOptimizer won't
            //   rebuild over it. But this is also the MANUAL gen path. If that flag is
            //   still set (leaked from a prior AUTO generation earlier in the session),
            //   STEP 1 SKIPPED the rebuild and the manual schedule kept AUTO per-bunk
            //   geometry — slot windows like 700-730 that cross the pinned 12:00 lunch —
            //   while the manual solver placed entries at skeleton times (lunch 720-750).
            //   Index-aligned but time-mismatched → the grid drew lunch in the wrong
            //   columns (looked like a DOUBLE LUNCH). Auto and manual geometry must not
            //   contaminate each other: in MANUAL mode we ALWAYS rebuild div-level
            //   geometry from THIS day's skeleton. buildFromSkeleton is idempotent for a
            //   manual skeleton, so forcing it is safe; only the genuine auto pipeline
            //   (manual mode false) keeps its pre-built per-bunk grid.
            var _miManualMode = (((window.getCampBuilderMode && window.getCampBuilderMode()) || window._daBuilderMode || 'manual') === 'manual');
            if (window._autoDivisionTimesBuilt && !_miManualMode) {
                console.log('[STEP 1] Skipping rebuild — auto pipeline already built divisionTimes');
                window._autoDivisionTimesBuilt = false;
            } else {
                if (window._autoDivisionTimesBuilt) {
                    window._autoDivisionTimesBuilt = false;
                    console.log('[STEP 1] Manual mode — forcing div-level rebuild from skeleton (clears any leaked auto per-bunk geometry)');
                }
                window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(manualSkeleton, divisions);
                console.log(`[STEP 1] Built divisionTimes for ${Object.keys(window.divisionTimes).length} divisions`);
                // ★ MODE ISOLATION (FN-28): window._perBunkSlots is an AUTO-ONLY global —
                //   set only by the auto solver (scheduler_core_auto.js). The manual gen's
                //   sharing + free-fill sweeps (_rtime / _stime76) read it FIRST when
                //   resolving each slot's time window, so a prior AUTO generation this
                //   session leaks its per-bunk geometry (e.g. 700-730 windows crossing the
                //   pinned lunch) into the manual schedule — the SAME class of corruption
                //   the divisionTimes rebuild above guards against, which is why auto→manual
                //   regen "messes up" the schedule while manual→auto (auto rebuilds its own
                //   per-bunk grid) is clean. Clear it in manual mode so those sweeps fall
                //   back to the manual entry / division-level times. Auto pipeline (which
                //   takes the skip-rebuild branch above) keeps its pre-built per-bunk grid.
                if (_miManualMode) { try { window._perBunkSlots = {}; } catch (_ePB) {} }
            }
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
            // ★ Day 22.5: per-bunk gen scope. When window.__allowedBunkSet is set,
            //   only the explicitly-selected bunks are regenerated; others preserve.
            const _allowedBunkSet = window.__allowedBunkSet || null;
            // ★ Partial (per-tile) regen: per-slot scope from Daily Adjustments.
            //   { [bunk]: { regen: Set<slotIdx>, keep: { [slotIdx]: entry } } }
            //   For in-scope bunks carrying this, rebuild the bunk from the snapshot:
            //   `keep` slots are pinned (preserved, never moved), `regen` slots are
            //   left empty for the solver to re-roll. This is immune to STEP 0's wipe.
            const _regenSlotScope = window.__regenSlotScope || null;

            (divisions[divName].bunks || []).forEach(bunk => {
                const bunkInScope = !_allowedBunkSet || _allowedBunkSet.has(String(bunk));
                if (isBeingGenerated && bunkInScope) {
                    const _rs = _regenSlotScope && _regenSlotScope[bunk];
                    if (_rs && _rs.keep) {
                        // ── Per-tile regen: keep non-selected slots (pinned), null the rest ──
                        const arr = new Array(slotCount).fill(null);
                        const keep = _rs.keep;
                        for (const k in keep) {
                            const i = parseInt(k, 10);
                            if (i >= 0 && i < slotCount && keep[k]) {
                                arr[i] = Object.assign({}, keep[k], {
                                    _fixed: true, _pinned: true, _regenPreserved: true
                                });
                            }
                        }
                        window.scheduleAssignments[bunk] = arr;
                        return; // selected slots stay null → solver fills only those
                    }
                    // Always create fresh empty arrays. For mid-day rain,
                    // Step 1.1 re-places morning entries by TIME after
                    // divisionTimes is rebuilt (index-based copy is wrong
                    // because slot indices change with the rainy skeleton).
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
        // ★★★ STEP 1.1: RE-PLACE MORNING ENTRIES (MID-DAY RAIN) ★★★
        // =========================================================================
        // After Step 1 rebuilds divisionTimes from the rainy skeleton, slot indices
        // have changed. Re-map morning entries from the pre-rebuild snapshot into
        // the NEW slot structure using time-based matching.
        if (window._skipGenerationWipe && window._midDayPreRebuild) {
            const _mdr = window._midDayPreRebuild;
            const _oldAssign = _mdr.assignments || {};
            const _oldDivTimes = _mdr.divisionTimes || {};
            const _oldUnifiedTimes = _mdr.times || [];
            const _transMin = _mdr.transitionMinutes || 810;
            let _placed = 0;

            Object.keys(_oldAssign).forEach(bunk => {
                const oldSlots = _oldAssign[bunk];
                if (!Array.isArray(oldSlots)) return;

                const divName = Object.keys(divisions).find(d =>
                    divisions[d].bunks?.includes(bunk)
                );
                const newDivSlots = window.divisionTimes?.[divName] || [];
                if (!newDivSlots.length) return;
                if (!window.scheduleAssignments[bunk]) return;

                // Use per-division old times (correct indices), fall back to unified
                const oldDivSlots = _oldDivTimes[divName] || _oldDivTimes[String(divName)] || _oldUnifiedTimes;

                oldSlots.forEach((entry, oldIdx) => {
                    if (!entry) return;
                    if (entry.continuation) return;
                    const oldSlot = oldDivSlots[oldIdx] || _oldUnifiedTimes[oldIdx];
                    if (!oldSlot) return;

                    const oStart = oldSlot.startMin !== undefined ? oldSlot.startMin
                        : oldSlot.start ? new Date(oldSlot.start).getHours() * 60 + new Date(oldSlot.start).getMinutes() : null;
                    const oEnd = oldSlot.endMin !== undefined ? oldSlot.endMin
                        : oldSlot.end ? new Date(oldSlot.end).getHours() * 60 + new Date(oldSlot.end).getMinutes() : null;
                    if (oEnd === null || oEnd > _transMin) return;

                    let bestIdx = -1, bestDiff = Infinity;
                    for (let i = 0; i < newDivSlots.length; i++) {
                        const ns = newDivSlots[i];
                        const diff = Math.abs((ns.startMin || 0) - oStart) + Math.abs((ns.endMin || 0) - oEnd);
                        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
                    }
                    if (bestIdx >= 0 && bestDiff <= 15) {
                        window.scheduleAssignments[bunk][bestIdx] = {
                            ...entry,
                            _fixed: true,
                            _pinned: true,
                            _preservedMorning: true
                        };
                        _placed++;
                    }
                });
            });
            console.log(`[STEP 1.1] Re-placed ${_placed} morning entries into new rainy slot structure`);
            delete window._midDayPreRebuild;
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

        // ★ STEP 1.6 — Partial (per-tile) regen: register field usage + locks for the
        //   PRESERVED slots in the regenerated (in-scope) bunks. STEP 1.5 only registers
        //   BACKGROUND (non-allowed) divisions, so without this the solver would not
        //   "see" a kept tile's field and could double-book it when filling the empty
        //   selected slots. Reuses registerFieldUsageFromRestoredSchedules with an EMPTY
        //   allowed-list so it registers (does not skip) these in-scope entries.
        if (window.__regenSlotScope && typeof window.registerFieldUsageFromRestoredSchedules === 'function') {
            const _rsSnap = {};
            Object.keys(window.__regenSlotScope).forEach(b => {
                const arr = window.scheduleAssignments?.[b];
                if (Array.isArray(arr)) _rsSnap[b] = arr;
            });
            if (Object.keys(_rsSnap).length > 0) {
                const _rsReg = window.registerFieldUsageFromRestoredSchedules(
                    _rsSnap, divisions, [], fieldUsageBySlot, activityProperties, existingUnifiedTimes
                );
                console.log('[STEP 1.6] ★ Per-tile regen: registered field usage for ' + _rsReg + ' preserved slot(s)');
            }
        }

        // ★ LG-6: restore league matchups for divisions NOT in this scoped gen.
        //   Step 1.5 above restored their SCHEDULE (scheduleAssignments); their
        //   leagueAssignments were wiped at the top of this run and the partial gen
        //   only re-fills the allowed divisions. Without this, a scope-regen of one
        //   division drops every OTHER division's league games, and the wholesale
        //   save pushes that loss to localStorage + cloud. The partial gen only
        //   writes allowed divisions, so the non-allowed entries restored here
        //   survive to the save.
        if (_preservedLeagueAssignments && allowedDivisionsSet) {
            if (!window.leagueAssignments || typeof window.leagueAssignments !== 'object') window.leagueAssignments = {};
            let _restoredLG6 = 0;
            for (const [divName, divData] of Object.entries(_preservedLeagueAssignments)) {
                if (!allowedDivisionsSet.has(String(divName))) {
                    window.leagueAssignments[divName] = divData;
                    _restoredLG6++;
                }
            }
            if (_restoredLG6 > 0) console.log(`[OPTIMIZER] ★ LG-6: restored league matchups for ${_restoredLG6} non-regenerated division(s)`);
        }

        // =========================================================================
        // STEP 2: Process Bunk Overrides (Pinned specific bunks)
        // =========================================================================

        console.log("\n[STEP 2] Processing bunk overrides...");
        // ★ BUNK-OVERRIDE WIPE FIX: prefer the overrides passed in externalOverrides (daily_adjustments
        //   sets currentOverrides.bunkActivityOverrides in its restore-after-wipe, then passes it here).
        //   loadCurrentDailyData() gets clobbered mid-run by the partial-mode force-load-from-cloud
        //   (~L1760: re-hydrates currentDailyData from the just-wiped cloud → 0 overrides), so reading
        //   it dropped the user's overrides entirely ("Restored 12 bunk override(s)" → "Processed 0").
        //   The passed param is a live object reference that survives that reload.
        const bunkOverrides = (externalOverrides && Array.isArray(externalOverrides.bunkActivityOverrides) && externalOverrides.bunkActivityOverrides.length)
            ? externalOverrides.bunkActivityOverrides
            : (window.loadCurrentDailyData?.().bunkActivityOverrides || []);

        // ★ POOL OVERRIDE support ("the bunk can have baseball OR basketball — let
        //   the solver decide"). A sportPool override carries a candidate set; we
        //   pick ONE candidate per bunk using a mix of FAIRNESS (rotation count —
        //   the activity this bunk has done least wins) and AVAILABILITY (a field /
        //   location that's actually open with capacity at this time). Defined here
        //   (closes over fieldUsageBySlot / fieldsBySport / capacity + location
        //   helpers) so the chosen candidate then flows through the normal per-type
        //   placement branches below.
        // Does this field's accessRestrictions DENY this division/bunk? Allow-list
        // semantics with dual string/number keys — mirrors the post-gen warn scan
        // and the solver's hard access check. Used to PREFER fields the bunk can
        // actually access when an override auto-picks among a sport's fields.
        const _fieldAccessViolates = (fieldName, dn, bk) => {
            if (!fieldName || !dn) return false;
            const _props = (typeof activityProperties !== 'undefined' && activityProperties) || window.activityProperties || {};
            const ar = (_props[fieldName] || {}).accessRestrictions;
            if (!ar || ar.enabled !== true) return false;
            const divs = ar.divisions || {};
            if (!(String(dn) in divs) && !(dn in divs)) return true;
            const rule = (String(dn) in divs) ? divs[String(dn)] : divs[dn];
            if (Array.isArray(rule) && rule.length > 0) {
                const bs = String(bk), bn = parseInt(bk);
                if (!rule.some(b => String(b) === bs || parseInt(b) === bn)) return true;
            }
            return false;
        };
        const _poolCandidateAvailable = (it, divName, slots, bunk) => {
            const nm = it.name;
            const ty = it.type || 'sport';
            const slotOpen = (key) => {
                const cap = getFieldCapacityLocal(key, activityProperties);
                return slots.every(si => {
                    const u = fieldUsageBySlot[si]?.[key];
                    return !(u && u.count >= cap);
                });
            };
            if (ty === 'sport') {
                const fs = (fieldsBySport || {})[nm] || [];
                if (fs.length === 0) return true; // sport branch falls back to the sport name as its own field
                // "available" = has an OPEN field the bunk can ACCESS, so a pool
                // prefers the candidate that won't force an access-restricted court.
                return fs.some(cf => {
                    if (window.GlobalFieldLocks?.isFieldLocked(cf, slots, divName)) return false;
                    if (_fieldAccessViolates(cf, divName, bunk)) return false;
                    return slotOpen(cf);
                });
            }
            if (ty === 'field') {
                if (window.GlobalFieldLocks?.isFieldLocked(nm, slots, divName)) return false;
                if (_fieldAccessViolates(nm, divName, bunk)) return false;
                return slotOpen(nm);
            }
            // special / pinned → location-based
            if (window.GlobalFieldLocks?.isFieldLocked(nm, slots, divName)) return false;
            const loc = it.location || (typeof getLocationForActivity === 'function' ? getLocationForActivity(nm) : null);
            if (loc) {
                if (_fieldAccessViolates(loc, divName, bunk)) return false;
                if (typeof canScheduleAtLocation === 'function' && !canScheduleAtLocation(nm, loc, slots)) return false;
                if (!slotOpen(loc)) return false;
            }
            return true;
        };
        // Can this pool candidate take THIS bunk without exceeding the sport's
        // maxPlayers? (accessible, unlocked, field-capacity room, AND campers stay
        // under max.) For non-sport candidates or sports with no max/sizes this is
        // just "has an open field". Drives the pool pick so it STOPS choosing a sport
        // once that sport's fields are full at max — routing the bunk to the other.
        const _poolCandidatePlayerFit = (it, divName, slots, bunk, size) => {
            const ty = it.type || 'sport';
            if (ty !== 'sport') return _poolCandidateAvailable(it, divName, slots, bunk);
            const maxP = (_ovSportReq(it.name).maxPlayers) || 0;
            if (!maxP || !(size > 0)) return _poolCandidateAvailable(it, divName, slots, bunk);
            const fs = (fieldsBySport || {})[it.name] || [];
            if (fs.length === 0) return true; // no field list → falls back to sport-name field; can't reason about max
            return fs.some(cf => {
                if (window.GlobalFieldLocks?.isFieldLocked(cf, slots, divName)) return false;
                if (_fieldAccessViolates(cf, divName, bunk)) return false;
                const cap = getFieldCapacityLocal(cf, activityProperties);
                for (const s of slots) { const u = fieldUsageBySlot[s]?.[cf]; if (u && u.count >= cap) return false; }
                return (_ovCampersOn(cf, slots) + size) <= maxP;
            });
        };
        const _pickPoolCandidate = (override, bunk, divName, slots) => {
            let items = (override.poolItems && override.poolItems.length)
                ? override.poolItems
                : (override.sportPool || []).map(n => ({ name: n, type: 'sport', location: null }));
            items = items.filter(it => it && it.name);
            if (!items.length) return null;
            const _size = _ovBunkSize(bunk);
            const getCount = (nm) => (window.RotationEngine && typeof window.RotationEngine.getActivityCount === 'function')
                ? (window.RotationEngine.getActivityCount(bunk, nm) || 0) : 0;
            let best = null, bestScore = -Infinity;
            items.forEach((it, idx) => {
                const fit = _poolCandidatePlayerFit(it, divName, slots, bunk, _size); // open field UNDER maxPlayers
                const avail = _poolCandidateAvailable(it, divName, slots, bunk);       // any open accessible field
                const count = getCount(it.name);
                // ★ MIN/MAX FIRST: a candidate that fits under maxPlayers (+5000) far
                // outranks one that doesn't — so once a sport's fields are full at max,
                // the pool routes the bunk to the other option instead of overfilling.
                // Then any-open-field (+1000), then rotation FAIRNESS (least-done wins,
                // -count*10), then stable order. (The old even-split balancer is gone:
                // distribution now comes from real capacity + rotation, not a forced 50/50.)
                const score = (fit ? 5000 : 0) + (avail ? 1000 : 0) - count * 10 - idx * 0.01;
                if (score > bestScore) { bestScore = score; best = it; }
            });
            return best;
        };

        // ★ Sport PLAYER min/max for bunk overrides — mirror the solver's rule so an
        //   override never overfills a court past maxPlayers or scatters a sport below
        //   minPlayers. INERT unless bunk sizes (camper counts) AND sport min/max are
        //   configured — exactly like the Total Solver's own `projectedPlayers > 0` guard.
        const _ovBunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        const _ovBunkSize = (b) => (_ovBunkMeta[b]?.size || _ovBunkMeta[String(b)]?.size || 0);
        const _ovSportReq = (sp) => (window.SchedulerCoreUtils?.getSportPlayerRequirements?.(sp)) || { minPlayers: null, maxPlayers: null };
        const _ovFieldCampers = {};    // `${slot}|${field}` → campers placed by override sports
        const _ovSportPlacements = []; // {bunk, sport, field, slots, size, divName} for the post-gen min/max scan
        const _ovCampersOn = (field, slots) => { let c = 0; slots.forEach(s => { const v = _ovFieldCampers[s + '|' + field] || 0; if (v > c) c = v; }); return c; };
        const _ovAddCampers = (field, slots, n) => { if (!(n > 0)) return; slots.forEach(s => { const k = s + '|' + field; _ovFieldCampers[k] = (_ovFieldCampers[k] || 0) + n; }); };

        bunkOverrides.forEach(override => {
            let activityName = override.activity;
            let overrideType = override.type;
            let _poolChosenLocation = null; // set when a sportPool override resolves to a chosen candidate
            const startMin = override.startMin ?? Utils.parseTimeToMinutes(override.startTime);
            const endMin = override.endMin ?? Utils.parseTimeToMinutes(override.endTime);
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

            // Resolve a pool ("either/or") override down to one concrete candidate,
            // then let it fall through to the matching per-type placement below.
            if (override.overrideMode === 'sportPool' || overrideType === 'sportPool') {
                const _chosen = _pickPoolCandidate(override, bunk, divName, slots);
                if (!_chosen) {
                    console.warn(`[BunkOverride] Pool ${bunk}: no usable candidate — skipping`);
                    return;
                }
                activityName = _chosen.name;
                overrideType = _chosen.type || 'sport';
                _poolChosenLocation = _chosen.location || null;
                const _poolNames = (override.sportPool && override.sportPool.length)
                    ? override.sportPool
                    : (override.poolItems || []).map(p => p.name);
                console.log(`[BunkOverride] Pool ${bunk}: chose "${activityName}" (${overrideType}) from [${_poolNames.join(', ')}] — fairness+availability`);
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

            } else if (overrideType === 'pinned') {
                // Resolve location: prefer override's stored location, then pinned defaults, then special lookup
                const locName = override.location
                    || _poolChosenLocation
                    || window.getPinnedTileDefaultLocation?.(activityName)
                    || getLocationForActivity(activityName);

                if (locName) {
                    if (window.GlobalFieldLocks?.isFieldLocked(locName, slots, divName)) {
                        console.warn(`   → Pinned ${activityName} location "${locName}" is LOCKED for ${divName}, cannot assign to ${bunk}`);
                        return;
                    }
                    if (!canScheduleAtLocation(activityName, locName, slots)) {
                        console.warn(`[BunkOverride] ${activityName} blocked for ${bunk} - location ${locName} at capacity`);
                        return;
                    }
                }

                fillBlock({
                    divName, bunk, startTime: startMin, endTime: endMin, slots
                }, {
                    field: locName || activityName,
                    sport: null,
                    _fixed: true,
                    _activity: activityName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);

                if (locName) {
                    registerActivityAtLocation(activityName, locName, slots, divName);
                }
                console.log(`   → Pinned ${activityName} assigned to ${bunk}` + (locName ? ` @ ${locName}` : ''));

            } else if (overrideType === 'sport') {
                let fieldName = activityName;
                const fieldsBySportData = fieldsBySport || {};

                const fieldsForSport = fieldsBySportData[activityName] || [];
                const _mySize = _ovBunkSize(bunk);
                const _req = _ovSportReq(activityName);
                const _maxP = _req.maxPlayers || 0;
                const _enforcePlayers = _mySize > 0 && _maxP > 0; // cap campers only when sizes + a max exist
                const _hasMin = _mySize > 0 && (_req.minPlayers || 0) > 0; // only consolidate toward an actual min

                if (fieldsForSport.length > 0) {
                    // Field has open SHARING capacity (bunk count) and isn't locked.
                    const _capRoom = (cf) => {
                        if (window.GlobalFieldLocks?.isFieldLocked(cf, slots, divName)) return false;
                        const maxCapacity = getFieldCapacityLocal(cf, activityProperties);
                        for (const slotIdx of slots) {
                            const usage = fieldUsageBySlot[slotIdx]?.[cf];
                            if (usage && usage.count >= maxCapacity) return false;
                        }
                        return true;
                    };
                    // Adding this bunk keeps the field at/under the sport's maxPlayers.
                    const _maxRoom = (cf) => !_enforcePlayers || (_ovCampersOn(cf, slots) + _mySize) <= _maxP;
                    // Field already hosts this sport → group toward minPlayers before opening a new one.
                    const _occupied = (cf) => _ovCampersOn(cf, slots) > 0;
                    const _access = (cf) => !_fieldAccessViolates(cf, divName, bunk);
                    // Score field-capacity-eligible fields:
                    //   accessible (+1000) > stays under max (+400) > groups for min (+200) > field order.
                    //   ⇒ packs same-sport override bunks onto an accessible field that still has
                    //     player room (toward min), and only opens a new / access-restricted /
                    //     over-max field when nothing better is free. (maxPlayers is a hard cap so
                    //     long as ANY field has player room; the post-scan warns if truly unavoidable.)
                    let picked = null, bestScore = -Infinity;
                    fieldsForSport.forEach((cf, idx) => {
                        if (!_capRoom(cf)) return;
                        const room = _maxRoom(cf);
                        const score = (_access(cf) ? 1000 : 0) + (room ? 400 : 0) + (room && _hasMin && _occupied(cf) ? 200 : 0) - idx * 0.01;
                        if (score > bestScore) { bestScore = score; picked = cf; }
                    });
                    if (picked) fieldName = picked;
                }

                fillBlock({
                    divName, bunk, startTime: startMin, endTime: endMin, slots
                }, {
                    field: fieldName,
                    sport: activityName,
                    _fixed: true,
                    _activity: activityName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                // Track campers on the chosen field + record for the post-gen min/max scan.
                _ovAddCampers(fieldName, slots, _mySize);
                _ovSportPlacements.push({ bunk, sport: activityName, field: fieldName, slots: slots.slice(), size: _mySize, divName });
                console.log(`   → Sport ${activityName} assigned to ${bunk} on field ${fieldName}`);

            } else if (overrideType === 'field') {
                // User pinned a specific field — use the field name directly
                const fieldName = activityName;
                if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots, divName)) {
                    console.warn(`   → Field ${fieldName} is LOCKED for ${divName}, cannot assign to ${bunk}`);
                    return;
                }

                const maxCapacity = getFieldCapacityLocal(fieldName, activityProperties);
                let hasRoom = true;
                for (const slotIdx of slots) {
                    const usage = fieldUsageBySlot[slotIdx]?.[fieldName];
                    if (usage && usage.count >= maxCapacity) {
                        hasRoom = false;
                        break;
                    }
                }
                if (!hasRoom) {
                    console.warn(`   → Field ${fieldName} at capacity, cannot assign to ${bunk}`);
                    return;
                }

                fillBlock({
                    divName, bunk, startTime: startMin, endTime: endMin, slots
                }, {
                    field: fieldName,
                    sport: null,
                    _fixed: true,
                    _activity: fieldName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);
                console.log(`   → Field ${fieldName} assigned to ${bunk}`);

            } else if (overrideType === 'special') {
                // Use stored location from override, fall back to global lookup
                const locName = override.location || _poolChosenLocation || getLocationForActivity(activityName);

                if (window.GlobalFieldLocks?.isFieldLocked(activityName, slots, divName)) {
                    console.warn(`   → Special ${activityName} is LOCKED for ${divName}, cannot assign to ${bunk}`);
                    return;
                }

                if (locName && !canScheduleAtLocation(activityName, locName, slots)) {
                    console.warn(`[BunkOverride] ${activityName} blocked for ${bunk} - location ${locName} in use`);
                    return;
                }

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
                    divName, bunk, startTime: startMin, endTime: endMin, slots
                }, {
                    field: activityName,
                    sport: null,
                    _fixed: true,
                    _activity: activityName,
                    _bunkOverride: true
                }, fieldUsageBySlot, yesterdayHistory, false, activityProperties);

                registerActivityAtLocation(activityName, locName, slots, divName);

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
                console.warn(`   → Unknown override type "${overrideType}", treating as generic pin`);
                fillBlock({
                    divName, bunk, startTime: startMin, endTime: endMin, slots
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
        // ★ Risk #2 (Day 28 — "warn but allow", user decision 2026-06-01):
        //   Bunk overrides intentionally BYPASS field access restrictions (the
        //   user is the boss), but a restricted placement must never be SILENT.
        //   Scan the just-placed _bunkOverride blocks against each field's
        //   accessRestrictions (mirrors the solver's hard check in
        //   total_solver_engine.calculatePenaltyCost + scheduler_core_utils
        //   canBlockFit) and emit a NON-BLOCKING heads-up consumed by
        //   coverage_warning.js. Placement is unchanged — this only reports.
        //   Fires every manual gen (empty payload clears stale warnings).
        // =========================================================================
        try {
            // Reuse the hoisted access check (defined before the override loop) so
            // the warn scan and the field-preference logic can never diverge.
            const _oaViolates = _fieldAccessViolates;
            const _bunkDivOf = {};
            Object.keys(divisions).forEach(dn => ((divisions[dn] || {}).bunks || []).forEach(b => { _bunkDivOf[String(b)] = dn; }));
            const _oaWarn = [];
            const _seenOA = {};
            Object.keys(window.scheduleAssignments || {}).forEach(bk => {
                (window.scheduleAssignments[bk] || []).forEach(s => {
                    if (!s || s._bunkOverride !== true || s.continuation) return;
                    if (s._isTrip || s._zone === 'offsite') return; // trips are off-site — no field access
                    const fld = s.field;
                    if (!fld || fld === 'Free') return;
                    const dn = _bunkDivOf[String(bk)];
                    if (!_oaViolates(fld, dn, bk)) return;
                    const k = bk + '|' + fld + '|' + (s._startMin == null ? '' : s._startMin);
                    if (_seenOA[k]) return; _seenOA[k] = 1;
                    _oaWarn.push({ bunk: bk, division: dn, field: fld, activity: s._activity || fld, startMin: s._startMin, endMin: s._endMin });
                });
            });
            window._overrideAccessWarnings = _oaWarn;
            window.dispatchEvent(new CustomEvent('campistry-override-access-warnings', { detail: { count: _oaWarn.length, items: _oaWarn } }));
            if (_oaWarn.length) console.warn('[BunkOverride] ⚠️ ' + _oaWarn.length + ' override(s) placed on access-restricted field(s) — ALLOWED (warn-but-allow). See heads-up panel.');
        } catch (_eOA) { console.warn('[BunkOverride] access-warning scan error: ' + (_eOA && _eOA.message)); }

        // =========================================================================
        // ★ Sport player min/max heads-up (warn-but-allow). The field picker above
        //   groups override bunks toward minPlayers and caps campers at maxPlayers —
        //   but the user's explicit picks can still leave a sport under min (nothing
        //   left to combine with) or, in the rare all-fields-full case, over max.
        //   Surface those (never silent, never block), mirroring the access heads-up.
        //   Empty payload clears stale warnings every gen. Inert without bunk sizes.
        // =========================================================================
        try {
            const _pwGroups = {}; // `${field}|${slot}|${sport}` → tally
            _ovSportPlacements.forEach(p => {
                if (!(p.size > 0)) return; // player rules inert without bunk sizes
                const req = _ovSportReq(p.sport);
                if (!req.minPlayers && !req.maxPlayers) return;
                p.slots.forEach(s => {
                    const k = p.field + '|' + s + '|' + p.sport;
                    const g = (_pwGroups[k] = _pwGroups[k] || { field: p.field, sport: p.sport, min: req.minPlayers || 0, max: req.maxPlayers || 0, campers: 0, bunks: new Set() });
                    g.campers += p.size;
                    g.bunks.add(p.bunk);
                });
            });
            const _pwSeen = {}, _pw = [];
            Object.keys(_pwGroups).forEach(k => {
                const g = _pwGroups[k];
                const under = g.min && g.campers < g.min;
                const over = g.max && g.campers > g.max;
                if (!under && !over) return;
                const fk = g.field + '|' + g.sport + '|' + (under ? 'min' : 'max'); // collapse multi-slot → one row
                if (_pwSeen[fk]) return; _pwSeen[fk] = 1;
                _pw.push({ field: g.field, sport: g.sport, campers: g.campers, min: g.min, max: g.max, kind: under ? 'min' : 'max', bunks: Array.from(g.bunks) });
            });
            window._overridePlayerWarnings = _pw;
            window.dispatchEvent(new CustomEvent('campistry-override-player-warnings', { detail: { count: _pw.length, items: _pw } }));
            if (_pw.length) console.warn('[BunkOverride] ⚠️ ' + _pw.length + ' override sport(s) outside player min/max — placed anyway (warn-but-allow).');
        } catch (_ePW) { console.warn('[BunkOverride] player-warning scan error: ' + (_ePW && _ePW.message)); }

        // =========================================================================
        // STEP 2.4: Daily Trips (off-campus) — honor campDailyTrips like AUTO does
        // =========================================================================
        //   Trips entered via the Trips popover are stored per-date in
        //   campDailyTrips_<date> (+ dailyData.dailyTrips). The AUTO builder reads
        //   this store directly (Phase 0). The MANUAL builder previously only saw
        //   trips that were ALSO injected into the skeleton at add-time — which
        //   only happens for manual-mode adds — so a trip added in AUTO mode was
        //   silently ignored on a manual generation. Read the store and pin a trip
        //   block over every bunk in the trip's division(s). Overwrite is
        //   intentional: a trip means the bunk is off-site, so it supersedes
        //   whatever else landed in that window (idempotent when the skeleton
        //   already placed the same trip in manual-mode-add).
        try {
            const _dk = window.currentScheduleDate || '';
            let _dTrips = [];
            try { const _s = localStorage.getItem('campDailyTrips_' + _dk); if (_s) _dTrips = JSON.parse(_s); } catch (_e) {}
            if (!Array.isArray(_dTrips) || !_dTrips.length) {
                const _dd = window.loadCurrentDailyData?.() || {};
                _dTrips = (_dd && _dd.dailyTrips) || [];
            }
            // Expand a (possibly parent) division to leaf division names present here.
            const _expandTripDiv = (d) => {
                if (!d) return [];
                const info = divisions[d];
                if (info && info.isParent) {
                    const kids = Array.isArray(info.children) ? info.children
                               : Array.isArray(info.grades) ? info.grades : null;
                    if (kids && kids.length) return kids.filter(k => divisions[k]);
                    return Object.keys(divisions).filter(k => {
                        const ki = divisions[k];
                        return ki && !ki.isParent && (ki.parent === d || ki.parentDivision === d);
                    });
                }
                return divisions[d] ? [d] : [];
            };
            let _tripPinned = 0;
            (_dTrips || []).forEach(trip => {
                const rawDivs = Array.isArray(trip.division) ? trip.division : [trip.division];
                const tStart = trip.startMin ?? Utils.parseTimeToMinutes(trip.startTime);
                const tEnd = trip.endMin ?? Utils.parseTimeToMinutes(trip.endTime);
                if (tStart == null || tEnd == null) return;
                const tripName = trip.event || 'Trip';
                const divSet = {};
                rawDivs.forEach(rd => _expandTripDiv(rd).forEach(g => { divSet[g] = 1; }));
                Object.keys(divSet).forEach(divName => {
                    if (allowedDivisionsSet && !allowedDivisionsSet.has(String(divName))) return;
                    const slots = Utils.findSlotsForRange(tStart, tEnd, divName);
                    if (!slots || !slots.length) return;
                    (divisions[divName].bunks || []).forEach(bunk => {
                        if (!window.scheduleAssignments[bunk]) return;
                        slots.forEach((slotIndex, i) => {
                            window.scheduleAssignments[bunk][slotIndex] = {
                                field: tripName, sport: null, continuation: i > 0,
                                _fixed: true, _activity: tripName, _isTrip: true,
                                _bunkOverride: true, _zone: 'offsite'
                            };
                        });
                        _tripPinned++;
                    });
                });
            });
            if (_tripPinned > 0) console.log('[DailyTrips] Pinned ' + _tripPinned + ' bunk-trip block(s) from campDailyTrips (manual).');
        } catch (_eTrip) { try { console.warn('[DailyTrips] ' + (_eTrip && _eTrip.message)); } catch (_e2) {} }

        // =========================================================================
        // STEP 2.5: Process Elective Tiles
        // =========================================================================

        // ★ Cleanup: drop orphan _swimChange tiles whose adjacent Swim has been
        //   removed (e.g. user merged Swim + Elective into a hybrid, or moved the swim).
        //   A _swimChange tile is orphan if no swim/swim_elective in the same division
        //   touches it (pre = ends at swim's start, post = starts at swim's end).
        // ★ Post-guard: final safety net. Even if a malformed/duplicate tile slips past
        //   the editors' save-time guards (or arrives from an older cloud record), drop
        //   it here so generation always works on a clean skeleton — same shared rules.
        try {
            if (window.CampUtils && window.CampUtils.sanitizeSkeletonTiles) {
                const _gsan = window.CampUtils.sanitizeSkeletonTiles(manualSkeleton);
                if (_gsan && Array.isArray(_gsan.tiles)) manualSkeleton = _gsan.tiles;
            }
        } catch (e) { console.error('[Optimizer] skeleton sanitize failed (non-fatal):', e); }

        const _origLen = manualSkeleton.length;
        manualSkeleton = manualSkeleton.filter(item => {
            if (!item || !item._swimChange) return true;
            const itemStart = Utils.parseTimeToMinutes(item.startTime);
            const itemEnd = Utils.parseTimeToMinutes(item.endTime);
            if (itemStart === null || itemEnd === null) return true;
            const hasMate = manualSkeleton.some(other => {
                if (!other || other === item) return false;
                if (other.division !== item.division) return false;
                const otherIsSwim = (other.type === 'pinned' && /^swim$/i.test(other.event || '')) ||
                                    other.type === 'swim_elective';
                if (!otherIsSwim) return false;
                const otherStart = Utils.parseTimeToMinutes(other.startTime);
                const otherEnd = Utils.parseTimeToMinutes(other.endTime);
                if (otherStart === null || otherEnd === null) return false;
                if (item._swimChange === 'pre' && Math.abs(itemEnd - otherStart) <= 30) return true;
                if (item._swimChange === 'post' && Math.abs(itemStart - otherEnd) <= 30) return true;
                return false;
            });
            if (!hasMate) {
                console.log(`[CLEANUP] Removing orphan _swimChange tile: ${item.event} ${item.startTime}-${item.endTime} (${item.division})`);
                return false;
            }
            return true;
        });
        if (manualSkeleton.length !== _origLen) {
            console.log(`[CLEANUP] Removed ${_origLen - manualSkeleton.length} orphan Change tile(s)`);
        }

        // =========================================================================
        // STEP 2.45: PINNED-FACILITY PRE-LOCK (custom-pinned exclusion).
        // A custom pinned tile must win its reserved facilities over EVERYTHING
        // except another custom pinned tile. Electives (STEP 2.5) register their own
        // per-division locks, and leagues + the solver run in STEP 4+. If the pinned
        // facility lock is registered only during STEP 3 (AFTER electives), an
        // elective that grabs the same facility/time first makes the later pinned
        // lockField() silently fail on the shared slot-index key — leaving the
        // facility protected by only the elective's DIVISION lock, which still lets
        // the elective's OWN grade reuse it (invariant violation). Registering the
        // pinned GLOBAL locks here, BEFORE electives, guarantees pinned always wins:
        // a later elective lockFieldForDivision() yields to the existing global lock,
        // and every consumer's time-based check sees the pinned lock. The matching
        // re-lock in STEP 3 then becomes a harmless no-op (already locked at the same
        // time). Scoped to type==='pinned' (the custom pinned tile). Pinned-vs-pinned
        // coexistence is preserved because tile PLACEMENT in STEP 3 fills
        // unconditionally — only the facility LOCK is pre-registered here.
        // =========================================================================
        if (window.GlobalFieldLocks) {
            let _preLockCount = 0;
            manualSkeleton.forEach(item => {
                if (!item || item.type !== 'pinned') return;
                const _divName = item.division;
                if (allowedDivisionsSet && !allowedDivisionsSet.has(String(_divName))) return;
                if (!((divisions[_divName] && divisions[_divName].bunks) || []).length) return;
                const _sMin = Utils.parseTimeToMinutes(item.startTime);
                const _eMin = Utils.parseTimeToMinutes(item.endTime);
                if (_sMin == null || _eMin == null || _eMin <= _sMin) return;
                const _exact = findExactSlotForTimeRange(_divName, _sMin, _eMin);
                const _slots = _exact !== -1 ? [_exact] : Utils.findSlotsForRange(_sMin, _eMin, _divName);
                if (!_slots.length) return;
                const _eventName = item.event || item.type || 'Pinned Event';
                const _pinFields = new Set();
                const _add = (f) => { if (f && typeof f === 'string' && f.trim() && f !== 'Free') _pinFields.add(f.trim()); };
                _add(getLocationForPinnedEvent(item));
                _add(typeof item.location === 'string' ? item.location : null);
                if (Array.isArray(item.reservedFields)) item.reservedFields.forEach(_add);
                _pinFields.forEach(_pinLoc => {
                    const _ok = window.GlobalFieldLocks.lockField(_pinLoc, _slots, {
                        lockedBy: 'pinned_event_location',
                        division: _divName,
                        startMin: _sMin, endMin: _eMin,
                        activity: `${_eventName} (pinned @ ${_pinLoc})`
                    });
                    if (_ok) _preLockCount++;
                });
            });
            console.log(`[STEP 2.45] Pinned-facility pre-lock: registered ${_preLockCount} custom-pinned facility lock(s) before electives`);
        }

        console.log("\n[STEP 2.5] Processing elective tiles (incl. swim+elective hybrids)...");
        // ★ Hybrid 'swim_elective' tiles are processed alongside electives:
        //   they reserve the pool AND the elective activities.
        const electiveTiles = manualSkeleton.filter(item =>
            item.type === 'elective' || item.type === 'swim_elective'
        );

        electiveTiles.forEach(elective => {
            const electiveDivision = elective.division;

            if (allowedDivisionsSet && !allowedDivisionsSet.has(String(electiveDivision))) {
                return;
            }

            // For hybrid tiles, fold the swim location into the activity list so
            // it gets locked too (acts like swim).
            const baseActivities = elective.electiveActivities || [];
            const hybridSwimLoc = (elective.type === 'swim_elective' && elective.swimLocation) ? [elective.swimLocation] : [];
            const activities = Array.from(new Set([...baseActivities, ...hybridSwimLoc]));
            const startMin = Utils.parseTimeToMinutes(elective.startTime);
            const endMin = Utils.parseTimeToMinutes(elective.endTime);
            const slots = Utils.findSlotsForRange(startMin, endMin, electiveDivision);

            if (activities.length === 0 || slots.length === 0) {
                console.warn(`[Elective] Skipping ${elective.type} for ${electiveDivision} - no activities or slots`);
                return;
            }

            console.log(`[${elective.type === 'swim_elective' ? 'Swim+Elective' : 'Elective'}] ${electiveDivision}: Reserving ${activities.join(', ')} @ ${elective.startTime}-${elective.endTime}`);

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
                        `Elective (${electiveDivision})`,
                        { startMin, endMin }
                    );
                    console.log(`   → Locked "${resolvedName}" for ${electiveDivision} only`);

                    if (isSwimOrPool(resolvedName)) {
                        SWIM_POOL_ALIASES.forEach(alias => {
                            if (alias.toLowerCase() !== resolvedName.toLowerCase()) {
                                window.GlobalFieldLocks.lockFieldForDivision(
                                    alias,
                                    slots,
                                    electiveDivision,
                                    `Elective (${electiveDivision}) - Pool Alias`,
                                    { startMin, endMin }
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

            // ★ Skip malformed tiles whose end is at/before their start (e.g. a typo'd
            //   "5:10pm-4:50pm"). The slot-grid builder already drops these
            //   (division_times_system.js), but the pinned-fill path below reads the raw
            //   skeleton — without this guard a backwards-time tile still gets pinned onto
            //   every bunk (e.g. phantom "Signup leagues" on a division that never set it).
            if (sMin != null && eMin != null && eMin <= sMin) {
                console.warn(`[SKELETON] ⚠️ Skipping malformed tile "${item.event || item.type}" for ${divName}: ${item.startTime}–${item.endTime} (end ≤ start)`);
                return;
            }

            // ★★★ v17.5 FIX: Process PINNED events FIRST (before overlap check) ★★★
            // ★ Hybrid swim_elective is treated like a pinned fill (every bunk gets
            //   the same "Swim + Elective" entry so per-bunk views show the option).
            const isHybridSE = item.type === 'swim_elective';
            const isPinnedType = isHybridSE ||
                                 item.type === 'pinned' ||
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

                    // ★ Hybrid extras stamped onto each bunk's entry so renderers can
                    //   show the combined "Pool + Activities" label and Change subdivision.
                    //   _splitPreChange/_splitPostChange use the same metadata as split-swim
                    //   so the existing print-center / unified renderers already know how
                    //   to draw Change → Hybrid → Change strips.
                    const hybridExtras = isHybridSE ? {
                        _swimElective: true,
                        _swimLocation: item.swimLocation,
                        _electiveActivities: item.electiveActivities || [],
                        _reservedFields: item.reservedFields || [],
                        _preChangeMin: item._preChangeMin,
                        _postChangeMin: item._postChangeMin,
                        _splitPreChange: parseInt(item._preChangeMin) || 0,
                        _splitPostChange: parseInt(item._postChangeMin) || 0
                    } : null;

                    // ★ Custom/pinned tile with specific fields: stamp the reserved
                    //   fields (and any explicit location) onto each bunk's entry so
                    //   ENTRY-based renderers (print center, Excel export) can show
                    //   "Basketball – Field 1, Field 2". The on-screen unified grid
                    //   already shows them because renderBunkCell reads them straight
                    //   off the skeleton block, but the entry itself only carried the
                    //   event name. Reuses hybridExtras' stamping loop below.
                    let pinnedExtras = hybridExtras;
                    if (!pinnedExtras) {
                        const _pinRF = Array.isArray(item.reservedFields)
                            ? item.reservedFields.filter(Boolean) : [];
                        const _pinLoc = (typeof item.location === 'string') ? item.location.trim() : '';
                        if (_pinRF.length || _pinLoc) {
                            pinnedExtras = {};
                            if (_pinRF.length) pinnedExtras._reservedFields = _pinRF;
                            if (_pinLoc) pinnedExtras._location = _pinLoc;
                        }
                    }

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

                        // Stamp hybrid metadata onto every slot of this bunk that
                        // got a 'Swim + Elective' fill. fillBlock can write to a
                        // different slot index than slots[0] (it derives mainSlots
                        // from findSlotsForRange + transition rules), so scan the
                        // bunk's full slot array and stamp anywhere matching the
                        // event name and time range.
                        if (pinnedExtras) {
                            const ba = window.scheduleAssignments?.[bunk];
                            if (Array.isArray(ba)) {
                                for (let _si = 0; _si < ba.length; _si++) {
                                    const a = ba[_si];
                                    if (!a) continue;
                                    const matchesEvent = (a.field === eventName) || (a._activity === eventName);
                                    const matchesTime = (a._startMin === sMin) || (a._startMin == null);
                                    if (matchesEvent && matchesTime) {
                                        Object.assign(a, pinnedExtras);
                                    }
                                }
                            }
                        }

                        pinnedEventCount++;
                    });
                    
                    console.log(`[SKELETON] ✅ Filled pinned "${eventName}" for ${divName} (${bunkList.length} bunks)`);

                    // ★ v17.11: Lock physical location if pinned event uses one.
                    // ★ FACILITY RESERVATION (custom.pinned override): a custom pinned
                    //   tile can reserve SEVERAL facilities (item.reservedFields, e.g.
                    //   "Basketball – Field 1, Field 2") plus an explicit location — but
                    //   only the single getLocationForPinnedEvent() result used to be
                    //   locked, so the OTHER reserved fields leaked and a league (which
                    //   runs later, in STEP 4/5, and yields to existing locks) could
                    //   grab them for another division. Lock EVERY field a custom pinned
                    //   tile uses, GLOBALLY, before any league runs — so custom pinned
                    //   always wins over regular AND specialty leagues.
                    if (window.GlobalFieldLocks) {
                        const _pinFields = new Set();
                        const _addPinField = (f) => {
                            if (f && typeof f === 'string' && f.trim() && f !== 'Free') _pinFields.add(f.trim());
                        };
                        _addPinField(getLocationForPinnedEvent(item));
                        _addPinField(typeof item.location === 'string' ? item.location : null);
                        if (Array.isArray(item.reservedFields)) item.reservedFields.forEach(_addPinField);
                        _pinFields.forEach(_pinLoc => {
                            window.GlobalFieldLocks.lockField(_pinLoc, slots, {
                                lockedBy: 'pinned_event_location',
                                division: divName,
                                // ★ Stamp EXPLICIT times so cross-grade time checks
                                //   (isFieldLockedByTime) never have to derive the window
                                //   from this division's slot grid. Without explicit times,
                                //   a league on ANOTHER grade's grid that can't resolve the
                                //   pinned division's slot index silently skips the lock
                                //   (global_field_locks ~L312) and poaches the facility.
                                startMin: sMin, endMin: eMin,
                                activity: `${eventName} (pinned @ ${_pinLoc})`
                            });
                            console.log(`[SKELETON] 🔒 Locked "${_pinLoc}" for pinned "${eventName}" in ${divName}`);
                        });
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

                let groupA, groupB;
                if (item.group1Bunks && item.group1Bunks.length > 0) {
                    // User-defined group assignment: group1Bunks = Group A; rest = Group B
                    const g1Set = new Set(item.group1Bunks.map(String));
                    groupA = bunkList.filter(b => g1Set.has(String(b)));
                    groupB = bunkList.filter(b => !g1Set.has(String(b)));
                    // Fall back to auto-split if all/none are in g1 (guards stale data)
                    if (groupA.length === 0 || groupB.length === 0) {
                        const sortedBunks = [...bunkList].sort((a, b) => {
                            const numA = parseInt(a.match(/\d+/)?.[0] || 0);
                            const numB = parseInt(b.match(/\d+/)?.[0] || 0);
                            return numA - numB || a.localeCompare(b);
                        });
                        const half = Math.ceil(sortedBunks.length / 2);
                        groupA = sortedBunks.slice(0, half);
                        groupB = sortedBunks.slice(half);
                        console.log(`[SPLIT] group1Bunks produced empty group — falling back to auto-split`);
                    } else {
                        console.log(`[SPLIT] Using user-defined groups — Group1: ${groupA.join(', ')} | Group2: ${groupB.join(', ')}`);
                    }
                } else {
                    const sortedBunks = [...bunkList].sort((a, b) => {
                        const numA = parseInt(a.match(/\d+/)?.[0] || 0);
                        const numB = parseInt(b.match(/\d+/)?.[0] || 0);
                        return numA - numB || a.localeCompare(b);
                    });
                    const half = Math.ceil(sortedBunks.length / 2);
                    groupA = sortedBunks.slice(0, half);
                    groupB = sortedBunks.slice(half);
                }

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

                // ★ Swim-in-split: detect if swim is one of the activities
                const splitSwimIs1 = isSwimOrPool(act1Name);
                const splitSwimIs2 = isSwimOrPool(act2Name);
                const splitHasSwim = splitSwimIs1 || splitSwimIs2;
                const splitPreChange = splitHasSwim ? (parseInt(item._preChangeMin) || 0) : 0;
                const splitPostChange = splitHasSwim ? (parseInt(item._postChangeMin) || 0) : 0;
                const splitChangeMin = splitPreChange + splitPostChange; // total change per half

                // Split block in half. Within each group's swim half, change is carved:
                // Swim half = [PreChange][Swim][PostChange] — sports half stays as one continuous tile.
                // Group A (swim first): PreChange→Swim→PostChange | Sports
                // Group B (swim second): Sports | PreChange→Swim→PostChange
                const midMin = Math.floor(sMin + (eMin - sMin) / 2);

                // Determine which activity is swim and which is the other
                const swimActName = splitSwimIs1 ? act1Name : act2Name;
                const otherActName = splitSwimIs1 ? act2Name : act1Name;
                // swimFirstGroup: the group that does swim in the first half (Group A does act1 first)
                const swimFirstGroup = splitSwimIs1 ? groupA : groupB;
                const swimSecondGroup = splitSwimIs1 ? groupB : groupA;

                console.log(`[SPLIT] Main 1 (act1Name): "${act1Name}"`);
                console.log(`[SPLIT] Main 2 (act2Name): "${act2Name}"`);
                console.log(`[SPLIT] Time block: ${sMin} to ${eMin} (mid: ${midMin})${splitChangeMin ? ' change: ' + splitPreChange + 'pre/' + splitPostChange + 'post' : ''}`);
                console.log(`[SPLIT] Group 1 (${groupA.length} bunks): ${groupA.join(', ')}`);
                console.log(`[SPLIT] Group 2 (${groupB.length} bunks): ${groupB.join(', ')}`);
                console.log(`[SPLIT] ---------------------------------------------------`);
                if (splitChangeMin > 0) {
                    const swimTime = Math.floor((eMin - sMin) / 2) - splitPreChange - splitPostChange;
                    console.log(`[SPLIT] Swim-first group: Change(${splitPreChange}m) → Swim(${swimTime}m) → Change(${splitPostChange}m) | ${otherActName}`);
                    console.log(`[SPLIT] Swim-second group: ${otherActName} | Change(${splitPreChange}m) → Swim(${swimTime}m) → Change(${splitPostChange}m)`);
                } else {
                    console.log(`[SPLIT] FIRST HALF (${sMin}-${midMin}): Group1→${act1Name}, Group2→${act2Name}`);
                    console.log(`[SPLIT] SECOND HALF (${midMin}-${eMin}): Group1→${act2Name}, Group2→${act1Name}`);
                }
                console.log(`[SPLIT] ---------------------------------------------------`);

                const routeSplitActivity = (bunks, actName, start, end, groupLabel, actLabel) => {
                    // ★★★ FIXED: Find exact slot for this time range ★★★
                    const exactSlot = findExactSlotForTimeRange(divName, start, end);
                    const fallbackSlots = Utils.findSlotsForRange(start, end, divName);
                    // Strictly filter to slots fully within [start, end] so the boundary
                    // slot (endMin === midMin) is not shared between both halves.
                    const _divSlotsArr = window.divisionTimes?.[String(divName)] || [];
                    const strictSlots = fallbackSlots.filter(si => {
                        const s = _divSlotsArr[si];
                        return s && s.startMin >= start && s.endMin <= end;
                    });
                    const targetSlots = exactSlot !== -1 ? [exactSlot] : (strictSlots.length > 0 ? strictSlots : fallbackSlots);

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
                                _slotKind: slotKindOf(actName),
                                type: 'slot',
                                startTime: start,
                                endTime: end,
                                slots: targetSlots,
                                fromSplitTile: true,
                                _fromSplitTile: true,
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
                                fromSplitTile: true
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

                // ───────────────────────────────────────────────────────────
                // STANDARD SPLIT GENERATION (always used, even with change)
                // groupA gets act1 in first half, act2 in second half
                // groupB gets act2 in first half, act1 in second half
                // ───────────────────────────────────────────────────────────
                console.log(`[SPLIT] \n>>> FIRST HALF (${sMin}-${midMin}) <<<`);
                routeSplitActivity(groupA, act1Name, sMin, midMin, "Group 1", "main 1");
                routeSplitActivity(groupB, act2Name, sMin, midMin, "Group 2", "main 2");

                console.log(`[SPLIT] \n>>> SECOND HALF (${midMin}-${eMin}) - SWITCH <<<`);
                routeSplitActivity(groupA, act2Name, midMin, eMin, "Group 1", "main 2");
                routeSplitActivity(groupB, act1Name, midMin, eMin, "Group 2", "main 1");

                // ───────────────────────────────────────────────────────────
                // SWIM-CHANGE METADATA: ADDED AFTER GENERATION (additive only)
                // Stamp _splitPreChange/_splitPostChange on the swim half of each
                // bunk so the renderer can show Change → Swim → Change. Sports
                // halves are left untouched. This does NOT change generation.
                // ───────────────────────────────────────────────────────────
                if (splitChangeMin > 0 && splitHasSwim) {
                    const swimNorm = (swimActName || '').toLowerCase().trim();
                    const stampSwim = (bunk) => {
                        const slots = window.divisionTimes?.[divName] || [];
                        for (let si = 0; si < slots.length; si++) {
                            const slot = slots[si];
                            if (!slot || slot.startMin == null || slot.endMin == null) continue;
                            // Only consider slots inside this split tile's time block
                            if (slot.startMin < sMin || slot.endMin > eMin) continue;
                            const a = window.scheduleAssignments?.[bunk]?.[si];
                            if (!a) continue;
                            const aNameRaw = (a._activity || a.field || '');
                            const aNorm = (typeof aNameRaw === 'string' ? aNameRaw : '').toLowerCase().trim();
                            // Match if assignment is the swim activity (or any swim/pool alias)
                            const isThisSwim = aNorm === swimNorm || isSwimOrPool(aNameRaw);
                            if (isThisSwim) {
                                a._splitPreChange = splitPreChange;
                                a._splitPostChange = splitPostChange;
                            }
                        }
                    };
                    groupA.forEach(stampSwim);
                    groupB.forEach(stampSwim);
                    console.log(`[SPLIT] Stamped swim-change metadata: ${splitPreChange}m pre / ${splitPostChange}m post on swim assignments`);
                }

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
                    type: 'league',
                    leagueName: item.leagueName || null,
                    _doubleHeaderPairId: item._doubleHeaderPairId || null,
                    _isAway: item.isAway === true,
                    _awayZone: item.isAway === true ? (item.awayZone || null) : null,
                    _awayMode: item.isAway === true ? (item.awayMode === 'mixed' ? 'mixed' : 'exclusive') : null
                });
                return;
            }

            // Check if it's a smart tile (handled separately)
            if (item.type === 'smart' || item.smartActivities) {
                return; // Smart tiles are processed in processSmartTiles
            }

            // General activity slot or other schedulable block
            if (normalizedGA || item.type === 'slot' || GENERATOR_TYPES.includes(item.type)) {
                // ★ Capture the tile's category from the RAW event label (sport-only /
                //   special-only / flexible) before normalizedGA flattens it — the
                //   solver uses this to keep specials out of Sports tiles and sports
                //   out of Special tiles.
                const _slotKind = slotKindOf(eventName);
                bunkList.forEach(bunk => {
                    const existing = window.scheduleAssignments[bunk]?.[slots[0]];
                    if (existing && existing._bunkOverride) return;

                    schedulableSlotBlocks.push({
                        divName,
                        bunk,
                        event: normalizedGA || eventName,
                        _slotKind,
                        type: 'slot',
                        startTime: sMin,
                        endTime: eMin,
                        slots,
                        // ★ Away (off-campus): restrict the solver to the zone's fields + travel.
                        _isAway: item.isAway === true,
                        _awayZone: item.isAway === true ? (item.awayZone || null) : null,
                        _awayMode: item.isAway === true ? (item.awayMode === 'mixed' ? 'mixed' : 'exclusive') : null
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

        // ★★★ RAINY DAY FIX: Skip ALL league processing on rainy days ★★★
        // Rainy day skeletons have no league blocks, but stale masterLeagues config
        // could still inject league data. Skip entirely to prevent ghost league rows.
        const _skipLeagues = isRainyDayModeActive() || window.isRainyDay === true;
        
        if (_skipLeagues) {
            console.log("\n[STEP 4] ⏭️ Skipping specialty leagues (rainy day mode)");
            console.log("[STEP 5] ⏭️ Skipping regular leagues (rainy day mode)");
            console.log("[STEP 5.5] ⏭️ Skipping league consolidation (rainy day mode)");
            // Ensure leagueAssignments is clean
            window.leagueAssignments = {};
        } else {

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
            // ★ FN-54: divisions covered by THIS generation — lets the league
            // engine reset a covered league's day records even when its tile
            // was removed from the skeleton (no league blocks in play).
            generatedDivisions: [...new Set(
                [...specialtyLeagueBlocks, ...leagueBlocks, ...schedulableSlotBlocks]
                    .map(b => b && b.divName).filter(Boolean)
            )],
            disabledFields,
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

        // ★★★ CHINUCH (manual mode) — matchup-display level, NOT per-bunk ★★★
        // Teams and bunks are SEPARATE concepts. A chinuch team is shown in the
        // league game's matchup display as "Team X — Chinuch (Facility)", built
        // by processRegularLeagues (it appends those lines to pick._allMatchups,
        // which fillBlock stores into leagueAssignments[divName][slot].matchups).
        // We do NOT override any individual bunk's schedule slot for chinuch —
        // the old STEP 5.1 per-bunk writeback was the wrong model (and, because
        // window.chinuchSchedule is keyed by TEAM label while it indexed by BUNK
        // key, it never matched anyway). Removed: chinuch now lives purely in the
        // matchup display, consistent with how the league block itself renders.
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
            activeSpecialtyLeagues = masterSpecialtyLeagues.filter(l => !disabledSpecialtyLeagues?.includes(l.name) && !disabledSpecialtyLeagues?.includes(l.id));
        } else if (masterSpecialtyLeagues && typeof masterSpecialtyLeagues === 'object') {
            activeSpecialtyLeagues = Object.values(masterSpecialtyLeagues).filter(l => l && !disabledSpecialtyLeagues?.includes(l.name) && !disabledSpecialtyLeagues?.includes(l.id));
        }
        
        console.log(`[STEP 5.5] Active leagues: ${activeLeagues.length}, Specialty: ${activeSpecialtyLeagues.length}`);
        
       leagueBlocks.forEach(block => {
            if (block.processed) return;
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

        } // ★★★ END: Skip leagues on rainy day ★★★

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
        // STEP 6.95: LOCK EACH PLACED SPECIAL'S PHYSICAL FACILITY
        // =========================================================================
        // Smart Tiles place specials by NAME (field = "Basketball Clinic"), but a
        // special's physical room can ALSO be a sport field (e.g. "Basketball Clinic"
        // → court "Jump Shot", which is in the Basketball field pool). The total solver
        // tracks sports by field name and specials by name, so without this it can drop
        // a Basketball game onto the very court a clinic is using — a physical double-
        // book neither engine sees. Some smart-tile paths already lock the facility;
        // this pass does it UNIFORMLY for every placed special, so the solver
        // (isFieldLocked / isFieldLockedByTime) and the lock-aware fill passes skip that
        // court for sports. Runs AFTER all special placement → never blocks same-special
        // capacity sharing (specials are already seated; the lock only gates downstream
        // SPORT placement). Time-based so it holds across divisions' differing grids.
        try {
            if (window.GlobalFieldLocks && window.GlobalFieldLocks.lockField) {
                const _slGS = window.loadGlobalSettings ? window.loadGlobalSettings() : (window.globalSettings || {});
                const _slSpecLoc = {}; // special name (lc) → physical location (orig case); first-with-location wins (cap/lowercase dup quirk)
                ((_slGS.app1 && _slGS.app1.specialActivities) || _slGS.specialActivities || []).forEach(s => {
                    if (!s || !s.name) return;
                    const _snm = String(s.name).toLowerCase().trim();
                    if (s.location && !_slSpecLoc[_snm]) _slSpecLoc[_snm] = s.location;
                });
                const _slDivs = window.divisions || {};
                const _slB2D = {}; Object.keys(_slDivs).forEach(d => ((_slDivs[d] && _slDivs[d].bunks) || []).forEach(b => { _slB2D[String(b)] = d; }));
                const _slDT = window.divisionTimes || {};
                const _slSA = window.scheduleAssignments || {};
                const _slDone = {};
                let _slLocked = 0;
                Object.keys(_slSA).forEach(bunk => {
                    const arr = _slSA[bunk]; if (!Array.isArray(arr)) return;
                    const div = _slB2D[String(bunk)]; if (!div) return;
                    arr.forEach((e, idx) => {
                        if (!e || e.continuation || e._noRoomCap) return;
                        const act = e._activity || e.field;
                        const locName = _slSpecLoc[String(act || '').toLowerCase().trim()]; // null unless a real special
                        if (!locName) return;
                        const sM = e._startMin, eM = e._endMin; if (sM == null || eM == null) return;
                        const key = String(locName).toLowerCase().trim() + '|' + sM + '-' + eM;
                        if (_slDone[key]) return; _slDone[key] = 1;
                        // Slots in this bunk's division grid that overlap the special's time
                        // (for the slot-based isFieldLocked check); startMin/endMin drive the
                        // cross-division isFieldLockedByTime check regardless.
                        const grid = _slDT[div] || [];
                        const occ = [];
                        for (let i = 0; i < grid.length; i++) { const s = grid[i]; if (s && s.startMin != null && s.startMin < eM && s.endMin > sM) occ.push(i); }
                        if (!occ.length) occ.push(idx);
                        window.GlobalFieldLocks.lockField(locName, occ, { lockedBy: 'placed_special_facility', division: div, activity: 'Special: ' + act, startMin: sM, endMin: eM });
                        _slLocked++;
                    });
                });
                console.log('[STEP 6.95] 🔒 Locked ' + _slLocked + ' physical facilit(ies) for placed specials (blocks sports on a special\'s court)');
            }
        } catch (_e695) { console.warn('[STEP 6.95] special-facility lock pass failed:', _e695); }

        // =========================================================================
        // STEP 6.5: REMOVE SOLVER BLOCKS FOR SLOTS ALREADY FILLED BY SMART TILES
        // =========================================================================
        // Smart tile direct fills (e.g. Swim) write to scheduleAssignments via fillBlock,
        // but gap-detection blocks from Step 3.5 remain in the array. The solver would
        // overwrite those fills. Remove any block whose slot is already occupied.
        {
            const preFilt = schedulableSlotBlocks.length;
            for (let _fi = schedulableSlotBlocks.length - 1; _fi >= 0; _fi--) {
                const _fb = schedulableSlotBlocks[_fi];
                if (!_fb.bunk || !_fb.slots?.length) continue;
                const _ex = window.scheduleAssignments[_fb.bunk]?.[_fb.slots[0]];
                if (_ex && !_ex.continuation && !_ex._isTransition) {
                    const _act = (_ex._activity || _ex.field || '').toLowerCase().trim();
                    if (_act && _act !== 'free' && _act !== 'free play' && _act !== 'free (timeout)') {
                        schedulableSlotBlocks.splice(_fi, 1);
                    }
                }
            }
            const removed = preFilt - schedulableSlotBlocks.length;
            if (removed > 0) console.log(`[STEP 6.5] Filtered ${removed} blocks already filled by smart tiles / pinned events`);
        }

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
        // STEP 7.5: Last-ditch Free-slot fill (silent batched version)
        // The solver's deepFreeResolution + sameDayDuplicateSweep can leave some
        // blocks as Free even when activities are still available. Use
        // AutoFillSlot.autoFillSlotSilent — same picking logic as the per-cell
        // '⚡ Auto Fill' button (rainy-day-aware, rotation-aware, max-usage
        // aware), but writes to memory only. The optimizer saves once at the
        // end, so we avoid 75 sequential per-cell saves.
        // =========================================================================
        try {
            if (window.AutoFillSlot && typeof window.AutoFillSlot.autoFillSlotSilent === 'function') {
                const _allowedBunks = (function() {
                    if (!allowedDivisions || allowedDivisions.length === 0) return null;
                    const s = new Set();
                    allowedDivisions.forEach(d => {
                        (divisions[d]?.bunks || divisions[String(d)]?.bunks || []).forEach(b => s.add(b));
                    });
                    return s;
                })();
                // ★ FN-56: league periods keep their per-bunk slots EMPTY by design
                // (fillBlock stores matchups in leagueAssignments only; the grid
                // overlays them at render). This pass saw those nulls as "leftover
                // Free" and stuffed them with general activities — invisible under
                // the overlay, but they consumed real field capacity (blocking other
                // divisions from those fields at that hour) and polluted rotation
                // counts. Skip any slot whose division-time is a league period or
                // that has league matchups stored for its slot index.
                const _b2d75 = {};
                Object.keys(divisions || {}).forEach(d => ((divisions[d] && divisions[d].bunks) || []).forEach(b => { _b2d75[String(b)] = String(d); }));
                const _isLeagueSlot75 = (bunk, si) => {
                    const d = _b2d75[String(bunk)];
                    if (!d) return false;
                    const ds = window.divisionTimes?.[d];
                    const sl = Array.isArray(ds) ? ds[si] : null;
                    if (sl && (sl.type === 'league' || sl.type === 'specialty_league')) return true;
                    const la = window.leagueAssignments?.[d]?.[si];
                    return !!(la && Array.isArray(la.matchups) && la.matchups.length > 0);
                };
                const _freeFills = [];
                let _lgSkipped75 = 0;
                Object.keys(window.scheduleAssignments || {}).forEach(bunk => {
                    if (_allowedBunks && !_allowedBunks.has(bunk)) return;
                    const arr = window.scheduleAssignments[bunk] || [];
                    for (let si = 0; si < arr.length; si++) {
                        const e = arr[si];
                        if (_isLeagueSlot75(bunk, si)) { _lgSkipped75++; continue; }
                        if (!e) { _freeFills.push({ bunk, si }); continue; }
                        if (e.continuation || e._isTransition || e._fixed || e._pinned || e._h2h || e._bunkOverride) continue;
                        const actLower = String(e._activity || e.field || e.sport || '').toLowerCase().trim();
                        if (actLower === 'free' || actLower === 'free play' || actLower === 'free (timeout)' || actLower === '') {
                            _freeFills.push({ bunk, si });
                        }
                    }
                });
                if (_lgSkipped75 > 0) console.log(`[STEP 7.5] FN-56: left ${_lgSkipped75} league-period slot(s) alone`);
                // ★ Build a reliable (bunk|slotIdx) → tile-kind map from the schedulable
                //   blocks. The solver stamps _slotKind on these from the raw skeleton
                //   event, so it is authoritative — divisionTimes' slot.event is not
                //   always "Sports Slot" here, which would let the free-fill drop a
                //   special into a Sports tile. We hand the kind to autoFillSlotSilent
                //   directly so a Sports tile only takes sports (a Special tile only
                //   specials); 'any' / missing keeps the prior either-or behavior.
                const _kindByCell75 = {};
                schedulableSlotBlocks.forEach(b => {
                    if (!b || !b._slotKind || b._slotKind === 'any' || !Array.isArray(b.slots)) return;
                    b.slots.forEach(si => { _kindByCell75[String(b.bunk) + '|' + si] = b._slotKind; });
                });
                if (_freeFills.length) {
                    console.log(`[STEP 7.5] Silent fallback: ${_freeFills.length} leftover Free slots`);
                    let _ffOk = 0, _ffSkip = 0;
                    for (const ff of _freeFills) {
                        try {
                            const _ffKind = _kindByCell75[String(ff.bunk) + '|' + ff.si];
                            const ok = window.AutoFillSlot.autoFillSlotSilent(ff.bunk, ff.si, _ffKind);
                            if (ok) _ffOk++; else _ffSkip++;
                        } catch (e) {
                            _ffSkip++;
                        }
                    }
                    console.log(`[STEP 7.5] Silent fallback: filled ${_ffOk} / ${_freeFills.length} (skipped ${_ffSkip})`);
                }
            } else {
                console.log('[STEP 7.5] AutoFillSlot.autoFillSlotSilent not available — skipping fallback fill');
            }
        } catch (_e) {
            console.warn('[STEP 7.5] Free-slot fallback failed:', _e);
        }

        // =========================================================================
        // STEP 7.55: Room-capacity / sharing demote sweep (manual analog of auto FN-19/21)
        // The manual special-placement path counts capacity per the special's OWN
        // sharing config. When two specials map to ONE physical room with different
        // caps (e.g. "Arts & Crafts 3" not_sharable cap-1 + "Arts and Crafts 3"
        // same_division cap-2 both at room "Arts and Crafts 3"), it can place 2 bunks
        // via the laxer twin — which the auto validator (location-keyed, most-
        // restrictive) then flags as a capacity violation. This DEMOTE-ONLY sweep
        // resolves each room EXACTLY as auto_validator.buildFieldSharingMap does
        // (facility-field precedence, then the FIRST special per location wins) and
        // demotes any occupant beyond the room's capacity / sharing rule → Free (STEP
        // 7.6 below then re-fills). _league / _postEdit / _pinned are user-locked: they
        // COUNT toward capacity but are never demoted. Runs on the FINAL schedule.
        // =========================================================================
        try {
            var _rsa = window.scheduleAssignments || {};
            var _rdivs = window.divisions || {};
            var _rb2g = {}; Object.keys(_rdivs).forEach(function (g) { ((_rdivs[g] && _rdivs[g].bunks) || []).forEach(function (b) { _rb2g[String(b)] = g; }); });
            var _rgs = window.loadGlobalSettings ? window.loadGlobalSettings() : (window.globalSettings || {});
            // Build room config the SAME way auto_validator.buildFieldSharingMap does so
            // the generator and validator agree: facility-field precedence, then the first
            // special per location wins; orphan custom→same_division, all→same_division.
            var _rcfg = {};
            function _rnorm(sw) {
                var ty = (sw && sw.type) || 'not_sharable';
                var dv = (sw && Array.isArray(sw.divisions)) ? sw.divisions : [];
                if (ty === 'custom' && dv.length === 0) ty = 'same_division';
                if (ty === 'all') ty = 'same_division';
                return { type: ty, cap: parseInt(sw && sw.capacity) || (ty === 'not_sharable' ? 1 : 2), pairs: (sw && sw.allowedPairs) || {}, divs: dv };
            }
            ((_rgs.app1 && _rgs.app1.fields) || _rgs.fields || []).forEach(function (f) {
                if (!f || !f.name) return;
                _rcfg[String(f.name).toLowerCase().trim()] = _rnorm(f.sharableWith || {});
            });
            // Map each special NAME → its physical FACILITY (location). This camp duplicates
            // specials cap/lowercase where the dup's own .location is blank, so resolve
            // case-insensitively and let the FIRST entry that carries a location win (the
            // getLocationForActivity lesson). Used below to bucket room-sharing specials
            // (Arts & Crafts + Leather → "Arts & Crafts Shack") under ONE facility key so the
            // sweep can see they collide — they are tracked by NAME everywhere else.
            var _specLocByName = {};
            ((_rgs.app1 && _rgs.app1.specialActivities) || _rgs.specialActivities || []).forEach(function (s) {
                if (!s || !s.name) return;
                var _snm = String(s.name).toLowerCase().trim();
                var _sloc = s.location ? String(s.location).toLowerCase().trim() : '';
                if (_sloc && !_specLocByName[_snm]) _specLocByName[_snm] = _sloc;
                var key = String(s.location || s.name).toLowerCase().trim();
                if (_rcfg[key]) return; // field precedence + first-special-per-location wins (matches validator)
                _rcfg[key] = _rnorm(s.sharableWith || {});
            });
            var _rskip = { 'free': 1, 'no field': 1, 'lunch': 1, 'snacks': 1, 'dismissal': 1, 'swim': 1, 'pool': 1, 'custom': 1, 'transition': 1, 'buffer': 1, 'canteen': 1, 'mincha': 1, 'davening': 1, 'lineup': 1, 'change': 1, 'cleanup': 1, 'main activity': 1 };
            var _rdt = window.divisionTimes || {};
            // Resolve a slot's window. Per-bunk geometry first (window durable copy, then
            // divisionTimes._perBunkSlots — what auto_validator reads), THEN the entry's own
            // _startMin. The entry fallback is essential DURING generation: at sweep time the
            // per-bunk grid (divisionTimes._perBunkSlots) is often not finalized yet, but the entry
            // already carries its real placement time, which is exactly what the grid settles to —
            // so the validator (post-settle) and the sweep (mid-gen) agree. Without it the sweep
            // falls to coarse division-level period times and misses real overlaps (e.g. a
            // cross-grade staggered share that the validator then flags). Division-level last.
            function _rtime(bunk, grade, idx, e) {
                var pbs = (window._perBunkSlots && window._perBunkSlots[grade] && window._perBunkSlots[grade][bunk])
                    || (_rdt[grade] && _rdt[grade]._perBunkSlots && _rdt[grade]._perBunkSlots[bunk]);
                if (pbs && pbs[idx] && pbs[idx].startMin != null) return { s: pbs[idx].startMin, e: pbs[idx].endMin };
                if (e && e._startMin != null && e._endMin != null) return { s: e._startMin, e: e._endMin };
                var ds = _rdt[grade]; if (ds && ds[idx] && ds[idx].startMin != null) return { s: ds[idx].startMin, e: ds[idx].endMin };
                return null;
            }
            function _rCrossOk(grade, others, pairs) {
                if (!pairs) return false;
                for (var i = 0; i < others.length; i++) {
                    if (grade === others[i]) continue;
                    var ok = (pairs[grade] && pairs[grade][others[i]]) || (pairs[others[i]] && pairs[others[i]][grade]);
                    if (!ok) return false;
                }
                return true;
            }
            var _rbyLoc = {};
            Object.keys(_rsa).forEach(function (bunk) {
                var slots = _rsa[bunk]; if (!Array.isArray(slots)) return;
                var g = _rb2g[String(bunk)] || '?';
                slots.forEach(function (e, idx) {
                    if (!e || e.continuation) return;
                    // ★★★ CB-8 (manual twin of FN-59): a Trip is OFF-SITE — it
                    // occupies no on-campus field, so it must not participate in
                    // the room-capacity / anti-stagger sweep. Including it let
                    // the sweep treat N bunks on one trip as N occupants of a
                    // cap-1 "field" and demote all but one bunk's trip to Free
                    // (then STEP 7.6 refilled them with on-campus sports),
                    // collapsing a whole division's trip. Skip trip entries —
                    // matching auto_validator.buildFieldUsageIndex (FN-59).
                    if (e._isTrip || (e.type || '').toLowerCase() === 'trip') return;
                    // ★ Field-less direct-fill label (Swim / Pickleball rotation option with no
                    //   configured field). Same shape of problem as a Trip above: its `field` is a
                    //   display label, not a bookable room, so N bunks on the SAME label are NOT N
                    //   occupants of one cap-1 room. fillBlock stamps _noRoomCap on these; skip them
                    //   here so they aren't demoted → Free → refilled with generic sports. Their own
                    //   real-world cap (e.g. 2 pickleball nets) is enforced at placement time by the
                    //   smart-tile direct-fill claim tracker, not by this room sweep.
                    if (e._noRoomCap) return;
                    // Bucket by PHYSICAL FACILITY, not activity NAME. A special's .field holds
                    // its display name; two different specials sharing one room (Arts & Crafts +
                    // Leather → "Arts & Crafts Shack") otherwise land in separate name-keyed
                    // buckets and never get compared. Sports/labels aren't specials → resolve to
                    // '' → fall back to .field (the real bookable field). PASS 0 below uses _actId.
                    var _actId = String(e._activity || e._assignedSpecial || e.field || '').toLowerCase().trim();
                    var _fieldLc = String(e.field || '').toLowerCase().trim();
                    var _facLc = (_actId && _specLocByName[_actId]) || (_fieldLc && _specLocByName[_fieldLc]) || '';
                    var fl = _facLc || _fieldLc || String(e._specialLocation || '').toLowerCase().trim();
                    // NOTE: do NOT skip rooms missing from _rcfg. auto_validator defaults any
                    // field it can't resolve to {not_sharable, cap 1} and flags it — most often
                    // a misspelled/duplicate special whose NAME (written into .field) differs
                    // from its location key (e.g. "Accesorize" name vs "Accessorize" location).
                    // Skipping those let the exact bug we are fixing slip through, so we include
                    // them and default to cap-1 below, matching the validator.
                    if (!fl || _rskip[fl] || /^game\s*\d+$/i.test(fl)) return;
                    var t = _rtime(bunk, g, idx, e); if (!t || t.s == null || t.e == null) return;
                    var prot = !!(e._league || e._postEdit || e._pinned || e._bunkOverride);
                    (_rbyLoc[fl] = _rbyLoc[fl] || []).push({ bunk: bunk, grade: g, idx: idx, s: t.s, e: t.e, dur: t.e - t.s, prot: prot, act: _actId });
                });
            });
            var _rdemoted = 0, _rstag = 0, _rcap = 0, _rfac = 0;
            function _rlive(u) { var c = _rsa[u.bunk] && _rsa[u.bunk][u.idx]; return c && c.field !== 'Free'; }
            function _rdemote(u) {
                if (!_rlive(u) || u.prot) return false; // never demote user-locked (league/post-edit/pinned/bunk-override)
                // Preserve the slot's start/end so the STEP 7.6 free-fill below can resolve
                // its time and refill it (without these the slot reads as time-null and is skipped).
                _rsa[u.bunk][u.idx] = { field: 'Free', sport: null, _activity: 'Free', _startMin: u.s, _endMin: u.e, _fixed: true, _constraintDemoted: true, _demotedReason: 'manual_room_cap', continuation: false };
                var sl = _rsa[u.bunk];
                for (var k = u.idx + 1; k < sl.length; k++) { if (sl[k] && sl[k].continuation) { sl[k] = { field: 'Free', sport: null, _activity: 'Free', _fixed: true, _constraintDemoted: true, continuation: false }; } else break; }
                _rdemoted++; return true;
            }
            // ★ PER-DATE BUNK-ONLY RESTRICTION sweep (Daily Adjustments → Resources →
            //   Bunk-Only Access). Demote any special/sport a bunk received that is
            //   reserved for OTHER bunk(s) on this facility today. This is the safety
            //   net for the SmartTile budget/rotation pool, which assigns specials to
            //   bunks WITHOUT consulting canBlockFit (so the field/auto gates miss it).
            //   Freed slots flow into the STEP 7.6/7.65 refill below (which honor the
            //   same restriction), so the bunk gets an allowed activity instead.
            //   Protected slots (league/pinned/override) are never demoted.
            (function _brRestrictionSweep() {
                var _brFn = window.SchedulerCoreUtils && window.SchedulerCoreUtils.isBunkRestrictedFromTarget;
                if (typeof _brFn !== 'function') return;
                var _brN = 0;
                Object.keys(_rbyLoc).forEach(function (fl) {
                    _rbyLoc[fl].forEach(function (u) {
                        if (!_rlive(u) || u.prot) return;
                        var _ent = _rsa[u.bunk] && _rsa[u.bunk][u.idx];
                        var _act = u.act || (_ent && (_ent._activity || _ent._assignedSpecial || _ent.field)) || '';
                        var _restricted = false;
                        try { _restricted = _brFn(u.bunk, _act, fl, u.grade); } catch (_e) {}
                        if (_restricted && _rdemote(u)) {
                            _brN++;
                            console.log('[STEP 7.55] 🔒 Bunk-only restriction: demoted ' + u.bunk + ' off "' + _act + '" @ ' + fl + ' (reserved for other bunk(s) today)');
                        }
                    });
                });
                if (_brN) console.log('[STEP 7.55] 🔒 Bunk-only restriction: removed ' + _brN + ' placement(s) reserved for other bunk(s)');
            })();
            Object.keys(_rbyLoc).forEach(function (fl) {
                // Unknown room → not_sharable cap-1, exactly as auto_validator defaults it.
                var cfg = _rcfg[fl] || { type: 'not_sharable', cap: 1, pairs: {}, divs: [] };
                var arr = _rbyLoc[fl];
                // PASS 0 — facility single-activity: a physical room hosts ONE activity at a
                //   time. Occupancy here is keyed by resolved FACILITY, so two DIFFERENT
                //   specials that share one room (Arts & Crafts + Leather → "Arts & Crafts
                //   Shack" — tracked by NAME everywhere else, so each booked the room
                //   independently) land in this one bucket. Keep the dominant activity; demote
                //   overlapping occupants of any OTHER activity → Free, regardless of capacity
                //   (a room can't run two different activities at once). For self-named/self-
                //   located specials and sports every occupant shares one activity id, so this
                //   never fires. STEP 7.6/7.65 below re-fill what is freed here.
                (function () {
                    var distinctActs = {};
                    arr.forEach(function (u) { if (_rlive(u) && u.act) distinctActs[u.act] = 1; });
                    if (Object.keys(distinctActs).length < 2) return;
                    var byAct = {};
                    arr.forEach(function (u) { if (_rlive(u) && u.act) (byAct[u.act] = byAct[u.act] || []).push(u); });
                    // Rank activities to choose which one keeps the room: protected (league/
                    // pinned) first, then the activity with the most occupants, then earliest
                    // start, then name (deterministic). The top-ranked activity is never demoted.
                    var order = Object.keys(byAct).sort(function (a, b) {
                        var pa = byAct[a].some(function (x) { return x.prot; }) ? 1 : 0;
                        var pb = byAct[b].some(function (x) { return x.prot; }) ? 1 : 0;
                        if (pa !== pb) return pb - pa;
                        if (byAct[a].length !== byAct[b].length) return byAct[b].length - byAct[a].length;
                        var sa = Math.min.apply(null, byAct[a].map(function (x) { return x.s; }));
                        var sb = Math.min.apply(null, byAct[b].map(function (x) { return x.s; }));
                        if (sa !== sb) return sa - sb;
                        return String(a).localeCompare(String(b));
                    });
                    var actRank = {}; order.forEach(function (a, i) { actRank[a] = i; });
                    for (var i = 0; i < arr.length; i++) {
                        var u = arr[i]; if (!_rlive(u) || !u.act || u.prot) continue;
                        for (var j = 0; j < arr.length; j++) {
                            if (j === i) continue;
                            var o = arr[j];
                            if (!_rlive(o) || !o.act || o.act === u.act) continue;
                            // u overlaps a higher-ranked activity's occupant → demote u (the loser).
                            if (o.s < u.e && o.e > u.s && actRank[o.act] < actRank[u.act]) { if (_rdemote(u)) _rfac++; break; }
                        }
                    }
                })();
                // PASS 1 — anti-stagger: among OVERLAPPING occupants keep the protected/
                //   longest/earliest as primary; demote any non-protected overlapper whose
                //   [start,end] differs (so the rest share one aligned window).
                arr.sort(function (a, b) { return (b.prot - a.prot) || (b.dur - a.dur) || (a.s - b.s) || (a.idx - b.idx); });
                for (var i = 0; i < arr.length; i++) {
                    var u = arr[i]; if (!_rlive(u)) continue;
                    for (var j = 0; j < arr.length; j++) {
                        if (j === i) continue;
                        var o = arr[j]; if (o.bunk === u.bunk || !_rlive(o)) continue;
                        if (o.s < u.e && o.e > u.s && (o.s !== u.s || o.e !== u.e)) { if (_rdemote(o)) _rstag++; }
                    }
                }
                // PASS 2 — capacity + sharing-type on identical-window groups.
                var groups = {};
                arr.forEach(function (u) { if (!_rlive(u)) return; var key = u.s + '-' + u.e; (groups[key] = groups[key] || []).push(u); });
                Object.keys(groups).forEach(function (key) {
                    var grp = groups[key].sort(function (a, b) { return (b.prot - a.prot) || (a.idx - b.idx) || String(a.bunk).localeCompare(String(b.bunk)); });
                    var st = cfg.type, pairs = cfg.pairs, dv = cfg.divs;
                    var capMax = (st === 'not_sharable') ? 1 : (cfg.cap || 1);
                    var kept = [];
                    grp.forEach(function (u) {
                        if (!_rlive(u)) return;
                        var ok = kept.length < capMax;
                        if (ok && kept.length > 0) {
                            var kg = kept.map(function (x) { return x.grade; });
                            if (st === 'not_sharable') ok = false;
                            else if (st === 'same_division') { if (kg.some(function (gg) { return gg !== u.grade; })) ok = false; }
                            else if (st === 'cross_division') { if (!_rCrossOk(u.grade, kg, pairs)) ok = false; }
                            else if (st === 'custom') { if (dv.length > 0) { if (dv.indexOf(u.grade) < 0 || kg.some(function (gg) { return dv.indexOf(gg) < 0; })) ok = false; } else if (kg.some(function (gg) { return gg !== u.grade; })) ok = false; }
                        }
                        if (ok || u.prot) kept.push(u); else { if (_rdemote(u)) _rcap++; }
                    });
                });
            });
            if (_rdemoted > 0) console.log('[STEP 7.55] room-capacity sweep: demoted ' + _rdemoted + ' (' + _rstag + ' staggered, ' + _rcap + ' over-cap/cross-grade, ' + _rfac + ' facility-conflict) placement(s) → Free');
            else console.log('[STEP 7.55] room-capacity sweep: ✅ no room-capacity/staggered violations');
        } catch (_e755) { console.warn('[STEP 7.55] room-capacity sweep failed:', _e755); }

        // =========================================================================
        // STEP 7.56: Validator-backed repair — the authoritative pass.
        // STEP 7.55 re-derives slot geometry to find violations, which can disagree
        // with the validator (different time source / not-yet-finalized per-bunk grid),
        // so it occasionally misses a staggered/cross-grade share the validator later
        // flags. This pass instead consumes auto_validator's OWN output: loop calling
        // validateAutoSchedule(), and for every error it reports, demote one offending
        // (non-user-locked) placement to Free, until the validator returns 0 errors.
        // Because it demotes exactly what the validator flags, the two cannot disagree.
        // The STEP 7.6 free-fill below then refills everything freed here.
        // =========================================================================
        try {
            // STEP 7.56 DISABLED: calling validateAutoSchedule() inline reads pre-settle slot
            // geometry (the per-bunk grid is finalized ~100ms AFTER generation by the slot-resize),
            // so it both misses real violations and risks demoting on false positives. The
            // authoritative pass is the post-settle capacity-repair gate in daily_adjustments.js,
            // which runs after the geometry finalizes. Keeping the block gated-off (not deleted)
            // to minimise churn in this hot generation path.
            if (false) {
                const _sa77 = window.scheduleAssignments || {};
                const _d77 = window.divisions || {};
                const _b2g77 = {}; Object.keys(_d77).forEach(g => ((_d77[g] && _d77[g].bunks) || []).forEach(b => { _b2g77[String(b)] = g; }));
                const _isProt77 = (e) => !!(e && (e._league || e._postEdit)); // user-locked: never auto-demote
                const _findSlot77 = (bunk, fieldName, grade) => {
                    const arr = _sa77[bunk] || []; const fl = String(fieldName || '').toLowerCase().trim();
                    for (let i = 0; i < arr.length; i++) {
                        const e = arr[i];
                        if (e && !e.continuation && e.field !== 'Free' && !_isProt77(e)
                            && String(e.field || e._specialLocation || '').toLowerCase().trim() === fl) return i;
                    }
                    return -1;
                };
                const _demote77 = (bunk, idx, reason) => {
                    const e = _sa77[bunk] && _sa77[bunk][idx];
                    if (!e || e.field === 'Free' || _isProt77(e)) return false;
                    const sm = e._startMin, em = e._endMin;
                    _sa77[bunk][idx] = { field: 'Free', sport: null, _activity: 'Free', _startMin: sm, _endMin: em, _fixed: true, _constraintDemoted: true, _demotedReason: reason, continuation: false };
                    const sl = _sa77[bunk];
                    for (let k = idx + 1; k < sl.length; k++) { if (sl[k] && sl[k].continuation) { sl[k] = { field: 'Free', _activity: 'Free', _fixed: true, continuation: false }; } else break; }
                    return true;
                };
                let _repaired77 = 0;
                for (let _pass = 0; _pass < 8; _pass++) {
                    let v77 = null;
                    try { v77 = window.validateAutoSchedule({ silent: true }); } catch (_ev) { break; }
                    const errs = (v77 && (v77.errors || v77.violations)) || [];
                    if (!errs.length) break;
                    let didDemote = false;
                    for (let ei = 0; ei < errs.length; ei++) {
                        const er = errs[ei]; if (!er || !er.field) continue;
                        // Offender bunks: structured er.bunks (cross_division/staggered) else
                        // all bunks of er.grade on er.field (capacity).
                        let offBunks = [];
                        if (Array.isArray(er.bunks) && er.bunks.length) offBunks = er.bunks.map(x => x && x.bunk).filter(Boolean);
                        else Object.keys(_sa77).forEach(b => { if (er.grade && _b2g77[String(b)] !== er.grade) return; if (_findSlot77(b, er.field) >= 0) offBunks.push(b); });
                        // Demote ONE demotable offender (prefer the later one); the loop re-checks.
                        for (let oi = offBunks.length - 1; oi >= 0; oi--) {
                            const si = _findSlot77(offBunks[oi], er.field);
                            if (si >= 0 && _demote77(offBunks[oi], si, 'vrepair_' + er.type)) { _repaired77++; didDemote = true; break; }
                        }
                    }
                    if (!didDemote) break; // every remaining offender is user-locked — stop (can't fix without overriding a pin)
                }
                if (_repaired77 > 0) console.log('[STEP 7.56] validator-backed repair demoted ' + _repaired77 + ' placement(s) → Free');
                else console.log('[STEP 7.56] validator-backed repair: ✅ validator already clean');
            }
        } catch (_e77) { console.warn('[STEP 7.56] validator-backed repair failed:', _e77); }

        // =========================================================================
        // STEP 7.6: Empty-field free-fill (manual analog of auto FN-22)
        // STEP 7.5 (autoFillSlotSilent) skips any slot carrying _fixed / _pinned /
        // _bunkOverride — but a Free *skeleton* slot legitimately carries those flags
        // (they describe the slot's fixed time / bunk-override origin, NOT "keep empty"),
        // so those Free slots were never filled. This pass detects Free by the slot's
        // ACTIVITY (not its flags) and fills it with a bunk-accessible sport on a
        // COMPLETELY EMPTY field — conflict-free by construction (empty field = no
        // capacity / sharing / stagger risk), respecting access + no same-day repeat.
        // =========================================================================
        try {
            const _gs76 = window.loadGlobalSettings ? window.loadGlobalSettings() : (window.globalSettings || {});
            const _fields76 = (_gs76.app1 && _gs76.app1.fields) || _gs76.fields || [];
            const _divs76 = window.divisions || {};
            const _b2g76 = {};
            Object.keys(_divs76).forEach(g => ((_divs76[g] && _divs76[g].bunks) || []).forEach(b => { _b2g76[String(b)] = g; }));
            const _allowed76 = (function () {
                if (!allowedDivisions || allowedDivisions.length === 0) return null;
                const s = new Set();
                allowedDivisions.forEach(d => (divisions[d]?.bunks || divisions[String(d)]?.bunks || []).forEach(b => s.add(String(b))));
                return s;
            })();
            const _dt76 = window.divisionTimes || {};
            // Same per-bunk → entry → division resolution as _rtime above (see note there): the
            // entry fallback keeps the free-fill's occupancy view correct during generation, before
            // divisionTimes._perBunkSlots is finalized.
            const _stime76 = (bunk, grade, idx, e) => {
                const pbs = (window._perBunkSlots && window._perBunkSlots[grade] && window._perBunkSlots[grade][bunk])
                    || (_dt76[grade] && _dt76[grade]._perBunkSlots && _dt76[grade]._perBunkSlots[bunk]);
                if (pbs && pbs[idx] && pbs[idx].startMin != null) return { s: pbs[idx].startMin, e: pbs[idx].endMin };
                if (e && e._startMin != null && e._endMin != null) return { s: e._startMin, e: e._endMin };
                const ds = _dt76[grade]; if (ds && ds[idx] && ds[idx].startMin != null) return { s: ds[idx].startMin, e: ds[idx].endMin };
                return null;
            };
            // Resolve a slot's tile event label (per-bunk grid first, then division grid)
            // so this sport-only pass can leave Special-only slots untouched.
            const _slotEvent76 = (bunk, grade, idx, e) => {
                const pbs = (window._perBunkSlots && window._perBunkSlots[grade] && window._perBunkSlots[grade][bunk])
                    || (_dt76[grade] && _dt76[grade]._perBunkSlots && _dt76[grade]._perBunkSlots[bunk]);
                if (pbs && pbs[idx] && pbs[idx].event != null) return pbs[idx].event;
                const ds = _dt76[grade]; if (ds && ds[idx] && ds[idx].event != null) return ds[idx].event;
                return (e && e.event) || '';
            };
            // Authoritative tile-kind per (bunk|slotIdx) from the schedulable blocks
            // (solver-stamped _slotKind) — divisionTimes' slot.event is not always the
            // raw label, so trust this first and fall back to the event guess.
            const _kindByCell76 = {};
            schedulableSlotBlocks.forEach(b => {
                if (!b || !b._slotKind || b._slotKind === 'any' || !Array.isArray(b.slots)) return;
                b.slots.forEach(si => { _kindByCell76[String(b.bunk) + '|' + si] = b._slotKind; });
            });
            const _skip76 = { 'free': 1, 'free play': 1, 'free (timeout)': 1, 'no field': 1, 'lunch': 1, 'snacks': 1, 'dismissal': 1, 'swim': 1, 'pool': 1, 'change': 1, 'cleanup': 1, 'main activity': 1, 'lineup': 1, 'transition': 1, 'buffer': 1, 'davening': 1, 'mincha': 1 };
            const _specialRooms76 = {};
            ((_gs76.app1 && _gs76.app1.specialActivities) || []).forEach(s => { if (s && s.location) _specialRooms76[String(s.location).toLowerCase().trim()] = 1; });
            // ★ Today's Resource disables (Daily Adjustments → Resources). This leftover-
            //   Free-slot backfill targets EMPTY fields — and a field disabled for today is
            //   empty precisely BECAUSE the solver avoided it, so without these gates the
            //   backfill re-fills the very fields/sports/specials the user shut off.
            //   currentDisabledFields includes special-activity LOCATIONS too (disabling a
            //   facility adds its name). Union with the date-fresh daily overrides for safety.
            const _curDaily76 = window.loadCurrentDailyData?.() || {};
            const _disabledLc76 = new Set([
                ...(window.currentDisabledFields || []),
                ...(((_curDaily76.overrides || {}).disabledFields) || [])
            ].map(n => String(n).toLowerCase().trim()));
            const _disSportsByField76 = _curDaily76.dailyDisabledSportsByField || {};
            const _disabledSpecialsLc76 = new Set((((_curDaily76.overrides || {}).disabledSpecials) || []).map(n => String(n).toLowerCase().trim()));
            const _sportFields76 = _fields76.filter(f => f && f.name && f.available !== false
                && !_disabledLc76.has(String(f.name).toLowerCase().trim())
                && !_specialRooms76[String(f.name).toLowerCase().trim()]
                && Array.isArray(f.activities) && f.activities.length
                && !(f.timeRules && f.timeRules.enabled));
            const _access76 = (f, grade) => {
                const ar = f.accessRestrictions;
                if (!ar || !ar.enabled) return true;
                const dvs = ar.divisions || {};
                if (Object.keys(dvs).length === 0) return true;
                return !!dvs[grade];
            };
            // occupancy index + per-bunk today's activities (from the FINAL schedule)
            const _occ76 = {}, _done76 = {};
            const _sa76 = window.scheduleAssignments || {};
            Object.keys(_sa76).forEach(b => {
                const g = _b2g76[String(b)] || '?'; _done76[b] = {};
                (_sa76[b] || []).forEach((e, idx) => {
                    if (!e || e.continuation) return;
                    const a = e._activity || e.sport; if (a && String(a).toLowerCase() !== 'free') _done76[b][String(a).toLowerCase()] = 1;
                    const fl = String(e.field || e._specialLocation || '').toLowerCase().trim();
                    if (!fl || _skip76[fl]) return;
                    const t = _stime76(b, g, idx, e); if (!t) return;
                    (_occ76[fl] = _occ76[fl] || []).push({ s: t.s, e: t.e });
                });
            });
            const _fieldFree76 = (fl, s, e) => { const arr = _occ76[fl] || []; for (let i = 0; i < arr.length; i++) { if (arr[i].s < e && arr[i].e > s) return false; } return true; };
            // ★ PINNED-FACILITY GUARD (custom-pinned exclusion). A custom pinned
            //   tile globally locks every facility it reserves for its FULL
            //   [startMin,endMin] window (STEP 3 → GlobalFieldLocks,
            //   lockedBy:'pinned_event_location'). These free-fill passes index
            //   occupancy by entry.field, but a pinned tile stores its EVENT NAME in
            //   .field and the real facilities in _reservedFields/_location — so
            //   _fieldFree76/_occL65 are BLIND to them and would otherwise drop a
            //   sport/special onto a pinned-reserved facility. The pinned lock is a
            //   GLOBAL lock, so isFieldLockedByTime blocks EVERY grade (only elective
            //   division-locks exempt their own grade) for any overlapping time —
            //   exactly the rule "nothing but another custom pinned tile may share a
            //   reserved facility within its window". Mirrors the STEP 7.5 gate
            //   (auto_fill_slot isFieldGloballyLocked) and the solver's own check.
            const _fieldPinLocked76 = (fieldName, s, e, g) => {
                try {
                    return !!(window.GlobalFieldLocks && window.GlobalFieldLocks.isFieldLockedByTime
                        && window.GlobalFieldLocks.isFieldLockedByTime(fieldName, s, e, g));
                } catch (_) { return false; }
            };
            // ★★★ CB-39: real per-slot timeRules availability gate. The candidate
            // filter above uses `!(f.timeRules && f.timeRules.enabled)`, which is
            // ALWAYS true (timeRules is an array and never has `.enabled`), so the
            // free-fill would place a sport on a field inside its Unavailable
            // window (or outside its Available windows). This mirrors the auto
            // FN-22 gate (scheduler_core_auto.js ~L19049): an Unavailable rule
            // overlapping [s,e) blocks the field; if any Available rules exist, the
            // slot must sit fully inside one of them.
            const _fieldTimeOk76 = (f, s, e) => {
                const rules = Array.isArray(f.timeRules) ? f.timeRules : null;
                if (!rules || rules.length === 0) return true;
                let hasAvail = false, insideAvail = false;
                for (let i = 0; i < rules.length; i++) {
                    const r = rules[i]; if (!r) continue;
                    const rs = (r.startMin != null) ? r.startMin : null;
                    const re = (r.endMin != null) ? r.endMin : null;
                    const isUnavail = String(r.type).toLowerCase() === 'unavailable' || r.available === false;
                    if (isUnavail) {
                        if (rs != null && re != null && rs < e && re > s) return false;
                    } else {
                        hasAvail = true;
                        if (rs != null && re != null && s >= rs && e <= re) insideAvail = true;
                    }
                }
                if (hasAvail && !insideAvail) return false;
                return true;
            };
            let _filled76 = 0;
            Object.keys(_sa76).forEach(b => {
                if (_allowed76 && !_allowed76.has(String(b))) return;
                const g = _b2g76[String(b)] || '?'; const arr = _sa76[b] || [];
                arr.forEach((e, idx) => {
                    if (!e || e.continuation || e._isTransition || e._league || e._h2h) return;
                    const a = String((e._activity || e.field || e.sport || '')).toLowerCase().trim();
                    // Free detected by ACTIVITY, regardless of _fixed/_pinned/_bunkOverride flags.
                    if (!(a === '' || a === 'free' || a === 'free play' || a === 'free (timeout)')) return;
                    // ★ A Special-only tile must never be sport-filled — leave it Free
                    //   (STEP 7.5 already offered it specials).
                    const _ck76 = _kindByCell76[String(b) + '|' + idx];
                    if (_ck76 === 'special' || (!_ck76 && slotKindOf(_slotEvent76(b, g, idx, e)) === 'special')) return;
                    const t = _stime76(b, g, idx, e); if (!t || t.s == null || t.e == null) return;
                    for (let fi = 0; fi < _sportFields76.length; fi++) {
                        const f = _sportFields76[fi]; const fl = String(f.name).toLowerCase().trim();
                        if (_skip76[fl] || !_fieldFree76(fl, t.s, t.e) || !_access76(f, g) || !_fieldTimeOk76(f, t.s, t.e) || _fieldPinLocked76(f.name, t.s, t.e, g)) continue;
                        let act = null;
                        const _blockedOnField76 = _disSportsByField76[f.name] || null;
                        for (let ai = 0; ai < f.activities.length; ai++) { const c = f.activities[ai]; if (c && !_done76[b][String(c).toLowerCase()] && !(_blockedOnField76 && _blockedOnField76.indexOf(c) !== -1)) { act = c; break; } }
                        if (!act) continue;
                        _sa76[b][idx] = { field: f.name, sport: act, _activity: act, _startMin: t.s, _endMin: t.e, _fixed: true, _freeFilled: true, continuation: false };
                        (_occ76[fl] = _occ76[fl] || []).push({ s: t.s, e: t.e });
                        _done76[b][String(act).toLowerCase()] = 1; _filled76++;
                        break;
                    }
                });
            });
            if (_filled76 > 0) console.log(`[STEP 7.6] Empty-field free-fill: filled ${_filled76} Free slot(s) with sports on empty fields`);
            else console.log('[STEP 7.6] Empty-field free-fill: no fillable Free slots');

            // ─────────────────────────────────────────────────────────────
            // STEP 7.62: Min-share pairing — FORM a shared game from leftover
            // under-min Free bunks. When a sport's minPlayers is set above a
            // single bunk's size (the user does this deliberately to FORCE two
            // bunks into one real game), the solver leaves each bunk Free: no
            // single bunk can seed the game (it's under min), and the solver's
            // min-repair only ADDS a partner to an already-placed game — with
            // nothing placed, there's no seed, so the pair never forms. This
            // pass creates the pair from scratch: it groups same-division Free
            // bunks at the SAME time onto an empty, accessible field for a sport
            // none of them did today, choosing up to the field's bunk-capacity
            // so the combined size meets the sport's min and stays within its
            // max (+2 grace). Legal by construction (empty field, one sport, one
            // division, no repeat, min/max + capacity honored) → no conflict.
            // ─────────────────────────────────────────────────────────────
            try {
                const _spMeta62 = (window.getSportMetaData && window.getSportMetaData()) || {};
                const _bMeta62 = (window.getBunkMetaData && window.getBunkMetaData()) || {};
                const _sizeOf62 = (b) => (_bMeta62[b] && _bMeta62[b].size) || 0;
                const _reqOf62 = (act) => { const m = _spMeta62[act] || {}; return { min: m.minPlayers || 0, max: m.maxPlayers || 0 }; };
                const _capOf62 = (f) => { const sw = f.sharableWith || {}; const ty = sw.type || 'not_sharable'; if (ty === 'not_sharable') return 1; return parseInt(sw.capacity) || 2; };
                const _isFree62 = (e) => { const a = String((e && (e._activity || e.field || e.sport)) || '').toLowerCase().trim(); return a === '' || a === 'free' || a === 'free play' || a === 'free (timeout)'; };
                // Group sport-fillable Free slots by division|start|end (only co-timed,
                // same-division bunks can legally share). Special-only tiles are excluded.
                const _grp62 = {};
                Object.keys(_sa76).forEach(b => {
                    if (_allowed76 && !_allowed76.has(String(b))) return;
                    const g = _b2g76[String(b)] || '?';
                    (_sa76[b] || []).forEach((e, idx) => {
                        if (!e || e.continuation || e._isTransition || e._league || e._h2h || !_isFree62(e)) return;
                        const ck = _kindByCell76[String(b) + '|' + idx];
                        const kind = (ck && ck !== 'any') ? ck : slotKindOf(_slotEvent76(b, g, idx, e));
                        if (kind === 'special') return; // a special-only tile can't take a sport
                        // The entry's own stamped time is authoritative for the sub-slot grid.
                        const s = (e._startMin != null) ? e._startMin : null, en = (e._endMin != null) ? e._endMin : null;
                        let t = (s != null && en != null) ? { s: s, e: en } : _stime76(b, g, idx, e);
                        if (!t || t.s == null || t.e == null) return;
                        const key = g + '|' + t.s + '|' + t.e;
                        (_grp62[key] = _grp62[key] || []).push({ bunk: b, idx: idx, grade: g, s: t.s, e: t.e, size: _sizeOf62(b) });
                    });
                });
                let _paired62 = 0, _games62 = 0;
                Object.keys(_grp62).forEach(key => {
                    let pool = _grp62[key].slice();
                    if (pool.length < 2) return; // need ≥2 free bunks to form a share
                    const g = pool[0].grade, s = pool[0].s, en = pool[0].e;
                    for (let fi = 0; fi < _sportFields76.length && pool.length >= 2; fi++) {
                        const f = _sportFields76[fi]; const fl = String(f.name).toLowerCase().trim();
                        if (!_fieldFree76(fl, s, en) || !_access76(f, g) || !_fieldTimeOk76(f, s, en) || _fieldPinLocked76(f.name, s, en, g)) continue;
                        const cap = _capOf62(f); if (cap < 2) continue; // a 1-bunk field can't host a forced pair
                        const blocked = _disSportsByField76[f.name] || null;
                        for (let ai = 0; ai < (f.activities || []).length; ai++) {
                            const act = f.activities[ai];
                            if (blocked && blocked.indexOf(act) !== -1) continue;
                            const req = _reqOf62(act);
                            if (!req.min) continue; // only sports with a real min require forced pairing
                            const elig = pool.filter(p => !(_done76[p.bunk] && _done76[p.bunk][String(act).toLowerCase()]));
                            if (elig.length < 2) continue;
                            elig.sort((a, b2) => b2.size - a.size); // largest first to reach min fast
                            let chosen = [], sum = 0;
                            for (let k = 0; k < elig.length && chosen.length < cap; k++) {
                                const cand = elig[k];
                                if (req.max && (sum + cand.size) > req.max + 2) continue; // would bust max+2
                                chosen.push(cand); sum += cand.size;
                                if (sum >= req.min) break; // min satisfied — a legal shared game
                            }
                            if (chosen.length >= 2 && sum >= req.min && (!req.max || sum <= req.max + 2)) {
                                chosen.forEach(c => {
                                    _sa76[c.bunk][c.idx] = { field: f.name, sport: act, _activity: act, _startMin: s, _endMin: en, _fixed: true, _freeFilled: true, _minShareFilled: true, continuation: false };
                                    (_occ76[fl] = _occ76[fl] || []).push({ s: s, e: en });
                                    (_done76[c.bunk] = _done76[c.bunk] || {})[String(act).toLowerCase()] = 1;
                                });
                                _paired62 += chosen.length; _games62++;
                                const chosenSet = new Set(chosen.map(c => c.bunk));
                                pool = pool.filter(p => !chosenSet.has(p.bunk));
                                break; // this field is now occupied — move to the next field
                            }
                        }
                    }
                });
                if (_games62 > 0) console.log('[STEP 7.62] min-share pairing: formed ' + _games62 + ' shared game(s), seated ' + _paired62 + ' under-min bunk(s)');
                else console.log('[STEP 7.62] min-share pairing: no pairable under-min Free bunks');
            } catch (_e62) { console.warn('[STEP 7.62] min-share pairing failed:', _e62); }

            // ─────────────────────────────────────────────────────────────
            // STEP 7.65: No-repeat fill. The empty-field pass only seats a Free
            // bunk on a COMPLETELY EMPTY sport field, so a bunk whose only
            // remaining fresh option was sharing a grade-mate's half-full room —
            // or opening a fresh special room — was left Free. Seat every
            // still-Free bunk with an activity it has NOT done today: (0) share
            // an under-capacity SAME-GRADE location (sport OR special, matched to
            // the slot kind); (2) for a Special-Activity slot, open a
            // grade-accessible special on a free location. NEVER repeats an
            // activity and never displaces an existing placement. A bunk with no
            // fresh option left stays Free here rather than repeat (covering it
            // would require moving another bunk's activity). Every placement is
            // legal by construction (under the location's cap, same grade,
            // co-started, never not_sharable, access + time-rules pass).
            const _norm65 = (sw) => {
                let ty = (sw && sw.type) || 'not_sharable';
                const dv = (sw && Array.isArray(sw.divisions)) ? sw.divisions : [];
                if (ty === 'custom' && dv.length === 0) ty = 'same_division';
                if (ty === 'all') ty = 'same_division';
                return { type: ty, cap: parseInt(sw && sw.capacity) || (ty === 'not_sharable' ? 1 : 2), divs: dv };
            };
            // Location config + special metadata (field precedence, then the
            // first special per location — matches the STEP 7.55 sweep).
            const _loc65 = {}, _specByName65 = {};
            _fields76.forEach(f => { if (f && f.name) _loc65[String(f.name).toLowerCase().trim()] = _norm65(f.sharableWith || {}); });
            ((_gs76.app1 && _gs76.app1.specialActivities) || _gs76.specialActivities || []).forEach(s => {
                if (!s || !s.name) return;
                const nm = String(s.name).toLowerCase().trim();
                const loc = String(s.location || s.name).toLowerCase().trim();
                _specByName65[nm] = { name: s.name, loc: loc, locName: s.location || s.name };
                if (!_loc65[loc]) _loc65[loc] = _norm65(s.sharableWith || {});
            });
            const _isSpecial65 = (a) => !!_specByName65[String(a || '').toLowerCase().trim()];
            const _kindOf65 = (b, g, idx, e) => { const k = _kindByCell76[String(b) + '|' + idx]; return (k && k !== 'any') ? k : slotKindOf(_slotEvent76(b, g, idx, e)); };
            const _isFree65 = (e) => { const a = String((e && (e._activity || e.field || e.sport) || '')).toLowerCase().trim(); return a === '' || a === 'free' || a === 'free play' || a === 'free (timeout)'; };
            const _bunkNum65 = (bn) => { const m = String(bn || '').match(/(\d+)/); return m ? parseInt(m[1], 10) : Infinity; }; // leading bunk number, matches the solver's getBunkNumber
            // Occupancy by location from the post-empty-fill schedule.
            const _occL65 = {};
            Object.keys(_sa76).forEach(b => {
                const g = _b2g76[String(b)] || '?';
                (_sa76[b] || []).forEach((e, idx) => {
                    if (!e || e.continuation) return;
                    const fl = String(e.field || '').toLowerCase().trim();
                    if (!fl || _skip76[fl] || _disabledLc76.has(fl) || e.field === 'Free') return;
                    const act = e._activity || e.sport; if (!act || String(act).toLowerCase() === 'free') return;
                    const t = _stime76(b, g, idx, e); if (!t || t.s == null || t.e == null) return;
                    (_occL65[fl] = _occL65[fl] || []).push({ bunk: String(b), grade: g, act: act, s: t.s, e: t.e, field: e.field });
                });
            });
            const _occAt65 = (fl, s, e, self) => (_occL65[fl] || []).filter(o => o.bunk !== self && o.s < e && o.e > s);
            // Grade pool of today's specials — proves grade-accessibility for the backfill.
            const _gradeSpecials65 = {};
            Object.keys(_done76).forEach(b => { const g = _b2g76[String(b)]; if (!g) return; Object.keys(_done76[b] || {}).forEach(an => { if (_isSpecial65(an)) (_gradeSpecials65[g] = _gradeSpecials65[g] || {})[an] = 1; }); });
            const _seat65 = (b, idx, locName, act, s, e) => {
                const sp = _isSpecial65(act);
                _sa76[b][idx] = sp
                    ? { field: locName, sport: null, _activity: act, _specialLocation: locName, _startMin: s, _endMin: e, _fixed: true, _freeFilled: true, _shareFilled: true, continuation: false }
                    : { field: locName, sport: act, _activity: act, _startMin: s, _endMin: e, _fixed: true, _freeFilled: true, _shareFilled: true, continuation: false };
                const fl = String(locName).toLowerCase().trim();
                (_occL65[fl] = _occL65[fl] || []).push({ bunk: String(b), grade: _b2g76[String(b)] || '?', act: act, s: s, e: e, field: locName });
                (_done76[String(b)] = _done76[String(b)] || {})[String(act).toLowerCase()] = 1;
            };
            // ★ Combined-player cap for SPORT shares (mirror of total_solver_engine
            //   checkSharedPlayerMaxConflict). The cfg.cap test below caps how many BUNKS
            //   share a field; it does NOT cap the combined CAMPERS. Without this, two
            //   same-grade bunks (e.g. 13 + 15) get seated on one court whose sport maxes
            //   at 22 → 28 players, blowing past the rule. Grace is absolute (max+2: max =
            //   target, +1 small grace, +2 ceiling, +3 blocked). Inert unless bunk sizes
            //   AND a sport max are configured. Round 0 only ever ADDS a 2nd bunk to an
            //   already-occupied field (occ.length >= 1), so a lone over-size bunk is never
            //   reached here — matching the solver gate's "only fires on a genuine share".
            const _bunkMeta65 = window.getBunkMetaData?.() || window.bunkMetaData || {};
            const _bunkSize65 = (bn) => (_bunkMeta65[bn]?.size || _bunkMeta65[String(bn)]?.size || 0);
            const _sportMax65 = (sp) => {
                const r = window.SchedulerCoreUtils?.getSportPlayerRequirements?.(sp);
                if (r && r.maxPlayers) return r.maxPlayers;
                const sm = window.getSportMetaData?.() || window.sportMetaData || {};
                if (sm[sp] && sm[sp].maxPlayers) return sm[sp].maxPlayers;
                const key = Object.keys(sm).find(k => k.toLowerCase() === String(sp || '').toLowerCase().trim());
                return (key && sm[key].maxPlayers) || 0;
            };
            // true if seating a bunk of `mySize` alongside the bunks in `occ` (all playing
            // the SAME sport `act`) keeps combined campers within maxPlayers + 2. Specials
            // have no player max → always fits.
            const _sportShareFits65 = (act, occ, mySize) => {
                if (_isSpecial65(act)) return true;
                const maxP = _sportMax65(act);
                if (!maxP || !(mySize > 0)) return true;
                let combined = mySize;
                for (const o of occ) combined += (_bunkSize65(o.bunk) || 0);
                return combined <= maxP + 2;
            };
            let _shared65 = 0, _backfilled65 = 0;
            // Round 0 — share into an under-capacity same-grade location (kind-matched),
            // fresh only. Among the legal shares, prefer the room whose occupant is the
            // CLOSEST bunk-number neighbour, mirroring the solver's adjacent-bunk bonus
            // (pairing 20+21 beats 20+22).
            Object.keys(_sa76).forEach(b => {
                if (_allowed76 && !_allowed76.has(String(b))) return;
                const g = _b2g76[String(b)] || '?';
                (_sa76[b] || []).forEach((e, idx) => {
                    if (!e || e.continuation || e._isTransition || e._league || e._h2h || !_isFree65(e)) return;
                    const t = _stime76(b, g, idx, e); if (!t || t.s == null || t.e == null) return;
                    const kind = _kindOf65(b, g, idx, e);
                    const _myNum65 = _bunkNum65(b);
                    let _best65 = null;
                    for (const fl of Object.keys(_occL65)) {
                        const cfg = _loc65[fl]; if (!cfg || cfg.type === 'not_sharable') continue;
                        const occ = _occAt65(fl, t.s, t.e, String(b));
                        if (occ.length === 0 || occ.length >= cfg.cap) continue; // need 1+ occupant AND room under cap
                        if (_fieldPinLocked76(occ[0].field || fl, t.s, t.e, g)) continue; // never share onto a pinned-reserved facility
                        if (occ.some(o => o.grade !== g)) continue;             // same-grade share only (always legal)
                        if (occ.some(o => o.s !== t.s || o.e !== t.e)) continue; // co-started, no staggered share
                        if (cfg.type === 'custom' && cfg.divs.length > 0 && cfg.divs.indexOf(g) < 0) continue;
                        const act = occ[0].act; if (!act) continue;            // join the location's in-progress activity
                        const actSp = _isSpecial65(act);
                        if (kind === 'special' && !actSp) continue;            // special slot → join a special only
                        if (kind === 'sport' && actSp) continue;               // sport slot → join a sport only
                        if (_done76[String(b)] && _done76[String(b)][String(act).toLowerCase()]) continue; // never a repeat
                        // ★ combined sport maxPlayers cap (max+2 grace) — skip a court that
                        //   this bunk would push past the sport's limit; bunk stays Free
                        //   rather than overfill, exactly as the solver declines the share.
                        if (!_sportShareFits65(act, occ, _bunkSize65(b))) continue;
                        let _dist65 = Infinity;
                        occ.forEach(o => { const dd = Math.abs(_bunkNum65(o.bunk) - _myNum65); if (dd < _dist65) _dist65 = dd; });
                        if (!_best65 || _dist65 < _best65.dist) _best65 = { field: occ[0].field, act: act, dist: _dist65 };
                    }
                    if (_best65) { _seat65(b, idx, _best65.field, _best65.act, t.s, t.e); _shared65++; }
                });
            });
            // Round 2 — special-slot backfill: a still-Free Special-Activity slot
            // opens a grade-accessible special on a free location (prefer one the
            // bunk has NOT done today; a repeat is the last resort).
            Object.keys(_sa76).forEach(b => {
                if (_allowed76 && !_allowed76.has(String(b))) return;
                const g = _b2g76[String(b)] || '?';
                (_sa76[b] || []).forEach((e, idx) => {
                    if (!e || e.continuation || e._isTransition || e._league || e._h2h || !_isFree65(e)) return;
                    if (_kindOf65(b, g, idx, e) !== 'special') return;
                    const t = _stime76(b, g, idx, e); if (!t || t.s == null || t.e == null) return;
                    const done = _done76[String(b)] || {};
                    const pool = Object.keys(_gradeSpecials65[g] || {});
                    const ordered = pool.filter(an => !done[an]); // fresh only — never a same-day repeat
                    for (const an of ordered) {
                        const sp = _specByName65[an]; if (!sp) continue;
                        // ★ special disabled today (facility-off cascade) or its location disabled
                        if (_disabledSpecialsLc76.has(String(an).toLowerCase().trim()) || _disabledLc76.has(String(sp.loc).toLowerCase().trim())) continue;
                        const cfg = _loc65[sp.loc] || { type: 'same_division', cap: 2 };
                        if (_fieldPinLocked76(sp.locName || sp.loc, t.s, t.e, g)) continue; // never open a special on a pinned-reserved facility
                        const occ = _occAt65(sp.loc, t.s, t.e, String(b));
                        if (occ.some(o => String(o.act || '').toLowerCase().trim() !== String(an).toLowerCase().trim())) continue; // never open a special on a court already running a DIFFERENT activity (sport or other special)
                        if (cfg.type === 'not_sharable' ? occ.length > 0 : occ.length >= cfg.cap) continue; // full
                        if (occ.some(o => o.grade !== g)) continue;             // same-grade only
                        if (occ.some(o => o.s !== t.s || o.e !== t.e)) continue; // co-start
                        _seat65(b, idx, sp.locName, sp.name, t.s, t.e); _backfilled65++; break;
                    }
                });
            });
            if (_shared65 + _backfilled65 > 0) console.log('[STEP 7.65] no-repeat fill: seated ' + _shared65 + ' by sharing + ' + _backfilled65 + ' fresh-room backfill(s)');
            else console.log('[STEP 7.65] no-repeat fill: nothing fillable without a repeat');
        } catch (_e76) {
            console.warn('[STEP 7.6] Empty-field free-fill failed:', _e76);
        }

        // =========================================================================
        // STEP 7.7: Spacing-rule enforcement sweep (manual analog of the auto gate).
        // The manual builder never gated spacing rules at placement time, so a
        // generated manual schedule could place e.g. a Special right after Lunch in
        // violation of a "no Special within N min of Lunch" rule. This FINAL sweep
        // (after every fill/refill above) demotes any spacing-violating block → Free,
        // mode 'manual' (applies rules whose mode is 'manual' or 'both'). Demote-only,
        // so it cannot create a field-sharing conflict. Mirrors how the auto path
        // simply refuses to place a violating candidate.
        // =========================================================================
        try {
            if (window.SchedulingRules && typeof window.SchedulingRules.enforceSpacingSweep === 'function') {
                const _sp = window.SchedulingRules.enforceSpacingSweep(window.scheduleAssignments || {}, { mode: 'manual' });
                if (_sp && (_sp.demoted || _sp.unresolved)) {
                    console.log('[STEP 7.7] spacing sweep: demoted ' + _sp.demoted + ' → Free' + (_sp.unresolved ? ', ' + _sp.unresolved + ' unresolved (user-locked)' : ''));
                } else {
                    console.log('[STEP 7.7] spacing sweep: ✅ no spacing violations');
                }
            }
        } catch (_e77) {
            console.warn('[STEP 7.7] spacing sweep failed:', _e77);
        }

        // =========================================================================
        // STEP 7.8: Field Quality Groups re-optimization (manual / Smart Tile)
        // The auto builder pulls grouped-field placements to the best-ranked field
        // for the most senior grade via its own final post-pass; the manual builder
        // (and its Smart Tile auto-fill) never did, so manual output ignored field
        // quality. Run the SHARED FieldQualityReopt pass over the assembled
        // schedule now — after every fill/refill/demote sweep above has settled the
        // fields, and before STEP 8 saves. No-op when no field groups are configured.
        // =========================================================================
        try {
            if (window.FieldQualityReopt && typeof window.FieldQualityReopt.run === 'function') {
                window.FieldQualityReopt.run({ log: function (m) { console.log('[STEP 7.8]' + m); } });
            }
        } catch (_e78) {
            console.warn('[STEP 7.8] field-quality re-opt failed:', _e78);
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
                    if (!entry || entry.continuation || entry._isTransition) return;
                    const actName = entry._activity || entry.sport || '';
                    if (!actName) return;

                    const actLower = actName.toLowerCase();
                    if (actLower === 'free' || actLower.includes('transition')) return;

                    newHistory.bunks[bunk] = newHistory.bunks[bunk] || {};
                    newHistory.bunks[bunk][actName] = timestamp;
                });
            });

            window.saveRotationHistory?.(newHistory);

            // ★★★ REBUILD HISTORICAL COUNTS FROM ALL SCHEDULES ★★★
            // saveSchedule (below) writes localStorage synchronously, so a rebuild
            // immediately after that picks up today's new contribution correctly.
            // We deliberately use rebuildHistoricalCounts (full re-scan) instead of
            // reIncrement: a delayed reIncrement reads the post-save allDaily and
            // treats the new schedule as the "old" snapshot, which silently shifts
            // counts by (newToday − oldToday) every time a date is regenerated.
            const schedDateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            const _runCountsRebuild = () => {
                try {
                    if (window.SchedulerCoreUtils?.rebuildHistoricalCounts) {
                        window.SchedulerCoreUtils.rebuildHistoricalCounts(true);
                    }
                    if (window.RotationCloud?.save) {
                        window.RotationCloud.save(schedDateKey, window.scheduleAssignments || {});
                    }
                } catch (e) { console.warn('[Optimizer] post-gen counts rebuild failed:', e); }
            };
            // Defer just past saveSchedule (called below) so allDaily has today.
            setTimeout(_runCountsRebuild, 0);

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

        // ★★★ Clear generation-in-progress flag now that we're truly done ★★★
        window._generationInProgress = false;

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
