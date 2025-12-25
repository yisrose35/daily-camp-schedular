// ============================================================================
// scheduler_core_utils.js (FIXED v7 - ELECTIVE DIVISION LOCKS + DISABLED FIELDS)
// PART 1 of 3: THE FOUNDATION
//
// CRITICAL UPDATE:
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

    Utils.findSlotsForRange = function (startMin, endMin) {
        const slots = [];
        if (!window.unifiedTimes || startMin == null || endMin == null) return slots;

        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const slot = window.unifiedTimes[i];
            const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
            if (slotStart >= startMin && slotStart < endMin) slots.push(i);
        }
        return slots;
    };

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

    window.SchedulerCoreUtils = Utils;

    // EXPOSE GLOBALLY FOR COMPATIBILITY
    window.FieldReservations = {
        getFromSkeleton: Utils.getFieldReservationsFromSkeleton,
        isReserved: Utils.isFieldReserved,
        parseTimeToMinutes: Utils.parseTimeToMinutes
    };

})();
