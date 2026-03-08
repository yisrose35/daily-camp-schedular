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
                history.gamesPerDate = history.gamesPerDate || {};  
                history.offCampusCounts = history.offCampusCounts || {};// ★ NEW: tracks games per date per league
                console.log("[RegularLeagues] ✅ Loaded history from cloud");
                return history;
            }
            
            // Fallback to localStorage
            const raw = localStorage.getItem(LEAGUE_HISTORY_KEY);
            if (!raw) return {
                teamSports: {},
                matchupHistory: {},
                gamesPerDate: {},
                offCampusCounts: {},
                _awayState: {}
            };

            const history = JSON.parse(raw);
            // Migrate old format to new
            history.teamSports = history.teamSports || {};
            history.matchupHistory = history.matchupHistory || {};
            history.gamesPerDate = history.gamesPerDate || {};
            history.offCampusCounts = history.offCampusCounts || {};
            
            
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
                gamesPerDate: {},
                offCampusCounts: {},
                _awayState: {}
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

    /**
     * ★ CRITICAL: Update game numbers in all schedules that come AFTER the current date
     * This ensures chronological consistency when schedules are created out of order
     */
    function updateFutureSchedules(currentDate, history) {
        console.log(`[RegularLeagues] 🔄 Checking for future schedules to update...`);
        console.log(`[RegularLeagues] Current history.gamesPerDate:`, JSON.stringify(history.gamesPerDate, null, 2));
        
        // Get all unique league names from history
        const leagueNames = Object.keys(history.gamesPerDate || {});
        if (leagueNames.length === 0) {
            console.log(`[RegularLeagues] No league history found, skipping update.`);
            return;
        }
        
        // Load all daily data
        const allDailyData = window.loadAllDailyData?.() || {};
        
        // Filter to only valid date keys (YYYY-MM-DD format) that are after currentDate
        const futureDates = Object.keys(allDailyData)
            .filter(date => {
                // Must be a valid date format
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
                // Must be after current date
                return date > currentDate;
            })
            .sort();
        
        if (futureDates.length === 0) {
            console.log(`[RegularLeagues] No future schedules to update.`);
            return;
        }
        
        console.log(`[RegularLeagues] Found ${futureDates.length} future date(s) to check: ${futureDates.join(', ')}`);
        
        let updatedAny = false;
        
        for (const futureDate of futureDates) {
            const dayData = allDailyData[futureDate];
            if (!dayData) continue;
            
            const assignments = dayData.scheduleAssignments || {};
            const leagueAssignments = dayData.leagueAssignments || {};
            let dayUpdated = false;
            
            // For each league, recalculate the correct game number for this date
            for (const leagueName of leagueNames) {
                // ★★★ CRITICAL: Count games from all dates BEFORE this future date ★★★
                const gamesPerDateMap = history.gamesPerDate[leagueName] || {};
                let gamesBeforeThisDate = 0;
                
                for (const histDate of Object.keys(gamesPerDateMap)) {
                    if (histDate < futureDate) {
                        gamesBeforeThisDate += gamesPerDateMap[histDate];
                    }
                }
                
                console.log(`[RegularLeagues] ${leagueName} on ${futureDate}: ${gamesBeforeThisDate} games before this date`);
                
                // Find all league entries for this date and update them
                // Track slots we've already processed to avoid double-counting
                const processedSlots = new Set();
                let gameIndexWithinDay = 0;
                
                // Get all division names and sort slots numerically
                const divNames = Object.keys(leagueAssignments).sort();
                
                for (const divName of divNames) {
                    const divData = leagueAssignments[divName] || {};
                    const slotKeys = Object.keys(divData)
                        .filter(k => !isNaN(parseInt(k)))
                        .sort((a, b) => parseInt(a) - parseInt(b));
                    
                    for (const slotIdx of slotKeys) {
                        const leagueData = divData[slotIdx];
                        if (!leagueData) continue;
                        if (leagueData.leagueName !== leagueName) continue;
                        
                       // ★★★ FIX: Deduplicate by actual time, not slot index ★★★
                        // Different divisions can have different slot indices for the same time
                        const divTimes = window.divisionTimes?.[divName] || [];
                        const slotTimeObj = divTimes[parseInt(slotIdx)];
                        const timeKey = slotTimeObj?.startTime || slotTimeObj?.start || `fallback_${slotIdx}`;
                        const Utils = window.SchedulerCoreUtils;
                        const normalizedTimeKey = Utils?.parseTimeToMinutes?.(timeKey) ?? timeKey;
                        const slotKey = `time_${normalizedTimeKey}`;
                        if (processedSlots.has(slotKey)) continue;
                        processedSlots.add(slotKey);
                        
                        const currentLabel = leagueData.gameLabel || '';
                        const match = currentLabel.match(/Game\s+(\d+)/i);
                        
                        if (match) {
                            const currentNum = parseInt(match[1], 10);
                            const correctNum = gamesBeforeThisDate + gameIndexWithinDay + 1;
                            
                            console.log(`[RegularLeagues] Slot ${slotIdx}: Current Game ${currentNum}, Should be Game ${correctNum}`);
                            
                            if (currentNum !== correctNum) {
                                console.log(`[RegularLeagues] 📝 Updating ${leagueName} on ${futureDate} slot ${slotIdx}: Game ${currentNum} → Game ${correctNum}`);
                                
                               // ★★★ FIX: Update ALL divisions that have this league at the SAME TIME ★★★
                                for (const d of divNames) {
                                    const dData = leagueAssignments[d] || {};
                                    for (const dSlot of Object.keys(dData)) {
                                        if (dData[dSlot]?.leagueName !== leagueName) continue;
                                        // Check if this slot is at the same time
                                        const dTimes = window.divisionTimes?.[d] || [];
                                        const dTimeObj = dTimes[parseInt(dSlot)];
                                        const dTimeKey = dTimeObj?.startTime || dTimeObj?.start || `fallback_${dSlot}`;
                                        const dNormalized = Utils?.parseTimeToMinutes?.(dTimeKey) ?? dTimeKey;
                                        if (`time_${dNormalized}` === slotKey) {
                                            dData[dSlot].gameLabel = `Game ${correctNum}`;
                                        }
                                    }
                                }
                                dayUpdated = true;
                            }
                            
                            gameIndexWithinDay++;
                        }
                    }
                }
                
                // Also update scheduleAssignments entries
                const processedBunkSlots = new Set();
                
                for (const bunk of Object.keys(assignments)) {
                    const bunkSchedule = assignments[bunk];
                    if (!Array.isArray(bunkSchedule)) continue;
                    
                    for (let i = 0; i < bunkSchedule.length; i++) {
                        const entry = bunkSchedule[i];
                        if (!entry) continue;
                        
                        // Check if this is a league entry for our league
                        const activityName = entry._activity || entry.field || '';
                        const entryLeagueName = entry._leagueName || '';
                        
                        const isThisLeague = activityName.includes(`League: ${leagueName}`) || 
                                            entryLeagueName === leagueName ||
                                            (entry._h2h && activityName.includes(leagueName));
                        
                        if (!isThisLeague) continue;
                        
                        // Avoid double-processing same slot
                        const slotKey = `${i}`;
                        if (processedBunkSlots.has(slotKey)) continue;
                        processedBunkSlots.add(slotKey);
                        
                        const gameLabel = entry._gameLabel || entry.sport || '';
                        const match = gameLabel.match(/Game\s+(\d+)/i);
                        
                        if (match) {
                            const currentNum = parseInt(match[1], 10);
                            // Recalculate based on slot position within day
                            // Find which game index this slot corresponds to
                            const slotGameIndex = Array.from(processedSlots).indexOf(`${i}`);
                            const correctNum = gamesBeforeThisDate + (slotGameIndex >= 0 ? slotGameIndex : 0) + 1;
                            
                            if (currentNum !== correctNum) {
                                // Update ALL bunks at this slot
                                for (const b of Object.keys(assignments)) {
                                    const bSchedule = assignments[b];
                                    if (Array.isArray(bSchedule) && bSchedule[i]) {
                                        const e = bSchedule[i];
                                        if (e._gameLabel) e._gameLabel = `Game ${correctNum}`;
                                        if (e.sport && e.sport.includes('Game')) e.sport = `Game ${correctNum}`;
                                        
                                        // Update matchup strings if present
                                        if (e._allMatchups && Array.isArray(e._allMatchups)) {
                                            e._allMatchups = e._allMatchups.map(m => 
                                                m.replace(/Game\s+\d+/gi, `Game ${correctNum}`)
                                            );
                                        }
                                    }
                                }
                                dayUpdated = true;
                            }
                        }
                    }
                    
                    // Only iterate bunks once to find slots, then break
                    break;
                }
            }
            
            if (dayUpdated) {
                allDailyData[futureDate].scheduleAssignments = assignments;
                allDailyData[futureDate].leagueAssignments = leagueAssignments;
                updatedAny = true;
                console.log(`[RegularLeagues] ✅ Updated schedule for ${futureDate}`);
            }
        }
        
        // Save all updated daily data
        if (updatedAny) {
            try {
                const DAILY_DATA_KEY = "campDailyData_v1";
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(allDailyData));
                
                // Also sync to cloud
                if (typeof window.saveGlobalSettings === 'function') {
                    // ★★★ FIX: Cloud-sync EACH modified future date individually ★★★
for (const futureDate of Object.keys(allDailyData)) {
    if (futureDate.match(/^\d{4}-\d{2}-\d{2}$/) && allDailyData[futureDate]?.scheduleAssignments) {
        window.ScheduleDB?.saveSchedule?.(futureDate, allDailyData[futureDate], { skipFilter: true });
    }
}
                }
                
                console.log(`[RegularLeagues] ✅ Saved updated future schedules to storage`);
            } catch (e) {
                console.error("[RegularLeagues] Failed to save updated future schedules:", e);
            }
        }
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
// =========================================================================
    // ★★★ AWAY DOUBLEHEADER ENGINE ★★★
    // =========================================================================
    function getAwayDoubleheaderMatchups(league, gameNumber, history) {
        var teams = league.teams || [];
        var config = league.awayDoubleheader || {};
        var groupSize = config.groupSize || 4;
        var gamesPerVisit = config.gamesPerVisit || 2;

        if (teams.length < 4) return null;

        // Build stable groups
        var groups = [];
        for (var i = 0; i < teams.length; i += groupSize) {
            var group = teams.slice(i, i + groupSize);
            if (group.length >= 2) groups.push(group);
        }
        if (groups.length < 2) return null;

        // Which group travels today
        var visitIndex = Math.floor((gameNumber - 1) / gamesPerVisit);
        var gameWithinVisit = (gameNumber - 1) % gamesPerVisit;
        var groupIndex = visitIndex % groups.length;
        var groupTeams = groups[groupIndex];

        // Group's own round-robin
        var groupRR = generateRoundRobinSchedule(groupTeams);
        var totalRounds = groupRR.length;
        if (totalRounds === 0) return null;

        // Track each group's pointer independently
        if (!history._awayState) history._awayState = {};
        var stateKey = league.name + '_group' + groupIndex;
        if (history._awayState[stateKey] === undefined) {
            history._awayState[stateKey] = 0;
        }

        var roundPointer = history._awayState[stateKey];
        var roundIdx = (roundPointer + gameWithinVisit) % totalRounds;
        var matchups = groupRR[roundIdx];

        console.log('[AwayDoubleheader] Game #' + gameNumber + ': Visit ' + (visitIndex + 1) + ', Group ' + (groupIndex + 1) + '/' + groups.length);
        console.log('[AwayDoubleheader]   Teams: [' + groupTeams.join(', ') + ']');
        console.log('[AwayDoubleheader]   Game ' + (gameWithinVisit + 1) + '/' + gamesPerVisit + ' | Round ' + (roundIdx + 1) + '/' + totalRounds + ' (pointer=' + roundPointer + ')');
        matchups.forEach(function(m) { console.log('   \uD83C\uDFDF\uFE0F ' + m[0] + ' vs ' + m[1]); });

        // Advance pointer after LAST game of this visit
        if (gameWithinVisit === gamesPerVisit - 1) {
            history._awayState[stateKey] = (roundPointer + gamesPerVisit) % totalRounds;
            console.log('[AwayDoubleheader]   \u2705 Pointer advanced \u2192 ' + history._awayState[stateKey]);
        }

        return {
            groupIndex: groupIndex,
            groupTeams: groupTeams,
            matchups: matchups,
            gameWithinVisit: gameWithinVisit,
            gamesPerVisit: gamesPerVisit,
            isAwayDoubleheader: true,
            roundIndex: roundIdx,
            totalRounds: totalRounds
        };
    }
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
    // ★★★ OFF-CAMPUS DOUBLE-HEADER ENGINE ★★★
    // =========================================================================

    function ocTeamsFromMatchup(m) {
        if (Array.isArray(m)) return [m[0], m[1]];
        return [m.teamA || m[0], m.teamB || m[1]];
    }

    function ocFindRepairings(teams, game1Matchups) {
        var game1Pairs = new Set();
        for (var i = 0; i < game1Matchups.length; i++) {
            var p = ocTeamsFromMatchup(game1Matchups[i]);
            game1Pairs.add(p[0] + '|' + p[1]); game1Pairs.add(p[1] + '|' + p[0]);
        }
        var results = [];
        function findMatchings(remaining, current) {
            if (remaining.length === 0) { results.push([...current]); return; }
            if (remaining.length === 1) return;
            var first = remaining[0], rest = remaining.slice(1);
            for (var i = 0; i < rest.length; i++) {
                if (game1Pairs.has(first + '|' + rest[i])) continue;
                current.push([first, rest[i]]);
                findMatchings([...rest.slice(0, i), ...rest.slice(i + 1)], current);
                current.pop();
            }
        }
        findMatchings([...teams], []);
        return results.length > 0 ? results : null;
    }

    function ocGetCombinations(arr, k) {
        if (k === 0) return [[]]; if (arr.length < k) return [];
        var results = [];
        function combine(start, current) {
            if (current.length === k) { results.push([...current]); return; }
            for (var i = start; i <= arr.length - (k - current.length); i++) { current.push(arr[i]); combine(i + 1, current); current.pop(); }
        }
        combine(0, []); return results;
    }

    function ocSelectBestRepairing(repairings, history, leagueName) {
        if (repairings.length === 1) return repairings[0];
        var best = repairings[0], bestScore = Infinity;
        for (var ri = 0; ri < repairings.length; ri++) {
            var score = 0;
            for (var mi = 0; mi < repairings[ri].length; mi++) {
                var pair = repairings[ri][mi];
                score += (history.matchupHistory || {})[leagueName + ':' + [pair[0], pair[1]].sort().join('-vs-')] || 0;
            }
            if (score < bestScore) { bestScore = score; best = repairings[ri]; }
        }
        return best;
    }

    function ocGetZoneSports(zoneName, leagueSports, context) {
        var zoneFields = window.getFieldsInZone?.(zoneName) || [];
        var allFields = context.fields || [];
        var zoneSports = new Set();
        for (var i = 0; i < zoneFields.length; i++) {
            var fc = allFields.find(function(f) { return f.name === zoneFields[i]; });
            if (fc && fc.activities) fc.activities.forEach(function(s) { if (leagueSports.includes(s)) zoneSports.add(s); });
        }
        return zoneSports;
    }

    function ocSportRepeatPenalty(team, zoneSports, history, leagueName, priority) {
        var th = getTeamSportHistory(leagueName, team, history);
        if (th.length === 0) return 0;
        var recent = th.slice(-Math.min(th.length, 6));
        var cnt = 0;
        for (var i = 0; i < recent.length; i++) { if (zoneSports.has(recent[i])) cnt++; }
        var lastWas = zoneSports.has(th[th.length - 1]) ? 1 : 0;
        return priority === 'sport_variety' ? (cnt * 500) + (lastWas * 2000) : (cnt * 10) + (lastWas * 50);
    }

    function ocSelectGroups(game1Matchups, teamsPerDay, history, leagueName, priority, zoneSports) {
        var away = Math.floor(teamsPerDay / 2);
        if (away <= 0 || away >= game1Matchups.length) return null;
        console.log('[OffCampus] Selecting ' + away + ' matchup(s), priority: ' + priority);
        var combos = ocGetCombinations(game1Matchups, away);
        var bestCombo = null, bestScore = Infinity, bestROff = null, bestROn = null;
        for (var ci = 0; ci < combos.length; ci++) {
            var combo = combos[ci], offT = [], onM = [], onT = [];
            combo.forEach(function(m) { var p = ocTeamsFromMatchup(m); offT.push(p[0], p[1]); });
            game1Matchups.forEach(function(m) { if (combo.indexOf(m) === -1) { onM.push(m); var p = ocTeamsFromMatchup(m); onT.push(p[0], p[1]); } });
            var rOff = ocFindRepairings(offT, combo); if (!rOff) continue;
            var rOn = ocFindRepairings(onT, onM); if (!rOn) continue;
            var trip = 0, maxI = 0, sp = 0;
            offT.forEach(function(t) { var c = (history.offCampusCounts||{})[leagueName+'|'+t]||0; trip += c; if (c > maxI) maxI = c; sp += ocSportRepeatPenalty(t, zoneSports, history, leagueName, priority); });
            var score = trip * 10000 + maxI * 1000 + sp;
            if (score < bestScore) { bestScore = score; bestCombo = combo; bestROff = rOff; bestROn = rOn; }
        }
        if (!bestCombo) return null;
        var fOff = [], fOn = [], fOnM = game1Matchups.filter(function(m){return bestCombo.indexOf(m)===-1;});
        bestCombo.forEach(function(m){var p=ocTeamsFromMatchup(m);fOff.push(p[0],p[1]);});
        fOnM.forEach(function(m){var p=ocTeamsFromMatchup(m);fOn.push(p[0],p[1]);});
        console.log('[OffCampus] Off: ' + fOff.join(',') + ' | On: ' + fOn.join(','));
        return {
            offCampus: { game1: bestCombo.map(function(m){return ocTeamsFromMatchup(m);}), game2: ocSelectBestRepairing(bestROff, history, leagueName), teams: fOff },
            onCampus: { game1: fOnM.map(function(m){return ocTeamsFromMatchup(m);}), game2: ocSelectBestRepairing(bestROn, history, leagueName), teams: fOn }
        };
    }

    function ocFindLinkedPairs(blocksByTime, sortedTimeKeys) {
        var pairMap = {};
        sortedTimeKeys.forEach(function(tk) {
            blocksByTime[tk].allBlocks.forEach(function(b) {
                if (!b._doubleHeaderPairId) return;
                if (!pairMap[b._doubleHeaderPairId]) pairMap[b._doubleHeaderPairId] = [];
                if (pairMap[b._doubleHeaderPairId].indexOf(tk) === -1) pairMap[b._doubleHeaderPairId].push(tk);
            });
        });
        return pairMap;
    }

    function ocRecordTrips(history, leagueName, teams) {
        if (!history.offCampusCounts) history.offCampusCounts = {};
        teams.forEach(function(t) { history.offCampusCounts[leagueName+'|'+t] = (history.offCampusCounts[leagueName+'|'+t]||0) + 1; });
    }

    window.viewOffCampusHistory = function(ln) {
        var c = ((window.loadGlobalSettings?.()||{}).leagueHistory||{}).offCampusCounts||{};
        var f = {};
        Object.keys(c).forEach(function(k) { if (!ln||k.indexOf(ln+'|')===0) { var p=k.split('|'); if(!f[p[0]])f[p[0]]={}; f[p[0]][p[1]]=c[k]; } });
        for (var l in f) { console.log('League: '+l); console.table(f[l]); }
        return f;
    };
    window.resetOffCampusHistory = function(ln) {
        var h = ((window.loadGlobalSettings?.()||{}).leagueHistory||{});
        if (ln) { var c=h.offCampusCounts||{}; Object.keys(c).forEach(function(k){if(k.indexOf(ln+'|')===0)delete c[k];}); } else { h.offCampusCounts={}; }
        window.saveGlobalSettings?.('leagueHistory', h);
    };
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
                // ★★★ FIX: Normalize time key to minutes for consistent cross-division grouping ★★★
                // Different divisions may store startTime as string vs number or with formatting differences
                const Utils = window.SchedulerCoreUtils;
                const rawTime = block.startTime;
                const key = (typeof rawTime === 'number') ? rawTime :
                    (Utils?.parseTimeToMinutes?.(rawTime) ?? String(rawTime).trim());
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
     const sortedTimeKeys = Object.keys(blocksByTime).sort((a, b) => Number(a) - Number(b));

        // ★★★ OFF-CAMPUS: Propagate _doubleHeaderPairId from skeleton to league blocks ★★★
        const manualSkeleton = window.dailyOverrideSkeleton || window.loadCurrentDailyData?.()?.manualSkeleton || [];
        manualSkeleton.forEach(function(skelItem) {
            if (!skelItem._doubleHeaderPairId || skelItem.type !== 'league') return;
            var skelStart = window.SchedulerCoreUtils?.parseTimeToMinutes?.(skelItem.startTime);
            sortedTimeKeys.forEach(function(tk) {
                if (Math.abs(Number(tk) - skelStart) > 5) return;
                blocksByTime[tk].allBlocks.forEach(function(b) {
                    if (b.type !== 'league' && !/league/i.test(b.event)) return;
                    if (skelItem.leagueName && b.leagueName && skelItem.leagueName !== b.leagueName) return;
                    if (skelItem.division && b.divName && String(skelItem.division) !== String(b.divName)) return;
                    b._doubleHeaderPairId = skelItem._doubleHeaderPairId;
                });
            });
        });

        // ★★★ OFF-CAMPUS DOUBLE-HEADER PRE-PROCESSING ★★★
        const offCampusScheduled = {};
        var linkedPairs = ocFindLinkedPairs(blocksByTime, sortedTimeKeys);

        for (const league of Object.values(masterLeagues)) {
            if (!league.offCampus?.enabled || !league.offCampus?.zone || !league.offCampus?.teamsPerDay) continue;
            if (!league.enabled || disabledLeagues?.includes(league.name)) continue;

            for (var pairId in linkedPairs) {
                var timeKeys = linkedPairs[pairId].sort(function(a,b){return Number(a)-Number(b);});
                if (timeKeys.length < 2) continue;
                var timeKey1 = timeKeys[0], timeKey2 = timeKeys[1];

                var matchesLeague = blocksByTime[timeKey1].allBlocks.some(function(b) {
                    if (b.leagueName) return b.leagueName === league.name;
                    return Object.keys(blocksByTime[timeKey1].byDivision).some(function(d) { return (league.divisions||[]).includes(d); });
                });
                if (!matchesLeague) continue;

                console.log('[OffCampus] Pair "' + pairId + '" for "' + league.name + '" at ' + timeKey1 + '/' + timeKey2);

                if (leagueGameCounters[league.name] === undefined) leagueGameCounters[league.name] = 0;
                var leagueTeams = league.teams || [];
                if (leagueTeams.length < 4) continue;

                var baseGN = calculateStartingGameNumber(league.name, dayId, history);
                var gameNum = baseGN + leagueGameCounters[league.name] + 1;
                var fullSched = generateRoundRobinSchedule(leagueTeams);
                var g1Matchups = fullSched[(gameNum - 1) % fullSched.length] || [];
                if (g1Matchups.length === 0) continue;

                var lSports = league.sports || ['General Sport'];
                var zoneSports = ocGetZoneSports(league.offCampus.zone, lSports, context);
                var priority = league.schedulingPriority || 'sport_variety';
                var dh = ocSelectGroups(g1Matchups, league.offCampus.teamsPerDay, history, league.name, priority, zoneSports);
                if (!dh) continue;

                ocRecordTrips(history, league.name, dh.offCampus.teams);

                var ocDivs = league.divisions.filter(function(d) { return Object.keys(blocksByTime[timeKey1]?.byDivision||{}).includes(d); });
                var s1 = blocksByTime[timeKey1].allBlocks[0]?.slots || [];
                var s2 = blocksByTime[timeKey2].allBlocks[0]?.slots || [];
                var zoneF = window.getFieldsInZone?.(league.offCampus.zone) || [];
                var fp1 = buildAvailableFieldSportPool(lSports, context, ocDivs, timeKey1, s1);
                var fp2 = buildAvailableFieldSportPool(lSports, context, ocDivs, timeKey2, s2);

                var g1Off = assignMatchupsToFieldsAndSports(dh.offCampus.game1, fp1.filter(function(p){return zoneF.includes(p.field);}), league.name, history, s1, priority);
                var g1On = assignMatchupsToFieldsAndSports(dh.onCampus.game1, fp1.filter(function(p){return !zoneF.includes(p.field);}), league.name, history, s1, priority);
                var g2Off = assignMatchupsToFieldsAndSports(dh.offCampus.game2, fp2.filter(function(p){return zoneF.includes(p.field);}), league.name, history, s2, priority);
                var g2On = assignMatchupsToFieldsAndSports(dh.onCampus.game2, fp2.filter(function(p){return !zoneF.includes(p.field);}), league.name, history, s2, priority);
                var g1All = g1Off.concat(g1On), g2All = g2Off.concat(g2On);
                var lbl1 = league.name + ' Game ' + gameNum, lbl2 = league.name + ' Game ' + (gameNum + 1);

              if (g1All.length > 0 && fillBlock) {
                    ocDivs.forEach(function(d) {
                        var blocksForDiv = (blocksByTime[timeKey1]?.byDivision[d]) || [];
                        blocksForDiv.forEach(function(block) {
                            var pick = {
                                field: 'League: ' + league.name,
                                sport: 'Game ' + gameNum,
                                _activity: 'League: ' + league.name,
                                _h2h: true, _fixed: true,
                                _allMatchups: g1All.map(function(a){ return a.team1+' vs '+a.team2+' @ '+a.field+' ('+a.sport+')'; }),
                                _gameLabel: lbl1
                            };
                            fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                            block.processed = true;
                        });
                    });
                    var uf1 = [...new Set(g1All.map(function(a){return a.field;}))];                    if (window.GlobalFieldLocks && s1.length > 0) {
                        var ds1 = window.divisionTimes?.[ocDivs[0]]||[];
                        var st1 = ds1[s1[0]]?.startMin, en1 = ds1[s1[s1.length-1]]?.endMin||st1+40;
                        uf1.forEach(function(f){window.GlobalFieldLocks.lockField(f,s1,league.name,'league',{startMin:st1,endMin:en1});});
                    }
                }
               if (g2All.length > 0 && fillBlock) {
                    ocDivs.forEach(function(d) {
                        var blocksForDiv = (blocksByTime[timeKey2]?.byDivision[d]) || [];
                        blocksForDiv.forEach(function(block) {
                            var pick = {
                                field: 'League: ' + league.name,
                                sport: 'Game ' + (gameNum + 1),
                                _activity: 'League: ' + league.name,
                                _h2h: true, _fixed: true,
                                _allMatchups: g2All.map(function(a){ return a.team1+' vs '+a.team2+' @ '+a.field+' ('+a.sport+')'; }),
                                _gameLabel: lbl2
                            };
                            fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                            block.processed = true;
                        });
                    });
                    var uf2 = [...new Set(g2All.map(function(a){return a.field;}))];
                    if (window.GlobalFieldLocks && s2.length > 0) {
                        var ds2 = window.divisionTimes?.[ocDivs[0]]||[];
                        var st2 = ds2[s2[0]]?.startMin, en2 = ds2[s2[s2.length-1]]?.endMin||st2+40;
                        uf2.forEach(function(f){window.GlobalFieldLocks.lockField(f,s2,league.name,'league',{startMin:st2,endMin:en2});});
                    }
                }

                [g1All, g2All].forEach(function(aa) { aa.forEach(function(a) {
                    if (a.sport) { recordTeamSport(league.name, a.team1||a.teamA, a.sport, history); recordTeamSport(league.name, a.team2||a.teamB, a.sport, history); }
                    recordMatchup(league.name, a.team1||a.teamA, a.team2||a.teamB, history);
                }); });

                leagueGameCounters[league.name] += 2;
                if (!history.gamesPerDate[league.name]) history.gamesPerDate[league.name] = {};
                history.gamesPerDate[league.name][dayId] = (history.gamesPerDate[league.name][dayId]||0) + 2;
                blocksByTime[timeKey1].allBlocks.forEach(function(b){b.processed=true;});
                blocksByTime[timeKey2].allBlocks.forEach(function(b){b.processed=true;});
                offCampusScheduled[league.name] = { handled: true };
                console.log('[OffCampus] ' + lbl1 + ' + ' + lbl2 + ' | Away: ' + dh.offCampus.teams.join(',') + ' | Home: ' + dh.onCampus.teams.join(','));
            }
        }

        // Normal league processing
        for (const timeKey of sortedTimeKeys) {
            const timeData = blocksByTime[timeKey];
            if (timeData.allBlocks.every(b => b.processed)) {
                console.log('\nSkipping time ' + timeKey + ' (off-campus handled)');
                continue;
            }            const divisionsAtTime = Object.keys(timeData.byDivision);

            console.log(`\n📅 Processing League Time Slot: ${timeKey}`);
            console.log(`   Divisions present: [${divisionsAtTime.join(", ")}]`);

            // Get slots for this time
            const sampleBlock = timeData.allBlocks[0];
            const slots = sampleBlock?.slots || [];

            const processedLeagues = new Set();
            // ★★★ MULTIPLE LEAGUE SUPPORT: Check if blocks at this time specify a league ★★★
            const blocksAtTime = timeData.allBlocks;
            const specifiedLeagueNames = new Set(
                blocksAtTime
                    .map(b => b.leagueName)
                    .filter(Boolean)
            );
            
            const applicableLeagues = Object.values(masterLeagues).filter(l => {
                if (!l.enabled) return false;
                if (disabledLeagues?.includes(l.name)) return false;
                if (!l.divisions || l.divisions.length === 0) return false;
                
                // ★★★ If blocks specify a league name, ONLY allow that league ★★★
                if (specifiedLeagueNames.size > 0) {
                    if (!specifiedLeagueNames.has(l.name)) return false;
                }
                
                return divisionsAtTime.some(div => l.divisions.includes(div));
            });

            console.log(`   Applicable leagues: [${applicableLeagues.map(l => l.name).join(', ')}]`);
            if (specifiedLeagueNames.size > 0) {
                console.log(`   ★ Filtered by block leagueName: [${[...specifiedLeagueNames].join(', ')}]`);
            }

            for (const league of applicableLeagues) {
                if (processedLeagues.has(league.name)) continue;
                processedLeagues.add(league.name);
                if (offCampusScheduled[league.name]?.handled) {
                    console.log('   Skipping "' + league.name + '" (off-campus double-header)');
                    continue;
                }

                const leagueDivisions = league.divisions.filter(div => divisionsAtTime.includes(div));
                if (leagueDivisions.length === 0) continue;
// ★★★ MULTIPLE LEAGUE SUPPORT: Only process divisions whose blocks match this league ★★★
                const filteredLeagueDivisions = leagueDivisions.filter(div => {
                    const divsBlocks = timeData.byDivision[div] || [];
                    // If ANY block in this division specifies a different league, skip this division for this league
                    const hasSpecific = divsBlocks.some(b => b.leagueName);
                    if (!hasSpecific) return true; // No specific league = accept all
                    return divsBlocks.some(b => b.leagueName === league.name);
                });
                
                if (filteredLeagueDivisions.length === 0) {
                    console.log(`   ⏭️ Skipping "${league.name}" — no matching divisions at this time`);
                    continue;
                }
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
                
                // ★★★ Get matchups — check for Away Doubleheader mode ★★★
                let matchups;
                let awayInfo = null;
                
                if (league.awayDoubleheader?.enabled) {
                    awayInfo = getAwayDoubleheaderMatchups(league, gameNumber, history);
                    if (awayInfo) {
                        matchups = awayInfo.matchups;
                        console.log('   \uD83D\uDE8C Away DH: Group ' + (awayInfo.groupIndex + 1) + ' [' + awayInfo.groupTeams.join(', ') + ']');
                        console.log('   \uD83C\uDFAE Game ' + (awayInfo.gameWithinVisit + 1) + '/' + awayInfo.gamesPerVisit + ' (Round ' + (awayInfo.roundIndex + 1) + '/' + awayInfo.totalRounds + ')');
                    } else {
                        console.log('   \u26A0\uFE0F Away doubleheader: no matchups generated');
                        matchups = [];
                    }
                } else {
                    const fullSchedule = generateRoundRobinSchedule(leagueTeams);
                    const roundIndex = (gameNumber - 1) % fullSchedule.length;
                    matchups = fullSchedule[roundIndex] || [];
                }

               console.log(`   Game #${gameNumber} (Today's Game: ${todayGameIndex + 1})`);
                console.log(`   Matchups: ${matchups.length}`);
                matchups.forEach(m => {
                    var t1 = Array.isArray(m) ? m[0] : m;
                    var t2 = Array.isArray(m) ? m[1] : m;
                    console.log(`      • ${t1} vs ${t2}`);
                });

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
    // ★★★ FIX: Include time range for cross-division lock detection ★★★
    const sampleBlock = timeData.allBlocks[0];
    const leagueDivName = leagueDivisions[0];
    const leagueDivSlots = window.divisionTimes?.[leagueDivName] || [];
    let lockStartMin = null, lockEndMin = null;
    if (slots.length > 0 && leagueDivSlots[slots[0]]) {
        lockStartMin = leagueDivSlots[slots[0]].startMin;
        lockEndMin = leagueDivSlots[slots[slots.length - 1]]?.endMin || lockStartMin + 40;
    }
    
    // ★★★ FIX v13.1: Include time range for cross-division lock detection ★★★
var _leagueDivSlots = window.divisionTimes?.[leagueDivisions[0]] || [];
var _lockStartMin = null, _lockEndMin = null;
if (slots.length > 0 && _leagueDivSlots[slots[0]]) {
    _lockStartMin = _leagueDivSlots[slots[0]].startMin;
    _lockEndMin = _leagueDivSlots[slots[slots.length - 1]]?.endMin || (_lockStartMin + 40);
}
window.GlobalFieldLocks.lockMultipleFields(usedFields, slots, {
    lockedBy: 'regular_league',
    leagueName: league.name,
    division: leagueDivisions.join(', '),
    activity: `${league.name} League Game`,
    startMin: _lockStartMin,
    endMin: _lockEndMin
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

                // ★ v7.1 FIX: Merge into existing round state instead of overwriting
                if (!window.leagueRoundState) window.leagueRoundState = {};
                const existingState = window.leagueRoundState[league.name] || {};
                window.leagueRoundState[league.name] = {
                    ...existingState,
                    currentRound: gameNumber,
                    lastScheduledDate: dayId,
                    sportRotationIndex: (existingState.sportRotationIndex || 0) + 1
                };
            }
        }

        // ★★★ SAVE GAMES PER DATE FOR EACH LEAGUE ★★★
        for (const [leagueName, count] of Object.entries(leagueGameCounters)) {
            if (count > 0) {
                recordGamesOnDate(leagueName, dayId, count, history);
            }
        }

        saveLeagueHistory(history);

        // ★ v7.1 FIX: Sync leagueRoundState with gamesPerDate and persist to cloud
        if (window.leagueRoundState) {
            Object.keys(leagueGameCounters).forEach(leagueName => {
                if (!window.leagueRoundState[leagueName]) return;
                window.leagueRoundState[leagueName].gamesPerDate = 
                    history.gamesPerDate?.[leagueName] || {};
            });
            
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('leagueRoundState', window.leagueRoundState);
                console.log("[RegularLeagues] ✅ leagueRoundState synced to cloud");
            }
        }

        // ★★★ UPDATE FUTURE SCHEDULES TO MAINTAIN CHRONOLOGICAL ORDER ★★★
        updateFutureSchedules(dayId, history);

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
