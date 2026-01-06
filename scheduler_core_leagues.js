// ============================================================================
// scheduler_core_leagues.js (FIXED v7 - CHRONOLOGICAL DATE ORDERING)
//
// CRITICAL UPDATE:
// - Now supports two scheduling priorities per league:
//   - 'sport_variety' (default): Prioritize playing all sports before repeating
//   - 'matchup_variety': Prioritize playing all opponents before rematching
// - Uses GlobalFieldLocks to check/lock fields
// - Regular leagues process AFTER specialty leagues
// - Any field locked by specialty leagues is unavailable
// - Regular leagues lock their fields to prevent double-booking
// - Game counter: Uses CHRONOLOGICAL date ordering (not creation order)
// - Persists to cloud via saveGlobalSettings
// ============================================================================

(function () {
    'use strict';

    const Leagues = {};

    // =========================================================================
    // PERSISTENT HISTORY (NOW CLOUD-SYNCED)
    // =========================================================================

    const LEAGUE_HISTORY_KEY = "campLeagueHistory_v2";

    function loadLeagueHistory() {
        try {
            // ★ First try to load from cloud-synced global settings
            const global = window.loadGlobalSettings?.() || {};
            if (global.leagueHistory && Object.keys(global.leagueHistory).length > 0) {
                const history = global.leagueHistory;
                // Ensure all fields exist
                history.teamSports = history.teamSports || {};
                history.matchupHistory = history.matchupHistory || {};
                history.gamesPerDate = history.gamesPerDate || {};  // ★ NEW: tracks games per date per league
                console.log("[RegularLeagues] ✅ Loaded history from cloud");
                return history;
            }
            
            // Fallback to localStorage
            const raw = localStorage.getItem(LEAGUE_HISTORY_KEY);
            if (!raw) return {
                teamSports: {},
                matchupHistory: {},
                gamesPerDate: {}  // ★ NEW: { leagueName: { "2025-01-01": 2, "2025-01-02": 3 } }
            };

            const history = JSON.parse(raw);
            // Migrate old format to new
            history.teamSports = history.teamSports || {};
            history.matchupHistory = history.matchupHistory || {};
            history.gamesPerDate = history.gamesPerDate || {};
            
            // Migrate from old roundCounters/dayStartRound if present
            if (history.roundCounters && !history.gamesPerDate) {
                console.log("[RegularLeagues] Migrating old history format...");
                history.gamesPerDate = {};
            }
            
            return history;
        } catch (e) {
            console.error("Failed to load league history:", e);
            return {
                teamSports: {},
                matchupHistory: {},
                gamesPerDate: {}
            };
        }
    }

    function saveLeagueHistory(history) {
        try {
            // Save to localStorage as backup
            localStorage.setItem(LEAGUE_HISTORY_KEY, JSON.stringify(history));
            
            // ★ CRITICAL: Also save to cloud via global settings
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('leagueHistory', history);
                console.log("[RegularLeagues] ✅ History saved to cloud");
            }
        } catch (e) {
            console.error("Failed to save league history:", e);
        }
    }

    // =========================================================================
    // ★ NEW: CHRONOLOGICAL GAME NUMBERING
    // =========================================================================

    /**
     * Calculate the starting game number for a given date based on
     * all games that occurred on EARLIER dates (chronologically)
     */
    function calculateStartingGameNumber(leagueName, currentDate, history) {
        if (!history.gamesPerDate) history.gamesPerDate = {};
        if (!history.gamesPerDate[leagueName]) history.gamesPerDate[leagueName] = {};
        
        const gamesMap = history.gamesPerDate[leagueName];
        
        // Sum games from all dates BEFORE currentDate (chronologically)
        let total = 0;
        for (const date of Object.keys(gamesMap)) {
            if (date < currentDate) {
                total += gamesMap[date];
            }
        }
        
        console.log(`[RegularLeagues] Starting game# for "${leagueName}" on ${currentDate}: ${total + 1} (${total} games on earlier dates)`);
        return total;
    }

    /**
     * Record how many games occurred on a given date for a league
     */
    function recordGamesOnDate(leagueName, currentDate, numGames, history) {
        if (!history.gamesPerDate) history.gamesPerDate = {};
        if (!history.gamesPerDate[leagueName]) history.gamesPerDate[leagueName] = {};
        
        history.gamesPerDate[leagueName][currentDate] = numGames;
        console.log(`[RegularLeagues] Recorded ${numGames} game(s) for "${leagueName}" on ${currentDate}`);
    }

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
    // MATCHUP HISTORY TRACKING (for matchup_variety mode)
    // =========================================================================

    function getMatchupKey(team1, team2) {
        // Normalize matchup key so A vs B === B vs A
        return [team1, team2].sort().join('|');
    }

    function getMatchupCount(leagueName, team1, team2, history) {
        const matchupKey = `${leagueName}:${getMatchupKey(team1, team2)}`;
        return history.matchupHistory[matchupKey] || 0;
    }

    function recordMatchup(leagueName, team1, team2, history) {
        const matchupKey = `${leagueName}:${getMatchupKey(team1, team2)}`;
        history.matchupHistory[matchupKey] = (history.matchupHistory[matchupKey] || 0) + 1;
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

            const last = workingTeams.pop();
            workingTeams.splice(1, 0, last);
        }
        return schedule;
    }

    // =========================================================================
    // ★★★ FIELD AVAILABILITY - WITH GLOBAL LOCK CHECK ★★★
    // =========================================================================

    function buildAvailableFieldSportPool(leagueSports, context, divisionNames, timeKey, slots) {
        const pool = [];
        const { fields, disabledFields, activityProperties } = context;

        const allFields = fields || [];

        for (const field of allFields) {
            if (!field || !field.name) continue;
            if (field.available === false) continue;
            if (disabledFields && disabledFields.includes(field.name)) continue;

            // ★★★ CHECK GLOBAL LOCKS FIRST ★★★
            if (window.GlobalFieldLocks && slots && slots.length > 0) {
                const lockInfo = window.GlobalFieldLocks.isFieldLocked(field.name, slots);
                if (lockInfo) {
                    console.log(`[RegularLeagues] ⚠️ Field "${field.name}" locked by ${lockInfo.lockedBy} (${lockInfo.leagueName || lockInfo.activity})`);
                    continue;
                }
            }

            // Check division restrictions
            if (field.limitUsage?.enabled) {
                const allowedDivs = Object.keys(field.limitUsage.divisions || {});
                const hasAllowed = divisionNames.some(d => allowedDivs.includes(d));
                if (!hasAllowed) continue;
            }

            const fieldSports = field.activities || [];

            for (const sport of leagueSports) {
                if (!fieldSports.includes(sport)) continue;

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
    // SMART ASSIGNMENT ALGORITHM - SPORT VARIETY MODE (Default)
    // =========================================================================

    function assignMatchupsToFieldsAndSports_SportVariety(matchups, availablePool, leagueName, history, slots) {
        const assignments = [];
        const usedFields = new Set();
        const usedSportsThisSlot = {};

        function getTeamSportNeed(team, sport) {
            const teamHistory = getTeamSportHistory(leagueName, team, history);
            const sportCount = teamHistory.filter(s => s === sport).length;

            if (sportCount === 0) return 1000;
            return Math.max(0, 100 - sportCount * 20);
        }

        // Sort matchups so teams with less sport variety get processed first
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const h1 = getTeamSportHistory(leagueName, t1, history);
            const h2 = getTeamSportHistory(leagueName, t2, history);
            const uniqueSports1 = new Set(h1).size;
            const uniqueSports2 = new Set(h2).size;
            return { t1, t2, varietyScore: uniqueSports1 + uniqueSports2 };
        });

        matchupsWithPriority.sort((a, b) => a.varietyScore - b.varietyScore);

        for (const { t1, t2 } of matchupsWithPriority) {
            let bestOption = null;
            let bestScore = -Infinity;

            for (const option of availablePool) {
                if (usedFields.has(option.field)) continue;

                let score = 0;

                // Heavy weight on sport need (main priority in this mode)
                const need1 = getTeamSportNeed(t1, option.sport);
                const need2 = getTeamSportNeed(t2, option.sport);
                score += need1 + need2;

                // Prefer sports not yet used this slot
                const sportUsageThisSlot = usedSportsThisSlot[option.sport] || 0;
                if (sportUsageThisSlot === 0) {
                    score += 500;
                } else {
                    score -= sportUsageThisSlot * 100;
                }

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

                usedFields.add(bestOption.field);
                usedSportsThisSlot[bestOption.sport] = (usedSportsThisSlot[bestOption.sport] || 0) + 1;

                console.log(`   ✅ [SportVariety] ${t1} vs ${t2} → ${bestOption.sport} @ ${bestOption.field}`);
            } else {
                console.log(`   ❌ No field available for ${t1} vs ${t2}`);
            }
        }

        return assignments;
    }

    // =========================================================================
    // SMART ASSIGNMENT ALGORITHM - MATCHUP VARIETY MODE
    // =========================================================================

    function assignMatchupsToFieldsAndSports_MatchupVariety(matchups, availablePool, leagueName, history, slots) {
        const assignments = [];
        const usedFields = new Set();

        // Sort matchups by how many times they've played (least played first)
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const matchupCount = getMatchupCount(leagueName, t1, t2, history);
            return { t1, t2, matchupCount };
        });

        // Process matchups with fewest prior meetings first
        matchupsWithPriority.sort((a, b) => a.matchupCount - b.matchupCount);

        console.log(`   📊 [MatchupVariety] Matchup priorities:`);
        matchupsWithPriority.forEach(m => {
            console.log(`      • ${m.t1} vs ${m.t2}: ${m.matchupCount} prior games`);
        });

        for (const { t1, t2 } of matchupsWithPriority) {
            let bestOption = null;
            let bestScore = -Infinity;

            for (const option of availablePool) {
                if (usedFields.has(option.field)) continue;

                let score = 0;

                // In matchup variety mode, sport variety is secondary
                // Just add a small preference for sports not played as much
                const h1 = getTeamSportHistory(leagueName, t1, history);
                const h2 = getTeamSportHistory(leagueName, t2, history);
                const sportCount1 = h1.filter(s => s === option.sport).length;
                const sportCount2 = h2.filter(s => s === option.sport).length;
                
                // Small bonus for less-played sports (not the main factor)
                score += Math.max(0, 50 - (sportCount1 + sportCount2) * 5);

                // Random factor for variety
                score += Math.random() * 20;

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

                usedFields.add(bestOption.field);

                console.log(`   ✅ [MatchupVariety] ${t1} vs ${t2} → ${bestOption.sport} @ ${bestOption.field}`);
            } else {
                console.log(`   ❌ No field available for ${t1} vs ${t2}`);
            }
        }

        return assignments;
    }

    // =========================================================================
    // UNIFIED ASSIGNMENT FUNCTION (Delegates based on priority mode)
    // =========================================================================

    function assignMatchupsToFieldsAndSports(matchups, availablePool, leagueName, history, slots, schedulingPriority) {
        const mode = schedulingPriority || 'sport_variety';
        
        console.log(`   🎯 Scheduling Priority: ${mode === 'sport_variety' ? 'Sport Variety' : 'Matchup Variety'}`);

        if (mode === 'matchup_variety') {
            return assignMatchupsToFieldsAndSports_MatchupVariety(matchups, availablePool, leagueName, history, slots);
        } else {
            return assignMatchupsToFieldsAndSports_SportVariety(matchups, availablePool, leagueName, history, slots);
        }
    }

    // =========================================================================
    // ★★★ MAIN REGULAR LEAGUE PROCESSOR ★★★
    // =========================================================================

    Leagues.processRegularLeagues = function (context) {
        console.log("\n" + "=".repeat(60));
        console.log("★★★ REGULAR LEAGUE ENGINE START (PRIORITY 2) ★★★");
        console.log("=".repeat(60));

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
            console.log("[RegularLeagues] No regular leagues configured.");
            return;
        }

        const history = loadLeagueHistory();

        // ★★★ GET CURRENT DAY IDENTIFIER ★★★
        const dayId = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        console.log(`[RegularLeagues] Current day: "${dayId}"`);

        // ★★★ TRACK GAMES PER LEAGUE FOR THIS DAY ★★★
        const leagueGameCounters = {};  // Tracks how many games each league has scheduled TODAY

        // Group blocks by time
        const blocksByTime = {};

        schedulableSlotBlocks
            .filter(b => b.type === 'league' || /league/i.test(b.event))
            .filter(b => !b.processed) // Skip already processed blocks
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

        // Sort time slots to ensure consistent ordering
        const sortedTimeKeys = Object.keys(blocksByTime).sort();

        // Process each time slot
        for (const timeKey of sortedTimeKeys) {
            const timeData = blocksByTime[timeKey];
            const divisionsAtTime = Object.keys(timeData.byDivision);

            console.log(`\n📅 Processing League Time Slot: ${timeKey}`);
            console.log(`   Divisions present: [${divisionsAtTime.join(", ")}]`);

            // Get slots for this time
            const sampleBlock = timeData.allBlocks[0];
            const slots = sampleBlock?.slots || [];

            const processedLeagues = new Set();
            const applicableLeagues = Object.values(masterLeagues).filter(l => {
                if (!l.enabled) return false;
                if (disabledLeagues?.includes(l.name)) return false;
                if (!l.divisions || l.divisions.length === 0) return false;
                return divisionsAtTime.some(div => l.divisions.includes(div));
            });

            for (const league of applicableLeagues) {
                if (processedLeagues.has(league.name)) continue;
                processedLeagues.add(league.name);

                const leagueDivisions = league.divisions.filter(div => divisionsAtTime.includes(div));
                if (leagueDivisions.length === 0) continue;

                console.log(`\n📋 League: "${league.name}"`);
                console.log(`   Teams: [${(league.teams || []).join(", ")}]`);
                console.log(`   Sports: [${(league.sports || []).join(", ")}]`);
                console.log(`   Active Divisions: [${leagueDivisions.join(", ")}]`);
                console.log(`   Scheduling Priority: ${league.schedulingPriority || 'sport_variety'}`);

                const leagueTeams = league.teams || [];
                if (leagueTeams.length < 2) {
                    console.log(`   ⚠️ Not enough teams`);
                    continue;
                }

                // ★★★ CHRONOLOGICAL GAME NUMBERING ★★★
                // Initialize counter for this league if not done
                if (leagueGameCounters[league.name] === undefined) {
                    leagueGameCounters[league.name] = 0;
                }
                
                // Get the starting game number based on chronological date order
                const baseGameNumber = calculateStartingGameNumber(league.name, dayId, history);
                const todayGameIndex = leagueGameCounters[league.name];
                const gameNumber = baseGameNumber + todayGameIndex + 1;
                
                // Get matchups using round robin
                const fullSchedule = generateRoundRobinSchedule(leagueTeams);
                const roundIndex = (gameNumber - 1) % fullSchedule.length;
                const matchups = fullSchedule[roundIndex] || [];

                console.log(`   Game #${gameNumber} (Round Index: ${roundIndex}, Today's Game: ${todayGameIndex + 1})`);
                console.log(`   Matchups: ${matchups.length}`);
                matchups.forEach(([t1, t2]) => console.log(`      • ${t1} vs ${t2}`));

                if (matchups.length === 0) continue;

                // ★★★ BUILD POOL - RESPECTS GLOBAL LOCKS ★★★
                const leagueSports = league.sports || ["General Sport"];
                const availablePool = buildAvailableFieldSportPool(
                    leagueSports,
                    context,
                    leagueDivisions,
                    timeKey,
                    slots
                );

                console.log(`   Available Field/Sport Combinations: ${availablePool.length}`);
                availablePool.slice(0, 10).forEach(p =>
                    console.log(`      • ${p.sport} @ ${p.field}`)
                );

                if (availablePool.length === 0) {
                    console.log(`   🚨 No fields available for league sports!`);
                    continue;
                }

                // ★★★ PASS SCHEDULING PRIORITY TO ASSIGNMENT FUNCTION ★★★
                const assignments = assignMatchupsToFieldsAndSports(
                    matchups,
                    availablePool,
                    league.name,
                    history,
                    slots,
                    league.schedulingPriority || 'sport_variety'
                );

                if (assignments.length === 0) {
                    console.log(`   ❌ No assignments possible`);
                    continue;
                }

                // ★★★ INCREMENT TODAY'S GAME COUNTER ★★★
                leagueGameCounters[league.name]++;

                // ★★★ CRITICAL: LOCK ALL USED FIELDS GLOBALLY ★★★
                const usedFields = [...new Set(assignments.map(a => a.field))];
                console.log(`\n   🔒 LOCKING FIELDS: ${usedFields.join(', ')}`);

                if (window.GlobalFieldLocks && slots.length > 0) {
                    window.GlobalFieldLocks.lockMultipleFields(usedFields, slots, {
                        lockedBy: 'regular_league',
                        leagueName: league.name,
                        division: leagueDivisions.join(', '),
                        activity: `${league.name} League Game`
                    });
                }

                // Also lock in fieldUsageBySlot for compatibility
                slots.forEach(slotIdx => {
                    usedFields.forEach(fieldName => {
                        if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
                        fieldUsageBySlot[slotIdx][fieldName] = {
                            count: 999,
                            divisions: leagueDivisions,
                            bunks: {},
                            _lockedByRegularLeague: league.name
                        };
                    });
                });

                console.log(`\n   📝 Final Assignments for Game #${gameNumber}:`);
                assignments.forEach(a => {
                    console.log(`      ✅ ${a.team1} vs ${a.team2} → ${a.sport} @ ${a.field}`);
                    recordTeamSport(league.name, a.team1, a.sport, history);
                    recordTeamSport(league.name, a.team2, a.sport, history);
                    
                    // Record matchup for matchup_variety tracking
                    recordMatchup(league.name, a.team1, a.team2, history);
                });

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

                console.log(`   📈 Game #${gameNumber} complete for "${league.name}"`);

                if (!window.leagueRoundState) window.leagueRoundState = {};
                window.leagueRoundState[league.name] = { currentRound: gameNumber };
            }
        }

        // ★★★ SAVE GAMES PER DATE FOR EACH LEAGUE ★★★
        for (const [leagueName, count] of Object.entries(leagueGameCounters)) {
            if (count > 0) {
                recordGamesOnDate(leagueName, dayId, count, history);
            }
        }

        saveLeagueHistory(history);

        console.log("\n" + "=".repeat(60));
        console.log("★★★ REGULAR LEAGUE ENGINE COMPLETE ★★★");
        console.log("=".repeat(60));

        // Debug print current lock state
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.debugPrintLocks();
        }
    };

    // =========================================================================
    // SPECIALTY LEAGUES (Delegate to dedicated processor)
    // =========================================================================

    Leagues.processSpecialtyLeagues = function (context) {
        // Delegate to the dedicated specialty leagues processor
        if (window.SchedulerCoreSpecialtyLeagues?.processSpecialtyLeagues) {
            window.SchedulerCoreSpecialtyLeagues.processSpecialtyLeagues(context);
        } else {
            console.warn("[Leagues] SchedulerCoreSpecialtyLeagues not loaded!");
        }
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
            // Also clear from cloud
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('leagueHistory', {});
            }
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

    window.viewMatchupHistory = function(leagueName) {
        const history = loadLeagueHistory();
        console.log(`\n=== Matchup History for League: ${leagueName} ===`);

        const matchupStats = {};
        Object.keys(history.matchupHistory).forEach(key => {
            if (!key.startsWith(leagueName + ':')) return;
            const matchupPart = key.substring(leagueName.length + 1);
            matchupStats[matchupPart] = history.matchupHistory[key];
        });

        console.table(matchupStats);
        return matchupStats;
    };

    window.viewLeagueSchedule = function(leagueName) {
        const history = loadLeagueHistory();
        console.log(`\n=== Games Per Date for League: ${leagueName} ===`);

        if (!history.gamesPerDate || !history.gamesPerDate[leagueName]) {
            console.log("No games recorded for this league.");
            return {};
        }

        const dates = Object.keys(history.gamesPerDate[leagueName]).sort();
        let cumulative = 0;
        
        console.log("Date\t\tGames\tCumulative");
        console.log("-".repeat(40));
        
        dates.forEach(date => {
            const count = history.gamesPerDate[leagueName][date];
            cumulative += count;
            console.log(`${date}\t${count}\t${cumulative}`);
        });
        
        return history.gamesPerDate[leagueName];
    };

    window.SchedulerCoreLeagues = Leagues;
    console.log('[RegularLeagues] Module loaded with Chronological Date Ordering + Cloud Persistence v7');
})();
