// ============================================================================
// scheduler_core_utils.js (FIXED v7.6 - ENHANCED FIELD PROPERTY CHECKS)
//
// PART 1: THE FOUNDATION & CONSOLIDATED UTILITIES
//
// CRITICAL UPDATES:
// - v7.1: Type-coerced comparisons for bunk lookups
// - v7.2: Division-aware lock checking & string coercion
// - v7.3: RBAC FIX - Uses window.AccessControl
// - v7.4: REMOVED LEGACY UNIFIED TIMES FALLBACKS. Added robust cross-division
//         conflict detection and division-aware time helpers.
// - v7.5: ★★★ ENHANCED sharableWith.divisions check for custom sharing mode ★★★
//         ★★★ FIXED capacity calculation for type="all" (999 = unlimited) ★★★
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

    // ★ Day 19.5: display-name helper for multiPart activities.
    // Returns "Baking 1/3" when slot has _partLabel (stamped by the gen
    // for multiPart specials), otherwise falls back to _activity or field.
    // Use this anywhere render code needs the visible activity name —
    // schedule grid, print center, calendar, daily adjustments, etc.
    Utils.getActivityDisplayName = function (slot) {
        if (!slot) return '';
        // Per-cell display-name ALIAS (post-edit "rename for display only"):
        // show this instead of the real activity. _activity is left untouched so
        // rotation/counting still credit the underlying activity.
        if (slot._displayName) return slot._displayName;
        if (slot._partLabel) return slot._partLabel;
        if (slot._partNumber && slot._totalParts && slot._activity) {
            return slot._activity + ' ' + slot._partNumber + '/' + slot._totalParts;
        }
        return slot._activity || slot.field || slot.event || '';
    };
    // Also expose on window for non-Utils call sites
    if (typeof window !== 'undefined') {
        window.getActivityDisplayName = Utils.getActivityDisplayName;
    }

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
    Utils.findSlotsForRange = function (startMin, endMin, divisionOrBunk = null, bunkName = null) {
        const slots = [];
        if (startMin == null || endMin == null) return slots;

        if (divisionOrBunk && window.divisionTimes) {
            let divName = String(divisionOrBunk);

            if (!window.divisionTimes[divName]) {
                const divisions = window.divisions || {};
                const bunkStr = String(divisionOrBunk);
                for (const [dName, dData] of Object.entries(divisions)) {
                    if (dData.bunks?.some(b => String(b) === bunkStr)) {
                        divName = dName;
                        if (!bunkName) bunkName = bunkStr;
                        break;
                    }
                }
            }

            // ★★★ AUTO MODE ONLY: Per-bunk slots exist only when auto scheduler built them ★★★
            const hasPerBunkSlots = !!window.divisionTimes[divName]?._perBunkSlots;
            if (hasPerBunkSlots && bunkName) {
                const perBunkSlots = window.divisionTimes[divName]._perBunkSlots[String(bunkName)];
                if (perBunkSlots && perBunkSlots.length > 0) {
                    for (let i = 0; i < perBunkSlots.length; i++) {
                        const slot = perBunkSlots[i];
                        if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                            slots.push(i);
                        }
                    }
                    if (slots.length > 0) return slots;
                    // If per-bunk found nothing, fall through to division-level
                }
            }

            // ★ MANUAL MODE (and auto fallback): Division-level slots — unchanged ★
            const divSlots = window.divisionTimes[divName];
            if (divSlots && divSlots.length > 0) {
                for (let i = 0; i < divSlots.length; i++) {
                    const slot = divSlots[i];
                    if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                        slots.push(i);
                    }
                }
                return slots;
            }
        }

        if (divisionOrBunk) {
            console.warn(`[findSlotsForRange] No divisionTimes for: ${divisionOrBunk}`);
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

    Utils.getBlockTimeRange = function (block) {
        let blockStartMin = (typeof block.startTime === "number") ? block.startTime : null;
        let blockEndMin = (typeof block.endTime === "number") ? block.endTime : null;

        // ★ FIX: Use divisionTimes instead of unifiedTimes ★
        if ((!blockStartMin || !blockEndMin) && block.slots?.length) {
            const divName = block.divName || (block.bunk ? Utils.getDivisionForBunk(block.bunk) : null);
            const divTimes = divName ? window.divisionTimes?.[divName] : null;

            if (divTimes && divTimes.length > 0) {
                const minIndex = Math.min(...block.slots);
                const maxIndex = Math.max(...block.slots);
                const firstSlot = divTimes[minIndex];
                const lastSlot = divTimes[maxIndex];
                if (firstSlot && lastSlot) {
                    blockStartMin = firstSlot.startMin;
                    blockEndMin = lastSlot.endMin;
                }
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

    // ★★★ v18.0: Get transition rules from ZONE (locations.js) instead of field/activity ★★★
    // First, try to find the zone for this field
    const zone = window.getZoneForField?.(fieldName);
    if (zone && zone.transition) {
        return {
            ...base,
            preMin: zone.transition.preMin || 0,
            postMin: zone.transition.postMin || 0,
            zone: zone.name || base.zone,
            label: "Travel"
        };
    }

    // Fallback: check if it's a special activity with a location
    if (activityProperties) {
        const props = activityProperties[fieldName];
        if (props?.location) {
            // Find zone for the location
            const locZone = window.getZoneForField?.(props.location);
            if (locZone && locZone.transition) {
                return {
                    ...base,
                    preMin: locZone.transition.preMin || 0,
                    postMin: locZone.transition.postMin || 0,
                    zone: locZone.name || base.zone,
                    label: "Travel"
                };
            }
        }
    }

    // Final fallback: return base (no transition)
    return base;
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

            // Absolute grace, not a percentage: over-max is allowed only up to +2
            // (max+1 routine grace, max+2 last-resort). Anything beyond max+2 is a
            // hard violation — there must never be more than 2 extra players over
            // the maximum, even when two bunks play together on a shared field.
            if (excess > 2) {
                return {
                    valid: false,
                    reason: `Maximum ${reqs.maxPlayers} players (+2 grace), have ${playerCount}`,
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
            bunkList: [],
            divisions: []
        };

        if (!fieldUsageBySlot || !fieldUsageBySlot[slotIndex]) return result;

        const slotData = fieldUsageBySlot[slotIndex];
        const fieldData = slotData[fieldName];

        if (!fieldData) return result;

        result.count = fieldData.count || 0;
        result.bunks = fieldData.bunks || {};
        result.bunkList = Object.keys(result.bunks);
        result.divisions = fieldData.divisions || [];

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
            bunkList: [],
            divisions: []
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
                
                // Track divisions of existing users
                const bunkDiv = Utils.getDivisionForBunk(bunk);
                if (bunkDiv && !result.divisions.includes(bunkDiv)) {
                    result.divisions.push(bunkDiv);
                }
            }
        }

        return result;
    }
    
    // =================================================================
    // ★★★ NEW: GET FIELD CAPACITY (SINGLE SOURCE OF TRUTH) ★★★
    // =================================================================
   Utils.getFieldCapacity = function(fieldName, activityProperties) {
        // Resolve a single props object → its configured capacity.
        function _capFromProps(props) {
            if (!props) return null;
            // ★★★ v7.6: v3.0 sharing model ★★★
            if (props.sharableWith) {
                if (props.sharableWith.type === 'all') return parseInt(props.sharableWith.capacity) || 999;
                if (props.sharableWith.type === 'same_division') return parseInt(props.sharableWith.capacity) || 2;
                if (props.sharableWith.type === 'not_sharable') return 1;
                if (props.sharableWith.type === 'custom') return parseInt(props.sharableWith.capacity) || 2;
                if (props.sharableWith.capacity) return parseInt(props.sharableWith.capacity);
            }
            // Legacy sharable check
            if (props.sharable) return 2;
            return 1; // Default: not sharable
        }

        let cap = _capFromProps(activityProperties?.[fieldName]);
        if (cap == null) cap = 1;

        // ★★★ SHARED-ROOM MOST-RESTRICTIVE FIX (manual cap-bug, 2026-06-04) ★★★
        // activityProperties is keyed by activity/special NAME, so it only sees ONE
        // definition for a given location. But two specials can map to the SAME physical
        // room with DIFFERENT caps — e.g. "Arts & Crafts 3" (not_sharable, cap 1) and
        // "Arts and Crafts 3" (same_division, cap 2) both at room "Arts and Crafts 3".
        // The generator would read the laxer twin (cap 2) and overbook, while the
        // validator (location-keyed) flags cap 1. A physical room can only honor its
        // MOST RESTRICTIVE constraint, so when NO real facility-field owns this location
        // (field precedence preserved → a permissive field reused by a special is not
        // over-restricted), fold in the minimum cap across every special sharing it.
        try {
            const target = String(fieldName || '').toLowerCase().trim();
            if (target) {
                const gs = (typeof window !== 'undefined' && window.loadGlobalSettings)
                    ? window.loadGlobalSettings() : ((typeof window !== 'undefined' && window.globalSettings) || {});
                const fields = (gs.app1 && gs.app1.fields) || gs.fields || [];
                const hasField = fields.some(f => f && f.name && String(f.name).toLowerCase().trim() === target);
                if (!hasField) {
                    const specials = (gs.app1 && gs.app1.specialActivities) || gs.specialActivities || [];
                    for (let i = 0; i < specials.length; i++) {
                        const s = specials[i];
                        if (!s) continue;
                        const loc = String(s.location || s.name || '').toLowerCase().trim();
                        const nm = String(s.name || '').toLowerCase().trim();
                        if (loc !== target && nm !== target) continue;
                        const c = _capFromProps(s);
                        if (c != null && c < cap) cap = c;
                    }
                }
            }
        } catch (_e) { /* fall back to the base capacity */ }

        return cap;
    };

    // =================================================================
    // 7. MAIN FIT LOGIC (WITH DIVISION-AWARE LOCK CHECK)
    // =================================================================

    Utils.isTimeAvailable = function (slotIndex, props, divName) {
       if (!window.unifiedTimes?.[slotIndex]) return props.available !== false;
        const slot = window.unifiedTimes[slotIndex];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        const slotEnd = new Date(slot.end).getHours() * 60 + new Date(slot.end).getMinutes();

        // ★ Optional per-grade scoping. Most callers pre-filter timeRules by
        //   division before passing props in (see v7.7 callers); this is a
        //   safety net for any caller that hasn't.
        const myDiv = divName != null ? String(divName) : null;
        const rules = (props.timeRules || [])
            .filter(r => {
                const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                if (rDivs.length === 0) return true;
                if (!myDiv) return true;
                return rDivs.includes(myDiv);
            })
            .map(r => {
                if (typeof r.startMin === "number") return r;
                return {
                    ...r,
                    startMin: Utils.parseTimeToMinutes(r.start),
                    endMin: Utils.parseTimeToMinutes(r.end)
                };
            });

        if (rules.length === 0) return props.available !== false;
        if (!props.available) return false;

        // ★ Case-insensitive type match (see note at the main fit-check): tolerate
        //   lowercase 'available'/'unavailable' so config field timeRules are enforced.
        let allowed = !rules.some(r => String(r.type).toLowerCase() === "available");

        for (const rule of rules) {
            if (String(rule.type).toLowerCase() === "available" &&
                slotStart >= rule.startMin &&
                slotEnd <= rule.endMin) {
                allowed = true;
                break;
            }
        }

        if (!allowed) return false;

        for (const rule of rules) {
            if (String(rule.type).toLowerCase() === "unavailable" &&
                slotStart < rule.endMin &&
                slotEnd > rule.startMin) {
                return false;
            }
        }

        return true;
    };

    /**
     * =========================================================================
     * PER-DATE BUNK-ONLY ACTIVITY RESTRICTION (Daily Adjustments → Resources)
     * =========================================================================
     * "This activity/sport/facility is only available for these bunk(s) today."
     * Restriction-only (allow-list): if a matching restriction exists and this
     * bunk is NOT in its allow-list, the bunk is BLOCKED from that target.
     * Targets:
     *   - targetType 'special'/'sport' → matches the activity NAME (actName)
     *   - targetType 'facility'        → matches the FIELD/facility name
     * Data lives in the per-date Resources overrides
     * (dailyActivityBunkRestrictions), mirrored to the campResourceOverrides_<date>
     * localStorage blob — read with the same fallback as the sport-disable /
     * dailyFieldAvailability paths so it works post-gen and on fresh devices.
     * Fail-open: any read error or empty list → not restricted.
     * Shared by BOTH engines (manual/total via canBlockFit, auto via
     * calculateLimitScore / isSpecialAvailableForBunk / isFieldAvailable, and the
     * fill pass via auto_fill_slot.buildCandidates).
     */
    Utils.isBunkRestrictedFromTarget = function (bunkName, activityName, fieldName, divName) {
        if (!bunkName) return false;
        let list = (window.loadCurrentDailyData?.() || {}).dailyActivityBunkRestrictions;
        if (!Array.isArray(list) || list.length === 0) {
            // localStorage fallback (mirror of isFieldAvailable @ scheduler_core_auto.js:2818)
            try {
                const dk = window.currentScheduleDate || '';
                if (dk) {
                    const stored = localStorage.getItem('campResourceOverrides_' + dk);
                    if (stored) {
                        const p = JSON.parse(stored);
                        if (Array.isArray(p?.dailyActivityBunkRestrictions)) list = p.dailyActivityBunkRestrictions;
                    }
                }
            } catch (_e) { /* ignore */ }
        }
        if (!Array.isArray(list) || list.length === 0) return false;
        const actLc = activityName ? String(activityName).toLowerCase().trim() : null;
        const fldLc = fieldName ? String(fieldName).toLowerCase().trim() : null;
        const bunkStr = String(bunkName);
        for (const r of list) {
            if (!r || !r.target || !Array.isArray(r.bunks)) continue;
            const tLc = String(r.target).toLowerCase().trim();
            const isActTarget = (r.targetType === 'special' || r.targetType === 'sport') && actLc && tLc === actLc;
            const isFacTarget = (r.targetType === 'facility') && fldLc && tLc === fldLc;
            if (!isActTarget && !isFacTarget) continue;
            const allowed = r.bunks.some(b => String(b) === bunkStr);
            if (!allowed) return true; // matched a restriction, bunk not allowed → blocked
        }
        return false;
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
     * 5. ★★★ NEW: sharableWith.divisions check for custom sharing mode ★★★
     * 6. Capacity checks
     * 7. Player requirements (soft check)
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

        // ★ v6.0: Sport-to-field restriction check
        if (actName) {
            const dailyDisabledSports = (window.loadCurrentDailyData?.() || {}).dailyDisabledSportsByField || {};
            const blockedSports = dailyDisabledSports[fieldName];
            if (blockedSports && blockedSports.length > 0 && blockedSports.includes(actName)) {
                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - sport "${actName}" is disabled on this field today`);
                return false;
            }
        }

        // ★ PER-DATE BUNK-ONLY RESTRICTION — "only available for these bunk(s) today".
        //   Covers special/sport (actName) and facility (fieldName) targets for the
        //   manual + total-solver path. Allowed bunks pass; everyone else is blocked.
        if (Utils.isBunkRestrictedFromTarget(block.bunk, actName, fieldName, block.divName || block.division)) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - target reserved for other bunk(s) today (bunk-only restriction)`);
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
            sharableWith: { capacity: 1, type: "not_sharable", divisions: [] },
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
        // ★★★ ENHANCED CAPACITY CALCULATION (v7.5) ★★★
        // =================================================================
        let maxCapacity = Utils.getFieldCapacity(fieldName, activityProperties);
        
        // Basic availability checks
        if (effectiveProps.available === false) {
            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - not available`);
            return false;
        }

        // =================================================================
        // ★★★ LIMIT USAGE CHECK (Division & Bunk Restrictions) ★★★
        // =================================================================
        if (effectiveProps.accessRestrictions?.enabled) {
            const divisionRules = effectiveProps.accessRestrictions.divisions || {};
            // ★ Day 11 parity (#V2-15): enabled with EMPTY divisions = misconfig (toggle on,
            //   no grades picked) → treat as NO restriction, matching auto_solver_engine and
            //   total_solver_engine. Otherwise the division-not-in-{} check below blocks EVERY
            //   grade and makes the field unusable in manual only (auto leaves it open).
            if (Object.keys(divisionRules).length > 0) {
                // ★ Dual-key lookup: divisions may be keyed by string ("3") or
                //   the original grade type (3). Matches the auto solver's
                //   commitWriteIfLegal check at scheduler_core_auto.js:1426-1428.
                const _divNameStr = String(block.divName);
                if (!(_divNameStr in divisionRules) && !(block.divName in divisionRules)) {
                    if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - accessRestrictions: division ${block.divName} not in allowed list`);
                    return false;
                }
                const divRule = divisionRules[_divNameStr] || divisionRules[block.divName];
                if (Array.isArray(divRule) && divRule.length > 0) {
                    const bunkStr = String(block.bunk);
                    const bunkNum = parseInt(block.bunk);
                    const inList = divRule.some(b => String(b) === bunkStr || parseInt(b) === bunkNum);
                    if (!inList) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - accessRestrictions: bunk not in allowed list`);
                        return false;
                    }
                }
            }
        }

        // =================================================================
        // ★★★ TIME-BASED AVAILABILITY CHECK (timeRules) ★★★
        // Handles both "Available" (only during) and "Unavailable" (blocked during)
        // =================================================================
        if (effectiveProps.timeRules && effectiveProps.timeRules.length > 0) {
            const { blockStartMin, blockEndMin } = Utils.getBlockTimeRange ? 
                Utils.getBlockTimeRange(block) : 
                { blockStartMin: block.startTime, blockEndMin: block.endTime };
            
            if (blockStartMin != null && blockEndMin != null) {
                // Separate rules by type
                // ★ Case-insensitive type match (mirrors auto_fill_slot.js:129 +
                //   the DA iron-gate): config field timeRules can carry a lowercase
                //   `type` ('unavailable'/'available') from non-UI/older paths, which
                //   the capital-only comparison silently dropped → rule never enforced
                //   in manual mode (auto already lowercased). Brings manual to parity.
                const availableRules = effectiveProps.timeRules.filter(r => String(r.type).toLowerCase() === 'available' || r.available === true);
                const unavailableRules = effectiveProps.timeRules.filter(r => String(r.type).toLowerCase() === 'unavailable' || r.available === false);
                
                // ★★★ v7.7: Filter rules by division applicability ★★★
                const blockDivision = block.divName;
                const applicableAvailableRules = availableRules.filter(r =>
                    !r.divisions || r.divisions.length === 0 || r.divisions.includes(blockDivision)
                );
                const applicableUnavailableRules = unavailableRules.filter(r =>
                    !r.divisions || r.divisions.length === 0 || r.divisions.includes(blockDivision)
                );
                
                // If there are applicable "Available" rules, block must be WITHIN at least one
                if (applicableAvailableRules.length > 0) {
                    let withinAvailable = false;
                    
                    for (const rule of applicableAvailableRules) {
                        const ruleStart = rule.startMin ?? Utils.parseTimeToMinutes(rule.startTime || rule.start);
                        const ruleEnd = rule.endMin ?? Utils.parseTimeToMinutes(rule.endTime || rule.end);
                        
                        if (ruleStart == null || ruleEnd == null) continue;
                        
                        // Block must be completely within the available window
                        if (blockStartMin >= ruleStart && blockEndMin <= ruleEnd) {
                            withinAvailable = true;
                            break;
                        }
                    }
                    
                    if (!withinAvailable) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - not within any Available time window for division ${blockDivision}`);
                        return false;
                    }
                }
                
                // Check applicable "Unavailable" rules - block must NOT overlap
                for (const rule of applicableUnavailableRules) {
                    const ruleStart = rule.startMin ?? Utils.parseTimeToMinutes(rule.startTime || rule.start);
                    const ruleEnd = rule.endMin ?? Utils.parseTimeToMinutes(rule.endTime || rule.end);
                    
                    if (ruleStart == null || ruleEnd == null) continue;
                    
                    const overlaps = !(blockEndMin <= ruleStart || blockStartMin >= ruleEnd);
                    
                    if (overlaps) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - overlaps Unavailable ${ruleStart}-${ruleEnd}`);
                        return false;
                    }
                }
            }
        }
        
        // =================================================================
        // ★ COMBINED FIELD ENFORCEMENT
        // combined (A+B) requested → block if any sub-field is in use at any slot
        // sub-field (A) requested  → block if combined (A+B) is in use at any slot
        // =================================================================
        {
            let comboLookup = window.getFieldComboLookup?.();
            if (!comboLookup || Object.keys(comboLookup.combinedToSubs || {}).length === 0) {
                const _gs = window.loadGlobalSettings?.() || {};
                const _fc = _gs.app1?.fieldCombos || _gs.fieldCombos || {};
                const _entries = Object.values(_fc);
                if (_entries.length > 0) {
                    comboLookup = { combinedToSubs: {}, subToCombined: {} };
                    for (const combo of _entries) {
                        if (!combo.combinedField || !Array.isArray(combo.subFields)) continue;
                        const cN = combo.combinedField.toLowerCase().trim();
                        comboLookup.combinedToSubs[cN] = combo.subFields.slice();
                        for (const sub of combo.subFields) {
                            comboLookup.subToCombined[sub.toLowerCase().trim()] = combo.combinedField;
                        }
                    }
                }
            }
            if (comboLookup) {
                const normFn = (n) => (n || '').toLowerCase().trim();
                const normField = normFn(fieldName);

                // Case 1: this IS the combined field — reject if any sub-field is occupied
                const subs = comboLookup.combinedToSubs[normField];
                if (subs) {
                    for (const subField of subs) {
                        for (const idx of uniqueSlots) {
                            const subUsage = getFieldUsageAtSlot(idx, subField, fieldUsageBySlot);
                            const subSched  = getScheduleUsageAtSlot(idx, subField);
                            if ((subUsage.bunkList?.length || 0) > 0 || (subSched.bunkList?.length || 0) > 0) {
                                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - combined field blocked by sub-field ${subField} at slot ${idx}`);
                                return false;
                            }
                        }
                    }
                }

                // Case 2: this IS a sub-field — reject if its combined field is occupied
                const combinedField = comboLookup.subToCombined[normField];
                if (combinedField) {
                    for (const idx of uniqueSlots) {
                        const comboUsage = getFieldUsageAtSlot(idx, combinedField, fieldUsageBySlot);
                        const comboSched  = getScheduleUsageAtSlot(idx, combinedField);
                        if ((comboUsage.bunkList?.length || 0) > 0 || (comboSched.bunkList?.length || 0) > 0) {
                            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - sub-field blocked by combined field ${combinedField} at slot ${idx}`);
                            return false;
                        }
                    }
                }
            }
        }

        // =================================================================
        // ★ INSTRUCTOR (RUN-BY) CONFLICT
        // Two activities tagged with the same `instructor` cannot occupy the
        // same slot — the same person can't be in two places at once.
        // Same-activity at the same slot for two bunks is NOT a conflict
        // (that's capacity sharing of one class by the same instructor).
        // =================================================================
        {
            const _normInstr = (s) => (s == null ? '' : String(s)).toLowerCase().trim();
            const _candAct   = _normInstr(actName || effectiveProps?._activityName || '');
            const _instrMap  = Utils._buildInstructorMap ? Utils._buildInstructorMap() : (function () {
                const map = {};
                try {
                    const settings = window.loadGlobalSettings?.() || {};
                    [
                        ...((settings.app1 && settings.app1.specialActivities) || []),
                        ...(settings.specialActivities || [])
                    ].forEach(s => {
                        if (s && s.name && typeof s.instructor === 'string' && s.instructor.trim()) {
                            map[s.name.toLowerCase().trim()] = s.instructor.trim().toLowerCase();
                        }
                    });
                    (settings.facilities || []).forEach(f => (f.generalActivities || []).forEach(ga => {
                        if (ga && ga.name && typeof ga.instructor === 'string' && ga.instructor.trim()) {
                            map[ga.name.toLowerCase().trim()] = ga.instructor.trim().toLowerCase();
                        }
                    }));
                } catch {}
                return map;
            })();
            const _myInstr = _candAct ? _instrMap[_candAct] : null;
            if (_myInstr) {
                const _sched = window.scheduleAssignments || {};
                for (const idx of uniqueSlots) {
                    for (const otherBunk in _sched) {
                        if (otherBunk === block.bunk) continue;
                        const slots = _sched[otherBunk];
                        const e = slots && slots[idx];
                        if (!e) continue;
                        const otherAct = e._activity || e._assignedSpecial || (typeof e.activity === 'string' ? e.activity : null) || (typeof e.sport === 'string' ? e.sport : null);
                        if (!otherAct) continue;
                        const _otherActNorm = _normInstr(otherAct);
                        if (_otherActNorm === _candAct) continue; // same activity = capacity-share, not a conflict
                        const _otherInstr = _instrMap[_otherActNorm];
                        if (_otherInstr && _otherInstr === _myInstr) {
                            if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName} (${actName}): REJECTED - instructor "${_myInstr}" already running "${otherAct}" for ${otherBunk} at slot ${idx}`);
                            return false;
                        }
                    }
                }
            }
        }

        // =================================================================
        // CHECK EACH SLOT FOR CAPACITY AND ACTIVITY MATCHING
        // =================================================================
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || Utils._bunkMetaData || {};
        const sportMeta = window.getSportMetaData?.() || window.sportMetaData || Utils._sportMetaData || {};
        const mySize = bunkMeta[block.bunk]?.size || 0;
        const myDivision = block.divName || Utils.getDivisionForBunk(block.bunk);

        // ★★★ v7.7: Create division-filtered props for isTimeAvailable ★★★
        const divFilteredProps = { ...effectiveProps };
        if (divFilteredProps.timeRules && divFilteredProps.timeRules.length > 0) {
            divFilteredProps.timeRules = divFilteredProps.timeRules.filter(r =>
                !r.divisions || r.divisions.length === 0 || r.divisions.includes(myDivision)
            );
        }

        for (const idx of uniqueSlots) {
            const trackedUsage = getFieldUsageAtSlot(idx, fieldName, fieldUsageBySlot);
            const scheduleUsage = getScheduleUsageAtSlot(idx, fieldName);

            const allBunks = new Set([...trackedUsage.bunkList, ...scheduleUsage.bunkList]);
            const allActivities = new Set([...trackedUsage.activities, ...scheduleUsage.activities]);
            const allDivisions = [...new Set([...trackedUsage.divisions, ...scheduleUsage.divisions])];

            allBunks.delete(block.bunk);

            const currentCount = allBunks.size;

            // STRICT CAPACITY CHECK
            // ★ PER-GRADE SHARING OVERRIDE: effective capacity/type for this grade
            const gradeShareOverride = effectiveProps.gradeShareRules?.[myDivision];
            const effectiveShareType = gradeShareOverride
                ? (gradeShareOverride.type || 'not_sharable')
                : (effectiveProps.sharableWith?.type || 'not_sharable');
            const effectiveCap = gradeShareOverride
                ? (parseInt(gradeShareOverride.capacity) || (gradeShareOverride.type === 'not_sharable' ? 1 : 2))
                : maxCapacity;

            if (currentCount >= effectiveCap) {
                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - at effective capacity (${currentCount}/${effectiveCap}) [gradeOverride=${!!gradeShareOverride}]`);
                return false;
            }

            if (effectiveShareType === 'not_sharable' && currentCount > 0) {
                if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - gradeShareRule: not_sharable for ${myDivision}`);
                return false;
            }

            // =================================================================
            // ★★★ v7.6: same_division ENFORCEMENT ★★★
            // When type="same_division", ONLY bunks from the same division can share
            // =================================================================
            if (effectiveShareType === 'same_division' && currentCount > 0) {
                for (const existingDiv of allDivisions) {
                    if (existingDiv !== myDivision) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - same_division: existing division ${existingDiv} != my division ${myDivision}`);
                        return false;
                    }
                }
            }

            // =================================================================
            // ★ Day 10: cross_division ("Grade Pairs") — mirror BOTH solvers
            //   (total_solver_engine isCrossDivAllowedManual + auto_solver_engine).
            //   Cross-grade co-occupancy is allowed ONLY for grade pairs the user
            //   enabled in allowedPairs (capacity already capped above). Without this,
            //   the FILLERS (scheduler_logic_fillers call canBlockFit) could place a
            //   non-allowed cross-grade pair the main solver would reject.
            // =================================================================
            if (effectiveShareType === 'cross_division' && currentCount > 0) {
                const _pairs = (effectiveProps.sharableWith && effectiveProps.sharableWith.allowedPairs) || {};
                for (const existingDiv of allDivisions) {
                    if (existingDiv === myDivision) continue;
                    const _key = [myDivision, existingDiv].sort().join('|');
                    if (_pairs[_key] !== true) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - cross_division pair not allowed: ${_key}`);
                        return false;
                    }
                }
            }

            // =================================================================
            // ★★★ v7.5: sharableWith.divisions CHECK FOR CUSTOM SHARING ★★★
            // When type="custom", only allow sharing with specified divisions
            // =================================================================
            if (effectiveProps.sharableWith?.type === 'custom' && !gradeShareOverride && currentCount > 0) {
                const allowedDivisions = effectiveProps.sharableWith.divisions || [];
                
                // Check if MY division is in the allowed list
                if (allowedDivisions.length > 0 && !allowedDivisions.includes(myDivision)) {
                    if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - sharableWith.divisions: my division ${myDivision} not in allowed list [${allowedDivisions.join(', ')}]`);
                    return false;
                }
                
                // Check if EXISTING users' divisions are in the allowed list
                for (const existingDiv of allDivisions) {
                    if (allowedDivisions.length > 0 && !allowedDivisions.includes(existingDiv)) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - sharableWith.divisions: existing division ${existingDiv} not compatible`);
                        return false;
                    }
                }
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

            // =================================================================
            // ★ SPORT maxPlayers — combined-headcount cap when SHARING a field.
            //   The capacity check above limits the BUNK COUNT; a sport's
            //   maxPlayers (rules.js sportMetaData) limits the combined PLAYER
            //   count. Auto-builder share/fill paths could add a 2nd same-division
            //   bunk that passes the count cap yet pushes combined headcount over
            //   the sport max (e.g. 15+11=26 players on a max-20 sport). Enforce
            //   here at the shared fit-check so BOTH builders honor it. Gated to
            //   actual sharing (currentCount>0) with known sizes; a lone bunk over
            //   max is unaffected (maxPlayers is a "combined when shared" cap).
            // =================================================================
            if (currentCount > 0 && mySize > 0 && actName) {
                const _spReq = sportMeta[actName] || sportMeta[actName.toLowerCase()];
                const _spMax = _spReq ? (parseInt(_spReq.maxPlayers) || 0) : 0;
                if (_spMax > 0) {
                    let _combinedPlayers = mySize;
                    for (const _ob of allBunks) { _combinedPlayers += (bunkMeta[_ob]?.size || 0); }
                    // Absolute combined ceiling = maxPlayers + 2 (max+1 routine grace,
                    // max+2 last-resort, never max+3+). Mirrors the auto engines and
                    // auto_fill_slot so the shared fit-check doesn't hard-block legal grace.
                    if (_combinedPlayers > _spMax + 2) {
                        if (DEBUG_FITS) console.log(`[FIT] ${block.bunk} - ${fieldName}: REJECTED - sport maxPlayers combined ${_combinedPlayers} > ${_spMax}+2`);
                        return false;
                    }
                }
            }

           if (!Utils.isTimeAvailable(idx, divFilteredProps)) {
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

        // ★★★ COMBINED FIELD MUTUAL EXCLUSION CHECK ★★★
        if (window.FieldCombos?.isInCombo?.(fieldName)) {
            const cStartMin = block.startTime ?? block.startMin;
            const cEndMin = block.endTime ?? block.endMin;
            if (cStartMin != null && cEndMin != null) {
                const comboCheck = window.FieldCombos.isBlockedByCombo(fieldName, cStartMin, cEndMin, block.bunk);
                if (comboCheck.blocked) {
                    if (DEBUG_FITS) console.log('[FIT] ' + block.bunk + ' - ' + fieldName + ': REJECTED - COMBO blocked by "' + comboCheck.blocker + '"');
                    return false;
                }
            } else if (uniqueSlots.length > 0) {
                const divCtx = block.divName || block.division;
                if (window.FieldCombos.isBlockedByComboAtSlots(fieldName, uniqueSlots, divCtx, block.bunk)) {
                    if (DEBUG_FITS) console.log('[FIT] ' + block.bunk + ' - ' + fieldName + ': REJECTED - COMBO blocked (slot-based)');
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
        console.log('  - type:', props?.sharableWith?.type);
        console.log('  - divisions:', props?.sharableWith?.divisions);
        console.log('  - capacity:', props?.sharableWith?.capacity);
        console.log('Calculated Capacity:', Utils.getFieldCapacity(fieldName, window.activityProperties));
        console.log('TimeRules:', props?.timeRules);
        console.log('LimitUsage:', props?.accessRestrictions);
        console.log('RainyDayAvailable:', props?.rainyDayAvailable);
        console.log('Activities:', props?.activities);

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
        
        // Check disabled status
        const disabledFields = window.currentDisabledFields || [];
        console.log('Disabled (rainy day):', disabledFields.includes(fieldName));
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
    // CONSOLIDATED UTILITY FUNCTIONS (INTEGRATED)
    // ============================================================================
    
    // =================================================================
    // 9. DIVISION-AWARE CORE FUNCTIONS (CONSOLIDATED)
    // =================================================================

    /**
     * Get the division name for a bunk
     * SINGLE SOURCE OF TRUTH - remove from all other files
     * * ★★★ FIX v7.1: Uses type-coerced comparison to handle number/string mismatch ★★★
     * This fixes the issue where bunks stored as numbers (e.g., [9, 10, 11])
     * weren't found when looked up as strings (e.g., "9")
     * * @param {string|number} bunkName - The bunk to look up
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
    // ★★★ CB-73: resolve the correct slot array for a bunk-OR-division. When a
    // BUNK with per-bunk geometry (auto mode) is given, return THAT bunk's
    // _perBunkSlots timeline; otherwise the division-level array. The index→time
    // helpers below used to always read divisionTimes[div], so for a per-bunk
    // schedule whose timeline differs from the division table they returned the
    // wrong slot / time / activity. Falls back to the flat division array (manual
    // geometry) and to [] for a per-bunk object addressed without a bunk (which
    // was never validly iterable anyway).
    Utils._resolveSlotArray = function(bunkOrDiv) {
        if (bunkOrDiv == null) return [];
        const key = String(bunkOrDiv);
        const dt = window.divisionTimes || {};
        const grade = Utils.getDivisionForBunk ? Utils.getDivisionForBunk(key) : null;
        if (grade) {
            const pbs = (window._perBunkSlots && window._perBunkSlots[grade] && window._perBunkSlots[grade][key])
                || (dt[grade] && dt[grade]._perBunkSlots && dt[grade]._perBunkSlots[key]);
            if (Array.isArray(pbs) && pbs.length) return pbs;
            if (Array.isArray(dt[grade])) return dt[grade];
            return [];
        }
        if (Array.isArray(dt[key])) return dt[key];
        return [];
    };

    Utils.getSlotsForDivision = function(divisionName) {
        // ★★★ CB-73: per-bunk aware (was: divisionTimes[div] || []).
        return Utils._resolveSlotArray(divisionName);
    };

    /**
     * Get slot at a specific index for a division
     * * @param {string} divisionName - Division name
     * @param {number} slotIndex - Slot index
     * @returns {Object|null} Slot object or null
     */
    Utils.getSlotAtIndex = function(divisionName, slotIndex) {
        // ★★★ CB-73: per-bunk aware when a bunk is passed (else division-level).
        return Utils._resolveSlotArray(divisionName)[slotIndex] || null;
    };

    /**
     * Get time range for a slot (DIVISION-AWARE)
     * SINGLE SOURCE OF TRUTH - replaces all getSlotTimeRange implementations
     * * @param {number} slotIdx - Slot index
     * @param {string} [bunkOrDiv] - Optional bunk name or division name for division-specific lookup
     * @returns {Object} { startMin, endMin } or { startMin: null, endMin: null }
     */
    Utils.getSlotTimeRange = function(slotIdx, bunkOrDiv) {
        // ★★★ CB-73: per-bunk aware. _resolveSlotArray returns the bunk's own
        // _perBunkSlots timeline when bunkOrDiv is a per-bunk auto-mode bunk,
        // else the division-level array. Previously it converted a bunk to its
        // division and read divisionTimes[div][slotIdx] — wrong window for a
        // per-bunk schedule whose timeline differs from the division table.
        if (bunkOrDiv) {
            const slot = Utils._resolveSlotArray(bunkOrDiv)[slotIdx];
            if (slot) {
                return { startMin: slot.startMin, endMin: slot.endMin };
            }
        }
        // No fallback - division/bunk context is required
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
        
        // Legacy array support (deprecated)
        if (Array.isArray(unifiedTimesOrDivision)) {
            console.warn('[findSlotIndexForTime] Array param is deprecated - pass division name');
            for (let i = 0; i < unifiedTimesOrDivision.length; i++) {
                const slotStart = Utils._getSlotStartMin(unifiedTimesOrDivision[i]);
                if (slotStart === targetMin) return i;
            }
        }
        return -1;
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
        // ★★★ CB-73: pass the BUNK (not its division) so findSlotForTime →
        // getSlotsForDivision → _resolveSlotArray uses the bunk's own per-bunk
        // timeline in auto mode. _resolveSlotArray falls back to the division
        // array when there's no per-bunk geometry, so manual mode is unchanged.
        return Utils.findSlotForTime(bunkName, targetMin);
    };

    // =================================================================
    // 10. CROSS-DIVISION CONFLICT DETECTION (CONSOLIDATED)
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
    // 11. TIME FORMATTING UTILITIES (CONSOLIDATED)
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
    // 12. ACTIVITY PROPERTIES UTILITIES (CONSOLIDATED)
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
                    capacity: Utils.getFieldCapacity(f.name, { [f.name]: f }),
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

    // =================================================================
    // 13. FIELD USAGE TRACKING (CONSOLIDATED)
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
    // 14. BUNKS & DIVISIONS HELPERS (CONSOLIDATED)
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
     * ★★★ FIX v7.3: Use AccessControl instead of deprecated PermissionsDB ★★★
     */
    Utils.canEditBunk = function(bunkName) {
        // Delegate to AccessControl (the correct RBAC system)
        if (window.AccessControl?.canEditBunk) {
            return window.AccessControl.canEditBunk(bunkName);
        }
        
        // Fallback: owner/admin can edit all
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') return true;
        
        // Fallback check for old PermissionsDB
        if (window.PermissionsDB?.canEditBunk) {
            return window.PermissionsDB.canEditBunk(bunkName);
        }
        
        // No RBAC = allow all
        return true;
    };

    /**
     * Get all editable bunks for current user
     * ★★★ FIX v7.3: Use AccessControl instead of deprecated PermissionsDB ★★★
     */
    Utils.getEditableBunks = function() {
        // Delegate to AccessControl
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        
        // If we have editable divisions, get bunks from them
        if (editableDivisions.length > 0) {
            const divisions = window.divisions || {};
            const bunks = [];
            for (const divName of editableDivisions) {
                const divInfo = divisions[divName] || divisions[String(divName)];
                if (divInfo?.bunks) {
                    bunks.push(...divInfo.bunks.map(String));
                }
            }
            return bunks;
        }
        
        // Fallback check for old PermissionsDB
        if (window.PermissionsDB?.getEditableBunks) {
            return window.PermissionsDB.getEditableBunks();
        }
        
        // Fallback: owner/admin or no RBAC -> all bunks
        const role = window.AccessControl?.getCurrentRole?.();
        if (!window.AccessControl || role === 'owner' || role === 'admin') {
            const allBunks = [];
            const divisions = window.divisions || {};
            for (const divData of Object.values(divisions)) {
                allBunks.push(...(divData.bunks || []).map(String));
            }
            return allBunks;
        }
        
        return [];
    };

    // =================================================================
    // 15. ESCAPE/FORMAT HELPERS (CONSOLIDATED)
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
        // Display-name ALIAS = exact cell text; show it verbatim, no location appended.
        if (entry._displayName) return entry._displayName;

        const activity = entry._activity || entry.sport || '';
        const field = Utils.fieldLabel(entry.field) || '';

        if (activity && field && activity !== field) {
            return `${field} – ${activity}`;
        }

        return activity || field || '';
    };

    // =========================================================================
    // NEW: Division-aware helpers
    // =========================================================================
    
    Utils.getSlotCountForBunk = function(bunkName) {
        const divName = Utils.getDivisionForBunk(bunkName);
        return window.divisionTimes?.[divName]?.length || 0;
    };
    
    Utils.checkTimeOverlap = function(start1, end1, start2, end2) {
        return !(end1 <= start2 || start1 >= end2);
    };

    // Slice 3 audit fix (N16): dual-key divisions lookup. The auto pipeline
    // has ~40 sites that read `divisions[grade]?.startTime` directly. If
    // `grade` ever arrives as a number when `divisions` is keyed by
    // string (or vice versa), the optional chain returns undefined, the
    // parse returns null, and the `|| 540 / || 960` literal default
    // silently kicks in — schedule uses the wrong day-window hours.
    // Use this helper at any time-lookup site to be type-tolerant.
    Utils.getDivisionRecord = function(grade) {
        const divs = window.divisions || {};
        if (grade == null) return null;
        return divs[grade] || divs[String(grade)] || null;
    };
    Utils.getDivisionTimes = function(grade) {
        const dt = window.divisionTimes || {};
        if (grade == null) return null;
        return dt[grade] || dt[String(grade)] || null;
    };

    // =================================================================
    // 16. LEGACY COMPATIBILITY LAYER
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
    
    // ★★★ FIX v7.3: Add minutesToTimeString to exports ★★★
    window.minutesToTimeString = Utils.minutesToTimeString;

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

    // =================================================================
    // 17. ACTIVITY ROTATION TRACKING (CONSOLIDATED - SINGLE SOURCE OF TRUTH)
    // =================================================================

    /**
     * Get all activities done by a bunk TODAY (before a specific slot)
     * SINGLE SOURCE OF TRUTH - all other files should delegate to this
     * @param {string} bunkName
     * @param {number} beforeSlotIndex
     * @returns {Set<string>} - lowercase activity names
     */
    Utils.getActivitiesDoneToday = function(bunkName, beforeSlotIndex) {
        const activities = new Set();
        const schedule = window.scheduleAssignments?.[bunkName] || [];

        for (let i = 0; i < beforeSlotIndex && i < schedule.length; i++) {
            const entry = schedule[i];
            if (entry && entry._activity && !entry._isTransition && !entry.continuation) {
                const _al = entry._activity.toLowerCase().trim();
                if (_al !== 'free' && _al !== 'free play' && !_al.includes('transition')) {
                    activities.add(_al);
                }
            }
        }

        return activities;
    };

    /**
     * Get activities done by a bunk YESTERDAY
     * @param {string} bunkName
     * @returns {Set<string>}
     */
    Utils.getActivitiesDoneYesterday = function(bunkName) {
        const activities = new Set();

        try {
            const allDaily = window.loadAllDailyData?.() || {};
            const currentDate = window.currentScheduleDate || window.currentDate;

            if (!currentDate) return activities;

            const [Y, M, D] = currentDate.split('-').map(Number);
            const yesterday = new Date(Y, M - 1, D);
            yesterday.setDate(yesterday.getDate() - 1);

            const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

            const yesterdayData = allDaily[yesterdayStr];
            if (!yesterdayData?.scheduleAssignments?.[bunkName]) return activities;

            const schedule = yesterdayData.scheduleAssignments[bunkName];
            for (const entry of schedule) {
                if (entry && entry._activity && !entry._isTransition && !entry.continuation) {
                    activities.add(entry._activity.toLowerCase().trim());
                }
            }
        } catch (e) {
            console.warn('[SchedulerCoreUtils] Error getting yesterday activities:', e);
        }

        return activities;
    };

    /**
     * Get the last time a bunk did a specific activity (days ago)
     * Returns null if never done, 0 if done today, 1 if yesterday, etc.
     * @param {string} bunkName
     * @param {string} activityName
     * @param {number} beforeSlotIndex
     * @returns {number|null}
     */
    Utils.getDaysSinceActivity = function(bunkName, activityName, beforeSlotIndex) {
        const actLower = (activityName || '').toLowerCase().trim();

        // Check today first
        const todayActivities = Utils.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0; // Done today
        }

        // Check rotation history for timestamps
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName] || bunkHistory[actLower];

        if (lastTimestamp) {
            const now = Date.now();
            const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
            return Math.max(1, daysSince);
        }

        // Check historical counts as fallback - if count > 0, they've done it sometime
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        if (historicalCounts[bunkName]?.[activityName] > 0 || historicalCounts[bunkName]?.[actLower] > 0) {
            return 14; // Assume 2 weeks ago if count exists but no timestamp
        }

        return null; // Never done
    };

    /**
     * Get total count of how many times a bunk has done an activity
     * Combines historicalCounts + manualUsageOffsets
     * @param {string} bunkName
     * @param {string} activityName
     * @returns {number}
     */
    Utils.getActivityCount = function(bunkName, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};

        const bunkCounts = historicalCounts[bunkName];
        let baseCount = bunkCounts?.[activityName] || 0;
        if (baseCount === 0 && bunkCounts) {
            const lower = activityName.toLowerCase();
            for (const key in bunkCounts) {
                if (key.toLowerCase() === lower) { baseCount = bunkCounts[key]; break; }
            }
        }
        const bunkOffsets = manualOffsets[bunkName];
        let offset = bunkOffsets?.[activityName] || 0;
        if (offset === 0 && bunkOffsets) {
            const lower = activityName.toLowerCase();
            for (const key in bunkOffsets) {
                if (key.toLowerCase() === lower) { offset = bunkOffsets[key]; break; }
            }
        }

        return Math.max(0, baseCount + offset);
    };

    /**
     * Get average activity count for a bunk across all activities
     * @param {string} bunkName
     * @param {string[]} allActivityNames
     * @returns {number}
     */
    Utils.getBunkAverageActivityCount = function(bunkName, allActivityNames) {
        if (!allActivityNames || allActivityNames.length === 0) return 0;

        let total = 0;
        for (const act of allActivityNames) {
            total += Utils.getActivityCount(bunkName, act);
        }

        return total / allActivityNames.length;
    };

    /**
     * Get camp dates config (if set by owner on the dashboard).
     * Returns { startDate, half1End, half2Start, endDate } or null.
     */
    Utils.getCampDates = function() {
        const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        const cd = gs.campDates || (window.loadGlobalSettings ? window.loadGlobalSettings('campDates') : null);
        if (cd && cd.startDate) return cd;
        return null;
    };

    /**
     * Compute the start date of the current N-week period, anchored to camp
     * start date if configured, else rolling calendar windows.
     * @param {string} period - '1week','2weeks','3weeks','4weeks','half'
     * @param {string} [refDate] - reference date (ISO), defaults to today
     * @returns {string|null} ISO date string
     */
    Utils.getPeriodStartDate = function(period, refDate) {
        var today = refDate || (window.currentScheduleDate
            ? (typeof window.currentScheduleDate === 'string' ? window.currentScheduleDate : window.currentScheduleDate.toISOString().slice(0, 10))
            : new Date().toISOString().slice(0, 10));
        var cd = Utils.getCampDates();

        if (period === 'half' || (!period)) {
            if (cd) {
                var curParts = today.split('-').map(Number);
                var curD = new Date(curParts[0], curParts[1] - 1, curParts[2]);
                if (cd.half2Start && curD >= new Date(cd.half2Start + 'T00:00:00')) return cd.half2Start;
                // ★ FIX: if refDate is BEFORE camp startDate (e.g. pre-camp
                // staging/test runs), returning cd.startDate causes
                // getPeriodActivityCount to filter out ALL historical dates
                // (every dateKey < periodStart), so the count is always 0
                // and maxUsage/exactFrequency caps go unenforced.
                // Only anchor to campStart when we're actually inside the
                // camp window. Before camp starts, use a rolling fallback
                // (return null → no date filter → count entire local
                // history, which is the conservative, safe behavior).
                if (cd.startDate) {
                    var _startD = new Date(cd.startDate + 'T00:00:00');
                    if (curD >= _startD) return cd.startDate;
                    // fall through to local settings fallback below
                }
            }
            var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var s = gs.app1 || gs;
            return s.halfStartDate || s.currentHalfStart || s.sessionHalfStart || null;
        }

        // ★ FIX: accept 'week' as an alias for '1week'. Several specials in
        // the config use the legacy 'week' string. Without this alias,
        // nWeeks=0 → return null → getPeriodActivityCount applies no period
        // filter → counts the ENTIRE local history. That makes a per-week
        // cap behave like a lifetime cap (overly strict, blocks the special
        // forever after first use ever).
        var nWeeks = (period === '1week' || period === 'week') ? 1
                   : period === '2weeks' ? 2
                   : period === '3weeks' ? 3
                   : period === '4weeks' ? 4
                   : 0;
        if (nWeeks === 0) return null;

        if (cd && cd.startDate) {
            var campStart = new Date(cd.startDate + 'T00:00:00');
            var todayParts = today.split('-').map(Number);
            var cur = new Date(todayParts[0], todayParts[1] - 1, todayParts[2]);
            var daysSinceStart = Math.floor((cur - campStart) / 86400000);
            if (daysSinceStart >= 0) {
                var weeksSinceStart = Math.floor(daysSinceStart / 7);
                var periodIndex = Math.floor(weeksSinceStart / nWeeks);
                var periodStartDay = periodIndex * nWeeks * 7;
                var periodDate = new Date(campStart);
                periodDate.setDate(periodDate.getDate() + periodStartDay);
                return periodDate.getFullYear() + '-' + String(periodDate.getMonth() + 1).padStart(2, '0') + '-' + String(periodDate.getDate()).padStart(2, '0');
            }
        }

        // Fallback: rolling calendar window from Monday
        var parts = today.split('-').map(Number);
        var d = new Date(parts[0], parts[1] - 1, parts[2]);
        var dow = d.getDay();
        var daysToMon = dow === 0 ? 6 : dow - 1;
        d.setDate(d.getDate() - daysToMon - ((nWeeks - 1) * 7));
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    /**
     * Period-aware activity count: how many days within the given period has
     * this bunk done this activity? Scans allDailyData.
     * @param {string} bunk
     * @param {string} activityName
     * @param {string} period - '1week','2weeks','3weeks','4weeks','half'
     * @param {string} [refDate]
     * @returns {number}
     */
    Utils.getPeriodActivityCount = function(bunk, activityName, period, refDate) {
        var today = refDate || (window.currentScheduleDate
            ? (typeof window.currentScheduleDate === 'string' ? window.currentScheduleDate : window.currentScheduleDate.toISOString().slice(0, 10))
            : new Date().toISOString().slice(0, 10));
        var periodStart = Utils.getPeriodStartDate(period, today);
        var allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
        var count = 0;
        Object.keys(allDaily).forEach(function(dateKey) {
            if (dateKey >= today) return;
            if (periodStart && dateKey < periodStart) return;
            var slots = allDaily[dateKey]?.scheduleAssignments?.[bunk];
            if (!Array.isArray(slots)) return;
            if (slots.some(function(e) { return e && !e.continuation && (e._activity === activityName || e.field === activityName); })) count++;
        });
        // ★★★ CB-66: also consult cloud rotation_counts (per-date). The local scan
        // above reads only campDailyData_v1, so on a SECOND DEVICE (no local dates)
        // or after the documented local-quota save-skip, period caps
        // (maxUsage/exactFrequency per 'half'/'Nweek') silently UNDER-enforce. Take
        // the MAX of local and a cloud period-count (count of distinct in-window
        // dates where rotation_counts has this bunk+activity). MAX avoids
        // double-counting dates present in both sources; it never lowers the local
        // count, so it can only tighten (never loosen) the hard cap.
        try {
            var _cbd66 = (window.RotationCloud && window.RotationCloud.getCachedCountsByDate)
                ? window.RotationCloud.getCachedCountsByDate() : null;
            if (_cbd66) {
                var _cloudCount66 = 0;
                Object.keys(_cbd66).forEach(function(dateKey) {
                    if (dateKey >= today) return;
                    if (periodStart && dateKey < periodStart) return;
                    var _byB = _cbd66[dateKey] && _cbd66[dateKey][bunk];
                    if (_byB && (_byB[activityName] || 0) > 0) _cloudCount66++;
                });
                if (_cloudCount66 > count) count = _cloudCount66;
            }
        } catch (_e66) { /* non-fatal — local count stands */ }
        return count;
    };

    /**
     * Determine the end date of the current period.
     */
    Utils.getPeriodEndDate = function(period, refDate) {
        var today = refDate || (window.currentScheduleDate
            ? (typeof window.currentScheduleDate === 'string' ? window.currentScheduleDate : window.currentScheduleDate.toISOString().slice(0, 10))
            : new Date().toISOString().slice(0, 10));
        var cd = Utils.getCampDates();

        if (period === 'half') {
            if (cd) {
                var curD = new Date(today + 'T00:00:00');
                if (cd.half2Start && curD >= new Date(cd.half2Start + 'T00:00:00')) {
                    return cd.endDate || null;
                }
                return cd.half1End || cd.endDate || null;
            }
            return null;
        }

        var nWeeks = period === '1week' ? 1 : period === '2weeks' ? 2 : period === '3weeks' ? 3 : period === '4weeks' ? 4 : 0;
        if (nWeeks === 0) return null;

        var periodStart = Utils.getPeriodStartDate(period, today);
        if (!periodStart) return null;
        var ps = new Date(periodStart + 'T00:00:00');
        ps.setDate(ps.getDate() + (nWeeks * 7) - 1);
        var endDate = cd && cd.endDate ? cd.endDate : null;
        if (endDate && ps > new Date(endDate + 'T00:00:00')) {
            return endDate;
        }
        return ps.getFullYear() + '-' + String(ps.getMonth() + 1).padStart(2, '0') + '-' + String(ps.getDate()).padStart(2, '0');
    };

    /**
     * Check if a date is an active camp day. Excludes Saturday (Shabbat).
     * Detects whether Sundays are active by checking allDailyData.
     */
    Utils._sundayActiveCache = null;
    Utils._isSundayActive = function() {
        if (Utils._sundayActiveCache !== null) return Utils._sundayActiveCache;
        var allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
        var keys = Object.keys(allDaily);
        for (var i = 0; i < keys.length; i++) {
            var d = new Date(keys[i] + 'T00:00:00');
            if (d.getDay() === 0) {
                var dayData = allDaily[keys[i]];
                if (dayData && dayData.scheduleAssignments && Object.keys(dayData.scheduleAssignments).length > 0) {
                    Utils._sundayActiveCache = true;
                    return true;
                }
            }
        }
        Utils._sundayActiveCache = false;
        return false;
    };

    Utils.isCampDay = function(dateStr) {
        var d = new Date(dateStr + 'T00:00:00');
        var dow = d.getDay();
        if (dow === 6) return false;
        if (dow === 0 && !Utils._isSundayActive()) return false;
        return true;
    };

    /**
     * Count active camp days between two dates (inclusive).
     */
    Utils.countCampDays = function(startDate, endDate) {
        if (!startDate || !endDate) return 0;
        var cur = new Date(startDate + 'T00:00:00');
        var end = new Date(endDate + 'T00:00:00');
        var count = 0;
        while (cur <= end) {
            var iso = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
            if (Utils.isCampDay(iso)) count++;
            cur.setDate(cur.getDate() + 1);
        }
        return count;
    };

    /**
     * Compute the escalating bonus for min/exact frequency enforcement.
     * Accounts for cooldown: if the activity can't be scheduled until a
     * future date, the effective remaining window shrinks and urgency rises.
     *
     * @param {string} period - '1week','2weeks','3weeks','4weeks','half'
     * @param {number} visitsNeeded - how many more visits are required
     * @param {string} [refDate] - reference date
     * @param {number} [cooldownDaysLeft] - calendar days until cooldown expires
     * @returns {number} bonus score (always >= 0)
     */
    Utils.getEscalationBonus = function(period, visitsNeeded, refDate, cooldownDaysLeft) {
        if (visitsNeeded <= 0) return 0;
        var today = refDate || (window.currentScheduleDate
            ? (typeof window.currentScheduleDate === 'string' ? window.currentScheduleDate : window.currentScheduleDate.toISOString().slice(0, 10))
            : new Date().toISOString().slice(0, 10));

        var periodStart = Utils.getPeriodStartDate(period, today);
        var periodEnd = Utils.getPeriodEndDate(period, today);
        if (!periodStart || !periodEnd) {
            return 100 * visitsNeeded;
        }

        var daysTotal = Utils.countCampDays(periodStart, periodEnd);
        if (daysTotal <= 0) return 100 * visitsNeeded;

        // Effective remaining camp days: subtract cooldown-blocked days
        var daysRemaining = Utils.countCampDays(today, periodEnd);
        if (cooldownDaysLeft > 0) {
            var cooldownExpiry = new Date(today + 'T00:00:00');
            cooldownExpiry.setDate(cooldownExpiry.getDate() + cooldownDaysLeft);
            var expiryStr = cooldownExpiry.getFullYear() + '-' + String(cooldownExpiry.getMonth() + 1).padStart(2, '0') + '-' + String(cooldownExpiry.getDate()).padStart(2, '0');
            var eligibleRemaining = Utils.countCampDays(expiryStr, periodEnd);
            daysRemaining = Math.min(daysRemaining, eligibleRemaining);
        }

        var effectiveElapsed = Math.max(0, daysTotal - daysRemaining);
        var dayIndex = Math.max(0, effectiveElapsed - 1);
        var base = 100 * Math.pow(2, dayIndex);
        return base * visitsNeeded;
    };

    /**
     * ★★★ REBUILD HISTORICAL COUNTS FROM ALL SAVED SCHEDULES ★★★
     * This is the DEFINITIVE source of truth for activity counts.
     * Call this after generation or on app load to sync counts.
     * @param {boolean} saveToCloud - Whether to save to globalSettings
     * @returns {Object} - The rebuilt counts { bunk: { activity: count } }
     */
    Utils.rebuildHistoricalCounts = function(saveToCloud = true) {
        console.log('📊 [SchedulerCoreUtils] Rebuilding historical counts from all schedules...');
        const validActivities = Utils.getValidActivityNames();
        const allDaily = window.loadAllDailyData?.() || {};
        const counts = {};
        let totalActivities = 0;
        let datesProcessed = 0;

        Object.entries(allDaily).forEach(([dateKey, dayData]) => {
            const sched = dayData?.scheduleAssignments || {};
            datesProcessed++;

            Object.keys(sched).forEach(bunk => {
                const bunkSchedule = sched[bunk] || [];

                bunkSchedule.forEach(entry => {
                    // Only count valid activities, skip continuations and transitions
                    if (entry && entry._activity && !entry.continuation && !entry._isTransition) {
                        const actName = entry._activity;

                        // Skip "Free" and transition types
                        const actLower = actName.toLowerCase();
                        if (actLower === 'free' || actLower === 'free play' || actLower.includes('transition')) {
                            return;
                        }

                        if (!validActivities.has(actName)) return;
                        counts[bunk] = counts[bunk] || {};
                        counts[bunk][actName] = (counts[bunk][actName] || 0) + 1;
                        totalActivities++;
                    }
                });
            });
        });

        console.log(`📊 [SchedulerCoreUtils] Rebuilt counts from ${datesProcessed} dates: ${Object.keys(counts).length} bunks, ${totalActivities} total activities`);

        // Save to globalSettings if requested
        if (saveToCloud && window.saveGlobalSettings) {
            // ★★★ CB-56 / CB-63: this rebuild scans ONLY local campDailyData_v1.
            // On a near-quota browser daily schedules are not written to
            // localStorage ("data is in cloud"), so loadAllDailyData() misses
            // most dates and a whole-key overwrite of the SHARED cloud
            // historicalCounts would DROP every bunk's history for the missing
            // dates. Detect that: if the previously-counted date set
            // (historicalCountedDates) contains dates not present in this scan,
            // the scan is partial — merge raise-only against the previous counts
            // (a partial scan can never LOWER the shared totals) and UNION the
            // counted-dates set. Decrements are the job of the explicit
            // erase / New-Half paths, not this passive rebuild.
            let _finalCounts = counts;
            const _countedDates = {};
            Object.keys(allDaily).forEach(function (dk) { _countedDates[dk] = true; });
            try {
                const _gs = window.loadGlobalSettings?.() || {};
                const _prevCounts = _gs.historicalCounts || {};
                const _prevDates = _gs.historicalCountedDates || {};
                const _scanned = new Set(Object.keys(allDaily));
                const _partial = Object.keys(_prevDates).some(dk => !_scanned.has(dk));
                if (_partial && Object.keys(_prevCounts).length > 0) {
                    console.warn('📊 [SchedulerCoreUtils] PARTIAL local scan (cloud knew dates absent locally) — merging raise-only to avoid dropping rotation history');
                    const _merged = JSON.parse(JSON.stringify(_prevCounts));
                    Object.keys(counts).forEach(function (bunk) {
                        _merged[bunk] = _merged[bunk] || {};
                        Object.keys(counts[bunk]).forEach(function (act) {
                            _merged[bunk][act] = Math.max(_merged[bunk][act] || 0, counts[bunk][act]);
                        });
                    });
                    _finalCounts = _merged;
                    // keep previously-counted dates too
                    Object.keys(_prevDates).forEach(function (dk) { _countedDates[dk] = true; });
                }
            } catch (_e) { /* fall back to authoritative overwrite */ }
            window.saveGlobalSettings('historicalCounts', _finalCounts);
            // Rebuild historicalCountedDates to match so incrementHistoricalCounts
            // guards stay consistent after a full rebuild.
            window.saveGlobalSettings('historicalCountedDates', _countedDates);
            console.log('📊 [SchedulerCoreUtils] Saved historical counts to globalSettings');

            // Trigger cloud sync if available
            if (typeof window.forceSyncToCloud === 'function') {
                setTimeout(() => window.forceSyncToCloud(), 100);
            }
        }

        return counts;
    };

    // Export for easy console access
    window.rebuildHistoricalCounts = Utils.rebuildHistoricalCounts;

    let _hydrateInProgress = false;
    let _lastHydrateTime = 0;
    const HYDRATE_COOLDOWN_MS = 60000;

    Utils.hydrateLocalStorageFromCloud = async function(force = false) {
        if (_hydrateInProgress) {
            console.log('📊 [Hydrate] Already in progress, skipping');
            return false;
        }

        if (!force && (Date.now() - _lastHydrateTime < HYDRATE_COOLDOWN_MS)) {
            console.log('📊 [Hydrate] Cooldown active, using cached data');
            return true;
        }

        if (!window.ScheduleDB?.loadDateRange) {
            console.log('📊 [Hydrate] ScheduleDB not available');
            return false;
        }

        _hydrateInProgress = true;

        try {
            console.log('📊 [Hydrate] Fetching ALL schedule dates from cloud...');

            const today = new Date();
            const start = new Date(today);
            start.setDate(start.getDate() - 90);

            const startStr = start.toISOString().split('T')[0];
            const endStr = today.toISOString().split('T')[0];

            const records = await window.ScheduleDB.loadDateRange(startStr, endStr);

            if (!records || records.length === 0) {
                console.log('📊 [Hydrate] No cloud records found');
                _hydrateInProgress = false;
                _lastHydrateTime = Date.now();
                return false;
            }

            console.log(`📊 [Hydrate] Got ${records.length} cloud records, merging...`);

            const DAILY_KEY = 'campDailyData_v1';
            let allLocal = {};
            try {
                allLocal = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
            } catch (e) {
                allLocal = {};
            }

            const datesSeen = new Set();
            records.forEach(record => {
                const dk = record.date_key;
                if (!dk || !/^\d{4}-\d{2}-\d{2}$/.test(dk)) return;

                datesSeen.add(dk);
                const sd = record.schedule_data || {};
                const localDate = allLocal[dk];
                const cloudUpdated = record.updated_at ? new Date(record.updated_at).getTime() : 0;
                const localUpdated = localDate?._savedAt || localDate?.savedAt || 0;
                const localSavedTime = typeof localUpdated === 'number' ? localUpdated :
                    (typeof localUpdated === 'string' ? new Date(localUpdated).getTime() : 0);

                if (!localDate || !localDate.scheduleAssignments ||
                    Object.keys(localDate.scheduleAssignments).length === 0 ||
                    cloudUpdated > localSavedTime) {

                    const existingAssignments = localDate?.scheduleAssignments || {};
                    const cloudAssignments = sd.scheduleAssignments || {};

                    allLocal[dk] = {
                        ...(localDate || {}),
                        scheduleAssignments: { ...existingAssignments, ...cloudAssignments },
                        leagueAssignments: sd.leagueAssignments || localDate?.leagueAssignments || {},
                        unifiedTimes: sd.unifiedTimes || localDate?.unifiedTimes || [],
                        divisionTimes: sd.divisionTimes || localDate?.divisionTimes || {},
                        isRainyDay: sd.isRainyDay ?? localDate?.isRainyDay ?? false,
                        _hydratedAt: Date.now()
                    };
                }
            });

            try {
                localStorage.setItem(DAILY_KEY, JSON.stringify(allLocal));
                console.log(`📊 [Hydrate] ✅ Merged ${datesSeen.size} dates into localStorage. ` +
                    `Total dates: ${Object.keys(allLocal).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).length}`);
            } catch (e) {
                console.warn('📊 [Hydrate] localStorage full, trimming old dates...');
                const dateKeys = Object.keys(allLocal)
                    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
                    .sort();

                while (dateKeys.length > 14) {
                    delete allLocal[dateKeys.shift()];
                }

                try {
                    localStorage.setItem(DAILY_KEY, JSON.stringify(allLocal));
                    console.log('📊 [Hydrate] ✅ Saved trimmed data (last 30 dates)');
                } catch (e2) {
                    console.warn('📊 [Hydrate] localStorage still full, using in-memory fallback');
                    if (window.setDailyDataMemoryOverride) {
                        window.setDailyDataMemoryOverride(allLocal);
                        console.log('📊 [Hydrate] ✅ Data available via in-memory fallback');
                    }
                }
            }

            _lastHydrateTime = Date.now();
            _hydrateInProgress = false;

            if (window.RotationEngine?.clearHistoryCache) {
                window.RotationEngine.clearHistoryCache();
                console.log('📊 [Hydrate] Cleared rotation cache for fresh history');
            }

            return true;

        } catch (e) {
            console.error('📊 [Hydrate] Error:', e);
            _hydrateInProgress = false;
            return false;
        }
    };

    window.hydrateLocalStorageFromCloud = Utils.hydrateLocalStorageFromCloud;

Utils.getValidActivityNames = function() {
        const g = window.loadGlobalSettings?.() || {};
        const fields = g.app1?.fields || [];
        const specials = g.app1?.specialActivities || [];
        const valid = new Set();
        fields.forEach(f => (f.activities || []).forEach(a => valid.add(a)));
        specials.forEach(s => { if (s.name) valid.add(s.name); });
        // ★ Also include the camp's configured sports (master list + sport metadata).
        //   A field's `activities` list only covers sports that have a dedicated field;
        //   a recognized sport without one (e.g. "Soccer") was therefore excluded, so a
        //   manual daily-adjustment to it placed the activity on the schedule but the
        //   rotation count silently ignored it. Including configured sports keeps the
        //   schedule and rotation counts consistent for any real activity the camp set
        //   up; unrecognized names (typos) stay excluded, as intended.
        (g.app1?.allSports || []).forEach(s => { if (s) valid.add(s); });
        Object.keys(g.app1?.sportMetaData || {}).forEach(s => { if (s) valid.add(s); });
        return valid;
    };
    // ★★★ CB-96 — DEAD-BUT-WIRED. incrementHistoricalCounts / reIncrementHistoricalCounts have NO
    //   live caller (repo-wide grep: only their defs, the window exports below, and a unit test).
    //   Every live generation/edit path instead calls `rebuildHistoricalCounts` (full re-scan from
    //   the final schedule), which is the authority and counts differently (it excludes league-game
    //   sports from historicalCounts; these incremental adders include them via the sport fallback).
    //   DO NOT re-wire these into a gen/post-edit path without first reconciling that divergence —
    //   doing so would inflate sport counts and double-count on re-generation. Left in place (not
    //   deleted) because a test depends on them and removal is out of scope for the audit pass.
    Utils.incrementHistoricalCounts = function(dateKey, scheduleAssignments, saveToCloud = true) {
        console.log(`📊 [SchedulerCoreUtils] Incrementing counts for ${dateKey}...`);

        const globalSettings = window.loadGlobalSettings?.() || {};
        const existingCounts = globalSettings.historicalCounts || {};
        const countedDates = globalSettings.historicalCountedDates || {};

        if (countedDates[dateKey]) {
            console.log(`📊 [SchedulerCoreUtils] ${dateKey} already counted, skipping`);
            return existingCounts;
        }

        const sched = scheduleAssignments || {};
        let added = 0;
const validActivities = Utils.getValidActivityNames();
        Object.keys(sched).forEach(bunk => {
            (sched[bunk] || []).forEach(entry => {
                if (entry && !entry.continuation && !entry._isTransition) {
                    let actName = entry._activity || entry.sport || '';
                    if (!actName) return;
                    if (!validActivities.has(actName) && entry.sport && validActivities.has(entry.sport)) {
                        actName = entry.sport;
                    }
                    const actLower = actName.toLowerCase();
                    if (actLower === 'free' || actLower.includes('transition')) return;

                    if (!validActivities.has(actName)) return;
                    existingCounts[bunk] = existingCounts[bunk] || {};
                    existingCounts[bunk][actName] = (existingCounts[bunk][actName] || 0) + 1;
                    added++;
                }
            });
        });

        countedDates[dateKey] = Date.now();

        console.log(`📊 [SchedulerCoreUtils] +${added} activities for ${dateKey}. ` +
            `Dates counted: ${Object.keys(countedDates).length}`);

        if (saveToCloud && window.saveGlobalSettings) {
            window.saveGlobalSettings('historicalCounts', existingCounts);
            window.saveGlobalSettings('historicalCountedDates', countedDates);
            if (typeof window.forceSyncToCloud === 'function') {
                setTimeout(() => window.forceSyncToCloud(), 100);
            }
        }

        return existingCounts;
    };


    Utils.reIncrementHistoricalCounts = function(dateKey, newScheduleAssignments, saveToCloud = true, oldScheduleAssignments = null) {
        console.log(`📊 [SchedulerCoreUtils] Re-incrementing for ${dateKey}...`);

        const globalSettings = window.loadGlobalSettings?.() || {};
        const existingCounts = globalSettings.historicalCounts || {};
        const countedDates = globalSettings.historicalCountedDates || {};

        if (countedDates[dateKey]) {
            // Use caller-supplied old schedule when available — avoids reading stale localStorage
            // when the caller has already overwritten it with the new schedule.
            const allDaily = oldScheduleAssignments ? null : (window.loadAllDailyData?.() || {});
            const oldSched = oldScheduleAssignments || allDaily?.[dateKey]?.scheduleAssignments || {};
            let removed = 0;
const validActivities = Utils.getValidActivityNames();
            Object.keys(oldSched).forEach(bunk => {
                (oldSched[bunk] || []).forEach(entry => {
                    if (entry && !entry.continuation && !entry._isTransition) {
                        let actName = entry._activity || entry.sport || '';
                        if (!actName) return;
                        if (!validActivities.has(actName) && entry.sport && validActivities.has(entry.sport)) {
                            actName = entry.sport;
                        }
                        const actLower = actName.toLowerCase();
                        if (actLower === 'free' || actLower.includes('transition')) return;

                        if (!validActivities.has(actName)) return;
                        if (existingCounts[bunk]?.[actName]) {
                            existingCounts[bunk][actName] = Math.max(0, existingCounts[bunk][actName] - 1);
                            removed++;
                        }
                    }
                });
            });

            delete countedDates[dateKey];
            console.log(`📊 Subtracted ${removed} old activities`);

            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('historicalCounts', existingCounts);
                window.saveGlobalSettings('historicalCountedDates', countedDates);
            }
        }

        return Utils.incrementHistoricalCounts(dateKey, newScheduleAssignments, saveToCloud);
    };


    Utils.rebuildHistoricalCountsFromCloud = async function(saveToCloud = true) {
        console.log('📊 [SchedulerCoreUtils] Full rebuild from cloud...');

        await Utils.hydrateLocalStorageFromCloud(true);

        const result = Utils.rebuildHistoricalCounts(saveToCloud);

        const allDaily = window.loadAllDailyData?.() || {};
        const countedDates = {};
        Object.keys(allDaily).forEach(dk => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(dk) && allDaily[dk]?.scheduleAssignments) {
                countedDates[dk] = Date.now();
            }
        });
        if (saveToCloud && window.saveGlobalSettings) {
            window.saveGlobalSettings('historicalCountedDates', countedDates);
        }

        return result;
    };

    window.incrementHistoricalCounts = Utils.incrementHistoricalCounts;
    window.reIncrementHistoricalCounts = Utils.reIncrementHistoricalCounts;
    window.rebuildHistoricalCountsFromCloud = Utils.rebuildHistoricalCountsFromCloud;

    // =================================================================
    // POST-EDIT COUNTS + ROTATION HISTORY — shared by all edit paths
    // =================================================================
    // Single source of truth for the delta update that must run after ANY
    // manual cell edit (direct edit, conflict-resolved edit, bypass, proposal).
    //
    // @param {string}   bunk          — bunk name
    // @param {string[]} oldActivities — activities that were in the affected slots before the edit
    // @param {string|null} newActivity — the replacement activity (null = clear)
    // @param {number[]} slots         — slot indices that were edited
    Utils.applyPostEditCounts = function(bunk, oldActivities, newActivity, slots) {
        // ── historicalCounts delta ────────────────────────────────────
        try {
            const _gs = window.loadGlobalSettings?.() || {};
            const _hc = _gs.historicalCounts || {};
            if (!_hc[bunk]) _hc[bunk] = {};

            let _newAct = newActivity || null;
            // Normalize case: reuse old casing when the name matches
            if (_newAct) {
                for (const oldAct of (oldActivities || [])) {
                    if (oldAct.toLowerCase() === _newAct.toLowerCase() && oldAct !== _newAct) {
                        _newAct = oldAct;
                        break;
                    }
                }
            }

            // Decrement old activities
            const _oldUnique = {};
            (oldActivities || []).forEach(a => { _oldUnique[a] = (_oldUnique[a] || 0) + 1; });
            for (const [act, count] of Object.entries(_oldUnique)) {
                _hc[bunk][act] = Math.max(0, (_hc[bunk][act] || 0) - count);
            }

            // Increment new activity
            const _validActs = Utils.getValidActivityNames?.() || new Set();
            if (_newAct && (_validActs.size === 0 || _validActs.has(_newAct))) {
                let _newCount = 0;
                (slots || []).forEach(idx => {
                    const entry = window.scheduleAssignments?.[bunk]?.[idx];
                    if (entry && !entry.continuation) _newCount++;
                });
                if (_newCount === 0) _newCount = 1; // fallback when slots list unavailable
                _hc[bunk][_newAct] = (_hc[bunk][_newAct] || 0) + _newCount;
            }

            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('historicalCounts', _hc);
                if (typeof window.forceSyncToCloud === 'function') {
                    setTimeout(() => window.forceSyncToCloud(), 100);
                }
            }
        } catch (e) { console.error('[PostEditCounts] historicalCounts delta failed:', e); }

        // ── rotationHistory rebuild for this bunk ─────────────────────
        try {
            const _rotHist = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
            _rotHist.bunks = _rotHist.bunks || {};
            const _bunkSlots = window.scheduleAssignments?.[bunk] || [];
            const _schedDate = window.currentScheduleDate ? new Date(window.currentScheduleDate + 'T12:00:00').getTime() : Date.now();
            const _now = _schedDate || Date.now();
            // Merge today's activities into existing timestamps instead of
            // wiping the bunk — preserves previous-day recency data.
            if (!_rotHist.bunks[bunk]) _rotHist.bunks[bunk] = {};
            const _todayActs = new Set();
            _bunkSlots.forEach(entry => {
                if (entry?._activity && !entry.continuation && !entry._isTransition) {
                    const _aLower = entry._activity.toLowerCase();
                    if (_aLower !== 'free' && !_aLower.includes('transition')) {
                        _rotHist.bunks[bunk][entry._activity] = _now;
                        _todayActs.add(entry._activity);
                    }
                }
            });
            window.saveRotationHistory?.(_rotHist);
        } catch (e) { console.error('[PostEditCounts] rotationHistory rebuild failed:', e); }

        // ── Sync rotation counts to cloud (debounced) ────────────────
        //    Multiple bunks may be edited in quick succession (proposals,
        //    conflict resolution).  Debounce so only one cloud save fires.
        clearTimeout(Utils._postEditCloudTimer);
        Utils._postEditCloudTimer = setTimeout(() => {
            try {
                const _dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                if (_dateKey && window.RotationCloud?.save) {
                    window.RotationCloud.save(_dateKey, window.scheduleAssignments || {});
                    console.log('[PostEditCounts] ☁️ Synced rotation counts to cloud');
                }
            } catch (e) { console.error('[PostEditCounts] RotationCloud sync failed:', e); }
        }, 500);
    };
    window.applyPostEditCounts = Utils.applyPostEditCounts;


    // =================================================================
    // ★★★ NEW v7.5: DIAGNOSTIC FUNCTIONS ★★★
    // =================================================================
    
    /**
     * Diagnose field data integrity - checks all fields for complete structure
     */
    Utils.diagnoseFieldData = function(fieldNameFilter = null) {
        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || [];
        
        console.log('=== FIELD DATA INTEGRITY CHECK ===');
        console.log(`Total fields: ${fields.length}`);
        
        const issues = [];
        
        fields.forEach(f => {
            if (fieldNameFilter && f.name !== fieldNameFilter) return;
            
            const fieldIssues = [];
            
            // Check sharableWith
            if (!f.sharableWith) {
                fieldIssues.push('Missing sharableWith');
            } else {
                if (!f.sharableWith.type) fieldIssues.push('sharableWith.type missing');
                if (!Array.isArray(f.sharableWith.divisions)) fieldIssues.push('sharableWith.divisions not an array');
                if (f.sharableWith.capacity === undefined) fieldIssues.push('sharableWith.capacity missing');
            }
            
            // Check accessRestrictions
            if (!f.accessRestrictions) {
                fieldIssues.push('Missing accessRestrictions');
            } else {
                if (f.accessRestrictions.enabled === undefined) fieldIssues.push('accessRestrictions.enabled missing');
                if (typeof f.accessRestrictions.divisions !== 'object') fieldIssues.push('accessRestrictions.divisions not an object');
                if (!Array.isArray(f.accessRestrictions.priorityList)) fieldIssues.push('accessRestrictions.priorityList not an array');
            }
            
            // Check timeRules
            if (!Array.isArray(f.timeRules)) {
                fieldIssues.push('timeRules not an array');
            } else {
                f.timeRules.forEach((r, i) => {
                    if (r.startMin === undefined || r.startMin === null) {
                        fieldIssues.push(`timeRules[${i}].startMin not pre-parsed`);
                    }
                });
            }
            
            // Check rainyDayAvailable
            if (f.rainyDayAvailable === undefined) {
                fieldIssues.push('rainyDayAvailable missing');
            }
            
            if (fieldIssues.length > 0) {
                issues.push({ field: f.name, issues: fieldIssues });
                console.log(`\n❌ ${f.name}:`);
                fieldIssues.forEach(i => console.log(`   - ${i}`));
            } else {
                console.log(`\n✅ ${f.name}: OK`);
            }
        });
        
        console.log('\n=== SUMMARY ===');
        console.log(`Fields with issues: ${issues.length}/${fields.length}`);
        
        return issues;
    };
    
    // Export diagnostic
    window.diagnoseFieldData = Utils.diagnoseFieldData;

    // =================================================================
    // END OF FILE
    // =================================================================
    console.log("✅ SchedulerCoreUtils v7.6 Loaded (v3.0 Sharing Model)");

})();
