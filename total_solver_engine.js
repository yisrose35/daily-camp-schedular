
// ============================================================================
// total_solver_engine.js (FIXED v4)
// Backtracking Constraint Solver + League Engine
// ----------------------------------------------------------------------------
// FIXES:
// 1. DON'T add sports as fields (Hockey:Hockey is wrong!)
// 2. Better rejection reason logging
// 3. Adjacent bunk preference
// 4. Same activity requirement when sharing
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;
    
    // DEBUG MODE - Set to true to see why fields are rejected
    const DEBUG_MODE = true;

    // Runtime globals
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

    // ============================================================================
    // DEBUG LOGGING
    // ============================================================================
    
    function debugLog(...args) {
        if (DEBUG_MODE) {
            console.log('[SOLVER DEBUG]', ...args);
        }
    }

    // ============================================================================
    // PENALTY ENGINE
    // ============================================================================

    function calculatePenaltyCost(block, pick) {
        let penalty = 0;
        const bunk = block.bunk;
        const act = pick._activity;
        const fieldName = pick.field;

        // Use sharing score from Utils
        const sharingScore = window.SchedulerCoreUtils?.calculateSharingScore?.(
            block, 
            fieldName, 
            window.fieldUsageBySlot, 
            act
        ) || 0;
        
        penalty -= sharingScore;

        // Check capacity and activity matching
        const schedules = window.scheduleAssignments || {};
        const slots = block.slots || [];
        
        for (const slotIdx of slots) {
            let fieldCount = 0;
            let existingActivities = new Set();
            
            for (const [otherBunk, otherSlots] of Object.entries(schedules)) {
                if (otherBunk === bunk) continue;
                const entry = otherSlots?.[slotIdx];
                if (!entry) continue;
                
                const entryField = window.SchedulerCoreUtils?.fieldLabel(entry.field) || entry._activity;
                if (entryField && entryField.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                    fieldCount++;
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

        // No double activity
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

        // Special max usage
        const specialRule = globalConfig.masterSpecials?.find(s => isSameActivity(s.name, act));
        if (specialRule && specialRule.maxUsage > 0) {
            const hist = globalConfig.historicalCounts?.[bunk]?.[act] || 0;
            if (hist + todayCount >= specialRule.maxUsage) penalty += 20000;
        }

        // Field preferences
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
    // LEAGUE ENGINE
    // ============================================================================

    function getMatchupHistory(teamA, teamB, leagueName) {
        const hist = globalConfig.rotationHistory?.leagues || {};
        const key = [teamA, teamB].sort().join("|");
        const leagueKey = `${leagueName}|${key}`;
        const played = hist[leagueKey] || [];
        const sportCounts = {};
        for (const g of played) {
            sportCounts[g.sport] = (sportCounts[g.sport] || 0) + 1;
        }
        return { playCount: played.length, sportCounts };
    }

    function buildFieldConstraintCache(block, leagueSports) {
        const cache = {};
        for (const sport of leagueSports) {
            cache[sport] = [];
            const potentials = allCandidateOptions.filter(c => c.type === "sport" && isSameActivity(c.sport, sport));
            for (const cand of potentials) {
                const fits = window.SchedulerCoreUtils.canBlockFit(
                    block, cand.field, activityProperties, window.fieldUsageBySlot, cand.activityName, false
                );
                if (fits) cache[sport].push(cand.field);
            }
        }
        return cache;
    }

    function findOptimalSchedule(cands, current) {
        if (cands.length === 0) return current;
        if (current.length * 2 === globalConfig._totalLeagueTeams) return current;

        let best = null;
        let maxMatches = current.length;
        let iterations = 0;

        cands.sort((a, b) => {
            if (a.playCount !== b.playCount) return a.playCount - b.playCount;
            return Math.random() - 0.5;
        });

        const backtrack = (idx, cur) => {
            iterations++;
            if (iterations > MAX_MATCHUP_ITERATIONS) return;
            if (cur.length * 2 === globalConfig._totalLeagueTeams) {
                if (cur.length > maxMatches) { maxMatches = cur.length; best = cur; }
                return;
            }
            if (idx === cands.length) {
                if (cur.length > maxMatches) { maxMatches = cur.length; best = cur; }
                return;
            }

            const cand = cands[idx];
            const available = !cur.some(m =>
                m.t1 === cand.t1 || m.t1 === cand.t2 ||
                m.t2 === cand.t1 || m.t2 === cand.t2 ||
                m.field === cand.field
            );

            if (available) backtrack(idx + 1, [...cur, cand]);
            backtrack(idx + 1, cur);
        };

        backtrack(0, []);
        return best || [];
    }

    Solver.generateDailyMatchups = function (league, repBlock) {
        const teams = league.teams || [];
        if (teams.length < 2) return [];

        const allPairs = [];
        let minPlay = Infinity;

        for (let i = 0; i < teams.length; i++) {
            for (let j = i + 1; j < teams.length; j++) {
                const hist = getMatchupHistory(teams[i], teams[j], league.name);
                allPairs.push({
                    t1: teams[i], t2: teams[j],
                    playCount: hist.playCount, sportCounts: hist.sportCounts
                });
                minPlay = Math.min(minPlay, hist.playCount);
            }
        }

        globalConfig._totalLeagueTeams = teams.length;
        let candidates = allPairs.filter(p => p.playCount === minPlay);
        const leagueSports = league.sports || ["General Sport"];
        fieldAvailabilityCache = buildFieldConstraintCache(repBlock, leagueSports);

        const viable = [];
        for (const p of candidates) {
            let minSC = Infinity;
            for (const sport of leagueSports) {
                const c = p.sportCounts[sport] || 0;
                minSC = Math.min(minSC, c);
            }
            const validSports = leagueSports.filter(s => (p.sportCounts[s] || 0) === minSC && fieldAvailabilityCache[s] && fieldAvailabilityCache[s].length > 0);
            
            shuffleArray(validSports);
            for (const sport of validSports) {
                const fields = fieldAvailabilityCache[sport];
                shuffleArray(fields);
                for (const f of fields) {
                    viable.push({
                        t1: p.t1, t2: p.t2, playCount: p.playCount, sport: sport, field: f
                    });
                    if (viable.length > 50) break;
                }
            }
        }
        shuffleArray(viable);
        return findOptimalSchedule(viable, []);
    };

    Solver.solveLeagueSchedule = function (leagueBlocks) {
        if (!leagueBlocks?.length) return [];
        const output = [];
        const bucket = {};

        for (const b of leagueBlocks) {
            const key = `${b.divName}_${b.startTime}`;
            if (!bucket[key]) bucket[key] = [];
            bucket[key].push(b);
        }

        for (const key in bucket) {
            const blocks = bucket[key];
            const rep = blocks[0];
            const league = globalConfig.masterLeagues
                ? Object.values(globalConfig.masterLeagues).find(l => l.enabled && l.divisions?.includes(rep.divName))
                : null;

            if (!league) continue;

            const matches = Solver.generateDailyMatchups(league, rep);
            if (!matches.length) continue;

            const tier = matches[0].playCount;
            const gameLabel = `Round ${tier + 1}`;
            
            for (const b of blocks) {
                const myMatch = matches.find(m => m.t1 === b.bunk || m.t2 === b.bunk);
                if (!myMatch) continue;

                const opponent = (myMatch.t1 === b.bunk) ? myMatch.t2 : myMatch.t1;
                const pick = {
                    field: myMatch.field,
                    sport: myMatch.sport,
                    _activity: `vs ${opponent} (${myMatch.sport})`,
                    _isLeague: true,
                    _gameLabel: gameLabel
                };

                window.fillBlock(b, pick, window.fieldUsageBySlot, globalConfig.yesterdayHistory, true, activityProperties);
                output.push({ block: b, solution: pick });
            }
        }
        return output;
    };

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

    /**
     * Known sport names - these should NOT be treated as fields
     */
    const KNOWN_SPORTS = new Set([
        'hockey', 'soccer', 'football', 'baseball', 'kickball', 'basketball',
        'lineup', 'running bases', 'newcomb', 'volleyball', 'dodgeball',
        'general activity slot', 'sports slot', 'special activity',
        'ga slot', 'sport slot', 'free', 'free play'
    ]);

    /**
     * Check if something is a sport name (not a field)
     */
    function isSportName(name) {
        if (!name) return false;
        return KNOWN_SPORTS.has(name.toLowerCase().trim());
    }

    /**
     * Build all candidate options from multiple sources
     * FIXED: Don't add sports as fields!
     */
    function buildAllCandidateOptions(config) {
        const options = [];
        const seenKeys = new Set();
        
        debugLog('=== BUILDING CANDIDATE OPTIONS ===');
        debugLog('masterFields:', config.masterFields?.length || 0);
        
        // Source 1: masterFields with activities (PRIMARY SOURCE)
        config.masterFields?.forEach(f => {
            debugLog(`  Field: ${f.name}, activities:`, f.activities);
            (f.activities || []).forEach(sport => {
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
        debugLog('masterSpecials:', config.masterSpecials?.length || 0);
        config.masterSpecials?.forEach(s => {
            debugLog(`  Special: ${s.name}`);
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
        
        // Source 3: fieldsBySport from loadAndFilterData
        const loadedData = window.SchedulerCoreUtils?.loadAndFilterData?.() || {};
        const fieldsBySport = loadedData.fieldsBySport || {};
        
        debugLog('fieldsBySport:', Object.keys(fieldsBySport));
        for (const [sport, fields] of Object.entries(fieldsBySport)) {
            (fields || []).forEach(fieldName => {
                // Skip if this "field" is actually a sport name
                if (isSportName(fieldName)) {
                    debugLog(`  SKIPPING sport-as-field: ${fieldName}`);
                    return;
                }
                
                const key = `${fieldName}|${sport}`;
                if (!seenKeys.has(key)) {
                    debugLog(`  Adding from fieldsBySport: ${fieldName} -> ${sport}`);
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
        
        // DO NOT add activityProperties entries as fields - they're often sports not fields!
        // The masterFields is the authoritative source for field->activity mappings
        
        debugLog('=== TOTAL CANDIDATE OPTIONS:', options.length, '===');
        debugLog('Options:', options.map(o => `${o.field}:${o.activityName}`).join(', '));
        
        return options;
    }

    /**
     * Debug why a specific field is rejected for a block
     */
    function debugRejection(block, fieldName, actName) {
        const props = activityProperties[fieldName];
        
        // Check block validity first
        if (!block.startTime && !block.slots?.length) {
            return `Block has no startTime or slots`;
        }
        
        // Check if slots can be found
        const slots = block.slots?.length ? block.slots : 
            window.SchedulerCoreUtils?.findSlotsForRange(block.startTime, block.endTime);
        if (!slots || slots.length === 0) {
            return `No slots found for time ${block.startTime}-${block.endTime}`;
        }
        
        if (!props) {
            return `No activityProperties for "${fieldName}"`;
        }
        
        if (props.available === false) {
            return `Field marked unavailable`;
        }
        
        // Check time rules
        if (props.timeRules && props.timeRules.length > 0) {
            const blockStart = block.startTime;
            const blockEnd = block.endTime;
            
            // Check if any Available rule covers this time
            const availableRules = props.timeRules.filter(r => r.type === "Available");
            if (availableRules.length > 0) {
                let covered = false;
                for (const rule of availableRules) {
                    const ruleStart = window.SchedulerCoreUtils?.parseTimeToMinutes(rule.start) || rule.startMin;
                    const ruleEnd = window.SchedulerCoreUtils?.parseTimeToMinutes(rule.end) || rule.endMin;
                    if (blockStart >= ruleStart && blockEnd <= ruleEnd) {
                        covered = true;
                        break;
                    }
                }
                if (!covered) {
                    return `Time ${blockStart}-${blockEnd} not in Available rules (${availableRules.map(r => `${r.start || r.startMin}-${r.end || r.endMin}`).join(', ')})`;
                }
            }
            
            // Check Unavailable rules
            const unavailableRules = props.timeRules.filter(r => r.type === "Unavailable");
            for (const rule of unavailableRules) {
                const ruleStart = window.SchedulerCoreUtils?.parseTimeToMinutes(rule.start) || rule.startMin;
                const ruleEnd = window.SchedulerCoreUtils?.parseTimeToMinutes(rule.end) || rule.endMin;
                if (blockStart < ruleEnd && blockEnd > ruleStart) {
                    return `Time ${blockStart}-${blockEnd} blocked by Unavailable rule ${ruleStart}-${ruleEnd}`;
                }
            }
        }
        
        // Check division restrictions
        if (props.allowedDivisions?.length && !props.allowedDivisions.includes(block.divName)) {
            return `Division "${block.divName}" not in allowedDivisions: [${props.allowedDivisions.join(', ')}]`;
        }
        
        if (props.preferences?.enabled && props.preferences.exclusive) {
            if (!props.preferences.list.includes(block.divName)) {
                return `Division "${block.divName}" not in exclusive preference list`;
            }
        }
        
        // Check capacity
        const schedules = window.scheduleAssignments || {};
        for (const slotIdx of slots) {
            let count = 0;
            for (const [otherBunk, otherSlots] of Object.entries(schedules)) {
                if (otherBunk === block.bunk) continue;
                const entry = otherSlots?.[slotIdx];
                if (!entry) continue;
                const entryField = window.SchedulerCoreUtils?.fieldLabel(entry.field) || entry._activity;
                if (entryField?.toLowerCase().trim() === fieldName.toLowerCase().trim()) {
                    count++;
                }
            }
            
            let maxCap = 1;
            if (props.sharableWith?.capacity) maxCap = parseInt(props.sharableWith.capacity) || 1;
            else if (props.sharable) maxCap = 2;
            
            if (count >= maxCap) {
                return `Field at capacity (${count}/${maxCap}) at slot ${slotIdx}`;
            }
        }
        
        return `Unknown (canBlockFit returned false) - check console for [FIT] messages`;
    }

    Solver.getValidActivityPicks = function (block) {
        const picks = [];
        const rejectionReasons = {};
        
        for (const cand of allCandidateOptions) {
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
                } else {
                    rejectionReasons[`${cand.field}:${cand.activityName}`] = `High penalty: ${cost}`;
                }
            } else {
                // Get detailed rejection reason
                rejectionReasons[`${cand.field}:${cand.activityName}`] = debugRejection(block, cand.field, cand.activityName);
            }
        }
        
        // DEBUG: Log rejections for blocks with few picks
        if (picks.length < 3 && DEBUG_MODE) {
            const timeHr = Math.floor(block.startTime/60);
            const timeMin = block.startTime % 60;
            const ampm = timeHr >= 12 ? 'PM' : 'AM';
            const hr12 = timeHr % 12 || 12;
            const timeStr = `${hr12}:${String(timeMin).padStart(2,'0')} ${ampm}`;
            
            console.log(`\n⚠️ BLOCK WITH FEW OPTIONS:`);
            console.log(`   Bunk: ${block.bunk}`);
            console.log(`   Division: ${block.divName}`);
            console.log(`   Time: ${timeStr} (${block.startTime} mins)`);
            console.log(`   Valid picks (${picks.length}): ${picks.map(p => `${p.pick.field}:${p.pick._activity}`).join(', ') || 'NONE'}`);
            console.log(`   Sample rejections:`);
            
            // Show first 10 rejections with full reasons
            const rejectionList = Object.entries(rejectionReasons).slice(0, 10);
            rejectionList.forEach(([key, reason]) => {
                console.log(`     ❌ ${key}: ${reason}`);
            });
        }
        
        // Always have Free as fallback
        picks.push({ 
            pick: { field: "Free", sport: null, _activity: "Free" }, 
            cost: 50000 
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

        // Build candidate options (FIXED - no sports as fields)
        allCandidateOptions = buildAllCandidateOptions(config);
        
        if (allCandidateOptions.length === 0) {
            console.error('[SOLVER] NO CANDIDATE OPTIONS BUILT!');
        }

        if (!window.leagueRoundState) window.leagueRoundState = {};
        if (!globalConfig.rotationHistory) globalConfig.rotationHistory = {};
        if (!globalConfig.rotationHistory.leagues) globalConfig.rotationHistory.leagues = {};

        const sorted = Solver.sortBlocksByDifficulty(allBlocks, config);
        const leagueBlocks = sorted.filter(b => b._isLeague);
        const activityBlocks = sorted.filter(b => !b._isLeague);

        console.log(`[SOLVER] Processing ${activityBlocks.length} activity blocks with ${allCandidateOptions.length} candidate options`);

        const solvedLeague = Solver.solveLeagueSchedule(leagueBlocks);

        let bestSchedule = [...solvedLeague];
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
                .slice(0, 10);

            for (const p of picks) {
                const res = Solver.applyTentativePick(block, p);
                const out = backtrack(idx + 1, [...acc, { block, solution: p.pick }]);
                if (out) return out;
                Solver.undoTentativePick(res);
            }
            return null;
        }

        const final = backtrack(0, solvedLeague);

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
    
    Solver.debugTimeRules = function(fieldName) {
        const props = activityProperties[fieldName];
        console.log(`=== TIME RULES FOR: ${fieldName} ===`);
        console.log('Props:', props);
        console.log('TimeRules:', props?.timeRules);
        
        if (props?.timeRules) {
            props.timeRules.forEach((rule, i) => {
                const startMin = window.SchedulerCoreUtils?.parseTimeToMinutes(rule.start) || rule.startMin;
                const endMin = window.SchedulerCoreUtils?.parseTimeToMinutes(rule.end) || rule.endMin;
                console.log(`  Rule ${i}: ${rule.type} ${startMin}-${endMin} (${rule.start}-${rule.end})`);
            });
        }
    };
    
    Solver.debugAllTimeRules = function() {
        console.log('=== ALL FIELD TIME RULES ===');
        for (const [fieldName, props] of Object.entries(activityProperties)) {
            if (props.timeRules && props.timeRules.length > 0) {
                console.log(`${fieldName}:`);
                props.timeRules.forEach((rule, i) => {
                    console.log(`  ${rule.type}: ${rule.start || rule.startMin} - ${rule.end || rule.endMin}`);
                });
            }
        }
    };

    window.totalSolverEngine = Solver;

})();
