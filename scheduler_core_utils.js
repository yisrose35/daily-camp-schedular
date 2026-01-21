// ============================================================================
// scheduler_core_utils.js (FIXED v7.1 - TYPE COERCION FIX FOR BUNK LOOKUPS)
//
// PART 1 of 3: THE FOUNDATION
//
// CRITICAL UPDATE v7.1:
// - ★★★ FIX: getDivisionForBunk now uses type-coerced comparison ★★★
// - ★★★ FIX: findSlotsForRange bunk lookup uses type-coerced comparison ★★★
// - This fixes the issue where bunks stored as numbers weren't found when
//   looked up as strings, causing getDivisionForBunk to return null
// - Division-aware lock checking for elective tiles
// - canBlockFit() now passes division context to GlobalFieldLocks
// - Elective tiles can lock fields for OTHER divisions while allowing their own
// - Added disabled fields check (e.g. Rainy Day) to core fit functions
// ============================================================================

(function () {
    'use strict';

    // ===== CONFIG =====
    const INCREMENT_MINS = 30;
    window.INCREMENT_MINS = INCREMENT_MINS;
    const TRANSITION_TYPE = "Transition/Buffer";
    window.TRANSITION_TYPE = TRANSITION_TYPE;

    // DEBUG MODE - Set to true to see why canBlockFit fails
    const DEBUG_FITS = false;

    const Utils = {};

    // =================================================================
    // 1. BASIC HELPERS
    // =================================================================

    Utils.parseTimeToMinutes = function (str) {
        if (str == null) return null;
        if (typeof str === "number") return str;
        if (typeof str !== "string") return null;

        let s = str.trim().toLowerCase();
        let mer = null;

        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/gi, "").trim();
        }

        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;

        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);

        if (mm < 0 || mm > 59) return null;

        if (mer) {
            if (hh === 12) hh = mer === "am" ? 0 : 12;
            else if (mer === "pm") hh += 12;
        } else {
            // If no AM/PM specified, assume PM ONLY for afternoon hours (12-6)
            if (hh >= 1 && hh <= 6) {
                console.warn(`[TIME PARSE] "${str}" has no AM/PM - assuming ${hh + 12 >= 12 ? 'PM' : 'AM'}`);
                hh += 12;
            }
        }

        return hh * 60 + mm;
    };

    Utils.fieldLabel = function (f) {
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && typeof f.name === "string") return f.name;
        return "";
    };

    Utils.fmtTime = function (d) {
        if (!d) return "";
        if (typeof d === 'string') d = new Date(d);
        let h = d.getHours();
        let m = d.getMinutes().toString().padStart(2, "0");
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${m} ${ap}`;
    };

    Utils.minutesToDate = function (mins) {
        const d = new Date(1970, 0, 1, 0, 0, 0);
        d.setMinutes(mins);
        return d;
    };

    /**
     * Find slot indices for a time range
     * @param {number} startMin - Start time in minutes
     * @param {number} endMin - End time in minutes
     * @param {string} [divisionOrBunk] - Division name or bunk name (NEW: for division-specific lookup)
     * @returns {number[]} Array of slot indices
     */
    Utils.findSlotsForRange = function (startMin, endMin, divisionOrBunk = null) {
        const slots = [];
        if (startMin == null || endMin == null) return slots;

        // ★★★ NEW: Division-specific lookup ★★★
       if (divisionOrBunk && window.divisionTimes) {
    let divName = String(divisionOrBunk);

    // ★★★ FIX: Check if it's already a DIVISION name FIRST ★★★
    if (!window.divisionTimes[divName]) {
        // Not a division, check if it's a bunk name
        const divisions = window.divisions || {};
        const bunkStr = String(divisionOrBunk);
        for (const [dName, dData] of Object.entries(divisions)) {
            if (dData.bunks?.some(b => String(b) === bunkStr)) {
                divName = dName;
                break;
            }
        }
    }

            // ★★★ FIX v7.2: Convert to string for divisionTimes lookup ★★★

const divSlots = window.divisionTimes[divName];
            if (divSlots && divSlots.length > 0) {
                for (let i = 0; i < divSlots.length; i++) {
                    const slot = divSlots[i];
                    // Check if slot overlaps with requested range
                    if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                        slots.push(i);
                    }
                }
                return slots;
            }
        }

        // Fallback to legacy unifiedTimes
        if (!window.unifiedTimes) return slots;

        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const slot = window.unifiedTimes[i];
            const slotStart = slot.startMin ?? (new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes());
            if (slotStart >= startMin && slotStart < endMin) slots.push(i);
        }
        return slots;
    };

    /**
     * NEW: Get slot info for a division at a specific index
     */
    Utils.getDivisionSlot = function(divisionName, slotIndex) {
        return window.divisionTimes?.[divisionName]?.[slotIndex] || null;
    };

    /**
     * NEW: Get all slots for a division
     */
    Utils.getDivisionSlots = function(divisionName) {
        return window.divisionTimes?.[divisionName] || [];
    };

    /**
     * ★★★ DEPRECATED: Use the consolidated version below (kept for reference) ★★★
     * This simpler version is overwritten by the fuller version in Section 2
     */
    // Utils.getDivisionForBunk = function(bunkName) { ... }

    Utils.getBlockTimeRange = function (block) {
        let blockStartMin = (typeof block.startTime === "number") ? block.startTime : null;
        let blockEndMin = (typeof block.endTime === "number") ? block.endTime : null;

        if ((!blockStartMin || !blockEndMin) && window.unifiedTimes && block.slots?.length) {
            const minIndex = Math.min(...block.slots);
            const maxIndex = Math.max(...block.slots);
            const firstSlot = window.unifiedTimes[minIndex];
            const lastSlot = window.unifiedTimes[maxIndex];

            if (firstSlot && lastSlot) {
                const firstStart = new Date(firstSlot.start);
                const lastEnd = new Date(lastSlot.end);
                blockStartMin = firstStart.getHours() * 60 + firstStart.getMinutes();
                blockEndMin = lastEnd.getHours() * 60 + lastEnd.getMinutes();
            }
        }
        return { blockStartMin, blockEndMin };
    };

    // =================================================================
    // 2. FIELD RESERVATION LOGIC (Skeleton-based)
    // =================================================================

    Utils.getFieldReservationsFromSkeleton = function(skeleton) {
        const reservations = {};

        if (!skeleton || !Array.isArray(skeleton)) {
            return reservations;
        }

        skeleton.forEach(block => {
            if (block.reservedFields && Array.isArray(block.reservedFields) && block.reservedFields.length > 0) {
                const startMin = Utils.parseTimeToMinutes(block.startTime);
                const endMin = Utils.parseTimeToMinutes(block.endTime);

                if (startMin === null || endMin === null) return;

                block.reservedFields.forEach(fieldName => {
                    if (!reservations[fieldName]) {
                        reservations[fieldName] = [];
                    }

                    reservations[fieldName].push({
                        startMin,
                        endMin,
                        division: block.division,
                        event: block.event,
                        id: block.id
                    });
                });
            }
        });

        console.log("[FieldReservations] Scanned skeleton, found reservations:", reservations);
        return reservations;
    };

    Utils.isFieldReserved = function(fieldName, startMin, endMin, reservations) {
        if (!reservations || !reservations[fieldName]) {
            return null;
        }

        for (const reservation of reservations[fieldName]) {
            const overlaps = (startMin < reservation.endMin) && (endMin > reservation.startMin);
            if (overlaps) {
                return reservation;
            }
        }

        return null;
    };

    // =================================================================
    // 3. TRANSITION / BUFFER LOGIC
    // =================================================================

    Utils.getTransitionRules = function (fieldName, activityProperties) {
        const base = {
            preMin: 0,
            postMin: 0,
            label: "Travel",
            zone: window.DEFAULT_ZONE_NAME || "default",
            occupiesField: false,
            minDurationMin: 0
        };

        if (!activityProperties) return base;
        const props = activityProperties[fieldName];
        if (!props?.transition) return base;
        return { ...base, ...props.transition };
    };

    Utils.getEffectiveTimeRange = function (block, rules) {
        const { blockStartMin, blockEndMin } = Utils.getBlockTimeRange(block);

        if (blockStartMin == null || blockEndMin == null) {
            return {
                blockStartMin,
                blockEndMin,
                effectiveStart: blockStartMin,
                effectiveEnd: blockEndMin,
                activityDuration: 0
            };
        }

        const pre = rules.preMin || 0;
        const post = rules.postMin || 0;

        const effectiveStart = blockStartMin + pre;
        const effectiveEnd = blockEndMin - post;

        return {
            blockStartMin,
            blockEndMin,
            effectiveStart,
            effectiveEnd,
            activityDuration: effectiveEnd - effectiveStart
        };
    };

    // =================================================================
    // 4. BUNK NUMBER EXTRACTION (for adjacent pairing)
    // =================================================================

    Utils.getBunkNumber = function (bunkName) {
        if (!bunkName) return Infinity;
        const match = String(bunkName).match(/(\d+)/);
        return match ? parseInt(match[1], 10) : Infinity;
    };

    Utils.getBunkDistance = function (bunk1, bunk2) {
        const num1 = Utils.getBunkNumber(bunk1);
        const num2 = Utils.getBunkNumber(bunk2);
        if (num1 === Infinity || num2 === Infinity) return Infinity;
        return Math.abs(num1 - num2);
    };

    // =================================================================
    // 5. SPORT PLAYER REQUIREMENTS
    // =================================================================

    Utils.getSportPlayerRequirements = function(sportName) {
        if (!sportName) return { minPlayers: null, maxPlayers: null };

        const sportMeta = window.getSportMetaData?.() || window.sportMetaData || Utils._sportMetaData || {};
        const meta = sportMeta[sportName] || {};

        return {
            minPlayers: meta.minPlayers || null,
            maxPlayers: meta.maxPlayers || null
        };
    };

    Utils.checkPlayerCountForSport = function(sportName, playerCount, isForLeague = false) {
        if (isForLeague) {
            return { valid: true, reason: null, severity: null };
        }

        const reqs = Utils.getSportPlayerRequirements(sportName);

        if (reqs.minPlayers === null && reqs.maxPlayers === null) {
            return { valid: true, reason: null, severity: null };
        }

        if (reqs.minPlayers !== null && playerCount < reqs.minPlayers) {
            const deficit = reqs.minPlayers - playerCount;
            const percentageUnder = deficit / reqs.minPlayers;

            if (percentageUnder > 0.4) {
                return {
                    valid: false,
                    reason: `Need at least ${reqs.minPlayers} players, only have ${playerCount}`,
                    severity: 'hard'
                };
            }

            return {
                valid: false,
                reason: `Below minimum (${playerCount}/${reqs.minPlayers})`,
                severity: 'soft'
            };
        }

        if (reqs.maxPlayers !== null && playerCount > reqs.maxPlayers) {
            const excess = playerCount - reqs.maxPlayers;
            const percentageOver = excess / reqs.maxPlayers;

            if (percentageOver > 0.3) {
                return {
                    valid: false,
                    reason: `Maximum ${reqs.maxPlayers} players, have ${playerCount}`,
                    severity: 'hard'
                };
            }

            return {
                valid: false,
                reason: `Above maximum (${playerCount}/${reqs.maxPlayers})`,
                severity: 'soft'
            };
        }

        return { valid: true, reason: null, severity: null };
    };

    Utils.getFieldPlayerCount = function(fieldName, slotIndex, excludeBunk = null) {
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || Utils._bunkMetaData || {};
        const schedules = window.scheduleAssignments || {};

        let totalPlayers = 0;

        for (const [bunk, slots] of Object.entries(schedules)) {
            if (bunk === excludeBunk) continue;

            const entry = slots?.[slotIndex];
            if (!entry) continue;

            const entryField = Utils.fieldLabel(entry.field) || entry._activity;
            if (!entryField) continue;

            if (entryField.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                totalPlayers += bunkMeta[bunk]?.size || 0;
            }
        }

        return totalPlayers;
    };

    // =================================================================
    // 6. FIELD USAGE HELPERS
    // =================================================================

    function getFieldUsageAtSlot(slotIndex, fieldName, fieldUsageBySlot) {
        const result = {
            count: 0,
            bunks: {},
            activities: new Set(),
            bunkList: []
        };

        if (!fieldUsageBySlot || !fieldUsageBySlot[slotIndex]) return result;

        const slotData = fieldUsageBySlot[slotIndex];
        const fieldData = slotData[fieldName];

        if (!fieldData) return result;

        result.count = fieldData.count || 0;
        result.bunks = fieldData.bunks || {};
        result.bunkList = Object.keys(result.bunks);

        Object.values(result.bunks).forEach(actName => {
            if (actName) result.activities.add(actName.toLowerCase().trim());
        });

        return result;
    }

    function getScheduleUsageAtSlot(slotIndex, fieldName) {
        const result = {
            count: 0,
            bunks: {},
            activities: new Set(),
            bunkList: []
        };

        const schedules = window.scheduleAssignments || {};

        for (const [bunk, slots] of Object.entries(schedules)) {
            const entry = slots?.[slotIndex];
            if (!entry) continue;

            const entryField = Utils.fieldLabel(entry.field) || entry._activity;
            if (!entryField) continue;

            if (entryField.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                result.count++;
                result.bunks[bunk] = entry._activity || entry.sport || entryField;
                result.bunkList.push(bunk);

                const actName = entry._activity || entry.sport;
                if (actName) result.activities.add(actName.toLowerCase().trim());
            }
        }

        return result;
    }

    // =================================================================
    // 7. MAIN FIT LOGIC (WITH DIVISION-AWARE LOCK CHECK)
    // =================================================================

    Utils.isTimeAvailable = function (slotIndex, props) {
        if (!window.unifiedTimes?.[slotIndex]) return false;
        const slot = window.unifiedTimes[slotIndex];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        const slotEnd = new Date(slot.end).getHours() * 60 + new Date(slot.end).getMinutes();

        const rules = (props.timeRules || []).map(r => {
            if (typeof r.startMin === "number") return r;
            return {
                ...r,
                startMin: Utils.parseTimeToMinutes(r.start),
                endMin: Utils.parseTimeToMinutes(r.end)
            };
        });

        if (rules.length === 0) return props.available !== false;
        if (!props.available) return false;

        let allowed = !rules.some(r => r.type === "Available");

        for (const rule of rules) {
            if (rule.type === "Available" &&
                slotStart >= rule.startMin &&
                slotEnd <= rule.endMin) {
                allowed = true;
                break;
            }
        }

        if (!allowed) return false;

        for (const rule of rules) {
            if (rule.type === "Unavailable" &&
                slotStart < rule.endMin &&
                slotEnd > rule.startMin) {
                return false;
            }
        }

        return true;
    };

    /**
     * =========================================================================
     * MAIN FIT CHECK - DIVISION-AWARE LOCK CHECKING FOR ELECTIVES
     * =========================================================================
     * This is the CRITICAL function that determines if a bunk can use a field.
     * * CHECK ORDER:
     * 0. DISABLED FIELDS - If disabled (Rainy Day), IMMEDIATELY REJECT
     * 1. GLOBAL LOCKS (leagues) - If locked, IMMEDIATELY REJECT
     * 2. DIVISION LOCKS (electives) - Check if this division is allowed
     * 3. Field reservations (skeleton)
     * 4. Activity properties (availability, time rules, preferences)
     * 5. Capacity checks
     * 6. Player requirements (soft check)
     * =========================================================================
     */
    Utils.canBlockFit = function (block, fieldName, activityProperties, fieldUsageBySlot, actName, forceLeague = false) {
        if (!fieldUsageBySlot) fieldUsageBySlot = window.fieldUsageBySlot || {};
        if (!fieldName) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - no field name`);
            return false;
        }

        // =================================================================
        // ★★★ CHECK IF FIELD IS IN DISABLED FIELDS LIST (RAINY DAY, ETC) ★★★
        // This MUST be checked BEFORE anything else!
        // =================================================================
        const disabledFields = window.currentDisabledFields || [];
        if (disabledFields.includes(fieldName)) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - field is DISABLED (rainy day or manual override)`);
            return false;
        }

        // Get slots for this block
        let uniqueSlots = [];
        if (block.slots && block.slots.length > 0) {
            uniqueSlots = [...new Set(block.slots)].sort((a, b) => a - b);
        } else {
            const { blockStartMin, blockEndMin } = Utils.getBlockTimeRange(block);
            if (blockStartMin != null && blockEndMin != null) {
                uniqueSlots = Utils.findSlotsForRange(blockStartMin, blockEndMin);
            }
        }

        // =================================================================
        // ★★★ CRITICAL: DIVISION-AWARE GLOBAL LOCK CHECK ★★★
        // =================================================================
        if (window.GlobalFieldLocks && uniqueSlots.length > 0) {
            // Pass the division context so elective locks work correctly
            const divisionContext = block.divName || block.division;
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, uniqueSlots, divisionContext);

            if (lockInfo) {
                if (DEBUG_FITS) {
                    if (lockInfo.type === 'division') {
                        console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - ELECTIVE LOCKED for ${lockInfo.allowedDivision} (not ${divisionContext})`);
                    } else {
                        console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - GLOBALLY LOCKED by ${lockInfo.lockedBy}`);
                    }
                }
                return false;
            }
        }

        // =================================================================

        const baseProps = {
            available: true,
            sharable: false,
            sharableWith: { capacity: 1, type: "not_sharable" },
            timeRules: [],
            transition: { preMin: 0, postMin: 0, zone: "default", occupiesField: false }
        };

        const props = activityProperties?.[fieldName];
        const effectiveProps = props || baseProps;

        // Get transition rules
        const rules = Utils.getTransitionRules(fieldName, activityProperties);
        const {
            blockStartMin, blockEndMin,
            effectiveStart, effectiveEnd,
            activityDuration
        } = Utils.getEffectiveTimeRange(block, rules);

        // =================================================================
        // FIELD RESERVATION CHECK (Skeleton-based)
        // =================================================================

        if (window.fieldReservations && blockStartMin != null && blockEndMin != null) {
            const reservation = Utils.isFieldReserved(
                fieldName,
                blockStartMin,
                blockEndMin,
                window.fieldReservations
            );

            if (reservation) {
                if (DEBUG_FITS) {
                    console.log(`[FIT] ${fieldName} REJECTED - reserved by "${reservation.event}" (${reservation.division})`);
                }
                return false;
            }
        }

        if (activityDuration <= 0 || activityDuration < (rules.minDurationMin || 0)) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - duration ${activityDuration}`);
            return false;
        }

        // =================================================================
        // CAPACITY CALCULATION
        // =================================================================
        let maxCapacity = 1;

        if (effectiveProps.sharableWith?.capacity) {
            maxCapacity = parseInt(effectiveProps.sharableWith.capacity) || 1;
        } else if (effectiveProps.sharable || effectiveProps.sharableWith?.type === "all" || effectiveProps.sharableWith?.type === "custom") {
            maxCapacity = 2;
        }

        // Basic availability checks
        if (effectiveProps.available === false) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - not available`);
            return false;
        }

        if (effectiveProps.allowedDivisions?.length && !effectiveProps.allowedDivisions.includes(block.divName)) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - division not allowed`);
            return false;
        }

        if (effectiveProps.preferences?.enabled && effectiveProps.preferences.exclusive &&
            !effectiveProps.preferences.list.includes(block.divName)) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - exclusive preference`);
            return false;
        }

        // LimitUsage check
        if (effectiveProps.limitUsage?.enabled) {
            const divisionRules = effectiveProps.limitUsage.divisions || {};

            if (!(block.divName in divisionRules)) {
                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - limitUsage: division ${block.divName} not in allowed list`);
                return false;
            }

            const rule = divisionRules[block.divName];

            if (Array.isArray(rule) && rule.length > 0) {
                const bunkStr = String(block.bunk);
                const bunkNum = parseInt(block.bunk);
                const inList = rule.some(b => String(b) === bunkStr || parseInt(b) === bunkNum);

                if (!inList) {
                    if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - limitUsage: bunk not in allowed list`);
                    return false;
                }
            }
        }

        if (uniqueSlots.length === 0 && blockStartMin != null) {
            if (window.unifiedTimes) {
                for (let i = 0; i < window.unifiedTimes.length; i++) {
                    const slot = window.unifiedTimes[i];
                    const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
                    const slotEnd = new Date(slot.end).getHours() * 60 + new Date(slot.end).getMinutes();

                    if (slotStart < blockEndMin && slotEnd > blockStartMin) {
                        uniqueSlots.push(i);
                    }
                }
            }
        }

        if (uniqueSlots.length === 0) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - no slots found`);
            return false;
        }

        // =================================================================
        // CHECK EACH SLOT FOR CAPACITY AND ACTIVITY MATCHING
        // =================================================================
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || Utils._bunkMetaData || {};
        const sportMeta = window.getSportMetaData?.() || window.sportMetaData || Utils._sportMetaData || {};
        const mySize = bunkMeta[block.bunk]?.size || 0;

        for (const idx of uniqueSlots) {
            const trackedUsage = getFieldUsageAtSlot(idx, fieldName, fieldUsageBySlot);
            const scheduleUsage = getScheduleUsageAtSlot(idx, fieldName);

            const allBunks = new Set([...trackedUsage.bunkList, ...scheduleUsage.bunkList]);
            const allActivities = new Set([...trackedUsage.activities, ...scheduleUsage.activities]);

            allBunks.delete(block.bunk);

            const currentCount = allBunks.size;

            // STRICT CAPACITY CHECK
            if (currentCount >= maxCapacity) {
                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - at capacity (${currentCount}/${maxCapacity})`);
                return false;
            }

            // SAME ACTIVITY REQUIREMENT WHEN SHARING
            if (currentCount > 0 && actName) {
                const myActivity = actName.toLowerCase().trim();

                if (allActivities.size > 0) {
                    const activitiesMatch = allActivities.has(myActivity);

                    if (!activitiesMatch) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - different activity`);
                        return false;
                    }
                }
            }

            if (!Utils.isTimeAvailable(idx, effectiveProps)) {
                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - time not available at slot ${idx}`);
                return false;
            }

            // =================================================================
            // SPORT PLAYER REQUIREMENTS (SOFT CHECK)
            // =================================================================
            if (actName && !forceLeague) {
                let currentHeadcount = 0;
                allBunks.forEach(b => {
                    currentHeadcount += (bunkMeta[b]?.size || 0);
                });

                const projectedHeadcount = currentHeadcount + mySize;

                const playerCheck = Utils.checkPlayerCountForSport(actName, projectedHeadcount, forceLeague);

                if (!playerCheck.valid && playerCheck.severity === 'hard') {
                    if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - player count HARD violation`);
                    return false;
                }
            }

            // Legacy maxCapacity check
            const maxHeadcount = sportMeta[actName]?.maxCapacity ?? Infinity;

            if (maxHeadcount !== Infinity) {
                let currentHeadcount = 0;
                allBunks.forEach(b => {
                    currentHeadcount += (bunkMeta[b]?.size || 0);
                });

                if (currentHeadcount + mySize > maxHeadcount) {
                    if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - headcount exceeded`);
                    return false;
                }
            }
        }

        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: ALLOWED`);
        return true;
    };

    /**
     * Calculate sharing score - HIGHER is better
     * NOW division-aware for elective locks
     */
    Utils.calculateSharingScore = function (block, fieldName, fieldUsageBySlot, actName) {
        if (!fieldUsageBySlot) fieldUsageBySlot = window.fieldUsageBySlot || {};

        // ★★★ CHECK DISABLED FIELDS FIRST ★★★
        const disabledFields = window.currentDisabledFields || [];
        if (disabledFields.includes(fieldName)) {
            return -999999; // Completely unavailable
        }

        // First check if field is locked (with division context)
        const slots = Utils.findSlotsForRange(block.startTime, block.endTime);
        const divisionContext = block.divName || block.division;

        if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots, divisionContext)) {
            return -999999; // Completely unavailable
        }

        let score = 0;
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || Utils._bunkMetaData || {};
        const mySize = bunkMeta[block.bunk]?.size || 0;

        for (const idx of slots) {
            const scheduleUsage = getScheduleUsageAtSlot(idx, fieldName);

            if (scheduleUsage.count === 0) {
                score += 100;

                if (actName) {
                    const playerCheck = Utils.checkPlayerCountForSport(actName, mySize, false);
                    if (!playerCheck.valid) {
                        if (playerCheck.severity === 'hard') {
                            score -= 5000;
                        } else {
                            score -= 500;
                        }
                    }
                }
            } else {
                let minDistance = Infinity;
                let sameActivity = true;
                let combinedSize = mySize;

                for (const existingBunk of scheduleUsage.bunkList) {
                    const distance = Utils.getBunkDistance(block.bunk, existingBunk);
                    minDistance = Math.min(minDistance, distance);
                    combinedSize += (bunkMeta[existingBunk]?.size || 0);

                    const existingActivity = scheduleUsage.bunks[existingBunk];
                    if (existingActivity && actName) {
                        if (existingActivity.toLowerCase().trim() !== actName.toLowerCase().trim()) {
                            sameActivity = false;
                        }
                    }
                }

                if (minDistance < Infinity) {
                    score += Math.max(0, 100 - (minDistance * 10));
                }

                if (sameActivity) {
                    score += 50;

                    if (actName) {
                        const playerCheck = Utils.checkPlayerCountForSport(actName, combinedSize, false);
                        if (playerCheck.valid) {
                            score += 200;
                        } else if (playerCheck.severity === 'soft') {
                            score -= 100;
                        } else {
                            score -= 2000;
                        }
                    }
                } else {
                    score -= 1000;
                }
            }
        }

        return score;
    };

    Utils.calculatePlayerCountPenalty = function(actName, playerCount, isLeague = false) {
        if (!actName || isLeague) return 0;

        const check = Utils.checkPlayerCountForSport(actName, playerCount, isLeague);

        if (check.valid) return 0;

        if (check.severity === 'hard') return 10000;
        if (check.severity === 'soft') return 1000;

        return 0;
    };

    Utils.canLeagueGameFit = function (block, fieldName, usage, props) {
        return Utils.canBlockFit(block, fieldName, props, usage, "League Game", true);
    };

    // =================================================================
    // 8. TIMELINE & DEBUG
    // =================================================================

    Utils.timeline = {
        checkAvailability(resourceName, startMin, endMin, weight, capacity, excludeBunk, divisionContext) {
            // ★★★ CHECK DISABLED FIELDS FIRST ★★★
            const disabledFields = window.currentDisabledFields || [];
            if (disabledFields.includes(resourceName)) {
                return false;
            }

            // Check global locks (with division context)
            const slots = Utils.findSlotsForRange(startMin, endMin);
            if (window.GlobalFieldLocks?.isFieldLocked(resourceName, slots, divisionContext)) {
                return false;
            }

            const assigns = window.scheduleAssignments || {};
            for (const s of slots) {
                let current = 0;
                for (const bunk of Object.keys(assigns)) {
                    if (bunk === excludeBunk) continue;
                    const entry = assigns[bunk][s];
                    if (!entry) continue;
                    const name = Utils.fieldLabel(entry.field) || entry._activity;
                    if (!name) continue;
                    if (name.toLowerCase() === resourceName.toLowerCase()) {
                        current++;
                    }
                }
                if (current + weight > capacity) return false;
            }

            return true;
        },

        getPeakUsage(resourceName, startMin, endMin, excludeBunk) {
            const slots = Utils.findSlotsForRange(startMin, endMin);
            const assigns = window.scheduleAssignments || {};
            let maxLoad = 0;
            for (const s of slots) {
                let current = 0;
                for (const bunk of Object.keys(assigns)) {
                    if (bunk === excludeBunk) continue;
                    const entry = assigns[bunk][s];
                    if (!entry) continue;
                    const name = Utils.fieldLabel(entry.field) || entry._activity;
                    if (!name) continue;
                    if (name.toLowerCase() === resourceName.toLowerCase()) {
                        current++;
                    }
                }
                maxLoad = Math.max(maxLoad, current);
            }
            return maxLoad;
        }
    };

    Utils.loadAndFilterData = function () {
        if (typeof window.loadAndFilterData !== "function") {
            console.error("ERROR: scheduler_core_loader.js not loaded before scheduler_core_utils.js");
            return {};
        }
        return window.loadAndFilterData();
    };

    Utils.debugFieldConfig = function(fieldName) {
        const props = window.activityProperties?.[fieldName];
        console.log(`=== DEBUG: ${fieldName} ===`);
        console.log('Properties:', props);
        console.log('Available:', props?.available);
        console.log('Sharable:', props?.sharable);
        console.log('SharableWith:', props?.sharableWith);
        console.log('TimeRules:', props?.timeRules);
        console.log('Preferences:', props?.preferences);

        // Check global lock status
        if (window.GlobalFieldLocks) {
            console.log('Global Lock Status: checking all slots...');
            const allSlots = window.unifiedTimes?.map((_, i) => i) || [];
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, allSlots);
            if (lockInfo) {
                console.log('LOCKED:', lockInfo);
            } else {
                console.log('Not globally locked');
            }
        }
    };

    Utils.debugSportRequirements = function(sportName) {
        const reqs = Utils.getSportPlayerRequirements(sportName);
        console.log(`\n=== ${sportName} PLAYER REQUIREMENTS ===`);
        console.log(`Min Players: ${reqs.minPlayers || 'Not set'}`);
        console.log(`Max Players: ${reqs.maxPlayers || 'Not set'}`);

        [8, 12, 14, 18, 24, 28, 32].forEach(count => {
            const check = Utils.checkPlayerCountForSport(sportName, count, false);
            const status = check.valid ? '✅' : (check.severity === 'hard' ? '❌ HARD' : '⚠️ SOFT');
            console.log(`  ${count} players: ${status} ${check.reason || ''}`);
        });
    };
// ============================================================================
// CONSOLIDATED UTILITY FUNCTIONS - ADD TO scheduler_core_utils.js
// ============================================================================
// 
// These functions were duplicated across:
// - unified_schedule_system.js
// - post_edit_system.js  
// - division_times_system.js
// - division_times_integration.js
//
// After adding these to scheduler_core_utils.js, update the other files to use:
//   window.SchedulerCoreUtils.functionName() or Utils.functionName()
//
// ============================================================================

    // =================================================================
    // 2. DIVISION-AWARE CORE FUNCTIONS (CONSOLIDATED)
    // =================================================================

    /**
     * Get the division name for a bunk
     * SINGLE SOURCE OF TRUTH - remove from all other files
     * 
     * ★★★ FIX v7.1: Uses type-coerced comparison to handle number/string mismatch ★★★
     * This fixes the issue where bunks stored as numbers (e.g., [9, 10, 11])
     * weren't found when looked up as strings (e.g., "9")
     * 
     * @param {string|number} bunkName - The bunk to look up
     * @returns {string|null} Division name or null if not found
     */
    Utils.getDivisionForBunk = function(bunkName) {
        if (bunkName === null || bunkName === undefined) return null;
        
        // ★★★ FIX v7.1: Convert to string for type-safe comparison ★★★
        const bunkStr = String(bunkName);
        const divisions = window.divisions || {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            // ★★★ FIX v7.1: Use .some() with string coercion instead of .includes() ★★★
            if (divData.bunks && divData.bunks.some(b => String(b) === bunkStr)) {
                return divName;
            }
        }
        
        // Fallback: check window.app1.divisions
        const app1Divisions = window.app1?.divisions || {};
        for (const [divName, divData] of Object.entries(app1Divisions)) {
            if (divData.bunks && divData.bunks.some(b => String(b) === bunkStr)) {
                return divName;
            }
        }
        
        return null;
    };

    /**
     * Get all slots for a division
     * SINGLE SOURCE OF TRUTH - remove from division_times_system.js exports
     * * @param {string} divisionName - Division name
     * @returns {Array} Array of slot objects with startMin, endMin, label
     */
   Utils.getSlotsForDivision = function(divisionName) {
    // ★★★ FIX v7.2: Convert to string for divisionTimes lookup ★★★
    const divNameStr = String(divisionName);
    return window.divisionTimes?.[divNameStr] || [];
};

    /**
     * Get slot at a specific index for a division
     * * @param {string} divisionName - Division name
     * @param {number} slotIndex - Slot index
     * @returns {Object|null} Slot object or null
     */
    Utils.getSlotAtIndex = function(divisionName, slotIndex) {
    // ★★★ FIX v7.2: Convert to string for divisionTimes lookup ★★★
    const divNameStr = String(divisionName);
    return window.divisionTimes?.[divNameStr]?.[slotIndex] || null;
};

    /**
     * Get time range for a slot (DIVISION-AWARE)
     * SINGLE SOURCE OF TRUTH - replaces all getSlotTimeRange implementations
     * * @param {number} slotIdx - Slot index
     * @param {string} [bunkOrDiv] - Optional bunk name or division name for division-specific lookup
     * @returns {Object} { startMin, endMin } or { startMin: null, endMin: null }
     */
    Utils.getSlotTimeRange = function(slotIdx, bunkOrDiv) {
        // Try division-specific lookup first
        if (bunkOrDiv && window.divisionTimes) {
            let divName = bunkOrDiv;
            
            // Check if it's a bunk name, convert to division
            const possibleDiv = Utils.getDivisionForBunk(bunkOrDiv);
            if (possibleDiv) divName = possibleDiv;
            
            // ★★★ FIX v7.2: Convert to string for divisionTimes lookup ★★★
const divNameStr = String(divName);
const slot = window.divisionTimes[divNameStr]?.[slotIdx];
            if (slot) {
                return {
                    startMin: slot.startMin,
                    endMin: slot.endMin
                };
            }
        }
        
        // Fallback to unifiedTimes
        const unifiedTimes = window.unifiedTimes || [];
        const slot = unifiedTimes[slotIdx];
        
        if (!slot) return { startMin: null, endMin: null };
        
        // Handle different slot formats
        if (slot.startMin !== undefined && slot.endMin !== undefined) {
            return { startMin: slot.startMin, endMin: slot.endMin };
        }
        
        // Parse from Date objects
        if (slot.start) {
            const start = new Date(slot.start);
            const end = slot.end ? new Date(slot.end) : null;
            return {
                startMin: start.getHours() * 60 + start.getMinutes(),
                endMin: end ? end.getHours() * 60 + end.getMinutes() : null
            };
        }
        
        return { startMin: null, endMin: null };
    };

    /**
     * Find which slot index contains a given time
     * * @param {string} divisionName - Division name
     * @param {number} targetMin - Target time in minutes
     * @returns {number} Slot index or -1 if not found
     */
    Utils.findSlotForTime = function(divisionName, targetMin) {
        const slots = Utils.getSlotsForDivision(divisionName);
        
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin <= targetMin && targetMin < slots[i].endMin) {
                return i;
            }
        }
        
        return -1;
    };

    /**
     * Find slot index by exact time range match
     * * @param {string} divisionName - Division name
     * @param {number} startMin - Start time in minutes
     * @param {number} endMin - End time in minutes
     * @returns {number} Slot index or -1 if not found
     */
    Utils.findSlotForTimeRange = function(divisionName, startMin, endMin) {
        const slots = Utils.getSlotsForDivision(divisionName);
        
        // Exact match first
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin === startMin && slots[i].endMin === endMin) {
                return i;
            }
        }
        
        // Fallback: find slot that contains this range
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].startMin <= startMin && endMin <= slots[i].endMin) {
                return i;
            }
        }
        
        return -1;
    };

    /**
     * Find slot index for a specific time (DIVISION-AWARE)
     * SINGLE SOURCE OF TRUTH - replaces findSlotIndexForTime in other files
     * * @param {number} targetMin - Target time in minutes
     * @param {Array|string} unifiedTimesOrDivision - Either unifiedTimes array OR division/bunk name
     * @returns {number} Slot index or -1 if not found
     */
    Utils.findSlotIndexForTime = function(targetMin, unifiedTimesOrDivision) {
        if (targetMin === null || targetMin === undefined) return -1;
        
        // Handle division/bunk name parameter
        if (typeof unifiedTimesOrDivision === 'string' && window.divisionTimes) {
            let divName = unifiedTimesOrDivision;
            
            // Check if it's a bunk name
            const possibleDiv = Utils.getDivisionForBunk(unifiedTimesOrDivision);
            if (possibleDiv) divName = possibleDiv;
            
            return Utils.findSlotForTime(divName, targetMin);
        }
        
        // Legacy: handle unifiedTimes array
        const unifiedTimes = Array.isArray(unifiedTimesOrDivision) 
            ? unifiedTimesOrDivision 
            : (window.unifiedTimes || []);
            
        if (unifiedTimes.length === 0) return -1;
        
        // Exact match
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = Utils._getSlotStartMin(unifiedTimes[i]);
            if (slotStart === targetMin) return i;
        }
        
        // Find containing slot
        const slots = Utils.findSlotsForRange(targetMin, targetMin + 30, unifiedTimes);
        if (slots.length > 0) return slots[0];
        
        // Closest match
        let closest = -1, minDiff = Infinity;
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slotStart = Utils._getSlotStartMin(unifiedTimes[i]);
            if (slotStart !== null) {
                const diff = Math.abs(slotStart - targetMin);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = i;
                }
            }
        }
        
        return closest;
    };

    /**
     * Internal helper: Get start time in minutes from a slot object
     */
    Utils._getSlotStartMin = function(slot) {
        if (!slot) return null;
        
        if (slot.startMin !== undefined) return slot.startMin;
        
        if (slot.start) {
            const d = new Date(slot.start);
            return d.getHours() * 60 + d.getMinutes();
        }
        
        return null;
    };

    /**
     * Get entry for a bunk at a specific time block (DIVISION-AWARE)
     * SINGLE SOURCE OF TRUTH - replaces getEntryForBlock in other files
     * * @param {string} bunk - Bunk name
     * @param {number} startMin - Start time in minutes
     * @param {number} endMin - End time in minutes
     * @param {Array} [unifiedTimes] - Optional legacy unifiedTimes array (ignored if divisionTimes available)
     * @returns {Object} { entry, slotIdx }
     */
    Utils.getEntryForBlock = function(bunk, startMin, endMin, unifiedTimes) {
        const assignments = window.scheduleAssignments || {};
        
        if (!assignments[bunk]) {
            return { entry: null, slotIdx: -1 };
        }
        
        const bunkData = assignments[bunk];
        const divName = Utils.getDivisionForBunk(bunk);
        const divSlots = window.divisionTimes?.[divName] || [];
        
        // Method 1: Find by EXACT time match in divisionTimes
        for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
            const slot = divSlots[slotIdx];
            if (slot.startMin === startMin && slot.endMin === endMin) {
                return { entry: bunkData[slotIdx] || null, slotIdx };
            }
        }
        
        // Method 2: Find slot that starts within the requested range
    for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
        const slot = divSlots[slotIdx];
        if (slot.startMin >= startMin && slot.startMin < endMin) {
            return { entry: bunkData[slotIdx] || null, slotIdx };
        }
    }
    
    // ★★★ NEW Method 3: Find slot that OVERLAPS the requested range ★★★
    for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
        const slot = divSlots[slotIdx];
        const hasOverlap = !(slot.endMin <= startMin || slot.startMin >= endMin);
        if (hasOverlap) {
            const entry = bunkData[slotIdx];
            if (entry && !entry.continuation) {
                return { entry, slotIdx };
            }
        }
    }
    
    // Method 4: Check embedded time in entry
        for (let slotIdx = 0; slotIdx < bunkData.length; slotIdx++) {
            const entry = bunkData[slotIdx];
            if (!entry || entry.continuation) continue;
            
            const entryStartMin = entry._blockStart || entry._startMin || entry.startMin;
            if (entryStartMin !== undefined && entryStartMin >= startMin && entryStartMin < endMin) {
                return { entry, slotIdx };
            }
        }
        
        return { entry: null, slotIdx: -1 };
    };

    /**
     * Get slots for a bunk (via its division)
     * * @param {string} bunkName - Bunk name
     * @returns {Array} Array of slot objects
     */
    Utils.getSlotsForBunk = function(bunkName) {
        const divName = Utils.getDivisionForBunk(bunkName);
        return divName ? Utils.getSlotsForDivision(divName) : [];
    };

    /**
     * Find slot for a bunk at a given time
     * * @param {string} bunkName - Bunk name
     * @param {number} targetMin - Target time in minutes
     * @returns {number} Slot index or -1
     */
    Utils.findSlotForBunkAtTime = function(bunkName, targetMin) {
        const divName = Utils.getDivisionForBunk(bunkName);
        if (!divName) return -1;
        return Utils.findSlotForTime(divName, targetMin);
    };

    // =================================================================
    // 3. CROSS-DIVISION CONFLICT DETECTION (CONSOLIDATED)
    // =================================================================

    /**
     * Check if two divisions have overlapping time slots
     * CRITICAL for cross-division field conflict detection
     * * @param {string} div1 - First division name
     * @param {number} slot1Idx - Slot index in first division
     * @param {string} div2 - Second division name
     * @param {number} slot2Idx - Slot index in second division
     * @returns {boolean} True if time overlap exists
     */
    Utils.checkTimeOverlapConflict = function(div1, slot1Idx, div2, slot2Idx) {
        const slot1 = Utils.getSlotAtIndex(div1, slot1Idx);
        const slot2 = Utils.getSlotAtIndex(div2, slot2Idx);
        
        if (!slot1 || !slot2) return false;
        
        // Check actual time overlap
        return !(slot1.endMin <= slot2.startMin || slot2.endMin <= slot1.startMin);
    };

    /**
     * Find all divisions that have time slots overlapping with a given slot
     * * @param {string} divisionName - Source division
     * @param {number} slotIndex - Source slot index
     * @returns {Array} Array of { division, slotIndex, overlapStart, overlapEnd }
     */
    Utils.findOverlappingDivisionSlots = function(divisionName, slotIndex) {
        const slot = Utils.getSlotAtIndex(divisionName, slotIndex);
        if (!slot) return [];
        
        const overlaps = [];
        const allDivisions = Object.keys(window.divisionTimes || {});
        
        for (const otherDiv of allDivisions) {
            if (otherDiv === divisionName) continue;
            
            const otherSlots = Utils.getSlotsForDivision(otherDiv);
            for (let i = 0; i < otherSlots.length; i++) {
                const other = otherSlots[i];
                
                // Check for time overlap
                if (!(other.endMin <= slot.startMin || other.startMin >= slot.endMin)) {
                    const overlapStart = Math.max(slot.startMin, other.startMin);
                    const overlapEnd = Math.min(slot.endMin, other.endMin);
                    
                    overlaps.push({
                        division: otherDiv,
                        slotIndex: i,
                        overlapStart,
                        overlapEnd,
                        overlapDuration: overlapEnd - overlapStart
                    });
                }
            }
        }
        
        return overlaps;
    };

    /**
     * Check if a field assignment would conflict with other divisions
     * Uses TIME-BASED comparison, not slot indices!
     * * @param {string} bunk - Bunk being assigned
     * @param {number} slotIndex - Slot index
     * @param {string} fieldName - Field being assigned
     * @returns {Object} { conflict: boolean, conflicts: Array }
     */
    Utils.checkCrossDivisionFieldConflict = function(bunk, slotIndex, fieldName) {
        const divName = Utils.getDivisionForBunk(bunk);
        if (!divName) return { conflict: false, conflicts: [] };
        
        const slot = Utils.getSlotAtIndex(divName, slotIndex);
        if (!slot) return { conflict: false, conflicts: [] };
        
        const startMin = slot.startMin;
        const endMin = slot.endMin;
        const conflicts = [];
        const divisions = window.divisions || {};
        
        for (const [otherDiv, divData] of Object.entries(divisions)) {
            if (otherDiv === divName) continue;
            
            const otherSlots = Utils.getSlotsForDivision(otherDiv);
            
            for (let i = 0; i < otherSlots.length; i++) {
                const otherSlot = otherSlots[i];
                
                // Check time overlap
                if (otherSlot.startMin < endMin && otherSlot.endMin > startMin) {
                    // Time overlaps - check if any bunk in this division uses the same field
                    for (const otherBunk of (divData.bunks || [])) {
                        const assignment = window.scheduleAssignments?.[otherBunk]?.[i];
                        if (!assignment) continue;
                        
                        const assignedField = Utils.fieldLabel(assignment.field) || assignment._activity;
                        if (assignedField && assignedField.toLowerCase() === fieldName.toLowerCase()) {
                            conflicts.push({
                                division: otherDiv,
                                bunk: otherBunk,
                                slotIndex: i,
                                field: assignedField,
                                activity: assignment._activity || assignment.sport,
                                timeOverlap: {
                                    start: Math.max(startMin, otherSlot.startMin),
                                    end: Math.min(endMin, otherSlot.endMin)
                                }
                            });
                        }
                    }
                }
            }
        }
        
        return {
            conflict: conflicts.length > 0,
            conflicts
        };
    };

    // =================================================================
    // 4. TIME FORMATTING UTILITIES (CONSOLIDATED)
    // =================================================================

    /**
     * Convert minutes to 12-hour time label (e.g., "2:30 PM")
     * SINGLE SOURCE OF TRUTH
     */
    Utils.minutesToTimeLabel = function(mins) {
        if (mins === null || mins === undefined) return '';
        const h24 = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
    };

    /**
     * Convert minutes to 24-hour time string (e.g., "14:30")
     */
    Utils.minutesToTimeString = function(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // =================================================================
    // 5. ACTIVITY PROPERTIES UTILITIES (CONSOLIDATED)
    // =================================================================

    /**
     * Get activity properties from all sources
     * SINGLE SOURCE OF TRUTH - consolidates from multiple files
     */
    Utils.getActivityProperties = function() {
        // Return cached if available
        if (window.activityProperties && Object.keys(window.activityProperties).length > 0) {
            return window.activityProperties;
        }
        
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const props = {};
        
        // Build from fields
        (app1.fields || window.getFields?.() || []).forEach(f => {
            if (f.name) {
                props[f.name] = {
                    ...f,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || (f.sharableWith?.type === 'all' ? 999 : 1),
                    available: f.available !== false
                };
            }
        });
        
        // Add sports
        const allSports = app1.allSports || window.allSports || [];
        allSports.forEach(sport => {
            if (!props[sport]) {
                props[sport] = {
                    name: sport,
                    type: 'sport',
                    available: true,
                    capacity: 1
                };
            }
        });
        
        // Add special activities
        (app1.activities || []).forEach(act => {
            const name = typeof act === 'string' ? act : act.name;
            if (name && !props[name]) {
                props[name] = {
                    name,
                    type: 'special',
                    available: true,
                    capacity: 1,
                    ...act
                };
            }
        });
        
        return props;
    };

    /**
     * Get field capacity
     */
    Utils.getFieldCapacity = function(fieldName, activityProperties) {
        const props = activityProperties || Utils.getActivityProperties();
        const fieldProps = props[fieldName];
        
        if (!fieldProps) return 1;
        
        // Check sharableWith config
        if (fieldProps.sharableWith) {
            if (fieldProps.sharableWith.type === 'all') return 999;
            if (fieldProps.sharableWith.capacity) return fieldProps.sharableWith.capacity;
        }
        
        return fieldProps.capacity || 1;
    };

    // =================================================================
    // 6. FIELD USAGE TRACKING (CONSOLIDATED)
    // =================================================================

    /**
     * Build field usage map by slot
     * SINGLE SOURCE OF TRUTH - replaces buildFieldUsageBySlot in other files
     * * @param {Array} excludeBunks - Bunks to exclude from usage count
     * @returns {Object} { [slotIdx]: { [fieldName]: { count, bunks, divisions } } }
     */
    Utils.buildFieldUsageBySlot = function(excludeBunks = []) {
        const map = {};
        const excludeSet = new Set(excludeBunks.map(String));
        const divisions = window.divisions || {};
        
        for (const [divName, divData] of Object.entries(divisions)) {
            const divSlots = window.divisionTimes?.[divName] || [];
            
            for (const bunk of (divData.bunks || [])) {
                if (excludeSet.has(String(bunk))) continue;
                
                const assignments = window.scheduleAssignments?.[bunk] || [];
                
                for (let idx = 0; idx < divSlots.length; idx++) {
                    const slot = divSlots[idx];
                    const entry = assignments[idx];
                    
                    if (!entry || entry.continuation || !entry.field) continue;
                    
                    const fieldName = Utils.fieldLabel(entry.field) || '';
                    if (!fieldName || fieldName === 'Free') continue;
                    
                    if (!map[idx]) map[idx] = {};
                    if (!map[idx][fieldName]) {
                        map[idx][fieldName] = {
                            count: 0,
                            bunks: {},
                            divisions: [],
                            startMin: slot.startMin,
                            endMin: slot.endMin
                        };
                    }
                    
                    map[idx][fieldName].count++;
                    map[idx][fieldName].bunks[bunk] = entry._activity || fieldName;
                    
                    if (!map[idx][fieldName].divisions.includes(divName)) {
                        map[idx][fieldName].divisions.push(divName);
                    }
                }
            }
        }
        
        return map;
    };

    /**
     * Check if a field is available at given slots
     * SINGLE SOURCE OF TRUTH
     */
    Utils.isFieldAvailable = function(fieldName, slots, excludeBunk, fieldUsageBySlot, activityProperties) {
        const props = activityProperties || Utils.getActivityProperties();
        const fieldProps = props[fieldName];
        
        if (!fieldProps || fieldProps.available === false) return false;
        
        // Check disabled fields (rainy day etc.)
        const disabledFields = window.currentDisabledFields || [];
        if (disabledFields.includes(fieldName)) return false;
        
        // Check global locks
        if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots)) {
            return false;
        }
        
        const maxCapacity = Utils.getFieldCapacity(fieldName, props);
        
        for (const slotIdx of slots) {
            const usage = fieldUsageBySlot?.[slotIdx]?.[fieldName];
            if (!usage) continue;
            
            // Count excluding the target bunk
            let count = usage.count;
            if (excludeBunk && usage.bunks[excludeBunk]) {
                count--;
            }
            
            if (count >= maxCapacity) return false;
        }
        
        return true;
    };

    // =================================================================
    // 7. BUNKS & DIVISIONS HELPERS (CONSOLIDATED)
    // =================================================================

    /**
     * Get all bunks for a division
     */
    Utils.getBunksForDivision = function(divisionName) {
        const divisions = window.divisions || {};
        return divisions[divisionName]?.bunks || [];
    };

    /**
     * Get divisions the current user can edit (RBAC-aware)
     */
    Utils.getMyDivisions = function() {
        if (window.PermissionsDB?.getEditableDivisions) {
            return window.PermissionsDB.getEditableDivisions();
        }
        
        // Fallback: all divisions if no RBAC
        return Object.keys(window.divisions || {});
    };

    /**
     * Check if user can edit a specific bunk
     */
    Utils.canEditBunk = function(bunkName) {
        if (window.PermissionsDB?.canEditBunk) {
            return window.PermissionsDB.canEditBunk(bunkName);
        }
        
        // Fallback: can edit all if no RBAC
        return true;
    };

    /**
     * Get all editable bunks for current user
     */
    Utils.getEditableBunks = function() {
        if (window.PermissionsDB?.getEditableBunks) {
            return window.PermissionsDB.getEditableBunks();
        }
        
        // Fallback: all bunks
        const allBunks = [];
        const divisions = window.divisions || {};
        for (const divData of Object.values(divisions)) {
            allBunks.push(...(divData.bunks || []));
        }
        return allBunks;
    };

    // =================================================================
    // 8. ESCAPE/FORMAT HELPERS (CONSOLIDATED)
    // =================================================================

    /**
     * Escape HTML to prevent XSS
     */
    Utils.escapeHtml = function(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    /**
     * Format a schedule entry for display
     */
    Utils.formatEntry = function(entry) {
        if (!entry) return '';
        
        const activity = entry._activity || entry.sport || '';
        const field = Utils.fieldLabel(entry.field) || '';
        
        if (activity && field && activity !== field) {
            return `${field} – ${activity}`;
        }
        
        return activity || field || '';
    };

    // =================================================================
    // 9. LEGACY COMPATIBILITY LAYER
    // =================================================================
    
    // These ensure old code still works while we migrate
    
    // Global function aliases (for code that calls window.getDivisionForBunk directly)
    window.getDivisionForBunk = Utils.getDivisionForBunk;
    window.getSlotTimeRange = Utils.getSlotTimeRange;
    window.findSlotIndexForTime = Utils.findSlotIndexForTime;
    window.findSlotsForRange = Utils.findSlotsForRange;
    window.getEntryForBlock = Utils.getEntryForBlock;
    window.buildFieldUsageBySlot = Utils.buildFieldUsageBySlot;
    window.isFieldAvailable = Utils.isFieldAvailable;
    window.getActivityProperties = Utils.getActivityProperties;
    window.getBunksForDivision = Utils.getBunksForDivision;
    window.getMyDivisions = Utils.getMyDivisions;
    window.canEditBunk = Utils.canEditBunk;
    window.getEditableBunks = Utils.getEditableBunks;
    window.minutesToTimeLabel = Utils.minutesToTimeLabel;
    window.escapeHtml = Utils.escapeHtml;
    window.formatEntry = Utils.formatEntry;

    // DivisionTimesSystem bridge (for code using window.DivisionTimesSystem)
    if (!window.DivisionTimesSystem) {
        window.DivisionTimesSystem = {};
    }
    window.DivisionTimesSystem.getDivisionForBunk = Utils.getDivisionForBunk;
    window.DivisionTimesSystem.getSlotsForDivision = Utils.getSlotsForDivision;
    window.DivisionTimesSystem.getSlotAtIndex = Utils.getSlotAtIndex;
    window.DivisionTimesSystem.findSlotForTime = Utils.findSlotForTime;
    window.DivisionTimesSystem.findSlotForTimeRange = Utils.findSlotForTimeRange;
    window.DivisionTimesSystem.getSlotsForBunk = Utils.getSlotsForBunk;
    window.DivisionTimesSystem.checkTimeOverlapConflict = Utils.checkTimeOverlapConflict;
    window.DivisionTimesSystem.findOverlappingDivisionSlots = Utils.findOverlappingDivisionSlots;
    window.SchedulerCoreUtils = Utils;

    // EXPOSE GLOBALLY FOR COMPATIBILITY
    window.FieldReservations = {
        getFromSkeleton: Utils.getFieldReservationsFromSkeleton,
        isReserved: Utils.isFieldReserved,
        parseTimeToMinutes: Utils.parseTimeToMinutes
    };

})();
