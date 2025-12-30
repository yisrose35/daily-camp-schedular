// ============================================================================
// scheduler_logic_fillers.js (SMART ROTATION v4)
// ============================================================================
// MAJOR UPDATE: Super Smart Activity Rotation System
//
// RULES:
// 1. HARD BLOCK: No bunk does same activity twice in one day (Infinity penalty)
// 2. STRONG: Yesterday's activities get heavy penalty (+5000)
// 3. MODERATE: Activities from 2-3 days ago get moderate penalty (+2000-3000)
// 4. BONUS: Never-done activities get strong bonus (-1500)
// 5. BONUS: Under-utilized activities get bonus (-800)
// 6. BALANCED: Tracks division-wide fairness
//
// SCORING PHILOSOPHY:
// - Lower scores = BETTER (we minimize penalty)
// - Activities are sorted by rotation score before selection
// - Field capacity and sharing rules still enforced
// ============================================================================

(function () {
    'use strict';

    // =========================================================================
    // ROTATION CONFIGURATION
    // =========================================================================
    const ROTATION_CONFIG = {
        // Hard rules
        SAME_DAY_PENALTY: Infinity,            // NEVER allow same activity twice in one day

        // Recency penalties (how many days ago did they do it?)
        YESTERDAY_PENALTY: 5000,               // Did it yesterday
        TWO_DAYS_AGO_PENALTY: 3000,            // Did it 2 days ago
        THREE_DAYS_AGO_PENALTY: 2000,          // Did it 3 days ago
        FOUR_TO_SEVEN_DAYS_PENALTY: 800,       // Did it 4-7 days ago
        WEEK_PLUS_PENALTY: 200,                // Did it more than a week ago

        // Frequency penalties (how often compared to other activities?)
        HIGH_FREQUENCY_PENALTY: 1500,          // Done this much more than others
        ABOVE_AVERAGE_PENALTY: 500,            // Done this more than average

        // Variety bonuses (negative = good)
        NEVER_DONE_BONUS: -1500,               // NEVER done this activity before
        UNDER_UTILIZED_BONUS: -800,            // Done less than average
        VARIETY_BONUS: -300,                   // Adding variety to today
        BALANCE_BONUS: -200,                   // Balancing sports vs specials today

        // Decay factor for old activities
        RECENCY_DECAY: 0.7,

        // Weights
        WEIGHTS: {
            recency: 1.0,
            frequency: 0.8,
            variety: 1.2,
            distribution: 0.6
        }
    };

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
        // Check disabled fields (rainy day, manual overrides)
        const disabledFields = window.currentDisabledFields || [];
        if (disabledFields.includes(fieldName)) {
            return true;
        }

        // Check global locks
        if (!window.GlobalFieldLocks) return false;
        const slots = block.slots || [];
        if (slots.length === 0) return false;

        const divisionContext = block.divName || block.division;
        return window.GlobalFieldLocks.isFieldLocked(fieldName, slots, divisionContext) !== null;
    }

    // =========================================================================
    // ★★★ SMART ROTATION TRACKING ★★★
    // =========================================================================

    /**
     * Get all activities done by a bunk TODAY (before current slot)
     * This is the PRIMARY check for same-day blocking
     */
    function getActivitiesDoneToday(bunkName, beforeSlotIndex) {
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
     * Get activities done YESTERDAY (for recency penalty)
     */
    function getActivitiesFromYesterday(bunkName) {
        const activities = new Set();

        try {
            const allDaily = window.loadAllDailyData?.() || {};
            const currentDate = window.currentScheduleDate;

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
            // Silent fail - yesterday data may not exist
        }

        return activities;
    }

    /**
     * Get how many days since bunk last did an activity
     * Returns: null (never), 0 (today), 1 (yesterday), etc.
     */
    function getDaysSinceActivity(bunkName, activityName, beforeSlotIndex) {
        const actLower = activityName.toLowerCase().trim();

        // Check today first
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0; // Done today
        }

        // Check rotation history for timestamps
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName];

        if (lastTimestamp) {
            const now = Date.now();
            const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
            return Math.max(1, daysSince);
        }

        // Check historical counts as fallback
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        if (historicalCounts[bunkName]?.[activityName] > 0) {
            return 14; // Assume 2 weeks ago if count exists but no timestamp
        }

        return null; // Never done
    }

    /**
     * Get total count of how many times bunk has done an activity
     */
    function getActivityCount(bunkName, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};

        const baseCount = historicalCounts[bunkName]?.[activityName] || 0;
        const offset = manualOffsets[bunkName]?.[activityName] || 0;

        return Math.max(0, baseCount + offset);
    }

    /**
     * Get average activity count for bunk across all activities
     */
    function getBunkAverageCount(bunkName, allActivityNames) {
        if (!allActivityNames || allActivityNames.length === 0) return 0;

        let total = 0;
        for (const act of allActivityNames) {
            total += getActivityCount(bunkName, act);
        }

        return total / allActivityNames.length;
    }

    /**
     * Get all unique activity names from config
     */
    function getAllActivityNames() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || [];
        const specials = globalSettings.app1?.specialActivities || [];

        const names = new Set();

        fields.forEach(f => {
            (f.activities || []).forEach(sport => names.add(sport));
        });

        specials.forEach(s => {
            if (s.name) names.add(s.name);
        });

        return [...names];
    }

    /**
     * Check if activity is a "special" type
     */
    function isSpecialActivity(activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specials = globalSettings.app1?.specialActivities || [];
        const specialNames = new Set(specials.map(s => s.name.toLowerCase().trim()));
        return specialNames.has((activityName || '').toLowerCase().trim());
    }

    // =========================================================================
    // ★★★ ROTATION SCORING FUNCTIONS ★★★
    // =========================================================================

    /**
     * Calculate RECENCY score - how recently did they do this?
     * LOWER IS BETTER
     */
    function calculateRecencyScore(bunkName, activityName, beforeSlotIndex) {
        const daysSince = getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);

        if (daysSince === null) {
            // NEVER done - this is GREAT!
            return ROTATION_CONFIG.NEVER_DONE_BONUS;
        }

        if (daysSince === 0) {
            // Same day - FORBIDDEN
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        }

        if (daysSince === 1) {
            return ROTATION_CONFIG.YESTERDAY_PENALTY;
        }

        if (daysSince === 2) {
            return ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY;
        }

        if (daysSince === 3) {
            return ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY;
        }

        if (daysSince <= 7) {
            return ROTATION_CONFIG.FOUR_TO_SEVEN_DAYS_PENALTY;
        }

        // More than a week ago - decay penalty over time
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, ROTATION_CONFIG.WEEK_PLUS_PENALTY * Math.pow(ROTATION_CONFIG.RECENCY_DECAY, weeksAgo));
    }

    /**
     * Calculate FREQUENCY score - how often have they done this vs other activities?
     * LOWER IS BETTER
     */
    function calculateFrequencyScore(bunkName, activityName) {
        const allActivities = getAllActivityNames();
        if (allActivities.length === 0) return 0;

        const count = getActivityCount(bunkName, activityName);
        const average = getBunkAverageCount(bunkName, allActivities);
        const deviation = count - average;

        if (deviation <= -2) {
            // Significantly under-utilized - bonus!
            return ROTATION_CONFIG.UNDER_UTILIZED_BONUS;
        }

        if (deviation < 0) {
            // Slightly under-utilized
            return ROTATION_CONFIG.VARIETY_BONUS;
        }

        if (deviation === 0) {
            return 0;
        }

        if (deviation <= 2) {
            return ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        }

        // Significantly over-used
        return ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY + (deviation - 2) * 200;
    }

    /**
     * Calculate VARIETY score - how much variety does this add to today?
     * LOWER IS BETTER
     */
    function calculateVarietyScore(bunkName, activityName, beforeSlotIndex) {
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = activityName.toLowerCase().trim();

        // Already done today - FORBIDDEN
        if (todayActivities.has(actLower)) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        }

        // Check activity type balance (sports vs specials)
        let todaySports = 0;
        let todaySpecials = 0;

        for (const act of todayActivities) {
            if (isSpecialActivity(act)) {
                todaySpecials++;
            } else {
                todaySports++;
            }
        }

        const thisIsSpecial = isSpecialActivity(activityName);

        // Bonus for balancing the day
        if (thisIsSpecial && todaySports > todaySpecials) {
            return ROTATION_CONFIG.BALANCE_BONUS;
        }

        if (!thisIsSpecial && todaySpecials > todaySports) {
            return ROTATION_CONFIG.BALANCE_BONUS;
        }

        // General variety bonus based on unique activities today
        const uniqueToday = todayActivities.size;
        return -50 * Math.min(uniqueToday, 4);
    }

    /**
     * Calculate DISTRIBUTION score - fairness across division
     * LOWER IS BETTER
     */
    function calculateDistributionScore(bunkName, activityName, divisionName) {
        const divisions = window.divisions || {};
        const bunksInDiv = divisions[divisionName]?.bunks || [];

        if (bunksInDiv.length <= 1) return 0;

        const counts = bunksInDiv.map(b => getActivityCount(b, activityName));
        const myCount = getActivityCount(bunkName, activityName);

        const minCount = Math.min(...counts);
        const maxCount = Math.max(...counts);

        if (myCount === maxCount && maxCount > minCount) {
            // This bunk has done it most - penalty
            return 300 * (maxCount - minCount);
        }

        if (myCount === minCount && maxCount > minCount) {
            // This bunk has done it least - bonus
            return -300;
        }

        return 0;
    }

    /**
     * Calculate LIMIT score - for activities with usage limits
     */
    function calculateLimitScore(bunkName, activityName, activityProperties, todaySet) {
        const props = activityProperties?.[activityName] || {};
        const maxUsage = props.maxUsage || 0;

        if (maxUsage <= 0) return 0;

        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        const hist = historicalCounts[bunkName]?.[activityName] || 0;
        const todayCount = todaySet.has(activityName.toLowerCase().trim()) ? 1 : 0;

        if (hist + todayCount >= maxUsage) {
            return Infinity; // At limit
        }

        if (hist + todayCount >= maxUsage - 1) {
            return 2000; // One away
        }

        if (hist + todayCount >= maxUsage - 2) {
            return 800; // Two away
        }

        return 0;
    }

    /**
     * ★★★ MASTER ROTATION SCORE CALCULATOR ★★★
     * Returns total rotation penalty for an activity choice
     * LOWER IS BETTER, Infinity means BLOCKED
     */
    function calculateRotationScore(bunkName, activityName, block, activityProperties) {
        if (!activityName || activityName === 'Free') return 0;

        const beforeSlotIndex = block.slots?.[0] || 0;
        const divisionName = block.divName || block.division;
        const todaySet = getActivitiesDoneToday(bunkName, beforeSlotIndex);

        // RECENCY - most important
        const recencyScore = calculateRecencyScore(bunkName, activityName, beforeSlotIndex);

        // If same day, stop immediately
        if (recencyScore === Infinity) {
            return Infinity;
        }

        // VARIETY - also checks same day
        const varietyScore = calculateVarietyScore(bunkName, activityName, beforeSlotIndex);

        if (varietyScore === Infinity) {
            return Infinity;
        }

        // FREQUENCY
        const frequencyScore = calculateFrequencyScore(bunkName, activityName);

        // DISTRIBUTION
        const distributionScore = calculateDistributionScore(bunkName, activityName, divisionName);

        // LIMIT
        const limitScore = calculateLimitScore(bunkName, activityName, activityProperties, todaySet);

        if (limitScore === Infinity) {
            return Infinity;
        }

        // Combine with weights
        const totalScore = (
            recencyScore * ROTATION_CONFIG.WEIGHTS.recency +
            frequencyScore * ROTATION_CONFIG.WEIGHTS.frequency +
            varietyScore * ROTATION_CONFIG.WEIGHTS.variety +
            distributionScore * ROTATION_CONFIG.WEIGHTS.distribution +
            limitScore
        );

        return totalScore;
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

        // Must be same activity when sharing
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
    // ★★★ SMART PICK SORTING - ROTATION AWARE ★★★
    // =========================================================================

    /**
     * Sort picks by rotation score (LOWER IS BETTER)
     * This is the key function that makes rotation "super smart"
     */
    function sortPicksByRotationScore(picks, block, activityProperties) {
        const bunkName = block.bunk;
        const divName = block.divName;

        return picks
            .map(pick => {
                const actName = pick._activity || pick.sport || fieldLabel(pick.field);
                const fieldName = fieldLabel(pick.field);

                // Calculate rotation score
                const rotationScore = calculateRotationScore(bunkName, actName, block, activityProperties);

                // If blocked by rotation, mark as such
                if (rotationScore === Infinity) {
                    return { ...pick, _rotationScore: Infinity, _blocked: true };
                }

                // Calculate other scores
                const fieldProps = activityProperties[fieldName] || {};
                const preferenceScore = calculatePreferenceScore(fieldProps, divName);
                const sharingBonus = calculateSharingBonus(fieldName, block, activityProperties);

                // Combined score (lower is better)
                // Rotation score is PRIMARY, preference and sharing are secondary
                const totalScore = rotationScore - preferenceScore - sharingBonus;

                return { ...pick, _rotationScore: rotationScore, _totalScore: totalScore, _blocked: false };
            })
            .filter(pick => !pick._blocked) // Remove blocked picks
            .sort((a, b) => a._totalScore - b._totalScore); // Sort by total score (ascending)
    }

    // =========================================================================
    // SPECIAL ACTIVITY SELECTOR (WITH SMART ROTATION)
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

        // Filter by availability and capacity
        const available = specials.filter(pick => {
            const actName = pick._activity;
            const fieldName = fieldLabel(pick.field);

            if (isFieldUnavailable(fieldName, block)) {
                return false;
            }

            // ★★★ ROTATION CHECK - Block same-day repeats ★★★
            if (doneToday.has(actName.toLowerCase().trim())) {
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

            return true;
        });

        // ★★★ SORT BY ROTATION SCORE ★★★
        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    };

    // =========================================================================
    // SPORTS ACTIVITY SELECTOR (WITH SMART ROTATION)
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
        const fieldsBySport = window.SchedulerCoreUtils.loadAndFilterData().fieldsBySport || {};
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

        // Filter by availability and capacity
        const available = sports.filter(pick => {
            const actName = pick._activity;
            const fieldName = fieldLabel(pick.field);

            if (isFieldUnavailable(fieldName, block)) {
                return false;
            }

            // ★★★ ROTATION CHECK - Block same-day repeats ★★★
            if (doneToday.has(actName.toLowerCase().trim())) {
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

            return true;
        });

        // ★★★ SORT BY ROTATION SCORE ★★★
        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    };

    // =========================================================================
    // SPORTS SLOT — FAIRNESS-BASED SELECTOR (WITH SMART ROTATION)
    // =========================================================================

    function findBestSportsSlot(block, allActivities, fieldUsageBySlot, yesterdayHistory,
                                activityProperties, rotationHistory, historicalCounts) {
        const fieldsBySport = window.SchedulerCoreUtils.loadAndFilterData().fieldsBySport || {};
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

        // Filter by availability
        const available = picks.filter(pick => {
            const actName = pick._activity;
            const fieldName = pick.field;

            if (isFieldUnavailable(fieldName, block)) {
                return false;
            }

            // ★★★ ROTATION CHECK - Block same-day repeats ★★★
            if (doneToday.has(actName.toLowerCase().trim())) {
                return false;
            }

            if (!activityProperties[fieldName]) return false;

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

            return true;
        });

        // ★★★ SORT BY ROTATION SCORE ★★★
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
    // DEBUG UTILITIES
    // =========================================================================

    /**
     * Debug: Show rotation analysis for a bunk
     */
    window.debugFillerRotation = function(bunkName, slotIndex = 0) {
        console.log('\n' + '='.repeat(60));
        console.log(`FILLER ROTATION DEBUG: ${bunkName} @ slot ${slotIndex}`);
        console.log('='.repeat(60));

        const todayActivities = getActivitiesDoneToday(bunkName, slotIndex);
        console.log(`\nDone Today (${todayActivities.size}): ${[...todayActivities].join(', ') || 'none'}`);

        const yesterdayActivities = getActivitiesFromYesterday(bunkName);
        console.log(`Done Yesterday (${yesterdayActivities.size}): ${[...yesterdayActivities].join(', ') || 'none'}`);

        const allActivities = getAllActivityNames();
        console.log(`\nAll Activities (${allActivities.length}):`);

        const fakeBlock = { bunk: bunkName, slots: [slotIndex], divName: 'Unknown' };
        const activityProperties = window.activityProperties || {};

        const scored = allActivities.map(act => {
            const score = calculateRotationScore(bunkName, act, fakeBlock, activityProperties);
            return { activity: act, score };
        }).sort((a, b) => a.score - b.score);

        console.log('\nRanked by Rotation Score (best first):');
        scored.slice(0, 15).forEach((item, i) => {
            const status = item.score === Infinity ? '❌ BLOCKED' : item.score.toFixed(0);
            console.log(`  ${i + 1}. ${item.activity}: ${status}`);
        });

        const blocked = scored.filter(s => s.score === Infinity);
        console.log(`\nBlocked Activities: ${blocked.map(b => b.activity).join(', ') || 'none'}`);

        console.log('\n' + '='.repeat(60));
    };

    /**
     * Debug: Show rotation configuration
     */
    window.debugRotationConfig = function() {
        console.log('\n=== ROTATION CONFIGURATION ===');
        console.log('Same Day Penalty:', ROTATION_CONFIG.SAME_DAY_PENALTY);
        console.log('Yesterday Penalty:', ROTATION_CONFIG.YESTERDAY_PENALTY);
        console.log('2 Days Ago Penalty:', ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY);
        console.log('3 Days Ago Penalty:', ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY);
        console.log('4-7 Days Penalty:', ROTATION_CONFIG.FOUR_TO_SEVEN_DAYS_PENALTY);
        console.log('Week+ Penalty:', ROTATION_CONFIG.WEEK_PLUS_PENALTY);
        console.log('Never Done Bonus:', ROTATION_CONFIG.NEVER_DONE_BONUS);
        console.log('Under-Utilized Bonus:', ROTATION_CONFIG.UNDER_UTILIZED_BONUS);
        console.log('Weights:', ROTATION_CONFIG.WEIGHTS);
    };

    // Expose config for tuning
    window.ROTATION_CONFIG = ROTATION_CONFIG;

    console.log('[FILLERS] Smart Rotation v4 loaded - Super smart activity distribution enabled');

})();
