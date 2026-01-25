// ============================================================================
// scheduler_logic_fillers.js (SUPERCHARGED ROTATION v6.0)
// ============================================================================
// ★★★ MAJOR UPGRADE: Human-Intelligent Activity Rotation System ★★★
//
// KEY IMPROVEMENTS:
// 1. REAL HISTORY SCANNING - looks at actual saved schedules, not just timestamps
// 2. STREAK DETECTION - escalating penalties for consecutive day patterns
// 3. MUCH STRONGER DISTRIBUTION - ensures all bunks get fair access
// 4. NOVELTY PRIORITIZATION - activities never done get HUGE bonus
// 5. SMARTER TIE-BREAKING - controlled randomness when scores are similar
// 6. CROSS-ACTIVITY COVERAGE - ensures bunks try ALL available activities
//
// RULES:
// 1. HARD BLOCK: No bunk does same activity twice in one day (Infinity penalty)
// 2. VERY STRONG: Yesterday's activities get HUGE penalty (+12000)
// 3. STREAK DETECTION: Multiple recent days = escalating multipliers
// 4. STRONG BONUS: Never-done activities get massive bonus (-5000)
// 5. FAIRNESS: Cross-bunk distribution enforced with strong penalties
//
// SCORING PHILOSOPHY:
// - Lower scores = BETTER (we minimize penalty)
// - Activities are sorted by rotation score before selection
// - Tie-breaking adds controlled randomness for variety
//
// ★★★ DELEGATES to SchedulerCoreUtils for core tracking functions ★★★
// ============================================================================

(function () {
    'use strict';

    // =========================================================================
    // ★★★ SUPERCHARGED ROTATION CONFIGURATION ★★★
    // =========================================================================
    const ROTATION_CONFIG = {
        // =====================================================================
        // HARD RULES (Absolute - no exceptions)
        // =====================================================================
        SAME_DAY_PENALTY: Infinity,              // NEVER repeat same day

        // =====================================================================
        // RECENCY PENALTIES - MUCH STRONGER than before
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
        DONE_ONCE_BONUS: -3000,                  // Only done once ever - big bonus
        DONE_TWICE_BONUS: -1500,                 // Only done twice - good bonus
        UNDER_UTILIZED_BONUS: -2000,             // Significantly under-utilized
        SLIGHTLY_UNDER_BONUS: -800,              // Slightly under average
        VARIETY_BONUS: -400,                     // General variety bonus
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
        // DECAY & WEIGHTS
        // =====================================================================
        RECENCY_DECAY: 0.6,                      // Faster decay for older activities

        WEIGHTS: {
            recency: 1.0,
            streak: 1.5,                          // Streaks are VERY important
            frequency: 1.0,
            variety: 1.2,
            distribution: 1.0,                    // Increased from 0.6
            coverage: 0.8                         // Activity coverage
        },

        // =====================================================================
        // TIE-BREAKER CONFIGURATION
        // =====================================================================
        TIE_BREAKER_RANGE: 500,
        TIE_BREAKER_RANDOMNESS: 300
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
    // ★★★ COMPREHENSIVE HISTORY SCANNER ★★★
    // Scans ACTUAL saved schedules instead of relying on timestamps
    // =========================================================================

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
            console.warn('[ROTATION] Error building history:', e);
        }
        
        return history;
    }

    // Cache for history to avoid rebuilding on every call
    let _historyCache = new Map();
    let _historyCacheDate = null;

    function getBunkHistory(bunkName) {
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
    }

    // Clear cache when schedules change
    window.clearRotationCache = function() {
        _historyCache.clear();
        console.log('🔄 Rotation history cache cleared');
    };

    // =========================================================================
    // ★★★ DELEGATED ROTATION TRACKING - Single Source of Truth ★★★
    // =========================================================================

    function getActivitiesDoneToday(bunkName, beforeSlotIndex) {
        if (window.SchedulerCoreUtils?.getActivitiesDoneToday) {
            return window.SchedulerCoreUtils.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        }
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

    function getActivitiesFromYesterday(bunkName) {
        if (window.SchedulerCoreUtils?.getActivitiesDoneYesterday) {
            return window.SchedulerCoreUtils.getActivitiesDoneYesterday(bunkName);
        }
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
            // Silent fail
        }
        return activities;
    }

    function getDaysSinceActivity(bunkName, activityName, beforeSlotIndex) {
        if (window.SchedulerCoreUtils?.getDaysSinceActivity) {
            return window.SchedulerCoreUtils.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        }
        const actLower = (activityName || '').toLowerCase().trim();
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0;
        }
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName] || bunkHistory[actLower];
        if (lastTimestamp) {
            const now = Date.now();
            const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
            return Math.max(1, daysSince);
        }
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        if (historicalCounts[bunkName]?.[activityName] > 0) {
            return 14;
        }
        return null;
    }

    function getActivityCount(bunkName, activityName) {
        if (window.SchedulerCoreUtils?.getActivityCount) {
            return window.SchedulerCoreUtils.getActivityCount(bunkName, activityName);
        }
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};
        const baseCount = historicalCounts[bunkName]?.[activityName] || 0;
        const offset = manualOffsets[bunkName]?.[activityName] || 0;
        return Math.max(0, baseCount + offset);
    }

    function getBunkAverageCount(bunkName, allActivityNames) {
        if (window.SchedulerCoreUtils?.getBunkAverageActivityCount) {
            return window.SchedulerCoreUtils.getBunkAverageActivityCount(bunkName, allActivityNames);
        }
        if (!allActivityNames || allActivityNames.length === 0) return 0;
        let total = 0;
        for (const act of allActivityNames) {
            total += getActivityCount(bunkName, act);
        }
        return total / allActivityNames.length;
    }

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

    function isSpecialActivity(activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specials = globalSettings.app1?.specialActivities || [];
        const specialNames = new Set(specials.map(s => (s.name || '').toLowerCase().trim()));
        return specialNames.has((activityName || '').toLowerCase().trim());
    }

    // =========================================================================
    // ★★★ SUPERCHARGED ROTATION SCORING FUNCTIONS ★★★
    // =========================================================================

    /**
     * Calculate RECENCY score with real history scanning
     * LOWER IS BETTER
     */
    function calculateRecencyScore(bunkName, activityName, beforeSlotIndex) {
        // First check today
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = (activityName || '').toLowerCase().trim();
        
        if (todayActivities.has(actLower)) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        }
        
        // Get comprehensive history from actual schedules
        const history = getBunkHistory(bunkName);
        const actHistory = history.byActivity[activityName];
        
        // Never done at all - HUGE bonus!
        if (!actHistory || actHistory.count === 0) {
            return ROTATION_CONFIG.NEVER_DONE_BONUS;
        }
        
        // Check total count for novelty bonuses
        if (actHistory.count === 1) {
            return ROTATION_CONFIG.DONE_ONCE_BONUS;
        }
        if (actHistory.count === 2) {
            return ROTATION_CONFIG.DONE_TWICE_BONUS;
        }
        
        const daysSince = actHistory.daysSinceLast;
        
        if (daysSince === null) {
            // Fallback to old method
            return calculateRecencyScoreFallback(bunkName, activityName, beforeSlotIndex);
        }
        
        // Apply recency penalties based on actual days
        if (daysSince === 1) {
            return ROTATION_CONFIG.YESTERDAY_PENALTY;
        }
        if (daysSince === 2) {
            return ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY;
        }
        if (daysSince === 3) {
            return ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY;
        }
        if (daysSince === 4) {
            return ROTATION_CONFIG.FOUR_DAYS_AGO_PENALTY;
        }
        if (daysSince === 5) {
            return ROTATION_CONFIG.FIVE_DAYS_AGO_PENALTY;
        }
        if (daysSince <= 7) {
            return ROTATION_CONFIG.SIX_SEVEN_DAYS_PENALTY;
        }
        
        // More than a week ago - apply decay
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, ROTATION_CONFIG.WEEK_PLUS_PENALTY * Math.pow(ROTATION_CONFIG.RECENCY_DECAY, weeksAgo));
    }

    // Fallback if history scanning fails
    function calculateRecencyScoreFallback(bunkName, activityName, beforeSlotIndex) {
        const daysSince = getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        
        if (daysSince === null) {
            return ROTATION_CONFIG.NEVER_DONE_BONUS;
        }
        if (daysSince === 0) {
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
            return ROTATION_CONFIG.SIX_SEVEN_DAYS_PENALTY;
        }
        
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, ROTATION_CONFIG.WEEK_PLUS_PENALTY * Math.pow(ROTATION_CONFIG.RECENCY_DECAY, weeksAgo));
    }

    /**
     * ★★★ NEW: STREAK DETECTION SCORE ★★★
     * Escalating penalties for doing same activity multiple recent days
     */
    function calculateStreakScore(bunkName, activityName) {
        const history = getBunkHistory(bunkName);
        
        // Check consecutive day streak
        const streak = history.recentStreak[activityName] || 0;
        
        if (streak >= 4) {
            return ROTATION_CONFIG.YESTERDAY_PENALTY * ROTATION_CONFIG.STREAK_FOUR_PLUS_MULTIPLIER;
        }
        if (streak >= 3) {
            return ROTATION_CONFIG.YESTERDAY_PENALTY * ROTATION_CONFIG.STREAK_THREE_DAYS_MULTIPLIER;
        }
        if (streak >= 2) {
            return ROTATION_CONFIG.YESTERDAY_PENALTY * ROTATION_CONFIG.STREAK_TWO_DAYS_MULTIPLIER;
        }
        
        // Also check frequency in last week (even if not consecutive)
        const weekCount = history.recentWeek[activityName] || 0;
        
        if (weekCount >= 4) {
            return ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY * 2;
        }
        if (weekCount >= 3) {
            return ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY;
        }
        if (weekCount >= 2) {
            return ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        }
        
        return 0;
    }

    /**
     * Calculate FREQUENCY score - enhanced version
     * LOWER IS BETTER
     */
    function calculateFrequencyScore(bunkName, activityName) {
        const allActivities = getAllActivityNames();
        if (allActivities.length === 0) return 0;

        const count = getActivityCount(bunkName, activityName);
        const average = getBunkAverageCount(bunkName, allActivities);
        const deviation = count - average;

        if (deviation <= -3) {
            return ROTATION_CONFIG.UNDER_UTILIZED_BONUS;
        }

        if (deviation <= -1) {
            return ROTATION_CONFIG.SLIGHTLY_UNDER_BONUS;
        }

        if (deviation === 0) {
            return 0;
        }

        if (deviation <= 1) {
            return ROTATION_CONFIG.SLIGHTLY_ABOVE_PENALTY;
        }

        if (deviation <= 2) {
            return ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        }

        // Significantly over-used - escalating penalty
        return ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY + (deviation - 2) * 500;
    }

    /**
     * Calculate VARIETY score - enhanced version
     * LOWER IS BETTER
     */
    function calculateVarietyScore(bunkName, activityName, beforeSlotIndex) {
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = (activityName || '').toLowerCase().trim();

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

        // Strong bonus for balancing the day
        if (thisIsSpecial && todaySports > todaySpecials + 1) {
            return ROTATION_CONFIG.BALANCE_BONUS * 2;
        }
        if (thisIsSpecial && todaySports > todaySpecials) {
            return ROTATION_CONFIG.BALANCE_BONUS;
        }

        if (!thisIsSpecial && todaySpecials > todaySports + 1) {
            return ROTATION_CONFIG.BALANCE_BONUS * 2;
        }
        if (!thisIsSpecial && todaySpecials > todaySports) {
            return ROTATION_CONFIG.BALANCE_BONUS;
        }

        // General variety bonus
        const uniqueToday = todayActivities.size;
        return ROTATION_CONFIG.VARIETY_BONUS - (50 * Math.min(uniqueToday, 4));
    }

    /**
     * Calculate DISTRIBUTION score - enhanced cross-bunk fairness
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
        const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;

        // SEVERE imbalance - 3+ more than min
        if (myCount >= minCount + 3) {
            return ROTATION_CONFIG.SEVERE_IMBALANCE_PENALTY;
        }

        // This bunk has done it most
        if (myCount === maxCount && maxCount > minCount) {
            return ROTATION_CONFIG.MOST_IN_DIVISION_PENALTY + (maxCount - minCount) * 300;
        }

        // Above division average
        if (myCount > avgCount + 0.5) {
            return ROTATION_CONFIG.ABOVE_DIV_AVG_PENALTY;
        }

        // This bunk has done it LEAST - strong bonus
        if (myCount === minCount && maxCount > minCount) {
            return ROTATION_CONFIG.LEAST_IN_DIVISION_BONUS - (maxCount - minCount) * 200;
        }

        // Below division average - bonus
        if (myCount < avgCount - 0.5) {
            return ROTATION_CONFIG.BELOW_DIV_AVG_BONUS;
        }

        return 0;
    }

    /**
     * ★★★ NEW: ACTIVITY COVERAGE SCORE ★★★
     * Encourage bunks to try ALL available activities
     */
    function calculateCoverageScore(bunkName, activityName) {
        const allActivities = getAllActivityNames();
        if (allActivities.length === 0) return 0;
        
        const history = getBunkHistory(bunkName);
        const triedActivities = history.uniqueActivities.size;
        const coverageRatio = triedActivities / allActivities.length;
        
        // Has this bunk ever tried this activity?
        const hasTriedThis = history.byActivity[activityName]?.count > 0;
        
        if (!hasTriedThis) {
            return ROTATION_CONFIG.MISSING_ACTIVITY_BONUS;
        }
        
        // Low overall coverage - bonus for trying less-used activities
        if (coverageRatio < 0.5) {
            const actCount = history.byActivity[activityName]?.count || 0;
            if (actCount <= 1) {
                return ROTATION_CONFIG.LOW_COVERAGE_BONUS;
            }
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

        const hist = getActivityCount(bunkName, activityName);
        const todayCount = todaySet.has((activityName || '').toLowerCase().trim()) ? 1 : 0;

        if (hist + todayCount >= maxUsage) {
            return Infinity;
        }

        if (hist + todayCount >= maxUsage - 1) {
            return 2000;
        }

        if (hist + todayCount >= maxUsage - 2) {
            return 800;
        }

        return 0;
    }

    /**
     * ★★★ MASTER ROTATION SCORE CALCULATOR ★★★
     * Combines all factors with weights
     * LOWER IS BETTER, Infinity means BLOCKED
     */
    function calculateRotationScore(bunkName, activityName, block, activityProperties) {
        if (!activityName || activityName === 'Free') return 0;

        const beforeSlotIndex = block.slots?.[0] || 0;
        const divisionName = block.divName || block.division;
        const todaySet = getActivitiesDoneToday(bunkName, beforeSlotIndex);

        // RECENCY - primary factor
        const recencyScore = calculateRecencyScore(bunkName, activityName, beforeSlotIndex);

        if (recencyScore === Infinity) {
            return Infinity;
        }

        // VARIETY - also checks same day
        const varietyScore = calculateVarietyScore(bunkName, activityName, beforeSlotIndex);

        if (varietyScore === Infinity) {
            return Infinity;
        }

        // ★★★ STREAK DETECTION ★★★
        const streakScore = calculateStreakScore(bunkName, activityName);

        // FREQUENCY
        const frequencyScore = calculateFrequencyScore(bunkName, activityName);

        // DISTRIBUTION
        const distributionScore = calculateDistributionScore(bunkName, activityName, divisionName);

        // ★★★ COVERAGE ★★★
        const coverageScore = calculateCoverageScore(bunkName, activityName);

        // LIMIT
        const limitScore = calculateLimitScore(bunkName, activityName, activityProperties, todaySet);

        if (limitScore === Infinity) {
            return Infinity;
        }

        // Combine with weights
        const totalScore = (
            recencyScore * ROTATION_CONFIG.WEIGHTS.recency +
            streakScore * ROTATION_CONFIG.WEIGHTS.streak +
            frequencyScore * ROTATION_CONFIG.WEIGHTS.frequency +
            varietyScore * ROTATION_CONFIG.WEIGHTS.variety +
            distributionScore * ROTATION_CONFIG.WEIGHTS.distribution +
            coverageScore * ROTATION_CONFIG.WEIGHTS.coverage +
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
    // ★★★ SMART PICK SORTING WITH TIE-BREAKING ★★★
    // =========================================================================

    function sortPicksByRotationScore(picks, block, activityProperties) {
        const bunkName = block.bunk;
        const divName = block.divName;

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

        // Sort by total score
        scored.sort((a, b) => a._totalScore - b._totalScore);

        // ★★★ TIE-BREAKING: Add controlled randomness when scores are close ★★★
        if (scored.length >= 2) {
            const bestScore = scored[0]._totalScore;
            const tieGroup = scored.filter(p => 
                p._totalScore <= bestScore + ROTATION_CONFIG.TIE_BREAKER_RANGE
            );
            
            if (tieGroup.length > 1) {
                tieGroup.forEach(p => {
                    p._tieBreaker = Math.random() * ROTATION_CONFIG.TIE_BREAKER_RANDOMNESS;
                    p._finalScore = p._totalScore + p._tieBreaker;
                });
                
                tieGroup.sort((a, b) => a._finalScore - b._finalScore);
                
                scored.splice(0, tieGroup.length, ...tieGroup);
            }
        }

        return scored;
    }

    // =========================================================================
    // SPECIAL ACTIVITY SELECTOR (WITH SUPERCHARGED ROTATION)
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

        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    };

    // =========================================================================
    // SPORTS ACTIVITY SELECTOR (WITH SUPERCHARGED ROTATION)
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

        const sorted = sortPicksByRotationScore(available, block, activityProperties);

        return sorted[0] || null;
    };

    // =========================================================================
    // SPORTS SLOT — FAIRNESS-BASED SELECTOR (WITH SUPERCHARGED ROTATION)
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
    // ★★★ ENHANCED DEBUG UTILITIES ★★★
    // =========================================================================

    window.debugFillerRotation = function(bunkName, slotIndex = 0) {
        console.log('\n' + '='.repeat(70));
        console.log(`★★★ SUPERCHARGED ROTATION DEBUG: ${bunkName} @ slot ${slotIndex} ★★★`);
        console.log('='.repeat(70));

        const history = getBunkHistory(bunkName);
        
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

        const todayActivities = getActivitiesDoneToday(bunkName, slotIndex);
        console.log(`\n📍 DONE TODAY: ${[...todayActivities].join(', ') || 'none yet'}`);

        const yesterdayActivities = getActivitiesFromYesterday(bunkName);
        console.log(`📍 DONE YESTERDAY: ${[...yesterdayActivities].join(', ') || 'none'}`);

        const allActivities = getAllActivityNames();
        const fakeBlock = { bunk: bunkName, slots: [slotIndex], divName: 'Unknown' };
        const activityProperties = window.activityProperties || {};

        console.log('\n🏆 ACTIVITY RANKINGS (best first):');
        const scored = allActivities.map(act => {
            const score = calculateRotationScore(bunkName, act, fakeBlock, activityProperties);
            const streak = calculateStreakScore(bunkName, act);
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

    window.debugRotationConfig = function() {
        console.log('\n=== SUPERCHARGED ROTATION CONFIG v6.0 ===');
        console.log('Same Day:', ROTATION_CONFIG.SAME_DAY_PENALTY);
        console.log('Yesterday:', ROTATION_CONFIG.YESTERDAY_PENALTY);
        console.log('2 Days Ago:', ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY);
        console.log('3 Days Ago:', ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY);
        console.log('\nStreak Multipliers:', {
            '2-day': ROTATION_CONFIG.STREAK_TWO_DAYS_MULTIPLIER,
            '3-day': ROTATION_CONFIG.STREAK_THREE_DAYS_MULTIPLIER,
            '4+': ROTATION_CONFIG.STREAK_FOUR_PLUS_MULTIPLIER
        });
        console.log('\nBonuses:');
        console.log('  Never Done:', ROTATION_CONFIG.NEVER_DONE_BONUS);
        console.log('  Done Once:', ROTATION_CONFIG.DONE_ONCE_BONUS);
        console.log('  Done Twice:', ROTATION_CONFIG.DONE_TWICE_BONUS);
        console.log('  Missing Activity:', ROTATION_CONFIG.MISSING_ACTIVITY_BONUS);
        console.log('\nDistribution Penalties:');
        console.log('  Most in Division:', ROTATION_CONFIG.MOST_IN_DIVISION_PENALTY);
        console.log('  Severe Imbalance:', ROTATION_CONFIG.SEVERE_IMBALANCE_PENALTY);
        console.log('  Least in Division Bonus:', ROTATION_CONFIG.LEAST_IN_DIVISION_BONUS);
        console.log('\nWeights:', ROTATION_CONFIG.WEIGHTS);
        console.log('Tie-Breaker Range:', ROTATION_CONFIG.TIE_BREAKER_RANGE);
    };

    // Expose config for tuning
    window.ROTATION_CONFIG = ROTATION_CONFIG;

    console.log('★★★ [FILLERS] SUPERCHARGED Rotation v6.0 loaded ★★★');

})();
