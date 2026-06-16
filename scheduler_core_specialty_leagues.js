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
                history.gameLog = history.gameLog || {};            // ★ FN-55
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
                gamesPerDate: {},  // ★ NEW: { leagueId: { "2025-01-01": 2, "2025-01-02": 3 } }
                gameLog: {}        // ★ FN-55
            };

            const history = JSON.parse(raw);
            // Ensure new fields exist
            history.teamFieldRotation = history.teamFieldRotation || {};
            history.lastSlotOrder = history.lastSlotOrder || {};
            history.conferenceRounds = history.conferenceRounds || {};
            history.matchupHistory = history.matchupHistory || {};
            history.gamesPerDate = history.gamesPerDate || {};
            history.gameLog = history.gameLog || {};
            
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
                gamesPerDate: {},
                gameLog: {}
            };
        }
    }

    function saveSpecialtyHistory(history) {
        // ★ Cloud save FIRST and in its OWN try — see saveLeagueHistory: a full
        //   localStorage must never block the cloud write. Previously a quota error
        //   on the localStorage backup skipped saveGlobalSettings, so the day's games
        //   never synced and the counter reset on the next cold start.
        if (typeof window.saveGlobalSettings === 'function') {
            try {
                window.saveGlobalSettings('specialtyLeagueHistory', history);
                console.log("[SpecialtyLeagues] ✅ History saved to cloud");
            } catch (e) {
                console.error("[SpecialtyLeagues] Failed to save history to cloud:", e);
            }
        }
        // localStorage backup — best-effort; a quota failure here is non-fatal.
        try {
            localStorage.setItem(SPECIALTY_HISTORY_KEY, JSON.stringify(history));
        } catch (e) {
            console.warn("[SpecialtyLeagues] history localStorage backup skipped (quota?):", e);
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
        const modifiedDates = new Set(); // ★ Track which dates actually changed

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
                modifiedDates.add(futureDate); // ★ Only track actually-changed dates
                console.log(`[SpecialtyLeagues] ✅ Updated schedule for ${futureDate}`);
            }
        }

        // Save all updated daily data
        if (updatedAny) {
            try {
                const DAILY_DATA_KEY = "campDailyData_v1";
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(allDailyData));

                // ★★★ FIX: Cloud-sync ONLY the dates that actually changed ★★★
                for (const changedDate of modifiedDates) {
                    if (allDailyData[changedDate]?.scheduleAssignments) {
                        window.ScheduleDB?.saveSchedule?.(changedDate, allDailyData[changedDate], { skipFilter: true });
                    }
                }

                console.log(`[SpecialtyLeagues] ✅ Saved ${modifiedDates.size} updated future schedule(s) to storage`);
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

        // ★★★ FILTER OUT DISABLED AND ALREADY-LOCKED FIELDS ★★★
        const _disabledSet = new Set(window.currentDisabledFields || []);
        let availableFields = fields.filter(f => !_disabledSet.has(f));
        // ★ FN-29: field-config map so specialty leagues honor the same facility configs
        //   sports do — access restrictions, weather availability, and canonical
        //   field.timeRules (fallback when the merged activityProperties copy is empty).
        const _gsSL = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
        const _fcfgSL = {}; ((_gsSL.app1 && _gsSL.app1.fields) || _gsSL.fields || []).forEach(f => { if (f && f.name) _fcfgSL[f.name] = f; });
        if (window.GlobalFieldLocks && slots && slots.length > 0) {
            availableFields = window.GlobalFieldLocks.filterAvailableFields(availableFields, slots);

            const lockedFields = fields.filter(f => !availableFields.includes(f));
            if (lockedFields.length > 0) {
                console.log(`[SpecialtyLeagues] ⚠️ Fields already locked: ${lockedFields.join(', ')}`);
            }
        }

        // ★★★ FILTER OUT FIELDS BLOCKED BY TIME RULES ★★★
        // Per-grade scoping: skip rules whose `divisions` list doesn't
        // intersect this league's active divisions. Empty/missing list = all.
        if (slots && slots.length > 0) {
            const _divSlots = window.divisionTimes?.[Object.keys(window.divisionTimes || {})[0]] || [];
            const _slotStart = _divSlots[slots[0]]?.startMin;
            const _slotEnd = _divSlots[slots[slots.length - 1]]?.endMin;
            if (_slotStart != null && _slotEnd != null) {
                const _parseMin = window.SchedulerCoreUtils?.parseTimeToMinutes;
                const _curDivs = (Array.isArray(league.divisions) ? league.divisions : []).map(String);
                availableFields = availableFields.filter(fName => {
                    const rules = (window.activityProperties?.[fName]?.timeRules) || (_fcfgSL[fName] && _fcfgSL[fName].timeRules) || null;
                    if (!rules || rules.length === 0) return true;
                    let hasAvail = false, inAvail = false;
                    for (const r of rules) {
                        const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                        if (rDivs.length > 0 && _curDivs.length > 0 && !rDivs.some(d => _curDivs.includes(d))) continue;
                        const rS = r.startMin ?? (_parseMin ? _parseMin(r.start || r.startTime) : null);
                        const rE = r.endMin ?? (_parseMin ? _parseMin(r.end || r.endTime) : null);
                        if (rS == null || rE == null) continue;
                        const rType = (r.type || '').toLowerCase();
                        if ((rType === 'unavailable' || r.available === false) && rS < _slotEnd && rE > _slotStart) return false;
                        if (rType === 'available' || r.available === true) {
                            hasAvail = true;
                            if (_slotStart >= rS && _slotEnd <= rE) inAvail = true;
                        }
                    }
                    return !hasAvail || inAvail;
                });
            }
        }

        // ★ FN-29: honor access restrictions + weather availability (the same field
        //   configs sports respect). Time rules handled above; combined-field
        //   exclusivity is handled in the assignment loop (_effectiveGames /
        //   FieldCombos.getExclusiveFields). Additive filter — only removes fields.
        {
            const _slDivs = (Array.isArray(league.divisions) ? league.divisions : []).map(String);
            const _slRainy = window.isRainyDay === true;
            availableFields = availableFields.filter(fName => {
                const fc = _fcfgSL[fName]; if (!fc) return true;
                if (fc.accessRestrictions && fc.accessRestrictions.enabled) {
                    const allowed = Object.keys(fc.accessRestrictions.divisions || {});
                    if (allowed.length > 0 && !_slDivs.some(d => allowed.includes(d))) return false;
                }
                if (_slRainy && !(fc.rainyDayAvailable === true || fc.isIndoor === true)) return false;
                return true;
            });
        }

        // ★ Orphan-court gate (mirrors scheduler_core_loader.filterSpecialsByFacility):
        //   drop any configured court that no longer exists in the facilities/fields
        //   registry — a deleted court, a typo, or a name like "Basketball Court A" that
        //   was never created. Without this the league schedules AND globally locks games
        //   on courts that don't exist (LG-25). Fail-open: if the registry can't be read,
        //   keep all (never silently drop everything).
        try {
            const _facsReg = (typeof window.getFacilities === 'function') ? window.getFacilities() : null;
            const _facNamesReg = Array.isArray(_facsReg) ? _facsReg.map(f => (f && f.name) || f) : (_facsReg ? Object.keys(_facsReg) : []);
            const _validReg = new Set(_facNamesReg.concat(Object.keys(_fcfgSL)).filter(Boolean).map(n => String(n).trim().toLowerCase()));
            if (_validReg.size) {
                const _beforeReg = availableFields.slice();
                availableFields = availableFields.filter(fName => _validReg.has(String(fName).trim().toLowerCase()));
                const _ghosts = _beforeReg.filter(f => !availableFields.includes(f));
                if (_ghosts.length) console.warn(`[SpecialtyLeagues] ⚠️ Dropped ${_ghosts.length} court(s) not in your facilities — create them or remove from league "${league.name}": ${_ghosts.join(', ')}`);
            }
        } catch (_eReg) { /* fail open — keep availableFields as-is */ }

        if (availableFields.length === 0) {
            console.error(`[SpecialtyLeagues] ❌ NO COURTS AVAILABLE for "${league.name}" — its configured courts are locked, blocked by time rules, or don't exist in your facilities. Add real courts to the league.`);
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

        // Combo-aware "effective games count": at slotOrder N, all of
        // {Full Gym, Gym 1, Gym 2} share capacity — a game on any one of them
        // consumes that slot for the others. Compute the effective count as
        // the max of the field's own count and its combo partners' counts.
        const _effectiveGames = (field) => {
            let v = fieldGamesCount[field] || 0;
            const partners = window.FieldCombos?.getExclusiveFields?.(field) || [];
            for (const p of partners) {
                const pv = fieldGamesCount[p];
                if (pv != null && pv > v) v = pv;
            }
            return v;
        };

        workingMatchups = workingMatchups.map(m => ({
            ...m,
            waitScore: getWaitPriorityScore(m.teamA, m.teamB, history.lastSlotOrder, id)
        }));
        workingMatchups.sort((a, b) => b.waitScore - a.waitScore);

        for (const matchup of workingMatchups) {
            // ★ FN-9: TBD forecast placeholders all carry teamA/teamB = "TBD", so a
            //   plain "TBD-TBD" key collapses every undecided matchup into one and
            //   reserves only a single field. Key TBD placeholders by their unique
            //   _tbdIndex so each reserves its own field; real matchups unchanged.
            const matchupKey = matchup._playoffTBD
                ? `TBD-${matchup._tbdIndex != null ? matchup._tbdIndex : (matchup._playoffSport || '')}`
                : `${matchup.teamA}-${matchup.teamB}`;
            if (assignedMatchups.has(matchupKey)) continue;

            let bestField = null;
            let minGames = Infinity;

            // ★ Playoff: if this matchup has a user-chosen field, prefer it
            //   when still under the per-field game cap. Falls through to
            //   the normal rotation-aware pick if it's not available.
            if (matchup._playoffField && availableFields.includes(matchup._playoffField)) {
                const cur = _effectiveGames(matchup._playoffField);
                if (cur < (gamesPerFieldSlot || 3)) {
                    bestField = matchup._playoffField;
                    minGames = cur;
                }
            }

            if (!bestField) for (const field of availableFields) {
                const currentGames = _effectiveGames(field);
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
                const slotOrder = _effectiveGames(bestField) + 1;
                assignments.push({
                    teamA: matchup.teamA,
                    teamB: matchup.teamB,
                    field: bestField,
                    slotOrder: slotOrder,
                    conference: matchup.conference,
                    isInterConference: matchup.isInterConference
                });

                fieldGamesCount[bestField] = slotOrder;
                // Bump combo partners to the same slotOrder so a future game
                // can't be assigned to a partner at the slot we just consumed.
                const partners = window.FieldCombos?.getExclusiveFields?.(bestField) || [];
                for (const p of partners) {
                    if (fieldGamesCount[p] != null && fieldGamesCount[p] < slotOrder) {
                        fieldGamesCount[p] = slotOrder;
                    }
                }
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

    function updateHistoryAfterScheduling(league, assignments, history, currentDate, gameLabel) {
        const { id } = league;

        // ★ FN-55: date-keyed game log — see rollbackDayRecords below.
        if (!history.gameLog) history.gameLog = {};
        if (!history.gameLog[id]) history.gameLog[id] = {};
        if (!history.gameLog[id][currentDate]) history.gameLog[id][currentDate] = [];

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

            history.gameLog[id][currentDate].push({ tA: game.teamA, tB: game.teamB, field: game.field, g: gameLabel || null });
        });
    }

    // =========================================================================
    // ★ FN-55: DATE-KEYED GAME LOG — makes a day's records reversible
    // =========================================================================
    // Specialty analog of the regular engine's FN-54: teamFieldRotation and
    // matchupHistory had no memory of which date contributed an entry, so
    // regenerating a date re-recorded all of its games (field-rotation arrays
    // and matchup date-arrays inflate) and deleting a date left them behind.
    // Every recorded game now also lands in history.gameLog[id][date] so a
    // regeneration or date-delete can subtract exactly what that date
    // contributed. lastSlotOrder is overwrite-only and needs no rollback.

    function rollbackDayRecords(leagueId, date, history) {
        const entries = history.gameLog?.[leagueId]?.[date];
        if (!entries || !entries.length) return 0;
        entries.forEach(function (e) {
            if (e.field) {
                [e.tA, e.tB].forEach(function (team) {
                    if (!team) return;
                    const arr = history.teamFieldRotation[`${leagueId}|${team}`];
                    if (!arr) return;
                    const idx = arr.lastIndexOf(e.field);
                    if (idx !== -1) arr.splice(idx, 1);
                });
            }
            if (e.tA && e.tB) {
                const mk = `${leagueId}|${[e.tA, e.tB].sort().join('|')}`;
                const dates = history.matchupHistory[mk];
                if (Array.isArray(dates)) {
                    const di = dates.indexOf(date);
                    if (di !== -1) dates.splice(di, 1);
                    if (dates.length === 0) delete history.matchupHistory[mk];
                }
            }
        });
        const n = entries.length;
        delete history.gameLog[leagueId][date];
        console.log(`[SpecialtyLeagues] ↩️ Rolled back ${n} logged game record(s) for league ${leagueId} on ${date}`);
        return n;
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

        // ★ FN-55: a generation that covers a specialty league's divisions
        // REPLACES that league's games for this date — subtract what the date
        // previously logged before anything re-records. In-play = a specialty
        // block's division OR a generated division (context.generatedDivisions
        // catches a regen whose skeleton dropped the specialty tile, which
        // previously left ghost games in the history forever).
        const _dayResetLeaguesS = new Set();
        (function () {
            const _divsInPlay = new Set(specialtyBlocks.map(function (b) { return b.divName; }).filter(Boolean));
            (context.generatedDivisions || []).forEach(function (d) { _divsInPlay.add(d); });
            Object.values(specialtyLeaguesConfig).forEach(function (l) {
                if (!l || !l.id) return;
                if (!(l.divisions || []).some(function (d) { return _divsInPlay.has(d); })) return;
                _dayResetLeaguesS.add(l.id);
                rollbackDayRecords(l.id, currentDate, history);
                if (history.gamesPerDate?.[l.id]?.[currentDate] !== undefined) {
                    delete history.gamesPerDate[l.id][currentDate];
                }
            });
        })();

        if (specialtyBlocks.length === 0) {
            if (_dayResetLeaguesS.size > 0) {
                // Day regenerated without specialty tiles — persist the reset
                // and clear the date's auto-saved result games.
                saveSpecialtyHistory(history);
                updateFutureSchedules(currentDate, history);
                _dayResetLeaguesS.forEach(function (id) {
                    try { window.SpecialtyLeaguesAPI?.syncGamesFromGeneration?.(id, currentDate, []); } catch (e) {}
                });
                console.log('[SpecialtyLeagues] Day records reset for ' + _dayResetLeaguesS.size + ' league(s) (no specialty blocks this run).');
            } else {
                console.log("[SpecialtyLeagues] No specialty league blocks in skeleton.");
            }
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

        // ★ Shared specialty leagues: when 2+ divisions reference the SAME
        //   specialty league at the SAME time slot (e.g. 8th & 9th both play
        //   ABBL @1035) it is ONE game, not separate games. The first division
        //   processed schedules + locks the fields; the rest REUSE that single
        //   game (identical matchups/fields) instead of trying to schedule a
        //   second game and colliding with the locks (which left the 2nd
        //   division empty). Keyed by `${league.id}_${startTime}`.
        const scheduledLeagueSlots = {};

        // Process each division/time combination
        for (const [key, blocks] of Object.entries(blocksByDivisionTime)) {
            const [divName, startTime] = key.split('_');

            console.log(`\n[SpecialtyLeagues] Processing ${divName} @ ${startTime}`);

            // ★ Honor the tile's chosen league: if a block names a valid
            //   specialty league for this division, schedule THAT one. Fall back
            //   to the division's first enabled specialty league when the tile
            //   has no pick (legacy tiles) or names something that isn't a valid
            //   specialty league here (e.g. a stale/regular name from the old
            //   dropdown) — matching the previous default rather than scheduling
            //   nothing.
            const _pickedLeagueName = (blocks.find(b => b && b.leagueName) || {}).leagueName || null;
            let league = _pickedLeagueName
                ? Object.values(specialtyLeaguesConfig).find(l =>
                    l && l.enabled &&
                    !disabledSpecialtyLeagues?.includes(l.name) &&
                    l.name === _pickedLeagueName &&
                    (l.divisions || []).includes(divName)
                  )
                : null;
            if (league) {
                console.log(`[SpecialtyLeagues] ${divName} @ ${startTime}: honoring tile pick "${_pickedLeagueName}"`);
            } else {
                if (_pickedLeagueName) {
                    console.log(`[SpecialtyLeagues] ${divName} @ ${startTime}: tile pick "${_pickedLeagueName}" isn't a valid specialty league here — using division default`);
                }
                league = Object.values(specialtyLeaguesConfig).find(l => {
                    if (!l.enabled) return false;
                    if (disabledSpecialtyLeagues?.includes(l.name)) return false;
                    if (!l.divisions || !l.divisions.includes(divName)) return false;
                    return true;
                });
            }

            if (!league) {
                console.log(`[SpecialtyLeagues] No enabled league for division ${divName}`);
                continue;
            }

            // ★ Reuse path: this league already played at this slot this run
            //   (another division sharing it). Show the SAME game here — do not
            //   schedule a second game, re-lock fields, or re-record history.
            const _shareKey = `${league.id}_${startTime}`;
            const _shared = scheduledLeagueSlots[_shareKey];
            if (_shared) {
                console.log(`[SpecialtyLeagues] ${divName} shares ${_shared.gameLabel} with an earlier division @${startTime} — reusing the same game`);
                if (!window.leagueAssignments) window.leagueAssignments = {};
                blocks.forEach(block => {
                    fillBlock(block, Object.assign({}, _shared.pick), fieldUsageBySlot, {}, true, activityProperties);
                    block.processed = true;
                    const _sIdx = block.slots && block.slots[0];
                    if (_sIdx !== undefined) {
                        if (!window.leagueAssignments[block.divName]) window.leagueAssignments[block.divName] = {};
                        window.leagueAssignments[block.divName][_sIdx] = _shared.uiEntry;
                    }
                });
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

            // ★★★ Get matchups — playoff > regular ★★★
            let matchups;
            let _playoffRoundNum = null;
            let _playoffIsTBD = false;
            const _PM_S = window.PlayoffMode;
            if (_PM_S && _PM_S.isLeagueInPlayoff(league)) {
                const liveMatchups = _PM_S.getActiveMatchups(league);
                if (liveMatchups.length > 0) {
                    if (todayGameIndex === 0) {
                        _playoffRoundNum = league.playoff.currentRound;
                        matchups = liveMatchups.map(function (m) {
                            return {
                                teamA: m.teamA,
                                teamB: m.teamB,
                                conference: null,
                                isInterConference: false,
                                _playoffSport: m.sport || null,
                                _playoffField: m.field || null
                            };
                        });
                        console.log('[SpecialtyLeagues] 🏆 PLAYOFF Round ' + _playoffRoundNum + ': ' + liveMatchups.length + ' active matchup(s)');
                    } else {
                        // Game 2+ same day: emit TBD placeholders for forecast next round.
                        const tbdRoundNum = league.playoff.currentRound + todayGameIndex;
                        const tbdCount = Math.max(1, Math.ceil(liveMatchups.length / Math.pow(2, todayGameIndex)));
                        const sportsPool = liveMatchups
                            .map(function (m) { return m.sport || null; })
                            .filter(Boolean);
                        const fallbackSport = league.sport || null;
                        _playoffRoundNum = tbdRoundNum;
                        _playoffIsTBD = true;
                        matchups = [];
                        for (let k = 0; k < tbdCount; k++) {
                            matchups.push({
                                teamA: 'TBD',
                                teamB: 'TBD',
                                conference: null,
                                isInterConference: false,
                                _playoffSport: sportsPool.length ? sportsPool[k % sportsPool.length] : fallbackSport,
                                _playoffField: null,
                                _playoffTBD: true,
                                // ★ FN-9: unique per-placeholder id so the field-assignment
                                //   dedup doesn't collapse every "TBD-TBD" matchup into one
                                //   (which reserved only a SINGLE field for a multi-matchup
                                //   undecided round, starving the others).
                                _tbdIndex: k
                            });
                        }
                        console.log('[SpecialtyLeagues] 🏆 PLAYOFF Round ' + tbdRoundNum + ' TBD: ' + tbdCount + ' placeholder matchup(s)');
                    }
                } else {
                    console.log('[SpecialtyLeagues] 🏆 PLAYOFF: no active matchups in current round — skipping');
                    continue;
                }
            } else {
                matchups = getLeagueMatchupsForToday(league, history, gameNumber);
            }

            if (matchups.length === 0) {
                console.log(`[SpecialtyLeagues] No matchups generated`);
                continue;
            }

            console.log(`[SpecialtyLeagues] Game #${gameNumber} - Generated ${matchups.length} matchups`);
            matchups.forEach(m => console.log(`   • ${m.teamA} vs ${m.teamB} (${m.conference || 'No Conference'})`));

            // ★★★ ASSIGN MATCHUPS - RESPECTING GLOBAL LOCKS ★★★
            const assignments = assignMatchupsToFieldsAndSlots(matchups, league, history, uniqueSlots);

            // Carry playoff sport through to assignments for display/downstream
            if (_playoffRoundNum && assignments.length > 0) {
                const _muSportMap = {};
                matchups.forEach(function (m) {
                    if (m._playoffSport) _muSportMap[m.teamA + '|' + m.teamB] = m._playoffSport;
                });
                assignments.forEach(function (a) {
                    var _ps = _muSportMap[a.teamA + '|' + a.teamB];
                    if (_ps) a._playoffSport = _ps;
                });
            }

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
var _specDivSlots = window.divisionTimes?.[divName] || [];
var _specLockStart = null, _specLockEnd = null;
if (uniqueSlots.length > 0 && _specDivSlots[uniqueSlots[0]]) {
    _specLockStart = _specDivSlots[uniqueSlots[0]].startMin;
    _specLockEnd = _specDivSlots[uniqueSlots[uniqueSlots.length - 1]]?.endMin || (_specLockStart + 40);
}
window.GlobalFieldLocks.lockMultipleFields(usedFields, uniqueSlots, {
    lockedBy: _playoffRoundNum ? 'playoff_specialty' : 'specialty_league',
    leagueName: league.name,
    division: divName,
    activity: _playoffRoundNum
        ? (`${league.name} Playoff R${_playoffRoundNum}` + (_playoffIsTBD ? ' TBD' : ''))
        : `${league.name} (${league.sport})`,
    startMin: _specLockStart,
    endMin: _specLockEnd
});

// ★★★ PLAYOFF: lock reserved activities for non-playoff kids ★★★
if (_playoffRoundNum && league.playoff && Array.isArray(league.playoff.reservedActivities) && league.playoff.reservedActivities.length > 0) {
    const reservedReason = `Playoff reserve (${league.name} R${_playoffRoundNum}` + (_playoffIsTBD ? ' TBD)' : ')');
    league.playoff.reservedActivities.forEach(function (act) {
        try {
            window.GlobalFieldLocks.lockFieldForDivision(act, uniqueSlots, divName, reservedReason);
        } catch (e) {
            console.warn('[PLAYOFF specialty] failed to reserve "' + act + '" for ' + divName + ':', e);
        }
    });
    console.log('[SpecialtyLeagues] 🎯 PLAYOFF: reserved [' + league.playoff.reservedActivities.join(', ') + '] for ' + divName);
}
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

            const gameLabel = _playoffRoundNum
                ? (`${league.name} Playoff R${_playoffRoundNum}` + (_playoffIsTBD ? ' TBD' : ''))
                : `${league.name} Game ${gameNumber}`;

            // Build the fill pick + UI entry ONCE — identical for every block,
            // and reused verbatim by any other division that shares this game.
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
                _assignments: assignments,
                _playoffRound: _playoffRoundNum || null
            };
            const uiEntry = {
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

            // Fill all blocks for this division + store its UI entry.
            if (!window.leagueAssignments) window.leagueAssignments = {};
            blocks.forEach(block => {
                fillBlock(block, Object.assign({}, pick), fieldUsageBySlot, {}, true, activityProperties);
                block.processed = true;
                const _sIdx = block.slots && block.slots[0];
                if (_sIdx !== undefined) {
                    if (!window.leagueAssignments[block.divName]) window.leagueAssignments[block.divName] = {};
                    window.leagueAssignments[block.divName][_sIdx] = uiEntry;
                }
            });

            updateHistoryAfterScheduling(league, assignments, history, currentDate, gameLabel);

            // ★ Record this league+slot so other divisions that share the same
            //   specialty league at the same time reuse this single game.
            scheduledLeagueSlots[`${league.id}_${startTime}`] = { pick, uiEntry, gameLabel };
        }

        // ★★★ SAVE GAMES PER DATE FOR EACH LEAGUE ★★★
        for (const [leagueId, count] of Object.entries(leagueGameCounters)) {
            if (count > 0) {
                recordGamesOnDate(leagueId, currentDate, count, history);
            }
        }

        saveSpecialtyHistory(history);

        // ★ FN-58: auto-save the day's games into the Specialty Leagues
        // results store — no manual "Import from Schedule" needed. The sync
        // swaps out the date's auto-saved games while preserving scores
        // already entered for matchups that still exist; an empty list
        // clears the date (league dropped from the day / produced no games).
        if (window.SpecialtyLeaguesAPI?.syncGamesFromGeneration) {
            _dayResetLeaguesS.forEach(function (id) {
                try {
                    const byLabel = {};
                    (history.gameLog?.[id]?.[currentDate] || []).forEach(function (e) {
                        const lbl = e.g || 'Game';
                        (byLabel[lbl] = byLabel[lbl] || []).push({ teamA: e.tA, teamB: e.tB, field: e.field || null });
                    });
                    const entries = Object.keys(byLabel).map(function (lbl) {
                        const m = String(lbl).match(/Game\s*(\d+)/i);
                        return { gameLabel: lbl, gameNumber: m ? parseInt(m[1], 10) : null, matches: byLabel[lbl] };
                    });
                    window.SpecialtyLeaguesAPI.syncGamesFromGeneration(id, currentDate, entries);
                } catch (e) {
                    console.warn('[SpecialtyLeagues] FN-58 games auto-save failed for league ' + id + ':', e);
                }
            });
        }

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

    /**
     * Remove a date's game counts from specialty league history and propagate
     * corrected game numbers to future dates still in localStorage.
     * Called by eraseCurrentDailyData after a single day is deleted.
     */
    SpecialtyLeagues.cleanupDateFromHistory = function(dateKey) {
        try {
            const history = loadSpecialtyHistory();

            let changed = false;

            // ★ FN-55: subtract the deleted date's logged games from the
            // rotation/matchup aggregates — previously a deleted day's games
            // stayed in them forever.
            for (const leagueId of Object.keys(history.gameLog || {})) {
                if (rollbackDayRecords(leagueId, dateKey, history) > 0) {
                    changed = true;
                }
            }

            // ★ FN-58: the deleted day's auto-saved result games go with it
            try { window.SpecialtyLeaguesAPI?.removeAutoGamesForDate?.(dateKey); } catch (e) {}

            for (const leagueId of Object.keys(history.gamesPerDate || {})) {
                if (history.gamesPerDate[leagueId][dateKey] !== undefined) {
                    delete history.gamesPerDate[leagueId][dateKey];
                    changed = true;
                }
            }

            if (!changed) return;

            saveSpecialtyHistory(history);
            console.log('[SpecialtyLeagues] 🗑️ Removed gamesPerDate entries for', dateKey);

            updateFutureSchedules(dateKey, history);
        } catch (e) {
            console.error('[SpecialtyLeagues] cleanupDateFromHistory error:', e);
        }
    };

    /**
     * ★ FN-55: subtract a date's logged specialty records for every league
     * whose divisions intersect divisionNames, then renumber future schedules.
     * For callers that regenerate a day WITHOUT invoking this engine at all
     * (auto builder with zero league blocks) — the engine's own in-play reset
     * can't run there.
     */
    SpecialtyLeagues.resetDayRecords = function(divisionNames, dateKey) {
        try {
            if (!Array.isArray(divisionNames) || divisionNames.length === 0 || !dateKey) return;
            const cfg = loadSpecialtyLeagues();
            const history = loadSpecialtyHistory();
            const divSet = new Set(divisionNames);
            let changed = false;
            const affected = [];
            Object.values(cfg || {}).forEach(function (l) {
                if (!l || !l.id) return;
                if (!(l.divisions || []).some(function (d) { return divSet.has(d); })) return;
                affected.push(l.id);
                if (rollbackDayRecords(l.id, dateKey, history) > 0) changed = true;
                if (history.gamesPerDate?.[l.id]?.[dateKey] !== undefined) {
                    delete history.gamesPerDate[l.id][dateKey];
                    changed = true;
                }
            });
            if (affected.length > 0) {
                try { window.SpecialtyLeaguesAPI?.removeAutoGamesForDate?.(dateKey, affected); } catch (e) {}
            }
            if (!changed) return;
            saveSpecialtyHistory(history);
            updateFutureSchedules(dateKey, history);
            console.log('[SpecialtyLeagues] ↩️ Reset day records for', dateKey, 'across divisions [' + divisionNames.join(', ') + ']');
        } catch (e) {
            console.error('[SpecialtyLeagues] resetDayRecords error:', e);
        }
    };

    /**
     * Wipe all gamesPerDate entries across every specialty league.
     * Called by eraseAllDailyData when every schedule is deleted at once.
     */
    SpecialtyLeagues.clearAllGamesPerDate = function() {
        try {
            const history = loadSpecialtyHistory();
            if (!history.gamesPerDate || Object.keys(history.gamesPerDate).length === 0) return;

            for (const leagueId of Object.keys(history.gamesPerDate)) {
                history.gamesPerDate[leagueId] = {};
            }

            saveSpecialtyHistory(history);
            console.log('[SpecialtyLeagues] 🗑️ Cleared all gamesPerDate entries (all schedules deleted)');
        } catch (e) {
            console.error('[SpecialtyLeagues] clearAllGamesPerDate error:', e);
        }
    };

    window.SchedulerCoreSpecialtyLeagues = SpecialtyLeagues;

    if (window.SchedulerCoreLeagues) {
        window.SchedulerCoreLeagues.processSpecialtyLeagues = SpecialtyLeagues.processSpecialtyLeagues;
    }

    console.log('[SpecialtyLeagues] Module loaded with Chronological Date Ordering + Cloud Persistence v3');
})();
