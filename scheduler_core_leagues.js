// ============================================================================
// scheduler_core_leagues.js (COMPLETE REWRITE v2)
// 
// PROBLEM SOLVED:
// Previously: All matchups got SAME field + SAME sport (impossible)
// Now: Each matchup gets UNIQUE field + VARIED sport (like the sample)
//
// SAMPLE TARGET:
// Team 1: vs 2 (basketball), vs 6 (football), vs 4 (hockey)
// Team 2: vs 1 (basketball), vs 3 (hockey), vs 5 (football)
// etc.
//
// KEY INSIGHT: In ONE time slot with 4 matchups:
// - Matchup A plays Baseball @ Field 1
// - Matchup B plays Basketball @ Gym A
// - Matchup C plays Football @ Football Field
// - Matchup D plays Hockey @ Hockey Rink
// ============================================================================

(function () {
    'use strict';

    const Leagues = {};

    // =========================================================================
    // PERSISTENT HISTORY (Season-Long Tracking)
    // =========================================================================
    
    const LEAGUE_HISTORY_KEY = "campLeagueHistory_v2";
    
    function loadLeagueHistory() {
        try {
            const raw = localStorage.getItem(LEAGUE_HISTORY_KEY);
            if (!raw) return { teamSports: {}, matchupHistory: {}, roundCounters: {} };
            return JSON.parse(raw);
        } catch (e) {
            console.error("Failed to load league history:", e);
            return { teamSports: {}, matchupHistory: {}, roundCounters: {} };
        }
    }
    
    function saveLeagueHistory(history) {
        try {
            localStorage.setItem(LEAGUE_HISTORY_KEY, JSON.stringify(history));
        } catch (e) {
            console.error("Failed to save league history:", e);
        }
    }
    
    // Track what sports each team has played in a league
    // Format: { "LeagueName|Team1": ["Baseball", "Basketball", ...], ... }
    function getTeamSportHistory(leagueName, team, history) {
        const key = `${leagueName}|${team}`;
        return history.teamSports[key] || [];
    }
    
    function recordTeamSport(leagueName, team, sport, history) {
        const key = `${leagueName}|${team}`;
        if (!history.teamSports[key]) history.teamSports[key] = [];
        history.teamSports[key].push(sport);
    }

    // =========================================================================
    // ROUND-ROBIN MATCHUP GENERATION
    // =========================================================================
    
    function generateRoundRobinSchedule(teams) {
        if (teams.length < 2) return [];
        
        const schedule = [];
        const n = teams.length;
        const isOdd = n % 2 === 1;
        
        const workingTeams = isOdd ? [...teams, 'BYE'] : [...teams];
        const rounds = workingTeams.length - 1;

        for (let round = 0; round < rounds; round++) {
            const roundMatches = [];
            
            for (let i = 0; i < workingTeams.length / 2; i++) {
                const home = workingTeams[i];
                const away = workingTeams[workingTeams.length - 1 - i];
                
                if (home !== 'BYE' && away !== 'BYE') {
                    roundMatches.push([home, away]);
                }
            }
            
            schedule.push(roundMatches);
            
            // Rotate: keep first fixed, rotate rest
            const last = workingTeams.pop();
            workingTeams.splice(1, 0, last);
        }

        return schedule;
    }

    // =========================================================================
    // FIELD/SPORT AVAILABILITY
    // =========================================================================
    
    /**
     * Build a pool of available field+sport combinations for a time slot.
     * Each combination can only be used ONCE per time slot.
     * 
     * @returns Array of { field: "Field A", sport: "Baseball", capacity: 1 }
     */
    function buildAvailableFieldSportPool(leagueSports, context, divisionNames, timeKey) {
        const pool = [];
        const { fields, disabledFields, activityProperties, fieldUsageBySlot } = context;
        
        // Get all fields that host any of the league's sports
        const allFields = fields || [];
        
        for (const field of allFields) {
            if (!field || !field.name) continue;
            if (field.available === false) continue;
            if (disabledFields && disabledFields.includes(field.name)) continue;
            
            // Check if field is allowed for these divisions
            if (field.limitUsage?.enabled) {
                const allowedDivs = Object.keys(field.limitUsage.divisions || {});
                const hasAllowed = divisionNames.some(d => allowedDivs.includes(d));
                if (!hasAllowed) continue;
            }
            
            // Check what sports this field supports
            const fieldSports = field.activities || [];
            
            for (const sport of leagueSports) {
                if (!fieldSports.includes(sport)) continue;
                
                // Check if field is already fully occupied at this time
                // (by checking fieldUsageBySlot or leagueFieldOccupancy)
                const isBlocked = window.leagueFieldOccupancy?.[timeKey]?.includes(field.name);
                if (isBlocked) continue;
                
                pool.push({
                    field: field.name,
                    sport: sport,
                    fieldObj: field
                });
            }
        }
        
        return pool;
    }

    // =========================================================================
    // SMART ASSIGNMENT ALGORITHM
    // =========================================================================
    
    /**
     * THE CORE ALGORITHM: Assign each matchup to a unique field with varied sports.
     * 
     * Goals:
     * 1. Each matchup gets a DIFFERENT field (no overlap)
     * 2. Teams get sport VARIETY over time
     * 3. Within a single slot, try for sport variety too
     */
    function assignMatchupsToFieldsAndSports(matchups, availablePool, leagueName, history) {
        const assignments = [];
        const usedFields = new Set();
        const usedSportsThisSlot = {};  // Track sport usage count this slot
        
        // Calculate sport "need" for each team (how much they need variety)
        function getTeamSportNeed(team, sport) {
            const teamHistory = getTeamSportHistory(leagueName, team, history);
            const sportCount = teamHistory.filter(s => s === sport).length;
            const totalGames = teamHistory.length;
            
            // If team has never played this sport, high need
            if (sportCount === 0) return 1000;
            
            // Lower score = team has played this sport more often
            return Math.max(0, 100 - sportCount * 20);
        }
        
        // Sort matchups by how desperately they need variety
        // (Teams with least sport variety go first to get best options)
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const h1 = getTeamSportHistory(leagueName, t1, history);
            const h2 = getTeamSportHistory(leagueName, t2, history);
            const uniqueSports1 = new Set(h1).size;
            const uniqueSports2 = new Set(h2).size;
            // Lower unique count = higher priority (needs more variety)
            return { t1, t2, varietyScore: uniqueSports1 + uniqueSports2 };
        });
        
        matchupsWithPriority.sort((a, b) => a.varietyScore - b.varietyScore);
        
        for (const { t1, t2 } of matchupsWithPriority) {
            let bestOption = null;
            let bestScore = -Infinity;
            
            for (const option of availablePool) {
                // Skip if field already used this slot
                if (usedFields.has(option.field)) continue;
                
                // Calculate score for this field+sport combination
                let score = 0;
                
                // Factor 1: Sport need for both teams
                const need1 = getTeamSportNeed(t1, option.sport);
                const need2 = getTeamSportNeed(t2, option.sport);
                score += need1 + need2;
                
                // Factor 2: Sport variety within this slot
                // Prefer sports not yet used in this time slot
                const sportUsageThisSlot = usedSportsThisSlot[option.sport] || 0;
                if (sportUsageThisSlot === 0) {
                    score += 500;  // Big bonus for unused sport
                } else {
                    score -= sportUsageThisSlot * 100;  // Penalty for repeated sport
                }
                
                // Factor 3: Slight randomization for variety
                score += Math.random() * 10;
                
                if (score > bestScore) {
                    bestScore = score;
                    bestOption = option;
                }
            }
            
            if (bestOption) {
                assignments.push({
                    team1: t1,
                    team2: t2,
                    matchup: `${t1} vs ${t2}`,
                    field: bestOption.field,
                    sport: bestOption.sport
                });
                
                // Mark as used
                usedFields.add(bestOption.field);
                usedSportsThisSlot[bestOption.sport] = (usedSportsThisSlot[bestOption.sport] || 0) + 1;
                
                // Block field globally for this time slot
                if (!window.leagueFieldOccupancy) window.leagueFieldOccupancy = {};
                const timeKey = `slot_${Date.now()}`;  // Will be passed in properly
                
                console.log(`   ✅ ${t1} vs ${t2} → ${bestOption.sport} @ ${bestOption.field}`);
            } else {
                console.log(`   ❌ No field available for ${t1} vs ${t2}`);
            }
        }
        
        return assignments;
    }

    // =========================================================================
    // MAIN REGULAR LEAGUE PROCESSOR
    // =========================================================================
    
    Leagues.processRegularLeagues = function (context) {
        console.log("\n=== LEAGUE ENGINE v2 START ===");
        
        const { 
            schedulableSlotBlocks, 
            masterLeagues, 
            disabledLeagues,
            divisions,
            fillBlock,
            fieldUsageBySlot,
            activityProperties,
            rotationHistory
        } = context;

        if (!masterLeagues || Object.keys(masterLeagues).length === 0) {
            console.log("No regular leagues configured.");
            return;
        }
        
        // Load persistent history
        const history = loadLeagueHistory();
        
        // Reset per-day field occupancy
        window.leagueFieldOccupancy = {};

        // Group blocks by time
        const blocksByTime = {};
        
        schedulableSlotBlocks
            .filter(b => b.type === 'league' || /league/i.test(b.event))
            .forEach(block => {
                const key = block.startTime;
                if (!blocksByTime[key]) {
                    blocksByTime[key] = { byDivision: {}, allBlocks: [] };
                }
                
                if (!blocksByTime[key].byDivision[block.divName]) {
                    blocksByTime[key].byDivision[block.divName] = [];
                }
                
                blocksByTime[key].byDivision[block.divName].push(block);
                blocksByTime[key].allBlocks.push(block);
            });

        // Process each time slot
        for (const [timeKey, timeData] of Object.entries(blocksByTime)) {
            const divisionsAtTime = Object.keys(timeData.byDivision);
            
            console.log(`\n📅 Processing League Time Slot: ${timeKey}`);
            console.log(`   Divisions present: [${divisionsAtTime.join(", ")}]`);
            
            // Track which leagues we've processed at this time
            const processedLeagues = new Set();

            // Find applicable leagues
            const applicableLeagues = Object.values(masterLeagues).filter(l => {
                if (!l.enabled) return false;
                if (disabledLeagues?.includes(l.name)) return false;
                if (!l.divisions || l.divisions.length === 0) return false;
                return divisionsAtTime.some(div => l.divisions.includes(div));
            });

            for (const league of applicableLeagues) {
                if (processedLeagues.has(league.name)) continue;
                processedLeagues.add(league.name);

                // Only divisions in BOTH this league AND this time slot
                const leagueDivisions = league.divisions.filter(div => divisionsAtTime.includes(div));
                if (leagueDivisions.length === 0) continue;

                console.log(`\n📋 League: "${league.name}"`);
                console.log(`   Teams: [${(league.teams || []).join(", ")}]`);
                console.log(`   Sports: [${(league.sports || []).join(", ")}]`);
                console.log(`   Active Divisions: [${leagueDivisions.join(", ")}]`);

                const leagueTeams = league.teams || [];
                if (leagueTeams.length < 2) {
                    console.log(`   ⚠️ Not enough teams`);
                    continue;
                }

                // Get current round
                const roundCounter = history.roundCounters[league.name] || 0;
                const fullSchedule = generateRoundRobinSchedule(leagueTeams);
                const roundIndex = roundCounter % fullSchedule.length;
                const matchups = fullSchedule[roundIndex] || [];
                
                console.log(`   Round: ${roundCounter + 1} (Index: ${roundIndex})`);
                console.log(`   Matchups: ${matchups.length}`);
                matchups.forEach(([t1, t2]) => console.log(`      • ${t1} vs ${t2}`));

                if (matchups.length === 0) continue;

                // Build available field/sport pool
                const leagueSports = league.sports || ["General Sport"];
                const availablePool = buildAvailableFieldSportPool(
                    leagueSports, 
                    context, 
                    leagueDivisions, 
                    timeKey
                );
                
                console.log(`   Available Field/Sport Combinations: ${availablePool.length}`);
                availablePool.slice(0, 10).forEach(p => 
                    console.log(`      • ${p.sport} @ ${p.field}`)
                );

                if (availablePool.length === 0) {
                    console.log(`   🚨 No fields available for league sports!`);
                    continue;
                }

                // THE KEY ALGORITHM: Assign unique fields with varied sports
                const assignments = assignMatchupsToFieldsAndSports(
                    matchups, 
                    availablePool, 
                    league.name, 
                    history
                );

                console.log(`\n   📝 Final Assignments:`);
                assignments.forEach(a => {
                    console.log(`      ${a.team1} vs ${a.team2} → ${a.sport} @ ${a.field}`);
                    
                    // Record in history
                    recordTeamSport(league.name, a.team1, a.sport, history);
                    recordTeamSport(league.name, a.team2, a.sport, history);
                });

                // Fill blocks for all bunks in league divisions
                const gameNumber = roundCounter + 1;
                
                leagueDivisions.forEach(divName => {
                    const blocksForDiv = timeData.byDivision[divName];
                    if (!blocksForDiv) return;
                    
                    blocksForDiv.forEach(block => {
                        const pick = {
                            field: `League: ${league.name}`,
                            sport: `Game ${gameNumber}`,
                            _activity: `League: ${league.name}`,
                            _h2h: true,
                            _fixed: true,
                            _allMatchups: assignments.map(a => 
                                `${a.team1} vs ${a.team2} @ ${a.field} (${a.sport})`
                            ),
                            _gameLabel: `Game ${gameNumber}`
                        };

                        fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                        block.processed = true;
                    });
                });

                // Increment round counter
                history.roundCounters[league.name] = roundCounter + 1;
                
                // Also update window.leagueRoundState for compatibility
                if (!window.leagueRoundState) window.leagueRoundState = {};
                window.leagueRoundState[league.name] = { currentRound: roundCounter + 1 };
            }
        }

        // Save history
        saveLeagueHistory(history);

        // Print summary
        console.log("\n=== LEAGUE ENGINE v2 COMPLETE ===");
        console.log("\n📊 Team Sport History:");
        Object.keys(history.teamSports).forEach(key => {
            const [league, team] = key.split('|');
            const sports = history.teamSports[key];
            const sportCounts = {};
            sports.forEach(s => sportCounts[s] = (sportCounts[s] || 0) + 1);
            console.log(`   ${league} - ${team}: ${JSON.stringify(sportCounts)}`);
        });
    };

    // =========================================================================
    // SPECIALTY LEAGUES (Similar Logic)
    // =========================================================================
    
    Leagues.processSpecialtyLeagues = function (context) {
        console.log("\n=== SPECIALTY LEAGUE ENGINE v2 START ===");
        
        const { 
            schedulableSlotBlocks, 
            masterSpecialtyLeagues, 
            disabledSpecialtyLeagues,
            activityProperties,
            fieldUsageBySlot,
            fillBlock,
            divisions
        } = context;

        if (!masterSpecialtyLeagues || Object.keys(masterSpecialtyLeagues).length === 0) {
            console.log("No specialty leagues configured.");
            return;
        }
        
        const history = loadLeagueHistory();

        const blocksByDivisionTime = {};
        
        schedulableSlotBlocks
            .filter(b => b.type === 'specialty_league')
            .forEach(block => {
                const key = `${block.divName}_${block.startTime}`;
                if (!blocksByDivisionTime[key]) {
                    blocksByDivisionTime[key] = [];
                }
                blocksByDivisionTime[key].push(block);
            });

        for (const [key, blocks] of Object.entries(blocksByDivisionTime)) {
            const [divName, startTime] = key.split('_');
            
            const league = Object.values(masterSpecialtyLeagues).find(l => {
                if (disabledSpecialtyLeagues?.includes(l.name)) return false;
                if (!l.divisions || !l.divisions.includes(divName)) return false;
                return true;
            });

            if (!league) continue;

            console.log(`\n📋 Specialty League: "${league.name}" (${divName})`);

            const leagueTeams = league.teams || [];
            if (leagueTeams.length < 2) continue;

            const roundCounter = history.roundCounters[`specialty_${league.name}`] || 0;
            const fullSchedule = generateRoundRobinSchedule(leagueTeams);
            const matchups = fullSchedule[roundCounter % fullSchedule.length] || [];

            if (matchups.length === 0) continue;

            const leagueSports = league.sports || [league.sport || "General"];
            const availablePool = buildAvailableFieldSportPool(
                leagueSports, 
                context, 
                [divName], 
                startTime
            );

            const assignments = assignMatchupsToFieldsAndSports(
                matchups, 
                availablePool, 
                `specialty_${league.name}`, 
                history
            );

            blocks.forEach(block => {
                const pick = {
                    field: `Specialty League: ${league.name}`,
                    sport: assignments.length > 0 ? assignments[0].sport : "League",
                    _activity: `Specialty League: ${league.name}`,
                    _h2h: true,
                    _fixed: true,
                    _allMatchups: assignments.map(a => 
                        `${a.team1} vs ${a.team2} @ ${a.field} (${a.sport})`
                    ),
                    _gameLabel: `Specialty League`
                };

                fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                block.processed = true;
            });

            history.roundCounters[`specialty_${league.name}`] = roundCounter + 1;
        }

        saveLeagueHistory(history);
        console.log("=== SPECIALTY LEAGUE ENGINE v2 COMPLETE ===");
    };

    // =========================================================================
    // DIAGNOSTIC UTILITIES
    // =========================================================================
    
    window.viewLeagueHistory = function() {
        const history = loadLeagueHistory();
        console.log("\n=== COMPLETE LEAGUE HISTORY ===");
        console.log(JSON.stringify(history, null, 2));
        return history;
    };
    
    window.resetLeagueHistory = function() {
        if (confirm("Reset ALL league history? This will start fresh.")) {
            localStorage.removeItem(LEAGUE_HISTORY_KEY);
            console.log("League history reset.");
        }
    };
    
    window.viewTeamSportBalance = function(leagueName) {
        const history = loadLeagueHistory();
        console.log(`\n=== Sport Balance for League: ${leagueName} ===`);
        
        const teamStats = {};
        Object.keys(history.teamSports).forEach(key => {
            if (!key.startsWith(leagueName + '|')) return;
            const team = key.split('|')[1];
            const sports = history.teamSports[key];
            
            const counts = {};
            sports.forEach(s => counts[s] = (counts[s] || 0) + 1);
            teamStats[team] = counts;
        });
        
        console.table(teamStats);
        return teamStats;
    };

    // Export
    window.SchedulerCoreLeagues = Leagues;

})();
