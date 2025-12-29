// ============================================================================
// rotation_engine.js - SMART ACTIVITY ROTATION SYSTEM
// ============================================================================
// This module provides intelligent activity distribution to ensure:
// 1. No bunk does the same activity twice in one day (HARD RULE)
// 2. Activities are spread out over multiple days (STRONG PREFERENCE)
// 3. All bunks get fair access to all activities over time
// 4. Variety is maximized - bunks try different things
//
// SCORING PHILOSOPHY:
// - Lower scores = BETTER (we minimize penalty)
// - Same day repeat = IMPOSSIBLE (returns Infinity)
// - Yesterday repeat = Very bad (+5000)
// - Recent repeat (2-3 days) = Bad (+2000-3000)
// - Older repeat (4-7 days) = Moderate (+500-1000)
// - Never done before = BONUS (-1000)
// - Under-utilized activity = BONUS (-500)
// ============================================================================

(function() {
    'use strict';

    const RotationEngine = {};

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    const CONFIG = {
        // Hard rules
        SAME_DAY_PENALTY: Infinity,           // NEVER allow same activity twice in one day
        
        // Recency penalties (days ago)
        YESTERDAY_PENALTY: 5000,              // Did it yesterday
        TWO_DAYS_AGO_PENALTY: 3000,           // Did it 2 days ago
        THREE_DAYS_AGO_PENALTY: 2000,         // Did it 3 days ago
        FOUR_TO_SEVEN_DAYS_PENALTY: 1000,     // Did it 4-7 days ago
        WEEK_PLUS_PENALTY: 200,               // Did it more than a week ago
        
        // Frequency penalties
        HIGH_FREQUENCY_PENALTY: 1500,         // Bunk has done this activity much more than others
        ABOVE_AVERAGE_PENALTY: 500,           // Bunk has done this more than average
        
        // Variety bonuses (negative = good)
        NEVER_DONE_BONUS: -1500,              // Bunk has NEVER done this activity
        UNDER_UTILIZED_BONUS: -800,           // Activity is under-utilized by this bunk
        GOOD_VARIETY_BONUS: -300,             // General variety bonus
        
        // Adjacent bunk bonuses (when sharing fields)
        ADJACENT_BUNK_BONUS: -200,            // Bunks are numerically adjacent
        SAME_DIVISION_BONUS: -100,            // Bunks are in same division
        
        // Special activity considerations
        LIMITED_ACTIVITY_PENALTY: 800,        // Activity has usage limits - be careful
        NEAR_LIMIT_PENALTY: 2000,             // Bunk is close to hitting limit
        
        // Time decay factor (how quickly recency penalty decreases)
        RECENCY_DECAY_FACTOR: 0.7,            // Each day reduces penalty by this factor
        
        // Weights for different scoring components
        WEIGHTS: {
            recency: 1.0,                     // How recently did they do it?
            frequency: 0.8,                   // How often have they done it overall?
            variety: 1.2,                     // How much variety does this add?
            distribution: 0.6                 // How balanced is activity distribution?
        }
    };

    // =========================================================================
    // STATE MANAGEMENT
    // =========================================================================
    
    /**
     * Get all activities done by a bunk TODAY (before a specific slot)
     */
    RotationEngine.getActivitiesDoneToday = function(bunkName, beforeSlotIndex) {
        const activities = new Set();
        const schedule = window.scheduleAssignments?.[bunkName] || [];
        
        // Fix #1: Enhanced activity detection logic
        for (let i = 0; i < beforeSlotIndex && i < schedule.length; i++) {
            const entry = schedule[i];
            if (!entry || entry._isTransition || entry.continuation) continue;
            
            // Check multiple property names for activity
            const activityName = entry._activity || entry.sport || 
                (typeof entry.field === 'string' ? entry.field : entry.field?.name);
            
            if (activityName) {
                activities.add(activityName.toLowerCase().trim());
            }
        }
        
        return activities;
    };

    /**
     * Get activities done by a bunk YESTERDAY
     */
    RotationEngine.getActivitiesDoneYesterday = function(bunkName) {
        const activities = new Set();
        
        try {
            const allDaily = window.loadAllDailyData?.() || {};
            const currentDate = window.currentScheduleDate;
            
            if (!currentDate) return activities;
            
            // Calculate yesterday's date
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
            console.warn('[ROTATION] Error getting yesterday activities:', e);
        }
        
        return activities;
    };

    /**
     * Get the last time a bunk did a specific activity (days ago)
     * Returns null if never done, 0 if done today, 1 if yesterday, etc.
     */
    RotationEngine.getDaysSinceActivity = function(bunkName, activityName, beforeSlotIndex) {
        const actLower = activityName.toLowerCase().trim();
        
        // Check today first
        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0; // Done today
        }
        
        // Check rotation history
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName];
        
        if (!lastTimestamp) {
            // Check historical counts - if count > 0, they've done it but we don't know when
            const globalSettings = window.loadGlobalSettings?.() || {};
            const historicalCounts = globalSettings.historicalCounts || {};
            if (historicalCounts[bunkName]?.[activityName] > 0) {
                return 14; // Assume 2 weeks ago if we have count but no timestamp
            }
            return null; // Never done
        }
        
        const now = Date.now();
        const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
        return Math.max(1, daysSince); // At least 1 day if it's in history
    };

    /**
     * Get total count of how many times a bunk has done an activity
     */
    RotationEngine.getActivityCount = function(bunkName, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};
        
        const baseCount = historicalCounts[bunkName]?.[activityName] || 0;
        const offset = manualOffsets[bunkName]?.[activityName] || 0;
        
        return Math.max(0, baseCount + offset);
    };

    /**
     * Get average activity count for a bunk across all activities
     */
    RotationEngine.getBunkAverageActivityCount = function(bunkName, allActivities) {
        if (!allActivities || allActivities.length === 0) return 0;
        
        let total = 0;
        for (const act of allActivities) {
            total += RotationEngine.getActivityCount(bunkName, act);
        }
        
        return total / allActivities.length;
    };

    /**
     * Get how "overused" an activity is for a specific bunk
     * Returns: negative = under-used, 0 = average, positive = over-used
     */
    RotationEngine.getActivityUsageDeviation = function(bunkName, activityName, allActivities) {
        const count = RotationEngine.getActivityCount(bunkName, activityName);
        const average = RotationEngine.getBunkAverageActivityCount(bunkName, allActivities);
        
        return count - average;
    };

    // =========================================================================
    // SCORING FUNCTIONS
    // =========================================================================

    /**
     * Calculate RECENCY score - how recently did they do this?
     * Higher = worse (more recent = higher penalty)
     */
    RotationEngine.calculateRecencyScore = function(bunkName, activityName, beforeSlotIndex) {
        const daysSince = RotationEngine.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        
        if (daysSince === null) {
            // Never done - this is GREAT!
            return CONFIG.NEVER_DONE_BONUS;
        }
        
        if (daysSince === 0) {
            // Same day - FORBIDDEN
            return CONFIG.SAME_DAY_PENALTY;
        }
        
        if (daysSince === 1) {
            return CONFIG.YESTERDAY_PENALTY;
        }
        
        if (daysSince === 2) {
            return CONFIG.TWO_DAYS_AGO_PENALTY;
        }
        
        if (daysSince === 3) {
            return CONFIG.THREE_DAYS_AGO_PENALTY;
        }
        
        if (daysSince <= 7) {
            return CONFIG.FOUR_TO_SEVEN_DAYS_PENALTY;
        }
        
        // More than a week ago - apply decay
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, CONFIG.WEEK_PLUS_PENALTY * Math.pow(CONFIG.RECENCY_DECAY_FACTOR, weeksAgo));
    };

    /**
     * Calculate FREQUENCY score - how often have they done this compared to other activities?
     * Higher = worse (done too often = higher penalty)
     */
    RotationEngine.calculateFrequencyScore = function(bunkName, activityName, allActivities) {
        const deviation = RotationEngine.getActivityUsageDeviation(bunkName, activityName, allActivities);
        
        if (deviation <= -2) {
            // Significantly under-utilized - bonus!
            return CONFIG.UNDER_UTILIZED_BONUS;
        }
        
        if (deviation < 0) {
            // Slightly under-utilized
            return CONFIG.GOOD_VARIETY_BONUS;
        }
        
        if (deviation === 0) {
            // Average usage
            return 0;
        }
        
        if (deviation <= 2) {
            // Slightly over-used
            return CONFIG.ABOVE_AVERAGE_PENALTY;
        }
        
        // Significantly over-used
        return CONFIG.HIGH_FREQUENCY_PENALTY + (deviation - 2) * 200;
    };

    /**
     * Calculate VARIETY score - how much variety does this add?
     * Considers what activities the bunk has done today
     */
    RotationEngine.calculateVarietyScore = function(bunkName, activityName, beforeSlotIndex, allActivities) {
        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = activityName.toLowerCase().trim();
        
        // Already done today - FORBIDDEN
        if (todayActivities.has(actLower)) {
            return CONFIG.SAME_DAY_PENALTY;
        }
        
        // Check if this activity type (sport vs special) adds variety
        const todaySports = new Set();
        const todaySpecials = new Set();
        
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specialNames = new Set(
            (globalSettings.app1?.specialActivities || []).map(s => s.name.toLowerCase().trim())
        );
        
        for (const act of todayActivities) {
            if (specialNames.has(act)) {
                todaySpecials.add(act);
            } else {
                todaySports.add(act);
            }
        }
        
        const isSpecial = specialNames.has(actLower);
        
        // Bonus if this balances the day's activities
        if (isSpecial && todaySports.size > todaySpecials.size) {
            return -200; // Bonus for adding a special when they've done more sports
        }
        
        if (!isSpecial && todaySpecials.size > todaySports.size) {
            return -200; // Bonus for adding a sport when they've done more specials
        }
        
        // General variety bonus based on how many unique activities today
        const uniqueToday = todayActivities.size;
        if (uniqueToday >= 4) {
            return -100; // Small bonus - they already have good variety
        }
        
        return -50 * uniqueToday; // More bonus for early variety
    };

    /**
     * Calculate DISTRIBUTION score - how balanced is this activity's usage across all bunks?
     */
    RotationEngine.calculateDistributionScore = function(bunkName, activityName, divisionName) {
        const divisions = window.divisions || {};
        const bunksInDiv = divisions[divisionName]?.bunks || [];
        
        if (bunksInDiv.length <= 1) return 0;
        
        // Get activity counts for all bunks in division
        const counts = bunksInDiv.map(b => RotationEngine.getActivityCount(b, activityName));
        const myCount = RotationEngine.getActivityCount(bunkName, activityName);
        
        const minCount = Math.min(...counts);
        const maxCount = Math.max(...counts);
        
        // If this bunk has done it most, penalty
        if (myCount === maxCount && maxCount > minCount) {
            return 300 * (maxCount - minCount);
        }
        
        // If this bunk has done it least, bonus
        if (myCount === minCount && maxCount > minCount) {
            return -300;
        }
        
        return 0;
    };

    /**
     * Calculate LIMIT score - for activities with usage limits
     */
    RotationEngine.calculateLimitScore = function(bunkName, activityName, activityProperties) {
        const props = activityProperties?.[activityName] || {};
        const maxUsage = props.maxUsage || 0;
        
        if (maxUsage <= 0) return 0; // No limit
        
        const currentCount = RotationEngine.getActivityCount(bunkName, activityName);
        
        if (currentCount >= maxUsage) {
            return Infinity; // At limit - cannot use
        }
        
        if (currentCount >= maxUsage - 1) {
            return CONFIG.NEAR_LIMIT_PENALTY; // One away from limit
        }
        
        if (currentCount >= maxUsage - 2) {
            return CONFIG.LIMITED_ACTIVITY_PENALTY; // Getting close
        }
        
        return 0;
    };

    // =========================================================================
    // MAIN SCORING FUNCTION
    // =========================================================================

    /**
     * Calculate the complete rotation score for an activity
     * LOWER IS BETTER
     * Returns Infinity if the activity is not allowed
     */
    RotationEngine.calculateRotationScore = function(options) {
        const {
            bunkName,
            activityName,
            divisionName,
            beforeSlotIndex,
            allActivities,
            activityProperties
        } = options;
        
        if (!bunkName || !activityName) return Infinity;
        
        // Calculate individual scores
        const recencyScore = RotationEngine.calculateRecencyScore(bunkName, activityName, beforeSlotIndex);
        
        // If recency returns Infinity (same day), stop immediately
        if (recencyScore === Infinity || recencyScore === CONFIG.SAME_DAY_PENALTY) {
            return Infinity;
        }
        
        const frequencyScore = RotationEngine.calculateFrequencyScore(bunkName, activityName, allActivities);
        const varietyScore = RotationEngine.calculateVarietyScore(bunkName, activityName, beforeSlotIndex, allActivities);
        const distributionScore = RotationEngine.calculateDistributionScore(bunkName, activityName, divisionName);
        const limitScore = RotationEngine.calculateLimitScore(bunkName, activityName, activityProperties);
        
        // If limit score is Infinity, stop
        if (limitScore === Infinity) {
            return Infinity;
        }
        
        // Combine scores with weights
        const totalScore = (
            recencyScore * CONFIG.WEIGHTS.recency +
            frequencyScore * CONFIG.WEIGHTS.frequency +
            varietyScore * CONFIG.WEIGHTS.variety +
            distributionScore * CONFIG.WEIGHTS.distribution +
            limitScore
        );
        
        return totalScore;
    };

    /**
     * Get a ranked list of activities for a bunk, sorted by rotation score
     * Returns array of { activity, score } sorted by score (lowest first = best)
     */
    RotationEngine.getRankedActivities = function(options) {
        const {
            bunkName,
            divisionName,
            beforeSlotIndex,
            availableActivities,
            activityProperties
        } = options;
        
        const allActivityNames = availableActivities.map(a => 
            typeof a === 'string' ? a : (a.name || a._activity || a.field)
        );
        
        const scored = availableActivities.map(activity => {
            const actName = typeof activity === 'string' ? activity : (activity.name || activity._activity || activity.field);
            
            const score = RotationEngine.calculateRotationScore({
                bunkName,
                activityName: actName,
                divisionName,
                beforeSlotIndex,
                allActivities: allActivityNames,
                activityProperties
            });
            
            return {
                activity,
                activityName: actName,
                score,
                allowed: score !== Infinity
            };
        });
        
        // Sort by score (lowest first)
        scored.sort((a, b) => a.score - b.score);
        
        return scored;
    };

    // =========================================================================
    // DEBUG UTILITIES
    // =========================================================================

    /**
     * Debug: Show rotation analysis for a specific bunk
     */
    RotationEngine.debugBunkRotation = function(bunkName) {
        console.log('\n' + '='.repeat(60));
        console.log(`ROTATION ANALYSIS: ${bunkName}`);
        console.log('='.repeat(60));
        
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || [];
        const specials = globalSettings.app1?.specialActivities || [];
        
        const allActivities = [
            ...fields.flatMap(f => f.activities || []),
            ...specials.map(s => s.name)
        ];
        
        const uniqueActivities = [...new Set(allActivities)].sort();
        
        console.log('\nActivity History:');
        uniqueActivities.forEach(act => {
            const count = RotationEngine.getActivityCount(bunkName, act);
            const daysSince = RotationEngine.getDaysSinceActivity(bunkName, act, 999);
            const daysStr = daysSince === null ? 'never' : (daysSince === 0 ? 'TODAY' : `${daysSince}d ago`);
            
            console.log(`  ${act}: count=${count}, last=${daysStr}`);
        });
        
        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, 999);
        console.log(`\nDone Today: ${[...todayActivities].join(', ') || 'none'}`);
        
        const yesterdayActivities = RotationEngine.getActivitiesDoneYesterday(bunkName);
        console.log(`Done Yesterday: ${[...yesterdayActivities].join(', ') || 'none'}`);
        
        console.log('\n' + '='.repeat(60));
    };

    /**
     * Debug: Show recommended activities for a bunk
     */
    RotationEngine.debugRecommendations = function(bunkName, divisionName, slotIndex) {
        console.log('\n' + '='.repeat(60));
        console.log(`ACTIVITY RECOMMENDATIONS: ${bunkName} @ slot ${slotIndex}`);
        console.log('='.repeat(60));
        
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || [];
        const specials = globalSettings.app1?.specialActivities || [];
        const activityProperties = window.activityProperties || {};
        
        const allActivities = [
            ...fields.flatMap(f => (f.activities || []).map(sport => ({ name: sport, type: 'sport' }))),
            ...specials.map(s => ({ name: s.name, type: 'special' }))
        ];
        
        const ranked = RotationEngine.getRankedActivities({
            bunkName,
            divisionName,
            beforeSlotIndex: slotIndex,
            availableActivities: allActivities,
            activityProperties
        });
        
        console.log('\nRanked Activities (best to worst):');
        ranked.slice(0, 15).forEach((item, i) => {
            const status = item.allowed ? '✅' : '❌';
            const scoreStr = item.score === Infinity ? 'BLOCKED' : item.score.toFixed(0);
            console.log(`  ${i + 1}. ${status} ${item.activityName}: ${scoreStr}`);
        });
        
        const blocked = ranked.filter(r => !r.allowed);
        if (blocked.length > 0) {
            console.log(`\nBlocked (${blocked.length}): ${blocked.map(b => b.activityName).join(', ')}`);
        }
        
        console.log('\n' + '='.repeat(60));
    };

    /**
     * Debug: Show division-wide rotation status
     */
    RotationEngine.debugDivisionRotation = function(divisionName) {
        const divisions = window.divisions || {};
        const bunks = divisions[divisionName]?.bunks || [];
        
        console.log('\n' + '='.repeat(70));
        console.log(`DIVISION ROTATION STATUS: ${divisionName}`);
        console.log('='.repeat(70));
        
        if (bunks.length === 0) {
            console.log('No bunks in division');
            return;
        }
        
        const globalSettings = window.loadGlobalSettings?.() || {};
        const fields = globalSettings.app1?.fields || [];
        const specials = globalSettings.app1?.specialActivities || [];
        
        const allActivities = [
            ...new Set([
                ...fields.flatMap(f => f.activities || []),
                ...specials.map(s => s.name)
            ])
        ].sort();
        
        // Build matrix
        console.log('\nActivity Count Matrix:');
        console.log('Bunk'.padEnd(15) + allActivities.map(a => a.substring(0, 8).padStart(10)).join(''));
        
        bunks.forEach(bunk => {
            const counts = allActivities.map(act => {
                const count = RotationEngine.getActivityCount(bunk, act);
                return String(count).padStart(10);
            });
            console.log(bunk.padEnd(15) + counts.join(''));
        });
        
        // Show today's activities
        console.log('\nToday\'s Activities:');
        bunks.forEach(bunk => {
            const today = RotationEngine.getActivitiesDoneToday(bunk, 999);
            console.log(`  ${bunk}: ${[...today].join(', ') || 'none yet'}`);
        });
        
        console.log('\n' + '='.repeat(70));
    };

    // =========================================================================
    // EXPORT
    // =========================================================================
    
    window.RotationEngine = RotationEngine;
    
    // Expose debug functions globally
    window.debugBunkRotation = RotationEngine.debugBunkRotation;
    window.debugRotationRecommendations = RotationEngine.debugRecommendations;
    window.debugDivisionRotation = RotationEngine.debugDivisionRotation;

    console.log('[ROTATION] Smart Activity Rotation Engine loaded');

})();
