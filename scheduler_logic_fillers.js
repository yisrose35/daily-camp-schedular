// ============================================================================
// scheduler_logic_fillers.js (FIXED v3 - GLOBAL LOCK INTEGRATION)
// 
// CRITICAL UPDATE:
// - All filler functions check GlobalFieldLocks before considering a field
// - Locked fields are completely excluded from available options
// ============================================================================

(function () {
    'use strict';

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

    function calculatePreferenceScore(fieldProps, divName) {
        if (!fieldProps?.preferences?.enabled) return 0;

        const list = fieldProps.preferences.list || [];
        const idx = list.indexOf(divName);

        if (idx === -1) return -50;
        return 1000 - idx * 100;
    }

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
     * ★★★ CHECK IF FIELD IS GLOBALLY LOCKED ★★★
     */
    function isFieldGloballyLocked(fieldName, block) {
        if (!window.GlobalFieldLocks) return false;
        const slots = block.slots || [];
        if (slots.length === 0) return false;
        return window.GlobalFieldLocks.isFieldLocked(fieldName, slots) !== null;
    }

    function canShareWithActivity(fieldName, block, activityName, activityProperties) {
        // ★★★ CHECK GLOBAL LOCK FIRST ★★★
        if (isFieldGloballyLocked(fieldName, block)) {
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
        // ★★★ CHECK GLOBAL LOCK FIRST ★★★
        if (isFieldGloballyLocked(fieldName, block)) {
            return -999999; // Completely unavailable
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
        const bonus = Math.max(0, 120 - avgDistance * 20);
        
        return bonus;
    }

    function calculateFairnessScore(activityName, bunkName, rotationHistory, yesterdayHistory, doneToday) {
        const hist = rotationHistory?.bunks?.[bunkName] || {};
        const yesterday = yesterdayHistory?.[bunkName] || [];

        const count = hist[activityName] || 0;
        const didYesterday = yesterday.includes(activityName);
        const didToday = doneToday.has(activityName);

        let score = 0;
        score -= count * 50;
        if (didYesterday) score -= 600;
        if (didToday) score -= 9999;

        return score;
    }

    function sortPicksByFreshness(picks, bunkHist, divName, activityProperties, block) {
        return picks.sort((a, b) => {
            const fieldA = fieldLabel(a.field);
            const fieldB = fieldLabel(b.field);
            
            const propsA = activityProperties[fieldA] || {};
            const propsB = activityProperties[fieldB] || {};

            const prefA = calculatePreferenceScore(propsA, divName);
            const prefB = calculatePreferenceScore(propsB, divName);
            if (prefA !== prefB) return prefB - prefA;

            const shareA = calculateSharingBonus(fieldA, block, activityProperties);
            const shareB = calculateSharingBonus(fieldB, block, activityProperties);
            if (shareA !== shareB) return shareB - shareA;

            const lastA = bunkHist[a._activity] || 0;
            const lastB = bunkHist[b._activity] || 0;
            if (lastA !== lastB) return lastA - lastB;

            return Math.random() - 0.5;
        });
    }

    function getGeneralActivitiesDoneToday(bunkName, currentSlotIndex) {
        const set = new Set();
        const sched = window.scheduleAssignments?.[bunkName] || [];

        sched.forEach((e, idx) => {
            if (idx < currentSlotIndex && e?._activity && !e._isTransition) {
                set.add(e._activity);
            }
        });

        return set;
    }

    function isOverUsageLimit(activityName, bunk, activityProperties, historicalCounts, todaySet) {
        const props = activityProperties[activityName];
        const max = props?.maxUsage || 0;

        if (max === 0) return false;

        const history = historicalCounts?.[bunk]?.[activityName] || 0;

        if (history >= max) return true;
        if (todaySet.has(activityName) && history + 1 >= max) return true;

        return false;
    }

    // ========================================================================
    // SPECIAL ACTIVITY SELECTOR (WITH GLOBAL LOCK CHECK)
    // ========================================================================
    window.findBestSpecial = function (
        block,
        allActivities,
        fieldUsageBySlot,
        yesterdayHistory,
        activityProperties,
        rotationHistory,
        historicalCounts
    ) {
        const specials = allActivities
            .filter(a => a.type === 'Special' || a.type === 'special')
            .map(a => ({
                field: a.name,
                sport: null,
                _activity: a.name
            }));

        const bunkHist = rotationHistory?.bunks?.[block.bunk] || {};
        const currentSlotIndex = block.slots[0];
        const doneToday = getGeneralActivitiesDoneToday(block.bunk, currentSlotIndex);

        const available = specials.filter(pick => {
            const actName = pick._activity;
            const fieldName = fieldLabel(pick.field);

            // ★★★ CHECK GLOBAL LOCK FIRST ★★★
            if (isFieldGloballyLocked(fieldName, block)) {
                return false;
            }

            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                return false;
            }

            if (!window.SchedulerCoreUtils.canBlockFit(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return false;

            if (isOverUsageLimit(actName, block.bunk, activityProperties, historicalCounts, doneToday))
                return false;

            if (doneToday.has(actName)) return false;

            return true;
        });

        const sorted = sortPicksByFreshness(available, bunkHist, block.divName, activityProperties, block);
        return sorted[0] || null;
    };

    // ========================================================================
    // SPORTS ACTIVITY SELECTOR (WITH GLOBAL LOCK CHECK)
    // ========================================================================
    window.findBestSportActivity = function (
        block,
        allActivities,
        fieldUsageBySlot,
        yesterdayHistory,
        activityProperties,
        rotationHistory,
        historicalCounts
    ) {
        const bunkHist = rotationHistory?.bunks?.[block.bunk] || {};
        const fieldsBySport = window.SchedulerCoreUtils.loadAndFilterData().fieldsBySport || {};

        const currentSlotIndex = block.slots[0];
        const doneToday = getGeneralActivitiesDoneToday(block.bunk, currentSlotIndex);

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

            // ★★★ CHECK GLOBAL LOCK FIRST ★★★
            if (isFieldGloballyLocked(fieldName, block)) {
                return false;
            }

            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                return false;
            }

            if (!activityProperties[fieldName]) return false;

            if (!window.SchedulerCoreUtils.canBlockFit(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return false;

            if (doneToday.has(actName)) return false;

            return true;
        });

        const sorted = sortPicksByFreshness(available, bunkHist, block.divName, activityProperties, block);
        return sorted[0] || null;
    };

    // ========================================================================
    // SPORTS SLOT — FAIRNESS-BASED SELECTOR (WITH GLOBAL LOCK CHECK)
    // ========================================================================
    function findBestSportsSlot(block, allActivities, fieldUsageBySlot, yesterdayHistory,
                                activityProperties, rotationHistory, historicalCounts) {

        const fieldsBySport = window.SchedulerCoreUtils.loadAndFilterData().fieldsBySport || {};

        const currentSlotIndex = block.slots[0];
        const doneToday = getGeneralActivitiesDoneToday(block.bunk, currentSlotIndex);

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

        const scored = picks
            .map(pick => {
                const actName = pick._activity;
                const fieldName = pick.field;

                // ★★★ CHECK GLOBAL LOCK FIRST ★★★
                if (isFieldGloballyLocked(fieldName, block)) {
                    return null;
                }

                if (!activityProperties[fieldName]) return null;

                if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                    return null;
                }

                if (!window.SchedulerCoreUtils.canBlockFit(
                    block,
                    fieldName,
                    activityProperties,
                    fieldUsageBySlot,
                    actName,
                    false
                )) return null;

                let score = 0;
                
                score += calculateFairnessScore(
                    actName,
                    block.bunk,
                    rotationHistory,
                    yesterdayHistory,
                    doneToday
                );
                
                score += calculateSharingBonus(fieldName, block, activityProperties);

                return { ...pick, _score: score };
            })
            .filter(Boolean);

        if (scored.length === 0) return null;

        scored.sort((a, b) => b._score - a._score);
        return scored[0];
    }

    // ========================================================================
    // GENERAL ACTIVITY SELECTOR
    // ========================================================================
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
        const currentSlotIndex = block.slots[0];
        const doneToday = getGeneralActivitiesDoneToday(block.bunk, currentSlotIndex);

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

})();
