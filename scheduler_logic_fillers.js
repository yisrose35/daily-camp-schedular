// ============================================================================
// scheduler_logic_fillers.js (v6.0 - DELEGATES TO ROTATION ENGINE)
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

        if (!window.GlobalFieldLocks) return false;
        const slots = block.slots || [];
        if (slots.length === 0) return false;

        const divisionContext = block.divName || block.division;
        return window.GlobalFieldLocks.isFieldLocked(fieldName, slots, divisionContext) !== null;
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

    function canShareWithActivity(fieldName, block, activityName, activityProperties) {
        if (isFieldUnavailable(fieldName, block)) {
            return false;
        }

        const state = getFieldCurrentState(fieldName, block);

        if (state.count === 0) return true;

        const props = activityProperties[fieldName] || {};
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable || props.sharableWith?.type === "all" || props.sharableWith?.type === "custom") {
            maxCapacity = 2;
        }

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

            const fieldProps = activityProperties[fieldName] || {};
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

        const specials = allActivities
            .filter(a => a.type === 'Special' || a.type === 'special')
            .map(a => ({
                field: a.name,
                sport: null,
                _activity: a.name
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

        const sports = allActivities
            .filter(a => a.type === 'field' || a.type === 'sport')
            .flatMap(a => {
                const fields = fieldsBySport[a.name] || a.allowedFields || [a.name];
                return fields.map(f => ({
                    field: f,
                    sport: a.name,
                    _activity: a.name
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

            if (!activityProperties[fieldName]) return false;

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

        const sports = allActivities.filter(a =>
            a.type === 'field' || a.type === 'sport'
        );

        const picks = [];
        sports.forEach(sport => {
            const sportName = sport.name;
            const fields = fieldsBySport[sportName] || sport.allowedFields || [sportName];
            fields.forEach(f => {
                const fieldName = fieldLabel(f);
                picks.push({
                    field: fieldName,
                    sport: sportName,
                    _activity: sportName
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

            if (!activityProperties[fieldName]) return false;

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
    // GENERAL ACTIVITY SELECTOR (MASTER SELECTOR)
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
        // 1) Try SPECIALS FIRST
        const specialPick = window.findBestSpecial(
            block,
            allActivities,
            fieldUsageBySlot,
            yesterdayHistory,
            activityProperties,
            rotationHistory,
            historicalCounts
        );
        if (specialPick) return specialPick;

        // 2) Try SPORTS SLOT
        const sportSlotPick = findBestSportsSlot(
            block,
            allActivities,
            fieldUsageBySlot,
            yesterdayHistory,
            activityProperties,
            rotationHistory,
            historicalCounts
        );
        if (sportSlotPick) return sportSlotPick;

        // 3) Try specific sport fallback
        const sportPick = window.findBestSportActivity(
            block,
            allActivities,
            fieldUsageBySlot,
            yesterdayHistory,
            activityProperties,
            rotationHistory,
            historicalCounts
        );
        if (sportPick) return sportPick;

        // 4) NOTHING FITS → Free
        return {
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

    // Expose reference to RotationEngine config
    Object.defineProperty(window, 'ROTATION_CONFIG', {
        get: function() {
            return window.RotationEngine?.CONFIG || {};
        }
    });

    console.log('[FILLERS] v6.0 loaded - DELEGATING to RotationEngine');

})();
