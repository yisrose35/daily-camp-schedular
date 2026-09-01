// ============================================================================
// rotation_engine.js - SUPERCHARGED ACTIVITY ROTATION SYSTEM v2.4
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
// KEY IMPROVEMENTS IN v2.2:
// - REAL HISTORY SCANNING from actual saved schedules
// - STREAK DETECTION with escalating penalties
// - MUCH STRONGER penalties and bonuses
// - ACTIVITY COVERAGE tracking
// - TIE-BREAKING with controlled randomness
// - buildBunkActivityHistory PROPERLY EXPOSED
// - rebuildAllHistory and verifyRotationScores utilities
// - Better edge case handling
//
// KEY FIXES IN v2.4:
// - ★★★ GOTCHA 1: Recency now checked BEFORE novelty bonuses ★★★
//   (Activity done yesterday but only once no longer gets a bonus)
// - ★★★ GOTCHA 2: Variety balance + general variety combined, not early-return ★★★
//   (Variety bonus no longer gets MORE generous as day fills up)
// - ★★★ GOTCHA 3: Streak weekCount fallback penalties strengthened ★★★
//   (No more 20x cliff between streak detection and weekCount fallback)
// - ★★★ GOTCHA 4: Recency fallback now has 4-day and 5-day checks ★★★
// - ★★★ GOTCHA 5: Coverage bonus scaled by existing coverage ratio ★★★
//
// SCORING PHILOSOPHY:
// - Lower scores = BETTER (we minimize penalty)
// - Same day repeat = IMPOSSIBLE (returns Infinity)
// - Yesterday repeat = EXTREMELY BAD (+12000)
// - Streaks = ESCALATING penalties (2x, 4x, 8x multipliers)
// - Never done before = HUGE BONUS (-5000) BUT only if not recent
//
// ★★★ ALL OTHER FILES SHOULD DELEGATE TO THIS ENGINE ★★★
// ============================================================================

(function() {
    'use strict';

    const RotationEngine = {};

    // =========================================================================
    // PERF: Cached lookups for special-activity names and all-activity names.
    // Rebuilt once per solver run via RotationEngine.invalidateMetaCaches().
    // =========================================================================
    let _specialNamesCache = null;   // Set of lowercase-trimmed special names
    let _allActivityNamesCache = null; // Array of all activity names

    function _ensureSpecialNamesCache() {
        if (_specialNamesCache) return _specialNamesCache;
        var globalSettings = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var specials = (globalSettings.app1 && globalSettings.app1.specialActivities) || [];
        _specialNamesCache = new Set();
        specials.forEach(function(s) {
            if (s.name) _specialNamesCache.add(s.name.toLowerCase().trim());
        });
        return _specialNamesCache;
    }

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
        YESTERDAY_PENALTY: 50000,                // Did it yesterday - MUST NOT REPEAT
        TWO_DAYS_AGO_PENALTY: 25000,             // 2 days ago - VERY BAD
        THREE_DAYS_AGO_PENALTY: 12000,           // 3 days ago - BAD
        FOUR_DAYS_AGO_PENALTY: 6000,             // 4 days ago - moderate
        FIVE_DAYS_AGO_PENALTY: 2500,             // 5 days ago - slight concern
        SIX_SEVEN_DAYS_PENALTY: 1200,            // 6-7 days ago - mild
        FOUR_TO_SEVEN_DAYS_PENALTY: 1200,        // Alias for compatibility
        WEEK_PLUS_PENALTY: 600,                  // 8+ days ago - decaying baseline

        // =====================================================================
        // ★★★ STREAK PENALTIES - Escalating for patterns ★★★
        // =====================================================================
        STREAK_TWO_DAYS_MULTIPLIER: 1.5,         // Did it 2 of last 3 days
        STREAK_THREE_DAYS_MULTIPLIER: 2.5,       // Did it 3 of last 5 days
        STREAK_FOUR_PLUS_MULTIPLIER: 4.0,        // Did it 4+ of last 7 days

        // =====================================================================
        // FREQUENCY PENALTIES - Compared to other activities
        // =====================================================================
       HIGH_FREQUENCY_PENALTY: 6000,
ABOVE_AVERAGE_PENALTY: 3000,
SLIGHTLY_ABOVE_PENALTY: 1500,
        // =====================================================================
        // ★★★ ENHANCED VARIETY BONUSES - MUCH STRONGER ★★★
        // =====================================================================
        NEVER_DONE_BONUS: -5000,                 // NEVER done - HUGE bonus!
        DONE_ONCE_BONUS: -3000,                  // Only done once ever (only if recency safe)
        DONE_TWICE_BONUS: -1500,                 // Only done twice (only if recency safe)
        UNDER_UTILIZED_BONUS: -2000,             // Significantly under-utilized
        SLIGHTLY_UNDER_BONUS: -800,              // Slightly under average
        GOOD_VARIETY_BONUS: -400,                // General variety bonus
        BALANCE_BONUS: -800,                     // Balancing sports vs specials

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
       MISSING_ACTIVITY_BONUS: -7000,
LOW_COVERAGE_BONUS: -3500,             // Bunk has tried <50% of activities

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
        TIE_BREAKER_RANDOMNESS: 300,

        // =====================================================================
        // AVOID-UNLESS-NEEDED (Rules tab "Don't Give Unless Needed")
        // =====================================================================
        // Huge FINITE penalty: ranks the sport below every organic candidate
        // (worst realistic combined score is ~150k) but keeps it feasible, so
        // it is chosen only when the alternative is a Free slot. Kept below the
        // auto engine's 999999 Infinity-mapping so hard-blocked candidates
        // still rank worse than avoided-but-allowed ones.
        AVOID_UNLESS_NEEDED_PENALTY: 500000
    };

    // Expose config for external access and tuning
    RotationEngine.CONFIG = CONFIG;

    // =========================================================================
    // ★★★ COMPREHENSIVE HISTORY SCANNER ★★★
    // Scans ACTUAL saved schedules instead of relying on timestamps
    // =========================================================================

    let _historyCache = new Map();
    let _fairShareFloorCache = new Map();   // activityName(lower) -> fair-share floor (per gen)
    let _historyCacheDate = null;
// ★★★ v2.3: Activity-done-today cache ★★★
var _todayActivityCache = new Map();
var _todayCacheGeneration = 0;
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
            const allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
            
            // ★★★ FIX: Handle null/undefined allDaily ★★★
            if (!allDaily || typeof allDaily !== 'object') {
                console.warn('[RotationEngine] No daily data available for history');
                return history;
            }
            
            const today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            
            // Get sorted dates (most recent first), excluding today
            // ★ HR-14: COMPLETE reset — bunks get new campers at the half, so
            // even the 14-day recency/streak/coverage window must not look
            // across the rotation epoch. Pre-epoch days are invisible here.
            const _hrEp14 = _hrRotationEpoch();
            const _dateRe = /^\d{4}-\d{2}-\d{2}$/;
            const sortedDates = Object.keys(allDaily)
                .filter(function(d) { return _dateRe.test(d) && d < today && (!_hrEp14 || d >= _hrEp14); })
                .sort(function(a, b) { return b.localeCompare(a); });
            
            // Process last 14 days
            const datesToProcess = sortedDates.slice(0, 14);
            
            const _todayMs = new Date(today + 'T12:00:00').getTime();
            datesToProcess.forEach(function(dateKey) {
                const actualDaysAgo = Math.max(1, Math.round((_todayMs - new Date(dateKey + 'T12:00:00').getTime()) / 86400000));
                const dayData = allDaily[dateKey];
                
                // ★★★ FIX: Defensive checks for day data ★★★
                if (!dayData || !dayData.scheduleAssignments) return;
                
                const schedule = dayData.scheduleAssignments[bunkName] || [];
                
                schedule.forEach(function(entry) {
                    if (entry && entry._activity && !entry.continuation && !entry._isTransition) {
                        const actName = entry._activity;
                        const actLower = (actName || '').toLowerCase().trim();

                        if (actLower === 'free' || actLower === 'free play' || actLower.indexOf('transition') !== -1) return;

                        // Use normalized key for case-insensitive matching
                        const historyKey = actLower;

                        // Initialize if needed
                        if (!history.byActivity[historyKey]) {
                            history.byActivity[historyKey] = {
                                dates: [],
                                count: 0,
                                daysSinceLast: null
                            };
                        }

                        const actHistory = history.byActivity[historyKey];
                        actHistory.dates.push({ dateKey: dateKey, daysAgo: actualDaysAgo });
                        actHistory.count++;
                        
                        // Track first occurrence (most recent)
                        if (actHistory.daysSinceLast === null) {
                            actHistory.daysSinceLast = actualDaysAgo;
                        }
                        
                        // Track last 7 days
                        if (actualDaysAgo <= 7) {
                            history.recentWeek[historyKey] = (history.recentWeek[historyKey] || 0) + 1;
                        }
                        
                        history.totalActivities++;
                        history.uniqueActivities.add(historyKey);
                    }
                });
            });
            
            // Calculate streaks (consecutive days ending at yesterday)
            for (var actName in history.byActivity) {
                if (history.byActivity.hasOwnProperty(actName)) {
                    var actData = history.byActivity[actName];
                    var sortedDays = actData.dates
                        .map(function(d) { return d.daysAgo; })
                        .sort(function(a, b) { return a - b; });
                    
                    var streak = 0;
                    var expectedDay = 1;  // Start with yesterday
                    
                    for (var i = 0; i < sortedDays.length; i++) {
                        var day = sortedDays[i];
                        if (day === expectedDay) {
                            streak++;
                            expectedDay++;
                        } else if (day > expectedDay) {
                            break;
                        }
                    }
                    
                    history.recentStreak[actName] = streak;
                }
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
    _fairShareFloorCache.clear();
    _todayActivityCache.clear();
    _todayCacheGeneration++;
    console.log('[RotationEngine] History + today cache cleared (gen ' + _todayCacheGeneration + ')');
};

RotationEngine.clearTodayCache = function() {
    _todayActivityCache.clear();
    _todayCacheGeneration++;
};

RotationEngine.invalidateBunkTodayCache = function(bunkName) {
    var keysToDelete = [];
    _todayActivityCache.forEach(function(value, key) {
        if (key.indexOf(bunkName + '|') === 0) {
            keysToDelete.push(key);
        }
    });
    for (var i = 0; i < keysToDelete.length; i++) {
        _todayActivityCache.delete(keysToDelete[i]);
    }
};

    /**
     * ★ Re-apply the cloud rotation overlay after a cache wipe.
     *
     * The generation preamble (scheduler_core_main.js / scheduler_core_auto.js)
     * loads RotationCloud and merges counts+lastDone into the history cache via
     * mergeCloudData — that is what makes recency scoring work on devices whose
     * localStorage allDailyData is incomplete. Any clearHistoryCache() call
     * AFTER that merge (e.g. TotalSolver.solveSchedule's fresh-start clear)
     * silently destroys the overlay, and every activity the local scan can't
     * see scores as "never done" (-5000) — observed live 2026-07-08: 259/400
     * scored pairs claimed never-done while the count store had them done.
     * This helper re-merges from RotationCloud's in-memory cache (sync, no
     * network). Call it immediately after any mid-pipeline cache clear.
     *
     * @returns {boolean} true if cached cloud data existed and was merged
     */
    RotationEngine.reoverlayCloudCache = function() {
        try {
            var data = window.RotationCloud && window.RotationCloud.getCachedData
                ? window.RotationCloud.getCachedData() : null;
            if (data && (data.counts || data.lastDone)) {
                RotationEngine.mergeCloudData(data);
                return true;
            }
        } catch (e) {
            console.warn('[RotationEngine] reoverlayCloudCache failed:', e);
        }
        return false;
    };

    // ★★★ EXPOSE buildBunkActivityHistory on RotationEngine object ★★★
    RotationEngine.buildBunkActivityHistory = buildBunkActivityHistory;

    // Expose globally
    window.clearRotationCache = RotationEngine.clearHistoryCache;
window.clearRotationTodayCache = RotationEngine.clearTodayCache;
window.invalidateBunkRotationCache = RotationEngine.invalidateBunkTodayCache;
    // =========================================================================
    // ★★★ CACHE MANAGEMENT UTILITIES ★★★
    // =========================================================================

    /**
     * Force rebuild history for all bunks
     * Call this after schedule changes or at generation start
     */
    RotationEngine.rebuildAllHistory = function() {
    console.log('[RotationEngine] Rebuilding all history...');
    _historyCache.clear();
    _fairShareFloorCache.clear();
    _todayActivityCache.clear();
    _historyCacheDate = null;
    _todayCacheGeneration++;
        
        // Optionally pre-warm cache for all bunks
        const divisions = window.divisions || {};
        let bunkCount = 0;
        
        for (const divName in divisions) {
            if (divisions.hasOwnProperty(divName)) {
                const divData = divisions[divName];
                const bunks = (divData && divData.bunks) || [];
                for (let i = 0; i < bunks.length; i++) {
                    RotationEngine.getBunkHistory(bunks[i]);
                    bunkCount++;
                }
            }
        }
        
        console.log('[RotationEngine] Rebuilt history for ' + bunkCount + ' bunks');
    };

    /**
     * Verify rotation scores for a bunk - useful for debugging
     */
    RotationEngine.verifyRotationScores = function(bunkName, availableActivities) {
        const activityProperties = window.activityProperties || {};
        const results = [];
        const activitiesToCheck = availableActivities || RotationEngine.getAllActivityNames();
        
        activitiesToCheck.forEach(function(act) {
            var actName = typeof act === 'string' ? act : (act.name || act._activity);
            var score = RotationEngine.calculateRotationScore({
                bunkName: bunkName,
                activityName: actName,
                divisionName: 'test',
                beforeSlotIndex: 0,
                allActivities: null,
                activityProperties: activityProperties
            });
            
            results.push({
                activity: actName,
                score: score,
                blocked: score === Infinity
            });
        });
        
        // Sort by score
        results.sort(function(a, b) { return a.score - b.score; });
        
        console.log('\n=== ROTATION VERIFICATION for ' + bunkName + ' ===');
        results.forEach(function(r, i) {
            var status = r.blocked ? 'BLOCKED' : r.score.toFixed(0);
            console.log((i+1) + '. ' + r.activity + ': ' + status);
        });
        
        return results;
    };

    // =========================================================================
    // ★★★ DELEGATED STATE MANAGEMENT - Single Source of Truth ★★★
    // =========================================================================

    /**
     * Get all activities done by a bunk TODAY (before a specific slot)
     */
    RotationEngine.getActivitiesDoneToday = function(bunkName, beforeSlotIndex) {
    var cacheKey = bunkName + '|' + beforeSlotIndex;
    
    var cached = _todayActivityCache.get(cacheKey);
    if (cached !== undefined) return cached;

    var activities;
    if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getActivitiesDoneToday) {
        activities = window.SchedulerCoreUtils.getActivitiesDoneToday(bunkName, beforeSlotIndex);
    } else {
        activities = new Set();
        var schedule = window.scheduleAssignments && window.scheduleAssignments[bunkName];
        if (schedule) {
            for (var i = 0; i < beforeSlotIndex && i < schedule.length; i++) {
                var entry = schedule[i];
                if (entry && entry._activity && !entry._isTransition && !entry.continuation) {
                    activities.add(entry._activity.toLowerCase().trim());
                }
            }
        }
    }

    _todayActivityCache.set(cacheKey, activities);
    return activities;
};

    /**
     * Get activities done by a bunk YESTERDAY
     */
    RotationEngine.getActivitiesDoneYesterday = function(bunkName) {
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getActivitiesDoneYesterday) {
            return window.SchedulerCoreUtils.getActivitiesDoneYesterday(bunkName);
        }
        // Fallback
        var activities = new Set();
        try {
            var allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
            var currentDate = window.currentScheduleDate || window.currentDate;
            if (!currentDate) return activities;

            var parts = currentDate.split('-');
            var Y = parseInt(parts[0], 10);
            var M = parseInt(parts[1], 10);
            var D = parseInt(parts[2], 10);
            var yesterday = new Date(Y, M - 1, D);
            yesterday.setDate(yesterday.getDate() - 1);
            var yesterdayStr = yesterday.getFullYear() + '-' + 
                String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + 
                String(yesterday.getDate()).padStart(2, '0');

            // ★ HR-15: COMPLETE reset — a pre-epoch yesterday is treated as
            // empty (mirrors Utils.getActivitiesDoneYesterday HR-13).
            var _hrEp15 = _hrRotationEpoch();
            if (_hrEp15 && yesterdayStr < _hrEp15) return activities;

            var yesterdayData = allDaily[yesterdayStr];
            if (!yesterdayData || !yesterdayData.scheduleAssignments || !yesterdayData.scheduleAssignments[bunkName]) {
                return activities;
            }

            var schedule = yesterdayData.scheduleAssignments[bunkName];
            for (var i = 0; i < schedule.length; i++) {
                var entry = schedule[i];
                if (entry && entry._activity && !entry._isTransition && !entry.continuation) {
                    activities.add(entry._activity.toLowerCase().trim());
                }
            }
        } catch (e) {
            console.warn('[RotationEngine] Error getting yesterday activities:', e);
        }
        return activities;
    };

    // ★ HR-9: rotation-epoch reader (Half Reset watermark). COMPLETE reset:
    // bunks get new campers at the half, so ALL history — cooldowns, counts,
    // multiPart gaps, AND the 14-day recency/streak/yesterday heuristics —
    // ignores pre-epoch dates (HR-13/14/15).
    // Local fallback because load order may precede scheduler_core_utils.
    function _hrRotationEpoch() {
        try {
            if (window.SchedulerCoreUtils && typeof window.SchedulerCoreUtils.getRotationEpoch === 'function') {
                return window.SchedulerCoreUtils.getRotationEpoch();
            }
            var e = window.loadGlobalSettings ? window.loadGlobalSettings('rotationEpoch') : null;
            var d = (typeof e === 'string') ? e : (e && e.date);
            return (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
        } catch (_) { return null; }
    }

    /**
     * Get the last time a bunk did a specific activity (days ago)
     * Now uses REAL history scanning as primary source
     */
    RotationEngine.getDaysSinceActivity = function(bunkName, activityName, beforeSlotIndex) {
        var actLower = (activityName || '').toLowerCase().trim();
        
        // First check today
        var todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0;
        }
        
        // Use history scanner (primary source, keys are normalized lowercase)
        var history = RotationEngine.getBunkHistory(bunkName);
        var actHistory = history.byActivity[actLower];

        if (actHistory && actHistory.daysSinceLast !== null) {
            return actHistory.daysSinceLast;
        }
        
        // Fallback to SchedulerCoreUtils — but do NOT trust its null verbatim:
        // it only checks exact-key historicalCounts, so counts living under a
        // different key casing or in manualUsageOffsets read as "never done".
        // Keep walking our own fallbacks when it comes back empty.
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDaysSinceActivity) {
            var utilsDays = window.SchedulerCoreUtils.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
            if (utilsDays !== null && utilsDays !== undefined) return utilsDays;
        }

        // Final fallback - check rotation history timestamps
        var rotationHistory = window.loadRotationHistory ? window.loadRotationHistory() : { bunks: {} };
        var bunkHistory = rotationHistory.bunks && rotationHistory.bunks[bunkName];
        var lastTimestamp = bunkHistory && (bunkHistory[activityName] || bunkHistory[actLower]);
        // ★ HR-9: a rotationHistory timestamp from before epoch midnight is
        // invisible (bookkeeping resets at the epoch; the schedule-scan path
        // above is the recency source and stays unfiltered).
        try {
            var _hrEp9 = _hrRotationEpoch();
            if (_hrEp9 && lastTimestamp && lastTimestamp < new Date(_hrEp9 + 'T00:00:00').getTime()) {
                lastTimestamp = null;
            }
        } catch (_) {}
        if (lastTimestamp) {
            var now = Date.now();
            var daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
            return Math.max(1, daysSince);
        }

        // Check counts (getActivityCount is case-insensitive and includes
        // manualUsageOffsets — wider than the exact-key check above)
        if (RotationEngine.getActivityCount(bunkName, activityName) > 0) {
            return 14; // Assume 2 weeks if count exists but no timestamp
        }

        return null; // Never done
    };

    /**
     * ★ HR-10: epoch-floored daysSince for COOLDOWN/GAP gates.
     * Cooldowns (frequencyDays) and multiPart daysBetween reset at the
     * rotation epoch — a pre-epoch occurrence must never block placement.
     * (Since HR-14 the shared 14-day history is itself epoch-filtered, so
     * this is belt-and-braces for cached histories built pre-filter; the
     * per-date entries carry dateKeys, so we can filter them here without
     * touching the shared history cache.)
     */
    RotationEngine.getDaysSinceActivityForCooldown = function(bunkName, activityName, beforeSlotIndex) {
        // ★ The epoch (if any) only floors WHICH prior dates are visible — it does
        //   NOT decide calendar-vs-schedule counting. The gap is always measured in
        //   SCHEDULE-days (see below), so this runs whether or not an epoch is set.
        var epoch = _hrRotationEpoch();

        var actLower = (activityName || '').toLowerCase().trim();

        // Today's draft occurrences are the active generation — never pre-epoch.
        var todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) return 0;

        // 14-day schedule scan: only post-epoch dates may trigger a cooldown.
        var history = RotationEngine.getBunkHistory(bunkName);
        var actHistory = history.byActivity[actLower];
        if (actHistory) {
            var best = null, minAll = null, bestKey = null;
            var dates = actHistory.dates || [];
            for (var i = 0; i < dates.length; i++) {
                var d = dates[i];
                if (!d || typeof d.daysAgo !== 'number') continue;
                if (minAll === null || d.daysAgo < minAll) minAll = d.daysAgo;
                // Epoch floor applies only when an epoch is configured.
                if ((!epoch || (d.dateKey && String(d.dateKey) >= epoch)) && (best === null || d.daysAgo < best)) {
                    best = d.daysAgo;
                    bestKey = d.dateKey ? String(d.dateKey) : null;
                }
            }
            // A daysSinceLast fresher than every scanned date came from the
            // cloud lastDone overlay (mergeCloudData) — post-epoch by
            // construction, since RotationCloud.load is epoch-filtered (HR-7).
            var dsl = actHistory.daysSinceLast;
            var _dslWins = false;
            if (dsl != null && (minAll === null || dsl < minAll) && (best === null || dsl < best)) { best = dsl; _dslWins = true; }
            if (best !== null) {
                // ★ Cooldown gap is measured in SCHEDULE-days, not calendar days:
                //   a day the grade isn't at camp (no schedule) must not count
                //   toward "min N days between visits". Convert the most-recent
                //   occurrence's dateKey to a schedule-day gap. The cloud-overlay
                //   dsl has no dateKey to anchor from, so it falls through to its
                //   raw (calendar) value.
                if (bestKey && !_dslWins && window.SchedulerCoreUtils && window.SchedulerCoreUtils.scheduledDaysBetween) {
                    var _todayCD = window.currentScheduleDate
                        ? (typeof window.currentScheduleDate === 'string' ? window.currentScheduleDate : window.currentScheduleDate.toISOString().slice(0, 10))
                        : new Date().toISOString().split('T')[0];
                    var _gapCD = window.SchedulerCoreUtils.scheduledDaysBetween(bunkName, bestKey, _todayCD, null);
                    if (typeof _gapCD === 'number' && _gapCD > 0) return _gapCD;
                }
                return best;
            }
        }

        // No schedule-scan anchor to convert. When there is NO epoch, defer to
        // the plain recency source (RotationEngine.getDaysSinceActivity — which
        // already blends history / utils / timestamp / count). There is no epoch
        // to protect against here, and this preserves the original no-epoch
        // behavior (the schedule-day conversion above still wins whenever the
        // history scan finds a dateKey to anchor from). When an epoch IS set we
        // keep the epoch-safe fallbacks below so a pre-epoch occurrence can't leak.
        if (!epoch && typeof RotationEngine.getDaysSinceActivity === 'function') {
            var _plainDays = RotationEngine.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
            if (_plainDays !== null && _plainDays !== undefined) return _plainDays;
        }

        // Utils fallback — HR-6 already epoch-floors its timestamp and its
        // count fallback reads epoch-scoped historicalCounts.
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDaysSinceActivity) {
            var utilsDays = window.SchedulerCoreUtils.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
            if (utilsDays !== null && utilsDays !== undefined) return utilsDays;
        }

        // rotationHistory timestamp fallback — epoch-floored (HR-9 semantics)
        // only when an epoch is set; otherwise any prior timestamp counts.
        var rotationHistory = window.loadRotationHistory ? window.loadRotationHistory() : { bunks: {} };
        var bunkHistory = rotationHistory.bunks && rotationHistory.bunks[bunkName];
        var lastTimestamp = bunkHistory && (bunkHistory[activityName] || bunkHistory[actLower]);
        if (lastTimestamp && (!epoch || lastTimestamp >= new Date(epoch + 'T00:00:00').getTime())) {
            return Math.max(1, Math.floor((Date.now() - lastTimestamp) / (1000 * 60 * 60 * 24)));
        }

        // Count fallback — epoch-scoped after HR-4/HR-7, so a positive count
        // means a real post-epoch occurrence.
        if (RotationEngine.getActivityCount(bunkName, activityName) > 0) return 14;

        return null; // Never done (since the epoch)
    };

    /**
     * Get total count of how many times a bunk has done an activity
     */
    RotationEngine.getActivityCount = function(bunkName, activityName) {
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getActivityCount) {
            return window.SchedulerCoreUtils.getActivityCount(bunkName, activityName);
        }
        // Fallback — case-insensitive lookup
        var globalSettings = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var historicalCounts = globalSettings.historicalCounts || {};
        var manualOffsets = globalSettings.manualUsageOffsets || {};
        var bunkCounts = historicalCounts[bunkName] || {};
        var baseCount = bunkCounts[activityName] || 0;
        if (baseCount === 0) {
            var lower = activityName.toLowerCase();
            for (var key in bunkCounts) {
                if (key.toLowerCase() === lower) { baseCount = bunkCounts[key]; break; }
            }
        }
        var bunkOffsets = manualOffsets[bunkName] || {};
        var offset = bunkOffsets[activityName] || 0;
        if (offset === 0) {
            var lower2 = activityName.toLowerCase();
            for (var key2 in bunkOffsets) {
                if (key2.toLowerCase() === lower2) { offset = bunkOffsets[key2]; break; }
            }
        }
        return Math.max(0, baseCount + offset);
    };

    /**
     * Get average activity count for a bunk across all activities
     */
    RotationEngine.getBunkAverageActivityCount = function(bunkName, allActivities) {
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getBunkAverageActivityCount) {
            return window.SchedulerCoreUtils.getBunkAverageActivityCount(bunkName, allActivities);
        }
        if (!allActivities || allActivities.length === 0) return 0;
        var total = 0;
        for (var i = 0; i < allActivities.length; i++) {
            total += RotationEngine.getActivityCount(bunkName, allActivities[i]);
        }
        return total / allActivities.length;
    };

    /**
     * Get how "overused" an activity is for a specific bunk
     */
    RotationEngine.getActivityUsageDeviation = function(bunkName, activityName, allActivities) {
        var count = RotationEngine.getActivityCount(bunkName, activityName);
        var average = RotationEngine.getBunkAverageActivityCount(bunkName, allActivities);
        return count - average;
    };

    /**
     * ★ Fair-share floor: the LOWEST activity-count among bunks that have actually
     *   done this activity (count >= 1). calculateLimitScore's hard cap blocks any
     *   bunk sitting 2+ above this floor, so no one laps the field on a scarce /
     *   contended activity. The pool is "bunks that have done it" rather than every
     *   camp bunk, so divisions that never touch it (access/structure) don't pin the
     *   floor at 0 and false-block everyone; never-done bunks are still favoured by
     *   the existing NEVER_DONE bonus. Returns null when fewer than 2 bunks have done
     *   it (no real distribution yet) or when disabled. Cached per generation.
     *   Kill switch: window.__fairShareHardCap = false.
     *
     * ★ Scope: when divisionName is given, the pool is ONLY that division's bunks.
     *   Division-mates share a skeleton, so they have comparable opportunity counts —
     *   the camp-wide pool compared apples to oranges: one light-skeleton bunk
     *   anywhere holding count 1 pinned the floor at 1 for the WHOLE camp (observed
     *   live 2026-07-08/09: every blocked activity had floor=1, capping all 19
     *   Basketball doers at 3 and emptying one bunk's entire candidate pool → Free
     *   slots). <2 doers within the division → null (no peer group, no cap).
     *   Camp-wide pool only when the caller has no division (legacy callers).
     *   Kill switch back to camp-wide: window.__fairShareDivisionScope = false.
     */
    RotationEngine.getFairShareFloor = function(activityName, divisionName) {
        if (window.__fairShareHardCap === false) return null;
        var key = (activityName || '').toLowerCase().trim();
        if (!key) return null;
        var divisions = window.divisions || {};
        var scopeDiv = (window.__fairShareDivisionScope !== false &&
                        divisionName != null && divisions[divisionName]) ? String(divisionName) : null;
        var cacheKey = (scopeDiv || '*') + '||' + key;
        if (_fairShareFloorCache.has(cacheKey)) return _fairShareFloorCache.get(cacheKey);
        var min = Infinity, doers = 0;
        for (var dn in divisions) {
            if (!Object.prototype.hasOwnProperty.call(divisions, dn)) continue;
            if (scopeDiv && dn !== scopeDiv) continue;
            var dv = divisions[dn];
            var bunks = (dv && dv.bunks) || [];
            for (var i = 0; i < bunks.length; i++) {
                var c = RotationEngine.getActivityCount(bunks[i], activityName);
                if (c >= 1) { doers++; if (c < min) min = c; }
            }
        }
        var floor = (doers >= 2 && min !== Infinity) ? min : null;
        _fairShareFloorCache.set(cacheKey, floor);
        return floor;
    };

    /**
     * Get all unique activity names from config
     */
    RotationEngine.getAllActivityNames = function() {
        if (_allActivityNamesCache) return _allActivityNamesCache;
        var globalSettings = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var fields = (globalSettings.app1 && globalSettings.app1.fields) || [];
        var specials = (globalSettings.app1 && globalSettings.app1.specialActivities) || [];

        var names = new Set();

        fields.forEach(function(f) {
            (f.activities || []).forEach(function(sport) {
                names.add(sport);
            });
        });

        specials.forEach(function(s) {
            if (s.name) names.add(s.name);
        });

        _allActivityNamesCache = Array.from(names);
        return _allActivityNamesCache;
    };

    /**
     * Check if activity is a "special" type
     */
    RotationEngine.isSpecialActivity = function(activityName) {
        return _ensureSpecialNamesCache().has((activityName || '').toLowerCase().trim());
    };

    // =========================================================================
    // ★★★ SUPERCHARGED SCORING FUNCTIONS ★★★
    // =========================================================================

    /**
     * ★★★ GOTCHA 1 FIX: Calculate RECENCY score with real history scanning ★★★
     * LOWER IS BETTER
     * 
     * OLD BUG: count===1 returned DONE_ONCE_BONUS (-3000) BEFORE checking daysSince.
     *   Activity done yesterday but only once → got -3000 bonus instead of +12000 penalty!
     * 
     * FIX: Always check daysSince FIRST. Novelty bonuses only apply when recency is safe.
     */
    RotationEngine.calculateRecencyScore = function(bunkName, activityName, beforeSlotIndex) {
        var actLower = (activityName || '').toLowerCase().trim();
        
        // First check today
        var todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return CONFIG.SAME_DAY_PENALTY;
        }
        
        // Get comprehensive history (keys are normalized lowercase)
        var history = RotationEngine.getBunkHistory(bunkName);
        var actHistory = history.byActivity[actLower];

        // Never done at all - HUGE bonus! (no recency conflict possible)
        // ★ SPLIT-BRAIN GUARD: "absent from the history scan" is NOT proof of
        //   "never done" — the scan only sees local allDailyData (+ whatever
        //   cloud overlay survived), while the count store (historicalCounts /
        //   rotation_counts) is cumulative. Live trace 2026-07-08: 65% of scored
        //   pairs got this -5000 bonus while their own frequency component
        //   proved count > 0 — recency was rewarding activities done days ago.
        //   Before granting the novelty bonus, check the count store; if it says
        //   the bunk HAS done this, score recency via the fallback chain
        //   (rotation timestamps → counts ⇒ assume 14d) instead.
        if (!actHistory || actHistory.count === 0) {
            if (RotationEngine.getActivityCount(bunkName, activityName) > 0) {
                return RotationEngine.calculateRecencyScoreFallback(bunkName, activityName, beforeSlotIndex);
            }
            return CONFIG.NEVER_DONE_BONUS;
        }
        
        var daysSince = actHistory.daysSinceLast;
        
        if (daysSince === null) {
            // Fallback
            return RotationEngine.calculateRecencyScoreFallback(bunkName, activityName, beforeSlotIndex);
        }
        
        // ★★★ v2.4 FIX: Apply recency penalties FIRST — these are non-negotiable ★★★
        var recencyPenalty = 0;
        if (daysSince === 1) recencyPenalty = CONFIG.YESTERDAY_PENALTY;
        else if (daysSince === 2) recencyPenalty = CONFIG.TWO_DAYS_AGO_PENALTY;
        else if (daysSince === 3) recencyPenalty = CONFIG.THREE_DAYS_AGO_PENALTY;
        else if (daysSince === 4) recencyPenalty = CONFIG.FOUR_DAYS_AGO_PENALTY;
        else if (daysSince === 5) recencyPenalty = CONFIG.FIVE_DAYS_AGO_PENALTY;
        else if (daysSince <= 7) recencyPenalty = CONFIG.SIX_SEVEN_DAYS_PENALTY;
        else {
            var weeksAgo = Math.floor(daysSince / 7);
            recencyPenalty = Math.max(50, CONFIG.WEEK_PLUS_PENALTY * Math.pow(CONFIG.RECENCY_DECAY_FACTOR, weeksAgo));
        }
        
        // ★★★ v2.4 FIX: Only apply novelty bonuses when recency is SAFE (4+ days ago) ★★★
        // This prevents "done once yesterday" from getting a bonus instead of a penalty
        if (daysSince >= 4) {
            if (actHistory.count === 1) {
                recencyPenalty = recencyPenalty + CONFIG.DONE_ONCE_BONUS;
            } else if (actHistory.count === 2) {
                recencyPenalty = recencyPenalty + CONFIG.DONE_TWICE_BONUS;
            }
        }
        
        return recencyPenalty;
    };

    /**
     * ★★★ GOTCHA 4 FIX: Fallback recency with all day checks ★★★
     * 
     * OLD BUG: Missing 4-day and 5-day penalty checks (jumped from 3 days to <=7)
     */
    RotationEngine.calculateRecencyScoreFallback = function(bunkName, activityName, beforeSlotIndex) {
        var daysSince = RotationEngine.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        
        if (daysSince === null) return CONFIG.NEVER_DONE_BONUS;
        if (daysSince === 0) return CONFIG.SAME_DAY_PENALTY;
        if (daysSince === 1) return CONFIG.YESTERDAY_PENALTY;
        if (daysSince === 2) return CONFIG.TWO_DAYS_AGO_PENALTY;
        if (daysSince === 3) return CONFIG.THREE_DAYS_AGO_PENALTY;
        if (daysSince === 4) return CONFIG.FOUR_DAYS_AGO_PENALTY;
        if (daysSince === 5) return CONFIG.FIVE_DAYS_AGO_PENALTY;
        if (daysSince <= 7) return CONFIG.SIX_SEVEN_DAYS_PENALTY;
        
        var weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, CONFIG.WEEK_PLUS_PENALTY * Math.pow(CONFIG.RECENCY_DECAY_FACTOR, weeksAgo));
    };

    /**
     * ★★★ GOTCHA 3 FIX: STREAK DETECTION SCORE ★★★
     * Escalating penalties for doing same activity multiple recent days
     * 
     * OLD BUG: streak>=2 → 24,000 but weekCount=2 (if streak detection missed) → only 1,200
     *   That's a 20x cliff if streak detection has a gap day.
     * 
     * FIX: Strengthen weekCount penalties to bridge the cliff.
     */
    RotationEngine.calculateStreakScore = function(bunkName, activityName) {
        var actLower = (activityName || '').toLowerCase().trim();
        var history = RotationEngine.getBunkHistory(bunkName);

        // Check consecutive day streak (keys are normalized)
        var streak = history.recentStreak[actLower] || 0;
        
        if (streak >= 4) {
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_FOUR_PLUS_MULTIPLIER;
        }
        if (streak >= 3) {
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_THREE_DAYS_MULTIPLIER;
        }
        if (streak >= 2) {
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_TWO_DAYS_MULTIPLIER;
        }
        
        // ★★★ v2.4 FIX: Stronger weekCount penalties to close the cliff ★★★
        var weekCount = history.recentWeek[actLower] || 0;
        
        if (weekCount >= 4) {
            // 4+ times this week (non-consecutive) — nearly as bad as a 3-day streak
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_THREE_DAYS_MULTIPLIER * 0.8;
        }
        if (weekCount >= 3) {
            // 3 times this week — as bad as a 2-day streak
            return CONFIG.YESTERDAY_PENALTY * CONFIG.STREAK_TWO_DAYS_MULTIPLIER * 0.8;
        }
        if (weekCount >= 2) {
            // 2 times this week — significant penalty (bridges the cliff)
            return CONFIG.YESTERDAY_PENALTY * 0.8;
        }
        
        return 0;
    };

    /**
     * Calculate FREQUENCY score - enhanced version
     */
   RotationEngine.calculateFrequencyScore = function(bunkName, activityName, allActivities) {
    var deviation = RotationEngine.getActivityUsageDeviation(bunkName, activityName, allActivities);

    // ★★★ v2.5 FIX: Also check absolute count vs min count across activities ★★★
    var myCount = RotationEngine.getActivityCount(bunkName, activityName);
    var allActs = allActivities || RotationEngine.getAllActivityNames();
    var minCount = Infinity;
    for (var i = 0; i < allActs.length; i++) {
        var c = RotationEngine.getActivityCount(bunkName, allActs[i]);
        if (c < minCount) minCount = c;
    }
    var absoluteGap = myCount - (minCount === Infinity ? 0 : minCount);

    // Hard escalation: if this activity is 3+ more than the least-used, massive penalty
    if (absoluteGap >= 4) return CONFIG.HIGH_FREQUENCY_PENALTY * 3 + absoluteGap * 2000;
    if (absoluteGap >= 3) return CONFIG.HIGH_FREQUENCY_PENALTY * 2 + absoluteGap * 1000;
    if (absoluteGap >= 2) return CONFIG.HIGH_FREQUENCY_PENALTY + absoluteGap * 500;

    if (deviation <= -3) return CONFIG.UNDER_UTILIZED_BONUS;
    if (deviation <= -1) return CONFIG.SLIGHTLY_UNDER_BONUS;
    // ★ FLOAT-GAP FIX (2026-07-08 brain trace): deviation is a float (count −
    //   mean). The old `=== 0` check only caught exact zero, so a NEVER-DONE
    //   activity on a bunk whose average was fractional (e.g. count 0, avg 0.3
    //   → deviation −0.3) fell through to the `<= 1` branch and ate the +1500
    //   "slightly above average" PENALTY. Observed live: every zero-count
    //   activity in a sparse-history camp scored +1500 — an anti-rotation
    //   signal punishing exactly the activities the bunk needed most. Anything
    //   at or below the average is now neutral; only genuinely-above pays.
    if (deviation <= 0) return 0;
    if (deviation <= 1) return CONFIG.SLIGHTLY_ABOVE_PENALTY;
    if (deviation <= 2) return CONFIG.ABOVE_AVERAGE_PENALTY;

    return CONFIG.HIGH_FREQUENCY_PENALTY + (deviation - 2) * 500;
};

    /**
     * ★★★ GOTCHA 2 FIX: Calculate VARIETY score ★★★
     * 
     * OLD BUG #1: Returned BALANCE_BONUS early, skipping general variety calculation.
     *   If balance was relevant, variety-of-today check was completely ignored.
     * 
     * OLD BUG #2: GOOD_VARIETY_BONUS - (50 * uniqueToday) got MORE generous as day fills.
     *   uniqueToday=0: -400, uniqueToday=4: -600. Should be the opposite.
     * 
     * FIX: Combine balance + variety instead of early return. Fix scaling direction.
     */
    RotationEngine.calculateVarietyScore = function(bunkName, activityName, beforeSlotIndex) {
        var todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        var actLower = (activityName || '').toLowerCase().trim();

        // Already done today - FORBIDDEN
        if (todayActivities.has(actLower)) {
            return CONFIG.SAME_DAY_PENALTY;
        }

        // --- Score component 1: Type balance (sports vs specials) ---
        var balanceScore = 0;
        var todaySports = 0;
        var todaySpecials = 0;

        todayActivities.forEach(function(act) {
            if (RotationEngine.isSpecialActivity(act)) {
                todaySpecials++;
            } else {
                todaySports++;
            }
        });

        var thisIsSpecial = RotationEngine.isSpecialActivity(activityName);

        if (thisIsSpecial && todaySports > todaySpecials + 1) {
            balanceScore = CONFIG.BALANCE_BONUS * 2;   // Strong bonus — specials way behind
        } else if (thisIsSpecial && todaySports > todaySpecials) {
            balanceScore = CONFIG.BALANCE_BONUS;        // Moderate bonus
        } else if (!thisIsSpecial && todaySpecials > todaySports + 1) {
            balanceScore = CONFIG.BALANCE_BONUS * 2;   // Strong bonus — sports way behind
        } else if (!thisIsSpecial && todaySpecials > todaySports) {
            balanceScore = CONFIG.BALANCE_BONUS;        // Moderate bonus
        } else if (thisIsSpecial && todaySpecials > todaySports + 1) {
            balanceScore = -CONFIG.BALANCE_BONUS;       // Penalty — too many specials already
        } else if (!thisIsSpecial && todaySports > todaySpecials + 1) {
            balanceScore = -CONFIG.BALANCE_BONUS;       // Penalty — too many sports already
        }

        // --- Score component 2: General variety ---
        // ★★★ v2.4 FIX: Bonus DECREASES as day fills (more things already done = less urgent) ★★★
        var uniqueToday = todayActivities.size;
        var generalVariety = CONFIG.GOOD_VARIETY_BONUS + (50 * Math.min(uniqueToday, 4));
        // uniqueToday=0: -400 (strong bonus for first activity of the day)
        // uniqueToday=2: -300
        // uniqueToday=4: -200 (weaker — day is already varied)

        // ★★★ v2.4 FIX: COMBINE both scores instead of early-returning on balance ★★★
        return balanceScore + generalVariety;
    };

    /**
     * Calculate DISTRIBUTION score - enhanced cross-bunk fairness
     */
    RotationEngine.calculateDistributionScore = function(bunkName, activityName, divisionName) {
        var divisions = window.divisions || {};
        var divData = divisions[divisionName];
        var bunksInDiv = (divData && divData.bunks) || [];

        if (bunksInDiv.length <= 1) return 0;

        var counts = bunksInDiv.map(function(b) {
            return RotationEngine.getActivityCount(b, activityName);
        });
        var myCount = RotationEngine.getActivityCount(bunkName, activityName);

        var minCount = Math.min.apply(null, counts);
        var maxCount = Math.max.apply(null, counts);
        var sum = 0;
        for (var i = 0; i < counts.length; i++) sum += counts[i];
        var avgCount = sum / counts.length;

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
     * ★★★ GOTCHA 5 FIX: ACTIVITY COVERAGE SCORE ★★★
     * Encourage bunks to try ALL available activities
     * 
     * OLD BUG: Returned MISSING_ACTIVITY_BONUS (-3500) even if bunk has 95% coverage.
     *   Combined with other bonuses, this could overpower strong recency penalties.
     * 
     * FIX: Scale the bonus by how much coverage the bunk still needs.
     */
    RotationEngine.calculateCoverageScore = function(bunkName, activityName) {
        var actLower = (activityName || '').toLowerCase().trim();
        var allActivities = RotationEngine.getAllActivityNames();
        if (allActivities.length === 0) return 0;

        var history = RotationEngine.getBunkHistory(bunkName);
        var triedActivities = history.uniqueActivities.size;
        var coverageRatio = triedActivities / allActivities.length;

        // Has this bunk ever tried this activity? (keys are normalized)
        // ★ SPLIT-BRAIN GUARD (same as calculateRecencyScore): the history scan
        //   missing an activity is not proof it was never tried — consult the
        //   cumulative count store before granting the missing-activity bonus.
        var hasTriedThis = (history.byActivity[actLower] && history.byActivity[actLower].count > 0)
            || RotationEngine.getActivityCount(bunkName, activityName) > 0;

        if (!hasTriedThis) {
            var needRatio = 1 - coverageRatio;
            var scaledBonus = CONFIG.MISSING_ACTIVITY_BONUS * Math.max(0.3, needRatio);
            return scaledBonus;
        }

        // Low overall coverage - bonus for trying less-used activities
        if (coverageRatio < 0.5) {
            var actCount = (history.byActivity[actLower] && history.byActivity[actLower].count) || 0;
            if (actCount <= 1) {
                return CONFIG.LOW_COVERAGE_BONUS;
            }
        }
        
        return 0;
    };

    /**
     * ★ GenTrace helper: record WHY an activity was hard-blocked for a bunk.
     *   Stores the reason on RotationEngine._lastBlockReason (read by
     *   calculateRotationScore for its score-breakdown trace) and feeds the
     *   generation brain trace when one is recording. Always returns Infinity
     *   so call sites read `return _blk(...)`.
     */
    function _blk(bunkName, activityName, reason, detail) {
        RotationEngine._lastBlockReason = reason;
        if (window.GenTrace && window.GenTrace.active) {
            window.GenTrace.block(bunkName, activityName, reason, detail);
        }
        return Infinity;
    }

    /**
     * Calculate LIMIT score - for activities with usage limits
     */
    RotationEngine.calculateLimitScore = function(bunkName, activityName, activityProperties, divisionName) {
        RotationEngine._lastBlockReason = null;
        var props = (activityProperties && activityProperties[activityName]) || {};
        // ★ available=false hard gate: a globally-disabled special must never be
        //   scheduled. canBlockFit also rejects available===false, but some manual
        //   solver placement paths score candidates via this function without going
        //   through canBlockFit — so a disabled special could still be selected and
        //   written. Block it here (the shared rotation-scoring choke point) so a
        //   disabled special is never picked. activityProperties carries `available`
        //   for every special (buildActivityProperties copies it), so props is reliable.
        if (props.available === false) return _blk(bunkName, activityName, 'special-disabled');
        // ★ PER-DATE BUNK-ONLY RESTRICTION — "only available for these bunk(s) today".
        //   Auto rotation gate for special/sport targets (matches by activity name).
        //   Facility targets are enforced in the field gate (isFieldAvailable).
        if (window.SchedulerCoreUtils?.isBunkRestrictedFromTarget?.(bunkName, activityName, null, divisionName)) return _blk(bunkName, activityName, 'per-date-bunk-restriction');
        var _getPeriodCount = window.SchedulerCoreUtils?.getPeriodActivityCount;
        var _cdForEsc = parseInt(props.frequencyDays) || 0;

        // ★★★ DAY 17 FIX: frequencyDays as a real cooldown hard-gate ★★★
        // The UI labels this "Min days between visits:" (facilities.js:3262)
        // and existing usage in scheduler config treats it as a cooldown.
        // Previously the engine only used _cdForEsc as a modulation parameter
        // for getEscalationBonus when min/exact frequency was set — no hard
        // gate at all. Live-observed: Quints 7 got Triple Fun on 5/28 and
        // 5/29 with frequencyDays=3 (only 1-day gap).
        //
        // Hard-block if the bunk did this activity within the cooldown window.
        // Skip daysSince=0 (same-day; variety score handles intra-day dup).
        // Skip null/undefined (never done; nothing to cooldown from).
        if (_cdForEsc > 0) {
            // ★ HR-11: cooldowns reset at the rotation epoch — use the
            // epoch-floored variant so a pre-epoch visit can never block.
            var _daysSinceCD = RotationEngine.getDaysSinceActivityForCooldown(bunkName, activityName);
            // ★ A cooldown requires an ACTUAL prior occurrence. Guard on getActivityCount > 0
            //   (the schedule-derived count the user sees) so a stale lastDone with a zero
            //   count — cloud rotation_counts diverging from the rebuilt history — can never
            //   block a special the bunk has never done and force it to the Swim fallback.
            if (typeof _daysSinceCD === 'number' && _daysSinceCD > 0 && _daysSinceCD < _cdForEsc
                && RotationEngine.getActivityCount(bunkName, activityName) > 0) {
                return _blk(bunkName, activityName, 'frequencyDays-cooldown', { daysSince: _daysSinceCD, cooldownDays: _cdForEsc });
            }
        }

        // ★ multiPart daysBetween + totalParts gate (manual-audit fix; mirrors
        //   auto scheduler_core_auto.js:4306-4338). AUTO pre-gates multiPart
        //   specials in its planner — the gap since the previous part must be
        //   >= daysBetween, and it refuses to place once all totalParts are done.
        //   The shared rotation path never checked either, so the MANUAL builder
        //   ignored multiPart entirely (placed it as an ordinary repeating
        //   special). Gate here → fixes manual; harmless for auto (its planner
        //   already pre-filters with the identical rule). Counting by the base
        //   activity name matches the writer, which keeps _activity as the base.
        //   Gated to non-auto (like rotationCohort below): AUTO's planner is the
        //   single authority and uses its own allDailyData count source, so we
        //   never want to double-enforce here with getActivityCount's source.
        var _mp = props.multiPart;
        // Robust read: if the (possibly rebuilt/whitelisted) activityProperties
        // dropped multiPart, fall back to the canonical special config store —
        // same reason computeManualSpecialFeatures reads it directly.
        if (!_mp && typeof window.getSpecialActivityByName === 'function') {
            try { var _spCfg = window.getSpecialActivityByName(activityName); if (_spCfg) _mp = _spCfg.multiPart; } catch (e) {}
        }
        if (window._daBuilderMode !== 'auto' && _mp && _mp.enabled) {
            var _mpTotal = parseInt(_mp.totalParts) || 0;
            var _mpPrior = (typeof RotationEngine.getActivityCount === 'function')
                ? (RotationEngine.getActivityCount(bunkName, activityName) || 0) : 0;
            // All parts already placed → never schedule this special again.
            if (_mpTotal > 0 && _mpPrior >= _mpTotal) return _blk(bunkName, activityName, 'multiPart-complete', { partsDone: _mpPrior, totalParts: _mpTotal });
            // daysBetween: minimum gap since the previous part must elapse.
            var _mpGap = parseInt(_mp.daysBetween) || 0;
            if (_mpGap > 0) {
                // ★ HR-12: multiPart sequences restart at part 1 at the epoch —
                // the gap gate must not see pre-epoch parts.
                var _mpSince = RotationEngine.getDaysSinceActivityForCooldown(bunkName, activityName);
                if (typeof _mpSince === 'number' && _mpSince > 0 && _mpSince < _mpGap) return _blk(bunkName, activityName, 'multiPart-daysBetween', { daysSince: _mpSince, daysBetween: _mpGap });
            }
        }

        // ★ availableDays weekday gate (manual-audit fix): mirror auto's
        //   isSpecialAvailableOnDay (scheduler_core_auto.js:382-383). A special
        //   restricted to certain weekdays must NEVER be selected on others.
        //   This was AUTO-ONLY (the auto planner pre-gated it); the shared
        //   solver/rotation path never checked weekday, so the MANUAL builder
        //   placed weekday-restricted specials on disallowed days. Hard-block on
        //   the shared path → fixes manual + harmless for auto (which already
        //   pre-filters by day). Matches auto: case-insensitive, accepts 3-letter
        //   ('Wed') or full ('Wednesday') day names.
        if (Array.isArray(props.availableDays) && props.availableDays.length > 0) {
            var _avDate = window.currentScheduleDate;
            if (_avDate) {
                var _avp = String(_avDate).split('-');
                if (_avp.length === 3) {
                    var _avDow = new Date(parseInt(_avp[0], 10), parseInt(_avp[1], 10) - 1, parseInt(_avp[2], 10)).getDay();
                    if (_avDow >= 0 && _avDow <= 6) {
                        var _avAbbr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][_avDow];
                        var _avFull = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][_avDow];
                        var _avAllowed = props.availableDays.map(function (d) { return String(d).toLowerCase(); });
                        if (_avAllowed.indexOf(_avAbbr) < 0 && _avAllowed.indexOf(_avFull) < 0) {
                            return _blk(bunkName, activityName, 'availableDays-weekday', { today: _avFull, allowed: props.availableDays });
                        }
                    }
                }
            }
        }

        // ★ rotationCohort: pooled cross-grade fairness (manual-audit fix).
        //   AUTO enforces this in its planner (scheduler_core_auto.js:4261-4283);
        //   the MANUAL builder has no planner, so it's enforced here. Gated to
        //   non-auto so auto's planner stays the single authority (avoids any
        //   double-enforcement with a different count source). Skip the special
        //   for this bunk when its count exceeds the cohort minimum (i.e. wait
        //   for the lagging bunks in the cohort to catch up). Mirrors the auto
        //   "skip if count > cohort min" rule.
        if (window._daBuilderMode !== 'auto') {
            var _rc = props.rotationCohort;
            if (_rc && _rc.enabled && Array.isArray(_rc.grades) && _rc.grades.length > 0) {
                var _divsRC = window.divisions || {};
                var _cohortBunks = [];
                _rc.grades.forEach(function (_g) {
                    var _gd = _divsRC[_g] || _divsRC[String(_g)];
                    if (_gd && Array.isArray(_gd.bunks)) _gd.bunks.forEach(function (_b) {
                        // ★ FN-5: only pool cohort bunks that can actually RECEIVE this
                        //   special. Without this filter, a cohort member that's
                        //   access-restricted away from the special keeps its count
                        //   pinned at 0, so _cohortMin stays 0 forever and every
                        //   reachable bunk freezes after one visit (count 1 > min 0 →
                        //   skipped). The AUTO planner filters with
                        //   isSpecialAvailableForBunk (scheduler_core_auto.js:4266);
                        //   reuse that exact check here for parity. Fallback: if the
                        //   helper isn't loaded, include the bunk (prior behavior) so
                        //   this can only ADD correct filtering, never break.
                        var _elig = true;
                        try {
                            if (typeof window.isSpecialAvailableForBunk === 'function') {
                                _elig = window.isSpecialAvailableForBunk(activityName, _g, _b, window.globalSettings || null);
                            }
                        } catch (_eElig) { _elig = true; }
                        if (_elig) _cohortBunks.push(String(_b));
                    });
                });
                if (_cohortBunks.length > 0 && _cohortBunks.indexOf(String(bunkName)) >= 0) {
                    var _myCohortCount = RotationEngine.getActivityCount(String(bunkName), activityName);
                    var _cohortMin = Infinity;
                    for (var _rci = 0; _rci < _cohortBunks.length; _rci++) {
                        var _cc = RotationEngine.getActivityCount(_cohortBunks[_rci], activityName);
                        if (_cc < _cohortMin) _cohortMin = _cc;
                    }
                    if (_myCohortCount > _cohortMin) return _blk(bunkName, activityName, 'rotationCohort-waiting', { myCount: _myCohortCount, cohortMin: _cohortMin });
                }
            }
        }

        // ★ Per-grade cap: grade-specific override takes precedence over global
        var maxUsage = props.maxUsage || 0;
        if (divisionName && props.maxUsagePerGrade && props.maxUsagePerGrade[divisionName] > 0) {
            maxUsage = props.maxUsagePerGrade[divisionName];
        }

        var maxPeriod = props.maxUsagePeriod || 'half';
        var maxCount = (_getPeriodCount && maxUsage > 0)
            ? _getPeriodCount(bunkName, activityName, maxPeriod)
            : RotationEngine.getActivityCount(bunkName, activityName);

        // Hard ceiling
        if (maxUsage > 0) {
            if (maxCount >= maxUsage) return _blk(bunkName, activityName, 'maxUsage-cap', { count: maxCount, maxUsage: maxUsage, period: maxPeriod });
            if (maxCount >= maxUsage - 1) return CONFIG.NEAR_LIMIT_PENALTY;
            if (maxCount >= maxUsage - 2) return CONFIG.LIMITED_ACTIVITY_PENALTY;
        }

        // ★ Exact frequency: acts as both ceiling and floor
        var exactFreq = parseInt(props.exactFrequency) || 0;
        if (divisionName && props.exactFrequencyPerGrade && props.exactFrequencyPerGrade[divisionName] > 0) {
            exactFreq = props.exactFrequencyPerGrade[divisionName];
        }
        if (exactFreq > 0) {
            var exactPeriod = props.exactFrequencyPeriod || '1week';
            var exactCount = _getPeriodCount ? _getPeriodCount(bunkName, activityName, exactPeriod) : RotationEngine.getActivityCount(bunkName, activityName);
            if (exactCount >= exactFreq) return _blk(bunkName, activityName, 'exactFrequency-reached', { count: exactCount, exactFrequency: exactFreq, period: exactPeriod });
            if (exactCount >= exactFreq - 1) return CONFIG.NEAR_LIMIT_PENALTY;
            var exactShortage = exactFreq - exactCount;
            if (exactShortage > 0) {
                var _efEsc = window.SchedulerCoreUtils?.getEscalationBonus?.(exactPeriod, exactShortage, undefined, _cdForEsc);
                return -(_efEsc || (exactShortage * 8000));
            }
        }

        // ★ Min frequency: strong pull when bunk is below the floor
        // Escalates based on effective remaining days incl. cooldown.
        var minFreq = parseInt(props.minFrequency) || 0;
        if (minFreq > 0) {
            var minPeriod = props.minFrequencyPeriod || 'week';
            if (minPeriod === 'week') minPeriod = '1week';
            var minCount = _getPeriodCount ? _getPeriodCount(bunkName, activityName, minPeriod) : RotationEngine.getActivityCount(bunkName, activityName);
            var shortage = minFreq - minCount;
            if (shortage > 0) {
                var _mfEsc = window.SchedulerCoreUtils?.getEscalationBonus?.(minPeriod, shortage, undefined, _cdForEsc);
                return -(_mfEsc || (shortage * 8000));
            }
        }

        // ★ FAIR-SHARE HARD CAP: a bunk that has done this activity 2+ more times
        //   than the least-served participant is BLOCKED until the laggards catch up
        //   — stops one bunk lapping the field on a scarce/contended activity even
        //   when the soft frequency/distribution penalties get overridden by field
        //   contention. Placed LAST so an explicit maxUsage/exactFrequency ceiling or
        //   a below-floor min-frequency pull always wins; this only governs activities
        //   no per-bunk limit rule already decided. Counts are from saved history
        //   (stable within a gen). Floor is division-scoped (see getFairShareFloor).
        //   Trade-off: a capped bunk with no other feasible option gets a Free slot —
        //   softened by the last-resort relax pass in auto_fill_slot.js scoreAndPick,
        //   which may re-admit ONLY fair-share-capped candidates before leaving a
        //   slot Free. Kill switch: window.__fairShareHardCap = false;
        //   gap override: window.__fairShareGap (default 2).
        var _fsFloor = RotationEngine.getFairShareFloor(activityName, divisionName);
        if (_fsFloor !== null) {
            var _fsGap = (typeof window.__fairShareGap === 'number' && window.__fairShareGap > 0) ? window.__fairShareGap : 2;
            var _fsMyCount = RotationEngine.getActivityCount(bunkName, activityName);
            if (_fsMyCount >= _fsFloor + _fsGap) return _blk(bunkName, activityName, 'fairShare-cap', { myCount: _fsMyCount, floor: _fsFloor, gap: _fsGap });
        }

        return 0;
    };

    // ★ Helper: resolve the effective max usage cap for a bunk's grade
    RotationEngine.getEffectiveMaxUsage = function(activityName, divisionName, activityProperties) {
        var props = (activityProperties && activityProperties[activityName]) || {};
        var maxUsage = props.maxUsage || 0;
        if (divisionName && props.maxUsagePerGrade && props.maxUsagePerGrade[divisionName] > 0) {
            maxUsage = props.maxUsagePerGrade[divisionName];
        }
        return maxUsage;
    };    // =========================================================================
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
        var bunkName = options.bunkName;
        var activityName = options.activityName;
        var divisionName = options.divisionName;
        var beforeSlotIndex = options.beforeSlotIndex || 0;
        var allActivities = options.allActivities;
        var activityProperties = options.activityProperties;

        // ★★★ FIX: Handle edge cases ★★★
        if (!bunkName || !activityName) return 0;
        
        var actLower = (activityName || '').toLowerCase().trim();
        if (actLower === 'free' || actLower === 'free play' || actLower === 'no field') return 0;

        // ★ GenTrace: capture the full component breakdown (or block cause) for
        //   the brain trace. Deduped per bunk|activity|slot inside GenTrace, so
        //   repeated scoring calls are cheap and the trace holds the latest view.
        var _gt = (window.GenTrace && window.GenTrace.active) ? window.GenTrace : null;

        // RECENCY - primary factor
        var recencyScore = RotationEngine.calculateRecencyScore(bunkName, activityName, beforeSlotIndex);

        if (recencyScore === Infinity) {
            if (_gt) _gt.score({ bunk: bunkName, activity: activityName, slot: beforeSlotIndex, blocked: true, blockReason: 'already-done-today' });
            return Infinity;
        }

        // VARIETY - also checks same day
        var varietyScore = RotationEngine.calculateVarietyScore(bunkName, activityName, beforeSlotIndex);

        if (varietyScore === Infinity) {
            if (_gt) _gt.score({ bunk: bunkName, activity: activityName, slot: beforeSlotIndex, blocked: true, blockReason: 'already-done-today' });
            return Infinity;
        }

        // ★★★ STREAK DETECTION ★★★
        var streakScore = RotationEngine.calculateStreakScore(bunkName, activityName);

        // FREQUENCY
        var frequencyScore = RotationEngine.calculateFrequencyScore(bunkName, activityName, allActivities || RotationEngine.getAllActivityNames());

        // DISTRIBUTION
        var distributionScore = RotationEngine.calculateDistributionScore(bunkName, activityName, divisionName);

        // ★★★ COVERAGE ★★★
        var coverageScore = RotationEngine.calculateCoverageScore(bunkName, activityName);

        // LIMIT
        var limitScore = RotationEngine.calculateLimitScore(bunkName, activityName, activityProperties, divisionName);

        if (limitScore === Infinity) {
            if (_gt) _gt.score({ bunk: bunkName, activity: activityName, slot: beforeSlotIndex, blocked: true, blockReason: RotationEngine._lastBlockReason || 'limit' });
            return Infinity;
        }

        // ★ AVOID-UNLESS-NEEDED (Rules tab): soft "don't give unless needed" rule.
        //   A huge finite penalty — NOT Infinity — so the sport ranks below every
        //   normal candidate but stays feasible; it is placed only when the
        //   alternative would be a Free slot. All engines rank through this
        //   function, so the penalty steers auto, manual, fills and suggestions.
        var avoidPenalty = 0;
        try {
            if (window.SchedulerCoreUtils?.isSportAvoidedUnlessNeeded?.(divisionName, activityName)) {
                avoidPenalty = CONFIG.AVOID_UNLESS_NEEDED_PENALTY;
            }
        } catch (e) { /* fail open */ }

        // Combine with weights
        var totalScore = (
            recencyScore * CONFIG.WEIGHTS.recency +
            streakScore * CONFIG.WEIGHTS.streak +
            frequencyScore * CONFIG.WEIGHTS.frequency +
            varietyScore * CONFIG.WEIGHTS.variety +
            distributionScore * CONFIG.WEIGHTS.distribution +
            coverageScore * CONFIG.WEIGHTS.coverage +
            limitScore +
            avoidPenalty
        );

        if (_gt) {
            _gt.score({
                bunk: bunkName, activity: activityName, slot: beforeSlotIndex, division: divisionName,
                recency: recencyScore, streak: streakScore, frequency: frequencyScore,
                variety: varietyScore, distribution: distributionScore, coverage: coverageScore,
                limit: limitScore, avoid: avoidPenalty, total: Math.round(totalScore)
            });
        }

        return totalScore;
    };

    /**
     * Simplified score calculation for quick checks (backward compatibility)
     */
    RotationEngine.quickScore = function(bunkName, activityName, slotIndex, divisionName) {
        return RotationEngine.calculateRotationScore({
            bunkName: bunkName,
            activityName: activityName,
            divisionName: divisionName,
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
        var bunkName = options.bunkName;
        var divisionName = options.divisionName;
        var beforeSlotIndex = options.beforeSlotIndex;
        var availableActivities = options.availableActivities;
        var activityProperties = options.activityProperties;

        var allActivityNames = availableActivities.map(function(a) {
            return typeof a === 'string' ? a : (a.name || a._activity || a.field);
        });

        var scored = availableActivities.map(function(activity) {
            var actName = typeof activity === 'string' ? activity : (activity.name || activity._activity || activity.field);

            var score = RotationEngine.calculateRotationScore({
                bunkName: bunkName,
                activityName: actName,
                divisionName: divisionName,
                beforeSlotIndex: beforeSlotIndex,
                allActivities: allActivityNames,
                activityProperties: activityProperties
            });

            return {
                activity: activity,
                activityName: actName,
                score: score,
                allowed: score !== Infinity
            };
        });

        // Sort by score (lowest first)
        scored.sort(function(a, b) { return a.score - b.score; });

        // ★★★ TIE-BREAKING: deterministic, not Math.random(). ★★★
        // Earlier this used Math.random() which made every regenerate
        // produce a different schedule even with identical inputs —
        // impossible to reproduce a bad run for debugging, and the
        // user-visible "regenerate" reshuffled work the user had
        // implicitly accepted. Now we hash (bunk + activity + day) so
        // ties resolve identically across runs while still varying
        // across (bunk, activity) pairs to avoid alphabetic bias.
        if (scored.length >= 2) {
            var bestScore = scored[0].score;
            var tieGroup = scored.filter(function(p) {
                return p.score <= bestScore + CONFIG.TIE_BREAKER_RANGE && p.allowed;
            });

            if (tieGroup.length > 1) {
                var dayKey = (typeof window !== 'undefined' && window.currentScheduleDate) || '';
                function _detTieHash(s) {
                    var h = 5381;
                    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
                    // Map to [0, TIE_BREAKER_RANDOMNESS).
                    var u = (h >>> 0) / 4294967296;
                    return u * CONFIG.TIE_BREAKER_RANDOMNESS;
                }
                tieGroup.forEach(function(p) {
                    p._tieBreaker = _detTieHash(bunkName + '|' + p.activityName + '|' + dayKey);
                    p._finalScore = p.score + p._tieBreaker;
                });

                tieGroup.sort(function(a, b) { return a._finalScore - b._finalScore; });

                scored.splice(0, tieGroup.length);
                for (var i = 0; i < tieGroup.length; i++) {
                    scored.unshift(tieGroup[tieGroup.length - 1 - i]);
                }
            }
        }

        // ★ GenTrace: record the ranked list the engine handed back — this is
        //   the "what did it think was best for this bunk at this slot" record.
        if (window.GenTrace && window.GenTrace.active) {
            var _allowed = [], _blocked = [];
            for (var _gi = 0; _gi < scored.length; _gi++) {
                var _p = scored[_gi];
                if (_p.allowed) _allowed.push({ name: _p.activityName, score: Math.round(_p.score) });
                else if (_blocked.length < 20) _blocked.push(_p.activityName);
            }
            window.GenTrace.rank({
                bunk: bunkName, division: divisionName, slot: beforeSlotIndex,
                ranked: _allowed, blocked: _blocked
            });
        }

        return scored;
    };

    // =========================================================================
    // ★★★ ENHANCED DEBUG UTILITIES ★★★
    // =========================================================================

    RotationEngine.debugBunkRotation = function(bunkName, slotIndex) {
        if (slotIndex === undefined) slotIndex = 0;
        
        console.log('\n' + '='.repeat(70));
        console.log('SUPERCHARGED ROTATION DEBUG: ' + bunkName + ' @ slot ' + slotIndex);
        console.log('='.repeat(70));

        var history = RotationEngine.getBunkHistory(bunkName);
        
        console.log('\nBUNK HISTORY (from actual schedules):');
        console.log('  Total activities tracked: ' + history.totalActivities);
        console.log('  Unique activities tried: ' + history.uniqueActivities.size);
        
        console.log('\nRECENT WEEK FREQUENCY:');
        var weekEntries = Object.entries(history.recentWeek).sort(function(a, b) { return b[1] - a[1]; });
        if (weekEntries.length === 0) {
            console.log('  No activities in last 7 days');
        } else {
            weekEntries.forEach(function(entry) {
                console.log('  ' + entry[0] + ': ' + entry[1] + 'x in last 7 days');
            });
        }
        
        console.log('\nCURRENT STREAKS (consecutive days):');
        var streakEntries = Object.entries(history.recentStreak).filter(function(e) { return e[1] > 0; }).sort(function(a, b) { return b[1] - a[1]; });
        if (streakEntries.length === 0) {
            console.log('  No active streaks');
        } else {
            streakEntries.forEach(function(entry) {
                console.log('  WARNING ' + entry[0] + ': ' + entry[1] + ' consecutive days');
            });
        }

        var todayActivities = RotationEngine.getActivitiesDoneToday(bunkName, slotIndex);
        console.log('\nDONE TODAY: ' + (Array.from(todayActivities).join(', ') || 'none yet'));

        var yesterdayActivities = RotationEngine.getActivitiesDoneYesterday(bunkName);
        console.log('DONE YESTERDAY: ' + (Array.from(yesterdayActivities).join(', ') || 'none'));

        var allActivities = RotationEngine.getAllActivityNames();
        var activityProperties = window.activityProperties || {};

        console.log('\nACTIVITY RANKINGS (best first):');
        var scored = allActivities.map(function(act) {
            var score = RotationEngine.calculateRotationScore({
                bunkName: bunkName,
                activityName: act,
                divisionName: 'Unknown',
                beforeSlotIndex: slotIndex,
                allActivities: allActivities,
                activityProperties: activityProperties
            });
            var streak = RotationEngine.calculateStreakScore(bunkName, act);
            var weekCount = history.recentWeek[(act || '').toLowerCase().trim()] || 0;
            return { activity: act, score: score, streak: streak, weekCount: weekCount };
        }).sort(function(a, b) { return a.score - b.score; });

        scored.slice(0, 15).forEach(function(item, i) {
            var status = item.score === Infinity ? 'BLOCKED' : item.score.toFixed(0);
            var streakInfo = item.streak > 0 ? ' [streak: +' + item.streak.toFixed(0) + ']' : '';
            var weekInfo = item.weekCount > 0 ? ' (' + item.weekCount + 'x/week)' : '';
            console.log('  ' + (i + 1) + '. ' + item.activity + ': ' + status + streakInfo + weekInfo);
        });

        var blocked = scored.filter(function(s) { return s.score === Infinity; });
        console.log('\nBlocked: ' + (blocked.map(function(b) { return b.activity; }).join(', ') || 'none'));

        console.log('\n' + '='.repeat(70));
    };

    RotationEngine.debugConfig = function() {
        console.log('\n=== SUPERCHARGED ROTATION CONFIG v2.4 ===');
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
        console.log('  Done Once:', CONFIG.DONE_ONCE_BONUS, '(only if 4+ days ago)');
        console.log('  Done Twice:', CONFIG.DONE_TWICE_BONUS, '(only if 4+ days ago)');
        console.log('  Missing Activity:', CONFIG.MISSING_ACTIVITY_BONUS, '(scaled by coverage need)');
        console.log('\nDistribution Penalties:');
        console.log('  Most in Division:', CONFIG.MOST_IN_DIVISION_PENALTY);
        console.log('  Severe Imbalance:', CONFIG.SEVERE_IMBALANCE_PENALTY);
        console.log('  Least in Division Bonus:', CONFIG.LEAST_IN_DIVISION_BONUS);
        console.log('\nWeights:', CONFIG.WEIGHTS);
    };

    RotationEngine.debugDivisionRotation = function(divisionName) {
        var divisions = window.divisions || {};
        var divData = divisions[divisionName];
        var bunks = (divData && divData.bunks) || [];

        console.log('\n' + '='.repeat(70));
        console.log('DIVISION ROTATION STATUS: ' + divisionName);
        console.log('='.repeat(70));

        if (bunks.length === 0) {
            console.log('No bunks in division');
            return;
        }

        console.log('\nTodays Activities:');
        bunks.forEach(function(bunk) {
            var today = RotationEngine.getActivitiesDoneToday(bunk, 999);
            console.log('  ' + bunk + ': ' + (Array.from(today).join(', ') || 'none yet'));
        });

        console.log('\n' + '='.repeat(70));
    };

    RotationEngine.invalidateMetaCaches = function() {
        _specialNamesCache = null;
        _allActivityNamesCache = null;
    };

    /**
     * Merge cloud rotation data (from RotationCloud.load()) into the history
     * cache so recency/count scoring sees cloud-backed history even when
     * allDailyData in localStorage is incomplete.
     *
     * @param {{ counts: Object, lastDone: Object }} cloudData
     *   counts:   { bunkName: { activityName: totalCount } }
     *   lastDone: { bunkName: { activityName: "YYYY-MM-DD" } }
     */
    RotationEngine.mergeCloudData = function(cloudData) {
        if (!cloudData) return;
        var today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        var todayMs = new Date(today + 'T12:00:00').getTime();
        var msPerDay = 86400000;
        var merged = 0;

        // Ensure cache date is current
        if (_historyCacheDate !== today) {
            _historyCache.clear();
            _historyCacheDate = today;
        }

        var allBunks = new Set();
        if (cloudData.counts) Object.keys(cloudData.counts).forEach(function(b) { allBunks.add(b); });
        if (cloudData.lastDone) Object.keys(cloudData.lastDone).forEach(function(b) { allBunks.add(b); });

        // Today's per-bunk cloud contribution. The local 14-day scan
        // (buildBunkActivityHistory) deliberately excludes today, so cloud
        // counts must do the same — otherwise a regenerate sees today's stale
        // draft as "history" and biases scoring against it.
        var todayCloud = (cloudData.countsByDate && cloudData.countsByDate[today]) || {};

        allBunks.forEach(function(bunk) {
            // Get or build the history for this bunk
            var history = _historyCache.has(bunk) ? _historyCache.get(bunk) : buildBunkActivityHistory(bunk);

            var cloudCounts = (cloudData.counts || {})[bunk] || {};
            var cloudLast = (cloudData.lastDone || {})[bunk] || {};
            var todayBunk = todayCloud[bunk] || {};

            // For each cloud activity, fill gaps the local scan may have missed
            var allActs = new Set(Object.keys(cloudCounts).concat(Object.keys(cloudLast)));
            allActs.forEach(function(act) {
                var actLower = act.toLowerCase().trim();
                var local = history.byActivity[actLower];
                var cloudCount = Math.max(0, (cloudCounts[act] || 0) - (todayBunk[act] || 0));
                var cloudLastDate = cloudLast[act] || null;

                if (!local) {
                    // Activity not seen in local 14-day scan — cloud fills the gap
                    var daysSince = null;
                    // ★ Only carry a recency (daysSinceLast) when the cloud actually has a
                    //   POSITIVE count. A stray lastDone date with a ZERO net count (e.g. the
                    //   occurrence was regenerated away but rotation_counts' lastDone wasn't
                    //   cleared) must NOT impose a daysSinceLast — otherwise getDaysSinceActivity
                    //   reports "done yesterday" for an activity getActivityCount says is 0, and
                    //   the frequencyDays cooldown wrongly blocks a never-done special (→ Swim).
                    if (cloudCount > 0 && cloudLastDate && cloudLastDate < today) {
                        daysSince = Math.max(1, Math.round((todayMs - new Date(cloudLastDate + 'T12:00:00').getTime()) / msPerDay));
                    }
                    history.byActivity[actLower] = {
                        dates: (daysSince !== null) ? [{ dateKey: cloudLastDate, daysAgo: daysSince }] : [],
                        count: cloudCount,
                        daysSinceLast: daysSince
                    };
                    if (cloudCount > 0) history.uniqueActivities.add(actLower);
                    history.totalActivities += cloudCount;
                    merged++;
                } else {
                    // Local exists but cloud may have a higher total (covers more dates)
                    if (cloudCount > local.count) {
                        history.totalActivities += (cloudCount - local.count);
                        local.count = cloudCount;
                    } else if (cloudCount < local.count && cloudLastDate) {
                        // ★★★ CB-62: cloud rotation_counts is the cumulative AUTHORITY.
                        // The merge previously only ever RAISED the local 14-day-scan
                        // count, so a cross-device delete/decrement (cloud total
                        // dropped) was silently ignored → stale-high counts forever.
                        // Lower to the cloud total, but ONLY when cloud is fully
                        // caught up: its last-done date is no older than local's most
                        // recent occurrence (cloudDays <= local.daysSinceLast). If
                        // local has a MORE recent occurrence than cloud knows about, it
                        // may be just-generated unsynced data, so keep the higher count.
                        var _cloudDays62 = Math.max(1, Math.round((todayMs - new Date(cloudLastDate + 'T12:00:00').getTime()) / msPerDay));
                        var _localRecent62 = (local.daysSinceLast == null) ? Infinity : local.daysSinceLast;
                        if (_cloudDays62 <= _localRecent62) {
                            history.totalActivities -= (local.count - cloudCount);
                            local.count = cloudCount;
                        }
                    }
                    // Cloud may have a more recent lastDone than local's 14-day window
                    if (cloudLastDate && cloudLastDate < today) {
                        var cloudDays = Math.max(1, Math.round((todayMs - new Date(cloudLastDate + 'T12:00:00').getTime()) / msPerDay));
                        if (local.daysSinceLast === null || cloudDays < local.daysSinceLast) {
                            local.daysSinceLast = cloudDays;
                        }
                    }
                }
            });

            _historyCache.set(bunk, history);
        });

        if (merged > 0) {
            console.log('[RotationEngine] Merged ' + merged + ' cloud-only activity records into history cache');
        }
        // ★ GenTrace: make the overlay visible in the brain trace so a future
        //   trace proves whether recency scoring had cloud history available.
        if (window.GenTrace && window.GenTrace.active) {
            window.GenTrace.event('rotation', 'cloud rotation overlay merged into history cache', { bunks: allBunks.size, newRecords: merged });
        }
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

    console.log('[RotationEngine] v2.4 loaded - Gotcha fixes: recency>novelty, balanced variety, streak cliff, coverage scaling');
})();
