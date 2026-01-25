// ============================================================================
// total_solver_engine.js (ENHANCED v9.0 - DELEGATES TO ROTATION ENGINE)
// Backtracking Constraint Solver + League Engine
// ----------------------------------------------------------------------------
// ★★★ NOW DELEGATES ALL ROTATION LOGIC TO rotation_engine.js ★★★
//
// The RotationEngine is the SINGLE SOURCE OF TRUTH for:
// - Activity history tracking
// - Recency/frequency/variety scoring
// - Streak detection
// - Distribution fairness
//
// This file handles:
// - Backtracking constraint solver
// - Block sorting and scheduling
// - Field availability and capacity
// - League game handling
// - Penalty cost calculation (delegates rotation to RotationEngine)
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;

    const DEBUG_MODE = false;
    const DEBUG_ROTATION = false;

    let globalConfig = null;
    let activityProperties = {};
    let allCandidateOptions = [];
    let fieldAvailabilityCache = {};

    // ============================================================================
    // ★★★ ROTATION CONFIG - DELEGATES TO ROTATION ENGINE ★★★
    // ============================================================================
    
    // Use RotationEngine.CONFIG as the single source of truth
    // This proxy provides fallback values if RotationEngine isn't loaded yet
    const ROTATION_CONFIG = new Proxy({}, {
        get: function(target, prop) {
            // Try to get from RotationEngine first
            if (window.RotationEngine?.CONFIG?.[prop] !== undefined) {
                return window.RotationEngine.CONFIG[prop];
            }
            // Fallback defaults (should match RotationEngine)
            const fallbacks = {
                SAME_DAY_PENALTY: Infinity,
                YESTERDAY_PENALTY: 12000,
                TWO_DAYS_AGO_PENALTY: 8000,
                THREE_DAYS_AGO_PENALTY: 5000,
                FOUR_DAYS_AGO_PENALTY: 3000,
                FIVE_DAYS_AGO_PENALTY: 1500,
                SIX_SEVEN_DAYS_PENALTY: 800,
                FOUR_TO_SEVEN_DAYS_PENALTY: 800,
                WEEK_PLUS_PENALTY: 200,
                HIGH_FREQUENCY_PENALTY: 3000,
                ABOVE_AVERAGE_PENALTY: 1200,
                NEVER_DONE_BONUS: -5000,
                UNDER_UTILIZED_BONUS: -2000,
                GOOD_VARIETY_BONUS: -400,
                RECENCY_WEIGHT: 1.0,
                FREQUENCY_WEIGHT: 1.0,
                VARIETY_WEIGHT: 1.2
            };
            return fallbacks[prop];
        }
    });

    // ============================================================================
    // HELPERS
    // ============================================================================

    function isSameActivity(a, b) {
        return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    }

    function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    function getBunkNumber(name) {
        const m = String(name).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    function debugLog(...args) {
        if (DEBUG_MODE) {
            console.log('[SOLVER DEBUG]', ...args);
        }
    }

    function rotationLog(...args) {
        if (DEBUG_ROTATION) {
            console.log('[ROTATION]', ...args);
        }
    }

    // ============================================================================
    // ★★★ DELEGATED ROTATION SCORING SYSTEM ★★★
    // All scoring now goes through window.RotationEngine
    // ============================================================================

    /**
     * Get all activities done by a bunk TODAY (before current slot)
     * Delegates to RotationEngine if available
     */
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
     * Get the last time a bunk did a specific activity (days ago)
     * Delegates to RotationEngine if available
     */
    function getDaysSinceActivity(bunkName, activityName, beforeSlotIndex) {
        if (window.RotationEngine?.getDaysSinceActivity) {
            return window.RotationEngine.getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        }
        // Fallback
        const actLower = (activityName || '').toLowerCase().trim();
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0;
        }
        const rotationHistory = globalConfig?.rotationHistory || window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName];
        if (!lastTimestamp) {
            const historicalCounts = globalConfig?.historicalCounts || {};
            if (historicalCounts[bunkName]?.[activityName] > 0) {
                return 14;
            }
            return null;
        }
        const now = Date.now();
        const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
        return Math.max(1, daysSince);
    }

    /**
     * Get total count of how many times a bunk has done an activity
     * Delegates to RotationEngine if available
     */
    function getActivityCount(bunkName, activityName) {
        if (window.RotationEngine?.getActivityCount) {
            return window.RotationEngine.getActivityCount(bunkName, activityName);
        }
        // Fallback
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalConfig?.historicalCounts || globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};
        const baseCount = historicalCounts[bunkName]?.[activityName] || 0;
        const offset = manualOffsets[bunkName]?.[activityName] || 0;
        return Math.max(0, baseCount + offset);
    }

    /**
     * Get all activity names from config
     */
    function getAllActivityNames() {
        if (window.RotationEngine?.getAllActivityNames) {
            return window.RotationEngine.getAllActivityNames();
        }
        // Fallback
        const names = new Set();
        globalConfig?.masterFields?.forEach(f => {
            (f.activities || []).forEach(sport => names.add(sport));
        });
        globalConfig?.masterSpecials?.forEach(s => {
            if (s.name) names.add(s.name);
        });
        if (activityProperties) {
            for (const name of Object.keys(activityProperties)) {
                if (name && name !== 'Free' && !name.includes('Transition')) {
                    names.add(name);
                }
            }
        }
        return [...names];
    }

    /**
     * ★★★ MASTER ROTATION SCORE CALCULATOR ★★★
     * Delegates to RotationEngine for all scoring
     * Returns total rotation penalty for an activity choice
     * LOWER IS BETTER, Infinity means blocked
     */
    function calculateRotationPenalty(bunkName, activityName, block) {
        if (!activityName || activityName === 'Free') return 0;

        const beforeSlotIndex = block.slots?.[0] || 0;

        // ★★★ DELEGATE TO ROTATION ENGINE ★★★
        if (window.RotationEngine?.calculateRotationScore) {
            const score = window.RotationEngine.calculateRotationScore({
                bunkName: bunkName,
                activityName: activityName,
                divisionName: block.divName || block.division,
                beforeSlotIndex: beforeSlotIndex,
                allActivities: null,  // RotationEngine will use getAllActivityNames()
                activityProperties: activityProperties
            });
            
            rotationLog(`${bunkName} - ${activityName}: RotationEngine score = ${score}`);
            return score;
        }

        // Fallback if RotationEngine not loaded
        console.warn('[SOLVER] RotationEngine not available, using basic scoring');
        
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = (activityName || '').toLowerCase().trim();
        
        if (todayActivities.has(actLower)) {
            rotationLog(`${bunkName} - ${activityName}: BLOCKED (same day)`);
            return Infinity;
        }
        
        const daysSince = getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        
        if (daysSince === null) {
            return ROTATION_CONFIG.NEVER_DONE_BONUS;
        }
        if (daysSince === 0) {
            return Infinity;
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
        
        return ROTATION_CONFIG.WEEK_PLUS_PENALTY;
    }

    // ============================================================================
    // PENALTY ENGINE (ENHANCED WITH DELEGATED ROTATION)
    // ============================================================================

    function calculatePenaltyCost(block, pick) {
        let penalty = 0;
        const bunk = block.bunk;
        const act = pick._activity;
        const fieldName = pick.field;

        // ★★★ SMART ROTATION PENALTY (via RotationEngine) ★★★
        const rotationPenalty = calculateRotationPenalty(bunk, act, block);

        if (rotationPenalty === Infinity) {
            return 999999; // Blocked by rotation rules
        }

        penalty += rotationPenalty;

        // Get bunk metadata
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        const mySize = bunkMeta[bunk]?.size || 0;

        // Sharing score (adjacent bunks bonus)
        const sharingScore = window.SchedulerCoreUtils?.calculateSharingScore?.(
            block,
            fieldName,
            window.fieldUsageBySlot,
            act
        ) || 0;

        penalty -= sharingScore;

        // Capacity and activity matching checks
        const schedules = window.scheduleAssignments || {};
        const slots = block.slots || [];

        for (const slotIdx of slots) {
            let fieldCount = 0;
            let existingActivities = new Set();
            let combinedSize = mySize;

            for (const [otherBunk, otherSlots] of Object.entries(schedules)) {
                if (otherBunk === bunk) continue;
                const entry = otherSlots?.[slotIdx];
                if (!entry) continue;

                const entryField = window.SchedulerCoreUtils?.fieldLabel(entry.field) || entry._activity;
                if (entryField && entryField.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                    fieldCount++;
                    combinedSize += (bunkMeta[otherBunk]?.size || 0);
                    if (entry._activity) {
                        existingActivities.add(entry._activity.toLowerCase().trim());
                    }
                }
            }

            const props = activityProperties[fieldName] || {};
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable || props.sharableWith?.type === "all") {
                maxCapacity = 2;
            }

            if (fieldCount >= maxCapacity) {
                return 999999;
            }

            if (fieldCount > 0 && existingActivities.size > 0) {
                const myActivity = (act || '').toLowerCase().trim();
                if (!existingActivities.has(myActivity)) {
                    return 888888;
                }
            }

            // Sport player requirements (soft constraints)
            if (act && !pick._isLeague) {
                const playerCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(act, combinedSize, false);

                if (playerCheck && !playerCheck.valid) {
                    if (playerCheck.severity === 'hard') {
                        penalty += 8000;
                    } else if (playerCheck.severity === 'soft') {
                        penalty += 1500;
                    }
                } else if (playerCheck && playerCheck.valid) {
                    penalty -= 500;
                }
            }
        }

        // Adjacent bunk bonus
        const myNum = getBunkNumber(bunk);
        if (myNum !== null) {
            for (const slotIdx of slots) {
                for (const [otherBunk, otherSlots] of Object.entries(schedules)) {
                    if (otherBunk === bunk) continue;
                    const entry = otherSlots?.[slotIdx];
                    if (!entry) continue;

                    const entryField = window.SchedulerCoreUtils?.fieldLabel(entry.field) || entry._activity;
                    if (entryField && entryField.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                        const otherNum = getBunkNumber(otherBunk);
                        if (otherNum !== null) {
                            const distance = Math.abs(myNum - otherNum);
                            penalty += (distance - 1) * 50;
                        }
                    }
                }
            }
        }

        // Usage limit check (for special activities with maxUsage)
        const specialRule = globalConfig.masterSpecials?.find(s => isSameActivity(s.name, act));
        if (specialRule && specialRule.maxUsage > 0) {
            const hist = getActivityCount(bunk, act);
            const todayCount = getActivitiesDoneToday(bunk, block.slots?.[0] || 999).has((act || '').toLowerCase().trim()) ? 1 : 0;
            if (hist + todayCount >= specialRule.maxUsage) penalty += 20000;
        }

        // Division preference
        const props = activityProperties[fieldName];
        if (props?.preferences?.enabled) {
            const idx = (props.preferences.list || []).indexOf(block.divName);
            if (idx !== -1) {
                penalty -= (50 - idx * 5);
            } else if (props.preferences.exclusive) {
                return 999999;
            } else {
                penalty += 2000;
            }
        }

        return penalty;
    }

    // ============================================================================
    // MAIN SOLVER
    // ============================================================================

    Solver.sortBlocksByDifficulty = function (blocks, config) {
        const meta = config.bunkMetaData || {};
        return blocks.sort((a, b) => {
            if (a._isLeague && !b._isLeague) return -1;
            if (!a._isLeague && b._isLeague) return 1;

            const numA = getBunkNumber(a.bunk) || Infinity;
            const numB = getBunkNumber(b.bunk) || Infinity;
            if (numA !== numB) return numA - numB;

            const sa = meta[a.bunk]?.size || 0;
            const sb = meta[b.bunk]?.size || 0;
            if (sa !== sb) return sb - sa;

            return 0;
        });
    };

    const KNOWN_SPORTS = new Set([
        'hockey', 'soccer', 'football', 'baseball', 'kickball', 'basketball',
        'lineup', 'running bases', 'newcomb', 'volleyball', 'dodgeball',
        'general activity slot', 'sports slot', 'special activity',
        'ga slot', 'sport slot', 'free', 'free play'
    ]);

    function isSportName(name) {
        if (!name) return false;
        return KNOWN_SPORTS.has(name.toLowerCase().trim());
    }

    /**
     * ★★★ BUILD CANDIDATE OPTIONS - WITH GLOBAL LOCK FILTERING ★★★
     */
    function buildAllCandidateOptions(config, blockSlots) {
        const options = [];
        const seenKeys = new Set();

        debugLog('=== BUILDING CANDIDATE OPTIONS ===');

        const disabledFields = window.currentDisabledFields || config.disabledFields || [];
        if (disabledFields.length > 0) {
            debugLog(`  Disabled fields: ${disabledFields.join(', ')}`);
        }

        // Source 1: masterFields with activities
        config.masterFields?.forEach(f => {
            if (disabledFields.includes(f.name)) {
                return;
            }

            (f.activities || []).forEach(sport => {
                if (window.GlobalFieldLocks && blockSlots && blockSlots.length > 0) {
                    const lockInfo = window.GlobalFieldLocks.isFieldLocked(f.name, blockSlots);
                    if (lockInfo) {
                        return;
                    }
                }

                const key = `${f.name}|${sport}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: f.name,
                        sport,
                        activityName: sport,
                        type: "sport"
                    });
                }
            });
        });

        // Source 2: masterSpecials
        config.masterSpecials?.forEach(s => {
            if (disabledFields.includes(s.name)) {
                return;
            }

            if (window.GlobalFieldLocks && blockSlots && blockSlots.length > 0) {
                const lockInfo = window.GlobalFieldLocks.isFieldLocked(s.name, blockSlots);
                if (lockInfo) {
                    return;
                }
            }

            const key = `${s.name}|special`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                options.push({
                    field: s.name,
                    sport: null,
                    activityName: s.name,
                    type: "special"
                });
            }
        });

        // Source 3: fieldsBySport
        const loadedData = window.SchedulerCoreUtils?.loadAndFilterData?.() || {};
        const fieldsBySport = loadedData.fieldsBySport || {};

        for (const [sport, fields] of Object.entries(fieldsBySport)) {
            (fields || []).forEach(fieldName => {
                if (isSportName(fieldName)) return;

                if (disabledFields.includes(fieldName)) {
                    return;
                }

                if (window.GlobalFieldLocks && blockSlots && blockSlots.length > 0) {
                    const lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, blockSlots);
                    if (lockInfo) {
                        return;
                    }
                }

                const key = `${fieldName}|${sport}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: fieldName,
                        sport,
                        activityName: sport,
                        type: "sport"
                    });
                }
            });
        }

        debugLog('=== TOTAL CANDIDATE OPTIONS:', options.length, '===');

        return options;
    }

    /**
     * ★★★ GET VALID PICKS - WITH DELEGATED ROTATION SCORING ★★★
     */
    Solver.getValidActivityPicks = function (block) {
        const picks = [];
        const slots = block.slots || [];
        const bunk = block.bunk;

        const disabledFields = window.currentDisabledFields || globalConfig.disabledFields || [];

        // Rebuild options for this specific block's slots
        const blockOptions = buildAllCandidateOptions(globalConfig, slots);

        for (const cand of blockOptions) {
            if (disabledFields.includes(cand.field)) {
                continue;
            }

            if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) {
                continue;
            }

            // ★★★ PRE-CHECK ROTATION - Skip activities done today ★★★
            const rotationPenalty = calculateRotationPenalty(bunk, cand.activityName, block);
            if (rotationPenalty === Infinity) {
                continue; // Skip - blocked by rotation
            }

            const fits = window.SchedulerCoreUtils.canBlockFit(
                block,
                cand.field,
                activityProperties,
                window.fieldUsageBySlot,
                cand.activityName,
                false
            );

            if (fits) {
                const pick = {
                    field: cand.field,
                    sport: cand.sport,
                    _activity: cand.activityName
                };
                const cost = calculatePenaltyCost(block, pick);

                if (cost < 500000) {
                    picks.push({ pick, cost });
                }
            }
        }

        if (picks.length === 0 && DEBUG_MODE) {
            console.log(`⚠️ NO VALID PICKS for ${block.bunk} at ${block.startTime}`);
        }

        // Free as fallback with very high penalty
        picks.push({
            pick: { field: "Free", sport: null, _activity: "Free" },
            cost: 100000
        });

        return picks;
    };

    Solver.applyTentativePick = function (block, scored) {
        const pick = scored.pick;
        window.fillBlock(block, pick, window.fieldUsageBySlot, globalConfig.yesterdayHistory, false, activityProperties);
        return { block, pick, bunk: block.bunk, startMin: block.startTime };
    };

    Solver.undoTentativePick = function (res) {
        const { bunk, block } = res;
        const slots = block.slots || [];

        if (window.scheduleAssignments[bunk]) {
            for (const slotIdx of slots) {
                delete window.scheduleAssignments[bunk][slotIdx];
            }
        }

        if (window.fieldUsageBySlot && res.pick) {
            const fieldName = res.pick.field;
            for (const slotIdx of slots) {
                if (window.fieldUsageBySlot[slotIdx]?.[fieldName]) {
                    const usage = window.fieldUsageBySlot[slotIdx][fieldName];
                    if (usage.bunks) {
                        delete usage.bunks[bunk];
                    }
                    if (usage.count > 0) {
                        usage.count--;
                    }
                }
            }
        }
    };

    Solver.solveSchedule = function (allBlocks, config) {
        globalConfig = config;
        activityProperties = config.activityProperties || {};
        let iterations = 0;
        const SAFETY_LIMIT = 100000;
        allCandidateOptions = buildAllCandidateOptions(config, []);

        if (allCandidateOptions.length === 0) {
            console.warn('[SOLVER] Warning: Limited candidate options available');
        }
        
        if (!window.leagueRoundState) window.leagueRoundState = {};
        if (!globalConfig.rotationHistory) globalConfig.rotationHistory = {};
        if (!globalConfig.rotationHistory.leagues) globalConfig.rotationHistory.leagues = {};
        
        const sorted = Solver.sortBlocksByDifficulty(allBlocks, config);
        const activityBlocks = sorted.filter(b => !b._isLeague);
        
        console.log(`[SOLVER] Processing ${activityBlocks.length} activity blocks`);
        console.log(`[SOLVER] ★ Using ${window.RotationEngine ? 'SUPERCHARGED RotationEngine v2.0' : 'FALLBACK scoring'}`);
        
        // Clear rotation cache for fresh scoring
        if (window.RotationEngine?.clearHistoryCache) {
            window.RotationEngine.clearHistoryCache();
        }
        
        let bestSchedule = [];
        let maxDepthReached = 0;

        function backtrack(idx, acc) {
            iterations++;
            if (idx > maxDepthReached) {
                maxDepthReached = idx;
                bestSchedule = [...acc];
            }
            if (idx === activityBlocks.length) return acc;
            if (iterations > SAFETY_LIMIT) {
                console.warn(`[SOLVER] Iteration limit ${SAFETY_LIMIT} hit.`);
                return null;
            }
            const block = activityBlocks[idx];

            const picks = Solver.getValidActivityPicks(block)
                .sort((a, b) => a.cost - b.cost)
                .slice(0, 15);
            for (const p of picks) {
                const res = Solver.applyTentativePick(block, p);
                const out = backtrack(idx + 1, [...acc, { block, solution: p.pick }]);
                if (out) return out;
                Solver.undoTentativePick(res);
            }
            return null;
        }
        
        const final = backtrack(0, []);
        
        if (final) {
            console.log(`[SOLVER] ✅ Solution found after ${iterations} iterations`);
            return final.map(a => ({
                bunk: a.block.bunk,
                divName: a.block.divName,
                startTime: a.block.startTime,
                endTime: a.block.endTime,
                solution: a.solution
            }));
        } else {
            console.warn("[SOLVER] ⚠️ Optimal solution not found. Using best partial.");
            const solvedBlocksSet = new Set(bestSchedule.map(s => s.block));
            const missingBlocks = activityBlocks.filter(b => !solvedBlocksSet.has(b));

            const fallback = [
                ...bestSchedule,
                ...missingBlocks.map(b => ({
                    block: b,
                    solution: { field: "Free", sport: null, _activity: "Free (Timeout)" }
                }))
            ];

            return fallback.map(a => ({
                bunk: a.block.bunk,
                divName: a.block.divName,
                startTime: a.block.startTime,
                endTime: a.block.endTime,
                solution: a.solution
            }));
        }
    };

    // ============================================================================
    // DEBUG UTILITIES
    // ============================================================================

    Solver.debugFieldAvailability = function(fieldName, slots) {
        console.log(`\n=== DEBUG: ${fieldName} AVAILABILITY ===`);

        if (window.GlobalFieldLocks) {
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, slots);
            if (lockInfo) {
                console.log(`🔒 GLOBALLY LOCKED by ${lockInfo.lockedBy}`);
                return false;
            } else {
                console.log('✅ Not globally locked');
            }
        }

        const props = activityProperties[fieldName];
        if (props) {
            console.log('Props:', props);
        } else {
            console.log('No activity properties found');
        }

        return true;
    };

    /**
     * ★★★ DEBUG: Rotation Analysis - Delegates to RotationEngine ★★★
     */
    Solver.debugBunkRotation = function(bunkName, slotIndex = 0) {
        if (window.RotationEngine?.debugBunkRotation) {
            window.RotationEngine.debugBunkRotation(bunkName, slotIndex);
        } else {
            console.log('\n' + '='.repeat(60));
            console.log(`ROTATION ANALYSIS: ${bunkName} (RotationEngine not loaded)`);
            console.log('='.repeat(60));

            const allActivities = getAllActivityNames();

            console.log('\nActivity History:');
            allActivities.forEach(act => {
                const count = getActivityCount(bunkName, act);
                const daysSince = getDaysSinceActivity(bunkName, act, 999);
                const daysStr = daysSince === null ? 'never' : (daysSince === 0 ? 'TODAY' : `${daysSince}d ago`);

                console.log(`  ${act}: count=${count}, last=${daysStr}`);
            });

            const todayActivities = getActivitiesDoneToday(bunkName, 999);
            console.log(`\nDone Today: ${[...todayActivities].join(', ') || 'none'}`);

            console.log('\n' + '='.repeat(60));
        }
    };

    /**
     * ★★★ DEBUG: Activity recommendations - Delegates to RotationEngine ★★★
     */
    Solver.debugActivityRecommendations = function(bunkName, slotIndex = 0) {
        if (window.RotationEngine?.debugBunkRotation) {
            // RotationEngine's debug includes recommendations
            window.RotationEngine.debugBunkRotation(bunkName, slotIndex);
        } else {
            console.log('\n' + '='.repeat(60));
            console.log(`ACTIVITY RECOMMENDATIONS: ${bunkName} @ slot ${slotIndex}`);
            console.log('='.repeat(60));

            const allActivities = getAllActivityNames();
            const fakeBlock = { bunk: bunkName, slots: [slotIndex], divName: 'Unknown' };

            const scored = allActivities.map(act => {
                const penalty = calculateRotationPenalty(bunkName, act, fakeBlock);
                return {
                    activity: act,
                    penalty,
                    allowed: penalty !== Infinity
                };
            });

            scored.sort((a, b) => a.penalty - b.penalty);

            console.log('\nRanked Activities (best to worst):');
            scored.slice(0, 15).forEach((item, i) => {
                const status = item.allowed ? '✅' : '❌';
                const penaltyStr = item.penalty === Infinity ? 'BLOCKED' : item.penalty.toFixed(0);
                console.log(`  ${i + 1}. ${status} ${item.activity}: ${penaltyStr}`);
            });

            const blocked = scored.filter(r => !r.allowed);
            if (blocked.length > 0) {
                console.log(`\nBlocked (${blocked.length}): ${blocked.map(b => b.activity).join(', ')}`);
            }

            console.log('\n' + '='.repeat(60));
        }
    };

    /**
     * Debug rotation config - shows current values from RotationEngine
     */
    Solver.debugRotationConfig = function() {
        if (window.RotationEngine?.debugConfig) {
            window.RotationEngine.debugConfig();
        } else {
            console.log('\n=== ROTATION CONFIG (Fallback Values) ===');
            console.log('Same Day:', ROTATION_CONFIG.SAME_DAY_PENALTY);
            console.log('Yesterday:', ROTATION_CONFIG.YESTERDAY_PENALTY);
            console.log('2 Days Ago:', ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY);
            console.log('3 Days Ago:', ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY);
            console.log('Never Done Bonus:', ROTATION_CONFIG.NEVER_DONE_BONUS);
            console.log('\n⚠️ RotationEngine not loaded - using fallback values');
        }
    };

    /**
     * Debug player requirements
     */
    Solver.debugPlayerRequirements = function() {
        const bunkMeta = window.getBunkMetaData?.() || {};
        const sportMeta = window.getSportMetaData?.() || {};

        console.log('\n=== PLAYER REQUIREMENTS DEBUG ===');
        console.log('\nBunk Sizes:');
        Object.entries(bunkMeta).forEach(([bunk, meta]) => {
            console.log(`  ${bunk}: ${meta.size || 0} players`);
        });

        console.log('\nSport Requirements:');
        Object.entries(sportMeta).forEach(([sport, meta]) => {
            const min = meta.minPlayers || 'none';
            const max = meta.maxPlayers || 'none';
            console.log(`  ${sport}: min=${min}, max=${max}`);
        });
    };

    // ============================================================================
    // EXPOSE GLOBALLY
    // ============================================================================

    window.totalSolverEngine = Solver;

    // Expose debug utilities (delegate to RotationEngine when available)
    window.debugBunkRotation = Solver.debugBunkRotation;
    window.debugActivityRecommendations = Solver.debugActivityRecommendations;
    window.debugRotationConfig = Solver.debugRotationConfig;

    console.log('[SOLVER] v9.0 loaded - ★ DELEGATES TO RotationEngine ★');

})();
