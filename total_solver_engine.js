// ============================================================================
// total_solver_engine.js (ENHANCED v8 - SMART ROTATION INTEGRATION)
// Backtracking Constraint Solver + League Engine
// ----------------------------------------------------------------------------
// MAJOR UPDATE: Smart Activity Rotation System
// - Tracks detailed activity history (when each bunk last did each activity)
// - Calculates "staleness scores" - prioritizes activities bunks haven't done
// - Enforces variety - strong penalties for repeating, bonuses for variety
// - Balances distribution - ensures fair access across all bunks
//
// SCORING PHILOSOPHY:
// - Lower penalty = BETTER
// - Same day repeat = BLOCKED (Infinity)
// - Yesterday repeat = Heavy penalty (+5000)
// - Recent repeat (2-3 days) = Moderate penalty (+2000-3000)
// - Never done before = BONUS (-1500)
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;
    
    const DEBUG_MODE = false;
    const DEBUG_ROTATION = false; // Set to true to see rotation scoring

    let globalConfig = null;
    let activityProperties = {};
    let allCandidateOptions = [];
    let fieldAvailabilityCache = {};

    // ============================================================================
    // ROTATION CONFIGURATION
    // ============================================================================
    const ROTATION_CONFIG = {
        // Hard rules
        SAME_DAY_PENALTY: Infinity,           // NEVER allow same activity twice in one day
        
        // Recency penalties (days ago)
        YESTERDAY_PENALTY: 5000,              // Did it yesterday
        TWO_DAYS_AGO_PENALTY: 3000,           // Did it 2 days ago
        THREE_DAYS_AGO_PENALTY: 2000,         // Did it 3 days ago
        FOUR_TO_SEVEN_DAYS_PENALTY: 800,      // Did it 4-7 days ago
        WEEK_PLUS_PENALTY: 200,               // Did it more than a week ago
        
        // Frequency penalties
        HIGH_FREQUENCY_PENALTY: 1500,         // Bunk has done this much more than others
        ABOVE_AVERAGE_PENALTY: 500,           // Bunk has done this more than average
        
        // Variety bonuses (negative = good)
        NEVER_DONE_BONUS: -1500,              // Bunk has NEVER done this activity
        UNDER_UTILIZED_BONUS: -800,           // Activity is under-utilized by this bunk
        GOOD_VARIETY_BONUS: -300,             // General variety bonus
        
        // Weights
        RECENCY_WEIGHT: 1.0,
        FREQUENCY_WEIGHT: 0.8,
        VARIETY_WEIGHT: 1.2
    };

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
    // ★★★ SMART ROTATION SCORING SYSTEM ★★★
    // ============================================================================

    /**
     * Get all activities done by a bunk TODAY (before current slot)
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
     * Get the last time a bunk did a specific activity (days ago)
     * Returns null if never done, 0 if done today, 1 if yesterday, etc.
     */
    function getDaysSinceActivity(bunkName, activityName, beforeSlotIndex) {
        const actLower = activityName.toLowerCase().trim();
        
        // Check today first
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        if (todayActivities.has(actLower)) {
            return 0; // Done today
        }
        
        // Check rotation history
        const rotationHistory = globalConfig?.rotationHistory || window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunkName] || {};
        const lastTimestamp = bunkHistory[activityName];
        
        if (!lastTimestamp) {
            // Check historical counts - if count > 0, they've done it but we don't know when
            const historicalCounts = globalConfig?.historicalCounts || {};
            if (historicalCounts[bunkName]?.[activityName] > 0) {
                return 14; // Assume 2 weeks ago if we have count but no timestamp
            }
            return null; // Never done
        }
        
        const now = Date.now();
        const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
        return Math.max(1, daysSince); // At least 1 day if it's in history
    }

    /**
     * Get total count of how many times a bunk has done an activity
     */
    function getActivityCount(bunkName, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalConfig?.historicalCounts || globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};
        
        const baseCount = historicalCounts[bunkName]?.[activityName] || 0;
        const offset = manualOffsets[bunkName]?.[activityName] || 0;
        
        return Math.max(0, baseCount + offset);
    }

    /**
     * Get average activity count for a bunk across all activities
     */
    function getBunkAverageActivityCount(bunkName, allActivities) {
        if (!allActivities || allActivities.length === 0) return 0;
        
        let total = 0;
        for (const act of allActivities) {
            total += getActivityCount(bunkName, act);
        }
        
        return total / allActivities.length;
    }

    /**
     * Calculate RECENCY penalty - how recently did they do this?
     * Higher = worse (more recent = higher penalty)
     */
    function calculateRecencyPenalty(bunkName, activityName, beforeSlotIndex) {
        const daysSince = getDaysSinceActivity(bunkName, activityName, beforeSlotIndex);
        
        if (daysSince === null) {
            // Never done - this is GREAT!
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
        
        // More than a week ago - small penalty that decreases over time
        const weeksAgo = Math.floor(daysSince / 7);
        return Math.max(50, ROTATION_CONFIG.WEEK_PLUS_PENALTY * Math.pow(0.7, weeksAgo));
    }

    /**
     * Calculate FREQUENCY penalty - how often have they done this compared to others?
     */
    function calculateFrequencyPenalty(bunkName, activityName) {
        // Get all activities for comparison
        const allActivities = getAllActivityNames();
        if (allActivities.length === 0) return 0;
        
        const count = getActivityCount(bunkName, activityName);
        const average = getBunkAverageActivityCount(bunkName, allActivities);
        const deviation = count - average;
        
        if (deviation <= -2) {
            // Significantly under-utilized - bonus!
            return ROTATION_CONFIG.UNDER_UTILIZED_BONUS;
        }
        
        if (deviation < 0) {
            // Slightly under-utilized
            return ROTATION_CONFIG.GOOD_VARIETY_BONUS;
        }
        
        if (deviation === 0) {
            // Average usage
            return 0;
        }
        
        if (deviation <= 2) {
            // Slightly over-used
            return ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        }
        
        // Significantly over-used
        return ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY + (deviation - 2) * 200;
    }

    /**
     * Calculate VARIETY penalty - how much variety does this add to today?
     */
    function calculateVarietyPenalty(bunkName, activityName, beforeSlotIndex) {
        const todayActivities = getActivitiesDoneToday(bunkName, beforeSlotIndex);
        const actLower = activityName.toLowerCase().trim();
        
        // Already done today - FORBIDDEN
        if (todayActivities.has(actLower)) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        }
        
        // Check activity type balance (sports vs specials)
        const globalSettings = window.loadGlobalSettings?.() || {};
        const specialNames = new Set(
            (globalSettings.app1?.specialActivities || []).map(s => s.name.toLowerCase().trim())
        );
        
        let todaySports = 0;
        let todaySpecials = 0;
        
        for (const act of todayActivities) {
            if (specialNames.has(act)) {
                todaySpecials++;
            } else {
                todaySports++;
            }
        }
        
        const isSpecial = specialNames.has(actLower);
        
        // Bonus if this balances the day's activities
        if (isSpecial && todaySports > todaySpecials) {
            return -200; // Bonus for adding a special when they've done more sports
        }
        
        if (!isSpecial && todaySpecials > todaySports) {
            return -200; // Bonus for adding a sport when they've done more specials
        }
        
        // General variety bonus based on unique activities today
        const uniqueToday = todayActivities.size;
        return -50 * uniqueToday; // More bonus for early variety
    }

    /**
     * Get all activity names from config
     */
    function getAllActivityNames() {
        const names = new Set();
        
        // From masterFields
        globalConfig?.masterFields?.forEach(f => {
            (f.activities || []).forEach(sport => names.add(sport));
        });
        
        // From masterSpecials
        globalConfig?.masterSpecials?.forEach(s => {
            if (s.name) names.add(s.name);
        });
        
        // From activityProperties
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
     * Returns total rotation penalty for an activity choice
     * LOWER IS BETTER, Infinity means blocked
     */
    function calculateRotationPenalty(bunkName, activityName, block) {
        if (!activityName || activityName === 'Free') return 0;
        
        const beforeSlotIndex = block.slots?.[0] || 0;
        
        // Calculate individual penalties
        const recencyPenalty = calculateRecencyPenalty(bunkName, activityName, beforeSlotIndex);
        
        // If recency returns Infinity (same day), stop immediately
        if (recencyPenalty === Infinity || recencyPenalty === ROTATION_CONFIG.SAME_DAY_PENALTY) {
            rotationLog(`${bunkName} - ${activityName}: BLOCKED (same day)`);
            return Infinity;
        }
        
        const frequencyPenalty = calculateFrequencyPenalty(bunkName, activityName);
        const varietyPenalty = calculateVarietyPenalty(bunkName, activityName, beforeSlotIndex);
        
        // If variety returns Infinity, stop
        if (varietyPenalty === Infinity) {
            rotationLog(`${bunkName} - ${activityName}: BLOCKED (variety check)`);
            return Infinity;
        }
        
        // Combine penalties with weights
        const totalPenalty = (
            recencyPenalty * ROTATION_CONFIG.RECENCY_WEIGHT +
            frequencyPenalty * ROTATION_CONFIG.FREQUENCY_WEIGHT +
            varietyPenalty * ROTATION_CONFIG.VARIETY_WEIGHT
        );
        
        rotationLog(`${bunkName} - ${activityName}: recency=${recencyPenalty}, freq=${frequencyPenalty}, variety=${varietyPenalty}, TOTAL=${totalPenalty}`);
        
        return totalPenalty;
    }

    // ============================================================================
    // PENALTY ENGINE (ENHANCED WITH SMART ROTATION)
    // ============================================================================

    function calculatePenaltyCost(block, pick) {
        let penalty = 0;
        const bunk = block.bunk;
        const act = pick._activity;
        const fieldName = pick.field;

        // ★★★ SMART ROTATION PENALTY (PRIMARY FACTOR) ★★★
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
            const hist = globalConfig.historicalCounts?.[bunk]?.[act] || 0;
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
     * ★★★ GET VALID PICKS - WITH SMART ROTATION SCORING ★★★
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

        console.log(`[SOLVER] Processing ${activityBlocks.length} activity blocks with SMART ROTATION`);

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
            console.log(`[SOLVER] Solution found after ${iterations} iterations`);
            return final.map(a => ({ 
                bunk: a.block.bunk, 
                divName: a.block.divName, 
                startTime: a.block.startTime, 
                endTime: a.block.endTime, 
                solution: a.solution 
            }));
        } else {
            console.warn("[SOLVER] Optimal solution not found. Using best partial.");
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
     * ★★★ DEBUG: Rotation Analysis for a bunk ★★★
     */
    Solver.debugBunkRotation = function(bunkName) {
        console.log('\n' + '='.repeat(60));
        console.log(`ROTATION ANALYSIS: ${bunkName}`);
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
    };

    /**
     * ★★★ DEBUG: Activity recommendations for a bunk ★★★
     */
    Solver.debugActivityRecommendations = function(bunkName, slotIndex = 0) {
        console.log('\n' + '='.repeat(60));
        console.log(`ACTIVITY RECOMMENDATIONS: ${bunkName} @ slot ${slotIndex}`);
        console.log('='.repeat(60));
        
        const allActivities = getAllActivityNames();
        const fakeBlock = { bunk: bunkName, slots: [slotIndex] };
        
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

    // Expose globally
    window.totalSolverEngine = Solver;
    
    // Also expose rotation debug utilities
    window.debugBunkRotation = Solver.debugBunkRotation;
    window.debugActivityRecommendations = Solver.debugActivityRecommendations;

})();
