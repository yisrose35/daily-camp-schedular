
// ============================================================================
// scheduler_logic_fillers.js (FIXED v2)
// 
// CRITICAL FIXES:
// 1. Same-activity requirement when sharing fields
// 2. Adjacent bunk preference scoring
// 3. Proper capacity checks before assignment
// ============================================================================

(function () {
    'use strict';

    // ---------------------------------------------------------
    // Safe fieldLabel wrapper
    // ---------------------------------------------------------
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

    // ---------------------------------------------------------
    // Preference Score
    // ---------------------------------------------------------
    function calculatePreferenceScore(fieldProps, divName) {
        if (!fieldProps?.preferences?.enabled) return 0;

        const list = fieldProps.preferences.list || [];
        const idx = list.indexOf(divName);

        if (idx === -1) return -50;
        return 1000 - idx * 100;
    }

    // ---------------------------------------------------------
    // Get current field usage (for sharing checks)
    // ---------------------------------------------------------
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

    // ---------------------------------------------------------
    // Check if activity matches existing on field (for sharing)
    // ---------------------------------------------------------
    function canShareWithActivity(fieldName, block, activityName, activityProperties) {
        const state = getFieldCurrentState(fieldName, block);
        
        // Empty field - can use
        if (state.count === 0) return true;
        
        // Check capacity
        const props = activityProperties[fieldName] || {};
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable || props.sharableWith?.type === "all" || props.sharableWith?.type === "custom") {
            maxCapacity = 2;
        }
        
        // At capacity - can't share
        if (state.count >= maxCapacity) {
            return false;
        }
        
        // Check activity match
        if (state.activities.size > 0 && activityName) {
            const myActivity = activityName.toLowerCase().trim();
            if (!state.activities.has(myActivity)) {
                // Different activity - can't share
                return false;
            }
        }
        
        return true;
    }

    // ---------------------------------------------------------
    // Calculate sharing bonus (adjacent bunks score higher)
    // ---------------------------------------------------------
    function calculateSharingBonus(fieldName, block, activityProperties) {
        const state = getFieldCurrentState(fieldName, block);
        
        // Empty field - neutral
        if (state.count === 0) return 0;
        
        const myNum = getBunkNumber(block.bunk);
        if (myNum === Infinity) return 0;
        
        // Calculate average distance to existing bunks
        let totalDistance = 0;
        for (const existingBunk of state.bunks) {
            const existingNum = getBunkNumber(existingBunk);
            if (existingNum !== Infinity) {
                totalDistance += Math.abs(myNum - existingNum);
            }
        }
        
        const avgDistance = state.bunks.length > 0 ? totalDistance / state.bunks.length : 0;
        
        // Distance 1 = +100 bonus
        // Distance 2 = +80 bonus
        // Distance 5 = +20 bonus
        // Distance 10+ = 0 or negative
        const bonus = Math.max(0, 120 - avgDistance * 20);
        
        return bonus;
    }

    // ---------------------------------------------------------
    // Fairness Score (Sports Slot)
    // ---------------------------------------------------------
    function calculateFairnessScore(activityName, bunkName, rotationHistory, yesterdayHistory, doneToday) {
        const hist = rotationHistory?.bunks?.[bunkName] || {};
        const yesterday = yesterdayHistory?.[bunkName] || [];

        const count = hist[activityName] || 0;
        const didYesterday = yesterday.includes(activityName);
        const didToday = doneToday.has(activityName);

        let score = 0;

        // Prefer sports done least this week
        score -= count * 50;

        // Hard avoid yesterday unless no alternative
        if (didYesterday) score -= 600;

        // Never repeat today
        if (didToday) score -= 9999;

        return score;
    }

    // ---------------------------------------------------------
    // Freshness Sorting (ENHANCED with sharing logic)
    // ---------------------------------------------------------
    function sortPicksByFreshness(picks, bunkHist, divName, activityProperties, block) {
        return picks.sort((a, b) => {
            const fieldA = fieldLabel(a.field);
            const fieldB = fieldLabel(b.field);
            
            const propsA = activityProperties[fieldA] || {};
            const propsB = activityProperties[fieldB] || {};

            // 1. Preference score (division priority)
            const prefA = calculatePreferenceScore(propsA, divName);
            const prefB = calculatePreferenceScore(propsB, divName);
            if (prefA !== prefB) return prefB - prefA;

            // 2. Sharing bonus (adjacent bunks)
            const shareA = calculateSharingBonus(fieldA, block, activityProperties);
            const shareB = calculateSharingBonus(fieldB, block, activityProperties);
            if (shareA !== shareB) return shareB - shareA;

            // 3. Freshness (least recently used)
            const lastA = bunkHist[a._activity] || 0;
            const lastB = bunkHist[b._activity] || 0;
            if (lastA !== lastB) return lastA - lastB;

            return Math.random() - 0.5;
        });
    }

    // ---------------------------------------------------------
    // Determine activities already done today (no repeats)
    // ---------------------------------------------------------
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

    // ---------------------------------------------------------
    // Max Usage Guard
    // ---------------------------------------------------------
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
    // SPECIAL ACTIVITY SELECTOR (ENHANCED)
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

            // Check if can share (same activity requirement)
            if (!canShareWithActivity(fieldName, block, actName, activityProperties)) {
                return false;
            }

            // canBlockFit with activity name
            if (!window.SchedulerCoreUtils.canBlockFit(
                block,
                fieldName,
                activityProperties,
                fieldUsageBySlot,
                actName,
                false
            )) return false;

            // max usage
            if (isOverUsageLimit(actName, block.bunk, activityProperties, historicalCounts, doneToday))
                return false;

            // today repeat
            if (doneToday.has(actName)) return false;

            return true;
        });

        const sorted = sortPicksByFreshness(available, bunkHist, block.divName, activityProperties, block);
        return sorted[0] || null;
    };

    // ========================================================================
    // SPORTS ACTIVITY SELECTOR (ENHANCED)
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

            // Check if can share (same activity requirement)
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
    // SPORTS SLOT — FAIRNESS-BASED SELECTOR (ENHANCED)
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

        // Score with fairness AND sharing logic
        const scored = picks
            .map(pick => {
                const actName = pick._activity;
                const fieldName = pick.field;

                if (!activityProperties[fieldName]) return null;

                // Check sharing compatibility FIRST
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

                // Calculate score
                let score = 0;
                
                // Fairness score
                score += calculateFairnessScore(
                    actName,
                    block.bunk,
                    rotationHistory,
                    yesterdayHistory,
                    doneToday
                );
                
                // Sharing bonus (adjacent bunks)
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

        // 2) Try SPORTS SLOT (fairness-based with sharing logic)
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
