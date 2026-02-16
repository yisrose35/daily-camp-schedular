// ============================================================================
// scheduler_core_specialty_leagues.js (FIXED v3 - CHRONOLOGICAL DATE ORDERING)
//
// DEDICATED SCHEDULER CORE FOR SPECIALTY LEAGUES
//
// CRITICAL UPDATE:
// - Now uses CHRONOLOGICAL date ordering (not creation order)
// - Persists history to cloud via saveGlobalSettings
// - Uses GlobalFieldLocks to LOCK fields before assignment
// - Checks for existing locks before using a field
// - Fields locked by specialty leagues are COMPLETELY unavailable to all others
// ============================================================================

(function() {
    'use strict';

    const SpecialtyLeagues = {};

    // =========================================================================
    // PERSISTENT HISTORY KEY
    // =========================================================================
    const SPECIALTY_HISTORY_KEY = "campSpecialtyLeagueHistory_v1";

    // =========================================================================
    // LOAD/SAVE HISTORY (NOW CLOUD-SYNCED)
    // =========================================================================

    function loadSpecialtyHistory() {
        try {
            // ★ First try to load from cloud-synced global settings
            const global = window.loadGlobalSettings?.() || {};
            if (global.specialtyLeagueHistory && Object.keys(global.specialtyLeagueHistory).length > 0) {
                const history = global.specialtyLeagueHistory;
                // Ensure all fields exist
                history.teamFieldRotation = history.teamFieldRotation || {};
                history.lastSlotOrder = history.lastSlotOrder || {};
                history.conferenceRounds = history.conferenceRounds || {};
                history.matchupHistory = history.matchupHistory || {};
                history.gamesPerDate = history.gamesPerDate || {};  // ★ NEW
                console.log("[SpecialtyLeagues] ✅ Loaded history from cloud");
                return history;
            }
            
            // Fallback to localStorage
            const raw = localStorage.getItem(SPECIALTY_HISTORY_KEY);
            if (!raw) return {
                teamFieldRotation: {},
                lastSlotOrder: {},
                conferenceRounds: {},
                matchupHistory: {},
                gamesPerDate: {}  // ★ NEW: { leagueId: { "2025-01-01": 2, "2025-01-02": 3 } }
            };
            
            const history = JSON.parse(raw);
            // Ensure new fields exist
            history.teamFieldRotation = history.teamFieldRotation || {};
            history.lastSlotOrder = history.lastSlotOrder || {};
            history.conferenceRounds = history.conferenceRounds || {};
            history.matchupHistory = history.matchupHistory || {};
            history.gamesPerDate = history.gamesPerDate || {};
            
            // Migrate old format if needed
            if (history.roundCounters && !history.gamesPerDate) {
                console.log("[SpecialtyLeagues] Migrating old history format...");
                history.gamesPerDate = {};
            }
            
            return history;
        } catch (e) {
            console.error("[SpecialtyLeagues] Failed to load history:", e);
            return {
                teamFieldRotation: {},
                lastSlotOrder: {},
                conferenceRounds: {},
                matchupHistory: {},
                gamesPerDate: {}
            };
        }
    }

    function saveSpecialtyHistory(history) {
        try {
            // Save to localStorage as backup
            localStorage.setItem(SPECIALTY_HISTORY_KEY, JSON.stringify(history));
            
            // ★ CRITICAL: Also save to cloud via global settings
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('specialtyLeagueHistory', history);
                console.log("[SpecialtyLeagues] ✅ History saved to cloud");
            }
        } catch (e) {
            console.error("[SpecialtyLeagues] Failed to save history:", e);
        }
    }

    // =========================================================================
    // ★ NEW: CHRONOLOGICAL GAME NUMBERING
    // =========================================================================

    /**
     * Calculate the starting game number for a given date based on
     * all games that occurred on EARLIER dates (chronologically)
     */
    function calculateStartingGameNumber(leagueId, currentDate, history) {
        if (!history.gamesPerDate) history.gamesPerDate = {};
        if (!history.gamesPerDate[leagueId]) history.gamesPerDate[leagueId] = {};
        
        const gamesMap = history.gamesPerDate[leagueId];
        
        // Sum games from all dates BEFORE currentDate (chronologically)
        let total = 0;
        for (const date of Object.keys(gamesMap)) {
            if (date < currentDate) {
                total += gamesMap[date];
            }
        }
        
        console.log(`[SpecialtyLeagues] Starting game# for league ${leagueId} on ${currentDate}: ${total + 1} (${total} games on earlier dates)`);
        return total;
    }

    /**
     * Record how many games occurred on a given date for a league
     */
    function recordGamesOnDate(leagueId, currentDate, numGames, history) {
        if (!history.gamesPerDate) history.gamesPerDate = {};
        if (!history.gamesPerDate[leagueId]) history.gamesPerDate[leagueId] = {};
        
        history.gamesPerDate[leagueId][currentDate] = numGames;
        console.log(`[SpecialtyLeagues] Recorded ${numGames} game(s) for league ${leagueId} on ${currentDate}`);
    }

    /**
     * ★ CRITICAL: Update game numbers in all schedules that come AFTER the current date
     * This ensures chronological consistency when schedules are created out of order
     */
    function updateFutureSchedules(currentDate, history) {
        console.log(`[SpecialtyLeagues] 🔄 Checking for future schedules to update...`);
        console.log(`[SpecialtyLeagues] Current history.gamesPerDate:`, JSON.stringify(history.gamesPerDate, null, 2));
        
        // Get all unique league IDs from history
        const leagueIds = Object.keys(history.gamesPerDate || {});
        if (leagueIds.length === 0) {
            console.log(`[SpecialtyLeagues] No league history found, skipping update.`);
            return;
        }
        
        // Load specialty league config to get names
        const specialtyLeaguesConfig = loadSpecialtyLeagues();
        
        // Load all daily data
        const allDailyData = window.loadAllDailyData?.() || {};
        const futureDates = Object.keys(allDailyData)
            .filter(date => {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
                return date > currentDate;
            })
            .sort();
        
        if (futureDates.length === 0) {
            console.log(`[SpecialtyLeagues] No future schedules to update.`);
            return;
        }
        
        console.log(`[SpecialtyLeagues] Found ${futureDates.length} future date(s) to check: ${futureDates.join(', ')}`);
        
        let updatedAny = false;
        
        for (const futureDate of futureDates) {
            const dayData = allDailyData[futureDate];
            if (!dayData) continue;
            
            const assignments = dayData.scheduleAssignments || {};
            const leagueAssignments = dayData.leagueAssignments || {};
            let dayUpdated = false;
            
            // For each league, recalculate the correct game number for this date
            for (const leagueId of leagueIds) {
                const league = specialtyLeaguesConfig[leagueId];
                const leagueName = league?.name || leagueId;
                
                // ★★★ CRITICAL: Count games from all dates BEFORE this future date ★★★
                const gamesPerDateMap = history.gamesPerDate[leagueId] || {};
                let gamesBeforeThisDate = 0;
                
                for (const histDate of Object.keys(gamesPerDateMap)) {
                    if (histDate < futureDate) {
                        gamesBeforeThisDate += gamesPerDateMap[histDate];
                    }
                }
                
                console.log(`[SpecialtyLeagues] ${leagueName} on ${futureDate}: ${gamesBeforeThisDate} games before this date`);
                
                // Track slots we've already processed
                const processedSlots = new Set();
                let gameIndexWithinDay = 0;
                
                // Check leagueAssignments for this league
                const divNames = Object.keys(leagueAssignments).sort();
                
                for (const divName of divNames) {
                    const divData = leagueAssignments[divName] || {};
                    const slotKeys = Object.keys(divData)
                        .filter(k => !isNaN(parseInt(k)))
                        .sort((a, b) => parseInt(a) - parseInt(b));
                    
                    for (const slotIdx of slotKeys) {
                        const leagueData = divData[slotIdx];
                        if (!leagueData || !leagueData.isSpecialtyLeague) continue;
                        if (leagueData.leagueName !== leagueName && leagueData.leagueName !== leagueId) continue;
                        
                        const slotKey = `${slotIdx}`;
                        if (processedSlots.has(slotKey)) continue;
                        processedSlots.add(slotKey);
                        
                        const currentLabel = leagueData.gameLabel || '';
                        const match = currentLabel.match(/Game\s+(\d+)/i);
                        
                        if (match) {
                            const currentNum = parseInt(match[1], 10);
                            const correctNum = gamesBeforeThisDate + gameIndexWithinDay + 1;
                            
                            console.log(`[SpecialtyLeagues] Slot ${slotIdx}: Current Game ${currentNum}, Should be Game ${correctNum}`);
                            
                            if (currentNum !== correctNum) {
                                console.log(`[SpecialtyLeagues] 📝 Updating ${leagueName} on ${futureDate}: Game ${currentNum} → Game ${correctNum}`);
                                
                                // Update in ALL divisions that have this slot
                                for (const d of divNames) {
                                    if (leagueAssignments[d]?.[slotIdx]?.isSpecialtyLeague &&
                                        (leagueAssignments[d][slotIdx].leagueName === leagueName || 
                                         leagueAssignments[d][slotIdx].leagueName === leagueId)) {
                                        leagueAssignments[d][slotIdx].gameLabel = `Game ${correctNum}`;
                                    }
                                }
                                dayUpdated = true;
                            }
                            
                            gameIndexWithinDay++;
                        }
                    }
                }
                
                // Also update scheduleAssignments
                const processedBunkSlots = new Set();
                
                for (const bunk of Object.keys(assignments)) {
                    const bunkSchedule = assignments[bunk];
                    if (!Array.isArray(bunkSchedule)) continue;
                    
                    for (let i = 0; i < bunkSchedule.length; i++) {
                        const entry = bunkSchedule[i];
                        if (!entry || !entry._isSpecialtyLeague) continue;
                        
                        const entryLeagueName = entry._leagueName || '';
                        if (entryLeagueName !== leagueName && entryLeagueName !== leagueId) continue;
                        
                        const slotKey = `${i}`;
                        if (processedBunkSlots.has(slotKey)) continue;
                        processedBunkSlots.add(slotKey);
                        
                        const gameLabel = entry._gameLabel || '';
                        const match = gameLabel.match(/Game\s+(\d+)/i);
                        
                        if (match) {
                            const currentNum = parseInt(match[1], 10);
                            const slotGameIndex = Array.from(processedSlots).indexOf(`${i}`);
                            const correctNum = gamesBeforeThisDate + (slotGameIndex >= 0 ? slotGameIndex : 0) + 1;
                            
                            if (currentNum !== correctNum) {
                                const newLabel = `${leagueName} Game ${correctNum}`;
                                
                                // Update ALL bunks at this slot
                                for (const b of Object.keys(assignments)) {
                                    const bSchedule = assignments[b];
                                    if (Array.isArray(bSchedule) && bSchedule[i] && bSchedule[i]._isSpecialtyLeague) {
                                        bSchedule[i]._gameLabel = newLabel;
                                        bSchedule[i].field = newLabel;
                                        bSchedule[i]._activity = newLabel;
                                        
                                        if (bSchedule[i]._allMatchups && Array.isArray(bSchedule[i]._allMatchups)) {
                                            bSchedule[i]._allMatchups = bSchedule[i]._allMatchups.map(m => 
                                                m.replace(/Game\s+\d+/gi, `Game ${correctNum}`)
                                            );
                                        }
                                    }
                                }
                                dayUpdated = true;
                            }
                        }
                    }
                    break;
                }
            }
            
            if (dayUpdated) {
                allDailyData[futureDate].scheduleAssignments = assignments;
                allDailyData[futureDate].leagueAssignments = leagueAssignments;
                updatedAny = true;
                console.log(`[SpecialtyLeagues] ✅ Updated schedule for ${futureDate}`);
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
                
                console.log(`[SpecialtyLeagues] ✅ Saved updated future schedules to storage`);
            } catch (e) {
                console.error("[SpecialtyLeagues] Failed to save updated future schedules:", e);
            }
        }
    }

    // =========================================================================
    // HELPER: Load specialty leagues from global settings
    // =========================================================================

    function loadSpecialtyLeagues() {
        const global = window.loadGlobalSettings?.() || {};
        return global.specialtyLeagues || {};
    }

    // =========================================================================
    // FAIRNESS ALGORITHM: Wait Priority Score
    // =========================================================================

    function getWaitPriorityScore(teamA, teamB, lastSlotOrder, leagueId) {
        const keyA = `${leagueId}|${teamA}`;
        const keyB = `${leagueId}|${teamB}`;

        const slotA = lastSlotOrder[keyA] || 1;
        const slotB = lastSlotOrder[keyB] || 1;

        const scoreA = (slotA - 1) * 50;
        const scoreB = (slotB - 1) * 50;

        return scoreA + scoreB;
    }

    // =========================================================================
    // FAIRNESS ALGORITHM: Field Rotation Score
    // =========================================================================

    function getFieldRotationScore(teamA, teamB, fieldName, teamFieldRotation, allFields, leagueId) {
        const keyA = `${leagueId}|${teamA}`;
        const keyB = `${leagueId}|${teamB}`;

        const fieldsA = teamFieldRotation[keyA] || [];
        const fieldsB = teamFieldRotation[keyB] || [];

        const countA = fieldsA.filter(f => f === fieldName).length;
        const countB = fieldsB.filter(f => f === fieldName).length;

        if (countA === 0 && countB === 0) return 200;
        if (countA === 0 || countB === 0) return 100;

        const allFieldsSet = new Set(allFields);
        const uniqueA = new Set(fieldsA);
        const uniqueB = new Set(fieldsB);

        const missingA = [...allFieldsSet].filter(f => !uniqueA.has(f));
        const missingB = [...allFieldsSet].filter(f => !uniqueB.has(f));

        if (missingA.length > 0 || missingB.length > 0) {
            return -100 * (countA + countB);
        }

        return -10 * (countA + countB);
    }

    // =========================================================================
    // ROUND ROBIN GENERATOR
    // =========================================================================

    function generateRoundRobin(teams) {
        if (!teams || teams.length < 2) return [];

        const rounds = [];
        const teamsCopy = [...teams];

        if (teamsCopy.length % 2 === 1) {
            teamsCopy.push(null);
        }

        const numRounds = teamsCopy.length - 1;
        const half = teamsCopy.length / 2;

        for (let round = 0; round < numRounds; round++) {
            const matches = [];

            for (let i = 0; i < half; i++) {
                const team1 = teamsCopy[i];
                const team2 = teamsCopy[teamsCopy.length - 1 - i];

                if (team1 && team2) {
                    matches.push({
                        teamA: team1,
                        teamB: team2
                    });
                }
            }

            rounds.push(matches);

            const last = teamsCopy.pop();
            teamsCopy.splice(1, 0, last);
        }

        return rounds;
    }

    // =========================================================================
    // GET TODAY'S MATCHUPS FOR A LEAGUE (Using chronological game number)
    // =========================================================================

    function getLeagueMatchupsForToday(league, history, gameNumber) {
        const {
            id,
            teams,
            conferences,
            allowInterConference,
            interConferencePriority
        } = league;

        if (!teams || teams.length < 2) return [];

        let matchups = [];

        const conferenceNames = Object.keys(conferences || {}).filter(c => (conferences[c]?.length || 0) > 0);

        if (conferenceNames.length > 0) {
            conferenceNames.forEach(confName => {
                const confTeams = conferences[confName] || [];
                const roundRobin = generateRoundRobin(confTeams);

                // Use gameNumber - 1 as the round index
                const currentRound = (gameNumber - 1) % Math.max(1, roundRobin.length);

                if (roundRobin[currentRound]) {
                    matchups.push(...roundRobin[currentRound].map(m => ({
                        ...m,
                        conference: confName,
                        isInterConference: false
                    })));
                }
            });

            if (allowInterConference && conferenceNames.length >= 2) {
                const conf1Teams = conferences[conferenceNames[0]] || [];
                const conf2Teams = conferences[conferenceNames[1]] || [];

                const interRound = (gameNumber - 1) % Math.max(1, Math.max(conf1Teams.length, conf2Teams.length));

                conf1Teams.forEach((team1, idx) => {
                    const team2Idx = (idx + interRound) % conf2Teams.length;
                    const team2 = conf2Teams[team2Idx];

                    if (team1 && team2) {
                        if (Math.random() < (interConferencePriority || 0.3)) {
                            matchups.push({
                                teamA: team1,
                                teamB: team2,
                                conference: "Inter-Conference",
                                isInterConference: true
                            });
                        }
                    }
                });
            }
        } else {
            const roundRobin = generateRoundRobin(teams);
            const currentRound = (gameNumber - 1) % Math.max(1, roundRobin.length);

            if (roundRobin[currentRound]) {
                matchups = roundRobin[currentRound].map(m => ({
                    ...m,
                    conference: null,
                    isInterConference: false
                }));
            }
        }

        return matchups;
    }

    // =========================================================================
    // ★★★ CRITICAL: ASSIGN MATCHUPS WITH GLOBAL LOCK CHECK ★★★
    // =========================================================================

    function assignMatchupsToFieldsAndSlots(matchups, league, history, slots) {
        const {
            id,
            fields,
            gamesPerFieldSlot
        } = league;

        if (!fields || fields.length === 0) {
            console.warn(`[SpecialtyLeagues] No fields for league ${league.name}`);
            return [];
        }

        // ★★★ FILTER OUT ALREADY-LOCKED FIELDS ★★★
        let availableFields = [...fields];
        if (window.GlobalFieldLocks && slots && slots.length > 0) {
            availableFields = window.GlobalFieldLocks.filterAvailableFields(fields, slots);

            const lockedFields = fields.filter(f => !availableFields.includes(f));
            if (lockedFields.length > 0) {
                console.log(`[SpecialtyLeagues] ⚠️ Fields already locked: ${lockedFields.join(', ')}`);
            }
        }

        if (availableFields.length === 0) {
            console.error(`[SpecialtyLeagues] ❌ NO FIELDS AVAILABLE - all fields are locked!`);
            return [];
        }

        const totalSlotsAvailable = availableFields.length * (gamesPerFieldSlot || 3);

        console.log(`[SpecialtyLeagues] Available fields: ${availableFields.join(', ')}`);
        console.log(`[SpecialtyLeagues] Total game slots: ${totalSlotsAvailable} (${availableFields.length} fields × ${gamesPerFieldSlot || 3} games)`);

        let workingMatchups = [...matchups];
        if (workingMatchups.length > totalSlotsAvailable) {
            workingMatchups = workingMatchups.map(m => ({
                ...m,
                waitScore: getWaitPriorityScore(m.teamA, m.teamB, history.lastSlotOrder, id)
            }));
            workingMatchups.sort((a, b) => b.waitScore - a.waitScore);
            workingMatchups = workingMatchups.slice(0, totalSlotsAvailable);
        }

        console.log(`[SpecialtyLeagues] Working matchups: ${workingMatchups.length}`);

        const assignments = [];
        const assignedMatchups = new Set();
        const fieldGamesCount = {};
        availableFields.forEach(f => fieldGamesCount[f] = 0);

        workingMatchups = workingMatchups.map(m => ({
            ...m,
            waitScore: getWaitPriorityScore(m.teamA, m.teamB, history.lastSlotOrder, id)
        }));
        workingMatchups.sort((a, b) => b.waitScore - a.waitScore);

        for (const matchup of workingMatchups) {
            const matchupKey = `${matchup.teamA}-${matchup.teamB}`;
            if (assignedMatchups.has(matchupKey)) continue;

            let bestField = null;
            let minGames = Infinity;

            for (const field of availableFields) {
                const currentGames = fieldGamesCount[field];
                const maxGames = gamesPerFieldSlot || 3;

                if (currentGames < maxGames && currentGames < minGames) {
                    const rotationScore = getFieldRotationScore(matchup.teamA, matchup.teamB, field, history.teamFieldRotation, availableFields, id);

                    if (currentGames < minGames || (currentGames === minGames && rotationScore > 0)) {
                        minGames = currentGames;
                        bestField = field;
                    }
                }
            }

            if (bestField) {
                const slotOrder = fieldGamesCount[bestField] + 1;
                assignments.push({
                    teamA: matchup.teamA,
                    teamB: matchup.teamB,
                    field: bestField,
                    slotOrder: slotOrder,
                    conference: matchup.conference,
                    isInterConference: matchup.isInterConference
                });

                fieldGamesCount[bestField]++;
                assignedMatchups.add(matchupKey);
                console.log(`[SpecialtyLeagues] ✅ Assigned ${matchup.teamA} vs ${matchup.teamB} to ${bestField} (slot ${slotOrder})`);
            }
        }

        assignments.sort((a, b) => {
            if (a.field !== b.field) return a.field.localeCompare(b.field);
            return a.slotOrder - b.slotOrder;
        });

        console.log(`[SpecialtyLeagues] Field distribution: ${Object.entries(fieldGamesCount).map(([f, c]) => `${f}:${c}`).join(', ')}`);

        return assignments;
    }

    // =========================================================================
    // UPDATE HISTORY AFTER SCHEDULING
    // =========================================================================

    function updateHistoryAfterScheduling(league, assignments, history, currentDate) {
        const { id } = league;

        // Always update field rotation and slot order
        assignments.forEach(game => {
            const keyA = `${id}|${game.teamA}`;
            const keyB = `${id}|${game.teamB}`;

            if (!history.teamFieldRotation[keyA]) history.teamFieldRotation[keyA] = [];
            if (!history.teamFieldRotation[keyB]) history.teamFieldRotation[keyB] = [];
            history.teamFieldRotation[keyA].push(game.field);
            history.teamFieldRotation[keyB].push(game.field);

            history.lastSlotOrder[keyA] = game.slotOrder;
            history.lastSlotOrder[keyB] = game.slotOrder;

            const matchupKey = [game.teamA, game.teamB].sort().join('|');
            const fullKey = `${id}|${matchupKey}`;
            if (!history.matchupHistory[fullKey]) history.matchupHistory[fullKey] = [];
            history.matchupHistory[fullKey].push(currentDate);
        });
    }

    // =========================================================================
    // ★★★ MAIN PROCESSOR: PROCESSES FIRST, LOCKS FIELDS GLOBALLY ★★★
    // =========================================================================

    SpecialtyLeagues.processSpecialtyLeagues = function(context) {
        console.log("\n" + "=".repeat(60));
        console.log("★★★ SPECIALTY LEAGUE SCHEDULER START (PRIORITY 1) ★★★");
        console.log("=".repeat(60));

        const {
            schedulableSlotBlocks,
            divisions,
            fieldUsageBySlot,
            activityProperties,
            fillBlock,
            disabledSpecialtyLeagues
        } = context;

        const specialtyLeaguesConfig = loadSpecialtyLeagues();

        if (!specialtyLeaguesConfig || Object.keys(specialtyLeaguesConfig).length === 0) {
            console.log("[SpecialtyLeagues] No specialty leagues configured.");
            return;
        }

        const history = loadSpecialtyHistory();
        
        // ★★★ GET CURRENT DAY IDENTIFIER ★★★
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        console.log(`[SpecialtyLeagues] Current day: "${currentDate}"`);

        // ★★★ TRACK GAMES PER LEAGUE FOR THIS DAY ★★★
        const leagueGameCounters = {};

        const specialtyBlocks = schedulableSlotBlocks.filter(b =>
            b.type === 'specialty_league' ||
            (b.event && b.event.toLowerCase().includes('specialty league'))
        );

        if (specialtyBlocks.length === 0) {
            console.log("[SpecialtyLeagues] No specialty league blocks in skeleton.");
            return;
        }

        console.log(`[SpecialtyLeagues] Found ${specialtyBlocks.length} specialty league blocks`);

        // Group blocks by division and time
        const blocksByDivisionTime = {};
        specialtyBlocks.forEach(block => {
            const key = `${block.divName}_${block.startTime}`;
            if (!blocksByDivisionTime[key]) {
                blocksByDivisionTime[key] = [];
            }
            blocksByDivisionTime[key].push(block);
        });

        // Process each division/time combination
        for (const [key, blocks] of Object.entries(blocksByDivisionTime)) {
            const [divName, startTime] = key.split('_');

            console.log(`\n[SpecialtyLeagues] Processing ${divName} @ ${startTime}`);

            const league = Object.values(specialtyLeaguesConfig).find(l => {
                if (!l.enabled) return false;
                if (disabledSpecialtyLeagues?.includes(l.name)) return false;
                if (!l.divisions || !l.divisions.includes(divName)) return false;
                return true;
            });

            if (!league) {
                console.log(`[SpecialtyLeagues] No enabled league for division ${divName}`);
                continue;
            }

            console.log(`[SpecialtyLeagues] Using league: ${league.name}`);
            console.log(`[SpecialtyLeagues] Teams: ${(league.teams || []).join(', ')}`);
            console.log(`[SpecialtyLeagues] Configured Fields: ${(league.fields || []).join(', ')}`);
            console.log(`[SpecialtyLeagues] Sport: ${league.sport}`);

            // Get all slots for this league block
            const allSlots = [];
            blocks.forEach(block => {
                if (block.slots) allSlots.push(...block.slots);
            });
            const uniqueSlots = [...new Set(allSlots)].sort((a, b) => a - b);

            // ★★★ CHRONOLOGICAL GAME NUMBERING ★★★
            if (leagueGameCounters[league.id] === undefined) {
                leagueGameCounters[league.id] = 0;
            }
            
            const baseGameNumber = calculateStartingGameNumber(league.id, currentDate, history);
            const todayGameIndex = leagueGameCounters[league.id];
            const gameNumber = baseGameNumber + todayGameIndex + 1;

            // Get today's matchups using the game number
            const matchups = getLeagueMatchupsForToday(league, history, gameNumber);

            if (matchups.length === 0) {
                console.log(`[SpecialtyLeagues] No matchups generated`);
                continue;
            }

            console.log(`[SpecialtyLeagues] Game #${gameNumber} - Generated ${matchups.length} matchups`);
            matchups.forEach(m => console.log(`   • ${m.teamA} vs ${m.teamB} (${m.conference || 'No Conference'})`));

            // ★★★ ASSIGN MATCHUPS - RESPECTING GLOBAL LOCKS ★★★
            const assignments = assignMatchupsToFieldsAndSlots(matchups, league, history, uniqueSlots);

            if (assignments.length === 0) {
                console.log(`[SpecialtyLeagues] ❌ No assignments made`);
                continue;
            }

            // ★★★ INCREMENT TODAY'S GAME COUNTER ★★★
            leagueGameCounters[league.id]++;

            // ★★★ CRITICAL: LOCK ALL USED FIELDS GLOBALLY ★★★
            const usedFields = [...new Set(assignments.map(a => a.field))];
            console.log(`\n[SpecialtyLeagues] 🔒 LOCKING FIELDS: ${usedFields.join(', ')}`);

            if (window.GlobalFieldLocks) {
    // ★★★ FIX: Include time range for cross-division lock detection ★★★
    const divSlots = window.divisionTimes?.[divName] || [];
    let lockStartMin = null, lockEndMin = null;
    if (uniqueSlots.length > 0 && divSlots[uniqueSlots[0]]) {
        lockStartMin = divSlots[uniqueSlots[0]].startMin;
        const lastSlot = divSlots[uniqueSlots[uniqueSlots.length - 1]];
        lockEndMin = lastSlot?.endMin || (lockStartMin + 40);
    }
    
   // ★★★ FIX v13.1: Include time range for cross-division lock detection ★★★
var _specDivSlots = window.divisionTimes?.[divName] || [];
var _specLockStart = null, _specLockEnd = null;
if (uniqueSlots.length > 0 && _specDivSlots[uniqueSlots[0]]) {
    _specLockStart = _specDivSlots[uniqueSlots[0]].startMin;
    _specLockEnd = _specDivSlots[uniqueSlots[uniqueSlots.length - 1]]?.endMin || (_specLockStart + 40);
}
window.GlobalFieldLocks.lockMultipleFields(usedFields, uniqueSlots, {
    lockedBy: 'specialty_league',
    leagueName: league.name,
    division: divName,
    activity: `${league.name} (${league.sport})`,
    startMin: _specLockStart,
    endMin: _specLockEnd
});
}

            // Also lock in fieldUsageBySlot for compatibility
            blocks.forEach(block => {
                block.slots.forEach(slotIdx => {
                    usedFields.forEach(fieldName => {
                        if (!fieldUsageBySlot[slotIdx]) fieldUsageBySlot[slotIdx] = {};
                        fieldUsageBySlot[slotIdx][fieldName] = {
                            count: 999,
                            divisions: [divName],
                            bunks: {},
                            _lockedBySpecialtyLeague: league.name
                        };
                    });
                });
            });

            console.log(`\n[SpecialtyLeagues] Final Assignments for Game #${gameNumber}:`);
            assignments.forEach(a => {
                console.log(`   ✅ ${a.teamA} vs ${a.teamB} @ ${a.field} (Slot ${a.slotOrder})`);
            });

            // Build matchup display strings
            const matchupStrings = assignments.map(a =>
                `${a.teamA} vs ${a.teamB} — ${a.field}`
            );

            const gameLabel = `${league.name} Game ${gameNumber}`;

            // Fill all blocks
            blocks.forEach(block => {
                const pick = {
                    field: gameLabel,
                    sport: league.sport || 'League',
                    _activity: gameLabel,
                    _h2h: true,
                    _fixed: true,
                    _allMatchups: matchupStrings,
                    _gameLabel: gameLabel,
                    _leagueName: league.name,
                    _isSpecialtyLeague: true,
                    _assignments: assignments
                };

                fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                block.processed = true;
            });

            updateHistoryAfterScheduling(league, assignments, history, currentDate);

            // Store in leagueAssignments for UI
            if (!window.leagueAssignments) window.leagueAssignments = {};
            if (!window.leagueAssignments[divName]) window.leagueAssignments[divName] = {};

            const slotIdx = blocks[0]?.slots?.[0];
            if (slotIdx !== undefined) {
                window.leagueAssignments[divName][slotIdx] = {
                    leagueName: league.name,
                    sport: league.sport,
                    gameLabel: gameLabel,
                    isSpecialtyLeague: true,
                    matchups: assignments.map(a => ({
                        teamA: a.teamA,
                        teamB: a.teamB,
                        field: a.field,
                        slotOrder: a.slotOrder,
                        conference: a.conference || null
                    }))
                };
            }
        }

        // ★★★ SAVE GAMES PER DATE FOR EACH LEAGUE ★★★
        for (const [leagueId, count] of Object.entries(leagueGameCounters)) {
            if (count > 0) {
                recordGamesOnDate(leagueId, currentDate, count, history);
            }
        }

        saveSpecialtyHistory(history);

        // ★★★ UPDATE FUTURE SCHEDULES TO MAINTAIN CHRONOLOGICAL ORDER ★★★
        updateFutureSchedules(currentDate, history);

        console.log("\n" + "=".repeat(60));
        console.log("★★★ SPECIALTY LEAGUE SCHEDULER COMPLETE ★★★");
        console.log("=".repeat(60) + "\n");

        // Debug print all locks
        if (window.GlobalFieldLocks) {
            window.GlobalFieldLocks.debugPrintLocks();
        }
    };

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    SpecialtyLeagues.getSpecialtyLeagueScheduleForToday = function(leagueId) {
        const config = loadSpecialtyLeagues();
        const league = config[leagueId];

        if (!league) return null;

        const history = loadSpecialtyHistory();
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const gameNumber = calculateStartingGameNumber(leagueId, currentDate, history) + 1;
        
        const matchups = getLeagueMatchupsForToday(league, history, gameNumber);
        const assignments = assignMatchupsToFieldsAndSlots(matchups, league, history, []);

        return {
            leagueName: league.name,
            sport: league.sport,
            fields: league.fields,
            gamesPerField: league.gamesPerFieldSlot || 3,
            gameNumber: gameNumber,
            assignments: assignments
        };
    };

    SpecialtyLeagues.resetHistory = function() {
        if (confirm("Reset ALL specialty league history? This will start fresh.")) {
            localStorage.removeItem(SPECIALTY_HISTORY_KEY);
            // Also clear from cloud
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('specialtyLeagueHistory', {});
            }
            console.log("[SpecialtyLeagues] History reset.");
            alert("Specialty League history has been reset.");
        }
    };

    SpecialtyLeagues.viewHistory = function() {
        const history = loadSpecialtyHistory();
        console.log("\n=== SPECIALTY LEAGUE HISTORY ===");
        console.log(JSON.stringify(history, null, 2));
        return history;
    };

    SpecialtyLeagues.viewTeamStats = function(leagueId) {
        const history = loadSpecialtyHistory();
        const config = loadSpecialtyLeagues();
        const league = config[leagueId];

        if (!league) {
            console.log("League not found");
            return;
        }

        console.log(`\n=== TEAM STATS: ${league.name} ===`);

        const teams = league.teams || [];
        const stats = {};

        teams.forEach(team => {
            const key = `${leagueId}|${team}`;
            const fieldHistory = history.teamFieldRotation[key] || [];
            const lastSlot = history.lastSlotOrder[key] || 'N/A';

            const fieldCounts = {};
            fieldHistory.forEach(f => {
                fieldCounts[f] = (fieldCounts[f] || 0) + 1;
            });

            stats[team] = {
                gamesPlayed: fieldHistory.length,
                lastSlotOrder: lastSlot,
                fieldUsage: fieldCounts
            };
        });

        console.table(stats);
        return stats;
    };

    SpecialtyLeagues.viewLeagueSchedule = function(leagueId) {
        const history = loadSpecialtyHistory();
        console.log(`\n=== Games Per Date for Specialty League: ${leagueId} ===`);

        if (!history.gamesPerDate || !history.gamesPerDate[leagueId]) {
            console.log("No games recorded for this league.");
            return {};
        }

        const dates = Object.keys(history.gamesPerDate[leagueId]).sort();
        let cumulative = 0;
        
        console.log("Date\t\tGames\tCumulative");
        console.log("-".repeat(40));
        
        dates.forEach(date => {
            const count = history.gamesPerDate[leagueId][date];
            cumulative += count;
            console.log(`${date}\t${count}\t${cumulative}`);
        });
        
        return history.gamesPerDate[leagueId];
    };

    // =========================================================================
    // EXPOSE GLOBALLY
    // =========================================================================

    window.SchedulerCoreSpecialtyLeagues = SpecialtyLeagues;

    if (window.SchedulerCoreLeagues) {
        window.SchedulerCoreLeagues.processSpecialtyLeagues = SpecialtyLeagues.processSpecialtyLeagues;
    }

    console.log('[SpecialtyLeagues] Module loaded with Chronological Date Ordering + Cloud Persistence v3');
})();
