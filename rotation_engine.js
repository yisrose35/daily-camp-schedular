// ============================================================================
// rotation_engine.js - SUPERCHARGED ACTIVITY ROTATION SYSTEM v2.0
// ============================================================================
// ★★★ SINGLE SOURCE OF TRUTH FOR ALL ROTATION LOGIC ★★★
//
// This module provides human-intelligent activity distribution to ensure:
// 1. No bunk does the same activity twice in one day (HARD RULE)
// 2. Activities are spread out over multiple days (STRONG PREFERENCE)
// 3. All bunks get fair access to all activities over time
// 4. Variety is maximized - bunks try different things
// 5. Streaks are detected and broken
// 6. Activity coverage is tracked - bunks try ALL available activities
//
// KEY IMPROVEMENTS IN v2.0:
// - REAL HISTORY SCANNING from actual saved schedules
// - STREAK DETECTION with escalating penalties
// - MUCH STRONGER penalties and bonuses
// - ACTIVITY COVERAGE tracking
// - TIE-BREAKING with controlled randomness
//
// SCORING PHILOSOPHY:
// - Lower scores = BETTER (we minimize penalty)
// - Same day repeat = IMPOSSIBLE (returns Infinity)
// - Yesterday repeat = EXTREMELY BAD (+12000)
// - Streaks = ESCALATING penalties (2x, 4x, 8x multipliers)
// - Never done before = HUGE BONUS (-5000)
//
// ★★★ ALL OTHER FILES SHOULD DELEGATE TO THIS ENGINE ★★★
// ============================================================================

(function() {
    'use strict';

    const RotationEngine = {};

    // =========================================================================
    // ★★★ SUPERCHARGED CONFIGURATION ★★★
    // =========================================================================

    const CONFIG = {
        // =====================================================================
        // HARD RULES (Absolute - no exceptions)
        // =====================================================================
        SAME_DAY_PENALTY: Infinity,              // NEVER repeat same day

        // =====================================================================
        // RECENCY PENALTIES - MUCH STRONGER
        // =====================================================================
        YESTERDAY_PENALTY: 12000,                // Did it yesterday - EXTREMELY BAD
        TWO_DAYS_AGO_PENALTY: 8000,              // 2 days ago - VERY BAD
        THREE_DAYS_AGO_PENALTY: 5000,            // 3 days ago - BAD
        FOUR_DAYS_AGO_PENALTY: 3000,             // 4 days ago - moderate
        FIVE_DAYS_AGO_PENALTY: 1500,             // 5 days ago - slight concern
        SIX_SEVEN_DAYS_PENALTY: 800,             // 6-7 days ago - mild
        WEEK_PLUS_PENALTY: 200,                  // 8+ days ago - minimal

        // =====================================================================
        // ★★★ STREAK PENALTIES - Escalating for patterns ★★★
        // =====================================================================
        STREAK_TWO_DAYS_MULTIPLIER: 2.0,         // Did it 2 of last 3 days
        STREAK_THREE_DAYS_MULTIPLIER: 4.0,       // Did it 3 of last 5 days
        STREAK_FOUR_PLUS_MULTIPLIER: 8.0,        // Did it 4+ of last 7 days

        // =====================================================================
        // FREQUENCY PENALTIES - Compared to other activities
        // =====================================================================
        HIGH_FREQUENCY_PENALTY: 3000,            // Done MUCH more than average
        ABOVE_AVERAGE_PENALTY: 1200,             // Done more than average
        SLIGHTLY_ABOVE_PENALTY: 500,             // Slightly above average

        // =====================================================================
        // ★★★ ENHANCED VARIETY BONUSES - MUCH STRONGER ★★★
        // =====================================================================
        NEVER_DONE_BONUS: -5000,                 // NEVER done - HUGE bonus!
        DONE_ONCE_BONUS: -3000,                  // Only done once ever
        DONE_TWICE_BONUS: -1500,                 // Only done twice
        UNDER_UTILIZED_BONUS: -2000,             // Significantly under-utilized
        SLIGHTLY_UNDER_BONUS: -800,              // Slightly under average
        GOOD_VARIETY_BONUS: -400,                // General variety bonus
        BALANCE_BONUS: -600,                     // Balancing sports vs specials

        // =====================================================================
        // ★★★ ENHANCED DISTRIBUTION PENALTIES - CROSS-BUNK FAIRNESS ★★★
        // =====================================================================
        MOST_IN_DIVISION_PENALTY: 2500,          // This bunk has done it MOST
        SEVERE_IMBALANCE_PENALTY: 5000,          // 3+ more than others - SEVERE
        ABOVE_DIV_AVG_PENALTY: 1000,             // Above division average
        LEAST_IN_DIVISION_BONUS: -1500,          // This bunk has done it LEAST
        BELOW_DIV_AVG_BONUS: -600,               // Below division average

        // =====================================================================
        // ★★★ ACTIVITY COVERAGE TRACKING ★★★
        // =====================================================================
        MISSING_ACTIVITY_BONUS: -3500,           // Bunk hasn't tried this at all
        LOW_COVERAGE_BONUS: -1500,               // Bunk has tried <50% of activities

        // =====================================================================
        // LIMIT PENALTIES
        // =====================================================================
        LIMITED_ACTIVITY_PENALTY: 800,           // Activity has usage limits
        NEAR_LIMIT_PENALTY: 2000,                // Bunk is close to hitting limit

        // =====================================================================
        // ADJACENT BUNK BONUSES (when sharing fields)
        // =====================================================================
        ADJACENT_BUNK_BONUS: -200,
        SAME_DIVISION_BONUS: -100,

        // =====================================================================
        // DECAY & WEIGHTS
        // =====================================================================
        RECENCY_DECAY_FACTOR: 0.6,               // Faster decay for older activities

        WEIGHTS: {
            recency: 1.0,
            streak: 1.5,                          // Streaks are VERY important
            frequency: 1.0,
            variety: 1.2,
            distribution: 1.0,                    // Strong fairness enforcement
            coverage: 0.8                         // Activity coverage
        },

        // =====================================================================
        // TIE-BREAKER CONFIGURATION
        // =====================================================================
        TIE_BREAKER_RANGE: 500,
        TIE_BREAKER_RANDOMNESS: 300
    };

    // Expose config for external access and tuning
    RotationEngine.CONFIG = CONFIG;

    // =========================================================================
    // ★★★ COMPREHENSIVE HISTORY SCANNER ★★★
    // Scans ACTUAL saved schedules instead of relying on timestamps
    // =========================================================================

    let _historyCache = new Map();
    let _historyCacheDate = null;

    /**
     * Build comprehensive activity history for a bunk by scanning saved schedules
     * This is the KEY improvement - looks at REAL data
     */
    function buildBunkActivityHistory(bunkName) {
        const history = {
            byActivity: {},       // activityName -> { dates: [], count: 0, daysSinceLast: null }
            recentWeek: {},       // activityName -> count in last 7 days
            recentStreak: {},     // activityName -> consecutive days ending at yesterday
            totalActivities: 0,
            uniqueActivities: new Set()
        };

        try {
            const allDaily = window.loadAllDailyData?.() || {};
            const today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            
            // Get sorted dates (most recent first), excluding today
            const sortedDates = Object.keys(allDaily)
                .filter(d => d < today)
                .sort((a, b) => b.localeCompare(a));
            
            // Process last 14 days
            const datesToProcess = sortedDates.slice(0, 14);
            
            datesToProcess.forEach((dateKey, daysAgo) => {
                const actualDaysAgo = daysAgo + 1;  // +1 because we excluded today
                const dayData = allDaily[dateKey];
                const schedule = dayData?.scheduleAssignments?.[bunkName] || [];
                
                schedule.forEach(entry => {
                    if (entry && entry._activity && !entry.continuation && !entry._isTransition) {
                        const actName = entry._activity;
                        const actLower = actName.toLowerCase().trim();
                        
                        if (actLower === 'free' || actLower.includes('transition')) return;
                        
                        // Initialize if needed
                        if (!history.byActivity[actName]) {
                            history.byActivity[actName] = {
                                dates: [],
                                count: 0,
                                daysSinceLast: null
                            };
                        }
                        
                        const actHistory = history.byActivity[actName];
                        actHistory.dates.push({ dateKey, daysAgo: actualDaysAgo });
                        actHistory.count++;
                        
                        // Track first occurrence (most recent)
                        if (actHistory.daysSinceLast === null) {
                            actHistory.daysSinceLast = actualDaysAgo;
                        }
                        
                        // Track last 7 days
                        if (actualDaysAgo <= 7) {
                            history.recentWeek[actName] = (history.recentWeek[actName] || 0) + 1;
                        }
                        
                        history.totalActivities++;
                        history.uniqueActivities.add(actName);
                    }
                });
            });
            
            // Calculate streaks (consecutive days ending at yesterday)
            for (const [actName, actData] of Object.entries(history.byActivity)) {
                const sortedDays = actData.dates
                    .map(d => d.daysAgo)
                    .sort((a, b) => a - b);
                
                let streak = 0;
                let expectedDay = 1;  // Start with yesterday
                
                for (const day of sortedDays) {
                    if (day === expectedDay) {
                        streak++;
                        expectedDay++;
                    } else if (day > expectedDay) {
                        break;
                    }
                }
                
                history.recentStreak[actName] = streak;
            }
            
        } catch (e) {
            console.warn('[RotationEngine] Error building history:', e);
        }
        
        return history;
    }

    /**
     * Get cached bunk history (rebuilds if date changed)
     */
    RotationEngine.getBunkHistory = function(bunkName) {
        const today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        // Invalidate cache if date changed
        if (_historyCacheDate !== today) {
            _historyCache.clear();
            _historyCacheDate = today;
        }
        
        if (!_historyCache.has(bunkName)) {
            _historyCache.set(bunkName, buildBunkActivityHistory(bunkName));
        }
        
        return _historyCache.get(bunkName);
    };

    /**
     * Clear history cache (call after schedule generation or changes)
     */
    RotationEngine.clearHistoryCache = function() {
        _historyCache.clear();
        console.log('🔄 [RotationEngine] History cache cleared');
    };

    // Expose globally
    window.clearRotationCache = RotationEngine.clearHistoryCache;

    // =========================================================================
    // ★★★ DELEGATED STATE MANAGEMENT - Single Source of Truth ★★★
    // =========================================================================

    /**
     * Get all activities done by a bunk TODAY (before a specific slot)
     */
    RotationEngine.getActivitiesDoneToday = function(bunkName, beforeSlotIndex) {
        if (window.SchedulerCoreUtils?.getActivitiesDoneToday) {
            return window.SchedulerCoreUtils.getActivitiesDoneToday(bunkName, beforeSlotIndex);
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
    };

    /**
     * Get activities done by a bunk YESTERDAY
     */
    RotationEngine.getActivitiesDoneYesterday = function(bunkName) {
        if (window.SchedulerCoreUtils?.getActivitiesDoneYesterday) {
            return window.SchedulerCoreUtils.getActivitiesDoneYesterday(bunkName);
        }
        // Fallback
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
            console.warn('[RotationEngine] Error getting yesterday activities:', e);
        }
        return activities;
    };

    /**
     * Get the last time a bunk did a specific activity (days ago)
     * Now uses REAL history scanning as primary source
     */
    RotationEngine.getDaysSinceActivity = function(bunkName, activityName, beforeSlotIndex) {
        const actLower = (activityName || '').toLowerCase().trim();
        
        // First check today
        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0;
        }
        
        // Use history scanner (primary source)
        const history = RotationEngine.getBunkHistory(bunkName);
        const actHistory = history.byActivity[activityName];
        
        if (actHistory && actHistory.daysSinceLast !== null) {
            return actHistory.daysSinceLast;
        }
        
        // Fallback to SchedulerCoreUtils
        if (window.SchedulerCoreUtils?.getDaysSinceActivity) {
            return window.SchedulerCoreUtils.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        }
        
        // Final fallback - check rotation history timestamps
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName] || bunkHistory[actLower];
        if (lastTimestamp) {
            const now = Date.now();
            const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
            return Math.max(1, daysSince);
        }
        
        // Check historical counts
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        if (historicalCounts[bunkName]?.[activityName] > 0) {
            return 14; // Assume 2 weeks if count exists but no timestamp
        }
        
        return null; // Never done
    };

    /**
     * Get total count of how many times a bunk has done an activity
     */
    RotationEngine.getActivityCount = function(bunkName, activityName) {
        if (window.SchedulerCoreUtils?.getActivityCount) {
            return window.SchedulerCoreUtils.getActivityCount(bunkName, activityName);
        }
        // Fallback
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
        if (window.SchedulerCoreUtils?.getBunkAverageActivityCount) {
            return window.SchedulerCoreUtils.getBunkAverageActivityCount(bunkName, allActivities);
        }
        if (!allActivities || allActivities.length === 0) return 0;
        let total = 0;
        for (const act of allActivities) {
            total += RotationEngine.getActivityCount(bunkName, act);
        }
        return total / allActivities.length;
    };

    /**
     * Get how "overused" an activity is for a specific bunk
     */
    RotationEngine.getActivityUsageDeviation = function(bunkName, activityName, allActivities) {
        const count = RotationEngine.getActivityCount(bunkName, activityName);
        const average = RotationEngine.getBunkAverageActivityCount(bunkName, allActivities);
        return count - average;
    };

    /**
     * Get all unique activity names from config
     */
    RotationEngine.getAllActivityNames = function() {
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
    };

    /**
     * Check if activity is a "special" type
     */
    RotationEngine.isSpecialActivity = function(activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specials = globalSettings.app1?.specialActivities || [];
        const specialNames = new Set(specials.map(s => (s.name || '').toLowerCase().trim()));
        return specialNames.has((activityName || '').toLowerCase().trim());
    };

    // =========================================================================
    // ★★★ SUPERCHARGED SCORING FUNCTIONS ★★★
    // =========================================================================

    /**
     * Calculate RECENCY score with real history scanning
     * LOWER IS BETTER
     */
    RotationEngine.calculateRecencyScore = function(bunkName, activityName, beforeSlotIndex) {
        const actLower = (activityName || '').toLowerCase().trim();
        
        // First check today
        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return CONFIG.SAME_DAY_PENALTY;
        }
        
        // Get comprehensive history
        const history = RotationEngine.getBunkHistory(bunkName);
        const actHistory = history.byActivity[activityName];
        
        // Never done at all - HUGE bonus!
        if (!actHistory || actHistory.count === 0) {
            return CONFIG.NEVER_DONE_BONUS;
        }
        
        // Check total count for novelty bonuses
        if (actHistory.count === 1) {
            return CONFIG.DONE_ONCE_BONUS;
        }
        if (actHistory.count === 2) {
            return CONFIG.DONE_TWICE_BONUS;
        }
        
        const daysSince = actHistory.daysSinceLast;
        
        if (daysSince === null) {
            // Fallback
            return RotationEngine.calculateRecencyScoreFallback(bunkName, activityName, beforeSlotIndex);
        }
        
        // Apply recency penalties based on actual days
        if (daysSince === 1) {
            return CONFIG.YESTERDAY_PENALTY;
        }
        if (daysSince === 2) {
            return CONFIG.TWO_DAYS_AGO_PENALTY;
        }
        if (daysSince === 3) {
            return CONFIG.THREE_DAYS_AGO_PENALTY;
        }
        if (daysSince === 4) {
            return CONFIG.FOUR_DAYS_AGO_PENALTY;
        }
        if (daysSince === 5) {
            return CONFIG.FIVE_DAYS_AGO_PENALTY;
        }
        if (daysSince <= 7) {
            return CONFIG.SIX_SEVEN_DAYS_PENALTY;
        }
        
        // More than a week ago - apply decay
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, CONFIG.WEEK_PLUS_PENALTY * Math.pow(CONFIG.RECENCY_DECAY_FACTOR, weeksAgo));
    };

    /**
     * Fallback recency calculation if history scanning fails
     */
    RotationEngine.calculateRecencyScoreFallback = function(bunkName, activityName, beforeSlotIndex) {
        const daysSince = RotationEngine.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        
        if (daysSince === null) {
            return CONFIG.NEVER_DONE_BONUS;
        }
        if (daysSince === 0) {
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
            return CONFIG.SIX_SEVEN_DAYS_PENALTY;
        }
        
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, CONFIG.WEEK_PLUS_PENALTY * Math.pow(CONFIG.RECENCY_DECAY_FACTOR, weeksAgo));
    };

    /**
     * ★★★ NEW: STREAK DETECTION SCORE ★★★
     * Escalating penalties for doing same activity multiple recent days
     */
    RotationEngine.calculateStreakScore = function(bunkName, activityName) {
        const history = RotationEngine.getBunkHistory(bunkName);
        
        // Check consecutive day streak
        const streak = history.recentStreak[activityName] || 0;
        
        if (streak >= 4) {
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_FOUR_PLUS_MULTIPLIER;
        }
        if (streak >= 3) {
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_THREE_DAYS_MULTIPLIER;
        }
        if (streak >= 2) {
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_TWO_DAYS_MULTIPLIER;
        }
        
        // Also check frequency in last week (even if not consecutive)
        const weekCount = history.recentWeek[activityName] || 0;
        
        if (weekCount >= 4) {
            return CONFIG.HIGH_FREQUENCY_PENALTY * 2;
        }
        if (weekCount >= 3) {
            return CONFIG.HIGH_FREQUENCY_PENALTY;
        }
        if (weekCount >= 2) {
            return CONFIG.ABOVE_AVERAGE_PENALTY;
        }
        
        return 0;
    };

    /**
     * Calculate FREQUENCY score - enhanced version
     */
    RotationEngine.calculateFrequencyScore = function(bunkName, activityName, allActivities) {
        const deviation = RotationEngine.getActivityUsageDeviation(bunkName, activityName, allActivities);

        if (deviation <= -3) {
            return CONFIG.UNDER_UTILIZED_BONUS;
        }

        if (deviation <= -1) {
            return CONFIG.SLIGHTLY_UNDER_BONUS;
        }

        if (deviation === 0) {
            return 0;
        }

        if (deviation <= 1) {
            return CONFIG.SLIGHTLY_ABOVE_PENALTY;
        }

        if (deviation <= 2) {
            return CONFIG.ABOVE_AVERAGE_PENALTY;
        }

        // Significantly over-used - escalating penalty
        return CONFIG.HIGH_FREQUENCY_PENALTY + (deviation - 2) * 500;
    };

    /**
     * Calculate VARIETY score - enhanced version
     */
    RotationEngine.calculateVarietyScore = function(bunkName, activityName, beforeSlotIndex) {
        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = (activityName || '').toLowerCase().trim();

        // Already done today - FORBIDDEN
        if (todayActivities.has(actLower)) {
            return CONFIG.SAME_DAY_PENALTY;
        }

        // Check activity type balance (sports vs specials)
        let todaySports = 0;
        let todaySpecials = 0;

        for (const act of todayActivities) {
            if (RotationEngine.isSpecialActivity(act)) {
                todaySpecials++;
            } else {
                todaySports++;
            }
        }

        const thisIsSpecial = RotationEngine.isSpecialActivity(activityName);

        // Strong bonus for balancing the day
        if (thisIsSpecial && todaySports > todaySpecials + 1) {
            return CONFIG.BALANCE_BONUS * 2;
        }
        if (thisIsSpecial && todaySports > todaySpecials) {
            return CONFIG.BALANCE_BONUS;
        }

        if (!thisIsSpecial && todaySpecials > todaySports + 1) {
            return CONFIG.BALANCE_BONUS * 2;
        }
        if (!thisIsSpecial && todaySpecials > todaySports) {
            return CONFIG.BALANCE_BONUS;
        }

        // General variety bonus
        const uniqueToday = todayActivities.size;
        return CONFIG.GOOD_VARIETY_BONUS - (50 * Math.min(uniqueToday, 4));
    };

    /**
     * Calculate DISTRIBUTION score - enhanced cross-bunk fairness
     */
    RotationEngine.calculateDistributionScore = function(bunkName, activityName, divisionName) {
        const divisions = window.divisions || {};
        const bunksInDiv = divisions[divisionName]?.bunks || [];

        if (bunksInDiv.length <= 1) return 0;

        const counts = bunksInDiv.map(b => RotationEngine.getActivityCount(b, activityName));
        const myCount = RotationEngine.getActivityCount(bunkName, activityName);

        const minCount = Math.min(...counts);
        const maxCount = Math.max(...counts);
        const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;

        // SEVERE imbalance - 3+ more than min
        if (myCount >= minCount + 3) {
            return CONFIG.SEVERE_IMBALANCE_PENALTY;
        }

        // This bunk has done it most
        if (myCount === maxCount && maxCount > minCount) {
            return CONFIG.MOST_IN_DIVISION_PENALTY + (maxCount - minCount) * 300;
        }

        // Above division average
        if (myCount > avgCount + 0.5) {
            return CONFIG.ABOVE_DIV_AVG_PENALTY;
        }

        // This bunk has done it LEAST - strong bonus
        if (myCount === minCount && maxCount > minCount) {
            return CONFIG.LEAST_IN_DIVISION_BONUS - (maxCount - minCount) * 200;
        }

        // Below division average - bonus
        if (myCount < avgCount - 0.5) {
            return CONFIG.BELOW_DIV_AVG_BONUS;
        }

        return 0;
    };

    /**
     * ★★★ NEW: ACTIVITY COVERAGE SCORE ★★★
     * Encourage bunks to try ALL available activities
     */
    RotationEngine.calculateCoverageScore = function(bunkName, activityName) {
        const allActivities = RotationEngine.getAllActivityNames();
        if (allActivities.length === 0) return 0;
        
        const history = RotationEngine.getBunkHistory(bunkName);
        const triedActivities = history.uniqueActivities.size;
        const coverageRatio = triedActivities / allActivities.length;
        
        // Has this bunk ever tried this activity?
        const hasTriedThis = history.byActivity[activityName]?.count > 0;
        
        if (!hasTriedThis) {
            return CONFIG.MISSING_ACTIVITY_BONUS;
        }
        
        // Low overall coverage - bonus for trying less-used activities
        if (coverageRatio < 0.5) {
            const actCount = history.byActivity[activityName]?.count || 0;
            if (actCount <= 1) {
                return CONFIG.LOW_COVERAGE_BONUS;
            }
        }
        
        return 0;
    };

    /**
     * Calculate LIMIT score - for activities with usage limits
     */
    RotationEngine.calculateLimitScore = function(bunkName, activityName, activityProperties) {
        const props = activityProperties?.[activityName] || {};
        const maxUsage = props.maxUsage || 0;

        if (maxUsage <= 0) return 0;

        const currentCount = RotationEngine.getActivityCount(bunkName, activityName);

        if (currentCount >= maxUsage) {
            return Infinity;
        }

        if (currentCount >= maxUsage - 1) {
            return CONFIG.NEAR_LIMIT_PENALTY;
        }

        if (currentCount >= maxUsage - 2) {
            return CONFIG.LIMITED_ACTIVITY_PENALTY;
        }

        return 0;
    };

    // =========================================================================
    // ★★★ MAIN SCORING FUNCTION ★★★
    // =========================================================================

    /**
     * Calculate the complete rotation score for an activity
     * LOWER IS BETTER
     * Returns Infinity if the activity is not allowed
     * 
     * This is the MAIN FUNCTION all other files should call!
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

        if (!bunkName || !activityName || activityName === 'Free') return 0;

        // RECENCY - primary factor
        const recencyScore = RotationEngine.calculateRecencyScore(bunkName, activityName, beforeSlotIndex);

        if (recencyScore === Infinity) {
            return Infinity;
        }

        // VARIETY - also checks same day
        const varietyScore = RotationEngine.calculateVarietyScore(bunkName, activityName, beforeSlotIndex);

        if (varietyScore === Infinity) {
            return Infinity;
        }

        // ★★★ STREAK DETECTION ★★★
        const streakScore = RotationEngine.calculateStreakScore(bunkName, activityName);

        // FREQUENCY
        const frequencyScore = RotationEngine.calculateFrequencyScore(bunkName, activityName, allActivities || RotationEngine.getAllActivityNames());

        // DISTRIBUTION
        const distributionScore = RotationEngine.calculateDistributionScore(bunkName, activityName, divisionName);

        // ★★★ COVERAGE ★★★
        const coverageScore = RotationEngine.calculateCoverageScore(bunkName, activityName);

        // LIMIT
        const limitScore = RotationEngine.calculateLimitScore(bunkName, activityName, activityProperties);

        if (limitScore === Infinity) {
            return Infinity;
        }

        // Combine with weights
        const totalScore = (
            recencyScore * CONFIG.WEIGHTS.recency +
            streakScore * CONFIG.WEIGHTS.streak +
            frequencyScore * CONFIG.WEIGHTS.frequency +
            varietyScore * CONFIG.WEIGHTS.variety +
            distributionScore * CONFIG.WEIGHTS.distribution +
            coverageScore * CONFIG.WEIGHTS.coverage +
            limitScore
        );

        return totalScore;
    };

    /**
     * Simplified score calculation for quick checks (backward compatibility)
     */
    RotationEngine.quickScore = function(bunkName, activityName, slotIndex, divisionName) {
        return RotationEngine.calculateRotationScore({
            bunkName,
            activityName,
            divisionName,
            beforeSlotIndex: slotIndex,
            allActivities: null,
            activityProperties: window.activityProperties || {}
        });
    };

    /**
     * Get a ranked list of activities for a bunk, sorted by rotation score
     * Returns array sorted by score (lowest first = best)
     * Includes TIE-BREAKING for variety
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

        // ★★★ TIE-BREAKING: Add controlled randomness when scores are close ★★★
        if (scored.length >= 2) {
            const bestScore = scored[0].score;
            const tieGroup = scored.filter(p => 
                p.score <= bestScore + CONFIG.TIE_BREAKER_RANGE && p.allowed
            );
            
            if (tieGroup.length > 1) {
                tieGroup.forEach(p => {
                    p._tieBreaker = Math.random() * CONFIG.TIE_BREAKER_RANDOMNESS;
                    p._finalScore = p.score + p._tieBreaker;
                });
                
                tieGroup.sort((a, b) => a._finalScore - b._finalScore);
                
                scored.splice(0, tieGroup.length, ...tieGroup);
            }
        }

        return scored;
    };

    // =========================================================================
    // ★★★ ENHANCED DEBUG UTILITIES ★★★
    // =========================================================================

    RotationEngine.debugBunkRotation = function(bunkName, slotIndex = 0) {
        console.log('\n' + '='.repeat(70));
        console.log(`★★★ SUPERCHARGED ROTATION DEBUG: ${bunkName} @ slot ${slotIndex} ★★★`);
        console.log('='.repeat(70));

        const history = RotationEngine.getBunkHistory(bunkName);
        
        console.log('\n📊 BUNK HISTORY (from actual schedules):');
        console.log(`  Total activities tracked: ${history.totalActivities}`);
        console.log(`  Unique activities tried: ${history.uniqueActivities.size}`);
        
        console.log('\n📅 RECENT WEEK FREQUENCY:');
        const weekEntries = Object.entries(history.recentWeek).sort((a, b) => b[1] - a[1]);
        if (weekEntries.length === 0) {
            console.log('  No activities in last 7 days');
        } else {
            weekEntries.forEach(([act, count]) => {
                console.log(`  ${act}: ${count}x in last 7 days`);
            });
        }
        
        console.log('\n🔥 CURRENT STREAKS (consecutive days):');
        const streakEntries = Object.entries(history.recentStreak).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
        if (streakEntries.length === 0) {
            console.log('  No active streaks');
        } else {
            streakEntries.forEach(([act, streak]) => {
                console.log(`  ⚠️ ${act}: ${streak} consecutive days`);
            });
        }

        const todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, slotIndex);
        console.log(`\n📍 DONE TODAY: ${[...todayActivities].join(', ') || 'none yet'}`);

        const yesterdayActivities = RotationEngine.getActivitiesDoneYesterday(bunkName);
        console.log(`📍 DONE YESTERDAY: ${[...yesterdayActivities].join(', ') || 'none'}`);

        const allActivities = RotationEngine.getAllActivityNames();
        const activityProperties = window.activityProperties || {};

        console.log('\n🏆 ACTIVITY RANKINGS (best first):');
        const scored = allActivities.map(act => {
            const score = RotationEngine.calculateRotationScore({
                bunkName,
                activityName: act,
                divisionName: 'Unknown',
                beforeSlotIndex: slotIndex,
                allActivities,
                activityProperties
            });
            const streak = RotationEngine.calculateStreakScore(bunkName, act);
            const weekCount = history.recentWeek[act] || 0;
            return { activity: act, score, streak, weekCount };
        }).sort((a, b) => a.score - b.score);

        scored.slice(0, 15).forEach((item, i) => {
            const status = item.score === Infinity ? '❌ BLOCKED' : item.score.toFixed(0);
            const streakInfo = item.streak > 0 ? ` [streak: +${item.streak.toFixed(0)}]` : '';
            const weekInfo = item.weekCount > 0 ? ` (${item.weekCount}x/week)` : '';
            console.log(`  ${i + 1}. ${item.activity}: ${status}${streakInfo}${weekInfo}`);
        });

        const blocked = scored.filter(s => s.score === Infinity);
        console.log(`\n🚫 Blocked: ${blocked.map(b => b.activity).join(', ') || 'none'}`);

        console.log('\n' + '='.repeat(70));
    };

    RotationEngine.debugConfig = function() {
        console.log('\n=== SUPERCHARGED ROTATION CONFIG v2.0 ===');
        console.log('Same Day:', CONFIG.SAME_DAY_PENALTY);
        console.log('Yesterday:', CONFIG.YESTERDAY_PENALTY);
        console.log('2 Days Ago:', CONFIG.TWO_DAYS_AGO_PENALTY);
        console.log('3 Days Ago:', CONFIG.THREE_DAYS_AGO_PENALTY);
        console.log('\nStreak Multipliers:', {
            '2-day': CONFIG.STREAK_TWO_DAYS_MULTIPLIER,
            '3-day': CONFIG.STREAK_THREE_DAYS_MULTIPLIER,
            '4+': CONFIG.STREAK_FOUR_PLUS_MULTIPLIER
        });
        console.log('\nBonuses:');
        console.log('  Never Done:', CONFIG.NEVER_DONE_BONUS);
        console.log('  Done Once:', CONFIG.DONE_ONCE_BONUS);
        console.log('  Done Twice:', CONFIG.DONE_TWICE_BONUS);
        console.log('  Missing Activity:', CONFIG.MISSING_ACTIVITY_BONUS);
        console.log('\nDistribution Penalties:');
        console.log('  Most in Division:', CONFIG.MOST_IN_DIVISION_PENALTY);
        console.log('  Severe Imbalance:', CONFIG.SEVERE_IMBALANCE_PENALTY);
        console.log('  Least in Division Bonus:', CONFIG.LEAST_IN_DIVISION_BONUS);
        console.log('\nWeights:', CONFIG.WEIGHTS);
        console.log('Tie-Breaker Range:', CONFIG.TIE_BREAKER_RANGE);
    };

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

        const allActivities = RotationEngine.getAllActivityNames().sort();

        console.log('\nActivity Count Matrix:');
        console.log('Bunk'.padEnd(15) + allActivities.map(a => a.substring(0, 8).padStart(10)).join(''));

        bunks.forEach(bunk => {
            const counts = allActivities.map(act => {
                const count = RotationEngine.getActivityCount(bunk, act);
                return String(count).padStart(10);
            });
            console.log(bunk.padEnd(15) + counts.join(''));
        });

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
    window.debugRotationRecommendations = RotationEngine.debugBunkRotation;
    window.debugDivisionRotation = RotationEngine.debugDivisionRotation;
    window.debugRotationConfig = RotationEngine.debugConfig;

    console.log('★★★ [RotationEngine] SUPERCHARGED v2.0 loaded - Single Source of Truth ★★★');
})();
