// ============================================================================
// scheduler_logic_fillers.js (v6.2 - FIXED CAPACITY LOGIC)
// ============================================================================
// ★★★ THIS FILE NOW DELEGATES ALL ROTATION LOGIC TO rotation_engine.js ★★★
//
// The RotationEngine is the SINGLE SOURCE OF TRUTH for rotation scoring.
// This file provides:
// - Activity selection functions (findBestSpecial, findBestSportActivity, etc.)
// - Field sharing logic
// - Preference scoring
// - All scoring is delegated to window.RotationEngine
//
// KEY FIXES IN v6.2:
// - ★★★ FIXED: canShareWithActivity capacity - type='all' now returns 999 ★★★
// - findBestGeneralActivity now uses UNIFIED scoring (no type bias)
// - Case-insensitive type filtering throughout
// - Dual property lookup (checks both field AND activity names)
// - Sports and specials compete fairly based on rotation scores
//
// ============================================================================

(function () {
    'use strict';

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    function fieldLabel(f) {
        if (window.SchedulerCoreUtils?.fieldLabel) {
            return window.SchedulerCoreUtils.fieldLabel(f);
        }
        return (f && f.name) ? f.name : f;
    }

    function getBunkNumber(bunkName) {
        if (!bunkName) return Infinity;
        const match = String(bunkName).match(/(\d+)/);
        return match ? parseInt(match[1], 10) : Infinity;
    }

    function isFieldUnavailable(fieldName, block) {
    const disabledFields = window.currentDisabledFields || [];
    if (disabledFields.includes(fieldName)) {
        return true;
    }

    // ★★★ RAINY DAY CHECK: Outdoor fields unavailable on rainy days ★★★
    const isRainyMode = window.isRainyDayModeActive?.() || window.isRainyDay === true;
    if (isRainyMode) {
        const fieldProps = window.activityProperties?.[fieldName];
        // If this field is NOT marked as indoor/rainyDayAvailable, it's unavailable
        if (fieldProps && fieldProps.rainyDayAvailable !== true) {
            // Double-check it's a field type (not a special activity)
            if (fieldProps.type === 'field' || fieldProps.activities) {
                return true;
            }
        }
        
        // Also check the raw field data
        const g = window.loadGlobalSettings?.() || {};
        const fields = g.app1?.fields || [];
        const fieldData = fields.find(f => f.name === fieldName);
        if (fieldData && fieldData.rainyDayAvailable !== true) {
            return true;
        }
    }

    if (!window.GlobalFieldLocks) return false;
    const slots = block.slots || [];
    if (slots.length === 0) return false;

    const divisionContext = block.divName || block.division;
    return window.GlobalFieldLocks.isFieldLocked(fieldName, slots, divisionContext) !== null;
}

    // =========================================================================
    // ★★★ CENTRALIZED CAPACITY FUNCTION ★★★
    // =========================================================================

    /**
     * Get field capacity - SINGLE SOURCE OF TRUTH
     * - type='not_sharable' → 1
     * - type='all' → 999 (unlimited)
     * - type='custom' → configured capacity (default 2)
     */
    function getFieldCapacity(fieldName, activityProperties) {
        // Use centralized utility if available
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        
        // Fallback implementation
        const props = activityProperties?.[fieldName] || {};
        
        if (props.sharableWith) {
            // ★★★ FIX: type='all' = unlimited (999) ★★★
            if (props.sharableWith.type === 'all') {
                return 999;
            }
            // type='custom' uses configured capacity
            if (props.sharableWith.type === 'custom') {
                return parseInt(props.sharableWith.capacity) || 2;
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

    // =========================================================================
    // ★★★ DELEGATED ROTATION FUNCTIONS ★★★
    // All scoring goes through RotationEngine
    // =========================================================================

    function getActivitiesDoneToday(bunkName, beforeSlotIndex) {
        if (window.RotationEngine?.getActivitiesDoneToday) {
            return window.RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        }
        // Fallback
        const activities = new Set();
        const schedule = window.scheduleAssignments?.[bunkName] || [];
        for (let i = 0; i < beforeSlotIndex && i < schedule.length; i++) {
            const entry = schedule[i];
            if (entry && entry._activity && !entry._isTransition && !entry.continuation) {
                activities.add(entry._activity.toLowerCase().trim());
            }
        }
        return activities;
    }

    /**
     * Calculate rotation score - DELEGATES TO ROTATION ENGINE
     */
    function calculateRotationScore(bunkName, activityName, block, activityProperties) {
        if (!activityName || activityName === 'Free') return 0;

        // ★★★ DELEGATE TO ROTATION ENGINE ★★★
        if (window.RotationEngine?.calculateRotationScore) {
            return window.RotationEngine.calculateRotationScore({
                bunkName,
                activityName,
                divisionName: block.divName || block.division,
                beforeSlotIndex: block.slots?.[0] || 0,
                allActivities: null,  // Will use RotationEngine.getAllActivityNames()
                activityProperties
            });
        }

        // Fallback if RotationEngine not loaded yet
        console.warn('[FILLERS] RotationEngine not available, using basic scoring');
        const beforeSlotIndex = block.slots?.[0] || 0;
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = (activityName || '').toLowerCase().trim();
        
        if (todayActivities.has(actLower)) {
            return Infinity;  // Same day = blocked
        }
        
        return 0;  // Basic fallback
    }

    // =========================================================================
    // FIELD SHARING LOGIC
    // =========================================================================

    function getFieldCurrentState(fieldName, block) {
        const slots = block.slots || [];
        const schedules = window.scheduleAssignments || {};

        const state = {
            count: 0,
            bunks: [],
            activities: new Set(),
            minBunkNum: Infinity,
            maxBunkNum: -Infinity
        };

        for (const slotIdx of slots) {
            for (const [bunk, bunkSlots] of Object.entries(schedules)) {
                if (bunk === block.bunk) continue;
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;

                const entryField = fieldLabel(entry.field) || entry._activity;
                if (!entryField) continue;

                if (entryField.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                    if (!state.bunks.includes(bunk)) {
                        state.bunks.push(bunk);
                        state.count++;

                        const num = getBunkNumber(bunk);
                        if (num < state.minBunkNum) state.minBunkNum = num;
                        if (num > state.maxBunkNum) state.maxBunkNum = num;
                    }

                    const actName = entry._activity || entry.sport;
                    if (actName) {
                        state.activities.add(actName.toLowerCase().trim());
                    }
                }
            }
        }

        return state;
    }

    /**
     * ★★★ FIXED v6.2: canShareWithActivity with correct capacity logic ★★★
     */
    function canShareWithActivity(fieldName, block, activityName, activityProperties) {
        if (isFieldUnavailable(fieldName, block)) {
            return false;
        }

        const state = getFieldCurrentState(fieldName, block);

        if (state.count === 0) return true;

        // ★★★ FIX v6.2: Use centralized capacity function ★★★
        // Check both field AND activity name for properties
        const maxCapacity = getFieldCapacity(fieldName, activityProperties) || 
                           getFieldCapacity(activityName, activityProperties) || 1;

        if (state.count >= maxCapacity) {
            return false;
        }

        if (state.activities.size > 0 && activityName) {
            const myActivity = activityName.toLowerCase().trim();
            if (!state.activities.has(myActivity)) {
                return false;
            }
        }

        return true;
    }

    function calculateSharingBonus(fieldName, block, activityProperties) {
        if (isFieldUnavailable(fieldName, block)) {
            return -999999;
        }

        const state = getFieldCurrentState(fieldName, block);

        if (state.count === 0) return 0;

        const myNum = getBunkNumber(block.bunk);
        if (myNum === Infinity) return 0;

        let totalDistance = 0;
        for (const existingBunk of state.bunks) {
            const existingNum = getBunkNumber(existingBunk);
            if (existingNum !== Infinity) {
                totalDistance += Math.abs(myNum - existingNum);
            }
        }

        const avgDistance = state.bunks.length > 0 ? totalDistance / state.bunks.length : 0;
        return Math.max(0, 120 - avgDistance * 20);
    }

    function calculatePreferenceScore(fieldProps, divName) {
        if (!fieldProps?.preferences?.enabled) return 0;
        const list = fieldProps.preferences.list || [];
        const idx = list.indexOf(divName);
        if (idx === -1) return -50;
        return 1000 - idx * 100;
    }

    // =========================================================================
    // ★★★ SMART PICK SORTING - DELEGATES TO ROTATION ENGINE ★★★
    // =========================================================================

    function sortPicksByRotationScore(picks, block, activityProperties) {
        const bunkName = block.bunk;
        const divName = block.divName;

        // Use RotationEngine's getRankedActivities if available (includes tie-breaking)
        if (window.RotationEngine?.getRankedActivities && picks.length > 0) {
            const rankedActivities = window.RotationEngine.getRankedActivities({
                bunkName,
                divisionName: divName,
                beforeSlotIndex: block.slots?.[0] || 0,
                availableActivities: picks.map(p => ({
                    name: p._activity || p.sport || fieldLabel(p.field),
                    ...p
                })),
                activityProperties
            });

            // Map back to picks with scores
            return rankedActivities
                .filter(r => r.allowed)
                .map(r => {
                    const originalPick = picks.find(p => {
                        const actName = p._activity || p.sport || fieldLabel(p.field);
                        return actName === r.activityName;
                    });
                    return {
                        ...originalPick,
                        _rotationScore: r.score,
                        _totalScore: r.score,
                        _blocked: false
                    };
                });
        }

        // Fallback to manual scoring
        const scored = picks.map(pick => {
            const actName = pick._activity || pick.sport || fieldLabel(pick.field);
            const fieldName = fieldLabel(pick.field);

            const rotationScore = calculateRotationScore(bunkName, actName, block, activityProperties);

            if (rotationScore === Infinity) {
                return { ...pick, _rotationScore: Infinity, _blocked: true };
            }

            // ★★★ FIX: Check both field AND activity name for properties ★★★
            const fieldProps = activityProperties[fieldName] || activityProperties[actName] || {};
            const preferenceScore = calculatePreferenceScore(fieldProps, divName);
            const sharingBonus = calculateSharingBonus(fieldName, block, activityProperties);

            const totalScore = rotationScore - preferenceScore - sharingBonus;

            return { 
                ...pick, 
                _rotationScore: rotationScore, 
                _totalScore: totalScore, 
                _blocked: false 
            };
        })
        .filter(pick => !pick._blocked);

        scored.sort((a, b) => a._totalScore - b._totalScore);

        return scored;
    }

    // =========================================================================
    // SPECIAL ACTIVITY SELECTOR
    // =========================================================================

    window.findBestSpecial = function (
        block,
        allActivities,
        fieldUsageBySlot,
        yesterdayHistory,
        activityProperties,
        rotationHistory,
        historicalCounts
    ) {
        const currentSlotIndex = block.slots[0];
        const doneToday = getActivitiesDoneToday(block.bunk, currentSlotIndex);

        // ★★★ FIX: Case-insensitive type filtering ★★★
        const specials = allActivities
            .filter(a => {
                const t = (a.type || '').toLowerCase();
                return t === 'special';
            })
            .map(a => ({
                field: a.name,
                sport: null,
                _activity: a.name,
                _type: 'special'
            }));

        const available = specials.filter(pick => {
            const actName = pick._activity;
            const fieldName = fieldLabel(pick.field);

            if (isFieldUnavailable(fieldName, block)) {
                return false;
            }

            if (doneToday.has((actName || '').toLowerCase().trim())) {
                return false;
            }

            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                return false;
            }

            if (!window.SchedulerCoreUtils?.canBlockFit?.(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return false;

            return true;
        });

        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    };

    // =========================================================================
    // SPORTS ACTIVITY SELECTOR
    // =========================================================================

    window.findBestSportActivity = function (
        block,
        allActivities,
        fieldUsageBySlot,
        yesterdayHistory,
        activityProperties,
        rotationHistory,
        historicalCounts
    ) {
        const fieldsBySport = window.SchedulerCoreUtils?.loadAndFilterData?.()?.fieldsBySport || {};
        const currentSlotIndex = block.slots[0];
        const doneToday = getActivitiesDoneToday(block.bunk, currentSlotIndex);

        // ★★★ FIX: Case-insensitive type filtering ★★★
        const sports = allActivities
            .filter(a => {
                const t = (a.type || '').toLowerCase();
                return t === 'field' || t === 'sport';
            })
            .flatMap(a => {
                const fields = fieldsBySport[a.name] || a.allowedFields || [a.name];
                return fields.map(f => ({
                    field: f,
                    sport: a.name,
                    _activity: a.name,
                    _type: 'sport'
                }));
            });

        const available = sports.filter(pick => {
            const actName = pick._activity;
            const fieldName = fieldLabel(pick.field);

            if (isFieldUnavailable(fieldName, block)) {
                return false;
            }

            if (doneToday.has((actName || '').toLowerCase().trim())) {
                return false;
            }

            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                return false;
            }

            // ★★★ FIX: Check both field AND activity name for properties ★★★
            if (!activityProperties[fieldName] && !activityProperties[pick._activity]) return false;

            if (!window.SchedulerCoreUtils?.canBlockFit?.(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return false;

            return true;
        });

        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    };

    // =========================================================================
    // SPORTS SLOT — FAIRNESS-BASED SELECTOR
    // =========================================================================

    function findBestSportsSlot(block, allActivities, fieldUsageBySlot, yesterdayHistory,
                                activityProperties, rotationHistory, historicalCounts) {
        const fieldsBySport = window.SchedulerCoreUtils?.loadAndFilterData?.()?.fieldsBySport || {};
        const currentSlotIndex = block.slots[0];
        const doneToday = getActivitiesDoneToday(block.bunk, currentSlotIndex);

        // ★★★ FIX: Case-insensitive type filtering ★★★
        const sports = allActivities.filter(a => {
            const t = (a.type || '').toLowerCase();
            return t === 'field' || t === 'sport';
        });

        const picks = [];
        sports.forEach(sport => {
            const sportName = sport.name;
            const fields = fieldsBySport[sportName] || sport.allowedFields || [sportName];
            fields.forEach(f => {
                const fieldName = fieldLabel(f);
                picks.push({
                    field: fieldName,
                    sport: sportName,
                    _activity: sportName,
                    _type: 'sport'
                });
            });
        });

        const available = picks.filter(pick => {
            const actName = pick._activity;
            const fieldName = pick.field;

            if (isFieldUnavailable(fieldName, block)) {
                return false;
            }

            if (doneToday.has((actName || '').toLowerCase().trim())) {
                return false;
            }

            // ★★★ FIX: Check both field AND activity name for properties ★★★
            if (!activityProperties[fieldName] && !activityProperties[actName]) return false;

            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                return false;
            }

            if (!window.SchedulerCoreUtils?.canBlockFit?.(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return false;

            return true;
        });

        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    }

    // =========================================================================
    // GENERAL ACTIVITY SELECTOR (MASTER SELECTOR) - UNIFIED SCORING v2.0
    // =========================================================================
    // ★★★ FIXED: Now uses unified scoring for BOTH sports and specials ★★★
    // Instead of prioritizing one type over another, all available options
    // compete fairly based on their rotation scores.
    // =========================================================================

    window.findBestGeneralActivity = function (
        block,
        allActivities,
        h2hActivities,
        fieldUsageBySlot,
        yesterdayHistory,
        activityProperties,
        rotationHistory,
        historicalCounts
    ) {
        const currentSlotIndex = block.slots?.[0] || 0;
        const doneToday = getActivitiesDoneToday(block.bunk, currentSlotIndex);
        const fieldsBySport = window.SchedulerCoreUtils?.loadAndFilterData?.()?.fieldsBySport || {};

        // ★★★ UNIFIED POOL: Collect ALL available options (specials + sports) ★★★
        const allPicks = [];

        // 1) Collect SPECIAL activities
        const specials = allActivities.filter(a => {
            const t = (a.type || '').toLowerCase();
            return t === 'special';
        });

        specials.forEach(special => {
            const actName = special.name;
            const fieldName = fieldLabel(actName);

            // Skip if unavailable
            if (isFieldUnavailable(fieldName, block)) return;
            if (doneToday.has((actName || '').toLowerCase().trim())) return;

            // Check sharing and capacity
            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) return;

            // Check canBlockFit - look up properties by activity name
            const props = activityProperties[fieldName] || activityProperties[actName] || {};
            if (props.available === false) return;

            if (!window.SchedulerCoreUtils?.canBlockFit?.(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return;

            allPicks.push({
                field: fieldName,
                sport: null,
                _activity: actName,
                _type: 'special'
            });
        });

        // 2) Collect SPORT activities
        const sports = allActivities.filter(a => {
            const t = (a.type || '').toLowerCase();
            return t === 'field' || t === 'sport';
        });

        sports.forEach(sport => {
            const sportName = sport.name;
            const fields = fieldsBySport[sportName] || sport.allowedFields || [sportName];

            fields.forEach(f => {
                const fieldName = fieldLabel(f);
                const actName = sportName;

                // Skip if unavailable
                if (isFieldUnavailable(fieldName, block)) return;
                if (doneToday.has((actName || '').toLowerCase().trim())) return;

                // Check if field has activity properties (check both field AND sport)
                const fieldProps = activityProperties[fieldName];
                const sportProps = activityProperties[sportName];
                if (!fieldProps && !sportProps) return;

                if (!canShareWithActivity(fieldName, block, actName, activityProperties)) return;

                if (!window.SchedulerCoreUtils?.canBlockFit?.(
                    block,
                    fieldName,
                    activityProperties,
                    fieldUsageBySlot,
                    actName,
                    false
                )) return;

                allPicks.push({
                    field: fieldName,
                    sport: sportName,
                    _activity: actName,
                    _type: 'sport'
                });
            });
        });

        // 3) If no picks available, return Free
        if (allPicks.length === 0) {
            return {
                field: "Free",
                sport: null,
                _activity: "Free"
            };
        }

        // 4) ★★★ UNIFIED SCORING: Sort ALL picks by rotation score ★★★
        const sorted = sortPicksByRotationScore(allPicks, block, activityProperties);

        // 5) Return the best pick (lowest score wins)
        return sorted[0] || {
            field: "Free",
            sport: null,
            _activity: "Free"
        };
    };

    // =========================================================================
    // DEBUG UTILITIES - DELEGATE TO ROTATION ENGINE
    // =========================================================================

    window.debugFillerRotation = function(bunkName, slotIndex = 0) {
        if (window.RotationEngine?.debugBunkRotation) {
            window.RotationEngine.debugBunkRotation(bunkName, slotIndex);
        } else {
            console.warn('[FILLERS] RotationEngine not loaded - cannot debug');
        }
    };

    window.debugRotationConfig = function() {
        if (window.RotationEngine?.debugConfig) {
            window.RotationEngine.debugConfig();
        } else {
            console.warn('[FILLERS] RotationEngine not loaded - cannot show config');
        }
    };

    Object.defineProperty(window, 'ROTATION_CONFIG', {
        get: function() {
            return window.RotationEngine?.CONFIG || {};
        }
    });

    // Expose calculateRotationScore (delegates to RotationEngine)
    window.calculateRotationScore = function(options) {
        if (window.RotationEngine?.calculateRotationScore) {
            return window.RotationEngine.calculateRotationScore(options);
        }
        return 0;
    };

    // Expose getFieldCapacity for external use
    window.getFieldCapacityFromFillers = getFieldCapacity;

    console.log('[FILLERS] v6.2 loaded - FIXED CAPACITY LOGIC (type=all → 999)');

})();
