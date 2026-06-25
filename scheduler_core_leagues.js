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
        const EMPTY = () => ({
            teamSports: {}, matchupHistory: {}, gamesPerDate: {},
            offCampusCounts: {}, gameLog: {}
        });
        try {
            // Cloud-synced copy (hydrated into global settings)
            const global = window.loadGlobalSettings?.() || {};
            const cloud = (global.leagueHistory && Object.keys(global.leagueHistory).length > 0)
                ? global.leagueHistory : null;

            // localStorage backup
            let local = null;
            try {
                const raw = localStorage.getItem(LEAGUE_HISTORY_KEY);
                if (raw) local = JSON.parse(raw);
            } catch (_) {}

            // ★ LG-7: when BOTH stores have data, prefer the FRESHER by _savedAt
            //   (stamped in saveLeagueHistory). A stale cloud row — e.g. an offline
            //   local save that hasn't synced yet — must not shadow newer local
            //   history at generation time, which made the game counter "reset".
            //   Falls back to cloud when timestamps are absent (legacy) or equal.
            let history;
            if (cloud && local) {
                const ct = Number(cloud._savedAt) || 0;
                const lt = Number(local._savedAt) || 0;
                history = (lt > ct) ? local : cloud;
                console.log(`[RegularLeagues] ✅ Loaded history (${history === local ? 'local is newer' : 'cloud'})`);
            } else if (cloud) {
                history = cloud;
                console.log("[RegularLeagues] ✅ Loaded history from cloud");
            } else if (local) {
                history = local;
                // Migrate from old roundCounters/dayStartRound if present
                if (history.roundCounters && !history.gamesPerDate) {
                    console.log("[RegularLeagues] Migrating old history format...");
                    history.gamesPerDate = {};
                }
            } else {
                return EMPTY();
            }

            // Fill defaults for missing fields
            history.teamSports = history.teamSports || {};
            history.matchupHistory = history.matchupHistory || {};
            history.gamesPerDate = history.gamesPerDate || {};
            history.offCampusCounts = history.offCampusCounts || {};
            history.gameLog = history.gameLog || {};
            return history;
        } catch (e) {
            console.error("Failed to load league history:", e);
            return EMPTY();
        }
    }

    function saveLeagueHistory(history) {
        // ★ LG-7: stamp this save so loadLeagueHistory can pick the fresher of
        //   cloud vs the campLeagueHistory_v2 backup. Same value lands in both
        //   stores; the store written later in a given session wins on reload.
        try { if (history && typeof history === 'object') history._savedAt = Date.now(); } catch (_) {}
        // ★ Cloud save FIRST and in its OWN try — a full localStorage (quota) must
        //   NEVER block the cloud write. Previously both writes shared one try block
        //   with localStorage.setItem first, so a QuotaExceededError on the backup
        //   skipped saveGlobalSettings entirely → that day's games never synced to
        //   cloud → the next cold start hydrated the stale cloud row and the game
        //   counter "reset" (works in-session, resets next day). The cloud is the
        //   authoritative cross-session store, so it must not depend on localStorage.
        if (typeof window.saveGlobalSettings === 'function') {
            try {
                window.saveGlobalSettings('leagueHistory', history);
                console.log("[RegularLeagues] ✅ History saved to cloud");
            } catch (e) {
                console.error("Failed to save league history to cloud:", e);
            }
        }
        // localStorage backup — best-effort; a quota failure here is non-fatal.
        try {
            localStorage.setItem(LEAGUE_HISTORY_KEY, JSON.stringify(history));
        } catch (e) {
            console.warn("League history localStorage backup skipped (quota?):", e);
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
        const modifiedDates = new Set(); // ★ Track which dates actually changed

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
                // ★ FN-10: per-day sequential game counter for the per-bunk copy.
                //   Mirrors gameIndexWithinDay used by the leagueAssignments block
                //   above. (The old code reused `processedSlots` — the OTHER set,
                //   keyed by `time_*` — via indexOf(`${i}`) on a bare slot index,
                //   which never matched, so every league game on the date was
                //   numbered identically in the per-bunk copy.)
                let bunkGameIndexWithinDay = 0;
                
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
                            // ★ FN-10: number by sequential per-day game order (slot order),
                            //   not by indexing the time_-keyed processedSlots set with a bare
                            //   slot index (that never matched → every game got the same number).
                            const correctNum = gamesBeforeThisDate + bunkGameIndexWithinDay + 1;

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
                            bunkGameIndexWithinDay++;
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
                modifiedDates.add(futureDate); // ★ Only track actually-changed dates
                console.log(`[RegularLeagues] ✅ Updated schedule for ${futureDate}`);
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

                console.log(`[RegularLeagues] ✅ Saved ${modifiedDates.size} updated future schedule(s) to storage`);
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
    // ★ FN-54: DATE-KEYED GAME LOG — makes a day's records reversible
    // =========================================================================
    // teamSports/matchupHistory are flat aggregates with no memory of WHICH
    // date contributed an entry, so regenerating a date re-recorded all of its
    // games (observed live: 101 recorded plays per team against 7 real game
    // dates) and deleting a date left its games in the aggregates forever —
    // both poison the variety ordering. Every recorded game now also lands in
    // history.gameLog[league][date], so a regeneration or a date-delete can
    // subtract exactly what that date previously contributed.

    function logGameRecord(leagueName, date, team1, team2, sport, history, gameLabel) {
        if (!history.gameLog) history.gameLog = {};
        if (!history.gameLog[leagueName]) history.gameLog[leagueName] = {};
        if (!history.gameLog[leagueName][date]) history.gameLog[leagueName][date] = [];
        // g = display label ("Game 3" / "Playoff R1") — lets FN-58 group the
        // date's records into result-entry games for the Leagues page.
        history.gameLog[leagueName][date].push({ t1: team1, t2: team2, sport: sport || null, g: gameLabel || null });
    }

    function rollbackDayRecords(leagueName, date, history) {
        const entries = history.gameLog?.[leagueName]?.[date];
        if (!entries || !entries.length) return 0;
        entries.forEach(function (e) {
            if (e.sport) {
                [e.t1, e.t2].forEach(function (team) {
                    if (!team) return;
                    const arr = history.teamSports[`${leagueName}|${team}`];
                    if (!arr) return;
                    const idx = arr.lastIndexOf(e.sport);
                    if (idx !== -1) arr.splice(idx, 1);
                });
            }
            if (e.t1 && e.t2) {
                const mk = `${leagueName}:${getMatchupKey(e.t1, e.t2)}`;
                if (history.matchupHistory[mk] > 1) history.matchupHistory[mk]--;
                else delete history.matchupHistory[mk];
            }
        });
        const n = entries.length;
        delete history.gameLog[leagueName][date];
        console.log(`[RegularLeagues] ↩️ Rolled back ${n} logged game record(s) for "${leagueName}" on ${date}`);
        return n;
    }

    // =========================================================================
    // ROUND-ROBIN MATCHUP GENERATION
    // =========================================================================
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
    // ★ FN-57: MODE-AWARE PAIRING + REMATCH-SPORT CAVEAT
    // =========================================================================
    // The two scheduling priorities must actually differ in WHO plays WHOM:
    //   - matchup_variety: strict round-robin — every team plays every other
    //     team before any rematch (opponent coverage is the guarantee).
    //   - sport_variety: pairings serve SPORT coverage — when the round-robin
    //     pairing would force a team to repeat a sport while some other
    //     pairing lets everyone play something new, deviate. Ties prefer the
    //     least-met opponents, so with plentiful sports this still behaves
    //     like round-robin (all pairs before rematch).
    // Caveat (both modes): when a pair DOES meet again, never replay a sport
    // that pair already played together. Per-pair sport history is derived
    // from the date-keyed gameLog (FN-54), so it is regen/delete-safe for
    // free; games recorded before gameLog existed are invisible to it.

    function getPairSports(leagueName, team1, team2, history) {
        const out = [];
        const gl = history.gameLog?.[leagueName];
        if (!gl) return out;
        const key = getMatchupKey(team1, team2);
        Object.keys(gl).forEach(function (d) {
            (gl[d] || []).forEach(function (e) {
                if (e && e.sport && getMatchupKey(e.t1, e.t2) === key) out.push(e.sport);
            });
        });
        return out;
    }

    // All ways to split the team list into pairs (odd counts get one bye).
    // 4 teams → 3 matchings, 8 → 105, 12 → 10395 — fine; larger leagues fall
    // back to round-robin in the chooser.
    function generatePerfectMatchings(teams) {
        const arr = teams.slice();
        if (arr.length % 2 === 1) arr.push('__BYE__');
        const out = [];
        (function rec(rem, cur) {
            if (rem.length === 0) { out.push(cur.slice()); return; }
            const a = rem[0];
            for (let i = 1; i < rem.length; i++) {
                cur.push([a, rem[i]]);
                rec(rem.slice(1, i).concat(rem.slice(i + 1)), cur);
                cur.pop();
            }
        })(arr, []);
        return out;
    }

    function choosePairingsForSportVariety(activeTeams, availablePool, leagueName, history, fallbackMatchups) {
        try {
            if (!Array.isArray(activeTeams) || activeTeams.length < 2 || activeTeams.length > 12) return fallbackMatchups;
            if (!Array.isArray(availablePool) || availablePool.length === 0) return fallbackMatchups;
            const matchings = generatePerfectMatchings(activeTeams);
            if (matchings.length <= 1) return fallbackMatchups;

            const histSets = {};
            activeTeams.forEach(function (t) { histSets[t] = new Set(getTeamSportHistory(leagueName, t, history)); });

            // Score each matching: fresh = how many team-slots can receive a
            // sport that team hasn't played (per pair, the best single option:
            // new-to-both = 2, new-to-one = 1). Maximize fresh; tie-break on
            // fewest prior meetings (prefer fresh opponents). Cross-pair field
            // contention is ignored here — the assigner resolves it.
            let best = null, bestFresh = -1, bestMeet = Infinity;
            for (const m of matchings) {
                let fresh = 0, meet = 0;
                for (const pair of m) {
                    if (pair[0] === '__BYE__' || pair[1] === '__BYE__') continue;
                    meet += getMatchupCount(leagueName, pair[0], pair[1], history);
                    let bestPair = 0;
                    for (const o of availablePool) {
                        const s = (histSets[pair[0]].has(o.sport) ? 0 : 1) + (histSets[pair[1]].has(o.sport) ? 0 : 1);
                        if (s > bestPair) { bestPair = s; if (bestPair === 2) break; }
                    }
                    fresh += bestPair;
                }
                if (fresh > bestFresh || (fresh === bestFresh && meet < bestMeet)) {
                    best = m; bestFresh = fresh; bestMeet = meet;
                }
            }
            if (!best) return fallbackMatchups;
            const chosen = best
                .filter(function (p) { return p[0] !== '__BYE__' && p[1] !== '__BYE__'; })
                .map(function (p) { return [p[0], p[1]]; });
            const _key = function (ms) { return ms.map(function (p) { return p.slice().sort().join('v'); }).sort().join(','); };
            if (_key(chosen) !== _key(fallbackMatchups)) {
                console.log('   ★ [SportVariety] pairing optimized for sport coverage: '
                    + chosen.map(function (p) { return p[0] + ' vs ' + p[1]; }).join(', ')
                    + ' (round-robin would be: '
                    + fallbackMatchups.map(function (p) { return p[0] + ' vs ' + p[1]; }).join(', ') + ')');
            }
            return chosen;
        } catch (e) {
            console.warn('[RegularLeagues] sport-variety pairing chooser failed — using round-robin:', e);
            return fallbackMatchups;
        }
    }

    // =========================================================================
    // ★★★ FIELD AVAILABILITY - WITH GLOBAL LOCK CHECK ★★★
    // =========================================================================

    function buildAvailableFieldSportPool(leagueSports, context, divisionNames, timeKey, slots, blockEndMin) {
        const pool = [];
        const { fields, disabledFields, activityProperties } = context;

        const allFields = fields || [];

        // ★ A field that is a SPECIAL activity's physical room (e.g. court "Jump Shot"
        //   is the "Basketball Clinic" room) must NOT be handed to a league game.
        //   Leagues run BEFORE Smart Tiles, so without this a league grabs the court
        //   and Smart Tiles then drop the clinic onto it — a physical double-book the
        //   name-vs-field tracking never sees. League analog of STEP 7.6's _specialRooms76
        //   (sport fill) and STEP 6.95's lock (solver): special rooms are special-only
        //   across every engine. Self-named specials (location == own name) aren't sport
        //   fields, so excluding them is a harmless no-op.
        const _leagueSpecialRooms = (function () {
            const s = new Set();
            try {
                const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : (window.globalSettings || {});
                ((gs.app1 && gs.app1.specialActivities) || gs.specialActivities || []).forEach(sp => {
                    if (sp && sp.location) s.add(String(sp.location).toLowerCase().trim());
                });
            } catch (_e) {}
            return s;
        })();

        const _poolDivSlots = window.divisionTimes?.[divisionNames[0]] || [];
        let _poolStartMin = (slots && slots.length > 0) ? _poolDivSlots[slots[0]]?.startMin : undefined;
        let _poolEndMin = (slots && slots.length > 0) ? _poolDivSlots[slots[slots.length - 1]]?.endMin : undefined;
        // Fallback: timeKey IS the startMin (always available); blockEndMin is passed explicitly.
        if (_poolStartMin == null && timeKey != null) _poolStartMin = Number(timeKey) || undefined;
        if (_poolEndMin == null && blockEndMin != null) _poolEndMin = Number(blockEndMin) || undefined;

        for (const field of allFields) {
            if (!field || !field.name) continue;
            if (field.available === false) continue;
            if (disabledFields && disabledFields.includes(field.name)) continue;
            if (_leagueSpecialRooms.has(String(field.name).toLowerCase().trim())) {
                console.log(`[RegularLeagues] ⚠️ Field "${field.name}" is a special-activity room — reserved for specials, not available to leagues`);
                continue;
            }

           // ★★★ CHECK GLOBAL LOCKS FIRST (TIME-BASED to avoid cross-division false positives) ★★★
            if (window.GlobalFieldLocks && slots && slots.length > 0) {
                const lockInfo = (_poolStartMin != null && _poolEndMin != null)
                    ? window.GlobalFieldLocks.isFieldLockedByTime(field.name, _poolStartMin, _poolEndMin, divisionNames[0])
                    : window.GlobalFieldLocks.isFieldLocked(field.name, slots, divisionNames[0]);
                if (lockInfo) {
                    console.log(`[RegularLeagues] ⚠️ Field "${field.name}" time-locked by ${lockInfo.lockedBy} (${lockInfo.leagueName || lockInfo.activity})`);
                    continue;
                }
            }

            // ★★★ CHECK FIELD TIME RULES (available/unavailable windows) ★★★
            // ★ Per-grade scoping: a rule with `divisions: ['1']` only applies
            //   when the current league touches grade 1. Rules with empty/missing
            //   `divisions` apply to all grades.
            // ★ FN-29: fall back to the canonical field.timeRules if activityProperties
            //   is empty/stale (the FN-24 disease) so a facility's unavailable window is
            //   honored by leagues even when the merged copy isn't populated.
            const _fieldTimeRules = (activityProperties?.[field.name]?.timeRules) || field.timeRules || null;
            if (_fieldTimeRules && _fieldTimeRules.length > 0 && _poolStartMin != null && _poolEndMin != null) {
                const _parseMin = window.SchedulerCoreUtils?.parseTimeToMinutes;
                const _curDivs = (divisionNames || []).map(String);
                let _blocked = false;
                let _hasAvailRules = false;
                let _inAvailWindow = false;
                for (const _tr of _fieldTimeRules) {
                    // Skip rules scoped to grades we're not currently scheduling for
                    const _trDivs = Array.isArray(_tr.divisions) ? _tr.divisions.map(String) : [];
                    if (_trDivs.length > 0 && !_trDivs.some(d => _curDivs.includes(d))) continue;

                    const _trStart = _tr.startMin ?? (_parseMin ? _parseMin(_tr.start || _tr.startTime) : null);
                    const _trEnd = _tr.endMin ?? (_parseMin ? _parseMin(_tr.end || _tr.endTime) : null);
                    if (_trStart == null || _trEnd == null) continue;
                    const _trType = (_tr.type || '').toLowerCase();
                    const _isUnavail = _trType === 'unavailable' || _tr.available === false;
                    const _isAvail = _trType === 'available' || _tr.available === true;
                    if (_isUnavail && _trStart < _poolEndMin && _trEnd > _poolStartMin) { _blocked = true; break; }
                    if (_isAvail) {
                        _hasAvailRules = true;
                        if (_poolStartMin >= _trStart && _poolEndMin <= _trEnd) _inAvailWindow = true;
                    }
                }
                if (_blocked || (_hasAvailRules && !_inAvailWindow)) {
                    console.log(`[RegularLeagues] ⚠️ Field "${field.name}" blocked by time rules (${_poolStartMin}-${_poolEndMin}) for divisions [${_curDivs.join(',')}]`);
                    continue;
                }
            }

            // ★ Off-campus zone per-grade availability windows: drop the field if any
            //   covered grade is outside its configured window for this zone (a grade
            //   with no window stays unrestricted).
            if (typeof window.isOffCampusFieldAvailableForGrade === 'function' && _poolStartMin != null && _poolEndMin != null) {
                const _ocOk = (divisionNames || []).every(d =>
                    window.isOffCampusFieldAvailableForGrade(field.name, String(d), _poolStartMin, _poolEndMin));
                if (!_ocOk) {
                    console.log(`[RegularLeagues] ⚠️ Field "${field.name}" off-campus window blocks grades [${(divisionNames||[]).join(',')}] @${_poolStartMin}-${_poolEndMin}`);
                    continue;
                }
            }

            // Check division restrictions
            if (field.accessRestrictions?.enabled) {
                const allowedDivs = Object.keys(field.accessRestrictions.divisions || {});
                const hasAllowed = divisionNames.some(d => allowedDivs.includes(d));
                if (!hasAllowed) continue;
            }

            // ★ FN-29: weather availability — on a rainy day, leagues (like sports) may
            //   only use rainy-available / indoor fields. getRainyDayFieldFilter excludes
            //   outdoor fields for sports but RETURNS a filter object (doesn't mutate
            //   field.available), so the league pool never saw it — a league could place a
            //   game on an outdoor field in the rain (weather was scored, not enforced).
            if (window.isRainyDay === true && !(field.rainyDayAvailable === true || field.isIndoor === true)) {
                continue;
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

    // Mark a field as used within this round AND mark its combo partners as used,
    // so a single round can't hand out e.g. Full Gym to one matchup and Gym 1
    // to another. Always lower-cases entries so .has() matches regardless of
    // candidate-pool casing.
    function _markFieldUsedWithCombos(usedFieldsSet, fieldName) {
        if (!fieldName) return;
        usedFieldsSet.add(fieldName);
        usedFieldsSet.add(String(fieldName).toLowerCase().trim());
        const partners = window.FieldCombos?.getExclusiveFields?.(fieldName) || [];
        for (const p of partners) {
            usedFieldsSet.add(p);
            usedFieldsSet.add(String(p).toLowerCase().trim());
        }
    }
    function _isFieldUsedConsideringCombos(usedFieldsSet, fieldName) {
        if (!fieldName) return false;
        if (usedFieldsSet.has(fieldName)) return true;
        const norm = String(fieldName).toLowerCase().trim();
        return usedFieldsSet.has(norm);
    }

    // =========================================================================
    // SMART ASSIGNMENT ALGORITHM - SPORT VARIETY MODE (Default)
    // =========================================================================

    function assignMatchupsToFieldsAndSports_SportVariety(matchups, availablePool, leagueName, history, slots, leagueRules) {
        const assignments = [];
        const usedFields = new Set();
        const usedSportsThisSlot = {};

        function getTeamSportNeed(team, sport) {
            const teamHistory = getTeamSportHistory(leagueName, team, history);
            const sportCount = teamHistory.filter(s => s === sport).length;

            if (sportCount === 0) return 1000;
            return Math.max(0, 100 - sportCount * 20);
        }

        // Sort matchups so teams with less sport variety get processed first.
        // When an indoor requirement is active, the neediest team (lowest current
        // indoor count) goes first so it gets first pick at any indoor option.
        const _indoorReq = leagueRules && leagueRules.indoorRequirement;
        const _indoorCounts = (leagueRules && leagueRules.indoorCounts) || {};
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const h1 = getTeamSportHistory(leagueName, t1, history);
            const h2 = getTeamSportHistory(leagueName, t2, history);
            const uniqueSports1 = new Set(h1).size;
            const uniqueSports2 = new Set(h2).size;
            const ic1 = _indoorCounts[t1] || 0;
            const ic2 = _indoorCounts[t2] || 0;
            return { t1, t2, varietyScore: uniqueSports1 + uniqueSports2, indoorMin: Math.min(ic1, ic2) };
        });

        if (_indoorReq && _indoorReq.enabled) {
            // Neediest pair (lowest min indoor count) first; tie-break on variety
            matchupsWithPriority.sort((a, b) => a.indoorMin - b.indoorMin || a.varietyScore - b.varietyScore);
        } else {
            matchupsWithPriority.sort((a, b) => a.varietyScore - b.varietyScore);
        }

        for (const { t1, t2 } of matchupsWithPriority) {
            let bestOption = null;
            let bestScore = -Infinity;

            // ★ INDOOR HARD CONSTRAINT: restrict to indoor (or non-indoor) when
            // the rule requires it AND such a field is available; otherwise use
            // the full eligible set so the matchup always gets a sport.
            const _eligible = availablePool.filter(function (o) { return !_isFieldUsedConsideringCombos(usedFields, o.field); });
            let _pool = _applyIndoorHardFilter(_eligible, t1, t2, leagueRules);

            // ★ FN-57 caveat: a rematch never replays a sport this pair has
            // already played together — unless nothing else is available.
            const _pairSports = new Set(getPairSports(leagueName, t1, t2, history));
            if (_pairSports.size > 0) {
                const _freshPool = _pool.filter(function (o) { return !_pairSports.has(o.sport); });
                if (_freshPool.length > 0) _pool = _freshPool;
                else console.log(`   ⚠️ ${t1} vs ${t2}: every available sport already played by this pair — allowing a repeat`);
            }

            for (const option of _pool) {
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

                // ★ INDOOR REQUIREMENT: bias toward/away from indoor based on rule + running counts
                score += _scoreIndoorBias(option, t1, t2, leagueRules);

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

                _markFieldUsedWithCombos(usedFields, bestOption.field);
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

    function assignMatchupsToFieldsAndSports_MatchupVariety(matchups, availablePool, leagueName, history, slots, leagueRules) {
        const assignments = [];
        const usedFields = new Set();

        // Sort matchups by how many times they've played (least played first)
        const _indoorReqMV = leagueRules && leagueRules.indoorRequirement;
        const _indoorCountsMV = (leagueRules && leagueRules.indoorCounts) || {};
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const matchupCount = getMatchupCount(leagueName, t1, t2, history);
            const indoorMin = Math.min(_indoorCountsMV[t1] || 0, _indoorCountsMV[t2] || 0);
            return { t1, t2, matchupCount, indoorMin };
        });

        // Process matchups with fewest prior meetings first. When an indoor
        // requirement is active, the neediest indoor pair goes first so it
        // claims a scarce indoor field before others.
        if (_indoorReqMV && _indoorReqMV.enabled) {
            matchupsWithPriority.sort((a, b) => a.indoorMin - b.indoorMin || a.matchupCount - b.matchupCount);
        } else {
            matchupsWithPriority.sort((a, b) => a.matchupCount - b.matchupCount);
        }

        console.log(`   📊 [MatchupVariety] Matchup priorities:`);
        matchupsWithPriority.forEach(m => {
            console.log(`      • ${m.t1} vs ${m.t2}: ${m.matchupCount} prior games`);
        });

        for (const { t1, t2 } of matchupsWithPriority) {
            let bestOption = null;
            let bestScore = -Infinity;

            // ★ INDOOR HARD CONSTRAINT (non-blocking) — same as SportVariety
            const _eligible = availablePool.filter(function (o) { return !_isFieldUsedConsideringCombos(usedFields, o.field); });
            let _pool = _applyIndoorHardFilter(_eligible, t1, t2, leagueRules);

            // ★ FN-57 caveat: a rematch never replays a sport this pair has
            // already played together — unless nothing else is available.
            const _pairSports = new Set(getPairSports(leagueName, t1, t2, history));
            if (_pairSports.size > 0) {
                const _freshPool = _pool.filter(function (o) { return !_pairSports.has(o.sport); });
                if (_freshPool.length > 0) _pool = _freshPool;
                else console.log(`   ⚠️ ${t1} vs ${t2}: every available sport already played by this pair — allowing a repeat`);
            }

            for (const option of _pool) {
                let score = 0;

                // In matchup variety mode, sport variety is secondary
                // Just add a small preference for sports not played as much
                const h1 = getTeamSportHistory(leagueName, t1, history);
                const h2 = getTeamSportHistory(leagueName, t2, history);
                const sportCount1 = h1.filter(s => s === option.sport).length;
                const sportCount2 = h2.filter(s => s === option.sport).length;
                
                // Small bonus for less-played sports (not the main factor)
                score += Math.max(0, 50 - (sportCount1 + sportCount2) * 5);

                // ★ INDOOR REQUIREMENT: bias toward/away from indoor based on rule + running counts
                score += _scoreIndoorBias(option, t1, t2, leagueRules);

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

                _markFieldUsedWithCombos(usedFields, bestOption.field);

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

    function assignMatchupsToFieldsAndSports(matchups, availablePool, leagueName, history, slots, schedulingPriority, leagueRules) {
        const mode = schedulingPriority || 'sport_variety';

        console.log(`   🎯 Scheduling Priority: ${mode === 'sport_variety' ? 'Sport Variety' : 'Matchup Variety'}`);

        if (mode === 'matchup_variety') {
            return assignMatchupsToFieldsAndSports_MatchupVariety(matchups, availablePool, leagueName, history, slots, leagueRules);
        } else {
            return assignMatchupsToFieldsAndSports_SportVariety(matchups, availablePool, leagueName, history, slots, leagueRules);
        }
    }

    // =========================================================================
    // ★★★ INDOOR REQUIREMENT — HARD (non-blocking) CONSTRAINT ★★★
    // An option is "indoor" if its facility is flagged indoor in Facilities
    // (rainyDayAvailable === true; isIndoor kept as a fallback).
    // =========================================================================
    function _optIsIndoor(option) {
        const fo = option && option.fieldObj;
        return !!(fo && (fo.rainyDayAvailable === true || fo.isIndoor === true));
    }

    // Hard-constraint direction for a matchup given the league rule + each
    // team's running indoor count today:
    //   +1 → this game MUST be indoor (a team is still below its floor)
    //   -1 → this game MUST avoid indoor (a team would exceed its ceiling)
    //    0 → no constraint
    function _indoorConstraintDir(t1, t2, leagueRules) {
        const req = leagueRules && leagueRules.indoorRequirement;
        if (!req || !req.enabled) return 0;
        const counts = (leagueRules && leagueRules.indoorCounts) || {};
        const op = req.op || '>=';
        const target = Number.isFinite(req.count) ? req.count : 1;
        const c1 = counts[t1] || 0, c2 = counts[t2] || 0;
        const lo = Math.min(c1, c2), hi = Math.max(c1, c2);
        if (op === '>=') return lo < target ? 1 : 0;       // below floor → require indoor
        if (op === '<=') return hi >= target ? -1 : 0;      // at/over ceiling → forbid indoor
        if (op === '=')  { if (lo < target) return 1; if (hi >= target) return -1; return 0; }
        return 0;
    }

    // Apply the HARD indoor constraint to the eligible (unused) options for a
    // matchup, WITH FALLBACK: if the required field type has no available
    // option, return the eligible set unchanged so the matchup still receives a
    // sport. The indoor rule never causes a game to go unscheduled.
    function _applyIndoorHardFilter(eligible, t1, t2, leagueRules) {
        const dir = _indoorConstraintDir(t1, t2, leagueRules);
        if (dir === 1) { const ind = eligible.filter(_optIsIndoor); return ind.length ? ind : eligible; }
        if (dir === -1) { const out = eligible.filter(function (o) { return !_optIsIndoor(o); }); return out.length ? out : eligible; }
        return eligible;
    }

    // =========================================================================
    // ★★★ INDOOR REQUIREMENT SCORING HELPER (tie-break within the filtered set) ★★★
    // Returns a score adjustment for picking `option` for the matchup (t1, t2),
    // given the league's indoor rule and each team's running indoor count today.
    // Higher = more desirable. Used by both SportVariety and MatchupVariety.
    // =========================================================================
    function _scoreIndoorBias(option, t1, t2, leagueRules) {
        const req = leagueRules && leagueRules.indoorRequirement;
        if (!req || !req.enabled) return 0;
        const counts = (leagueRules && leagueRules.indoorCounts) || {};
        // ★★★ INDOOR FIX: indoor/outdoor is defined in Facilities via the
        // weather toggle, stored as field.rainyDayAvailable (indoor ⟺ true —
        // see scheduler_core_main.js rainy-day filter + facilities.js
        // renderWeatherSettings). The scorer previously read fieldObj.isIndoor,
        // which fields don't carry, so the indoor requirement never detected
        // any indoor field. Read the canonical rainyDayAvailable flag (keep
        // isIndoor as a fallback in case any field carries it explicitly).
        const _fo = option && option.fieldObj;
        const isIndoor = !!(_fo && (_fo.rainyDayAvailable === true || _fo.isIndoor === true));
        const op = req.op || '>=';
        const target = Number.isFinite(req.count) ? req.count : 1;

        function teamDelta(team) {
            const cur = counts[team] || 0;
            if (op === '>=') {
                if (isIndoor) {
                    if (cur < target) return 1500 * (target - cur);
                    return -200;
                }
                if (cur < target) return -800 * (target - cur);
                return 0;
            }
            if (op === '=') {
                if (isIndoor) {
                    if (cur < target) return 1500 * (target - cur);
                    return -3000;
                }
                if (cur < target) return -800 * (target - cur);
                if (cur > target) return 200;
                return 0;
            }
            // op === '<='
            if (isIndoor) {
                if (cur >= target) return -3000;
                return 100;
            }
            if (cur < target) return 0;
            return 200;
        }

        return teamDelta(t1) + teamDelta(t2);
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
                score += (history.matchupHistory || {})[leagueName + ':' + [pair[0], pair[1]].sort().join('|')] || 0;
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

        // ★★★ INDOOR REQUIREMENT: per-team running indoor-game count for today ★★★
        // Used by the scorer to bias matchup field choice toward indoor for teams
        // that haven't met their league's indoor rule yet.
        const indoorCountsByLeague = {};  // indoorCountsByLeague[leagueName][team] = number

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

        // ★ FN-54: a generation that covers a league's divisions REPLACES that
        // league's games for this date — so before anything re-records, subtract
        // what this date previously logged (sports/matchups) and clear its
        // games-per-date entry. A league is in play when its blocks appear this
        // run (name hint or division match — the same matching the per-period
        // loop uses) OR when one of its divisions is being generated
        // (context.generatedDivisions) — the latter catches a regen whose
        // skeleton no longer has the league tile, which previously left ghost
        // games in the history forever. Scoped, so a partial-division regen
        // leaves other leagues' day records untouched. Without this, every
        // regen re-appended the day's games into the flat aggregates.
        const _dayResetLeagues = new Set();   // ★ FN-58: leagues whose day was replaced this run
        (function () {
            const _genDivs = new Set(context.generatedDivisions || []);
            const _allLeagues = Array.isArray(masterLeagues) ? masterLeagues : Object.values(masterLeagues || {});
            _allLeagues.forEach(function (league) {
                if (!league || !league.name) return;
                const inPlay = sortedTimeKeys.some(function (tk) {
                    const td = blocksByTime[tk];
                    if (td.allBlocks.some(function (b) { return b.leagueName === league.name; })) return true;
                    return Object.keys(td.byDivision).some(function (d) { return (league.divisions || []).includes(d); });
                }) || (league.divisions || []).some(function (d) { return _genDivs.has(d); });
                if (!inPlay) return;
                _dayResetLeagues.add(league.name);
                rollbackDayRecords(league.name, dayId, history);
                if (history.gamesPerDate?.[league.name]?.[dayId] !== undefined) {
                    delete history.gamesPerDate[league.name][dayId];
                }
            });
        })();

        // ★★★ CHINUCH: Pre-compute which teams attend chinuch at each league period ★★★
        // Distribution is fully automatic: teamsPerSession = ceil(teams / numPeriods).
        // Only periodsNeeded = ceil(teams / teamsPerSession) periods get chinuch — the
        // rest are normal league periods. Each team is assigned exactly one chinuch
        // period per day. Teams are shuffled daily for variety.
        window.chinuchSchedule = {};
        (function () {
            function _seededShuffle(arr, seed) {
                const a = arr.slice();
                let s = 0;
                for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) & 0x7fffffff;
                for (let i = a.length - 1; i > 0; i--) {
                    s = ((s * 1664525) + 1013904223) & 0x7fffffff;
                    const j = s % (i + 1);
                    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
                }
                return a;
            }
            const _enabledLeagues = Array.isArray(masterLeagues) ? masterLeagues : Object.values(masterLeagues || {});
            for (const league of _enabledLeagues) {
                if (!league.chinuch?.enabled || !league.enabled) continue;
                if (disabledLeagues?.includes(league.name)) continue;
                const teams = (league.teams || []).slice();
                if (teams.length < 1) continue;

                // Collect all time-keys for this league — mirror the same matching logic
                // used in the main per-time-key loop: leagueName hint takes priority over
                // division membership, so leagues configured without assigned divisions
                // (but referenced by name on skeleton blocks) are still found correctly.
                const allPeriodKeys = sortedTimeKeys.filter(tk => {
                    const blocks = blocksByTime[tk].allBlocks;
                    if (blocks.some(b => b.leagueName === league.name)) return true;
                    const divs = Object.keys(blocksByTime[tk].byDivision);
                    return divs.some(d => (league.divisions || []).includes(d));
                });
                if (allPeriodKeys.length === 0) continue;

                // Distribution: three modes, highest priority first.
                //   1. perSessionCounts [4,2,1,0] — exact count per period.
                //   2. timesPerDay / teamsPerRound override (either or both).
                //   3. Auto: teamsPerSession = ceil(teams / numPeriods); only as many
                //      periods as needed — trailing periods get no chinuch that day.
                // e.g. 8 teams, 4 periods → 2/session, [2,2,2,2]
                // e.g. 6 teams, 4 periods → 2/session, [2,2,2,0]
                // e.g. 5 teams, 4 periods → 2/session, [2,2,1,0]
                const numPeriods = allPeriodKeys.length;
                const customCounts = Array.isArray(league.chinuch.perSessionCounts)
                    ? league.chinuch.perSessionCounts
                        .map(function (n) { return Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0; })
                        .slice(0, numPeriods)
                    : null;

                // Shuffle teams using date+leagueName seed for daily variety
                const shuffled = _seededShuffle(teams, dayId + league.name);
                const bunkSchedule = {};
                let _mode;
                let _summary;

                if (customCounts && customCounts.length > 0) {
                    // Honor exact per-session counts. Walk shuffled teams sequentially
                    // and pour into period buckets. If the array totals more than the
                    // team count, later periods simply get fewer (or zero) teams. If
                    // it totals less, leftover teams have no chinuch slot today (they
                    // will appear in matchups or as byes).
                    let teamIdx = 0;
                    for (let p = 0; p < customCounts.length; p++) {
                        const take = customCounts[p];
                        for (let k = 0; k < take && teamIdx < shuffled.length; k++, teamIdx++) {
                            bunkSchedule[shuffled[teamIdx]] = Number(allPeriodKeys[p]);
                        }
                    }
                    _mode = 'custom';
                    _summary = '[' + customCounts.join(',') + ']';
                } else {
                    const manualTeams = (league.chinuch.teamsPerRound > 0) ? league.chinuch.teamsPerRound : null;
                    const manualTimes = (league.chinuch.timesPerDay > 0) ? Math.min(league.chinuch.timesPerDay, numPeriods) : null;

                    let teamsPerSession;
                    let periodsNeeded;
                    if (manualTeams && manualTimes) {
                        teamsPerSession = manualTeams;
                        periodsNeeded = manualTimes;
                    } else if (manualTeams) {
                        teamsPerSession = manualTeams;
                        periodsNeeded = Math.min(Math.ceil(teams.length / teamsPerSession), numPeriods);
                    } else if (manualTimes) {
                        periodsNeeded = manualTimes;
                        teamsPerSession = Math.ceil(teams.length / periodsNeeded);
                    } else {
                        teamsPerSession = Math.ceil(teams.length / numPeriods);
                        periodsNeeded = Math.ceil(teams.length / teamsPerSession);
                    }
                    const activePeriodKeys = allPeriodKeys.slice(0, periodsNeeded);

                    // ★★★ CHINUCH FIX: cap chinuch attendance to teamsPerSession ×
                    // periodsNeeded teams. The old forEach gave EVERY team a chinuch
                    // slot — so "1 team/session" on a single league period actually
                    // pulled ALL teams to chinuch, leaving nobody to play (then the
                    // activeTeams<2 guard skipped the whole league). Only the first
                    // `cap` shuffled teams attend chinuch today; the rest play their
                    // league game. The daily date-seeded shuffle rotates which teams
                    // attend so it evens out over the week.
                    const _cap = teamsPerSession * periodsNeeded;
                    shuffled.forEach((team, idx) => {
                        if (idx >= _cap) return; // remaining teams play (no chinuch today)
                        const periodIdx = Math.min(Math.floor(idx / teamsPerSession), periodsNeeded - 1);
                        bunkSchedule[team] = Number(activePeriodKeys[periodIdx]);
                    });
                    _mode = (manualTeams || manualTimes) ? 'manual' : 'auto';
                    _summary = teamsPerSession + '/session, ' + periodsNeeded + '/' + numPeriods + ' period(s), cap ' + Math.min(_cap, teams.length) + '/' + teams.length + ' team(s)';
                }

                window.chinuchSchedule[league.name] = bunkSchedule;
                console.log('[Chinuch] "' + league.name + '" (' + _mode + '): ' + teams.length + ' team(s), ' + _summary);
            }
        })();

        // ★★★ OFF-CAMPUS: Auto-detect consecutive league slots as back-to-back pairs ★★★
        for (var i = 0; i < sortedTimeKeys.length - 1; i++) {
            var tk1 = sortedTimeKeys[i], tk2 = sortedTimeKeys[i + 1];
            var blocks1 = blocksByTime[tk1].allBlocks.filter(function(b) { return b.type === 'league' || /league/i.test(b.event); });
            var blocks2 = blocksByTime[tk2].allBlocks.filter(function(b) { return b.type === 'league' || /league/i.test(b.event); });
            if (!blocks1.length || !blocks2.length) continue;
            blocks1.forEach(function(b1) {
                var lName = b1.leagueName || '';
                var league = lName && masterLeagues[lName];
                if (!league || !league.offCampus?.enabled) return;
                var matched = blocks2.filter(function(b2) {
                    return (b2.leagueName === lName) || (!b2.leagueName && !lName);
                });
                if (!matched.length) return;
                if (b1._doubleHeaderPairId) return;
                var pairId = 'auto_' + lName + '_' + tk1;
                b1._doubleHeaderPairId = pairId;
                matched.forEach(function(b2) { b2._doubleHeaderPairId = pairId; });
            });
        }

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
                var _oc1End = blocksByTime[timeKey1].allBlocks[0]?.endTime;
                var _oc2End = blocksByTime[timeKey2].allBlocks[0]?.endTime;
                var zoneF = window.getFieldsInZone?.(league.offCampus.zone) || [];
                var fp1 = buildAvailableFieldSportPool(lSports, context, ocDivs, timeKey1, s1, _oc1End);
                var fp2 = buildAvailableFieldSportPool(lSports, context, ocDivs, timeKey2, s2, _oc2End);

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
                                _leagueName: league.name,
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
                                _leagueName: league.name,
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

                [[g1All, lbl1], [g2All, lbl2]].forEach(function(set) { var aa = set[0], lbl = set[1]; aa.forEach(function(a) {
                    if (a.sport) { recordTeamSport(league.name, a.team1||a.teamA, a.sport, history); recordTeamSport(league.name, a.team2||a.teamB, a.sport, history); }
                    recordMatchup(league.name, a.team1||a.teamA, a.team2||a.teamB, history);
                    // ★ FN-54: date-keyed log so regen/delete can subtract this game
                    logGameRecord(league.name, dayId, a.team1||a.teamA, a.team2||a.teamB, a.sport, history, lbl);
                }); });

                leagueGameCounters[league.name] += 2;
                if (!history.gamesPerDate[league.name]) history.gamesPerDate[league.name] = {};
                history.gamesPerDate[league.name][dayId] = (history.gamesPerDate[league.name][dayId]||0) + 2;
               blocksByTime[timeKey1].allBlocks.forEach(function(b){
                    if ((league.divisions||[]).includes(b.divName)) b.processed=true;
                });
                blocksByTime[timeKey2].allBlocks.forEach(function(b){
                    if ((league.divisions||[]).includes(b.divName)) b.processed=true;
                });
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

                const coveredDivs = divisionsAtTime.filter(div => l.divisions.includes(div));
                if (coveredDivs.length === 0) return false;

                // ★★★ If blocks specify a league name, ONLY allow that league —
                // ★ Day 20 fix: EXCEPT a league still applies to a covered division
                // whose block has NO leagueName (auto-bound / unnamed). Without this,
                // an unnamed block that shares a time slot with named-league blocks in
                // OTHER divisions gets its league filtered out entirely, so that
                // division never receives matchups. (Observed: Minors' auto-bound
                // "1st Grade" block shared time 650 with named Soloists / Duetos-Trios
                // blocks → "1st Grade" excluded → Minors got no league game.)
                if (specifiedLeagueNames.size > 0 && !specifiedLeagueNames.has(l.name)) {
                    const hasUnnamedCoveredBlock = coveredDivs.some(div =>
                        (timeData.byDivision[div] || []).some(b => !b.leagueName));
                    if (!hasUnnamedCoveredBlock) return false;
                }

                return true;
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

                // ★★★ CHINUCH: Filter out teams on chinuch this period ★★★
                let activeTeams = leagueTeams;
                let chinuchTeamsHere = [];
                if (league.chinuch?.enabled && window.chinuchSchedule?.[league.name]) {
                    chinuchTeamsHere = Object.entries(window.chinuchSchedule[league.name])
                        .filter(([, sm]) => Number(sm) === Number(timeKey))
                        .map(([name]) => name);
                    if (chinuchTeamsHere.length > 0) {
                        activeTeams = leagueTeams.filter(t => !chinuchTeamsHere.includes(t));
                        console.log(`   [Chinuch] Teams on chinuch this period: [${chinuchTeamsHere.join(', ')}]`);
                        console.log(`   [Chinuch] Active teams: [${activeTeams.join(', ')}]`);
                    }
                }
                if (activeTeams.length < 2) {
                    // ★ Day 20 fix: a period where (nearly) every team is on chinuch
                    //   is a LEGITIMATE chinuch-only period — not an error. The old
                    //   code just `continue`d, so nothing was written and the league
                    //   layer block was left raw (_activity:"league" / the Phase-0
                    //   "League Game" placeholder). That is exactly the reported
                    //   "joint league leaves raw unprocessed blocks" symptom: it bit
                    //   joint leagues (Duetos/Trios) hardest because with N teams and
                    //   1 league period the auto distribution puts ALL teams on
                    //   chinuch → 0 active → raw blocks on every participating bunk.
                    //   Fix: when there are chinuch teams, write a chinuch-only block
                    //   (no games) to every participating division's block so each
                    //   bunk shows its team's chinuch activity. Mirrors the normal
                    //   writeback below but with only the chinuch lines. We do NOT
                    //   bump leagueGameCounters here — no game was played.
                    if (chinuchTeamsHere.length > 0) {
                        const _chOnlyLines = chinuchTeamsHere.map(function (t) {
                            const fac = league.chinuch?.bunkFacilities?.[t] || 'Chinuch';
                            return `${t} — Chinuch (${fac})`;
                        });
                        const _UtilsCh = window.SchedulerCoreUtils;
                        let _chWrote = 0;
                        filteredLeagueDivisions.forEach(divName => {
                            const blocksForDiv = timeData.byDivision[divName];
                            if (!blocksForDiv) return;
                            blocksForDiv.filter(b => !b.leagueName || b.leagueName === league.name).forEach(block => {
                                const _bk = (typeof block.startTime === 'number')
                                    ? block.startTime
                                    : (_UtilsCh?.parseTimeToMinutes?.(block.startTime) ?? block.startTime);
                                if (Number(_bk) !== Number(timeKey)) return;
                                const pick = {
                                    field: `League: ${league.name}`,
                                    sport: '',
                                    _activity: `League: ${league.name}`,
                                    _leagueName: league.name,
                                    _h2h: true,
                                    _fixed: true,
                                    _allMatchups: _chOnlyLines.slice(),
                                    _gameLabel: 'Chinuch',
                                    _chinuchOnly: true,
                                    _playoffRound: null
                                };
                                fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                                block.processed = true;
                                _chWrote++;
                            });
                        });
                        console.log(`   [Chinuch] Chinuch-only period for "${league.name}" — wrote ${_chWrote} block(s) for [${chinuchTeamsHere.join(', ')}] across [${filteredLeagueDivisions.join(', ')}]`);
                    } else {
                        console.log(`   ⚠️ Not enough active teams after chinuch`);
                    }
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
                
                // ★★★ BUILD POOL - RESPECTS GLOBAL LOCKS ★★★
                // ★ FN-57: built BEFORE matchup selection so sport_variety
                // pairing can see which sports are actually available today.
                const leagueSports = league.sports || ["General Sport"];
                var availablePool = buildAvailableFieldSportPool(
                    leagueSports,
                    context,
                    leagueDivisions,
                    timeKey,
                    slots,
                    sampleBlock?.endTime
                );
                // ★ Away (off-campus) league tile: if this league's block(s) for this
                //   period are marked Away, restrict the field pool to the chosen
                //   zone's fields. Travel is stamped per-block in fillBlock.
                //   Only the 'exclusive' mode restricts the pool; 'mixed' leaves the
                //   full pool so some games can stay on campus (travel still shows
                //   per-field for whichever land off-campus).
                var _awayZoneForPeriod = null;
                filteredLeagueDivisions.forEach(function (divName) {
                    (timeData.byDivision[divName] || []).forEach(function (b) {
                        if (!b || b._isAway !== true || !b._awayZone) return;
                        if (b._awayMode === 'mixed') return;
                        if (b.leagueName && b.leagueName !== league.name) return;
                        var _bk = (typeof b.startTime === 'number')
                            ? b.startTime
                            : (window.SchedulerCoreUtils?.parseTimeToMinutes?.(b.startTime) ?? b.startTime);
                        if (Number(_bk) !== Number(timeKey)) return;
                        _awayZoneForPeriod = b._awayZone;
                    });
                });
                if (_awayZoneForPeriod && typeof window.getFieldsInZone === 'function') {
                    var _azSet = new Set(window.getFieldsInZone(_awayZoneForPeriod) || []);
                    var _filteredPool = availablePool.filter(function (p) { return _azSet.has(p.field); });
                    if (_filteredPool.length > 0) {
                        console.log('   🚌 Away league "' + league.name + '" @' + timeKey + ' → restricting to zone "' + _awayZoneForPeriod + '" (' + _filteredPool.length + ' field/sport combos)');
                        availablePool = _filteredPool;
                    } else {
                        console.warn('   ⚠️ Away league "' + league.name + '" @' + timeKey + ' → zone "' + _awayZoneForPeriod + '" has no available fields; keeping full pool.');
                    }
                }
                // ★ Multi-game-per-day: exclude sports already used by this
                // league EARLIER today so games get distinct sports even when
                // the matchup is identical (e.g., 2-team league).
                if (todayGameIndex > 0 && availablePool.length > 1) {
                    var _prevSports = new Set();
                    var _leagueTeamKeys = leagueTeams.map(function(t) { return league.name + '|' + t; });
                    _leagueTeamKeys.forEach(function(k) {
                        var hist = history.teamSports[k] || [];
                        if (hist.length > 0) _prevSports.add(hist[hist.length - 1]);
                    });
                    if (_prevSports.size > 0) {
                        var filtered = availablePool.filter(function(p) { return !_prevSports.has(p.sport); });
                        if (filtered.length > 0) {
                            console.log('   ★ Multi-game: excluding sports from earlier game(s): [' + [..._prevSports].join(', ') + ']');
                            availablePool = filtered;
                        }
                    }
                }

                console.log(`   Available Field/Sport Combinations: ${availablePool.length}`);
                availablePool.slice(0, 10).forEach(p =>
                    console.log(`      • ${p.sport} @ ${p.field}`)
                );

                if (availablePool.length === 0) {
                    console.log(`   🚨 No fields available for league sports!`);
                    continue;
                }

                // ★★★ Get matchups — playoff > round-robin ★★★
                let matchups;
                let playoffMatchupSports = null;     // null when not in playoff mode
                let playoffMatchupFields = null;     // user-chosen field per matchup ('' = auto)
                let playoffRoundNum = null;
                let playoffIsTBD = false;            // true when emitting placeholder for an undecided future round
                const _PM = window.PlayoffMode;

                if (_PM && _PM.isLeagueInPlayoff(league)) {
                    const liveMatchups = _PM.getActiveMatchups(league);
                    if (liveMatchups.length > 0) {
                        if (todayGameIndex === 0) {
                            playoffRoundNum = league.playoff.currentRound;
                            matchups = liveMatchups.map(function (m) { return [m.teamA, m.teamB]; });
                            playoffMatchupSports = liveMatchups.map(function (m) { return m.sport || null; });
                            playoffMatchupFields = liveMatchups.map(function (m) { return m.field || ''; });
                            console.log('   🏆 PLAYOFF Round ' + playoffRoundNum + ': ' + liveMatchups.length + ' active matchup(s)');
                        } else {
                            // Game 2+ same day: winners not yet known — emit
                            // placeholder TBD matchups for the forecast next round.
                            const tbdRoundNum = league.playoff.currentRound + todayGameIndex;
                            const tbdCount = Math.max(1, Math.ceil(liveMatchups.length / Math.pow(2, todayGameIndex)));
                            const sportsPool = liveMatchups
                                .map(function (m) { return m.sport || null; })
                                .filter(Boolean);
                            const fallbackSport = (league.sports && league.sports[0]) || null;
                            playoffRoundNum = tbdRoundNum;
                            playoffIsTBD = true;
                            matchups = [];
                            playoffMatchupSports = [];
                            playoffMatchupFields = [];
                            for (let k = 0; k < tbdCount; k++) {
                                matchups.push(['TBD', 'TBD']);
                                playoffMatchupSports.push(sportsPool.length ? sportsPool[k % sportsPool.length] : fallbackSport);
                                playoffMatchupFields.push('');
                            }
                            console.log('   🏆 PLAYOFF Round ' + tbdRoundNum + ' TBD: ' + tbdCount + ' placeholder matchup(s)');
                        }
                    } else {
                        console.log('   🏆 PLAYOFF: no active matchups in current round (all decided or all byes) — skipping');
                        continue;
                    }
                } else {
                    const fullSchedule = generateRoundRobinSchedule(activeTeams);
                    const roundIndex = (gameNumber - 1) % fullSchedule.length;
                    const _rrMatchups = fullSchedule[roundIndex] || [];
                    // ★ FN-57: the two priorities differ in WHO plays WHOM.
                    // matchup_variety: strict round-robin — every opponent
                    // before any rematch. sport_variety: pairings chosen to
                    // maximize teams getting a sport they haven't played
                    // (ties prefer least-met opponents, so with plentiful
                    // sports this matches round-robin behavior).
                    const _prioMode = league.schedulingPriority || 'sport_variety';
                    if (_prioMode === 'sport_variety') {
                        matchups = choosePairingsForSportVariety(activeTeams, availablePool, league.name, history, _rrMatchups);
                    } else {
                        matchups = _rrMatchups;
                    }
                }

               console.log(`   Game #${gameNumber} (Today's Game: ${todayGameIndex + 1})`);
                console.log(`   Matchups: ${matchups.length}`);
                matchups.forEach(m => {
                    var t1 = Array.isArray(m) ? m[0] : m;
                    var t2 = Array.isArray(m) ? m[1] : m;
                    console.log(`      • ${t1} vs ${t2}`);
                });

                if (matchups.length === 0) continue;

                // (★ FN-57: the field/sport pool is now built BEFORE matchup
                // selection — see above — because sport_variety pairing needs
                // to know which sports are actually available today.)

                // ★★★ PLAYOFF TBD: information-only mode ★★★
                // For game 2+ in playoff mode, winners aren't decided yet so we
                // don't pick fields automatically — just list the open fields at
                // this time so the user can assign them once results are in.
                // No field locks, no per-matchup assignments.
                if (playoffIsTBD) {
                    leagueGameCounters[league.name]++;
                    const _seenFields = new Set();
                    const _openList = [];
                    availablePool.forEach(function (p) {
                        if (_seenFields.has(p.field)) return;
                        _seenFields.add(p.field);
                        _openList.push(p.field);
                    });
                    const _tbdLabel = 'Playoff R' + playoffRoundNum + ' TBD';
                    const _tbdRows = ['Round ' + playoffRoundNum + ' — winners TBD']
                        .concat(_openList.length > 0
                            ? ['Open fields:'].concat(_openList.map(function (s) { return '  • ' + s; }))
                            : ['(no open fields at this time)']);
                    console.log('   🏆 PLAYOFF TBD info-only: ' + _openList.length + ' open field(s) listed');
                    leagueDivisions.forEach(function (divName) {
                        const blocksForDiv = timeData.byDivision[divName];
                        if (!blocksForDiv) return;
                        blocksForDiv.forEach(function (block) {
                            const _Utils = window.SchedulerCoreUtils;
                            const _blockKey = (typeof block.startTime === 'number')
                                ? block.startTime
                                : (_Utils?.parseTimeToMinutes?.(block.startTime) ?? block.startTime);
                            if (Number(_blockKey) !== Number(timeKey)) return;
                            const pick = {
                                field: 'League: ' + league.name,
                                sport: _tbdLabel,
                                _activity: 'League: ' + league.name,
                                _leagueName: league.name,
                                _h2h: true,
                                _fixed: true,
                                _allMatchups: _tbdRows,
                                _gameLabel: _tbdLabel,
                                _playoffRound: playoffRoundNum,
                                _playoffTBD: true
                            };
                            fillBlock(block, pick, fieldUsageBySlot, {}, true, activityProperties);
                            block.processed = true;
                        });
                    });
                    // Reserved-activity locks still apply so non-playing bunks
                    // get routed away from these activities even though we don't
                    // know which kids will be playing yet.
                    if (window.GlobalFieldLocks && league.playoff && Array.isArray(league.playoff.reservedActivities) && league.playoff.reservedActivities.length > 0) {
                        const reservedReason = 'Playoff reserve (' + league.name + ' R' + playoffRoundNum + ' TBD)';
                        leagueDivisions.forEach(function (divName) {
                            league.playoff.reservedActivities.forEach(function (act) {
                                try {
                                    window.GlobalFieldLocks.lockFieldForDivision(act, slots, divName, reservedReason);
                                } catch (e) {
                                    console.warn('[PLAYOFF TBD] failed to reserve "' + act + '" for ' + divName + ':', e);
                                }
                            });
                        });
                    }
                    console.log('   📈 Game #' + gameNumber + ' (TBD info) complete for "' + league.name + '"');
                    continue;
                }

                // ★★★ PASS SCHEDULING PRIORITY TO ASSIGNMENT FUNCTION ★★★
                // For playoff mode: each matchup has its own fixed sport — bypass
                // the variety logic and assign per-matchup directly.
                let assignments;
                if (playoffMatchupSports) {
                    assignments = [];
                    const _poolUsed = new Set();
                    matchups.forEach(function (mu, i) {
                        const teamA = Array.isArray(mu) ? mu[0] : mu;
                        const teamB = Array.isArray(mu) ? mu[1] : null;
                        const wantedSport = playoffMatchupSports[i];
                        const wantedField = (playoffMatchupFields && playoffMatchupFields[i]) || '';
                        if (!teamA || !teamB) return;
                        if (!wantedSport) {
                            console.log('   ⚠️ PLAYOFF: matchup ' + teamA + ' vs ' + teamB + ' has no sport set — skipping');
                            return;
                        }
                        // Filter the pool to (sport-matching, field not yet used).
                        let candidates = availablePool.filter(function (p) {
                            return p.sport === wantedSport && !_poolUsed.has(p.field);
                        });
                        // ★ If the user chose a specific field for this matchup, prefer it.
                        //   Fall back to any compatible field if the chosen one is unavailable.
                        if (wantedField) {
                            const chosen = candidates.find(function (p) { return p.field === wantedField; });
                            if (chosen) {
                                _poolUsed.add(chosen.field);
                                assignments.push({ team1: teamA, team2: teamB, field: chosen.field, sport: chosen.sport });
                                return;
                            }
                            console.log('   ⚠️ PLAYOFF: chosen field "' + wantedField + '" for ' + teamA + ' vs ' + teamB +
                                ' is unavailable (in use or doesn\'t support ' + wantedSport + ') — falling back to auto-pick');
                        }
                        if (candidates.length === 0) {
                            // For TBD placeholders, the "wanted" sport is just a
                            // forecast — the actual round 2 sport isn't known yet.
                            // Fall back to any available pool entry so the slot
                            // still gets reserved with a TBD label.
                            if (playoffIsTBD) {
                                const fallback = availablePool.filter(function (p) { return !_poolUsed.has(p.field); });
                                if (fallback.length > 0) {
                                    const pickF = fallback[0];
                                    _poolUsed.add(pickF.field);
                                    assignments.push({ team1: teamA, team2: teamB, field: pickF.field, sport: pickF.sport });
                                    console.log('   🏆 PLAYOFF TBD: using fallback ' + pickF.sport + ' @ ' + pickF.field + ' (preferred sport "' + wantedSport + '" unavailable)');
                                    return;
                                }
                            }
                            console.log('   🚨 PLAYOFF: no field for sport "' + wantedSport + '" (matchup ' + teamA + ' vs ' + teamB + ')');
                            return;
                        }
                        const pick = candidates[0];
                        _poolUsed.add(pick.field);
                        assignments.push({ team1: teamA, team2: teamB, field: pick.field, sport: pick.sport });
                    });
                } else {
                    if (!indoorCountsByLeague[league.name]) indoorCountsByLeague[league.name] = {};
                    assignments = assignMatchupsToFieldsAndSports(
                        matchups,
                        availablePool,
                        league.name,
                        history,
                        slots,
                        league.schedulingPriority || 'sport_variety',
                        {
                            indoorRequirement: league.indoorRequirement,
                            indoorCounts: indoorCountsByLeague[league.name]
                        }
                    );
                }

                if (assignments.length === 0) {
                    console.log(`   ❌ No assignments possible`);
                    continue;
                }

                // ★ INDOOR: increment per-team count for matchups that landed indoor
                if (league.indoorRequirement?.enabled) {
                    if (!indoorCountsByLeague[league.name]) indoorCountsByLeague[league.name] = {};
                    const ic = indoorCountsByLeague[league.name];
                    assignments.forEach(function (a) {
                        const fObj = availablePool.find(function (p) { return p.field === a.field && p.sport === a.sport; });
                        // ★ INDOOR FIX: read the canonical Facilities indoor flag
                        // (rainyDayAvailable), with isIndoor as a fallback.
                        const _f = fObj && fObj.fieldObj;
                        if (_f && (_f.rainyDayAvailable === true || _f.isIndoor === true)) {
                            if (a.team1) ic[a.team1] = (ic[a.team1] || 0) + 1;
                            if (a.team2) ic[a.team2] = (ic[a.team2] || 0) + 1;
                        }
                    });
                }

                // ★★★ INCREMENT TODAY'S GAME COUNTER ★★★
                leagueGameCounters[league.name]++;

                // ★★★ CRITICAL: LOCK ALL USED FIELDS GLOBALLY ★★★
                const usedFields = [...new Set(assignments.map(a => a.field))];
                console.log(`\n   🔒 LOCKING FIELDS: ${usedFields.join(', ')}`);

               if (window.GlobalFieldLocks && slots.length > 0) {
var _leagueDivSlots = window.divisionTimes?.[leagueDivisions[0]] || [];
var _lockStartMin = null, _lockEndMin = null;
if (slots.length > 0 && _leagueDivSlots[slots[0]]) {
    _lockStartMin = _leagueDivSlots[slots[0]].startMin;
    _lockEndMin = _leagueDivSlots[slots[slots.length - 1]]?.endMin || (_lockStartMin + 40);
}
window.GlobalFieldLocks.lockMultipleFields(usedFields, slots, {
    lockedBy: playoffRoundNum ? 'playoff' : 'regular_league',
    leagueName: league.name,
    division: leagueDivisions.join(', '),
    activity: playoffRoundNum
        ? (`${league.name} Playoff R${playoffRoundNum}` + (playoffIsTBD ? ' TBD' : ''))
        : (`${league.name} League Game`),
    startMin: _lockStartMin,
    endMin: _lockEndMin
});

// ★★★ PLAYOFF: lock reserved activities for non-playoff kids ★★★
// User-configured list of facilities/activities that should be reserved
// exclusively for this league's divisions during the playoff slot, so the
// auto-scheduler routes the not-playing bunks into them.
if (playoffRoundNum && league.playoff && Array.isArray(league.playoff.reservedActivities) && league.playoff.reservedActivities.length > 0) {
    const reservedReason = `Playoff reserve (${league.name} R${playoffRoundNum}` + (playoffIsTBD ? ' TBD)' : ')');
    leagueDivisions.forEach(function (divName) {
        league.playoff.reservedActivities.forEach(function (act) {
            try {
                window.GlobalFieldLocks.lockFieldForDivision(act, slots, divName, reservedReason);
            } catch (e) {
                console.warn('[PLAYOFF] failed to reserve "' + act + '" for ' + divName + ':', e);
            }
        });
    });
    console.log('   🎯 PLAYOFF: reserved [' + league.playoff.reservedActivities.join(', ') + '] for [' + leagueDivisions.join(', ') + ']');
}
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
                const _recLabel = playoffRoundNum ? ('Playoff R' + playoffRoundNum) : ('Game ' + gameNumber);
                assignments.forEach(a => {
                    console.log(`      ✅ ${a.team1} vs ${a.team2} → ${a.sport} @ ${a.field}`);
                    recordTeamSport(league.name, a.team1, a.sport, history);
                    recordTeamSport(league.name, a.team2, a.sport, history);

                    // Record matchup for matchup_variety tracking
                    recordMatchup(league.name, a.team1, a.team2, history);
                    // ★ FN-54: date-keyed log so regen/delete can subtract this game
                    logGameRecord(league.name, dayId, a.team1, a.team2, a.sport, history, _recLabel);
                });
window._debugLeagueTimeData = timeData;
                // ★ Day 20 fix #1: iterate filteredLeagueDivisions, not
                // leagueDivisions. The filter at line ~1071 already determined
                // which divisions' blocks named THIS league (or had no hint).
                // Iterating leagueDivisions wrote matchups to divisions whose
                // block named a DIFFERENT league, overwriting that league's
                // intended placement.
                filteredLeagueDivisions.forEach(divName => {
                    const blocksForDiv = timeData.byDivision[divName];
                    if (!blocksForDiv) return;
                    // Within the division, only fill blocks that named THIS
                    // league or had no hint (extra safety if a division has
                    // multiple league blocks).
                    blocksForDiv.filter(b => !b.leagueName || b.leagueName === league.name).forEach(block => {
        // ★ FIX: Manual-mode blocks have only `startTime`; auto-mode blocks have both
        // `startTime` (string) and `startMin` (number). Normalize from `startTime` so
        // the check works in both modes. Previously checked `block.startMin`, which is
        // undefined in manual mode → NaN !== timeKey → every block skipped, matchups
        // never reached fillBlock, leagueAssignments stayed empty, and the renderer
        // fell back to generic "1 vs 2, 3 vs 4" pairings.
        const _Utils = window.SchedulerCoreUtils;
        const _blockKey = (typeof block.startTime === 'number')
            ? block.startTime
            : (_Utils?.parseTimeToMinutes?.(block.startTime) ?? block.startTime);
        if (Number(_blockKey) !== Number(timeKey)) return;
        const _gameLbl = playoffRoundNum
            ? (`Playoff R${playoffRoundNum}`)
            : (`Game ${gameNumber}`);
        // ★ Day 20 fix #2: separate sport from gameLabel. Previously
        // pick.sport = gameLbl (e.g. "Game 1") which then leaked into the
        // slot's sport field and field display. Use the first actual
        // sport from the assignments list (every matchup has its own sport
        // already in the matchup string), falling back to the league's
        // primary sport.
        const _firstSport = (assignments.find(a => a && a.sport) || {}).sport
            || (league.sports && league.sports[0])
            || '';
        // ★ CHINUCH: append "Team — Chinuch (Facility)" lines for teams on chinuch this period
        const _chinuchLines = chinuchTeamsHere.map(function (t) {
            const fac = league.chinuch?.bunkFacilities?.[t] || 'Chinuch';
            return `${t} — Chinuch (${fac})`;
        });
        // ★ BYE: any active team not in a matchup is on a bye — show it explicitly so
        // every team appears on the schedule every period (no silently-dropped teams).
        const _playingTeams = new Set();
        assignments.forEach(function (a) {
            if (a.team1) _playingTeams.add(a.team1);
            if (a.team2) _playingTeams.add(a.team2);
        });
        const _byeLines = (activeTeams || [])
            .filter(function (t) { return !_playingTeams.has(t); })
            .map(function (t) { return `${t} — Bye`; });
        const pick = {
                            field: `League: ${league.name}`,
                            sport: _firstSport,
                            _activity: `League: ${league.name}`,
                            _leagueName: league.name,
                            _h2h: true,
                            _fixed: true,
                            _allMatchups: assignments.map(a =>
                                `${a.team1} vs ${a.team2} @ ${a.field} (${a.sport})`
                            ).concat(_byeLines).concat(_chinuchLines),
                            _gameLabel: _gameLbl,
                            _playoffRound: playoffRoundNum || null
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

        // ★ FN-58: auto-save the day's games into the Leagues page results
        // store — no manual "Import from Schedule" needed. For every league
        // whose day this generation replaced, push the date's logged games
        // (grouped by game label) to the Leagues module; it swaps out the
        // date's auto-saved games while preserving scores already entered
        // for matchups that still exist. An empty list clears the date's
        // auto games (regen that dropped the league / produced no games).
        if (window.LeaguesAPI?.syncGamesFromGeneration) {
            _dayResetLeagues.forEach(function (lgName) {
                try {
                    const byLabel = {};
                    (history.gameLog?.[lgName]?.[dayId] || []).forEach(function (e) {
                        const lbl = e.g || 'Game';
                        (byLabel[lbl] = byLabel[lbl] || []).push({ teamA: e.t1, teamB: e.t2, sport: e.sport || null });
                    });
                    const entries = Object.keys(byLabel).map(function (lbl) {
                        const m = String(lbl).match(/Game\s*(\d+)/i);
                        return { gameLabel: lbl, gameNumber: m ? parseInt(m[1], 10) : null, matches: byLabel[lbl] };
                    });
                    window.LeaguesAPI.syncGamesFromGeneration(lgName, dayId, entries);
                } catch (e) {
                    console.warn('[RegularLeagues] FN-58 games auto-save failed for "' + lgName + '":', e);
                }
            });
        }

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

    /**
     * Remove a date's game counts from league history and propagate updated
     * game numbers to any future dates still in localStorage.
     * Called by eraseCurrentDailyData after a day is deleted.
     */
    /**
     * ★ FN-54: subtract a date's logged league records for every league whose
     * divisions intersect divisionNames, then renumber future schedules.
     * For callers that regenerate a day WITHOUT invoking the league engine at
     * all (auto builder with zero league layers) — the engine's own in-play
     * reset can't run there, which previously left ghost games in the history
     * when a league layer was removed and the day regenerated.
     */
    Leagues.resetDayRecords = function(divisionNames, dateKey) {
        try {
            if (!Array.isArray(divisionNames) || divisionNames.length === 0 || !dateKey) return;
            const history = loadLeagueHistory();
            const divSet = new Set(divisionNames);
            const settings = window.loadGlobalSettings?.() || {};
            const leagues = settings.app1?.leagues || settings.leaguesByName || {};
            const allLeagues = Array.isArray(leagues) ? leagues : Object.values(leagues || {});
            let changed = false;
            const affected = [];
            allLeagues.forEach(function (league) {
                if (!league || !league.name) return;
                if (!(league.divisions || []).some(function (d) { return divSet.has(d); })) return;
                affected.push(league.name);
                if (rollbackDayRecords(league.name, dateKey, history) > 0) changed = true;
                if (history.gamesPerDate?.[league.name]?.[dateKey] !== undefined) {
                    delete history.gamesPerDate[league.name][dateKey];
                    changed = true;
                }
            });
            // ★ FN-58: the day's auto-saved result games are gone with it
            if (affected.length > 0) {
                try { window.LeaguesAPI?.removeAutoGamesForDate?.(dateKey, affected); } catch (e) {}
            }
            if (!changed) return;
            saveLeagueHistory(history);
            updateFutureSchedules(dateKey, history);
            console.log('[RegularLeagues] ↩️ Reset day records for', dateKey, 'across divisions [' + divisionNames.join(', ') + ']');
        } catch (e) {
            console.error('[RegularLeagues] resetDayRecords error:', e);
        }
    };

    Leagues.cleanupDateFromHistory = function(dateKey) {
        try {
            const history = loadLeagueHistory();

            let changed = false;

            // ★ FN-54: subtract the deleted date's logged games from the
            // variety aggregates (teamSports/matchupHistory) — previously a
            // deleted day's games stayed in the aggregates forever.
            for (const leagueName of Object.keys(history.gameLog || {})) {
                if (rollbackDayRecords(leagueName, dateKey, history) > 0) {
                    changed = true;
                }
            }

            // ★ FN-58: the deleted day's auto-saved result games go with it
            try { window.LeaguesAPI?.removeAutoGamesForDate?.(dateKey); } catch (e) {}

            for (const leagueName of Object.keys(history.gamesPerDate || {})) {
                if (history.gamesPerDate[leagueName][dateKey] !== undefined) {
                    delete history.gamesPerDate[leagueName][dateKey];
                    changed = true;
                }
            }

            if (!changed) return;

            saveLeagueHistory(history);
            console.log('[RegularLeagues] 🗑️ Removed gamesPerDate entries for', dateKey);

            // Propagate corrected game numbers to future schedules in localStorage
            updateFutureSchedules(dateKey, history);
        } catch (e) {
            console.error('[RegularLeagues] cleanupDateFromHistory error:', e);
        }
    };

    /**
     * Wipe all gamesPerDate entries across every league.
     * Called by eraseAllDailyData when every schedule is deleted at once.
     * No future-schedule propagation needed because all schedules are gone.
     */
    Leagues.clearAllGamesPerDate = function() {
        try {
            const history = loadLeagueHistory();
            if (!history.gamesPerDate || Object.keys(history.gamesPerDate).length === 0) return;

            for (const leagueName of Object.keys(history.gamesPerDate)) {
                history.gamesPerDate[leagueName] = {};
            }

            saveLeagueHistory(history);
            console.log('[RegularLeagues] 🗑️ Cleared all gamesPerDate entries (all schedules deleted)');
        } catch (e) {
            console.error('[RegularLeagues] clearAllGamesPerDate error:', e);
        }
    };

    window.SchedulerCoreLeagues = Leagues;
    console.log('[RegularLeagues] Module loaded with Chronological Date Ordering + Cloud Persistence v7');
})();
