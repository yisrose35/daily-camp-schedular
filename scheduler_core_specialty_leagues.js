// ============================================================================
// scheduler_core_specialty_leagues.js (FIXED v2 - GLOBAL LOCK INTEGRATION)
// 
// DEDICATED SCHEDULER CORE FOR SPECIALTY LEAGUES
// 
// CRITICAL UPDATE:
// - Now uses GlobalFieldLocks to LOCK fields before assignment
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
    // LOAD/SAVE HISTORY
    // =========================================================================
    function loadSpecialtyHistory() {
        try {
            const raw = localStorage.getItem(SPECIALTY_HISTORY_KEY);
            if (!raw) return { 
                teamFieldRotation: {},
                lastSlotOrder: {},
                roundCounters: {},
                conferenceRounds: {},
                matchupHistory: {},
                lastScheduledDate: {}
            };
            return JSON.parse(raw);
        } catch (e) {
            console.error("[SpecialtyLeagues] Failed to load history:", e);
            return { teamFieldRotation: {}, lastSlotOrder: {}, roundCounters: {}, conferenceRounds: {}, matchupHistory: {}, lastScheduledDate: {} };
        }
    }

    function saveSpecialtyHistory(history) {
        try {
            localStorage.setItem(SPECIALTY_HISTORY_KEY, JSON.stringify(history));
        } catch (e) {
            console.error("[SpecialtyLeagues] Failed to save history:", e);
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
                    matches.push({ teamA: team1, teamB: team2 });
                }
            }
            
            rounds.push(matches);
            
            const last = teamsCopy.pop();
            teamsCopy.splice(1, 0, last);
        }
        
        return rounds;
    }

    // =========================================================================
    // GET TODAY'S MATCHUPS FOR A LEAGUE
    // =========================================================================
    function getLeagueMatchupsForToday(league, history) {
        const { id, teams, conferences, allowInterConference, interConferencePriority } = league;
        
        if (!teams || teams.length < 2) return [];
        
        let matchups = [];
        
        const conferenceNames = Object.keys(conferences || {}).filter(c => (conferences[c]?.length || 0) > 0);
        
        if (conferenceNames.length > 0) {
            conferenceNames.forEach(confName => {
                const confTeams = conferences[confName] || [];
                const roundRobin = generateRoundRobin(confTeams);
                
                const confKey = `${id}|${confName}`;
                const currentRound = (history.conferenceRounds[confKey] || 0) % Math.max(1, roundRobin.length);
                
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
                
                const interKey = `${id}|inter`;
                const interRound = (history.conferenceRounds[interKey] || 0) % Math.max(1, Math.max(conf1Teams.length, conf2Teams.length));
                
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
            const currentRound = (history.roundCounters[id] || 0) % Math.max(1, roundRobin.length);
            
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
        const { id, fields, gamesPerFieldSlot } = league;
        
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
    function updateHistoryAfterScheduling(league, assignments, history) {
        const { id, conferences } = league;
        const currentDate = window.currentScheduleDate || new Date().toISOString().slice(0, 10);
        
        if (!history.lastScheduledDate) history.lastScheduledDate = {};
        const isNewDay = history.lastScheduledDate[id] !== currentDate;
        
        if (isNewDay) {
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
            
            const conferenceNames = Object.keys(conferences || {}).filter(c => (conferences[c]?.length || 0) > 0);
            
            if (conferenceNames.length > 0) {
                conferenceNames.forEach(conf => {
                    const confKey = `${id}|${conf}`;
                    history.conferenceRounds[confKey] = (history.conferenceRounds[confKey] || 0) + 1;
                });
                
                if (league.allowInterConference) {
                    const interKey = `${id}|inter`;
                    history.conferenceRounds[interKey] = (history.conferenceRounds[interKey] || 0) + 1;
                }
            } else {
                history.roundCounters[id] = (history.roundCounters[id] || 0) + 1;
            }
            
            history.lastScheduledDate[id] = currentDate;
            
            console.log(`[SpecialtyLeagues] New day (${currentDate}) - incremented round counter`);
        } else {
            console.log(`[SpecialtyLeagues] Same day (${currentDate}) - round counter unchanged`);
        }
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
            
            // Get today's matchups
            const matchups = getLeagueMatchupsForToday(league, history);
            
            if (matchups.length === 0) {
                console.log(`[SpecialtyLeagues] No matchups generated`);
                continue;
            }
            
            console.log(`[SpecialtyLeagues] Generated ${matchups.length} matchups`);
            matchups.forEach(m => console.log(`   • ${m.teamA} vs ${m.teamB} (${m.conference || 'No Conference'})`));
            
            // ★★★ ASSIGN MATCHUPS - RESPECTING GLOBAL LOCKS ★★★
            const assignments = assignMatchupsToFieldsAndSlots(matchups, league, history, uniqueSlots);
            
            if (assignments.length === 0) {
                console.log(`[SpecialtyLeagues] ❌ No assignments made`);
                continue;
            }
            
            // ★★★ CRITICAL: LOCK ALL USED FIELDS GLOBALLY ★★★
            const usedFields = [...new Set(assignments.map(a => a.field))];
            console.log(`\n[SpecialtyLeagues] 🔒 LOCKING FIELDS: ${usedFields.join(', ')}`);
            
            if (window.GlobalFieldLocks) {
                window.GlobalFieldLocks.lockMultipleFields(usedFields, uniqueSlots, {
                    lockedBy: 'specialty_league',
                    leagueName: league.name,
                    division: divName,
                    activity: `${league.name} (${league.sport})`
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
            
            console.log(`\n[SpecialtyLeagues] Final Assignments:`);
            assignments.forEach(a => {
                console.log(`   ✅ ${a.teamA} vs ${a.teamB} @ ${a.field} (Slot ${a.slotOrder})`);
            });
            
            // Build matchup display strings
            const matchupStrings = assignments.map(a => 
                `${a.teamA} vs ${a.teamB} — ${a.field}`
            );
            
            const roundNum = (history.roundCounters[league.id] || 0) + 1;
            const gameLabel = `${league.name} Game ${roundNum}`;
            
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
            
            updateHistoryAfterScheduling(league, assignments, history);
            
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
        
        saveSpecialtyHistory(history);
        
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
        const matchups = getLeagueMatchupsForToday(league, history);
        const assignments = assignMatchupsToFieldsAndSlots(matchups, league, history, []);
        
        return {
            leagueName: league.name,
            sport: league.sport,
            fields: league.fields,
            gamesPerField: league.gamesPerFieldSlot || 3,
            assignments: assignments
        };
    };

    SpecialtyLeagues.resetHistory = function() {
        if (confirm("Reset ALL specialty league history? This will start fresh.")) {
            localStorage.removeItem(SPECIALTY_HISTORY_KEY);
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

    // =========================================================================
    // EXPOSE GLOBALLY
    // =========================================================================
    window.SchedulerCoreSpecialtyLeagues = SpecialtyLeagues;
    
    if (window.SchedulerCoreLeagues) {
        window.SchedulerCoreLeagues.processSpecialtyLeagues = SpecialtyLeagues.processSpecialtyLeagues;
    }

    console.log('[SpecialtyLeagues] Module loaded with Global Lock integration');

})();
