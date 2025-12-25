// ============================================================================
// total_solver_engine.js (FIXED v7 - SPORT PLAYER REQUIREMENTS + DISABLED FIELDS)
// Backtracking Constraint Solver + League Engine
// ----------------------------------------------------------------------------
// CRITICAL UPDATE:
// - ALL candidate options are filtered against GlobalFieldLocks
// - Locked fields are completely excluded from consideration
// - NEW: Player count requirements are soft constraints with penalties
// - This ensures NO field double-booking across divisions
// - PATCH 3: Filters disabled fields (rainy day/manual overrides)
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;
    
    const DEBUG_MODE = false;

    let globalConfig = null;
    let activityProperties = {};
    let allCandidateOptions = [];
    let fieldAvailabilityCache = {};

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

    // ============================================================================
    // PENALTY ENGINE (WITH PLAYER COUNT REQUIREMENTS)
    // ============================================================================

    function calculatePenaltyCost(block, pick) {
        let penalty = 0;
        const bunk = block.bunk;
        const act = pick._activity;
        const fieldName = pick.field;

        // Get bunk metadata
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        const mySize = bunkMeta[bunk]?.size || 0;

        const sharingScore = window.SchedulerCoreUtils?.calculateSharingScore?.(
            block, 
            fieldName, 
            window.fieldUsageBySlot, 
            act
        ) || 0;
        
        penalty -= sharingScore;

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

            // =================================================================
            // SPORT PLAYER REQUIREMENTS PENALTY (NEW!)
            // =================================================================
            if (act && !pick._isLeague) {
                const playerCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(act, combinedSize, false);
                
                if (playerCheck && !playerCheck.valid) {
                    if (playerCheck.severity === 'hard') {
                        // Heavy penalty but NOT a rejection - we prefer this over "Free"
                        penalty += 8000;
                        debugLog(`[PENALTY] ${bunk} - ${act}: HARD player violation (${combinedSize} players), penalty +8000`);
                    } else if (playerCheck.severity === 'soft') {
                        // Moderate penalty for slightly off
                        penalty += 1500;
                        debugLog(`[PENALTY] ${bunk} - ${act}: SOFT player violation (${combinedSize} players), penalty +1500`);
                    }
                } else if (playerCheck && playerCheck.valid) {
                    // BONUS for meeting player requirements!
                    penalty -= 500;
                    debugLog(`[PENALTY] ${bunk} - ${act}: Player count GOOD (${combinedSize} players), bonus -500`);
                }
            }
        }

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

        const today = window.scheduleAssignments[bunk] || {};
        let todayCount = 0;
        for (const e of Object.values(today)) {
            if (!e) continue;
            const existing = e._activity || e.activity || e.field;
            if (isSameActivity(existing, act)) {
                todayCount++;
            }
        }
        if (!pick._isLeague && todayCount >= 1) penalty += 15000;

        const specialRule = globalConfig.masterSpecials?.find(s => isSameActivity(s.name, act));
        if (specialRule && specialRule.maxUsage > 0) {
            const hist = globalConfig.historicalCounts?.[bunk]?.[act] || 0;
            if (hist + todayCount >= specialRule.maxUsage) penalty += 20000;
        }

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
        
        // ★★★ Get disabled fields (rainy day, manual overrides, etc) ★★★
        const disabledFields = window.currentDisabledFields || config.disabledFields || [];
        if (disabledFields.length > 0) {
            debugLog(`  Disabled fields: ${disabledFields.join(', ')}`);
        }
        
        // Source 1: masterFields with activities
        config.masterFields?.forEach(f => {
            // ★★★ CHECK IF FIELD IS DISABLED (RAINY DAY, ETC) ★★★
            if (disabledFields.includes(f.name)) {
                debugLog(`  SKIPPING ${f.name} - field is DISABLED`);
                return;
            }
            
            (f.activities || []).forEach(sport => {
                // ★★★ CHECK IF FIELD IS GLOBALLY LOCKED ★★★
                if (window.GlobalFieldLocks && blockSlots && blockSlots.length > 0) {
                    const lockInfo = window.GlobalFieldLocks.isFieldLocked(f.name, blockSlots);
                    if (lockInfo) {
                        debugLog(`  SKIPPING ${f.name} - locked by ${lockInfo.lockedBy}`);
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
            // ★★★ CHECK IF SPECIAL IS DISABLED ★★★
            if (disabledFields.includes(s.name)) {
                debugLog(`  SKIPPING ${s.name} - special is DISABLED`);
                return;
            }
            
            // ★★★ CHECK IF SPECIAL IS GLOBALLY LOCKED ★★★
            if (window.GlobalFieldLocks && blockSlots && blockSlots.length > 0) {
                const lockInfo = window.GlobalFieldLocks.isFieldLocked(s.name, blockSlots);
                if (lockInfo) {
                    debugLog(`  SKIPPING ${s.name} - locked by ${lockInfo.lockedBy}`);
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
                
                // ★★★ CHECK IF FIELD IS DISABLED (RAINY DAY, ETC) ★★★
                if (disabledFields.includes(fieldName)) {
                    debugLog(`  SKIPPING ${fieldName} - field is DISABLED`);
                    return;
                }
                
                // ★★★ CHECK IF FIELD IS GLOBALLY LOCKED ★★★
                if (window.GlobalFieldLocks && blockSlots && blockSlots.length > 0) {
                    const lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, blockSlots);
                    if (lockInfo) {
                        debugLog(`  SKIPPING ${fieldName} - locked by ${lockInfo.lockedBy}`);
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
     * ★★★ GET VALID PICKS - RESPECTS GLOBAL LOCKS + PLAYER REQUIREMENTS ★★★
     */
    Solver.getValidActivityPicks = function (block) {
        const picks = [];
        const slots = block.slots || [];
        
        // ★★★ Get disabled fields ★★★
        const disabledFields = window.currentDisabledFields || globalConfig.disabledFields || [];
        
        // Rebuild options for this specific block's slots (filters out locked fields)
        const blockOptions = buildAllCandidateOptions(globalConfig, slots);
        
        for (const cand of blockOptions) {
            // ★★★ CHECK IF FIELD IS DISABLED ★★★
            if (disabledFields.includes(cand.field)) {
                continue;
            }
            
            // Double-check global lock (shouldn't be needed but safety first)
            if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) {
                continue;
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
                
                // Allow picks with higher penalties (soft constraints)
                // Only reject if cost is astronomical (hard constraints)
                if (cost < 500000) {
                    picks.push({ pick, cost });
                }
            }
        }
        
        if (picks.length === 0 && DEBUG_MODE) {
            console.log(`⚠️ NO VALID PICKS for ${block.bunk} at ${block.startTime}`);
        }
        
        // Always have Free as fallback - but with VERY high penalty
        // This ensures we prefer even bad sports matches over Free
        picks.push({ 
            pick: { field: "Free", sport: null, _activity: "Free" }, 
            cost: 100000  // High but not impossible
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

        // Build initial candidate options (will be rebuilt per-block with lock filtering)
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
                .slice(0, 15); // Increased from 10 to consider more options

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
        
        // Check global lock
        if (window.GlobalFieldLocks) {
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, slots);
            if (lockInfo) {
                console.log(`🔒 GLOBALLY LOCKED by ${lockInfo.lockedBy} (${lockInfo.leagueName || lockInfo.activity})`);
                return false;
            } else {
                console.log('✅ Not globally locked');
            }
        }
        
        // Check activity properties
        const props = activityProperties[fieldName];
        if (props) {
            console.log('Props:', props);
        } else {
            console.log('No activity properties found');
        }
        
        return true;
    };

    /**
     * Debug utility: Analyze player requirements impact
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
        
        console.log('\nViability Analysis:');
        const bunks = Object.keys(bunkMeta);
        Object.entries(sportMeta).forEach(([sport, meta]) => {
            if (meta.minPlayers || meta.maxPlayers) {
                console.log(`\n  ${sport} (min: ${meta.minPlayers || 'n/a'}, max: ${meta.maxPlayers || 'n/a'}):`);
                
                // Check solo play
                bunks.forEach(bunk => {
                    const size = bunkMeta[bunk]?.size || 0;
                    const check = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(sport, size, false);
                    if (check && !check.valid) {
                        console.log(`    ${bunk} (${size}): ${check.severity} - ${check.reason}`);
                    }
                });
                
                // Check pairs
                console.log('    Viable pairs:');
                for (let i = 0; i < bunks.length; i++) {
                    for (let j = i + 1; j < bunks.length; j++) {
                        const combined = (bunkMeta[bunks[i]]?.size || 0) + (bunkMeta[bunks[j]]?.size || 0);
                        const check = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(sport, combined, false);
                        if (check && check.valid) {
                            console.log(`      ${bunks[i]} + ${bunks[j]} = ${combined} ✅`);
                        }
                    }
                }
            }
        });
    };

    window.totalSolverEngine = Solver;

})();
